# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# Extracts true-scale outlines of the F/A-18 from two public-domain NASA
# figures the build may trace (references.json, use "trace"):
#
# - the three-view in the HATP overview ("hatp", PDF page 30, figure 2: "F/A-18
#   geometry details. Dimensions are in feet full scale"). Each view's outline
#   is filled from outside into a silhouette mask; the side and front views are
#   scaled by their own dimension bars (56.00 ft long, 37.417 ft across), the
#   top view by its own length (main() says why).
# - the six forebody and LEX sections of TP-3111 figure 5 ("tp3111", PDF page
#   31), drawn at one unstated scale. The scale is fitted to TM-101724's heights
#   and widths at FS 107, 142 and 184 (facts.json "sections"), and the outlines
#   at FS 253, 296 and 357, with the LEX, take it.
#
# Writes references/views.json (metres per pixel, the nose apex and centreline
# pixels), references/<view>.png, and references/sections.json (each section's
# outline in inches: buttline from its centreline, height above its keel).
# Run fetch.py first. The masks serve the outline check (air-fa18c.md,
# Verification); the drawings are sketches, so they agree with the jet to a
# few centimetres, not millimetres.
#
# usage: python3 -I views.py
import json, subprocess
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
CACHE = HERE / "references"
PAGE, DPI = 30, 600
FOOT = 0.3048

# TP-3111 figure 5's row of sections on the 600 DPI page (rows only; the
# leader lines from the plan view above end inside it), left to right
SECTIONS = {"rows": (3600, 4700), "stations": (107, 142, 184, 253, 296, 357)}

# Each view's box on the 600 DPI page, found from the page's ink bands. The
# side and front boxes include their dimension bars.
BOXES = {
	"top": (2290, 3470, 3930, 4670),
	"side": (2290, 4800, 3950, 5270),
	"front": (1000, 4800, 2240, 5270),
}
BARS = {"side": 56.00 * FOOT, "front": 37.417 * FOOT}


def page(source="hatp", number=PAGE):
	png = CACHE / f"{source}-{number}.png"
	if not png.exists():
		subprocess.run(["pdftoppm", "-r", str(DPI), "-f", str(number), "-l", str(number), "-png", "-singlefile",
			str(CACHE / f"{source}.pdf"), str(png.with_suffix(""))], check=True)
	return np.array(Image.open(png).convert("L")) < 128


