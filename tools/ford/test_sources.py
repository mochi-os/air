# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# Tests for sources.py: a fact stands only on a quote found in its own source.
#
# usage: python3 -I test_sources.py
import sys, tempfile, unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sources

PAGE = "<html><head><title>Facts</title><script>var Length = 'Length: 9 feet';</script></head><body><p>Length:&nbsp;1,092\n  feet</p><p>It’s 256 feet wide</p></body></html>"


class Sources(unittest.TestCase):
	def setUp(self):
		self.folder = tempfile.TemporaryDirectory()
		self.cache = Path(self.folder.name)
		(self.cache / "page.html").write_text(PAGE)
		self.references = [{"id": "page", "file": "page.html"}]

	def tearDown(self):
		self.folder.cleanup()

	def run_facts(self, *quotes, source="page"):
		facts = {"group": {f"fact{i}": {"value": 1, "source": source, "quote": q} for i, q in enumerate(quotes)}}
		return sources.check(self.references, facts, self.cache)

	def test_found(self):
		# whitespace, a non-breaking space and a curly apostrophe all fold
		count, failures = self.run_facts("Length: 1,092 feet", "It's 256 feet wide")
		self.assertEqual((count, failures), (2, []))

	def test_missing_quote(self):
		count, failures = self.run_facts("Length: 1,106 feet")
		self.assertEqual(count, 1)
		self.assertEqual(len(failures), 1)
		self.assertIn("not found", failures[0])

	def test_script_text_does_not_count(self):
		# a block page's or a script's text is not the document's
		count, failures = self.run_facts("Length: 9 feet")
		self.assertEqual(len(failures), 1)

	def test_unknown_source(self):
		count, failures = self.run_facts("Length: 1,092 feet", source="elsewhere")
		self.assertIn("not in references.json", failures[0])

	def test_not_fetched(self):
		self.references = [{"id": "page", "file": "absent.html"}]
		count, failures = self.run_facts("Length: 1,092 feet")
		self.assertIn("not fetched", failures[0])

	def test_any_reading(self):
		# a table's row is whole in one reading of a PDF and split in the other
		original = sources.texts
		sources.texts = lambda path: ["GF\nGG\nGERALD R FORD(CVN)(78)", "GF    GERALD R FORD(CVN)(78)\nGG    GROTON"]
		try:
			count, failures = self.run_facts("GF GERALD R FORD(CVN)(78)", "GF GROTON")
		finally:
			sources.texts = original
		self.assertEqual(count, 2)
		self.assertEqual(len(failures), 1)
		self.assertIn("GF GROTON", failures[0])

	def test_nested_lists(self):
		facts = {"length": {"values": [{"source": "page", "quote": "Length: 1,092 feet"}, {"source": "page", "quote": "Length: 1,106 feet"}]}}
		count, failures = sources.check(self.references, facts, self.cache)
		self.assertEqual(count, 2)
		self.assertEqual(len(failures), 1)
		self.assertIn("length.values.1", failures[0])


if __name__ == "__main__":
	unittest.main()
