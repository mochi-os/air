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
# A joint driven straight in radians: half a turn either way covers every throw (the nosewheel's 75 deg among
# them), and the engine wraps a wheel's roll into one turn, since a schedule holds at its ends.
IDENTITY = [[-math.pi, -math.pi], [math.pi, math.pi]]


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

	def point(self, u, x, side=0.0, scale=1.0):
		# x chord fraction; side -1 lower, 0 chord plane, 1 upper surface. A
		# scale under 1 shortens the chord from its trailing end, the section
		# still a whole airfoil (a rounded corner, Surface.piece)
		leading, chord, thickness = self.station(u)
		chord *= scale
		y = half(airfoil(thickness), x) * side
		return leading + self.aft * (x * chord * INCH) + self.up * (y * chord * INCH)

	def piece(self, spans, chord, steps=6, end=None, extra=()):
		# The part between span stations spans[0]..spans[1] and chord fractions
		# chord[0]..chord[1], closed at every cut. end, a function of the span
		# station, is the share of the chord a rounded corner leaves (1 where
		# none), and extra adds span stations for its rings
		start, stop = chord
		xs = sorted({start, stop} | {x for x in STATIONS if start < x < stop})
		us = sorted({spans[0] + (spans[1] - spans[0]) * i / steps for i in range(steps + 1)} | {u for u in extra if spans[0] < u < spans[1]})
		rings = []
		for u in us:
			scale = end(u) if end else 1.0
			rings.append([self.point(u, x, 1, scale) for x in xs] + [self.point(u, x, -1, scale) for x in reversed(xs)])
		return loft(rings)

	def rounded(self, radius):
		# The trailing corner at the tip (span station self.length) rounded
		# to radius inches, tangent to the tip and the trailing edge: the
		# share of the chord each station keeps, and the round's span stations
		length = self.length
		tip = length * self.sweep + self.chords[1]
		slope = (tip - self.chords[0]) / length          # the trailing edge's aft run per inch out
		cos = 1 / math.sqrt(1 + slope * slope)
		middle = length - radius                          # the round's centre, inches out
		behind = self.chords[0] + middle * slope - radius / cos   # and inches aft of the root's leading edge
		begins = middle - radius * slope * cos            # where it leaves the trailing edge

		def end(u):
			if u <= begins:
				return 1.0
			chord = self.station(u)[1]
			return (behind + math.sqrt(max(0.0, radius * radius - (u - middle) ** 2)) - u * self.sweep) / chord

		# rings evenly round the arc, so they crowd where it turns to meet the tip
		start = math.atan(slope)
		return end, [middle + radius * math.sin(-start + (math.pi / 2 + start) * k / 12) for k in range(13)]

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


def outward(mesh):
	# A closed mesh's faces turned out: reversed if its signed volume is negative
	vertices, faces = mesh
	volume = sum(Vector(vertices[f[0]]).dot(Vector(vertices[f[i]]).cross(Vector(vertices[f[i + 1]]))) for f in faces for i in range(1, len(f) - 1))
	return mesh if volume > 0 else (vertices, [tuple(reversed(f)) for f in faces])


def merge(pieces):
	vertices, faces = [], []
	for vs, fs in pieces:
		offset = len(vertices)
		vertices += vs
		faces += [tuple(i + offset for i in f) for f in fs]
	return vertices, faces


class Bend:
	# The wing bent up by 1 g of lift (layout.flex): a cantilever from the
	# LEX-wing junction, its lift along the span as the chord and its
	# stiffness as the chord times the section's depth squared (a box as wide
	# as the chord and as deep as the airfoil), streamwise sections rigid, so
	# the bend sets no twist. at(u) gives the rise, inches up the wing's
	# normal, and the slope, radians, u the surface's planform distance out;
	# the tip at the planform's end rises layout.flex.rise
	def __init__(self, surface, root, rise, steps=800):
		self.surface, self.root, self.end = surface, root, surface.length
		h = (self.end - root) / steps
		self.us = [root + h * i for i in range(steps + 1)]
		chords = [surface.station(u)[1] for u in self.us]
		depths = [surface.station(u)[2] / 100 * c for u, c in zip(self.us, chords)]
		# shear and moment from the tip in, then the slope and the rise out
		shear, moment = [0.0] * (steps + 1), [0.0] * (steps + 1)
		for i in range(steps - 1, -1, -1):
			shear[i] = shear[i + 1] + (chords[i] + chords[i + 1]) / 2 * h
			moment[i] = moment[i + 1] + (shear[i] + shear[i + 1]) / 2 * h
		curvature = [m / (c * d * d) for m, c, d in zip(moment, chords, depths)]
		slopes, heights = [0.0], [0.0]
		for i in range(steps):
			slopes.append(slopes[-1] + (curvature[i] + curvature[i + 1]) / 2 * h)
			heights.append(heights[-1] + (slopes[i] + slopes[i + 1]) / 2 * h)
		scale = rise / heights[-1]
		self.slopes, self.heights = [s * scale for s in slopes], [z * scale for z in heights]
		self.lateral = Vector((0, surface.span.y, 0)).normalized()
		self.side, self.up = surface.span.normalized(), surface.up.copy()
		self.axis = self.side.cross(self.up).normalized()   # a positive turn about it lifts the outboard side

	def out(self, p):
		# A point's planform distance out, inches
		return (p - self.surface.root).dot(self.lateral) / INCH

	def at(self, u):
		if u <= self.root:
			return 0.0, 0.0
		if u >= self.end:
			return self.heights[-1] + self.slopes[-1] * (u - self.end), self.slopes[-1]
		f = (u - self.root) / (self.end - self.root) * (len(self.us) - 1)
		i = min(int(f), len(self.us) - 2)
		k = f - i
		return self.heights[i] + (self.heights[i + 1] - self.heights[i]) * k, self.slopes[i] + (self.slopes[i + 1] - self.slopes[i]) * k

	def moved(self, p):
		# Where 1 g of lift takes a point of the wing: its section raised and
		# turned about the section's line in the chord plane
		rise, slope = self.at(self.out(p))
		h = (p - self.surface.root).dot(self.up)
		return p + self.up * (rise * INCH) + (self.up * (math.cos(slope) - 1) - self.side * math.sin(slope)) * h


MATERIALS = {}
# Linear base colours. The paint bake replaces paint's and team's with the atlas
# (layout.paint); lights is the unlit formation strips' pale grey, sRGB 154-163
# in dvids9820808 (the engine lights them at night); burner the afterburner
# duct's soot, sRGB about 28 (the engine sets its glow); stores the pylons',
# tanks' and launchers' grey, the airframe's lower grey (layout.paint lower:
# the real ones carry the airframe's paint), plain: they stay out of the atlas
def linear(srgb):
	c = np.asarray(srgb, float) / 255
	return tuple(float(v) for v in np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)) + (1,)


COLOURS = {"paint": (0.42, 0.45, 0.48, 1), "team": (0.42, 0.45, 0.48, 1), "glass": (0.1, 0.12, 0.14, 0.4),
	"lights": (0.34, 0.35, 0.32, 1), "burner": (0.012, 0.011, 0.010, 1), "display": (0.05, 0.08, 0.05, 1),
	"stores": linear(LAYOUT["paint"]["lower"])}


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
RESTED = {}   # {node: matrix taking a point as the part stands extended to where it rests}
PROBE = []   # the stowed probe's tip
SURFACES = {}
BENDING = {}   # each wing's bend under load, for the stores hung under it
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


# The bend's reach: node to (rotation, translation, slope) of the bend joints
# above it at 1 g, for each node the wing's bend moves (wing() and bent())
FLEX = {}
LOAD = [[-3.0, -3.0], [7.5, 7.5]]   # the lift's load factor, NATOPS's limits, to the bend's share of 1 g
STILL = (Matrix.Identity(3), Vector(), 0.0)


def carried(name):
	# The bend joints' move at 1 g above a node, the nearest that has one
	obj = NODES.get(name) if name else None
	while obj is not None:
		if obj.name in FLEX:
			return FLEX[obj.name]
		obj = obj.parent
	return STILL


def flex_joint(name, bend, point, parent=None):
	# A bend joint at `point` in the wing's chord plane: it turns about the
	# streamwise axis and slides up the wing's normal so that, with any bend
	# joint above it, it carries its children as 1 g of lift carries that
	# point; the keys scale it with the load
	R0, t0, slope0 = carried(parent)
	rise, slope = bend.at(bend.out(point))
	turn = slope - slope0
	R = Matrix.Rotation(turn, 3, bend.axis)
	slide = (point + bend.up * (rise * INCH) - t0 - R0 @ point).dot(R0 @ bend.up)
	node(name, parent=parent, hinge=point)
	JOINTS[name] = {"motion": "bend", "axis": exported(bend.axis), "direction": exported(bend.up), "drive": "load",
		"keys": [[load, round(turn * load, 7), round(slide * load, 7)] for load, _ in LOAD]}
	FLEX[name] = (R0 @ R, R0 @ (point - R @ point + bend.up * slide) + t0, slope)


def bent(name, bend):
	# Gives a node's mesh the bend as the shape key "flex": what 1 g of lift
	# does to it beyond what the bend joints above it carry, in the node's own
	# frame; the "load" drive sets its weight
	obj = NODES[name]
	R, t, _ = carried(name)
	hinge = HINGES[name]
	obj.shape_key_add(name="Basis", from_mix=False)
	key = obj.shape_key_add(name="flex", from_mix=False)
	for i, v in enumerate(obj.data.vertices):
		p = v.co + hinge
		key.data[i].co = v.co + R.transposed() @ (bend.moved(p) - (R @ p + t))
	morphs = {"flex": {"drive": "load", "keys": LOAD}}
	if name in JOINTS:
		JOINTS[name]["morphs"] = morphs
	else:
		JOINTS[name] = {"motion": "morph", "morphs": morphs}
	BENDS[name] = bend


BENDS = {}   # node to the bend its shape key follows (the features file's morphs)


def flexed(name, p):
	# A point's shape-key move on its node, as bent() gives the mesh
	if name not in BENDS:
		return None
	R, t, _ = carried(name)
	return R.transposed() @ (BENDS[name].moved(p) - (R @ p + t))


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
	# the bend under load (layout.flex), from the LEX-wing junction
	flex = LAYOUT["flex"]
	bend = Bend(surface, flex["root"], flex["rise"])
	spans = LAYOUT["surfaces"]
	fold = value(w["fold"])
	areas = value(w["areas"])
	share = value(w["lef"])   # each inboard leading-edge flap's share of the total; each outboard has (1 - 2 x share) / 2
	inner_lef = surface.fraction(areas["lef"] * share, spans["lef"]["inner"])
	outer_lef = surface.fraction(areas["lef"] * (1 - 2 * share) / 2, spans["lef"]["outer"])
	aileron = surface.fraction(areas["aileron"] / 2, spans["aileron"])
	# the flaps' fronts on the hinge line the photos show (layout.hinge), where
	# cr201687's flap area would put them about 5 in behind it
	tef = 1 - LAYOUT["hinge"]["value"]
	inside = 40.0   # the root buried in the fuselage
	# the aileron starts inboard of the fold line: the inner panel stops at its
	# hinge there, and that part of it folds with the outer panel
	node(f"wing_inner_{name}", mesh=surface.panel((inside, fold), [(spans["lef"]["inner"], inner_lef, "front"), (spans["tef"], tef, "back"), (spans["aileron"], aileron, "back")]))
	bent(f"wing_inner_{name}", bend)

	def hinged(joint_name, reach, x, part, arm, want, drive, parent=None, paint="paint"):
		# a hinged surface, under a bend joint at its hinge line's middle
		# that carries it with the bend (flex_<surface>), the rest of the bend
		# in its shape key
		a, b = surface.point(reach[0], x), surface.point(reach[1], x)
		flex_joint(f"flex_{joint_name}", bend, surface.point((reach[0] + reach[1]) / 2, x), parent)
		node(joint_name, parent=f"flex_{joint_name}", hinge=a, mesh=surface.piece(reach, part, steps=max(1, round((reach[1] - reach[0]) / 20))), paint=paint)
		joint(joint_name, b - a, arm, want, drive, IDENTITY)
		bent(joint_name, bend)

	hinged(f"flap_leading_inner_{name}", spans["lef"]["inner"], inner_lef, (0, inner_lef), FORWARD, DOWN, "slat")
	hinged(f"flap_trailing_{name}", spans["tef"], 1 - tef, (1 - tef, 1), AFT, DOWN, f"flaperon.{name}")
	# The outer panel folds about the fold line, carrying its flap and aileron,
	# as far as the photos fold it (layout.fold): NATOPS's folded span holds at
	# any angle past 90 deg, where the panel's foot stands outermost
	a, b = surface.point(fold, 0), surface.point(fold, 1)
	outer = surface.panel((fold, semispan), [(spans["lef"]["outer"], outer_lef, "front"), (spans["aileron"], aileron, "back")])
	high = math.radians(LAYOUT["fold"]["angle"])
	# under a bend joint at the fold line's leading end, which lies on its
	# streamwise axis: the fold line rides the bend unbroken
	flex_joint(f"flex_wing_{name}", bend, a)
	node(f"wing_{name}", parent=f"flex_wing_{name}", hinge=a)
	joint(f"wing_{name}", b - a, Vector((0, -side, 0)), UP, "fold", [[0, 0], [1, round(high, 4)]])
	node(f"wing_outer_{name}", parent=f"wing_{name}", hinge=a, paint="team", mesh=outer)
	bent(f"wing_outer_{name}", bend)
	hinged(f"flap_leading_outer_{name}", spans["lef"]["outer"], outer_lef, (0, outer_lef), FORWARD, DOWN, "slat", parent=f"wing_{name}")
	hinged(f"aileron_{name}", spans["aileron"], 1 - aileron, (1 - aileron, 1), AFT, DOWN, f"flaperon.{name}", parent=f"wing_{name}")
	SURFACES[f"wing_{name}"] = surface
	BENDING[name] = bend
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
	# the flap's and aileron's fronts on the lower surface, where the photos
	# from below see the hinge line (layout.hinge)
	for part, reach_, share in (("flap_trailing", spans["tef"], tef), ("aileron", spans["aileron"], aileron)):
		CURVES[f"hinge_{part}_{name}"] = ([surface.point(reach_[0] + (reach_[1] - reach_[0]) * i / 8, 1 - share, -1) for i in range(9)], f"{part}_{name}")
	underwing(side, surface, spans["aileron"], aileron, bend)
	return {"lef": [inner_lef, outer_lef], "tef": tef, "aileron": aileron}


def underwing(side, surface, reach, aileron, bend):
	# The fairing under each outer panel (layout.wing_fairing): pointed at
	# both ends in plan, widest at its middle; a blunt nose reaching its depth
	# within `nose` inches, that depth to the aileron's hinge, where it ends
	# square; behind it a shallower tail piece on the aileron, tapering to its
	# aft tip. Rounded sections hung from the wing's lower surface (half an
	# inch into it); both fold and flex with the panel, the tail moves with
	# the aileron
	name = side_name(side)
	place = LAYOUT["wing_fairing"]
	(f0, w0, b0), (f1, w1, b1) = place["front"], place["aft"]
	lower = built([f"wing_outer_{name}", f"aileron_{name}"])
	# the aileron's hinge on the lower surface where the fairing crosses it
	a, b = surface.point(reach[0], 1 - aileron, -1), surface.point(reach[1], 1 - aileron, -1)
	across = (b1 - (-a.y / INCH * side)) / ((-b.y + a.y) / INCH * side)
	hinge = (ORIGIN["station"] - a.lerp(b, across).x / INCH)

	def section(station, depth):
		u = (station - f0) / (f1 - f0)
		half = max(0.05, place["width"] / 2 * math.sin(math.pi * min(max(u, 0.0), 1.0)) ** 0.5)
		middle = b0 + (b1 - b0) * u
		hit = lower.ray_cast(at(station, 60.0, side * middle), UP)[0]
		if hit is None:
			raise SystemExit(f"no wing above fairing_wing_{name} at FS {station:.1f}")
		top = ORIGIN["waterline"] + hit.z / INCH + 0.5
		return [at(station, top - (depth + 0.5) * math.sin(math.pi * k / 8), side * (middle - half * math.cos(math.pi * k / 8))) for k in range(9)]

	steps = int(math.ceil((hinge - 0.3 - f0) / 1.5))
	body = [section(f0 + (hinge - 0.3 - f0) * i / steps, place["depth"] * ease(min(1.0, (hinge - 0.3 - f0) * i / steps / place["nose"]))) for i in range(steps + 1)]
	steps = int(math.ceil((f1 - hinge - 0.3) / 1.5))
	tail = [section(hinge + 0.3 + (f1 - hinge - 0.3) * i / steps, max(0.05, place["tail"] * (1 - i / steps) ** 0.8)) for i in range(steps + 1)]
	for part, rings, parent in (("wing", body, f"wing_{name}"), ("aileron", tail, f"aileron_{name}")):
		node(f"fairing_{part}_{name}", parent=parent, hinge=rings[0][4], mesh=outward(loft(rings)))
		bent(f"fairing_{part}_{name}", bend)


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
	# cr201687's planform is the theoretical one; the tip's trailing corner is
	# rounded (layout.stabilator_corner). The corner landmarks stay where the
	# edges' lines meet, as the photos are marked
	end, round_ = surface.rounded(value(LAYOUT["stabilator_corner"]))
	node(f"stabilator_{name}", hinge=pivot, mesh=surface.piece((0, exposed), (0, 1), steps=8, end=end, extra=round_))
	LANDMARKS[f"stabilator_tip_leading_{name}"] = surface.point(exposed, 0)
	LANDMARKS[f"stabilator_tip_trailing_{name}"] = surface.point(exposed, 1)
	MARKS[f"stabilator_tip_leading_{name}"] = (surface.point(exposed, 0), f"stabilator_{name}")
	MARKS[f"stabilator_tip_trailing_{name}"] = (surface.point(exposed, 1), f"stabilator_{name}")
	CURVES[f"stabilator_leading_{name}"] = ([surface.point(exposed * i / 8, 0) for i in range(9)], f"stabilator_{name}")
	trailing = sorted({exposed * i / 8 for i in range(9)} | set(round_))
	CURVES[f"stabilator_trailing_{name}"] = ([surface.point(u, 1, 0, end(u)) for u in trailing], f"stabilator_{name}")
	joint(f"stabilator_{name}", span, AFT, DOWN, f"stabilator.{name}", IDENTITY)


SEAT = (0.5, 12.0, 2.0)   # inches a part mounted on the skin reaches into it, above its foot it is cast down from, and between the points of its foot (fin())


