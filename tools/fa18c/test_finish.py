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
		self.assertFalse(finish.bare(np.array([[[2.2, 2.2], [5.8, 2.2], [5.8, 4.2]]])))   # 0.74 texels across on the mean

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

	def test_a_narrow_strip_is_bare_though_it_holds_a_centre(self):
		# the strip moved down onto the centres' row 3.5: a closed door's crack
		# held a centre here and there, and between them drew the door's paint
		self.assertTrue(finish.bare(self.strip - [0.0, 0.3]))
		# a strip of two triangles 0.35 texels tall, its shared side inside it
		self.assertTrue(finish.bare(np.array([[[0.0, 3.4], [6.0, 3.4], [6.0, 3.75]], [[0.0, 3.4], [6.0, 3.75], [0.0, 3.75]]])))

	def test_a_wide_island_holding_a_centre_is_not_bare(self):
		self.assertFalse(finish.bare(np.array([[[1.0, 1.0], [5.0, 1.0], [5.0, 5.0]], [[1.0, 1.0], [5.0, 5.0], [1.0, 5.0]]])))
		# 0.6 texels tall over a row of centres: its outline the four sides
		# alone, not the side its two triangles share
		self.assertFalse(finish.bare(np.array([[[0.0, 3.2], [6.0, 3.2], [6.0, 3.8]], [[0.0, 3.2], [6.0, 3.8], [0.0, 3.8]]])))

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


