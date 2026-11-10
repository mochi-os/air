# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# usage: python3 -I test_measure.py
import math, sys, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import measure  # noqa: E402


def photo(yaw=0.0, distance=200.0, fins="X", offset=(0.0, 0.0), focal=3000.0, flip=False):
	# An AIM-9M (5 in across, 113 long) photographed through a pinhole: its
	# axis level, turned `yaw` radians out of the image plane, its middle
	# `distance` inches in front of the camera. Pixels are x right, y down.
	c, s = math.cos(yaw), math.sin(yaw)
	sign = -1.0 if flip else 1.0

	def place(station, off):
		# nose at -56.5 in along the axis, stations aft; `off` straight up
		along = (station - 56.5) * sign
		x, y, z = along * c + offset[0], -off + offset[1], distance + along * s
		return [1000 + focal * x / z, 800 + focal * y / z]

	marks = {"nose": place(0, 0), "tail_top": place(113, 2.5), "tail_bottom": place(113, -2.5)}
	for n, station in enumerate((20, 45, 70, 95), 1):
		marks[f"body_top_{n}"] = place(station, 2.5)
		marks[f"body_bottom_{n}"] = place(station, -2.5)
	seen = 7.0 * (math.cos(math.radians(45)) if fins == "X" else 1.0)
	marks["canard_upper_tip_leading"] = place(15, seen)
	marks["wing_upper_tip_trailing"] = place(108, 12.375 * (math.cos(math.radians(45)) if fins == "X" else 1.0))
	return {"missile": "AIM-9M", "fins": fins, "marks": marks}


