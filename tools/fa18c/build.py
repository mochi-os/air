# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# Builds our own F/A-18C (claude/plans/air-fa18c.md) from nothing on each run:
# every number comes from facts.json, whose entries cite their sources, and
# from the outlines views.py traces out of the NASA figures. It never opens the
# old model or anything under apps/air/downloads.
#
# Writes the model as glTF binary and its points file (the plan's Contract):
# true metres in the engine's axes (x forward, y up, z starboard), origin at FS
# 456, WL 105, BL 0, each moving part a node on its hinge, at rest with no
# rotation.
#
# With a third path it also writes the features file: named points and curves
# on the model, each with the node it rides on, that the photo match
# (verify/photos.py) and the facts check compare.
#
# --draft leaves out the paint (the atlas and its ambient-occlusion bake), for
# quick looks at the shape.
#
# usage: blender -b --factory-startup --python-use-system-env -P build.py -- OUT.glb OUT.json [FEATURES.json] [--draft]
import json, math, sys
from pathlib import Path

import bmesh
import numpy as np
import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

HERE = Path(__file__).resolve().parent
FACTS = json.loads((HERE / "facts.json").read_text())
LAYOUT = FACTS["layout"]
# Traced by views.py from the NASA figures (run fetch.py and views.py first)
TRACED = json.loads((HERE / "references" / "sections.json").read_text())["sections"]
PROFILES = json.loads((HERE / "references" / "profiles.json").read_text())
INCH = 0.0254
# The plan's origin (Contract, Frame): the research jets' centre of gravity, rounded
ORIGIN = {"station": 456, "waterline": 105}

# Blender works z up; the glTF exporter turns its (x, y, z) into (x, z, -y).
# So here x is forward, y port and z up, and the exported frame is the
# engine's: x forward, y up, z starboard.
FORWARD, PORT, UP = Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))
AFT, DOWN = -FORWARD, -UP
IDENTITY = [[-1.0, -1.0], [1.0, 1.0]]


def value(entry):
	return entry["value"] if isinstance(entry, dict) and "value" in entry else entry


def at(station, waterline, buttline):
	# A point given in the jet's stations, inches, buttline positive to starboard
	return Vector(((ORIGIN["station"] - station) * INCH, -buttline * INCH, (waterline - ORIGIN["waterline"]) * INCH))


def exported(vector):
	# A point or direction in the engine's frame
	return [round(vector.x, 5), round(vector.z, 5), round(-vector.y, 5)]


def side_name(side):
	return "left" if side < 0 else "right"


# NACA 65A sections (facts.json "airfoils", TR-84's tables). Another thickness
# takes the ordinate-to-thickness ratios interpolated between the tabulated
# forms, as TR-84's cross plots do; above 5% the 5% ratios hold.
def airfoil(thickness):
	table = FACTS["airfoils"]
	forms = {float(key): ys for key, ys in table["thickness"].items()}
	keys = sorted(forms)
	t = min(max(thickness, keys[0]), keys[-1])
	low = max(key for key in keys if key <= t)
	high = min(key for key in keys if key >= t)
	weight = 0 if high == low else (t - low) / (high - low)
	return [(x / 100, ((a / low) * (1 - weight) + (b / high) * weight) * thickness / 100)
		for x, a, b in zip(table["x"], forms[low], forms[high])]


STATIONS = [x / 100 for x in FACTS["airfoils"]["x"]]


def half(section, x):
	# Half-thickness at chord fraction x, linear between the table's stations
	for (x0, y0), (x1, y1) in zip(section, section[1:]):
		if x0 <= x <= x1:
			return y0 + (y1 - y0) * (x - x0) / ((x1 - x0) or 1)
	return 0.0


class Surface:
	# A lifting surface of streamwise sections on a straight leading edge.
	# Moving u inches along the span moves the leading edge by `span` x u
	# (span's lateral part is the planform's unit, so u is the planform
	# distance) and aft by u x tan(sweep). Thicknesses are (root, tip), or
	# [(u, percent)] knots held past their ends; aft is the chord's direction
	# (turned from straight aft by a surface's toe).
	def __init__(self, root, span, sweep, chords, thicknesses, length, aft=None):
		self.root, self.span, self.sweep = root, span, math.tan(math.radians(sweep))
		self.chords, self.length = chords, length
		self.thicknesses = thicknesses if isinstance(thicknesses, list) else [(0.0, thicknesses[0]), (length, thicknesses[1])]
		self.aft = (aft or AFT).normalized()
		self.up = self.aft.cross(span).normalized()
		if self.up.dot(UP) < 0:
			self.up = -self.up

	def station(self, u):
		f = u / self.length
		chord = self.chords[0] + (self.chords[1] - self.chords[0]) * f
		thickness = between(self.thicknesses, u)
		leading = self.root + self.span * (u * INCH) + AFT * (u * self.sweep * INCH)
		return leading, chord, thickness

	def point(self, u, x, side=0.0):
		# x chord fraction; side -1 lower, 0 chord plane, 1 upper surface
		leading, chord, thickness = self.station(u)
		y = half(airfoil(thickness), x) * side
		return leading + self.aft * (x * chord * INCH) + self.up * (y * chord * INCH)

	def piece(self, spans, chord, steps=6):
		# The part between span stations spans[0]..spans[1] and chord fractions
		# chord[0]..chord[1], closed at every cut
		start, end = chord
		xs = sorted({start, end} | {x for x in STATIONS if start < x < end})
		rings = []
		for i in range(steps + 1):
			u = spans[0] + (spans[1] - spans[0]) * i / steps
			rings.append([self.point(u, x, 1) for x in xs] + [self.point(u, x, -1) for x in reversed(xs)])
		return loft(rings)

	def panel(self, spans, cuts):
		# The fixed part between span stations spans[0]..spans[1], less the
		# hinged surfaces: cuts is a list of (span range, chord fraction, edge)
		# with edge "front" (a leading-edge flap) or "back"
		breaks = sorted({spans[0], spans[1]} | {b for reach, _, _ in cuts for b in reach if spans[0] < b < spans[1]})
		pieces = []
		for a, b in zip(breaks, breaks[1:]):
			middle = (a + b) / 2
			front = max([x for reach, x, edge in cuts if edge == "front" and reach[0] <= middle <= reach[1]], default=0.0)
			back = min([1 - x for reach, x, edge in cuts if edge == "back" and reach[0] <= middle <= reach[1]], default=1.0)
			pieces.append(self.piece((a, b), (front, back), steps=max(1, round((b - a) / 20))))
		return merge(pieces)

	def fraction(self, area, spans):
		# The constant chord fraction a hinged surface needs for `area` (ft2)
		# between span stations spans[0]..spans[1]
		steps = 200
		total = sum(self.station(spans[0] + (spans[1] - spans[0]) * (i + 0.5) / steps)[1] for i in range(steps))
		return area * 144 / (total * (spans[1] - spans[0]) / steps)


def loft(rings):
	# Quads between consecutive closed rings of equal length, and an n-gon
	# over each end
	vertices = [v for ring in rings for v in ring]
	n = len(rings[0])
	faces = []
	for r in range(len(rings) - 1):
		a, b = r * n, (r + 1) * n
		faces += [(a + i, a + (i + 1) % n, b + (i + 1) % n, b + i) for i in range(n)]
	last = (len(rings) - 1) * n
	faces += [tuple(range(n - 1, -1, -1)), tuple(range(last, last + n))]
	return vertices, faces


def merge(pieces):
	vertices, faces = [], []
	for vs, fs in pieces:
		offset = len(vertices)
		vertices += vs
		faces += [tuple(i + offset for i in f) for f in fs]
	return vertices, faces


MATERIALS = {}
# Linear base colours. The paint bake replaces paint's and team's with the atlas
# (layout.paint); lights is the unlit formation strips' pale grey, sRGB 154-163
# in dvids9820808 (the engine lights them at night)
COLOURS = {"paint": (0.42, 0.45, 0.48, 1), "team": (0.42, 0.45, 0.48, 1), "glass": (0.1, 0.12, 0.14, 0.4),
	"lights": (0.34, 0.35, 0.32, 1), "burner": (1, 0.6, 0.2, 1), "display": (0.05, 0.08, 0.05, 1)}


def material(name):
	if name not in MATERIALS:
		m = bpy.data.materials.new(name)
		m.use_nodes = True
		m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = COLOURS[name]
		m.diffuse_color = COLOURS[name]
		MATERIALS[name] = m
	return MATERIALS[name]


NODES, HINGES, JOINTS = {}, {}, {}
# The contract's landmarks (points file), in the model frame
LANDMARKS = {}
# The features file's points and curves the photo match measures the model
# by (verify/photos.py), each with the node it rides on: name to (point, node)
# and name to ([points], node)
MARKS, CURVES = {}, {}
PROBE = []   # the stowed probe's tip
SURFACES = {}
TOPLINE, KEELLINE = [], []


def node(name, parent=None, hinge=None, mesh=None, paint="paint"):
	# An object at `hinge` (world space). Its mesh's vertices are given in
	# world space and stored relative to the hinge. Every ancestor rests
	# unrotated, so a child's location is its hinge less its parent's.
	if hinge is None:
		hinge = HINGES[parent].copy() if parent else Vector()
	data = None
	if mesh:
		# a mesh is (vertices, faces), or (vertices, faces, a material per face)
		vertices, faces = mesh[0], mesh[1]
		paints = mesh[2] if len(mesh) > 2 else [paint] * len(faces)
		data = bpy.data.meshes.new(name)
		data.from_pydata([v - hinge for v in vertices], [], faces)
		names = sorted(set(paints))
		for n in names:
			data.materials.append(material(n))
		for polygon, n in zip(data.polygons, paints):
			polygon.material_index = names.index(n)
		data.validate()
		tidy(data)
	obj = bpy.data.objects.new(name, data)
	bpy.context.scene.collection.objects.link(obj)
	if parent:
		obj.parent = NODES[parent]
	obj.location = hinge - (HINGES[parent] if parent else Vector())
	NODES[name], HINGES[name] = obj, hinge.copy()
	return obj


def tidy(data):
	# Welds coincident vertices, turns every face outward, and shades smooth
	# but for edges sharper than 35 degrees (leading and trailing edges, cuts)
	bm = bmesh.new()
	bm.from_mesh(data)
	bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
	bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
	bm.to_mesh(data)
	bm.free()
	data.shade_smooth()
	data.set_sharp_from_angle(angle=math.radians(35))


def joint(name, axis, arm, want, drive, keys, motion="rotate"):
	# Records a joint. The axis is turned so that a positive angle moves `arm`
	# (from the hinge toward the moving part) toward `want`, or a positive
	# slide moves along `want`.
	axis = axis.normalized()
	if (axis.cross(arm).dot(want) if motion == "rotate" else axis.dot(want)) < 0:
		axis = -axis
	JOINTS[name] = {"motion": motion, "axis": exported(axis), "drive": drive, "keys": keys}


def leading_sweep(quarter, aspect, taper):
	# Leading-edge sweep of a straight-tapered planform from its quarter-chord sweep
	return math.degrees(math.atan(math.tan(math.radians(quarter)) + (4 / aspect) * 0.25 * (1 - taper) / (1 + taper)))


def wing(side):
	name = side_name(side)
	w = FACTS["wing"]
	semispan = value(FACTS["reference"]["span"]) * 12 / 2
	# the photos' anhedral, the jet parked (layout.wing), where cr201687 has -3 deg
	dihedral = math.tan(math.radians(LAYOUT["wing"]["dihedral"]))
	root_chord, tip_chord = value(w["root"]), value(w["tip"])
	taper = tip_chord / root_chord
	sweep = leading_sweep(value(w["sweep"]), value(w["aspect"]), taper)
	# The theoretical root on the centreline: its leading edge back from the
	# mean aerodynamic chord's (tp209033 table 1), its chord plane through the
	# layout's waterline at the LEX junction, falling outboard with the anhedral
	mean = (semispan / 3) * (1 + 2 * taper) / (1 + taper)
	leading = value(FACTS["reference"]["leading"]) - mean * math.tan(math.radians(sweep))
	plane = LAYOUT["wing"]
	root = at(leading, plane["value"] - plane["buttline"] * dihedral, 0)
	span = Vector((0, -side, dihedral))
	# Thickness: cr3608's 5% at wing station 56.876 and 3.5% from 145.390 out
	# to the tip, linear between and held inboard
	airfoils = w["airfoil"]
	thickness = [(56.876, value(airfoils["root"])), (145.39, value(airfoils["middle"])), (semispan, value(airfoils["tip"]))]
	surface = Surface(root, span, sweep, (root_chord, tip_chord), thickness, semispan)
	spans = LAYOUT["surfaces"]
	fold = value(w["fold"])
	areas = value(w["areas"])
	share = value(w["lef"])   # each inboard leading-edge flap's share of the total; each outboard has (1 - 2 x share) / 2
	inner_lef = surface.fraction(areas["lef"] * share, spans["lef"]["inner"])
	outer_lef = surface.fraction(areas["lef"] * (1 - 2 * share) / 2, spans["lef"]["outer"])
	tef = surface.fraction(areas["tef"] / 2, spans["tef"])
	aileron = surface.fraction(areas["aileron"] / 2, spans["aileron"])
	inside = 40.0   # the root buried in the fuselage
	node(f"wing_inner_{name}", mesh=surface.panel((inside, fold), [(spans["lef"]["inner"], inner_lef, "front"), (spans["tef"], tef, "back")]))

	def hinged(joint_name, reach, x, part, arm, want, drive, parent=None, paint="paint"):
		a, b = surface.point(reach[0], x), surface.point(reach[1], x)
		node(joint_name, parent=parent, hinge=a, mesh=surface.piece(reach, part, steps=max(1, round((reach[1] - reach[0]) / 20))), paint=paint)
		joint(joint_name, b - a, arm, want, drive, IDENTITY)

	hinged(f"flap_leading_inner_{name}", spans["lef"]["inner"], inner_lef, (0, inner_lef), FORWARD, DOWN, "slat")
	hinged(f"flap_trailing_{name}", spans["tef"], 1 - tef, (1 - tef, 1), AFT, DOWN, f"flaperon.{name}")
	# The outer panel folds about the fold line, carrying its flap and aileron,
	# as far as gives NATOPS's folded span (no source states the angle)
	a, b = surface.point(fold, 0), surface.point(fold, 1)
	outer = surface.panel((fold, semispan), [(spans["lef"]["outer"], outer_lef, "front"), (spans["aileron"], aileron, "back")])
	axis = (b - a).normalized()
	if axis.cross(Vector((0, -side, 0))).dot(UP) < 0:
		axis = -axis
	corners = list(outer[0]) + list(surface.piece(spans["lef"]["outer"], (0, outer_lef))[0]) + list(surface.piece(spans["aileron"], (1 - aileron, 1))[0])

	def reach(angle):
		R = Matrix.Rotation(angle, 3, axis)
		return max(abs((a + R @ (v - a)).y) for v in corners) / INCH

	# (past 90 degrees: the anhedral leans a vertical panel outboard)
	folded = value(FACTS["overall"]["span"]["folded"]) * 12 / 2
	low, high = math.radians(30), math.radians(120)
	for _ in range(40):
		middle = (low + high) / 2
		low, high = (middle, high) if reach(middle) > folded else (low, middle)
	node(f"wing_{name}", hinge=a)
	joint(f"wing_{name}", b - a, Vector((0, -side, 0)), UP, "fold", [[0, 0], [1, round(high, 4)]])
	node(f"wing_outer_{name}", parent=f"wing_{name}", hinge=a, paint="team", mesh=outer)
	hinged(f"flap_leading_outer_{name}", spans["lef"]["outer"], outer_lef, (0, outer_lef), FORWARD, DOWN, "slat", parent=f"wing_{name}")
	hinged(f"aileron_{name}", spans["aileron"], 1 - aileron, (1 - aileron, 1), AFT, DOWN, f"flaperon.{name}", parent=f"wing_{name}")
	SURFACES[f"wing_{name}"] = surface
	LANDMARKS[f"wingtip_leading_{name}"] = surface.point(semispan, 0)
	LANDMARKS[f"wingtip_trailing_{name}"] = surface.point(semispan, 1)
	MARKS[f"wingtip_leading_{name}"] = (surface.point(semispan, 0), f"flap_leading_outer_{name}")
	# the tip's trailing corner is the aileron's, which runs to the tip; at the
	# fold the photos see the flap's outboard trailing corner
	MARKS[f"wingtip_trailing_{name}"] = (surface.point(semispan, 1), f"aileron_{name}")
	MARKS[f"fold_trailing_{name}"] = (surface.point(spans["tef"][1], 1), f"flap_trailing_{name}")
	MARKS[f"lex_wing_{name}"] = (surface.point(spans["lef"]["inner"][0], 0), f"flap_leading_inner_{name}")
	for key, reach_, part in (("inner", spans["lef"]["inner"], "flap_leading_inner"), ("outer", spans["lef"]["outer"], "flap_leading_outer")):
		CURVES[f"wing_leading_{key}_{name}"] = ([surface.point(reach_[0] + (reach_[1] - reach_[0]) * i / 12, 0) for i in range(13)], f"{part}_{name}")
	CURVES[f"wingtip_{name}"] = ([surface.point(semispan, x) for x in (0, 0.25, 0.5, 0.75, 1)], f"wing_outer_{name}")
	return {"lef": [inner_lef, outer_lef], "tef": tef, "aileron": aileron}


