# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# Weathers one atlas of the ship's paint (decision 17, amended 2026-11-03):
# from the maps build.py bakes for a group of meshes (each texel's position
# and normal in the ship frame, its ambient occlusion, and which texels the
# atlas holds), the group's colour map and height map, by rule:
# - the haze grey, its tone shifting plate to plate, with touch-up patches of
#   fresher paint and a faint mottling;
# - the plates' seams and the frames behind them as grooves and a slight
#   dishing in the height map, the seams a shade darker;
# - streaks down from the group's fittings, rust or dirty water, and the
#   runs the photos show where they show them, each face's streaks as heavy
#   as its photos';
# - grime toward the deck and the waterline, and walking surfaces darker;
# - wear by zone: each texel's level of wear (0 almost clean, 1 the most
#   worn), from the group's zones, scaling the paint's blotching, its grime
#   patches, rust and dirt weeping down the walls, the scum line above the
#   boot top, and scuffs worn through dark paint;
# - the baked occlusion multiplied in.
# Everything is seeded, so a build gives the same texture every time.
#
# layout.weathering: {"samples": n, "grey": [r, g, b] (linear), "rust": [r, g, b],
#   "dirt": [r, g, b] (sRGB), "groups": [{"material", "meshes", "size", "plates":
#   {"height", "width", "origin"}, "frames": spacing, "touchups": share of cells, "streaks": {"spacing",
#   "length": [min, max], "rust"}, "grey": [r, g, b] (the group's own paint), "runs": [{"top": [x, y, z],
#   "length", "width", "rust": bool, "weight"}], "regions": [{"box": [[x, y, z], [x, y, z]], "streaks": factor}],
#   "decks": [{"box": [[x, y, z], [x, y, z]], "colour": [r, g, b] (linear), "dirt": {"mottle": [[scale, spread], ...],
#   "patches": {"scale", "share", "darkening"}, "grain": relief}}]: walking surfaces in a box their own non-skid,
#   dirtied}],
#   "flat": no normal map (build.py), "level": the wear where no zone says, "zones": [{"level", "box": [[x, y, z], [x, y, z]], "facing": "wall" | "under" |
#   "up", "soft": metres}] (each later zone over the earlier, its box's edges blended over `soft`), "wear": {"blotches":
#   [[scale, spread, stretch], ...], "patches": {"scale", "share", "tint": [r, g, b], "stretch"}, "weeps": {"spacing", "height",
#   "share", "length": [min, max], "width": [min, max], "rust"}, "scum": {"height", "tint"}, "scuffs": {"scale",
#   "share", "lift": [r, g, b]}}: each at full wear}]}
#
# usage: python3 -I weather.py MAPS.npz MATERIAL COLOUR.png HEIGHT.png [--facts PATH]
import json, sys
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from plates import lamps  # noqa: E402

UP = np.array([0.0, 1.0, 0.0])
NOISE = 0.371   # noise()'s own spread, which a dirt's spreads are given in units of


def hashed(*keys):
	# A deterministic value in [0, 1) per integer key tuple, elementwise (the
	# multiplies wrap, as the hash means them to). The keys folded in, then
	# mixed through (a 64-bit finaliser) so that keys a step apart (seed + 1,
	# seed + 2) give unrelated values, and the top bits taken
	h = np.uint64(1469598103934665603)
	with np.errstate(over="ignore"):
		for k in keys:
			h = (h ^ np.asarray(k, dtype=np.int64).astype(np.uint64)) * np.uint64(1099511628211)
			h ^= h >> np.uint64(29)
		h ^= h >> np.uint64(33)
		h *= np.uint64(0xFF51AFD7ED558CCD)
		h ^= h >> np.uint64(33)
		h *= np.uint64(0xC4CEB9FE1A85EC53)
		h ^= h >> np.uint64(33)
	return (h >> np.uint64(40)).astype(np.float64) / float(1 << 24)


