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
# occlusion's noise smoothed within each island (ShadeTest, likewise), each
# texel's size on the jet, the bake's margin's included (TexelTest, likewise),
# each door's seam shaded on every edge texel (CoveringTest, likewise), the
# V's walls behind the speedbrake (WalledTest, likewise), and each face a
# cut leaves with a straight corner split from it (StraightTest, a small
# Blender run).
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


class QuarterTest(unittest.TestCase):
	# The nacelles' upper outboard quarter's exponent along the stations
	# (build.py quarter()): the section's own before the fade, the shoulder's
	# full exponent between the fade and the fade-out, eased back to the
	# section's own through `out`, and without `out` only the end circle's
	# rounding takes it back
	@classmethod
	def setUpClass(cls):
		tree = ast.parse((HERE / "build.py").read_text())
		found = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in ("quarter", "ease")]
		cls.space = {"rounding": lambda station: 0.0}
		exec(compile(ast.Module(body=found, type_ignores=[]), "build.py", "exec"), cls.space)

	def exponent(self, shoulder, station, power=2.3):
		self.space["QUARTER"] = shoulder
		return self.space["quarter"](station, power)

	def test_the_shoulder_fades_in_holds_and_fades_out(self):
		shoulder = {"exponent": 7.0, "fade": [605, 635], "out": [660, 685]}
		self.assertAlmostEqual(self.exponent(shoulder, 600), 2.3)
		self.assertAlmostEqual(self.exponent(shoulder, 620), 2.3 + 4.7 / 2)
		self.assertAlmostEqual(self.exponent(shoulder, 650), 7.0)
		self.assertAlmostEqual(self.exponent(shoulder, 672.5), 2.3 + 4.7 / 2)
		self.assertAlmostEqual(self.exponent(shoulder, 690), 2.3)

	def test_without_a_fade_out_the_shoulder_holds_to_the_end(self):
		self.assertAlmostEqual(self.exponent({"exponent": 7.0, "fade": [605, 635]}, 690), 7.0)


