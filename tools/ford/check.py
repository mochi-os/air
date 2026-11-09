# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# The facts check (verify/README.md step 2): measures the built model and its
# ship file back against every entry in facts.json and fails any measurement
# outside its tolerance. The build reads these facts and placements, but its
# lofts and outlines can still land somewhere else; this is what catches it.
# Every facts.json entry is either measured here or listed in EXEMPT with the
# reason (not geometry, relative to another ship, or not built yet), so a new
# fact cannot go unchecked. The shape.* checks hold what no fact states.
#
# usage: python3 -I check.py MODEL.glb SHIP.json [--json]
import json, math, sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "verify"))   # run with -I, which leaves the script's own folder off the path
import model as verify  # noqa: E402
import camera  # noqa: E402

FACTS = json.loads((HERE / "facts.json").read_text())
FT = 0.3048

# Entries the check does not measure, and why
EXEMPT = {
	"overall.beam.deck": "the published width is not the deck's extreme: measured the same way, CVN 77 spans 80.5 m against her published 252 ft (layout.notes.deck), so 256 ft names some other width",
	"overall.draught.navigational": "a limit the deployed draught stays under (hull.draught.deployed)",
	"overall.draught.limit": "a limit the deployed draught stays under (hull.draught.deployed)",
	"overall.displacement": "a weight, not a shape",
	"hull.form": "the stations' shape follows it; no public lines to measure against",
	"island.levels": "decks inside the island, not its outside",
	"island.placement": "relative to an unnamed earlier carrier",
	"island.taller": "relative to an unnamed earlier carrier",
	"arresting.engines": "below the deck",
	"arresting.runout": "the flight core's arresting gear (carrier.go), tested in carrier_test.go",
	"catapults.force": "the flight core's catapult (carrier.go), tested in carrier_test.go",
	"catapults.speed": "the flight core's cap on a shot, written into the ship file",
	"catapults.profile": "the flight core's catapult (carrier.go), tested in carrier_test.go",
	"markings.colours": "the paint's colours, measured from the photos (layout.paint)",
	"markings.lens": "the shore layout's lens, a check on the Ford's when the lens is placed",
	"radio.tacan": "the flight core's, not the model's",
	"layout.catapults": "tracks, batteries and strokes the build writes as given; the shuttles' and deflectors' joints are tested in test_build.py",
	"layout.fittings": "fittings' sizes the build writes as given",
	"layout.landing": "the landing line and wires the build writes as given",
	"layout.consoles": "the consoles the build writes as given; their motion is tested in test_build.py",
	"layout.antennas": "the antennas the build writes as given; their motion is tested in test_build.py",
	"layout.parking": "a placed spot the build writes as given",
	"layout.sponsons": "built as given (references/research/sides, stern); the photo match checks their corners",
	"layout.weapons": "built as given",
	"layout.domes_edge": "built as given",
	"layout.catwalks": "built as given",
	"layout.racks": "built as given",
	"layout.openings": "built as given, dark on the hull",
	"layout.weathering": "the paint's wear by rule (weather.py); test_weather checks the rules, test_build the atlas",
	"layout.wear": "the deck's wear by rule from measured numbers (paint.py); test_paint holds the tyres to the band measured in dvids7694421 and the soot to its panels",
	"layout.tubs": "built as given (references/research/stern); test_build checks a tub's floor, railing and knee",
	"layout.transom": "built as given (references/research/transom); test_build checks the face, its recess and the walkway",
	"layout.lettering": "plates built as given; test_build checks each reads from outside its face",
	"layout.lens": "the lens the build writes as given, for the engine to draw",
	"layout.lights": "the lights the build writes as given, for the engine to draw",
	"layout.paint": "colours paint.py draws, not a shape",
	"layout.markings": "the markings paint.py draws; their widths and spacings are checked against markings.*",
	"layout.stains": "the darkening paint.py draws over the markings, not a shape",
}


def value(entry):
	return entry["value"] if isinstance(entry, dict) and "value" in entry else entry


def entries(facts):
	# Every entry a check must account for: dicts that cite a source or carry
	# several sources' values, and layout's placements
	out = []

	def walk(o, path):
		if path.startswith("layout.") and path.count(".") == 1:
			out.append(path)
			return
		if isinstance(o, dict):
			if "source" in o or "values" in o:
				out.append(path)
				return
			for k, v in o.items():
				if k not in ("about", "note", "notes", "where", "also", "unit", "use"):
					walk(v, f"{path}.{k}" if path else k)

	walk(facts, "")
	return out


def area(outline):
	# Unsigned area of a plan polygon [[x, z], ...]
	return abs(sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(outline, outline[1:] + outline[:1]))) / 2