class MeasureTest(unittest.TestCase):
	def read(self, entry):
		return measure.measure(entry)["bodies"]["-"]

	def test_side_on(self):
		row = self.read(photo())
		self.assertAlmostEqual(row["marks"]["canard_upper_tip_leading"]["station"], 15, places=1)
		self.assertAlmostEqual(row["marks"]["canard_upper_tip_leading"]["off"], 7, delta=0.05)
		self.assertAlmostEqual(row["marks"]["wing_upper_tip_trailing"]["station"], 108, places=1)
		self.assertAlmostEqual(row["length"], 113, places=1)

	def test_seen_at_an_angle(self):
		# 35 deg out of the image plane, close: the stations still read true from
		# the nose, the tail and the widths' slope
		row = self.read(photo(yaw=0.6, distance=160.0))
		self.assertAlmostEqual(row["marks"]["canard_upper_tip_leading"]["station"], 15, delta=0.05)
		self.assertAlmostEqual(row["marks"]["wing_upper_tip_trailing"]["station"], 108, delta=0.05)
		self.assertAlmostEqual(row["marks"]["canard_upper_tip_leading"]["off"], 7, delta=0.05)
		# the width's scale alone misreads the length: the flag that the view is
		# not side-on, so a photo without a tail mark must be
		self.assertGreater(abs(row["length"] - 113), 2)

	def test_width_scale_without_the_tail(self):
		# no tail mark: side-on, the width's scale alone still reads the stations
		entry = photo()
		del entry["marks"]["tail_top"], entry["marks"]["tail_bottom"]
		row = self.read(entry)
		self.assertAlmostEqual(row["marks"]["wing_upper_tip_trailing"]["station"], 108, delta=0.1)

	def test_plus_fins_read_whole(self):
		row = self.read(photo(fins="+"))
		self.assertAlmostEqual(row["marks"]["canard_upper_tip_leading"]["off"], 7, delta=0.05)

	def test_x_fins_unscaled_would_read_short(self):
		# the same pixels said to be a + would read the X's fin at cos 45
		entry = photo(fins="X")
		entry["fins"] = "+"
		row = self.read(entry)
		self.assertAlmostEqual(row["marks"]["canard_upper_tip_leading"]["off"], 7 * math.cos(math.radians(45)), delta=0.05)

	def test_nose_sets_the_direction(self):
		# the axis points nose-ward whichever way the photo lays the missile
		row = self.read(photo(flip=True, yaw=0.3))
		self.assertAlmostEqual(row["marks"]["canard_upper_tip_leading"]["station"], 15, delta=0.05)

	def test_scaled_by_a_launcher_and_anchored(self):
		# no nose or tail: a launcher 110 in long beside the body (4 in above
		# its axis) gives the scale along it, 20 deg off side-on, and a mark of
		# known station sets where the stations start
		entry = photo(yaw=0.35, distance=600.0)
		del entry["marks"]["nose"], entry["marks"]["tail_top"], entry["marks"]["tail_bottom"]
		place = photo(yaw=0.35, distance=600.0)["marks"]
		launcher = photo(yaw=0.35, distance=600.0)
		# the launcher's ends: stations 8 and 118, 4 in above the axis
		import math as m
		c, s = m.cos(0.35), m.sin(0.35)

		def at(station, off):
			along = station - 56.5
			x, y, z = along * c, -off, 600.0 + along * s
			return [1000 + 3000.0 * x / z, 800 + 3000.0 * y / z]

		entry["marks"]["launcher_front"] = at(8, 9.0)
		entry["marks"]["launcher_aft"] = at(118, 9.0)
		entry["scale"] = {"from": "launcher_front", "to": "launcher_aft", "length": 110}
		row = self.read(entry)
		self.assertFalse(row["absolute"])
		self.assertAlmostEqual(row["marks"]["wing_upper_tip_trailing"]["station"] - row["marks"]["canard_upper_tip_leading"]["station"], 93, delta=0.3)
		entry["anchor"] = {"mark": "wing_upper_tip_trailing", "station": 108}
		row = self.read(entry)
		self.assertTrue(row["absolute"])
		self.assertAlmostEqual(row["marks"]["canard_upper_tip_leading"]["station"], 15, delta=0.3)
		# the width's scale alone, 20 deg off side-on, reads the spacing wrong
		del entry["scale"]
		row = self.read(entry)
		self.assertGreater(abs(row["marks"]["wing_upper_tip_trailing"]["station"] - row["marks"]["canard_upper_tip_leading"]["station"] - 93), 2)

	def test_tail_alone_sets_the_stations(self):
		entry = photo()
		del entry["marks"]["nose"]
		row = self.read(entry)
		self.assertTrue(row["absolute"])
		self.assertAlmostEqual(row["marks"]["canard_upper_tip_leading"]["station"], 15, delta=0.1)

	def test_bodies_apart(self):
		# two bodies in one photo, marks suffixed by body, each read on its own axis
		one, two = photo(offset=(0.0, -20.0)), photo(offset=(0.0, 20.0), distance=260.0)
		marks = {f"{k}_a": v for k, v in one["marks"].items()}
		marks.update({f"{k}_b": v for k, v in two["marks"].items()})
		bodies = measure.measure({"missile": "AIM-9M", "fins": "X", "marks": marks})["bodies"]
		self.assertEqual(sorted(bodies), ["a", "b"])
		for body in ("a", "b"):
			self.assertAlmostEqual(bodies[body]["marks"]["canard_upper_tip_leading"]["station"], 15, delta=0.05)

	def test_level_holds_a_section_step_apart_from_perspective(self):
		# square side-on, a middle section 2% wider, pairs only forward of it
		# (a harness cover hides the rest): a fitted slope takes the step for
		# perspective and moves the stations; level reads them true
		entry = photo()
		del entry["marks"]["body_top_4"], entry["marks"]["body_bottom_4"]
		for n in (2, 3):
			for side, sign in (("top", 1), ("bottom", -1)):
				x, y = entry["marks"][f"body_{side}_{n}"]
				entry["marks"][f"body_{side}_{n}"] = [x, y - sign * 0.05 * 3000 / 200]
		self.assertGreater(abs(self.read(entry)["marks"]["canard_upper_tip_leading"]["station"] - 15), 0.5)
		entry["level"] = True
		self.assertAlmostEqual(self.read(entry)["marks"]["canard_upper_tip_leading"]["station"], 15, delta=0.05)
		self.assertAlmostEqual(self.read(entry)["marks"]["wing_upper_tip_trailing"]["station"], 108, delta=0.05)

	def test_a_pin_sets_a_slanted_photos_perspective(self):
		# 34 deg off the side, the middle section 2% wider and the pairs only
		# forward: the widths' slope misreads the perspective; a ring of known
		# station (its top and bottom points' mean on the axis) pins it
		yaw, distance = 0.6, 600.0
		c, s = math.cos(yaw), math.sin(yaw)

		def at(station, off):
			along = station - 56.5
			x, y, z = along * c, -off, distance + along * s
			return [1000 + 3000.0 * x / z, 800 + 3000.0 * y / z]

		entry = photo(yaw=yaw, distance=distance)
		del entry["marks"]["body_top_4"], entry["marks"]["body_bottom_4"]
		for n, station in ((2, 45), (3, 70)):
			entry["marks"][f"body_top_{n}"], entry["marks"][f"body_bottom_{n}"] = at(station, 2.55), at(station, -2.55)
		entry["marks"]["ring_top"], entry["marks"]["ring_bottom"] = at(30, 2.5), at(30, -2.5)
		self.assertGreater(abs(self.read(entry)["marks"]["canard_upper_tip_leading"]["station"] - 15), 0.5)
		entry["pin"] = {"marks": ["ring_top", "ring_bottom"], "station": 30}
		row = self.read(entry)
		self.assertEqual(row["scaled"], "pin")
		self.assertAlmostEqual(row["marks"]["canard_upper_tip_leading"]["station"], 15, delta=0.05)
		self.assertAlmostEqual(row["marks"]["wing_upper_tip_trailing"]["station"], 108, delta=0.05)

	def test_an_oblique_end(self):
		# 46 deg out of the image plane, the tail given only as the aftmost point
		# of the end's outline: moved back to the end's centre, the stations read
		# true; taken as the centre itself, they read short. The width's slope
		# reads phi only as well as perspective allows: 0.7 in short with the
		# camera 160 in away, 0.2 at 600
		yaw, distance, focal = 0.8, 600.0, 3000.0
		c, s = math.cos(yaw), math.sin(yaw)

		def at(station, up=0.0, side=0.0):
			along = station - 56.5
			x, y, z = along * c - side * s, -up, distance + along * s + side * c
			return [1000 + focal * x / z, 800 + focal * y / z]

		entry = photo(yaw=yaw, distance=distance)
		del entry["marks"]["tail_top"], entry["marks"]["tail_bottom"]
		nose, centre = at(0), at(113)
		axis = [centre[0] - nose[0], centre[1] - nose[1]]
		rim = [at(113, 2.5 * math.cos(a), 2.5 * math.sin(a)) for a in (k * math.pi / 180 for k in range(360))]
		entry["marks"]["tail"] = max(rim, key=lambda q: q[0] * axis[0] + q[1] * axis[1])
		row = self.read(entry)
		self.assertTrue(row["absolute"])
		self.assertAlmostEqual(row["marks"]["wing_upper_tip_trailing"]["station"], 108, delta=0.3)
		self.assertAlmostEqual(row["marks"]["canard_upper_tip_leading"]["station"], 15, delta=0.3)
		entry["marks"]["tail_top"] = entry["marks"]["tail_bottom"] = entry["marks"].pop("tail")
		row = self.read(entry)
		self.assertLess(row["marks"]["wing_upper_tip_trailing"]["station"], 107)

	def test_planform_bodies(self):
		# a body named in "planform" reads its fins whole and feeds the medians;
		# another body in the same photo is flagged rolled
		one, two = photo(fins="+", offset=(0.0, -20.0)), photo(fins="+", offset=(0.0, 20.0))
		marks = {f"{k}_a": v for k, v in one["marks"].items()}
		marks.update({f"{k}_b": v for k, v in two["marks"].items()})
		bodies = measure.measure({"missile": "AIM-9M", "fins": "X", "planform": ["a"], "marks": marks})["bodies"]
		self.assertAlmostEqual(bodies["a"]["marks"]["canard_upper_tip_leading"]["off"], 7, delta=0.05)
		self.assertFalse(bodies["a"]["rolled"])
		self.assertTrue(bodies["b"]["rolled"])
		# without the list, an X's fin is scaled back as if seen from the side
		bodies = measure.measure({"missile": "AIM-9M", "fins": "X", "marks": marks})["bodies"]
		self.assertAlmostEqual(bodies["a"]["marks"]["canard_upper_tip_leading"]["off"], 7 / math.cos(math.radians(45)), delta=0.05)
		self.assertFalse(bodies["b"]["rolled"])

	def test_oblique_without_a_length(self):
		# seen 34 deg off the side with no tail: the width's scale reads the
		# stations short, so a photo marked oblique leaves the body out
		entry = photo(yaw=0.6, distance=600.0)
		del entry["marks"]["tail_top"], entry["marks"]["tail_bottom"]
		self.assertLess(self.read(entry)["marks"]["wing_upper_tip_trailing"]["station"], 100)
		entry["oblique"] = True
		self.assertEqual(measure.measure(entry)["bodies"], {})
		# with its tail it is read
		self.assertIn("-", measure.measure(dict(photo(yaw=0.6, distance=600.0), oblique=True))["bodies"])


