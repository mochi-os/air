# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
import sys
import unittest
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))
import skyline  # noqa: E402


def look(eye, photo=None, pose=None, section=None, sea=None, silhouette=False):
	# The places a scene finds on a plate (the body, 2 x 0.2 x 1 m) photographed from eye against a bright
	# sky: photo is the catalogue's photo entry, pose the cameras file's, section the catalogue's "skyline",
	# sea its "sea"; with silhouette, the model's silhouette mask too
	import tempfile
	import camera as cam
	import model as mod
	from test_verify import JET, box, glb
	with tempfile.TemporaryDirectory() as root:
		root = Path(root)
		glb(root / "m.glb", [{"name": "body", "mesh": box((-1, -0.1, -0.5), (1, 0.1, 0.5))}])
		model = mod.Model(root / "m.glb")
		size = [1200, 600]
		camera = cam.looking(np.array(eye, float), np.array([0.0, 0.0, 0.0]), 2400.0)
		flat, depth = cam.project(camera, model.triangles(mod.pose({}, {})).reshape(-1, 3), (size[0] / 2, size[1] / 2))
		mask = skyline.frontmost(flat.reshape(-1, 3, 2), depth.reshape(-1, 3), tuple(size)) >= 0
		(root / "references").mkdir()
		Image.fromarray(np.where(mask[..., None], 60, 200).astype(np.uint8).repeat(3, -1)).save(root / "references" / "p.png")
		catalogue = {"frame": JET, "photos": {"p": photo or {}}}
		if section:
			catalogue["skyline"] = section
		if sea:
			catalogue["sea"] = sea
		entry = {"photo": "p", "file": "p.png", "size": size, "camera": list(camera), "pose": pose or {}}
		places, shown = skyline.Scene(catalogue, root, mod.Frame(catalogue["frame"]), {}, entry).places(model, {}, {})
		return (places, shown) if silhouette else places


def profile(edge, jet=60.0, sky=200.0, noise=0.0, seed=0):
	# a brightness profile across an edge at `edge` samples outward of the model's
	t = np.arange(-skyline.REACH, skyline.REACH + 1, dtype=float)
	p = np.where(t < edge, jet, sky)
	return p + np.random.default_rng(seed).normal(0, noise, len(p))