def sill(f):
	# The lower edge of a window or radar face, as its two ends: given by four
	# corners, by a plane (x= or z=) with the other two extents, or by a plan
	# line with the distances along it it spans
	if "corners" in f:
		corners = np.array(f["corners"], float)
		low = corners[np.argsort(corners[:, 1])[:2]]
		return low[0], low[1]
	y = f["y"][0]
	if "plane" in f:
		axis, value = f["plane"].split("=")
		value = float(value)
		if axis == "x":
			return np.array([value, y, f["z"][0]]), np.array([value, y, f["z"][1]])
		return np.array([f["x"][0], y, value]), np.array([f["x"][1], y, value])
	(x0, z0), (x1, z1) = f["line"]
	length = np.hypot(x1 - x0, z1 - z0)
	a, b = f["along"]
	at = lambda d: np.array([x0 + (x1 - x0) * d / length, y, z0 + (z1 - z0) * d / length])
	return at(a), at(b)


def noise(p, scale, seed=0):
	# Value noise in [-1, 1] at points p (N, 3), lattice spacing `scale` metres
	q = p / scale
	i = np.floor(q).astype(np.int64)
	f = q - i
	f = f * f * (3 - 2 * f)
	out = np.zeros(len(p))
	for dx in (0, 1):
		for dy in (0, 1):
			for dz in (0, 1):
				w = (f[:, 0] if dx else 1 - f[:, 0]) * (f[:, 1] if dy else 1 - f[:, 1]) * (f[:, 2] if dz else 1 - f[:, 2])
				out += w * hashed(i[:, 0] + dx, i[:, 1] + dy, i[:, 2] + dz, seed)
	return out * 2 - 1


def across(n):
	# The horizontal direction along a face (unit), from its normal; any for a level face
	t = np.stack([n[:, 2], np.zeros(len(n)), -n[:, 0]], 1)
	length = np.linalg.norm(t, axis=1)
	flat = length < 1e-6
	t[flat] = (1.0, 0.0, 0.0)
	length[flat] = 1.0
	return t / length[:, None]


def seam(x, spacing, width):
	# 1 on a seam line every `spacing` metres, 0 away from it, over `width`
	d = np.abs((x + spacing / 2) % spacing - spacing / 2)
	return np.clip(1 - d / width, 0, 1)


def plates(p, n, spec, texel):
	# Each texel's plate (row, column) and its nearness to a seam: on a wall the
	# rows are bands of `height` up from `origin`, each offset half a plate's
	# `width` from the one below; on a level face the plates lie fore and aft
	h, w, origin = spec["height"], spec["width"], spec.get("origin", 0.0)
	t = across(n)
	level = np.abs(n[:, 1]) > 0.7
	u = np.where(level, p[:, 0], np.einsum("ij,ij->i", p, t))
	v = np.where(level, p[:, 2], p[:, 1] - origin)
	row = np.floor(v / h).astype(np.int64)
	shift = (row % 2) * w / 2
	column = np.floor((u + shift) / w).astype(np.int64)
	width = max(0.012, texel * 0.75)
	lines = np.maximum(seam(v, h, width), seam(u + shift, w, width))
	return row, column, lines, u, v