def rounding_inward(r):
	# The round-down's edge's inward direction in plan, toward the deck's middle
	(ax, az), (bx, bz) = r["edge"]
	span = math.hypot(bx - ax, bz - az)
	nx, nz = -(bz - az) / span, (bx - ax) / span
	mx, mz = np.mean(np.array(FACTS["layout"]["deck"]["outline"], float), axis=0)
	return (nx, nz) if (mx - ax) * nx + (mz - az) * nz >= 0 else (-nx, -nz)


def rounding_distance(r, plan):
	# Plan points' distances (N, [x, z]) in from the round-down's edge
	(ax, az), _ = r["edge"]
	nx, nz = rounding_inward(r)
	return (plan[:, 0] - ax) * nx + (plan[:, 1] - az) * nz


def rounding_miss(tris, r, height, inward):
	# The worst gap between a deck's top (triangles, ship frame) and its
	# round-down's curve, sampled across the edge's middle 90% and from 0.1 m
	# inside its edge to 0.1 m short of the curve's end
	(ax, az), (bx, bz) = r["edge"]
	nx, nz = inward
	curve = lambda d: height - r["drop"] * max(0.0, 1 - d / r["length"]) ** 2
	worst = 0.0
	for share in np.linspace(0.05, 0.95, 9):
		x0, z0 = ax + (bx - ax) * share, az + (bz - az) * share
		for d in np.linspace(0.1, r["length"] - 0.1, 7):
			x, z = x0 + nx * d, z0 + nz * d
			for (px, py, pz), (qx, qy, qz), (rx, ry, rz) in tris:
				den = (qz - rz) * (px - rx) + (rx - qx) * (pz - rz)
				if abs(den) < 1e-12:
					continue
				l1 = ((qz - rz) * (x - rx) + (rx - qx) * (z - rz)) / den
				l2 = ((rz - pz) * (x - rx) + (px - rx) * (z - rz)) / den
				if min(l1, l2, 1 - l1 - l2) >= -1e-9:
					worst = max(worst, abs(l1 * py + l2 * qy + (1 - l1 - l2) * ry - curve(d)))
					break
	return worst


def hits(tris, origin, direction, reach):
	# Whether a ray from origin meets one of the triangles (N, 3, 3) within
	# reach, either side of it
	origin, direction = np.asarray(origin, float), np.asarray(direction, float)
	end = origin + direction * reach
	low, high = np.minimum(origin, end) - 1e-6, np.maximum(origin, end) + 1e-6
	tris = tris[np.all((tris.max(axis=1) >= low) & (tris.min(axis=1) <= high), axis=1)]
	a, e1, e2 = tris[:, 0], tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0]
	p = np.cross(direction, e2)
	det = np.einsum("ij,ij->i", e1, p)
	ok = np.abs(det) > 1e-12
	inv = np.where(ok, 1 / np.where(ok, det, 1), 0)
	s = origin - a
	u = np.einsum("ij,ij->i", s, p) * inv
	q = np.cross(s, e1)
	v = (q @ direction) * inv
	t = np.einsum("ij,ij->i", e2, q) * inv
	return bool((ok & (u >= 0) & (v >= 0) & (u + v <= 1) & (t > 1e-6) & (t < reach)).any())


def inside(outline, x, z):
	# Whether plan point (x, z) lies inside the polygon [[x, z], ...]
	crossings = 0
	for (ax, az), (bx, bz) in zip(outline, outline[1:] + outline[:1]):
		if (az > z) != (bz > z) and x < ax + (z - az) * (bx - ax) / (bz - az):
			crossings += 1
	return crossings % 2 == 1


def result(fact, what, expected, measured, tolerance, unit="m"):
	return {"fact": fact, "what": what, "expected": float(expected), "measured": float(measured), "tolerance": tolerance, "unit": unit}


class Ship:
	def __init__(self, glb, ship):
		self.model = verify.Model(glb)
		self.ship = json.loads(Path(ship).read_text())
		self.parts = self.model.parts()
		self.layout = FACTS["layout"]

	def points(self, names, materials=None):
		parts = self.model.parts(materials=materials) if materials else self.parts
		found = [parts[n].reshape(-1, 3) for n in names if n in parts]
		if not found:
			raise KeyError(", ".join(names))
		return np.concatenate(found)


def breadth(tris, x, y, side):
	# The hull's outermost half-breadth at (x, y) on a side (1 starboard, -1
	# port), from its section at x; None where nothing crosses that height
	segments = verify.cut(tris, [x, 0, 0], [1, 0, 0])
	a, b = segments[:, 0], segments[:, 1]
	across = ((a[:, 1] - y) * (b[:, 1] - y) <= 0) & (np.abs(b[:, 1] - a[:, 1]) > 1e-9)
	t = (y - a[across, 1]) / (b[across, 1] - a[across, 1])
	reach = side * (a[across, 2] + (b[across, 2] - a[across, 2]) * t)
	return float(reach.max()) if len(reach) else None