def stabilator(side):
	name = side_name(side)
	s = FACTS["stabilator"]
	place = LAYOUT["stabilator"]
	root_chord, tip_chord = value(s["root"]), value(s["tip"])
	exposed = value(s["exposed"]) * 12 / 2
	taper = tip_chord / root_chord
	aspect = (value(s["exposed"]) * 12) ** 2 / (value(s["area"]) * 144)
	sweep = leading_sweep(value(s["sweep"]), aspect, taper)
	span = Vector((0, -side, math.tan(math.radians(value(s["dihedral"])))))
	root = at(place["value"], place["waterline"], side * place["buttline"])
	airfoils = value(s["airfoil"])
	surface = Surface(root, span, sweep, (root_chord, tip_chord), (airfoils["root"], airfoils["tip"]), exposed)
	# The spindle is not published: provisionally through the exposed panel's
	# mean-chord quarter point, square to the centreline in the panel's plane
	mean = (exposed / 3) * (1 + 2 * taper) / (1 + taper)
	chord = root_chord * (2 / 3) * (1 + taper + taper * taper) / (1 + taper)
	quarter = surface.station(mean)[0] + AFT * (0.25 * chord * INCH)
	pivot = Vector((quarter.x, root.y, root.z))
	node(f"stabilator_{name}", hinge=pivot, mesh=surface.piece((0, exposed), (0, 1), steps=8))
	LANDMARKS[f"stabilator_tip_leading_{name}"] = surface.point(exposed, 0)
	LANDMARKS[f"stabilator_tip_trailing_{name}"] = surface.point(exposed, 1)
	MARKS[f"stabilator_tip_leading_{name}"] = (surface.point(exposed, 0), f"stabilator_{name}")
	MARKS[f"stabilator_tip_trailing_{name}"] = (surface.point(exposed, 1), f"stabilator_{name}")
	CURVES[f"stabilator_leading_{name}"] = ([surface.point(exposed * i / 8, 0) for i in range(9)], f"stabilator_{name}")
	CURVES[f"stabilator_trailing_{name}"] = ([surface.point(exposed * i / 8, 1) for i in range(9)], f"stabilator_{name}")
	joint(f"stabilator_{name}", span, AFT, DOWN, f"stabilator.{name}", IDENTITY)


def fin(side):
	name = side_name(side)
	f = FACTS["fin"]
	place = LAYOUT["fin"]
	cant = math.radians(value(f["cant"]))
	span = Vector((0, -side * math.sin(cant), math.cos(cant)))
	root = at(place["root"]["station"], place["root"]["waterline"], side * place["root"]["buttline"])
	root_chord, tip_chord, height = value(f["root"]), value(f["tip"]), value(f["height"])
	sweep = math.degrees(math.atan(math.tan(math.radians(value(f["sweep"]))) + 0.25 * (root_chord - tip_chord) / height))
	airfoils = value(f["airfoil"])
	# toed out: the chord turned so the leading edge stands outboard of the trailing edge
	toe = math.radians(value(f["toe"]))
	aft = AFT * math.cos(toe) + PORT * (side * math.sin(toe))
	surface = Surface(root, span, sweep, (root_chord, tip_chord), (airfoils["root"], airfoils["tip"]), height, aft=aft)
	reach = LAYOUT["surfaces"]["rudder"]
	spans = (reach[0] * height, reach[1] * height)
	rudder = surface.fraction(value(f["rudder"]) / 2, spans)
	node(f"fin_{name}", hinge=root, mesh=surface.panel((0, height), [(spans, rudder, "back")]))
	# the antenna pod on the trailing edge below the tip (layout.pod), on the
	# fin's plane at its waterline
	p = LAYOUT["pod"]
	level = height - (place["tip"]["waterline"] - p["waterline"]) / math.cos(cant)
	bl = -surface.point(level, 1).y / INCH   # Blender's y is to port
	node(f"pod_{name}", mesh=pod(at(p["from"], p["waterline"], bl), at(p["to"], p["waterline"], bl), p["diameter"] / 2))
	MARKS[f"pod_aft_{name}"] = (at(p["to"], p["waterline"], bl), f"pod_{name}")
	a, b = surface.point(spans[0], 1 - rudder), surface.point(spans[1], 1 - rudder)
	node(f"rudder_{name}", hinge=a, mesh=surface.piece(spans, (1 - rudder, 1), steps=3), paint="team")
	joint(f"rudder_{name}", b - a, AFT, PORT, "rudder", IDENTITY)
	LANDMARKS[f"fin_tip_leading_{name}"] = surface.point(height, 0)
	LANDMARKS[f"fin_tip_trailing_{name}"] = surface.point(height, 1)
	MARKS[f"fin_tip_leading_{name}"] = (surface.point(height, 0), f"fin_{name}")
	MARKS[f"fin_tip_trailing_{name}"] = (surface.point(height, 1), f"fin_{name}")
	MARKS[f"fin_root_leading_{name}"] = (surface.point(0, 0), f"fin_{name}")
	CURVES[f"fin_leading_{name}"] = ([surface.point(height * i / 8, 0) for i in range(9)], f"fin_{name}")
	CURVES[f"fin_trailing_{name}"] = ([surface.point(spans[1] + (height - spans[1]) * i / 6, 1) for i in range(7)], f"fin_{name}")
	CURVES[f"rudder_trailing_{name}"] = ([surface.point(spans[0] + (spans[1] - spans[0]) * i / 4, 1) for i in range(5)], f"rudder_{name}")
	return rudder


def between(knots, x):
	# Linear between (x, value) knots, held flat past the ends
	knots = sorted(knots)
	if x <= knots[0][0]:
		return knots[0][1]
	for (x0, y0), (x1, y1) in zip(knots, knots[1:]):
		if x <= x1:
			return y0 + (y1 - y0) * (x - x0) / (x1 - x0)
	return knots[-1][1]


def smoothed(values, stations):
	# A profile traced from the scanned figure steps a whole pixel at a time
	# (0.4 to 0.9 in): every inch or so where the line is steep, and only every
	# 10 to 30 in where it is nearly level, where read pixel by pixel it would
	# make ledges in the skin. The drawn line crosses from one pixel row to the
	# next where the trace steps, so it runs through the middle of each step
	# (halfway between the rows, halfway between the stations), and a step that
	# comes straight back (a row the line only grazes) cancels out; a Gaussian
	# over 4 in irons the corners at those middles. It eases in over FS 72 to
	# 88, so the nose, steep out of the apex, keeps its traced line; the cited
	# sections at FS 70, 85 and 107 fix its heights either way
	values = np.array(values, float)
	stations = np.array(stations, float)
	good = np.isfinite(values)
	first, last = np.nonzero(good)[0][[0, -1]]
	knots = [(stations[first], values[first])]
	for i in range(first + 1, last + 1):
		if good[i] and good[i - 1] and values[i] != values[i - 1]:
			knots.append(((stations[i - 1] + stations[i]) / 2, (values[i - 1] + values[i]) / 2))
	knots.append((stations[last], values[last]))
	line = np.interp(stations, [k[0] for k in knots], [k[1] for k in knots])
	reach = 12
	kernel = np.exp(-0.5 * (np.arange(-reach, reach + 1) / 4.0) ** 2)
	kernel /= kernel.sum()
	ironed = np.convolve(np.pad(line, reach, mode="edge"), kernel, mode="valid")
	weight = np.clip((stations - 72) / 16, 0, 1)
	weight = weight * weight * (3 - 2 * weight)
	return list(np.where(good, values * (1 - weight) + ironed * weight, np.nan))


SMOOTHED = {}


def profile(kind, station):
	# The HATP side's top or keel line, or the top view's half-width, at a station
	view = "side" if kind in ("top", "keel") else "top"
	table = PROFILES[view]
	if (view, kind) not in SMOOTHED:
		SMOOTHED[(view, kind)] = smoothed(table[kind], table["stations"])
	values = SMOOTHED[(view, kind)]
	stations = table["stations"]
	i = min(max(int(station) - stations[0], 0), len(stations) - 2)
	a, b = values[i], values[i + 1]
	return a + (b - a) * (station - stations[i])


def resample(chain, n):
	# n points evenly spaced along a polyline
	lengths = [0.0]
	for (x0, y0), (x1, y1) in zip(chain, chain[1:]):
		lengths.append(lengths[-1] + math.hypot(x1 - x0, y1 - y0))
	out, j = [], 0
	for i in range(n):
		target = lengths[-1] * i / (n - 1)
		while j < len(lengths) - 2 and lengths[j + 1] < target:
			j += 1
		f = (target - lengths[j]) / ((lengths[j + 1] - lengths[j]) or 1)
		out.append((chain[j][0] + (chain[j + 1][0] - chain[j][0]) * f, chain[j][1] + (chain[j + 1][1] - chain[j][1]) * f))
	return out


HALF = 33   # points on each half-section, top centreline to keel


def destaired(chain, sigma=1.0):
	# A traced half-outline (top centreline to keel) with its pixel steps
	# smoothed out: points every 0.25 in along it, each moved to the Gaussian
	# mean of its neighbours (sigma in inches along the outline), with the
	# outline's mirror image beyond each centreline end so they stay on it.
	# Resampled raw, a point landing on a step's riser rather than its tread
	# moves by up to the step, 0.1-0.4 in, and the skin between the sections
	# carries the jitter as bumps
	length = sum(math.hypot(x1 - x0, y1 - y0) for (x0, y0), (x1, y1) in zip(chain, chain[1:]))
	dense = np.array(resample(chain, max(8, int(length / 0.25) + 1)))
	reach = int(3 * sigma / 0.25)
	head = dense[1:reach + 1][::-1] * [-1, 1]
	tail = dense[-reach - 1:-1][::-1] * [-1, 1]
	padded = np.concatenate([head, dense, tail])
	kernel = np.exp(-0.5 * (np.arange(-reach, reach + 1) * 0.25 / sigma) ** 2)
	kernel /= kernel.sum()
	smoothed = np.stack([np.convolve(padded[:, axis], kernel, mode="valid") for axis in (0, 1)], 1)
	return [tuple(p) for p in smoothed]


def shape(station):
	# A traced section's starboard half (both drawn halves averaged), the LEX
	# cut off where it leaves the body, normalised to unit height above the
	# keel and unit half-width. Returns (points, body half-width in inches).
	outline = TRACED[str(station)]["outline"]
	top = max(range(len(outline)), key=lambda i: outline[i][1])
	bottom = min(range(len(outline)), key=lambda i: outline[i][1])
	ring = outline[top:] + outline[:top]
	cut = (bottom - top) % len(outline)
	chains = [ring[: cut + 1], list(reversed(ring[cut:] + ring[:1]))]
	tip = max(outline, key=lambda p: abs(p[0]))
	halves = []
	if station < 253:
		# no LEX: the whole outline
		body = abs(tip[0])
		for chain in chains:
			halves.append(resample(destaired([(abs(x), y) for x, y in chain]), HALF))
	else:
		# The LEX leaves the body near its tip's height: the body's own
		# half-width is the widest point well away from it, and the outline
		# runs straight down the wall across the LEX's root (lex() builds the
		# blade), so no stub of it is left on the body
		band = [p for p in outline if abs(p[1] - tip[1]) >= 12]
		body = max(abs(p[0]) for p in band)
		for chain in chains:
			chain = [(abs(x), y) for x, y in chain]
			kept = [p for p in chain if p[0] <= body + 0.3 and not (p[0] > body - 2.5 and tip[1] - 5 <= p[1] <= tip[1] + 14)]
			halves.append(resample(destaired(kept), HALF))
	points = [((a[0] + b[0]) / 2, (a[1] + b[1]) / 2) for a, b in zip(*halves)]
	height = max(y for _, y in points)
	width = max(x for x, _ in points)
	return [(x / width, y / height) for x, y in points], width


def circle():
	return [(math.sin(math.pi * i / (HALF - 1)), (1 + math.cos(math.pi * i / (HALF - 1))) / 2) for i in range(HALF)]


def smooth(knots, x):
	# A monotone cubic through (x, value) knots (Fritsch-Carlson), held flat
	# past the ends: no overshoot, no kinks
	knots = sorted(knots)
	xs, ys = [k[0] for k in knots], [k[1] for k in knots]
	if x <= xs[0]:
		return ys[0]
	if x >= xs[-1]:
		return ys[-1]
	n = len(xs)
	d = [(ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]) for i in range(n - 1)]
	m = [d[0]] + [0.0 if d[i - 1] * d[i] <= 0 else (d[i - 1] + d[i]) / 2 for i in range(1, n - 1)] + [d[-1]]
	for i in range(n - 1):
		if d[i] == 0:
			m[i] = m[i + 1] = 0.0
		else:
			a, b = m[i] / d[i], m[i + 1] / d[i]
			if a * a + b * b > 9:
				t = 3 / math.sqrt(a * a + b * b)
				m[i], m[i + 1] = t * a * d[i], t * b * d[i]
	i = max(k for k in range(n - 1) if xs[k] <= x)
	h = xs[i + 1] - xs[i]
	t = (x - xs[i]) / h
	return (ys[i] * (2 * t ** 3 - 3 * t ** 2 + 1) + m[i] * h * (t ** 3 - 2 * t ** 2 + t)
		+ ys[i + 1] * (-2 * t ** 3 + 3 * t ** 2) + m[i + 1] * h * (t ** 3 - t ** 2))


FORE = {}


def forebody():
	# What every forebody ring is made from: the cited sections' sizes
	# (TM-101724 to FS 184, the traced TP-3111 sections beyond) and shapes,
	# the HATP profiles that carry the run between them, the nosecone's
	# drooped axis, and the canopy's located points (layout.canopy), which
	# the top line is bent to pass through
	sections = {r["station"]: r for r in FACTS["sections"]}
	shapes = {70: (circle(), sections[70]["width"] / 2)}
	for station in (107, 142, 184, 253, 296, 357):
		shapes[station] = shape(station)
	heights = {s: r["height"] for s, r in sections.items()}
	widths = {s: r["width"] / 2 for s, r in sections.items()}
	for station in (253, 296, 357):
		heights[station] = TRACED[str(station)]["height"]
		widths[station] = shapes[station][1]
	hatp = lambda s: profile("top", s) - profile("keel", s)
	FORE.update(shapes=shapes, widths=widths, hatp=hatp, known=sorted(shapes),
		height_ratio=[(s, h / hatp(s)) for s, h in heights.items()],
		width_ratio=[(s, w / profile("half", s)) for s, w in widths.items() if s <= 184], top=[])
	layout = LAYOUT["canopy"]
	located = [(layout["windscreen"]["station"], layout["windscreen"]["waterline"]), (layout["bow"]["station"], layout["bow"]["waterline"]),
		(layout["crown"]["station"], layout["crown"]["waterline"]), (layout["aft"]["station"], layout["aft"]["waterline"])]
	located += [tuple(p) for p in layout["top"]]   # the top line behind the crown, from the profiles
	located.sort()
	bends = [(s, wl - sum(raw(s)[:2])) for s, wl in located]
	# from TM-101724's last section, arriving level (a knot either side, or
	# the bend starts on a slope), to the rear fuselage's top line across the
	# blend (BLEND), which the HATP top line agrees with: TP-3111's section at
	# FS 357, scaled off the HATP height, stands 1.3 in lower, and a top line
	# falling to it within 20 in of the canopy creased the spine and left it
	# sagging an inch before the blend raised it again
	onto = [(s, smooth(CORE["top"], s) - sum(raw(s)[:2])) for s in BLEND]
	FORE["top"] = [(176.0, 0.0), (184.0, 0.0)] + bends + onto + [(BLEND[1] + 10.0, onto[-1][1])]


NOSE = 128.5   # facts.json nose.junction: the nosecone ends here


def raw(station):
	# A forebody station's keel, height and half-width before the canopy's bend
	F = FORE
	# each run between the cited sections on a monotone cubic through them:
	# straight runs would turn the skin at every section
	height = F["hatp"](station) * onward(F["height_ratio"], station)
	if station <= 184:
		width = profile("half", station) * smooth(F["width_ratio"], station)
	else:
		width = onward([(s, w) for s, w in F["widths"].items() if s >= 184], station)
	keel = profile("keel", min(station, 404))
	# The nosecone's sections centre on its axis, drooped 5.6 deg through the
	# apex on WL 100 (tm101724, cr3608), handing over to the HATP keel by FS 160
	apex = value(FACTS["nose"]["apex"])
	if station < 160:
		axis = value(FACTS["datum"]["apex"]) + (station - apex) * math.tan(math.radians(value(FACTS["nose"]["droop"])))
		w = min(1.0, max(0.0, (station - NOSE) / (160 - NOSE)))
		w = w * w * (3 - 2 * w)
		keel = (1 - w) * (axis - height / 2) + w * keel
	return keel, height, width