class OutlineTest(unittest.TestCase):
	# The lenses' outlines (build.py taper(), pill() and disc()), each a share
	# of the lens's width at a share of its length from its first end: the
	# LEX's square across its forward end and narrowing to its aft share 85%
	# of the way aft before a rounded end, the strobes' full but for rounded
	# ends, the tail light's a circle; none narrower than a tenth, so no ring
	# of the plate collapses to a point
	@classmethod
	def setUpClass(cls):
		tree = ast.parse((HERE / "build.py").read_text())
		found = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in ("taper", "pill", "disc")]
		cls.space = {"math": math}
		exec(compile(ast.Module(body=found, type_ignores=[]), "build.py", "exec"), cls.space)

	def test_the_lex_lens_is_square_forward_and_narrows_to_its_aft_share_before_its_rounded_end(self):
		taper = self.space["taper"]
		self.assertEqual(taper(0.0, 0.55), 1.0)
		self.assertAlmostEqual(taper(0.85, 0.55), 0.55)
		self.assertAlmostEqual(taper(0.425, 0.55), 0.775)
		self.assertTrue(0.1 < taper(0.95, 0.55) < 0.55)
		self.assertEqual(taper(1.0, 0.55), 0.1)
		shares = [taper(s / 24, 0.55) for s in range(25)]
		self.assertEqual(shares, sorted(shares, reverse=True))

	def test_the_strobe_is_a_pill_and_the_tail_light_a_circle(self):
		pill, disc = self.space["pill"], self.space["disc"]
		self.assertEqual(pill(0.5), 1.0)
		self.assertGreater(pill(0.25), 0.99)
		self.assertAlmostEqual(pill(0.1), pill(0.9))
		self.assertEqual(pill(0.0), 0.1)
		self.assertEqual(disc(0.5), 1.0)
		self.assertAlmostEqual(disc(0.25), math.sqrt(0.75))
		self.assertEqual(disc(1.0), 0.1)


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
	# The inlets' ducts (build.py duct_ring(), faced(), bay_roof(), without
	# Blender): each duct raked as the lip at its mouth and square from its
	# first fitted section, running to the engine face's circle on the
	# engine's axis at X/D 6.5; the paint picks out the engine face's disc and
	# hub alone, never the walls; and the main bay's roof stands under the
	# duct
	@classmethod
	def setUpClass(cls):
		tree = ast.parse((HERE / "build.py").read_text())
		wanted = ("value", "mouth", "reach", "mouth_ring", "engine_buttline", "smooth", "ease", "duct_run", "duct_start", "duct_ring", "duct_stations",
			"engine_face", "faced", "bay_roof", "enclosing")
		constants = ("MOUTH_SIDES", "DUCT_NEAR", "DUCT_STEP", "HUB")
		found = [n for n in tree.body if (isinstance(n, ast.FunctionDef) and n.name in wanted)
			or (isinstance(n, ast.Assign) and any(getattr(t, "id", None) in constants for t in n.targets))]
		space = {"np": __import__("numpy"), "math": math, "FACTS": FACTS, "LAYOUT": FACTS["layout"]}
		exec(compile(ast.Module(body=found, type_ignores=[]), "build.py", "exec"), space)
		space["MOUTH"] = space["mouth"]()
		cls.space = space
		cls.np = space["np"]
		inlet = FACTS["layout"]["inlet"]
		cls.face = inlet["lip"]["top"][0] + inlet["duct"]["face"] * FACTS["engine"]["inlet"]["value"]

	def test_raked_at_the_mouth_and_square_behind(self):
		s = self.space
		start = s["duct_start"]()
		mouth = s["duct_ring"](start)
		self.assertGreater(max(p[0] for p in mouth) - min(p[0] for p in mouth), 3.0)
		for a, b in zip(mouth, s["mouth_ring"](1.2, s["MOUTH"]["wall"])):
			self.assertTrue(all(abs(x - y) < 1e-9 for x, y in zip(a, b)))
		first = s["duct_run"]()[0][0]
		for station in (first, first + 20.0):
			self.assertTrue(all(abs(p[0] - station) < 1e-9 for p in s["duct_ring"](station)))

	def test_it_runs_to_the_engine_face(self):
		s = self.space
		near, deep = s["duct_stations"]()
		stations = [s["duct_start"]()] + near + deep
		self.assertTrue(all(b > a for a, b in zip(stations, stations[1:])))
		self.assertAlmostEqual(deep[-1], self.face, places=9)
		self.assertLessEqual(max(b - a for a, b in zip(deep, deep[1:])), s["DUCT_STEP"] + 1e-9)
		# its last ring the engine face's circle round the engine's axis, every other point as built
		radius = FACTS["engine"]["face"]["value"] / 2
		axis = (s["engine_buttline"](self.face), FACTS["layout"]["nozzle"]["waterline"])
		ring = s["duct_ring"](self.face, 2)
		self.assertEqual(len(ring), s["MOUTH_SIDES"] // 2)
		for station, wl, bl in ring:
			self.assertAlmostEqual(station, self.face, places=9)
			self.assertAlmostEqual(math.hypot(bl - axis[0], wl - axis[1]), radius, places=6)
		# turned inboard and up on its way there
		mouth = self.np.array(s["duct_ring"](stations[0]))
		self.assertLess(self.np.mean([p[2] for p in ring]), mouth[:, 2].mean() - 5.0)
		self.assertGreater(self.np.mean([p[1] for p in ring]), mouth[:, 1].mean() + 5.0)

	def test_the_paint_marks_the_engine_face_alone(self):
		s = self.space
		face, (bl, wl), radius, hub, length = s["engine_face"]()
		disc = [(face, wl + r * math.cos(t), bl + r * math.sin(t)) for r in (0.0, 6.0, radius - 0.1) for t in (0.3, 2.0, 4.1)]
		nose = [(face - length * u, wl + hub * math.sqrt(1 - u * u) * math.cos(t), bl + hub * math.sqrt(1 - u * u) * math.sin(t)) for u in self.space["HUB"] + [0.0] for t in (0.5, 3.0)]
		near, deep = s["duct_stations"]()
		walls = [p for st in [s["duct_start"]()] + near + deep if st < face - length - 0.5 for p in s["duct_ring"](st, 2)]
		for side in (1, -1):
			on = self.np.array([(f, w, side * b) for f, w, b in disc + nose])
			off = self.np.array([(f, w, side * b) for f, w, b in walls] + [(420.0, 100.0, side * 12.0), (face + 1.0, wl, side * bl)])
			self.assertTrue(s["faced"](on[:, 0], on[:, 1], on[:, 2]).all())
			self.assertFalse(s["faced"](off[:, 0], off[:, 1], off[:, 2]).any())
		# a grid of texels keeps its shape, each judged alone
		grid = self.np.array([[disc[0], (420.0, 100.0, 12.0)], [walls[0], disc[4]]], float)
		marked = s["faced"](grid[..., 0], grid[..., 1], grid[..., 2])
		self.assertEqual(marked.shape, (2, 2))
		self.np.testing.assert_array_equal(marked, [[True, False], [False, True]])

	def test_the_bay_roof_under_the_duct(self):
		s = self.space
		f0, f1, lo, hi = FACTS["layout"]["wells"]["main"][0]
		gap = FACTS["layout"]["wells"]["roof"][0]
		for station in self.np.linspace(f0, f1, 23):
			roof = s["bay_roof"](station)
			floor = min(w for _, w, b in s["duct_ring"](station, 2) if lo <= b <= hi)
			self.assertAlmostEqual(floor - roof, gap, places=9)

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

	def test_lent_texels_keep_their_cast_among_their_own_kind(self):
		# a strip's lent texels (finish.lent()) on the jet beside an island's
		# own, cast 0 along half its length (a crack that sees nothing) and 0.3
		# along the rest: the 0s are no buried samples, so they keep their 0
		# and blend only with the 0.3s where the two meet; the 0.3s keep their
		# 0.3 beside the island's 0.8, and the island's texels its 0.8; and two
		# strips lent 0.1 and 0.2 side by side meet each other
		import numpy
		where, covered, size = self.atlas()
		shade = numpy.full((20, 41), 0.8)
		lent = numpy.zeros((20, 41), bool)
		lent[:, 5] = lent[:, 30:32] = True
		shade[:10, 5], shade[10:, 5], shade[:, 30], shade[:, 31] = 0.0, 0.3, 0.1, 0.2
		out = self.soften(shade, where, covered, size, lent=lent)
		numpy.testing.assert_allclose(out[:8, 5], 0.0)
		self.assertLess(out[9, 5], 0.15)
		numpy.testing.assert_allclose(out[12:, 5], 0.3)
		self.assertTrue((out[:, 30] > 0.1 + 1e-6).all() and (out[:, 31] < 0.2 - 1e-6).all() and (out[:, 30:32] < 0.2).all())
		numpy.testing.assert_allclose(out[:, [3, 4, 6, 7, 29, 32]], 0.8)


class TexelTest(unittest.TestCase):
	# Each texel's size on the jet (build.py texel_size()), without Blender:
	# python3 -I test_build.py TexelTest
	@classmethod
	def setUpClass(cls):
		tree = ast.parse((HERE / "build.py").read_text())
		found = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "texel_size"]
		import numpy
		space = {"np": numpy, "math": math}
		exec(compile(ast.Module(body=found, type_ignores=[]), "build.py", "exec"), space)
		cls.texel_size = staticmethod(space["texel_size"])

	def test_a_margin_repeating_its_edge_takes_the_usual_step(self):
		# an island 20 texels square a texel's step apart, its last three
		# columns the bake's margin, each repeating the island's edge: covered
		# (the margin carries the edge's normal too), at no step from it
		import numpy
		step = 0.012
		ys, xs = numpy.mgrid[0:20, 0:23].astype(float)
		where = numpy.stack([numpy.minimum(xs, 19) * step, ys * step, numpy.zeros_like(xs)], -1)
		covered = numpy.ones((20, 23), bool)
		size = self.texel_size(where, covered)
		self.assertTrue((size > 0).all(), "a texel of no size: a line reaching it shades it by 0/0")
		numpy.testing.assert_allclose(size[:, :20], step)
		# a margin that all but repeats the edge (the bake's float noise, here
		# 0.001 in): the edge's texels keep the island's step
		where[:, 20:, 0] = 19 * step + numpy.arange(1, 4) * 0.001 * 0.0254
		size = self.texel_size(where, covered)
		numpy.testing.assert_allclose(size[:, :20], step)

	def test_the_margin_takes_the_step_along_the_edge(self):
		# the margin's own texels, each repeating the edge texel beside it
		# across the edge (both its neighbours that way all but where it is),
		# stand a texel's step from the next along the edge: on a square
		# island that is their size, as it is the edge texel's
		import numpy
		step = 0.012
		ys, xs = numpy.mgrid[0:20, 0:23].astype(float)
		where = numpy.stack([numpy.minimum(xs, 19) * step, ys * step, numpy.zeros_like(xs)], -1)
		where[:, 20:, 0] += numpy.arange(1, 4) * 1e-6
		size = self.texel_size(where, numpy.ones((20, 23), bool))
		numpy.testing.assert_allclose(size, step)

	def test_a_margin_takes_the_size_of_the_texel_it_repeats(self):
		# an island longer across its edge than along it (a forward nose
		# door's, 1.07 in by 0.70): its margin repeats the edge texel's place
		# and takes its size, not its own step along the edge, so a seam
		# within the edge texel's reach shades the margin too
		import numpy
		across, along = 0.027, 0.018
		ys, xs = numpy.mgrid[0:20, 0:23].astype(float)
		where = numpy.stack([numpy.minimum(xs, 19) * across, ys * along, numpy.zeros_like(xs)], -1)
		size = self.texel_size(where, numpy.ones((20, 23), bool))
		numpy.testing.assert_allclose(size[:, :20], across)
		numpy.testing.assert_allclose(size[:, 20:], across)

	def test_islands_apart_on_the_atlas_keep_their_own_steps(self):
		# two islands side by side, one a texel's step of 0.012 m, the other
		# 2 m off with a step of 0.006: neither's size reaches across
		import numpy
		ys, xs = numpy.mgrid[0:10, 0:20].astype(float)
		where = numpy.stack([xs * 0.012, ys * 0.012, numpy.zeros_like(xs)], -1)
		where[:, 10:] = numpy.stack([2.0 + xs[:, 10:] * 0.006, ys[:, 10:] * 0.006, numpy.zeros_like(xs[:, 10:])], -1)
		size = self.texel_size(where, numpy.ones((10, 20), bool))
		numpy.testing.assert_allclose(size[:, :10], 0.012)
		numpy.testing.assert_allclose(size[:, 10:], 0.006)