def fittings(facts, material):
	# Where streaks start: (point, weight) for every fitting the group carries.
	# The island: each window's sill, each radar face's lower edge, the
	# underside of every detail, the lip of every level and the lamps round
	# its numbers; the radomes: round each one where it is widest, below the
	# seam there; the hull: the sponsons' lower edges and the deck's edge,
	# where the scuppers drain
	layout = facts["layout"]
	out = []
	if material == "domes":
		for d in layout.get("island", {}).get("domes", []):
			if "profile" not in d:
				continue
			y, r = max(d["profile"], key=lambda q: q[1])
			count = max(4, int(2 * np.pi * r / 0.8))
			for k in range(count):
				a = 2 * np.pi * k / count
				out.append(((d["centre"][0] + (r + 0.02) * np.cos(a), y, d["centre"][1] + (r + 0.02) * np.sin(a)), 0.6))
	elif material == "island":
		island = layout.get("island", {})
		for edges, spacing, weight in ((island.get("windows", []), 0.9, 1.0), (island.get("panels", []), 0.7, 1.6)):
			for f in edges:
				a, b = sill(f)
				count = max(1, int(np.linalg.norm(b - a) / spacing))
				for k in range(count + 1):
					out.append((tuple(a + (b - a) * k / count), weight))
		for d in island.get("details", []):
			if d["kind"] in ("box", "cylinder", "dish"):
				c = d.get("centre") or d.get("base")
				if c:
					y = c[1] - (d.get("size", [0, 0, 0])[1] / 2 if d["kind"] == "box" else 0)
					out.append(((c[0], y, c[2]), 0.8))
		prisms = island.get("prisms", [])
		middle = [np.mean([c[0] for q in prisms for c in q["outline"]]), np.mean([c[1] for q in prisms for c in q["outline"]])] if prisms else [0, 0]
		cells = layout.get("lettering", {}).get("cells", {})
		for plate in layout.get("lettering", {}).get("plates", []):
			if plate.get("on") == "island" and "lamps" in cells.get(plate["cell"], {}):
				out += [(foot, 0.6) for foot, _ in lamps(plate, cells[plate["cell"]], middle)]
		for prism in prisms:
			outline = prism["outline"]
			for (x0, z0), (x1, z1) in zip(outline, outline[1:] + outline[:1]):
				length = np.hypot(x1 - x0, z1 - z0)
				for k in range(int(length / 2.2)):
					s = (k + hashed(int(x0 * 10), int(z0 * 10), k)) / max(1, int(length / 2.2))
					out.append(((x0 + (x1 - x0) * s, prism["top"], z0 + (z1 - z0) * s), 0.7))
	else:
		for s in layout.get("sponsons", []):
			outline = s["outline"]
			# a sloped underside gives a height per corner
			bottoms = s["bottom"] if isinstance(s["bottom"], list) else [s["bottom"]] * len(outline)
			for i, ((x0, z0), (x1, z1)) in enumerate(zip(outline, outline[1:] + outline[:1])):
				y0, y1 = bottoms[i], bottoms[(i + 1) % len(outline)]
				length = np.hypot(x1 - x0, z1 - z0)
				for k in range(int(length / 3.0)):
					a = (k + 0.5) / max(1, int(length / 3.0))
					out.append(((x0 + (x1 - x0) * a, y0 + (y1 - y0) * a, z0 + (z1 - z0) * a), 0.8))
		deck = layout["deck"]
		under = deck["height"] - deck.get("thickness", 0.5)
		outline = deck["outline"]
		for (x0, z0), (x1, z1) in zip(outline, outline[1:] + outline[:1]):
			length = np.hypot(x1 - x0, z1 - z0)
			for k in range(int(length / 5.0)):
				a = (k + hashed(int(x0), int(z0), k)) / max(1, int(length / 5.0))
				out.append(((x0 + (x1 - x0) * a, under, z0 + (z1 - z0) * a), 1.0))
	return out