def onward(knots, x):
	# smooth(), arriving level at its last knot: behind the last cited section
	# (FS 357) the forebody holds while the rear fuselage takes over, and a run
	# that stopped there on a slope would turn the skin at the section
	last = max(knots)
	return smooth(list(knots) + [(last[0] + 20.0, last[1])], x)


def section_shape(station):
	# The forebody's unit half-section at a station: each of its points on a
	# monotone cubic through the cited sections' shapes (FORE["known"])
	F = FORE
	key = round(station, 4)
	if key not in F.setdefault("between", {}):
		known = F["known"]
		count = len(F["shapes"][known[0]][0])
		F["between"][key] = [tuple(onward([(k, F["shapes"][k][0][i][axis]) for k in known], station) for axis in (0, 1)) for i in range(count)]
	return F["between"][key]


def half_ring(station):
	# The fuselage's starboard half at a station, top centreline to keel, as
	# (buttline, waterline) at the half-ring's ANGLES round its centre
	F = FORE
	keel, height, width = raw(station)
	height += smooth(F["top"], station) if F["top"] and F["top"][0][0] < station < F["top"][-1][0] else 0.0
	points = section_shape(station)
	fore = narrowed(station, [(x * width, keel + y * height) for x, y in points])
	if station <= BLEND[0]:
		centre = (0.0, keel + height / 2)
		return centre, polar(fore, centre, angles_at(station, centre))
	centre, union = union_ring(station)
	w = min(1.0, (station - BLEND[0]) / (BLEND[1] - BLEND[0]))
	w = w * w * (3 - 2 * w)
	if w >= 1:
		return centre, union
	# each outline sampled round its own centre, then blended point by point:
	# sampling the forebody round the rear fuselage's centre, which moves
	# against it from station to station, steps where a ray grazes its side
	own = (0.0, keel + height / 2)
	forward = polar(fore, own, angles_at(station, own))
	middle = (0.0, (1 - w) * own[1] + w * centre[1])
	return middle, [((1 - w) * a[0] + w * b[0], (1 - w) * a[1] + w * b[1]) for a, b in zip(forward, union)]


SHOULDER = 8.0   # inches below the canopy's sill over which narrowed() fades out


def narrowed(station, outline):
	# The canopy's sill (layout.canopy, photo-measured) lies on the skin. The
	# cited sections between FS 184 and 253 leave the skin at its height 2-2.5 in
	# too wide, and the canopy's outline as far outside the rear and head-on
	# photos', so the section above the sill is drawn in across to pass through
	# it, the change fading out over SHOULDER inches below. It fades in over the
	# windscreen, whose outline the photos already match, and ends at the
	# canopy's aft end, where the sill meets the skin unchanged.
	layout = LAYOUT["canopy"]
	front, foot, back = layout["windscreen"]["station"], layout["sill"][0][0], layout["aft"]["station"]
	if station <= front or station >= back:
		return outline
	weight = 1.0 if station >= foot else ease((station - front) / (foot - front))
	b, w = sill_point(station)
	width = 0.0
	for (x0, y0), (x1, y1) in zip(outline, outline[1:]):
		# the outline runs from the top centreline down: its first crossing of the sill's waterline
		if (y0 - w) * (y1 - w) <= 0 and y0 != y1:
			width = x0 + (x1 - x0) * (w - y0) / (y1 - y0)
			break
	if width <= 0:
		return outline
	k = 1 + weight * (b / width - 1)
	drawn = [(x * (1 + (k - 1) * ease(1 - (w - y) / SHOULDER)), y) for x, y in outline]
	# Above the sill the glass is a superellipse from the sill to the top
	# centreline, its exponent fitted to the canopy's outlines in the photos:
	# one at the bow's foot and one at the aft corner, linear between
	glass = between([(foot, layout["glass"][0]), (layout["sill"][-1][0], layout["glass"][1])], station)
	top = outline[0][1]
	if top <= w:
		return drawn
	out = []
	for x, y in drawn:
		if y > w:
			v = min(1.0, (y - w) / (top - w))
			x = (1 - weight) * x + weight * b * (1 - v ** glass) ** (1 / glass)
		out.append((x, y))
	return out


def ease(f):
	# smoothstep of f clamped to 0..1
	f = min(1.0, max(0.0, f))
	return f * f * (3 - 2 * f)


BOW_FRAME = 3.0   # inches: the canopy's bow frame, painted, aft of the bow
LEAN_REACH = 10.0   # inches either side of a leaning edge over which the rings round it follow its lean


def leaned(station):
	# The fuselage ring at a station as (station, buttline, waterline) per
	# half-ring column. The canopy's bow and aft edge lean (layout.canopy: the
	# bow's foot, the sill's first point, is aft of its top; the canopy's aft
	# lower corner, the sill's last, ahead of its aft end), so each column of
	# the rings at those edges moves along by its share of the lean, from none
	# at the top centreline to all of it at the sill, fading out over SHOULDER
	# inches below. The rings within LEAN_REACH follow, less and less, so the
	# loft stays in order; each moved column is the skin at its own station.
	layout = LAYOUT["canopy"]
	bow, back = layout["bow"]["station"], layout["aft"]["station"]
	edges = [((bow, bow + BOW_FRAME), layout["sill"][0][0] - bow), ((back, back), layout["sill"][-1][0] - back)]
	centre, starboard = half_ring(station)
	shifts = [0.0] * len(starboard)
	for (start, end), lean in edges:
		distance = max(start - station, station - end, 0.0)
		weight = ease(1 - distance / LEAN_REACH)
		if weight == 0:
			continue
		top, sill = starboard[0][1], starboard[SILL][1]
		for j, (_, wl) in enumerate(starboard):
			share = (top - wl) / (top - sill) if j <= SILL else ease(1 - (sill - wl) / SHOULDER)
			shifts[j] += lean * weight * min(1.0, max(0.0, share))
	rings = {}
	out = []
	for j, shift in enumerate(shifts):
		if abs(shift) < 1e-6:
			out.append((station, *starboard[j]))
			continue
		moved = station + shift
		if moved not in rings:
			rings[moved] = half_ring(moved)[1]
		out.append((moved, *rings[moved][j]))
	return out


def skin(station, theta, out=0.0):
	# The fuselage's surface at a station, theta from the top centreline
	# round its centre (+ to starboard), moved out along the ray by `out`
	# inches: (buttline, waterline)
	centre, starboard = half_ring(station)
	bl, wl = polar(starboard, centre, [abs(theta)])[0]
	r = math.hypot(bl - centre[0], wl - centre[1])
	k = (r + out) / r
	return math.copysign(centre[0] + (bl - centre[0]) * k, theta), centre[1] + (wl - centre[1]) * k


FUSELAGE_STATIONS = []   # the stations fuselage() lofts its rings at


def body_at(station, waterline):
	# The fuselage's side at a station and waterline: the first wall the
	# half-ring crosses coming down from the top centreline (the body's side,
	# not a nacelle further out)
	_, starboard = half_ring(station)
	for (b0, w0), (b1, w1) in zip(starboard, starboard[1:]):
		if (w0 - waterline) * (w1 - waterline) <= 0 and w0 != w1:
			return b0 + (b1 - b0) * (waterline - w0) / (w1 - w0)
	return 0.0


def fuselage():
	# The fuselage, apex to the nozzles: forebody rings (forebody(), the
	# HATP profiles scaled to the cited sections) handing over to the rear
	# fuselage's union of body and nacelles between FS 357 and 404
	forebody()
	apex = value(FACTS["nose"]["apex"])
	stations = [apex + 0.2, 61.5, 63, 65, 67.5, 70, 74, 79, 85, 92, 100, 107, 115, 122, 124, 128.5, 133, 142, 152, 163, 174,
		180.2, 186, 190, 192.2, 196, 200, 205, 210, 215, 220, 225, 230, 236, 241, 246, 250.8, 256, 264, 275, 285, 296, 306, 316, 320.8, 326, 336, 346, 357, 368, 380, 392, 404]
	stations += [s for s in AFT_STATIONS if s > stations[-1]]
	# denser where the LEX and its fairing lie on the shoulder (lex()), and a
	# ring at each of the canopy's located stations
	c = LAYOUT["canopy"]
	located = {c["windscreen"]["station"], c["bow"]["station"], c["bow"]["station"] + BOW_FRAME, c["crown"]["station"], c["aft"]["station"]} | {p[0] for p in c["sill"]} | {p[0] for p in c["top"]}
	# and every 3 in over the nose, where the section widens fastest and the
	# probes, fairings, strips and door sit on the skin: 7-8 in apart, the
	# rings creased it 3 deg each, and the loft's flat facets stood up to 0.3
	# in off the section the fittings follow; every 4 in from the canopy's aft end to
	# the nozzles, where 10-20 in between rings left the spine and nacelles
	# faceted
	stations = sorted(set(stations) | {float(x) for x in range(328, 692, 4)} | {float(x) for x in range(92, 217, 3)} | located
		| {float(r["station"]) for r in FACTS["sections"]} | {253.0, 296.0, 357.0})   # a ring at every cited and traced section
	FUSELAGE_STATIONS[:] = stations
	rings = []
	for station in stations:
		columns = leaned(station)
		ring = [at(s, wl, bl) for s, bl, wl in columns] + [at(s, wl, -bl) for s, bl, wl in reversed(columns[1:-1])]
		rings.append(ring)
	canopy(stations, rings)
	TOPLINE[:] = [ring[0] for ring in rings]
	KEELLINE[:] = sorted((ring[len(ANGLES) - 1] for ring in rings), key=lambda v: -v.x)
	LANDMARKS["apex"] = rings[0][0]
	MARKS["apex"] = (rings[0][0], "fuselage")
	return sorted(FORE["widths"].items())


def canopy(stations, rings):
	# Splits the fuselage loft into the body, the fixed windscreen and the
	# canopy (facts.json layout.canopy, located on the reference photo). Each
	# station's glass spans the half-ring from the top centreline down to the
	# sill; ahead of the bow the windscreen's lower edge rises to the
	# centreline at its front base. The canopy carries its bow (its first
	# BOW_FRAME inches) and its sill rail (the lowest column of the glass) in
	# paint. The rings at the bow and the aft end lean as the photos show
	# (leaned()), so both edges run from their top to the sill's ends.
	layout = LAYOUT["canopy"]
	front, bow, back = layout["windscreen"]["station"], layout["bow"]["station"], layout["aft"]["station"]
	half = len(ANGLES)
	n = len(rings[0])

	def angle_of(j):
		return j if j < half else 2 * half - 2 - j

	def sill_index(r):
		# How many half-ring columns from the top are glass at this ring
		station = stations[r]
		if station < front - 0.01 or station > back + 0.01:
			return 0
		return SILL

	limits = [sill_index(r) for r in range(len(rings))]
	vertices, faces = loft(rings)
	groups = {"body": [], "windscreen": [], "canopy": []}
	for k, face in enumerate(faces):
		r, i = divmod(k, n)
		if r >= len(rings) - 1:
			groups["body"].append((face, "paint"))
			continue
		limit = min(limits[r], limits[r + 1])
		columns = (angle_of(i), angle_of((i + 1) % n))
		if max(columns) > limit or limit == 0:
			groups["body"].append((face, "paint"))
			continue
		station = (stations[r] + stations[r + 1]) / 2
		if station < bow:
			groups["windscreen"].append((face, "glass"))
		else:
			frame = station < bow + BOW_FRAME or max(columns) == limit
			groups["canopy"].append((face, "paint" if frame else "glass"))

	def mesh(entries):
		used = sorted({i for face, _ in entries for i in face})
		index = {old: new for new, old in enumerate(used)}
		return [vertices[i] for i in used], [tuple(index[i] for i in face) for face, _ in entries], [m for _, m in entries]

	# split into triangles here, each quad across its shorter diagonal, so the
	# panels cut from the skin (cut()) and the skin as exported share them: a
	# twisted quad split the other way stands up to half an inch off
	vertices_, faces_, materials_ = mesh(groups["body"])
	split, kinds = [], []
	for face, kind in zip(faces_, materials_):
		if len(face) == 4:
			a, b, c, d = face
			pieces = [(a, b, c), (a, c, d)] if (vertices_[a] - vertices_[c]).length <= (vertices_[b] - vertices_[d]).length else [(a, b, d), (b, c, d)]
		else:
			pieces = [face]
		split += pieces
		kinds += [kind] * len(pieces)
	node("fuselage", mesh=(vertices_, split, kinds))
	node("windscreen", mesh=mesh(groups["windscreen"]))
	# The canopy slides 1.5 in aft to unlatch (NATOPS 2.15.1), then swings up
	# about its aft hinge. The opening angle is provisional until the canopy-
	# open photos of BuNo 165221 are matched.
	hinge = at(back + 1.0, layout["aft"]["waterline"] - 4.0, 0)
	node("canopy_slide", hinge=hinge)
	joint("canopy_slide", AFT, AFT, AFT, "canopy", [[0, 0], [0.08, 1.5 * INCH], [1, 1.5 * INCH]], motion="slide")
	node("canopy", parent="canopy_slide", hinge=hinge, mesh=mesh(groups["canopy"]))
	joint("canopy", PORT, FORWARD, UP, "canopy", [[0, 0], [0.08, 0], [1, math.radians(45)]])
	# Features: the frame's corners and the sill on each side (the column
	# SILL steps down from the top; the port half runs back up the ring)
	index = {round(st, 1): r for r, st in enumerate(stations)}
	column = lambda r, side: rings[r][SILL] if side > 0 else rings[r][n - SILL]
	MARKS["windscreen_base"] = (rings[index[round(front, 1)]][0], "windscreen")
	MARKS["bow_top"] = (rings[index[round(bow, 1)]][0], "canopy")
	MARKS["canopy_aft"] = (rings[index[round(back, 1)]][0], "canopy")
	MARKS["canopy_crown"] = (max((rings[r][0] for r in range(len(rings)) if bow <= stations[r] <= back), key=lambda v: v.z), "canopy")
	glass = [r for r, st in enumerate(stations) if bow <= st <= back]
	screen = [r for r, st in enumerate(stations) if front <= st <= bow]
	for side in (-1, 1):
		name = side_name(side)
		MARKS[f"bow_foot_{name}"] = (column(index[round(bow, 1)], side), "canopy")
		MARKS[f"sill_aft_{name}"] = (column(glass[-1], side), "canopy")
		CURVES[f"canopy_sill_{name}"] = ([column(r, side) for r in glass], "canopy")
		CURVES[f"windscreen_sill_{name}"] = ([column(r, side) for r in screen], "windscreen")
	CURVES["canopy_top"] = ([rings[r][0] for r in glass], "canopy")


ANGLES = [math.pi * i / 47 for i in range(48)]   # each half-ring, top centreline (0) to keel (pi)
SILL = 16   # the half-ring's column on the canopy's sill: SILL steps above it, the rest below


def sill_point(station):
	# The canopy's sill (facts.json layout.canopy: [FS, WL, BL] from the bow's
	# foot to the canopy's aft lower corner) along the stations, held past its
	# ends, as (buttline, waterline)
	layout = LAYOUT["canopy"]
	sill = layout["sill"]
	waterlines = [(layout["bow"]["station"], layout["bow"]["foot"])] + [(p[0], p[1]) for p in sill]
	return between([(p[0], p[2]) for p in sill], station), between(waterlines, station)


def angles_at(station, centre):
	# The half-ring's angles: SILL even steps from the top down to the sill's
	# angle, and even steps on to the keel, so one column runs on the sill
	b, w = sill_point(station)
	sill = math.atan2(b, w - centre[1])
	# Ahead of the bow the column follows the windscreen's lower edge, which
	# rises to the centreline at its front base; ahead of that it eases back
	layout = LAYOUT["canopy"]
	front, bow = layout["windscreen"]["station"], layout["bow"]["station"]
	least = 0.03
	if front <= station < bow:
		sill = max(least, sill * (station - front) / (bow - front))
	elif front - 12 < station < front:
		f = (front - station) / 12
		sill = least + (sill - least) * f * f * (3 - 2 * f)
	upper = [sill * i / SILL for i in range(SILL)]
	lower = [sill + (math.pi - sill) * i / (len(ANGLES) - 1 - SILL) for i in range(len(ANGLES) - SILL)]
	# Behind the forebody the steps below the sill run evenly along the rear
	# fuselage's outline instead: even angles would leave a nacelle's top,
	# nearly level with the centre, between two steps, and the ring's chord
	# across it inches under it. Ahead of JOIN they follow the outline at
	# JOIN, eased in from BLEND's end, so the columns stay put where the
	# nacelles join
	weight = ease((station - BLEND[1]) / (JOIN - BLEND[1]))
	if weight > 0:
		even = spread(max(station, JOIN), sill, len(lower))
		lower = [(1 - weight) * a + weight * b for a, b in zip(lower, even)]
	return upper + lower


DENSE = [math.pi * i / 900 for i in range(901)]   # angles for the outline spread() measures along
OUTLINES = {}


def outline(station, start):
	# The rear fuselage's outline at a station, densely, from the angle
	# `start` round its centre to the keel: (angles, points, the length along
	# it to each)
	key = round(station, 4)
	if key not in OUTLINES:
		OUTLINES[key] = np.array(union_ring(station, DENSE)[1])
	points, theta = OUTLINES[key], np.array(DENSE)
	keep = theta > start
	first = [np.interp(start, theta, points[:, 0]), np.interp(start, theta, points[:, 1])]
	angles = np.concatenate([[start], theta[keep]])
	path = np.vstack([first, points[keep]])
	length = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(path, axis=0).T))])
	return angles, path, length


