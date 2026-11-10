# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# Tests the stores' paint (finish.py) on texels laid out by hand: a tank's
# skin, its joint rings and its filler cap, on the side the photos show it.
#
# usage: python3 -I test_finish.py
import json, math, sys, unittest
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import finish  # noqa: E402

INCH = 0.0254
LAYOUT = json.loads((HERE / "facts.json").read_text())["layout"]
SPEC = LAYOUT["stores"]["paint"]
GREY = np.array(LAYOUT["paint"]["lower"]) / 255
# a tank flying forward along Blender's x, level: its nose at the origin, its
# axis aft (-x), its up z; Blender's y is the jet's left
TANK = {"kind": "tank", "nose": [0.0, 0.0, 0.0], "axis": [-1.0, 0.0, 0.0], "up": [0.0, 0.0, 1.0]}
RADIUS = 14.5


def skin(stations, turns):
	# points on the tank's skin (metres, Blender's axes) at stations aft of
	# its nose and turns from the top toward the jet's right
	s, t = np.meshgrid(np.asarray(stations, float), np.radians(np.asarray(turns, float)), indexing="ij")
	return np.stack([-s * INCH, -np.sin(t) * RADIUS * INCH, np.cos(t) * RADIUS * INCH], -1)


def paint(where, layout=SPEC, occlusion=1.0, part=1):
	shape = where.shape[:-1]
	return finish.colour(layout, GREY, np.full(shape, occlusion), where, np.full(shape, part), [TANK, dict(TANK, kind="pylon")], np.full(shape, 0.1))


def luminance(c):
	return c @ np.array([0.2126, 0.7152, 0.0722])


class AlongTest(unittest.TestCase):
	def test_stations_run_aft_and_turns_toward_the_right(self):
		where = skin([10.0, 50.0], [0.0, 90.0, -90.0])
		station, turn, radius = finish.along(where.reshape(-1, 3), TANK)
		np.testing.assert_allclose(station, [10, 10, 10, 50, 50, 50], atol=1e-6)
		np.testing.assert_allclose(turn, [0, 90, -90, 0, 90, -90], atol=1e-6)
		np.testing.assert_allclose(radius, RADIUS, atol=1e-6)

	def test_the_right_is_the_jets_right(self):
		# Blender's -y is the jet's right (starboard)
		station, turn, _ = finish.along(np.array([[-0.5, -0.3, 0.0]]), TANK)
		self.assertAlmostEqual(float(turn[0]), 90.0, 6)


class ColourTest(unittest.TestCase):
	def test_plain_paint_is_the_grey_under_its_shading_and_light_wear(self):
		where = skin(np.linspace(20, 60, 80), np.linspace(-150, -60, 60))
		out = paint(where, occlusion=0.5)
		shaded = GREY * (0.4 + 0.6 * 0.5)
		ratio = luminance(out) / luminance(shaded)
		spread = np.abs(ratio - np.median(ratio))
		np.testing.assert_allclose(np.median(out.reshape(-1, 3), 0), shaded * (1 + SPEC["wear"]["parts"] * finish.missile.shade(1)), rtol=0.03)
		self.assertLess(np.percentile(spread, 95), 0.1)
		self.assertGreater(spread.max(), 0.005)   # not flat: the mottle and grain are there

	def test_noise_finer_than_two_texels_fades(self):
		# at the stores' half-inch texels the grain (0.15 in) is gone and the
		# finer mottle (0.6 in) mostly: what is left varies on the scale of inches
		where = skin(np.linspace(20, 60, 80), np.linspace(-150, -60, 60))
		shape = where.shape[:-1]
		coarse = finish.colour(SPEC, GREY, np.ones(shape), where, np.ones(shape, int), [TANK], np.full(shape, 0.5))
		fine = finish.colour(SPEC, GREY, np.ones(shape), where, np.ones(shape, int), [TANK], np.full(shape, 0.05))
		step = lambda c: np.median(np.abs(np.diff(luminance(c), axis=0)))   # neighbour to neighbour, 0.5 in apart
		self.assertLess(step(coarse), 0.5 * step(fine))

	def test_each_part_has_a_shade_of_its_own(self):
		where = skin(np.linspace(20, 60, 40), np.linspace(-150, -60, 30))
		one, two = (np.median(luminance(paint(where, part=p))) for p in (1, 2))
		self.assertGreater(abs(one - two) / one, 0.02)

	def test_the_joints_ring_the_tank_darker_than_beside(self):
		turns = np.linspace(-170, 170, 60)
		for joint in SPEC["tank"]["joints"]:
			on = luminance(paint(skin([joint], turns)))
			beside = luminance(paint(skin([joint + 2.0], turns)))
			self.assertLess(on.mean(), 0.8 * beside.mean(), joint)
			self.assertTrue((on < beside).mean() > 0.9, joint)

	def test_the_filler_cap_is_on_the_tanks_right_in_its_colour(self):
		cap = SPEC["tank"]["cap"]
		lid = np.asarray(cap["colour"]) / 255 * 0.4   # unlit: the shading's floor
		for side, expect in ((1, True), (-1, False)):
			centre = paint(skin([cap["station"]], [side * cap["turn"]]), occlusion=0.0)[0, 0]
			if expect:
				np.testing.assert_allclose(centre, lid, atol=0.03)
			else:
				self.assertGreater(np.abs(centre - lid).max(), 0.05)
		# a ring round it, darker than the paint just outside
		r = cap["ring"] / 2
		ring = luminance(paint(skin([cap["station"] + r], [cap["turn"]])))[0, 0]
		outside = luminance(paint(skin([cap["station"] + r + 1.0], [cap["turn"]])))[0, 0]
		self.assertLess(ring, 0.8 * outside)

	def test_a_pylon_wears_the_paint_alone(self):
		# no layout for the pylons' lines yet: the plain paint, no ring at the tank's joint stations
		joint = SPEC["tank"]["joints"][0]
		on = luminance(paint(skin([joint], np.linspace(-170, 170, 60)), part=2))
		beside = luminance(paint(skin([joint + 2.0], np.linspace(-170, 170, 60)), part=2))
		self.assertGreater(on.mean(), 0.95 * beside.mean())


if __name__ == "__main__":
	unittest.main()
