# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# usage: python3 -I test_check.py
import json, math, re, sys, tempfile, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "verify"))

import numpy as np  # noqa: E402

import check  # noqa: E402
from test_verify import box, glb  # noqa: E402


class EntriesTest(unittest.TestCase):
	def test_entries(self):
		facts = {"about": "x", "overall": {"length": {"value": 1, "source": "a"}, "span": {"spread": {"value": 2, "source": "a"}}},
			"sections": [{"station": 70, "source": "b"}, {"station": 85, "source": "b"}],
			"gravity": [{"aircraft": "HARV", "station": 454.3, "source": "c"}],
			"layout": {"about": "y", "wing": {"value": 113}, "gear": {"nose": 1}}}
		self.assertEqual(check.entries(facts), ["overall.length", "overall.span.spread", "sections@70", "sections@85", "gravity@HARV", "layout.wing", "layout.gear"])

	def test_every_fact_is_measured_or_exempt(self):
		# The fact ids check.py measures, read from its source: literal ids, and
		# the per-station families it builds with f-strings
		source = (HERE / "check.py").read_text()
		start = source.index("EXEMPT = {")
		source = source[:start] + source[source.index("\n}\n", start) + 3 :]
		# the first argument of result() calls, and any quoted dotted path (fact
		# ids carried in tuples); a bare word such as "canopy" is a node's name
		measured = set(re.findall(r'result\(\s*"([^"]+)"', source)) | set(re.findall(r'"([a-z0-9_]+(?:\.[a-z0-9_]+)+)"', source))
		for family, key in (("sections", "sections"), ("lex.sections", "lex")):
			if f'f"{family}@{{' in source or f"f\"{family}@{{" in source:
				rows = check.FACTS[key] if key == "sections" else check.FACTS["lex"]["sections"]
				measured |= {f"{family}@{r['station']}" for r in rows}
		for fact in check.entries(check.FACTS):
			self.assertTrue(fact in measured or fact in check.EXEMPT, f"{fact}: neither measured nor exempt")
		for fact in check.EXEMPT:
			self.assertIn(fact, check.entries(check.FACTS), f"{fact}: exempt but not in facts.json")
			self.assertNotIn(fact, measured, f"{fact}: both measured and exempt")


class ProvenanceTest(unittest.TestCase):
	# Our model's scripts never open the old model or the vendor downloads (the
	# plan's Provenance check): no line of their code names them. far.py,
	# fresh.py and pose.json serve the old model until the swap retires them.
	OURS = ["build.py", "stages.py", "check.py", "outline.py", "views.py", "fetch.py", "render.py",
		"../verify/model.py", "../verify/camera.py", "../verify/photos.py", "../verify/cast.py", "../verify/crop.py", "../verify/view.py"]
	FORBIDDEN = re.compile(r"downloads|fa18c-far|stores\.glb|fa18c\.glb|pose\.json|far\.py|fresh\.py")

	def test_our_scripts_never_name_the_old_files(self):
		for name in self.OURS:
			for number, line in enumerate((HERE / name).read_text().splitlines(), 1):
				code = line.split("#", 1)[0]
				self.assertIsNone(self.FORBIDDEN.search(code), f"{name}:{number}: {line.strip()}")

	def test_the_rule_bites(self):
		self.assertIsNotNone(self.FORBIDDEN.search('ORIGINAL = HERE.parents[1] / "downloads" / "x.glb"'))
		self.assertIsNone(self.FORBIDDEN.search("blender -b -P build.py -- OUT.glb OUT.json"))