def streaks(p, n, sources, spec, seed, runs=()):
	# Rust and dirty water down the walls below each source: a streak runs down
	# the face the texel lies on, below the source and in front of it, narrow
	# across the face and fading with its length. The sources' streaks are
	# drawn by lot (whether, how long, how wide, rust or dirt); each of `runs`
	# as the photos measure it
	rust = np.zeros(len(p))
	dirt = np.zeros(len(p))
	wall = np.abs(n[:, 1]) < 0.4
	index = np.nonzero(wall)[0]
	if not len(index) or not (sources or runs):
		return rust, dirt
	cell = 1.0
	keys = np.floor(p[index][:, [0, 2]] / cell).astype(np.int64)
	order = np.lexsort((keys[:, 1], keys[:, 0]))
	keys, index = keys[order], index[order]
	flat = keys[:, 0] * 100003 + keys[:, 1]
	t = across(n)
	lo, hi = spec.get("length", [0.4, 3.5])
	drawn = []
	for k, (s, weight) in enumerate(sources):
		if hashed(k, seed, 7) > spec.get("share", 0.75):
			continue   # not every fitting runs
		length = lo + (hi - lo) * hashed(k, seed, 11) ** 2 * weight
		width = 0.05 + 0.15 * hashed(k, seed, 13)   # 5-20 cm across, as the photos' streaks
		drawn.append((k, s, weight, length, width, hashed(k, seed, 17) < spec.get("rust", 0.35)))
	for j, r in enumerate(runs):
		drawn.append((len(sources) + j, r["top"], r.get("weight", 1.0), r["length"], r.get("width", 0.1), r.get("rust", True)))
	for k, s, weight, length, width, rusty in drawn:
		s = np.asarray(s, float)
		reach = 1.0 + width
		cx = np.arange(np.floor((s[0] - reach) / cell), np.floor((s[0] + reach) / cell) + 1).astype(np.int64)
		cz = np.arange(np.floor((s[2] - reach) / cell), np.floor((s[2] + reach) / cell) + 1).astype(np.int64)
		chosen = []
		for a in cx:
			for b in cz:
				key = a * 100003 + b
				i0, i1 = np.searchsorted(flat, key), np.searchsorted(flat, key, side="right")
				if i1 > i0:
					chosen.append(index[i0:i1])
		if not chosen:
			continue
		i = np.concatenate(chosen)
		d = s - p[i]
		below = d[:, 1]
		front = np.einsum("ij,ij->i", d, n[i])
		side = np.einsum("ij,ij->i", d, t[i])
		hit = (below > 0) & (below < length) & (front > -0.15) & (front < 0.9) & (np.abs(side) < width * 1.5)
		if not hit.any():
			continue
		i, below, side = i[hit], below[hit], side[hit]
		fade = (1 - below / length) ** 1.5
		drips = 0.6 + 0.4 * noise(np.stack([side * 0 + k, below / 0.35, side / 0.05], 1), 1.0, seed + 3)
		value = weight * fade * np.exp(-(side / (width / 2)) ** 2) * np.clip(drips, 0, 1)
		if rusty:
			rust[i] = np.maximum(rust[i], value)
		else:
			dirt[i] = np.maximum(dirt[i], value)
	return rust, dirt


def wear_level(p, n, group):
	# Each texel's wear, 0 to 1: the group's level, then each zone over it in
	# turn, a box's edges blended over `soft` metres
	level = np.full(len(p), float(group.get("level", 0.0)))
	for zone in group.get("zones", []):
		member = np.ones(len(p))
		if "box" in zone:
			low, high = np.asarray(zone["box"], float)
			soft = zone.get("soft", 1.0)
			depth = np.minimum(p - low, high - p).min(axis=1)
			t = np.clip(depth / soft + 0.5, 0, 1)
			member *= t * t * (3 - 2 * t)
		# a wall stands within 30 degrees of upright; an underside or a top
		# lies within 30 degrees of level (the flare's slopes neither)
		facing = zone.get("facing")
		if facing == "wall":
			member *= np.abs(n[:, 1]) < 0.5
		elif facing == "under":
			member *= n[:, 1] < -0.85
		elif facing == "up":
			member *= n[:, 1] > 0.85
		level = level * (1 - member) + zone["level"] * member
	return level


