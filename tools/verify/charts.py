# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# Finds the lines painted or cut into a model's skin (panel joints, seams) on
# the charts rectify.py lays the photos onto. Each photo's chart is searched
# for valleys: thin runs darker than the skin on both sides (an edge of a
# lettering stroke or a shadow is darker on one side only, and is passed
# over). The photos that see a pixel are weighed by how sharply each sees it
# (its pixels per chart pixel and how squarely it faces the skin), and each
# pixel's valley is the sharpest photo's: averaged over the photos, a line
# a pixel wide that one sharp photo shows was diluted to nothing by the
# blurrier views, each registered a pixel or two apart (on the F/A-18C's
# right side the average found 105 lines; most of what the sharpest views
# show fell under the threshold). How many photos also see a valley there is
# kept with each line, for curating. The valleys are thinned to their
# crests, linked into polylines and simplified, and each point given the
# skin's place at rest (the chart's place.npy), in source coordinates.
#
# usage: python3 -I charts.py RECTIFIED CHART OUT [--least N] [--photos a,b,...] [--sheets [--known FACTS]]
#
# Writes OUT/lines.json ({"chart", "lines": [{"id", "points": [[source
# coordinates]], "pixels": [[x, y]], "strength", "photos"}], "fasteners":
# [{"pixel", "point", "strength"}], "rows": [{"points", "pitch",
# "strength"}]}), OUT/mosaic.png
# (each pixel from the photo that sees it most sharply, its brightness taken
# relative to the skin round it) and OUT/valleys.png (that photo's valleys).
import json, math, sys
from pathlib import Path

import numpy as np
from PIL import Image

SPAN = 2          # pixels either side of a line its sides are read at
LEAST = 0.025     # least share darker than its sides a crest must be to start a line
WEAK = 0.012      # least share it may fall to along a line
SHORTEST = 8      # pixels: shorter runs are not linked
LONGEST_DROPPED = 24   # pixels: a line shorter than this once its pieces are joined is dropped
AGREE = 2      # pixels: how far apart two photos may see one line
TOLERANCE = 0.8   # pixels: how far a simplified line may leave the crest


def box(a, r):
	# A box blur of radius r along both axes, NaN-free input
	if r < 1:
		return a
	out = a
	for axis in (0, 1):
		c = np.cumsum(np.pad(out, [(r + 1, r) if k == axis else (0, 0) for k in (0, 1)], mode="edge"), axis=axis, dtype=np.float64)
		hi = np.take(c, np.arange(2 * r + 1, c.shape[axis]), axis=axis)
		lo = np.take(c, np.arange(0, c.shape[axis] - 2 * r - 1), axis=axis)
		out = ((hi - lo) / (2 * r + 1)).astype(np.float32)
	return out


def blur(a, sigma, mask=None):
	# A Gaussian of about sigma pixels (three box passes), mask-normalised:
	# NaN where nothing within reach is known
	known = np.isfinite(a) if mask is None else mask
	r = max(1, int(round(math.sqrt(12 * sigma * sigma / 3 + 1) / 2 - 0.5)))
	value, weight = np.where(known, a, 0).astype(np.float32), known.astype(np.float32)
	for _ in range(3):
		value, weight = box(value, r), box(weight, r)
	with np.errstate(invalid="ignore", divide="ignore"):
		return np.where(weight > 0.2, value / weight, np.nan).astype(np.float32)


DIRECTIONS = [(1, 0), (0, 1), (1, 1), (1, -1), (2, 1), (1, 2), (2, -1), (1, -2)]


def shifted(a, dx, dy):
	# a moved so out[y, x] = a[y + dy, x + dx], NaN past the edges
	out = np.full(a.shape, np.nan, np.float32)
	h, w = a.shape
	ys, yd = (slice(dy, h), slice(0, h - dy)) if dy >= 0 else (slice(0, h + dy), slice(-dy, h))
	xs, xd = (slice(dx, w), slice(0, w - dx)) if dx >= 0 else (slice(0, w + dx), slice(-dx, w))
	out[yd, xd] = a[ys, xs]
	return out


