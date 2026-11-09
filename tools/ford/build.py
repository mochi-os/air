# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# Builds our own USS Gerald R. Ford, CVN-78 (claude/plans/air-ford.md), from
# nothing on each run: every dimension comes from facts.json, whose entries
# cite their sources, and every placement from its layout, which says what each
# was measured on. It never opens the old carrier model or anything under
# apps/air/downloads.
#
# Writes the model as glTF binary and the ship file (the plan's Contract,
# ford.json): true metres in the engine's axes (x forward, y up, z starboard),
# origin on the centreline at the deployed waterline, midway between the flight
# deck's aft and forward extremes. Each moving part is a node on its hinge or
# slide line, at rest with no rotation.
#
# With a third path it also writes the features file: named points and curves
# on the model, each with the node it rides on, for the photo match
# (verify/photos.py) and the facts check.
#
# --facts PATH reads another facts file (the tests' small decks).
# --draft leaves out the deck texture (paint.py's), for quick looks at the shape.
#
# usage: blender -b --factory-startup --python-use-system-env -P build.py -- OUT.glb OUT.json [FEATURES.json] [--facts PATH] [--draft]
import itertools, json, math, subprocess, sys, tempfile
from pathlib import Path

import bmesh
import bpy
from mathutils import Matrix, Vector

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from plates import framed as plate_frame, lamps as plate_lamps  # noqa: E402
FACTS, LAYOUT = {}, {}

# Blender works z up; the glTF exporter turns its (x, y, z) into (x, z, -y).
# So here x is forward, y port and z up, and the exported frame is the ship's:
# x forward, y up, z starboard.
FORWARD, PORT, UP = Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))
AFT, STARBOARD, DOWN = -FORWARD, -PORT, -UP


def at(x, y, z):
	# A point given in the ship frame (x forward, y up, z starboard)
	return Vector((x, -z, y))


def exported(vector):
	# A point or direction in the ship frame
	return [round(vector.x, 4), round(vector.z, 4), round(-vector.y, 4)]


def plan(point):
	# A plan point [x, z] at the flight deck's height
	return at(point[0], LAYOUT["deck"]["height"], point[1])


MATERIALS = {}
# Linear base colours, provisional until the photo match measures them; the
# deck's and the lettering's come from their textures
COLOURS = {"deck": (0.16, 0.16, 0.16, 1), "grey": (0.30, 0.32, 0.33, 1), "boot": (0.02, 0.02, 0.02, 1),
	"lettering": (0.8, 0.8, 0.8, 1), "glass": (0.03, 0.04, 0.05, 1), "dark": (0.03, 0.03, 0.03, 1),
	# the radar faces' covers lighter than the haze grey round them, by eye
	# in dvids9135541
	"lights": (0.5, 0.5, 0.45, 1), "panel": (0.42, 0.44, 0.45, 1),
	# the raft canisters white and the small ones blue, by eye in the overhead;
	# the nets' cord a dirty rust-brown, by eye at the hue of their brown
	# pixels in dvids7694418 (chromaticity 0.41, 0.30, 0.28 under the shade's
	# blue light, so warmer still in white light)
	"raft": (0.62, 0.62, 0.6, 1), "blue": (0.13, 0.35, 0.52, 1), "net": (0.16, 0.09, 0.05, 1),
	# the transom's recess, its paint in shade there (0.35-0.4 of the face's
	# brightness in the same light); the drop-light bar the deck's yellow
	"recess": (0.11, 0.12, 0.12, 1), "yellow": (0.67, 0.39, 0.03, 1),
	# glass seen through: tinted, its alpha the share of light it stops; the
	# rooms behind it painted, in their own shade. Together they read as the
	# photos' windows do against their grey frames: about a quarter of the
	# frame's brightness in sun, a tenth in shade (dvids7489972, 9405715)
	"pane": (0.06, 0.07, 0.08, 0.45), "room": (0.06, 0.06, 0.065, 1),
	# the Phalanx's radome, white
	"radome": (0.7, 0.7, 0.68, 1),
	# the island's fittings: the windows' wiper motors white, the fire
	# stations' valves and extinguishers red, the signal lamps' lenses, an
	# electrical box brown (references/research/island4)
	"white": (0.62, 0.62, 0.6, 1), "red": (0.4, 0.03, 0.02, 1), "amber": (0.6, 0.3, 0.02, 1), "violet": (0.2, 0.06, 0.35, 1),
	"brown": (0.15, 0.08, 0.04, 1),
	# the railings and the nets' frames, grey as the ship's, their own so the
	# photo checks can leave them out: bars thinner than any photo resolves,
	# which the photos show the sky through
	"rail": (0.30, 0.32, 0.33, 1)}


def linear(value):
	# an sRGB channel (0-255) as the linear value a material's base colour takes
	c = value / 255
	return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def material(name):
	if name not in MATERIALS:
		m = bpy.data.materials.new(name)
		m.use_nodes = True
		m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = COLOURS[name]
		m.diffuse_color = COLOURS[name]
		if COLOURS[name][3] < 1:
			# see-through: the exporter makes an alpha under 1 glTF's BLEND
			m.node_tree.nodes["Principled BSDF"].inputs["Alpha"].default_value = COLOURS[name][3]
			m.use_backface_culling = False
		MATERIALS[name] = m
	return MATERIALS[name]


NODES, HINGES, JOINTS = {}, {}, {}
STEP = 1.5   # metres between the hull's sections
# A part stowed flush in the deck (a barricade stanchion, a console, a sunk
# sheave) sits this far under the deck's top, which hides it: level with it,
# the two surfaces fought for the same pixels and tore
STOWED = 0.02
# The features file's points and curves, each with the node it rides on: name
# to (point, node) and name to ([points], node)
MARKS, CURVES = {}, {}


def node(name, parent=None, hinge=None, mesh=None, paint="grey", smooth=False):
	# An object at `hinge` (world space). Its mesh's vertices are given in
	# world space and stored relative to the hinge. Every ancestor rests
	# unrotated, so a child's location is its hinge less its parent's.
	# `smooth` shades the whole mesh smooth, or with a list the faces it marks
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
		if isinstance(smooth, list):
			for polygon, s in zip(data.polygons, smooth):
				polygon.use_smooth = s
		data.validate()
		tidy(data, smooth)
		# a radome is smooth wherever it stands, its node's plating flat, and
		# sharp where its profile steps (a seam's flange): only the radome's
		# faces made smooth, and every edge past 30 degrees sharp
		if not smooth and SMOOTHED & set(paints):
			bm = bmesh.new()
			bm.from_mesh(data)
			smoothed = {names.index(n) for n in SMOOTHED if n in names}
			for f in bm.faces:
				f.smooth = f.material_index in smoothed
			for e in bm.edges:
				if len(e.link_faces) == 2 and e.calc_face_angle(0.0) > math.radians(30):
					e.smooth = False
			bm.to_mesh(data)
			bm.free()
	obj = bpy.data.objects.new(name, data)
	bpy.context.scene.collection.objects.link(obj)
	if parent:
		obj.parent = NODES[parent]
	obj.location = hinge - (HINGES[parent] if parent else Vector())
	NODES[name], HINGES[name] = obj, hinge.copy()
	return obj


SMOOTHED = {"radome"}   # paints drawn smooth in a flat node: turned and spherical shells


def tidy(data, smooth):
	# Welds coincident vertices and turns every face outward. A ship is mostly
	# flat plate: smooth shading only where asked, and then sharp above 30
	# degrees. Asked per face (a list), the faces keep their marks (a flat
	# face's normal is its own, whatever its neighbours)
	bm = bmesh.new()
	bm.from_mesh(data)
	bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
	# only a closed mesh has an outside to turn to; an open one (the deck's
	# top, its edge plate) keeps the winding it was built with
	if all(len(e.link_faces) == 2 for e in bm.edges):
		bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
	if isinstance(smooth, list):
		for e in bm.edges:
			e.smooth = e.calc_face_angle(0.0) <= math.radians(30)
	bm.to_mesh(data)
	bm.free()
	if isinstance(smooth, list):
		return
	if smooth:
		data.shade_smooth()
		data.set_sharp_from_angle(angle=math.radians(30))
	else:
		data.shade_flat()


def joint(name, axis, arm, want, drive, keys, motion="rotate"):
	# Records a joint. The axis is turned so that a positive angle moves `arm`
	# (from the hinge toward the moving part) toward `want`, or a positive
	# slide moves along `want`.
	axis = axis.normalized()
	if (axis.cross(arm).dot(want) if motion == "rotate" else axis.dot(want)) < 0:
		axis = -axis
	JOINTS[name] = {"motion": motion, "axis": exported(axis), "drive": drive, "keys": keys}


def area(outline):
	# Signed area of a plan polygon [[x, z], ...]: positive when it runs
	# clockwise seen from above (x forward, z starboard), as stern to bow up
	# the port side does
	return sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(outline, outline[1:] + outline[:1])) / 2


def inside(point, outline):
	# Whether a plan point [x, z] lies inside a plan polygon (even-odd)
	x, z = point
	result = False
	for (ax, az), (bx, bz) in zip(outline, outline[1:] + outline[:1]):
		if (az > z) != (bz > z) and x < ax + (z - az) * (bx - ax) / (bz - az):
			result = not result
	return result


def inset(outline, distance):
	# A convex plan polygon [[x, z], ...] with each side moved `distance` in,
	# square to itself, its corners where the moved sides meet
	cx, cz = sum(p[0] for p in outline) / len(outline), sum(p[1] for p in outline) / len(outline)
	lines = []
	for a, b in zip(outline, outline[1:] + outline[:1]):
		length = math.hypot(b[0] - a[0], b[1] - a[1])
		dx, dz = (b[0] - a[0]) / length, (b[1] - a[1]) / length
		nx, nz = -dz, dx
		if (cx - a[0]) * nx + (cz - a[1]) * nz < 0:
			nx, nz = -nx, -nz   # inward
		lines.append((a[0] + nx * distance, a[1] + nz * distance, dx, dz))
	corners = []
	for (ax, az, adx, adz), (bx, bz, bdx, bdz) in zip(lines[-1:] + lines[:-1], lines):
		t = ((bx - ax) * bdz - (bz - az) * bdx) / (adx * bdz - adz * bdx)
		corners.append([ax + adx * t, az + adz * t])
	return corners


def slab(outline, top, bottom, paints=("grey", "grey", "grey")):
	# A plan polygon [[x, z], ...] between two heights: (vertices, faces,
	# materials), the top, bottom and sides painted as given
	ring = outline if area(outline) < 0 else outline[::-1]   # anticlockwise from above, so the top faces up
	n = len(ring)
	vertices = [at(x, top, z) for x, z in ring] + [at(x, bottom, z) for x, z in ring]
	faces = [tuple(range(n)), tuple(range(2 * n - 1, n - 1, -1))]
	faces += [(i, n + i, n + (i + 1) % n, (i + 1) % n) for i in range(n)]
	return vertices, faces, [paints[0], paints[1]] + [paints[2]] * n


def prism(outline, bottom, top, upper=None, paint="grey"):
	# A plan polygon from `bottom` to `top`, its plan at the top `upper` (as
	# many corners, in step) where its faces slope. A bottom or top given as a
	# list is a height per corner, for one that slopes.
	upper = upper or outline
	n = len(outline)
	bottom = list(bottom) if isinstance(bottom, list) else [bottom] * n
	top = list(top) if isinstance(top, list) else [top] * n
	if area(outline) > 0:
		outline, upper, bottom, top = outline[::-1], upper[::-1], bottom[::-1], top[::-1]
	vertices = [at(x, y, z) for (x, z), y in zip(upper, top)] + [at(x, y, z) for (x, z), y in zip(outline, bottom)]
	faces = [tuple(range(n)), tuple(range(2 * n - 1, n - 1, -1))]
	faces += [(i, n + i, n + (i + 1) % n, (i + 1) % n) for i in range(n)]
	return vertices, faces, [paint] * len(faces)


def primitive(make):
	# (vertices, faces) of a closed bmesh primitive that make(bm) adds
	bm = bmesh.new()
	make(bm)
	bm.verts.index_update()
	vertices = [v.co.copy() for v in bm.verts]
	faces = [tuple(v.index for v in f.verts) for f in bm.faces]
	bm.free()
	return vertices, faces


def dome(centre, radius, plinth):
	# A radome: a sphere on a cylinder reaching `plinth` below its centre, the
	# sphere in the radomes' light, smooth paint (the plinth the face's grey)
	c = at(*centre)
	sphere = primitive(lambda bm: bmesh.ops.create_uvsphere(bm, u_segments=48, v_segments=24, radius=radius, matrix=Matrix.Translation(c)))
	pieces = [(sphere[0], sphere[1], ["radome"] * len(sphere[1]))]
	if plinth > 0:
		middle = c + DOWN * (plinth / 2)
		pieces.append(primitive(lambda bm: bmesh.ops.create_cone(bm, cap_ends=True, segments=48, radius1=radius, radius2=radius,
			depth=plinth, matrix=Matrix.Translation(middle))))
	return merge(pieces)


def lathe(centre, profile, radome=None, segments=48, paint="grey"):
	# A solid turned about an upright axis at centre [x, z]: profile [[y,
	# radius], ...] from its foot up, a radius of 0 closing it to a point, an
	# end left open closed by a flat cap; the bands above `radome` in the
	# radomes' paint, below it `paint`
	x, z = centre
	vertices, rings = [], []
	for y, r in profile:
		if r <= 1e-6:
			rings.append([len(vertices)])
			vertices.append(at(x, y, z))
			continue
		rings.append(list(range(len(vertices), len(vertices) + segments)))
		vertices += [at(x + r * math.cos(2 * math.pi * k / segments), y, z + r * math.sin(2 * math.pi * k / segments)) for k in range(segments)]
	# wound outward as built: a profile running up winds each band out from
	# the axis (down on a ledge stepping out, up on one stepping in), the foot's
	# cap down and the top's up
	faces, paints = [], []
	for i, (low, high) in enumerate(zip(rings, rings[1:])):
		band = "radome" if radome is not None and (profile[i][0] + profile[i + 1][0]) / 2 > radome else paint
		for k in range(segments):
			a, b = k, (k + 1) % segments
			if len(low) == 1 and len(high) == 1:
				continue
			faces.append((low[0], high[a], high[b]) if len(low) == 1 else (low[a], high[0], low[b]) if len(high) == 1 else (low[a], high[a], high[b], low[b]))
			paints.append(band)
	if len(rings[0]) > 1:
		faces.append(tuple(rings[0]))
		paints.append(paint)
	if len(rings[-1]) > 1:
		faces.append(tuple(reversed(rings[-1])))
		paints.append("radome" if radome is not None and profile[-1][0] > radome else paint)
	return vertices, faces, paints


def lamps(plate, cell, centre):
	# The lamps round a lettering cell's shapes (plates.py), each a short
	# cylinder standing out from the plate's face
	spec = cell["lamps"]
	return [shape({"kind": "cylinder", "base": list(foot), "axis": list(out), "length": spec["depth"], "radius": spec["diameter"] / 2,
		"segments": 6, "paint": "lights"}) for foot, out in plate_lamps(plate, cell, centre)]


def pole(base, bottom, top, radius):
	middle = at(base[0], (bottom + top) / 2, base[1])
	return merge([primitive(lambda bm: bmesh.ops.create_cone(bm, cap_ends=True, segments=8, radius1=radius, radius2=radius,
		depth=top - bottom, matrix=Matrix.Translation(middle)))])


def box(centre, along, across, length, width, height, paint="grey", top=1.0):
	# A box standing on `centre`'s height: length along `along`, width across
	# it. top < 1 narrows its top to that share of the width, its sides and
	# ends sloping in alike
	along, across = along.normalized(), across.normalized()
	corners = []
	for z, w, l in ((0, width, length), (height, width * top, length - width * (1 - top))):
		for a, b in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
			corners.append(centre + along * (a * l / 2) + across * (b * w / 2) + UP * z)
	faces = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
	return corners, faces, [paint] * 6


def merge(pieces):
	vertices, faces, paints = [], [], []
	for piece in pieces:
		offset = len(vertices)
		vertices += piece[0]
		faces += [tuple(i + offset for i in f) for f in piece[1]]
		paints += list(piece[2]) if len(piece) > 2 else ["grey"] * len(piece[1])
	return vertices, faces, paints


def round_down(d):
	# The round-down (deck.round): the deck curving down to its aft edge over
	# `length`, `drop` at the edge, leaving the flat deck level (a parabola in
	# the distance from the edge), and the edge plate's foot falling to
	# `fascia` there. Returns the plan distance from the edge, the top's and the
	# plate foot's heights at a plan point, and the cut distances
	r = d.get("round")
	top, bottom = d["height"], d["height"] - d["thickness"]
	if not r:
		return None
	(ax, az), (bx, bz) = r["edge"]
	length = math.hypot(bx - ax, bz - az)
	ex, ez = (bx - ax) / length, (bz - az) / length
	# inward: toward the deck's middle
	mx = sum(p[0] for p in d["outline"]) / len(d["outline"])
	mz = sum(p[1] for p in d["outline"]) / len(d["outline"])
	nx, nz = -ez, ex
	if (mx - ax) * nx + (mz - az) * nz < 0:
		nx, nz = -nx, -nz
	span, drop = r["length"], r["drop"]

	def distance(x, z):
		return (x - ax) * nx + (z - az) * nz

	def share(x, z):
		# 1 at the edge, 0 where the round-down meets the flat deck
		t = max(0.0, 1.0 - distance(x, z) / span)
		return t * t

	def height(x, z):
		return top - drop * share(x, z)

	def foot(x, z):
		return bottom - (bottom - r.get("fascia", bottom - drop)) * share(x, z)

	steps = r.get("steps", 6)
	cuts = [span * k / steps for k in range(1, steps + 1)]
	return {"distance": distance, "height": height, "foot": foot, "cuts": cuts, "inward": (nx, nz), "edge": (ax, az)}