class CoveringTest(unittest.TestCase):
	# The share of each texel a panel line covers (build.py covering()),
	# without Blender: python3 -I test_build.py CoveringTest
	@classmethod
	def setUpClass(cls):
		tree = ast.parse((HERE / "build.py").read_text())
		found = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "covering"]
		import numpy
		space = {"np": numpy, "math": math}
		exec(compile(ast.Module(body=found, type_ignores=[]), "build.py", "exec"), space)
		cls.covering = staticmethod(space["covering"])

	def test_a_seam_shades_every_edge_texel(self):
		# texels 0.7 in wide, the line 0.4 in: along a seam, the island's edge
		# texel, its centre anywhere up to a texel inside, takes the line's
		# width over the texel's; the next texel in takes none
		import numpy
		inch = 0.0254
		texel, half = numpy.full(8, 0.7 * inch), 0.2 * inch
		depth = numpy.array([0.0, 0.1, 0.35, 0.5, 0.6, 0.69, 0.75, 1.1]) * inch
		share = self.covering(numpy.full(8, numpy.inf), depth, texel, half)
		numpy.testing.assert_allclose(share[:6], 0.4 / 0.7, atol=1e-9)
		self.assertTrue((share[6:] < 0.1).all(), share)

	def test_a_traced_line_keeps_its_area(self):
		# off any seam, a texel takes the share of its width the line covers:
		# centred on it, the line's width over its own; half a texel off, the
		# half the line reaches; further, none
		import numpy
		inch = 0.0254
		texel, half = numpy.full(3, 0.7 * inch), 0.2 * inch
		share = self.covering(numpy.array([0.0, 0.35, 0.6]) * inch, numpy.full(3, numpy.inf), texel, half)
		numpy.testing.assert_allclose(share, [0.4 / 0.7, 0.2 / 0.7, 0.0], atol=1e-9)

	def test_fine_texels_draw_the_seam_at_its_width(self):
		# texels finer than the line: within half its width of a seam, whole;
		# past it, bare (the edge's rule adds nothing the area did not)
		import numpy
		inch = 0.0254
		texel, half = numpy.full(3, 0.1 * inch), 0.2 * inch
		share = self.covering(numpy.full(3, numpy.inf), numpy.array([0.05, 0.15, 0.3]) * inch, texel, half)
		numpy.testing.assert_allclose(share, [1.0, 1.0, 0.0], atol=1e-9)


