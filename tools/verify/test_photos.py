# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# usage: python3 -I test_photos.py
import io
import json, math, sys, tempfile, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

import camera as cam  # noqa: E402
import cast  # noqa: E402
import crop  # noqa: E402
import model as mod  # noqa: E402
import photos  # noqa: E402
from test_verify import JET, box, glb  # noqa: E402


class HelpersTest(unittest.TestCase):
	def test_priors_become_planes(self):
		frame = mod.Frame(JET)
		planes = photos.priors(frame, {"at": [100.0, None, 12.0], "sigma": [1.0, 9.0, 0.5]})
		self.assertEqual(len(planes), 2)
		p = frame.model([100.0, 140.0, 12.0])
		for normal, offset, sigma in planes:
			self.assertAlmostEqual(normal @ p, offset)
		self.assertAlmostEqual(planes[0][2], 0.0254)
		self.assertAlmostEqual(planes[1][2], 0.5 * 0.0254)

	def test_snap_finds_the_edge(self):
		gray = np.zeros((100, 100))
		gray[:, 60:] = 255.0
		moved = photos.snap(gray, [[52, 20], [53, 50], [54, 80]], 10)
		self.assertTrue(np.all(np.abs(moved[:, 0] - 59.5) <= 1.0), moved)
		np.testing.assert_allclose(moved[:, 1], [20, 50, 80], atol=1.0)

	def test_crop_refuses_a_runaway_size(self):
		photo = (8000, 5000)
		self.assertEqual(crop.size(100, 200, 500, 400, 1400, photo), ((100, 200, 500, 400), (1400, 700)))
		# a box past the photo's edge is held inside it, not padded out to ten billion pixels
		self.assertEqual(crop.size(0, 0, 99999, 99999, 1600, photo), ((0, 0, 8000, 5000), (1600, 1000)))
		# a thin strip drawn 1400 wide would be millions of pixels tall
		with self.assertRaises(ValueError):
			crop.size(100, 200, 102, 5000, 1400, photo)
		with self.assertRaises(ValueError):
			crop.size(500, 200, 100, 400, 1400, photo)

	def test_segment_distance(self):
		segments = photos.to_segments(np.array([[0.0, 0.0], [10.0, 0.0], [10.0, 10.0]]))
		d, i = photos.segment_distance([[5, 3], [12, 5], [-4, 0]], segments)
		np.testing.assert_allclose(d, [3, 2, 4])
		self.assertEqual(list(i), [0, 1, 0])


