# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# Builds the AIM-120C with Blender and probes it: its hooks, by points the
# layout's shapes make solid and points they leave empty (the slot of a
# C-hanger, the holes of the aft shoe's flange, the overhang of a T-hanger's
# flange), each tested against the built mesh by its winding number; and its
# paint, by the atlas the body's own UVs show at points the markings cover.
#
# usage: systemd-run --user --scope --slice=probe.slice -p MemoryMax=6G -p MemorySwapMax=0 python3 -I test_build.py
import io, json, math, struct, subprocess, sys, tempfile, unittest
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "verify"))
import model as verify  # noqa: E402

INCH = 0.0254


def winding(triangles, point):
	# How many times the closed surfaces wind round the point: 1 inside one
	# solid, 0 outside them all (the solid angle of every triangle, summed)
	a, b, c = (triangles[:, k] - point for k in range(3))
	la, lb, lc = (np.linalg.norm(v, axis=1) for v in (a, b, c))
	top = np.einsum("ij,ij->i", a, np.cross(b, c))
	bottom = la * lb * lc + np.einsum("ij,ij->i", a, b) * lc + np.einsum("ij,ij->i", b, c) * la + np.einsum("ij,ij->i", c, a) * lb
	return float(np.sum(2 * np.arctan2(top, bottom)) / (4 * math.pi))


BUILT = {}


def setUpModule():
	# one build for every test here: the AIM-120C, painted
	BUILT["dir"] = tempfile.TemporaryDirectory()
	glb, points = Path(BUILT["dir"].name) / "m.glb", Path(BUILT["dir"].name) / "m.json"
	run = subprocess.run(["blender", "-b", "--factory-startup", "--python-exit-code", "1", "-P", str(HERE / "build.py"), "--", "aim120c", str(glb), str(points)],
		capture_output=True, text=True)
	if run.returncode:
		raise RuntimeError(run.stdout[-3000:] + run.stderr[-3000:])
	BUILT["glb"], BUILT["document"] = glb, json.loads(points.read_text())


def tearDownModule():
	BUILT["dir"].cleanup()


class HooksTest(unittest.TestCase):
	@classmethod
	def setUpClass(cls):
		document = BUILT["document"]
		cls.parts = verify.Model(str(BUILT["glb"])).parts(verify.pose(document["joints"], {}))
		cls.centre = document["points"]["nose"][0] / INCH   # the gravity's station: the nose's x is its distance aft of the nose
		layout = json.loads((HERE / "facts.json").read_text())["layout"]["aim120c"]
		cls.specs = {s["name"]: s for s in layout["fittings"]["value"]}

	def solid(self, station, across, height):
		# whether the point (inches aft of the nose, to the right, above the axis) lies inside a fitting
		point = np.array([(self.centre - station) * INCH, height * INCH, across * INCH])
		return winding(self.parts["fittings"], point) > 0.5

	def assertSolid(self, *point):
		self.assertTrue(self.solid(*point), f"{point} should be solid")

	def assertEmpty(self, *point):
		self.assertFalse(self.solid(*point), f"{point} should be empty")

	def test_the_winding_number_tells_inside_from_outside(self):
		cube = np.array([[[0, 0, 0], [1, 1, 0], [1, 0, 0]], [[0, 0, 0], [0, 1, 0], [1, 1, 0]], [[0, 0, 1], [1, 0, 1], [1, 1, 1]], [[0, 0, 1], [1, 1, 1], [0, 1, 1]],
			[[0, 0, 0], [1, 0, 0], [1, 0, 1]], [[0, 0, 0], [1, 0, 1], [0, 0, 1]], [[0, 1, 0], [1, 1, 1], [1, 1, 0]], [[0, 1, 0], [0, 1, 1], [1, 1, 1]],
			[[0, 0, 0], [0, 0, 1], [0, 1, 1]], [[0, 0, 0], [0, 1, 1], [0, 1, 0]], [[1, 0, 0], [1, 1, 0], [1, 1, 1]], [[1, 0, 0], [1, 1, 1], [1, 0, 1]]], float)
		self.assertAlmostEqual(abs(winding(cube, np.array([0.5, 0.3, 0.6]))), 1.0, 6)
		self.assertAlmostEqual(winding(cube, np.array([1.5, 0.3, 0.6])), 0.0, 6)

	def test_the_forward_hook_is_a_t(self):
		# a stem narrower than the flange over it, so the launcher's rail can grip the flange
		stem = self.specs["hook_forward_stem"]["width"] / 2
		flange = max(a for a, h in self.specs["hook_forward_flange"]["section"])
		self.assertLess(stem + 0.1, flange)
		self.assertSolid(68.3, stem - 0.1, 3.62)
		self.assertEmpty(68.3, (stem + flange) / 2, 3.62)
		self.assertSolid(68.3, (stem + flange) / 2, 3.79)

	def test_the_forward_flange_carries_rails_either_side_of_the_buttons_pad(self):
		for side in (1, -1):
			self.assertSolid(68.0, side * 0.86, 3.91)   # a rail
			self.assertEmpty(68.0, side * 0.51, 3.91)   # the notch inside it
			self.assertSolid(68.5, side * 0.3, 3.91)    # the pad
		self.assertEmpty(67.8, 0.0, 3.91)               # the recess forward of the pad
		self.assertSolid(68.65, 0.0, 4.2)                # the button's post
		self.assertSolid(68.67, 0.35, 4.47)              # and its cap

	def test_the_centre_hooks_are_c_channels_facing_inward(self):
		for side in (1, -1):
			self.assertSolid(93.8, side * 2.2, 4.0)    # the web
			self.assertSolid(93.8, side * 1.8, 4.37)   # its lip
			self.assertEmpty(93.8, side * 1.8, 4.0)    # the slot under the lip
			self.assertSolid(93.8, side * 1.8, 3.65)   # the lower jaw
			self.assertEmpty(94.58, side * 2.2, 4.53)  # its top aft corner, rounded
		self.assertEmpty(93.8, 0.0, 4.0)

	def test_the_aft_flange_is_pierced_by_its_holes(self):
		plate = self.specs["hook_aft_flange"]["plate"]
		self.assertGreaterEqual(len(plate["holes"]), 5)
		for station, across, radius in plate["holes"]:
			self.assertEmpty(station, across, 3.99)
			self.assertSolid(station, across + math.copysign(radius + 0.05, across or 1), 3.99)   # beside it
		self.assertSolid(127.0, 0.0, 3.99)

	def test_the_aft_hook_is_a_t_with_rounded_corners(self):
		self.assertEmpty(127.0, 0.95, 3.7)     # beside the stem, under the flange
		self.assertSolid(127.0, 0.95, 3.99)    # the flange
		self.assertEmpty(125.70, 1.01, 3.99)   # its forward corner, rounded

	def test_the_hooks_edges_are_bevelled(self):
		self.assertEmpty(127.0, 1.03, 4.08)    # the flange's top edge
		self.assertEmpty(68.3, 1.065, 3.96)    # the forward flange's rail's top edge



