# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# The stores' paint (claude/plans/air-fa18c.md #9; layout.stores.paint),
# texel by texel in plain numpy, as the missiles' paint is: the airframe's
# lower grey under the baked shading, each part a shade of its own, the
# mottle and grain the missiles' paint is calibrated to (good but not perfect
# condition), and the joints and filler cap the photos show, with grime along
# the joints. build.py bakes what it reads and saves what it returns.
import importlib.util
import math
import zlib
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("missile_paint", HERE.parent / "missiles" / "paint.py")
missile = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(missile)
INCH = 0.0254


def along(where, frame):
	# A texel's place on its part: inches aft of the part's nose along its
	# axis, its turn about the axis in degrees from the part's up toward its
	# right, and its distance from the axis in inches (frame: nose, axis and
	# up as unit vectors, Blender's axes: x forward, y left, z up)
	d = where - np.asarray(frame["nose"])
	axis, up = np.asarray(frame["axis"], float), np.asarray(frame["up"], float)
	right = np.cross(up, axis)
	station = d @ axis / INCH
	across = d - np.outer(d @ axis, axis).reshape(d.shape)
	turn = np.degrees(np.arctan2(across @ right, across @ up))
	return station, turn, np.linalg.norm(across, axis=-1) / INCH


def colour(layout, grey, occlusion, where, part, frames, size):
	# The stores' atlas, sRGB 0..1. grey: the paint's sRGB colour (3);
	# occlusion: ambient occlusion 0..1; where: each texel's place (metres,
	# Blender's axes); part: the index of the part it lies on in frames, from
	# 1 (0: no part); frames: per part its kind ("tank", "pylon", ...) and
	# axis frame (along); size: each texel's width (inches)
	wear = layout.get("wear", {})
	inches = where / INCH
	shading = 0.4 + 0.6 * occlusion[..., None]
	out = np.asarray(grey, float) * shading
	# a part painted a colour of its own along its body (layout.<kind> body):
	# between its light ends (light: inches aft of its nose) and within
	# `inboard` inches of its axis toward its up (the wingtip LAU-7, dark,
	# beside its light cap, cone and adapter)
	# With `even`, the whole part, its body and its light ends, takes none of
	# the paint's mottle or grain
	even = np.zeros(part.shape)
	for index, frame in enumerate(frames, start=1):
		spec = layout.get(frame["kind"], {})
		mine = part == index
		if "body" not in spec or not mine.any():
			continue
		station, turn, radius = along(where[mine], frame)
		body = (station > spec["light"][0]) & (station < spec["light"][1]) & (radius * np.cos(np.radians(turn)) < spec["inboard"])
		cells = np.flatnonzero(mine.ravel())[body]
		flat = out.reshape(-1, 3)
		flat[cells] = np.asarray(spec["body"], float) / 255 * shading.reshape(-1, 1)[cells]
		if spec.get("even"):
			even[mine] = 1.0
	tone = 1 + wear.get("parts", 0.04) * missile.shade(part)
	# each scale of the noise as strong as the missiles' calibration where the
	# atlas resolves it, fading out as its features shrink to a texel (the
	# grain's 0.15 in, under the stores' half-inch texels, would only speckle)
	resolved = lambda scale: np.clip(scale / size - 1, 0, 1)
	mottle = (resolved(1.5) * (missile.noise(inches, 1.5, 11) - 0.5) + 0.5 * resolved(0.6) * (missile.noise(inches, 0.6, 17) - 0.5)) / (missile.SPREAD * math.sqrt(1.25))
	grain = resolved(0.15) * (missile.noise(inches, 0.15, 18) - 0.5) / missile.SPREAD
	out = out * (tone * (1 + (1 - even) * (wear.get("mottle", 0.03) * mottle + wear.get("grain", 0.012) * grain)))[..., None]
	# what the photos show on each kind of part (layout.<kind>): its joint
	# rings, darker than the paint with grime beside them, and a tank's
	# filler cap, a coloured lid in a ring
	line = layout.get("line", {"width": 0.06, "depth": 0.45})
	ink = np.zeros(part.shape)
	grime = np.zeros(part.shape)
	for index, frame in enumerate(frames, start=1):
		mine = part == index
		spec = layout.get(frame["kind"], {})
		if not mine.any() or not spec:
			continue
		station, turn, radius = along(where[mine], frame)
		lines = np.zeros(station.shape)
		near = np.zeros(station.shape)
		for joint in spec.get("joints", []):
			lines = np.maximum(lines, missile.band(station - joint, line["width"], size[mine]))
			near = np.maximum(near, np.clip(1 - np.abs(station - joint) / 0.8, 0, 1))
		cap = spec.get("cap")
		if cap:
			# the distance on the skin from the cap's middle, along the axis
			# and round it: the lid in its colour, a ring round it
			d = np.hypot(station - cap["station"], np.radians((turn - cap["turn"] + 180) % 360 - 180) * radius)
			lid = np.clip((cap["diameter"] / 2 - d) / size[mine] + 0.5, 0, 1)
			lines = np.maximum(lines, missile.band(d - cap["ring"] / 2, line["width"], size[mine]))
			out[mine] = out[mine] + (np.asarray(cap["colour"]) / 255 * shading[mine] - out[mine]) * lid[..., None]
		ink[mine] = lines
		grime[mine] = near * wear.get("grime", 0.08) * (0.5 + missile.noise(inches[mine], 0.6, 19))
	out = out * np.clip(1 - grime, 0.6, 1.2)[..., None]
	out = out * (1 - line["depth"] * ink)[..., None]
	return np.clip(out, 0, 1)


