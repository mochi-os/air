# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# Tests for weather.py's rules, on the maps of a plain wall: a face 6 m wide
# and 6 m tall standing on the deck, facing starboard, each texel 5 cm.
#
# usage: python3 -I test_weather.py
import sys, unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import weather  # noqa: E402

DECK = 18.27
SIZE = 120


def wall(ao=None):
	# The maps of a wall at z 10, x 0-6, y DECK to DECK + 6, top row first
	rows, columns = np.mgrid[0:SIZE, 0:SIZE]
	x = columns / SIZE * 6.0
	y = DECK + 6.0 - rows / SIZE * 6.0
	position = np.stack([x, y, np.full_like(x, 10.0)], -1).astype(np.float32)
	normal = np.broadcast_to(np.array([0.0, 0.0, 1.0], np.float32), position.shape).copy()
	return {"position": position, "normal": normal, "ao": np.ones((SIZE, SIZE), np.float32) if ao is None else ao,
		"valid": np.ones((SIZE, SIZE), bool), "texel": np.float32(0.05)}


def facts(windows=()):
	return {"layout": {"deck": {"height": DECK, "outline": [[-50, -40], [50, -40], [50, 40], [-50, 40]], "thickness": 0.5},
		"hull": {"boot": 1.0},
		"island": {"windows": list(windows), "panels": [], "details": [], "prisms": []},
		"weathering": {"grey": [0.30, 0.32, 0.33], "groups": [GROUP]}}}


GROUP = {"material": "island", "plates": {"height": 1.8, "width": 3.0, "origin": DECK}, "frames": 0.6,
	"streaks": {"length": [1.0, 3.0], "share": 1.0, "rust": 0.5, "strength": 0.5}}


def at(maps, x, y):
	# the texel nearest (x, y) on the wall
	return int(round((DECK + 6.0 - y) / 6.0 * SIZE)), int(round(x / 6.0 * SIZE))