def weeps(p, n, level, spec, seed):
	# Rust and dirty water weeping down the walls from seams and fittings too
	# small to model: in columns `spacing` apart along each wall, a run may
	# start in each band `height` tall, by lot as often as the wear says
	rust = np.zeros(len(p))
	dirt = np.zeros(len(p))
	wall = np.abs(n[:, 1]) < 0.5
	i = np.nonzero(wall & (level > 0))[0]
	if not len(i):
		return rust, dirt
	t = across(n[i])
	u = np.einsum("ij,ij->i", p[i], t)
	y = p[i, 1]
	# the face's own key, so walls facing apart get their own runs
	face = np.round(np.arctan2(n[i, 2], n[i, 0]) / 0.35).astype(np.int64)
	spacing, height = spec["spacing"], spec["height"]
	lo, hi = spec["length"]
	w0, w1 = spec["width"]
	column = np.floor(u / spacing).astype(np.int64)
	band = np.floor(y / height).astype(np.int64)
	for c in (column - 1, column, column + 1):
		for b in range(0, int(np.ceil(hi / height)) + 1):
			j = band + b
			k = np.nonzero(hashed(c, j, face, seed + 90) < spec["share"] * level[i])[0]
			if not len(k):
				continue
			key = (c[k], j[k], face[k])
			top = (j[k] + 1) * height - hashed(*key, seed + 91) * height
			length = lo + (hi - lo) * hashed(*key, seed + 92) ** 2
			centre = (c[k] + 0.15 + 0.7 * hashed(*key, seed + 93)) * spacing
			width = w0 + (w1 - w0) * hashed(*key, seed + 94)
			below = top - y[k]
			on = (below > 0) & (below < length) & (np.abs(u[k] - centre) < width * 1.5)
			if not on.any():
				continue
			k, below, length, centre, width = k[on], below[on], length[on], centre[on], width[on]
			rusty = hashed(c[k], j[k], face[k], seed + 96) < spec["rust"]
			fade = (1 - below / length) ** 1.5
			drips = 0.6 + 0.4 * noise(np.stack([c[k] * 1.0, below / 0.35, (u[k] - centre) / 0.05], 1), 1.0, seed + 95)
			value = fade * np.exp(-((u[k] - centre) / (width / 2)) ** 2) * np.clip(drips, 0, 1)
			rust[i[k[rusty]]] = np.maximum(rust[i[k[rusty]]], value[rusty])
			dirt[i[k[~rusty]]] = np.maximum(dirt[i[k[~rusty]]], value[~rusty])
	return rust, dirt


def weather(maps, group, facts, chunk=1 << 20):
	# The colour map (linear RGB) and the height map ([0, 1], 0.5 level) of one
	# atlas, a chunk of its texels at a time; texels outside it the plain grey
	spec = facts["layout"]["weathering"]
	valid = np.asarray(maps["valid"])
	shape = valid.shape
	grey = np.array(group.get("grey", spec.get("grey", [0.30, 0.32, 0.33])), np.float32)
	out_colour = np.empty(shape + (3,), np.float32)
	out_colour[:] = grey
	out_height = np.full(shape, 0.5, np.float32)
	position = np.asarray(maps["position"]).reshape(-1, 3)
	normal = np.asarray(maps["normal"]).reshape(-1, 3)
	ao = np.asarray(maps["ao"]).reshape(-1)
	sources = fittings(facts, group["material"])
	where = np.flatnonzero(valid)
	for start in range(0, len(where), chunk):
		i = where[start : start + chunk]
		colour, height = texels(position[i], normal[i], ao[i], float(maps["texel"]), group, facts, sources)
		out_colour.reshape(-1, 3)[i] = colour
		out_height.reshape(-1)[i] = height
	return out_colour, out_height


