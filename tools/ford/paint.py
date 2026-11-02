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
# Colours are sRGB, 0-255.
#
# usage: python3 -I paint.py OUT.png [--facts PATH]
import json, math, sys
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
SUPERSAMPLE = 3


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


def render(layout):
	texture = layout["deck"]["texture"]
	canvas = Canvas(texture, SUPERSAMPLE)
	image = Image.new("RGB", (canvas.width, canvas.height), tuple(layout["paint"]["deck"]))
	draw = ImageDraw.Draw(image)
	for m in layout.get("markings", []):
		colour = tuple(m["colour"])
		if m["kind"] == "area":
			draw.polygon([canvas.pixel(p) for p in m["outline"]], fill=colour)
		elif m["kind"] == "line":
			pieces = dashes(m["points"], *m["dash"]) if m.get("dash") else [m["points"]]
			for piece in pieces:
				stroke(draw, canvas, piece, m["width"], colour)
		else:
			raise ValueError(f"marking {m.get('name')}: unknown kind {m['kind']}")
	return image.resize(tuple(texture["pixels"]), Image.Resampling.BOX)


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
