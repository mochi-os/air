# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# Tests for raycheck.py: a ray's first surface and the walls round its start,
# cast on small models, and the reader's frame on a small glTF file.
#
# usage: python3 -I test_raycheck.py
import json, shutil, struct, sys, tempfile, unittest
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import pack  # noqa: E402
import raycheck  # noqa: E402
from test_stacks import slab, square  # noqa: E402

BOX = slab(-5, 5, -5, 5, -5, 5)


def ship(*parts):
	# A model in the deck's terms from (triangles, double-sided) parts, each wound to face its front
	tris = np.concatenate([p[0] for p in parts])
	normals = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
	sided = np.concatenate([np.full(len(p[0]), p[1]) for p in parts])
	return tris, normals, sided


class RayTest(unittest.TestCase):
	def test_a_ray_from_outside_meets_a_closed_part_front_first(self):
		status, ok = raycheck.judge(ship((BOX, False)), (-20, 0.3, 0.2), (20, 0.3, 0.2))
		self.assertTrue(ok, status)
		self.assertTrue(status.startswith("HIT 2 (first at 15.0m)"), status)

	def test_a_face_met_from_behind_is_culled(self):
		# a floor facing up, met by a ray from under it
		status, ok = raycheck.judge(ship((square(-5, 5, -5, 5, 0), False)), (0.3, 0.2, -10), (0.3, 0.2, 10))
		self.assertFalse(ok)
		self.assertIn("CULLED at 10.0m", status)

	def test_a_double_sided_sheet_is_drawn_from_either_side(self):
		sheet = ship((square(-5, 5, -5, 5, 0), True))
		for o, e in (((0.3, 0.2, -10), (0.3, 0.2, 10)), ((0.3, 0.2, 10), (0.3, 0.2, -10))):
			status, ok = raycheck.judge(sheet, o, e)
			self.assertTrue(ok, status)

	def test_faces_back_to_back_count_as_one_within_2_cm(self):
		# a floor facing up with one facing down just over it, met from below: the up-facing one first
		for gap, drawn in ((0.01, True), (0.05, False)):
			pair = ship((square(-5, 5, -5, 5, 0), False), (square(-5, 5, -5, 5, gap, -1), False))
			status, ok = raycheck.judge(pair, (0.3, 0.2, -10), (0.3, 0.2, 10))
			self.assertEqual(ok, drawn, (gap, status))

	def test_a_start_inside_a_closed_part_fails(self):
		status, ok = raycheck.judge(ship((BOX, False)), (0, 0.1, 0.05), (20, 0.3, 0.2))
		self.assertFalse(ok)
		self.assertIn("its start sees walls from behind in 6 of 6 directions", status)

	def test_a_start_inside_a_part_fails_though_its_ray_meets_a_face_front_first(self):
		# a box inside the box, ahead of the start: the ray meets its front, the walls round the start their backs
		status, ok = raycheck.judge(ship((BOX, False), (slab(1, 2, -1, 1, -1, 1), False)), (0, 0.1, 0.05), (20, 0.3, 0.2))
		self.assertFalse(ok)
		self.assertTrue(status.startswith("*** HIT 3 (first at 1.0m)"), status)
		self.assertIn("in 5 of 6 directions", status)

	def test_a_start_outside_sees_every_wall_from_the_front(self):
		model = ship((BOX, False), (square(-5, 5, -5, 5, 20), True))
		for start in ((-20, 0.3, 0.2), (0.3, 0.2, 12), (0.3, -30, 0.2)):
			self.assertEqual(raycheck.behind(model, start), 0, start)


def glb(path):
	# One triangle facing down at the deck's height, drawn by a plain node, and by a mirrored node
	# moved under a parent that is moved to starboard
	y = raycheck.DECKY
	binary = np.array([[0, y, 0], [1, y, 0], [0, y, 1]], np.float32).tobytes() + np.array([0, 1, 2, 0], np.uint16).tobytes()
	gltf = {
		"asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0, 2]}],
		"nodes": [{"mesh": 0}, {"mesh": 1, "translation": [5, 0, 0], "scale": [-1, 1, 1]}, {"translation": [0, 0, 2], "children": [1]}],
		"meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "indices": 1, "material": m}]} for m in (0, 1)],
		"materials": [{"doubleSided": True}, {}],
		"accessors": [
			{"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3"},
			{"bufferView": 1, "componentType": 5123, "count": 3, "type": "SCALAR"},
		],
		"bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": 36}, {"buffer": 0, "byteOffset": 36, "byteLength": 6}],
		"buffers": [{"byteLength": len(binary)}],
	}
	text = json.dumps(gltf).encode()
	text += b" " * (-len(text) % 4)
	head = struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(text) + 8 + len(binary))
	path.write_bytes(head + struct.pack("<I", len(text)) + b"JSON" + text + struct.pack("<I", len(binary)) + b"BIN\0" + binary)


class LoadTest(unittest.TestCase):
	def test_load_reads_a_model_into_the_deck_frame(self):
		with tempfile.TemporaryDirectory() as folder:
			path = Path(folder) / "model.glb"
			glb(path)
			tris, normals, sided = raycheck.load(str(path))
		# forward, to starboard, above the deck
		np.testing.assert_allclose(tris[0], [[0, 0, 0], [1, 0, 0], [0, 1, 0]], atol=1e-6)
		np.testing.assert_allclose(tris[1], [[5, 2, 0], [4, 2, 0], [5, 3, 0]], atol=1e-6)
		# both face down, the mirrored node's too, as the renderer draws it
		for n in normals:
			np.testing.assert_allclose(n / np.linalg.norm(n), [0, 0, -1], atol=1e-6)
		self.assertEqual(sided.tolist(), [True, False])

	@unittest.skipUnless(shutil.which("node") and Path("~/bin/bwrap-build").expanduser().exists() and pack.GLTFPACK.exists(),
		"needs node, ~/bin/bwrap-build and ../gltfpack-native")
	def test_load_reads_the_game_s_packed_model_as_built(self):
		# the game's model is meshopt-compressed (pack.py): the same triangles, faces and sides
		work = HERE / "references" / "pack" / "test"
		work.mkdir(parents=True, exist_ok=True)
		glb(work / "model.glb")
		pack.sandboxed([str(pack.GLTFPACK), "-i", str(work / "model.glb"), "-o", str(work / "packed.glb"), "-cc", "-noq", "-kn", "-km", "-ke"])
		self.assertIn("EXT_meshopt_compression", pack.read((work / "packed.glb").read_bytes())[0]["extensionsUsed"])

		def rows(ship):
			out = []
			for t, n, d in zip(*ship):
				first = min(range(3), key=lambda k: tuple(np.round(t[k], 5)))
				out.append(tuple(np.round(np.roll(t, -first, axis=0), 5).ravel()) + tuple(np.round(n / np.linalg.norm(n), 5)) + (bool(d),))
			return sorted(out)
		self.assertEqual(rows(raycheck.load(str(work / "packed.glb"))), rows(raycheck.load(str(work / "model.glb"))))


if __name__ == "__main__":
	unittest.main()