def spread(station, start, count):
	# `count` angles from `start` to the keel round the rear fuselage's centre
	# at a station, evenly along its outline
	angles, _, length = outline(station, start)
	return [float(a) for a in np.interp(np.linspace(0.0, length[-1], count), length, angles)]


def along(station, start, count):
	# `count` points from `start` to the keel, evenly along the outline
	_, path, length = outline(station, start)
	return [(float(np.interp(d, length, path[:, 0])), float(np.interp(d, length, path[:, 1]))) for d in np.linspace(0.0, length[-1], count)]



BLEND = (357, 404)   # the traced forebody hands over to the rear fuselage's union between these stations
AFT_STATIONS = [412, 420, 435, 450, 470, 490, 510, 530, 550, 570, 590, 610, 630, 650, 670, 692]


def polar(points, centre, angles):
	# A half-outline (top to keel) resampled at the angles round centre: along
	# each ray, its farthest crossing
	out = []
	segments = list(zip(points, points[1:]))
	for theta in angles:
		d = (math.sin(theta), math.cos(theta))
		best = 0.0
		for (x0, y0), (x1, y1) in segments:
			ex, ey = x1 - x0, y1 - y0
			den = d[0] * ey - d[1] * ex
			if abs(den) < 1e-12:
				continue
			ox, oy = x0 - centre[0], y0 - centre[1]
			t = (ox * ey - oy * ex) / den
			u = (ox * d[1] - oy * d[0]) / den
			if -1e-9 <= u <= 1 + 1e-9 and t > best:
				best = t
		if theta in (0.0, math.pi) or best == 0.0:
			# the centreline: the outline's own end, which the ray may graze
			end = points[0] if theta < 1 else points[-1]
			best = max(best, abs(end[1] - centre[1]))
		out.append((centre[0] + d[0] * best, centre[1] + d[1] * best))
	return out


def beneath(starboard, bl):
	# The highest point of a half-ring (fuselage) above a buttline, or None
	best = None
	for (b0, w0), (b1, w1) in zip(starboard, starboard[1:]):
		if (b0 - bl) * (b1 - bl) <= 0 and b0 != b1:
			w = w0 + (w1 - w0) * (bl - b0) / (b1 - b0)
			best = w if best is None else max(best, w)
	return best


LEX_STATIONS = 48   # rings from the apex to the junction
# The LEX's upper surface across its span: how far it has fallen from its root
# toward its edge, as a share of the whole fall, at each share of the way out.
# Read off the traced TP-3111 sections at FS 296 and 357, which agree: nearly
# flat over its inner half, falling steeply only near the edge
LEX_FALL = [(0.0, 0.0), (0.25, 0.04), (0.44, 0.15), (0.5, 0.21), (0.67, 0.32), (0.78, 0.43), (0.83, 0.52), (0.89, 0.6), (0.94, 0.72), (1.0, 1.0)]
FAIRING = 60.0      # inches behind the junction the LEX takes to settle onto the wing root


def lex(side, widths):
	# The leading-edge extension: a thin blade off the body's side from its
	# apex to the LEX-wing junction, then a fairing behind the junction that
	# eases its upper surface down onto the nacelle's shoulder and the wing
	# root, so the LEX runs into the wing with no step. Its span is
	# TM-101724's at FS 253, 296 and 357, run between them and forward by
	# cr186938's graph; its root and edge stand where the traced TP-3111
	# sections put them above the keel; at the junction (tp3111, FS 404.05)
	# its edge meets the wing's leading edge. Spans and heights run on smooth
	# curves through those knots. Its upper surface never dips under what lies
	# beneath it (the fuselage, the wing), so the two never cross in a ragged
	# line where they run nearly level.
	name = side_name(side)
	wing = SURFACES[f"wing_{name}"]
	# The apex where the photos put it (layout.lex), cr186938's graph from FS
	# 220 aft (its first point, read near zero, would start the LEX 7 in early)
	start = LAYOUT["lex"]["apex"]
	apex = start["station"]
	graph = [(apex, 0.0)] + [tuple(k) for k in FACTS["lex"]["graph"]["value"] if k[0] >= 220]
	measured = {r["station"]: r["span"] for r in FACTS["lex"]["sections"]}
	ratio = [(s, span / smooth(graph, s)) for s, span in measured.items()]
	junction = value(FACTS["wing"]["junction"])
	reach = LAYOUT["surfaces"]["lef"]["inner"][0]   # the junction's buttline
	meet = ORIGIN["waterline"] + wing.point(reach, 0).z / INCH
	# Heights above the keel of the LEX's upper root and of its edge, read off
	# the traced sections at FS 253, 296 and 357 (views.py), and at the apex
	root_height = [(apex, start["waterline"] - profile("keel", apex)), (253, 42.6), (296, 43.0), (357, 42.7)]
	edge_height = [(253, 38.3), (296, 35.2), (357, 31.0), (junction, meet - profile("keel", junction))]

	def root_line(station):
		return profile("keel", min(station, junction)) + smooth(root_height, station)

	def wing_top(station, bl):
		# the inner wing's upper surface over a buttline, or None off its
		# chord; held at its root (BL 40) for 4 in inboard, so what settles
		# onto it covers the root's end above the nacelle
		if bl < 36:
			return None
		bl = max(bl, 40.0)
		leading, chord, _ = wing.station(bl)
		x = (station - (456 - leading.x / INCH)) / chord
		return ORIGIN["waterline"] + wing.point(bl, x, 1).z / INCH if 0 <= x <= 1 else None

	# The edge's buttline: the root's plus the span forward of FS 357, then on
	# to the junction's buttline
	knots = [(st, body_at(st, root_line(st)) + smooth(graph, st) * smooth(ratio, st)) for st in (apex, 205, 220, 240, 253, 270, 296, 320, 340, 357)]
	knots.append((junction, reach))
	stations = [apex + (junction - apex) * i / LEX_STATIONS for i in range(LEX_STATIONS + 1)]
	# Behind the junction a ring only where the fuselage beneath has one, on
	# to the last at or past the fairing's end: between its rings the fuselage
	# runs straight, so a ring between them, set over the section the rings
	# straddle, would lie off the skin the loft actually draws
	behind = [s for s in FUSELAGE_STATIONS if junction < s < junction + FAIRING]
	behind += [min(s for s in FUSELAGE_STATIONS if s >= junction + FAIRING)]
	across = 16
	# where the fairing lands on the fuselage (settled), and 2 in on
	land = junction + 0.85 * FAIRING
	_, landed = half_ring(land)
	_, beyond = half_ring(land + 2)
	rings, edges, tops, sections = [], [], [], []
	for station in stations + behind:
		keel = profile("keel", min(station, junction))
		# settled by 85% of the way: its last stretch lies on the surface
		f = max(0.0, min(1.0, (station - junction) / (0.85 * FAIRING)))
		e = f * f * (3 - 2 * f)
		if station <= junction:
			root = root_line(station)
			edge_bl = smooth(knots, station)
			edge = keel + smooth(edge_height, station)
			span = max(edge_bl - body_at(station, root), 0.0)
			if station < 253:
				edge = root - (root - (keel + smooth(edge_height, 253))) * span / measured[253]
			thickness = min(3.0, 0.2 * span + 0.2)
		else:
			# the outer side rides the inner wing just inboard of the junction
			edge_bl = reach - 5.0 * e
			edge = (wing_top(station, edge_bl) or meet) - 0.1 * e
			thickness = 3.0 * (1 - e) + 0.3 * e
		# behind the junction the root stays on the body's wall at the
		# junction's root height, wherever the root itself has settled
		body = body_at(station, root if station <= junction else root_line(junction)) - 1.0
		edge_bl = max(edge_bl, body + 1.0)
		_, starboard = half_ring(station)
		inlet = inlet_slice(station)

		def settle(bl):
			# what it settles toward over a buttline: the fuselage beneath it
			# once it has landed; ahead of that, the line the fuselage runs
			# along where it lands, so it comes down straight onto the skin's
			# slope. (Settling toward the skin station by station, it dived to
			# the nacelle's top at JOIN, 2.5 in below where it lands, and rose
			# again with the nacelle's shoulder: a trough across the fairing)
			if station >= land:
				return beneath(starboard, bl)
			w, ahead = beneath(landed, bl), beneath(beyond, bl)
			if w is None or ahead is None:
				return beneath(starboard, bl)
			return w + (station - land) * (ahead - w) / 2

		def under(bl):
			# the highest skin over a buttline: the fuselage's, or ahead of JOIN the inlet's
			found = [w for w in (beneath(starboard, bl), beneath(inlet, bl) if inlet else None) if w is not None]
			return max(found, default=None)

		clearance = 0.25
		if station > junction:
			# its root settles onto the fuselage beside the body's wall, and it
			# hugs what lies beneath ever closer, though never so close that
			# the skin's facets beneath stand through it
			floor = settle(body + 1.5)
			settled = (floor if floor is not None else edge) + 0.15
			root = root_line(junction) + (settled - root_line(junction)) * e
			clearance = 0.25 * (1 - e) + 0.15 * e
		top = []
		for k in range(across + 1):
			t = k / across
			bl = body + (edge_bl - body) * t
			# the blade's own upper surface: the traced sections' fall from root to edge
			wl = root + 0.5 - (root + 0.5 - edge) * smooth(LEX_FALL, t)
			if station > junction:
				# behind the junction it settles, once, onto what lies beneath, from
				# the blade with its root as it stands at the junction (the root
				# settling as well would settle it twice) and its edge riding the
				# wing; its first column, inside the body's wall, onto its settled root
				wl = root_line(junction) + 0.5 - (root_line(junction) + 0.5 - edge) * smooth(LEX_FALL, t)
				floor = settled if k == 0 else max([w for w in (settle(bl), wing_top(station, bl)) if w is not None], default=wl)
				wl = wl * (1 - e) + (floor + clearance) * e
			if 0 < k < across:
				floor = max([w for w in (under(bl), wing_top(station, bl)) if w is not None], default=None)
				if floor is not None and bl > body + 0.5:
					wl = max(wl, floor + clearance)
			top.append((bl, wl))
		if station > junction:
			top = lifted(top, [starboard] + ([inlet] if inlet else []), clearance)
		sections.append((station, top, thickness, body, root))
	for station, top, thickness, body, root in sections:
		bottom = [(bl, wl - thickness * (0.3 + 0.7 * 4 * t * (1 - t)) if 0 < k < across else wl) for k, ((bl, wl), t) in
			enumerate(zip(top, [k / across for k in range(across + 1)]))]
		bottom[0] = (body, root - thickness)
		points = top + list(reversed(bottom[1:-1])) + [bottom[0]]
		rings.append([at(station, h, side * b) for b, h in points])
		tops.append((station, top))
		if station <= junction:
			edges.append(at(station, top[-1][1], side * top[-1][0]))
	node(f"lex_{name}", mesh=loft(rings))
	MARKS[f"lex_apex_{name}"] = (rings[0][across], f"lex_{name}")
	CURVES[f"lex_edge_{name}"] = (edges, f"lex_{name}")
	fence(side, tops)


def lifted(top, skins, clearance):
	# The fairing's upper points (BL, WL), raised so the straight run between
	# each two of them, past its first, clears every corner of the skins
	# beneath (polylines of (BL, WL)) by the clearance, not just the skin under
	# the points themselves: a sharp corner between two points stands through
	# the run across it. Corners an inch or more above a run are a wall it
	# meets, not a skin it lies on
	out = list(top)
	for _ in range(3):
		for k in range(1, len(out) - 2):
			(b0, w0), (b1, w1) = out[k], out[k + 1]
			short = max([w + clearance - (w0 + (w1 - w0) * (b - b0) / (b1 - b0)) for skin in skins for b, w in skin if b0 < b < b1], default=0.0)
			if 0 < short < 1.0:
				out[k], out[k + 1] = (b0, w0 + short), (b1, w1 + short)
	return out


def fence(side, tops):
	# The LEX fence: a plate standing on tp3111's base line (lex.fence: FS
	# 378.17 to 410.33 at BL 42) up to the top corners the photos measure
	# (layout.lex), leaning outboard as the fleet fence does
	name = side_name(side)
	base = FACTS["lex"]["fence"]["value"]

	def surface(station, bl):
		# the LEX's upper surface over a station and buttline
		for (s0, t0), (s1, t1) in zip(tops, tops[1:]):
			if s0 <= station <= s1:
				f = (station - s0) / (s1 - s0)
				return between(t0, bl) * (1 - f) + between(t1, bl) * f
		raise ValueError(f"FS {station} is off the LEX")

	low = [(st, surface(st, base["buttline"]) - 0.3, base["buttline"]) for st in (base["leading"], base["trailing"])]
	top = [tuple(LAYOUT["lex"]["fence"][k]) for k in ("front", "aft")]
	corners = [at(s_, w, side * b) for s_, w, b in (low[0], low[1], top[1], top[0])]
	# 0.25 in thick, centred on the plate (a cross product's side flips in the mirror)
	normal = (corners[1] - corners[0]).cross(corners[3] - corners[0]).normalized() * (0.125 * INCH)
	vertices = [c - normal for c in corners] + [c + normal for c in corners]
	faces = [(0, 1, 2, 3), (7, 6, 5, 4), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)]
	node(f"lex_fence_{name}", mesh=(vertices, faces))
	MARKS[f"lex_fence_top_front_{name}"] = (corners[3], f"lex_fence_{name}")
	MARKS[f"lex_fence_top_aft_{name}"] = (corners[2], f"lex_fence_{name}")


def exit_distance(centre, half, exponent, origin, direction, reach=120.0):
	# How far along a ray from origin a superellipse (|dx/a|^n + |dy/b|^n <= 1)
	# extends: the farthest inside point, 0 if the ray misses it. half is (a,
	# b), or (a, b above the centre, b below it)
	t = np.linspace(0.0, reach, 961)
	x = origin[0] + direction[0] * t - centre[0]
	y = origin[1] + direction[1] * t - centre[1]
	b = np.where(y > 0, half[1], half[-1])
	inside = np.abs(x / half[0]) ** exponent + np.abs(y / b) ** exponent <= 1.0
	if not inside.any():
		return 0.0
	return float(t[np.nonzero(inside)[0][-1]])


def engine_buttline(station):
	# The engine axes: 2.33 ft either side at the aerodynamic reference centre,
	# converging aft at 2 deg (facts.json engine)
	e = FACTS["engine"]
	return value(e["buttline"]) * 12 - (station - value(FACTS["reference"]["station"])) * math.tan(math.radians(value(e["angle"])))


# The rear fuselage's parts along the stations, inches (provisional: fitted
# to the HATP views and the reference photo dvids9820808, verify/photos.py): the
# central body's top, bottom and half-width, and each nacelle's centre
# buttline and waterline, half-width and half-height above its centre. A
# nacelle starts at the inlet's mouth (MOUTH, layout.inlet), rises behind it
# to meet the wing root by FS 445 (the HATP fit's section there, which
# nothing measures yet), runs aft and inboard onto the engine axis by the
# engine face, and ends at the nozzles: these are its knots from FS 445.
# Below its centre it reaches down to layout.nacelle's line (nacelle_bottom()).
CORE = {
	"top": [(357, 151.3), (405, 150.0), (450, 148.4), (500, 145.6), (540, 140.9), (570, 135), (600, 130), (650, 127), (692, 124)],
	"bottom": [(357, 84.2), (420, 83.5), (500, 84), (560, 85), (620, 88), (692, 93)],
	"half": [(357, 23.2), (404, 24), (450, 22), (550, 20), (650, 17), (692, 12)],
}
NACELLE = [(445, 30.3, 103.3, 15.3, 16.5), (470, None, 104.5, 17.5, 17.5), (520, None, 105.5, 19.5, 18.5), (580, None, 106.0, 21.0, 19.0), (640, None, 106.0, 20.0, 18.5), (692, None, 106.0, 18.5, 17.5)]
NOZZLE = LAYOUT["nozzle"]   # the outer flaps' start and exit, their radii, and the axis's waterline
# The fuselage station where each inlet's outer skin hands over to the rear
# fuselage's nacelle, behind the plug that closes the duct
JOIN = 440.0


