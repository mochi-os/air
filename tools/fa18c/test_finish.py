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

	def test_the_wingtip_rails_body_is_dark_between_its_light_ends(self):
		# the LAU-7 (layout.stores.paint tip): its body the measured dark tone,
		# its cap and cone and the adapter inboard of it the stores' grey;
		# the light ends from the rail's own layout, as build.py passes them
		rail = LAYOUT["stores"]["rails"]["tip"]
		length = float(np.linalg.norm(np.subtract(rail["aft"], rail["front"])))
		spec = dict(SPEC, tip=dict(SPEC["tip"], light=[rail["cap"], length - rail["cone"]]))
		frame = {"kind": "tip", "nose": [0.0, 0.0, 0.0], "axis": [-1.0, 0.0, 0.0], "up": [0.0, 0.0, 1.0]}
		def at(station, inboard):
			where = np.array([[[-station * INCH, 0.0, inboard * INCH]]])
			return finish.colour(spec, GREY, np.ones((1, 1)), where, np.ones((1, 1), int), [frame], np.full((1, 1), 0.1))[0, 0]
		body = np.asarray(SPEC["tip"]["body"]) / 255
		for station, inboard, dark in ((length / 2, -2.0, True), (40.0, 2.0, True), (rail["cap"] - 1.0, -2.0, False), (length - rail["cone"] + 1.0, -2.0, False), (length / 2, 4.0, False)):
			c = at(station, inboard)
			if dark:
				np.testing.assert_allclose(c, body, atol=0.03, err_msg=f"{station} in aft, {inboard} in inboard")
			else:
				np.testing.assert_allclose(c, GREY, atol=0.05, err_msg=f"{station} in aft, {inboard} in inboard")


class RailTest(unittest.TestCase):
	# The wingtip LAU-7 (layout.stores.paint tip): even, its body and its
	# light cap, cone and adapter alike free of the paint's mottle and grain
	rail = LAYOUT["stores"]["rails"]["tip"]
	length = float(np.linalg.norm(np.subtract(rail["aft"], rail["front"])))
	frame = {"kind": "tip", "nose": [0.0, 0.0, 0.0], "axis": [-1.0, 0.0, 0.0], "up": [0.0, 0.0, 1.0]}

	def paint(self, points, tip=None):
		spec = dict(SPEC, tip=dict(tip or SPEC["tip"], light=[self.rail["cap"], self.length - self.rail["cone"]]))
		shape = points.shape[:-1]
		return finish.colour(spec, GREY, np.ones(shape), points, np.ones(shape, int), [self.frame], np.full(shape, 0.1))

	def run_(self, stations, across, up):
		# points along a run of stations at one place on its section: `across`
		# toward the jet's right (Blender's -y), `up` along its up (z)
		n = len(stations)
		return np.stack([-np.asarray(stations) * INCH, np.full(n, -across * INCH), np.full(n, up * INCH)], -1)[None]

	def test_every_part_of_it_is_even(self):
		# the body's middle third, the cap ahead of its joint, the cone, and the
		# adapter inboard of the body (up past `inboard`)
		runs = {
			"body": self.run_(np.linspace(self.length / 3, 2 * self.length / 3, 200), 2.1, 0.0),
			"cap": self.run_(np.linspace(0.5, self.rail["cap"] - 0.5, 200), 1.0, 0.0),
			"cone": self.run_(np.linspace(self.length - self.rail["cone"] + 0.5, self.length - 0.5, 200), 0.5, 0.0),
			"adapter": self.run_(np.linspace(self.length / 3, 2 * self.length / 3, 200), 0.0, SPEC["tip"]["inboard"] + 1.0),
		}
		for name, points in runs.items():
			self.assertLess(np.ptp(luminance(self.paint(points))), 0.002, name)
			uneven = luminance(self.paint(points, dict(SPEC["tip"], even=False)))
			self.assertGreater(np.ptp(uneven), 0.004, name)


