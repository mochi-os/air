# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# Tests for check.py: every facts.json entry is measured or exempt, and the
# entries it must account for are found.
#
# usage: python3 -I test_check.py
import re, sys, unittest
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import check  # noqa: E402


class EntriesTest(unittest.TestCase):
	def test_entries(self):
		facts = {"about": "x", "overall": {"length": {"values": [{"value": 1, "source": "a"}], "use": "u"}, "beam": {"deck": {"value": 2, "source": "a"}}},
			"layout": {"about": "y", "notes": {"deck": "z"}, "deck": {"height": 1}, "markings": [{"name": "m"}]}}
		self.assertEqual(check.entries(facts), ["overall.length", "overall.beam.deck", "layout.deck", "layout.markings"])

	def test_every_fact_is_measured_or_exempt(self):
		# The fact ids check.py measures: the first argument of each result()
		source = (HERE / "check.py").read_text()
		start = source.index("EXEMPT = {")
		source = source[:start] + source[source.index("\n}\n", start) + 3 :]
		measured = set(re.findall(r'result\(\s*"([^"]+)"', source))
		for fact in check.entries(check.FACTS):
			self.assertTrue(fact in measured or fact in check.EXEMPT, f"{fact}: neither measured nor exempt")
		for fact in check.EXEMPT:
			self.assertIn(fact, check.entries(check.FACTS), f"{fact}: exempt but not in facts.json")
			self.assertNotIn(fact, measured, f"{fact}: both measured and exempt")

	def test_area(self):
		self.assertEqual(check.area([[0, 0], [4, 0], [4, 3], [0, 3]]), 12)
		self.assertEqual(check.area([[0, 0], [0, 3], [4, 3], [4, 0]]), 12)

	def test_round_down(self):
		# a deck 10 m wide whose aft 3 m drop 0.6 m on the parabola: strips cut
		# every 0.25 m across the curve, then the flat deck to x 10
		r = {"edge": [[0, -5], [0, 5]], "length": 3.0, "drop": 0.6}
		height, inward = 18.0, (1.0, 0.0)
		def deck(fall):
			xs = [k * 0.25 for k in range(13)] + [10.0]
			tris = []
			for a, b in zip(xs, xs[1:]):
				ya, yb = fall(a), fall(b)
				tris += [[[a, ya, -5], [b, yb, -5], [b, yb, 5]], [[a, ya, -5], [b, yb, 5], [a, ya, 5]]]
			return np.array(tris, float)
		curve = lambda x: height - 0.6 * max(0.0, 1 - x / 3.0) ** 2
		self.assertLess(check.rounding_miss(deck(curve), r, height, inward), 0.02)        # chords 0.25 m apart: under 2 cm
		self.assertGreater(check.rounding_miss(deck(lambda x: height), r, height, inward), 0.4)    # flat: no round-down
		straight = lambda x: height - 0.6 * max(0.0, 1 - x / 3.0)                         # a ramp, not the parabola
		self.assertGreater(check.rounding_miss(deck(straight), r, height, inward), 0.1)

	def test_rounding_inward(self):
		# toward the deck's middle, whichever way the edge runs
		r = dict(check.FACTS["layout"]["deck"]["round"])
		nx, nz = check.rounding_inward(r)
		mx, mz = np.mean(np.array(check.FACTS["layout"]["deck"]["outline"], float), axis=0)
		(ax, az), _ = r["edge"]
		self.assertGreater((mx - ax) * nx + (mz - az) * nz, 0)
		r["edge"] = r["edge"][::-1]
		self.assertGreater((mx - r["edge"][0][0]) * check.rounding_inward(r)[0] + (mz - r["edge"][0][1]) * check.rounding_inward(r)[1], 0)
		self.assertAlmostEqual(float(check.rounding_distance(r, np.array([[mx, mz]]))[0]), (mx - r["edge"][0][0]) * check.rounding_inward(r)[0] + (mz - r["edge"][0][1]) * check.rounding_inward(r)[1])


if __name__ == "__main__":
	unittest.main()
