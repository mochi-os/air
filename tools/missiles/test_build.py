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
import io, json, math, os, re, shutil, struct, subprocess, sys, tempfile, unittest
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


def build(name, *options):
	glb, points = Path(BUILT["dir"].name) / f"{name}.glb", Path(BUILT["dir"].name) / f"{name}.json"
	run = subprocess.run(["blender", "-b", "--factory-startup", "--python-exit-code", "1", "-P", str(HERE / "build.py"), "--", "aim120c", str(glb), str(points), *options],
		capture_output=True, text=True)
	if run.returncode:
		raise RuntimeError(run.stdout[-3000:] + run.stderr[-3000:])
	return glb, points


def setUpModule():
	# two builds for every test here: the AIM-120C as it ships, painted, and
	# its shape alone with every part a closed solid (a draft that keeps the
	# faces no view can see, where the parts meet), for the probes
	BUILT["dir"] = tempfile.TemporaryDirectory()
	BUILT["glb"], BUILT["points"] = build("m")
	BUILT["document"] = json.loads(BUILT["points"].read_text())
	BUILT["whole"], _ = build("whole", "--draft", "--whole")


def tearDownModule():
	BUILT["dir"].cleanup()


class HooksTest(unittest.TestCase):
	@classmethod
	def setUpClass(cls):
		document = BUILT["document"]
		cls.parts = verify.Model(str(BUILT["whole"])).parts(verify.pose(document["joints"], {}))
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



def hidden(glb):
	# the triangles no view can see that a model keeps (../hidden.py), per
	# part: [triangles, square inches]
	run = subprocess.run(["blender", "-b", "--factory-startup", "--python-exit-code", "1", "-P", str(HERE.parent / "hidden.py"), "--", str(glb), str(BUILT["points"])],
		capture_output=True, text=True)
	line = next((l for l in run.stdout.splitlines() if l.startswith("hidden ")), None)
	if run.returncode or line is None:
		raise RuntimeError(run.stdout[-3000:] + run.stderr[-3000:])
	return json.loads(line[len("hidden ") :])


class HiddenTest(unittest.TestCase):
	def test_no_face_lies_inside_or_against_another_part(self):
		# the hooks' feet sunk in the body, the wings' roots against it, the
		# skin under the harness cover: none is built, so none takes triangles
		# or atlas texels
		self.assertEqual(hidden(BUILT["glb"]), {})

	def test_the_parts_whole_hide_what_the_build_leaves_out(self):
		# the same model with every face kept shows what the check finds, so
		# that an empty finding above is the build's doing: the fittings' feet,
		# the wings' roots, and the body's skin under the harness cover, which
		# the body's cuts at the cover's sides and ends leave as whole faces
		found = hidden(BUILT["whole"])
		for part in ("fittings", "body", "wing_upper_left"):
			self.assertIn(part, found)
		self.assertGreater(found["body"][1], 100)   # square inches: the harness cover's 1.3 by 87 in, inside its cuts


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
		# a line about a texel wide: darker all round than the paint beside it,
		# but under the harness cover, where no skin is built
		layout = json.loads((HERE / "facts.json").read_text())["layout"]["aim120c"]
		harness = next(s for s in layout["fittings"]["value"] if s["name"] == "harness")
		under = math.degrees(math.asin(harness["width"] / 2 / (json.loads((HERE / "facts.json").read_text())["aim120c"]["diameter"]["value"] / 2))) + 1
		rolls = [r for r in np.arange(1, 360, 7) if abs((r - harness["roll"] + 180) % 360 - 180) > under]
		lum = lambda station: np.array([np.dot(self.texel(station, roll), [0.2126, 0.7152, 0.0722]) for roll in rolls])
		ring, beside = lum(134.0), lum(132.5)
		self.assertLess(ring.mean(), 0.85 * beside.mean())
		self.assertGreater(np.mean(ring < 0.95 * beside), 0.8)

	def test_the_plain_paint_is_the_paint_in_good_condition(self):
		# along the top, clear of the markings and the lugs, the atlas is the
		# measured paint under its shading and light wear
		top = np.array([self.texel(s, 0.0) for s in np.linspace(40, 55, 30)])
		np.testing.assert_allclose(top.mean(0), self.paint, atol=0.12)
		self.assertLess(np.abs(top - top.mean(0)).max(), 0.08)


def changed(change):
	# A copy of the facts, changed in place by `change`
	facts = json.loads((HERE / "facts.json").read_text())
	change(facts)
	return facts


