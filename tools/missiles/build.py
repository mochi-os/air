# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# Builds one of our missiles (claude/plans/air-fa18c.md #9) from nothing on
# each run: every number comes from facts.json, the cited sizes and the
# layout measured on the photos (measure.py). Writes the model as glTF binary
# and its points file: true metres in the engine's axes (x forward along the
# missile, y up, z to its right), origin on the axis at the centre of gravity,
# the launch lugs on top, each moving fin a node on its hinge, at rest with no
# rotation.
#
# Its paint is an atlas (layout.atlas texels a side) baked over every part
# but the seeker's glass: ambient occlusion, the materials' colours and the
# markings and wear paint.py lays over them; --draft leaves it out.
#
# usage: blender -b --factory-startup -P build.py -- MISSILE OUT.glb OUT.json [--draft]   (MISSILE: aim9m or aim120c)
import json, math, sys, tempfile
from pathlib import Path

import bmesh
import bpy
import numpy as np
from mathutils import Vector

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import paint as painting  # noqa: E402
FACTS = json.loads((HERE / "facts.json").read_text())
INCH = 0.0254
SIDES = 24
# A joint driven straight in radians, half a turn either way
IDENTITY = [[-math.pi, -math.pi], [math.pi, math.pi]]
# Linear base colours: the seeker's glass, the ordnance bands (yellow over the
# warhead, brown over the rocket motor), the fins' metal; the body's grey and
# a radome's white are the layout's (paint, radome), set below
COLOURS = {"glass": (0.05, 0.06, 0.07, 0.6), "explosive": (0.75, 0.55, 0.02, 1),
	"propellant": (0.18, 0.09, 0.03, 1), "metal": (0.3, 0.3, 0.31, 1)}


def linear(srgb):
	return tuple(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in (v / 255 for v in srgb)) + (1,)
# The fins' places round the body, in degrees from straight up toward the
# missile's right: carried in an X, the lugs on top between the upper pair
ROLLS = {"upper_right": 45, "lower_right": 135, "lower_left": 225, "upper_left": 315}


def value(entry):
	return entry["value"] if isinstance(entry, dict) and "value" in entry else entry


MISSILE = sys.argv[sys.argv.index("--") + 1]
SPEC = FACTS[MISSILE]
LAYOUT = {k: value(v) for k, v in FACTS["layout"][MISSILE].items() if k not in ("about", "note")}
LENGTH = value(SPEC["length"])
RADIUS = value(SPEC["diameter"]) / 2
NODES, HINGES, JOINTS, MATERIALS = {}, {}, {}, {}
COLOURS["paint"] = linear(LAYOUT["paint"])
# the bare-metal finishes' colours as layout measures them, and their sheen:
# partly metallic and smoother than the paint (the game's loader keeps it for
# these names, model.ts SHEEN)
FINISHES = dict(LAYOUT.get("finishes", {}))
SHEEN = FINISHES.pop("sheen", None)
for name, colour in FINISHES.items():
	COLOURS[name] = linear(colour)
if "liner" in LAYOUT.get("nozzle", {}):
	COLOURS["liner"] = linear(LAYOUT["nozzle"]["liner"])
if "radome" in LAYOUT:
	COLOURS["radome"] = linear(LAYOUT["radome"]["colour"])


def gravity():
	# The centre of gravity's station: cited where a source gives it, else
	# the body's volume centroid (layout.gravity says which)
	if "gravity" in SPEC:
		return value(SPEC["gravity"])
	return LAYOUT["gravity"]


CG = gravity()


def point(station, off=0.0, roll=0.0):
	# Blender's axes (x forward, y port, z up) from a station (inches aft of
	# the nose), a distance off the axis and a roll (degrees from up, toward
	# the missile's right)
	a = math.radians(roll)
	return Vector(((CG - station) * INCH, -off * math.sin(a) * INCH, off * math.cos(a) * INCH))


def exported(v):
	return [round(v.x, 5), round(v.z, 5), round(-v.y, 5)]


