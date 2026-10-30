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
COLOURS = {"paint": (0.42, 0.45, 0.48, 1), "team": (0.42, 0.45, 0.48, 1), "glass": (0.1, 0.12, 0.14, 0.4),
	"lights": (1, 1, 1, 1), "burner": (1, 0.6, 0.2, 1), "display": (0.05, 0.08, 0.05, 1)}


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
	dihedral = math.tan(math.radians(value(w["dihedral"])))
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
	MARKS[f"wingtip_trailing_{name}"] = (surface.point(semispan, 1), f"wing_outer_{name}")
	MARKS[f"fold_trailing_{name}"] = (surface.point(fold, 1), f"wing_inner_{name}")
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


def profile(kind, station):
	# The HATP side's top or keel line, or the top view's half-width, at a station
	table = PROFILES["side"] if kind in ("top", "keel") else PROFILES["top"]
	values = table[kind if kind != "half" else "half"]
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
			halves.append(resample([(abs(x), y) for x, y in chain], HALF))
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
			halves.append(resample(kept, HALF))
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
	bends = [(s, wl - sum(raw(s)[:2])) for s, wl in located]
	FORE["top"] = [(184.0, 0.0)] + bends + [(346.0, 0.0)]   # from TM-101724's last section


NOSE = 128.5   # facts.json nose.junction: the nosecone ends here


def raw(station):
	# A forebody station's keel, height and half-width before the canopy's bend
	F = FORE
	height = F["hatp"](station) * between(F["height_ratio"], station)
	if station <= 184:
		width = profile("half", station) * between(F["width_ratio"], station)
	else:
		width = between([(s, w) for s, w in F["widths"].items() if s >= 184], station)
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


def half_ring(station):
	# The fuselage's starboard half at a station, top centreline to keel, as
	# (buttline, waterline) at the half-ring's ANGLES round its centre
	F = FORE
	keel, height, width = raw(station)
	height += smooth(F["top"], station) if F["top"] and F["top"][0][0] < station < F["top"][-1][0] else 0.0
	low = max([s for s in F["known"] if s <= station], default=F["known"][0])
	high = min([s for s in F["known"] if s >= station], default=F["known"][-1])
	f = 0 if high == low else (station - low) / (high - low)
	points = [(a[0] * (1 - f) + b[0] * f, a[1] * (1 - f) + b[1] * f) for a, b in zip(F["shapes"][low][0], F["shapes"][high][0])]
	fore = [(x * width, keel + y * height) for x, y in points]
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


