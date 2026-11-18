# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# Tests the atlases the F/A-18C's build keeps between runs (build.py --cache,
# ../cache.py). KeyTest builds drafts that only write the keys the jet's and
# the stores' bakes would be kept under (--keys), and holds each key to what
# it comes from: the paint's colours count in neither, a stencil and the nose
# in the jet's alone, the tanks in the stores' alone, a part of the airframe
# within the stores' reach in both, and so do the code that bakes each and
# the constants it bakes by. CacheTest builds the jet painted, four times: a
# build whose inputs are unchanged takes both atlases' UVs and bakes from the
# cache and makes the same model, byte for byte; a change to the paint alone
# bakes nothing again, one to the tanks the stores alone. Also that the model
# rests as built: the wing's flex morph weighted 0. About 20 minutes. And
# that a gear joint's keys read within their tolerance of its motion
# (ThinnedTest, without Blender: python3 -I test_build.py ThinnedTest), that
# the speedbrake's turn is solved about the right point (PivotTest), the
# occlusion's noise smoothed within each island (ShadeTest, likewise), and
# the V's walls behind the speedbrake (WalledTest, likewise).
#
# usage: systemd-run --user --scope --slice=probe.slice -p MemoryMax=6G -p MemorySwapMax=0 python3 -I test_build.py
import ast, json, math, os, re, struct, subprocess, tempfile, unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
FACTS = json.loads((HERE / "facts.json").read_text())


def gltf(glb):
	# The JSON chunk of a glTF binary
	length = struct.unpack("<I", glb[12:16])[0]
	return json.loads(glb[20 : 20 + length])


def changed(change):
	# A copy of the facts, changed in place by `change`
	facts = json.loads(json.dumps(FACTS))
	change(facts["layout"])
	return facts


class ThinnedTest(unittest.TestCase):
	# A gear joint's keys (build.py thinned(), sequenced()): read piecewise
	# linearly, every point of the motion they stand for within the
	# tolerance, the ends kept, and no more kept than the motion's bends need
	@classmethod
	def setUpClass(cls):
		tree = ast.parse((HERE / "build.py").read_text())
		found = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in ("thinned", "interp")]
		space = {}
		exec(compile(ast.Module(body=found, type_ignores=[]), "build.py", "exec"), space)
		cls.thinned, cls.interp = staticmethod(space["thinned"]), staticmethod(space["interp"])

	def test_a_straight_stretch_keeps_its_ends_alone(self):
		line = [(k / 100, 0.3 + 2 * k / 100) for k in range(101)]
		self.assertEqual(self.thinned(line, 1e-6), [line[0], line[-1]])

	def test_a_brace_breaking_from_straight_reads_within_the_tolerance(self):
		# a turn growing as the root of the travel from straight, as a side
		# brace's halves do just after the gear starts up
		curve = [(k / 480, math.sqrt(1 - k / 480)) for k in range(481)]
		kept = self.thinned(curve, 0.0005)
		self.assertEqual((kept[0], kept[-1]), (curve[0], curve[-1]))
		self.assertLessEqual(max(abs(self.interp(kept, x) - y) for x, y in curve), 0.0005)
		self.assertLess(len(kept), len(curve) / 4)
		# denser where it turns fastest: more keys in the last tenth than the first
		self.assertGreater(sum(x > 0.9 for x, _ in kept), sum(x < 0.1 for x, _ in kept))


