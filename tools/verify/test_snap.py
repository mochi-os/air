# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import snap  # noqa: E402


def field(h=80, w=200):
	return np.zeros((h, w))


class SnapTest(unittest.TestCase):
	def test_a_sketch_a_few_pixels_off_moves_onto_the_line(self):
		s = field()
		s[40, :] = 0.05
		p, found = snap.snapped(np.array([[20.0, 37.0], [180.0, 43.0]]), s)
		self.assertTrue(found.all())
		self.assertLess(np.abs(p[:, 1] - 40).max(), 0.6)

	def test_a_sketch_where_no_valley_is_stands_as_drawn(self):
		p, found = snap.snapped(np.array([[20.0, 37.0], [180.0, 37.0]]), field())
		self.assertFalse(found.any())
		self.assertLess(np.abs(p[:, 1] - 37).max(), 1e-6)

	def test_a_line_beyond_reach_is_not_taken(self):
		s = field()
		s[40 + snap.REACH + 2, :] = 0.05
		p, found = snap.snapped(np.array([[20.0, 40.0], [180.0, 40.0]]), s)
		self.assertFalse(found.any())

	def test_a_gap_in_the_line_takes_its_neighbours_move(self):
		s = field()
		s[42, :] = 0.05
		s[42, 90:110] = 0.0
		p, found = snap.snapped(np.array([[20.0, 39.0], [180.0, 39.0]]), s)
		self.assertFalse(found[(p[:, 0] > 95) & (p[:, 0] < 105)].any())
		self.assertLess(np.abs(p[:, 1] - 42).max(), 0.6)

	def test_a_speck_beside_the_line_does_not_pull_it_aside(self):
		s = field()
		s[40, :] = 0.03
		s[44, 100:103] = 0.1     # a dark speck, stronger, three pixels long
		p, _ = snap.snapped(np.array([[20.0, 41.0], [180.0, 41.0]]), s)
		self.assertLess(np.abs(p[:, 1] - 40).max(), 0.6)

	def test_a_sheet_names_its_chart_and_tile(self):
		self.assertEqual(snap.where("right_01_02"), ("right", (1920, 720)))

	def test_a_line_names_a_sheet_or_the_whole_chart(self):
		self.assertEqual(snap.origin({"sheet": "top_02_01", "points": []}), ("top", (960, 1440)))
		self.assertEqual(snap.origin({"chart": "bottom", "points": []}), ("bottom", (0, 0)))


if __name__ == "__main__":
	unittest.main()
