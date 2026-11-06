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
# each region of the skin (part, a stretch of stations, and for the body the
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
# station): no place whose search crosses a store is judged. Nor is one whose
# search crosses a photo's own "masks" (polygons in its pixels: whatever the
# model does not carry that differs from photo to photo, parked jets, cranes,
# people). The catalogue's "skyline" section sets the regions and what makes a
# finding (Settings), each key it leaves out keeping the F/A-18C's value.
#
# With --reach it instead finds which regions can make the outline at all,
# from directions spread round the model, flown and gear down: a region on
# no outline from any direction no photo can judge (the catalogue's
# skyline "unseen" records what measures it instead).
#
# usage: python3 -I skyline.py CATALOGUE.json MODEL.glb POINTS.json CAMERAS.json OUT_DIR [--only ID,ID]
#        python3 -I skyline.py CATALOGUE.json MODEL.glb POINTS.json OUT.json --reach [--count N]
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
BLUE = 40.0      # the band's blue over its red and green, past which it is clear sky or open sea however dark: shaded paint reaches about 20
HORIZON = 1.5    # degrees under the model frame's horizontal before a ground photo's ray meets ground: the jet sits about 1 deg off level on its gear
BEHIND = 0.75   # a part nearer than this share of a place's depth just inside it makes the place one seen past it
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
STRETCH = 24     # inches of stations a region spans
AXIS = 110.0     # the waterline the body's sectors are measured round, on the centreline
LABEL = "FS"     # the stations as a region's label names them
SECTORED = ["body"]   # the families whose regions are split into sectors round the section
SIDES = None     # names for either side of the centreline, [negative, positive], or None for a mirrored skin judged as one
# Drives that take a part between two shapes (stowed and let down, shut and open): the regions of a part
# one has moved take its word, distinct from the other words its family can carry
STANCES = {"gear": "down", "canopy": "open", "speedbrake": "open", "hook": "down", "probe": "out", "bar": "lowered", "ladder": "out", "fold": "folded"}


class Settings:
	# The regions of the skin and what makes a finding, from the catalogue's
	# "skyline" section; a key left out keeps the F/A-18C's constant above.
	# Coordinates are the frame's, in its order: along, up, across.
	#   stretch    the first coordinate's span of a region (STRETCH)
	#   axis       the second coordinate the body's sectors are measured round, on the third's zero (AXIS)
	#   sectors    [[limit, name], ...]: round the section, degrees from straight up, each up to its limit;
	#              the last past 180 (SECTORS)
	#   families   [[family, [node name prefix, ...]], ...]: a part matching none is "body" (FAMILIES)
	#   moving     the families each photo's pose moves, whose findings are listed apart (MOVING)
	#   tolerance  the median miss a finding passes; the overlays and sheets colour misses within it,
	#              within 2.5 times it, and beyond (TOLERANCE)
	#   solid      the materials whose outline is the model's own edge (SOLID)
	#   label      the first coordinate as a region's label names it (LABEL)
	#   sectored   the families split into sectors round the section (SECTORED)
	#   sides      [name below zero, name above] on the third coordinate, each region split by side; none
	#              judges a mirrored skin's two sides as one (SIDES)
	#   horizon    degrees under the horizon before a ground photo's ray meets ground (HORIZON); measured
	#              from level, or with the catalogue's "sea", from the sea's horizon at the camera's height
	#   stances    {drive: word}: the regions of a part the drive has moved from rest take the word, so a
	#              region never mixes the gear down with the gear up (STANCES)
	#   unseen     {region label: what measures it instead}: regions on no outline from any direction
	#              (--reach finds them), reported apart from the regions no photo judges
	# and the frame's symbol and plural, as the misses print
	def __init__(self, catalogue=None):
		catalogue = catalogue or {}
		spec = catalogue.get("skyline", {})
		self.stretch = spec.get("stretch", STRETCH)
		self.axis = float(spec.get("axis", AXIS))
		self.sectors = [(limit, name) for limit, name in spec.get("sectors", SECTORS)]
		self.families = [(name, tuple(prefixes)) for name, prefixes in spec.get("families", FAMILIES)]
		self.moving = set(spec.get("moving", MOVING))
		self.tolerance = float(spec.get("tolerance", TOLERANCE))
		self.solid = list(spec.get("solid", SOLID))
		self.label = spec.get("label", LABEL)
		self.sectored = list(spec.get("sectored", SECTORED))
		self.sides = spec.get("sides", SIDES)
		self.horizon = float(spec.get("horizon", HORIZON))
		self.unseen = dict(spec.get("unseen", {}))
		self.stances = dict(spec.get("stances", STANCES))
		frame = mod.Frame(catalogue["frame"]) if "frame" in catalogue else None
		self.symbol = frame.symbol if frame else mod.SYMBOL
		self.plural = frame.plural if frame else mod.PLURAL