class Vec:
	# Just enough of mathutils.Vector for build.py's turned() and blade(),
	# without Blender
	def __init__(self, v):
		import numpy
		self.v = numpy.asarray(v, float)

	x = property(lambda self: float(self.v[0]))
	y = property(lambda self: float(self.v[1]))
	z = property(lambda self: float(self.v[2]))
	length = property(lambda self: float((self.v ** 2).sum() ** 0.5))

	def __add__(self, o):
		return Vec(self.v + o.v)

	def __sub__(self, o):
		return Vec(self.v - o.v)

	def __mul__(self, k):
		return Vec(self.v * k)

	__rmul__ = __mul__

	def __truediv__(self, k):
		return Vec(self.v / k)

	def __neg__(self):
		return Vec(-self.v)

	def dot(self, o):
		return float(self.v @ o.v)

	def cross(self, o):
		import numpy
		return Vec(numpy.cross(self.v, o.v))

	def normalized(self):
		return Vec(self.v / self.length)

	def orthogonal(self):
		# any vector square to this one
		import numpy
		other = numpy.array([1.0, 0.0, 0.0]) if abs(self.v[0]) < 0.9 else numpy.array([0.0, 1.0, 0.0])
		return Vec(numpy.cross(self.v, other))


class FittingTest(unittest.TestCase):
	# The pitot-static tube's and AoA probe's shapes (build.py turned(),
	# blade(), with airfoil() and loft()), without Blender
	@classmethod
	def setUpClass(cls):
		tree = ast.parse((HERE / "build.py").read_text())
		found = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in ("turned", "blade", "airfoil", "half", "loft")]
		cls.space = {"math": math, "Vector": Vec, "INCH": 0.0254, "FACTS": FACTS}
		exec(compile(ast.Module(body=found, type_ignores=[]), "build.py", "exec"), cls.space)

	def test_a_turned_body_takes_its_profile(self):
		vertices, faces = self.space["turned"](Vec([0.0, 0.0, 0.0]), Vec([1.0, 0.0, 0.0]), [(0.0, 0.09), (4.5, 0.39), (9.4, 0.4)], sides=16)
		self.assertEqual(len(vertices), 48)
		for ring, (d, r) in zip(range(3), [(0.0, 0.09), (4.5, 0.39), (9.4, 0.4)]):
			points = [vertices[ring * 16 + i].v for i in range(16)]
			for p in points:
				self.assertAlmostEqual(p[0], d * 0.0254, places=9)
				self.assertAlmostEqual((p[1] ** 2 + p[2] ** 2) ** 0.5, r * 0.0254, places=9)
		self.assertEqual(len(faces), 2 * 16 + 2)   # quads between three rings, an n-gon over each end

	def test_a_blade_is_as_thick_as_asked_square_to_its_chord_and_span(self):
		i = 0.0254
		root = (Vec([0.0, 0.0, 0.0]), Vec([-4.4 * i, 0.0, 0.0]))
		foot = (Vec([2.8 * i, -2.0 * i, -3.2 * i]), Vec([-0.7 * i, -2.0 * i, -3.2 * i]))
		vertices, faces = self.space["blade"](root, foot, [0.5, 0.35])
		n = len(vertices) // 2
		for k, ((lead, trail), t) in enumerate(zip((root, foot), (0.5, 0.35))):
			ring = [p.v for p in vertices[k * n:(k + 1) * n]]
			chord = (trail - lead).normalized().v
			span = ((foot[0] + foot[1]) * 0.5 - (root[0] + root[1]) * 0.5).v
			across = Vec(chord).cross(Vec(span)).normalized().v
			offsets = [float((p - lead.v) @ across) for p in ring]
			self.assertAlmostEqual(max(offsets) - min(offsets), t * i, delta=0.005 * t * i)   # its thickness (the 65A table's thickest ordinate, 2.496 of 5)
			along = [float((p - lead.v) @ chord) for p in ring]
			self.assertAlmostEqual(min(along), 0.0, places=9)   # from its leading edge
			self.assertAlmostEqual(max(along), (trail - lead).length, places=9)   # to its trailing edge
			self.assertAlmostEqual(offsets[0], 0.0, places=9)   # round from a point on its leading edge

	def test_a_blade_has_one_ring_at_each_end(self):
		i = 0.0254
		vertices, faces = self.space["blade"]((Vec([0.0, 0.0, 0.0]), Vec([-4.0 * i, 0.0, 0.0])), (Vec([1.0 * i, 0.0, -3.0 * i]), Vec([-3.0 * i, 0.0, -3.0 * i])), [0.5, 0.5])
		self.assertEqual(len(vertices) % 2, 0)
		self.assertEqual(len(faces), len(vertices) // 2 + 2)


class ExitTest(unittest.TestCase):
	# How far rays from a section's centre reach in a superellipse (build.py
	# exit_distances()), without Blender: python3 -I test_build.py ExitTest.
	# A unit section whose outboard half (x > 0) has its own exponent above
	# the centre, as a nacelle's upper outboard quarter has (quarter()); a
	# superellipse of exponent n meets the diagonal at 2^(-1/n) along each axis
	@classmethod
	def setUpClass(cls):
		tree = ast.parse((HERE / "build.py").read_text())
		found = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "exit_distances"]
		import numpy
		space = {"np": numpy}
		exec(compile(ast.Module(body=found, type_ignores=[]), "build.py", "exec"), space)
		cls.exits = staticmethod(space["exit_distances"])

	def test_each_quarter_takes_its_own_exponent(self):
		diagonal = [(1, 1), (1, -1), (-1, 1), (-1, -1)]
		directions = [(x / math.sqrt(2), y / math.sqrt(2)) for x, y in diagonal]
		got = self.exits((0.0, 0.0), ({"in": 1.0, "out": 1.0, "sign": 1}, 1.0, 1.0), {"in": 2.0, "out": (4.0, 2.0)}, (0.0, 0.0), directions, reach=2.0)
		want = [math.sqrt(2) * 2 ** (-1 / n) for n in (4.0, 2.0, 2.0, 2.0)]
		for g, w in zip(got, want):
			self.assertAlmostEqual(g, w, delta=2.0 / 960)

	def test_a_plain_exponent_in_and_out_is_as_before(self):
		directions = [(math.cos(t), math.sin(t)) for t in (0.3, 1.2, 2.5, 4.0)]
		plain = self.exits((0.0, 0.0), ({"in": 1.0, "out": 1.0, "sign": 1}, 1.0, 1.0), {"in": 2.3, "out": 2.3}, (0.0, 0.0), directions, reach=2.0)
		paired = self.exits((0.0, 0.0), ({"in": 1.0, "out": 1.0, "sign": 1}, 1.0, 1.0), {"in": 2.3, "out": (2.3, 2.3)}, (0.0, 0.0), directions, reach=2.0)
		self.assertEqual(plain, paired)


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