def glb_parts(path):
	# the glTF's JSON, its binary chunk and a reader for an accessor
	b = Path(path).read_bytes()
	n = struct.unpack("<I", b[12:16])[0]
	j = json.loads(b[20 : 20 + n])
	base = 20 + n + 8

	def accessor(i):
		a = j["accessors"][i]
		v = j["bufferViews"][a["bufferView"]]
		kind, width = {5126: ("f", 4), 5123: ("H", 2), 5125: ("I", 4)}[a["componentType"]]
		k = {"SCALAR": 1, "VEC2": 2, "VEC3": 3}[a["type"]]
		start = base + v.get("byteOffset", 0) + a.get("byteOffset", 0)
		return np.frombuffer(b[start : start + a["count"] * k * width], dtype="<" + kind).reshape(a["count"], k)

	return j, b, base, accessor


class PaintTest(unittest.TestCase):
	@classmethod
	def setUpClass(cls):
		j, b, base, accessor = glb_parts(BUILT["glb"])
		cls.json = j
		view = j["bufferViews"][j["images"][0]["bufferView"]]
		start = base + view.get("byteOffset", 0)
		cls.atlas = np.asarray(Image.open(io.BytesIO(b[start : start + view["byteLength"]])).convert("RGB"), float) / 255
		body = next(n for n in j["nodes"] if n.get("name") == "body")
		triangles, uvs = [], []
		for p in j["meshes"][body["mesh"]]["primitives"]:
			index = accessor(p["indices"]).ravel()
			triangles.append(accessor(p["attributes"]["POSITION"])[index].reshape(-1, 3, 3))
			uvs.append(accessor(p["attributes"]["TEXCOORD_0"])[index].reshape(-1, 3, 2))
		cls.triangles, cls.uvs = np.concatenate(triangles), np.concatenate(uvs)
		cls.centre = BUILT["document"]["points"]["nose"][0] / INCH
		layout = json.loads((HERE / "facts.json").read_text())["layout"]
		cls.layout = {k: v["value"] if isinstance(v, dict) and "value" in v else v for k, v in layout["aim120c"].items()}
		cls.paint = np.array(cls.layout["paint"]) / 255

	def texel(self, station, roll):
		# the atlas's colour where the body's skin is at (station, roll): the
		# point on the cylinder put on the facet under it, its UV by its
		# barycentric place there (glTF: x forward, y up, z right)
		r = 3.5
		p = np.array([(self.centre - station) * INCH, r * math.cos(math.radians(roll)) * INCH, r * math.sin(math.radians(roll)) * INCH])
		a, b, c = self.triangles[:, 0], self.triangles[:, 1], self.triangles[:, 2]
		n = np.cross(b - a, c - a)
		n /= np.linalg.norm(n, axis=1, keepdims=True)
		q = p - np.einsum("ij,ij->i", p - a, n)[:, None] * n
		v0, v1, v2 = b - a, c - a, q - a
		d00, d01, d11 = np.einsum("ij,ij->i", v0, v0), np.einsum("ij,ij->i", v0, v1), np.einsum("ij,ij->i", v1, v1)
		d20, d21 = np.einsum("ij,ij->i", v2, v0), np.einsum("ij,ij->i", v2, v1)
		den = d00 * d11 - d01 * d01
		v, w = (d11 * d20 - d01 * d21) / den, (d00 * d21 - d01 * d20) / den
		u = 1 - v - w
		ok = (u >= -1e-6) & (v >= -1e-6) & (w >= -1e-6) & (n @ p > 0) & (np.linalg.norm(q - p, axis=1) < 0.01)
		i = int(np.nonzero(ok)[0][0])
		uv = u[i] * self.uvs[i, 0] + v[i] * self.uvs[i, 1] + w[i] * self.uvs[i, 2]
		size = self.atlas.shape[0]
		return self.atlas[min(size - 1, int(uv[1] * size)), min(size - 1, int(uv[0] * size))]

	def dark(self, station, roll):
		return float(np.dot(self.texel(station, roll), [0.2126, 0.7152, 0.0722])) < 0.5 * float(np.dot(self.paint, [0.2126, 0.7152, 0.0722]))

	def share(self, points):
		return np.mean([self.dark(s, r) for s, r in points])

	def test_every_material_but_the_glass_wears_the_one_atlas(self):
		self.assertEqual(len(self.json["images"]), 1)
		self.assertEqual(self.json["images"][0]["mimeType"], "image/jpeg")
		self.assertLess(Path(BUILT["glb"]).stat().st_size, 1_200_000)   # the download's budget (claude/plans/air-fa18c.md #7)
		self.assertEqual(self.atlas.shape[:2], (self.layout["atlas"], self.layout["atlas"]))
		materials = [m for m in self.json["materials"] if m["name"] != "glass"]
		self.assertTrue(all("baseColorTexture" in m.get("pbrMetallicRoughness", {}) for m in materials))
		sources = {self.json["textures"][m["pbrMetallicRoughness"]["baseColorTexture"]["index"]]["source"] for m in materials}
		self.assertEqual(sources, {0})

	def test_the_designation_is_lettered_on_both_sides_and_not_on_top(self):
		box = next(s for s in self.layout["markings"]["stencils"] if s.get("text") == ["AIM-120C-7"])
		(s0, s1), (a0, a1) = box["station"], box["arc"]
		grid = [(s, math.degrees(a / 3.5)) for s in np.linspace(s0 + 0.1, s1 - 0.1, 40) for a in np.linspace(a0 + 0.1, a1 - 0.1, 6)]
		self.assertGreater(self.share([(s, 270 + d) for s, d in grid]), 0.15)   # the left side
		self.assertGreater(self.share([(s, 90 - d) for s, d in grid]), 0.15)    # the right
		self.assertLess(self.share([(s, d - 30) for s, d in grid]), 0.02)       # the top, clear of it

	def test_a_joint_rings_the_body(self):
		# a line about a texel wide: darker all round than the paint beside it
		lum = lambda station: np.array([np.dot(self.texel(station, roll), [0.2126, 0.7152, 0.0722]) for roll in np.arange(1, 360, 7)])
		ring, beside = lum(134.0), lum(132.5)
		self.assertLess(ring.mean(), 0.85 * beside.mean())
		self.assertGreater(np.mean(ring < 0.95 * beside), 0.8)

	def test_the_plain_paint_is_the_paint_in_good_condition(self):
		# along the top, clear of the markings and the lugs, the atlas is the
		# measured paint under its shading and light wear
		top = np.array([self.texel(s, 0.0) for s in np.linspace(40, 55, 30)])
		np.testing.assert_allclose(top.mean(0), self.paint, atol=0.12)
		self.assertLess(np.abs(top - top.mean(0)).max(), 0.08)


if __name__ == "__main__":
	unittest.main()
