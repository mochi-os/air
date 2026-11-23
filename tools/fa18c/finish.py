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
	# Whether a UV island, its triangles (K, 3, 2) in the atlas's pixels,
	# holds no texel centre (pixel x + 0.5, y + 0.5)
	for t in np.asarray(triangles, float):
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
