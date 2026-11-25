# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# usage: python3 -I test_check.py
import ast, json, math, re, subprocess, sys, tempfile, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "verify"))

import numpy as np  # noqa: E402

import check  # noqa: E402
from test_verify import box, glb, guess_counts  # noqa: E402


class StoresTest(unittest.TestCase):
	def test_a_station_names_its_twin(self):
		self.assertEqual(check.STATION.match("rail_2a").groups(), ("rail", "2", "a"))
		self.assertEqual(check.STATION.match("tank_7").groups(), ("tank", "7", ""))
		for name in ("flex_rail_left", "rail_tip", "wing_left", "gear_nose_door_left", "flex_pylon_2"):
			self.assertIsNone(check.STATION.match(name), name)

	def test_slope_at_the_tip(self):
		# a wing rising 0.02 in per inch out to its tip at BL 225: the slope at
		# the tip itself reads the same, not half of it
		buttlines = np.arange(40.0, 225.5, 0.5)
		rises = 0.02 * (buttlines - 40.0)
		self.assertAlmostEqual(check.slope_at(buttlines, rises, 225.0), 0.02, places=6)
		self.assertAlmostEqual(check.slope_at(buttlines, rises, 130.0), 0.02, places=6)


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

	def test_no_key_twice(self):
		# a key written twice in one object reads as its last alone, and hides
		# the first from the build and the check alike
		twice = []

		def pairs(items):
			keys = [k for k, _ in items]
			twice.extend(sorted({k for k in keys if keys.count(k) > 1}))
			return dict(items)

		json.loads((HERE / "facts.json").read_text(), object_pairs_hook=pairs)
		self.assertEqual(twice, [])

	def test_no_fact_is_a_guess(self):
		# A shape no source shows is asked about, never guessed: any facts.json
		# text saying it is guessed ("by eye", "estimated", "not measured", "unseen": verify's GUESS) is a guess unless the user signed it off
		# (check.GUESSES), and a sign-off names a text that still says it
		counts = guess_counts(check.FACTS)
		unsigned = [f"{p}: says it is guessed (verify's GUESS words), no source measured it and the user has not signed it off (check.GUESSES)" for p in sorted(set(counts) - set(check.GUESSES))]
		stale = [f"{p}: signed off in check.GUESSES but no longer says it is guessed" for p in sorted(set(check.GUESSES) - set(counts))]
		grown = [f"{p}: holds {counts[p]} guesses where the sign-off covers {check.GUESSES[p][0]}: ask the user about the new one" for p in sorted(set(counts) & set(check.GUESSES)) if counts[p] != check.GUESSES[p][0]]
		self.assertFalse(unsigned + stale + grown, "\n" + "\n".join(unsigned + stale + grown))


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

	def test_loops_from_a_segment_part_way_along(self):
		# a cut's segments come in no order: a loop whose first-listed segment
		# lies part way along an open chain, the rest listed back to front,
		# still chains whole, walking back from that segment as well as on
		chain = np.array([[[2, 0], [3, 0]], [[1, 0], [2, 0]], [[0, 0], [1, 0]], [[3, 0], [4, 0]]], float)
		(loop,) = check.loops(chain)
		self.assertEqual([tuple(p) for p in loop], [(0, 0), (1, 0), (2, 0), (3, 0), (4, 0)])

	def test_inverted_finds_a_closed_island_turned_inward(self):
		# a box turned out passes, the same box turned in is found with its
		# volume, and beside an outward one only the inward island counts,
		# far from the origin as a part's islands lie
		v, f = box((400, 100, 30), (410, 102, 33))
		out = np.asarray(v, float)[np.asarray(f)]
		inward = out[:, ::-1]
		self.assertEqual(check.inverted(out), [])
		(volume,) = check.inverted(inward)
		self.assertAlmostEqual(volume, -60.0, places=6)
		self.assertEqual(len(check.inverted(np.concatenate([out + [0, 0, 20], inward]))), 1)

	def test_inverted_judges_an_island_without_faces_touching_it_at_corners(self):
		# a thin closed slab turned out (the cabin scoop's door), with a broad
		# flap at each side touching it at one corner and sharing none of its
		# edges, facing each other: joined at the corners, the three enclose
		# -47 in3 wherever the volume is taken from; judged as the build's
		# islands are, the slab stands alone, turned out
		v, f = box((400, 100, 30), (410, 100.1, 33))
		slab = np.asarray(v, float)[np.asarray(f)]
		flaps = np.array([[[400, 100, 33], [400, 110, 33], [410, 110, 33]], [[400, 100, 30], [410, 110, 30], [400, 110, 30]]], float)
		self.assertEqual(check.inverted(np.concatenate([slab, flaps])), [])

	def test_inverted_leaves_an_open_shell_unjudged(self):
		# a box with one end left open turned in, as an inlet's skin and duct
		# or a well are open shells: its volume swings with the origin, so it
		# is not judged
		v, f = box((400, 100, 30), (410, 102, 33))
		inward = np.asarray(v, float)[np.asarray(f)][:, ::-1]
		ends = np.abs(inward[:, :, 0] - 400).max(axis=1) < 1e-9
		self.assertEqual(ends.sum(), 2)
		self.assertEqual(check.inverted(inward[~ends]), [])

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

	def test_only_runs_the_groups_it_names(self):
		# --only (chosen()): the groups whose fact is named, exactly, and every
		# group without it
		self.assertTrue(check.chosen("layout.motion", []))
		self.assertTrue(check.chosen("layout.motion", ["layout.motion"]))
		self.assertTrue(check.chosen("layout", ["wing", "layout"]))
		self.assertFalse(check.chosen("layout.motion", ["layout"]))
		self.assertFalse(check.chosen("layout", ["layout.motion"]))
		with tempfile.TemporaryDirectory() as d:
			path = Path(d) / "m.glb"
			i = 0.0254
			glb(path, [{"name": "fuselage", "mesh": box(((456 - 500) * i, -5 * i, -10 * i), ((456 - 400) * i, 15 * i, 10 * i))}])
			(Path(d) / "m.json").write_text(json.dumps({"joints": {}, "points": {}}))
			jet = check.Jet(path, Path(d) / "m.json")
			every, seen = list(check.checks(jet)), set()
			some = list(check.checks(jet, ["overall"], seen))
			# the one group's rows alone, the same as a whole run gives them
			self.assertTrue(some)
			self.assertEqual(some, [r for r in every if r["fact"].startswith("overall")])
			# every group is seen, run or not
			self.assertTrue({"overall", "layout.motion", "paint", "wing"} <= seen)
			# a name no group has fails the run, naming the groups
			run = subprocess.run([sys.executable, "-I", str(Path(check.__file__)), str(path), str(Path(d) / "m.json"), "--only", "overall,wings"], capture_output=True, text=True)
			self.assertNotEqual(run.returncode, 0)
			self.assertIn("--only wings: no group of that name", run.stderr)
			self.assertIn("layout.motion", run.stderr)


class UnoccludedTest(unittest.TestCase):
	# The ambient occlusion check.py casts as build.py's lend() does
	# (unoccluded()), at a point facing up: an open sky with a floor 200 in
	# below, lying on a floor, under a roof 40 in up, under the roof with a
	# round hole 40 in across overhead (half the cosine-weighted sky; 0.29
	# were the rays spread evenly over the hemisphere)
	@staticmethod
	def plane(z, big=1e4):
		return np.array([[[-big, -big, z], [big, -big, z], [big, big, z]], [[-big, -big, z], [big, big, z], [-big, big, z]]])

	def cast(self, tris):
		return float(check.unoccluded(tris, np.array([[0.0, 0.0, 0.0]]), np.array([[0.0, 0.0, 1.0]]))[0])

	def test_an_open_sky_is_unoccluded_and_a_roof_hides_it_all(self):
		self.assertEqual(self.cast(self.plane(-200.0)), 1.0)
		self.assertEqual(self.cast(self.plane(40.0)), 0.0)

	def test_a_point_on_a_face_is_not_shaded_by_that_face(self):
		self.assertEqual(self.cast(self.plane(0.0)), 1.0)

	def test_a_face_a_hair_over_the_point_does_not_shade_it(self):
		# a thousandth of an inch up, inside the tenth of a millimetre the
		# rays start off the face, as build.py's do
		self.assertEqual(self.cast(np.concatenate([self.plane(0.0), self.plane(0.001)])), 1.0)

	def test_a_hole_overhead_passes_its_share_of_the_cosine_weighted_sky(self):
		ring = [(40 * math.cos(2 * math.pi * k / 256), 40 * math.sin(2 * math.pi * k / 256)) for k in range(256)]
		quads = [((x0, y0, 40.0), (x1, y1, 40.0), (1e4 * x1, 1e4 * y1, 40.0), (1e4 * x0, 1e4 * y0, 40.0)) for (x0, y0), (x1, y1) in zip(ring, ring[1:] + ring[:1])]
		holed = np.array([t for a, b, c, d in quads for t in ((a, b, c), (a, c, d))])
		self.assertAlmostEqual(self.cast(holed), 0.5, delta=0.04)


class AcrossTest(unittest.TestCase):
	# The points a narrow strip's light is judged at (check.across()), at a
	# triangle's middle from its longest edge to the side opposite
	def test_they_run_from_the_longest_edge_to_the_side_opposite_at_the_middle(self):
		# a sliver 6 long and 0.3 across, its far corner a third of the way
		# along: its middle (8/3 along) lies past that corner, so the far end
		# is on the side from the far corner to the long edge's end
		t = np.array([[0.0, 0.0, 0.0], [6.0, 0.0, 0.0], [2.0, 0.3, 0.0]])
		points = check.across(t)
		self.assertEqual(points.shape, (5, 3))
		np.testing.assert_allclose(points[:, 0], 8 / 3)
		np.testing.assert_allclose(points[0], [8 / 3, 0.0, 0.0], atol=1e-12)
		np.testing.assert_allclose(points[-1, 1], 0.25)
		np.testing.assert_allclose(np.diff(points[:, 1]), 0.25 / 4)

	def test_a_far_corner_past_the_middle_puts_the_far_end_on_the_side_from_the_start(self):
		t = np.array([[0.0, 0.0, 0.0], [6.0, 0.0, 0.0], [4.0, 0.3, 0.0]])
		points = check.across(t)
		np.testing.assert_allclose(points[:, 0], 10 / 3)
		np.testing.assert_allclose(points[-1], [10 / 3, 0.25, 0.0], atol=1e-12)


class ShownTest(unittest.TestCase):
	# The shade an atlas brightness shows on a face (check.shown()), the
	# inverse of build.py's paint: the grey there times 0.4 + 0.6 of the shade
	def grey(self, colour):
		return float(np.dot(colour, [0.299, 0.587, 0.114])) / 255

	def test_a_face_up_shows_its_shade_on_the_upper_grey_and_one_facing_down_on_the_lower(self):
		p = check.FACTS["layout"]["paint"]
		for shade in (0.0, 0.3, 1.0):
			self.assertAlmostEqual(check.shown(self.grey(p["upper"]) * (0.4 + 0.6 * shade), [0.0, 1.0, 0.0]), shade, places=9)
			self.assertAlmostEqual(check.shown(self.grey(p["lower"]) * (0.4 + 0.6 * shade), [0.0, -1.0, 0.0]), shade, places=9)

	def test_a_face_in_the_turn_shows_it_on_the_greys_blended_as_the_build_blends_them(self):
		p = check.FACTS["layout"]["paint"]
		start, end = p["turn"]
		f = 0.25 * 0.25 * (3 - 2 * 0.25)   # a quarter of the way through the turn, eased
		grey = self.grey(p["upper"]) * (1 - f) + self.grey(p["lower"]) * f
		self.assertAlmostEqual(check.shown(grey * (0.4 + 0.6 * 0.7), [0.0, start + (end - start) / 4, 0.0]), 0.7, places=9)