def valleys(grey):
	# How much darker each pixel is than the skin either side of it, as a
	# share of the skin's brightness there, along the direction it is
	# darkest across, and that direction's index (DIRECTIONS: across the line)
	g = blur(grey, 0.7)
	level = blur(grey, 6.0)
	best = np.zeros(g.shape, np.float32)
	which = np.zeros(g.shape, np.int8)
	for k, (dx, dy) in enumerate(DIRECTIONS):
		n = math.hypot(dx, dy)
		ox, oy = int(round(dx * SPAN / n)), int(round(dy * SPAN / n))
		if (ox, oy) == (0, 0):
			continue
		# both sides must be seen: at the edge of what a photo sees, one side
		# alone would make every step a valley
		side = np.minimum(shifted(g, ox, oy), shifted(g, -ox, -oy))
		depth = np.nan_to_num((side - g) / np.maximum(level, 1e-3), nan=0.0)
		better = depth > best
		best[better], which[better] = depth[better], k
	return best, which


RING = 3.5   # pixels: the radius a dot's surround is read at, clear of a 2 px fastener head's blur and short of its neighbour an inch on
DOT = 0.035  # least share darker than its surround a fastener must be (rows() keeps only those in line)


def dots(grey):
	# How much darker each pixel is than every point of a ring round it, as a
	# share of the skin's brightness: a fastener's head is a dot darker than
	# the paint on every side, where a line is darker along it and a stroke's
	# edge on one side
	g = blur(grey, 0.6)
	level = blur(grey, 6.0)
	ring = None
	for k in range(12):
		a = 2 * math.pi * k / 12
		s = shifted(g, int(round(RING * math.cos(a))), int(round(RING * math.sin(a))))
		ring = s if ring is None else np.minimum(ring, s)
	return np.nan_to_num((ring - g) / np.maximum(level, 1e-3), nan=0.0).astype(np.float32)


def peaks(strength, least):
	# Pixels stronger than `least` and than their eight neighbours: (N, 2) x, y
	keep = strength > least
	for dy in (-1, 0, 1):
		for dx in (-1, 0, 1):
			if dy or dx:
				keep &= strength >= np.nan_to_num(shifted(strength, dx, dy), nan=-1)
	ys, xs = np.nonzero(keep)
	return np.stack([xs, ys], 1)


DARK = 0.7      # a marking is darker than this share of the paint round it
THICK = 3       # pixels: a marking's strokes are at least twice this wide; a line is narrower
CLEAR = 6       # pixels: how far past a marking its outline's steps are passed over


def disk(radius):
	r = int(math.ceil(radius))
	return [(dx, dy) for dy in range(-r, r + 1) for dx in range(-r, r + 1) if dx * dx + dy * dy <= radius * radius]


def spread(mask, radius, grow=True):
	# A mask grown (or shrunk) by `radius` pixels each way, a square at a
	# time: along the rows, then the columns
	out = mask.copy()
	r = int(math.ceil(radius))
	for axis in (0, 1):
		step = out.copy()
		for k in range(1, r + 1):
			for sign in (1, -1):
				dx, dy = (sign * k, 0) if axis == 1 else (0, sign * k)
				moved = np.nan_to_num(shifted(out.astype(np.float32), dx, dy), nan=0.0 if grow else 1.0) > 0.5
				step = (step | moved) if grow else (step & moved)
		out = step
	return out


def markings(grey):
	# The painted markings (lettering, insignia, stencil boxes): areas darker
	# than the paint round them in strokes too wide for a panel line, and
	# CLEAR pixels round them, whose outlines and light lettering would read
	# as lines
	relative = grey / blur(grey, 64.0)   # against the paint 8 in round: inside a stencil's box the box is all there is nearer
	dark = np.nan_to_num(relative, nan=1.0) < DARK
	core = spread(dark, THICK, grow=False)
	return spread(core, THICK + CLEAR)


JUMP = 1.5   # source units: a step this large between neighbouring chart pixels' skin is one part's edge over another