class LentTest(unittest.TestCase):
	# The airframe atlas's UV islands too narrow to hold a texel centre
	# (finish.closest(), bare(), lent()), on an 8 by 8 atlas whose bottom two
	# rows the bake reached
	strip = np.array([[[2.2, 3.55], [5.8, 3.55], [5.8, 3.9]]])   # 0.35 texels tall, between the centres' rows
	places = np.array([[[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 0.1, 0.0]]])
	normals = np.array([[0.0, 0.0, 1.0]])

	def baked(self):
		normal = np.zeros((8, 8, 3))
		normal[:2] = [0.5, 1.0, 0.5]   # (0, 1, 0) encoded: the bake reached them
		where = np.zeros((8, 8, 3))
		where[:2, :, 0] = np.arange(8) / 7.0
		where[:2, :, 2] = -1.0
		shade = np.zeros((8, 8))
		shade[:2] = np.linspace(0.2, 0.9, 8)
		return {"normal": normal, "where": where, "shade": shade, "nozzle": np.zeros((8, 8), bool), "finish": np.zeros((8, 8), np.int8)}

	own = {"finish": np.array([0]), "nozzle": np.array([0])}

	def shaded(self, places, normals, island, triangle):
		# build.py lend()'s cast stood in for: a shade of each point's height
		# on the jet, its island and its triangle, kept with what it was asked
		self.asked = (places.copy(), normals.copy(), island.copy(), triangle.copy())
		return 0.1 + 0.5 * places[:, 2] + 0.01 * island + 0.001 * triangle

	def test_the_nearest_point_inside_and_beyond_a_triangle(self):
		t = np.array([[0.0, 0.0], [4.0, 0.0], [0.0, 4.0]])
		weights, distance = finish.closest(t, np.array([[1.0, 1.0], [5.0, 0.0], [-1.0, 2.0]]))
		np.testing.assert_allclose(distance, [0.0, 1.0, 1.0])
		np.testing.assert_allclose(weights @ t, [[1.0, 1.0], [4.0, 0.0], [0.0, 2.0]])

	def test_a_strip_between_the_centres_is_bare_and_a_wider_one_is_not(self):
		self.assertTrue(finish.bare(self.strip))
		self.assertFalse(finish.bare(np.array([[[2.2, 3.2], [5.8, 3.2], [5.8, 3.9]]])))

	def test_the_texels_beside_a_bare_strip_take_its_place_and_the_shade_cast_there(self):
		baked = self.baked()
		before = {k: v.copy() for k, v in baked.items()}
		lent = finish.lent([(self.strip, self.places, self.normals, self.own)], baked, self.shaded)
		changed = np.any(baked["normal"] != before["normal"], axis=-1)
		count = int(lent.sum())
		# the texels whose centres lie within 0.75 of the strip, and only they:
		# row 3 (centres 3.5) all along it, row 4 only where its top edge rises;
		# and it answers which texels it lent
		ys, xs = np.mgrid[0:8, 0:8]
		near = (finish.closest(self.strip[0], np.c_[xs.ravel() + 0.5, ys.ravel() + 0.5])[1] <= 0.75).reshape(8, 8)
		np.testing.assert_array_equal(lent, changed)
		np.testing.assert_array_equal(changed, near)
		self.assertTrue(changed[3, 2:6].all() and changed[4, 4:6].all() and not changed[4, 2])
		self.assertFalse(changed[:3].any() or changed[5:].any())
		# each lent its nearest point on the strip, mapped onto the strip's place on the jet, and the strip's normal
		for row, column in zip(*np.nonzero(changed)):
			weights, _ = finish.closest(self.strip[0], np.array([[column + 0.5, row + 0.5]]))
			np.testing.assert_allclose(baked["where"][row, column], weights[0] @ self.places[0])
			np.testing.assert_allclose(baked["normal"][row, column] * 2 - 1, [0.0, 0.0, 1.0])
		# and the shade cast at five points across the strip, facing its way, its island and triangle named
		places, normals, island, triangle = self.asked
		self.assertEqual(len(places), 5 * count)
		np.testing.assert_allclose(places[:, 2], 0.0)
		np.testing.assert_allclose(normals, np.tile([0.0, 0.0, 1.0], (5 * count, 1)))
		np.testing.assert_array_equal(island, 0)
		np.testing.assert_array_equal(triangle, 0)
		np.testing.assert_allclose(baked["shade"][changed], 0.1)

	def test_a_strip_packed_with_no_width_takes_the_mean_across_its_width(self):
		# its corners on one line in the atlas, its far corner a unit above its
		# near ones on the jet: a texel along it a share s of the way takes
		# the shade cast across the triangle there, from the near edge to the
		# far, a mean height of (1 - s) / 2, not the height at whichever edge
		# lay nearest its centre
		flat = np.array([[[2.2, 3.7], [5.8, 3.7], [2.2, 3.7]]])
		places = np.array([[[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]]])
		baked = self.baked()
		self.assertGreater(int(finish.lent([(flat, places, self.normals, self.own)], baked, self.shaded).sum()), 0)
		rows, columns = np.nonzero(np.abs(np.linalg.norm(baked["normal"] * 2 - 1, axis=-1) - 1) < 0.1)
		lent = rows >= 2
		along = np.clip((columns[lent] + 0.5 - 2.2) / 3.6, 0, 1)
		np.testing.assert_allclose(baked["shade"][rows[lent], columns[lent]], 0.1 + 0.5 * (1 - along) / 2, atol=1e-9)

	def test_points_across_a_triangle_run_from_its_longest_edge_to_the_side_opposite(self):
		# a right triangle, its longest edge the hypotenuse from (0, 0) to (4, 2):
		# the point halfway along it, and level with it the right angle's corner
		t = np.array([[0.0, 0.0], [4.0, 2.0], [4.0, 0.0]])
		weights = finish.across(t, np.array([[0.5, 0.5, 0.0]]), count=3)
		uv = weights[0] @ t
		np.testing.assert_allclose(uv[0], [2.0, 1.0])
		np.testing.assert_allclose(np.sum(weights, axis=-1), 1.0)
		# the far point on the side opposite, level with the first along the hypotenuse
		hyp = (t[1] - t[0]) / np.linalg.norm(t[1] - t[0])
		self.assertAlmostEqual((uv[2] - t[0]) @ hyp, (uv[0] - t[0]) @ hyp)
		self.assertTrue(np.isclose(uv[2][1], 0.0) or np.isclose(uv[2][0], 4.0))
		np.testing.assert_allclose(uv[1], (uv[0] + uv[2]) / 2)

	def test_an_island_holding_a_centre_is_not_bare(self):
		# the strip moved down onto the centres' row 3.5
		self.assertFalse(finish.bare(self.strip - [0.0, 0.3]))

	def test_a_strip_keeps_its_own_finish_and_nozzle_mark(self):
		# the bake's texels round it another finish and mark (a door's white
		# inside): the strip's texels keep their own
		baked = self.baked()
		baked["finish"][:] = 3
		before = {k: v.copy() for k, v in baked.items()}
		own = {"finish": np.array([5]), "nozzle": np.array([1])}
		finish.lent([(self.strip, self.places, self.normals, own)], baked, self.shaded)
		changed = np.any(baked["normal"] != before["normal"], axis=-1)
		self.assertTrue(changed.any())
		self.assertTrue((baked["finish"][changed] == 5).all())
		self.assertTrue(baked["nozzle"][changed].all())

	def test_each_texel_is_shaded_on_its_own_island_and_triangle(self):
		# a second island of two triangles, a strip at the atlas's top, its
		# second triangle over the right part, too far from the first for a
		# texel to lie within reach of both: each texel's shade asked with its
		# own island and triangle
		top = np.array([[[0.2, 7.55], [2.8, 7.55], [2.8, 7.9]], [[5.2, 7.55], [7.8, 7.55], [7.8, 7.9]]])
		places = np.array([[[0.0, 0.0, 2.0], [1.0, 0.0, 2.0], [1.0, 0.1, 2.0]], [[1.0, 0.0, 2.0], [2.0, 0.0, 2.0], [2.0, 0.1, 2.0]]])
		own = {"finish": np.array([0, 0]), "nozzle": np.array([0, 0])}
		baked = self.baked()
		finish.lent([(self.strip, self.places, self.normals, self.own), (top, places, np.array([[0.0, 0.0, 1.0]] * 2), own)], baked, self.shaded)
		_, _, island, triangle = self.asked
		rows, columns = np.nonzero(np.abs(np.linalg.norm(baked["normal"] * 2 - 1, axis=-1) - 1) < 0.1)
		upper = rows >= 7
		self.assertTrue(upper.any() and (~upper).any())
		shade = baked["shade"][rows, columns] - 0.1 - 0.5 * baked["where"][rows, columns, 2]
		lent = rows >= 2
		np.testing.assert_allclose(shade[lent & ~upper], 0.0, atol=1e-9)
		np.testing.assert_allclose(shade[upper], np.where(columns[upper] >= 4, 0.011, 0.010), atol=1e-9)
		self.assertEqual(sorted(set(zip(island.tolist(), triangle.tolist()))), [(0, 0), (1, 0), (1, 1)])