class GeometryTest(unittest.TestCase):
	def test_loops_and_area(self):
		square = np.array([[[0, 0], [2, 0]], [[2, 2], [2, 0]], [[2, 2], [0, 2]], [[0, 0], [0, 2]]], float)
		(loop,) = check.loops(square)
		self.assertEqual(len(loop), 5)
		self.assertAlmostEqual(check.shoelace(loop), 4.0)

	def test_leading_sweep(self):
		# an untapered wing's leading edge sweeps as its quarter chord does
		self.assertAlmostEqual(check.leading_sweep(30, 4, 1.0), 30)
		self.assertGreater(check.leading_sweep(20, 3.5, 0.35), 20)

	def test_jet_cuts_in_stations(self):
		with tempfile.TemporaryDirectory() as d:
			path = Path(d) / "m.glb"
			# a box from FS 400 to 500, WL 100 to 120, BL -10 to 10 (model frame: x = (456 - FS) in, y = WL - 105, z = BL)
			i = 0.0254
			glb(path, [{"name": "fuselage", "mesh": box(((456 - 500) * i, -5 * i, -10 * i), ((456 - 400) * i, 15 * i, 10 * i))}])
			(Path(d) / "m.json").write_text(json.dumps({"joints": {}, "points": {}}))
			jet = check.Jet(path, Path(d) / "m.json")
			q = jet.cut(["fuselage"], [450, 100, 0], [1, 0, 0])
			np.testing.assert_allclose(q[:, 0], 450, atol=1e-6)
			self.assertAlmostEqual(q[:, 1].max() - q[:, 1].min(), 20, places=4)
			self.assertAlmostEqual(q[:, 2].max(), 10, places=4)
			with self.assertRaises(KeyError):
				jet.tris(["wing_inner_right"])
			# an empty selection is a missing part, reported, not a crash
			with self.assertRaises(KeyError):
				jet.tris([])

	def test_a_jet_short_of_parts_reports_every_group(self):
		# Every check run on a model of one box: each group either measures or
		# reports what it could not (a missing part, or nothing left to measure
		# in a cut or a selection), and the run as a whole never raises
		with tempfile.TemporaryDirectory() as d:
			path = Path(d) / "m.glb"
			i = 0.0254
			glb(path, [{"name": "fuselage", "mesh": box(((456 - 500) * i, -5 * i, -10 * i), ((456 - 400) * i, 15 * i, 10 * i))}])
			(Path(d) / "m.json").write_text(json.dumps({"joints": {}, "points": {}}))
			jet = check.Jet(path, Path(d) / "m.json")
			rows = list(check.checks(jet))
			missing = [r for r in rows if "missing" in r]
			self.assertTrue(missing)
			for r in rows:
				self.assertTrue("missing" in r or {"expected", "measured", "tolerance"} <= set(r), r)
			# a draft carries no atlas: its paint goes unchecked rather than failing
			self.assertFalse([r for r in rows if r["fact"].startswith("paint") or r["fact"] == "layout.stencils"])


def triangles(lo, hi):
	# a closed box's triangles in source coordinates (FS, WL, BL)
	v, f = box(lo, hi)
	return v[f]