def bleed(colour, covered, passes=8):
	# Each island's paint carried out into the atlas's texels no part covers,
	# a texel a pass, each taking the mean of its neighbours already painted.
	# The stores bake with no margin, so an island's edge texels stood beside
	# the grey gutter, which the texture's filtering and its smaller mipmap
	# levels blend into the edge: a dark wingtip rail, its faces a few
	# texels wide, would take a light rim, lighter the further off it is
	# seen. Returns the paint and which texels hold it
	out, have = np.array(colour, float), np.array(covered, bool)
	h, w = have.shape
	for _ in range(passes):
		total, count = np.zeros(out.shape), np.zeros((h, w))
		for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
			into = (slice(max(dy, 0), h + min(dy, 0)), slice(max(dx, 0), w + min(dx, 0)))
			source = (slice(max(-dy, 0), h + min(-dy, 0)), slice(max(-dx, 0), w + min(-dx, 0)))
			total[into] += np.where(have[source][..., None], out[source], 0.0)
			count[into] += have[source]
		fill = ~have & (count > 0)
		if not fill.any():
			break
		out[fill] = total[fill] / count[fill][..., None]
		have |= fill
	return out, have


# The airframe's markings (layout.markings), drawn as each marking's ink over
# the paint, 0 to 1, at `scale` pixels per inch, from MIL-STD-2161C(AS)'s
# dimensioned figures: build.py lays each image on the skin at its place

# The modified vertical block letters (MIL-STD-2161C figure A-4(a)): six
# blocks high, strokes a block wide, 4.5 blocks across (A and M 5.5, W 6.5),
# a block between letters. Each letter as polygons in blocks, y up from the
# baseline; only the letters the markings use
BLOCKS = {
	"A": (5.5, [[(0, 0), (1, 0), (3.25, 6), (2.25, 6)], [(4.5, 0), (5.5, 0), (3.25, 6), (2.25, 6)], [(1, 1.5), (4.5, 1.5), (4.5, 2.5), (1, 2.5)]]),
	"N": (4.5, [[(0, 0), (1, 0), (1, 6), (0, 6)], [(3.5, 0), (4.5, 0), (4.5, 6), (3.5, 6)], [(0, 6), (1, 6), (4.5, 0), (3.5, 0)]]),
	"V": (4.5, [[(0, 6), (1, 6), (2.75, 0), (1.75, 0)], [(3.5, 6), (4.5, 6), (2.75, 0), (1.75, 0)]]),
	"Y": (4.5, [[(0, 6), (1, 6), (2.75, 3), (1.75, 3)], [(3.5, 6), (4.5, 6), (2.75, 3), (1.75, 3)], [(1.75, 0), (2.75, 0), (2.75, 3.2), (1.75, 3.2)]]),
}


def block_width(text):
	# A word's width in blocks: its letters and a block between each
	return sum(BLOCKS[c][0] for c in text) + (len(text) - 1)


def block_text(text, height, scale):
	# A word in block letters `height` inches high, as ink (H, W) 0..1 at
	# `scale` pixels per inch, its box exactly the word's
	from PIL import Image, ImageDraw
	block = height / 6 * scale
	w, h = int(round(block_width(text) * block)), int(round(height * scale))
	image = Image.new("L", (w, h), 0)
	draw = ImageDraw.Draw(image)
	x = 0.0
	for c in text:
		width, polygons = BLOCKS[c]
		for polygon in polygons:
			draw.polygon([((x + px) * block, h - py * block) for px, py in polygon], fill=255)
		x += width + 1
	return np.asarray(image, float) / 255