class PivotTest(unittest.TestCase):
	# The point a turn aft toward up takes one point to another about (build.py
	# pivot(), the speedbrake's turn solved from its photographed corner)
	@classmethod
	def setUpClass(cls):
		tree = ast.parse((HERE / "build.py").read_text())
		found = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "pivot"]
		space = {"math": math}
		exec(compile(ast.Module(body=found, type_ignores=[]), "build.py", "exec"), space)
		cls.pivot = staticmethod(space["pivot"])

	def test_the_turn_about_it_lands_on_the_point(self):
		for a, centre, angle in (((2.0, -0.2), (0.4, 0.1), math.radians(60)), ((1.5, 0.3), (-0.2, -0.5), math.radians(25))):
			v = (a[0] - centre[0], a[1] - centre[1])
			# aft (-x) toward up (+z): x' = x cos + z sin, z' = -x sin + z cos
			b = (centre[0] + v[0] * math.cos(angle) + v[1] * math.sin(angle), centre[1] - v[0] * math.sin(angle) + v[1] * math.cos(angle))
			found = self.pivot(a, b, angle)
			self.assertAlmostEqual(found[0], centre[0], places=9)
			self.assertAlmostEqual(found[1], centre[1], places=9)

	def test_the_sense_of_the_turn_picks_the_side(self):
		# the same two points turned the other way about a centre across the
		# chord: the turn aft toward up never finds that centre
		a, centre, angle = (2.0, 0.0), (1.0, 1.0), math.radians(40)
		v = (a[0] - centre[0], a[1] - centre[1])
		b = (centre[0] + v[0] * math.cos(-angle) + v[1] * math.sin(-angle), centre[1] - v[0] * math.sin(-angle) + v[1] * math.cos(-angle))
		found = self.pivot(a, b, angle)
		self.assertGreater(math.hypot(found[0] - centre[0], found[1] - centre[1]), 0.5)


class DuctTest(unittest.TestCase):
	# The inlets' ducts (build.py duct_ring(), ducted(), without Blender): the
	# duct raked as the lip at its mouth and square at its cap, turning
	# inboard; the paint keeps the lip's grey at the mouth, darkens to black a
	# hydraulic diameter down and on the cap, and leaves the outer skin and
	# anything off the ducts alone, either side
	@classmethod
	def setUpClass(cls):
		tree = ast.parse((HERE / "build.py").read_text())
		wanted = ("value", "mouth", "reach", "mouth_ring", "engine_buttline", "duct_ring", "enclosing", "ducted")
		found = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in wanted]
		space = {"np": __import__("numpy"), "math": math, "FACTS": FACTS, "LAYOUT": FACTS["layout"], "MOUTH_SIDES": 80}
		exec(compile(ast.Module(body=found, type_ignores=[]), "build.py", "exec"), space)
		space["MOUTH"] = space["mouth"]()
		cls.space = space
		cls.np = space["np"]
		cls.cap = FACTS["layout"]["inlet"]["lip"]["top"][0] + FACTS["layout"]["inlet"]["duct"]["depth"]

	def kept(self, points):
		p = self.np.array(points, float)
		return self.space["ducted"](p[:, 0], p[:, 1], p[:, 2])

	def test_raked_at_the_mouth_and_square_at_the_cap(self):
		mouth, cap = self.space["duct_ring"](0.0), self.space["duct_ring"](1.0)
		self.assertGreater(max(p[0] for p in mouth) - min(p[0] for p in mouth), 3.0)
		self.assertTrue(all(abs(p[0] - self.cap) < 1e-9 for p in cap))
		# turned inboard toward the engine's axis
		self.assertLess(sum(p[2] for p in cap) / len(cap), sum(p[2] for p in mouth) / len(mouth) - 0.5)

	def test_the_paint_darkens_down_the_duct(self):
		ring = lambda share, k: self.space["duct_ring"](share)[k]
		for side in (1, -1):
			walls = [ring(share, k) for share in (0.0, 0.5, 1.0) for k in (0, 20, 40, 60)]
			kept = self.kept([(s, w, side * b) for s, w, b in walls])
			self.assertTrue((kept[:4] > 0.95).all(), kept[:4])     # at the lip, its grey
			self.assertTrue((kept[8:] < 0.01).all(), kept[8:])     # down the duct, black
			# the cap's middle, black; the outer skin a wall's width outside the duct, and the fuselage's side, untouched
			centre = self.space["MOUTH"]["centre"]
			outside = [(s + 0.5, w + (w - centre[1]) * 0.15, side * (b + (b - centre[0]) * 0.15)) for s, w, b in walls[:8]]
			kept = self.kept([(self.cap, centre[1], side * centre[0])] + outside + [(420.0, 100.0, side * 12.0)])
			self.assertLess(kept[0], 0.01)
			self.assertTrue((kept[1:] == 1.0).all(), kept[1:])

	def test_the_atlas_as_a_grid(self):
		# the paint passes the atlas's texels as grids, rows by columns: each
		# texel judged as it is alone
		cap, mouth = self.space["duct_ring"](1.0)[20], self.space["duct_ring"](0.0)[20]
		grid = self.np.array([[cap, (420.0, 100.0, 12.0)], [mouth, (420.0, 100.0, -12.0)]], float)
		kept = self.space["ducted"](grid[..., 0], grid[..., 1], grid[..., 2])
		self.assertEqual(kept.shape, (2, 2))
		flat = self.kept(grid.reshape(-1, 3)).reshape(2, 2)
		self.np.testing.assert_array_equal(kept, flat)
		self.assertLess(kept[0, 0], 0.01)
		self.assertGreater(kept[1, 0], 0.95)

	def test_enclosing(self):
		square = self.np.array([(0.0, 0.0), (4.0, 0.0), (4.0, 4.0), (0.0, 4.0)])
		enclosing = self.space["enclosing"]
		self.assertTrue(enclosing(square, (2.0, 2.0)))
		self.assertFalse(enclosing(square, (4.3, 2.0)))
		self.assertTrue(enclosing(square, (4.3, 2.0), 0.5))
		self.assertFalse(enclosing(square, (5.0, 5.0), 0.5))