class ShapeTest(unittest.TestCase):
	HULL = triangles((400, 100, -10), (500, 120, 10))

	def test_enclosed(self):
		inside = np.array([[450, 110, 0], [401, 101, 9.5]], float)
		self.assertTrue(check.enclosed(inside, self.HULL).all())
		# just outside each face in turn
		outside = np.array([[399, 110, 0], [501, 110, 0], [450, 99, 0], [450, 121, 0], [450, 110, -11], [450, 110, 11]], float)
		self.assertFalse(check.enclosed(outside, self.HULL).any())
		# a point under a lid with nothing beneath it: the stowed ladder beneath the LEX
		lid = triangles((400, 120, -10), (500, 121, 10))
		self.assertFalse(check.enclosed(np.array([[450, 110, 0]], float), lid).any())
		# inside walls open below (the LEX over its ladder well): every way but down meets the hull
		open_below = np.delete(self.HULL, [4, 5], axis=0)
		self.assertFalse(check.enclosed(np.array([[450, 110, 0]], float), open_below).any())
		# inside a tube open at its ends: along it nothing at all is met
		tube = np.delete(self.HULL, [6, 7, 10, 11], axis=0)
		self.assertFalse(check.enclosed(np.array([[450, 110, 0]], float), tube).any())

	def test_standoff(self):
		# a panel 0.15 in over the box's top, then one sunk 0.05 in into it, then one hanging under the belly
		top = triangles((420, 119.9, -5), (480, 120.15, 5))
		s = check.standoff(top, self.HULL)
		self.assertTrue(len(s))
		np.testing.assert_allclose(s, 0.15, atol=1e-6)
		sunk = triangles((420, 119.8, -5), (480, 119.95, 5))
		np.testing.assert_allclose(check.standoff(sunk, self.HULL), -0.05, atol=1e-6)
		hanging = triangles((420, 95, -5), (480, 96, 5))
		np.testing.assert_allclose(check.standoff(hanging, self.HULL, below=True), 5, atol=1e-6)
		# on a slope the gap counts along the skin's normal: a 45 deg roof with a panel 0.3 in above it vertically
		# a three-cornered panel whose edge walls lean out to its wider inner face, as an offset along
		# a sloping skin's normals leaves them: a look straight down at its outline sees the walls, not the panel
		outer = np.array([[420, 120.15, -5], [480, 120.15, -5], [420, 120.15, 5]], float)
		inner = np.array([[419.8, 119.9, -5.2], [480.5, 119.9, -5.2], [419.8, 119.9, 5.5]], float)
		walls = [t for i in range(3) for t in ((outer[i], outer[i - 1], inner[i - 1]), (outer[i], inner[i - 1], inner[i]))]
		wedge = np.array([outer, inner[::-1]] + walls)
		np.testing.assert_allclose(check.standoff(wedge, self.HULL), 0.15, atol=1e-6)
		roof = np.array([[[400, 100, 0], [500, 100, 0], [500, 120, 20]], [[400, 100, 0], [500, 120, 20], [400, 120, 20]]], float)
		panel = roof + np.array([0, 0.3, 0])
		np.testing.assert_allclose(check.standoff(panel[:, :, :], roof), 0.3 / math.sqrt(2), atol=1e-6)
		# over a crease each cell's gap counts along its own facet's normal: a 45 deg ridge, and a panel
		# 0.15 in off each face along its normal, meeting above the ridge (the speedbrake on the spine's
		# shoulder): a slope read across the cells either side of the ridge would see it level there
		ridge = np.array([[[400, 100, -20], [500, 100, -20], [500, 120, 0]], [[400, 100, -20], [500, 120, 0], [400, 120, 0]],
			[[400, 120, 0], [500, 120, 0], [500, 100, 20]], [[400, 120, 0], [500, 100, 20], [400, 100, 20]]], float)
		cap = ridge + np.array([0, 0.15 * math.sqrt(2), 0])
		np.testing.assert_allclose(check.standoff(cap, ridge), 0.15, atol=1e-6)

	def test_seam(self):
		# a plate lying 0.15 in over the box's top all along: one stays on top
		lid = triangles((420, 120.1, -8), (480, 120.15, 8))
		self.assertEqual(check.seam(lid, self.HULL, np.concatenate([lid, self.HULL]), "above"), 0.0)
		# a plate tilted 0.1 in over its 60 in, crossing the top halfway: it stands on top over one half and under
		# the other, all of it within half an inch, a ragged line
		tilt = triangles((420, 119.95, -8), (480, 120.0, 8))
		tilt[..., 1] += (tilt[..., 0] - 450) * 0.1 / 60
		ragged = check.seam(tilt, self.HULL, np.concatenate([tilt, self.HULL]), "above")
		self.assertGreater(ragged, 100)
		# the same, seen from below, where the box's own bottom hides it
		self.assertEqual(check.seam(tilt, self.HULL, np.concatenate([tilt, self.HULL]), "below"), 0.0)
		# the same under a cover: hidden, so no seam
		cover = triangles((410, 125, -12), (490, 126, 12))
		self.assertEqual(check.seam(tilt, self.HULL, np.concatenate([tilt, self.HULL, cover]), "above"), 0.0)
		# plates crossing the top off the grid's lines, steeply (45 deg) and less so (22 deg): clean lines, no
		# seam, though cells either side of each, within half an inch, have each on top
		for slope in (1.0, 0.4):
			steep = triangles((420, 119.9, -8), (480, 120.0, 8))
			steep[..., 1] += (steep[..., 0] - 450.2) * slope
			self.assertEqual(check.seam(steep, self.HULL, np.concatenate([steep, self.HULL]), "above"), 0.0, slope)
		# from outboard: the same tilted plate on the box's starboard side
		side = triangles((420, 102, 9.95), (480, 118, 10.0))
		side[..., 2] += (side[..., 0] - 450) * 0.1 / 60
		self.assertGreater(check.seam(side, self.HULL, np.concatenate([side, self.HULL]), "outboard"), 100)

	def test_bends(self):
		stations = np.arange(200.0, 400.0, 1.0)
		free = np.ones(len(stations), bool)
		rows = lambda line: np.stack([line, line, line])

		def creases(found):
			return [(stations[i], round(c, 2)) for _, i, _, c in found if abs(c) > 0.1]

		# a smooth curve, however tight, is no crease
		curve = rows(0.004 * (stations - 300) ** 2)
		found = check.bends(curve, 1.5, free)
		self.assertTrue(found)
		self.assertEqual(creases(found), [])
		self.assertGreater(max(abs(b) for _, _, b, _ in found), 1.5)
		# a kink is: the slope turning by 0.1 at FS 300 (5.7 deg), read at five-sixths of that (the 3 in average)
		kink = rows(np.where(stations < 300, 0.0, 0.1 * (stations - 300)))
		found = creases(check.bends(kink, 1.5, free))
		self.assertTrue(found)
		self.assertTrue(all(abs(s - 300) <= 2 for s, _ in found))
		self.assertAlmostEqual(max(abs(c) for _, c in found), math.degrees(math.atan(0.1)) * 5 / 6, delta=0.3)
		# not where the skin has a real edge, nor across a jump between surfaces, nor on a face turned away
		edge = free & ~((stations >= 290) & (stations <= 310))
		self.assertEqual(creases(check.bends(kink, 1.5, edge)), [])
		jump = kink + rows(np.where(stations < 297, 0.0, 1.0))
		self.assertEqual([s for s, _ in creases(check.bends(jump, 1.5, free)) if abs(s - 300) < 8], [])
		# unless no step is an edge: a cliff then reads as a sharp bend
		cliff = rows(np.where(stations < 300, 0.0, -6.0))
		self.assertEqual(creases(check.bends(cliff, 1.5, free)), [])
		self.assertGreater(max(abs(c) for _, c in creases(check.bends(cliff, 1.5, free, jump=None))), 30)
		steep = np.stack([kink[0], kink[0] + 1.2, kink[0] + 2.4])
		self.assertEqual(creases(check.bends(steep, 1.5, free)), [])
		# a mask per line: left out on the line whose mask holds the edge, read on the others
		wide = np.stack([kink[0]] * 4)
		masks = np.stack([free, edge, free, free])
		found = check.bends(wide, 1.5, masks)
		self.assertTrue(any(j == 2 and abs(c) > 0.1 for j, _, _, c in found))
		self.assertFalse(any(j == 1 and abs(stations[i] - 300) < 8 and abs(c) > 0.1 for j, i, _, c in check.bends(np.stack([kink[0]] * 3), 1.5, np.stack([free, edge, free]))))

	def test_seated(self):
		tris = lambda lo, hi: (lambda v, f: v[f])(*box(lo, hi))
		skin = tris((0.0, 90.0, -50.0), (100.0, 100.0, 50.0))   # its top at WL 100
		stations = np.arange(10.0, 90.0, 5.0)
		# a fin 2 in above the skin stands 2 in off it; one sunk half an inch, not at all
		self.assertAlmostEqual(check.seated(tris((5.0, 102.0, 38.0), (95.0, 160.0, 42.0)), skin, stations), 2.0, places=6)
		self.assertAlmostEqual(check.seated(tris((5.0, 99.5, 38.0), (95.0, 160.0, 42.0)), skin, stations), -0.5, places=6)
		# a foot that floats over part of its length is judged there
		lifted = np.concatenate([tris((5.0, 99.5, 38.0), (50.0, 160.0, 42.0)), tris((50.0, 103.0, 38.0), (95.0, 160.0, 42.0))])
		self.assertAlmostEqual(check.seated(lifted, skin, stations), 3.0, places=6)
		# one face of the foot lifted (the deck falls away outboard) is judged on that face
		v, f = box((5.0, 99.5, 38.0), (95.0, 160.0, 42.0))
		v[(v[:, 1] < 100) & (v[:, 2] > 40)] += [0.0, 2.5, 0.0]
		self.assertAlmostEqual(check.seated(v[f], skin, stations), 2.0, places=6)
		# and so is the inboard face
		v, f = box((5.0, 99.5, 38.0), (95.0, 160.0, 42.0))
		v[(v[:, 1] < 100) & (v[:, 2] < 40)] += [0.0, 2.5, 0.0]
		self.assertAlmostEqual(check.seated(v[f], skin, stations), 2.0, places=6)
		# a flat foot floating over a deck that falls outboard is judged where the deck lies lowest under it
		top = lambda bl: 101.0 - (bl - 38.0)   # WL 101 under the inboard face, 97 under the outboard
		corners = np.array([[0.0, top(30.0), 30.0], [100.0, top(30.0), 30.0], [100.0, top(48.0), 48.0], [0.0, top(48.0), 48.0]])
		falling = corners[np.array([(0, 1, 2), (0, 2, 3)])]
		self.assertAlmostEqual(check.seated(tris((5.0, 102.0, 38.0), (95.0, 160.0, 42.0)), falling, stations), 5.0, places=3)
		# every corner within a tenth of an inch of the lowest counts: tilted 0.1 in up outboard, the foot's
		# lowest corner on the outboard side is where the cut meets its closing face, not its outboard edge
		v, f = box((5.0, 102.0, 38.0), (95.0, 160.0, 42.0))
		v[(v[:, 1] < 103) & (v[:, 2] > 40)] += [0.0, 0.1, 0.0]
		self.assertAlmostEqual(check.seated(v[f], falling, np.arange(55.0, 90.0, 5.0)), 5.1, places=3)
		# a part high above its foot (a canted fin's tip) is not its foot
		tip = tris((5.0, 150.0, 60.0), (95.0, 160.0, 64.0))
		self.assertAlmostEqual(check.seated(np.concatenate([tris((5.0, 99.5, 38.0), (95.0, 104.0, 42.0)), tip]), skin, stations), -0.5, places=6)
		# a face slanting down into the skin (a canted fin's foot) is judged at its foot, not partway up
		slant = np.array([[0.0, 99.5, 36.0], [0.0, 99.5, 36.4], [0.0, 110.0, 40.0], [0.0, 110.0, 39.6]])
		v = np.concatenate([slant, slant + [100.0, 0.0, 0.0]])
		f = np.array([(0, 1, 2), (0, 2, 3), (4, 6, 5), (4, 7, 6), (0, 4, 5), (0, 5, 1), (1, 5, 6), (1, 6, 2), (2, 6, 7), (2, 7, 3), (3, 7, 4), (3, 4, 0)])
		self.assertAlmostEqual(check.seated(v[f], skin, stations), -0.5, places=6)
		# a canted fin on a root piece reaching into a deck that falls outboard: the
		# closing faces between them lie lower than the inboard foot at the
		# fin's middle, over deck lower still, and are not its foot
		def prism(outline):
			# an outline in (WL, BL) carried from FS 0 to 100, closed at both ends
			ring = np.array([[0.0, wl, bl] for wl, bl in outline])
			v = np.concatenate([ring, ring + [100.0, 0.0, 0.0]])
			n = len(ring)
			f = [(0, i, i + 1) for i in range(1, n - 1)] + [(n, n + i + 1, n + i) for i in range(1, n - 1)]
			f += [(i, (i + 1) % n, n + (i + 1) % n) for i in range(n)] + [(i, n + (i + 1) % n, n + i) for i in range(n)]
			return v[np.array(f)]
		lean = np.array([math.cos(math.radians(20)), math.sin(math.radians(20))])
		inner, outer = np.array([125.0, 35.8]), np.array([123.2, 40.8])
		deck = lambda bl: 124.8 - 0.55 * (bl - 35.54)
		fin = prism([inner, outer, outer + 30 * lean, inner + 30 * lean])
		piece = prism([inner, outer, outer - 1.4 * lean, inner - 0.75 * lean])
		sloped = prism([(deck(30.0), 30.0), (deck(48.0), 48.0), (90.0, 48.0), (90.0, 30.0)])
		self.assertLess(check.seated(np.concatenate([fin, piece]), sloped, stations), 0.0)
		# and the fin alone, its root above that deck, stands off it
		self.assertGreater(check.seated(fin, sloped, stations), 0.5)
		# no station cutting the part measures nothing
		self.assertTrue(np.isnan(check.seated(tris((5.0, 102.0, 38.0), (95.0, 160.0, 42.0)), skin, np.array([200.0]))))

	def test_waves(self):
		stations = np.arange(200.0, 400.0, 1.0)
		free = np.ones(len(stations), bool)
		line = lambda h: np.stack([h])
		heights = lambda found: [(f[1], f[2], round(f[3], 2)) for f in found]
		# a line narrowing steadily, or curving, or widest once, has no wave
		self.assertEqual(check.waves(line(20 - 0.05 * (stations - 200)), stations, free), [])
		self.assertEqual(check.waves(line(0.0004 * (stations - 300) ** 2), stations, free), [])
		self.assertEqual(check.waves(line(-0.0004 * (stations - 300) ** 2), stations, free), [])
		# a 0.4 in dip then hump on a narrowing line is: one dip and one hump, each about 0.4 deep or high
		bump = 0.2 * np.sin((stations - 300) * math.pi / 20) * (np.abs(stations - 300) <= 40)
		found = check.waves(line(20 - 0.005 * (stations - 200) - bump), stations, free)
		self.assertEqual(sorted(s for _, _, s, _ in found), [-1, 1])
		self.assertTrue(all(0.3 < h < 0.45 for _, _, _, h in found), heights(found))
		self.assertTrue(all(270 <= st <= 330 for _, st, _, _ in found), heights(found))
		# one within noise is not, on a level line
		self.assertEqual(check.waves(line(20 - bump / 10), stations, free), [])
		self.assertTrue(check.waves(line(20 - bump / 2), stations, free))
		# nor one whose turns lie further apart than twice the span
		long = 0.2 * np.cos((stations - 300) * math.pi / 60)   # turns at FS 240, 300 and 360
		self.assertEqual(check.waves(line(long), stations, free, span=40.0), [])
		self.assertTrue(check.waves(line(long), stations, free, span=80.0))
		# nor across the skin's edges, a line's gaps, or a step between surfaces
		wave = 20 - bump
		self.assertTrue(check.waves(line(wave), stations, free))
		self.assertEqual(check.waves(line(wave), stations, free & ~((stations > 285) & (stations < 315))), [])
		gap = wave.copy(); gap[(stations > 285) & (stations < 315)] = np.nan
		self.assertEqual(check.waves(line(gap), stations, free), [])
		step = wave + np.where(stations < 300, 0.0, 3.0)
		self.assertEqual(check.waves(line(step), stations, free), [])

	def test_surface_distance(self):
		triangle = np.array([[[0, 0, 0], [4, 0, 0], [0, 4, 0]]], float)
		points = np.array([[1, 1, 2], [1, 1, -0.5], [2, -3, 0], [6, 0, 0], [-1, -1, 1]], float)
		got = check.surface_distance(points, triangle)
		# over the face: to the plane; past an edge: to the edge; past a corner: to the corner
		for value, want in zip(got, [2.0, 0.5, 3.0, 2.0, math.sqrt(3)]):
			self.assertAlmostEqual(value, want)
		# the nearest of several, and a degenerate triangle is no surface: a point on one measures to the skin
		two = np.concatenate([triangle, triangle + [0, 0, 1]])
		self.assertAlmostEqual(check.surface_distance(np.array([[1, 1, 2.0]]), two)[0], 1.0)
		flat = np.concatenate([triangle + [0, 0, 1], np.zeros((1, 3, 3))])
		self.assertAlmostEqual(check.surface_distance(np.zeros((1, 3)), flat)[0], 1.0)

	def test_polygons(self):
		square = np.array([[0, 0], [2, 0], [2, 2], [0, 2]], float)
		self.assertTrue(check.inside_polygon(np.array([1.0, 1.0]), square))
		self.assertFalse(check.inside_polygon(np.array([2.5, 1.0]), square))
		segments = np.stack([square, np.roll(square, -1, axis=0)], 1)
		self.assertAlmostEqual(check.segment_distance(np.array([2.5, 1.0]), segments), 0.5)
		self.assertAlmostEqual(check.segment_distance(np.array([3.0, 3.0]), segments), math.sqrt(2))
		# the same outline as segments in any order, some reversed
		jumbled = segments[[2, 0, 3, 1]].copy()
		jumbled[1] = jumbled[1][::-1]
		self.assertTrue(check.inside_segments(np.array([1.0, 1.0]), jumbled))
		self.assertFalse(check.inside_segments(np.array([2.5, 1.0]), jumbled))
		self.assertFalse(check.inside_segments(np.array([1.0, -0.5]), jumbled))

	def test_a_measurement_of_nothing_fails(self):
		self.assertTrue(check.failed(check.result("x", "y", 1.0, float("nan"), 0.5)))
		self.assertTrue(check.failed(check.result("x", "y", 1.0, float("inf"), 0.5)))
		self.assertFalse(check.failed(check.result("x", "y", 1.0, 1.2, 0.5)))

	def test_coverage(self):
		# texels whose centre two triangles both hold count 2; a texel on a
		# shared edge counts for neither, so a mesh's own seams never read as overlap
		quad = np.array([[[0.1, 0.1], [0.9, 0.1], [0.9, 0.9]], [[0.1, 0.1], [0.9, 0.9], [0.1, 0.9]]])
		count = check.coverage(quad, 10)
		self.assertEqual(int((count >= 2).sum()), 0)
		self.assertEqual(int((count == 1).sum()), 64 - 8)   # the 8 x 8 texels inside, less the diagonal's 8
		folded = np.concatenate([quad, quad[:1]])
		self.assertEqual(int((count >= 2).sum()) + int((check.coverage(folded, 10) >= 2).sum()), 28)

	def test_sample(self):
		# read between texels, the image's first row at v = 0 (glTF's v runs down)
		image = np.array([[0.0, 1.0], [0.5, 0.5]])
		got = check.sample(image, np.array([[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.5, 0.25]]))
		for value, want in zip(got, [0.0, 1.0, 0.5, 0.5]):
			self.assertAlmostEqual(value, want)

	def test_hits(self):
		tris = np.array([[[0, 0, 0], [4, 0, 0], [0, 4, 0]], [[0, 0, -2], [4, 0, -2], [0, 4, -2]]], float)
		k, bary = check.hits(tris, np.array([[1.0, 2.0, 5.0], [9.0, 9.0, 5.0]]), np.array([0.0, 0.0, -1.0]))
		self.assertEqual(list(k), [0, -1])   # the nearer of the two; a miss is -1
		self.assertAlmostEqual(bary[0, 0], 0.25)
		self.assertAlmostEqual(bary[0, 1], 0.5)

	def test_atlas(self):
		# the paint material's base colour image, as brightness; none on a model without one
		import io
		from PIL import Image
		with tempfile.TemporaryDirectory() as folder:
			plain = Path(folder) / "plain.glb"
			v, f = box((0, 0, 0), (1, 1, 1))
			glb(plain, [{"name": "fuselage", "mesh": (v, f)}])
			self.assertIsNone(check.atlas(plain))
			png = io.BytesIO()
			Image.fromarray(np.array([[0, 255], [128, 64]], np.uint8)).save(png, "PNG")
			png = png.getvalue() + b"\0" * (-len(png.getvalue()) % 4)
			document = {"asset": {"version": "2.0"}, "materials": [{"name": "glass"}, {"name": "paint", "pbrMetallicRoughness": {"baseColorTexture": {"index": 0}}}],
				"textures": [{"source": 0}], "images": [{"bufferView": 0, "mimeType": "image/png"}],
				"bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": len(png)}], "buffers": [{"byteLength": len(png)}]}
			text = json.dumps(document).encode()
			text += b" " * (-len(text) % 4)
			body = len(text).to_bytes(4, "little") + b"JSON" + text + len(png).to_bytes(4, "little") + b"BIN\0" + png
			painted = Path(folder) / "painted.glb"
			painted.write_bytes(b"glTF" + (2).to_bytes(4, "little") + (12 + len(body)).to_bytes(4, "little") + body)
			got = check.atlas(painted)
			self.assertEqual(got.shape, (2, 2))
			self.assertAlmostEqual(got[0, 1], 1.0)
			self.assertAlmostEqual(got[1, 0], 128 / 255)

	def test_mirrored(self):
		left = np.array([[400, 100, -20], [420, 110, -10]], float)
		self.assertAlmostEqual(check.mirrored(left, left * [1, 1, -1]), 0)
		# the same part on the same side is no mirror image
		self.assertAlmostEqual(check.mirrored(left, left), 30)
		self.assertAlmostEqual(check.mirrored(left, left * [1, 1, -1] + [0, 0.4, 0]), 0.4)