def insignia(diameter, scale):
	# The national star insignia in the tactical paint scheme (MIL-STD-2161C
	# figure A-1): the circle `diameter` inches across in the contrasting grey
	# with the star inside it left in the paint, the five points on the
	# circle; each bar a radius long past the circle, half a radius high
	# inside an eighth-radius outline, the paint inside it split by a stripe
	# a sixth of a radius high. Ink (H, W) 0..1, the box the marking fills:
	# 2.125 diameters across and one high
	from PIL import Image, ImageDraw
	r = diameter / 2 * scale
	outline, inner, stripe = r / 8, r / 2, r / 6
	w, h = int(round(2 * (2 * r + outline))), int(round(2 * r))
	image = Image.new("L", (w, h), 0)
	draw = ImageDraw.Draw(image)
	cx, cy = w / 2, h / 2
	bar = inner / 2 + outline
	draw.rectangle([cx - 2 * r - outline, cy - bar, cx + 2 * r + outline, cy + bar], fill=255)
	for side in (-1, 1):
		a, b = sorted((cx + side * r * 0.9, cx + side * (2 * r)))
		draw.rectangle([a, cy - inner / 2, b, cy + inner / 2], fill=0)
		draw.rectangle([a, cy - stripe / 2, b, cy + stripe / 2], fill=255)
	draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=255)
	small = r * math.sin(math.radians(18)) / math.sin(math.radians(126))
	points = []
	for k in range(10):
		a = math.radians(90 + 36 * k)
		rr = r if k % 2 == 0 else small
		points.append((cx + rr * math.cos(a), cy - rr * math.sin(a)))
	draw.polygon(points, fill=0)
	return np.asarray(image, float) / 255


def chevron(scale, text=True, left=False):
	# The engine intake warning chevron (MIL-STD-2161C figure A-15): two arms
	# 2 in wide, their outer edges 21.5 in apart at their open ends and
	# meeting 42 in on; JET along the upper arm and INTAKE along the lower,
	# 2 in letters, and between the arms' open ends the 19 in DANGER box with
	# its arrow pointing away from the point, all the lettering in the paint.
	# Ink (H, W) 0..1, the point at the right, or with `left` at the left (the
	# right side's, its point aft as the left side's is), the lettering
	# reading left to right either way, as dvids5074311 shows it on the right
	from PIL import Image, ImageDraw, ImageFont
	w, h = int(round(42 * scale)), int(round(21.5 * scale))

	def x(v):
		return w - v if left else v

	image = Image.new("L", (w, h), 0)
	draw = ImageDraw.Draw(image)
	tip = np.array([w, h / 2])
	for start, sign in ((np.array([0.0, 0.0]), 1), (np.array([0.0, float(h)]), -1)):
		along = (tip - start) / np.linalg.norm(tip - start)
		inward = np.array([-along[1], along[0]]) * sign
		if inward[1] * sign < 0:
			inward = -inward
		off = inward * 2.0 * scale
		# the inner edge, parallel to the outer, meets the other arm's on the
		# centreline
		meet = start + off + along * ((h / 2 - (start + off)[1]) / along[1])
		draw.polygon([(x(p[0]), p[1]) for p in (start, tip, meet, start + off)], fill=255)
		if text:
			word = "JET" if sign > 0 else "INTAKE"
			size = int(round(2.0 * scale * 0.8))
			font = ImageFont.load_default(size=max(6, size))
			label = Image.new("L", (int(14 * scale), int(2.0 * scale)), 0)
			ImageDraw.Draw(label).text((label.width / 2, label.height / 2), word, fill=255, font=font, anchor="mm")
			angle = math.degrees(math.atan2(-along[1], along[0])) * (-1 if left else 1)
			turned = label.rotate(angle, expand=True, resample=Image.BICUBIC)
			middle = start + along * 12.0 * scale + off / 2
			image.paste(0, (int(x(middle[0]) - turned.width / 2), int(middle[1] - turned.height / 2)), turned)
	# the DANGER box: 19 in long and 2.7 in high on the centreline at the open end
	top, bottom = h / 2 - 1.35 * scale, h / 2 + 1.35 * scale
	ends = sorted([x(0), x(19 * scale)])
	draw.rectangle([ends[0], top, ends[1], bottom], fill=255)
	if text:
		font = ImageFont.load_default(size=max(6, int(round(2.0 * scale * 0.8))))
		draw.text((x(11.5 * scale), h / 2), "DANGER", fill=0, font=font, anchor="mm")
		draw.polygon([(x(1.0 * scale), h / 2), (x(3.0 * scale), top + 0.5 * scale), (x(3.0 * scale), bottom - 0.5 * scale)], fill=0)
	return np.asarray(image, float) / 255


