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
	"fittings.pitot": "not built yet: the two pitot-static probes",
	"fittings.probe": "the research jet's probe doors (FS 128.5 to 188); the reference airframe's door is shorter (layout.probe, checked there)",
	"fittings.ecm": "not built yet: the research jet's ECM covers, to confirm on the reference airframe",
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
	"wing.incidence": "no twist is published; checked as a flat chord plane through wing.dihedral",
	"wing.chord": "checked through reference.chord",
	"engine.thrust": "where the flight model applies thrust, not a shape",
	"overall.exhaust": "the HARV's exhaust plane (tm101724) and the wind-tunnel model's (tp3478); the production nozzle's exit lip stands 7 in further aft in the photos (layout.nozzle, checked there)",
	"canopy": "the two-seat canopy's differences; this is the single-seat jet",
	"gravity@HARV phase 1, 60% fuel, clean, gear up": "a centre of gravity, not a shape",
	"gravity@HARV phases 2-3, 60% fuel, clean, gear up": "a centre of gravity, not a shape",
	"gravity@HARV simulation": "a centre of gravity, not a shape",
	"gravity@F-18B SRA, 66% fuel, clean, gear up": "a centre of gravity, not a shape",
	"layout.eye": "the design eye is a point the build writes as given",
	"layout.hardpoints": "store mounts the build writes as given (step 5 checks them against the stores)",
	"layout.lights": "light points the build writes as given",
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


def heights(tris, stations, buttlines):
	# A top-down height map: the highest waterline of the triangles (source
	# coordinates, (N, 3, 3)) over each (buttline, station) cell, NaN where none
	H = np.full((len(buttlines), len(stations)), np.nan)
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
		H[j0 : j1 + 1, i0 : i1 + 1] = np.where(inside & ~(sub >= h), h, sub)
	return H


def shoelace(loop):
	# a closed 2D loop's area
	x, y = loop[:, 0], loop[:, 1]
	return abs((x[:-1] * y[1:] - x[1:] * y[:-1]).sum()) / 2


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
		nozzles = jet.points(["nozzle_left", "nozzle_right"])
		yield result("layout.nozzle", "nozzles' exit", F["layout"]["nozzle"]["exit"], nozzles[:, 0].max(), 0.5, "FS in")
		lip = nozzles[nozzles[:, 0] > nozzles[:, 0].max() - 0.5]
		yield result("layout.nozzle", "nozzle exit's lower lip", F["layout"]["nozzle"]["waterline"] - F["layout"]["nozzle"]["radius"][1], lip[:, 1].min(), 0.5, "WL in")

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
		poke = blade & (U > L + 0.05)
		yield result("shape.lex", "share of the LEX's upper surface something pokes through", 0.0, 100 * poke.sum() / max(blade.sum(), 1), 1.0, "%")
		tail = blade & (stations[None, :] > end - 4)
		# most of it: a cell on the wing's root rib sees the fuselage below the rib
		gap = float(np.nanpercentile(np.where(tail, L - U, np.nan), 95)) if tail.any() else 0.0
		yield result("shape.lex", "LEX's end standing above what lies beneath (a step), 95% of it", 0.0, gap, 0.6)

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
		yield result("wing.dihedral", "leading edge's slope, BL 80 to 220", value(w["dihedral"]), math.degrees(math.atan((b[1] - a[1]) / 140)), 0.2, "deg")
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
		n = jet.points(["nozzle_right"])
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
		probe = jet.points(["probe"])
		yield result("layout.probe", "stowed probe reaching ahead of its door", 0.0, max(0.0, pr["from"] - probe[:, 0].min()), 0.01)
		hook = F["layout"]["hook"]
		h = jet.points(["hook"])
		yield result("layout.hook", "stowed hook's aftmost point (its shoe's round end past the point)", hook["point"][0], h[:, 0].max(), 2.0, "FS in")

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
		hood = jet.cut(["canopy"], [c["crown"]["station"], 100, 0], [1, 0, 0])
		yield result("layout.canopy", "canopy crown", c["crown"]["waterline"], hood[:, 1].max(), 0.4, "WL in")
		whole = jet.points(["canopy"])
		yield result("layout.canopy", "canopy's aft end", c["aft"]["station"], whole[:, 0].max(), 0.6, "FS in")
		screen = jet.points(["windscreen"])
		yield result("layout.canopy", "windscreen's front base", c["windscreen"]["station"], screen[:, 0].min(), 0.6, "FS in")
		bow = jet.cut(["canopy", "windscreen"], [c["bow"]["station"], 100, 0], [1, 0, 0])
		yield result("layout.canopy", "bow's top", c["bow"]["waterline"], bow[:, 1].max(), 0.4, "WL in")
		yield result("layout.surfaces", "inboard leading-edge flap's outer end", L["surfaces"]["lef"]["inner"][1],
			jet.points(["flap_leading_inner_right"])[:, 2].max(), 0.5, "BL in")
		yield result("layout.surfaces", "aileron's outer end", L["surfaces"]["aileron"][1], jet.points(["aileron_right"])[:, 2].max(), 0.5, "BL in")

	yield from guard("layout", "placements", placements)


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
