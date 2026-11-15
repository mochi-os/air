# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# Tests for far.py: what the distant model draws and leaves to the full model,
# its pose, its colours and cut-outs, its check, its agreement with the
# engine's constants; and, where gltfpack and node are installed, one made,
# simplified, compressed and decoded.
#
# usage: python3 -I test_far.py
import io, json, re, shutil, sys, tempfile, unittest
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import far  # noqa: E402
import pack  # noqa: E402
from test_pack import glb, square  # noqa: E402

ENGINE = (HERE.parents[1] / "web" / "src" / "game" / "engine.ts").read_text()
PAINTS = {"grey": True, "red": False, "net": True}


def png(rgba):
	out = io.BytesIO()
	Image.fromarray(np.asarray(rgba, np.uint8), "RGBA").save(out, format="PNG")
	return out.getvalue()


# an image solid grey (sRGB 128) on its left half and holes on its right
HALF = np.zeros((8, 8, 4), np.uint8)
HALF[:, :, :3] = 128
HALF[:, :4, 3] = 255


def ship(nodes, joints=None, image=png(HALF)):
	# A model and its ship file, written to a folder: the net paint a cut-out
	gltf, binary = pack.read(glb(nodes, PAINTS, image))
	for m in gltf["materials"]:
		if m["name"] == "net":
			m["alphaMode"] = "MASK"
	folder = Path(tempfile.mkdtemp())
	(folder / "model.glb").write_bytes(pack.write(gltf, binary))
	return folder / "model.glb", {"joints": joints or {}}


def gathered(nodes, joints=None, image=png(HALF)):
	path, ship_file = ship(nodes, joints, image)
	try:
		return far.gather(path, ship_file)
	finally:
		shutil.rmtree(path.parent)


def within(parts, low, high):
	# Whether any triangle lies wholly within the box low..high
	corners = parts["positions"][parts["triangles"]]
	return bool(((corners >= np.array(low) - 1e-6) & (corners <= np.array(high) + 1e-6)).all(axis=(1, 2)).any())


class GatherTest(unittest.TestCase):
	def test_the_deck_parts_stay_with_the_full_model(self):
		parts = gathered([
			{"name": "hull", "parts": [(square(0), "red")]},
			{"name": "deck", "parts": [(square(2), "red")], "children": ["plate"]},
			{"name": "plate", "parts": [(square(4), "red")]},
			{"name": "deck_skirt", "parts": [(square(6), "red")]},
			{"name": "decks", "parts": [(square(8), "red")]}])
		self.assertTrue(within(parts, [0, 0, 0], [1, 0, 1]))
		for x in (2, 4, 6):   # the deck, a part hanging from it, the skirt
			self.assertFalse(within(parts, [x, 0, 0], [x + 1, 0, 1]), x)
		self.assertTrue(within(parts, [8, 0, 0], [9, 0, 1]))   # a name the engine does not keep

	def test_a_whip_is_drawn_lowered_as_the_engine_sets_it(self):
		# a whip standing on its hinge, lowered a quarter turn about x: from up the y axis to along z
		upright = np.array([[[0, 0, 0], [0.1, 0, 0], [0.1, 2, 0]], [[0, 0, 0], [0.1, 2, 0], [0, 2, 0]]], np.float32)
		joint = {"motion": "rotate", "axis": [1, 0, 0], "drive": "lowered for flight operations", "keys": [[0, 0], [1, np.pi / 2]]}
		parts = gathered([{"name": "antenna_port", "parts": [(upright, "red")]}], {"antenna_port": joint})
		self.assertAlmostEqual(float(np.abs(parts["positions"][:, 1]).max()), 0, places=5)
		self.assertAlmostEqual(float(np.abs(parts["positions"][:, 2]).max()), 2, places=5)
		# it faced +z standing, and faces down lowered
		np.testing.assert_allclose(parts["normals"], [[0, -1, 0]] * len(parts["normals"]), atol=1e-6)

	def test_a_paint_s_colour_is_its_factor_times_its_image_in_linear_light(self):
		solid = np.zeros((8, 8, 4), np.uint8)
		solid[:, :, :3], solid[:, :, 3] = 128, 255
		parts = gathered([{"name": "hull", "parts": [(square(0), "grey"), (square(2), "red")]}], image=png(solid))
		grey = parts["colours"][parts["positions"][:, 0] < 1.5]
		red = parts["colours"][parts["positions"][:, 0] > 1.5]
		np.testing.assert_allclose(grey, [[0.3 * 0.2158605, 0.32 * 0.2158605, 0.33 * 0.2158605]] * len(grey), atol=1e-4)
		np.testing.assert_allclose(red, [[0.3, 0.32, 0.33]] * len(red), atol=1e-6)

	def test_a_cut_out_keeps_what_is_mostly_solid_coloured_by_its_solid_part(self):
		# UVs a tenth of x and z: the square at x 0..1 reads the image's solid left, the one at 6..7 its holes
		parts = gathered([{"name": "nets", "parts": [(square(0), "net"), (square(6), "net")]}])
		self.assertTrue(within(parts, [0, 0, 0], [1, 0, 1]))
		self.assertFalse(within(parts, [6, 0, 0], [7, 0, 1]))
		kept = parts["colours"][parts["triangles"][:, 0]]
		np.testing.assert_allclose(kept, [[0.3 * 0.2158605, 0.32 * 0.2158605, 0.33 * 0.2158605]] * len(kept), atol=1e-4)

	def test_a_mirrored_part_keeps_facing_out(self):
		parts = gathered([{"name": "island", "parts": [(square(2), "red")], "scale": [-1, 1, 1]}])
		corners = parts["positions"][parts["triangles"]]
		front = np.cross(corners[:, 1] - corners[:, 0], corners[:, 2] - corners[:, 0])
		self.assertTrue((front[:, 1] > 0).all())   # the square faced +y and still does
		np.testing.assert_allclose(parts["normals"], [[0, 1, 0]] * len(parts["normals"]), atol=1e-6)


