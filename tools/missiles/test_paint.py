# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# usage: python3 -I test_paint.py
import math, sys, unittest
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import paint  # noqa: E402

INCH = paint.INCH
R = 3.5


def skin(stations, rolls, radius=R):
	# texels on a cylinder: (station, roll) grids as Blender places (x forward,
	# y port, z up, metres) about a centre of gravity at station 0
	s, r = np.meshgrid(np.asarray(stations, float), np.asarray(rolls, float), indexing="ij")
	where = np.stack([-s * INCH, -radius * np.sin(np.radians(r)) * INCH, radius * np.cos(np.radians(r)) * INCH], -1)
	normal = np.stack([np.zeros_like(s), -np.sin(np.radians(r)), np.cos(np.radians(r))], -1)
	return s, r, where, normal


class PlacesTest(unittest.TestCase):
	def test_station_roll_and_distance(self):
		s, r, where, _ = skin([10.0], [0.0, 90.0, 180.0, 270.0])
		station, roll, off = paint.places(where, 0.0)
		np.testing.assert_allclose(station, 10.0)
		np.testing.assert_allclose(roll, [[0, 90, 180, 270]], atol=1e-9)
		np.testing.assert_allclose(off, R)


class BandTest(unittest.TestCase):
	def test_a_line_thinner_than_a_texel_covers_its_share(self):
		self.assertAlmostEqual(float(paint.band(np.array(0.0), 0.035, 0.07)), 0.5)
		self.assertAlmostEqual(float(paint.band(np.array(0.0), 0.2, 0.05)), 1.0)
		self.assertEqual(float(paint.band(np.array(1.0), 0.035, 0.07)), 0.0)


class DrawTest(unittest.TestCase):
	def test_lettering_fills_its_box(self):
		ink, fill = paint.draw({"station": [0, 4], "arc": [0, 1], "text": ["AIM"], "stretch": True})
		self.assertEqual(ink.shape, (60, 240))
		self.assertGreater(ink.mean(), 0.1)
		self.assertEqual(fill.max(), 0)
		columns = np.nonzero(ink.max(0) > 0.5)[0]
		self.assertLess(columns[0], 5)
		self.assertGreater(columns[-1], 234)

	def test_lettering_read_upward_runs_round_the_body(self):
		ink, _ = paint.rotated({"station": [0, 0.4], "arc": [0, 2], "text": ["LIFT HERE"], "upward": True})
		self.assertEqual(ink.shape, (120, 24))
		rows = np.nonzero(ink.max(1) > 0.5)[0]
		self.assertGreater(rows[-1] - rows[0], 60)
		# up its middle the letters come one after another, not as one squeezed line
		column = ink[:, 12] > 0.5
		self.assertGreaterEqual(int((np.diff(column.astype(int)) == 1).sum()), 5)

	def test_a_label_is_filled_and_bordered(self):
		ink, fill = paint.draw({"station": [0, 2], "arc": [0, 1], "kind": "label", "line": 0.05})
		self.assertEqual(fill.min(), 1.0)
		self.assertEqual(ink[0].min(), 1.0)
		self.assertEqual(ink[30, 60], 0.0)


class SidesTest(unittest.TestCase):
	def test_each_side_reads_upright_with_the_lugs_up(self):
		marking = {"station": [10, 20], "arc": [-1, 1]}
		station = np.array([12.0])
		left, right = paint.sides(marking, station, np.array([270 + math.degrees(0.5 / R)]), np.array([R]))
		self.assertAlmostEqual(float(left[0][0]), 0.2)      # the left reads aft: its start forward
		self.assertAlmostEqual(float(left[1][0]), 0.25)     # half an inch up: a quarter down from the top
		left, right = paint.sides(marking, station, np.array([90 - math.degrees(0.5 / R)]), np.array([R]))
		self.assertAlmostEqual(float(right[0][0]), 0.8)     # the right reads forward: its start aft
		self.assertAlmostEqual(float(right[1][0]), 0.25)