def fairing(name, side, surface, skin, span):
	# The riveted fairing along a fin's root on its outboard side (layout.fin
	# fairing): its upper edge runs up the leading edge from the root's corner
	# to the photos' top line and aft along it on the fin's face, standing
	# `step` off the face (eased in from the leading edge to the line's
	# second point); its foot stands on the nacelle at the photos' buttlines;
	# each section straight from edge to foot, closed inside the fin and the
	# skin along the fin's face carried down to the skin (closed straight from
	# edge to foot, a slab stood off the canted fin over an open crevice, its
	# floor black in the bake); it ends square at the last top point. Returns
	# its front foot, where the leading edge meets the skin
	place = LAYOUT["fin"]["fairing"]
	top, foot = [tuple(p) for p in place["top"]], [tuple(p) for p in place["foot"]]
	face = built([f"fin_{name}"])
	low, high = surface.point(0, 0), surface.point(value(FACTS["fin"]["height"]), 0)

	def source(v):
		return ORIGIN["station"] - v.x / INCH, ORIGIN["waterline"] + v.z / INCH, -v.y / INCH

	(f0, w0, _), (f1, w1, _) = source(low), source(high)
	outward = Vector((0, -side, 0))   # Blender's y is to port
	start, end = f0, top[-1][0]
	rings = []
	steps = int(math.ceil((end - start) / 2.0))
	for i in range(steps + 1):
		station = start + (end - start) * i / steps
		edge = low.lerp(high, (station - f0) / (f1 - f0))   # the leading edge at this station
		line = float(np.interp(station, [p[0] for p in top], [p[1] for p in top]))
		if source(edge)[1] <= line:
			upper = edge
		else:
			origin = at(station, line, side * 90.0)
			upper = face.ray_cast(origin, -outward)[0]
			if upper is None:
				raise SystemExit(f"fin_{name}'s face not found at FS {station:.1f}")
		stand = place["step"] * ease((station - top[0][0]) / (top[1][0] - top[0][0]))
		bl = float(np.interp(station, [p[0] for p in foot], [p[1] for p in foot]))
		hits = crossings(skin, at(station, 160.0, side * bl), DOWN)
		if not hits:
			raise SystemExit(f"no skin beneath fin_{name}'s fairing at FS {station:.1f}")
		lower = at(station, 160.0 - hits[0], side * bl)
		outer = upper + outward * (stand * INCH)
		# inside: just within the fin's face (on the leading edge itself
		# where the fin has no thickness), down that face to half an inch
		# under the skin
		inset = 0.3 * ease((station - start) / 6.0)
		inner = upper - outward * (inset * INCH)
		depth = (inner.z - lower.z) / INCH + 0.5
		root = inner - span * (depth / span.z * INCH)
		ring = [inner] + [outer.lerp(lower, k / 4) for k in range(5)] + [lower + DOWN * (0.5 * INCH), root]
		rings.append(ring)
	vertices, faces = loft(rings)
	# faces out: the outer face's quad at mid-length outboard
	n = len(rings[0])
	middle = (len(rings) // 2) * n
	a, b, c = (Vector(vertices[middle + k]) for k in (2, 3, n + 3))
	if (b - a).cross(c - a).dot(outward) < 0:
		faces = [tuple(reversed(f)) for f in faces]
	node(f"fin_fairing_{name}", mesh=(vertices, faces))
	return rings[0][5]   # the front section's foot


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
	# The root's section carried straight down the fin's plane to SEAT[0]
	# inches inside the built skin, as a fixed part of its own (the fin keeps
	# its cited root, height and area): the photos show the fin and the
	# rudder's lower end standing on the fuselage all along the root
	# (dvids9820808, dvids8842845), while the root is a straight chord at WL
	# 122.5-125 over a deck that falls away aft, so the background showed
	# through beneath it, 5.2 in by the rudder (the user's report). Each point
	# is cast down from SEAT[1] inches above the root, outside the skin
	# The root's section at every airfoil station and every SEAT[2] inches of
	# chord between, on the straight edges the fin's own root ring has there,
	# so the foot follows the deck (with the airfoil's stations alone, 11 in
	# apart, the foot's straight runs stood up to 0.9 in out of it)
	xs = sorted({0.0, 1.0} | {x for x in STATIONS if 0 < x < 1})
	dense = sorted(set(xs) | set(np.linspace(0.0, 1.0, int(math.ceil(root_chord / SEAT[2])) + 1).tolist()))

	def edge(x, face):
		j = min(max(int(np.searchsorted(xs, x, side="right")) - 1, 0), len(xs) - 2)
		f = (x - xs[j]) / (xs[j + 1] - xs[j])
		return surface.point(0, xs[j], face).lerp(surface.point(0, xs[j + 1], face), f)

	ring = [edge(x, 1) for x in dense] + [edge(x, -1) for x in reversed(dense)]
	skin = built(["fuselage"])
	foot = []
	for point in ring:
		hits = crossings(skin, point + span * (SEAT[1] * INCH), -span)
		if not hits:
			raise SystemExit(f"no skin beneath fin_{name}'s root")
		foot.append(point - span * ((max(hits[0] - SEAT[1], 0.0) + SEAT[0]) * INCH))
	# closed across its foot face by face from one side of the section to the
	# other, so the closing faces follow the skin (one face over the whole
	# foot bridged the deck's curve and stood out of it)
	vertices, faces = loft([foot, ring])
	k = len(dense)
	faces = faces[:-2] + [faces[-1]] + [(i, i + 1, 2 * k - 2 - i, 2 * k - 1 - i) for i in range(k - 1)]
	node(f"fin_root_{name}", hinge=root, mesh=(vertices, faces))
	corner = fairing(name, side, surface, skin, span)
	# the antenna pods on the trailing edge below the tip (layout.pods), each
	# straddling the fin on its plane at its waterline; the upper one's blunt
	# end is a landmark
	pieces = []
	for k, (start, end, waterline, diameter) in enumerate(LAYOUT["pods"]["list"]):
		level = height - (place["tip"]["waterline"] - waterline) / math.cos(cant)
		bl = -surface.point(level, 1).y / INCH   # Blender's y is to port
		pieces.append(pod(at(start, waterline, bl), at(end, waterline, bl), diameter / 2))
		if k == 0:
			MARKS[f"pod_aft_{name}"] = (at(end, waterline, bl), f"pod_{name}")
	node(f"pod_{name}", mesh=merge(pieces))
	a, b = surface.point(spans[0], 1 - rudder), surface.point(spans[1], 1 - rudder)
	node(f"rudder_{name}", hinge=a, mesh=surface.piece(spans, (1 - rudder, 1), steps=3), paint="team")
	joint(f"rudder_{name}", b - a, AFT, PORT, "rudder", IDENTITY)
	LANDMARKS[f"fin_tip_leading_{name}"] = surface.point(height, 0)
	LANDMARKS[f"fin_tip_trailing_{name}"] = surface.point(height, 1)
	MARKS[f"fin_tip_leading_{name}"] = (surface.point(height, 0), f"fin_{name}")
	MARKS[f"fin_tip_trailing_{name}"] = (surface.point(height, 1), f"fin_{name}")
	# the root's leading corner as the photos mark it: where the leading
	# edge, its fairing's front, meets the skin
	MARKS[f"fin_root_leading_{name}"] = (corner, f"fin_fairing_{name}")
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
	# the bend starts on a slope), toward the rear fuselage's top line at FS
	# 357 and 404, which the HATP top line agrees with: TP-3111's section at
	# FS 357, scaled off the HATP height, stands 1.3 in lower, and a top line
	# falling to it within 20 in of the canopy creased the spine. Behind the
	# joint the loft (lofted()) takes the top onto the spine's crown; these
	# knots shape the top line's run to the joint
	onto = [(s, smooth(CORE["top"], s) - sum(raw(s)[:2])) for s in (357.0, 404.0)]
	FORE["top"] = [(176.0, 0.0), (184.0, 0.0)] + bends + onto + [(414.0, onto[-1][1])]


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


def fore_outline(station):
	# The forebody's starboard outline at a station before narrowed(), top
	# centreline down, with its keel and height
	F = FORE
	keel, height, width = raw(station)
	height += smooth(F["top"], station) if F["top"] and F["top"][0][0] < station < F["top"][-1][0] else 0.0
	return keel, height, [(x * width, keel + y * height) for x, y in section_shape(station)]


def rounded(outline, pieces=4):
	# A half-outline on a centripetal Catmull-Rom curve through its points,
	# each run cut in `pieces`, mirrored across the centreline at both ends so
	# the top and keel stay level. Sampled straight, the HALF points' runs left
	# the half-ring's columns turning 1 and 13 deg in turn (two columns on one
	# run), which the spine's slope behind the canopy read as a crease
	ghost = [(-outline[1][0], outline[1][1])] + list(outline) + [(-outline[-2][0], outline[-2][1])]
	out = [outline[0]]
	for i in range(1, len(ghost) - 2):
		p = ghost[i - 1:i + 3]
		gaps = [max(math.hypot(b[0] - a[0], b[1] - a[1]), 1e-9) ** 0.5 for a, b in zip(p, p[1:])]
		t = [0.0, gaps[0], gaps[0] + gaps[1], gaps[0] + gaps[1] + gaps[2]]

		def mix(a, b, ta, tb, u):
			f = (u - ta) / (tb - ta)
			return (a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f)

		for k in range(1, pieces + 1):
			u = t[1] + (t[2] - t[1]) * k / pieces
			a1, a2, a3 = mix(p[0], p[1], t[0], t[1], u), mix(p[1], p[2], t[1], t[2], u), mix(p[2], p[3], t[2], t[3], u)
			b1, b2 = mix(a1, a2, t[0], t[2], u), mix(a2, a3, t[1], t[3], u)
			out.append(mix(b1, b2, t[1], t[2], u))
	return out


LOFT = (334.0, 412.0)   # the spine behind the canopy, lofted from the joint to the rear fuselage (lofted())
LOFT_GRID = np.linspace(0.0, 1.0, 241)   # shares of a section's height the loft runs along, top centreline (0) to keel (1)
LOFT_ENDS = {}
LOWER = (357.0, 136.0, 142.0)   # the cited section the loft's lower body passes through, and the waterlines (in it) between which its shoulder lets go of it


def gridded(outline):
	# A half-outline (top centreline down to the keel) as (top, keel, its
	# half-widths at LOFT_GRID's shares of its height); rays grazing the
	# outline step its height back up by hundredths, which are held out
	points = np.array(outline, float)
	heights = np.minimum.accumulate(points[:, 1])
	top, keel = heights[0], heights[-1]
	share, first = np.unique((top - heights) / (top - keel), return_index=True)
	return top, keel, np.interp(LOFT_GRID, share, points[first, 0])


def shares_along(points, outline):
	# Each point's share of the way along an outline (an array of points, top
	# centreline down), where it lies nearest
	length = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(outline, axis=0).T))])
	start, edge = outline[:-1], np.diff(outline, axis=0)
	size = np.maximum((edge * edge).sum(1), 1e-12)
	out = []
	for q in np.asarray(points, float):
		f = np.clip(((q - start) * edge).sum(1) / size, 0, 1)
		i = int(np.argmin(np.hypot(*(start + f[:, None] * edge - q).T)))
		out.append((length[i] + f[i] * np.sqrt(size[i])) / length[-1])
	return np.array(out)


def hermite(t, length, a, b, da, db):
	# The cubic from a (slope da) to b (slope db) over length, at t in 0..1
	return (2 * t ** 3 - 3 * t ** 2 + 1) * a + (t ** 3 - 2 * t ** 2 + t) * length * da + (-2 * t ** 3 + 3 * t ** 2) * b + (t ** 3 - t ** 2) * length * db


def leaving(chord, arriving):
	# The slope a cubic leaves its start with, given its chord's slope and the
	# slope it arrives with: straight (no turn at the start), held between
	# level and three times the chord's slope, so a run that falls or rises
	# from end to end does so throughout
	natural = (3 * chord - arriving) / 2
	return np.where(chord > 0, np.clip(natural, 0, 3 * chord), np.where(chord < 0, np.clip(natural, 3 * chord, 0), 0.0))


def loft_outline(station):
	# The loft's outline at a station, as an array of (half-width, height)
	# from the top centreline down: each share of the height on its cubic,
	# the top on the spine's crown
	L = LOFT_ENDS
	length = LOFT[1] - LOFT[0]
	t = (station - LOFT[0]) / length
	x = hermite(t, length, L["xa"], L["xb"], L["leave"], L["arrive"])
	# below the shoulder, through the cited section too
	h0, h1 = LOWER[0] - LOFT[0], LOFT[1] - LOWER[0]
	if station <= LOWER[0]:
		lower = hermite((station - LOFT[0]) / h0, h0, L["xa"], L["xm"], L["lleave"], L["middle"])
	else:
		lower = hermite((station - LOWER[0]) / h1, h1, L["xm"], L["xb"], L["middle"], L["arrive"])
	x = x + L["lower"] * (lower - x)
	keel = float(hermite(t, length, L["ka"], L["kb"], L["kleave"], L["karrive"]))
	crown = [tuple(p) for p in SPINE["crown"]]
	top = smooth(crown, station) + (L["ta"] - smooth(crown, LOFT[0])) * (1 - ease(4 * t)) + (L["tb"] - smooth(crown, LOFT[1])) * ease(4 * t - 3)
	return np.array(tailed(station, list(zip(x.tolist(), (top - LOFT_GRID * (top - keel)).tolist()))))


def lofted(station):
	# The fuselage behind the canopy (LOFT), as (centre, starboard half-ring).
	# Each share of the section's height, top centreline to keel, runs on one
	# cubic from its half-width in the joint's section (the forebody, through
	# the triangulated joint) to the rear fuselage's, arriving with the rear
	# fuselage's own slope and leaving the joint level, so it falls or rises
	# from end to end without turning, slowly at first, as the side seam does
	# (0.05 in an inch over FS 340-370, 0.1 over 384-403); the top runs on the
	# spine's crown. Below the shoulder (LOWER) it passes through the cited FS
	# 357 section as well, on a monotone cubic through the three, which the
	# panel lines traced at FS 359 agree with (the loft between the two ends
	# alone stood 1-1.3 in outside them); the shoulder lets go of it, the
	# section there standing 2-3 in wider than the side seam. The side seam (layout.spine side) is not drawn through:
	# the loft passes within 0.55 in of it (0.7 at FS 384), and drawn through
	# its points, one by one or by a least-squares pull, it narrowed the side
	# behind the joint and let it out again, a 0.2-0.7 in dip then hump. The
	# half-ring's points slide along
	# the outline from their places in the joint's ring to the rear
	# fuselage's (cast as rays from the centre instead, they jumped between
	# the belly's two crossings, a 0.4 in step at FS 387). Blending the
	# forebody's sections into the rear fuselage's union over FS 357-404 and
	# fitting the result to the seam with changes that faded in and out along
	# the way left the side narrowing behind the joint, swelling again at FS
	# 382 and dropping, a dip then a hump the user saw three times
	L = LOFT_ENDS
	length = LOFT[1] - LOFT[0]
	if not L:
		start = flared(LOFT[0], rounded(narrowed(LOFT[0], fore_outline(LOFT[0])[2])))
		(ta, ka, xa), (tb, kb, xb), (_, kc, xc) = gridded(start), gridded(union_ring(LOFT[1], DENSE)[1]), gridded(union_ring(LOFT[1] + 4.0, DENSE)[1])
		arrive, karrive = (xc - xb) / 4.0, (kc - kb) / 4.0
		L.update(xa=xa, xb=xb, ka=ka, kb=kb, ta=ta, tb=tb, arrive=arrive, leave=np.zeros_like(xa),
			karrive=karrive, kleave=float(leaving(np.array((kb - ka) / length), np.array(karrive))))
		tm, km, xm = gridded(rounded(fore_outline(LOWER[0])[2]))
		h0, h1 = LOWER[0] - LOFT[0], LOFT[1] - LOWER[0]
		m0, m1 = (xm - xa) / h0, (xb - xm) / h1
		safe = lambda m: np.where(m == 0, 1.0, m)
		middle = np.where(m0 * m1 > 0, 3 * (h0 + h1) / ((2 * h1 + h0) / safe(m0) + (h1 + 2 * h0) / safe(m1)), 0.0)
		share = (tm - LOFT_GRID * (tm - km) - LOWER[2]) / (LOWER[1] - LOWER[2])
		L.update(xm=xm, middle=middle, lleave=leaving(m0, middle), lower=np.array([ease(f) for f in share]))
		# the joint's ring as the loft's columns have it, and the union's
		L["fa"] = shares_along(half_ring(LOFT[0])[1], loft_outline(LOFT[0]))
		L["fb"] = shares_along(union_ring(LOFT[1])[1], loft_outline(LOFT[1]))
	t = (station - LOFT[0]) / length
	outline = loft_outline(station)
	length_along = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(outline, axis=0).T))])
	want = ((1 - ease(t)) * L["fa"] + ease(t) * L["fb"]) * length_along[-1]
	ring = [(float(np.interp(d, length_along, outline[:, 0])), float(np.interp(d, length_along, outline[:, 1]))) for d in want]
	return (0.0, (outline[0, 1] + outline[-1, 1]) / 2), keeled(station, ring)


def half_ring(station):
	# The fuselage's starboard half at a station, top centreline to keel, as
	# (buttline, waterline) at the half-ring's ANGLES round its centre: the
	# forebody to the joint behind the canopy, the loft to the rear
	# fuselage's union, and the union
	if LOFT[0] < station < LOFT[1]:
		return lofted(station)
	if station >= LOFT[1]:
		return union_ring(station)
	keel, height, outline = fore_outline(station)
	fore = rounded(narrowed(station, outline))
	centre = (0.0, keel + height / 2)
	angles = angles_at(station, centre, fore)
	if station > FLARE[0]:
		fore = flared(station, fore)
	fore = keeled(station, tailed(station, fore))
	return centre, polar(fore, centre, angles)


def keeled(station, outline):
	# layout.belly: the photos put the forebody's keel 0.5-2 in above the
	# HATP line over its aft half while its lower sides fit, so the belly is
	# flatter: the skin within a few inches of the keel (at least 4, and 2.5
	# times the lift) is squashed up onto the photos' keel, nothing above that
	keel = LAYOUT["belly"]["keel"]
	if not keel[0][0] < station < keel[-1][0]:
		return outline
	low = min(y for _, y in outline)
	lift = smooth([tuple(k) for k in keel], station) - low
	if lift <= 0:
		return outline
	band = max(4.0, 2.5 * lift)
	return [(x, low + lift + (y - low) * (band - lift) / band if y < low + band else y) for x, y in outline]


def tailed(station, outline):
	# The canopy's aft end on the photos (layout.canopy tail, the user's
	# decision, 2026-11-05): from the canopy's last top reading its top falls
	# on through the photos' height over the spine's crown at its aft end,
	# and behind that lies on the crown, the spine running flat to the
	# canopy's aft frame as the profiles show it; the outline's part above
	# the crown is squashed to that top. The old model's section laid here
	# (2026-11-04) stood its hood 1.8 in over the crown and its base 2-2.7 in
	# outside the head-on photos' outline beside the canopy
	C = LAYOUT["canopy"]
	aft, last = C["aft"]["station"], max(p[0] for p in C["top"])
	if station <= last:
		return outline
	crown = smooth([tuple(c) for c in LAYOUT["spine"]["crown"]], station)
	top = outline[0][1]
	if top <= crown + 1e-6:
		return outline
	end = smooth([tuple(c) for c in LAYOUT["spine"]["crown"]], aft) + C["tail"]["height"]
	want = smooth([tuple(p) for p in C["top"]] + [(aft, end)], station) if station < aft else crown
	scale = max(0.0, want - crown) / (top - crown)
	return [(x, crown + (y - crown) * scale if y > crown else y) for x, y in outline]


