# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# Tests for plates.py: the plates' frames, rings offset round a shape and
# into its holes, points spaced round them, and the lamps carried onto a
# plate; and for letters.py's cells drawn from shapes.
#
# usage: python3 -I test_plates.py
import math, sys, unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import letters  # noqa: E402
import plates  # noqa: E402

SQUARE = [[0.5, 0.5], [1.5, 0.5], [1.5, 1.5], [0.5, 1.5]]


class PlatesTest(unittest.TestCase):
	def test_frames_read_from_outside(self):
		# the viewer's right: forward to aft from port, aft to forward from
		# starboard, starboard to port from forward, port to starboard from aft
		centre = [0, 0]
		for plane, right in (("z=-5", (-1, 0, 0)), ("z=5", (1, 0, 0)), ("x=5", (0, 0, -1)), ("x=-5", (0, 0, 1))):
			key = "x" if plane.startswith("z") else "z"
			f = plates.framed({"plane": plane, key: [1, 3], "y": [2, 5], "cell": "c"}, centre)
			self.assertEqual(f["right"], right, plane)
			self.assertEqual(f["size"], (2, 3))

	def test_rings_offset_out_and_into_holes(self):
		# either winding: out by the distance, mitred square at the corners
		for polygon in (SQUARE, SQUARE[::-1]):
			out = np.array(plates.offset_ring(polygon, 0.1))
			np.testing.assert_allclose([out[:, 0].min(), out[:, 0].max(), out[:, 1].min(), out[:, 1].max()], [0.4, 1.6, 0.4, 1.6], atol=1e-9)
			inside = np.array(plates.offset_ring(polygon, -0.1))
			np.testing.assert_allclose([inside[:, 0].min(), inside[:, 0].max()], [0.6, 1.4], atol=1e-9)
		# a concave corner moves in along its bisector, as far as each edge
		ell = [[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]]
		out = plates.offset_ring(ell, 0.1)
		self.assertTrue(np.allclose(out[3], [1.1, 1.1]))

	def test_points_spaced_evenly_round_a_ring(self):
		points = np.array(plates.spaced(SQUARE, 0.5))
		self.assertEqual(len(points), 8)   # 4 m round, as near 0.5 apart as divides it
		gaps = np.linalg.norm(np.diff(np.vstack([points, points[:1]]), axis=0), axis=1)
		np.testing.assert_allclose(gaps, 0.5, atol=1e-9)
		self.assertEqual(len(plates.spaced(SQUARE, 3.0)), 3)   # never fewer than three

	def test_lamps_onto_the_plate_standing_out(self):
		cell = {"size": [2.0, 2.0], "shapes": [{"polygon": SQUARE, "holes": [[[0.8, 0.8], [1.2, 0.8], [1.2, 1.2], [0.8, 1.2]]]}],
			"lamps": {"spacing": 0.5, "offset": 0.1, "diameter": 0.16, "depth": 0.15}}
		plate = {"plane": "z=-5", "x": [10, 12], "y": [20, 22], "cell": "c"}
		feet = plates.lamps(plate, cell, [0, 0])
		self.assertEqual(len(feet), 10 + 3)
		for (x, y, z), out in feet:
			self.assertEqual(out, (0, 0, -1))   # out of the port face
			self.assertAlmostEqual(z, -5.03)   # on the plate's front
			# the cell's x runs aft (the viewer's right from port), its y down
			u, v = 11 - x, 21 - y
			self.assertTrue(abs(abs(u) - 0.6) < 1e-9 or abs(abs(v) - 0.6) < 1e-9 or (abs(u) <= 0.1 + 1e-9 and abs(v) <= 0.1 + 1e-9), (u, v))


class LettersTest(unittest.TestCase):
	SPEC = {"background": [149, 153, 156], "outline": [40, 42, 44], "font": "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"}

	def cell(self, shapes, **more):
		return np.asarray(letters.shaped(dict({"box": [0, 0, 100, 100], "size": [2.0, 2.0], "shapes": shapes}, **more), self.SPEC, True)).astype(float)

	def at(self, image, x, y):
		return image[int(y * 50), int(x * 50)]

	def painted(self, image, x, y, colour):
		# opaque in `colour`, give or take the edges' smoothing
		np.testing.assert_allclose(self.at(image, x, y), list(colour) + [255], atol=3)

	def test_a_polygon_its_hole_and_its_shadow(self):
		# the white, clear in its hole but for the shadow the white casts into
		# it, which falls to the viewer's right and down
		hole = [[0.8, 0.8], [1.2, 0.8], [1.2, 1.2], [0.8, 1.2]]
		image = self.cell([{"polygon": SQUARE, "holes": [hole], "fill": [230, 230, 230], "offset": [0.1, 0.1], "shadow": [20, 20, 20]}])
		self.painted(image, 0.7, 0.7, [230, 230, 230])
		self.assertLess(self.at(image, 1.15, 1.15)[3], 10)                       # the hole, past the shadow
		self.painted(image, 0.84, 1.0, [20, 20, 20])                             # its left side in shadow
		self.assertLess(self.at(image, 1.17, 1.0)[3], 10)                        # its right side clear
		self.painted(image, 1.55, 1.0, [20, 20, 20])                             # the shadow past the right edge
		self.assertLess(self.at(image, 0.45, 1.0)[3], 10)                        # and none past the left
		self.assertLess(self.at(image, 0.1, 0.1)[3], 10)

	def test_discs_rings_and_text(self):
		image = self.cell([{"disc": [0.5, 0.5, 0.4], "fill": [200, 0, 0]}, {"ring": [1.5, 1.5, 0.4, 0.2], "fill": [0, 200, 0]},
			{"text": "W", "box": [1.1, 0.1, 1.9, 0.9], "fill": [0, 0, 200]}])
		self.painted(image, 0.5, 0.5, [200, 0, 0])
		self.painted(image, 1.5, 1.2, [0, 200, 0])
		self.assertLess(self.at(image, 1.5, 1.5)[3], 10)   # the ring's hole
		text = image[5:45, 55:95]
		self.assertGreater((text[..., 3] == 255).mean(), 0.2)
		self.assertTrue((text[text[..., 3] == 255][:, 2] > 150).all())

	def test_runs_of_colours_side_by_side(self):
		image = self.cell([{"runs": [["E", [255, 0, 0]], ["S", [0, 0, 255]]], "box": [0, 0.5, 2.0, 1.5], "gap": 0.0}])
		opaque = image[..., 3] == 255
		left, right = image[:, :50][opaque[:, :50]], image[:, 50:][opaque[:, 50:]]
		self.assertTrue(len(left) and len(right))
		self.assertTrue((left[:, 0] > left[:, 2]).all() and (right[:, 2] > right[:, 0]).all())

	def test_grime_toward_the_foot(self):
		shapes = [{"polygon": [[0, 0], [2, 0], [2, 2], [0, 2]], "fill": [200, 200, 200]}]
		clean, grimy = self.cell(shapes), self.cell(shapes, grime=[0.5, 1.0, 0.2])
		self.assertEqual(list(grimy[10, 50]), list(clean[10, 50]))   # the top half as painted
		self.assertLess(grimy[95, 50, 0], clean[95, 50, 0] * 0.85)   # the foot a fifth darker
		self.assertEqual(grimy[95, 50, 3], 255)


if __name__ == "__main__":
	unittest.main()
