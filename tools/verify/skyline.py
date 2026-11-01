# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# The outline against the sky, all of it: for every solved photo, the posed
# model's silhouette through the photo's camera (photos.py --cameras), and
# along its whole edge, wherever the photo shows sky beyond it, the jet's own
# edge in the photo, found where the sky's brightness gives way. Each place
# found is a miss in the project's units at the outline's depth (+ where the
# model stands outside the photo's edge, as photos.py signs it), on the part
# and the stretch of skin that makes the silhouette there. No tracing: every
# photo measures every outline it shows against the sky.
#
# It reports each photo's share of its outline judged and its misses, then
# each region of the skin (part, 24 in of stations, and for the body the
# sector round the section) with the photos that judge it: a region two or
# more photos agree misses is a finding, and a region no photo judges is
# unmeasured (README.md, Pitfalls). It writes each photo's overlay (the
# model's edge in red, a line from it to each place found on the photo's,
# coloured by the miss), a sheet per finding of every photo's view of it,
# skyline.json (every place) and summary.json (the report as data, for
# page.py).
#
# The model carries no stores, so the catalogue's "stores" gives each kind's
# boxes and the load every photo is assumed to carry ("load", station:
# kind), which a photo's own "stores" overrides (null for an empty
# station): no place whose search crosses a store is judged.
#
# usage: python3 -I skyline.py CATALOGUE.json MODEL.glb POINTS.json CAMERAS.json OUT_DIR [--only ID,ID]
import json, sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

sys.path.insert(0, str(Path(__file__).resolve().parent))   # run with -I, which leaves the script's own folder off the path
import camera as cam  # noqa: E402
import model as mod  # noqa: E402
from photos import weak  # noqa: E402

Image.MAX_IMAGE_PIXELS = None
WIDTH = 3000     # pixels the longer side is worked at
REACH = 24       # pixels either side of the model's edge searched, at that width
BAND = REACH // 2   # the outermost samples, the sky the walk starts from
GREEN = 8.0      # the band's green over its red and blue, past which it is grass or trees, not sky
HORIZON = 1.5    # degrees under the model frame's horizontal before a ground photo's ray meets ground: the jet sits about 1 deg off level on its gear
REACHES = (REACH, 2 * REACH, 3 * REACH)   # tried in turn where the shorter finds no edge: a miss past the reach is no sky there
STEP = 4         # pixels between places tried along the model's edge
SKY = {"bright": 110, "even": 7.0, "contrast": 25, "depart": 8.0}   # the sky beyond: at least this bright and no rougher; the jet this far from it
SUSTAIN = 3      # samples a change in brightness must hold to be the jet, not a panel line or a halo
SHARP = 5        # samples an edge may take to rise from a quarter to three quarters of the jet's level
# The skin's families by node name; those that move stand where each photo's
# pose puts them, so a miss on them is first a question about the pose
FAMILIES = [("rudder", ("rudder_",)), ("fin", ("fin_",)), ("aileron", ("aileron_",)), ("flap", ("flap_trailing_",)), ("slat", ("flap_leading_",)),
	("wing", ("wing_",)), ("stabilator", ("stabilator_",)), ("nozzle", ("nozzle_", "burner_")), ("gear", ("gear_", "hook", "launch_bar", "ladder")),
	("canopy", ("canopy", "windscreen")), ("cockpit", ("cockpit_", "pilot"))]
MOVING = {"rudder", "aileron", "flap", "slat", "stabilator", "nozzle", "gear", "canopy"}
MINIMUM = 3      # places a photo must judge in a region to count as judging it
TOLERANCE = 1.0  # inches the median over a region's photos may miss by
AGREE = 2 / 3    # share of a region's photos that must miss on the side of that median
SOLID = ["paint", "team", "lights", "burner", "display"]   # materials whose outline is the jet's own edge
SECTORS = [(30, "top"), (75, "upper side"), (105, "side"), (150, "lower side"), (181, "bottom")]   # round the body's section, degrees from the top


