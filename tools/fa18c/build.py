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
# quick looks at the shape. --cache DIR keeps the atlases' UVs and bakes there
# between builds, each under a key of everything it comes from (../cache.py),
# and takes them from there when nothing they come from has changed: the jet's
# and the stores' each on its own. --facts FILE builds from another facts file.
# --keys FILE writes the keys the atlases would bake under, and stops.
#
# usage: blender -b --factory-startup --python-use-system-env -P build.py -- OUT.glb OUT.json [FEATURES.json] [--draft] [--cache DIR] [--facts FILE] [--keys FILE]
import heapq, json, math, re, sys
from contextlib import contextmanager
from pathlib import Path

import bmesh
import numpy as np
import bpy
from mathutils import Matrix, Quaternion, Vector
from mathutils.bvhtree import BVHTree

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
import cache  # noqa: E402
import finish  # noqa: E402
import hidden  # noqa: E402
ARGS = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []


def option(name):
	# An option's value (--name VALUE), taken out of ARGS; None if not given
	if name not in ARGS:
		return None
	i = ARGS.index(name)
	value = ARGS[i + 1]
	del ARGS[i : i + 2]
	return value


FACTS = json.loads(Path(option("--facts") or HERE / "facts.json").read_text())
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
# The gap a moving part keeps from what it passes, in (check.py SEAM)
SEAM = 0.1


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

	def piece(self, spans, chord, steps=6, end=None, extra=(), back=None):
		# The part between span stations spans[0]..spans[1] and chord fractions
		# chord[0]..chord[1], closed at every cut. end, a function of the span
		# station, is the share of the chord a rounded corner leaves (1 where
		# none), and extra adds span stations for its rings; back, a function
		# of the span station, the chord fraction its aft edge stands at there
		# in place of chord[1] (the table's stations before it kept, so a
		# neighbouring piece shares their corners)
		start, stop = chord
		xs = sorted({start, stop} | {x for x in STATIONS if start < x < stop})
		us = sorted({spans[0] + (spans[1] - spans[0]) * i / steps for i in range(steps + 1)} | {u for u in extra if spans[0] < u < spans[1]})
		rings = []
		for u in us:
			scale = end(u) if end else 1.0
			at_ = xs if back is None else xs[:-1] + [back(u)]
			if at_[-1] <= at_[-2]:
				raise SystemExit(f"Surface.piece: its aft edge at {u:.1f} in out lies ahead of the table's station {at_[-2]}")
			rings.append([self.point(u, x, 1, scale) for x in at_] + [self.point(u, x, -1, scale) for x in reversed(at_)])
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


def band(rings):
	# Quads between consecutive closed rings of equal length, open at both
	# ends (loft() closes them)
	vertices, faces = loft(rings)
	return vertices, faces[:-2]


def outward(mesh):
	# A closed mesh's faces turned out: reversed if its signed volume is negative
	vertices, faces = mesh
	volume = sum(Vector(vertices[f[0]]).dot(Vector(vertices[f[i]]).cross(Vector(vertices[f[i + 1]]))) for f in faces for i in range(1, len(f) - 1))
	return mesh if volume > 0 else (vertices, [tuple(reversed(f)) for f in faces])


def merge(pieces):
	# Meshes as one; a piece may carry a finish per face (a material's name,
	# None for the node's own), and then so does the whole
	vertices, faces, finishes = [], [], []
	for piece in pieces:
		vs, fs = piece[0], piece[1]
		offset = len(vertices)
		vertices += vs
		faces += [tuple(i + offset for i in f) for f in fs]
		finishes += piece[2] if len(piece) > 2 else [None] * len(fs)
	if any(finishes):
		return vertices, faces, finishes
	return vertices, faces


def finished(mesh, name):
	# A mesh with every face in one finish
	return mesh[0], mesh[1], [name] * len(mesh[1])


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
# the real ones carry the airframe's paint), plain: they stay out of the atlas.
# The landing gear's finishes (layout.paint gear: white, rubber, chrome, hub)
# share the paint's atlas: their colour, shaded, in place of the greys
def linear(srgb):
	c = np.asarray(srgb, float) / 255
	return tuple(float(v) for v in np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)) + (1,)


COLOURS = {"paint": (0.42, 0.45, 0.48, 1), "team": (0.42, 0.45, 0.48, 1), "glass": (0.1, 0.12, 0.14, 0.4),
	"lights": (0.34, 0.35, 0.32, 1), "burner": (0.012, 0.011, 0.010, 1), "display": (0.05, 0.08, 0.05, 1),
	"stores": linear(LAYOUT["paint"]["lower"]), "red": linear(LAYOUT["scoop"]["red"])}
COLOURS.update({name: linear(c) for name, c in LAYOUT["paint"]["gear"].items()})
ATLASED = ("paint", "team") + tuple(LAYOUT["paint"]["gear"])   # the materials the atlas paints


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


def node(name, parent=None, hinge=None, mesh=None, paint="paint", inside=False, out=None):
	# An object at `hinge` (world space). Its mesh's vertices are given in
	# world space and stored relative to the hinge. Every ancestor rests
	# unrotated, so a child's location is its hinge less its parent's.
	# `inside`: an open shell seen from within (a well), its faces turned in
	# once tidy() has turned them out; `out`: (a point, a direction) an open
	# shell's face nearest the point faces, the shell turned whole to it
	# (tidy() picks a side by the face furthest from the middle, which for a
	# skin ending in a long duct can be the duct's)
	if hinge is None:
		hinge = HINGES[parent].copy() if parent else Vector()
	data = None
	if mesh:
		# a mesh is (vertices, faces), or (vertices, faces, a material per face,
		# None for `paint`)
		vertices, faces = mesh[0], mesh[1]
		paints = [n or paint for n in mesh[2]] if len(mesh) > 2 else [paint] * len(faces)
		data = bpy.data.meshes.new(name)
		data.from_pydata([v - hinge for v in vertices], [], faces)
		names = sorted(set(paints))
		for n in names:
			data.materials.append(material(n))
		for polygon, n in zip(data.polygons, paints):
			polygon.material_index = names.index(n)
		data.validate()
		tidy(data)
		if inside:
			data.flip_normals()
		if out is not None:
			point, direction = out[0] - hinge, out[1]
			nearest = min(data.polygons, key=lambda f: (f.center - point).length)
			if nearest.normal.dot(direction) < 0:
				data.flip_normals()
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
	if motion == "rotate" and len(keys) > 2:
		# a solved schedule's turns, each read within a half turn: unwrapped, so
		# no neighbouring keys stand a whole turn apart (the side braces' did, at
		# gear 0.75-0.80, and spun a full turn backwards between them)
		turns = np.unwrap([k[1] for k in keys])
		keys = [[k[0], round(float(t), 4)] for k, t in zip(keys, turns)]
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
	key.value = 0.0   # at rest: Blender 5 weights a new key 1, which bent every view and bake to 1 g
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
	# hinge there, and that part of it folds with the outer panel. There the
	# inner panel's aft edge runs streamwise, parallel to the fold's axis, a
	# seam ahead of the aileron's hinge at its inner end: the aileron's hinge
	# line sweeps aft going out, and turned about the fold its nose would
	# swing into an edge that followed it
	stub = spans["aileron"][0]
	lead = lambda u: ORIGIN["station"] - surface.station(u)[0].x / INCH
	edge = lead(stub) + (1 - aileron) * surface.station(stub)[1] - SEAM
	node(f"wing_inner_{name}", mesh=merge([surface.panel((inside, stub), [(spans["lef"]["inner"], inner_lef, "front"), (spans["tef"], tef, "back")]),
		surface.piece((stub, fold), (inner_lef, 1 - aileron), steps=1, back=lambda u: (edge - lead(u)) / surface.station(u)[1])]))
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
	hinged(f"flap_trailing_{name}", spans["tef"], 1 - tef, (1 - tef, 1), AFT, DOWN, f"trailing.{name}")
	# The outer panel folds about the fold line, carrying its flap and aileron,
	# as far as the photos fold it (layout.fold): NATOPS's folded span holds at
	# any angle past 90 deg, where the panel's foot stands outermost. Its
	# hinge runs along the upper skin's peak over the fold line, so the outer
	# panel's root face swings up clear of the inner panel's
	_, chord_, thickness_ = surface.station(fold)
	peak = max(y for _, y in airfoil(thickness_)) * chord_
	a, b = (surface.point(fold, x) + surface.up * (peak * INCH) for x in (0, 1))
	outer = surface.panel((fold, semispan), [(spans["lef"]["outer"], outer_lef, "front"), (spans["aileron"], aileron, "back")])
	high = math.radians(LAYOUT["fold"]["angle"])
	# under a bend joint at the fold line's leading end in the chord plane, on
	# the bend's streamwise axis: the bend carries the hinge above it as it
	# carries the skin there, and the fold line rides the bend unbroken
	flex_joint(f"flex_wing_{name}", bend, surface.point(fold, 0))
	node(f"wing_{name}", parent=f"flex_wing_{name}", hinge=a)
	joint(f"wing_{name}", b - a, Vector((0, -side, 0)), UP, "fold", [[0, 0], [1, round(high, 4)]])
	node(f"wing_outer_{name}", parent=f"wing_{name}", hinge=a, paint="team", mesh=outer)
	bent(f"wing_outer_{name}", bend)
	hinged(f"flap_leading_outer_{name}", spans["lef"]["outer"], outer_lef, (0, outer_lef), FORWARD, DOWN, "slat", parent=f"wing_{name}")
	hinged(f"aileron_{name}", spans["aileron"], 1 - aileron, (1 - aileron, 1), AFT, DOWN, f"aileron.{name}", parent=f"wing_{name}")
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


def fairing(name, side, surface, skin, span, corner):
	# The riveted fairing along a fin's root on its outboard side (layout.fin
	# fairing): its upper edge runs up the leading edge from the root's corner
	# to the photos' top line and aft along it on the fin's face, standing
	# `step` off the face (eased in from the leading edge to the line's
	# second point); its foot stands on the nacelle at the photos' buttlines;
	# each section straight from edge to foot, closed inside the fin and the
	# skin along the fin's face carried down to the skin (closed straight from
	# edge to foot, a slab stood off the canted fin over an open crevice, its
	# floor black in the bake). Behind the band's last top point the plate
	# (aft) carries on to the rudder's lower leading corner (`corner`): a
	# `seam` step in where the band ends, then its upper edge eased in to
	# within `step` of the fin's face and its foot on the fin root's line the
	# photos cast, so it ends on the fin with no face standing aft (ended
	# square at the band's end, a wedge stood 5.3 in off the fin there).
	# Returns its front foot, where the leading edge meets the skin
	place = LAYOUT["fin"]["fairing"]
	plate = place["aft"]
	top = [tuple(p) for p in place["top"]]
	line = top + [tuple(p) for p in plate["top"]]
	# the foot on the band's buttlines, then on the fin root's line the photos
	# cast from where it turns in behind the band (stepped in at the band's
	# end instead, the band's last section stood 2 in proud of the plate's)
	foot = [tuple(p) for p in place["foot"] if p[0] < plate["foot"][0][0]] + [tuple(p) for p in plate["foot"]]
	face = built([f"fin_{name}"])
	low, high = surface.point(0, 0), surface.point(value(FACTS["fin"]["height"]), 0)

	def source(v):
		return ORIGIN["station"] - v.x / INCH, ORIGIN["waterline"] + v.z / INCH, -v.y / INCH

	(f0, w0, _), (f1, w1, _) = source(low), source(high)
	outward = Vector((0, -side, 0))   # Blender's y is to port
	start, band, end = f0, top[-1][0], source(corner)[0] - plate["clear"]
	steps = int(math.ceil((band - start) / 2.0))
	stations = [(start + (band - start) * i / steps, False) for i in range(steps + 1)]
	# rings every half inch, which the foot's turn in behind the band needs
	count = int(math.ceil((end - band) / 0.5))
	stations += [(band + (end - band) * i / count, True) for i in range(count + 1)]

	def ring(station, aft):
		edge = low.lerp(high, (station - f0) / (f1 - f0))   # the leading edge at this station
		height = float(np.interp(station, [p[0] for p in line], [p[1] for p in line]))
		if source(edge)[1] <= height:
			upper = edge
		else:
			origin = at(station, height, side * 90.0)
			upper = face.ray_cast(origin, -outward)[0]
			if upper is None:
				raise SystemExit(f"fin_{name}'s face not found at FS {station:.1f}")
		stand = place["step"] * ease((station - top[0][0]) / (top[1][0] - top[0][0]))
		bl = float(np.interp(station, [p[0] for p in foot], [p[1] for p in foot]))
		if aft:
			# the upper edge eased in from the band's end, less the seam, to
			# its stand-off at the plate's aft end
			k = ease((station - band) / (end - band))
			stand = place["step"] - plate["seam"] + (plate["step"] - place["step"] + plate["seam"]) * k
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
		return [inner] + [outer.lerp(lower, k / 4) for k in range(5)] + [lower + DOWN * (0.5 * INCH), root]

	rings = [ring(station, aft) for station, aft in stations]
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
	# the rudder's outline as the photos read it (layout.rudder): its lower
	# and upper edges along the span and its hinge line at one share of the
	# chord, its trailing edge the fin's
	measured = LAYOUT["rudder"]
	spans = (measured["span"][0] * height, measured["span"][1] * height)
	rudder = 1 - measured["hinge"]
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
	corner = fairing(name, side, surface, skin, span, surface.point(spans[0], 1 - rudder))
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
	# Ahead of the first cited section (FS 70, a circle) the nosecone is round:
	# the side trace's half-height and the top trace's half-width, within a
	# pixel step of each other there, part toward the apex (at FS 61.5 a
	# section 1.7 in tall stood 0.36 in wide, a blade that shaded in streaks),
	# so each section takes their mean as its radius
	first = min(r["station"] for r in FACTS["sections"])
	if station < first:
		radius = (height / 2 + width) / 2
		height, width = 2 * radius, radius
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
	# the band where the ring jumps out to the nacelles just ahead of JOIN
	# (union_ring()), across the ducts: its faces inside the inlets' skins
	# at JOIN, which close the nacelles round them, are left out (the ring's
	# points there stand up to 0.07 in off the inlets' last, sampled apart)
	jump = stations.index(max(s for s in stations if s < JOIN - 1e-6))
	nacelle = np.array([(bl, wl) for wl, bl in joint_ring()])

	def inside(v):
		return enclosing(nacelle, (abs(v.y) / INCH, ORIGIN["waterline"] + v.z / INCH), 0.25)

	groups = {"body": [], "windscreen": [], "canopy": []}
	for k, face in enumerate(faces):
		r, i = divmod(k, n)
		if r == jump and all(inside(vertices[v]) for v in face):
			continue
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
	# the skin under the canopy's rim (its sill, its aft end, its bow at the
	# windscreen), so no slit opens where the canopy's shell stands a seal's
	# step proud of the loft (layout.motion canopy): the canopy's faces within
	# RIM inches of its edge kept on the fuselage too, their edge where the
	# loft lays it and falling in from it by twice the step, so the shell
	# slides clear over them where the loft rises aft (it rises up to 0.3 in
	# over the slide behind the bow)
	count = {}
	for face, _ in groups["canopy"]:
		for a, b in zip(face, face[1:] + face[:1]):
			count[frozenset((a, b))] = count.get(frozenset((a, b)), 0) + 1
	rim = {i for e, k in count.items() if k == 1 for i in e}
	edge = [vertices[i] for i in rim]
	normals = shell_normals(vertices, [f for f, _ in groups["canopy"]])
	sunk = {}

	def under(i):
		# a vertex of the skin under the rim: its own on the edge, else a copy fallen in
		if i in rim:
			return i
		if i not in sunk:
			vertices.append(vertices[i] - normals[i] * (2 * LAYOUT["motion"]["canopy"]["value"]["seal"] * INCH))
			sunk[i] = len(vertices) - 1
		return sunk[i]
	for face, _ in list(groups["canopy"]):
		if any(min((vertices[i] - e).length for e in edge) < RIM * INCH for i in face):
			groups["body"].append((tuple(under(i) for i in face), "paint"))

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
	# The canopy slides aft along its sill to unlatch (NATOPS 2.15.1), rising
	# as it goes, then swings up about its hinge at its aft top (layout.motion
	# canopy). Its shell stands a seal's step proud of the loft it was cut
	# from, so neither the slide nor the turn drags its rim through the skin
	# it rests on
	motion = LAYOUT["motion"]["canopy"]["value"]
	shell, moved = proud(mesh(groups["canopy"]), motion["seal"])
	hinge = at(*motion["hinge"], 0)
	slide = AFT * (motion["slide"] * INCH) + UP * (motion["rise"] * INCH)
	node("canopy_slide", hinge=hinge)
	joint("canopy_slide", slide, slide, slide, "canopy", [[0, 0], [motion["unlatch"], round(slide.length, 5)], [1, round(slide.length, 5)]], motion="slide")
	node("canopy", parent="canopy_slide", hinge=hinge, mesh=shell)
	joint("canopy", PORT, FORWARD, UP, "canopy", [[0, 0], [motion["unlatch"], 0], [1, math.radians(motion["open"])]])
	# Features: the frame's corners and the sill on each side (the column
	# SILL steps down from the top; the port half runs back up the ring)
	index = {round(st, 1): r for r, st in enumerate(stations)}
	column = lambda r, side: rings[r][SILL] if side > 0 else rings[r][n - SILL]
	# a point of the canopy's where its proud shell has it
	shelled = lambda v: moved.get(tuple(round(c, 7) for c in v), v)
	MARKS["windscreen_base"] = (rings[index[round(front, 1)]][0], "windscreen")
	MARKS["bow_top"] = (shelled(rings[index[round(bow, 1)]][0]), "canopy")
	# the fixed windscreen's aft arch, where the bow meets it: the same point while the
	# canopy is shut, and what a photo with the canopy raised shows there
	MARKS["windscreen_top"] = (rings[index[round(bow, 1)]][0], "windscreen")
	MARKS["canopy_aft"] = (shelled(rings[index[round(back, 1)]][0]), "canopy")
	MARKS["canopy_crown"] = (shelled(max((rings[r][0] for r in range(len(rings)) if bow <= stations[r] <= back), key=lambda v: v.z)), "canopy")
	glass = [r for r, st in enumerate(stations) if bow <= st <= back]
	screen = [r for r, st in enumerate(stations) if front <= st <= bow]
	for side in (-1, 1):
		name = side_name(side)
		MARKS[f"bow_foot_{name}"] = (shelled(column(index[round(bow, 1)], side)), "canopy")
		MARKS[f"sill_aft_{name}"] = (shelled(column(glass[-1], side)), "canopy")
		CURVES[f"canopy_sill_{name}"] = ([shelled(column(r, side)) for r in glass], "canopy")
		CURVES[f"windscreen_sill_{name}"] = ([column(r, side) for r in screen], "windscreen")
	CURVES["canopy_top"] = ([shelled(rings[r][0]) for r in glass], "canopy")


RIM = 2.5   # in: how far in from the canopy's edge the skin under it runs (canopy())


def shell_normals(vertices, faces):
	# Each corner's normal over the faces given (a shell's), each face's
	# turned away from the centreline below it: {index: unit normal}
	normals = {}
	for f in faces:
		corners = [vertices[i] for i in f]
		n = Vector()
		for a, b in zip(corners, corners[1:] + corners[:1]):
			n += a.cross(b)   # Newell's
		centre = sum(corners, Vector()) / len(corners)
		if n.dot(centre - Vector((centre.x, 0.0, 0.0))) < 0:
			n = -n
		for i in f:
			normals[i] = normals.get(i, Vector()) + n.normalized()
	return {i: n.normalized() for i, n in normals.items()}


def proud(mesh, step):
	# A shell (vertices, faces, finishes) stood `step` inches out: each corner
	# moved along its faces' mean normal (shell_normals()); and where each
	# corner went, by its place before
	vertices, faces, finishes = mesh
	normals = shell_normals(vertices, faces)
	out = [v + normals[i] * (step * INCH) for i, v in enumerate(vertices)]
	return (out, faces, finishes), {tuple(round(c, 7) for c in v): w for v, w in zip(vertices, out)}


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



def legs(station):
	# The unsided outline from the top centreline to the keel split where the
	# nacelle takes it over from the body (crease()), at the nacelle's top,
	# its outboard side and its bottom (where it crosses the nacelle's centre
	# buttline and waterline): (angles, lengths, the five legs' ends along it)
	angles, path, length = outline(station, 0.0, False)
	b, w = nacelle_at(station)[:2]
	x, y = path[:, 0], path[:, 1]
	top = int(np.argmax((x[:-1] - b) * (x[1:] - b) <= 0))
	side = top + int(np.argmax(x[top:]))
	bottom = side + int(np.argmax((y[side:-1] - w) * (y[side + 1:] - w) <= 0))
	bottom = bottom + int(np.argmax((x[bottom:-1] - b) * (x[bottom + 1:] - b) <= 0))
	seam = min(float(np.interp(crease(station), angles, length)), float(length[top]) - 1.0)
	return angles, length, [seam, float(length[top]), float(length[side]), float(length[bottom]), float(length[-1])]


def crease(station):
	# The angle round the body's centre at which a nacelle takes the
	# outline over from the body and the deck, walking out from the top: the
	# V's floor behind the speedbrake, a sharp turn that columns spaced
	# along the outline cut off by more or less from ring to ring
	top, bottom = smooth(CORE["top"], station), smooth(CORE["bottom"], station)
	upper, half = core_widths(station)
	centre = (0.0, (top + bottom) / 2)
	b, w, a, up, down = nacelle_at(station)
	others = [((0.0, centre[1]), ((upper, half), (top - bottom) / 2), core_power(station))]
	deck = deck_top(station)
	if deck is not None and deck > w + 0.25:
		others.append(((0.0, w), (deck_half(station), deck - w, DECK_BELOW), DECK_EXPONENT))
	directions = [(math.sin(t), math.cos(t)) for t in DENSE]
	nacelle = np.array(exit_distances((b, w), (a, up, down), 2.3 + (2.0 - 2.3) * rounding(station), centre, directions))
	rest = np.max([exit_distances(c, h, n, centre, directions) for c, h, n in others], axis=0)
	return DENSE[int(np.argmax(nacelle > rest))]


SHARES = {}


def spaced(station, count):
	# `count` points from the top centreline to the keel behind the speedbrake,
	# evenly along each leg of the outline between the nacelle's top, its
	# outboard side and its bottom, each leg holding the steps it holds where
	# the tail's spacing has eased in: spaced along the whole outline, the V
	# forming between the nacelles lengthened its top leg and moved every step
	# below it from station to station
	if count not in SHARES:
		_, _, ends = legs(TAIL["narrows"][0] + TAIL_EASE)
		steps = [round((count - 1) * e / ends[-1]) for e in ends]
		SHARES[count] = [b - a for a, b in zip([0] + steps[:-1], steps)]
	angles, length, ends = legs(station)
	marks = []
	for (a, b), n in zip(zip([0.0] + ends[:-1], ends), SHARES[count]):
		marks += list(np.linspace(a, b, n + 1)[:-1])
	turns = np.interp(marks + [ends[-1]], length, angles)
	theta, path, _ = outline(station, 0.0)
	return [(float(np.interp(a, theta, path[:, 0])), float(np.interp(a, theta, path[:, 1]))) for a in turns]


TAIL_EASE = 16.0   # inches behind the speedbrake over which the tail's spacing eases in (union_ring())

# the last two: the nozzles' flaps' start, and the nacelles' lips over them (layout.nacelle end)
AFT_STATIONS = [412, 420, 435, 450, 470, 490, 510, 530, 550, 570, 590, 610, 630, 650, 670, LAYOUT["nozzle"]["start"], LAYOUT["nozzle"]["start"] + LAYOUT["nacelle"]["end"]["lip"]]


def polar(points, centre, angles):
	# A half-outline (top to keel) resampled at the angles round centre: along
	# each ray, its farthest crossing (every segment at once, the same sums on
	# each as one at a time)
	out = []
	ends = np.asarray(points, float)
	ex, ey = ends[1:, 0] - ends[:-1, 0], ends[1:, 1] - ends[:-1, 1]
	ox, oy = ends[:-1, 0] - centre[0], ends[:-1, 1] - centre[1]
	for theta in angles:
		d = (math.sin(theta), math.cos(theta))
		den = d[0] * ey - d[1] * ex
		crossed = np.abs(den) >= 1e-12
		with np.errstate(divide="ignore", invalid="ignore"):
			t = (ox * ey - oy * ex) / den
			u = (ox * d[1] - oy * d[0]) / den
		hit = crossed & (u >= -1e-9) & (u <= 1 + 1e-9) & (t > 0.0)
		best = float(t[hit].max()) if hit.any() else 0.0
		if theta in (0.0, math.pi) or best == 0.0:
			# the centreline: the outline's own end, which the ray may graze
			end = points[0] if theta < 1 else points[-1]
			best = max(best, abs(end[1] - centre[1]))
		out.append((centre[0] + d[0] * best, centre[1] + d[1] * best))
	return out


def beneath(starboard, bl, level=False):
	# The highest point of a half-ring (fuselage) above a buttline, or None;
	# `level`: on its stretches closer to level than upright only, so a wall
	# leaning in over a part beside it is not taken for a floor under it
	best = None
	for (b0, w0), (b1, w1) in zip(starboard, starboard[1:]):
		if (b0 - bl) * (b1 - bl) <= 0 and b0 != b1 and not (level and abs(w1 - w0) > abs(b1 - b0)):
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
RIDE = 0.05   # inches the LEX's underside rides over the skin rising under it behind FS 357


def lex(side, widths):
	# The leading-edge extension: a wedge off the body's side from its apex to
	# the LEX-wing junction, then a fairing behind the junction that eases its
	# upper surface down onto the nacelle's shoulder and the wing root, so the
	# LEX runs into the wing with no step. Its span is TM-101724's at FS 253,
	# 296 and 357, run between them and forward by cr186938's graph; its root
	# stands where the traced TP-3111 sections put it above the keel, its edge
	# where three side photos see it (layout.lex edge), and so does its nearly
	# flat underside (lex.underside) where the traced sections put it; at the
	# junction (tp3111, FS 404.05) its edge meets the wing's leading edge.
	# Spans and heights run on smooth curves through those knots. Behind FS
	# 357 its underside comes down through the splitter's top (layout.inlet)
	# to the wing's lower surface by the wing root's leading edge (layout.lex
	# underside), so the root lies inside it, and on aft just under that
	# surface, riding just over the cowl and the nacelle where they rise
	# above it. Its upper
	# surface never dips under what lies beneath it (the fuselage, the wing),
	# so the two never cross in a ragged line where they run nearly level.
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
	# the traced sections at FS 253, 296 and 357 (views.py), and at the apex.
	# The edge's waterline is where the side photos see it, from the apex on
	# to the wing's leading edge at the junction (the sections read it up to
	# 1.24 in higher); the upper surface falls to it from the root, so it
	# comes down toward the sections' own upper surface near the edge
	root_height = [(apex, start["waterline"] - profile("keel", apex)), (253, 42.6), (296, 43.0), (357, 42.7)]
	edge_line = [(apex, start["waterline"])] + [tuple(k) for k in LAYOUT["lex"]["edge"]] + [(junction, meet)]

	def root_line(station):
		return profile("keel", min(station, junction)) + smooth(root_height, station)

	# The underside: the traced sections' heights above the keel at each share
	# of the span (each section's own root to edge), run between them along
	# the stations and held behind FS 357
	sections_ = FACTS["lex"]["underside"]["value"]

	def traced(station, t):
		return smooth([(sec["station"], smooth([((bl - sec["heights"][0][0]) / (sec["edge"] - sec["heights"][0][0]), h) for bl, h in sec["heights"]], t)) for sec in sections_], station)

	def wing_low(station, bl):
		# the inner wing's lower surface over a buttline (its root's, BL 40,
		# inboard of that), or None off its chord
		bl = max(bl, 40.0)
		leading, chord, _ = wing.station(bl)
		x = (station - (456 - leading.x / INCH)) / chord
		return ORIGIN["waterline"] + wing.point(bl, x, -1).z / INCH if 0 <= x <= 1 else None

	cover = LAYOUT["lex"]["underside"]["clearance"]
	floor_ = wing_low(junction, 40.0) - cover   # the wing root's lower surface under the junction

	def roof(station, bl):
		# where the underside comes down to: just under the wing root's lower
		# surface under the junction, and just under the wing's own lower
		# surface wherever that is lower
		w = wing_low(station, bl)
		return floor_ if w is None else min(floor_, w - cover)

	last = sections_[-1]["station"]
	down = 456 - wing.station(40.0)[0].x / INCH   # the wing root's leading edge

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
	# The descent behind FS 357, as a share of the way down to the roof: none
	# at FS 357, through the splitter's top (its leading edge meets the
	# underside there, layout.inlet), all of it by the wing root's leading
	# edge (BL 40), arriving level
	f0, w0, b0 = LAYOUT["inlet"]["splitter"]["edge"][0]
	inner = body_at(f0, root_line(f0)) - 1.0
	t0 = (b0 - inner) / (smooth(knots, f0) - inner)
	held = profile("keel", f0) + traced(last, t0)
	descent = [(last, 0.0), (f0, (held - w0) / (held - roof(f0, b0))), (down, 1.0)]
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
			edge = smooth(edge_line, station)
			span = max(edge_bl - body_at(station, root), 0.0)
		else:
			# the outer side rides the inner wing just inboard of the junction
			edge_bl = reach - 5.0 * e
			edge = (wing_top(station, edge_bl) or meet) - 0.1 * e
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

		def under(bl, level=False):
			# the highest skin over a buttline: the fuselage's, or ahead of JOIN the inlet's
			found = [w for w in (beneath(starboard, bl, level), beneath(inlet, bl, level) if inlet else None) if w is not None]
			return max(found, default=None)

		# Ahead of FS 253 the blade's lip over its root and its least
		# thickness shrink with its span as its thickness does, to nothing at
		# the apex, so it starts from the wall as an edge, not a slab
		share = min(1.0, span / measured[253]) if station < 253 else 1.0

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
			wl = root + 0.5 * share - (root + 0.5 * share - edge) * smooth(LEX_FALL, t)
			if station > junction:
				# behind the junction it settles, once, onto what lies beneath, from
				# the blade with its root as it stands at the junction (the root
				# settling as well would settle it twice) and its edge riding the
				# wing; its first column, inside the body's wall, onto its settled root
				wl = root_line(junction) + 0.5 - (root_line(junction) + 0.5 - edge) * smooth(LEX_FALL, t)
				floor = settled if k == 0 else max([w for w in (settle(bl), wing_top(station, bl)) if w is not None], default=wl)
				wl = wl * (1 - e) + (floor + clearance) * e
			if 0 < k < across:
				floor = max([w for w in (under(bl, level=True), wing_top(station, bl)) if w is not None], default=None)
				if floor is not None and bl > body + 0.5:
					wl = max(wl, floor + clearance)
			top.append((bl, wl))
		if station > junction:
			top = lifted(top, [starboard] + ([inlet] if inlet else []), clearance)

		def underside(t, bl, wl):
			# the underside under the upper surface's wl at a share of the
			# span: ahead of FS 253 its thickness there shrinking with the
			# span; the traced sections to FS 357; then down to the roof
			if station > junction:
				b = roof(station, bl)
			elif station < 253:
				# the depth at FS 253 under the top there, so the two meet
				thick = smooth(root_height, 253) + 0.5 - (smooth(root_height, 253) + 0.5 - (smooth(edge_line, 253) - profile("keel", 253))) * smooth(LEX_FALL, t) - traced(253, t)
				b = wl - thick * span / measured[253]
			else:
				b = keel + traced(min(station, last), t)
				if station > last:
					b += (roof(station, bl) - b) * onward(descent, station)
			# on what rises under it (the cowl, the nacelle, the deck beside the
			# spine), just clear of it, never round it: what it enclosed would
			# go as hidden faces
			skin = under(max(bl, body + 1.5)) if station > last else None
			if skin is not None:
				b = max(b, skin + RIDE)
			return min(b, wl - (0.3 * share if station <= junction else 0.1))

		bottom = [(bl, underside(k / across, bl, wl)) for k, (bl, wl) in enumerate(top)]
		if station > last:
			bottom = lifted(bottom, [starboard] + ([inlet] if inlet else []), RIDE)
		# its root inside the body's wall at its own height too
		wall = body_at(station, bottom[0][1]) if station <= junction else core_at(station, bottom[0][1])
		bottom[0] = (min(body, wall - 1.0), bottom[0][1])
		sections.append((station, top, bottom))
	for station, top, bottom in sections:
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
	return exit_distances(centre, half, exponent, origin, [direction], reach)[0]


def exit_distances(centre, half, exponent, origin, directions, reach=120.0):
	# exit_distance() along each of the rays from origin in `directions` at
	# once (the same sums on each sample, so the same distances)
	t = np.linspace(0.0, reach, 961)
	d = np.asarray(directions, float).reshape(-1, 2)
	x = origin[0] + d[:, :1] * t - centre[0]
	y = origin[1] + d[:, 1:] * t - centre[1]
	b = np.where(y > 0, half[1], half[-1])
	if isinstance(exponent, tuple):
		exponent = np.where(y > 0, exponent[0], exponent[1])   # above and below the centre
	if isinstance(half[0], dict):
		out = x * half[0]["sign"] > 0
		a = np.where(out, half[0]["out"], half[0]["in"])
		exponent = np.where(out, exponent["out"], exponent["in"])
	else:
		a = np.where(y > 0, half[0][0], half[0][1]) if isinstance(half[0], tuple) else half[0]
	inside = np.abs(x / a) ** exponent + np.abs(y / b) ** exponent <= 1.0
	last = len(t) - 1 - np.argmax(inside[:, ::-1], axis=1)
	return [float(t[k]) if hit else 0.0 for k, hit in zip(last.tolist(), inside.any(axis=1).tolist())]


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
# than below ("upper"), fitted through the spine's flank points. Behind the
# speedbrake the top falls into the V between the nacelles' tops and the body
# narrows to the strip between the nozzles (layout.spine tail, narrowing()):
# carried on along the crest, it stood a flat cap between the nozzles 14 in
# above the photos' V
SPINE = LAYOUT["spine"]
TAIL = SPINE["tail"]
CORE = {
	"top": sorted([(s, w) for s, w in SPINE["crown"] if s >= 357] + [(540, 138.2), (600, 129.6)] + [tuple(SPINE["crest"][0])] + [tuple(p) for p in TAIL["top"]]),   # FS 540 and 600 as fitted (600 0.4 in under the crown the fit had, which the deck now swells back up); the photos' crest at the speedbrake's aft edge, then the tail's V
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
	# and narrowing with the body to the strip between the nozzles, where
	# between the nacelles' rings it would stand a web the photos do not show
	return narrowing(lambda s: smooth([(490.0, DECK_HALF), (510.0, DECK_HALF), (640.0, DECK_HALF - 18.0), (DECK_END + 20, DECK_HALF - 18.0)], s), station)


def narrowing(width, station):
	# A half-width (a function of the station) behind the speedbrake, narrowed
	# to the strip between the nozzles (layout.spine tail): its own run eased,
	# level at both ends, to half the strip's width
	start, end = TAIL["narrows"]
	return width(station) + (TAIL["strip"] / 2 - width(end)) * ease((station - start) / (end - start))


def core_widths(station):
	# The body's half-widths above and below its centre
	return narrowing(lambda s: onward(CORE["upper"], s), station), narrowing(lambda s: smooth(CORE["half"], s), station)


FLOOR = 12.0   # the body's exponent above its centre where it has narrowed to the strip (core_power())


def core_power(station):
	# The body's superellipse exponents above and below its centre. Above,
	# behind the speedbrake, eased up to FLOOR as the body narrows to the
	# strip, so that its top is the V's floor (layout.spine tail): at 2.6 it
	# stood a dome 2.8 in high over the strip's edges at FS 680, which had
	# turned to a trough between the nacelles' walls by FS 688, folding the
	# facets between 40-60 deg
	start, end = TAIL["narrows"]
	return 2.6 + (FLOOR - 2.6) * ease((station - start) / (end - start)), 2.6


def core_at(station, waterline):
	# The body's half-width at a waterline (its superellipse alone, without the
	# nacelles or the deck), 0 above or below it
	top, bottom = smooth(CORE["top"], station), smooth(CORE["bottom"], station)
	y = waterline - (top + bottom) / 2
	share = abs(y / ((top - bottom) / 2))
	if share >= 1:
		return 0.0
	power = core_power(station)[0 if y > 0 else 1]
	return core_widths(station)[0 if y > 0 else 1] * (1 - share ** power) ** (1 / power)


NOZZLE = LAYOUT["nozzle"]   # the outer flaps' start and exit, their radii, and the axis's waterline
# its centre falls from FS 580 onto the nozzles' axis at their start
NACELLE = [(445, 30.3, 103.3, 15.3, 16.5), (470, None, 104.5, 17.5, 17.5), (520, None, 105.5, 19.5, 18.5), (580, None, 106.0, 21.0, 19.0),
	(640, None, 106.0 + (NOZZLE["waterline"] - 106.0) * (640 - 580) / (692 - 580), 20.0, 18.5), (692, None, NOZZLE["waterline"], 18.5, 17.5)]
# Each nacelle ends on its outer flaps' start circle (layout.nacelle end),
# its section eased into that circle from `round`, and runs `lip` on over the
# flaps to the fuselage's last ring: ended on its own section at FS 692, it
# stood an annulus 0.6-0.9 in round the flaps
END = LAYOUT["nacelle"]["end"]
TAIL_END = NOZZLE["start"] + END["lip"]
# inches the end's sections stand outside that circle: the skin's facets
# between its columns cut up to 0.2 in inside their corners, and on the
# circle itself the alternate flaps showed through the lip in teeth
LIP = 0.15


def rounding(station):
	# how far a nacelle's section has eased into its end circle
	return ease((station - END["round"]) / (NOZZLE["start"] - END["round"]))


# The fuselage station where each inlet's outer skin hands over to the rear
# fuselage's nacelle, round the duct
JOIN = 440.0


def union_ring(station, angles=None, sided=True):
	# The rear fuselage at a station: the smooth union of the central body and
	# the two nacelles, sampled at ANGLES round the central body's mid-height.
	# The nacelles join it whole at JOIN: ahead of that the inlets' own outer
	# skins (inlets()) stand in for them, and the fuselage's ring jumps out to
	# the nacelles between its last station ahead of JOIN and JOIN itself,
	# inside them, where the ducts pass (canopy() leaves those faces out)
	top, bottom = smooth(CORE["top"], station), smooth(CORE["bottom"], station)
	upper, half = core_widths(station)
	centre = (0.0, (top + bottom) / 2)
	core = ((0.0, centre[1]), ((upper, half), (top - bottom) / 2), core_power(station))
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
			power = 2.3 + (2.0 - 2.3) * rounding(station)   # a circle at the end
			for side in (1, -1):
				if outboard is None:
					parts.append(((side * b, w), (a, up, down), power))
				else:
					parts.append(((side * b, w), ({"in": a, "out": outboard, "sign": side}, up, down), {"in": power, "out": flat[1]}))
			deck = deck_top(station)
			if deck is not None and deck > w + 0.25:
				wide = deck_half(station)
				if outboard is not None:
					# a smooth minimum, so the edge leaves DECK_SIDE for the
					# deck's own taper with no kink
					wide = -math.log(math.exp(-wide) + math.exp(-DECK_SIDE))
				parts.append(((0.0, w), (wide, deck - w, DECK_BELOW), DECK_EXPONENT))
		directions = [(math.sin(theta), math.cos(theta)) for theta in turns]
		reaches = list(zip(*(exit_distances(c, h, n, centre, directions) for c, h, n in parts)))
		ring = []
		for direction, each in zip(directions, reaches):
			r = sum(x ** 10 for x in each) ** 0.1
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
	if angles is DENSE and station > TAIL["narrows"][0]:
		# the V above, and the notch below between the strip and the
		# nacelles' lower sides (walked from the keel, upside down)
		ring = walled(ring, centre, nacelle_at(station)[0], ease((station - TAIL["narrows"][0]) / TAIL_EASE), rounding(station))
		ring = [(x, -y) for x, y in reversed(valley([(x, -y) for x, y in reversed(ring)], (centre[0], -centre[1])))]
	ring = doored(station, ring)
	if sided:
		# the band on the sided outline alone: the columns are spaced along
		# the unsided one (along()), and shortened by the tunnel's walls it
		# moved every column round the section, the upper skin's with them
		ring = floored(station, centre, ring)
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
		sill = angles_at(station, centre)[SILL]
		ring = ring[:SILL] + along(station, sill, len(ring) - SILL)
		if station > TAIL["narrows"][0]:
			# behind the speedbrake the steps run evenly along the outline's
			# legs (spaced()), eased in from the sill's split: as the
			# top falls into the V between the nacelles the steps above the
			# sill (a tenth of the outline, on the strip) and the sparser ones
			# below met its walls differently from station to station, and
			# twisted the facets between. Each step's angle is eased, and the
			# point taken on the outline there (eased point by point, the steps
			# cut inside the outline by up to an inch)
			weight = ease((station - TAIL["narrows"][0]) / TAIL_EASE)
			theta, path, _ = outline(station, 0.0)
			turn = lambda p: math.atan2(p[0] - centre[0], p[1] - centre[1])
			turns = [turn(a) + (turn(b) - turn(a)) * weight for a, b in zip(ring, spaced(station, len(ring)))]
			ring = [(float(np.interp(a, theta, path[:, 0])), float(np.interp(a, theta, path[:, 1]))) for a in turns]
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


def walled(ring, centre, side, weight, level, drop=0.25):
	# Behind the speedbrake the V between the nacelles' tops: its walls run
	# straight from the strip's edge, where the top leaves its level by
	# `drop` inches, to where they touch a nacelle's rounded top (the outline
	# there highest seen from the edge, inboard of the nacelle's centre
	# buttline `side`), each sample moved out along its ray onto the wall,
	# by `weight` (the V eased in behind the speedbrake). By `level` the
	# walls give way to the nacelles' own round sides down to the strip, the
	# strip carried across to them: at the nozzles the V reaches the gap
	# between their rings (layout.spine tail), where straight walls stood
	# 0.6 in inside the rings above the strip. The union of the body and the
	# nacelles left a groove 1.3-3 in deep along each of the strip's edges
	# from FS 676 to the end, the facets between folded 60-100 deg; and
	# where no ray from the centre meets a nacelle's inboard wall, a notch
	# the loft's columns crossed in shards
	top = ring[0][1]
	c = next((k for k, (x, y) in enumerate(ring) if abs(y - top) > drop), None)
	if c is None or c == 0 or weight <= 0:
		return ring
	c -= 1
	(x0, y0) = ring[c]
	reach = [k for k in range(c + 1, len(ring)) if x0 < ring[k][0] <= side]
	if not reach:
		return ring
	touch = max(reach, key=lambda k: math.atan2(ring[k][1] - y0, ring[k][0] - x0))
	across = next((k for k in reach if ring[k][1] >= y0), touch)

	def onto(k, far):
		# sample k moved out along its ray onto the chord from the edge to
		# sample `far` (as it is, beyond it or where the chord runs inside it)
		x, y = ring[k]
		if k >= far:
			return x, y
		(x1, y1), dx, dy = ring[far], x - centre[0], y - centre[1]
		ex, ey = x1 - x0, y1 - y0
		det = dx * ey - dy * ex
		if abs(det) < 1e-12:
			return x, y
		t = ((x0 - centre[0]) * ey - (y0 - centre[1]) * ex) / det
		return (centre[0] + dx * t, centre[1] + dy * t) if t > 1.0 else (x, y)

	out = list(ring)
	for k in range(c + 1, max(touch, across)):
		(ax, ay), (bx, by) = onto(k, touch), onto(k, across)
		x, y = ring[k]
		wall = (ax + (bx - ax) * level, ay + (by - ay) * level)
		out[k] = (x + (wall[0] - x) * weight, y + (wall[1] - y) * weight)
	return out


def valley(ring, centre, leap=1.0, stride=4):
	# Behind the speedbrake the top falls into a V between the nacelles'
	# tops, whose walls below where a ray from the centre grazes a nacelle no
	# ray meets: there the outline dives down the strip's side and leaps back
	# up onto the nacelle, a notch the loft's columns crossed in shards. Each
	# leap outward of more than `leap` inches between neighbouring samples is
	# closed by the chord across the notch's mouth, from where the dive begins
	# (going back from the leap, the first `stride` samples running nearer
	# level than steep: the samples step in hundredths of an inch) to the
	# leap's far side. Bridged instead by the flattest chord over the outline
	# before it, the notch took the visible trough beside the strip with it
	# as soon as it opened, and the skin folded there
	r = [math.hypot(x - centre[0], y - centre[1]) for x, y in ring]
	out = list(ring)
	for i in range(len(ring) - 1):
		if r[i + 1] - r[i] <= leap:
			continue
		c = i
		while c >= stride and abs(ring[c][1] - ring[c - stride][1]) > abs(ring[c][0] - ring[c - stride][0]):
			c -= 1
		(x0, y0), (x1, y1) = ring[c], ring[i + 1]
		for k in range(c + 1, i + 1):
			f = (k - c) / (i + 1 - c)
			out[k] = (x0 + (x1 - x0) * f, y0 + (y1 - y0) * f)
	return out


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


def floored(station, centre, ring):
	# layout.band: between the nacelles the photos see the belly as a nearly
	# flat band level with the main gear inner doors' inboard edges, crowned on
	# the centreline, where the HATP fit hollowed a tunnel 6-8 in deeper. Under
	# the nacelles' inner halves (out to the band's reach) the outline takes a
	# line across the buttlines through the band's centre, the doors' inboard
	# edges where they run and the outline's own height at the reach, a
	# monotone cubic, mirrored so the crown is level; eased in from the
	# forebody and out to the tail over the band's fades, the edge held past
	# its ends (a knot that came and went with the station creased the skin
	# 6 deg there). Ahead of the first drain the centre runs on from the
	# forebody's keel (layout.belly)
	band = LAYOUT["band"]
	f0, f1, f2, f3 = band["fade"]
	if not f0 < station < f3:
		return ring
	weight = ease((station - f0) / (f1 - f0)) if station < f1 else ease((f3 - station) / (f3 - f2)) if station > f2 else 1.0
	reach = band["reach"]
	# the lower outline: below the nacelles' centre line (the core's mid-height
	# lies above the nacelles' tops aft, which lie inside the reach)
	below = nacelle_at(station)[1]
	lower = [(x, y) for x, y in ring if y < below]
	# the outline's own height at the reach: the lowest crossing of that buttline
	crossings = [y0 + (y1 - y0) * (reach - x0) / (x1 - x0) for (x0, y0), (x1, y1) in zip(lower, lower[1:]) if (x0 - reach) * (x1 - reach) <= 0 and x0 != x1]
	if not crossings:
		return ring
	edge = min(crossings)
	floor = band["floor"]
	b = smooth([(k[0], k[1]) for k in floor], station)
	w = smooth([(k[0], k[2]) for k in floor], station)
	knots = [(0.0, smooth([tuple(k) for k in band["centre"]], station)), (b, w), (-b, w), (reach, edge), (-reach, edge)]
	out = []
	for x, y in ring:
		if y < below and abs(x) < reach:
			y += (smooth(knots, abs(x)) - y) * weight
		out.append((x, y))
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


FLUSH = 0.06   # how far a plate laid on the skin (a lens, a probe's plate) stands off it, in: enough to keep it out of the skin's facets


def flush(tree, ends, side, width, inward, proud=FLUSH, under=0.05, steps=6, across_steps=6):
	# A flush plate on a built face between two points ([FS, WL, BL] on the
	# right; mirrored for the left), `width` inches across: each of its points,
	# along it and across it, cast along `inward` onto the face and stood
	# `proud` off it, its back `under` beneath, so a plate follows the face it
	# is measured on, curved as it is both ways
	(f0, w0, b0), (f1, w1, b1) = ends
	a, b = at(f0, w0, side * b0), at(f1, w1, side * b1)
	across = (b - a).cross(inward).normalized()
	rings = []
	for i in range(steps + 1):
		middle = a.lerp(b, i / steps)
		outer, inner = [], []
		for k in (-1 + 2 * j / across_steps for j in range(across_steps + 1)):
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
	# on what it stands on. The tip launchers' strips are built with the
	# launchers (stores()). Lenses' sizes are estimated
	strips, points = LAYOUT["strips"], LAYOUT["lights"]["points"]
	lens = 2.0   # in across a lens, estimated
	for side in (-1, 1):
		name = side_name(side)
		inward = Vector((0, side, 0))   # along the buttline toward the centreline
		fin = built([f"fin_{name}"])
		node(f"formation_fin_{name}", mesh=flush(fin, strips["fin"], side, strips["width"], inward), paint="lights")
		node(f"formation_body_{name}", mesh=flush(built(["fuselage"]), strips["body"], side, strips["width"], inward), paint="lights")
		# the strobes on the fins' faces and the position lights on the LEX's
		# edges, each cast in along the buttline
		for key, part, toward in ((f"strobe_{name}", f"fin_{name}", inward), (f"position_lex_{name}", f"lex_{name}", inward)):
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


CHEEK = {}   # each side's LAU-116 block corners (cheeks()), which its round and hooks hang by (stores())


def cheek_front():
	# The LAU-116's front edge's station: its front_top and front_bottom marks' mean
	lau = LAYOUT["stores"]["lau116"]
	return (lau["front_top"][0] + lau["front_bottom"][0]) / 2


def cheek_face(station, waterline):
	# The station's outboard face's buttline (layout.nacelle cheek face): a
	# plane leaning in going up, measured at the slot, and ahead of it through
	# the block's front_top mark (layout.stores.lau116) at the same lean,
	# straight between
	face, (_, w0, b0) = LAYOUT["nacelle"]["cheek"]["face"], LAYOUT["stores"]["lau116"]["front_top"]
	ahead = b0 + face["lean"] * (w0 - face["waterline"])
	base = smooth([[cheek_front(), ahead], [face["station"], face["buttline"]]], station)
	return base + face["lean"] * (face["waterline"] - waterline)


def cheek_lines(station):
	# The station's bottom, the box's top (None ahead of the box) and the
	# station's top, where it meets the nacelle's skin, at a station: the
	# ramp's line up to the front edge's crest, the fairing's on until it falls
	# onto the box's top, arriving level (dvids9393266's outline curves into
	# the box's top), then the box's top (layout.stores.lau116 fairing,
	# layout.nacelle cheek)
	lau, box = LAYOUT["stores"]["lau116"], LAYOUT["nacelle"]["cheek"]
	front, fairing = cheek_front(), lau["fairing"]
	bottom = smooth([[front - 20.0, lau["front_bottom"][1]], [front, lau["front_bottom"][1]]] + box["bottom"], station)
	top = smooth(box["top"], station) if station >= box["front"] else None
	line = onward([tuple(k) for k in fairing["ramp"]["top"] + [[front, lau["crest"][1]]] + fairing["top"]], station)
	if top is not None:
		line = top if station >= fairing["top"][-1][0] else max(line, top)
	return bottom, top, line


def bezier(points, n):
	# n points along a Bezier curve through its control points (2D tuples),
	# its ends included
	out = []
	for k in range(n):
		t = k / (n - 1)
		ps = [np.array(p, float) for p in points]
		while len(ps) > 1:
			ps = [a * (1 - t) + b * t for a, b in zip(ps, ps[1:])]
		out.append(ps[0])
	return out


def cheek_ring(station, wall, inner, shape=None, offset=0.0, room=0.0):
	# One section of the cheek station at a station, as (WL, BL) on the right,
	# from the skin under its bottom out round its outboard face and over its
	# top into the skin, and back down the skin (or, behind the box's sweep,
	# its aft face, `inner`): the bottom's corner rounded by the edges'
	# radius (layout.stores.lau116 round); the face on its plane (cheek_face())
	# up to the box's top, its top corner rounded and the fairing over the box
	# set in from it (layout.stores.lau116 fairing inset), or over the block up
	# to the box's top's height, where the block's face rises on to the
	# station's top; from there to the skin one cubic, leaving along the face
	# (the fairing over the box upright) and meeting the skin turned into it
	# (layout.nacelle cheek section into), eased flat onto the box's top as
	# the fairing above it falls to nothing (ease); the same number of points
	# in every section (43), each feature on its own points. `shape`
	# overrides (bottom, box top, station's top, knee) for the block's and the
	# ramp's sections; `offset` draws the face in, as the box's aft edge
	# rounds into its aft face; `room` takes the way back down inside the skin
	# by that much
	lau, box = LAYOUT["stores"]["lau116"], LAYOUT["nacelle"]["cheek"]
	bottom, top, line = cheek_lines(station)
	knee = smooth(box["top"], box["front"])
	if shape is not None:
		bottom, top, line, knee = shape
	face = lambda w: cheek_face(station, w) - offset
	up = np.array([1.0, -LAYOUT["nacelle"]["cheek"]["face"]["lean"]])
	up /= np.linalg.norm(up)
	inboard = np.array([0.0, -1.0])
	# the bottom: out along the skin's foot to the corner, rounded
	c0 = np.array([bottom, face(bottom)])
	start = np.array([bottom, inner(bottom)])
	# a corner's rounding starts this far along each face: a round of that
	# radius turning the face's 107 deg
	turn = math.acos(float(np.dot(np.array([0.0, 1.0]), up)))
	t = min(lau["round"] * math.tan(turn / 2), 0.4 * (c0[1] - start[1]))
	points = [start + (c0 - np.array([0.0, t]) - start) * k / 3 for k in range(3)]
	points += bezier([c0 - np.array([0.0, t]), c0, c0 + up * t], 5)
	if top is not None:
		# the face up to the box's top corner, rounded; the ledge to the
		# fairing's foot, set in from the corner
		c1 = np.array([top, face(top)])
		reach = c1[1] - inner(top)
		t1 = min(box["section"]["corner"], 0.3 * reach)
		ends = c0 + up * t, c1 - up * t1
		points += [ends[0] + (ends[1] - ends[0]) * k / 5 for k in range(1, 6)]
		points += bezier([c1 - up * t1, c1, c1 + inboard * t1], 4)[1:]
		foot = c1 + inboard * min(lau["fairing"]["inset"], 0.5 * reach)
		leave = np.array([1.0, 0.0])
		height = line - top
	else:
		# the block's face up to the knee, then on along the plane to the
		# fairing's foot, where the cubic takes over
		c1 = np.array([knee, face(knee)])
		ends = c0 + up * t, c1
		points += [ends[0] + (ends[1] - ends[0]) * k / 5 for k in range(1, 6)]
		points += [c1 + up * (0.1 * k) for k in range(1, 4)]
		foot = c1 + up * lau["fairing"]["inset"]
		leave = up
		height = line - knee
	points.append(foot)
	# from the foot over into the skin at the station's top
	end = np.array([line, inner(line)])
	along = np.array([1.0, wall(line + 0.5) - wall(line - 0.5)])
	along /= np.linalg.norm(along)
	into = np.array([along[1], -along[0]])
	arrive = along * math.cos(math.radians(box["section"]["into"])) + into * math.sin(math.radians(box["section"]["into"]))
	g = min(1.0, max(0.0, height / box["section"]["ease"]))
	g = g * g * (3 - 2 * g)
	d0, d1 = leave * g + inboard * (1 - g), arrive * g + inboard * (1 - g)
	d0, d1 = d0 / np.linalg.norm(d0), d1 / np.linalg.norm(d1)
	m = box["section"]["span"] * np.linalg.norm(end - foot)
	for k in range(1, 15):
		u = k / 14
		points.append((2 * u ** 3 - 3 * u ** 2 + 1) * foot + (u ** 3 - 2 * u ** 2 + u) * m * d0 + (-2 * u ** 3 + 3 * u ** 2) * end + (u ** 3 - u ** 2) * m * d1)
	# and back down the skin (or the aft face) to the bottom, close enough to
	# lie on the skin, which then hides it (the cull)
	points += [np.array([line - (line - bottom) * k / 13, inner(line - (line - bottom) * k / 13) - room]) for k in range(1, 13)]
	return points


def cheeks():
	# The cheek station on each nacelle's side, airframe, shown with or
	# without the stores (layout.nacelle cheek, layout.stores.lau116): one
	# loft from the ramp's front to the box's aft edge, each section from the
	# nacelle's skin out round the outboard face and over the top into the
	# skin (cheek_ring()). Ahead of the front edge, the ramp: the front edge's
	# section, its heights scaled to the ramp's line and drawn in to the skin
	# as it runs forward, a crease along the front edge. Behind the box's top
	# drop, its aft face sweeps from the skin back out to the aft edge
	# (layout.nacelle cheek sweep), concave, leaving the skin along it and
	# meeting the face as it rounds in over its last inches: in plan, a
	# quarter ellipse each, square to the jet where they meet. The slot sunk
	# inboard into the face behind the box's front. The rest of the launcher
	# lies inside the nacelle: not built
	lau, box = LAYOUT["stores"]["lau116"], LAYOUT["nacelle"]["cheek"]
	front, edge, sweep, round_ = cheek_front(), box["edge"], box["sweep"]["run"], box["sweep"]["round"]
	quarter = lambda u: 1 - math.sqrt(1 - min(1.0, max(0.0, u)) ** 2)
	skin = built(["fuselage"])
	nose = lau["fairing"]["ramp"]["top"][0][0]
	for side in (-1, 1):
		name = side_name(side)
		reach = 6.0 + max(cheek_face(front, 70.0), cheek_face(box["face"]["station"], 70.0))

		def wall(station, w):
			# the nacelle's skin at a station and waterline, BL, cast inboard
			start = fwb([station, w, reach], side)
			hit = skin.ray_cast(start, (fwb([station, w, 0.0], side) - start).normalized())[0]
			if hit is None:
				raise SystemExit(f"no nacelle skin under the cheek station at FS {station:.1f}, WL {w:.1f}")
			return reach - (hit - start).length / INCH

		def offset(station):
			# the face drawn in as the aft edge rounds
			return round_ * quarter((station - edge + round_) / round_)

		slot = box["slot"]

		def room(station):
			# round the slot the station's inner side runs on inside the nacelle's
			# side (slot room), so the slot's floor, inboard of the side where the
			# face leans in over it, stays inside the station
			(a, b) = slot["stations"]
			return slot["room"] * min(1.0, max(0.0, station - a + 2.0), max(0.0, b + 2.0 - station))

		def inner(station):
			# the skin under the station, or behind the sweep's start its aft face:
			# from the skin back out to the aft edge's tip, the face rounded in
			# there, leaving the skin along it; never thinner than the edge
			def at(w):
				s0 = edge - sweep
				if station <= s0:
					return wall(station, w)
				tip = cheek_face(station, w) - round_
				aft = wall(station, w) + (tip - wall(station, w)) * quarter((station - s0) / sweep)
				return min(aft, cheek_face(station, w) - offset(station) - box["sweep"]["edge"])
			return at

		rings = []
		# the ramp: the front edge's section, its heights scaled from its bottom
		# to the ramp's line and drawn in to the skin, all but gone at its front
		bottom, _, line = cheek_lines(front)
		knee = smooth(box["top"], box["front"])
		first = cheek_ring(front, lambda w: wall(front, w), lambda w: wall(front, w))
		for st in [nose] + [float(s) for s in range(math.ceil(nose + 0.5), math.ceil(front - 0.5))]:
			b_, _, l_ = cheek_lines(st)
			k = (l_ - b_) / (line - bottom)
			drawn = max(0.03, (st - nose) / (front - nose))
			ring = []
			for w, b in first:
				w_ = b_ + (w - bottom) * k
				ring.append((w_, wall(st, w_) + drawn * (b - wall(front, w))))
			rings.append((st, ring))
		stations = [front] + [float(s) for s in range(math.ceil(front + 0.5), math.floor(box["front"]))] + [box["front"]]
		stations += [box["front"] + 0.05] + [float(s) for s in range(math.ceil(box["front"]), 544)]
		stations += [544.0 + 0.5 * k for k in range(25)] + [557.0, 558.0, edge - sweep]
		# the sweep's rings, closer as its curves steepen into the tip
		stations += sorted({round(edge - sweep + sweep * k / 12, 3) for k in range(1, 12)} | {round(edge - round_ * (1 - math.sin(math.pi / 2 * k / 6)), 3) for k in range(7)})
		for st in stations:
			shape = (cheek_lines(st)[0], None, cheek_lines(st)[2], knee) if st <= box["front"] else None
			rings.append((st, cheek_ring(st, lambda w, st=st: wall(st, w), inner(st), shape, offset(st), room(st))))
		mesh = outward(loft([[fwb([st, w, b], side) for w, b in ring] for st, ring in rings]))
		# the slot in the face behind its front, a rounded oblong sunk inboard
		# into the face, its walls level
		(s0, s1), (w0, w1), rr = slot["stations"], slot["waterlines"], slot["round"]
		corners_ = ((s1 - rr, w1 - rr, 0), (s0 + rr, w1 - rr, 90), (s0 + rr, w0 + rr, 180), (s1 - rr, w0 + rr, 270))
		oblong = [(st + rr * math.cos(math.radians(a0 + 15 * i)), w + rr * math.sin(math.radians(a0 + 15 * i))) for st, w, a0 in corners_ for i in range(7)]
		cutter = loft([[fwb([st, w, cheek_face(st, w) + depth], side) for st, w in oblong] for depth in (-slot["depth"], 1.0)])
		node(f"fairing_cheek_{name}", mesh=recessed(mesh, outward(cutter)))
		# the marks (marking.md): the block's front edge's ends and crest, the
		# box's aft edge's middle and its top front corner
		top = lau["front_top"][1]
		corners = {"front_top": fwb([front, top, cheek_face(front, top)], side), "front_bottom": fwb([front, bottom, cheek_face(front, bottom)], side),
			"crest": fwb([front, line, wall(front, line)], side), "back": fwb([box["front"], top, cheek_face(box["front"], top)], side)}
		CHEEK[side] = corners
		for key in ("front_top", "front_bottom", "crest"):
			MARKS[f"ejector_{key}_{name}"] = (corners[key], f"fairing_cheek_{name}")
		middle = (smooth(box["bottom"], edge) + smooth(box["top"], edge)) / 2
		MARKS[f"fairing_cheek_aft_{name}"] = (fwb([edge, middle, cheek_face(edge, middle)], side), f"fairing_cheek_{name}")
		MARKS[f"fairing_cheek_front_{name}"] = (fwb([box["front"], knee, cheek_face(box["front"], knee)], side), f"fairing_cheek_{name}")


def recessed(mesh, cutter):
	# A closed mesh with a closed cutter's solid taken out of it (an exact
	# boolean difference): (vertices, faces)
	made = []
	for name, (vertices, faces) in (("recessed", mesh), ("cutter", cutter)):
		data = bpy.data.meshes.new(name)
		data.from_pydata(vertices, [], faces)
		obj = bpy.data.objects.new(name, data)
		bpy.context.scene.collection.objects.link(obj)
		made.append(obj)
	cut = made[0].modifiers.new("cut", "BOOLEAN")
	cut.operation, cut.solver, cut.object = "DIFFERENCE", "EXACT", made[1]
	evaluated = made[0].evaluated_get(bpy.context.evaluated_depsgraph_get())
	data = evaluated.to_mesh()
	out = [v.co.copy() for v in data.vertices], [tuple(p.vertices) for p in data.polygons]
	evaluated.to_mesh_clear()
	for obj in made:
		mesh_ = obj.data
		bpy.data.objects.remove(obj)
		bpy.data.meshes.remove(mesh_)
	return out


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
	down = w - nacelle_bottom(station)
	# eased into the circle it ends on, round the engine's axis (layout.nacelle
	# end), LIP outside it all round (with the bottom kept inside it, the
	# skin crossed the flaps' forward ends round the lower outboard quarter,
	# and the alternate flaps showed through it in teeth)
	k = rounding(station)
	r = END["radius"] + LIP
	return b, w + (NOZZLE["waterline"] - w) * k, a + (r - a) * k, up + (r - up) * k, down + (r - down) * k


MOUTH_SIDES = 80   # points round the inlet's mouth, from its top outboard and round: at 40 the rings'
# chords cut 0.2 in inside the fuselage's outline where the two meet
DUCT_NEAR = 9   # rings down each inlet's duct from the lip's inside to its first fitted section, round every point
DUCT_STEP = 3.5   # inches between the duct's rings behind that section, round every other point (dark there)


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


def duct_run():
	# The duct's fitted sections (layout.inlet duct sections), each (FS, BL
	# and WL of its centre, half-width, half-height, exponent), then the
	# engine face's circle (engine.face) round the engine's axis at X/D 6.5
	# behind the lip's top (layout.inlet duct face)
	if "run" not in MOUTH:
		duct, nozzle = LAYOUT["inlet"]["duct"], LAYOUT["nozzle"]
		face = LAYOUT["inlet"]["lip"]["top"][0] + duct["face"] * value(FACTS["engine"]["inlet"])
		r = value(FACTS["engine"]["face"]) / 2
		MOUTH["run"] = [tuple(float(v) for v in s) for s in duct["sections"]] + [(face, engine_buttline(face), float(nozzle["waterline"]), r, r, 2.0)]
	return MOUTH["run"]


def duct_start():
	# the station of the duct's first ring, half the wall inside the lip and
	# 1.2 in down, its points' mean
	lip = mouth_ring(1.2, MOUTH["wall"])
	return sum(p[0] for p in lip) / len(lip)


def duct_ring(station, every=1):
	# The duct's inside at a station, as (FS, WL, BL outboard) round every
	# `every`th of the mouth's directions: the mouth's D half the wall inside
	# the lip, raked as the lip, giving way to the fitted sections and on to
	# the engine face's circle (duct_run()), each a superellipse round its
	# centre. The D and the rake ease out by the first section; the centre
	# leaves the mouth's level, and the sections' centres, sizes and
	# exponents run on monotone cubics through them
	run = duct_run()
	lip = mouth_ring(1.2, MOUTH["wall"])
	start, first = duct_start(), run[0][0]
	w = ease((station - start) / (first - start))
	c = MOUTH["centre"]
	bl, wl = (smooth([(start - 20.0, c[k]), (start, c[k])] + [(s[0], s[1 + k]) for s in run], station) for k in (0, 1))
	a, h, n = (smooth([(s[0], s[k]) for s in run], station) for k in (3, 4, 5))
	out = []
	for i in range(0, MOUTH_SIDES, every):
		s0, w0, b0 = lip[i]
		t = 2 * math.pi * i / MOUTH_SIDES
		x, y = math.sin(t), math.cos(t)
		r = math.hypot(b0 - c[0], w0 - c[1]) * (1 - w) + w / ((abs(x) / a) ** n + (abs(y) / h) ** n) ** (1 / n)
		out.append((station + (s0 - start) * (1 - w), wl + y * r, bl + x * r))
	return out


def duct_stations():
	# The stations of the duct's rings behind the lip's: DUCT_NEAR to its
	# first fitted section, then every DUCT_STEP or less to the engine face
	run = duct_run()
	start, first, face = duct_start(), run[0][0], run[-1][0]
	near = [start + (first - start) * k / DUCT_NEAR for k in range(1, DUCT_NEAR + 1)]
	count = math.ceil((face - first) / DUCT_STEP)
	return near, [first + (face - first) * k / count for k in range(1, count + 1)]


def engine_face():
	# The engine face closing each duct: its station, centre (BL outboard,
	# WL), radius, and the hub's radius and length ahead of it, round the
	# engine's axis (engine.face, layout.inlet duct hub)
	face, bl, wl, r, _, _ = duct_run()[-1]
	radius, length = LAYOUT["inlet"]["duct"]["hub"]
	return face, (bl, wl), r, radius, length


HUB = [0.45, 0.75, 0.93]   # the hub's rings, as shares of its length ahead of the face


def faced(station, waterline, buttline):
	# Whether each point (arrays of FS, WL, BL) lies on an engine face: on its
	# disc, within a quarter inch of its plane, or on its hub (engine_face())
	face, (bl, wl), r, radius, length = engine_face()
	shape = np.shape(station)
	station, waterline, buttline = np.ravel(station), np.ravel(waterline), np.abs(np.ravel(buttline))
	off = np.hypot(buttline - bl, waterline - wl)
	ahead = np.clip((face - station) / length, 0, 1)
	disc = (station > face - 0.25) & (station < face + 0.25) & (off < r + 0.25)
	hub = (station > face - length - 0.25) & (station <= face) & (off < radius * np.sqrt(1 - ahead ** 2) + 0.25)
	return (disc | hub).reshape(shape)


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
	# Each inlet: an open duct from the lip aft through the nacelle to the
	# engine face, its lip rounded (duct_ring(), layout.inlet duct): round
	# every point of the mouth to its first fitted section, every other point
	# behind it, where it is dark, then the engine face's disc and hub
	# (engine_face()); behind the lip its outer surface eases from the mouth's
	# D into the rear fuselage at JOIN, where the fuselage's nacelle takes
	# over, open there
	wall = MOUTH["wall"]
	near, deep = duct_stations()
	face, (bl, wl), _, radius, length = engine_face()
	turns = [2 * math.pi * i / MOUTH_SIDES for i in range(0, MOUTH_SIDES, 2)]
	for side in (-1, 1):
		name = side_name(side)

		def ring(depth, inset, blend=0.0):
			return [at(s_, w, side * b) for s_, w, b in inlet_ring(depth, inset, blend)]

		def duct(station, every=1):
			return [at(s_, w, side * b) for s_, w, b in duct_ring(station, every)]

		def circle(station, r):
			return [at(station, wl + math.cos(t) * r, side * (bl + math.sin(t) * r)) for t in turns]

		rings = [duct(st) for st in reversed(near)]
		rings += [ring(1.2, wall), ring(-0.4, wall / 2), ring(1.2, 0)]
		rings += [ring(depth, 0, outer_blend(depth)) for depth in INLET_OUTER[1:] + [JOIN - MOUTH["station"]]]
		vertices, faces = loft(rings)
		faces = faces[:-2]
		# from the hub's tip aft: its rings, the disc's inner edge, the duct's
		# rings round every other point, then into the first fitted section's
		back = [circle(face - length * u, radius * math.sqrt(1 - u * u)) for u in reversed(HUB)] + [circle(face, radius)]
		back += [duct(st, 2) for st in reversed(deep)]
		half = MOUTH_SIDES // 2
		base = len(vertices)
		vertices += [at(face - length, wl, side * bl)] + [v for r in back for v in r]
		faces += [(base, base + 1 + (i + 1) % half, base + 1 + i) for i in range(half)]
		for k in range(len(back) - 1):
			a, b = base + 1 + k * half, base + 1 + (k + 1) * half
			faces += [(a + i, a + (i + 1) % half, b + (i + 1) % half, b + i) for i in range(half)]
		a = base + 1 + (len(back) - 1) * half
		for j in range(half):
			i, k = 2 * j, (j + 1) % half
			faces += [(a + j, a + k, i + 1), (a + j, i + 1, i), (a + k, (i + 2) % MOUTH_SIDES, i + 1)]
		# its outer skin faces out: the top of its last ring ahead of JOIN up
		top = ring(INLET_OUTER[-1], 0, outer_blend(INLET_OUTER[-1]))[0]
		node(f"inlet_{name}", mesh=(vertices, faces), out=(top, Vector((0.0, 0.0, 1.0))))
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


def serrated(p0, p1, inner, outer, teeth=24):
	# A ribbed ring from p0 to p1: its rim's radius alternating between inner
	# and outer, `teeth` ribs round it (a gland nut's grip)
	axis = (p1 - p0).normalized()
	u = axis.orthogonal().normalized()
	v = axis.cross(u)
	sides = teeth * 2
	return loft([[p + (u * math.cos(2 * math.pi * i / sides) + v * math.sin(2 * math.pi * i / sides)) * ((outer if i % 2 else inner) * INCH)
		for i in range(sides)] for p in (p0, p1)])


# How far a pin's end or a bolt's head stands off the face it sits on,
# inches: enough to draw its edge. The photos see these face on, which gives
# their diameters and not their heights
STANDOFF = 0.15
LUG = 1.2   # the side brace's bolt boss on the post's lower casting, half its length along the bolt, in


def hollow(end, axis, size):
	# A hollow pin's end at `end` on a face, standing off it along `axis`:
	# size [its diameter, its bore's], inches; the bore a dark disc just under
	# its face
	outer, bore = size
	axis = axis.normalized()
	return merge([cylinder(end, end + axis * (STANDOFF * INCH), outer / 2, sides=16),
		finished(cylinder(end + axis * ((STANDOFF - 0.05) * INCH), end + axis * ((STANDOFF + 0.01) * INCH), bore / 2, sides=12), "hub")])


def stud(end, axis, diameter):
	# A round bolt head at `end` on a face, standing off it along `axis`,
	# `diameter` inches across
	return cylinder(end, end + axis.normalized() * (STANDOFF * INCH), diameter / 2, sides=12)


def hose(points, diameter, sides=6, steps=6):
	# A line of round stock `diameter` inches across through points,
	# smoothed between them (Catmull-Rom; steps=1 keeps it straight from one
	# to the next), its section carried along it without twist
	ends = [points[0]] + list(points) + [points[-1]]
	path = []
	for i in range(1, len(ends) - 2):
		p0, p1, p2, p3 = ends[i - 1], ends[i], ends[i + 1], ends[i + 2]
		for k in range(steps):
			t = k / steps
			path.append((p1 * 2 + (p2 - p0) * t + (p0 * 2 - p1 * 5 + p2 * 4 - p3) * t * t + (p1 * 3 - p0 - p2 * 3 + p3) * t ** 3) * 0.5)
	path.append(points[-1])
	u = (path[1] - path[0]).normalized().orthogonal().normalized()
	rings = []
	for i, p in enumerate(path):
		t = (path[min(i + 1, len(path) - 1)] - path[max(i - 1, 0)]).normalized()
		u = (u - t * u.dot(t)).normalized()
		v = t.cross(u)
		rings.append([p + (u * math.cos(2 * math.pi * k / sides) + v * math.sin(2 * math.pi * k / sides)) * (diameter / 2 * INCH) for k in range(sides)])
	return loft(rings)


def filleted(mesh, radius, segments=2):
	# A cast part with its sharp edges (faces meeting at more than 30
	# degrees) rounded `radius` inches over `segments` faces, as a casting's
	# are; an edge too short to take the round stays sharp
	bm = bmesh.new()
	made = [bm.verts.new(v) for v in mesh[0]]
	for face in mesh[1]:
		bm.faces.new([made[i] for i in face])
	bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
	edges = [e for e in bm.edges if len(e.link_faces) == 2 and e.calc_face_angle(0) > math.radians(30) and e.calc_length() >= 2.4 * radius * INCH]
	bmesh.ops.bevel(bm, geom=edges, offset=radius * INCH, offset_type="OFFSET", segments=segments, profile=0.5, affect="EDGES", clamp_overlap=True)
	index = {v: i for i, v in enumerate(bm.verts)}
	out = [v.co.copy() for v in bm.verts], [tuple(index[v] for v in f.verts) for f in bm.faces]
	bm.free()
	return out


def ring(centre, normal, radius, stock, sides=14, around=6):
	# A closed ring of round stock: `radius` inches to the stock's middle round
	# `centre`, in the plane square to `normal`, the stock `stock` across
	n = normal.normalized()
	u = n.orthogonal().normalized()
	v = n.cross(u)
	vertices, faces = [], []
	for i in range(sides):
		a = 2 * math.pi * i / sides
		out = u * math.cos(a) + v * math.sin(a)
		for k in range(around):
			b = 2 * math.pi * k / around
			vertices.append(centre + out * (radius * INCH) + (out * math.cos(b) + n * math.sin(b)) * (stock / 2 * INCH))
	for i in range(sides):
		for k in range(around):
			a, b = i * around + k, ((i + 1) % sides) * around + k
			faces.append((a, b, ((i + 1) % sides) * around + (k + 1) % around, i * around + (k + 1) % around))
	return vertices, faces


def casting(start, end, out, radius, flare, sides=40, rings=11):
	# A main post's lower casting (layout.gear legs main castings flare), a
	# loft down the post from `start` to the fork at `end`: the post's round
	# section, `radius` in, turning into a squared one (a superellipse) the
	# flare's diameter fore and aft and `across` it, as dvids8678626 and
	# dvids8678629 show it; an I-section, its web sunk between a front and an
	# aft flange by the pocket's depth over the pocket's span of its length
	# down each side face, the pocket opening below the post and closing
	# above the fork
	down = (end - start).normalized()
	side = (out - down * out.dot(down)).normalized()
	fore = side.cross(down)
	depth, span = flare["pocket"]
	sections = []
	for r in range(rings):
		t = r / (rings - 1)
		blend = t * t * (3 - 2 * t)
		a = radius + (flare["diameter"] / 2 - radius) * blend
		b = radius + (flare["across"] / 2 - radius) * blend
		sink = depth * math.sin(math.pi * t) ** 0.6
		centre = start + (end - start) * t
		ring_ = []
		for k in range(sides):
			th = 2 * math.pi * k / sides
			c_, s_ = math.cos(th), math.sin(th)
			power = 2 + blend   # round at the post, squared toward the fork
			x = a * math.copysign(abs(c_) ** (2 / power), c_)
			y = b * math.copysign(abs(s_) ** (2 / power), s_)
			u = abs(x) / (a * span)
			if u < 1:
				y = math.copysign(abs(y) - sink * math.cos(math.pi / 2 * u) ** 2, y)
			ring_.append(centre + (fore * x + side * y) * INCH)
		sections.append(ring_)
	return outward(loft(sections))


def hull(points):
	# The convex hull of points in a plane ([(x, y), ...]), counterclockwise
	pts = sorted(set(points))
	def half(seq):
		out = []
		for q in seq:
			while len(out) >= 2 and (out[-1][0] - out[-2][0]) * (q[1] - out[-2][1]) - (out[-1][1] - out[-2][1]) * (q[0] - out[-2][0]) <= 0:
				out.pop()
			out.append(q)
		return out
	lower, upper = half(pts), half(pts[::-1])
	return lower[:-1] + upper[:-1]


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


def tyre(centre, axis, radius, width, hub, finish, sides=28, grooves=0, face=None, outer=1, brake=None, bulge=0.45):
	# A tyre and wheel: the tyre in rubber, its section round: each sidewall
	# swells from the rim's bead (`hub` of the tyre's radius, at 0.7 of its
	# width) to its full width `bulge` of the way out to the tread, then
	# rounds over its shoulder into the tread's flat, cut by `grooves`
	# V-grooves evenly across it (layout.gear tyres). The wheel's face on
	# the `outer` side along the axis (layout.gear tyres face): the rim's
	# flange standing proud of the bead, the rim's inner wall sloping down to
	# the face's web, which carries the bolt circle and, through it, the
	# lightening holes, open to the wheel's dark inside; the hub's boss, its
	# three-lobed cap plate and its cap and axle nut. On the other side a
	# plain disc, or the brake's housing with its ring of pistons.
	axis = axis.normalized()
	u = axis.orthogonal().normalized()
	v = axis.cross(u)
	r, w = radius * INCH, width * INCH / 2
	bead = r * hub
	widest = bead + bulge * (r - bead)
	steps = 5

	def side(sign):
		# the bead out to the widest, then the shoulder over to the tread's
		# edge: two quarter ellipses meeting square to the axis at the widest,
		# each sampled at even turns of its edge (even steps round an
		# ellipse turn sharpest at its flat end: 31 deg on the nose tyres)
		low, high = (widest - bead, w * 0.3), (r - widest, w * 0.5)
		out = [(bead, sign * w * 0.7)]
		for k in range(1, steps + 1):
			turn = math.pi / 2 * (1 - k / steps)
			s_ = math.atan2(low[1] * math.cos(turn), low[0] * math.sin(turn))
			out.append((widest - low[0] * math.cos(s_), sign * (w * 0.7 + low[1] * math.sin(s_))))
		for k in range(1, steps):
			turn = math.pi / 2 * k / steps
			t_ = math.atan2(high[0] * math.sin(turn), high[1] * math.cos(turn))
			out.append((widest + high[0] * math.sin(t_), sign * (w * 0.5 + high[1] * math.cos(t_))))
		return out
	tread = [(r, -w * 0.5)]
	for i in range(grooves):
		z, g = -w * 0.5 + w * (i + 1) / (grooves + 1), GROOVE["width"] * INCH / 2
		tread += [(r, z - g), (r - GROOVE["depth"] * INCH, z), (r, z + g)]
	tread += [(r, w * 0.5)]
	profile = side(-1) + tread + side(1)[::-1]

	def radial(a):
		return u * math.cos(a) + v * math.sin(a)
	rings = [[centre + radial(2 * math.pi * i / sides) * d + axis * z for d, z in profile] for i in range(sides)]
	# the tread and sidewalls lofted round the circle, then each hub's face
	vertices = [p for ring in rings for p in ring]
	n = len(profile)
	faces = []
	for i in range(sides):
		a, b = i * n, ((i + 1) % sides) * n
		faces += [(a + j, a + j + 1, b + j + 1, b + j) for j in range(n - 1)]
	finishes = ["rubber"] * len(faces)
	pieces = []

	def quad(f, sign):
		return f if sign > 0 else tuple(reversed(f))
	for j, sign in ((0, -1), (n - 1, 1)):
		plane = centre + axis * (sign * w * 0.7)
		normal = axis * sign
		if face and sign == outer:
			fl, deep = face["flange"] * INCH, face["recess"] * INCH
			bolts, holes = face["bolts"], face["holes"]
			cap, nut = face["cap"]
			web = plane - normal * deep
			band = (bolts["radius"] + bolts["diameter"]) * INCH   # the rim's inner wall comes down to the web outside the bolt circle
			boss = cap / 2 * INCH
			# the flange out of the bead and across, the rim's inner wall
			# sloping down to the web: rings round the axis
			steps_ = [(bead, 0.3 * INCH), (bead - fl, 0.3 * INCH), (band, -deep)]
			base = len(vertices)
			for i in range(sides):
				vertices += [plane + radial(2 * math.pi * i / sides) * d + normal * z for d, z in steps_]
			k = len(steps_)
			for i in range(sides):
				a, b = i * k, ((i + 1) % sides) * k
				ring0, ring1 = i * n + j, ((i + 1) % sides) * n + j
				quads = [(ring0, ring1, base + b, base + a)] + [(base + a + q, base + b + q, base + b + q + 1, base + a + q + 1) for q in range(k - 1)]
				faces += [quad(f, sign) for f in quads]
				finishes += [finish] * len(quads)
			outer_ring = [base + i * k + k - 1 for i in range(sides)]   # the web's outer edge, at the rim's wall's foot
			count = holes["count"]
			if count:
				# the web between the boss and the rim's wall cut into one
				# sector per hole: each sector's outline (its outer arc on
				# the wall's foot, a radial line in, its inner arc on the
				# boss, a radial line out) joined to its hole's oval point by
				# point, each pair on one ray from the hole's centre, so the
				# web meets its neighbours along shared lines; then the
				# hole's wall down through the web and on in the dark of the
				# wheel's inside to its floor
				per = sides // count
				across = 3
				depth = holes["depth"] * INCH
				thick = face["web"] * INCH
				for h in range(count):
					a0, a1 = 2 * math.pi * h / count, 2 * math.pi * (h + 1) / count
					mid = (a0 + a1) / 2
					c = web + radial(mid) * (holes["radius"] * INCH)
					loop = []   # the sector's outline, (point, index or None)
					for q in range(per + 1):
						i = (h * per + q) % sides
						loop.append((vertices[outer_ring[i]], outer_ring[i]))
					for q in range(1, across + 1):
						d = band + (boss - band) * q / (across + 1)
						loop.append((web + radial(a1) * d, None))
					for q in range(per, -1, -1):
						loop.append((web + radial(a0 + (a1 - a0) * q / per) * boss, None))
					for q in range(across, 0, -1):
						d = band + (boss - band) * q / (across + 1)
						loop.append((web + radial(a0) * d, None))
					rad, tan = radial(mid), radial(mid + math.pi / 2)
					hw, hr = holes["size"][0] / 2 * INCH, holes["size"][1] / 2 * INCH
					top, mouth, floor_ = [], [], []
					for point, index in loop:
						if index is None:
							index = len(vertices)
							vertices.append(point)
						top.append(index)
						d = point - c
						x, y = d.dot(tan), d.dot(rad)
						t = math.atan2(y, x)
						reach = hw * hr / math.sqrt((hr * math.cos(t)) ** 2 + (hw * math.sin(t)) ** 2)
						edge = c + (tan * math.cos(t) + rad * math.sin(t)) * reach
						mouth.append(len(vertices)); vertices.append(edge)
						floor_.append(len(vertices)); vertices.append(edge - normal * thick)
					m = len(loop)
					low = []
					for q in range(m):
						low.append(len(vertices)); vertices.append(vertices[mouth[q]] - normal * depth)
					for q in range(m):
						q1 = (q + 1) % m
						faces.append(quad((top[q], top[q1], mouth[q1], mouth[q]), sign)); finishes.append(finish)
						faces.append(quad((mouth[q], mouth[q1], floor_[q1], floor_[q]), sign)); finishes.append(finish)
						faces.append(quad((floor_[q], floor_[q1], low[q1], low[q]), sign)); finishes.append("rubber")
					bottom = len(vertices)
					vertices.append(c - normal * depth)
					for q in range(m):
						faces.append((bottom, low[q], low[(q + 1) % m]) if sign > 0 else (bottom, low[(q + 1) % m], low[q]))
						finishes.append("rubber")
			else:
				# a plain web across to the boss
				middle = len(vertices)
				vertices.append(web)
				for i in range(sides):
					faces.append((middle, outer_ring[i], outer_ring[(i + 1) % sides]) if sign > 0 else (middle, outer_ring[(i + 1) % sides], outer_ring[i]))
					finishes.append(finish)
			for b_ in range(bolts["count"]):
				at_ = web + radial(2 * math.pi * b_ / bolts["count"]) * (bolts["radius"] * INCH)
				pieces.append(finished(cylinder(at_, at_ + normal * (0.35 * INCH), bolts["diameter"] / 2, sides=6), finish))
			plate_ = face.get("plate")
			if plate_:
				# the cap's three-lobed plate on the web, a bolt in each lobe
				outline = [web + radial(2 * math.pi * q / 36) * ((plate_["radius"] - plate_["lobe"] * (1 - math.cos(3 * 2 * math.pi * q / 36)) / 2) * INCH) for q in range(36)]
				pieces.append(finished(extruded(outline, normal * (plate_["thickness"] * INCH)), finish))
				for q in range(3):
					at_ = web + normal * (plate_["thickness"] * INCH) + radial(2 * math.pi * q / 3) * ((plate_["radius"] - 0.45) * INCH)
					pieces.append(finished(cylinder(at_, at_ + normal * (0.2 * INCH), 0.3, sides=6), finish))
			pieces.append(finished(cylinder(web, web + normal * (1.2 * INCH), cap / 2, sides=24), finish))
			pieces.append(finished(cylinder(web + normal * (1.2 * INCH), web + normal * (1.8 * INCH), nut / 2, sides=6), "chrome"))
			continue
		middle = len(vertices)
		vertices.append(plane)
		for i in range(sides):
			a, b = i * n + j, ((i + 1) % sides) * n + j
			faces.append((middle, b, a) if j == 0 else (middle, a, b))
			finishes.append(finish)
		if brake:
			# the brake's housing out of the inner face, its pistons round it
			out_ = plane + normal * (brake["depth"] * INCH)
			pieces.append(finished(cylinder(plane - normal * (0.2 * INCH), out_, brake["diameter"] / 2, sides=sides), finish))
			ps = brake["pistons"]
			for q in range(ps["count"]):
				at_ = out_ + radial(2 * math.pi * (q + 0.5) / ps["count"]) * (ps["radius"] * INCH)
				pieces.append(finished(cylinder(at_ - normal * (0.2 * INCH), at_ + normal * (0.8 * INCH), ps["diameter"] / 2, sides=8), finish))
	return merge([(vertices, faces, finishes)] + pieces)


def extruded(outline, offset):
	# A prism: a closed flat outline (anticlockwise seen from where `offset`
	# points) and its copy moved by `offset`, capped at both ends
	m = len(outline)
	vertices = list(outline) + [q + offset for q in outline]
	faces = [tuple(range(m - 1, -1, -1)), tuple(range(m, 2 * m))]
	faces += [(i, (i + 1) % m, m + (i + 1) % m, m + i) for i in range(m)]
	return vertices, faces


def plate(corner, along, across, thickness):
	# A thin box on a corner and two edges, its thickness centred on them (a
	# cross product's side flips in the mirror, so a one-sided plate would not)
	normal = along.cross(across).normalized() * (thickness * INCH / 2)
	p = [corner, corner + along, corner + along + across, corner + across]
	vertices = [q - normal for q in p] + [q + normal for q in p]
	faces = [(0, 1, 2, 3), (7, 6, 5, 4), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)]
	return vertices, faces


def profiled(outline, width, buttline=0.0):
	# A plate whose side profile is a closed outline in stations and
	# waterlines ([[FS, WL], ...], either way round), `width` inches across,
	# centred on a buttline: a casting's web, a bracket, a flat bar
	ring = [at(f, w, 0) for f, w in outline]
	half = width / 2
	return outward(loft([[p + Vector((0, -(buttline + s * half) * INCH, 0)) for p in ring] for s in (-1, 1)]))


def housing(stations, waterlines, width, buttline=0.0, sides=24, power=3.0):
	# An upright casting round a post: a rounded box (a superellipse, `power`
	# the squareness of its corners) spanning the stations fore and aft and
	# `width` across, from one waterline to the other, its rims chamfered by
	# a tenth of an inch
	(f0, f1), (w0, w1) = stations, waterlines
	middle, a, b = (f0 + f1) / 2, (f1 - f0) / 2, width / 2

	def ring(w, inset):
		out = []
		for k in range(sides):
			t = 2 * math.pi * k / sides
			c, s = math.cos(t), math.sin(t)
			x = (a - inset) * math.copysign(abs(c) ** (2 / power), c)
			y = (b - inset) * math.copysign(abs(s) ** (2 / power), s)
			out.append(at(middle + x, w, buttline + y))
		return out
	return outward(loft([ring(w0, 0.1), ring(w0 + 0.1, 0.0), ring(w1 - 0.1, 0.0), ring(w1, 0.1)]))


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
	return ([undo @ v for v in mesh[0]], *mesh[1:])


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


STROKE = [round(k / 24, 4) for k in range(25)]   # the gear drive's samples for the braces' solved keys
BRACES = []   # the gear's braces, built once the whole airframe is (braces())
DROOPS = {}   # each main leg's arm hanging in flight below its standing angle: (radians, the arm's reach to the wheel's face, m)
FULLS = {}   # each leg's oleo drive with the leg fully in, m from hanging
GROOVE = LAYOUT["gear"]["tyres"]["groove"]   # the tyres' tread grooves: width and depth, in
# Each well's opening in the skin, cut once the airframe is built (wells()):
# {well: {"below": bool, "pieces": [a door's plan outline, [[FS, BL], ...]]}}
# for the doors and the speedbrake, as cut() copied them; the probe's is its
# door's stations and angles and the station its well reaches back to,
# {"probe": {"shell": (from, to, upper, lower), "back": station}}
OPENINGS = {}
# The skin as it stood before the openings were cut (opened()): a ray-cast
# tree a door's outer faces lie on, closed
UNCUT = {}


def turning(hinge, axis, angle):
	# A turn by `angle` about `axis` through `hinge`
	return Matrix.Translation(hinge) @ Matrix.Rotation(angle, 4, axis) @ Matrix.Translation(-hinge)


def placed(name, drives):
	# A node's move from rest under the drives ({drive: value}): its own and
	# its ancestors' joints, each about or along its axis through its hinge as
	# it rests (every node rests unrotated)
	move, obj = Matrix.Identity(4), NODES[name]
	while obj is not None:
		j = JOINTS.get(obj.name)
		if j and j["motion"] in ("rotate", "slide"):
			axis = Vector((j["axis"][0], -j["axis"][2], j["axis"][1]))
			value = interp(j["keys"], drives.get(j["drive"], 0.0))
			move = (turning(HINGES[obj.name], axis, value) if j["motion"] == "rotate" else Matrix.Translation(axis.normalized() * value)) @ move
		obj = obj.parent
	return move


def enclosed(tree, p):
	# Whether a point is enclosed by a tree's surfaces: a ray along each axis,
	# both ways, meets one (check.py's enclosed())
	return all(tree.ray_cast(p, d)[0] is not None for d in (FORWARD, AFT, PORT, -PORT, UP, DOWN))


def room(skin, parts, a, b, radius, skip=0.0):
	# The least room round a tube of the given radius from a to b, in: to the
	# skin, as far outside it as it stands where it leaves it, and to the other
	# parts (trees); `skip` the share of its length at a left out, where it is
	# pinned to what it rides
	least = math.inf
	for k in range(9):
		p = a.lerp(b, skip + (1 - skip) * k / 8)
		gap = skin.find_nearest(p)[3] / INCH
		least = min(least, gap - radius if enclosed(skin, p) else -gap - radius)
		for tree in parts:
			least = min(least, tree.find_nearest(p)[3] / INCH - radius)
	return least


def scoop():
	# The FCS ram air scoop (layout.scoop): a can under the right LEX whose end
	# is the round cap the photos see flush in its sub-panel, and which AV COOL
	# EMERG swings out about a hinge at the cap's aft edge until its mouth
	# faces forward (layout.motion scoop, NATOPS 2.16.7). Its body red, its
	# end the airframe's paint
	s, m = LAYOUT["scoop"], LAYOUT["motion"]["scoop"]["value"]
	skin = built(["fuselage"])
	cap, normal = skin.find_nearest(at(*s["cap"]))[:2]
	normal = normal.normalized()
	if normal.y > 0:
		normal = -normal   # outward, to starboard
	forward = (FORWARD - normal * FORWARD.dot(normal)).normalized()
	radius = s["diameter"] / 2
	centre = cap + normal * (0.05 * INCH)   # standing just proud of the skin, as the flush doors do
	hinge = centre - forward * (radius * INCH)
	vertices, faces = cylinder(centre, centre - normal * (s["length"] * INCH), radius, sides=16)
	node("scoop", hinge=hinge, mesh=(vertices, faces, ["red"] * 16 + ["paint", "red"]))
	joint("scoop", forward.cross(normal), -normal, forward, "scoop", [[0, 0], [1, round(math.radians(m["travel"]), 4)]])
	MARKS["scoop_cap"] = (centre, "scoop")


def stroked(f, ramp):
	# How far an actuator has stroked (0 to 1) at f of its time: its speed
	# rises over the ramp's share of the time as a smoothstep, holds, and falls
	# again as one; a smoothstep's area is half its span, so the steady speed
	# is 1 / (1 - ramp)
	speed = 1 / (1 - ramp)

	def gathered(x):
		# the ramp's travel at x of it, in ramp times speed: the smoothstep's integral
		return x ** 3 - x ** 4 / 2
	if f <= ramp:
		return speed * ramp * gathered(f / ramp)
	if f >= 1 - ramp:
		return 1 - speed * ramp * gathered((1 - f) / ramp)
	return speed * (ramp / 2 + f - ramp)


def timeline():
	# The gear's mechanisms' times (layout.motion), each way, as shares of the
	# gear's stroke time from the handle's move: {"up": {mechanism: [from,
	# to]}, "down": {...}}. Retracting, the nose leg leads, the mains follow
	# and the doors close last (layout.motion sequence: the legs' shares of
	# the time before the doors, which take the last of it, layout.motion
	# doors); extending, the doors snap open and both legs fall together
	# (layout.motion extension)
	share = LAYOUT["motion"]["doors"]["value"]["open"]
	order = LAYOUT["motion"]["sequence"]["value"]
	legs = 1 - share
	up = {leg: [round(legs * (1 - order[leg][1]), 4), round(legs * (1 - order[leg][0]), 4)] for leg in ("nose", "main")}
	up["doors"] = [round(legs, 4), 1.0]
	return {"up": up, "down": {k: list(v) for k, v in LAYOUT["motion"]["extension"]["value"].items()}}


def mechanism(name):
	# Which of the gear's mechanisms a gear joint belongs to: the doors, the
	# nose leg (with the launch bar it carries) or the main legs
	if "door" in name:
		return "doors"
	return "nose" if name.startswith(("gear_nose", "launch_bar")) else "main"


def thinned(curve, tolerance):
	# The fewest of a curve's points [(x, y)] read piecewise linearly through
	# which every point lies within the tolerance of the line through the
	# kept ones either side, the ends kept (Douglas-Peucker)
	keep, spans = {0, len(curve) - 1}, [(0, len(curve) - 1)]
	while spans:
		a, b = spans.pop()
		(x0, y0), (x1, y1) = curve[a], curve[b]
		worst, at_ = 0.0, None
		for k in range(a + 1, b):
			x, y = curve[k]
			miss = abs(y - (y0 + (y1 - y0) * (x - x0) / ((x1 - x0) or 1)))
			if miss > worst:
				worst, at_ = miss, k
		if at_ is not None and worst > tolerance:
			keep.add(at_)
			spans += [(a, at_), (at_, b)]
	return [curve[k] for k in sorted(keep)]


# how far a gear joint's keys may read off its motion between them: a turn,
# radians (half a thousandth: a hundredth of an inch at a brace's 20 in), a
# slide, metres (a tenth of a millimetre)
KEYED = {"rotate": 0.0005, "slide": 0.0001}


def sequenced(grid=480):
	# The gear's sequence: each of its mechanisms (the doors, the nose leg,
	# the main legs) has its own drive, gear.doors, gear.nose and gear.main, 0
	# stowed to 1 down, which the engine runs each at its own pace after its
	# own start, by direction (timeline(), the points file's motion gear).
	# Each moves as an actuator strokes (layout.motion stroke): gathering
	# speed over the ramp's share of its time, steady, then shedding it again,
	# each ramp's speed easing (no jump in speed or in acceleration at either
	# end). An ease over the whole phase spends a third of it in the last fifth
	# of the travel, where a main wheel rises straight up into its bay. Every
	# gear joint's keys were made against its own progress, 0 stowed to 1 down
	# (a door's over 0 to the doors' share of the gear, layout.motion doors);
	# they are resampled against its mechanism's stroke here, as densely as
	# each joint's own motion needs to read within KEYED between its keys: a
	# linkage's members keyed alike at even shares drift apart between keys
	# where one turns fast (a side brace breaking from straight)
	share = LAYOUT["motion"]["doors"]["value"]["open"]
	ramp = LAYOUT["motion"]["stroke"]["value"]["ramp"]

	def gently(f):
		return stroked(f, ramp)
	for name, j in JOINTS.items():
		if j.get("drive") != "gear" or j["motion"] not in ("rotate", "slide"):
			continue
		keys, part = j["keys"], mechanism(name)
		j["drive"] = f"gear.{part}"
		inputs = [k / grid for k in range(grid + 1)]
		if part == "doors":
			opened = interp(keys, share)
			curve = [(x, opened * gently(x)) for x in inputs]
		else:
			curve = [(x, interp(keys, gently(x))) for x in inputs]
		j["keys"] = [[round(x, 4), round(y, 4)] for x, y in thinned(curve, KEYED[j["motion"]])]


def actuator(n, pin, undo, skin):
	# The nose drag brace (layout.gear legs nose actuator): a telescopic
	# actuator from its pin in the fuselage to the web's pin on the post, the
	# cylinder above and the polished rod below with its eye on the web's
	# pin. The cylinder turns about its pin to aim at the web's pin through
	# the stroke and the rod slides out of it as the leg swings forward; the
	# rod is as long as reaching the overlap (layout.motion braces) into the
	# cylinder at full stretch needs. A strip under the cylinder, which every
	# photo shows hanging along the brace, closes the brace's slot in the
	# skin behind the long door when the gear is up: it is the slot's skin, cut
	# as the doors are, and rides the brace
	a = n["actuator"]
	P = at(*a["pin"], 0)
	lug = undo @ pin   # the web's pin at rest, the leg stowed
	feet = [placed("gear_nose_strut", {"gear": d}) @ lug for d in STROKE]
	u0 = (feet[0] - P).normalized()
	length, rod_r, cyl_r = a["cylinder"] * INCH, a["diameters"][1] / 2, a["diameters"][0] / 2
	reaches = [(f - P).length for f in feet]
	rod = max(reaches) - length + LAYOUT["motion"]["braces"]["value"]["overlap"] * INCH
	inner = min(reaches) - rod
	if inner < 3.0 * INCH:
		raise SystemExit(f"nose drag brace: the rod's inner end comes within {inner / INCH:.1f} in of the cylinder's pin")
	print(f"nose drag brace: the rod {rod / INCH:.1f} in, the brace {min(reaches) / INCH:.1f} to {max(reaches) / INCH:.1f} in pin to pin,",
		f"the rod showing {(reaches[-1] - length) / INCH:.1f} in gear down, its inner end {inner / INCH:.1f} in from the pin at the least")
	lateral = PORT
	# the slot: from the long door's aft edge to where the brace, gear down,
	# leaves the skin, as wide as the cylinder and a seam either side
	d = LAYOUT["gear"]["doors"]["long"]
	(h0, hb), (h1, hb1) = d["hinge"]
	(e0, eb), (e1, eb1) = d["free"]
	half = cyl_r + 0.4

	def aft_edge(b):
		# the long door's aft edge's station at a buttline
		return h1 + (e1 - h1) * (hb1 - b) / (hb1 - eb1)
	up = (P - pin).normalized()
	hit = skin.ray_cast(pin, up)[0]
	if hit is None:
		raise SystemExit("nose drag brace: no skin over the web's pin")
	rise = math.atan2(up.z, up.x * -1.0)
	out = 456.0 - hit.x / INCH + cyl_r / math.sin(abs(rise)) + 1.0
	slot = [[aft_edge(-half), -half], [out, -half], [out, half], [aft_edge(half), half]]
	OPENINGS.setdefault("nose", {"below": True, "pieces": []})["pieces"].append(slot)
	strip = cut(None, None, below=True, outline=slot, inside="white")
	# the strip's two brackets up to the cylinder, at rest
	brackets = []
	for station in (slot[0][0] + 8.0, out - 8.0):
		# each at least 2.5 in inside the cylinder's open end, clear of its
		# collar, where the rod slides out
		station = max(station, 456.0 - (P + u0 * (length - 2.5 * INCH)).x / INCH)
		foot = draped(skin, station, 0.0, below=True)
		t = (foot - P).dot(u0)
		brackets.append(cylinder(foot + UP * (0.05 * INCH), P + u0 * t, 0.5, sides=8))
	body = merge([cylinder(P, P + u0 * length, cyl_r, sides=16), cylinder(P + u0 * (length - 1.5 * INCH), P + u0 * length, cyl_r + 0.3, sides=16),
		cylinder(P + lateral * (2.0 * INCH), P - lateral * (2.0 * INCH), 1.6)] + brackets)
	node("gear_nose_brace", hinge=P, mesh=body, paint="white")
	joint("gear_nose_brace", lateral, u0, lateral.cross(u0), "gear",
		[[k, round(math.atan2(lateral.dot(u0.cross((f - P).normalized())), u0.dot((f - P).normalized())), 4)] for k, f in zip(STROKE, feet)])
	node("gear_nose_door_brace", parent="gear_nose_brace", hinge=P, mesh=strip)
	# the rod's end: a clevis straddling the web's boss (the web is a single
	# plate), white as dvids9820808 shows its end fitting, its cheeks out to
	# a yoke and the polished body beyond (layout.gear legs nose actuator
	# fitting); gear() notches the web where the body lies at rest
	web = n["castings"]["web"]
	fit, yoke = a["fitting"], rod_r + 0.1   # the yoke, a tenth proud of the rod, spans the web's plane
	cheek = web["boss"][1] / 2 + 0.1 + 0.25   # each cheek's middle off the centreline, a tenth clear of the boss's end
	side_ = u0.cross(lateral).normalized()

	def slab(a, b, half, middle, thick):
		# a flat bar from a to b, `half` inches either side of its axis in the
		# side plane, `thick` across the jet, its middle `middle` inches to port
		def ring(c):
			return [c + side_ * (x * half * INCH) + lateral * ((middle + y * thick / 2) * INCH) for x, y in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
		return loft([ring(a), ring(b)])
	end = feet[0] - u0 * ((fit - 0.8) * INCH)   # the cheeks' end, then the yoke, then the polished body
	body = feet[0] - u0 * (fit * INCH)
	clevis = [slab(feet[0], end, 1.7, side * cheek, 0.5) for side in (-1, 1)]
	clevis += [cylinder(feet[0] + lateral * ((side * cheek - 0.25) * INCH), feet[0] + lateral * ((side * cheek + 0.25) * INCH), 1.7, sides=16) for side in (-1, 1)]
	# the yoke: round where it leaves the polished rod, squared out to the
	# cheeks (dvids9820806)
	def neck(t):
		a_ = (rod_r + 0.3) + (cheek + 0.25 - rod_r - 0.3) * t
		b_ = (rod_r + 0.3) + (yoke - rod_r - 0.3) * t
		power = 2.0 + 6.0 * t
		centre = body + (end - body) * t
		return [centre + (lateral * (a_ * math.copysign(abs(math.cos(th)) ** (2 / power), math.cos(th))) +
			side_ * (b_ * math.copysign(abs(math.sin(th)) ** (2 / power), math.sin(th)))) * INCH for th in (2 * math.pi * k / 20 for k in range(20))]
	clevis += [outward(loft([neck(t) for t in (0.0, 0.3, 0.65, 1.0)])), cylinder(feet[0] + lateral * ((cheek + 0.4) * INCH), feet[0] - lateral * ((cheek + 0.4) * INCH), 0.6)]
	# its pin hollow, standing proud of the cheeks (layout.gear legs nose
	# castings fittings pin, dvids9820808)
	clevis += [hollow(feet[0] + lateral * (k * (cheek + 0.25) * INCH), lateral * k, n["castings"]["fittings"]["pin"]) for k in (-1, 1)]
	eye = merge([finished(cylinder(body, feet[0] - u0 * rod, rod_r, sides=12), "chrome")] + clevis)
	node("gear_nose_brace_rod", parent="gear_nose_brace", hinge=feet[0], mesh=eye, paint="white")
	joint("gear_nose_brace_rod", u0, u0, u0, "gear", [[k, round(r - reaches[0], 4)] for k, r in zip(STROKE, reaches)], motion="slide")


def tucked(points, pivot, blocks, turn, limit, margin=0.5):
	# The furthest a part's side-view points (FS, WL), turned about its pivot,
	# go toward `limit` (radians, up from where they lie when turn is +1, down
	# when -1) in quarter-degree steps before any comes within `margin` inches
	# of a block: an (FS, WL) box (f0, f1, w0, w1), a circle (f, w, r), or a
	# convex polygon [(f, w), ...], each grown by the margin
	def near(x, y):
		for k in blocks:
			if len(k) == 4 and not isinstance(k[0], (list, tuple)):
				if k[0] - margin < x < k[1] + margin and k[2] - margin < y < k[3] + margin:
					return True
			elif len(k) == 3 and not isinstance(k[0], (list, tuple)):
				if math.hypot(x - k[0], y - k[1]) < k[2] + margin:
					return True
			else:
				inside = True
				for (f0, w0), (f1, w1) in zip(k, k[1:] + k[:1]):
					# distance in from each edge, the polygon's points counterclockwise or not
					ex, ey = f1 - f0, w1 - w0
					side = (ex * (y - w0) - ey * (x - f0)) / math.hypot(ex, ey)
					inside &= side * polygon_sense(k) > -margin
				if inside:
					return True
		return False

	def clear(angle):
		c, s_ = math.cos(angle), math.sin(angle)
		for x, y in points:
			# forward is -FS: up is a turn from aft (+FS) toward +WL
			dx, dy = x - pivot[0], y - pivot[1]
			if near(pivot[0] + dx * c - dy * s_ * turn, pivot[1] + dx * s_ * turn + dy * c):
				return False
		return True
	angle, step = 0.0, math.radians(0.25)
	while angle + step <= limit and clear(angle + step):
		angle += step
	return angle


def clipped(outline, normal, limit):
	# A convex (FS, WL) outline's part where normal . point <= limit
	out = []
	for (x0, y0), (x1, y1) in zip(outline, outline[1:] + outline[:1]):
		d0, d1 = normal[0] * x0 + normal[1] * y0 - limit, normal[0] * x1 + normal[1] * y1 - limit
		if d0 <= 0:
			out.append((x0, y0))
		if d0 * d1 < 0:
			t = d0 / (d0 - d1)
			out.append((x0 + (x1 - x0) * t, y0 + (y1 - y0) * t))
	return out


def notched(outline, thickness, n, undo, pin):
	# The nose web (a side outline, a plate on the centreline), less where the
	# drag brace's rod lies at rest beyond its end fitting's cheeks: the yoke
	# and polished body, their radius and a margin either side of the rod's
	# line, taken into the gear-down frame (layout.gear legs nose actuator).
	# At rest the rod turns furthest toward the post of all the stroke, so the
	# rest's strip holds every other step's; the plate is built as the convex
	# pieces of it outside the strip
	a = n["actuator"]
	line = undo.to_3x3().inverted() @ (at(*a["pin"], 0) - undo @ pin)
	u = Vector((-line.x, line.z)).normalized()   # (FS, WL): FS runs aft, against x
	side = Vector((-u.y, u.x))
	f, w = n["brace"][0], n["brace"][1]
	reach = a["fitting"] - 0.8
	half = a["diameters"][1] / 2 + 0.1 + 0.3
	o = [tuple(q) for q in outline]
	pieces = [clipped(o, (u.x, u.y), u.x * f + u.y * w + reach), clipped(o, (side.x, side.y), side.x * f + side.y * w - half),
		clipped(o, (-side.x, -side.y), -(side.x * f + side.y * w + half))]

	def area(q):
		return abs(sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(q, q[1:] + q[:1]))) / 2
	pieces = [q for q in pieces if len(q) >= 3 and area(q) > 0.01]
	# what the notch takes, by sampling the outline every twentieth of an inch
	xs, ys = [q[0] for q in o], [q[1] for q in o]
	cells = [(x, y) for x in np.arange(min(xs), max(xs), 0.05) for y in np.arange(min(ys), max(ys), 0.05) if within(o, x, y)]
	taken = sum(1 for x, y in cells if not any(within(q, x, y) for q in pieces)) * 0.0025
	print(f"nose web: notched {taken:.2f} sq in of its {area(o):.1f} where the drag brace's rod lies stowed")
	return [profiled([list(q) for q in piece], thickness) for piece in pieces]


def within(outline, x, y):
	# whether a side-view point lies inside a convex (FS, WL) outline
	sense = polygon_sense(outline)
	return all(((f1 - f0) * (y - w0) - (w1 - w0) * (x - f0)) * sense > 0 for (f0, w0), (f1, w1) in zip(outline, outline[1:] + outline[:1]))


def enclosing(polygon, point, margin=0.0):
	# whether a closed polygon ((N, 2) array) holds a point, or passes within
	# `margin` of it
	a, b = polygon, np.roll(polygon, -1, axis=0)
	x, y = point
	crossing = ((a[:, 1] > y) != (b[:, 1] > y)) & (x < a[:, 0] + (y - a[:, 1]) * (b[:, 0] - a[:, 0]) / np.where(b[:, 1] != a[:, 1], b[:, 1] - a[:, 1], 1))
	if crossing.sum() % 2:
		return True
	e = b - a
	t = np.clip(((x - a[:, 0]) * e[:, 0] + (y - a[:, 1]) * e[:, 1]) / np.maximum((e * e).sum(1), 1e-12), 0, 1)
	return bool((np.hypot(a[:, 0] + e[:, 0] * t - x, a[:, 1] + e[:, 1] * t - y) <= margin).any())


def polygon_sense(outline):
	# +1 for a counterclockwise (FS, WL) outline, -1 for a clockwise one
	return 1.0 if sum(f0 * w1 - f1 * w0 for (f0, w0), (f1, w1) in zip(outline, outline[1:] + outline[:1])) > 0 else -1.0


def main_members(skin, leg, name, side, out, pivot, trunnion, fork, axis, swing, strut_undo):
	# A main leg's side brace and connecting link (layout.gear legs main,
	# layout.motion braces), each between a pin in the structure and a point
	# riding the leg, at each of the gear's steps. The leg turns about the
	# trunnion's axis by the swing times one less the gear; the brace's halves,
	# the link and the bell crank hinge about axes along it, so that turn
	# keeps each in its plane square to the axis and their ends meet exactly
	m, b = LAYOUT["gear"]["legs"]["main"], LAYOUT["motion"]["braces"]["value"]
	fit = m["castings"]["fittings"]
	# solved at steps closing in on gear down, where the brace breaks from
	# straight and its halves' turns grow as the root of the foot's travel
	steps = sorted({round(k / 40, 6) for k in range(41)} | {round(1 - (k / 40) ** 2, 6) for k in range(41)})
	n = axis.normalized()

	def carry(p, t):
		return trunnion + Matrix.Rotation(swing * (1 - t), 3, n) @ (p - trunnion)

	def flat(v):
		return v - n * v.dot(n)

	def angle(u, v):
		u, v = flat(u), flat(v)
		return math.atan2(n.dot(u.cross(v)), u.dot(v))

	def on(start, direction, waterline):
		# where a line reaches a waterline (the model's z is up)
		return start + direction * ((waterline - 105.0) * INCH - start.z) / direction.z

	def meet(origin, target, first, second, sense):
		# where two members from origin and target meet, square to the axis:
		# first's length from origin, second's from target, in the plane, the
		# joint to one side
		q = flat(target - origin)
		d = min(q.length, first + second - 1e-9)
		x = (d * d + first * first - second * second) / (2 * d)
		h = math.sqrt(max(first * first - x * x, 0.0))
		u = q.normalized()
		return origin + u * x + n.cross(u) * (sense * h)

	# The side brace folds at its knee: its lower half from the bolt on the
	# post's lower casting up to the knee, which gear down stands where the
	# photos last see the brace (dvids4642471 shows its boss there, at the
	# bay's edge, the upper half going on up into the bay), and its upper
	# half from there to its pin in the structure (layout.motion braces side
	# pin, placed for room)
	bolt = at(m["brace"][1][0], m["brace"][1][1], side * m["brace"][1][2])
	knee = at(m["brace"][0][0], m["brace"][0][1], side * m["brace"][0][2])
	pin = at(b["side"]["pin"][0], b["side"]["pin"][1], side * b["side"]["pin"][2])
	rise = n * (knee - pin).dot(n)   # the knee's offset along the axis, which no turn changes
	upper, lower = flat(knee - pin).length, flat(bolt - knee).length
	bolts = [carry(bolt, t) for t in steps]
	radius = b["link"] / 2

	def folded(sense):
		return [meet(pin, q, upper, lower, sense) + rise for q in bolts]
	# the fold that stands the knee gear down where the photos see it
	knees = min((folded(sense) for sense in (1, -1)), key=lambda k: (k[-1] - knee).length)
	if (knees[-1] - knee).length > 0.01 * INCH:
		raise SystemExit(f"{leg} side brace: no fold stands its knee gear down where the photos see it ({(knees[-1] - knee).length / INCH:.2f} in off)")
	k0, q0 = knees[0], bolts[0]
	off = max((k + (q - k) - q).length for k, q in zip(knees, bolts))
	print(f"{leg} side brace: halves {(knee - pin).length / INCH:.1f} and {(bolt - knee).length / INCH:.1f} in, its knee turning {math.degrees(abs(angle(k0 - pin, knees[-1] - pin))):.0f} deg")
	# the knee's boss across the pin, on the lower half (layout.motion braces
	# side boss, dvids4642471 at the tube's 1.8 in), and the downlock spring
	# from it along the upper half on up into the bay, beside the tube on the
	# boss's face (side spring: its coil, its pitch and its length into the
	# bay, which no photo sees past the bay's edge)
	boss, sp = b["side"]["boss"], b["side"]["spring"]
	ends = [k0 - n * (boss[1] / 2 * INCH), k0 + n * (boss[1] / 2 * INCH)]
	upward = (pin - k0).normalized()
	beside = n * ((boss[1] / 2 - sp["diameter"] / 2) * INCH)
	coil = []
	count = int(sp["length"] / sp["pitch"])
	for k in range(count):
		a_ = k0 + beside + upward * ((boss[0] / 2 + k * sp["pitch"]) * INCH)
		coil.append(cylinder(a_, a_ + upward * (sp["pitch"] * INCH), sp["diameter"] / 2 if k % 2 == 0 else sp["diameter"] / 2 - 0.15, sides=8))
	node(f"{leg}_brace_upper", hinge=pin, mesh=merge([cylinder(pin, k0, radius)] + coil), paint="white")
	joint(f"{leg}_brace_upper", n, flat(k0 - pin), n.cross(flat(k0 - pin)), "gear", [[t, round(angle(k0 - pin, k - pin), 4)] for t, k in zip(steps, knees)])
	node(f"{leg}_brace", parent=f"{leg}_brace_upper", hinge=k0, mesh=merge([cylinder(k0, q0, radius), cylinder(ends[0], ends[1], boss[0] / 2, sides=16)]), paint="white")
	joint(f"{leg}_brace", n, flat(q0 - k0), n.cross(flat(q0 - k0)), "gear",
		[[t, round(angle(q0 - k0, q - k) - angle(k0 - pin, k - pin), 4)] for t, k, q in zip(steps, knees, bolts)])
	MARKS[f"brace_bolt_{name}"] = (q0, f"{leg}_brace")
	MARKS[f"brace_knee_{name}"] = (k0, f"{leg}_brace")
	# the side brace's end fittings (layout.motion braces side fitting, its
	# fork in dvids8678626 and dvids8678629), riding the lower half on their own
	# node so the brace's tube still ends on its bolt: the fork's two cheeks
	# straddling the post's lug either side of its boss, each an eye round
	# the bolt tapering into the tube, square to the bolt, a yoke joining
	# them to the tube, the bolt's pin hollow and standing proud of the
	# cheeks. The knee takes no boss wider than its tubes: stowed, the post
	# lies against its pin's axis
	f_ = b["side"]["fitting"]
	# the foot is a universal joint (layout.motion braces side foot,
	# dvids8678626): the fork's pin square to the brace and to the foot's bolt,
	# which runs down through a spool turning in the post's clevis; through
	# the stroke the fork rolls on the brace and the spool on its bolt to keep
	# the pin so, the brace's fold staying about the trunnion's axis. Each
	# step's pin in the post's own frame (the post gear down), then at rest
	ft = b["side"]["foot"]
	down_ = Vector((-ft["bolt"][0], -side * ft["bolt"][2], ft["bolt"][1])).normalized()
	pins = []
	for t, k_, q_ in zip(steps, knees, bolts):
		p_ = down_.cross(Matrix.Rotation(swing * (1 - t), 3, n).inverted() @ (k_ - q_)).normalized()
		pins.append(-p_ if pins and p_.dot(pins[-1]) < 0 else p_)
	rest_ = Matrix.Rotation(swing, 3, n)
	pin = (rest_ @ pins[0]).normalized()
	d = (k0 - q0) - pin * (k0 - q0).dot(pin)
	d = d.normalized()
	e = pin.cross(d).normalized()
	outline = hull([(f_["eye"] / 2 * math.cos(a), f_["eye"] / 2 * math.sin(a)) for a in (2 * math.pi * k / 20 for k in range(20))] +
		[(f_["length"], -radius), (f_["length"], radius)])
	flat_ = [q0 + (d * x + e * y) * INCH for x, y in outline]
	face_ = LUG + 0.05   # each cheek's inner face, just clear of the lug's boss
	# the post's axis level with the bolt: the cheek on its side is the inner
	axis_ = (fork - trunnion).normalized()
	root = trunnion + axis_ * (bolt - trunnion).dot(axis_)
	inner = math.copysign(1.0, (carry(root, 0) - q0).dot(pin))
	pieces = []
	for k in (-1, 1):
		ring_ = [q + pin * (k * face_ * INCH) for q in flat_]
		pieces.append(extruded(ring_ if k > 0 else ring_[::-1], pin * (k * f_["cheek"] * INCH)))
		# the pin hollow at its outer end and with a round head at its inner (dvids8678626)
		end_ = q0 + pin * (k * (face_ + f_["cheek"]) * INCH)
		pieces.append(stud(end_, pin * k, fit["pin"][0]) if k == inner else hollow(end_, pin * k, fit["pin"]))
	pieces.append(plate(q0 + (d * (f_["length"] - 0.8) - e * radius) * INCH, d * (0.8 * INCH), e * (2 * radius * INCH), 2 * (face_ + f_["cheek"])))
	node(f"{leg}_brace_fittings", parent=f"{leg}_brace", hinge=k0, mesh=merge(pieces), paint="white")
	# the fork's roll on the brace's axis at each step: from where the brace's
	# fold alone carries its pin to where the joint wants it
	along_ = (q0 - k0).normalized()
	rolls = []
	for t, k_, q_, p_ in zip(steps, knees, bolts, pins):
		carried_ = Matrix.Rotation(angle(q0 - k0, q_ - k_), 3, n) @ pin
		wanted = Matrix.Rotation(swing * (1 - t), 3, n) @ p_
		axis_t = (q_ - k_).normalized()
		rolls.append(math.atan2(axis_t.dot(carried_.cross(wanted)), carried_.dot(wanted)))
	joint(f"{leg}_brace_fittings", along_, pin, along_.cross(pin), "gear", [[t, round(r_, 4)] for t, r_ in zip(steps, rolls)])
	# the spool: its block between the fork's cheeks, bored for the pin, its
	# neck between them down to the clevis's upper lug, and its body on down
	# to the lower, turning on the foot's bolt with the pin
	(l0_, _), (m0_, _) = ft["lugs"]
	bolt_rest = rest_ @ down_
	node(f"{leg}_spool", parent=f"{leg}_strut", hinge=q0, mesh=merge([cylinder(q0 - pin * (LUG * INCH), q0 + pin * (LUG * INCH), 1.2),
		cylinder(q0, q0 + bolt_rest * (l0_ * INCH), LUG - 0.1), cylinder(q0 + bolt_rest * (l0_ * INCH), q0 + bolt_rest * (m0_ * INCH), ft["spool"] / 2)]), paint="white")
	joint(f"{leg}_spool", bolt_rest, pin, bolt_rest.cross(pin), "gear",
		[[t, round(math.atan2(down_.dot(pins[0].cross(p_)), pins[0].dot(p_)), 4)] for t, p_ in zip(steps, pins)])
	# The connecting link, rigid, from its pin in the structure down its axis
	# to the bell crank's pin; the crank, on a bracket off the arm's pivot
	# boss with its arm square to the link, turns to hold the link's length
	# as the leg swings (the turn the planing link carries to the axle)
	link = m["link"]
	direction = Vector((-link["direction"][0], -side * link["direction"][2], link["direction"][1])).normalized()
	through = at(link["through"][0], link["through"][1], side * link["through"][2])
	top, crank_pin = on(through, direction, b["connecting"]["pin"]), on(through, direction, b["connecting"]["crank"])
	across = n.cross(flat(direction)).normalized()
	if (crank_pin + across - pivot).length > (crank_pin - across - pivot).length:
		across = -across   # toward the arm's pivot
	centre = crank_pin + across * (b["connecting"]["arm"] * INCH)
	length, height = flat(top - crank_pin).length, (top - crank_pin).dot(n)

	def held(t, guess):
		# the crank's turn that holds the link's length at gear t, near a guess
		def gap(phi):
			return flat(carry(centre + Matrix.Rotation(phi, 3, n) @ (crank_pin - centre), t) - top).length - length
		lo, hi = guess - 1.0, guess + 1.0
		if gap(lo) * gap(hi) > 0:
			raise SystemExit(f"{leg} connecting link: the crank cannot hold its length at gear {t}")
		while hi - lo > 1e-7:
			mid = (lo + hi) / 2
			lo, hi = (lo, mid) if gap(lo) * gap(mid) <= 0 else (mid, hi)
		return (lo + hi) / 2
	phis = [0.0]
	for t in reversed(steps[:-1]):
		phis.append(held(t, phis[-1]))
	phis = list(reversed(phis))   # by step, gear 0 to 1
	pins = [carry(centre + Matrix.Rotation(phi, 3, n) @ (crank_pin - centre), t) for t, phi in zip(steps, phis)]
	print(f"{leg} connecting link: {(top - crank_pin).length / INCH:.1f} in, its crank's arm {(crank_pin - centre).length / INCH:.1f} in turning {math.degrees(max(phis) - min(phis)):.1f} deg")
	# the link as dvids8678626 shows it: a white sleeve from its pin down to
	# the polished rod, which runs between the collars the photos mark
	# (layout.gear legs main link collars), a lock collar at each of its
	# ends, and a white rod end on down to the crank's pin, where the crank's
	# bolt head covers it (layout.braces connecting)
	k_ = b["connecting"]
	run = (pins[0] - top).normalized()
	upper, lower = (top + run * (on(through, direction, link["collars"][i][1]) - top).length for i in (0, 1))
	lock, thick = k_["collar"]
	node(f"{leg}_link", hinge=top, mesh=merge([cylinder(top, upper, k_["sleeve"] / 2, sides=12),
		finished(cylinder(upper, lower, k_["rod"] / 2, sides=10), "chrome"),
		cylinder(lower, pins[0], k_["end"] / 2, sides=10)] +
		[cylinder(q - run * (thick / 2 * INCH), q + run * (thick / 2 * INCH), lock / 2, sides=12) for q in (upper, lower)]), paint="white")
	joint(f"{leg}_link", n, flat(pins[0] - top), n.cross(flat(pins[0] - top)), "gear", [[t, round(angle(pins[0] - top, p - top), 4)] for t, p in zip(steps, pins)])
	collar = (on(through, direction, link["collars"][0][1]) - top).length
	MARKS[f"link_collar_{name}"] = (top + (pins[0] - top).normalized() * collar, f"{leg}_link")
	# the crank: a bar from its boss to the link's pin, riding the leg, at
	# rest turned as with the gear stowed
	rest_pin = centre + Matrix.Rotation(phis[0], 3, n) @ (crank_pin - centre)
	node(f"{leg}_crank", parent=f"{leg}_strut", hinge=strut_undo @ centre,
		mesh=rested(merge([cylinder(centre, rest_pin, 0.8), cylinder(centre - n * (1.0 * INCH), centre + n * (1.0 * INCH), 1.3)] +
			[stud(q + n * (k * e * INCH), n * k, fit["bolt"]) for q, e in ((centre, 1.0), (rest_pin, 0.5)) for k in (-1, 1)]), strut_undo), paint="white")
	arm = strut_undo.to_3x3() @ flat(rest_pin - centre)
	joint(f"{leg}_crank", n, arm, n.cross(arm), "gear", [[t, round(phi - phis[0], 4)] for t, phi in zip(steps, phis)])
	# the post's lower casting's fittings, riding the post: under the fork the
	# clevis the brace's foot turns in (layout.motion braces side foot,
	# dvids8678626), two lugs off the post either side of the spool, the
	# bolt's thread, castellated nut and end under the lower lug; and the
	# crank's bracket from the pivot boss (within its length, gear()) out to
	# the crank's pin
	def along(x):
		return bolt + down_ * (x * INCH)
	ends_ = []
	for top_, bottom_ in ft["lugs"]:
		# each lug a plate square to the bolt from the post's axis out round the
		# bolt, as wide as the spool and a little more
		q = along(top_)
		home = trunnion + axis_ * (q - trunnion).dot(axis_)
		e1 = ((home - q) - down_ * (home - q).dot(down_))
		reach_, e1 = e1.length / INCH, e1.normalized()
		e2 = down_.cross(e1)
		r = ft["spool"] / 2 + 0.3
		ring_ = [q + (e1 * math.cos(t) + e2 * math.sin(t)) * (r * INCH) for t in (math.pi / 2 + math.pi * k / 12 for k in range(13))]
		ring_ += [q + (e1 * reach_ - e2 * r) * INCH, q + (e1 * reach_ + e2 * r) * INCH]
		ends_.append(outward(extruded(ring_, down_ * ((bottom_ - top_) * INCH))))
	_, (_, b1) = ft["lugs"]
	across, n0, n1 = ft["nut"]
	ends_ += [cylinder(along(b1), along(n0), ft["spool"] / 2 - 0.4),
		cylinder(along(n0), along(n1), across / 2 / math.cos(math.pi / 12), sides=12), cylinder(along(n1), along(ft["end"][1]), ft["end"][0] / 2)]
	base = pivot + out * max(-4.5 * INCH, min(2.5 * INCH, (centre - pivot).dot(out)))
	node(f"{leg}_casting", parent=f"{leg}_strut", hinge=strut_undo @ centre, mesh=rested(merge(ends_ + [cylinder(base, centre, 1.0)]), strut_undo), paint="white")


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
		# Stowed as Grandmont 2009 has the mechanism (layout.motion stowed):
		# the whole leg turns about one trunnion axis, never about its post;
		# the shrink link draws the shock absorber in, turning the trailing
		# arm up about its pivot; the axle and wheel turn a quarter about an
		# axis at the arm's end. The facts give the left leg in stations,
		# waterlines and buttlines, the right its mirror; the model's frame
		# reflects them, so an axis (a, b, c) there is (a, c, -b) here
		stow = LAYOUT["motion"]["stowed"]["value"]["main"]

		def turned(v):
			x, w, b = v if side < 0 else (-v[0], -v[1], v[2])
			return Vector((x, b, -w)).normalized()
		face = axle - out * (g["tyres"]["main"]["width"] / 2 * INCH)
		shock = m["shock"]
		# the shock turns about its top pin, the boss on the post's top casting
		# where it meets the skin (layout.gear legs main shock ends)
		shock_top, eye = (at(f, w, side * b) for f, w, b in shock["ends"])
		# the arm's tip, where the axle's stub begins, the shock's eye on a lug
		# on the arm's top short of it
		tip = at(m["arm"]["tip"][0], m["arm"]["tip"][1], side * m["arm"]["tip"][2])
		reach = (face - pivot).length
		lever = out if out.cross(face - pivot).dot(UP) > 0 else -out
		# The leg hangs in flight with the shock absorber out by its whole
		# stroke (layout.motion stowed main shrink): the photos' stance on the
		# ground is the shock pushed in by the stroke, and the arm drooping
		# below it in flight is checked against the approach photos'
		# (layout.gear legs main droop). The leg is built drooped, as it rests
		# relative to the post; the oleo drive pushes the arm back up onto the
		# ground (the stance the photos show is the droop's worth of it), and
		# the shrink link draws the shock in by its stroke as the leg retracts,
		# so it stows with the arm at its standing angle
		length, lo, hi = (eye - shock_top).length, 0.0, 1.6
		for _ in range(60):
			mid = (lo + hi) / 2
			lo, hi = (mid, hi) if (pivot + Matrix.Rotation(-mid, 3, lever) @ (eye - pivot) - shock_top).length < length + stow["shrink"] * INCH else (lo, mid)
		shrink = (lo + hi) / 2
		DROOPS[leg] = (shrink, reach)
		hang = Matrix.Rotation(-shrink, 3, lever)
		standing = eye
		eye, tip, face, axle = (pivot + hang @ (v - pivot) for v in (eye, tip, face, axle))
		hanging = (eye - shock_top).length   # the shock absorber's length in flight
		drawn = Matrix.Rotation(shrink, 3, lever)
		swing, quarter = math.radians(stow["swing"]), math.pi / 2
		# the axle's turn axis, which the facts give with the arm at its
		# standing angle, as it lies with the arm hanging
		turn_axis = hang @ turned(stow["turn"])
		frames = chain([(trunnion, turned(stow["axis"]), -swing), (pivot, lever, -shrink), (tip, turn_axis, -quarter)])
		strut_undo, shrink_undo, axle_undo = (f[2] for f in frames)
		boss = cylinder(pivot - out * (4.5 * INCH), pivot + out * (2.5 * INCH), 2.0)
		# The post's castings (layout.gear legs main castings, read off the
		# close-ups dvids8678626 and dvids8678629): the head where it leaves
		# the airframe, wider than the post and chamfered to it; two clamp
		# bands; the lower casting flaring from the post down to the fork,
		# whose cheeks hold the pivot boss's ends; and the clevis aft and
		# outboard of the head holding the shock absorber's top, its cheeks
		# square to the axis the shock turns about (the plane through its lug
		# and its eye hanging and standing)
		c = m["castings"]
		post_r = m["post"] / 2
		head = top + extended * (c["head"]["length"] * INCH)
		flare = top + extended * (c["flare"]["from"] * INCH)
		pieces = [cylinder(trunnion, flare + extended * (0.2 * INCH), post_r, sides=16), boss,   # the post down into the lower casting's top, which carries it on to the fork
			cylinder(top - extended * (1.0 * INCH), head, c["head"]["diameter"] / 2, sides=16),
			cylinder(head, head + extended * (1.0 * INCH), c["head"]["diameter"] / 2, post_r, sides=16),
			casting(flare, fork, out, post_r, c["flare"])]
		# the pivot's pin, hollow, standing proud of the boss's ends
		# (layout.gear legs main castings fittings pin, dvids8678626)
		fit = c["fittings"]
		# the pivot pin's outboard end through its hex nut (castings fittings
		# nut, dvids8678626), the inboard end, unseen, its plain hollow end
		nut_ = fit["nut"]
		pieces += [cylinder(pivot + out * (2.5 * INCH), pivot + out * ((2.5 + nut_[1]) * INCH), nut_[0] / 2 / math.cos(math.pi / 6), sides=6),
			hollow(pivot + out * ((2.5 + nut_[1]) * INCH), out, fit["pin"]), hollow(pivot - out * (4.5 * INCH), -out, fit["pin"])]
		for band in c["bands"]:
			at_ = top + extended * (band * INCH)
			pieces.append(cylinder(at_ - extended * (0.35 * INCH), at_ + extended * (0.35 * INCH), post_r + 0.3, sides=16))
		def station(q):
			# a point's station and waterline, inches
			return ORIGIN["station"] - q.x / INCH, q.z / INCH + ORIGIN["waterline"]
		fs_, wl_ = station(pivot)
		boss_round = [(fs_ + c["cheeks"]["radius"] * math.cos(a), wl_ + c["cheeks"]["radius"] * math.sin(a)) for a in (2 * math.pi * k / 16 for k in range(16))]
		cf, cw = station(fork + UP * (2.0 * INCH))
		width_ = c["flare"]["diameter"] / 2 - 0.3
		outline = hull(boss_round + [(cf - width_, cw), (cf + width_, cw)])
		for end in (-4.5 + c["cheeks"]["thickness"] / 2, 2.5 - c["cheeks"]["thickness"] / 2):
			pieces.append(filleted(profiled(outline, c["cheeks"]["thickness"], -(pivot + out * (end * INCH)).y / INCH), min(fit["round"], 0.4 * c["cheeks"]["thickness"])))
		lug_axis = (eye - shock_top).cross(standing - shock_top).normalized()
		near_ = top + extended * (shock_top - top).dot(extended)
		reach_ = (near_ - shock_top) - lug_axis * (near_ - shock_top).dot(lug_axis)
		toward_ = reach_.normalized()
		across_ = toward_.cross(lug_axis)
		into = reach_.length - (post_r - 1.0) * INCH
		for k in (-1, 1):
			# the inboard cheek runs to the post; the outboard is a lug round
			# the pin, the connecting link passing outboard of the casting
			# between them (dvids8678626)
			o = lug_axis * (k * 1.65 * INCH)
			length = into if o.dot(out) < 0 else 1.0 * INCH
			pieces.append(filleted(slab([shock_top + o - across_ * (1.6 * INCH), shock_top + o + across_ * (1.6 * INCH), shock_top + o + toward_ * length + across_ * (1.6 + 0.6 * length / into) * INCH, shock_top + o + toward_ * length - across_ * (1.6 + 0.6 * length / into) * INCH], 0.8), min(fit["round"], 0.32)))
		pieces.append(cylinder(shock_top - lug_axis * (2.3 * INCH), shock_top + lug_axis * (2.3 * INCH), 0.9, sides=10))
		# hollow, like the pivot's, standing proud of the cheeks' faces
		# (fittings pin, dvids8678626)
		pieces += [hollow(shock_top + lug_axis * (k * 2.05 * INCH), lug_axis * k, fit["pin"]) for k in (-1, 1)]
		# the tie-down: a lug out of the post's front under its head, turned a
		# little outboard, and its ring hanging from the lug's eye in the
		# lug's plane
		td = c["tiedown"]
		ahead = FORWARD - extended * FORWARD.dot(extended)
		outward_ = out - extended * out.dot(extended)
		ahead = (ahead.normalized() * math.cos(math.radians(td["turn"])) + outward_.normalized() * math.sin(math.radians(td["turn"]))).normalized()
		depth_, reach_lug, thick = td["lug"]
		base = top + extended * (td["at"] * INCH) + ahead * ((post_r - 0.3) * INCH)
		pieces.append(slab([base - extended * (depth_ / 2 * INCH), base + extended * (depth_ / 2 * INCH),
			base + ahead * (reach_lug * INCH) + extended * (depth_ / 2 * INCH), base + ahead * (reach_lug * INCH) - extended * (depth_ / 2 * INCH)], thick))
		across_ring, stock = td["ring"]
		eye_ = base + ahead * ((reach_lug - 0.5) * INCH)
		pieces.append(ring(eye_ + extended * ((across_ring / 2 - stock / 2) * INCH), ahead.cross(extended), across_ring / 2 - stock / 2, stock))
		node(f"{leg}_strut", hinge=trunnion, mesh=rested(merge(pieces), strut_undo), paint="white")
		stowed_post = strut_undo.to_3x3() @ extended
		joint(f"{leg}_strut", frames[0][1], stowed_post, extended, "gear", [[0, 0], [1, round(swing, 4)]])
		# the shrink link's turn of the arm, and the leg's own compression on
		# the ground (the oleo drive's metres over the arm's length) below it
		node(f"{leg}_shrink", parent=f"{leg}_strut", hinge=frames[1][0])
		rest_turn = shrink_undo.to_3x3()
		joint(f"{leg}_shrink", frames[1][1], rest_turn @ (tip - pivot), strut_undo.to_3x3() @ (tip - pivot), "gear", [[0, 0], [1, round(shrink, 4)]])
		# the trailing arm: its sleeve round the pivot boss between the fork's
		# cheeks, the tapered arm aft to the eye with a flange part-way, and
		# the brake line along its top, in its coiled guard over its aft part
		a_ = c["arm"]
		along = (tip - pivot).normalized()
		upward = (UP - along * UP.dot(along)).normalized()
		radius_at = lambda f: (a_["diameters"][0] + (a_["diameters"][1] - a_["diameters"][0]) * f) / 2
		flange = pivot + (tip - pivot) * a_["flange"]
		arm_pieces = [cylinder(pivot - out * ((4.5 - c["cheeks"]["thickness"] - 0.1) * INCH), pivot + out * ((2.5 - c["cheeks"]["thickness"] - 0.1) * INCH), a_["diameters"][0] / 2, sides=16),
			cylinder(pivot, tip, a_["diameters"][0] / 2, a_["diameters"][1] / 2, sides=16),
			cylinder(flange - along * (0.3 * INCH), flange + along * (0.3 * INCH), radius_at(a_["flange"]) + 0.25, sides=16)]
		line_ = c["line"]
		lift_ = lambda f: upward * ((radius_at(f) + line_["diameter"] / 2 + 0.1) * INCH)
		arm_pieces.append(finished(cylinder(pivot + lift_(0.0), tip + lift_(1.0), line_["diameter"] / 2, sides=6), "chrome"))
		f_ = line_["coil"][0]
		while f_ <= line_["coil"][1]:
			q = pivot + (tip - pivot) * f_ + lift_(f_)
			arm_pieces.append(finished(cylinder(q - along * (0.12 * INCH), q + along * (0.12 * INCH), line_["diameter"] / 2 + 0.25, sides=8), "chrome"))
			f_ += 0.5 * INCH / (tip - pivot).length
		# the lug on the arm's top that carries the shock's eye: a plate from
		# the arm up to the eye, square to the axis the shock turns about, and
		# the eye's boss on it
		below = pivot + along * (eye - pivot).dot(along)
		arm_pieces.append(filleted(slab([below - along * (1.8 * INCH), below + along * (1.8 * INCH), eye + along * (1.1 * INCH), eye - along * (1.1 * INCH)], 1.0), min(fit["round"], 0.4)))
		arm_pieces.append(cylinder(eye - lug_axis * (1.2 * INCH), eye + lug_axis * (1.2 * INCH), 1.1, sides=12))
		node(f"{leg}_oleo", parent=f"{leg}_shrink", hinge=frames[1][0], mesh=rested(merge(arm_pieces), shrink_undo), paint="white")
		joint(f"{leg}_oleo", rest_turn @ lever, rest_turn @ (face - pivot), rest_turn @ UP, f"oleo.{name}", [[0, 0], [1, round(1 / reach, 4)]])
		# the planing rod above the arm (dvids8678626), riding it from a pin
		# on the pivot boss's axis outboard of the fork's cheek to the axle's
		# fitting over the arm's tip, outboard of the shock's eye (user,
		# 2026-11-14: so the arm's droop never parts it from either end); an
		# eye round each pin
		r_ = c["rod"]
		across = along.cross(upward).normalized()
		if across.dot(out) < 0:
			across = -across   # outboard, square to the arm and to its up
		front = pivot + out * (r_["front"] * INCH)
		back = tip + upward * (r_["back"][0] * INCH) + across * (r_["back"][1] * INCH)
		node(f"{leg}_rod", parent=f"{leg}_oleo", hinge=frames[1][0], mesh=rested(merge([cylinder(front, back, r_["diameter"] / 2, sides=8),
			cylinder(front - out * (0.4 * INCH), front + out * (0.4 * INCH), r_["diameter"] / 2 + 0.25, sides=10),
			cylinder(back - out * (0.4 * INCH), back + out * (0.4 * INCH), r_["diameter"] / 2 + 0.25, sides=10)]), shrink_undo), paint="white")
		# the axle's stub, from the arm's end out to the wheel's inboard face,
		# turning a quarter with the wheel on it
		node(f"{leg}_axle", parent=f"{leg}_oleo", hinge=frames[2][0], mesh=rested(cylinder(tip, face, a_["diameters"][1] / 2, 2.0, sides=16), axle_undo), paint="white")
		joint(f"{leg}_axle", frames[2][1], axle_undo.to_3x3() @ (axle - tip), shrink_undo.to_3x3() @ (axle - tip), "gear", [[0, 0], [1, round(quarter, 4)]])
		wheel_turn = axle_undo.to_3x3()
		node(f"{leg}_wheel", parent=f"{leg}_axle", hinge=axle_undo @ axle,
			mesh=rested(tyre(axle, out, main_r, g["tyres"]["main"]["width"], g["tyres"]["main"]["hub"], "hub", grooves=g["tyres"]["main"]["grooves"],
				face=g["tyres"]["main"]["face"], outer=1, brake=g["tyres"]["main"]["brake"], sides=48, bulge=g["tyres"]["bulge"]), axle_undo))
		# the hub's outer face, where a photo shows the wheel's centre
		MARKS[f"axle_main_{name}"] = (axle_undo @ (axle + out * (g["tyres"]["main"]["width"] * 0.35 * INCH)), f"{leg}_wheel")
		# its centre, where a head-on photo shows the middle of the tyre
		MARKS[f"wheel_main_{name}"] = (axle_undo @ axle, f"{leg}_wheel")
		joint(f"{leg}_wheel", wheel_turn @ out, Vector((0, 0, -1)), FORWARD, f"wheel.{name}", IDENTITY)
		# the shock absorber, from a lug on the post's top casting down to an
		# eye on the arm: as the shrink link draws the arm up its body turns
		# about the lug to follow the eye and a sleeve slides its can up over
		# the body (the gear drive); on the ground the leg's compression does
		# the same (the oleo drive; the two never move at once)
		arm = eye - shock_top
		drawn_eye = pivot + drawn @ (eye - pivot)

		def toward(e, ref, axis):
			# the turn about `axis` that aims the body from ref at e, in the
			# plane square to the axis
			a, c = ref - axis * ref.dot(axis), (e - shock_top) - axis * (e - shock_top).dot(axis)
			return math.atan2(axis.dot(a.cross(c)), a.dot(c))
		bend_in = arm.cross(drawn_eye - shock_top).normalized()
		aim_in = Matrix.Translation(shock_top) @ Matrix.Rotation(toward(drawn_eye, arm, bend_in), 4, bend_in) @ Matrix.Translation(-shock_top)
		body_undo = strut_undo @ aim_in
		body_turn = body_undo.to_3x3()
		steps = [k / 40 for k in range(41)]
		eyes_in = [pivot + Matrix.Rotation(shrink * (1 - g_), 3, lever) @ (eye - pivot) for g_ in steps]
		node(f"{leg}_shock_aim", parent=f"{leg}_strut", hinge=strut_undo @ shock_top)
		aim_keys = [[g_, round(abs(toward(e, drawn_eye - shock_top, bend_in)), 4)] for g_, e in zip(steps, eyes_in)]
		joint(f"{leg}_shock_aim", strut_undo.to_3x3() @ bend_in, body_turn @ arm, strut_undo.to_3x3() @ arm, "gear", aim_keys)
		# the eye swings round the arm's pivot, out of the plane square to that
		# turn's axis (the pin stands to one side of the arm), so after each
		# turn the body leans across onto the eye about the axis square to it
		# and to the turn's
		lean_axis = arm.cross(bend_in).normalized()

		def lean(e):
			return math.asin(max(-1.0, min(1.0, (e - shock_top).normalized().dot(bend_in))))
		node(f"{leg}_shock_lean", parent=f"{leg}_shock_aim", hinge=strut_undo @ shock_top)
		joint(f"{leg}_shock_lean", body_turn @ lean_axis, body_turn @ arm, body_turn @ bend_in, "gear", [[g_, round(lean(e), 4)] for g_, e in zip(steps, eyes_in)])
		# the can as long as the photos show it standing, from the collar to the
		# eye, closed by the eye's 1.5 in at its end, carries the polished
		# piston up through the collar into the white upper cylinder, which
		# runs on up its line past the pin into the bay (layout.gear legs main
		# shock hidden): out by the 12 in stroke in flight the piston keeps an
		# inch inside the cylinder, and the leg is fully in where its top comes
		# within half an inch of the cylinder's top (the oleo drive's full,
		# metres at the arm's reach, which the points file gives the engine as
		# the most it may push the leg in)
		sc = c["shock"]
		hidden = shock["hidden"] * INCH
		standing_length = (standing - shock_top).length
		can_length = standing_length * (1 - shock["collar"])
		cap_reach = hidden + sc["cap"][1] * INCH   # the upper cylinder's end, down from its top
		piston_top = cap_reach - (hanging - standing_length) - 1.0 * INCH   # standing, down from the cylinder's top
		bottom = standing_length - (piston_top - 0.5 * INCH)   # the pin to the eye, fully in
		lo, hi = shrink, shrink + 1.0
		for _ in range(60):
			mid = (lo + hi) / 2
			lo, hi = (mid, hi) if (pivot + Matrix.Rotation(mid, 3, lever) @ (eye - pivot) - shock_top).length > bottom else (lo, mid)
		FULLS[leg] = (lo + hi) / 2 * reach
		# the oleo drive, m: up from hanging past the standing stance to the
		# stroke's end; the body turns about one axis square to the plane
		# through the lug and the eye hanging and standing, the shrink link's
		# plane too, so both drives aim it along it
		travel = [round(0.05 * k, 2) for k in range(int(FULLS[leg] / 0.05) + 1) if 0.05 * k < FULLS[leg] - 0.01] + [round(FULLS[leg], 4)]
		eyes = [pivot + Matrix.Rotation(d / reach, 3, lever) @ (eye - pivot) for d in travel]
		bend = bend_in if bend_in.cross(arm).dot(drawn_eye - eye) > 0 else -bend_in
		collar = eye - arm.normalized() * can_length
		body, can = (w / 2 for w in shock["diameters"])
		# the shock's top: its eye on the clevis's pin, the white upper cylinder
		# from inside the bay down past the pin to its visible cap's end, the
		# red band on the cap
		down_ = arm.normalized()
		crown = shock_top - down_ * hidden
		cap_end = crown + down_ * cap_reach
		band = shock_top + down_ * (sc["band"][0] * INCH)
		top_pieces = [cylinder(shock_top - lug_axis * (1.25 * INCH), shock_top + lug_axis * (1.25 * INCH), 1.6, sides=12),
			cylinder(crown, cap_end, sc["cap"][0] / 2, sides=16),
			finished(cylinder(band, band + down_ * (sc["band"][1] * INCH), sc["cap"][0] / 2 + 0.05, sides=16), "red")]
		node(f"{leg}_shock_turn", parent=f"{leg}_shock_lean", hinge=strut_undo @ shock_top)
		joint(f"{leg}_shock_turn", body_turn @ bend, body_turn @ arm, body_turn @ (eyes[-1] - eye), f"oleo.{name}",
			[[d, round(toward(e, arm, bend), 4)] for d, e in zip(travel, eyes)])
		node(f"{leg}_shock", parent=f"{leg}_shock_turn", hinge=strut_undo @ shock_top, mesh=rested(merge(top_pieces), body_undo), paint="white")
		joint(f"{leg}_shock", body_turn @ lean_axis, body_turn @ arm, body_turn @ bend_in, f"oleo.{name}", [[d, round(lean(e), 4)] for d, e in zip(travel, eyes)])
		# the can drawn up the body by the shrink at rest, the sleeve letting it
		# back down as the arm lowers
		drawn_length = (drawn_eye - shock_top).length
		up_body = -arm.normalized()
		sleeve = Matrix.Translation(up_body * (hanging - drawn_length))
		node(f"{leg}_shock_sleeve", parent=f"{leg}_shock", hinge=body_undo @ (sleeve @ eye))
		joint(f"{leg}_shock_sleeve", body_turn @ arm, body_turn @ arm, body_turn @ arm, "gear",
			[[g_, round((e - shock_top).length - drawn_length, 4)] for g_, e in zip(steps, eyes_in)], motion="slide")
		end = eye - arm.normalized() * (1.5 * INCH)
		# its lower end narrowing to the neck on the eye (castings fittings
		# neck, dvids8678626)
		neck = c["fittings"]["neck"]
		shoulder = end - arm.normalized() * (neck[1] * INCH)
		node(f"{leg}_shock_can", parent=f"{leg}_shock_sleeve", hinge=body_undo @ (sleeve @ eye),
			mesh=rested(merge([cylinder(collar, shoulder, can, sides=16), cylinder(shoulder, end, can, neck[0] / 2, sides=16), cylinder(end, eye, 1.5), serrated(collar - arm.normalized() * (0.2 * INCH), collar + arm.normalized() * ((sc["collar"] - 0.2) * INCH), can + 0.1, can + 0.3),
				finished(cylinder(crown + down_ * (cap_reach - 1.0 * INCH), collar, body, sides=16), "chrome")]), body_undo @ sleeve), paint="white")
		joint(f"{leg}_shock_can", body_turn @ arm, body_turn @ arm, body_turn @ -arm, f"oleo.{name}",
			[[d, round(arm.length - (e - shock_top).length, 4)] for d, e in zip(travel, eyes)], motion="slide")
		# the side brace and the planing mechanism's connecting link, solved
		# once the whole airframe is built (main_members())
		BRACES.append(lambda skin, leg=leg, name=name, side=side, out=out, pivot=pivot, trunnion=trunnion, fork=fork, axis=turned(stow["axis"]), swing=swing, strut_undo=strut_undo:
			main_members(skin, leg, name, side, out, pivot, trunnion, fork, axis, swing, strut_undo))
	# The nose leg (layout.gear legs nose): a vertical post on a trunnion aft
	# of it, the polished piston below with the axle's fork trailing aft to the
	# twin wheels, the drag brace a telescopic actuator from a pin in the
	# fuselage to the web's pin, the launch bar raised in front. It retracts
	# forward. The leg rests as it stands in flight: the oleo out by its
	# extension, which the oleo drive takes back in on the ground (the
	# photographed stance is oleo.nose at the extension)
	n = legs["nose"]
	axle = at(g["nose"], g["axles"]["nose"], 0)
	column = n["oleo"][0]
	trunnion = at(*n["trunnion"], 0)
	top = at(column, n["oleo"][1], 0)   # where the piston leaves the post
	stretch = DOWN * (n["extension"] * INCH)
	extended = DOWN
	# stowed forward and a little up (layout.motion stowed nose), the twin
	# wheels under the forward doors
	rise = math.radians(LAYOUT["motion"]["stowed"]["value"]["nose"])
	stowed = (FORWARD * math.cos(rise) + UP * math.sin(rise)).normalized()
	swing = math.acos(max(-1.0, min(1.0, stowed.dot(extended))))
	axis = stowed.cross(extended).normalized()
	frames = chain([(trunnion, axis, swing)])
	undo = frames[0][2]
	RESTED["gear_nose_strut"] = undo
	pin = at(n["brace"][0], n["brace"][1], 0)
	bar_pivot, bar_tip = at(*n["bar"]["pivot"], 0), at(*n["bar"]["tip"], 0)
	# the post and its castings (layout.gear legs nose castings): the round
	# steering housing, the collar under it and the steering block on its
	# front, the web out to the drag brace's pin with the pin's boss, the
	# torque link's bosses either side on brackets off the collar with their
	# links forward and down to the launch bar's pivot plates; the post's head
	# carried on a yoke aft to the trunnion: a plate either side and a pin out
	# of each, open between them for the drag brace's rod, which lies under
	# the trunnion when the leg is stowed
	c = n["castings"]
	web, d = c["web"], c["disk"]
	f, w = n["brace"][0], n["brace"][1]
	tf, tw = n["trunnion"]
	head = at(column, tw + 2.0, 0)
	pieces = [cylinder(head, top, n["post"] / 2),
		*[filleted(profiled([[column, tw - 3.0], [tf + 1.5, tw - 2.0], [tf + 1.5, tw + 2.0], [column, tw + 2.0]], 1.0, s_ * 2.3), min(c["fittings"]["round"], 0.4)) for s_ in (-1, 1)],
		cylinder(at(tf, tw, -1.8), at(tf, tw, -4.0), 1.8), cylinder(at(tf, tw, 1.8), at(tf, tw, 4.0), 1.8),
		housing(c["housing"]["stations"], c["housing"]["waterlines"], c["housing"]["width"]),
		# the collar, its top band the steering's bronze ring gear (castings
		# fittings teeth, dvids8856010), its teeth a gear's whole depth deep,
		# 2.25 modules (ISO 53)
		housing(c["collar"]["stations"], [c["collar"]["waterlines"][0], c["collar"]["waterlines"][1] - c["fittings"]["teeth"]["height"]], c["collar"]["width"], power=2.0),
		finished(serrated(at(sum(c["collar"]["stations"]) / 2, c["collar"]["waterlines"][1] - c["fittings"]["teeth"]["height"], 0), at(sum(c["collar"]["stations"]) / 2, c["collar"]["waterlines"][1], 0),
			c["collar"]["width"] / 2 - 2.25 * c["collar"]["width"] / c["fittings"]["teeth"]["count"], c["collar"]["width"] / 2, c["fittings"]["teeth"]["count"]), "hub"),
		housing(c["steering"]["stations"], c["steering"]["waterlines"], c["steering"]["width"], power=6.0),
		*notched(web["outline"], web["thickness"], n, undo, pin),
		cylinder(at(f, w, -web["boss"][1] / 2), at(f, w, web["boss"][1] / 2), web["boss"][0] / 2)]
	# the hydraulic hoses down the post's starboard front to the steering
	# block (layout.gear legs nose castings hoses, dvids8678629 head-on and
	# dvids9820808 from starboard): each from inside the bay down the post
	# at its bearing round from forward, sagging out a little on the way,
	# over the housing's front to its fitting on the block's side
	hs = c["hoses"]
	reach = n["post"] / 2 + hs["diameter"] / 2 + 0.1
	for bearing, end in zip(hs["bearings"], hs["ends"]):
		b_ = math.radians(bearing)
		df, db = -math.cos(b_), math.sin(b_)
		run = [at(column + df * reach, hs["top"], db * reach),
			at(column + df * (reach + 0.6), (hs["top"] + c["housing"]["waterlines"][1]) / 2, db * (reach + 0.6)),
			at(column + df * reach, c["housing"]["waterlines"][1] + 0.6, db * reach),
			at(c["steering"]["stations"][1] - 0.2, c["steering"]["waterlines"][1] + 0.6, end[2]),
			at(*end)]
		pieces.append(finished(hose(run, hs["diameter"], sides=8), "rubber"))
	# the wiring down the post's port front (layout.gear legs nose castings
	# harness, dvids8678628), from the bay down the post to the housing's top
	hn = c["harness"]
	b_ = math.radians(hn["bearing"])
	df, db = -math.cos(b_), math.sin(b_)
	reach = n["post"] / 2 + hn["diameter"] / 2 + 0.05
	pieces.append(finished(hose([at(column + df * reach, hn["top"], db * reach),
		at(column + df * (reach + 0.4), (hn["top"] + c["housing"]["waterlines"][1]) / 2, db * (reach + 0.4)),
		at(column + df * reach, c["housing"]["waterlines"][1] + 0.4, db * reach),
		at(column + df * reach, c["housing"]["waterlines"][1] - 0.3, db * reach)], hn["diameter"], sides=6), "rubber"))
	# an eye ring on either side of the post under the bay (layout.gear legs
	# nose castings eyes, dvids9820806 and dvids8678628): flat on the post's
	# side, its stock's inner face just inside the post's round
	ey = c["eyes"]
	outer, inner = ey["diameters"][0] / 2, ey["diameters"][1] / 2
	turns = [2 * math.pi * k / 24 for k in range(24)]
	for side in (-1, 1):
		face = side * (math.sqrt(max((n["post"] / 2) ** 2 - outer ** 2, 0.0)) - 0.05)
		for half in (0, 1):
			arc = [t for t in turns if half * math.pi - 1e-9 <= t <= (half + 1) * math.pi + 1e-9] + [(half + 1) * math.pi]
			arc = sorted(set(round(t, 9) for t in arc))
			ring_ = [at(ey["at"][0] + outer * math.cos(t), ey["at"][1] + outer * math.sin(t), face) for t in arc] + \
				[at(ey["at"][0] + inner * math.cos(t), ey["at"][1] + inner * math.sin(t), face) for t in reversed(arc)]
			pieces.append(outward(extruded(ring_, at(0.0, 0.0, side * ey["stock"]) - at(0.0, 0.0, 0.0))))
	# a squared block on the post's port front over the housing, under the
	# approach lights' box, and the upright cylinder between it and the post
	# (layout.gear legs nose castings block, dvids9820806 and dvids8678629)
	# (its own node, to one side of the post, which is otherwise its mirror)
	bk = c["block"]
	(f0, f1), (w0, w1), (b0, b1) = bk["stations"], bk["waterlines"], bk["buttlines"]
	pf, pb = bk["pipe"]["at"]
	block = [filleted(profiled([[f0, w0], [f1, w0], [f1, w1], [f0, w1]], abs(b1 - b0), (b0 + b1) / 2), c["fittings"]["round"]),
		cylinder(at(pf, w0, pb), at(pf, bk["pipe"]["top"], pb), bk["pipe"]["diameter"] / 2)]
	# the castings' fittings (layout.gear legs nose castings fittings,
	# dvids9820808): the web's raised rim round its outline on each face, and
	# round bolt heads on the launch bar's pivot and the torque link's pin on
	# the pivot plates' outer faces
	fit = c["fittings"]
	rim = [at(f_, w_, 0) for f_, w_ in web["outline"]] + [at(*web["outline"][0], 0)]
	for side in (-1, 1):
		pieces.append(hose([q + PORT * (side * web["thickness"] / 2 * INCH) for q in rim], fit["rim"], steps=1))
	for side in (-1, 1):
		face = side * (c["plates"]["buttline"] + 0.3)
		for f_, w_ in (n["bar"]["pivot"], c["link"]["to"]):
			pieces.append(stud(at(f_, w_, face), -PORT * side, fit["bolt"]))   # out: buttlines run to starboard, -y
	for side in (-1, 1):
		inner = side * d["buttline"]
		pieces += [cylinder(at(*d["at"], inner), at(*d["at"], inner + side * 1.0), d["radius"]),
			cylinder(at(c["collar"]["stations"][1] - 1.0, d["at"][1], inner + side * 0.5), at(*d["at"], inner + side * 0.5), 0.5),
			cylinder(at(*d["at"], inner + side * 0.5), at(*c["link"]["to"], inner + side * 0.5), c["link"]["diameter"] / 2),
			filleted(profiled(c["plates"]["outline"], 0.6, side * c["plates"]["buttline"]), min(fit["round"], 0.24))]
	node("gear_nose_strut", hinge=trunnion, mesh=rested(merge(pieces), undo), paint="white")
	node("gear_nose_block", parent="gear_nose_strut", hinge=undo @ trunnion, mesh=rested(merge(block), undo), paint="white")
	joint("gear_nose_strut", frames[0][1], stowed, extended, "gear", [[0, 0], [1, swing]])

	def flying(mesh):
		# a part on the oleo, as it hangs in flight: down the post by the extension
		return ([v + stretch for v in mesh[0]], *mesh[1:])
	# the piston, down to the axle's fork, which trails aft to the axle: out by
	# the extension in flight it still reaches well up into the post, and
	# pushed in by the whole extension its top stays an inch under the post's
	# head; the holdback bar aft of the fork, its spring above it on two posts.
	# The leg is fully in when the piston's top meets the head: an inch past
	# standing (the oleo drive's full, which the points file gives the engine)
	foot = at(column, g["axles"]["nose"] + 1.5, 0)
	ext = n["extension"]
	FULLS["gear_nose"] = (ext + 1.0) * INCH
	node("gear_nose_oleo", parent="gear_nose_strut", hinge=undo @ (top + stretch), mesh=rested(flying(merge([finished(cylinder(head + DOWN * INCH, foot, n["piston"] / 2), "chrome"),
		filleted(profiled(c["fork"]["outline"], c["fork"]["width"]), c["fittings"]["round"])])), undo), paint="white")
	# the oleo slides up the post, toward the trunnion, as the ground loads it:
	# the post's up as it lies at rest (the sign rule reads `want` in the rest
	# frame, where the stowed post points forward)
	joint("gear_nose_oleo", undo.to_3x3() @ UP, UP, undo.to_3x3() @ UP, "oleo.nose", down, motion="slide")
	node("gear_nose_steering", parent="gear_nose_oleo", hinge=undo @ (top + stretch))
	joint("gear_nose_steering", undo.to_3x3() @ extended, PORT, -PORT, "steering", IDENTITY)
	wheels = merge([tyre(axle + Vector((0, s * offset * INCH, 0)), PORT, nose_r, g["tyres"]["nose"]["width"], g["tyres"]["nose"]["hub"], "white",
		grooves=g["tyres"]["nose"]["grooves"], face=g["tyres"]["nose"]["face"], outer=s, sides=40, bulge=g["tyres"]["bulge"]) for s in (-1, 1)] +
		[cylinder(axle + Vector((0, -6 * INCH, 0)), axle + Vector((0, 6 * INCH, 0)), 1.2)])
	node("gear_nose_wheel", parent="gear_nose_steering", hinge=undo @ (axle + stretch), mesh=rested(flying(wheels), undo), paint="white")
	for side in (-1, 1):
		MARKS[f"axle_nose_{side_name(side)}"] = (undo @ (axle + stretch + Vector((0, -side * (offset + g["tyres"]["nose"]["width"] * 0.35) * INCH, 0))), "gear_nose_wheel")
		MARKS[f"wheel_nose_{side_name(side)}"] = (undo @ (axle + stretch + Vector((0, -side * offset * INCH, 0))), "gear_nose_wheel")
	joint("gear_nose_wheel", undo.to_3x3() @ PORT, Vector((0, 0, -1)), FORWARD, "wheel.nose", IDENTITY)
	actuator(n, pin, undo, belly)
	# The holdback bar aft of the fork, its spring above it on two posts: it
	# trails aft on the ground, as the photos show it there, and lies folded
	# up along the piston's aft face with the oleo out, as the photos in flight
	# show it gear down and the transit photos as the leg retracts (layout.gear
	# legs nose castings holdback): folding as far as the piston, the fork and
	# the post above them let it, pivoting on its root at the fork, with the
	# oleo's stroke from out to standing. Built folded, as it rests
	h = c["holdback"]
	(s0f, s0w), (s1f, s1w) = h["spring"]
	low = max(p[1] for p in h["outline"])
	root = (min(f for f, _ in h["outline"]), sum(w for f, w in h["outline"] if f == min(f for f, _ in h["outline"])) / sum(1 for f, _ in h["outline"] if f == min(f for f, _ in h["outline"])))
	shape = [tuple(q) for q in h["outline"]] + [(x + dx, y_) for x, y in h["spring"] for dx in (-0.5, 0.5) for y_ in (low - 0.3, y + 0.4)]
	shape += [(s0f + (s1f - s0f) * k / 8 + nx * h["coil"] / 2 * side, s0w + (s1w - s0w) * k / 8 + ny * h["coil"] / 2 * side)
		for k in range(9) for side in (-1, 1) for nx, ny in [((s0w - s1w) / math.hypot(s1f - s0f, s1w - s0w), (s1f - s0f) / math.hypot(s1f - s0f, s1w - s0w))]]
	shape = [q for q in shape if math.hypot(q[0] - root[0], q[1] - root[1]) > 1.5]   # its own lug on the fork
	post_r = n["post"] / 2
	# what rides the oleo, and the strut above as it stands in flight (in the
	# oleo's frame, the strut's parts raised by the extension)
	blocks = [(column - n["piston"] / 2, column + n["piston"] / 2, g["axles"]["nose"], n["oleo"][1] + ext), [tuple(q) for q in c["fork"]["outline"]],
		(column - post_r, column + post_r, n["oleo"][1] + ext, n["trunnion"][1] + ext),
		(c["collar"]["stations"][0], c["collar"]["stations"][1], c["collar"]["waterlines"][0] + ext, c["collar"]["waterlines"][1] + ext),
		[(f, w + ext) for f, w in c["web"]["outline"]]]
	tuck = tucked(shape, root, blocks, 1, math.pi / 2)
	print(f"nose holdback: folds {math.degrees(tuck):.1f} deg up from trailing aft")
	pivot_h = at(root[0], root[1], 0)
	fold_h = Matrix.Translation(pivot_h) @ Matrix.Rotation(tuck, 4, PORT) @ Matrix.Translation(-pivot_h)   # aft turns up about port
	coil = [cylinder(at(s0f + (s1f - s0f) * k / 16, s0w + (s1w - s0w) * k / 16, 0), at(s0f + (s1f - s0f) * (k + 1) / 16, s0w + (s1w - s0w) * (k + 1) / 16, 0),
		h["coil"] / 2 if k % 2 == 0 else h["coil"] / 2 - 0.25, sides=8) for k in range(16)]
	posts = [profiled([[x - 0.5, low - 0.3], [x + 0.5, low - 0.3], [x + 0.5, y + 0.4], [x - 0.5, y + 0.4]], h["width"]) for x, y in h["spring"]]
	node("gear_nose_holdback", parent="gear_nose_oleo", hinge=undo @ (pivot_h + stretch), mesh=rested(flying(rested(merge([filleted(profiled(h["outline"], h["width"]), min(c["fittings"]["round"], 0.4 * h["width"]))] + posts + coil), fold_h)), undo), paint="white")
	trailing = at(max(f for f, _ in h["outline"]), root[1], 0) - pivot_h
	joint("gear_nose_holdback", undo.to_3x3() @ PORT, undo.to_3x3() @ trailing, undo.to_3x3() @ DOWN, "oleo.nose", [[0, 0], [round(ext * INCH, 4), round(tuck, 4)]])
	# The launch bar: raised as the photos show it gear down, lowered forward
	# until its tip rests on the deck (layout.motion bar); as the leg
	# retracts it folds down past forward to lie along the post's front, as
	# far toward straight down as the piston, the fork and the axle's tube let
	# it with the oleo out in flight: raised, or folded up as far as the
	# castings let it, it would stow through the cockpit's floor
	length = (bar_tip - bar_pivot).length / INCH
	ground = g["axles"]["nose"] - nose_r
	raised = math.atan2((bar_tip - bar_pivot).z, (bar_tip - bar_pivot).x)
	b = n["bar"]
	tip = b["head"][0] / 2   # the head's radius: its underside meets the deck
	# its end ring's lowest point on the deck: the axis stands the radius
	# times the cosine of the bar's slope above it
	drop = n["bar"]["pivot"][1] - ground - LAYOUT["motion"]["bar"]["value"]["deck"]
	lowered = -math.asin(min(1.0, drop / length))
	for _ in range(8):
		lowered = -math.asin(min(1.0, (drop - tip * math.cos(lowered)) / length))
	(pf, pw) = b["pivot"]
	up_ = Vector((math.cos(math.pi - raised), math.sin(math.pi - raised)))
	side_ = Vector((-up_.y, up_.x)) * (b["section"][0] / 2)
	shape = [tuple(Vector((pf, pw)) + up_ * (length * k / 40) + side_ * sign) for k in range(41) for sign in (-1, 1)]
	shape += [tuple(Vector((pf, pw)) + up_ * length + Vector((math.cos(q), math.sin(q))) * tip) for q in [2 * math.pi * k / 12 for k in range(12)]]
	blocks = [(column - n["piston"] / 2, column + n["piston"] / 2, g["axles"]["nose"] + 1.5 - ext, n["oleo"][1]), [(f, w - ext) for f, w in c["fork"]["outline"]],
		(g["nose"], g["axles"]["nose"] - ext, 1.2)]
	if offset - g["tyres"]["nose"]["width"] / 2 < b["head"][1] / 2 + 0.5:
		blocks.append((g["nose"], g["axles"]["nose"] - ext, nose_r))   # the tyres close enough to take the head
	folded = raised - tucked(shape, (pf, pw), blocks, 1, raised + math.pi / 2)
	print(f"launch bar: folds {math.degrees(raised - folded):.1f} deg down from raised, to {-math.degrees(folded):.1f} deg below forward")
	# a flat bar (layout.gear legs nose bar: its section), black in a band
	# short of its tip, and the cross-tube at the tip that the shuttle takes;
	# built folded, as it rests
	along = Vector((math.cos(math.pi - folded), math.sin(math.pi - folded)))   # forward is -FS
	across = Vector((-along.y, along.x)) * (b["section"][0] / 2)

	def stretch_(a, z):
		# the bar's side profile from a to z inches along it from the pivot
		ends = [Vector((pf, pw)) + along * a, Vector((pf, pw)) + along * z]
		return [list(ends[0] - across), list(ends[1] - across), list(ends[1] + across), list(ends[0] + across)]
	reach = length
	far = Vector((pf, pw)) + along * reach
	band = [reach - b["band"][1], reach - b["band"][0]]
	beam = merge([profiled(stretch_(0.0, band[0]), b["section"][1]), finished(profiled(stretch_(band[0], band[1]), b["section"][1]), "rubber"),
		profiled(stretch_(band[1], reach), b["section"][1]), cylinder(at(far.x, far.y, -b["head"][1] / 2), at(far.x, far.y, b["head"][1] / 2), tip, sides=12)])
	node("launch_bar_fold", parent="gear_nose_strut", hinge=undo @ bar_pivot)
	# both joints turn about the pivot's axis, each sign set by the raised
	# bar's turn: up toward raised for the fold, down toward the deck for the bar
	raised_now = bar_tip - bar_pivot
	joint("launch_bar_fold", undo.to_3x3() @ PORT, undo.to_3x3() @ raised_now, undo.to_3x3() @ UP, "gear", [[0, 0], [1, round(raised - folded, 4)]])
	node("launch_bar", parent="launch_bar_fold", hinge=undo @ bar_pivot, mesh=rested(beam, undo), paint="white")
	joint("launch_bar", undo.to_3x3() @ PORT, undo.to_3x3() @ raised_now, undo.to_3x3() @ DOWN, "bar", [[0, 0], [1, round(raised - lowered, 4)]])
	MARKS["launch_bar_tip"] = (undo @ at(far.x, far.y, 0), "launch_bar")
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
	# each casing reaching half an inch into the post's wall, short of the
	# piston, which runs up inside the post as the oleo strokes
	casing = [cylinder(at(f + 0.3, w, b), at(post + 0.5, w, b), radius)]
	lenses = [cylinder(at(f, w, b), at(f + 0.4, w, b), radius - 0.3)]
	a_ = lamp["approach"]
	f, w, b = points["approach"]["at"]
	turn = math.radians(a_["facing"])
	facing = FORWARD * math.cos(turn) + PORT * math.sin(turn)   # Blender's y is to port
	sideways = facing.cross(UP).normalized()
	middle = at(f, w, b)
	width, height = a_["box"]
	depth = (middle - at(post + 0.5, w, 0)).dot(facing) / INCH   # from its face back into the post's wall
	face = middle - facing * (0.1 * INCH)

	def rectangle(centre):
		return [centre + (sideways * (x * width / 2) + UP * (y * height / 2)) * INCH for x, y in ((-1, -1), (1, -1), (1, 1), (-1, 1))]

	casing.append(loft([rectangle(face), rectangle(face - facing * (depth * INCH))]))
	# held on an arm from the box's back into the post's wall
	back = face - facing * (depth * INCH)
	casing.append(cylinder(back + facing * (0.5 * INCH), at(post + 0.5, w, 0), 0.8, sides=8))
	node("gear_nose_lamps", parent="gear_nose_strut", hinge=undo @ trunnion, mesh=rested(merge(casing), undo), paint="white")
	node("lamp_gear_nose", parent="gear_nose_strut", hinge=undo @ trunnion, mesh=rested(merge(lenses), undo), paint="lights")
	# each approach light's lens its own node, which the engine lights by itself
	# with the angle of attack (NATOPS 2.6.1.6)
	for k, hue in ((1, "green"), (0, "amber"), (-1, "red")):
		centre = middle + UP * (k * a_["spacing"] * INCH)
		node(f"lamp_approach_{hue}", parent="gear_nose_strut", hinge=undo @ trunnion, mesh=rested(cylinder(centre, centre - facing * (0.4 * INCH), a_["lens"] / 2), undo), paint="lights")

	def door(node_name, well, outline, hinge, targets, below=True, curve=None, corners=None, pairs=None, least=None):
		# A door cut from the skin inside its plan outline ([FS, BL]), hinged
		# on the skin along `hinge` (two [FS, BL] ends), opened with the gear
		# by the angle that brings its far edge's ends nearest the photos'
		# (targets, [FS, WL, BL] each: an open edge's ends, or its one marked
		# corner). `curve` names its free edge in the features file, an inch
		# apart along the hinge, for the photos' traces of it; `corners` its
		# closed outline's corners ({mark: [FS, BL]}), on the door, for the
		# gear-up photos' seams
		# A hinge end given as [FS, WL, BL] is where the photos fix the axis
		# (off the skin, inside it); `pairs` fits the turn to named closed
		# corners ([FS, BL]) and where the photos put each open ([FS, WL, BL])
		# where two of its convex pieces share an edge, neither closes it:
		# the shorter of the two edges, lying along the longer
		def shared(piece):
			edges = list(zip(piece, piece[1:] + piece[:1]))
			out = []
			for other in outline:
				if other is piece:
					continue
				for a, b in zip(other, other[1:] + other[:1]):
					for c, d in edges:
						if on_line(c, a, b) and on_line(d, a, b):
							out.append((c, d))
						elif on_line(a, c, d) and on_line(b, c, d):
							out.append((a, b))
			return out

		def on_line(q, a, b):
			# q within a hundredth of an inch of the segment a-b, in plan
			dx, dy = b[0] - a[0], b[1] - a[1]
			k = max(0.0, min(1.0, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / (dx * dx + dy * dy)))
			return math.hypot(q[0] - a[0] - dx * k, q[1] - a[1] - dy * k) < 0.01
		least = least or [0.3] * len(outline)
		mesh = merge([cut(None, None, below=below, outline=piece, inside="white", seams=shared(piece), least=k) for piece, k in zip(outline, least)])
		o = OPENINGS.setdefault(well, {"below": below, "pieces": []})
		o["least"] = o.get("least", [0.3] * len(o["pieces"])) + least
		o["pieces"] += outline
		for mark, (f, b) in (corners or {}).items():
			MARKS[mark] = (draped(belly, f, b, below=below, out=0.15), node_name)
		h0, h1 = (at(*h) if len(h) == 3 else draped(belly, h[0], h[1], below=below, out=0.15) for h in hinge)
		axis = (h1 - h0).normalized()

		def off(v):
			d = v - h0
			return (d - axis * d.dot(axis)).length

		reach = max(off(v) for v in mesh[0])
		edge = [v for v in mesh[0] if off(v) > reach - 0.5 * INCH]
		if pairs:
			ends = [draped(belly, f, b, below=below, out=0.15) for (f, b), _ in pairs]
			goals = [at(*t) for _, t in pairs]
		else:
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
		share = LAYOUT["motion"]["doors"]["value"]["open"]
		joint(node_name, axis, closed, opened, "gear", [[0, 0], [share, round(abs(turn), 4)], [1, round(abs(turn), 4)]])
		if curve:
			bins = {}
			for v in edge:
				bins.setdefault(round((v - h0).dot(axis) / INCH), []).append(v)
			CURVES[curve] = ([sum(vs, Vector()) / len(vs) for _, vs in sorted(bins.items())], node_name)

	# The nose bay's doors, open while the leg is down (NATOPS 2.10.1): a
	# forward door each side hinged along the bay's sides, closing toward the
	# centreline; behind them a long door hinged right of the centreline and
	# closing across it, to its closed free edge (the views from below)
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
		# closed, the two doors meet on the centreline: the leg's fork passes
		# there, so no strip of skin lies between them (0.7 in further than a
		# rigid panel as long as the open edge's marks, which stand 1-2 in off
		# the doors' outer faces)
		reach0 = reach1 = 0.0
		n = f"gear_nose_door_{side_name(side)}"
		door(n, "nose", [[[f0, side * b0], [f1, side * b1], [f1, reach1], [f0, reach0]]],
			[[f0, side * b0], [f1, side * b1]], edges, curve=f"door_nose_forward_edge_{side_name(side)}",
			corners={f"{n}_front_outboard": [f0, side * b0], f"{n}_aft_outboard": [f1, side * b1], f"{n}_aft_inboard": [f1, reach1], f"{n}_front_inboard": [f0, reach0]})
	d = doors["long"]
	(f0, b0), (f1, b1) = d["hinge"]
	(e0, r0), (e1, r1) = d["free"]
	n = "gear_nose_door_long"
	door(n, "nose", [[[f0, b0], [f1, b1], [e1, r1], [e0, r0]]], [[f0, b0], [f1, b1]], d["edge"],
		corners={f"{n}_front_right": [f0, b0], f"{n}_aft_right": [f1, b1], f"{n}_aft_left": [e1, r1], f"{n}_front_left": [e0, r0]})
	# Each main leg's doors in the blister under its nacelle (layout.nacelle
	# door), each hanging straight down when open: the inner hinged along the
	# blister's inner edge, the outer along its outer edge outboard of the leg
	for side in (-1, 1):
		name = side_name(side)
		# the outer door from its hinge in to the middle seam, closed as the
		# views from below put them
		d = doors["outer"]
		f0, f1, b = d["hinge"]
		inner = d["seam"]
		# the inner door's two panels and the outer door, closed as the views
		# from below put them, each turned open about the axis the gear-down
		# photos fit (layout.gear doors): the forward panel about an axis
		# inside the skin, skewed to the centreline; the strip aft of it about
		# its own inboard edge; the outer door about an axis outboard of its edge
		def plan(points):
			return [[fs, side * bl] for fs, bl in points]

		def snapped(piece, outline):
			# a panel's corners within a twentieth of an inch of another
			# outline's edge put exactly on it, so the two cut the skin
			# along one line and leave no sliver of it between them
			out = []
			for q in piece:
				for a, b in zip(outline, outline[1:] + outline[:1]):
					ab = (b[0] - a[0], b[1] - a[1])
					k = max(0.0, min(1.0, ((q[0] - a[0]) * ab[0] + (q[1] - a[1]) * ab[1]) / (ab[0] ** 2 + ab[1] ** 2)))
					on = [a[0] + ab[0] * k, a[1] + ab[1] * k]
					if math.hypot(q[0] - on[0], q[1] - on[1]) < 0.05:
						q = on
						break
				out.append(list(q))
			return out

		def axis_(points):
			return [[q[0], q[1], side * q[2]] if len(q) == 3 else [q[0], side * q[1]] for q in points]

		def fitted(free):
			return [([fs, side * bl], [tf, tw, side * tb]) for (fs, bl), (tf, tw, tb) in free]

		# the forward panel and the corner panel outboard of its edge, where
		# the leg's top meets the skin, which opens with it
		e = doors["inner"]["forward"]
		# the corner panel only where the nacelle's bottom still faces down by
		# 60 deg or more: its closed edge stays below the hinge's height, off
		# the side the bottom turns up into, as it starts to open
		door(f"gear_door_inner_{name}", f"main_{name}", [plan(e["outline"])] + [plan(snapped(piece, e["outline"])) for piece in e["corner"]], axis_(e["hinge"]), None, pairs=fitted(e["free"]),
			least=[0.3] + [0.5] * len(e["corner"]),
			corners={f"gear_door_inner_{k}_{name}": [fs, side * bl] for k, (fs, bl) in zip(("front_inboard", "front_outboard", "bend", "aft_outboard", "aft_inboard"), e["outline"])})
		e = doors["inner"]["strip"]
		door(f"gear_door_strip_{name}", f"main_{name}", [plan(e["outline"])], axis_(e["hinge"]), None, pairs=fitted(e["free"]),
			corners={f"gear_door_strip_{k}_{name}": [fs, side * bl] for k, (fs, bl) in zip(("front_inboard", "front_outboard", "aft_outboard", "aft_inboard"), e["outline"])})
		door(f"gear_door_outer_{name}", f"main_{name}", [[[f0, side * b], [f1, side * b], [f1, side * inner], [f0, side * inner]]], axis_(d["axis"]), None, pairs=fitted(d["free"]),
			corners={f"gear_door_outer_front_outboard_{name}": [f0, side * b], f"gear_door_outer_aft_outboard_{name}": [f1, side * b],
				f"gear_door_outer_aft_inboard_{name}": [f1, side * inner], f"gear_door_outer_front_inboard_{name}": [f0, side * inner]})


def hexagon(end, axis, across, height, chamfer=0.1):
	# A hex bolt head or nut at `end` on a face, standing `height` inches off
	# it along `axis`, `across` inches across its corners, its crown's edge
	# chamfered as a forged head's is
	axis = axis.normalized()
	u = axis.orthogonal().normalized()
	v = axis.cross(u)

	def flats(p, radius):
		return [p + (u * math.cos(math.pi / 3 * k) + v * math.sin(math.pi / 3 * k)) * (radius * INCH) for k in range(6)]

	top = end + axis * (height * INCH)
	return outward(loft([flats(end, across / 2), flats(top - axis * (chamfer * INCH), across / 2), flats(top, across / 2 - 1.5 * chamfer)]))


def tube(p0, p1, outer, inner, sides=24):
	# A closed tube from p0 to p1: its outer and inner walls and the rings at
	# its ends, radii in inches
	axis = (p1 - p0).normalized()
	u = axis.orthogonal().normalized()
	v = axis.cross(u)
	rims = [[p + (u * math.cos(2 * math.pi * k / sides) + v * math.sin(2 * math.pi * k / sides)) * (r * INCH) for k in range(sides)]
		for p, r in ((p0, outer), (p1, outer), (p1, inner), (p0, inner))]
	faces = [(a * sides + k, a * sides + (k + 1) % sides, b * sides + (k + 1) % sides, b * sides + k) for a, b in ((0, 1), (1, 2), (2, 3), (3, 0)) for k in range(sides)]
	return [q for rim in rims for q in rim], faces


def rounded_section(centre, across, through, half, depth, radius, arc=6, flat=7, dish=(0.0, 0.0)):
	# A rounded rectangle round `centre`: `half` inches either way along
	# `across`, `depth` either way along `through`, its corners rounded
	# `radius` inches, `arc` points to each corner and `flat` along each side
	# between them, starting on `across`; dish [depth, rim]: its face along
	# +through dished that deep inside a rim that wide
	out = []
	r = min(radius, 0.95 * half, 0.95 * depth)
	sunk, rim = dish
	inside = max(half - rim, 1e-6)
	for corner, (sa, st) in enumerate(((1, 1), (-1, 1), (-1, -1), (1, -1))):
		ca, ct = sa * (half - r), st * (depth - r)
		for k in range(arc):
			a = math.pi / 2 * (corner + k / (arc - 1))
			out.append((ca + r * math.cos(a), ct + r * math.sin(a)))
		# along the side to the next corner (the +through and -through sides
		# cross `across`, the others `through`)
		nxt = ((-1, 1), (-1, -1), (1, -1), (1, 1))[corner]
		for k in range(1, flat + 1):
			f = k / (flat + 1)
			if corner in (0, 2):
				out.append((sa * (half - r) + (nxt[0] - sa) * (half - r) * f, st * depth))
			else:
				out.append((sa * half, st * (depth - r) + (nxt[1] - st) * (depth - r) * f))
	return [centre + across * (a * INCH) + through * ((t - (sunk * (1 - (a / inside) ** 2) if t > 0 and abs(a) < inside else 0.0)) * INCH) for a, t in out]


def tailhook(pivot, fitting):
	# The arresting hook (layout.hook): swings sideways with its pivot fitting
	# (the keel's aft end, which turns on the keel about the upright through the
	# pin) on NATOPS 2.10.5's lateral liquid spring, then lowers about the pin.
	# Stowed, its shank climbs from the pivot into the channel between the
	# nacelles, the point tucked between the nozzles. The shank, its pivot's
	# forging and the point are white, as the gear is, and cast as castings
	# are, every edge rounded: the forging's arms round the pin on the
	# fitting's lug either side, closing aft into a socket round the shank's
	# end, the hold-down damper's clevis on its top; the round shank tapering
	# aft with its split collar and the small lug on its top; the point one
	# casting, the shank flaring into its body round the aft-facing bore, the
	# shoe under it, and the through bolt's hex head and nut on the body's
	# sides; the hold-down damper from the keel to the clevis telescopes as
	# the hook lowers
	hook = LAYOUT["hook"]
	head, fittings = hook["head"], hook["fittings"]
	node("hook_swing", hinge=pivot, mesh=fitting)
	joint("hook_swing", UP, AFT, -PORT, "swing", IDENTITY)
	tip = at(*hook["point"], 0)
	along = (tip - pivot).normalized()
	side = Vector(at(0, 0, 1) - at(0, 0, 0)).normalized()
	up = side.cross(along).normalized()
	if up.dot(UP) < 0:
		up = -up
	length = (tip - pivot).length / INCH
	climb = math.asin(along.dot(UP))

	def p(s, u=0.0, v=0.0):
		# along the shank s, up from its line u and across it v, inches
		return pivot + along * (s * INCH) + up * (u * INCH) + side * (v * INCH)

	def diameter(s):
		knots = hook["shank"]
		return float(np.interp(s / length, [k[0] for k in knots], [k[1] for k in knots]))

	def round_ring(s, radius, sides=16, lift=0.0):
		return [p(s, lift + radius * math.cos(2 * math.pi * k / sides), radius * math.sin(2 * math.pi * k / sides)) for k in range(sides)]

	def chord(points, near, far):
		# a profile in the shank's plane ([s, u] corners), carried across from v = near to v = far
		return outward(loft([[p(s, u, v) for s, u in points] for v in (near, far)]))

	body, shoe, bolts = head["body"], head["shoe"], head["bolts"]
	half = body["width"] / 2
	around = 32

	def section(s, end):
		# the casting's section at s: the round shank, flaring over `flare` into
		# the body's ahead of the point's aft face, a superellipse rounder above
		# (its chamfered top) and squarer below, where the shoe leaves it;
		# matched point for point, so no edge stands between them
		t = ease((s - (end - body["length"] - head["flare"])) / head["flare"])
		r = diameter(s) / 2
		ring = []
		for k in range(around):
			th = 2 * math.pi * k / around
			c, sn = math.cos(th), math.sin(th)
			power = 3.5 if sn >= 0 else 6.0
			x = half * math.copysign(abs(c) ** (2 / power), c)
			y = (body["top"] if sn >= 0 else body["bottom"]) * math.copysign(abs(sn) ** (2 / power), sn)
			ring.append(p(s, r * sn + (y - r * sn) * t, r * c + (x - r * c) * t))
		return ring

	def point(end):
		# the point's casting with its aft face at `end` along the shank
		pieces = []
		start = end - body["length"] - head["flare"]
		stations = [6.0 + (start - 1.0 - 6.0) * i / 8 for i in range(9)] + [start - 1.0 + 0.25 * i for i in range(int(round((end - start + 1.0) / 0.25)) + 1)]
		# its aft face an annulus round the bore, which runs in along the line
		# to a dark floor (as hollow() draws a pin's), deep enough to stand in
		# shade
		bore, deep = head["bore"]
		vertices, faces = loft([section(s, end) for s in stations])
		last = len(vertices) - around
		faces = faces[:-1]
		vertices = vertices + [p(s, bore / 2 * math.sin(2 * math.pi * k / around), bore / 2 * math.cos(2 * math.pi * k / around)) for s in (end, end - deep) for k in range(around)]
		mouth, floor = last + around, last + 2 * around
		faces += [(last + k, last + (k + 1) % around, mouth + (k + 1) % around, mouth + k) for k in range(around)]
		faces += [(mouth + k, mouth + (k + 1) % around, floor + (k + 1) % around, floor + k) for k in range(around)]
		faces += [tuple(range(floor, floor + around))]
		pieces.append((vertices, faces, [None] * (len(faces) - 1) + ["hub"]))
		# the shank tube's end, a ring proud of the face round the bore
		outside, proud = head["ring"]
		pieces.append(tube(p(end - 0.05), p(end + proud), outside / 2, bore / 2))
		# the shoe: a plate under the body's aft end, its sole leaving the body
		# at its shoulders just ahead of the aft face, which overhangs it, and
		# leaning toward the pivot as it hangs; its width carried out of the
		# body's sides on a fillet to the shoulders, straight, then rounded to
		# its lowest point; its sole dished inside a rim, every edge rounded
		lean = math.radians(shoe["lean"])
		down = -up * math.cos(lean) - along * math.sin(lean)
		sole = along * math.cos(lean) - up * math.sin(lean)
		thick = shoe["thickness"]
		reach = (shoe["reach"] - shoe["root"]) / math.cos(lean)
		root = p(end - shoe["recess"], -shoe["root"]) - sole * (thick / 2 * INCH)
		f = shoe["fillet"]
		wide = shoe["width"] / 2
		straight = reach - shoe["round"] - f
		profile = [(-0.75, half - 0.3), (-f - 0.2, half - 0.05)]
		profile += [(-f + f * math.sin(math.pi / 2 * k / 4), half + f - f * math.cos(math.pi / 2 * k / 4)) for k in range(5)]
		profile += [(0.0, wide - f + 0.001)] + [(f - f * math.cos(math.pi / 2 * k / 4), wide - f + f * math.sin(math.pi / 2 * k / 4)) for k in range(1, 5)]
		profile += [(f + straight * k / 3, wide) for k in range(1, 4)]
		profile += [(f + straight + shoe["round"] * math.sin(math.pi / 2 * k / 8), wide * math.cos(math.pi / 2 * k / 8)) for k in range(1, 8)]
		profile += [(reach - 0.02, 0.45)]
		rings = [rounded_section(root + down * (w * INCH), side, sole, max(hw, 0.3), thick / 2 - (0.3 if w > reach - 0.1 else 0.0), 0.5, dish=(shoe["dish"][0] * ease(w / 0.8) * ease((reach - w) / 0.8), shoe["dish"][1])) for w, hw in profile]
		pieces.append(outward(loft(rings)))
		# the through bolt: its hex head on the body's port side, its nut and
		# the thread's end on the starboard side
		back, lift = bolts["place"]
		stand = bolts["span"] / 2 - half
		for sign in (-1, 1):
			base = p(end - back, lift, sign * (half - 0.05))
			out_ = side * sign
			pieces.append(finished(hexagon(base, out_, bolts["size"], stand + 0.05), "chrome"))
			if sign > 0:
				pieces.append(finished(cylinder(base + out_ * ((stand + 0.05) * INCH), base + out_ * ((stand + 0.3) * INCH), bolts["size"] * 0.25, sides=12), "chrome"))
		return pieces

	# the point's aft face set back from the length so the casting's aftmost
	# point lands on the tip's station (the shank climbs, so its aft face's
	# lowest corner, where the shoe leaves it, stands aftmost)
	end = length
	for _ in range(2):
		aftmost = min(v.x for piece in point(end) for v in piece[0])
		end += (aftmost - tip.x) / INCH / math.cos(climb)
	pieces = point(end)
	# the forging at the pivot (layout.hook fitting, fittings): an arm either
	# side of the fitting's lug, round the pin, its outer face under the pin's
	# cap, tapering aft into the web that joins them; the web closing into the
	# socket round the shank's forward end
	reach_ = hook["fitting"]["radius"]
	outer = hook["fitting"]["width"] / 2 - STANDOFF
	inner = outer - fittings["yoke"]
	front, deep = fittings["web"]
	close, socket = fittings["socket"]
	arm = [(reach_ * math.cos(2 * math.pi * k / 24), reach_ * math.sin(2 * math.pi * k / 24)) for k in range(24)] + [(front + 1.4, deep / 2), (front + 1.4, -deep / 2)]
	arm = hull(arm)
	for sign in (1, -1):
		v0, v1 = sorted((sign * inner, sign * outer))
		pieces.append(filleted(chord(arm, v0, v1), 0.3))
		pieces.append(hollow(p(0, 0, sign * outer), side * sign, fittings["pin"]))

	def web_ring(s, inset=0.0):
		# the web's section: across the arms' outer faces, as deep as the web,
		# easing into the socket's round; `inset` in all round where its front
		# rounds in
		t = ease((s - (front + 1.4)) / (close - front - 1.4))
		ring = []
		for k in range(around):
			th = 2 * math.pi * k / around
			c, sn = math.cos(th), math.sin(th)
			x = (outer - 0.15 - inset) * math.copysign(abs(c) ** (2 / 3), c)
			y = (deep / 2 - inset) * math.copysign(abs(sn) ** (2 / 3), sn)
			ring.append(p(s, y + (socket / 2 * sn - y) * t, x + (socket / 2 * c - x) * t))
		return ring

	# its front rounded in over half an inch, a quarter round
	web = [(front + 0.5 - 0.5 * math.cos(math.pi / 2 * k / 4), 0.5 - 0.5 * math.sin(math.pi / 2 * k / 4)) for k in range(4)]
	web += [(front + 0.5 + 0.25 * i, 0.0) for i in range(int(round((close + 1.0 - front - 0.5) / 0.25)) + 1)]
	pieces.append(outward(loft([web_ring(s, inset) for s, inset in web])))
	# the split collar near the shank's top, its clamp's bolt on it
	place, stand, band = fittings["collar"]
	r = diameter(place) / 2 + stand
	pieces.append(filleted(outward(loft([round_ring(place + band / 2 * k, r - (0.12 if k in (-1, 1) else 0.0), 24) for k in (-1, -0.7, 0.7, 1)])), 0.05))
	pieces.append(finished(hexagon(p(place, r - 0.05), up, 0.75, 0.4), "chrome"))
	# the small lug on its top a third of the way along
	share, l, w, h = fittings["tab"]
	s = share * length
	pieces.append(filleted(chord([(s - l / 2, diameter(s) / 2 - 0.2), (s + l / 2, diameter(s) / 2 - 0.2), (s + l / 2 - 0.3, diameter(s) / 2 + h), (s - l / 2 + 0.3, diameter(s) / 2 + h)], -w / 2, w / 2), 0.1))
	# the hold-down damper's clevis on the web's top: two lugs round its pin,
	# the bolt through them
	rod = fittings["rod"]
	eye_length, eye = rod["end"]
	g = p(rod["lug"], diameter(rod["lug"]) / 2 + 0.6)
	gs, gu = rod["lug"], diameter(rod["lug"]) / 2 + 0.6
	lug = hull([(gs + 0.75 * math.cos(2 * math.pi * k / 16), gu + 0.75 * math.sin(2 * math.pi * k / 16)) for k in range(16)] + [(gs - 1.2, gu - 1.4), (gs + 1.2, gu - 1.4)])
	for sign in (1, -1):
		v0, v1 = sorted((sign * (eye / 2 + 0.05), sign * (eye / 2 + 0.4)))
		pieces.append(filleted(chord(lug, v0, v1), 0.08))
		pieces.append(finished(hexagon(p(gs, gu, sign * (eye / 2 + 0.38)), side * sign, 0.75, 0.3), "chrome"))
	hooked = merge(pieces)
	node("hook", parent="hook_swing", hinge=pivot, mesh=hooked, paint="white")
	MARKS["hook_point"] = (tip, "hook")
	MARKS["hook_pivot"] = (pivot, "hook")
	# lowered until the point's lowest corner lies in the direction the
	# photos' does from the pivot (layout.hook lowered): turned aft towards
	# down. Its distance from the pivot, past the stowed tip's, is unsettled
	lowered = at(*hook["lowered"], 0) - pivot
	aim = math.atan2(lowered.z, lowered.x)

	def lowest(turn):
		c, s_ = math.cos(turn), math.sin(turn)
		return min((Vector(((v - pivot).x * c - (v - pivot).z * s_, 0.0, (v - pivot).x * s_ + (v - pivot).z * c)) for v in hooked[0]), key=lambda q: q.z)

	travel = min((math.radians(tenth / 10) for tenth in range(400, 1000)), key=lambda turn: abs(math.atan2(lowest(turn).z, lowest(turn).x) - aim))
	joint("hook", PORT, AFT, DOWN, "hook", [[0, 0], [1, round(travel, 4)]])
	# the hold-down damper: a cylinder turning on its trunnion pin in the keel,
	# its gland nut at its lower end, and a polished piston with its rod end on
	# the clevis's bolt, each kept on the line between the two pins as the hook
	# lowers
	q = at(*rod["top"], 0)
	cylinder_d, piston_d = rod["diameters"]
	above, below = rod["cylinder"]
	towards = (g - q).normalized()
	node("hook_rod", parent="hook_swing", hinge=q, mesh=merge([
		filleted(cylinder(q - towards * (above * INCH), q + towards * ((below - 0.45) * INCH), cylinder_d / 2, sides=16), 0.1),
		cylinder(q + side * (0.9 * INCH), q - side * (0.9 * INCH), 0.5, sides=12),
		hexagon(q + towards * ((below - 0.5) * INCH), towards, cylinder_d + 0.2, 0.5)]), paint="white")
	node("hook_piston", parent="hook", hinge=g, mesh=merge([
		finished(cylinder(g - towards * ((eye_length - 0.1) * INCH), g - towards * ((eye_length + rod["piston"]) * INCH), piston_d / 2, sides=16), "chrome"),
		hexagon(g - towards * ((eye_length - 0.35) * INCH), -towards, piston_d + 0.25, 0.35),
		cylinder(g - towards * (0.3 * INCH), g - towards * ((eye_length - 0.3) * INCH), 0.38, sides=12),
		tube(g - side * (eye / 2 * INCH), g + side * (eye / 2 * INCH), eye / 2, 0.3, sides=16),
		finished(cylinder(g - side * ((eye / 2 + 0.36) * INCH), g + side * ((eye / 2 + 0.36) * INCH), 0.3, sides=12), "chrome")]), paint="white")

	def angle(v):
		# a direction's turn aft towards down, in the plane of the hook's travel
		return math.atan2(-v.z, -v.x)

	def lug_at(turn):
		c, s_ = math.cos(turn), math.sin(turn)
		d = g - pivot
		# turned aft towards down about the pivot (Blender's x forward, z up)
		return pivot + Vector((d.x * c - d.z * s_, d.y, d.x * s_ + d.z * c))

	rest = angle(g - q)
	keys = [i / 16 for i in range(17)]
	turns = [angle(lug_at(travel * k) - q) - rest for k in keys]
	joint("hook_rod", PORT, AFT, DOWN, "hook", [[k, round(t, 4)] for k, t in zip(keys, turns)])
	joint("hook_piston", PORT, AFT, DOWN, "hook", [[k, round(t - travel * k, 4)] for k, t in zip(keys, turns)])


def mechanisms():
	# The arresting hook, the refuelling probe and its door and the
	# speedbrake. Placements are provisional: the hook's pivot is
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

	hook = LAYOUT["hook"]
	pivot = at(*hook["pivot"], 0)
	axis_ = hook["pivot"][0]
	# its aft end, the hook's pivot fitting, turns with the hook's sideways
	# swing about the upright through the pin (tailhook()): the keel stops on an
	# arc round that upright, the fitting starting a seam inside it; the arc
	# clears every point of the yoke's arms ahead of the pin (round it to the
	# fitting's radius, across from the arm's inner face to its outer) that
	# the swing to its stop turns in over the keel's width
	outer = hook["fitting"]["width"] / 2 - STANDOFF
	inner = outer - hook["fittings"]["yoke"]
	swing = math.radians(value(LAYOUT["motion"]["swing"])["travel"])
	reach = hook["fitting"]["radius"]
	arc = max(math.hypot(s, v) for s in np.linspace(-reach, 0.0, 26) for v in np.linspace(inner, outer, 13)
		if v * math.cos(swing) + s * math.sin(swing) < keel["width"] / 2 + SEAM) + 2 * SEAM + 0.05

	def ring(station, onto=None):
		half = max(0.25, keel["width"] / 2 * (station - front) / (back - front))
		b = keel_bottom(station)
		# round from the top toward starboard, as the other lofts go; a ring
		# `onto` an arc has each point moved along to it, the top and bottom
		# edges in steps short enough that the faces between them keep to it
		points = [(top, half * k / 3) for k in range(-3, 4)] + [(b + 1.0, half)] + [(b, 0.6 * half * k / 3) for k in range(3, -4, -1)] + [(b + 1.0, -half)]
		return [at(axis_ - math.sqrt(onto * onto - bl * bl) if onto else station, wl, bl) for wl, bl in points]

	def arced(rings, last):
		# a loft whose end ring (the last, or the first) stands on an arc, closed
		# there by upright strips from each point of its top edge to the point of
		# its bottom edge under it, which keep to the arc, rather than by one
		# face across it
		vertices, faces = loft(rings)
		n = len(rings[0])
		base = (len(rings) - 1) * n if last else 0
		other = 0 if last else (len(rings) - 1) * n
		faces = [f for f in faces if len(f) == 4]
		faces.append(tuple(range(other + n - 1, other - 1, -1)) if last else tuple(range(other, other + n)))
		faces += [(base + k, base + k + 1, base + 13 - k, base + 14 - k) for k in range(6)]
		faces += [(base + 6, base + 7, base + 8), (base, base + 14, base + 15)]
		return vertices, faces

	stop = axis_ - arc
	rings = [ring(front + (stop - front) * i / 20) for i in range(20)] + [ring(stop, onto=arc)]
	fitting = [ring(stop, onto=arc - SEAM / 2)] + [ring(axis_ - arc + 1.0 + (back - (axis_ - arc + 1.0)) * i / 3) for i in range(4)]
	node("keel", mesh=arced(rings, True))
	# the fitting, and between the hook's yoke arms its lug round the pin
	tailhook(pivot, merge([outward(arced(fitting, False)), cylinder(at(hook["pivot"][0], hook["pivot"][1], -inner), at(hook["pivot"][0], hook["pivot"][1], inner), hook["fittings"]["lug"] / 2, sides=20)]))
	# Probe: its door on the upper starboard nose where the photos put the
	# reference airframe's (layout.probe; the research jet's, TM-101724's, ran
	# FS 128.5 to 188), a thin shell on the skin, `proud` off it (layout.probe). The probe lies
	# stowed beneath it, 3.5 in under the skin, and swings out about its root
	# (layout.motion probe pivot, behind the door's aft edge) by the least turn
	# that takes its nozzle to where the photos put it out (layout.motion probe
	# nozzle), as the hook's travel is solved from its photo point. The door
	# rides the probe on the stand-off brackets the photos show, with no joint
	# of its own. The skin is opened ahead of it for the nozzle (layout.probe
	# opening), closed by a door of its own (forward_door())
	door = LAYOUT["probe"]
	start, end, front = door["from"], door["to"], door["opening"]
	upper, lower = math.radians(door["upper"]), math.radians(door["lower"])
	angles = [upper + (lower - upper) * j / 6 for j in range(7)]
	shell = lambda st, th, out: at(st, *reversed(skin(st, th, out)))
	# the shell's outer face off the skin: a loft over the skin's rings, not
	# its facets, over a hole kept up to 0.09 in inside its edges (wells()),
	# so it cannot lie flush; and its aft edge, swinging out with the probe,
	# clears the skin behind it only standing 0.15 in off (at 0.05 it cut
	# through at probe 0.2-0.3). The paint draws its seam dark (rims()), so
	# its edge no longer reads as a light line
	proud = 0.15

	# the seam between the forward door and the probe door: the plane through
	# the forward door's hinge's aft end square to its hinge (its upper edge),
	# in which the forward door's aft edge turns, so it never swings into the
	# probe door beside it; its station at an angle round and an offset off
	# the skin, `short` inches ahead of the plane
	hinge = [shell(front, upper, proud), shell(start, upper, proud)]
	line = (hinge[1] - hinge[0]).normalized()

	def seam(th, out, short=0.0):
		st = start
		for _ in range(3):
			miss = (shell(st, th, out) - hinge[1]).dot(line) / INCH + short
			st -= miss / ((shell(st + 0.1, th, out) - shell(st, th, out)).dot(line) / INCH / 0.1)
		return st

	def panel(a, b, count, head=None, tail=None):
		# a shell on the skin from station a to b, its first or last ring's
		# stations given round it (head, tail: of the angle and the offset)
		stations = [a + (b - a) * i / count for i in range(count + 1)]
		at_ = lambda i, th, out: (head(th, out) if head and i == 0 else tail(th, out) if tail and i == count else stations[i])
		return loft([[shell(at_(i, th, proud), th, proud) for th in angles] + [shell(at_(i, th, -0.1), th, -0.1) for th in reversed(angles)] for i in range(count + 1)]), stations
	shut, stations = panel(start, end, 14, head=seam)
	forward, _ = panel(front, start, 4, tail=lambda th, out: seam(th, out, 0.05))
	motion = LAYOUT["motion"]["probe"]["value"]
	middle = (upper + lower) / 2
	# the stowed probe's line: 3.5 in under the skin at its root and at 3 in
	# behind the door's forward end, as long as reaching the photos' nozzle needs
	root, aim = shell(end + motion["pivot"], middle, -3.5), shell(start + 3, middle, -3.5)
	aim = (aim - root).normalized()
	nozzle, point = at(*motion["nozzle"]), at(*motion["tip"])
	reach = nozzle - root
	stowed = root + aim * reach.length
	axis = aim.cross(reach.normalized())
	turn = math.asin(min(1.0, axis.length))
	if aim.dot(reach) < 0:
		turn = math.pi - turn
	# the nozzle's head, coaxial with the shaft: its collar from 1.5 in behind
	# the ball's centre and its round nose out to the photos' tip, as (inches
	# along from the ball's centre, radius)
	head = (point - nozzle).length / INCH
	tip = stowed + aim * (head * INCH)
	u = aim.orthogonal().normalized()
	v = aim.cross(u)
	profile = [(-1.5, 2.1), (0.0, 2.1), (0.45 * head, 1.95), (0.7 * head, 1.6), (0.88 * head, 1.1), (head, 0.4)]
	rings = [[stowed + aim * (t * INCH) + (u * math.cos(2 * math.pi * i / 16) + v * math.sin(2 * math.pi * i / 16)) * (r * INCH) for i in range(16)] for t, r in profile]
	PROBE[:] = [tip]
	# under the skin behind the door's aft edge, and on to 1.5 in ahead of it,
	# the arm narrows to a neck round its root's pin: the skin over it, and
	# the opening's aft edge the arm's top swings back toward, stand clear
	neck = root + aim * ((motion["pivot"] + 1.5) * INCH)
	arm = merge([cylinder(root, neck, 1.0, sides=12), cylinder(neck, stowed - aim * (1.5 * INCH), 2.2, 1.9, sides=16), loft(rings)])
	# the opening, and the station its well reaches back to: an inch past the
	# probe's root end
	OPENINGS["probe"] = {"shell": (front, end, upper, lower), "back": max(ORIGIN["station"] - q.x / INCH for q in arm[0]) + 1.0}
	node("probe", hinge=root, mesh=arm)
	# it waits while the forward door opens (layout.motion probe forward)
	share = motion["forward"]
	joint("probe", axis, aim, reach - aim * reach.length, "probe", [[0, 0], [share, 0], [1, round(turn, 4)]])
	node("probe_door", parent="probe", mesh=shut)
	middle_ = (front + start) / 2
	forward_door(forward, hinge, shell(middle_, lower, proud) - shell(middle_, upper, proud),
		shell(middle_, upper, proud + 1.0) - shell(middle_, upper, proud), [(arm, 0.3), (shut, 0.0)], root, axis, turn, share)
	# its lower corners, the crispest in a photo
	MARKS["probe_door_front"] = (shell(seam(lower, proud), lower, proud), "probe_door")
	MARKS["probe_door_aft"] = (shell(end, lower, proud), "probe_door")
	CURVES["probe_door"] = ([shell(st, upper, proud) for st in stations] + [shell(end, th, proud) for th in angles[1:]] +
		[shell(st, lower, proud) for st in reversed(stations[1:-1])] + [shell(seam(th, proud), th, proud) for th in reversed(angles)], "probe_door")
	print(f"probe: {reach.length / INCH:.1f} in from its root to the nozzle, turning {math.degrees(turn):.1f} deg; stowed, its tip at FS {ORIGIN['station'] - tip.x / INCH:.1f}")
	speedbrake()


def forward_door(mesh, hinge, across, out, riders, root, axis, turn, share):
	# The probe's forward door (layout.probe opening): the panel over the
	# opening ahead of the probe door, a door of its own hinged along its
	# upper edge, since the nozzle leaves past the lower one (from 26 deg
	# round the section to 52). It opens while the probe waits, its first
	# `share` of the stroke, holds open while the probe's parts pass, and
	# closes behind them over as long again, so it stands closed at rest and
	# with the probe out, as dvids6690145 shows it. Its opening is the least
	# that keeps each part the probe carries (riders: its mesh at rest and how
	# many inches off it to stay; the probe door beside it, which it closes
	# against, only out of it) clear at every share of the probe's turn, and
	# it starts to close once no angle it closes through comes so near again
	a, b = hinge
	line = (b - a).normalized()
	if (Matrix.Rotation(0.1, 3, line) @ across - across).dot(out) < 0:
		line = -line   # a positive turn lifts the lower edge out
	turns = [k / 60 for k in range(61)]

	def turned(vertices, centre, direction, angle):
		R = Matrix.Rotation(angle, 3, direction)
		return [centre + R @ (v - centre) for v in vertices]
	carried = {}
	for f in turns:
		posed = [(turned(r[0], root, axis.normalized(), turn * f), r[1], gap) for r, gap in riders]
		carried[f] = [(BVHTree.FromPolygons(vs, fs), vs, gap) for vs, fs, gap in posed]
	poses = {}

	def touches(angle, f):
		if angle not in poses:
			vs = turned(mesh[0], a, line, angle)
			poses[angle] = (BVHTree.FromPolygons(vs, mesh[1]), vs)
		door, vs = poses[angle]
		for k, (tree, theirs, gap) in enumerate(carried[f]):
			# stowed, the probe lies as close under the door as the wells hold it
			gap = gap if f > 0 else 0.0
			if door.overlap(tree) or (gap and (any(tree.find_nearest(v, gap * INCH)[0] is not None for v in vs) or any(door.find_nearest(v, gap * INCH)[0] is not None for v in theirs))):
				return k + 1
		return 0
	angles = [math.radians(d) for d in range(0, 152, 2)]
	opening = next((x for x in angles[1:] if not any(touches(x, f) for f in turns)), None)
	if opening is None:
		raise SystemExit("probe's forward door: no opening up to 150 deg clears the probe through its turn")
	through = [x for x in angles if x <= opening]
	met = [(round(math.degrees(x)), touches(x, 0.0)) for x in through[1:] if touches(x, 0.0)]
	if met:
		raise SystemExit(f"probe's forward door: it meets the stowed probe's parts as it opens (deg, part): {met[:6]}, opening {math.degrees(opening):.0f}")
	# the least share of the turn from which on no angle it closes through
	# comes near the probe's parts
	bad = [f for f in turns if any(touches(x, f) for x in through)]
	clear = next((f for f in turns if not bad or f > max(bad)), None)
	if clear is None:
		raise SystemExit("probe's forward door: the probe out stands in its way")
	shut = share + clear * (1 - share)   # the stroke's share where it starts to close
	done = min(1.0, shut + share)
	if done - shut < 0.02:
		raise SystemExit(f"probe's forward door: no time to close, the probe clear only at {clear:.2f} of its turn")
	ramp = LAYOUT["motion"]["stroke"]["value"]["ramp"]
	inputs = [k / 480 for k in range(481)]

	def angle_at(x):
		if x <= share:
			return opening * stroked(x / share, ramp)
		if x <= shut:
			return opening
		if x <= done:
			return opening * (1 - stroked((x - shut) / (done - shut), ramp))
		return 0.0
	node("probe_door_forward", hinge=a, mesh=mesh)
	joint("probe_door_forward", line, across, out, "probe", [[x, round(y, 4)] for x, y in thinned([(x, angle_at(x)) for x in inputs], KEYED["rotate"])])
	print(f"probe's forward door: opens {math.degrees(opening):.0f} deg over the stroke's first {share:.2f}, starts to close at {shut:.2f}",
		f"(the probe clear at {clear:.2f} of its turn), shut by {done:.2f}")


def pivot(a, b, angle):
	# The point (x, z) about which a turn of `angle` aft toward up (x forward,
	# z up: a vector pointing aft turns toward up) takes the point a to b
	middle = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
	chord = (b[0] - a[0], b[1] - a[1])
	length = math.hypot(*chord)
	reach = length / 2 / math.tan(angle / 2)
	c, s = math.cos(angle), math.sin(angle)

	def miss(p):
		v = (a[0] - p[0], a[1] - p[1])
		return math.hypot(v[0] * c + v[1] * s + p[0] - b[0], -v[0] * s + v[1] * c + p[1] - b[1])
	return min(((middle[0] - k * chord[1] / length * reach, middle[1] + k * chord[0] / length * reach) for k in (1, -1)), key=miss)


def speedbrake():
	# The dorsal panel between the fins (layout.speedbrake), cut from the
	# spine's skin. Open (tp209033's 60 deg) it stands where the photos put it:
	# its turn takes its closed aft corner onto the photos' about the point
	# that solves, as the hook's travel is solved from its photo point. The
	# photos show nothing at that point and no hinge at the panel's forward
	# edge, which stands 8-10 in off the spine: under the panel only a narrow
	# member painted like it, almost upright on the centreline, and beside it
	# a dark hose rising to it (layout.speedbrake mechanism). The member is
	# built as the actuator: a cylinder turning about its foot's pin in the
	# well and two stages sliding out of it to a lug under the panel, each
	# keyed as finely as its own motion needs, so the stages' end stays on the
	# lug; the hose rides the cylinder from the well to its side
	sb = LAYOUT["speedbrake"]
	front, back, half = sb["front"], sb["back"], sb["half"]
	mech = sb["mechanism"]
	skin_tree = built(["fuselage"])
	turn = math.radians(FACTS["surfaces"]["limits"]["speedbrake"]["up"])
	# a turn of `angle` aft toward up about PORT, in the plane of the
	# stations and waterlines: (x, z) of a point relative to the turn's centre
	rotated = lambda v, angle: Vector((v.x * math.cos(angle) + v.z * math.sin(angle), v.y, -v.x * math.sin(angle) + v.z * math.cos(angle)))
	closed, opened_ = draped(skin_tree, back, half, out=0.15), at(*sb["open"]["aft"])
	x, z = pivot(closed.xz, opened_.xz, turn)
	pole = Vector((x, 0.0, z))
	mesh = cut((front, back), (-half, half))
	OPENINGS["speedbrake"] = {"below": False, "pieces": [[[front, -half], [back, -half], [back, half], [front, half]]]}
	# the lug under the panel near its aft end, carrying the actuator's eye
	act = mech["actuator"]
	foot = at(act["foot"][0], act["foot"][1], 0)
	lug_station, below = act["lug"]
	# the panel's inner face lies a tenth under the skin (cut()): the pin
	# `below` under it, the lug a plate on the centreline from inside the
	# panel down round the pin
	eye = draped(skin_tree, lug_station, 0, out=-0.1) - UP * (below * INCH)
	tops = [draped(skin_tree, lug_station + k, 0, out=-0.05) for k in (-1.2, 1.2)]
	plate = [tops[0], tops[1], eye + AFT * (1.0 * INCH), eye + FORWARD * (1.0 * INCH)]
	lug = merge([loft([[q + PORT * (k * 0.2 * INCH) for q in plate] for k in (1, -1)]), cylinder(eye + PORT * (0.2 * INCH), eye - PORT * (0.2 * INCH), 1.0, sides=12)])
	node("speedbrake", hinge=pole, mesh=mesh)
	joint("speedbrake", PORT, AFT, UP, "speedbrake", [[0, 0], [1, round(turn, 4)]])
	node("speedbrake_lug", parent="speedbrake", mesh=lug)
	# the actuator's aim and reach through the stroke, sampled finely
	inputs = [k / 240 for k in range(241)]
	eyes = [rotated(eye - pole, turn * x) + pole for x in inputs]
	u0 = (eyes[0] - foot).normalized()
	aims = [math.atan2(u0.z * (e - foot).normalized().x - u0.x * (e - foot).normalized().z, u0.dot((e - foot).normalized())) for e in eyes]
	reaches = [(e - foot).length for e in eyes]
	tube, stages = act["diameters"], act["stages"]
	least, most = reaches[0] / INCH, max(reaches) / INCH
	stroke = (most - least) / stages
	end = 2.5   # in: the last stage's rod end, from its tube to its eye
	length = least - 1.0 - 0.5 * stages - end   # each tube, nested between the foot's boss and the rod end
	if length - stroke < act["overlap"]:
		raise SystemExit(f"speedbrake actuator: {stages} stages of {length:.1f} in overlap by {length - stroke:.1f} in at full stretch")
	print(f"speedbrake: turning {math.degrees(turn):.1f} deg about FS {ORIGIN['station'] - pole.x / INCH:.1f}, WL {pole.z / INCH + ORIGIN['waterline']:.1f};",
		f"the actuator {least:.1f} to {most:.1f} in pin to pin, {stages} stages of {length:.1f} in, each sliding {stroke:.1f}")
	ring = lambda d: cylinder(foot + PORT * (d / 2 * INCH), foot - PORT * (d / 2 * INCH), 1.1, sides=12)
	cylinder_ = merge([cylinder(foot + u0 * (1.0 * INCH), foot + u0 * ((1.0 + length) * INCH), tube[0] / 2, sides=16), ring(tube[0])])
	node("speedbrake_actuator", hinge=foot, mesh=cylinder_)
	joint("speedbrake_actuator", PORT, AFT, UP, "speedbrake", [[x, round(y, 4)] for x, y in thinned(list(zip(inputs, aims)), KEYED["rotate"])])
	names = ("middle", "inner")
	if stages != len(names):
		raise SystemExit(f"speedbrake actuator: built with {len(names)} stages, not {stages}")
	parent, start = "speedbrake_actuator", 1.0
	for k, stage in enumerate(names):
		name = f"speedbrake_actuator_{stage}"
		start += 0.5
		last = k == stages - 1
		if last:
			start = least - end - length
		pieces = [cylinder(foot + u0 * (start * INCH), foot + u0 * ((start + length) * INCH), tube[k + 1] / 2, sides=16)]
		if last:
			# its rod end: a fork straddling the lug's plate, round its pin
			pieces.append(cylinder(foot + u0 * ((least - end) * INCH), eyes[0], 0.6, sides=10))
			pieces += [cylinder(eyes[0] + PORT * (sign * 0.25 * INCH), eyes[0] + PORT * (sign * 0.75 * INCH), 1.1, sides=12) for sign in (1, -1)]
		node(name, parent=parent, hinge=foot, mesh=merge(pieces))
		share = [(x, (r - reaches[0]) / stages) for x, r in zip(inputs, reaches)]
		joint(name, u0, u0, u0, "speedbrake", [[x, round(y, 5)] for x, y in thinned(share, KEYED["slide"])], motion="slide")
		parent = name
	# the hose: from the well up the cylinder's side, at its place in the
	# photos with the panel open, riding the cylinder
	hose = mech["hose"]
	aim = aims[-1]
	back_ = lambda p: rotated(p - foot, -aim) + foot
	base, top = back_(at(*hose["base"])), back_(at(*hose["top"]))
	split = base.lerp(top, hose["fitting"] / ((top - base).length / INCH))
	node("speedbrake_hose", parent="speedbrake_actuator", hinge=foot, mesh=merge([cylinder(base, split, hose["diameters"][0] / 2, sides=12),
		cylinder(split, top, hose["diameters"][1] / 2, sides=10)]), paint="hub")


def bay_roof(station):
	# The main gear's bay's roof at a station: under the inlet duct's lowest
	# point over the bay's plan by layout.wells roof, the duct's floor being
	# the bay's ceiling (duct_ring(), round every other point as built there)
	lo, hi = LAYOUT["wells"]["main"][0][2:4]
	return min(w for _, w, b in duct_ring(station, 2) if lo <= b <= hi) - LAYOUT["wells"]["roof"][0]


def wells():
	# The wells behind the openings (layout.wells): each main gear's bay, the
	# nose gear's, the speedbrake's and the probe's, a box of walls and a roof
	# standing on the closed skin (the main bays' under the inlet ducts,
	# bay_roof(), sloping with them and stationed at their rings); then each
	# opening cut from the skin, the faces cut() copied for each door, so a
	# closed door fills its own hole. Every material is two-sided, so the
	# skin's inside shows where a well reaches past its opening. check.py
	# holds every face inside the airframe
	w = LAYOUT["wells"]
	tree = built(["fuselage"])
	rows, across = 8, 8
	# the skin as built, for its sections at the end walls' stations
	skin_ = NODES["fuselage"].data
	corners_ = [v.co + HINGES["fuselage"] for v in skin_.vertices]
	faces_ = [(list(f.vertices), f.normal.copy()) for f in skin_.polygons]

	def height(station, buttline, below):
		# the skin's waterline at a station and buttline, its lower surface
		# seen from below or its upper from above
		hit = tree.ray_cast(at(station, -100.0 if below else 300.0, buttline), UP if below else DOWN)[0]
		if hit is None:
			raise SystemExit(f"wells: no skin at FS {station:.1f}, BL {buttline:.1f}")
		return hit.z / INCH + ORIGIN["waterline"]

	def foot(station, buttline, below):
		# where a wall meets the skin: its foot UNDER/2 inside it along the
		# skin's normal, as a door's edge band is split (cut()), and the point
		# UNDER inside it, as a cut panel's inner face lies: the band between
		# in the airframe's paint, the well's own finish only inside it. A
		# white foot's straight run between stations passed in and out of the
		# skin's facets and showed through in dashes; a foot on the skin
		# itself, its run standing up to 0.012 in out of the tunnel's hollow
		# between the nacelles and level with it elsewhere, drew there in dots
		ray = UP if below else DOWN
		hit, normal = tree.ray_cast(at(station, -100.0 if below else 300.0, buttline), ray)[:2]
		if hit is None:
			raise SystemExit(f"wells: no skin at FS {station:.1f}, BL {buttline:.1f}")
		inward = -normal if normal.dot(ray) < 0 else normal
		return hit + inward * (UNDER / 2 * INCH), hit + inward * (UNDER * INCH)

	def column(station, buttline, below, top):
		# a wall from its foot under the skin, by its band, to the roof
		hit, start = foot(station, buttline, below)
		end = at(station, top, buttline)
		return [hit] + [start.lerp(end, k / rows) for k in range(rows + 1)]

	def section(station, segment, below, depth):
		# a ring round the well's section: up the low wall, across the roof,
		# down the high wall; its two ends on the skin, the next two UNDER
		# inside it
		_, _, lo, hi, roof = segment
		if depth:
			top = lambda bl: height(station, bl, below) - depth
		elif roof is None:
			# under the duct, and never less than layout.wells roof's least
			# over the skin, which rises at the bay's outboard edge
			roof, least = bay_roof(station), LAYOUT["wells"]["roof"][1]
			top = lambda bl: max(roof, height(station, bl, below) + least)
		else:
			top = lambda bl: roof
		low = column(station, lo, below, top(lo))
		high = column(station, hi, below, top(hi))
		roof_ = [at(station, top(lo + (hi - lo) * j / across), lo + (hi - lo) * j / across) for j in range(1, across)]
		return low + roof_ + list(reversed(high))

	def bottom(station, start, end, centre):
		# the skin across a section from one wall's foot to another's, ends
		# left out: each point on it, and UNDER inside it. Walked along the
		# built skin's own section at the station, corner by corner, the
		# shorter way round: points sampled across it, by rays up (or down)
		# each buttline or from inside the well, joined by chords that stood
		# out of the skin wherever it tucks in or turns into a corner
		x = start.x
		segments = []
		for vertices, normal in faces_:
			# its corners on the plane, and where its edges cross it, each
			# edge read from its lower vertex, so the two faces sharing it
			# cut it at the very same point
			cut = [corners_[i].copy() for i in vertices if corners_[i].x == x]
			for i, j in zip(vertices, vertices[1:] + vertices[:1]):
				i, j = min(i, j), max(i, j)
				p, q = corners_[i], corners_[j]
				if (p.x - x) * (q.x - x) < 0:
					cut.append(p.lerp(q, (x - p.x) / (q.x - p.x)))
			if len(cut) == 2 and (cut[0] - cut[1]).length > 1e-9:
				segments.append((cut[0], cut[1], normal))
		key = lambda v: (round(v.y, 6), round(v.z, 6))
		graph, place, normals = {}, {}, {}
		for p, q, normal in segments:
			for a, b in ((p, q), (q, p)):
				graph.setdefault(key(a), []).append((key(b), (a - b).length))
				place[key(a)] = a
				normals.setdefault(key(a), []).append(normal)
		if not graph:
			raise SystemExit(f"wells: no skin across FS {station:.1f}")
		# where two lofts meet without sharing vertices the section breaks;
		# each loose end joins the nearest other within a twentieth of an inch
		loose = [k for k, links in graph.items() if len(links) == 1]
		for k in loose:
			others = [o for o in loose if o != k and o not in {l for l, _ in graph[k]}]
			if others:
				o = min(others, key=lambda o: (place[o] - place[k]).length)
				gap = (place[o] - place[k]).length
				if gap < 0.05 * INCH:
					graph[k].append((o, gap))
					graph[o].append((k, gap))
		near = lambda v: min(place, key=lambda k: (place[k] - v).length)
		source, target = near(start), near(end)
		# the shortest way along the section between them
		distance, back, frontier = {source: 0.0}, {}, [(0.0, source)]
		while frontier:
			d, k = heapq.heappop(frontier)
			if k == target:
				break
			if d > distance.get(k, math.inf):
				continue
			for other, length in graph[k]:
				if d + length < distance.get(other, math.inf):
					distance[other], back[other] = d + length, k
					heapq.heappush(frontier, (d + length, other))
		if target not in distance:
			raise SystemExit(f"wells: the skin's section at FS {station:.1f} does not join the walls' feet")
		path = [target]
		while path[-1] != source:
			path.append(back[path[-1]])
		path.reverse()
		points = []
		for k in path:
			on = place[k]
			if min((on - start).length, (on - end).length) < 0.05 * INCH:
				continue
			# inward along the faces' normals, kept in the end wall's plane
			n = sum(normals[k], Vector())
			n.x = 0.0
			inward = -n.normalized() if n.dot(centre - on) < 0 else n.normalized()
			points.append((on + inward * (UNDER / 2 * INCH), on + inward * (UNDER * INCH)))
		return points

	def cap(station, ring, inner, below):
		# a section's end wall, less the smaller section it opens into, and
		# its band along the skin in the paint: (points, [(face, finish)])
		centre = sum(ring, Vector()) / len(ring)
		if inner is None:
			edge = [(ring[-1], ring[-2])] + bottom(station, ring[-1], ring[0], centre) + [(ring[0], ring[1])]
			outline = ring[1:-1] + [q for _, q in edge[1:-1]]
			bands = [edge]
		else:
			right = [(ring[-1], ring[-2])] + bottom(station, ring[-1], inner[-1], centre) + [(inner[-1], inner[-2])]
			left = [(inner[0], inner[1])] + bottom(station, inner[0], ring[0], centre) + [(ring[0], ring[1])]
			outline = ring[1:-1] + [q for _, q in right[1:-1]] + list(reversed(inner[1:-1])) + [q for _, q in left[1:-1]]
			bands = [right, left]
		points = list(outline)
		# one face, split later (mended()) so no triangle lies along its straight
		# runs, as a fill fanning from one end of a run lays them
		faces = [(tuple(range(len(outline))), None)]
		for band in bands:
			base = len(points)
			for on, under in band:
				points += [on, under]
			faces += [((base + 2 * k, base + 2 * k + 2, base + 2 * k + 3, base + 2 * k + 1), "paint") for k in range(len(band) - 1)]
		return points, faces

	def box(segments, below, depth=0.0):
		# the well's walls, roof and end walls over its segments ([FS from, FS
		# to, BL low, BL high, roof WL]), each opening into the next, the
		# larger's end wall round the smaller
		vertices, faces, finishes = [], [], []

		def add(points, polys):
			base = len(vertices)
			vertices.extend(points)
			for f, finish in polys:
				faces.append(tuple(base + i for i in f))
				finishes.append(finish)

		rings = []
		for segment in segments:
			f0, f1 = segment[0], segment[1]
			n = max(2, math.ceil((f1 - f0) / 2.0))
			stations = [f0 + (f1 - f0) * i / n for i in range(n + 1)]
			if segment[4] is None:
				# under the duct: a section at each of its rings, the roof
				# between them running as its floor does
				stations = [f0] + [st for st in duct_stations()[1] if f0 + 0.5 < st < f1 - 0.5] + [f1]
			strip = [section(st, segment, below, depth) for st in stations]
			m = len(strip[0])
			for a, b in zip(strip, strip[1:]):
				add(a + b, [((j, j + 1, m + j + 1, m + j), "paint" if j in (0, m - 2) else None) for j in range(m - 1)])
			rings.append(strip)
		add(*cap(segments[0][0], rings[0][0], None, below))
		add(*cap(segments[-1][1], rings[-1][-1], None, below))
		within = lambda inner, outer: outer[2] <= inner[2] and inner[3] <= outer[3] and (inner[4] <= outer[4] if below else inner[4] >= outer[4])
		for (a, b), (ra, rb) in zip(zip(segments, segments[1:]), zip(rings, rings[1:])):
			if within(b, a):
				add(*cap(a[1], ra[-1], rb[0], below))
			elif within(a, b):
				add(*cap(a[1], rb[0], ra[-1], below))
			else:
				raise SystemExit(f"wells: the sections either side of FS {a[1]} do not nest")
		return vertices, faces, finishes

	def holds(segments, outline, name):
		# every corner of the opening lies within the well's plan
		for f, b in outline:
			if not any(sg[0] - 0.05 <= f <= sg[1] + 0.05 and sg[2] - 0.05 <= b <= sg[3] + 0.05 for sg in segments):
				raise SystemExit(f"wells: {name}'s opening corner FS {f:.2f}, BL {b:.2f} lies outside its well")

	built_ = {}
	for side in (-1, 1):
		name = f"main_{side_name(side)}"
		segments = [[f0, f1, lo, hi, None] if side > 0 else [f0, f1, -hi, -lo, None] for f0, f1, lo, hi in w["main"]]
		built_[name] = (segments, True, 0.0)
	built_["nose"] = (w["nose"], True, 0.0)
	built_["speedbrake"] = (w["speedbrake"]["segments"], False, w["speedbrake"]["depth"])
	for name, (segments, below, depth) in built_.items():
		for piece in OPENINGS[name]["pieces"]:
			holds(segments, piece, name)
		node(f"well_{name}", mesh=box(segments, below, depth), paint="paint" if name == "speedbrake" else "white", inside=True)
	# the probe's: a trough under its door, the skin's own section moved in,
	# starting a tenth of an inch under the skin and as far past the door's
	# edges, so its top lies hidden under the rim of the hole, and on back
	# under the skin past the probe's root
	start, end, upper, lower = OPENINGS["probe"]["shell"]
	depth = w["probe"]["depth"]
	shell = lambda st, th, out: at(st, *reversed(skin(st, th, out)))
	over = 0.1
	reach = lambda st: over / math.hypot(*(a - b for a, b in zip(skin(st, (upper + lower) / 2), half_ring(st)[0])))
	start, end = start - over, max(end + over, OPENINGS["probe"]["back"])
	stations = [start + (end - start) * i / 14 for i in range(15)]
	rings = []
	for st in stations:
		top, bottom = upper - reach(st), lower + reach(st)
		angles = [top + (bottom - top) * j / 6 for j in range(7)]
		rings.append([shell(st, top, -over - (depth - over) * k / 4) for k in range(5)] + [shell(st, th, -depth) for th in angles[1:-1]] +
			[shell(st, bottom, -over - (depth - over) * k / 4) for k in range(4, -1, -1)])
	vertices, faces = [v for r in rings for v in r], []
	m = len(rings[0])
	for i in range(len(rings) - 1):
		faces += [(i * m + j, i * m + j + 1, (i + 1) * m + j + 1, (i + 1) * m + j) for j in range(m - 1)]
	for ring, st in ((rings[0], start), (rings[-1], end)):
		top, bottom = upper - reach(st), lower + reach(st)
		outline = ring + [shell(st, top + (bottom - top) * j / 6, -over) for j in range(5, 0, -1)]
		base = len(vertices)
		vertices += outline
		faces.append(tuple(range(base, base + len(outline))))
	node("well_probe", mesh=(vertices, faces), inside=True)
	opened()


def straight(loop, tolerance=math.radians(0.1)):
	# whether a face's corner turns less than the tolerance from a straight
	# line between its neighbours: a point a cut or a band left on an edge of
	# a face it did not cut. Judged by the turn, not by the distance off the
	# line, as the vertex normal weights each corner by its angle
	a, b, c = loop.link_loop_prev.vert.co, loop.vert.co, loop.link_loop_next.vert.co
	return (b - a).length > 0 and (c - b).length > 0 and (b - a).angle(c - b) < tolerance


def opened():
	# Cuts each opening from the fuselage's skin: for a door cut from the skin
	# (cut()), the faces inside its plan outline on its side, split along the
	# outline's planes as cut() split them; for the probe's, the faces inside
	# its door's stations and angles, split along the planes through its
	# edges' ends and the section's centre
	UNCUT["fuselage"] = built(["fuselage"])
	obj = NODES["fuselage"]
	bm = bmesh.new()
	bm.from_mesh(obj.data)
	bmesh.ops.translate(bm, verts=bm.verts, vec=HINGES["fuselage"])

	def split(planes, facing, near, least=0.3):
		# a corner within a hundred-thousandth of a metre of a plane is taken
		# as on it, where a new point beside it would leave an edge of no
		# length, whose triangles have no normal
		for point, normal in planes:
			bm.normal_update()
			faces = [f for f in bm.faces if f.normal.dot(facing) > 0 and near(f)]
			geom = faces + list({e for f in faces for e in f.edges}) + list({v for f in faces for v in f.verts})
			bmesh.ops.bisect_plane(bm, geom=geom, dist=1e-5, plane_co=point, plane_no=normal)
		bm.normal_update()
		gone = [f for f in bm.faces if f.normal.dot(facing) >= least and near(f) and all((f.calc_center_median() - p).dot(n) < 0 for p, n in planes)]
		bmesh.ops.delete(bm, geom=gone, context="FACES")
		return len(gone)

	removed = {}
	for name, o in OPENINGS.items():
		if "pieces" in o:
			facing = DOWN if o["below"] else UP
			least_ = o.get("least", [])
			least_ = least_ + [0.3] * (len(o["pieces"]) - len(least_))   # pieces added past the doors take the default
			for piece, least in zip(o["pieces"], least_):
				corners = [at(f, 0, b) for f, b in piece]
				x0, x1 = min(c.x for c in corners) - 0.02, max(c.x for c in corners) + 0.02
				y0, y1 = min(c.y for c in corners) - 0.02, max(c.y for c in corners) + 0.02
				near = lambda f: max(v.co.x for v in f.verts) >= x0 and min(v.co.x for v in f.verts) <= x1 and max(v.co.y for v in f.verts) >= y0 and min(v.co.y for v in f.verts) <= y1
				removed[name] = removed.get(name, 0) + split(sides(piece), facing, near, least)
		else:
			# in six pieces along the stations, each edge a plane through its
			# ends and the section's centre, moved in by as far as the door's
			# curved edge strays from it there, so the hole never reaches past
			# the closed door
			start, end, upper, lower = o["shell"]
			shell = lambda st, th: at(st, *reversed(skin(st, th, 0.0)))
			cuts = [start + (end - start) * i / 6 for i in range(7)]
			worst, removed[name] = 0.0, 0
			for s0, s1 in zip(cuts, cuts[1:]):
				middle = (s0 + s1) / 2
				centre = half_ring(middle)[0]
				axis = at(middle, centre[1], centre[0])
				planes = [(at(s0, 0, 0), FORWARD), (at(s1, 0, 0), AFT)]
				for th, other in ((upper, lower), (lower, upper)):
					a, b = shell(s0, th), shell(s1, th)
					normal = (b - a).cross(axis - a).normalized()
					if normal.dot(shell(middle, other) - a) > 0:
						normal = -normal
					stray = max(abs((shell(s0 + (s1 - s0) * i / 8, th) - a).dot(normal)) for i in range(9))
					planes.append((a - normal * stray, normal))
					worst = max(worst, stray / INCH)
				outward = (shell(middle, (upper + lower) / 2) - axis).normalized()
				lo, hi = at(s1 + 1, 0, 0).x, at(s0 - 1, 0, 0).x
				# a face reaching into the piece's stations, however far its middle
				# lies (the loft's rings stand 3 in apart): one straddling a piece's
				# end is split there and its part inside cut away, never left as a
				# strip of skin across the hole
				near = lambda f, lo=lo, hi=hi: max(v.co.x for v in f.verts) >= lo and min(v.co.x for v in f.verts) <= hi and f.calc_center_median().y < 0
				removed[name] += split(planes, outward, near)
			print(f"wells: the probe door's edges stray from their planes by {worst:.3f} in at most, the hole kept inside them")
	# the cuts' slivers of no area, whose normals no facing test can read:
	# where two pieces' cuts meet at a shared corner, an edge of no length
	# first, collapsed to a point (it leaves a facet with two corners in one
	# place, whose triangle no atlas can unfold); then faces of no area
	shared = [at(f, 0, b) for o in OPENINGS.values() for piece in o.get("pieces", []) for f, b in piece]

	def at_corner(e):
		m = (e.verts[0].co + e.verts[1].co) / 2
		return any(math.hypot(m.x - c.x, m.y - c.y) < 0.05 * INCH for c in shared)
	bmesh.ops.collapse(bm, edges=[e for e in bm.edges if e.calc_length() < 1e-6 and at_corner(e)], uvs=False)
	bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.calc_area() < 1e-10], context="FACES_ONLY")
	bmesh.ops.translate(bm, verts=bm.verts, vec=-HINGES["fuselage"])
	bm.to_mesh(obj.data)
	bm.free()
	obj.data.update()
	print("wells: skin faces cut away:", json.dumps(removed))


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


def sides(outline):
	# A convex plan outline's ([FS, BL] corners) edges, each as its vertical
	# plane (a point, its normal pointing away from the middle)
	corners = [at(f, 0, bl) for f, bl in outline]
	middle = sum(corners, Vector()) / len(corners)
	planes = []
	for c0, c1 in zip(corners, corners[1:] + corners[:1]):
		normal = (c1 - c0).cross(UP).normalized()
		if normal.dot(c0 - middle) < 0:
			normal = -normal
		planes.append((c0, normal))
	return planes


UNDER = 0.1   # how far a cut panel's inner face, or a well's wall's foot, lies inside the skin, in


def cut(stations, buttlines, below=False, proud=0.0, under=UNDER, outline=None, inside=None, seams=(), least=0.3):
	# A thin panel cut from the built fuselage's own skin between two
	# stations and two buttlines, or inside a convex plan `outline` of
	# [FS, BL] corners, on its top or its bottom: its outer face `proud` off
	# every facet (on them: wells() cuts the skin under it away along the
	# same planes, so it closes the hole flush, as the real doors do; stood
	# 0.15 in off, its edge was a step whose side the viewer's lamp lit as a
	# light line round every closed door), its inner `under` beneath, its edges closed, but for those
	# along `seams` ([FS, BL] pairs), where another panel of the same part
	# goes on; with `inside`, its inner face and its edges below the skin in
	# that finish, the band of its edges standing proud of the skin in the
	# outer face's. It takes the skin's facets turned to its side by at least
	# `least` (the cosine of their slope)
	bm = bmesh.new()
	bm.from_mesh(NODES["fuselage"].data)
	bmesh.ops.translate(bm, verts=bm.verts, vec=HINGES["fuselage"])
	if outline is None:
		(front, back), ys = stations, sorted(-b * INCH for b in buttlines)
		planes = ((at(front, 0, 0), FORWARD), (at(back, 0, 0), AFT), (Vector((0, ys[1], 0)), PORT), (Vector((0, ys[0], 0)), -PORT))
	else:
		planes = sides(outline)
	for point, normal in planes:
		bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=point, plane_no=normal, clear_outer=True)
	# a plane through the skin's own vertices (the centreline seam) leaves
	# slivers of no area, whose normals no facing test can read
	bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.calc_area() < 1e-10], context="FACES_ONLY")
	bm.normal_update()
	facing = DOWN if below else UP
	bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.normal.dot(facing) < least], context="FACES")
	# a sliver a cut left (an edge shorter than a twentieth of an inch, or a
	# triangle narrower than a fiftieth across its longest edge), which
	# moving the corners out along their normals can turn inside out; in
	# triangles, as the model is exported
	bmesh.ops.triangulate(bm, faces=bm.faces[:])
	bmesh.ops.dissolve_degenerate(bm, edges=bm.edges[:], dist=0.05 * INCH)
	bmesh.ops.triangulate(bm, faces=bm.faces[:])
	bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.calc_area() < 1e-10 or 2 * f.calc_area() / max(e.calc_length() for e in f.edges) < 0.02 * INCH], context="FACES_ONLY")
	bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
	bm.normal_update()
	index = {v: i for i, v in enumerate(bm.verts)}
	n = len(index)
	vertices = [v.co + v.normal * (proud * INCH) for v in bm.verts] + [v.co - v.normal * (under * INCH) for v in bm.verts]
	faces = [tuple(index[v] for v in f.verts) for f in bm.faces]
	faces += [tuple(n + index[v] for v in reversed(f.verts)) for f in bm.faces]
	outer = len(bm.faces)

	def seam(e):
		# an edge lying along one of the seams, in plan
		m = (e.verts[0].co + e.verts[1].co) / 2
		f, b = ORIGIN["station"] - m.x / INCH, -m.y / INCH
		for (f0, b0), (f1, b1) in seams:
			dx, dy = f1 - f0, b1 - b0
			k = max(0.0, min(1.0, ((f - f0) * dx + (b - b0) * dy) / (dx * dx + dy * dy)))
			if math.hypot(f - f0 - dx * k, b - b0 - dy * k) < 0.01:
				return True
		return False
	# with an inside finish, each edge split on a ring of corners half its
	# depth under the skin: in the outer finish down past the hole's rim, so
	# the inside's never shows on the rim itself
	finishes = [None] * outer + [inside] * outer
	level = {}
	for e in bm.edges:
		if len(e.link_faces) == 1 and not seam(e):
			a, b = (index[v] for v in e.verts)
			SEAMS.append((np.array(vertices[a]), np.array(vertices[b])))
			if not inside:
				faces.append((a, b, n + b, n + a))
				continue
			for v in e.verts:
				if v not in level:
					level[v] = len(vertices)
					vertices.append(v.co - v.normal * (under / 2 * INCH))
			c, d = (level[v] for v in e.verts)
			faces += [(a, b, d, c), (c, d, n + b, n + a)]
			finishes += [None, inside]
	bm.free()
	if inside:
		return vertices, faces, finishes
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


def patch(station, theta, outline, out):
	# Points laid on the fuselage's skin round a point on it: `outline`
	# [(along the stations, round the section)] in inches from that point,
	# each moved `out` inches off the skin
	centre, _ = half_ring(station)
	bl, wl = skin(station, theta)
	reach = math.hypot(bl, wl - centre[1])
	return [on_skin(station + a, theta + r / reach, out) for a, r in outline]


def turned(start, axis, profile, sides=16):
	# A closed body of revolution from `start` along `axis`: its profile
	# [(inches along the axis, radius in inches)]
	axis = axis.normalized()
	u = axis.orthogonal().normalized()
	v = axis.cross(u)
	return loft([[start + axis * (d * INCH) + (u * math.cos(2 * math.pi * i / sides) + v * math.sin(2 * math.pi * i / sides)) * (r * INCH)
		for i in range(sides)] for d, r in profile])


def blade(root, foot, thickness):
	# A strut of symmetric sections (the NACA 65A form) from its root's chord
	# to its foot's, each a (leading, trailing) pair of points, `thickness`
	# [root, foot] inches through at their thickest
	span = (foot[0] + foot[1] - root[0] - root[1]) / 2
	rings = []
	for (lead, trail), t in zip((root, foot), thickness):
		chord = trail - lead
		across = chord.cross(span).normalized() * chord.length
		form = airfoil(100 * t * INCH / chord.length)
		upper = [lead + chord * x + across * y for x, y in form]
		lower = [lead + chord * x - across * y for x, y in reversed(form[1:])]
		rings.append(upper + (lower[1:] if form[-1][1] == 0 else lower))
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
		# angle-of-attack probe: a round plate laid on the skin, its rim a dark
		# sealant seam, and the probe standing straight out of it, polished
		# metal: a flat flange on the plate, then the probe tapering the whole
		# way out (the photos' profile) to a rounded blunt tip
		theta = surface_angle(aoa["station"], aoa["waterline"], side)
		base = on_skin(aoa["station"], theta)
		out = (on_skin(aoa["station"], theta, 1.0) - base).normalized()

		def circle(radius, around=24):
			return [(radius * math.cos(2 * math.pi * i / around), radius * math.sin(2 * math.pi * i / around)) for i in range(around)]

		edge, rim = aoa["plate"] / 2, aoa["rim"]
		width, thick = aoa["flange"]
		hole = width / 2
		# the plate's face, from its seam in under the flange's foot (short of
		# its wall: a ring on the wall left the cull of hidden faces to take
		# the flange's foot unevenly), and the seam, its wall from inside the
		# skin and its ring: each an open band, the seam's inner ring 0.002 in
		# outside the plate's, past tidy()'s weld, so each takes an island of
		# its own. Lofted closed, each laid a disc on the plate's face and the
		# three fought there in shards; joined, the seam's 0.25 in shared the
		# plate's edge texels and painted rubber into them in scallops
		plate = band([patch(aoa["station"], theta, circle(r), FLUSH) for r in (edge - rim, edge * 0.75, edge * 0.5, hole * 0.8)])
		seam = finished(band([patch(aoa["station"], theta, circle(r), o) for r, o in ((edge, -0.05), (edge, FLUSH), (edge - rim + 0.002, FLUSH))]), "rubber")
		# the probe's profile from the plate's face: the flange, its foot
		# sunk 0.05 in into the plate's body, clear of the disc closing it
		# (0.02 left them 0.004 in apart), then the photos' diameters out from
		# the flange's top, then the tip rounded over its last ring's radius
		top = FLUSH + thick
		profile = [(FLUSH - 0.05, hole), (top, hole)] + [(top + d, w / 2) for d, w in aoa["profile"]]
		last, radius = profile[-1]
		profile += [(last + radius * math.sin(math.radians(a)), radius * math.cos(math.radians(a))) for a in (40, 70, 88)]
		probe = finished(turned(base, out, profile, sides=20), "chrome")
		node(f"aoa_{name}", mesh=merge([plate, seam, probe]))
		MARKS[f"aoa_{name}"] = (base, f"aoa_{name}")
		# pitot-static tube: a strut of aerofoil section swept forward and down
		# from a dark plate on the skin, canted outboard to the tube; the tube
		# runs forward from the strut's trailing foot, round at its aft end,
		# tapering to its open tip
		fore, aft = pitot["root"]
		middle = (fore + aft) / 2
		bl = math.copysign(pitot["buttline"], skin(middle, surface_angle(middle, pitot["waterline"], side))[0])
		(point, end), (lead, trail) = pitot["tip"], pitot["foot"]

		def axis(station):
			# the tube's centre at a station
			return at(station, end + pitot["rise"] * (station - point) / (trail - point), bl)

		roots = [on_skin(st, surface_angle(st, pitot["waterline"], side), -0.4) for st in (fore, aft)]
		strut = blade((roots[0], roots[1]), (axis(lead), axis(trail)), pitot["thickness"])
		radius = pitot["tube"] / 2
		length = (axis(trail) - axis(point)).length / INCH
		end_cap = [(length - radius + radius * math.sin(math.radians(a)), radius * math.cos(math.radians(a))) for a in (0, 40, 70, 88)]
		tube = turned(axis(point), axis(trail) - axis(point), [(d, w / 2) for d, w in pitot["profile"]] + end_cap)

		def laid(outline, out):
			return [on_skin(s, surface_angle(s, w, side), out) for s, w in outline]

		outline = pitot["plate"]
		centre = (sum(s for s, _ in outline) / len(outline), sum(w for _, w in outline) / len(outline))
		inner = [(centre[0] + (s - centre[0]) / 2, centre[1] + (w - centre[1]) / 2) for s, w in outline]
		plate = finished(loft([laid(outline, -0.05), laid(outline, STANDOFF), laid(inner, STANDOFF)]), "rubber")
		node(f"pitot_{name}", mesh=merge([strut, tube, plate]), paint="chrome")
		MARKS[f"pitot_tip_{name}"] = (axis(point), f"pitot_{name}")
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
		near, far = waist - 0.5, TAIL_END + 0.5
		ring = lambda station: [axis(station) + (round_at(station, throat, 2 * math.pi * i / 10) - axis(station)) for i in range(10)]
		vertices = ring(far) + ring(near)
		faces = [(i, (i + 1) % 10, 10 + (i + 1) % 10, 10 + i) for i in range(10)] + [tuple(range(10))]
		node(f"burner_{name}", paint="burner", mesh=(vertices, faces))


NOZZLE_PARTS = []   # the flaps the paint gives the nozzles' colours (layout.paint.nozzle)
NOZZLE_WAIST = []   # the throat's station at rest

ATLAS = 2048
STRIP = 0.03   # the atlas's share, along its right side, left free for faces unfolded after packing


def painted_parts():
	# The meshes the paint covers, as the bakes see them: the stores, which
	# take an atlas of their own, and the rest. In the rest, faces of more
	# than four corners in triangles (as the export writes them): a long,
	# bent cap (a loft's end, fin_root's over the fin's root chord) laid flat
	# in one piece overlapped itself, wherever it was put. No vertex is
	# added, so a mesh's shape keys (the wing's flex) stand as they were
	stored = [o for o in bpy.data.objects if o.type == "MESH" and o.material_slots and all(s.material and s.material.name == "stores" for s in o.material_slots)]
	parts = [o for o in bpy.data.objects if o.type == "MESH" and o not in stored]
	for o in parts:
		if any(len(f.vertices) > 4 for f in o.data.polygons):
			mesh = bmesh.new()
			mesh.from_mesh(o.data)
			bmesh.ops.triangulate(mesh, faces=[f for f in mesh.faces if len(f.verts) > 4])
			mesh.to_mesh(o.data)
			mesh.free()
	return stored, parts


def jet_key(parts, frames):
	# The jet's bakes' key: every part's faces (each lies within the
	# occlusion's reach of the rest), the stencils' frames on the built skin,
	# the atlas's layout, the nozzles' parts, the finishes, the open pose's
	# joints and drives and the code that unwraps and bakes
	key = cache.Key("paint")
	key.meshes(parts)
	key.add([[spec, list(c), list(a), list(u), list(n)] for spec, c, a, u, n in frames], [ATLAS, STRIP, STENCIL_DENSITY, STENCIL_TEXEL, STENCIL_MARGIN, DUCT_DENSITY, duct_run()[0][0]], sorted(NOZZLE_PARTS))
	key.add(list(ATLASED), sorted(OPENED.items()), OPEN_REACH, sorted([n, j] for n, j in JOINTS.items() if j.get("drive") in OPENED), sorted(o.name for o in parts if exposed(o.name)))
	key.code(bakes, texels, stencil_islands, stencil_texel, flattened, unfolded, coarsened, posed, interp, exposed, closes, built)
	return key


def store_key(stored, parts):
	# The stores' bakes' key: their own faces, the airframe's within the
	# occlusion's reach of them (the wing over a pylon, not the nose) and the
	# reach, the atlas's size and the code that unwraps and bakes
	key = cache.Key("stores")
	key.meshes(stored)
	key.surroundings(stored, parts, STORE_REACH * INCH, INCH)
	key.add(LAYOUT["stores"]["paint"]["atlas"])
	key.code(store_bakes, store_kind, texels)
	return key


def paint(directory, folder=None):
	# Unique UVs for every part in one atlas, then the paint: ambient
	# occlusion baked in Cycles as the shading every skin is laid over (#8),
	# times the paint's grey. Writes the atlas beside the model. With a cache
	# folder, the UVs and bakes come from there when a build has seen
	# everything they come from (bakes(), ../cache.py); both keys are taken
	# first, on the meshes as built, since baking leaves them changed.
	# the stores stay out: plain grey, no atlas, and hidden from the bake, so
	# a pylon or a tank the loadout leaves off casts no shadow on the wing
	stored, parts = painted_parts()
	for o in stored:
		o.hide_render = True
	frames = stencil_frames()
	keys = jet_key(parts, frames), store_key(stored, parts)
	image = bpy.data.images.new("paint", ATLAS, ATLAS, alpha=False)
	for m in MATERIALS.values():
		nodes = m.node_tree.nodes
		texture = nodes.new("ShaderNodeTexImage")
		texture.image = image
		nodes.active = texture
	baked = cache.fetch(folder, "paint", keys[0], parts, lambda: bakes(parts, frames))
	for m in MATERIALS.values():
		next(n for n in m.node_tree.nodes if n.type == "TEX_IMAGE").image = image
	# The two greys (layout.paint): each texel's surface normal, baked in the
	# objects' own axes (every node rests unrotated, so they are the jet's),
	# picks the upper grey or, facing down, the lower
	normal = baked["normal"].astype(np.float64) * 2 - 1
	up = normal[..., 2]
	covered = np.abs(np.linalg.norm(normal, axis=-1) - 1) < 0.1   # texels the bake reached: a unit normal
	where = baked["where"].astype(np.float64)
	size = texel_size(where, covered)
	shade = soften(baked["shade"].astype(np.float64), where, covered, size)
	nozzle = baked["nozzle"]
	p = LAYOUT["paint"]
	upper, lower = np.array(p["upper"]) / 255, np.array(p["lower"]) / 255
	start, end = p["turn"]
	f = np.clip((up - start) / (end - start), 0, 1)
	f = (f * f * (3 - 2 * f))[..., None]
	grey = upper[None, None, :] * (1 - f) + lower[None, None, :] * f
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
	# the engine faces at the ducts' ends, the engines' bare metal (faced());
	# the ducts' walls keep the greys, shaded by the occlusion alone
	colour = np.where(faced(station, waterline, buttline)[..., None], metal * (0.4 + 0.6 * shade[..., None]), colour)
	# the landing gear's finishes (layout.paint gear), shaded, with no panel
	# lines or stencils
	finish = baked["finish"]
	for k, name in enumerate(ATLASED):
		if name in p["gear"]:
			colour = np.where((finish == k + 1)[..., None], np.array(p["gear"][name]) / 255 * (0.4 + 0.6 * shade[..., None]), colour)
	pixels = np.concatenate([colour, np.ones((ATLAS, ATLAS, 1))], -1)
	image.pixels[:] = pixels.ravel()
	image.filepath_raw = str(Path(directory) / "paint.png")
	image.file_format = "PNG"
	image.save()
	for name, m in MATERIALS.items():
		if name in ATLASED:
			nodes = m.node_tree.nodes
			texture = next(n for n in nodes if n.type == "TEX_IMAGE")
			m.node_tree.links.new(texture.outputs["Color"], nodes["Principled BSDF"].inputs["Base Color"])
		else:
			m.node_tree.nodes.remove(next(n for n in m.node_tree.nodes if n.type == "TEX_IMAGE"))
	paint_stores(stored, keys[1], folder)


def texels(image):
	# An image's pixels as Blender keeps them (rows from its bottom, RGBA)
	out = np.empty(len(image.pixels), np.float32)
	image.pixels.foreach_get(out)
	return out.reshape(image.size[1], image.size[0], 4)


# What the bake shades as it stands open, gear down, speedbrake up and probe
# out: the gear, its doors and bays, the speedbrake and the probe, their doors
# and wells (exposed()). Baked where they rest, stowed behind closed doors, they sit in
# the dark; the rest of the airframe is shaded at rest, so nothing hanging
# open shadows the belly it is stowed against
OPENED = {"gear.doors": 1.0, "gear.nose": 1.0, "gear.main": 1.0, "speedbrake": 1.0, "probe": 1.0}
OPEN_REACH = 24.0   # inches: the ambient occlusion's reach on what stands open


def exposed(name):
	return name.startswith(("gear_", "well_", "speedbrake")) or name in ("launch_bar", "probe", "probe_door", "probe_door_forward")


def closes(name):
	# a door or panel cut from the skin, which closes flush with it
	return "door" in name or name == "speedbrake"


@contextmanager
def posed(drives):
	# Every joint that turns or slides moved to its drive's value through its
	# keys, as the engine moves it (render.py), and back to rest after
	moved = []
	for name, j in JOINTS.items():
		if j["motion"] not in ("rotate", "slide") or j["drive"] not in drives:
			continue
		value = interp(j["keys"], drives[j["drive"]])
		obj = NODES[name]
		moved.append((obj, obj.rotation_mode, obj.matrix_basis.copy()))
		axis = Vector((j["axis"][0], -j["axis"][2], j["axis"][1]))   # glTF to Blender
		if j["motion"] == "rotate":
			obj.rotation_mode = "QUATERNION"
			obj.rotation_quaternion = obj.rotation_quaternion @ Quaternion(axis, value)
		else:
			obj.location += axis * value
	bpy.context.view_layer.update()
	try:
		yield
	finally:
		for obj, mode, basis in reversed(moved):
			obj.rotation_mode = mode
			obj.matrix_basis = basis
		bpy.context.view_layer.update()


def bakes(parts, frames):
	# The atlas's UVs and what Cycles bakes on them, each material's texture
	# node the target: every part unwrapped, the skin under the stencils (at
	# their frames) on islands of its own, faces folding over others on
	# theirs, all packed; then the ambient occlusion, the normals in the
	# objects' axes, each texel's place on the jet, which texels are the
	# nozzles' flaps, and each texel's finish (layout.paint gear), as the
	# bakes' pixels (rows from the atlas's bottom); the occlusion of what is
	# seen open (exposed()) baked open
	bpy.ops.object.select_all(action="DESELECT")
	for o in parts:
		o.select_set(True)
	bpy.context.view_layer.objects.active = parts[0]
	# the stencils' islands packed to STENCIL_TEXEL: each part added takes its
	# share of the atlas and coarsens every texel, the stencils' too (at a
	# fixed density they passed layout.stencils' limit three times), so their
	# density is raised and the atlas packed again until their coarsest texel
	# is within it
	density = STENCIL_DENSITY
	for _ in range(5):
		bpy.ops.object.mode_set(mode="EDIT")
		bpy.ops.mesh.select_all(action="SELECT")
		bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.002, scale_to_bounds=False)
		bpy.ops.object.mode_set(mode="OBJECT")
		joined = stencil_islands(parts, frames, density)
		unfolded(parts)
		coarsened(parts)
		sharpened(parts)
		bpy.ops.object.mode_set(mode="EDIT")
		bpy.ops.mesh.select_all(action="SELECT")
		bpy.ops.uv.pack_islands(rotate=True, margin=0.002)
		bpy.ops.object.mode_set(mode="OBJECT")
		coarsest = stencil_texel(joined) / (1 - STRIP)
		if coarsest <= STENCIL_TEXEL:
			break
		density *= coarsest / STENCIL_TEXEL * 1.02
	else:
		raise SystemExit(f"stencils: their coarsest texel {coarsest:.3f} in at {density:.2f} times the rest's density, past {STENCIL_TEXEL}")
	print(f"stencils: {density:.2f} times the rest's density, their coarsest texel {coarsest:.3f} in")
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
	targets = [next(n for n in m.node_tree.nodes if n.type == "TEX_IMAGE") for m in MATERIALS.values()]
	occlusion = bpy.data.images.new("occlusion", ATLAS, ATLAS, alpha=False)
	for target in targets:
		target.image = occlusion
	scene = bpy.context.scene
	scene.render.engine = "CYCLES"
	scene.cycles.samples = 48
	scene.cycles.device = "CPU"
	scene.render.bake.margin = 6
	bpy.ops.object.bake(type="AO", use_clear=True)
	shade = texels(occlusion)[..., 0]
	# what stands open shaded by what is near it alone (OPEN_REACH): the
	# airframe over the gear would darken it all, the bake having no ground
	# under the jet to light it from below, where the photos show the legs
	# white
	# (the scene has no world here: one for this bake alone)
	world = scene.world
	scene.world = bpy.data.worlds.new("open")
	scene.world.light_settings.distance = OPEN_REACH * INCH
	with posed(OPENED):
		bpy.ops.object.bake(type="AO", use_clear=True)
	bpy.data.worlds.remove(scene.world)
	scene.world = world
	open_ = texels(occlusion)[..., 0]
	normals = bpy.data.images.new("normals", ATLAS, ATLAS, alpha=False, float_buffer=True)
	normals.colorspace_settings.name = "Non-Color"
	for target in targets:
		target.image = normals
	bpy.ops.object.bake(type="NORMAL", normal_space="OBJECT", use_clear=True)
	normal = texels(normals)[..., :3]
	# Each texel's place on the jet: a temporary shader emits its position
	positions = bpy.data.images.new("positions", ATLAS, ATLAS, alpha=False, float_buffer=True)
	positions.colorspace_settings.name = "Non-Color"
	scene.cycles.samples = 1
	temporary = []
	for m, target in zip(MATERIALS.values(), targets):
		nodes, links = m.node_tree.nodes, m.node_tree.links
		target.image = positions
		geometry, emission = nodes.new("ShaderNodeNewGeometry"), nodes.new("ShaderNodeEmission")
		links.new(geometry.outputs["Position"], emission.inputs["Color"])
		links.new(emission.outputs["Emission"], nodes["Material Output"].inputs["Surface"])
		temporary.append((m, geometry, emission))
	bpy.ops.object.bake(type="EMIT", use_clear=True)
	where = texels(positions)[..., :3]
	# which texels are the nozzles' flaps and which are seen open only: each
	# face's kind emitted. A door or the speedbrake, cut from the skin, is
	# seen closed from outside: its outer faces and its edges keep the
	# shading at rest, and only its inside, turned against the skin, takes
	# the open pose's: the faces on the skin as it stood before the openings
	# were cut, since a panel's middle lies inches from the hole's rim. An
	# edge, closed, stands in a gap of no width against the hole's rim, and
	# shows only through the crack the two rims leave at a glancing view:
	# shaded open, unshaded, it lit there as a dashed light line round the
	# door
	skin = UNCUT["fuselage"]
	for o in parts:
		whole = 1.0 if o.name in NOZZLE_PARTS else 2.0 if exposed(o.name) else 0.0
		values = [whole] * len(o.data.polygons)
		if whole == 2.0 and closes(o.name):
			for p in o.data.polygons:
				near, facing, _, distance = skin.find_nearest(o.matrix_world @ p.center)
				if near is not None and distance < 0.5 * INCH and facing.dot(o.matrix_world.to_3x3() @ p.normal) > -0.5:
					values[p.index] = 0.0
		(o.data.attributes.get("kind") or o.data.attributes.new("kind", "FLOAT", "FACE")).data.foreach_set("value", values)
	indices = []
	for m, geometry, emission in temporary:
		index = m.node_tree.nodes.new("ShaderNodeAttribute")
		index.attribute_type, index.attribute_name = "GEOMETRY", "kind"
		m.node_tree.links.new(index.outputs["Fac"], emission.inputs["Color"])
		indices.append((m, index))
	bpy.ops.object.bake(type="EMIT", use_clear=True)
	kind = np.rint(texels(positions)[..., 0])
	nozzle = kind == 1
	shade = np.where(kind == 2, open_, shade)
	for m, index in indices:
		m.node_tree.nodes.remove(index)
	for o in parts:
		if "kind" in o.data.attributes:
			o.data.attributes.remove(o.data.attributes["kind"])
	# and each texel's finish: 1 and up for ATLASED's, 0 for the rest
	for m, index in indices:
		value = m.node_tree.nodes.new("ShaderNodeValue")
		value.outputs[0].default_value = float(ATLASED.index(m.name) + 1) if m.name in ATLASED else 0.0
		m.node_tree.links.new(value.outputs[0], next(e for n, g, e in temporary if n == m).inputs["Color"])
	bpy.ops.object.bake(type="EMIT", use_clear=True)
	finish = np.rint(texels(positions)[..., 0]).astype(np.int8)
	for m, _ in indices:
		m.node_tree.nodes.remove(next(n for n in m.node_tree.nodes if n.type == "VALUE"))
	for m, geometry, emission in temporary:
		nodes = m.node_tree.nodes
		nodes.remove(geometry)
		nodes.remove(emission)
		m.node_tree.links.new(nodes["Principled BSDF"].outputs["BSDF"], nodes["Material Output"].inputs["Surface"])
	for target in targets:
		target.image = None
	for made in (occlusion, normals, positions):
		bpy.data.images.remove(made)
	return {"shade": shade, "normal": normal, "where": where, "nozzle": nozzle, "finish": finish}


# The ambient occlusion's reach on the stores, inches: a rack shaded by its
# pylon and the wing over it, not by a tank on the next station
STORE_REACH = 12.0


def store_kind(o):
	# A store part's kind, from its name: the wingtip rails are tips
	return "tip" if re.fullmatch(r"rail_[19]", o.name) else o.name.split("_")[0]


def paint_stores(stored, key, folder=None):
	# The stores' own atlas (layout.stores.paint): every part's UVs unique,
	# the ambient occlusion baked in layers (store_bakes()), then finish.py's
	# paint, as JPEG; the UVs and bakes from the cache folder when it holds an
	# entry under the key (store_key())
	spec = LAYOUT["stores"]["paint"]
	size = spec["atlas"]
	scene = bpy.context.scene
	scene.world = scene.world or bpy.data.worlds.new("world")
	for o in stored:
		o.hide_render = False
	material = MATERIALS["stores"]
	nodes, links = material.node_tree.nodes, material.node_tree.links
	target = nodes.new("ShaderNodeTexImage")
	nodes.active = target
	baked = cache.fetch(folder, "stores", key, stored, lambda: store_bakes(stored, size, target))
	for o in stored:
		o.hide_render = False
	part = baked["part"].astype(int)
	where = baked["where"].astype(np.float64)
	occlusion = baked["occlusion"].astype(np.float64)
	covered = part > 0
	inches = texel_size(where, covered) / INCH
	frames = [FRAMES.get(o.name, {"kind": store_kind(o), "nose": [0, 0, 0], "axis": [-1, 0, 0], "up": [0, 0, 1]}) for o in stored]
	grey = np.array(LAYOUT["paint"]["lower"]) / 255
	# the wingtip LAU-7's light ends: its cap to the cap's joint and its cone
	# from the cone's base (layout.stores.rails.tip)
	tip = STORES["rails"]["tip"]
	spec = dict(spec, tip=dict(spec["tip"], light=[tip["cap"], float(np.linalg.norm(np.subtract(tip["aft"], tip["front"]))) - tip["cone"]]))
	out = finish.colour(spec, grey, occlusion, where, part, frames, inches)
	out[~covered] = grey
	from PIL import Image
	import tempfile
	path = Path(tempfile.mkdtemp()) / "stores.jpg"
	Image.fromarray((out[::-1] * 255 + 0.5).astype(np.uint8)).save(path, "JPEG", quality=90, subsampling=0)
	image = bpy.data.images.load(str(path))
	image.pack()
	image.name = "stores"
	target.image = image
	links.new(target.outputs["Color"], nodes["Principled BSDF"].inputs["Base Color"])


def store_bakes(stored, size, target):
	# The stores' UVs and what Cycles bakes on them into `target` (the stores
	# material's texture node): the part each texel lies on (its index in
	# `stored`, from 1), its place, and the ambient occlusion in layers, each
	# part with only the parts it is always shown with (a rack under its
	# pylon, a rail beside its rack: never a tank's shadow on a pylon the
	# loadout may show bare, nor a LAU-127's on the LAU-7 that takes its
	# place). The airframe stands in every layer, so the wing shades its pylons
	scene = bpy.context.scene
	scene.render.engine = "CYCLES"
	scene.cycles.device = "CPU"
	bpy.ops.object.select_all(action="DESELECT")
	for o in stored:
		o.select_set(True)
	bpy.context.view_layer.objects.active = stored[0]
	bpy.ops.object.mode_set(mode="EDIT")
	bpy.ops.mesh.select_all(action="SELECT")
	bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.002, scale_to_bounds=False)
	bpy.ops.uv.pack_islands(rotate=True, rotate_method="AXIS_ALIGNED", margin=0.006)
	bpy.ops.object.mode_set(mode="OBJECT")
	nodes, links = MATERIALS["stores"].node_tree.nodes, MATERIALS["stores"].node_tree.links

	def bake(kind, shown, baked, emit=None, **options):
		image = bpy.data.images.new(kind, size, size, alpha=False, float_buffer=True)
		image.colorspace_settings.name = "Non-Color"
		target.image = image
		for o in stored:
			o.hide_render = o not in shown and o not in baked
		bpy.ops.object.select_all(action="DESELECT")
		for o in baked:
			o.select_set(True)
		bpy.context.view_layer.objects.active = baked[0]
		made = []
		if emit:
			# emit: makes the node whose output socket is baked by emission
			emission = nodes.new("ShaderNodeEmission")
			source = emit(nodes)
			links.new(source, emission.inputs["Color"])
			links.new(emission.outputs["Emission"], nodes["Material Output"].inputs["Surface"])
			made = [emission, source.node]
		bpy.ops.object.bake(type="EMIT" if emit else kind, use_clear=True, margin=0, **options)
		out = texels(image)
		for n in made:
			nodes.remove(n)
		links.new(nodes["Principled BSDF"].outputs["BSDF"], nodes["Material Output"].inputs["Surface"])
		bpy.data.images.remove(image)
		return out

	for i, o in enumerate(stored):
		o.pass_index = i + 1
	scene.cycles.samples = 1
	part = np.rint(bake("part", stored, stored, emit=lambda n: n.new("ShaderNodeObjectInfo").outputs["Object Index"])[..., 0]).astype(np.int32)
	where = bake("where", stored, stored, emit=lambda n: n.new("ShaderNodeNewGeometry").outputs["Position"])[..., :3]
	# the layers, each baked with the parts it is always shown with
	first = [o for o in stored if store_kind(o) in ("pylon", "ejector", "tip")]
	racks = [o for o in stored if store_kind(o) == "rack"]
	layers = [(first, first), (racks, first), ([o for o in stored if store_kind(o) == "tank"], first),
		([o for o in stored if store_kind(o) == "rail"], first + racks), ([o for o in stored if store_kind(o) == "launcher"], first + racks)]
	reach = scene.world.light_settings.distance
	scene.world.light_settings.distance = STORE_REACH * INCH
	scene.cycles.samples = 48
	occlusion = np.ones((size, size), np.float32)
	for baked, shown in layers:
		if not baked:
			continue
		shade = bake("AO", shown, baked)[..., 0]
		mine = np.isin(part, [stored.index(o) + 1 for o in baked])
		occlusion[mine] = shade[mine]
	scene.world.light_settings.distance = reach
	return {"part": part, "where": where, "occlusion": occlusion}


def soften(shade, where, covered, size, sigma=1.0, reach=2, buried=0.02):
	# The occlusion bake's noise smoothed within each island: 48 samples a
	# texel leave 0.4-0.5% of noise from texel to texel, blotches 0.47 in
	# across up close. Each covered texel takes a Gaussian mean (`sigma`
	# texels, out to `reach`) of the neighbours the bake reached that lie on
	# the jet within half as far again as their step across the atlas (across
	# an island's edge the next texel lies elsewhere on the jet) and are not
	# buried: a texel whose sample lay inside another part saw nothing, and
	# its black ran along the fin fairing's edges in a sawtooth. A buried
	# texel takes its unburied neighbours' shade; one with none keeps its own
	h, w = shade.shape
	keep = covered & (shade >= buried)
	padded = lambda a, v: np.pad(a, [(reach, reach), (reach, reach)] + [(0, 0)] * (a.ndim - 2), constant_values=v)
	shade_, where_, keep_ = padded(shade, 0.0), padded(where, 1e9), padded(keep, False)
	total, weight = np.zeros((h, w)), np.zeros((h, w))
	for dy in range(-reach, reach + 1):
		for dx in range(-reach, reach + 1):
			if dx * dx + dy * dy > reach * reach:
				continue
			k = math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma))
			cut = (slice(reach + dy, reach + dy + h), slice(reach + dx, reach + dx + w))
			near = np.linalg.norm(where_[cut] - where, axis=-1) <= 1.5 * math.hypot(dx, dy) * size
			m = keep_[cut] & near & covered
			total += np.where(m, k * shade_[cut], 0.0)
			weight += np.where(m, k, 0.0)
	return np.where(covered & (weight > 0), total / np.maximum(weight, 1e-12), shade)


def texel_size(where, covered):
	# Each texel's size on the jet (metres): the largest step to a neighbour
	# across the atlas on the same island (one no more than three times the
	# atlas's usual step away), else the usual step. A texel the bake's margin
	# filled repeats its neighbour's place across the island's edge, or all but
	# repeats it, while along the edge it stands a texel's step from the next:
	# the nearer neighbour, taken as the size, made the edge's texels and the
	# margin's 0 to 0.001 in where the rest were 0.7, so a panel line beside
	# them shaded none (a door's seam, which runs along an island's edge) or
	# shaded them by 0/0 and they painted black
	steps = []
	for a, b, ok in ((where[:, 1:], where[:, :-1], covered[:, 1:] & covered[:, :-1]), (where[1:], where[:-1], covered[1:] & covered[:-1])):
		d = np.linalg.norm(a - b, axis=-1)
		steps.append(np.where(ok & (d > 0), d, np.nan))
	usual = np.nanmedian(np.concatenate([s.ravel() for s in steps]))
	size = np.full(where.shape[:2], -np.inf)
	for axis, d in enumerate(steps):
		d = np.where(d < 3 * usual, d, -np.inf)
		for pad in (((0, 0), (1, 0)), ((0, 0), (0, 1))) if axis == 0 else (((1, 0), (0, 0)), ((0, 1), (0, 0))):
			size = np.maximum(size, np.pad(d, pad, constant_values=-np.inf))
	size = np.where(size > 0, size, usual)
	# and the margin's texels the size of the texel each repeats: their own
	# steps run only along the edge, so on an island longer across its edge
	# than along it (a forward nose door's, 1.07 in across and 0.70 along) a
	# seam within the edge texel's reach lay beyond the margin's, which kept
	# the door's grey a texel past the seam's, and the seam read no darker
	# than the door. Carried across as many texels as the bake's margin
	# reaches (6)
	for _ in range(6):
		for a, b in (((slice(None), slice(1, None)), (slice(None), slice(None, -1))), ((slice(1, None), slice(None)), (slice(None, -1), slice(None)))):
			same = covered[a] & covered[b] & (np.linalg.norm(where[a] - where[b], axis=-1) < 0.01 * usual)
			larger = np.where(same, np.maximum(size[a], size[b]), 0.0)
			size[a] = np.maximum(size[a], larger)
			size[b] = np.maximum(size[b], larger)
	return size


# each cut panel's outline (cut(): its outer face's open edges, but where
# another panel of the same door goes on), as segments in the model frame:
# the seams the paint draws round the closed doors
SEAMS = []


def rims():
	# The seam round each closed door, which the paint draws as a panel line,
	# as segments in the model frame: the cut panels' outlines, the probe's
	# door's (its curve), and the forward door's rim with the skin, the
	# fuselage's open edges within a quarter inch of it (wells())
	out = list(SEAMS)
	curve, _ = CURVES["probe_door"]
	out += [(np.array(a), np.array(b)) for a, b in zip(curve, curve[1:] + curve[:1])]
	tree = built(["probe_door_forward"])
	mesh, hinge = NODES["fuselage"].data, HINGES["fuselage"]
	count = {}
	for polygon in mesh.polygons:
		for k in polygon.edge_keys:
			count[k] = count.get(k, 0) + 1
	for (a, b), n in count.items():
		if n != 1:
			continue
		p, q = mesh.vertices[a].co + hinge, mesh.vertices[b].co + hinge
		hit = tree.find_nearest((p + q) / 2)
		if hit[0] is not None and hit[3] < 0.25 * INCH:
			out.append((np.array(p), np.array(q)))
	return out


def covering(gap, seam, texel, half):
	# The share of each texel a panel line covers (panels()), by its centre's
	# distance from the nearest traced line or ring (gap) and from the nearest
	# door's seam (seam), its width on the jet (texel) and half the line's
	# width, all in metres: the share of its width within half the line's
	# width of the line. A seam runs along an island's edge, the door's on one
	# side and the skin's on the other, where the edge texel's centre lies
	# anywhere up to a texel inside it: by area, a line narrower than a texel
	# shaded the shallow ones and left the deep ones bare, and the seam broke
	# into dots (27-44% of each door's outline no darker than beside it). So
	# each texel within a texel of a seam takes at least the share a line
	# gives the texel it crosses, its width over the texel's
	near = np.minimum(gap, seam)
	share = np.clip((np.minimum(near + texel / 2, half) - np.maximum(near - texel / 2, -half)) / texel, 0, 1)
	return np.maximum(share, np.where(seam < texel, np.minimum(1.0, 2 * half / texel), 0.0))


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
	# the traced lines laid on the skin, and the seam round each closed door
	# (a door lies flush in its opening: cut())
	segments = []
	for k, line in enumerate(p.get("lines", []) + mirrored + [[(s, w, -b) for s, w, b in line] for line in mirrored]):
		corners = on_parts(skin, [at(*c) for c in line], k)
		segments += [(np.array(a), np.array(b)) for a, b in zip(corners, corners[1:])]
	seams = rims()
	if not seams:
		raise SystemExit("panels: no door's outline found on the skin")
	seam = np.full(len(points), np.inf)
	for lines, into, near in ((segments, gap, reach), (seams, seam, texel.max())):
		for a, b in lines:
			pick = between_x(min(a[0], b[0]) - near, max(a[0], b[0]) + near)
			if not len(pick):
				continue
			q = points[pick]
			d = b - a
			t = np.clip(((q - a) @ d) / max(d @ d, 1e-12), 0, 1)
			into[pick] = np.minimum(into[pick], np.linalg.norm(q - (a + t[:, None] * d), axis=1))
	factor[covered] = 1 - (1 - p["shade"]) * covering(gap, seam, texel, half)
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
# the stencils' density on the first packing, raised (bakes()) until their
# coarsest texel is within STENCIL_TEXEL
STENCIL_DENSITY = 4.6   # the stencils' skin's texels per inch, against the rest's, packing first
STENCIL_TEXEL = 0.14   # inches: the stencils' coarsest texel the atlas is packed to, inside layout.stencils' 0.15
DUCT_DENSITY = 0.3   # the inlets' ducts' texels per inch behind their first fitted section, against the rest's
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


def stencil_islands(parts, frames, density=STENCIL_DENSITY):
	# The skin under each stencil (frames: stencil_frames()) on its own UV
	# island, `density` times as dense as smart_project left the rest
	# and laid flat in the stencil's plane, before the islands are packed: at
	# the atlas's own texel (about 6 mm) lettering half an inch high read as
	# speckle. A face joins a stencil's island with a corner within
	# STENCIL_MARGIN of it, facing its
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
	scale = math.sqrt(mapped / area) * density   # UV units per metre on the islands
	faces = []
	for k, (spec, centre, across, up, normal) in enumerate(frames):
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
				faces.append((o, f.index))
				for i in f.loop_indices:
					c = corners[mesh.loops[i].vertex_index]
					uv[i].uv = (2.0 + k + c.dot(across) * scale, 2.0 + c.dot(up) * scale)
		if not joined:
			raise SystemExit(f"stencil {k}: no skin facing it within its margin (layout.stencils)")
	return faces


def stencil_texel(faces):
	# The coarsest texel, in inches, over the given (object, face) pairs:
	# each face's size on the jet over its size on the atlas
	coarsest = 0.0
	for o, index in faces:
		f = o.data.polygons[index]
		q = [o.data.uv_layers.active.data[i].uv for i in f.loop_indices]
		mapped = abs(sum(a.x * b.y - b.x * a.y for a, b in zip(q, q[1:] + q[:1]))) / 2
		if mapped > 0:
			coarsest = max(coarsest, math.sqrt(f.area / mapped) / ATLAS / INCH)
	return coarsest


def coarsened(parts):
	# The inlets' ducts behind their first fitted section, dark and seen only
	# down the mouth, on islands DUCT_DENSITY as dense as the rest, each
	# island wholly there scaled about its middle before the atlas is packed:
	# at the rest's density their 150 in took so much of the atlas that the
	# stencils' coarsest texel passed its limit
	first = duct_run()[0][0]
	for o in parts:
		if not o.name.startswith("inlet_"):
			continue
		bm = bmesh.new()
		bm.from_mesh(o.data)
		bm.faces.ensure_lookup_table()
		layer = bm.loops.layers.uv.active
		parent = list(range(len(bm.faces)))

		def find(i):
			while parent[i] != i:
				parent[i] = parent[parent[i]]
				i = parent[i]
			return i

		# an island: faces joined across edges whose ends carry the same UVs on both
		for e in bm.edges:
			if len(e.link_faces) != 2:
				continue
			f, g = e.link_faces
			ends = [[l[layer].uv.copy() for l in face.loops if l.vert in e.verts] for face in (f, g)]
			if all(any((a - b).length < 1e-7 for b in ends[1]) for a in ends[0]):
				parent[find(f.index)] = find(g.index)
		islands = {}
		for f in bm.faces:
			islands.setdefault(find(f.index), []).append(f)
		world = o.matrix_world
		for faces in islands.values():
			if min(ORIGIN["station"] - (world @ f.calc_center_median()).x / INCH for f in faces) < first:
				continue
			loops = [l for f in faces for l in f.loops]
			middle = sum((l[layer].uv for l in loops), Vector((0.0, 0.0))) / len(loops)
			for l in loops:
				l[layer].uv = middle + (l[layer].uv - middle) * DUCT_DENSITY
		bm.to_mesh(o.data)
		bm.free()


def sharpened(parts):
	# Each closing part's islands (closes(): a door, the speedbrake) scaled
	# about their middles until a texel on them is no longer across than
	# along, before the atlas is packed: smart_project lays an island on one
	# plane square to its faces' mean, so a part curving away from that plane
	# came out foreshortened (a forward nose door, wrapping round its bay's
	# side, 1.0 in a texel across its centreline edge against 0.7 along it),
	# and its seam, drawn on the edge texel, read no darker than the door an
	# inch away, which lay in the same texel. Each island takes the stretch
	# most of its area shows (the 90th part by area, up to twice)
	for o in parts:
		if not closes(o.name):
			continue
		bm = bmesh.new()
		bm.from_mesh(o.data)
		bm.faces.ensure_lookup_table()
		layer = bm.loops.layers.uv.active
		parent = list(range(len(bm.faces)))

		def find(i):
			while parent[i] != i:
				parent[i] = parent[parent[i]]
				i = parent[i]
			return i

		for e in bm.edges:
			if len(e.link_faces) != 2:
				continue
			f, g = e.link_faces
			ends = [[l[layer].uv.copy() for l in face.loops if l.vert in e.verts] for face in (f, g)]
			if all(any((a - b).length < 1e-7 for b in ends[1]) for a in ends[0]):
				parent[find(f.index)] = find(g.index)
		islands = {}
		for f in bm.faces:
			islands.setdefault(find(f.index), []).append(f)
		for faces in islands.values():
			stretch, weight = [], []
			for f in faces:
				loops = f.loops
				for k in range(1, len(loops) - 1):
					a, b, c = loops[0], loops[k], loops[k + 1]
					edges = np.array([b.vert.co - a.vert.co, c.vert.co - a.vert.co]).T
					steps = np.array([b[layer].uv - a[layer].uv, c[layer].uv - a[layer].uv]).T
					if abs(np.linalg.det(steps)) < 1e-14:
						continue
					sides = np.linalg.svd(edges @ np.linalg.inv(steps), compute_uv=False)
					if sides[1] <= 0:
						continue
					stretch.append(sides[0] / sides[1])
					weight.append(np.linalg.norm(np.cross(edges[:, 0], edges[:, 1])))
			if not stretch:
				continue
			order = np.argsort(stretch)
			share = np.cumsum(np.array(weight)[order]) / sum(weight)
			scale = min(2.0, max(1.0, float(np.array(stretch)[order][np.searchsorted(share, 0.9)])))
			if scale > 1.0:
				loops = [l for f in faces for l in f.loops]
				middle = sum((l[layer].uv for l in loops), Vector((0.0, 0.0))) / len(loops)
				for l in loops:
					l[layer].uv = middle + (l[layer].uv - middle) * scale
		bm.to_mesh(o.data)
		bm.free()


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
		# a sliver smaller than a tenth of a texel square holds no texel's
		# sample wherever it lies, and its corners a hair apart can read as a
		# fold wherever it is laid: it needs no island
		tiny = (0.1 / (size * scale)) ** 2
		folded = {i for i in folded if mesh.polygons[i].area >= tiny}
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
FRAMES = {}   # each store part's axis frame for its paint (finish.py)
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


def rounded_ring(centre, f, u, width, height, rounding=1.0, n=4, groove=None):
	# A rounded rectangle across f: `height` inches along u, `width` across
	# both, its corners rounded by `rounding` of the smaller half. groove:
	# (height, depth) inches, a channel sunk into its -u face (the face a
	# launcher's round hangs on), kept inside that face's flat
	s = f.cross(u)
	hw, hh = max(width, 0.05) * INCH / 2, max(height, 0.05) * INCH / 2
	r = min(hw, hh) * rounding
	ring = []
	for cx, cy, start in ((hw - r, hh - r, 0), (-(hw - r), hh - r, 90), (-(hw - r), -(hh - r), 180), (hw - r, -(hh - r), 270)):
		for k in range(n + 1):
			a = math.radians(start + 90 * k / n)
			ring.append(centre + s * (cx + r * math.cos(a)) + u * (cy + r * math.sin(a)))
		if groove and start == 180:
			half = min(groove[0] * INCH / 2, hw - r - 0.05 * INCH)
			depth = min(groove[1] * INCH, hh)
			for x, y in ((-half, 0.0), (-half, depth), (half, depth), (half, 0.0)):
				ring.append(centre + s * x + u * (y - hh))
	return ring


def round_ring(centre, f, u, radius, sides=24):
	s = f.cross(u)
	r = max(radius, 0.03) * INCH
	return [centre + (u * math.cos(2 * math.pi * i / sides) + s * math.sin(2 * math.pi * i / sides)) * r for i in range(sides)]


def store(name, mesh, parent=None, hinge=None, shown=False, frame=None):
	# a store part: its node, hidden by its show joint unless always fitted;
	# frame (nose, tail and up, the part's own axis) places its paint
	node(name, parent=parent, hinge=hinge, mesh=mesh, paint="stores")
	if frame:
		nose, tail, up = frame
		FRAMES[name] = {"kind": name.split("_")[0], "nose": list(nose), "axis": list((tail - nose).normalized()), "up": list(up.normalized())}
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


def tank_top(station):
	# The wing tank's top at a station (the photos' tank, layout.stores.tank:
	# its axis from nose to tail, its profile stretched to that length)
	tank = STORES["tank"]
	nose, tail = Vector(tank["nose"]), Vector(tank["tail"])
	k = (station - nose.x) / (tail.x - nose.x)
	profile = tank["profile"]
	return nose.y + k * (tail.y - nose.y) + interp(profile, k * profile[-1][0])


def seated_bottom(bottom):
	# The inboard pylon's bottom (the outboard's moved to its own nose, never
	# traced) brought down onto its tank, which the photos trace within half
	# an inch and which hangs against it: on the tank's top from behind the
	# pylon's nose (which the photos place) to the tank's crest, then easing
	# back to the pylon's own line at its tail as the tank's tail cone falls
	# away from it
	stations = [s for s, _ in bottom[1:]]
	crest = max(stations, key=tank_top)
	drop = interp(bottom, crest) - tank_top(crest)
	last = bottom[-1][0]
	out = [bottom[0]]
	for s, w in bottom[1:]:
		out.append((s, tank_top(s) - 0.05 if s <= crest else w - drop * (last - s) / (last - crest)))
	return out


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


def box_pylon(front, back, bottom, width, corner, top, taper, round_=0.0):
	# A boxed pylon on the centreline (the SUU-62): its leading edge along
	# `front` ([FS, WL] pairs, its lower end to its root), narrow and rounded,
	# its sides closing to it in straight lines over `taper` inches from the
	# edge's middle station; behind that flat sides at their full width to an
	# upright aft face at `back`, its sections' corners rounded by `corner`;
	# its bottom flat at `bottom` WL, rising into the aft face round a corner
	# of radius `round_`; its top 1.5 in inside `top(FS)`
	line = sorted(front)
	start = line[0][0]
	lead = (line[0][0] + line[-1][0]) / 2
	stations = [start + 0.15, start + 0.6] + [lead + taper * k / 4 for k in range(5)] + [line[-1][0] + d for d in (0.0, 0.5)]
	stations += list(range(int(line[-1][0]) + 6, int(back - round_) - 1, 6))
	stations += [back - round_ * math.sin(math.pi / 2 * k / 6) for k in range(7)] if round_ else [back]
	stations = sorted(set(stations))
	rings = []
	for s in stations:
		low = max(bottom, interp(line, s)) if s <= line[-1][0] else bottom
		if round_ and s > back - round_:
			# the bottom's rise round the aft corner
			low += round_ - math.sqrt(max(0.0, round_ * round_ - (s - (back - round_)) ** 2))
		high = top(s) + 1.5
		edge = min(1.0, max(0.15, (s - lead) / taper))
		rings.append(rounded_ring(at(s, (low + high) / 2, 0.0), FORWARD, UP, width * edge, max(high - low, 0.1), rounding=corner + (1 - corner) * (1 - edge)))
	return loft(rings)


def box_mesh(front, f, u, length, width, height, fairing, tail=4.0, tip=0.3, anchor=0.0, close=0.7, ogive=False, groove=None, rounding=0.45, faces=None, power=None):
	# A launcher or rack: a box `length` aft from its front, its corners
	# rounded by `rounding` of its smaller half, its forward fairing growing
	# from `tip` of its section (or [width, height] tips) over `fairing`
	# inches, its aft end closing to
	# `close` over `tail`, straight, or with ogive a rounded cone, the
	# sections rounding toward round as they shrink, and with `power` p
	# closing as (1 - v)^p over it (the photos' fine cone to a point, the
	# last ring a hundredth of the section); its sections shrink
	# toward its middle, or with anchor 1 toward its +u face, that face's line
	# straight (a LAU-115 under its pylon), with -1 toward its -u face (a
	# launcher's face its round slides along); groove, a channel along its
	# -u face (rounded_ring), fading out where the ends shrink. faces: its
	# +u and -u faces closing to the tip each over its own run ([plus, minus]
	# inches) and the tip standing `at` of its height up from the -u face
	# ({"runs": [plus, minus], "at": share}); the width still over `fairing`
	stations = {0.0, 0.5, 1.5} | {fairing * k / 6 for k in range(7)} | {float(t) for t in range(int(fairing) + 6, int(length - tail), 12)} | {length - tail, length}
	if faces:
		stations |= {run * k / 6 for run in faces["runs"] for k in range(7)}
	if ogive:
		stations |= {length - tail * k / 6 for k in range(7)}
	if power:
		stations |= {length - tail * k / 16 for k in range(17)}
	rings = []
	tips = tip if isinstance(tip, (list, tuple)) else (tip, tip)
	for t in sorted(stations):
		grow = [a + (1 - a) * math.sin(min(t / fairing, 1.0) * math.pi / 2) if fairing else 1.0 for a in tips]
		v = max(0.0, (t - (length - tail)) / tail) if tail else 0.0
		if power:
			shrink = max(0.01, close + (1 - close) * (1 - min(v, 1.0)) ** power)
		else:
			shrink = close + (1 - close) * math.cos(v * math.pi / 2) if ogive else 1.0 - (1 - close) * v
		kw, kh = grow[0] * shrink, grow[1] * shrink
		lift = u * (anchor * (height - height * kh) / 2 * INCH)
		if faces:
			# the -u face's line and the +u face's, as shares of the height up
			# from the -u face, each easing from the tip's over its own run
			ease = [math.sin(min(t / run, 1.0) * math.pi / 2) if run else 1.0 for run in faces["runs"]]
			low = (faces["at"] - tips[1] / 2) * (1 - ease[1])
			high = faces["at"] + tips[1] / 2 + (1 - faces["at"] - tips[1] / 2) * ease[0]
			kh = (high - low) * shrink
			lift = u * (((high + low) / 2 - 0.5) * height * INCH)
		k = min(kw, kh)
		channel = (groove[0] * kw, groove[1] * min(1.0, max(0.0, (k - 0.85) / 0.15))) if groove else None
		rings.append(rounded_ring(front - f * (t * INCH) + lift, f, u, width * kw, height * kh, rounding=rounding + ((0.95 - rounding) * (1 - k) if ogive else 0.0), groove=channel))
	return loft(rings)


def casing(side, stations, waterlines, buttlines, keep="low", ends=0.3, chamfer=2.0):
	# A box at a wingtip along the jet's axis: stations [FS] front and back,
	# waterlines low and high, buttlines inboard and outboard (on the right;
	# mirrored on `side`), its fore and aft ends chamfered down to `ends` of
	# its height over up to `chamfer` inches, keeping the edge on the `keep`
	# side (low or high) whole
	(s0, s1), (w0, w1), (b0, b1) = stations, waterlines, buttlines
	inward = Vector((0, side, 0))
	t = min(chamfer, (s1 - s0) / 4)
	rings = []
	for station, k in ((s0, ends), (s0 + t, 1.0), (s1 - t, 1.0), (s1, ends)):
		low, high = (w0, w0 + (w1 - w0) * k) if keep == "low" else (w1 - (w1 - w0) * k, w1)
		rings.append(rounded_ring(at(station, (low + high) / 2, side * (b0 + b1) / 2), FORWARD, inward, high - low, b1 - b0, rounding=0.25))
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


def hooks(nose, f, u):
	# The LAU-116's hooks, the store a cheek round hangs from: one on each
	# hanger of the round (layout.stores.lau116 hooks), the hanger's
	# footprint, up the round's up (u) from the hanger's top into the
	# nacelle's skin, 0.1 in past it, clear of the stowed main wheel under it;
	# the forward one where the photos put it, ahead of the round's forward
	# hanger, standing on the round's body there (hooks forward)
	lau = STORES["lau116"]
	r, skin = lau["round"], built(["fuselage"])
	pieces = []
	fittings = {p["name"]: p for p in value(MISSILES["layout"]["aim120c"]["fittings"])}
	for name in lau["hooks"]["hangers"]:
		p = fittings[name]
		if "section" in p:
			(a, b), half, low = p["stations"], max(abs(x) for x, _ in p["section"]), max(y for _, y in p["section"])
		else:
			(a, b), half, low = p["box"][0], p["box"][1][1], p["box"][2][1]
		if name == lau["hooks"]["hangers"][0] and "forward" in lau["hooks"]:
			# the photos' station along the round from its nose, on its body
			along = (lau["hooks"]["forward"]["station"] - (ORIGIN["station"] - nose.x / INCH)) / f.x
			a, b, low = along - (b - a) / 2, along + (b - a) / 2, missile_mount("aim120c")[1]
		middle = (a + b) / 2
		start = nose - f * (middle * INCH) + u * (low * INCH)
		hit = skin.ray_cast(start, u)[0]
		if hit is None:
			raise SystemExit(f"no nacelle skin over the LAU-116's {name} hook")
		high = low + (hit - start).length / INCH + 0.1
		centre = lambda s: nose - f * (s * INCH) + u * ((low + high) / 2 * INCH)
		pieces.append(loft([rounded_ring(centre(s), f, u, 2 * half, high - low, rounding=min(1.0, r / half)) for s in (a, b)]))
	return merge([outward(piece) for piece in pieces])


def stores():
	global STORES
	STORES = LAYOUT["stores"]
	lau7, lau127 = FACTS["stores"]["lau7"], FACTS["stores"]["lau127"]
	lau115 = FACTS["stores"]["lau115"]
	py, rails, rounds = STORES["pylon"], STORES["rails"], STORES["rounds"]
	for side in (-1, 1):
		name = side_name(side)
		bend = BENDING[name]
		surface = SURFACES[f"wing_{name}"]
		tip, outboard, inboard, cheek = (1, 2, 3, 4) if side < 0 else (9, 8, 7, 6)
		# The wingtip LAU-7, turned on its side with its round outboard of it,
		# riding the outer panel's bend and fold: a blunt cap forward (nose)
		# and a long fine cone aft to a point (taper), the photos' profiles,
		# the channel the round slides in along its outboard face
		# (layout.stores.rails.tip)
		front, aft = fwb(rails["tip"]["front"], side), fwb(rails["tip"]["aft"], side)
		f, u = square(front - aft, Vector((0, side, 0)))   # u away from the round: inboard
		flex_joint(f"flex_rail_{name}", bend, surface.point(surface.length, 0.5), parent=f"wing_{name}")
		nose, taper = rails["tip"]["nose"], rails["tip"]["taper"]
		rail = box_mesh(front, f, u, (front - aft).length / INCH, value(lau7["width"]), value(lau7["height"]), nose["run"],
			tail=rails["tip"]["cone"], tip=nose["tip"], close=taper["close"], ogive=True, power=taper["power"], groove=rails["tip"]["channel"])
		# the fairing joining it to the wingtip (layout.stores.rails.tip.adapter):
		# along the tip's chord, the rail's top carried in level to the step
		# where the photos from above put the upper housing's outboard face,
		# rising from there to the wing's top at its edge; below, a ruled face
		# from the rail's bottom inboard edge up to the wing's lower edge
		adapter = rails["tip"]["adapter"]
		wing = built([f"wing_outer_{name}", f"flap_leading_outer_{name}", f"aileron_{name}"])   # the tip's whole chord
		def along(station):
			# the rail's axis at a station: its buttline and waterline
			k = (station - rails["tip"]["front"][0]) / (rails["tip"]["aft"][0] - rails["tip"]["front"][0])
			return [rails["tip"]["front"][i] + k * (rails["tip"]["aft"][i] - rails["tip"]["front"][i]) for i in (1, 2)]
		def edge(station, below):
			# the wingtip's surface just inboard of its edge, WL
			start = fwb([station, 60.0 if below else 160.0, adapter["edge"] - 0.3], side)
			hit = wing.ray_cast(start, UP if below else -UP)[0]
			if hit is None:
				raise SystemExit(f"no wingtip surface at FS {station:.1f}")
			return hit.z / INCH + ORIGIN["waterline"]
		rings = []
		for k in range(adapter["steps"] + 1):
			station = adapter["chord"][0] + 0.3 + (adapter["chord"][1] - adapter["chord"][0] - 0.6) * k / adapter["steps"]   # just inside the tip's edges
			wl, bl = along(station)
			top, bottom = wl + value(lau7["width"]) / 2, wl - value(lau7["width"]) / 2
			face = bl - value(lau7["height"]) / 2 + 0.3   # 0.3 in inside the rail
			rings.append([fwb([station, w, b], side) for w, b in ((edge(station, False), adapter["edge"] - 0.3), (top - 0.15, adapter["step"]), (top - 0.15, face),
				(bottom + 0.15, face), (bottom + 0.15, adapter["step"]), (edge(station, True), adapter["edge"] - 0.3))])
		fairing = outward(loft(rings))
		# the formation lights' housings, each a plate framing its strip, the
		# rim, ends and slope as the side photos show them round the windows:
		# the upper standing on the fairing's top at the rail's level, the
		# lower its mirror, hanging from the fairing's underside, its top
		# reaching up into the underside where that rises to the tip's edge
		strips, housing = LAYOUT["strips"], adapter["housings"]
		def underside(station, buttline):
			# the fairing's underside at a station and buttline, WL: level with
			# the rail's bottom out to the step, then rising to the tip's edge
			bottom = along(station)[0] - value(lau7["width"]) / 2 + 0.15
			k = min(1.0, max(0.0, (adapter["step"] - buttline) / (adapter["step"] - adapter["edge"] + 0.3)))
			return bottom + k * (edge(station, True) - bottom)
		def frame(key, above):
			(f0, w0, b0), (f1, w1, b1) = sorted(strips[key])
			face = (abs(b0) + abs(b1)) / 2
			edge_ = lambda w: w + (1 if above else -1) * (strips["width"] / 2 + housing["rim"])
			if above:
				base_ = lambda f: along(f)[0] + value(lau7["width"]) / 2 - 0.3
			else:
				base_ = lambda f: underside(f, face - housing["thick"]) + 0.1
			outer = [(f0 - housing["end"], edge_(w0)), (f1 + housing["end"], edge_(w1))]
			drop = [abs(w - base_(f)) for f, w in outer]
			base = [(outer[0][0] - drop[0], base_(outer[0][0] - drop[0])), (outer[1][0] + drop[1], base_(outer[1][0] + drop[1]))]
			outline = [base[0], outer[0], outer[1], base[1]]
			return outward(loft([[fwb([f, w, b], side) for f, w in outline] for b in (face - housing["thick"], face)]))
		upper, lower = frame("tip", True), frame("undertip", False)
		store(f"rail_{tip}", merge([rail, fairing, upper, lower]), parent=f"flex_rail_{name}", hinge=front, shown=True, frame=(front, aft, u))
		inward = Vector((0, side, 0))
		for key, housing in (("tip", upper), ("undertip", lower)):
			node(f"formation_{key}_{name}", parent=f"flex_rail_{name}", mesh=flush(BVHTree.FromPolygons(*housing), strips[key], side, strips["width"], inward), paint="lights")
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
			if station == inboard:
				bottom_ = seated_bottom(bottom_)
			root = surface.point(abs(nose_[2]), 0.5)
			flex = f"flex_pylon_{station}"
			flex_joint(flex, bend, root)
			store(f"pylon_{station}", pylon_mesh(side, nose_, tail_, front_, bottom_, py["width"]), parent=flex, frame=(fwb(nose_, side), fwb(tail_, side), UP))
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
			rack = STORES["rack"]
			store(f"rack_{station}", box_mesh(rack_front, axis_f, UP, length, value(lau115["width"]), value(lau115["height"]), rack["fairing"], tip=rack["tip"],
				anchor=1.0, rounding=rack["corner"]),
				parent=flex, hinge=rack_front, frame=(rack_front, rack_front - axis_f * (length * INCH), UP))
			if station == outboard:
				# the LAU-115's front and aft lower corners and its front's top,
				# where its fairing meets the pylon (marking.md); its sections
				# hang from its top line, the pylon's bottom
				height = value(lau115["height"])
				top_ = rack_front + UP * (height / 2 * INCH)
				MARKS[f"rack_outboard_front_{name}"] = (top_ - UP * (height * 0.45 * INCH), f"rack_{station}")
				MARKS[f"rack_outboard_root_front_{name}"] = (top_, f"rack_{station}")
				MARKS[f"rack_outboard_aft_{name}"] = (top_ - axis_f * (length * INCH) - UP * (height * 0.7 * INCH), f"rack_{station}")
			# a single AIM-120 on the LAU-115's own rail, centred under it: under
			# its bottom at its middle (its top runs straight from its front,
			# where the pylon's bottom curves over a tank)
			rack_top = (rack_front.z - axis_f.z * (middle - start) * INCH) / INCH + ORIGIN["waterline"] + value(lau115["height"]) / 2
			below = rack_top - value(lau115["height"]) - 0.6 - value(MISSILES["aim120c"]["diameter"]) / 2
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
				# the fitting joining a rail to the LAU-115's side: the photos put the
				# rails' fronts 15.8 in apart, wider than the LAU-115's 7 in body
				# and the rails' halves, the real rails hanging from its shoulder
				# adapters. A block from just inside the LAU-115's side to the
				# rail's middle, its top half, along the length the two share; part
				# of the rail, shown with it
				def fitting(length):
					s0 = max(start, fronts[point][0]) + 3.0
					s1 = min(start + value(lau115["length"]), fronts[point][0] + length) - 3.0
					mid = (s0 + s1) / 2
					rail_at = tip_ - axis_f * ((mid - fronts[point][0]) * INCH)
					centre = at(mid, 0.0, bl(mid) * side).y
					edge = centre + math.copysign((value(lau115["width"]) / 2 - 0.3) * INCH, rail_at.y - centre)
					front = Vector((at(s0, 0.0, 0.0).x, (edge + rail_at.y) / 2, rail_at.z + 1.5 * INCH))
					return box_mesh(front, FORWARD, UP, s1 - s0, abs(rail_at.y - edge) / INCH, 3.0, 0.0, tail=0.0)
				body = rails["launcher"]
				store(f"launcher_{station}{point}", merge([box_mesh(tip_, axis_f, -toward, value(lau127["length"]), value(lau127["width"]), value(lau127["height"]), body["fairing"],
					tip=body["tip"], rounding=body["corner"], faces=body["faces"]),
					fitting(value(lau127["length"]))]), parent=flex, hinge=tip_, frame=(tip_, tip_ - axis_f * (value(lau127["length"]) * INCH), -toward))
				store(f"rail_{station}{point}", merge([box_mesh(tip_, axis_f, -toward, value(lau7["length"]), value(lau7["width"]), value(lau7["height"]), 14.0, groove=rails["tip"]["channel"]),
					fitting(value(lau7["length"]))]), parent=flex, hinge=tip_, frame=(tip_, tip_ - axis_f * (value(lau7["length"]) * INCH), -toward))
				ROUNDS[station][f"launcher_{station}{point}"] = round_at(n120, axis_f, -toward, "aim120c")
				# an AIM-9M on the LAU-7 there: its axis 5.0 in from the rail's,
				# toward the round, as on the wingtip; its nose 8.9 in ahead
				n9 = tip_ + toward * (5.0 * INCH) + axis_f * (8.9 * INCH)
				ROUNDS[station][f"rail_{station}{point}"] = round_at(n9, axis_f, -toward, "aim9m")
				if station == outboard:
					MARKS[f"rail_outboard_{'outer' if point == 'a' else 'inner'}_front_{name}"] = (tip_, f"launcher_{station}{point}")
					# the aft ends: a LAU-7's (rail) and a LAU-127's (launcher), from the same front
					side_ = 'outer' if point == 'a' else 'inner'
					MARKS[f"rail_outboard_{side_}_aft_{name}"] = (tip_ - axis_f * (value(lau7["length"]) * INCH), f"rail_{station}{point}")
					MARKS[f"launcher_outboard_{side_}_aft_{name}"] = (tip_ - axis_f * (value(lau127["length"]) * INCH), f"launcher_{station}{point}")
			if station == inboard:
				# the 330-gallon tank, from the photos' nose and tail
				n, t = fwb(STORES["tank"]["nose"], side), fwb(STORES["tank"]["tail"], side)
				store(f"tank_{station}", tank_mesh(n, t), parent=flex, frame=(n, t, UP))
				MARKS[f"tank_inboard_nose_{name}"] = (n, f"tank_{station}")
				MARKS[f"tank_inboard_tail_{name}"] = (t, f"tank_{station}")
		# The cheek station's LAU-116 and its AIM-120, canted 45 deg toward the
		# fuselage on it (dvids9380790), the round on the line from its tail to
		# its nose as the photos measure them
		nose = fwb(rounds["cheek"]["nose"], side)
		up = (UP + Vector((0, side, 0))).normalized()   # up and inboard
		f, u = square((nose - fwb(rounds["cheek"]["tail"], side)).normalized(), up)
		ROUNDS[cheek] = {f"ejector_{cheek}": round_at(nose, f, u, "aim120c")}
		# the LAU-116's hooks; its block, and behind it over the round's aft
		# end the box, are the airframe's (cheeks())
		corners = CHEEK[side]
		store(f"ejector_{cheek}", hooks(nose, f, u), hinge=corners["front_top"], frame=(corners["front_top"], corners["back"], UP))
	# The centreline: the SUU-62 on the belly and its tank, level
	centre = STORES["centre"]
	n = at(*centre["nose"])
	length = (Vector(STORES["tank"]["tail"]) - Vector(STORES["tank"]["nose"])).length
	t = n + AFT * (length * INCH)
	store("tank_5", tank_mesh(n, t), frame=(n, t, UP))
	MARKS["tank_centre_nose"] = (n, "tank_5")
	profile = STORES["tank"]["profile"]
	line = STORES["centreline"]
	tank_top = lambda s: centre["nose"][1] + interp(profile, s - centre["nose"][0])
	# a flat-sided box behind its narrow rounded leading edge, that edge as
	# the photos measure it from its lower end above the tank up to the belly,
	# its bottom flat at that lower end, the tank hanging from sway braces
	# under it (layout.stores.centreline)
	low, high = (line["front"], line["bottom"]), (line["top"], keel_at(line["top"]))
	# each brace a pad 2 in long on either side, from 0.5 in inside the
	# pylon's bottom to 0.1 in inside the tank's skin there
	pads = []
	for station in line["braces"]:
		radius = tank_top(station) - centre["nose"][1]
		for across in (-3.0, 3.0):
			seat = centre["nose"][1] + math.sqrt(radius * radius - across * across) - 0.1
			top = line["bottom"] + 0.5
			pads.append(box_mesh(at(station - 1.0, (seat + top) / 2, across), FORWARD, UP, 2.0, 1.5, top - seat, 0.0, tail=0.0))
	store("pylon_5", merge([box_pylon([low, high], line["back"], line["bottom"], line["width"], line["corner"], keel_at, line["taper"], line["round"])] + pads),
		frame=(at(low[0], low[1], 0.0), at(line["back"], line["bottom"], 0.0), UP))
	# the SUU-62's ends low down and where its edges meet the belly (marking.md)
	MARKS["pylon_centre_nose"] = (at(low[0], low[1], 0.0), "pylon_5")
	MARKS["pylon_centre_tail"] = (at(line["back"], line["bottom"], 0.0), "pylon_5")
	MARKS["pylon_centre_root_front"] = (at(high[0], high[1], 0.0), "pylon_5")
	MARKS["pylon_centre_root_aft"] = (at(line["back"], keel_at(line["back"]), 0.0), "pylon_5")


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
		# static: the oleo's drive as the jet stands loaded, metres in from the
		# length the model rests it at, as it hangs in flight: the nose's
		# extension, each main arm's droop over its reach
		static = g["legs"]["nose"]["extension"] * INCH if name == "nose" else DROOPS[f"gear_{name}"][0] * DROOPS[f"gear_{name}"][1]
		# full: the drive with the leg fully in, the most the engine may push it
		gear[name] = {"axle": e(at(station, g["axles"][tyre], buttline)), "radius": round(radius * INCH, 4), "static": round(static, 4), "full": round(FULLS[f"gear_{name}"], 4)}
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
	# the airframe from below: the skin, and the cheek fairings standing on it
	# over the cheek stations
	belly = built(["fuselage", "inlet_left", "inlet_right", "fairing_cheek_left", "fairing_cheek_right"])
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
			# on the nacelle or the keel: the airframe straight below the station and buttline
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


def rider(obj):
	# What a part moves with, for hidden.py's groups: the joint it rides (its
	# own or its nearest moving ancestor's: a surface, a door, a store the
	# loadout shows); a part with shape keys (the wing's flex) is its own,
	# since a bend can bare what it hides at rest; None for the rigid frame
	while obj is not None:
		if obj.name in JOINTS:
			return obj.name
		if obj.data is not None and getattr(obj.data, "shape_keys", None):
			return obj.name
		obj = obj.parent
	return None


def cull():
	# Removes the faces no view can see: inside another part or against one
	# that moves with it (hidden.py), such as the skin under the windscreen's
	# and canopy sill's fittings, the fin roots' caps inside the fins and the
	# pilot inside the seat
	counts = hidden.remove([o for o in bpy.data.objects if o.type == "MESH"], rider)
	print("hidden faces removed:", sum(counts.values()))


def mend(bm):
	# One mesh mended (mended()): its edges shorter than a hundredth of an
	# inch and its faces of no area dissolved; each face with a straight
	# corner split into triangles, each diagonal chosen for the widest angles
	# inside the face's outline (a well's cap is concave, and a diagonal from
	# the straight corner to the corner furthest from its line passed outside
	# it, folding the bay's faces out through the skin); and dissolved again,
	# for a triangle of no area the split lays where a face's corners run on
	# one line (the keel's front edge, points 0.0167 in apart), until no face
	# is left with a straight corner: dissolving such a triangle joins it to
	# its neighbour, a face with a straight corner again, which the cull's
	# split laid flat once more. Returns the faces removed and the faces split
	def dissolved():
		before = len(bm.faces)
		bmesh.ops.dissolve_degenerate(bm, edges=bm.edges[:], dist=0.01 * INCH)
		return before - len(bm.faces)

	removed, split = dissolved(), 0
	for _ in range(4):
		bm.normal_update()   # the fill projects each face along its normal
		faces = [f for f in bm.faces if len(f.verts) > 3 and any(straight(loop) for loop in f.loops)]
		if not faces:
			break
		bmesh.ops.triangulate(bm, faces=faces, quad_method="BEAUTY", ngon_method="BEAUTY")
		split += len(faces)
		removed += dissolved()
	return removed, split


def mended():
	# Mends every part (mend()) once the openings are cut and before the
	# hidden faces go, so the cull judges the triangles exported, none made
	# after it: a cut plane passing a hair from a vertex leaves faces of no
	# area, whose normal is undefined, and smoothing folded it into their
	# neighbours' corners, which shaded as if on a crease (light triangles on
	# the nose); and a face with a corner lying straight (a cut's or a band's
	# point on its edge, which the neighbour shares) splits there into
	# triangles of no area as the exporter fans it. A part with a shape key
	# (the wings' flex) is left as built
	totals = [0, 0]
	for o in bpy.data.objects:
		if o.type != "MESH" or o.data.shape_keys is not None:
			continue
		bm = bmesh.new()
		bm.from_mesh(o.data)
		totals = [a + b for a, b in zip(totals, mend(bm))]
		bm.to_mesh(o.data)
		bm.free()
	print("faces of no area removed: {}; faces with a straight corner split: {}".format(*totals))

def main():
	folder, keys = option("--cache"), option("--keys")
	args = ARGS
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
	# the gear's braces, solved for room inside the whole airframe (check.py's
	# hull: the stowed parts lie inside it)
	skin = built(["fuselage", "lex_left", "lex_right", "inlet_left", "inlet_right", "wing_inner_left", "wing_inner_right", "canopy", "windscreen", "fin_left", "fin_right"])
	for brace in BRACES:
		brace(skin)
	sequenced()
	scoop()
	lamps()
	cheeks()
	stores()
	print("chord fractions:", json.dumps(fractions, default=lambda x: round(x, 3)))
	located = points()
	wells()
	mended()
	cull()
	if keys:
		# the keys the atlases would bake under, and nothing more (test_build.py)
		stored, parts = painted_parts()
		Path(keys).write_text(json.dumps({"paint": jet_key(parts, stencil_frames()).hex(), "stores": store_key(stored, parts).hex()}))
		return
	if "--draft" not in args:
		paint(Path(out[0]).parent, folder)
	bpy.ops.export_scene.gltf(filepath=out[0], export_format="GLB", export_yup=True, use_selection=False,
		export_apply=False, export_animations=False, export_extras=False)
	# the mechanisms' stroke times (the hook's swing from centre to either
	# stop), the rudders' toe-in and the hook's sideways travel each way, for
	# the engine (layout.motion)
	m = {k: v["value"] for k, v in LAYOUT["motion"].items() if isinstance(v, dict)}
	motion = {"seconds": {k: m[k]["seconds"] for k in ("canopy", "probe", "bar", "fold", "hook", "scoop", "swing")}, "toe": m["toe"], "swing": m["swing"]["travel"],
		"canopy": {k: m["canopy"][k] for k in ("unlatch", "fall", "lock")},   # the closing's own phases: the opening's are its stroke and the slide's share
		"gear": timeline()}   # each gear mechanism's share of the stroke's time, each way
	document = {"frame": {"origin": {"station": ORIGIN["station"], "waterline": ORIGIN["waterline"], "buttline": 0}},
		"motion": motion,
		"joints": dict(sorted(JOINTS.items())),
		"points": {**located, "landmarks": {name: exported(point) for name, point in sorted(LANDMARKS.items())}}}
	Path(out[1]).write_text(json.dumps(document, indent="\t") + "\n")
	if len(out) > 2:
		features = {"about": "The model's named points and curves, each on the node it rides on, at rest in the model frame (build.py). A point on a node with shape keys gives its move under each at full weight, in the node's frame (morphs).",
			"landmarks": {name: {"at": exported(p), "node": n, **({"morphs": {"flex": exported(flexed(n, p))}} if n in BENDS else {})} for name, (p, n) in sorted(MARKS.items())},
			"curves": {name: {"points": [exported(p) for p in points], "node": n, **({"morphs": {"flex": [exported(flexed(n, p)) for p in points]}} if n in BENDS else {})} for name, (points, n) in sorted(CURVES.items())}}
		Path(out[2]).write_text(json.dumps(features, indent="\t") + "\n")


main()