def overlaps(place):
	# The chart pixels beside an edge where one part stands in front of
	# another, or the model's outline (place: each pixel's skin, NaN off the
	# model), CLEAR pixels round: the photos show an edge there that is no
	# panel line
	edge = np.zeros(place.shape[:2], bool)
	for axis in (0, 1):
		d = np.linalg.norm(np.diff(place, axis=axis), axis=-1)
		step = ~(d < JUMP)   # NaN (an outline) counts as a step
		if axis == 0:
			edge[:-1] |= step
			edge[1:] |= step
		else:
			edge[:, :-1] |= step
			edge[:, 1:] |= step
	edge &= np.isfinite(place[..., 0])
	return spread(edge, CLEAR / 2)


def thinned(strength, which):
	# Crests: pixels at least as strong as both neighbours across the line
	out = np.zeros(strength.shape, bool)
	for k, (dx, dy) in enumerate(DIRECTIONS):
		n = math.hypot(dx, dy)
		ox, oy = int(round(dx / n)), int(round(dy / n))
		mine = which == k
		a, b = np.nan_to_num(shifted(strength, ox, oy)), np.nan_to_num(shifted(strength, -ox, -oy))
		out |= mine & (strength >= a) & (strength >= b)
	return out & (strength > 0)


def chains(crest, strength, least=LEAST, weak=WEAK):
	# Polylines through the crest pixels: grown from pixels stronger than
	# `least` along neighbours stronger than `weak`, walking from each end
	keep = crest & (strength > weak)
	ys, xs = np.nonzero(keep)
	index = {(y, x): i for i, (y, x) in enumerate(zip(ys.tolist(), xs.tolist()))}
	neighbours = [[] for _ in range(len(ys))]
	for i, (y, x) in enumerate(zip(ys.tolist(), xs.tolist())):
		for dy in (-1, 0, 1):
			for dx in (-1, 0, 1):
				if (dy or dx) and (y + dy, x + dx) in index:
					neighbours[i].append(index[(y + dy, x + dx)])
	used = np.zeros(len(ys), bool)
	order = np.argsort(-strength[ys, xs])
	out = []
	for start in order:
		if used[start] or strength[ys[start], xs[start]] < least:
			continue
		used[start] = True
		run = [start]
		for direction in (0, 1):
			path = [start]
			while True:
				here = path[-1]
				options = [j for j in neighbours[here] if not used[j]]
				if not options:
					break
				if len(path) > 1:
					# keep going the way the line goes
					py, px = ys[path[-1]] - ys[path[-2]], xs[path[-1]] - xs[path[-2]]
					options.sort(key=lambda j: -((ys[j] - ys[here]) * py + (xs[j] - xs[here]) * px) / math.hypot(ys[j] - ys[here], xs[j] - xs[here]))
				nxt = options[0]
				used[nxt] = True
				for j in options[1:]:
					used[j] = True   # a crest two pixels wide is one line
				path.append(nxt)
			run = list(reversed(path[1:])) + run if direction == 0 else run + path[1:]
		if len(run) >= SHORTEST:
			out.append(np.stack([xs[run], ys[run]], 1).astype(float))
	return out


GAP = 4        # pixels: the most a line may break for
TURN = 25      # degrees: the most two pieces of one line may turn where they join