def texels(position, normal, ao, texel, group, facts, sources):
	# The colour (linear RGB) and height of texels at `position`, facing
	# `normal`, with occlusion `ao`
	spec = facts["layout"]["weathering"]
	p = position.astype(np.float64)
	n = normal.astype(np.float64)
	n /= np.maximum(np.linalg.norm(n, axis=1), 1e-9)[:, None]
	occlusion = ao.astype(np.float64)
	seed = int(hashed(*[ord(c) for c in group["material"]]) * 1e6)
	row, column, lines, u, v = plates(p, n, group["plates"], texel)
	facing = np.where(n[:, 1] > 0.7, 1, np.where(n[:, 1] < -0.7, 2, 0))
	grey = np.array(group.get("grey", spec.get("grey", [0.30, 0.32, 0.33])))
	tone = 1 + 0.03 * (hashed(row, column, facing, seed) * 2 - 1)
	# touch-ups: a patch of fresher paint in some cells of a coarser grid
	cell = 1.3
	cu, cv = np.floor(u / cell).astype(np.int64), np.floor(v / cell).astype(np.int64)
	pick = hashed(cu, cv, facing, seed + 1)
	fu, fv = u / cell - cu, v / cell - cv
	left, right = 0.1 + 0.3 * hashed(cu, cv, seed + 2), 0.6 + 0.35 * hashed(cu, cv, seed + 3)
	bottom, top = 0.1 + 0.3 * hashed(cu, cv, seed + 4), 0.6 + 0.35 * hashed(cu, cv, seed + 5)
	patch = (pick < group.get("touchups", 0.07)) & (fu > left) & (fu < right) & (fv > bottom) & (fv < top)
	tone = np.where(patch, tone * (1 + 0.05 * (hashed(cu, cv, seed + 6) * 2 - 0.6)), tone)
	tone *= 1 + 0.02 * noise(p, 3.0, seed + 7) + 0.012 * noise(p, 0.6, seed + 8)
	base = np.broadcast_to(grey, (len(p), 3)).copy()
	# the decks of their own non-skid (the stern's lower decks), their colour
	# the non-skid's as measured
	decked = np.zeros(len(p), bool)
	dirty = np.ones(len(p))
	for k, d in enumerate(group.get("decks", [])):
		low, high = np.asarray(d["box"], float)
		inside = np.all((p >= low) & (p <= high), axis=1) & (n[:, 1] > 0.9)
		base[inside] = d["colour"]
		decked |= inside
		# its dirt: the non-skid's tone wandering at each scale, and darker
		# patches where trodden-in grime and spills lie
		dirt, q = d.get("dirt", {}), p[inside]
		shade = np.ones(len(q))
		for j, (scale, spread) in enumerate(dirt.get("mottle", [])):
			shade *= np.exp(spread * noise(q, scale, seed + 20 + 7 * k + j) / NOISE)
		patches = dirt.get("patches")
		if patches:
			m = noise(q, patches["scale"], seed + 40 + k) / NOISE
			# the noise's level that share of a deck lies above (its measured quantiles)
			cut = np.interp(patches["share"], [0.04, 0.08, 0.15, 0.25], [1.73, 1.44, 1.09, 0.72])
			shade *= 1 - patches["darkening"] * np.clip((m - cut) / 0.4, 0, 1)
		dirty[inside] = shade
	level = wear_level(p, n, group)
	colour = base * (tone * dirty)[:, None]
	colour *= (1 - 0.06 * lines)[:, None]
	wear = group.get("wear", {})
	# the paint's tone wandering, the more the more worn, each scale's noise
	# stretched up and down the walls as rain and spray lay it
	shade = np.zeros(len(p))
	for j, (scale, spread, *rest) in enumerate(wear.get("blotches", [])):
		stretch = rest[0] if rest else 1.0
		shade += spread * noise(p * [1, 1 / stretch, 1], scale, seed + 60 + j) / NOISE
	colour *= np.exp(level * shade)[:, None]
	# grime in patches, long up and down the walls as the water runs
	patches = wear.get("patches")
	if patches:
		m = noise(p * [1, 1 / patches.get("stretch", 1.0), 1], patches["scale"], seed + 70) / NOISE
		cut = np.interp(patches["share"], [0.04, 0.08, 0.15, 0.25], [1.73, 1.44, 1.09, 0.72])
		amount = level * np.clip((m - cut) / 0.4, 0, 1)
		colour *= 1 - amount[:, None] * (1 - np.array(patches["tint"]))[None, :]
	# the scum line: a band above the boot top, discoloured
	scum = wear.get("scum")
	if scum:
		boot = facts["layout"].get("hull", {}).get("boot", 0.0)
		edge = scum["height"] * (0.7 + 0.3 * noise(p * [0.3, 1, 0.3], 1.5, seed + 75))
		inside = (p[:, 1] > boot) & (p[:, 1] < boot + edge) & (np.abs(n[:, 1]) < 0.7)
		amount = level[inside] * (1 - (p[inside, 1] - boot) / edge[inside]) ** 0.7
		colour[inside] *= 1 - amount[:, None] * (1 - np.array(scum["tint"]))[None, :]
	# dark paint scuffed through to lighter where fenders and tugs bear on it,
	# the scuffs long fore and aft
	scuffs = wear.get("scuffs")
	if scuffs:
		m = noise(p * [0.4, 1.5, 0.4], scuffs["scale"], seed + 80) / NOISE
		cut = np.interp(scuffs["share"], [0.04, 0.08, 0.15, 0.25], [1.73, 1.44, 1.09, 0.72])
		amount = level * np.clip((m - cut) / 0.4, 0, 1)
		colour += amount[:, None] * np.array(scuffs["lift"])[None, :]
	# walking surfaces: the non-skid's darker grey
	walk = (n[:, 1] > 0.9) & group.get("walk", True) & ~decked
	colour[walk] *= 0.78 + 0.04 * noise(p[walk], 0.25, seed + 9)[:, None]
	# grime toward the deck (the island) or the waterline (the hull)
	deck = facts["layout"]["deck"]["height"]
	base = deck if group["material"] == "island" else facts["layout"].get("hull", {}).get("boot", 1.0)
	rise = np.clip(1 - (p[:, 1] - base) / 2.5, 0, 1) * (np.abs(n[:, 1]) < 0.7)
	colour *= (1 - 0.10 * rise * (0.6 + 0.4 * noise(p * [1, 0.2, 1], 0.4, seed + 10)))[:, None]
	# streaks
	rust, dirt = streaks(p, n, sources, group.get("streaks", {}), seed, group.get("runs", []))
	if wear.get("weeps"):
		r, d = weeps(p, n, level, wear["weeps"], seed)
		rust, dirt = np.maximum(rust, r), np.maximum(dirt, d)
	# each face's streaks as heavy as its photos'
	for region in group.get("regions", []):
		low, high = np.asarray(region["box"], float)
		inside = np.all((p >= low) & (p <= high), axis=1)
		rust[inside] = np.clip(rust[inside] * region["streaks"], 0, 1)
		dirt[inside] = np.clip(dirt[inside] * region["streaks"], 0, 1)
	rusty = np.array(spec.get("rust", [0.22, 0.07, 0.025]))
	dirty = np.array(spec.get("dirt", [0.11, 0.11, 0.10]))
	strength = group.get("streaks", {}).get("strength", 0.45)
	colour = colour * (1 - strength * rust)[:, None] + rusty[None, :] * (strength * rust)[:, None]
	colour = colour * (1 - 0.6 * strength * dirt)[:, None] + dirty[None, :] * (0.6 * strength * dirt)[:, None]
	# the occlusion
	colour *= (0.3 + 0.7 * occlusion)[:, None]
	# the height map: seams as grooves, the plates dished between their frames
	frames = group.get("frames", 0.7)
	dish = 0.5 - 0.5 * np.cos(2 * np.pi * ((u / frames) % 1.0))
	height = 0.5 - 0.35 * lines - 0.06 * dish * (np.abs(n[:, 1]) < 0.7) + 0.02 * noise(p, 0.15, seed + 12)
	# the decks' non-skid grain in the relief
	for k, d in enumerate(group.get("decks", [])):
		grain = d.get("dirt", {}).get("grain", 0.0)
		if grain:
			low, high = np.asarray(d["box"], float)
			inside = np.all((p >= low) & (p <= high), axis=1) & (n[:, 1] > 0.9)
			height[inside] += grain * noise(p[inside], 0.06, seed + 50 + k) / NOISE
	return np.clip(colour, 0, 1), np.clip(height, 0, 1)


def srgb(c):
	return np.where(c <= 0.0031308, 12.92 * c, 1.055 * np.power(np.clip(c, 0, 1), 1 / 2.4) - 0.055)


def main():
	args = sys.argv[1:]
	facts = HERE / "facts.json"
	if "--facts" in args:
		i = args.index("--facts")
		facts = Path(args[i + 1])
		del args[i : i + 2]
	facts = json.loads(facts.read_text())
	maps = np.load(args[0])
	group = next(g for g in facts["layout"]["weathering"]["groups"] if g["material"] == args[1])
	colour, height = weather(maps, group, facts)
	Image.fromarray((srgb(colour) * 255 + 0.5).astype(np.uint8)).save(args[2])
	Image.fromarray((height * 65535 + 0.5).astype(np.uint16)).save(args[3])


if __name__ == "__main__":
	main()
