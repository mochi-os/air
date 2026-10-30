# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# A photo crop with a labelled pixel grid in full-resolution coordinates, for
# reading marks by eye (README.md, step 4): coarse first to find a feature,
# then a few hundred pixels at a step of 10-25 to read it, then again with the
# candidate drawn on (x,y:label) to check it before recording it.
#
# usage: python3 -I crop.py PHOTO x0 y0 x1 y1 STEP OUT.jpg [WIDTH] [x,y:label ...]
import sys

from PIL import Image, ImageDraw

Image.MAX_IMAGE_PIXELS = None
LARGEST = 4000   # pixels on the output's longer side: more is a mistake (a swapped corner), and can take tens of GB


def size(x0, y0, x1, y1, width, photo):
	# The crop held inside the photo (a box past its edge is padded, and 0 0
	# 99999 99999 asks for ten billion pixels), and its output size drawn
	# `width` pixels wide; or an error
	x0, y0, x1, y1 = max(x0, 0), max(y0, 0), min(x1, photo[0]), min(y1, photo[1])
	if x1 <= x0 or y1 <= y0:
		raise ValueError(f"the crop needs x0 < x1 and y0 < y1 inside the {photo[0]} x {photo[1]} photo, got {x0} {y0} {x1} {y1}")
	height = round((y1 - y0) * width / (x1 - x0))
	if max(width, height) > LARGEST:
		raise ValueError(f"the crop would be {width} x {height} pixels; keep it within {LARGEST} (check the corners and WIDTH)")
	return (x0, y0, x1, y1), (width, max(1, height))


def main():
	photo, x0, y0, x1, y1, step, out = sys.argv[1], *map(int, sys.argv[2:7]), sys.argv[7]
	rest = sys.argv[8:]
	width = int(rest.pop(0)) if rest and ":" not in rest[0] else 1400
	image = Image.open(photo)
	try:
		(x0, y0, x1, y1), shape = size(x0, y0, x1, y1, width, image.size)
	except ValueError as e:
		sys.exit(f"crop.py: {e}")
	image = image.convert("RGB").crop((x0, y0, x1, y1))
	k = width / (x1 - x0)
	image = image.resize(shape, Image.LANCZOS)
	pen = ImageDraw.Draw(image)
	for x in range((x0 // step + 1) * step, x1, step):
		X = (x - x0) * k
		pen.line([X, 0, X, image.height], fill=(255, 0, 255) if x % (step * 5) == 0 else (0, 255, 255), width=1)
		pen.text((X + 2, 2), str(x), fill=(255, 255, 0))
	for y in range((y0 // step + 1) * step, y1, step):
		Y = (y - y0) * k
		pen.line([0, Y, image.width, Y], fill=(255, 0, 255) if y % (step * 5) == 0 else (0, 255, 255), width=1)
		pen.text((2, Y + 2), str(y), fill=(255, 255, 0))
	for mark in rest:
		xy, label = mark.split(":", 1)
		x, y = map(float, xy.split(","))
		X, Y = (x - x0) * k, (y - y0) * k
		pen.ellipse([X - 6, Y - 6, X + 6, Y + 6], outline=(255, 60, 0), width=2)
		pen.text((X + 8, Y - 8), label, fill=(255, 60, 0))
	image.save(out, quality=90)


if __name__ == "__main__":
	main()
