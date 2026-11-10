# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# A missile's paint (claude/plans/air-fa18c.md #9): what each texel of its
# atlas shows, from the bakes build.py makes (the base colour, ambient
# occlusion, the texel's place on the missile and which part it is on) and the
# layout's markings (facts.json layout.<missile>.markings): the section joints
# and their screws, the stencils, placards and symbols, the access covers and
# ports, and light service wear (layout.wear): each section's own shade, a
# mottle and a fine grain in the paint, grime, handling smudges round the
# lifting points, scuffs, worn edges on the wings and fins, faded stencils. Plain numpy and Pillow, so it runs and is
# tested outside Blender.
#
# Places are in the missile's own terms: stations (inches aft of the nose),
# rolls (degrees from the top toward the missile's right) and, for markings,
# the arc round the surface from a side's middle (inches, + toward the top).
# A marking given for the left side is painted on the right too, mirrored: its
# lettering upright with the lugs up on both sides, reading aft on the left and
# forward on the right, as the photos show it.
import math

import numpy as np
from PIL import Image, ImageDraw, ImageFont

INCH = 0.0254
DENSITY = 60   # pixels per inch a marking is drawn at before it is sampled
# the parts build.py tells apart (each object's pass index)
PARTS = {"body": 1, "fin": 2, "fittings": 3, "metal": 4}


def linear(srgb):
	c = np.asarray(srgb, float) / 255
	return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def encoded(c):
	c = np.clip(c, 0, 1)
	return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def places(where, centre):
	# each texel's station, roll and distance off the axis (inches) from its
	# place in Blender's axes (metres: x forward, y port, z up)
	station = centre - where[..., 0] / INCH
	roll = np.degrees(np.arctan2(-where[..., 1], where[..., 2])) % 360
	off = np.hypot(where[..., 1], where[..., 2]) / INCH
	return station, roll, off


# value noise's own spread (its standard deviation, 0..1 values), so a layer
# of it can be given as the spread the photos measure
SPREAD = 0.185


def shade(index, seed=0.31):
	# a section's own shade, -1..1, the same each build: the golden ratio's
	# steps keep neighbours apart
	return ((index * 0.6180339887 + seed) % 1) * 2 - 1


def noise(points, scale, seed):
	# smooth value noise in 0..1 over 3D points (inches), its features about
	# `scale` inches across: hashed lattice values, trilinear and smoothstepped
	p = np.asarray(points, float) / scale
	cell = np.floor(p)
	f = p - cell
	f = f * f * (3 - 2 * f)
	cell = cell.astype(np.int64)

	def value(dx, dy, dz):
		h = (cell[..., 0] + dx) * 73856093 ^ (cell[..., 1] + dy) * 19349663 ^ (cell[..., 2] + dz) * 83492791 ^ seed * 2654435761
		h = (h ^ (h >> 13)) * 1274126177
		return ((h ^ (h >> 16)) & 0xFFFF) / 65535.0

	out = 0
	for dx in (0, 1):
		for dy in (0, 1):
			for dz in (0, 1):
				w = (f[..., 0] if dx else 1 - f[..., 0]) * (f[..., 1] if dy else 1 - f[..., 1]) * (f[..., 2] if dz else 1 - f[..., 2])
				out = out + w * value(dx, dy, dz)
	return out


def band(distance, width, size):
	# the share of a texel (`size` inches across) a line `width` wide covers,
	# its middle `distance` from the texel's: lines thinner than a texel fade
	# rather than break into dots
	half = width / 2
	low = np.maximum(distance - size / 2, -half)
	high = np.minimum(distance + size / 2, half)
	return np.clip((high - low) / np.maximum(size, 1e-9), 0, 1)