class BleedTest(unittest.TestCase):
	# The stores' atlas's gutters (finish.bleed()): an island's paint carried
	# out a texel a pass into the texels no part covers
	def test_the_paint_runs_out_a_texel_a_pass_and_leaves_the_island_as_it_was(self):
		colour = np.full((16, 16, 3), 0.7)
		covered = np.zeros((16, 16), bool)
		covered[6:10, 6:8] = True
		colour[covered] = [0.2, 0.25, 0.3]
		given = colour.copy()
		out, painted = finish.bleed(colour, covered, passes=3)
		ys, xs = np.mgrid[0:16, 0:16]
		steps = np.maximum(np.maximum(6 - ys, ys - 9), 0) + np.maximum(np.maximum(6 - xs, xs - 7), 0)
		np.testing.assert_array_equal(painted, steps <= 3)
		np.testing.assert_allclose(out[painted], np.tile([0.2, 0.25, 0.3], (int(painted.sum()), 1)))
		np.testing.assert_allclose(out[~painted], 0.7)
		np.testing.assert_array_equal(colour, given)

	def test_two_islands_meet_between_them_each_with_its_own_paint(self):
		colour = np.zeros((4, 10, 3))
		covered = np.zeros((4, 10), bool)
		covered[:, 0] = covered[:, 9] = True
		colour[:, 0], colour[:, 9] = 0.2, 0.8
		out, painted = finish.bleed(colour, covered, passes=8)
		self.assertTrue(painted.all())
		np.testing.assert_allclose(out[:, 1:5, 0], 0.2)
		np.testing.assert_allclose(out[:, 5:9, 0], 0.8)


if __name__ == "__main__":
	unittest.main()