class CastTest(unittest.TestCase):
	# A box with a flap, photographed by a known camera: a pixel cast onto the
	# surface lands on the point it shows, on the flap as the photo poses it,
	# and the projection goes back the other way
	def setUp(self):
		self.dir = tempfile.TemporaryDirectory()
		root = Path(self.dir.name)
		glb(root / "m.glb", [{"name": "fuselage", "mesh": box((-4, -0.5, -0.6), (4, 0.5, 0.6))},
			{"name": "flap", "translation": (-4, 0, 0), "mesh": box((-1, -0.05, -2), (0, 0.05, 2))}])
		self.points = {"joints": {"flap": {"motion": "rotate", "axis": [0, 0, 1], "drive": "flap", "keys": [[0, 0], [1, math.pi / 2]]}}}
		self.camera = cam.looking(np.array([3.0, 4.0, 9.0]), np.zeros(3), 3000.0)
		self.size = (3000, 2000)
		self.cameras = [{"photo": "p", "size": list(self.size), "camera": list(self.camera), "pose": {"flap": 1}}]
		self.catalogue = {"frame": JET}
		self.model = mod.Model(root / "m.glb")

	def tearDown(self):
		self.dir.cleanup()

	def pixel(self, point):
		return cam.project(self.camera, np.array([point], float), np.array(self.size, float) / 2)[0][0]

	def test_a_pixel_lands_where_its_surface_is(self):
		caster = cast.Caster(self.catalogue, self.model, self.points, self.cameras, "p")
		frame = mod.Frame(JET)
		# a point on the box's starboard face, which the camera sees
		point = np.array([1.3, 0.2, 0.6])
		how, at = caster.cast(self.pixel(point))
		self.assertEqual(how, "surface")
		np.testing.assert_allclose(at, frame.source(point), atol=1e-4)
		# the camera's pixel for it comes back
		np.testing.assert_allclose(caster.project(frame.source(point))[0], self.pixel(point), atol=1e-6)

	def test_the_surface_is_posed_as_the_photo_has_it(self):
		# the flap swung down a right angle about its hinge at x = -4: its tip,
		# 1 m aft at rest, now hangs 1 m below the hinge, its face toward the
		# camera at x = -3.95
		caster = cast.Caster(self.catalogue, self.model, self.points, self.cameras, "p", onto=["flap"])
		frame = mod.Frame(JET)
		point = np.array([-3.95, -0.6, 0.05])
		how, at = caster.cast(self.pixel(point))
		self.assertEqual(how, "surface")
		np.testing.assert_allclose(at, frame.source(point), atol=1e-4)

	def test_a_pixel_off_the_model_needs_a_plane(self):
		caster = cast.Caster(self.catalogue, self.model, self.points, self.cameras, "p", onto=["fuselage"])
		frame = mod.Frame(JET)
		off = np.array([2.0, 1.5, 0.0])
		self.assertEqual(caster.cast(self.pixel(off)), ("missed", None))
		station = frame.source(off)[0]
		how, at = caster.cast(self.pixel(off), f"station={station}")
		self.assertEqual(how, f"station={station}")
		np.testing.assert_allclose(at, frame.source(off), atol=1e-4)

	def test_a_plane_wins_over_the_surface_behind(self):
		# a part standing off the skin (a probe's tip) is cast onto its plane
		# even where the skin lies behind it along the sight line
		caster = cast.Caster(self.catalogue, self.model, self.points, self.cameras, "p", onto=["fuselage"])
		frame = mod.Frame(JET)
		tip = np.array([1.3, 0.2, 1.0])   # in front of the box's starboard face
		self.assertEqual(caster.cast(self.pixel(tip))[0], "surface")
		buttline = frame.source(tip)[2]
		how, at = caster.cast(self.pixel(tip), f"buttline={buttline}")
		self.assertEqual(how, f"buttline={buttline}")
		np.testing.assert_allclose(at, frame.source(tip), atol=1e-4)