def union_ring(station, angles=None):
	# The rear fuselage at a station: the smooth union of the central body and
	# the two nacelles, sampled at ANGLES round the central body's mid-height.
	# The nacelles join it whole at JOIN: ahead of that the inlets' own outer
	# skins (inlets()) stand in for them, and the fuselage's ring jumps out to
	# the nacelles between its last station ahead of JOIN and JOIN itself,
	# inside them, behind the plug
	top, bottom, half = (smooth(CORE[k], station) for k in ("top", "bottom", "half"))
	centre = (0.0, (top + bottom) / 2)
	parts = [((0.0, centre[1]), (half, (top - bottom) / 2), 2.6)]
	if station >= JOIN - 1e-6:
		b, w, a, up, down = nacelle_at(station)
		for side in (1, -1):
			parts.append(((side * b, w), (a, up, down), 2.3))
	ring = []
	default = angles is None
	for theta in angles or angles_at(station, centre):
		direction = (math.sin(theta), math.cos(theta))
		reaches = [exit_distance(c, h, n, centre, direction) for c, h, n in parts]
		r = sum(x ** 10 for x in reaches) ** 0.1
		ring.append((centre[0] + direction[0] * r, centre[1] + direction[1] * r))
	if default and station >= JOIN - 1e-6:
		# from JOIN aft the steps below the sill are points evenly along the
		# outline itself, its leaps included: where the centre cannot see into
		# a hollow (the tunnel between the nacelles, beside the body's wall
		# under a nacelle's crown) the outline leaps between two rays, and a
		# point cast at an angle near one lands on one side or the other from
		# station to station, twisting the loft's facets
		ring = ring[:SILL] + along(station, angles_at(station, centre)[SILL], len(ring) - SILL)
	return centre, ring


def mouth_box():
	# The box round the mouth's outer surface: centre buttline and waterline,
	# half-width and half-height
	if "front" not in MOUTH:
		ring = np.array([(b, w) for _, w, b in mouth_ring(0, 0)])
		low, high = ring.min(axis=0), ring.max(axis=0)
		MOUTH["front"] = ((low[0] + high[0]) / 2, (low[1] + high[1]) / 2, (high[0] - low[0]) / 2, (high[1] - low[1]) / 2)
	return MOUTH["front"]


def nacelle_bottom(station):
	# layout.nacelle: the nacelle's lowest line, from the lip's bottom down onto
	# the HATP side view's keel line and along it, then on to the nozzles, on a
	# monotone cubic through the knots
	n = LAYOUT["nacelle"]
	b, w, a, h = mouth_box()
	low, high = n["keel"]
	knots = [(LAYOUT["inlet"]["lip"]["bottom"][0], w - h)]
	knots += [(float(s), profile("keel", s)) for s in range(int(low), int(high) + 1, 4)]
	knots += [tuple(k) for k in n["aft"]]
	return smooth(knots, station)


def nacelle_at(station):
	# From the mouth, whose outer surface's box starts it, then NACELLE's
	# knots on monotone cubics, and below the centre down to its own line.
	# Returns (centre buttline, centre waterline, half-width, half-height above
	# the centre, below it)
	b0, w0, a0, h0 = mouth_box()
	knots = [(MOUTH["station"], b0, w0, a0, h0)]
	knots += [(s, b if b is not None else engine_buttline(s), w, a, h) for s, b, w, a, h in NACELLE]
	b, w, a, up = (smooth([(k[0], k[i]) for k in knots], station) for i in (1, 2, 3, 4))
	return b, w, a, up, w - nacelle_bottom(station)


MOUTH_SIDES = 80   # points round the inlet's mouth, from its top outboard and round: at 40 the rings'
# chords cut 0.2 in inside the fuselage's outline where the two meet
PLUG = 15   # inches down each inlet's duct to the plug that closes it


def mouth():
	# The inlet's mouth (layout.inlet, the photo match): a D whose flat side is
	# inboard, facing the splitter plate. Its lip's front edge follows the
	# traced outline from the top corner round the outside to the bottom
	# corner, then the flat side back up; the lip lies in the plane that fits
	# its five measured points (it is raked): FS = plane[0] + plane[1] WL +
	# plane[2] BL
	inlet = LAYOUT["inlet"]
	lip = inlet["lip"]
	points = np.array([lip[k] for k in ("top", "bottom", "outer", "corner_top", "corner_bottom")], float)
	plane = np.linalg.lstsq(np.c_[np.ones(len(points)), points[:, 1], points[:, 2]], points[:, 0], rcond=None)[0]
	edge = [lip["corner_top"][1:]] + inlet["outline"] + [lip["corner_bottom"][1:]]
	# (BL, WL): the centre, and the front edge as a closed polygon
	return {"plane": plane, "centre": points[:, [2, 1]].mean(0), "edge": np.array(edge, float)[:, ::-1],
		"wall": inlet["wall"], "station": float(points[:, 0].min())}


MOUTH = mouth()


def reach(direction):
	# How far the lip's front edge lies from the mouth's centre along a
	# direction (BL, WL)
	c, poly = MOUTH["centre"], MOUTH["edge"]
	for a, b in zip(poly, np.roll(poly, -1, axis=0)):
		matrix = np.array([direction, a - b]).T
		if abs(np.linalg.det(matrix)) < 1e-12:
			continue
		r, s = np.linalg.solve(matrix, a - c)
		if r > 0 and -1e-9 <= s <= 1 + 1e-9:
			return float(r)
	raise ValueError(f"no lip along {direction}")


def mouth_ring(depth, inset):
	# The mouth's outline, `depth` inches aft of the lip's plane and `inset`
	# inches inside its outer surface (which stands half the wall outside the
	# front edge): (FS, WL, BL outboard) round from the top, outboard first
	m = MOUTH
	out = []
	for i in range(MOUTH_SIDES):
		t = 2 * math.pi * i / MOUTH_SIDES
		direction = np.array([math.sin(t), math.cos(t)])
		r = reach(direction) + m["wall"] / 2 - inset
		bl, wl = m["centre"] + direction * r
		out.append((m["plane"][0] + m["plane"][1] * wl + m["plane"][2] * bl + depth, float(wl), float(bl)))
	return out


# The inlet's outer surface behind the lip: rings at these depths aft of the
# lip's plane, then one at JOIN. It rides the nacelle as it grows behind the
# mouth (target()), carrying the mouth's D as it stands off the nacelle at the
# lip, that difference fading out by JOIN (outer_blend()), where the skin
# meets the fuselage ring on ring and on its slope
INLET_OUTER = [1.2, 4, 7, 10, 13, 16, 19, 22, 24.5]
# Inches past the nacelle's own section the joint ring may reach: far enough
# for the fuselage's outline where it bridges from the nacelle to the body
# (up to 1.4 in out at the inboard bottom corner; at 1 in the fuselage stands
# out beside the inlet's end, shape.joint), short of the belly beyond, so
# toward the body it stops inside it (uncapped, the inlet's skin crosses the
# fuselage's underside, shape.seam). Stopping on the nacelle's own section
# wherever the ray leaves through the body cuts inside that corner instead
CAP = 4.0


def first_exit(origin, direction, polygon):
	# How far along a ray from inside a closed polygon it first crosses it, or None
	a = np.asarray(polygon, float)
	e = np.roll(a, -1, axis=0) - a
	o, d = np.asarray(origin, float), np.asarray(direction, float)
	cross = d[0] * e[:, 1] - d[1] * e[:, 0]
	q = a - o
	with np.errstate(divide="ignore", invalid="ignore"):
		r = (q[:, 0] * e[:, 1] - q[:, 1] * e[:, 0]) / cross
		t = (q[:, 0] * d[1] - q[:, 1] * d[0]) / cross
	hits = r[(np.abs(cross) > 1e-12) & (r > 1e-9) & (t >= -1e-9) & (t <= 1 + 1e-9)]
	return float(hits.min()) if len(hits) else None


def joint_ring():
	# The rear fuselage's outline at JOIN round the nacelle's centre, along the
	# mouth's directions, as (WL, BL outboard): where the nacelle is the
	# outside, the outline itself (its leaps across hollows included), so the
	# inlet's skin meets the fuselage ring on ring; toward the body, CAP past
	# the nacelle's own section, where the body lies over it
	if "join" not in MOUTH:
		b, w, a, up, down = nacelle_at(JOIN)
		# the outline itself, densely, which the fuselage's ring points stand on
		half = union_ring(JOIN, DENSE)[1]
		out = []
		for i in range(MOUTH_SIDES):
			t = 2 * math.pi * i / MOUTH_SIDES
			d = (math.sin(t), math.cos(t))
			own = exit_distance((b, w), (a, up, down), 2.3, (b, w), d)
			r = first_exit((b, w), d, half)
			r = own + CAP if r is None else min(r, own + CAP)
			out.append((w + d[1] * r, b + d[0] * r))
		MOUTH["join"] = out
	return MOUTH["join"]


def outer_blend(depth):
	# The share of the way the mouth's D has handed over to the target at a
	# depth: none at the lip, all of it at JOIN, level at both ends
	return ease((depth - INLET_OUTER[0]) / (JOIN - MOUTH["station"] - INLET_OUTER[0]))


def target(station):
	# What the inlet's skin eases toward at a station, as (WL, BL outboard)
	# round the mouth: the joint ring, moved by as much as the nacelle's own
	# section there lies from where it lies at JOIN along each direction, so
	# the skin arrives at JOIN on the nacelle's slope. (The fuselage's whole
	# outline taken station by station instead would jump where a direction
	# passes from the tunnel's leap to inside the body)
	key = round(station * 4) / 4
	cache = MOUTH.setdefault("targets", {})
	if key not in cache:

		def section(s):
			b, w, a, up, down = nacelle_at(s)
			out = []
			for i in range(MOUTH_SIDES):
				d = (math.sin(2 * math.pi * i / MOUTH_SIDES), math.cos(2 * math.pi * i / MOUTH_SIDES))
				r = exit_distance((b, w), (a, up, down), 2.3, (b, w), d)
				out.append((w + d[1] * r, b + d[0] * r))
			return out

		if "joined" not in MOUTH:
			MOUTH["joined"] = section(JOIN)
		cache[key] = [(jw + w - w0, jb + b - b0) for (jw, jb), (w, b), (w0, b0) in zip(joint_ring(), section(key), MOUTH["joined"])]
	return cache[key]


def inlet_ring(depth, inset, blend=0.0):
	# One ring of the inlet, (FS, WL, BL outboard): the target at its station,
	# carrying the mouth's outline (at a depth and inset) as it stands off the
	# target at the lip, that standing-off fading by `blend`, so where the D
	# and the target agree (the bottom) the skin follows the target from the
	# lip on; the rake fades by the same share, square at JOIN
	d = mouth_ring(depth, inset)
	if blend <= 0:
		return d
	station = MOUTH["station"] + depth
	return [(s_ * (1 - blend) + station * blend, tw + (w - lw) * (1 - blend), tb + (b - lb) * (1 - blend))
		for (s_, w, b), (tw, tb), (lw, lb) in zip(d, target(station), target(MOUTH["station"]))]


def inlet_slice(station):
	# The inlet's outer skin cut across a station, as a closed list of (BL
	# outboard, WL) round the mouth; [] off it. Each point of the mouth runs aft
	# along its own line, raked at the lip and square at JOIN, so each finds its
	# own depth at the station
	end = JOIN - MOUTH["station"]
	if station < MOUTH["station"] or station > JOIN:
		return []
	out = []
	lip = target(MOUTH["station"])
	for i, (s0, w, b) in enumerate(mouth_ring(0, 0)):
		depth = station - s0
		for _ in range(8):
			depth = station - s0 + outer_blend(depth) * (s0 - MOUTH["station"])
		depth = min(max(depth, INLET_OUTER[0]), end)
		f = outer_blend(depth)
		tw, tb = target(MOUTH["station"] + depth)[i]
		out.append((tb + (b - lip[i][1]) * (1 - f), tw + (w - lip[i][0]) * (1 - f)))
	return out + out[:1]


def inlets():
	# Each inlet: an open duct from the lip aft into the nacelle, its lip
	# rounded, its interior closed by a plug 15 in down the duct; behind the
	# lip its outer surface eases from the mouth's D into the rear fuselage at
	# JOIN, where the fuselage's nacelle takes over
	wall = MOUTH["wall"]
	for side in (-1, 1):
		name = side_name(side)

		def ring(depth, inset, blend=0.0):
			return [at(s_, w, side * b) for s_, w, b in inlet_ring(depth, inset, blend)]

		rings = [ring(PLUG, wall), ring(6, wall), ring(1.2, wall), ring(-0.4, wall / 2), ring(1.2, 0)]
		rings += [ring(depth, 0, outer_blend(depth)) for depth in INLET_OUTER[1:] + [JOIN - MOUTH["station"]]]
		node(f"inlet_{name}", mesh=loft(rings))
		outer = mouth_ring(0, 0)
		lip = LAYOUT["inlet"]["lip"]

		def nearest(key):
			# the lip's outer side, in the lip's plane, nearest a measured point in its WL and BL
			target = lip[key]
			s_, w, b = min(outer, key=lambda p: (p[1] - target[1]) ** 2 + (p[2] - target[2]) ** 2)
			return at(s_, w, side * b)

		for key in ("top", "bottom", "outer"):
			MARKS[f"inlet_lip_{key}_{name}"] = (nearest(key), f"inlet_{name}")
		for key in ("top", "bottom"):
			MARKS[f"inlet_corner_{key}_{name}"] = (nearest(f"corner_{key}"), f"inlet_{name}")
		edge = ring(-0.4, wall / 2)
		CURVES[f"inlet_lip_{name}"] = (edge + edge[:1], f"inlet_{name}")
		splitter(side)


def splitter(side):
	# The splitter plate: a thin plate standing off the fuselage beside the
	# inlet's flat side, its leading edge the measured curve
	# (layout.inlet.splitter, bowing outboard at mid-height), running aft past
	# the lip into the duct's inner wall
	name = side_name(side)
	s = LAYOUT["inlet"]["splitter"]
	edge = np.array(s["edge"], float)
	thickness = s["thickness"]
	rows = []
	for w in np.linspace(edge[0, 1], edge[-1, 1], 13):
		s_, b = (np.interp(w, edge[::-1, 1], edge[::-1, k]) for k in (0, 2))
		lip = MOUTH["plane"][0] + MOUTH["plane"][1] * w + MOUTH["plane"][2] * b
		aft = lip + s["past"]
		rows.append([(s_, w, b), (aft, w, b), (aft, w, b - thickness), (s_ + thickness, w, b - thickness)])
	vertices = [at(s_, w, side * b) for row in rows for s_, w, b in row]
	faces = []
	for k in range(len(rows) - 1):
		a, c = 4 * k, 4 * (k + 1)
		faces += [(a + i, a + (i + 1) % 4, c + (i + 1) % 4, c + i) for i in range(4)]
	last = 4 * (len(rows) - 1)
	faces += [(3, 2, 1, 0), (last, last + 1, last + 2, last + 3)]
	node(f"splitter_{name}", mesh=(vertices, faces))
	MARKS[f"splitter_top_{name}"] = (vertices[0], f"splitter_{name}")
	MARKS[f"splitter_bottom_{name}"] = (vertices[4 * (len(rows) - 1)], f"splitter_{name}")
	CURVES[f"splitter_{name}"] = ([vertices[4 * k] for k in range(len(rows))], f"splitter_{name}")


def cylinder(p0, p1, r0, r1=None, sides=12):
	# A closed tube from p0 to p1, radius r0 tapering to r1
	r1 = r0 if r1 is None else r1
	axis = (p1 - p0).normalized()
	u = axis.orthogonal().normalized()
	v = axis.cross(u)
	rings = [[p + (u * math.cos(2 * math.pi * i / sides) + v * math.sin(2 * math.pi * i / sides)) * (r * INCH) for i in range(sides)]
		for p, r in ((p0, r0), (p1, r1))]
	return loft(rings)


def pod(front, back, radius, sides=14):
	# A streamlined body of revolution, pointed at `front`, blunt at `back`,
	# `radius` inches at its widest
	axis = back - front
	u = axis.normalized().orthogonal().normalized()
	v = axis.normalized().cross(u)
	profile = [(0.0, 0.05), (0.1, 0.45), (0.22, 0.75), (0.35, 0.95), (0.5, 1.0), (0.85, 1.0), (0.95, 0.8), (1.0, 0.35)]
	rings = [[front + axis * t + (u * math.cos(2 * math.pi * i / sides) + v * math.sin(2 * math.pi * i / sides)) * (radius * r * INCH)
		for i in range(sides)] for t, r in profile]
	return loft(rings)


def tyre(centre, axis, radius, width, hub=0.55, sides=28):
	# A tyre and wheel: a rounded tread round the axis, its sidewalls
	# dished in to the hub
	axis = axis.normalized()
	u = axis.orthogonal().normalized()
	v = axis.cross(u)
	r, w = radius * INCH, width * INCH / 2
	profile = [(r * hub, -w * 0.7), (r * 0.82, -w), (r * 0.97, -w * 0.9), (r, -w * 0.5), (r, w * 0.5), (r * 0.97, w * 0.9),
		(r * 0.82, w), (r * hub, w * 0.7)]
	rings = []
	for i in range(sides):
		a = 2 * math.pi * i / sides
		radial = u * math.cos(a) + v * math.sin(a)
		rings.append([centre + radial * d + axis * z for d, z in profile])
	# a closed torus: loft round the circle, then close the seam
	vertices = [p for ring in rings for p in ring]
	n = len(profile)
	faces = []
	for i in range(sides):
		a, b = i * n, ((i + 1) % sides) * n
		faces += [(a + j, a + j + 1, b + j + 1, b + j) for j in range(n - 1)]
		faces.append((a + n - 1, a, b, b + n - 1))
	return vertices, faces