def wing_photo(near=30.0):
	# The AIM-9M's wing face photographed close and at a slant: the planform
	# (station, off) placed in 3D on a plane turned 50 deg about one axis and
	# 25 about another, `near` inches from the camera, through a pinhole
	import numpy as np
	a, b = math.radians(50), math.radians(25)
	r = np.array([[math.cos(a), 0, math.sin(a)], [0, 1, 0], [-math.sin(a), 0, math.cos(a)]]) @ \
		np.array([[1, 0, 0], [0, math.cos(b), -math.sin(b)], [0, math.sin(b), math.cos(b)]])

	def at(station, off):
		x, y, z = r @ (station - 100.0, off - 7.0, 0.0) + (0.0, 0.0, near)
		return [2000 + 3000 * x / z, 1500 + 3000 * y / z]

	marks = {"wing_root_leading": at(88.0, 2.5), "wing_tip_leading": at(95.7, 12.4), "wing_tip_trailing": at(111.1, 12.4),
		"wing_root_trailing": at(111.1, 2.5), "rolleron_hub": at(109.6, 8.4), "wing_trailing_edge_1": at(111.1, 6.0),
		"wing_tip_edge_1": at(103.0, 12.4)}
	return {"missile": "AIM-9M", "fins": "X", "plane": {"part": "wings"}, "marks": marks}


