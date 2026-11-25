# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# Gathers the lines and fastener rows charts.py found on each chart into one
# set on the skin. Each point is kept on the chart that faces the skin there
# most squarely (a side chart where the skin faces sideways more than up or
# down, the top or bottom chart where it faces up or down more), so a line on
# a shoulder that two charts both reach is kept once; a line split by that
# boundary goes on as two. Then a line is kept when it is long enough and
# either several photos see a valley along it or it is deep (one photo's
# grain is neither), and dropped where it runs along a line the facts file
# already holds (layout.panels). Points the chart's rest skin does not cover
# are dropped: a line is laid on the skin.
#
# usage: python3 -I curate.py RECTIFIED LINES FACTS OUT.json [--charts right,left,top,bottom] [--sheets DIR]
#
# RECTIFIED: rectify.py's folders (each chart's chart.json and place.npy);
# LINES: charts.py's output folders, one per chart; writes OUT.json:
# {"lines": [{"chart", "id", "points": [[source coordinates]], "length",
# "strength", "photos"}], "rows": [{"chart", "points", "pitch", "strength"}],
# "dropped": {reason: count}}; with --sheets, each chart's mosaic in tiles
# with the kept lines in green, their rows' heads in blue, the lines the
# facts already hold in orange and the other dropped lines in red.
import json, math, sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))
import charts  # noqa: E402

SHORTEST = 3.0      # inches: a shorter line is dropped
AGREE = 2           # photos: a line fewer see a valley along is kept only if it is deep
DEEP = 0.05         # a line seen by fewer photos is kept if its valley is at least this deep
SAME = 0.75         # inches: a line within this of one the facts hold, along most of it, is that line
MOSTLY = 0.7        # the share of a line that must run along a held line for it to be that line
STEP = 0.5          # inches between the points a line is measured at
TOLERANCE = 0.15    # inches: how far the kept line's points may leave the found line
JUMP = 4            # steps: a line whose points, STEP apart on the chart, lie further apart than this many on the skin has run off one surface onto another


def normals(place):
	# The rest skin's normal at each chart pixel (source coordinates), from
	# the places of its neighbours: NaN where a neighbour is off the model
	dx = np.gradient(place, axis=1)
	dy = np.gradient(place, axis=0)
	n = np.cross(dx, dy)
	length = np.linalg.norm(n, axis=-1, keepdims=True)
	with np.errstate(invalid="ignore", divide="ignore"):
		return n / length


def mine(name, normal):
	# whether a chart faces skin of this normal (source coordinates: FS, WL,
	# BL) more squarely than the charts across from it: side charts the skin
	# facing across (BL), top and bottom the skin facing up or down (WL)
	across, up = np.abs(normal[..., 2]), np.abs(normal[..., 1])
	return (across >= up) if name in ("right", "left") else (up > across)


def dense(pixels, step):
	# points every `step` pixels along a polyline (N, 2)
	p = np.asarray(pixels, float)
	out = [p[0]]
	for a, b in zip(p, p[1:]):
		n = max(1, int(math.ceil(np.hypot(*(b - a)) / step)))
		out += [a + (b - a) * k / n for k in range(1, n + 1)]
	return np.array(out)


def simplified(points, tolerance):
	# Ramer-Douglas-Peucker in 3D
	if len(points) < 3:
		return points
	a, b = points[0], points[-1]
	d = b - a
	n = np.linalg.norm(d)
	off = np.linalg.norm(np.cross(points - a, d), axis=1) / n if n > 0 else np.linalg.norm(points - a, axis=1)
	k = int(np.argmax(off))
	if off[k] <= tolerance:
		return np.stack([a, b])
	return np.vstack([simplified(points[:k + 1], tolerance)[:-1], simplified(points[k:], tolerance)])


def distance(points, held):
	# each point's distance to the nearest of the held polylines' segments
	best = np.full(len(points), np.inf)
	for line in held:
		for a, b in zip(line, line[1:]):
			d = b - a
			t = np.clip(((points - a) @ d) / max(d @ d, 1e-12), 0, 1)
			best = np.minimum(best, np.linalg.norm(points - (a + t[:, None] * d), axis=1))
	return best


def known(facts):
	# the polylines the facts already hold, both sides of the mirrored ones
	p = json.loads(Path(facts).read_text())["layout"]["panels"]
	lines = [np.array(l, float) for l in p.get("lines", []) + p.get("mirrored", [])]
	lines += [np.array(l, float) * [1, 1, -1] for l in p.get("mirrored", [])]
	return lines


def runs(mask):
	# the [start, end) index ranges where a boolean list is true
	out, start = [], None
	for i, v in enumerate(list(mask) + [False]):
		if v and start is None:
			start = i
		elif not v and start is not None:
			out.append((start, i))
			start = None
	return out


def pieces(points, ok, jump):
	# the [start, end) index ranges of a line's points (N, 3) that are ok and
	# run on without a gap: a step longer than `jump` between neighbours is a
	# line seen running off one surface onto another behind it (from below,
	# a line on a nacelle's bottom runs on in the chart onto the wing 20 in
	# above), so it ends there
	ok = np.asarray(ok, bool).copy()
	out = []
	for a, b in runs(ok):
		steps = np.linalg.norm(np.diff(points[a:b], axis=0), axis=1)
		cut = [a] + [a + i + 1 for i in np.flatnonzero(steps > jump)] + [b]
		out += [(c, d) for c, d in zip(cut, cut[1:]) if d > c]
	return out