def shoulders(ship):
	# Over the bow's shoulders, where they are in full (hull.shoulders), the
	# flare passes through each station's points between the knuckle and the
	# gallery's foot, each side: the worst miss of the hull's outermost
	# half-breadth at the point's height
	h = ship.layout["hull"]
	if not h.get("shoulders"):
		return
	deck = ship.layout["deck"]
	under = deck["height"] - deck["thickness"]
	tris = ship.parts["hull"]
	for s in sorted(h["stations"], key=lambda q: q["x"]):
		if s["x"] < h["shoulders"]["full"]:
			continue
		for name, side in (("starboard", 1), ("port", -1)):
			knuckle = sorted(h["knuckle"][name])
			gallery = sorted(h["gallery"][name])
			low = np.interp(s["x"], [p[0] for p in knuckle], [p[1] for p in knuckle])
			foot = under - np.interp(s["x"], [p[0] for p in gallery], [p[1] for p in gallery])
			misses = []
			for y, z in s["points"]:
				if low < y < foot:
					reach = breadth(tris, s["x"], y, side)
					misses.append(math.inf if reach is None else abs(reach - z))
			if misses:
				yield result("layout.hull", f"the bow's flare through station {s['x']:g}'s points above the knuckle, {name}", 0, max(misses), 0.01)


# What the photos measure of the hawse hoods (layout.notes.anchors): the foot
# of each one's outline seen from ahead and its outboard side (height and
# breadth, from dvids3299641); its top corner, where it meets the plating
# (both head-on photos, each side); and the port one's lip and lit side seen
# past the stem against the sky in dvids9688116, through research/bow's camera
HOOD = {"foot": (9.13, 7.3), "side": (10.0, 8.4), "corner": {"starboard": (151.8, 10.95, 8.17), "port": (152.7, 10.96, 8.32)},
	"seen": {"photo": "dvids9688116", "pixels": [[4730, 2300], [4740, 2295], [4725, 2315], [4610, 2380], [4620, 2372]]}}
CAMERAS = HERE / "references" / "research" / "bow" / "cameras.json"


def anchors(ship):
	# The anchors housed at the bow (layout.anchors): each hawse pipe's hood
	# through the points the photos measure of it (HOOD), its top corner on
	# the plating; and the bow ahead of the port one leaving it in view where
	# dvids9688116 sees it, no plating on a ray through those pixels more
	# than 2 m nearer the camera than the crown (a fuller bow hid them)
	a = ship.layout.get("anchors")
	if not a:
		return
	ship.points(["anchors"])
	tris = ship.parts["hull"]
	hood = ship.model.parts(materials=["grey", "hawse"])["anchors"]   # the hood's grey, weathered (layout.weathering)
	for name, side in (("starboard", 1), ("port", -1)):
		# its outline seen from ahead: how far it reaches past each point, down
		# at the foot (its lowest), outboard at the side
		ahead = hood[:, :, 1:] * [1, side]
		for what, p, toward in (("foot", HOOD["foot"], (-1, 0)), ("outboard side", HOOD["side"], (0, 1))):
			yield result("layout.anchors", f"the {name} hawse hood's outline seen from ahead past its {what}", 0, outline_reach(ahead, p, toward), 0.3)
		x, y, z = HOOD["corner"][name]
		reach = breadth(tris, x, y, side)
		yield result("layout.anchors", f"the {name} hawse hood's top corner off the plating", 0, math.inf if reach is None else z - reach, 0.3)
	seen = HOOD["seen"]
	c = json.loads(CAMERAS.read_text())[seen["photo"]]
	view, centre = np.array(c["camera"], float), np.array(c["centre"], float)
	eye = camera.eye(view)
	near = float(np.linalg.norm(np.array(a["crown"], float) * [1, 1, -1] - eye)) - 2
	hidden = sum(hits(tris, eye, camera.ray(view, np.array(q, float), centre), near) for q in seen["pixels"])
	yield result("layout.anchors", f"the port hawse hood's pixels in {seen['photo']} hidden by the bow", 0, hidden, 0.5, unit="pixels")


def outline_reach(tris, point, toward):
	# How far an outline in the plane (triangles (N, 3, 2), their union)
	# reaches past a point along a direction: the furthest t, -2 to 2 m, at
	# which point + t toward lies on a triangle; -inf when none of that line does
	d = np.asarray(toward, float) / np.linalg.norm(toward)
	tris = np.asarray(tris, float)
	e1, e2 = tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0]
	tris = tris[np.abs(e1[:, 0] * e2[:, 1] - e1[:, 1] * e2[:, 0]) > 1e-12]   # those seen edge on cover nothing
	t = np.linspace(-2, 2, 801)
	q = np.asarray(point, float) + t[:, None] * d
	a, b, c = tris[:, 0], tris[:, 1], tris[:, 2]
	def side(u, v):
		return (v[None, :, 0] - u[None, :, 0]) * (q[:, None, 1] - u[None, :, 1]) - (v[None, :, 1] - u[None, :, 1]) * (q[:, None, 0] - u[None, :, 0])
	s1, s2, s3 = side(a, b), side(b, c), side(c, a)
	covered = (((s1 >= 0) & (s2 >= 0) & (s3 >= 0)) | ((s1 <= 0) & (s2 <= 0) & (s3 <= 0))).any(1)
	return float(t[covered].max()) if covered.any() else -math.inf


