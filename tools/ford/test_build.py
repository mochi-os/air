# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# Tests for build.py: the frame, the joints' signs, the deck's paint mapping
# and the ship file, on a small deck built in Blender; and the provenance rule.
#
# usage: systemd-run --user --collect --wait --pipe --quiet --slice=probe.slice -p MemoryMax=6G -p MemorySwapMax=0 python3 -I /home/alistair/mochi/apps/air/tools/ford/test_build.py
import json, re, subprocess, sys, tempfile, unittest
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "verify"))
from model import Model, pose  # noqa: E402

# A deck lopsided on purpose, so a flipped axis shows: it reaches 40 m to port
# and 30 m to starboard, with a notch for one starboard elevator
DECK = {"height": 19.0, "thickness": 0.6,
	"outline": [[-100, -40], [100, -40], [100, 30], [20, 30], [20, 20], [0, 20], [0, 30], [-100, 30]],
	"texture": {"x": [-110, 110], "z": [-45, 35], "pixels": [220, 80]},
	"marks": {"bow_port": [100, -40]}}
LAYOUT = {
	"deck": DECK,
	"elevators": [{"number": 1, "side": 1, "outline": [[0, 20], [20, 20], [20, 30], [0, 30]], "thickness": 0.9, "travel": 8.0}],
	# a catapult on the bow, angled 5 degrees to port
	"catapults": [{"number": 1, "track": [[0, -10], [90, -10 - 90 * np.tan(np.radians(5))]], "battery": [10, -10.875], "stroke": 90.0,
		# its hinge skewed 0.5 m forward at the starboard end, square to neither track nor ship
		"deflector": {"hinge": [[5, -15.44], [5.5, -5.44]], "depth": 5}, "cab": [12, -2]}],
	"fittings": {"shuttle": {"length": 1.2, "width": 0.4, "height": 0.25},
		"deflector": {"thickness": 0.3, "angle": 50},
		"cab": {"length": 3, "width": 2, "height": 2, "rise": 1.5}},
	"paint": {"deck": [60, 60, 60]},
	"markings": [],
	# an island: a block whose sides lean in, a radome on its plinth, a mast
	"island": {"prisms": [{"name": "block", "bottom": 19.0, "top": 31.0, "outline": [[-20, 20], [-5, 20], [-5, 28], [-20, 28]],
		"upper": [[-19, 21], [-6, 21], [-6, 27], [-19, 27]]}],
		"domes": [{"name": "radar", "centre": [-12, 33.0, 24], "radius": 1.5, "plinth": 2.0}],
		"poles": [{"name": "mast", "base": [-12, 24], "bottom": 31.0, "top": 45.0, "radius": 0.5}]},
	# a hull 8 m deep: 30 m on the waterline amidships, narrowing to 18 at
	# x 60 and to its stem, which rises from x 70 below to the deck at 95; a
	# transom from 2 m down at x -90; knuckles 6 m up to port, 5 to starboard
	"hull": {"boot": 1.0,
		"transom": {"x": -90, "points": [[-2, 8], [5, 10]]},
		"stations": [{"x": -60, "points": [[-8, 12], [0, 15], [6, 16]]}, {"x": 40, "points": [[-8, 12], [0, 15], [6, 16]]},
			{"x": 60, "points": [[-8, 6], [0, 9], [6, 12]]}],
		"stem": [[70, -8], [75, 0], [95, 19.5]],   # drawn past the deck's underside
		"knuckle": {"port": [[-90, 6, -16], [60, 6, -12]], "starboard": [[-90, 5, 16], [60, 5, 12]]},
		"gallery": {"port": [[-100, 3]], "starboard": [[-100, 2]]}},
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
		self.assertTrue(np.allclose(deck[:, 1], 19.0, atol=1e-4))
		self.assertAlmostEqual(deck[:, 0].min(), -100, places=3)
		self.assertAlmostEqual(deck[:, 0].max(), 100, places=3)
		self.assertAlmostEqual(deck[:, 2].min(), -40, places=3)   # port is negative z
		self.assertAlmostEqual(deck[:, 2].max(), 30, places=3)
		skirt = self.model.parts()["deck_skirt"].reshape(-1, 3)
		self.assertAlmostEqual(skirt[:, 1].min(), 18.4, places=3)

	def test_deck_area_leaves_out_the_elevator(self):
		tris = self.model.parts()["deck"]
		a = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
		self.assertAlmostEqual(0.5 * np.linalg.norm(a, axis=1).sum(), 200 * 70 - 20 * 10, places=1)
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

	def test_elevator_goes_down_and_cab_comes_up(self):
		elevator = self.posed(elevator_1=8)["elevator_1"].reshape(-1, 3)
		self.assertAlmostEqual(elevator[:, 1].max(), 11.0, places=3)
		cab = self.model.parts()["catapult_1_cab"].reshape(-1, 3)
		self.assertAlmostEqual(cab[:, 1].max(), 19.0, places=3)   # stowed flush
		raised = self.posed(catapult_1_cab=1.5)["catapult_1_cab"].reshape(-1, 3)
		self.assertAlmostEqual(raised[:, 1].max(), 20.5, places=3)

	def test_ship_file(self):
		cat = self.ship["catapults"][0]
		self.assertAlmostEqual(cat["heading"], 5, places=2)   # positive to port
		self.assertEqual(cat["stroke"], 90.0)
		self.assertEqual(self.ship["deck"]["outline"], DECK["outline"])
		self.assertEqual(sorted(self.ship["joints"]), ["catapult_1_cab", "catapult_1_deflector", "catapult_1_shuttle", "elevator_1"])
		self.assertEqual(self.ship["joints"]["catapult_1_shuttle"]["keys"], [[0, 0], [1, 90.0]])
		# the deflector faces square to its hinge: the starboard end further
		# forward turns it to port
		deflector = cat["deflector"]
		self.assertAlmostEqual(deflector["heading"], np.degrees(np.arctan2(0.5, 10)), places=2)
		self.assertEqual([deflector["x"], deflector["z"]], [5.25, -10.44])
		self.assertAlmostEqual(deflector["width"], np.hypot(0.5, 10), places=3)

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
		self.assertEqual(len(gltf["images"]), 1)

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

	def test_hull_faces_out_and_wears_boot_below(self):
		tris, normals = self.faces("hull")
		keel = (np.abs(tris[:, :, 1] + 8) < 1e-4).all(1)
		self.assertTrue(keel.any() and (normals[keel, 1] < -0.99).all())
		side = (tris[:, :, 2] > 14).all(1) & (tris[:, :, 1] > -5).all(1) & (tris[:, :, 1] < 0).all(1) & (np.abs(tris[:, :, 0]) < 20).all(1)
		self.assertTrue(side.any() and (normals[side, 2] > 0.9).all())
		boot = self.model.parts(materials=["boot"])["hull"].reshape(-1, 3)
		self.assertLessEqual(boot[:, 1].max(), 1.0 + 1e-4)
		self.assertAlmostEqual(boot[:, 1].min(), -8, places=3)
		# grey above it, but for the end caps and the faces where the rising
		# stem crosses the boot top
		grey = self.faces("hull", materials=["grey"])[0]
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
