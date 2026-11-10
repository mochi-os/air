# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# usage: python3 -I test_verify.py
import json, math, struct, sys, tempfile, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import numpy as np  # noqa: E402

import camera as cam  # noqa: E402
import model as mod  # noqa: E402


def box(lo, hi):
	# A closed box's triangles, outward faces
	x0, y0, z0 = lo
	x1, y1, z1 = hi
	v = np.array([[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], float)
	f = [(0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7), (0, 1, 5), (0, 5, 4), (1, 2, 6), (1, 6, 5), (2, 3, 7), (2, 7, 6), (3, 0, 4), (3, 4, 7)]
	return v, np.array(f)


def glb(path, nodes):
	# A minimal glTF binary: nodes [{"name", "translation", "mesh": (vertices, faces) or None, "children": [indices],
	# "targets": {shape key: each vertex's move (n, 3)}, "sparse": the targets written as sparse accessors, as Blender does}]
	blob = bytearray()
	views, accessors, meshes, out = [], [], [], []

	def view(data):
		while len(blob) % 4:
			blob.append(0)
		views.append({"buffer": 0, "byteOffset": len(blob), "byteLength": data.nbytes})
		blob.extend(data.tobytes())
		return len(views) - 1

	for n in nodes:
		entry = {"name": n["name"], "translation": list(map(float, n.get("translation", (0, 0, 0))))}
		if n.get("children"):
			entry["children"] = n["children"]
		if n.get("mesh") is not None:
			v, f = n["mesh"]
			for data, kind, count, width in ((np.asarray(v, np.float32), 5126, len(v), "VEC3"), (np.asarray(f, np.uint32).ravel(), 5125, f.size, "SCALAR")):
				accessors.append({"bufferView": view(data), "componentType": kind, "count": int(count), "type": width})
			primitive = {"attributes": {"POSITION": len(accessors) - 2}, "indices": len(accessors) - 1, "material": 0}
			if n.get("normals") is not None:
				data = np.asarray(n["normals"], np.float32)
				accessors.append({"bufferView": view(data), "componentType": 5126, "count": len(v), "type": "VEC3"})
				primitive["attributes"]["NORMAL"] = len(accessors) - 1
			mesh = {"primitives": [primitive]}
			if n.get("targets"):
				primitive["targets"] = []
				for name, moves in n["targets"].items():
					moves = np.asarray(moves, np.float32)
					if n.get("sparse"):
						rows = np.nonzero(np.abs(moves).sum(1))[0].astype(np.uint32)
						accessors.append({"componentType": 5126, "count": len(v), "type": "VEC3", "sparse": {"count": int(len(rows)),
							"indices": {"bufferView": view(rows), "componentType": 5125}, "values": {"bufferView": view(moves[rows])}}})
					else:
						accessors.append({"bufferView": view(moves), "componentType": 5126, "count": len(v), "type": "VEC3"})
					primitive["targets"].append({"POSITION": len(accessors) - 1})
				mesh["extras"] = {"targetNames": list(n["targets"])}
			meshes.append(mesh)
			entry["mesh"] = len(meshes) - 1
		out.append(entry)
	children = {c for n in nodes for c in n.get("children", [])}
	gltf = {"asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [i for i in range(len(nodes)) if i not in children]}], "nodes": out,
		"meshes": meshes, "accessors": accessors, "bufferViews": views, "buffers": [{"byteLength": len(blob)}], "materials": [{"name": "paint"}]}
	text = json.dumps(gltf).encode()
	text += b" " * (-len(text) % 4)
	while len(blob) % 4:
		blob.append(0)
	total = 12 + 8 + len(text) + 8 + len(blob)
	Path(path).write_bytes(struct.pack("<III", 0x46546C67, 2, total) + struct.pack("<II", len(text), 0x4E4F534A) + text +
		struct.pack("<II", len(blob), 0x004E4942) + bytes(blob))


JET = {"names": ["station", "waterline", "buttline"], "unit": 0.0254, "origin": [456, 105, 0], "axes": [[-1, 0, 0], [0, 1, 0], [0, 0, 1]], "mirror": "buttline"}


class FrameTest(unittest.TestCase):
	def test_round_trip(self):
		frame = mod.Frame(JET)
		p = frame.model([60.5, 100, 12])
		np.testing.assert_allclose(p, [(456 - 60.5) * 0.0254, -5 * 0.0254, 12 * 0.0254])
		np.testing.assert_allclose(frame.source(p), [60.5, 100, 12])

	def test_plane_and_mirror(self):
		frame = mod.Frame(JET)
		normal, offset = frame.plane("station=356")
		self.assertAlmostEqual(normal @ frame.model([356, 140, -30]), offset)
		np.testing.assert_allclose(frame.source(frame.reflection() @ frame.model([300, 110, 40])), [300, 110, -40])

	def test_symbol(self):
		# the unit as printed and in prose: inches, unless the frame names its own
		self.assertEqual((mod.Frame(JET).symbol, mod.Frame(JET).plural), ("in", "inches"))
		feet = mod.Frame(dict(JET, unit=0.3048, symbol="ft", plural="feet"))
		self.assertEqual((feet.symbol, feet.plural), ("ft", "feet"))

	def test_rejects_skewed_axes(self):
		with self.assertRaises(ValueError):
			mod.Frame({**JET, "axes": [[1, 1, 0], [0, 1, 0], [0, 0, 1]]})


class ModelTest(unittest.TestCase):
	def setUp(self):
		self.dir = tempfile.TemporaryDirectory()
		self.path = Path(self.dir.name) / "m.glb"
		# a body, and a flap hinged at x=-1 whose mesh hangs aft of the hinge,
		# and a light shown only when its drive is on
		glb(self.path, [{"name": "body", "mesh": box((-1, -0.1, -0.5), (1, 0.1, 0.5))},
			{"name": "flap", "translation": (-1, 0, 0), "mesh": box((-0.5, -0.02, -0.5), (0, 0.02, 0.5)), "children": [2]},
			{"name": "tab", "translation": (-0.5, 0, 0), "mesh": box((-0.1, -0.01, -0.1), (0, 0.01, 0.1))}])
		self.model = mod.Model(self.path)

	def tearDown(self):
		self.dir.cleanup()

	def test_rest(self):
		tris = self.model.triangles()
		self.assertEqual(len(tris), 36)
		self.assertAlmostEqual(tris[..., 0].min(), -1.6)
		self.assertEqual(self.model.rotated(), [])

	def test_normals(self):
		# each triangle's corners' normals as written, None where a primitive
		# has none
		v, f = box((-1, -0.1, -0.5), (1, 0.1, 0.5))
		normals = v / np.linalg.norm(v, axis=1)[:, None]
		path = Path(self.dir.name) / "n.glb"
		glb(path, [{"name": "body", "mesh": (v, f), "normals": normals}, {"name": "bare", "mesh": box((2, 0, 0), (3, 1, 1))}])
		model = mod.Model(path)
		corners = model.normals[model.nodes[model.index["body"]]["mesh"]][0]
		self.assertEqual(corners.shape, (12, 3, 3))
		self.assertTrue(np.allclose(corners, normals[f], atol=1e-6))
		self.assertIsNone(model.normals[model.nodes[model.index["bare"]]["mesh"]][0])

	def test_rotate_carries_children(self):
		# the flap turns 90 degrees down about its hinge (z axis): its aft
		# edge and the tab beneath it drop below the hinge
		posed = mod.pose({"flap": {"motion": "rotate", "axis": [0, 0, 1], "drive": "flap", "keys": [[0, 0], [1, math.pi / 2]]}}, {"flap": 1})
		parts = self.model.parts(posed)
		self.assertAlmostEqual(parts["flap"][..., 1].min(), -0.5, places=6)
		self.assertAlmostEqual(parts["tab"][..., 1].min(), -0.6, places=6)
		self.assertAlmostEqual(parts["tab"][..., 0].min(), -1.01, places=6)
		self.assertAlmostEqual(parts["body"][..., 1].min(), -0.1)

	def test_joint_named_in_the_pose(self):
		# a joint named in the pose's "joints" takes that value past its drive;
		# another joint on the same drive follows the drive, so a pair that
		# shares one can be posed apart
		joints = {"flap": {"motion": "rotate", "axis": [0, 0, 1], "drive": "flap", "keys": [[0, 0], [1, math.pi / 2]]},
			"tab": {"motion": "rotate", "axis": [0, 0, 1], "drive": "flap", "keys": [[0, 0], [1, math.pi / 2]]}}
		posed = mod.pose(joints, {"flap": 0, "joints": {"flap": math.pi / 2}})
		self.assertAlmostEqual(posed["flap"][2], math.pi / 2)
		self.assertAlmostEqual(posed["tab"][2], 0.0)
		self.assertAlmostEqual(self.model.parts(posed)["flap"][..., 1].min(), -0.5, places=6)
		# the value is the joint's own (radians), not a drive input read through the schedule
		self.assertAlmostEqual(mod.pose(joints, {"joints": {"tab": 0.25}})["tab"][2], 0.25)

	def test_slide_and_show(self):
		joints = {"flap": {"motion": "slide", "axis": [0, 1, 0], "drive": "d", "keys": [[0, 0], [1, 0.3]]},
			"tab": {"motion": "show", "axis": [1, 0, 0], "drive": "s", "keys": [[0, 0], [1, 1]]}}
		parts = self.model.parts(mod.pose(joints, {"d": 1}))
		self.assertAlmostEqual(parts["flap"][..., 1].max(), 0.32, places=6)
		self.assertNotIn("tab", parts)
		self.assertIn("tab", self.model.parts(mod.pose(joints, {"s": 1})))

	def test_show_needs_no_axis(self):
		# a store part shown or hidden by the loadout has no axis to turn about
		joints = {"tab": {"motion": "show", "drive": "stores", "keys": [[0, 0], [1, 1]]}}
		self.assertNotIn("tab", self.model.parts(mod.pose(joints, {})))
		self.assertIn("tab", self.model.parts(mod.pose(joints, {"joints": {"tab": 1}})))

	def test_include_exclude(self):
		self.assertEqual(len(self.model.triangles(include=["fl*"])), 12)
		self.assertEqual(len(self.model.triangles(exclude=["flap", "tab"])), 12)

	def test_cut_and_area(self):
		tris = self.model.triangles(include=["body"])
		segments = mod.cut(tris, [0.3, 0, 0], [1, 0, 0])
		np.testing.assert_allclose(segments[..., 0], 0.3)
		self.assertAlmostEqual(segments[..., 2].max(), 0.5)
		self.assertAlmostEqual(segments[..., 1].min(), -0.1)
		self.assertAlmostEqual(mod.area(tris, [0, 1, 0]), 2 * 2 * 1.0)
		self.assertAlmostEqual(mod.area(tris), 2 * (2 * 1 + 2 * 0.2 + 1 * 0.2))

	def test_lookup_holds_past_ends(self):
		keys = [[0, 0], [0.25, 1], [1, 1]]
		self.assertEqual(mod.lookup(keys, -1), 0)
		self.assertAlmostEqual(mod.lookup(keys, 0.125), 0.5)
		self.assertEqual(mod.lookup(keys, 5), 1)

	def test_lookup_of_several_outputs(self):
		# a bend's keys, [input, turn, slide], give both, each held past the ends
		keys = [[-1, -2, -4], [1, 2, 4]]
		self.assertEqual(mod.lookup(keys, 0.5), (1.0, 2.0))
		self.assertEqual(mod.lookup(keys, 3), (2, 4))

	def test_bend_turns_then_slides(self):
		# the flap turns about its hinge (z) and slides along y in its parent's
		# frame, carrying the tab: at load 1 a right angle and 0.3, at 0.5 half of each
		joints = {"flap": {"motion": "bend", "axis": [0, 0, 1], "direction": [0, 1, 0], "drive": "load", "keys": [[0, 0, 0], [1, math.pi / 2, 0.3]]}}
		parts = self.model.parts(mod.pose(joints, {"load": 1}))
		self.assertAlmostEqual(parts["flap"][..., 1].min(), -0.5 + 0.3, places=6)
		self.assertAlmostEqual(parts["flap"][..., 0].min(), -1.02, places=6)
		self.assertAlmostEqual(parts["tab"][..., 1].min(), -0.6 + 0.3, places=6)
		half = self.model.parts(mod.pose(joints, {"load": 0.5}))
		tip = np.array([-1.5, 0.0, 0.0]) - [-1, 0, 0]
		turned = np.array([math.cos(math.pi / 4) * tip[0], math.sin(math.pi / 4) * tip[0], 0]) + [-1, 0.15, 0]
		self.assertAlmostEqual(half["flap"][..., 1].min(), turned[1] - 0.02 * math.cos(math.pi / 4), places=5)
		self.assertAlmostEqual(parts["body"][..., 1].min(), -0.1)

	def test_shape_keys_follow_their_weights(self):
		# the body's right end rises 0.1 per unit of its key; a "morph" joint
		# weights it through its keys, and a rotate joint's morphs move its
		# mesh before it turns
		v, f = box((-1, -0.1, -0.5), (1, 0.1, 0.5))
		lift = np.where(v[:, :1] > 0, [0, 0.1, 0], 0)
		w, g = box((-0.5, -0.02, -0.5), (0, 0.02, 0.5))
		droop = np.where(w[:, :1] < -0.25, [0, -0.05, 0], 0)
		for sparse in (False, True):
			path = Path(self.dir.name) / f"k{int(sparse)}.glb"
			glb(path, [{"name": "body", "mesh": (v, f), "targets": {"flex": lift}, "sparse": sparse},
				{"name": "flap", "translation": (-1, 0, 0), "mesh": (w, g), "targets": {"flex": droop}, "sparse": sparse}])
			model = mod.Model(path)
			joints = {"body": {"motion": "morph", "morphs": {"flex": {"drive": "load", "keys": [[0, 0], [2, 2]]}}},
				"flap": {"motion": "rotate", "axis": [0, 0, 1], "drive": "flap", "keys": [[0, 0], [1, math.pi / 2]],
					"morphs": {"flex": {"drive": "load", "keys": [[0, 0], [2, 2]]}}}}
			rest = model.parts(mod.pose(joints, {}))
			self.assertAlmostEqual(rest["body"][..., 1].max(), 0.1, places=6, msg=sparse)
			for load in (1, 2):
				posed = model.parts(mod.pose(joints, {"load": load}))
				self.assertAlmostEqual(posed["body"][..., 1].max(), 0.1 + 0.1 * load, places=6, msg=sparse)
				self.assertAlmostEqual(posed["body"][..., 1].min(), -0.1, places=6, msg=sparse)
				self.assertAlmostEqual(posed["flap"][..., 1].min(), -0.02 - 0.05 * load, places=6, msg=sparse)
			# drooped, then turned a right angle about z, which takes (x, y) to
			# (-y, x): the droop now points forward of the hinge
			turned = model.parts(mod.pose(joints, {"load": 1, "flap": 1}))["flap"]
			self.assertAlmostEqual(turned[..., 0].max(), -1 + 0.02 + 0.05, places=6, msg=sparse)
			self.assertEqual(mod.pose(joints, {"load": 1}).weights, {"body": {"flex": 1.0}, "flap": {"flex": 1.0}})


class OutlineTest(unittest.TestCase):
	def test_signed_distances(self):
		theirs = np.zeros((60, 60), bool)
		theirs[10:50, 10:50] = True
		ours = np.zeros_like(theirs)
		ours[10:50, 10:56] = True   # 6 px too long on the right
		(a, da), (b, db) = mod.outlines(ours, theirs)
		self.assertAlmostEqual(da.max(), 6.0)
		self.assertGreater(da[np.argmax(np.abs(da))], 0)
		# the reference's right edge lies inside ours: ours is too big there
		self.assertAlmostEqual(db.max(), 6.0)
		found = mod.regions(a, da, lambda r, c: (c, r), 3.0, 20)
		self.assertTrue(all(c >= 52 for _, c, _ in found))

	def test_silhouette(self):
		flat = np.array([[[2, 2], [20, 2], [2, 20]]], float)
		m = mod.silhouette(flat, (30, 30))
		self.assertTrue(m[5, 5])
		self.assertFalse(m[25, 25])
		self.assertFalse(mod.silhouette(flat, (30, 30), depth=np.array([[1, 1, -1]])).any())


def scene(seed=1, n=14):
	rng = np.random.default_rng(seed)
	return rng.uniform(-3, 3, (n, 3)) * [3, 0.6, 2]


class CameraTest(unittest.TestCase):
	centre = (2000.0, 1300.0)

	def test_vector_round_trip(self):
		for v in ([0.3, -0.2, 0.1], [0, math.pi - 1e-9, 0], [1.2, 2.0, -1.5], [0, 0, 0]):
			R = cam.rotation(v)
			np.testing.assert_allclose(cam.rotation(cam.vector(R)), R, atol=1e-6)

	def test_solve_recovers_camera(self):
		points = scene()
		truth = cam.looking(np.array([4.0, 2.0, 30.0]), np.zeros(3), 9000.0)
		truth[7] = 0.02
		pixels, depth = cam.project(truth, points, self.centre)
		self.assertTrue((depth > 0).all())
		found, residual = cam.solve(points, pixels, self.centre, 4000, distortion=True)
		self.assertLess(np.abs(residual).max(), 1e-3)
		np.testing.assert_allclose(cam.eye(found), cam.eye(truth), atol=1e-3)
		self.assertAlmostEqual(found[7], 0.02, places=4)

	def test_cast_and_triangulate(self):
		a = cam.looking(np.array([20.0, 1.0, 8.0]), np.zeros(3), 6000.0)
		b = cam.looking(np.array([-6.0, 2.5, 18.0]), np.zeros(3), 7000.0)
		b[7] = -0.03
		target = np.array([1.2, 0.4, -0.7])
		pa = cam.project(a, [target], self.centre)[0][0]
		pb = cam.project(b, [target], self.centre)[0][0]
		np.testing.assert_allclose(cam.triangulate([a, b], [pa, pb], [self.centre] * 2), target, atol=1e-6)
		np.testing.assert_allclose(cam.cast(a, pa, self.centre, np.array([0, 0, 1.0]), -0.7), target, atol=1e-6)

	def test_carried_camera_sees_the_moved_point(self):
		# a camera carried by a move sees a point where the plain camera sees it moved
		c = cam.looking(np.array([20.0, 1.0, 8.0]), np.zeros(3), 6000.0)
		c[7] = 0.02
		R, t = cam.rotation([0.1, -0.4, 0.25]), np.array([0.3, -1.2, 0.5])
		points = np.array([[1.2, 0.4, -0.7], [-2.0, 0.9, 1.5], [0.0, -0.3, 0.2]])
		np.testing.assert_allclose(cam.project(cam.carried(c, (R, t)), points, self.centre)[0], cam.project(c, points @ R.T + t, self.centre)[0], atol=1e-6)
		self.assertIs(cam.carried(c, None), c)

	def test_bundle_carries_moving_points(self):
		# A flap's tip and edge, turned 0.5 rad about a hinge in one photo: carried
		# by that photo's moves, they triangulate at rest from the start, and that
		# photo's camera starts right from three cited points and the moved ones
		anchors = {f"a{i}": p for i, p in enumerate(scene(2, 5))}
		rest = {"tip": np.array([-5.0, 0.0, 2.0]), "edge": np.array([-5.0, 0.0, -1.0])}
		hinge = np.array([-4.0, 0.0, 0.0])
		R = cam.rotation([0.0, 0.0, 0.5])
		move = (R, hinge - R @ hinge)
		views = (((25, 3, 10), None), ((-8, 2, 22), None), ((18, -4, -14), move))
		photos, truths = [], []
		for position, m in views:
			c = cam.looking(np.array(position, float), np.zeros(3), 8000)
			truths.append(c)
			marks = {}
			for name, p in anchors.items():
				if m is None or name in ("a0", "a1", "a2"):
					marks[name] = tuple(cam.project(c, [p], self.centre)[0][0])
			for name, p in rest.items():
				marks[name] = tuple(cam.project(c, [p if m is None else m[0] @ p + m[1]], self.centre)[0][0])
			photo = {"centre": self.centre, "width": 4000, "sigma": 1.0, "marks": marks}
			if m is not None:
				photo["moves"] = {name: m for name in rest}
			photos.append(photo)
		points = {name: {"priors": [(np.eye(3)[i], p[i], 0.0) for i in range(3)]} for name, p in anchors.items()}
		# the moved photo's camera can start only from its three anchors and the
		# moved tip and edge, so give the tip and edge their rest positions to start
		for name, p in rest.items():
			points[name] = {"priors": [], "value": p}
		bundle = cam.Bundle(photos, points)
		self.assertEqual(bundle.initialise(log=lambda *_: None), [])
		np.testing.assert_allclose(cam.eye(photos[2]["camera"]), cam.eye(truths[2]), atol=1e-3)
		# with no starting position, the tip is triangulated at rest through the moved photo too
		for p in photos:
			p["camera"] = None
		points = {name: {"priors": [(np.eye(3)[i], p[i], 0.0) for i in range(3)]} for name, p in anchors.items()}
		points["tip"] = {"priors": []}
		points["edge"] = {"priors": [], "value": rest["edge"]}
		photos[0]["marks"].pop("edge")
		photos[1]["marks"].pop("edge")
		bundle = cam.Bundle(photos, points)
		self.assertEqual(bundle.initialise(log=lambda *_: None), [])
		np.testing.assert_allclose(bundle.known["tip"], rest["tip"], atol=1e-3)
		cameras, solved = bundle.solve()
		np.testing.assert_allclose(solved["tip"], rest["tip"], atol=1e-3)

	def test_bundle_measures_unknown_points(self):
		# Five fully cited points fix the frame; three cameras see them and
		# six points nothing cites, one pair mirrored across z. The bundle
		# recovers the uncited points from the marks alone.
		rng = np.random.default_rng(4)
		anchors = {f"a{i}": p for i, p in enumerate(scene(2, 5))}
		unknown = {f"u{i}": p for i, p in enumerate(scene(3, 4))}
		unknown["fin_right"] = np.array([-4.0, 3.0, 1.6])
		unknown["fin_left"] = np.array([-4.0, 3.0, -1.6])
		everything = {**anchors, **unknown}
		photos = []
		for position, focal in (((25, 3, 10), 8000), ((-8, 2, 22), 7000), ((18, -4, -14), 9000)):
			c = cam.looking(np.array(position, float), np.zeros(3), focal)
			names = list(everything)
			pixels = cam.project(c, np.array([everything[n] for n in names]), self.centre)[0] + rng.normal(0, 0.3, (len(names), 2))
			photos.append({"centre": self.centre, "width": 4000, "sigma": 1.0, "marks": dict(zip(names, map(tuple, pixels)))})
		points = {}
		for name, p in anchors.items():
			points[name] = {"priors": [(np.eye(3)[i], p[i], 0.0) for i in range(3)]}
		for name in unknown:
			points[name] = {"priors": []}
		bundle = cam.Bundle(photos, points, mirror=(np.diag([1, 1, -1.0]), [("fin_left", "fin_right")]))
		self.assertEqual(bundle.initialise(log=lambda *_: None), [])
		cameras, solved = bundle.solve()
		for name, p in unknown.items():
			np.testing.assert_allclose(solved[name], p, atol=5e-3, err_msg=name)
		self.assertNotIn("fin_left", bundle.point_slot)
		self.assertLess(np.sqrt(np.diag(bundle.spread["u0"])).max(), 0.02)
		misses = bundle.misses()
		self.assertLess(max(math.hypot(du, dv) for m in misses.values() for du, dv, _ in m.values()), 2.0)

	def test_bundle_spread_comes_from_the_photos_that_see_a_point(self):
		# Three photos marked to 0.3 px see the points u0-u3, the first of them
		# also "far"; a fourth sees only "far". Its marks 6 px out, the points
		# it never sees keep the spread the three give them, with or without
		# it, and "far" carries its noise (one scale for the whole bundle let
		# the noisy photo widen every point, and leaving it out narrowed them
		# all)
		rng = np.random.default_rng(21)
		anchors = {f"a{i}": p for i, p in enumerate(scene(2, 6))}
		unknown = {f"u{i}": p for i, p in enumerate(scene(3, 4))}
		far = np.array([1.5, -0.5, 2.0])
		photos = []
		for k, (position, focal) in enumerate((((25, 3, 10), 8000), ((-8, 2, 22), 7000), ((18, -4, -14), 9000))):
			c = cam.looking(np.array(position, float), np.zeros(3), focal)
			marks = {**anchors, **unknown, **({"far": far} if k == 0 else {})}
			names = list(marks)
			pixels = cam.project(c, np.array([marks[n] for n in names]), self.centre)[0] + rng.normal(0, 0.3, (len(names), 2))
			photos.append({"centre": self.centre, "width": 4000, "sigma": 1.0, "marks": dict(zip(names, map(tuple, pixels)))})

		def fourth(noise):
			c = cam.looking(np.array([5.0, 20.0, -20.0]), np.zeros(3), 8000)
			marks = {**anchors, "far": far}
			names = list(marks)
			pixels = cam.project(c, np.array([marks[n] for n in names]), self.centre)[0] + rng.normal(0, noise, (len(names), 2))
			return {"centre": self.centre, "width": 4000, "sigma": 1.0, "marks": dict(zip(names, map(tuple, pixels)))}

		def spreads(photos):
			points = {n: {"priors": [(np.eye(3)[i], p[i], 0.0) for i in range(3)]} for n, p in anchors.items()}
			points.update({n: {"priors": [], "value": p + 0.05} for n, p in {**unknown, "far": far}.items()})
			bundle = cam.Bundle([dict(ph) for ph in photos], points)
			self.assertEqual(bundle.initialise(log=lambda *_: None), [])
			bundle.solve()
			return {n: float(np.sqrt(np.diag(bundle.spread[n])).max()) for n in (*unknown, "far")}

		clean, noisy = spreads(photos + [fourth(0.3)]), spreads(photos + [fourth(6.0)])
		for name in unknown:
			self.assertLess(abs(noisy[name] / clean[name] - 1), 0.1, name)
		self.assertGreater(noisy["far"] / clean["far"], 2.0)

	def test_bundle_shrugs_off_a_wrong_mark(self):
		# one mark 300 px off (a mis-click): the robust loss keeps it from
		# dragging the points the other marks agree on
		rng = np.random.default_rng(9)
		anchors = {f"a{i}": p for i, p in enumerate(scene(2, 6))}
		unknown = {f"u{i}": p for i, p in enumerate(scene(3, 4))}
		everything = {**anchors, **unknown}
		photos = []
		for position, focal in (((25, 3, 10), 8000), ((-8, 2, 22), 7000), ((18, -4, -14), 9000)):
			c = cam.looking(np.array(position, float), np.zeros(3), focal)
			names = list(everything)
			pixels = cam.project(c, np.array([everything[n] for n in names]), self.centre)[0] + rng.normal(0, 0.3, (len(names), 2))
			photos.append({"centre": self.centre, "width": 4000, "sigma": 1.0, "marks": dict(zip(names, map(tuple, pixels)))})
		photos[1]["marks"]["u0"] = (photos[1]["marks"]["u0"][0] + 300, photos[1]["marks"]["u0"][1])
		points = {n: {"priors": [(np.eye(3)[i], p[i], 0.0) for i in range(3)]} for n, p in anchors.items()}
		points.update({n: {"priors": [], "value": p + 0.05} for n, p in unknown.items()})
		bundle = cam.Bundle(photos, points)
		bundle.initialise(log=lambda *_: None)
		_, solved = bundle.solve()
		for name in ("u1", "u2", "u3"):
			np.testing.assert_allclose(solved[name], unknown[name], atol=5e-3, err_msg=name)
		misses = bundle.misses()
		self.assertGreater(math.hypot(*misses[1]["u0"][:2]), 200)

	def test_bundle_flags_what_one_photo_cannot_fix(self):
		# A point only one photo sees is loose along that camera's ray: the
		# bundle must say so rather than report it known. Points two photos see,
		# directly or one of them through its mirror twin, stay fixed, even two
		# photos only 3 degrees apart (weakly, but fixed).
		rng = np.random.default_rng(11)
		anchors = {f"a{i}": p for i, p in enumerate(scene(6, 6))}
		truth = {"both": np.array([1.0, 0.5, 1.0]), "once": np.array([-1.0, 0.8, 0.7]),
			"wing_right": np.array([-2.0, 1.0, 1.5]), "wing_left": np.array([-2.0, 1.0, -1.5]),
			"narrow": np.array([0.5, -0.4, -1.0]), "fin_left": np.array([-3.0, 2.0, -1.2]), "fin_right": np.array([-3.0, 2.0, 1.2])}
		turn = math.radians(3)
		near = np.array([[math.cos(turn), 0, math.sin(turn)], [0, 1, 0], [-math.sin(turn), 0, math.cos(turn)]]) @ [25.0, 3, 10]
		cameras = [cam.looking(np.array(p, float), np.zeros(3), 8000.0) for p in ((25, 3, 10), (-8, 2, 22), near)]
		seen = [["both", "once", "wing_right", "narrow", "fin_left"], ["both", "wing_left"], ["narrow"]]
		photos = []
		for c, extra in zip(cameras, seen):
			marks = {**anchors, **{n: truth[n] for n in extra}}
			names = list(marks)
			pixels = cam.project(c, np.array([marks[n] for n in names]), self.centre)[0] + rng.normal(0, 0.3, (len(names), 2))
			photos.append({"centre": self.centre, "width": 4000, "sigma": 1.0, "marks": dict(zip(names, map(tuple, pixels)))})
		points = {n: {"priors": [(np.eye(3)[i], p[i], 0.0) for i in range(3)]} for n, p in anchors.items()}
		points.update({n: {"priors": [], "value": p + 0.05} for n, p in truth.items()})
		bundle = cam.Bundle(photos, points, mirror=(np.diag([1, 1, -1.0]), [("wing_left", "wing_right"), ("fin_left", "fin_right")]))
		self.assertEqual(bundle.initialise(log=lambda *_: None), [])
		_, solved = bundle.solve()
		for name in ("both", "wing_right", "wing_left"):
			self.assertEqual(len(bundle.loose[name]), 0, name)
			np.testing.assert_allclose(solved[name], truth[name], atol=5e-3, err_msg=name)
		self.assertEqual(len(bundle.loose["narrow"]), 0)
		self.assertGreater(np.sqrt(np.linalg.eigvalsh(bundle.spread["narrow"]).max()), 0.05)
		for name in ("once", "fin_left"):
			self.assertEqual(len(bundle.loose[name]), 1, name)
			ray = cam.ray(bundle.cameras[0], photos[0]["marks"][name], self.centre)
			self.assertGreater(abs(bundle.loose[name][0] @ ray), 0.999, name)
			# across the ray it is measured: the solved point lies on the true ray
			off = solved[name] - truth[name]
			self.assertLess(np.linalg.norm(off - (off @ ray) * ray), 5e-3, name)

	def test_bundle_uses_partial_priors(self):
		# a point seen in one photo, with its z cited, lands on the right spot
		anchors = {f"a{i}": p for i, p in enumerate(scene(5, 6))}
		target = np.array([0.5, 0.8, 2.2])
		c = cam.looking(np.array([20.0, 4.0, 12.0]), np.zeros(3), 8000.0)
		names = list(anchors) + ["t"]
		pixels = cam.project(c, np.array([*anchors.values(), target]), self.centre)[0]
		photos = [{"centre": self.centre, "width": 4000, "sigma": 1.0, "marks": dict(zip(names, map(tuple, pixels)))}]
		points = {n: {"priors": [(np.eye(3)[i], p[i], 0.0) for i in range(3)]} for n, p in anchors.items()}
		# started half a metre out along its sightline: only the prior can bring it back
		points["t"] = {"priors": [(np.array([0, 0, 1.0]), 2.2, 0.001)], "value": target + 0.5 * cam.ray(c, pixels[-1], self.centre)}
		bundle = cam.Bundle(photos, points)
		bundle.initialise(log=lambda *_: None)
		_, solved = bundle.solve()
		np.testing.assert_allclose(solved["t"], target, atol=1e-3)

	def test_horizon_lies_at_the_dip(self):
		# the almanac's dip: 1.76 minutes of arc at 1 m, 7.04 at 16 m
		self.assertEqual(cam.dip(0.0), 0.0)
		self.assertAlmostEqual(math.degrees(cam.dip(16.0)) * 60, 7.04, places=6)
		# pixels on the true horizon miss by nothing; the camera pitched down 2
		# mrad, their rays point 2 mrad low (less off to the side)
		c = cam.looking(np.array([0.0, 9.0, 300.0]), np.array([0.0, 9.0, 0.0]), 6000.0)
		pixels = self.sea_horizon(c)
		np.testing.assert_allclose(cam.horizon(c, pixels, self.centre, np.array([0, 1.0, 0]), 0.0), 0.0, atol=1e-6)
		down = c.copy()
		down[1:4] = cam.vector(cam.rotation([0.002, 0, 0]) @ cam.rotation(c[1:4]))
		down[4:7] = -cam.rotation(down[1:4]) @ cam.eye(c)
		expected = [-6000 * 0.002 * math.cos(a) for a in self.AZIMUTHS]
		np.testing.assert_allclose(cam.horizon(down, pixels, self.centre, np.array([0, 1.0, 0]), 0.0), expected, atol=0.05)

	AZIMUTHS = (-0.25, -0.1, 0.05, 0.2)

	def sea_horizon(self, c, sea=0.0):
		# where the sea's horizon falls in a camera looking along -z: far points
		# at the dip below level, either side of ahead
		eye = cam.eye(c)
		d = cam.dip(eye[1] - sea)
		directions = [[math.sin(a) * math.cos(d), -math.sin(d), -math.cos(a) * math.cos(d)] for a in self.AZIMUTHS]
		return cam.project(c, eye + 1e5 * np.array(directions), self.centre)[0]

	def test_horizon_fixes_a_camera_on_a_line(self):
		# Four marks on one line, as a deck edge seen from near the water: the
		# camera can swing about the line and see them the same. Started swung
		# 5 mrad, the marks leave it there; the horizon brings it back
		line = {f"edge{i}": np.array([x, 18.0, 36.0]) for i, x in enumerate((-100.0, -30.0, 40.0, 110.0))}
		truth = cam.looking(np.array([5.0, 6.0, 300.0]), np.array([0.0, 18.0, 36.0]), 6000.0)
		axis = np.array([0.0, 18.0, 36.0])
		Q = cam.rotation([0.005, 0, 0])
		swung = cam.carried(truth, (Q.T, axis - Q.T @ axis))
		names = list(line)
		marks = dict(zip(names, map(tuple, cam.project(truth, np.array([line[n] for n in names]), self.centre)[0])))
		np.testing.assert_allclose(cam.project(swung, np.array([line[n] for n in names]), self.centre)[0], list(marks.values()), atol=1e-6)
		points = {n: {"priors": [(np.eye(3)[i], p[i], 0.0) for i in range(3)]} for n, p in line.items()}

		def solved(horizon):
			photo = {"centre": self.centre, "width": 4000, "sigma": 1.0, "marks": marks, "camera": swung.copy(), "focal": (6000.0, 0.01)}
			if horizon:
				photo["horizon"] = list(map(tuple, self.sea_horizon(truth)))
			bundle = cam.Bundle([photo], points, sea=(np.array([0, 1.0, 0]), 0.0))
			bundle.initialise(log=lambda *_: None)
			cameras, _ = bundle.solve()
			return bundle, cameras[0]

		_, without = solved(False)
		self.assertGreater(np.linalg.norm(cam.eye(without) - cam.eye(truth)), 1.0)
		bundle, held = solved(True)
		np.testing.assert_allclose(cam.eye(held), cam.eye(truth), atol=0.05)
		self.assertLess(max(abs(v) for v in bundle.horizons()[0]), 0.05)

	def test_horizon_needs_a_sea(self):
		photo = {"centre": self.centre, "width": 4000, "sigma": 1.0, "marks": {}, "horizon": [(0.0, 0.0)]}
		with self.assertRaises(ValueError):
			cam.Bundle([photo], {})
		# a sea plane written facing down is turned to face up, out of the water
		normal, offset = cam.Bundle([photo], {}, sea=([0, -1.0, 0], 2.0)).sea
		np.testing.assert_allclose(normal, [0, 1, 0])
		self.assertEqual(offset, -2.0)


if __name__ == "__main__":
	unittest.main()