def placard(lines, size, scale):
	# A block of the contrasting grey `size` (length, height) inches with its
	# lines of lettering in the paint (BEWARE OF BLAST, MIL-STD-2161C figure
	# A-8; DANGER ARRESTING HOOK in the hook's T, figure A-14). Ink (H, W)
	from PIL import Image, ImageDraw, ImageFont
	w, h = int(round(size[0] * scale)), int(round(size[1] * scale))
	image = Image.new("L", (w, h), 255)
	draw = ImageDraw.Draw(image)
	height = h / (len(lines) + 1)
	font = ImageFont.load_default(size=max(6, int(height)))
	for i, text in enumerate(lines):
		draw.text((w / 2, height * (i + 1)), text, fill=0, font=font, anchor="mm")
	return np.asarray(image, float) / 255


def hook_tee(scale, bar=(20.0, 7.0), stem=(7.0, 7.0), arrow=True):
	# The arresting hook marking: a T, its top `bar` (across, high) inches,
	# its stem `stem` (wide, below the top) at the top's middle, DANGER /
	# ARRESTING HOOK in the top and, with `arrow`, an arrow down the stem, the
	# lettering and arrow in the paint. MIL-STD-2161C figure A-14's are the
	# defaults (a 20 x 7 in top, a 7 in stem to 14 in, a 2 in arrow); the
	# photos read the jets' far smaller. Ink (H, W)
	from PIL import Image, ImageDraw, ImageFont
	w, top, h = int(round(bar[0] * scale)), bar[1] * scale, int(round((bar[1] + stem[1]) * scale))
	image = Image.new("L", (w, h), 0)
	draw = ImageDraw.Draw(image)
	draw.rectangle([0, 0, w, top], fill=255)
	draw.rectangle([w / 2 - stem[0] / 2 * scale, 0, w / 2 + stem[0] / 2 * scale, h], fill=255)
	# the lettering two lines in the top, each 2/7 of its height (A-14's 2 in in 7)
	font = ImageFont.load_default(size=max(6, int(round(top * 2 / 7))))
	draw.text((w / 2, top * 2.0 / 7), "DANGER", fill=0, font=font, anchor="mm")
	draw.text((w / 2, top * 4.6 / 7), "ARRESTING HOOK", fill=0, font=font, anchor="mm")
	if arrow:
		x = w / 2
		draw.polygon([(x - 1.0 * scale, top + 1.5 * scale), (x + 1.0 * scale, top + 1.5 * scale), (x, top + 3.5 * scale)], fill=0)
	return np.asarray(image, float) / 255


def walkway(size, line, spacing, scale, falling=True):
	# A walkway square: its outline `line` inches wide round a box `size`
	# (across, high) inches, and three stripes as wide at 45 deg inside it,
	# the middle one through its centre and the others `spacing` inches
	# either side, square to them. With `falling` the stripes run from the
	# top left to the bottom right as read (on the left LEX seen from above,
	# forward up: from forward outboard to aft inboard). Ink (H, W)
	w, h = int(round(size[0] * scale)), int(round(size[1] * scale))
	y, x = np.mgrid[0:h, 0:w].astype(float) + 0.5
	u, v = (x - w / 2) / scale, (y - h / 2) / scale
	across = (u - v if falling else u + v) / math.sqrt(2)   # inches square to the stripes
	half = line / 2
	ink = np.zeros((h, w))
	for k in (-1, 0, 1):
		ink[np.abs(across - k * spacing) <= half] = 1
	border = (np.minimum(x, w - x) <= line * scale) | (np.minimum(y, h - y) <= line * scale)
	ink[border] = 1
	return ink


# The airframe's atlas (build.py paint()): its UV islands too narrow to hold a
# texel centre of their own, to which the bake writes nothing, given texels of
# their own here


