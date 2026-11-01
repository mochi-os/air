# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
import json, math, sys, tempfile, unittest
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import camera as cam  # noqa: E402
import model as mod  # noqa: E402
import poses  # noqa: E402
import skyline  # noqa: E402
from test_verify import JET, box, glb  # noqa: E402

FLAP = {"flap": {"motion": "rotate", "axis": [0, 0, 1], "drive": "flap", "keys": [[-1, -1], [1, 1]]}}


class PosesTest(unittest.TestCase):
	def test_score(self):
		# the mean size of the misses, the largest fifth left out, whichever side they fall
		self.assertAlmostEqual(poses.score([1, -2, 3, -4, 100]), 2.5)
		self.assertAlmostEqual(poses.score([0.5]), 0.5)

	def test_fit_finds_the_least(self):
		# the scan's best, refined to a quarter of its step
		found = poses.fit(lambda a: (abs(a - 0.237) + 0.1, 20), 0.0, 10)
		self.assertAlmostEqual(found[0], 0.237, delta=poses.STEP / 4)
		self.assertEqual(found[2], 20)
		# the catalogue's own angle is always tried
		calls = []
		poses.fit(lambda a: (calls.append(a) or 1.0, 20), 0.333, 10)
		self.assertIn(0.333, calls)

	def test_fit_needs_places(self):
		# a lower score where the surface has turned out of sight does not
		# count, in the final pick or in choosing where to refine: the best of
		# the angles that keep it in sight, refined from 0.2 to 0.25
		found = poses.fit(lambda a: (abs(a - 0.5), 20 if a < 0.27 else 2), 0.0, 10)
		self.assertAlmostEqual(found[0], 0.25, places=4)
		self.assertIsNone(poses.fit(lambda a: (1.0, 2), 0.0, 10))

	def test_fit_needs_a_minimum(self):
		# a score still falling at the scan's end is no fit: the surface would go on turning
		self.assertIsNone(poses.fit(lambda a: (a + 1.0, 20), 0.0, 10))
		self.assertIsNotNone(poses.fit(lambda a: (abs(a + 0.7), 20), 0.0, 10))

	def test_fit_a_photo(self):
		# a plate with a flap hinged at its aft end, seen side on against the
		# sky, the photo taken with the flap 0.3 rad down: fitting the flap to
		# the photo's outline finds 0.3, where the catalogue's rest pose missed
		with tempfile.TemporaryDirectory() as root:
			root = Path(root)
			glb(root / "m.glb", [{"name": "body", "mesh": box((-1, -0.1, -0.5), (1, 0.1, 0.5))},
				{"name": "flap", "translation": (-1, 0, 0), "mesh": box((-0.6, -0.03, -0.5), (0, 0.03, 0.5))}])
			model = mod.Model(root / "m.glb")
			size = [1200, 600]
			camera = cam.looking(np.array([-0.3, 0.0, 12.0]), np.array([-0.3, 0.0, 0.0]), 2400.0)
			centre = (size[0] / 2, size[1] / 2)
			truth = model.triangles(mod.pose(FLAP, {"joints": {"flap": 0.3}}))
			flat, depth = cam.project(camera, truth.reshape(-1, 3), centre)
			mask = skyline.frontmost(flat.reshape(-1, 3, 2), depth.reshape(-1, 3), tuple(size)) >= 0
			(root / "references").mkdir()
			Image.fromarray(np.where(mask, 60, 200).astype(np.uint8)).convert("RGB").save(root / "references" / "p.png")
			entry = {"photo": "p", "file": "p.png", "size": size, "camera": list(camera), "pose": {}}
			catalogue = {"frame": JET, "photos": {"p": {"file": "p.png"}}}
			scene = skyline.Scene(catalogue, root, mod.Frame(JET), {}, entry)
			places, _ = scene.places(model, FLAP, {}, parts={"flap"})
			self.assertTrue(places)
			self.assertEqual({p["part"] for p in places}, {"flap"})
			before = poses.score([p["miss"] for p in places])
			self.assertGreater(before, 2.0)

			def evaluate(angle):
				found, _ = scene.places(model, FLAP, {"joints": {"flap": angle}}, parts={"flap"})
				return (poses.score([p["miss"] for p in found]) if found else math.inf), len(found)

			angle, after, kept = poses.fit(evaluate, 0.0, len(places) // 2)
			self.assertAlmostEqual(angle, 0.3, delta=0.03)
			self.assertLess(after, 0.5)
			# with no parts named, the body's outline is judged too
			every, _ = scene.places(model, FLAP, {"joints": {"flap": 0.3}})
			self.assertIn("body", {p["part"] for p in every})


if __name__ == "__main__":
	unittest.main()
