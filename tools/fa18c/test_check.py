# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# usage: python3 -I test_check.py
import json, math, re, sys, tempfile, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "verify"))

import numpy as np  # noqa: E402

import check  # noqa: E402
from test_verify import box, glb  # noqa: E402


class EntriesTest(unittest.TestCase):
	def test_entries(self):
		facts = {"about": "x", "overall": {"length": {"value": 1, "source": "a"}, "span": {"spread": {"value": 2, "source": "a"}}},
			"sections": [{"station": 70, "source": "b"}, {"station": 85, "source": "b"}],
			"gravity": [{"aircraft": "HARV", "station": 454.3, "source": "c"}],
			"layout": {"about": "y", "wing": {"value": 113}, "gear": {"nose": 1}}}
		self.assertEqual(check.entries(facts), ["overall.length", "overall.span.spread", "sections@70", "sections@85", "gravity@HARV", "layout.wing", "layout.gear"])

	def test_every_fact_is_measured_or_exempt(self):
		# The fact ids check.py measures, read from its source: literal ids, and
		# the per-station families it builds with f-strings
		source = (HERE / "check.py").read_text()
		start = source.index("EXEMPT = {")
		source = source[:start] + source[source.index("\n}\n", start) + 3 :]
		# the first argument of result() calls, and any quoted dotted path (fact
		# ids carried in tuples); a bare word such as "canopy" is a node's name
		measured = set(re.findall(r'result\(\s*"([^"]+)"', source)) | set(re.findall(r'"([a-z0-9_]+(?:\.[a-z0-9_]+)+)"', source))
		for family, key in (("sections", "sections"), ("lex.sections", "lex")):
			if f'f"{family}@{{' in source or f"f\"{family}@{{" in source:
				rows = check.FACTS[key] if key == "sections" else check.FACTS["lex"]["sections"]
				measured |= {f"{family}@{r['station']}" for r in rows}
		for fact in check.entries(check.FACTS):
			self.assertTrue(fact in measured or fact in check.EXEMPT, f"{fact}: neither measured nor exempt")
		for fact in check.EXEMPT:
			self.assertIn(fact, check.entries(check.FACTS), f"{fact}: exempt but not in facts.json")
			self.assertNotIn(fact, measured, f"{fact}: both measured and exempt")


class GeometryTest(unittest.TestCase):
	def test_loops_and_area(self):
		square = np.array([[[0, 0], [2, 0]], [[2, 2], [2, 0]], [[2, 2], [0, 2]], [[0, 0], [0, 2]]], float)
		(loop,) = check.loops(square)
		self.assertEqual(len(loop), 5)
		self.assertAlmostEqual(check.shoelace(loop), 4.0)

	def test_leading_sweep(self):
		# an untapered wing's leading edge sweeps as its quarter chord does
		self.assertAlmostEqual(check.leading_sweep(30, 4, 1.0), 30)
		self.assertGreater(check.leading_sweep(20, 3.5, 0.35), 20)

	def test_jet_cuts_in_stations(self):
		with tempfile.TemporaryDirectory() as d:
			path = Path(d) / "m.glb"
			# a box from FS 400 to 500, WL 100 to 120, BL -10 to 10 (model frame: x = (456 - FS) in, y = WL - 105, z = BL)
			i = 0.0254
			glb(path, [{"name": "fuselage", "mesh": box(((456 - 500) * i, -5 * i, -10 * i), ((456 - 400) * i, 15 * i, 10 * i))}])
			(Path(d) / "m.json").write_text(json.dumps({"joints": {}, "points": {}}))
			jet = check.Jet(path, Path(d) / "m.json")
			q = jet.cut(["fuselage"], [450, 100, 0], [1, 0, 0])
			np.testing.assert_allclose(q[:, 0], 450, atol=1e-6)
			self.assertAlmostEqual(q[:, 1].max() - q[:, 1].min(), 20, places=4)
			self.assertAlmostEqual(q[:, 2].max(), 10, places=4)
			with self.assertRaises(KeyError):
				jet.tris(["wing_inner_right"])


if __name__ == "__main__":
	unittest.main()