class BuriedTest(unittest.TestCase):
	# A flush lens's outer face under the skin it stands on (check.buried()),
	# on models of boxes: a lens plate on the right at BL 50-50.2 and a
	# carrier reaching out to BL 50 (the lens clear of it) or to BL 51 over
	# the lens's upper half (that half under its skin)
	def jet(self, d, reach):
		i = 0.0254
		model = lambda lo, hi: box(((456 - hi[0]) * i, (lo[1] - 105) * i, lo[2] * i), ((456 - lo[0]) * i, (hi[1] - 105) * i, hi[2] * i))
		glb(Path(d) / "m.glb", [{"name": "lex_right", "mesh": model(reach[0], reach[1])},
			{"name": "lamp_position_lex_right", "mesh": model((383.0, 116.6, 50.0), (385.0, 118.6, 50.2))}])
		(Path(d) / "m.json").write_text(json.dumps({"joints": {}, "points": {}}))
		return check.Jet(Path(d) / "m.glb", Path(d) / "m.json")

	def share(self, reach):
		with tempfile.TemporaryDirectory() as d:
			return check.buried(self.jet(d, reach), "lamp_position_lex_right", "lex_right", np.array([0.0, 0.0, 1.0]))

	def test_a_lens_on_its_face_is_whole(self):
		self.assertEqual(self.share(((370.0, 110.0, 0.0), (400.0, 125.0, 50.0))), 0.0)

	def test_a_lens_half_under_the_skin_reads_half(self):
		self.assertAlmostEqual(self.share(((370.0, 117.6, 0.0), (400.0, 125.0, 51.0))), 0.5, places=6)


class PanelLinesTest(unittest.TestCase):
	# Every panel line layout.panels gives against the skin (check.panel_lines()):
	# those cast by hand and mirrored, and those the charts traced, each keyed
	# as build.py given_lines() counts them, so a row names the line the paint
	# would refuse; on a plate of skin at WL 120
	plate = np.array([[[590, 120, -60], [710, 120, -60], [710, 120, 60]], [[590, 120, -60], [710, 120, 60], [590, 120, 60]]], float)
	panels = {"lines": [[[610, 120, 10], [620, 120, 10]]], "mirrored": [[[630, 120, 20], [640, 120, 20]]],
		"traced": [[[650, 120, 30], [660, 120, 30]], [[670, 122, 40], [680, 122, 40]]]}

	def rows(self, panels):
		return {r["what"].split(" (")[0]: r for r in check.panel_lines(self.plate, panels)}

	def test_a_traced_line_off_the_skin_fails_under_the_key_the_build_gives_it(self):
		rows = self.rows(self.panels)
		self.assertEqual(sorted(rows), ["panel line 0", "panel line 1", "panel line 3", "panel line 4"])
		self.assertTrue(check.failed(rows["panel line 4"]))
		self.assertAlmostEqual(rows["panel line 4"]["measured"], 2.0, places=6)
		self.assertFalse(any(check.failed(rows[k]) for k in ("panel line 0", "panel line 1", "panel line 3")))

	def test_its_key_is_the_one_build_py_counts(self):
		tree = ast.parse((HERE / "build.py").read_text())
		found = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "given_lines"]
		space = {"LAYOUT": {"panels": self.panels}}
		exec(compile(ast.Module(body=found, type_ignores=[]), "build.py", "exec"), space)
		given = space["given_lines"]()
		self.assertEqual([list(map(list, given[k])) for k in (3, 4)], self.panels["traced"])

	def test_a_line_with_no_skin_near_it_is_missing(self):
		with self.assertRaises(KeyError):
			list(check.panel_lines(self.plate, {"lines": [], "mirrored": [], "traced": [[[900, 120, 0], [910, 120, 0]]]}))


class LensesTest(unittest.TestCase):
	# The lamps' lenses (check.lenses()), on models of boxes built to
	# layout.lights lenses: each wearing its glass's finish in its measured
	# colour, the LEX lenses full width over their forward 60% and narrowed to
	# their aft share behind, the strobes, the tail light and the fold lights
	# their measured sizes; then each broken in turn
	L = check.FACTS["layout"]["lights"]["lenses"]

	def lens(self, at, length, up, across):
		# a box about [FS, WL, BL], its length along the station, its height up
		# and its width across, in source inches
		i, (f, w, b) = 0.0254, at
		return box(((456 - f - length / 2) * i, (w - up / 2 - 105) * i, (b - across / 2) * i), ((456 - f + length / 2) * i, (w + up / 2 - 105) * i, (b + across / 2) * i))

	def tapered(self, at, length, width, aft):
		# the LEX lens: full width over its forward 60%, its aft share behind
		f, w, b = at
		front, back = self.lens((f - length / 2 + 0.3 * length, w, b), 0.6 * length, width, 0.2), self.lens((f + 0.3 * length, w, b), 0.4 * length, width * aft, 0.2)
		return np.concatenate([front[0], back[0]]), np.concatenate([front[1], back[1] + len(front[0])])

	def results(self, broken=None):
		L, points = self.L, check.FACTS["layout"]["lights"]["points"]
		parts = {}
		for side, sign in (("left", -1), ("right", 1)):
			f, w, b = points[f"position_lex_{side}"]["at"]
			parts[f"lamp_position_lex_{side}"] = self.tapered((f, w, b), L["lex"]["length"], L["lex"]["width"], L["lex"]["aft"])
			f, w, b = points[f"strobe_{side}"]["at"]
			parts[f"lamp_strobe_{side}"] = self.lens((f, w, b), L["strobe"]["length"], L["strobe"]["width"], 0.2)
			f, w, b = points[f"position_fold_{side}"]["at"]
			parts[f"lamp_position_fold_{side}"] = self.lens((f, w, b), L["fold"]["width"], L["fold"]["width"], L["fold"]["width"])
		parts["lamp_position_tail"] = self.lens(points["position_tail"]["at"], 0.2, L["tail"]["diameter"], L["tail"]["diameter"])
		finishes = dict(check.LENSES)
		colours = {name: tuple(np.where(np.asarray(c) / 255 <= 0.04045, np.asarray(c) / 255 / 12.92, ((np.asarray(c) / 255 + 0.055) / 1.055) ** 2.4)) for name, c in L["colours"].items()}
		if broken:
			broken(parts, finishes, colours)
		with tempfile.TemporaryDirectory() as d:
			glb(Path(d) / "m.glb", [{"name": n, "mesh": m, "material": finishes[n]} for n, m in parts.items()], colours)
			(Path(d) / "m.json").write_text(json.dumps({"joints": {}, "points": {}}))
			rows = list(check.lenses(check.Jet(Path(d) / "m.glb", Path(d) / "m.json")))
		return [r["what"] for r in rows if check.failed(r)], len(rows)

	def test_lenses_built_to_the_photos_pass(self):
		failed, count = self.results()
		self.assertEqual(failed, [])
		self.assertEqual(count, 4 + 7 + 2 * 5 + 2 + 2)

	def test_a_lens_in_the_strips_finish_fails(self):
		def broken(parts, finishes, colours):
			finishes["lamp_position_lex_right"] = "lights"
		self.assertEqual(self.results(broken)[0], ["lamp_position_lex_right wearing starboard (it wears lights)"])

	def test_a_finish_off_the_photos_colour_fails(self):
		def broken(parts, finishes, colours):
			colours["starboard"] = colours["port"]
		self.assertEqual(self.results(broken)[0], ["starboard lenses' base colour off the photos', linear"])

	def test_a_strobe_too_short_fails(self):
		def broken(parts, finishes, colours):
			f, w, b = check.FACTS["layout"]["lights"]["points"]["strobe_left"]["at"]
			parts["lamp_strobe_left"] = self.lens((f, w, b), 7.0, self.L["strobe"]["width"], 0.2)
		self.assertEqual(self.results(broken)[0], ["strobe_left lens's length"])

	def test_a_lex_lens_not_narrowing_aft_fails(self):
		def broken(parts, finishes, colours):
			f, w, b = check.FACTS["layout"]["lights"]["points"]["position_lex_left"]["at"]
			parts["lamp_position_lex_left"] = self.lens((f, w, b), self.L["lex"]["length"], self.L["lex"]["width"], 0.2)
		self.assertEqual(self.results(broken)[0], ["position_lex_left lens's width near its aft end (5/6 of the way aft)"])

	def test_a_tail_lens_too_small_and_a_fold_lens_too_wide_fail(self):
		def broken(parts, finishes, colours):
			points = check.FACTS["layout"]["lights"]["points"]
			parts["lamp_position_tail"] = self.lens(points["position_tail"]["at"], 0.2, 1.0, 1.0)
			parts["lamp_position_fold_right"] = self.lens(points["position_fold_right"]["at"], 1.2, 1.2, 2.0)
		self.assertEqual(self.results(broken)[0], ["position_fold_right lens across", "tail light's lens up", "tail light's lens across"])

	def test_a_lens_not_built_is_missing(self):
		def broken(parts, finishes, colours):
			del parts["lamp_strobe_right"]
		with self.assertRaises(KeyError):
			self.results(broken)


class SlotTest(unittest.TestCase):
	# A slot cut down through a surface (check.slot_open()), on triangles in
	# [FS, WL, BL] inches: a top at WL 127 from BL 10 to 50 over FS 400-460,
	# with or without the strip BL 24.3-27.3, FS 405-450 taken out, and a floor
	# at WL 110 beneath it
	ends = np.array([[408.7, 127.0, 25.8], [446.7, 127.0, 25.8]])

	def quad(self, f0, f1, b0, b1, wl):
		a, b, c, d = [[f0, wl, b0], [f1, wl, b0], [f1, wl, b1], [f0, wl, b1]]
		return [[a, b, c], [a, c, d]]

	def surface(self, cut):
		tris = self.quad(400, 460, 10, 50, 110.0)
		if cut:
			for f0, f1, b0, b1 in ((400, 460, 10, 24.3), (400, 460, 27.3, 50), (400, 405, 24.3, 27.3), (450, 460, 24.3, 27.3)):
				tris += self.quad(f0, f1, b0, b1, 127.0)
		else:
			tris += self.quad(400, 460, 10, 50, 127.0)
		return np.array(tris, float)

	def test_an_open_slot_drops_to_its_floor_and_leaves_the_top_beside_it(self):
		drop, beside = check.slot_open(self.surface(True), self.ends, 1)
		self.assertAlmostEqual(drop, 17.0, places=6)
		self.assertAlmostEqual(beside, 0.0, places=6)

	def test_an_uncut_top_does_not_drop(self):
		drop, beside = check.slot_open(self.surface(False), self.ends, 1)
		self.assertAlmostEqual(drop, 0.0, places=6)
		self.assertAlmostEqual(beside, 0.0, places=6)

	def test_a_top_cut_away_beside_the_slot_reads_how_far_it_falls(self):
		drop, beside = check.slot_open(self.quad_only_floor(), self.ends, 1)
		self.assertEqual(drop, 17.0)
		self.assertAlmostEqual(beside, 17.0, places=6)

	def quad_only_floor(self):
		return np.array(self.quad(400, 460, 10, 50, 110.0), float)