class PlaneTest(unittest.TestCase):
	def test_reads_a_wing_face_in_perspective(self):
		m = measure.on_plane(wing_photo())
		self.assertAlmostEqual(m["marks"]["rolleron_hub"]["station"], 109.6, delta=0.01)
		self.assertAlmostEqual(m["marks"]["rolleron_hub"]["off"], 8.4, delta=0.01)
		self.assertLess(max(m["edges"].values()), 0.01)

	def test_an_affine_map_would_misread_it(self):
		# three corners and a parallelogram's fourth: the perspective is lost
		import numpy as np
		e = wing_photo()["marks"]
		p = [np.array(e[n]) for n in ("wing_root_leading", "wing_tip_leading", "wing_tip_trailing")]
		q = np.array([[88.0, 2.5], [95.7, 12.4], [111.1, 12.4]])
		m = np.linalg.solve(np.c_[p, np.ones(3)], q)
		s, off = np.r_[e["rolleron_hub"], 1] @ m
		self.assertGreater(math.hypot(s - 109.6, off - 8.4), 0.3)

	def test_a_misplaced_corner_shows_on_the_edges(self):
		entry = wing_photo()
		# about 0.4 in out: four corners fit any quadrilateral exactly, so only the
		# edge marks see it (under 0.01 in placed right)
		entry["marks"]["wing_tip_trailing"][1] += 40
		self.assertGreater(max(measure.on_plane(entry)["edges"].values()), 0.1)

	def test_needs_four_corners(self):
		entry = wing_photo()
		del entry["marks"]["wing_root_leading"]
		with self.assertRaises(ValueError):
			measure.on_plane(entry)


if __name__ == "__main__":
	unittest.main()
