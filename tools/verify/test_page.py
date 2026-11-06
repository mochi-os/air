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
import skyline  # noqa: E402
from test_verify import JET  # noqa: E402

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

	def test_coverage_settings(self):
		# the catalogue's sectors give the body's rows, in their order; its label and stretch the cells' titles
		summary = {"universe": [["body", 440, "hull"], ["body", 440, "deck"], ["body", 480, "deck"]], "regions": []}
		settings = skyline.Settings({"skyline": {"stretch": 40, "label": "frame", "sectors": [[90, "deck"], [181, "hull"]]}})
		text = page.coverage(summary, settings)
		self.assertLess(text.index("body, deck"), text.index("body, hull"))
		self.assertIn('<td class="none" title="body frame 480-520: no photo">', text)
		self.assertNotIn("body, deck", page.coverage(summary))

	def test_coverage_sides(self):
		# a catalogue whose regions are split by side (a ship's): a row per part
		# and side, the body first, port before starboard, each cell filled
		summary = {"universe": [["deck", 10, "starboard"], ["deck", 10, "port"], ["body", 10, "port"], ["hull", 20, "starboard"]],
			"regions": [{"family": "deck", "stretch": 10, "sector": "port", "region": "deck x 10-20 port", "photos": {"a": 0.4, "b": 0.6}, "median": 0.5,
				"finding": False}]}
		settings = skyline.Settings({"skyline": {"stretch": 10, "label": "x", "sectored": [], "sides": ["port", "starboard"]}})
		text = page.coverage(summary, settings)
		self.assertLess(text.index("body, port"), text.index("deck, port"))
		self.assertLess(text.index("deck, port"), text.index("deck, starboard"))
		self.assertLess(text.index("deck, starboard"), text.index("hull, starboard"))
		self.assertIn('<td class="two" title="deck x 10-20 port: 2 photos, a +0.4, b +0.6">+0.5</td>', text)
		self.assertIn('<td class="none" title="deck x 10-20: no photo">', text)

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
			# the F/A-18C's wording at the defaults
			for words in ("of the real aircraft,", "finds the aircraft's own outline", "Misses are in inches:", "misses by more than an inch (",
				"green within 1 in, yellow within 2.5, magenta beyond", "across 24 in of stations", "posed as the aircraft stood", page.POSING,
				"median miss 0.80 in"):
				self.assertIn(words, text)

	def test_build_measured(self):
		# a copyrighted photo is measured only: the page shows the model through its camera, never its pixels
		with tempfile.TemporaryDirectory() as root:
			root = Path(root)
			sky, sheets, out = root / "sky", root / "sheets", root / "out"
			sky.mkdir()
			sheets.mkdir()
			summary = {"photos": {"p1": {"tried": 10, "judged": 4, "median": 0.8, "weak": False}}, "regions": [], "universe": []}
			(sky / "summary.json").write_text(json.dumps(summary))
			Image.new("RGB", (3000, 2000)).save(sky / "p1.png")
			for kind in ("photo", "model", "over"):
				Image.new("RGB", (1600, 1000)).save(sheets / f"p1-{kind}.jpg")
			page.build({"photos": {"p1": {"use": "measure"}}}, [{"photo": "p1", "rms": 4.0, "field": 30.0}], sky, sheets, GATE, out, "F/A-18C", "Hornet shape review")
			self.assertEqual(sorted(f.name for f in (out / "img").glob("p1-*")), ["p1-model.jpg"])
			text = (out / "index.html").read_text()
			self.assertIn("copyrighted, measured only", text)
			self.assertNotIn("p1-photo.jpg", text)
			self.assertNotIn("p1-sky.jpg", text)

	def test_build_settings(self):
		# a ship's catalogue: its subject, the frame's unit, the tolerance, the stretch and how its parts are
		# posed, all in the page's text; the notes still show beside the findings
		with tempfile.TemporaryDirectory() as root:
			root = Path(root)
			sky, sheets, out = root / "sky", root / "sheets", root / "out"
			sky.mkdir()
			sheets.mkdir()
			summary = {"photos": {"p1": {"tried": 10, "judged": 4, "median": 0.8, "weak": False}},
				"regions": [{"family": "island", "stretch": 600, "sector": "", "region": "island frame 600-640", "photos": {"p1": -3.2, "p2": -3.4}, "median": -3.3,
					"places": 8, "finding": True, "moving": False},
				{"family": "elevator", "stretch": 640, "sector": "", "region": "elevator frame 640-680", "photos": {"p1": 2.2, "p2": 2.6}, "median": 2.4, "places": 9,
					"finding": True, "moving": True}], "universe": [["island", 600, ""], ["elevator", 640, ""]]}
			(sky / "summary.json").write_text(json.dumps(summary))
			catalogue = {"frame": dict(JET, symbol="ft", plural="feet"), "subject": "ship", "photos": {"p1": {"shows": "port side"}},
				"skyline": {"tolerance": 2, "stretch": 40, "label": "frame", "posing": "The elevators are posed from the photos.",
					"about": "the photos' sea", "notes": {"island frame 600-640": "the island's mast"}}}
			page.build(catalogue, [{"photo": "p1", "rms": 4.0, "field": 30.0}], sky, sheets, GATE, out, "Ford · Air", "Ford shape review")
			text = (out / "index.html").read_text()
			for words in ("of the real ship,", "finds the ship's own outline", "Misses are in feet:", "misses by more than 2 ft (",
				"green within 2 ft, yellow within 5, magenta beyond", "across 40 ft of stations", "posed as the ship stood",
				"These follow each photo's pose. The elevators are posed from the photos.</p>", '<span class="miss">-3.3 ft</span>',
				"</span> +2.4 ft, 2 photos", "median miss 0.80 ft", '<p class="note col">the island&#x27;s mast</p>'):
				self.assertIn(words, text)
			for words in ("aircraft", "inches", "an inch", " in</span>", page.POSING):
				self.assertNotIn(words, text)


if __name__ == "__main__":
	unittest.main()