class AloftTest(unittest.TestCase):
	# How far a plate laid on a skin stands off it (check.aloft()), on models
	# of boxes: a skin out to BL 50 and a plate on it from BL 50 to `top`
	def stands(self, top):
		with tempfile.TemporaryDirectory() as d:
			jet = BuriedTest().jet(d, ((370.0, 110.0, 0.0), (400.0, 125.0, 50.0)))
			i = 0.0254
			plate = box(((456 - 385.0) * i, (116.6 - 105) * i, 50.0 * i), ((456 - 383.0) * i, (118.6 - 105) * i, top * i))
			v, f = plate
			return check.aloft(np.asarray(v)[np.asarray(f)], jet.tris(["lex_right"]))

	def test_a_plate_laid_on_the_skin_stands_its_thickness_off(self):
		self.assertAlmostEqual(self.stands(50.06), 0.06, places=4)

	def test_a_plate_standing_off_reads_how_far(self):
		self.assertAlmostEqual(self.stands(50.6), 0.6, places=4)

	def test_no_plate_reads_nothing(self):
		with tempfile.TemporaryDirectory() as d:
			jet = BuriedTest().jet(d, ((370.0, 110.0, 0.0), (400.0, 125.0, 50.0)))
			self.assertTrue(math.isnan(check.aloft(np.zeros((0, 3, 3)), jet.tris(["lex_right"]))))


class LauncherTest(unittest.TestCase):
	# The cheek station's LAU-116 (layout.stores.lau116): its block, on the
	# cheek station's node (layout.nacelle cheek), and its hooks, the store; on
	# models of pieces, each a section carried along the stations, the face on
	# its leaning plane (check.cheek_face())
	def hooks(self, move=0.0):
		# the forward and centre hooks inside the nacelle, clear of the box,
		# the forward one's middle at the facts' station, moved by `move` FS in
		station = check.FACTS["layout"]["stores"]["lau116"]["hooks"]["forward"]["station"] + move
		return [box_section(station - 1.5, station + 1.5, lambda st: [(76.0, 37.0), (76.0, 39.0), (79.0, 39.0), (79.0, 37.0)]),
			box_section(513.5, 516.5, lambda st: [(76.0, 37.0), (76.0, 39.0), (79.0, 39.0), (79.0, 37.0)])]

	def jet(self, d, block, stored):
		# a fuselage, the right cheek box over its length on the station's node,
		# its face on its plane up to its top, stepped under the facts' line (at
		# the line where the fairing over it is set in from its corner), with
		# the pieces of `block` on the node, and station 6's LAU-116 store the
		# pieces of `stored`, shown with the stores
		box_ = check.FACTS["layout"]["nacelle"]["cheek"]
		front, edge, low = box_["front"], box_["edge"], box_["bottom"][0][1]
		middle = (front + check.FACTS["layout"]["stores"]["lau116"]["fairing"]["top"][-1][0]) / 2
		face = check.cheek_face
		cheek = []
		for s0, s1, top in ((front, 535.0, float(np.interp(middle, *zip(*box_["top"])))), (535.0, 556.0, 86.2), (556.0, edge, 84.0)):
			cheek.append(box_section(s0, s1, lambda st, top=top: [(low, 39.0), (low, face(st, low)), (low + 2.0, face(st, low + 2.0)), (top, face(st, top)), (top, 39.0)]))
		glb(Path(d) / "m.glb", [{"name": "fuselage", "mesh": box_mesh((400, 70, -38), (600, 100, 38))},
			{"name": "fairing_cheek_right", "mesh": merged(cheek + list(block))}, {"name": "ejector_6", "mesh": merged(list(stored))}])
		(Path(d) / "m.json").write_text(json.dumps({"joints": {"ejector_6": {"motion": "show", "drive": "stores", "keys": [[0, 0], [1, 1]]}}, "points": {}}))
		return check.Jet(Path(d) / "m.glb", Path(d) / "m.json")

	def block(self, move=(0.0, 0.0, 0.0)):
		# the LAU-116's block, the fairing over it and the ramp ahead of it as
		# the facts give them, in steps, moved by [FS, WL, BL]: the ramp's
		# pieces drawn in off the face, each top a point at its knot's height on
		# the crest's buttline; the face's from its front's crest, on the face's
		# plane up to the box's top's height and upright above it; its last inch
		# the box's bottom, as the build eases it into the box's; over the box,
		# set in from the box's top corner
		lau, box_ = check.FACTS["layout"]["stores"]["lau116"], check.FACTS["layout"]["nacelle"]["cheek"]
		fairing, ramp = lau["fairing"], lau["fairing"]["ramp"]["top"]
		front, back = (lau["front_top"][0] + lau["front_bottom"][0]) / 2, box_["front"]
		bottom, m = lau["front_bottom"][1], np.array(move)
		knee = float(np.interp(back, *zip(*box_["top"])))
		face = lambda st, w: check.cheek_face(st - m[0], w - m[1]) + m[2]
		crest = lau["crest"][2] + m[2]
		pieces = []
		cuts = [ramp[0][0]] + [(a[0] + b[0]) / 2 for a, b in zip(ramp[1:], ramp[2:])] + [front]
		for (s0, s1), (_, top) in zip(zip(cuts, cuts[1:]), ramp[1:]):
			pieces.append(box_section(s0 + m[0], s1 + m[0], lambda st, top=top: [(bottom + m[1], 40.9), (bottom + m[1], crest), (top + m[1], crest), (top + m[1] - 0.5, 40.9)]))

		def upright(low, top):
			return lambda st: [(low + m[1], 40.9), (low + m[1], face(st, low + m[1])), (low + m[1] + 2.0, face(st, low + m[1] + 2.0)), (knee + m[1], face(st, knee + m[1])),
				(top + m[1], face(st, knee + m[1]) - 0.3), (top + m[1], 41.5)]

		level = [k for k in fairing["top"] if k[0] < back]
		cuts = [front, front + 1.0] + [(a[0] + b[0]) / 2 for a, b in zip(level, level[1:])] + [back - 1.0]
		for (s0, s1), top in zip(zip(cuts, cuts[1:]), [lau["crest"][1]] + [k[1] for k in level]):
			pieces.append(box_section(s0 + m[0], s1 + m[0], upright(bottom, top)))
		pieces.append(box_section(back - 1.0 + m[0], back + m[0], upright(box_["bottom"][0][1], level[-1][1])))
		over = [k for k in fairing["top"] if k[0] > back][:-1]
		cuts = [back] + [(a[0] + b[0]) / 2 for a, b in zip(over, over[1:])] + [fairing["top"][-1][0] - 0.5]
		for (s0, s1), (_, top) in zip(zip(cuts, cuts[1:]), over):
			corner = lambda st: float(np.interp(st - m[0], *zip(*box_["top"])))
			pieces.append(box_section(s0 + m[0], s1 + m[0], lambda st, top=top: [(corner(st) - 0.5 + m[1], 41.0), (corner(st) - 0.5 + m[1], face(st, corner(st) + m[1]) - fairing["inset"]),
				(top + m[1], face(st, corner(st) + m[1]) - fairing["inset"]), (top + m[1], 41.0)]))
		return pieces

	def rows(self, jet, fact, words):
		return [r for r in check.checks(jet, [fact]) if words in r["what"]]

	def test_nothing_stands_outside_the_cheek_box(self):
		with tempfile.TemporaryDirectory() as d:
			# the 44 in launcher the photos replaced, a store: through the box's
			# face, most where the face leans in furthest, under its top
			jet = self.jet(d, [], [box_mesh((500.0, 76.0, 40.0), (538.0, 93.0, 46.6))])
			(row,) = self.rows(jet, "layout.nacelle", "outside the cheek box's outboard face")
			self.assertTrue(check.failed(row), row)
			station, w = (float(v) for v in re.search(r"FS ([0-9.]+), WL ([0-9.]+)", row["what"]).groups())
			self.assertAlmostEqual(row["measured"], 46.6 - float(check.cheek_face(station, w)), places=2)
		with tempfile.TemporaryDirectory() as d:
			# the block the photos show on the box's node, the hooks inside the nacelle
			(row,) = self.rows(self.jet(d, self.block(), self.hooks()), "layout.nacelle", "outside the cheek box's outboard face")
			self.assertFalse(check.failed(row), row)
			self.assertEqual(row["measured"], 0.0)

	def test_the_launchers_corners_meet_the_marks(self):
		with tempfile.TemporaryDirectory() as d:
			rows = self.rows(self.jet(d, self.block(), self.hooks()), "layout.stores", "LAU-116")
			self.assertEqual(len(rows), 23, rows)
			self.assertFalse([r for r in rows if check.failed(r)], rows)
		# each fitting moved past the marks' spread fails, and says where; and
		# moved off the box's face or bottom, so does its joint with the box
		for move, words in (((1.0, 0.0, 0.0), "front edge against"), ((0.0, 0.3, 0.0), "fairing's top at"), ((0.0, 0.3, 0.0), "crest, 0.05"),
				((0.0, 0.0, 0.5), "crest, its buttline"), ((0.0, 0.3, 0.0), "ramp's top"), ((1.0, 0.0, 0.0), "ramp's front"), ((0.0, -0.3, 0.0), "bottom against front_bottom"),
				((0.0, 0.0, 0.5), "face against the hole"), ((0.0, 0.0, 0.5), "face against front_top"), ((0.0, 0.0, 0.1), "face 0.5 in ahead of its aft end against the cheek box's"),
				((0.0, -0.2, 0.0), "bottom 0.5 in ahead of its aft end against the cheek box's"), ((0.0, 0.0, 0.5), "set in"), ((3.0, 0.0, 0.0), "aft end on the box's top")):
			with tempfile.TemporaryDirectory() as d:
				rows = self.rows(self.jet(d, self.block(move), self.hooks()), "layout.stores", "LAU-116")
				self.assertTrue([r for r in rows if check.failed(r) and words in r["what"]], (move, rows))
		with tempfile.TemporaryDirectory() as d:
			rows = self.rows(self.jet(d, self.block(), self.hooks(1.0)), "layout.stores", "LAU-116")
			self.assertTrue([r for r in rows if check.failed(r) and "forward hook" in r["what"]], rows)

	def test_the_block_is_the_airframes(self):
		# the block built as the store, shown only with a round: the clean jet
		# has none, and every corner fails
		with tempfile.TemporaryDirectory() as d:
			rows = self.rows(self.jet(d, [], self.block() + self.hooks()), "layout.stores", "LAU-116")
			self.assertEqual(len(rows), 23, rows)
			# all but the box's own corner, which stands as it does under the
			# fairing, and the forward hook, the store's
			self.assertTrue(all(check.failed(r) for r in rows if "set in" not in r["what"] and "hook" not in r["what"]), [r for r in rows if not check.failed(r)])
			self.assertFalse([r for r in rows if "hook" in r["what"] and check.failed(r)], rows)


def box_mesh(lo, hi):
	# a box between [FS, WL, BL] corners, in the model frame
	i = 0.0254
	return box(((456 - hi[0]) * i, (lo[1] - 105) * i, lo[2] * i), ((456 - lo[0]) * i, (hi[1] - 105) * i, hi[2] * i))


def box_section(s0, s1, section):
	# a closed piece between two stations, its section at each a convex
	# polygon of [WL, BL] (section(station)), in the model frame
	i = 0.0254
	ends = [[((456 - st) * i, (w - 105) * i, b * i) for w, b in section(st)] for st in (s0, s1)]
	n = len(ends[0])
	v = np.array(ends[0] + ends[1], float)
	f = [(0, k, k + 1) for k in range(1, n - 1)] + [(n, n + k + 1, n + k) for k in range(1, n - 1)]
	f += [t for k in range(n) for t in ((k, (k + 1) % n, n + (k + 1) % n), (k, n + (k + 1) % n, n + k))]
	return v, np.array(f)


