# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# Paints the flight deck's texture (decision 6) from the markings table in
# facts.json's layout: the deck's own colour, then each marking, drawn in deck
# metres. The image is the deck seen from above with the bow to the right:
# columns run stern to bow across layout.deck.texture.x, rows port (the top)
# to starboard across its z, as build.py maps it.
#
# A marking is one of:
#   {"kind": "area", "outline": [[x, z], ...], "colour": [r, g, b]}
#   {"kind": "line", "points": [[x, z], ...], "width": m, "colour": [r, g, b],
#    "dash": [on, off] (optional, metres, starting on at the first point)}
#   {"kind": "text", "text": "6", "centre": [x, z], "height": m (along up),
#    "width": m (across), "up": [ux, uz] (the glyphs' top), "colour": [r, g, b]}:
#    filled block figures stretched to the box, in layout.lettering's font
#   {"kind": "circle", "centre": [x, z], "radius": m, "fill": true, or false
#    with "width": m for a ring, "colour": [r, g, b]}
# Colours are sRGB, 0-255. Then layout.stains darken what is painted, in
# linear light: {"outline": [[x, z], ...], "darkening": 0-1 (the paint times
# 1 - darkening), "feather": m (a soft edge that wide, half inside)}.
#
# Then layout.wear, the deck's wear as photographed (decision 17, amended
# 2026-11-03), each by rule from measured numbers, seeded so a build paints
# the same deck every time, in linear light over everything painted:
#   "mottle": [[scale m, spread], ...]: the non-skid's tone wandering, value
#     noise at each scale, the spread a share of the paint;
#   "tyres": the landing area's rubber, generated landing by landing in the
#     landing frame (s along layout.landing.line from its aft end, t across,
#     + to starboard): each touchdown scattered about the engaged wire, two
#     main-gear tracks pulled toward the centreline as the wire takes the
#     jet, a spin-up smear, the rollout to its stop and the taxi on forward;
#   "deflectors": each blast deflector panel's soot, a soft blob at a share
#     along it from its aft edge and across it from its port end;
#   "spots": fluid drips, small soft dark spots scattered over the deck and
#     the elevators outside the landing area;
#   "tiedowns": the tie-down fittings, a lattice of small dark dots (rows fore
#     and aft `across` apart, a fitting every `along`, alternate rows half a
#     step on), over the deck and the elevators, none on the catapults'
#     track covers or the blast deflectors;
#   "forward": each blast deflector's scorch on the deck just forward of its
#     hinge, a soft half-ellipse against it on the track's line;
#   "taxi": tyre tracks taxiing onto each catapult from aft of its deflector,
#     curving onto the track, turning onto each elevator, and turning off
#     the landing area toward the parking and the bow's catapults.
#
# usage: python3 -I paint.py OUT.png [--facts PATH]
import json, math, sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent
SUPERSAMPLE = 3
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"


class Canvas:
	def __init__(self, texture, scale):
		(self.x0, self.x1), (self.z0, self.z1) = texture["x"], texture["z"]
		self.width, self.height = (p * scale for p in texture["pixels"])

	def pixel(self, point):
		x, z = point
		return ((x - self.x0) / (self.x1 - self.x0) * self.width, (z - self.z0) / (self.z1 - self.z0) * self.height)

	def metres(self, length):
		# pixels per metre along x; the texture's texels are near square
		return length * self.width / (self.x1 - self.x0)


def dashes(points, on, off):
	# The pieces of a polyline a dash pattern leaves drawn
	pieces, current, drawing, left = [], [points[0]], True, on
	for a, b in zip(points, points[1:]):
		length = math.dist(a, b)
		done = 0.0
		while length - done > left:
			done += left
			f = done / length
			p = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]
			if drawing:
				pieces.append(current + [p])
			current, drawing = [p], not drawing
			left = on if drawing else off
		left -= length - done
		current.append(b)
	if drawing and len(current) > 1:
		pieces.append(current)
	return pieces