class WeatherTest(unittest.TestCase):
	def test_seams_are_darker_and_grooved(self):
		maps = wall()
		colour, height = weather.weather(maps, GROUP, facts())
		# along the seam between the first two rows of plates, against the rows of
		# texels 15 cm either side of it, which average the plates' tones out
		seam = at(maps, 0, DECK + 1.8)[0]
		either = (colour[seam - 3].mean() + colour[seam + 3].mean()) / 2
		self.assertLess(colour[seam].mean(), either * 0.97)
		self.assertLess(height[seam].mean(), (height[seam - 3].mean() + height[seam + 3].mean()) / 2 - 0.1)

	def test_plates_differ_in_tone(self):
		colour, _ = weather.weather(wall(), dict(GROUP, touchups=0.0), facts())   # no touch-ups, whose patches step too
		# across each upright seam the grey steps from one plate's tone to the
		# next's: texels 5 cm either side, down the plate's height, in the rows
		# above the grime's 2.5 m (the mottling barely changes over 10 cm)
		steps = []
		for (low, high), seams in (((2.6, 3.4), (1.5, 4.5)), ((3.8, 5.2), (3.0,))):
			r0, r1 = at(None, 0, DECK + high)[0], at(None, 0, DECK + low)[0]
			for x in seams:
				left, right = at(None, x - 0.05, 0)[1], at(None, x + 0.05, 0)[1]
				a, b = colour[r0:r1, left].mean(), colour[r0:r1, right].mean()
				steps.append(abs(a - b) / ((a + b) / 2))
		self.assertGreater(max(steps), 0.008)

	def test_touchups_patch_some_plates(self):
		plain, _ = weather.weather(wall(), dict(GROUP, touchups=0.0), facts())
		patched, _ = weather.weather(wall(), dict(GROUP, touchups=0.5), facts())
		changed = np.abs(patched - plain).sum(-1) > 1e-6
		self.assertGreater(changed.mean(), 0.05)
		self.assertLess(changed.mean(), 0.6)

	def test_streaks_run_down_from_a_sill_only(self):
		window = {"name": "w", "plane": "z=10", "x": [2.0, 4.0], "y": [DECK + 4.5, DECK + 5.5]}
		plain, _ = weather.weather(wall(), GROUP, facts())
		streaked, _ = weather.weather(wall(), GROUP, facts([window]))
		change = np.abs(streaked - plain).sum(-1)
		rows, columns = np.nonzero(change > 1e-6)
		self.assertTrue(len(rows))
		x = columns / SIZE * 6.0
		y = DECK + 6.0 - rows / SIZE * 6.0
		self.assertLessEqual(y.max(), DECK + 4.5 + 0.06)              # nothing above the sill
		self.assertGreaterEqual(x.min(), 2.0 - 0.3)                   # nor beside the window
		self.assertLessEqual(x.max(), 4.0 + 0.3)
		self.assertLess(streaked[change > 1e-6].sum(), plain[change > 1e-6].sum())   # darker where they run

	def test_occlusion_darkens(self):
		ao = np.ones((SIZE, SIZE), np.float32)
		ao[:, : SIZE // 2] = 0.3
		colour, _ = weather.weather(wall(ao), GROUP, facts())
		dark = colour[:, : SIZE // 2].mean()
		light = colour[:, SIZE // 2 :].mean()
		self.assertAlmostEqual(dark / light, (0.3 + 0.7 * 0.3) / 1.0, delta=0.04)

	def test_grime_toward_the_deck(self):
		colour, _ = weather.weather(wall(), GROUP, facts())
		low = colour[at(None, 0, DECK + 0.4)[0] - 2 : at(None, 0, DECK + 0.4)[0] + 2].mean()
		high = colour[at(None, 0, DECK + 4.0)[0] - 2 : at(None, 0, DECK + 4.0)[0] + 2].mean()
		self.assertLess(low, high * 0.96)

	def test_walking_surfaces_darker(self):
		maps = wall()
		up = maps["normal"].copy()
		up[:] = (0.0, 1.0, 0.0)
		maps_up = dict(maps, normal=up)
		upright, _ = weather.weather(maps, GROUP, facts())
		floor, _ = weather.weather(maps_up, GROUP, facts())
		self.assertLess(floor.mean(), upright.mean() * 0.9)

	def test_the_same_every_time(self):
		a = weather.weather(wall(), GROUP, facts())
		b = weather.weather(wall(), GROUP, facts())
		self.assertTrue(np.array_equal(a[0], b[0]) and np.array_equal(a[1], b[1]))

	def test_measured_runs_where_the_photos_put_them(self):
		# a run drawn as measured: below its top for its length, nothing above
		# or beside it, whatever the lot says of the fittings' streaks
		run = {"top": [3.0, DECK + 5.0, 10.05], "length": 1.5, "width": 0.1}
		plain, _ = weather.weather(wall(), GROUP, facts())
		ran, _ = weather.weather(wall(), dict(GROUP, runs=[run]), facts())
		change = np.abs(ran - plain).sum(-1) > 1e-6
		rows, columns = np.nonzero(change)
		x, y = columns / SIZE * 6.0, DECK + 6.0 - rows / SIZE * 6.0
		self.assertGreater(change.sum(), 20)
		self.assertLessEqual(y.max(), DECK + 5.0 + 0.05)
		self.assertGreaterEqual(y.min(), DECK + 5.0 - 1.5 - 0.05)
		self.assertLess(np.abs(x - 3.0).max(), 0.16)
		self.assertLess(ran[change].sum(), plain[change].sum())

	def test_regions_scale_each_faces_streaks(self):
		# a region with no streaks leaves the window's runs out of it; one with
		# heavier streaks darkens them further
		window = {"name": "w", "plane": "z=10", "x": [2.0, 4.0], "y": [DECK + 4.5, DECK + 5.5]}
		plain, _ = weather.weather(wall(), GROUP, facts())
		streaked, _ = weather.weather(wall(), GROUP, facts([window]))
		box = [[0.0, DECK, 9.0], [3.0, DECK + 6.0, 11.0]]
		clean, _ = weather.weather(wall(), dict(GROUP, regions=[{"box": box, "streaks": 0.0}]), facts([window]))
		heavy, _ = weather.weather(wall(), dict(GROUP, regions=[{"box": box, "streaks": 2.0}]), facts([window]))
		left = np.s_[:, : int(3.0 / 6.0 * SIZE) - 1]
		self.assertGreater(np.abs(streaked[left] - plain[left]).sum(), 0)
		self.assertTrue(np.allclose(clean[left], plain[left]))
		self.assertLess(heavy[left].sum(), streaked[left].sum())
		right = np.s_[:, int(3.0 / 6.0 * SIZE) + 1 :]
		self.assertTrue(np.allclose(clean[right], streaked[right]))

	def test_a_group_wears_its_own_paint(self):
		white = [0.7, 0.7, 0.68]
		grey, _ = weather.weather(wall(), GROUP, facts())
		own, _ = weather.weather(wall(), dict(GROUP, grey=white), facts())
		ratio = own.mean(axis=(0, 1)) / grey.mean(axis=(0, 1))
		np.testing.assert_allclose(ratio, np.array(white) / [0.30, 0.32, 0.33], rtol=0.03)
		maps = wall()
		maps["valid"][:10] = False
		outside, _ = weather.weather(maps, dict(GROUP, grey=white), facts())
		self.assertTrue(np.allclose(outside[:10], white))

	def test_no_walking_surfaces_where_the_group_has_none(self):
		maps = wall()
		maps["normal"][:] = (0.0, 1.0, 0.0)
		walked, _ = weather.weather(maps, GROUP, facts())
		kept, _ = weather.weather(maps, dict(GROUP, walk=False), facts())
		self.assertGreater(kept.mean(), walked.mean() / 0.85)

	def test_sources_at_the_lamps_and_the_radomes_seams(self):
		# the island's streaks start at the lamps round its numbers too; the
		# radomes' round each one where it is widest
		cell = {"size": [2.0, 2.0], "shapes": [{"polygon": [[0.5, 0.5], [1.5, 0.5], [1.5, 1.5], [0.5, 1.5]]}],
			"lamps": {"spacing": 0.5, "offset": 0.1, "diameter": 0.16, "depth": 0.15}}
		f = facts()
		f["layout"]["island"]["prisms"] = [{"outline": [[0, 0], [6, 0], [6, 10], [0, 10]], "bottom": DECK, "top": DECK + 6}]
		f["layout"]["lettering"] = {"cells": {"square": cell}, "plates": [{"on": "island", "cell": "square", "plane": "z=10", "x": [2, 4], "y": [DECK + 1, DECK + 3]}]}
		lamps = [s for s in weather.fittings(f, "island") if abs(s[0][2] - 10.03) < 1e-6]
		self.assertEqual(len(lamps), 10)
		f["layout"]["island"]["domes"] = [{"centre": [3, 5], "profile": [[DECK + 6, 1.0], [DECK + 7, 1.5], [DECK + 8, 0.0]]}]
		seams = weather.fittings(f, "domes")
		self.assertEqual(len(seams), int(2 * np.pi * 1.5 / 0.8))
		for (x, y, z), _ in seams:
			self.assertAlmostEqual(y, DECK + 7)
			self.assertAlmostEqual(np.hypot(x - 3, z - 5), 1.52)

	def test_a_deck_of_its_own_non_skid(self):
		# walking surfaces inside a deck's box take its colour, not the grey's
		# darker non-skid; those outside it and the walls keep the grey
		maps = wall()
		maps["normal"][:] = (0.0, 1.0, 0.0)
		tan = [0.30, 0.25, 0.20]
		deck = {"box": [[0.0, DECK, 9.0], [3.0, DECK + 6.0, 11.0]], "colour": tan}
		plain, _ = weather.weather(maps, GROUP, facts())
		decked, _ = weather.weather(maps, dict(GROUP, decks=[deck]), facts())
		left, right = np.s_[:, : int(3.0 / 6.0 * SIZE) - 1], np.s_[:, int(3.0 / 6.0 * SIZE) + 1 :]
		ratio = decked[left].mean(axis=(0, 1)) / plain[left].mean(axis=(0, 1))
		np.testing.assert_allclose(ratio, np.array(tan) / (np.array([0.30, 0.32, 0.33]) * 0.80), rtol=0.05)
		self.assertTrue(np.allclose(decked[right], plain[right]))
		upright, _ = weather.weather(wall(), dict(GROUP, decks=[deck]), facts())
		self.assertTrue(np.allclose(upright, weather.weather(wall(), GROUP, facts())[0]))

	def test_a_dirty_deck(self):
		# the deck's dirt: its tone wandering as asked, darker patches over
		# about their share of it, a grain in its relief; the walls beside it as they were
		maps = wall()
		maps["normal"][:] = (0.0, 1.0, 0.0)
		box = [[0.0, DECK, 9.0], [3.0, DECK + 6.0, 11.0]]
		tan = [0.30, 0.25, 0.20]
		clean = {"box": box, "colour": tan}
		dirty = dict(clean, dirt={"mottle": [[2.0, 0.12]], "patches": {"scale": 0.7, "share": 0.08, "darkening": 0.4}, "grain": 0.08})
		a, ha = weather.weather(maps, dict(GROUP, touchups=0.0, decks=[clean]), facts())
		b, hb = weather.weather(maps, dict(GROUP, touchups=0.0, decks=[dirty]), facts())
		left, right = np.s_[:, : int(3.0 / 6.0 * SIZE) - 1], np.s_[:, int(3.0 / 6.0 * SIZE) + 1 :]
		spread = lambda c: np.std(c[left].mean(-1)) / c[left].mean()
		self.assertGreater(spread(b), spread(a) + 0.08)
		ratio = b[left].mean(-1) / a[left].mean(-1)
		self.assertTrue(0.02 < (ratio < 0.8).mean() < 0.2)   # the patches, about their share
		self.assertGreater(np.std(hb[left]), np.std(ha[left]) * 1.5)   # the grain
		self.assertTrue(np.allclose(a[right], b[right]) and np.allclose(ha[right], hb[right]))

	def test_texels_outside_the_atlas_are_the_grey(self):
		maps = wall()
		maps["valid"][:10] = False
		colour, height = weather.weather(maps, GROUP, facts())
		self.assertTrue(np.allclose(colour[:10], [0.30, 0.32, 0.33]))
		self.assertTrue(np.allclose(height[:10], 0.5))


if __name__ == "__main__":
	unittest.main()