def merged(pieces):
	# meshes as one
	if not pieces:
		return np.zeros((0, 3)), np.zeros((0, 3), int)
	return np.concatenate([v for v, _ in pieces]), np.concatenate([f + sum(len(v) for v, _ in pieces[:k]) for k, (_, f) in enumerate(pieces)])


def tube(start=420.0, end=500.0, centre=(100.0, -30.0), radius=10.0, sides=16, rings=9, capped=True, gap=None, turned=False):
	# A duct in the model frame: a round tube along the stations from `start`
	# to `end` round (WL, BL) `centre`, `rings` rings, closed at its end by a
	# fan, its faces turned in to its axis (`turned`: out); `gap`: (first
	# ring, last ring, sides) whose faces are left out, a hole. Its UVs: u the
	# share of the way along, v round it
	i = 0.0254
	stations = np.linspace(start, end, rings)
	turns = 2 * math.pi * np.arange(sides) / sides
	v = [((456 - st) * i, (centre[0] + radius * math.cos(t) - 105) * i, (centre[1] + radius * math.sin(t)) * i) for st in stations for t in turns]
	uv = [((st - start) / (end - start), k / sides) for st in stations for k in range(sides)]
	f = []
	for r in range(rings - 1):
		for k in range(sides):
			if gap and gap[0] <= r < gap[1] and k < gap[2]:
				continue
			a, b = r * sides + k, r * sides + (k + 1) % sides
			f += [(a, b, b + sides), (a, b + sides, a + sides)]
	if capped:
		v.append(((456 - end) * i, (centre[0] - 105) * i, centre[1] * i))
		uv.append((1.0, 0.5))
		last = (rings - 1) * sides
		f += [(len(v) - 1, last + k, last + (k + 1) % sides) for k in range(sides)]
	f = np.array(f)
	return np.array(v, float), (f[:, ::-1] if turned else f), np.array(uv, float)


def painted(path, nodes, image):
	# A glTF binary of nodes {"name", "mesh": (vertices, faces[, uvs])}, every
	# mesh in the paint material, whose base colour is the image (H, W, 0..255)
	import io
	from PIL import Image
	blob, views, accessors, meshes = bytearray(), [], [], []

	def view(data):
		while len(blob) % 4:
			blob.append(0)
		views.append({"buffer": 0, "byteOffset": len(blob), "byteLength": len(data)})
		blob.extend(data)
		return len(views) - 1

	for n in nodes:
		v, f = n["mesh"][:2]
		attributes = {}
		for key, data, width in (("POSITION", np.asarray(v, np.float32), "VEC3"), ("TEXCOORD_0", None if len(n["mesh"]) < 3 else np.asarray(n["mesh"][2], np.float32), "VEC2")):
			if data is not None:
				accessors.append({"bufferView": view(data.tobytes()), "componentType": 5126, "count": len(data), "type": width})
				attributes[key] = len(accessors) - 1
		indices = np.asarray(f, np.uint32).ravel()
		accessors.append({"bufferView": view(indices.tobytes()), "componentType": 5125, "count": int(indices.size), "type": "SCALAR"})
		meshes.append({"primitives": [{"attributes": attributes, "indices": len(accessors) - 1, "material": 0}]})
	png = io.BytesIO()
	Image.fromarray(np.asarray(image, np.uint8)).save(png, "PNG")
	picture = view(png.getvalue())
	while len(blob) % 4:
		blob.append(0)
	document = {"asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": list(range(len(nodes)))}],
		"nodes": [{"name": n["name"], "mesh": k} for k, n in enumerate(nodes)], "meshes": meshes, "accessors": accessors, "bufferViews": views,
		"buffers": [{"byteLength": len(blob)}], "materials": [{"name": "paint", "pbrMetallicRoughness": {"baseColorTexture": {"index": 0}}}],
		"textures": [{"source": 0}], "images": [{"bufferView": picture, "mimeType": "image/png"}]}
	text = json.dumps(document).encode()
	text += b" " * (-len(text) % 4)
	body = len(text).to_bytes(4, "little") + b"JSON" + text + len(blob).to_bytes(4, "little") + b"BIN\0" + bytes(blob)
	Path(path).write_bytes(b"glTF" + (2).to_bytes(4, "little") + (12 + len(body)).to_bytes(4, "little") + body)


class DuctTest(unittest.TestCase):
	# The inlet ducts' checks (layout.inlet): what a sight line ends on
	# (head_on()), rays from a duct's axis meeting its own faces first
	# (strays()) and the paint where rays from an eye meet its walls (shades());
	# on a model of a round tube along the stations, closed by a fan
	def jet(self, d, *nodes):
		path = Path(d) / "m.glb"
		painted(path, [{"name": "inlet_left", "mesh": nodes[0]}] + list(nodes[1:]), np.array([[255, 128, 0]] * 2, np.uint8))
		(Path(d) / "m.json").write_text(json.dumps({"joints": {}, "points": {}}))
		return check.Jet(path, Path(d) / "m.json")

	def test_head_on(self):
		with tempfile.TemporaryDirectory() as d:
			jet = self.jet(d, tube())
			tris = jet.tris(["inlet_left"])
			start = check.FRAME.model(np.array([[400.0, 100.0, -30.0]]))[0]
			# down the axis it meets the end across it, the end's station
			station, across = check.head_on(tris, start, check.FRAME.axes @ np.array([1.0, 0.0, 0.0]))
			self.assertAlmostEqual(station, 500.0, places=3)
			self.assertTrue(across)
			# at a slant it meets a wall, which lies along the axis
			slant = check.FRAME.axes @ np.array([1.0, 0.0, 0.25])
			station, across = check.head_on(tris, start, slant / np.linalg.norm(slant))
			self.assertLess(station, 500.0)
			self.assertFalse(across)
			self.assertIsNone(check.head_on(tris, start, check.FRAME.axes @ np.array([-1.0, 0.0, 0.0])))

	def test_strays(self):
		stations = [440.0, 460.0, 480.0]
		with tempfile.TemporaryDirectory() as d:
			self.assertEqual(check.strays(self.jet(d, tube()), "inlet_left", stations), 0)
		# a part standing in the duct, a hole in its walls, a station past its end
		with tempfile.TemporaryDirectory() as d:
			i = 0.0254
			strut = box(((456 - 475) * i, (92 - 105) * i, -34 * i), ((456 - 470) * i, (112 - 105) * i, -30 * i))
			self.assertGreater(check.strays(self.jet(d, tube(), {"name": "fuselage", "mesh": strut}), "inlet_left", stations), 0)
		with tempfile.TemporaryDirectory() as d:
			self.assertGreater(check.strays(self.jet(d, tube(gap=(3, 5, 6))), "inlet_left", stations), 0)
		with tempfile.TemporaryDirectory() as d:
			self.assertEqual(check.strays(self.jet(d, tube()), "inlet_left", stations + [520.0], count=12), 12)
		# its faces turned out, met from behind: every ray
		with tempfile.TemporaryDirectory() as d:
			self.assertEqual(check.strays(self.jet(d, tube(turned=True)), "inlet_left", stations, count=12), 36)

	def test_shades(self):
		# the atlas a gradient along the tube, light at its mouth: the walls
		# met deeper read darker, and a ray another part stops is left out
		with tempfile.TemporaryDirectory() as d:
			image = np.array([np.linspace(1.0, 0.0, 64)] * 4)
			jet = self.jet(d, tube())
			eye = np.array([380.0, 100.0, -30.0])
			aims = [np.array([420.0, 100.0 + w, -30.0 + b]) for w in (-6.0, 0.0, 6.0) for b in (-6.0, 6.0)] + [np.array([420.0, 100.0, -30.0])]
			values, points = check.shades(jet, image, "inlet_left", [eye], aims, lambda p: p[0] < 499.0)
			self.assertEqual(len(values), 6)   # down the axis it meets the end, left out
			np.testing.assert_allclose(values, 1.0 - (points[:, 0] - 420.0) / 80.0, atol=0.03)
			blocker = box(((456 - 410) * 0.0254, -10 * 0.0254, -40 * 0.0254), ((456 - 405) * 0.0254, 0.0, -20 * 0.0254))
			blocked, _ = check.shades(self.jet(d, tube(), {"name": "fuselage", "mesh": blocker}), image, "inlet_left", [eye], aims, lambda p: p[0] < 499.0)
			self.assertLess(len(blocked), len(values))


def triangles(lo, hi):
	# a closed box's triangles in source coordinates (FS, WL, BL)
	v, f = box(lo, hi)
	return v[f]