def guard(fact, what, make):
	# A check whose part is not built yet reports it as missing, not a crash
	try:
		yield from make()
	except KeyError as missing:
		yield {"fact": fact, "what": what, "missing": f"{missing} not built"}


def checks(ship):
	deck = ship.layout["deck"]
	height = deck["height"]

	def overall():
		top = ship.points(["deck"])
		yield result("overall.length", "the flight deck's length overall", FACTS["overall"]["length"]["values"][0]["value"] * FT,
			top[:, 0].max() - top[:, 0].min(), 1.0)
		plan = area(deck["outline"]) + sum(area(e["outline"]) for e in ship.layout["elevators"])
		square = next(v for v in FACTS["overall"]["area"]["values"] if v["unit"] == "ft2")
		yield result("overall.area", "the flight deck's plan with its elevators", square["value"] * FT * FT, plan, round(0.03 * square["value"] * FT * FT), "m2")
	yield from overall()

	def hull():
		h = ship.ship["hull"]
		water = h["waterline"]
		yield result("overall.waterline", "the hull's waterline, transom to stem", value(FACTS["overall"]["waterline"]) * FT, water["stem"] - water["stern"], 2.0)
		yield result("overall.beam.waterline", "the hull's beam on the waterline", value(FACTS["overall"]["beam"]["waterline"]) * FT,
			2 * max(q[1] for q in water["half"]), 0.3)
		yield result("hull.draught.deployed", "the keel below the waterline", value(FACTS["hull"]["draught"]["deployed"]) * FT, h["draught"], 0.05)
		boot = ship.points(["hull"], materials=["boot"])
		yield result("hull.boot", "the boot top above the waterline", (value(FACTS["hull"]["boot"]) - value(FACTS["hull"]["draught"]["deployed"])) * FT,
			boot[:, 1].max(), 0.05)
		stem = sorted(ship.layout["hull"]["stem"], key=lambda q: q[1])
		on = np.interp(0.0, [q[1] for q in stem], [q[0] for q in stem])
		yield result("layout.hull", "the stem on the waterline, where its layout puts it", on, water["stem"], 0.01)
		keel = ship.points(["hull"])[:, 1].min()
		yield result("layout.hull", "the keel, as deep as its layout's deepest station", min(q["points"][0][0] for q in ship.layout["hull"]["stations"]), keel, 0.01)
		yield from shoulders(ship)
	yield from guard("hull", "the hull", hull)
	yield from guard("anchors", "the anchors", lambda: anchors(ship))

	def island():
		base = [p for p in ship.ship["island"]["prisms"] if abs(p["bottom"] - height) < 1e-6]
		if not base:
			raise KeyError("island base")
		plan = np.array([q for p in base for q in p["outline"]])
		yield result("island.length", "the island's base, fore and aft", value(FACTS["island"]["length"]) * FT, plan[:, 0].max() - plan[:, 0].min(), 1.0)
		yield result("island.width", "the island's base, athwartships", value(FACTS["island"]["width"]) * FT, plan[:, 1].max() - plan[:, 1].min(), 1.0)
		i = ship.layout["island"]
		block = max(p["top"] for p in i["prisms"] if not p["name"].startswith(("mast", "gaff")))   # the mast's parts left out
		tops = [max(q[0] for q in d["profile"]) if "profile" in d else d["centre"][1] + d["radius"] for d in i.get("domes", [])]   # a turned radome's profile, or a sphere
		highest = max([p["top"] for p in i["prisms"]] + [p["top"] for p in i.get("poles", [])] + tops)
		yield result("layout.island", "the island's highest point, where its layout puts it", highest, ship.points(["island"])[:, 1].max(), 0.01)
		yield result("island.height", "the island's block above the deck (the mast left out)", value(FACTS["island"]["height"]) * FT, block - height, 1.5)
	yield from guard("island", "the island", island)

	def elevators():
		built = sorted(n for n in ship.parts if n.startswith("elevator_"))
		yield result("elevators.count", "elevators built", value(FACTS["elevators"]["count"]), len(built), 0, "")
		for name in built:
			points = ship.points([name])
			top = points[np.abs(points[:, 1] - height) < 1e-4][:, [0, 2]]
			outline = np.array(next(e["outline"] for e in ship.layout["elevators"] if f"elevator_{e['number']}" == name))
			# the platform's top meets its layout's corners
			gap = max(np.linalg.norm(top - corner, axis=1).min() for corner in outline)
			yield result("layout.elevators", f"{name}'s top at its layout's corners", 0, gap, 0.01)
			# a trapezoid, wider at the deck's edge: its long side, and its depth
			# from the inboard edge out
			top_z = np.abs(top[:, 1])
			sides = [np.linalg.norm(outline[i] - outline[(i + 1) % 4]) for i in range(4)]
			# the published size is one starboard elevator's (facts.json says which)
			if name == f"elevator_{FACTS['elevators']['length']['elevator']}":
				yield result("elevators.length", f"{name}'s long side", value(FACTS["elevators"]["length"]) * FT, max(sides), 1.0)
				# where the photos and the published figure disagree, the entry says which the model uses
				width = FACTS["elevators"]["width"]
				want = width["measured"]["value"] if width.get("use", "").startswith("measured") else value(width) * FT
				yield result("elevators.width", f"{name}'s depth inboard", want, top_z.max() - top_z.min(), 0.5)
	yield from elevators()

	def fittings():
		yield result("arresting.wires", "wires in the ship file", value(FACTS["arresting"]["wires"]), len(ship.ship["landing"]["wires"]), 0, "")
		yield result("arresting.target", "the wire the landing aims at", value(FACTS["arresting"]["target"]), ship.ship["landing"]["target"], 0, "")
		yield result("catapults.count", "catapults in the ship file", value(FACTS["catapults"]["count"]), len(ship.ship["catapults"]), 0, "")
	yield from fittings()

	def markings():
		marks = {m["name"]: m for m in ship.layout["markings"]}
		M = FACTS["markings"]
		yield result("markings.centreline", "the centreline's width", value(M["centreline"]) * FT, marks["centreline"]["width"], 0.01)
		# its yellow runs on over the round-down to the deck's aft edge, over
		# the ramp's white (DVIDS 7694418)
		(ex, ez), (gx, gz) = deck["round"]["edge"]
		x, z = marks["centreline"]["points"][0]
		miss = abs((gx - ex) * (z - ez) - (gz - ez) * (x - ex)) / math.hypot(gx - ex, gz - ez)
		yield result("markings.centreline", "the centreline's aft end off the deck's aft edge", 0, miss, 0.05)
		order = [m["name"] for m in ship.layout["markings"]]
		yield result("markings.centreline", "the centreline's yellow drawn over the ramp", 1, order.index("centreline_yellow_1") > order.index("ramp"), 0, "")
		# the bow control station's band right outside its lid's rim on every
		# side (DVIDS 9405623, 9405624): each side's middle half its width out
		# from the lid's outline
		lid = next(c for c in ship.layout["consoles"] if c["name"] == "bow")["outline"]
		edges = list(zip(lid, lid[1:] + lid[:1]))
		def off(p):
			return min(abs((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) / math.dist(a, b) for a, b in edges)
		for name in ("console_bow_surround", "console_bow_surround_stripes"):
			band = marks[name]
			middles = [((a[0] + b[0]) / 2, (a[1] + b[1]) / 2) for a, b in zip(band["points"], band["points"][1:])]
			worst = max(abs(off(p) - band["width"] / 2) for p in middles)
			yield result("shape.console_band", f"{name}'s inner edge off the bow station's lid", 0, worst, 0.02)
		yellow = sorted((m for n, m in marks.items() if n.startswith("centreline_yellow_")), key=lambda m: m["points"][0][0])
		inner = [math.dist(*m["points"]) for m in yellow[1:-1]]
		yield result("markings.sections", "the centreline's whole yellow sections", value(M["sections"]) * FT, np.mean(inner), 0.05)
		for side in ("port", "starboard"):
			yield result("markings.edges.outer", f"the {side} outer edge stripe's width", value(M["edges"]["outer"]) * FT, marks[f"edge_{side}_outer"]["width"], 0.01)
			yield result("markings.edges.inner", f"the {side} inner edge stripe's width", value(M["edges"]["inner"]) * FT, marks[f"edge_{side}_inner"]["width"], 0.01)
			bars = sorted((np.mean(m["outline"], axis=0) for n, m in marks.items() if n.startswith(f"bar_{side}_")), key=lambda q: q[0])
			gaps = [math.dist(a, b) for a, b in zip(bars, bars[1:])]
			step = value(M["edges"]["bars"])[1] * FT
			# a gap of two intervals is a bar the wires' supports replace
			yield result("markings.edges.bars", f"the {side} bars' interval", step, np.mean([g / round(g / step) for g in gaps]), 0.1)
		yield result("markings.ramp", "the ramp stripe's width", value(M["ramp"]) * FT, marks["ramp"]["width"], 0.01)
	yield from markings()

	def plan():
		# the deck's top at its height but for its round-down, and its outline
		# covered in plan (the round-down's curve adds a little surface)
		top = ship.points(["deck"])
		r = deck.get("round")
		if r:
			top = top[rounding_distance(r, top[:, [0, 2]]) >= r["length"] - 1e-6]
		yield result("layout.deck", "the deck's top at its layout height", height, top[:, 1].mean(), 0.001)
		tris = ship.parts["deck"]
		cross = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
		yield result("layout.deck", "the deck's top covers its layout outline", area(deck["outline"]), 0.5 * np.abs(cross[:, 1]).sum(), 1.0, "m2")
	yield from plan()

	def shapes():
		hull = ship.points(["hull"])
		yield result("shape.deck", "hull standing above the deck's underside", 0, max(0.0, hull[:, 1].max() - (height - deck["thickness"])), 0.01)
		below = hull[hull[:, 1] < min(min(q[1] for q in ship.layout["hull"]["knuckle"][s]) for s in ("port", "starboard")) - 1e-6]
		port = np.unique(np.round(below[below[:, 2] < -1e-6] * [1, 1, -1], 3), axis=0)
		starboard = np.unique(np.round(below[below[:, 2] > 1e-6], 3), axis=0)
		same = len(port) == len(starboard) and np.allclose(port, starboard, atol=1e-3)
		yield result("shape.mirror", "the hull below its knuckles, port against starboard", 0, 0 if same else 1, 0, "")
	yield from guard("shape", "the hull's shapes", shapes)

	def standing():
		island = ship.points(["island"])
		yield result("shape.island", "island reaching below the deck", 0, max(0.0, height - island[:, 1].min()), 0.01)
	yield from guard("shape.island", "the island's shape", standing)

	def rounding():
		# the round-down: the deck's surface on the layout's curve across the
		# whole edge, sampled between the cuts and away from the edge's ends
		r = deck.get("round")
		if not r:
			return
		worst = rounding_miss(ship.parts["deck"], r, height, rounding_inward(r))
		yield result("shape.round_down", "the deck's top off its round-down's curve", 0, worst, 0.02)
	yield from guard("shape.round_down", "the round-down", rounding)

	def pole():
		# the drop-light pole (references/research/drop): its yellow from its
		# foot to its top with nothing in its gap, nothing of the walkway aft
		# of it, so it shows unbroken past the walkway from astern, and the
		# recess's raised deck out past it at the gap's foot
		d, floor = ship.layout["transom"]["drop"], ship.layout["transom"]["floor"]
		parts = ship.model.parts(materials=["yellow"])
		if "transom_fittings" not in parts:
			raise KeyError("transom_fittings")
		tris = parts["transom_fittings"]
		tris = tris[np.all((np.abs(tris[:, :, 0] - d["x"]) < d["depth"]) & (np.abs(tris[:, :, 2] - d["z"]) < d["width"]), axis=1)]
		yield result("shape.drop", "the drop-light pole's top", d["top"], tris[:, :, 1].max(), 0.01)
		yield result("shape.drop", "the drop-light pole's foot", d["bottom"], tris[:, :, 1].min(), 0.01)
		# a yellow face reaching into the gap, whatever its corners
		low, high = d.get("gap", [d["top"], d["top"]])
		across = (tris[:, :, 1].min(axis=1) < high - 1e-3) & (tris[:, :, 1].max(axis=1) > low + 1e-3)
		yield result("shape.drop", "the drop-light pole's yellow faces reaching into its gap", 0, int(across.sum()), 0, "")
		# every face of the transom's fittings (the walkway is weathered, so
		# in no one material); the rays below start clear of the pole's own
		walk = ship.parts["transom_fittings"]
		across = (d["z"] - d["width"] / 3, d["z"], d["z"] + d["width"] / 3)
		aft = d["x"] - d["depth"] / 2
		blocked = sum(hits(walk, [aft - 0.01, level, z], [-1.0, 0, 0], 4) for level in np.arange(floor - 1.75, floor, 0.1) for z in across)
		yield result("shape.drop", "lines of sight aft from the pole that the walkway blocks", 0, blocked, 0, "")
		# the recess's raised deck runs out past the pole at its gap's foot,
		# interrupting it (7694418): something under each point just aft of
		# the pole there, within 0.6 m of the foot
		if "gap" in d:
			under = sum(hits(walk, [aft - 0.05, d["gap"][0] + 0.6, z], [0, -1.0, 0], 0.61) for z in across)
			yield result("shape.drop", "points just aft of the pole at its gap's foot with a deck under them", len(across), under, 0, "")
	yield from guard("shape.drop", "the drop-light pole", pole)

	def platforms():
		# every open edge of the transom's decks railed (the photos rail every
		# one: references/research/drop): sampled every 0.25 m clear of the
		# corners, an edge is open where nothing stands within 1 m below just
		# beyond it (a deck it steps down to) and no wall rises just beyond it,
		# and railed where something stands 0.3-1.6 m over the deck within
		# 0.5 m inside it. The walkway's cut round the drop-light pole, where
		# the pole's ladder comes down, is open in every photo.
		t = ship.layout["transom"]
		tris = np.concatenate([p[p[:, :, 0].min(axis=1) < t["face"] + 6] for p in ship.parts.values()])
		details = {e["name"]: e for e in t["details"]}
		slats = [e for e in t["details"] if e["name"].startswith("landing_slat_")]
		if not slats or "mezzanine" not in details:
			raise KeyError("landing_slat, mezzanine")
		fore, aft = max(e["path"][0][0] for e in slats), min(e["path"][0][0] for e in slats)
		size, level = slats[0]["size"], slats[0]["path"][0][1] + slats[0]["size"] / 2
		port, starboard = slats[0]["path"][0][2], slats[0]["path"][-1][2]
		fantail = next(s for s in ship.layout["sponsons"] if s["name"] == "fantail")
		decks = [
			("mezzanine", details["mezzanine"]["outline"], details["mezzanine"]["top"]),
			("ledge", details["mezzanine_ledge"]["outline"], details["mezzanine_ledge"]["top"]),
			("walkway", t["walkway"]["plan"], t["floor"]),
			("fantail", fantail["outline"], fantail["top"]),
			("landing", [[fore + size / 2, port], [aft - size / 2, port], [aft - size / 2, starboard], [fore + size / 2, starboard]], level),
		]
		d = t["drop"]
		down = np.array([0, -1.0, 0])
		bare, opened = [], set()
		for name, outline, top in decks:
			for a, b in zip(outline, outline[1:] + outline[:1]):
				a, b = np.array(a, float), np.array(b, float)
				span = np.linalg.norm(b - a)
				if span < 0.4:
					continue
				along = (b - a) / span
				out = np.array([along[1], -along[0]])
				middle = (a + b) / 2
				if inside(outline, *(middle + out * 0.05)):
					out = -out
				for s in np.arange(0.15, span - 0.15 + 1e-9, 0.25):
					x, z = a + along * s
					if name == "walkway" and x > d["x"] - d["depth"] and abs(z - d["z"]) < 1.6:
						continue
					beyond = [x + out[0] * 0.2, top + 0.3, z + out[1] * 0.2]
					if hits(tris, beyond, down, 1.3):
						continue
					if hits(tris, [x - out[0] * 0.1, top + 0.25, z - out[1] * 0.1], [out[0], 0, out[1]], 0.6):
						continue
					opened.add(name)
					if not any(hits(tris, [x - out[0] * k, top + 1.6, z - out[1] * k], down, 1.3) for k in np.arange(0.0, 0.51, 0.05)):
						bare.append((name, round(float(x), 2), round(float(z), 2)))
		yield result("shape.platforms", "transom decks with an open edge found", len(decks), len(opened), 0, "")
		where = ""
		if bare:
			names = sorted({b[0] for b in bare})
			where = " (" + "; ".join(f"{n} {[b[1:] for b in bare if b[0] == n][:3]}" for n in names) + ")"
		yield result("shape.platforms", f"points along the transom decks' open edges with no railing{where}", 0, len(bare), 0, "")
	yield from guard("shape.platforms", "the transom decks' railings", platforms)

	def railings():
		# every island railing and chain (references/research/roofs) clear of
		# every radome: across the railing's height, its bars no nearer a
		# radome's axis than the radome's profile there
		island = ship.layout["island"]
		lines = [(d["name"], d["path"], d["height"]) for d in island["details"] if d["kind"] == "railing"]
		lines += [(d["name"], d["path"], 0.0) for d in island["details"] if d["name"].startswith("aft_platform_chain_") and d["kind"] == "path"]
		worst, where = 0.0, ""
		for dome in island["domes"]:
			profile = dome.get("profile")
			if not profile:
				continue
			heights, radii = [q[0] for q in profile], [q[1] for q in profile]
			cx, cz = dome["centre"]
			for name, path, rise in lines:
				for a, b in zip(path, path[1:]):
					ax, az, bx, bz = a[0] - cx, a[2] - cz, b[0] - cx, b[2] - cz
					t = max(0.0, min(1.0, -(ax * (bx - ax) + az * (bz - az)) / max((bx - ax) ** 2 + (bz - az) ** 2, 1e-12)))
					distance = math.hypot(ax + (bx - ax) * t, az + (bz - az) * t)
					y = a[1] + (b[1] - a[1]) * t
					for level in np.linspace(min(y, y + rise), max(y, y + rise), 11):
						if heights[0] <= level <= heights[-1]:
							into = np.interp(level, heights, radii) + 0.025 - distance
							if into > worst:
								worst, where = into, f" ({name} into {dome['name']})"
		yield result("shape.railings", f"the island's railings reaching into a radome{where}", 0, worst, 0.0)
	yield from guard("shape.railings", "the island's railings", railings)

	def sponsons():
		# every railing and deck circle (a ring facing up) standing on a
		# sponson keeps to its top: the railing's line, and the circle's
		# underside all round, within 0.01 m of the top's plane (a flat circle
		# on a sloping top sinks into it on one side) and inside its edges
		# (one past them hangs in the air). A railing standing on another
		# deck's top over a sponson (the recess's raised deck runs out over
		# the fantail) is that deck's.
		details = ship.layout["transom"]["details"]
		decks = [d for d in details if d["kind"] == "prism" and "outline" in d and not isinstance(d["top"], list)]
		elsewhere = lambda q: any(abs(q[1] - e["top"]) < 0.01 and inside(e["outline"], q[0], q[2]) for e in decks)
		worst, where = 0.0, ""
		for s in ship.layout["sponsons"]:
			outline = s["outline"]
			tops = s["top"] if isinstance(s["top"], list) else [s["top"]] * len(outline)
			plane, *_ = np.linalg.lstsq(np.c_[np.array(outline), np.ones(len(outline))], np.array(tops), rcond=None)
			top = lambda x, z: plane[0] * x + plane[1] * z + plane[2]

			def outside(x, z):
				# how far a plan point lies outside the outline (0 inside)
				if inside(outline, x, z):
					return 0.0
				best = math.inf
				for (ax, az), (bx, bz) in zip(outline, outline[1:] + outline[:1]):
					t = max(0.0, min(1.0, ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / max((bx - ax) ** 2 + (bz - az) ** 2, 1e-12)))
					best = min(best, math.hypot(x - ax - (bx - ax) * t, z - az - (bz - az) * t))
				return best

			points = []
			for d in details:
				if d["kind"] == "railing" and inside(outline, d["path"][0][0], d["path"][0][2]) and not elsewhere(d["path"][0]):
					for a, b in zip(d["path"], d["path"][1:]):
						points += [(d["name"], *(np.array(a) + (np.array(b) - np.array(a)) * k / 10)) for k in range(11)]
				elif d["kind"] == "ring" and inside(outline, d["centre"][0], d["centre"][2]):
					n = np.array(d["facing"], float) / np.linalg.norm(d["facing"])
					if abs(n[1]) < 0.9:
						continue
					c = np.array(d["centre"], float)
					a0, a1 = d.get("sweep", [0, 360])
					for angle in np.radians(np.linspace(a0, a1, 181)):
						u = np.array([math.cos(angle), 0.0, math.sin(angle)])
						u = (u - n * (u @ n)) / np.linalg.norm(u - n * (u @ n))
						points += [(d["name"], *(c + u * radius)) for radius in (d["inner"], d["outer"])]
			for name, x, y, z in points:
				miss = max(abs(y - top(x, z)) - 0.01, outside(x, z), 0.0)
				if miss > worst:
					worst, where = miss, f" ({name} on {s['name']})"
		yield result("shape.sponsons", f"the sponsons' railings and deck circles off their tops{where}", 0, worst, 0.0)
	yield from guard("shape.sponsons", "the sponsons' railings and deck circles", sponsons)


def main():
	ship = Ship(sys.argv[1], sys.argv[2])
	results = list(checks(ship))
	covered = {r["fact"] for r in results}
	unaccounted = [e for e in entries(FACTS) if e not in covered and e not in EXEMPT]
	stale = [e for e in EXEMPT if e not in entries(FACTS)]
	failures = [r for r in results if "missing" in r or abs(r["measured"] - r["expected"]) > r["tolerance"]]
	if "--json" in sys.argv:
		print(json.dumps({"results": results, "unaccounted": unaccounted, "stale": stale, "exempt": EXEMPT}, indent="\t"))
	else:
		for r in results:
			if "missing" in r:
				print(f"MISSING  {r['fact']:24s} {r['what']}: {r['missing']}")
				continue
			miss = r["measured"] - r["expected"]
			flag = "FAIL" if abs(miss) > r["tolerance"] else "ok"
			print(f"{flag:8s} {r['fact']:24s} {r['what']:58s} {r['expected']:10.2f} {r['measured']:10.2f} {miss:+8.2f} (±{r['tolerance']}) {r['unit']}")
		for e in unaccounted:
			print(f"UNCHECKED {e}: facts.json entry with no check and no exemption")
		for e in stale:
			print(f"STALE    {e}: exempted but no longer in facts.json")
		print(f"{len(results)} measurements, {len(failures)} outside tolerance; {len(EXEMPT)} entries exempt; {len(unaccounted)} unaccounted")
	sys.exit(1 if failures or unaccounted or stale else 0)


if __name__ == "__main__":
	main()
