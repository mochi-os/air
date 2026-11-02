# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# Tests for paint.py: where each marking lands in the image, which must match
# build.py's mapping (port at the top, the bow to the right).
#
# usage: python3 -I test_paint.py
import sys, unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import paint  # noqa: E402

GREY, RED, WHITE = [60, 60, 60], [200, 0, 0], [240, 240, 240]
# 20 x 10 m at 10 cm a texel
LAYOUT = {"deck": {"texture": {"x": [-10, 10], "z": [-5, 5], "pixels": [200, 100]}}, "paint": {"deck": GREY}}


def at(image, x, z):
	# the texel under a deck point
	return list(image.getpixel((int((x + 10) / 20 * 200), int((z + 5) / 10 * 100))))


class Paint(unittest.TestCase):
	def render(self, *markings):
		return paint.render({**LAYOUT, "markings": list(markings)})

	def test_size_and_base(self):
		image = self.render()
		self.assertEqual(image.size, (200, 100))
		self.assertEqual(at(image, 0, 0), GREY)

	def test_port_is_the_top_and_the_bow_the_right(self):
		image = self.render({"kind": "area", "outline": [[6, -4], [8, -4], [8, -2], [6, -2]], "colour": RED})
		self.assertEqual(at(image, 7, -3), RED)       # forward, to port
		self.assertEqual(at(image, 7, 3), GREY)       # its mirror to starboard
		self.assertEqual(at(image, -7, -3), GREY)     # its mirror aft
		x, y = 170, 10   # col (7 + 10) / 20, row (-3 + 5) / 10: right and near the top
		self.assertEqual(list(image.getpixel((x, y))), RED)

	def test_line_width(self):
		image = self.render({"kind": "line", "points": [[-8, 0], [8, 0]], "width": 1.0, "colour": WHITE})
		self.assertEqual(at(image, 0, 0.4), WHITE)
		self.assertEqual(at(image, 0, -0.4), WHITE)
		self.assertEqual(at(image, 0, 0.7), GREY)
		self.assertEqual(at(image, 9, 0), GREY)       # past its end

	def test_dashes(self):
		image = self.render({"kind": "line", "points": [[-8, 0], [8, 0]], "width": 1.0, "colour": WHITE, "dash": [2, 2]})
		self.assertEqual(at(image, -7, 0), WHITE)     # the first dash, -8 to -6
		self.assertEqual(at(image, -5, 0), GREY)      # the first gap
		self.assertEqual(at(image, -3, 0), WHITE)
		self.assertEqual(at(image, 7, 0), GREY)       # 6 to 8 is a gap

	def test_dashes_turn_corners(self):
		# a 3 m dash starting 1 m before a corner carries 2 m round it
		pieces = paint.dashes([[0, 0], [1, 0], [1, 5]], 3, 1)
		self.assertEqual(pieces[0], [[0, 0], [1, 0], [1.0, 2.0]])
		self.assertEqual(pieces[1], [[1.0, 3.0], [1, 5]])

	def test_unknown_kind(self):
		with self.assertRaises(ValueError):
			self.render({"kind": "circle", "colour": RED})


if __name__ == "__main__":
	unittest.main()