def bar(ink):
	# The dimension bar is the longest horizontal run of ink in the box's top
	# fifth; its ends are the arrow tips at the extension lines.
	top = ink[: ink.shape[0] // 5]
	row = int(np.argmax(top.sum(1)))
	xs = np.nonzero(top[max(row - 6, 0) : row + 7].any(0))[0]
	left, right = int(xs.min()), int(xs.max())
	# Extension lines: the long vertical runs at the bar's ends, which touch the
	# jet's extremities. Each is returned by its innermost column, so the
	# silhouette can start past it.
	def heavy(x):
		return ink[row:, x].sum() > 0.5 * (ink.shape[0] - row)

	def extension(x0, step):
		x = next((x for x in range(x0, x0 + 40 * step, step) if heavy(x)), None)
		if x is None:
			raise SystemExit("no extension line beside the dimension bar")
		while heavy(x + step):
			x += step
		return x
	return row, left, right, extension(left, 1), extension(right, -1)


def silhouette(ink, x0, x1, y0):
	# Everything the outside cannot reach through the background, inside
	# [x0, x1) below row y0
	walls = ink[y0:, x0:x1].copy()
	walls[1:] |= walls[:-1]
	walls[:, 1:] |= walls[:, :-1]
	# copy(): an image made from an array is read-only, and floodfill on it
	# silently changes nothing
	image = Image.fromarray(np.pad(np.where(walls, 0, 255).astype(np.uint8), 2, constant_values=255)).copy()
	ImageDraw.floodfill(image, (0, 0), 128)
	mask = np.array(image)[2:-2, 2:-2] != 128
	# Keep the aircraft alone: the largest blob (the bar's label and stray
	# marks are separate blobs)
	return max(blobs(mask), key=lambda blob: int(blob.sum()))


def blobs(mask):
	# Each 4-connected blob of a mask, by filling them in turn
	image = Image.fromarray(np.where(mask, 255, 0).astype(np.uint8)).copy()
	found = []
	while True:
		left = np.argwhere(np.array(image) == 255)
		if not len(left):
			return found
		y, x = left[0]
		ImageDraw.floodfill(image, (int(x), int(y)), 128)
		region = np.array(image) == 128
		found.append(region)
		image = Image.fromarray(np.where(region, 0, np.array(image)).astype(np.uint8)).copy()


def grow(mask, radius):
	# Dilate by a disc of the radius, in pixels
	out = mask.copy()
	for dy in range(-radius, radius + 1):
		for dx in range(-radius, radius + 1):
			if dx * dx + dy * dy <= radius * radius:
				out |= np.roll(np.roll(mask, dy, 0), dx, 1)
	return out


def trace(mask):
	# The outer boundary of a blob, in order (Moore neighbours, clockwise on
	# screen), as (row, column) pixels
	m = np.pad(mask, 1)
	ys, xs = np.nonzero(m)
	start = (int(ys[0]), int(xs[0]))
	around = [(0, -1), (-1, -1), (-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1)]
	point, back, path = start, 0, [start]
	while True:
		for k in range(1, 9):
			d = (back + k) % 8
			q = (point[0] + around[d][0], point[1] + around[d][1])
			if m[q]:
				previous = (point[0] + around[(d - 1) % 8][0], point[1] + around[(d - 1) % 8][1])
				back = around.index((previous[0] - q[0], previous[1] - q[1]))
				point = q
				break
		if point == start:
			return [(y - 1, x - 1) for y, x in path]
		path.append(point)


def simplify(points, tolerance):
	# Ramer-Douglas-Peucker on a closed outline, kept as an open run from its
	# first point round to its last
	keep = [0, len(points) - 1]
	stack = [(0, len(points) - 1)]
	a = np.array(points, float)
	while stack:
		i, j = stack.pop()
		if j <= i + 1:
			continue
		segment = a[j] - a[i]
		length = np.hypot(*segment) or 1.0
		relative = a[i + 1 : j] - a[i]
		offsets = np.abs(segment[0] * relative[:, 1] - segment[1] * relative[:, 0]) / length
		k = int(np.argmax(offsets))
		if offsets[k] > tolerance:
			keep.append(i + 1 + k)
			stack += [(i, i + 1 + k), (i + 1 + k, j)]
	return [points[i] for i in sorted(set(keep))]


def sections():
	ink = page("tp3111", 31)
	top, bottom = SECTIONS["rows"]
	walls = ink[top:bottom]
	image = Image.fromarray(np.pad(np.where(walls, 0, 255).astype(np.uint8), 2, constant_values=255)).copy()
	ImageDraw.floodfill(image, (0, 0), 128)
	inside = (np.array(image)[2:-2, 2:-2] == 255)
	found = sorted((b for b in blobs(inside) if b.sum() > 20000), key=lambda b: np.nonzero(b.any(0))[0].min())
	stations = SECTIONS["stations"]
	if len(found) != len(stations):
		raise SystemExit(f"tp3111 figure 5: {len(found)} sections found, {len(stations)} expected")
	# The outline runs down the middle of the drawn line: the interior grown by
	# half the line's width, measured where the FS 107 circle's line crosses
	# its own centre column
	first = found[0]
	column = int(np.nonzero(first.any(0))[0].mean())
	lowest = int(np.nonzero(first[:, column])[0].max())
	half = int(round(np.nonzero(walls[lowest + 1 : lowest + 40, column])[0].size / 2))
	shapes = [grow(b, half) for b in found]

	def extent(shape):
		ys, xs = np.nonzero(shape)
		return ys.max() - ys.min() + 1, xs.max() - xs.min() + 1

	known = json.loads((HERE / "facts.json").read_text())["sections"]
	truth = {row["station"]: (row["height"], row["width"]) for row in known}
	pairs = [(px, truth[station][i]) for station, shape in zip(stations, shapes) if station in truth
		for i, px in enumerate(extent(shape))]
	scale = sum(px * value for px, value in pairs) / sum(px * px for px, _ in pairs)
	out = {"source": "tp3111", "page": 31, "dpi": DPI, "scale": scale, "unit": "in", "about":
		"Each outline runs clockwise as drawn: x is the buttline from the section's centreline (positive to the drawing's right; "
		"the sections are symmetric), y the height above the section's keel. Placing a section's keel on the jet is the build's: "
		"the side silhouette gives it. check pairs each fitted height and width with TM-101724's.", "check": {}, "sections": {}}
	for station, shape in zip(stations, shapes):
		ys, xs = np.nonzero(shape)
		centre, keel = (xs.min() + xs.max()) / 2, ys.max()
		outline = simplify(trace(shape), 0.6)
		height, width = extent(shape)
		out["sections"][str(station)] = {"height": height * scale, "width": width * scale,
			"outline": [[round((x - centre) * scale, 2), round((keel - y) * scale, 2)] for y, x in outline]}
		if station in truth:
			out["check"][str(station)] = {"height": [round(height * scale, 2), truth[station][0]],
				"width": [round(width * scale, 2), truth[station][1]]}
		print(f"FS {station}: {height * scale:.2f} high, {width * scale:.2f} wide, {len(outline)} points"
			+ (f" (TM-101724: {truth[station][0]} by {truth[station][1]})" if station in truth else ""))
	(CACHE / "sections.json").write_text(json.dumps(out, indent="\t") + "\n")


def main():
	sections()
	ink = page()
	views = {}
	for name, (x0, y0, x1, y1) in BOXES.items():
		box = ink[y0:y1, x0:x1]
		if name in BARS:
			row, left, right, inner, outer = bar(box)
			scale = BARS[name] / (right - left)
			mask = silhouette(box, inner + 1, outer, row + 12)
			offset = (x0 + inner + 1, y0 + row + 12)
		else:
			mask = silhouette(box, 0, box.shape[1], 0)
			offset = (x0, y0)
			scale = None
		views[name] = {"mask": mask, "scale": scale, "offset": offset}
	# The top view has no bar, and the figure draws it about 1.5% smaller than
	# the side view: scaled by its own nose-to-nozzle length (56.00 ft, as the
	# side view's bar), its missile-to-missile span is NATOPS's 40 ft 5 in
	top = views["top"]["mask"]
	xs = np.nonzero(top.any(0))[0]
	views["top"]["scale"] = float(BARS["side"] / (xs.max() - xs.min()))

	out = {"source": "hatp", "page": PAGE, "dpi": DPI, "views": {}}
	for name, view in views.items():
		mask = view["mask"]
		ys, xs = np.nonzero(mask)
		info = {"scale": view["scale"], "offset": view["offset"], "size": [int(mask.shape[1]), int(mask.shape[0])]}
		if name in ("top", "side"):
			info["apex"] = int(xs.min())
			info["length"] = (int(xs.max()) - int(xs.min())) * view["scale"]
		if name == "top":
			info["centre"] = float((ys.min() + ys.max()) / 2)
			info["span"] = (int(ys.max()) - int(ys.min())) * view["scale"]
		if name == "front":
			info["centre"] = float((xs.min() + xs.max()) / 2)
			info["span"] = (int(xs.max()) - int(xs.min())) * view["scale"]
			info["height"] = (int(ys.max()) - int(ys.min())) * view["scale"]
		if name == "side":
			info["height"] = (int(ys.max()) - int(ys.min())) * view["scale"]
		Image.fromarray((mask * 255).astype(np.uint8)).save(CACHE / f"{name}.png")
		out["views"][name] = info
		print(name, {k: (round(v, 3) if isinstance(v, float) else v) for k, v in info.items()})
	(CACHE / "views.json").write_text(json.dumps(out, indent="\t") + "\n")
	profiles(ink, views, out["views"])


def profiles(ink, views, info):
	# The side view's top and keel lines and the top view's half-width at
	# every inch of station, registered on the nose apex (FS 60.5 on WL 100,
	# facts.json nose.apex and datum.apex) and the centreline. The masks run to
	# the drawn line's outer edge; each value is moved in by half its width,
	# to the line's middle.
	apex = 60.5
	out = {"source": "hatp", "unit": "in", "about": "WL of the side view's top and keel lines, and the top view's half-width, "
		"at each station; null where the view has nothing", "line": {}}

	def width(view, transpose):
		# The drawn line's width: the median ink run at the mask's edge
		mask = views[view]["mask"]
		x0, y0 = views[view]["offset"]
		page_ink = ink[y0 : y0 + mask.shape[0], x0 : x0 + mask.shape[1]]
		if transpose:
			mask, page_ink = mask.T, page_ink.T
		runs = []
		for column in range(0, mask.shape[1], 7):
			rows = np.nonzero(mask[:, column])[0]
			if len(rows):
				run = 0
				while rows[0] + run < mask.shape[0] and page_ink[rows[0] + run, column]:
					run += 1
				runs.append(run)
		return float(np.median(runs))

	for view, transpose in (("side", False), ("top", False)):
		v = info[view]
		mask = views[view]["mask"]
		per = v["scale"] / 0.0254
		half = width(view, transpose) * per / 2
		out["line"][view] = round(2 * half, 2)
		stations = list(range(61, 733))
		if view == "side":
			apex_row = float(np.nonzero(mask[:, v["apex"]])[0].mean())
			tops, keels = [], []
			for station in stations:
				column = int(round(v["apex"] + (station - apex) / per))
				rows = np.nonzero(mask[:, column])[0] if 0 <= column < mask.shape[1] else []
				tops.append(round(100 + (apex_row - rows.min()) * per - half, 2) if len(rows) else None)
				keels.append(round(100 + (apex_row - rows.max()) * per + half, 2) if len(rows) else None)
			out["side"] = {"stations": stations, "top": tops, "keel": keels}
		else:
			halves = []
			for station in stations:
				column = int(round(v["apex"] + (station - apex) / per))
				rows = np.nonzero(mask[:, column])[0] if 0 <= column < mask.shape[1] else []
				halves.append(round((rows.max() - rows.min()) / 2 * per - half, 2) if len(rows) else None)
			out["top"] = {"stations": stations, "half": halves}
	(CACHE / "profiles.json").write_text(json.dumps(out) + "\n")
	print("profiles: line widths", out["line"])


if __name__ == "__main__":
	main()
