# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# Tests for stacks.py: which faces a little behind others count, how big
# their overlap is, and when the one in front can be seen.
#
# usage: python3 -I test_stacks.py
import sys, unittest
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import stacks  # noqa: E402


def square(x0, x1, y0, y1, z, facing=1):
	# Two triangles in the plane z over x0..x1, y0..y1, facing +z (or -z)
	a, b, c, d = [x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]
	tris = [[a, b, c], [a, c, d]]
	return np.array([t if facing > 0 else t[::-1] for t in tris], float)


def slab(x0, x1, y0, y1, z0, z1):
	# A closed box, its faces wound outward
	out = [square(x0, x1, y0, y1, z1), square(x0, x1, y0, y1, z0, -1)]
	for k, (lo, hi) in enumerate(((x0, x1), (y0, y1))):
		for side, at in ((-1, lo), (1, hi)):
			if k == 0:
				quad = [[at, y0, z0], [at, y1, z0], [at, y1, z1], [at, y0, z1]]
			else:
				quad = [[x0, at, z0], [x1, at, z0], [x1, at, z1], [x0, at, z1]]
			quad = np.array(quad, float)
			n = np.cross(quad[1] - quad[0], quad[2] - quad[1])
			outward = np.zeros(3)
			outward[k] = side
			if n @ outward < 0:
				quad = quad[::-1]
			out.append(np.array([[quad[0], quad[1], quad[2]], [quad[0], quad[2], quad[3]]]))
	return np.concatenate(out)


def model(*parts):
	# parts: (triangles, node, paint)
	tris = np.concatenate([p[0] for p in parts])
	nodes = np.concatenate([[p[1]] * len(p[0]) for p in parts])
	names = np.concatenate([[p[2]] * len(p[0]) for p in parts])
	return tris, nodes, names


def found(parts, sides):
	tris, nodes, names = model(*parts)
	return stacks.failing(tris, names, sides, stacks.stacks(tris, nodes, names, sides))


ONE = {"grey": (False, False), "dark": (False, False)}
BOTH = {"grey": (True, False), "dark": (True, False)}