DEFAULT = Settings()


def edge_along(profile, bright=SKY["bright"], attached=False):
	# The jet's edge along a brightness profile sampled outward across the
	# model's edge (index REACH at the model's edge): the offset in samples
	# (+ outward), or None where what lies beyond is not sky (darker than
	# bright, or too rough) or no sharp change from it is found.
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
	# shading, not an edge, and nothing is judged. Attached (a sea behind, whose
	# foam and lit waves depart from it as the subject does), the walk starts
	# where the run departing from the inner end, the model's side, first comes
	# back to the background, so only the subject's own edge is found
	p = np.asarray(profile, float)
	n = len(p) // 2
	x = np.arange(len(p))
	band = x[-BAND:]
	slope, base = np.polyfit(band, p[band], 1)
	sky = base + slope * x
	rough = (p[band] - sky[band]).std()
	if sky[band].mean() < bright or rough > SKY["even"]:
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

	first = len(p) - BAND
	if attached:
		calm = [j for j in range(len(p) - SUSTAIN + 1) if np.all(np.abs(off[j:j + SUSTAIN]) <= depart)]
		first = min(first, calm[0]) if calm else first
	for i in range(first, SUSTAIN - 1, -1):
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


def family(name, settings=None):
	for label, prefixes in (settings or DEFAULT).families:
		if name.startswith(prefixes):
			return label
	return "body"