def closest(triangle, points):
	# The nearest point of a triangle (3, 2) to each point (N, 2): its
	# barycentric weights on the triangle's corners (N, 3), and the distance (N)
	a, b, c = np.asarray(triangle, float)
	points = np.asarray(points, float)
	weights, distance = np.zeros((len(points), 3)), np.full(len(points), np.inf)
	for i, j in ((0, 1), (1, 2), (2, 0)):
		p, q = (a, b, c)[i], (a, b, c)[j]
		edge = q - p
		length = edge @ edge
		s = np.clip(((points - p) @ edge) / length, 0, 1) if length > 0 else np.zeros(len(points))
		d = np.linalg.norm(points - (p + s[:, None] * edge), axis=1)
		better = d < distance
		distance[better] = d[better]
		w = np.zeros((better.sum(), 3))
		w[:, i], w[:, j] = 1 - s[better], s[better]
		weights[better] = w
	v0, v1, v2 = b - a, c - a, points - a
	den = v0[0] * v1[1] - v1[0] * v0[1]
	if abs(den) > 1e-18:
		v = (v2[:, 0] * v1[1] - v1[0] * v2[:, 1]) / den
		w = (v0[0] * v2[:, 1] - v2[:, 0] * v0[1]) / den
		inside = (v >= 0) & (w >= 0) & (v + w <= 1)
		weights[inside] = np.c_[1 - v - w, v, w][inside]
		distance[inside] = 0.0
	return weights, distance


def bare(triangles):
	# Whether a UV island, its triangles (K, 3, 2) in the atlas's pixels, is
	# too narrow for the bake: narrower than half a texel on the mean (twice
	# its area over its outline's length), or holding no texel centre (pixel
	# x + 0.5, y + 0.5). A closed door's crack strip at 4096, 0.14 texels
	# across, held a centre here and there, and between them drew the door's
	# own paint, which the bake's margin carries into the gap round its island
	triangles = np.asarray(triangles, float)
	a, b = triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0]
	area = 0.5 * np.abs(a[:, 0] * b[:, 1] - a[:, 1] * b[:, 0]).sum()
	uses = {}
	for t in triangles:
		for i in range(3):
			edge = tuple(sorted((tuple(np.round(t[i], 4)), tuple(np.round(t[(i + 1) % 3], 4)))))
			uses[edge] = uses.get(edge, 0) + 1
	outline = sum(math.dist(*edge) for edge, n in uses.items() if n == 1)
	if outline > 0 and 2 * area / outline < 0.5:
		return True
	for t in triangles:
		(x0, y0), (x1, y1) = np.floor(t.min(0)).astype(int), np.ceil(t.max(0)).astype(int)
		xs, ys = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
		if (closest(t, np.c_[xs.ravel(), ys.ravel()])[1] == 0).any():
			return False
	return True


def across(triangle, weights, count=5):
	# Points across a narrow triangle (UVs (3, 2)) at each of the points
	# `weights` (N, 3, barycentric): its longest edge's point level with it
	# along that edge, the opposite side's, and `count` in all evenly between,
	# as barycentric weights (N, count, 3). A strip packed with no width
	# keeps its width on the jet: its corners lie on one line in the atlas,
	# and the nearest point to a texel fell on either long edge, its outer
	# corner seeing half the sky below the jet or its inner corner none
	t = np.asarray(triangle, float)
	a, b = max(((0, 1), (1, 2), (2, 0)), key=lambda e: np.sum((t[e[1]] - t[e[0]]) ** 2))
	c = 3 - a - b
	ab = t[b] - t[a]
	length = ab @ ab
	weights = np.asarray(weights, float)
	if length <= 1e-18:
		return np.repeat(weights[:, None], count, axis=1)
	along = np.clip((weights @ t - t[a]) @ ab / length, 0, 1)
	level = float(np.clip((t[c] - t[a]) @ ab / length, 0, 1))
	near, far = np.zeros((len(along), 3)), np.zeros((len(along), 3))
	near[:, a], near[:, b] = 1 - along, along
	low = along <= level
	# a far corner level with the near end (packed onto it, a strip with no
	# width) puts the whole edge between them at that end: its far point the
	# far corner
	s = np.where(low, along / level if level > 1e-12 else 1.0, (along - level) / max(1 - level, 1e-12))
	far[low, a], far[low, c] = 1 - s[low], s[low]
	far[~low, c], far[~low, b] = 1 - s[~low], s[~low]
	f = np.linspace(0, 1, count)[None, :, None]
	return near[:, None] * (1 - f) + far[:, None] * f