def stroke(draw, canvas, points, width, colour):
	# A polyline of a width in metres: a quad per segment, a disc at each
	# inner joint so turns don't notch
	half = canvas.metres(width) / 2
	pixels = [canvas.pixel(p) for p in points]
	for (ax, ay), (bx, by) in zip(pixels, pixels[1:]):
		length = math.hypot(bx - ax, by - ay) or 1
		nx, ny = -(by - ay) / length * half, (bx - ax) / length * half
		draw.polygon([(ax + nx, ay + ny), (bx + nx, by + ny), (bx - nx, by - ny), (ax - nx, ay - ny)], fill=colour)
	for x, y in pixels[1:-1]:
		draw.ellipse([x - half, y - half, x + half, y + half], fill=colour)


def text(image, canvas, m, font):
	# Figures filled to a box of the marking's height and width, their tops
	# turned to `up`: drawn upright, stretched, then turned (a turn of a on
	# the image, counter-clockwise as it is seen, takes the upright top
	# (0, -1) to (-sin a, -cos a), and up's x runs right, its z down)
	big = ImageFont.truetype(font, 400)
	l, t, r, b = ImageDraw.Draw(Image.new("L", (1, 1))).textbbox((0, 0), m["text"], font=big)
	glyphs = Image.new("L", (r - l, b - t))
	ImageDraw.Draw(glyphs).text((-l, -t), m["text"], font=big, fill=255)
	size = (max(1, round(canvas.metres(m["width"]))), max(1, round(canvas.metres(m["height"]))))
	ux, uz = m["up"]
	turned = glyphs.resize(size, Image.Resampling.LANCZOS).rotate(math.degrees(math.atan2(-ux, -uz)), resample=Image.Resampling.BICUBIC, expand=True)
	cx, cy = canvas.pixel(m["centre"])
	image.paste(Image.new("RGB", turned.size, tuple(m["colour"])), (round(cx - turned.width / 2), round(cy - turned.height / 2)), turned)


def circle(draw, canvas, m):
	cx, cy = canvas.pixel(m["centre"])
	r = canvas.metres(m["radius"])
	if m.get("fill", True):
		draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=tuple(m["colour"]))
	else:
		w = canvas.metres(m["width"])
		draw.ellipse([cx - r - w / 2, cy - r - w / 2, cx + r + w / 2, cy + r + w / 2], outline=tuple(m["colour"]), width=max(1, round(w)))


def linear(srgb):
	c = srgb / 255.0
	return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def encoded(lin):
	c = np.where(lin <= 0.0031308, lin * 12.92, 1.055 * np.power(np.clip(lin, 0, 1), 1 / 2.4) - 0.055)
	return np.clip(np.round(c * 255), 0, 255).astype(np.uint8)


def stained(image, canvas, stains):
	# Each stain's share at each texel (its outline, its edge blurred across
	# its feather), the paint under it darkened by that share of its
	# darkening, in linear light
	if not stains:
		return image
	darkness = np.zeros((canvas.height, canvas.width), np.float32)
	for s in stains:
		mask = Image.new("L", (canvas.width, canvas.height), 0)
		ImageDraw.Draw(mask).polygon([canvas.pixel(p) for p in s["outline"]], fill=255)
		if s.get("feather"):
			mask = mask.filter(ImageFilter.GaussianBlur(canvas.metres(s["feather"]) / 4))
		share = np.asarray(mask, np.float32) / 255
		darkness = 1 - (1 - darkness) * (1 - share * s["darkening"])
	lin = linear(np.asarray(image, np.float32)) * (1 - darkness)[:, :, None]
	return Image.fromarray(encoded(lin), "RGB")


def render(layout):
	texture = layout["deck"]["texture"]
	canvas = Canvas(texture, SUPERSAMPLE)
	image = Image.new("RGB", (canvas.width, canvas.height), tuple(layout["paint"]["deck"]))
	draw = ImageDraw.Draw(image)
	font = layout.get("lettering", {}).get("font", FONT)
	for m in layout.get("markings", []):
		colour = tuple(m["colour"])
		if m["kind"] == "area":
			draw.polygon([canvas.pixel(p) for p in m["outline"]], fill=colour)
		elif m["kind"] == "line":
			pieces = dashes(m["points"], *m["dash"]) if m.get("dash") else [m["points"]]
			for piece in pieces:
				stroke(draw, canvas, piece, m["width"], colour)
		elif m["kind"] == "text":
			text(image, canvas, m, font)
		elif m["kind"] == "circle":
			circle(draw, canvas, m)
		else:
			raise ValueError(f"marking {m.get('name')}: unknown kind {m['kind']}")
	image = image.resize(tuple(texture["pixels"]), Image.Resampling.BOX)
	# the stains soft, so painted at the texture's own size, and the wear over them
	image = stained(image, Canvas(texture, 1), layout.get("stains", []))
	return worn(image, Canvas(texture, 1), layout)