def region(name, point, settings=None, stance=""):
	# The stretch of skin a place on the outline belongs to: (part family,
	# the settings' stretch of stations, and for the sectored families the
	# sector round the section; with sides, the side too; on a part a stance
	# drive has moved, its word (stances()))
	settings = settings or DEFAULT
	station, waterline, buttline = point
	f = family(name, settings)
	stretch = int(station // settings.stretch * settings.stretch)
	sector = ""
	if f in settings.sectored:
		angle = np.degrees(np.arctan2(abs(buttline), waterline - settings.axis))
		sector = next(label for limit, label in settings.sectors if angle < limit)
	if settings.sides:
		sector = " ".join(n for n in (sector, settings.sides[int(buttline >= 0)]) if n)
	if stance:
		sector = " ".join(n for n in (sector, stance) if n)
	return f, stretch, sector


def stances(model, joints, pose, settings=None):
	# {part: word} for the parts a stance drive (the settings' stances) moves
	# from rest in the pose: a gear leg let down, a door opened, a canopy
	# raised is another shape than the same part stowed, and a region judged
	# by both would mix them (gear-up photos read the closed doors with the
	# belly, gear-down ones the legs)
	settings = settings or DEFAULT
	out, rest = {}, None
	for drive, word in settings.stances.items():
		value = pose.get(drive, 0)
		if not value:
			continue
		if rest is None:
			rest = model.parts(mod.pose(joints, {}), materials=settings.solid)
		for name, tris in model.parts(mod.pose(joints, {drive: value}), materials=settings.solid).items():
			if name not in rest or rest[name].shape != tris.shape or not np.allclose(rest[name], tris, atol=1e-6):
				out[name] = word
	return out


def universe(model, joints, frame, settings=None):
	# Every region of the skin: at rest, and with each stance drive's parts
	# moved (stances())
	settings = settings or DEFAULT
	out = set()
	for pose in [{}] + [{drive: 1} for drive in settings.stances]:
		moved = stances(model, joints, pose, settings)
		parts = model.parts(mod.pose(joints, pose), materials=settings.solid)
		out |= {region(n, q, settings, moved.get(n, "")) for n, t in parts.items() for q in frame.source(t.reshape(-1, 3))[::3]}
	return out


def afloat(tris, sea):
	# The triangles cut at the sea's surface, the part above it kept: the sea
	# hides what lies under it, so it makes no outline. sea is (normal, offset),
	# the normal pointing out of the water. Returns (triangles, the index of
	# each one's source)
	normal, offset = sea
	d = tris @ normal - offset
	above = (d >= 0).all(axis=1)
	kept, source = [tris[above]], [np.nonzero(above)[0]]
	for i in np.nonzero(~above & (d >= 0).any(axis=1))[0]:
		polygon = []
		for k in range(3):
			a, b, da, db = tris[i, k], tris[i, (k + 1) % 3], d[i, k], d[i, (k + 1) % 3]
			if da >= 0:
				polygon.append(a)
			if (da >= 0) != (db >= 0):
				polygon.append(a + (b - a) * (da / (da - db)))
		for k in range(1, len(polygon) - 1):
			kept.append(np.array([[polygon[0], polygon[k], polygon[k + 1]]]))
			source.append(np.array([i]))
	return np.concatenate(kept), np.concatenate(source)


def waterline(tris, sea, tolerance=1e-6):
	# The model's waterline after afloat(): each edge of a kept triangle lying
	# on the sea's surface, as (N, 2, 3) end points
	normal, offset = sea
	on = np.abs(tris @ normal - offset) < tolerance
	edges = [tris[on[:, k] & on[:, (k + 1) % 3]][:, [k, (k + 1) % 3]] for k in range(3)]
	return np.concatenate(edges) if edges else np.zeros((0, 2, 3))


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


def covered(polygons, work, scale):
	# What a photo's masks hide (polygons in its own pixels), as a mask at the
	# working scale
	image = Image.new("L", work, 0)
	pen = ImageDraw.Draw(image)
	for polygon in polygons:
		pen.polygon([(x * scale, y * scale) for x, y in polygon], fill=255, outline=255)
	return np.asarray(image) > 0


def measure(gray, ids, names, points, depths, focal, unit, scale, blocked=None, green=None, below=None, blue=None, water=None, seaward=None, paint=None):
	# Every place along the model's edge where the photo shows sky beyond it:
	# [{pixel, edge, miss (the frame's unit), part, point}]. gray and ids (each pixel's
	# frontmost triangle, frontmost()) are at the working scale; names,
	# points (source coordinates) and depths are each triangle's, a name of
	# None for glass, which shows the sky through it and is not judged. No
	# place whose profile crosses blocked (a store, blocked()) is judged, nor
	# one whose band of sky is green (green: each pixel's green over its red
	# and blue): grass and trees, bright and even in grey, pass for sky. In a
	# photo taken on the ground, below (a mask at the working scale) is what
	# lies under the horizon: ground, never sky, however bright and even. A
	# band that is blue (blue: each pixel's blue over its red and green) is
	# sky however dark: a deep blue sky or sea reads darker in grey than the
	# brightness that keeps shaded skin from passing for sky, which is grey.
	# Against a blue sky the edge is read where the blue ends, unless paint is
	# "blue": a jet painted as blue as the sky (the Blue Angels' navy reads
	# about 33 over its red and green against a clear sky's 43, short of the
	# contrast, so the walk passes its edge for the next gold stripe inward) is
	# read by its brightness as well, and the edge nearer the sky taken: its
	# gold trim, which brightness passes for sky, is found by its blue. A place on a part
	# seen past a nearer one just inside it is not judged, nor one on water (a
	# mask at the working scale of the model's waterline): there the outline is
	# the sea's, which each photo's draught, waves and wake move. Where the band
	# lies seaward (a mask of what lies under the sea's horizon) the edge is the
	# subject's own, found attached (edge_along)
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

	def behind(row, column, dx, dy, depth):
		# whether the place is on a part seen past a nearer one just inside it
		# (the stern beside a bow the model draws too narrow): the photo's edge
		# beyond may be either part's, and read at the far part's depth a miss of
		# the near one's would be scaled by their ratio and filed under the far
		t = np.arange(1, REACH + 1)
		xs, ys = np.round(column - t * dx).astype(int), np.round(row - t * dy).astype(int)
		inside = (xs >= 0) & (ys >= 0) & (xs < ids.shape[1]) & (ys < ids.shape[0])
		k = ids[ys[inside], xs[inside]]
		k = k[k >= 0]
		return bool(len(k)) and float(depths[k].min()) < BEHIND * depth

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
		attached = seaward is not None and seaward[y0[-BAND:], x0[-BAND:]].mean() > 0.5

		def along(image):
			return image[y0, x0] * (1 - fx) * (1 - fy) + image[y0, x0 + 1] * fx * (1 - fy) + image[y0 + 1, x0] * (1 - fx) * fy + image[y0 + 1, x0 + 1] * fx * fy

		# a blue sky is judged by its blue, however dark: in grey, shaded skin
		# can match it and the walk would pass the skin's edge for the next
		# bright step inward; grey skin is never that blue
		if blue is not None and blue[y0[-BAND:], x0[-BAND:]].mean() >= BLUE:
			found = edge_along(along(blue), 0.0, attached)
			if paint == "blue":
				edges = [f for f in (found, edge_along(along(gray), attached=attached)) if f is not None]
				found = max(edges) if edges else None
			return found
		return edge_along(along(gray), attached=attached)

	for row, column in rim(mask):
		j = ids[row, column]
		if names[j] is None or (water is not None and water[row, column]):
			continue
		dx, dy = nx[row, column], ny[row, column]
		if behind(row, column, dx, dy, depths[j]):
			continue
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


class Scene:
	# One solved photo (an entry of photos.py's cameras file) at the working
	# scale, ready to measure the model in any pose against: its brightness,
	# greenness and blueness, what its stores and masks hide, and in a photo
	# taken on the ground what lies under its horizon: where the catalogue's
	# photo entry says "ground": true, never where it says false, and without
	# it where the entry's pose has the gear down. Its blue is read only where
	# the photo entry says "clear": true, the background beyond the jet clear
	# blue sky or open sea: a white cloud against the blue is no bluer than the
	# jet, and the walk would take the cloud's edge for the jet's
	def __init__(self, catalogue, root, frame, hardpoints, entry):
		self.frame = frame
		self.settings = Settings(catalogue)
		photo = catalogue["photos"][entry["photo"]]
		self.camera = np.array(entry["camera"], float)
		size = entry["size"]
		self.centre = (size[0] / 2, size[1] / 2)
		self.scale = min(1.0, WIDTH / max(size))
		self.work = (int(size[0] * self.scale), int(size[1] * self.scale))
		with Image.open(Path(root) / "references" / entry["file"]) as image:
			colour = np.asarray(image.convert("RGB").resize(self.work), float)
		self.gray = colour @ np.array([0.299, 0.587, 0.114])
		self.green = colour[..., 1] - np.maximum(colour[..., 0], colour[..., 2])
		clear = photo.get("clear", False)
		self.blue = colour[..., 2] - np.maximum(colour[..., 0], colour[..., 1]) if clear else None
		# "paint": "blue" where the jet itself is as blue as the sky (measure())
		self.paint = photo.get("paint")
		stores = catalogue.get("stores")
		self.hidden = None
		if stores:
			load = dict(stores["load"])
			load.update(photo.get("stores", {}))
			self.hidden = blocked(stores, load, hardpoints, frame, self.camera, self.centre, self.work, self.scale)
		if photo.get("masks"):
			masks = covered(photo["masks"], self.work, self.scale)
			self.hidden = masks if self.hidden is None else self.hidden | masks
		# the sea's surface, the normal out of the water (the model frame's y is up)
		self.sea = None
		if "sea" in catalogue:
			normal, offset = frame.plane(catalogue["sea"])
			self.sea = (normal, offset) if normal[1] >= 0 else (-normal, -offset)
		ground = photo.get("ground")
		if ground is None:
			ground = entry.get("pose", {}).get("gear", 0) >= 1
		self.ground = horizon(self.camera, self.centre, self.work, self.scale, frame.model([0, 1, 0]) - frame.model([0, 0, 0]),
			self.settings.horizon, self.sea) if ground else None
		# in a photo taken from the air, what lies under the sea's horizon is the
		# sea, whose foam and waves are no sky
		self.seaward = horizon(self.camera, self.centre, self.work, self.scale, None, 0.0, self.sea) if self.sea is not None and not ground else None

	def places(self, model, joints, pose, parts=None):
		# The places found along the model's outline in the pose (the points
		# file's drives, or a joint's own name for that joint's angle), and the
		# silhouette's mask. With parts, only places on those parts are sought;
		# every part still hides what lies behind it
		posed = mod.pose(joints, pose)
		# glass shows the sky through it, so its outline is no brightness step:
		# it still hides what lies behind, but no place on it is judged
		solid = model.parts(posed, materials=self.settings.solid)
		clear = model.parts(posed, materials=["glass"])
		if not solid and not clear:
			# no part in the materials asked for (a catalogue's solid naming none of
			# the model's): nothing to measure, not a crash
			return [], np.zeros((self.work[1], self.work[0]), bool)
		names = [n if parts is None or n in parts else None for n, t in solid.items() for _ in range(len(t))] + [None] * sum(len(t) for t in clear.values())
		tris = np.concatenate(list(solid.values()) + list(clear.values()))
		water = None
		if self.sea is not None:
			tris, source = afloat(tris, self.sea)
			names = [names[i] for i in source]
			if not len(tris):
				return [], np.zeros((self.work[1], self.work[0]), bool)
			# the waterline drawn 3 px wide where it lies in front of the camera,
			# so its rim pixels either side are covered
			ends = waterline(tris, self.sea)
			image = Image.new("L", self.work, 0)
			draw = ImageDraw.Draw(image)
			if len(ends):
				pixels, depths = cam.project(self.camera, ends.reshape(-1, 3), self.centre)
				pixels, depths = pixels.reshape(-1, 2, 2) * self.scale, depths.reshape(-1, 2)
				for (a, b), d in zip(pixels, depths):
					if (d > 0).all():
						draw.line([tuple(a), tuple(b)], fill=255, width=3)
			water = np.asarray(image) > 0
		flat, depth = cam.project(self.camera, tris.reshape(-1, 3), self.centre)
		flat, depth = flat.reshape(-1, 3, 2), depth.reshape(-1, 3)
		ids = frontmost(flat * self.scale, depth, self.work)
		points = self.frame.source(tris.mean(axis=1))
		places = measure(self.gray, ids, names, points, depth.mean(axis=1), self.camera[0], self.frame.unit, self.scale, self.hidden, self.green, self.ground, self.blue,
			water, self.seaward, self.paint)
		# a place on a part a stance drive has moved carries its word (stances())
		moved = stances(model, joints, pose, self.settings)
		for p in places:
			if p["part"] in moved:
				p["stance"] = moved[p["part"]]
		return places, ids >= 0


def overlay(gray, mask, places, scale, path, settings=None):
	tolerance = (settings or DEFAULT).tolerance
	base = np.stack([gray] * 3, -1).astype(np.uint8)
	rim = mod.boundary(mask)
	base[rim[:, 0], rim[:, 1]] = (255, 40, 40)
	image = Image.fromarray(base)
	pen = ImageDraw.Draw(image)
	# each place: a line from the model's edge to the photo's, and a dot on
	# the photo's, green within the tolerance, yellow within 2.5 times it,
	# magenta beyond
	for p in places:
		x, y = p["pixel"][0] * scale, p["pixel"][1] * scale
		ex, ey = p["edge"][0] * scale, p["edge"][1] * scale
		m = abs(p["miss"])
		colour = (40, 220, 40) if m <= tolerance else (240, 200, 0) if m <= 2.5 * tolerance else (255, 0, 255)
		pen.line([x, y, ex, ey], fill=colour)
		pen.ellipse([ex - 1.5, ey - 1.5, ex + 1.5, ey + 1.5], fill=colour)
	image.save(path)


def horizon(camera, centre, work, scale, up, degrees=HORIZON, sea=None):
	# What a camera on the ground sees under the horizon, as a mask at the
	# working scale: every pixel whose ray points more than `degrees` below the
	# model frame's horizontal (up: the frame's upward unit vector), or with
	# sea ((normal, offset), the normal out of the water) more than `degrees`
	# below the sea's horizon at the camera's height, on a coarse grid
	rows, columns = np.mgrid[0:work[1]:8, 0:work[0]:8]
	rotation = cam.rotation(camera[1:4]).T
	below = np.radians(degrees)
	if sea is not None:
		up = sea[0]
		below += cam.dip(float(sea[0] @ cam.eye(camera) - sea[1]))
	up = np.asarray(up, float) / np.linalg.norm(up)
	coarse = np.zeros(rows.shape, bool)
	for (i, j), r in np.ndenumerate(rows):
		x = cam.undistort(camera, [(columns[i, j] / scale, r / scale)], centre)[0]
		d = rotation @ np.array([x[0], x[1], 1.0])
		coarse[i, j] = d @ up / np.linalg.norm(d) < -np.sin(below)
	return np.repeat(np.repeat(coarse, 8, axis=0), 8, axis=1)[:work[1], :work[0]]


def label(key, settings=None):
	settings = settings or DEFAULT
	f, stretch, sector = key
	return f"{f} {settings.label} {stretch}-{stretch + settings.stretch}" + (f" {sector}" if sector else "")


def judge(results, weaks=(), settings=None):
	# Each region the photos judge: (key, {photo: median miss}, median over
	# the photos, places), worst first. A photo judging fewer than MINIMUM
	# places in a region does not count for it; a weak camera counts nowhere
	regions = {}
	for photo, places in results.items():
		if photo in weaks:
			continue
		for p in places["places"]:
			regions.setdefault(region(p["part"], p["point"], settings, p.get("stance", "")), {}).setdefault(photo, []).append(p["miss"])
	rows = []
	for key, photos in regions.items():
		photos = {ph: v for ph, v in photos.items() if len(v) >= MINIMUM}
		if photos:
			medians = {ph: float(np.median(v)) for ph, v in photos.items()}
			rows.append((key, medians, float(np.median(list(medians.values()))), sum(len(v) for v in photos.values())))
	return sorted(rows, key=lambda r: -abs(r[2]))


def finding(medians, settings=None):
	# A region misses when two or more photos judge it, the median over them
	# passes the settings' tolerance, and AGREE of them miss on that side: each
	# photo is one measurement, its camera's own error included
	if len(medians) < 2:
		return False
	overall = float(np.median(list(medians.values())))
	agree = sum(1 for m in medians.values() if np.sign(m) == np.sign(overall))
	return abs(overall) > (settings or DEFAULT).tolerance and agree >= AGREE * len(medians)


def summary(results, universe=(), weaks=(), settings=None):
	# The report's text: each photo, then each region judged, worst first,
	# then the findings (fixed structure apart from moving surfaces), then the
	# regions of the skin (universe) judged by one photo or none. A weak
	# camera's places are drawn but judge nothing
	settings = settings or DEFAULT
	symbol, past = settings.symbol, 1.5 * settings.tolerance
	lines = []
	for photo, places in results.items():
		misses = np.array([p["miss"] for p in places["places"]]) if places["places"] else np.zeros(0)
		share = len(misses) / max(places["tried"], 1)
		line = f"photo {photo}: {len(misses)} of {places['tried']} places judged ({share:.0%})"
		if len(misses):
			line += f", median miss {np.median(np.abs(misses)):.2f} {symbol}, {np.mean(np.abs(misses) > past):.0%} past {past:g} {symbol}"
		lines.append(line + ("; a weak camera: judges nothing" if photo in weaks else ""))
	lines.append("")
	rows = judge(results, weaks, settings)
	fixed, moving = [], []
	for key, medians, overall, count in rows:
		lines.append(f"region {label(key, settings):34s} {len(medians)} photos, {count:4d} places, median {overall:+6.2f} {symbol}  ({', '.join(f'{ph} {m:+.1f}' for ph, m in sorted(medians.items()))})")
		if finding(medians, settings):
			agree = sum(1 for m in medians.values() if np.sign(m) == np.sign(overall))
			text = f"finding: {label(key, settings)} misses by {overall:+.1f} {symbol} (median of {len(medians)} photos, {agree} on that side)"
			(moving if key[0] in settings.moving else fixed).append(text)
	lines.append("")
	lines += fixed or ["no fixed region misses"]
	if moving:
		lines.append("")
		lines.append("on moving surfaces (check each photo's pose before the shape):")
		lines += moving
	judged = {key: len(medians) for key, medians, _, _ in rows}
	unseen = settings.unseen
	one = sorted(label(k, settings) for k, n in judged.items() if n == 1 and label(k, settings) not in unseen)
	none = sorted(label(k, settings) for k in set(universe) - set(judged) if label(k, settings) not in unseen)
	lines.append("")
	lines.append(f"judged by one photo only ({len(one)}): " + ", ".join(one))
	lines.append(f"judged by no photo ({len(none)}): " + ", ".join(none))
	if unseen:
		# on no outline from any direction (reach()), so no photo can judge them:
		# what measures each instead; one a photo judges after all is listed again
		labels = {label(k, settings) for k in universe}
		listed = sorted(u for u in unseen if u in labels)
		lines.append(f"on no outline, measured otherwise ({len(listed)}): " + "; ".join(f"{u} ({unseen[u]})" for u in listed))
		judging = sorted(u for u in listed if any(label(k, settings) == u for k in judged))
		if judging:
			lines.append(f"listed as on no outline but judged by a photo ({len(judging)}): " + ", ".join(judging))
		gone = sorted(u for u in unseen if u not in labels)
		if gone:
			lines.append(f"listed as on no outline but no longer on the skin ({len(gone)}): " + ", ".join(gone))
	return "\n".join(lines)


def directions(count):
	# count unit directions spread evenly round a sphere (a Fibonacci
	# lattice), in the model frame (x ahead, y up)
	k = np.arange(count) + 0.5
	up = 1 - 2 * k / count
	around = np.pi * (1 + 5 ** 0.5) * k
	level = np.sqrt(1 - up * up)
	return np.stack([level * np.cos(around), up, level * np.sin(around)], -1)


VIEW = {}   # the posed model one reach() pass renders, shared with its workers


def viewed(job):
	# The regions at least MINIMUM of whose places lie on the silhouette's rim
	# from one direction at one distance (in the model's radii), for reach()
	direction, distance = job
	flat, keys, middle, radius, width = VIEW["flat"], VIEW["keys"], VIEW["middle"], VIEW["radius"], VIEW["width"]
	focal = width / 2 / (1.1 * radius / (distance * radius))
	if distance < 2:
		# close: a wide lens framing the whole model, as the photos taken near the jet are
		focal = width / 2 / np.tan(np.arcsin(min(0.99, 1.0 / distance)))
	camera = cam.looking(middle + direction * distance * radius, middle, focal)
	pixels, depth = cam.project(camera, flat, (width / 2, width / 2))
	ids = frontmost(pixels.reshape(-1, 3, 2), depth.reshape(-1, 3), (width, width))
	hits = {}
	for row, column in rim(ids >= 0):
		key = keys[ids[row, column]]
		if key is not None:
			hits[key] = hits.get(key, 0) + 1
	return [key for key, n in hits.items() if n >= MINIMUM]


def reach(model, joints, poses, frame, settings=None, count=240, width=800, distances=(6.0,), workers=1):
	# Which regions of the skin can make the outline at all, and from where:
	# the model in each pose (the points file's drives) seen from count
	# directions spread evenly round it, at each distance (in the model's
	# radii, round its middle; under 2, a wide lens close in, as photos taken
	# beside the jet are), framing it whole, and the regions of the solid
	# parts at least MINIMUM of whose places lie on the silhouette's rim, as a
	# photo must have to judge one (glass hides what lies behind it but is no
	# outline, as in Scene.places). {region: [(azimuth, elevation, pose
	# index, distance), ...]}, in degrees: azimuth round from straight ahead
	# toward the third coordinate's positive side, elevation up from level
	import multiprocessing
	settings = settings or DEFAULT
	seen = {}
	around = directions(count)
	jobs = [(d, r) for r in distances for d in around]
	for index, pose in enumerate(poses):
		posed = mod.pose(joints, pose)
		moved = stances(model, joints, pose, settings)
		solid = model.parts(posed, materials=settings.solid)
		clear = model.parts(posed, materials=["glass"])
		names = [n for n, t in solid.items() for _ in range(len(t))] + [None] * sum(len(t) for t in clear.values())
		tris = np.concatenate(list(solid.values()) + list(clear.values()))
		points = frame.source(tris.mean(axis=1))
		flat = tris.reshape(-1, 3)
		middle = (flat.min(0) + flat.max(0)) / 2
		VIEW.update(flat=flat, keys=[region(n, q, settings, moved.get(n, "")) if n is not None else None for n, q in zip(names, points)], middle=middle,
			radius=float(np.linalg.norm(flat - middle, axis=1).max()), width=width)
		if workers > 1:
			with multiprocessing.get_context("fork").Pool(workers) as pool:
				found = pool.map(viewed, jobs, chunksize=4)
		else:
			found = [viewed(job) for job in jobs]
		for (direction, distance), keys in zip(jobs, found):
			azimuth = round(float(np.degrees(np.arctan2(direction[2], direction[0]))), 1)
			elevation = round(float(np.degrees(np.arcsin(np.clip(direction[1], -1, 1)))), 1)
			for key in keys:
				seen.setdefault(key, []).append((azimuth, elevation, index, distance))
	return seen


def digest(results, universe=(), weaks=(), settings=None):
	# What the report says, as data (summary.json, for page.py): each photo's
	# figures, each region judged, and the regions of the skin
	settings = settings or DEFAULT
	photos = {}
	for photo, places in results.items():
		misses = [abs(p["miss"]) for p in places["places"]]
		photos[photo] = {"tried": places["tried"], "judged": len(misses), "median": round(float(np.median(misses)), 2) if misses else None,
			"weak": photo in weaks}
	regions = [{"region": label(key, settings), "family": key[0], "stretch": key[1], "sector": key[2], "photos": {ph: round(m, 2) for ph, m in medians.items()},
		"median": round(overall, 2), "places": count, "finding": finding(medians, settings), "moving": key[0] in settings.moving}
		for key, medians, overall, count in judge(results, weaks, settings)]
	return {"photos": photos, "regions": regions, "universe": sorted([list(k) for k in universe], key=lambda k: (k[0], k[2], k[1]))}


def sheets(results, weaks, directory, side=480, settings=None, private=()):
	# For each finding, the overlay round its places in every photo judging
	# it, side by side, to check by eye before it becomes a task. A photo in
	# private (a copyrighted one, measured only: the catalogue's "use":
	# "measure") shows as a plain tile with its miss, none of its pixels, since
	# the sheets go on published pages
	settings = settings or DEFAULT
	directory = Path(directory)
	for key, medians, overall, _ in judge(results, weaks, settings):
		if not finding(medians, settings):
			continue
		tiles = []
		for photo in sorted(medians):
			if photo in private:
				tile = Image.new("RGB", (side, side), (64, 64, 64))
				ImageDraw.Draw(tile).text((4, 2), f"{photo} {medians[photo]:+.1f} {settings.symbol}: measured only, not shown", fill=(255, 255, 255))
				tiles.append(tile)
				continue
			r = results[photo]
			xy = np.array([q["pixel"] for q in r["places"] if region(q["part"], q["point"], settings, q.get("stance", "")) == key]) * r["scale"]
			centre = xy.mean(axis=0)
			reach = max(side / 2, float(np.abs(xy - centre).max()) + 30)
			with Image.open(directory / f"{photo}.png") as image:
				tile = image.crop(tuple(int(v) for v in (centre[0] - reach, centre[1] - reach, centre[0] + reach, centre[1] + reach))).resize((side, side))
			pen = ImageDraw.Draw(tile)
			pen.rectangle([0, 0, side, 16], fill=(0, 0, 0))
			pen.text((4, 2), f"{photo} {medians[photo]:+.1f} {settings.symbol}", fill=(255, 255, 255))
			tiles.append(tile)
		columns = min(4, len(tiles))
		rows = (len(tiles) + columns - 1) // columns
		sheet = Image.new("RGB", (side * columns, side * rows + 20), (0, 0, 0))
		for i, tile in enumerate(tiles):
			sheet.paste(tile, (i % columns * side, 20 + i // columns * side))
		ImageDraw.Draw(sheet).text((4, 4), f"{label(key, settings)}: {overall:+.1f} {settings.symbol}", fill=(255, 255, 255))
		sheet.save(directory / f"finding {label(key, settings)}.png")


def postures(settings=None):
	# The poses the reach renders: flown (nozzles closed, the wings under load),
	# gear down and gear down with the canopy open, as the photos are posed, and
	# every stance those leave stowed let down at once, as parked on a deck
	settings = settings or DEFAULT
	poses = [{"load": 1, "nozzle": 1}, {"gear": 1}, {"gear": 1, "canopy": 1}]
	others = {drive: 1 for drive in settings.stances if not any(drive in pose for pose in poses)}
	return poses + ([{"gear": 1, **others}] if others else [])


def reaching(argv):
	# --reach: which regions can make the outline from some direction, flown,
	# gear down and with every stance let down, written to OUT.json ({region:
	# [[azimuth, elevation, pose], ...]}) with the regions on no outline printed
	args = [a for a in argv if not a.startswith("--")]
	catalogue_path, glb, points_path, out = args[:4]
	catalogue = json.loads(Path(catalogue_path).read_text())
	frame = mod.Frame(catalogue["frame"])
	settings = Settings(catalogue)
	model = mod.Model(glb)
	joints = json.loads(Path(points_path).read_text())["joints"]
	skin = universe(model, joints, frame, settings)
	count = int(argv[argv.index("--count") + 1]) if "--count" in argv else 240
	seen = reach(model, joints, postures(settings), frame, settings, count, distances=(1.6, 2.5, 6.0), workers=6)
	Path(out).write_text(json.dumps({label(k, settings): v for k, v in sorted(seen.items(), key=lambda kv: label(kv[0], settings))}, indent="\t") + "\n")
	never = sorted(label(k, settings) for k in skin - set(seen))
	print(f"on no outline from any of {count} directions at 1.6, 2.5 and 6 radii, flown, gear down, the canopy open or every stance let down ({len(never)}): " + ", ".join(never))


def main():
	if "--reach" in sys.argv:
		return reaching([a for a in sys.argv[1:] if a not in ("--reach",)])
	args = [a for a in sys.argv[1:] if not a.startswith("--")]
	only = sys.argv[sys.argv.index("--only") + 1].split(",") if "--only" in sys.argv else None
	if only:
		args = [a for a in args if a != ",".join(only)]
	catalogue_path, glb, points_path, cameras_path, out = args[:5]
	root = Path(catalogue_path).resolve().parent
	catalogue = json.loads(Path(catalogue_path).read_text())
	frame = mod.Frame(catalogue["frame"])
	settings = Settings(catalogue)
	model = mod.Model(glb)
	points_file = json.loads(Path(points_path).read_text())
	joints, hardpoints = points_file["joints"], points_file.get("points", {}).get("hardpoints", {})
	out = Path(out)
	out.mkdir(parents=True, exist_ok=True)
	spec = catalogue.get("gate")
	# every region of the skin, at rest and in each stance, for the coverage
	skin = universe(model, joints, frame, settings)
	results, weaks = {}, set()
	for entry in json.loads(Path(cameras_path).read_text()):
		photo = entry["photo"]
		if only and photo not in only:
			continue
		if spec and "rms" in entry and weak(entry["field"], entry["rms"], spec):
			weaks.add(photo)
		scene = Scene(catalogue, root, frame, hardpoints, entry)
		places, mask = scene.places(model, joints, entry.get("pose", {}))
		results[photo] = {"tried": len(rim(mask)), "places": places, "scale": scene.scale}
		overlay(scene.gray, mask, places, scene.scale, out / f"{photo}.png", settings)
		print(f"photo {photo}: {len(places)} places", file=sys.stderr)
	(out / "skyline.json").write_text(json.dumps(results) + "\n")
	print(summary(results, skin, weaks, settings))
	(out / "summary.json").write_text(json.dumps(digest(results, skin, weaks, settings), indent="\t") + "\n")
	sheets(results, weaks, out, settings=settings, private={p for p, e in catalogue["photos"].items() if e.get("use") == "measure"})


if __name__ == "__main__":
	main()