def gather(name, grid, place, found, held, dropped):
	scale = 1.0 / abs(grid["right"][int(np.argmax(np.abs(grid["right"])))])   # pixels per source unit
	n = normals(place)
	h, w = place.shape[:2]
	kept, red = [], []
	for line in found["lines"]:
		px = dense(line["pixels"], STEP * scale)
		xi, yi = np.clip(np.round(px[:, 0]).astype(int), 0, w - 1), np.clip(np.round(px[:, 1]).astype(int), 0, h - 1)
		at, normal = place[yi, xi], n[yi, xi]
		ok = np.isfinite(at).all(1) & np.isfinite(normal).all(1)
		ok &= mine(name, np.nan_to_num(normal))
		spans = [(a, b) for a, b in pieces(np.nan_to_num(at), ok, JUMP * STEP) if b - a >= 2]
		if not spans:
			reason = "another chart's" if np.isfinite(at).all(1).any() else "off the skin"
			dropped[reason] = dropped.get(reason, 0) + 1
			red.append((line["pixels"], reason))
			continue
		for a, b in spans:
			points = at[a:b].astype(float)
			length = float(np.linalg.norm(np.diff(points, axis=0), axis=1).sum())
			reason = None
			if length < SHORTEST:
				reason = "short"
			elif line["photos"] < AGREE and line["strength"] < DEEP:
				reason = "one photo's"
			elif held and (distance(points, held) < SAME).mean() >= MOSTLY:
				reason = "held"
			if reason:
				dropped[reason] = dropped.get(reason, 0) + 1
				red.append((px[a:b].tolist(), reason))
				continue
			kept.append({"chart": name, "id": line["id"], "points": np.round(simplified(points, TOLERANCE), 2).tolist(), "length": round(length, 1), "strength": line["strength"], "photos": line["photos"], "pixels": px[a:b].tolist()})
	rows = []
	for row in found.get("rows", []):
		points = np.array(row["points"], float)
		# a row's heads' normals, read where the heads are on the chart
		pixel = charts.to_pixels(grid, points)
		xi, yi = np.clip(np.round(pixel[:, 0]).astype(int), 0, w - 1), np.clip(np.round(pixel[:, 1]).astype(int), 0, h - 1)
		normal = n[yi, xi]
		if not (np.isfinite(normal).all(1) & mine(name, np.nan_to_num(normal))).all():
			dropped["row on another chart's"] = dropped.get("row on another chart's", 0) + 1
			continue
		rows.append({"chart": name, "points": row["points"], "pitch": row["pitch"], "strength": row["strength"], "pixels": pixel.tolist()})
	return kept, rows, red


def sheets(name, mosaic, kept, rows, red, out, tile=(960, 720)):
	base = np.where(np.isfinite(mosaic), np.clip((mosaic - 0.6) / 0.6, 0, 1) * 255, 30).astype(np.uint8)
	h, w = base.shape
	for y0 in range(0, h, tile[1]):
		for x0 in range(0, w, tile[0]):
			x1, y1 = min(x0 + tile[0], w), min(y0 + tile[1], h)

			def inside(points):
				return any(x0 <= x < x1 and y0 <= y < y1 for x, y in points)
			mine_ = [l for l in kept if inside(l["pixels"])]
			if not mine_ and not any(inside(r) for r, _ in red):
				continue
			image = Image.fromarray(base[y0:y1, x0:x1]).convert("RGB")
			draw = ImageDraw.Draw(image)
			for line, reason in red:
				# a line the facts already hold in orange, the rest dropped in red
				draw.line([(x - x0, y - y0) for x, y in line], fill=(255, 160, 0) if reason == "held" else (230, 40, 40), width=1)
			for line in mine_:
				draw.line([(x - x0, y - y0) for x, y in line["pixels"]], fill=(40, 230, 40), width=1)
				x, y = line["pixels"][len(line["pixels"]) // 2]
				draw.text((x - x0 + 2, y - y0 - 10), str(line["id"]), fill=(255, 255, 0))
			for row in rows:
				for x, y in row["pixels"]:
					if x0 <= x < x1 and y0 <= y < y1:
						draw.ellipse([x - x0 - 2, y - y0 - 2, x - x0 + 2, y - y0 + 2], outline=(60, 200, 255))
			image.save(Path(out) / f"{name}_{y0 // tile[1]:02d}_{x0 // tile[0]:02d}.png")


def main():
	args = sys.argv[1:]
	options = {}
	for key in ("--charts", "--sheets"):
		if key in args:
			i = args.index(key)
			options[key] = args[i + 1]
			del args[i:i + 2]
	rectified, lines, facts, out = Path(args[0]), Path(args[1]), args[2], Path(args[3])
	names = options.get("--charts", "right,left,top,bottom").split(",")
	held = known(facts)
	dropped, every, rows = {}, [], []
	for name in names:
		grid = json.loads((rectified / name / "chart.json").read_text())
		place = np.load(rectified / name / "place.npy").astype(np.float64)
		found = json.loads((lines / name / "lines.json").read_text())
		kept, row, red = gather(name, grid, place, found, held, dropped)
		print(f"{name}: {len(found['lines'])} lines found, {len(kept)} kept; {len(found.get('rows', []))} rows found, {len(row)} kept", flush=True)
		every += kept
		rows += row
		if "--sheets" in options:
			Path(options["--sheets"]).mkdir(parents=True, exist_ok=True)
			mosaic = np.load(lines / name / "mosaic.npy").astype(np.float32)
			sheets(name, mosaic, kept, row, red, options["--sheets"])
	for line in every:
		del line["pixels"]
	for row in rows:
		del row["pixels"]
	out.write_text(json.dumps({"lines": every, "rows": rows, "dropped": dropped}))
	print(f"kept {len(every)} lines ({sum(l['length'] for l in every):.0f} in) and {len(rows)} rows ({sum(len(r['points']) for r in rows)} heads); dropped {dropped}")


if __name__ == "__main__":
	main()