class TipsTest(unittest.TestCase):
	# A wing's two marked corners photographed by a known camera, their marks
	# drawn where the corners would be raised: the fit finds the raise, as a
	# shift of the whole surface or as a turn about its root
	SPAN = (54.5, 224.5)

	def setUp(self):
		import camera as cam
		import photos as ph
		import tips
		self.cam, self.tips = cam, tips
		self.dir = tempfile.TemporaryDirectory()
		root = Path(self.dir.name)
		i = 0.0254
		at = lambda fs, wl, bl: [(456 - fs) * i, (wl - 105) * i, bl * i]
		self.corners = {"wingtip_trailing_right": at(556, 104, 224.5), "fold_trailing_right": at(560, 107, 160)}
		# an aileron hinged at FS 540 on the tip's trailing corner, the fixed wing's leading corner ahead
		hinge = np.array(at(540, 105, 0))
		self.leading = at(500, 105, 224.5)
		self.joints = {"aileron_right": {"motion": "rotate", "axis": [0, 0, 1], "drive": "flaperon.right", "keys": [[0, 0], [1, 1]]}}
		glb(root / "m.glb", [{"name": "wing_right", "mesh": box(at(560, 103, 54.5), at(480, 108, 224.5))},
			{"name": "aileron_right", "translation": tuple(hinge), "mesh": box(np.array(at(560, 104, 180)) - hinge, np.array(at(540, 106, 224.5)) - hinge)}])
		landmarks = {n: {"at": p, "node": "wing_right"} for n, p in self.corners.items()}
		(root / "f.json").write_text(json.dumps({"landmarks": landmarks}))
		landmarks = {"wingtip_leading_right": {"at": self.leading, "node": "wing_right"}, "wingtip_trailing_right": {"at": self.corners["wingtip_trailing_right"], "node": "aileron_right"}}
		(root / "hinged.json").write_text(json.dumps({"landmarks": landmarks}))
		self.root = root
		self.camera = cam.looking(np.array(at(500, 250, 400)), np.array(at(540, 105, 150)), 3000.0)
		self.size = (3000, 2000)
		self.frame = {"names": ["station", "waterline", "buttline"], "unit": i, "origin": [456, 105, 0], "axes": [[-1, 0, 0], [0, 1, 0], [0, 0, 1]], "mirror": "buttline"}
		model = check.verify.Model(root / "m.glb")
		self.features = ph.Features(model, {}, root / "f.json")
		self.model = model

	def tearDown(self):
		self.dir.cleanup()

	def marks(self, raise_, turned):
		# where the corners stand raised `raise_` inches at the tip, in the photo
		marks = {}
		for name, p in self.corners.items():
			share = (abs(p[2]) / 0.0254 - self.SPAN[0]) / (self.SPAN[1] - self.SPAN[0]) if turned else 1.0
			point = np.array(p) + np.array([0, 0.0254, 0]) * raise_ * share
			marks[name] = list(self.cam.project(self.camera, point[None], np.array(self.size, float) / 2)[0][0])
		return marks

	def fit(self, raise_, turned, rotate, **more):
		# the fit over one photo, or more photos given as {id: raise}
		raises = {"p": raise_, **more.pop("photos", {})}
		catalogue = {"frame": self.frame, "photos": {k: {"marks": self.marks(r, turned)} for k, r in raises.items()}}
		cameras = [{"photo": k, "size": list(self.size), "camera": list(self.camera)} for k in raises]
		tips = self.tips.Tips(catalogue, cameras, self.model, {}, self.features)
		kind = {"marks": list(self.corners), "span": self.SPAN}
		return tips.fit(kind, neutral=True, rotate=rotate, **more)

	def test_a_photo_left_out(self):
		both = self.fit(5.0, False, False, photos={"q": 1.0})[0]
		self.assertGreater(both, 1.5)
		self.assertLess(both, 4.5)
		self.assertAlmostEqual(self.fit(5.0, False, False, photos={"q": 1.0}, leave="q")[0], 5.0, places=3)

	def test_a_raised_surface(self):
		offset, _, misses = self.fit(5.0, False, False)
		self.assertAlmostEqual(offset, 5.0, places=3)
		self.assertLess(max(m[3] for m in misses), 0.01)

	def test_a_turned_surface(self):
		offset, _, misses = self.fit(5.0, True, True)
		self.assertAlmostEqual(offset, 5.0, places=3)
		self.assertLess(max(m[3] for m in misses), 0.01)
		# fitted as a shift, a turn leaves the fold and the tip apart
		offset, _, misses = self.fit(5.0, True, False)
		self.assertGreater(max(m[3] for m in misses), 0.3)

	def test_a_deflection_is_fitted_beside_the_raise(self):
		import photos as ph
		features = ph.Features(self.model, self.joints, self.root / "hinged.json")
		marks = {}
		for name in ("wingtip_leading_right", "wingtip_trailing_right"):
			point = features.landmark(name, {"flaperon.right": 0.2}) + np.array([0, 0.0254, 0]) * 3.0
			marks[name] = list(self.cam.project(self.camera, point[None], np.array(self.size, float) / 2)[0][0])
		catalogue = {"frame": self.frame, "photos": {"p": {"marks": marks}}}
		tips = self.tips.Tips(catalogue, [{"photo": "p", "size": list(self.size), "camera": list(self.camera)}], self.model, self.joints, features)
		kind = {"marks": ["wingtip_leading_right", "wingtip_trailing_right"], "span": self.SPAN}
		offset, deflections, _ = tips.fit(kind)
		self.assertAlmostEqual(offset, 3.0, places=2)
		self.assertAlmostEqual(deflections[("p", "flaperon.right")], 0.2, places=3)
		# held neutral, the deflection has nowhere to go but the raise
		offset, deflections, misses = tips.fit(kind, neutral=True)
		self.assertEqual(deflections, {})
		self.assertGreater(max(m[3] for m in misses), 0.3)

	def test_the_spans_come_from_the_facts(self):
		k = self.tips.kinds()
		self.assertEqual(k["wing"]["span"][0], check.FACTS["layout"]["wing"]["buttline"])
		self.assertAlmostEqual(k["stabilator"]["span"][1] - k["stabilator"]["span"][0], check.value(check.FACTS["stabilator"]["exposed"]) * 6)


if __name__ == "__main__":
	unittest.main()