FLARE = (290.0, 0.15, 3.5)   # the station the canopy's aft fairing starts from (its shoulders widest there, WL 146-148), the inches its edge on the glass is rounded over, and how far inside the joint's section it starts round the glass's top
FLARE_BASE = []


def flared(station, outline):
	# The canopy's aft fairing: at each height where the joint's section (the
	# forebody's there, filled out to the triangulated joint, filled()) is
	# wider than the canopy's own section at FLARE[0], the skin widens
	# steadily from the one to the other by the joint, the outline drawn out
	# wherever it stands inside that, the edge rounded over FLARE[1] inches.
	# Above, where the joint is the narrower, the glass's pointed top runs on
	# toward its tip as the photos' outlines put it (layout.canopy glass), and
	# the joint's section rises round it from FLARE[2] inches inside, so the
	# skin closes over the tip onto the spine's top (with the glass alone,
	# the tip's sides dipped an inch below it). The
	# glass's single superellipse, fitted to those outlines near its top,
	# narrowed the shoulders by 0.7 in over FS 290-310 before the fairing
	# swelled them out to the joint, a notch then hump the user saw on each
	# shoulder; dvids7487368, from above, shows broad metal shoulders beside
	# the glass's tip, its lower edge rising off the sill from about FS 310.
	# Carrying the glass's pointed section to its aft end and swelling it out
	# to the joint within 8 in stood a collar round the spine
	if not FLARE_BASE:
		joint = rounded(filled(LOFT[0], narrowed(LOFT[0], fore_outline(LOFT[0])[2])))
		glass = rounded(narrowed(FLARE[0], fore_outline(FLARE[0])[2]))
		FLARE_BASE[:] = [np.array([p[1] for p in reversed(s)]) for s in (joint, glass)] + [np.array([p[0] for p in reversed(s)]) for s in (joint, glass)]
	heights, glass_heights, widths, glass_widths = FLARE_BASE
	share = ease((station - FLARE[0]) / (LOFT[0] - FLARE[0]))
	half = FLARE[1] / 2
	out = []
	for x, y in outline:
		if heights[0] <= y <= heights[-1]:
			joint, start = float(np.interp(y, heights, widths)), float(np.interp(y, glass_heights, glass_widths, right=0.0))
			target = joint - FLARE[2] * (1 - share)
			if joint > start:
				target = max(target, start + (joint - start) * share)
			# drawn out by as much as it stands inside, exactly where that is
			# more than half the rounding, on a parabola where it is less
			d = target - x
			x += d if d >= half else (d + half) ** 2 / (2 * FLARE[1]) if d > -half else 0.0
		out.append((x, y))
	return out


SHOULDER = 8.0   # inches below the canopy's sill over which narrowed() fades out
SCREEN_FADE = 8.0   # inches across the windscreen's front base over which narrowed() fades in
SPINE_FADE = 333.0   # the station by which narrowed() has faded out behind the canopy: the joint there (layout.canopy seam)


def narrowed(station, outline):
	# The canopy's sill (layout.canopy, photo-measured) lies on the skin. The
	# cited sections between FS 184 and 253 leave the skin at its height 2-2.5 in
	# too wide, and the canopy's outline as far outside the rear and head-on
	# photos', so the section above the sill is drawn in across to pass through
	# it, the change fading out over SHOULDER inches below. Ahead of the bow the
	# windscreen's frame sill takes the sill's place, the same way. Behind the
	# canopy's aft end its fairing carries the canopy's section on: each
	# outline point's share of its width that the canopy's aft end keeps,
	# fading out by the joint at SPINE_FADE, where two photos either side put
	# the spine as full as the cited section. Stopping at the aft end stood the
	# spine 0.7-2.1 in proud of the canopy within an inch; fading to FS 357
	# left it 2-2.6 in low at the joint.
	layout = LAYOUT["canopy"]
	front, foot, back = layout["windscreen"]["station"], layout["sill"][0][0], layout["aft"]["station"]
	if station <= front - SCREEN_FADE / 2 or station >= SPINE_FADE:
		return outline
	if station > back:
		weight = ease(1 - (station - back) / (SPINE_FADE - back))
		own = fore_outline(back)[2]
		kept = [e[0] / o[0] if o[0] > 1e-9 else 1.0 for o, e in zip(own, narrowed(back, own))]
		return [(x * (1 - weight * (1 - k)), y) for (x, y), k in zip(outline, kept)]
	if station < foot:
		# ahead of the bow's foot the windscreen's frame sill (layout.canopy
		# screen, traced), running on into the canopy's, fading in across the
		# windscreen's front base
		weight = ease((station - (front - SCREEN_FADE / 2)) / SCREEN_FADE)
		sill = layout["screen"] + layout["sill"]
		b, w = between([(p[0], p[2]) for p in sill], station), between([(p[0], p[1]) for p in sill], station)
	else:
		weight = 1.0
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
	# centreline, its exponent fitted to the outlines in the photos: the
	# windscreen's (layout.canopy screen_glass) held to its station, then the
	# canopy's at the bow's foot and at the aft corner, linear between
	screen = layout["screen_glass"]
	glass = between([(screen[0], screen[1]), (foot, layout["glass"][0]), (layout["sill"][-1][0], layout["glass"][1])], station)
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


JOINT_FILL = []   # (depth below the section's top, half-width to add) knots, from layout.canopy joint


def filled(station, outline):
	# The canopy's aft fairing stands fuller at its shoulders than the cited
	# sections either side (layout.canopy joint, triangulated from two
	# photos either side: up to 1.2 in of half-width at WL 146-150, none at
	# the sill or the top). The fill grows from the canopy's aft end to the
	# joint, where the section passes through it and the loft (lofted())
	# carries it on
	layout = LAYOUT["canopy"]
	back, joint = layout["aft"]["station"], layout["joint"]
	peak = sum(p[0] for p in joint) / len(joint)
	if station <= back:
		return outline
	if not JOINT_FILL:
		knots = [(0.0, 0.0)]
		for fs, wl, bl in joint:
			raw = narrowed(fs, fore_outline(fs)[2])
			width = next(x0 + (x1 - x0) * (wl - y0) / (y1 - y0) for (x0, y0), (x1, y1) in zip(raw, raw[1:]) if (y0 - wl) * (y1 - wl) <= 0 and y0 != y1)
			knots.append((raw[0][1] - wl, bl - width))
		knots.append((max(k[0] for k in knots) + 1.5, 0.0))
		JOINT_FILL[:] = sorted(knots)
	weight = ease((station - back) / (peak - back))
	top = outline[0][1]
	return [(x + weight * smooth(JOINT_FILL, top - y) if top - y < JOINT_FILL[-1][0] else x, y) for x, y in outline]


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
	# and every 2 in along the loft behind the canopy (LOFT), where 4 in between
	# rings creased the spine's shoulder by 3-3.6 deg, and over the tunnel
	# between the nacelles at FS 488-512 (3.6 deg seen from below); every inch
	# where the canopy's fairing sheds its section (narrowed(), to SPINE_FADE);
	# and every 3 in over the nose, where the section widens fastest and the
	# probes, fairings, strips and door sit on the skin: 7-8 in apart, the
	# rings creased it 3 deg each, and the loft's flat facets stood up to 0.3
	# in off the section the fittings follow; every 4 in from the canopy's aft end to
	# the nozzles, where 10-20 in between rings left the spine and nacelles
	# faceted
	stations = sorted(set(stations) | {float(x) for x in range(328, 692, 4)} | {float(x) for x in range(int(LOFT[0]), int(LOFT[1]), 2)} | {float(x) for x in range(488, 514, 2)} | {float(x) for x in range(326, 336)} | {float(x) for x in range(92, 217, 3)} | located
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


GLASS_RAIL = 1.0   # inches of the canopy's sill rail, metal, below the glass ahead of the edge's readings
GLASS_FIT = []


def glass_line(station):
	# The glass's lower edge's waterline at a station (layout.canopy
	# glass_edge): a quadratic fitted to the readings from both photos (rms
	# 0.35 in), never closer to the sill than its rail ahead of them, and
	# carried up from the last reading to the canopy's aft end on the top
	# centreline, where the glass ends in its tip
	layout = LAYOUT["canopy"]
	edge = layout["glass_edge"]
	if not GLASS_FIT:
		GLASS_FIT[:] = list(np.polyfit([p[0] - 290.0 for p in edge], [p[1] for p in edge], 2))
	fit = lambda s: float(np.polyval(GLASS_FIT, s - 290.0))
	rail = sill_point(station)[1] + GLASS_RAIL
	soft = 0.5
	line = (fit(station) + rail + math.sqrt((fit(station) - rail) ** 2 + soft * soft)) / 2
	last, end = max(p[0] for p in edge), layout["aft"]["station"]
	if station > last:
		# the canopy's top there, the photos' height above the spine's crown
		# (layout.canopy tail, tailed())
		tip = smooth([tuple(c) for c in LAYOUT["spine"]["crown"]], end) + layout["tail"]["height"]
		line += (tip - fit(end)) * ease((station - last) / (end - last))
	return line


def glass_edge(vertices, entries):
	# The glass's lower and aft edge: the canopy's faces cut along the
	# glass's lower edge (glass_line()), glass above it, metal below: the
	# canopy's sill rail, the broad panel below the glass toward its aft end
	# that the photos show, and its tip at the canopy's aft end. Ended along
	# the loft's own rings and columns, the glass ran down to the sill at the
	# aft end in steps (the user's report). New points on edges two cut faces
	# share are shared. Adds to vertices; returns the entries
	# a point within a thousandth of an inch of the line is on it, in both
	# pieces of a cut face
	def side(i):
		s = (vertices[i].z / INCH + ORIGIN["waterline"]) - glass_line(ORIGIN["station"] - vertices[i].x / INCH)
		return 0.0 if abs(s) < 1e-3 else s
	made = {}

	def crossing(a, b):
		key = (min(a, b), max(a, b))
		if key not in made:
			sa, sb = side(a), side(b)
			vertices.append(vertices[a] + (vertices[b] - vertices[a]) * (sa / (sa - sb)))
			made[key] = len(vertices) - 1
		return made[key]

	out = []
	for face, kind in entries:
		signs = [side(i) for i in face]
		if kind != "glass" or min(signs) >= 0:
			out.append((face, kind))
			continue
		if max(signs) <= 0:
			out.append((face, "paint"))
			continue
		ahead, behind = [], []
		for k, i in enumerate(face):
			j = face[(k + 1) % len(face)]
			si, sj = signs[k], signs[(k + 1) % len(face)]
			if si >= 0:
				ahead.append(i)
			if si <= 0:
				behind.append(i)
			if (si > 0 and sj < 0) or (si < 0 and sj > 0):
				c = crossing(i, j)
				ahead.append(c)
				behind.append(c)
		out += [(tuple(ahead), "glass"), (tuple(behind), "paint")]
	return out


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
	groups["canopy"] = glass_edge(vertices, groups["canopy"])

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
	# the fixed windscreen's aft arch, where the bow meets it: the same point while the
	# canopy is shut, and what a photo with the canopy raised shows there
	MARKS["windscreen_top"] = (rings[index[round(bow, 1)]][0], "windscreen")
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


def windscreen_edge(station, outline, centre):
	# The windscreen's lower edge ahead of the bow, as an angle round centre:
	# where the outline (top centreline down) first crosses its base line,
	# which runs from the front base on the centreline down to the bow's
	# foot. The photos show the glass reaching its frame along the sides at
	# that height all the way from the front, a wide U in plan, not a point
	layout = LAYOUT["canopy"]
	front, bow = layout["windscreen"]["station"], layout["bow"]["station"]
	w = layout["windscreen"]["waterline"] + (layout["bow"]["foot"] - layout["windscreen"]["waterline"]) * (station - front) / (bow - front)
	for (x0, y0), (x1, y1) in zip(outline, outline[1:]):
		if (y0 - w) * (y1 - w) <= 0 and y0 != y1:
			return math.atan2(x0 + (x1 - x0) * (w - y0) / (y1 - y0), w - centre[1])
	return None


WINDSCREEN_NOSE = 4.0   # inches behind the windscreen's front base over which its edge widens to the base line


def angles_at(station, centre, outline=None):
	# The half-ring's angles: SILL even steps from the top down to the sill's
	# angle, and even steps on to the keel, so one column runs on the sill
	b, w = sill_point(station)
	sill = math.atan2(b, w - centre[1])
	# Ahead of the bow the column follows the windscreen's lower edge (on the
	# outline, where given), rounding into the centreline at its front base
	# over WINDSCREEN_NOSE inches; ahead of that it eases back
	layout = LAYOUT["canopy"]
	front, bow = layout["windscreen"]["station"], layout["bow"]["station"]
	least = 0.03
	edge = windscreen_edge(station, outline, centre) if outline is not None and front <= station < bow else None
	if edge is not None:
		sill = max(least, least + (edge - least) * ease((station - front) / WINDSCREEN_NOSE))
	elif front <= station < bow:
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
	# JOIN, eased in from the loft's end, so the columns stay put where the
	# nacelles join
	weight = ease((station - LOFT[1]) / (JOIN - LOFT[1]))
	if weight > 0:
		even = spread(max(station, JOIN), sill, len(lower))
		lower = [(1 - weight) * a + weight * b for a, b in zip(lower, even)]
	return upper + lower


DENSE = [math.pi * i / 900 for i in range(901)]   # angles for the outline spread() measures along
OUTLINES = {}


def outline(station, start, sided=True):
	# The rear fuselage's outline at a station, densely, from the angle
	# `start` round its centre to the keel: (angles, points, the length along
	# it to each); unsided, without layout.nacelle side
	key = (round(station, 4), sided)
	if key not in OUTLINES:
		OUTLINES[key] = np.array(union_ring(station, DENSE, sided)[1])
	points, theta = OUTLINES[key], np.array(DENSE)
	keep = theta > start
	first = [np.interp(start, theta, points[:, 0]), np.interp(start, theta, points[:, 1])]
	angles = np.concatenate([[start], theta[keep]])
	path = np.vstack([first, points[keep]])
	length = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(path, axis=0).T))])
	return angles, path, length


def spread(station, start, count):
	# `count` angles from `start` to the keel round the rear fuselage's centre
	# at a station, evenly along its outline without layout.nacelle side, as
	# along() spaces them
	angles, _, length = outline(station, start, False)
	return [float(a) for a in np.interp(np.linspace(0.0, length[-1], count), length, angles)]


def along(station, start, count):
	# `count` points from `start` to the keel, evenly along the outline
	# without layout.nacelle side, then at the same angles on the outline
	# with it: spaced along the sided outline, the points under the nacelles
	# moved with the side's length and the blister's edges creased the skin
	# 3.7 deg where the chords between them cut its curve differently from
	# station to station
	angles, _, length = outline(station, start, False)
	turns = np.interp(np.linspace(0.0, length[-1], count), length, angles)
	theta, path, _ = outline(station, start)
	return [(float(np.interp(a, theta, path[:, 0])), float(np.interp(a, theta, path[:, 1]))) for a in turns]



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
		# junction's root height, wherever the root itself has settled: the
		# spine's wall, inboard of the deck that rises past that height under
		# the fairing (the union's outline there jumps out to the deck's shoulder)
		body = (body_at(station, root) if station <= junction else core_at(station, root_line(junction))) - 1.0
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
	# b), or (a, b above the centre, b below it); a may be a pair, (above the
	# centre, below it), or {"in", "out", "sign"}, the half-widths inboard and
	# outboard (outboard where dx has the sign), with the exponent then
	# {"in", "out"} too
	t = np.linspace(0.0, reach, 961)
	x = origin[0] + direction[0] * t - centre[0]
	y = origin[1] + direction[1] * t - centre[1]
	b = np.where(y > 0, half[1], half[-1])
	if isinstance(half[0], dict):
		out = x * half[0]["sign"] > 0
		a = np.where(out, half[0]["out"], half[0]["in"])
		exponent = np.where(out, exponent["out"], exponent["in"])
	else:
		a = np.where(y > 0, half[0][0], half[0][1]) if isinstance(half[0], tuple) else half[0]
	inside = np.abs(x / a) ** exponent + np.abs(y / b) ** exponent <= 1.0
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
# The body's top is the spine's crown the profile measures (layout.spine), to
# FS 500, then on to the tail as fitted: the HATP side view's top line runs
# 1.8-2.9 in above it over FS 455-500. Above its centre the body is narrower
# than below ("upper"), fitted through the spine's flank points.
SPINE = LAYOUT["spine"]
CORE = {
	"top": sorted([(s, w) for s, w in SPINE["crown"] if s >= 357] + [(540, 138.2), (600, 129.6)] + [tuple(p) for p in SPINE["crest"]]),   # FS 540 and 600 as fitted (600 0.4 in under the crown the fit had, which the deck now swells back up); behind and between the fins, the photos' crest
	"bottom": [(357, 84.2), (420, 83.5), (500, 84), (560, 85), (620, 88), (692, 93)],
	"half": [(357, 23.2), (404, 24), (450, 22), (550, 20), (650, 17), (692, 12)],
}


def upper_widths():
	# The body's half-width above its centre: as below it up to the LEX-wing
	# junction, where the forebody has handed over, then through each flank
	# point of layout.spine, which lies on the body's superellipse; narrowing
	# on as it does over the last two points to the speedbrake's front (FS
	# 545), the narrow ridge the photos put ahead of it (layout.spine rear, FS
	# 577), and back to as below it by FS 620. The broad top between the fins
	# is the deck's (deck_top()), not the body's: fitting the body through the
	# speedbrake's side edges stood its shoulders up in a hump at FS 592,
	# behind a dip at the ridge
	def through(s, wl, bl):
		top, bottom = smooth(CORE["top"], s), smooth(CORE["bottom"], s)
		share = abs((wl - (top + bottom) / 2) / ((top - bottom) / 2))
		return (s, bl / (1 - share ** 2.6) ** (1 / 2.6))

	out = [(404.0, smooth(CORE["half"], 404))] + [through(*p) for p in SPINE["flank"]]
	(s0, a0), (s1, a1) = out[-2], out[-1]
	return out + [(545.0, a1 + (a1 - a0) / (s1 - s0) * (545.0 - s1) / 2), (620.0, smooth(CORE["half"], 620))]


CORE["upper"] = upper_widths()
# The deck behind the LEX: a flat top either side of the spine near the LEX
# root's height (layout.spine deck), from the nacelles' tops at JOIN, risen
# by FS 452 under the LEX's fairing; its shoulder falls outboard to WL 123 at BL
# 40.5 (a line the panel tracing triangulated over FS 451-501). Between the fins
# it carries the speedbrake: level to its front, then falling with its side
# edges (layout.spine rear, FS 600-640), each knot DECK_SWELL under them, and
# eased down behind its aft edge before it sinks inside the nacelles and ends
# (ended level with the nacelles' tops, a groove beside the spine opened in one
# ring; sunk onto the nacelles' tops by FS 580, a guess, it left the
# speedbrake's edges 1.4-2.9 in low; sunk straight from its aft edge, it
# creased the skin 6 deg there)
DECK_HALF, DECK_EXPONENT, DECK_END = 44.0, 5.0, 692.0
DECK_SWELL = 0.5   # inches the union swells the deck's top where it meets the spine and nacelles   # its half-width at the nacelles' centre height, its superellipse's exponent
# How far the deck reaches under the nacelles' centre height. The union swells the
# nacelles' sides where the deck's edge runs just inside them (2.4 in at FS 474);
# ending 0.5 in under their centre, it left that swelling as a ledge along each
# nacelle's widest line from FS 452 to 580, a 38 deg fold
DECK_BELOW = 6.0
# the deck's half-width at the nacelles' centre height where layout.nacelle
# side reshapes them: the union lets any part within a tenth of another swell
# it, and the deck's edge left where it was, 3 in inside the narrowed side,
# swelled the face 1.7 in at FS 548 (narrowing the nacelle to make up for it
# pulled its lower side in 2-3 in, where the deck doesn't reach). Solved at
# each station so the outline passes through the side's line, it came out
# 28.2-31.3 in over FS 500-596, jagged by the outline's sampling, and the
# jagged edge creased the side 3.1 deg
DECK_SIDE = 30.0


