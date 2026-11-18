# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# Tests for texswap.py: each image classed by the material slots that use it,
# an image serving two classes refused, a KTX2 file's transfer function read;
# and, where gltfpack-native and ~/bin/bwrap-build are installed, a model's
# colour image encoded sRGB and its normal map linear.
#
# usage: python3 -I test_texswap.py
import io, shutil, struct, sys, tempfile, unittest
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import texswap  # noqa: E402


def model(materials, textures, images=1):
	return {"materials": materials, "textures": textures, "images": [{"name": f"image{i}"} for i in range(images)]}


class ClassesTest(unittest.TestCase):
	def test_each_image_takes_the_class_of_its_slot(self):
		js = model([
			{"pbrMetallicRoughness": {"baseColorTexture": {"index": 0}, "metallicRoughnessTexture": {"index": 3}}, "normalTexture": {"index": 2}},
			{"emissiveTexture": {"index": 1}, "occlusionTexture": {"index": 4}}],
			[{"source": 0}, {"source": 1}, {"extensions": {"KHR_texture_basisu": {"source": 2}}}, {"source": 3}, {"source": 4}], images=6)
		self.assertEqual(texswap.classes(js), {0: "color", 1: "color", 2: "normal", 3: "attrib", 4: "attrib"})   # image 5 is used by nothing

	def test_one_image_in_two_classes_is_refused(self):
		js = model([{"pbrMetallicRoughness": {"baseColorTexture": {"index": 0}}}, {"normalTexture": {"index": 1}}], [{"source": 0}, {"source": 0}])
		with self.assertRaises(SystemExit):
			texswap.classes(js)

	def test_one_image_in_two_slots_of_one_class_is_kept(self):
		js = model([{"pbrMetallicRoughness": {"baseColorTexture": {"index": 0}}, "emissiveTexture": {"index": 0}}], [{"source": 0}])
		self.assertEqual(texswap.classes(js), {0: "color"})


def ktx2(transfer):
	# The header, index and data format descriptor of a KTX2 file, its transfer function `transfer`
	header = b"\xabKTX 20\xbb\r\n\x1a\n" + struct.pack("<9I", 0, 1, 4, 4, 0, 0, 1, 1, 0)
	index = struct.pack("<4I2Q", 80, 28, 0, 0, 0, 0)
	dfd = struct.pack("<I", 28) + struct.pack("<IHH", 0, 2, 24) + bytes([166, 1, transfer, 0]) + bytes(12)
	return header + index + dfd


class TransferTest(unittest.TestCase):
	def test_it_reads_the_descriptor_s_transfer_function(self):
		self.assertEqual(texswap.transfer(ktx2(1)), "linear")
		self.assertEqual(texswap.transfer(ktx2(2)), "srgb")


def noise(seed):
	# A PNG over MIN bytes, so texswap encodes it
	pixels = np.random.default_rng(seed).integers(0, 256, (192, 192, 3), dtype=np.uint8)
	out = io.BytesIO()
	Image.fromarray(pixels, "RGB").save(out, format="PNG")
	data = out.getvalue()
	assert len(data) >= texswap.MIN
	return data


TOOLS = Path(texswap.GLTFPACK).exists() and Path("~/bin/bwrap-build").expanduser().exists()


@unittest.skipUnless(TOOLS, "needs gltfpack-native and ~/bin/bwrap-build")
class SwapTest(unittest.TestCase):
	def test_a_colour_is_encoded_srgb_and_a_normal_map_linear(self):
		colour, normal = noise(1), noise(2)
		js = model([{"pbrMetallicRoughness": {"baseColorTexture": {"index": 0}}, "normalTexture": {"index": 1}}], [{"source": 0}, {"source": 1}], images=0)
		js["images"] = [{"name": "paint", "mimeType": "image/png", "bufferView": 0}, {"name": "paint_normal", "mimeType": "image/png", "bufferView": 1}]
		js["bufferViews"] = [{"buffer": 0, "byteOffset": 0, "byteLength": len(colour)}, {"buffer": 0, "byteOffset": len(colour) + (-len(colour) % 4), "byteLength": len(normal)}]
		binary = colour + b"\0" * (-len(colour) % 4) + normal
		js["buffers"] = [{"byteLength": len(binary)}]
		js["asset"] = {"version": "2.0"}
		# inside the project, where the sandboxed encoder can reach it (gitignored)
		work = Path(tempfile.mkdtemp(dir=HERE / "ford" / "references"))
		try:
			texswap.save_glb(work / "in.glb", js, binary)
			texswap.swap(str(work / "in.glb"), str(work / "out.glb"))
			out, data = texswap.load_glb(work / "out.glb")
			found = {}
			for image in out["images"]:
				view = out["bufferViews"][image["bufferView"]]
				self.assertEqual(image["mimeType"], "image/ktx2")
				found[image["name"]] = texswap.transfer(data[view["byteOffset"]:view["byteOffset"] + view["byteLength"]])
			self.assertEqual(found, {"paint": "srgb", "paint_normal": "linear"})
		finally:
			shutil.rmtree(work)


if __name__ == "__main__":
	unittest.main()
