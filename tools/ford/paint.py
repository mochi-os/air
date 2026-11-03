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
	# the stains soft, so painted at the texture's own size
	return stained(image, Canvas(texture, 1), layout.get("stains", []))


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