def plate(corner, along, across, thickness):
	# A thin box on a corner and two edges, its thickness centred on them (a
	# cross product's side flips in the mirror, so a one-sided plate would not)
	normal = along.cross(across).normalized() * (thickness * INCH / 2)
	p = [corner, corner + along, corner + along + across, corner + across]
	vertices = [q - normal for q in p] + [q + normal for q in p]
	faces = [(0, 1, 2, 3), (7, 6, 5, 4), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)]
	return vertices, faces


def chain(joints):
	# Rest frames for a chain of joints given in the extended pose, root
	# first: (hinge, axis, angle) each. The rest pose is every joint at zero,
	# so a part under the k-th joint rests at chain[k][2] @ its extended
	# position, and the k-th joint's own hinge and axis at rest are
	# chain[k][0] and chain[k][1].
	undo = Matrix.Identity(4)
	out = []
	for hinge, axis, angle in joints:
		hinge = undo @ hinge
		axis = (undo.to_3x3() @ axis).normalized()
		turn = Matrix.Translation(hinge) @ Matrix.Rotation(angle, 4, axis) @ Matrix.Translation(-hinge)
		undo = turn.inverted() @ undo
		out.append((hinge, axis, undo.copy()))
	return out


def rested(mesh, undo):
	return [undo @ v for v in mesh[0]], mesh[1]


def built(names):
	# A ray-cast tree over built nodes' meshes, at rest in the model frame
	vertices, polygons = [], []
	for name in names:
		base = len(vertices)
		vertices += [v.co + HINGES[name] for v in NODES[name].data.vertices]
		polygons += [[base + i for i in p.vertices] for p in NODES[name].data.polygons]
	return BVHTree.FromPolygons(vertices, polygons)


def crossings(tree, start, direction):
	# How far along a ray from `start` (model frame) it crosses the tree's
	# surfaces, in inches
	out, travelled, point = [], 0.0, start.copy()
	while True:
		hit = tree.ray_cast(point, direction)[0]
		if hit is None:
			return out
		travelled += (hit - point).length
		out.append(travelled / INCH)
		point = hit + direction * 1e-5
		travelled += 1e-5


def gear():
	# The landing gear, built extended on the measured axles (facts.json
	# layout.gear: the photos put them level, so the jet sits a little nose
	# down on its smaller nose tyres) and stored stowed, as the contract rests
	# it. Trunnions, strut rake and the doors are provisional until the gear
	# close-ups (dvids8678626, dvids8678628) are matched. NATOPS 2.10.1 has the
	# main gear retract aft into the fuselage and the nose gear forward; the
	# stowed poses are chosen to lie inside the skin (check.py, shape.stowed).
	g = LAYOUT["gear"]
	main_r, nose_r = g["tyres"]["main"]["diameter"] / 2, g["tyres"]["nose"]["diameter"] / 2
	offset = g["spacing"] / 2   # each nose wheel's centre off the centreline
	down = [[0, 0], [1, 1]]
	for side in (-1, 1):
		name = side_name(side)
		leg = f"gear_{name}"
		axle = at(g["main"], g["axles"]["main"], side * g["track"] / 2)
		foot = at(g["main"] + 1, g["axles"]["main"] + 2, side * (g["track"] / 2 - 8))
		trunnion = at(g["main"] - 4, 99, side * 38)
		extended = (foot - trunnion).normalized()
		# stowed aft, 19 deg inboard and 3 deg up: the most room round the
		# strut and wheel inside the nacelle, the wheel within 14 deg of flat
		inboard, up = math.radians(19), math.radians(3)
		stowed = Vector((-math.cos(up) * math.cos(inboard), side * math.cos(up) * math.sin(inboard), math.sin(up)))
		swing = math.acos(max(-1.0, min(1.0, stowed.dot(extended))))
		axis = stowed.cross(extended).normalized()
		# strut swing, then a quarter turn about the strut that stands the
		# wheel up from lying flat in the nacelle, each side the mirror of the other
		frames = chain([(trunnion, axis, swing), (trunnion, -side * extended, math.pi / 2)])
		strut_undo, twist_undo = frames[0][2], frames[1][2]
		node(f"{leg}_strut", hinge=trunnion, mesh=rested(merge([cylinder(trunnion, trunnion.lerp(foot, 0.62), 3.4),
			plate(trunnion + Vector((0.08, 0, 0)) + Vector((0, -side * 0.12, 0)), (foot - trunnion) * 0.7, Vector((-0.38, 0, 0)), 0.4)]), strut_undo))
		joint(f"{leg}_strut", frames[0][1], AFT, extended, "gear", [[0, 0], [1, swing]])
		node(f"{leg}_twist", parent=f"{leg}_strut", hinge=frames[1][0])
		joint(f"{leg}_twist", frames[1][1], Vector((0, 0, 1)), Vector((0, 0, 1)), "gear", [[0, 0], [1, math.pi / 2]])
		node(f"{leg}_oleo", parent=f"{leg}_twist", hinge=frames[1][0],
			mesh=rested(merge([cylinder(trunnion.lerp(foot, 0.5), foot, 2.5), cylinder(foot, axle, 2.2, 2.0)]), twist_undo))
		joint(f"{leg}_oleo", twist_undo.to_3x3() @ -extended, -extended, -extended, f"oleo.{name}", down, motion="slide")
		wheel_axis = Vector((0, -side, 0))
		node(f"{leg}_wheel", parent=f"{leg}_oleo", hinge=twist_undo @ axle, mesh=rested(tyre(axle, wheel_axis, main_r, g["tyres"]["main"]["width"]), twist_undo))
		# the hub's outer face, where a photo shows the wheel's centre
		MARKS[f"axle_main_{name}"] = (twist_undo @ (axle + wheel_axis * (g["tyres"]["main"]["width"] * 0.35 * INCH)), f"{leg}_wheel")
		# its centre, where a head-on photo shows the middle of the tyre
		MARKS[f"wheel_main_{name}"] = (twist_undo @ axle, f"{leg}_wheel")
		joint(f"{leg}_wheel", twist_undo.to_3x3() @ wheel_axis, Vector((0, 0, -1)), FORWARD, f"wheel.{name}", IDENTITY)
	# The nose leg retracts forward; twin wheels; the launch bar on the strut
	axle = at(g["nose"], g["axles"]["nose"], 0)
	trunnion = at(g["nose"] + 12, 100, 0)
	extended = (axle - trunnion).normalized()
	swing = math.acos(max(-1.0, min(1.0, FORWARD.dot(extended))))
	axis = FORWARD.cross(extended).normalized()
	frames = chain([(trunnion, axis, swing)])
	undo = frames[0][2]
	node("gear_nose_strut", hinge=trunnion, mesh=rested(cylinder(trunnion, trunnion.lerp(axle, 0.6), 3.0), undo))
	joint("gear_nose_strut", frames[0][1], FORWARD, extended, "gear", [[0, 0], [1, swing]])
	node("gear_nose_oleo", parent="gear_nose_strut", hinge=trunnion, mesh=rested(cylinder(trunnion.lerp(axle, 0.5), axle, 2.2), undo))
	joint("gear_nose_oleo", undo.to_3x3() @ -extended, -extended, -extended, "oleo.nose", down, motion="slide")
	node("gear_nose_steering", parent="gear_nose_oleo", hinge=undo @ trunnion)
	joint("gear_nose_steering", undo.to_3x3() @ extended, PORT, -PORT, "steering", IDENTITY)
	wheels = merge([tyre(axle + Vector((0, s * offset * INCH, 0)), PORT, nose_r, g["tyres"]["nose"]["width"]) for s in (-1, 1)] +
		[cylinder(axle + Vector((0, -6 * INCH, 0)), axle + Vector((0, 6 * INCH, 0)), 1.2)])
	node("gear_nose_wheel", parent="gear_nose_steering", hinge=undo @ axle, mesh=rested(wheels, undo))
	for side in (-1, 1):
		MARKS[f"axle_nose_{side_name(side)}"] = (undo @ (axle + Vector((0, -side * (offset + g["tyres"]["nose"]["width"] * 0.35) * INCH, 0))), "gear_nose_wheel")
		MARKS[f"wheel_nose_{side_name(side)}"] = (undo @ (axle + Vector((0, -side * offset * INCH, 0))), "gear_nose_wheel")
	joint("gear_nose_wheel", undo.to_3x3() @ PORT, Vector((0, 0, -1)), FORWARD, "wheel.nose", IDENTITY)
	# The launch bar: pivoted on the strut low down, stowed up along it, lowered forward to the shuttle
	pivot = trunnion.lerp(axle, 0.78)
	tip_stowed = pivot + (trunnion - axle).normalized() * (34 * INCH) + FORWARD * (3 * INCH)
	node("launch_bar", parent="gear_nose_strut", hinge=undo @ pivot, mesh=rested(cylinder(pivot + FORWARD * (3 * INCH), tip_stowed, 1.6, 1.2), undo))
	joint("launch_bar", undo.to_3x3() @ PORT, FORWARD, DOWN, "bar", [[0, 0], [1, math.radians(105)]])
	# The nose bay's doors, on the belly's skin either side of the centreline
	# over the stowed leg, hinged along the bay's outer edges, open while the
	# leg is down (NATOPS 2.10.1: the doors stay open)
	front, back, edge = g["nose"] - 56, g["nose"] + 16, 11.0
	belly = built(["fuselage"])
	for side in (-1, 1):
		name = side_name(side)
		door = cut((front, back), (side * 0.15, side * edge), below=True)
		hinge = draped(belly, front, side * edge, below=True, out=0.15)
		node(f"gear_nose_door_{name}", hinge=hinge, mesh=door)
		joint(f"gear_nose_door_{name}", draped(belly, back, side * edge, below=True, out=0.15) - hinge, Vector((0, side, 0)), DOWN, "gear",
			[[0, 0], [0.15, math.radians(88)], [1, math.radians(88)]])


def mechanisms():
	# The arresting hook, the refuelling probe and its door, the speedbrake
	# and the boarding ladder. Placements are provisional: the hook's pivot is
	# located on the reference photo dvids9820808 (FS 641, WL 80); the rest
	# wait on photos that show them open.
	# Hook: swings sideways on its pivot (NATOPS 2.10.5's lateral liquid
	# spring), then lowers
	hook = LAYOUT["hook"]
	pivot = at(*hook["pivot"], 0)
	# the shank ends 4 in above and 3 in ahead of the point, where the shoe hangs
	point = at(hook["point"][0] - 3, hook["point"][1] + 4, 0)
	node("hook_swing", hinge=pivot)
	joint("hook_swing", UP, AFT, -PORT, "swing", IDENTITY)
	shank = merge([cylinder(pivot, point, 2.0, 1.6), cylinder(point, point + DOWN * (4 * INCH) + AFT * (3 * INCH), 2.2, 1.8)])
	node("hook", parent="hook_swing", hinge=pivot, mesh=shank)
	MARKS["hook_point"] = (point + DOWN * (4 * INCH) + AFT * (3 * INCH), "hook")
	joint("hook", PORT, AFT, DOWN, "hook", [[0, 0], [1, math.radians(62)]])
	# Probe: its door on the upper starboard nose where the photos put the
	# reference airframe's (layout.probe; the research jet's, TM-101724's, ran
	# FS 128.5 to 188), a thin shell on the skin, 0.15 in proud, hinged along
	# its lower edge; the probe lies stowed beneath it, 3.5 in under the skin,
	# and swings out and forward about its aft end
	door = LAYOUT["probe"]
	start, end = door["from"], door["to"]
	upper, lower = math.radians(door["upper"]), math.radians(door["lower"])
	stations = [start + (end - start) * i / 14 for i in range(15)]
	angles = [upper + (lower - upper) * j / 6 for j in range(7)]
	shell = lambda st, th, out: at(st, *reversed(skin(st, th, out)))
	rings = [[shell(st, th, 0.15) for th in angles] + [shell(st, th, -0.1) for th in reversed(angles)] for st in stations]
	a, b = shell(start, lower, 0.15), shell(end, lower, 0.15)
	node("probe_door", hinge=a, mesh=loft(rings))
	joint("probe_door", b - a, shell((start + end) / 2, upper, 0.15) - shell((start + end) / 2, lower, 0.15), -PORT, "probe",
		[[0, 0], [0.25, math.radians(80)], [1, math.radians(80)]])
	middle = (upper + lower) / 2
	# its lower corners, the crispest in a photo
	MARKS["probe_door_front"] = (shell(start, lower, 0.15), "probe_door")
	MARKS["probe_door_aft"] = (shell(end, lower, 0.15), "probe_door")
	CURVES["probe_door"] = ([shell(st, upper, 0.15) for st in stations] + [shell(end, th, 0.15) for th in angles[1:]] +
		[shell(st, lower, 0.15) for st in reversed(stations[:-1])] + [shell(start, th, 0.15) for th in reversed(angles[:-1])], "probe_door")
	root, tip = shell(end - 2, middle, -3.5), shell(start + 3, middle, -3.5)
	PROBE[:] = [tip]
	node("probe", hinge=root, mesh=merge([cylinder(root, tip, 2.2, 1.9), cylinder(tip, tip + FORWARD * (2 * INCH), 1.9, 1.2)]))
	joint("probe", UP + PORT * 0.4, FORWARD, -PORT, "probe", [[0, 0], [0.25, 0], [1, math.radians(28)]])
	# Speedbrake: the dorsal panel between the fins, on the spine's skin,
	# hinged at its forward edge
	front, back, half = 545, 610, 17
	skin_tree = built(["fuselage"])
	node("speedbrake", hinge=draped(skin_tree, front, 0, out=0.15), mesh=cut((front, back), (-half, half)))
	joint("speedbrake", PORT, AFT, UP, "speedbrake", [[0, 0], [1, math.radians(60)]])


def ladder():
	# The boarding ladder, stowed in its well under the left LEX and rotating
	# down from its forward beam (NATOPS 2.15.2). The LEX is 2-3 in deep
	# there, so each rail runs straight on the line that leaves it the most
	# room between the LEX's lower and upper skins
	front, length, rails, radius = 300, 92, (-26.0, -38.0), 0.45
	tree = built(["fuselage", "lex_left"])
	stations = [front + length * i / 23 for i in range(24)]
	ends = []
	for bl in rails:
		skins = []
		for st in stations:
			hits = crossings(tree, at(st, 60, bl), UP)
			if len(hits) < 2:
				raise SystemExit(f"ladder: no LEX over BL {bl} at FS {st:.0f}")
			skins.append((60 + hits[0], 60 + hits[1]))
		best = None
		for i in range(61):
			w0 = skins[0][0] + (skins[0][1] - skins[0][0]) * i / 60
			for j in range(61):
				w1 = skins[-1][0] + (skins[-1][1] - skins[-1][0]) * j / 60
				room = min(min(w - lo, hi - w) for (lo, hi), w in zip(skins, (w0 + (w1 - w0) * k / 23 for k in range(24))))
				if best is None or room > best[0]:
					best = (room, w0, w1)
		if best[0] < radius + 0.1:
			raise SystemExit(f"ladder: its BL {bl} rail has {best[0]:.2f} in of room in the LEX")
		ends.append((at(front, best[1], bl), at(front + length, best[2], bl)))
	(a0, a1), (b0, b1) = ends
	pieces = [cylinder(a0, a1, radius), cylinder(b0, b1, radius)]
	pieces += [cylinder(a0.lerp(a1, k * 11 / length), b0.lerp(b1, k * 11 / length), 0.35) for k in range(1, 9)]
	beam = (a0 + b0) / 2
	node("ladder", hinge=beam, mesh=merge(pieces))
	joint("ladder", a0 - b0, AFT, DOWN, "ladder", [[0, 0], [1, math.radians(68)]])


def surface_angle(station, waterline, side):
	# The angle round the section from the top centreline, signed + to
	# starboard, where the skin on that side stands at a waterline
	low, high = 0.0, math.pi
	for _ in range(40):
		middle = (low + high) / 2
		if skin(station, middle)[1] > waterline:
			low = middle
		else:
			high = middle
	return math.copysign((low + high) / 2, side)


def on_skin(station, theta, out=0.0):
	# A point on the fuselage's skin, moved out from it by `out` inches
	bl, wl = skin(station, theta, out)
	return at(station, wl, bl)


def draped(tree, station, buttline, below=False, out=0.0):
	# The point on the built skin straight above (or below) a station and
	# buttline, moved off it by `out` inches along its face's normal
	direction = UP if below else DOWN
	hit, normal = tree.ray_cast(at(station, 0 if below else 250, buttline), direction)[:2]
	if hit is None:
		raise SystemExit(f"no skin at FS {station:.1f} BL {buttline:.1f}")
	return hit - normal * (math.copysign(1, normal.dot(direction)) * out * INCH)