def skin(station, theta, out=0.0):
	# The fuselage's surface at a station, theta from the top centreline
	# round its centre (+ to starboard), moved out along the ray by `out`
	# inches: (buttline, waterline)
	centre, starboard = half_ring(station)
	bl, wl = polar(starboard, centre, [abs(theta)])[0]
	r = math.hypot(bl - centre[0], wl - centre[1])
	k = (r + out) / r
	return math.copysign(centre[0] + (bl - centre[0]) * k, theta), centre[1] + (wl - centre[1]) * k


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
	located = {c["windscreen"]["station"], c["bow"]["station"], c["crown"]["station"], c["aft"]["station"]} | {p[0] for p in c["sill"]}
	stations = sorted(set(stations) | {float(x) for x in range(340, 472, 4)} | located)
	rings = []
	for station in stations:
		_, starboard = half_ring(station)
		ring = [at(station, wl, bl) for bl, wl in starboard] + [at(station, wl, -bl) for bl, wl in reversed(starboard[1:-1])]
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
	# 3 in) and its sill rail (the lowest column of the glass) in paint.
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
			frame = station < bow + 3 or max(columns) == limit
			groups["canopy"].append((face, "paint" if frame else "glass"))

	def mesh(entries):
		used = sorted({i for face, _ in entries for i in face})
		index = {old: new for new, old in enumerate(used)}
		return [vertices[i] for i in used], [tuple(index[i] for i in face) for face, _ in entries], [m for _, m in entries]

	node("fuselage", mesh=mesh(groups["body"]))
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
	return [sill * i / SILL for i in range(SILL)] + [sill + (math.pi - sill) * i / (len(ANGLES) - 1 - SILL) for i in range(len(ANGLES) - SILL)]
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
		# the inner wing's upper surface over a buttline, or None off its chord
		leading, chord, _ = wing.station(bl)
		x = (station - (456 - leading.x / INCH)) / chord
		return ORIGIN["waterline"] + wing.point(bl, x, 1).z / INCH if 0 <= x <= 1 and bl >= 40 else None

	# The edge's buttline: the root's plus the span forward of FS 357, then on
	# to the junction's buttline
	knots = [(st, body_at(st, root_line(st)) + smooth(graph, st) * smooth(ratio, st)) for st in (apex, 205, 220, 240, 253, 270, 296, 320, 340, 357)]
	knots.append((junction, reach))
	stations = [apex + (junction - apex) * i / LEX_STATIONS for i in range(LEX_STATIONS + 1)]
	behind = [junction + FAIRING * (i / 12) ** 1.3 for i in range(1, 13)]
	across = 16
	rings, edges, tops = [], [], []
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
			root = root_line(junction) + (edge - root_line(junction)) * e
			thickness = 3.0 * (1 - e) + 0.3 * e
		# behind the junction the root stays on the body's wall at the
		# junction's root height, wherever the root itself has settled
		body = body_at(station, root if station <= junction else root_line(junction)) - 1.0
		edge_bl = max(edge_bl, body + 1.0)
		_, starboard = half_ring(station)
		clearance = 0.25
		if station > junction:
			# its root settles onto the fuselage beside the body's wall, and it
			# hugs what lies beneath ever closer
			floor = beneath(starboard, body + 1.5)
			root = root_line(junction) + ((floor if floor is not None else edge) + 0.05 - root_line(junction)) * e
			clearance = 0.25 * (1 - e) + 0.05 * e
		top = []
		for k in range(across + 1):
			t = k / across
			bl = body + (edge_bl - body) * t
			# the blade's own upper surface: the traced sections' fall from root to edge
			wl = root + 0.5 - (root + 0.5 - edge) * smooth(LEX_FALL, t)
			if station > junction:
				# behind the junction it settles onto what lies beneath
				floor = max([w for w in (beneath(starboard, bl), wing_top(station, bl)) if w is not None], default=wl)
				wl = wl * (1 - e) + (floor + clearance) * e
			if 0 < k < across:
				floor = max([w for w in (beneath(starboard, bl), wing_top(station, bl)) if w is not None], default=None)
				if floor is not None and bl > body + 0.5:
					wl = max(wl, floor + clearance)
			top.append((bl, wl))
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
	normal = (corners[1] - corners[0]).cross(corners[3] - corners[0]).normalized() * (0.25 * INCH)
	vertices = corners + [c + normal for c in corners]
	faces = [(0, 1, 2, 3), (7, 6, 5, 4), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)]
	node(f"lex_fence_{name}", mesh=(vertices, faces))
	MARKS[f"lex_fence_top_front_{name}"] = (corners[3], f"lex_fence_{name}")
	MARKS[f"lex_fence_top_aft_{name}"] = (corners[2], f"lex_fence_{name}")


def exit_distance(centre, half, exponent, origin, direction, reach=120.0):
	# How far along a ray from origin a superellipse (|dx/a|^n + |dy/b|^n <= 1)
	# extends: the farthest inside point, 0 if the ray misses it
	t = np.linspace(0.0, reach, 961)
	x = origin[0] + direction[0] * t - centre[0]
	y = origin[1] + direction[1] * t - centre[1]
	inside = np.abs(x / half[0]) ** exponent + np.abs(y / half[1]) ** exponent <= 1.0
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
# buttline and waterline and half-width and half-height. A nacelle starts at
# the inlet lip, FS 365 (dvids9820808: its outer wall from WL 86 to 112.7),
# runs aft and inboard onto the engine axis by the engine face, and ends at
# the nozzles.
CORE = {
	"top": [(357, 151.3), (405, 150.0), (450, 148.4), (500, 145.6), (540, 140.9), (570, 135), (600, 130), (650, 127), (692, 124)],
	"bottom": [(357, 84.2), (420, 83.5), (500, 84), (560, 85), (620, 88), (692, 93)],
	"half": [(357, 23.2), (404, 24), (450, 22), (550, 20), (650, 17), (692, 12)],
}
NACELLE = [(365, 36.0, 99.4, 9.5, 13.4), (385, 35.5, 100.0, 10.5, 14.0), (420, 33.0, 102.0, 13.0, 15.5), (470, None, 104.5, 17.5, 17.5),
	(520, None, 105.5, 19.5, 18.5), (580, None, 106.0, 21.0, 19.0), (640, None, 106.0, 20.0, 18.5), (692, None, 106.0, 18.5, 17.5)]
NOZZLE = LAYOUT["nozzle"]   # the outer flaps' start and exit, their radii, and the axis's waterline