def rounded_ring(ring, shape):
	# The deck's ring with a point wherever an edge crosses a round-down cut,
	# so the edge plate follows the curve and not a slope between corners
	if not shape:
		return ring
	out = []
	for a, b in zip(ring, ring[1:] + ring[:1]):
		out.append(a)
		da, db = shape["distance"](*a), shape["distance"](*b)
		crossings = []
		for c in shape["cuts"]:
			if (da - c) * (db - c) < 0:
				t = (c - da) / (db - da)
				crossings.append((t, [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]))
		out += [q for _, q in sorted(crossings)]
	return out


def flight_deck():
	# The flight deck: its top (`deck`, the painted texture), its edge plate
	# (`deck_skirt`) and the underside of its overhang (`deck_underside`). The
	# elevators' platforms are their own nodes, so the outline leaves them out.
	# Where the deck rounds down to its aft edge (deck.round) the top is cut
	# along the edge at each step of the curve and lowered to it, and the edge
	# plate follows
	d = LAYOUT["deck"]
	top, bottom = d["height"], d["height"] - d["thickness"]
	outline = d["outline"]
	shape = round_down(d)
	ring = rounded_ring(outline if area(outline) < 0 else outline[::-1], shape)
	n = len(ring)
	node("deck", mesh=([at(x, top, z) for x, z in ring], [tuple(range(n))], ["deck"]))
	data = NODES["deck"].data
	bm = bmesh.new()
	bm.from_mesh(data)
	bmesh.ops.triangulate(bm, faces=bm.faces, quad_method="BEAUTY", ngon_method="BEAUTY")
	if shape:
		# cut along the edge at each step, then each vertex to the curve
		(ax, az), (nx, nz) = shape["edge"], shape["inward"]
		hinge = HINGES["deck"]
		for c in shape["cuts"]:
			point = at(ax + nx * c, top, az + nz * c) - hinge
			bmesh.ops.bisect_plane(bm, geom=list(bm.verts) + list(bm.edges) + list(bm.faces), plane_co=point, plane_no=at(nx, 0, nz))
		bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=1e-4)   # a cut through a point the ring already has there
		bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3], quad_method="BEAUTY", ngon_method="BEAUTY")
		for v in bm.verts:
			p = v.co + hinge
			x, z = p.x, -p.y
			v.co.z = shape["height"](x, z) - hinge.z
	bm.to_mesh(data)
	bm.free()
	painted("deck")
	sides = [(i, n + i, n + (i + 1) % n, (i + 1) % n) for i in range(n)]
	height = shape["height"] if shape else (lambda x, z: top)
	foot = shape["foot"] if shape else (lambda x, z: bottom)
	vertices = [at(x, height(x, z), z) for x, z in ring] + [at(x, foot(x, z), z) for x, z in ring]
	node("deck_skirt", mesh=(vertices, sides, ["grey"] * n))
	node("deck_underside", mesh=([at(x, bottom, z) for x, z in ring[::-1]], [tuple(range(n))], ["grey"]))
	for name, (x, z) in d.get("marks", {}).items():
		MARKS[f"deck_{name}"] = (at(x, height(x, z), z), "deck")
	CURVES["deck_edge"] = ([at(x, height(x, z), z) for x, z in rounded_ring(outline, shape)], "deck")


def painted(name):
	# UVs on a node's faces that wear the deck's paint, from their places at
	# rest: u runs stern to bow across the texture's x extent, v from
	# starboard (0) to port (1), so the image reads as the deck seen from
	# above with the bow to the right
	(x0, x1), (z0, z1) = LAYOUT["deck"]["texture"]["x"], LAYOUT["deck"]["texture"]["z"]
	obj = NODES[name]
	data = obj.data
	index = [i for i, m in enumerate(data.materials) if m.name == "deck"]
	uv = data.uv_layers.new(name="deck")
	for polygon in data.polygons:
		for loop in polygon.loop_indices:
			co = HINGES[name] + data.vertices[data.loops[loop].vertex_index].co
			x, z = co.x, -co.y
			uv.data[loop].uv = ((x - x0) / (x1 - x0), (z1 - z) / (z1 - z0)) if polygon.material_index in index else (0, 0)


def elevators():
	# Each deck-edge elevator's platform, a node sliding down its trunk.
	# Decision 14 keeps them at deck level, so the keys run to the hangar deck
	# but nothing drives them yet.
	d = LAYOUT["deck"]
	for e in LAYOUT.get("elevators", []):
		name = f"elevator_{e['number']}"
		top = d["height"]
		x = sum(p[0] for p in e["outline"]) / len(e["outline"])
		z = sum(p[1] for p in e["outline"]) / len(e["outline"])
		node(name, hinge=at(x, top, z), mesh=slab(e["outline"], top, top - e["thickness"], ("deck", "dark", "grey")))
		painted(name)
		joint(name, UP, Vector(), DOWN, "none yet (decision 14)", [[0, 0], [1, e["travel"]]], motion="slide")
		for i, (px, pz) in enumerate(e["outline"]):
			MARKS[f"{name}_corner_{i + 1}"] = (at(px, top, pz), name)


def catapults():
	# Each catapult's shuttle (sliding forward along its track from battery)
	# and its blast deflector (hinged at its forward edge, rising behind the
	# jet). Their shapes are the photos' (layout.fittings); their places the
	# deck plan's.
	fittings = LAYOUT["fittings"]
	top = LAYOUT["deck"]["height"]
	for c in LAYOUT.get("catapults", []):
		number = c["number"]
		(ax, az), (fx, fz) = c["track"]
		along = (at(fx, top, fz) - at(ax, top, az)).normalized()
		across = UP.cross(along).normalized()
		battery = at(c["battery"][0], top, c["battery"][1])
		s = fittings["shuttle"]
		name = f"catapult_{number}_shuttle"
		node(name, hinge=battery, mesh=box(battery, along, across, s["length"], s["width"], s["height"], top=s.get("top", 1.0)))
		joint(name, along, Vector(), along, "the flight core's launch", [[0, 0], [1, c["stroke"]]], motion="slide")
		MARKS[f"{name}_top"] = (battery + UP * s["height"], name)
		f = c.get("deflector")
		if f:
			# its hinge is its forward edge, given by its two ends: the Ford's
			# lie square to the ship, not to their tracks
			ends = [at(p[0], top, p[1]) for p in f["hinge"]]
			hinge = (ends[0] + ends[1]) / 2
			width = (ends[1] - ends[0]).length
			edge = (ends[1] - ends[0]).normalized()
			aft = UP.cross(edge).normalized()
			if aft.dot(FORWARD) > 0:
				aft = -aft
			name = f"catapult_{number}_deflector"
			# flush, its top is the deck's paint (the engine's taxi face)
			t = fittings["deflector"]["thickness"]
			vertices, faces, paints = box(hinge + aft * (f["depth"] / 2) + DOWN * t, -aft, edge, f["depth"], width, t)
			paints[1] = "deck"
			node(name, hinge=hinge, mesh=(vertices, faces, paints))
			painted(name)
			angle = math.radians(fittings["deflector"]["angle"])
			joint(name, edge, aft, UP, "raised behind a jet on the catapult", [[0, 0], [1, round(angle, 4)]])


def consoles():
	# The catapults' integrated control stations (ICCS): each a cab sunk in the
	# surface it sits in (`top`, the deck's unless given) and rising `rise` out
	# of it while its catapults are manned. Its lid is the layout's `outline`,
	# a plate `lid` thick whose top wears the deck's paint (stowed, that top
	# lies STOWED under the surface); under it a darker tier `tier` deep, set in
	# by as much; then the body, its faces leaning in from its foot (`inset[0]`
	# inside the outline) to its top (`inset[1]`), `panes` windows in each face
	# (a count a side, from the outline's first corner) in frames `frame`
	# wide; and under its foot a skirt `skirt` deep, which stays below the
	# surface when it is raised
	k = LAYOUT["fittings"]["console"]
	for c in LAYOUT.get("consoles", []):
		surface = c.get("top", LAYOUT["deck"]["height"])
		lid, tier = c.get("lid", k["lid"]), c.get("tier", k["tier"])
		travel = c["rise"] + STOWED
		# its heights at rest: raised, less the travel
		top = surface - STOWED
		foot = surface - travel
		head = top - lid - tier
		vertices, faces, paints = prism(c["outline"], top - lid, top)
		paints[0] = "deck"   # prism()'s first face is its top
		pieces = [(vertices, faces, paints)]
		if tier > 0:
			pieces.append(prism(inset(c["outline"], tier), head, top - lid, paint="dark"))
		low, high = inset(c["outline"], c["inset"][0]), inset(c["outline"], c["inset"][1])
		pieces += [prism(low, foot, head, upper=high), prism(low, foot - k["skirt"], foot)]
		cx, cz = sum(p[0] for p in low) / len(low), sum(p[1] for p in low) / len(low)
		n = len(low)
		for i, count in enumerate(c.get("panes", [1] * n)):
			if not count:
				continue
			# the face's corners: A and B at its foot, C above B and D above A
			A, B = Vector((low[i][0], foot, low[i][1])), Vector((low[(i + 1) % n][0], foot, low[(i + 1) % n][1]))
			C, D = Vector((high[(i + 1) % n][0], head, high[(i + 1) % n][1])), Vector((high[i][0], head, high[i][1]))
			normal = (B - A).cross(D - A).normalized()
			if normal.dot(Vector(((A.x + B.x) / 2 - cx, 0, (A.z + B.z) / 2 - cz))) < 0:
				normal = -normal   # outward
			span, rake = (B - A).length, (D - A).length
			sa, ta = k["frame"] / span, k["frame"] / rake
			width = (1 - 2 * sa - (count - 1) * sa) / count
			point = lambda s, t: (A + (B - A) * s) * (1 - t) + (D + (C - D) * s) * t + normal * 0.005
			for j in range(count):
				s0 = sa + j * (width + sa)
				corners = [point(s0, ta), point(s0 + width, ta), point(s0 + width, 1 - ta), point(s0, 1 - ta)]
				pieces.append(plate([list(q) for q in corners], list(normal), 0.02, "glass"))
		name = f"catapult_console_{c['name']}"
		node(name, hinge=at(cx, foot, cz), mesh=merge(pieces))
		painted(name)
		joint(name, UP, Vector(), UP, "raised while its catapults are manned", [[0, 0], [1, round(travel, 4)]], motion="slide")


def arresting():
	# The arresting gear's deck fittings: each pendant's round sheaves, raised
	# while it is rigged and sinking under the deck when it is not; the leaf-spring
	# supports under it, which a wheel or the hook presses flat; and the
	# barricade's stanchions, lying in their trays under the deck and rising about
	# their heads. The pendants themselves are the engine's, drawn between
	# their ends (decision 25).
	landing = LAYOUT.get("landing", {})
	fittings = LAYOUT["fittings"]
	top = LAYOUT["deck"]["height"]
	(ax, az), (fx, fz) = landing.get("line", [[0, 0], [1, 0]])
	along = (at(fx, top, fz) - at(ax, top, az)).normalized()
	across = UP.cross(along).normalized()
	# the sheaves in their own white where the facts give it
	paint = "grey"
	if "colour" in fittings.get("sheave", {}):
		COLOURS["sheave"] = tuple(linear(c) for c in fittings["sheave"]["colour"]) + (1,)
		paint = "sheave"
	for sheave in landing.get("sheaves", []):
		k = fittings["sheave"]
		base = plan(sheave["centre"])
		name = sheave["name"].replace("_port", "_sheave_port").replace("_starboard", "_sheave_starboard")
		node(name, hinge=base + UP * k["height"], paint=paint, mesh=primitive(lambda bm: bmesh.ops.create_cone(bm, cap_ends=True,
			segments=16, radius1=k["diameter"] / 2, radius2=k["diameter"] / 2, depth=k["height"],
			matrix=Matrix.Translation(base + UP * (k["height"] / 2)))))
		joint(name, DOWN, Vector(), DOWN, "its wire's: sunk under the deck while the wire is not rigged", [[0, 0], [1, round(k["height"] + STOWED, 4)]], motion="slide")
	for support in landing.get("supports", []):
		k = fittings["support"]
		base = plan(support["centre"])
		name = f"wire_{support['wire']}_support_{support['number']}"
		node(name, hinge=base + UP * k["height"], mesh=box(base, along, across, k["length"], k["width"], k["height"]))
		joint(name, DOWN, Vector(), DOWN, "pressed flat by a wheel or the hook; nothing drives it yet", [[0, 0], [1, round(k["height"] + STOWED, 4)]], motion="slide")
	for stanchion in landing.get("barricade", {}).get("stanchions", []):
		k = fittings["stanchion"]
		hinge, tip = plan(stanchion["hinge"]), plan(stanchion["tip"])
		run = tip - hinge
		name = f"barricade_{stanchion['side']}"
		# stowed: its top just under the deck's
		node(name, hinge=hinge, mesh=box(hinge + run / 2 + DOWN * (k["thickness"] + STOWED), run, UP.cross(run), run.length, k["width"], k["thickness"]))
		joint(name, UP.cross(run), run, UP, "none yet: rigged for a barricade arrestment", [[0, 0], [1, round(math.pi / 2, 4)]])


def shape(p, frame=None):
	# One part of the layout's (layout.island.details, a weapon kind's parts, a
	# mast's fittings) as (vertices, faces, paints), its points in the ship's
	# frame, or carried by `frame` (a matrix on Blender's points) from a
	# kind's own: box {centre, size [x, y, z]}; cylinder {base, axis and
	# length, or end; radius; segments}; prism {outline, bottom, top}; railing
	# {path, height, posts}: a top and a mid rail and posts; dish {centre,
	# diameter, facing}: a disc; dome {centre, radius}: a sphere; lathe
	# {centre [x, z], profile, radome}: turned about an upright axis (lathe());
	# path {path, size, round, closed}: bars along a line, round ones as
	# cylinders; ladder {bottom, top, along [x, z], width, rungs}: two stiles
	# and rungs; stair {bottom, top, width, railing}: a girder, treads and a
	# railing either side; plate {corners, outward, thickness}: a slab on a
	# face; ring {centre, facing, outer, inner, thickness, sweep}: a flat ring
	# standing out along `facing` (a life ring, a chock's rim), or with
	# `sweep` [from, to] only that arc of it (a deck circle the deck's edge
	# cuts)
	paint = p.get("paint", "rail" if p["kind"] in ("railing", "ladder") else "grey")
	kind = p["kind"]
	if kind == "box":
		(cx, cy, cz), (sx, sy, sz) = p["centre"], p["size"]
		corners = [at(cx + i * sx / 2, cy + j * sy / 2, cz + k * sz / 2) for j in (-1, 1) for i, k in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
		piece = (corners, [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)], [paint] * 6)
	elif kind in ("cylinder", "dish"):
		if kind == "dish":
			radius, length = p["diameter"] / 2, 0.12
			facing = Vector(p.get("facing", [-1, 0, 0])).normalized()
			a = Vector(p["centre"]) - facing * (length / 2)
			b = a + facing * length
		else:
			radius = p["radius"]
			a = Vector(p["base"])
			b = Vector(p["end"]) if "end" in p else a + Vector(p["axis"]).normalized() * p["length"]
		a, b = at(*a), at(*b)
		turn = Vector((0, 0, 1)).rotation_difference((b - a).normalized()).to_matrix().to_4x4()
		place = Matrix.Translation((a + b) / 2) @ turn
		vertices, faces = primitive(lambda bm: bmesh.ops.create_cone(bm, cap_ends=True, segments=p.get("segments", 12), radius1=radius,
			radius2=radius, depth=(b - a).length, matrix=place))
		piece = (vertices, faces, [paint] * len(faces))
	elif kind == "lathe":
		piece = lathe(p["centre"], p["profile"], p.get("radome"), p.get("segments", 48), paint)
	elif kind == "plate":
		piece = plate(p["corners"], p["outward"], p.get("thickness", 0.03), paint)
	elif kind == "path":
		points = p["path"] + (p["path"][:1] if p.get("closed") else [])
		size = p["size"]
		if p.get("round"):
			piece = merge([shape({"kind": "cylinder", "base": a, "end": b, "radius": size / 2, "segments": 6, "paint": paint})
				for a, b in zip(points, points[1:])])
		else:
			piece = merge([bar(a, b, size, paint) for a, b in zip(points, points[1:])])
	elif kind == "ladder":
		# two stiles `width` apart along the face, a rung every `rungs`
		(x, y, z), top = p["bottom"], p["top"]
		ax, az = p["along"]
		h = p["width"] / 2
		pieces = [bar([x + ax * k * h, y, z + az * k * h], [x + ax * k * h, top, z + az * k * h], 0.06, paint) for k in (-1, 1)]
		count = int((top - y) / p.get("rungs", 0.3))
		for i in range(1, count + 1):
			r = y + i * (top - y) / (count + 1)
			pieces.append(bar([x - ax * h, r, z - az * h], [x + ax * h, r, z + az * h], 0.035, paint))
		piece = merge(pieces)
	elif kind == "stair":
		# a box girder under its middle, a tread every 0.2 m of rise, and a
		# railing along either edge
		a, b = Vector(p["bottom"]), Vector(p["top"])
		run = Vector((b.x - a.x, 0, b.z - a.z)).normalized()
		side = Vector((-run.z, 0, run.x)) * (p["width"] / 2)
		pieces = [bar(list(a - Vector((0, 0.3, 0))), list(b - Vector((0, 0.3, 0))), 0.4, p.get("paint", "grey"))]
		count = max(1, int((b.y - a.y) / 0.2))
		for i in range(count + 1):
			q = a + (b - a) * (i / count)
			pieces.append(bar(list(q - side), list(q + side), 0.05, p.get("paint", "grey")))
		for k in (-1, 1):
			pieces.append(shape({"kind": "railing", "path": [list(a + side * k), list(b + side * k)], "height": p.get("railing", 1.0)}))
		piece = merge(pieces)
	elif kind == "prism":
		piece = prism(p["outline"], p["bottom"], p["top"], paint=paint)
	elif kind == "ring":
		piece = ring(p["centre"], p["facing"], p["outer"], p["inner"], p.get("thickness", 0.1), p.get("segments", 16), paint, p.get("sweep"))
	elif kind == "dome":
		c, r = at(*p["centre"]), p["radius"]
		vertices, faces = primitive(lambda bm: bmesh.ops.create_uvsphere(bm, u_segments=32, v_segments=16, radius=r, matrix=Matrix.Translation(c)))
		piece = (vertices, faces, [paint] * len(faces))
	elif kind == "railing":
		# rails along the path, posts evenly along each straight run from
		# corner to corner, or, where the path is `bent` (one rail bent round a
		# rounded corner's many short runs), evenly along the whole of it
		height, rails, path = p["height"], [], p["path"]
		for a, b in zip(path, path[1:]):
			for rise, size in ((height, 0.05), (height / 2, 0.04)):
				rails.append(bar([a[0], a[1] + rise, a[2]], [b[0], b[1] + rise, b[2]], size, paint))
		for run in ([path] if p.get("bent") else [[a, b] for a, b in zip(path, path[1:])]):
			for q, _ in along_line([[v[0], v[2]] for v in run], p.get("posts", 1.5)):
				rails.append(bar([q[0], level(run, q), q[1]], [q[0], level(run, q) + height, q[1]], 0.05, paint))
		piece = merge(rails)
	else:
		raise ValueError(f"part {p.get('name')}: unknown kind {kind}")
	if frame is not None:
		piece = ([frame @ v for v in piece[0]], piece[1], piece[2])
	return piece