class MatchTest(unittest.TestCase):
	# A box "airframe" with a flap, photographed from three sides: the match
	# recovers where its corners really are, reports the model's misses, and
	# measures an edge traced along a curve.
	def setUp(self):
		self.dir = tempfile.TemporaryDirectory()
		root = Path(self.dir.name)
		(root / "references" / "photos").mkdir(parents=True)
		glb(root / "m.glb", [{"name": "fuselage", "mesh": box((-4, -0.5, -0.6), (4, 0.5, 0.6))},
			{"name": "flap", "translation": (-4, 0, 0), "mesh": box((-1, -0.05, -2), (0, 0.05, 2))}])
		(root / "m.json").write_text(json.dumps({"joints": {"flap": {"motion": "rotate", "axis": [0, 0, 1], "drive": "flap", "keys": [[0, 0], [1, math.pi / 2]]}}}))
		frame = mod.Frame(JET)
		corners = {"nose_top": [4, 0.5, 0], "nose_bottom": [4, -0.5, 0], "tail_top_right": [-4, 0.5, 0.6], "tail_top_left": [-4, 0.5, -0.6],
			"tail_bottom_right": [-4, -0.5, 0.6], "tail_bottom_left": [-4, -0.5, -0.6], "front_right": [4, 0.5, 0.6], "front_left": [4, 0.5, -0.6],
			"flap_tip_right": [-5, 0, 2], "flap_tip_left": [-5, 0, -2]}
		# the model puts one corner 3 in too high: the match must say so
		self.truth = {n: np.array(p, float) for n, p in corners.items()}
		modelled = dict(self.truth)
		modelled["front_right"] = self.truth["front_right"] + [0, 3 * 0.0254, 0]
		modelled["front_left"] = self.truth["front_left"] + [0, 3 * 0.0254, 0]
		features = {"landmarks": {n: {"at": list(p), "node": "flap" if n.startswith("flap") else "fuselage"} for n, p in modelled.items()},
			"curves": {"top_right": {"points": [[4, 0.5, 0.6], [-4, 0.5, 0.6]], "node": "fuselage"}}}
		(root / "features.json").write_text(json.dumps(features))
		catalogue = {"frame": JET, "mirror": ["_left", "_right"], "points": {
			"nose_top": {"at": list(frame.source(self.truth["nose_top"])), "sigma": 0.0},
			"nose_bottom": {"at": list(frame.source(self.truth["nose_bottom"])), "sigma": 0.0},
			"tail_top_right": {"at": list(frame.source(self.truth["tail_top_right"])), "sigma": 0.0},
			"tail_bottom_left": {"at": list(frame.source(self.truth["tail_bottom_left"])), "sigma": 0.0}}, "photos": {}}
		rng = np.random.default_rng(7)
		size = (3000, 2000)
		for k, position in enumerate(((10.0, 3.0, 14.0), (-12.0, 4.0, 9.0), (3.0, 6.0, -15.0))):
			c = cam.looking(np.array(position), np.zeros(3), 3200.0)
			names = list(self.truth)
			pixels = cam.project(c, np.array([self.truth[n] for n in names]), (size[0] / 2, size[1] / 2))[0] + rng.normal(0, 0.3, (len(names), 2))
			Image.new("L", size).save(root / "references" / "photos" / f"p{k}.png")
			edge = cam.project(c, np.array([[4 - 8 * t, 0.5, 0.6] for t in (0.2, 0.4, 0.6, 0.8)]), (size[0] / 2, size[1] / 2))[0]
			catalogue["photos"][f"p{k}"] = {"file": f"photos/p{k}.png", "marks": {n: list(map(float, p)) for n, p in zip(names, pixels)},
				"edges": {"top": {"against": "top_right", "points": edge.tolist()}}}
		(root / "photos.json").write_text(json.dumps(catalogue))
		self.root = root

	def tearDown(self):
		self.dir.cleanup()

	def test_measures_the_real_points(self):
		r = self.root
		match = photos.Match(r / "photos.json", r / "m.glb", r / "m.json", r / "features.json").solve(log=lambda *_: None)
		report = match.report()
		self.assertTrue(all(p["solved"] for p in report["photos"].values()))
		frame = mod.Frame(JET)
		for name, truth in self.truth.items():
			np.testing.assert_allclose(report["points"][name]["measured"], frame.source(truth), atol=0.15, err_msg=name)
		# the model's raised corner shows as a 3 in miss upward, the rest as none
		self.assertAlmostEqual(report["points"]["front_right"]["miss"][1], 3.0, delta=0.15)
		self.assertLess(max(abs(v) for v in report["points"]["tail_top_left"]["miss"]), 0.15)
		self.assertLess(report["edges"]["p0:top"]["median"], 0.1)

	def test_one_photo_measures_across_its_sightline_only(self):
		# front_right marked in one photo only: the report flags it loose along
		# that camera's line of sight, gives the model's miss across it only,
		# and does not depend on where along the line the solve left the point
		r = self.root
		catalogue = json.loads((r / "photos.json").read_text())
		for k, photo in enumerate(catalogue["photos"].values()):
			photo["marks"].pop("front_left")
			if k:
				photo["marks"].pop("front_right")
		(r / "photos.json").write_text(json.dumps(catalogue))
		match = photos.Match(r / "photos.json", r / "m.glb", r / "m.json", r / "features.json").solve(log=lambda *_: None)
		row = match.report()["points"]["front_right"]
		self.assertEqual(row["photos"], 1)
		self.assertEqual(len(row["loose"]), 1)
		frame = mod.Frame(JET)
		eye = frame.source(cam.eye(match.cameras[0]))
		sight = frame.source(self.truth["front_right"]) - eye
		sight /= np.linalg.norm(sight)
		loose = np.array(row["loose"][0])
		self.assertGreater(abs(loose @ sight), 0.999)
		miss = np.array(row["miss"])
		self.assertLess(abs(miss @ loose), 0.05)
		# the raised corner's 3 in, less its part along the line of sight
		self.assertAlmostEqual(np.linalg.norm(miss), 3.0 * math.sqrt(1 - sight[1] ** 2), delta=0.15)
		# slide the solved point 30 cm along its line of sight: nothing reported moves
		match.points["front_right"] = match.points["front_right"] + 0.3 * match.bundle.loose["front_right"][0]
		moved = match.report()["points"]["front_right"]
		np.testing.assert_allclose(moved["miss"], row["miss"], atol=0.02)
		np.testing.assert_allclose(moved["measured"], row["measured"], atol=0.02)

	def test_an_edge_against_a_curve_not_built_is_reported(self):
		r = self.root
		catalogue = json.loads((r / "photos.json").read_text())
		catalogue["photos"]["p0"]["edges"]["spoiler"] = {"against": "spoiler_right", "points": [[10.0, 10.0], [20.0, 20.0]]}
		(r / "photos.json").write_text(json.dumps(catalogue))
		match = photos.Match(r / "photos.json", r / "m.glb", r / "m.json", r / "features.json").solve(log=lambda *_: None)
		report = match.report()
		self.assertTrue(report["edges"]["p0:spoiler"]["missing"])
		self.assertLess(report["edges"]["p0:top"]["median"], 0.1)
		self.assertIn("no such curve", photos.text(report))

	def test_outline_edges_are_signed(self):
		r = self.root
		match = photos.Match(r / "photos.json", r / "m.glb", r / "m.json", r / "features.json").solve(log=lambda *_: None)
		photo, c = match.photos[0], match.cameras[0]
		# a traced outline 2 in below the box's lower right edge (on its silhouette from
		# above): the model stands inside the traced edge (-)
		down = np.array([0, -2 * 0.0254, 0])
		line = cam.project(c, np.array([[4 - 8 * t, -0.5, 0.6] for t in (0.3, 0.5, 0.7)]) + down, photo["centre"])[0]
		result = match.edge(0, {"against": "outline", "points": line.tolist()})
		self.assertLess(result["worst"], -1.0)
		self.assertGreater(result["worst"], -3.0)

	def test_an_outline_of_named_parts(self):
		# an edge seen in front of the rest of the model (a store before the
		# fuselage) is judged against its own parts' silhouette alone: a trace
		# 2 in below the fuselage's lower right edge reads 2 in against the
		# whole model, and far off against the flap's alone
		r = self.root
		match = photos.Match(r / "photos.json", r / "m.glb", r / "m.json", r / "features.json").solve(log=lambda *_: None)
		photo, c = match.photos[0], match.cameras[0]
		down = np.array([0, -2 * 0.0254, 0])
		line = cam.project(c, np.array([[4 - 8 * t, -0.5, 0.6] for t in (0.3, 0.5, 0.7)]) + down, photo["centre"])[0]
		whole = match.edge(0, {"against": "outline", "points": line.tolist()})
		flap = match.edge(0, {"against": "outline", "points": line.tolist(), "parts": ["flap"]})
		self.assertAlmostEqual(abs(whole["median"]), 2.0, delta=0.8)
		self.assertGreater(abs(flap["median"]), 10.0)

	def test_gate(self):
		report = {
			"photos": {"good": {"solved": True, "field": 30.0, "rms": 4.0}, "far": {"solved": True, "field": 1.0, "rms": 4.0}, "loose": {"solved": True, "field": 30.0, "rms": 25.0}},
			"edges": {"good:fin": {"median": 2.0, "worst": 3.0}, "good:nose": {"median": 0.4, "worst": 0.9}, "good:spoiler": {"missing": True},
				"far:spine": {"median": 5.0, "worst": 6.0}, "loose:tail": {"median": 5.0, "worst": 6.0}, "good:known": {"median": 4.0, "worst": 5.0},
				"good:curve": {"median": 2.5, "worst": 2.9, "signed": False}},
			"points": {"near": {"photos": 3, "sigma": [1, 1, 1], "miss": [0.5, -2.5, 0.0]}, "off": {"photos": 3, "sigma": [1, 1, 1], "miss": [0.0, 3.5, 0.0]},
				"small": {"photos": 3, "sigma": [0.1, 0.1, 0.1], "miss": [0.0, 0.9, 0.0]}, "unbuilt": {"photos": 3, "sigma": [1, 1, 1]}},
		}
		spec = {"edge": 1.5, "sigmas": 3, "floor": 1.0, "field": 1.5, "rms": 15, "known": {"edge good:known": "a finding"}}
		failures, known, unjudged = photos.gate(report, spec)
		# an edge past the line, an edge against a curve not built, a point past both lines
		self.assertEqual(sorted(n for n, _ in failures), ["edge good:curve", "edge good:fin", "edge good:spoiler", "point off"])
		# a curve's miss is a distance, printed without a side
		self.assertIn(("edge good:curve", "median miss 2.50 in, worst 2.90 (a distance from the build's curve, without a side)"), failures)
		self.assertIn(("edge good:fin", "median miss 2.00 in, worst +3.00"), failures)
		# and the report's table says so too
		table = photos.text({"photos": {}, "points": {}, "anchors": {}, "locate": {}, "edges": {"good:curve": dict(report["edges"]["good:curve"], against="fin_leading", points=4)}})
		self.assertIn("worst   2.90 in, no side (a curve)", table)
		# within 3 sigma, or within the inch floor however small the sigma: not a failure
		self.assertNotIn("point near", [n for n, _ in failures])
		self.assertNotIn("point small", [n for n, _ in failures])
		# a known miss carries its why; a weak camera's edges are not judged
		self.assertEqual(known, [("edge good:known", "median miss 4.00 in, worst +5.00: a finding")])
		self.assertEqual(sorted(n for n, _ in unjudged), ["edge far:spine", "edge loose:tail"])

	def test_a_failed_gate_still_writes_its_cameras(self):
		# a gate nothing can pass (no edge may miss at all): the run fails, but the cameras are written first
		r = self.root
		catalogue = json.loads((r / "photos.json").read_text())
		catalogue["gate"] = {"edge": -1.0, "sigmas": 0, "floor": -1.0, "field": 0.0, "rms": 1e9, "known": {}}
		(r / "photos.json").write_text(json.dumps(catalogue))
		out = r / "cameras.json"
		argv, stdout = sys.argv, sys.stdout
		sys.argv = ["photos.py", str(r / "photos.json"), str(r / "m.glb"), str(r / "m.json"), str(r / "features.json"), "--check", "--cameras", str(out)]
		sys.stdout = io.StringIO()
		try:
			with self.assertRaises(SystemExit) as caught:
				photos.main()
		finally:
			sys.argv, sys.stdout = argv, stdout
		self.assertEqual(caught.exception.code, 1)
		self.assertTrue(out.exists())
		self.assertTrue(json.loads(out.read_text()))

	def test_the_frame_symbol_prints(self):
		# a frame naming its unit's symbol prints every miss with it, in the report and the gate
		r = self.root
		catalogue = json.loads((r / "photos.json").read_text())
		catalogue["frame"] = dict(JET, symbol="ft")
		catalogue["gate"] = {"edge": -1.0, "sigmas": 0, "floor": -1.0, "field": 0.0, "rms": 1e9, "known": {}}
		(r / "photos.json").write_text(json.dumps(catalogue))
		argv, stdout = sys.argv, sys.stdout
		sys.argv = ["photos.py", str(r / "photos.json"), str(r / "m.glb"), str(r / "m.json"), str(r / "features.json"), "--check"]
		sys.stdout = io.StringIO()
		try:
			with self.assertRaises(SystemExit):
				photos.main()
			printed = sys.stdout.getvalue()
		finally:
			sys.argv, sys.stdout = argv, stdout
		self.assertRegex(printed, r"photo p0: .* worst \S+ [0-9.]+ ft")
		self.assertRegex(printed, r"edge p0:top +against top_right +4 points, median +[0-9.]+ ft, worst +[0-9.]+ ft, no side")
		self.assertRegex(printed, r"FAILED: edge p0:top: median miss [0-9.]+ ft,")
		self.assertRegex(printed, r"FAILED: point \S+: miss \[.*\] ft, uncertainty")
		self.assertNotIn(" in,", printed)
		self.assertNotIn(" in\n", printed)

	def test_a_part_posed_differently_in_each_photo(self):
		# The flap drooped in one photo and not the others: its tips, carried into
		# that photo's pose, still measure where they stand in the catalogue's pose
		# (rest), and that photo's camera fits as well as the others'
		r = self.root
		catalogue = json.loads((r / "photos.json").read_text())
		f = photos.Features(mod.Model(r / "m.glb"), json.loads((r / "m.json").read_text())["joints"], r / "features.json")
		camera = cam.looking(np.array((-12.0, 4.0, 9.0)), np.zeros(3), 3200.0)   # p1's, as setUp made it
		drooped = {"flap": 0.3}
		for name in ("flap_tip_right", "flap_tip_left"):
			at = f.landmark(name, drooped)
			catalogue["photos"]["p1"]["marks"][name] = list(map(float, cam.project(camera, [at], (1500, 1000))[0][0]))
		catalogue["photos"]["p1"]["pose"] = drooped
		(r / "photos.json").write_text(json.dumps(catalogue))
		match = photos.Match(r / "photos.json", r / "m.glb", r / "m.json", r / "features.json").solve(log=lambda *_: None)
		report = match.report()
		frame = mod.Frame(JET)
		for name in ("flap_tip_right", "flap_tip_left"):
			np.testing.assert_allclose(report["points"][name]["measured"], frame.source(self.truth[name]), atol=0.15, err_msg=name)
			self.assertLess(max(abs(v) for v in report["points"][name]["miss"]), 0.15)
		self.assertLess(report["photos"]["p1"]["rms"], 1.0)

	def test_features_follow_the_pose(self):
		r = self.root
		m = mod.Model(r / "m.glb")
		f = photos.Features(m, json.loads((r / "m.json").read_text())["joints"], r / "features.json")
		tip = f.landmark("flap_tip_right", {"flap": 1})
		# the flap swings a right angle about its hinge at x = -4: its tip, 1 m aft of the hinge, ends 1 m down
		np.testing.assert_allclose(tip, [-4, -1, 2], atol=1e-6)

	def bent(self):
		# The flap given a shape key, "flex", that drops its aft half 0.05 m per
		# unit of the "load" drive, and the features file the move at its tips
		r = self.root
		v, f = box((-1, -0.05, -2), (0, 0.05, 2))
		glb(r / "m.glb", [{"name": "fuselage", "mesh": box((-4, -0.5, -0.6), (4, 0.5, 0.6))},
			{"name": "flap", "translation": (-4, 0, 0), "mesh": (v, f), "targets": {"flex": np.where(v[:, :1] < -0.5, [0, -0.05, 0], 0)}, "sparse": True}])
		joints = {"flap": {"motion": "rotate", "axis": [0, 0, 1], "drive": "flap", "keys": [[0, 0], [1, math.pi / 2]],
			"morphs": {"flex": {"drive": "load", "keys": [[0, 0], [1, 1]]}}}}
		(r / "m.json").write_text(json.dumps({"joints": joints}))
		features = json.loads((r / "features.json").read_text())
		for name in ("flap_tip_right", "flap_tip_left"):
			features["landmarks"][name]["morphs"] = {"flex": [0, -0.05, 0]}
		(r / "features.json").write_text(json.dumps(features))
		return photos.Features(mod.Model(r / "m.glb"), joints, r / "features.json")

	def test_features_carry_shape_keys(self):
		f = self.bent()
		np.testing.assert_allclose(f.landmark("flap_tip_right", {"load": 1}), [-5, -0.05, 2], atol=1e-6)
		# the key moves the tip before the flap turns: (-1, -0.05) from the hinge goes to (0.05, -1)
		np.testing.assert_allclose(f.landmark("flap_tip_right", {"load": 1, "flap": 1}), [-3.95, -1, 2], atol=1e-6)
		R, t = f.between({}, {"load": 1}, "flap_tip_right")
		np.testing.assert_allclose(R, np.eye(3), atol=1e-9)
		np.testing.assert_allclose(t, [0, -0.05, 0], atol=1e-6)
		self.assertIsNone(f.between({"load": 1}, {"load": 1}, "flap_tip_right"))
		self.assertIsNone(f.between({}, {"load": 1}, "front_right"))

	def test_a_shape_key_carried_into_a_photo(self):
		# One photo shows the flap bent by its shape key: its tips, carried into
		# that photo's pose, still measure where they stand at rest, and that
		# photo's camera fits as well as the others'
		r = self.root
		f = self.bent()
		catalogue = json.loads((r / "photos.json").read_text())
		camera = cam.looking(np.array((-12.0, 4.0, 9.0)), np.zeros(3), 3200.0)   # p1's, as setUp made it
		loaded = {"load": 1}
		for name in ("flap_tip_right", "flap_tip_left"):
			at = f.landmark(name, loaded)
			catalogue["photos"]["p1"]["marks"][name] = list(map(float, cam.project(camera, [at], (1500, 1000))[0][0]))
		catalogue["photos"]["p1"]["pose"] = loaded
		(r / "photos.json").write_text(json.dumps(catalogue))
		match = photos.Match(r / "photos.json", r / "m.glb", r / "m.json", r / "features.json").solve(log=lambda *_: None)
		report = match.report()
		frame = mod.Frame(JET)
		for name in ("flap_tip_right", "flap_tip_left"):
			np.testing.assert_allclose(report["points"][name]["measured"], frame.source(self.truth[name]), atol=0.15, err_msg=name)
		self.assertLess(report["photos"]["p1"]["rms"], 1.0)

	def test_a_photo_names_its_own_focal(self):
		# p0 carries an EXIF lens of 28 mm at 1000 pixels a centimetre (2800 px).
		# Left alone that is its prior; a focal in the entry replaces it, and
		# false leaves the photo none, as one without EXIF
		r = self.root
		exif = Image.Exif()
		lens = exif.get_ifd(0x8769)
		lens[0x920A], lens[0xA20E], lens[0xA210] = 28.0, 1000.0, 3
		Image.new("L", (3000, 2000)).save(r / "references" / "photos" / "p0.jpg", exif=exif)
		catalogue = json.loads((r / "photos.json").read_text())
		catalogue["photos"]["p0"]["file"] = "photos/p0.jpg"

		def prior(focal):
			entry = catalogue["photos"]["p0"]
			entry.pop("focal", None)
			if focal != "absent":
				entry["focal"] = focal
			(r / "photos.json").write_text(json.dumps(catalogue))
			return photos.Match(r / "photos.json", r / "m.glb", r / "m.json", r / "features.json").photos[0]["focal"]

		self.assertEqual(prior("absent"), (2800.0, 0.1))
		self.assertEqual(prior(3200), (3200, 0.1))
		self.assertIsNone(prior(False))

	def test_the_horizon_holds_a_camera(self):
		# p0's sea horizon, the sea 80 in under the model's origin (waterline 25):
		# the solve fits it, the report and its text give its rms, and a catalogue
		# without a sea refuses it
		r = self.root
		camera = cam.looking(np.array((10.0, 3.0, 14.0)), np.zeros(3), 3200.0)   # p0's, as setUp made it
		eye = cam.eye(camera)
		sea = (25 - 105) * 0.0254
		d = cam.dip(eye[1] - sea)
		forward = -eye * [1, 0, 1] / np.linalg.norm(eye * [1, 0, 1])
		right = np.cross(forward, [0, 1.0, 0])
		directions = [math.cos(d) * (math.cos(a) * forward + math.sin(a) * right) - math.sin(d) * np.array([0, 1.0, 0]) for a in (-0.3, 0.0, 0.3)]
		horizon = cam.project(camera, eye + 1e5 * np.array(directions), (1500, 1000))[0]
		catalogue = json.loads((r / "photos.json").read_text())
		catalogue["photos"]["p0"]["horizon"] = horizon.tolist()
		(r / "photos.json").write_text(json.dumps(catalogue))
		with self.assertRaises(ValueError):
			photos.Match(r / "photos.json", r / "m.glb", r / "m.json", r / "features.json").solve(log=lambda *_: None)
		catalogue["sea"] = "waterline=25"
		(r / "photos.json").write_text(json.dumps(catalogue))
		report = photos.Match(r / "photos.json", r / "m.glb", r / "m.json", r / "features.json").solve(log=lambda *_: None).report()
		self.assertLess(report["photos"]["p0"]["horizon"], 1.0)
		truth = mod.Frame(JET).source(eye)
		np.testing.assert_allclose(report["photos"]["p0"]["camera"], truth, atol=2.0)
		self.assertNotIn("horizon", report["photos"]["p1"])
		self.assertRegex(photos.text(report), r"photo p0: .*, horizon rms [0-9.]+ px")
		# the horizon drawn 30 px low moves the camera: an 8 m box seen from 17 m
		# leaves its pitch and distance loose enough to fit both
		catalogue["photos"]["p0"]["horizon"] = (horizon + [0, 30]).tolist()
		(r / "photos.json").write_text(json.dumps(catalogue))
		report = photos.Match(r / "photos.json", r / "m.glb", r / "m.json", r / "features.json").solve(log=lambda *_: None).report()
		self.assertGreater(np.linalg.norm(np.subtract(report["photos"]["p0"]["camera"], truth)), 10.0)


if __name__ == "__main__":
	unittest.main()