class ShadeTest(unittest.TestCase):
	# The occlusion bake's noise smoothed within each island (build.py
	# soften()), without Blender: python3 -I test_build.py ShadeTest
	@classmethod
	def setUpClass(cls):
		tree = ast.parse((HERE / "build.py").read_text())
		found = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "soften"]
		import numpy
		space = {"np": numpy, "math": math}
		exec(compile(ast.Module(body=found, type_ignores=[]), "build.py", "exec"), space)
		cls.soften = staticmethod(space["soften"])

	def atlas(self, step=0.012):
		# two islands side by side on the atlas, 20 texels each, each a flat
		# patch of the jet a texel's step apart, the right one 2 m from the
		# left; a column of texels the bake left uncovered between them
		import numpy
		ys, xs = numpy.mgrid[0:20, 0:41].astype(float)
		where = numpy.stack([xs * step, ys * step, numpy.zeros_like(xs)], -1)
		where[:, 21:, 0] += 2.0
		covered = numpy.ones((20, 41), bool)
		covered[:, 20] = False
		return where, covered, numpy.full((20, 41), step)

	def test_it_stays_inside_an_island(self):
		import numpy
		where, covered, size = self.atlas()
		shade = numpy.where(numpy.arange(41)[None, :] < 20, 0.9, 0.3) * numpy.ones((20, 1))
		out = self.soften(shade, where, covered, size)
		numpy.testing.assert_allclose(out[:, :20], 0.9)
		numpy.testing.assert_allclose(out[:, 21:], 0.3)
		self.assertTrue((out[:, 20] == shade[:, 20]).all())   # uncovered texels as they were
		# and two islands touching on the atlas with no gap stay apart too
		covered[:, 20] = True
		where[:, 20, 0] += 2.0
		shade[:, 20] = 0.3
		out = self.soften(shade, where, covered, size)
		numpy.testing.assert_allclose(out[:, :20], 0.9)
		numpy.testing.assert_allclose(out[:, 20:], 0.3)

	def test_it_smooths_the_noise(self):
		import numpy
		where, covered, size = self.atlas()
		noise = numpy.random.default_rng(1).normal(0.0, 0.005, (20, 41))
		out = self.soften(0.7 + noise, where, covered, size)
		inner = (slice(3, 17), slice(3, 17))
		self.assertLess((out[inner] - 0.7).std(), 0.5 * noise[inner].std())

	def test_a_buried_texel_takes_its_neighbours(self):
		# a texel whose sample lay inside another part saw nothing: it takes
		# its island's shade, and darkens none of its neighbours
		import numpy
		where, covered, size = self.atlas()
		shade = numpy.full((20, 41), 0.8)
		shade[10, 10] = 0.0
		out = self.soften(shade, where, covered, size)
		self.assertAlmostEqual(out[10, 10], 0.8, places=6)
		numpy.testing.assert_allclose(out[8:13, 8:13], 0.8)


