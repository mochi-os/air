# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# Tests for build.py: the frame, the joints' signs, the deck's paint mapping
# and the ship file, on a small deck built in Blender; and the provenance rule.
#
# usage: systemd-run --user --collect --wait --pipe --quiet --slice=probe.slice -p MemoryMax=6G -p MemorySwapMax=0 python3 -I /home/alistair/mochi/apps/air/tools/ford/test_build.py
import io, itertools, json, math, re, subprocess, sys, tempfile, unittest
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
		"deflector": {"hinge": [[5, -15.44], [5.5, -5.44]], "depth": 2.5, "linkage": {"pivot": [1.575, -0.4725], "crank": 0.778, "rod": 0.914}}}],
	# a bow station, an elongated hexagon in the deck rising 1 m, and a waist
	# one at a deck edge in a surface 2 cm under it, no tier, windows on three faces
	"consoles": [{"name": "bow", "outline": [[10.4, -2], [11.0, -3.2], [13.0, -3.2], [13.6, -2], [13.0, -0.8], [11.0, -0.8]], "rise": 1.0, "inset": [0.15, 0.45]},
		{"name": "waist", "outline": [[-30, -40], [-26, -40], [-27, -38.4], [-29, -38.4]], "top": 18.98, "rise": 0.6, "inset": [0.05, 0.2],
			"tier": 0, "lid": 0.08, "panes": [0, 1, 2, 1]}],
	# a landing line angled to port, one wire with its sheaves and a support,
	# a barricade stanchion lying aft from its head
	"landing": {"line": [[-90, 0], [10, -10]], "wires": [{"number": 1, "x": 30, "ends": [[-62, 19.08, -16], [-58, 19.08, 12]]}], "target": 1,
		# the port sheave's arm turned 27 degrees outboard, the starboard's straight forward
		"sheaves": [{"name": "wire_1_port", "centre": [-62, -16.5], "arm": {"angle": 27, "offset": 0.25, "length": 3.8}},
			{"name": "wire_1_starboard", "centre": [-58, 12.5], "arm": {"angle": 0, "offset": 0.48, "length": 4.75}}],
		"supports": [{"wire": 1, "number": 1, "centre": [-61, -9]}],
		"barricade": {"stanchions": [{"side": "port", "hinge": [-50, -30], "tip": [-58, -31]}]}},
	# a whip that lowers aft and to port, and a fixed mast
	"antennas": [{"name": "port_aft", "base": [-70, -39], "length": 6, "lowered": [-0.8, -0.6], "mount": [0.6, 0.7, 0.6]},
		# a square mast with a box on its outboard side
		{"name": "starboard_forward", "base": [80, 25], "length": 12, "width": 0.6,
			"details": [{"name": "box", "kind": "box", "centre": [80, 28, 25.5], "size": [0.4, 0.4, 0.4]}]}],
	"fittings": {"shuttle": {"length": 1.2, "width": 0.4, "height": 0.25, "top": 0.5},
		# a deflector scaled down to fit the fixture's thin deck: its linkage
		# the Ford's search's for a 2.92 m panel, 0.2 thick, every length times 0.829
		"deflector": {"thickness": 0.166, "face": 0.1, "angle": 50, "modules": 6, "rows": 7, "cells": 3, "groove": 0.03, "rib": 0.04,
			"clearance": 0.02, "lug": [0.1, 0.06, 0.04], "stripe": 0.21, "pit": 0.55,
			"linkage": {"attach": 0.686, "bend": 1, "spread": 0.026, "sizes": [0.06, 0.04], "keys": 25},
			# a 2 s raise, fastest at the start
			"motion": {"time": 2.0, "keys": [[0, 0], [0.25, 0.4], [0.5, 0.7], [0.75, 0.9], [1, 1]]}},
		"console": {"lid": 0.1, "tier": 0.12, "skirt": 0.3, "frame": 0.1},
		"sheave": {"diameter": 1.0, "height": 0.16, "colour": [242, 242, 236],
			"arm": {"colour": [148, 154, 161], "root": 0.8, "width": [0.36, 0.22], "narrows": 3.0, "thickness": [0.04, 0.02], "thins": 2.1,
				"head": {"inner": 0.52, "from": 24, "to": 80, "outline": [[0.8, 0.34], [0.86, 0.5], [0.7, 0.62], [0.3, 0.58]], "top": 0.1, "thickness": 0.02},
				"pedestal": [[0.45, 0.35], [0.85, 0.35], [0.85, 0.6], [0.45, 0.6]],
				"pin": {"at": [0.64, 0.36], "diameter": 0.025, "height": 0.035, "nut": [0.04, 0.015]}}},
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
	# a sponson under the port quarter with a Phalanx on it, a house on its
	# inboard forward corner, a skirt under it whose forward face slopes back
	# (its plan at the top 2 m further forward than at its foot) and a locker
	# rounded along its length, an opening in the starboard side, a catwalk
	# with its net and a rack of rafts
	"sponsons": [{"name": "quarter", "outline": [[-90, -12], [-90, -20], [-80, -20], [-80, -12]], "bottom": 8.0, "top": 12.0,
			"details": [{"name": "quarter_house", "kind": "box", "centre": [-82.5, 12.5, -13.5], "size": [2, 1, 2]},
				{"name": "quarter_skirt", "kind": "prism", "outline": [[-88, -19], [-84, -19], [-84, -17], [-88, -17]],
					"upper": [[-88, -19], [-82, -19], [-82, -17], [-88, -17]], "bottom": 7.0, "top": 8.0},
				{"name": "quarter_locker", "kind": "rounded", "centre": [-86.0, 12.5, -18.0], "size": [2.0, 1.0, 1.0], "along": "x", "radius": 0.2},
				{"name": "quarter_knob", "kind": "dome", "centre": [-88.5, 12.3, -13.0], "radius": 0.3, "segments": 8}]},
		# one whose top rises forward and whose bottom falls outboard
		{"name": "sloped", "outline": [[-70, -30], [-70, -36], [-60, -36], [-60, -30]], "bottom": [9.5, 9.0, 9.0, 9.5], "top": [14.0, 14.0, 15.0, 15.0]}],
	# a gun tub on the starboard edge: its floor at 16, its outline from the
	# inboard aft corner round to the inboard forward one, a knee down to 14
	"tubs": [{"name": "tub", "outline": [[-70, 30], [-70, 33], [-66, 33], [-66, 30]], "floor": 16.0, "railing": 1.1, "knee": {"x": -69.9, "foot": 14.0}}],
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
		# the rest as parts: a life ring on the recess's back wall, a
		# quarter of a deck circle on a deck sloping 0.1 m a metre aft, and a
		# railing in the recess bent round a corner of radius 0.5 drawn in six
		# short runs, 5.79 m long in all
		"details": [{"name": "ring", "kind": "ring", "centre": [-88, 8.5, 2], "facing": [-1, 0, 0], "outer": 0.4, "inner": 0.25, "thickness": 0.1, "paint": "red",
				"mark": "transom_ring"},
			{"name": "arc", "kind": "ring", "centre": [-93, 7.3, -3], "facing": [0.1, 1, 0], "outer": 1.0, "inner": 0.8, "thickness": 0.02, "segments": 12,
				"sweep": [0, 90], "paint": "white"},
			{"name": "bend", "kind": "railing", "height": 1.0, "posts": 1.5, "bent": True, "path": [[-88.5, 8.0, -3.5]]
				+ [[round(-90.5 + 0.5 * math.cos(math.radians(-90 - 15 * k)), 4), 8.0, round(-3.0 + 0.5 * math.sin(math.radians(-90 - 15 * k)), 4)] for k in range(7)]
				+ [[-91.0, 8.0, 0.0]]}],
		# the walkway cut back round the drop bar to a ledge at x -92.8 from
		# z 1.5 to 2.5, its railing in two lines turning in along the cut
		"walkway": {"plan": [[-92, -5], [-94, -5], [-94, 1.5], [-92.8, 1.5], [-92.8, 2.5], [-94, 2.5], [-94, 5], [-92, 5]], "thickness": 0.2,
			"rail": [[[-92, -5], [-94, -5], [-94, 1.5], [-93.0, 1.5]], [[-93.0, 2.5], [-94, 2.5], [-94, 5]]],
			"aft": [[[-94, -5], [-94, 1.5], [-92.8, 1.5]], [[-92.8, 2.5], [-94, 2.5], [-94, 5]]], "fascia": [6.0, 6.9], "member": [5.2, 5.8], "railing": 1.0, "posts": 1.8},
		"frame": {"x": -95, "z": [-3, 3], "members": 4, "top": 5.8, "bottom": -1.0, "size": 0.3},
		"fenders": [{"centre": [-95.5, 4.5, -1.5], "length": 1.5, "diameter": 0.8}],
		"drop": {"x": -93, "z": 2, "width": 0.4, "depth": 0.3, "bottom": 2.6, "top": 18.4, "gap": [9.0, 12.0]},
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


def build(cls, layout):
	# Builds a layout into a test class's own folder: its model, ship file and
	# features
	cls.folder = tempfile.TemporaryDirectory()
	where = Path(cls.folder.name)
	(where / "facts.json").write_text(json.dumps({"layout": layout}))
	out = [where / "ford.glb", where / "ford.json", where / "features.json"]
	run = subprocess.run(["blender", "-b", "--factory-startup", "--python-use-system-env", "-P", str(HERE / "build.py"), "--",
		*map(str, out), "--facts", str(where / "facts.json")], capture_output=True, text=True)
	if run.returncode or "Traceback" in run.stdout + run.stderr:
		raise RuntimeError(run.stdout[-3000:] + run.stderr[-3000:])
	cls.glb = out[0]
	cls.model = Model(out[0])
	cls.ship = json.loads(out[1].read_text())
	cls.features = json.loads(out[2].read_text())


def corners(model, name, materials=None):
	# a node's triangles and each one's corners' normals
	mesh = model.nodes[model.index[name]]["mesh"]
	pieces = [(t, n) for (t, m), n in zip(model.meshes[mesh], model.normals[mesh]) if materials is None or m in materials]
	return np.concatenate([t for t, n in pieces]), np.concatenate([n for t, n in pieces])


class BuildTest(unittest.TestCase):
	@classmethod
	def setUpClass(cls):
		build(cls, LAYOUT)

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
		opening = 2.5 * np.hypot(0.5, 10)   # the deflector's
		self.assertAlmostEqual(0.5 * np.abs(a[:, 1]).sum(), 200 * 70 - 20 * 10 - opening, places=1)   # in plan, the round-down's curve aside
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
		self.assertGreater(raised[:, 1].max(), 19.0 + 2.5 * np.sin(np.radians(50)) - 0.05)
		# the raised top lies aft of the hinge
		self.assertLess(raised[raised[:, 1].argmax(), 0], 5)

	def opening(self):
		# the fixture's deflector opening: its first end, unit vectors along
		# its edge and aft, its width and depth
		a, b = np.array([5, -15.44]), np.array([5.5, -5.44])
		edge = (b - a) / np.linalg.norm(b - a)
		aft = np.array([-edge[1], edge[0]])
		if aft[0] > 0:
			aft = -aft
		return a, edge, aft, np.linalg.norm(b - a), 2.5

	def test_deflector_lies_square_to_its_hinge(self):
		# at rest the panel fills its opening, square to the hinge line, less
		# the clearance all round (its lugs standing into the aft one)
		rest = self.model.parts()["catapult_1_deflector"].reshape(-1, 3)[:, [0, 2]]
		a, edge, aft, width, depth = self.opening()
		reach, along = (rest - a) @ aft, (rest - a) @ edge
		self.assertAlmostEqual(reach.min(), 0.02, places=3)
		self.assertAlmostEqual(reach.max(), depth - 0.02, places=3)
		self.assertAlmostEqual(along.min(), 0.02, places=3)
		self.assertAlmostEqual(along.max(), width - 0.02, places=3)

	def test_deflector_opening_is_cut_from_the_deck(self):
		# no deck under the panel, the deck right up to the opening's sides,
		# and a pit under it, its floor `pit` down
		a, edge, aft, width, depth = self.opening()
		deck = self.model.parts()["deck"]
		middle = deck.mean(1)[:, [0, 2]]
		reach, along = (middle - a) @ aft, (middle - a) @ edge
		self.assertFalse(((reach > 1e-3) & (reach < depth - 1e-3) & (along > 1e-3) & (along < width - 1e-3)).any())
		corners = np.round(deck.reshape(-1, 3)[:, [0, 2]], 3)
		for c in (a, a + edge * width, a + edge * width + aft * depth, a + aft * depth):
			self.assertTrue((np.abs(corners - c) < 2e-3).all(1).any(), c)
		pit = self.model.parts()["pits"].reshape(-1, 3)
		self.assertAlmostEqual(pit[:, 1].min(), 19.0 - 0.55, places=3)
		self.assertAlmostEqual(pit[:, 1].max(), 19.0, places=3)

	def test_deflector_face_is_tiled_in_the_decks_paint(self):
		# 6 modules by 7 rows of tiles, each tile's top two triangles in the
		# deck's paint, the grooves between them dark
		tops = self.model.parts(materials=["deck"])["catapult_1_deflector"]
		self.assertEqual(len(tops), 6 * 7 * 2)
		self.assertTrue(np.allclose(tops[:, :, 1], 19.0, atol=1e-4))
		self.assertGreater(len(self.model.parts(materials=["recess"])["catapult_1_deflector"]), 0)

	def test_deflector_rises_as_measured(self):
		# its keys seconds into its raise against its angle: the layout's
		# motion, its shares carried to its time and its angle
		keys = self.ship["joints"]["catapult_1_deflector"]["keys"]
		np.testing.assert_allclose(keys, [[0, 0], [0.5, 0.4 * np.radians(50)], [1.0, 0.7 * np.radians(50)], [1.5, 0.9 * np.radians(50)], [2.0, np.radians(50)]], atol=1e-4)

	def test_deflector_struts_follow_it(self):
		# at every point of its raise each strut's rod meets the panel's back
		# where its fitting is: the crank and the rod posed through their own
		# keys on the panel's angle, as the engine poses them
		joints = self.ship["joints"]
		self.assertEqual(joints["catapult_1_deflector_crank"]["follows"], "catapult_1_deflector")
		self.assertEqual(joints["catapult_1_deflector_rod"]["follows"], "catapult_1_deflector")
		a, edge, aft, width, depth = self.opening()
		hinge = a + aft * 0.02
		D, W = depth - 2 * 0.02 - 0.04, width - 2 * 0.02
		attach = 0.686 * D
		w = 0.5 * W / 6 - 0.026 * W + 0.02   # the first strut, along the edge from the opening's first end
		up = np.array([0.0, 1.0, 0.0])
		for seconds in (0.0, 0.6, 1.2, 2.0):
			angle = np.interp(seconds, *np.array(joints["catapult_1_deflector"]["keys"]).T)
			values = {name: np.interp(angle, *np.array(joints[name]["keys"]).T) for name in ("catapult_1_deflector_crank", "catapult_1_deflector_rod")}
			rod = self.posed(catapult_1_deflector=angle, **values)["catapult_1_deflector_rod"].reshape(-1, 3)
			u, v = attach * np.cos(angle) + 0.166 * np.sin(angle), attach * np.sin(angle) - 0.166 * np.cos(angle)
			plan = hinge + aft * u + edge * w
			target = np.array([plan[0], 19.0 + v, plan[1]])
			self.assertLess(np.linalg.norm(rod - target, axis=1).min(), 0.03, seconds)   # the rod's end, 0.04 across

	def test_elevator_goes_down_and_console_comes_up(self):
		elevator = self.posed(elevator_1=8)["elevator_1"].reshape(-1, 3)
		self.assertAlmostEqual(elevator[:, 1].max(), 11.0, places=3)
		console = self.model.parts()["catapult_console_bow"].reshape(-1, 3)
		self.assertAlmostEqual(console[:, 1].max(), 19.0 - 0.02, places=3)   # stowed just under the deck, which hides it
		self.assertEqual(self.ship["joints"]["catapult_console_bow"]["keys"], [[0, 0], [1, 1.02]])
		raised = self.posed(catapult_console_bow=1.02)["catapult_console_bow"].reshape(-1, 3)
		self.assertAlmostEqual(raised[:, 1].max(), 20.0, places=3)         # its rise over the deck
		self.assertAlmostEqual(raised[:, 1].min(), 19.0 - 0.3, places=3)   # its skirt still under it
		np.testing.assert_allclose([console[:, 0].min(), console[:, 0].max(), console[:, 2].min(), console[:, 2].max()], [10.4, 13.6, -3.2, -0.8], atol=1e-4)   # the lid
		# the lid's top in the deck's paint, the tier under it dark
		none = np.empty((0, 3, 3))
		lid = self.model.parts(materials=["deck"]).get("catapult_console_bow", none).reshape(-1, 3)
		self.assertGreater(len(lid), 0)
		self.assertTrue(np.allclose(lid[:, 1], 19.0 - 0.02, atol=1e-4))
		tier = self.model.parts(materials=["dark"]).get("catapult_console_bow", none).reshape(-1, 3)
		self.assertGreater(len(tier), 0)
		np.testing.assert_allclose([tier[:, 1].min(), tier[:, 1].max()], [18.98 - 0.22, 18.98 - 0.1], atol=1e-4)
		# the body's faces leaning in from its foot (on the deck when raised) to its head
		body = self.model.parts(materials=["grey"])["catapult_console_bow"].reshape(-1, 3)
		foot, head = body[np.isclose(body[:, 1], 19.0 - 1.02, atol=1e-4)], body[np.isclose(body[:, 1], 18.98 - 0.22, atol=1e-4)]
		self.assertGreater(np.ptp(foot[:, 2]) - np.ptp(head[:, 2]), 0.5)   # 0.15 in at its foot, 0.45 at its head, each side
		self.assertAlmostEqual(np.ptp(foot[:, 2]), 2.4 - 0.3, places=3)
		# a window in each of its six faces, and in the waist's three
		self.assertEqual(len(self.model.parts(materials=["glass"])["catapult_console_bow"]), 6 * 12)
		glass = self.model.parts(materials=["glass"])["catapult_console_waist"]
		self.assertEqual(len(glass), 4 * 12)
		inboard = (glass[:, :, 2] > -38.8) & (glass[:, :, 0] < -27.05) & (glass[:, :, 0] > -28.95)   # its face, clear of the corners
		self.assertEqual(int(inboard.all(1).sum()), 2 * 12)   # two in its inboard face
		outboard = (glass[:, :, 2] < -39.7) & (glass[:, :, 0] > -29.5) & (glass[:, :, 0] < -26.5)
		self.assertFalse(outboard.all(1).any())                              # none in its outboard one
		# the waist's lid stowed under its own surface, rising as its joint says, with no tier
		waist = self.model.parts()["catapult_console_waist"].reshape(-1, 3)
		self.assertAlmostEqual(waist[:, 1].max(), 18.98 - 0.02, places=3)
		self.assertEqual(self.ship["joints"]["catapult_console_waist"]["keys"], [[0, 0], [1, 0.62]])
		self.assertNotIn("catapult_console_waist", self.model.parts(materials=["dark"]))

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
		sheave = self.model.parts(materials=["sheave"])["wire_1_sheave_port"].reshape(-1, 3)   # the housing, not its arm
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

	def test_sheave_arms(self):
		# each rigged sheave's arm in its own paint, riding on the sheave
		arms = self.model.parts(materials=["arm"])
		for name, centre, side, angle, offset, length in (("wire_1_sheave_port", (-62, -16.5), -1, 27, 0.25, 3.8), ("wire_1_sheave_starboard", (-58, 12.5), 1, 0, 0.48, 4.75)):
			arm = arms[name].reshape(-1, 3)
			plan = arm[:, [0, 2]] - centre
			turn = np.radians(angle)
			along = plan @ [np.cos(turn), side * np.sin(turn)]
			out = plan @ [-np.sin(turn), side * np.cos(turn)]
			# its tip on its line turned outboard, the bar's middle its offset outboard of it
			self.assertAlmostEqual(along.max(), length, places=3, msg=name)
			tip = plan[np.argmax(along)]
			self.assertAlmostEqual(float(tip @ [-np.sin(turn), side * np.cos(turn)]), offset, places=3, msg=name)
			# the whole fitting outboard of the housing's centre and clear of its rim
			self.assertGreater(out.min(), 0.0, name)
			self.assertGreaterEqual(np.hypot(plan[:, 0], plan[:, 1]).min(), 0.52 - 1e-3, name)
			# the bar 0.36 wide at its root and 0.22 from 3 m along, 0.04 thick there and 0.02 from 2.1 m
			for u, width, thick in ((0.8, 0.36, 0.04), (3.0, 0.22, 0.02), (length - 0.11, 0.22, 0.02)):
				section = np.abs(along - u) < 1e-3
				bar = section & (np.abs(out - offset) < 0.2) & (arm[:, 1] < 19.05)
				self.assertAlmostEqual(np.ptp(out[bar]), width, places=3, msg=(name, u))
				self.assertAlmostEqual(arm[bar][:, 1].max(), 19.0 + thick, places=3, msg=(name, u))
			# the head 0.1 up, the pin's nut 0.15, under the housing's top
			self.assertAlmostEqual(arm[:, 1].max(), 19.15, places=3, msg=name)
			head = arm[np.abs(arm[:, 1] - 19.1) < 1e-4]
			self.assertTrue(len(head), name)
		# turned 27 degrees, the port arm's tip lies 1.95 m outboard of the housing, the starboard's 0.48
		port = arms["wire_1_sheave_port"].reshape(-1, 3)
		self.assertAlmostEqual(-(port[np.argmax(port[:, 0]), 2] + 16.5), 3.8 * np.sin(np.radians(27)) + 0.25 * np.cos(np.radians(27)), delta=0.12)
		# sunk with its sheave while the wire is not rigged, under the deck
		travel = self.ship["joints"]["wire_1_sheave_port"]["keys"][-1][1]
		sunk = self.model.parts(pose(self.ship["joints"], {"joints": {"wire_1_sheave_port": travel}}), materials=["arm"])
		self.assertLess(sunk["wire_1_sheave_port"].reshape(-1, 3)[:, 1].max(), 19.0 - 0.02)

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
		self.assertEqual(sorted(self.ship["joints"]), ["antenna_port_aft", "barricade_port", "catapult_1_deflector", "catapult_1_deflector_crank", "catapult_1_deflector_rod", "catapult_1_shuttle",
			"catapult_console_bow", "catapult_console_waist", "elevator_1", "wire_1_sheave_port", "wire_1_sheave_starboard", "wire_1_support_1"])
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
		quarter = sponson[np.isclose(sponson[:, 0], -90) | np.isclose(sponson[:, 0], -80)]   # its corners
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

	def test_sponson_details(self):
		# what stands on a sponson is built with it: the house's eight corners
		sponson = np.round(self.model.parts()["sponsons"].reshape(-1, 3), 4)
		for x in (-83.5, -81.5):
			for y in (12.0, 13.0):
				for z in (-14.5, -12.5):
					self.assertTrue((np.abs(sponson - [x, y, z]) < 1e-3).all(1).any(), (x, y, z))
		# and its faces wound outward, though the node it is merged into is not
		# closed as a whole (the railings' and catwalks' open parts)
		tri = self.model.parts()["sponsons"]
		middle = tri.mean(1)
		mine = (np.abs(middle[:, 0] + 82.5) < 1.001) & (np.abs(middle[:, 1] - 12.5) < 0.501) & (np.abs(middle[:, 2] + 13.5) < 1.001)
		normal = np.cross(tri[mine, 1] - tri[mine, 0], tri[mine, 2] - tri[mine, 0])
		self.assertEqual(mine.sum(), 12)
		self.assertTrue((((middle[mine] - [-82.5, 12.5, -13.5]) * normal).sum(1) > 0).all())

	def test_sponson_detail_slopes(self):
		# a prism under a sponson with a plan of its own at the top: its top
		# corners on that plan, its foot on its outline, so its forward face
		# slopes back from (-82, 8) to (-84, 7)
		sponson = np.round(self.model.parts()["sponsons"].reshape(-1, 3), 4)
		has = lambda q: (np.abs(sponson - q) < 1e-3).all(1).any()
		for z in (-19, -17):
			self.assertTrue(has([-82, 8, z]), z)
			self.assertTrue(has([-84, 7, z]), z)
			self.assertFalse(has([-82, 7, z]), z)

	def test_rounded_box(self):
		# a box rounded along x: its ends at -87 and -85, its section's corners
		# drawn in 0.2 (the tangent points), the sharp corner gone
		sponson = np.round(self.model.parts()["sponsons"].reshape(-1, 3), 4)
		has = lambda q: (np.abs(sponson - q) < 1e-3).all(1).any()
		for x in (-87, -85):
			self.assertTrue(has([x, 13.0, -17.7]), x)
			self.assertTrue(has([x, 12.8, -17.5]), x)
			self.assertTrue(has([x, 12.0, -18.3]), x)
			self.assertFalse(has([x, 13.0, -17.5]), x)
		locker = sponson[(sponson[:, 0] > -87.01) & (sponson[:, 0] < -84.99) & (sponson[:, 2] < -17.4) & (sponson[:, 1] > 11.99)]
		self.assertAlmostEqual(locker[:, 1].max(), 13.0, places=4)
		self.assertAlmostEqual(locker[:, 2].min(), -18.5, places=4)
		# and every face of it wound outward, its ends as well as its sides
		tri = self.model.parts()["sponsons"]
		middle = tri.mean(1)
		mine = (middle[:, 0] > -87.01) & (middle[:, 0] < -84.99) & (middle[:, 2] < -17.49) & (middle[:, 2] > -18.51) & (middle[:, 1] > 11.99) & (middle[:, 1] < 13.01)
		normal = np.cross(tri[mine, 1] - tri[mine, 0], tri[mine, 2] - tri[mine, 0])
		self.assertGreater(mine.sum(), 20)
		self.assertTrue((((middle[mine] - [-86.0, 12.5, -18.0]) * normal).sum(1) > 0).all())

	def test_dome_segments(self):
		# a dome of 8 segments round and 4 from pole to pole: 8 triangles at
		# each pole and 16 quads between, 48 triangles
		tri = self.model.parts()["sponsons"]
		middle = tri.mean(1)
		knob = np.linalg.norm(middle - [-88.5, 12.3, -13.0], axis=1) < 0.31
		self.assertEqual(knob.sum(), 48)

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
		# in two sections, nothing in its gap
		heights = set(np.round(bar[:, 1], 4))
		self.assertTrue({9.0, 12.0} <= heights, heights)
		self.assertFalse(((bar[:, 1] > 9.0 + 1e-4) & (bar[:, 1] < 12.0 - 1e-4)).any())
		# the walkway cut back round it: looking aft from the bar's aft face
		# down past the walkway's floor, fascia and member, nothing in the way
		walk = self.model.parts(materials=["grey", "rail"])["transom_fittings"]

		def blocked(origin, direction):
			# whether a ray meets a triangle (Moller-Trumbore)
			a, b, c = walk[:, 0], walk[:, 1], walk[:, 2]
			e1, e2 = b - a, c - a
			p = np.cross(direction, e2)
			det = np.einsum("ij,ij->i", e1, p)
			ok = np.abs(det) > 1e-12
			inv = np.where(ok, 1 / np.where(ok, det, 1), 0)
			s = origin - a
			u = np.einsum("ij,ij->i", s, p) * inv
			q = np.cross(s, e1)
			v = np.einsum("j,ij->i", direction, q) * inv
			t = np.einsum("ij,ij->i", e2, q) * inv
			return bool((ok & (u >= 0) & (v >= 0) & (u + v <= 1) & (t > 1e-6) & (t < 3)).any())
		for y in np.arange(5.25, 7.0, 0.1):
			for z in (1.85, 2.0, 2.15):
				self.assertFalse(blocked(np.array([-93.16, y, z]), np.array([-1.0, 0, 0])), (y, z))
		self.assertTrue(blocked(np.array([-93.16, 6.5, 0.0]), np.array([-1.0, 0, 0])))   # beside the cut, the fascia
		# the fascia along the cut's sides stands out into the cut, not into
		# the walkway; none along the ledge's edge, where the bar stands
		fascia = fittings[np.isclose(fittings[:, 1], 6.0, atol=1e-4) | np.isclose(fittings[:, 1], 6.9, atol=1e-4)]
		for z in (1.6, 2.4):
			self.assertTrue((np.abs(fascia[:, 2] - z) < 1e-4).any(), z)
		for z in (1.4, 2.6):
			self.assertFalse(((np.abs(fascia[:, 2] - z) < 1e-4) & (fascia[:, 0] > -93.9)).any(), z)
		self.assertFalse(blocked(np.array([-93.5, 6.5, 2.0]), np.array([1.0, 0, 0])))   # none on the ledge's edge
		# its railing in two lines: on both sides of the cut, none across it
		rail = self.model.parts(materials=["rail"])["transom_fittings"].reshape(-1, 3)
		rail = rail[(rail[:, 0] < -92.5) & (rail[:, 1] > 7.0)]
		self.assertTrue((rail[:, 2] < 1.6).any() and (rail[:, 2] > 2.4).any())
		self.assertFalse(blocked(np.array([-93.5, 7.5, 2.0]), np.array([1.0, 0, 0])))
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
		# and named for the photo match at its centre, as its `mark` asks
		self.assertEqual(self.features["landmarks"]["transom_ring"], {"at": [-88, 8.5, 2], "node": "transom_fittings"})

	def test_bent_railing(self):
		# a railing bent round a rounded corner: its posts evenly along the
		# whole of it (5.79 m at 1.5: five, 1.45 m apart), not one at each end
		# of the corner's short runs; its rails round the corner
		rail = self.model.parts(materials=["rail"])["transom_fittings"].reshape(-1, 3)
		bend = rail[(rail[:, 0] > -91.1) & (rail[:, 0] < -88.4) & (rail[:, 2] < 0.1) & (rail[:, 1] > 7.9) & (rail[:, 1] < 9.1)]
		feet = bend[np.isclose(bend[:, 1], 8.0, atol=1e-4)][:, [0, 2]]
		posts = []
		for p in feet[np.lexsort((feet[:, 1], feet[:, 0]))]:
			if not any(math.dist(p, q) < 0.1 for q in posts):
				posts.append(p)
		posts = [np.mean(feet[np.linalg.norm(feet - p, axis=1) < 0.1], axis=0) for p in posts]
		self.assertEqual(len(posts), 5)
		gaps = [min(math.dist(p, q) for q in posts if q is not p) for p in posts]
		self.assertGreater(min(gaps), 1.0)
		# the top rail passes through the corner's middle, 0.5 from its centre
		top = bend[np.isclose(bend[:, 1], 9.0, atol=0.03)]
		middle = np.array([-90.5 - 0.5 * math.cos(math.radians(45)), -3.0 - 0.5 * math.sin(math.radians(45))])
		self.assertLess(np.linalg.norm(top[:, [0, 2]] - middle, axis=1).min(), 0.04)

	def test_ring_sweep(self):
		# a deck circle the deck's edge cuts: only its swept arc, from forward
		# round to starboard, lying on the sloping deck its facing gives, and
		# closed at either end
		triangles = self.model.parts(materials=["white"])["transom_fittings"]
		points = triangles.reshape(-1, 3)
		centre, normal = np.array([-93, 7.3, -3]), np.array([0.1, 1, 0]) / np.linalg.norm([0.1, 1, 0])
		offset = points - centre
		height = offset @ normal
		self.assertGreater(height.min(), -1e-4)
		self.assertLess(height.max(), 0.02 + 1e-4)
		across = offset - np.outer(height, normal)
		radius = np.linalg.norm(across, axis=1)
		self.assertAlmostEqual(radius.min(), 0.8, places=3)
		self.assertAlmostEqual(radius.max(), 1.0, places=3)
		angle = np.degrees(np.arctan2(across[:, 2], across[:, 0])).reshape(-1, 3)
		self.assertAlmostEqual(angle.min(), 0.0, places=2)
		self.assertAlmostEqual(angle.max(), 90.0, places=2)
		# twelve segments of four faces and an end face at either end
		self.assertEqual(len(triangles), (12 * 4 + 2) * 2)
		self.assertEqual(int((np.ptp(angle, axis=1) < 1e-3).sum()), 4)

	def test_sloped_sponson(self):
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
		# grey above it, but for the bow's end cap: where the rising stem
		# crosses the boot top a section carries the band's edge round it
		grey = self.faces("hull", materials=["hull"])[0]
		self.assertGreaterEqual(grey[(np.abs(grey[:, :, 0] + 90) < 1e-3).all(1)][:, :, 1].min(), 1.0 - 1e-4)   # the transom above the boot top
		sides = grey[~((np.abs(grey[:, :, 0] + 90) < 1e-3).all(1) | (grey[:, :, 0] > 100 - 1e-3).all(1))].reshape(-1, 3)
		self.assertGreaterEqual(sides[:, 1].min(), 1.0 - 1e-4)


class SquareStepTest(unittest.TestCase):
	# the fixture with its port deck edge stepping out square at x -80, z -36
	# aft of it and -40 forward
	@classmethod
	def setUpClass(cls):
		layout = json.loads(json.dumps(LAYOUT))
		outline = layout["deck"]["outline"]
		assert outline[0] == [-100, -40]
		layout["deck"]["outline"] = [[-100, -36], [-80, -36], [-80, -40]] + outline[1:]
		build(cls, layout)

	@classmethod
	def tearDownClass(cls):
		cls.folder.cleanup()

	def test_hull_steps_square_under_the_edge(self):
		# the hull widens to the edge forward of the step in a face across
		# the ship at the step, not sloping back to the section before it:
		# no face reaching past the narrow edge lies aft of the step
		hull = self.model.parts()["hull"]
		wide = hull[(hull[:, :, 2] < -36.5).any(axis=1) & (hull[:, :, 0] < -60).all(axis=1)]
		self.assertGreater(len(wide), 0)
		self.assertGreater(wide[:, :, 0].min(), -80.0101)
		narrow = hull[(hull[:, :, 0] < -80.02).all(axis=1)]
		self.assertGreater(narrow[:, :, 2].min(), -36.0001)


class QuarterTest(unittest.TestCase):
	# the fixture with a port quarter from its wall's forward end at x -55 aft
	# to -89, a metre short of the transom: the wall run aft to the quarter
	# sponson's forward end at -80, and the deck notched over the sponson to
	# its inboard edge (z -12) aft of -80. Its sections: knuckle, (7, -20),
	# (8, -30) at -55, out to the wall's foot (8, -36); (7, -13), (7.5, -16) at
	# -89, the knee outboard of the sponson's inboard edge and below its
	# bottom (8)
	@classmethod
	def setUpClass(cls):
		layout = json.loads(json.dumps(LAYOUT))
		outline = layout["deck"]["outline"]
		assert outline[0] == [-100, -40]
		layout["deck"]["outline"] = [[-100, -12], [-80, -12], [-80, -40]] + outline[1:]
		hull = layout["hull"]
		hull["walls"]["port"] = [{"wall": [[-80, -36], [-55, -36]], "foot": 8.0}]
		hull["quarters"] = {"port": [{"x": -55, "points": [[7, -20], [8, -30]]}, {"x": -89, "points": [[7, -13], [7.5, -16]]}]}
		# and the bow's shoulders (ShoulderTest's), so every section carries
		# their points, under the wall and along the quarter on the last point
		# before the foot
		hull["stations"][-1]["points"] += [[10, 22], [14, 26]]
		hull["shoulders"] = {"start": 52, "full": 58}
		build(cls, layout)

	@classmethod
	def tearDownClass(cls):
		cls.folder.cleanup()

	def ring(self, x):
		# the port side of the hull's section nearest x, and its x
		points = self.model.parts()["hull"].reshape(-1, 3)
		x = points[np.argmin(np.abs(points[:, 0] - x))][0]
		ring = np.unique(np.round(points[np.abs(points[:, 0] - x) < 1e-4], 4), axis=0)
		return x, ring[ring[:, 2] < 1e-6]

	def has(self, ring, y, z):
		return bool((np.linalg.norm(ring[:, 1:] - [y, z], axis=1) < 1e-3).any())

	def test_section_under_the_wall(self):
		# near -65, some 10/34 of the way aft: the knuckle (6, about -15: the
		# transom's 10 at -90 widening to 16 at -60), then the quarter's points
		# straight between its sections, the wall's foot and up the wall
		x, ring = self.ring(-65)
		t = (-55 - x) / 34
		for y, z in ((6, -(10 + 6 * (x + 90) / 30)), (7, -20 + 7 * t), (8 - 0.5 * t, -30 + 14 * t), (8, -36), (18.4, -36)):
			self.assertTrue(self.has(ring, y, z), (y, z))
		# and nothing else between the knuckle and the foot: no slope straight
		# from one to the other
		self.assertEqual(len(ring[(ring[:, 1] > 6 + 1e-3) & (ring[:, 1] < 8 - 1e-3)]), 2)

	def test_section_under_the_sponson(self):
		# near -85 the knee (about 7.56, -17.65) lies outboard of the
		# sponson's inboard edge; the section runs back in to the sponson's
		# bottom there and up to the notch's edge
		x, ring = self.ring(-85)
		self.assertLess(x, -80)
		t = (-55 - x) / 34
		half = 10 + 6 * (x + 90) / 30   # the transom's 10 at -90 widening to 16 at -60
		for y, z in ((6, -half), (7, -20 + 7 * t), (8 - 0.5 * t, -30 + 14 * t), (8, -12), (18.4, -12)):
			self.assertTrue(self.has(ring, y, z), (y, z))
		self.assertAlmostEqual(ring[:, 2].min(), -30 + 14 * t, places=3)

	def test_ends_square(self):
		hull = self.model.parts()["hull"]
		# forward: the flare out to the deck's edge (z -40) reaches no further
		# aft than a centimetre past the wall's end
		wide = hull[(hull[:, :, 2] < -36.5).any(axis=1)]
		self.assertGreater(len(wide), 0)
		self.assertGreater(wide[:, :, 0].min(), -55.0101)
		# aft: behind the quarter's end nothing stands out past the notch's
		# edge, and the step across the ship at its end reaches the knee
		behind = hull[(hull[:, :, 0] < -89.005).all(axis=1)]
		self.assertGreater(behind[:, :, 2].min(), -12.0001)
		step = hull[(hull[:, :, 0] >= -89.0101).all(axis=1) & (hull[:, :, 0] <= -89 + 1e-4).all(axis=1)]
		self.assertAlmostEqual(step[:, :, 2].min(), -16, places=3)

	def test_landmarks(self):
		marks = self.features["landmarks"]
		half = 10 + 6 / 30
		self.assertEqual(marks["hull_quarter_port_knee"], {"at": [-89, 7.5, -16], "node": "hull"})
		self.assertEqual(marks["hull_quarter_port_knuckle"]["node"], "hull")
		np.testing.assert_allclose(marks["hull_quarter_port_knuckle"]["at"], [-89, 6.0, -half], atol=1e-3)

	def test_hull_stays_closed(self):
		# every edge crossed once each way, but the deck underside's, which the
		# deck closes, and the transom's section above its floor, which the
		# upper transom closes
		edges = {}
		for t in np.round(self.model.parts()["hull"], 4):
			for a, b in ((0, 1), (1, 2), (2, 0)):
				key = (tuple(t[a]), tuple(t[b]))
				edges[key] = edges.get(key, 0) + 1
		self.assertEqual(set(edges.values()), {1})
		open_ = [e for e in edges if (e[1], e[0]) not in edges]
		self.assertTrue(open_ and all((e[0][1] == 18.4 and e[1][1] == 18.4) or (e[0][0] == -90 and e[1][0] == -90 and min(e[0][1], e[1][1]) >= 5 - 1e-4)
			for e in open_))


class BowTest(unittest.TestCase):
	# the fixture with its stem's front rounded at a half-metre fillet, the
	# front 0.3 m in half-width at the waterline (from a knife edge 2 m down,
	# to 1 at y 5), and a bulb: below the waterline the stem's profile runs
	# from (75, 0) out to a nose at (76, -4) and back down to the keel at (60,
	# -8); head on the bulb is 2 m in half-breadth from y -6 to -4, 1 at -8 and
	# -2, 0.2 at -1; its nose 3 m long in plan where it is widest, its taper
	# from x 66 to 60
	@classmethod
	def setUpClass(cls):
		layout = json.loads(json.dumps(LAYOUT))
		hull = layout["hull"]
		hull["stem"] = [[60, -8], [70, -7.5], [74, -6], [76, -4], [75.5, -2], [75, 0], [95, 19.5]]
		hull["front"] = [[-2, 0.0], [0, 0.3], [5, 1.0]]
		hull["fillet"] = 0.5
		hull["bulb"] = {"outline": [[-8, 1.0], [-6, 2.0], [-4, 2.0], [-2, 1.0], [-1, 0.2]], "nose": 3.0, "taper": [66, 60]}
		build(cls, layout)

	@classmethod
	def tearDownClass(cls):
		cls.folder.cleanup()

	def corners(self, name, materials=None):
		return corners(self.model, name, materials)

	def ring(self, name, x):
		# a part's vertices in its section at x
		points = self.model.parts()[name].reshape(-1, 3)
		return points[np.abs(points[:, 0] - x) < 1e-4]

	def test_stem_front_rounds_into_the_sides(self):
		# the section near x 78.9 meets the stem at its foot's height (the
		# stem leaning from (75, 0) to (95, 19.5)), where the front's half-width
		# is y / 5: flat across to that less the fillet, then round a quarter
		# circle of 0.5 into the side while the stem lies within 0.5 ahead
		points = self.model.parts()["hull"].reshape(-1, 3)
		x = points[np.argmin(np.abs(points[:, 0] - 78.9))][0]
		ring = self.ring("hull", x)
		ring = ring[(ring[:, 2] >= 0) & (ring[:, 1] < 5 - 1e-6)]
		foot = (x - 75) * 19.5 / 20
		self.assertAlmostEqual(ring[:, 1].min(), foot, places=3)
		checked = 0
		for y, z in ring[(ring[:, 2] > 1e-6) & (ring[:, 1] > foot + 1e-3)][:, 1:]:
			ahead = 75 + y * 20 / 19.5
			width = 0.3 + 0.14 * y
			radius = min(0.5, width)
			if x > ahead - radius - 1e-9:
				u = (x - (ahead - radius)) / radius
				self.assertAlmostEqual(z, width - radius + radius * math.sqrt(max(0.0, 1 - u * u)), places=3, msg=y)
				checked += 1
		self.assertGreaterEqual(checked, 3)
		self.assertAlmostEqual(ring[np.abs(ring[:, 1] - foot) < 1e-4][:, 2].max(), 0.3 + 0.14 * foot - 0.5, places=3)

	def test_stem_round_where_it_stands_upright(self):
		# below the waterline the stem stands upright at x 75, its front 0.15
		# in half-width at y -1 and so wholly round: sections behind it at the
		# fillet's quarter-angles draw the round there
		hull = self.model.parts()["hull"].reshape(-1, 3)
		for k in (1, 2):
			x = 75 - 0.5 * (1 - math.cos(math.pi / 8 * k))
			ring = np.unique(np.round(hull[(np.abs(hull[:, 0] - x) < 1e-3) & (np.abs(hull[:, 1] + 1) < 1e-3) & (hull[:, 2] > 0)], 5), axis=0)
			self.assertEqual(len(ring), 1, k)
			u = (x - (75 - 0.15)) / 0.15
			self.assertAlmostEqual(ring[0, 2], 0.15 * math.sqrt(1 - u * u), places=3, msg=k)

	def test_bulb_section_is_its_outline(self):
		# at x 68, ahead of the taper and behind the nose, the section is the
		# outline head on: 2 m from y -6 to -4, from the forefoot's edge
		# (about -7.6) up to the waterline
		ring = self.ring("hull_bulb", 68)
		self.assertGreater(len(ring), 0)
		self.assertAlmostEqual(np.abs(ring[:, 2]).max(), 2.0, places=3)
		flat = ring[(ring[:, 1] > -5.9) & (ring[:, 1] < -4.1)]
		self.assertGreater(len(flat), 4)
		self.assertTrue(np.allclose(np.abs(flat[:, 2]), 2.0, atol=1e-3))
		self.assertAlmostEqual(ring[:, 1].max(), 0.0, places=4)
		self.assertTrue(-7.7 < ring[:, 1].min() < -7.5)
		# above the outline's top (y -1) the stem's front carries it up to the
		# waterline: 0.3 m there, from its knife edge at -2
		fin = ring[(ring[:, 1] > -0.9) & (np.abs(ring[:, 2]) > 1e-6)]
		self.assertGreater(len(fin), 1)
		self.assertTrue(np.allclose(np.abs(fin[:, 2]), 0.3 * (fin[:, 1] + 2) / 2, atol=1e-3))

	def test_bulb_nose_on_the_profile(self):
		# its forward edge is the stem's profile below the waterline, the nose
		# at (76, -4) on the centreline, and nothing ahead of it
		points = self.model.parts()["hull_bulb"].reshape(-1, 3)
		tip = points[np.argmax(points[:, 0])]
		np.testing.assert_allclose(tip, [76, -4, 0], atol=1e-3)
		# in plan a quarter ellipse 3 m long at its widest, from x 73: a metre
		# back from the nose, two thirds of the way along it
		ring = self.ring("hull_bulb", 75)
		self.assertGreater(len(ring), 0)
		at = ring[np.abs(ring[:, 1] + 4) < 0.2]
		self.assertGreater(len(at), 0)
		self.assertLess(np.abs(np.abs(at[:, 2]).max() - 2.0 * math.sqrt(1 - (2 / 3) ** 2)), 0.05)

	def test_bulb_profile_has_no_kinks(self):
		# from the side its forward edge runs through the profile's knots
		# without turning at them: its slope just below the knot at y -6 and
		# just above it alike (straight between the knots it would run 2.67
		# m/m below and 1 above)
		points = self.model.parts()["hull_bulb"].reshape(-1, 3)
		edge = points[(np.abs(points[:, 2]) < 1e-6) & (points[:, 1] > -7.2) & (points[:, 1] < -4.8) & (points[:, 0] > 70)]
		edge = edge[np.argsort(edge[:, 1])]
		below = edge[(edge[:, 1] > -6.8) & (edge[:, 1] < -6.0)]
		above = edge[(edge[:, 1] > -6.0) & (edge[:, 1] < -5.2)]
		self.assertGreater(len(below), 2)
		self.assertGreater(len(above), 2)
		slope = lambda p: np.polyfit(p[:, 1], p[:, 0], 1)[0]
		self.assertLess(abs(slope(below) / slope(above) - 1), 0.3)

	def test_bulb_tapers_into_the_forefoot(self):
		# half its breadth halfway along the taper (smoothstep), none at its end
		self.assertAlmostEqual(np.abs(self.ring("hull_bulb", 63)[:, 2]).max(), 1.0, places=3)
		end = self.ring("hull_bulb", 60)
		self.assertGreater(len(end), 0)
		self.assertLess(np.abs(end[:, 2]).max(), 1e-6)
		self.assertAlmostEqual(self.model.parts()["hull_bulb"][:, :, 0].min(), 60, places=4)

	def test_bulb_smooth_and_painted(self):
		tris, normals = self.corners("hull_bulb")
		# smooth: most triangles' corners turn with the surface
		turning = np.abs(normals - normals[:, :1]).max(axis=(1, 2)) > 1e-3
		self.assertGreater(turning.mean(), 0.5)
		# outward: on the starboard flank at its widest, the normals point to starboard
		flank = (np.abs(tris[:, :, 0] - 68) < 0.5).all(1) & (np.abs(tris[:, :, 1] + 5) < 0.8).all(1) & (tris[:, :, 2] > 1.9).all(1)
		self.assertTrue(flank.any() and (normals[flank][:, :, 2] > 0.9).all())
		# anti-fouling below its top (-3), boot above, the edge along a height
		# in every section that spans it (all behind the nose's last 0.5 m)
		red = self.corners("hull_bulb", ["antifouling"])[0]
		black = self.corners("hull_bulb", ["boot"])[0]
		self.assertGreater(len(red), 0)
		self.assertLessEqual(red[:, :, 1].max(), -3 + 1e-4)
		black = black[(black[:, :, 0] <= 75.5).all(1)]
		self.assertGreater(len(black), 0)
		self.assertGreaterEqual(black[:, :, 1].min(), -3 - 1e-4)

	def test_hull_smooth_below_its_knuckles(self):
		tris, normals = self.corners("hull")
		# below the knuckles, clear of the keel's edge: one normal at each point
		below = (tris[:, :, 1] > -7.9).all(1) & (tris[:, :, 1] < 4.9).all(1) & (np.abs(tris[:, :, 0]) < 50).all(1)
		self.assertGreater(below.sum(), 0)
		seen = {}
		for p, n in zip(np.round(tris[below].reshape(-1, 3), 4), normals[below].reshape(-1, 3)):
			seen.setdefault(tuple(p), []).append(n)
		self.assertTrue(all(np.abs(np.array(v) - v[0]).max() < 1e-3 for v in seen.values()))
		self.assertTrue((np.abs(normals[below] - normals[below][:, :1]).max(axis=(1, 2)) > 1e-3).any())
		# sharp where the plating turns more than 30 degrees: the flat keel's
		# corners face straight down
		keel = (np.abs(tris[:, :, 1] + 8) < 1e-4).all(1) & (np.abs(tris[:, :, 0]) < 50).all(1)
		self.assertTrue(keel.any() and (normals[keel][:, :, 1] < -0.999).all())
		# the port flare above its knuckle flat: each triangle's corners alike
		flare = (tris[:, :, 1] > 6.1).all(1) & (tris[:, :, 2] < -16.5).all(1) & (tris[:, :, 0] > -50).all(1) & (tris[:, :, 0] < 0).all(1)
		self.assertGreater(flare.sum(), 0)
		self.assertTrue((np.abs(normals[flare] - normals[flare][:, :1]).max(axis=(1, 2)) < 1e-4).all())
		# and the knuckle a crease: at its points the hull below and the flare
		# above turn different ways
		upper = (tris[:, :, 1] >= 6 - 1e-4).all(1) & (tris[:, :, 2] < -1).all(1) & (np.abs(tris[:, :, 0]) < 50).all(1)
		lower = (tris[:, :, 1] <= 6 + 1e-4).all(1) & (tris[:, :, 2] < -1).all(1) & (np.abs(tris[:, :, 0]) < 50).all(1)
		knuckle = lambda mask: {tuple(p): n for p, n in zip(np.round(tris[mask].reshape(-1, 3), 4), normals[mask].reshape(-1, 3)) if abs(p[1] - 6) < 1e-4}
		above, beneath = knuckle(upper), knuckle(lower)
		shared = set(above) & set(beneath)
		self.assertGreater(len(shared), 0)
		self.assertTrue(all(np.dot(above[p], beneath[p]) < math.cos(math.radians(10)) for p in shared))
		# the hull below keeps its own normal there, none of the flare's: the
		# midbody's side from (0, -15) up to the knuckle (6, -16)
		side = np.array([0, -1, -6]) / math.sqrt(37)
		middle = [p for p in shared if -50 < p[0] < 30]
		self.assertGreater(len(middle), 0)
		self.assertTrue(all(np.dot(beneath[p], side) > 0.9999 for p in middle))

	def test_hull_stays_closed(self):
		# the rounding's sections leave no gap, and no fin stands on the
		# centreline ahead of the stem where it stands upright (x 75, a knife
		# edge below the waterline), up to the first section where it leans
		# with its front round to a point (x 76.03, at the boot top, the
		# front's 0.44 within the fillet): every edge crossed once each way,
		# but the deck underside's and the transom's above its floor
		edges = {}
		hull = np.round(self.model.parts()["hull"], 4)
		self.assertFalse(((np.abs(hull[:, :, 2]) < 1e-4).all(1) & (hull[:, :, 0] > 75 + 1e-4).any(1)).any())
		for t in hull:
			for a, b in ((0, 1), (1, 2), (2, 0)):
				key = (tuple(t[a]), tuple(t[b]))
				edges[key] = edges.get(key, 0) + 1
		self.assertEqual(set(edges.values()), {1})
		open_ = [e for e in edges if (e[1], e[0]) not in edges]
		self.assertTrue(all((e[0][1] == 18.4 and e[1][1] == 18.4) or (e[0][0] == -90 and e[1][0] == -90 and min(e[0][1], e[1][1]) >= 5 - 1e-4)
			for e in open_))


class ShoulderTest(unittest.TestCase):
	# the fixture with the bow's shoulders from x 52, in full from 58, running
	# ahead of the last station by the share squared, and the station at x 60
	# carried on above the knuckles to (10, 22) and (14, 26):
	# the deck's edge at z 30 to starboard (the gallery's foot 16.4), -40 to
	# port (15.4); knuckles 5 to starboard, 6 to port. The shoulders' levels
	# are the station's heights above the lower knuckle: 6, 10 and 14
	@classmethod
	def setUpClass(cls):
		layout = json.loads(json.dumps(LAYOUT))
		hull = layout["hull"]
		assert hull["stations"][-1]["x"] == 60
		hull["stations"][-1]["points"] += [[10, 22], [14, 26]]
		hull["shoulders"] = {"start": 52, "full": 58, "power": 2}
		build(cls, layout)

	@classmethod
	def tearDownClass(cls):
		cls.folder.cleanup()

	def ring(self, x):
		# the hull's section nearest x, and its x
		points = self.model.parts()["hull"].reshape(-1, 3)
		x = points[np.argmin(np.abs(points[:, 0] - x))][0]
		return x, np.unique(np.round(points[np.abs(points[:, 0] - x) < 1e-4], 4), axis=0)

	def has(self, ring, y, z):
		return bool((np.linalg.norm(ring[:, 1:] - [y, z], axis=1) < 1e-3).any())

	def test_shoulders_follow_the_station(self):
		# at x 60 the flare runs from each knuckle through the station's
		# points at the levels above it to the gallery's foot
		x, ring = self.ring(60)
		self.assertAlmostEqual(x, 60, places=3)
		for y, z in ((5, 11.5), (6, 12), (10, 22), (14, 26), (16.4, 30), (6, -12), (10, -22), (14, -26), (15.4, -40)):
			self.assertTrue(self.has(ring, y, z), (y, z))

	def test_shoulders_ease_in(self):
		# halfway along the shoulders' start (x 55) the starboard flare at
		# each level lies the eased share (smoothstep) of the way from the
		# straight line, knuckle to foot, out to the stations' half-breadth
		x, ring = self.ring(55)
		self.assertTrue(52.5 < x < 57.5)
		t = (x - 52) / 6
		share = t * t * (3 - 2 * t)
		along = (x - 40) / 20   # between the stations at 40 and 60
		knuckle = 15 + 5 / 6 + along * (11.5 - 15 - 5 / 6)
		for y, station in ((10, 16 + along * 6), (14, 16 + along * 10)):
			straight = knuckle + (30 - knuckle) * (y - 5) / (16.4 - 5)
			self.assertTrue(self.has(ring, y, straight + share * (station - straight)), y)
		self.assertTrue(self.has(ring, 5, knuckle))
		# a section where they start, its levels on the straight line, and one
		# where they come in full, its levels on the stations'
		for x, share in ((52, 0.0), (58, 1.0)):
			at, ring = self.ring(x)
			self.assertAlmostEqual(at, x, places=3)
			along = (x - 40) / 20
			knuckle = 15 + 5 / 6 + along * (11.5 - 15 - 5 / 6)
			for y, station in ((10, 16 + along * 6), (14, 16 + along * 10)):
				straight = knuckle + (30 - knuckle) * (y - 5) / (16.4 - 5)
				self.assertTrue(self.has(ring, y, straight + share * (station - straight)), (x, y))

	def test_shoulders_hold_out_ahead_of_the_last_station(self):
		# near x 70 each level runs from the station at 60 toward the face's
		# crease at the stem there (the stem leaning from (75, 0) to (95,
		# 19.5); the face 2 wide at y 10, 10 at 18) by the share squared
		x, ring = self.ring(70)
		self.assertTrue(60 < x < 75)
		for y, station, crease in ((10, 22, 2), (14, 26, 6)):
			share = (x - 60) / (75 + y * 20 / 19.5 - 60)
			self.assertTrue(self.has(ring, y, station + (crease - station) * share ** 2), y)

	def test_flare_straight_aft_of_them(self):
		# aft of x 52 nothing stands between the knuckle and the gallery's
		# foot: the flare runs straight
		x, ring = self.ring(48)
		self.assertLess(x, 52)
		starboard = ring[ring[:, 2] > 1e-6]
		self.assertEqual(len(starboard[(starboard[:, 1] > 5 + 1e-3) & (starboard[:, 1] < 16.4 - 1e-3)]), 0)

	def test_shoulders_smooth(self):
		# over the shoulders the flare is shaded smooth, one normal at each
		# point; aft of them flat
		tris, normals = corners(self.model, "hull")
		forward = (tris[:, :, 0] >= 58 - 1e-4).all(1) & (tris[:, :, 0] <= 60 + 1e-4).all(1) & (tris[:, :, 1] > 6.5).all(1) & (tris[:, :, 1] < 15).all(1) & (tris[:, :, 2] > 0).all(1)
		self.assertGreater(forward.sum(), 0)
		seen = {}
		for p, n in zip(np.round(tris[forward].reshape(-1, 3), 4), normals[forward].reshape(-1, 3)):
			seen.setdefault(tuple(p), []).append(n)
		shared = [v for v in seen.values() if len(v) > 1]
		self.assertGreater(len(shared), 0)
		self.assertTrue(all(np.abs(np.array(v) - v[0]).max() < 1e-3 for v in shared))
		self.assertTrue((np.abs(normals[forward] - normals[forward][:, :1]).max(axis=(1, 2)) > 1e-3).any())
		aft = ((tris[:, :, 0] > 42).all(1) & (tris[:, :, 0] < 50).all(1) & (tris[:, :, 1] >= 5 - 1e-4).all(1) & (tris[:, :, 1] <= 16.4 + 1e-4).all(1)
			& (tris[:, :, 1] > 5.5).any(1) & (tris[:, :, 2] > 0).all(1))
		self.assertGreater(aft.sum(), 0)
		self.assertTrue((np.abs(normals[aft] - normals[aft][:, :1]).max(axis=(1, 2)) < 1e-4).all())

	def test_hull_stays_closed(self):
		edges = {}
		for t in np.round(self.model.parts()["hull"], 4):
			for a, b in ((0, 1), (1, 2), (2, 0)):
				key = (tuple(t[a]), tuple(t[b]))
				edges[key] = edges.get(key, 0) + 1
		self.assertEqual(set(edges.values()), {1})
		open_ = [e for e in edges if (e[1], e[0]) not in edges]
		self.assertTrue(all((e[0][1] == 18.4 and e[1][1] == 18.4) or (e[0][0] == -90 and e[1][0] == -90 and min(e[0][1], e[1][1]) >= 5 - 1e-4)
			for e in open_))


class AnchorTest(unittest.TestCase):
	# the fixture with its anchors: the starboard one's crown at (72, 4, 10),
	# its stock 0.2 across from (71, 2, 8) to (73, 6, 12) with a knob 0.3
	# across at each end, the crown's block 0.6 along the stock, 0.5 across and
	# 0.4 deep, chamfered 0.02, a pin 0.1 across standing 0.08 out of it, its
	# frame reaching 1.2 from the crown and 0.8 wide, a loop of bar 0.1 across
	# and 0.2 deep (chamfered alike); the hawse pipe a rounded square (power 4) 1.6
	# across and 1.2 high, rolled 0.3 rad, running up and aft (-0.6, 0.8, 0)
	# from its mouth at (73, 4.6, 9.4), cut level (opening straight down),
	# closed 3 m in by a dome 0.4 deep, its lip 0.1 round, its bore dark 1 m
	# in; the port one its mirror image
	SPEC = {"crown": [72, 4, 10], "stock": {"ends": [[71, 2, 8], [73, 6, 12]], "diameter": 0.2, "knob": 0.3},
		"block": [0.6, 0.5, 0.4], "frame": {"reach": 1.2, "width": 0.8, "bar": 0.1, "depth": 0.2}, "shank": 0.3, "chamfer": 0.02,
		"pin": {"diameter": 0.1, "length": 0.08},
		"hawse": {"mouth": [73, 4.6, 9.4], "axis": [-0.6, 0.8, 0], "facing": [0, -1, 0], "width": 1.6, "height": 1.2, "power": 4,
			"roll": 0.3, "lip": 0.1, "length": 3.0, "dome": 0.4, "depth": 1.0},
		"colour": {"anchor": [190, 168, 131], "rust": [165, 115, 55], "umber": [115, 75, 30]}}

	@classmethod
	def setUpClass(cls):
		layout = json.loads(json.dumps(LAYOUT))
		layout["anchors"] = cls.SPEC
		build(cls, layout)

	@classmethod
	def tearDownClass(cls):
		cls.folder.cleanup()

	def points(self, paint):
		tris, normals = corners(self.model, "anchors", [paint])
		points = tris.reshape(-1, 3)
		return points[points[:, 2] > 0], tris, normals

	def crown(self):
		# the crown's frame of reference: along the stock, away from the
		# mouth across it, and through both
		crown, mouth = np.array([72, 4, 10.0]), np.array([73, 4.6, 9.4])
		along = np.array([2, 4, 4.0]) / 6
		toward = mouth - crown
		away = -(toward - along * (toward @ along))
		away /= np.linalg.norm(away)
		return crown, along, away, np.cross(along, away)

	def test_landmarks(self):
		marks = self.features["landmarks"]
		for name, side in (("starboard", 1), ("port", -1)):
			for mark, p in (("crown", [72, 4, 10]), ("stock_top", [73, 6, 12]), ("stock_bottom", [71, 2, 8])):
				self.assertEqual(marks[f"anchor_{mark}_{name}"]["node"], "anchors")
				np.testing.assert_allclose(marks[f"anchor_{mark}_{name}"]["at"], [p[0], p[1], side * p[2]], atol=1e-4)

	def test_stock_round_with_a_knob_at_each_end(self):
		# the stock's ends: its rim 0.1 from the end's centre, square to the
		# stock, and its knob's surface 0.15 round the end
		starboard, tris, normals = self.points("anchor")
		far = starboard[np.linalg.norm(starboard - [72, 4, 10], axis=1) > 1.6]
		along = np.array([2, 4, 4.0]) / 6
		for end in ([71, 2, 8], [73, 6, 12]):
			near = far[np.linalg.norm(far - end, axis=1) < 0.2]
			found = set(np.round(np.linalg.norm(near - end, axis=1), 3))
			self.assertEqual(found, {0.1, 0.15}, end)
			rim = near[np.abs(np.linalg.norm(near - end, axis=1) - 0.1) < 1e-3]
			self.assertTrue(np.allclose((rim - end) @ along, 0, atol=1e-3))
		# the port anchor the starboard one's mirror image
		every = tris.reshape(-1, 3)
		port = np.unique(np.round(every[every[:, 2] < 0] * [1, 1, -1], 4), axis=0)
		self.assertTrue(np.array_equal(port, np.unique(np.round(starboard, 4), axis=0)))
		# the knobs smooth: their corners' normals turn across a face
		knob = (np.linalg.norm(tris - [73, 6, 12], axis=2) > 0.149).all(1) & (np.linalg.norm(tris - [73, 6, 12], axis=2) < 0.151).all(1)
		self.assertTrue(knob.any())
		self.assertTrue((np.abs(normals[knob] - normals[knob][:, :1]).max(axis=(1, 2)) > 1e-3).any())

	def test_crown_block_and_frame(self):
		crown, along, away, through = self.crown()
		local = lambda p: np.stack([(p - crown) @ along, (p - crown) @ away, (p - crown) @ through], -1)
		anchor = np.round(local(self.points("anchor")[0]), 3)
		def found(points, p):
			return (np.abs(points - p) < 1e-3).all(1).any()
		# the block: each corner cut back 0.02 on its three faces, the corner
		# itself gone
		for i, j, k in itertools.product((-1, 1), repeat=3):
			for p in ((0.3, 0.23, 0.18), (0.28, 0.25, 0.18), (0.28, 0.23, 0.2)):
				self.assertTrue(found(anchor, [i * p[0], j * p[1], k * p[2]]), (i, j, k, p))
			self.assertFalse(found(anchor, [i * 0.3, j * 0.25, k * 0.2]))
		# the pin: 0.1 across, out of the block's outer face (away from the
		# pipe's run into the hull) to 0.08 past it
		outward = 1 if through @ -np.array([-0.6, 0.8, 0]) > 0 else -1
		rim = anchor[np.abs(anchor[:, 2] - outward * 0.28) < 1e-3]
		self.assertGreaterEqual(len(rim), 12)
		np.testing.assert_allclose(np.linalg.norm(rim[:, :2], axis=1), 0.05, atol=1e-3)
		# the frame: from the block's edge out to 1.2, 0.8 wide, 0.2 deep
		rust, tris, normals = self.points("rust")
		umber, inner, _ = self.points("umber")
		r = local(np.concatenate([rust, umber]))
		np.testing.assert_allclose([r[:, 0].min(), r[:, 0].max(), r[:, 1].min(), r[:, 1].max(), r[:, 2].min(), r[:, 2].max()],
			[-0.4, 0.4, 0.25, 1.2, -0.1, 0.1], atol=1e-3)
		# open in its middle: no face of it across the slot's centre
		middle = (0.25 + 1.2) / 2
		every = np.concatenate([tris, inner])
		t = local(every[every[:, :, 2].min(1) > 0].reshape(-1, 3)).reshape(-1, 3, 3)[:, :, :2] - [0, middle]
		cross = lambda u, v: u[:, 0] * v[:, 1] - u[:, 1] * v[:, 0]
		signs = np.stack([cross(t[:, (k + 1) % 3] - t[:, k], -t[:, k]) for k in range(3)], 1)
		covered = (signs > 1e-9).all(1) | (signs < -1e-9).all(1)
		self.assertFalse(covered.any())
		# a loop of bar 0.1 across: umber on the faces that look into the slot,
		# rust outside and on its flat faces
		def on(faces, p):
			# whether point p (crown-local) lies on one of the starboard triangles
			faces = local(faces[faces[:, :, 2].min(1) > 0].reshape(-1, 3)).reshape(-1, 3, 3)
			n = np.cross(faces[:, 1] - faces[:, 0], faces[:, 2] - faces[:, 0])
			n /= np.linalg.norm(n, axis=1)[:, None]
			flat = np.abs(((p - faces[:, 0]) * n).sum(1)) < 1e-4
			sides = [((np.cross(faces[:, (k + 1) % 3] - faces[:, k], p - faces[:, k])) * n).sum(1) for k in range(3)]
			return bool((flat & (np.stack(sides, 1) >= -1e-9).all(1)).any())
		for p in ((-0.3, middle, 0), (0.3, middle, 0), (0, 0.35, 0), (0, 1.1, 0)):
			self.assertTrue(on(inner, np.array(p)), p)
			self.assertFalse(on(tris, np.array(p)), p)
		for p in ((-0.4, middle, 0), (0.4, middle, 0), (0, 0.25, 0), (0, 1.2, 0), (-0.35, middle, 0.1), (0, 0.3, -0.1)):
			self.assertTrue(on(tris, np.array(p)), p)
			self.assertFalse(on(inner, np.array(p)), p)
		# the shank, 0.3 square and chamfered, from the crown up into the bore,
		# half its depth (1 m) in, on the crown's side of it as far as leaves the
		# shank's half and 0.1 m inside the bore (0.6 high, its bore 5/7 of
		# that): 0.179 off the axis toward the crown
		mouth, axis = np.array([73, 4.6, 9.4]), np.array([-0.6, 0.8, 0])
		offset = crown - mouth
		offset -= axis * (offset @ axis)
		end = mouth + axis * 0.5 + offset * ((0.6 * 5 / 7 - 0.15 - 0.1) / np.linalg.norm(offset))
		run = (end - crown) / np.linalg.norm(end - crown)
		anchor = np.unique(np.round(self.points("anchor")[0], 4), axis=0)
		near = anchor[np.linalg.norm(anchor - end, axis=1) < 0.25]
		self.assertEqual(len(near), 12)
		self.assertEqual(set(np.round((near - end) @ run, 3)), {0.0, -0.02})
		across = near - end - np.outer((near - end) @ run, run)
		np.testing.assert_allclose(np.sort(np.round(np.linalg.norm(across, axis=1), 3)), [0.184] * 4 + [0.198] * 8, atol=1e-3)

	def test_hawse_hood_cut_on_the_slant(self):
		mouth, axis, facing = np.array([73, 4.6, 9.4]), np.array([-0.6, 0.8, 0.0]), np.array([0, -1.0, 0])
		# the section's frame: across level (axis x up) turned 0.3 rad toward
		# axis x level, the height square to both
		level = np.cross(axis, [0, 1, 0])
		level /= np.linalg.norm(level)
		across = level * math.cos(0.3) + np.cross(axis, level) * math.sin(0.3)
		high = np.cross(axis, across)
		def radial(p):
			# the superellipse's radius in metres of the mean half-size (0.7):
			# 0.7 on the pipe's outside, 0.5 on the bore
			v = p - mouth
			return 0.7 * ((np.abs(v @ across) / 0.8) ** 4 + (np.abs(v @ high) / 0.6) ** 4) ** 0.25
		grey = self.points("grey")[0]
		self.assertGreater(len(grey), 0)
		r = radial(grey)
		# the pipe a rounded square outside, 1.6 across and 1.2 high, the lip
		# rolling in to the bore
		self.assertAlmostEqual(r.max(), 0.7, places=3)
		self.assertTrue(np.isclose(r, 0.7, atol=1e-3).any() and np.isclose(r, 0.5, atol=1e-3).any())
		outside = grey[np.isclose(r, 0.7, atol=1e-3)] - mouth
		np.testing.assert_allclose([np.abs(outside @ across).max(), np.abs(outside @ high).max()], [0.8, 0.6], atol=1e-3)
		# square-shouldered, not an ellipse: near 45 degrees round it stands
		# well out past the ellipse through the same ends
		ellipse = np.sqrt((outside @ across / 0.8) ** 2 + (outside @ high / 0.6) ** 2)
		self.assertGreater(ellipse.max(), 1.15)
		# the lip's crest (0.6 out) all on the level plane through the mouth:
		# the mouth opens straight down, though the pipe leans
		crest = grey[np.isclose(r, 0.6, atol=1e-3)]
		self.assertGreaterEqual(len(crest), 32)
		self.assertTrue(np.allclose((crest - mouth) @ facing, 0, atol=1e-3))
		# the lip rolled: its crest 0.1 out of the mouth past the end of the
		# pipe's outside and the bore's mouth on the same side
		def direction(p):
			v = p - mouth
			v = v - np.outer(v @ axis, axis)
			return v / np.linalg.norm(v, axis=1)[:, None]
		for edge in (0.7, 0.5):
			ring = grey[np.isclose(r, edge, atol=1e-3)]
			same = direction(crest) @ direction(ring).T > 1 - 1e-6
			out = (crest[:, None] - ring[None]) @ -axis
			rise = np.where(same, np.abs(out), np.inf).min(1)
			np.testing.assert_allclose(rise, 0.1, atol=1e-3)
		# closed 3 m in by a dome 0.4 deep: each angle's line slid along the
		# axis as the mouth's slant slides it, its section shrinking on a
		# quarter ellipse to a tip on the axis 3.4 in
		v = grey - mouth
		radius = v - np.outer(v @ axis, axis)
		slide = -0.6 * (radius @ facing) / np.maximum(r, 1e-9) / -(axis @ facing)
		inward = v @ axis + slide
		dome = (inward > 3 + 1e-6) & (r > 1e-3)
		self.assertGreater(dome.sum(), 32)
		np.testing.assert_allclose((r[dome] / 0.7) ** 2 + ((inward[dome] - 3) / 0.4) ** 2, 1, atol=1e-3)
		self.assertTrue((np.linalg.norm(grey - (mouth + axis * 3.4), axis=1) < 1e-3).any())
		# the bore dark, 0.5 round, to its bottom 1 m in along the pipe
		dark = self.points("dark")[0]
		self.assertEqual(set(np.round(radial(dark), 3)), {0.0, 0.5})
		bottom = dark[radial(dark) < 1e-3]
		np.testing.assert_allclose(bottom, [mouth + axis * 1.0] * len(bottom), atol=1e-3)
		# the port hood the starboard one's mirror image
		every = corners(self.model, "anchors", ["grey"])[0].reshape(-1, 3)
		port = np.unique(np.round(every[every[:, 2] < 0] * [1, 1, -1], 4), axis=0)
		self.assertTrue(np.array_equal(port, np.unique(np.round(grey, 4), axis=0)))


def alike(a, b):
	# Two glbs the same but for what a build does not yet keep from run to run
	# (#94): the order of their triangles (each primitive's indices compared as
	# a set of triangles) and their normals to 2e-4
	def parts(data):
		n = int.from_bytes(data[12:16], "little")
		gltf, start = json.loads(data[20 : 20 + n]), 20 + n
		return gltf, data[start + 8 : start + 8 + int.from_bytes(data[start : start + 4], "little")]

	(ga, ba), (gb, bb) = parts(a), parts(b)
	views = lambda g: {k: v for k, v in g.items() if k not in ("bufferViews", "buffers")}
	if views(ga) != views(gb):
		return False
	indices = {p["indices"] for m in ga["meshes"] for p in m["primitives"] if "indices" in p}
	normals = {p["attributes"]["NORMAL"] for m in ga["meshes"] for p in m["primitives"] if "NORMAL" in p["attributes"]}
	kinds = {5126: np.float32, 5125: np.uint32, 5123: np.uint16, 5121: np.uint8}
	for i, (x, y) in enumerate(zip(ga["accessors"], gb["accessors"])):
		if "bufferView" not in x:
			continue
		def values(g, d, a):
			v = g["bufferViews"][a["bufferView"]]
			return np.frombuffer(d, kinds[a["componentType"]], v["byteLength"] // np.dtype(kinds[a["componentType"]]).itemsize, v.get("byteOffset", 0))
		u, w = values(ga, ba, x), values(gb, bb, y)
		if i in indices:
			u, w = np.sort(np.sort(u.reshape(-1, 3), 1), 0), np.sort(np.sort(w.reshape(-1, 3), 1), 0)
		if u.shape != w.shape or not (np.allclose(u, w, atol=2e-4, rtol=0) if i in normals else np.array_equal(u, w)):
			return False
	for x, y in zip(ga.get("images", []), gb.get("images", [])):
		v, w = ga["bufferViews"][x["bufferView"]], gb["bufferViews"][y["bufferView"]]
		if ba[v.get("byteOffset", 0) : v.get("byteOffset", 0) + v["byteLength"]] != bb[w.get("byteOffset", 0) : w.get("byteOffset", 0) + w["byteLength"]]:
			return False
	return True


class CacheTest(unittest.TestCase):
	# The weathered atlases kept between builds (build.py --cache): a build
	# whose groups' inputs are unchanged takes them from the cache and makes the
	# same model, byte for byte; a change re-bakes the groups it reaches, and
	# only those
	@classmethod
	def setUpClass(cls):
		cls.folder = tempfile.TemporaryDirectory()
		cls.cache = Path(cls.folder.name) / "cache"

	@classmethod
	def tearDownClass(cls):
		cls.folder.cleanup()

	def build(self, layout, name):
		where = Path(self.folder.name) / name
		where.mkdir()
		(where / "facts.json").write_text(json.dumps({"layout": layout}))
		run = subprocess.run(["blender", "-b", "--factory-startup", "--python-use-system-env", "-P", str(HERE / "build.py"), "--",
			str(where / "ford.glb"), str(where / "ford.json"), "--facts", str(where / "facts.json"), "--cache", str(self.cache)],
			capture_output=True, text=True)
		if run.returncode or "Traceback" in run.stdout + run.stderr:
			raise RuntimeError(run.stdout[-3000:] + run.stderr[-3000:])
		said = dict(re.findall(r"^weathered (\w+): (baked|from the cache)", run.stdout, re.M))
		return (where / "ford.glb").read_bytes(), {group: way == "baked" for group, way in said.items()}

	def test_cached_atlases(self):
		# the island's box doubled, its faces twice over, as a model's can be
		base = json.loads(json.dumps(LAYOUT))
		base["island"]["details"].append(dict(base["island"]["details"][3]))
		first, baked = self.build(base, "first")
		self.assertEqual(baked, {"island": True, "domes": True, "hull": True, "boot": True})
		# again: every group from the cache, the same model
		again, baked = self.build(base, "again")
		self.assertEqual(baked, {"island": False, "domes": False, "hull": False, "boot": False})
		self.assertTrue(alike(again, first))
		# the port sheave's arm turned, 20 m from any weathered face: still all cached
		turned = json.loads(json.dumps(base))
		turned["landing"]["sheaves"][0]["arm"]["angle"] = 20
		model, baked = self.build(turned, "turned")
		self.assertEqual(baked, {"island": False, "domes": False, "hull": False, "boot": False})
		self.assertNotEqual(model, first)
		# the port whip moved from the port deck edge to the island's forward
		# face: the faces it left and the faces it came to re-bake, the radomes
		# on the roof and the boot top at the waterline do not
		moved = json.loads(json.dumps(base))
		moved["antennas"][0]["base"] = [-4.5, 24]
		_, baked = self.build(moved, "moved")
		self.assertEqual(baked, {"island": True, "domes": False, "hull": True, "boot": False})
		# the hull's own spec changed: the hull alone
		framed = json.loads(json.dumps(base))
		framed["weathering"]["groups"][2]["frames"] = 0.8
		_, baked = self.build(framed, "framed")
		self.assertEqual(baked, {"island": False, "domes": False, "hull": True, "boot": False})


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