class MarkingsTest(unittest.TestCase):
	layout = {"markings": {"seams": [40.0], "screws": [{"station": 39.5, "count": 12}],
		"stencils": [{"station": [10, 20], "arc": [-0.5, 0.5], "text": ["AIM-120C-7"], "stretch": True}]}}

	def test_the_stencil_is_on_both_sides_and_nowhere_else(self):
		stations = np.linspace(8, 22, 141)
		for roll, inside in ((270, True), (90, True), (0, False), (180, False)):
			s, r, where, _ = skin(stations, [roll])
			ink, *_ = paint.markings(self.layout, s.ravel(), r.ravel(), np.full(s.size, R), np.full(s.size, 0.05))
			within = (s.ravel() > 10.5) & (s.ravel() < 19.5)
			if inside:
				self.assertGreater(ink[within].max(), 0.8, roll)
			else:
				self.assertEqual(ink[within].max(), 0.0, roll)
			self.assertEqual(ink[(s.ravel() < 9.5) | (s.ravel() > 20.5)].max(), 0.0, roll)

	def test_a_seam_rings_the_body_at_its_station(self):
		s, r, *_ = skin([40.0, 41.0], np.arange(0, 360, 7.0))
		ink, *_ = paint.markings(self.layout, s.ravel(), r.ravel(), np.full(s.size, R), np.full(s.size, 0.035))
		ink = ink.reshape(s.shape)
		self.assertGreater(ink[0].min(), 0.5)
		self.assertEqual(ink[1].max(), 0.0)

	def test_a_row_of_screws_has_its_count(self):
		s, r, *_ = skin([39.5], np.arange(0, 360, 0.5))
		ink, *_ = paint.markings(self.layout, s.ravel(), r.ravel(), np.full(s.size, R), np.full(s.size, 0.03))
		heads = np.diff((ink > 0.3).astype(int), append=int(ink[0] > 0.3))
		self.assertEqual(int((heads == 1).sum()), 12)


class EdgesTest(unittest.TestCase):
	outline = [[133.0, 3.5], [133.3, 4.6], [137.7, 9.15], [145.05, 9.15], [144.9, 3.5]]

	def test_the_leading_edge_and_tip_wear_and_the_root_does_not(self):
		d = paint.edges(self.outline, np.array([135.5, 141.0, 139.0, 139.0]), np.array([6.875, 9.15, 6.0, 3.5]))
		self.assertAlmostEqual(float(d[0]), 0.0, 6)   # on the leading edge
		self.assertAlmostEqual(float(d[1]), 0.0, 6)   # on the tip
		self.assertGreater(float(d[2]), 1.0)           # the middle of the fin
		self.assertGreater(float(d[3]), 1.0)           # the root's middle, against the body