class ShapeTest(unittest.TestCase):
	HULL = triangles((400, 100, -10), (500, 120, 10))

	def test_hidden_finds_a_part_inside_another_that_moves_with_it(self):
		# a box inside the fuselage, both in the jet's rigid frame, is hidden
		# whole; on a joint of its own (a gear leg), it is not judged against
		# the fuselage at all
		with tempfile.TemporaryDirectory() as d:
			path, points = Path(d) / "m.glb", Path(d) / "m.json"
			i = 0.0254
			glb(path, [{"name": "fuselage", "mesh": box(((456 - 500) * i, -5 * i, -10 * i), ((456 - 400) * i, 15 * i, 10 * i))},
				{"name": "gear", "mesh": box(((456 - 460) * i, 0, -2 * i), ((456 - 440) * i, 5 * i, 2 * i))}])
			points.write_text(json.dumps({"joints": {}, "points": {}}))
			self.assertEqual(check.hidden(path, points)["gear"][0], 12)
			points.write_text(json.dumps({"joints": {"gear": {"motion": "rotate"}}, "points": {}}))
			self.assertEqual(check.hidden(path, points), {})

	def test_enclosed(self):
		inside = np.array([[450, 110, 0], [401, 101, 9.5]], float)
		self.assertTrue(check.enclosed(inside, self.HULL).all())
		# just outside each face in turn
		outside = np.array([[399, 110, 0], [501, 110, 0], [450, 99, 0], [450, 121, 0], [450, 110, -11], [450, 110, 11]], float)
		self.assertFalse(check.enclosed(outside, self.HULL).any())
		# a point under a lid with nothing beneath it
		lid = triangles((400, 120, -10), (500, 121, 10))
		self.assertFalse(check.enclosed(np.array([[450, 110, 0]], float), lid).any())
		# inside walls open below: every way but down meets the hull
		open_below = np.delete(self.HULL, [4, 5], axis=0)
		self.assertFalse(check.enclosed(np.array([[450, 110, 0]], float), open_below).any())
		# inside a tube open at its ends: along it nothing at all is met
		tube = np.delete(self.HULL, [6, 7, 10, 11], axis=0)
		self.assertFalse(check.enclosed(np.array([[450, 110, 0]], float), tube).any())

	def test_inward_and_crossed(self):
		# a ray in from a box's top, straight down, leaves through its floor
		# 20 in below, a face turned along it; one from under the floor going
		# down meets nothing, and one going up meets the floor turned against it
		# and leaves through the top
		top = np.array([450.0, 120.0, 0.0])
		self.assertAlmostEqual(check.inward(self.HULL, top, np.array([0.0, -1.0, 0.0])), 20.0, places=6)
		self.assertEqual(check.inward(self.HULL, np.array([450.0, 99.0, 0.0]), np.array([0.0, -1.0, 0.0])), np.inf)
		self.assertAlmostEqual(check.inward(self.HULL, np.array([450.0, 99.0, 0.0]), np.array([0.0, 1.0, 0.0])), 21.0, places=6)
		# inside by its crossings' parity along the oblique rays, even beside a face's edge
		self.assertTrue(check.crossed(np.array([450.0, 110.0, 0.0]), self.HULL))
		self.assertTrue(check.crossed(np.array([400.01, 100.01, -9.99]), self.HULL))
		self.assertFalse(check.crossed(np.array([450.0, 125.0, 0.0]), self.HULL))
		self.assertFalse(check.crossed(np.array([399.0, 110.0, 0.0]), self.HULL))
		# with a hole in the top (FS 440-460, BL -5 to 5) two rays pass through
		# it: from 3 in above, they read inside and the other five outside; from
		# 3 in under, they read outside and the other five inside
		fs, bl = (400, 440, 460, 500), (-10, -5, 5, 10)
		top = np.array([[f, 120.0, b] for f in fs for b in bl])
		cells = [(a, b) for a in range(3) for b in range(3) if (a, b) != (1, 1)]
		lid = [top[list(t)] for a, b in cells for t in ((a * 4 + b, a * 4 + b + 1, (a + 1) * 4 + b + 1), (a * 4 + b, (a + 1) * 4 + b + 1, (a + 1) * 4 + b))]
		holed = np.array([t for t in self.HULL if not np.allclose(t[:, 1], 120)] + lid)
		self.assertFalse(check.crossed(np.array([442.44, 123.0, -4.55]), holed))
		self.assertTrue(check.crossed(np.array([447.12, 117.0, -2.76]), holed))

	def test_rim_and_the_closed_skin(self):
		# a box with a square hole in its top (FS 440-460, BL -5 to 5) and a
		# door flush over it (the speedbrake, as cut() lays it): the checks' fuselage is
		# closed by the door's outer face moved back in, and the door's rim
		# meets the hole's edge; moved an inch aft, it misses by an inch
		i = 0.0254
		x = lambda fs: (456 - fs) * i
		fs, bl = (400, 440, 460, 500), (-10, -5, 5, 10)
		top = np.array([[x(f), 15 * i, b * i] for f in fs for b in bl])
		cells = [(a, b) for a in range(3) for b in range(3) if (a, b) != (1, 1)]
		faces = [t for a, b in cells for t in ((a * 4 + b, a * 4 + b + 1, (a + 1) * 4 + b + 1), (a * 4 + b, (a + 1) * 4 + b + 1, (a + 1) * 4 + b))]
		v, f = box((x(500), -5 * i, -10 * i), (x(400), 15 * i, 10 * i))
		keep = [t for t in f if not all(abs(v[k][1] - 15 * i) < 1e-9 for k in t)]
		shell = (np.concatenate([v, top]), np.array([list(t) for t in keep] + [[len(v) + k for k in t] for t in faces]))
		with tempfile.TemporaryDirectory() as d:
			path, points = Path(d) / "m.glb", Path(d) / "m.json"
			for shift, want in ((0.0, 0.0), (1.0, 1.0)):
				# as cut() makes a door: its outer face, the same triangles under it turned in, and its edges
				corners = [(440 + shift, -5), (460 + shift, -5), (460 + shift, 5), (440 + shift, 5)]
				dv = np.array([[x(f), 15.0 * i, b * i] for f, b in corners] + [[x(f), 14.9 * i, b * i] for f, b in corners])
				df = [(0, 1, 2), (0, 2, 3), (4, 6, 5), (4, 7, 6)] + [t for k in range(4) for t in ((k, (k + 1) % 4, 4 + (k + 1) % 4), (k, 4 + (k + 1) % 4, 4 + k))]
				door = (dv, np.array(df))
				glb(path, [{"name": "fuselage", "mesh": shell}, {"name": "speedbrake", "mesh": door}])
				points.write_text(json.dumps({"joints": {}, "points": {}}))
				jet = check.Jet(path, points)
				self.assertAlmostEqual(check.rim(jet, "speedbrake"), want, places=3)
			# the same door cut as two panels abutting at FS 450, each with its
			# own corners, the second's seam split at BL 0 (as door() cuts a
			# door's convex pieces one by one, each subdivided its own way):
			# where they meet is no edge of the door's, so its rim still meets
			# the hole's
			def panel(ring):
				n = len(ring)
				pv = np.array([[x(f), 15.0 * i, b * i] for f, b in ring] + [[x(f), 14.9 * i, b * i] for f, b in ring])
				outer = [(0, k, k + 1) for k in range(1, n - 1)]
				inner = [(n, n + k + 1, n + k) for k in range(1, n - 1)]
				walls = [t for k in range(n) for t in ((k, (k + 1) % n, n + (k + 1) % n), (k, n + (k + 1) % n, n + k))]
				return pv, outer + inner + walls
			(va, fa), (vb, fb) = panel([(440, -5), (450, -5), (450, 5), (440, 5)]), panel([(450, 0), (450, -5), (460, -5), (460, 5), (450, 5)])
			halves = (np.concatenate([va, vb]), np.array(fa + [tuple(k + len(va) for k in t) for t in fb]))
			glb(path, [{"name": "fuselage", "mesh": shell}, {"name": "speedbrake", "mesh": halves}])
			jet = check.Jet(path, points)
			self.assertAlmostEqual(check.rim(jet, "speedbrake"), 0.0, places=3)
			# a second door cut from the same skin: overlapping the first by
			# 5 in, they lie on each other; abutting it, they do not, though
			# a sliver of its faces 0.01 in wide runs along the edge they share
			# (as the cut leaves them)
			def plate(stations):
				n = len(stations)
				# the probe's door standing its PROUD off the skin
				pv = np.array([[x(f), h * i, b * i] for h in (15.0 + check.PROUD["probe_door"], 14.9) for f in stations for b in (-5, 5)])
				outer = [t for k in range(n - 1) for t in ((2 * k, 2 * k + 2, 2 * k + 3), (2 * k, 2 * k + 3, 2 * k + 1))]
				inner = [(a + 2 * n, c + 2 * n, b + 2 * n) for a, b, c in outer]
				ring = [2 * k for k in range(n)] + [2 * k + 1 for k in reversed(range(n))]
				sides = [t for a, b in zip(ring, ring[1:] + ring[:1]) for t in ((a, b, b + 2 * n), (a, b + 2 * n, a + 2 * n))]
				return pv, np.array(outer + inner + sides)

			for stations, want in (((455, 465), True), ((460, 460.01, 470), False)):
				glb(path, [{"name": "fuselage", "mesh": shell}, {"name": "speedbrake", "mesh": door}, {"name": "probe_door", "mesh": plate(stations)}])
				jet = check.Jet(path, points)
				self.assertEqual(check.stacked(jet, ["speedbrake", "probe_door"]) > 0, want, stations)
			glb(path, [{"name": "fuselage", "mesh": shell}, {"name": "speedbrake", "mesh": door}])
			jet = check.Jet(path, points)
			self.assertEqual(len(jet.opened()) + 2, len(jet.tris(["fuselage"])))
			closed = check.heights(jet.points(["fuselage"]).reshape(-1, 3, 3), np.array([449.0, 451.0]), np.array([-1.0, 1.0]))
			np.testing.assert_allclose(closed, 120.0, atol=1e-6)

	def test_outline_normals_are_the_doors_face(self):
		# a door flush in a hole in a box's top, as cut() lays it, its edges'
		# walls slivers 0.1 in deep: each outline point's normal is its outer
		# face's, up, though the triangle whose centre lies nearest is most
		# often a wall's, square to it (the seam's paint was read along those)
		i = 0.0254
		x = lambda fs: (456 - fs) * i
		fs, bl = (400, 440, 460, 500), (-10, -5, 5, 10)
		top = np.array([[x(f), 15 * i, b * i] for f in fs for b in bl])
		cells = [(a, b) for a in range(3) for b in range(3) if (a, b) != (1, 1)]
		faces = [t for a, b in cells for t in ((a * 4 + b, a * 4 + b + 1, (a + 1) * 4 + b + 1), (a * 4 + b, (a + 1) * 4 + b + 1, (a + 1) * 4 + b))]
		v, f = box((x(500), -5 * i, -10 * i), (x(400), 15 * i, 10 * i))
		keep = [t for t in f if not all(abs(v[k][1] - 15 * i) < 1e-9 for k in t)]
		shell = (np.concatenate([v, top]), np.array([list(t) for t in keep] + [[len(v) + k for k in t] for t in faces]))
		corners = [(440, -5), (460, -5), (460, 5), (440, 5)]
		dv = np.array([[x(f), 15.0 * i, b * i] for f, b in corners] + [[x(f), 14.9 * i, b * i] for f, b in corners])
		df = [(0, 1, 2), (0, 2, 3), (4, 6, 5), (4, 7, 6)] + [t for k in range(4) for t in ((k, (k + 1) % 4, 4 + (k + 1) % 4), (k, 4 + (k + 1) % 4, 4 + k))]
		with tempfile.TemporaryDirectory() as d:
			path, points = Path(d) / "m.glb", Path(d) / "m.json"
			glb(path, [{"name": "fuselage", "mesh": shell}, {"name": "speedbrake", "mesh": (dv, np.array(df))}])
			points.write_text(json.dumps({"joints": {}, "points": {}}))
			jet = check.Jet(path, points)
			line, ups = check.outline(jet, "speedbrake", normals=True)
			self.assertEqual(len(line), len(ups))
			np.testing.assert_allclose(ups, np.tile([0.0, 1.0, 0.0], (len(ups), 1)), atol=1e-6)
			np.testing.assert_allclose(check.outline(jet, "speedbrake"), line)
			tris = check.FRAME.source(jet.tris(["speedbrake"]).reshape(-1, 3)).reshape(-1, 3, 3)
			nearest = [np.argmin(np.linalg.norm(tris.mean(1) - q, axis=1)) for q in check.FRAME.source(line)]
			sideways = np.abs(check.outward(tris[nearest])[:, 1]) < 0.1
			self.assertGreater(sideways.mean(), 0.5)

	def test_depths(self):
		# a door as cut() makes it, here standing 0.15 in over the skin, its
		# inner face 0.1 under, each edge split at the skin, the band above in
		# the paint and the band below white: its white faces lie the 0.15 in
		# under its outer face, at their shallowest, and its painted ones that
		# far at their deepest; an edge white all the way up reaches the outer face
		i = 0.0254
		x = lambda fs: (456 - fs) * i
		ring = [(440, -5), (460, -5), (460, 5), (440, 5)]
		level = lambda wl: np.array([[x(f), wl * i, b * i] for f, b in ring])
		outer, skin, inner = level(15.15), level(15.0), level(14.9)
		face = np.array([outer[[0, 1, 2]], outer[[0, 2, 3]]])
		bands = lambda hi, lo: np.array([t for k in range(4) for t in ((hi[k], hi[(k + 1) % 4], lo[(k + 1) % 4]), (hi[k], lo[(k + 1) % 4], lo[k]))])
		back = np.array([inner[[0, 2, 1]], inner[[0, 3, 2]]])

		class Model:
			def __init__(self, finishes):
				self.finishes = finishes

			def parts(self, posed=None, materials=None):
				return {"door": np.concatenate([self.finishes[m] for m in materials])}

		class Jet:
			joints = {}

			def __init__(self, finishes):
				self.model = Model(finishes)

			def faces(self, name):
				return face

		split = Jet({"paint": np.concatenate([face, bands(outer, skin)]), "white": np.concatenate([bands(skin, inner), back])})
		self.assertAlmostEqual(float(check.depths(split, "door", "white").min()), 0.15, places=4)
		self.assertAlmostEqual(float(check.depths(split, "door", "paint").max()), 0.15, places=4)
		whole = Jet({"paint": face, "white": np.concatenate([bands(outer, inner), back])})
		self.assertAlmostEqual(float(check.depths(whole, "door", "white").min()), 0.0, places=4)
		self.assertAlmostEqual(float(check.depths(whole, "door", "paint").max()), 0.0, places=4)
		# a door with no faces in a finish cannot be measured
		with self.assertRaises(KeyError):
			check.depths(Jet({"paint": face, "white": np.zeros((0, 3, 3))}), "door", "white")

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

	def test_apart(self):
		# boxes half an inch apart stand half an inch apart; touching or
		# crossing, not at all; a corner off an edge by its diagonal
		tris = lambda lo, hi: (lambda v, f: v[f])(*box(lo, hi))
		one = tris((0.0, 0.0, 0.0), (10.0, 2.0, 2.0))
		self.assertAlmostEqual(check.apart(one, tris((0.0, 2.5, 0.0), (10.0, 4.0, 2.0))), 0.5, places=6)
		self.assertAlmostEqual(check.apart(one, tris((0.0, 2.0, 0.0), (10.0, 4.0, 2.0))), 0.0, places=6)
		self.assertAlmostEqual(check.apart(one, tris((2.0, 1.0, 1.0), (8.0, 4.0, 3.0))), 0.0, places=6)
		self.assertAlmostEqual(check.apart(one, tris((11.0, 3.0, 0.0), (12.0, 4.0, 2.0))), math.sqrt(2), places=6)
		self.assertEqual(check.apart(one, tris((50.0, 0.0, 0.0), (60.0, 2.0, 2.0))), float("inf"))
		# a long part whose face passes close while all its corners lie far off
		long = tris((-100.0, -1.0, -1.0), (100.0, 0.0, 1.0))
		self.assertAlmostEqual(check.apart(tris((0.0, 0.5, 0.0), (1.0, 1.5, 0.5)), long), 0.5, places=6)
		# further apart than the search's reach, with a sliver of one reaching
		# toward the other: the box's own corners, whose faces lie beyond the
		# reach, are still the nearest
		sliver = np.array([[[11.0, 0.0, 1.0], [11.9, 2.6, 1.0], [11.5, 0.0, 1.0]]])
		self.assertAlmostEqual(check.apart(np.concatenate([one, sliver]), tris((0.0, 4.5, 0.0), (10.0, 6.0, 2.0))), 2.5, places=6)

	def test_through(self):
		# two boxes crossing: their faces cross where an edge of either passes
		# through a face of the other; boxes touching face to face, lying
		# apart, or one wholly inside the other (no face crossing) do not
		tris = lambda lo, hi: (lambda v, f: v[f])(*box(lo, hi))
		one = tris((0.0, 0.0, 0.0), (10.0, 2.0, 2.0))
		hits = check.through(one, tris((4.0, 1.5, -1.0), (6.0, 4.0, 3.0)))
		self.assertTrue(len(hits))
		self.assertTrue(((hits[:, 1] >= 1.5 - 1e-9) & (hits[:, 1] <= 2.0 + 1e-9)).all())
		self.assertEqual(len(check.through(one, tris((0.0, 2.0, 0.0), (10.0, 4.0, 2.0)))), 0)
		self.assertEqual(len(check.through(one, tris((0.0, 2.0, 0.5), (5.0, 4.0, 1.5)))), 0)
		self.assertEqual(len(check.through(one, tris((0.0, 2.5, 0.0), (10.0, 4.0, 2.0)))), 0)
		self.assertEqual(len(check.through(one, tris((2.0, 0.5, 0.5), (8.0, 1.5, 1.5)))), 0)
		# a thin plate standing through the box's middle: none of its corners
		# inside the box, its faces crossed by the box's long edges
		self.assertTrue(len(check.through(one, tris((4.9, -1.0, -1.0), (5.1, 3.0, 3.0)))))

	def test_shrunk(self):
		# a box pulled in is the box with each face stepped in by the seam,
		# every copy of a corner alike; a plate grazing it by less than the
		# seam then clears it, one deeper does not
		tris = lambda lo, hi: (lambda v, f: v[f])(*box(lo, hi))
		one = tris((0.0, 0.0, 0.0), (10.0, 2.0, 2.0))
		self.assertTrue(np.allclose(check.shrunk(one, 0.1), tris((0.1, 0.1, 0.1), (9.9, 1.9, 1.9))))
		graze = tris((2.0, 1.95, 0.5), (8.0, 3.0, 1.5))
		self.assertTrue(len(check.through(one, graze)))
		self.assertEqual(len(check.through(check.shrunk(graze, 0.1), one)), 0)
		deep = tris((2.0, 1.5, 0.5), (8.0, 3.0, 1.5))
		self.assertTrue(len(check.through(check.shrunk(deep, 0.1), one)))

	def test_boundary(self):
		# a shell's edge: the corners on sides one triangle alone has; a closed
		# box has none, the same box with its top's two triangles gone has its
		# top's four corners
		v, f = box((0.0, 0.0, 0.0), (1.0, 2.0, 3.0))
		self.assertEqual(len(check.boundary(v[f])), 0)
		top = [k for k, t in enumerate(f) if np.allclose(v[t][:, 1], 2.0)]
		self.assertEqual(len(top), 2)
		rim = check.boundary(v[np.delete(f, top, axis=0)])
		self.assertEqual(len(rim), 4)
		np.testing.assert_allclose(rim[:, 1], 2.0)

	def _jet(self, d, nodes, joints):
		path = Path(d) / "m.glb"
		glb(path, nodes)
		(Path(d) / "m.json").write_text(json.dumps({"joints": joints, "points": {}}))
		return check.Jet(path, Path(d) / "m.json")

	def test_pinned(self):
		# a pin carried by two members turning alike about one hinge stays put
		# between them; one turning about a hinge beside it, or keyed along
		# another curve to the same end, drifts away mid-stroke
		turn = lambda keys, drive="d": {"motion": "rotate", "axis": [0, 0, 1], "drive": drive, "keys": keys}
		bar = box((0.0, -0.05, -0.05), (1.0, 0.05, 0.05))
		with tempfile.TemporaryDirectory() as d:
			jet = self._jet(d, [{"name": "a", "mesh": bar}, {"name": "b", "mesh": bar}, {"name": "c", "translation": (0.1, 0, 0), "mesh": bar},
				{"name": "e", "mesh": bar}], {"a": turn([[0, 0], [1, 1.5]]), "b": turn([[0, 0], [1, 1.5]]), "c": turn([[0, 0], [1, 1.5]]), "e": turn([[0, 0], [0.5, 1.0], [1, 1.5]])})
			pin = np.array([1.0, 0.0, 0.0])
			self.assertAlmostEqual(check.pinned(jet, pin, ["a", "b"], lambda x: {"d": x}), 0.0, places=6)
			self.assertGreater(check.pinned(jet, pin, ["a", "c"], lambda x: {"d": x}), 1.0)
			self.assertGreater(check.pinned(jet, pin, ["a", "e"], lambda x: {"d": x}), 1.0)

	def test_clearance_sweeps_each_drive(self):
		# a mechanism's sweep (clearance(), SWEPT): a bar swinging on the probe
		# drive, still over the stroke's first 0.3, passes through a post
		# beside it mid-stroke; two parts riding the bar together overlap where
		# they stand, which its sweep leaves to the static checks; a door riding
		# the bar closes into the skin while it rests, its seat the wells
		# check's, where a part of any other name crossing the skin then is a
		# clash; a drive moving no part reports it missing
		turn = lambda drive: {"motion": "rotate", "axis": [0, 0, 1], "drive": drive, "keys": [[0, 0], [0.3, 0], [1, 1.5]]}
		with tempfile.TemporaryDirectory() as d:
			nodes = [{"name": "arm", "mesh": box((0.0, -0.05, -0.05), (1.0, 0.05, 0.05)), "children": [1, 2, 3, 4]},
				{"name": "cap", "mesh": box((0.8, -0.04, -0.04), (0.95, 0.04, 0.04))},
				{"name": "rib", "mesh": box((0.85, -0.06, -0.02), (0.9, 0.06, 0.02))},
				{"name": "probe_door", "mesh": box((0.3, -0.12, -0.04), (0.5, -0.06, 0.04))},
				{"name": "probe_fin", "mesh": box((0.3, -0.12, 0.2), (0.5, -0.06, 0.3))},
				{"name": "post", "mesh": box((0.45, 0.45, -0.1), (0.55, 0.55, 0.1))},
				{"name": "fuselage", "mesh": box((0.35, -0.3, -0.5), (0.45, -0.1, 0.5))}]
			jet = self._jet(d, nodes, {"arm": turn("probe")})
			rows = list(check.clearance(jet, "probe", 21))
			clash = [r for r in rows if r["what"].startswith("arm through post")]
			self.assertEqual(len(clash), 1)
			self.assertTrue(check.failed(clash[0]))
			self.assertLess(clash[0]["measured"], 21)
			self.assertFalse([r for r in rows if "cap" in r["what"] and "rib" in r["what"]])
			self.assertFalse([r for r in rows if r["what"].startswith("probe_door through")])
			fin = [r for r in rows if r["what"].startswith("probe_fin through fuselage")]
			self.assertEqual(len(fin), 1)
			self.assertIn("probe 0.0-0.3 ", fin[0]["what"])
			pairs = [r for r in rows if r["what"].startswith("pairs of parts crossing as the probe moves")]
			self.assertEqual(pairs[0]["measured"], 2)
			with self.assertRaises(KeyError):
				list(check.clearance(jet, "fold", 21))

	def test_vertical(self):
		# a vertical line through a box crosses its top and bottom; beside it, nothing
		tris = (lambda v, f: v[f])(*box((0.0, 1.0, 0.0), (10.0, 3.0, 2.0)))
		self.assertEqual(sorted(set(np.round(check.vertical(tris, 4.3, 0.7), 9))), [1.0, 3.0])
		self.assertEqual(len(check.vertical(tris, 12.0, 0.7)), 0)

	def test_each_store_part_hangs_from_its_carrier(self):
		self.assertEqual(check.carrier("rail_9"), "wing_outer_right")
		self.assertEqual(check.carrier("rail_2a"), "rack_2")
		self.assertEqual(check.carrier("launcher_8b"), "rack_8")
		self.assertEqual(check.carrier("tank_7"), "pylon_7")
		self.assertEqual(check.carrier("tank_5"), "pylon_5")
		self.assertEqual(check.carrier("pylon_5"), "fuselage")
		self.assertEqual(check.carrier("pylon_3"), "wing_inner_left")
		self.assertEqual(check.carrier("ejector_6"), "fuselage")

	def test_seated_over_a_hole_in_the_skin(self):
		# the skin a fin's root encloses is not built (hidden.py): a foot over
		# the hole stands in it and is passed over, not read against the floor
		# seen through it; the feet beside the hole are read as ever
		tris = lambda lo, hi: (lambda v, f: v[f])(*box(lo, hi))
		tiles = []
		for s0 in range(0, 100, 10):
			for b0 in range(-48, 52, 4):
				if 40 <= s0 < 60 and 36 <= b0 < 44:
					continue   # the hole under the fin, FS 40-60, BL 36-44
				c = np.array([[s0, 100.0, b0], [s0 + 10, 100.0, b0], [s0 + 10, 100.0, b0 + 4], [s0, 100.0, b0 + 4]])
				tiles += [c[[0, 1, 2]], c[[0, 2, 3]]]
		floor = tris((0.0, 89.0, -50.0), (100.0, 90.0, 50.0))
		skin = np.concatenate([np.array(tiles), floor])
		stations = np.arange(10.0, 90.0, 5.0)
		self.assertTrue(check.holed(skin, 50.0, 38.0))
		self.assertFalse(check.holed(skin, 30.0, 38.0))
		self.assertAlmostEqual(check.seated(tris((5.0, 99.5, 38.0), (95.0, 160.0, 42.0)), skin, stations), -0.5, places=6)
		# a fin lifted off the skin is still seen to stand off it
		self.assertAlmostEqual(check.seated(tris((5.0, 102.0, 38.0), (95.0, 160.0, 42.0)), skin, stations), 2.0, places=6)
		# a step in the skin's own shape is no hole
		step = np.concatenate([np.array(tiles), tris((40.0, 89.0, 36.0), (60.0, 99.0, 44.0))])
		self.assertFalse(check.holed(step, 50.0, 40.0))
		# a hole between a deck and a nacelle's shoulder 5 in under it,
		# falling away 5.5 in/in with an inch of it seen from above (the skin
		# beside the fin's root fairing at FS 597), is a hole
		shoulder = []
		for s0 in range(0, 100, 10):
			for b0 in np.arange(30.0, 43.25, 0.25):
				if 40 <= s0 < 60 and 37.5 <= b0 < 42.25:
					continue
				drop = lambda b: 125.2 - 0.25 * (b - 30.0) if b <= 37.5 else 118.1 - 5.5 * (b - 42.25)
				c = np.array([[s0, drop(b0), b0], [s0 + 10, drop(b0), b0], [s0 + 10, drop(b0 + 0.25), b0 + 0.25], [s0, drop(b0 + 0.25), b0 + 0.25]])
				shoulder += [c[[0, 1, 2]], c[[0, 2, 3]]]
		shoulder = np.concatenate([np.array(shoulder), tris((0.0, 79.0, -50.0), (100.0, 80.0, 43.25))])
		self.assertTrue(check.holed(shoulder, 50.0, 38.0))
		self.assertFalse(check.holed(shoulder, 30.0, 38.0))

	def test_proud(self):
		# A face turned aft stands proud of what lies behind it by its step: a
		# block on the skin ended square stands its height; one ending over a
		# lower block behind it, the difference; the part of a face inside
		# what lies behind it, nothing. Source coordinates mirror the model's
		# frame, so the boxes' faces are wound as the jet's read there
		mirrored = lambda lo, hi: (lambda v, f: v[f][:, ::-1])(*box(lo, hi))
		skin = mirrored((0.0, 90.0, -50.0), (100.0, 100.0, 50.0))
		np.testing.assert_allclose(check.standing(np.array([[50.0, 101.0, 0.0], [50.0, 99.0, 0.0]]), skin), [1.0, -1.0])
		block = mirrored((10.0, 100.0, 30.0), (50.0, 103.0, 40.0))
		self.assertAlmostEqual(check.proud(block, np.concatenate([skin, block])), 3.0, places=6)
		lower = mirrored((50.0, 100.0, 30.0), (80.0, 102.75, 40.0))
		self.assertAlmostEqual(check.proud(block, np.concatenate([skin, block, lower])), 0.25, places=6)
		sunk = mirrored((10.0, 97.0, 30.0), (50.0, 100.3, 40.0))
		self.assertAlmostEqual(check.proud(sunk, np.concatenate([skin, sunk])), 0.3, places=6)
		# nothing turned aft, nothing proud
		self.assertEqual(check.proud(block[:2], skin), 0.0)
		# and a ramp drawing in at 50 deg off aft is no face turned aft
		v = np.array([[10.0, 100.0, 30.0], [50.0, 100.0, 30.0], [52.5, 103.0, 30.0], [10.0, 103.0, 30.0]])
		v = np.concatenate([v, v + [0.0, 0.0, 10.0]])
		f = np.array([(0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7), (0, 1, 5), (0, 5, 4), (1, 2, 6), (1, 6, 5), (2, 3, 7), (2, 7, 6), (3, 0, 4), (3, 4, 7)])
		ramp = v[f][:, ::-1]
		self.assertEqual(check.proud(ramp, np.concatenate([skin, ramp])), 0.0)

	def test_outward(self):
		# out of the jet as it reads in source coordinates: a box's faces
		# wound as the jet's (mirrored), its top face up and its aft face aft
		v, f = box((0.0, 90.0, -10.0), (100.0, 100.0, 10.0))
		tris = v[f][:, ::-1]
		n = check.outward(tris)
		top = tris.mean(1)[:, 1] > 99.9
		aft = tris.mean(1)[:, 0] > 99.9
		np.testing.assert_allclose(n[top], np.tile([0.0, 1.0, 0.0], (top.sum(), 1)), atol=1e-12)
		np.testing.assert_allclose(n[aft], np.tile([1.0, 0.0, 0.0], (aft.sum(), 1)), atol=1e-12)

	def test_folds(self):
		# the angle between neighbouring faces' normals: none on a flat sheet,
		# the turn of a hinge, the sharpest of several, and nothing between
		# faces that share only a corner
		flat = np.array([[[0, 0, 0], [1, 0, 0], [0, 1, 0]], [[1, 0, 0], [1, 1, 0], [0, 1, 0]]], float)
		self.assertAlmostEqual(check.folds(flat), 0.0, places=6)
		for angle in (30.0, 100.0):
			a = math.radians(angle)
			bent = np.array([[[0, 0, 0], [1, 0, 0], [0, 1, 0]], [[0, 0, 0], [0, 1, 0], [-math.cos(a), 0, math.sin(a)]]], float)
			self.assertAlmostEqual(check.folds(bent), angle, places=6)
		three = np.concatenate([flat, np.array([[[1, 0, 0], [2, 0, 1], [1, 1, 0]]], float)])
		self.assertAlmostEqual(check.folds(three), 45.0, places=6)
		apart = np.array([[[0, 0, 0], [1, 0, 0], [0, 1, 0]], [[0, 0, 0], [0, 0, 1], [-1, 0, 0]]], float)
		self.assertAlmostEqual(check.folds(apart), 0.0, places=6)
		# a sliver beside a face, turned whichever way its rounding left it, has no fold
		sliver = np.concatenate([flat, np.array([[[1, 0, 0], [0, 1, 0], [0.5, 0.5, 0.0005]]], float)])
		self.assertAlmostEqual(check.folds(sliver), 0.0, places=6)

	def test_shading(self):
		# a sheet in the model frame (metres) shading as exported: flat with
		# its own normals, nothing; a hinge shaded smooth (one normal at each
		# shared corner, the mean of its faces') turns, and each corner's normal
		# stands half the turn off its face; shaded sharp (each face its own
		# normals) it turns nothing; a triangle of no area (a cut's point on an
		# edge, split across) is counted, and its corners' noise judged in none
		up = np.array([0.0, 0.0, 1.0])
		flat = 0.1 * np.array([[[0, 0, 0], [1, 0, 0], [0, 1, 0]], [[1, 0, 0], [1, 1, 0], [0, 1, 0]]], float)
		self.assertEqual(check.shading(flat, np.tile(up, (2, 3, 1))), (0, 0.0, 0, 0.0, None))
		a = math.radians(60.0)
		bent = 0.1 * np.array([[[0, 0, 0], [0, 1, 0], [-1, 0, 0]], [[0, 0, 0], [math.cos(a), 0, math.sin(a)], [0, 1, 0]]], float)
		faces = np.array([up, [-math.sin(a), 0.0, math.cos(a)]])
		mean = faces.mean(0) / np.linalg.norm(faces.mean(0))
		smooth = np.array([[mean, mean, faces[0]], [mean, faces[1], mean]])
		flat_, off, worst, turn, where = check.shading(bent, smooth)
		self.assertEqual(flat_, 0)
		self.assertAlmostEqual(off, 30.0, places=4)
		self.assertAlmostEqual(turn, 60.0, places=4)
		sharp = np.array([[faces[0]] * 3, [faces[1]] * 3])
		flat_, off, worst, turn, where = check.shading(bent, sharp)
		self.assertAlmostEqual(off, 0.0, places=4)
		self.assertEqual((turn, where), (0.0, None))
		# a cut's point on the shared edge, its face split along the edge: no
		# area, its own normal noise, its corners' normals pointing anywhere
		cut = np.concatenate([flat, 0.1 * np.array([[[1, 0, 0], [0.4, 0.6, 0], [0, 1, 0]]], float)])
		noise = np.concatenate([np.tile(up, (2, 3, 1)), np.array([[[1.0, 0, 0], [0, 1.0, 0], [0, -1.0, 0]]])])
		flat_, off, worst, turn, where = check.shading(cut, noise)
		self.assertEqual((flat_, off, turn), (1, 0.0, 0.0))
		# but its normals bending a real neighbour's corner are seen
		noise[0, 1] = [1.0, 0, 0]
		self.assertAlmostEqual(check.shading(cut, noise)[1], 90.0, places=4)

	def test_lip(self):
		# the least a ring stands outside another round an axis, over the
		# angles asked: two circles 0.2 apart, a dent in the outer one's
		# reach, a dent outside the angles asked, and no angle with both
		circle = lambda r, turns: np.c_[r * np.cos(np.radians(turns)), r * np.sin(np.radians(turns))]
		turns = np.arange(-180.0, 180.0, 0.5)
		self.assertAlmostEqual(check.lip(circle(18.0, turns), circle(17.8, turns), range(-60, 96, 2)), 0.2, places=6)
		dent = circle(18.0, turns)
		dent[np.abs(turns - 40.0) < 2] *= 17.7 / 18.0
		self.assertAlmostEqual(check.lip(dent, circle(17.8, turns), range(-60, 96, 2)), -0.1, places=6)
		dent = circle(18.0, turns)
		dent[np.abs(turns - 150.0) < 2] *= 17.7 / 18.0
		self.assertAlmostEqual(check.lip(dent, circle(17.8, turns), range(-60, 96, 2)), 0.2, places=6)
		self.assertTrue(np.isnan(check.lip(circle(18.0, np.arange(100.0, 120.0)), circle(17.8, turns), range(-60, 96, 2))))

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
		# a mid-plane given as a point and its normal reads as the one fitted to the part's own points
		block = tris((5.0, 102.0, 38.0), (95.0, 160.0, 42.0))
		self.assertAlmostEqual(check.seated(block, skin, stations, (np.array([50.0, 130.0, 40.0]), np.array([0.0, 0.0, 2.0]))), check.seated(block, skin, stations), places=6)
		# and a plane off the part's middle puts its whole foot on one side, where a lifted face's foot is missed
		v, f = box((5.0, 99.5, 38.0), (95.0, 160.0, 42.0))
		v[(v[:, 1] < 100) & (v[:, 2] > 40)] += [0.0, 2.5, 0.0]
		self.assertAlmostEqual(check.seated(v[f], skin, stations, (np.array([50.0, 130.0, 40.0]), np.array([0.0, 0.0, 1.0]))), 2.0, places=6)
		self.assertAlmostEqual(check.seated(v[f], skin, stations, (np.array([50.0, 130.0, 37.0]), np.array([0.0, 0.0, 1.0]))), -0.5, places=6)
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
		# nor on a face steeper than 0.7 across the lines (1.5 in apart), which the
		# view across it measures; on a gentler one, it is
		steep = np.stack([wave, wave + 3.0, wave + 6.0])
		gentle = np.stack([wave, wave + 0.6, wave + 1.2])
		self.assertEqual(check.waves(steep, stations, free, step=1.5), [])
		self.assertTrue(check.waves(gentle, stations, free, step=1.5))
		self.assertTrue(check.waves(steep, stations, free))

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