def deck_top(station):
	# The deck's top at a station, or None where it does not stand above the nacelles
	if not JOIN - 1e-6 <= station <= DECK_END:
		return None
	start = (lambda b, w, a, up, down: w + up)(*nacelle_at(JOIN))
	settled = (lambda b, w, a, up, down: w + up)(*nacelle_at(580.0))
	floor = nacelle_at(DECK_END)[1] + 0.5
	knots = [(JOIN - 4, start), (JOIN, start), (452.0, 128.05)] + [tuple(p) for p in SPINE["deck"] if p[0] > 455] + [(540.0, 126.8)] + [(s, wl - DECK_SWELL) for s, wl, bl in SPINE["rear"] if s >= 590] + [(LAYOUT["speedbrake"]["back"], SPINE["rear"][-1][1] - DECK_SWELL - 1.0), (LAYOUT["speedbrake"]["back"] + 16, SPINE["rear"][-1][1] - DECK_SWELL - 3.0), (DECK_END, floor), (DECK_END + 4, floor)]
	return smooth(knots, station)


def deck_half(station):
	# The deck's half-width at the nacelles' centre height: DECK_HALF over the
	# shoulder the panel tracing measures (FS 451-501), then drawing in on to
	# DECK_END as it sinks into the nacelles, so its edge, just inside their
	# outboard sides, leaves them before it ends (ending at full width, it
	# creased their sides 3-7 deg; drawn in over FS 580-640 only, 4)
	return smooth([(490.0, DECK_HALF), (510.0, DECK_HALF), (640.0, DECK_HALF - 18.0), (DECK_END + 20, DECK_HALF - 18.0)], station)


def core_at(station, waterline):
	# The body's half-width at a waterline (its superellipse alone, without the
	# nacelles or the deck), 0 above or below it
	top, bottom = smooth(CORE["top"], station), smooth(CORE["bottom"], station)
	y = waterline - (top + bottom) / 2
	share = abs(y / ((top - bottom) / 2))
	if share >= 1:
		return 0.0
	return (onward(CORE["upper"], station) if y > 0 else smooth(CORE["half"], station)) * (1 - share ** 2.6) ** (1 / 2.6)


NOZZLE = LAYOUT["nozzle"]   # the outer flaps' start and exit, their radii, and the axis's waterline
# its centre falls from FS 580 onto the nozzles' axis at their start
NACELLE = [(445, 30.3, 103.3, 15.3, 16.5), (470, None, 104.5, 17.5, 17.5), (520, None, 105.5, 19.5, 18.5), (580, None, 106.0, 21.0, 19.0),
	(640, None, 106.0 + (NOZZLE["waterline"] - 106.0) * (640 - 580) / (692 - 580), 20.0, 18.5), (692, None, NOZZLE["waterline"], 18.5, 17.5)]
# The fuselage station where each inlet's outer skin hands over to the rear
# fuselage's nacelle, behind the plug that closes the duct
JOIN = 440.0


def union_ring(station, angles=None, sided=True):
	# The rear fuselage at a station: the smooth union of the central body and
	# the two nacelles, sampled at ANGLES round the central body's mid-height.
	# The nacelles join it whole at JOIN: ahead of that the inlets' own outer
	# skins (inlets()) stand in for them, and the fuselage's ring jumps out to
	# the nacelles between its last station ahead of JOIN and JOIN itself,
	# inside them, behind the plug
	top, bottom, half = (smooth(CORE[k], station) for k in ("top", "bottom", "half"))
	upper = onward(CORE["upper"], station)
	centre = (0.0, (top + bottom) / 2)
	core = ((0.0, centre[1]), ((upper, half), (top - bottom) / 2), 2.6)
	default = angles is None
	turns = angles or angles_at(station, centre)
	flat = nacelle_side(station) if sided and station >= JOIN - 1e-6 else None

	def assembled(outboard):
		# the parts, the nacelles' outboard halves `outboard` wide (with the
		# side's exponent) where layout.nacelle side flattens them, and the
		# deck's edge then drawn in to DECK_SIDE
		parts = [core]
		if station >= JOIN - 1e-6:
			b, w, a, up, down = nacelle_at(station)
			for side in (1, -1):
				if outboard is None:
					parts.append(((side * b, w), (a, up, down), 2.3))
				else:
					parts.append(((side * b, w), ({"in": a, "out": outboard, "sign": side}, up, down), {"in": 2.3, "out": flat[1]}))
			deck = deck_top(station)
			if deck is not None and deck > w + 0.25:
				wide = deck_half(station)
				if outboard is not None:
					# a smooth minimum, so the edge leaves DECK_SIDE for the
					# deck's own taper with no kink
					wide = -math.log(math.exp(-wide) + math.exp(-DECK_SIDE))
				parts.append(((0.0, w), (wide, deck - w, DECK_BELOW), DECK_EXPONENT))
		ring = []
		for theta in turns:
			direction = (math.sin(theta), math.cos(theta))
			reaches = [exit_distance(c, h, n, centre, direction) for c, h, n in parts]
			r = sum(x ** 10 for x in reaches) ** 0.1
			ring.append((centre[0] + direction[0] * r, centre[1] + direction[1] * r))
		return ring

	ring = assembled(None)
	if flat is not None:
		# the side as the photos have it, the deck's edge drawn in (DECK_SIDE);
		# then the two outlines blended point by point by the side's weight
		# (blending the width and exponent moved the corner unevenly and
		# creased the skin 3.4-5 deg in the fades)
		width = flat[0]
		weight = flat[3]
		side = assembled(width)
		ring = [(x0 + (x1 - x0) * weight, y0 + (y1 - y0) * weight) for (x0, y0), (x1, y1) in zip(ring, side)]
	ring = doored(station, ring)
	shape = bay(station, centre, ring) if sided else None
	if angles is DENSE:
		BAYS[(round(station, 4), sided)] = shape
	if shape is not None:
		ring = bayed(centre, ring, shape)
	if default and station >= JOIN - 1e-6:
		# from JOIN aft the steps below the sill are points evenly along the
		# outline itself, its leaps included: where the centre cannot see into
		# a hollow (the tunnel between the nacelles, beside the body's wall
		# under a nacelle's crown) the outline leaps between two rays, and a
		# point cast at an angle near one lands on one side or the other from
		# station to station, twisting the loft's facets
		ring = ring[:SILL] + along(station, angles_at(station, centre)[SILL], len(ring) - SILL)
		# one column pinned to the bay's corner (from the dense outline,
		# which along() has just built): between columns 4-5 in apart the
		# corner was cut off by up to 4 in, by more or less from station to
		# station
		shape = BAYS.get((round(station, 4), True)) if sided else None
		if shape is not None:
			weight, _, corner = shape
			x, y = ring[BAY_COLUMN]
			ring[BAY_COLUMN] = (x + (corner[0] - x) * weight, y + (corner[1] - y) * weight)
	return centre, ring


def nacelle_side(station):
	# layout.nacelle side: between the flap and the stabilator the photos put
	# each nacelle's outer face flatter than its section's superellipse: the
	# formation strips on it (line) inboard of its widest line, its lower
	# corner seen from below (corner) outboard of it. There the outboard half
	# of the section takes the half-width and exponent that pass through both
	# (each's mean point), easing back to
	# the section's own over the fades either side; the inboard half keeps
	# its shape. Returns the side's (half-width, exponent) outboard, the
	# line's waterline and the weight the outline takes it by, or None
	side = LAYOUT["nacelle"]["side"]
	start, end = side["fade"]
	if not start < station < end:
		return None
	line, corner = side["line"], side["corner"]
	first, last = line[0][0], max(line[-1][0], corner[-1][0])
	weight = ease((station - start) / (first - start)) if station < first else ease((end - station) / (end - last)) if station > last else 1.0
	b, w, a, up, down = nacelle_at(station)
	# one point of each for the whole side (the strips' ends 0.3 in apart):
	# held past their ends, points interpolated along the stations creased
	# the skin where they stopped
	lw, lb = (float(np.mean([p[k] for p in line])) for k in (1, 2))
	cw, cb = (float(np.mean([p[k] for p in corner])) for k in (1, 2))

	def reach(n):
		# the half-width through the line's point at exponent n, and how far
		# outside the superellipse the corner's point then lies
		height = up if lw > w else down
		width = (lb - b) / (1 - abs((lw - w) / height) ** n) ** (1 / n)
		return width, abs((cb - b) / width) ** n + abs((cw - w) / (up if cw > w else down)) ** n - 1

	low, high = 2.3, 8.0
	if reach(low)[1] <= 0:
		n = low
	else:
		for _ in range(50):
			middle = (low + high) / 2
			low, high = (middle, high) if reach(middle)[1] > 0 else (low, middle)
		n = (low + high) / 2
	width = reach(n)[0]
	return width, n, lw, weight


def doored(station, ring):
	# layout.nacelle door: closed, the main gear doors stand below each
	# nacelle as a long blister, which the HATP figure's wind-tunnel model
	# lacks. Across the doors' span the outline under the nacelle is lowered
	# onto the doors' line, the lowering easing out over 4 in inside each edge
	# and over a band above the bottom (4 in and 1.5 times the depth), so the
	# tunnel between the nacelles and their outer sides keep their shape. The
	# fades are eased and the band grows smoothly: a clamped linear fade, or a
	# band switching from a floor to a multiple of the depth, kinks the skin
	# where a line along the stations crosses it (3.9 deg at FS 556)
	n = LAYOUT["nacelle"]
	door = [tuple(k) for k in n["door"]]
	if not door[0][0] < station < door[-1][0]:
		return ring
	own = nacelle_bottom(station)
	depth = own - smooth(door, station)
	if depth <= 0:
		return ring
	inner, outer = n["span"]
	band = 4.0 + 1.5 * depth
	out = []
	for x, y in ring:
		across = ease((abs(x) - inner) / 4.0) * ease((outer - abs(x)) / 4.0)
		height = 1.0 - ease((y - own) / band)
		out.append((x, y - depth * across * height))
	return out


BAYS = {}   # {(station, sided): the bay's (weight, polygon, corner) from the dense outline, or None}
BAY_COLUMN = 36   # the half-ring's column nearest the bay's corner all along it (FS 444-612)


def bay(station, centre, ring):
	# layout.nacelle bay: under each nacelle the main gear bay's bottom runs
	# nearly flat out to its outboard edge, where the outer door hangs, and a
	# band rises from that edge to a crease on the nacelle's side, where the
	# section's superellipse rounds 4-8 in higher. A wedge joined to the
	# outline (along each ray from the centre the farther of the two): its
	# bottom eased from the nacelle's lowest point, level there, up to the
	# edge, level again at the edge; straight from the edge to the crease,
	# then up at the crease's buttline until it meets the skin; eased in and
	# out over the fades, point by point.
	# The sided outline only: the loft's columns are spaced on the outline
	# without it (along()). Returns the wedge's weight, its polygon and the
	# corner (the edge's buttline and height), or None
	place = LAYOUT["nacelle"]["bay"]
	f0, f1, f2, f3 = place["fade"]
	if not f0 < station < f3:
		return None
	weight = ease((station - f0) / (f1 - f0)) if station < f1 else ease((f3 - station) / (f3 - f2)) if station > f2 else 1.0
	edge = smooth([tuple(k) for k in place["buttline"]], station)
	points = np.array(ring, float)
	under = points[(points[:, 0] > 12.0) & (points[:, 0] < edge) & (points[:, 1] < centre[1])]
	if not len(under):
		return None
	low = under[np.argmin(under[:, 1])]
	height = max(smooth([tuple(k) for k in place["edge"]], station), low[1])
	crease, beside = place["crease"]
	crease = max(crease, height + 0.5)
	# where the skin, rising outboard of the low point, reaches the crease's
	# buttline: the wedge's top
	top = None
	for (x0, y0), (x1, y1) in zip(ring, ring[1:]):
		if (x0 - beside) * (x1 - beside) <= 0 and x0 != x1:
			y = y0 + (y1 - y0) * (beside - x0) / (x1 - x0)
			if y > crease and y < centre[1] and (top is None or y < top):
				top = y
	if edge <= low[0]:
		return None
	if top is None:
		top = crease   # the skin already outboard of the crease's buttline there
	polygon = [(x, low[1] + (height - low[1]) * ease((x - low[0]) / (edge - low[0]))) for x in np.linspace(low[0], edge, 13)]
	polygon += [(beside, crease), (beside, top + 0.5), (low[0], top + 0.5)]
	return weight, polygon, (edge, height)


def bayed(centre, ring, shape):
	# the outline joined with the bay's wedge (bay()), eased by its weight
	weight, polygon, _ = shape
	out = []
	for x, y in ring:
		dx, dy = x - centre[0], y - centre[1]
		r = math.hypot(dx, dy)
		if r < 1e-9:
			out.append((x, y))
			continue
		d = (dx / r, dy / r)
		far = 0.0
		for (ax, ay), (bx, by) in zip(polygon, polygon[1:] + polygon[:1]):
			ex, ey = bx - ax, by - ay
			den = d[0] * ey - d[1] * ex
			if abs(den) < 1e-12:
				continue
			ox, oy = ax - centre[0], ay - centre[1]
			t = (ox * ey - oy * ex) / den
			u = (ox * d[1] - oy * d[0]) / den
			if t > 0 and -1e-9 <= u <= 1 + 1e-9:
				far = max(far, t)
		reach = r + (max(r, far) - r) * weight
		out.append((centre[0] + d[0] * reach, centre[1] + d[1] * reach))
	return out


def flush(tree, ends, side, width, inward, proud=0.06, under=0.05, steps=6):
	# A flush plate on a built face between two points ([FS, WL, BL] on the
	# right; mirrored for the left), `width` inches across: each of its points
	# cast along `inward` onto the face and stood `proud` off it, its back
	# `under` beneath, so a plate follows the face it is measured on
	(f0, w0, b0), (f1, w1, b1) = ends
	a, b = at(f0, w0, side * b0), at(f1, w1, side * b1)
	across = (b - a).cross(inward).normalized()
	rings = []
	for i in range(steps + 1):
		middle = a.lerp(b, i / steps)
		outer, inner = [], []
		for k in (-1, 1):
			start = middle + across * (k * width / 2 * INCH) - inward * (12 * INCH)
			hit, normal = tree.ray_cast(start, inward)[:2]
			if hit is None:
				raise SystemExit(f"nothing under the plate at {middle}")
			normal = -normal if normal.dot(inward) > 0 else normal
			outer.append(hit + normal * (proud * INCH))
			inner.append(hit - normal * (under * INCH))
		rings.append(outer + inner[::-1])
	return loft(rings)


def lamps():
	# The formation strips and lenses the photos place (layout.strips and
	# lights): the strips on the fins' and the nacelles' outboard faces, the
	# strobes' lenses on the fins' faces, the position lights' on the LEX's
	# edges and the white one closing the right fin's upper pod, each flush
	# on what it stands on. The tip launchers' strips stand on the launchers
	# (stores, step 5) and the lights at the wing's fold on a fairing the
	# build does not carry: those stay points. Lenses' sizes are estimated
	strips, points = LAYOUT["strips"], LAYOUT["lights"]["points"]
	lens = 2.0   # in across a lens, estimated
	for side in (-1, 1):
		name = side_name(side)
		inward = Vector((0, side, 0))   # along the buttline toward the centreline
		fin = built([f"fin_{name}"])
		node(f"formation_fin_{name}", mesh=flush(fin, strips["fin"], side, strips["width"], inward), paint="lights")
		node(f"formation_body_{name}", mesh=flush(built(["fuselage"]), strips["body"], side, strips["width"], inward), paint="lights")
		# the strobes on the fins' faces, cast in along the buttline; the position
		# lights under the LEX's edges, 0.9 in inboard of it, cast up onto it
		for key, part, toward in ((f"strobe_{name}", f"fin_{name}", inward), (f"position_lex_{name}", f"lex_{name}", UP)):
			f, w, b = points[key]["at"]
			ends = [[f - lens / 2, w, abs(b)], [f + lens / 2, w, abs(b)]]
			node(f"lamp_{key}", mesh=flush(built([part]), ends, side, lens, toward), paint="lights")
	# the position lights under the outer panels, on their fairings' noses
	# (layout.wing_fairing), cast aft and up onto the nose; smaller, the nose
	# under 2 in across there; they fold and flex with the panel
	small = 1.2   # in across, estimated
	for side in (-1, 1):
		name = side_name(side)
		f, w, b = points[f"position_fold_{name}"]["at"]
		ends = [[f - small / 2, w, abs(b)], [f + small / 2, w, abs(b)]]
		lamp = f"lamp_position_fold_{name}"
		node(lamp, parent=f"wing_{name}", mesh=flush(built([f"fairing_wing_{name}"]), ends, side, small, (AFT + UP).normalized()), paint="lights")
		bent(lamp, BENDS[f"fairing_wing_{name}"])
	# the tail light: a lens 1 in across on the right fin's upper pod's aft
	# end (2.6 in across), centred on the pod's axis, where the photos put
	# it (layout.lights position_tail, within an inch)
	end = MARKS["pod_aft_right"][0]
	f, w, b = ORIGIN["station"] - end.x / INCH, ORIGIN["waterline"] + end.z / INCH, -end.y / INCH
	ends = [[f - 0.5, w - 0.5, b], [f - 0.5, w + 0.5, b]]
	node("lamp_position_tail", mesh=flush(built(["pod_right"]), ends, 1, 1.0, FORWARD), paint="lights")


def mouth_box():
	# The box round the mouth's outer surface: centre buttline and waterline,
	# half-width and half-height
	if "front" not in MOUTH:
		ring = np.array([(b, w) for _, w, b in mouth_ring(0, 0)])
		low, high = ring.min(axis=0), ring.max(axis=0)
		MOUTH["front"] = ((low[0] + high[0]) / 2, (low[1] + high[1]) / 2, (high[0] - low[0]) / 2, (high[1] - low[1]) / 2)
	return MOUTH["front"]


def nacelle_bottom(station):
	# layout.nacelle: the nacelle's own lowest line, from the lip's bottom down
	# onto the HATP side view's keel line and along it, through the photos'
	# knots (line), then on to the nozzles, on a monotone cubic through the
	# knots; the main gear doors' blister below it is the outline's (doored())
	n = LAYOUT["nacelle"]
	b, w, a, h = mouth_box()
	low, high = n["keel"]
	knots = [(LAYOUT["inlet"]["lip"]["bottom"][0], w - h)]
	knots += [(float(s), profile("keel", s)) for s in range(int(low), int(high) + 1, 4)]
	knots += [tuple(k) for k in n["line"]] + [tuple(k) for k in n["aft"]]
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


