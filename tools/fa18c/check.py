# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# The facts check (air-fa18c.md, Verification; verify/README.md step 2):
# measures the built model back against every entry in facts.json, posed where
# the fact needs it (gear down for heights, wings folded for the folded span),
# and fails any measurement outside its tolerance. The build reads these facts,
# but its lofts, blends and fractions can still land somewhere else; this is
# what catches it. Every facts.json entry is either measured here or listed in
# EXEMPT with the reason (not geometry, or not built yet), so a new fact cannot
# go unchecked.
#
# usage: python3 -I check.py MODEL.glb MODEL.json [--json]
import json, math, sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "verify"))   # run with -I, which leaves the script's own folder off the path
import model as verify  # noqa: E402

FACTS = json.loads((HERE / "facts.json").read_text())
FRAME = verify.Frame({"names": ["station", "waterline", "buttline"], "unit": 0.0254, "origin": [456, 105, 0],
	"axes": [[-1, 0, 0], [0, 1, 0], [0, 0, 1]], "mirror": "buttline"})
WING = ["wing_inner_{s}", "wing_outer_{s}", "flap_leading_inner_{s}", "flap_leading_outer_{s}", "flap_trailing_{s}", "aileron_{s}"]

# Entries the check does not measure, and why
PAINTED = {"layout.stencils"}   # facts only the paint's atlas shows

EXEMPT = {
	"overall.span.missiles": "needs the wingtip launchers and missiles (step 5, stores)",
	"nose.junction": "the radome's joint is a paint line, not a shape",
	"fittings.probe": "the research jet's probe doors (FS 128.5 to 188); the reference airframe's door is shorter (layout.probe, checked there)",
	"lex.hardware": "the fleet fence's lengths (top 27.9 in) disagree with tp3111's model fence (22.58 in); the photos' top corners (layout.lex) stand 23.8 in apart, so the build follows tp3111 and the photos",
	"model.scale": "the wind-tunnel model's scale, not a dimension",
	"reference.gravity": "a moment reference, not a shape",
	"reference.station": "a moment reference; checked through reference.leading and reference.chord",
	"surfaces.lef.ground": "a flap schedule the engine applies",
	"surfaces.lef.fixed": "a flap schedule the engine applies",
	"surfaces.lef.check": "a flap schedule the engine applies",
	"surfaces.lef.differential": "a flap schedule the engine applies",
	"surfaces.tef.half": "a flap schedule the engine applies",
	"surfaces.tef.full": "a flap schedule the engine applies",
	"surfaces.droop.half": "a flap schedule the engine applies",
	"surfaces.droop.full": "a flap schedule the engine applies",
	"surfaces.trim": "a trim setting the engine applies",
	"surfaces.limits": "motion limits stay in code (Contract)",
	"datum.waterline": "the frame's definition",
	"datum.buttline": "the frame's definition",
	"datum.apex": "the frame's definition; checked through nose.apex",
	"wing.aspect": "checked through wing.root, wing.tip and the span",
	"wing.taper": "checked through wing.root and wing.tip",
	"wing.incidence": "no twist is published; checked as a flat chord plane through layout.wing's anhedral",
	"wing.dihedral": "cr201687's -3 deg: the photos put the tips about 5 in higher, so the build takes layout.wing's anhedral, checked there",
	"wing.chord": "checked through reference.chord",
	"engine.thrust": "where the flight model applies thrust, not a shape",
	"canopy": "the two-seat canopy's differences; this is the single-seat jet",
	"gravity@HARV phase 1, 60% fuel, clean, gear up": "a centre of gravity, not a shape",
	"gravity@HARV phases 2-3, 60% fuel, clean, gear up": "a centre of gravity, not a shape",
	"gravity@HARV simulation": "a centre of gravity, not a shape",
	"gravity@F-18B SRA, 66% fuel, clean, gear up": "a centre of gravity, not a shape",
	"layout.eye": "the design eye is a point the build writes as given",
	"layout.hardpoints": "store mounts the build writes as given, the fuselage ones draped onto the skin (shape.mount); step 5 checks them against the stores",
	"layout.paint": "colours the paint bake writes into the atlas, not a shape (looked at on the comparison sheets)",
}


def value(entry):
	return entry["value"] if isinstance(entry, dict) and "value" in entry else entry


def entries(facts):
	# Every entry a check must account for: dicts that cite a source, list
	# items that do, and layout's placements
	out = []

	def walk(o, path):
		if isinstance(o, dict):
			if "source" in o or (path.startswith("layout.") and path.count(".") == 1):
				out.append(path)
				return
			for k, v in o.items():
				if k not in ("about", "note", "where", "also", "unit"):
					walk(v, f"{path}.{k}" if path else k)
		elif isinstance(o, list):
			for item in o:
				if isinstance(item, dict) and "source" in item:
					out.append(f"{path}@{item.get('aircraft', item.get('station'))}")

	walk(facts, "")
	return out


def leading_sweep(quarter, aspect, taper):
	return math.degrees(math.atan(math.tan(math.radians(quarter)) + (4 / aspect) * 0.25 * (1 - taper) / (1 + taper)))


class Jet:
	def __init__(self, glb, points):
		self.path = glb
		self.model = verify.Model(glb)
		self.document = json.loads(Path(points).read_text())
		self.joints = self.document["joints"]
		self.cache = {}

	def parts(self, drives=None):
		key = tuple(sorted((drives or {}).items()))
		if key not in self.cache:
			self.cache[key] = self.model.parts(verify.pose(self.joints, drives or {}))
		return self.cache[key]

	def has(self, *names):
		return all(n in self.parts() for n in names)

	def tris(self, names, drives=None):
		parts = self.parts(drives)
		chosen = [parts[n] for n in names if n in parts]
		if not names:
			raise KeyError("not built: no parts asked for")
		if len(chosen) != len(names):
			raise KeyError(f"not built: {sorted(set(names) - set(parts))}")
		return np.concatenate(chosen)

	def textured(self, materials=("paint", "team")):
		# The painted triangles at rest, in stations, waterlines and buttlines,
		# with their corners' UVs: (triangles (N, 3, 3), UVs (N, 3, 2))
		worlds = self.model.worlds({})
		tris, uvs = [], []
		for i, n in enumerate(self.model.nodes):
			if n["mesh"] is None or i not in worlds:
				continue
			W = worlds[i]
			for (t, material), uv in zip(self.model.meshes[n["mesh"]], self.model.uvs[n["mesh"]]):
				if uv is not None and material in materials:
					tris.append(FRAME.source((t @ W[:3, :3].T + W[:3, 3]).reshape(-1, 3)).reshape(-1, 3, 3))
					uvs.append(uv)
		if not tris:
			raise KeyError("no painted triangles with UVs")
		return np.concatenate(tris), np.concatenate(uvs)

	def points(self, names, drives=None):
		# every corner, in stations, waterlines and buttlines
		return FRAME.source(self.tris(names, drives).reshape(-1, 3))

	def cut(self, names, point, normal, drives=None):
		# a plane given in source coordinates (point, normal), crossing points in source coordinates
		segments = verify.cut(self.tris(names, drives), FRAME.model(point), FRAME.axes @ np.asarray(normal, float))
		return FRAME.source(segments.reshape(-1, 3))

	def hinge(self, name):
		i = self.model.index[name]
		return FRAME.source(self.model.rest[i][:3, 3])


def loops(segments, tolerance=1e-6):
	# Chains a cut's segments (M, 2, D) into closed loops
	segments = [tuple(map(tuple, s)) for s in segments]
	ends = {}
	for k, (a, b) in enumerate(segments):
		for p in (a, b):
			ends.setdefault(tuple(np.round(p, 5)), []).append(k)
	used, out = set(), []
	for start in range(len(segments)):
		if start in used:
			continue
		used.add(start)
		loop = [segments[start][0], segments[start][1]]
		while True:
			key = tuple(np.round(loop[-1], 5))
			nxt = next((k for k in ends.get(key, []) if k not in used), None)
			if nxt is None:
				break
			used.add(nxt)
			a, b = segments[nxt]
			loop.append(b if tuple(np.round(a, 5)) == key else a)
		out.append(np.array(loop))
	return out


def heights(tris, stations, buttlines, tilt=False):
	# A top-down height map: the highest waterline of the triangles (source
	# coordinates, (N, 3, 3)) over each (buttline, station) cell, NaN where
	# none. With tilt, also each cell's cosine of the slope of the triangle
	# that gives its height
	H = np.full((len(buttlines), len(stations)), np.nan)
	C = np.full_like(H, np.nan)
	s0, b0 = stations[0], buttlines[0]
	ds, db = stations[1] - stations[0], buttlines[1] - buttlines[0]
	keep = (tris[..., 0].max(1) >= stations[0]) & (tris[..., 0].min(1) <= stations[-1]) & (tris[..., 2].max(1) >= buttlines[0]) & (tris[..., 2].min(1) <= buttlines[-1])
	for t in tris[keep]:
		a, b, c = t[:, [0, 2]]
		i0 = max(int(np.floor((min(a[0], b[0], c[0]) - s0) / ds)), 0)
		i1 = min(int(np.ceil((max(a[0], b[0], c[0]) - s0) / ds)), len(stations) - 1)
		j0 = max(int(np.floor((min(a[1], b[1], c[1]) - b0) / db)), 0)
		j1 = min(int(np.ceil((max(a[1], b[1], c[1]) - b0) / db)), len(buttlines) - 1)
		if i1 < i0 or j1 < j0:
			continue
		gx, gy = np.meshgrid(stations[i0 : i1 + 1], buttlines[j0 : j1 + 1])
		v0, v1 = b - a, c - a
		d = v0[0] * v1[1] - v0[1] * v1[0]
		if abs(d) < 1e-12:
			continue
		px, py = gx - a[0], gy - a[1]
		u = (px * v1[1] - py * v1[0]) / d
		v = (v0[0] * py - v0[1] * px) / d
		inside = (u >= -1e-9) & (v >= -1e-9) & (u + v <= 1 + 1e-9)
		h = t[0, 1] + u * (t[1, 1] - t[0, 1]) + v * (t[2, 1] - t[0, 1])
		sub = H[j0 : j1 + 1, i0 : i1 + 1]
		take = inside & ~(sub >= h)
		H[j0 : j1 + 1, i0 : i1 + 1] = np.where(take, h, sub)
		if tilt:
			n = np.cross(t[1] - t[0], t[2] - t[0])
			C[j0 : j1 + 1, i0 : i1 + 1] = np.where(take, abs(n[1]) / np.linalg.norm(n), C[j0 : j1 + 1, i0 : i1 + 1])
	return (H, C) if tilt else H


def shoelace(loop):
	# a closed 2D loop's area
	x, y = loop[:, 0], loop[:, 1]
	return abs((x[:-1] * y[1:] - x[1:] * y[:-1]).sum()) / 2


# The airframe's closed shells, the parts that must lie inside them at rest
# (stowed, or under the canopy), and the panels that lie flush on the skin
# with the side they face
HULL = ["fuselage", "lex_left", "lex_right", "inlet_left", "inlet_right", "wing_inner_left", "wing_inner_right", "canopy", "windscreen",
	"fin_left", "fin_right"]
STOWED = [f"gear_{leg}_{piece}" for leg in ("left", "right", "nose") for piece in ("strut", "oleo", "wheel")] + [
	"launch_bar", "gear_nose_lamps", "lamp_gear_nose", "ladder", "probe", "cockpit_tub", "cockpit_panel", "cockpit_seat", "cockpit_stick", "cockpit_hud", "pilot"]
FLUSH = [("speedbrake", False), ("gear_nose_door_left", True), ("gear_nose_door_right", True), ("gear_nose_door_long", True), ("gear_nose_door_aft", True),
	("gear_door_inner_left", True), ("gear_door_inner_right", True), ("gear_door_outer_left", True), ("gear_door_outer_right", True), ("probe_door", False)]
# The parts with no twin that stand to one side; every other one is
# symmetric about the centreline
ONE_SIDED = {"antenna_dome", "antenna_ventral", "gear_nose_door_aft", "gear_nose_door_long", "gear_nose_lamps", "lamp_gear_nose", "lamp_position_tail", "ladder", "pilot", "probe", "probe_door"}


def enclosed(points, tris):
	# Whether each point (N, 3) is enclosed by the triangles (M, 3, 3): a ray
	# along each axis, both ways, meets one of them
	out = np.ones(len(points), bool)
	lo, hi = tris.min(1), tris.max(1)
	for axis in range(3):
		u, v = [i for i in range(3) if i != axis]
		# the triangles that can lie across this part's rays at all
		box = (lo[:, u] <= points[:, u].max()) & (hi[:, u] >= points[:, u].min()) & (lo[:, v] <= points[:, v].max()) & (hi[:, v] >= points[:, v].min())
		t, tl, th = tris[box], lo[box], hi[box]
		a, b, c = t[:, 0], t[:, 1], t[:, 2]
		d = (b[:, u] - a[:, u]) * (c[:, v] - a[:, v]) - (c[:, u] - a[:, u]) * (b[:, v] - a[:, v])
		flat = np.abs(d) < 1e-12
		d = np.where(flat, 1, d)
		for k, p in enumerate(points):
			if not out[k]:
				continue
			near = ~flat & (tl[:, u] <= p[u]) & (th[:, u] >= p[u]) & (tl[:, v] <= p[v]) & (th[:, v] >= p[v])
			if not near.any():
				out[k] = False
				continue
			an, bn, cn, dn = a[near], b[near], c[near], d[near]
			s = ((p[u] - an[:, u]) * (cn[:, v] - an[:, v]) - (cn[:, u] - an[:, u]) * (p[v] - an[:, v])) / dn
			r = ((bn[:, u] - an[:, u]) * (p[v] - an[:, v]) - (p[u] - an[:, u]) * (bn[:, v] - an[:, v])) / dn
			inside = (s >= 0) & (r >= 0) & (s + r <= 1)
			depth = an[:, axis] + s * (bn[:, axis] - an[:, axis]) + r * (cn[:, axis] - an[:, axis]) - p[axis]
			out[k] = (inside & (depth > 0)).any() and (inside & (depth < 0)).any()
	return out


def standoff(panel, skin, below=False, step=0.5):
	# How far a panel's outer face (triangles, source coordinates) stands off
	# the skin, along the skin's normal, on a grid over the panel at least
	# half an inch in from its outline, looking down on it (or up from below):
	# the gap straight down, times the cosine of the slope of the skin's own
	# facet beneath (a slope read across the height map's cells mixes the
	# facets either side of a crease)
	flip = -1.0 if below else 1.0
	fs, bl = panel[..., 0], panel[..., 2]
	stations = np.arange(fs.min(), fs.max() + 1e-9, step)
	buttlines = np.arange(bl.min(), bl.max() + 1e-9, step)

	def outermost(tris, tilt=False):
		t = tris.copy()
		t[..., 1] *= flip
		if tilt:
			h, cosine = heights(t, stations, buttlines, tilt=True)
			return h * flip, cosine
		return heights(t, stations, buttlines) * flip

	outer, (under, cosine) = outermost(panel), outermost(skin, tilt=True)
	# the panel's cover less a cell's margin all round
	cover = np.isfinite(outer)
	inner = cover.copy()
	inner[1:] &= cover[:-1]
	inner[:-1] &= cover[1:]
	inner[:, 1:] &= cover[:, :-1]
	inner[:, :-1] &= cover[:, 1:]
	inner[[0, -1], :] = inner[:, [0, -1]] = False
	s = flip * (outer - under) * cosine
	return s[inner & np.isfinite(s)]


# The parts that lie against each other's skin, each pair seen from above,
# below and outboard: where two lie within half an inch of each other, one
# stays on top
SEAMS = [("inlet", "fuselage"), ("lex", "fuselage"), ("lex", "inlet"), ("lex", "wing_inner"), ("wing_inner", "fuselage"), ("flap_leading_inner", "lex")]


def seam(a, b, every, view, step=0.5, near=0.5):
	# The area (square inches) where two parts (triangles, source coordinates)
	# lying within `near` of each other cross back and forth, seen from a view
	# ("above", "below", "outboard" on the right): over their overlap, where
	# either is the outermost of `every` part, two cells in from its edge
	# (where they meet or cross along a line), the cells in which the one
	# mostly beneath stands on top. A near-level crossing shows as a ragged
	# line; one hidden beneath another part, or one crossing steeply, does not
	axes = [0, 2, 1] if view == "outboard" else [0, 1, 2]
	flip = -1.0 if view == "below" else 1.0

	def seen(tris):
		t = tris[..., axes].copy()
		t[..., 1] *= flip
		return t

	a, b, every = seen(a), seen(b), seen(every)
	lo = np.maximum(a.reshape(-1, 3).min(0), b.reshape(-1, 3).min(0))
	hi = np.minimum(a.reshape(-1, 3).max(0), b.reshape(-1, 3).max(0))
	if (hi[[0, 2]] - lo[[0, 2]] < 2 * step).any():
		return 0.0
	stations, across = np.arange(lo[0], hi[0], step), np.arange(lo[2], hi[2], step)
	ha, hb, top = heights(a, stations, across), heights(b, stations, across), heights(every, stations, across)
	d = ha - hb
	zone = np.isfinite(d) & (np.abs(d) < near) & (np.fmax(ha, hb) >= top - 1e-6)
	inner = zone.copy()
	for _ in range(2):
		z = inner.copy()
		inner[1:] &= z[:-1]
		inner[:-1] &= z[1:]
		inner[:, 1:] &= z[:, :-1]
		inner[:, :-1] &= z[:, 1:]
	return float(min((inner & (d > 0)).sum(), (inner & (d < 0)).sum()) * step * step)


def segment_distance(point, segments):
	# A point's (2) distance to the nearest of segments (N, 2, 2)
	a, b = segments[:, 0], segments[:, 1]
	e = b - a
	t = np.clip(((point - a) * e).sum(1) / np.maximum((e * e).sum(1), 1e-12), 0, 1)
	return float(np.linalg.norm(a + t[:, None] * e - point, axis=1).min())


def inside_polygon(point, polygon):
	# Whether a point (2) lies inside a closed polygon (N, 2), by crossings
	x, y = point
	a, b = polygon, np.roll(polygon, -1, axis=0)
	cross = (a[:, 1] > y) != (b[:, 1] > y)
	at = a[:, 0] + (y - a[:, 1]) * (b[:, 0] - a[:, 0]) / np.where(b[:, 1] != a[:, 1], b[:, 1] - a[:, 1], 1)
	return bool(np.count_nonzero(cross & (at > x)) % 2)


def inside_segments(point, segments):
	# Whether a point (2) lies inside a closed outline given as segments (N, 2,
	# 2) in any order, by crossings
	x, y = point
	a, b = segments[:, 0], segments[:, 1]
	cross = (a[:, 1] > y) != (b[:, 1] > y)
	at = a[:, 0] + (y - a[:, 1]) * (b[:, 0] - a[:, 0]) / np.where(b[:, 1] != a[:, 1], b[:, 1] - a[:, 1], 1)
	return bool(np.count_nonzero(cross & (at > x)) % 2)


def lines(tris, view, stations, across):
	# The skin's fixed lines seen from a view ("above" and "below": waterline at
	# fixed buttlines; "outboard" on the right: buttline at fixed waterlines),
	# as heights over (across, stations), NaN off the skin
	axes = [0, 2, 1] if view == "outboard" else [0, 1, 2]
	flip = -1.0 if view == "below" else 1.0
	t = tris[..., axes].copy()
	t[..., 1] *= flip
	return heights(t, stations, across) * flip