class HookTest(unittest.TestCase):
	# the hook's castings' checks (check.py hook()) and its mechanisms' sweeps
	def _jet(self, d, nodes, joints, motion=None):
		path = Path(d) / "m.glb"
		glb(path, nodes)
		(Path(d) / "m.json").write_text(json.dumps({"joints": joints, "points": {}, "motion": motion or {}}))
		return check.Jet(path, Path(d) / "m.json")

	def test_held_is_the_largest_loop_round_the_line(self):
		# a square round the line and a smaller one beside it: the square, its area
		square = lambda x0, y0, x1, y1: np.array([[[x0, y0, 0], [x1, y0, 0]], [[x1, y0, 0], [x1, y1, 0]], [[x1, y1, 0], [x0, y1, 0]], [[x0, y1, 0], [x0, y0, 0]]], float)
		segments = np.concatenate([square(-1, -2, 1, 2), square(3, -1, 4, 1)])
		outline, area = check.held(segments, np.zeros(3), np.array([1.0, 0, 0]), np.array([0, 1.0, 0]))
		self.assertAlmostEqual(area, 8.0)
		self.assertAlmostEqual(outline[:, 0].max(), 1.0)
		self.assertIsNone(check.held(square(3, -1, 4, 1), np.zeros(3), np.array([1.0, 0, 0]), np.array([0, 1.0, 0])))

	def test_corners(self):
		# a hexagon cut through its sides' middles has six corners however many
		# points lie along them; a round head's twelve sides have twelve
		hexagon = [(math.cos(math.pi / 3 * k), math.sin(math.pi / 3 * k)) for k in range(6)]
		along = [p for a, b in zip(hexagon, hexagon[1:] + hexagon[:1]) for p in (a, ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2))]
		self.assertEqual(check.corners(along[3:] + along[:3] + [along[3]]), 6)
		self.assertEqual(check.corners([(math.cos(math.pi / 6 * k), math.sin(math.pi / 6 * k)) for k in range(12)]), 12)

	def test_a_flare_changes_gently_and_a_step_does_not(self):
		# a round bar flaring over 3 in into a wider one, cast as one loft, and
		# the same two bars butted: along the line the flare's equivalent
		# radius grows by under FLARE an inch, the butted pair's jumps
		i = 0.0254

		def lofted(stations):
			rings = [[(s * i, r * math.sin(2 * math.pi * k / 24) * i, r * math.cos(2 * math.pi * k / 24) * i) for k in range(24)] for s, r in stations]
			v = np.array([p for ring in rings for p in ring])
			f = [(a * 24 + k, a * 24 + (k + 1) % 24, (a + 1) * 24 + (k + 1) % 24) for a in range(len(rings) - 1) for k in range(24)]
			f += [(a * 24 + k, (a + 1) * 24 + (k + 1) % 24, (a + 1) * 24 + k) for a in range(len(rings) - 1) for k in range(24)]
			f += [(0, k + 1, k) for k in range(1, 23)] + [((len(rings) - 1) * 24, (len(rings) - 1) * 24 + k, (len(rings) - 1) * 24 + k + 1) for k in range(1, 23)]
			return v, np.array(f)

		ease = lambda t: min(1.0, max(0.0, t)) ** 2 * (3 - 2 * min(1.0, max(0.0, t)))
		smooth = lofted([(s, 1.2 + 0.7 * ease((s - 4.0) / 3.0)) for s in np.arange(0.0, 10.01, 0.25)])
		thin, wide = lofted([(0.0, 1.2), (6.0, 1.2)]), lofted([(6.0, 1.9), (10.0, 1.9)])
		butted = (np.concatenate([thin[0], wide[0]]), np.concatenate([thin[1], wide[1] + len(thin[0])]))
		# model x is forward: the line runs aft, stations increasing
		stations = np.arange(1.0, 9.0, 0.1)
		for mesh, gentle in ((smooth, True), (butted, False)):
			with tempfile.TemporaryDirectory() as d:
				jet = self._jet(d, [{"name": "hook", "mesh": mesh}], {})
				slope = check.steepest(jet, ["hook"], np.array([456.0, 105.0, 0.0]), np.array([-1.0, 0, 0]), np.array([0, 0, 1.0]), np.array([0, 1.0, 0]), stations)
				self.assertEqual(slope < check.FLARE, gentle, slope)

	def test_area_within(self):
		# a triangle's area counts where its middle lies along the line
		tri = np.array([[[0, 0, 0], [1, 0, 0], [0, 1, 0]], [[5, 0, 0], [7, 0, 0], [5, 2, 0]]], float)
		self.assertAlmostEqual(check.area_within(tri, np.zeros(3), np.array([1.0, 0, 0]), -1, 2), 0.5)
		self.assertAlmostEqual(check.area_within(tri, np.zeros(3), np.array([1.0, 0, 0]), 2, 9), 2.0)

	def test_the_swing_is_swept_down_from_stop_to_stop(self):
		# a hook swinging sideways on a pivot (drive swing) and lowered about
		# its pin (drive hook): stowed, a swing would carry its end through a
		# post beside it; held down (HELD), as only the wire swings it, its
		# sweep runs from one stop to the other (STROKES, the points file's
		# travel each way) and clears the post; the hook's own sweep starts
		# stowed
		bar = box((0.0, -0.03, -0.03), (1.0, 0.03, 0.03))
		nodes = [{"name": "pivot", "mesh": None, "children": [1]}, {"name": "arm", "mesh": bar}, {"name": "post", "mesh": box((0.75, -0.05, 0.25), (0.85, 0.05, 0.35))}]
		joints = {"pivot": {"motion": "rotate", "axis": [0, 1, 0], "drive": "swing", "keys": [[-math.pi, -math.pi], [math.pi, math.pi]]},
			"arm": {"motion": "rotate", "axis": [0, 0, 1], "drive": "hook", "keys": [[0, 0], [1, -1.0472]]}}
		with tempfile.TemporaryDirectory() as d:
			jet = self._jet(d, nodes, joints, {"swing": 20.0})
			rows = list(check.clearance(jet, "swing", 21))
			self.assertFalse([r for r in rows if r["what"].startswith("arm through post")], rows)
			held = check.HELD
			try:
				check.HELD = {}
				rows = list(check.clearance(jet, "swing", 21))
			finally:
				check.HELD = held
			clash = [r for r in rows if r["what"].startswith("arm through post")]
			self.assertEqual(len(clash), 1)
			self.assertIn("swing -0.349-", clash[0]["what"])   # toward its stop
			self.assertTrue(check.failed(clash[0]))
			rows = list(check.clearance(jet, "hook", 21))
			self.assertFalse([r for r in rows if r["what"].startswith("arm through post")])
			np.testing.assert_allclose(check.STROKES["swing"](jet, 3), [-math.radians(20), 0, math.radians(20)])
			self.assertEqual(check.STROKES["hook"](jet, 3)[0], 0.0)
		self.assertIn("hook", check.SWEPT)
		self.assertIn("swing", check.SWEPT)


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
		self.joints = {"aileron_right": {"motion": "rotate", "axis": [0, 0, 1], "drive": "aileron.right", "keys": [[0, 0], [1, 1]]}}
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
			point = features.landmark(name, {"aileron.right": 0.2}) + np.array([0, 0.0254, 0]) * 3.0
			marks[name] = list(self.cam.project(self.camera, point[None], np.array(self.size, float) / 2)[0][0])
		catalogue = {"frame": self.frame, "photos": {"p": {"marks": marks}}}
		tips = self.tips.Tips(catalogue, [{"photo": "p", "size": list(self.size), "camera": list(self.camera)}], self.model, self.joints, features)
		kind = {"marks": ["wingtip_leading_right", "wingtip_trailing_right"], "span": self.SPAN}
		offset, deflections, _ = tips.fit(kind)
		self.assertAlmostEqual(offset, 3.0, places=2)
		self.assertAlmostEqual(deflections[("p", "aileron.right")], 0.2, places=3)
		# held neutral, the deflection has nowhere to go but the raise
		offset, deflections, misses = tips.fit(kind, neutral=True)
		self.assertEqual(deflections, {})
		self.assertGreater(max(m[3] for m in misses), 0.3)

	def test_the_spans_come_from_the_facts(self):
		k = self.tips.kinds()
		self.assertEqual(k["wing"]["span"][0], check.FACTS["layout"]["wing"]["buttline"])
		self.assertAlmostEqual(k["stabilator"]["span"][1] - k["stabilator"]["span"][0], check.value(check.FACTS["stabilator"]["exposed"]) * 6)


