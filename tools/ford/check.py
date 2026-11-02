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
	"markings.colours": "the paint's colours, measured from the photos (layout.paint)",
	"markings.lens": "the shore layout's lens, a check on the Ford's when the lens is placed",
	"radio.tacan": "the flight core's, not the model's",
	"layout.catapults": "tracks, batteries and strokes the build writes as given; the shuttles' and deflectors' joints are tested in test_build.py",
	"layout.fittings": "fittings' sizes the build writes as given",
	"layout.landing": "the landing line and wires the build writes as given",
	"layout.paint": "colours paint.py draws, not a shape",
	"layout.markings": "the markings paint.py draws; their widths and spacings are checked against markings.*",
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
	yield from guard("hull", "the hull", hull)

	def island():
		base = [p for p in ship.ship["island"]["prisms"] if abs(p["bottom"] - height) < 1e-6]
		if not base:
			raise KeyError("island base")
		plan = np.array([q for p in base for q in p["outline"]])
		yield result("island.length", "the island's base, fore and aft", value(FACTS["island"]["length"]) * FT, plan[:, 0].max() - plan[:, 0].min(), 1.0)
		yield result("island.width", "the island's base, athwartships", value(FACTS["island"]["width"]) * FT, plan[:, 1].max() - plan[:, 1].min(), 1.0)
		i = ship.layout["island"]
		block = max(p["top"] for p in i["prisms"] if not p["name"].startswith(("mast", "gaff")))   # the mast's parts left out
		highest = max([p["top"] for p in i["prisms"]] + [p["top"] for p in i.get("poles", [])] + [d["centre"][1] + d["radius"] for d in i.get("domes", [])])
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
			yield result("elevators.length", f"{name}'s long side", value(FACTS["elevators"]["length"]) * FT, max(sides), 1.0)
			yield result("elevators.width", f"{name}'s depth inboard", value(FACTS["elevators"]["width"]) * FT, top_z.max() - top_z.min(), 0.5)
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
		top = ship.points(["deck"])
		yield result("layout.deck", "the deck's top at its layout height", height, top[:, 1].mean(), 0.001)
		tris = ship.parts["deck"]
		cross = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
		yield result("layout.deck", "the deck's top covers its layout outline", area(deck["outline"]), 0.5 * np.linalg.norm(cross, axis=1).sum(), 1.0, "m2")
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