def cut(stations, buttlines, below=False, proud=0.15, under=0.1):
	# A thin panel cut from the built fuselage's own skin between two
	# stations and two buttlines, on its top or its bottom: its outer face
	# `proud` off every facet, its inner `under` beneath, its edges closed
	bm = bmesh.new()
	bm.from_mesh(NODES["fuselage"].data)
	bmesh.ops.translate(bm, verts=bm.verts, vec=HINGES["fuselage"])
	(front, back), ys = stations, sorted(-b * INCH for b in buttlines)
	for point, normal in ((at(front, 0, 0), FORWARD), (at(back, 0, 0), AFT), (Vector((0, ys[1], 0)), PORT), (Vector((0, ys[0], 0)), -PORT)):
		bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=point, plane_no=normal, clear_outer=True)
	bm.normal_update()
	facing = DOWN if below else UP
	bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.normal.dot(facing) < 0.3], context="FACES")
	bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
	bm.normal_update()
	index = {v: i for i, v in enumerate(bm.verts)}
	n = len(index)
	vertices = [v.co + v.normal * (proud * INCH) for v in bm.verts] + [v.co - v.normal * (under * INCH) for v in bm.verts]
	faces = [tuple(index[v] for v in f.verts) for f in bm.faces]
	faces += [tuple(n + index[v] for v in reversed(f.verts)) for f in bm.faces]
	for e in bm.edges:
		if len(e.link_faces) == 1:
			a, b = (index[v] for v in e.verts)
			faces.append((a, b, n + b, n + a))
	bm.free()
	return vertices, faces


def blister(station, waterline, side, length, width, proud, along=12, around=10):
	# A fairing on the skin centred at a station and waterline on that side:
	# half an ellipsoid, `length` along the stations, `width` round the
	# section and standing `proud` off the skin, in inches
	theta = surface_angle(station, waterline, side)
	centre, _ = half_ring(station)
	bl, wl = skin(station, theta)
	spread = (width / 2) / math.hypot(bl, wl - centre[1])
	rings = []
	for i in range(along + 1):
		u = -0.97 + 1.94 * i / along
		s = math.sqrt(1 - u * u)
		rings.append([on_skin(station + u * length / 2, theta + math.cos(math.pi * k / around) * spread * s,
			math.sin(math.pi * k / around) * proud * s) for k in range(around + 1)])
	return loft(rings)


def slab(corners, thickness):
	# A thin plate on four corners, `thickness` inches through
	a, b, c, d = corners
	normal = (b - a).cross(d - a).normalized() * (thickness * INCH / 2)
	vertices = [p - normal for p in corners] + [p + normal for p in corners]
	faces = [(0, 1, 2, 3), (7, 6, 5, 4), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)]
	return vertices, faces


def fittings():
	# What stands on the nose's skin, from the photos and tm101724 (facts.json
	# layout.aoa, pitot, blisters, formation and blade; fittings.ecm): the
	# angle-of-attack probes, the pitot-static tubes, the antenna fairings
	# and ECM covers, the formation light strips and the blade under the nose
	aoa, pitot = LAYOUT["aoa"], LAYOUT["pitot"]
	ecm = FACTS["fittings"]["ecm"]
	for side in (-1, 1):
		name = side_name(side)
		# angle-of-attack probe: a cone standing straight out of a round plate
		theta = surface_angle(aoa["station"], aoa["waterline"], side)
		base = on_skin(aoa["station"], theta)
		out = (on_skin(aoa["station"], theta, 1.0) - base).normalized()
		tip = base + out * (aoa["cone"] * INCH)
		node(f"aoa_{name}", mesh=merge([cylinder(base - out * (0.25 * INCH), base + out * (0.1 * INCH), aoa["plate"] / 2, sides=20),
			cylinder(base, tip, aoa["base"] / 2, 0.06)]))
		MARKS[f"aoa_{name}"] = (base, f"aoa_{name}")
		# pitot-static tube: a strut swept forward and down from the skin, the
		# tube pointing forward from its foot, on the root's buttline
		fore, aft = pitot["root"]
		roots = [on_skin(st, surface_angle(st, pitot["waterline"], side), -0.4) for st in (fore, aft)]
		bl = skin((fore + aft) / 2, surface_angle((fore + aft) / 2, pitot["waterline"], side))[0]
		(bend, low), (point, end) = pitot["bend"], pitot["tip"]
		radius = pitot["tube"] / 2
		strut = slab([roots[0], roots[1], at(bend + 1.7, low, bl), at(bend - 0.6, low, bl)], 0.5)
		tube = cylinder(at(bend + 1.7, low - radius, bl), at(point, end, bl), radius, radius * 0.75)
		node(f"pitot_{name}", mesh=merge([strut, tube]))
		MARKS[f"pitot_tip_{name}"] = (at(point, end, bl), f"pitot_{name}")
		# fairings: the ECM covers (tm101724) and the photos' antenna fairings
		pieces = [blister(ecm["station"], skin(ecm["station"], math.radians(180 - ecm["theta"][0]))[1], side,
			ecm["length"], ecm["width"], ecm["proud"])]
		for spec in LAYOUT["blisters"].values():
			if isinstance(spec, list):
				first, last, wl, width, proud = spec
				pieces.append(blister((first + last) / 2, wl, side, last - first, width, proud))
		node(f"fairings_{name}", mesh=merge(pieces))
		# formation light strip, flush with the skin
		f = LAYOUT["formation"]
		rings = []
		for i in range(13):
			st = f["from"] + (f["to"] - f["from"]) * i / 12
			top = surface_angle(st, f["waterline"] + f["height"] / 2, side)
			bottom = surface_angle(st, f["waterline"] - f["height"] / 2, side)
			angles = [top + (bottom - top) * j / 3 for j in range(4)]
			rings.append([on_skin(st, a, 0.06) for a in angles] + [on_skin(st, a, -0.05) for a in reversed(angles)])
		node(f"formation_{name}", mesh=loft(rings), paint="lights")
	# the blade antenna under the nose, on the centreline
	b = LAYOUT["blade"]
	start, end, low = b["bottom"]
	corners = [at(b["from"], keel_at(b["from"]) + 1.0, 0), at(b["to"], keel_at(b["to"]) + 1.0, 0), at(end, low, 0), at(start, low, 0)]
	node("blade_nose", mesh=slab(corners, b["thickness"]))
	MARKS["blade_nose_bottom_front"] = (at(start, low, 0), "blade_nose")
	MARKS["blade_nose_bottom_aft"] = (at(end, low, 0), "blade_nose")
	# the antennas on the spine (layout.antennas): the swept dorsal blade and the
	# small one ahead of it on the centreline, their bases sunk an inch into the
	# skin; the dome on the left of the spine
	a = LAYOUT["antennas"]
	for key, half in (("dorsal", 0.3), ("spine", 0.2)):
		(f0, w0), (f1, w1), (f2, w2), (f3, w3) = a[key]
		node(f"antenna_{key}", mesh=prism([(f0, w0 - 1.0), (f1, w1 - 1.0), (f2, w2), (f3, w3)], half))
		MARKS[f"antenna_{key}_tip_front"] = (at(f3, w3, 0), f"antenna_{key}")
	station, waterline, buttline, diameter, proud = a["dome"]
	node("antenna_dome", mesh=blister(station, waterline, math.copysign(1, buttline), diameter, diameter, proud))
	# under the radome: three short posts and the chin fairing behind them
	keel = lambda st: keel_at(st)
	posts = [cylinder(at(st, keel(st) + 0.5, 0), at(st, keel(st) - 0.5, 0), 0.3) for st in a["comb"]]
	first, last, rise = a["chin"]
	chin = ellipsoid(((first + last) / 2, keel((first + last) / 2), 0), ((last - first) / 2, rise, 1.6))
	node("antenna_chin", mesh=merge(posts + [chin]))


def block(stations, waterlines, buttlines):
	# A box between two stations, waterlines and buttlines, in inches
	vertices = [at(s, w, b) for s in stations for w in waterlines for b in buttlines]
	faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
	return vertices, faces


def prism(profile, half):
	# A side profile ([FS, WL] corners in order) carried across the
	# centreline to `half` inches each side
	n = len(profile)
	vertices = [at(s, w, -half) for s, w in profile] + [at(s, w, half) for s, w in profile]
	faces = [tuple(range(n)), tuple(range(2 * n - 1, n - 1, -1))] + [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
	return vertices, faces


def ellipsoid(centre, radii, rings=10, sides=14):
	# An ellipsoid at [FS, WL, BL] with radii along each, in inches
	(s, w, b), (rs, rw, rb) = centre, radii
	loops = []
	for i in range(1, rings):
		a = math.pi * i / rings
		loops.append([at(s - rs * math.cos(a), w + rw * math.sin(a) * math.cos(2 * math.pi * k / sides), b + rb * math.sin(a) * math.sin(2 * math.pi * k / sides))
			for k in range(sides)])
	return loft(loops)


def painted(pieces):
	# Merges (vertices, faces) pieces each with its material: a mesh with a material per face
	vertices, faces, paints = [], [], []
	for (vs, fs), paint in pieces:
		offset = len(vertices)
		vertices += vs
		faces += [tuple(i + offset for i in f) for f in fs]
		paints += [paint] * len(fs)
	return vertices, faces, paints


def cockpit():
	# The simple cockpit every jet carries, hidden in first person where the
	# detailed one takes over (the Contract's `cockpit` group and `pilot`).
	# Placed by what dvids9820808 shows through the canopy (layout.cockpit:
	# the headbox, the helmet, the HUD frame, the glareshield's edge); its
	# widths, floor, walls, panel and the pilot's limbs are estimated round
	# those and the canopy's sill
	c = LAYOUT["cockpit"]
	sill = LAYOUT["canopy"]["sill"]
	edge, top = c["glareshield"]
	floor, bulkhead = 118.0, 283.0
	node("cockpit")
	# the tub: walls inside the sill, a floor, and a deck behind the seat
	walls = []
	for side in (-1, 1):
		stations = [edge + (bulkhead - edge) * i / 8 for i in range(9)]
		inner = [(st, between([(p[0], p[2]) for p in sill], st) - 1.2, between([(p[0], p[1]) for p in sill], st) - 0.5) for st in stations]
		for (s0, b0, w0), (s1, b1, w1) in zip(inner, inner[1:]):
			walls.append(slab([at(s0, floor, side * b0), at(s1, floor, side * b1), at(s1, w1, side * b1), at(s0, w0, side * b0)], 0.5))
	deck = between([(p[0], p[1]) for p in sill], bulkhead) - 1.0
	room = between([(p[0], p[2]) for p in sill], bulkhead) - 1.2
	pieces = [(piece, "paint") for piece in walls] + [
		(block((edge, bulkhead), (floor - 0.5, floor), (-12.0, 12.0)), "paint"),
		(block((bulkhead, bulkhead + 0.5), (floor, deck), (-room, room)), "paint"),
		(block((bulkhead, LAYOUT["canopy"]["sill"][-1][0]), (deck - 0.5, deck), (-room, room)), "paint")]
	node("cockpit_tub", parent="cockpit", mesh=painted(pieces))
	# the instrument panel under the glareshield, its displays facing aft:
	# the two DDIs either side, the AMPCD between them below, the UFC above
	panel = edge + 1.5
	hull = built(["fuselage", "windscreen", "canopy"])

	def room(station, waterline):
		# 12 in each side, or half an inch inside the hull where it is narrower
		return min(12.0, crossings(hull, at(station, waterline, 0), Vector((0, -1, 0)))[0] - 0.5)

	displays = [(-7.0, 138.0, 5.0), (7.0, 138.0, 5.0), (0.0, 130.5, 5.0), (0.0, 141.5, 3.5)]
	wide = room(panel, top)
	pieces = [(block((panel, panel + 0.6), (floor + 4, top), (-wide, wide)), "paint")]
	for bl, wl, size in displays:
		pieces.append((block((panel + 0.6, panel + 0.7), (wl - size / 2, wl + size / 2), (bl - size / 2, bl + size / 2)), "display"))
	# the glareshield over it, back to the HUD's foot
	(foot_station, foot), (head_station, head) = c["hud"]
	pieces.append((loft([[at(s, w, b) for w, b in ((top, -h), (top, h), (top + 0.6, h), (top + 0.6, -h))]
		for s, h in ((foot_station, room(foot_station, top + 0.6)), (edge, room(edge, top + 0.6)))]), "paint"))
	node("cockpit_panel", parent="cockpit", mesh=painted(pieces))
	# the HUD: two posts and the combiner between them
	posts = [cylinder(at(foot_station, foot, b), at(head_station, head, b), 0.4) for b in (-3.2, 3.2)]
	glass = slab([at(foot_station + 0.5, foot + 0.5, -3.0), at(foot_station + 0.5, foot + 0.5, 3.0), at(head_station, head, 3.0), at(head_station, head, -3.0)], 0.1)
	node("cockpit_hud", parent="cockpit", mesh=painted([(posts[0], "paint"), (posts[1], "paint"), (glass, "glass")]))
	# the seat: its headbox as the photo shows it, the back raked down along
	# the headbox's front edge, and the pan
	box = c["headbox"]
	(fs0, wl0), (fs1, wl1) = box[0], box[1]
	rake = (fs1 - fs0) / (wl1 - wl0)
	pan = 123.0
	back = [(fs0 - rake * (wl0 - pan), pan), box[0], box[3], (box[3][0] - rake * (box[3][1] - pan + 2), pan - 2)]
	# (its width estimated: 12 in, inside the glass that narrows to about 13 in at its height)
	seat = [prism(box, 6.0), prism(back, 7.5), block((240.0, back[0][0]), (pan - 3, pan), (-8.0, 8.0))]
	node("cockpit_seat", parent="cockpit", mesh=merge(seat))
	# the stick between the pilot's knees
	node("cockpit_stick", parent="cockpit", mesh=merge([cylinder(at(241, floor, 0), at(239.5, 133, 0), 0.6), cylinder(at(239.5, 133, 0), at(239.2, 137, 0), 0.9)]))
	# the pilot: the helmet as the photo shows it, the rest a seated figure
	h = c["helmet"]
	helmet = ellipsoid(((h["front"] + h["back"]) / 2, (h["top"] + h["bottom"]) / 2, 0), ((h["back"] - h["front"]) / 2, (h["top"] - h["bottom"]) / 2, 5.0))
	shoulder = 147.5
	body = [helmet, cylinder(at(256, h["bottom"] + 0.5, 0), at(257, shoulder - 1, 0), 2.0),
		ellipsoid((257.5, (shoulder + pan + 3) / 2, 0), (5.0, (shoulder - pan - 3) / 2, 8.0))]
	for side in (-1, 1):
		body += [cylinder(at(254, pan + 3, side * 4.5), at(234, pan + 6, side * 5), 3.0),   # thigh
			cylinder(at(234, pan + 6, side * 5), at(222, floor + 1, side * 5.5), 2.4),   # shin
			cylinder(at(257, shoulder - 2, side * 8.5), at(249, 136, side * 9), 2.0)]   # upper arm
	body += [cylinder(at(249, 136, 9), at(240, 134, 1.5), 1.7), cylinder(at(249, 136, -9), at(246, 135, -11.5), 1.7)]   # to the stick and the throttles
	node("pilot", mesh=merge(body))


def nozzles():
	# Each nozzle's outer flaps (layout.petals): twelve flat facets round the
	# engine axis from their hinges at the start to the photo-matched exit,
	# their middles on the round nozzle (so the twelve-sided exit's lowest
	# lip is the photos'), 1.5 in deep to the divergent flaps' faces inside.
	# Each is its own joint, `nozzle_<side>_petal_<k>` from the top round
	# outboard. They rest open, as parked; the `nozzle` drive closes them
	# (0 open, 1 closed at military power), the exit lip moving in by the
	# throat's travel. The aft ends' stepped tabs are not built
	petals = LAYOUT["petals"]
	count, half = petals["count"], math.pi / petals["count"]
	length = NOZZLE["exit"] - NOZZLE["start"]
	travel = math.asin(petals["travel"] / length)
	deep = 1.5
	for side in (-1, 1):
		name = side_name(side)
		centre = lambda station: (NOZZLE["waterline"], side * engine_buttline(station))

		def round_at(station, radius, angle):
			# a point at a radius and angle (from the top, + outboard) round the axis
			w, b = centre(station)
			return at(station, w + radius * math.cos(angle), b + side * radius * math.sin(angle))

		corners = lambda station, radius, angle: [round_at(station, radius / math.cos(half), angle + s * half) for s in (-1, 1)]
		for k in range(count):
			angle = 2 * half * k
			(r0, r1), (s0, s1) = NOZZLE["radius"], (NOZZLE["start"], NOZZLE["exit"])
			outer = corners(s0, r0, angle) + list(reversed(corners(s1, r1, angle)))
			inner = corners(s0, r0 - deep, angle) + list(reversed(corners(s1, r1 - deep, angle)))
			faces = [(0, 1, 2, 3), (7, 6, 5, 4)] + [(i, (i + 1) % 4 + 4, i + 4) for i in range(4)] + [(i, (i + 1) % 4, (i + 1) % 4 + 4) for i in range(4)]
			petal = f"nozzle_{name}_petal_{k + 1}"
			hinge = round_at(s0, r0, angle)
			node(petal, hinge=hinge, mesh=(outer + inner, faces))
			radial = (hinge - at(s0, *centre(s0))).normalized()
			tangent = (round_at(s0, r0, angle + 0.01) - round_at(s0, r0, angle - 0.01)).normalized()
			joint(petal, tangent, round_at(s1, r1, angle) - hinge, radial, "nozzle", [[0, 0], [1, -travel]])
		# the photo match's rings and lowest points, on the bottom flap
		bottom = f"nozzle_{name}_petal_{count // 2 + 1}"
		for key, station, radius in (("root", NOZZLE["start"], NOZZLE["radius"][0]), ("exit", NOZZLE["exit"], NOZZLE["radius"][1])):
			ring = [p for k in range(count) for p in corners(station, radius, 2 * half * k)[:1]]
			CURVES[f"nozzle_{key}_{name}"] = (ring + ring[:1], bottom)
			MARKS[f"nozzle_{key}_bottom_{name}"] = (round_at(station, radius, math.pi), bottom)
		# the burner (the Contract's burner_left/right): the faces that glow in
		# the nozzle, a liner from deep in it to near the exit, closed at its deep
		# end, as wide as the throat at full reheat (layout.petals); the engine
		# sets their glow and draws the flames. Ten sides keep the distant
		# stage's burner within its 80 triangles
		axis = lambda station: at(station, *centre(station))
		deep_end, near = NOZZLE["exit"] - 10, NOZZLE["exit"] - 2.5
		glow = petals["throat"][1]
		node(f"burner_{name}", paint="burner", mesh=cylinder(axis(deep_end), axis(near), glow, glow, sides=10))


ATLAS = 2048


def paint(directory):
	# Unique UVs for every part in one atlas, then the paint: ambient
	# occlusion baked in Cycles as the shading every skin is laid over (#8),
	# times the paint's grey. Writes the atlas beside the model.
	parts = [o for o in bpy.data.objects if o.type == "MESH"]
	bpy.ops.object.select_all(action="DESELECT")
	for o in parts:
		o.select_set(True)
	bpy.context.view_layer.objects.active = parts[0]
	bpy.ops.object.mode_set(mode="EDIT")
	bpy.ops.mesh.select_all(action="SELECT")
	bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.002, scale_to_bounds=False)
	bpy.ops.uv.pack_islands(rotate=True, margin=0.002)
	bpy.ops.object.mode_set(mode="OBJECT")
	image = bpy.data.images.new("paint", ATLAS, ATLAS, alpha=False)
	for m in MATERIALS.values():
		nodes = m.node_tree.nodes
		texture = nodes.new("ShaderNodeTexImage")
		texture.image = image
		nodes.active = texture
	scene = bpy.context.scene
	scene.render.engine = "CYCLES"
	scene.cycles.samples = 48
	scene.cycles.device = "CPU"
	scene.render.bake.margin = 6
	bpy.ops.object.bake(type="AO", use_clear=True)
	shade = np.array(image.pixels[:]).reshape(ATLAS, ATLAS, 4)[..., 0]
	# The two greys (layout.paint): each texel's surface normal, baked in the
	# objects' own axes (every node rests unrotated, so they are the jet's),
	# picks the upper grey or, facing down, the lower
	normals = bpy.data.images.new("normals", ATLAS, ATLAS, alpha=False, float_buffer=True)
	normals.colorspace_settings.name = "Non-Color"
	for m in MATERIALS.values():
		next(n for n in m.node_tree.nodes if n.type == "TEX_IMAGE").image = normals
	bpy.ops.object.bake(type="NORMAL", normal_space="OBJECT", use_clear=True)
	normal = np.array(normals.pixels[:]).reshape(ATLAS, ATLAS, 4)[..., :3] * 2 - 1
	up = normal[..., 2]
	covered = np.abs(np.linalg.norm(normal, axis=-1) - 1) < 0.1   # texels the bake reached: a unit normal
	# Each texel's place on the jet: a temporary shader emits its position
	positions = bpy.data.images.new("positions", ATLAS, ATLAS, alpha=False, float_buffer=True)
	positions.colorspace_settings.name = "Non-Color"
	scene.cycles.samples = 1
	temporary = []
	for m in MATERIALS.values():
		nodes, links = m.node_tree.nodes, m.node_tree.links
		next(n for n in nodes if n.type == "TEX_IMAGE").image = positions
		geometry, emission = nodes.new("ShaderNodeNewGeometry"), nodes.new("ShaderNodeEmission")
		links.new(geometry.outputs["Position"], emission.inputs["Color"])
		links.new(emission.outputs["Emission"], nodes["Material Output"].inputs["Surface"])
		temporary.append((m, geometry, emission))
	bpy.ops.object.bake(type="EMIT", use_clear=True)
	where = np.array(positions.pixels[:]).reshape(ATLAS, ATLAS, 4)[..., :3]
	for m, geometry, emission in temporary:
		nodes = m.node_tree.nodes
		nodes.remove(geometry)
		nodes.remove(emission)
		m.node_tree.links.new(nodes["Principled BSDF"].outputs["BSDF"], nodes["Material Output"].inputs["Surface"])
		next(n for n in nodes if n.type == "TEX_IMAGE").image = image
	p = LAYOUT["paint"]
	upper, lower = np.array(p["upper"]) / 255, np.array(p["lower"]) / 255
	start, end = p["turn"]
	f = np.clip((up - start) / (end - start), 0, 1)
	f = (f * f * (3 - 2 * f))[..., None]
	grey = upper[None, None, :] * (1 - f) + lower[None, None, :] * f
	colour = grey * (0.4 + 0.6 * shade[..., None]) * (panels(where, covered) * stencils(where, covered))[..., None]
	pixels = np.concatenate([colour, np.ones((ATLAS, ATLAS, 1))], -1)
	image.pixels[:] = pixels.ravel()
	image.filepath_raw = str(Path(directory) / "paint.png")
	image.file_format = "PNG"
	image.save()
	for name, m in MATERIALS.items():
		if name in ("paint", "team"):
			nodes = m.node_tree.nodes
			texture = next(n for n in nodes if n.type == "TEX_IMAGE")
			m.node_tree.links.new(texture.outputs["Color"], nodes["Principled BSDF"].inputs["Base Color"])
		else:
			m.node_tree.nodes.remove(next(n for n in m.node_tree.nodes if n.type == "TEX_IMAGE"))