class StraightTest(unittest.TestCase):
	# A face with a straight corner (build.py mend(), in Blender): a cut's
	# point on an edge of a face the cut did not reach. Split into triangles as
	# the hidden-face cull splits it (a quad across its first corner's
	# diagonal), such a face can lay a triangle of no area along the edge;
	# mended first, none is, and every triangle stays inside the face's
	# outline, its area the face's
	SCRIPT = """
import bmesh, json, sys
from mathutils import Vector
exec(sys.argv[sys.argv.index("--") + 1])

def faces(corners, polygons, fix):
	bm = bmesh.new()
	vs = [bm.verts.new(Vector(c)) for c in corners]
	for p in polygons:
		bm.faces.new([vs[i] for i in p])
	made = list(mend(bm)) if fix else [0, 0]
	bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3], quad_method="FIXED")
	areas = sorted(f.calc_area() for f in bm.faces)
	bm.free()
	return made, areas

# the shoelace area of faces in the z = 0 plane
def area(corners, polygons):
	total = 0
	for p in polygons:
		c = [corners[i] for i in p]
		total += abs(sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(c, c[1:] + c[:1]))) / 2
	return total

# a quad: a triangle with a cut's point on its edge from its third corner back
# to its first; a pentagon with two such points on that edge; a concave cap
# (a U whose left leg stands taller), its straight corner's furthest corner
# across the notch; and the keel's front cap (FS 589), a 0.5 by 1 in
# rectangle whose bottom edge carries points 0.0167 in apart, each one face;
# and a strip of triangles with one of no area along its edge, its longest
# side on the boundary (no turn of an edge can take it out), metres
I = 0.0254
quad = [(0, 0, 0), (0.05, 0.15, 0), (0.05, 0, 0), (0.015, 0, 0)]
pentagon = [(0, 0, 0), (0.05, 0.15, 0), (0.05, 0, 0), (0.033, 0, 0), (0.015, 0, 0)]
cap = [(x * 0.01, y * 0.01, 0) for x, y in ((0, 0), (2.5, 0), (3, 0), (3, 2), (2, 2), (2, 1), (1, 1), (1, 3), (0, 3))]
keel = [(b * I, 0, 0) for b in (-0.25, -0.1667, -0.15, -0.1, 0, 0.1, 0.15, 0.1667, 0.25)] + [(0.25 * I, I, 0), (-0.25 * I, I, 0)]
edge = ([(0, 0, 0), (0.004, 0, 0), (0.01, 0, 0), (0.01, 0.01, 0), (0, 0.01, 0)], [(2, 1, 0), (0, 1, 4), (1, 2, 3), (1, 3, 4)])
shapes = {name: (c, [list(range(len(c)))]) for name, c in (("quad", quad), ("pentagon", pentagon), ("cap", cap), ("keel", keel))}
shapes["edge"] = edge
print("result " + json.dumps({name: [faces(c, p, fix) for fix in (False, True)] + [area(c, p)] for name, (c, p) in shapes.items()}))
"""

	@classmethod
	def setUpClass(cls):
		tree = ast.parse((HERE / "build.py").read_text())
		found = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in ("straight", "mend")]
		source = "import bmesh, math\nINCH = 0.0254\n" + ast.unparse(ast.Module(body=found, type_ignores=[]))
		with tempfile.TemporaryDirectory() as d:
			script = Path(d) / "straight.py"
			script.write_text(cls.SCRIPT)
			run = subprocess.run(["blender", "-b", "--factory-startup", "--python-exit-code", "1", "-P", str(script), "--", source], capture_output=True, text=True)
		if run.returncode or "Traceback" in run.stdout + run.stderr:
			raise RuntimeError(run.stdout + run.stderr)
		cls.result = json.loads(re.search(r"^result (.*)$", run.stdout, re.M)[1])

	def test_a_straight_corner_lays_a_triangle_of_no_area_unless_mended(self):
		self.assertLess(self.result["quad"][0][1][0], 1e-12)   # the cull's split, unmended: a triangle of no area
		# and mended, none, the triangles' areas the face's: none folded outside
		# its outline (the cap's furthest corner lies across its notch)
		least = (0.001 * 0.0254) ** 2
		self.assertLess(self.result["edge"][0][1][0], least)
		for name in ("quad", "pentagon", "cap", "keel", "edge"):
			_, (made, fixed), whole = self.result[name]
			# a face split, or the edge's flat triangle dissolved
			self.assertGreater(made[0] if name == "edge" else made[1], 0, name)
			self.assertGreater(fixed[0], least, name)   # every triangle with its area
			self.assertAlmostEqual(sum(fixed) / whole, 1.0, places=6, msg=name)   # single precision