def draw(marking):
	# a marking drawn flat, upright as read, filling its box at DENSITY:
	# coverage 0..1 of its ink, and of its fill where it is a label
	(s0, s1), (a0, a1) = marking["station"], marking["arc"]
	w, h = max(2, round((s1 - s0) * DENSITY)), max(2, round((a1 - a0) * DENSITY))
	kind = marking.get("kind", "text")
	ink = Image.new("L", (w, h), 0)
	fill = Image.new("L", (w, h), 0)
	d = ImageDraw.Draw(ink)
	if kind in ("label", "box"):
		if kind == "label":
			ImageDraw.Draw(fill).rectangle((0, 0, w - 1, h - 1), fill=255)
		line = round(marking.get("line", 0.04) * DENSITY)
		if line:
			d.rectangle((0, 0, w - 1, h - 1), outline=255, width=line)
	if kind in ("disc", "port"):
		d.ellipse((0, 0, w - 1, h - 1), fill=255)
		if kind == "port":
			ring = max(1, round(0.05 * DENSITY))
			d.ellipse((ring, ring, w - 1 - ring, h - 1 - ring), fill=96)
	if kind == "centre":
		# the centre of gravity's symbol: a ring, its upper left and lower right quarters filled
		d.pieslice((0, 0, w - 1, h - 1), 180, 270, fill=255)
		d.pieslice((0, 0, w - 1, h - 1), 0, 90, fill=255)
		d.ellipse((0, 0, w - 1, h - 1), outline=255, width=max(1, round(0.04 * DENSITY)))
	lines = marking.get("text", [])
	if lines:
		# each line fills its share of the box: drawn large in Pillow's own
		# font, made bold, cropped to its ink and fitted to its place
		inset = round(marking.get("inset", 0.0) * DENSITY)
		rows = len(lines)
		pitch = (h - 2 * inset) / rows
		for i, text in enumerate(lines):
			if not text.strip():
				continue
			size = 96
			font = ImageFont.load_default(size=size)
			box = d.textbbox((0, 0), text, font=font, stroke_width=round(size * marking.get("weight", 0.06)))
			glyphs = Image.new("L", (box[2] - box[0] + 4, box[3] - box[1] + 4), 0)
			ImageDraw.Draw(glyphs).text((2 - box[0], 2 - box[1]), text, font=font, fill=255,
				stroke_width=round(size * marking.get("weight", 0.06)), stroke_fill=255)
			glyphs = glyphs.crop(glyphs.getbbox() or (0, 0, 1, 1))
			height = max(1, round(pitch * marking.get("height", 0.78)))
			width = round(glyphs.width * height / glyphs.height)
			if marking.get("stretch"):
				width = w - 2 * inset
			width = max(1, min(width, w - 2 * inset))
			glyphs = glyphs.resize((width, height), Image.LANCZOS)
			x = inset + (0 if marking.get("align", "left") == "left" else (w - 2 * inset - width) // 2)
			y = round(inset + i * pitch + (pitch - height) / 2)
			ink.paste(255, (x, y), glyphs)
	return np.asarray(ink, float) / 255, np.asarray(fill, float) / 255


def rotated(marking):
	# a marking whose lettering runs round the body (read upward): drawn
	# across its box's height, then turned a quarter so it runs up the arc
	if not marking.get("upward"):
		return draw(marking)
	(s0, s1), (a0, a1) = marking["station"], marking["arc"]
	turned = dict(marking, station=[0, a1 - a0], arc=[0, s1 - s0], upward=False)
	ink, fill = draw(turned)
	return np.rot90(ink), np.rot90(fill)


def sample(image, u, v):
	# bilinear sample of a marking's drawing at (u across, v down), 0..1;
	# outside it, nothing
	h, w = image.shape
	x, y = u * w - 0.5, v * h - 0.5
	inside = (u >= 0) & (u <= 1) & (v >= 0) & (v <= 1)
	x0, y0 = np.clip(np.floor(x).astype(int), 0, w - 1), np.clip(np.floor(y).astype(int), 0, h - 1)
	x1, y1 = np.clip(x0 + 1, 0, w - 1), np.clip(y0 + 1, 0, h - 1)
	fx, fy = np.clip(x - x0, 0, 1), np.clip(y - y0, 0, 1)
	out = (image[y0, x0] * (1 - fx) * (1 - fy) + image[y0, x1] * fx * (1 - fy) + image[y1, x0] * (1 - fx) * fy + image[y1, x1] * fx * fy)
	return np.where(inside, out, 0.0)


def sides(marking, station, roll, radius):
	# each side's (u, v) for a marking: across its box as read, and down it
	(s0, s1), (a0, a1) = marking["station"], marking["arc"]
	out = []
	for side in marking.get("sides", ("left", "right")):
		if side == "left":
			arc = np.radians(((roll - 270 + 180) % 360) - 180) * radius
			u = (station - s0) / (s1 - s0)
		else:
			arc = np.radians(((90 - roll + 180) % 360) - 180) * radius
			u = (s1 - station) / (s1 - s0)
		out.append((u, (a1 - arc) / (a1 - a0)))
	return out


def markings(layout, station, roll, radius, size):
	# the body's markings over the texels on its skin: (darkening ink 0..1,
	# its colour, a label's fill 0..1, its colour). Seams and screws are ink
	# too, darker or lighter by their kind
	n = station.shape
	ink = np.zeros(n)
	ink_colour = np.zeros(n + (3,))
	fill = np.zeros(n)
	fill_colour = np.zeros(n + (3,))
	m = layout.get("markings", {})
	black = linear(m.get("ink", [30, 30, 32]))

	def lay(cover, colour, into, tint):
		# a coat over what is there, by its coverage
		into[...] = into + cover * (1 - into)
		tint[...] = tint + (colour - tint) * cover[..., None]

	for seam in m.get("seams", []):
		lay(band(station - seam, m.get("seam", 0.035), size) * 0.75, black, ink, ink_colour)
	for row in m.get("screws", []):
		pitch = 360 / row["count"]
		turn = np.radians(((roll - row.get("phase", 0) + pitch / 2) % pitch) - pitch / 2) * radius
		d = np.hypot(station - row["station"], turn)
		r = row.get("radius", 0.11)
		lay(np.clip((r - d) / np.maximum(size, 0.02) + 0.5, 0, 1) * 0.6, black, ink, ink_colour)
	for ring in m.get("windows", []):
		pitch = 360 / ring["count"]
		turn = np.radians(((roll - ring.get("phase", 0) + pitch / 2) % pitch) - pitch / 2) * radius
		d = np.hypot(station - ring["station"], turn)
		lay(np.clip((ring["radius"] - d) / np.maximum(size, 0.02) + 0.5, 0, 1) * 0.85, linear(ring.get("colour", [20, 22, 26])), ink, ink_colour)
	for marking in m.get("stencils", []):
		drawn, filled = rotated(marking)
		colour = linear(marking.get("colour", m.get("ink", [30, 30, 32])))
		label = linear(marking.get("fill", [225, 226, 222]))
		opacity = marking.get("opacity", 0.9)
		for u, v in sides(marking, station, roll, radius):
			if filled.any():
				lay(sample(filled, u, v), label, fill, fill_colour)
			lay(sample(drawn, u, v) * opacity, colour, ink, ink_colour)
	return ink, ink_colour, fill, fill_colour


def edges(outline, station, span):
	# a fin's planform outline (station, span off the axis) from its root's
	# leading corner round to its root's trailing one: each texel's distance
	# (inches) to its leading edge and tip, the edges the air and the handling
	# wear; the root, against the body, is left out
	pts = np.asarray(outline, float)
	last = max(i for i, (_, r) in enumerate(pts) if r >= 0.95 * pts[:, 1].max())   # the tip's trailing corner
	exposed = list(zip(pts[: last], pts[1 : last + 1]))
	best = np.full(station.shape, np.inf)
	for (s0, r0), (s1, r1) in exposed:
		ds, dr = s1 - s0, r1 - r0
		t = np.clip(((station - s0) * ds + (span - r0) * dr) / max(ds * ds + dr * dr, 1e-12), 0, 1)
		best = np.minimum(best, np.hypot(station - (s0 + t * ds), span - (r0 + t * dr)))
	return best


def colour(layout, centre, albedo, occlusion, where, normal, part, size):
	# The atlas's linear colour, texel by texel. albedo: the materials' base
	# colours; occlusion: ambient occlusion 0..1; where: each texel's place
	# (Blender's axes, metres); normal: its surface's, in the same axes;
	# part: PARTS' index; size: each texel's width on the missile (inches)
	wear = layout.get("wear", {})
	station, roll, off = places(where, centre)
	inches = where / INCH
	out = albedo * (0.45 + 0.55 * occlusion[..., None])
	body = part == PARTS["body"]
	# the paint itself: each section a shade of its own (built and painted
	# apart), a mottle over half an inch to a few inches and a fine grain,
	# each as spread as the photos measure it
	seams = sorted(layout.get("markings", {}).get("seams", []))
	tone = 1 + wear.get("sections", 0.04) * shade(np.searchsorted(seams, station)) * body
	mottle = (noise(inches, 1.5, 1) - 0.5 + 0.5 * (noise(inches, 0.6, 7) - 0.5)) / (SPREAD * math.sqrt(1.25))
	grain = (noise(inches, 0.15, 8) - 0.5) / SPREAD
	out = out * (tone * (1 + wear.get("mottle", 0.03) * mottle + wear.get("grain", 0.012) * grain))[..., None]
	# grime: deeper by the section joints and round the fittings on top,
	# where hands and the launcher are
	near = np.zeros(station.shape)
	for seam in layout.get("markings", {}).get("seams", []):
		near = np.maximum(near, np.clip(1 - np.abs(station - seam) / 0.8, 0, 1))
	lugs = layout.get("lugs", [])
	top = np.clip(1 - np.abs(((roll + 180) % 360) - 180) / 50, 0, 1)
	for lug in lugs:
		near = np.maximum(near, top * np.clip(1 - np.abs(station - lug) / 4.0, 0, 1))
	grime = wear.get("seams", 0.08) * near * noise(inches, 0.6, 2)
	# handling smudges: faint darker patches round the lifting points
	# (layout.markings' LIFT HERE stencils), where the crews' hands go
	for marking in layout.get("markings", {}).get("stencils", []):
		if "LIFT HERE" not in " ".join(marking.get("text", [])):
			continue
		(s0, s1), (a0, a1) = marking["station"], marking["arc"]
		for u, v in sides(marking, station, roll, off):
			d = np.hypot((u - 0.5) * (s1 - s0), (v - 0.5) * (a1 - a0))
			patch = np.clip((noise(inches, 0.8, 6) - 0.45) / 0.2, 0, 1)
			grime = grime + wear.get("smudges", 0.06) * np.clip(1 - d / 3.0, 0, 1) * patch * body
	out = out * np.clip(1 - grime, 0.6, 1.2)[..., None]
	# the markings on the body's skin (not its ends): ink over a label's fill over the paint
	radial = np.stack([np.zeros_like(roll), -np.sin(np.radians(roll)), np.cos(np.radians(roll))], -1)
	skin = body & (np.einsum("...i,...i->...", normal, radial) > 0.5)
	if skin.any():
		ink, ink_colour, fill, fill_colour = markings(layout, station[skin], roll[skin], off[skin], size[skin])
		fade = 1 - wear.get("fade", 0.2) * noise(inches[skin], 0.4, 3)
		shaded = (0.45 + 0.55 * occlusion[skin])[..., None]
		painted = out[skin]
		painted = painted + (fill_colour * shaded - painted) * fill[..., None]
		painted = painted + (ink_colour * shaded - painted) * (ink * fade)[..., None]
		out[skin] = painted
	# scuffs: short light streaks along the body, where hands and slings
	# rub, more on its lower half
	streak = noise(inches * np.array([0.12, 1, 1]), 0.5, 4)
	lower = np.clip(0.4 + 0.6 * (np.abs(((roll + 180) % 360) - 180) / 180), 0, 1)
	scuff = np.clip((streak - 0.78) / 0.12, 0, 1) * lower * body * wear.get("scuffs", 0.06)
	out = out * (1 + scuff)[..., None]
	# the wings and fins: paint worn at their leading edges and tips, toward
	# the bare metal under it, in patches
	fins = part == PARTS["fin"]
	if fins.any():
		distance = np.full(station.shape, np.inf)
		for kind in ("canards", "wings", "fins"):
			spec = layout.get(kind)
			if spec:
				distance = np.minimum(distance, edges(spec["outline"], station, off))
		worn = np.clip(1 - distance / wear.get("edge", 0.3), 0, 1) * np.clip((noise(inches, 0.25, 5) - 0.35) / 0.3, 0, 1)
		worn = worn * fins * wear.get("edges", 0.5)
		bare = linear(wear.get("bare", [150, 152, 156])) * (0.45 + 0.55 * occlusion[..., None])
		out = out + (bare - out) * worn[..., None]
	return np.clip(out, 0, 1)