def edge_along(profile):
	# The jet's edge along a brightness profile sampled outward across the
	# model's edge (index REACH at the model's edge): the offset in samples
	# (+ outward), or None where what lies beyond is not sky (too dark or too
	# rough) or no sharp change from it is found.
	#
	# The sky is a line fitted to the outer samples and carried inward, since
	# it often darkens or brightens toward the jet. Walking in from it, the
	# jet begins at the first change of brightness held for SUSTAIN samples on
	# one side of the sky, darker or brighter (a sunlit top is brighter than
	# an overcast sky, a shaded flank darker), that reaches the contrast; a
	# weaker change (the halo photo processing leaves round an edge, a faint
	# cloud) is walked past. The edge is the crossing nearest the sky of
	# half-way from the sky to the jet's own level, and it must be sharp: from
	# a quarter to three quarters of that level within SHARP samples, or it is
	# shading, not an edge, and nothing is judged
	p = np.asarray(profile, float)
	n = len(p) // 2
	x = np.arange(len(p))
	band = x[-BAND:]
	slope, base = np.polyfit(band, p[band], 1)
	sky = base + slope * x
	rough = (p[band] - sky[band]).std()
	if sky[band].mean() < SKY["bright"] or rough > SKY["even"]:
		return None
	depart = max(SKY["depart"], 4 * rough)
	off = p - sky

	def crossing(side, level, fraction, start, end):
		# the crossing nearest the sky of fraction of level, between start and end
		f = fraction * level
		for j in range(end, start - 1, -1):
			a, b = off[j] * side, off[j + 1] * side
			if a >= f > b:
				return j + (a - f) / (a - b)
		return None

	for i in range(len(p) - BAND, SUSTAIN - 1, -1):
		run = off[i - SUSTAIN + 1:i + 1]
		if not (np.all(run > depart) or np.all(run < -depart)):
			continue
		side = np.sign(run[0])
		# the jet's level over a window deep enough that a ramp shows as one,
		# ending where the brightness crosses back to the sky's other side
		start = i
		while start > max(i - SUSTAIN - 2 * SHARP, 0) and off[start - 1] * side > 0:
			start -= 1
		level = (off[start:i + 1] * side).max()
		if level < SKY["contrast"]:
			continue
		end = min(i + 2, len(p) - 2)
		half, outer, inner = (crossing(side, level, f, start, end) for f in (0.5, 0.25, 0.75))
		if half is None or outer is None or inner is None or outer - inner > SHARP:
			return None
		return float(half - n)
	return None