class TidyTest(unittest.TestCase):
	# tidy() (build.py, in Blender) turns a closed island outward by the volume
	# it encloses, whichever way Blender's own turn guessed: here the guess
	# leaves every face as given, as it left the right LEX wholly inward. A
	# closed box given inward comes out outward; one given outward stays so;
	# an open box (one end missing) is left as given, having no inside to
	# judge by; all three far from the origin, as a part's faces lie
	SCRIPT = """
import bmesh as real, bpy, json, math, sys
from types import SimpleNamespace
from mathutils import Vector
exec(sys.argv[sys.argv.index("--") + 1])
bmesh = SimpleNamespace(new=real.new, ops=SimpleNamespace(remove_doubles=real.ops.remove_doubles, reverse_faces=real.ops.reverse_faces, recalc_face_normals=lambda bm, faces: None))

def box(x, inward, open_=False):
	lo, hi = (x, 0.0, 0.0), (x + 0.3, 0.05, 0.08)
	corners = [(a, b, c) for a in (lo[0], hi[0]) for b in (lo[1], hi[1]) for c in (lo[2], hi[2])]
	quads = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]   # outward
	quads = quads[1:] if open_ else quads
	return corners, [q[::-1] for q in quads] if inward else quads

def volume(data):
	total = 0.0
	for p in data.polygons:
		c = [Vector(data.vertices[i].co) for i in p.vertices]
		total += sum(c[0].dot(c[i].cross(c[i + 1])) for i in range(1, len(c) - 1)) / 6
	return total

out = {}
for name, (x, inward, open_) in {"inward": (40.0, True, False), "outward": (41.0, False, False), "open": (42.0, True, True)}.items():
	corners, faces = box(x, inward, open_)
	data = bpy.data.meshes.new(name)
	data.from_pydata(corners, [], faces)
	given = volume(data)
	tidy(data)
	out[name] = [given, volume(data)]
print("result " + json.dumps(out))
"""

	@classmethod
	def setUpClass(cls):
		tree = ast.parse((HERE / "build.py").read_text())
		found = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in ("tidy", "sealed", "enclosure")]
		with tempfile.TemporaryDirectory() as d:
			script = Path(d) / "tidy.py"
			script.write_text(cls.SCRIPT)
			run = subprocess.run(["blender", "-b", "--factory-startup", "--python-exit-code", "1", "-P", str(script), "--", ast.unparse(ast.Module(body=found, type_ignores=[]))], capture_output=True, text=True, timeout=600)
		if run.returncode or "Traceback" in run.stdout + run.stderr:
			raise RuntimeError(run.stdout[-3000:] + run.stderr[-3000:])
		cls.result = json.loads(re.search(r"^result (.*)$", run.stdout, re.M)[1])

	def test_a_closed_island_given_inward_comes_out_outward(self):
		given, tidied = self.result["inward"]
		self.assertLess(given, 0)
		self.assertAlmostEqual(tidied / (0.3 * 0.05 * 0.08), 1.0, places=5)   # single precision

	def test_a_closed_island_given_outward_stays_outward(self):
		given, tidied = self.result["outward"]
		self.assertAlmostEqual(given, tidied, places=9)
		self.assertGreater(tidied, 0)

	def test_an_open_island_is_left_as_given(self):
		given, tidied = self.result["open"]
		self.assertAlmostEqual(given, tidied, places=9)


