# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# Tests for build.py: the frame, the joints' signs, the deck's paint mapping
# and the ship file, on a small deck built in Blender; and the provenance rule.
#
# usage: systemd-run --user --collect --wait --pipe --quiet --slice=probe.slice -p MemoryMax=6G -p MemorySwapMax=0 python3 -I /home/alistair/mochi/apps/air/tools/ford/test_build.py
import io, json, re, subprocess, sys, tempfile, unittest
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "verify"))
from model import Model, pose  # noqa: E402

# A deck lopsided on purpose, so a flipped axis shows: it reaches 40 m to port
# and 30 m to starboard, with a notch for one starboard elevator
DECK = {"height": 19.0, "thickness": 0.6,
	"outline": [[-100, -40], [100, -40], [100, 30], [20, 30], [20, 20], [0, 20], [0, 30], [-100, 30]],
	"texture": {"x": [-110, 110], "z": [-45, 35], "pixels": [220, 80]},
	"marks": {"bow_port": [100, -40]},
	# rounding down 0.6 m to its aft edge over 3 m, the edge plate's foot to 17.8
	"round": {"edge": [[-100, -40], [-100, 30]], "length": 3.0, "drop": 0.6, "fascia": 17.8, "steps": 6}}
LAYOUT = {
	"deck": DECK,
	"elevators": [{"number": 1, "side": 1, "outline": [[0, 20], [20, 20], [20, 30], [0, 30]], "thickness": 0.9, "travel": 8.0}],
	# a catapult on the bow, angled 5 degrees to port
	"catapults": [{"number": 1, "track": [[0, -10], [90, -10 - 90 * np.tan(np.radians(5))]], "battery": [10, -10.875], "stroke": 90.0,
		# its hinge skewed 0.5 m forward at the starboard end, square to neither track nor ship
		"deflector": {"hinge": [[5, -15.44], [5.5, -5.44]], "depth": 5}}],
	"consoles": [{"name": "bow", "centre": [12, -2]}],
	# a landing line angled to port, one wire with its sheaves and a support,
	# a barricade stanchion lying aft from its head
	"landing": {"line": [[-90, 0], [10, -10]], "wires": [{"number": 1, "x": 30, "ends": [[-62, 19.08, -16], [-58, 19.08, 12]]}], "target": 1,
		"sheaves": [{"name": "wire_1_port", "centre": [-62, -16.5]}, {"name": "wire_1_starboard", "centre": [-58, 12.5]}],
		"supports": [{"wire": 1, "number": 1, "centre": [-61, -9]}],
		"barricade": {"stanchions": [{"side": "port", "hinge": [-50, -30], "tip": [-58, -31]}]}},
	# a whip that lowers aft and to port, and a fixed mast
	"antennas": [{"name": "port_aft", "base": [-70, -39], "length": 6, "lowered": [-0.8, -0.6], "mount": [0.6, 0.7, 0.6]},
		# a square mast with a box on its outboard side
		{"name": "starboard_forward", "base": [80, 25], "length": 12, "width": 0.6,
			"details": [{"name": "box", "kind": "box", "centre": [80, 28, 25.5], "size": [0.4, 0.4, 0.4]}]}],
	"fittings": {"shuttle": {"length": 1.2, "width": 0.4, "height": 0.25, "top": 0.5},
		"deflector": {"thickness": 0.3, "angle": 50},
		"console": {"length": 3, "width": 2, "height": 1.5},
		"sheave": {"diameter": 1.0, "height": 0.16, "colour": [242, 242, 236]},
		"support": {"length": 1.45, "pad": 0.28, "width": 0.1, "height": 0.08},
		"stanchion": {"width": 1.0, "head": 1.8, "thickness": 0.15},
		"antenna": {"radius": 0.06}},
	"paint": {"deck": [60, 60, 60]},
	"markings": [],
	# the lens and the lights, which the engine draws from the ship file
	"lens": {"position": [-30, 19.6, -38], "facing": [-1, 0, 0], "cells": 12, "pitch": 0.165,
		"lights": {"datum": [[-30, 19.6, -40], [-30, 19.6, -36]], "cut": [[-30, 20.1, -38.5]], "waveoff": [[-30, 19.9, -39]]}},
	"lights": {"centreline": {"positions": [[-90, 19.0, -10], [-80, 19.0, -10]], "colour": "white", "kind": "recovery"}},
	# an island: a block whose sides lean in, a radome on its plinth, a mast
	"island": {"prisms": [{"name": "block", "bottom": 19.0, "top": 31.0, "outline": [[-20, 20], [-5, 20], [-5, 28], [-20, 28]],
		"upper": [[-19, 21], [-6, 21], [-6, 27], [-19, 27]]}],
		"domes": [{"name": "radar", "centre": [-12, 33.0, 24], "radius": 1.5, "plinth": 2.0},
			# an acorn turned on the roof: a drum, a collar, a frustum widening to a cap
			{"name": "acorn", "centre": [-16, 22], "profile": [[31.0, 0.6], [32.0, 0.6], [32.0, 0.8], [33.0, 1.0], [33.6, 0.7], [33.9, 0.0]], "radome": 32.01}],
		"poles": [{"name": "mast", "base": [-12, 24], "bottom": 31.0, "top": 45.0, "radius": 0.5}],
		# a window on its forward face and a radar face on its port face
		"windows": [{"name": "bridge", "plane": "x=-5", "z": [21, 27], "y": [28, 29]},
			# and one a glazed level's panes replace
			{"name": "cabin_port", "plane": "z=20.4", "x": [-15, -9], "y": [23, 24], "cab": "cabin"}],
		# a level glazed port and starboard, seen through
		"cabs": [{"name": "cabin", "sill": 23.0, "head": 24.0, "floor": 22.0, "room": [[-14, 21.2], [-10, 21.2], [-10, 26.8], [-14, 26.8]],
			"openings": [{"from": [-15, 20.4], "to": [-9, 20.4], "conduit": 0.3, "wipers": True}, {"from": [-15, 27.6], "to": [-9, 27.6]}]}],
		"panels": [{"name": "radar", "plane": "z=20", "x": [-16, -12], "y": [24, 27]},
			# and a thicker cover on the forward face
			{"name": "cover", "plane": "x=-5", "z": [24.5, 26.5], "y": [24, 25], "thickness": 0.1}],
		# a railing round the roof's port edge, a dish facing aft, a brace and a box
		"details": [{"name": "rail", "kind": "railing", "path": [[-20, 31.0, 20], [-5, 31.0, 20]], "height": 1.0},
			{"name": "dish", "kind": "dish", "centre": [-20.5, 25, 24], "diameter": 1.0, "facing": [-1, 0, 0]},
			{"name": "brace", "kind": "cylinder", "base": [-12, 31, 24], "end": [-12, 29, 27], "radius": 0.2},
			{"name": "box", "kind": "box", "centre": [-12, 40, 24], "size": [2, 0.5, 3]},
			# a pipe with a bend, a ladder, a stair and a slab on the forward face
			{"name": "pipe", "kind": "path", "round": True, "size": 0.1, "path": [[-6, 20, 28.5], [-6, 25, 28.5], [-8, 25, 28.5]]},
			{"name": "ladder", "kind": "ladder", "bottom": [-19, 19.0, 28.5], "top": 22.0, "along": [1, 0], "width": 0.5},
			{"name": "stair", "kind": "stair", "bottom": [-20, 25.0, 29.5], "top": [-14, 29.0, 29.5], "width": 1.0},
			{"name": "rim", "kind": "plate", "corners": [[-4.5, 22, 22], [-4.5, 22, 24], [-4.5, 23, 24], [-4.5, 23, 22]], "outward": [1, 0, 0], "thickness": 0.2}]},
	# a number on each long face of the island, from one cell of a two-cell atlas
	"lettering": {"pixels": [64, 32], "font": "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "background": [149, 153, 156],
		"colour": [236, 236, 230], "outline": [40, 42, 44], "cutout": True, "cells": {"number": {"text": "78", "box": [32, 0, 64, 32]},
			# a square with a square hole, lamps round both, on the forward face
			"square": {"box": [0, 0, 32, 32], "size": [2.0, 2.0], "shapes": [{"polygon": [[0.5, 0.5], [1.5, 0.5], [1.5, 1.5], [0.5, 1.5]],
				"holes": [[[0.8, 0.8], [1.2, 0.8], [1.2, 1.2], [0.8, 1.2]]], "fill": [236, 236, 230], "offset": [0.1, 0.1]}],
				"lamps": {"spacing": 0.5, "offset": 0.1, "diameter": 0.16, "depth": 0.15}}},
		"plates": [{"name": "island_port", "on": "island", "cell": "number", "plane": "z=20", "x": [-12, -8], "y": [21, 23]},
			{"name": "island_starboard", "on": "island", "cell": "number", "plane": "z=28", "x": [-12, -8], "y": [21, 23]},
			{"name": "lit", "on": "island", "cell": "square", "plane": "x=-4", "z": [21, 23], "y": [20, 22]}],
		# a draught mark either side of the stem, half a metre up
		"draught": {"height": 0.3, "width": 0.2, "aft": 1.0, "numerals": [{"cell": "number", "text": "8", "bottom": 0.5}]}},
	# a sponson under the port quarter with a Phalanx on it, an opening in the
	# starboard side, a catwalk with its net and a rack of rafts
	"sponsons": [{"name": "quarter", "outline": [[-90, -12], [-90, -20], [-80, -20], [-80, -12]], "bottom": 8.0, "top": 12.0},
		# one whose top rises forward and whose bottom falls outboard
		{"name": "sloped", "outline": [[-70, -30], [-70, -36], [-60, -36], [-60, -30]], "bottom": [9.5, 9.0, 9.0, 9.5], "top": [14.0, 14.0, 15.0, 15.0]}],
	# a gun tub on the starboard edge: its floor at 16, its outline from the
	# inboard aft corner round to the inboard forward one, a knee down to 14
	"tubs": [{"name": "tub", "outline": [[-70, 30], [-70, 33], [-66, 33], [-66, 30]], "floor": 16.0, "railing": 1.1, "knee": {"x": -69.9, "foot": 14.0}}],
	# a flare below the quarter sponson, a metre deep
	"wedges": [{"name": "flare", "x": [-89, -88], "section": [[-12, 6], [-16, 8], [-12, 8]]}],
	# a Phalanx trained to starboard, its barrels along its line of fire
	"weapons": {"kinds": {"phalanx": {"parts": [{"name": "base", "kind": "cylinder", "base": [0, 0, 0], "axis": [0, 1, 0], "length": 0.6, "radius": 0.8},
		{"name": "radome", "kind": "cylinder", "base": [0, 1.68, 0], "axis": [0, 1, 0], "length": 1.4, "radius": 0.5, "paint": "radome"},
		{"name": "radome_top", "kind": "dome", "centre": [0, 3.08, 0], "radius": 0.5, "paint": "radome"},
		{"name": "barrels", "kind": "cylinder", "base": [0.2, 1.25, 0], "axis": [1, 0, 0], "length": 2.0, "radius": 0.17}]}},
		# and one elevated 30 degrees, facing forward, on a pedestal a metre tall
		"mounts": [{"kind": "phalanx", "place": "quarter", "foot": [-85, 12.0, -16], "train": 90},
			{"kind": "phalanx", "place": "raised", "foot": [-75, 10.0, -16], "train": 0, "elevation": 30, "pedestal": 1.0}]},
	"openings": [{"name": "hangar", "plane": "z=16.2", "x": [0, 20], "y": [5, 10]}],
	# a port catwalk from x -50 to -30 with a net outboard of it, but for a
	# platform off it at x -36 to -34; and a net across the bow
	"catwalks": {"floor": 17.5, "railing": 1.0, "posts": 1.5, "toe": 0.1, "knees": {"spacing": 2.0, "depth": 0.8},
		"net": {"width": 1.5, "rise": 0.4, "frames": 2.5, "sag": 0.2},
		"runs": [{"side": "port", "x": [-50, -30], "width": 1.5, "net": True}],
		"platforms": [{"side": "port", "x": [-36, -34], "width": 2.0}],
		"nets": [{"side": "bow", "from": [100, -40], "to": [100, 30]}, {"side": "stern", "from": [-93, -10], "to": [-93, 10], "floor": 14.0}]},
	# three racks of two canisters on the starboard edge, a row of small ones on the port catwalk
	"racks": {"canister": {"length": 1.5, "diameter": 0.8}, "small": {"length": 0.8, "diameter": 0.5}, "tiers": [[17.0, 17.9], [18.0, 18.9]],
		"groups": [{"side": "starboard", "x": [-60, -55], "count": 3, "z": [31.0, 32.5]}],
		"rows": [{"side": "port", "x": [-44, -42], "z": [-41.2, -40.6]}]},
	# a dome on a platform 1 m off the starboard edge, which is carried in to the edge
	"domes_edge": [{"centre": [-46, 32.5], "diameter": 2.0, "floor": 17.5, "platform": [[-48, 31], [-44, 31], [-44, 34], [-48, 34]]}],
	# an upper transom 2 m aft of the hull's at x -90, from its walkway at 7
	# up: a recess 8 m wide and 3 high running in to x -88, a window to port,
	# a walkway, a frame of four posts, a fender, the drop bar and a plinth
	"transom": {"face": -92, "floor": 7.0, "opening": {"outline": [[-4, 7.0], [-4, 10.0], [4, 10.0], [4, 7.0]], "back": -88},
		"windows": [{"plane": "x=-92", "z": [-8, -6], "y": [11, 12], "radius": 0.2, "frame": 0.1}], "catwalk": {"y": [15.6, 16.2]},
		# the rest as parts: a life ring on the recess's back wall
		"details": [{"name": "ring", "kind": "ring", "centre": [-88, 8.5, 2], "facing": [-1, 0, 0], "outer": 0.4, "inner": 0.25, "thickness": 0.1, "paint": "red"}],
		"walkway": {"plan": [[-92, -5], [-94, -5], [-94, 5], [-92, 5]], "thickness": 0.2, "rail": [[-92, -5], [-94, -5], [-94, 5]],
			"aft": [[-94, -5], [-94, 5]], "fascia": [6.0, 6.9], "member": [5.2, 5.8], "railing": 1.0, "posts": 1.8},
		"frame": {"x": -95, "z": [-3, 3], "members": 4, "top": 5.8, "bottom": -1.0, "size": 0.3},
		"fenders": [{"centre": [-95.5, 4.5, -1.5], "length": 1.5, "diameter": 0.8}],
		"drop": {"x": -93, "z": 2, "width": 0.4, "depth": 0.3, "bottom": 2.6, "top": 18.4},
		"plinth": {"outline": [[-97.2, 6.8], [-94.8, 6.8], [-94.8, 9.2], [-97.2, 9.2]], "upper": [[-97, 7], [-95, 7], [-95, 9], [-97, 9]], "bottom": 6.9, "top": 9.2}},
	# a hull 8 m deep: 30 m on the waterline amidships, narrowing to 18 at
	# x 60 and to its stem, which rises from x 70 below to the deck at 95; a
	# transom from 2 m down at x -90; knuckles 6 m up to port, 5 to starboard
	"hull": {"boot": 1.0,
		"transom": {"x": -90, "points": [[-2, 8], [5, 10]]},
		"stations": [{"x": -60, "points": [[-8, 12], [0, 15], [6, 16]]}, {"x": 40, "points": [[-8, 12], [0, 15], [6, 16]]},
			{"x": 60, "points": [[-8, 6], [0, 9], [6, 12]]}],
		"stem": [[70, -8], [75, 0], [95, 19.5]],   # drawn past the deck's underside
		# a flat face on the stem from y 10 up, 4 m wide there and 20 at y 18;
		# below it the stem's front, a knife edge at the waterline, 2 m wide at
		# y 5 and widening on into the face's bottom edge
		"face": {"bottom": [10, 2], "top": [18, 10]},
		"front": [[0, 0.0], [5, 1.0]],
		# red anti-fouling below 3 m down, the boot-topping's black above it to the boot top
		"antifouling": {"top": -3.0, "colour": [140, 60, 50]},
		"knuckle": {"port": [[-90, 6, -16], [60, 6, -12]], "starboard": [[-90, 5, 16], [60, 5, 12]]},
		"gallery": {"port": [[-100, 3]], "starboard": [[-100, 2]]},
		# a wall standing in from the port deck edge (z -40) aft of amidships
		"walls": {"port": [{"wall": [[-75, -36], [-55, -36]], "foot": 8.0}]},
		# a blister rounded at each end to starboard, a square one to port
		"blisters": [{"side": "starboard", "x": [-40, -20], "y": [1.5, 4.0], "depth": 1.0, "ends": "round"},
			{"side": "port", "x": [-20, -10], "y": [2.0, 4.0], "depth": 0.5, "ends": "square"}],
		# port creases from the gallery's foot to the knuckle: one from x 50
		# down to 30, one from 40 by a corner at (25, 10, -26) down to 10
		"flare": {"port": [[[50, 15.4, -40], [30, 6, -16]], [[40, 15.4, -40], [25, 10, -26], [10, 6, -16]]]}},
	# the weathering: the island and the hull each a small atlas, its relief
	# exaggerated so a texel 30 cm across still tilts at a seam
	"weathering": {"samples": 2, "occlusion": 3.0, "relief": 0.5, "grey": [0.30, 0.32, 0.33],
		"groups": [{"material": "island", "meshes": ["island", "island_details"], "size": 128,
			"plates": {"height": 1.8, "width": 3.0, "origin": 19.0}, "frames": 0.6, "streaks": {"length": [0.5, 3.0]},
			"runs": [{"top": [-5.1, 29.0, 24.0], "length": 2.0}], "regions": [{"box": [[-21, 19, 27], [-4, 32, 29]], "streaks": 0.5}]},
			# the radomes their own group, from their paint
			{"material": "domes", "from": "radome", "meshes": ["island"], "size": 128, "grey": [0.7, 0.7, 0.68], "walk": False,
				"plates": {"height": 1.0, "width": 1000.0}, "frames": 1000.0, "streaks": {"length": [0.3, 1.0], "share": 1.0, "rust": 0.0}},
			{"material": "hull", "meshes": ["hull", "sponsons"], "size": 128, "plates": {"height": 2.4, "width": 9.0}, "frames": 0.75},
			# the boot top its own atlas, colour only
			{"material": "boot", "from": "boot", "meshes": ["hull"], "size": 64, "flat": True, "walk": False, "grey": [0.02, 0.02, 0.02],
				"plates": {"height": 2.4, "width": 9.0}, "frames": 0.75, "level": 1.0,
				"wear": {"scuffs": {"scale": 0.5, "share": 0.15, "lift": [0.1, 0.1, 0.1]}}}]},
}