class CacheTest(unittest.TestCase):
	# The atlas kept between builds (build.py --cache), on the AIM-9M, the
	# quicker build: the cache changes nothing about the model; a build whose
	# parts, unwrap and colours are unchanged takes its UVs and bakes from the
	# cache and makes the same model, byte for byte; a change to the paint
	# alone bakes nothing again; a change to anything the bakes come from (the
	# shape, a colour they lay, the unwrap's seams, length and pieces, the
	# atlas's size, the parts' indices, the code) bakes again. Each case
	# builds against its own copy of the cache the first build left, so none
	# hangs on what another kept or let go
	@classmethod
	def setUpClass(cls):
		cls.plain = cls.build("plain", cache=False)
		cls.first = cls.build("first", cache=False, into=Path(BUILT["dir"].name) / "cache")

	@classmethod
	def build(cls, name, facts=None, cache=True, edit=None, into=None):
		# cache: whether to build against a copy of the first build's cache;
		# into: a cache folder of its own. edit: (old, new), built from a copy
		# of build.py beside it with the line changed, so it finds the facts and
		# the shared modules as it does
		folder = Path(BUILT["dir"].name)
		glb, points = folder / f"{name}.glb", folder / f"{name}.json"
		if cache:
			into = folder / f"{name}-cache"
			shutil.copytree(folder / "cache", into)
		options = ["--cache", str(into)] if into else []
		if facts is not None:
			(folder / f"{name}-facts.json").write_text(json.dumps(facts))
			options += ["--facts", str(folder / f"{name}-facts.json")]
		script = HERE / "build.py"
		if edit:
			source = script.read_text()
			if source.count(edit[0]) != 1:
				raise RuntimeError(f"{name}: the line to change is not in build.py once")
			script = HERE / f".cache-{os.getpid()}-{name}.py"
			script.write_text(source.replace(*edit))
		try:
			run = subprocess.run(["blender", "-b", "--factory-startup", "--python-use-system-env", "--python-exit-code", "1", "-P", str(script), "--",
				"aim9m", str(glb), str(points), *options], capture_output=True, text=True)
		finally:
			if edit:
				script.unlink()
		if run.returncode or "Traceback" in run.stdout + run.stderr:
			raise RuntimeError(run.stdout[-3000:] + run.stderr[-3000:])
		return glb.read_bytes(), re.findall(r"^bakes aim9m: (baked|from the cache)", run.stdout, re.M)

	def bakes(self, name, change=None, edit=None):
		_, said = self.build(name, changed(change) if change else None, edit=edit)
		self.assertEqual(said, ["baked"])

	def test_the_cache_changes_nothing(self):
		self.assertEqual(self.plain[1], ["baked"])
		self.assertEqual(self.first[1], ["baked"])
		self.assertEqual(self.first[0], self.plain[0])

	def test_an_unchanged_build_takes_the_bakes_from_the_cache(self):
		again, said = self.build("again")
		self.assertEqual(said, ["from the cache"])
		self.assertEqual(again, self.first[0])

	def test_the_paint_alone_bakes_nothing_again(self):
		# a window of the markings wider
		model, said = self.build("painted", changed(lambda f: f["layout"]["aim9m"]["markings"]["value"]["windows"][0].update(radius=0.8)))
		self.assertEqual(said, ["from the cache"])
		self.assertNotEqual(model, self.first[0])

	def test_the_shape_bakes_again(self):
		# the wings' tip chord moved aft an inch
		self.bakes("shaped", lambda f: f["layout"]["aim9m"]["wings"]["value"]["outline"][1].__setitem__(0, 96.7))

	def test_a_colour_the_bakes_lay_bakes_again(self):
		# the body's grey lighter: the albedo bake lays it
		self.bakes("coloured", lambda f: f["layout"]["aim9m"]["paint"].update(value=[110, 114, 127]))

	def test_the_unwraps_seams_bake_again(self):
		self.bakes("seamed", lambda f: f["layout"]["aim9m"]["markings"]["value"]["seams"].__setitem__(0, 28.0))

	def test_the_unwraps_length_bakes_again(self):
		# the length the body's last piece ends at, which the profile does not reach
		self.bakes("lengthened", lambda f: f["aim9m"]["length"].update(value=f["aim9m"]["length"]["value"] + 0.5))

	def test_the_atlas_size_bakes_again(self):
		self.bakes("sized", lambda f: f["layout"]["aim9m"]["atlas"].update(value=512))

	def test_the_unwraps_pieces_bake_again(self):
		self.bakes("pieced", edit=("PIECE = 36.0\n", "PIECE = 30.0\n"))

	def test_the_parts_indices_bake_again(self):
		# the fittings baked as the fins' part
		self.bakes("indexed", edit=('else painting.PARTS["fittings"] if o.name == "fittings"', 'else painting.PARTS["fin"] if o.name == "fittings"'))

	def test_the_code_bakes_again(self):
		self.bakes("unwrapped", edit=('	bpy.ops.uv.pack_islands(rotate=True, rotate_method="AXIS_ALIGNED", margin=0.006)\n',
			'	bpy.ops.uv.pack_islands(rotate=True, rotate_method="AXIS_ALIGNED", margin=0.006)   # changed\n'))


if __name__ == "__main__":
	unittest.main()