SHOWN = [[0, 0], [0.95, 0], [1, 1]]   # a part shown only with its drive nearly full: the gear's folding braces


def gear():
	# The landing gear, built extended on the measured axles (facts.json
	# layout.gear: the photos put them level, so the jet sits a little nose
	# down on its smaller nose tyres) and stored stowed, as the contract rests
	# it. The legs and the doors stand where the photos put them (layout.gear
	# legs and doors); NATOPS 2.10.1 has the main gear retract aft into the
	# fuselage and the nose gear forward; the stowed poses are chosen to lie
	# inside the skin (check.py, shape.stowed).
	g = LAYOUT["gear"]
	legs, doors = g["legs"], g["doors"]
	main_r, nose_r = g["tyres"]["main"]["diameter"] / 2, g["tyres"]["nose"]["diameter"] / 2
	offset = g["spacing"] / 2   # each nose wheel's centre off the centreline
	down = [[0, 0], [1, 1]]
	belly = built(["fuselage"])
	m = legs["main"]
	for side in (-1, 1):
		name = side_name(side)
		leg = f"gear_{name}"
		out = Vector((0, -side, 0))   # outboard
		axle = at(g["main"], g["axles"]["main"], side * g["track"] / 2)
		top = at(m["top"][0], m["top"][1], side * m["top"][2])
		pivot = at(m["pivot"][0], m["pivot"][1], side * m["pivot"][2])
		# the post runs from where the photos see it leave the airframe down to
		# the fork round the pivot boss's inboard end; it retracts about a
		# point 8 in further up its axis, inside the nacelle
		fork = pivot - out * (3.0 * INCH) + UP * (1.5 * INCH)
		extended = (fork - top).normalized()
		trunnion = top - extended * (8.0 * INCH)
		# stowed aft, 19 deg inboard and 3 deg up: the most room round the
		# post and wheel inside the nacelle, the wheel within 14 deg of flat
		inboard, up = math.radians(19), math.radians(3)
		stowed = Vector((-math.cos(up) * math.cos(inboard), side * math.cos(up) * math.sin(inboard), math.sin(up)))
		swing = math.acos(max(-1.0, min(1.0, stowed.dot(extended))))
		axis = stowed.cross(extended).normalized()
		# post swing, then a quarter turn about the post that stands the
		# wheel up from lying flat in the nacelle, each side the mirror of the other
		frames = chain([(trunnion, axis, swing), (trunnion, -side * extended, math.pi / 2)])
		strut_undo, twist_undo = frames[0][2], frames[1][2]
		node(f"{leg}_strut", hinge=trunnion, mesh=rested(merge([cylinder(trunnion, fork, m["post"] / 2),
			cylinder(pivot - out * (4.5 * INCH), pivot + out * (2.5 * INCH), 2.0)]), strut_undo))
		joint(f"{leg}_strut", frames[0][1], AFT, extended, "gear", [[0, 0], [1, swing]])
		# the side brace, which folds as the leg retracts: one rigid part
		# cannot, so it is shown only with the gear down
		brace = [at(f, w, side * b) for f, w, b in m["brace"]]
		node(f"{leg}_brace", parent=f"{leg}_strut", hinge=strut_undo @ brace[0], mesh=rested(cylinder(brace[0], brace[1], 0.9), strut_undo))
		joint(f"{leg}_brace", UP, UP, UP, "gear", SHOWN, motion="show")
		node(f"{leg}_twist", parent=f"{leg}_strut", hinge=frames[1][0])
		joint(f"{leg}_twist", frames[1][1], Vector((0, 0, 1)), Vector((0, 0, 1)), "gear", [[0, 0], [1, math.pi / 2]])
		# the trailing arm, from the pivot back to the wheel's inboard face:
		# the leg's compression turns it about the pivot, the axle rising by
		# the oleo drive's metres
		face = axle - out * (g["tyres"]["main"]["width"] / 2 * INCH)
		eye = pivot.lerp(face, m["shock"][1])
		shock_top = at(m["shock"][0][0], m["shock"][0][1], side * m["shock"][0][2])
		gland = shock_top.lerp(eye, 0.45)
		# the shock absorber, from the airframe to the arm, shown with the gear
		# down as the brace is
		node(f"{leg}_shock", parent=f"{leg}_twist", hinge=twist_undo @ shock_top,
			mesh=rested(merge([cylinder(shock_top, gland, 1.3), cylinder(gland, eye, 1.8)]), twist_undo))
		joint(f"{leg}_shock", UP, UP, UP, "gear", SHOWN, motion="show")
		turn = twist_undo.to_3x3()
		node(f"{leg}_oleo", parent=f"{leg}_twist", hinge=twist_undo @ pivot, mesh=rested(cylinder(pivot, face, 2.6, 1.8), twist_undo))
		joint(f"{leg}_oleo", turn @ out, turn @ (face - pivot), turn @ UP, f"oleo.{name}", [[0, 0], [1, round(1 / (face - pivot).length, 4)]])
		wheel_axis = out
		node(f"{leg}_wheel", parent=f"{leg}_oleo", hinge=twist_undo @ axle, mesh=rested(tyre(axle, wheel_axis, main_r, g["tyres"]["main"]["width"]), twist_undo))
		# the hub's outer face, where a photo shows the wheel's centre
		MARKS[f"axle_main_{name}"] = (twist_undo @ (axle + wheel_axis * (g["tyres"]["main"]["width"] * 0.35 * INCH)), f"{leg}_wheel")
		# its centre, where a head-on photo shows the middle of the tyre
		MARKS[f"wheel_main_{name}"] = (twist_undo @ axle, f"{leg}_wheel")
		joint(f"{leg}_wheel", turn @ wheel_axis, Vector((0, 0, -1)), FORWARD, f"wheel.{name}", IDENTITY)
	# The nose leg: a vertical post, the polished piston below it and the
	# axle trailing behind; it retracts forward; twin wheels; the drag brace
	# up and aft into the bay; the launch bar raised in front
	n = legs["nose"]
	axle = at(g["nose"], g["axles"]["nose"], 0)
	column = n["oleo"][0]
	trunnion = at(column, 102, 0)
	top = at(column, n["oleo"][1], 0)
	extended = DOWN
	# stowed forward and 6 deg up, the twin wheels clear of the forebody's
	# lower skin either side of the bay
	stowed = (FORWARD * math.cos(math.radians(6)) + UP * math.sin(math.radians(6))).normalized()
	swing = math.acos(max(-1.0, min(1.0, stowed.dot(extended))))
	axis = stowed.cross(extended).normalized()
	frames = chain([(trunnion, axis, swing)])
	undo = frames[0][2]
	RESTED["gear_nose_strut"] = undo
	pin = at(n["brace"][0], n["brace"][1], 0)
	lean = math.radians(n["brace"][2])
	reach = (95 - n["brace"][1]) / math.cos(lean)
	bar_pivot, bar_tip = at(*n["bar"]["pivot"], 0), at(*n["bar"]["tip"], 0)
	node("gear_nose_strut", hinge=trunnion, mesh=rested(merge([cylinder(trunnion, top, n["post"] / 2),
		cylinder(at(column, n["bar"]["pivot"][1], 1.6), at(column, n["bar"]["pivot"][1], -1.6), 1.6)]), undo))
	joint("gear_nose_strut", frames[0][1], stowed, extended, "gear", [[0, 0], [1, swing]])
	# the drag brace up and aft into the bay, which folds as the leg retracts:
	# shown with the gear down
	node("gear_nose_brace", parent="gear_nose_strut", hinge=undo @ pin,
		mesh=rested(cylinder(pin, pin + (AFT * math.sin(lean) + UP * math.cos(lean)) * (reach * INCH), 1.9, 1.4), undo))
	joint("gear_nose_brace", UP, UP, UP, "gear", SHOWN, motion="show")
	# the piston from the post's foot to the axle's fitting, which trails aft to the axle
	foot = at(column, g["axles"]["nose"] + 1.5, 0)
	node("gear_nose_oleo", parent="gear_nose_strut", hinge=trunnion, mesh=rested(merge([cylinder(top, foot, n["piston"] / 2),
		cylinder(foot, axle, 1.6)]), undo))
	joint("gear_nose_oleo", undo.to_3x3() @ UP, UP, UP, "oleo.nose", down, motion="slide")
	node("gear_nose_steering", parent="gear_nose_oleo", hinge=undo @ trunnion)
	joint("gear_nose_steering", undo.to_3x3() @ extended, PORT, -PORT, "steering", IDENTITY)
	wheels = merge([tyre(axle + Vector((0, s * offset * INCH, 0)), PORT, nose_r, g["tyres"]["nose"]["width"]) for s in (-1, 1)] +
		[cylinder(axle + Vector((0, -6 * INCH, 0)), axle + Vector((0, 6 * INCH, 0)), 1.2)])
	node("gear_nose_wheel", parent="gear_nose_steering", hinge=undo @ axle, mesh=rested(wheels, undo))
	for side in (-1, 1):
		MARKS[f"axle_nose_{side_name(side)}"] = (undo @ (axle + Vector((0, -side * (offset + g["tyres"]["nose"]["width"] * 0.35) * INCH, 0))), "gear_nose_wheel")
		MARKS[f"wheel_nose_{side_name(side)}"] = (undo @ (axle + Vector((0, -side * offset * INCH, 0))), "gear_nose_wheel")
	joint("gear_nose_wheel", undo.to_3x3() @ PORT, Vector((0, 0, -1)), FORWARD, "wheel.nose", IDENTITY)
	# The launch bar: raised as the photos show it, lowered forward until its
	# tip meets the shuttle 3 in above the deck
	length = (bar_tip - bar_pivot).length / INCH
	ground = g["axles"]["nose"] - nose_r
	raised = math.atan2((bar_tip - bar_pivot).z, (bar_tip - bar_pivot).x)
	lowered = -math.asin(min(1.0, (n["bar"]["pivot"][1] - ground - 3.0) / length))
	node("launch_bar", parent="gear_nose_strut", hinge=undo @ bar_pivot, mesh=rested(cylinder(bar_pivot, bar_tip, 1.6, 1.2, sides=8), undo))
	joint("launch_bar", undo.to_3x3() @ PORT, undo.to_3x3() @ (bar_tip - bar_pivot), undo.to_3x3() @ DOWN, "bar", [[0, 0], [1, round(raised - lowered, 4)]])
	MARKS["launch_bar_tip"] = (undo @ bar_tip, "launch_bar")
	# The strut's lamps (layout.lights gear, natops 2.6.1.5-6): the landing
	# and taxi light, a round sealed beam facing forward on the post's front,
	# and below it the three approach lights' box, its face turned forward
	# and to the left, green above amber above red; each lens's centre where
	# the photos put the light (the approach's the amber one)
	lamp = LAYOUT["lights"]["gear"]
	points = LAYOUT["lights"]["points"]
	f, w, b = points["landing"]["at"]
	radius = lamp["landing"]["diameter"] / 2
	post = column - n["post"] / 2   # the post's front, FS
	housing = [cylinder(at(f + 0.3, w, b), at(post + 1.0, w, b), radius)]
	lenses = [cylinder(at(f, w, b), at(f + 0.4, w, b), radius - 0.3)]
	a_ = lamp["approach"]
	f, w, b = points["approach"]["at"]
	turn = math.radians(a_["facing"])
	facing = FORWARD * math.cos(turn) + PORT * math.sin(turn)   # Blender's y is to port
	sideways = facing.cross(UP).normalized()
	middle = at(f, w, b)
	width, height = a_["box"]
	depth = (middle - at(post + 1.0, w, 0)).dot(-facing) / INCH
	face = middle - facing * (0.1 * INCH)

	def rectangle(centre):
		return [centre + (sideways * (x * width / 2) + UP * (y * height / 2)) * INCH for x, y in ((-1, -1), (1, -1), (1, 1), (-1, 1))]

	housing.append(loft([rectangle(face), rectangle(face - facing * (depth * INCH))]))
	# held on an arm from the box's back to the post's axis
	back = face - facing * (depth * INCH)
	housing.append(cylinder(back + facing * (0.5 * INCH), at(column, w, 0), 0.8, sides=8))
	for k in (1, 0, -1):
		centre = middle + UP * (k * a_["spacing"] * INCH)
		lenses.append(cylinder(centre, centre - facing * (0.4 * INCH), a_["lens"] / 2))
	node("gear_nose_lamps", parent="gear_nose_strut", hinge=undo @ trunnion, mesh=rested(merge(housing), undo))
	node("lamp_gear_nose", parent="gear_nose_strut", hinge=undo @ trunnion, mesh=rested(merge(lenses), undo), paint="lights")

	def door(node_name, outline, hinge, targets, below=True, curve=None):
		# A door cut from the skin inside its plan outline ([FS, BL]), hinged
		# on the skin along `hinge` (two [FS, BL] ends), opened with the gear
		# by the angle that brings its far edge's ends nearest the photos'
		# (targets, [FS, WL, BL] each: an open edge's ends, or its one marked
		# corner). `curve` names its free edge in the features file, an inch
		# apart along the hinge, for the photos' traces of it
		mesh = merge([cut(None, None, below=below, outline=piece) for piece in outline])
		h0, h1 = (draped(belly, f, b, below=below, out=0.15) for f, b in hinge)
		axis = (h1 - h0).normalized()

		def off(v):
			d = v - h0
			return (d - axis * d.dot(axis)).length

		reach = max(off(v) for v in mesh[0])
		edge = [v for v in mesh[0] if off(v) > reach - 0.5 * INCH]
		goals = [at(*t) for t in targets]
		# for each target the far edge's point nearest it along the hinge
		ends = [min(edge, key=lambda v: abs((v - g).dot(axis))) for g in goals]

		def miss(turn):
			R = Matrix.Rotation(turn, 3, axis)
			return sum((h0 + R @ (v - h0) - g).length for v, g in zip(ends, goals))

		turn = min((math.radians(q / 4) for q in range(-600, 601)), key=miss)
		closed = ends[0] - h0
		opened = Matrix.Rotation(turn, 3, axis) @ closed
		node(node_name, hinge=h0, mesh=mesh)
		joint(node_name, axis, closed, opened, "gear", [[0, 0], [0.15, round(abs(turn), 4)], [1, round(abs(turn), 4)]])
		if curve:
			bins = {}
			for v in edge:
				bins.setdefault(round((v - h0).dot(axis) / INCH), []).append(v)
			CURVES[curve] = ([sum(vs, Vector()) / len(vs) for _, vs in sorted(bins.items())], node_name)

	def across(station, hinge, length, toward):
		# The buttline a closed door's far edge reaches, `length` inches along
		# the skin from its hinge at a station, toward a buttline: a rigid
		# panel as long closed as the photos show it open
		start = draped(belly, station, hinge, below=True)
		step = 0.25 if toward > hinge else -0.25
		b = hinge
		while (toward - b) * step > 0 and (draped(belly, station, b + step, below=True) - start).length < length * INCH:
			b += step
		return b

	def opened(hinge, edge):
		# a door's length, hinge to free edge, as the photos show it open
		(f, b), (_, w, c) = hinge, edge
		return math.dist([w, c], [draped(belly, f, b, below=True).z / INCH + 105, b])

	# The nose bay's doors, open while the leg is down (NATOPS 2.10.1): a
	# forward door each side hinged along the bay's sides, closing toward the
	# centreline; behind them a long door and a short aft one on the right,
	# hinged beside the centreline and closing across it
	# (the marks' buttlines are the open doors' outer faces, standing off the
	# skin: each hinge end is on the skin at its mark's height, the free
	# edge's end moved in by as much)
	d = doors["forward"]

	def edge_at(station, height, side):
		# the skin's buttline at a height, cast in along the buttline
		hit = belly.ray_cast(at(station, height, side * 60.0), Vector((0, side, 0)))[0]
		if hit is None:
			raise SystemExit(f"no skin at FS {station}, WL {height}")
		return -hit.y / INCH * side

	for side in (-1, 1):
		ends = [(f, edge_at(f, h, side), b) for (f, b), h in zip(d["hinge"], d["height"])]
		(f0, b0, _), (f1, b1, _) = ends
		edges = [[f, w, side * (b - (mark - on))] for (f, w, b), (_, on, mark) in zip(d["edge"], ends)]
		reach0 = across(f0, side * b0, opened([f0, side * b0], [0, edges[0][1], edges[0][2]]), 0.0)
		reach1 = across(f1, side * b1, opened([f1, side * b1], [0, edges[1][1], edges[1][2]]), 0.0)
		door(f"gear_nose_door_{side_name(side)}", [[[f0, side * b0], [f1, side * b1], [f1, reach1], [f0, reach0]]],
			[[f0, side * b0], [f1, side * b1]], edges, curve=f"door_nose_forward_edge_{side_name(side)}")
	for key in ("long", "aft"):
		d = doors[key]
		(f0, b0), (f1, b1) = d["hinge"]
		(e0, _, _), (e1, _, _) = d["edge"]
		reach0 = across(f0, b0, opened([f0, b0], d["edge"][0]), -20.0)
		reach1 = across(f1, b1, opened([f1, b1], d["edge"][1]), -20.0)
		door(f"gear_nose_door_{key}", [[[f0, b0], [f1, b1], [e1, reach1], [e0, reach0]]], [[f0, b0], [f1, b1]], d["edge"])
	# Each main leg's doors in the blister under its nacelle (layout.nacelle
	# door), each hanging straight down when open: the inner hinged along the
	# blister's inner edge, the outer along its outer edge outboard of the leg
	for side in (-1, 1):
		name = side_name(side)
		# the outer door as tall, closed, along the skin from its hinge as the
		# photos' front edge is open
		d = doors["outer"]
		f0, f1, b = d["hinge"]
		tall = d["front"][0][1] - d["front"][1][1]
		h = draped(belly, f0, side * b, below=True)
		inner = b - 0.5
		while inner > 16 and (draped(belly, f0, side * inner, below=True) - h).length < tall * INCH:
			inner -= 0.25
		# the inner door: forward of the outer door out to its front's
		# outboard corner, aft of it a strip meeting the outer door's inner
		# edge; cut as two convex pieces
		e = doors["inner"]
		g0, g1, c = e["hinge"]
		(a0, _), (a1, _), (tip_f, tip_b) = e["outline"]
		meet = [f0, side * (inner - 0.1)]
		pieces = [[[a0, side * c], [f0, side * c], meet, [tip_f, side * tip_b]], [[f0, side * c], [a1, side * c], [a1, side * (inner - 0.1)], meet]]
		door(f"gear_door_inner_{name}", pieces, [[g0, side * c], [g1, side * c]], [[e["low"][0], e["low"][1], side * c]])
		door(f"gear_door_outer_{name}", [[[f0, side * b], [f1, side * b], [f1, side * inner], [f0, side * inner]]], [[f0, side * b], [f1, side * b]],
			[[d["front"][1][0], d["front"][0][1] - tall, side * b]])


