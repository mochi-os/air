# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# Tests for sides.py: which faces are seen from behind, cast with numpy on
# small models.
#
# usage: python3 -I test_sides.py
import sys, unittest
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import sides  # noqa: E402
from test_stacks import slab, square  # noqa: E402

ONE = {"grey": (False, False), "room": (False, False)}


def inside_out(tris):
	return tris[:, ::-1]


def bad(parts, paints=ONE):
	tris = np.concatenate([p[0] for p in parts])
	names = np.concatenate([[p[1]] * len(p[0]) for p in parts])
	found, _ = sides.failing(tris, names, paints)
	return found, tris


class SidesTest(unittest.TestCase):
	def test_a_box_wound_out(self):
		self.assertEqual(bad([(slab(0, 2, 0, 2, 0, 1), "grey")])[0], [])

	def test_a_box_inside_out(self):
		# every face's back is what is seen, and none of its fronts
		found, tris = bad([(inside_out(slab(0, 2, 0, 2, 0, 1)), "grey")])
		self.assertEqual(len(found), len(tris))
		self.assertTrue(all(ahead == 0 for _, _, ahead in found))

	def test_a_sheet(self):
		# a single face is seen from behind, unless its paint is drawn both sides
		self.assertEqual(len(bad([(square(0, 2, 0, 2, 0), "grey")])[0]), 2)
		self.assertEqual(bad([(square(0, 2, 0, 2, 0), "pane")], dict(ONE, pane=(True, True)))[0], [])

	def test_a_cutout(self):
		# a sheet in a see-through paint drawn on one side (a painted mark, clear
		# but for its letters) shows what lies past it from behind, as paint does
		self.assertEqual(bad([(square(0, 2, 0, 2, 0), "mark")], dict(ONE, mark=(False, True)))[0], [])

	def test_a_crack(self):
		# a box with its top left off: its walls' backs show through the gap
		box = slab(0, 2, 0, 2, 0, 1)
		top = np.all(np.abs(box[:, :, 2] - 1) < 1e-9, axis=1)
		found, tris = bad([(box[~top], "grey")])
		self.assertTrue(found)
		self.assertTrue(all(tris[i][:, 2].min() < 1 - 1e-9 for i, _, _ in found))

	def test_a_sheet_of_two_faces(self):
		# a floor with its underside in the same plane facing down: each
		# covers the other's back
		floor = square(0, 2, 0, 2, 0)
		self.assertEqual(bad([(floor, "grey"), (square(0, 2, 0, 2, 0, -1), "grey")])[0], [])
		# and an underside a millimetre and a half under it (the hull's run
		# under a sponson's bottom), as it lies in the floor's plane
		self.assertEqual(bad([(floor, "grey"), (square(0, 2, 0, 2, -0.0015, -1), "grey")])[0], [])
		# and far from the origin, the floor 2 mm out of level over its 5 m (the
		# hull's top under a sponson's bottom 160 m aft): measured along each
		# one's own normal their planes lay 7 mm apart
		level = square(150, 155, 16, 21, 9.82, -1)
		tilted = square(150, 155, 16, 21, 9.82)
		tilted[:, :, 2] -= 0.002 * (tilted[:, :, 1] - 16) / 5
		self.assertEqual(bad([(tilted, "grey"), (level, "grey")])[0], [])
		# half an underside covers half the floor
		found, tris = bad([(floor, "grey"), (square(0, 1, 0, 2, 0, -1), "grey")])
		self.assertTrue(found)
		self.assertTrue(all(tris[i][:, 0].max() > 1 + 1e-9 for i, _, _ in found))

	def test_a_room_through_glass(self):
		# a room hollowed out of a block, glazed over its top: its walls wound
		# to face into it pass; wound as a solid's, their backs show through
		# the glass
		top = lambda t: np.all(np.abs(t[:, :, 2] - 2) < 1e-9, axis=1)
		block = slab(-1, 3, -1, 3, -1, 2)
		room = slab(0, 2, 0, 2, 0, 2)
		rim = np.concatenate([square(-1, 3, -1, 0, 2), square(-1, 3, 2, 3, 2), square(-1, 0, 0, 2, 2), square(2, 3, 0, 2, 2)])
		paints = dict(ONE, pane=(True, True))
		solid = [(block[~top(block)], "grey"), (rim, "grey"), (square(0, 2, 0, 2, 2), "pane")]
		self.assertEqual(bad(solid + [(inside_out(room[~top(room)]), "room")], paints)[0], [])
		found, tris = bad(solid + [(room[~top(room)], "room")], paints)
		self.assertTrue(found)
		self.assertTrue(all(i >= len(block[~top(block)]) + len(rim) for i, _, _ in found))


if __name__ == "__main__":
	unittest.main()
