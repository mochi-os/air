# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# Tests for paint.py: where each marking lands in the image, which must match
# build.py's mapping (port at the top, the bow to the right).
#
# usage: python3 -I test_paint.py
import json, sys, unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import paint  # noqa: E402

GREY, RED, WHITE = [60, 60, 60], [200, 0, 0], [240, 240, 240]
# 20 x 10 m at 10 cm a texel
LAYOUT = {"deck": {"texture": {"x": [-10, 10], "z": [-5, 5], "pixels": [200, 100]}}, "paint": {"deck": GREY}}


def at(image, x, z):
	# the texel under a deck point
	return list(image.getpixel((int((x + 10) / 20 * 200), int((z + 5) / 10 * 100))))


def inside(point, outline):
	# a plan point in a polygon (even-odd)
	x, z = point
	result = False
	for (ax, az), (bx, bz) in zip(outline, outline[1:] + outline[:1]):
		if (az > z) != (bz > z) and x < ax + (z - az) * (bx - ax) / (bz - az):
			result = not result
	return result


class Paint(unittest.TestCase):
	def render(self, *markings):
		return paint.render({**LAYOUT, "markings": list(markings)})

	def test_size_and_base(self):
		image = self.render()
		self.assertEqual(image.size, (200, 100))
		self.assertEqual(at(image, 0, 0), GREY)

	def test_port_is_the_top_and_the_bow_the_right(self):
		image = self.render({"kind": "area", "outline": [[6, -4], [8, -4], [8, -2], [6, -2]], "colour": RED})
		self.assertEqual(at(image, 7, -3), RED)       # forward, to port
		self.assertEqual(at(image, 7, 3), GREY)       # its mirror to starboard
		self.assertEqual(at(image, -7, -3), GREY)     # its mirror aft
		x, y = 170, 10   # col (7 + 10) / 20, row (-3 + 5) / 10: right and near the top
		self.assertEqual(list(image.getpixel((x, y))), RED)

	def test_line_width(self):
		image = self.render({"kind": "line", "points": [[-8, 0], [8, 0]], "width": 1.0, "colour": WHITE})
		self.assertEqual(at(image, 0, 0.4), WHITE)
		self.assertEqual(at(image, 0, -0.4), WHITE)
		self.assertEqual(at(image, 0, 0.7), GREY)
		self.assertEqual(at(image, 9, 0), GREY)       # past its end

	def test_dashes(self):
		image = self.render({"kind": "line", "points": [[-8, 0], [8, 0]], "width": 1.0, "colour": WHITE, "dash": [2, 2]})
		self.assertEqual(at(image, -7, 0), WHITE)     # the first dash, -8 to -6
		self.assertEqual(at(image, -5, 0), GREY)      # the first gap
		self.assertEqual(at(image, -3, 0), WHITE)
		self.assertEqual(at(image, 7, 0), GREY)       # 6 to 8 is a gap

	def test_dashes_turn_corners(self):
		# a 3 m dash starting 1 m before a corner carries 2 m round it
		pieces = paint.dashes([[0, 0], [1, 0], [1, 5]], 3, 1)
		self.assertEqual(pieces[0], [[0, 0], [1, 0], [1.0, 2.0]])
		self.assertEqual(pieces[1], [[1.0, 3.0], [1, 5]])

	def test_text_turns_its_top_to_up(self):
		# a 7 4 m tall along x with its top to the bow: its top bar spans the
		# box's width at the forward end, its foot is narrow at the aft end
		image = self.render({"kind": "text", "text": "7", "centre": [0, 0], "height": 4, "width": 2, "up": [1, 0], "colour": WHITE})
		def painted(x):
			return sum(at(image, x, z / 10) == WHITE for z in range(-12, 13))
		self.assertGreater(painted(1.8), 12)
		self.assertLess(painted(-1.8), 8)
		self.assertGreater(painted(-1.8), 0)
		self.assertEqual(at(image, 2.5, 0), GREY)      # nothing past the box
		self.assertEqual(at(image, 0, 1.5), GREY)

	def test_circles(self):
		image = self.render({"kind": "circle", "centre": [-5, 0], "radius": 2, "fill": True, "colour": RED},
			{"kind": "circle", "centre": [5, 0], "radius": 2, "fill": False, "width": 0.4, "colour": RED})
		self.assertEqual(at(image, -5, 0), RED)
		self.assertEqual(at(image, -5, 1.7), RED)
		self.assertEqual(at(image, -5, 2.5), GREY)
		self.assertEqual(at(image, 5, 0), GREY)        # the ring hollow
		self.assertEqual(at(image, 5, 2), RED)

	def test_stains_darken_in_linear_light(self):
		# half the light gone over the stain's middle, none well outside it,
		# and part of it across its feathered edge; the markings under it
		# darkened alike
		image = paint.render({**LAYOUT, "markings": [{"kind": "area", "outline": [[-2, -4], [2, -4], [2, 4], [-2, 4]], "colour": WHITE}],
			"stains": [{"outline": [[-6, -4], [6, -4], [6, 4], [-6, 4]], "darkening": 0.5, "feather": 1.0}]})
		half = lambda c: round(255 * ((((c / 255 + 0.055) / 1.055) ** 2.4 / 2) ** (1 / 2.4) * 1.055 - 0.055))
		self.assertEqual(at(image, -4, 0), [half(c) for c in GREY])
		self.assertEqual(at(image, 0, 0), [half(c) for c in WHITE])
		self.assertEqual(at(image, -9, 0), GREY)
		edge = at(image, -6, 0)[0]
		self.assertTrue(half(GREY[0]) < edge < GREY[0], edge)

	def test_wear_is_seeded_and_leaves_an_unworn_deck_alone(self):
		worn = {**LAYOUT, "deck": {**LAYOUT["deck"], "outline": [[-10, -5], [10, -5], [10, 5], [-10, 5]]}, "markings": [],
			"wear": {"seed": 1, "mottle": [[4, 0.05], [1, 0.05]]}}
		a, b = paint.render(worn), paint.render(worn)
		self.assertEqual(a.tobytes(), b.tobytes())
		self.assertNotEqual(a.tobytes(), self.render().tobytes())
		flat = paint.render({**worn, "wear": {"mottle": [[4, 0.0]]}})
		self.assertEqual(flat.tobytes(), self.render().tobytes())

	def test_mottle_spreads_as_asked(self):
		# the tone's spread in linear light the mottle's, at its scale
		worn = {**LAYOUT, "deck": {**LAYOUT["deck"], "texture": {"x": [-10, 10], "z": [-5, 5], "pixels": [400, 200]}}, "markings": [],
			"wear": {"seed": 2, "mottle": [[1.0, 0.08]]}}
		lin = paint.linear(np.asarray(paint.render(worn), np.float32))[..., 1]
		spread = np.std(np.log(lin / np.median(lin)))
		self.assertAlmostEqual(spread, 0.08, delta=0.02)

	def test_soot_on_its_panel_only(self):
		# the soot's core where the share puts it on the panel, as dark as asked,
		# and none past the panel's outline
		outline = [[-4, -3], [0, -3], [0, 3], [-4, 3], [-4, -3]]
		worn = {**LAYOUT, "markings": [{"name": "jbd_outline", "kind": "line", "points": outline, "width": 0.01, "colour": GREY}],
			"wear": {"deflectors": {"along": 0.25, "across": 0.5, "spread": [0.8, 1.5], "panels": {"jbd_outline": 0.8}}}}
		image = np.asarray(paint.render(worn), np.float32)
		lin = paint.linear(image)[..., 1]
		grey = paint.linear(np.array(GREY, np.float32))[1]
		row = lambda z: int((z + 5) / 10 * 100)
		col = lambda x: int((x + 10) / 20 * 200)
		panel = lin[row(-2.9) : row(2.9), col(-3.9) : col(-0.1)]
		dark = 1 - panel / grey
		def peak(profile, start):
			# the core's place: a parabola through the profile's top, past the 8-bit ties
			i = int(np.argmax(profile))
			k = np.arange(max(0, i - 6), min(len(profile), i + 7))
			a, b, _ = np.polyfit(k, profile[k], 2)
			return start + -b / (2 * a) / 10
		self.assertAlmostEqual(peak(dark.mean(0), -3.9), -3.0, delta=0.1)   # a quarter along from its aft edge
		self.assertAlmostEqual(peak(dark.mean(1), -2.9), 0.0, delta=0.1)    # across its middle
		self.assertAlmostEqual(panel.min() / grey, 0.2, delta=0.03)
		self.assertTrue(np.allclose(lin[:, col(0.2) :], grey, atol=1e-4))     # forward of the panel
		self.assertTrue(np.allclose(lin[: row(-3.2), :], grey, atol=1e-4))    # to port of it

	def test_spots_on_the_deck_and_out_of_the_clear_area(self):
		clear = [[-10, -5], [0, -5], [0, 5], [-10, 5]]
		worn = {**LAYOUT, "deck": {**LAYOUT["deck"], "outline": [[-10, -5], [10, -5], [10, 0], [-10, 0]]},
			"elevators": [{"outline": [[6, 0], [10, 0], [10, 5], [6, 5]]}],
			"markings": [{"name": "landing", "kind": "area", "outline": clear, "colour": GREY}],
			"wear": {"seed": 4, "spots": {"count": 40, "size": [0.5, 0.8], "darkening": [0.3, 0.4], "clear": "landing"}}}
		lin = paint.linear(np.asarray(paint.render(worn), np.float32))[..., 1]
		dark = lin < paint.linear(np.array(GREY, np.float32))[1] * 0.97
		rows, cols = np.nonzero(dark)
		self.assertTrue(len(rows))
		# none centred in the clear area, aft of x 0, nor off the deck, to
		# starboard of z 0, but on the elevator there (each reaching its
		# radius, 0.4 m, and its blur past)
		self.assertGreaterEqual(cols.min(), 100 - 6)
		off = dark[50 + 6 :, : 160 - 6]
		self.assertFalse(off.any())
		self.assertTrue(dark[50 + 6 :, 160 + 6 :].any())
		self.assertGreater(cols.mean(), 120)

	def test_tyres_meet_the_measured_band(self):
		# the facts' generator against the band measured in the photo: the
		# core and the shoulders' shares in 10 m steps along the landing line
		# (the shoulders past the touchdown zone held at 1, their reference
		# strip there darker than they are)
		layout = json.loads((Path(paint.HERE) / "facts.json").read_text())["layout"]
		spec = layout["wear"]["tyres"]
		grid, ss, ts = paint.tyre_density(layout, spec)
		share = np.exp(-grid)
		S, T = np.meshgrid(ss, ts)
		misses = []
		for s0, (core, shoulder) in spec["measured"].items():
			cols = (S >= int(s0)) & (S < int(s0) + 10)
			got = np.median(share[cols & (np.abs(T + 0.5) <= 2.5)]), np.median(share[cols & (np.abs(T + 0.5) > 2.5) & (np.abs(T + 0.5) <= 6)])
			misses += [got[0] - core, got[1] - min(shoulder, 1.0)]
		misses = np.array(misses)
		self.assertLess(np.sqrt(np.mean(misses ** 2)), 0.12)
		self.assertLess(np.abs(misses).max(), 0.25)

	def small_tyres(self, **more):
		# one landing on a short deck: its line along x, a wire at x -2
		spec = {"seed": 5, "landings": 1, "gauge": 3.0, "track": 0.4, "wires": {"1": 1.0}, "reach": 20.0, "width": 5.0,
			"touchdown": {"before": 3.0, "spread": 0.0}, "lateral": {"mean": 1.0, "spread": 0.0, "heading": 2.0, "pull": 1000.0},
			"smear": {"length": [2.0, 2.0], "density": 1.0}, "rollout": 0.5, "runout": [5.0, 5.0],
			"forward": {"start": [30.0, 30.0], "end": [30.0, 30.0], "spread": 0.0, "density": 0.0}}
		spec.update(more)
		layout = {**LAYOUT, "markings": [], "landing": {"line": [[-9, 0], [9, 0]], "wires": [{"number": 1, "ends": [[-2, 19, -3], [-2, 19, 3]]}]}}
		return layout, spec

	def test_tyres_land_where_the_landing_frame_puts_them(self):
		# the rubber's grid carried onto the texture: across + to starboard (z +),
		# along from the line's aft end; its darkness the grid's
		layout, spec = self.small_tyres()
		grid, ss, ts = paint.tyre_density(layout, spec)
		image = paint.render({**layout, "wear": {"tyres": spec}})
		lin = paint.linear(np.asarray(image, np.float32))[..., 1]
		grey = paint.linear(np.array(GREY, np.float32))[1]
		for s_, t_ in ((4.0, 2.5), (4.0, -0.5), (7.0, 2.5)):
			j, i = int(round(s_ / (ss[1] - ss[0]))), int(round((t_ - ts[0]) / (ts[1] - ts[0])))
			x, z = -9 + s_, t_
			got = lin[int((z + 5) / 10 * 100), int((x + 10) / 20 * 200)] / grey
			self.assertAlmostEqual(got, np.exp(-grid[i, j]), delta=0.08, msg=(s_, t_))
		self.assertLess(lin[int((-0.5 + 5) * 10), int((-5 + 10) * 10)] / grey, 0.97)   # its port track, at t 1.0 - 1.5
		self.assertAlmostEqual(lin[int((-4.0 + 5) * 10), int((-5 + 10) * 10)] / grey, 1.0, delta=0.01)   # nothing out at z -4

	def test_tracks_run_smooth(self):
		# a track on a slant moves across by less than a cell from step to step,
		# not in the cells' steps
		layout, spec = self.small_tyres()
		grid, ss, ts = paint.tyre_density(layout, spec)
		upper = grid[ts > 1.0]
		t = ts[ts > 1.0]
		rolling = (ss > 4.5) & (ss < 10.5)
		centre = (upper[:, rolling] * t[:, None]).sum(0) / upper[:, rolling].sum(0)
		self.assertLess(np.abs(np.diff(centre)).max(), 0.02)
		self.assertGreater(abs(centre[-1] - centre[0]), 0.05)   # it does slant, by less than a cell over the run

	def test_heavy_landings_stand_out_as_streaks(self):
		# each landing's own weight of rubber: across the band at the wires its
		# fine contrast (less a metre's running mean) half again what alike
		# landings leave
		layout = json.loads((Path(paint.HERE) / "facts.json").read_text())["layout"]
		spec = layout["wear"]["tyres"]
		def contrast(variation):
			grid, ss, ts = paint.tyre_density(layout, dict(spec, variation=variation))
			across = np.exp(-grid[:, (ss >= 60) & (ss < 62)]).mean(1)
			fine = across - np.convolve(across, np.ones(11) / 11, mode="same")
			return np.std(fine[np.abs(ts + 0.5) < 4])
		self.assertGreater(contrast(spec["variation"]), 1.4 * contrast(0.0))

	def test_tyre_band_rounded_at_its_aft_edge(self):
		# where the band begins, line by line across it: aftmost on the
		# centreline, later the farther off it (the photo's rounded edge, not
		# a straight one across)
		layout = json.loads((Path(paint.HERE) / "facts.json").read_text())["layout"]
		spec = layout["wear"]["tyres"]
		grid, ss, ts = paint.tyre_density(layout, spec)
		share = np.exp(-grid)
		def begins(near, far):
			# where the band's dark mass starts over a strip of lines `near` to
			# `far` off the centreline, either side
			off = np.abs(ts - spec["lateral"]["mean"])
			band = share[(off >= near) & (off < far)].mean(0)
			run = np.convolve(band, np.ones(10) / 10, mode="valid")   # over a metre along
			return ss[np.argmax(run < 0.7)] if (run < 0.7).any() else np.inf
		# the nose on the centreline and over a centred jet's wheels, then later out to the sides
		self.assertLess(begins(0.0, 1.5), begins(1.5, 3.0) + 0.5)
		self.assertLess(begins(1.5, 3.0), begins(3.0, 4.5) - 4.0)
		self.assertLess(begins(3.0, 4.5), begins(4.5, 6.0) - 2.0)

	def test_tyre_band_tapers(self):
		# wide at the touchdown, narrow past the wires, clean aft of the touchdown
		layout = json.loads((Path(paint.HERE) / "facts.json").read_text())["layout"]
		grid, ss, ts = paint.tyre_density(layout, layout["wear"]["tyres"])
		width = lambda s0: (np.exp(-grid[:, (ss >= s0) & (ss < s0 + 10)]).mean(1) < 0.85).sum() * (ts[1] - ts[0])
		self.assertGreater(width(55), 8.0)
		self.assertLess(width(100), width(55) * 0.6)
		self.assertLess(width(15), 0.5)

	def lin_green(self, layout):
		return paint.linear(np.asarray(paint.render(layout), np.float32))[..., 1] / paint.linear(np.array(GREY, np.float32))[1]

	def at_lin(self, lin, x, z):
		return lin[int((z + 5) / 10 * 100), int((x + 10) / 20 * 200)]

	def test_tiedowns_on_their_lattice(self):
		# a dark dot at each of the lattice's points, the odd rows half a step on,
		# none between them, none in a clear area nor off the deck
		ties = {"origin": [0.0, 0.0], "along": 2.0, "across": 1.0, "diameter": 0.3, "darkening": 0.5, "clear_suffixes": ["_panel"]}
		layout = {**LAYOUT, "deck": {**LAYOUT["deck"], "outline": [[-10, -5], [10, -5], [10, 3.5], [-10, 3.5]]},
			"elevators": [{"outline": [[-10, 3.5], [0, 3.5], [0, 5], [-10, 5]]}],
			"markings": [{"name": "jbd_panel", "kind": "area", "outline": [[4.5, -4], [8.5, -4], [8.5, 4], [4.5, 4]], "colour": GREY}],
			"wear": {"tiedowns": ties}}
		lin = self.lin_green(layout)
		self.assertLess(self.at_lin(lin, 0.0, 0.0), 0.7)      # a row's fitting
		self.assertLess(self.at_lin(lin, -1.0, 1.0), 0.7)     # the next row's, half a step on
		self.assertGreater(self.at_lin(lin, -1.0, 0.0), 0.98)  # between them
		self.assertGreater(self.at_lin(lin, 0.0, 1.0), 0.98)
		self.assertGreater(lin[int(1 / 10 * 100) :, int(14.6 / 20 * 200) : int(18.4 / 20 * 200)].min(), 0.98)   # none on the panel
		self.assertGreater(lin[int(8.7 / 10 * 100) :, int(10.5 / 20 * 200) :].min(), 0.98)   # none off the deck, past z 3.5
		self.assertLess(self.at_lin(lin, -4.0, 4.0), 0.7)     # on the elevator

	def test_deck_covers_are_filled(self):
		# the barricade's trays and hatches and the bow's hatch (facts.json): each a filled cover, its rim, its frame
		# where it has one and its centre nested in turn, none drawn as a bare outline, no tie-down fitting on it
		layout = json.loads((Path(paint.HERE) / "facts.json").read_text())["layout"]
		marks = {m["name"]: m for m in layout["markings"]}
		covers = [n[: -len("_cover")] for n in marks if n.endswith("_cover")]
		self.assertEqual(len(covers), 6, covers)
		self.assertFalse([n for n in covers if n in marks], "a cover's old outline is still drawn")
		self.assertIn("_cover", layout["wear"]["tiedowns"]["clear_suffixes"])
		texture = layout["deck"]["texture"]
		canvas = paint.Canvas(texture, 1)
		image = np.asarray(paint.render(layout), np.float32)
		for name in covers:
			rings = [marks[name + "_cover"]] + [marks[name + s] for s in ("_cover_frame", "_cover_centre") if name + s in marks]
			for outer, inner in zip(rings, rings[1:]):
				for x, z in inner["outline"]:
					self.assertTrue(inside((x, z), outer["outline"]), (name, inner["name"]))
			# the centre's middle wears the centre's colour, worn but not dotted: within the wear's spread of it, and no
			# texel of the centre darker than a tie-down fitting leaves one
			centre = rings[-1]
			o = np.array(centre["outline"])
			points = [(x, z) for x in np.linspace(o[:, 0].min(), o[:, 0].max(), 40) for z in np.linspace(o[:, 1].min(), o[:, 1].max(), 20)
				if inside((x, z), centre["outline"])]
			self.assertGreater(len(points), 5, name)
			got = np.median([paint.linear(image[int(canvas.pixel(p)[1]), int(canvas.pixel(p)[0])]) for p in points], axis=0)
			want = paint.linear(np.array(centre["colour"], np.float32))
			np.testing.assert_allclose(got / want, 1.0, atol=0.35, err_msg=name)
		# no fitting on a cover: the darkest texel inside each cover against its centre's colour, with the lattice and
		# without it (the same layout less its tie-downs), differ by less than a fitting's darkening
		plain = np.asarray(paint.render({**layout, "wear": {k: w for k, w in layout["wear"].items() if k != "tiedowns"}}), np.float32)
		ratio = paint.linear(image[..., 1] + 0.5) / paint.linear(plain[..., 1] + 0.5)
		from PIL import Image, ImageDraw
		for name in covers:
			mask = Image.new("L", (ratio.shape[1], ratio.shape[0]), 0)
			ImageDraw.Draw(mask).polygon([canvas.pixel(p) for p in marks[name + "_cover"]["outline"]], fill=255)
			inner = np.asarray(mask.filter(__import__("PIL.ImageFilter", fromlist=["MinFilter"]).MinFilter(7))) > 0   # a fitting's width in from its edge, where one beside it still reaches
			self.assertGreater(inner.sum(), 4, name)
			self.assertGreater(ratio[inner].min(), 0.9, name)

	def test_ramp_over_the_round_down(self):
		# the ramp at the stern as the 2022-23 photos show it (facts.json): white over the round-down aft of the stripe
		# to the deck's edge, light grey along the edge either side of it, the plain deck forward of that grey, and
		# the centreline's yellow over the white to the edge
		layout = json.loads((Path(paint.HERE) / "facts.json").read_text())["layout"]
		marks = {m["name"]: m for m in layout["markings"]}
		canvas = paint.Canvas(layout["deck"]["texture"], 1)
		image = np.asarray(paint.render(layout), np.float32)
		(ax, az), (bx, bz) = layout["deck"]["round"]["edge"]
		edge = lambda z: ax + (z - az) / (bz - az) * (bx - ax)
		def wears(x, z, colour, name):
			# the median of the texels within 0.15 m against the colour, in linear light, within the wear's spread
			c, r = canvas.pixel((x, z)); patch = image[int(r) - 2:int(r) + 3, int(c) - 2:int(c) + 3].reshape(-1, 3)
			got = np.median(paint.linear(patch), axis=0)
			np.testing.assert_allclose(got / paint.linear(np.array(colour, np.float32)), 1.0, atol=0.3, err_msg=name)
		white, light, deck = marks["ramp"]["colour"], marks["ramp_port"]["colour"], layout["paint"]["deck"]
		for z in (10, 16):
			wears(edge(z) + 0.4, z, white, f"the round-down at z {z}, between the stripe and the edge")
		wears(edge(-10) + 1.0, -10, light, "the port strip")
		wears(edge(-6) + 2.5, -6, deck, "forward of the port strip")
		wears(edge(20.5) + 1.5, 20.5, light, "the starboard end")
		# the outline traced on the 2023 overhead: the white out to z -5.2 and 19.9 a metre in from the edge, the
		# starboard grey 4.55 deep and the plain deck beyond it
		wears(edge(-5.1) + 1.0, -5.1, white, "the white's port end")
		wears(edge(19.75) + 1.0, 19.75, white, "the white's starboard end")
		wears(edge(21) + 4.0, 21, light, "the starboard grey, 4 m in")
		wears(edge(21) + 5.2, 21, deck, "forward of the starboard grey")
		# the gutters' grates at the edge, the light grey either side of the starboard one
		wears(edge(20.6) + 0.05, 20.6, marks["grate_starboard"]["colour"], "the starboard grate")
		wears(edge(-14.0) + 0.05, -14.0, marks["grate_port"]["colour"], "the port grate")
		wears(edge(21.5) + 0.05, 21.5, light, "outboard of the starboard grate")
		(cx, cz), (dx, dz) = marks["centreline"]["points"]
		x = edge(cz) + 0.4
		wears(x, cz + (x - cx) / (dx - cx) * (dz - cz), marks["centreline_yellow_1"]["colour"], "the centreline over the white")

	def test_scorch_forward_of_the_hinge(self):
		# darkest just forward of the hinge on the track's line, none aft of it,
		# fading forward and to the sides
		layout = {**LAYOUT, "markings": [], "catapults": [{"track": [[0.0, 0.0], [9.0, 0.0]], "battery": [0.5, 0.0], "deflector": {"hinge": [[-3.0, -2.0], [-3.0, 2.0]]}}],
			"wear": {"deflectors": {"along": 0.25, "across": 0.5, "spread": [1.0, 1.0], "panels": {}, "forward": {"darkening": 0.5, "spread": [1.0, 1.5]}}}}
		lin = self.lin_green(layout)
		self.assertLess(self.at_lin(lin, -2.9, 0.0), 0.6)
		self.assertGreater(self.at_lin(lin, -3.3, 0.0), 0.99)       # aft of the hinge
		self.assertGreater(self.at_lin(lin, 0.5, 0.0), 0.97)        # 3.5 m forward
		self.assertGreater(self.at_lin(lin, -2.9, 3.0), self.at_lin(lin, -2.9, 0.0) + 0.2)

	def test_taxi_tracks_onto_the_catapult_and_the_elevator(self):
		# the catapult's arcs from aft and to either side, arriving along its
		# track; the elevator's from inboard onto its platform
		layout = {**LAYOUT, "markings": [], "catapults": [{"track": [[0.0, 0.0], [9.0, 0.0]], "battery": [0.0, 0.0], "deflector": {"hinge": [[-3.0, -2.0], [-3.0, 2.0]]}}],
			"elevators": [{"outline": [[2.0, 3.0], [6.0, 3.0], [6.0, 5.0], [2.0, 5.0]]}]}
		taxi = {"seed": 2, "gauge": 1.0, "track": 0.2, "catapults": {"count": 20, "aft": [6.0, 8.0], "offset": [1.5, 3.5], "join": [2.0, 3.0], "density": 3.0},
			"elevators": {"count": 10, "along": [2.0, 3.0], "inboard": [1.0, 2.0], "density": 3.0}}
		canvas = paint.Canvas(layout["deck"]["texture"], 1)
		cat = paint.taxi_density(layout, dict(taxi, elevators=None), canvas, (100, 200))
		lift = paint.taxi_density(layout, dict(taxi, catapults=None), canvas, (100, 200))
		row = lambda z: int((z + 5) / 10 * 100)
		col = lambda x: int((x + 10) / 20 * 200)
		near_track = cat[row(-0.8) : row(0.8), col(-1.5) : col(-0.5)]
		self.assertGreater(near_track.sum(), 0)                                       # along the track before the battery
		self.assertGreater(cat[:, col(-8) : col(-6)][np.r_[row(-5) : row(-1.6), row(1.6) : row(5)]].sum(), 0)   # starting off to the sides, aft
		self.assertEqual(cat[:, col(0.5) :].sum(), 0)                               # none past the battery
		self.assertGreater(lift[row(3.2) : row(5), col(2) : col(6)].sum(), 0)        # onto the platform
		self.assertGreater(lift[row(1.0) : row(2.0), :].sum(), 0)                    # from inboard of it

	def test_taxi_tracks_on_the_texture(self):
		layout = {**LAYOUT, "markings": [], "catapults": [{"track": [[0.0, 0.0], [9.0, 0.0]], "battery": [0.0, 0.0], "deflector": {"hinge": [[-3.0, -2.0], [-3.0, 2.0]]}}]}
		taxi = {"seed": 2, "gauge": 1.0, "track": 0.2, "catapults": {"count": 20, "aft": [6.0, 8.0], "offset": [1.5, 3.5], "join": [2.0, 3.0], "density": 3.0}}
		lin = self.lin_green({**layout, "wear": {"taxi": taxi}})
		self.assertLess(lin[:, : int(10 / 20 * 200)].min(), 0.9)
		self.assertGreater(lin[:, int(10.5 / 20 * 200) :].min(), 0.999)

	def test_taxi_tracks_fade_onto_the_catapult(self):
		# their last share faded, where every one runs the same line to the battery
		layout = {**LAYOUT, "markings": [], "catapults": [{"track": [[0.0, 0.0], [9.0, 0.0]], "battery": [0.0, 0.0], "deflector": {"hinge": [[-3.0, -2.0], [-3.0, 2.0]]}}]}
		taxi = {"seed": 2, "gauge": 1.0, "track": 0.2, "catapults": {"count": 20, "aft": [6.0, 8.0], "offset": [1.5, 3.5], "join": [2.0, 3.0], "density": 3.0}}
		canvas = paint.Canvas(layout["deck"]["texture"], 1)
		end = np.s_[int(4.2 / 10 * 100) : int(5.8 / 10 * 100), int(9.0 / 20 * 200) : int(10.0 / 20 * 200)]   # the last metre before the battery
		plain = paint.taxi_density(layout, taxi, canvas, (100, 200))[end].sum()
		faded = paint.taxi_density(layout, {**taxi, "catapults": {**taxi["catapults"], "fade": 0.5}}, canvas, (100, 200))[end].sum()
		self.assertLess(faded, plain * 0.3)

	def test_taxi_tracks_turn_off_the_landing_area(self):
		# from the landing line's stretch where aircraft stop, ahead along it
		# and round to their destination, fading in where they all start
		layout = {**LAYOUT, "markings": [], "landing": {"line": [[-10.0, -3.0], [10.0, -3.0]]}}
		turns = {"count": 20, "along": [6.0, 8.0], "lateral": 0.2, "ahead": [2.0, 3.0], "ends": [[[4.0, 2.0], [6.0, 4.0]]], "density": 3.0}
		taxi = {"seed": 2, "gauge": 1.0, "track": 0.2, "turns": turns}
		canvas = paint.Canvas(layout["deck"]["texture"], 1)
		grid = paint.taxi_density(layout, taxi, canvas, (100, 200))
		row = lambda z: int((z + 5) / 10 * 100)
		col = lambda x: int((x + 10) / 20 * 200)
		self.assertGreater(grid[row(1.5) : row(4.5), col(3.5) : col(6.5)].sum(), 0)   # at their destination
		self.assertGreater(grid[row(-4) : row(-2), col(-3) : col(0)].sum(), 0)        # leaving along the line
		self.assertEqual(grid[:, col(7.5) :].sum(), 0)                               # none past it
		self.assertEqual(grid[:, : col(-6)].sum(), 0)                                # nor aft of where they stop
		self.assertEqual(grid[row(-5) : row(-4.5)].sum(), 0)                         # nor to port of the line
		start = np.s_[row(-4.2) : row(-1.8), col(-4.5) : col(-1.5)]
		faded = paint.taxi_density(layout, {**taxi, "turns": {**turns, "rise": 0.5}}, canvas, (100, 200))[start].sum()
		self.assertLess(faded, grid[start].sum() * 0.5)

	def test_round_down_white_from_where_photographed(self):
		# the facts' ramp: the stripe white from z -5.293 to starboard (its ends where the 2022-23 photos' white ends),
		# the round-down aft of it white from its aft corners, and light grey to either side, each strip meeting the
		# stripe on the stripe's own end, square to it
		layout = json.loads((Path(paint.HERE) / "facts.json").read_text())["layout"]
		ramps = {m["name"]: m for m in layout["markings"] if m["name"].startswith("ramp")}
		self.assertEqual(set(ramps), {"ramp", "ramp_port", "ramp_aft", "ramp_starboard"})
		(px, pz), (qx, qz) = ramps["ramp"]["points"]
		self.assertAlmostEqual(pz, -5.293)
		self.assertEqual(ramps["ramp"]["colour"], layout["paint"]["white"])
		self.assertEqual(ramps["ramp_aft"]["colour"], layout["paint"]["white"])
		length = np.hypot(qx - px, qz - pz); u = np.array([qx - px, qz - pz]) / length
		for name, end, along in (("ramp_port", (px, pz), 0.0), ("ramp_starboard", (qx, qz), length)):
			self.assertLess(sum(ramps[name]["colour"]), sum(ramps["ramp"]["colour"]) * 0.9, name)
			for point in ramps[name]["outline"][:2]:
				self.assertAlmostEqual(float((np.array(point) - np.array([px, pz])) @ u), along, delta=0.002, msg=name)
		# the white over the round-down starts at the stripe's aft corners
		w = np.array([u[1], -u[0]]) * ramps["ramp"]["width"] / 2; w = w if w[0] > 0 else -w
		np.testing.assert_allclose(ramps["ramp_aft"]["outline"][:2], [np.array([px, pz]) - w, np.array([qx, qz]) - w], atol=0.002)

	def test_edge_stripes_meet_the_ramp(self):
		# the landing area's four edge stripes start on the ramp stripe's centre line, so each runs into it as the 2022-23
		# photos show; the port two had all started at x -159.8 with the others, 2.4-2.9 m short of the angled stripe, and
		# the deck there, 1.5 m aft of that old start along each, is now their white
		layout = json.loads((Path(paint.HERE) / "facts.json").read_text())["layout"]
		marks = {m["name"]: m for m in layout["markings"]}
		(px, pz), (qx, qz) = marks["ramp"]["points"]
		u = np.array([qx - px, qz - pz]) / np.hypot(qx - px, qz - pz)
		for name in ("edge_port_inner", "edge_port_outer", "edge_starboard_inner", "edge_starboard_outer"):
			off = np.array(marks[name]["points"][0]) - np.array([px, pz])
			self.assertAlmostEqual(float(off[0] * u[1] - off[1] * u[0]), 0.0, delta=0.002, msg=name)
		canvas = paint.Canvas(layout["deck"]["texture"], 1)
		image = np.asarray(paint.render(layout), np.float32)
		for name in ("edge_port_inner", "edge_port_outer"):
			start, end = (np.array(p, float) for p in marks[name]["points"][:2])
			v = (end - start) / np.linalg.norm(end - start)
			x, z = start + v * (-161.3 - start[0]) / v[0]
			c, r = canvas.pixel((x, z)); patch = image[int(r) - 1:int(r) + 2, int(c) - 1:int(c) + 2].reshape(-1, 3)
			got = np.median(paint.linear(patch), axis=0)
			np.testing.assert_allclose(got / paint.linear(np.array(marks[name]["colour"], np.float32)), 1.0, atol=0.3, err_msg=name)

	def test_unknown_kind(self):
		with self.assertRaises(ValueError):
			self.render({"kind": "triangle", "colour": RED})


if __name__ == "__main__":
	unittest.main()
