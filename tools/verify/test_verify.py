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
	# A minimal glTF binary: nodes [{"name", "translation", "mesh": (vertices, faces) or None, "children": [indices]}]
	blob = bytearray()
	views, accessors, meshes, out = [], [], [], []
	for n in nodes:
		entry = {"name": n["name"], "translation": list(map(float, n.get("translation", (0, 0, 0))))}
		if n.get("children"):
			entry["children"] = n["children"]
		if n.get("mesh") is not None:
			v, f = n["mesh"]
			for data, kind, count, width in ((np.asarray(v, np.float32), 5126, len(v), "VEC3"), (np.asarray(f, np.uint32).ravel(), 5125, f.size, "SCALAR")):
				while len(blob) % 4:
					blob.append(0)
				views.append({"buffer": 0, "byteOffset": len(blob), "byteLength": data.nbytes})
				blob += data.tobytes()
				accessors.append({"bufferView": len(views) - 1, "componentType": kind, "count": int(count), "type": width})
			meshes.append({"primitives": [{"attributes": {"POSITION": len(accessors) - 2}, "indices": len(accessors) - 1, "material": 0}]})
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

	def test_rotate_carries_children(self):
		# the flap turns 90 degrees down about its hinge (z axis): its aft
		# edge and the tab beneath it drop below the hinge
		posed = mod.pose({"flap": {"motion": "rotate", "axis": [0, 0, 1], "drive": "flap", "keys": [[0, 0], [1, math.pi / 2]]}}, {"flap": 1})
		parts = self.model.parts(posed)
		self.assertAlmostEqual(parts["flap"][..., 1].min(), -0.5, places=6)
		self.assertAlmostEqual(parts["tab"][..., 1].min(), -0.6, places=6)
		self.assertAlmostEqual(parts["tab"][..., 0].min(), -1.01, places=6)
		self.assertAlmostEqual(parts["body"][..., 1].min(), -0.1)

	def test_slide_and_show(self):
		joints = {"flap": {"motion": "slide", "axis": [0, 1, 0], "drive": "d", "keys": [[0, 0], [1, 0.3]]},
			"tab": {"motion": "show", "axis": [1, 0, 0], "drive": "s", "keys": [[0, 0], [1, 1]]}}
		parts = self.model.parts(mod.pose(joints, {"d": 1}))
		self.assertAlmostEqual(parts["flap"][..., 1].max(), 0.32, places=6)
		self.assertNotIn("tab", parts)
		self.assertIn("tab", self.model.parts(mod.pose(joints, {"s": 1})))

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


if __name__ == "__main__":
	unittest.main()
