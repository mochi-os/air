# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# usage: python3 -I test_check.py
import json, math, sys, tempfile, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "verify"))

import check  # noqa: E402
from test_verify import box, glb, guess_counts  # noqa: E402

INCH = 0.0254


def missile(path, length=113.0, radius=2.5, reach=12.375, nose=None):
	# A box "AIM-9M": a body `length` long whose corners stand `radius` off
	# the axis, a wing whose corner reaches `reach`, its origin 55 in aft of
	# the nose; and its points file
	half = radius / math.sqrt(2) * INCH
	body = box(((55 - length) * INCH, -half, -half), (55 * INCH, half, half))
	w = reach / math.sqrt(2) * INCH
	wing = box((-56 * INCH, 0, 0), (-40 * INCH, w, w))
	glb(path / "m.glb", [{"name": "body", "mesh": body}, {"name": "wing_upper_right", "mesh": wing}])
	points = {"joints": {}, "points": {"nose": [(nose if nose is not None else 55.0) * INCH, 0, 0], "exit": [(55 - length) * INCH, 0, 0],
		"gravity": [0, 0, 0], "mount": [-8.9 * INCH, 2.5 * INCH, 0]}}
	(path / "m.json").write_text(json.dumps(points))
	return path / "m.glb", path / "m.json"


class CheckTest(unittest.TestCase):
	def setUp(self):
		self.dir = tempfile.TemporaryDirectory()
		self.root = Path(self.dir.name)

	def tearDown(self):
		self.dir.cleanup()

	def failures(self, **mutation):
		results = check.measure("aim9m", *missile(self.root, **mutation))
		return {r["fact"] for r in results if check.failed(r)}

	def test_a_true_build_passes(self):
		self.assertEqual(self.failures(), set())

	def test_each_miss_fails_its_own_fact(self):
		self.assertEqual(self.failures(length=110.0), {"length"})
		self.assertEqual(self.failures(radius=2.8), {"diameter"})
		self.assertEqual(self.failures(reach=11.0), {"span"})
		self.assertEqual(self.failures(nose=54.0), {"nose"})

	def test_no_wings_fails_the_span(self):
		# a missile built without its wings measures no span: a failure, not a pass
		glb_path, points = missile(self.root)
		from test_verify import glb as write
		write(glb_path, [{"name": "body", "mesh": box(((55 - 113.0) * INCH, -0.04, -0.04), (55 * INCH, 0.04, 0.04))}])
		results = check.measure("aim9m", glb_path, points)
		self.assertIn("span", {r["fact"] for r in results if check.failed(r)})

	def test_every_fact_is_measured_or_exempt(self):
		# both missiles' cited sizes: each one a measurement names or EXEMPT
		results = check.measure("aim9m", *missile(self.root))
		for name in ("aim9m", "aim120c"):
			self.assertEqual(check.unaccounted(name, results), [], name)
		# a new fact neither measures nor exempts fails
		check.FACTS["aim9m"]["fineness"] = {"value": 22.6}
		try:
			self.assertEqual(check.unaccounted("aim9m", results), ["fineness"])
		finally:
			del check.FACTS["aim9m"]["fineness"]


	def test_no_fact_is_a_guess(self):
		# A shape no source shows is asked about, never guessed: any facts.json
		# text saying it is guessed ("by eye", "estimated", "not measured", "unseen": verify's GUESS) is a guess unless the user signed it off
		# (check.GUESSES), and a sign-off names a text that still says it
		counts = guess_counts(check.FACTS)
		unsigned = [f"{p}: says it is guessed (verify's GUESS words), no source measured it and the user has not signed it off (check.GUESSES)" for p in sorted(set(counts) - set(check.GUESSES))]
		stale = [f"{p}: signed off in check.GUESSES but no longer says it is guessed" for p in sorted(set(check.GUESSES) - set(counts))]
		grown = [f"{p}: holds {counts[p]} guesses where the sign-off covers {check.GUESSES[p][0]}: ask the user about the new one" for p in sorted(set(counts) & set(check.GUESSES)) if counts[p] != check.GUESSES[p][0]]
		self.assertFalse(unsigned + stale + grown, "\n" + "\n".join(unsigned + stale + grown))


if __name__ == "__main__":
	unittest.main()