class BakingTest(unittest.TestCase):
	# The parts joined into one copy for Cycles to bake (build.py baking()):
	# two quads, each on its own half of a 32-texel atlas with a face
	# attribute of its own, one under a joint turned a quarter turn and moved,
	# as a posed part stands, beside a mesh left out
	SCRIPT = """
import bpy, json, math, sys
import numpy as np
from contextlib import contextmanager
exec(sys.argv[sys.argv.index("--") + 1])
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
material = bpy.data.materials.new("paint")
material.use_nodes = True
nodes, links = material.node_tree.nodes, material.node_tree.links
image = bpy.data.images.new("atlas", 32, 32, alpha=False, float_buffer=True)
target = nodes.new("ShaderNodeTexImage")
target.image = image
nodes.active = target

def part(name, left, value, parent=None):
	mesh = bpy.data.meshes.new(name)
	mesh.from_pydata([(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)], [], [(0, 1, 2, 3)])
	layer = mesh.uv_layers.new(name="UVMap")
	for loop, uv in zip(layer.data, ((left, 0), (left + 0.5, 0), (left + 0.5, 1), (left, 1))):
		loop.uv = uv
	mesh.attributes.new("kind", "FLOAT", "FACE").data.foreach_set("value", [value])
	mesh.materials.append(material)
	o = bpy.data.objects.new(name, mesh)
	scene.collection.objects.link(o)
	o.parent = parent
	return o
joint = bpy.data.objects.new("joint", None)
scene.collection.objects.link(joint)
joint.location, joint.rotation_euler = (2, 3, 4), (0, 0, math.pi / 2)
a, b, other = part("a", 0.0, 0.25), part("b", 0.5, 0.75, joint), part("other", 0.0, 0.5)
bpy.context.view_layer.update()
placed = lambda o: [[round(c, 5) for c in o.matrix_world @ v.co] for v in o.data.vertices]
scene.render.engine = "CYCLES"
scene.cycles.samples, scene.cycles.device = 1, "CPU"
with baking([a, b]) as whole:
	inside = {"objects": sorted(o.name for o in scene.objects), "faces": len(whole.data.polygons),
		"vertices": sorted(placed(whole)), "expected": sorted(placed(a) + placed(b)),
		"uvs": sorted([round(c, 5) for c in loop.uv] for loop in whole.data.uv_layers["UVMap"].data),
		"kind": sorted(round(d.value, 5) for d in whole.data.attributes["kind"].data),
		"hidden": [a.hide_render, b.hide_render, other.hide_render],
		"selected": sorted(o.name for o in bpy.context.selected_objects) == [whole.name], "active": bpy.context.view_layer.objects.active == whole}
	# the attribute emitted by a node made after the copy, as bakes() does
	kind = nodes.new("ShaderNodeAttribute")
	kind.attribute_type, kind.attribute_name = "GEOMETRY", "kind"
	emission = nodes.new("ShaderNodeEmission")
	links.new(kind.outputs["Fac"], emission.inputs["Color"])
	links.new(emission.outputs["Emission"], nodes["Material Output"].inputs["Surface"])
	bpy.ops.object.bake(type="EMIT", use_clear=True, margin=0)
pixels = np.array(image.pixels[:]).reshape(32, 32, 4)
after = {"objects": sorted(o.name for o in scene.objects), "meshes": sorted(m.name for m in bpy.data.meshes),
	"hidden": [a.hide_render, b.hide_render, other.hide_render], "selected": sorted(o.name for o in bpy.context.selected_objects),
	"baked": [round(float(pixels[16, 8, 0]), 4), round(float(pixels[16, 24, 0]), 4)]}
print("result " + json.dumps({"inside": inside, "after": after}))
"""

	@classmethod
	def setUpClass(cls):
		tree = ast.parse((HERE / "build.py").read_text())
		found = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "baking"]
		source = ast.unparse(ast.Module(body=found, type_ignores=[]))
		with tempfile.TemporaryDirectory() as d:
			script = Path(d) / "baking.py"
			script.write_text(cls.SCRIPT)
			run = subprocess.run(["blender", "-b", "--factory-startup", "--python-exit-code", "1", "-P", str(script), "--", source], capture_output=True, text=True, timeout=600)
		if run.returncode or "Traceback" in run.stdout + run.stderr:
			raise RuntimeError(run.stdout[-3000:] + run.stderr[-3000:])
		cls.result = json.loads(re.search(r"^result (.*)$", run.stdout, re.M)[1])

	def test_the_copy_holds_every_face_where_it_stands_with_its_uvs_and_attributes(self):
		inside = self.result["inside"]
		self.assertEqual(inside["faces"], 2)
		self.assertEqual(inside["vertices"], inside["expected"])
		self.assertEqual(inside["uvs"], sorted([[0, 0], [0.5, 0], [0.5, 1], [0, 1], [0.5, 0], [1, 0], [1, 1], [0.5, 1]]))
		self.assertEqual(inside["kind"], [0.25, 0.75])
		self.assertTrue(inside["selected"] and inside["active"])

	def test_the_parts_stand_hidden_from_the_render_while_the_copy_bakes(self):
		# coincident with the copy, they would shade it
		self.assertEqual(self.result["inside"]["hidden"], [True, True, False])

	def test_it_bakes_each_part_into_its_own_texels(self):
		self.assertEqual(self.result["after"]["baked"], [0.25, 0.75])

	def test_it_leaves_the_scene_as_it_found_it(self):
		after = self.result["after"]
		self.assertEqual(after["objects"], ["a", "b", "joint", "other"])
		self.assertEqual(after["meshes"], ["a", "b", "other"])
		self.assertEqual(after["hidden"], [False, False, False])
		self.assertEqual(after["selected"], ["a", "b"])


class OcclusionTest(unittest.TestCase):
	# The ambient occlusion cast at a lent texel (build.py occlusion()), at a
	# point facing up: under an open sky with a floor 5 m below; lying on a
	# floor; under a roof a metre up; under the roof with a round hole a metre
	# across straight overhead, which passes half the sky's cosine weight (a
	# hole of half-angle a passes sin² a: 0.29 spread evenly over the
	# hemisphere); and under the roof with a reach short of it
	SCRIPT = """
import json, math, sys
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree
exec(sys.argv[sys.argv.index("--") + 1])
big = 1000.0
plane = lambda z: BVHTree.FromPolygons([(-big, -big, z), (big, -big, z), (big, big, z), (-big, big, z)], [(0, 1, 2, 3)])
ring = [(math.cos(2 * math.pi * k / 256), math.sin(2 * math.pi * k / 256), 1.0) for k in range(256)]
holed = BVHTree.FromPolygons(ring + [(big * x, big * y, 1.0) for x, y, _ in ring], [(k, (k + 1) % 256, 256 + (k + 1) % 256, 256 + k) for k in range(256)])
point, up = np.array([[0.0, 0.0, 0.0]]), np.array([[0.0, 0.0, 1.0]])
cast = lambda tree, reach=1e4: float(occlusion(tree, point, up, reach)[0])
print("result " + json.dumps({"open": cast(plane(-5.0)), "floor": cast(plane(0.0)), "roof": cast(plane(1.0)), "hole": cast(holed), "reach": cast(plane(1.0), 0.5)}))
"""

	@classmethod
	def setUpClass(cls):
		tree = ast.parse((HERE / "build.py").read_text())
		found = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "occlusion"]
		with tempfile.TemporaryDirectory() as d:
			script = Path(d) / "occlusion.py"
			script.write_text(cls.SCRIPT)
			run = subprocess.run(["blender", "-b", "--factory-startup", "--python-exit-code", "1", "-P", str(script), "--", ast.unparse(ast.Module(body=found, type_ignores=[]))], capture_output=True, text=True, timeout=600)
		if run.returncode or "Traceback" in run.stdout + run.stderr:
			raise RuntimeError(run.stdout[-3000:] + run.stderr[-3000:])
		cls.result = json.loads(re.search(r"^result (.*)$", run.stdout, re.M)[1])

	def test_an_open_sky_is_unoccluded_and_a_roof_hides_it_all(self):
		self.assertEqual(self.result["open"], 1.0)
		self.assertEqual(self.result["roof"], 0.0)

	def test_a_point_on_a_face_is_not_shaded_by_that_face(self):
		self.assertEqual(self.result["floor"], 1.0)

	def test_a_hole_overhead_passes_its_share_of_the_cosine_weighted_sky(self):
		self.assertAlmostEqual(self.result["hole"], 0.5, delta=0.03)

	def test_a_roof_beyond_the_reach_hides_nothing(self):
		self.assertEqual(self.result["reach"], 1.0)