def lent(islands, baked, shaded, reach=0.75, count=5):
	# Each texel within `reach` texels of a bare island's triangle (islands:
	# [(UVs (K, 3, 2) in the atlas's pixels, x along a row and y up from the
	# bottom row as the bakes' rows run, places (K, 3, 3) on the jet, unit
	# normals (K, 3), own: {bake: (K,)} what the triangle itself is, its
	# finish and its nozzle mark)]) takes the triangle's own place at its
	# nearest point, its normal and what it is, and the mean of the shade cast
	# at `count` points across the triangle there (across(); shaded(places
	# (M, 3), normals (M, 3), islands (M,), triangles (M,)) -> (M,), each
	# point's island and triangle by index). Borrowed from the
	# texel the bake reached nearest, a strip in a crack took the light of
	# the open skin beside it: a closed door's edges, square to its face and
	# a twentieth of an inch across, read as bright as the door, a light
	# line round it where the crack is dark. The packing leaves four texels
	# between islands, so a texel this near a bare island is no other's own;
	# the bake's margin may have dilated a neighbour into it. Changes baked's
	# arrays in place; returns which texels it filled, (H, W) booleans
	h, w = baked["shade"].shape[:2]
	rows, columns, places, normals, owns, which, triangles, spread = [], [], [], [], {}, [], [], []
	for i, (uvs, xyz, ns, own) in enumerate(islands):
		for k, (t, p, n) in enumerate(zip(np.asarray(uvs, float), np.asarray(xyz, float), np.asarray(ns, float))):
			(x0, y0), (x1, y1) = np.floor(t.min(0) - reach).astype(int), np.ceil(t.max(0) + reach).astype(int)
			xs, ys = np.meshgrid(np.arange(max(x0, 0), min(x1, w - 1) + 1), np.arange(max(y0, 0), min(y1, h - 1) + 1))
			xs, ys = xs.ravel(), ys.ravel()
			weights, distance = closest(t, np.c_[xs + 0.5, ys + 0.5])
			pick = distance <= reach
			rows.append(ys[pick])
			columns.append(xs[pick])
			places.append(weights[pick] @ p)
			spread.append(across(t, weights[pick], count) @ p)
			normals.append(np.repeat(n[None], pick.sum(), axis=0))
			which.append(np.full(pick.sum(), i))
			triangles.append(np.full(pick.sum(), k))
			for key, values in own.items():
				owns.setdefault(key, []).append(np.repeat(np.asarray(values)[k], pick.sum()))
	filled = np.zeros((h, w), bool)
	if not rows:
		return filled
	rows, columns, places, normals = np.concatenate(rows), np.concatenate(columns), np.concatenate(places), np.concatenate(normals)
	if not len(rows):
		return filled
	owns = {key: np.concatenate(values) for key, values in owns.items()}
	repeat = lambda a: np.repeat(a, count, axis=0)
	cast = shaded(np.concatenate(spread).reshape(-1, 3), repeat(normals), repeat(np.concatenate(which)), repeat(np.concatenate(triangles)))
	baked["shade"][rows, columns] = cast.reshape(-1, count).mean(1)
	for key, values in owns.items():
		baked[key][rows, columns] = values.astype(baked[key].dtype)
	baked["where"][rows, columns] = places
	baked["normal"][rows, columns] = (normals + 1) / 2
	filled[rows, columns] = True
	return filled


class Cells:
	# Points (N, 3) indexed by the cube of side `size` (metres) each lies in,
	# so what lies near a short segment or a fastener's head is read from a
	# few cubes rather than a slab of the whole jet: thousands of traced
	# segments, each read against every texel in its stations' slab, ran to
	# billions of distances
	def __init__(self, points, size):
		self.size = size
		cell = np.floor(points / size).astype(np.int64)
		self.low = cell.min(0)
		cell -= self.low
		self.span = cell.max(0) + 1
		key = (cell[:, 0] * self.span[1] + cell[:, 1]) * self.span[2] + cell[:, 2]
		self.order = np.argsort(key, kind="stable")
		self.keys = key[self.order]

	def near(self, a, b, reach):
		# indices of the points in every cube within `reach` of the box round a and b
		lo = np.floor((np.minimum(a, b) - reach) / self.size).astype(np.int64) - self.low
		hi = np.floor((np.maximum(a, b) + reach) / self.size).astype(np.int64) - self.low
		lo, hi = np.maximum(lo, 0), np.minimum(hi, self.span - 1)
		if (hi < lo).any():
			return np.zeros(0, np.int64)
		out = []
		for i in range(lo[0], hi[0] + 1):
			for j in range(lo[1], hi[1] + 1):
				first = (i * self.span[1] + j) * self.span[2]
				start = np.searchsorted(self.keys, first + lo[2])
				end = np.searchsorted(self.keys, first + hi[2], side="right")
				if end > start:
					out.append(self.order[start:end])
		return np.concatenate(out) if out else np.zeros(0, np.int64)