class WalledTest(unittest.TestCase):
	# The V's walls behind the speedbrake (build.py walled()), without
	# Blender: python3 -I test_build.py WalledTest. A half section from the
	# top's centreline: a level floor to x 2, a groove 2.5 in deep beside it,
	# and the nacelle's wall rising to its top at x 9
	@classmethod
	def setUpClass(cls):
		tree = ast.parse((HERE / "build.py").read_text())
		found = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "walled"]
		space = {"math": math}
		exec(compile(ast.Module(body=found, type_ignores=[]), "build.py", "exec"), space)
		cls.walled = staticmethod(space["walled"])

	ring = [(0.0, 10.0), (1.0, 10.0), (2.0, 10.0), (2.2, 9.0), (2.5, 8.0), (3.0, 7.5), (3.5, 8.5), (4.0, 10.0), (5.0, 12.0), (6.0, 13.5), (7.0, 14.5), (8.0, 15.0), (9.0, 15.2), (10.0, 15.1)]

	def on(self, p, a, b):
		# p's offset off the line through a and b
		return ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) / math.hypot(b[0] - a[0], b[1] - a[1])

	def test_the_walls_run_straight_from_the_floors_edge_to_the_top(self):
		out = self.walled(self.ring, (0.0, 0.0), 10.0, 1.0, 0.0)
		self.assertEqual(out[:3], self.ring[:3])   # the floor as it was
		self.assertEqual(out[10:], self.ring[10:])   # the top from where the wall touches it
		for k in range(3, 10):
			self.assertAlmostEqual(self.on(out[k], (2.0, 10.0), (7.0, 14.5)), 0.0, places=9)
			# each sample moved out along its own ray from the centre
			self.assertAlmostEqual(out[k][0] * self.ring[k][1] - out[k][1] * self.ring[k][0], 0.0, places=9)
			self.assertGreater(math.hypot(*out[k]), math.hypot(*self.ring[k]))

	def test_level_carries_the_floor_across_to_the_nacelle(self):
		out = self.walled(self.ring, (0.0, 0.0), 10.0, 1.0, 1.0)
		for k in range(3, 7):
			self.assertAlmostEqual(out[k][1], 10.0, places=9)
		self.assertEqual(out[7:], self.ring[7:])   # the nacelle's own side from the floor's height

	def test_weight_eases_it_in(self):
		self.assertEqual(self.walled(self.ring, (0.0, 0.0), 10.0, 0.0, 0.0), self.ring)
		full, half = self.walled(self.ring, (0.0, 0.0), 10.0, 1.0, 0.0), self.walled(self.ring, (0.0, 0.0), 10.0, 0.5, 0.0)
		for k in range(3, 10):
			self.assertAlmostEqual(half[k][0], (full[k][0] + self.ring[k][0]) / 2, places=9)
			self.assertAlmostEqual(half[k][1], (full[k][1] + self.ring[k][1]) / 2, places=9)

	def test_a_top_level_to_the_nacelle_is_left_alone(self):
		flat = [(x * 0.5, 10.0) for x in range(21)]
		self.assertEqual(self.walled(flat, (0.0, 0.0), 10.0, 1.0, 0.0), flat)