def ring(centre, facing, outer, inner, thickness, segments, paint, sweep=None):
	# A flat ring round `centre` (ship frame) in the plane square to `facing`,
	# from `inner` to `outer` radius, standing `thickness` out along `facing`.
	# With `sweep` [from, to] (degrees in plan, from forward toward starboard,
	# for a ring facing up) only that arc, its ends closed
	n = Vector(facing).normalized()
	c = Vector(centre)
	if sweep is None:
		u = n.cross(Vector((0, 1, 0)) if abs(n.y) < 0.9 else Vector((1, 0, 0))).normalized()
		w = n.cross(u)
		directions = [u * math.cos(2 * math.pi * k / segments) + w * math.sin(2 * math.pi * k / segments) for k in range(segments)]
	else:
		def direction(degrees):
			d = Vector((math.cos(math.radians(degrees)), 0, math.sin(math.radians(degrees))))
			return (d - n * d.dot(n)).normalized()
		directions = [direction(sweep[0] + (sweep[1] - sweep[0]) * k / segments) for k in range(segments + 1)]
	count = len(directions)
	points = [at(*(c + n * depth + d * radius)) for depth in (0.0, thickness) for radius in (outer, inner) for d in directions]
	ring_of = lambda layer, which: layer * 2 * count + which * count   # the first vertex of a loop
	faces = []
	for k in range(segments):
		j = (k + 1) % count
		for a, b in ((ring_of(0, 0), ring_of(0, 1)), (ring_of(1, 0), ring_of(1, 1)), (ring_of(0, 0), ring_of(1, 0)), (ring_of(0, 1), ring_of(1, 1))):
			faces.append((a + k, a + j, b + j, b + k))
	if sweep is not None:
		for k in (0, segments):
			faces.append((ring_of(0, 0) + k, ring_of(0, 1) + k, ring_of(1, 1) + k, ring_of(1, 0) + k))
	return points, faces, [paint] * len(faces)


def rounded(corners, radius, steps=3):
	# A rectangle's corners (ship frame, in order round it) with each rounded
	# off at `radius` (at most half a side), as a polygon
	out = []
	n = len(corners)
	for k in range(n):
		p, a, b = Vector(corners[k]), Vector(corners[k - 1]), Vector(corners[(k + 1) % n])
		r = min(radius, (a - p).length / 2, (b - p).length / 2)
		u, w = (a - p).normalized(), (b - p).normalized()
		middle = p + (u + w) * r
		for i in range(steps + 1):
			t = i / steps * math.pi / 2
			out.append(list(middle - w * r * math.cos(t) - u * r * math.sin(t)))
	return out


