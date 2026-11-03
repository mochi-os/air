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
# narrower than the font's own figures.
#
# layout.lettering: {"pixels": [w, h], "font": path to a TrueType font, "background": [r, g, b],
#   "cells": {name: {"text": str, "box": [l, t, r, b], "background": [r, g, b] (optional)}},
#   "colour": [r, g, b], "outline": [r, g, b]}
#
# usage: python3 -I letters.py OUT.png [--facts PATH]
import json, sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent


def draw(spec):
	image = Image.new("RGB", tuple(spec["pixels"]), tuple(spec["background"]))
	pen = ImageDraw.Draw(image)
	for cell in spec["cells"].values():
		left, top, right, bottom = cell["box"]
		width, height = right - left, bottom - top
		# set large, cut to its own outline, then stretched over the cell
		font = ImageFont.truetype(spec["font"], 400)
		stroke = 6
		l, t, r, b = pen.textbbox((0, 0), cell["text"], font=font, stroke_width=stroke)
		background = tuple(cell.get("background", spec["background"]))
		text = Image.new("RGB", (r - l, b - t), background)
		ImageDraw.Draw(text).text((-l, -t), cell["text"], font=font, fill=tuple(spec["colour"]), stroke_width=stroke,
			stroke_fill=tuple(spec["outline"]))
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