def noise(shape, cells, rng):
	# Smooth value noise of unit spread over an image `shape` (rows, columns):
	# random values on a grid of `cells` (rows, columns), interpolated up
	grid = rng.standard_normal((cells[0] + 3, cells[1] + 3)).astype(np.float32)
	big = Image.fromarray(grid, "F").resize((shape[1] + 2 * shape[1] // cells[1], shape[0] + 2 * shape[0] // cells[0]), Image.Resampling.BICUBIC)
	out = np.asarray(big, np.float32)[shape[0] // cells[0] : shape[0] // cells[0] + shape[0], shape[1] // cells[1] : shape[1] // cells[1] + shape[1]]
	return out / max(float(out.std()), 1e-6)


def frame_of(layout):
	# The landing frame: its aft end, along and across (+ to starboard) unit vectors
	(ax, az), (bx, bz) = layout["landing"]["line"]
	length = math.hypot(bx - ax, bz - az)
	along = np.array([(bx - ax) / length, (bz - az) / length])
	across = np.array([-along[1], along[0]])
	if across[1] < 0:
		across = -across
	return np.array([ax, az]), along, across


def wires_along(layout, origin, along):
	# Each wire's distance along the landing line, from its dashes' middles
	out = {}
	for w in layout["landing"].get("wires", []):
		(x0, _, z0), (x1, _, z1) = w["ends"]
		middle = np.array([(x0 + x1) / 2, (z0 + z1) / 2])
		out[w["number"]] = float((middle - origin) @ along)
	return out


def tyre_density(layout, spec, cell=0.1, parts=("smear", "rollout", "forward")):
	# The rubber's optical density (minus the log of the paint's remaining
	# share) on a grid in the landing frame: (density, s values, t values).
	# Each landing touches down about its engaged wire (picked by its share)
	# and scattered across the deck, the later the farther off the centreline
	# (`round` metres along per square metre across); its two main-gear tracks leave a spin-up
	# smear fading over its length, then roll on to the stop past the wire,
	# pulled toward the centreline as the wire centres the jet; past a gap,
	# the forward part's marks (bolters' and aircraft taxiing out) run along
	# the centreline. `parts` leaves components out, for fitting their densities
	rng = np.random.default_rng(spec.get("seed", 7))
	origin, along, _ = frame_of(layout)
	wires = wires_along(layout, origin, along)
	s_max, t_max = spec.get("reach", 220.0), spec.get("width", 12.0)
	ss = np.arange(0, s_max, cell)
	ts = np.arange(-t_max, t_max + cell / 2, cell)
	density = np.zeros((len(ts), len(ss)), np.float64)
	half = spec["gauge"] / 2
	sigma = spec["track"] / 2
	k = np.arange(-int(3 * sigma / cell) - 1, int(3 * sigma / cell) + 3)
	numbers, shares = zip(*spec["wires"].items())
	def lay(s0, s1, t_of, value_of):
		# a track from s0 to s1, at t_of(s), its density value_of(s)
		i0, i1 = max(0, int(s0 / cell)), min(len(ss), int(s1 / cell))
		if i1 <= i0:
			return
		s = ss[i0:i1]
		# spread across the cells about the track's own place, not its nearest cell's
		place = (t_of(s) + t_max) / cell
		rows = np.floor(place).astype(int)[None, :] + k[:, None]
		spread = np.exp(-0.5 * ((rows - place[None, :]) * cell / sigma) ** 2)
		spread /= spread.sum(0, keepdims=True)
		cols = np.broadcast_to(np.arange(i0, i1)[None, :], rows.shape)
		ok = (rows >= 0) & (rows < len(ts))
		np.add.at(density, (rows[ok], cols[ok]), (spread * value_of(s)[None, :])[ok])
	lateral, smear, forward = spec["lateral"], spec["smear"], spec["forward"]
	for _ in range(spec["landings"]):
		wire = wires[int(rng.choice([int(n) for n in numbers], p=np.array(shares) / sum(shares)))]
		centre = rng.normal(lateral["mean"], lateral["spread"])
		# the farther off the centreline, the later the touchdown: the band's aft
		# edge rounded, its aftmost on the centreline
		touch = wire - spec["touchdown"]["before"] + rng.normal(0, spec["touchdown"]["spread"]) \
			+ spec["touchdown"].get("round", 0.0) * (centre - lateral["mean"]) ** 2
		heading = rng.normal(0, np.radians(lateral["heading"]))
		stop = wire + rng.uniform(*spec["runout"])
		length = rng.uniform(*smear["length"])
		start, end = rng.uniform(*forward["start"]), rng.uniform(*forward["end"])
		lane = rng.normal(lateral["mean"], forward["spread"])
		# each landing's own weight of rubber, a few heavy ones standing out as streaks
		weight = rng.lognormal(-0.5 * spec.get("variation", 0.0) ** 2, spec.get("variation", 0.0))
		for side in (-1, 1):
			def offset(s, side=side, centre=centre, heading=heading, touch=touch, wire=wire):
				# the track drifts on its heading, then the wire pulls it in to the centreline's
				drawn = np.exp(-np.clip(s - wire, 0, None) / lateral["pull"])
				return (centre + side * half + heading * (s - touch)) * drawn + (lateral["mean"] + side * half) * (1 - drawn)
			if "smear" in parts:
				# the spin-up's smear: in over its first half metre, fading over its length
				lay(touch, touch + 2 * length, offset, lambda s, touch=touch, length=length: weight * smear["density"]
					* np.clip((s - touch) / 0.5, 0, 1) * np.exp(-(s - touch) / (length / 2)))
			if "rollout" in parts:
				lay(touch, stop, offset, lambda s: np.full(len(s), weight * spec["rollout"]))
			if "forward" in parts:
				lay(start, end, lambda s, side=side, lane=lane: side * half + lane + 0 * s, lambda s: np.full(len(s), weight * forward["density"]))
	return density, ss, ts


def worn(image, canvas, layout):
	# layout.wear over the painted deck, in linear light: the tone's wandering
	# multiplied in, then each layer's optical density
	wear = layout.get("wear")
	if not wear:
		return image
	lin = linear(np.asarray(image, np.float32))
	height, width = lin.shape[:2]
	xs = (canvas.x0 + (np.arange(width) + 0.5) / width * (canvas.x1 - canvas.x0)).astype(np.float32)
	zs = (canvas.z0 + (np.arange(height) + 0.5) / height * (canvas.z1 - canvas.z0)).astype(np.float32)
	rng = np.random.default_rng(wear.get("seed", 3))
	def window(x0, x1, z0, z1):
		# the texture's rows and columns over a box of deck metres
		c0, c1 = np.searchsorted(xs, [x0, x1])
		r0, r1 = np.searchsorted(zs, [z0, z1])
		return slice(int(r0), int(r1)), slice(int(c0), int(c1))
	# the non-skid's tone wandering
	tone = np.ones((height, width), np.float32)
	for scale, spread in wear.get("mottle", []):
		cells = (max(2, int(round((canvas.z1 - canvas.z0) / scale))), max(2, int(round((canvas.x1 - canvas.x0) / scale))))
		tone *= np.exp(spread * noise((height, width), cells, rng))
	lin *= tone[:, :, None]
	density = np.zeros((height, width), np.float32)
	# the landing area's rubber, from its grid in the landing frame
	if "tyres" in wear:
		grid, ss, ts = tyre_density(layout, wear["tyres"])
		origin, along, across = frame_of(layout)
		corners = np.array([origin + along * s + across * t for s in (ss[0], ss[-1]) for t in (ts[0], ts[-1])])
		rows, cols = window(corners[:, 0].min(), corners[:, 0].max(), corners[:, 1].min(), corners[:, 1].max())
		x, z = np.meshgrid(xs[cols], zs[rows])
		s = (x - origin[0]) * along[0] + (z - origin[1]) * along[1]
		t = (x - origin[0]) * across[0] + (z - origin[1]) * across[1]
		fi, fj = (t - ts[0]) / (ts[1] - ts[0]), (s - ss[0]) / (ss[1] - ss[0])
		inside = (fi >= 0) & (fi < len(ts) - 1) & (fj >= 0) & (fj < len(ss) - 1)
		i0, j0 = np.floor(fi[inside]).astype(int), np.floor(fj[inside]).astype(int)
		a, b = fi[inside] - i0, fj[inside] - j0
		g = grid.astype(np.float32)
		part = np.zeros(x.shape, np.float32)
		part[inside] = g[i0, j0] * (1 - a) * (1 - b) + g[i0 + 1, j0] * a * (1 - b) + g[i0, j0 + 1] * (1 - a) * b + g[i0 + 1, j0 + 1] * a * b
		density[rows, cols] += part
	# each blast deflector panel's soot, on the panel only
	spec = wear.get("deflectors")
	if spec:
		for name, darkening in spec["panels"].items():
			points = np.array(next(m for m in layout["markings"] if m["name"] == name)["points"][:4], float)
			x0, x1, z0, z1 = points[:, 0].min(), points[:, 0].max(), points[:, 1].min(), points[:, 1].max()
			cx, cz = x0 + spec["along"] * (x1 - x0), z0 + spec["across"] * (z1 - z0)
			su, sw = spec["spread"]
			rows, cols = window(x0, x1, z0, z1)
			x, z = np.meshgrid(xs[cols], zs[rows])
			density[rows, cols] += -math.log(1 - darkening) * np.exp(-0.5 * (((x - cx) / su) ** 2 + ((z - cz) / sw) ** 2))
	if spec and spec.get("forward"):
		# the scorch just forward of each hinge, on the track's line
		fwd = spec["forward"]
		for c in layout.get("catapults", []):
			(h0x, h0z), (h1x, h1z) = c["deflector"]["hinge"]
			hx, hz = (h0x + h1x) / 2, (h0z + h1z) / 2
			(ax, az), (bx, bz) = c["track"]
			length = math.hypot(bx - ax, bz - az)
			dx, dz = (bx - ax) / length, (bz - az) / length
			k = (hx - ax) * dx + (hz - az) * dz
			ox, oz = ax + dx * k, az + dz * k   # the track's line abreast the hinge
			sa, sw = fwd["spread"]
			rows, cols = window(ox - 4 * max(sa, sw), ox + 4 * max(sa, sw), oz - 4 * max(sa, sw), oz + 4 * max(sa, sw))
			x, z = np.meshgrid(xs[cols], zs[rows])
			along, across = (x - ox) * dx + (z - oz) * dz, -(x - ox) * dz + (z - oz) * dx
			density[rows, cols] += -math.log(1 - fwd["darkening"]) * np.exp(-0.5 * ((along / sa) ** 2 + (across / sw) ** 2)) * (along >= 0)
	# the deck and the elevators' platforms, which its outline is notched round
	surfaces = []
	def on_deck(u, v):
		if not surfaces:
			surfaces.extend([[canvas.pixel(p) for p in layout["deck"]["outline"]]] + [[canvas.pixel(p) for p in e["outline"]] for e in layout.get("elevators", [])])
		return any(inside_polygon(u, v, q) for q in surfaces)
	# fluid drips over the deck, none in the landing area
	spots = wear.get("spots")
	if spots:
		mask = Image.new("L", (width, height), 0)
		draw = ImageDraw.Draw(mask)
		clear = [canvas.pixel(p) for p in next(m for m in layout["markings"] if m["name"] == spots["clear"])["outline"]] if spots.get("clear") else None
		kept = 0
		while kept < spots["count"]:
			u, v = canvas.pixel((rng.uniform(canvas.x0, canvas.x1), rng.uniform(canvas.z0, canvas.z1)))
			if not on_deck(u, v) or (clear and inside_polygon(u, v, clear)):
				continue
			r = canvas.metres(rng.uniform(*spots["size"])) / 2
			draw.ellipse([u - r, v - r * rng.uniform(0.6, 1.0), u + r, v + r * rng.uniform(0.6, 1.0)], fill=int(255 * rng.uniform(*spots["darkening"])))
			kept += 1
		share = np.asarray(mask.filter(ImageFilter.GaussianBlur(canvas.metres(0.1))), np.float32) / 255
		density += -np.log(np.clip(1 - share, 1e-3, 1))
	# tyre tracks taxiing onto the catapults and the elevators
	if wear.get("taxi"):
		density += taxi_density(layout, wear["taxi"], canvas, (height, width))
	# the tie-down fittings, over everything but the track covers and the deflectors
	ties = wear.get("tiedowns")
	if ties:
		mask = Image.new("L", (width, height), 0)
		draw = ImageDraw.Draw(mask)
		keep_off = Image.new("L", (width, height), 0)
		off = ImageDraw.Draw(keep_off)
		for m in layout.get("markings", []):
			if m["name"] in ties.get("clear", []) or any(m["name"].endswith(e) for e in ties.get("clear_suffixes", [])):
				if m["kind"] == "area":
					off.polygon([canvas.pixel(p) for p in m["outline"]], fill=255)
				else:
					stroke(off, canvas, m["points"], m["width"], 255)
		ox, oz = ties["origin"]
		r = canvas.metres(ties["diameter"]) / 2
		value = int(255 * ties["darkening"])
		k0, k1 = int(math.floor((canvas.z0 - oz) / ties["across"])), int(math.ceil((canvas.z1 - oz) / ties["across"]))
		for k in range(k0, k1 + 1):
			z_ = oz + k * ties["across"]
			shift = (k % 2) * ties["along"] / 2
			j0, j1 = int(math.floor((canvas.x0 - ox - shift) / ties["along"])), int(math.ceil((canvas.x1 - ox - shift) / ties["along"]))
			for j in range(j0, j1 + 1):
				u, v = canvas.pixel((ox + shift + j * ties["along"], z_))
				if 0 <= u < width and 0 <= v < height and on_deck(u, v) and keep_off.getpixel((int(u), int(v))) == 0:
					draw.ellipse([u - r, v - r, u + r, v + r], fill=value)
		share = np.asarray(mask.filter(ImageFilter.GaussianBlur(canvas.metres(0.03))), np.float32) / 255
		density += -np.log(np.clip(1 - share, 1e-3, 1))
	lin *= np.exp(-density)[:, :, None]
	return Image.fromarray(encoded(lin), "RGB")


def taxi_density(layout, spec, canvas, shape):
	# Tyre tracks taxiing on: each a quadratic curve from a start scattered
	# aft of a catapult's deflector to its battery, through a point on the
	# track's line so it arrives along the track; each elevator's from a start
	# on the deck fore or aft of it, round its inboard corner, onto its
	# platform; each turn off the landing area from where an arrested
	# aircraft stops on the landing line, ahead along it and round to where
	# it parks or the bow's catapults begin; two main-gear tracks a gauge
	# apart, as density on the texture
	rng = np.random.default_rng(spec.get("seed", 11))
	height, width = shape
	grid = np.zeros(shape, np.float64)
	half = spec["gauge"] / 2
	per_metre = width / (canvas.x1 - canvas.x0)
	def lay(p0, p1, p2, value, fade=1.0, rise=0.0):
		# fade: the share of the way along after which the track fades out,
		# where the next ones overlap it (a catapult's last metres); rise: the
		# share it fades in over, where they all start (the landing line)
		n = max(8, int(math.dist(p0, p2) * per_metre * 1.5))
		t = np.linspace(0, 1, n)[:, None]
		weight = value * np.clip((1 - t[:, 0]) / max(1 - fade, 1e-6), 0, 1) if fade < 1 else np.full(n, value)
		if rise > 0:
			weight = weight * np.clip(t[:, 0] / rise, 0, 1)
		curve = (1 - t) ** 2 * np.array(p0) + 2 * (1 - t) * t * np.array(p1) + t ** 2 * np.array(p2)
		tangent = 2 * (1 - t) * (np.array(p1) - np.array(p0)) + 2 * t * (np.array(p2) - np.array(p1))
		tangent /= np.maximum(np.linalg.norm(tangent, axis=1, keepdims=True), 1e-9)
		normal = np.stack([-tangent[:, 1], tangent[:, 0]], 1)
		for side in (-1, 1):
			q = curve + side * half * normal
			u = ((q[:, 0] - canvas.x0) / (canvas.x1 - canvas.x0) * width).astype(int)
			v = ((q[:, 1] - canvas.z0) / (canvas.z1 - canvas.z0) * height).astype(int)
			ok = (u >= 0) & (u < width) & (v >= 0) & (v < height)
			np.add.at(grid, (v[ok], u[ok]), weight[ok] / 1.5)
	cats = spec.get("catapults")
	for c in layout.get("catapults", []) if cats else []:
		(ax, az), (bx, bz) = c["track"]
		length = math.hypot(bx - ax, bz - az)
		d = np.array([(bx - ax) / length, (bz - az) / length])
		n = np.array([-d[1], d[0]])
		battery = np.array(c["battery"])
		for _ in range(cats["count"]):
			start = battery - d * rng.uniform(*cats["aft"]) + n * rng.uniform(-1, 1) * rng.uniform(*cats["offset"])
			join = battery - d * rng.uniform(*cats["join"])
			lay(start, join, battery, cats["density"] * rng.lognormal(-0.32, 0.8), cats.get("fade", 1.0))
	lifts = spec.get("elevators")
	for e in layout.get("elevators", []) if lifts else []:
		outline = np.array(e["outline"], float)
		middle = outline.mean(0)
		inboard = outline[np.argsort(np.abs(outline[:, 1]))[:2]]   # its two corners nearer the centreline
		edge_middle = inboard.mean(0)
		toward = -np.sign(middle[1]) * np.array([0.0, 1.0])   # from the platform in toward the centreline
		for _ in range(lifts["count"]):
			way = rng.choice([-1, 1])
			start = edge_middle + np.array([way * rng.uniform(*lifts["along"]), 0.0]) + toward * rng.uniform(*lifts["inboard"])
			corner = edge_middle + toward * rng.uniform(1.0, 4.0)
			end = middle + rng.uniform(-3, 3, 2)
			lay(start, corner, end, lifts["density"] * rng.lognormal(-0.32, 0.8))
	turns = spec.get("turns")
	if turns and layout.get("landing", {}).get("line"):
		(ax, az), (fx, fz) = layout["landing"]["line"]
		length = math.hypot(fx - ax, fz - az)
		d = np.array([(fx - ax) / length, (fz - az) / length])
		n = np.array([-d[1], d[0]])
		for _ in range(turns["count"]):
			start = np.array([ax, az]) + d * rng.uniform(*turns["along"]) + n * rng.normal(0, turns["lateral"])
			ahead = start + d * rng.uniform(*turns["ahead"])
			(x0, z0), (x1, z1) = turns["ends"][rng.integers(len(turns["ends"]))]
			end = np.array([rng.uniform(x0, x1), rng.uniform(z0, z1)])
			lay(start, ahead, end, turns["density"] * rng.lognormal(-0.32, 0.8), rise=turns.get("rise", 0.0))
	# each track the tyres' width across
	sigma = max(1, int(round(spec.get("track", 0.3) / 2 * per_metre)))
	k = np.exp(-0.5 * (np.arange(-3 * sigma, 3 * sigma + 1) / sigma) ** 2)
	k /= k.sum()
	rows = np.nonzero(grid.any(1))[0]
	cols = np.nonzero(grid.any(0))[0]
	if not len(rows):
		return grid.astype(np.float32)
	r0, r1, c0, c1 = max(0, rows[0] - 4 * sigma), min(height, rows[-1] + 4 * sigma + 1), max(0, cols[0] - 4 * sigma), min(width, cols[-1] + 4 * sigma + 1)
	part = grid[r0:r1, c0:c1]
	part = np.apply_along_axis(lambda a: np.convolve(a, k, mode="same"), 0, part)
	part = np.apply_along_axis(lambda a: np.convolve(a, k, mode="same"), 1, part)
	grid[r0:r1, c0:c1] = part
	return grid.astype(np.float32)


def inside_polygon(u, v, polygon):
	# Whether (u, v) lies inside a polygon, by crossings
	inside = False
	for (x0, y0), (x1, y1) in zip(polygon, polygon[1:] + polygon[:1]):
		if (y0 > v) != (y1 > v) and u < x0 + (v - y0) * (x1 - x0) / (y1 - y0):
			inside = not inside
	return inside


def main():
	args = sys.argv[1:]
	facts = HERE / "facts.json"
	if "--facts" in args:
		i = args.index("--facts")
		facts = Path(args[i + 1])
		del args[i : i + 2]
	render(json.loads(facts.read_text())["layout"]).save(args[0], optimize=True)


if __name__ == "__main__":
	main()