class KeyTest(unittest.TestCase):
	# Each case a draft build writing its keys (build.py --keys): a changed
	# facts file, or a copy of build.py beside it with its code changed
	CASES = {
		"base": (None, None),
		"colour": (lambda l: l["paint"].update(upper=[90, 93, 104]), None),
		"stencil": (lambda l: l["stencils"]["warning"].update(at=[310.4, 134.0]), None),
		"tanks": (lambda l: l["stores"]["tank"]["profile"][7].__setitem__(1, 14.6), None),
		"pitot": (lambda l: l["pitot"].update(tube=0.9), None),
		"near": (lambda l: l["antennas"]["ventral"][2].__setitem__(1, 75.3), None),   # the blade under the nose, within the centreline tank's reach
		"bakes": (None, ("	shade = texels(occlusion)[..., 0]\n", "	shade = texels(occlusion)[..., 0]   # changed\n")),
		"opened": (None, ('OPENED = {"gear.doors": 1.0, "gear.nose": 1.0, "gear.main": 1.0, "speedbrake": 1.0, "probe": 1.0}', 'OPENED = {"gear.doors": 1.0, "gear.nose": 1.0, "gear.main": 0.9, "speedbrake": 1.0, "probe": 1.0}')),
		"finish": (lambda l: l["paint"]["gear"].update(white=[150, 150, 152]), None),
		"atlas": (None, ("ATLAS = 2048\n", "ATLAS = 4096\n")),
		"store_bakes": (None, ("	occlusion = np.ones((size, size), np.float32)\n", "	occlusion = np.ones((size, size), np.float32)   # changed\n")),
		"reach": (None, ("STORE_REACH = 12.0\n", "STORE_REACH = 12.5\n")),
		"store_atlas": (lambda l: l["stores"]["paint"].update(atlas=512), None),
		"strip": (None, ("STRIP = 0.03   #", "STRIP = 0.04   #")),
		"density": (None, ("STENCIL_DENSITY = 4.6   #", "STENCIL_DENSITY = 3.0   #")),
		"open_reach": (None, ("OPEN_REACH = 24.0   #", "OPEN_REACH = 25.0   #")),
		"margin": (None, ("STENCIL_MARGIN = 1.5    #", "STENCIL_MARGIN = 2.0    #")),
		"nozzles": (None, ("			NOZZLE_PARTS.append(petal)\n", "			NOZZLE_PARTS.append(petal) if k else None\n")),
	}

	@classmethod
	def setUpClass(cls):
		cls.folder = tempfile.TemporaryDirectory()
		with ThreadPoolExecutor(3) as pool:
			cls.keys = dict(zip(cls.CASES, pool.map(cls.keyed, cls.CASES)))

	@classmethod
	def tearDownClass(cls):
		cls.folder.cleanup()

	@classmethod
	def keyed(cls, name):
		change, edit = cls.CASES[name]
		where = Path(cls.folder.name) / name
		where.mkdir()
		script = HERE / "build.py"
		if edit:
			# beside the original, so it finds the facts, the references and the shared modules as it does
			old, new = edit
			source = script.read_text()
			if source.count(old) != 1:
				raise RuntimeError(f"{name}: the line to change is not in build.py once")
			script = HERE / f".keys-{os.getpid()}-{name}.py"
			script.write_text(source.replace(old, new))
		options = ["--facts", str(where / "facts.json")] if change else []
		if change:
			(where / "facts.json").write_text(json.dumps(changed(change)))
		try:
			run = subprocess.run(["blender", "-b", "--factory-startup", "--python-use-system-env", "--python-exit-code", "1", "-P", str(script), "--",
				str(where / "fa18c.glb"), str(where / "fa18c.json"), "--draft", "--keys", str(where / "keys.json"), *options], capture_output=True, text=True)
		finally:
			if edit:
				script.unlink()
		if run.returncode or "Traceback" in run.stdout + run.stderr:
			raise RuntimeError(run.stdout[-3000:] + run.stderr[-3000:])
		return json.loads((where / "keys.json").read_text())

	def moved(self, name):
		# which keys the case changes from the base's
		return {group: self.keys[name][group] != self.keys["base"][group] for group in ("paint", "stores")}

	def test_the_paints_colours_bake_nowhere(self):
		self.assertEqual(self.moved("colour"), {"paint": False, "stores": False})

	def test_a_stencil_bakes_the_jet_alone(self):
		self.assertEqual(self.moved("stencil"), {"paint": True, "stores": False})

	def test_the_gears_finishes_bake_nowhere(self):
		self.assertEqual(self.moved("finish"), {"paint": False, "stores": False})

	def test_the_open_pose_counts_in_the_jets_key_alone(self):
		self.assertEqual(self.moved("opened"), {"paint": True, "stores": False})

	def test_the_open_parts_reach_counts_in_the_jets_key_alone(self):
		self.assertEqual(self.moved("open_reach"), {"paint": True, "stores": False})

	def test_the_tanks_bake_the_stores_alone(self):
		self.assertEqual(self.moved("tanks"), {"paint": False, "stores": True})

	def test_the_nose_out_of_the_stores_reach_bakes_the_jet_alone(self):
		self.assertEqual(self.moved("pitot"), {"paint": True, "stores": False})

	def test_the_airframe_within_the_stores_reach_bakes_both(self):
		self.assertEqual(self.moved("near"), {"paint": True, "stores": True})

	def test_the_code_that_bakes_the_jet_counts_in_its_key_alone(self):
		self.assertEqual(self.moved("bakes"), {"paint": True, "stores": False})

	def test_the_atlas_size_counts_in_the_jets_key_alone(self):
		self.assertEqual(self.moved("atlas"), {"paint": True, "stores": False})

	def test_the_code_that_bakes_the_stores_counts_in_their_key_alone(self):
		self.assertEqual(self.moved("store_bakes"), {"paint": False, "stores": True})

	def test_the_stores_reach_counts_in_their_key_alone(self):
		self.assertEqual(self.moved("reach"), {"paint": False, "stores": True})

	def test_the_stores_atlas_size_counts_in_their_key_alone(self):
		self.assertEqual(self.moved("store_atlas"), {"paint": False, "stores": True})

	def test_the_atlas_strip_counts_in_the_jets_key_alone(self):
		self.assertEqual(self.moved("strip"), {"paint": True, "stores": False})

	def test_the_stencils_density_counts_in_the_jets_key_alone(self):
		self.assertEqual(self.moved("density"), {"paint": True, "stores": False})

	def test_the_stencils_margin_counts_in_the_jets_key_alone(self):
		self.assertEqual(self.moved("margin"), {"paint": True, "stores": False})

	def test_the_nozzles_flaps_count_in_the_jets_key_alone(self):
		self.assertEqual(self.moved("nozzles"), {"paint": True, "stores": False})


