# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
import math
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import charts  # noqa: E402


def skin(h=80, w=120, level=0.6):
	return np.full((h, w), level, np.float32)


class ValleyTest(unittest.TestCase):
	def test_a_thin_dark_line_is_a_valley(self):
		g = skin()
		g[:, 60] = 0.45
		depth, _ = charts.valleys(g)
		self.assertGreater(depth[40, 60], charts.LEAST)
		self.assertLess(depth[40, 40], 0.005)

	def test_a_step_is_no_valley(self):
		# a stroke's edge or a shadow's is darker on one side only
		g = skin()
		g[:, 60:] = 0.4
		depth, _ = charts.valleys(g)
		self.assertLess(depth[20:60, 50:70].max(), charts.WEAK)

	def test_no_valley_where_one_side_is_unseen(self):
		# at the edge of what a photo sees, the skin beyond is NaN: read
		# against one side alone, every step there would be a valley
		g = skin()
		g[:, :60] = np.nan
		g[:, 60:63] = 0.45
		depth, _ = charts.valleys(g)
		self.assertLess(np.nanmax(depth[20:60, 58:64]), charts.WEAK)


class MarkingTest(unittest.TestCase):
	def test_a_thick_dark_stroke_is_a_marking_and_a_thin_line_is_not(self):
		g = skin(120, 160)
		g[20:100, 30:46] = 0.2      # a letter's stroke, 16 pixels wide
		g[:, 120] = 0.4             # a panel line
		marked = charts.markings(g)
		self.assertTrue(marked[60, 38])
		self.assertTrue(marked[60, 30 - charts.CLEAR // 2])   # its outline, cleared
		self.assertFalse(marked[60, 120])
		self.assertFalse(marked[60, 90])


class OverlapTest(unittest.TestCase):
	def test_a_step_in_the_skin_behind_and_the_outline_are_edges_and_the_skin_is_not(self):
		place = np.zeros((60, 80, 3), np.float32)
		place[..., 0] = np.arange(80)[None, :] * 0.125
		place[..., 2] = 10.0
		place[:, 40:, 2] = 4.0          # a part standing 6 in in front of another from column 40
		place[:, 70:] = np.nan          # off the model
		edges = charts.overlaps(place)
		self.assertTrue(edges[30, 39] and edges[30, 40])
		self.assertTrue(edges[30, 69])
		self.assertFalse(edges[30, 20])
		self.assertFalse(edges[30, 55])


class DotTest(unittest.TestCase):
	def test_a_dot_darker_all_round_is_found(self):
		g = skin()
		g[39:41, 59:61] = 0.4
		found = charts.peaks(charts.dots(g), charts.DOT)
		self.assertTrue(any(abs(x - 59.5) <= 1 and abs(y - 39.5) <= 1 for x, y in found))

	def test_a_line_is_no_dot(self):
		# a line is lighter along itself, where a fastener is not
		g = skin()
		g[:, 60] = 0.4
		self.assertEqual(len(charts.peaks(charts.dots(g), charts.DOT)), 0)


class ChainTest(unittest.TestCase):
	def test_a_straight_crest_is_one_line_of_two_points(self):
		strength = np.zeros((60, 100), np.float32)
		strength[30, 10:90] = 0.1
		which = np.full(strength.shape, 1, np.int8)   # across the line: (0, 1), down the rows
		crest = charts.thinned(strength, which)
		runs = charts.chains(crest, strength)
		self.assertEqual(len(runs), 1)
		simple = charts.simplified(runs[0])
		self.assertEqual(len(simple), 2)
		self.assertEqual(sorted(simple[:, 0].tolist()), [10.0, 89.0])

	def test_two_pieces_of_a_broken_line_are_joined(self):
		a = np.array([[x, 30.0] for x in range(10, 40)])
		b = np.array([[x, 30.0] for x in range(43, 80)])
		joined = charts.joined([a, b[::-1]])
		self.assertEqual(len(joined), 1)
		self.assertEqual(len(joined[0]), len(a) + len(b))

	def test_crossing_lines_are_not_joined(self):
		a = np.array([[x, 30.0] for x in range(10, 40)])
		b = np.array([[41.0, y] for y in range(31, 60)])
		self.assertEqual(len(charts.joined([a, b])), 2)

	def test_a_short_run_is_dropped(self):
		strength = np.zeros((60, 100), np.float32)
		strength[30, 10:10 + charts.SHORTEST - 2] = 0.1
		which = np.full(strength.shape, 1, np.int8)
		self.assertEqual(charts.chains(charts.thinned(strength, which), strength), [])


class RowTest(unittest.TestCase):
	def test_evenly_spaced_heads_are_one_row(self):
		heads = [[10 + 8 * k, 30] for k in range(6)]
		found = charts.rows(heads)
		self.assertEqual(len(found), 1)
		self.assertEqual(sorted(found[0]), list(range(6)))

	def test_a_row_round_a_6_inch_curve_is_followed(self):
		# 48 px at 8 px a inch, a head an inch on
		heads = [[50 + 48 * math.cos(a), 50 + 48 * math.sin(a)] for a in np.arange(0, 2.0, 8 / 48)]
		self.assertEqual([len(r) for r in charts.rows(heads)], [len(heads)])

	def test_a_jittered_row_with_a_third_of_its_heads_missed_is_found(self):
		found = 0
		for seed in range(20):
			r = np.random.default_rng(100 + seed)
			heads = [[10 + 8 * k + r.normal(0, 0.4), 30 + r.normal(0, 0.4)] for k in range(15) if r.uniform() > 0.33]
			rows = charts.rows(heads)
			found += bool(rows) and max(len(g) for g in rows) >= len(heads) - 2
		self.assertGreaterEqual(found, 17)

	def test_a_scatter_is_no_row(self):
		# 25 specks in 560 px square, as dense as the heads the F/A-18C's
		# right side gives, at many draws
		for seed in range(40):
			heads = np.random.default_rng(seed).uniform(0, 560, (25, 2))
			self.assertEqual(charts.rows(heads), [], seed)

	def test_too_few_heads_are_no_row(self):
		self.assertEqual(charts.rows([[10 + 8 * k, 30] for k in range(charts.ROW - 1)]), [])

	def test_two_crossing_rows_share_the_head_where_they_cross(self):
		across = [[10 + 8 * k, 40] for k in range(7)]
		down = [[34, 10 + 10 * k] for k in range(7) if 10 + 10 * k != 40]
		found = charts.rows(across + down)
		self.assertEqual(sorted(len(r) for r in found), [7, 7])
		self.assertEqual(len(set(found[0]) & set(found[1])), 1)

	def test_a_row_with_heads_missing_is_one_row_with_its_own_pitch(self):
		heads = [[10 + 8 * k, 30] for k in range(12) if k not in (3, 7, 8)]
		found = charts.rows(heads)
		self.assertEqual([len(r) for r in found], [9])
		self.assertAlmostEqual(charts.pitch_of([[x, y, 0] for x, y in np.array(heads)[sorted(found[0])]]), 8.0, places=3)

	def test_a_row_read_at_twice_its_pitch_is_not_taken_again(self):
		heads = [[10 + 6 * k, 30] for k in range(12)]
		self.assertEqual([len(r) for r in charts.rows(heads)], [12])


if __name__ == "__main__":
	unittest.main()