def joined(segments, keys=None):
	# The line each segment (M, 2, 3) belongs to: segments sharing an end
	# joined, as a line's corners are laid one after another and a door's
	# outline closes on itself. Returns one index a segment, its line's: the
	# least of its segments' `keys` (M integers, default each its own index),
	# so a line keyed by where it was given (layout.panels) keeps its key
	# however many segments laying it on the skin made
	segments = np.asarray(segments, float)
	parent = list(range(len(segments)))

	def root(i):
		while parent[i] != i:
			parent[i] = parent[parent[i]]
			i = parent[i]
		return i
	first = {}
	for i, ends in enumerate(segments):
		for end in ends:
			key = tuple(np.round(end, 6))
			if key in first:
				a, b = root(i), root(first[key])
				parent[max(a, b)] = min(a, b)
			else:
				first[key] = i
	roots = np.array([root(i) for i in range(len(segments))])
	if keys is None:
		return roots
	keys = np.asarray(keys)
	least = {}
	for r, k in zip(roots, keys):
		least[r] = min(least.get(r, k), k)
	return np.array([least[r] for r in roots])


def named(name):
	# The key a door's seam steps the panels' tones by (tones(), draw()): its
	# name's, past every line layout.panels gives, so the build and check.py
	# key it alike however its outline's segments were laid
	return 1000000 + zlib.crc32(name.encode()) % 1000000


def oriented(segments):
	# A joined line's segments (M, 2, 3) turned to run one way along it, the
	# first as given and each one after it to follow on from its neighbour; a
	# closed line (no free end) then runs so its area's largest component is
	# positive, a rule its frame alone decides, so the build and check.py
	# turn it alike however its edges came (by the skin's normals round it,
	# the build counted a well's walls and the doors' insides and turned the
	# right nose door the other way). A door's outline came as the mesh's
	# edges, each its own way round, and its tone flipped from one edge to
	# the next round the door
	segments = np.array(segments, float)
	ends = [tuple(np.round(e, 6)) for e in segments.reshape(-1, 3)]
	touching = {}
	for i in range(len(segments)):
		for j in (0, 1):
			touching.setdefault(ends[2 * i + j], []).append((i, j))
	done = np.zeros(len(segments), bool)
	for first in range(len(segments)):
		if done[first]:
			continue
		done[first] = True
		queue = [first]
		while queue:
			i = queue.pop()
			for j in (0, 1):
				for k, side in touching[ends[2 * i + j]]:
					if done[k]:
						continue
					# a neighbour at this segment's end starts there; at its start, ends there
					if side == j:
						segments[k] = segments[k][::-1]
						ends[2 * k], ends[2 * k + 1] = ends[2 * k + 1], ends[2 * k]
					done[k] = True
					queue.append(k)
	counts = {}
	for e in ends:
		counts[e] = counts.get(e, 0) + 1
	if len(segments) > 2 and all(c % 2 == 0 for c in counts.values()):
		area = np.cross(segments[:, 0] - segments[0, 0], segments[:, 1] - segments[0, 0]).sum(0) / 2
		if area[np.argmax(np.abs(area))] < 0:
			segments = segments[:, ::-1]
	return segments


def mixed(values):
	# splitmix64's finaliser on uint64s: every output bit hangs on every input
	# bit, so keys a fixed distance apart draw unrelated numbers
	z = np.asarray(values, np.uint64)
	with np.errstate(over="ignore"):
		z = (z ^ (z >> np.uint64(30))) * np.uint64(0xBF58476D1CE4E5B9)
		z = (z ^ (z >> np.uint64(27))) * np.uint64(0x94D049BB133111EB)
	return z ^ (z >> np.uint64(31))


def draw(keys, seed):
	# a draw from the normal distribution for each integer key, the same each
	# build. A multiplicative hash's draws ran in step for keys a fixed
	# distance apart: each panel line's mirror image, a fixed count of
	# segments after it, stepped the paint by nearly the same amount, and the
	# tones read the same on both sides
	with np.errstate(over="ignore"):
		h = mixed(np.asarray(keys, np.int64).astype(np.uint64) * np.uint64(0x9E3779B97F4A7C15) + np.uint64(int(seed * 1e6)))
	u = ((h >> np.uint64(11)).astype(np.float64) + 0.5) / 2.0 ** 53
	v = ((mixed(h) >> np.uint64(11)).astype(np.float64) + 0.5) / 2.0 ** 53
	return np.sqrt(-2 * np.log(u)) * np.cos(2 * math.pi * v)