def joined(runs, gap=GAP, turn=TURN):
	# Pieces of one line joined end to end: an end within `gap` pixels of
	# another piece's end, both running on in about the same direction (within
	# `turn` degrees), and the gap between them along that direction. Ends are
	# looked up in a grid of `gap`-pixel cells
	runs = list(runs)
	limit = math.cos(math.radians(turn))

	def end(run, e):
		# a run's end point and the direction it leaves by (over its last 6 pixels)
		k = min(6, len(run) - 1)
		a, b = (run[k], run[0]) if e == 0 else (run[-1 - k], run[-1])
		d = b - a
		return b, d / max(np.hypot(*d), 1e-9)

	cells = {}
	def add(i):
		for e in (0, 1):
			p, _ = end(runs[i], e)
			cells.setdefault((int(p[0] // gap), int(p[1] // gap)), set()).add((i, e))

	def remove(i):
		for e in (0, 1):
			p, _ = end(runs[i], e)
			cells.get((int(p[0] // gap), int(p[1] // gap)), set()).discard((i, e))

	for i in range(len(runs)):
		add(i)
	queue = list(range(len(runs)))
	while queue:
		i = queue.pop()
		if runs[i] is None:
			continue
		for ei in (0, 1):
			pi, hi = end(runs[i], ei)
			cx, cy = int(pi[0] // gap), int(pi[1] // gap)
			best = None
			for dx in (-1, 0, 1):
				for dy in (-1, 0, 1):
					for j, ej in cells.get((cx + dx, cy + dy), ()):
						if j == i or runs[j] is None:
							continue
						pj, hj = end(runs[j], ej)
						d = pj - pi
						dist = np.hypot(*d)
						if dist > gap or hi @ -hj < limit or (dist > 0.5 and (d / dist) @ hi < limit):
							continue
						if best is None or dist < best[0]:
							best = (dist, j, ej)
			if best is None:
				continue
			_, j, ej = best
			remove(i)
			remove(j)
			a = runs[i] if ei == 1 else runs[i][::-1]
			b = runs[j] if ej == 0 else runs[j][::-1]
			runs[i], runs[j] = np.vstack([a, b]), None
			add(i)
			queue.append(i)
			break
	return [r for r in runs if r is not None]


def simplified(points, tolerance=TOLERANCE):
	# Ramer-Douglas-Peucker
	if len(points) < 3:
		return points
	a, b = points[0], points[-1]
	d = b - a
	n = np.hypot(*d)
	off = np.abs(d[0] * (points[:, 1] - a[1]) - d[1] * (points[:, 0] - a[0])) / n if n > 0 else np.hypot(*(points - a).T)
	k = int(np.argmax(off))
	if off[k] <= tolerance:
		return np.stack([a, b])
	return np.vstack([simplified(points[:k + 1], tolerance)[:-1], simplified(points[k:], tolerance)])


PITCH = (4, 28)   # pixels: the nearest and furthest apart two heads of one fastener row stand
SLACK = 0.3       # how far a row's next head may stand off where the steps put it, as a share of a step
ROW = 4           # heads: fewer in line are no row
FOUND = 0.6       # the least share of a row's heads the dots must find where some are missed


def pitch_of(points):
	# A row's pitch from its heads in order, some of the steps between them
	# spanning heads the dots missed: the shortest step is one pitch or near
	# it, and each step a whole number of pitches
	d = np.linalg.norm(np.diff(np.asarray(points, float), axis=0), axis=1)
	if not len(d):
		return 0.0
	many = np.maximum(1, np.round(d / d.min()))
	return float(d.sum() / many.sum())


def rows(found, pitch=PITCH, slack=SLACK, least=ROW, skip=2):
	# Fastener heads in rows: runs of at least `least` heads each a near
	# equal step on from the last, along a line that may bend gently. A
	# lone dark speck, or a scatter of grain, has no such neighbours. The
	# longest rows are taken first; a later one is taken if enough of its
	# heads are its own (two rows crossing at a frame share the fastener
	# there; the same row read at twice its pitch has none of its own):
	# (rows as lists of indices into `found`)
	found = np.asarray(found, float)
	if len(found) < least:
		return []
	cell = pitch[1]
	grid = {}
	for k, (x, y) in enumerate(found):
		grid.setdefault((int(x // cell), int(y // cell)), []).append(k)

	def near(p, radius):
		cx, cy = int(p[0] // cell), int(p[1] // cell)
		reach = int(math.ceil(radius / cell))
		out = []
		for dx in range(-reach, reach + 1):
			for dy in range(-reach, reach + 1):
				for j in grid.get((cx + dx, cy + dy), ()):
					if np.hypot(*(found[j] - p)) <= radius:
						out.append(j)
		return out

	def walk(path, step):
		# on from the path's end by its steps so far, head by head, stepping
		# over up to `skip` heads the dots missed (about half a row's heads
		# are found where the chart's pixel is an eighth of an inch). The
		# next head is looked for the mean of the last two steps on: a
		# single step carries both its heads' jitter, and guessed from it
		# alone the walk lost a row with half-pixel jitter and a third of its
		# heads missed in 18 of 40 draws (3 of 40 this way); a longer mean,
		# or one turned by the steps' turn, lags round a curved row or
		# follows the jitter. Rows round a curve tighter than about 6 in
		# (48 px) break into pieces
		steps = [step]
		while True:
			step = np.mean(steps[-2:], axis=0)
			length = np.hypot(*step)
			for k in range(1, skip + 2):
				guess = found[path[-1]] + step * k
				options = [j for j in near(guess, slack * length) if j not in path]
				if options:
					break
			else:
				return path
			j = min(options, key=lambda j: np.hypot(*(found[j] - guess)))
			steps.append((found[j] - found[path[-1]]) / k)
			path.append(j)

	candidates = []
	for i in range(len(found)):
		for j in near(found[i], pitch[1]):
			if j <= i or np.hypot(*(found[j] - found[i])) < pitch[0]:
				continue
			step = found[j] - found[i]
			ahead = walk([i, j], step)
			back = walk([i], -step)
			path = list(reversed(back[1:])) + ahead
			if len(path) < least:
				continue
			# a row that stepped over missed heads must have found most of
			# its heads and one more than a whole row needs: three steps
			# through a scatter, each free to land a pitch or two on, find
			# four specks in line too readily
			d = np.linalg.norm(np.diff(found[path], axis=0), axis=1)
			expected = int(np.maximum(1, np.round(d / pitch_of(found[path]))).sum()) + 1 if len(d) else 1
			if expected > len(path) and (len(path) < least + 1 or len(path) < FOUND * expected):
				continue
			candidates.append(path)
	candidates.sort(key=len, reverse=True)
	taken = np.zeros(len(found), bool)
	out = []
	for path in candidates:
		free = [k for k in path if not taken[k]]
		if len(free) < least:
			continue
		taken[path] = True
		out.append(path)
	return out


COLOURS = [(255, 60, 60), (60, 200, 255), (255, 200, 0), (120, 255, 120), (255, 120, 255), (255, 150, 60)]


def to_pixels(grid, points):
	# Source coordinates to the chart's pixels (x, y), along its right and down
	points = np.asarray(points, float) - np.asarray(grid["origin"], float)
	right, down = np.asarray(grid["right"], float), np.asarray(grid["down"], float)
	return np.stack([points @ right / (right @ right), points @ down / (down @ down)], -1)


def sheets(mosaic, lines, grid, out, fasteners=(), known=(), tile=(960, 720), step=10.0):
	# The lines over the mosaic in tiles, each line in a colour with its id
	# at its middle, and a grid every `step` source units labelled with the
	# coordinates the chart's axes run along
	from PIL import ImageDraw
	h, w = mosaic.shape
	base = np.where(np.isfinite(mosaic), np.clip((mosaic - 0.6) / 0.6, 0, 1) * 255, 30).astype(np.uint8)
	right, down, origin = np.array(grid["right"]), np.array(grid["down"]), np.array(grid["origin"])
	ax, ay = int(np.argmax(np.abs(right))), int(np.argmax(np.abs(down)))
	names = "FWB"   # station, waterline, buttline
	written = []
	for y0 in range(0, h, tile[1]):
		for x0 in range(0, w, tile[0]):
			x1, y1 = min(x0 + tile[0], w), min(y0 + tile[1], h)
			mine = [l for l in lines if any(x0 <= x < x1 and y0 <= y < y1 for x, y in l["pixels"])]
			theirs = [k for k in known if ((k[:, 0] >= x0) & (k[:, 0] < x1) & (k[:, 1] >= y0) & (k[:, 1] < y1)).any()]
			spots = [f["pixel"] for f in fasteners if x0 <= f["pixel"][0] < x1 and y0 <= f["pixel"][1] < y1]
			if not mine and not spots:
				continue
			image = Image.fromarray(base[y0:y1, x0:x1]).convert("RGB")
			draw = ImageDraw.Draw(image)
			# the grid: source value at a pixel along each axis
			for axis, index, length in ((0, ax, x1 - x0), (1, ay, y1 - y0)):
				vector = right if axis == 0 else down
				start = origin[index] + vector[index] * ((x0 if axis == 0 else y0))
				per = vector[index]
				first = math.ceil(min(start, start + per * length) / step) * step
				value = first
				while value <= max(start, start + per * length):
					p = (value - start) / per
					if axis == 0:
						draw.line([(p, 0), (p, y1 - y0)], fill=(70, 70, 140))
						draw.text((p + 2, 2), f"{names[index]}{value:g}", fill=(150, 150, 255))
					else:
						draw.line([(0, p), (x1 - x0, p)], fill=(70, 70, 140))
						draw.text((2, p + 2), f"{names[index]}{value:g}", fill=(150, 150, 255))
					value += step
			for l in mine:
				c = COLOURS[l["id"] % len(COLOURS)]
				pts = [(x - x0, y - y0) for x, y in l["pixels"]]
				draw.line(pts, fill=c, width=1)
				mx, my = pts[len(pts) // 2]
				draw.text((mx + 3, my - 10), str(l["id"]), fill=c)
			for k in theirs:
				draw.line([(x - x0, y - y0) for x, y in k], fill=(255, 255, 255), width=1)
			for x, y in spots:
				draw.ellipse([x - x0 - 2, y - y0 - 2, x - x0 + 2, y - y0 + 2], outline=(0, 255, 0))
			path = out / f"sheet_{y0 // tile[1]:02d}_{x0 // tile[0]:02d}.png"
			image.save(path)
			written.append(path.name)
	return written


def main():
	args = sys.argv[1:]
	least = float(args[args.index("--least") + 1]) if "--least" in args else LEAST
	only = set(args[args.index("--photos") + 1].split(",")) if "--photos" in args else None
	rectified, name, out = Path(args[0]), args[1], Path(args[2])
	out.mkdir(parents=True, exist_ok=True)
	folder = rectified / name
	grid = json.loads((folder / "chart.json").read_text())
	place = np.load(folder / "place.npy")
	w, h = grid["size"]
	total, spots = np.zeros((h, w), np.float32), np.zeros((h, w), np.float32)
	best, mosaic = np.zeros((h, w), np.float32), np.full((h, w), np.nan, np.float32)
	count = np.zeros((h, w), np.int16)
	files = sorted(p for p in folder.glob("*.npz") if only is None or p.stem in only)
	for path in files:
		d = np.load(path)
		# each photo's window of the chart, laid back in its place
		x0, y0 = (int(v) for v in d["origin"]) if "origin" in d.files else (0, 0)
		grey, facing, reach = (np.full((h, w), np.nan, np.float32) for _ in range(3))
		for full, key in ((grey, "grey"), (facing, "facing"), (reach, "reach")):
			part = d[key].astype(np.float32)
			full[y0:y0 + part.shape[0], x0:x0 + part.shape[1]] = part
		seen = np.isfinite(grey)
		if seen.sum() < 1000:
			continue
		# sharpness: a photo seeing the skin at under a pixel per chart pixel
		# blurs a line narrower than a chart pixel to nothing
		sharp = np.clip(np.nan_to_num(reach), 0, 2) / 2
		wt = np.where(seen, np.nan_to_num(facing) * sharp ** 2, 0).astype(np.float32)
		depth, which = valleys(grey)
		# a marking says nothing of the lines under it
		wt[markings(grey)] = 0
		# the photos that also see a valley here: within AGREE pixels, as two
		# photos register a pixel or two apart; grain is one photo's alone
		count += (wt > 0.05) & spread(depth > WEAK, AGREE)
		relative = grey / blur(grey, 24.0)
		better = wt > best
		best[better], mosaic[better] = wt[better], relative[better]
		total[better], spots[better] = depth[better], dots(grey)[better]
		print(f"{path.stem}: {int(seen.sum())} pixels, weight {float(wt.sum()):.0f}", flush=True)
	strength = np.where(best > 0.02, np.nan_to_num(total), 0).astype(np.float32)
	strength[overlaps(place)] = 0
	# the direction across each crest: the one its neighbours fall away along most
	which = np.zeros(strength.shape, np.int8)
	bestdepth = np.full(strength.shape, -1.0, np.float32)
	for k, (dx, dy) in enumerate(DIRECTIONS):
		n = math.hypot(dx, dy)
		ox, oy = int(round(dx / n)), int(round(dy / n))
		across = strength - 0.5 * (np.nan_to_num(shifted(strength, ox, oy)) + np.nan_to_num(shifted(strength, -ox, -oy)))
		better = across > bestdepth
		bestdepth[better], which[better] = across[better], k
	crest = thinned(strength, which)
	lines = []
	for k, run in enumerate(r for r in joined(chains(crest, strength, least)) if len(r) >= LONGEST_DROPPED):
		simple = simplified(run)
		xi, yi = np.clip(simple[:, 0].astype(int), 0, w - 1), np.clip(simple[:, 1].astype(int), 0, h - 1)
		at = place[yi, xi]
		# a point off the model takes the chart's own plane
		plane = np.array(grid["origin"]) + simple[:, :1] * np.array(grid["right"]) + simple[:, 1:2] * np.array(grid["down"])
		at = np.where(np.isfinite(at), at, plane)
		ri, ci = run[:, 1].astype(int), run[:, 0].astype(int)
		lines.append({"id": k, "points": np.round(at, 2).tolist(), "pixels": simple.round(1).tolist(), "strength": round(float(strength[ri, ci].mean()), 4), "photos": round(float(np.median(count[ri, ci])), 1)})
	# the fasteners: dots darker than all round them, averaged over the photos
	dot = np.where(best > 0.02, np.nan_to_num(spots), 0).astype(np.float32)
	found = peaks(dot, DOT)
	at = place[found[:, 1], found[:, 0]]
	keep = np.isfinite(at[:, 0])
	fasteners = [{"pixel": [int(x), int(y)], "point": np.round(p, 2).tolist(), "strength": round(float(dot[y, x]), 4)} for (x, y), p in zip(found[keep], at[keep])]
	# the heads in rows (rows()): each row's heads in order, in source
	# coordinates, and its pitch (pitch_of())
	heads = np.array([f["pixel"] for f in fasteners], float).reshape(-1, 2)
	points = np.array([f["point"] for f in fasteners], float).reshape(-1, 3)
	runs = []
	for row in rows(heads):
		p = points[row]
		runs.append({"points": np.round(p, 2).tolist(), "pitch": round(pitch_of(p), 2), "strength": round(float(np.mean([fasteners[k]["strength"] for k in row])), 4)})
	(out / "lines.json").write_text(json.dumps({"chart": name, "grid": grid, "lines": lines, "fasteners": fasteners, "rows": runs}))
	Image.fromarray((np.clip(dot / 0.15, 0, 1) * 255).astype(np.uint8)).save(out / "dots.png")
	Image.fromarray(np.where(np.isfinite(mosaic), np.clip((mosaic - 0.6) / 0.6, 0, 1) * 255, 30).astype(np.uint8)).save(out / "mosaic.png")
	Image.fromarray((np.clip(strength / 0.15, 0, 1) * 255).astype(np.uint8)).save(out / "valleys.png")
	np.save(out / "mosaic.npy", mosaic.astype(np.float16))
	if "--sheets" in args:
		known = []
		if "--known" in args:
			# the panel lines a facts file already holds (layout.panels), drawn in white:
			# those on the chart's side of the model only
			panels = json.loads(Path(args[args.index("--known") + 1]).read_text())["layout"]["panels"]
			normal = np.asarray(grid["normal"], float)
			every = [np.array(l, float) for l in panels["lines"] + panels["mirrored"]] + [np.array(l, float) * [1, 1, -1] for l in panels["mirrored"]]
			for l in every:
				if (l - np.nanmean(place.reshape(-1, 3), 0)) @ normal @ np.ones(len(l)) / len(l) > 0:
					known.append(to_pixels(grid, l))
		sheets(mosaic, lines, grid, out, fasteners, known)
	print(f"{name}: {len(files)} photos, {len(lines)} lines, {sum(len(l['pixels']) for l in lines)} points, {len(fasteners)} fasteners in {len(runs)} rows", flush=True)


if __name__ == "__main__":
	main()