def material(name):
	if name not in MATERIALS:
		m = bpy.data.materials.new(name)
		m.use_nodes = True
		principled = m.node_tree.nodes["Principled BSDF"]
		principled.inputs["Base Color"].default_value = COLOURS[name]
		m.diffuse_color = COLOURS[name]
		if SHEEN and name in ("metal", "bare", "bracket", "wheel"):
			principled.inputs["Metallic"].default_value = SHEEN["metallic"]
			principled.inputs["Roughness"].default_value = SHEEN["roughness"]
		MATERIALS[name] = m
	return MATERIALS[name]


def node(name, parent=None, hinge=None, mesh=None, paint="paint"):
	# An object at `hinge`, its mesh given in missile space and stored about
	# the hinge (every ancestor rests unrotated)
	hinge = hinge if hinge is not None else (HINGES[parent].copy() if parent else Vector())
	data = None
	if mesh:
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
		bm = bmesh.new()
		bm.from_mesh(data)
		bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
		bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
		bm.to_mesh(data)
		bm.free()
		data.shade_smooth()
		data.set_sharp_from_angle(angle=math.radians(35))
	obj = bpy.data.objects.new(name, data)
	bpy.context.scene.collection.objects.link(obj)
	if parent:
		obj.parent = NODES[parent]
	obj.location = hinge - (HINGES[parent] if parent else Vector())
	NODES[name], HINGES[name] = obj, hinge.copy()
	return obj


def joint(name, axis, drive, keys=IDENTITY):
	axis = axis.normalized()
	JOINTS[name] = {"motion": "rotate", "axis": exported(axis), "drive": drive, "keys": keys}


def paint_at(station):
	for start, end, paint in LAYOUT.get("bands", []):
		if start <= station <= end:
			return paint
	return "paint"


def body():
	# The body of revolution: the profile's (station, radius) knots, a ring at
	# each, closed at the nose by its point and at the tail by a flat end;
	# the glass ahead of layout.dome, a radome's white ahead of its end, the
	# bands where layout.bands puts them
	profile = [tuple(k) for k in LAYOUT["profile"]]
	# rings at the bands' edges too, so a band ends on a ring
	cuts = sorted({s for band in LAYOUT.get("bands", []) for s in band[:2]} | ({LAYOUT["dome"]} if "dome" in LAYOUT else set())
		| ({LAYOUT["radome"]["end"]} if "radome" in LAYOUT else set()))
	knots = sorted(set(profile) | {(s, radius_at(profile, s)) for s in cuts if profile[0][0] < s < profile[-1][0]})
	vertices, faces, paints = [], [], []
	rings = []
	for s, r in knots:
		if r <= 1e-6:
			rings.append([len(vertices)])
			vertices.append(point(s))
			continue
		ring = []
		for i in range(SIDES):
			ring.append(len(vertices))
			vertices.append(point(s, r, 360 * i / SIDES))
		rings.append(ring)
	for (s0, _), (s1, _), a, b in zip(knots, knots[1:], rings, rings[1:]):
		if "dome" in LAYOUT and s1 <= LAYOUT["dome"] + 1e-6:
			paint = "glass"
		elif "radome" in LAYOUT and s1 <= LAYOUT["radome"]["end"] + 1e-6:
			paint = "radome"
		else:
			paint = paint_at((s0 + s1) / 2)
		for i in range(SIDES):
			j = (i + 1) % SIDES
			if len(a) == 1:
				faces.append((a[0], b[j], b[i]))
			elif len(b) == 1:
				faces.append((a[i], a[j], b[0]))
			else:
				faces.append((a[i], a[j], b[j], b[i]))
			paints.append(paint)
	last = rings[-1]
	if len(last) > 1 and "nozzle" in LAYOUT:
		# the aft face as a ring to the nozzle's exit, the nozzle a cone into
		# the body to its throat (layout's depth and throat, else 3 in deep to
		# 0.6 of the exit, by eye), dark at the bottom; lined where layout
		# gives the liner's colour, else bare metal
		end = knots[-1][0]
		nozzle = LAYOUT["nozzle"]
		inner = []
		for s, r in ((end, nozzle["exit"]), (end - nozzle.get("depth", 3.0), nozzle.get("throat", nozzle["exit"] * 0.6))):
			inner.append([len(vertices) + i for i in range(SIDES)])
			vertices.extend(point(s, r, 360 * i / SIDES) for i in range(SIDES))
		for a, b, paint in ((last, inner[0], "paint"), (inner[0], inner[1], "liner" if "liner" in nozzle else "metal")):
			for i in range(SIDES):
				j = (i + 1) % SIDES
				faces.append((a[i], a[j], b[j], b[i]))
				paints.append(paint)
		faces.append(tuple(reversed(inner[1])))
		paints.append("metal")
	elif len(last) > 1:
		faces.append(tuple(reversed(last)))
		paints.append("metal")
	node("body", mesh=(vertices, faces, paints))