class ColourTest(unittest.TestCase):
	layout = {"markings": {"seams": [40.0]}, "lugs": [30.0], "wings": {"outline": [[60, 3.5], [66, 9.5], [70, 9.5], [70, 3.5]]},
		"wear": {"sections": 0.04, "mottle": 0.03, "grain": 0.012, "seams": 0.08, "smudges": 0.06, "scuffs": 0.06, "edges": 0.5, "edge": 0.3, "fade": 0.2, "bare": [150, 152, 156]}}

	def test_plain_paint_stays_in_good_condition(self):
		s, r, where, normal = skin(np.linspace(0, 100, 200), np.arange(0, 360, 5.0))
		albedo = np.full(s.shape + (3,), 0.15)
		out = paint.colour(self.layout, 0.0, albedo, np.ones(s.shape), where, normal, np.full(s.shape, paint.PARTS["body"]), np.full(s.shape, 0.05))
		change = (out[..., 1] / 0.15 - 1)[np.abs(s - 40) > 0.3]   # off the seam, which is a marking
		self.assertLess(np.percentile(np.abs(change), 95), 0.10)   # the photos' paint: 90% of it within -5..+4.4%
		self.assertLess(np.abs(change).max(), 0.22)   # rare peaks, where a crest of the mottle meets a scuff
		self.assertLess(np.abs(change).mean(), 0.05)
		self.assertGreater(np.abs(change).max(), 0.01)   # worn at all

	def body(self, layout, stations, rolls):
		# the body's paint over a (station, roll) grid, as a share of the plain paint
		s, r, where, normal = skin(stations, rolls)
		out = paint.colour(dict(layout, wear=self.layout["wear"]), 0.0, np.full(s.shape + (3,), 0.15), np.ones(s.shape), where, normal,
			np.full(s.shape, paint.PARTS["body"]), np.full(s.shape, 0.03))
		return out[..., 1] / 0.15

	def test_each_section_has_a_shade_of_its_own(self):
		layout = {"markings": {"seams": [40.0, 80.0]}}
		means = [self.body(layout, np.linspace(a, a + 25, 60), np.arange(0, 360, 4.0)).mean() for a in (8, 48, 88)]
		self.assertGreater(max(means) - min(means), 0.02)
		self.assertLess(max(abs(m - 1) for m in means), 0.05)

	def test_the_paint_is_mottled_and_grained_as_the_photos_measure(self):
		# along the body, the cylinder's own shading aside: spread over half an
		# inch to six inches about 2.5%, and finer than half an inch about 1%
		step = 0.03
		rows = self.body({}, np.arange(10, 130, step), np.arange(5, 360, 37.0)).T
		def running(a, inches):
			k = int(round(inches / step))
			return np.array([np.convolve(r, np.ones(k) / k, mode="valid") for r in a]), k
		wide, k6 = running(rows, 6.0)
		half, k5 = running(rows, 0.5)
		cut = (k6 - k5) // 2
		coarse = half[:, cut : cut + wide.shape[1]] / wide - 1
		fine = rows[:, (k5 - 1) // 2 : (k5 - 1) // 2 + half.shape[1]] / half - 1
		self.assertTrue(0.018 < coarse.std() < 0.032, coarse.std())
		self.assertTrue(0.006 < fine.std() < 0.016, fine.std())

	def test_hands_leave_smudges_round_the_lifting_points(self):
		# the smudges alone: the same texels painted with them and without,
		# within two inches of the lifting point (clear of its lettering) and
		# ten inches on
		layout = {"markings": {"stencils": [{"station": [50, 52], "arc": [-0.2, 0.2], "text": ["LIFT HERE"], "stretch": True}]}}
		ring = np.arange(270 - 25, 270 + 25, 1.0)
		def smudged(stations):
			s, r, where, normal = skin(stations, ring)
			out = [paint.colour(dict(layout, wear=dict(self.layout["wear"], smudges=smudges)), 0.0, np.full(s.shape + (3,), 0.15), np.ones(s.shape), where, normal,
				np.full(s.shape, paint.PARTS["body"]), np.full(s.shape, 0.03))[..., 1] for smudges in (0.06, 0.0)]
			return out[0] / out[1] - 1
		near = smudged(np.concatenate([np.linspace(49, 49.8, 20), np.linspace(52.2, 53, 20)]))
		far = smudged(np.concatenate([np.linspace(59, 59.8, 20), np.linspace(62.2, 63, 20)]))
		self.assertLess(near.mean(), -0.008)
		self.assertGreater(near.min(), -0.07)   # faint
		self.assertEqual(np.abs(far).max(), 0.0)

	def test_grime_gathers_by_the_joints(self):
		s, r, where, normal = skin(np.concatenate([np.linspace(40.1, 40.6, 30), np.linspace(45, 55, 30)]), np.arange(0, 360, 3.0))
		out = paint.colour({"markings": {"seams": [40.0]}, "wear": self.layout["wear"]}, 0.0, np.full(s.shape + (3,), 0.15), np.ones(s.shape), where, normal,
			np.full(s.shape, paint.PARTS["body"]), np.full(s.shape, 0.05))[..., 1]
		self.assertLess(out[:30].mean(), out[30:].mean() * 0.98)

	def test_the_wings_wear_lighter_at_their_edges_only(self):
		# the wear is patchy: along the leading edge some of it is worn, an
		# inch and more inside every edge none of it
		def wing(station, span):
			# the wear alone: the same texels painted with the edges' wear and without
			roll = np.full(station.shape, 45.0)
			where = np.stack([-station * INCH, -span * np.sin(np.radians(roll)) * INCH, span * np.cos(np.radians(roll)) * INCH], -1)
			n = station.shape
			out = [paint.colour(dict(self.layout, wear=dict(self.layout["wear"], edges=edges)), 0.0, np.full(n + (3,), 0.15), np.ones(n), where,
				np.tile([0.0, 0.7071, 0.7071], n + (1,)), np.full(n, paint.PARTS["fin"]), np.full(n, 0.05))[:, 1] for edges in (0.5, 0.0)]
			return out[0] - out[1]
		t = np.linspace(0.05, 0.95, 400)
		edge = wing(60 + 6 * t, 3.5 + 6 * t)
		self.assertGreater(edge.max(), 0.02)
		self.assertGreater((edge > 0).mean(), 0.05)
		inner = wing(np.repeat(np.linspace(66.5, 68.5, 20), 20), np.tile(np.linspace(4.5, 8.5, 20), 20))
		self.assertLessEqual(inner.max(), 0.0)

if __name__ == "__main__":
	unittest.main()
