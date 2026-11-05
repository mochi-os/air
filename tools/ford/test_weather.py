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


def wall(ao=None, base=DECK):
	# The maps of a wall at z 10, x 0-6, y base to base + 6, top row first
	rows, columns = np.mgrid[0:SIZE, 0:SIZE]
	x = columns / SIZE * 6.0
	y = base + 6.0 - rows / SIZE * 6.0
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

	def test_deck_seams_lighter(self):
		# a deck's plates' seams lighter than the non-skid between them, along
		# and across at their spacing from their origin, the rest as it was
		rows, columns = np.mgrid[0:SIZE, 0:SIZE]
		position = np.stack([columns / SIZE * 6.0, np.full((SIZE, SIZE), DECK), rows / SIZE * 6.0], -1).astype(np.float32)
		maps = {"position": position, "normal": np.broadcast_to(np.array([0.0, 1.0, 0.0], np.float32), position.shape).copy(),
			"ao": np.ones((SIZE, SIZE), np.float32), "valid": np.ones((SIZE, SIZE), bool), "texel": np.float32(0.05)}
		box = [[-1.0, DECK - 0.1, -1.0], [7.0, DECK + 0.1, 7.0]]
		plain = {"box": box, "colour": [0.30, 0.25, 0.20], "dirt": {}}
		seamed = dict(plain, dirt={"seams": {"along": 2.0, "across": 1.5, "width": 0.05, "lift": 0.2, "origin": [0.5, 0.25]}})
		a, _ = weather.weather(maps, dict(GROUP, touchups=0.0, decks=[plain]), facts())
		b, _ = weather.weather(maps, dict(GROUP, touchups=0.0, decks=[seamed]), facts())
		ratio = b.mean(-1) / a.mean(-1)
		cell = lambda x, z: (int(round(z / 6.0 * SIZE)), int(round(x / 6.0 * SIZE)))
		self.assertGreater(ratio[cell(2.5, 1.0)], 1.15)    # on a seam fore and aft of the plates (x 0.5, 2.5, 4.5)
		self.assertGreater(ratio[cell(1.5, 3.25)], 1.15)   # and athwart (z 0.25, 1.75, 3.25, 4.75)
		self.assertAlmostEqual(float(ratio[cell(1.5, 1.0)]), 1.0, places=5)   # between them
		self.assertLess((ratio > 1.01).mean(), 0.15)

	def test_wear_by_zone(self):
		# the group's level where no zone says, each zone over the earlier, a
		# box's edges blended over its `soft`, a facing taking only its faces
		group = dict(GROUP, level=0.3, zones=[{"level": 1.0, "box": [[0, 0, 0], [10, 10, 10]], "soft": 2.0},
			{"level": 0.0, "box": [[-50, -50, -50], [50, 50, 50]], "facing": "up"},
			{"level": 0.8, "box": [[-50, -50, -50], [50, 50, 50]], "facing": "under"}])
		p = np.array([[5, 5, 5], [30, 5, 5], [10, 5, 5], [5, 5, 5], [5, 5, 5], [20, 5, 5], [20, 5, 5]], float)
		n = np.array([[0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 1, 0], [0, -1, 0], [0, 0.6, 0.8], [0, -0.6, 0.8]], float)
		level = weather.wear_level(p, n, group)
		self.assertAlmostEqual(level[0], 1.0)    # deep in the box
		self.assertAlmostEqual(level[1], 0.3)    # outside it
		self.assertAlmostEqual(level[2], 0.65)   # on its face, halfway
		self.assertAlmostEqual(level[3], 0.0)    # facing up, the later zone over the box's
		self.assertAlmostEqual(level[4], 0.8)    # facing down
		self.assertAlmostEqual(level[5], 0.3)    # sloping up or down, neither
		self.assertAlmostEqual(level[6], 0.3)

	def spread(self, colour, scale):
		# the log luminance's spread against its own mean over `scale` metres
		lum = np.log(colour @ [0.2126, 0.7152, 0.0722])
		r = max(1, int(scale / 0.05 / 2))
		mean = lum.copy()
		for axis in (0, 1):
			pad = [(0, 0), (0, 0)]
			pad[axis] = (r + 1, r)
			c = np.cumsum(np.pad(mean, pad, mode="edge"), axis=axis)
			mean = (np.take(c, np.arange(2 * r + 1, c.shape[axis]), axis=axis) - np.take(c, np.arange(0, c.shape[axis] - 2 * r - 1), axis=axis)) / (2 * r + 1)
		return float((lum - mean).std())

	def worn(self, wear, level, maps=None, **extra):
		colour, _ = weather.weather(maps or wall(), dict(GROUP, touchups=0.0, level=level, wear=wear, **extra), facts())
		return colour

	def test_the_worn_wall_blotchier(self):
		# the paint's tone wanders the more the more worn, nothing at no wear,
		# its blotches longer up the wall than across it
		wear = {"blotches": [[1.0, 0.05, 2.0], [0.35, 0.03, 3.0]]}
		plain, _ = weather.weather(wall(), dict(GROUP, touchups=0.0), facts())
		clean, half, full = (self.worn(wear, level) for level in (0.0, 0.5, 1.0))
		np.testing.assert_allclose(clean, plain)
		# the spread the wear adds (the plates' own adds to it in quadrature),
		# growing with the level squared
		s0, s5, s1 = (self.spread(c, 1.0) for c in (clean, half, full))
		ratio = (s1 ** 2 - s0 ** 2) / (s5 ** 2 - s0 ** 2)
		self.assertGreater(s5, s0 * 1.2)
		self.assertGreater(ratio, 2.5)
		self.assertLess(ratio, 6.0)
		shade = np.log(full[..., 1] / plain[..., 1])
		up = np.abs(shade[5:] - shade[:-5]).mean()
		across = np.abs(shade[:, 5:] - shade[:, :-5]).mean()
		self.assertLess(up, across * 0.8)

	def test_grime_patches_darker_and_browner(self):
		wear = {"patches": {"scale": 0.8, "share": 0.15, "tint": [0.7, 0.68, 0.6], "stretch": 3.0}}
		plain, worn = self.worn(wear, 0.0), self.worn(wear, 1.0)
		ratio = worn / plain
		# long up and down the wall
		shade = np.log(ratio[..., 1])
		self.assertLess(np.abs(shade[5:] - shade[:-5]).mean(), np.abs(shade[:, 5:] - shade[:, :-5]).mean() * 0.7)
		patched = ratio[..., 1] < 0.97
		self.assertGreater(patched.mean(), 0.02)
		self.assertLess(patched.mean(), 0.4)
		self.assertLess(ratio[..., 2][patched].mean(), ratio[..., 0][patched].mean())   # browner
		self.assertGreater(ratio[..., 1][patched].min(), 0.67)   # no darker than the tint
		np.testing.assert_allclose(self.worn(wear, 0.0), weather.weather(wall(), dict(GROUP, touchups=0.0), facts())[0])

	def test_weeps_run_down_the_walls(self):
		spec = {"spacing": 0.6, "height": 2.0, "share": 0.5, "length": [1.0, 3.0], "width": [0.08, 0.15], "rust": 0.5}
		maps = wall()
		p, n = maps["position"].reshape(-1, 3).astype(float), maps["normal"].reshape(-1, 3).astype(float)
		rust, dirt = weather.weeps(p, n, np.ones(len(p)), spec, 7)
		total = np.maximum(rust, dirt).reshape(SIZE, SIZE)
		self.assertGreater((total > 0.05).mean(), 0.02)
		self.assertLess((total > 0.05).mean(), 0.5)
		self.assertGreater(rust.max(), 0.3)   # some rust,
		self.assertGreater(dirt.max(), 0.3)   # some dirty water,
		self.assertLessEqual(total.max(), 1.0)   # none above its top, where it would be stronger than at it
		# long up and down, narrow across
		self.assertLess(np.abs(total[2:] - total[:-2]).mean(), np.abs(total[:, 2:] - total[:, :-2]).mean() * 0.5)
		# none where nothing is worn, nor on a level face
		self.assertEqual(max(a.max() for a in weather.weeps(p, n, np.zeros(len(p)), spec, 7)), 0.0)
		level = np.tile([0.0, 1.0, 0.0], (len(p), 1))
		self.assertEqual(max(a.max() for a in weather.weeps(p, level, np.ones(len(p)), spec, 7)), 0.0)
		# and as many as the wear says
		some = np.maximum(*weather.weeps(p, n, np.full(len(p), 0.3), spec, 7))
		self.assertLess((some > 0.05).mean(), (total > 0.05).mean() * 0.6)

	def test_weeps_on_the_worn_wall(self):
		# the wall's own weeps, darker and some rust-red, none unworn
		wear = {"weeps": {"spacing": 0.6, "height": 2.0, "share": 0.5, "length": [1.0, 3.0], "width": [0.08, 0.15], "rust": 0.5}}
		plain, worn = self.worn(wear, 0.0), self.worn(wear, 1.0)
		ratio = worn / plain
		self.assertGreater((ratio[..., 1] < 0.95).mean(), 0.01)
		self.assertGreater((ratio[..., 0] / ratio[..., 2]).max(), 1.2)   # rust
		np.testing.assert_allclose(plain, weather.weather(wall(), dict(GROUP, touchups=0.0), facts())[0])

	def test_scum_line_above_the_boot_top(self):
		# a band above the boot top (1 m) darker and greener, none below it or
		# well above
		wear = {"scum": {"height": 0.8, "tint": [0.8, 0.85, 0.7]}}
		maps = wall(base=0.0)
		plain, worn = self.worn(wear, 0.0, wall(base=0.0)), self.worn(wear, 1.0, maps)
		ratio = worn / plain
		row = lambda y: int(round((6.0 - y) / 6.0 * SIZE))
		self.assertLess(ratio[row(1.1), :, 1].mean(), 0.9)
		self.assertGreater(ratio[row(1.1), :, 1].mean(), ratio[row(1.1), :, 0].mean())   # greener
		self.assertAlmostEqual(float(ratio[row(2.5)].mean()), 1.0, places=6)
		self.assertAlmostEqual(float(ratio[row(0.5)].mean()), 1.0, places=6)

	def test_scuffs_through_dark_paint(self):
		# dark paint scuffed lighter in long marks fore and aft, none unworn
		wear = {"scuffs": {"scale": 0.6, "share": 0.1, "lift": [0.05, 0.05, 0.05]}}
		plain, worn = (self.worn(wear, level, grey=[0.02, 0.02, 0.02]) for level in (0.0, 1.0))
		lift = (worn - plain)[..., 1]
		scuffed = lift > 0.005
		self.assertGreater(scuffed.mean(), 0.02)
		self.assertLess(scuffed.mean(), 0.3)
		self.assertLessEqual(lift.max(), 0.05 + 1e-6)
		self.assertLess(np.abs(lift[:, 3:] - lift[:, :-3]).mean(), np.abs(lift[3:] - lift[:-3]).mean() * 0.7)
		np.testing.assert_allclose(plain, weather.weather(wall(), dict(GROUP, touchups=0.0, grey=[0.02, 0.02, 0.02]), facts())[0])

	def test_the_ship_wears_as_photographed(self):
		# the facts' wear on flat walls in each zone, by the photos' own measure
		# (references/research/weather/scripts/measure.py: the log luminance
		# against its gaussian mean over 2 m and 0.5 m, robust): the hull's
		# lower walls at the low end of the 2022-2025 broadsides' 5.4-7.3% and
		# 2.2-3.8%, every other zone cleaner, the island's top and the mast the
		# cleanest
		import json
		real = json.loads((Path(weather.HERE) / "facts.json").read_text())
		groups = {g["material"]: g for g in real["layout"]["weathering"]["groups"]}

		def measured(material, x0, x1, y0, y1, z, scale):
			step = 0.05
			X, Y = np.meshgrid(np.arange(x0, x1, step), np.arange(y1, y0, -step))
			p = np.stack([X.ravel(), Y.ravel(), np.full(X.size, z)], 1)
			n = np.tile([0.0, 0.0, np.sign(z)], (len(p), 1))
			colour, _ = weather.texels(p, n, np.ones(len(p)), step, groups[material], real, [])
			lum = np.log(colour @ [0.2126, 0.7152, 0.0722]).reshape(X.shape)
			sigma = scale / step / 2
			r = int(3 * sigma)
			k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
			k /= k.sum()
			mean = lum
			for axis in (0, 1):
				pad = [(0, 0), (0, 0)]
				pad[axis] = (r, r)
				b = np.pad(mean, pad, mode="reflect")
				mean = sum(k[j] * np.take(b, np.arange(j, j + mean.shape[axis]), axis=axis) for j in range(len(k)))
			res = (lum - mean).ravel()
			return 1.4826 * np.median(np.abs(res - np.median(res)))
		low = measured("hull", -30, 0, 1.5, 5.5, -20, 2.0)
		self.assertGreater(low, 0.050)
		self.assertLess(low, 0.073)
		fine = measured("hull", -30, 0, 1.5, 5.5, -20, 0.5)
		self.assertGreater(fine, 0.018)
		self.assertLess(fine, 0.038)
		flare = measured("hull", -30, 0, 9, 14, -20, 2.0)
		base = measured("island", -90, -82, 19.5, 23, 30, 2.0)
		middle = measured("island", -90, -82, 27, 33, 30, 2.0)
		top = measured("island", -90, -82, 36, 40, 30, 2.0)
		mast = measured("island", -92, -88, 42, 46, 30, 2.0)
		self.assertLess(flare, low * 0.6)
		self.assertLess(base, low)
		self.assertLess(middle, base)
		self.assertLess(top, middle)
		self.assertLess(top, 0.02)
		self.assertLess(mast, top * 1.05)

	def test_transom_rust_where_photographed(self):
		# the facts' runs down the lower transom (x -163.4, facing aft) at the
		# photographed z -13.95, -12.55 and -15.2: rust down each, none between
		import json
		real = json.loads((Path(weather.HERE) / "facts.json").read_text())
		hull = next(g for g in real["layout"]["weathering"]["groups"] if g["material"] == "hull")
		step = 0.05
		Z, Y = np.meshgrid(np.arange(-16.0, -11.0, step), np.arange(6.5, 1.0, -step))
		p = np.stack([np.full(Z.size, -163.4), Y.ravel(), Z.ravel()], 1)
		n = np.tile([-1.0, 0.0, 0.0], (len(p), 1))
		rust, _ = weather.streaks(p, n, [], hull.get("streaks", {}), 1, hull["runs"])
		rust = rust.reshape(Z.shape)
		column = lambda z: int(round((z + 16.0) / step))
		for z in (-13.95, -12.55, -15.2):
			self.assertGreater(rust[:, column(z)].max(), 0.3, z)
		self.assertEqual(rust[:, column(-13.25)].max(), 0.0)
		self.assertEqual(rust[:, column(-11.5)].max(), 0.0)

	def test_lots_a_seed_apart_unrelated(self):
		# the hash's values for keys one step apart in any place, the seed last
		# above all, uncorrelated
		k = np.arange(20000)
		for a, b in ((weather.hashed(k, 3, 90), weather.hashed(k, 3, 96)), (weather.hashed(k, 7), weather.hashed(k, 8)),
				(weather.hashed(k, 1, 2), weather.hashed(k + 1, 1, 2))):
			self.assertLess(abs(np.corrcoef(a, b)[0, 1]), 0.03)
			self.assertLess(abs(a.mean() - 0.5), 0.01)

	def test_texels_outside_the_atlas_are_the_grey(self):
		maps = wall()
		maps["valid"][:10] = False
		colour, height = weather.weather(maps, GROUP, facts())
		self.assertTrue(np.allclose(colour[:10], [0.30, 0.32, 0.33]))
		self.assertTrue(np.allclose(height[:10], 0.5))


if __name__ == "__main__":
	unittest.main()
