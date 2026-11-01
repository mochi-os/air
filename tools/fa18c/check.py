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
	"overall.exhaust": "the HARV's exhaust plane (tm101724) and the wind-tunnel model's (tp3478); the production nozzle's exit lip stands 7 in further aft in the photos (layout.nozzle, checked there)",
	"canopy": "the two-seat canopy's differences; this is the single-seat jet",
	"gravity@HARV phase 1, 60% fuel, clean, gear up": "a centre of gravity, not a shape",
	"gravity@HARV phases 2-3, 60% fuel, clean, gear up": "a centre of gravity, not a shape",
	"gravity@HARV simulation": "a centre of gravity, not a shape",
	"gravity@F-18B SRA, 66% fuel, clean, gear up": "a centre of gravity, not a shape",
	"layout.eye": "the design eye is a point the build writes as given",
	"layout.hardpoints": "store mounts the build writes as given, the fuselage ones draped onto the skin (shape.mount); step 5 checks them against the stores",
	"layout.lights": "light points the build writes as given",
	"layout.paint": "colours the paint bake writes into the atlas, not a shape (looked at on the comparison sheets)",
	"layout.stencils": "stencils the paint bake draws into the atlas, not a shape",
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
	"launch_bar", "ladder", "probe", "cockpit_tub", "cockpit_panel", "cockpit_seat", "cockpit_stick", "cockpit_hud", "pilot"]
FLUSH = [("speedbrake", False), ("gear_nose_door_left", True), ("gear_nose_door_right", True), ("probe_door", False)]
# The parts with no twin that stand to one side; every other one is
# symmetric about the centreline
ONE_SIDED = {"antenna_dome", "ladder", "pilot", "probe", "probe_door"}


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
	# cliff reads as the bend it is). Returns [(line, station, bend, crease)]
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


def mirrored(left, right):
	# How far a left part's bounds (points, source coordinates) miss its right
	# twin's, reflected across the centreline
	right = right * np.array([1.0, 1.0, -1.0])
	return float(max(np.abs(left.min(0) - right.min(0)).max(), np.abs(left.max(0) - right.max(0)).max()))