class PaintTest(unittest.TestCase):
	def test_a_texel_takes_its_longer_step_as_the_build_does(self):
		# a face stretched along one of the atlas's axes: build.py texel_size()
		# takes a texel's largest step to a neighbour, and draws its heads by it
		face = np.array([[0.0, 0.0, 0.0], [4.4, 0.0, 0.0], [0.0, 3.5, 0.0]])
		uv = np.array([[0.0, 0.0], [10.0, 0.0], [0.0, 10.0]]) / 4096
		self.assertAlmostEqual(check.texel_of(face, uv, 4096), 0.44)
		square = np.array([[0.0, 0.0, 0.0], [3.5, 0.0, 0.0], [0.0, 3.5, 0.0]])
		self.assertAlmostEqual(check.texel_of(square, uv, 4096), 0.35)

	def test_a_head_reads_the_photos_shade_on_fine_texels_and_fades_on_coarse(self):
		# drawn as the build draws it: on texels far finer than the head it
		# reads its own shade against the paint between heads, and lighter as
		# the texel grows past it
		fine, usual, coarse = (check.drawn(t, 0.92, 0.14, 0.71) for t in (0.04, 0.35, 0.6))
		self.assertAlmostEqual(fine, 0.71, delta=0.02)
		self.assertTrue(fine < usual < coarse < 1.0)
		self.assertAlmostEqual(usual, 0.939, delta=0.01)                  # each texel darkened by the share of it a head covers
		# heads closer than a texel run together into a line: no dots stand
		# out against the paint between them
		self.assertGreater(check.drawn(0.35, 0.2, 0.14, 0.71), 0.99)
		self.assertEqual(check.drawn(0.35, 0.92, 0.14, 1.0), 1.0)        # undrawn heads read the paint

	def test_eroded_keeps_only_what_holds_all_round(self):
		mask = np.zeros((20, 20), bool)
		mask[5:15, 5:15] = True
		out = check.eroded(mask, 2)
		self.assertEqual(int(out.sum()), 36)                            # 10 x 10 less 2 each side
		self.assertEqual(out[7, 7], 1.0)
		self.assertEqual(out[6, 6], 0.0)
		self.assertEqual(int(check.eroded(np.ones((6, 6), bool), 1).sum()), 16)   # the image's edge holds nothing beyond
		holed = np.ones((9, 9), bool)
		holed[4, 4] = False
		self.assertEqual([check.eroded(holed, 1)[y, x] for y, x in ((3, 3), (3, 5), (5, 3), (5, 5))], [0.0] * 4)   # a square reach: the hole's corner neighbours go too


if __name__ == "__main__":
	unittest.main()