def sheet(polygon, outward, thickness, paint):
	# A polygon (ship frame) made a sheet `thickness` thick along `outward`
	n = len(polygon)
	out = Vector(outward).normalized() * thickness
	vertices = [at(*q) for q in polygon] + [at(*(Vector(q) + out)) for q in polygon]
	faces = [tuple(range(n)), tuple(range(2 * n - 1, n - 1, -1))] + [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
	return vertices, faces, [paint] * len(faces)


def mounted(m):
	# A weapon's mount: its kind's parts carried to its foot, trained (its
	# line of fire from the ship's +x toward +z) and elevated; on a pedestal
	# from below its foot where it has one
	frame = Matrix.Translation(at(*m["foot"])) @ Matrix.Rotation(-math.radians(m.get("train", 0)), 4, "Z") @ Matrix.Rotation(
		-math.radians(m.get("elevation", 0)), 4, "Y")
	pieces = [shape(p, frame) for p in LAYOUT["weapons"]["kinds"][m["kind"]]["parts"]]
	if m.get("pedestal"):
		x, y, z = m["foot"]
		pieces.append(shape({"kind": "cylinder", "base": [x, y - m["pedestal"], z], "axis": [0, 1, 0], "length": m["pedestal"], "radius": 1.0}))
	return pieces


def antennas():
	# The deck-edge antennas: the whips that lower for flight operations, upright
	# at rest, and the bow's mast, which stands through launches and is built
	# fixed
	fittings = LAYOUT["fittings"]
	top = LAYOUT["deck"]["height"]
	mounts = []
	for a in LAYOUT.get("antennas", []):
		name = f"antenna_{a['name']}"
		base = plan(a["base"])
		if a.get("width"):
			# a square mast, with its fittings on it
			(x, z), w = a["base"], a["width"]
			pieces = [prism([[x - w / 2, z - w / 2], [x + w / 2, z - w / 2], [x + w / 2, z + w / 2], [x - w / 2, z + w / 2]], top, top + a["length"])]
			pieces += [shape(p) for p in a.get("details", [])]
			node(name, hinge=base, mesh=merge(pieces))
		else:
			radius = fittings["antenna"]["radius"] * (1 if a.get("lowered") else 2.5)
			node(name, hinge=base, mesh=pole(a["base"], top, top + a["length"], radius))
		if a.get("mount"):
			# its hinge's housing at the deck's edge, which stays as the whip lowers
			(x, z), (sx, sy, sz) = a["base"], a["mount"]
			mounts.append(shape({"kind": "box", "centre": [x, top - sy / 2, z], "size": [sx, sy, sz]}))
		if a.get("lowered"):
			lowered = at(a["lowered"][0], 0, a["lowered"][1]).normalized()
			joint(name, UP.cross(lowered), UP, lowered, "lowered for flight operations", [[0, 0], [1, round(math.pi / 2, 4)]])
	if mounts:
		node("antenna_mounts", mesh=merge(mounts))


def island():
	# The island: prisms level by level (sloped where a prism's plan at its
	# top differs from its bottom's), radomes on plinths and the mast's poles,
	# one fixed node standing on the deck
	i = LAYOUT.get("island")
	if not i:
		return
	blocks = [prism(p["outline"], p["bottom"], p["top"], p.get("upper")) for p in i.get("prisms", [])]
	extras = [lathe(d["centre"], d["profile"], d.get("radome")) if "profile" in d else dome(d["centre"], d["radius"], d.get("plinth", 0))
		for d in i.get("domes", [])]
	extras += [pole(p["base"], p["bottom"], p["top"], p["radius"]) for p in i.get("poles", [])]
	glazing = []
	if not i.get("cabs"):
		node("island", mesh=merge(blocks + extras))
	else:
		# the glazed levels cut from the blocks alone, the domes and poles
		# joined in after, which the cuts would otherwise trim where they meet
		# the roof; their glass and fittings go with the details, which stand
		# off the body (the engine's crash box is the body's)
		node("island", mesh=merge(blocks))
		glazing = glazed(NODES["island"], i["cabs"])
		if extras:
			node("island_extras", mesh=merge(extras))
			joined("island", "island_extras")
	# its windows (glass) and the radar's faces (panel), on its faces; a
	# glazed level's windows are its cab's panes
	middle = [sum(c[0] for p in i.get("prisms", []) for c in p["outline"]) / max(1, sum(len(p["outline"]) for p in i.get("prisms", []))),
		sum(c[1] for p in i.get("prisms", []) for c in p["outline"]) / max(1, sum(len(p["outline"]) for p in i.get("prisms", [])))]
	cells = LAYOUT.get("lettering", {}).get("cells", {})
	lit = [piece for p in LAYOUT.get("lettering", {}).get("plates", []) if p.get("on") == "island" and "lamps" in cells.get(p["cell"], {})
		for piece in lamps(p, cells[p["cell"]], middle)]
	if i.get("details") or lit or glazing:
		# the mast's and the body's fittings, walkways and railings, the lamps
		# round the numbers, and the glazed levels' glass and fittings
		node("island_details", mesh=merge([shape(p) for p in i.get("details", [])] + lit + glazing))
	details = [face(w, middle, "glass") for w in i.get("windows", []) if "cab" not in w] + [face(f, middle, "panel") for f in i.get("panels", [])]
	plates = [p for p in LAYOUT.get("lettering", {}).get("plates", []) if p.get("on") == "island"]
	details += [face(p, middle, "lettering") for p in plates]
	if details:
		node("island_faces", mesh=merge(details))
		if plates:
			lettered("island_faces", [plate_frame(p, middle) for p in plates])
	for p in i.get("prisms", []):
		for k, (x, z) in enumerate(p.get("upper") or p["outline"]):
			MARKS[f"island_{p['name']}_top_{k + 1}"] = (at(x, p["top"], z), "island")


def joined(name, other):
	# Node `other`'s mesh joined into node `name`'s, `other` gone
	bpy.ops.object.select_all(action="DESELECT")
	NODES[other].select_set(True)
	NODES[name].select_set(True)
	bpy.context.view_layer.objects.active = NODES[name]
	bpy.ops.object.join()
	del NODES[other], HINGES[other]


def glazed(obj, cabs):
	# The island's glazed levels (layout.island.cabs), seen through: each
	# one's room cut out of the island's block (Blender's exact boolean) from
	# its floor to its head inside its walls, and an opening through each
	# glazed face from the sill to the head. The room's walls and ceiling take
	# the room's paint and its floor the dark; the openings' reveals are the
	# wall's grey. Returns what fills them: a pane in each opening leaning
	# `lean` out at its head (in, where the face rakes back), a frame between
	# bays about `mullions` apart and heavier bars at the sill and the head,
	# all in the island's grey as the photos show them, a white wiper motor
	# across each bay near its head where the opening has `wipers`, a conduit
	# along the face `conduit` above the head where it gives one, and dark
	# consoles along the glass inside
	out = []
	for cab in cabs:
		sill, head = cab["sill"], cab["head"]
		# outward: away from the room's own middle (the island's lies too near
		# an aft face to tell)
		middle = [sum(q[0] for q in cab["room"]) / len(cab["room"]), sum(q[1] for q in cab["room"]) / len(cab["room"])]
		openings = []
		for o in cab["openings"]:
			(ax, az), (bx, bz) = o["from"], o["to"]
			length = math.hypot(bx - ax, bz - az)
			dx, dz = (bx - ax) / length, (bz - az) / length
			nx, nz = -dz, dx
			if ((ax + bx) / 2 - middle[0]) * nx + ((az + bz) / 2 - middle[1]) * nz < 0:
				nx, nz = -nx, -nz   # outward
			openings.append((ax, az, bx, bz, length, dx, dz, nx, nz, o.get("lean", cab.get("lean", 0.25)), o.get("conduit"), o.get("wipers", False)))
		vertices, faces, paints = prism(cab["room"], cab["floor"], cab["head"], paint="room")
		paints[1] = "dark"   # prism()'s second face is its bottom: the floor
		cutters = [(vertices, faces, paints)]
		for ax, az, bx, bz, length, dx, dz, nx, nz, lean, _, _ in openings:
			reach = 0.6 + max(lean, 0.0)
			quad = [[ax - nx * 0.8, az - nz * 0.8], [bx - nx * 0.8, bz - nz * 0.8], [bx + nx * reach, bz + nz * reach], [ax + nx * reach, az + nz * reach]]
			cutters.append(prism(quad, sill, head))
		cutter = node("cutter", mesh=merge(cutters))
		cut = obj.modifiers.new("glazed", "BOOLEAN")
		cut.operation, cut.solver, cut.object = "DIFFERENCE", "EXACT", cutter
		cut.use_self, cut.material_mode = True, "TRANSFER"
		bpy.context.view_layer.objects.active = obj
		bpy.ops.object.modifier_apply(modifier=cut.name)
		bpy.data.objects.remove(cutter, do_unlink=True)
		del NODES["cutter"], HINGES["cutter"]
		for ax, az, bx, bz, length, dx, dz, nx, nz, lean, conduit, wipers in openings:
			foot = lambda s: [ax + dx * s, sill, az + dz * s]
			top = lambda s: [ax + dx * s + nx * lean, head, az + dz * s + nz * lean]
			out.append(sheet([foot(0), foot(length), top(length), top(0)], [nx, 0, nz], 0.02, "pane"))
			count = max(1, round(length / cab.get("mullions", 2.0)))
			for k in range(count + 1):
				out.append(bar(foot(length * k / count), top(length * k / count), 0.15))
			out += [bar(foot(0), foot(length), 0.2), bar(top(0), top(length), 0.2)]
			# the wipers 0.1 m out from the glass, 0.88 of the way up
			rise, off = sill + 0.88 * (head - sill), lean * 0.88 + 0.1
			half = min(0.3, length / count / 2 * 0.8)
			for k in range(count if wipers else 0):
				m = length * (k + 0.5) / count
				out.append(bar([ax + dx * (m - half) + nx * off, rise, az + dz * (m - half) + nz * off],
					[ax + dx * (m + half) + nx * off, rise, az + dz * (m + half) + nz * off], 0.14, "white"))
			if conduit:
				out.append(bar([ax + nx * 0.06, head + conduit, az + nz * 0.06], [bx + nx * 0.06, head + conduit, bz + nz * 0.06], 0.08))
			# a console along it inside, below the sill
			c = [[ax - nx * 0.4 + dx * 0.4, az - nz * 0.4 + dz * 0.4], [bx - nx * 0.4 - dx * 0.4, bz - nz * 0.4 - dz * 0.4],
				[bx - nx * 1.0 - dx * 0.4, bz - nz * 1.0 - dz * 0.4], [ax - nx * 1.0 + dx * 0.4, az - nz * 1.0 + dz * 0.4]]
			if length > 1.0:
				out.append(prism(c, cab["floor"], min(sill, cab["floor"] + 1.0), paint="dark"))
	return out


def lettered(name, frames):
	# UVs on a node's lettering faces, each from the plate frame nearest it:
	# its cell of the lettering texture (letters.py) reads from outside, u to
	# the viewer's right and v up; the plate's edges take its cell's border
	spec = LAYOUT["lettering"]
	width, height = spec["pixels"]
	obj = NODES[name]
	data = obj.data
	index = [i for i, m in enumerate(data.materials) if m.name == "lettering"]
	uv = data.uv_layers.new(name="lettering")
	for polygon in data.polygons:
		if polygon.material_index not in index:
			for loop in polygon.loop_indices:
				uv.data[loop].uv = (0, 0)
			continue
		middle = HINGES[name] + polygon.center
		ship = Vector((middle.x, middle.z, -middle.y))
		f = min(frames, key=lambda f: (ship - Vector(f["middle"])).length)
		left, top, right, bottom = spec["cells"][f["cell"]]["box"]
		for loop in polygon.loop_indices:
			co = HINGES[name] + data.vertices[data.loops[loop].vertex_index].co
			offset = Vector((co.x, co.z, -co.y)) - Vector(f["middle"])
			s = min(max(offset.dot(Vector(f["right"])) / f["size"][0] + 0.5, 0), 1)
			t = min(max(offset.dot(Vector(f["up"])) / f["size"][1] + 0.5, 0), 1)
			uv.data[loop].uv = ((left + s * (right - left)) / width, 1 - (bottom - t * (bottom - top)) / height)


def plate(corners, outward, thickness=0.03, paint="dark"):
	# A thin slab on a face: corners (ship frame, in order round it) and the
	# slab standing `thickness` out from them along `outward`
	base = [at(*c) for c in corners]
	out = at(*outward)
	out = out.normalized() * thickness
	vertices = base + [v + out for v in base]
	faces = [(0, 1, 2, 3), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
	return vertices, faces, [paint] * 6


def face(entry, centre, paint):
	# A plate on a face the layout gives as a plane ("z=20.5" with x and y ranges,
	# "x=-80.85" with z and y), as corners, or as a plan line with distances along
	# it; facing away from `centre` [x, z]; its own paint and thickness where
	# it gives them
	paint = entry.get("paint", paint)
	thick = entry.get("thickness", 0.03)
	(y0, y1) = entry["y"] if "y" in entry else (0, 0)
	if "corners" in entry:
		corners = entry["corners"]
		mid = [sum(c[i] for c in corners) / 4 for i in range(3)]
		u = [corners[1][i] - corners[0][i] for i in range(3)]
		v = [corners[3][i] - corners[0][i] for i in range(3)]
		n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
		if n[0] * (mid[0] - centre[0]) + n[2] * (mid[2] - centre[1]) < 0:
			n = [-c for c in n]
		return plate(corners, n, thickness=thick, paint=paint)
	if "line" in entry:
		(ax, az), (bx, bz) = entry["line"]
		length = math.hypot(bx - ax, bz - az)
		dx, dz = (bx - ax) / length, (bz - az) / length
		a0, a1 = entry["along"]
		p0, p1 = (ax + dx * a0, az + dz * a0), (ax + dx * a1, az + dz * a1)
		n = [-dz, 0, dx]
		if n[0] * (p0[0] - centre[0]) + n[2] * (p0[1] - centre[1]) < 0:
			n = [dz, 0, -dx]
		return plate([[p0[0], y0, p0[1]], [p1[0], y0, p1[1]], [p1[0], y1, p1[1]], [p0[0], y1, p0[1]]], n, thickness=thick, paint=paint)
	axis, value = entry["plane"].split("=")
	value = float(value)
	def square(grow):
		# the plate's corners on its plane, grown by `grow` all round
		if axis == "z":
			(x0, x1) = entry["x"]
			return [[x0 - grow, y0 - grow, value], [x1 + grow, y0 - grow, value], [x1 + grow, y1 + grow, value], [x0 - grow, y1 + grow, value]]
		(z0, z1) = entry["z"]
		return [[value, y0 - grow, z0 - grow], [value, y0 - grow, z1 + grow], [value, y1 + grow, z1 + grow], [value, y1 + grow, z0 - grow]]
	outward = [0, 0, 1 if value > centre[1] else -1] if axis == "z" else [1 if value > centre[0] else -1, 0, 0]
	if "radius" not in entry:
		return plate(square(0), outward, thickness=thick, paint=paint)
	# rounded corners; a frame round it, flatter, so the glass stands proud of it
	pieces = [sheet(rounded(square(0), entry["radius"]), outward, thick, paint)]
	if entry.get("frame"):
		pieces.append(sheet(rounded(square(entry["frame"]), entry["radius"] + entry["frame"]), outward, thick / 2, entry.get("rim", "panel")))
	return merge(pieces)


def bar(a, b, size, paint="grey"):
	# A square bar `size` across from a to b (ship frame)
	a, b = at(*a), at(*b)
	along = b - a
	helper = UP if abs(along.normalized().dot(UP)) < 0.9 else FORWARD
	u = along.cross(helper).normalized() * (size / 2)
	w = along.cross(u).normalized() * (size / 2)
	corners = [a + u * i + w * j for i, j in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
	corners += [c + along for c in corners]
	faces = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
	return corners, faces, [paint] * 6


def tube(a, b, radius, paint="grey", segments=16, ends=True):
	# A round bar from a to b (ship frame), `radius` across, or tapering from
	# radius[0] at a to radius[1] at b: its sides, and a flat end at each end
	# (ends=True), or at neither; (vertices, faces, paints, smooth), the sides
	# smooth and the ends flat
	a, b = at(*a), at(*b)
	along = b - a
	first, last = radius if isinstance(radius, (list, tuple)) else (radius, radius)
	turn = Vector((0, 0, 1)).rotation_difference(along.normalized()).to_matrix().to_4x4()
	shape = Matrix.Translation((a + b) / 2) @ turn
	vertices, faces = primitive(lambda bm: bmesh.ops.create_cone(bm, cap_ends=ends, segments=segments, radius1=first, radius2=last,
		depth=along.length, matrix=shape))
	smooth = [len(f) == 4 for f in faces]
	return vertices, faces, [paint] * len(faces), smooth


def cylinder(centre, radius, length, paint, across=False):
	# A cylinder lying fore and aft, or across the ship (ship frame centre)
	shape = Matrix.Translation(at(*centre)) @ Matrix.Rotation(math.pi / 2, 4, "X" if across else "Y")
	vertices, faces = primitive(lambda bm: bmesh.ops.create_cone(bm, cap_ends=True, segments=12, radius1=radius, radius2=radius,
		depth=length, matrix=shape))
	return vertices, faces, [paint] * len(faces)


def section(origin, outward, along, points, thickness, paint="grey"):
	# A plate standing in the vertical plane through `origin` [x, z] across
	# `outward` (a plan direction [x, z]): its outline [[out, y], ...], `out`
	# metres along `outward`, made `thickness` thick along `along`
	o = Vector((outward[0], outward[1]))
	a = Vector((along[0], along[1])).normalized() * (thickness / 2)
	n = len(points)
	vertices = [at(origin[0] + o.x * d + a.x * s, y, origin[1] + o.y * d + a.y * s) for s in (-1, 1) for d, y in points]
	faces = [tuple(range(n)), tuple(range(2 * n - 1, n - 1, -1))] + [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
	return vertices, faces, [paint] * len(faces)


def edge_line(side, x0, x1):
	# The deck's edge on one side between x0 and x1 as a plan line [[x, z],
	# ...] forward, through every corner of the deck's and the elevators'
	# outlines between
	outlines = [LAYOUT["deck"]["outline"]] + [e["outline"] for e in LAYOUT.get("elevators", [])]
	xs = sorted({x0, x1} | {p[0] for o in outlines for p in o if x0 < p[0] < x1})
	return [[x, edge(outlines, x, side)] for x in xs]


def offset(line, side, distance):
	# A plan line [[x, z], ...] running forward, moved `distance` outboard
	# (side +1 starboard, -1 port), mitred at its corners; and each point's
	# outward direction
	normals = []
	for a, b in zip(line, line[1:]):
		d = Vector((b[0] - a[0], b[1] - a[1])).normalized()
		normals.append(Vector((-d.y, d.x)) * side)
	out, directions = [], []
	for k, p in enumerate(line):
		around = [normals[i] for i in (k - 1, k) if 0 <= i < len(normals)]
		n = sum(around, Vector((0, 0))).normalized()
		scale = 1 / max(n.dot(around[0]), 0.3)
		out.append([p[0] + n.x * distance * scale, p[1] + n.y * distance * scale])
		directions.append([n.x, n.y])
	return out, directions


def along_line(line, spacing):
	# Points every `spacing` along a plan line, evenly from end to end, each
	# with the line's direction there: [([x, z], [dx, dz]), ...]
	lengths = [math.dist(a, b) for a, b in zip(line, line[1:])]
	total = sum(lengths)
	count = max(1, round(total / spacing))
	out = []
	for k in range(count + 1):
		s = total * k / count
		for (a, b), length in zip(zip(line, line[1:]), lengths):
			if s <= length + 1e-9 or (a, b) == (line[-2], line[-1]):
				t = min(s / length, 1.0) if length else 0.0
				out.append(([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], [(b[0] - a[0]) / length, (b[1] - a[1]) / length]))
				break
			s -= length
	return out


def level(path, q):
	# A path's height at plan point q on it, from the run nearest q
	best = None
	for a, b in zip(path, path[1:]):
		dx, dz = b[0] - a[0], b[2] - a[2]
		t = min(max(((q[0] - a[0]) * dx + (q[1] - a[2]) * dz) / max(dx * dx + dz * dz, 1e-18), 0.0), 1.0)
		gap = math.dist(q, [a[0] + dx * t, a[2] + dz * t])
		if best is None or gap < best[0]:
			best = (gap, a[1] + (b[1] - a[1]) * t)
	return best[1]


def railing(line, floor, spec, paint="rail"):
	# A toe board, a mid rail and a top rail along a plan line, and posts
	pieces = []
	height = spec["railing"]
	for a, b in zip(line, line[1:]):
		for y, size in ((floor + spec["toe"] / 2, spec["toe"]), (floor + height / 2, 0.04), (floor + height, 0.05)):
			pieces.append(bar([a[0], y, a[1]], [b[0], y, b[1]], size, paint))
	for p, _ in along_line(line, spec["posts"]):
		pieces.append(bar([p[0], floor, p[1]], [p[0], floor + height, p[1]], 0.05, paint))
	return pieces


def knees(inner, side, reach, top, foot, spacing):
	# Plate knees under a floor every `spacing` along the deck's edge (inner):
	# each from the floor's outer edge, `reach` outboard, down to `foot` at
	# the edge, its inboard part running on into the hull so its foot meets
	# whatever the edge has below it
	pieces = []
	for p, d in along_line(inner, spacing):
		out = [-d[1] * side, d[0] * side]
		pieces.append(section(p, out, d, [(-1.5, top), (reach, top), (0.0, foot), (-1.5, foot)], 0.04))
	return pieces


def catwalk_runs():
	# Each catwalk's deck-edge line, its outboard line and outward directions
	spec = LAYOUT.get("catwalks")
	runs = []
	for r in (spec or {}).get("runs", []):
		side = 1 if r["side"] == "starboard" else -1
		inner = edge_line(side, *r["x"])
		outer, directions = offset(inner, side, r["width"])
		runs.append({"side": side, "x": r["x"], "inner": inner, "outer": outer, "net": r.get("net", False), "width": r["width"]})
	return runs


def catwalks():
	# The catwalks under the deck's edge: a floor from the edge out, a toe
	# board and railings along its outboard edge, plate knees under it to the
	# band; and the platforms off them
	spec = LAYOUT.get("catwalks")
	if not spec:
		return []
	floor, k = spec["floor"], spec["knees"]
	pieces = []
	for r in catwalk_runs():
		inside, _ = offset(r["inner"], r["side"], -0.2)   # into the band, so the floor's edge never lies on it
		pieces.append(prism(inside + r["outer"][::-1], floor - 0.1, floor))
		pieces += railing(r["outer"], floor, spec)
		pieces += knees(r["inner"], r["side"], r["width"], floor - 0.1, floor - 0.1 - k["depth"], k["spacing"])
	runs = catwalk_runs()
	for pl in spec.get("platforms", []):
		side = 1 if pl["side"] == "starboard" else -1
		inner = edge_line(side, *pl["x"])
		width = max([r["width"] for r in runs if r["side"] == side and r["x"][0] <= sum(pl["x"]) / 2 <= r["x"][1]], default=0.0)
		near, _ = offset(inner, side, width)   # meeting the catwalk's floor edge to edge
		far, _ = offset(inner, side, width + pl["width"])
		pieces.append(prism(near + far[::-1], floor - 0.1, floor))
		pieces += railing(far, floor, spec)
		pieces += knees(inner, side, width + pl["width"], floor - 0.1, floor - 0.1 - k["depth"] - 0.2 * pl["width"], 2.0)
	return pieces


def domes_edge():
	# The deck-edge domes, each on its platform, with knees under the
	# platform's ends down to the deck's edge
	pieces = []
	runs = catwalk_runs()
	for d in LAYOUT.get("domes_edge", []):
		r = d["diameter"] / 2
		floor = d["floor"]
		top = d.get("top", floor + 2.3 * r)
		side = 1 if d["centre"][1] > 0 else -1
		# the platform's inboard edge carried in to the catwalk's outer edge,
		# or into the band where none runs, so it meets what it stands off
		inmost = min(abs(p[1]) for p in d["platform"])
		platform = []
		for x, z in d["platform"]:
			if abs(abs(z) - inmost) < 1e-6:
				edge_z = abs(edge_line(side, x - 0.01, x + 0.01)[0][1])
				catwalk = [q["width"] for q in runs if q["side"] == side and q["x"][0] <= x <= q["x"][1]]
				z = side * min(abs(z), edge_z + catwalk[0] if catwalk else edge_z - 0.2)
			platform.append([x, z])
		pieces.append(prism(platform, floor - 0.3, floor))
		pieces.append(dome([d["centre"][0], top - r, d["centre"][1]], r, top - r - floor))
		x0, x1 = min(p[0] for p in d["platform"]), max(p[0] for p in d["platform"])
		reach = max(abs(p[1]) for p in d["platform"])
		for x in (x0 + 0.2, x1 - 0.2):
			inner = edge_line(side, x - 0.01, x + 0.01)
			edge_z = abs(inner[0][1])
			foot = d.get("foot", floor - 0.3 - max(0.8, 0.2 * (reach - edge_z)))
			pieces.append(section([x, side * edge_z], [0, side], [1, 0], [(-1.5, floor - 0.3), (reach - edge_z, floor - 0.3), (0.0, foot),
				(-1.5, foot)], 0.06))
	return pieces


def tubs():
	# The gun tubs on the sponsons' outboard faces (layout.tubs): a floor, a
	# railing round its outboard sides (the outline's open path, from the
	# inboard aft corner round to the inboard forward corner), and a knee at
	# its aft end from the floor's outer edge down to its foot on the face;
	# the gun on the floor is a weapon's mount
	pieces = []
	for t in LAYOUT.get("tubs", []):
		floor = t["floor"]
		pieces.append(prism(t["outline"], floor - 0.2, floor))
		pieces += railing(t["outline"], floor, {"railing": t["railing"], "posts": 1.5, "toe": 0.1})
		face, edge = t["outline"][0][1], t["outline"][1][1]
		side = 1 if edge > face else -1
		k = t["knee"]
		pieces.append(section([k["x"], face], [0, side], [1, 0], [(-0.5, floor - 0.2), (abs(edge - face), floor - 0.2), (0.0, k["foot"]),
			(-0.5, k["foot"])], 0.06))
	return pieces


def racks():
	# The raft canisters: each rack one canister lying fore and aft in each
	# tier, on a cradle hung outboard of the catwalk's railing; and the rows
	# of small canisters on the catwalks
	spec = LAYOUT.get("racks")
	if not spec:
		return []
	pieces = []
	length, radius = spec["canister"]["length"], spec["canister"]["diameter"] / 2
	tiers = spec["tiers"]
	for g in spec["groups"]:
		side = 1 if g["side"] == "starboard" else -1
		(x0, x1), (z0, z1) = g["x"], sorted(g["z"], key=abs)
		pitch = (x1 - x0) / g["count"]
		zc = (z0 + z1) / 2
		inboard = z0 - side * 0.6   # the cradles reach in to the railing
		for k in range(g["count"]):
			xc = x0 + pitch * (k + 0.5)
			span = min(length, pitch - 0.1)
			for bottom, upper in tiers:
				pieces.append(cylinder([xc, (bottom + upper) / 2, zc], radius, span, "raft"))
				for end in (-1, 1):
					x = xc + end * span / 2
					pieces.append(bar([x, bottom, inboard], [x, bottom, z1], 0.06))
			for end in (-1, 1):
				x = xc + end * span / 2
				pieces.append(bar([x, tiers[0][0], z1], [x, tiers[-1][1], z1], 0.06))
	small = spec.get("small")
	for row in spec.get("rows", []):
		(x0, x1), (z0, z1) = row["x"], row["z"]
		count = max(1, int((x1 - x0) / (small["length"] + 0.05)))
		pitch = (x1 - x0) / count
		y = tiers[0][0] + small["diameter"] / 2
		for k in range(count):
			pieces.append(cylinder([x0 + pitch * (k + 0.5), y, (z0 + z1) / 2], small["diameter"] / 2, small["length"], "blue"))
	return pieces


def net_material():
	# The nets' material: a small net of the nets' cord, the holes cut out
	# (glTF alphaMode MASK: the image's alpha, rounded, as the surface's
	# alpha), on both faces
	if "net" in MATERIALS:
		return MATERIALS["net"]
	m = material("net")
	size, cell, cord = 64, 16, 3
	image = bpy.data.images.new("net", size, size, alpha=True)
	pixels = []
	for v in range(size):
		for u in range(size):
			on = u % cell < cord or v % cell < cord
			pixels += [*COLOURS["net"][:3], 1.0 if on else 0.0]
	image.pixels = pixels
	image.pack()
	tree = m.node_tree
	texture = tree.nodes.new("ShaderNodeTexImage")
	texture.image = image
	bsdf = tree.nodes["Principled BSDF"]
	tree.links.new(texture.outputs["Color"], bsdf.inputs["Base Color"])
	cut = tree.nodes.new("ShaderNodeMath")
	cut.operation = "ROUND"
	tree.links.new(texture.outputs["Alpha"], cut.inputs[0])
	tree.links.new(cut.outputs[0], bsdf.inputs["Alpha"])
	m.use_backface_culling = False
	return m


NET_TILE = 0.5   # metres of net in one repeat of its image: 12.5 cm meshes


def nets():
	# The safety nets: outboard of the catwalks that carry them (not where a
	# rack or a platform stands) and across the bow, each a strip rising
	# outward from the railing's top, on frames down to the catwalk's edge.
	# The strips are their own node (`nets`, open, both faces drawn), mapped
	# by plan so the net's meshes come out square
	spec = LAYOUT.get("catwalks")
	if not spec or "net" not in spec:
		return
	n = spec["net"]
	floor, height = spec["floor"], spec["railing"]
	blocked = [(g["x"], 1 if g["side"] == "starboard" else -1) for g in LAYOUT.get("racks", {}).get("groups", [])]
	blocked += [(pl["x"], 1 if pl["side"] == "starboard" else -1) for pl in spec.get("platforms", [])]
	lines = []
	for r in catwalk_runs():
		if not r["net"]:
			continue
		# the run split round whatever stands outboard of it
		cuts = sorted((max(a, r["x"][0]), min(b, r["x"][1])) for (a, b), side in blocked if side == r["side"] and a < r["x"][1] and b > r["x"][0])
		start = r["x"][0]
		for a, b in cuts + [(r["x"][1], r["x"][1])]:
			if a - start > 1.0:
				inner = edge_line(r["side"], start, a)
				outer, _ = offset(inner, r["side"], r["width"])
				lines.append((outer, r["side"], floor))
			start = max(start, b)
	for extra in spec.get("nets", []):
		# a strip hangs to the line's left as it runs (forward over the bow,
		# from port to starboard), aft over the stern
		lines.append(([extra["from"], extra["to"]], 1 if extra["side"] == "stern" else -1, extra.get("floor", floor)))
	strips, frames = [], []
	for line, side, base in lines:
		y0, y1 = base + height, base + height + n["rise"]
		# a frame every `frames` or so, evenly, and the net's outer edge
		# hanging `sag` between each pair of them (its middle the lowest)
		total = sum(math.dist(a, b) for a, b in zip(line, line[1:]))
		count = max(1, round(total / n["frames"]))
		points = along_line(line, total / (2 * count))
		near = [p for p, _ in points]
		far = [[p[0] - d[1] * side * n["width"], p[1] + d[0] * side * n["width"]] for p, d in points]
		drop = [n.get("sag", 0.0) * (k % 2) for k in range(len(points))]
		k = len(points)
		vertices = [at(x, y0, z) for x, z in near] + [at(x, y1 - s, z) for (x, z), s in zip(far, drop)]
		faces = [(i, i + 1, k + i + 1, k + i) for i in range(k - 1)]
		strips.append((vertices, faces, ["net"] * len(faces)))
		frames += [bar([a[0], y1 - sa, a[1]], [b[0], y1 - sb, b[1]], 0.05, "rail") for a, b, sa, sb in zip(far, far[1:], drop, drop[1:])]
		for (p, _), q in list(zip(points, far))[::2]:
			frames.append(bar([p[0], base, p[1]], [q[0], y1, q[1]], 0.05, "rail"))
	if not strips:
		return
	net_material()
	obj = node("nets", mesh=merge(strips))
	uv = obj.data.uv_layers.new(name="net")
	for loop in obj.data.loops:
		co = obj.data.vertices[loop.vertex_index].co + HINGES["nets"]
		uv.data[loop.index].uv = (co.x / NET_TILE, co.y / NET_TILE)
	node("net_frames", mesh=merge(frames))


def facing(points, outward, paint):
	# One face through `points` (ship frame), wound so it faces `outward`
	# (a ship-frame direction): for a mesh with an open edge, whose winding
	# tidy() leaves as built
	corners = [at(*q) for q in points]
	normal = Vector()
	for a, b in zip(corners, corners[1:] + corners[:1]):
		normal += Vector(((a.y - b.y) * (a.z + b.z), (a.z - b.z) * (a.x + b.x), (a.x - b.x) * (a.y + b.y)))
	if normal.dot(at(*outward)) < 0:
		corners = corners[::-1]
	return corners, [tuple(range(len(corners)))], [paint]


def upper_transom(x0, section):
	# The transom above the walkway (layout.transom). The hull's last section
	# above the walkway's floor ([z, y]: the port foot on the floor, up the
	# port side, across under the deck, down the starboard side to its foot)
	# carried aft from x0 to the face; the face round its stepped recess, the
	# recess running in to its back wall (`transom`). The windows and the
	# catwalk band on the face, the walkway with its railing and fascia, the
	# post frame and its fenders, the drop-light bar and the Phalanx's raised
	# deck (`transom_fittings`)
	t = LAYOUT["transom"]
	x1, floor = t["face"], t["floor"]
	hole, back = t["opening"]["outline"], t["opening"]["back"]
	middle = [sum(q[0] for q in section) / len(section), sum(q[1] for q in section) / len(section)]
	shell = []
	for (za, ya), (zb, yb) in zip(section, section[1:]):
		out = [0, zb - za, -(yb - ya)]   # across the edge, in (y, z)
		if out[1] * ((ya + yb) / 2 - middle[1]) + out[2] * ((za + zb) / 2 - middle[0]) < 0:
			out = [0, -out[1], -out[2]]
		shell.append(facing([[x0, ya, za], [x1, ya, za], [x1, yb, zb], [x0, yb, zb]], [0, out[1], out[2]], "grey"))
	for za, zb in ((section[0][0], hole[0][0]), (hole[-1][0], section[-1][0])):
		shell.append(facing([[x0, floor, za], [x1, floor, za], [x1, floor, zb], [x0, floor, zb]], [0, -1, 0], "grey"))
	shell.append(facing([[x1, y, z] for z, y in [section[0]] + hole + section[:0:-1]], [-1, 0, 0], "grey"))
	# the recess: its walls and floor face in, its back wall aft
	centre = [sum(q[0] for q in hole) / len(hole), sum(q[1] for q in hole) / len(hole)]
	for (za, ya), (zb, yb) in zip(hole, hole[1:] + hole[:1]):
		inward = [0, centre[1] - (ya + yb) / 2, centre[0] - (za + zb) / 2]
		shell.append(facing([[x1, ya, za], [back, ya, za], [back, yb, zb], [x1, yb, zb]], inward, "recess"))
	shell.append(facing([[back, y, z] for z, y in hole], [-1, 0, 0], "recess"))
	node("transom", mesh=merge(shell))
	# closed pieces, which tidy() turns outward
	fittings = [face(w, [0, 0], "glass") for w in t["windows"]]
	(zp, _), (zs, _) = section[2], section[3]
	fittings.append(face({"plane": f"x={x1}", "z": sorted([zp, zs]), "y": t["catwalk"]["y"]}, [0, 0], "recess"))
	rail = {"railing": t["walkway"]["railing"], "posts": t["walkway"]["posts"], "toe": 0.1}
	fittings += railing([[x1 - 0.1, zs - 0.3], [x1 - 0.1, zp + 0.3]], t["catwalk"]["y"][0], rail)
	w = t["walkway"]
	fittings.append(prism(w["plan"], floor - w["thickness"], floor))
	# its railing one line, or several where the walkway is cut back
	for line in (w["rail"] if isinstance(w["rail"][0][0], list) else [w["rail"]]):
		fittings += railing(line, floor, rail)
	# the fascia and the member under it along each piece of its aft edge (one
	# line or several), each standing out from the walkway
	lines = w["aft"] if isinstance(w["aft"][0][0], list) else [w["aft"]]
	for (ax, az), (bx, bz) in [piece for line in lines for piece in zip(line, line[1:])]:
		length = math.hypot(bx - ax, bz - az)
		nx, nz = (bz - az) / length, -(bx - ax) / length
		if inside([(ax + bx) / 2 + nx * 0.01, (az + bz) / 2 + nz * 0.01], w["plan"]):
			nx, nz = -nx, -nz
		for (y0, y1), depth in ((w["fascia"], 0.1), (w["member"], 0.2)):
			fittings.append(prism([[ax, az], [ax + nx * depth, az + nz * depth], [bx + nx * depth, bz + nz * depth], [bx, bz]], y0, y1))
	f = t["frame"]
	(z0, z1) = f["z"]
	for k in range(f["members"]):
		z = z0 + (z1 - z0) * k / (f["members"] - 1)
		fittings.append(bar([f["x"], f["bottom"], z], [f["x"], f["top"], z], f["size"], "dark"))
	fittings.append(bar([f["x"], f["top"] - f["size"] / 2, z0], [f["x"], f["top"] - f["size"] / 2, z1], f["size"], "dark"))
	for fender in t["fenders"]:
		fittings.append(cylinder(fender["centre"], fender["diameter"] / 2, fender["length"], "dark", across=True))
	# the drop-light pole, in two sections where it has a `gap`
	d = t["drop"]
	plan = [[d["x"] - d["depth"] / 2, d["z"] - d["width"] / 2], [d["x"] + d["depth"] / 2, d["z"] - d["width"] / 2],
		[d["x"] + d["depth"] / 2, d["z"] + d["width"] / 2], [d["x"] - d["depth"] / 2, d["z"] + d["width"] / 2]]
	ends = [d["bottom"], *d.get("gap", []), d["top"]]
	for y0, y1 in zip(ends[::2], ends[1::2]):
		fittings.append(prism(plan, y0, y1, paint="yellow"))
	# the Phalanx's raised deck: its plan at its foot, and at its top where
	# its sides slope
	pl = t["plinth"]
	fittings.append(prism(pl["outline"], pl["bottom"], pl["top"], pl.get("upper")))
	# the rest as photographed: the recess's mezzanine, doors, cabinet, lamps
	# and life ring, the boat landing, the scuppers, pipe and chocks; a part
	# that gives a `mark` is a landmark for the photo match at its centre
	fittings += [shape(d) for d in t.get("details", [])]
	for d in t.get("details", []):
		if "mark" in d:
			MARKS[d["mark"]] = (at(*d["centre"]), "transom_fittings")
	node("transom_fittings", mesh=merge(fittings))


def turned(origin, axis, profile, paints, flat=(), segments=32, shift=None, section=None):
	# A closed surface of revolution about the line through `origin` along
	# `axis`, which may lean any way (Blender vectors; lathe() turns about an
	# upright one): profile [(radius, along), ...], a radius of 0 a point on
	# the axis; paints[k] the band's from profile point k to k + 1, its faces
	# smooth unless k is in `flat`; (vertices, faces, paints, smooth).
	# section(angle), given, is the outline a radius of 1 traces instead of a
	# circle (a vector square to the axis at each angle round it); shift(offset),
	# given, moves the whole profile at each angle that far along the axis, from
	# that angle's offset at a radius of 1 (a pipe's end cut on the slant)
	axis = axis.normalized()
	u = axis.cross(UP if abs(axis.dot(UP)) < 0.9 else FORWARD).normalized()
	w = axis.cross(u)
	angles = [2 * math.pi * k / segments for k in range(segments)]
	directions = [section(t) if section else u * math.cos(t) + w * math.sin(t) for t in angles]
	moved = [shift(d) if shift else 0.0 for d in directions]
	vertices, rings = [], []
	for r, s in profile:
		if r < 1e-9:
			rings.append([len(vertices)] * segments)
			vertices.append(origin + axis * (s + sum(moved) / segments))
			continue
		rings.append(list(range(len(vertices), len(vertices) + segments)))
		vertices += [origin + axis * (s + m) + d * r for d, m in zip(directions, moved)]
	faces, painted, smooth = [], [], []
	for i in range(len(profile) - 1):
		for k in range(segments):
			ring = (rings[i][k], rings[i][(k + 1) % segments], rings[i + 1][(k + 1) % segments], rings[i + 1][k])
			face = tuple(v for j, v in enumerate(ring) if v != ring[j - 1])
			if len(face) < 3:
				continue
			faces.append(face)
			painted.append(paints[i])
			smooth.append(i not in flat)
	return vertices, faces, painted, smooth


def cuboid(centre, axes, sizes, paint="grey"):
	# A box about `centre` (a Blender vector), sizes[i] along axes[i] (three
	# perpendicular unit vectors)
	h = [a * (s / 2) for a, s in zip(axes, sizes)]
	corners = [centre + h[0] * i + h[1] * j + h[2] * k for k in (-1, 1) for i, j in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
	faces = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
	return corners, faces, [paint] * 6


def loop(centre, axes, sizes, girth, deep, cut, outside="grey", inside="grey"):
	# A rectangular loop of bar in one piece, sizes[0] by sizes[1] overall
	# along axes[0] and axes[1], about `centre` (Blender vectors; axes
	# right-handed): the bar `girth` across in the loop's plane and `deep`
	# along axes[2], its four edges cut back `cut` at 45 degrees, swept round
	# the loop with mitred corners. The faces that look into the loop's
	# middle (the inner face and its two chamfers) are painted `inside`
	assert 0 < cut < min(girth, deep) / 2, "a chamfer leaving each face some flat"
	g, d = girth / 2, deep / 2
	# the bar's section: (out from the bar's middle line in the loop's plane,
	# along axes[2]), round it outward face first
	section = [(g, d - cut), (g, -(d - cut)), (g - cut, -d), (-(g - cut), -d), (-g, -(d - cut)), (-g, d - cut), (-(g - cut), d), (g - cut, d)]
	middle = [sizes[0] / 2 - g, sizes[1] / 2 - g]
	corners = ((1, 1), (-1, 1), (-1, -1), (1, -1))   # round the loop, anticlockwise about axes[2]
	vertices = [centre + axes[0] * (i * (middle[0] + r)) + axes[1] * (j * (middle[1] + r)) + axes[2] * t
		for i, j in corners for r, t in section]
	n = len(section)
	faces, paints = [], []
	for c in range(4):
		for k in range(n):
			a, b = c * n + k, c * n + (k + 1) % n
			faces.append((a, b, ((c + 1) % 4) * n + (k + 1) % n, ((c + 1) % 4) * n + k))
			# the section's edge from point k to k + 1: inward when both its ends
			# lie on the loop's inner side
			paints.append(inside if section[k][0] < 0 and section[(k + 1) % n][0] < 0 else outside)
	return vertices, faces, paints


def chamfered(centre, axes, sizes, cut, paint="grey"):
	# A box as cuboid() makes it, each edge cut back `cut` on both its faces
	# at 45 degrees and each corner a triangle: 24 corners, 26 faces. paint is
	# a name, or a function naming each face's paint from its outward normal in
	# the box's own axes (a tuple)
	assert 0 < cut < min(sizes) / 2, "a chamfer leaving each face some flat"
	half = [s / 2 for s in sizes]
	keys = [(signs, k) for signs in itertools.product((-1, 1), repeat=3) for k in range(3)]
	# each corner of the box is three points, one on each of its faces (the
	# face square to axis k), drawn in `cut` along the other two axes
	local = {(signs, k): Vector([signs[i] * (half[i] if i == k else half[i] - cut) for i in range(3)]) for signs, k in keys}
	sets = [[(s, k) for s, k in keys if k == i and s[i] == sign] for i in range(3) for sign in (-1, 1)]
	sets += [[(s, k) for s, k in keys if k in (i, j) and s[i] == si and s[j] == sj]
		for i, j in ((0, 1), (0, 2), (1, 2)) for si in (-1, 1) for sj in (-1, 1)]
	sets += [[(s, k) for k in range(3)] for s in itertools.product((-1, 1), repeat=3)]
	index = {key: n for n, key in enumerate(keys)}
	faces, paints = [], []
	for face in sets:
		# wound round its outward side (the box is convex about its centre)
		middle = sum((local[key] for key in face), Vector()) / len(face)
		u = (local[face[0]] - middle).normalized()
		w = middle.normalized().cross(u)
		face.sort(key=lambda key: math.atan2((local[key] - middle).dot(w), (local[key] - middle).dot(u)))
		faces.append(tuple(index[key] for key in face))
		normal = (local[face[1]] - local[face[0]]).cross(local[face[2]] - local[face[0]]).normalized()
		paints.append(paint(tuple(normal)) if callable(paint) else paint)
	corners = [centre + sum((axis * c for axis, c in zip(axes, local[key])), Vector()) for key in keys]
	return corners, faces, paints


def anchors():
	# The bow's two anchors, housed (layout.anchors, the starboard one; the
	# port one its mirror image). Each hawse pipe's end stands out of the
	# plating as a grey hood: a pipe of rounded-square section along `axis`,
	# from `length` inside its mouth (closed there by a dome `dome` deep, or
	# flat) out to the mouth, which is cut on the slant to open toward
	# `facing`, its lip rolling `lip` round into the bore, dark to `depth`
	# inside. The anchor's crown sits below the mouth: its shank from the
	# crown up into the bore, a block on the stock (its edges chamfered, a pin
	# standing out of it), the frame (a loop of chamfered bar round a slot)
	# reaching from the block away from the mouth, and the stock a round bar
	# through the block, a knob at each end. The crown and the stock's ends
	# are landmarks for the photo match
	a = LAYOUT.get("anchors")
	if not a:
		return
	for paint in ("anchor", "rust", "umber"):
		COLOURS[paint] = tuple(linear(c) for c in a["colour"][paint]) + (1,)
	vertices, faces, paints, smooth = [], [], [], []

	def add(piece, flat=False):
		offset = len(vertices)
		vertices.extend(piece[0])
		faces.extend(tuple(i + offset for i in f) for f in piece[1])
		paints.extend(piece[2])
		smooth.extend([False] * len(piece[1]) if flat else piece[3])

	hawse, stock, block, frame = a["hawse"], a["stock"], a["block"], a["frame"]
	lip, length, depth = hawse["lip"], hawse["length"], hawse["depth"]
	wide, tall, power = hawse["width"], hawse["height"], hawse["power"]
	# the pipe's section a rounded square (a superellipse of `power`, 2 a
	# circle), `width` across (level and square to the axis, rolled `roll`
	# round it) and `height`; its profile's radii in metres of the mean
	# half-size R, the lip and the bore drawn in from it in proportion
	R = (wide + tall) / 4
	arc = [(R - lip + lip * math.cos(t), -lip + lip * math.sin(t)) for t in (math.pi * k / 8 for k in range(9))]
	# along the pipe out of its mouth: its far end (a dome `dome` deep past
	# `length`, or flat), its outside, the lip (from the outside round to the
	# bore), the bore and its bottom
	dome = hawse.get("dome", 0.0)
	if dome > 0:
		far = [(R * math.sin(t), -length - dome * math.cos(t)) for t in (math.pi / 2 * k / 8 for k in range(9))]
	else:
		far = [(0, -length), (R, -length)]
	profile = far + arc + [(R - 2 * lip, -depth), (0, -depth)]
	shades = ["grey"] * (len(far) + 8) + ["dark", "dark"]
	flat = (len(profile) - 2,) if dome > 0 else (0, len(profile) - 2)
	for side, name in ((1, "starboard"), (-1, "port")):
		def mirrored(p):
			return [p[0], p[1], side * p[2]]
		mouth = at(*mirrored(hawse["mouth"]))
		axis = at(*mirrored(hawse["axis"])).normalized()   # into the pipe from its mouth
		facing = at(*mirrored(hawse["facing"])).normalized()   # the way the mouth opens
		# the section's width runs level (axis x up) turned `roll` toward axis x
		# level, its height square to both; the port one rolled the other way so
		# it is the starboard one's mirror image, both wound as turned() winds a
		# circle about -axis
		level = axis.cross(UP).normalized()
		roll = side * hawse.get("roll", 0.0)
		across = level * math.cos(roll) + axis.cross(level) * math.sin(roll)
		u, w = -across, axis.cross(across)
		def section(t):
			c, s = math.cos(t), math.sin(t)
			return (u * (wide / 2 * math.copysign(abs(c) ** (2 / power), c)) + w * (tall / 2 * math.copysign(abs(s) ** (2 / power), s))) / R
		# the mouth cut on the plane through its centre square to `facing`:
		# the lip's crest on that plane all round, the pipe leaning past it
		add(turned(mouth, -axis, profile, shades, flat=flat, section=section,
			shift=lambda d: -(R - lip) * d.dot(facing) / -axis.dot(facing)))
		crown = at(*mirrored(a["crown"]))
		low, high = at(*mirrored(stock["ends"][0])), at(*mirrored(stock["ends"][1]))
		along = (high - low).normalized()
		add(tube(mirrored(stock["ends"][0]), mirrored(stock["ends"][1]), stock["diameter"] / 2, "anchor"))
		for end in (low, high):
			knob = primitive(lambda bm: bmesh.ops.create_uvsphere(bm, u_segments=16, v_segments=8, radius=stock["knob"] / 2,
				matrix=Matrix.Translation(end)))
			add((knob[0], knob[1], ["anchor"] * len(knob[1]), [True] * len(knob[1])))
		# the crown's frame of reference: along the stock, away from the
		# mouth across it, and through both (out of the plating or into it)
		toward = mouth - crown
		away = -(toward - along * toward.dot(along)).normalized()
		through = along.cross(away)
		# the block, its edges chamfered, and the pin through it standing out of
		# its outer face (the one away from the pipe's run into the hull)
		cut = a["chamfer"]
		add(chamfered(crown, (along, away, through), block, cut, "anchor"), flat=True)
		outward = through if through.dot(-axis) > 0 else -through
		pin = crown + outward * (block[2] / 2)
		add(tube(exported(pin), exported(pin + outward * a["pin"]["length"]), a["pin"]["diameter"] / 2, "anchor", segments=12))
		# the frame: one loop of bar `girth` across (in the loop's plane) and
		# `deep` through it, round a slot from the block's edge out to `reach`
		# from the crown and `width` along the stock; its edges chamfered, its
		# corners mitred, rust outside and umber on the faces that look into the
		# slot (the photos' shadowed insides)
		start, reach, width = block[1] / 2, frame["reach"], frame["width"]
		add(loop(crown + away * ((start + reach) / 2), (along, away, through), (width, reach - start), frame["bar"], frame["depth"], cut,
			"rust", "umber"), flat=True)
		# the shank: a square bar, chamfered, from the crown up into the bore,
		# to half its depth on the crown's side of it (no nearer its wall than
		# its own half and 0.1 m)
		offset = crown - mouth
		offset -= axis * offset.dot(axis)
		room = max(0.0, min(wide, tall) / 2 * (R - 2 * lip) / R - a["shank"] / 2 - 0.1)
		inside = mouth + axis * (depth / 2) + offset * min(1.0, room / max(offset.length, 1e-9))
		run = inside - crown
		square = run.cross(UP if abs(run.normalized().dot(UP)) < 0.9 else FORWARD).normalized()
		add(chamfered((crown + inside) / 2, (run.normalized(), square, run.normalized().cross(square)), (run.length, a["shank"], a["shank"]), cut,
			"anchor"), flat=True)
		MARKS[f"anchor_crown_{name}"] = (crown, "anchors")
		MARKS[f"anchor_stock_top_{name}"] = (high, "anchors")
		MARKS[f"anchor_stock_bottom_{name}"] = (low, "anchors")
	node("anchors", mesh=(vertices, faces, paints), smooth=smooth)


def sides():
	# What the hull carries outside its loft: the weapon sponsons and the small
	# deck-edge sponsons with their domes, the catwalks and the raft racks (one
	# fixed node); the weapons on the sponsons; and the openings in the hull
	# sides and transom, drawn dark a few centimetres proud of them
	top = LAYOUT["deck"]["height"]
	pieces = [prism(s["outline"], s["bottom"], s["top"]) for s in LAYOUT.get("sponsons", [])]
	for s in LAYOUT.get("sponsons", []):
		n = len(s["outline"])
		for k, (x, z) in enumerate(s["outline"]):
			for end in ("bottom", "top"):
				y = s[end][k] if isinstance(s[end], list) else s[end]
				MARKS[f"sponson_{s['name']}_{end}_{k + 1}"] = (at(x, y, z), "sponsons")
	pieces += domes_edge() + catwalks() + racks() + tubs()
	if pieces:
		node("sponsons", mesh=merge(pieces))
	nets()
	weapons = [piece for m in LAYOUT.get("weapons", {}).get("mounts", []) for piece in mounted(m)]
	if weapons:
		node("weapons", mesh=merge(weapons))
	openings = [face(o, [0, 0], "dark") for o in LAYOUT.get("openings", [])]
	if openings:
		node("openings", mesh=merge(openings))


def interpolate(x, xs, ys):
	# Piecewise linear, held at the ends
	if x <= xs[0]:
		return ys[0]
	for (x0, y0), (x1, y1) in zip(zip(xs, ys), zip(xs[1:], ys[1:])):
		if x <= x1:
			return y0 if x1 == x0 else y0 + (y1 - y0) * (x - x0) / (x1 - x0)
	return ys[-1]


def monotone(x, xs, ys):
	# A monotone cubic through the knots (Fritsch-Carlson), held at the ends:
	# it never overshoots between them, and turns level at a knot where the
	# run changes direction
	if x <= xs[0]:
		return ys[0]
	if x >= xs[-1]:
		return ys[-1]
	h = [b - a for a, b in zip(xs, xs[1:])]
	d = [(b - a) / w for a, b, w in zip(ys, ys[1:], h)]
	m = [d[0]] + [0.0 if d[k - 1] * d[k] <= 0 else 3 * (h[k - 1] + h[k]) / ((2 * h[k] + h[k - 1]) / d[k - 1] + (h[k] + 2 * h[k - 1]) / d[k])
		for k in range(1, len(d))] + [d[-1]]
	k = max(i for i in range(len(h)) if xs[i] <= x)
	t = (x - xs[k]) / h[k]
	return (ys[k] * (2 * t ** 3 - 3 * t ** 2 + 1) + h[k] * m[k] * (t ** 3 - 2 * t ** 2 + t)
		+ ys[k + 1] * (-2 * t ** 3 + 3 * t ** 2) + h[k] * m[k + 1] * (t ** 3 - t ** 2))


def zipped(vertices, top, bottom):
	# Triangles between two runs of vertex indices, each forward to aft (from
	# high x to low): a strip that advances along whichever run is behind in
	# its share of its own length
	def share(run, k):
		x0, x1 = vertices[run[0]].x, vertices[run[-1]].x
		return 1.0 if abs(x0 - x1) < 1e-9 else (x0 - vertices[run[k]].x) / (x0 - x1)

	triangles, i, j = [], 0, 0
	while i < len(top) - 1 or j < len(bottom) - 1:
		if j == len(bottom) - 1 or (i < len(top) - 1 and share(top, i + 1) <= share(bottom, j + 1)):
			triangles.append((top[i], top[i + 1], bottom[j]))
			i += 1
		else:
			triangles.append((top[i], bottom[j + 1], bottom[j]))
			j += 1
	return triangles


def edge(outlines, x, side):
	# The deck's edge at x on one side (+1 starboard, -1 port): the outermost
	# crossing of the plan outlines with the line at x, held at the deck's ends
	low = min(p[0] for o in outlines for p in o)
	high = max(p[0] for o in outlines for p in o)
	x = min(max(x, low + 1e-6), high - 1e-6)
	best = None
	for o in outlines:
		for a, b in zip(o, o[1:] + o[:1]):
			if (a[0] - x) * (b[0] - x) <= 0 and a[0] != b[0]:
				z = a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0])
				if best is None or z * side > best * side:
					best = z
	return best


def bulb(b, stem, front, foul):
	# The bulbous bow (hull.bulb): (vertices, faces, paints) of a loft of
	# sections from its tail forward to its nose, drawn smooth. Head on its
	# outline is b["outline"] ([y, half-breadth] from its foot up), carried on
	# above its top by the stem's front (front(y)) to the waterline. From the
	# side its forward edge is the stem's profile below the waterline (stem,
	# [x, y]) through a monotone cubic. At each height it keeps the outline's
	# half-breadth aft from where its nose begins, the nose a quarter ellipse
	# in plan b["nose"] long where the bulb is widest and shorter in proportion
	# above and below; aft of b["taper"][0] it narrows smoothly to nothing at
	# b["taper"][1], within the forefoot. Anti-fouling below its top (foul),
	# boot above.
	outline = b["outline"]
	oy, oh = [p[0] for p in outline], [p[1] for p in outline]
	widest = max(oh)
	profile = sorted((y, x) for x, y in stem if y <= 0)
	py, px = [p[0] for p in profile], [p[1] for p in profile]
	bottom, top = oy[0], py[-1]
	tip = max(range(len(px)), key=lambda k: px[k])
	ny, nx = py[tip], px[tip]
	(full, tail) = b["taper"]

	def nose(y):
		# the bulb's forward edge at a height
		return monotone(y, py, px)

	def solve(x, lo, hi):
		# the height between lo and hi where the forward edge reaches x
		for _ in range(60):
			middle = (lo + hi) / 2
			if (nose(middle) - x) * (nose(lo) - x) <= 0:
				hi = middle
			else:
				lo = middle
		return (lo + hi) / 2

	def width(y):
		return monotone(y, oy, oh) if y <= oy[-1] else front(y)

	def breadth(x, y):
		w = width(y)
		length = b["nose"] * w / widest
		if length <= 0:
			return 0.0
		u = max(0.0, min(1.0, (x - (nose(y) - length)) / length))
		t = max(0.0, min(1.0, (x - tail) / (full - tail)))
		return w * math.sqrt(1 - u * u) * t * t * (3 - 2 * t)

	# sections every metre along the taper and every third of a metre ahead
	# of it, each sampled down from its top to its bottom about a third of a
	# metre apart where the bulb is deepest: so many above the anti-fouling's
	# top and so many below, the paint's edge running along them; where a
	# section lies wholly to one side its share on the other side meets at
	# its end
	along = sorted(set([tail + (full - tail) * k / math.ceil(full - tail) for k in range(math.ceil(full - tail) + 1)]
		+ [full + (nx - full) * k / math.ceil((nx - full) * 3) for k in range(math.ceil((nx - full) * 3) + 1)]))
	split = min(max(foul, bottom), top)
	upper, lower = max(1, math.ceil((top - split) * 3)), max(1, math.ceil((split - bottom) * 3))
	vertices, rings = [], []
	for x in along:
		low = bottom if nose(bottom) >= x else solve(x, bottom, ny)
		high = top if nose(top) >= x else solve(x, ny, top)
		middle = min(max(split, low), high)
		heights = [high + (middle - high) * k / upper for k in range(upper)] + [middle + (low - middle) * k / lower for k in range(lower + 1)]
		side = [(y, breadth(x, y)) for y in heights]
		# starboard from the top down, then port back up
		rings.append(len(vertices))
		vertices += [at(x, y, z) for y, z in side] + [at(x, y, -z) for y, z in side[::-1]]
	n = 2 * (upper + lower + 1)
	faces = [(r + j, r + (j + 1) % n, r + n + (j + 1) % n, r + n + j) for r in rings[:-1] for j in range(n)]
	paints = ["antifouling" if max(vertices[q].z for q in f) <= foul + 1e-6 else "boot" for f in faces]
	return vertices, faces, paints


def hull():
	# The hull, a loft of sections every STEP from the transom to the bow.
	# Each section runs from the keel up each side's hull to its knuckle, out
	# along the flare to the foot of the gallery wall, and up that wall to the
	# deck's underside at the deck's edge; along a wall (hull.walls: the
	# quarters' and the port midbody's), to the foot of that wall and up it.
	# Along a quarter (hull.quarters) the section runs from the knuckle out
	# through the quarter's points to its wall's foot, or under a sponson to
	# the sponson's bottom at its inboard edge, and the quarter ends square at
	# both ends.
	# Below the knuckle the hull is symmetric: its half-breadth at a height is
	# read off the stations either side (the transom the first of them), and
	# ahead of the last it narrows to the stem. The flare is flat between its
	# creases: a section at every corner of the deck's edge and every knot of
	# the knuckle and the gallery, and where hull.flare gives creases that
	# slant, flat facets between them in place of the sections' strips.
	# Painted red below the anti-fouling's top, boot to the boot top, grey
	# above.
	h = LAYOUT.get("hull")
	if not h:
		return
	d = LAYOUT["deck"]
	under = d["height"] - d["thickness"]
	boot = h["boot"]
	# the anti-fouling's top: the boot-topping's lower edge (none, all boot below the boot top, without it)
	foul = h["antifouling"]["top"] if "antifouling" in h else -1e9
	if "antifouling" in h:
		COLOURS["antifouling"] = tuple(linear(c) for c in h["antifouling"]["colour"]) + (1,)
	stations = sorted(h["stations"] + [{"x": h["transom"]["x"], "points": h["transom"]["points"]}], key=lambda s: s["x"])
	sx = [s["x"] for s in stations]
	keels = [s["points"][0][0] for s in stations]
	# the stem's leading edge from the deck down, held from creeping forward
	# again below it (a bulb is its own part)
	stem, reach = [], float("inf")
	for x, y in sorted(h["stem"], key=lambda p: -p[1]):
		reach = min(reach, x)
		stem.append((reach, y))
	stem.sort(key=lambda p: p[1])
	outlines = [d["outline"]] + [e["outline"] for e in LAYOUT.get("elevators", [])]
	transom = sx[0]
	bow = max(p[0] for p in d["outline"])

	def ahead(y):
		# the stem's x at a height
		return interpolate(y, [p[1] for p in stem], [p[0] for p in stem])

	def low(x):
		# the hull's lowest point at x: the stations' keel, or the stem once
		# it has risen above it
		rising = sorted(stem)
		return max(interpolate(x, sx, keels), interpolate(x, [p[0] for p in rising], [p[1] for p in rising]) if x > rising[0][0] else -1e9)

	def crease(y):
		# the bow's forward edge's half-breadth at a height: the face's crease
		# from its bottom edge up (hull.face, a flat raked plate between two
		# straight creases); below it the stem's front (hull.front, its
		# half-width by height, rising into the face's bottom edge), nothing
		# below the front's lowest knot or where there is neither
		face = h.get("face")
		if face and y >= face["bottom"][0]:
			(y0, w0), (y1, w1) = face["bottom"], face["top"]
			return w0 + (min(y, y1) - y0) / (y1 - y0) * (w1 - w0)
		front = h.get("front", []) + ([face["bottom"]] if face and h.get("front") else [])
		return interpolate(y, [p[0] for p in front], [p[1] for p in front]) if front else 0.0

	fillet = h.get("fillet", 0.0)

	def rounding(y):
		# the radius the stem's front turns into the sides at a height (in
		# plan, hull.fillet, or its whole half-width where that is less); the
		# face above keeps its creases
		face = h.get("face")
		return 0.0 if face and y >= face["bottom"][0] else min(fillet, crease(y))

	def half(x, y, power=1.0):
		values = [interpolate(y, [p[0] for p in s["points"]], [p[1] for p in s["points"]]) for s in stations]
		value = interpolate(x, sx, values)
		if x > sx[-1]:
			# ahead of the last station each height runs straight to the bow's
			# forward edge there: the stem, or the face's crease above it, whose
			# sections take the face as their flat bottom (or, with a power over
			# 1, the share of the way raised to it: holding out, then turning
			# in). Below the face the stem's front turns into the sides round a
			# quarter circle
			front, end, radius = ahead(y), crease(y), rounding(y)
			start = front - radius
			share = max(0.0, min(1.0, (x - sx[-1]) / (start - sx[-1]))) if start > sx[-1] else 1.0
			value += (end - value) * share ** power
			if radius > 0 and x > start:
				u = min(1.0, (x - start) / radius)
				value = end - radius + radius * math.sqrt(1 - u * u)
		return value

	def knuckle(x, side):
		line = sorted(h["knuckle"]["starboard" if side > 0 else "port"])
		y = max(interpolate(x, [p[0] for p in line], [p[1] for p in line]), low(x))
		return y, half(x, y)

	def gallery(x, side):
		line = sorted(h["gallery"]["starboard" if side > 0 else "port"])
		return interpolate(x, [p[0] for p in line], [p[1] for p in line])

	walls = h.get("walls", {})
	flare = h.get("flare", {})
	quarters = {name: sorted(q, key=lambda s: s["x"]) for name, q in h.get("quarters", {}).items()}
	# every ring carries as many points between its knuckle and its foot as a
	# quarter's section has; outside a quarter they sit on the knuckle, where
	# tidy() welds them away
	counts = {len(s["points"]) for q in quarters.values() for s in q}
	assert len(counts) <= 1, "hull.quarters' sections differ in their number of points"
	K = counts.pop() if counts else 0
	for name, q in quarters.items():
		creases = [p[0] for c in flare.get(name, []) for p in (c[0], c[-1])]
		assert q[0]["x"] - 0.01 > transom, "a quarter ends forward of the transom"
		assert not creases or q[-1]["x"] + 0.01 < min(creases) or q[0]["x"] - 0.01 > max(creases), "a quarter clear of the flare's creases"
	# the bow's shoulders (hull.shoulders): forward of full the flare between
	# the knuckle and the gallery's foot follows the stations' points above the
	# knuckle, aft of start it runs straight, and between the two it goes its
	# share of the way from the straight line out to them. Ahead of the last
	# station they run to the face's crease by the share raised to power.
	# Every ring carries a point at each height those stations give above the
	# knuckle (levels), after the quarter's; aft of start they sit on the
	# point before, where tidy() welds them away
	shoulders = h.get("shoulders")
	levels = []
	if shoulders:
		start, full, power = shoulders["start"], shoulders["full"], shoulders.get("power", 1.0)
		lowest = min(min([interpolate(start, [p[0] for p in line], [p[1] for p in line])] + [p[1] for p in line if p[0] >= start])
			for line in (sorted(h["knuckle"][name]) for name in ("port", "starboard")))
		levels = sorted({y for s in stations if s["x"] >= start for y, z in s["points"] if lowest < y < under})
		for name in ("port", "starboard"):
			assert all(p[0] < start for c in flare.get(name, []) for p in c), "the shoulders clear of the flare's creases"
			assert all(w["wall"][-1][0] < start for w in walls.get(name, [])), "the shoulders clear of the walls"
			assert not quarters.get(name) or quarters[name][-1]["x"] < start, "the shoulders clear of the quarters"
	J = len(levels)

	def shoulder(x, ky, kz, foot, z):
		# the points at the shoulders' levels on a ring forward of their start,
		# between its knuckle (ky, kz) and its foot (foot, z): the straight
		# line's share of the way out to the stations' half-breadth, the share
		# easing in and out (smoothstep) so the shoulders leave the straight
		# flare level; a level at or below the knuckle sits on it, one at or
		# above the foot on that
		t = max(0.0, min(1.0, (x - start) / (full - start)))
		share = t * t * (3 - 2 * t)
		points = []
		for y in levels:
			if y <= ky:
				points.append((ky, kz))
			elif y >= foot:
				points.append((foot, z))
			else:
				straight = kz + (z - kz) * (y - ky) / (foot - ky)
				points.append((y, straight + (half(x, y, power) - straight) * share))
		return points

	def wall(x, side):
		# where a wall stands under the deck's edge: its |z| and its foot's
		# height, or None outside every wall on that side
		for w in walls.get("starboard" if side > 0 else "port", []):
			line = w["wall"]
			if line[0][0] <= x <= line[-1][0]:
				return abs(interpolate(x, [p[0] for p in line], [p[1] for p in line])), w["foot"]
		return None

	def quarter(x, side):
		# a quarter's section at x (hull.quarters: its points out from the
		# knuckle to where it meets its wall's foot or its sponson's bottom, as
		# [y, |z|]), straight between its measured sections; None outside it
		q = quarters.get("starboard" if side > 0 else "port")
		if not q or not q[0]["x"] <= x <= q[-1]["x"]:
			return None
		along = [s["x"] for s in q]
		return [(interpolate(x, along, [s["points"][k][0] for s in q]), abs(interpolate(x, along, [s["points"][k][1] for s in q]))) for k in range(K)]

	def inboard(x, side):
		# the inboard edge of a sponson standing over x on a side, as the |z|
		# and the height of its bottom there, or None where none does
		best = None
		for s in LAYOUT.get("sponsons", []):
			o = s["outline"]
			bottoms = s["bottom"] if isinstance(s["bottom"], list) else [s["bottom"]] * len(o)
			for k, (a, b) in enumerate(zip(o, o[1:] + o[:1])):
				if (a[0] - x) * (b[0] - x) <= 0 and a[0] != b[0] and a[1] * side > 0:
					t = (x - a[0]) / (b[0] - a[0])
					z = abs(a[1] + (b[1] - a[1]) * t)
					if best is None or z < best[0]:
						best = (z, bottoms[k] + (bottoms[(k + 1) % len(o)] - bottoms[k]) * t)
		return best

	# the sections: every STEP, and at every x where a line the flare runs
	# between turns (the deck's and elevators' corners, the knuckle's and the
	# gallery's knots, the walls' ends, the creases' ends), so the flare is
	# flat between them and creases only there
	turns = {p[0] for o in outlines for p in o}
	# and where the deck's edge steps out square (a side of its outline across
	# the ship), a section either side of the step, so the hull steps square
	# under the edge rather than sloping across to the section before
	deck = LAYOUT["deck"]["outline"]
	turns |= {a[0] + d for a, b in zip(deck, deck[1:] + deck[:1]) if a[0] == b[0] for d in (-0.01, 0.01)}
	for name in ("port", "starboard"):
		turns |= {p[0] for p in h["knuckle"][name]} | {p[0] for p in h["gallery"][name]}
		turns |= {w["wall"][e][0] for w in walls.get(name, []) for e in (0, -1)}
		turns |= {c[e][0] for c in flare.get(name, []) for e in (0, -1)}
		# and at each of a quarter's sections, with a section a centimetre past
		# either end, so it ends square: a face across the ship from its section
		# to the hull's either side of it
		if quarters.get(name):
			q = quarters[name]
			turns |= {s["x"] for s in q} | {q[0]["x"] - 0.01, q[-1]["x"] + 0.01}
	if shoulders:
		# and where the shoulders start and come in full
		turns |= {start, full}
	if h.get("front"):
		# and at each knot of the stem the front runs up, so its edges follow
		# the stem's profile
		top = h["face"]["bottom"][0] if h.get("face") else h["front"][-1][0]
		turns |= {ahead(p[0]) for p in h["front"]} | {x for x, y in stem if h["front"][0][0] <= y <= top}
		# and where it rises through the boot top, so the band's edge runs
		# round the stem along a section rather than through faces
		if h["front"][0][0] <= boot <= top:
			turns.add(ahead(boot))
		if fillet:
			# and behind its foot, where the stem stands upright, at the
			# quarter-angles of the fillet, so its front rounds there too
			foot = ahead(h["front"][0][0])
			turns |= {foot - fillet * (1 - math.cos(math.pi / 8 * k)) for k in range(1, 5)}
	turns = [x for x in turns if transom + 0.4 < x < bow - 0.4]
	count = max(2, int((bow - transom) / STEP) + 1)
	grid = [transom + (bow - transom) * k / (count - 1) for k in range(count)]
	xs = sorted(set([x for x in grid if all(abs(x - t) > 0.4 for t in turns)] + turns + [transom, bow]))

	LOWER, UPPER = 6, 8
	rings = []
	for x in xs:
		# nothing of the hull reaches the deck-edge band: a stem or flare drawn
		# up to the deck stops at the band's foot
		feet = {side: under - gallery(x, side) for side in (-1, 1)}
		y0 = min(low(x), min(feet.values()))
		knuckles = {}
		for side in (-1, 1):
			ky = min(knuckle(x, side)[0], feet[side])
			knuckles[side] = (ky, half(x, ky))
		# both sides sampled at the same heights up to the lower knuckle, so
		# the hull is symmetric there, then each to its own
		lower = min(k[0] for k in knuckles.values())
		b = min(max(boot, y0), lower)
		if y0 < foul < b:
			# the anti-fouling's top is a ring height, so the paint's edge runs
			# along the rings rather than through faces
			heights = [y0] + [y0 + (foul - y0) * (j + 1) / (LOWER - 2) for j in range(LOWER - 2)] + [foul + (b - foul) * (j + 1) / 2 for j in range(2)]
		else:
			heights = [y0] + [y0 + (b - y0) * (j + 1) / LOWER for j in range(LOWER)]
		heights += [b + (lower - b) * (j + 1) / UPPER for j in range(UPPER)]
		sides = {}
		for side in (-1, 1):
			ky, kz = knuckles[side]
			points = [(y, half(x, y)) for y in heights] + [(ky, kz)]
			standing = wall(x, side)
			section = quarter(x, side)
			if standing:
				# a wall: out from the knuckle (along a quarter's section) to its
				# foot and up it to the deck's underside, the deck overhanging any
				# inboard of its edge
				z, foot = standing
				points += section or [(ky, kz)] * K
				points += [points[-1]] * J + [(max(foot, ky), z), (under, z)]
			elif section:
				# a quarter under a sponson: along its section, then in or out to
				# the sponson's bottom at its inboard edge (the deck's edge at the
				# section's last point's height where none stands over it), and up
				# to the deck's edge
				z = abs(edge(outlines, x, side))
				reach = inboard(x, side)
				points += section + [section[-1]] * J + [(section[-1][0], z) if reach is None else (reach[1], reach[0]), (under, z)]
			else:
				# the flare: straight from the knuckle to the gallery's foot, or
				# over the bow's shoulders
				z = abs(edge(outlines, x, side))
				foot = max(feet[side], ky)
				points += [(ky, kz)] * K + (shoulder(x, ky, kz, foot, z) if shoulders and x >= start - 1e-9 else [(ky, kz)] * J)
				points += [(foot, z), (under, z)]
			sides[side] = [at(x, y, side * z) for y, z in points]
		rings.append(sides[-1][::-1] + [at(x, y0, 0)] + sides[1])
	n = len(rings[0])
	vertices = [v for ring in rings for v in ring]
	faces, paints, smooth = [], [], []

	def paint(face):
		# red anti-fouling below its top, the black boot-topping up to the boot
		# top, grey above
		top = max(vertices[q].z for q in face)
		return "antifouling" if top <= foul + 1e-6 else "boot" if top <= boot + 1e-6 else "grey"

	# each side's knuckle and the gallery wall's foot above it, as indices in
	# a ring: port first, reversed, then the keel, then starboard. Where they
	# are used (the flare's facets, the transom) no quarter runs and the
	# shoulders have not begun, so the K and J points sit on the knuckle and
	# the index beside the foot stands for it
	S = (n - 1) // 2
	columns = {-1: (2, 1), 1: (2 * S - 2, 2 * S - 1)}
	ring = {x: i for i, x in enumerate(xs)}
	# the stretch the creases cover on each side, whose sections' strips of
	# flare give way to the facets
	covered = {}
	for side, name in ((-1, "port"), (1, "starboard")):
		if flare.get(name):
			ends = [p[0] for c in flare[name] for p in (c[0], c[-1])]
			covered[side] = (min(ends), max(ends))
	for i in range(len(rings) - 1):
		for j in range(n - 1):
			skip = False
			for side, (lo, hi) in covered.items():
				knuckle_index, foot = columns[side]
				if min(knuckle_index, foot) == j and xs[i] >= lo - 1e-6 and xs[i + 1] <= hi + 1e-6:
					skip = True
			a, b = i * n + j, i * n + j + 1
			# nor a face lying wholly on the centreline: a fin of no thickness,
			# from where the stem stands upright with a knife edge to the next
			# section's foot ahead of it, built once from each side
			if skip or all(abs(vertices[q].y) < 1e-4 for q in (a, a + n, b + n, b)):
				continue
			faces.append((a, a + n, b + n, b))
			paints.append(paint(faces[-1]))
			# smooth from the keel up to the knuckles, and over the shoulders
			# up to the gallery's foot
			lower = K + J + 2 <= j <= 2 * S - K - J - 3
			flaring = bool(shoulders) and xs[i] >= start - 1e-9 and (1 <= j <= K + J + 1 or 2 * S - K - J - 2 <= j <= 2 * S - 2)
			smooth.append(lower or flaring)
	for side, (lo, hi) in covered.items():
		# the facets between each crease and the next, forward to aft: each a
		# polygon of the gallery's foot from one crease's top to the next's, the
		# aft crease down, the knuckle back to the forward crease's foot and
		# that crease up. A crease's own points (its middle) are new corners,
		# and a facet with one fans from it; one without is zipped between its
		# gallery foot and its knuckle
		knuckle_index, foot = columns[side]
		lines = [(ring[hi], [], ring[hi])]
		for course in flare["starboard" if side > 0 else "port"]:
			middle = []
			for p in course[1:-1]:
				vertices.append(at(*p))
				middle.append(len(vertices) - 1)
			lines.append((ring[course[0][0]], middle, ring[course[-1][0]]))
		lines.append((ring[lo], [], ring[lo]))
		for (t0, m0, b0), (t1, m1, b1) in zip(lines, lines[1:]):
			assert t0 >= t1 and b0 >= b1, "hull.flare's creases cross"
			top = [r * n + foot for r in range(t0, t1 - 1, -1)]
			bottom = [r * n + knuckle_index for r in range(b0, b1 - 1, -1)]
			polygon = top + m1 + bottom[::-1] + m0[::-1]
			apex = (m1 + m0)[:1]
			if apex:
				k = polygon.index(apex[0])
				polygon = polygon[k:] + polygon[:k]
				triangles = [(polygon[0], polygon[q], polygon[q + 1]) for q in range(1, len(polygon) - 1)]
			else:
				triangles = zipped(vertices, top, bottom)
			for t in triangles:
				# the polygon runs forward along the top, so its turn is the
				# starboard strips'; port's run the other way
				t = t if side > 0 else t[::-1]
				faces.append(t)
				paints.append(paint(t))
	# the transom, facing aft: a strip from the keel up, port point to
	# starboard point at each height, so it wears the same bands as the sides.
	# Under an upper transom (layout.transom) the strip stops at the knuckles
	# and a band runs up from them to its floor; upper_transom() closes the
	# rest, carrying the section above the floor aft to its face
	m = (n - 1) // 2
	above = LAYOUT.get("transom")
	faces.append((m - 1, m, m + 1))
	paints.append(paint(faces[-1]))
	for k in range(m - 3 if above else m - 1):
		faces.append((m - 1 - k, m + 1 + k, m + 2 + k, m - 2 - k))
		paints.append(paint(faces[-1]))
	if above:
		cut = {}
		for side, (knuckle_index, foot) in columns.items():
			a, b = vertices[knuckle_index], vertices[foot]
			t = min(max((above["floor"] - a.z) / (b.z - a.z), 0.0), 1.0) if abs(b.z - a.z) > 1e-9 else 0.0
			vertices.append(a.lerp(b, t))
			cut[side] = len(vertices) - 1
		faces.append((columns[-1][0], columns[1][0], cut[1], cut[-1]))
		paints.append("grey")
		section = [vertices[i] for i in (cut[-1], columns[-1][1], 0, n - 1, columns[1][1], cut[1])]
		upper_transom(transom, [[-v.y, v.z] for v in section])
	last = (len(rings) - 1) * n
	faces.append(tuple(range(last + n - 1, last - 1, -1)))   # the bow's end, facing forward
	paints.append("grey")
	# the faces from the keel up to the knuckles are smooth, the plating's
	# flats, walls, facets and ends flat
	smooth += [False] * (len(faces) - len(smooth))
	node("hull", mesh=(vertices, faces, paints), smooth=smooth)
	blisters = []
	for b in h.get("blisters", []):
		# a blister on the hull side (hull.blisters): its outline seen from
		# the side, rounded at each end or square, standing `depth` out from
		# the side and running on into it, so it follows the side's curve
		side = 1 if b["side"] == "starboard" else -1
		(x0, x1), (y0, y1) = b["x"], b["y"]
		if b.get("ends") == "round":
			r = (y1 - y0) / 2
			arc = [math.pi / 2 + math.pi * k / 8 for k in range(9)]
			outline = [(x0 + r + r * math.cos(a), (y0 + y1) / 2 + r * math.sin(a)) for a in arc]
			outline += [(x1 - r - r * math.cos(a), (y0 + y1) / 2 - r * math.sin(a)) for a in arc]
		else:
			outline = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
		m = len(outline)
		corners = [at(x, y, side * (half(x, y) + b["depth"])) for x, y in outline] + [at(x, y, side * (half(x, y) - 0.4)) for x, y in outline]
		walls = [(i, (i + 1) % m, m + (i + 1) % m, m + i) for i in range(m)]
		blisters.append((corners, [tuple(range(m)), tuple(range(2 * m - 1, m - 1, -1))] + walls, ["grey"] * (m + 2)))
	if blisters:
		node("hull_blisters", mesh=merge(blisters))
	if h.get("bulb"):
		node("hull_bulb", parent="hull", mesh=bulb(h["bulb"], h["stem"], crease, foul), smooth=True)
	if h.get("face"):
		# the face's corners, where its creases meet its bottom edge and the
		# deck-edge band, for the photo match
		for end, (y, w) in (("bottom", h["face"]["bottom"]), ("top", h["face"]["top"])):
			for name, side in (("port", -1), ("starboard", 1)):
				MARKS[f"hull_face_{end}_{name}"] = (at(ahead(y), y, side * w), "hull")
		if "bullnose" in h["face"]:
			# the bullnose ring on the face's centreline: it fixes the bow's
			# photos sideways, as nothing else near the bow does from ahead
			y = h["face"]["bullnose"]
			MARKS["hull_face_bullnose"] = (at(ahead(y), y, 0), "hull")
	draught = LAYOUT.get("lettering", {}).get("draught")
	if draught:
		# the stem's draught marks: each numeral a plate on the hull's side just
		# aft of the stem at its height, tangent to the side there
		plates, frames = [], []
		for numeral in draught["numerals"]:
			y0 = numeral["bottom"]
			y1 = y0 + draught["height"]
			middle = (y0 + y1) / 2
			x = ahead(middle) - draught["aft"]
			slope = (half(x + 0.05, middle) - half(x - 0.05, middle)) / 0.1
			w = draught["width"] * len(numeral["text"])
			for side in (-1, 1):
				along = Vector((1, 0, side * slope)).normalized()
				out = Vector((-slope, 0, side)).normalized()
				right = along * side
				centre = Vector((x, 0, side * half(x, middle)))
				corners = [centre - right * (w / 2), centre + right * (w / 2)]
				corners = [[c.x, y0, c.z] for c in corners] + [[c.x, y1, c.z] for c in corners[::-1]]
				plates.append(plate(corners, [out.x, out.y, out.z], paint="lettering"))
				frames.append({"middle": (x, middle, side * half(x, middle)), "right": tuple(right), "up": (0, 1, 0), "size": (w, draught["height"]),
					"cell": numeral["cell"]})
		node("hull_lettering", mesh=merge(plates))
		lettered("hull_lettering", frames)
	waterline = [x for x in [transom + (bow - transom) * k / 120 for k in range(121)] if x <= ahead(0) and low(x) <= 0]
	CURVES["hull_waterline_starboard"] = ([at(x, 0, half(x, 0)) for x in waterline], "hull")
	for side, name in ((-1, "port"), (1, "starboard")):
		CURVES[f"hull_knuckle_{name}"] = ([at(x, knuckle(x, side)[0], side * knuckle(x, side)[1]) for x in [transom + (bow - transom) * k / 60 for k in range(61)]], "hull")
		if quarters.get(name):
			# a quarter's aft end, as the photos of the transom see it: its
			# knuckle and its knee (its section's last point)
			x = quarters[name][0]["x"]
			ky, kz = knuckle(x, side)
			y, z = quarter(x, side)[-1]
			MARKS[f"hull_quarter_{name}_knuckle"] = (at(x, ky, side * kz), "hull")
			MARKS[f"hull_quarter_{name}_knee"] = (at(x, y, side * z), "hull")
	front = ahead(0)
	entrance = math.degrees(math.atan2(half(front - 10, 0), 10))
	return {"draught": round(-min(keels), 3), "entrance": round(entrance, 2), "waterline": {"stern": round(waterline[0], 3), "stem": round(front, 3),
		"half": [[round(x, 2), round(half(x, 0), 3)] for x in waterline[:: max(1, len(waterline) // 30)]]}}


def lettering_texture(facts):
	# The lettering (letters.py, in the system's Python as paint.py is) as the
	# lettering material's base colour
	folder = Path(tempfile.mkdtemp())
	png = folder / "lettering.png"
	subprocess.run(["python3", "-I", str(HERE / "letters.py"), str(png), "--facts", str(facts)], check=True)
	image = bpy.data.images.load(str(png))
	image.pack()
	png.unlink()
	folder.rmdir()
	tree = material("lettering").node_tree
	texture = tree.nodes.new("ShaderNodeTexImage")
	texture.image = image
	tree.links.new(texture.outputs["Color"], tree.nodes["Principled BSDF"].inputs["Base Color"])
	if LAYOUT["lettering"].get("cutout"):
		# alphaMode MASK: clear but for the text, so the plate shows the
		# weathered face behind it (the alpha rounded, as the nets')
		cut = tree.nodes.new("ShaderNodeMath")
		cut.operation = "ROUND"
		tree.links.new(texture.outputs["Alpha"], cut.inputs[0])
		tree.links.new(cut.outputs[0], tree.nodes["Principled BSDF"].inputs["Alpha"])


def deck_texture(facts):
	# The deck's paint (paint.py, run by the system's Python: Blender's has no
	# Pillow) as the deck material's base colour
	folder = Path(tempfile.mkdtemp())
	png = folder / "deck.png"
	subprocess.run(["python3", "-I", str(HERE / "paint.py"), str(png), "--facts", str(facts)], check=True)
	image = bpy.data.images.load(str(png))
	image.pack()
	png.unlink()
	folder.rmdir()
	tree = material("deck").node_tree
	texture = tree.nodes.new("ShaderNodeTexImage")
	texture.image = image
	tree.links.new(texture.outputs["Color"], tree.nodes["Principled BSDF"].inputs["Base Color"])


# The ship frame's box, which the position bake encodes into [0, 1]
FRAME_LOW, FRAME_SPAN = Vector((-220.0, -20.0, -80.0)), Vector((440.0, 120.0, 160.0))


def regroup():
	# Each weathered group's meshes (layout.weathering.groups) wear the group's
	# own material in place of the grey, which its atlas then textures; in a
	# draft build too, so a draft's materials are a full build's
	for group in LAYOUT.get("weathering", {}).get("groups", []):
		source = group.get("from", "grey")   # the paint the group takes over, the grey unless it names another
		COLOURS[group["material"]] = COLOURS[source]
		target = material(group["material"])
		for name in group["meshes"]:
			obj = NODES.get(name)
			if obj is None or obj.type != "MESH":
				continue
			for i, m in enumerate(obj.data.materials):
				if m.name == source:
					obj.data.materials[i] = target


def baked(objs, kind, size, tree_of, space="TANGENT", float_buffer=True, samples=1):
	# Bakes `kind` for the objects into a new image, each material slot of
	# theirs swapped for the material tree_of(image) builds while it bakes, at
	# `samples` a texel; returns the image's pixels, top row first (H, W, 4)
	import numpy as np
	bpy.context.scene.cycles.samples = samples
	image = bpy.data.images.new(f"bake_{kind}", size, size, alpha=True, float_buffer=float_buffer)
	image.colorspace_settings.name = "Non-Color"
	temporary = tree_of(image)
	kept = {}
	for o in objs:
		kept[o.name] = list(o.data.materials)
		for i in range(len(o.data.materials)):
			o.data.materials[i] = temporary
	bpy.ops.object.select_all(action="DESELECT")
	for o in objs:
		o.select_set(True)
	bpy.context.view_layer.objects.active = objs[0]
	bpy.ops.object.bake(type=kind, normal_space=space, margin=8, use_clear=True)
	for o in objs:
		for i, m in enumerate(kept[o.name]):
			o.data.materials[i] = m
	pixels = np.empty(size * size * 4, np.float32)
	image.pixels.foreach_get(pixels)
	bpy.data.materials.remove(temporary)
	bpy.data.images.remove(image)
	return pixels.reshape(size, size, 4)[::-1]


def emitting(source):
	# A material whose emission is `source` (a function adding the colour's
	# node to a tree), with the bake's target image node active
	def make(image):
		m = bpy.data.materials.new("bake")
		m.use_nodes = True
		tree = m.node_tree
		for n in list(tree.nodes):
			tree.nodes.remove(n)
		out = tree.nodes.new("ShaderNodeOutputMaterial")
		emit = tree.nodes.new("ShaderNodeEmission")
		tree.links.new(source(tree), emit.inputs["Color"])
		tree.links.new(emit.outputs["Emission"], out.inputs["Surface"])
		target = tree.nodes.new("ShaderNodeTexImage")
		target.image = image
		tree.nodes.active = target
		return m
	return make


def weathered(facts, out):
	# Each weathered group's atlas (weather.py): its meshes' faces in the
	# group's material unwrapped and packed into one, each texel's position,
	# normal and ambient occlusion baked, weather.py's colour and height maps
	# drawn from them, and the height baked into a tangent-space normal map;
	# the group's material wears the colour and the normal map
	import numpy as np
	spec = LAYOUT.get("weathering")
	if not spec:
		return
	scene = bpy.context.scene
	scene.render.engine = "CYCLES"
	scene.cycles.device = "CPU"
	if scene.world is None:
		scene.world = bpy.data.worlds.new("world")
	scene.world.light_settings.distance = spec.get("occlusion", 3.0)   # how far the occlusion looks, metres
	folder = Path(tempfile.mkdtemp(dir=Path(out).parent))
	for group in spec["groups"]:
		target = MATERIALS[group["material"]]
		objs = [NODES[n] for n in group["meshes"] if n in NODES and NODES[n].type == "MESH"]
		if not objs:
			continue
		size = group["size"]
		area = 0.0
		for o in objs:
			# one atlas layer a mesh, which each group's faces share, each
			# group packing its own into the whole square
			if "atlas" not in o.data.uv_layers:
				o.data.uv_layers.new(name="atlas")
			o.data.uv_layers.active = o.data.uv_layers["atlas"]
			for poly in o.data.polygons:
				poly.select = o.data.materials[poly.material_index] == target
				if poly.select:
					area += poly.area
		bpy.ops.object.select_all(action="DESELECT")
		for o in objs:
			o.select_set(True)
		bpy.context.view_layer.objects.active = objs[0]
		# the group's faces selected in edit mode, by face: in vertex mode the
		# vertices an earlier pass left selected decide what the UV operators
		# move, which packed faces outside the group into its atlas and
		# repacked a group already baked on the same mesh
		bpy.context.tool_settings.mesh_select_mode = (False, False, True)
		bpy.ops.object.mode_set(mode="EDIT")
		for o in objs:
			mesh = bmesh.from_edit_mesh(o.data)
			mine = {i for i, m in enumerate(o.data.materials) if m == target}
			for f in mesh.faces:
				f.select_set(False)
			for f in mesh.faces:
				f.select_set(f.material_index in mine)
			bmesh.update_edit_mesh(o.data)
		bpy.ops.uv.smart_project(angle_limit=1.15, island_margin=0.0, area_weight=0.0, scale_to_bounds=False)
		bpy.ops.uv.average_islands_scale()
		bpy.ops.uv.pack_islands(rotate=True, margin=4.0 / size)
		bpy.ops.object.mode_set(mode="OBJECT")
		# every other face's UVs gathered to one point while this group bakes (a
		# new layer gives each face the whole square; another group's packing
		# overlaps this one's), so only its own faces reach its images
		others = {}
		for o in objs:
			layer = o.data.uv_layers["atlas"]
			uv = np.empty(len(layer.data) * 2, np.float32)
			layer.data.foreach_get("uv", uv)
			mine = np.zeros(len(layer.data), bool)
			for poly in o.data.polygons:
				if o.data.materials[poly.material_index] == target:
					mine[poly.loop_start : poly.loop_start + poly.loop_total] = True
			others[o.name] = (~mine, uv.reshape(-1, 2)[~mine].copy())
			uv.reshape(-1, 2)[~mine] = 0.0
			layer.data.foreach_set("uv", uv)

		def position(tree):
			# the texel's place in the ship frame, scaled into the frame's box
			geometry = tree.nodes.new("ShaderNodeNewGeometry")
			low = tree.nodes.new("ShaderNodeVectorMath")
			low.operation = "SUBTRACT"
			low.inputs[1].default_value = FRAME_LOW
			span = tree.nodes.new("ShaderNodeVectorMath")
			span.operation = "DIVIDE"
			span.inputs[1].default_value = FRAME_SPAN
			tree.links.new(geometry.outputs["Position"], low.inputs[0])
			tree.links.new(low.outputs["Vector"], span.inputs[0])
			return span.outputs["Vector"]

		def facing(tree):
			geometry = tree.nodes.new("ShaderNodeNewGeometry")
			half = tree.nodes.new("ShaderNodeVectorMath")
			half.operation = "MULTIPLY_ADD"
			half.inputs[1].default_value = (0.5, 0.5, 0.5)
			half.inputs[2].default_value = (0.5, 0.5, 0.5)
			tree.links.new(geometry.outputs["Normal"], half.inputs[0])
			return half.outputs["Vector"]

		def plain(image):
			m = bpy.data.materials.new("bake")
			m.use_nodes = True
			target_node = m.node_tree.nodes.new("ShaderNodeTexImage")
			target_node.image = image
			m.node_tree.nodes.active = target_node
			return m

		# each map into the ship frame as it comes (Blender's (x, y, z) is the
		# ship's (x, -z, y)), dropping what it no longer needs before the next
		where = baked(objs, "EMIT", size, emitting(position))
		valid = where[..., 3] > 0.5
		low, span = np.array(FRAME_LOW[:], np.float32), np.array(FRAME_SPAN[:], np.float32)
		ship = np.empty(where.shape[:2] + (3,), np.float32)
		ship[..., 0] = low[0] + where[..., 0] * span[0]
		ship[..., 1] = low[2] + where[..., 2] * span[2]
		ship[..., 2] = -(low[1] + where[..., 1] * span[1])
		del where
		normal = baked(objs, "EMIT", size, emitting(facing), float_buffer=False)
		facing_ship = np.empty(normal.shape[:2] + (3,), np.float16)
		facing_ship[..., 0] = normal[..., 0] * 2 - 1
		facing_ship[..., 1] = normal[..., 2] * 2 - 1
		facing_ship[..., 2] = -(normal[..., 1] * 2 - 1)
		del normal
		ao = baked(objs, "AO", size, plain, float_buffer=False, samples=spec.get("samples", 32))[..., 0].astype(np.float16)
		maps = folder / f"{group['material']}.npz"
		np.savez(maps, position=ship, normal=facing_ship, ao=ao, valid=valid,
			texel=np.float32(math.sqrt(area / max(int(valid.sum()), 1))))
		del ship, facing_ship, ao, valid
		colour_png, height_png = folder / f"{group['material']}.png", folder / f"{group['material']}_height.png"
		subprocess.run(["python3", "-I", str(HERE / "weather.py"), str(maps), group["material"], str(colour_png), str(height_png),
			"--facts", str(facts)], check=True)
		maps.unlink()
		height = bpy.data.images.load(str(height_png))
		height.colorspace_settings.name = "Non-Color"

		def bumped(image):
			# the height, as a bump on a plain surface, for the normal bake
			m = bpy.data.materials.new("bake")
			m.use_nodes = True
			tree = m.node_tree
			bsdf = tree.nodes["Principled BSDF"]
			source = tree.nodes.new("ShaderNodeTexImage")
			source.image = height
			bump = tree.nodes.new("ShaderNodeBump")
			bump.inputs["Distance"].default_value = spec.get("relief", 0.01)   # metres of relief across the height map's range
			tree.links.new(source.outputs["Color"], bump.inputs["Height"])
			tree.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
			target_node = tree.nodes.new("ShaderNodeTexImage")
			target_node.image = image
			tree.nodes.active = target_node
			return m

		# a flat group (layout.weathering.groups[].flat) wears its colour alone,
		# no normal map
		normals = None if group.get("flat") else baked(objs, "NORMAL", size, bumped, float_buffer=False, samples=4)
		for o in objs:
			layer = o.data.uv_layers["atlas"]
			uv = np.empty(len(layer.data) * 2, np.float32)
			layer.data.foreach_get("uv", uv)
			rest, kept = others[o.name]
			uv.reshape(-1, 2)[rest] = kept
			layer.data.foreach_set("uv", uv)
		bpy.data.images.remove(height)
		height_png.unlink()
		colour = bpy.data.images.load(str(colour_png))
		colour.name = group["material"]
		colour.pack()
		colour_png.unlink()
		tree = target.node_tree
		bsdf = tree.nodes["Principled BSDF"]
		base = tree.nodes.new("ShaderNodeTexImage")
		base.image = colour
		mapped = tree.nodes.new("ShaderNodeUVMap")
		mapped.uv_map = "atlas"
		tree.links.new(mapped.outputs["UV"], base.inputs["Vector"])
		tree.links.new(base.outputs["Color"], bsdf.inputs["Base Color"])
		if normals is None:
			continue
		normal_image = bpy.data.images.new(f"{group['material']}_normal", size, size, alpha=False)
		normal_image.colorspace_settings.name = "Non-Color"
		normal_image.pixels.foreach_set(np.ascontiguousarray(normals[::-1]).ravel())
		normal_image.pack()
		bumpy = tree.nodes.new("ShaderNodeTexImage")
		bumpy.image = normal_image
		tree.links.new(mapped.outputs["UV"], bumpy.inputs["Vector"])
		relief = tree.nodes.new("ShaderNodeNormalMap")
		relief.uv_map = "atlas"
		tree.links.new(bumpy.outputs["Color"], relief.inputs["Color"])
		tree.links.new(relief.outputs["Normal"], bsdf.inputs["Normal"])
	folder.rmdir()


def ship_file(hulled):
	# The ship file (the plan's Contract, ford.json): the deck layout the
	# engine and the flight core read, and the points file
	d = LAYOUT["deck"]
	out = {"frame": {"origin": "centreline, deployed waterline, midway along the flight deck",
		"axes": "x forward, y up, z starboard, metres"}}
	out["deck"] = {"height": d["height"], "outline": d["outline"]}
	out["catapults"] = []
	for c in LAYOUT.get("catapults", []):
		(ax, az), (fx, fz) = c["track"]
		heading = math.degrees(math.atan2(-(fz - az), fx - ax))   # positive to port, as the engine reads it
		entry = {"number": c["number"], "x": c["battery"][0], "z": c["battery"][1], "heading": round(heading, 3),
			"stroke": c["stroke"]}
		if "speed" in FACTS.get("catapults", {}):
			entry["speed"] = FACTS["catapults"]["speed"]["value"]   # the end speed a shot is capped at
		if c.get("deflector"):
			f = c["deflector"]
			(px, pz), (sx, sz) = sorted(f["hinge"], key=lambda p: p[1])
			# the panel's heading: square to its hinge (port end to starboard
			# end), positive to port
			heading = math.degrees(math.atan2(sx - px, sz - pz))
			entry["deflector"] = {"x": round((px + sx) / 2, 3), "z": round((pz + sz) / 2, 3), "width": round(math.dist((px, pz), (sx, sz)), 3),
				"depth": f["depth"], "heading": round(heading, 3)}
		out["catapults"].append(entry)
	for key in ("landing", "lens", "parking", "lights", "consoles", "antennas"):
		if key in LAYOUT:
			out[key] = LAYOUT[key]
	if LAYOUT.get("island"):
		# the island as the server collides with it (decision 20): its prisms'
		# plans and heights, and the mast's top
		i = LAYOUT["island"]
		out["island"] = {"prisms": [{"outline": p["outline"], "bottom": p["bottom"], "top": p["top"]} for p in i.get("prisms", [])]}
		poles = i.get("poles", [])
		if poles:
			mast = max(poles, key=lambda p: p["top"])
			out["island"]["mast"] = {"position": mast["base"], "top": mast["top"]}
	if hulled:
		out["hull"] = hulled
		if LAYOUT["hull"].get("screws"):
			out["hull"]["screws"] = LAYOUT["hull"]["screws"]   # each pair's offset from the centreline, and their diameter: the wake's races
	out["elevators"] = [{"number": e["number"], "side": e["side"], "outline": e["outline"]} for e in LAYOUT.get("elevators", [])]
	out["texture"] = d["texture"]
	out["joints"] = dict(sorted(JOINTS.items()))
	return out


def main():
	global FACTS, LAYOUT
	args = sys.argv[sys.argv.index("--") + 1 :]
	facts = HERE / "facts.json"
	if "--facts" in args:
		i = args.index("--facts")
		facts = Path(args[i + 1])
		del args[i : i + 2]
	FACTS = json.loads(facts.read_text())
	LAYOUT = FACTS["layout"]
	out = [a for a in args if not a.startswith("--")]
	bpy.ops.wm.read_factory_settings(use_empty=True)
	flight_deck()
	elevators()
	catapults()
	consoles()
	arresting()
	antennas()
	island()
	sides()
	hulled = hull()
	anchors()
	regroup()
	if "--draft" not in args:
		deck_texture(facts)
		if "lettering" in MATERIALS:
			lettering_texture(facts)
		weathered(facts, out[0])
	bpy.ops.export_scene.gltf(filepath=out[0], export_format="GLB", export_yup=True, use_selection=False,
		export_apply=False, export_animations=False, export_extras=False)
	Path(out[1]).write_text(json.dumps(ship_file(hulled), indent="\t") + "\n")
	if len(out) > 2:
		features = {"about": "The model's named points and curves, each on the node it rides on, at rest in the ship frame (build.py).",
			"landmarks": {name: {"at": exported(p), "node": n} for name, (p, n) in sorted(MARKS.items())},
			"curves": {name: {"points": [exported(p) for p in points], "node": n} for name, (points, n) in sorted(CURVES.items())}}
		Path(out[2]).write_text(json.dumps(features, indent="\t") + "\n")


main()