def tones(points, normals, segments, lines, spread, reach, seed=0.37, chunk=200000):
	# The panels' tones, a factor about 1 at each point of the skin (N, 3,
	# inches, any frame; normals (N, 3), its skin's): the paint steps across
	# each panel line (segments (M, 2, 3), lines (M) the line each is part
	# of, joined()) by as much as two panels' tones differ, a normal spread
	# of `spread` each (the step's spread `spread` times root 2), half the
	# step up on one side and half down on the other. The step holds out to
	# half `reach` either side and eases away by `reach`; past a line's free
	# end it spreads across as wide as the point lies beyond the end, and
	# eases away by half `reach`. The lines the photos traced seldom close a
	# panel: walled off by them, one panel held nine tenths of the skin
	points, normals = np.asarray(points, float), np.asarray(normals, float)
	segments, lines = np.asarray(segments, float), np.asarray(lines)
	out = np.ones(len(points))
	if not len(segments):
		return out
	cells = Cells(points, reach / 2)
	names, which = np.unique(lines, return_inverse=True)
	steps = spread * math.sqrt(2) * draw(names, seed)
	for k in range(len(names)):
		seg = segments[which == k]
		pick = np.unique(np.concatenate([cells.near(a, b, reach) for a, b in seg]))
		seg = oriented(seg)
		ends, counts = np.unique(np.round(seg.reshape(-1, 3), 6), axis=0, return_counts=True)
		free = {tuple(e) for e, c in zip(ends, counts) if c == 1}
		loose = np.array([[tuple(np.round(a, 6)) in free, tuple(np.round(b, 6)) in free] for a, b in seg])
		for part in range(0, len(pick), chunk):
			index = pick[part:part + chunk]
			q, n = points[index], normals[index]
			best = np.full(len(index), np.inf)
			off, beyond = np.zeros(len(index)), np.zeros(len(index))
			for (a, b), (open_a, open_b) in zip(seg, loose):
				d = b - a
				length = float(np.linalg.norm(d))
				if length < 1e-9:
					continue
				along = d / length
				raw = (q - a) @ along
				t = np.clip(raw, 0.0, length)
				gap = np.linalg.norm(q - (a + t[:, None] * along), axis=1)
				closer = gap < best
				if not closer.any():
					continue
				best[closer] = gap[closer]
				off[closer] = np.einsum("ij,ij->i", np.cross(along, q[closer] - a), n[closer])
				past = np.where(raw < 0, -raw if open_a else 0.0, np.where(raw > length, raw - length if open_b else 0.0, 0.0))
				beyond[closer] = past[closer]
			side = np.clip(off / np.maximum(beyond, 0.01), -1.0, 1.0)
			hold = (1 - smoothstep(best, reach / 2, reach)) * (1 - smoothstep(beyond, 0.0, reach / 2))
			out[index] += steps[k] / 2 * side * hold
	return out


def smoothstep(x, a, b):
	t = np.clip((x - a) / (b - a), 0, 1)
	return t * t * (3 - 2 * t)


def weathering(inches, station, up, tone, wear):
	# The light weathering every skin is laid over (plan #8 Weathering), a
	# factor on the paint a point: the panels' tones (tone, tones()); a fine
	# mottle; grime in streaks along the stations under the aft fuselage,
	# from wear.grime from to full (FS), on skin facing down past its
	# facing; and the exhaust's staining, darker towards the nozzles, from
	# wear.exhaust from to full. inches: each point in inches (any frame,
	# for the noise); station: its FS; up: its normal's upward part
	g, e = wear["grime"], wear["exhaust"]
	mottle = (missile.noise(inches, 4.0, 23) - 0.5) / missile.SPREAD
	streak = missile.noise(inches * np.array([0.08, 1.0, 1.0]), 1.5, 29)   # features about 19 in along the stations and 1.5 in across
	under = smoothstep(-up, -g["facing"], -g["facing"] + 0.3)
	grime = g["amount"] * smoothstep(station, g["from"], g["full"]) * under * np.clip((streak - 0.35) / 0.4, 0, 1)
	exhaust = e["amount"] * smoothstep(station, e["from"], e["full"]) * (0.6 + 0.4 * streak)
	return tone * (1 + wear["mottle"] * mottle) * (1 - grime) * (1 - exhaust)