class MarkingTest(unittest.TestCase):
	# The markings drawn to MIL-STD-2161C's dimensions, at 10 pixels an inch
	scale = 10

	def test_the_insignia_is_its_circle_high_and_its_bars_a_radius_past_it(self):
		ink = finish.insignia(12, self.scale)
		h, w = ink.shape
		self.assertEqual(h, 120)                               # the 12 in circle
		self.assertEqual(w, round(2 * (2 * 60 + 60 / 8)))      # bars a radius long, an eighth-radius outline
		cy, cx = h // 2, w // 2
		self.assertLess(ink[cy, cx], 0.5)                       # the star, in the paint
		a = math.radians(126)                                   # between two of the star's points
		self.assertGreater(ink[round(cy - 54 * math.sin(a)), round(cx + 54 * math.cos(a))], 0.5)   # the circle
		self.assertLess(ink[cy - 15, cx - 2 * 60 + 10], 0.5)    # the bar's inside, in the paint
		self.assertGreater(ink[cy, cx - 2 * 60 + 10], 0.5)      # its stripe, in the grey
		self.assertLess(ink[2, 2], 0.5)                         # past the bar's outline at a corner

	def test_block_letters_are_six_blocks_high_with_a_block_between(self):
		ink = finish.block_text("NAVY", 12, self.scale)
		self.assertEqual(ink.shape, (120, round((4.5 + 5.5 + 4.5 + 4.5 + 3) * 20)))
		block = 20
		self.assertGreater(ink[60, block // 2], 0.5)                  # N's left stem
		self.assertLess(ink[60, round(4.5 * block + block / 2)], 0.5)  # the gap after N
		self.assertGreater(ink[119, round(5.5 * block + 0.5 * block)], 0.5)   # A's left foot

	def test_the_intake_chevron_is_42_by_21_5_inches_with_its_point_right(self):
		ink = finish.chevron(self.scale)
		self.assertEqual(ink.shape, (215, 420))
		self.assertGreater(ink[107, 415], 0.5)     # the point
		self.assertGreater(ink[3, 2], 0.5)         # the upper arm's open end
		self.assertLess(ink[50, 300], 0.5)         # between the arms, in the paint
		self.assertGreater(ink[107, 50], 0.5)      # the DANGER box

	def test_the_right_sides_chevron_points_left_and_still_reads_left_to_right(self):
		right, left = finish.chevron(self.scale), finish.chevron(self.scale, left=True)
		self.assertEqual(left.shape, right.shape)
		self.assertGreater(left[107, 4], 0.5)      # the point, at the left
		self.assertGreater(left[3, 417], 0.5)      # the upper arm's open end, at the right
		self.assertGreater(left[107, 370], 0.5)    # the DANGER box, at the open end
		# the arms are the other's mirror; the lettering is not, so it reads as written
		shapes, mirrored = finish.chevron(self.scale, text=False), finish.chevron(self.scale, text=False, left=True)
		self.assertLess(np.abs(mirrored - shapes[:, ::-1]).mean(), 0.005)   # a pixel's rasterising on the edges apart
		self.assertGreater(np.abs(left - right[:, ::-1]).sum(), 50)

	def test_cells_find_every_point_near_a_segment_and_none_far(self):
		rng = np.random.default_rng(5)
		points = rng.uniform(-2, 2, (20000, 3))
		cells = finish.Cells(points, 0.1)
		a, b, reach = np.array([-1.0, 0.2, 0.3]), np.array([0.7, -0.4, 0.1]), 0.15
		d = b - a
		t = np.clip((points - a) @ d / (d @ d), 0, 1)
		gap = np.linalg.norm(points - (a + t[:, None] * d), axis=1)
		found = set(cells.near(a, b, reach).tolist())
		self.assertTrue(set(np.flatnonzero(gap < reach).tolist()) <= found)   # none missed
		self.assertLess(len(found), len(points) / 10)                         # and few read
		self.assertEqual(len(cells.near(np.array([5.0, 5, 5]), np.array([6.0, 6, 6]), 0.1)), 0)

	def test_the_hook_marking_is_a_t_20_by_14_inches(self):
		ink = finish.hook_tee(self.scale)
		self.assertEqual(ink.shape, (140, 200))
		self.assertGreater(ink[134, 100], 0.5)     # the stem's foot
		self.assertLess(ink[134, 10], 0.5)         # beside the stem, under the top
		self.assertGreater(ink[60, 10], 0.5)       # the top's corner

	def test_the_hook_marking_takes_the_photos_sizes(self):
		ink = finish.hook_tee(self.scale, bar=(10.3, 3.0), stem=(2.9, 2.9), arrow=False)
		self.assertEqual(ink.shape, (59, 103))
		self.assertGreater(ink[55, 51], 0.5)       # the stem's foot
		self.assertLess(ink[55, 30], 0.5)          # beside the stem, under the top
		self.assertGreater(ink[28, 2], 0.5)        # the top's corner
		self.assertGreater(ink[35:58, 40:63].mean(), 0.9)   # no arrow in the stem

	def test_a_walkway_is_its_outline_and_three_stripes_falling_to_the_right(self):
		ink = finish.walkway((7.7, 9.1), 1.0, 2.1, self.scale)
		h, w = ink.shape
		self.assertEqual((h, w), (91, 77))
		self.assertGreater(ink[2, 38], 0.5)        # the outline's top
		self.assertGreater(ink[45, 2], 0.5)        # its side
		self.assertGreater(ink[45, 38], 0.5)       # the middle stripe through the centre
		# the stripes run from the top left to the bottom right: on the line
		# from the centre down to the right, ink; down to the left, a gap
		self.assertGreater(ink[45 + 20, 38 + 20], 0.5)
		self.assertLess(ink[45 + 7, 38 - 7], 0.5)
		self.assertGreater(ink[45 + int(2.1 * 10 / math.sqrt(2)), 38 - int(2.1 * 10 / math.sqrt(2))], 0.5)   # the next stripe, 2.1 in off
		rising = finish.walkway((7.7, 9.1), 1.0, 2.1, self.scale, falling=False)
		self.assertLess(np.abs(rising - ink[:, ::-1]).mean(), 0.02)        # the other way, the mirror

	def test_a_placard_is_its_box_in_the_grey_with_its_lettering_in_the_paint(self):
		ink = finish.placard(["BEWARE", "OF BLAST"], (8, 4.5), self.scale)
		self.assertEqual(ink.shape, (45, 80))
		self.assertGreater(ink[1, 1], 0.5)
		self.assertLess(ink.min(), 0.5)            # some lettering


def sheet(step=0.25, size=20.0):
	# a flat skin in the x-y plane, points `step` apart
	xs = np.arange(0, size, step)
	x, y = np.meshgrid(xs, xs)
	return np.stack([x.ravel(), y.ravel(), np.zeros(x.size)], 1)


WEAR = {"tone": 0.012, "mottle": 0.005, "grime": {"amount": 0.06, "from": 540, "full": 650, "facing": -0.3}, "exhaust": {"amount": 0.06, "from": 640, "full": 685}}


class WeatheringTest(unittest.TestCase):
	def test_the_paint_steps_across_a_line_and_holds_its_step(self):
		p = sheet(0.25, 60.0)
		up = np.tile([0.0, 0.0, 1.0], (len(p), 1))
		line = np.array([[[30.0, -1, 0], [30.0, 61, 0]]])
		t = finish.tones(p, up, line, [0], 0.012, 24.0)
		middle = np.abs(p[:, 1] - 30) < 10
		near, far = middle & (np.abs(p[:, 0] - 30) > 0.5) & (np.abs(p[:, 0] - 30) < 11), middle & (np.abs(p[:, 0] - 30) > 25)
		left, right = t[near & (p[:, 0] < 30)], t[near & (p[:, 0] > 30)]
		self.assertTrue(np.allclose(left, left[0]) and np.allclose(right, right[0]))     # each side even within half the reach
		self.assertGreater(abs(left[0] - right[0]), 1e-4)
		self.assertAlmostEqual(left[0] - 1, -(right[0] - 1))                               # half the step up, half down
		self.assertAlmostEqual(abs(left[0] - right[0]), abs(float(finish.draw([0], 0.37)[0])) * 0.012 * np.sqrt(2))   # two panels' tones apart
		self.assertTrue(np.allclose(t[far], 1.0))                                          # gone beyond the reach

	def test_a_line_s_steps_spread_as_two_panels_tones_differ(self):
		steps = finish.draw(np.arange(4000), 0.37) * 0.012 * np.sqrt(2)
		self.assertAlmostEqual(float(np.std(steps)) / np.sqrt(2), 0.012, delta=0.001)
		self.assertTrue((finish.draw(np.arange(4000), 0.37) == finish.draw(np.arange(4000), 0.37)).all())   # the same each build

	def test_past_a_line_s_end_its_step_eases_out(self):
		p = sheet(0.25, 60.0)
		up = np.tile([0.0, 0.0, 1.0], (len(p), 1))
		line = np.array([[[30.0, -1, 0], [30.0, 30, 0]]])       # ends half way up the sheet
		t = finish.tones(p, up, line, [0], 0.012, 24.0)
		across = lambda y: abs(float(t[(np.abs(p[:, 1] - y) < 0.2) & (np.abs(p[:, 0] - 28) < 0.2)].mean() - t[(np.abs(p[:, 1] - y) < 0.2) & (np.abs(p[:, 0] - 32) < 0.2)].mean()))
		self.assertGreater(across(20), 1e-4)
		self.assertLess(across(34), across(20))                   # spreading past the end
		self.assertLess(across(43), 0.05 * across(20))            # and gone by half the reach
		# nothing jumps beyond the end: neighbouring points a quarter inch apart
		beyond = (p[:, 1] > 31) & (np.abs(p[:, 0] - 30) < 2)
		row = lambda y: t[(np.abs(p[:, 1] - y) < 0.1) & (np.abs(p[:, 0] - 30) < 2)]
		self.assertLess(float(np.abs(np.diff(row(33.0))).max()), 0.25 * across(20))
		self.assertTrue(beyond.any())

	def test_a_door_s_closed_outline_is_one_line(self):
		square = np.array([[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]], float)
		segments = np.array([[square[i], square[(i + 1) % 4]] for i in range(4)] + [[[20, 0, 0], [30, 0, 0]]])
		joins = finish.joined(segments)
		self.assertEqual(len(set(joins[:4].tolist())), 1)
		self.assertNotEqual(joins[4], joins[0])
		p = sheet(0.25, 20.0)
		up = np.tile([0.0, 0.0, 1.0], (len(p), 1))
		t = finish.tones(p, up, segments[:4], joins[:4], 0.012, 24.0)
		inside = (p[:, 0] > 1) & (p[:, 0] < 9) & (p[:, 1] > 1) & (p[:, 1] < 9)
		outside = (p[:, 0] > 11) & (p[:, 0] < 15) & (p[:, 1] > 3) & (p[:, 1] < 7)
		self.assertTrue(np.allclose(t[inside], t[inside][0]))     # the door one tone
		self.assertGreater(abs(float(t[inside][0] - t[outside].mean())), 1e-4)

	def test_a_door_s_edges_any_way_round_step_its_inside_alike(self):
		# a door's outline comes as mesh edges, each its own way round: its
		# inside one tone whatever their directions, stepped by half its draw,
		# the outside the other half, the same way whichever way the edges came
		# (the loop turned by its frame alone: anticlockwise about +z here, so
		# up seen from +z and down seen from -z)
		square = np.array([[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]], float)
		given = np.array([[square[i], square[(i + 1) % 4]] for i in range(4)])
		mixed = given.copy()
		mixed[[1, 3]] = mixed[[1, 3], ::-1]
		p = sheet(0.25, 20.0)
		inside = (p[:, 0] > 1) & (p[:, 0] < 9) & (p[:, 1] > 1) & (p[:, 1] < 9)
		outside = (p[:, 0] > 11) & (p[:, 0] < 15) & (p[:, 1] > 3) & (p[:, 1] < 7)
		key = 7 if finish.draw([7], 0.37)[0] > 0 else 8
		step = float(finish.draw([key], 0.37)[0]) * 0.012 * np.sqrt(2)
		for normal in (1.0, -1.0):
			up = np.tile([0.0, 0.0, normal], (len(p), 1))
			for segments in (given, mixed, given[:, ::-1]):
				t = finish.tones(p, up, segments, [key] * 4, 0.012, 24.0)
				self.assertTrue(np.allclose(t[inside], t[inside][0]))          # one tone inside
				self.assertAlmostEqual(float(t[inside][0]), 1 + normal * step / 2)   # half the step
				self.assertTrue(np.allclose(t[outside], 1 - normal * step / 2))     # the other half outside

	def test_a_line_and_its_mirror_image_draw_unrelated_steps(self):
		# keys a fixed count apart (a line and its mirror image after every
		# mirrored line) drew nearly the same step from a multiplicative hash
		d = finish.draw(np.arange(4000), 0.37)
		for apart in (1, 12, 433, 1000):
			self.assertLess(abs(float(np.corrcoef(d[:-apart], d[apart:])[0, 1])), 0.06)
		self.assertGreater(finish.named("gear_nose_door_left"), 999999)
		self.assertEqual(finish.named("gear_nose_door_left"), finish.named("gear_nose_door_left"))
		self.assertNotEqual(finish.named("gear_nose_door_left"), finish.named("gear_nose_door_right"))

	def test_grime_lies_under_the_aft_fuselage_only(self):
		p = sheet(0.5, 40.0)
		tone = np.full(len(p), 1.01)
		up = np.full(len(p), -1.0)
		forward = finish.weathering(p, np.full(len(p), 400.0), up, tone, dict(WEAR, mottle=0.0))
		aft = finish.weathering(p, np.full(len(p), 660.0), up, tone, dict(WEAR, mottle=0.0, exhaust=dict(WEAR["exhaust"], amount=0.0)))
		upper = finish.weathering(p, np.full(len(p), 660.0), -up, tone, dict(WEAR, mottle=0.0, exhaust=dict(WEAR["exhaust"], amount=0.0)))
		self.assertTrue(np.allclose(forward, tone))                       # nothing ahead of the grime's start
		self.assertLess(float(np.min(aft / tone)), 1 - 0.5 * WEAR["grime"]["amount"])   # streaks under the aft fuselage
		self.assertGreater(float(np.mean(aft / tone)), 1 - WEAR["grime"]["amount"])     # but not all of it dark
		self.assertTrue(np.allclose(upper, tone))                         # none on skin facing up

	def test_the_exhaust_stains_darker_towards_the_nozzles(self):
		p = sheet(0.5, 20.0)
		up = np.ones(len(p))
		w = dict(WEAR, mottle=0.0)
		means = [float(np.mean(finish.weathering(p, np.full(len(p), s), up, np.ones(len(p)), w))) for s in (600.0, 660.0, 690.0)]
		self.assertEqual(means[0], 1.0)
		self.assertLess(means[2], means[1])
		self.assertLess(means[1], 1.0)
		self.assertGreater(means[2], 1 - WEAR["exhaust"]["amount"])


if __name__ == "__main__":
	unittest.main()