class CheckTest(unittest.TestCase):
	@classmethod
	def setUpClass(cls):
		cls.parts = gathered([{"name": "hull", "parts": [(square(0), "red"), (square(10, 0, 5), "red")]}])

	def test_its_own_model_passes(self):
		self.assertEqual(far.check(self.parts, far.model(self.parts)), [])

	def test_it_finds_images_a_second_call_and_a_short_extent(self):
		gltf, binary = pack.read(far.model(self.parts))
		gltf["images"] = [{"uri": "x.png"}]
		self.assertIn("it carries images", far.check(self.parts, pack.write(gltf, binary)))
		gltf, binary = pack.read(far.model(self.parts))
		gltf["meshes"][0]["primitives"].append(dict(gltf["meshes"][0]["primitives"][0]))
		self.assertIn("it draws in 2 calls, not 1", far.check(self.parts, pack.write(gltf, binary)))
		short = dict(self.parts, positions=self.parts["positions"] * np.array([1, 1, 0.5]))
		self.assertTrue(any(p.startswith("its extent in z") for p in far.check(self.parts, far.model(short))))

	def test_a_miss_under_a_pixel_at_its_nearest_passes(self):
		for by, found in ((0.9 * far.PIXEL, False), (1.1 * far.PIXEL, True)):
			moved = dict(self.parts, positions=self.parts["positions"] + np.array([by, 0, 0]))
			self.assertEqual(bool(far.check(self.parts, far.model(moved))), found, by)


class EngineTest(unittest.TestCase):
	def test_its_constants_are_the_engine_s(self):
		keep = re.search(r"CARRIER_KEEP=/(.+?)/[,;]", ENGINE).group(1)
		self.assertEqual(far.KEEP.pattern, keep)
		self.assertEqual(far.LIMIT, float(re.search(r"CARRIER_LIMIT=([\d.]+)", ENGINE).group(1)))
		self.assertEqual(far.MARGIN, float(re.search(r"STAGE_MARGIN=([\d.]+)", ENGINE).group(1)))
		self.assertEqual(far.LENGTH, float(re.search(r"ford:\{ url:ford_model_url, length:([\d.]+)", ENGINE).group(1)))
		self.assertRegex(ENGINE, r"\n\t\tfar:ford_far_url,\n")


TOOLS = shutil.which("node") and Path("~/bin/bwrap-build").expanduser().exists() and pack.GLTFPACK.exists()


@unittest.skipUnless(TOOLS, "needs node, ~/bin/bwrap-build and ../gltfpack-native")
class PackedTest(unittest.TestCase):
	def test_one_made_simplified_and_compressed_passes_its_check(self):
		work = HERE / "references" / "pack" / "test"
		work.mkdir(parents=True, exist_ok=True)
		parts = gathered([{"name": "hull", "parts": [(square(x, 0, z), "red") for x in range(4) for z in range(4)]}])
		(work / "far-raw.glb").write_bytes(far.model(parts))
		pack.sandboxed([str(pack.GLTFPACK), "-i", str(work / "far-raw.glb"), "-o", str(work / "far.glb"), "-cc", "-si", "0.5"])
		self.assertIn("EXT_meshopt_compression", pack.read((work / "far.glb").read_bytes())[0]["extensionsUsed"])
		self.assertEqual(far.check(parts, pack.plain(work / "far.glb")), [])


if __name__ == "__main__":
	unittest.main()