def checks(jet):
	# Yields {"fact", "what", "expected", "measured", "tolerance", "unit"} or {"fact", "what", "missing"}
	F = FACTS

	def result(fact, what, expected, measured, tolerance, unit="in"):
		return {"fact": fact, "what": what, "expected": round(float(expected), 3), "measured": round(float(measured), 3),
			"tolerance": tolerance, "unit": unit}

	def guard(fact, what, fn):
		try:
			return list(fn())
		except KeyError as e:
			return [{"fact": fact, "what": what, "missing": str(e).strip("'\"")}]

	apex = value(F["nose"]["apex"])
	down = {"gear": 1}
	every = list(jet.parts())

	# Overall
	def overall():
		p = jet.points(every)
		yield result("overall.length", "nose apex to the aftmost point", value(F["overall"]["length"]) * 12, p[:, 0].max() - p[:, 0].min(), 1.0)
		w = jet.points([n.format(s=s) for n in WING for s in ("left", "right")])
		yield result("overall.span.spread", "wingtip to wingtip", value(F["overall"]["span"]["spread"]) * 12, w[:, 2].max() - w[:, 2].min(), 1.0)
		folded = jet.points([n for n in every if not n.startswith("gear")], {"fold": 1})
		yield result("overall.span.folded", "span with the wings folded", value(F["overall"]["span"]["folded"]) * 12, folded[:, 2].max() - folded[:, 2].min(), 1.5)
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
		lip = nozzles[nozzles[:, 0] > nozzles[:, 0].max() - 0.5]
		yield result("layout.nozzle", "nozzle exit's lower lip", F["layout"]["nozzle"]["waterline"] - F["layout"]["nozzle"]["radius"][1], lip[:, 1].min(), 0.5, "WL in")
		# the burner's glowing faces sit inside the nozzles, short of the exit
		burner = jet.points(["burner_left", "burner_right"])
		yield result("layout.nozzle", "burner's faces short of the nozzles' exit", 0.0, max(0.0, burner[:, 0].max() - F["layout"]["nozzle"]["exit"] + 1.0), 0.01, "FS in")
		yield result("layout.nozzle", "burner inside the nozzle's exit", 0.0, max(0.0, F["layout"]["nozzle"]["waterline"] - F["layout"]["nozzle"]["radius"][1] - burner[:, 1].min()), 0.01, "WL in")
		# the outer flaps: twelve a side, each closing on the drive by the throat's travel, the burner as wide as the open throat
		petals = F["layout"]["petals"]
		for side in ("left", "right"):
			yield result("layout.petals", f"{side} nozzle's outer flaps", petals["count"], sum(n.startswith(f"nozzle_{side}_petal_") for n in flaps), 0, "flaps")
		bottom = f"nozzle_right_petal_{petals['count'] // 2 + 1}"
		def lip(drives):
			# the flap's aft end, its lowest point
			p = jet.points([bottom], drives)
			return p[p[:, 0] > p[:, 0].max() - 0.5][:, 1].min()

		yield result("layout.petals", "bottom flap's exit lip rising as the nozzle closes", petals["travel"], lip({"nozzle": 1}) - lip({}), 0.05)
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
		# hinged surfaces: planform areas, both sides
		areas = value(w["areas"])
		for fact_key, nodes in (("aileron", ["aileron_{s}"]), ("lef", ["flap_leading_inner_{s}", "flap_leading_outer_{s}"]), ("tef", ["flap_trailing_{s}"])):
			total = sum(verify.area(jet.tris([n.format(s=s)]), FRAME.axes @ [0, 1, 0]) / 2 for n in nodes for s in ("left", "right")) / 0.0254 ** 2 / 144
			yield result("wing.areas", f"{fact_key} area, both sides", areas[fact_key], total, areas[fact_key] * 0.03, "ft2")
		inner_area = verify.area(jet.tris(["flap_leading_inner_right"]), FRAME.axes @ [0, 1, 0]) / 2 / 0.0254 ** 2 / 144
		yield result("wing.lef", "each inboard leading-edge flap's share of the total", value(w["lef"]), inner_area / areas["lef"], 0.01, "of total")

	yield from guard("wing", "wing", wing)

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
		samples = {}
		for f in (0.03, 0.5, 0.97):
			b = inner + exposed * f
			q = jet.cut(["stabilator_right"], [600, 100, b], [0, 0, 1])
			samples[f] = q
			chord = q[:, 0].max() - q[:, 0].min()
			yield result("stabilator.root" if f < 0.5 else "stabilator.tip", f"chord {f:.0%} out", rc + (tc - rc) * f, chord, 0.6)
		aspect = (value(s_["exposed"]) * 12) ** 2 / (value(s_["area"]) * 144)
		lsweep = leading_sweep(value(s_["sweep"]), aspect, tc / rc)
		a, b = samples[0.03], samples[0.97]
		slope = (b[:, 0].min() - a[:, 0].min()) / (exposed * 0.94)
		yield result("stabilator.sweep", "leading-edge sweep (from the quarter-chord's)", lsweep, math.degrees(math.atan(slope)), 0.3, "deg")
		fa, fb = a[np.argmin(a[:, 0])], b[np.argmin(b[:, 0])]
		yield result("stabilator.dihedral", "leading edge's slope", value(s_["dihedral"]), math.degrees(math.atan((fb[1] - fa[1]) / (fb[2] - fa[2]))), 0.2, "deg")
		area = sum(verify.area(jet.tris([f"stabilator_{s}"]), FRAME.axes @ [0, 1, 0]) / 2 for s in ("left", "right")) / 0.0254 ** 2 / 144
		yield result("stabilator.area", "exposed area, both sides", value(s_["area"]), area, 2.0, "ft2")
		for f, key in ((0.03, "root"), (0.97, "tip")):
			q = samples[f]
			chord = q[:, 0].max() - q[:, 0].min()
			yield result("stabilator.airfoil", f"{key} thickness", value(s_["airfoil"])[key], 100 * (q[:, 1].max() - q[:, 1].min()) / chord, 0.4, "% chord")
		place = F["layout"]["stabilator"]
		front = a[:, 0].min() - (b[:, 0].min() - a[:, 0].min()) * 0.03 / 0.94
		yield result("layout.stabilator", "exposed root's leading edge", place["value"], front, 1.5, "FS in")
		yield result("layout.stabilator", "exposed root", place["buttline"], inner, 0.5, "BL in")
		yield result("layout.stabilator", "exposed root's leading edge height", place["waterline"], fa[1] - 0.03 * (fb[1] - fa[1]) / 0.94, 0.3, "WL in")

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
		for side in ("left", "right"):
			misses = [bottom(s, side) - keel[s] for s in range(int(low), int(high) + 1, 8)]
			yield result("layout.nacelle", f"{side} nacelle's bottom off the HATP keel line, FS {low}-{high}, worst", 0.0, max(misses, key=abs), 1.0)
			for s in (650, 666, 685):
				yield result("layout.nacelle", f"{side} nacelle's bottom at FS {s}", float(np.interp(s, [k[0] for k in aft], [k[1] for k in aft])), bottom(s, side), 1.0, "WL in")
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
		for station, waterline in sp["deck"]:
			yield result("layout.spine", f"deck beside the spine at FS {station:g} (dvids9820788)", waterline, at("above", station, 24.0), 1.0, "WL in")

	yield from guard("layout.spine", "spine", spine)

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
		dome = jet.points(["antenna_dome"])
		station, waterline, buttline, diameter, proud = an["dome"]
		yield result("layout.antennas", "dome's middle", station, (dome[:, 0].min() + dome[:, 0].max()) / 2, 0.5, "FS in")
		yield result("layout.antennas", "dome's side", buttline, (dome[:, 2].min() + dome[:, 2].max()) / 2, 1.0, "BL in")
		chin = jet.points(["antenna_chin"])
		yield result("layout.antennas", "chin fairing and posts' forward end", an["chin"][0], chin[:, 0].min(), 0.5, "FS in")
		yield result("layout.antennas", "comb's aft post", an["comb"][-1] + 0.3, chin[:, 0].max(), 0.5, "FS in")
		# the antenna pods on the fins' trailing edges
		pd = F["layout"]["pod"]
		for name in ("pod_left", "pod_right"):
			p = jet.points([name])
			yield result("layout.pod", f"{name} front", pd["from"], p[:, 0].min(), 0.5, "FS in")
			yield result("layout.pod", f"{name} aft end", pd["to"], p[:, 0].max(), 0.5, "FS in")
			yield result("layout.pod", f"{name} middle", pd["waterline"], (p[:, 1].min() + p[:, 1].max()) / 2, 0.5, "WL in")
			yield result("layout.pod", f"{name} diameter", pd["diameter"], p[:, 1].max() - p[:, 1].min(), 0.3)
			# the pod straddles the fin at its middle; its blunt end stands past the trailing edge
			fin = jet.cut([name.replace("pod", "fin")], [(pd["from"] + pd["to"]) / 2, 100, 0], [1, 0, 0])
			level = fin[np.abs(fin[:, 1] - pd["waterline"]) < 1.0]
			yield result("layout.pod", f"{name} on its fin", (level[:, 2].min() + level[:, 2].max()) / 2 if len(level) else np.inf,
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
		c = L["canopy"]
		for k, (st, wl, bl) in enumerate(c["sill"]):
			sill = jet.cut(["canopy"], [st, 100, 0], [1, 0, 0])
			low = sill[sill[:, 2] > 0]
			yield result("layout.canopy", f"canopy's sill at FS {st}", wl, low[:, 1].min(), 1.0, "WL in") if len(low) else None
		# the glass's section: its half-width halfway from the sill to the top, against the fitted superellipse,
		# near each end of the canopy (the exponent runs from one at the bow's foot to the other at the aft corner)
		for st in (250.0, 310.0):
			b = np.interp(st, [p[0] for p in c["sill"]], [p[2] for p in c["sill"]])
			w = np.interp(st, [p[0] for p in c["sill"]], [p[1] for p in c["sill"]])
			glass = jet.cut(["canopy"], [st, 100, 0], [1, 0, 0])
			halfway = w + (glass[:, 1].max() - w) / 2
			near = glass[np.abs(glass[:, 1] - halfway) < 0.4]
			n = np.interp(st, [c["sill"][0][0], c["sill"][-1][0]], c["glass"])
			yield result("layout.canopy", f"glass's half-width halfway up at FS {st:.0f}", b * (1 - 0.5 ** n) ** (1 / n),
				np.abs(near[:, 2]).max(), 0.3, "BL in") if len(near) else None
		# the bow and the aft edge lean: the glass's lowest stretch starts at the bow's foot and ends at the aft corner
		whole = jet.points(["canopy"])
		foot = whole[whole[:, 1] < c["bow"]["foot"] + 1.0]
		yield result("layout.canopy", "canopy's lowest front (the bow's foot)", c["sill"][0][0], foot[:, 0].min(), 0.6, "FS in") if len(foot) else None
		corner = whole[whole[:, 1] < c["sill"][-1][1] + 1.0]
		yield result("layout.canopy", "canopy's lowest aft (the aft corner)", c["sill"][-1][0], corner[:, 0].max(), 0.6, "FS in") if len(corner) else None
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
			yield result("layout.canopy", f"canopy's top at FS {st:.0f}", wl, cut[:, 1].max(), 0.3, "WL in") if len(cut) else None
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
		# layout.nacelle instead), and the nozzles
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

		glass, inlet = (cp["windscreen"]["station"] - 14, cp["aft"]["station"] + 4), (lip - 8, join + 12)
		side = np.arange(88.0, 148.0, 2.0)
		sill = min(p[1] for p in cp["sill"]) - 9
		# Each view's tolerance lies between the fixed build's worst (2.5, 2.9
		# and 2.8 deg: the tunnel's bump at FS 475 and the radome's junction at
		# FS 129 are smooth turns of the shape) and the loft's rings spread out
		# as they were: 20 in apart behind the canopy (3.2 above), 7-8 in over
		# the nose (3.2 outboard)
		for view, across, step, free, tolerance in (("above", np.arange(0.0, 16.0, 1.5), 1.5, clear(glass), 2.8), ("below", np.arange(0.0, 37.0, 1.5), 1.5, clear(inlet), 3.5),
				("outboard", side, 2.0, np.array([clear(glass, inlet) if wl >= sill else clear(inlet) for wl in side]), 3.0)):
			found = bends(lines(skin, view, stations, across), step, free)
			if not found:
				raise KeyError(f"no skin measured seen from {view}")
			yield result("shape.bend", f"skin's sharpest crease seen from {view}, away from its edges", 0.0, max(abs(f[3]) for f in found), tolerance, "deg")
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
			for left in sorted(n for n in parts if "left" in n.split("_")):
				right = "_".join("right" if s == "left" else s for s in left.split("_"))
				if right in parts:
					yield result("shape.mirror", f"{left} against {right}, {pose}", 0, mirrored(jet.points([left], drives), jet.points([right], drives)), 0.1)
			for name in sorted(n for n in parts if not {"left", "right"} & set(n.split("_")) and n not in ONE_SIDED):
				p = jet.points([name], drives)
				yield result("shape.mirror", f"{name} about the centreline, {pose}", 0, mirrored(p, p), 0.1)

	yield from guard("shape", "shapes", shapes)


def main():
	jet = Jet(sys.argv[1], sys.argv[2])
	results = list(checks(jet))
	covered = {r["fact"] for r in results}
	unaccounted = [e for e in entries(FACTS) if e not in covered and e not in EXEMPT]
	stale = [e for e in EXEMPT if e not in entries(FACTS)]
	failures = [r for r in results if "missing" in r or abs(r["measured"] - r["expected"]) > r["tolerance"]]
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
		print(f"{len(results)} measurements, {len(failures)} outside tolerance; {len(EXEMPT)} entries exempt; {len(unaccounted)} unaccounted")
	sys.exit(1 if failures or unaccounted or stale else 0)


if __name__ == "__main__":
	main()