def panels(where, covered):
	# The panel lines' shading over the atlas (layout.panels): 1 where none
	# runs, darker within half the line's width of one. Each texel's place on
	# the jet (where, Blender's axes, metres) is measured against the lines:
	# rings round the fuselage at a station, and polylines given on the skin
	p = LAYOUT["panels"]
	factor = np.ones(where.shape[:2])
	half = p["width"] * INCH / 2
	points = where[covered]
	order = np.argsort(points[:, 0])
	xs = points[order, 0]
	near = np.zeros(len(points), bool)

	def between_x(lo, hi):
		return order[np.searchsorted(xs, lo): np.searchsorted(xs, hi)]

	for station in p.get("rings", []):
		x = at(station, ORIGIN["waterline"], 0).x
		near[between_x(x - half, x + half)] = True
	mirrored = p.get("mirrored", [])
	skin = built([n for n, o in NODES.items() if o.type == "MESH"])
	for k, line in enumerate(p.get("lines", []) + mirrored + [[(s, w, -b) for s, w, b in line] for line in mirrored]):
		corners = on_parts(skin, [at(*c) for c in line], k)
		for a, b in zip(corners, corners[1:]):
			a, b = np.array(a), np.array(b)
			pick = between_x(min(a[0], b[0]) - half, max(a[0], b[0]) + half)
			if not len(pick):
				continue
			q = points[pick]
			d = b - a
			t = np.clip(((q - a) @ d) / max(d @ d, 1e-12), 0, 1)
			gap = np.linalg.norm(q - (a + t[:, None] * d), axis=1)
			near[pick[gap < half]] = True
	shade = np.ones(len(points))
	shade[near] = p["shade"]
	factor[covered] = shade
	return factor


def on_parts(tree, corners, k, step=0.5, far=1.0):
	# A panel line, cast onto the skin as some photos saw it, laid on the skin
	# as built now: every half inch along it moved to the nearest surface. A
	# point further than `far` inches off means the skin has moved since the
	# line was cast: cast it again
	out = []
	for a, b in zip(corners, corners[1:]):
		n = max(1, math.ceil((b - a).length / (step * INCH)))
		out += [a.lerp(b, i / n) for i in range(n)]
	out.append(corners[-1])
	laid = []
	for q in out:
		hit, _, _, gap = tree.find_nearest(q)
		if gap > far * INCH:
			raise SystemExit(f"panel line {k}: a point {gap / INCH:.1f} in off the skin; cast the line again (layout.panels)")
		laid.append(hit)
	return laid


STENCIL = 10   # pixels per inch the stencils are drawn at before they are laid on the atlas


def stencil_image(spec, dark, light):
	# A stencil as the paint's brightness under it (1 where it leaves the
	# paint alone): a dark box with light lettering, or a dark inverted triangle
	# band with its edge word in light and its words inside in dark
	from PIL import Image, ImageDraw, ImageFont
	w, h = round(spec["size"][0] * STENCIL), round(spec["size"][1] * STENCIL)
	image = Image.new("L", (w, h), 255)
	draw = ImageDraw.Draw(image)
	lines = spec["lines"]
	if spec["kind"] == "box":
		draw.rectangle([0, 0, w - 1, h - 1], fill=round(dark * 255))
		size = h / (len(lines) + 1.5)
		font = ImageFont.load_default(size=size)
		for i, text in enumerate(lines):
			draw.text((w / 2, size * (i + 1)), text, fill=round(light * 255), font=font, anchor="mm")
	else:
		band = 0.17 * h
		draw.polygon([(0, 0), (w - 1, 0), (w / 2, h - 1)], fill=round(dark * 255))
		inner = [(band * 1.7, band), (w - 1 - band * 1.7, band), (w / 2, h - 1 - band * 1.9)]
		draw.polygon(inner, fill=255)
		draw.text((w / 2, band / 2), spec["edge"], fill=round(light * 255), font=ImageFont.load_default(size=band * 0.8), anchor="mm")
		size = (h - 2.9 * band) / (len(lines) + 1)
		font = ImageFont.load_default(size=size)
		for i, text in enumerate(lines):
			draw.text((w / 2, band + size * (i + 0.8)), text, fill=round(dark * 255), font=font, anchor="mm")
	return np.asarray(image, float) / 255


def stencils(where, covered):
	# The stencils' shading over the atlas (layout.stencils): each laid on both
	# sides' skin, flat in the plane touching the skin at its middle, its
	# lettering reading forward on the right and aft on the left
	p = LAYOUT["stencils"]
	factor = np.ones(where.shape[:2])
	points = where[covered]
	shade = np.ones(len(points))
	for key, spec in p.items():
		if not isinstance(spec, dict):
			continue
		image = stencil_image(spec, p["dark"], p["light"])
		# blurred to the atlas's texel (about 6 mm): lettering finer than that
		# would read as speckle, so it reads as soft bands instead
		from PIL import Image, ImageFilter
		image = np.asarray(Image.fromarray((image * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(STENCIL * 0.12)), float) / 255
		h, w = image.shape
		for side in (-1, 1):
			station, waterline = spec["at"]
			theta = surface_angle(station, waterline, side)
			centre = on_skin(station, theta)
			normal = (on_skin(station, theta, 1.0) - centre).normalized()
			up = (UP - normal * UP.dot(normal)).normalized()
			across = up.cross(normal)   # the reading direction: forward on the right, aft on the left
			d = points - np.array(centre)
			off = d @ np.array(normal)
			u = d @ np.array(across) / (spec["size"][0] * INCH) + 0.5
			v = 0.5 - d @ np.array(up) / (spec["size"][1] * INCH)
			pick = (np.abs(off) < 1.5 * INCH) & (u >= 0) & (u < 1) & (v >= 0) & (v < 1)
			shade[pick] = np.minimum(shade[pick], image[(v[pick] * h).astype(int), (u[pick] * w).astype(int)])
	factor[covered] = shade
	return factor


def points():
	# The points file's points (the plan's Contract, fa18c.json), at rest in
	# the model frame. Provisional placements say so in their facts.
	g = LAYOUT["gear"]
	e = lambda v: exported(v)
	out = {}
	eye = LAYOUT["eye"]
	out["eye"] = e(at(eye["station"], eye["waterline"], 0))
	gun = FACTS["fittings"]["gun"]["station"]
	out["gun"] = {"muzzle": e(top_at(gun)), "direction": e(FORWARD)}
	out["nozzles"] = {side_name(s): {"exit": e(at(NOZZLE["exit"], NOZZLE["waterline"], s * engine_buttline(NOZZLE["exit"]))),
		"radius": round(NOZZLE["radius"][1] * INCH, 4)} for s in (-1, 1)}
	gear = {}
	for name, station, buttline, tyre in (("nose", g["nose"], 0, "nose"), ("left", g["main"], -g["track"] / 2, "main"), ("right", g["main"], g["track"] / 2, "main")):
		radius = g["tyres"][tyre]["diameter"] / 2
		gear[name] = {"axle": e(at(station, g["axles"][tyre], buttline)), "radius": round(radius * INCH, 4)}
	out["gear"] = gear
	# the main tyres' contact (the nose tyres', smaller, stand a little higher)
	out["ground"] = round((g["axles"]["main"] - g["tyres"]["main"]["diameter"] / 2 - ORIGIN["waterline"]) * INCH, 4)
	out["hook"] = {"pivot": e(at(*LAYOUT["hook"]["pivot"], 0)), "point": e(at(*LAYOUT["hook"]["point"], 0))}
	out["probe"] = e(PROBE[0])
	out["belly"] = [e(at(s, keel_at(s), 0)) for s in (100, 250, 450, 600)]
	out["wingtips"] = {n: e(LANDMARKS[f"wingtip_leading_{n}"].lerp(LANDMARKS[f"wingtip_trailing_{n}"], 0.5)) for n in ("left", "right")}
	out["speedbrake"] = {"hinge": e(HINGES["speedbrake"]), "area": round(65 * 34 * INCH * INCH, 3)}
	hard = {}
	belly = built(["fuselage", "inlet_left", "inlet_right"])
	for station in LAYOUT["hardpoints"]["stations"]:
		number, buttline = station["number"], station["buttline"]
		side = "left" if buttline < 0 else "right"
		if station["kind"] == "wing":
			surface = SURFACES[f"wing_{side}"]
			u = abs(buttline)
			mount = surface.point(u, station["chord"], -1)
		elif station["kind"] == "tip":
			surface = SURFACES[f"wing_{side}"]
			mount = surface.point(value(FACTS["reference"]["span"]) * 6, 0.45)
		else:
			# on the nacelle or the keel: the skin straight below the station and buttline
			mount = draped(belly, station["station"], buttline, below=True)
		hard[str(number)] = {"mount": e(mount), "forward": e(FORWARD)}
	out["hardpoints"] = hard
	lights = {}
	for name, spec in LAYOUT["lights"]["points"].items():
		lights[name] = {"position": e(at(*spec["at"])), "colour": spec["colour"], "kind": spec["kind"]}
	out["lights"] = lights
	return out


def top_at(station):
	# The fuselage's top centreline at a station, between its rings
	line = sorted(TOPLINE, key=lambda v: -v.x)
	for a, b in zip(line, line[1:]):
		sa, sb = 456 - a.x / INCH, 456 - b.x / INCH
		if sa <= station <= sb:
			return a.lerp(b, (station - sa) / ((sb - sa) or 1))
	raise ValueError(f"FS {station} is off the top line")


def keel_at(station):
	return between([(456 - v.x / INCH, ORIGIN["waterline"] + v.z / INCH) for v in KEELLINE], station)


def main():
	args = sys.argv[sys.argv.index("--") + 1 :]
	out = [a for a in args if not a.startswith("--")]
	bpy.ops.wm.read_factory_settings(use_empty=True)
	widths = fuselage()
	gun = FACTS["fittings"]["gun"]["station"]
	MARKS["gun_port"] = (top_at(gun), "fuselage")
	MARKS["radome_top"] = (top_at(NOSE), "fuselage")
	inlets()
	nozzles()
	gear()
	mechanisms()
	fittings()
	cockpit()
	for side in (-1, 1):
		fractions = wing(side)
		stabilator(side)
		fractions["rudder"] = fin(side)
	for side in (-1, 1):
		lex(side, widths)
	ladder()
	print("chord fractions:", json.dumps(fractions, default=lambda x: round(x, 3)))
	located = points()
	if "--draft" not in args:
		paint(Path(out[0]).parent)
	bpy.ops.export_scene.gltf(filepath=out[0], export_format="GLB", export_yup=True, use_selection=False,
		export_apply=False, export_animations=False, export_extras=False)
	document = {"frame": {"origin": {"station": ORIGIN["station"], "waterline": ORIGIN["waterline"], "buttline": 0}},
		"joints": dict(sorted(JOINTS.items())),
		"points": {**located, "landmarks": {name: exported(point) for name, point in sorted(LANDMARKS.items())}}}
	Path(out[1]).write_text(json.dumps(document, indent="\t") + "\n")
	if len(out) > 2:
		features = {"about": "The model's named points and curves, each on the node it rides on, at rest in the model frame (build.py).",
			"landmarks": {name: {"at": exported(p), "node": n} for name, (p, n) in sorted(MARKS.items())},
			"curves": {name: {"points": [exported(p) for p in points], "node": n} for name, (points, n) in sorted(CURVES.items())}}
		Path(out[2]).write_text(json.dumps(features, indent="\t") + "\n")


main()