def rim(mask):
	# The mask's edge pixels (rows, columns), one per STEP by STEP cell, so
	# the places tried are spaced evenly along every edge whatever its slope
	edge = mod.boundary(mask)
	_, first = np.unique((edge[:, 0] // STEP) * (mask.shape[1] // STEP + 1) + edge[:, 1] // STEP, return_index=True)
	return edge[np.sort(first)]


def outward(mask):
	# Each pixel's outward normal (unit, (x, y)) from the mask's blurred edge
	soft = np.asarray(Image.fromarray((mask * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(2)), float)
	gy, gx = np.gradient(soft)
	size = np.hypot(gx, gy) + 1e-9
	return -gx / size, -gy / size


def family(name):
	for label, prefixes in FAMILIES:
		if name.startswith(prefixes):
			return label
	return "body"


def region(name, point):
	# The stretch of skin a place on the outline belongs to: (part family,
	# 24 in of stations, and for the body the sector round the section)
	station, waterline, buttline = point
	f = family(name)
	stretch = int(station // 24 * 24)
	if f != "body":
		return f, stretch, ""
	angle = np.degrees(np.arctan2(abs(buttline), waterline - 110.0))
	return f, stretch, next(label for limit, label in SECTORS if angle < limit)


def frontmost(flat, depth, size):
	# Each pixel's frontmost triangle (-1 where none): triangles already
	# projected to pixels (N, 3, 2), drawn far to near so the nearest stays.
	# Triangles with any corner behind the camera are left out
	image = Image.new("I", size, 0)
	pen = ImageDraw.Draw(image)
	keep = np.nonzero((depth > 0).all(1))[0]
	for t in keep[np.argsort(-depth[keep].mean(1))]:
		pen.polygon([tuple(q) for q in flat[t]], fill=int(t) + 1, outline=int(t) + 1)
	return np.asarray(image, np.int64) - 1


def hull(points):
	# The convex hull of 2-D points, counter-clockwise (Andrew's monotone chain)
	points = sorted(map(tuple, np.asarray(points, float)))
	if len(points) < 3:
		return points

	def turn(o, a, b):
		return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

	lower, upper = [], []
	for q in points:
		while len(lower) >= 2 and turn(lower[-2], lower[-1], q) <= 0:
			lower.pop()
		lower.append(q)
	for q in reversed(points):
		while len(upper) >= 2 and turn(upper[-2], upper[-1], q) <= 0:
			upper.pop()
		upper.append(q)
	return lower[:-1] + upper[:-1]


def blocked(stores, load, hardpoints, frame, camera, centre, work, scale):
	# Where the photo may show a store the model does not carry (a tank, a
	# missile, a pylon), as a mask at the working scale: every loaded
	# station's boxes (stores["kinds"][kind]: centre and size in the
	# project's coordinates from the mount, the mirror coordinate taken
	# outboard) projected through the camera and filled. A store's skin is
	# bright and even, so beyond the model's edge it would pass for sky
	image = Image.new("L", work, 0)
	pen = ImageDraw.Draw(image)
	mirror = frame.mirror
	signs = np.array([-1.0, 1.0])
	for station, kind in load.items():
		if kind is None or station not in hardpoints:
			continue
		mount = frame.source(np.array(hardpoints[station]["mount"], float))
		out = np.ones(3)
		if mirror is not None:
			out[mirror] = 1.0 if mount[mirror] >= 0 else -1.0
		for box in stores["kinds"][kind]:
			middle = mount + np.array(box["centre"], float) * out
			half = np.array(box["size"], float) / 2
			corners = np.array([middle + half * np.array([a, b, c]) for a in signs for b in signs for c in signs])
			flat, depth = cam.project(camera, frame.model(corners), centre)
			if (depth <= 0).any():
				continue
			pen.polygon([tuple(q) for q in hull(flat * scale)], fill=255)
	return np.asarray(image.filter(ImageFilter.MaxFilter(7))) > 0


def measure(gray, ids, names, points, depths, focal, unit, scale, blocked=None, green=None, below=None):
	# Every place along the model's edge where the photo shows sky beyond it:
	# [{pixel, edge, miss (inches), part, point}]. gray and ids (each pixel's
	# frontmost triangle, frontmost()) are at the working scale; names,
	# points (source coordinates) and depths are each triangle's, a name of
	# None for glass, which shows the sky through it and is not judged. No
	# place whose profile crosses blocked (a store, blocked()) is judged, nor
	# one whose band of sky is green (green: each pixel's green over its red
	# and blue): grass and trees, bright and even in grey, pass for sky. In a
	# photo taken on the ground, below (a mask at the working scale) is what
	# lies under the horizon: ground, never sky, however bright and even
	mask = ids >= 0
	nx, ny = outward(mask)
	out = []

	def clear(row, column, dx, dy, reach):
		# how far out from the model's edge the normal stays off the model: past
		# that it meets another of the model's parts (the hook below the body,
		# the body past a concave corner), whose own edge in the photo is not
		# this one's
		t = np.arange(2, reach + 1)
		xs, ys = np.round(column + t * dx).astype(int), np.round(row + t * dy).astype(int)
		inside = (xs >= 0) & (ys >= 0) & (xs < mask.shape[1]) & (ys < mask.shape[0])
		hit = np.zeros(len(t), bool)
		hit[inside] = mask[ys[inside], xs[inside]]
		return int(t[np.argmax(hit)]) - 2 if hit.any() else reach

	def search(row, column, dx, dy, reach):
		# the photo's edge along the normal within reach, or None
		t = np.arange(-reach, reach + 1)
		xs, ys = column + t * dx, row + t * dy
		if xs.min() < 0 or ys.min() < 0 or xs.max() > gray.shape[1] - 2 or ys.max() > gray.shape[0] - 2:
			return None
		x0, y0 = np.floor(xs).astype(int), np.floor(ys).astype(int)
		if blocked is not None and blocked[y0, x0].any():
			return None
		if green is not None and green[y0[-BAND:], x0[-BAND:]].mean() > GREEN:
			return None
		if below is not None and below[y0[-BAND:], x0[-BAND:]].any():
			return None
		fx, fy = xs - x0, ys - y0
		return edge_along(gray[y0, x0] * (1 - fx) * (1 - fy) + gray[y0, x0 + 1] * fx * (1 - fy) + gray[y0 + 1, x0] * (1 - fx) * fy + gray[y0 + 1, x0 + 1] * fx * fy)

	for row, column in rim(mask):
		j = ids[row, column]
		if names[j] is None:
			continue
		dx, dy = nx[row, column], ny[row, column]
		# where the model's edge lies more than the reach inside or outside
		# the photo's, the shorter search sees no sky beyond it, or no edge
		found = None
		room = clear(row, column, dx, dy, REACHES[-1])
		for reach in REACHES:
			if reach > room:
				# the search would cross another of the model's parts: a shorter one
				# only, with room for its band of sky
				if room >= 2 * BAND:
					found = search(row, column, dx, dy, room)
				break
			found = search(row, column, dx, dy, reach)
			if found is not None:
				break
		if found is None:
			continue
		# measured from the edge pixel's centre, half a pixel inside the silhouette's own edge
		inches = -(found - 0.5) / scale * depths[j] / focal / unit
		edge = (column + found * dx, row + found * dy)
		out.append({"pixel": [round(float(column / scale), 1), round(float(row / scale), 1)], "edge": [round(float(edge[0] / scale), 1), round(float(edge[1] / scale), 1)],
			"miss": round(float(inches), 2), "part": names[j], "point": [round(float(v), 1) for v in points[j]]})
	return out


def overlay(gray, mask, places, scale, path):
	base = np.stack([gray] * 3, -1).astype(np.uint8)
	rim = mod.boundary(mask)
	base[rim[:, 0], rim[:, 1]] = (255, 40, 40)
	image = Image.fromarray(base)
	pen = ImageDraw.Draw(image)
	# each place: a line from the model's edge to the photo's, and a dot on
	# the photo's, green within 1 in, yellow within 2.5, magenta beyond
	for p in places:
		x, y = p["pixel"][0] * scale, p["pixel"][1] * scale
		ex, ey = p["edge"][0] * scale, p["edge"][1] * scale
		m = abs(p["miss"])
		colour = (40, 220, 40) if m <= 1.0 else (240, 200, 0) if m <= 2.5 else (255, 0, 255)
		pen.line([x, y, ex, ey], fill=colour)
		pen.ellipse([ex - 1.5, ey - 1.5, ex + 1.5, ey + 1.5], fill=colour)
	image.save(path)


def horizon(camera, centre, work, scale, up):
	# What a camera on the ground sees under the horizon, as a mask at the
	# working scale: every pixel whose ray points more than HORIZON degrees
	# below the model frame's horizontal (up: the frame's upward unit vector),
	# on a coarse grid
	rows, columns = np.mgrid[0:work[1]:8, 0:work[0]:8]
	rotation = cam.rotation(camera[1:4]).T
	up = np.asarray(up, float) / np.linalg.norm(up)
	coarse = np.zeros(rows.shape, bool)
	for (i, j), r in np.ndenumerate(rows):
		x = cam.undistort(camera, [(columns[i, j] / scale, r / scale)], centre)[0]
		d = rotation @ np.array([x[0], x[1], 1.0])
		coarse[i, j] = d @ up / np.linalg.norm(d) < -np.sin(np.radians(HORIZON))
	return np.repeat(np.repeat(coarse, 8, axis=0), 8, axis=1)[:work[1], :work[0]]


def label(key):
	f, stretch, sector = key
	return f"{f} FS {stretch}-{stretch + 24}" + (f" {sector}" if sector else "")


def judge(results, weaks=()):
	# Each region the photos judge: (key, {photo: median miss}, median over
	# the photos, places), worst first. A photo judging fewer than MINIMUM
	# places in a region does not count for it; a weak camera counts nowhere
	regions = {}
	for photo, places in results.items():
		if photo in weaks:
			continue
		for p in places["places"]:
			regions.setdefault(region(p["part"], p["point"]), {}).setdefault(photo, []).append(p["miss"])
	rows = []
	for key, photos in regions.items():
		photos = {ph: v for ph, v in photos.items() if len(v) >= MINIMUM}
		if photos:
			medians = {ph: float(np.median(v)) for ph, v in photos.items()}
			rows.append((key, medians, float(np.median(list(medians.values()))), sum(len(v) for v in photos.values())))
	return sorted(rows, key=lambda r: -abs(r[2]))


def finding(medians):
	# A region misses when two or more photos judge it, the median over them
	# passes TOLERANCE, and AGREE of them miss on that side: each photo is one
	# measurement, its camera's own error included
	if len(medians) < 2:
		return False
	overall = float(np.median(list(medians.values())))
	agree = sum(1 for m in medians.values() if np.sign(m) == np.sign(overall))
	return abs(overall) > TOLERANCE and agree >= AGREE * len(medians)


def summary(results, universe=(), weaks=()):
	# The report's text: each photo, then each region judged, worst first,
	# then the findings (fixed structure apart from moving surfaces), then the
	# regions of the skin (universe) judged by one photo or none. A weak
	# camera's places are drawn but judge nothing
	lines = []
	for photo, places in results.items():
		misses = np.array([p["miss"] for p in places["places"]]) if places["places"] else np.zeros(0)
		share = len(misses) / max(places["tried"], 1)
		line = f"photo {photo}: {len(misses)} of {places['tried']} places judged ({share:.0%})"
		if len(misses):
			line += f", median miss {np.median(np.abs(misses)):.2f} in, {np.mean(np.abs(misses) > 1.5):.0%} past 1.5 in"
		lines.append(line + ("; a weak camera: judges nothing" if photo in weaks else ""))
	lines.append("")
	rows = judge(results, weaks)
	fixed, moving = [], []
	for key, medians, overall, count in rows:
		lines.append(f"region {label(key):34s} {len(medians)} photos, {count:4d} places, median {overall:+6.2f} in  ({', '.join(f'{ph} {m:+.1f}' for ph, m in sorted(medians.items()))})")
		if finding(medians):
			agree = sum(1 for m in medians.values() if np.sign(m) == np.sign(overall))
			text = f"finding: {label(key)} misses by {overall:+.1f} in (median of {len(medians)} photos, {agree} on that side)"
			(moving if key[0] in MOVING else fixed).append(text)
	lines.append("")
	lines += fixed or ["no fixed region misses"]
	if moving:
		lines.append("")
		lines.append("on moving surfaces (check each photo's pose before the shape):")
		lines += moving
	judged = {key: len(medians) for key, medians, _, _ in rows}
	one = sorted(label(k) for k, n in judged.items() if n == 1)
	none = sorted(label(k) for k in set(universe) - set(judged))
	lines.append("")
	lines.append(f"judged by one photo only ({len(one)}): " + ", ".join(one))
	lines.append(f"judged by no photo ({len(none)}): " + ", ".join(none))
	return "\n".join(lines)


def digest(results, universe=(), weaks=()):
	# What the report says, as data (summary.json, for page.py): each photo's
	# figures, each region judged, and the regions of the skin
	photos = {}
	for photo, places in results.items():
		misses = [abs(p["miss"]) for p in places["places"]]
		photos[photo] = {"tried": places["tried"], "judged": len(misses), "median": round(float(np.median(misses)), 2) if misses else None,
			"weak": photo in weaks}
	regions = [{"region": label(key), "family": key[0], "stretch": key[1], "sector": key[2], "photos": {ph: round(m, 2) for ph, m in medians.items()},
		"median": round(overall, 2), "places": count, "finding": finding(medians), "moving": key[0] in MOVING} for key, medians, overall, count in judge(results, weaks)]
	return {"photos": photos, "regions": regions, "universe": sorted([list(k) for k in universe], key=lambda k: (k[0], k[2], k[1]))}


def sheets(results, weaks, directory, side=480):
	# For each finding, the overlay round its places in every photo judging
	# it, side by side, to check by eye before it becomes a task
	directory = Path(directory)
	for key, medians, overall, _ in judge(results, weaks):
		if not finding(medians):
			continue
		tiles = []
		for photo in sorted(medians):
			r = results[photo]
			xy = np.array([q["pixel"] for q in r["places"] if region(q["part"], q["point"]) == key]) * r["scale"]
			centre = xy.mean(axis=0)
			reach = max(side / 2, float(np.abs(xy - centre).max()) + 30)
			with Image.open(directory / f"{photo}.png") as image:
				tile = image.crop(tuple(int(v) for v in (centre[0] - reach, centre[1] - reach, centre[0] + reach, centre[1] + reach))).resize((side, side))
			pen = ImageDraw.Draw(tile)
			pen.rectangle([0, 0, side, 16], fill=(0, 0, 0))
			pen.text((4, 2), f"{photo} {medians[photo]:+.1f} in", fill=(255, 255, 255))
			tiles.append(tile)
		columns = min(4, len(tiles))
		rows = (len(tiles) + columns - 1) // columns
		sheet = Image.new("RGB", (side * columns, side * rows + 20), (0, 0, 0))
		for i, tile in enumerate(tiles):
			sheet.paste(tile, (i % columns * side, 20 + i // columns * side))
		ImageDraw.Draw(sheet).text((4, 4), f"{label(key)}: {overall:+.1f} in", fill=(255, 255, 255))
		sheet.save(directory / f"finding {label(key)}.png")


def main():
	args = [a for a in sys.argv[1:] if not a.startswith("--")]
	only = sys.argv[sys.argv.index("--only") + 1].split(",") if "--only" in sys.argv else None
	if only:
		args = [a for a in args if a != ",".join(only)]
	catalogue_path, glb, points_path, cameras_path, out = args[:5]
	root = Path(catalogue_path).resolve().parent
	catalogue = json.loads(Path(catalogue_path).read_text())
	frame = mod.Frame(catalogue["frame"])
	model = mod.Model(glb)
	points_file = json.loads(Path(points_path).read_text())
	joints, hardpoints = points_file["joints"], points_file.get("points", {}).get("hardpoints", {})
	out = Path(out)
	out.mkdir(parents=True, exist_ok=True)
	spec = catalogue.get("gate")
	# every region of the skin, at rest, for the coverage
	rest = model.parts(mod.pose(joints, {}), materials=SOLID)
	universe = {region(n, q) for n, t in rest.items() for q in frame.source(t.reshape(-1, 3))[::3]}
	results, weaks = {}, set()
	for entry in json.loads(Path(cameras_path).read_text()):
		photo = entry["photo"]
		if only and photo not in only:
			continue
		camera = np.array(entry["camera"], float)
		size = entry["size"]
		if spec and "rms" in entry and weak(entry["field"], entry["rms"], spec):
			weaks.add(photo)
		centre = (size[0] / 2, size[1] / 2)
		scale = min(1.0, WIDTH / max(size))
		# glass shows the sky through it, so its outline is no brightness step:
		# it still hides what lies behind, but no place on it is judged
		posed = mod.pose(joints, entry.get("pose", {}))
		solid = model.parts(posed, materials=SOLID)
		clear = model.parts(posed, materials=["glass"])
		names = [n for n, t in solid.items() for _ in range(len(t))] + [None] * sum(len(t) for t in clear.values())
		tris = np.concatenate(list(solid.values()) + list(clear.values()))
		flat, depth = cam.project(camera, tris.reshape(-1, 3), centre)
		flat, depth = flat.reshape(-1, 3, 2), depth.reshape(-1, 3)
		work = (int(size[0] * scale), int(size[1] * scale))
		ids = frontmost(flat * scale, depth, work)
		with Image.open(root / "references" / entry["file"]) as image:
			colour = np.asarray(image.convert("RGB").resize(work), float)
		gray = colour @ np.array([0.299, 0.587, 0.114])
		green = colour[..., 1] - np.maximum(colour[..., 0], colour[..., 2])
		points = frame.source(tris.mean(axis=1))
		stores = catalogue.get("stores")
		hidden = None
		if stores:
			load = dict(stores["load"])
			load.update(catalogue["photos"][photo].get("stores", {}))
			hidden = blocked(stores, load, hardpoints, frame, camera, centre, work, scale)
		# a photo with the gear down was taken on the ground: under its horizon lies ground
		ground = horizon(camera, centre, work, scale, frame.model([0, 1, 0]) - frame.model([0, 0, 0])) if entry.get("pose", {}).get("gear", 0) >= 1 else None
		places = measure(gray, ids, names, points, depth.mean(axis=1), camera[0], frame.unit, scale, hidden, green, ground)
		mask = ids >= 0
		results[photo] = {"tried": len(rim(mask)), "places": places, "scale": scale}
		overlay(gray, mask, places, scale, out / f"{photo}.png")
		print(f"photo {photo}: {len(places)} places", file=sys.stderr)
	(out / "skyline.json").write_text(json.dumps(results) + "\n")
	print(summary(results, universe, weaks))
	(out / "summary.json").write_text(json.dumps(digest(results, universe, weaks), indent="\t") + "\n")
	sheets(results, weaks, out)


if __name__ == "__main__":
	main()