class BuildTest(unittest.TestCase):
	@classmethod
	def setUpClass(cls):
		cls.folder = tempfile.TemporaryDirectory()
		where = Path(cls.folder.name)
		(where / "facts.json").write_text(json.dumps({"layout": LAYOUT}))
		out = [where / "ford.glb", where / "ford.json", where / "features.json"]
		run = subprocess.run(["blender", "-b", "--factory-startup", "--python-use-system-env", "-P", str(HERE / "build.py"), "--",
			*map(str, out), "--facts", str(where / "facts.json")], capture_output=True, text=True)
		if run.returncode or "Traceback" in run.stdout + run.stderr:
			raise RuntimeError(run.stdout[-3000:] + run.stderr[-3000:])
		cls.glb = out[0]
		cls.model = Model(out[0])
		cls.ship = json.loads(out[1].read_text())
		cls.features = json.loads(out[2].read_text())

	@classmethod
	def tearDownClass(cls):
		cls.folder.cleanup()

	def posed(self, **values):
		return self.model.parts(pose(self.ship["joints"], {"joints": values}))

	def test_rest_is_identity(self):
		self.assertEqual(self.model.rotated(), [])

	def test_deck_in_the_ship_frame(self):
		deck = self.model.parts()["deck"].reshape(-1, 3)
		self.assertTrue(np.allclose(deck[deck[:, 0] > -97 + 1e-4][:, 1], 19.0, atol=1e-4))   # flat but for its round-down
		self.assertAlmostEqual(deck[:, 0].min(), -100, places=3)
		self.assertAlmostEqual(deck[:, 0].max(), 100, places=3)
		self.assertAlmostEqual(deck[:, 2].min(), -40, places=3)   # port is negative z
		self.assertAlmostEqual(deck[:, 2].max(), 30, places=3)
		skirt = self.model.parts()["deck_skirt"].reshape(-1, 3)
		self.assertAlmostEqual(skirt[skirt[:, 0] > -97 + 1e-4][:, 1].min(), 18.4, places=3)

	def test_deck_rounds_down_to_its_aft_edge(self):
		# the top on its curve: level 3 m in, 0.6 m down at the edge, a
		# parabola between, cut at each of its six steps right across the deck
		deck = self.model.parts()["deck"].reshape(-1, 3)
		curve = lambda x: 19.0 - 0.6 * max(0.0, 1 - (x + 100) / 3.0) ** 2
		near = deck[deck[:, 0] < -97 + 1e-4]
		np.testing.assert_allclose(near[:, 1], [curve(x) for x in near[:, 0]], atol=1e-4)
		# and inside it, not just along its edges: the surface's height at plan
		# points between the steps, within the chord's sag of the curve
		tris = self.model.parts()["deck"]
		def surface(x, z):
			for t in tris:
				(ax, ay, az), (bx, by, bz), (cx, cy, cz) = t
				d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz)
				l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d
				l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d
				if min(l1, l2, 1 - l1 - l2) >= -1e-9:
					return l1 * ay + l2 * by + (1 - l1 - l2) * cy
			return None
		for x in (-99.75, -99.0, -98.25, -97.5):
			for z in (-35.0, -5.0, 25.0):
				self.assertAlmostEqual(surface(x, z), curve(x), delta=0.01, msg=(x, z))
		self.assertAlmostEqual(deck[:, 1].min(), 18.4, places=4)
		# the edge plate: at the aft edge from 18.4 down to its foot at 17.8, along
		# the sides on the curve, not a slope to the next corner
		skirt = self.model.parts()["deck_skirt"].reshape(-1, 3)
		edge = skirt[np.abs(skirt[:, 0] + 100) < 1e-4]
		np.testing.assert_allclose([edge[:, 1].max(), edge[:, 1].min()], [18.4, 17.8], atol=1e-4)
		side = skirt[(np.abs(skirt[:, 2] + 40) < 1e-4) & (np.abs(skirt[:, 0] + 98.5) < 1e-3)]
		self.assertAlmostEqual(side[:, 1].max(), curve(-98.5), places=4)
		self.assertAlmostEqual(side[:, 1].min(), 18.4 - (18.4 - 17.8) * 0.25, places=4)

	def test_deck_area_leaves_out_the_elevator(self):
		tris = self.model.parts()["deck"]
		a = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
		self.assertAlmostEqual(0.5 * np.abs(a[:, 1]).sum(), 200 * 70 - 20 * 10, places=1)   # in plan, the round-down's curve aside
		# and every face of the top faces up
		self.assertTrue((a[:, 1] > 0).all())

	def test_deck_paint_mapping(self):
		# glTF v runs from port (0, the image's top row) to starboard (1): the
		# image is the deck seen from above with the bow to the right
		index = self.model.index["deck"]
		tris = self.model.meshes[self.model.nodes[index]["mesh"]][0][0].reshape(-1, 3)
		uv = self.model.uvs[self.model.nodes[index]["mesh"]][0].reshape(-1, 2)
		self.assertTrue(np.allclose(uv[:, 0], (tris[:, 0] + 110) / 220, atol=1e-4))
		self.assertTrue(np.allclose(uv[:, 1], (tris[:, 2] + 45) / 80, atol=1e-4))

	def test_shuttle_slides_forward_along_its_track(self):
		rest = self.model.parts()["catapult_1_shuttle"].reshape(-1, 3).mean(0)
		moved = self.posed(catapult_1_shuttle=10)["catapult_1_shuttle"].reshape(-1, 3).mean(0)
		step = moved - rest
		self.assertAlmostEqual(np.linalg.norm(step), 10, places=3)
		self.assertGreater(step[0], 9.9)
		self.assertLess(step[2], -0.8)   # the track angles to port

	def test_deflector_rises_aft_of_its_hinge(self):
		rest = self.model.parts()["catapult_1_deflector"].reshape(-1, 3)
		self.assertAlmostEqual(rest[:, 1].max(), 19.0, places=3)   # flush
		raised = self.posed(catapult_1_deflector=np.radians(50))["catapult_1_deflector"].reshape(-1, 3)
		self.assertGreater(raised[:, 1].max(), 19.0 + 5 * np.sin(np.radians(50)) - 0.05)
		# the raised top lies aft of the hinge
		self.assertLess(raised[raised[:, 1].argmax(), 0], 5)

	def test_deflector_lies_square_to_its_hinge(self):
		# at rest the panel reaches its depth aft of the hinge line, square to
		# it, and no further
		rest = self.model.parts()["catapult_1_deflector"].reshape(-1, 3)[:, [0, 2]]
		a, b = np.array([5, -15.44]), np.array([5.5, -5.44])
		edge = (b - a) / np.linalg.norm(b - a)
		aft = np.array([-edge[1], edge[0]])
		if aft[0] > 0:
			aft = -aft
		reach = (rest - a) @ aft
		self.assertAlmostEqual(reach.min(), 0, places=3)
		self.assertAlmostEqual(reach.max(), 5, places=3)
		self.assertAlmostEqual(((rest - a) @ edge).max() - ((rest - a) @ edge).min(), np.linalg.norm(b - a), places=3)

	def test_elevator_goes_down_and_console_comes_up(self):
		elevator = self.posed(elevator_1=8)["elevator_1"].reshape(-1, 3)
		self.assertAlmostEqual(elevator[:, 1].max(), 11.0, places=3)
		console = self.model.parts()["catapult_console_bow"].reshape(-1, 3)
		self.assertAlmostEqual(console[:, 1].max(), 19.0 - 0.02, places=3)   # stowed just under the deck, which hides it
		raised = self.posed(catapult_console_bow=self.ship["joints"]["catapult_console_bow"]["keys"][-1][1])["catapult_console_bow"].reshape(-1, 3)
		self.assertAlmostEqual(raised[:, 1].max(), 20.5, places=3)
		self.assertAlmostEqual(raised[:, 1].min(), 19.0, places=3)

	def test_shuttle_narrows_to_its_top(self):
		shuttle = self.model.parts()["catapult_1_shuttle"].reshape(-1, 3)
		track = np.array([np.cos(np.radians(5)), -np.sin(np.radians(5))])
		across = np.array([-track[1], track[0]])
		for height, width in ((shuttle[:, 1].min(), 0.4), (shuttle[:, 1].max(), 0.2)):
			level = shuttle[np.abs(shuttle[:, 1] - height) < 1e-4][:, [0, 2]]
			self.assertAlmostEqual(np.ptp(level @ across), width, places=3)

	def test_sheaves_sink_and_supports_press_under_the_deck(self):
		# each sunk or pressed just under the deck, which hides it
		for name, proud in (("wire_1_sheave_port", 0.16), ("wire_1_sheave_starboard", 0.16), ("wire_1_support_1", 0.08)):
			rest = self.model.parts()[name].reshape(-1, 3)
			self.assertAlmostEqual(rest[:, 1].max(), 19.0 + proud, places=3, msg=name)
			travel = self.ship["joints"][name]["keys"][-1][1]   # its joint's whole travel
			sunk = self.posed(**{name: travel})[name].reshape(-1, 3)
			self.assertAlmostEqual(sunk[:, 1].max(), 19.0 - 0.02, places=3, msg=name)
		sheave = self.model.parts()["wire_1_sheave_port"].reshape(-1, 3)
		np.testing.assert_allclose(sheave[:, [0, 2]].mean(0), [-62, -16.5], atol=0.05)
		self.assertAlmostEqual(np.ptp(sheave[:, 0]), 1.0, places=2)
		# in their own white, the support in the grey
		self.assertTrue(self.model.parts(materials=["sheave"])["wire_1_sheave_starboard"].size)
		self.assertFalse(self.model.parts(materials=["grey"]).get("wire_1_sheave_port", np.zeros(0)).size)
		self.assertTrue(self.model.parts(materials=["grey"])["wire_1_support_1"].size)
		# the support lies along the landing line
		support = self.model.parts()["wire_1_support_1"].reshape(-1, 3)[:, [0, 2]]
		line = np.array([100, -10]) / np.hypot(100, 10)
		self.assertAlmostEqual(np.ptp((support - [-61, -9]) @ line), 1.45, places=3)

	def test_barricade_stanchion_rises_about_its_head(self):
		rest = self.model.parts()["barricade_port"].reshape(-1, 3)
		self.assertAlmostEqual(rest[:, 1].max(), 19.0 - 0.02, places=3)   # in its tray, just under the deck, which hides it
		raised = self.posed(barricade_port=np.pi / 2)["barricade_port"].reshape(-1, 3)
		length = np.hypot(8, 1)
		self.assertAlmostEqual(raised[:, 1].max(), 19.0 + length, places=2)
		# upright over its head, not its tip
		top = raised[raised[:, 1] > 19.0 + length - 0.2][:, [0, 2]].mean(0)
		self.assertLess(np.linalg.norm(top - [-50, -30]), 0.6)

	def test_whip_lowers_to_its_side_and_the_mast_stands(self):
		rest = self.model.parts()["antenna_port_aft"].reshape(-1, 3)
		self.assertAlmostEqual(rest[:, 1].max(), 25.0, places=3)   # upright at rest
		lowered = self.posed(antenna_port_aft=np.pi / 2)["antenna_port_aft"].reshape(-1, 3)
		self.assertLess(lowered[:, 1].max(), 19.1)
		far = lowered[np.argmax(np.linalg.norm(lowered[:, [0, 2]] - [-70, -39], axis=1))][[0, 2]]
		direction = (far - [-70, -39]) / np.linalg.norm(far - [-70, -39])
		np.testing.assert_allclose(direction, [-0.8, -0.6], atol=0.02)
		self.assertNotIn("antenna_starboard_forward", self.ship["joints"])
		mast = self.model.parts()["antenna_starboard_forward"].reshape(-1, 3)
		self.assertAlmostEqual(mast[:, 1].max(), 31.0, places=3)
		# square, 0.6 m, with its box on the outboard side
		np.testing.assert_allclose([mast[:, 0].min(), mast[:, 0].max(), mast[:, 2].min(), mast[:, 2].max()], [79.7, 80.3, 24.7, 25.7], atol=1e-4)
		# the whip's hinge housing stays at the deck's edge when it lowers
		housing = self.model.parts()["antenna_mounts"].reshape(-1, 3)
		np.testing.assert_allclose([housing[:, 1].min(), housing[:, 1].max()], [18.3, 19.0], atol=1e-4)
		np.testing.assert_allclose(housing[:, [0, 2]].mean(axis=0), [-70, -39], atol=1e-4)

	def test_island_details(self):
		details = self.model.parts()["island_details"].reshape(-1, 3)
		rail = details[np.abs(details[:, 2] - 20) < 0.03]
		self.assertAlmostEqual(rail[:, 1].max(), 32.025, places=3)   # the top rail over the path
		self.assertAlmostEqual(rail[:, 0].min(), -20.025, places=3)
		# in the railings' material, which the photo checks leave out, and nothing else of the island in it
		# but the ladder and the stair's railings
		railed = self.model.parts(materials=["rail"])["island_details"].reshape(-1, 3)
		self.assertAlmostEqual(railed[:, 1].max(), 32.025, places=3)
		self.assertTrue(((np.abs(railed[:, 2] - 20) < 0.03) | (np.abs(railed[:, 2] - 28.5) < 0.04) | (np.abs(railed[:, 2] - 29.0) < 0.03)
			| (np.abs(railed[:, 2] - 30.0) < 0.03)).all())
		dish = details[np.abs(details[:, 0] + 20.5) < 0.07]
		np.testing.assert_allclose([dish[:, 1].min(), dish[:, 1].max(), dish[:, 2].min(), dish[:, 2].max()], [24.5, 25.5, 23.5, 24.5], atol=0.02)
		self.assertAlmostEqual(np.ptp(dish[:, 0]), 0.12, places=3)   # a disc facing aft
		brace = details[(np.abs(details[:, 0] + 12) < 0.21) & (details[:, 1] < 31.3) & (details[:, 1] > 28.7)]
		self.assertGreater(brace[:, 2].max(), 26.8)   # out to its end
		box = details[details[:, 1] > 39]
		np.testing.assert_allclose([box[:, 0].min(), box[:, 0].max(), box[:, 1].max(), box[:, 2].min()], [-13, -11, 40.25, 22.5], atol=1e-4)

	def test_turned_radome(self):
		# the acorn's bands in the radomes' group above its seam at 32, its
		# drum the island's; each face turned out from the axis or up
		tris = self.model.parts(materials=["domes"])["island"]
		near = np.linalg.norm(tris[:, :, [0, 2]].mean(1) - [-16, 22], axis=1) < 1.2
		acorn = tris[near]
		self.assertAlmostEqual(acorn[:, :, 1].max(), 33.9, places=3)
		self.assertGreaterEqual(acorn[:, :, 1].min(), 32.0 - 1e-6)
		widest = np.linalg.norm(acorn.reshape(-1, 3)[:, [0, 2]] - [-16, 22], axis=1).max()
		self.assertAlmostEqual(widest, 1.0, places=3)
		normal = np.cross(acorn[:, 1] - acorn[:, 0], acorn[:, 2] - acorn[:, 0])
		middle = acorn.mean(1)
		radial = np.stack([middle[:, 0] + 16, np.zeros(len(middle)), middle[:, 2] - 22], 1)
		self.assertTrue((np.einsum("ij,ij->i", normal, radial) + normal[:, 1] * 0.5 > 0).all())
		drum = self.model.parts(materials=["island"])["island"].reshape(-1, 3)
		drum = drum[np.linalg.norm(drum[:, [0, 2]] - [-16, 22], axis=1) < 0.61]
		self.assertAlmostEqual(drum[:, 1].max(), 32.0, places=3)

	def test_paths_ladders_stairs_and_slabs(self):
		details = self.model.parts()["island_details"].reshape(-1, 3)
		# the pipe round, up the face and along it at 25
		pipe = details[(np.abs(details[:, 2] - 28.5) < 0.051) & (details[:, 0] > -8.1) & (details[:, 0] < -5.9) & (details[:, 1] < 25.1)]
		np.testing.assert_allclose([pipe[:, 1].min(), pipe[:, 0].min()], [20, -8], atol=0.06)
		upright = pipe[pipe[:, 1] < 24.8]
		self.assertLess(np.hypot(upright[:, 0] + 6, upright[:, 2] - 28.5).max(), 0.0501)   # round, no square bar's corners
		# the ladder: two stiles half a metre apart, a rung every 0.3 m
		ladder = self.model.parts(materials=["rail"])["island_details"]
		ladder = ladder[(np.abs(ladder[:, :, 2].mean(1) - 28.5) < 0.1) & (ladder[:, :, 1].max(1) <= 22.0 + 1e-6)]
		rungs = ladder[np.ptp(ladder[:, :, 0], axis=1) > 0.4]
		heights = np.sort(rungs[:, :, 1].mean(1))
		self.assertEqual(1 + (np.diff(heights) > 0.1).sum(), 10)
		self.assertAlmostEqual(np.ptp(ladder[:, :, 0]), 0.56, places=2)
		# the stair: a tread every 0.2 m of its rise, a girder under it, railed
		stair = details[(np.abs(details[:, 2] - 29.5) < 1.3) & (details[:, 0] <= -13.9) & (details[:, 1] > 24.0)]
		self.assertAlmostEqual(stair[:, 1].max(), 30.0, places=1)   # its railing a metre over the top
		self.assertLess(stair[:, 1].min(), 24.8)   # the girder under its foot
		# the slab standing 0.2 m forward of its corners
		slab = details[(details[:, 0] > -4.6) & (details[:, 0] < -4.2)]
		self.assertAlmostEqual(slab[:, 0].max(), -4.3, places=3)

	def test_lamps_round_the_shapes(self):
		# a lamp at each point plates.lamps sets round the square and inside
		# its hole, standing out of the plate's face, in the lamps' paint
		sys.path.insert(0, str(HERE))
		import plates
		cell, plate = LAYOUT["lettering"]["cells"]["square"], LAYOUT["lettering"]["plates"][2]
		feet = plates.lamps(plate, cell, [-12.5, 24])
		self.assertEqual(len(feet), 13)   # ten round the square's 4.8 m, three round the hole's 0.8
		lit = self.model.parts(materials=["lights"])["island_details"].reshape(-1, 3)
		self.assertAlmostEqual(lit[:, 0].min(), -3.97, places=3)
		self.assertAlmostEqual(lit[:, 0].max(), -3.82, places=3)
		for (x, y, z), _ in feet:
			near = lit[np.hypot(lit[:, 1] - y, lit[:, 2] - z) < 0.081]
			self.assertGreaterEqual(len(near), 12, (y, z))
		# none on the white: each lamp outside the square, or inside its hole
		inside = (np.abs(lit[:, 1] - 21) < 0.5 - 0.01) & (np.abs(lit[:, 2] - 22) < 0.5 - 0.01)
		hole = (np.abs(lit[:, 1] - 21) < 0.2) & (np.abs(lit[:, 2] - 22) < 0.2)
		self.assertFalse((inside & ~hole).any())

	def test_ship_file(self):
		cat = self.ship["catapults"][0]
		self.assertAlmostEqual(cat["heading"], 5, places=2)   # positive to port
		self.assertEqual(cat["stroke"], 90.0)
		self.assertEqual(self.ship["deck"]["outline"], DECK["outline"])
		self.assertEqual(sorted(self.ship["joints"]), ["antenna_port_aft", "barricade_port", "catapult_1_deflector", "catapult_1_shuttle",
			"catapult_console_bow", "elevator_1", "wire_1_sheave_port", "wire_1_sheave_starboard", "wire_1_support_1"])
		self.assertEqual(self.ship["consoles"], LAYOUT["consoles"])
		self.assertEqual(self.ship["antennas"], LAYOUT["antennas"])
		self.assertEqual(self.ship["joints"]["catapult_1_shuttle"]["keys"], [[0, 0], [1, 90.0]])
		# the deflector faces square to its hinge: the starboard end further
		# forward turns it to port
		deflector = cat["deflector"]
		self.assertAlmostEqual(deflector["heading"], np.degrees(np.arctan2(0.5, 10)), places=2)
		self.assertEqual([deflector["x"], deflector["z"]], [5.25, -10.44])
		self.assertAlmostEqual(deflector["width"], np.hypot(0.5, 10), places=3)
		self.assertEqual(self.ship["lens"], LAYOUT["lens"])
		self.assertEqual(self.ship["lights"], LAYOUT["lights"])

	def test_deck_wears_its_paint(self):
		# the deck material's base colour is paint.py's image, the texture's size
		raw = self.glb.read_bytes()
		length = int.from_bytes(raw[12:16], "little")
		gltf = json.loads(raw[20 : 20 + length])
		deck = next(m for m in gltf["materials"] if m["name"] == "deck")
		texture = gltf["textures"][deck["pbrMetallicRoughness"]["baseColorTexture"]["index"]]
		image = gltf["images"][texture["source"]]
		view = gltf["bufferViews"][image["bufferView"]]
		start = 20 + length + 8 + view.get("byteOffset", 0)
		png = raw[start : start + view["byteLength"]]
		self.assertEqual(png[:8], b"\x89PNG\r\n\x1a\n")
		self.assertEqual((int.from_bytes(png[16:20], "big"), int.from_bytes(png[20:24], "big")), (220, 80))
		# and the lettering's is letters.py's, at its atlas's size
		lettering = next(m for m in gltf["materials"] if m["name"] == "lettering")
		texture = gltf["textures"][lettering["pbrMetallicRoughness"]["baseColorTexture"]["index"]]
		view = gltf["bufferViews"][gltf["images"][texture["source"]]["bufferView"]]
		start = 20 + length + 8 + view.get("byteOffset", 0)
		png = raw[start : start + view["byteLength"]]
		self.assertEqual((int.from_bytes(png[16:20], "big"), int.from_bytes(png[20:24], "big")), (64, 32))
		self.assertEqual(len(gltf["images"]), 10)   # the deck's, the lettering's, the nets', the island's, hull's and radomes' colour and normal maps, and the boot top's colour
		# the lettering cut out: clear but for its text, so a plate shows the face behind it
		self.assertEqual(lettering.get("alphaMode"), "MASK")
		self.assertEqual(png[25], 6)   # colour type RGBA

	def test_glazed_level_seen_through(self):
		# its glass and fittings are details, which the engine's crash box
		# leaves out: the body's sides stay where the blocks put them
		body = self.model.parts()["island"].reshape(-1, 3)
		self.assertGreaterEqual(body[:, 2].min(), 20 - 1e-4)
		# a sight line across the block through both openings meets nothing of
		# the island: the room is hollow and both walls open
		tris = self.model.parts()["island"]
		def crosses(a, b):
			d = np.array(b) - np.array(a)
			for t in tris:
				e1, e2 = t[1] - t[0], t[2] - t[0]
				h = np.cross(d, e2)
				det = e1 @ h
				if abs(det) < 1e-12:
					continue
				f = 1 / det
				s_ = np.array(a) - t[0]
				u = f * (s_ @ h)
				q = np.cross(s_, e1)
				v = f * (d @ q)
				w = f * (e2 @ q)
				if u >= 0 and v >= 0 and u + v <= 1 and 0 <= w <= 1:
					return True
			return False
		self.assertFalse(crosses([-12, 23.5, 19.0], [-12, 23.5, 29.0]))
		self.assertTrue(crosses([-12, 21.0, 19.0], [-12, 21.0, 29.0]))   # below the room, the block as it was
		# the panes: see-through, leaning out 0.25 m at the head
		raw = self.glb.read_bytes()
		length = int.from_bytes(raw[12:16], "little")
		gltf = json.loads(raw[20 : 20 + length])
		pane = next(m for m in gltf["materials"] if m["name"] == "pane")
		self.assertEqual(pane.get("alphaMode"), "BLEND")
		glass = self.model.parts(materials=["pane"])["island_details"].reshape(-1, 3)
		port = glass[glass[:, 2] < 24]
		self.assertAlmostEqual(port[port[:, 1] < 23.5][:, 2].max(), 20.4, places=3)          # its foot on the face
		self.assertAlmostEqual(port[port[:, 1] > 23.5][:, 2].min(), 20.4 - 0.25 - 0.02, places=3)   # its head out
		# mullions every 1.5 m (five across 6 m), and consoles inside below the sill
		# the cab's fittings among the details: within the level's own box
		def cab(*materials):
			q = self.model.parts(materials=list(materials))["island_details"].reshape(-1, 3)
			return q[(q[:, 0] >= -15.6) & (q[:, 0] <= -8.4) & (q[:, 1] >= 21.9) & (q[:, 1] <= 24.5) & (q[:, 2] >= 19.9) & (q[:, 2] <= 28.1)]
		# the frames in the island's grey, as the photos show them round the dark glass
		grey = cab("grey", "island")   # the grey weathered into the island's atlas
		heads = grey[(grey[:, 1] > 23.9) & (grey[:, 1] < 24.1) & (grey[:, 2] < 24)]
		self.assertEqual(sorted(set(np.round(heads[:, 0] * 2) / 2)), [-15.0, -13.0, -11.0, -9.0])   # a frame every 2 m, at the heads
		dark = cab("dark")
		console = dark[(dark[:, 1] <= 23.0 + 1e-4) & (dark[:, 2] < 24) & (dark[:, 2] > 20.4)]
		self.assertAlmostEqual(console[:, 1].min(), 22.0, places=3)
		# a white wiper motor in each of the port opening's three bays, 0.1 m
		# out from the glass 0.88 of the way up; none on the starboard one,
		# which asks for none; a conduit 0.3 above the port head only
		white = cab("white")
		port = white[white[:, 2] < 24]
		self.assertEqual(len(np.unique(np.round(port[:, 0], 1))), 6)         # three bars, two ends each
		self.assertAlmostEqual(port[:, 1].mean(), 23.88, places=3)
		self.assertAlmostEqual(port[:, 2].mean(), 20.4 - 0.25 * 0.88 - 0.1, places=3)
		self.assertFalse((white[:, 2] > 24).any())
		# the room behind the glass: its floor (y 22.0), which only the room's
		# cut makes, dark; its ceiling (y 24.0) and walls the room's paint
		def flat(triangles, y):
			return triangles[(np.abs(triangles[:, :, 1] - y) < 1e-4).all(1)].mean(1)
		def inside(middles, x0, x1, z0, z1):
			return ((middles[:, 0] > x0) & (middles[:, 0] < x1) & (middles[:, 2] > z0) & (middles[:, 2] < z1)).any()
		none = np.empty((0, 3, 3))
		dark = self.model.parts(materials=["dark"]).get("island", none)
		self.assertTrue(inside(flat(dark, 22.0), -14.1, -9.9, 21, 27))
		room = self.model.parts(materials=["room"]).get("island", none)
		self.assertTrue(inside(flat(room, 24.0), -14, -10, 21.2, 26.8))
		end = room[(np.abs(room[:, :, 0] + 14) < 1e-4).all(1)].mean(1)                 # the room's aft wall
		self.assertTrue(((end[:, 1] > 22) & (end[:, 1] < 24) & (end[:, 2] > 21.2) & (end[:, 2] < 26.8)).any())
		# the openings' reveals the wall's grey: the port sill (y 23.0) from the
		# face (z 20) in to the room (21.2), and nothing dark or the room's there
		body = self.model.parts(materials=["grey", "island"])["island"]
		self.assertTrue(inside(flat(body, 23.0), -15, -9, 20, 21.2))
		for other in (dark, room):
			self.assertFalse(inside(flat(other, 23.0), -15, -9, 20, 21.2))
		# a conduit 0.3 above the port head, its only grey above the head
		conduit = grey[grey[:, 1] > 24.15]
		self.assertAlmostEqual(conduit[:, 1].mean(), 24.3, places=3)
		self.assertTrue((conduit[:, 2] < 21).all())                            # the port head's alone
		# the window it replaces drawn as no plate of its own
		faces = self.model.parts(materials=["glass"])["island_faces"].reshape(-1, 3)
		self.assertFalse(((faces[:, 1] > 22.9) & (faces[:, 1] < 24.1)).any())

	def test_radomes_smooth(self):
		# the island's sphere 48 round its equator, and drawn smooth: its
		# vertices shared between faces (flat shading gives each face its own)
		points = self.model.parts(materials=["domes"])["island"].reshape(-1, 3)   # the sphere's, not its plinth's top
		equator = points[(np.abs(points[:, 1] - 33.0) < 1e-3) & (np.abs(np.linalg.norm(points[:, [0, 2]] - [-12, 24], axis=1) - 1.5) < 0.01)]
		self.assertEqual(len(np.unique(np.round(equator, 3), axis=0)), 48)
		raw = self.glb.read_bytes()
		length = int.from_bytes(raw[12:16], "little")
		gltf = json.loads(raw[20 : 20 + length])
		names = [m["name"] for m in gltf["materials"]]
		mesh = gltf["meshes"][next(n["mesh"] for n in gltf["nodes"] if n["name"] == "island")]
		for primitive in mesh["primitives"]:
			vertices = gltf["accessors"][primitive["attributes"]["POSITION"]]["count"]
			triangles = gltf["accessors"][primitive["indices"]]["count"] // 3
			if names[primitive["material"]] == "domes":
				self.assertLess(vertices, triangles)       # smooth: shared
			elif names[primitive["material"]] == "island":
				self.assertGreater(vertices, triangles)    # the plating flat

	def test_weathered_atlases(self):
		# each weathered group's grey wears the group's material, unwrapped into
		# its atlas, which carries a colour and a normal map at the group's size
		raw = self.glb.read_bytes()
		length = int.from_bytes(raw[12:16], "little")
		gltf = json.loads(raw[20 : 20 + length])
		binary = raw[20 + length + 8:]
		from io import BytesIO
		from PIL import Image
		def picture(index):
			view = gltf["bufferViews"][gltf["images"][gltf["textures"][index]["source"]]["bufferView"]]
			start = view.get("byteOffset", 0)
			return np.asarray(Image.open(BytesIO(binary[start : start + view["byteLength"]])), float)
		materials = [m["name"] for m in gltf["materials"]]
		srgb = lambda c: np.where(c <= 0.0031308, 12.92 * c, 1.055 * np.power(c, 1 / 2.4) - 0.055)
		for group, meshes, size, paint, source, floor in (("island", ("island", "island_details"), 128, [0.30, 0.32, 0.33], "grey", 0.04),
				("hull", ("hull", "sponsons"), 128, [0.30, 0.32, 0.33], "grey", 0.04), ("domes", ("island",), 128, [0.7, 0.7, 0.68], "radome", 0.01)):
			m = gltf["materials"][materials.index(group)]
			colour = picture(m["pbrMetallicRoughness"]["baseColorTexture"]["index"])
			normal = picture(m["normalTexture"]["index"])
			self.assertEqual(colour.shape[:2], (size, size), group)
			self.assertGreater(colour[..., :3].std(), 2.0, group)   # weathered, not one flat grey
			self.assertGreater(np.abs(normal[..., :2] - 128).max(), 3.0, group)   # the seams' relief
			# only the group's own faces reach its atlas: the texels between its
			# islands stay the plain paint (a face outside it, given the whole
			# square by a new UV layer, covers most of them: 1-2% left here
			# against 8-18%)
			plain = np.floor(srgb(np.array(paint)) * 255 + 0.5)
			self.assertGreater(np.all(colour[..., :3] == plain, axis=-1).mean(), floor, group)
			# and its faces as baked: no two of its meshes' faces on one texel,
			# though a later group unwraps the same mesh
			if len(meshes) > 1:
				covered = sum(self.covered(name, group, 256) for name in meshes)
				self.assertLess((covered > 1).mean(), 0.002, group)
			for name in meshes:
				mesh = gltf["meshes"][next(n["mesh"] for n in gltf["nodes"] if n["name"] == name)]
				worn = [pr for pr in mesh["primitives"] if materials[pr["material"]] == group]
				self.assertTrue(worn and all("TEXCOORD_0" in pr["attributes"] for pr in worn), name)
				self.assertFalse([pr for pr in mesh["primitives"] if materials[pr["material"]] == source], name)
		# the boot top's atlas a colour map alone at its size, scuffed, its faces
		# still the boot's paint below the boot top
		m = gltf["materials"][materials.index("boot")]
		self.assertNotIn("normalTexture", m)
		colour = picture(m["pbrMetallicRoughness"]["baseColorTexture"]["index"])
		self.assertEqual(colour.shape[:2], (64, 64))
		self.assertGreater(colour[..., :3].std(), 2.0)
		boot = self.model.parts(materials=["boot"])["hull"].reshape(-1, 3)
		self.assertLessEqual(boot[:, 1].max(), 1.0 + 1e-3)
		# the island's radomes weathered in their own group, their plinths in
		# the island's; the Phalanx's radome left in the plain paint
		domes = self.model.parts(materials=["domes"])["island"].reshape(-1, 3)
		self.assertAlmostEqual(domes[:, 1].max(), 34.5, places=2)
		self.assertGreater(domes[:, 1].min(), 31.4)
		self.assertTrue(self.model.parts(materials=["radome"])["weapons"].size)

	def covered(self, name, material, size):
		# how many of a node's faces in `material` cover each texel of its atlas
		from PIL import Image, ImageDraw
		mesh = self.model.nodes[self.model.index[name]]["mesh"]
		image = Image.new("L", (size, size), 0)
		pen = ImageDraw.Draw(image)
		for k, (_, m) in enumerate(self.model.meshes[mesh]):
			if m == material:
				for t in self.model.uvs[mesh][k].reshape(-1, 3, 2):
					pen.polygon([(u * size, v * size) for u, v in t], fill=1)
		return np.asarray(image).astype(int)

	def test_numbers_read_from_outside(self):
		# each plate's cell (u 0.5-1 across the atlas, v 0 at its top row)
		# runs to the viewer's right: aft to forward on the starboard face,
		# forward to aft on the port face, and bottom to top up it
		index = self.model.index["island_faces"]
		mesh = self.model.nodes[index]["mesh"]
		materials = [m for _, m in self.model.meshes[mesh]]
		k = materials.index("lettering")
		tris = self.model.meshes[mesh][k][0].reshape(-1, 3)
		uv = self.model.uvs[mesh][k].reshape(-1, 2)
		for z, sign in ((28, 1), (20, -1)):
			front = np.abs(tris[:, 2] - (z + sign * 0.03)) < 1e-3
			self.assertGreater(front.sum(), 0, z)
			s = (tris[front, 0] + 12) / 4
			u = 0.5 + 0.5 * (s if sign > 0 else 1 - s)
			self.assertTrue(np.allclose(uv[front, 0], u, atol=1e-4), z)
			self.assertTrue(np.allclose(uv[front, 1], 1 - (tris[front, 1] - 21) / 2, atol=1e-4), z)

	def test_features(self):
		self.assertEqual(self.features["landmarks"]["deck_bow_port"], {"at": [100, 19.0, -40], "node": "deck"})


	def faces(self, name, materials=None):
		tris = self.model.parts(materials=materials)[name]
		normals = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
		return tris, normals / np.linalg.norm(normals, axis=1)[:, None]

	def test_island_block_leans_in(self):
		tris, normals = self.faces("island")
		points = tris.reshape(-1, 3)
		self.assertAlmostEqual(points[:, 1].max(), 45.0, places=3)   # the mast's top
		# the roof's own triangles (the mast and the dome's plinth stand on it)
		corners = np.array([[-19, 31, 21], [-6, 31, 21], [-6, 31, 27], [-19, 31, 27]])
		top = (np.linalg.norm(tris[:, :, None, :] - corners, axis=3).min(2) < 1e-4).all(1)
		bottom = (np.abs(tris[:, :, 1] - 19.0) < 1e-4).all(1)
		self.assertTrue(top.any() and bottom.any())
		self.assertTrue((normals[top, 1] > 0.99).all())    # the roof faces up
		self.assertTrue((normals[bottom, 1] < -0.99).all())
		roof = tris[top].reshape(-1, 3)
		self.assertAlmostEqual(roof[:, 0].min(), -19, places=3)   # the upper plan
		base = tris[bottom].reshape(-1, 3)
		self.assertAlmostEqual(base[:, 0].min(), -20, places=3)
		self.assertAlmostEqual(base[:, 2].max(), 28, places=3)   # starboard is +z

	def test_island_dome_and_ship_file(self):
		island = self.ship["island"]
		self.assertEqual(island["prisms"], [{"outline": [[-20, 20], [-5, 20], [-5, 28], [-20, 28]], "bottom": 19.0, "top": 31.0}])
		self.assertEqual(island["mast"], {"position": [-12, 24], "top": 45.0})
		points = self.model.parts()["island"].reshape(-1, 3)
		near = points[np.linalg.norm(points - [-12, 33, 24], axis=1) < 1.6]
		self.assertAlmostEqual(near[:, 1].max(), 34.5, places=3)   # the dome's top

	def test_sponson_and_its_phalanx(self):
		sponson = self.model.parts()["sponsons"].reshape(-1, 3)
		self.assertTrue(((sponson[:, 0] >= -90 - 1e-6) & (sponson[:, 0] <= -30 + 0.03)).all())   # the railing's last post half its width past
		quarter = sponson[np.isclose(sponson[:, 0], -90) | np.isclose(sponson[:, 0], -80)]   # its corners, not the flare below it
		self.assertAlmostEqual(quarter[:, 1].min(), 8.0, places=4)
		self.assertAlmostEqual(quarter[:, 1].max(), 12.0, places=4)
		# the catwalk's floor at its height, its railing a metre above it
		catwalk = sponson[(sponson[:, 0] >= -50 - 1e-6) & (sponson[:, 2] < -39)]
		self.assertTrue(np.isclose(catwalk[:, 1], 17.5, atol=1e-4).any())
		self.assertAlmostEqual(catwalk[:, 1].max(), 18.525, places=3)
		weapons = self.model.parts()["weapons"].reshape(-1, 3)
		self.assertAlmostEqual(weapons[:, 1].max(), 15.58, places=2)   # the radome's top
		np.testing.assert_allclose(weapons[weapons[:, 1].argmax()][[0, 2]], [-85, -16], atol=0.05)
		# trained to starboard: the barrels run out along +z from the axis, not along x
		barrels = weapons[(np.abs(weapons[:, 1] - 13.25) < 0.18) & (weapons[:, 0] < -80)]
		self.assertAlmostEqual(barrels[:, 2].max(), -16 + 2.2, places=3)
		self.assertLess(barrels[:, 0].max(), -85 + 0.81)
		radome = self.model.parts(materials=["radome"])["weapons"].reshape(-1, 3)
		self.assertAlmostEqual(radome[np.abs(radome[:, 0] + 85) < 1][:, 1].min(), 13.68, places=3)
		# the elevated one: its barrels' muzzle raised forward of its axis, its pedestal down to 9
		raised = weapons[(weapons[:, 0] > -77) & (weapons[:, 0] < -72) & (np.abs(weapons[:, 2] + 16) < 0.9)]
		muzzle = raised[raised[:, 0].argmax()]
		self.assertAlmostEqual(muzzle[0], -75 + 1.365, places=2)
		self.assertGreater(muzzle[1], 11.9)
		self.assertAlmostEqual(raised[:, 1].min(), 9.0, places=3)

	def test_gun_tub_is_a_railed_floor(self):
		# a floor 0.2 thick at 16, a railing 1.1 over it on its outboard sides
		# only, a knee from the floor's outer edge down to 14 at the face
		sponson = self.model.parts()["sponsons"].reshape(-1, 3)
		tub = sponson[(sponson[:, 0] > -70.1) & (sponson[:, 0] < -65.9) & (sponson[:, 2] > 29.4)]
		self.assertAlmostEqual(tub[:, 1].max(), 17.125, places=3)   # the top rail
		self.assertAlmostEqual(tub[:, 1].min(), 14.0, places=3)     # the knee's foot
		under = tub[np.isclose(tub[:, 1], 15.8, atol=1e-4) & np.isclose(tub[:, 2], 33, atol=1e-4)]
		self.assertAlmostEqual(under[:, 0].max(), -66, places=3)   # the floor's underside, out to its edge and on to its forward end
		along_face = (tub[:, 2] < 30.3) & (tub[:, 0] > -69.5) & (tub[:, 0] < -66.5)
		self.assertFalse((along_face & (tub[:, 1] > 16.01)).any())   # no railing along the face
		# the railing in the railings' material, the floor and knee not
		railed = self.model.parts(materials=["rail"])["sponsons"].reshape(-1, 3)
		railed = railed[(railed[:, 0] > -70.1) & (railed[:, 0] < -65.9) & (railed[:, 2] > 29.4)]
		self.assertAlmostEqual(railed[:, 1].max(), 17.125, places=3)
		self.assertGreaterEqual(railed[:, 1].min(), 16.0 - 1e-4)
		knee = tub[np.isclose(tub[:, 1], 14.0, atol=1e-4)]
		self.assertAlmostEqual(knee[:, 2].min(), 29.5, places=3)   # running on 0.5 into the face

	def test_catwalk_hangs_off_the_deck_edge(self):
		# its floor out to 1.5 m past the port edge, a railing on its outer
		# edge, knees under it whose feet meet the edge 0.8 m below the floor's
		# underside; the platform off it 2 m further out
		sponson = self.model.parts()["sponsons"].reshape(-1, 3)
		run = sponson[(sponson[:, 0] > -50 - 1e-6) & (sponson[:, 0] < -37) & (sponson[:, 2] < -37)]
		self.assertAlmostEqual(run[:, 2].min(), -41.5 - 0.05, places=3)   # the toe board's outer face
		self.assertTrue((np.isclose(run[:, 1], 18.5, atol=1e-4) & np.isclose(run[:, 2], -41.5, atol=0.03)).any())   # the top rail
		self.assertTrue((np.isclose(run[:, 1], 16.6, atol=1e-4) & np.isclose(run[:, 2], -40, atol=1e-4)).any())
		self.assertAlmostEqual(run[:, 2].max(), -38.5, places=3)   # the knees run on 1.5 m into the band
		self.assertTrue((np.isclose(run[:, 1], 17.5, atol=1e-4) & np.isclose(run[:, 2], -39.8, atol=1e-4)).any())   # the floor, from inside it
		platform = sponson[(sponson[:, 0] > -36 - 1e-6) & (sponson[:, 0] < -34 + 1e-6)]
		self.assertAlmostEqual(platform[:, 2].min(), -43.5 - 0.05, places=3)

	def test_rafts_hang_in_tiers_outboard(self):
		# three racks, a canister in each tier, lying fore and aft outboard of
		# the starboard edge; the small ones on the port catwalk
		rafts = self.model.parts(materials=["raft"])["sponsons"].reshape(-1, 3)
		self.assertGreater(rafts[:, 0].min(), -60 - 1e-6)
		self.assertLess(rafts[:, 0].max(), -55 + 1e-6)
		self.assertGreater(rafts[:, 2].min(), 31.0 - 1e-6)   # outboard of the edge at 30
		for low, high in ((17.0, 17.9), (18.0, 18.9)):
			tier = rafts[(rafts[:, 1] > low - 1e-6) & (rafts[:, 1] < high + 1e-6)]
			self.assertEqual(len(np.unique(np.round(tier[:, 0], 3))), 6)   # each canister's two ends
		self.assertEqual(len(rafts[(rafts[:, 1] > 17.9 + 1e-6) & (rafts[:, 1] < 18.0 - 1e-6)]), 0)
		small = self.model.parts(materials=["blue"])["sponsons"].reshape(-1, 3)
		self.assertEqual(len(np.unique(np.round(small[:, 0], 3))), 4)   # two canisters' ends
		self.assertLess(small[:, 2].max(), -40.6 + 1e-6)

	def test_dome_platform_meets_the_edge(self):
		# the platform carried in from 31 to inside the edge at 30, the dome on
		# it, and knees from its outer edge down to the deck's edge
		sponson = self.model.parts()["sponsons"].reshape(-1, 3)
		dome = sponson[(sponson[:, 0] > -48 - 1e-6) & (sponson[:, 0] < -44 + 1e-6) & (sponson[:, 2] > 28)]
		self.assertAlmostEqual(dome[:, 2].min(), 28.5, places=3)   # the knees' inboard run, 1.5 m into the hull
		self.assertTrue((np.isclose(dome[:, 2], 29.8, atol=1e-4) & np.isclose(dome[:, 1], 17.5, atol=1e-4)).any())
		self.assertAlmostEqual(dome[:, 1].max(), 19.8, places=2)   # the dome's top, 2.3 radii over the floor
		self.assertTrue((np.isclose(dome[:, 2], 30, atol=1e-4) & np.isclose(dome[:, 1], 16.4, atol=1e-4)).any())

	def test_nets_see_through_and_skip_the_platform(self):
		nets = self.model.parts(materials=["net"])["nets"]
		points = nets.reshape(-1, 3)
		side = points[(points[:, 0] < 0) & (points[:, 0] > -90)]
		self.assertAlmostEqual(side[:, 1].min(), 18.5, places=4)    # the railing's top
		self.assertAlmostEqual(side[:, 1].max(), 18.9, places=4)
		self.assertAlmostEqual(side[:, 2].min(), -43.0, places=4)   # 1.5 m out from the railing
		# its outer edge hanging 0.2 m between the frames, at their tips at each frame
		edge = side[np.isclose(side[:, 2], -43.0, atol=1e-4)]
		self.assertEqual(sorted(set(np.round(edge[:, 1], 4))), [18.7, 18.9])
		# none outboard of the platform, and the run's net either side of it
		spans = [(t[:, 0].min(), t[:, 0].max()) for t in nets if t[:, 0].max() < 0]
		self.assertFalse(any(a < -35 < b for a, b in spans))
		inside = lambda x0, x1: any(a >= x0 - 1e-4 and b <= x1 + 1e-4 for a, b in spans)
		self.assertTrue(inside(-50, -36) and inside(-34, -30))
		bow = points[points[:, 0] > 99]
		self.assertAlmostEqual(bow[:, 0].max(), 101.5, places=4)
		# the stern's hung aft of its line, from its own floor's railing
		stern = points[points[:, 0] < -90]
		self.assertAlmostEqual(stern[:, 0].max(), -93.0, places=4)
		self.assertAlmostEqual(stern[:, 0].min(), -94.5, places=4)
		np.testing.assert_allclose([stern[:, 1].min(), stern[:, 1].max()], [15.0, 15.4], atol=1e-4)
		# a cut-out material on both faces, its image mapped
		data = self.glb.read_bytes()
		size = int.from_bytes(data[12:16], "little")
		gltf = json.loads(data[20:20 + size])
		net = next(m for m in gltf["materials"] if m["name"] == "net")
		self.assertEqual(net.get("alphaMode"), "MASK")
		self.assertTrue(net.get("doubleSided"))
		self.assertIn("baseColorTexture", net["pbrMetallicRoughness"])
		# the cord rust-brown, as the photo has it: red over green over blue
		image = gltf["images"][gltf["textures"][net["pbrMetallicRoughness"]["baseColorTexture"]["index"]]["source"]]
		view = gltf["bufferViews"][image["bufferView"]]
		start = 20 + size + 8 + view.get("byteOffset", 0)
		pixels = np.asarray(Image.open(io.BytesIO(data[start:start + view["byteLength"]])).convert("RGBA")).reshape(-1, 4)
		cord = pixels[pixels[:, 3] > 127][:, :3].astype(int).mean(0)
		self.assertGreater(cord[0], 1.4 * cord[1])
		self.assertGreater(cord[1], 1.4 * cord[2])
		mesh = gltf["meshes"][next(n["mesh"] for n in gltf["nodes"] if n["name"] == "nets")]
		self.assertIn("TEXCOORD_0", mesh["primitives"][0]["attributes"])
		# their frames in the railings' material, which the photo checks leave out with the nets
		frames = self.model.parts()["net_frames"].reshape(-1, 3)
		self.assertEqual(len(self.model.parts(materials=["rail"])["net_frames"].reshape(-1, 3)), len(frames))

	def test_blisters_stand_out_from_the_hull_side(self):
		# the hull's side at y 2.75 midships: 15 at the waterline to 16 at y 6
		side = 15 + 2.75 / 6
		blisters = self.model.parts()["hull_blisters"].reshape(-1, 3)
		starboard = blisters[blisters[:, 2] > 0]
		np.testing.assert_allclose([starboard[:, 0].min(), starboard[:, 0].max(), starboard[:, 1].min(), starboard[:, 1].max()],
			[-40, -20, 1.5, 4.0], atol=1e-4)
		self.assertAlmostEqual(starboard[np.isclose(starboard[:, 1], 2.75, atol=1e-3)][:, 2].max(), side + 1.0, places=3)
		self.assertAlmostEqual(starboard[:, 2].min(), 15 + 1.5 / 6 - 0.4, places=3)   # running on 0.4 into the side, at its foot
		# rounded at each end: its end at mid-height, no corner at its foot
		self.assertTrue((np.isclose(starboard[:, 0], -40, atol=1e-4) & np.isclose(starboard[:, 1], 2.75, atol=1e-3)).any())
		self.assertFalse((np.isclose(starboard[:, 0], -40, atol=1e-3) & np.isclose(starboard[:, 1], 1.5, atol=1e-3)).any())
		port = blisters[blisters[:, 2] < 0]
		self.assertTrue((np.isclose(port[:, 0], -20, atol=1e-4) & np.isclose(port[:, 1], 2.0, atol=1e-4)).any())   # square
		self.assertAlmostEqual(port[:, 2].min(), -(15 + 4.0 / 6 + 0.5), places=3)

	def test_flare_creases_make_facets(self):
		tris = self.model.parts()["hull"]
		points = tris.reshape(-1, 3)
		# the crease's own corner is a corner of the hull
		self.assertTrue((np.linalg.norm(points - [25, 10, -26], axis=1) < 1e-4).any())
		# sections at the deck's corners (the elevator's notch), off the grid
		for x in (0, 20):
			self.assertTrue(np.isclose(points[:, 0], x, atol=1e-4).any(), x)
		# between the creases' ends no section's strip of flare runs straight
		# from the knuckle up to the gallery's foot; outside them they do
		def strips(lo, hi):
			found = []
			for t in tris:
				for a, b in ((0, 1), (1, 2), (2, 0)):
					p, q = sorted((t[a], t[b]), key=lambda v: v[1])
					if abs(p[0] - q[0]) < 1e-4 and lo < p[0] < hi and np.allclose([p[1], q[1], q[2]], [6, 15.4, -40], atol=1e-3):
						found.append(p[0])
			return found
		self.assertEqual(strips(10.01, 49.99), [])
		self.assertGreater(len(strips(-30, 9.99)), 0)
		# and the hull stays whole and wound one way: each edge crossed once
		# each way, but the deck underside's, which the deck closes, and the
		# transom's section above its floor, which the upper transom closes
		edges = {}
		for t in np.round(tris, 4):
			for a, b in ((0, 1), (1, 2), (2, 0)):
				key = (tuple(t[a]), tuple(t[b]))
				edges[key] = edges.get(key, 0) + 1
		self.assertEqual(set(edges.values()), {1})
		open_ = [e for e in edges if (e[1], e[0]) not in edges]
		self.assertTrue(open_ and all((e[0][1] == 18.4 and e[1][1] == 18.4) or (e[0][0] == -90 and e[1][0] == -90 and min(e[0][1], e[1][1]) >= 5 - 1e-4)   # from the knuckles (5 and 6) up
			for e in open_))

	def test_transom_face_round_its_recess(self):
		# the hull's own transom stops at the walkway's floor; above it the
		# upper transom's face 2 m aft closes the hull round its recess, which
		# runs in to its back wall
		hull = self.model.parts()["hull"]
		end = hull[np.all(np.abs(hull[:, :, 0] + 90) < 1e-4, axis=1)]
		self.assertGreater(len(end), 0)
		self.assertAlmostEqual(end[:, :, 1].max(), 7.0, places=4)
		parts = self.model.parts()
		shell = parts["transom"]

		def covers(tris, x, z, y):
			# whether a triangle in the plane at x covers (z, y)
			for t in tris[np.all(np.abs(tris[:, :, 0] - x) < 1e-4, axis=1)]:
				a, b, c = (np.array([v[2], v[1]]) for v in t)
				d = lambda p, q, r: (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1])
				s = [d(np.array([z, y]), a, b), d(np.array([z, y]), b, c), d(np.array([z, y]), c, a)]
				if min(s) >= -1e-9 or max(s) <= 1e-9:
					return True
			return False
		self.assertTrue(covers(hull, -90, 0, 6.5))       # the hull's own, from the knuckles up to the floor
		self.assertTrue(covers(shell, -92, 0, 13))       # the face above the recess
		self.assertTrue(covers(shell, -92, -10, 8))      # and beside it
		self.assertFalse(covers(shell, -92, 0, 8.5))     # the recess open
		recess = self.model.parts(materials=["recess"])["transom"]
		self.assertTrue(covers(recess, -88, 0, 8.5))     # its back wall
		points = shell.reshape(-1, 3)
		self.assertAlmostEqual(points[:, 0].min(), -92, places=4)
		self.assertAlmostEqual(points[:, 0].max(), -88, places=4)
		self.assertAlmostEqual(points[:, 1].max(), 18.4, places=4)   # up to the deck's underside
		self.assertAlmostEqual(points[:, 2].min(), -40, places=4)    # out to the deck's edges
		self.assertAlmostEqual(points[:, 2].max(), 30, places=4)
		# the section's sides carried aft from the hull's transom to the face
		for z in (-40, 30):
			wall = shell[np.all(np.abs(shell[:, :, 2] - z) < 1e-4, axis=1)].reshape(-1, 3)
			self.assertEqual((round(wall[:, 0].min(), 4), round(wall[:, 0].max(), 4)), (-92, -90), z)

	def test_transom_fittings(self):
		fittings = self.model.parts()["transom_fittings"].reshape(-1, 3)
		walkway = fittings[(fittings[:, 0] < -92 + 1e-4) & (fittings[:, 0] > -94 - 1e-4) & (np.abs(fittings[:, 2]) < 5 + 1e-4)]
		self.assertTrue(np.isclose(walkway[:, 1], 7.0, atol=1e-4).any() and np.isclose(walkway[:, 1], 6.8, atol=1e-4).any())
		bar = self.model.parts(materials=["yellow"])["transom_fittings"].reshape(-1, 3)
		np.testing.assert_allclose([bar[:, 0].min(), bar[:, 0].max(), bar[:, 2].min(), bar[:, 2].max(), bar[:, 1].min(), bar[:, 1].max()],
			[-93.15, -92.85, 1.8, 2.2, 2.6, 18.4], atol=1e-4)
		dark = self.model.parts(materials=["dark"])["transom_fittings"].reshape(-1, 3)
		self.assertAlmostEqual(dark[:, 1].min(), -1.0, places=4)   # the frame's posts into the water
		self.assertEqual(len(np.unique(np.round(dark[dark[:, 1] < 0, 2], 2))), 8)   # four posts, two faces each
		self.assertAlmostEqual(fittings[:, 1][np.abs(fittings[:, 0] + 96) < 1.01].max(), 9.2, places=4)   # the plinth
		# its sides sloping: its top inside its upper plan, its foot out to its outline
		plinth = fittings[(np.abs(fittings[:, 0] + 96) < 1.3) & (np.abs(fittings[:, 2] - 8) < 1.3) & (fittings[:, 1] > 6.8)]
		top = plinth[np.isclose(plinth[:, 1], 9.2, atol=1e-4)]
		self.assertLessEqual(np.abs(top[:, 0] + 96).max(), 1.0 + 1e-4)
		self.assertTrue((np.linalg.norm(plinth - [-97.2, 6.9, 6.8], axis=1) < 1e-4).any())
		glass = self.model.parts(materials=["glass"])["transom_fittings"].reshape(-1, 3)
		self.assertAlmostEqual(glass[:, 0].min(), -92.03, places=4)
		# the window's corners rounded at 0.2 m, its frame 0.1 m round it and
		# flatter, the glass standing proud of it
		corner = np.array([-8.0, 11.0])
		self.assertGreater(np.linalg.norm(glass[:, [2, 1]] - corner, axis=1).min(), 0.05)
		self.assertAlmostEqual(glass[:, 2].min(), -8.0, places=4)
		frame = self.model.parts(materials=["panel"])["transom_fittings"].reshape(-1, 3)
		np.testing.assert_allclose([frame[:, 2].min(), frame[:, 2].max(), frame[:, 1].min(), frame[:, 1].max()], [-8.1, -5.9, 10.9, 12.1], atol=1e-4)
		self.assertAlmostEqual(frame[:, 0].min(), -92.015, places=4)
		# the life ring: a flat ring between its radii round its centre, 0.1 m
		# out from the back wall
		ring = self.model.parts(materials=["red"])["transom_fittings"].reshape(-1, 3)
		radius = np.linalg.norm(ring[:, 1:] - [8.5, 2], axis=1)
		self.assertAlmostEqual(radius.min(), 0.25, places=3)
		self.assertAlmostEqual(radius.max(), 0.4, places=3)
		np.testing.assert_allclose([ring[:, 0].min(), ring[:, 0].max()], [-88.1, -88.0], atol=1e-4)

	def test_sloped_sponson_and_wedge(self):
		# each corner at its own heights, and named for the photo match
		marks = self.features["landmarks"]
		self.assertEqual(marks["sponson_sloped_top_3"], {"at": [-60, 15.0, -36], "node": "sponsons"})
		self.assertEqual(marks["sponson_sloped_bottom_2"], {"at": [-70, 9.0, -36], "node": "sponsons"})
		self.assertEqual(marks["sponson_quarter_top_1"], {"at": [-90, 12.0, -12], "node": "sponsons"})
		sponson = self.model.parts()["sponsons"].reshape(-1, 3)
		sloped = sponson[(sponson[:, 0] >= -70 - 1e-6) & (sponson[:, 0] <= -60 + 1e-6) & (sponson[:, 2] <= -30 + 1e-6)]
		for x, z, y in ((-70, -36, 9.0), (-70, -30, 9.5), (-60, -36, 15.0), (-70, -36, 14.0)):
			self.assertTrue((np.linalg.norm(sloped - [x, y, z], axis=1) < 1e-4).any(), (x, y, z))
		self.assertAlmostEqual(sloped[:, 1].max(), 15.0, places=4)
		self.assertAlmostEqual(sloped[:, 1].min(), 9.0, places=4)
		# the wedge spans its x and its section
		wedge = sponson[(sponson[:, 0] >= -89 - 1e-6) & (sponson[:, 0] <= -88 + 1e-6) & (sponson[:, 1] < 8 - 1e-6)]
		self.assertGreater(len(wedge), 0)
		self.assertEqual(marks["wedge_flare_2"], {"at": [-89, 8.0, -16], "node": "sponsons"})
		self.assertTrue((np.linalg.norm(sponson - [-88, 6, -12], axis=1) < 1e-4).any())

	def test_quarter_wall_stands_in_from_the_deck_edge(self):
		# along the quarter the port side rises from the wall's foot straight
		# up to the deck's underside, 4 m inside the deck's edge; outside it,
		# the gallery wall at the edge
		points = self.model.parts()["hull"].reshape(-1, 3)
		def ring(x):
			nearest = points[np.argmin(np.abs(points[:, 0] - x))][0]
			return points[np.abs(points[:, 0] - nearest) < 1e-4]
		inside = ring(-65)
		port = inside[inside[:, 2] < 0]
		self.assertAlmostEqual(port[:, 2].min(), -36, places=4)
		for y in (8.0, 18.4):
			self.assertTrue((np.linalg.norm(port[:, 1:] - [y, -36], axis=1) < 1e-3).any(), y)
		outside = ring(-40)
		self.assertAlmostEqual(outside[outside[:, 2] < 0][:, 2].min(), -40, places=4)

	def test_faces_stand_proud_and_face_out(self):
		# the opening on the hull's starboard side, the window forward on the
		# island and the radar face on its port side: each a thin plate a few
		# centimetres out from its face, in its material
		for name, axis, value, outward, paint in (("openings", 2, 16.2, 1, "dark"), ("island_faces", 0, -5, 1, "glass"), ("island_faces", 2, 20, -1, "panel")):
			parts = self.model.parts(materials=[paint])
			self.assertIn(name, parts, paint)
			plate = parts[name].reshape(-1, 3)
			plate = plate[np.abs(plate[:, axis] - value) < 0.1]
			self.assertGreater(len(plate), 0, paint)
			self.assertAlmostEqual(plate[:, axis].min() if outward > 0 else plate[:, axis].max(), value, places=4)
			self.assertAlmostEqual(plate[:, axis].max() if outward > 0 else plate[:, axis].min(), value + outward * 0.03, places=4)
		# a face of its own thickness
		cover = self.model.parts(materials=["panel"])["island_faces"].reshape(-1, 3)
		cover = cover[np.abs(cover[:, 0] + 5) < 0.2]
		self.assertAlmostEqual(np.ptp(cover[:, 0]), 0.1, places=4)

	def test_hull_depth_and_waterline(self):
		hull = self.ship["hull"]
		self.assertEqual(hull["draught"], 8)
		self.assertAlmostEqual(hull["waterline"]["stem"], 75, places=3)
		self.assertAlmostEqual(dict(map(tuple, hull["waterline"]["half"])).get(-60.0, 15), 15, places=3)
		amidships = [h for x, h in hull["waterline"]["half"] if -50 < x < 30]
		self.assertTrue(amidships and all(abs(h - 15) < 1e-6 for h in amidships))
		points = self.model.parts()["hull"].reshape(-1, 3)
		self.assertAlmostEqual(points[:, 1].min(), -8, places=3)
		self.assertLessEqual(points[:, 1].max(), 18.4 + 1e-4)   # nothing through the deck
		# nothing below the waterline ahead of the stem, nor aft of the transom
		self.assertLessEqual(points[points[:, 1] < -1e-6, 0].max(), 75 + 1e-3)
		self.assertGreaterEqual(points[:, 0].min(), -90 - 1e-3)
		transom = points[np.abs(points[:, 0] + 90) < 1e-3]
		self.assertAlmostEqual(transom[:, 1].min(), -2, places=3)

	def test_hull_symmetric_below_its_knuckles(self):
		points = self.model.parts()["hull"].reshape(-1, 3)
		below = points[points[:, 1] < 5 - 1e-6]
		port = np.unique(np.round(below[below[:, 2] < -1e-6] * [1, 1, -1], 4), axis=0)
		starboard = np.unique(np.round(below[below[:, 2] > 1e-6], 4), axis=0)
		self.assertTrue(np.array_equal(port, starboard))

	def test_hull_sides_out_to_the_deck_edge(self):
		points = self.model.parts()["hull"].reshape(-1, 3)
		ring = points[np.abs(points[:, 0] - points[np.argmin(np.abs(points[:, 0]))][0]) < 1e-4]
		def at(y, z):
			return (np.linalg.norm(ring[:, 1:] - [y, z], axis=1) < 1e-3).any()
		self.assertTrue(at(18.4, 30) and at(16.4, 30))      # starboard: the gallery wall 2 m deep at the deck's edge
		self.assertTrue(at(18.4, -40) and at(15.4, -40))    # port: 3 m
		self.assertTrue(at(6, -16) and at(5, 15 + 5 / 6))   # each side's knuckle on the hull
		self.assertFalse(at(6, 16))

	def test_draught_marks_beside_the_stem(self):
		# a plate each side, a metre aft of the stem at its height, standing
		# outside the hull and reading from outside: forward to the right on
		# starboard, aft to the right on port
		index = self.model.index["hull_lettering"]
		mesh = self.model.nodes[index]["mesh"]
		tris = self.model.meshes[mesh][0][0].reshape(-1, 3)
		uv = self.model.uvs[mesh][0].reshape(-1, 2)
		stem = 75 + 0.65 * 20 / 19.5
		self.assertTrue((np.abs(tris[:, 0] - (stem - 1.0)) < 0.15).all())
		self.assertAlmostEqual(tris[:, 1].min(), 0.5, places=3)
		self.assertAlmostEqual(tris[:, 1].max(), 0.8, places=3)
		# the hull's half-breadth at the plate, between the rings either side of it
		hull = self.model.parts()["hull"].reshape(-1, 3)
		rings = np.unique(np.round(hull[:, 0], 4))
		x = stem - 1.0
		breadth = []
		for ring in (rings[rings <= x].max(), rings[rings > x].min()):
			side = hull[(np.abs(hull[:, 0] - ring) < 1e-3) & (hull[:, 2] > 1e-6) & (hull[:, 1] < 5)]
			side = side[np.argsort(side[:, 1])]
			breadth.append((ring, np.interp(0.65, side[:, 1], side[:, 2])))
		(x0, b0), (x1, b1) = breadth
		here = b0 + (x - x0) / (x1 - x0) * (b1 - b0)
		for sign in (1, -1):
			side = tris[np.sign(tris[:, 2]) == sign]
			self.assertAlmostEqual(np.abs(side[:, 2]).mean(), here, delta=0.1)   # on the side, tangent at its middle
			u = uv[np.sign(tris[:, 2]) == sign][:, 0]
			order = np.argsort(side[:, 0])
			self.assertGreater(sign * (u[order][-1] - u[order][0]), 0)

	def test_bow_face_is_the_sections_flat_bottom(self):
		# ahead of the face's bottom edge each section's lowest points lie
		# across the face at its centreline height, out to its crease; below
		# it across the stem's front, out to its half-width there, a section at
		# each of the front's knots; below the front the stem keeps no breadth
		points = self.model.parts()["hull"].reshape(-1, 3)
		for x in (88, 89.5):   # below the band's foot (y 15.4), where the loft stops a stem or face
			nearest = points[np.argmin(np.abs(points[:, 0] - x))][0]
			ring = points[np.abs(points[:, 0] - nearest) < 1e-4]
			height = (nearest - 75) * 19.5 / 20
			bottom = ring[np.abs(ring[:, 1] - height) < 1e-3]
			self.assertGreater(len(bottom), 1, x)
			self.assertAlmostEqual(np.abs(bottom[:, 2]).max(), 2 + (height - 10), places=3)
			self.assertGreaterEqual(ring[:, 1].min(), height - 1e-3)
		for height, width in ((5, 1.0), (7.5, 1.5)):
			x = 75 + height * 20 / 19.5
			ring = points[np.abs(points[:, 0] - x) < 1e-3] if height == 5 else None
			if ring is None:
				# between the knots: the section nearest, its bottom at the stem there
				nearest = points[np.argmin(np.abs(points[:, 0] - x))][0]
				ring, height = points[np.abs(points[:, 0] - nearest) < 1e-4], (nearest - 75) * 19.5 / 20
				width = 1.0 + (height - 5) / 5
			bottom = ring[np.abs(ring[:, 1] - height) < 1e-3]
			self.assertGreater(len(bottom), 1, height)
			self.assertAlmostEqual(np.abs(bottom[:, 2]).max(), width, places=3)
			self.assertGreaterEqual(ring[:, 1].min(), height - 1e-3)
		stem = points[(points[:, 1] > -7.5) & (points[:, 1] < -0.5) & (points[:, 0] >= 75 + points[:, 1] * 5 / 8 - 1e-3)]
		self.assertGreater(len(stem), 0)
		self.assertTrue((np.abs(stem[:, 2]) < 1e-3).all())   # on the forefoot below the front: no breadth

	def test_hull_faces_out_and_wears_boot_below(self):
		tris, normals = self.faces("hull")
		keel = (np.abs(tris[:, :, 1] + 8) < 1e-4).all(1)
		self.assertTrue(keel.any() and (normals[keel, 1] < -0.99).all())
		side = (tris[:, :, 2] > 13).all(1) & (tris[:, :, 1] > -5).all(1) & (tris[:, :, 1] < 0).all(1) & (np.abs(tris[:, :, 0]) < 20).all(1)
		self.assertTrue(side.any() and (normals[side, 2] > 0.9).all())
		# the anti-fouling up to its top, the boot-topping from there to the boot
		# top
		red = self.model.parts(materials=["antifouling"])["hull"].reshape(-1, 3)
		self.assertAlmostEqual(red[:, 1].max(), -3.0, places=3)
		self.assertAlmostEqual(red[:, 1].min(), -8, places=3)
		boot = self.model.parts(materials=["boot"])["hull"].reshape(-1, 3)
		self.assertLessEqual(boot[:, 1].max(), 1.0 + 1e-4)
		# nothing black below the band's edge but where the keel rises through it
		# toward the transom (the test ship's from x -65 aft) and the stem rises
		# through it (from x 70)
		middle = boot[(boot[:, 0] > -60) & (boot[:, 0] < 70)]
		self.assertGreaterEqual(middle[:, 1].min(), -3.0 - 1e-4)
		# the transom, from 2 m down (above the band's edge), black up to the boot top
		transom = self.faces("hull", materials=["boot"])[0]
		self.assertTrue((np.abs(transom[:, :, 0] + 90) < 1e-3).all(1).any())
		# grey above it, but for the bow's end cap and the faces where the
		# rising stem crosses the boot top
		grey = self.faces("hull", materials=["hull"])[0]
		self.assertGreaterEqual(grey[(np.abs(grey[:, :, 0] + 90) < 1e-3).all(1)][:, :, 1].min(), 1.0 - 1e-4)   # the transom above the boot top
		sides = grey[~((np.abs(grey[:, :, 0] + 90) < 1e-3).all(1) | (grey[:, :, 0] > 75).any(1))].reshape(-1, 3)
		self.assertGreaterEqual(sides[:, 1].min(), 1.0 - 1e-4)


class ProvenanceTest(unittest.TestCase):
	# The Ford's scripts never open the old carrier, its ship file or the
	# vendor downloads (decision 1): no line of their code names them
	FORBIDDEN = re.compile(r"downloads|nimitz|build_carrier|bake_decktex|plan_check|jbd_border", re.I)

	def test_our_scripts_never_name_the_old_files(self):
		for path in sorted(HERE.glob("*.py")):
			if path.name == "test_build.py":
				continue
			for number, line in enumerate(path.read_text().splitlines(), 1):
				code = line.split("#", 1)[0]
				self.assertIsNone(self.FORBIDDEN.search(code), f"{path.name}:{number}: {line.strip()}")

	def test_the_rule_bites(self):
		self.assertIsNotNone(self.FORBIDDEN.search('OLD = HERE.parents[2] / "web/src/assets/nimitz.glb"'))
		self.assertIsNotNone(self.FORBIDDEN.search('OLD = HERE.parents[1] / "downloads" / "x.glb"'))
		self.assertIsNone(self.FORBIDDEN.search("blender -b -P build.py -- OUT.glb OUT.json"))


if __name__ == "__main__":
	unittest.main()