def mechanisms():
	# The arresting hook, the refuelling probe and its door, the speedbrake
	# and the boarding ladder. Placements are provisional: the hook's pivot is
	# located on the reference photo dvids9820808 (FS 641, WL 80); the rest
	# wait on photos that show them open.
	# The keel under the centreline (layout.keel): a narrow wedge from where
	# it leaves the body to the hook's pivot fitting at its aft end, its
	# bottom on the photos' line, rising to the body over its unseen front
	keel = LAYOUT["keel"]
	front, back = keel["stations"]
	(s0, w0), (s1, w1) = keel["bottom"]
	top = 92.0   # inside the body between the nacelles, so the keel joins the skin

	def keel_bottom(station):
		if station >= s0:
			return w0 + (w1 - w0) * min(1.0, (station - s0) / (s1 - s0))
		return top - (top - w0) * ease((station - front) / (s0 - front))

	rings = []
	for station in [front + (back - front) * i / 20 for i in range(21)]:
		half = max(0.25, keel["width"] / 2 * (station - front) / (back - front))
		b = keel_bottom(station)
		# round from the top toward starboard, as the other lofts go
		rings.append([at(station, top, -half), at(station, top, half), at(station, b + 1.0, half), at(station, b, 0.6 * half),
			at(station, b, -0.6 * half), at(station, b + 1.0, -half)])
	hook = LAYOUT["hook"]
	pivot = at(*hook["pivot"], 0)
	fitting = hook["fitting"]
	node("keel", mesh=merge([loft(rings), cylinder(at(hook["pivot"][0], hook["pivot"][1], -fitting["width"] / 2), at(hook["pivot"][0], hook["pivot"][1], fitting["width"] / 2), fitting["radius"])]))
	# Hook: swings sideways on its pivot (NATOPS 2.10.5's lateral liquid
	# spring), then lowers. Stowed, its shank climbs from the pivot into the
	# channel between the nacelles, the shoe tucked between the nozzles
	# (layout.hook): a tapered bar, then the shoe, deeper below the line, its
	# tip at the point
	node("hook_swing", hinge=pivot)
	joint("hook_swing", UP, AFT, -PORT, "swing", IDENTITY)
	tip = at(*hook["point"], 0)
	along = (tip - pivot).normalized()
	side = Vector(at(0, 0, 1) - at(0, 0, 0)).normalized()
	up = side.cross(along).normalized()
	if up.dot(UP) < 0:
		up = -up
	length = (tip - pivot).length / INCH

	def section(distance, width, above, below):
		c = pivot + along * (distance * INCH)
		return [c + up * (above * INCH) - side * (width / 2 * INCH), c + up * (above * INCH) + side * (width / 2 * INCH),
			c - up * (below * INCH) + side * (width / 2 * INCH), c - up * (below * INCH) - side * (width / 2 * INCH)]

	depth, width = hook["shank"]["depth"], hook["shank"]["width"]
	shank = loft([section(0.0, width, depth / 2, depth / 2), section(length - 6, width * 0.7, depth * 0.4, depth * 0.4)])
	# the tip's end face is square to the shank, which climbs: set back by the
	# depth below the line times the climb, its lowest corner lands on the point
	back = (depth / 2 + 0.6) * along.dot(UP)
	shoe = loft([section(length - 6, width * 0.7, depth * 0.4, depth * 0.4), section(length - 5, width, depth / 2, depth / 2 + 1.6),
		section(length - 1.5, width, depth / 2, depth / 2 + 1.6), section(length - back, width * 0.7, depth * 0.35, depth / 2 + 0.6)])
	hooked = merge([shank, shoe])
	node("hook", parent="hook_swing", hinge=pivot, mesh=hooked)
	MARKS["hook_point"] = (tip, "hook")
	MARKS["hook_pivot"] = (pivot, "hook")
	# lowered until the shoe's lowest point lies in the direction the photos'
	# does from the pivot (layout.hook lowered): turned aft towards down. Its
	# distance from the pivot, 2.9 in past the stowed tip's, is unsettled
	lowered = at(*hook["lowered"], 0) - pivot
	aim = math.atan2(lowered.z, lowered.x)

	def lowest(turn):
		c, s = math.cos(turn), math.sin(turn)
		return min((Vector(((v - pivot).x * c - (v - pivot).z * s, 0.0, (v - pivot).x * s + (v - pivot).z * c)) for v in hooked[0]), key=lambda q: q.z)

	travel = min((math.radians(tenth / 10) for tenth in range(400, 1000)), key=lambda turn: abs(math.atan2(lowest(turn).z, lowest(turn).x) - aim))
	joint("hook", PORT, AFT, DOWN, "hook", [[0, 0], [1, round(travel, 4)]])
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
	# hinged at its forward edge (layout.speedbrake)
	sb = LAYOUT["speedbrake"]
	front, back, half = sb["front"], sb["back"], sb["half"]
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


def cut(stations, buttlines, below=False, proud=0.15, under=0.1, outline=None):
	# A thin panel cut from the built fuselage's own skin between two
	# stations and two buttlines, or inside a convex plan `outline` of
	# [FS, BL] corners, on its top or its bottom: its outer face `proud` off
	# every facet, its inner `under` beneath, its edges closed
	bm = bmesh.new()
	bm.from_mesh(NODES["fuselage"].data)
	bmesh.ops.translate(bm, verts=bm.verts, vec=HINGES["fuselage"])
	if outline is None:
		(front, back), ys = stations, sorted(-b * INCH for b in buttlines)
		planes = ((at(front, 0, 0), FORWARD), (at(back, 0, 0), AFT), (Vector((0, ys[1], 0)), PORT), (Vector((0, ys[0], 0)), -PORT))
	else:
		# each edge's vertical plane, its normal pointing away from the middle
		corners = [at(f, 0, bl) for f, bl in outline]
		middle = sum(corners, Vector()) / len(corners)
		planes = []
		for c0, c1 in zip(corners, corners[1:] + corners[:1]):
			normal = (c1 - c0).cross(UP).normalized()
			if normal.dot(c0 - middle) < 0:
				normal = -normal
			planes.append((c0, normal))
	for point, normal in planes:
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
		# pitot-static tube: a strut swept forward and down from the skin and
		# canted outboard to the tube's buttline, the tube pointing forward from
		# its foot
		fore, aft = pitot["root"]
		roots = [on_skin(st, surface_angle(st, pitot["waterline"], side), -0.4) for st in (fore, aft)]
		bl = math.copysign(pitot["buttline"], skin((fore + aft) / 2, surface_angle((fore + aft) / 2, pitot["waterline"], side))[0])
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
	# skin; the dome on the spine's crown
	a = LAYOUT["antennas"]
	for key, half in (("dorsal", 0.3), ("spine", 0.2)):
		(f0, w0), (f1, w1), (f2, w2), (f3, w3) = a[key]
		node(f"antenna_{key}", mesh=prism([(f0, w0 - 1.0), (f1, w1 - 1.0), (f2, w2), (f3, w3)], half))
		MARKS[f"antenna_{key}_tip_front"] = (at(f3, w3, 0), f"antenna_{key}")
	# the blade under the forward fuselage, right of the nose gear's bay,
	# raked aft and canted outboard, its base sunk an inch into the skin
	(f0, w0, b0), (f1, w1, b1), (f2, w2, b2), (f3, w3, b3) = a["ventral"]
	node("antenna_ventral", mesh=slab([at(f0, w0 + 1.0, b0), at(f1, w1 + 1.0, b1), at(f2, w2, b2), at(f3, w3, b3)], 0.4))
	MARKS["antenna_ventral_tip_front"] = (at(f3, w3, b3), "antenna_ventral")
	MARKS["antenna_ventral_tip_aft"] = (at(f2, w2, b2), "antenna_ventral")
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
	# the HUD: two posts and the combiner between them, the posts where the
	# photos put the frame's upper corners
	w = c["widths"]["hud"]
	posts = [cylinder(at(foot_station, foot, b), at(head_station, head, b), 0.4) for b in (-w, w)]
	glass = slab([at(foot_station + 0.5, foot + 0.5, 0.2 - w), at(foot_station + 0.5, foot + 0.5, w - 0.2), at(head_station, head, w - 0.2), at(head_station, head, 0.2 - w)], 0.1)
	node("cockpit_hud", parent="cockpit", mesh=painted([(posts[0], "paint"), (posts[1], "paint"), (glass, "glass")]))
	# the seat: its headbox as the photo shows it, the back raked down along
	# the headbox's front edge, and the pan
	box = c["headbox"]
	(fs0, wl0), (fs1, wl1) = box[0], box[1]
	rake = (fs1 - fs0) / (wl1 - wl0)
	pan = 123.0
	back = [(fs0 - rake * (wl0 - pan), pan), box[0], box[3], (box[3][0] - rake * (box[3][1] - pan + 2), pan - 2)]
	# (the headbox's width the photos'; the back's and the pan's estimated)
	seat = [prism(box, c["widths"]["headbox"]), prism(back, 7.5), block((240.0, back[0][0]), (pan - 3, pan), (-8.0, 8.0))]
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
	# Each nozzle's twelve flaps (layout.petals), round the engine axis from
	# their hinges at the start to the exit, each its own joint,
	# `nozzle_<side>_petal_<k>` from the top round outboard. A flap carries,
	# rigidly:
	# - its outer flap, a curved shell from the hinge to the exit, its aft part
	#   stepped round by a share of its width (the stepped tabs), so the seams
	#   between flaps make a staircase; alternate flaps stand a little proud,
	#   so closed flaps overlap as shingles;
	# - inside, 1.5 in in from the outer flap at the exit, its divergent flap,
	#   the gas path's wall from the exit forward to the throat, and its
	#   convergent flap from the throat forward to the tailpipe (tp3531's);
	# - the lip that closes the gap between the two at the exit.
	# They rest open, as parked; the `nozzle` drive closes them (0 open, 1
	# closed at military power, the gas path's exit at tm100159's radius),
	# which takes the throat in with them to about tm101741's closed throat
	petals = LAYOUT["petals"]
	count, half = petals["count"], math.pi / petals["count"]
	length = NOZZLE["exit"] - NOZZLE["start"]
	deep = 1.5
	skin, seam, proud = 0.25, 0.15, 0.3   # in: the shells' thickness, the gap between flaps, the alternate flaps' stand
	(r0, r1), (s0, s1) = NOZZLE["radius"], (NOZZLE["start"], NOZZLE["exit"])
	# closing turns each flap about its hinge (the outer face's middle at the
	# start) until its inner face's middle at the exit stands at the closed
	# exit's radius (layout.petals.closed)
	inward = (r1 - deep) - r0
	travel = math.atan2(inward, length) - math.asin((petals["closed"] - r0) / math.hypot(length, inward))
	# the gas path at rest (open): the divergent flaps from the exit's inner
	# radius in to the open throat, the convergent flaps from it forward to the
	# tailpipe at their open angle (tp3531 figure 7, its throats tm101741's)
	throat = petals["throat"][1]
	pipe, convergent = petals["tailpipe"], petals["convergent"]
	diverge = math.asin((r1 - deep - throat) / petals["divergent"])
	waist = s1 - petals["divergent"] * math.cos(diverge)            # the throat's station
	opening = math.asin((pipe - throat) / convergent)
	tail = waist - convergent * math.cos(opening)                   # where the convergent flaps start
	step_at = s1 - petals["step"][0] * length                        # the stepped tabs' station
	NOZZLE_WAIST.append(waist)
	jog = petals["step"][1] * 2 * half
	for side in (-1, 1):
		name = side_name(side)
		centre = lambda station: (NOZZLE["waterline"], side * engine_buttline(station))

		def round_at(station, radius, angle):
			# a point at a radius and angle (from the top, + outboard) round the axis
			w, b = centre(station)
			return at(station, w + radius * math.cos(angle), b + side * radius * math.sin(angle))

		def shell(stations, radii, angles, thick, steps=4, across=6):
			# A curved shell between two stations and two angles, its face at
			# radii (linear along it), `thick` further out (or in, negative),
			# closed at every edge
			rings = []
			for i in range(steps + 1):
				f = i / steps
				s = stations[0] + (stations[1] - stations[0]) * f
				r = radii[0] + (radii[1] - radii[0]) * f
				arc = [angles[0] + (angles[1] - angles[0]) * j / across for j in range(across + 1)]
				rings.append([round_at(s, r, a) for a in arc] + [round_at(s, r + thick, a) for a in reversed(arc)])
			return loft(rings)

		def lip(station, radii, angles, across=6):
			# the end wall between two radii at a station, a quarter inch deep
			arc = [angles[0] + (angles[1] - angles[0]) * j / across for j in range(across + 1)]
			return loft([[round_at(station - 0.25, radii[0], a), round_at(station - 0.25, radii[1], a), round_at(station, radii[1], a), round_at(station, radii[0], a)] for a in arc])

		radius_at = lambda station: r0 + (r1 - r0) * (station - s0) / length
		turn = jog * side   # the same turn, seen from behind, on both engines
		for k in range(count):
			angle = 2 * half * k
			lift = proud if k % 2 else 0.0
			gap = seam / 2 / r1
			forward = (angle - half + gap, angle + half - gap)
			aft = (forward[0] + turn, forward[1] + turn)
			pieces = [
				shell((s0, step_at), (r0 + lift, radius_at(step_at) + lift), forward, -skin),
				shell((step_at, s1), (radius_at(step_at) + lift, r1 + lift), aft, -skin, steps=3),
				lip(s1, (r1 - deep + skin - 0.15 * (k % 2), r1 + lift - skin), aft),
				shell((waist, s1), (throat - 0.15 * (k % 2), r1 - deep - 0.15 * (k % 2)), forward, skin),
				shell((tail, waist), (pipe - 0.15 * (k % 2), throat - 0.15 * (k % 2)), forward, skin, steps=2),
			]
			petal = f"nozzle_{name}_petal_{k + 1}"
			hinge = round_at(s0, r0, angle)
			node(petal, hinge=hinge, mesh=merge(pieces))
			radial = (hinge - at(s0, *centre(s0))).normalized()
			tangent = (round_at(s0, r0, angle + 0.01) - round_at(s0, r0, angle - 0.01)).normalized()
			joint(petal, tangent, round_at(s1, r1, angle) - hinge, radial, "nozzle", [[0, 0], [1, -travel]])
			NOZZLE_PARTS.append(petal)
		# the photo match's rings and lowest points, on the bottom flap
		bottom = f"nozzle_{name}_petal_{count // 2 + 1}"
		for key, station, radius in (("root", s0, r0), ("exit", s1, r1)):
			ring = [round_at(station, radius, 2 * half * k) for k in range(count)]
			CURVES[f"nozzle_{key}_{name}"] = (ring + ring[:1], bottom)
			MARKS[f"nozzle_{key}_bottom_{name}"] = (round_at(station, radius, math.pi), bottom)
		# the burner (the Contract's burner_left/right): the faces that glow in
		# the nozzle, the afterburner's duct seen through the throat, from the
		# throat forward, as wide as the throat at full reheat (layout.petals),
		# open aft and closed just aft of the fuselage's closed end, which it
		# hides. Dark until the engine sets their glow and draws the flames. Ten
		# sides keep the distant stage's burner within its 80 triangles
		axis = lambda station: at(station, *centre(station))
		near, far = waist - 0.5, CORE["top"][-1][0] + 0.5
		ring = lambda station: [axis(station) + (round_at(station, throat, 2 * math.pi * i / 10) - axis(station)) for i in range(10)]
		vertices = ring(far) + ring(near)
		faces = [(i, (i + 1) % 10, 10 + (i + 1) % 10, 10 + i) for i in range(10)] + [tuple(range(10))]
		node(f"burner_{name}", paint="burner", mesh=(vertices, faces))


NOZZLE_PARTS = []   # the flaps the paint gives the nozzles' colours (layout.paint.nozzle)
NOZZLE_WAIST = []   # the throat's station at rest

ATLAS = 2048
STRIP = 0.03   # the atlas's share, along its right side, left free for faces unfolded after packing


def paint(directory):
	# Unique UVs for every part in one atlas, then the paint: ambient
	# occlusion baked in Cycles as the shading every skin is laid over (#8),
	# times the paint's grey. Writes the atlas beside the model.
	# the stores stay out: plain grey, no atlas, and hidden from the bake, so
	# a pylon or a tank the loadout leaves off casts no shadow on the wing
	stored = [o for o in bpy.data.objects if o.type == "MESH" and o.material_slots and all(s.material and s.material.name == "stores" for s in o.material_slots)]
	for o in stored:
		o.hide_render = True
	parts = [o for o in bpy.data.objects if o.type == "MESH" and o not in stored]
	bpy.ops.object.select_all(action="DESELECT")
	for o in parts:
		o.select_set(True)
	bpy.context.view_layer.objects.active = parts[0]
	# faces of more than four corners in triangles (as the export writes them):
	# a long, bent cap (a loft's end, fin_root's over the fin's root chord)
	# laid flat in one piece overlapped itself, wherever it was put. No vertex
	# is added, so a mesh's shape keys (the wing's flex) stand as they were
	import bmesh
	for o in parts:
		if any(len(f.vertices) > 4 for f in o.data.polygons):
			mesh = bmesh.new()
			mesh.from_mesh(o.data)
			bmesh.ops.triangulate(mesh, faces=[f for f in mesh.faces if len(f.verts) > 4])
			mesh.to_mesh(o.data)
			mesh.free()
	bpy.ops.object.mode_set(mode="EDIT")
	bpy.ops.mesh.select_all(action="SELECT")
	bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.002, scale_to_bounds=False)
	bpy.ops.object.mode_set(mode="OBJECT")
	stencil_islands(parts)
	unfolded(parts)
	bpy.ops.object.mode_set(mode="EDIT")
	bpy.ops.mesh.select_all(action="SELECT")
	bpy.ops.uv.pack_islands(rotate=True, margin=0.002)
	bpy.ops.object.mode_set(mode="OBJECT")
	# faces the packed atlas lays over others at a texel's centre (a sliver at
	# FS 436-440, two vertices 0.4 in apart within 0.1 texel, which no edge
	# test sees): laid into a strip the packed islands leave free (packed
	# again instead, each pass found new ones: 9, 8, 6, 6 faces)
	for o in parts:
		for loop in o.data.uv_layers.active.data:
			loop.uv = loop.uv * (1 - STRIP)
	strip = {"left": 1 - STRIP, "right": 1.0, "x": 0.0, "y": 0.0, "row": 0.0}
	for _ in range(8):
		if not unfolded(parts, ATLAS, strip):
			break
	else:
		raise SystemExit("faces still lie over others on the packed atlas")
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
	# and which texels are the nozzles' flaps: their objects' index emitted
	for o in parts:
		o.pass_index = 1 if o.name in NOZZLE_PARTS else 0
	indices = []
	for m, geometry, emission in temporary:
		index = m.node_tree.nodes.new("ShaderNodeObjectInfo")
		m.node_tree.links.new(index.outputs["Object Index"], emission.inputs["Color"])
		indices.append((m, index))
	bpy.ops.object.bake(type="EMIT", use_clear=True)
	nozzle = np.array(positions.pixels[:]).reshape(ATLAS, ATLAS, 4)[..., 0] > 0.5
	for m, index in indices:
		m.node_tree.nodes.remove(index)
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
	size = texel_size(where, covered)
	colour = grey * (0.4 + 0.6 * shade[..., None]) * (panels(where, covered, size) * stencils(where, covered, size))[..., None]
	# The nozzles' flaps: bare metal outside; inside, the divergent flaps'
	# faces from the exit to the throat and the dark beyond it, each texel
	# by which way it faces from its engine's axis (layout.paint.nozzle)
	n = p["nozzle"]
	station = ORIGIN["station"] - where[..., 0] / INCH
	buttline = -where[..., 1] / INCH
	waterline = ORIGIN["waterline"] + where[..., 2] / INCH
	axis = np.vectorize(engine_buttline)(np.where(nozzle, station, NOZZLE["start"])) * np.sign(buttline)
	out = np.stack([-(buttline - axis), waterline - NOZZLE["waterline"]], -1)   # the radial direction in Blender's y and z
	out /= np.maximum(np.linalg.norm(out, axis=-1, keepdims=True), 1e-9)
	facing = normal[..., 1] * out[..., 0] + normal[..., 2] * out[..., 1]
	metal = np.array(n["outer"]) / 255
	dark = np.array(n["deep"]) / 255
	divergent = (station >= NOZZLE_WAIST[0]) & (facing < -0.3)
	inside = np.where(divergent[..., None], np.array(n["inner"]) / 255, dark)
	tint = np.where((facing < -0.3)[..., None], inside, metal)
	# the exit's ring of brackets, the faces that look aft, dark
	tint = np.where((normal[..., 0] < -0.7)[..., None], dark, tint)
	# the divergent flaps' cooling holes: columns across each flap, rows
	# along it from the throat to the exit
	columns, rows, hole = n["holes"]
	turn = np.degrees(np.arctan2((buttline - axis) * np.sign(buttline), waterline - NOZZLE["waterline"]))   # nozzles(): from the top, + outboard
	width = 360 / LAYOUT["petals"]["count"]
	across = (turn / width + 0.5) % 1                                  # 0..1 across a flap, its seams at 0 and 1
	along = (station - NOZZLE_WAIST[0]) / (NOZZLE["exit"] - NOZZLE_WAIST[0])
	radius = (NOZZLE["radius"][1] - 1.5) * np.pi * 2 / LAYOUT["petals"]["count"]   # a flap's width at the exit, in
	du = (across * columns % 1 - 0.5) * radius / columns
	dv = (along * rows % 1 - 0.5) * (NOZZLE["exit"] - NOZZLE_WAIST[0]) / rows
	tint = np.where((divergent & (np.hypot(du, dv) < hole))[..., None], dark, tint)
	colour = np.where(nozzle[..., None], tint * (0.4 + 0.6 * shade[..., None]), colour)
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
	for o in stored:
		o.hide_render = False


