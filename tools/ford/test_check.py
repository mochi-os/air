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


if __name__ == "__main__":
	unittest.main()