class StacksTest(unittest.TestCase):
	def test_what_a_size_needs(self):
		# the game's camera: a plate half a metre across needs 4 mm, a door 8
		# m across 0.96 m, as the square of the size
		self.assertAlmostEqual(stacks.needed(0.5), 0.00375, delta=0.0001)
		self.assertAlmostEqual(stacks.needed(8.0), 0.9605, delta=0.001)

	def test_same_way_a_little_behind(self):
		# a door 4 m square 5 cm in front of a wall facing as it does, where
		# it needs 24 cm; half a metre off, it passes
		door, wall = (square(0, 4, 0, 4, 0), "doors", "grey"), (square(-1, 5, -1, 5, -0.05), "hull", "dark")
		places = found([door, wall], ONE)
		self.assertEqual(len(places), 1)
		place = places[0]
		self.assertEqual(place["behind"], ("hull", "dark", "same"))
		self.assertEqual(place["front"], ("doors", "grey"))
		self.assertAlmostEqual(place["gap"], 0.05, places=6)
		self.assertAlmostEqual(place["size"], 4.0, delta=0.6)   # the overlap's span, to the sampling
		self.assertAlmostEqual(place["area"], 16.0, delta=0.5)
		self.assertEqual(found([door, (square(-1, 5, -1, 5, -0.5), "hull", "dark")], ONE), [])

	def test_a_back_counts_when_drawn(self):
		# a plate 2 cm thick: its top with its bottom behind it, facing away;
		# drawn on both sides its bottom's back fights its top
		plate = (slab(0, 3, 0, 3, 0, 0.02), "plates", "grey")
		places = found([plate], BOTH)
		self.assertTrue(places)
		self.assertTrue(all(p["behind"][2] == "back" for p in places))
		self.assertEqual(found([plate], ONE), [])

	def test_far_off_and_a_little_out_of_parallel(self):
		# a plate a metre across 1 cm behind a deck 160 m from the origin,
		# turned a degree out of the deck's plane (along each one's own normal
		# their planes lay 2.8 m apart), and one turned half a CELL'th, its
		# normal on a cell's edge: each found behind it
		deck = (square(159, 162, 17, 20, 9.82), "deck", "grey")
		for turn in (np.tan(np.radians(1.0)), 0.5 / stacks.CELL):
			plate = square(160, 161, 18, 19, 9.81)
			plate[:, :, 2] += turn * (plate[:, :, 0] - 160.5)
			tris, nodes, names = model(deck, (plate, "plates", "dark"))
			places = stacks.stacks(tris, nodes, names, ONE)
			self.assertTrue(places, turn)
			self.assertTrue(all(p["behind"][0] == "plates" and p["front"][0] == "deck" and 0 < p["gap"] < 0.02 for p in places), turn)

	def test_coincident(self):
		# two parts in one plane overlapping: no gap at all
		places = found([(square(0, 2, 0, 2, 0), "a", "grey"), (square(1, 3, 0, 2, 0), "b", "dark")], ONE)
		self.assertTrue(places)
		self.assertTrue(all(p["gap"] < 1e-6 for p in places))

	def test_neighbours_in_a_plane(self):
		# squares side by side in one plane, and a part's own triangles
		self.assertEqual(found([(square(0, 2, 0, 2, 0), "a", "grey"), (square(2, 4, 0, 2, 0), "a", "grey"), (square(0, 2, 2, 4, 0), "b", "grey")], BOTH), [])

	def test_the_overlap_not_the_faces(self):
		# a strip 1.5 m wide behind a 4 m square: the strip's 1.5 needs 3.4 cm
		# (the square's 4 would need 24), so 1 cm fails and 5 passes
		places = found([(square(0, 4, 0, 4, 0), "a", "grey"), (square(0, 4, 1, 2.5, -0.01), "b", "dark")], ONE)
		self.assertEqual(len(places), 1)
		self.assertAlmostEqual(places[0]["size"], 1.5, delta=0.05)
		self.assertEqual(found([(square(0, 4, 0, 4, 0), "a", "grey"), (square(0, 4, 1, 2.5, -0.05), "b", "dark")], ONE), [])

	def test_a_grid_is_as_wide_as_its_strips(self):
		# ribs 0.1 wide every half metre both ways, 2 cm proud of a plate: each
		# strip 5 times its gap, though the grid spans 4 m
		ribs = [square(k * 0.5, k * 0.5 + 0.1, 0, 4.1, 0) for k in range(9)]
		ribs += [square(k * 0.5 + 0.1, (k + 1) * 0.5, m * 0.5, m * 0.5 + 0.1, 0) for k in range(8) for m in range(9)]
		plate = (square(0, 4.1, 0, 4.1, -0.02), "plate", "dark")
		self.assertEqual(found([(np.concatenate(ribs), "ribs", "grey"), plate], ONE), [])
		tris, nodes, names = model((np.concatenate(ribs), "ribs", "grey"), plate)
		places = stacks.stacks(tris, nodes, names, ONE)
		self.assertTrue(places)
		self.assertLess(max(p["size"] for p in places), 0.13)
		self.assertTrue(found([(square(0, 4, 0, 4, 0), "solid", "grey"), plate], ONE))

	def test_hidden_front(self):
		# under a lid a metre over it the stack can't be seen; under glass it can
		stack = [(square(0, 4, 0, 4, 0), "a", "grey"), (square(0, 4, 0, 4, -0.05), "b", "dark")]
		lid = square(-2, 6, -2, 6, 1, -1)
		self.assertEqual(found(stack + [(lid, "lid", "grey")], ONE), [])
		sides = dict(ONE, glass=(True, True))
		self.assertTrue(found(stack + [(lid, "lid", "glass")], sides))

	def test_a_cutout_counts_its_marks(self):
		# a lettered plate 4 m square, 3 cm in front of a wall facing as it
		# does, its paint a cutout drawn only along a stroke 0.16 m wide: the
		# stroke needs a fraction of a millimetre, so it passes; drawn all over,
		# the plate needs 24 cm and fails
		plate, wall = square(0, 4, 0, 4, 0), square(-1, 5, -1, 5, -0.03)
		tris, nodes, names = model((plate, "letters", "mark"), (wall, "island", "grey"))
		uvs = np.full((len(tris), 3, 2), np.nan)
		uvs[:2] = tris[:2, :, :2] / 4   # the plate's u, v its x, y over 4 m
		sides = dict(ONE, mark=(False, True))
		stroke = np.zeros((100, 100))
		stroke[:, :4] = 1.0              # columns 0-3 of 100: x 0 to 0.16
		for alpha, fails in ((stroke, False), (np.ones((100, 100)), True)):
			drawn = stacks.drawer(tris, names, uvs, {"mark": (alpha, 0.5)})
			places = stacks.failing(tris, names, sides, stacks.stacks(tris, nodes, names, sides, drawn=drawn))
			self.assertEqual(bool(places), fails, fails)
		# a clear plate overlaps nothing
		drawn = stacks.drawer(tris, names, uvs, {"mark": (np.zeros((100, 100)), 0.5)})
		self.assertTrue(all(p["size"] == 0 for p in stacks.stacks(tris, nodes, names, sides, drawn=drawn)))

	def test_beyond_the_gap(self):
		tris, nodes, names = model((square(0, 4, 0, 4, 0), "a", "grey"), (square(0, 4, 0, 4, -1.6), "b", "dark"))
		self.assertEqual(stacks.stacks(tris, nodes, names, ONE), [])


if __name__ == "__main__":
	unittest.main()