def texel_size(where, covered):
	# Each texel's size on the jet (metres): the distance to its nearer
	# neighbour across the atlas on the same island (one no more than three
	# times the atlas's usual step away), else the usual step
	steps = []
	for a, b, ok in ((where[:, 1:], where[:, :-1], covered[:, 1:] & covered[:, :-1]), (where[1:], where[:-1], covered[1:] & covered[:-1])):
		d = np.where(ok, np.linalg.norm(a - b, axis=-1), np.nan)
		steps.append(d)
	usual = np.nanmedian(np.concatenate([s.ravel() for s in steps]))
	size = np.full(where.shape[:2], np.inf)
	for axis, d in enumerate(steps):
		d = np.where(d < 3 * usual, d, np.inf)
		pad = ((0, 0), (0, 1)) if axis == 0 else ((0, 1), (0, 0))
		size = np.minimum(size, np.pad(d, pad, constant_values=np.inf))
		pad = ((0, 0), (1, 0)) if axis == 0 else ((1, 0), (0, 0))
		size = np.minimum(size, np.pad(d, pad, constant_values=np.inf))
	return np.where(np.isfinite(size), size, usual)


def panels(where, covered, size):
	# The panel lines' shading over the atlas (layout.panels): 1 where none
	# runs, darker by the share of each texel (size, its width on the jet) a
	# line covers. Each texel's place on the jet (where, Blender's axes,
	# metres) is measured against the lines: rings round the fuselage at a
	# station, and polylines given on the skin. A texel wholly on or off a
	# line by its centre broke lines narrower than two texels into dots
	p = LAYOUT["panels"]
	factor = np.ones(where.shape[:2])
	half = p["width"] * INCH / 2
	points = where[covered]
	texel = size[covered]
	reach = half + texel.max() / 2
	order = np.argsort(points[:, 0])
	xs = points[order, 0]
	gap = np.full(len(points), np.inf)

	def between_x(lo, hi):
		return order[np.searchsorted(xs, lo): np.searchsorted(xs, hi)]

	for station in p.get("rings", []):
		x = at(station, ORIGIN["waterline"], 0).x
		pick = between_x(x - reach, x + reach)
		gap[pick] = np.minimum(gap[pick], np.abs(points[pick, 0] - x))
	mirrored = p.get("mirrored", [])
	skin = built([n for n, o in NODES.items() if o.type == "MESH"])
	for k, line in enumerate(p.get("lines", []) + mirrored + [[(s, w, -b) for s, w, b in line] for line in mirrored]):
		corners = on_parts(skin, [at(*c) for c in line], k)
		for a, b in zip(corners, corners[1:]):
			a, b = np.array(a), np.array(b)
			pick = between_x(min(a[0], b[0]) - reach, max(a[0], b[0]) + reach)
			if not len(pick):
				continue
			q = points[pick]
			d = b - a
			t = np.clip(((q - a) @ d) / max(d @ d, 1e-12), 0, 1)
			gap[pick] = np.minimum(gap[pick], np.linalg.norm(q - (a + t[:, None] * d), axis=1))
	# the share of a texel's width within half the line's width of the line
	share = np.clip((np.minimum(gap + texel / 2, half) - np.maximum(gap - texel / 2, -half)) / texel, 0, 1)
	factor[covered] = 1 - (1 - p["shade"]) * share
	# the slot along each LEX's root (layout.lex slot), an opening painted as
	# a dark band its width wide until the paint is traced
	slot = LAYOUT["lex"]["slot"]
	half = slot["width"] * INCH / 2
	reach = half + texel.max() / 2
	gap = np.full(len(points), np.inf)
	for sign in (1, -1):
		ends = [at(f, w, b * sign) for f, w, b in (slot["front"], slot["aft"])]
		laid = on_parts(skin, ends, "lex slot")
		for a, b in zip(laid, laid[1:]):
			a, b = np.array(a), np.array(b)
			pick = between_x(min(a[0], b[0]) - reach, max(a[0], b[0]) + reach)
			q = points[pick]
			d = b - a
			t = np.clip(((q - a) @ d) / max(d @ d, 1e-12), 0, 1)
			gap[pick] = np.minimum(gap[pick], np.linalg.norm(q - (a + t[:, None] * d), axis=1))
	share = np.clip((np.minimum(gap + texel / 2, half) - np.maximum(gap - texel / 2, -half)) / texel, 0, 1)
	factor[covered] = np.minimum(factor[covered], 1 - (1 - slot["shade"]) * share)
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


STENCIL = 40   # pixels per inch the stencils are drawn at before they are laid on the atlas
STENCIL_DENSITY = 4.0   # the stencils' skin's texels per inch, against the rest's
STENCIL_MARGIN = 1.5    # inches round each stencil its own island reaches


def stencil_frames():
	# Each stencil (layout.stencils) on each side as (spec, centre, across, up,
	# normal): flat in the plane touching the built skin at its middle, its
	# lettering reading forward on the right and aft on the left. The ray from
	# the section's centre leans 33 deg off the side wall's normal there: a
	# plane square to it left the warning box's top and bottom 2-2.5 in off
	# the skin, and they went undrawn
	p = LAYOUT["stencils"]
	tree = built(["fuselage"])
	out = []
	for key, spec in p.items():
		if not isinstance(spec, dict):
			continue
		for side in (-1, 1):
			station, waterline = spec["at"]
			theta = surface_angle(station, waterline, side)
			centre, normal, _, _ = tree.find_nearest(on_skin(station, theta))
			normal = normal.normalized()
			if normal.dot(on_skin(station, theta, 1.0) - centre) < 0:
				normal = -normal
			up = (UP - normal * UP.dot(normal)).normalized()
			out.append((spec, centre, up.cross(normal), up, normal))
	return out


def stencil_islands(parts):
	# The skin under each stencil on its own UV island, STENCIL_DENSITY times
	# as dense as smart_project left the rest and laid flat in the stencil's
	# plane, before the islands are packed: at the atlas's own texel (about 6
	# mm) lettering half an inch high read as speckle. A face joins a
	# stencil's island with a corner within STENCIL_MARGIN of it, facing its
	# way and within 2 in of its plane: the LEX's root, lying under the warning
	# box's margin, took the same place on the island and the bake wrote it
	# over the box's corner
	area, mapped = 0.0, 0.0
	for o in parts:
		uv = o.data.uv_layers.active.data
		for f in o.data.polygons:
			q = [uv[i].uv for i in f.loop_indices]
			mapped += abs(sum(a.x * b.y - b.x * a.y for a, b in zip(q, q[1:] + q[:1]))) / 2
			area += f.area
	scale = math.sqrt(mapped / area) * STENCIL_DENSITY   # UV units per metre on the islands
	for k, (spec, centre, across, up, normal) in enumerate(stencil_frames()):
		reach = [(s / 2 + STENCIL_MARGIN) * INCH for s in spec["size"]]
		joined = 0
		for o in parts:
			mesh, world = o.data, o.matrix_world
			turn = world.to_3x3()
			corners = [world @ v.co - centre for v in mesh.vertices]
			inside = [abs(c.dot(normal)) < 3 * INCH and abs(c.dot(across)) < reach[0] and abs(c.dot(up)) < reach[1] for c in corners]
			uv = mesh.uv_layers.active.data
			for f in mesh.polygons:
				if not any(inside[i] for i in f.vertices) or (turn @ f.normal).normalized().dot(normal) < 0.5 or abs((world @ f.center - centre).dot(normal)) > 2 * INCH:
					continue
				joined += 1
				for i in f.loop_indices:
					c = corners[mesh.loops[i].vertex_index]
					uv[i].uv = (2.0 + k + c.dot(across) * scale, 2.0 + c.dot(up) * scale)
		if not joined:
			raise SystemExit(f"stencil {k}: no skin facing it within its margin (layout.stencils)")


def flattened(mesh, triangles):
	# A face's corners laid flat, triangle by triangle (its loop triangles,
	# the split the export writes), each opened about the edge it shares with
	# one already laid: {loop: (x, y)} in metres. Projected onto one plane, a
	# twisted quad folded into a bow tie whose two halves lay over each other
	point = lambda loop: mesh.vertices[mesh.loops[loop].vertex_index].co
	a, b, c = triangles[0]
	along = (point(b) - point(a)).normalized()
	normal = (point(b) - point(a)).cross(point(c) - point(a)).normalized()
	across = normal.cross(along)
	flat = {a: (0.0, 0.0), b: ((point(b) - point(a)).length, 0.0), c: ((point(c) - point(a)).dot(along), (point(c) - point(a)).dot(across))}
	laid = [triangles[0]]
	waiting = list(triangles[1:])
	while waiting:
		for triangle in waiting:
			known = [l for l in triangle if l in flat]
			if len(known) < 2:
				continue
			p, q = known[:2]
			r = next(l for l in triangle if l not in (p, q))
			if r in flat:
				waiting.remove(triangle)
				break
			# the side the laid triangle on this edge lies on (else the laid corners' middle)
			other = next((l for t in laid if p in t and q in t for l in t if l not in (p, q)), None)
			P, Q = (Vector((*flat[l], 0.0)) for l in (p, q))
			O = Vector((*flat[other], 0.0)) if other is not None else sum((Vector((*v, 0.0)) for v in flat.values()), Vector()) / len(flat)
			edge = Q - P
			length = edge.length
			d1, d2 = (point(r) - point(p)).length, (point(r) - point(q)).length
			x = (d1 * d1 - d2 * d2 + length * length) / (2 * length)
			y = math.sqrt(max(d1 * d1 - x * x, 0.0))
			unit = edge / length
			side = Vector((-unit.y, unit.x, 0.0))
			if side.dot(O - P) > 0:
				side = -side
			R = P + unit * x + side * y
			flat[r] = (R.x, R.y)
			laid.append(triangle)
			waiting.remove(triangle)
			break
		else:
			break
	return flat


