# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# Draws the lettering texture (decision 17) from facts.json's layout.lettering:
# each cell of the atlas a piece of text in white with a dark outline, on the
# grey of the face it is painted on (or the cell's own background, as the
# boot's black under the draught marks), so a plate laid on that face needs no
# transparency. Cells are given in pixels, [left, top, right, bottom]; the text
# is stretched to fill its cell, as the measured lettering is taller and
# narrower than the font's own figures. With "cutout", the atlas carries an
# alpha, clear but for the text and its outline, so the plate shows the
# weathered face behind it (decision 17, amended 2026-11-03).
#
# A cell may instead be drawn from shapes, in its own frame of `size` metres
# (x to the viewer's right, y down from its top), as the painted signs are:
# polygons with holes, each with a drop shadow where it has an `offset`;
# discs; text stretched over a box; runs of text in several colours; and a
# grime darkening its paint toward its foot.
#
# layout.lettering: {"pixels": [w, h], "font": path to a TrueType font, "background": [r, g, b],
#   "cells": {name: {"text": str, "box": [l, t, r, b], "background": [r, g, b] (optional)}
#     or {"box", "size": [w, h], "shapes": [{"polygon": [[x, y], ...], "holes": [[[x, y], ...]], "fill": [r, g, b],
#       "offset": [dx, dy], "shadow": [r, g, b]} | {"disc": [x, y, radius], "fill"} | {"ring": [x, y, outer, inner], "fill"}
#       | {"text", "box": [l, t, r, b], "fill"}
#       | {"runs": [[text, [r, g, b]], ...], "box", "gap": share of a letter}], "grime": [from, to, amount]}},
#   "colour": [r, g, b], "outline": [r, g, b], "cutout": bool (optional)}
#
# usage: python3 -I letters.py OUT.png [--facts PATH]
import json, sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent


SCALE = 4   # drawn this much finer, then reduced, for smooth edges


def mask(size, scale, polygons, holes=()):
	# An L mask of `size` pixels: the polygons filled, their holes cleared
	image = Image.new("L", size, 0)
	pen = ImageDraw.Draw(image)
	for polygon in polygons:
		pen.polygon([(x * scale[0], y * scale[1]) for x, y in polygon], fill=255)
	for hole in holes:
		pen.polygon([(x * scale[0], y * scale[1]) for x, y in hole], fill=0)
	return image


def stretched(text, font_path, size):
	# An L mask of `text` set large, cut to its ink and stretched to `size`
	font = ImageFont.truetype(font_path, 400)
	l, t, r, b = ImageDraw.Draw(Image.new("L", (1, 1))).textbbox((0, 0), text, font=font)
	ink = Image.new("L", (r - l, b - t), 0)
	ImageDraw.Draw(ink).text((-l, -t), text, font=font, fill=255)
	return ink.resize(size, Image.LANCZOS)


def shaped(cell, spec, cutout):
	# A cell drawn from its shapes, at its box's pixels
	left, top, right, bottom = cell["box"]
	width, height = (right - left) * SCALE, (bottom - top) * SCALE
	scale = (width / cell["size"][0], height / cell["size"][1])
	ground = tuple(cell.get("background", spec["background"]))
	paint = Image.new("RGB", (width, height), ground)
	alpha = Image.new("L", (width, height), 0)
	def lay(colour, where):
		paint.paste(tuple(colour), (0, 0), where)
		alpha.paste(255, (0, 0), where)
	box = lambda b: (int(b[0] * scale[0]), int(b[1] * scale[1]), int(b[2] * scale[0]), int(b[3] * scale[1]))
	for shape in cell["shapes"]:
		if "polygon" in shape:
			holes = shape.get("holes", [])
			if "offset" in shape:
				dx, dy = shape["offset"]
				moved = lambda q: [[x + dx, y + dy] for x, y in q]
				lay(shape.get("shadow", spec["outline"]), mask((width, height), scale, [moved(shape["polygon"])], [moved(h) for h in holes]))
			lay(shape["fill"], mask((width, height), scale, [shape["polygon"]], holes))
		elif "disc" in shape or "ring" in shape:
			# a disc, or a ring: a disc with a hole of the inner radius
			x, y, r, *hole = shape.get("disc") or shape["ring"]
			where = Image.new("L", (width, height), 0)
			pen = ImageDraw.Draw(where)
			pen.ellipse([(x - r) * scale[0], (y - r) * scale[1], (x + r) * scale[0], (y + r) * scale[1]], fill=255)
			if hole:
				pen.ellipse([(x - hole[0]) * scale[0], (y - hole[0]) * scale[1], (x + hole[0]) * scale[0], (y + hole[0]) * scale[1]], fill=0)
			lay(shape["fill"], where)
		else:
			l, t, r, b = box(shape["box"])
			runs = shape.get("runs") or [[shape["text"], shape["fill"]]]
			# each run as wide as its share of the letters, a gap between runs
			gap = shape.get("gap", 0.0)
			letters = sum(len(text) for text, _ in runs) + gap * (len(runs) - 1)
			x = l
			for text, colour in runs:
				w = int((r - l) * len(text) / letters)
				where = Image.new("L", (width, height), 0)
				where.paste(stretched(text, spec["font"], (max(w, 1), b - t)), (x, t))
				lay(colour, where)
				x += w + int((r - l) * gap / letters)
	if "grime" in cell:
		# the paint darker toward the foot, from `from` to `to` (shares of the height)
		start, end, amount = cell["grime"]
		ramp = Image.linear_gradient("L").resize((width, height))
		ramp = ramp.point(lambda v: int(255 * (1 - amount * min(max((v / 255 - start) / max(end - start, 1e-6), 0), 1))))
		paint = Image.merge("RGB", [ImageChops.multiply(c, ramp) for c in paint.split()])
	out = Image.merge("RGBA", (*paint.split(), alpha)) if cutout else paint
	return out.resize((right - left, bottom - top), Image.LANCZOS)


def draw(spec):
	cutout = spec.get("cutout", False)
	mode = "RGBA" if cutout else "RGB"
	clear = lambda colour: tuple(colour) + ((0,) if cutout else ())
	image = Image.new(mode, tuple(spec["pixels"]), clear(spec["background"]))
	pen = ImageDraw.Draw(image)
	for cell in spec["cells"].values():
		if "shapes" in cell:
			image.paste(shaped(cell, spec, cutout), tuple(cell["box"][:2]))
			continue
		left, top, right, bottom = cell["box"]
		width, height = right - left, bottom - top
		# set large, cut to its own outline, then stretched over the cell
		font = ImageFont.truetype(spec["font"], 400)
		stroke = 6
		l, t, r, b = pen.textbbox((0, 0), cell["text"], font=font, stroke_width=stroke)
		background = clear(cell.get("background", spec["background"]))
		text = Image.new(mode, (r - l, b - t), background)
		ImageDraw.Draw(text).text((-l, -t), cell["text"], font=font, fill=clear(spec["colour"])[:3] + ((255,) if cutout else ()),
			stroke_width=stroke, stroke_fill=tuple(spec["outline"]) + ((255,) if cutout else ()))
		image.paste(text.resize((width, height), Image.LANCZOS), (left, top))
	return image


def main():
	args = sys.argv[1:]
	facts = HERE / "facts.json"
	if "--facts" in args:
		i = args.index("--facts")
		facts = Path(args[i + 1])
		del args[i : i + 2]
	spec = json.loads(facts.read_text())["layout"]["lettering"]
	draw(spec).save(args[0])


if __name__ == "__main__":
	main()