class SkylineTest(unittest.TestCase):
	def test_edge_along(self):
		# the sky's edge where it is, to a fraction of a sample, inside or outside the model's
		for edge in (-6.0, 0.0, 3.0, 8.0):
			self.assertAlmostEqual(skyline.edge_along(profile(edge)), edge - 0.5, delta=0.6)
		# not sky beyond: too dark (the ground), too rough (a hangar, people), no brighter than the jet
		self.assertIsNone(skyline.edge_along(profile(3.0, sky=90.0)))
		self.assertIsNone(skyline.edge_along(profile(3.0, noise=15.0)))
		self.assertIsNone(skyline.edge_along(profile(3.0, jet=185.0)))
		# a dark sky passes where the caller lowers the brightness it asks for (a blue sky, measure())
		self.assertAlmostEqual(skyline.edge_along(profile(3.0, jet=200.0, sky=70.0), 0.0), 2.5, delta=0.6)
		self.assertIsNone(skyline.edge_along(profile(3.0, jet=200.0, sky=70.0)))
		# a jet brighter than the sky: a sunlit top under overcast
		self.assertAlmostEqual(skyline.edge_along(profile(2.0, jet=240.0, sky=180.0)), 1.5, delta=0.6)
		# a blurred edge: half-way between sky and jet, wherever the change first shows
		blur = np.convolve(np.pad(profile(4.0), 3, mode="edge"), np.ones(7) / 7, mode="valid")
		self.assertAlmostEqual(skyline.edge_along(blur), 3.5, delta=0.6)
		# a halo one sample wide outside a dark edge, a panel line inside a bright jet: neither is the edge
		halo = profile(-2.0)
		halo[skyline.REACH - 2] = 230
		self.assertAlmostEqual(skyline.edge_along(halo), -2.5, delta=0.6)
		line = profile(5.0, jet=240.0, sky=180.0)
		line[skyline.REACH] = 90
		self.assertAlmostEqual(skyline.edge_along(line), 4.5, delta=0.6)
		# a lighter line, still brighter than the sky, crosses half-way twice: the edge is the crossing nearest the sky
		line[skyline.REACH] = 200
		self.assertAlmostEqual(skyline.edge_along(line), 4.5, delta=0.6)
		# shading, not an edge: a gentle ramp from the sky into the jet is not judged
		ramp = np.clip(200 - np.maximum(0, 6 - np.arange(-skyline.REACH, skyline.REACH + 1)) * 6.0, 60, 200)
		self.assertIsNone(skyline.edge_along(ramp))
		# a steeply sloping sky (vignetting, the horizon's haze) is still even sky, judged
		steep = profile(-3.0) + np.where(np.arange(-skyline.REACH, skyline.REACH + 1) >= -3, np.arange(-skyline.REACH, skyline.REACH + 1) * 2.5, 0)
		self.assertAlmostEqual(skyline.edge_along(steep), -3.5, delta=0.6)
		# a sky darkening toward the jet is still sky, not the jet's edge
		slope = profile(-3.0) + np.clip(np.arange(-skyline.REACH, skyline.REACH + 1) * 0.6, -20, 20)
		self.assertAlmostEqual(skyline.edge_along(slope), -3.5, delta=0.6)

	def test_edge_along_photo(self):
		# profiles across dvids9820788's spine (FS 404, 456; the model's edge at sample 24): the sunlit top is
		# brighter than the sky and its shading falls off inward; the edge is the step at 22-24, not the
		# shading 10 samples in
		spine = [92, 96, 98, 106, 111, 116, 123, 127, 131, 131, 142, 151, 158, 168, 172, 186, 151, 178, 212, 210, 217, 225, 230, 202, 183, 185, 185,
			186, 187, 187, 187, 189, 189, 189, 190, 190, 190, 191, 191, 192, 192, 192, 191, 191, 191, 191, 190, 190, 190]
		self.assertAlmostEqual(skyline.edge_along(spine), -1.2, delta=0.5)
		later = [89, 93, 91, 90, 93, 99, 108, 117, 121, 129, 131, 135, 117, 128, 172, 176, 184, 191, 199, 205, 211, 218, 224, 208, 174, 178, 178, 178,
			179, 179, 181, 182, 182, 183, 183, 184, 185, 185, 186, 188, 188, 189, 189, 190, 190, 189, 190, 190, 190]
		self.assertAlmostEqual(skyline.edge_along(later), -0.9, delta=0.5)

	def test_outward(self):
		mask = np.zeros((101, 101), bool)
		yy, xx = np.mgrid[:101, :101]
		mask[(xx - 50) ** 2 + (yy - 50) ** 2 <= 30 ** 2] = True
		nx, ny = skyline.outward(mask)
		for x, y in ((80, 50), (50, 20), (29, 71)):
			radial = np.array([x - 50, y - 50], float) / np.hypot(x - 50, y - 50)
			self.assertGreater(nx[y, x] * radial[0] + ny[y, x] * radial[1], 0.95)

	def test_frontmost(self):
		# two overlapping squares: the nearer one wins where they overlap, whichever is drawn first
		square = lambda x, y: np.array([[[x, y], [x + 40, y], [x + 40, y + 40]], [[x, y], [x + 40, y + 40], [x, y + 40]]], float)
		flat = np.concatenate([square(10, 10), square(30, 30)])
		for near in (0, 2):
			depth = np.full((4, 3), 5.0)
			depth[near:near + 2] = 2.0
			ids = skyline.frontmost(flat, depth, (100, 100))
			self.assertIn(ids[40, 40], (near, near + 1))
			self.assertEqual(ids[90, 90], -1)
		# a triangle behind the camera is left out
		depth = np.full((4, 3), 5.0)
		depth[0, 1] = -1.0
		self.assertNotIn(0, skyline.frontmost(flat, depth, (100, 100)))

	def test_measure(self):
		# a square model in a photo whose jet stands 3 px outside it all round, with sky beyond: every
		# place found reads the model 3 in inside (at a depth where a pixel is an inch)
		size, unit, focal = 200, 0.0254, 1000.0
		ids = np.full((size, size), -1)
		ids[60:140, 60:140] = 0
		image = Image.new("L", (size, size), 200)
		ImageDraw.Draw(image).rectangle([57, 57, 142, 142], fill=60)
		gray = np.asarray(image, float)
		names, points, depths = ["fuselage"], np.array([[450.0, 148.0, 0.0]]), np.array([focal * unit])
		places = skyline.measure(gray, ids, names, points, depths, focal, unit, 1.0)
		self.assertGreater(len(places), 40)
		misses = np.array([p["miss"] for p in places])
		self.assertAlmostEqual(float(np.median(misses)), -3.0, delta=0.3)
		self.assertEqual(places[0]["part"], "fuselage")
		self.assertEqual(places[0]["point"], [450.0, 148.0, 0.0])
		# the miss scales with the depth of the triangle making the outline: the right half twice as far
		halves = ids.copy()
		halves[60:140, 100:140] = 1
		two = skyline.measure(gray, halves, names * 2, np.concatenate([points, points]), np.array([1.0, 2.0]) * focal * unit, focal, unit, 1.0)
		right = [p["miss"] for p in two if p["pixel"][0] > 130]
		left = [p["miss"] for p in two if p["pixel"][0] < 70]
		self.assertAlmostEqual(float(np.median(left)), -3.0, delta=0.3)
		self.assertAlmostEqual(float(np.median(right)), -6.0, delta=0.6)
		# the photo's jet standing 50 px outside the model's edge, past the first reach: found by a longer one
		big = np.full((320, 320), -1)
		big[60:140, 60:140] = 0
		wide = Image.new("L", (320, 320), 200)
		ImageDraw.Draw(wide).rectangle([60, 60, 139, 189], fill=60)
		far = skyline.measure(np.asarray(wide, float), big, names, points, depths, focal, unit, 1.0)
		bottom = [p["miss"] for p in far if p["pixel"][1] >= 138 and 70 < p["pixel"][0] < 130]
		self.assertTrue(bottom)
		self.assertAlmostEqual(float(np.median(bottom)), -50.0, delta=1.0)
		# another of the model's parts just below the edge, as the hook hangs below the body, with the
		# photo's own such part where the model has it: the short search sees that part, not sky; a longer
		# one would walk in from the sky below it and take its far edge for the body's. It stops at the
		# model's own part instead, and with no room for sky there it judges nothing
		hung = np.full((320, 320), -1)
		hung[60:140, 60:140] = 0
		hung[150:160, 60:140] = 0
		scene = Image.new("L", (320, 320), 200)
		ImageDraw.Draw(scene).rectangle([60, 60, 139, 141], fill=60)
		ImageDraw.Draw(scene).rectangle([60, 150, 139, 159], fill=60)
		under = skyline.measure(np.asarray(scene, float), hung, names, points, depths, focal, unit, 1.0)
		body = [p["miss"] for p in under if 138 <= p["pixel"][1] <= 140 and 70 < p["pixel"][0] < 130]
		self.assertFalse([m for m in body if m < -5.0])
		# with the ground beyond instead of sky, nothing is judged
		dark = np.where(gray > 100, 80.0, gray)
		self.assertEqual(skyline.measure(dark, ids, names, points, depths, focal, unit, 1.0), [])
		# nor where the bright, even background is green: grass or trees, not sky
		grass = np.zeros_like(gray)
		grass[150:, :] = 30.0
		kept = skyline.measure(gray, ids, names, points, depths, focal, unit, 1.0, green=grass)
		self.assertTrue([p for p in kept if p["pixel"][1] < 70])
		self.assertFalse([p for p in kept if p["pixel"][1] >= 138 and 70 < p["pixel"][0] < 130])
		# a deep blue sky reads darker in grey than the ground the brightness rule turns away, and is judged
		# where it is blue; the same darkness in grey (shaded paint, about 20 bluer than red at most) is not
		deep = np.where(gray > 100, 70.0, 200.0)
		self.assertEqual(skyline.measure(deep, ids, names, points, depths, focal, unit, 1.0), [])
		sky = np.where(gray > 100, 60.0, 0.0)
		clear = skyline.measure(deep, ids, names, points, depths, focal, unit, 1.0, blue=sky)
		self.assertGreater(len(clear), 40)
		self.assertAlmostEqual(float(np.median([p["miss"] for p in clear])), -3.0, delta=0.3)
		# shaded paint (about 20 bluer than red at most) beside warm sunlit paint is not sky, though the two differ
		self.assertEqual(skyline.measure(deep, ids, names, points, depths, focal, unit, 1.0, blue=np.where(gray > 100, 20.0, -15.0)), [])
		# shaded skin at the edge as dark in grey as the deep sky: its edge is read where the blue ends, where
		# a walk in grey would pass the shaded rim for the sunlit skin 6 px further in
		rim = np.full((size, size), 70.0)
		rim[57:143, 57:143] = 60.0
		rim[63:137, 63:137] = 200.0
		tint = np.full((size, size), 60.0)
		tint[57:143, 57:143] = 10.0
		shaded = skyline.measure(rim, ids, names, points, depths, focal, unit, 1.0, blue=tint)
		self.assertGreater(len(shaded), 40)
		self.assertAlmostEqual(float(np.median([p["miss"] for p in shaded])), -3.0, delta=0.3)
		# nor under the horizon in a photo taken on the ground, however much the ground there looks like sky
		ground = np.zeros(gray.shape, bool)
		ground[150:, :] = True
		kept = skyline.measure(gray, ids, names, points, depths, focal, unit, 1.0, below=ground)
		self.assertTrue([p for p in kept if p["pixel"][1] < 70])
		self.assertFalse([p for p in kept if p["pixel"][1] >= 138 and 70 < p["pixel"][0] < 130])
		# nor is glass, whose outline shows the sky through it
		self.assertEqual(skyline.measure(gray, ids, [None], points, depths, focal, unit, 1.0), [])
		# nor any place whose search crosses a store the model does not carry: here, the square's right side
		store = np.zeros((size, size), bool)
		store[40:160, 150:170] = True
		kept = skyline.measure(gray, ids, names, points, depths, focal, unit, 1.0, store)
		self.assertTrue(kept)
		self.assertFalse([p for p in kept if p["pixel"][0] >= 138])
		self.assertTrue([p for p in places if p["pixel"][0] >= 138])
		self.assertTrue([p for p in kept if p["pixel"][0] < 70])
		# each place records where the photo's edge was found: 3 px outward of the model's
		apart = [np.hypot(p["edge"][0] - p["pixel"][0], p["edge"][1] - p["pixel"][1]) for p in places]
		self.assertAlmostEqual(float(np.median(apart)), 3.5, delta=0.6)

	def test_rim(self):
		# a square's four sides each sampled every STEP pixels, a diagonal's too
		mask = np.zeros((100, 100), bool)
		mask[20:80, 20:80] = True
		edge = skyline.rim(mask)
		for side in (edge[:, 1] == 20, edge[:, 1] == 79, edge[:, 0] == 20, edge[:, 0] == 79):
			self.assertGreaterEqual(side.sum(), 60 // skyline.STEP - 2)   # less the corner cells another side takes
		yy, xx = np.mgrid[:100, :100]
		diamond = np.abs(xx - 50) + np.abs(yy - 50) <= 30
		self.assertGreater(len(skyline.rim(diamond)), 4 * 30 / skyline.STEP)

	def test_horizon(self):
		# a level camera looking along the model's x axis from 30 m: the horizon is the image's middle row
		import camera as cam
		import model as mod
		frame = mod.Frame({"names": ["station", "waterline", "buttline"], "unit": 0.0254, "origin": [456, 105, 0],
			"axes": [[-1, 0, 0], [0, 1, 0], [0, 0, 1]], "mirror": "buttline"})
		camera = cam.looking(np.array([30.0, 0.0, 0.0]), np.array([0.0, 0.0, 0.0]), 500.0)
		up = frame.model([0, 1, 0]) - frame.model([0, 0, 0])
		mask = skyline.horizon(camera, (200, 200), (400, 400), 1.0, up)
		# ground begins HORIZON degrees under the middle row
		row = 200 + 500 * np.tan(np.radians(skyline.HORIZON))
		self.assertFalse(mask[int(row) - 10, 200])
		self.assertTrue(mask[int(row) + 10, 200])
		self.assertFalse(mask[203, 200])
		# tilted down 10 deg, the line rises by the focal length times the tangent
		tilted = cam.looking(np.array([30.0, 0.0, 0.0]), np.array([0.0, -30.0 * np.tan(np.radians(10)), 0.0]), 500.0)
		mask = skyline.horizon(tilted, (200, 200), (400, 400), 1.0, up)
		row = 200 - 500 * np.tan(np.radians(10 - skyline.HORIZON))
		self.assertFalse(mask[int(row) - 12, 200])
		self.assertTrue(mask[int(row) + 12, 200])
		# a long lens 20 m over the sea: the catalogue's own margin under level, then the sea's horizon,
		# which lies the dip at that height (0.13 deg) further down
		level = cam.looking(np.array([30.0, 0.0, 0.0]), np.array([0.0, 0.0, 0.0]), 20000.0)
		for degrees, sea, below in ((0.1, None, 0.1), (0.1, (np.array([0, 1.0, 0]), -20.0), 0.1 + np.degrees(cam.dip(20.0)))):
			mask = skyline.horizon(level, (200, 200), (400, 400), 1.0, up, degrees, sea)
			row = 200 + 20000 * np.tan(np.radians(below))
			self.assertFalse(mask[int(row) - 10, 200], (degrees, sea))
			self.assertTrue(mask[int(row) + 10, 200], (degrees, sea))

	def test_sea(self):
		# the plate stands half in the sea: what lies under the water makes no outline, so the silhouette
		# stops at the waterline and no place is sought below it; with no sea the whole plate is the model's
		side = (0.0, 0.0, 12.0)
		whole, shown = look(side, silhouette=True)
		afloat, kept = look(side, sea="waterline=105", silhouette=True)
		rows = np.nonzero(shown.any(axis=1))[0]
		middle = (rows.min() + rows.max()) // 2
		self.assertTrue(shown[middle + 5:].any())
		self.assertFalse(kept[middle + 2:].any())
		self.assertTrue(kept[:middle - 2].any())
		self.assertTrue(whole and afloat)
		self.assertTrue(all(p["point"][1] >= 105 - 1e-6 for p in afloat))
		self.assertTrue(any(p["point"][1] < 105 for p in whole))

	def test_afloat(self):
		# a triangle across the surface keeps the part above it, as one triangle or two; one under it goes
		sea = (np.array([0, 1.0, 0]), 0.0)
		tris = np.array([[[0, 1, 0], [1, -1, 0], [-1, -1, 0]], [[0, -1, 0], [1, 1, 0], [-1, 1, 0]], [[0, -1, 0], [1, -2, 0], [-1, -2, 0]]], float)
		kept, source = skyline.afloat(tris, sea)
		self.assertEqual(sorted(source.tolist()), [0, 1, 1])
		self.assertTrue((kept[..., 1] >= -1e-9).all())
		area = lambda t: 0.5 * np.linalg.norm(np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0]), axis=1)
		self.assertAlmostEqual(area(kept[source == 0]).sum(), 0.5, places=6)
		self.assertAlmostEqual(area(kept[source == 1]).sum(), 1.5, places=6)

	def test_scene_blue_sky(self):
		# a plate seen from below against a deep blue sky, darker in grey than the brightness rule asks:
		# in a photo the catalogue calls clear the scene reads the photo's colour and judges the plate's
		# outline; the same grey without the blue is not sky
		import tempfile
		import camera as cam
		import model as mod
		from test_verify import JET, box, glb
		with tempfile.TemporaryDirectory() as root:
			root = Path(root)
			glb(root / "m.glb", [{"name": "body", "mesh": box((-1, -0.1, -0.5), (1, 0.1, 0.5))}])
			model = mod.Model(root / "m.glb")
			size = [1200, 600]
			camera = cam.looking(np.array([0.0, 0.0, 12.0]), np.array([0.0, 0.0, 0.0]), 2400.0)
			flat, depth = cam.project(camera, model.triangles(mod.pose({}, {})).reshape(-1, 3), (size[0] / 2, size[1] / 2))
			mask = skyline.frontmost(flat.reshape(-1, 3, 2), depth.reshape(-1, 3), tuple(size)) >= 0
			(root / "references").mkdir()
			entry = {"photo": "p", "size": size, "camera": list(camera), "pose": {}}
			found = {}
			for name, sky, clear in (("blue", (30, 70, 140), True), ("grey", (70, 70, 70), True), ("unread", (30, 70, 140), False)):
				photo = np.where(mask[..., None], np.array([200, 200, 200]), np.array(sky)).astype(np.uint8)
				Image.fromarray(photo).save(root / "references" / f"{name}.png")
				catalogue = {"frame": JET, "photos": {"p": {"clear": True} if clear else {}}}
				places, _ = skyline.Scene(catalogue, root, mod.Frame(JET), {}, dict(entry, file=f"{name}.png")).places(model, {}, {})
				found[name] = places
			self.assertGreater(len(found["blue"]), 40)
			self.assertLess(float(np.median(np.abs([p["miss"] for p in found["blue"]]))), 0.5)
			self.assertEqual(found["grey"], [])
			# the blue is read only in a photo the catalogue calls clear: elsewhere a cloud would pass for the jet
			self.assertEqual(found["unread"], [])

	def test_ground(self):
		# seen from above and to the side, everything beyond the plate lies under the horizon: a photo with
		# the gear down is taken on the ground and judges nothing there, unless its entry says "ground": false;
		# "ground": true masks a photo whatever its pose
		above = (0.0, 3.0, 12.0)
		self.assertGreater(len(look(above)), 40)
		self.assertEqual(look(above, pose={"gear": 1}), [])
		self.assertGreater(len(look(above, pose={"gear": 1}, photo={"ground": False})), 40)
		self.assertEqual(look(above, photo={"ground": True}), [])
		# the catalogue's horizon: looking 14 deg down at the plate, ground begins only 30 deg under level
		self.assertGreater(len(look(above, photo={"ground": True}, section={"horizon": 30})), 40)

	def test_masks(self):
		# a polygon in the photo's own pixels over the plate's right end (beyond x 700; the plate spans 400-800):
		# no place whose search crosses it is judged, the rest are
		side = (0.0, 0.0, 12.0)
		every = look(side)
		self.assertTrue([p for p in every if p["pixel"][0] > 700])
		kept = look(side, photo={"masks": [[[700, 0], [1200, 0], [1200, 600], [700, 600]]]})
		self.assertFalse([p for p in kept if p["pixel"][0] > 700])
		self.assertTrue([p for p in kept if p["pixel"][0] < 600])

	def test_solid(self):
		# the catalogue's solid materials: a model whose paint is not among them has no outline to judge
		side = (0.0, 0.0, 12.0)
		self.assertGreater(len(look(side, section={"solid": ["paint"]})), 40)
		self.assertEqual(look(side, section={"solid": ["hull"]}), [])

	def test_settings(self):
		# every setting defaults to the F/A-18C's constant, beside the catalogue's own text keys
		from test_verify import JET
		kept = skyline.Settings({"frame": JET, "skyline": {"about": "the photos' blue", "notes": {"fin FS 600-624": "a note"}}})
		self.assertEqual((kept.stretch, kept.axis, kept.sectors, kept.families, kept.moving, kept.tolerance, kept.solid, kept.label, kept.symbol, kept.plural),
			(24, 110.0, skyline.SECTORS, skyline.FAMILIES, skyline.MOVING, 1.0, skyline.SOLID, "FS", "in", "inches"))
		for name in ("stretch", "axis", "sectors", "families", "moving", "tolerance", "solid", "label", "symbol", "plural"):
			self.assertEqual(getattr(kept, name), getattr(skyline.DEFAULT, name), name)

	def test_region_settings(self):
		# each of the catalogue's settings moves a place to another region: a stretch of 40, sectors round
		# WL 600 (the point lies under it), the catalogue's own sectors and families, and its own label
		point = (450.0, 148.0, 0.0)
		self.assertEqual(skyline.region("hull", point), ("body", 432, "top"))
		self.assertEqual(skyline.region("hull", point, skyline.Settings({"skyline": {"stretch": 40}})), ("body", 440, "top"))
		self.assertEqual(skyline.region("hull", point, skyline.Settings({"skyline": {"axis": 600}})), ("body", 432, "bottom"))
		self.assertEqual(skyline.region("hull", point, skyline.Settings({"skyline": {"sectors": [[90, "deck"], [181, "hull"]]}})), ("body", 432, "deck"))
		ship = skyline.Settings({"skyline": {"families": [["elevator", ["elevator_"]]]}})
		self.assertEqual(skyline.region("elevator_aft", point, ship), ("elevator", 432, ""))
		self.assertEqual(skyline.region("elevator_aft", point), ("body", 432, "top"))
		self.assertEqual(skyline.region("fin_left", point, ship), ("body", 432, "top"))
		self.assertEqual(skyline.label(("body", 432, "top"), skyline.Settings({"skyline": {"label": "frame"}})), "body frame 432-456 top")
		self.assertEqual(skyline.label(("body", 440, "top"), skyline.Settings({"skyline": {"stretch": 40}})), "body FS 440-480 top")
		# a ship's hull takes the sectors, and every region its side; the mirrored jet's do not
		ship = skyline.Settings({"skyline": {"families": [["hull", ["hull"]]], "sectored": ["hull"], "sides": ["port", "starboard"]}})
		self.assertEqual(skyline.region("hull", (450.0, 148.0, -30.0), ship), ("hull", 432, "upper side port"))
		self.assertEqual(skyline.region("hull", (450.0, 148.0, 30.0), ship), ("hull", 432, "upper side starboard"))
		self.assertEqual(skyline.region("deck", (450.0, 148.0, -30.0), ship), ("body", 432, "port"))
		self.assertEqual(skyline.region("hull", (450.0, 148.0, -30.0)), ("body", 432, "upper side"))
		self.assertEqual(skyline.label(("hull", 432, "upper side port"), ship), "hull FS 432-456 upper side port")

	def test_summary_settings(self):
		# the catalogue's moving families, tolerance and the frame's symbol, in the report
		from test_verify import JET
		place = lambda miss: {"miss": miss, "part": "fin_left", "point": [600.0, 160.0, -40.0]}
		results = {"a": {"tried": 10, "places": [place(2.0), place(2.4), place(2.2)]}, "b": {"tried": 10, "places": [place(1.9)] * 3}}
		universe = {("fin", 600, "")}
		self.assertIn("no fixed region misses", skyline.summary(results, universe, settings=skyline.Settings({"skyline": {"moving": ["fin"]}})))
		self.assertNotIn("no fixed region misses", skyline.summary(results, universe))
		self.assertTrue(skyline.digest(results, universe, settings=skyline.Settings({"skyline": {"moving": ["fin"]}}))["regions"][0]["moving"])
		self.assertFalse(skyline.digest(results, universe)["regions"][0]["moving"])
		self.assertNotIn("finding:", skyline.summary(results, universe, settings=skyline.Settings({"skyline": {"tolerance": 2.5}})))
		self.assertFalse(skyline.digest(results, universe, settings=skyline.Settings({"skyline": {"tolerance": 2.5}}))["regions"][0]["finding"])
		self.assertIn("100% past 3.75 in", skyline.summary({"a": {"tried": 3, "places": [place(4.0)] * 3}}, universe, settings=skyline.Settings({"skyline": {"tolerance": 2.5}})))
		self.assertIn("0% past 3.75 in", skyline.summary(results, universe, settings=skyline.Settings({"skyline": {"tolerance": 2.5}})))
		text = skyline.summary(results, universe, settings=skyline.Settings({"frame": dict(JET, symbol="ft")}))
		self.assertIn("photo a: 3 of 10 places judged (30%), median miss 2.20 ft, 100% past 1.5 ft", text)
		self.assertIn("finding: fin FS 600-624 misses by +2.0 ft (median of 2 photos, 2 on that side)", text)
		self.assertNotIn(" in", text)

	def test_overlay_colours(self):
		# a place 1.5 off: yellow at the 1 in tolerance, green at 2
		import tempfile
		with tempfile.TemporaryDirectory() as root:
			colours = []
			for settings in (None, skyline.Settings({"skyline": {"tolerance": 2.0}})):
				path = Path(root) / "o.png"
				skyline.overlay(np.full((100, 100), 120.0), np.zeros((100, 100), bool), [{"pixel": [10, 10], "edge": [50, 50], "miss": 1.5}], 1.0, path, settings)
				with Image.open(path) as image:
					colours.append(image.getpixel((50, 50)))
			self.assertEqual(colours, [(240, 200, 0), (40, 220, 40)])

	def test_hull(self):
		square = [(0, 0), (4, 0), (4, 4), (0, 4)]
		inside = [(2, 2), (1, 3), (3, 1)]
		self.assertEqual(sorted(skyline.hull(square + inside)), sorted(square))
		self.assertEqual(len(skyline.hull([(0, 0), (1, 1), (2, 2), (2, 0)])), 3)

	def test_blocked(self):
		# a tank-sized box under a mount at FS 470, WL 84 on the centreline, seen from the right side 30 m
		# off: it covers the place below the mount, not the place above it; an empty station covers nothing
		sys.path.insert(0, str(Path(__file__).resolve().parent))
		import camera as cam
		import model as mod
		frame = mod.Frame({"names": ["station", "waterline", "buttline"], "unit": 0.0254, "origin": [456, 105, 0],
			"axes": [[-1, 0, 0], [0, 1, 0], [0, 0, 1]], "mirror": "buttline"})
		mount = frame.model([470.0, 84.0, 0.0])
		camera = cam.looking(mount + np.array([0.0, 0.0, 30.0]), mount, 1000.0)
		stores = {"kinds": {"tank": [{"centre": [0, -40, 0], "size": [180, 36, 36]}]}}
		hardpoints = {"5": {"mount": list(mount)}}
		mask = skyline.blocked(stores, {"5": "tank"}, hardpoints, frame, camera, (500, 500), (1000, 1000), 1.0)
		below, _ = cam.project(camera, frame.model([[470.0, 44.0, 0.0]]), (500, 500))
		above, _ = cam.project(camera, frame.model([[470.0, 104.0, 0.0]]), (500, 500))
		self.assertTrue(mask[int(below[0, 1]), int(below[0, 0])])
		self.assertFalse(mask[int(above[0, 1]), int(above[0, 0])])
		# a box 90 in long each way: the tank's ends at FS 380 and 560 are in, FS 340 is not
		for station, inside in ((385.0, True), (555.0, True), (340.0, False)):
			q, _ = cam.project(camera, frame.model([[station, 44.0, 0.0]]), (500, 500))
			self.assertEqual(bool(mask[int(q[0, 1]), int(q[0, 0])]), inside, station)
		self.assertFalse(skyline.blocked(stores, {"5": None}, hardpoints, frame, camera, (500, 500), (1000, 1000), 1.0).any())
		# the mirror coordinate's offset is outboard: a box 30 in outboard of a mount at BL -100 lies at BL -130
		side = {"kinds": {"pod": [{"centre": [0, 0, 30], "size": [20, 20, 20]}]}}
		left = frame.model([470.0, 84.0, -100.0])
		top = cam.looking(left + np.array([0.0, 30.0, 0.0001]), left, 1000.0)
		mask = skyline.blocked(side, {"2": "pod"}, {"2": {"mount": list(left)}}, frame, top, (500, 500), (1000, 1000), 1.0)
		for buttline, inside in ((-130.0, True), (-70.0, False)):
			q, _ = cam.project(top, frame.model([[470.0, 84.0, buttline]]), (500, 500))
			self.assertEqual(bool(mask[int(q[0, 1]), int(q[0, 0])]), inside, buttline)

	def test_region(self):
		self.assertEqual(skyline.region("fuselage", (450.0, 148.0, 0.0)), ("body", 432, "top"))
		self.assertEqual(skyline.region("inlet_left", (450.0, 110.0, -40.0)), ("body", 432, "side"))
		self.assertEqual(skyline.region("fuselage", (300.0, 80.0, 1.0)), ("body", 288, "bottom"))
		self.assertEqual(skyline.region("fin_left", (600.0, 160.0, -40.0)), ("fin", 600, ""))
		self.assertEqual(skyline.region("flap_trailing_right", (560.0, 110.0, 120.0)), ("flap", 552, ""))
		self.assertEqual(skyline.region("flap_leading_outer_left", (420.0, 110.0, -150.0)), ("slat", 408, ""))
		self.assertEqual(skyline.region("rudder_right", (650.0, 170.0, 50.0)), ("rudder", 648, ""))

	def test_summary(self):
		place = lambda miss, part="fin_left": {"miss": miss, "part": part, "point": [600.0, 160.0, -40.0]}
		top = {"miss": 0.2, "part": "fuselage", "point": [450.0, 148.0, 0.0]}
		results = {"a": {"tried": 10, "places": [place(2.0), place(2.4), place(2.2)]}, "b": {"tried": 10, "places": [place(1.9)] * 3},
			"c": {"tried": 10, "places": [top] * 3}}
		universe = {("fin", 600, ""), ("body", 432, "top"), ("body", 456, "top")}
		text = skyline.summary(results, universe)
		# the fin misses outward in two photos: a finding; the top is judged by one photo, the next stretch by none
		self.assertIn("finding: fin FS 600-624 misses by +2.0 in (median of 2 photos, 2 on that side)", text)
		self.assertIn("judged by one photo only (1): body FS 432-456 top", text)
		self.assertIn("judged by no photo (1): body FS 456-480 top", text)
		# two photos disagreeing in sign are no finding
		results["b"]["places"] = [place(-1.9)] * 3
		self.assertNotIn("finding:", skyline.summary(results, universe))
		# a photo judging fewer than MINIMUM places in a region does not count for it
		results["b"]["places"] = [place(1.9)] * (skyline.MINIMUM - 1)
		self.assertNotIn("finding:", skyline.summary(results, universe))
		# a weak camera's places judge nothing
		results["b"]["places"] = [place(1.9)] * 3
		self.assertNotIn("finding:", skyline.summary(results, universe, weaks={"b"}))
		self.assertIn("photo b: 3 of 10 places judged (30%), median miss 1.90 in, 100% past 1.5 in; a weak camera: judges nothing", skyline.summary(results, universe, weaks={"b"}))
		# a moving surface's agreed miss is set apart, as a question for the pose
		results = {k: {"tried": 10, "places": [place(m, "rudder_left") for m in v]} for k, v in (("a", [2.0] * 3), ("b", [1.9] * 3))}
		text = skyline.summary(results, universe)
		self.assertIn("no fixed region misses", text)
		self.assertIn("on moving surfaces (check each photo's pose before the shape):\nfinding: rudder FS 600-624 misses by", text)

	def test_digest(self):
		place = lambda miss: {"miss": miss, "part": "fin_left", "point": [600.0, 160.0, -40.0]}
		results = {"a": {"tried": 10, "places": [place(2.0)] * 3}, "b": {"tried": 8, "places": [place(1.8)] * 3}, "c": {"tried": 5, "places": [place(-3.0)] * 3}}
		d = skyline.digest(results, {("fin", 600, ""), ("body", 432, "top")}, weaks={"c"})
		self.assertEqual(d["photos"]["a"], {"tried": 10, "judged": 3, "median": 2.0, "weak": False})
		self.assertTrue(d["photos"]["c"]["weak"])
		self.assertEqual(len(d["regions"]), 1)
		r = d["regions"][0]
		self.assertEqual((r["region"], r["median"], r["places"], r["finding"], r["moving"]), ("fin FS 600-624", 1.9, 6, True, False))
		self.assertEqual(r["photos"], {"a": 2.0, "b": 1.8})
		self.assertEqual(d["universe"], [["body", 432, "top"], ["fin", 600, ""]])

	def test_finding(self):
		# the median over the photos past the tolerance, and two thirds of them on its side
		self.assertTrue(skyline.finding({"a": 1.8, "b": 1.0, "c": 0.7, "d": 1.2}))
		self.assertFalse(skyline.finding({"a": 1.8, "b": 0.6, "c": 0.7, "d": 0.9}))
		self.assertFalse(skyline.finding({"a": -2.0, "b": -2.1, "c": -1.9, "d": 0.8, "e": 0.9, "f": 0.4, "g": -1.4}))
		self.assertTrue(skyline.finding({"a": 1.8, "b": -0.3, "c": 4.3, "d": 1.3, "e": -1.1, "f": 4.2, "g": 3.9}))
		self.assertFalse(skyline.finding({"a": 1.8, "b": -0.3, "c": 4.3, "d": -1.3, "e": -1.1, "f": 4.2}))
		# one photo is no finding, however far it misses
		self.assertFalse(skyline.finding({"a": 8.1}))


if __name__ == "__main__":
	unittest.main()