def unfolded(parts, size=ATLAS * 2, strip=None):
	# Faces lying over others on the islands (a curved surface turning back
	# past the plane smart_project laid it on, a sliver, or a twisted quad's
	# two halves) each get an island of their own, laid flat at the islands'
	# density: the bake wrote one over the other, 225 texels in all, most in
	# the cockpit tub and the LEXes (check.py paint.overlap). Faces are seen
	# as the export splits them (loop triangles), and only on the islands in
	# the unit square: the stencils' lie outside it until packed. Run again
	# on the packed atlas at its own size, it catches what packing's scaling
	# brought onto a texel's centre, and lays those faces into `strip`, a
	# shelf of the atlas the packed islands leave free, packing nothing again
	area, mapped = 0.0, 0.0
	for o in parts:
		uv = o.data.uv_layers.active.data
		for f in o.data.polygons:
			q = [uv[i].uv for i in f.loop_indices]
			mapped += abs(sum(a.x * b.y - b.x * a.y for a, b in zip(q, q[1:] + q[:1]))) / 2
			area += f.area
	scale = math.sqrt(mapped / area)
	placed = 0
	for o in parts:
		mesh = o.data
		uv = mesh.uv_layers.active.data
		mesh.calc_loop_triangles()
		split = {}
		owners, corners = [], []
		for lt in mesh.loop_triangles:
			split.setdefault(lt.polygon_index, []).append(tuple(lt.loops))
			owners.append(lt.polygon_index)
			corners.append([tuple(uv[l].uv) for l in lt.loops])
		if not corners:
			continue
		points = np.array(corners) * size
		owners = np.array(owners)
		lo = np.floor(points.min(1) - 0.5).astype(int)
		span = np.ceil(points.max(1) - 0.5).astype(int) - lo + 1
		cross = lambda a, b: a[..., 0] * b[..., 1] - a[..., 1] * b[..., 0]
		whole = cross(points[:, 1] - points[:, 0], points[:, 2] - points[:, 0])
		hits = []
		for s in np.unique(span.max(1)):
			pick = np.where((span.max(1) == s) & (np.abs(whole) > 1e-12))[0]
			grid = np.stack(np.meshgrid(np.arange(s), np.arange(s), indexing="ij"), -1).reshape(-1, 2)
			for chunk in np.array_split(pick, max(1, len(pick) * s * s // 2000000 + 1)):
				q = lo[chunk, None, :] + grid[None] + 0.5
				a, b, c = (points[chunk, k, None, :] for k in range(3))
				w0, w1 = cross(b - q, c - q) / whole[chunk, None], cross(c - q, a - q) / whole[chunk, None]
				inside = (w0 > 1e-6) & (w1 > 1e-6) & (1 - w0 - w1 > 1e-6) & (q[..., 0] >= 0) & (q[..., 0] < size) & (q[..., 1] >= 0) & (q[..., 1] < size)
				which = np.broadcast_to(owners[chunk, None], inside.shape)[inside]
				x, y = q[..., 0][inside].astype(int), q[..., 1][inside].astype(int)
				hits.append(np.stack([which, y, x], 1))
		hits = np.concatenate(hits) if hits else np.zeros((0, 3), int)
		key = hits[:, 1].astype(np.int64) * size + hits[:, 2]
		_, inverse, counts = np.unique(key, return_inverse=True, return_counts=True)
		folded = set(np.unique(hits[counts[inverse] >= 2, 0]).tolist())
		# and folds too thin to cover a sample: two triangles sharing an edge
		# on an island with their third corners on the same side of it (a
		# sliver at FS 436-440 lay over its neighbour between the samples, and
		# the packed atlas put a texel's centre on it)
		sides = {}
		for k, tri in enumerate(corners):
			for i in range(3):
				e0, e1, w = tri[i], tri[(i + 1) % 3], tri[(i + 2) % 3]
				edge = tuple(sorted((tuple(round(c, 7) for c in e0), tuple(round(c, 7) for c in e1))))
				(x0, y0), (x1, y1) = edge
				side = (x1 - x0) * (w[1] - y0) - (y1 - y0) * (w[0] - x0)
				sides.setdefault(edge, []).append((owners[k], side))
		for pair in sides.values():
			if len(pair) == 2 and pair[0][1] * pair[1][1] > 0:
				folded |= {int(pair[0][0]), int(pair[1][0])}
		if strip is not None and folded:
			print(f"  {o.name}: {sorted(folded)[:12]}")
		for index in folded:
			flat = flattened(mesh, split[index])
			if len(flat) < len(mesh.polygons[index].loop_indices):
				raise SystemExit(f"{o.name}: face {index}'s triangles do not join edge to edge")
			if strip is None:
				for loop, (x, y) in flat.items():
					uv[loop].uv = (-2.0 - placed * 0.01 + x * scale, 2.0 + y * scale)
			else:
				points = {loop: (x * scale, y * scale) for loop, (x, y) in flat.items()}
				xs, ys = [q[0] for q in points.values()], [q[1] for q in points.values()]
				width, height = max(xs) - min(xs), max(ys) - min(ys)
				gap, room = 3 / ATLAS, strip["right"] - strip["left"]
				if width > room - 2 * gap:
					points = {loop: (y, -x) for loop, (x, y) in points.items()}
					xs, ys = [q[0] for q in points.values()], [q[1] for q in points.values()]
					width, height = max(xs) - min(xs), max(ys) - min(ys)
				if width > room - 2 * gap:
					# a face longer than the strip is wide (fin_root's cap, hidden in
					# the fin): laid at a lower density, scaled to fit
					fit = (room - 2 * gap) / width
					points = {loop: (x * fit, y * fit) for loop, (x, y) in points.items()}
					xs, ys = [q[0] for q in points.values()], [q[1] for q in points.values()]
					width, height = max(xs) - min(xs), max(ys) - min(ys)
				if strip["x"] + width > room - gap:
					strip["x"], strip["y"], strip["row"] = 0.0, strip["y"] + strip["row"] + gap, 0.0
				if strip["y"] + height + 2 * gap > 1.0:
					raise SystemExit("the atlas's free strip is full")
				left, bottom = strip["left"] + gap + strip["x"] - min(xs), gap + strip["y"] - min(ys)
				for loop, (x, y) in points.items():
					uv[loop].uv = (left + x, bottom + y)
				strip["x"] += width + gap
				strip["row"] = max(strip["row"], height)
			placed += 1
	print(f"unfolded {placed} faces onto islands of their own")
	return placed


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


def stencils(where, covered, size):
	# The stencils' shading over the atlas (layout.stencils), each texel the
	# stencil's average over its own width on the jet (size): sampled at its
	# centre, lettering finer than a texel read as speckle
	from PIL import Image, ImageFilter
	p = LAYOUT["stencils"]
	factor = np.ones(where.shape[:2])
	points = where[covered]
	texel = size[covered]
	shade = np.ones(len(points))
	images = {}
	for spec, centre, across, up, normal in stencil_frames():
		d = points - np.array(centre)
		off = d @ np.array(normal)
		u = d @ np.array(across) / (spec["size"][0] * INCH) + 0.5
		v = 0.5 - d @ np.array(up) / (spec["size"][1] * INCH)
		pick = (np.abs(off) < 1.5 * INCH) & (u >= 0) & (u < 1) & (v >= 0) & (v < 1)
		if not pick.any():
			continue
		# blurred to half the texels' width there, then read between pixels
		sigma = 0.5 * float(np.median(texel[pick])) / INCH * STENCIL
		key = (id(spec), round(sigma, 2))
		if key not in images:
			drawn = stencil_image(spec, p["dark"], p["light"])
			images[key] = np.asarray(Image.fromarray((drawn * 255).round().astype(np.uint8)).filter(ImageFilter.GaussianBlur(sigma)), float) / 255
		image = images[key]
		h, w = image.shape
		x, y = np.clip(u[pick] * w - 0.5, 0, w - 1), np.clip(v[pick] * h - 0.5, 0, h - 1)
		x0, y0 = np.minimum(x.astype(int), w - 2), np.minimum(y.astype(int), h - 2)
		fx, fy = x - x0, y - y0
		value = (image[y0, x0] * (1 - fx) * (1 - fy) + image[y0, x0 + 1] * fx * (1 - fy)
			+ image[y0 + 1, x0] * (1 - fx) * fy + image[y0 + 1, x0 + 1] * fx * fy)
		shade[pick] = np.minimum(shade[pick], value)
	factor[covered] = shade
	return factor


# The F/A-18C's own stores (claude/plans/air-fa18c.md #9 and the contract's
# Stores): the wing pylons, racks, rails and launchers, the cheek launchers,
# the centreline pylon and the tanks, each its own node hidden until the
# loadout shows it (a "show" joint on the "stores" drive, which the engine
# answers part by part), but the wingtip rails, always fitted. Every place
# is the photos' (layout.stores), every size the sources' (stores). A part
# under the wing hangs rigid from a bend joint at its pylon's root, as the
# real store does, and the tip rail from one under the outer panel, folding
# with it. Where each part carries its missile goes in the points file's
# hardpoints (ROUNDS).
STORE_PARTS = []   # every hidden store part's node
ROUNDS = {}   # station number to {part: the round it carries: mount, forward, up}
MISSILES = json.loads((HERE.parent / "missiles" / "facts.json").read_text())
SHOW = [[0, 0], [1, 1]]


def fwb(p, side):
	# a [FS, WL, BL] the layout gives on the right, on `side`
	return at(p[0], p[1], abs(p[2]) * side)


def interp(knots, x):
	# piecewise linear through [(x, y)], held at the ends
	if x <= knots[0][0]:
		return knots[0][1]
	for (x0, y0), (x1, y1) in zip(knots, knots[1:]):
		if x <= x1:
			return y0 + (y1 - y0) * (x - x0) / ((x1 - x0) or 1)
	return knots[-1][1]


def square(forward, up):
	# forward, and up made square to it
	f = forward.normalized()
	return f, (up - f * up.dot(f)).normalized()


def rounded_ring(centre, f, u, width, height, rounding=1.0, n=4):
	# A rounded rectangle across f: `height` inches along u, `width` across
	# both, its corners rounded by `rounding` of the smaller half
	s = f.cross(u)
	hw, hh = max(width, 0.05) * INCH / 2, max(height, 0.05) * INCH / 2
	r = min(hw, hh) * rounding
	ring = []
	for cx, cy, start in ((hw - r, hh - r, 0), (-(hw - r), hh - r, 90), (-(hw - r), -(hh - r), 180), (hw - r, -(hh - r), 270)):
		for k in range(n + 1):
			a = math.radians(start + 90 * k / n)
			ring.append(centre + s * (cx + r * math.cos(a)) + u * (cy + r * math.sin(a)))
	return ring


def round_ring(centre, f, u, radius, sides=24):
	s = f.cross(u)
	r = max(radius, 0.03) * INCH
	return [centre + (u * math.cos(2 * math.pi * i / sides) + s * math.sin(2 * math.pi * i / sides)) * r for i in range(sides)]


def store(name, mesh, parent=None, hinge=None, shown=False):
	# a store part: its node, hidden by its show joint unless always fitted
	node(name, parent=parent, hinge=hinge, mesh=mesh, paint="stores")
	if not shown:
		JOINTS[name] = {"motion": "show", "drive": "stores", "keys": SHOW}
		STORE_PARTS.append(name)


def tank_mesh(nose, tail):
	# The 330-gallon tank: a body of revolution on the photos' profile
	# (layout.stores.tank), stretched to the length nose to tail
	profile = STORES["tank"]["profile"]
	axis = tail - nose
	scale = axis.length / INCH / profile[-1][0]
	f, u = square(-axis, UP)
	knots = sorted({s for s, _ in profile} | {float(s) for s in range(0, int(profile[-1][0]) + 1, 5)})
	return loft([round_ring(nose + axis.normalized() * (s * scale * INCH), f, u, interp(profile, s)) for s in knots])


def wing_low(side, station, buttline):
	# the wing's lower surface's waterline at a station and buttline, None
	# off its chord
	surface = SURFACES[f"wing_{side_name(side)}"]
	leading, chord, _ = surface.station(abs(buttline))
	x = (station - (ORIGIN["station"] - leading.x / INCH)) / chord
	if not 0.0 <= x <= 1.0:
		return None
	return surface.point(abs(buttline), x, -1).z / INCH + ORIGIN["waterline"]


def pylon_mesh(side, nose, tail, front, bottom, width, top=None):
	# A pylon from its nose to its tail ([FS, WL, BL], the BL line between
	# them): its leading edge (front, [FS, WL]) up from the nose, its bottom
	# along `bottom`, its top 1.5 in inside the wing (or `top(FS)`), its
	# width rounding in over its first 6 in and thinning to a trailing edge
	# over its last 24
	start, end = nose[0], tail[0]
	stations = [start + d for d in (0.15, 0.6, 1.5, 3, 5, 8, 12, 17)]
	stations += [s for s in range(int(start) + 24, int(end) - 24, 8)] + [end - 16, end - 8, end - 2, end]
	rings = []
	for s in stations:
		bl = nose[2] + (tail[2] - nose[2]) * (s - start) / (end - start)
		low = interp(bottom, s)
		roof = top(s) if top else wing_low(side, s, bl)
		high = roof + 1.5 if roof is not None else 200.0
		if s <= front[-1][0]:
			high = min(high, interp(front, s))
		half = width / 2 * min(1.0, ((s - start) / 6) ** 0.5) * min(1.0, max(0.12, (end - s) / 24))
		centre = at(s, (low + high) / 2, bl * side)
		rings.append(rounded_ring(centre, FORWARD, UP, 2 * half, max(high - low, 0.1)))
	return loft(rings)


def box_mesh(front, f, u, length, width, height, fairing, tail=4.0, tip=0.3):
	# A launcher or rack: a rounded box `length` aft from its front, its
	# forward fairing growing from `tip` of its section over `fairing` inches,
	# its aft end closing to 0.7 over `tail`
	stations = sorted({0.0, 0.5, 1.5} | {fairing * k / 6 for k in range(7)} | {float(t) for t in range(int(fairing) + 6, int(length - tail), 12)} | {length - tail, length})
	rings = []
	for t in stations:
		grow = tip + (1 - tip) * math.sin(min(t / fairing, 1.0) * math.pi / 2) if fairing else 1.0
		shrink = 1.0 - 0.3 * max(0.0, (t - (length - tail)) / tail) if tail else 1.0
		k = grow * shrink
		rings.append(rounded_ring(front - f * (t * INCH), f, u, width * k, height * k, rounding=0.45))
	return loft(rings)


def missile_mount(kind):
	# where a missile's own points file puts its mount: inches aft of its
	# nose, on top of its body
	layout, facts = MISSILES["layout"][kind], MISSILES[kind]
	return value(layout["mount"]), value(facts["diameter"]) / 2


def round_at(nose, f, up, kind):
	# a round on its part: the missile's mount, where its forward and its
	# lug side (up) point, in the engine's frame
	station, radius = missile_mount(kind)
	f, up = square(f, up)
	mount = nose - f * (station * INCH) + up * (radius * INCH)
	return {"kind": kind, "mount": exported(mount), "forward": exported(f), "up": exported(up)}


def stores():
	global STORES
	STORES = LAYOUT["stores"]
	lau7, lau127 = FACTS["stores"]["lau7"], FACTS["stores"]["lau127"]
	lau115, lau116 = FACTS["stores"]["lau115"], FACTS["stores"]["lau116"]
	py, rails, rounds = STORES["pylon"], STORES["rails"], STORES["rounds"]
	for side in (-1, 1):
		name = side_name(side)
		bend = BENDING[name]
		surface = SURFACES[f"wing_{name}"]
		tip, outboard, inboard, cheek = (1, 2, 3, 4) if side < 0 else (9, 8, 7, 6)
		# The wingtip LAU-7, turned on its side with its round outboard of it,
		# riding the outer panel's bend and fold
		front, aft = fwb(rails["tip"]["front"], side), fwb(rails["tip"]["aft"], side)
		f, u = square(front - aft, Vector((0, side, 0)))   # u away from the round: inboard
		flex_joint(f"flex_rail_{name}", bend, surface.point(surface.length, 0.5), parent=f"wing_{name}")
		rail = box_mesh(front, f, u, (front - aft).length / INCH, value(lau7["width"]), value(lau7["height"]), 16.0)
		# the fittings bolting it to the wingtip: a strip across the gap from
		# the tip's edge to the rail's inboard face, along the rail's middle
		reach = abs(front.y) / INCH - value(lau7["height"]) / 2 - surface.length
		middle = front - f * (40 * INCH)
		strip = box_mesh(middle + u * ((value(lau7["height"]) / 2 + reach / 2) * INCH), f, u, 50.0, 2.5, reach + 1.0, 4.0, tail=4.0, tip=0.6)
		store(f"rail_{tip}", merge([rail, strip]), parent=f"flex_rail_{name}", hinge=front, shown=True)
		MARKS[f"rail_tip_front_{name}"] = (front, f"rail_{tip}")
		MARKS[f"rail_tip_aft_{name}"] = (aft, f"rail_{tip}")
		# its AIM-9M on the photos' round axis, the nose 8.9 in ahead of the
		# rail's front (missiles layout.aim9m.mount)
		n9x, t9x = fwb(rounds["tip"]["nose"], side), fwb(rounds["tip"]["tail"], side)
		back = (t9x - n9x).normalized()
		nose = n9x + back * ((front - n9x).dot(back) - 8.9 * INCH)
		ROUNDS.setdefault(tip, {})[f"rail_{tip}"] = round_at(nose, -back, u, "aim9m")
		# The wing pylons: the outboard as the photos measure it, the inboard
		# the same pylon moved to its own nose
		shift = Vector(py["inboard"]) - Vector(py["nose"])
		for station, delta in ((outboard, Vector()), (inboard, shift)):
			moved = lambda p: [p[0] + delta.x, p[1] + delta.y, abs(p[2]) + delta.z]
			nose_, tail_ = moved(py["nose"]), moved(py["tail"])
			front_ = [(s + delta.x, w + delta.y) for s, w in py["front"]]
			bottom_ = [(s + delta.x, w + delta.y) for s, w in py["bottom"]]
			root = surface.point(abs(nose_[2]), 0.5)
			flex = f"flex_pylon_{station}"
			flex_joint(flex, bend, root)
			store(f"pylon_{station}", pylon_mesh(side, nose_, tail_, front_, bottom_, py["width"]), parent=flex)
			position = "outboard" if station == outboard else "inboard"
			MARKS[f"pylon_{position}_nose_{name}"] = (fwb(nose_, side), f"pylon_{station}")
			if station == outboard:
				MARKS[f"pylon_{position}_tail_{name}"] = (fwb(tail_, side), f"pylon_{station}")
			# the pylon's line, along its bottom
			axis_f, _ = square(fwb(nose_, side) - fwb(tail_, side), UP)
			# the twin rounds' noses and the LAU-127s' fronts, outer (a) and inner (b)
			twin = {"a": moved(rounds["twin"]["outer"]), "b": moved(rounds["twin"]["inner"])}
			fronts = {"a": moved(rails["launcher"]["outer"]), "b": moved(rails["launcher"]["inner"])}
			middle = fronts["a"][0] + value(lau127["length"]) / 2
			# the LAU-115 under the pylon, its middle under the LAU-127s'
			bl = lambda s: nose_[2] + (tail_[2] - nose_[2]) * (s - nose_[0]) / (tail_[0] - nose_[0])
			length = value(lau115["length"])
			start = middle - length / 2
			top = interp(bottom_, start)
			rack_front = at(start, top - value(lau115["height"]) / 2, bl(start) * side)
			store(f"rack_{station}", box_mesh(rack_front, axis_f, UP, length, value(lau115["width"]), value(lau115["height"]), 9.0, tip=0.45),
				parent=flex, hinge=rack_front)
			# a single AIM-120 on the LAU-115's own rail, centred under it
			below = interp(bottom_, middle) - value(lau115["height"]) - 0.6 - value(MISSILES["aim120c"]["diameter"]) / 2
			under = at(middle, below, bl(middle) * side)
			nose = under + axis_f * ((middle - twin["a"][0]) * INCH)
			ROUNDS.setdefault(station, {})[f"rack_{station}"] = round_at(nose, axis_f, UP, "aim120c")
			for point in ("a", "b"):
				tip_ = fwb(fronts[point], side)
				n120 = fwb(twin[point], side)
				# toward the round's axis from the launcher's front: the launcher's down
				on_axis = n120 - axis_f * (tip_ - n120).dot(-axis_f)
				down = on_axis - tip_
				_, toward = square(axis_f, down)
				store(f"launcher_{station}{point}", box_mesh(tip_, axis_f, -toward, value(lau127["length"]), value(lau127["width"]), value(lau127["height"]), 14.0),
					parent=flex, hinge=tip_)
				store(f"rail_{station}{point}", box_mesh(tip_, axis_f, -toward, value(lau7["length"]), value(lau7["width"]), value(lau7["height"]), 14.0),
					parent=flex, hinge=tip_)
				ROUNDS[station][f"launcher_{station}{point}"] = round_at(n120, axis_f, -toward, "aim120c")
				# an AIM-9M on the LAU-7 there: its axis 5.0 in from the rail's,
				# toward the round, as on the wingtip; its nose 8.9 in ahead
				n9 = tip_ + toward * (5.0 * INCH) + axis_f * (8.9 * INCH)
				ROUNDS[station][f"rail_{station}{point}"] = round_at(n9, axis_f, -toward, "aim9m")
				if station == outboard:
					MARKS[f"rail_outboard_{'outer' if point == 'a' else 'inner'}_front_{name}"] = (tip_, f"launcher_{station}{point}")
			if station == inboard:
				# the 330-gallon tank, from the photos' nose and tail
				n, t = fwb(STORES["tank"]["nose"], side), fwb(STORES["tank"]["tail"], side)
				store(f"tank_{station}", tank_mesh(n, t), parent=flex)
				MARKS[f"tank_inboard_nose_{name}"] = (n, f"tank_{station}")
				MARKS[f"tank_inboard_tail_{name}"] = (t, f"tank_{station}")
		# The cheek station's LAU-116 and its AIM-120, canted 45 deg toward the
		# fuselage on it (dvids9380790)
		nose = fwb(rounds["cheek"]["nose"], side)
		up = (UP + Vector((0, side, 0))).normalized()   # up and inboard
		f, u = square(FORWARD, up)
		round_ = round_at(nose, f, u, "aim120c")
		ROUNDS[cheek] = {f"ejector_{cheek}": round_}
		station, radius = missile_mount("aim120c")
		# the LAU-116 between the round's forward and aft hooks
		lugs = value(MISSILES["layout"]["aim120c"]["lugs"])
		middle = (min(lugs) + max(lugs)) / 2
		hooks = nose - f * (middle * INCH) + u * ((radius + value(lau116["height"]) / 2) * INCH)
		front = hooks + f * (value(lau116["length"]) / 2 * INCH)
		store(f"ejector_{cheek}", box_mesh(front, f, u, value(lau116["length"]), value(lau116["width"]), value(lau116["height"]), 4.0, tip=0.8), hinge=front)
	# The centreline: the SUU-62 on the belly and its tank, level
	centre = STORES["centre"]
	n = at(*centre["nose"])
	length = (Vector(STORES["tank"]["tail"]) - Vector(STORES["tank"]["nose"])).length
	t = n + AFT * (length * INCH)
	store("tank_5", tank_mesh(n, t))
	MARKS["tank_centre_nose"] = (n, "tank_5")
	profile = STORES["tank"]["profile"]
	line = STORES["centreline"]
	tank_top = lambda s: centre["nose"][1] + interp(profile, s - centre["nose"][0])
	store("pylon_5", pylon_mesh(1, [line["front"], tank_top(line["front"]) - 1.0, 0.0], [line["back"], tank_top(line["back"]) - 1.0, 0.0],
		[(line["front"], tank_top(line["front"]) - 1.0), (line["front"] + 6, keel_at(line["front"] + 6) + 1.5)],
		[(s, tank_top(s) - 1.0) for s in range(int(line["front"]), int(line["back"]) + 1, 4)], py["width"], top=lambda s: keel_at(s)))


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
	sb = LAYOUT["speedbrake"]
	out["speedbrake"] = {"hinge": e(HINGES["speedbrake"]), "area": round((sb["back"] - sb["front"]) * 2 * sb["half"] * INCH * INCH, 3)}
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
		# the parts the station can show and where each carries its round
		# (stores(), the contract's Stores)
		hard[str(number)] = {"mount": e(mount), "forward": e(FORWARD), "parts": sorted(n for n in STORE_PARTS + ["rail_1", "rail_9"] if n.rsplit("_", 1)[1].rstrip("ab") == str(number)),
			"rounds": ROUNDS.get(number, {})}
	out["hardpoints"] = hard
	out["stores"] = sorted(STORE_PARTS)
	lights = {}
	for name, spec in LAYOUT["lights"]["points"].items():
		# a light on a moving part names it, the engine carrying the light with the part: on a gear part given as
		# the gear stands down and moved to where it rests; on the wing's outer panels, at rest already
		position = RESTED.get(spec["node"], Matrix.Identity(4)) @ at(*spec["at"]) if "node" in spec else at(*spec["at"])
		lights[name] = {"position": e(position), "colour": spec["colour"], "kind": spec["kind"], **({"node": spec["node"]} if "node" in spec else {})}
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
	lamps()
	stores()
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
		features = {"about": "The model's named points and curves, each on the node it rides on, at rest in the model frame (build.py). A point on a node with shape keys gives its move under each at full weight, in the node's frame (morphs).",
			"landmarks": {name: {"at": exported(p), "node": n, **({"morphs": {"flex": exported(flexed(n, p))}} if n in BENDS else {})} for name, (p, n) in sorted(MARKS.items())},
			"curves": {name: {"points": [exported(p) for p in points], "node": n, **({"morphs": {"flex": [exported(flexed(n, p)) for p in points]}} if n in BENDS else {})} for name, (points, n) in sorted(CURVES.items())}}
		Path(out[2]).write_text(json.dumps(features, indent="\t") + "\n")


main()