def radius_at(profile, s):
	for (s0, r0), (s1, r1) in zip(profile, profile[1:]):
		if s0 <= s <= s1:
			return r0 + (r1 - r0) * (s - s0) / ((s1 - s0) or 1)
	return profile[-1][1]


def slab(outline, roll, thickness, offset=0.0):
	# A planform (station, distance off the axis) as a slab in the plane
	# through the axis at `roll`, `thickness` inches thick, its middle
	# `offset` inches along the plane's normal (toward the missile's port
	# side for an upper right fin, layout's face 1)
	a = math.radians(roll)
	normal = Vector((0, -math.cos(a), -math.sin(a)))
	n = len(outline)
	vertices = [point(s, r, roll) + normal * ((offset + side * thickness / 2) * INCH) for side in (1, -1) for s, r in outline]
	faces = [tuple(range(n)), tuple(range(2 * n - 1, n - 1, -1))] + [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
	return vertices, faces


def fin(kind, which, spec, parent=None):
	# A fin's planform (station, distance off the axis) as a thin slab in the
	# plane through the axis at its roll; a movable fin is its own node on its
	# hinge, turning about the radial line there
	roll = ROLLS[which]
	vertices, faces = slab(spec["outline"], roll, spec["thickness"])
	name = f"{kind}_{which}"
	hinge = point(spec["hinge"], RADIUS, roll) if "hinge" in spec else None
	node(name, parent=parent, hinge=hinge, mesh=(vertices, faces))
	if "hinge" in spec:
		joint(name, point(spec["hinge"], 1, roll) - point(spec["hinge"], 0, roll), "control")
	return name


def rolleron(which, spec):
	# A rolleron (NACA RM SL55C22): the wing's hinged trailing tip flap,
	# thicker than the wing, enclosing a toothed gyro wheel that spins about
	# the axle across the wing's plane and stands out beyond the tip edge; a
	# D-shaped bearing bracket on one face and a block beyond the tip. Without
	# layout's flap, a plain wheel in the wing's plane
	roll = ROLLS[which]
	parts = [(spec[k], k) for k in ("flap", "bracket", "block") if k in spec]
	if parts:
		vertices, faces, paints = [], [], []
		for part, kind in parts:
			offset = 0.0
			if kind == "bracket":
				# on the flap's face
				offset = part.get("face", 1) * (spec["flap"]["thickness"] / 2 + part["thickness"] / 2)
			v, f = slab(part["outline"], roll, part["thickness"], offset)
			faces += [tuple(len(vertices) + i for i in face) for face in f]
			finish = {"flap": "bare", "bracket": "bracket", "block": "metal"}[kind]
			paints += [finish if finish in COLOURS else "metal"] * len(f)
			vertices += v
		node(f"rolleron_flap_{which}", parent=f"wing_{which}", mesh=(vertices, faces, paints))
	a = math.radians(roll)
	axle = Vector((0, -math.cos(a), -math.sin(a)))
	centre = point(spec["centre"][0], spec["centre"][1], roll)
	u = Vector((1, 0, 0))
	v = axle.cross(u)
	r, w = spec["radius"] * INCH, spec["width"] * INCH / 2
	if "teeth" in spec:
		# ratchet teeth: a steep face from the root circle to the tip, then a
		# slope back down to the next tooth's root
		root, count = spec["root"] * INCH, spec["teeth"]
		pitch = 2 * math.pi / count
		rim = [(k * pitch + d, radius) for k in range(count) for d, radius in ((0.0, root), (0.12 * pitch, r))]
	else:
		rim = [(2 * math.pi * i / 20, r) for i in range(20)]
	n = len(rim)
	vertices = [centre + (u * math.cos(angle) + v * math.sin(angle)) * radius + axle * side for side in (-w, w) for angle, radius in rim]
	faces = [tuple(range(n)), tuple(range(2 * n - 1, n - 1, -1))] + [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
	name = f"rolleron_{which}"
	node(name, parent=f"wing_{which}", hinge=centre, mesh=(vertices, faces), paint="wheel" if "wheel" in COLOURS else "metal")
	joint(name, axle, "rolleron")


def block(profile, width, roll=0.0):
	# A part standing on the body: its side profile, a closed polygon of
	# (station, distance off the axis) in the plane through the axis at
	# `roll`, extruded `width` inches across that plane. Profile points on the
	# cylinder (exactly its radius) sink to where it meets the block's sides,
	# so a flat base leaves no gap on the curved body
	a = math.radians(roll)
	across = Vector((0, -math.cos(a), -math.sin(a)))
	half = width / 2
	foot = math.sqrt(max(RADIUS ** 2 - half ** 2, 0.0)) - 0.05
	outline = [(s, foot if abs(r - RADIUS) < 1e-6 else r) for s, r in profile]
	n = len(outline)
	vertices = [point(s, r, roll) + across * (side * half * INCH) for side in (1, -1) for s, r in outline]
	faces = [tuple(range(n)), tuple(range(2 * n - 1, n - 1, -1))] + [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
	return vertices, faces


def patch(outline, height, mirror=False):
	# A plate lying on the body: its outline, (station, roll in degrees), a
	# raised skin `height` inches proud of the body, its top tessellated in
	# (station, roll) so it follows the cylinder. With mirror, its copy on
	# the missile's other side too (roll negated)
	from mathutils.geometry import tessellate_polygon
	vertices, faces = [], []
	for sign in ((1, -1) if mirror else (1,)):
		ring = [(s, sign * r) for s, r in outline]
		if sign < 0:
			ring.reverse()
		n, base = len(ring), len(vertices)
		vertices += [point(s, RADIUS + height, r) for s, r in ring] + [point(s, RADIUS - 0.03, r) for s, r in ring]
		flat = [Vector((s, r, 0)) for s, r in ring]
		triangles = tessellate_polygon([flat])
		faces += [tuple(base + i for i in tri) for tri in triangles]
		faces += [tuple(base + n + i for i in reversed(tri)) for tri in triangles]
		faces += [(base + i, base + n + i, base + n + (i + 1) % n, base + (i + 1) % n) for i in range(n)]
	return vertices, faces


def post(centre, radius, bottom, top, sides=16):
	# A round post standing straight up from the body's top line: its axis at
	# station `centre`, from `bottom` to `top` inches above the top line (a
	# bottom on the line sinks into the body)
	low = RADIUS + bottom - (0.1 if bottom <= 1e-6 else 0.0)
	ring = [(math.cos(2 * math.pi * i / sides), math.sin(2 * math.pi * i / sides)) for i in range(sides)]
	vertices = [Vector(((CG - centre + radius * c) * INCH, -radius * s * INCH, z * INCH)) for z in (RADIUS + top, low) for c, s in ring]
	n = sides
	faces = [tuple(range(n)), tuple(range(2 * n - 1, n - 1, -1))] + [(i, n + i, n + (i + 1) % n, (i + 1) % n) for i in range(n)]
	return vertices, faces


def arc(centre, radius, start, end, steps=4):
	# Points on a quarter circle in a plane, from angle `start` to `end` (degrees)
	return [(centre[0] + radius * math.cos(math.radians(start + (end - start) * k / steps)),
		centre[1] + radius * math.sin(math.radians(start + (end - start) * k / steps))) for k in range(steps + 1)]


def extrude(outline, plane, between):
	# A closed polygon in a plane of the missile's own axes, extruded square to
	# it: `plane` maps a polygon point and a depth to Blender's axes
	n = len(outline)
	vertices = [plane(p, d) for d in between for p in outline]
	faces = [tuple(range(n)), tuple(range(2 * n - 1, n - 1, -1))] + [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
	return vertices, faces


def side(outline, across):
	# A part seen from the side: its outline, (station, inches above the axis),
	# between two distances to the missile's right of its vertical plane
	return extrude(outline, lambda p, a: Vector(((CG - p[0]) * INCH, -a * INCH, p[1] * INCH)), across)


def section(outline, stations):
	# A part along the body: its cross-section, (inches to the missile's right,
	# inches above the axis), between two stations
	return extrude(outline, lambda p, s: Vector(((CG - s) * INCH, -p[0] * INCH, p[1] * INCH)), stations)


def box(stations, across, heights, mirror=False, round=(0.0, 0.0)):
	# A box in the missile's own axes: `stations` (inches aft of the nose),
	# `across` (inches to the missile's right of its vertical plane) and
	# `heights` (inches above its axis), its top corners seen from the side
	# rounded to `round` (forward, aft); with mirror, its copy on the left too
	s0, s1 = sorted(stations)
	h0, h1 = sorted(heights)
	front, back = round
	outline = [(s0, h0)]
	outline += arc((s0 + front, h1 - front), front, 180, 90) if front else [(s0, h1)]
	outline += arc((s1 - back, h1 - back), back, 90, 0) if back else [(s1, h1)]
	outline += [(s1, h0)]
	vertices, faces = [], []
	for sign in ((1, -1) if mirror else (1,)):
		v, f = side(outline, sorted(sign * a for a in across))
		faces += [tuple(len(vertices) + i for i in face) for face in f]
		vertices += v
	return vertices, faces


def plate(stations, across, heights, round=0.0, holes=()):
	# A plate lying level: its outline seen from above, a rectangle of
	# `stations` by `across` (inches to the missile's right) with its corners
	# rounded to `round`, pierced by round holes, each (station, across,
	# radius), between two heights above the axis
	from mathutils.geometry import tessellate_polygon
	s0, s1 = sorted(stations)
	a0, a1 = sorted(across)
	h0, h1 = sorted(heights)
	r = round
	outer = (arc((s1 - r, a1 - r), r, 0, 90) + arc((s0 + r, a1 - r), r, 90, 180)
		+ arc((s0 + r, a0 + r), r, 180, 270) + arc((s1 - r, a0 + r), r, 270, 360)) if r else [(s1, a1), (s0, a1), (s0, a0), (s1, a0)]
	loops = [outer] + [[(s + radius * math.cos(2 * math.pi * k / 12), a - radius * math.sin(2 * math.pi * k / 12)) for k in range(12)] for s, a, radius in holes]
	flat = [p for loop in loops for p in loop]
	n = len(flat)
	triangles = tessellate_polygon([[Vector((s, a, 0)) for s, a in loop] for loop in loops])
	vertices = [Vector(((CG - s) * INCH, -a * INCH, h * INCH)) for h in (h1, h0) for s, a in flat]
	faces = [tuple(tri) for tri in triangles] + [tuple(n + i for i in reversed(tri)) for tri in triangles]
	start = 0
	for loop in loops:
		m = len(loop)
		faces += [(start + i, start + (i + 1) % m, n + start + (i + 1) % m, n + start + i) for i in range(m)]
		start += m
	return vertices, faces


def chamfer(vertices, faces, width):
	# A part with its sharp edges (faces meeting at more than 30 degrees)
	# bevelled `width` inches, as a machined fitting's are. An edge too short
	# to take the bevel (a small hole's rim) stays sharp: clamping overlaps
	# instead would narrow every bevel of the part to the tightest one's
	bm = bmesh.new()
	made = [bm.verts.new(v) for v in vertices]
	for face in faces:
		bm.faces.new([made[i] for i in face])
	bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
	edges = [e for e in bm.edges if len(e.link_faces) == 2 and e.calc_face_angle(0) > math.radians(30) and e.calc_length() >= 1.2 * width * INCH]
	bmesh.ops.bevel(bm, geom=edges, offset=width * INCH, offset_type="OFFSET", segments=1, profile=0.5, affect="EDGES", clamp_overlap=False)
	index = {v: i for i, v in enumerate(bm.verts)}
	out = [v.co.copy() for v in bm.verts], [tuple(index[v] for v in f.verts) for f in bm.faces]
	bm.free()
	return out


def fittings():
	# The fittings on the body (hooks, hangers, wing and fin fittings), each
	# its measured profile extruded to its width (layout.fittings), one node
	vertices, faces, paints = [], [], []
	for spec in LAYOUT.get("fittings", []):
		if "outline" in spec:
			v, f = patch(spec["outline"], spec["height"], spec.get("mirror", False))
		elif "post" in spec:
			v, f = post(**spec["post"])
		elif "box" in spec:
			v, f = box(*spec["box"], mirror=spec.get("mirror", False), round=spec.get("round", (0.0, 0.0)))
		elif "plate" in spec:
			v, f = plate(**spec["plate"])
		elif "section" in spec:
			v, f = section(spec["section"], spec["stations"])
		else:
			v, f = block(spec["profile"], spec["width"], spec.get("roll", 0.0))
		if spec.get("bevel"):
			v, f = chamfer(v, f, spec["bevel"])
		faces += [tuple(len(vertices) + i for i in face) for face in f]
		paints += [spec.get("paint", "metal")] * len(f)
		vertices += v
	if faces:
		node("fittings", mesh=(vertices, faces, paints))


def lugs():
	# The launch lugs on top: small blocks the launcher's rail carries, where
	# layout gives no fittings for them
	if not LAYOUT.get("lugs") or "fittings" in LAYOUT:
		return
	l, w, h = (value(LAYOUT["lug"][k]) for k in ("length", "width", "height"))
	vertices, faces = [], []
	for s in LAYOUT["lugs"]:
		base = len(vertices)
		for ds in (-l / 2, l / 2):
			for dz in (-w / 2, w / 2):
				for dy in (RADIUS - 0.2, RADIUS + h):
					vertices.append(Vector(((CG - s - ds) * INCH, -dz * INCH, dy * INCH)))
		faces += [tuple(base + i for i in f) for f in ((0, 1, 3, 2), (4, 6, 7, 5), (0, 2, 6, 4), (1, 5, 7, 3), (0, 4, 5, 1), (2, 3, 7, 6))]
	node("lugs", mesh=(vertices, faces), paint="metal")


# The longest piece of the body's skin one island of the atlas holds, inches
PIECE = 36.0


def unwrap(parts):
	# Unique UVs: every part projected flat by its faces' directions, then the
	# body's skin laid out again as itself unrolled, in pieces between its
	# joints (and no longer than PIECE) and between the fins' rolls, so the
	# long body packs as near-square islands at one density with the rest
	bpy.ops.object.select_all(action="DESELECT")
	for o in parts:
		o.select_set(True)
	bpy.context.view_layer.objects.active = parts[0]
	bpy.ops.object.mode_set(mode="EDIT")
	bpy.ops.mesh.select_all(action="SELECT")
	bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.002, scale_to_bounds=False)
	bpy.ops.object.mode_set(mode="OBJECT")
	body = NODES["body"]
	cuts = sorted(set(LAYOUT.get("markings", {}).get("seams", [])) | {0.0, LENGTH})
	pieces = []
	for a, b in zip(cuts, cuts[1:]):
		n = max(1, math.ceil((b - a) / PIECE))
		pieces += [(a + (b - a) * i / n, a + (b - a) * (i + 1) / n) for i in range(n)]
	mesh = bmesh.new()
	mesh.from_mesh(body.data)
	uv = mesh.loops.layers.uv.active
	origin = body.location
	for face in mesh.faces:
		centre = face.calc_center_median() + origin
		radial = Vector((0, centre.y, centre.z))
		if radial.length < 1e-6 or face.normal.dot(radial.normalized()) < 0.3:
			continue   # the ends, the nozzle and the nose's very tip keep their projection
		stations = [CG - (v.co.x + origin.x) / INCH for v in face.verts]
		if max(stations) - min(stations) < 1e-4:
			continue
		middle = CG - centre.x / INCH
		start = next((a for a, b in pieces if a <= middle <= b), 0.0)
		turn = math.degrees(math.atan2(-centre.y, centre.z)) % 360
		quarter = (math.floor((turn + 45) / 90) * 90 - 45) % 360
		for loop in face.loops:
			p = loop.vert.co + origin
			r = math.hypot(p.y, p.z)
			roll = math.degrees(math.atan2(-p.y, p.z)) % 360 if r > 1e-6 else turn
			loop[uv].uv = ((CG - p.x / INCH - start) * INCH, ((roll - quarter) % 360) / 360 * 2 * math.pi * max(r, 1e-6))
	mesh.to_mesh(body.data)
	mesh.free()
	bpy.ops.object.mode_set(mode="EDIT")
	bpy.ops.mesh.select_all(action="SELECT")
	bpy.ops.uv.pack_islands(rotate=True, rotate_method="AXIS_ALIGNED", margin=0.006)
	bpy.ops.object.mode_set(mode="OBJECT")


def baked(kind, size, parts, emit=None, **options):
	# One bake into a float image the size of the atlas, as an array (rows
	# from the atlas's bottom, as Blender keeps them). emit: per material,
	# a function making the shader whose emission is baked
	image = bpy.data.images.new(kind, size, size, alpha=False, float_buffer=True)
	image.colorspace_settings.name = "Non-Color"
	temporary = []
	for m in MATERIALS.values():
		nodes, links = m.node_tree.nodes, m.node_tree.links
		target = nodes.new("ShaderNodeTexImage")
		target.image = image
		nodes.active = target
		temporary.append(target)
		if emit:
			emission = nodes.new("ShaderNodeEmission")
			source = emit(m, nodes)
			links.new(source, emission.inputs["Color"])
			links.new(emission.outputs["Emission"], nodes["Material Output"].inputs["Surface"])
			temporary.append(emission)
	bpy.ops.object.bake(type="EMIT" if emit else kind, use_clear=True, margin=8, **options)
	pixels = np.array(image.pixels[:]).reshape(size, size, 4)
	for m in MATERIALS.values():
		nodes = m.node_tree.nodes
		for n in [n for n in nodes if n in temporary or n.name.startswith(("RGB", "Geometry", "Object Info"))]:
			nodes.remove(n)
		m.node_tree.links.new(nodes["Principled BSDF"].outputs["BSDF"], nodes["Material Output"].inputs["Surface"])
	bpy.data.images.remove(image)
	return pixels


def paint():
	# The atlas: every part's UVs unique, Cycles' bakes of the ambient
	# occlusion, the materials' colours, each texel's place and normal and the
	# part it lies on, then paint.py's colour over them, saved as the base
	# colour of every material but the glass
	size = LAYOUT["atlas"]
	parts = [o for o in bpy.data.objects if o.type == "MESH"]
	for o in parts:
		o.pass_index = painting.PARTS["body"] if o.name == "body" else painting.PARTS["fin"] if o.name.startswith(("wing_", "fin_", "canard_")) \
			else painting.PARTS["fittings"] if o.name == "fittings" else painting.PARTS["metal"]
	unwrap(parts)
	scene = bpy.context.scene
	scene.render.engine = "CYCLES"
	scene.cycles.device = "CPU"
	scene.cycles.samples = 32
	scene.world = scene.world or bpy.data.worlds.new("world")
	scene.world.light_settings.distance = 4 * INCH   # ambient occlusion within the fins' and fittings' reach, not the far side of the body
	shade = baked("AO", size, parts)[..., 0]
	normal = baked("NORMAL", size, parts, normal_space="OBJECT")[..., :3] * 2 - 1
	scene.cycles.samples = 1

	def colour(m, nodes):
		rgb = nodes.new("ShaderNodeRGB")
		rgb.outputs[0].default_value = COLOURS[m.name]
		return rgb.outputs[0]

	albedo = baked("albedo", size, parts, emit=colour)[..., :3]
	where = baked("where", size, parts, emit=lambda m, nodes: nodes.new("ShaderNodeNewGeometry").outputs["Position"])[..., :3]
	part = baked("part", size, parts, emit=lambda m, nodes: nodes.new("ShaderNodeObjectInfo").outputs["Object Index"])[..., 0]
	covered = np.abs(np.linalg.norm(normal, axis=-1) - 1) < 0.1
	steps = []
	for a, b in ((where[:, 1:], where[:, :-1]), (where[1:], where[:-1])):
		d = np.linalg.norm(a - b, axis=-1)
		steps.append(d[(d > 0) & (d < 0.01)])
	texel = float(np.median(np.concatenate(steps))) / INCH   # the atlas's usual texel on the missile, inches
	if "--bakes" in sys.argv:   # the bakes kept for a look at the paint without Blender: --bakes FILE.npz
		np.savez_compressed(sys.argv[sys.argv.index("--bakes") + 1], albedo=albedo, shade=shade, where=where, normal=normal, part=part, texel=texel, centre=CG)
	out = painting.colour(dict(LAYOUT, wear=value(FACTS["layout"]["wear"])), CG, albedo, shade, where, normal,
		np.rint(part).astype(int), np.full(shade.shape, texel))
	# texels no part covers: the paint, so the atlas's smaller mip levels bleed no black into the edges
	out[~covered] = np.asarray(COLOURS["paint"][:3])
	from PIL import Image
	# JPEG at quality 90, full colour resolution: a quarter of the PNG's size for a mean error of a level,
	# the paint's mottle and grain being what lossless PNG compresses worst
	path = Path(tempfile.mkdtemp()) / f"{MISSILE}.jpg"
	Image.fromarray((painting.encoded(out[::-1]) * 255 + 0.5).astype(np.uint8)).save(path, "JPEG", quality=90, subsampling=0)
	image = bpy.data.images.load(str(path))
	image.pack()
	image.name = "paint"
	for name, m in MATERIALS.items():
		if name == "glass":
			continue
		nodes = m.node_tree.nodes
		texture = nodes.new("ShaderNodeTexImage")
		texture.image = image
		m.node_tree.links.new(texture.outputs["Color"], nodes["Principled BSDF"].inputs["Base Color"])


def main():
	rest = sys.argv[sys.argv.index("--") + 2 :]
	out = [a for i, a in enumerate(rest) if not a.startswith("--") and (i == 0 or rest[i - 1] != "--bakes")]
	bpy.ops.wm.read_factory_settings(use_empty=True)
	body()
	for kind in ("canards", "wings", "fins"):
		spec = LAYOUT.get(kind)
		if not spec:
			continue
		for which in ROLLS:
			fin(kind[:-1], which, spec)
			if kind == "wings" and "rollerons" in LAYOUT:
				rolleron(which, LAYOUT["rollerons"])
	lugs()
	fittings()
	if "--draft" not in sys.argv:
		paint()
	bpy.ops.export_scene.gltf(filepath=out[0], export_format="GLB", export_yup=True, use_selection=False,
		export_apply=False, export_animations=False, export_extras=False)
	# where the missile sits on its launcher: the top of the body at the
	# station layout.mount gives (its forward lug's, or the launcher's middle)
	mount = LAYOUT["mount"] if "mount" in LAYOUT else min(LAYOUT["lugs"])
	points = {
		"length": round(LENGTH * INCH, 5), "diameter": round(2 * RADIUS * INCH, 5),
		"nose": exported(point(0)), "exit": exported(point(LENGTH)), "gravity": exported(point(CG)),
		"mount": exported(point(mount, RADIUS)),
		"lugs": [exported(point(s, RADIUS)) for s in sorted(LAYOUT["lugs"])],
	}
	document = {"frame": {"origin": {"station": CG, "about": "on the axis at the centre of gravity; stations are inches aft of the nose's tip"}},
		"joints": dict(sorted(JOINTS.items())), "points": points}
	Path(out[1]).write_text(json.dumps(document, indent="\t") + "\n")


main()