class CacheTest(unittest.TestCase):
	@classmethod
	def setUpClass(cls):
		cls.folder = tempfile.TemporaryDirectory()
		cls.cache = Path(cls.folder.name) / "cache"

	@classmethod
	def tearDownClass(cls):
		cls.folder.cleanup()

	def build(self, name, facts=None):
		where = Path(self.folder.name) / name
		where.mkdir()
		options = ["--cache", str(self.cache)]
		if facts is not None:
			(where / "facts.json").write_text(json.dumps(facts))
			options += ["--facts", str(where / "facts.json")]
		run = subprocess.run(["blender", "-b", "--factory-startup", "--python-use-system-env", "--python-exit-code", "1", "-P", str(HERE / "build.py"), "--",
			str(where / "fa18c.glb"), str(where / "fa18c.json"), *options], capture_output=True, text=True)
		if run.returncode or "Traceback" in run.stdout + run.stderr:
			raise RuntimeError(run.stdout[-3000:] + run.stderr[-3000:])
		said = dict(re.findall(r"^bakes (\w+): (baked|from the cache)", run.stdout, re.M))
		return (where / "fa18c.glb").read_bytes(), {group: way == "baked" for group, way in said.items()}

	def test_cached_atlases(self):
		first, baked = self.build("first")
		self.assertEqual(baked, {"paint": True, "stores": True})
		# the wing rests unbent: its flex morph weighted 0 (Blender 5 weights a new shape key 1)
		flexed = {m["name"]: m["weights"] for m in gltf(first)["meshes"] if "weights" in m}
		self.assertIn("wing_outer_left", flexed)
		self.assertEqual({name: w for name, w in flexed.items() if any(w)}, {})
		# again: both from the cache, the same model
		again, baked = self.build("again")
		self.assertEqual(baked, {"paint": False, "stores": False})
		self.assertEqual(again, first)
		# the upper grey lighter: the paint alone
		painted = json.loads(json.dumps(FACTS))
		painted["layout"]["paint"]["upper"] = [90, 93, 104]
		model, baked = self.build("painted", painted)
		self.assertEqual(baked, {"paint": False, "stores": False})
		self.assertNotEqual(model, first)
		# the wing tanks a tenth of an inch fatter: the stores alone
		tanks = json.loads(json.dumps(FACTS))
		tanks["layout"]["stores"]["tank"]["profile"][7][1] += 0.1
		model, baked = self.build("tanks", tanks)
		self.assertEqual(baked, {"paint": False, "stores": True})
		self.assertNotEqual(model, first)


if __name__ == "__main__":
	unittest.main()