def union_ring(station, angles=None):
	# The rear fuselage at a station: the smooth union of the central body and
	# the two nacelles, sampled at ANGLES round the central body's mid-height
	top, bottom, half = (between(CORE[k], station) for k in ("top", "bottom", "half"))
	centre = (0.0, (top + bottom) / 2)
	parts = [((0.0, centre[1]), (half, (top - bottom) / 2), 2.6)]
	if station > 365:
		# The nacelles grow in from the inlets' lips, full by FS 404, inside
		# the inlet ducts (inlets()), so the fuselage has no step where they start
		b, w, a, h = nacelle_at(station)
		g = min(1.0, (station - 365) / (404 - 365))
		g = g * g * (3 - 2 * g)
		for side in (1, -1):
			parts.append(((side * b, w), (a * g + 1e-3, h * g + 1e-3), 2.3))
	ring = []
	for theta in angles or angles_at(station, centre):
		direction = (math.sin(theta), math.cos(theta))
		reaches = [exit_distance(c, h, n, centre, direction) for c, h, n in parts]
		r = sum(x ** 10 for x in reaches) ** 0.1
		ring.append((centre[0] + direction[0] * r, centre[1] + direction[1] * r))
	return centre, ring


def nacelle_at(station):
	knots = [(s, (b if b is not None else engine_buttline(s), w, a, h)) for s, b, w, a, h in NACELLE]
	return [between([(s, v[i]) for s, v in knots], station) for i in range(4)]


def inlets():
	# Each inlet's mouth: an open duct from the lip (FS 365) aft into the
	# nacelle, its lip rounded, its interior closed by a plug 15 in down the
	# duct
	lip = NACELLE[0][0]
	wall = 1.5
	for side in (-1, 1):
		name = side_name(side)

		def ring(station, inset):
			b, w, a, h = nacelle_at(station)
			out = []
			for i in range(40):
				t = 2 * math.pi * i / 40
				c, s_ = math.cos(t), math.sin(t)
				x = (abs(s_) ** (2 / 2.3)) * math.copysign(1, s_) * (a - inset)
				y = (abs(c) ** (2 / 2.3)) * math.copysign(1, c) * (h - inset)
				out.append(at(station, w + y, side * (b + x)))
			return out

		rings = [ring(lip + 15, wall), ring(lip + 6, wall), ring(lip + 1.2, wall), ring(lip - 0.4, wall / 2), ring(lip + 1.2, 0)]
		rings += [ring(s, 0) for s in (lip + 6, lip + 15, lip + 25, 400, 410)]
		node(f"inlet_{name}", mesh=loft(rings))
		outer = ring(lip + 1.2, 0)
		MARKS[f"inlet_lip_top_{name}"] = (max(outer, key=lambda v: v.z), f"inlet_{name}")
		MARKS[f"inlet_lip_bottom_{name}"] = (min(outer, key=lambda v: v.z), f"inlet_{name}")
		edge = ring(lip - 0.4, wall / 2)
		CURVES[f"inlet_lip_{name}"] = (edge + edge[:1], f"inlet_{name}")


def cylinder(p0, p1, r0, r1=None, sides=12):
	# A closed tube from p0 to p1, radius r0 tapering to r1
	r1 = r0 if r1 is None else r1
	axis = (p1 - p0).normalized()
	u = axis.orthogonal().normalized()
	v = axis.cross(u)
	rings = [[p + (u * math.cos(2 * math.pi * i / sides) + v * math.sin(2 * math.pi * i / sides)) * (r * INCH) for i in range(sides)]
		for p, r in ((p0, r0), (p1, r1))]
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
	# A thin box on a corner and two edges
	normal = along.cross(across).normalized() * (thickness * INCH)
	p = [corner, corner + along, corner + along + across, corner + across]
	vertices = p + [q + normal for q in p]
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