class SeatTest(unittest.TestCase):
	# A cut panel's open edge put back on its plan outline (build.py seat()):
	# a unit square panel on the skin z = 0.1 y², a 4 by 4 grid of quads,
	# its corner at (0, 1) pulled 0.02 in along one side and the edge's
	# vertex at (0.5, 0) pulled 0.01 off it, as the cut's cleanup leaves
	# them, one at (1, 0.5) pulled 0.08 off, past the reach of 0.05, and an
	# inside vertex moved to 0.03 from the edge, which is no edge's own
	SCRIPT = """
import json, math, sys
import bmesh
from mathutils import Vector
from mathutils.bvhtree import BVHTree
exec(sys.argv[sys.argv.index("--") + 1])
z = lambda x, y: 0.1 * y * y
skin = bmesh.new()
n = 40
grid = [[skin.verts.new((-0.5 + 2 * i / n, -0.5 + 2 * j / n, z(-0.5 + 2 * i / n, -0.5 + 2 * j / n))) for j in range(n + 1)] for i in range(n + 1)]
for i in range(n):
	for j in range(n):
		skin.faces.new((grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]))
surface = BVHTree.FromBMesh(skin)
bm = bmesh.new()
verts = {(i, j): bm.verts.new((i / 4, j / 4, z(i / 4, j / 4))) for i in range(5) for j in range(5)}
for i in range(4):
	for j in range(4):
		bm.faces.new((verts[i, j], verts[i + 1, j], verts[i + 1, j + 1], verts[i, j + 1]))
verts[0, 4].co = Vector((0.0, 0.98, z(0.0, 0.98)))
verts[2, 0].co = Vector((0.5, 0.01, z(0.5, 0.01)))
verts[4, 2].co = Vector((0.92, 0.5, z(0.92, 0.5)))
verts[1, 1].co = Vector((0.25, 0.03, z(0.25, 0.03)))
moved = seat(bm, [(0, 0), (1, 0), (1, 1), (0, 1)], surface, Vector((0, 0, 1)), 0.05)
at = lambda k: list(verts[k].co)
print("result " + json.dumps({"moved": moved, "corner": at((0, 4)), "edge": at((2, 0)), "far": at((4, 2)), "inside": at((1, 1)), "other": at((4, 4))}))
"""

	@classmethod
	def setUpClass(cls):
		tree = ast.parse((HERE / "build.py").read_text())
		found = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "seat"]
		with tempfile.TemporaryDirectory() as d:
			script = Path(d) / "seat.py"
			script.write_text(cls.SCRIPT)
			run = subprocess.run(["blender", "-b", "--factory-startup", "--python-exit-code", "1", "-P", str(script), "--", ast.unparse(ast.Module(body=found, type_ignores=[]))], capture_output=True, text=True, timeout=600)
		if run.returncode or "Traceback" in run.stdout + run.stderr:
			raise RuntimeError(run.stdout[-3000:] + run.stderr[-3000:])
		cls.result = json.loads(re.search(r"^result (.*)$", run.stdout, re.M)[1])

	def test_a_corner_pulled_in_goes_back_to_the_outline_s_corner_on_the_skin(self):
		for got, want in zip(self.result["corner"], (0.0, 1.0, 0.1)):
			self.assertAlmostEqual(got, want, places=6)

	def test_an_edge_s_vertex_pulled_off_goes_back_onto_the_edge_on_the_skin(self):
		for got, want in zip(self.result["edge"], (0.5, 0.0, 0.0)):
			self.assertAlmostEqual(got, want, places=6)

	def test_a_vertex_past_the_reach_and_one_inside_stay_where_they_are(self):
		for got, want in zip(self.result["far"], (0.92, 0.5, 0.025)):
			self.assertAlmostEqual(got, want, places=6)
		for got, want in zip(self.result["inside"], (0.25, 0.03, 0.1 * 0.03 * 0.03)):
			self.assertAlmostEqual(got, want, places=6)
		for got, want in zip(self.result["other"], (1.0, 1.0, 0.1)):
			self.assertAlmostEqual(got, want, places=6)
		self.assertEqual(self.result["moved"], 2)


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
		"atlas": (None, ("ATLAS = 4096\n", "ATLAS = 2048\n")),
		"store_bakes": (None, ("	occlusion = np.ones((size, size), np.float32)\n", "	occlusion = np.ones((size, size), np.float32)   # changed\n")),
		"reach": (None, ("STORE_REACH = 12.0\n", "STORE_REACH = 12.5\n")),
		"store_atlas": (lambda l: l["stores"]["paint"].update(atlas=512), None),
		"strip": (None, ("STRIP = 0.03   #", "STRIP = 0.04   #")),
		"density": (None, ("STENCIL_DENSITY = 4.6   #", "STENCIL_DENSITY = 3.0   #")),
		"open_reach": (None, ("OPEN_REACH = 24.0   #", "OPEN_REACH = 25.0   #")),
		"margin": (None, ("STENCIL_MARGIN = 1.5    #", "STENCIL_MARGIN = 2.0    #")),
		"nozzles": (None, ("			NOZZLE_PARTS.append(petal)\n", "			NOZZLE_PARTS.append(petal) if k else None\n")),
		"baking": (None, ("		mesh.transform(o.matrix_world)\n", "		mesh.transform(o.matrix_world)   # changed\n")),
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

	def test_the_joined_copy_both_bake_on_counts_in_both_keys(self):
		self.assertEqual(self.moved("baking"), {"paint": True, "stores": True})


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