def bends(H, step, free, jump=0.6):
	# Each line's bend (degrees) at each station, the stations an inch apart:
	# over 4 in either side, and the same again where more than 60% of it lies
	# within 2 in (a crease; else 0: a smooth curve keeps only half its bend in
	# the inner window). Lines are averaged over 3 in first, against the
	# loft's facets, so a sharp kink reads at about five-sixths of its angle;
	# a station counts only where its window is whole and free (one mask, or
	# one per line)
	# of the skin's edges (free), on a face within 35 deg of the view (the
	# surface across the line no steeper than 0.7, step apart) and on one
	# surface (no step over jump inches; None where no step is an edge, so a
	# cliff reads as the bend it is). Returns [(line, station's index, bend, crease)]
	slope = np.abs(np.gradient(H, step, axis=0))
	out = []
	for j in range(1, len(H) - 1):
		raw = H[j]
		h = np.convolve(np.pad(raw, 1, mode="edge"), np.ones(3) / 3, mode="valid")
		for i in range(7, len(raw) - 7):
			w = slice(i - 7, i + 8)
			if not (free[j] if free.ndim == 2 else free)[w].all() or not np.isfinite(H[j - 1:j + 2, w]).all() or (slope[j, w] > 0.7).any() or (jump is not None and (np.abs(np.diff(raw[w])) > jump).any()):
				continue

			def bend(b):
				return math.degrees(math.atan((h[i + b] - h[i]) / b) - math.atan((h[i] - h[i - b]) / b))

			wide, narrow = bend(4), bend(2)
			out.append((j, i, wide, wide if abs(narrow) > 0.6 * abs(wide) else 0.0))
	return out


def turns(h, noise=0.05):
	# A line's turns, as (index, +1 for a hump or -1 for a dip), each standing
	# noise above or below the run either side of it, alternating
	out, kind, best = [], 0, 0
	for i in range(1, len(h)):
		if kind == 0:
			if abs(h[i] - h[0]) > noise:
				kind = 1 if h[i] > h[0] else -1
				best = int(np.argmax(h[:i + 1]) if kind == 1 else np.argmin(h[:i + 1]))
		elif kind * (h[i] - h[best]) > 0:
			best = i
		elif kind * (h[best] - h[i]) > noise:
			out.append((best, kind))
			kind, best = -kind, i
	return out


def seated(part, skin, stations):
	# How far a thin part standing on the skin (a fin; triangles, source
	# coordinates) stands off it at its foot, the furthest over the stations:
	# at each, on each side of the part's own mid-plane (through its middle,
	# square to its thinnest direction), the section's corners lowest along the
	# part's span (within a tenth of an inch), each against the skin's top at
	# its buttline. 0 or less where every foot lies on or in the skin, NaN
	# where no station cuts the part. Lowest by waterline instead, a face
	# slanting down into the skin was judged halfway up, and a face meeting
	# another part (a fin's root on a fairing under it) was judged at the
	# closing face between them
	points = part.reshape(-1, 3)
	centre = points.mean(0)
	normal = np.linalg.svd(points - centre, full_matrices=False)[2][-1]
	span = np.cross(normal, [1.0, 0.0, 0.0])
	span = span / np.linalg.norm(span) * (1.0 if span[1] >= 0 else -1.0)
	worst = np.nan
	for station in stations:
		ends = verify.cut(part, [station, 0.0, 0.0], [1.0, 0.0, 0.0]).reshape(-1, 3)
		if not len(ends):
			continue
		offsets, along = (ends - centre) @ normal, ends @ span
		for sign in (1.0, -1.0):
			on = sign * offsets >= 0
			if not on.any():
				continue
			for foot in ends[on & (along <= along[on].min() + 0.1)]:
				top = heights(skin, np.array([station - 0.01, station, station + 0.01]), np.array([foot[2], foot[2] + 0.01]))[0][1]
				worst = foot[1] - top if np.isnan(worst) else max(worst, foot[1] - top)
	return worst


def waves(H, stations, free, span=40.0, jump=0.6, step=None):
	# Each line's waves: a dip between two humps, or a hump between two dips,
	# the three turns within 2 * span inches, over a run of stations free of
	# the skin's edges (free: one mask, or one per line), on the skin
	# throughout and on one surface (no step over jump inches between
	# neighbours: where a line leaves one surface for another). With step (the
	# lines' spacing), only on a face within 35 deg of the view (the surface
	# across the line no steeper than 0.7), as bends() reads it: on a steeper
	# face a sideways wiggle of hundredths shows as tenths, and the view across
	# it measures it squarely. Lines are averaged over 3 stations first, against
	# the loft's facets. Returns [(line, station, +1 hump or -1 dip, its height
	# above or depth below the lower or higher of the turns either side)]
	out = []
	slope = np.abs(np.gradient(H, step, axis=0)) if step is not None and len(H) > 1 else None
	for j, raw in enumerate(H):
		ok = np.isfinite(raw) & (free[j] if free.ndim == 2 else free)
		if slope is not None:
			ok &= ~(slope[j] > 0.7)
		step = np.abs(np.diff(np.where(np.isfinite(raw), raw, 0.0))) > jump
		i = 0
		while i < len(raw):
			if not ok[i]:
				i += 1
				continue
			k = i + 1
			while k < len(raw) and ok[k] and not step[k - 1]:
				k += 1
			h = np.convolve(np.pad(raw[i:k], 1, mode="edge"), np.ones(3) / 3, mode="valid")
			found = [(a, s) for a, s in turns(h) if 0 < a < len(h) - 1]
			for (a, _), (b, s), (c, _) in zip(found, found[1:], found[2:]):
				if stations[i + c] - stations[i + a] <= 2 * span:
					out.append((j, float(stations[i + b]), s, float(min(abs(h[b] - h[a]), abs(h[b] - h[c])))))
			i = k
	return out


def surface_distance(points, tris, chunk=256):
	# Each point's (N, 3) distance to the nearest of the triangles (M, 3, 3):
	# to the plane where the point stands over a triangle, else to its edges
	out = np.full(len(points), np.inf)
	a, b, c = tris[:, 0], tris[:, 1], tris[:, 2]
	n = np.cross(b - a, c - a)
	size = np.linalg.norm(n, axis=1)
	keep = size > 1e-12
	if not keep.any():
		return out
	a, b, c, n = a[keep], b[keep], c[keep], n[keep] / size[keep, None]
	v0, v1 = b - a, c - a
	d00, d01, d11 = (v0 * v0).sum(1), (v0 * v1).sum(1), (v1 * v1).sum(1)
	den = d00 * d11 - d01 * d01

	def edge(p, s0, s1):
		e = s1 - s0
		t = np.clip(((p[:, None] - s0[None]) * e[None]).sum(-1) / np.maximum((e * e).sum(1), 1e-12)[None], 0, 1)
		return np.linalg.norm(s0[None] + t[..., None] * e[None] - p[:, None], axis=-1)

	for i in range(0, len(points), chunk):
		p = points[i:i + chunk]
		w = p[:, None] - a[None]
		h = (w * n[None]).sum(-1)
		q = w - h[..., None] * n[None]
		d20, d21 = (q * v0[None]).sum(-1), (q * v1[None]).sum(-1)
		u, v = (d11 * d20 - d01 * d21) / den, (d00 * d21 - d01 * d20) / den
		over = (u >= 0) & (v >= 0) & (u + v <= 1)
		rim = np.minimum(np.minimum(edge(p, a, b), edge(p, b, c)), edge(p, c, a))
		out[i:i + chunk] = np.where(over, np.abs(h), rim).min(1)
	return out


def first_hit(tris, origin, direction):
	# The distance along a ray to the nearest triangle it meets (model units), or None
	v0, v1, v2 = tris[:, 0], tris[:, 1], tris[:, 2]
	e1, e2 = v1 - v0, v2 - v0
	p = np.cross(direction, e2)
	det = (e1 * p).sum(1)
	ok = np.abs(det) > 1e-12
	inv = np.where(ok, 1 / np.where(ok, det, 1), 0)
	s = origin - v0
	u = (s * p).sum(1) * inv
	q = np.cross(s, e1)
	v = (direction * q).sum(1) * inv
	d = (e2 * q).sum(1) * inv
	met = ok & (u >= 0) & (v >= 0) & (u + v <= 1) & (d > 1e-9)
	return float(d[met].min()) if met.any() else None


def hits(tris, origins, direction):
	# Where rays from each origin (N, 3) along one direction first meet the
	# triangles: (triangle index, barycentric (u, v)) per ray, index -1 for a miss
	v0, e1, e2 = tris[:, 0], tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0]
	p = np.cross(direction, e2)
	det = (e1 * p).sum(1)
	ok = np.abs(det) > 1e-12
	inv = np.where(ok, 1 / np.where(ok, det, 1), 0)
	q = np.cross(e1, direction)
	out, bary = np.full(len(origins), -1), np.zeros((len(origins), 2))
	for i, o in enumerate(origins):
		s = o - v0
		u = (s * p).sum(1) * inv
		c = np.cross(s, e1)
		v = (direction * c).sum(1) * inv
		d = (e2 * c).sum(1) * inv
		met = ok & (u >= -1e-6) & (v >= -1e-6) & (u + v <= 1 + 1e-6) & (d > 1e-9)
		if met.any():
			k = int(np.argmin(np.where(met, d, np.inf)))
			out[i], bary[i] = k, (u[k], v[k])
	return out, bary


def atlas(path):
	# The paint's atlas a GLB carries, as brightness 0..1 (H, W), or None (a
	# draft, unpainted)
	import io
	from PIL import Image
	data = Path(path).read_bytes()
	length = int.from_bytes(data[12:16], "little")
	gltf = json.loads(data[20:20 + length])
	start = 20 + length
	binary = data[start + 8:]
	materials = {m.get("name"): m for m in gltf.get("materials", [])}
	texture = materials.get("paint", {}).get("pbrMetallicRoughness", {}).get("baseColorTexture")
	if texture is None:
		return None
	image = gltf["images"][gltf["textures"][texture["index"]]["source"]]
	view = gltf["bufferViews"][image["bufferView"]]
	raw = binary[view.get("byteOffset", 0): view.get("byteOffset", 0) + view["byteLength"]]
	return np.asarray(Image.open(io.BytesIO(raw)).convert("L"), float) / 255


def sample(image, uv):
	# The atlas's brightness at UVs (N, 2), read between texels (glTF's v runs down the image)
	h, w = image.shape
	x, y = np.clip(uv[:, 0] * w - 0.5, 0, w - 1), np.clip(uv[:, 1] * h - 0.5, 0, h - 1)
	x0, y0 = np.minimum(x.astype(int), w - 2), np.minimum(y.astype(int), h - 2)
	fx, fy = x - x0, y - y0
	return (image[y0, x0] * (1 - fx) * (1 - fy) + image[y0, x0 + 1] * fx * (1 - fy) + image[y0 + 1, x0] * (1 - fx) * fy + image[y0 + 1, x0 + 1] * fx * fy)