def gear():
	# The landing gear, built extended on the measured axles (facts.json
	# layout.gear: the photos put them level, so the jet sits a little nose
	# down on its smaller nose tyres) and stored stowed, as the contract rests
	# it. Trunnions, strut rake and the doors are provisional until the gear
	# close-ups (dvids8678626, dvids8678628) are matched.
	g = LAYOUT["gear"]
	main_r, nose_r = g["tyres"]["main"]["diameter"] / 2, g["tyres"]["nose"]["diameter"] / 2
	offset = g["spacing"] / 2   # each nose wheel's centre off the centreline
	down = [[0, 0], [1, 1]]
	for side in (-1, 1):
		name = side_name(side)
		leg = f"gear_{name}"
		axle = at(g["main"], g["axles"]["main"], side * g["track"] / 2)
		foot = at(g["main"] + 1, g["axles"]["main"] + 2, side * (g["track"] / 2 - 8))
		trunnion = at(g["main"] - 4, 99, side * 44)
		extended = (foot - trunnion).normalized()
		stowed = AFT.copy()
		swing = math.acos(max(-1.0, min(1.0, stowed.dot(extended))))
		axis = stowed.cross(extended).normalized()
		# strut swing, then a quarter turn about the strut that stands the
		# wheel up from lying flat in the nacelle
		frames = chain([(trunnion, axis, swing), (trunnion, extended, math.pi / 2)])
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
	# The nose bay's side doors, hinged along its edges, open while the leg is down
	for side in (-1, 1):
		name = side_name(side)
		edge = at(g["nose"] - 50, 87, side * 9)
		door = plate(edge, AFT * (66 * INCH), Vector((0, -side * 8 * INCH, 0)), 0.4)
		node(f"gear_nose_door_{name}", hinge=edge, mesh=door)
		joint(f"gear_nose_door_{name}", AFT, Vector((0, -side, 0)), DOWN, "gear", [[0, 0], [0.15, math.radians(88)], [1, math.radians(88)]])


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
	# Speedbrake: the dorsal panel between the fins, hinged at its forward edge
	front, back, half = 545, 610, 17
	hinge = at(front, between(CORE["top"], front) + 0.4, 0)
	panel = plate(at(front, between(CORE["top"], front) + 0.4, -half), at(back, between(CORE["top"], back) + 0.4, -half) - at(front, between(CORE["top"], front) + 0.4, -half),
		Vector((0, 2 * half * INCH, 0)), 0.5)
	node("speedbrake", hinge=hinge, mesh=panel)
	joint("speedbrake", PORT, AFT, UP, "speedbrake", [[0, 0], [1, math.radians(60)]])
	# Boarding ladder: stowed in a well under the left LEX, it rotates down
	# from its forward beam (NATOPS 2.15.2)
	beam = at(300, 118, -32)
	rails = [cylinder(beam + PORT * (s * 7 * INCH), beam + PORT * (s * 7 * INCH) + AFT * (92 * INCH), 0.8) for s in (-1, 1)]
	rungs = [cylinder(beam + AFT * (k * 11 * INCH) - PORT * (7 * INCH), beam + AFT * (k * 11 * INCH) + PORT * (7 * INCH), 0.5) for k in range(1, 9)]
	node("ladder", hinge=beam, mesh=merge(rails + rungs))
	joint("ladder", PORT, AFT, DOWN, "ladder", [[0, 0], [1, math.radians(68)]])


def nozzles():
	# The nozzles' outer flaps as a tapering ring on each engine axis, open at
	# the exit, until the petals take their place
	for side in (-1, 1):
		name = side_name(side)
		rings = []
		steps = 12
		for station, radius in zip((NOZZLE["start"], NOZZLE["exit"]), NOZZLE["radius"]):
			b = side * engine_buttline(station)
			rings.append([at(station, NOZZLE["waterline"] + radius * math.cos(2 * math.pi * i / 24), b + radius * math.sin(2 * math.pi * i / 24)) for i in range(24)])
		inner = [at(NOZZLE["exit"] - 6, NOZZLE["waterline"] + (NOZZLE["radius"][1] - 1.5) * math.cos(2 * math.pi * i / 24),
			side * engine_buttline(NOZZLE["exit"]) + (NOZZLE["radius"][1] - 1.5) * math.sin(2 * math.pi * i / 24)) for i in range(24)]
		rings.append(inner)
		node(f"nozzle_{name}", mesh=loft(rings))
		for key, ring in (("root", rings[0]), ("exit", rings[1])):
			CURVES[f"nozzle_{key}_{name}"] = (ring + ring[:1], f"nozzle_{name}")
			MARKS[f"nozzle_{key}_bottom_{name}"] = (min(ring, key=lambda v: v.z), f"nozzle_{name}")


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
	grey = np.array(COLOURS["paint"][:3])
	colour = grey[None, None, :] * (0.4 + 0.6 * shade[..., None])
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
	out["speedbrake"] = {"hinge": e(at(545, between(CORE["top"], 545) + 0.4, 0)), "area": round(65 * 34 * INCH * INCH, 3)}
	hard = {}
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
			mount = at(station["station"], station["waterline"], buttline)
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
	for side in (-1, 1):
		fractions = wing(side)
		stabilator(side)
		fractions["rudder"] = fin(side)
	for side in (-1, 1):
		lex(side, widths)
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
