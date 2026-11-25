# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import curate  # noqa: E402


def side(h=80, w=200, scale=8.0, bulge=None):
	# a right side chart's rest skin: FS along x, WL down y, BL out of the
	# chart; with `bulge`, the skin from that row down turns to face down
	grid = {"origin": [100.0, 120.0, 0.0], "right": [1 / scale, 0, 0], "down": [0, -1 / scale, 0], "size": [w, h]}
	ys, xs = np.mgrid[0:h, 0:w].astype(float)
	place = np.stack([100 + xs / scale, 120 - ys / scale, np.full(xs.shape, 20.0)], -1)
	if bulge is not None:
		under = ys >= bulge
		# below the row the skin runs inboard: facing down
		place[..., 1] = np.where(under, 120 - bulge / scale - (ys - bulge) / scale * 0.2, place[..., 1])
		place[..., 2] = np.where(under, 20 - (ys - bulge) / scale, 20.0)
	return grid, place


def found(lines, rows=()):
	return {"lines": [dict({"id": k, "strength": 0.06, "photos": 3}, **l) for k, l in enumerate(lines)], "rows": list(rows)}


class FacingTest(unittest.TestCase):
	def test_a_side_chart_keeps_skin_facing_across_and_the_top_skin_facing_up(self):
		across, up = np.array([0.0, 0.2, 0.98]), np.array([0.0, 0.98, 0.2])
		self.assertTrue(curate.mine("right", across))
		self.assertFalse(curate.mine("right", up))
		self.assertTrue(curate.mine("top", up))
		self.assertFalse(curate.mine("bottom", across))

	def test_the_normal_of_a_flat_side_is_across(self):
		_, place = side()
		n = curate.normals(place)
		self.assertGreater(abs(n[40, 100, 2]), 0.99)


class GatherTest(unittest.TestCase):
	def test_a_long_deep_line_is_kept_on_the_skin_in_source_coordinates(self):
		grid, place = side()
		kept, rows, red = curate.gather("right", grid, place, found([{"pixels": [[10, 40], [150, 40]]}]), [], {})
		self.assertEqual(len(kept), 1)
		points = np.array(kept[0]["points"])
		self.assertEqual(len(points), 2)                     # a straight line, simplified to its ends
		self.assertAlmostEqual(points[0][0], 101.25, places=1)
		self.assertAlmostEqual(points[0][1], 115.0, places=1)
		self.assertAlmostEqual(kept[0]["length"], 17.5, places=0)

	def test_a_short_line_and_one_photos_shallow_line_are_dropped(self):
		grid, place = side()
		dropped = {}
		lines = found([{"pixels": [[10, 40], [25, 40]]}, {"pixels": [[10, 60], [150, 60]], "photos": 1, "strength": 0.03}])
		kept, _, _ = curate.gather("right", grid, place, lines, [], dropped)
		self.assertEqual(kept, [])
		self.assertEqual(dropped, {"short": 1, "one photo's": 1})

	def test_one_photos_deep_line_is_kept(self):
		grid, place = side()
		kept, _, _ = curate.gather("right", grid, place, found([{"pixels": [[10, 60], [150, 60]], "photos": 1, "strength": 0.08}]), [], {})
		self.assertEqual(len(kept), 1)

	def test_a_line_the_facts_hold_is_dropped(self):
		grid, place = side()
		held = [np.array([[101.0, 115.2, 20.0], [120.0, 115.2, 20.0]])]
		dropped = {}
		kept, _, _ = curate.gather("right", grid, place, found([{"pixels": [[10, 40], [150, 40]]}]), held, dropped)
		self.assertEqual(kept, [])
		self.assertEqual(dropped, {"held": 1})

	def test_a_line_running_onto_skin_another_chart_faces_is_cut_there(self):
		grid, place = side(bulge=50)
		kept, _, _ = curate.gather("right", grid, place, found([{"pixels": [[100, 5], [100, 75]]}]), [], {})
		self.assertEqual(len(kept), 1)
		self.assertGreater(min(p[1] for p in kept[0]["points"]), 120 - 50 / 8 - 0.5)   # only the part above the bend

	def test_a_line_off_the_model_is_dropped(self):
		grid, place = side()
		place[30:50] = np.nan
		dropped = {}
		kept, _, _ = curate.gather("right", grid, place, found([{"pixels": [[10, 40], [150, 40]]}]), [], dropped)
		self.assertEqual(kept, [])
		self.assertEqual(dropped, {"off the skin": 1})


class PiecesTest(unittest.TestCase):
	def test_a_line_running_off_one_surface_onto_another_ends_there(self):
		# half an inch apart along a nacelle's bottom, then on the wing 20 in above
		points = np.array([[0.0, 80, 0], [0.5, 80, 0], [1.0, 80, 0], [1.5, 100, 0], [2.0, 100, 0], [2.5, 100, 0]])
		self.assertEqual(curate.pieces(points, np.ones(6, bool), 2.0), [(0, 3), (3, 6)])

	def test_a_line_on_one_surface_stays_whole_and_gaps_still_cut_it(self):
		points = np.c_[np.arange(8) * 0.5, np.full(8, 80.0), np.zeros(8)]
		self.assertEqual(curate.pieces(points, np.ones(8, bool), 2.0), [(0, 8)])
		ok = np.ones(8, bool)
		ok[4] = False
		self.assertEqual(curate.pieces(points, ok, 2.0), [(0, 4), (5, 8)])

	def test_gather_ends_a_line_where_the_skin_jumps(self):
		grid, place = side()
		place[:, 80:, 2] = 40.0      # the skin from column 80 on stands 20 in further out: another surface
		kept, _, _ = curate.gather("right", grid, place, found([{"pixels": [[10, 40], [150, 40]]}]), [], {})
		self.assertEqual(len(kept), 2)
		self.assertTrue(all(abs(p[2] - kept[0]["points"][0][2]) < 1e-6 for p in kept[0]["points"]))


if __name__ == "__main__":
	unittest.main()
