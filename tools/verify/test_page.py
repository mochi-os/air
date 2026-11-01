# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
import json
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import page  # noqa: E402

GATE = """photo dvids1: 9 marks
unjudged (a weak camera): edge far:spine: camera far at field 1.0 deg, rms 4.0 px
known: edge good:fin_leading: median miss 2.03 in, worst 3.04 (a distance from the build's curve, without a side): the fins stand aft
known: point fold_trailing_left: miss [-3.25, 3.51, -7.31] in, uncertainty [1.88, 2.88, 0.82] (2 photos): the fold, <not settled>
FAILED: edge good:nose: median miss 2.00 in, worst +3.00
gate: 1 failed, 2 known, 1 unjudged
"""


class PageTest(unittest.TestCase):
	def test_gate(self):
		rows, total = page.gate(GATE)
		self.assertEqual(total, "1 failed, 2 known, 1 unjudged")
		self.assertEqual([n for n, _ in rows["known"]], ["edge good:fin_leading", "point fold_trailing_left"])
		self.assertEqual(rows["known"][0][1], "median miss 2.03 in, worst 3.04 (a distance from the build's curve, without a side): the fins stand aft")
		self.assertEqual(rows["failed"], [("edge good:nose", "median miss 2.00 in, worst +3.00")])
		self.assertEqual([n for n, _ in rows["unjudged"]], ["edge far:spine"])

	def test_coverage(self):
		summary = {"universe": [["body", 432, "top"], ["body", 456, "top"], ["body", 456, "side"], ["fin", 600, ""]],
			"regions": [{"family": "body", "stretch": 432, "sector": "top", "region": "body FS 432-456 top", "photos": {"a": 0.4, "b": 0.6}, "median": 0.5, "finding": False},
				{"family": "body", "stretch": 456, "sector": "top", "region": "body FS 456-480 top", "photos": {"a": 1.9}, "median": 1.9, "finding": False},
				{"family": "fin", "stretch": 600, "sector": "", "region": "fin FS 600-624", "photos": {"a": -1.2, "b": -1.4}, "median": -1.3, "finding": True}]}
		text = page.coverage(summary)
		self.assertIn('<td class="two" title="body FS 432-456 top: 2 photos, a +0.4, b +0.6">+0.5</td>', text)
		self.assertIn('<td class="one"', text)
		self.assertIn('<td class="miss"', text)
		self.assertIn('<td class="none" title="body FS 456-480: no photo">', text)
		# a stretch with no skin in a row is left blank, not marked unmeasured
		self.assertIn('<td class="void"></td>', text)
		# body sectors first, in order round the section, then the other parts
		self.assertLess(text.index("body, top"), text.index("body, side"))
		self.assertLess(text.index("body, side"), text.index(">fin<"))

	def test_build(self):
		# a run's outputs to a page: escaped text, images copied as JPEGs, the finding's sheet shown
		with tempfile.TemporaryDirectory() as root:
			root = Path(root)
			sky, sheets, out = root / "sky", root / "sheets", root / "out"
			sky.mkdir()
			sheets.mkdir()
			summary = {"photos": {"p1": {"tried": 10, "judged": 4, "median": 0.8, "weak": False}},
				"regions": [{"family": "fin", "stretch": 600, "sector": "", "region": "fin FS 600-624", "photos": {"p1": -1.2, "p2": -1.4}, "median": -1.3, "places": 8,
					"finding": True, "moving": False},
				{"family": "stabilator", "stretch": 696, "sector": "", "region": "stabilator FS 696-720", "photos": {"p1": -1.2, "p2": -1.3}, "median": -1.2, "places": 9,
					"finding": True, "moving": True}], "universe": [["fin", 600, ""], ["stabilator", 696, ""]]}
			(sky / "summary.json").write_text(json.dumps(summary))
			Image.new("RGB", (3000, 2000)).save(sky / "p1.png")
			Image.new("RGB", (800, 400)).save(sky / "finding fin FS 600-624.png")
			for kind in ("photo", "model", "over"):
				Image.new("RGB", (1600, 1000)).save(sheets / f"p1-{kind}.jpg")
			catalogue = {"photos": {"p1": {"shows": "left side <taxiing>"}}, "skyline": {"notes": {"fin FS 600-624": "the fins stand 1 in aft & more", "stabilator FS 696-720": "posed <from the photos>"}}}
			page.build(catalogue, [{"photo": "p1", "rms": 4.0, "field": 30.0}], sky, sheets, GATE, out, "F/A-18C", "Hornet shape review")
			text = (out / "index.html").read_text()
			self.assertIn("<title>Hornet shape review</title>", text)
			self.assertIn("left side &lt;taxiing&gt;", text)
			self.assertIn("the fold, &lt;not settled&gt;", text)
			self.assertIn('src="img/finding-fin-fs-600-624.jpg"', text)
			self.assertIn("-1.3 in", text)
			self.assertIn('<p class="note col">the fins stand 1 in aft &amp; more</p>', text)
			# a finding on a moving surface is listed apart, with its note
			self.assertIn('<span class="pid">stabilator FS 696-720</span> -1.2 in, 2 photos<br><span class="note">posed &lt;from the photos&gt;</span>', text)
			for name in ("p1-photo.jpg", "p1-model.jpg", "p1-over.jpg", "p1-sky.jpg", "finding-fin-fs-600-624.jpg"):
				self.assertTrue((out / "img" / name).exists(), name)
			with Image.open(out / "img" / "p1-sky.jpg") as image:
				self.assertEqual(image.width, page.WIDTH)


if __name__ == "__main__":
	unittest.main()