def coverage(uvs, size):
	# How many triangles (N, 3, 2 in UV) hold each texel's centre strictly
	# inside, over a size x size atlas: islands laid over each other count 2
	count = np.zeros((size, size), np.int32)
	p = uvs * size
	lo = np.floor(p.min(1) - 0.5).astype(int)
	span = np.ceil(p.max(1) - 0.5).astype(int) - lo + 1
	cross = lambda a, b: a[..., 0] * b[..., 1] - a[..., 1] * b[..., 0]
	whole = cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0])
	for s in np.unique(span.max(1)):
		pick = np.where((span.max(1) == s) & (np.abs(whole) > 1e-12))[0]
		for chunk in np.array_split(pick, max(1, len(pick) * s * s // 2000000 + 1)):
			grid = np.stack(np.meshgrid(np.arange(s), np.arange(s), indexing="ij"), -1).reshape(-1, 2)
			q = lo[chunk, None, :] + grid[None] + 0.5
			a, b, c = (p[chunk, k, None, :] for k in range(3))
			w0, w1 = cross(b - q, c - q) / whole[chunk, None], cross(c - q, a - q) / whole[chunk, None]
			inside = (w0 > 1e-6) & (w1 > 1e-6) & (1 - w0 - w1 > 1e-6)
			x, y = q[..., 0].astype(int), q[..., 1].astype(int)
			inside &= (x >= 0) & (x < size) & (y >= 0) & (y < size)
			np.add.at(count, (y[inside], x[inside]), 1)
	return count


def mirrored(left, right):
	# How far a left part's bounds (points, source coordinates) miss its right
	# twin's, reflected across the centreline
	right = right * np.array([1.0, 1.0, -1.0])
	return float(max(np.abs(left.min(0) - right.min(0)).max(), np.abs(left.max(0) - right.max(0)).max()))


def result(fact, what, expected, measured, tolerance, unit="in"):
	# One measurement. A measurement of nothing (NaN off the skin) fails: NaN
	# compares false against any tolerance, and would pass
	measured = float(measured)
	return {"fact": fact, "what": what, "expected": round(float(expected), 3), "measured": round(measured, 3) if math.isfinite(measured) else math.inf,
		"tolerance": tolerance, "unit": unit}


def failed(r):
	return "missing" in r or abs(r["measured"] - r["expected"]) > r["tolerance"]


def checks(jet):
	# Yields {"fact", "what", "expected", "measured", "tolerance", "unit"} or {"fact", "what", "missing"}
	F = FACTS

	def guard(fact, what, fn):
		# a group that cannot measure reports it, as a failure, and the rest run
		# on: a fact or part not found (KeyError), or nothing left to measure (a
		# reduction over an empty selection: ValueError, IndexError)
		try:
			return list(fn())
		except KeyError as e:
			return [{"fact": fact, "what": what, "missing": str(e).strip("'\"")}]
		except (ValueError, IndexError) as e:
			return [{"fact": fact, "what": what, "missing": f"nothing to measure ({type(e).__name__}: {e})"}]

	apex = value(F["nose"]["apex"])
	down = {"gear": 1}
	every = list(jet.parts())

	# Overall
	def overall():
		p = jet.points(every)
		# to the foot NATOPS gives it in (facts: overall.length)
		yield result("overall.length", "nose apex to the aftmost point", value(F["overall"]["length"]) * 12, p[:, 0].max() - p[:, 0].min(), 6.0)
		w = jet.points([n.format(s=s) for n in WING for s in ("left", "right")])
		yield result("overall.span.spread", "wingtip to wingtip", value(F["overall"]["span"]["spread"]) * 12, w[:, 2].max() - w[:, 2].min(), 1.0)
		# the folded panels' span, without the fairings under them (layout.wing_fairing),
		# which turn outboard with the panel 4.3 in a side: see facts overall.span.folded
		folded = jet.points([n for n in every if not n.startswith("gear") and not n.startswith("fairing_") and not n.startswith("lamp_position_fold")], {"fold": 1})
		yield result("overall.span.folded", "span with the wings folded, the panels without their underwing fairings", value(F["overall"]["span"]["folded"]) * 12, folded[:, 2].max() - folded[:, 2].min(), 1.5)
		# the outer panel turned as far as the photos fold it (layout.fold): the
		# rigid turn taking its points at rest onto its points folded
		for side in ("left", "right"):
			spread, turned = jet.points([f"wing_outer_{side}"]), jet.points([f"wing_outer_{side}"], {"fold": 1})
			u, _, vt = np.linalg.svd((turned - turned.mean(0)).T @ (spread - spread.mean(0)))
			rotation = u @ vt
			angle = math.degrees(math.acos(max(-1.0, min(1.0, (np.trace(rotation) - 1) / 2))))
			yield result("layout.fold", f"{side} outer wing's fold", F["layout"]["fold"]["angle"], angle, 1.0, "deg")
		# the ground: the plane through the three tyres' lowest points (the jet
		# need not sit level on its gear)
		contacts = []
		for wheel in ("gear_left_wheel", "gear_right_wheel", "gear_nose_wheel"):
			w = jet.points([wheel], down)
			contacts.append(w[np.argmin(w[:, 1])])
		a, b, c = contacts
		normal = np.cross(b - a, c - a)
		normal = normal / np.linalg.norm(normal) * (1 if normal[1] > 0 else -1)
		above = lambda pts: float(((pts - a) @ normal).max())
		yield result("overall.height.fins", "ground to the fin tops, gear down", value(F["overall"]["height"]["fins"]) * 12, above(jet.points(["fin_left", "fin_right"])), 1.5)
		yield result("overall.height.canopy", "ground to the closed canopy's top", value(F["overall"]["height"]["canopy"]) * 12, above(jet.points(["canopy"])), 1.5)
		g = F["layout"]["gear"]
		yield result("layout.gear", "main tyres' contact", g["axles"]["main"] - g["tyres"]["main"]["diameter"] / 2, (a[1] + b[1]) / 2, 0.5, "WL in")
		flaps = sorted(n for n in jet.parts() if "_petal_" in n)
		nozzles = jet.points(flaps)
		yield result("layout.nozzle", "nozzles' exit", F["layout"]["nozzle"]["exit"], nozzles[:, 0].max(), 0.5, "FS in")
		yield result("overall.exhaust", "nose apex to the nozzles' exit", value(F["overall"]["exhaust"]) * 12, nozzles[:, 0].max() - jet.points(["fuselage"])[:, 0].min(), 0.5)
		lip = nozzles[nozzles[:, 0] > nozzles[:, 0].max() - 0.5]
		yield result("layout.nozzle", "nozzle exit's lower lip", F["layout"]["nozzle"]["waterline"] - F["layout"]["nozzle"]["radius"][1], lip[:, 1].min(), 0.5, "WL in")
		# the burner's glowing faces sit inside the nozzles, short of the exit
		burner = jet.points(["burner_left", "burner_right"])
		yield result("layout.nozzle", "burner's faces short of the nozzles' exit", 0.0, max(0.0, burner[:, 0].max() - F["layout"]["nozzle"]["exit"] + 1.0), 0.01, "FS in")
		yield result("layout.nozzle", "burner inside the nozzle's exit", 0.0, max(0.0, F["layout"]["nozzle"]["waterline"] - F["layout"]["nozzle"]["radius"][1] - burner[:, 1].min()), 0.01, "WL in")
		# the outer flaps: twelve a side, closing on the drive to tm100159's exit, the burner as wide as the open throat
		petals = F["layout"]["petals"]
		for side in ("left", "right"):
			yield result("layout.petals", f"{side} nozzle's outer flaps", petals["count"], sum(n.startswith(f"nozzle_{side}_petal_") for n in flaps), 0, "flaps")
		bottom = f"nozzle_right_petal_{petals['count'] // 2 + 1}"
		# closed, the bottom flap's aft end on the vertical through the engine's
		# axis: its divergent flap's face (the gas path's exit) the closed
		# radius from the axis
		p = jet.points([bottom], {"nozzle": 1})
		e = F["engine"]
		axis = value(e["buttline"]) * 12 - (p[:, 0] - value(F["reference"]["station"])) * math.tan(math.radians(value(e["angle"])))
		below = p[(p[:, 0] > p[:, 0].max() - 0.5) & (np.abs(p[:, 2] - axis) <= 0.6)]
		yield result("layout.petals", "closed nozzle's exit radius", petals["closed"], F["layout"]["nozzle"]["waterline"] - below[:, 1].max(), 0.1)
		# open (at rest), on the same vertical: the gas path from the exit in to
		# the throat (the divergent flap) and on to the tailpipe (the convergent
		# flap), their faces' points and the lengths between them
		n = F["layout"]["nozzle"]
		p = jet.points([bottom])
		axis = value(e["buttline"]) * 12 - (p[:, 0] - value(F["reference"]["station"])) * math.tan(math.radians(value(e["angle"])))
		line = p[np.abs(p[:, 2] - axis) <= 0.6]
		radius = n["waterline"] - line[:, 1]
		inside = line[radius < n["radius"][1] - 1.0]
		gas = n["waterline"] - inside[:, 1]
		throat = inside[np.argmin(gas)]
		exit_ = inside[inside[:, 0] > inside[:, 0].max() - 0.1]
		exit_ = exit_[np.argmax(exit_[:, 1])]
		front = inside[inside[:, 0] < inside[:, 0].min() + 0.1]
		front = front[np.argmax(front[:, 1])]
		yield result("layout.petals", "open throat's radius, where the divergent flaps end", petals["throat"][1], n["waterline"] - throat[1], 0.1)
		yield result("layout.petals", "tailpipe's radius, where the convergent flaps start", petals["tailpipe"], n["waterline"] - front[1], 0.1)
		yield result("layout.petals", "divergent flaps' length", petals["divergent"], np.linalg.norm((exit_ - throat)[:2]), 0.1)
		yield result("layout.petals", "convergent flaps' length", petals["convergent"], np.linalg.norm((throat - front)[:2]), 0.1)
		# the gas path's wall unbroken: straight down from the axis every half
		# inch from the tailpipe to the exit, the first face met on the bottom
		# flap lies on the convergent and divergent flaps' cones
		inner = n["radius"][1] - 1.5
		waist = n["exit"] - petals["divergent"] * math.cos(math.asin((inner - petals["throat"][1]) / petals["divergent"]))
		tail = waist - petals["convergent"] * math.cos(math.asin((petals["tailpipe"] - petals["throat"][1]) / petals["convergent"]))
		tris = jet.tris([bottom])
		downward = FRAME.axes @ np.array([0.0, -1.0, 0.0])
		worst = 0.0
		for station in np.arange(tail + 0.25, n["exit"] - 0.25, 0.5):
			bl = value(e["buttline"]) * 12 - (station - value(F["reference"]["station"])) * math.tan(math.radians(value(e["angle"])))
			origin = FRAME.model(np.array([station, n["waterline"], bl]))
			met = first_hit(tris, origin, downward)
			wall = met / 0.0254 if met is not None else 99.0
			if station < waist:
				cone = petals["tailpipe"] + (petals["throat"][1] - petals["tailpipe"]) * (station - tail) / (waist - tail)
			else:
				cone = petals["throat"][1] + (inner - petals["throat"][1]) * (station - waist) / (n["exit"] - waist)
			worst = max(worst, abs(wall - cone))
		yield result("layout.petals", "gas path's wall off the flaps' cones, worst, from the tailpipe to the exit", 0.0, worst, 0.15)
		# the stepped tabs: the bottom flap's outer face round its engine's
		# axis, as angles from the bottom (positive outboard): what only its
		# forward part covers ends at the step, and its aft part reaches round
		# past the forward part's edge by the step
		for side in ("left", "right"):
			flap = jet.points([f"nozzle_{side}_petal_{petals['count'] // 2 + 1}"])
			sign = 1 if side == "right" else -1
			axis = value(e["buttline"]) * 12 - (flap[:, 0] - value(F["reference"]["station"])) * math.tan(math.radians(value(e["angle"])))
			radius = np.hypot(flap[:, 1] - n["waterline"], flap[:, 2] - sign * axis)
			outer = flap[radius > n["radius"][1] - 0.3]
			angle = np.degrees(np.arctan2(sign * (outer[:, 2] - sign * axis[radius > n["radius"][1] - 0.3]), n["waterline"] - outer[:, 1]))
			# the build's angles run from the top round outboard, so past the
			# bottom they run inboard; its turn, the same seen from behind on
			# both engines, is towards larger angles on the right and smaller on
			# the left: here, inboard on the right, outboard on the left
			turned = -angle * sign
			step = 360 / petals["count"] * petals["step"][1]
			lone = turned < turned.min() + step / 2
			yield result("layout.petals", f"{side} nozzle's stepped tabs' station, from the exit as a share of the flaps' length", petals["step"][0], (n["exit"] - outer[lone, 0].max()) / (n["exit"] - n["start"]), 0.02, "of the length")
			aft, forward = outer[:, 0] > outer[lone, 0].max() + 0.5, outer[:, 0] < outer[lone, 0].max() - 0.5
			# (nothing aft of a step that is not there: no step round)
			reach = (turned[aft].max() - turned[forward].max()) / (360 / petals["count"]) if aft.any() and forward.any() else 0.0
			yield result("layout.petals", f"{side} nozzle's stepped tabs' step round, as a share of a flap's width", petals["step"][1], reach, 0.02, "of the width")
		glow = jet.points(["burner_right"])
		ring = glow[glow[:, 0] > glow[:, 0].max() - 1.0][:, 1:]   # the near end, square to the converging axis
		yield result("layout.petals", "burner's radius, the open throat's", petals["throat"][1], np.linalg.norm(ring - ring.mean(0), axis=1).max(), 0.1)

	yield from guard("overall", "overall", overall)

	# Nose and forebody sections
	def nose():
		p = jet.points(["fuselage"])
		tip = p[np.argmin(p[:, 0])]
		yield result("nose.apex", "nose apex station", apex, tip[0], 0.3, "FS in")
		yield result("nose.apex", "nose apex on the fuselage reference line", value(F["datum"]["apex"]), tip[1], 0.5, "WL in")
		droop = math.radians(value(F["nose"]["droop"]))
		centres = {}
		for row in F["sections"]:
			s = row["station"]
			canted = "canted" in row.get("note", "")
			flat = jet.cut(["fuselage"], [s, 100, 0], [1, 0, 0])
			middle = (flat[:, 1].max() + flat[:, 1].min()) / 2
			if canted:
				# square to the nosecone's drooped axis: the top leans forward
				normal = [math.cos(droop), math.sin(droop), 0]
				q = jet.cut(["fuselage"], [s, middle, 0], normal)
				up = np.array([-math.sin(droop), math.cos(droop), 0])
				height = (q @ up).max() - (q @ up).min()
			else:
				q = flat
				height = q[:, 1].max() - q[:, 1].min()
			centres[s] = middle
			fact = f"sections@{s}"
			yield result(fact, f"FS {s} section height", row["height"], height, 0.5)
			yield result(fact, f"FS {s} section width", row["width"], q[:, 2].max() - q[:, 2].min(), 0.5)
		slope = math.degrees(math.atan((centres[107] - centres[70]) / (107 - 70)))
		yield result("nose.droop", "nosecone axis droop, FS 70 to 107", value(F["nose"]["droop"]), slope, 1.0, "deg")
		for row in F["forebody"]["value"]:
			s = row["station"]
			q = jet.cut(["fuselage"], [s, 100, 0], [1, 0, 0])
			yield result("forebody", f"FS {s} height (McDonnell Douglas drawing)", row["height"], q[:, 1].max() - q[:, 1].min(), 1.5)
			yield result("forebody", f"FS {s} width (McDonnell Douglas drawing)", row["width"], q[:, 2].max() - q[:, 2].min(), 1.5)

	yield from guard("sections", "forebody", nose)

	# LEX
	def lex():
		graph = F["lex"]["graph"]["value"]
		rows = [(r["station"], r["span"], f"lex.sections@{r['station']}", 1.0) for r in F["lex"]["sections"]]
		rows += [(s, span, "lex.graph", 2.5) for s, span in graph if s >= 220]
		for s, span, fact, tolerance in rows:
			q = jet.cut(["lex_right"], [s, 100, 0], [1, 0, 0])
			edge = q[np.argmax(q[:, 2])]
			body = jet.cut(["fuselage"], [s, 100, 0], [1, 0, 0])
			band = body[np.abs(body[:, 1] - q[np.argmin(q[:, 2]), 1]) < 3]
			yield result(fact, f"FS {s} LEX span from its root", span, edge[2] - band[:, 2].max(), tolerance)

	yield from guard("lex", "LEX", lex)

	# The LEX's apex and fence (tp3111's base; the photos' apex and top corners)
	def lex_parts():
		start = F["layout"]["lex"]["apex"]
		edge = jet.points(["lex_right"])
		tip = edge[edge[:, 0] < edge[:, 0].min() + 0.3]
		yield result("layout.lex", "LEX apex", start["station"], edge[:, 0].min(), 0.5, "FS in")
		yield result("layout.lex", "LEX apex", start["waterline"], tip[:, 1].mean(), 1.0, "WL in")
		base = F["lex"]["fence"]["value"]
		plate = jet.points(["lex_fence_right"])
		low = plate[plate[:, 1] < plate[:, 1].min() + 1.5]
		yield result("lex.fence", "fence base's leading end", base["leading"], low[:, 0].min(), 0.5, "FS in")
		yield result("lex.fence", "fence base's trailing end", base["trailing"], low[:, 0].max(), 0.5, "FS in")
		yield result("lex.fence", "fence base", base["buttline"], low[:, 2].mean(), 0.5, "BL in")
		lex_top = jet.cut(["lex_right"], [(base["leading"] + base["trailing"]) / 2, 100, 0], [1, 0, 0])
		floor = lex_top[np.abs(lex_top[:, 2] - base["buttline"]) < 1.0][:, 1].max()
		yield result("lex.fence", "fence height above the LEX", base["height"], plate[:, 1].max() - floor, 1.0)
		for key, corner in (("front", 0), ("aft", 1)):
			want = F["layout"]["lex"]["fence"][key]
			top = plate[plate[:, 1] > plate[:, 1].max() - 1.0]
			got = top[np.argmin(top[:, 0])] if key == "front" else top[np.argmax(top[:, 0])]
			yield result("layout.lex", f"fence's top {key} corner", want[0], got[0], 0.6, "FS in")

	yield from guard("lex.fence", "LEX fence", lex_parts)

	# The panel lines, cast onto the skin as the photos saw it, lie on the skin
	# as built: the paint lays each on the nearest surface and refuses one
	# standing more than an inch off, so a skin moved since a line was cast
	# shows here, in a draft, rather than only when the paint is baked
	def panels():
		p = F["layout"]["panels"]
		skin = jet.points(every).reshape(-1, 3, 3)
		for k, (line, sides) in enumerate([(l, [1]) for l in p["lines"]] + [(l, [1, -1]) for l in p["mirrored"]]):
			worst = 0.0
			for side in sides:
				corners = np.array(line, float) * [1, 1, side]
				dense = np.concatenate([np.linspace(q, r, max(2, int(np.ceil(np.linalg.norm(r - q) / 0.5)) + 1)) for q, r in zip(corners, corners[1:])])
				low, high = dense.min(0) - 3, dense.max(0) + 3
				# every triangle whose box meets the line's (a large one may have no corner near it)
				near = skin[((skin.min(1) <= high) & (skin.max(1) >= low)).all(1)]
				if not len(near):
					raise KeyError(f"no skin near panel line {k}")
				worst = max(worst, float(surface_distance(dense, near).max()))
			yield result("layout.panels", f"panel line {k} (FS {line[0][0]:.0f}-{line[-1][0]:.0f}) off the skin, the furthest", 0.0, worst, 1.0)
		# and the LEX's root slot, painted the same way (layout.lex slot)
		slot = F["layout"]["lex"]["slot"]
		for side, name in ((1, "right"), (-1, "left")):
			ends = np.array([slot["front"], slot["aft"]], float) * [1, 1, side]
			dense = np.linspace(ends[0], ends[1], int(np.ceil(np.linalg.norm(ends[1] - ends[0]) / 0.5)) + 1)
			low, high = dense.min(0) - 3, dense.max(0) + 3
			near = skin[((skin.min(1) <= high) & (skin.max(1) >= low)).all(1)]
			if not len(near):
				raise KeyError(f"no skin near the {name} LEX's slot")
			yield result("layout.lex", f"{name} LEX's slot off the skin, the furthest", 0.0, float(surface_distance(dense, near).max()), 1.0)

	yield from guard("layout.panels", "panel lines", panels)

	# The LEX runs into the wing with no step: its aft end, behind the
	# junction, settles onto what lies beneath it, and nothing beneath pokes up
	# through its upper surface (a near-level crossing shows as a ragged line)
	def blend():
		junction = value(F["wing"]["junction"])
		lex_points = jet.points(["lex_right"])
		end = lex_points[:, 0].max()
		yield result("shape.lex", "LEX's aft end behind the LEX-wing junction (a square end sits on it)", 40.0, min(end - junction, 40.0), 20.0)
		beneath = ["fuselage", "inlet_right", "splitter_right", "wing_inner_right", "flap_leading_inner_right"]
		under = np.concatenate([jet.points([n]).reshape(-1, 3, 3) for n in beneath if n in jet.parts()])
		stations, buttlines = np.arange(200.0, end + 0.5, 1.0), np.arange(15.0, 60.5, 1.0)
		L = heights(jet.points(["lex_right"]).reshape(-1, 3, 3), stations, buttlines)
		U = heights(under, stations, buttlines)
		covered = ~np.isnan(L)
		# the body's own wall rises at the LEX's root: judge the blade, 2 in out from it
		root = np.array([np.nanmin(np.where(covered[:, i], buttlines, np.nan)) if covered[:, i].any() else np.inf for i in range(len(stations))])
		blade = covered & (buttlines[:, None] > root[None, :] + 2)
		# any at all: a skin a hundredth of an inch through shows as a speck
		poke = blade & (U > L)
		yield result("shape.lex", "LEX's upper surface something pokes through", 0.0, float(poke.sum()), 0.0, "sq in")
		tail = blade & (stations[None, :] > end - 4)
		# most of it: a cell on the wing's root rib sees the fuselage below the rib
		gap = float(np.nanpercentile(np.where(tail, L - U, np.nan), 95)) if tail.any() else 0.0
		yield result("shape.lex", "LEX's end standing above what lies beneath (a step), 95% of it", 0.0, gap, 0.6)
		# the inner wing's root ends at BL 39.9 standing above the nacelle's shoulder: the fairing beside it
		# covers it (the wing read half an inch out, clear of its root's edge)
		cells = np.array([39.5, 40.5])
		over = heights(jet.points(["lex_right"]).reshape(-1, 3, 3), stations, cells)[0]
		wing = heights(jet.points(["wing_inner_right"]).reshape(-1, 3, 3), stations, cells)[1]
		span = (stations > junction) & np.isfinite(wing)
		bare = np.where(span & np.isfinite(over), wing - over, np.where(span, np.inf, -np.inf))
		yield result("shape.lex", "wing's root end standing above the LEX fairing beside it, the most", 0.0, max(float(bare.max()), 0.0), 0.05)

	yield from guard("shape.lex", "LEX blend", blend)

	# Wing planform, thickness, dihedral
	w = F["wing"]
	semispan = value(F["reference"]["span"]) * 12 / 2
	root, tip = value(w["root"]), value(w["tip"])
	taper = tip / root
	sweep = leading_sweep(value(w["sweep"]), value(w["aspect"]), taper)
	mean = (semispan / 3) * (1 + 2 * taper) / (1 + taper)
	leading = value(F["reference"]["leading"]) - mean * math.tan(math.radians(sweep))

	def wing():
		names = [n.format(s="right") for n in WING]
		samples = {}
		for b in (60, 80, 100, 130, 160, 180, 200, 220):
			q = jet.cut(names, [400, 100, b], [0, 0, 1])
			front, back = q[np.argmin(q[:, 0])], q[np.argmax(q[:, 0])]
			samples[b] = (front, back)
			yield result("wing.root", f"BL {b} leading edge", leading + b * math.tan(math.radians(sweep)), front[0], 0.5, "FS in")
			yield result("wing.tip", f"BL {b} chord", root + (tip - root) * b / semispan, back[0] - front[0], 0.5)
		# chord plane falls outboard with the anhedral
		a, b = samples[80][0], samples[220][0]
		yield result("layout.wing", "leading edge's slope, BL 80 to 220", F["layout"]["wing"]["dihedral"], math.degrees(math.atan((b[1] - a[1]) / 140)), 0.2, "deg")
		plane = F["layout"]["wing"]
		q = jet.cut(names, [400, 100, plane["buttline"]], [0, 0, 1])
		front, back = q[np.argmin(q[:, 0])], q[np.argmax(q[:, 0])]
		yield result("layout.wing", f"chord plane at BL {plane['buttline']}", plane["value"], (front[1] + back[1]) / 2, 0.5, "WL in")
		# thickness: cr3608's stations (wing station taken as buttline)
		for fact, station, expected in (("wing.airfoil.root", 56.876, value(w["airfoil"]["root"])), ("wing.airfoil.middle", 145.39, value(w["airfoil"]["middle"])),
				("wing.airfoil.tip", semispan - 1, value(w["airfoil"]["tip"]))):
			q = jet.cut(names, [400, 100, station], [0, 0, 1])
			chord = q[:, 0].max() - q[:, 0].min()
			thickest, where = 0.0, 0.0
			for x in np.linspace(q[:, 0].min() + chord * 0.05, q[:, 0].max() - chord * 0.05, 60):
				near = q[np.abs(q[:, 0] - x) < chord * 0.012]
				if len(near) >= 2 and near[:, 1].max() - near[:, 1].min() > thickest:
					thickest, where = near[:, 1].max() - near[:, 1].min(), (x - q[:, 0].min()) / chord
			yield result(fact, f"BL {station:.1f} thickness", expected, 100 * thickest / chord, 0.15, "% chord")
			if fact == "wing.airfoil.middle":
				yield result("airfoils", "NACA 65A's thickest point", 0.40, where, 0.06, "of chord")
		fold = jet.hinge("wing_right")
		yield result("wing.fold", "fold line", value(w["fold"]), fold[2], 0.3, "BL in")
		yield result("wing.span", "wingtip at the launcher rail (a sketch, so loosely)", value(w["span"]), jet.points(names)[:, 2].max(), 3.0, "BL in")
		inner = jet.points(["flap_leading_inner_right"])
		end = inner[inner[:, 2] < inner[:, 2].min() + 0.2]
		yield result("wing.junction", "inboard leading-edge flap's inner end (the LEX-wing junction)", value(w["junction"]),
			end[:, 0].min(), 1.0, "FS in")
		# the reference planform: area, mean chord and its leading edge, from the cuts
		bs = np.linspace(60, semispan - 0.5, 40)
		chords, fronts = [], []
		for b in bs:
			q = jet.cut(names, [400, 100, b], [0, 0, 1])
			chords.append(q[:, 0].max() - q[:, 0].min())
			fronts.append(q[:, 0].min())
		c0, c1 = np.polyfit(bs, chords, 1)[::-1]
		f0, f1 = np.polyfit(bs, fronts, 1)[::-1]
		yield result("reference.area", "trapezoidal wing area, to the centreline", value(F["reference"]["area"]), 2 * (c0 + (c0 + c1 * semispan)) / 2 * semispan / 144, 4, "ft2")
		lam = (c0 + c1 * semispan) / c0
		mac = c0 * (2 / 3) * (1 + lam + lam * lam) / (1 + lam)
		ymac = (semispan / 3) * (1 + 2 * lam) / (1 + lam)
		yield result("reference.chord", "mean aerodynamic chord", value(F["reference"]["chord"]) * 12, mac, 1.0)
		yield result("reference.leading", "mean chord's leading edge", value(F["reference"]["leading"]), f0 + f1 * ymac, 0.5, "FS in")
		yield result("reference.span", "reference span (wingtip to wingtip)", value(F["reference"]["span"]) * 12, 2 * jet.points(names)[:, 2].max(), 1.0)
		yield result("wing.sweep", "quarter-chord sweep", value(w["sweep"]), math.degrees(math.atan(f1 + 0.25 * c1)), 0.2, "deg")
		# hinged surfaces: planform areas, both sides. The flaps' area is not
		# built: their fronts stand on the hinge line (layout.hinge), below
		areas = value(w["areas"])
		for fact_key, nodes in (("aileron", ["aileron_{s}"]), ("lef", ["flap_leading_inner_{s}", "flap_leading_outer_{s}"])):
			total = sum(verify.area(jet.tris([n.format(s=s)]), FRAME.axes @ [0, 1, 0]) / 2 for n in nodes for s in ("left", "right")) / 0.0254 ** 2 / 144
			yield result("wing.areas", f"{fact_key} area, both sides", areas[fact_key], total, areas[fact_key] * 0.03, "ft2")
		# the flap's and aileron's fronts, as shares of the wing's chord half-way
		# along each, against the hinge line the photos from below show
		hinge = value(F["layout"]["hinge"])
		# (the flap's built on it; the aileron's, set by its cited area, within an inch)
		for part, reach_, tolerance in (("flap_trailing", F["layout"]["surfaces"]["tef"], 0.003), ("aileron", F["layout"]["surfaces"]["aileron"], 0.015)):
			b = (reach_[0] + reach_[1]) / 2
			chord = jet.cut([n.format(s="right") for n in WING], [0, 0, b], [0, 0, 1])
			front = jet.cut([f"{part}_right"], [0, 0, b], [0, 0, 1])[:, 0].min()
			yield result("layout.hinge", f"{part.split('_')[0]}'s front at BL {b:.0f}, share of the chord", hinge, (front - chord[:, 0].min()) / np.ptp(chord[:, 0]), tolerance, "of chord")
		inner_area = verify.area(jet.tris(["flap_leading_inner_right"]), FRAME.axes @ [0, 1, 0]) / 2 / 0.0254 ** 2 / 144
		yield result("wing.lef", "each inboard leading-edge flap's share of the total", value(w["lef"]), inner_area / areas["lef"], 0.01, "of total")

	yield from guard("wing", "wing", wing)

	# The bend under load (layout.flex): the tips rise as the facts say at 1 g,
	# along the span as the ground test bent, nothing inboard of the junction
	# moves, and the outer panel and the hinged surfaces stay on the bent wing:
	# closely at 1 g, and within the limit load's slip at 7.5 g (a shape key
	# moves in a straight line and cannot follow a bend joint's turn to second
	# order, so the long flaps' ends slide along their seams by about the
	# square of the turn: 0.2 in at 7.5 g with a 2.1 in rise, 1.1 in with 5 in)
	def flex():
		f = F["layout"]["flex"]
		for side in ("left", "right"):
			outer, inner = f"wing_outer_{side}", f"wing_inner_{side}"
			rest, one = jet.points([outer]), jet.points([outer], {"load": 1})
			tip = np.abs(rest[:, 2]) >= np.abs(rest[:, 2]).max() - 0.5
			yield result("layout.flex", f"{side} wingtip's rise at 1 g", f["rise"], (one - rest)[tip, 1].mean(), 0.1)
			# the bend's shape along the span, against the ground test's
			both = jet.points([inner, outer]); lifted = jet.points([inner, outer], {"load": 1})
			rise = (one - rest)[tip, 1].mean()
			# (each streamwise section moves whole, so the rise is a function of the buttline)
			buttlines, rises = np.abs(both[:, 2]), (lifted - both)[:, 1]
			order = np.argsort(buttlines)
			for station, share in f["shape"]:
				if not buttlines.min() <= station <= buttlines.max():
					raise KeyError(f"not built: the {side} wing at BL {station}")
				yield result("layout.flex", f"{side} wing's rise at BL {station}, as a share of the tip's", share, np.interp(station, buttlines[order], rises[order]) / rise, 0.07, "of the tip's")
			# each bend joint turns its part, with the bend joints above it, by the
			# wing's own slope at its buttline: the hinge lines follow the bend.
			# The mesh's slope is its ring segment's (rings about 20 in apart),
			# within 1 mrad of the bend's; a turn left out misses by all of it
			# (7.5 mrad and up, 2.6 for one riding the fold's)
			def slope(bl):
				return (np.interp(bl + 2, buttlines[order], rises[order]) - np.interp(bl - 2, buttlines[order], rises[order])) / 4

			posed = verify.pose(jet.joints, {"load": 1})
			carriers = sorted(n for n in jet.joints if n.startswith("flex_") and n.endswith(f"_{side}"))
			if not carriers:
				raise KeyError(f"not built: the {side} wing's bend joints")
			for name in carriers:
				turn, i = 0.0, jet.model.index[name]
				while i is not None:
					node = jet.model.nodes[i]["name"]
					if jet.joints.get(node, {}).get("motion") == "bend":
						turn += posed[node][2][0]
					i = jet.model.nodes[i]["parent"]
				yield result("layout.flex", f"{name}'s turn at 1 g, the wing's slope at its buttline", slope(abs(jet.hinge(name)[2])) * 1000, turn * 1000, 1.5, "mrad")
				# and its hinge point rises with the wing there
				origin = FRAME.source(jet.model.worlds(posed)[jet.model.index[name]][:3, 3][None])[0]
				bl = abs(jet.hinge(name)[2])
				yield result("layout.flex", f"{name}'s point's rise at 1 g, the wing's at its buttline", np.interp(bl, buttlines[order], rises[order]), origin[1] - jet.hinge(name)[1], 0.05)
			still = np.abs(jet.points([inner])[:, 2]) <= f["root"]
			if not still.any():
				raise KeyError(f"not built: {inner} inboard of the junction")
			yield result("layout.flex", f"{side} wing inboard of the junction moving at 7.5 g", 0.0, np.abs(jet.points([inner], {"load": 7.5}) - jet.points([inner]))[still].max(), 0.01)
			for a, b in ((inner, outer), (inner, f"flap_trailing_{side}"), (inner, f"flap_leading_inner_{side}"), (outer, f"aileron_{side}"), (outer, f"flap_leading_outer_{side}")):
				A, B = jet.points([a]), jet.points([b])
				near = np.linalg.norm(A[:, None] - B[None], axis=2) < 0.01
				i, j = np.nonzero(near)
				if not len(i):
					raise KeyError(f"not built: a seam between {a} and {b}")
				for load, tolerance in ((1, 0.01), (7.5, 0.3)):
					gap = np.linalg.norm(jet.points([a], {"load": load})[i] - jet.points([b], {"load": load})[j], axis=1).max()
					yield result("layout.flex", f"{b} on {a}'s seam at {load} g", 0.0, gap, tolerance)

	yield from guard("layout.flex", "wing flex", flex)

	# Stabilator
	s_ = F["stabilator"]

	def stabilator():
		p = jet.points(["stabilator_left", "stabilator_right"])
		yield result("stabilator.span", "tip to tip", value(s_["span"]) * 12, p[:, 2].max() - p[:, 2].min(), 0.5)
		r = jet.points(["stabilator_right"])
		yield result("stabilator.exposed", "exposed panels' span", value(s_["exposed"]) * 12, 2 * (r[:, 2].max() - r[:, 2].min()), 1.0)
		inner, outer = r[:, 2].min(), r[:, 2].max()
		rc, tc = value(s_["root"]), value(s_["tip"])
		exposed = outer - inner
		aspect = (value(s_["exposed"]) * 12) ** 2 / (value(s_["area"]) * 144)
		lsweep = leading_sweep(value(s_["sweep"]), aspect, tc / rc)
		# the trailing corner's round (layout.stabilator_corner): the angle the
		# cited planform's tip and trailing edge include, and the station out
		# where the round leaves the trailing edge
		radius = value(F["layout"]["stabilator_corner"])
		run = exposed * math.tan(math.radians(lsweep)) + tc - rc
		included = math.pi / 2 - math.atan2(run, exposed)
		begins = outer - radius / math.tan(included / 2) * math.sin(included)
		samples = {}
		for f in (0.03, 0.5, 0.75, 0.97):
			b = inner + exposed * f
			q = jet.cut(["stabilator_right"], [600, 100, b], [0, 0, 1])
			samples[f] = q
			chord = q[:, 0].max() - q[:, 0].min()
			if b < begins:
				# a chord on the round is the round's, checked below
				yield result("stabilator.root" if f < 0.5 else "stabilator.tip", f"chord {f:.0%} out", rc + (tc - rc) * f, chord, 0.6)
		a, b = samples[0.03], samples[0.97]
		slope = (b[:, 0].min() - a[:, 0].min()) / (exposed * 0.94)
		yield result("stabilator.sweep", "leading-edge sweep (from the quarter-chord's)", lsweep, math.degrees(math.atan(slope)), 0.3, "deg")
		fa, fb = a[np.argmin(a[:, 0])], b[np.argmin(b[:, 0])]
		yield result("stabilator.dihedral", "leading edge's slope", value(s_["dihedral"]), math.degrees(math.atan((fb[1] - fa[1]) / (fb[2] - fa[2]))), 0.2, "deg")
		# cr201687's area is the theoretical planform's, with sharp corners: less
		# the two trailing corners' rounds, each the corner's sliver between the
		# round and the tip and trailing edge
		sliver = radius * radius * (1 / math.tan(included / 2) - (math.pi - included) / 2)
		area = sum(verify.area(jet.tris([f"stabilator_{s}"]), FRAME.axes @ [0, 1, 0]) / 2 for s in ("left", "right")) / 0.0254 ** 2 / 144
		yield result("stabilator.area", "exposed area, both sides, less the corners' rounds", value(s_["area"]) - 2 * sliver / 144, area, 0.3, "ft2")
		for f, key in ((0.03, "root"), (0.97, "tip")):
			q = samples[f]
			chord = q[:, 0].max() - q[:, 0].min()
			yield result("stabilator.airfoil", f"{key} thickness", value(s_["airfoil"])[key], 100 * (q[:, 1].max() - q[:, 1].min()) / chord, 0.4, "% chord")
		place = F["layout"]["stabilator"]
		front = a[:, 0].min() - (b[:, 0].min() - a[:, 0].min()) * 0.03 / 0.94
		yield result("layout.stabilator", "exposed root's leading edge", place["value"], front, 1.5, "FS in")
		yield result("layout.stabilator", "exposed root", place["buttline"], inner, 0.5, "BL in")
		yield result("layout.stabilator", "exposed root's leading edge height", place["waterline"], fa[1] - 0.03 * (fb[1] - fa[1]) / 0.94, 0.3, "WL in")
		# The tip's trailing corner rounded to layout.stabilator_corner, tangent to
		# the tip and the trailing edge: the trailing edge's line measured clear of
		# the round (3% and 70% out), and the outline at the tip and half-way
		# round the corner where a circle of that radius puts it
		clear = {}
		for f in (0.03, 0.7):
			b = inner + exposed * f
			clear[b] = jet.cut(["stabilator_right"], [600, 100, b], [0, 0, 1])[:, 0].max()
		(b0, t0), (b1, t1) = clear.items()
		slope = (t1 - t0) / (b1 - b0)
		cos = 1 / math.sqrt(1 + slope * slope)
		middle = outer - radius
		behind = t0 + slope * (middle - b0) - radius / cos
		for b, where in ((outer - 0.3, "at the tip"), (outer - radius * 0.5, "half-way round")):
			edge = jet.cut(["stabilator_right"], [600, 100, b], [0, 0, 1])[:, 0].max()
			yield result("layout.stabilator_corner", f"trailing corner's round, {where}", behind + math.sqrt(radius * radius - (b - middle) ** 2), edge, 0.4, "FS in")

	yield from guard("stabilator", "stabilator", stabilator)

	# Fins
	f_ = F["fin"]

	def fin():
		cant = math.radians(value(f_["cant"]))
		span = np.array([0, math.cos(cant), math.sin(cant)])   # (station, waterline, buttline), right fin
		p = jet.points(["fin_right", "rudder_right"])
		h = p @ span
		yield result("fin.top", "fin tip", value(f_["top"]), p[:, 1].max(), 0.5, "WL in")
		rc, tc = value(f_["root"]), value(f_["tip"])
		low, high = h.min(), h.max()
		sections = {}
		for frac in (0.03, 0.97):
			d = low + (high - low) * frac
			q = jet.cut(["fin_right", "rudder_right"], [0, 0, 0] + span * d, span)
			sections[frac] = q
			yield result("fin.root" if frac < 0.5 else "fin.tip", f"chord {frac:.0%} up", rc + (tc - rc) * frac, q[:, 0].max() - q[:, 0].min(), 0.6)
		a, b = sections[0.03], sections[0.97]
		# the leading edge's ends: the foremost point of the root's and the tip's lowest and highest inch
		root_end = p[p[:, 1] < p[:, 1].min() + 1.0]
		tip_end = p[p[:, 1] > p[:, 1].max() - 1.0]
		ends = root_end[np.argmin(root_end[:, 0])], tip_end[np.argmin(tip_end[:, 0])]
		yield result("fin.height", "height along its span (leading edge, root to tip)", value(f_["height"]), (ends[1] - ends[0]) @ span, 0.5)
		lsweep = math.degrees(math.atan(math.tan(math.radians(value(f_["sweep"]))) + 0.25 * (rc - tc) / value(f_["height"])))
		measured = math.degrees(math.atan((b[:, 0].min() - a[:, 0].min()) / ((high - low) * 0.94)))
		yield result("fin.sweep", "leading-edge sweep (from the quarter-chord's)", lsweep, measured, 0.3, "deg")
		top, bottom = b[np.argmin(b[:, 0])], a[np.argmin(a[:, 0])]
		lean = math.degrees(math.atan2(top[2] - bottom[2], top[1] - bottom[1]))
		yield result("fin.cant", "outboard lean", value(f_["cant"]), lean, 0.3, "deg")
		# toe: the root chord's heading in plan, + with the leading edge outboard
		front, back = a[np.argmin(a[:, 0])], a[np.argmax(a[:, 0])]
		yield result("fin.toe", "toe out (leading edge outboard)", value(f_["toe"]), math.degrees(math.atan2(front[2] - back[2], back[0] - front[0])), 0.2, "deg")
		normal = FRAME.axes @ np.cross([1.0, 0, 0], span)
		area = sum(verify.area(jet.tris([f"fin_{s}", f"rudder_{s}"]), normal * ([1, 1, -1] if s == "left" else 1)) / 2 for s in ("left", "right")) / 0.0254 ** 2 / 144
		yield result("fin.area", "area, both fins", value(f_["area"]), area, 2.0, "ft2")
		rudder = sum(verify.area(jet.tris([f"rudder_{s}"]), normal * ([1, 1, -1] if s == "left" else 1)) / 2 for s in ("left", "right")) / 0.0254 ** 2 / 144
		yield result("fin.rudder", "rudder area, both", value(f_["rudder"]), rudder, 0.5, "ft2")
		for frac, key in ((0.03, "root"), (0.97, "tip")):
			q = sections[frac]
			chord = q[:, 0].max() - q[:, 0].min()
			across = np.cross(span, [1, 0, 0])
			yield result("fin.airfoil", f"{key} thickness", value(f_["airfoil"])[key], 100 * ((q @ across).max() - (q @ across).min()) / chord, 0.4, "% chord")
		place = F["layout"]["fin"]
		run = (top[0] - bottom[0]) / 0.94
		yield result("layout.fin", "tip leading edge", place["tip"]["station"], top[0] + run * 0.03, 1.0, "FS in")
		yield result("layout.fin", "root leading edge", place["root"]["station"], bottom[0] - run * 0.03, 1.5, "FS in")
		# the fairing along the right fin's root, outboard: where its upper edge
		# meets the leading edge, its upper edge's height and its foot's
		# buttline at the photos' stations, its front, its upper edge's step
		# off the fin's face, and how far its foot stands outboard of the
		# face carried down (the views from behind)
		fair = place["fairing"]
		q = jet.points(["fin_fairing_right"])
		peak = q[np.argmax(q[:, 1])]
		front_top = fair["top"][0]
		yield result("layout.fin", "fairing's upper edge meeting the leading edge", front_top[0], peak[0], 1.5, "FS in")
		yield result("layout.fin", "fairing's upper edge meeting the leading edge", front_top[1], peak[1], 1.0, "WL in")
		yield result("layout.fin", "fairing's front", fair["foot"][0][0], q[:, 0].min(), 1.5, "FS in")
		for station, waterline in fair["top"][1:]:
			c = jet.cut(["fin_fairing_right"], [station, 0, 0], [1, 0, 0])
			if not len(c):
				raise KeyError(f"no fin_fairing_right at FS {station}")
			yield result("layout.fin", f"fairing's upper edge at FS {station:.0f}", waterline, c[:, 1].max(), 1.0, "WL in")
		for station, buttline in fair["foot"][1:]:
			c = jet.cut(["fin_fairing_right"], [min(station, fair["top"][-1][0] - 0.5), 0, 0], [1, 0, 0])
			if not len(c):
				raise KeyError(f"no fin_fairing_right at FS {station}")
			low = c[c[:, 1] < c[:, 1].min() + 1.0]
			yield result("layout.fin", f"fairing's foot at FS {station:.0f}", buttline, low[:, 2].max(), 1.0, "BL in")
		station, waterline = fair["top"][2]
		c = jet.cut(["fin_fairing_right"], [station, 0, 0], [1, 0, 0])
		f = jet.cut(["fin_right"], [station, 0, 0], [1, 0, 0])

		def face(wl):
			# the outermost buttline where the fin's cut (segments, point pairs) crosses WL wl
			a, b = f[0::2], f[1::2]
			hit = (a[:, 1] - wl) * (b[:, 1] - wl) < 0
			if not hit.any():
				raise KeyError(f"no fin_right face at FS {station}, WL {wl}")
			t = (wl - a[hit, 1]) / (b[hit, 1] - a[hit, 1])
			return float((a[hit, 2] + (b[hit, 2] - a[hit, 2]) * t).max())

		edge = c[c[:, 1] > c[:, 1].max() - 0.3]
		yield result("layout.fin", f"fairing's upper edge's step off the fin's face at FS {station:.0f}", fair["step"], edge[:, 2].max() - face(c[:, 1].max() - 0.15), 0.3, "in")
		w0, w1 = waterline + 5.0, waterline + 15.0
		low = c[c[:, 1] < c[:, 1].min() + 1.0]
		foot = low[np.argmax(low[:, 2])]
		carried = face(w0) + (face(w1) - face(w0)) * (foot[1] - w0) / (w1 - w0)
		yield result("layout.fin", f"fairing's foot outboard of the fin's face carried down, FS {station:.0f}", fair["standoff"], foot[2] - carried, 0.75, "in")

	yield from guard("fin", "fins", fin)

	# Engine, nozzles, inlets
	e_ = F["engine"]

	def engine():
		n = jet.points(sorted(n for n in jet.parts() if n.startswith("nozzle_right_petal_")))
		exit_ = n[n[:, 0] > n[:, 0].max() - 0.5]
		centre = (exit_[:, 2].max() + exit_[:, 2].min()) / 2
		at = n[:, 0].max()
		expected = value(e_["buttline"]) * 12 - (at - value(F["reference"]["station"])) * math.tan(math.radians(value(e_["angle"])))
		yield result("engine.buttline", "nozzle exit's centre on the engine axis", expected, centre, 0.5, "BL in")
		start = n[n[:, 0] < n[:, 0].min() + 0.5]
		slope = math.degrees(math.atan(((start[:, 2].max() + start[:, 2].min()) / 2 - centre) / (at - n[:, 0].min())))
		yield result("engine.angle", "nozzle axis converging aft", value(e_["angle"]), slope, 0.5, "deg")
		# 4 in behind the raked lip's aftmost point, where the cut crosses the duct whole
		lip = max(p[0] for p in F["layout"]["inlet"]["lip"].values())
		q = jet.cut(["inlet_right"], [lip + 4, 100, 0], [1, 0, 0])
		inner = min((l for l in loops(q[:, 1:].reshape(-1, 2, 2)) if len(l) > 8), key=shoelace)
		a = shoelace(inner)
		perimeter = np.linalg.norm(np.diff(inner, axis=0), axis=1).sum()
		yield result("engine.inlet", "inlet duct's hydraulic diameter, 4 in in", value(e_["inlet"]), 4 * a / perimeter, 1.0)

	yield from guard("engine", "engine", engine)

	# The inlet's mouth and splitter plate where the photos put them
	def inlet():
		place = F["layout"]["inlet"]
		lip = place["lip"]
		measured = np.array([lip[k] for k in ("top", "bottom", "outer", "corner_top", "corner_bottom")], float)
		plane = np.linalg.lstsq(np.c_[np.ones(len(measured)), measured[:, 1], measured[:, 2]], measured[:, 0], rcond=None)[0]
		duct = jet.points(["inlet_right"])
		# the lip as built: the front edge and the ring 1.6 in behind it, found
		# from the mesh (the most forward points along the lip's slant), so an
		# inlet built in the wrong place reads as misses, not as nothing
		ahead = plane[0] + plane[1] * duct[:, 1] + plane[2] * duct[:, 2] - duct[:, 0]
		front = duct[ahead > ahead.max() - 1.9]

		def pick(values, how):
			return float(how(values)) if len(values) else float("nan")

		yield result("layout.inlet", "lip's top", lip["top"][1], pick(front[:, 1], np.max), 1.0, "WL in")
		yield result("layout.inlet", "lip's bottom", lip["bottom"][1], pick(front[:, 1], np.min), 1.0, "WL in")
		yield result("layout.inlet", "lip's outboard side", lip["outer"][2], pick(front[:, 2], np.max), 1.0, "BL in")
		for key in ("top", "bottom"):
			p = lip[f"corner_{key}"]
			near = front[np.abs(front[:, 1] - p[1]) < 1.0]
			yield result("layout.inlet", f"flat inboard side at its {key} corner", p[2], pick(near[:, 2], np.min), 1.0, "BL in")
			p = lip[key]
			near = front[np.abs(front[:, 1] - p[1]) < 1.0]
			yield result("layout.inlet", f"lip's station at its {key}", p[0], pick(near[:, 0], np.min), 1.0, "FS in")
		# the front edge (the one ring ahead of the rest) against the traced outline
		edge = np.unique(duct[ahead > ahead.max() - 0.2][:, [1, 2]].round(4), axis=0)
		centre = edge.mean(axis=0)
		edge = edge[np.argsort(np.arctan2(edge[:, 1] - centre[1], edge[:, 0] - centre[0]))]
		a, b = edge, np.roll(edge, -1, axis=0)
		worst = 0.0
		for q in np.array(place["outline"], float):
			s = np.clip(((q - a) * (b - a)).sum(1) / np.maximum(((b - a) ** 2).sum(1), 1e-12), 0, 1)
			worst = max(worst, float(np.linalg.norm(a + s[:, None] * (b - a) - q, axis=1).min()))
		yield result("layout.inlet", "lip's front edge off the traced outline, worst", 0.0, worst, 1.0)
		plate = jet.points(["splitter_right"])
		traced = place["splitter"]["edge"]
		for what, p in (("top", traced[0]), ("middle", traced[len(traced) // 2]), ("bottom", traced[-1])):
			near = plate[np.abs(plate[:, 1] - p[1]) < 0.6]
			yield result("layout.inlet", f"splitter's leading edge at its {what}", p[0], pick(near[:, 0], np.min), 1.0, "FS in")
			yield result("layout.inlet", f"splitter's buttline at its {what}", p[2], pick(near[:, 2], np.max), 0.5, "BL in")

	yield from guard("layout.inlet", "inlet", inlet)

	# The nacelles' lowest line: on the HATP side view's keel line (its traced
	# centre, unsmoothed), through the in-flight photo's outline behind the
	# lip, and on to the nozzles
	def nacelle():
		n = F["layout"]["nacelle"]
		drawn = json.loads((HERE / "references" / "profiles.json").read_text())["side"]
		keel = dict(zip(drawn["stations"], drawn["keel"]))
		low, high = n["keel"]

		def bottom(station, side):
			q = jet.cut(["fuselage", f"inlet_{side}"], [station, 100, 0], [1, 0, 0])
			out = q[:, 2] * (1 if side == "right" else -1)
			near = q[(out > 12) & (out < 50)]
			if not len(near):
				raise KeyError(f"nothing of the {side} nacelle at FS {station}")
			return float(near[:, 1].min())

		aft = n["aft"]
		# the outline follows the keel line until the doors' blister leaves it
		high = min(high, n["door"][0][0])
		for side in ("left", "right"):
			misses = [bottom(s, side) - keel[s] for s in range(int(low), int(high) + 1, 8)]
			yield result("layout.nacelle", f"{side} nacelle's bottom off the HATP keel line, FS {low}-{high}, worst", 0.0, max(misses, key=abs), 1.0)
			for s in (650, 666, 685):
				yield result("layout.nacelle", f"{side} nacelle's bottom at FS {s}", float(np.interp(s, [k[0] for k in aft], [k[1] for k in aft])), bottom(s, side), 1.0, "WL in")
			# the blister's knots, but its last, which only shapes its step up
			# onto the nacelle's own line, crossing it before
			for s, w in n["door"][:-1]:
				yield result("layout.nacelle", f"{side} nacelle's bottom at FS {s:g} (the main gear doors' blister)", w, bottom(s, side), 0.5, "WL in")
			for s, w in n["line"]:
				yield result("layout.nacelle", f"{side} nacelle's bottom at FS {s:g} (the photos' lower outline)", w, bottom(s, side), 0.5, "WL in")
		# the outer face between the flap and the stabilator through the photos'
		# strips at its widest line and its lower corner seen from below
		def outer(station, waterline, side):
			# the outline's buttline at the waterline, between its points just
			# above and just below, on the outer face
			q = jet.cut(["fuselage"], [station, 100, 0], [1, 0, 0])
			sign = 1 if side == "right" else -1
			face = q[(q[:, 2] * sign > 30) & (np.abs(q[:, 1] - waterline) < 4)]
			above, below = face[face[:, 1] >= waterline], face[face[:, 1] < waterline]
			if not len(above) or not len(below):
				raise KeyError(f"nothing of the {side} nacelle's side at FS {station}, WL {waterline}")
			a = above[np.argmax(above[:, 2] * sign - 10 * (above[:, 1] - waterline))]
			b = below[np.argmax(below[:, 2] * sign - 10 * (waterline - below[:, 1]))]
			f = (waterline - b[1]) / ((a[1] - b[1]) or 1)
			return float(abs(b[2] + (a[2] - b[2]) * f))

		# the main gear bay's corner (layout.nacelle bay): the bottom's outboard
		# edge along its knots, where the eases leave it whole; the band above
		# it at the outer door's hinge, and the crease
		bay = F["layout"]["nacelle"]["bay"]

		def edge(station, buttline, side):
			# the skin's lowest waterline where the station's cut crosses the buttline
			q = jet.cut(["fuselage"], [station, 100, 0], [1, 0, 0]).reshape(-1, 2, 3)
			sign = 1 if side == "right" else -1
			a, b = q[:, 0], q[:, 1]
			hit = (a[:, 2] * sign - buttline) * (b[:, 2] * sign - buttline) < 0
			if not hit.any():
				raise KeyError(f"nothing of the {side} nacelle at FS {station}, BL {buttline}")
			t = (buttline - a[hit, 2] * sign) / (b[hit, 2] * sign - a[hit, 2] * sign)
			return float((a[hit, 1] + (b[hit, 1] - a[hit, 1]) * t).min())

		f0, f1, f2, f3 = bay["fade"]
		hinge = F["layout"]["gear"]["doors"]["outer"]["hinge"]
		across = lambda s: float(np.interp(s, [k[0] for k in bay["buttline"]], [k[1] for k in bay["buttline"]]))
		crease, beside = bay["crease"]
		for side in ("left", "right"):
			for s, w in bay["edge"]:
				if f1 <= s <= f2:
					yield result("layout.nacelle", f"{side} main gear bay's outboard edge at FS {s:g}", w, edge(s, across(s) - 0.5, side), 1.0, "WL in")
			for s in hinge[:2]:
				yield result("layout.nacelle", f"{side} main gear bay's band at the outer door's hinge, FS {s:g}", across(s), outer(s, (edge(s, across(s) - 0.5, side) + crease) / 2, side), 1.0, "BL in")
			yield result("layout.nacelle", f"{side} main gear bay's crease, FS {hinge[0]:g}", beside, outer(hinge[0], crease, side), 1.0, "BL in")
			# aft of the door, where its buttline eases in
			yield result("layout.nacelle", f"{side} main gear bay's corner at FS 594", across(594), outer(594, edge(594, across(594) - 0.5, side) + 1.0, side), 1.0, "BL in")
		# and between them the face is not hollow: no point of it inside the
		# chord from the line to the corner, wherever the side reshapes it (the
		# union swelling the face at the line pinched it 0.6 in at FS 548)
		top = float(np.mean([p[1] for p in n["side"]["line"]]))
		low = float(np.mean([p[1] for p in n["side"]["corner"]]))
		start, end = n["side"]["fade"]
		for side in ("left", "right"):
			for s, w, b in n["side"]["line"] + n["side"]["corner"]:
				yield result("layout.nacelle", f"{side} nacelle's outer face at FS {s:g}, WL {w:g}", b, outer(s, w, side), 0.5, "BL in")
			worst, where = 0.0, None
			for station in range(int(start) + 40, int(end) - 39, 4):
				upper, lower = outer(station, top, side), outer(station, low, side)
				for share in (0.25, 0.5, 0.75):
					w = low + (top - low) * share
					hollow = lower + (upper - lower) * share - outer(station, w, side)
					if hollow > worst:
						worst, where = hollow, (station, w)
			label = f" (at FS {where[0]}, WL {where[1]:.1f})" if where else ""
			yield result("layout.nacelle", f"{side} nacelle's outer face hollow between its line and its lower corner, the deepest{label}", 0.0, worst, 0.25)
		for s, w, sigma in n["photo"]:
			yield result("layout.nacelle", f"left nacelle's bottom at FS {s} (dvids6696790's outline)", w, bottom(s, "left"), sigma, "WL in")
		# the photo's outline falls from just behind the lip's rim, stepping 0.8
		# in below it and on at 0.13 in/in to FS 447: no level stretch first
		rim = F["layout"]["inlet"]["lip"]["bottom"][0] + 1.5
		yield result("layout.nacelle", "underside's fall over the 4 in behind the lip's rim", -0.15, (bottom(rim + 4, "left") - bottom(rim, "left")) / 4, 0.07, "in/in")

	yield from guard("layout.nacelle", "nacelle", nacelle)

	# The spine and the deck behind the LEX where the photos place them: the
	# crown in the profile, the spine's flank at its panel joints' lower ends,
	# and the deck where it meets the spine's wall
	def spine():
		sp = F["layout"]["spine"]
		skin = jet.points(["fuselage", "canopy", "lex_left", "lex_right"]).reshape(-1, 3, 3)

		def at(view, station, across):
			# the skin's height seen from a view, at one station and line, on a small even grid round it
			return float(lines(skin, view, np.array([station - 0.5, station, station + 0.5]), np.array([across - 0.5, across, across + 0.5]))[1, 1])

		for station, waterline in sp["crown"]:
			yield result("layout.spine", f"crown at FS {station:g} (dvids9820808's profile)", waterline, at("above", station, 0.0), 0.5, "WL in")
		for station, waterline, buttline in sp["flank"]:
			yield result("layout.spine", f"spine's flank at FS {station:g}, WL {waterline:g} (its panel joints' lower ends)", buttline, at("outboard", station, waterline), 1.0, "BL in")
		# the side seam behind the canopy, triangulated by two photo pairs that part
		# by 0.4-1.3 in along it: held to 0.75 in
		for station, waterline, buttline in sp["side"]:
			yield result("layout.spine", f"spine's side seam behind the canopy at FS {station:g}, WL {waterline:g}", buttline, at("outboard", station, waterline), 0.75, "BL in")
		for station, waterline, buttline in sp["rear"]:
			yield result("layout.spine", f"spine's top between the fins at FS {station:g}, BL {buttline:g}", waterline, at("above", station, buttline), 1.0, "WL in")
		for station, waterline in sp["deck"]:
			yield result("layout.spine", f"deck beside the spine at FS {station:g} (dvids9820788)", waterline, at("above", station, 24.0), 1.0, "WL in")
		# the top's centreline behind the crown's last point, between and behind
		# the fins, where the sky check's top outline puts it
		top = jet.points(["fuselage", "speedbrake"]).reshape(-1, 3, 3)
		for station, waterline in sp["crest"]:
			crest = float(lines(top, "above", np.array([station - 0.5, station, station + 0.5]), np.array([-0.5, 0.0, 0.5]))[1, 1])
			yield result("layout.spine", f"crest at FS {station:g} (the sky check's top outline)", waterline, crest, 0.5, "WL in")

	yield from guard("layout.spine", "spine", spine)

	# The forebody's keel where the photos' lower outline puts it (layout.belly)
	def belly():
		skin = jet.points(["fuselage"]).reshape(-1, 3, 3)
		for station, waterline in F["layout"]["belly"]["keel"][1:-1]:
			low = float(lines(skin, "below", np.array([station - 0.5, station, station + 0.5]), np.array([-0.5, 0.0, 0.5]))[1, 1])
			yield result("layout.belly", f"keel at FS {station:g} (the photos' lower outline)", waterline, low, 0.4, "WL in")

	yield from guard("layout.belly", "belly", belly)

	# Fittings
	def fittings():
		g = F["fittings"]["gun"]
		muzzle = FRAME.source(jet.document["points"]["gun"]["muzzle"])
		yield result("fittings.gun", "gun muzzle station", g["station"], muzzle[0], 1.0, "FS in")
		q = jet.cut(["fuselage"], [g["station"], 100, 0], [1, 0, 0])
		yield result("fittings.gun", "gun muzzle on the top centreline", q[:, 1].max(), muzzle[1], 0.5, "WL in")
		pr = F["layout"]["probe"]
		door = jet.points(["probe_door"])
		yield result("layout.probe", "probe door's forward end", pr["from"], door[:, 0].min(), 1.0, "FS in")
		yield result("layout.probe", "probe door's aft end", pr["to"], door[:, 0].max(), 1.0, "FS in")
		# the door lies on the skin: no corner more than an inch outside the fuselage's section there
		worst = 0.0
		for s in np.linspace(pr["from"] + 2, pr["to"] - 2, 8):
			body = jet.cut(["fuselage"], [s, 100, 0], [1, 0, 0])
			centre = np.array([(body[:, 1].max() + body[:, 1].min()) / 2, 0.0])
			d = jet.cut(["probe_door"], [s, 100, 0], [1, 0, 0])
			for wl, bl in d[:, 1:]:
				theta = math.atan2(bl, wl - centre[0])
				rays = body[:, 1:] - centre
				angle = np.arctan2(rays[:, 1], rays[:, 0])
				skin = np.linalg.norm(rays[np.argmin(np.abs(angle - theta))])
				worst = max(worst, math.hypot(wl - centre[0], bl) - skin)
		yield result("layout.probe", "probe door's height above the skin", 0.3, worst, 0.7)
		# its edges round the section at its middle: the lower from the photos, the upper from tm101724
		s = (pr["from"] + pr["to"]) / 2
		body = jet.cut(["fuselage"], [s, 100, 0], [1, 0, 0])
		middle = (body[:, 1].max() + body[:, 1].min()) / 2
		d = jet.cut(["probe_door"], [s, 100, 0], [1, 0, 0])
		round_from_top = np.degrees(np.arctan2(np.abs(d[:, 2]), d[:, 1] - middle))
		yield result("layout.probe", "probe door's lower edge round from the top", pr["lower"], round_from_top.max(), 2.0, "deg")
		yield result("layout.probe", "probe door's upper edge round from the top", pr["upper"], round_from_top.min(), 2.0, "deg")
		probe = jet.points(["probe"])
		yield result("layout.probe", "stowed probe reaching ahead of its door", 0.0, max(0.0, pr["from"] - probe[:, 0].min()), 0.01)
		# the angle-of-attack probes: the plate's centre, and the cone standing out of it
		aoa = F["layout"]["aoa"]
		for name in ("aoa_left", "aoa_right"):
			p = jet.points([name])
			# the plate: all but the cone's outer part
			plate = p[np.abs(p[:, 2]) < np.abs(p[:, 2]).max() - 2.0]
			middle = np.array([(plate[:, 0].min() + plate[:, 0].max()) / 2, (plate[:, 1].min() + plate[:, 1].max()) / 2])
			rim = plate[np.hypot(plate[:, 0] - middle[0], plate[:, 1] - middle[1]) > 2.0]
			yield result("layout.aoa", f"{name} plate's station", aoa["station"], middle[0], 0.5, "FS in")
			yield result("layout.aoa", f"{name} plate's waterline", aoa["waterline"], middle[1], 0.5, "WL in")
			yield result("layout.aoa", f"{name} plate's diameter", aoa["plate"], plate[:, 0].max() - plate[:, 0].min(), 0.3)
			yield result("layout.aoa", f"{name} cone standing out of the plate", aoa["cone"], np.abs(p[:, 2]).max() - np.abs(rim[:, 2]).mean(), 0.5)
		# the pitot-static tubes: the photos' tip and strut, tm101724's extent
		pt, cited = F["layout"]["pitot"], F["fittings"]["pitot"]
		for name in ("pitot_left", "pitot_right"):
			p = jet.points([name])
			yield result("layout.pitot", f"{name} tip", pt["tip"][0], p[:, 0].min(), 0.5, "FS in")
			front = p[p[:, 0] < pt["tip"][0] + 0.5]
			yield result("layout.pitot", f"{name} tip's waterline", pt["tip"][1], (front[:, 1].min() + front[:, 1].max()) / 2, 0.5, "WL in")
			yield result("layout.pitot", f"{name} tube's buttline", pt["buttline"], np.abs((front[:, 2].min() + front[:, 2].max()) / 2), 0.3, "BL in")
			yield result("layout.pitot", f"{name} strut's aft root", pt["root"][1], p[:, 0].max(), 0.5, "FS in")
			yield result("fittings.pitot", f"{name} forward end", cited["from"], p[:, 0].min(), 1.0, "FS in")
			yield result("fittings.pitot", f"{name} aft end", cited["to"], p[:, 0].max(), 1.0, "FS in")
		# the fairings on each side: tm101724's ECM covers and the photos' antenna fairings
		ecm, blisters = F["fittings"]["ecm"], F["layout"]["blisters"]
		for name in ("fairings_left", "fairings_right"):
			p = jet.points([name])
			cover = p[(p[:, 0] > ecm["station"] - ecm["length"]) & (p[:, 0] < ecm["station"] + ecm["length"] * 0.6)]
			yield result("fittings.ecm", f"{name} ECM cover's middle", ecm["station"], (cover[:, 0].min() + cover[:, 0].max()) / 2, 0.5, "FS in")
			yield result("fittings.ecm", f"{name} ECM cover's length", ecm["length"], cover[:, 0].max() - cover[:, 0].min(), 0.6)
			cut = jet.cut([name], [ecm["station"], 100, 0], [1, 0, 0])
			top = cut[np.argmax(np.abs(cut[:, 2]))]
			body = jet.cut(["fuselage"], [ecm["station"], 100, 0], [1, 0, 0])
			side = body[np.sign(body[:, 2]) == np.sign(top[2])]
			skin = np.abs(side[np.argmin(np.abs(side[:, 1] - top[1])), 2])
			yield result("fittings.ecm", f"{name} ECM cover standing off the skin", ecm["proud"], abs(top[2]) - skin, 0.3)
			for key, spec in blisters.items():
				if not isinstance(spec, list):
					continue
				first, last, wl, width, proud = spec
				q = p[(p[:, 0] > first - 1) & (p[:, 0] < last + 1) & (np.abs(p[:, 1] - wl) < width)]
				yield result("layout.blisters", f"{name} {key} fairing's forward end", first, q[:, 0].min(), 0.5, "FS in")
				yield result("layout.blisters", f"{name} {key} fairing's aft end", last, q[:, 0].max(), 0.5, "FS in")
				yield result("layout.blisters", f"{name} {key} fairing's middle", wl, (q[:, 1].min() + q[:, 1].max()) / 2, 0.7, "WL in")
		# the formation light strips
		f = F["layout"]["formation"]
		for name in ("formation_left", "formation_right"):
			p = jet.points([name])
			yield result("layout.formation", f"{name} forward end", f["from"], p[:, 0].min(), 0.5, "FS in")
			yield result("layout.formation", f"{name} aft end", f["to"], p[:, 0].max(), 0.5, "FS in")
			yield result("layout.formation", f"{name} middle", f["waterline"], (p[:, 1].min() + p[:, 1].max()) / 2, 0.5, "WL in")
			yield result("layout.formation", f"{name} height", f["height"], p[:, 1].max() - p[:, 1].min(), 0.4)
		# the simple cockpit, placed by what the reference photo shows through the canopy
		ck = F["layout"]["cockpit"]
		seat = jet.points(["cockpit_seat"])
		head = seat[seat[:, 1] > ck["headbox"][3][1] + 0.5]
		yield result("layout.cockpit", "seat's headbox top", max(p[1] for p in ck["headbox"]), seat[:, 1].max(), 0.3, "WL in")
		yield result("layout.cockpit", "seat's headbox front", min(p[0] for p in ck["headbox"]), head[:, 0].min(), 0.4, "FS in")
		yield result("layout.cockpit", "seat's headbox aft", max(p[0] for p in ck["headbox"]), head[:, 0].max(), 0.4, "FS in")
		pilot = jet.points(["pilot"])
		helmet = pilot[pilot[:, 1] > ck["helmet"]["bottom"] + 1.0]
		yield result("layout.cockpit", "helmet's top", ck["helmet"]["top"], pilot[:, 1].max(), 0.3, "WL in")
		yield result("layout.cockpit", "helmet's front", ck["helmet"]["front"], helmet[:, 0].min(), 0.5, "FS in")
		yield result("layout.cockpit", "helmet's back", ck["helmet"]["back"], helmet[:, 0].max(), 0.5, "FS in")
		hud = jet.points(["cockpit_hud"])
		yield result("layout.cockpit", "HUD frame's top", ck["hud"][1][1], hud[:, 1].max(), 0.5, "WL in")
		yield result("layout.cockpit", "HUD frame's foot", ck["hud"][0][0], hud[:, 0].min(), 0.5, "FS in")
		posts = np.abs(hud[:, 2])
		yield result("layout.cockpit", "HUD frame's posts off the centreline", ck["widths"]["hud"], float(posts[posts > ck["widths"]["hud"] / 2].mean()), 0.3, "BL in")
		top = seat[seat[:, 1] > min(p[1] for p in ck["headbox"][1:3]) - 1.0]
		yield result("layout.cockpit", "seat's headbox top, either side", ck["widths"]["headbox"], float(np.abs(top[:, 2]).max()), 0.3, "BL in")
		panel = jet.points(["cockpit_panel"])
		hood = panel[panel[:, 1] > ck["glareshield"][1] + 0.2]   # the glareshield, above the panel that meets it
		yield result("layout.cockpit", "glareshield's aft edge", ck["glareshield"][0], hood[:, 0].max(), 0.3, "FS in")
		# the cockpit lies under the canopy: nothing of it stands outside the fuselage's and canopy's sections
		inside = 0.0
		for s in np.arange(236.0, 300.0, 2.0):
			hull = jet.cut(["fuselage", "canopy"], [s, 100, 0], [1, 0, 0])
			parts = jet.cut(["cockpit_tub", "cockpit_panel", "cockpit_seat", "pilot"], [s, 100, 0], [1, 0, 0])
			if not len(hull) or not len(parts):
				continue
			for wl, bl in parts[:, 1:]:
				# the hull's half-width at this waterline, from the cut's segments' points nearest it above and below
				side = hull[np.sign(hull[:, 2]) == (np.sign(bl) or 1)]
				above, below = side[side[:, 1] >= wl], side[side[:, 1] < wl]
				if wl > hull[:, 1].max():
					inside = max(inside, wl - hull[:, 1].max())
					continue
				if not len(above) or not len(below):
					continue
				a = above[np.argmin(above[:, 1] - wl)]
				b = below[np.argmin(wl - below[:, 1])]
				f = (wl - b[1]) / ((a[1] - b[1]) or 1)
				inside = max(inside, abs(bl) - abs(b[2] + (a[2] - b[2]) * f))
		yield result("layout.cockpit", "cockpit standing outside the fuselage and canopy", 0.0, max(0.0, inside), 0.05)
		# the formation strips on the fins' and nacelles' faces (layout.strips)
		# and the lenses on the fins, the LEX's edges and the right fin's pod
		# (layout.lights): each flush on the built face where the photos put it,
		# so a buttline off the photos' is the face's, not the strip's
		st, lamps = F["layout"]["strips"], F["layout"]["lights"]["points"]
		for side, sign in (("left", -1), ("right", 1)):
			for key in ("fin", "body"):
				p = jet.points([f"formation_{key}_{side}"])
				ends = np.array(st[key], float) * [1, 1, sign]
				middle = ends.mean(axis=0)
				axis = (ends[1] - ends[0]) / np.linalg.norm(ends[1] - ends[0])
				centre = (p.min(axis=0) + p.max(axis=0)) / 2
				# along the face where the photos put it; the face itself (the
				# buttline) within the rays' own misses, up to 2.1 in
				for i, word, tolerance in ((0, "FS", 0.8), (1, "WL", 0.8), (2, "BL", 2.0)):
					yield result("layout.strips", f"{key} strip's middle on the {side}" + (", the face it stands on" if word == "BL" else ""), middle[i], centre[i], tolerance, f"{word} in")
				along = (p - middle) @ axis
				yield result("layout.strips", f"{key} strip's length on the {side}", float(np.linalg.norm(ends[1] - ends[0])), float(along.max() - along.min()), 0.8, "in")
			# the strobes on the fins' faces (the buttline the face's), the position
			# lights under the LEX's edges (the waterline the face's)
			# and the position lights on the underwing fairings' noses, cast aft
			# and up onto them (both the station and the height the nose's)
			for key, faces in ((f"strobe_{side}", (2,)), (f"position_lex_{side}", (1,)), (f"position_fold_{side}", (0, 1))):
				p = jet.points([f"lamp_{key}"])
				centre = (p.min(axis=0) + p.max(axis=0)) / 2
				at = np.array(lamps[key]["at"], float)
				for i, word in enumerate(("FS", "WL", "BL")):
					yield result("layout.strips", f"{key} lens" + (", the face it stands on" if i in faces else ""), at[i], centre[i], 2.0 if i in faces else 0.8, f"{word} in")
		# the fairings under the outer panels (layout.wing_fairing): their tips,
		# their buttline and width at the widest, their depth under the wing
		# ahead of the aileron's hinge
		uw = F["layout"]["wing_fairing"]
		body, tail = jet.points(["fairing_wing_right"]), jet.points(["fairing_aileron_right"])
		yield result("layout.wing_fairing", "front tip", uw["front"][0], body[:, 0].min(), 1.0, "FS in")
		yield result("layout.wing_fairing", "aft tip", uw["aft"][0], tail[:, 0].max(), 1.0, "FS in")
		middle = (uw["front"][0] + uw["aft"][0]) / 2
		c = jet.cut(["fairing_wing_right", "fairing_aileron_right"], [middle, 0, 0], [1, 0, 0])
		if not len(c):
			raise KeyError(f"no underwing fairing at FS {middle}")
		yield result("layout.wing_fairing", "width at its middle", uw["width"], c[:, 2].max() - c[:, 2].min(), 0.5, "in")
		yield result("layout.wing_fairing", "buttline at its middle", (uw["front"][2] + uw["aft"][2]) / 2, (c[:, 2].max() + c[:, 2].min()) / 2, 0.5, "BL in")
		station = uw["front"][0] + uw["nose"] + 4.0
		c, wing = jet.cut(["fairing_wing_right"], [station, 0, 0], [1, 0, 0]), jet.cut(["wing_outer_right", "flap_leading_outer_right"], [station, 0, 0], [1, 0, 0])
		across = (uw["front"][2] + uw["aft"][2]) / 2
		a_, b_ = wing[0::2], wing[1::2]
		hit = (a_[:, 2] - across) * (b_[:, 2] - across) < 0
		if not len(c) or not hit.any():
			raise KeyError(f"no underwing fairing or wing at FS {station}")
		t = (across - a_[hit, 2]) / (b_[hit, 2] - a_[hit, 2])
		lower = float((a_[hit, 1] + (b_[hit, 1] - a_[hit, 1]) * t).min())
		yield result("layout.wing_fairing", f"depth under the wing at FS {station:g}", uw["depth"], lower - c[:, 1].min(), 1.0, "in")
		p = jet.points(["lamp_position_tail"])
		centre = (p.min(axis=0) + p.max(axis=0)) / 2
		yield result("layout.strips", "tail light's lens, on its pod's end, off where the photos put the light", 0.0, float(np.linalg.norm(centre - np.array(lamps["position_tail"]["at"], float))), 1.5, "in")
		# the spine's antennas and the small ones under the radome
		an = F["layout"]["antennas"]
		for key in ("dorsal", "spine"):
			p = jet.points([f"antenna_{key}"])
			corners = an[key]
			yield result("layout.antennas", f"{key} blade's tip", max(w for _, w in corners), p[:, 1].max(), 0.3, "WL in")
			tip = p[p[:, 1] > p[:, 1].max() - 0.3]
			yield result("layout.antennas", f"{key} blade's tip front", corners[3][0], tip[:, 0].min(), 0.4, "FS in")
			yield result("layout.antennas", f"{key} blade's tip aft", corners[2][0], tip[:, 0].max(), 0.4, "FS in")
			yield result("layout.antennas", f"{key} blade on the centreline", 0.0, (p[:, 2].min() + p[:, 2].max()) / 2, 0.1, "BL in")
		# the blade under the forward fuselage, off the centreline
		p = jet.points(["antenna_ventral"])
		corners = an["ventral"]
		yield result("layout.antennas", "ventral blade's tip", min(c[1] for c in corners), p[:, 1].min(), 0.3, "WL in")
		# the tip's edge slopes 0.3 in, and the slab stands 0.4 in through
		tip = p[p[:, 1] < max(c[1] for c in corners[2:]) + 0.2]
		yield result("layout.antennas", "ventral blade's tip front", corners[3][0], tip[:, 0].min(), 0.4, "FS in")
		yield result("layout.antennas", "ventral blade's tip aft", corners[2][0], tip[:, 0].max(), 0.4, "FS in")
		yield result("layout.antennas", "ventral blade's tip off the centreline", (corners[2][2] + corners[3][2]) / 2, float(tip[:, 2].mean()), 0.4, "BL in")
		base = p[p[:, 1] > p[:, 1].max() - 1.3]
		yield result("layout.antennas", "ventral blade's base off the centreline", (corners[0][2] + corners[1][2]) / 2, float(base[:, 2].mean()), 0.4, "BL in")
		dome = jet.points(["antenna_dome"])
		station, waterline, buttline, diameter, proud = an["dome"]
		yield result("layout.antennas", "dome's middle", station, (dome[:, 0].min() + dome[:, 0].max()) / 2, 0.5, "FS in")
		yield result("layout.antennas", "dome's side", buttline, (dome[:, 2].min() + dome[:, 2].max()) / 2, 1.0, "BL in")
		chin = jet.points(["antenna_chin"])
		yield result("layout.antennas", "chin fairing and posts' forward end", an["chin"][0], chin[:, 0].min(), 0.5, "FS in")
		yield result("layout.antennas", "comb's aft post", an["comb"][-1] + 0.3, chin[:, 0].max(), 0.5, "FS in")
		# the antenna pods on the fins' trailing edges, each read within its own
		# band of waterlines (an empty band reads as a miss)
		for name in ("pod_left", "pod_right"):
			every = jet.points([name])
			for k, (start, end, waterline, diameter) in enumerate(F["layout"]["pods"]["list"]):
				p = every[np.abs(every[:, 1] - waterline) < diameter / 2 + 0.3]
				if not len(p):
					yield result("layout.pods", f"{name} {k}: its points", 1.0, 0.0, 0.5, "found")
					continue
				yield result("layout.pods", f"{name} {k}: front", start, p[:, 0].min(), 0.5, "FS in")
				yield result("layout.pods", f"{name} {k}: aft end", end, p[:, 0].max(), 0.5, "FS in")
				yield result("layout.pods", f"{name} {k}: middle", waterline, (p[:, 1].min() + p[:, 1].max()) / 2, 0.5, "WL in")
				yield result("layout.pods", f"{name} {k}: diameter", diameter, p[:, 1].max() - p[:, 1].min(), 0.3)
				# it straddles the fin at its middle; its blunt end stands at or past the trailing edge
				fin = jet.cut([name.replace("pod", "fin")], [(start + end) / 2, 100, 0], [1, 0, 0])
				sides = [a[2] + (b[2] - a[2]) * (waterline - a[1]) / (b[1] - a[1]) for a, b in fin.reshape(-1, 2, 3) if (a[1] - waterline) * (b[1] - waterline) <= 0 and a[1] != b[1]]
				yield result("layout.pods", f"{name} {k}: on its fin", (min(sides) + max(sides)) / 2 if sides else np.inf,
					(p[:, 2].min() + p[:, 2].max()) / 2, 0.5, "BL in")
		# the blade antenna under the nose
		b = F["layout"]["blade"]
		p = jet.points(["blade_nose"])
		bottom = p[p[:, 1] < p[:, 1].min() + 0.5]
		yield result("layout.blade", "nose blade's bottom edge", b["bottom"][2], p[:, 1].min(), 0.3, "WL in")
		yield result("layout.blade", "nose blade's bottom front corner", b["bottom"][0], bottom[:, 0].min(), 0.5, "FS in")
		yield result("layout.blade", "nose blade's bottom aft corner", b["bottom"][1], bottom[:, 0].max(), 0.5, "FS in")
		yield result("layout.blade", "nose blade on the centreline", 0.0, (p[:, 2].min() + p[:, 2].max()) / 2, 0.1, "BL in")
		hook = F["layout"]["hook"]
		h = jet.points(["hook"])
		yield result("layout.hook", "stowed hook's aftmost point, the shoe's tip", hook["point"][0], h[:, 0].max(), 0.5, "FS in")
		# the photo marks the middle of the shoe's end face: the mean of the four
		# corners furthest along the shank from the pivot
		pivot = np.array(jet.hinge("hook"))
		corners = np.unique(np.round(h, 4), axis=0)
		axis = (np.array(hook["point"]) - pivot[:2]) / np.linalg.norm(np.array(hook["point"]) - pivot[:2])
		face = corners[np.argsort((corners[:, :2] - pivot[:2]) @ axis)[-4:]]
		yield result("layout.hook", "stowed hook's tip height, its end face's middle", hook["point"][1], float(face[:, 1].mean()), 1.0, "WL in")
		yield result("layout.hook", "hook's pivot station", hook["pivot"][0], pivot[0], 0.1, "FS in")
		yield result("layout.hook", "hook's pivot height", hook["pivot"][1], pivot[1], 0.1, "WL in")
		yield result("layout.hook", "hook's length, pivot to tip", hook["length"], float(np.hypot(*(np.array(hook["point"]) - pivot[:2]))), 0.3, "in")
		# lowered, the shoe's lowest point in the direction the photos put it
		# from the pivot (its distance, 2.9 in past the stowed tip's, unsettled)
		down_hook = jet.points(["hook"], {"hook": 1})
		low = down_hook[np.argmin(down_hook[:, 1])]
		want = math.degrees(math.atan2(pivot[1] - hook["lowered"][1], hook["lowered"][0] - pivot[0]))
		yield result("layout.hook", "lowered hook's lowest point below the pivot's horizontal, aft", want, math.degrees(math.atan2(pivot[1] - low[1], low[0] - pivot[0])), 1.0, "deg")
		# the keel: its bottom on the photos' line, its aft end at the pivot,
		# its forward end where it leaves the body
		keel = F["layout"]["keel"]
		k = jet.points(["keel"])
		for station, waterline in keel["bottom"]:
			near = k[np.abs(k[:, 0] - station) < 2.0]
			yield result("layout.keel", f"keel's bottom at FS {station}", waterline, float(near[:, 1].min()) if len(near) else 999.0, 0.5, "WL in")
		blade = k[k[:, 1] < 90]
		# its aft end along its bottom, below the pivot fitting that closes it
		fitting = F["layout"]["hook"]["pivot"][1] - F["layout"]["hook"]["fitting"]["radius"]
		bottom = k[k[:, 1] < fitting - 0.3]
		yield result("layout.keel", "keel's aft end, along its bottom below the pivot fitting", keel["stations"][1], float(bottom[:, 0].max()) if len(bottom) else 0.0, 1.0, "FS in")
		# measured just forward of the pivot fitting, against the taper's width there
		front, back = keel["stations"]
		at = back - F["layout"]["hook"]["fitting"]["radius"] - 2.0
		near = blade[np.abs(blade[:, 0] - at) < 1.5]
		yield result("layout.keel", f"keel's width at FS {at:.0f}, tapering to its front", keel["width"] * (at - front) / (back - front), float(np.ptp(near[:, 2])) if len(near) else 0.0, 0.6, "in")

	yield from guard("fittings", "fittings", fittings)

	# Layout placements the build should land on
	L = F["layout"]

	def placements():
		gear = L["gear"]
		for name, station, tyre in (("gear_right_wheel", gear["main"], "main"), ("gear_nose_wheel", gear["nose"], "nose")):
			p = jet.points([name], down)
			yield result("layout.gear", f"{name} axle", station, (p[:, 0].max() + p[:, 0].min()) / 2, 0.5, "FS in")
			yield result("layout.gear", f"{name} diameter", gear["tyres"][tyre]["diameter"], p[:, 1].max() - p[:, 1].min(), 0.3)
		p = jet.points(["gear_right_wheel"], down)
		yield result("layout.gear", "main wheels' track", gear["track"], p[:, 2].max() + p[:, 2].min(), 0.5)
		# the nose pair's outer sidewalls, less one tyre's width: the centres' spacing
		p = jet.points(["gear_nose_wheel"], down)
		yield result("layout.gear", "nose wheels' spacing", gear["spacing"], p[:, 2].max() - p[:, 2].min() - gear["tyres"]["nose"]["width"], 0.3)
		# the legs where the photos put them, gear down (layout.gear legs)
		legs, axes = gear["legs"], (("FS", 0), ("WL", 1), ("BL", 2))
		m = legs["main"]
		for side in ("left", "right"):
			# where the post crosses the photos' top's waterline (it runs on up
			# inside the airframe to its retraction pivot), the arm's pivot end
			# (its foremost ring), the side brace's top (its innermost ring)
			ring = jet.cut([f"gear_{side}_strut"], [0, m["top"][1], 0], [0, 1, 0], down)
			if not len(ring):
				raise KeyError(f"no {side} main post at WL {m['top'][1]}")
			top = ring.mean(0)
			arm = np.unique(jet.points([f"gear_{side}_oleo"], down), axis=0)
			pivot = arm[np.argsort(arm[:, 0])[:12]].mean(0)
			brace = np.unique(jet.points([f"gear_{side}_brace"], down), axis=0)
			brace = brace[np.argsort(np.abs(brace[:, 2]))[:12]].mean(0)
			for label, want, got, axes_ in (("post at the photos' top", m["top"], top, (("FS", 0), ("BL", 2))), ("arm's pivot end", m["pivot"], pivot, axes),
					("side brace's top", m["brace"][0], brace, axes)):
				for unit, i in axes_:
					yield result("layout.gear", f"{side} main {label}", want[i], abs(got[i]) if i == 2 else got[i], 1.0, f"{unit} in")
		n = legs["nose"]
		oleo = np.unique(jet.points(["gear_nose_oleo"], down), axis=0)
		top = oleo[np.argsort(oleo[:, 1])[-12:]].mean(0)
		yield result("layout.gear", "nose piston's top", n["oleo"][0], top[0], 0.5, "FS in")
		yield result("layout.gear", "nose piston's top", n["oleo"][1], top[1], 0.5, "WL in")
		bar = np.unique(jet.points(["launch_bar"], down), axis=0)
		tip = bar[np.argsort(bar[:, 0])[:8]].mean(0)
		yield result("layout.gear", "launch bar's raised tip", n["bar"]["tip"][0], tip[0], 1.0, "FS in")
		yield result("layout.gear", "launch bar's raised tip", n["bar"]["tip"][1], tip[1], 1.0, "WL in")
		# the strut's lamps, gear down (layout.lights gear): the landing lamp's
		# lens (its front, its middle, its size) and the approach lights' three
		# lenses (the middle one's place, their spacing)
		lit, spots = np.unique(jet.points(["lamp_gear_nose"], down), axis=0), F["layout"]["lights"]
		landing = np.array(spots["points"]["landing"]["at"], float)
		near = lit[np.linalg.norm(lit - landing, axis=1) < 4.0]
		if not len(near):
			raise KeyError("no landing lens near the landing light's point")
		yield result("layout.lights", "landing lamp's lens front", landing[0], near[:, 0].min(), 0.8, "FS in")
		for i, unit in ((1, "WL"), (2, "BL")):
			yield result("layout.lights", "landing lamp's lens middle", landing[i], (near[:, i].min() + near[:, i].max()) / 2, 0.8, f"{unit} in")
		yield result("layout.lights", "landing lamp's lens across", spots["gear"]["landing"]["diameter"] - 0.6, near[:, 1].max() - near[:, 1].min(), 0.5, "in")
		approach = np.array(spots["points"]["approach"]["at"], float)
		spacing = spots["gear"]["approach"]["spacing"]
		middles = []
		for k in (1, 0, -1):
			lens = lit[np.linalg.norm(lit - (approach + [0, k * spacing, 0]), axis=1) < 0.9]
			if not len(lens):
				raise KeyError(f"no approach lens {k:+d} from the amber one")
			middles.append((lens.min(axis=0) + lens.max(axis=0)) / 2)
		for i, unit in enumerate(("FS", "WL", "BL")):
			yield result("layout.lights", "approach lights' amber lens", approach[i], middles[1][i], 0.8, f"{unit} in")
		yield result("layout.lights", "approach lights' lenses apart, green to red", 2 * spacing, middles[0][1] - middles[2][1], 0.3, "in")
		brace = np.unique(jet.points(["gear_nose_brace"], down), axis=0)
		if not len(brace):
			raise KeyError("no nose drag brace with the gear down")
		pin = brace[np.argsort(brace[:, 1])[:12]].mean(0)
		yield result("layout.gear", "nose drag brace's pin", n["brace"][0], pin[0], 1.0, "FS in")
		yield result("layout.gear", "nose drag brace's pin", n["brace"][1], pin[1], 1.0, "WL in")
		# each door open as the photos show it: its lowest point
		doors = gear["doors"]
		def skin(station, height):
			# the fuselage's outboard buttline at a height, on the right
			c = jet.cut(["fuselage"], [station, 0, 0], [1, 0, 0])
			a_, b_ = c[0::2], c[1::2]
			hit = ((a_[:, 1] - height) * (b_[:, 1] - height) < 0) & (np.maximum(a_[:, 2], b_[:, 2]) > 0)
			if not hit.any():
				raise KeyError(f"no fuselage at FS {station}, WL {height}")
			t = (height - a_[hit, 1]) / (b_[hit, 1] - a_[hit, 1])
			return float((a_[hit, 2] + (b_[hit, 2] - a_[hit, 2]) * t).max())

		# the forward doors open, their tops where they hinge, at the marks' heights
		fwd = doors["forward"]
		q = jet.points(["gear_nose_door_right"], down)
		for (station, _), height in zip(fwd["hinge"], fwd["height"]):
			near = q[np.abs(q[:, 0] - station) < 2.0]
			if not len(near):
				raise KeyError(f"no gear_nose_door_right near FS {station}")
			yield result("layout.gear", f"gear_nose_door_right open, its top at FS {station:g}", height, near[:, 1].max(), 1.0, "WL in")
		# each nose door's free edge, open: the middle of its two ends (a rigid
		# door hinged on the build's skin leans 2-2.5 in otherwise than the
		# photos' at one end of the forward and long doors, the skin's slope at
		# the bay's edges: #71)
		for key, names in (("forward", ["gear_nose_door_right", "gear_nose_door_left"]), ("long", ["gear_nose_door_long"]), ("aft", ["gear_nose_door_aft"])):
			for name in names:
				q = jet.points([name], down)
				ends = []
				for fs, wl, bl in doors[key]["edge"]:
					near = q[np.abs(q[:, 0] - fs) < 2.0]
					if not len(near):
						raise KeyError(f"no {name} near FS {fs}")
					ends.append(near[np.argmin(near[:, 1])])
				got, want = np.mean(ends, axis=0), np.mean(np.array(doors[key]["edge"], float), axis=0)
				if "height" in doors[key]:
					# the forward doors' marks are their open outer faces: their
					# hinges stand on the skin at the marks' heights, and the free
					# edge comes in by as much
					want[2] -= float(np.mean([b - skin(f, h) for (f, b), h in zip(doors[key]["hinge"], doors[key]["height"])]))
				yield result("layout.gear", f"{name} open, its free edge's middle", want[1], got[1], 1.5, "WL in")
				yield result("layout.gear", f"{name} open, its free edge's middle", want[2], abs(got[2]), 1.5, "BL in")
		# the main doors hang plumb under their hinges, the outer as tall as the
		# photos show it (their hinges' height is the nacelle's: the build's
		# skin there stands higher than the photos' doors, a finding)
		for side in ("left", "right"):
			q = jet.points([f"gear_door_inner_{side}"], down)
			lowest = q[np.argmin(q[:, 1])]
			yield result("layout.gear", f"{side} inner main door open, its lowest point", doors["inner"]["low"][0], lowest[0], 1.5, "FS in")
			yield result("layout.gear", f"{side} inner main door open, hanging under its hinge", doors["inner"]["hinge"][2], abs(lowest[2]), 1.5, "BL in")
			q = jet.points([f"gear_door_outer_{side}"], down)
			front = q[q[:, 0] < q[:, 0].min() + 1.0]
			yield result("layout.gear", f"{side} outer main door open, hanging under its hinge", doors["outer"]["hinge"][2], float(np.abs(front[np.argmin(front[:, 1])][2])), 1.5, "BL in")
			yield result("layout.gear", f"{side} outer main door open, its front edge's height", doors["outer"]["front"][0][1] - doors["outer"]["front"][1][1],
				float(front[:, 1].max() - front[:, 1].min()), 1.5, "in")
		c = L["canopy"]
		for k, (st, wl, bl) in enumerate(c["sill"]):
			sill = jet.cut(["canopy"], [st, 100, 0], [1, 0, 0])
			low = sill[sill[:, 2] > 0]
			yield result("layout.canopy", f"canopy's sill at FS {st}", wl, low[:, 1].min() if len(low) else np.inf, 1.0, "WL in")
		# the glass's section: its half-width halfway from the sill to the top, against the fitted superellipse,
		# near each end of the canopy (the exponent runs from one at the bow's foot to the other at the aft
		# corner), aft where the glass alone still makes the section: behind FS 290 the fairing's shoulders
		# rise beside it (flared())
		for st in (250.0, 290.0):
			b = np.interp(st, [p[0] for p in c["sill"]], [p[2] for p in c["sill"]])
			w = np.interp(st, [p[0] for p in c["sill"]], [p[1] for p in c["sill"]])
			glass = jet.cut(["canopy"], [st, 100, 0], [1, 0, 0])
			halfway = w + (glass[:, 1].max() - w) / 2
			near = glass[np.abs(glass[:, 1] - halfway) < 0.4]
			n = np.interp(st, [c["sill"][0][0], c["sill"][-1][0]], c["glass"])
			yield result("layout.canopy", f"glass's half-width halfway up at FS {st:.0f}", b * (1 - 0.5 ** n) ** (1 / n),
				np.abs(near[:, 2]).max() if len(near) else np.inf, 0.3, "BL in")
		# the glass's lower edge, where the metal panel below it meets it, read off two left-side photos
		glass = jet.model.parts(verify.pose(jet.joints, {}), materials=("glass",)).get("canopy", np.zeros((0, 3, 3)))
		crown = lambda st: float(np.interp(st, [p[0] for p in L["spine"]["crown"]], [p[1] for p in L["spine"]["crown"]]))
		for st, wl in c["glass_edge"]:
			across = FRAME.source(verify.cut(glass, FRAME.model([st, 100, 0]), FRAME.axes @ np.array([1.0, 0, 0])).reshape(-1, 3)) if len(glass) else np.zeros((0, 3))
			left = across[across[:, 2] < 0]
			yield result("layout.canopy", f"glass's lower edge at FS {st:g}, left", wl, left[:, 1].min() if len(left) else np.inf, 0.75, "WL in")
		# the bow and the aft edge lean: the glass's lowest stretch starts at the bow's foot and ends at the aft corner
		whole = jet.points(["canopy"])
		foot = whole[whole[:, 1] < c["bow"]["foot"] + 1.0]
		yield result("layout.canopy", "canopy's lowest front (the bow's foot)", c["sill"][0][0], foot[:, 0].min() if len(foot) else np.inf, 0.6, "FS in")
		corner = whole[whole[:, 1] < c["sill"][-1][1] + 1.0]
		yield result("layout.canopy", "canopy's lowest aft (the aft corner)", c["sill"][-1][0], corner[:, 0].max() if len(corner) else np.inf, 0.6, "FS in")
		# no ledge under the sill: the body an inch below it stands within an inch of the sill's buttline
		ledge = 0.0
		for st in (250.0, 280.0, 310.0):
			b = np.interp(st, [p[0] for p in c["sill"]], [p[2] for p in c["sill"]])
			w = np.interp(st, [p[0] for p in c["sill"]], [p[1] for p in c["sill"]])
			body = jet.cut(["fuselage"], [st, 100, 0], [1, 0, 0])
			level = body[np.abs(body[:, 1] - (w - 1.0)) < 0.4]
			if len(level):
				ledge = max(ledge, np.abs(level[:, 2]).max() - b)
		yield result("layout.canopy", "body standing out an inch under the sill", 0.0, max(0.0, ledge), 1.0)
		# the top line behind the crown, as the profiles show it
		for st, wl in c["top"]:
			cut = jet.cut(["canopy"], [st, 100, 0], [1, 0, 0])
			yield result("layout.canopy", f"canopy's top at FS {st:.0f}", wl, cut[:, 1].max() if len(cut) else np.inf, 0.3, "WL in")
		# the canopy's top falling to the photos' height over the crown at its
		# aft end and the spine flat behind it (layout.canopy tail, the sky
		# check's side photos)
		whole = np.concatenate([jet.points(["fuselage"]).reshape(-1, 3, 3), jet.points(["canopy"]).reshape(-1, 3, 3)])
		for offset in (0.0, 4.0, 8.0):
			st = c["aft"]["station"] + offset
			top = lines(whole, "above", np.array([st - 0.01, st, st + 0.01]), np.array([0.0, 0.01]))[0][1]
			yield result("layout.canopy", f"canopy's top {offset:g} in aft of its aft end, above the crown (the photos' sky check)", c["tail"]["height"], top - crown(st), 0.3, "WL in")
		hood = jet.cut(["canopy"], [c["crown"]["station"], 100, 0], [1, 0, 0])
		yield result("layout.canopy", "canopy crown", c["crown"]["waterline"], hood[:, 1].max(), 0.4, "WL in")
		whole = jet.points(["canopy"])
		yield result("layout.canopy", "canopy's aft end", c["aft"]["station"], whole[:, 0].max(), 0.6, "FS in")
		# the windscreen's glass reaches its frame along the sides at the base
		# line, from the front base down to the bow's foot (a wide U in plan)
		front, bow = c["windscreen"]["station"], c["bow"]["station"]
		glass = jet.points(["windscreen"])
		for station in (front + 8, (front + bow) / 2, bow - 6):
			base = c["windscreen"]["waterline"] + (c["bow"]["foot"] - c["windscreen"]["waterline"]) * (station - front) / (bow - front)
			# within 3 in: the rings near the bow lean with it, their columns moved along
			near = glass[np.abs(glass[:, 0] - station) < 3.0]
			yield result("layout.canopy", f"windscreen glass's lowest at FS {station:.0f}, on its base line", base, float(near[:, 1].min()) if len(near) else 999.0, 1.0, "WL in")
		# the windscreen's section above its frame sill (screen): its half-width
		# halfway from the sill to the top against the fitted superellipse, where
		# its exponent is held (FS 198) and rising to the canopy's (FS 220)
		sill = c["screen"] + c["sill"]
		for st in (198.0, 220.0):
			b = np.interp(st, [p[0] for p in sill], [p[2] for p in sill])
			w = np.interp(st, [p[0] for p in sill], [p[1] for p in sill])
			cut = jet.cut(["fuselage", "windscreen"], [st, 100, 0], [1, 0, 0])
			halfway = w + (cut[:, 1].max() - w) / 2 if len(cut) else 0.0
			# where the section's segments cross the halfway height (none: a failure)
			crossings = [a[2] + (b_[2] - a[2]) * (halfway - a[1]) / (b_[1] - a[1]) for a, b_ in cut.reshape(-1, 2, 3) if (a[1] - halfway) * (b_[1] - halfway) <= 0 and a[1] != b_[1]]
			n = np.interp(st, [c["screen_glass"][0], c["sill"][0][0], c["sill"][-1][0]], [c["screen_glass"][1], c["glass"][0], c["glass"][1]])
			yield result("layout.canopy", f"windscreen's half-width halfway up at FS {st:.0f}", b * (1 - 0.5 ** n) ** (1 / n),
				max(np.abs(crossings)) if crossings else np.inf, 0.3, "BL in")
		screen = jet.points(["windscreen"])
		yield result("layout.canopy", "windscreen's front base", c["windscreen"]["station"], screen[:, 0].min(), 0.6, "FS in")
		bow = jet.cut(["canopy", "windscreen"], [c["bow"]["station"], 100, 0], [1, 0, 0])
		yield result("layout.canopy", "bow's top", c["bow"]["waterline"], bow[:, 1].max(), 0.4, "WL in")
		yield result("layout.surfaces", "inboard leading-edge flap's outer end", L["surfaces"]["lef"]["inner"][1],
			jet.points(["flap_leading_inner_right"])[:, 2].max(), 0.5, "BL in")
		yield result("layout.surfaces", "aileron's outer end", L["surfaces"]["aileron"][1], jet.points(["aileron_right"])[:, 2].max(), 0.5, "BL in")
		yield result("layout.surfaces", "aileron's inner end", L["surfaces"]["aileron"][0], jet.points(["aileron_right"])[:, 2].min(), 0.5, "BL in")
		yield result("layout.surfaces", "trailing-edge flap's outer end", L["surfaces"]["tef"][1], jet.points(["flap_trailing_right"])[:, 2].max(), 0.5, "BL in")
		# where the aileron runs inboard of the fold line, the inner panel stops
		# at its hinge: nothing of it lies behind the aileron's leading edge there
		between = (L["surfaces"]["aileron"][0] + value(F["wing"]["fold"])) / 2
		inner = jet.cut(["wing_inner_right"], [0, 0, between], [0, 0, 1])
		hinge = jet.cut(["aileron_right"], [0, 0, between], [0, 0, 1])
		yield result("layout.surfaces", f"inner panel's aft edge at BL {between:.1f}, at the aileron's leading edge", float(hinge[:, 0].min()) if len(hinge) else 999.0,
			float(inner[:, 0].max()) if len(inner) else -999.0, 0.3, "FS in")

	yield from guard("layout", "placements", placements)

	# The whole shape's own rules, which no fact states (shape.*): stowed parts
	# and the cockpit lie inside the airframe at rest, flush panels lie on the
	# skin 0.15 in proud with none of it poking through, each left part is its
	# right twin's mirror image, and every other part but the one-sided is
	# symmetric about the centreline
	def shapes():
		hull = jet.points(HULL).reshape(-1, 3, 3)
		for name in STOWED:
			corners = np.unique(jet.points([name]), axis=0)
			yield result("shape.stowed", f"{name}'s corners outside the airframe at rest", 0, (~enclosed(corners, hull)).sum(), 0, "corners")
		skin = jet.points(["fuselage"]).reshape(-1, 3, 3)
		# each fin, with its rudder's lower end, stands on the skin all along
		# its root: no daylight under it (the user saw the background through
		# a 5.2 in gap there)
		place, chord = F["layout"]["fin"]["root"], value(F["fin"]["root"])
		for side in ("left", "right"):
			part = jet.points([f"fin_{side}", f"rudder_{side}", f"fin_root_{side}"]).reshape(-1, 3, 3)
			gap = seated(part, skin, np.arange(place["station"] + 1.0, place["station"] + chord - 1.0, 2.0))
			yield result("shape.seated", f"fin_{side}'s root standing off the skin beneath it, its furthest", 0.0, float(np.maximum(gap, 0.0)), 0.05)
		for name, below in FLUSH:
			s = standoff(jet.points([name]).reshape(-1, 3, 3), skin, below)
			yield result("shape.flush", f"{name}'s outer face off the skin, its furthest from 0.15 in", 0.15, s[np.argmax(np.abs(s - 0.15))] if len(s) else np.inf, 0.15)
		for spot in F["layout"]["hardpoints"]["stations"]:
			if spot["kind"] != "fuselage":
				continue
			mount = FRAME.source(jet.document["points"]["hardpoints"][str(spot["number"])]["mount"])
			# the section's segments that cross the station's buttline, where they cross it
			a, b = jet.cut(["fuselage", "inlet_left", "inlet_right"], [spot["station"], 100, 0], [1, 0, 0]).reshape(-1, 2, 3).transpose(1, 0, 2)
			bl = spot["buttline"]
			across = (a[:, 2] - bl) * (b[:, 2] - bl) <= 0
			f = (bl - a[across, 2]) / np.where(b[across, 2] != a[across, 2], b[across, 2] - a[across, 2], 1)
			skin = a[across, 1] + f * (b[across, 1] - a[across, 1])
			if not len(skin):
				raise KeyError(f"no skin below station {spot['number']}")
			yield result("shape.mount", f"station {spot['number']}'s mount off the skin below it", 0.0, float(mount[1] - skin.min()), 0.1)
		# The skin turns sharply only at its real edges: a crease anywhere else is
		# the build joining its sources with straight runs or reading a traced
		# line pixel by pixel. Left out: the nose ahead of FS 95, the windscreen
		# and canopy (on the lines that meet them: from above, and from the side
		# down to 9 in under the sill, where the section is drawn in to it), the
		# inlets from their lips to 12 in behind where their skins hand over to
		# the fuselage (a blend between two shapes, held by shape.joint and
		# layout.nacelle instead), the gear doors' aft step (held by
		# layout.nacelle) and the nozzles
		skin = jet.points(["fuselage", "canopy", "windscreen", "inlet_left", "inlet_right"]).reshape(-1, 3, 3)
		stations = np.arange(95.0, 661.0, 1.0)
		cp = F["layout"]["canopy"]
		lip = min(p[0] for p in F["layout"]["inlet"]["lip"].values())
		join = float(jet.points(["inlet_right"])[:, 0].max())

		def clear(*windows):
			keep = np.ones(len(stations), bool)
			for a, b in windows:
				keep &= ~((stations >= a) & (stations <= b))
			return keep

		# the canopy's top meets the spine's flat top at its aft end at the corner
		# the profiles show there (layout.canopy tail): an edge by design; so is
		# the step up at the aft end of the main gear doors' blister under each
		# nacelle (layout.nacelle door), seen from below and below the sill
		glass, inlet = (cp["windscreen"]["station"] - 14, cp["aft"]["station"] + 4), (lip - 8, join + 12)
		door = F["layout"]["nacelle"]["door"]
		blister = (door[-2][0] - 4, door[-1][0] + 8)
		side = np.arange(88.0, 148.0, 2.0)
		sill = min(p[1] for p in cp["sill"]) - 9
		# Each view's tolerance lies between the fixed build's worst (2.5, 2.9
		# and 2.8 deg: the tunnel's bump at FS 475 and the radome's junction at
		# FS 129 are smooth turns of the shape) and the loft's rings spread out
		# as they were: 20 in apart behind the canopy (3.2 above), 7-8 in over
		# the nose (3.2 outboard)
		for view, across, step, free, tolerance in (("above", np.arange(0.0, 16.0, 1.5), 1.5, clear(glass), 2.8), ("below", np.arange(0.0, 37.0, 1.5), 1.5, clear(inlet, blister), 3.5),
				("outboard", side, 2.0, np.array([clear(glass, inlet) if wl >= sill else clear(inlet, blister) for wl in side]), 3.0)):
			found = bends(lines(skin, view, stations, across), step, free)
			if not found:
				raise KeyError(f"no skin measured seen from {view}")
			yield result("shape.bend", f"skin's sharpest crease seen from {view}, away from its edges", 0.0, max(abs(f[3]) for f in found), tolerance, "deg")
		# the skin's waves on the same lines, from above out to the spine's
		# shoulder: a dip between humps or a hump between dips within 80 in,
		# which no crease check sees (the user saw a 0.4-0.8 in dip then hump
		# behind the canopy three times, where the forebody's sections were
		# blended into the rear fuselage and fitted to the side seam point by
		# point; the smooth loft behind the canopy carries none)
		for view, across, free in (("above", np.arange(0.0, 22.0, 1.5), clear(glass)), ("below", np.arange(0.0, 37.0, 1.5), clear(inlet, blister)),
				("outboard", side, np.array([clear(glass, inlet) if wl >= sill else clear(inlet, blister) for wl in side]))):
			H = lines(skin, view, stations, across)
			if not np.isfinite(H).any():
				raise KeyError(f"no skin measured seen from {view}")
			found = waves(H, stations, free, step=float(across[1] - across[0]))
			worst = max(found, key=lambda f: f[3], default=None)
			where = f" (at FS {worst[1]:g}, {'BL' if view != 'outboard' else 'WL'} {across[worst[0]]:g})" if worst else ""
			yield result("shape.wave", f"skin's largest dip then hump seen from {view}{where}", 0.0, worst[3] if worst else 0.0, 0.15)
		# the LEX's upper surface and its fairing, which eases it down behind the
		# junction onto the nacelle's shoulder: beside the body's wall (where the
		# root meets it) to inside the wing's root, and short of its square aft end
		top = jet.points(["lex_right", "fuselage", "inlet_right", "wing_inner_right"]).reshape(-1, 3, 3)
		end = float(jet.points(["lex_right"])[:, 0].max())
		# (the fixed build's worst 4.5 deg, where it lands on the skin; 11.5 when
		# it dived to the nacelle's top at JOIN and rose again, 6.9 settling twice).
		# No step on it is an edge: one that stood level and dropped onto the
		# skin at JOIN read as two surfaces meeting
		found = bends(lines(top, "above", stations, np.arange(26.5, 36.0, 1.5)), 1.5, clear(glass, (end - 6, stations[-1])), jump=None)
		yield result("shape.bend", "LEX's and its fairing's sharpest crease seen from above", 0.0, max((abs(f[3]) for f in found), default=np.inf), 5.0, "deg")
		# the belly from the nose to the inlets, where a traced line's pixel
		# steps would lie as ledges, spread over inches rather than creased
		found = bends(lines(skin, "below", stations, np.arange(0.0, 12.0, 1.5)), 1.5, clear(inlet) & (stations < lip - 8))
		yield result("shape.bend", "belly's sharpest bend between the nose and the inlets", 0.0, max((abs(f[2]) for f in found), default=np.inf), 2.8, "deg")
		# the deck between the fins falls aft with no hump: along its lines outboard
		# of the ridge, the most it rises going aft over FS 520-660 (the user saw a
		# 2.1 in hump at FS 592 behind a dip, the body fitted through the
		# speedbrake's edges; 0.2 in on the old deck)
		run = np.arange(520.0, 661.0, 2.0)
		H = lines(jet.points(["fuselage"]).reshape(-1, 3, 3), "above", run, np.arange(13.0, 24.1, 1.0))
		rise = max((float(np.nanmax(h[i:]) - h[i]) for h in H for i in range(len(h)) if np.isfinite(h[i])), default=np.inf)
		yield result("shape.deck", "deck between the fins: the most it rises going aft, BL 13-24", 0.0, rise, 1.2)
		sb = F["layout"]["speedbrake"]
		# the speedbrake's place: its front, back and side edges
		brake = jet.points(["speedbrake"])
		yield result("layout.speedbrake", "speedbrake's forward edge", sb["front"], brake[:, 0].min(), 0.5, "FS in")
		yield result("layout.speedbrake", "speedbrake's aft edge", sb["back"], brake[:, 0].max(), 0.5, "FS in")
		yield result("layout.speedbrake", "speedbrake's half-width", sb["half"], np.abs(brake[:, 2]).max(), 0.3, "BL in")
		# the canopy's aft end, which the crease checks leave out as an edge: its
		# fairing lifts the canopy's section onto the spine's within inches, but
		# turns no sharper than a fillet would (the fitted 11 deg an inch; 67
		# where the spine stood up to 2 in proud of the canopy within an inch)
		aft = cp["aft"]["station"]
		near = np.arange(aft - 8, aft + 17, 1.0)
		H = lines(jet.points(["fuselage", "canopy"]).reshape(-1, 3, 3), "above", near, np.arange(2.0, 16.01, 2.0))
		turns = np.degrees(np.arctan(H[:, 2:] - H[:, 1:-1]) - np.arctan(H[:, 1:-1] - H[:, :-2]))
		yield result("shape.bend", "skin's sharpest turn across the canopy's aft end seen from above, an inch either side", 0.0,
			float(np.nanmax(np.abs(turns))) if np.isfinite(turns).any() else np.inf, 20.0, "deg")
		# where each inlet's outer skin hands over to the fuselage: the part of the
		# fuselage's section that the nacelle adds stands nowhere outside the
		# inlet's last ring (its jump from the body to the nacelle, just ahead,
		# would show beside the ring). Added: outside the section 4.5 in ahead,
		# and away from it (the spine narrowing there moves its points inside)
		end = jet.points(["inlet_right"])
		ring = np.unique(end[end[:, 0] > join - 0.02][:, [2, 1]].round(4), axis=0)
		middle = ring.mean(0)
		ring = ring[np.argsort(np.arctan2(ring[:, 1] - middle[1], ring[:, 0] - middle[0]))]
		behind = jet.cut(["fuselage"], [join + 0.1, 100, 0], [1, 0, 0])[:, [2, 1]]
		ahead = jet.cut(["fuselage"], [join - 4.5, 100, 0], [1, 0, 0])[:, [2, 1]].reshape(-1, 2, 2)
		added = [q for q in behind if q[0] > 0 and segment_distance(q, ahead) > 0.5 and not inside_segments(q, ahead)]
		if not added:
			raise KeyError("the fuselage adds no nacelle where the inlet ends")
		outside = [segment_distance(q, np.stack([ring, np.roll(ring, -1, axis=0)], 1)) for q in added if not inside_polygon(q, ring)]
		yield result("shape.joint", "fuselage standing out of an inlet's end where it hands over", 0.0, max(outside, default=0.0), 0.1)
		every = jet.points(sorted(jet.parts())).reshape(-1, 3, 3)
		for first, second in SEAMS:
			for side in ("left", "right"):
				a, b = (jet.points([n if n == "fuselage" else f"{n}_{side}"]).reshape(-1, 3, 3) for n in (first, second))
				mirror = np.array([1.0, 1.0, -1.0 if side == "left" else 1.0])
				worst = max(((seam(a * mirror, b * mirror, every * mirror, view), view) for view in ("above", "below", "outboard")))
				yield result("shape.seam", f"{first}_{side} and {second} crossing back and forth, worst seen from {worst[1]}", 0, worst[0], 3.0, "sq in")
		for drives, pose in (({}, "at rest"), (down, "gear down")):
			parts = jet.parts(drives)
			# the side is a segment of the name, last (aileron_left) or not (gear_left_wheel)
			for left in sorted(n for n in parts if "left" in n.split("_") and not n.startswith("nozzle_")):
				right = "_".join("right" if s == "left" else s for s in left.split("_"))
				if right in parts:
					yield result("shape.mirror", f"{left} against {right}, {pose}", 0, mirrored(jet.points([left], drives), jet.points([right], drives)), 0.1)
			# the nozzles whole: their flaps' stepped tabs turn the same way on
			# both engines (one engine, fitted either side: usaf120811FON144293
			# from below shows both staircases running the same way), so a
			# flap is no mirror of its twin, but the ring of them is, but for
			# the tabs' turn
			flaps = {side: sorted(n for n in parts if n.startswith(f"nozzle_{side}_petal_")) for side in ("left", "right")}
			if flaps["left"] and flaps["right"]:
				yield result("shape.mirror", f"left nozzle's flaps against the right's, {pose}", 0, mirrored(jet.points(flaps["left"], drives), jet.points(flaps["right"], drives)), 0.3)
			for name in sorted(n for n in parts if not {"left", "right"} & set(n.split("_")) and n not in ONE_SIDED):
				p = jet.points([name], drives)
				yield result("shape.mirror", f"{name} about the centreline, {pose}", 0, mirrored(p, p), 0.1)

	yield from guard("shape", "shapes", shapes)

	# The paint, on a painted build (a draft carries no atlas: main() says so)
	image = atlas(jet.path)
	if image is None:
		return

	def paint():
		tris, uvs = jet.textured()
		size = image.shape[0]
		# no texel lies under two painted faces: islands laid over each other
		# let the bake write one over the other (the LEX's root over the warning
		# box's corner, while its island took in faces turned away from it; 225
		# texels where smart_project folded faces over others)
		count = coverage(uvs, size)
		yield result("paint.overlap", "atlas texels two painted faces both lie on", 0, int((count >= 2).sum()), 0, "texels")
		normals = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
		area = np.linalg.norm(normals, axis=1)
		normals = normals / np.maximum(area, 1e-12)[:, None]
		e1, e2 = uvs[:, 1] - uvs[:, 0], uvs[:, 2] - uvs[:, 0]
		texel = np.sqrt(area / 2 / np.maximum(np.abs(e1[:, 0] * e2[:, 1] - e1[:, 1] * e2[:, 0]) / 2 * size * size, 1e-12))
		centres = tris.mean(1)

		def read(points, normal, near):
			# the atlas's brightness where each point, moved out along the normal
			# and cast back, meets the near triangles; NaN for a miss
			k, bary = hits(tris[near], points + 2.0 * normal, -normal)
			out = np.full(len(points), np.nan)
			hit = k >= 0
			if hit.any():
				i = np.where(near)[0][k[hit]]
				u, v = bary[hit].T
				uv = uvs[i, 0] * (1 - u - v)[:, None] + uvs[i, 1] * u[:, None] + uvs[i, 2] * v[:, None]
				out[hit] = sample(image, uv)
			return out

		# each stencil drawn on skin dense enough for its lettering (each
		# stencil's own island), and whole: its ink just inside its edges dark
		# against the paint beside it (a plane leaning off the skin left the
		# warning box's top and bottom undrawn)
		for key, spec in F["layout"]["stencils"].items():
			if not isinstance(spec, dict):
				continue
			(fs, wl), (length, height) = spec["at"], spec["size"]
			for side in (1, -1):
				name = "right" if side > 0 else "left"
				box = (np.abs(centres[:, 0] - fs) < length / 2) & (np.abs(centres[:, 1] - wl) < height / 2) & (centres[:, 2] * side > 0)
				if not box.any():
					raise KeyError(f"no painted skin under the {key} stencil, {name}")
				outer = box & (centres[:, 2] * side > (centres[box, 2] * side).max() - 2.0)
				yield result("layout.stencils", f"{key} stencil's skin, {name}: its coarsest texel", 0.0, float(texel[outer].max()), 0.15)
				k, bary = hits(tris, np.array([[fs, wl, side * 80.0]]), np.array([0.0, 0.0, -side]))
				if k[0] < 0:
					raise KeyError(f"no skin at the {key} stencil's middle, {name}")
				centre = tris[k[0], 0] + (tris[k[0], 1] - tris[k[0], 0]) * bary[0, 0] + (tris[k[0], 2] - tris[k[0], 0]) * bary[0, 1]
				normal = normals[k[0]] * np.sign(normals[k[0], 2] * side)
				up = np.array([0.0, 1.0, 0.0]) - normal * normal[1]
				up /= np.linalg.norm(up)
				across = np.cross(up, normal)
				corners = [(-0.5, 0.5), (0.5, 0.5), (0.5, -0.5), (-0.5, -0.5)] if spec["kind"] == "box" else [(-0.5, 0.5), (0.0, -0.5), (0.5, 0.5)]
				inset = 0.2
				edges = list(zip(corners, corners[1:] + corners[:1])) if spec["kind"] == "box" else list(zip(corners, corners[1:]))
				inner, outside = [], []
				middle = np.mean(corners, 0)
				for a, b in edges:
					a, b = np.array(a) * (length, height), np.array(b) * (length, height)
					inward = (middle * (length, height) - (a + b) / 2)
					inward /= np.linalg.norm(inward)
					for f in np.linspace(0.05, 0.95, 24):
						q = a + (b - a) * f
						inner.append(q + inward * inset)
						outside.append(q - inward * 1.0)
				near = (np.abs(centres - centre) < max(length, height)).all(1)
				place = lambda qs: centre + np.array(qs)[:, :1] * across + np.array(qs)[:, 1:] * up
				ink, paint_ = read(place(inner), normal, near), read(place(outside), normal, near)
				ok = np.isfinite(ink)
				if not ok.any() or not np.isfinite(paint_).any():
					raise ValueError(f"the {key} stencil's edges are off the painted skin, {name}")
				dark = float(np.mean(ink[ok] < 0.75 * np.nanmedian(paint_)))
				yield result("layout.stencils", f"{key} stencil's edges inked, {name}: their share", 1.0, dark, 0.05, "share")

		# the panel lines read along their whole length: each half inch of a line
		# darker than the skin an inch either side (a line narrower than two
		# texels, each texel wholly on it or off it by its centre, broke into dots)
		p = F["layout"]["panels"]
		every_line = [np.array(l, float) for l in p["lines"] + p["mirrored"]] + [np.array(l, float) * [1, 1, -1] for l in p["mirrored"]]
		for station in p.get("rings", []):
			segments = verify.cut(tris, [station, 100, 0], [1, 0, 0])
			if not len(segments):
				raise KeyError(f"no painted skin at the ring at FS {station}")
			every_line += [s for s in segments]
		gaps, total = 0, 0
		for line in every_line:
			points = np.concatenate([np.linspace(q, r, max(2, int(np.ceil(np.linalg.norm(r - q) / 0.5)) + 1))[:-1] for q, r in zip(line, line[1:])] + [line[-1:]])
			if len(points) < 3:
				continue
			low, high = points.min(0) - 3, points.max(0) + 3
			near = ((tris.min(1) <= high) & (tris.max(1) >= low)).all(1)
			if not near.any():
				raise KeyError("no painted skin near a panel line")
			for i in range(1, len(points) - 1):
				q = points[i]
				j = np.where(near)[0][np.argmin(np.linalg.norm(centres[near] - q, axis=1))]
				n = normals[j]
				along = points[i + 1] - points[i - 1]
				beside = np.cross(n, along)
				if np.linalg.norm(beside) < 1e-9:
					continue
				beside /= np.linalg.norm(beside)
				line_, left, right = read(np.array([q, q + 1.0 * beside, q - 1.0 * beside]), n, near)
				reference = np.nanmax([left, right]) if np.isfinite([left, right]).any() else np.nan
				if np.isfinite(line_) and np.isfinite(reference):
					total += 1
					gaps += line_ > 0.95 * reference
		if not total:
			raise ValueError("no panel line read off the paint")
		yield result("layout.panels", "panel lines' share of their length no darker than the skin beside them", 0.0, gaps / total, 0.05, "share")

		# the LEX's root slot dark along its length against the LEX's top 4 in
		# outboard of it (layout.lex slot)
		slot = F["layout"]["lex"]["slot"]
		for side, name in ((1, "right"), (-1, "left")):
			ends = np.array([slot["front"], slot["aft"]], float) * [1, 1, side]
			low, high = ends.min(0) - 6, ends.max(0) + 6
			near = ((tris.min(1) <= high) & (tris.max(1) >= low)).all(1)
			if not near.any():
				raise KeyError(f"no painted skin near the {name} LEX's slot")
			ratios = []
			for t in np.linspace(0.1, 0.9, 9):
				q = ends[0] + (ends[1] - ends[0]) * t
				inside, outside = read(np.array([q, q + [0, 0, 4.0 * side]]), np.array([0.0, 1.0, 0.0]), near)
				if np.isfinite(inside) and np.isfinite(outside):
					ratios.append(inside / outside)
			if not ratios:
				raise ValueError(f"the {name} LEX's slot is off the painted skin")
			yield result("layout.lex", f"{name} LEX's slot's paint against the LEX beside it, the lightest", slot["shade"], max(ratios), 0.2, "share")

	yield from guard("paint", "paint", paint)


def main():
	jet = Jet(sys.argv[1], sys.argv[2])
	results = list(checks(jet))
	covered = {r["fact"] for r in results}
	# a draft's paint is unbaked: what only the paint shows goes unchecked, and says so
	if atlas(sys.argv[1]) is None:
		covered |= PAINTED
	unaccounted = [e for e in entries(FACTS) if e not in covered and e not in EXEMPT]
	stale = [e for e in EXEMPT if e not in entries(FACTS)]
	failures = [r for r in results if failed(r)]
	if "--json" in sys.argv:
		print(json.dumps({"results": results, "unaccounted": unaccounted, "stale": stale, "exempt": EXEMPT}, indent="\t"))
	else:
		for r in results:
			if "missing" in r:
				print(f"MISSING  {r['fact']:28s} {r['what']}: {r['missing']}")
				continue
			miss = r["measured"] - r["expected"]
			flag = "FAIL" if abs(miss) > r["tolerance"] else "ok"
			print(f"{flag:8s} {r['fact']:28s} {r['what']:58s} {r['expected']:9.2f} {r['measured']:9.2f} {miss:+8.2f} (±{r['tolerance']}) {r['unit']}")
		for e in unaccounted:
			print(f"UNCHECKED {e}: facts.json entry with no check and no exemption")
		for e in stale:
			print(f"STALE    {e}: exempted but no longer in facts.json")
		if atlas(sys.argv[1]) is None:
			print("PAINT    unchecked: the model carries no atlas (a draft)")
		print(f"{len(results)} measurements, {len(failures)} outside tolerance; {len(EXEMPT)} entries exempt; {len(unaccounted)} unaccounted")
	sys.exit(1 if failures or unaccounted or stale else 0)


if __name__ == "__main__":
	main()
