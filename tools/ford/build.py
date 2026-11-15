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
from depth import needed  # noqa: E402
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
	# what lies in shade: the band under the transom's catwalk (0.35-0.4 of
	# the grey's brightness in the same light, as the transom's recess read
	# in dvids7694418; the recesses, pits and grooves are the plating's grey,
	# the weathering's occlusion their shade); the drop-light bar the deck's
	# yellow
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
	# the bow's mooring chocks a pale grey: in dvids9688116 their sunlit
	# flanks read 1.6-1.8 times the plating beside them in linear light (their
	# tops near white with the sky's sheen), so 1.6 times the haze grey
	"chock": (0.48, 0.51, 0.53, 1),
	"brown": (0.15, 0.08, 0.04, 1),
	# the deck edge's coaming a weathered tan: in dvids9478807 its sunlit face
	# reads (0.84, 0.68, 0.47) of the deck's white lines in the same light,
	# here of the white above
	"coaming": (0.52, 0.42, 0.28, 1),
	# the lens's unlit cells, their faces' brighter half in dvids9478807 against
	# the sunlit white plate beside them (facing aft as they do), of the white
	# above: a dark violet-blue
	"cell": (0.01, 0.028, 0.097, 1),
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
# The round-down's fascia, a plate this thick where it hangs below the deck's underside
FASCIA = 0.03
# The most a plate on a face stands off it for the depth buffer's sake (plate())
STANDOFF = 0.08
# How much deeper a deflector's ribs across its rows are than those along them
RIBBED = 0.003
# How far under a well's sill its curb and comb stop, where the lowered platform rests
RESTING = 0.02
# A railing's posts, a little thinner than its top rail (0.05)
POST = 0.045
# How far short of a face it would otherwise lie in a part's end stops (a
# blister's ribs at its top and bottom)
SHORT = 0.01
# The paints drawn on both sides of their faces: sheets seen from either side,
# the glazing's panes and the nets. Every other face is seen from its front
# only, the side it is wound to face (the sides check, sides())
BOTH = {"pane", "net"}
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
	# where two pieces touch face to face on the same corners (a sponson's
	# body on its foot), the two faces between them go and the solids are
	# one: welded, one of them stayed inside, lying a little behind the outer
	# face that faces its way (the body's bottom 0.75 m over the foot's), for
	# the depth buffer to draw through it from far off. Of two pieces' faces
	# in one place facing one way, one stays. Settled before the weld, which
	# merges faces on the same corners into one; a piece's own two faces on
	# the same corners (a sheet drawn both ways) stay
	bm.normal_update()
	places = {}
	for f in bm.faces:
		places.setdefault(tuple(sorted(tuple(round(c, 4) for c in v.co) for v in f.verts)), []).append(f)
	pairs = [faces for faces in places.values() if len(faces) == 2 and not set(faces[0].verts) & set(faces[1].verts)]
	gone = []
	if pairs:
		# each piece (its faces joined by their vertices, before the weld) and
		# its middle: two pieces either side of their shared face meet there
		# (a membrane, whichever way each was wound); on one side, they share
		# a face of their outside
		bm.verts.index_update()
		parent = list(range(len(bm.verts)))

		def root(i):
			while parent[i] != i:
				parent[i] = parent[parent[i]]
				i = parent[i]
			return i
		for f in bm.faces:
			first = root(f.verts[0].index)
			for v in f.verts[1:]:
				parent[root(v.index)] = first
		total, count = {}, {}
		for v in bm.verts:
			r = root(v.index)
			total[r] = total.get(r, Vector()) + v.co
			count[r] = count.get(r, 0) + 1
		for faces in pairs:
			n, q = faces[0].normal, faces[0].verts[0].co
			sides = [(total[r] / count[r] - q).dot(n) for r in (root(f.verts[0].index) for f in faces)]
			gone += faces if sides[0] * sides[1] < 0 else faces[1:]
	if gone:
		bmesh.ops.delete(bm, geom=gone, context="FACES_ONLY")
	bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
	bm.faces.index_update()
	# only a closed piece has an outside to turn to: each connected piece of
	# the mesh that is closed is turned outward on its own, and an open one
	# (the deck's top, its edge plate) keeps the winding it was built with.
	# Turning only a mesh closed as a whole left every part of a node with one
	# open part (a railing's bar, a plate) as built: shape()'s boxes inward,
	# and the bakes read their faces as facing into the solid
	seen = set()
	for start in bm.faces:
		if start.index in seen:
			continue
		piece, todo = [], [start]
		seen.add(start.index)
		while todo:
			f = todo.pop()
			piece.append(f)
			for e in f.edges:
				for g in e.link_faces:
					if g.index not in seen:
						seen.add(g.index)
						todo.append(g)
		if all(len(e.link_faces) == 2 for f in piece for e in f.edges):
			bmesh.ops.recalc_face_normals(bm, faces=piece)
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


def unique(bm, paints, prefer=()):
	# Faces on the same vertices, as Blender's exact boolean leaves where a cut
	# meets a face in its own plane or where two of the cut's blocks meet,
	# settled here by rule. Left in, the glTF exporter's mesh.validate() would
	# delete all but one of each, whichever came first, from the very mesh it
	# exports.
	# Faces wound both ways: each stays only where more of the faces round it
	# (not on its vertices) wind with it than against it, so an outside surface
	# counted twice keeps its outward face, and a membrane between two solids,
	# agreeing with each solid as often as it disagrees, goes. Of the faces
	# left, one stays: of a paint in `prefer` where one has it (`paints`, the
	# mesh's material names)
	bm.verts.index_update()
	bm.faces.index_update()
	groups = {}
	for f in bm.faces:
		groups.setdefault(frozenset(v.index for v in f.verts), []).append(f)
	gone = []
	for faces in groups.values():
		if len(faces) < 2:
			continue
		links = {len(e.link_faces) for f in faces for e in f.edges}
		if links <= {len(faces)}:
			continue   # a sheet of faces on the same corners, joined to nothing else: no membrane
		if len(faces) == 2 and links == {4}:
			# between two solids, each edge on a face of each beside the pair:
			# a membrane, whichever way the solids were wound
			gone += faces
			continue
		def agreement(f):
			votes = 0
			for loop in f.loops:
				for other in loop.edge.link_loops:
					if other.face not in faces:
						votes += 1 if other.vert != loop.vert else -1
			return votes
		kept = faces
		if any(f.normal.dot(faces[0].normal) < 0 for f in faces[1:]):
			kept = [f for f in faces if agreement(f) > 0]
		if kept:
			best = min(kept, key=lambda f: (f.material_index >= len(paints) or paints[f.material_index] not in prefer, f.index))
			kept = [best]
		gone += [f for f in faces if f not in kept]
	if gone:
		bmesh.ops.delete(bm, geom=gone, context="FACES_ONLY")


def joint(name, axis, arm, want, drive, keys, motion="rotate", follows=None):
	# Records a joint. The axis is turned so that a positive angle moves `arm`
	# (from the hinge toward the moving part) toward `want`, or a positive
	# slide moves along `want`. A joint that `follows` another takes that
	# joint's value as its keys' input
	axis = axis.normalized()
	if (axis.cross(arm).dot(want) if motion == "rotate" else axis.dot(want)) < 0:
		axis = -axis
	JOINTS[name] = {"motion": motion, "axis": exported(axis), "drive": drive, "keys": keys}
	if follows:
		JOINTS[name]["follows"] = follows


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
	# (vertices, faces) of a closed bmesh primitive that make(bm) adds. The
	# faces are put in a fixed order, each keeping its winding: Blender's UV
	# sphere gives the same vertices every run but its faces in a different
	# order each time, which reordered the exported triangles, the normals the
	# exporter writes and the atlases' packing from one build to the next
	bm = bmesh.new()
	make(bm)
	bm.verts.index_update()
	vertices = [v.co.copy() for v in bm.verts]
	faces = sorted((tuple(v.index for v in f.verts) for f in bm.faces), key=lambda f: (sorted(f), f))
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
	if along.cross(across).dot(UP) < 0:
		# its axes left-handed (across to port): turned outward all the same,
		# as a box welded to its neighbours is not turned by tidy()
		faces = [f[::-1] for f in faces]
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
	return {"distance": distance, "height": height, "foot": foot, "share": share, "cuts": cuts, "inward": (nx, nz), "edge": (ax, az)}


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
	# the blast deflectors' openings: the top cut along each one's four sides
	# and the faces inside left out, so a raised panel shows its pit; before
	# the round-down, which lowers the cuts' new points to its curve with the rest
	cut = HINGES["deck"]
	for c in LAYOUT.get("catapults", []):
		if not c.get("deflector"):
			continue
		corner, edge, aft, width, depth = opening(c, top)
		quad = [corner, corner + edge * width, corner + edge * width + aft * depth, corner + aft * depth]
		for a, b in zip(quad, quad[1:] + quad[:1]):
			bmesh.ops.bisect_plane(bm, geom=list(bm.verts) + list(bm.edges) + list(bm.faces), plane_co=a - cut, plane_no=(b - a).cross(UP).normalized())
		bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=1e-4)
		middle = lambda f: f.calc_center_median() + cut - corner
		inside = [f for f in bm.faces if 0 < middle(f).dot(edge) < width and 0 < middle(f).dot(aft) < depth]
		bmesh.ops.delete(bm, geom=inside, context="FACES")
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
	bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3], quad_method="BEAUTY", ngon_method="BEAUTY")
	bm.to_mesh(data)
	bm.free()
	painted("deck")
	sides = [(i, n + i, n + (i + 1) % n, (i + 1) % n) for i in range(n)]
	height = shape["height"] if shape else (lambda x, z: top)
	foot = shape["foot"] if shape else (lambda x, z: bottom)
	vertices = [at(x, height(x, z), z) for x, z in ring] + [at(x, foot(x, z), z) for x, z in ring]
	# where the round-down's fascia hangs below the underside, a plate
	# FASCIA thick: its inner face (the ring drawn in, facing inboard) from
	# the underside down to its foot, and its lower edge. Drawn on one side
	# only, a sheet there showed its back from under the overhang at the
	# deck's aft corners, where nothing stands behind it
	inward = []
	for k, (x, z) in enumerate(ring):
		normals = []
		for a, b in ((ring[k - 1], ring[k]), (ring[k], ring[(k + 1) % n])):
			dx, dz = b[0] - a[0], b[1] - a[1]
			length = math.hypot(dx, dz)
			normals.append((dz / length, -dx / length))   # area() negative, its inside on each side's right in (x, z)
		mx, mz = normals[0][0] + normals[1][0], normals[0][1] + normals[1][1]
		size = math.hypot(mx, mz)
		mx, mz = mx / size, mz / size
		scale = FASCIA / max(mx * normals[0][0] + mz * normals[0][1], 0.3)
		inward.append((x + mx * scale, z + mz * scale))
	hanging = [k for k in range(n) if foot(*ring[k]) < bottom - 1e-6 or foot(*ring[(k + 1) % n]) < bottom - 1e-6]
	for k in hanging:
		m = (k + 1) % n
		base = len(vertices)
		vertices += [at(inward[k][0], bottom, inward[k][1]), at(inward[k][0], foot(*ring[k]), inward[k][1]),
			at(inward[m][0], bottom, inward[m][1]), at(inward[m][0], foot(*ring[m]), inward[m][1])]
		sides += [(base + 2, base + 3, base + 1, base), (n + m, n + k, base + 1, base + 3)]
	node("deck_skirt", mesh=(vertices, sides, ["grey"] * len(sides)))
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


def side_name(e):
	# an entry's side, "starboard" or "port", given by name or by sign
	return "starboard" if e["side"] in ("starboard", 1) else "port"


def well(e):
	# An elevator's well (layout.elevators' well: the rails the platform runs
	# on, their x at the hull side), in plan as [x, |z|] corners from aft:
	# its aft end at the deck's edge, the hull side between the rails along
	# the platform's inboard edge (the mean |z| of its inboard corners), its
	# forward end at the deck's edge; each end parallel to the platform's own,
	# moved as far as its rail is from the platform's inboard corner, and on
	# by half its rail's width (well.rail), the rail standing on the wall
	# against the end. None without one
	w = e.get("well")
	if not w:
		return None
	corners = sorted(e["outline"], key=lambda p: abs(p[1]))
	inboard, outboard = sorted(corners[:2]), sorted(corners[2:])
	z = sum(abs(p[1]) for p in inboard) / 2
	half = w.get("rail", {}).get("width", 0.0) / 2
	aft, forward = w["rails"][0] - half, w["rails"][1] + half
	plan = [(outboard[0][0] + aft - inboard[0][0], abs(outboard[0][1])), (aft, z), (forward, z),
		(outboard[1][0] + forward - inboard[1][0], abs(outboard[1][1]))]
	# an end measured (well.ends: its x at the platform's inboard edge and at
	# the deck's edge) stands where it was measured, square across the ship or
	# slanted as it is, clear of the rail beside it
	ends = w.get("ends", {})
	if "aft" in ends:
		plan[1], plan[0] = (ends["aft"][0], z), (ends["aft"][1], plan[0][1])
	if "forward" in ends:
		plan[2], plan[3] = (ends["forward"][0], z), (ends["forward"][1], plan[3][1])
	return plan


def elevators():
	# Each deck-edge elevator's platform, a node sliding down its trunk to the
	# hangar deck (well.hangar, the deck the platform's top comes down to).
	# Decision 14 keeps them at deck level, so nothing drives them yet. Each
	# rail's foot at the hangar deck is a landmark on the hull
	d = LAYOUT["deck"]
	for e in LAYOUT.get("elevators", []):
		name = f"elevator_{e['number']}"
		top = d["height"]
		x = sum(p[0] for p in e["outline"]) / len(e["outline"])
		z = sum(p[1] for p in e["outline"]) / len(e["outline"])
		# its top the deck's, its underside and edges the plating's grey,
		# weathered with the hull (layout.weathering)
		node(name, hinge=at(x, top, z), mesh=slab(e["outline"], top, top - e["thickness"], ("deck", "grey", "grey")))
		painted(name)
		hangar = e["well"]["hangar"]
		joint(name, UP, Vector(), DOWN, "none yet (decision 14)", [[0, 0], [1, round(top - hangar, 4)]], motion="slide")
		for i, (px, pz) in enumerate(e["outline"]):
			MARKS[f"{name}_corner_{i + 1}"] = (at(px, top, pz), name)
		sign = 1 if side_name(e) == "starboard" else -1
		z = well(e)[1][1]
		for end, px in zip(("aft", "forward"), e["well"]["rails"]):
			MARKS[f"well_{e['number']}_{end}"] = (at(px, hangar, sign * z), "hull")


def catapults():
	# Each catapult's shuttle (sliding forward along its track from battery)
	# and its blast deflector (hinged at its forward edge, rising behind the
	# jet). Their shapes are the photos' (layout.fittings); their places the
	# deck plan's.
	fittings = LAYOUT["fittings"]
	top = LAYOUT["deck"]["height"]
	pits = []
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
		if c.get("deflector"):
			pits += deflector(c, number, top)
	if pits:
		node("pits", mesh=merge(pits))


def opening(c, top):
	# The opening a catapult's blast deflector lies flush in (layout.catapults
	# .deflector: its forward edge's two ends, square to the ship rather than
	# to the track, and its depth aft of it), inside the deck's yellow band:
	# its forward corner at the first end, unit vectors along the edge and
	# aft, its width and its depth
	f = c["deflector"]
	ends = [at(p[0], top, p[1]) for p in f["hinge"]]
	edge = (ends[1] - ends[0]).normalized()
	aft = UP.cross(edge).normalized()
	if aft.dot(FORWARD) > 0:
		aft = -aft
	return ends[0], edge, aft, (ends[1] - ends[0]).length, f["depth"]


def knee(b, a, crank, rod, side):
	# Where a crank from b and a rod to a meet, (u, v) in a deflector's
	# section, on the side of the line b-a that `side` (1 or -1) names
	d = math.dist(b, a)
	assert abs(crank - rod) <= d <= crank + rod, "the deflector's linkage reaches its panel"
	e = ((a[0] - b[0]) / d, (a[1] - b[1]) / d)
	x = (crank * crank - rod * rod + d * d) / (2 * d)
	h = math.sqrt(max(crank * crank - x * x, 0.0))
	return (b[0] + x * e[0] - side * h * e[1], b[1] + x * e[1] + side * h * e[0])


def deflector(c, number, top):
	# A catapult's blast deflector (layout.fittings.deflector): a panel hinged
	# at the forward edge of its opening, inside the deck's yellow band, lying
	# flush in it and rising behind a jet on the catapult. Its face (the top
	# lowered, the jet's side raised) is `modules` modules across and `rows`
	# rows of tiles in the deck's paint, `groove` apart over a darker plate
	# `face` thick; its back a grid of ribs, `cells` cells across each module,
	# to its `thickness`; its free edge striped red and white, a lug at each
	# module's middle. Two struts a module, each a crank from a bearing in the
	# pit and a rod to the panel's back (the catapult's deflector.linkage: the
	# crank's pivot in the panel's section, the two lengths), follow its angle
	# through their keys: all the cranks one node, all the rods another, hung
	# from it. Returns the pit's pieces: its walls, its floor and the bearings
	k = LAYOUT["fittings"]["deflector"]
	corner, edge, aft, width, depth = opening(c, top)
	gap = k["clearance"]
	across, high, out = k["lug"]
	thick, face, groove = k["thickness"], k["face"], k["groove"]
	W, D = width - 2 * gap, depth - 2 * gap - out
	origin = corner + edge * gap + aft * gap
	axes = (aft, edge, UP)

	def p(u, v, w):
		# a point in the panel's section, at rest: u aft of the hinge, v up
		# from the deck, w along the hinge from its first end
		return origin + aft * u + UP * v + edge * w

	name = f"catapult_{number}_deflector"
	modules, rows, cells = k["modules"], k["rows"], k["cells"]
	pieces = []
	# the face's tiles in the deck's paint, sunk `sink` into the plate
	sink = 0.05
	for m in range(modules):
		for r in range(rows):
			u0, u1 = r * D / rows + groove / 2, (r + 1) * D / rows - groove / 2
			w0, w1 = m * W / modules + groove / 2, (m + 1) * W / modules - groove / 2
			vertices, faces, paints = cuboid(p((u0 + u1) / 2, -sink / 2, (w0 + w1) / 2), axes, (u1 - u0, w1 - w0, sink))
			paints[1] = "deck"
			pieces.append((vertices, faces, paints))
	# the plate, in the grooves, and the back's ribs: the grooves' floors and
	# the back's cells between its ribs the plating's grey, which the
	# weathering's occlusion shades
	vertices, faces, paints = cuboid(p(D / 2, -(face + sink) / 2, W / 2), axes, (D, W, face - sink))
	pieces.append((vertices, faces, paints))
	rib = k["rib"]
	# each rib ending half a rib short of the panel's edge, inside the rib
	# that runs along the edge (ending at the edge, its end lay in that rib's
	# outer face's plane), and the ribs across the rows RIBBED deeper than
	# those along them (as deep, their backs met in one plane at every
	# crossing): so nothing of one lies in another's face, for the depth
	# buffer to draw through each other
	for j in range(modules * cells + 1):
		w = min(max(j * W / (modules * cells), rib / 2), W - rib / 2)
		pieces.append(cuboid(p(D / 2, -(face + thick) / 2, w), axes, (D - rib, rib, thick - face)))
	for i in range(rows + 1):
		u = min(max(i * D / rows, rib / 2), D - rib / 2)
		pieces.append(cuboid(p(u, -(face + thick + RIBBED) / 2, W / 2), axes, (rib, W - rib, thick - face + RIBBED)))
	# the free edge's stripes, leaning 45 degrees across the plate's edge, a
	# little under the face so that lowered they stay in the gap's shadow
	pitch, band = k["stripe"], face - sink
	for i in range(int(W / pitch) + 2):
		w0 = i * pitch - band
		quad = [(-face, w0), (-face, w0 + pitch), (-sink, w0 + pitch + band), (-sink, w0 + band)]
		quad = [p(D, v, min(max(w, 0.0), W)) for v, w in quad]
		if (quad[1] - quad[0]).length < 1e-3 and (quad[2] - quad[3]).length < 1e-3:
			continue
		slab = quad + [q + aft * 0.006 for q in quad]
		pieces.append((slab, [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)], ["red" if i % 2 else "white"] * 6))
	# a lug at each module's middle, standing out of the free edge
	for m in range(modules):
		pieces.append(cuboid(p(D + out / 2, -high / 2 - 0.01, (m + 0.5) * W / modules), axes, (out, across, high), "brown"))
	# the struts: a pair a module, each side of its middle, and the fitting
	# on the back each rod pins to
	lk, own = k["linkage"], c["deflector"]["linkage"]
	a, (bu, bv) = lk["attach"] * D, own["pivot"]
	crank, rod, side = own["crank"], own["rod"], lk["bend"]
	struts = [(m + 0.5) * W / modules + sign * lk["spread"] * W for m in range(modules) for sign in (-1, 1)]
	for w in struts:
		pieces.append(cuboid(p(a, -thick - 0.04, w), axes, (0.22, 0.18, 0.08)))
	node(name, hinge=p(0, 0, W / 2), mesh=merge(pieces))
	painted(name)
	# its angle through its raise, as measured (fittings.deflector.motion: the
	# raise's time, and each share of that time's share of the angle): keys in
	# seconds into it, which a lowering runs back along, as the same orifice
	# meters the cylinders both ways
	angle = math.radians(k["angle"])
	motion = k["motion"]
	keys = [[round(s * motion["time"], 3), round(angle * a, 4)] for s, a in motion["keys"]]
	joint(name, edge, aft, UP, "raised behind a jet on the catapult: seconds into its raise, lowered back along them", keys)

	# the linkage through the panel's travel: where its back's fitting is,
	# and where the crank and the rod meet
	def attach(th):
		return (a * math.cos(th) + thick * math.sin(th), a * math.sin(th) - thick * math.cos(th))

	steps = [angle * i / lk["keys"] for i in range(lk["keys"] + 1)]
	knees = [knee((bu, bv), attach(th), crank, rod, side) for th in steps]
	turn = lambda q, o: math.atan2(q[1] - o[1], q[0] - o[0])
	first = (turn(knees[0], (bu, bv)), turn(attach(0), knees[0]))
	keys = {"crank": [], "rod": []}
	lowest = bv
	for th, kn in zip(steps, knees):
		phi = turn(kn, (bu, bv)) - first[0]
		psi = turn(attach(th), kn) - first[1]
		keys["crank"].append([round(th, 4), round(phi, 4)])
		keys["rod"].append([round(th, 4), round(psi - phi, 4)])
		lowest = min(lowest, kn[1])
	size_crank, size_rod = lk["sizes"]
	pit = k["pit"]
	assert -lowest + size_crank < pit < LAYOUT["deck"]["thickness"], "the linkage clears the pit's floor, the pit inside the deck"
	k0, a0 = knees[0], attach(0)
	assert max(k0[1], bv) + size_crank * 0.7 < -thick, "lowered, the linkage (its bearing's boss too) lies under the panel"
	cranks, rods = [], []
	for w in struts:
		cranks.append(bar(exported(p(bu, bv, w)), exported(p(k0[0], k0[1], w)), size_crank, "white"))
		cranks.append(cuboid(p(bu, bv, w), axes, (size_crank * 1.4, size_crank * 1.4, size_crank * 1.4), "white"))
		rods.append(bar(exported(p(k0[0], k0[1], w)), exported(p(a0[0], a0[1], w)), size_rod, "white"))
		rods.append(cuboid(p(k0[0], k0[1], w), axes, (size_crank * 1.5, size_crank * 1.5, size_crank * 1.5), "white"))
	for part, mesh, pivot, parent in (("crank", cranks, p(bu, bv, W / 2), None), ("rod", rods, p(k0[0], k0[1], W / 2), f"{name}_crank")):
		node(f"{name}_{part}", parent=parent, hinge=pivot, mesh=merge(mesh))
		joint(f"{name}_{part}", edge, aft, UP, f"follows {name}", keys[part], follows=name)

	# the pit: its walls from the deck down, its floor, and a bearing under
	# each crank's pivot
	def q(u, v, w):
		return corner + aft * u + UP * v + edge * w

	# walls and floor wound to face into the pit, the side the weathering's
	# occlusion is baked from: the walls the plating's grey, the floor dark
	walls = [[q(0, 0, 0), q(0, 0, width), q(0, -pit, width), q(0, -pit, 0)],
		[q(0, 0, width), q(depth, 0, width), q(depth, -pit, width), q(0, -pit, width)],
		[q(depth, 0, width), q(depth, 0, 0), q(depth, -pit, 0), q(depth, -pit, width)],
		[q(depth, 0, 0), q(0, 0, 0), q(0, -pit, 0), q(depth, -pit, 0)]]
	found = [(quad[::-1], [(0, 1, 2, 3)], ["grey"]) for quad in walls]
	found.append(([q(depth, -pit, 0), q(depth, -pit, width), q(0, -pit, width), q(0, -pit, 0)], [(0, 1, 2, 3)], ["dark"]))
	for w in struts:
		found.append(cuboid(p(bu, (bv - pit) / 2, w), axes, (size_crank * 1.2, size_crank * 1.6, bv + pit)))
	return found


def consoles():
	# The catapults' integrated control stations (ICCS): each a cab sunk in the
	# surface it sits in (`top`, the deck's unless given) and rising `rise` out
	# of it while its catapults are manned. Its lid is the layout's `outline`,
	# a plate `lid` thick whose top wears the deck's paint (stowed, that top
	# lies under the surface, STOWED or as far as the lid's size needs); under
	# it a darker tier `tier` deep, set in
	# by as much; then the body, its faces leaning in from its foot (`inset[0]`
	# inside the outline) to its top (`inset[1]`), `panes` windows in each face
	# (a count a side, from the outline's first corner) in frames `frame`
	# wide; and under its foot a skirt `skirt` deep, which stays below the
	# surface when it is raised
	k = LAYOUT["fittings"]["console"]
	for c in LAYOUT.get("consoles", []):
		surface = c.get("top", LAYOUT["deck"]["height"])
		lid, tier = c.get("lid", k["lid"]), c.get("tier", k["tier"])
		# stowed as far under the surface as its lid's size needs for the
		# game's depth buffer to keep the two apart from afar (depth.py)
		xs, zs = [p[0] for p in c["outline"]], [p[1] for p in c["outline"]]
		stowed = max(STOWED, 1.1 * needed(min(max(xs) - min(xs), max(zs) - min(zs))))
		travel = c["rise"] + stowed
		# its heights at rest: raised, less the travel
		top = surface - stowed
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
	# the sheaves in their own white where the facts give it, their arms in theirs
	paint = "grey"
	if "colour" in fittings.get("sheave", {}):
		COLOURS["sheave"] = tuple(linear(c) for c in fittings["sheave"]["colour"]) + (1,)
		paint = "sheave"
	arm = fittings.get("sheave", {}).get("arm")
	if arm and "colour" in arm:
		COLOURS["arm"] = tuple(linear(c) for c in arm["colour"]) + (1,)
	for sheave in landing.get("sheaves", []):
		k = fittings["sheave"]
		base = plan(sheave["centre"])
		name = sheave["name"].replace("_port", "_sheave_port").replace("_starboard", "_sheave_starboard")
		vertices, faces = primitive(lambda bm: bmesh.ops.create_cone(bm, cap_ends=True,
			segments=16, radius1=k["diameter"] / 2, radius2=k["diameter"] / 2, depth=k["height"],
			matrix=Matrix.Translation(base + UP * (k["height"] / 2))))
		pieces = [(vertices, faces, [paint] * len(faces))]
		mark = k.get("triangle")
		if mark:
			# a triangle painted on the drum's side facing its wire, inboard
			# (fittings.sheave.triangle): its base `width` wide along the top
			# edge, its apex at the foot, standing just off the side
			side = -1 if name.endswith("_port") else 1
			# (its own names: `along` is the landing line's, which the supports below use)
			inward, fore = at(0, 0, -side) - at(0, 0, 0), at(1, 0, 0) - at(0, 0, 0)
			r = k["diameter"] / 2 + 0.002
			top, foot = base + UP * (k["height"] - 0.005), base + UP * 0.01
			corners = [top + inward * r + fore * mark["width"] / 2, top + inward * r - fore * mark["width"] / 2, foot + inward * r]
			pieces.append((corners, [(0, 1, 2) if side < 0 else (0, 2, 1)], [mark.get("paint", "red")]))
		# its arm rides on it, so sinks with it: the barricade's, flush and
		# unrigged, have none
		if arm and "arm" in sheave:
			pieces += sheave_arm(sheave, arm)
		node(name, hinge=base + UP * k["height"], mesh=merge(pieces))
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


def hull2d(points):
	# The convex hull of plan points [(u, v), ...], anticlockwise (Andrew's
	# monotone chain)
	points = sorted(set(points))

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


def hatches():
	# The small hatch covers' hardware (fittings.hatch): on each cover
	# (`covers`: its centre [x, z], `length` along its heading `angle`,
	# degrees from forward toward starboard, `width` across), barrel hinges
	# lying along its outboard edge at the shares `hinge.at` of its length,
	# and a handle along its inboard edge at `handle.at`, standing
	# `handle.height` on the deck; in `paint` (the node `hatches`)
	import numpy as np
	k = LAYOUT.get("fittings", {}).get("hatch")
	if not k:
		return
	deck = LAYOUT["deck"]["height"]
	hinge, handle, paint = k["hinge"], k["handle"], k.get("paint", "panel")
	pieces = []
	for c in k["covers"]:
		(cx, cz), a = c["centre"], math.radians(c["angle"])
		along, across = np.array([math.cos(a), math.sin(a)]), np.array([-math.sin(a), math.cos(a)])
		out = across if across[1] * cz > 0 else -across   # toward the ship's side
		centre = np.array([cx, cz])
		for share in hinge["at"]:
			middle = centre + along * c["length"] * (share - 0.5) + out * (c["width"] / 2 - hinge["diameter"] / 2)
			ends = [middle - along * hinge["length"] / 2, middle + along * hinge["length"] / 2]
			pieces.append(bar(*[[e[0], deck + hinge["diameter"] / 2, e[1]] for e in ends], hinge["diameter"], paint))
		middle = centre + along * c["length"] * (handle["at"] - 0.5) - out * (c["width"] / 2 - handle["inset"])
		ends = [middle - along * handle["length"] / 2, middle + along * handle["length"] / 2]
		pieces.append(bar(*[[e[0], deck + handle["height"], e[1]] for e in ends], handle["size"], paint))
	node("hatches", mesh=merge(pieces))


def sheave_arm(sheave, k):
	# The fitting forward of a rigged sheave (fittings.sheave.arm, each
	# sheave's arm): a steel bar, a wedge whose top falls from under its head
	# to a thin end on the deck, and its head beside the housing's outboard
	# side, a plate lying on the bar's root over a block, a pin through both.
	# Its line runs from the housing's centre, turned arm.angle outboard of
	# forward; the bar's middle lies arm.offset outboard of that line, from
	# k.root along it to its rounded end at arm.length, its top at the heights
	# arm.profile gives along it, its width k.width's; the plate's top at
	# arm.top. Positions in the fitting are [along, outboard] from the
	# housing's centre, heights above the deck. Returns pieces for merge()
	arm = sheave["arm"]
	(cx, cz), turn = sheave["centre"], math.radians(arm["angle"])
	offset, length = arm["offset"], arm["length"]
	side = -1 if sheave["name"].endswith("_port") else 1   # outboard: port is -z
	a = (math.cos(turn), side * math.sin(turn))
	o = (-math.sin(turn), side * math.cos(turn))
	deck = LAYOUT["deck"]["height"]
	paint = "arm" if "colour" in k else "dark"
	bottom = deck - STOWED / 2   # sunk a little: on the deck's top it fought it for the pixels

	def place(u, v):
		return [cx + u * a[0] + v * o[0], cz + u * a[1] + v * o[1]]

	def along(u, keys):
		# keys [[along, value], ...] read piecewise linearly, held at the ends
		if u <= keys[0][0]:
			return keys[0][1]
		for (u0, v0), (u1, v1) in zip(keys, keys[1:]):
			if u <= u1:
				return v0 + (v1 - v0) * (u - u0) / (u1 - u0)
		return keys[-1][1]

	# the head: a plate, its inboard edge an arc clear of the rim, then its
	# corners (moved by the arm's own head.shift, [along, outboard], where its
	# photo puts its head elsewhere), lying on the bar's root; under it a dark
	# block to the deck, set in from the plate's edges, all the photos show
	# there being shadow
	h = k["head"]
	du, dv = arm.get("head", {}).get("shift", [0.0, 0.0])
	steps = 6
	arc = [math.radians(h["to"] + (h["from"] - h["to"]) * i / steps) for i in range(steps + 1)]
	plan = [(h["inner"] * math.cos(b), h["inner"] * math.sin(b)) for b in arc] + [(u + du, v + dv) for u, v in h["outline"]]
	underside = deck + arm["top"] - h["thickness"]
	pieces = [slab([place(u, v) for u, v in plan], deck + arm["top"], underside, (paint,) * 3),
		slab([place(u, v) for u, v in inset(hull2d(plan), h["inset"])], underside, bottom, ("dark",) * 3)]
	# the pin, and its nut on top
	p = place(k["pin"]["at"][0] + du, k["pin"]["at"][1] + dv)
	rise = deck + arm["top"] + k["pin"]["height"]
	nut, tall = k["pin"]["nut"]
	pieces.append(tube([p[0], deck + arm["top"], p[1]], [p[0], rise, p[1]], k["pin"]["diameter"] / 2, paint, segments=12))
	pieces.append(tube([p[0], rise, p[1]], [p[0], rise + tall, p[1]], nut / 2, paint, segments=6))
	# the bar: a section at its root, at each of its profile's and its width's
	# knots and where its end's half disc begins, each its two top and two
	# bottom corners; then the half disc to a point
	nose = along(length, k["width"]) / 2
	knots = [u for u, _ in arm["profile"]] + [u for u, _ in k["width"]]
	stations = sorted({k["root"], *(u for u in knots if k["root"] < u < length - nose), length - nose})
	sections = [(u, along(u, k["width"]) / 2) for u in stations]
	sections += [(length - nose + nose * math.sin(math.radians(f)), nose * math.cos(math.radians(f))) for f in (30, 60)]
	vertices = []
	for u, half in sections:
		top = deck + along(u, arm["profile"])
		for v, y in ((offset - half, top), (offset + half, top), (offset - half, bottom), (offset + half, bottom)):
			x, z = place(u, v)
			vertices.append(at(x, y, z))
	x, z = place(length, offset)
	vertices += [at(x, deck + along(length, arm["profile"]), z), at(x, bottom, z)]
	n = len(sections)
	faces = [(0, 2, 3, 1)]   # the root's end
	for i in range(n - 1):
		t, s = 4 * i, 4 * (i + 1)
		faces += [(t, t + 1, s + 1, s), (t + 2, s + 2, s + 3, t + 3), (t, s, s + 2, t + 2), (t + 1, t + 3, s + 3, s + 1)]
	t, tip = 4 * (n - 1), 4 * n
	faces += [(t, t + 1, tip), (t + 2, tip + 1, t + 3), (t, tip, tip + 1, t + 2), (t + 1, t + 3, tip + 1, tip)]
	pieces.append((vertices, faces, [paint] * len(faces)))
	return pieces


def shape(p, frame=None):
	# One part of the layout's (layout.island.details, a weapon kind's parts, a
	# mast's fittings) as (vertices, faces, paints), its points in the ship's
	# frame, or carried by `frame` (a matrix on Blender's points) from a
	# kind's own: box {centre, size [x, y, z]}; rounded {centre, size, along
	# (x, y or z), radius}: a box its edges along that axis rounded; cylinder {base, axis and
	# length, or end; radius; segments}; prism {outline, bottom, top, upper:
	# its plan at the top, corner for corner, where its faces slope}; railing
	# {path, height, posts}: a top and a mid rail and posts; dish {centre,
	# diameter, facing}: a disc; dome {centre, radius, segments round it}: a sphere; lathe
	# {centre [x, z], profile, radome}: turned about an upright axis (lathe());
	# path {path, size, round, closed}: bars along a line, round ones as
	# cylinders; ladder {bottom, top, along [x, z], width, rungs}: two stiles
	# and rungs; stair {bottom, top, width, railing}: a girder, treads and a
	# railing either side; plate {corners, outward, thickness}: a slab on a
	# face; ring {centre, facing, outer, inner, thickness, sweep}: a flat ring
	# standing out along `facing` (a life ring, a chock's rim; a radius
	# [across, along] for an oval), or with
	# `sweep` [from, to] only that arc of it (a deck circle the deck's edge
	# cuts); turned {centre, axis, profile, closed}: turned about any line
	# (spun()); tyre: a wheel (tyre()); sweep {path, radius}: a round bar
	# along a line (sweep()); rope {path, diameter}: a rope round its sheaves
	# (reeved()); extrusion {plane, profile, along}: a polygon in one of the
	# frame's planes drawn along the third axis. The vehicles' kinds keep the
	# smooth marks the last five give their faces
	paint = p.get("paint", "rail" if p["kind"] in ("railing", "ladder") else "grey")
	kind = p["kind"]
	if kind == "box":
		# cuboid() winds it outward: drawn round the ship's plan here, as
		# Blender's turns it, it came out inside out, which tidy() undid only
		# for a box standing alone (a balcony welded to its struts stayed so)
		(cx, cy, cz), (sx, sy, sz) = p["centre"], p["size"]
		origin = at(0, 0, 0)
		piece = cuboid(at(cx, cy, cz), (at(1, 0, 0) - origin, at(0, 1, 0) - origin, at(0, 0, 1) - origin), (sx, sy, sz), paint)
	elif kind == "rounded":
		# a box whose four edges along `along` (x, y or z) are rounded off at
		# `radius`: its section across that axis rounded, drawn the box's
		# length along it
		c, s = Vector(p["centre"]), Vector(p["size"])
		k = "xyz".index(p["along"])
		i, j = [n for n in range(3) if n != k]
		u, w, a = Vector([0, 0, 0]), Vector([0, 0, 0]), Vector([0, 0, 0])
		u[i], w[j], a[k] = s[i] / 2, s[j] / 2, s[k] / 2
		foot = c - a
		section = rounded([list(foot - u - w), list(foot + u - w), list(foot + u + w), list(foot - u + w)], p["radius"], p.get("steps", 3))
		piece = sheet(section, list(a), s[k], paint)
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
			# one piece round its corners (swept()), closed where it ends where it began
			looped = p.get("closed") or math.dist(p["path"][0], p["path"][-1]) < 1e-6
			piece = swept(p["path"], size, paint, closed=looped and len(p["path"]) > 2)
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
		piece = prism(p["outline"], p["bottom"], p["top"], upper=p.get("upper"), paint=paint)
	elif kind == "ring":
		piece = ring(p["centre"], p["facing"], p["outer"], p["inner"], p.get("thickness", 0.1), p.get("segments", 16), paint, p.get("sweep"))
	elif kind == "dome":
		c, r = at(*p["centre"]), p["radius"]
		n = p.get("segments", 32)
		vertices, faces = primitive(lambda bm: bmesh.ops.create_uvsphere(bm, u_segments=n, v_segments=n // 2, radius=r, matrix=Matrix.Translation(c)))
		piece = (vertices, faces, [paint] * len(faces))
	elif kind == "railing":
		# rails along the path, posts evenly along each straight run from
		# corner to corner, or, where the path is `bent` (one rail bent round a
		# rounded corner's many short runs), evenly along the whole of it
		height, rails, path = p["height"], [], p["path"]
		# each rail one bar along the whole path, mitred (swept()); the
		# posts from a centimetre under the path to the top rail's underside
		for rise, size in ((height, 0.05), (height / 2, 0.04)):
			rails.append(swept([[v[0], v[1] + rise, v[2]] for v in path], size, paint))
		for run in ([path] if p.get("bent") else [[a, b] for a, b in zip(path, path[1:])]):
			for q, _ in along_line([[v[0], v[2]] for v in run], p.get("posts", 1.5)):
				rails.append(bar([q[0], level(run, q) - 0.01, q[1]], [q[0], level(run, q) + height - 0.025, q[1]], POST, paint))
		piece = merge(rails)
	elif kind == "turned":
		piece = spun(p["centre"], p["axis"], p["profile"], p.get("segments", 24), paint, p.get("closed", False))
	elif kind == "tyre":
		piece = tyre(p, p.get("paint", "dark"))
	elif kind == "sweep":
		piece = sweep(p["path"], p["radius"], p.get("segments", 8), paint)
	elif kind == "rope":
		piece = sweep(reeved(p["path"]), p["diameter"] / 2, p.get("segments", 6), p.get("paint", "dark"))
	elif kind == "extrusion":
		# a polygon in one of the frame's planes ("xy": profile [[x, y], ...]),
		# drawn from along[0] to along[1] on the third axis
		i, j = "xyz".index(p["plane"][0]), "xyz".index(p["plane"][1])
		k = 3 - i - j
		polygon = []
		for q in p["profile"]:
			v = [0.0, 0.0, 0.0]
			v[i], v[j], v[k] = q[0], q[1], p["along"][0]
			polygon.append(v)
		outward = [0.0, 0.0, 0.0]
		outward[k] = 1.0
		piece = sheet(polygon, outward, p["along"][1] - p["along"][0], paint)
	else:
		raise ValueError(f"part {p.get('name')}: unknown kind {kind}")
	if frame is not None:
		piece = ([frame @ v for v in piece[0]],) + tuple(piece[1:])
	return piece


def ring(centre, facing, outer, inner, thickness, segments, paint, sweep=None):
	# A flat ring round `centre` (ship frame) in the plane square to `facing`,
	# from `inner` to `outer` radius, standing `thickness` out along `facing`;
	# either radius may be [across, along] for an oval: across the level line
	# in its plane, and along the line square to that (up a wall's face). With
	# `sweep` [from, to] (degrees in plan, from forward toward starboard, for a
	# ring facing up) only that arc, its ends closed
	n = Vector(facing).normalized()
	c = Vector(centre)
	spread = lambda radius: (radius, radius) if isinstance(radius, (int, float)) else tuple(radius)
	if sweep is None:
		u = n.cross(Vector((0, 1, 0)) if abs(n.y) < 0.9 else Vector((1, 0, 0))).normalized()
		w = n.cross(u)
		angles = [2 * math.pi * k / segments for k in range(segments)]
		loop = lambda radius: [u * math.cos(a) * spread(radius)[0] + w * math.sin(a) * spread(radius)[1] for a in angles]
	else:
		assert all(isinstance(r, (int, float)) for r in (outer, inner)), "a swept ring is round"
		def direction(degrees):
			d = Vector((math.cos(math.radians(degrees)), 0, math.sin(math.radians(degrees))))
			return (d - n * d.dot(n)).normalized()
		directions = [direction(sweep[0] + (sweep[1] - sweep[0]) * k / segments) for k in range(segments + 1)]
		loop = lambda radius: [d * radius for d in directions]
	count = len(loop(outer))
	points = [at(*(c + n * depth + d)) for depth in (0.0, thickness) for radius in (outer, inner) for d in loop(radius)]
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


def clipped(polygon, low, high):
	# A convex polygon [[x, y], ...] cut to low <= x <= high
	for keep, bound in ((lambda x: x >= low, low), (lambda x: x <= high, high)):
		out = []
		for k, p in enumerate(polygon):
			q = polygon[k - 1]
			if keep(p[0]) != keep(q[0]):
				t = (bound - q[0]) / (p[0] - q[0])
				out.append([bound, q[1] + t * (p[1] - q[1])])
			if keep(p[0]):
				out.append(list(p))
		polygon = out
	return polygon


def rails(xs, z, side, r, top):
	# A well's two rails (well.rail), each a channel on its wall (the plane z,
	# facing `side`) centred on its x: `width` wide, from its foot (`foot`, a
	# bar 0.15 deep across its bottom) up to `top`, the platform's underside
	# at the deck; a flange `flange` wide at each side standing `depth` out,
	# a web `web` wide down its middle standing 0.1 less, and the slots
	# between them closed at the wall, all the plating's grey (weathered
	# with the hull, its occlusion the slots' shade)
	outward = (at(0, 0, side) - at(0, 0, 0)).normalized()
	along = at(1, 0, 0) - at(0, 0, 0)
	width, depth, flange, web, foot = r["width"], r["depth"], r["flange"], r["web"], r["foot"]
	slot = width / 2 - flange - web / 2
	pieces = []
	for x in xs:
		pieces.append(box(at(x, foot - 0.15, z + side * depth / 2), along, outward, width, depth, 0.15))
		pieces.append(box(at(x, foot, z + side * (depth - 0.1) / 2), along, outward, web, depth - 0.1, top - foot))
		for s in (-1, 1):
			pieces.append(box(at(x + s * (width - flange) / 2, foot, z + side * depth / 2), along, outward, flange, depth, top - foot))
			pieces.append(box(at(x + s * (web + slot) / 2, foot, z + side * 0.01), along, outward, slot, 0.02, top - foot))
	return pieces


def sill(s, x0, x1, top, z, side):
	# What stands on a hangar doorway's wall under its sill (well.opening.sill):
	# a `curb` from `bottom` up to the sill standing `out` from the wall along
	# the doorway's width, `posts` square `width` standing `height` on it at
	# each `x`, and a `comb`, its teeth's dark gaps `tooth` wide at `pitch`
	# from x[0] to x[1], `depth` down from the sill (`top`)
	outward = (at(0, 0, side) - at(0, 0, 0)).normalized()
	along = at(1, 0, 0) - at(0, 0, 0)
	pieces = []
	# the curb's and the comb's tops RESTING under the sill's: the platform,
	# lowered, comes to rest over them at the sill's height, and level with
	# it they fought it for the pixels
	curb = s.get("curb")
	if curb:
		pieces.append(box(at((x0 + x1) / 2, curb["bottom"], z + side * curb["out"] / 2), along, outward, x1 - x0, curb["out"], top - RESTING - curb["bottom"]))
	posts = s.get("posts")
	if posts:
		out = curb["out"] / 2 if curb else posts["width"] / 2
		for x in posts["x"]:
			pieces.append(box(at(x, top, z + side * out), along, outward, posts["width"], posts["width"], posts["height"]))
	comb = s.get("comb")
	if comb:
		(a, b), pitch, tooth = comb["x"], comb["pitch"], comb["tooth"]
		n = int((b - a - tooth) / pitch + 1e-9) + 1
		start = (a + b) / 2 - (n - 1) * pitch / 2
		for k in range(n):
			# on the curb's face where there is one (inside it they lay in its top's plane)
			front = curb["out"] if curb else 0.0
			pieces.append(box(at(start + k * pitch, top - comb["depth"], z + side * (front + 0.01)), along, outward, tooth, 0.02, comb["depth"] - RESTING, "dark"))
	return pieces


def band(outer, inner, facing, thickness, paint):
	# A flat ring between two loops on a face (ship frame, as many points
	# each, in step round it), standing `thickness` out along `facing`
	n = len(outer)
	assert len(inner) == n, "a ring's loops in step"
	out = (at(*facing) - at(0, 0, 0)).normalized() * thickness
	foot = [at(*q) for q in outer] + [at(*q) for q in inner]
	vertices = foot + [v + out for v in foot]
	faces = []
	for k in range(n):
		m = (k + 1) % n
		faces += [(k, m, n + m, n + k), (2 * n + k, 3 * n + k, 3 * n + m, 2 * n + m), (k, 2 * n + k, 2 * n + m, m), (n + k, n + m, 3 * n + m, 3 * n + k)]
	return outward((vertices, faces, [paint] * len(faces)))


def sheet(polygon, outward, thickness, paint):
	# A polygon (ship frame) made a sheet `thickness` thick along `outward`
	n = len(polygon)
	out = Vector(outward).normalized() * thickness
	# round anticlockwise seen from outside, so every face winds outward
	normal = sum(((Vector(a) - Vector(polygon[0])).cross(Vector(b) - Vector(polygon[0])) for a, b in zip(polygon[1:], polygon[2:])), Vector())
	if normal.dot(out) < 0:
		polygon = polygon[::-1]
	vertices = [at(*q) for q in polygon] + [at(*(Vector(q) + out)) for q in polygon]
	faces = [tuple(range(n - 1, -1, -1)), tuple(range(n, 2 * n))] + [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
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
			# its hinge's housing at the deck's edge, which stays as the whip
			# lowers: `sy` deep under the deck's height, and standing over it as
			# far as a stowed part sits under the deck (STOWED) or its size needs
			# for the depth buffer to keep its top apart from whatever it stands
			# on at that height (depth.py)
			(x, z), (sx, sy, sz) = a["base"], a["mount"]
			proud = max(STOWED, 1.1 * needed(min(sx, sz)))
			mounts.append(shape({"kind": "box", "centre": [x, top + (proud - sy) / 2, z], "size": [sx, sy + proud, sz]}))
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
		# a prism whose `tips` name its ends' marks (the yardarms'): each end's
		# middle, half way up
		xs = [x for x, _ in p["outline"]]
		for side, mark in p.get("tips", {}).items():
			z = (min if side == "port" else max)(z for _, z in p["outline"])
			MARKS[mark] = (at((min(xs) + max(xs)) / 2, (p["bottom"] + p["top"]) / 2, z), "island")
	# a radome the photos mark (its `mark`) at the centre of its top's
	# outline, its top less its widest radius; a detail at its centre
	for d in i.get("domes", []):
		if "mark" in d:
			top = max(y for y, _ in d["profile"])
			MARKS[d["mark"]] = (at(d["centre"][0], top - max(r for _, r in d["profile"]), d["centre"][1]), "island")
	for d in i.get("details", []):
		if "mark" in d:
			MARKS[d["mark"]] = (at(*d["centre"]), "island_details")


def joined(name, other):
	# Node `other`'s mesh joined into node `name`'s, `other` gone
	bpy.ops.object.select_all(action="DESELECT")
	NODES[other].select_set(True)
	NODES[name].select_set(True)
	bpy.context.view_layer.objects.active = NODES[name]
	bpy.ops.object.join()
	del NODES[other], HINGES[other]


def pierce(obj, holes):
	# Openings cut into a node's flat faces and the recesses behind them, made
	# by hand so nothing else of the mesh changes (Blender's exact boolean
	# rebuilds faces far from the cut, and not the same way from run to run).
	# Each hole: `outline`, a polygon (ship frame) on one of the node's planes,
	# `normal` out of that plane; its faces round it lying in the plane are
	# taken out and filled again round the hole, and from its edge walls run
	# `depth` in to a back. The walls take `paint`, a wall along the outline's
	# lowest height `floor`, the back `back`. With `room` {outline, depth} a
	# larger recess opens behind the first's back: its front wall round the
	# first's inner end, its walls as the first's, its floor the first's or
	# the room's own `floor`, its back `back` (or its `pieces`, below). Its region the plane's faces
	# within `margin` (0.5 m) of it. The walls run in square to the
	# plane, or straight in against `out` where it is given (a recess cut
	# level into a sloping face: out [0, 0, 1] on the starboard side, so its
	# floor is flat), `depth` or as far as |z| `level` (an upright back in a
	# sloping face); a `back` of None leaves it open. Several openings in one
	# plane are one hole with `rings`, each ring a hole's own outline, depth,
	# paints, out and room: cut one at a time, a later one's region would
	# take in the faces filled round an earlier one and pinch at its edge;
	# each ring's region found in its own plane (`normal`), its walls square
	# to that plane
	import bmesh
	from mathutils.geometry import tessellate_polygon
	names = [m.name for m in obj.data.materials]
	def slot(paint):
		if paint not in names:
			obj.data.materials.append(material(paint))
			names.append(paint)
		return names.index(paint)
	bm = bmesh.new()
	bm.from_mesh(obj.data)
	for hole in holes:
		bm.normal_update()   # the faces an earlier hole filled
		n = (at(*hole["normal"]) - at(0, 0, 0)).normalized()
		rings = hole.get("rings") or [hole]
		outlines = [[at(*q) for q in r["outline"]] for r in rings]
		every = [p for ring in outlines for p in ring]
		origin = sum(every, Vector()) / len(every)
		u = n.cross(Vector((0, 0, 1)) if abs(n.z) < 0.9 else Vector((1, 0, 0))).normalized()
		w = n.cross(u)
		flat = lambda p: ((p - origin).dot(u), (p - origin).dot(w))
		# each wound counter-clockwise seen from outside
		for k, ring in enumerate(outlines):
			pts = [flat(p) for p in ring]
			if sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(pts, pts[1:] + pts[:1])) < 0:
				outlines[k] = ring[::-1]
		pts = [flat(p) for ring in outlines for p in ring]
		# the faces in the plane round each ring (in a ring's own plane where
		# it gives one: several rings may lie on strips of plating a few
		# degrees apart)
		region, seen = [], set()
		for r, ring in zip(rings, outlines):
			rn = (at(*r["normal"]) - at(0, 0, 0)).normalized() if r is not hole and "normal" in r else n
			ro = sum(ring, Vector()) / len(ring)
			ru = rn.cross(Vector((0, 0, 1)) if abs(rn.z) < 0.9 else Vector((1, 0, 0))).normalized()
			rw = rn.cross(ru)
			rflat = lambda p: ((p - ro).dot(ru), (p - ro).dot(rw))
			rpts = [rflat(p) for p in ring]
			margin = r.get("margin", 0.5)
			low = (min(p[0] for p in rpts) - margin, min(p[1] for p in rpts) - margin)
			high = (max(p[0] for p in rpts) + margin, max(p[1] for p in rpts) + margin)
			for f in bm.faces:
				# within 15 cm of it, facing as it does within 18 degrees (a
				# face drawn on a curve, as a bow face on its stem's, strays
				# from its plane by a few centimetres), or as far as a ring's
				# `within` allows (a long face the bow's shoulders twist)
				if f not in seen and all(abs((v.co - ro).dot(rn)) < r.get("within", 0.15) for v in f.verts) and f.normal.dot(rn) > 0.95:
					c = [rflat(v.co) for v in f.verts]
					if min(q[0] for q in c) < high[0] and max(q[0] for q in c) > low[0] and min(q[1] for q in c) < high[1] and max(q[1] for q in c) > low[1]:
						region.append(f)
						seen.add(f)
		assert region, f"no flat face round hole {hole.get('name')}"
		paint = region[0].material_index
		chosen = set(region)
		# its edge, as the faces wind it, chained into loops
		after = {}
		for f in region:
			for loop in f.loops:
				other = [g for g in loop.edge.link_faces if g is not f]
				if not other or other[0] not in chosen:
					after[loop.vert] = loop.link_loop_next.vert
		loops = []
		while after:
			first = min(after, key=lambda v: tuple(v.co))
			chain, v = [first], after.pop(first)
			while v is not first:
				chain.append(v)
				assert v in after, f"hole {hole.get('name')}: its region's edge touches itself at a corner"
				v = after.pop(v)
			loops.append(chain)
		# the hole inside the region, clear of its edge
		edge = [flat(v.co) for chain in loops for v in chain]
		reach = [(min(q[k] for q in edge), max(q[k] for q in edge)) for k in (0, 1)]
		assert all(lo + 0.01 < q[k] < hi - 0.01 for q in pts for k, (lo, hi) in enumerate(reach)), \
			f"hole {hole.get('name')} reaches its region's edge: hole {[(round(min(q[k] for q in pts), 2), round(max(q[k] for q in pts), 2)) for k in (0, 1)]}, region {[(round(a, 2), round(b, 2)) for a, b in reach]}, {len(region)} faces, {len(loops)} loops"
		for f in region:
			bm.faces.remove(f)
		openings = [[bm.verts.new(p) for p in ring] for ring in outlines]
		def fill(outer_chains, inner, facing, index, inline=False):
			# the plane between the outer loops and the inner polygons, facing
			# `facing`. With `inline`, a vertex in line with its neighbours
			# (where a room's side is cornered for a door's leaf) is left out
			# of the tessellation, which would lay a triangle of no area along
			# the line and could turn it either way, and put back by fanning
			# the triangle on whose side it lies from that triangle's middle.
			# Each outline is filled on its own with the loops inside it: the
			# region's faces may make several outlines (a sliver of plating a
			# few degrees off the plane, left out of it, between two), and
			# given them all at once the tessellation laid triangles across the
			# gap between them and over the hole. A loop inside an outline
			# (the rim of an opening cut before) is a hole in it, one inside
			# that an outline again
			chains = [list(chain) for chain in outer_chains]
			plans = [[flat(v.co) for v in chain] for chain in chains]

			def contains(plan, q):
				hit = False
				for (ax, ay), (bx, by) in zip(plan, plan[1:] + plan[:1]):
					if (ay > q[1]) != (by > q[1]) and q[0] < ax + (bx - ax) * (q[1] - ay) / (by - ay):
						hit = not hit
				return hit

			def probe(loop):
				# a point on the loop's first edge, clear of its corners
				a, b = flat(loop[0].co), flat(loop[1].co)
				return ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
			around = [[j for j in range(len(chains)) if j != i and contains(plans[j], probe(chains[i]))] for i in range(len(chains))]
			groups = {i: [chains[i]] for i in range(len(chains)) if len(around[i]) % 2 == 0}
			for i in range(len(chains)):
				if len(around[i]) % 2:
					parent = max(around[i], key=lambda j: len(around[j]))
					groups[parent].append(chains[i])
			for ring in inner:
				holders = [j for j in range(len(chains)) if contains(plans[j], probe(ring))]
				assert len(holders) % 2 == 1, f"hole {hole.get('name')}: it crosses the edge of the plane's faces round it (a crease, or a face out of its plane): move it onto one face"
				groups[max(holders, key=lambda j: len(around[j]))].append(list(ring))
			for loops in groups.values():
				fill_loops(loops, facing, index, inline)

		def fill_loops(loops, facing, index, inline):
			# one outline and the holes in it (fill())
			def straight(loop, k):
				a, b, c = flat(loop[k - 1].co), flat(loop[k].co), flat(loop[(k + 1) % len(loop)].co)
				return inline and abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) < 1e-9
			corners, between = [], {}
			for loop in loops:
				kept = [k for k in range(len(loop)) if not straight(loop, k)]
				corners.append([loop[k] for k in kept])
				for m, k in enumerate(kept):
					end = kept[(m + 1) % len(kept)]
					run = [loop[i % len(loop)] for i in range(k + 1, end + (len(loop) if end <= k else 0))]
					if run:
						between[(loop[k], loop[end])] = run
			everything = [v for loop in corners for v in loop]
			lines = [[(*flat(v.co), 0.0) for v in loop] for loop in corners]
			for tri in tessellate_polygon(lines):
				vs = [everything[k] for k in tri]
				if (vs[1].co - vs[0].co).cross(vs[2].co - vs[1].co).dot(facing) < 0:
					vs = vs[::-1]
				ring = []
				for a, b in zip(vs, vs[1:] + vs[:1]):
					ring.append(a)
					ring += between.get((a, b), [])[:] or between.get((b, a), [])[::-1]
				if len(ring) == 3:
					bm.faces.new(vs).material_index = index
					continue
				middle = bm.verts.new(sum((v.co for v in vs), Vector()) / 3)
				for a, b in zip(ring, ring[1:] + ring[:1]):
					bm.faces.new((a, b, middle)).material_index = index
		fill(loops, openings, n, paint)
		def walls(front, back_ring, floor_index, wall_index):
			# from one loop to another behind it, facing into the recess; the
			# floor along its lowest height (up, not the plane's w, which points
			# down on an upright face)
			bottom = min(v.co.z for v in front)
			middle = sum((v.co for v in front), Vector()) / len(front)
			for k in range(len(front)):
				a, b = front[k], front[(k + 1) % len(front)]
				quad = [a, b, back_ring[(k + 1) % len(front)], back_ring[k]]
				inward = middle - (a.co + b.co) / 2
				inward -= n * inward.dot(n)
				if (quad[1].co - quad[0].co).cross(quad[2].co - quad[1].co).dot(inward) < 0:
					quad = quad[::-1]
				level = abs(a.co.z - bottom) < 1e-6 and abs(b.co.z - bottom) < 1e-6
				bm.faces.new(quad).material_index = floor_index if level else wall_index
		for r, opening in zip(rings, openings):
			d = (at(*r["out"]) - at(0, 0, 0)).normalized() if "out" in r else ((at(*r["normal"]) - at(0, 0, 0)).normalized() if r is not hole and "normal" in r else n)
			if "level" in r:
				# in along d until the ship frame's |z| is `level`
				inner = [bm.verts.new(v.co - d * (abs(v.co.y) - r["level"]) / abs(d.y)) for v in opening]
			else:
				inner = [bm.verts.new(v.co - d * r["depth"]) for v in opening]
			walls(opening, inner, slot(r.get("floor", r.get("paint", "grey"))), slot(r.get("paint", "grey")))
			room = r.get("room")
			if room:
				# wound as the hole is, counter-clockwise seen from outside
				front = [at(*q) - d * r["depth"] for q in room["outline"]]
				corners = [flat(p) for p in front]
				if sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(corners, corners[1:] + corners[:1])) < 0:
					front = front[::-1]
				front = [bm.verts.new(p) for p in front]
				wall_paint = r.get("paint", "grey")
				fill([front], [inner], -n, slot(wall_paint), inline=True)
				behind = [bm.verts.new(v.co - d * room["depth"]) for v in front]
				walls(front, behind, slot(room.get("floor", r.get("floor", wall_paint))), slot(wall_paint))
				last = behind
				if room.get("pieces"):
					# the room's back in pieces, each outline on the hole's
					# plane with its corners the room outline's own: a panel
					# in its `paint` (a shut door's leaf), or a pocket on
					# behind it `pocket` deep, its walls and back in its
					# `paint` (the dark through the door's seam or past its
					# ends). Nothing stands behind a panel, for the depth buffer
					# to draw through it, and the room stays closed
					for piece in room["pieces"]:
						mouth = []
						for q in piece["outline"]:
							p = at(*q) - d * (r["depth"] + room["depth"])
							v = min(behind, key=lambda v: (v.co - p).length)
							assert (v.co - p).length < 1e-4, f"hole {hole.get('name')}: a piece's corner {q} is not a corner of its room"
							mouth.append(v)
						index = slot(piece.get("paint", "dark"))
						if "pocket" in piece:
							deep = [bm.verts.new(v.co - d * piece["pocket"]) for v in mouth]
							walls(mouth, deep, index, index)
							mouth = deep
						face = bm.faces.new(mouth)
						face.normal_update()
						if face.normal.dot(d) < 0:
							face.normal_flip()
						face.material_index = index
					continue
			else:
				last = inner
			if r.get("back", "dark") is None:
				continue   # open: something else of the model stands behind it
			face = bm.faces.new(last)
			face.normal_update()   # a new face has none until asked
			if face.normal.dot(d) < 0:
				face.normal_flip()
			face.material_index = slot(r.get("back", "dark"))
	bm.normal_update()
	bm.to_mesh(obj.data)
	bm.free()


def notch(obj, cuts):
	# Bays cut up through a side's plating to the deck edge's overhang
	# (hull.notches, openings()): over x [aft, forward] on `side` (1
	# starboard, -1 port) the plating from height `from` up to the foot of
	# the deck edge's upright face (the flare, a crease's bend and the
	# overhang running out from it to the foot) is taken out, and a bay built
	# behind: its floor level at `from`, its ends square across the ship,
	# its back upright at |z| `level`, its ceiling level with the foot out to
	# the deck edge's face. The floor, ends and ceiling take `paint`, the
	# back `back`. Cut by hand, as pierce(), so nothing else of the mesh
	# changes; the hull's node stands at the origin
	import bmesh
	names = [m.name for m in obj.data.materials]
	def slot(paint):
		if paint not in names:
			obj.data.materials.append(material(paint))
			names.append(paint)
		return names.index(paint)
	bm = bmesh.new()
	bm.from_mesh(obj.data)
	for c in cuts:
		side, (x0, x1), low, level = c["side"], c["x"], c["from"], c["level"]
		# Blender's axes: x forward, y port (the ship's -z), z up
		outboard = lambda co: -side * co.y
		def plating(f, reach):
			# a face on the side reaching outboard of the back and above the
			# floor, and within reach of the cut along the ship: by its
			# corners, not its middle (the flare's faces run from the knuckle
			# to the bend, the overhang's far along the ship)
			xs = [v.co.x for v in f.verts]
			return max(outboard(v.co) for v in f.verts) > level + 1e-3 and max(v.co.z for v in f.verts) > low + 1e-4 \
				and min(xs) < x1 + reach and max(xs) > x0 - reach
		def between(f):
			return plating(f, 0) and x0 < f.calc_center_median().x < x1
		# the plating split at its ends, then between them at its floor
		def split(faces, co, no):
			geom = list({e for f in faces for e in f.edges}) + list({v for f in faces for v in f.verts}) + faces
			bmesh.ops.bisect_plane(bm, geom=geom, dist=1e-5, plane_co=co, plane_no=no)
		for x in (x0, x1):
			split([f for f in bm.faces if plating(f, 1.0)], (x, 0, 0), (1, 0, 0))
		split([f for f in bm.faces if between(f)], (0, 0, low), (0, 0, 1))
		# the deck edge's upright face over it, its foot the bay's ceiling
		# (not quite level); everything of the plating under it goes
		bm.normal_update()
		upright = {f for f in bm.faces if between(f) and -side * f.normal.y > 0.98 and min(v.co.z for v in f.verts) > low + 0.5}
		assert upright, f"notch {c['name']}: no deck edge over it"
		feet = []
		for f in upright:
			heights = [v.co.z for v in f.verts]
			feet += [z for z in heights if z < (min(heights) + max(heights)) / 2]
		foot, top = min(feet), max(feet)
		gone = [f for f in bm.faces if between(f) and f not in upright and low < f.calc_center_median().z < top]
		assert gone, f"notch {c['name']}: no plating in it"
		edges = {e for f in gone for e in f.edges}
		for f in gone:
			bm.faces.remove(f)
		# the edges left with no face, and their corners with no edge
		for e in [e for e in edges if e.is_valid and not e.link_faces]:
			bm.edges.remove(e)
		for v in [v for v in bm.verts if not v.link_edges]:
			bm.verts.remove(v)
		# the cut's edge chained into one loop
		inside = lambda v: x0 - 1e-4 <= v.co.x <= x1 + 1e-4 and low - 1e-4 <= v.co.z <= top + 1e-4 and outboard(v.co) > level - 0.01
		rim = [e for e in bm.edges if len(e.link_faces) == 1 and all(inside(v) for v in e.verts)]
		ends = {}
		for e in rim:
			for v in e.verts:
				ends.setdefault(v, []).append(e)
		assert rim and all(len(es) == 2 for es in ends.values()), \
			f"notch {c['name']}: its edge is not one loop: {sorted((round(v.co.x, 3), round(v.co.z, 3), round(outboard(v.co), 3), len(es)) for v, es in ends.items() if len(es) != 2)}"
		first = min(ends, key=lambda v: (v.co.x, v.co.z))
		loop, previous, v = [first], None, first
		while True:
			e = next(e for e in ends[v] if e is not previous)
			v, previous = e.other_vert(v), e
			if v is first:
				break
			loop.append(v)
		assert len(loop) == len(ends), f"notch {c['name']}: its edge is more than one loop"
		# the bay: from each point of the edge straight in to the back, each
		# face turned to face into it
		back = [bm.verts.new((v.co.x, -side * level, v.co.z)) for v in loop]
		middle = Vector(((x0 + x1) / 2, -side * (level + 0.5), (low + foot) / 2))
		walls, floor = slot(c.get("paint", "grey")), slot(c.get("floor", c.get("paint", "grey")))
		for k in range(len(loop)):
			a, b = loop[k], loop[(k + 1) % len(loop)]
			quad = [a, b, back[(k + 1) % len(loop)], back[k]]
			normal = (quad[1].co - quad[0].co).cross(quad[2].co - quad[1].co)
			if normal.dot(middle - (a.co + b.co) / 2) < 0:
				quad = quad[::-1]
			level_floor = abs(a.co.z - low) < 1e-4 and abs(b.co.z - low) < 1e-4
			bm.faces.new(quad).material_index = floor if level_floor else walls
		face = bm.faces.new(back)
		face.normal_update()
		if -side * face.normal.y < 0:
			face.normal_flip()
		face.material_index = slot(c.get("back", "dark"))
	bm.normal_update()
	bm.to_mesh(obj.data)
	bm.free()


def lip(centre, facing, outer, inner, height, paint, segments=32, steps=10, barrel=0.25):
	# A cast rim round an opening in a face (a fairlead's or a chock's): its
	# section a half ellipse from `inner` out to `outer` radius (either may be
	# [across, along], as ring()'s), standing `height` out of the face at its
	# middle, rolling over into a barrel `barrel` deep inside the opening at
	# 0.98 of the inner radius, and its outer edge running 5 cm into the
	# face. An open surface, wound outward
	n = Vector(facing).normalized()
	c = Vector(centre)
	u = n.cross(Vector((0, 1, 0)) if abs(n.y) < 0.9 else Vector((1, 0, 0))).normalized()
	w = n.cross(u)
	spread = lambda radius: (radius, radius) if isinstance(radius, (int, float)) else tuple(radius)
	(ia, ib), (oa, ob) = spread(inner), spread(outer)
	# the section, inside out: (share of the way from inner to outer radius,
	# height); the barrel's top a centimetre into the opening, so the rim
	# turns down into it at once: a flat ring there lay in the face, which
	# the face's plating overlaps wherever the opening it was cut with runs
	# inside the circle, for the depth buffer to draw through each other
	section = [(-0.02, -barrel), (-0.02, -0.01)]
	section += [((1 - math.cos(math.pi * k / steps)) / 2, height * math.sin(math.pi * k / steps)) for k in range(steps + 1)]
	section += [(1.0, -0.05)]
	vertices = []
	for k in range(segments):
		a = 2 * math.pi * k / segments
		for share, rise in section:
			vertices.append(at(*(c + n * rise + u * math.cos(a) * (ia + (oa - ia) * share) + w * math.sin(a) * (ib + (ob - ib) * share))))
	m = len(section)
	faces = []
	for k in range(segments):
		j = (k + 1) % segments
		for i in range(m - 1):
			faces.append((k * m + i, k * m + i + 1, j * m + i + 1, j * m + i))
	# wound so the crest faces out along `facing`
	crest = steps // 2 + 2
	f = faces[crest]
	normal = (vertices[f[1]] - vertices[f[0]]).cross(vertices[f[2]] - vertices[f[1]])
	if normal.dot(at(*n) - at(0, 0, 0)) < 0:
		faces = [tuple(reversed(f)) for f in faces]
	return vertices, faces, [paint] * len(faces)


def reveal(cab, ax, az, bx, bz, nx, nz):
	# How deep a glazed opening's reveal is: how far in from the middle of its
	# line (from a to b, its outward normal n) the room's wall stands, the
	# first edge of the room's outline a ray straight in meets; at least 0.8
	mx, mz = (ax + bx) / 2, (az + bz) / 2
	dx, dz = -nx, -nz
	cross = lambda ux, uz, vx, vz: ux * vz - uz * vx
	best = None
	room = cab["room"]
	for (px, pz), (qx, qz) in zip(room, room[1:] + room[:1]):
		ex, ez = qx - px, qz - pz
		det = cross(dx, dz, ex, ez)
		if abs(det) < 1e-12:
			continue
		wx, wz = px - mx, pz - mz
		t, u = cross(wx, wz, ex, ez) / det, cross(wx, wz, dx, dz) / det
		if t > 0 and -1e-9 <= u <= 1 + 1e-9:
			best = t if best is None else min(best, t)
	return max(0.8, best if best is not None else 0.8)


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
			# in through the wall and on into the room: cut on its own, one
			# ending in the room's wall left that wall standing in the opening
			inward = reveal(cab, ax, az, bx, bz, nx, nz) + 0.2
			quad = [[ax - nx * inward, az - nz * inward], [bx - nx * inward, bz - nz * inward], [bx + nx * reach, bz + nz * reach], [ax + nx * reach, az + nz * reach]]
			cutters.append(prism(quad, sill, head))
		# one cut at a time, the room first: the cutters overlap (each
		# opening's reaches into the room, and its neighbours' at a corner),
		# and cut as one the exact boolean kept each one's faces inside the
		# others, the room's wall standing across every opening and the
		# openings' inner ends inside the room
		for k, piece in enumerate(cutters):
			cutter = node("cutter", mesh=piece)
			cut = obj.modifiers.new(f"glazed {k}", "BOOLEAN")
			cut.operation, cut.solver, cut.object = "DIFFERENCE", "EXACT", cutter
			cut.use_self, cut.material_mode = True, "TRANSFER"
			bpy.context.view_layer.objects.active = obj
			bpy.ops.object.modifier_apply(modifier=cut.name)
			bpy.data.objects.remove(cutter, do_unlink=True)
			del NODES["cutter"], HINGES["cutter"]
		for ax, az, bx, bz, length, dx, dz, nx, nz, lean, conduit, wipers in openings:
			foot = lambda s: [ax + dx * s, sill, az + dz * s]
			top = lambda s: [ax + dx * s + nx * lean, head, az + dz * s + nz * lean]
			# the pane one sheet of glass, its paint drawn on both sides: a
			# slab's two faces see-through and a little apart would be drawn
			# through each other
			glass = [at(*q) for q in (foot(0), foot(length), top(length), top(0))]
			if (glass[1] - glass[0]).cross(glass[2] - glass[1]).dot(at(nx, 0, nz) - at(0, 0, 0)) < 0:
				glass = glass[::-1]
			out.append((glass, [(0, 1, 2, 3)], ["pane"]))
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
	# the cuts leave faces on the same vertices where they meet the block's
	# own faces in their planes, or where two of its blocks meet inside a
	# room: settled once all are made, so each cut works on the block as built,
	# the room's paint kept where a copy of the grey lies on it
	bm = bmesh.new()
	bm.from_mesh(obj.data)
	unique(bm, [m.name for m in obj.data.materials], prefer=("room",))
	bm.to_mesh(obj.data)
	bm.free()
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
	# standing on a face, its front stands off it at least as far as its size
	# needs for the game's depth buffer to keep the two apart from afar
	# (depth.py): a few millimetres more on a panel a metre or two across, up
	# to STANDOFF; a larger plate needs the face behind it cut away instead. A
	# cutout (the lettering) fights its face only along its marks, which need
	# far less than its plate
	size = min(max((base[0] - base[1]).length, (base[2] - base[3]).length), max((base[1] - base[2]).length, (base[3] - base[0]).length))
	if not (paint == "lettering" and LAYOUT.get("lettering", {}).get("cutout")):
		thickness = max(thickness, min(1.1 * needed(size), STANDOFF))
	out = at(*outward)
	out = out.normalized() * thickness
	# the corners round anticlockwise seen from outside, so every face winds
	# outward (a plate welded to its neighbours is not turned by tidy())
	if (base[1] - base[0]).cross(base[2] - base[1]).dot(out) < 0:
		base = base[::-1]
	vertices = base + [v + out for v in base]
	faces = [(3, 2, 1, 0), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
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
	# rounded corners; a frame round it, flatter, so the glass stands proud of
	# it: a ring round the glass, which stands on the face inside it off it
	# as far as its size needs (as plate() stands a plate off). A frame drawn
	# whole behind the glass lay a little behind its front over all of it, and
	# over the face, for the depth buffer to draw through it
	corners = square(0)
	span = min(math.dist(corners[0], corners[1]), math.dist(corners[1], corners[2]))
	pieces = [sheet(rounded(corners, entry["radius"]), outward, max(thick, min(1.1 * needed(span), STANDOFF)), paint)]
	if entry.get("frame"):
		pieces.append(band(rounded(square(entry["frame"]), entry["radius"] + entry["frame"]), rounded(corners, entry["radius"]), outward, thick / 2, entry.get("rim", "panel")))
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


def section(origin, across, along, points, thickness, paint="grey", holes=()):
	# A plate standing in the vertical plane through `origin` [x, z] across
	# `across` (a plan direction [x, z]): its outline [[out, y], ...], `out`
	# metres along `across`, made `thickness` thick along `along`; `holes`
	# [[out, y, radius], ...] round holes through it, walled
	from mathutils.geometry import tessellate_polygon
	o = Vector((across[0], across[1]))
	a = Vector((along[0], along[1])).normalized() * (thickness / 2)
	area = lambda pts: sum(p[0] * q[1] - q[0] * p[1] for p, q in zip(pts, pts[1:] + pts[:1])) / 2
	turning = area(points) > 0
	loops = [list(points)]
	for d, y, r in holes:
		ring = [(d + r * math.cos(2 * math.pi * k / 24), y + r * math.sin(2 * math.pi * k / 24)) for k in range(24)]
		loops.append(ring[::-1] if turning else ring)   # wound against the outline
	flat = [p for loop in loops for p in loop]
	m = len(flat)
	vertices = [at(origin[0] + o.x * d + a.x * s, y, origin[1] + o.y * d + a.y * s) for s in (-1, 1) for d, y in flat]
	if holes:
		front = []
		for tri in tessellate_polygon([[Vector((d, y, 0)) for d, y in loop] for loop in loops]):
			tri = list(tri)
			if (area([flat[i] for i in tri]) > 0) != turning:
				tri.reverse()
			front.append(tuple(tri))
		faces = front + [tuple(m + i for i in reversed(f)) for f in front]
	else:
		faces = [tuple(range(m)), tuple(range(2 * m - 1, m - 1, -1))]
	start = 0
	for loop in loops:
		k = len(loop)
		# the walls wound as the faces are (they were wound against them, which
		# tidy() put right only for a plate standing alone)
		faces += [(start + i, m + start + i, m + start + (i + 1) % k, start + (i + 1) % k) for i in range(k)]
		start += k
	# and the whole turned outward whichever way its outline and its axes run
	# (a knee welded to its floor is not turned by tidy())
	return outward((vertices, faces, [paint] * len(faces)))


def edge_line(side, x0, x1):
	# The deck's edge on one side between x0 and x1 as a plan line [[x, z],
	# ...] forward, through every corner of the deck's and the elevators'
	# outlines between
	outlines = [LAYOUT["deck"]["outline"]] + [e["outline"] for e in LAYOUT.get("elevators", [])]
	xs = sorted({x0, x1} | {p[0] for o in outlines for p in o if x0 < p[0] < x1})
	return [[x, edge(outlines, x, side)] for x in xs]


def offset(line, side, distance, square=False):
	# A plan line [[x, z], ...] running forward, moved `distance` outboard
	# (side +1 starboard, -1 port), mitred at its corners; and each point's
	# outward direction. Its ends moved square to the ship's length with
	# `square` (z only, as far as the line's end runs, outboard along its
	# own normal), so two lines meeting end to end at an x cut alike there,
	# where each cut along its own end's normal laid a wedge of one over the
	# other or opened one between them. A run shorter than its corner's mitre shifts its end
	# along (a catwalk starting 8 mm before the deck edge's corner) would run
	# backward, folding whatever is built along the line over itself: the
	# corner it ends at is dropped, and the line runs straight past it
	line = list(line)
	while True:
		normals = []
		for a, b in zip(line, line[1:]):
			d = Vector((b[0] - a[0], b[1] - a[1])).normalized()
			normals.append(Vector((-d.y, d.x)) * side)
		out, directions = [], []
		for k, p in enumerate(line):
			around = [normals[i] for i in (k - 1, k) if 0 <= i < len(normals)]
			n = sum(around, Vector((0, 0))).normalized()
			if square and len(around) == 1:
				n = Vector((0, side))
			scale = 1 / max(n.dot(around[0]), 0.3)
			out.append([p[0] + n.x * distance * scale, p[1] + n.y * distance * scale])
			directions.append([n.x, n.y])
		back = [k for k in range(len(line) - 1) if (out[k + 1][0] - out[k][0]) * (line[k + 1][0] - line[k][0])
			+ (out[k + 1][1] - out[k][1]) * (line[k + 1][1] - line[k][1]) <= 0]
		if not back or len(line) <= 2:
			return out, directions
		k = back[0]
		del line[k + 1 if k + 1 < len(line) - 1 else k]


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
	# A toe board, a mid rail and a top rail along a plan line, and posts.
	# Each rail is one bar along the whole line, mitred at its corners
	# (swept()); each post runs from a centimetre into the floor up to the
	# top rail's underside
	pieces = []
	height = spec["railing"]
	for y, size in ((floor + spec["toe"] / 2, spec["toe"]), (floor + height / 2, 0.04), (floor + height, 0.05)):
		pieces.append(swept([[q[0], y, q[1]] for q in line], size, paint))
	for q, _ in along_line(line, spec["posts"]):
		pieces.append(bar([q[0], floor - 0.01, q[1]], [q[0], floor + height - 0.025, q[1]], POST, paint))
	return pieces


def swept(points, size, paint, closed=False):
	# A square bar `size` across along a path [[x, y, z], ...] (ship frame),
	# round its corners as one piece, cut at each on the plane halfway
	# between its runs, or all the way round a `closed` one. A bar a run
	# overlapped the next at each corner with their faces in one plane, for
	# the depth buffer to draw through each other (a railing's rails, a
	# frame's members, a seal round a window): hence one piece. Its first
	# run's section as bar()'s, each next one's that section reflected in
	# the corner's cut, so the faces meet edge to edge there and a path in
	# one plane keeps its faces square to it all the way
	points = [at(*q) for q in points]
	points = [q for k, q in enumerate(points) if k == 0 or (q - points[k - 1]).length > 1e-6]
	if closed and len(points) > 2 and (points[-1] - points[0]).length < 1e-6:
		points = points[:-1]
	half = size / 2
	n = len(points)
	runs = [(points[(k + 1) % n] - points[k]).normalized() for k in range(n if closed else n - 1)]
	d = runs[0]
	helper = UP if abs(d.dot(UP)) < 0.9 else FORWARD
	u = d.cross(helper).normalized()
	w = d.cross(u).normalized()
	corners = ((-1, -1), (1, -1), (1, 1), (-1, 1))

	def cut(k):
		# the plane through point k between its runs (None at an open end)
		if not closed and k in (0, n - 1):
			return None
		a, b = runs[k - 1], runs[k % len(runs)]
		m = a + b
		return m.normalized() if m.length > 1e-6 else a
	def joint(k, u, w):
		# the ring where run k - 1 meets the cut at point k, from that run's
		# section (u, w), and the next run's section: it reflected in the cut
		q, m, a = points[k], cut(k), runs[k - 1]
		ring = []
		for i, j in corners:
			c = u * (i * half) + w * (j * half)
			ring.append(q + c - a * (c.dot(m) / max(a.dot(m), 0.3)))
		return ring, u - m * (2 * u.dot(m)), w - m * (2 * w.dot(m))
	rings = [None] * n
	if not closed:
		rings[0] = [points[0] + u * (i * half) + w * (j * half) for i, j in corners]
	for k in range(1, n if closed else n - 1):
		rings[k], u, w = joint(k, u, w)
	if closed:
		# the closing corner from the section the last run arrives with (a
		# loop in one plane comes back to the first run's own)
		rings[0], _, _ = joint(0, u, w)
	else:
		rings[n - 1] = [points[n - 1] + u * (i * half) + w * (j * half) for i, j in corners]
	vertices = [v for ring in rings for v in ring]
	faces = []
	for k in range(n if closed else n - 1):
		a, b = 4 * k, 4 * ((k + 1) % n)
		faces += [(a + i, a + (i + 1) % 4, b + (i + 1) % 4, b + i) for i in range(4)]
	if not closed:
		last = 4 * (n - 1)
		faces += [(0, 3, 2, 1), (last, last + 1, last + 2, last + 3)]
	return outward((vertices, faces, [paint] * len(faces)))


def catwalk_runs():
	# Each catwalk's deck-edge line, its outboard line and outward directions
	spec = LAYOUT.get("catwalks")
	runs = []
	for r in (spec or {}).get("runs", []):
		side = 1 if r["side"] == "starboard" else -1
		inner = edge_line(side, *r["x"])
		outer, directions = offset(inner, side, r["width"], square=True)
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
	# the plate knees under the floors, every `spacing` along the deck's edge,
	# as (side, point, direction, reach, foot): each from the floor's outer
	# edge, `reach` outboard, down to `foot` at the edge, its inboard part
	# running on into the hull so its foot meets whatever the edge has below
	# it. One a place, the furthest reaching, where two runs meet or a
	# platform's falls on a catwalk's (each run puts one at its ends, and two
	# in one place lay in each other's faces)
	braces = []
	runs = catwalk_runs()
	for r in runs:
		inside, _ = offset(r["inner"], r["side"], -0.2, square=True)   # into the band, so the floor's edge never lies on it
		pieces.append(prism(inside + r["outer"][::-1], floor - 0.1, floor))
		pieces += railing(r["outer"], floor, spec)
		braces += [(r["side"], p, d, r["width"], floor - 0.1 - k["depth"]) for p, d in along_line(r["inner"], k["spacing"])]
	for pl in spec.get("platforms", []):
		side = 1 if pl["side"] == "starboard" else -1
		inner = edge_line(side, *pl["x"])
		width = max([r["width"] for r in runs if r["side"] == side and r["x"][0] <= sum(pl["x"]) / 2 <= r["x"][1]], default=0.0)
		# its inboard edge each catwalk's outboard edge along it, so it meets
		# the floors edge to edge where they widen under it; its outboard
		# edge the catwalk's at its middle and its width beyond
		near = []
		cuts = sorted({pl["x"][0], pl["x"][1]} | {x for r in runs if r["side"] == side for x in r["x"] if pl["x"][0] < x < pl["x"][1]})
		for a, b in zip(cuts, cuts[1:]):
			reach = max([r["width"] for r in runs if r["side"] == side and r["x"][0] <= (a + b) / 2 <= r["x"][1]], default=0.0)
			near += [q for q in offset(edge_line(side, a, b), side, reach, square=True)[0] if not near or math.dist(q, near[-1]) > 1e-6]
		far, _ = offset(inner, side, width + pl["width"], square=True)
		pieces.append(prism(near + far[::-1], floor - 0.1, floor))
		pieces += railing(far, floor, spec)
		braces += [(side, p, d, width + pl["width"], floor - 0.1 - k["depth"] - 0.2 * pl["width"]) for p, d in along_line(inner, 2.0)]
	kept = []
	for b in sorted(braces, key=lambda b: -b[3]):
		if not any(b[0] == c[0] and math.dist(b[1], c[1]) < 0.05 for c in kept):
			kept.append(b)
	for side, p, d, reach, foot in kept:
		out = [-d[1] * side, d[0] * side]
		pieces.append(section(p, out, d, [(-1.5, floor - 0.1), (reach, floor - 0.1), (0.0, foot), (-1.5, foot)], 0.04))
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
		# the platform's inboard edge on the catwalk's outer edge, edge to edge
		# (inboard of it, the two floors lay in one plane), or carried into
		# the band where none runs, so it meets what it stands off
		inmost = min(abs(p[1]) for p in d["platform"])
		platform = []
		for x, z in d["platform"]:
			if abs(abs(z) - inmost) < 1e-6:
				edge_z = abs(edge_line(side, x - 0.01, x + 0.01)[0][1])
				catwalk = [q["outer"] for q in runs if q["side"] == side and q["x"][0] <= x <= q["x"][1]]
				if catwalk:
					line = catwalk[0]
					k = max(i for i in range(len(line) - 1) if line[i][0] <= x + 1e-9) if x >= line[0][0] else 0
					(ax, az), (bx, bz) = line[k], line[min(k + 1, len(line) - 1)]
					z = az + (bz - az) * (x - ax) / (bx - ax) if abs(bx - ax) > 1e-9 else az
				else:
					z = side * min(abs(z), edge_z - 0.2)
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


def coamings():
	# The low coamings on the deck at its edge (layout.coaming): each a wall
	# `height` tall and `width` deep along the edge from x to x, and at its
	# foot its scuppers, `height` tall and `width` wide, dark, one every
	# `pitch` from the one centred at `at`, none where a pillar stands (the
	# pitch nearest each of `pillars`). The foot is built as pillars and
	# scuppers side by side, flush, so neither fights the other
	pieces = []
	deck = LAYOUT["deck"]["height"]
	for c in LAYOUT.get("coaming", []):
		side = 1 if c["side"] == "starboard" else -1
		(x0, x1), paint, s = c["x"], c.get("paint", "coaming"), c.get("scuppers")
		def wall(a, b, bottom, top, paint):
			outer = edge_line(side, a, b)
			inner, _ = offset(outer, side, -c["width"])
			return prism(outer + inner[::-1], deck + bottom, deck + top, paint=paint)
		foot = s["height"] if s else 0.0
		pieces.append(wall(x0, x1, foot, c["height"], paint))
		# its station placards (`placards`: each its `x` run and `height` [from,
		# to] above the deck, in its `paint`, the colours `colours` names in
		# sRGB): plates 5 mm proud of its inboard face
		for name, colour in c.get("colours", {}).items():
			COLOURS[name] = tuple(linear(v) for v in colour) + (1,)
		for p in c.get("placards", []):
			(a, b), (low, high) = p["x"], p["height"]
			face, _ = offset(edge_line(side, a, b), side, -c["width"])
			front, _ = offset(edge_line(side, a, b), side, -(c["width"] + 0.005))
			pieces.append(prism(face + front[::-1], deck + low, deck + high, paint=p["paint"]))
		if not s:
			continue
		cuts = []
		for k in range(math.ceil((x0 - s["at"]) / s["pitch"]), math.floor((x1 - s["at"]) / s["pitch"]) + 1):
			centre = s["at"] + k * s["pitch"]
			if centre - s["width"] / 2 < x0 or centre + s["width"] / 2 > x1:
				continue
			if any(abs(centre - p) < s["pitch"] / 2 for p in s.get("pillars", [])):
				continue
			cuts.append((centre - s["width"] / 2, centre + s["width"] / 2))
		x = x0
		for a, b in cuts:
			pieces += [wall(x, a, 0.0, foot, paint), wall(a, b, 0.0, foot, "dark")]
			x = b
		pieces.append(wall(x, x1, 0.0, foot, paint))
	return pieces


def lens_housing():
	# The landing lens's housing (layout.lens.housing), its parts in the lens's
	# own frame: t along its face, positive inboard; h above its datum; d
	# behind its face, forward. box {t, h, d: [from, to], face}: a block square
	# to the face, its side toward the face's front painted `face` where it is
	# given (the boards: black in front, grey at their sides and backs); drum
	# {t: [from, to], h, d, radius}: a cylinder along the face; bar {from, to:
	# [t, h, d], size}: a strut; chain {posts: [[t, d], ...], h, height,
	# courses, sag}: posts on a floor at h, a chain from each post's top to the
	# next's and one more for each course (that far below the tops), sagging
	# `sag` times its span at mid-span. Each of the lens's lights gets a
	# lamp (lamps.<name> {radius, depth, paint, lens}): a housing behind it
	# with its glass in front, and the cell column its cells (cells {radius,
	# depth, paint}) at the lens's pitch. The engine draws the lights
	# themselves, and no housing of its own for a lens the ship file says is
	# housed
	lens = LAYOUT.get("lens")
	spec = (lens or {}).get("housing")
	if not spec:
		return []
	origin, facing = Vector(lens["position"]), Vector(lens["facing"]).normalized()
	across = Vector((-facing.z, 0.0, facing.x))
	if across.z * origin.z > 0:
		across = -across          # inboard: toward the centreline
	def point(t, h, d):
		return list(origin + across * t + Vector((0.0, h, 0.0)) - facing * d)
	pieces = []
	for p in spec.get("parts", []):
		kind, paint = p["kind"], p.get("paint", "grey")
		if kind == "box":
			(t0, t1), (h0, h1), (d0, d1) = p["t"], p["h"], p["d"]
			outline = [[q[0], q[2]] for q in (point(t0, 0, d0), point(t1, 0, d0), point(t1, 0, d1), point(t0, 0, d1))]
			vertices, faces, paints = prism(outline, origin.y + h0, origin.y + h1, paint=paint)
			if p.get("face"):
				front = at(*point((t0 + t1) / 2, (h0 + h1) / 2, d0))
				k = min(range(len(faces)), key=lambda i: (sum((vertices[j] for j in faces[i]), Vector()) / len(faces[i]) - front).length)
				paints[k] = p["face"]
			pieces.append((vertices, faces, paints))
		elif kind == "drum":
			(t0, t1), h, d = p["t"], p["h"], p["d"]
			pieces.append(shape({"kind": "cylinder", "base": point(t0, h, d), "end": point(t1, h, d), "radius": p["radius"], "segments": 16, "paint": paint}))
		elif kind == "bar":
			pieces.append(shape({"kind": "path", "path": [point(*p["from"]), point(*p["to"])], "size": p["size"], "paint": paint}))
		elif kind == "chain":
			posts, floor, top, steps = p["posts"], p["h"], p["h"] + p["height"], 8
			for t, d in posts:
				pieces.append(bar(point(t, floor, d), point(t, top, d), p.get("post", 0.05), paint))
			for height in [top] + [top - c for c in p.get("courses", [])]:
				for (ta, da), (tb, db) in zip(posts, posts[1:]):
					sag = p["sag"] * math.hypot(tb - ta, db - da)
					line = [point(ta + (tb - ta) * k / steps, height - sag * 4 * k / steps * (1 - k / steps), da + (db - da) * k / steps) for k in range(steps + 1)]
					pieces.append(shape({"kind": "path", "path": line, "size": p.get("size", 0.03), "round": True, "paint": paint}))
		else:
			raise ValueError(f"lens housing part {p.get('name')}: unknown kind {kind}")
	glass = 0.02
	for name, lamp in spec.get("lamps", {}).items():
		for q in lens["lights"].get(name, []):
			front = Vector(q)
			pieces.append(shape({"kind": "cylinder", "base": list(front), "end": list(front - facing * glass), "radius": lamp["radius"], "segments": 16, "paint": lamp["lens"]}))
			pieces.append(shape({"kind": "cylinder", "base": list(front - facing * glass), "end": list(front - facing * lamp["depth"]), "radius": lamp["radius"], "segments": 16, "paint": lamp["paint"]}))
	cells = spec.get("cells")
	if cells:
		for k in range(lens["cells"]):
			h = (k - (lens["cells"] - 1) / 2) * lens["pitch"]
			pieces.append(shape({"kind": "cylinder", "base": point(0, h, 0), "end": point(0, h, cells["depth"]), "radius": cells["radius"], "segments": 16, "paint": cells["paint"]}))
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
		# its lightening holes (knee.holes: each [out from the face, down
		# from the floor's underside, radius]); its outer end upright for
		# knee.toe under the floor before its edge slopes to the foot
		holes = [(d, floor - 0.2 - down, r) for d, down, r in k.get("holes", [])]
		width = abs(edge - face)
		outer = [(width, floor - 0.2)] + ([(width, floor - 0.2 - k["toe"])] if k.get("toe") else [])
		# its tail into the sponson rising from its foot: level with it, the
		# tail's underside lay in the sponson's bottom where the foot is there
		pieces.append(section([k["x"], face], [0, side], [1, 0], [(-0.5, floor - 0.2)] + outer + [(0.0, k["foot"]), (-0.5, k["foot"] + 0.1)], 0.06, holes=holes))
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
				outer, _ = offset(inner, r["side"], r["width"], square=True)
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
	run = t.get("run")
	if run:
		# the face run on outboard of the section on one side (transom.run):
		# from the section's side out to |z| `out`, from `bottom` up to the
		# deck's underside, a solid forward to x `forward`. Its inboard side
		# is the section's, from a point put in it at `bottom`, so its face
		# and the transom's meet edge to edge in one plane; a box there,
		# overlapping the section, lay a little behind the face wherever the
		# section covered it, for the depth buffer to draw through
		section = [list(q) for q in section]
		sign = 1 if run["side"] == "starboard" else -1
		upward = [5, 4, 3] if sign > 0 else [0, 1, 2]   # that side's corners from the floor up
		for k in range(len(upward) - 1):
			(za, ya), (zb, yb) = section[upward[k]], section[upward[k + 1]]
			if ya - 1e-6 <= run["bottom"] <= yb + 1e-6:
				f = (run["bottom"] - ya) / (yb - ya) if abs(yb - ya) > 1e-9 else 0.0
				foot = [za + (zb - za) * f, run["bottom"]]
				break
		else:
			raise ValueError(f"transom.run: its bottom {run['bottom']} lies outside the section's side")
		place = max(upward[k], upward[k + 1])
		if all(math.dist(foot, q) > 1e-6 for q in section):
			section.insert(place, foot)
			upward = [i + (i >= place) for i in upward]
		above = [section[i] for i in upward if section[i][1] > run["bottom"] + 1e-6]
		polygon = [foot] + above + [[sign * run["out"], above[-1][1]], [sign * run["out"], run["bottom"]]]
		centre = [sum(q[0] for q in polygon) / len(polygon), sum(q[1] for q in polygon) / len(polygon)]
		xf = run["forward"]
		shell.append(facing([[x1, y, z] for z, y in polygon], [-1, 0, 0], "grey"))
		shell.append(facing([[xf, y, z] for z, y in polygon], [1, 0, 0], "grey"))
		for (za, ya), (zb, yb) in zip(polygon, polygon[1:] + polygon[:1]):
			out = [0, zb - za, -(yb - ya)]
			if out[1] * ((ya + yb) / 2 - centre[1]) + out[2] * ((za + zb) / 2 - centre[0]) < 0:
				out = [0, -out[1], -out[2]]
			shell.append(facing([[x1, ya, za], [xf, ya, za], [xf, yb, zb], [x1, yb, zb]], out, "grey"))
	for (za, ya), (zb, yb) in zip(section, section[1:]):
		out = [0, zb - za, -(yb - ya)]   # across the edge, in (y, z)
		if out[1] * ((ya + yb) / 2 - middle[1]) + out[2] * ((za + zb) / 2 - middle[0]) < 0:
			out = [0, -out[1], -out[2]]
		shell.append(facing([[x0, ya, za], [x1, ya, za], [x1, yb, zb], [x0, yb, zb]], [0, out[1], out[2]], "grey"))
	# its underside where it overhangs the hull's last section, the whole
	# width, under the recess's floor too (seen from the walkway below)
	shell.append(facing([[x0, floor, section[0][0]], [x1, floor, section[0][0]], [x1, floor, section[-1][0]], [x0, floor, section[-1][0]]], [0, -1, 0], "grey"))
	shell.append(facing([[x1, y, z] for z, y in [section[0]] + hole + section[:0:-1]], [-1, 0, 0], "grey"))
	# the recess: its walls and floor face in, its back wall aft, in the ship's
	# grey, the weathering's occlusion darkening it as the photos' shade does.
	# In: to the left of each edge as the outline runs anticlockwise (its
	# middle lies above the ledge where it steps in, so a wall turned toward
	# that faced out of the recess)
	turn = sum(za * yb - zb * ya for (za, ya), (zb, yb) in zip(hole, hole[1:] + hole[:1]))
	for (za, ya), (zb, yb) in zip(hole, hole[1:] + hole[:1]):
		inward = [0, (zb - za) * (1 if turn > 0 else -1), -(yb - ya) * (1 if turn > 0 else -1)]
		shell.append(facing([[x1, ya, za], [back, ya, za], [back, yb, zb], [x1, yb, zb]], inward, "grey"))
	shell.append(facing([[back, y, z] for z, y in hole], [-1, 0, 0], "grey"))
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
	# the fascia and the member under it along its aft edge (one line or
	# several), each standing out from the walkway, one piece along the whole
	# line mitred at its corners: a piece a run, each overlapped the next at
	# its corners with their faces in one plane, for the depth buffer to draw
	# through each other
	lines = w["aft"] if isinstance(w["aft"][0][0], list) else [w["aft"]]
	for line in lines:
		# the side of the line the walkway lies on, which every run must agree on
		sides = set()
		for (ax, az), (bx, bz) in zip(line, line[1:]):
			length = math.hypot(bx - ax, bz - az)
			nx, nz = (bz - az) / length, -(bx - ax) / length   # offset()'s outward for side -1
			sides.add(1 if inside([(ax + bx) / 2 + nx * 0.01, (az + bz) / 2 + nz * 0.01], w["plan"]) else -1)
		if len(sides) != 1:
			raise ValueError(f"transom walkway: its aft line {line} runs on both sides of the walkway")
		side = sides.pop()
		for (y0, y1), depth in ((w["fascia"], 0.1), (w["member"], 0.2)):
			out, _ = offset(line, side, depth)
			fittings.append(prism(line + out[::-1], y0, y1))
	f = t["frame"]
	(z0, z1) = f["z"]
	for k in range(f["members"]):
		z = z0 + (z1 - z0) * k / (f["members"] - 1)
		fittings.append(bar([f["x"], f["bottom"], z], [f["x"], f["top"], z], f["size"], "dark"))
	# the bar along their tops a centimetre larger than they are: as large,
	# its faces lay in theirs where it crossed them
	fittings.append(bar([f["x"], f["top"] - f["size"] / 2, z0], [f["x"], f["top"] - f["size"] / 2, z1], f["size"] + 0.01, "dark"))
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
	# that gives a `mark` is a landmark for the photo match at its centre; a
	# `net` a panel of see-through net (net_panels())
	fittings += [shape(d) for d in t.get("details", []) if d["kind"] != "net"]
	for d in t.get("details", []):
		if "mark" in d:
			MARKS[d["mark"]] = (at(*d["centre"]), "transom_fittings")
	node("transom_fittings", mesh=merge(fittings))
	net_panels([d for d in t.get("details", []) if d["kind"] == "net"])


def net_panels(panels):
	# Flat panels of net (the port aft sponson's cage), each four `corners` in
	# the ship frame: one node, `net_panels`, in the nets' see-through cord
	# (net_material()), mapped square on each panel's own plane at the nets'
	# NET_TILE, so a vertical panel's meshes come out as the catwalks' do
	if not panels:
		return
	vertices, faces, planes = [], [], []
	for p in panels:
		corners = [at(*q) for q in p["corners"]]
		faces.append(tuple(range(len(vertices), len(vertices) + 4)))
		vertices += corners
		u, v = (corners[1] - corners[0]).normalized(), (corners[3] - corners[0]).normalized()
		planes.append((corners[0], u, v, u.cross(v).normalized()))
	net_material()
	obj = node("net_panels", mesh=(vertices, faces, ["net"] * len(faces)))
	uv = obj.data.uv_layers.new(name="net")
	hinge = HINGES["net_panels"]
	for polygon in obj.data.polygons:
		# its panel: the one whose plane passes through its middle
		middle = polygon.center + hinge
		origin, u, v, _ = min(planes, key=lambda q: abs((middle - q[0]).dot(q[3])))
		for k in polygon.loop_indices:
			co = obj.data.vertices[obj.data.loops[k].vertex_index].co + hinge
			uv.data[k].uv = ((co - origin).dot(u) / NET_TILE, (co - origin).dot(v) / NET_TILE)


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
	if axes[0].cross(axes[1]).dot(axes[2]) < 0:
		faces = [f[::-1] for f in faces]   # outward with left-handed axes too (box())
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
	# deck-edge sponsons with their domes, what hangs on the sides
	# (hull.details), the catwalks and the raft racks (one fixed node); the
	# weapons on the sponsons; and the openings in the hull sides and
	# transom, drawn dark a few centimetres proud of them
	top = LAYOUT["deck"]["height"]
	pieces = [prism(s["outline"], s["bottom"], s["top"]) for s in LAYOUT.get("sponsons", [])]
	# what stands on a sponson (shape()s: a deckhouse, its railings)
	pieces += [shape(d) for s in LAYOUT.get("sponsons", []) for d in s.get("details", [])]
	# what hangs on the hull's sides clear of the sponsons (shape()s: the
	# frame in the starboard bay aft of the island)
	pieces += [shape(d) for d in LAYOUT.get("hull", {}).get("details", [])]
	for s in LAYOUT.get("sponsons", []):
		n = len(s["outline"])
		for k, (x, z) in enumerate(s["outline"]):
			for end in ("bottom", "top"):
				y = s[end][k] if isinstance(s[end], list) else s[end]
				MARKS[f"sponson_{s['name']}_{end}_{k + 1}"] = (at(x, y, z), "sponsons")
	pieces += domes_edge() + catwalks() + racks() + tubs() + lens_housing() + coamings()
	if pieces:
		node("sponsons", mesh=merge(pieces))
	nets()
	weapons = [piece for m in LAYOUT.get("weapons", {}).get("mounts", []) for piece in mounted(m)]
	if weapons:
		node("weapons", mesh=merge(weapons))
	openings = [face(o, [0, 0], "dark") for o in LAYOUT.get("openings", [])]
	if openings:
		node("openings", mesh=merge(openings))


def basis(axis):
	# A unit vector along `axis` (ship frame) and two square to it and to each
	# other
	n = Vector(axis).normalized()
	u = n.cross(Vector((0, 1, 0)) if abs(n.y) < 0.9 else Vector((1, 0, 0))).normalized()
	return n, u, n.cross(u)


def spun(centre, axis, profile, segments=24, paint="grey", closed=False, paints=None):
	# A solid turned about the line through `centre` (ship frame) along `axis`:
	# profile [[along, radius], ...], `along` metres along the axis from the
	# centre. A radius of 0 closes it to a point and an open end is capped
	# flat; `closed` joins the profile's last point to its first instead (a
	# ring: a tyre's carcass) and caps nothing. `paints` gives each step of the
	# profile its own paint. (vertices, faces, paints, smooth): the turned
	# bands smooth, the caps flat
	c = Vector(centre)
	n, u, w = basis(axis)
	vertices, rings = [], []
	for a, r in profile:
		if r <= 1e-6:
			rings.append([len(vertices)])
			vertices.append(at(*(c + n * a)))
			continue
		rings.append(list(range(len(vertices), len(vertices) + segments)))
		vertices += [at(*(c + n * a + (u * math.cos(2 * math.pi * k / segments) + w * math.sin(2 * math.pi * k / segments)) * r)) for k in range(segments)]
	faces, out, smooth = [], [], []
	steps = list(zip(rings, rings[1:])) + ([(rings[-1], rings[0])] if closed else [])
	for i, (low, high) in enumerate(steps):
		band = paints[i] if paints else paint
		for k in range(segments):
			a, b = k, (k + 1) % segments
			if len(low) == 1 and len(high) == 1:
				continue
			faces.append((low[0], high[a], high[b]) if len(low) == 1 else (low[a], high[0], low[b]) if len(high) == 1 else (low[a], high[a], high[b], low[b]))
			out.append(band)
			smooth.append(True)
	if not closed:
		for ring, band in ((rings[0], paints[0] if paints else paint), (rings[-1], paints[-1] if paints else paint)):
			if len(ring) > 1:
				faces.append(tuple(ring))
				out.append(band)
				smooth.append(False)
	return vertices, faces, out, smooth


def sweep(path, radius, segments=8, paint="grey"):
	# A round bar along a line of points (ship frame), `radius` across or one
	# radius per point: a ring at every point, square to the line's mean
	# direction there and widened so a bend keeps its thickness, carried round
	# the line without twisting, and a flat cap at each end. A rope, a hose, a
	# cable. (vertices, faces, paints, smooth)
	points = [Vector(q) for q in path]
	radii = radius if isinstance(radius, (list, tuple)) else [radius] * len(points)
	runs = [(b - a).normalized() for a, b in zip(points, points[1:])]
	tangents = [runs[0]] + [(a + b).normalized() if (a + b).length > 1e-6 else b for a, b in zip(runs, runs[1:])] + [runs[-1]]
	_, u, _ = basis(tangents[0])
	vertices, rings = [], []
	for i, (q, t) in enumerate(zip(points, tangents)):
		if i:
			u = tangents[i - 1].rotation_difference(t) @ u
			u = (u - t * u.dot(t)).normalized()
		w = t.cross(u)
		# a mitred ring: as much wider as the bend's half angle asks, so the
		# bar does not pinch at a corner
		widen = 1 / max(0.5, runs[min(i, len(runs) - 1)].dot(t))
		rings.append(len(vertices))
		vertices += [at(*(q + (u * math.cos(2 * math.pi * k / segments) + w * math.sin(2 * math.pi * k / segments)) * radii[i] * widen))
			for k in range(segments)]
	faces = [(r + k, r + (k + 1) % segments, s + (k + 1) % segments, s + k) for r, s in zip(rings, rings[1:]) for k in range(segments)]
	smooth = [True] * len(faces)
	faces += [tuple(range(rings[0], rings[0] + segments)), tuple(range(rings[-1], rings[-1] + segments))]
	smooth += [False, False]
	return vertices, faces, [paint] * len(faces), smooth


def reeved(path, step=math.radians(15)):
	# A rope's line (ship frame points) through `path`: its ends {"at": point}
	# and the sheaves it runs round between them, {"sheave": centre, "axis",
	# "radius": the groove's pitch radius, "turn": 1 to run round it
	# anticlockwise about its axis, -1 clockwise}. Each straight run leaves one
	# sheave and meets the next on their tangents, found by turns (each
	# sheave's tangent points from its neighbours' until they settle), and the
	# rope wraps each sheave's groove between them
	nodes = []
	for q in path:
		if "sheave" in q:
			n, u, w = basis(q["axis"])
			nodes.append({"centre": Vector(q["sheave"]), "n": n, "u": u, "w": w, "r": q["radius"], "turn": q.get("turn", 1), "in": None, "out": None})
		else:
			nodes.append({"at": Vector(q["at"])})
	if "at" not in nodes[0] or "at" not in nodes[-1]:
		raise ValueError("a rope ends at points, not on sheaves")

	def on(s, angle):
		return s["centre"] + (s["u"] * math.cos(angle) + s["w"] * math.sin(angle)) * s["r"]

	def seen(i, j):
		# where node j's part of the rope is, as node i reaches toward it
		other = nodes[j]
		if "at" in other:
			return other["at"]
		key = "out" if j < i else "in"
		return on(other, other[key]) if other[key] is not None else other["centre"]

	for _ in range(30):
		for i, s in enumerate(nodes):
			if "at" in s:
				continue
			for j, key in ((i - 1, "in"), (i + 1, "out")):
				d = seen(i, j) - s["centre"]
				d = d - s["n"] * d.dot(s["n"])
				angle = math.atan2(d.dot(s["w"]), d.dot(s["u"]))
				spread = math.acos(min(1.0, s["r"] / max(d.length, 1e-9)))
				s[key] = angle + s["turn"] * spread if key == "in" else angle - s["turn"] * spread
	line = []
	for s in nodes:
		if "at" in s:
			line.append(s["at"])
			continue
		wrap = ((s["out"] - s["in"]) * s["turn"]) % (2 * math.pi)
		if wrap > 2 * math.pi - 1e-3:
			wrap = 0.0
		count = max(1, math.ceil(wrap / step))
		line += [on(s, s["in"] + s["turn"] * wrap * k / count) for k in range(count + 1)]
	return [list(q) for q in line]


def tyre(p, paint="dark"):
	# A wheel standing about its axle: `centre` the middle of the tyre's width,
	# `axis` out from the vehicle; the tyre's carcass turned with rounded
	# shoulders and a bulging sidewall, its lugs (lugs {count each side, depth,
	# width, lean: how far round the tread a lug runs from the shoulder in, and
	# reach: how far past the middle, of the half width}) standing on its tread
	# alternately from either shoulder, and a dished rim (`rim` its lip's
	# diameter, `dish` how far its disc sits in from the lip, `hub` the boss's
	# diameter) with `bolts` round the boss. (vertices, faces, paints, smooth)
	c = Vector(p["centre"])
	n, u, w = basis(p["axis"])
	segments = p.get("segments", 32)
	R, half = p["diameter"] / 2, p["width"] / 2
	lugs = p.get("lugs")
	depth = lugs["depth"] if lugs else 0.0
	crown, rim = R - depth, p["rim"] / 2
	wall = crown - rim
	# the carcass's section, from the rim's lip on the inner face round the
	# outside to the outer face's lip, closed along the bead seat
	section = [(-0.86, 0.0), (-1.03, 0.4), (-0.96, 0.82), (-0.75, 1.0), (0.75, 1.0), (0.96, 0.82), (1.03, 0.4), (0.86, 0.0)]
	pieces = [spun(c, n, [(a * half, rim + 0.01 + h * (wall - 0.01)) for a, h in section], segments, paint, closed=True)]
	if lugs:
		count, width, lean, reach = lugs["count"], lugs["width"], lugs.get("lean", 0.3), lugs.get("reach", 0.1)
		for side in (-1, 1):
			for k in range(count):
				centre = 2 * math.pi * (k + (0.5 if side > 0 else 0)) / count
				# from over the shoulder in to past the middle: the lug's foot
				# sunk a little into the carcass, its top falling away over
				# the shoulder
				stations = [(side * half * 0.97, crown - 0.22 * wall, R - 0.12 * wall), (-side * half * reach, crown - 0.01, R)]
				vertices, rings = [], []
				for along, low, high in stations:
					t = (half * 0.99 - side * along) / (half * (0.99 + reach))
					angle = centre + side * lean * t / R
					ring = []
					for radius in (low, high):
						for e in (-0.5, 0.5):
							a = angle + e * width / R
							ring.append(len(vertices))
							vertices.append(at(*(c + n * along + (u * math.cos(a) + w * math.sin(a)) * radius)))
					rings.append(ring)
				faces = [tuple(rings[0][i] for i in (0, 1, 3, 2)), tuple(rings[-1][i] for i in (0, 2, 3, 1))]
				for a, b in zip(rings, rings[1:]):
					for i, j in ((0, 1), (1, 3), (3, 2), (2, 0)):
						faces.append((a[i], a[j], b[j], b[i]))
				pieces.append((vertices, faces, [paint] * len(faces), [False] * len(faces)))
	# the rim: its disc `dish` in from the lip, the boss proud of the disc
	face, dish, boss = half * 0.86, p.get("dish", 0.1), p.get("hub", 0.3) / 2
	rim_paint = p.get("paint_rim", "white")
	pieces.append(spun(c, n, [(face - dish + 0.06, 0), (face - dish + 0.06, boss * 0.6), (face - dish, boss), (face - dish, boss * 1.9),
		(face, rim - 0.015), (face - 0.025, rim + 0.02), (-face, rim + 0.02), (-face, 0)], segments, rim_paint))
	bolts = p.get("bolts")
	if bolts:
		nut = boss * 0.14
		for k in range(bolts):
			a = 2 * math.pi * (k + 0.5) / bolts
			foot = c + n * (face - dish) + (u * math.cos(a) + w * math.sin(a)) * boss * 1.4
			pieces.append(spun(foot, n, [(0, nut), (nut * 1.5, nut), (nut * 1.5, 0)], 6, rim_paint))
	return merge_smooth(pieces)


def outward(piece):
	# Each closed solid in a piece wound outward: its faces grouped by the
	# vertices they share, and a group enclosing a negative volume turned
	# over. A vehicle's parts touch one another, and welded together where
	# they meet they make solids that are not closed, which tidy() leaves as
	# built (a box from shape() inward, a reflected part inside out)
	vertices, faces = piece[0], piece[1]
	parent = list(range(len(vertices)))

	def root(i):
		while parent[i] != i:
			parent[i] = parent[parent[i]]
			i = parent[i]
		return i

	for f in faces:
		for i in f[1:]:
			parent[root(i)] = root(f[0])
	# each group's volume measured from one of its own vertices, in double
	# precision: from the ship's origin, in Blender's single-precision
	# vectors, the rounding of terms 80 m out swamped a small plate's
	# volume and turned good parts over at random
	volume, origin = {}, {}
	for f in faces:
		g = root(f[0])
		o = origin.setdefault(g, tuple(vertices[f[0]]))
		p = [tuple(c - d for c, d in zip(vertices[i], o)) for i in f]
		a = p[0]
		for b, c in zip(p[1:], p[2:]):
			volume[g] = volume.get(g, 0.0) + a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])
	faces = [tuple(reversed(f)) if volume[root(f[0])] < 0 else tuple(f) for f in faces]
	return (vertices, faces) + tuple(piece[2:])


def merge_smooth(pieces):
	# merge() keeping each face's smooth mark (False for a piece without any)
	vertices, faces, paints = merge(pieces)
	smooth = [s for piece in pieces for s in (piece[3] if len(piece) > 3 else [False] * len(piece[1]))]
	return vertices, faces, paints, smooth


def standing(p):
	# Where a parked vehicle stands (layout.vehicles.parked): its kind's own
	# frame (x forward from the middle of its footprint, y up from the deck, z
	# to starboard) carried to its place on the deck and turned to its heading,
	# positive to port
	x, z = p["at"]
	return Matrix.Translation(at(x, p.get("deck", LAYOUT["deck"]["height"]), z)) @ Matrix.Rotation(math.radians(p["heading"]), 4, "Z")


def footprint(p):
	# A parked vehicle as the server collides with it: its kind's footprint,
	# `size` [length, height, width] about its middle, turned to its heading
	# (positive to port) and carried to its place, and its top
	length, height, width = LAYOUT["vehicles"]["kinds"][p["kind"]]["size"]
	x, z = p["at"]
	a = math.radians(p["heading"])
	corners = [(u * length / 2, w * width / 2) for u, w in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
	outline = [[round(x + u * math.cos(a) + w * math.sin(a), 3), round(z - u * math.sin(a) + w * math.cos(a), 3)] for u, w in corners]
	return {"kind": p["kind"], "outline": outline, "top": round(p.get("deck", LAYOUT["deck"]["height"]) + height, 3)}


def vehicles():
	# The deck's vehicles (layout.vehicles; decision 16 as amended): each
	# parked one its kind's parts, carried to where it stands, all in one
	# node, which the engine leaves out of what it measures from the model
	v = LAYOUT.get("vehicles")
	if not v or not v.get("parked"):
		return
	# a part marked `mirror` stands on both sides: as given, and reflected
	# across the vehicle's middle (its z)
	reflect = Matrix.Scale(-1, 4, (0, 1, 0))
	pieces = []
	for p in v["parked"]:
		frame = standing(p)
		for part in v["kinds"][p["kind"]]["parts"]:
			pieces.append(outward(shape(part, frame)))
			if part.get("mirror"):
				pieces.append(outward(shape(part, frame @ reflect)))
	vertices, faces, paints, smooth = merge_smooth(pieces)
	node("vehicles", mesh=(vertices, faces, paints), smooth=smooth)


def single_layers():
	# One UV layer a mesh: where a mesh carries the weathering's atlas and
	# another layer (the deck's paint on an elevator's top or a deflector's
	# face, the lettering on the island's faces), the other is dropped, so
	# every material reads the first UV set. The engine puts each material's
	# images back by name on that set (engine.ts carrier_images), so a
	# material reading a second set showed the wrong part of its image. The
	# atlas layer began as a copy of the other (weathered() makes it from
	# the active layer) and the bake moves only its groups' faces, so the
	# other faces already hold their own mapping in it
	for o in bpy.data.objects:
		if o.type != "MESH" or "atlas" not in o.data.uv_layers or len(o.data.uv_layers) < 2:
			continue
		others = [layer.name for layer in o.data.uv_layers if layer.name != "atlas"]
		if len(others) != 1:
			raise RuntimeError(f"{o.name}: the atlas and {others}: which layer each face reads is not known")
		o.data.uv_layers.remove(o.data.uv_layers[others[0]])
		atlas = o.data.uv_layers["atlas"]
		o.data.uv_layers.active = atlas
		atlas.active_render = True


def posed(names):
	# Each named joint, and every joint that follows it, turned to the end of
	# its keys (a deflector raised, its crank and rod at the panel's angle);
	# returns what puts them back. A joint's axis is the exported frame's,
	# its node's parent's frame at rest; a follower's keys take its leader's
	# value as their input
	kept = []
	for name, j in JOINTS.items():
		leader = name if name in names else j.get("follows")
		if leader not in names:
			continue
		if j["motion"] != "rotate":
			raise ValueError(f"{name}: only a turning joint is posed for the bake")
		value = JOINTS[leader]["keys"][-1][1]
		if name != leader:
			xs, ys = zip(*j["keys"])
			value = interpolate(value, xs, ys)
		gx, gy, gz = j["axis"]
		o = NODES[name]
		kept.append((o, o.rotation_mode, tuple(o.rotation_axis_angle)))
		o.rotation_mode = "AXIS_ANGLE"
		o.rotation_axis_angle = (value, gx, -gz, gy)   # the exported frame's (x, z, -y) back to Blender's
	bpy.context.view_layer.update()

	def undo():
		for o, mode, angle in kept:
			o.rotation_axis_angle = angle
			o.rotation_mode = mode
		bpy.context.view_layer.update()
	return undo


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


def earcut(points):
	# Triangles (as positions in the list) filling a simple polygon given as
	# 2D points in order, each wound as the polygon runs. Consecutive points
	# that coincide (two rings' knuckles a centimetre apart, seen along the
	# ship) are one corner, the second joined in by a sliver triangle so every
	# edge of the polygon is an edge of a triangle
	same = lambda p, q: abs(p[0] - q[0]) < 1e-6 and abs(p[1] - q[1]) < 1e-6
	slots = []
	for k, p in enumerate(points):
		if slots and same(points[slots[-1][-1]], p):
			slots[-1].append(k)
		else:
			slots.append([k])
	if len(slots) > 1 and same(points[slots[-1][-1]], points[slots[0][0]]):
		slots[0] = slots.pop() + slots[0]
	triangles = []
	for k, slot in enumerate(slots):
		after = slots[(k + 1) % len(slots)][0]
		triangles += [(slot[t], slot[t + 1], after) for t in range(len(slot) - 1)]
	corners = [slot[0] for slot in slots]
	if len(corners) < 3:
		# no area: a fan, which still carries every edge
		return triangles + [(corners[0], corners[t], corners[t + 1]) for t in range(1, len(corners) - 1)]
	cross = lambda a, b, c: (points[b][0] - points[a][0]) * (points[c][1] - points[a][1]) - (points[b][1] - points[a][1]) * (points[c][0] - points[a][0])
	turn = 1 if sum(points[a][0] * points[b][1] - points[b][0] * points[a][1] for a, b in zip(corners, corners[1:] + corners[:1])) >= 0 else -1

	def inside(q, a, b, c):
		return all(turn * cross(u, v, q) >= -1e-12 for u, v in ((a, b), (b, c), (c, a)))

	while len(corners) > 3:
		best = None
		for k in range(len(corners)):
			a, b, c = corners[k - 1], corners[k], corners[(k + 1) % len(corners)]
			bend = turn * cross(a, b, c)
			if bend > 1e-12 and not any(inside(q, a, b, c) for q in corners if q not in (a, b, c) and not any(same(points[q], points[r]) for r in (a, b, c))):
				best = k
				break
			if best is None or bend > turn * cross(corners[best - 1], corners[best], corners[(best + 1) % len(corners)]):
				best = k   # none clean yet: the most convex corner, should none be found
		triangles.append((corners[best - 1], corners[best], corners[(best + 1) % len(corners)]))
		corners.pop(best)
	return triangles + [tuple(corners)]


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
	# both ends. Under a deck-edge elevator (its well, well()) the section
	# runs out along the flare only as far as the well's wall, which stands on
	# the flare there and rises to the deck's underside: along the rails the
	# hull side, at the well's ends walls parallel to the platform's ends.
	# Below the knuckle the hull is symmetric: its half-breadth at a height is
	# read off the stations either side (the transom the first of them; under
	# water each at the same share of its own depth, half()), and ahead of the
	# last it narrows to the stem; the keel runs a monotone cubic through the
	# stations' keels. The flare is flat between its
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
	rounding_down = round_down(d)
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

	def keel(x):
		# the stations' keel line, a monotone cubic through their keels, so
		# where it rises aft it bends smoothly rather than kinking at each
		return monotone(x, sx, keels)

	def low(x):
		# the hull's lowest point at x: the stations' keel, or the stem once
		# it has risen above it
		rising = sorted(stem)
		return max(keel(x), interpolate(x, [p[0] for p in rising], [p[1] for p in rising]) if x > rising[0][0] else -1e9)

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
	fade = h.get("fade", 0.0)

	def rounding(y):
		# the radius the stem's front turns into the sides at a height (in
		# plan, hull.fillet, or its whole half-width where that is less); the
		# face above keeps its creases, the rounding easing out (smoothstep)
		# over hull.fade below the face's bottom edge, so the stem's corners
		# come to the face's creases with no step
		face = h.get("face")
		if face and y >= face["bottom"][0]:
			return 0.0
		radius = min(fillet, crease(y))
		if face and fade > 0:
			t = max(0.0, min(1.0, (face["bottom"][0] - y) / fade))
			radius *= t * t * (3 - 2 * t)
		return radius

	def half(x, y, power=1.0):
		# below the waterline each station is read as far into its own depth
		# as the height is into the hull's here: a height a share of the way
		# from the keel line up to the waterline reads every station that
		# share of the way up from its own keel. Where the keel rises aft (2-3
		# m a station) the flat bottom and the turn of the bilge then run on
		# between stations, where read at one height one station's keel strip
		# met the next one's bilge; with the keels level it is the height
		# itself. Above the waterline, the height
		bottom = keel(x)
		share = max(0.0, (y - bottom) / -bottom) if y < 0 and bottom < 0 else None
		reads = [y if share is None else k * (1 - share) for k in keels]
		values = [interpolate(r, [p[0] for p in s["points"]], [p[1] for p in s["points"]]) for r, s in zip(reads, stations)]
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
	# the measured profiles (hull.profiles: on each side, stretches of
	# sections as a quarter's, the side stepping out of the flare along them,
	# each ending square), as quarters along their own stretches
	profiles = {name: [sorted(q, key=lambda s: s["x"]) for q in stretches] for name, stretches in h.get("profiles", {}).items()}
	# the elevators' wells (well()), each side's plans
	wells = {"port": [], "starboard": []}
	for e in LAYOUT.get("elevators", []):
		plan = well(e)
		if plan:
			name = side_name(e)
			wells[name].append(plan)
			assert all(not plan[0][0] <= p[0] <= plan[-1][0] for c in flare.get(name, []) for p in c), "a well clear of the flare's creases"

	def inner(x, side):
		# the |z| of a well's wall over x on a side: along the rails, or on
		# either end between them and the deck's edge; None outside every well
		for (x0, z0), (x1, z1), (x2, z2), (x3, z3) in wells["starboard" if side > 0 else "port"]:
			if x1 <= x <= x2:
				return z1
			if x0 <= x < x1:
				return z0 + (z1 - z0) * (x - x0) / (x1 - x0)
			if x2 < x <= x3:
				return z2 + (z3 - z2) * (x - x2) / (x3 - x2)
		return None
	# every ring carries as many points between its knuckle and its foot as
	# the longest quarter's or profile's section has (a shorter one's last
	# point repeated); outside them they sit on the knuckle, where tidy()
	# welds them away
	stretches = {name: ([quarters[name]] if quarters.get(name) else []) + profiles.get(name, []) for name in ("port", "starboard")}
	K = max([len(s["points"]) for q in stretches.values() for stretch in q for s in stretch], default=0)
	# and at least one where a crease runs (its point; creased())
	K = max(K, 1 if any(h.get("crease", {}).values()) else 0)
	for name, q in stretches.items():
		creases = [p[0] for c in flare.get(name, []) for p in (c[0], c[-1])]
		for stretch in q:
			assert stretch[0]["x"] - 0.01 > transom, "a quarter ends forward of the transom"
			assert not creases or stretch[-1]["x"] + 0.01 < min(creases) or stretch[0]["x"] - 0.01 > max(creases), "a quarter clear of the flare's creases"
		for stretch in profiles.get(name, []):
			assert all(stretch[-1]["x"] + 0.01 < plan[0][0] or stretch[0]["x"] - 0.01 > plan[-1][0] for plan in wells[name]), "a profile clear of the wells"
		spans = sorted((stretch[0]["x"], stretch[-1]["x"]) for stretch in q)
		assert all(a[1] + 0.02 < b[0] for a, b in zip(spans, spans[1:])), "the profiles apart"
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
			assert all(stretch[-1]["x"] < start for stretch in stretches[name]), "the shoulders clear of the quarters and profiles"
			assert all(plan[-1][0] < start for plan in wells[name]), "the shoulders clear of the wells"
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
		# a quarter's or a profile's section at x (hull.quarters: its points
		# out from the knuckle to where it meets its wall's foot or its
		# sponson's bottom; hull.profiles: out from the knuckle to where its
		# plating runs on to the gallery's foot; as [y, |z|], a short section's
		# last point repeated to K), straight between its measured sections,
		# and whether it is a profile's; (None, False) outside them
		name = "starboard" if side > 0 else "port"
		for q in stretches[name]:
			if q[0]["x"] <= x <= q[-1]["x"]:
				along = [s["x"] for s in q]
				points = [s["points"] + [s["points"][-1]] * (K - len(s["points"])) for s in q]
				section = [(interpolate(x, along, [p[k][0] for p in points]), abs(interpolate(x, along, [p[k][1] for p in points]))) for k in range(K)]
				return section, any(q is stretch for stretch in profiles.get(name, []))
		return None, False

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
		# and a centimetre past each wall's ends, so it ends square: from under
		# the port aft sponson the hull steps out to the quarter's wall at the
		# sponson's end, which a strip to the next section twisted across
		turns |= {w["wall"][0][0] - 0.01 for w in walls.get(name, [])} | {w["wall"][-1][0] + 0.01 for w in walls.get(name, [])}
		turns |= {c[e][0] for c in flare.get(name, []) for e in (0, -1)}
		if h.get("crease", {}).get(name):
			turns |= set(h["crease"][name]["x"])
		# and at each of a quarter's sections, with a section a centimetre past
		# either end, so it ends square: a face across the ship from its section
		# to the hull's either side of it
		for q in stretches[name]:
			turns |= {s["x"] for s in q} | {q[0]["x"] - 0.01, q[-1]["x"] + 0.01}
		# and at each corner of a well's plan, with a section a centimetre past
		# an end that stands square across the ship, so it ends square there
		for (x0, _), (x1, _), (x2, _), (x3, _) in wells[name]:
			turns |= {x0, x1, x2, x3}
			if x1 - x0 < 0.01:
				turns.add(x1 - 0.01)
			if x3 - x2 < 0.01:
				turns.add(x2 + 0.01)
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
			# and, where the rounding eases out under the face, at the front and
			# the rounding's quarter-angles at each quarter of the fade, so it
			# narrows smoothly
			if h.get("face") and fade > 0:
				for j in range(5):
					y = h["face"]["bottom"][0] - fade * j / 4
					turns |= {ahead(y) - rounding(y) * (1 - math.cos(math.pi / 8 * k)) for k in range(5)}
	for v in h.get("face", {}).get("vents", []):
		# and a section 10 cm above and below each vent on the face, so one
		# flat strip of it holds the vent (a section crosses the raked face at
		# one height, and the strips beside run off its plane to the hull's
		# lower sections)
		(fy0, _), (fy1, _) = h["face"]["bottom"], h["face"]["top"]
		slope = (ahead(fy1) - ahead(fy0)) / (fy1 - fy0)
		rise = v["height"] / 2 / math.sqrt(1 + slope * slope) + 0.1
		turns |= {ahead(v["y"] - rise), ahead(v["y"] + rise)}
	turns = [x for x in turns if transom + 0.4 < x < bow - 0.4]
	count = max(2, int((bow - transom) / STEP) + 1)
	grid = [transom + (bow - transom) * k / (count - 1) for k in range(count)]
	xs = sorted(set([x for x in grid if all(abs(x - t) > 0.4 for t in turns)] + turns + [transom, bow]))

	def creased(x, side, ky, kz, foot):
		# the crease's point (height, |z|) over the flare at x on a side
		# (hull.crease), or None where none runs
		c = h.get("crease", {}).get("starboard" if side > 0 else "port")
		if not c or not c["x"][0] <= x <= c["x"][1] or not ky < c["height"] < foot:
			return None
		if c.get("hold") is not None and x < c["hold"]:
			# aft of `hold` the bend keeps the |z| it has there, the plating
			# straight from the knuckle up to it: under the island the
			# plating stands as far out as at the slots forward of it, where
			# the knuckle line narrows aft
			hy = min(knuckle(c["hold"], side)[0], under - gallery(c["hold"], side))
			return (c["height"], half(c["hold"], hy) + c["slope"] * (c["height"] - hy))
		return (c["height"], kz + c["slope"] * (c["height"] - ky))

	# the rings below the boot top: under the waterline at these shares of
	# the depth from the keel up to it, closest where the bilge turns (a
	# tenth of the way up at every station, half()), a ring on the waterline,
	# and two more to the boot top; above it UPPER more to the knuckle
	SHARES, UPPER = (0.0, 0.04, 0.1, 0.18, 0.3, 0.5, 0.75, 1.0), 8
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
		w = min(0.0, b)
		if y0 < w:
			heights = [y0 + (w - y0) * s for s in SHARES] + [w + (b - w) * (j + 1) / 2 for j in range(2)]
		else:
			heights = [y0 + (b - y0) * j / (len(SHARES) + 1) for j in range(len(SHARES) + 2)]
		heights += [b + (lower - b) * (j + 1) / UPPER for j in range(UPPER)]
		sides = {}
		for side in (-1, 1):
			ky, kz = knuckles[side]
			points = [(y, half(x, y)) for y in heights] + [(ky, kz)]
			standing = wall(x, side)
			section, profiled = quarter(x, side)
			recess = inner(x, side)
			if standing:
				# a wall: out from the knuckle (along a quarter's section) to its
				# foot and up it to the deck's underside, the deck overhanging any
				# inboard of its edge
				z, foot = standing
				points += section or [(ky, kz)] * K
				points += [points[-1]] * J + [(max(foot, ky), z), (under, z)]
			elif section and profiled:
				# a profile: along its section, then on to the gallery's foot at
				# the deck's edge as the flare reaches it, and up to the deck
				z = abs(edge(outlines, x, side))
				foot = max(feet[side], ky)
				points += section + [section[-1]] * J + [(foot, z), (under, z)]
			elif section:
				# a quarter under a sponson: along its section, then in or out to
				# the sponson's bottom at its inboard edge (the deck's edge at the
				# section's last point's height where none stands over it), and up
				# to the deck's edge
				z = abs(edge(outlines, x, side))
				reach = inboard(x, side)
				points += section + [section[-1]] * J + [(section[-1][0], z) if reach is None else (reach[1], reach[0]), (under, z)]
			elif recess is not None:
				# a well: the flare from the knuckle as far as the well's wall,
				# which stands on it there and rises to the deck's underside, the
				# platform over it; a wall inboard of the knuckle rising from it.
				# Over a crease the flare is the creased one, the wall standing on
				# whichever of its two strips reaches it
				z = abs(edge(outlines, x, side))
				foot = max(feet[side], ky)
				bend = creased(x, side, ky, kz, foot)
				if bend and bend[1] < recess:
					share = 0.0 if z <= bend[1] else min(1.0, (recess - bend[1]) / (z - bend[1]))
					points += [bend] * (K + J) + [(bend[0] + (foot - bend[0]) * share, recess), (under, recess)]
				elif bend and recess > kz:
					# the wall standing on the lower strip, the crease's points with
					# its foot, so they run on from the bend where the wall meets it
					wall_foot = (ky + (bend[0] - ky) * (recess - kz) / (bend[1] - kz), recess)
					points += [wall_foot] * (K + J) + [wall_foot, (under, recess)]
				else:
					share = 0.0 if recess <= kz or z <= kz else min(1.0, (recess - kz) / (z - kz))
					points += [(ky, kz)] * (K + J) + [(ky + (foot - ky) * share, recess), (under, recess)]
			else:
				# the flare: straight from the knuckle to the gallery's foot, or
				# over the bow's shoulders, or over a crease (hull.crease: on a
				# side from x to x, the plating rising from the knuckle at
				# `slope`, |z| per metre up, to `height`, the deck edge's
				# overhang running out from there to the gallery's foot)
				z = abs(edge(outlines, x, side))
				foot = max(feet[side], ky)
				bend = creased(x, side, ky, kz, foot)
				if bend:
					points += [bend] * (K + J)
				else:
					points += [(ky, kz)] * K + (shoulder(x, ky, kz, foot, z) if shoulders and x >= start - 1e-9 else [(ky, kz)] * J)
				points += [(foot, z), (under, z)]
			# where the side comes up to the deck's edge under the round-down,
			# whose fascia hangs below the underside there, its top drawn in by
			# as much of the fascia's thickness as the round-down's share: up to
			# the edge, it lay in the fascia's face for the depth buffer to draw
			# through it
			top, z = points[-1]
			if rounding_down and top == under and abs(z - abs(edge(outlines, x, side))) < 1e-6 and rounding_down["foot"](x, side * z) < under - 1e-6:
				points[-1] = (under, z - FASCIA * rounding_down["share"](x, side * z))
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
	# where two rings stand a centimetre or so apart (a quarter's or a
	# profile's square end, a well's, a step in the deck's edge), the strip
	# between them is a face across the ship from one section to the other.
	# Where the two cross (a stretch out of the flare below and inside it
	# above: the waist box's face), its quads, fanned from the knuckle, fold
	# over one another and leave a fin standing out of the hull. There the
	# region between the sections is split at each crossing into lobes, each
	# filled by itself and wound as the strip's quads are (one lobe's face
	# out of the stretch, the next's into it), and each crossing is a corner
	# of both rings, the strips either side taking it in
	sections = {-1: (0, K + J + 2), 1: (2 * S - K - J - 2, 2 * S)}   # each side's run of a ring from its knuckle to the deck
	flat = lambda q: (vertices[q].y, vertices[q].z)
	along = {}       # ring -> [(place along the ring as a column, vertex)] for each crossing on it
	lobes = []       # (ring pair, first column, last column, crossings as ((place, vertex) on the first ring, on the second))
	for i in range(len(rings) - 1):
		if xs[i + 1] - xs[i] > 0.05:
			continue
		for side, (lo, hi) in sections.items():
			# two sections that never part by 2 cm make no face worth the name
			apart = [math.dist(flat(i * n + j), flat((i + 1) * n + j)) for j in range(lo, hi + 1)]
			if max(apart) < 0.02:
				continue
			# where they cross: a millimetre or more clear of every segment's
			# ends (a touch at a corner both share is no crossing)
			found = []
			for t in range(lo, hi):
				p, q = flat(i * n + t), flat(i * n + t + 1)
				lp = math.dist(p, q)
				if lp < 1e-9:
					continue
				for u in range(lo, hi):
					r, w = flat((i + 1) * n + u), flat((i + 1) * n + u + 1)
					lr = math.dist(r, w)
					d = (q[0] - p[0]) * (w[1] - r[1]) - (q[1] - p[1]) * (w[0] - r[0])
					if lr < 1e-9 or abs(d) < 1e-12:
						continue
					s = ((r[0] - p[0]) * (w[1] - r[1]) - (r[1] - p[1]) * (w[0] - r[0])) / d
					v = ((r[0] - p[0]) * (q[1] - p[1]) - (r[1] - p[1]) * (q[0] - p[0])) / d
					if 1e-3 < s * lp < lp - 1e-3 and 1e-3 < v * lr < lr - 1e-3:
						found.append((t + s, u + v))
			found.sort()
			assert [b for a, b in found] == sorted(b for a, b in found), f"the sections at x {xs[i]:.2f} cross out of order"
			# the lobes run between the columns either side where the two
			# sections meet (the knuckle, the gallery's foot), or to the run's
			# end (the deck's underside, which the deck closes). Crossing or
			# not, the region is filled as one: where one section doubles back
			# (a quarter's out under its sponson's bottom and back in along it)
			# a quad between the two is not convex, and its triangles overlap
			# facing opposite ways
			met = [j for j in range(lo, hi + 1) if apart[j - lo] < 0.02]
			parted = [j for j in range(lo, hi + 1) if apart[j - lo] >= 0.02]
			first = max([j for j in met if j <= min([min(a, b) for a, b in found] + parted)], default=lo)
			last = min([j for j in met if j >= max([max(a, b) for a, b in found] + parted)], default=hi)
			crossings = []
			for a, b in found:
				pair = []
				for ring_index, place in ((i, a), (i + 1, b)):
					t = int(place)
					p, q = vertices[ring_index * n + t], vertices[ring_index * n + t + 1]
					vertices.append(p + (q - p) * (place - t))
					along.setdefault(ring_index, []).append((place, len(vertices) - 1))
					pair.append((place, len(vertices) - 1))
				crossings.append(tuple(pair))
			lobes.append((i, first, last, crossings))

	def run(r, start, end):
		# the vertices along ring r from place `start` to `end` (columns, and
		# the crossings on it between), in that direction, ends excluded
		points = [(float(j), r * n + j) for j in range(int(math.floor(min(start, end))), int(math.ceil(max(start, end))) + 1)]
		points += along.get(r, [])
		points = sorted((p for p in points if min(start, end) + 1e-9 < p[0] < max(start, end) - 1e-9), reverse=end < start)
		return [q for _, q in points]

	replaced = set()
	for i, first, last, crossings in lobes:
		replaced |= {(i, j) for j in range(first, last)}
		ends = [((first, i * n + first), (first, (i + 1) * n + first))] + crossings + [((last, i * n + last), (last, (i + 1) * n + last))]
		for (a0, b0), (a1, b1) in zip(ends, ends[1:]):
			# the lobe as the strip's quads run, ring i back and ring i + 1 on
			polygon = [b0[1]] + run(i + 1, b0[0], b1[0]) + [b1[1], a1[1]] + run(i, a1[0], a0[0]) + [a0[1]]
			for t in earcut([flat(q) for q in polygon]):
				faces.append(tuple(polygon[k] for k in t))
				paints.append(paint(faces[-1]))
				smooth.append(False)

	for i in range(len(rings) - 1):
		for j in range(n - 1):
			if (i, j) in replaced:
				continue
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
			# with any crossing on its edges (a lobe's beside it) a corner
			faces.append(tuple([a, a + n] + run(i + 1, j, j + 1) + [b + n, b] + run(i, j + 1, j)))
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
	if foul > -1e8:
		# the anti-fouling's edge cut along its top, level, and everything
		# under it red: the rings stand at shares of the hull's depth, so its
		# top is no ring's height
		obj = NODES["hull"]
		bm = bmesh.new()
		bm.from_mesh(obj.data)
		level = at(0, foul, 0).z - HINGES["hull"].z
		bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], dist=1e-6, plane_co=(0, 0, level), plane_no=(0, 0, 1))
		names = [m.name for m in obj.data.materials]
		if "antifouling" not in names:
			obj.data.materials.append(material("antifouling"))
			names.append("antifouling")
		red = names.index("antifouling")
		for f in bm.faces:
			if f.material_index != red and names[f.material_index] == "boot" and max(v.co.z for v in f.verts) <= level + 1e-6:
				f.material_index = red
		bm.to_mesh(obj.data)
		bm.free()
	holes = []   # openings pierced in the hull's flat faces once its parts are made (pierce())
	blisters = []
	for b in h.get("blisters", []):
		# a blister on the hull side (hull.blisters): its outline seen from
		# the side, rounded at each end or square, standing `depth` out from
		# the side and running on into it, so it follows the side's curve; a
		# square one's `ribs` upright on its face, `width` wide standing
		# `depth` out every `pitch`, as many as fit, centred along it, each
		# stopping SHORT of its top and bottom: sunk into its face,
		# a rib's ends lay in the blister's top and bottom for the depth
		# buffer to draw through each other
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
		ribs = b.get("ribs")
		if ribs and b.get("ends") != "round":
			n = int((x1 - x0) / ribs["pitch"])
			# the face between its corners, as its quad lies
			face = lambda x, y: half(x0, y) + b["depth"] + (half(x1, y) - half(x0, y)) * (x - x0) / (x1 - x0)
			for k in range(n):
				x = (x0 + x1) / 2 + (k - (n - 1) / 2) * ribs["pitch"]
				rib = [at(x + dx, y, side * (face(x + dx, y) + out)) for y in (y0 + SHORT, y1 - SHORT) for dx, out in ((-ribs["width"] / 2, -0.05), (ribs["width"] / 2, -0.05), (ribs["width"] / 2, ribs["depth"]), (-ribs["width"] / 2, ribs["depth"]))]
				blisters.append((rib, [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)], ["grey"] * 6))
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
		# its mooring openings (hull.face.chocks: each {y, z} on the face): a
		# cast rim (lip()) from `inner` to `outer` radius standing `thickness`
		# out of it at its crown, in its `paint`, and its throat cut `depth`
		# into the bow (carved below), its walls the plating's grey for the
		# weathering's occlusion to shade, its back dark (the ship's inside
		# beyond it): the bullnose on the centreline and a
		# chock either side, a landmark at each one's centre where it gives a
		# `mark` (the bullnose fixes the bow's photos sideways, as nothing else
		# near the bow does from ahead)
		(y0, _), (y1, _) = h["face"]["bottom"], h["face"]["top"]
		normal = Vector((y1 - y0, -(ahead(y1) - ahead(y0)), 0)).normalized()   # out of the face, forward and down
		across = normal.cross(Vector((0, 1, 0))).normalized()
		up = normal.cross(across)
		chocks = []
		for c in h["face"].get("chocks", []):
			centre = Vector((ahead(c["y"]), c["y"], c["z"]))
			chocks.append(lip(list(centre), list(normal), c["outer"], c["inner"], c["thickness"], c.get("paint", "white")))
			ia, ib = (c["inner"], c["inner"]) if isinstance(c["inner"], (int, float)) else c["inner"]
			throat = [centre + across * math.cos(2 * math.pi * k / 32) * ia + up * math.sin(2 * math.pi * k / 32) * ib for k in range(32)]
			holes.append({"name": "chock", "outline": [list(q) for q in throat], "normal": list(normal), "depth": c["depth"], "paint": "grey", "back": "dark"})
			if "mark" in c:
				MARKS[c["mark"]] = (at(*centre), "chocks")
		if chocks:
			# cast, so shaded smooth (sharp only where the rim runs into the face)
			node("chocks", mesh=merge(chocks), smooth=True)
		# its vents (hull.face.vents: each {y, z} on the face, `width` across and
		# `height` up the face, its corners rounded at `radius`): a hole cut
		# `depth` into the bow, its walls the plating's grey and its back dark,
		# and across its mouth a grille `inset` behind the face, a bar down its
		# middle and `bars` across, `size` thick, each bowed `bow` out of the
		# face at its middle, in the chocks' paint (the node `vents`)
		grilles = []
		for v in h["face"].get("vents", []):
			centre = Vector((ahead(v["y"]), v["y"], v["z"]))
			w, t2 = v["width"] / 2, v["height"] / 2
			corners = [centre + across * a + up * b for a, b in ((-w, -t2), (w, -t2), (w, t2), (-w, t2))]
			outline = rounded([list(q) for q in corners], v["radius"], steps=4)
			# cut before the chocks' throats, from the face's own plating (a
			# region round it that took in a throat's refilled faces would
			# pinch at a vertex)
			holes.insert(0, {"name": "vent", "outline": outline, "normal": list(normal), "depth": v["depth"], "paint": "grey", "back": "dark"})
			g = v["grille"]
			mid = centre - normal * g["inset"]
			grilles.append(bar(list(mid - up * t2), list(mid + up * t2), g["size"], g.get("paint", "chock")))
			for k in range(1, g["bars"] + 1):
				level = mid + up * (-t2 + 2 * t2 * k / (g["bars"] + 1))
				# a parabola from the hole's sides out to `bow` at its middle
				path = [level + across * (w * t) + normal * (g.get("bow", 0.0) * (1 - t * t)) for t in (-1, -0.5, 0, 0.5, 1)]
				grilles += [bar(list(a), list(b), g["size"], g.get("paint", "chock")) for a, b in zip(path, path[1:])]
		if grilles:
			node("vents", mesh=merge(grilles))
	# the open decks in the sides (hull.decks: each an `outline` [[x, y], ...]
	# on the face whose plan line is `face` [[x, |z|], [x, |z|]], cut `depth`
	# in square to it), and each deck-edge elevator's hangar doorway on its
	# well's wall (well.opening: its outline on the wall with its corners'
	# radius, `depth` through the wall, and the hangar behind it as a room
	# `room.depth` deep, `room.beyond` past the doorway's ends and
	# `room.above` over its head): rooms cut from the hull, their walls,
	# floors and a deck's back the plating's grey (or a deck's own `back`),
	# for the weathering's occlusion to shade, and a doorway's back the
	# hangar's dark: the doorway a hole through the side's plating, `depth`
	# its thickness, and behind it a rectangular room, so the space runs on
	# behind the hole's rounded corners, its floor its own `floor` (the
	# hangar deck's dark), `beams` under its ceiling (`count` of them `width`
	# wide and `depth` deep). A doorway with a `door` has it shut as the
	# room's back: the room's outline cut square `gap` [aft, forward] short of
	# its ends, in two equal leaves with a `seam` between them, through which
	# and past whose ends the hangar's dark shows, a pocket a metre deep (the
	# hull's, pierce()'s room pieces: nothing behind a leaf); a fitting on the
	# seam (`fitting`: its `height` over the sill and `size` along, up and
	# out, in its `paint`; the node `doors`). Marked for
	# the photo match: the fitting's face and the doorway's forward end at
	# mid-height. Each well's rails (rails()) and its sill's curb, posts and
	# comb (sill()) are the node `wells`
	doors, fittings = [], []
	for d in h.get("decks", []):
		side = 1 if d["side"] == "starboard" else -1
		(ax, az), (bx, bz) = d["face"]
		dx, dz = bx - ax, bz - az
		n = Vector((dz, 0, -dx)).normalized()
		n = n if n.z * side > 0 else -n
		on = lambda x, y: [x, y, side * (az + dz * (x - ax) / dx)]
		holes.append({"name": d["name"], "outline": [on(x, y) for x, y in d["outline"]], "normal": list(n), "depth": d["depth"], "paint": "grey",
			"floor": "grey", "back": d.get("back", "grey")})
	for e in LAYOUT.get("elevators", []):
		w = e.get("well")
		if not w:
			continue
		side = 1 if side_name(e) == "starboard" else -1
		z = well(e)[1][1] * side
		outward = (at(0, 0, side) - at(0, 0, 0)).normalized()
		along = at(1, 0, 0) - at(0, 0, 0)
		if w.get("rail"):
			fittings += rails(w["rails"], z, side, w["rail"], LAYOUT["deck"]["height"] - e["thickness"])
		o = w.get("opening")
		if not o:
			continue
		(x0, x1), (y0, y1) = o["x"], o["y"]
		r = o["room"]
		doorway = rounded([[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]], o.get("radius", 0.0), steps=8)
		# the room's floor 5 cm under the doorway's sill, so the doorway is a
		# hole in its wall, clear of its edge
		rx0, rx1, ry0, ry1 = x0 - r["beyond"], x1 + r["beyond"], y0 - 0.05, y1 + r["above"]
		room = [[rx0, ry0, z], [rx1, ry0, z], [rx1, ry1, z], [rx0, ry1, z]]
		shut = o.get("door")
		hole = {"name": f"hangar_{e['number']}", "outline": doorway, "normal": [0, 0, side], "depth": o["depth"], "paint": "grey", "floor": "grey",
			"back": "dark", "room": {"outline": room, "depth": r["depth"], "floor": r.get("floor", "grey")}}
		if shut:
			# the door the room's back: its leaves grey panels, and through
			# the seam between them and past their ends the hangar's dark, a
			# pocket a metre deep; the room's outline cornered where they meet
			aft, forward = shut["gap"]
			middle = (rx0 + aft + rx1 - forward) / 2
			leaves = ((rx0 + aft, middle - shut["seam"] / 2), (middle + shut["seam"] / 2, rx1 - forward))
			spans = [(a, b, "pocket") for a, b in ((rx0, leaves[0][0]), (leaves[0][1], leaves[1][0]), (leaves[1][1], rx1))] + [(a, b, "leaf") for a, b in leaves]
			spans = sorted((a, b, kind) for a, b, kind in spans if b - a > 1e-6)
			cuts = sorted({x for a, b, _ in spans for x in (a, b)} - {rx0, rx1})
			hole["room"]["outline"] = [[rx0, ry0, z]] + [[x, ry0, z] for x in cuts] + [[rx1, ry0, z], [rx1, ry1, z]] + [[x, ry1, z] for x in cuts[::-1]] + [[rx0, ry1, z]]
			hole["room"]["pieces"] = [dict({"outline": [[a, ry0, z], [b, ry0, z], [b, ry1, z], [a, ry1, z]]}, **({"paint": "grey"} if kind == "leaf" else {"pocket": 1.0, "paint": "dark"}))
				for a, b, kind in spans]
		holes.append(hole)
		beams = r.get("beams")
		if beams:
			# under the room's ceiling, its length, evenly through its depth
			span = (rx0, rx1)
			for k in range(1, beams["count"] + 1):
				at_depth = o["depth"] + r["depth"] * k / (beams["count"] + 1)
				fittings.append(box(at((span[0] + span[1]) / 2, ry1 - beams["depth"], z - side * at_depth), along, outward, span[1] - span[0], beams["width"], beams["depth"]))
		MARKS[f"doorway_{e['number']}_forward"] = (at(x1, (y0 + y1) / 2, z), "hull")
		fittings += sill(o.get("sill", {}), x0, x1, y0, z, side)
		if shut:
			plane = z - side * (o["depth"] + r["depth"])
			f = shut["fitting"]
			length, height, out = f["size"]
			doors.append(box(at(middle, y0 + f["height"] - height / 2, plane + side * out / 2), along, outward, length, out, height, f.get("paint", "white")))
			MARKS[f"door_{e['number']}_fitting"] = (at(middle, y0 + f["height"], plane + side * out), "doors")
	if holes:
		pierce(NODES["hull"], holes)
	if doors:
		node("doors", mesh=merge(doors))
	if fittings:
		node("wells", mesh=merge(fittings))
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
			y, z = quarter(x, side)[0][-1]
			MARKS[f"hull_quarter_{name}_knuckle"] = (at(x, ky, side * kz), "hull")
			MARKS[f"hull_quarter_{name}_knee"] = (at(x, y, side * z), "hull")
	front = ahead(0)
	entrance = math.degrees(math.atan2(half(front - 10, 0), 10))
	return {"draught": round(-min(keels), 3), "entrance": round(entrance, 2), "waterline": {"stern": round(waterline[0], 3), "stem": round(front, 3),
		"half": [[round(x, 2), round(half(x, 0), 3)] for x in waterline[:: max(1, len(waterline) // 30)]]}}


def collar(inner, outer, outward, proud, paint):
	# A frame between two rings of as many points (ship frame, in one plane,
	# the outer round the inner) standing `proud` out of it along `outward`:
	# its face, its outer edge and its inner edge, wound outward
	n = len(inner)
	assert len(outer) == n, "a collar's rings of as many points"
	out = Vector(outward).normalized()
	rise = out * proud
	ring = lambda r, up: [at(*(Vector(q) + (rise if up else Vector()))) for q in r]
	vertices = ring(inner, False) + ring(inner, True) + ring(outer, False) + ring(outer, True)
	I0, I1, O0, O1 = 0, n, 2 * n, 3 * n
	faces = []
	for k in range(n):
		j = (k + 1) % n
		faces += [(I1 + k, O1 + k, O1 + j, I1 + j), (O0 + k, O0 + j, O1 + j, O1 + k), (I0 + j, I0 + k, I1 + k, I1 + j)]
	# wound so the face looks out along `outward`
	f = faces[0]
	if (vertices[f[1]] - vertices[f[0]]).cross(vertices[f[2]] - vertices[f[1]]).dot(at(*out) - at(0, 0, 0)) < 0:
		faces = [tuple(reversed(f)) for f in faces]
	return vertices, faces, [paint] * len(faces)


def openings():
	# The small openings in the sides' plating the photos show (hull.openings,
	# layout.notes.openings), each at its measured place `at` [x, height] on
	# its `side` (starboard by default) of the node it is cut into (`node`,
	# the hull by default): the outermost plating there gives its plane, on
	# which its outline
	# is drawn `size` [along the ship, up the face] with its corners rounded at
	# `radius` (`round`, an ellipse of that size), the recess behind it cut
	# `depth` in (pierce()), its walls the plating's grey for the weathering's
	# occlusion to shade. By `kind`:
	#   vent: open, its back dark;
	#   window: glazed, its back the glass `depth` in, and round it a frame
	#     standing `frame` [width, proud] out of the plating;
	#   chock: a closed chock as the bow face's (lip() round the throat, the
	#     throat its size, cut `depth` in to a dark back), its rim `lip`
	#     [outer across, outer up, thickness] in the chocks' paint;
	#   recess: an opening whose outline is `outline` [[x, y], ...], each
	#     corner on the face at that position along the ship and height, cut
	#     level into the face `depth` deep (its floor flat), its back `back`
	#     (the plating's grey in its own shade unless given), with `rim`
	#     [width, proud] a frame round it as a window's, `railing` its
	#     height: a railing across its floor `inset` in from the face, and
	#     `ledge` [out, thickness]: a shelf out from its floor's front edge on
	#     `knees` brackets `drop` deep;
	#   placard: a plate 5 mm proud of the plating, `size` and `paint`.
	# Any opening's back may name its own paint (`back`).
	# The frames, lips and plates are the node `frames`; openings on one face
	# are cut together.
	#
	# Before them the boxes on the sides (hull.boxes, the node `boxes`): each
	# an upright face at |z| `face` on its `side` from x[0] (its aft end at
	# its foot; at its top `rake` where that end leans) to x[1], from `ledge`
	# [foot, top, proud] (a shelf under it standing `proud` out of the face),
	# or from `bottom` where it has none, up to `top`, built back into the
	# hull; where the flare runs outboard of
	# the face (above the height where they cross), the flare is cut away
	# level in to the face (a recess with its back open, the box's face
	# standing in it), clear of any well's wall beside it (and aft of `cut`
	# where the wall's slivers beside it would pinch the cut). Openings may then
	# be cut into a box's face (`node` boxes).
	#
	# With the boxes, the bays cut up to the deck edge (hull.notches,
	# notch()): each over `x` on its `side` from `from`, its back `depth` in
	# from the plating there. One over a box (`box`) starts a little under
	# where the flare passes in behind the box's face, and the box is built
	# back to the bay's back, so the box's top is the bay's floor and the
	# flare over it goes with the bay, not with a cut of its own
	import bmesh
	from mathutils.bvhtree import BVHTree
	h = LAYOUT.get("hull", {})
	trees, cuts, pieces = {}, {}, []
	ship = lambda v: Vector((v.x, v.z, -v.y))   # Blender's axes back to the ship's
	def tree(name):
		if name not in trees:
			bm = bmesh.new()
			bm.from_mesh(NODES[name].data)
			bm.transform(NODES[name].matrix_world)
			bm.faces.ensure_lookup_table()
			# each face's corners (ship frame) and normal, for the regions below
			trees[name] = (BVHTree.FromBMesh(bm), [([ship(v.co) for v in f.verts], ship(f.normal).normalized()) for f in bm.faces])
			bm.free()
		return trees[name]
	solids, recesses, lettering, frames_ = [], [], [], []
	notches = [dict(c, side=1 if c.get("side", "starboard") == "starboard" else -1) for c in h.get("notches", [])]
	over = {c["box"]: c for c in notches if c.get("box")}
	for b in h.get("boxes", []):
		side = 1 if b.get("side", "starboard") == "starboard" else -1
		(x0, x1), face = b["x"], b["face"]
		foot, shelf, proud = b["ledge"] if "ledge" in b else (b["bottom"], b["bottom"], 0.0)
		top = b["top"]
		lean = b.get("rake", x0)
		aft = lambda y: x0 + (lean - x0) * (y - foot) / (top - foot)
		# the flare's plane at the box's middle
		bvh, _ = tree("hull")
		middle = (x0 + x1) / 2
		hit, normal, index, distance = bvh.ray_cast(at(middle, (shelf + top) / 2, side * 80.0), at(0, 0, -side) - at(0, 0, 0))
		assert hit is not None, f"box {b['name']}: no hull there"
		q, n = ship(hit), ship(normal).normalized()
		if n.z * side < 0:
			n = -n
		flare = lambda x, y: abs(q.z - (n.x * (x - q.x) + n.y * (y - q.y)) / n.z)
		inside = flare(middle, foot) - 0.8
		# where the flare stands outboard of the face: from the height they
		# cross at
		cross = q.y - (side * face - q.z) * n.z / n.y
		bay = over.get(b["name"])
		if bay:
			assert bay["side"] == side, f"box {b['name']}: its bay on the other side"
			bay["from"] = max(cross - 0.25, shelf + 0.05)
			bay["level"] = flare(middle, bay["from"]) - bay["depth"]
			inside = min(inside, bay["level"])
		def solid(y0, y1, z):
			# the box between two heights, out to |z|, its aft end leaning
			outline = [[aft(y0), side * inside], [aft(y0), side * z], [x1, side * z], [x1, side * inside]]
			upper = [[aft(y1), side * inside], [aft(y1), side * z], [x1, side * z], [x1, side * inside]]
			return prism(outline, y0, y1, upper=upper)
		solids += ([solid(foot, shelf, face + proud)] if shelf > foot else []) + [solid(shelf, top, face)]
		# the flare cut away from a little above the crossing, so the cut has
		# walls, to the box's top; a box under a bay has the bay instead
		y0 = max(cross + 0.1, shelf)
		if y0 < top - 0.05 and not bay:
			def onflare(x, y):
				# a corner moved in along x until the plating there is the flare's
				# plane (not a well's wall)
				step = 0.05 if x < middle else -0.05
				for _ in range(80):
					got = bvh.ray_cast(at(x, y, side * 80.0), at(0, 0, -side) - at(0, 0, 0))
					if got[0] is not None and abs(abs(ship(got[0]).z) - flare(x, y)) < 0.03:
						return x
					x += step
				raise AssertionError(f"box {b['name']}: no flare at its corner")
			start = lambda y: max(aft(y), b.get("cut", aft(y)))
			corners = [(onflare(start(y0), y0), y0), (onflare(x1, y0), y0), (onflare(x1, top), top), (onflare(start(top), top), top)]
			outline = [[x, y, side * flare(x, y)] for x, y in corners]
			# the faces round it only those it lies on (a well's wall beside it
			# is built of slivers whose edges meet at corners)
			recesses.append({"name": b["name"], "outline": outline, "normal": list(n), "out": [0, 0, side],
				"level": face, "paint": "grey", "floor": "grey", "back": None, "margin": 0.05})
	assert all("from" in c for c in over.values()), "a bay over a box that is not built"
	for c in notches:
		if "level" not in c:
			# its back `depth` in from the plating at its middle and floor
			bvh, _ = tree("hull")
			hit = bvh.ray_cast(at(sum(c["x"]) / 2, c["from"], c["side"] * 80.0), at(0, 0, -c["side"]) - at(0, 0, 0))[0]
			assert hit is not None, f"notch {c['name']}: no plating there"
			c["level"] = abs(ship(hit).z) - c["depth"]
	if notches:
		notch(NODES["hull"], notches)
		trees.pop("hull", None)
	if recesses:
		pierce(NODES["hull"], recesses)
		trees.pop("hull", None)
	if solids:
		node("boxes", mesh=merge(solids))
	for o in h.get("openings", []):
		name = o.get("node", "hull")
		bvh, faces = tree(name)
		# the outermost plating at its x and height on its side
		side = 1 if o.get("side", "starboard") == "starboard" else -1
		x, y = o["at"]
		hit, normal, index, distance = bvh.ray_cast(at(x, y, side * 80.0), at(0, 0, -side) - at(0, 0, 0))
		assert hit is not None, f"opening {o['name']}: no plating of {name} at x {x}, y {y}"
		q, n = ship(hit), ship(normal).normalized()
		if n.z * side < 0:
			n = -n
		along = Vector((0, 1, 0)).cross(n).normalized()
		up = n.cross(along).normalized()
		kind = o["kind"]
		if kind == "recess":
			# the outline's corners on the face's plane, at their x and y
			onto = lambda x, y: Vector((x, y, q.z - (n.x * (x - q.x) + n.y * (y - q.y)) / n.z))
			outline = [onto(x, y) for x, y in o["outline"]]
			if o.get("radius"):
				outline = [Vector(c) for c in rounded([list(c) for c in outline], o["radius"], steps=4)]
		else:
			a, b = o["size"][0] / 2, o["size"][1] / 2
			if o.get("round"):
				outline = [q + along * a * math.cos(2 * math.pi * k / 24) + up * b * math.sin(2 * math.pi * k / 24) for k in range(24)]
			else:
				corners = [q + along * i * a + up * j * b for i, j in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
				outline = [Vector(c) for c in rounded([list(c) for c in corners], o.get("radius", 0.0), steps=4)]
		if kind == "placard":
			# square-cornered, 5 mm proud of the plating; one with a `cell`
			# drawn from the lettering's (the node `side_lettering`)
			a, b = o["size"][0] / 2, o["size"][1] / 2
			corners = [q + along * i * a + up * j * b + n * 0.005 for i, j in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
			if o.get("cell"):
				lettering.append(plate([list(c) for c in corners], list(n), 0.01, "lettering"))
				right = along * (1 if (along.cross(up)).dot(n) > 0 else -1)
				frames_.append({"middle": tuple(q + n * 0.015), "right": tuple(right), "up": tuple(up), "size": tuple(o["size"]), "cell": o["cell"]})
			else:
				pieces.append(plate([list(c) for c in corners], list(n), 0.01, o["paint"]))
			continue
		hole = {"name": o["name"], "outline": [list(c) for c in outline], "normal": list(n), "depth": o["depth"], "paint": "grey", "floor": "grey",
			"back": o.get("back", {"window": "glass", "recess": "grey"}.get(kind, "dark"))}
		if kind == "recess" or o.get("level"):
			# its walls straight in across the ship, its floor level: in a
			# sloping face, walls square to it would climb out through what
			# stands over the face (the quarter's vents, under its ledge)
			hole["out"] = [0, 0, 1 if n.z > 0 else -1]
		if "within" in o:
			hole["within"] = o["within"]
		# its region only the faces it lies on and their neighbours within 15 cm
		# (an elevator well's wall beside it is built of slivers meeting at
		# corners)
		hole["margin"] = 0.15
		# the faces pierce() will take in round it, as it finds them
		u = n.cross(Vector((0, 1, 0)) if abs(n.y) < 0.9 else Vector((1, 0, 0))).normalized()
		w = n.cross(u)
		flat = lambda p: ((p - q).dot(u), (p - q).dot(w))
		ring = [flat(c) for c in outline]
		region = set()
		low = (min(p[0] for p in ring) - 0.15, min(p[1] for p in ring) - 0.15)
		high = (max(p[0] for p in ring) + 0.15, max(p[1] for p in ring) + 0.15)
		for k, (corners, fn) in enumerate(faces):
			if fn.dot(n) > 0.95 and all(abs((c - q).dot(n)) < o.get("within", 0.15) for c in corners):
				c = [flat(v) for v in corners]
				if min(p[0] for p in c) < high[0] and max(p[0] for p in c) > low[0] and min(p[1] for p in c) < high[1] and max(p[1] for p in c) > low[1]:
					region.add(k)
		cuts.setdefault(name, []).append((region, n, hole))
		if kind == "window" or o.get("rim"):
			width, proud = o.get("frame") or o["rim"]
			if o.get("round"):
				outer = [q + along * (a + width) * math.cos(2 * math.pi * k / 24) + up * (b + width) * math.sin(2 * math.pi * k / 24) for k in range(24)]
			elif kind == "recess":
				# grown out along each corner's bisector by the width
				m = len(outline)
				outer = []
				for k in range(m):
					p0, p1, p2 = outline[k - 1], outline[k], outline[(k + 1) % m]
					e1, e2 = (p1 - p0).normalized(), (p2 - p1).normalized()
					o1, o2 = e1.cross(n), e2.cross(n)
					bisector = (o1 + o2).normalized()
					outer.append(p1 + bisector * width / max(0.5, bisector.dot(o1)))
				centre = sum(outline, Vector()) / m
				if (outer[0] - centre).length < (outline[0] - centre).length:
					outer = [2 * p - o_ for p, o_ in zip(outline, outer)]
			else:
				corners = [q + along * i * (a + width) + up * j * (b + width) for i, j in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
				outer = [Vector(c) for c in rounded([list(c) for c in corners], o.get("radius", 0.0) + width, steps=4)]
			pieces.append(collar([list(c) for c in outline], [list(c) for c in outer], list(n), proud, "grey"))
		if kind == "chock":
			across, high, thickness = o["lip"]
			pieces.append(lip(list(q), list(n), [across / 2, high / 2], [a, b], thickness, o.get("paint", "chock")))
		if kind == "recess" and o.get("ledge"):
			# a shelf out from its floor's front edge, `ledge` [depth out,
			# thickness], on `knees` triangular brackets down to the face
			out_, thick = o["ledge"]
			side = 1 if n.z > 0 else -1
			low = min(c.y for c in outline)
			floor = [c for c in outline if abs(c.y - low) < 1e-6]
			x0, x1 = min(c.x for c in floor), max(c.x for c in floor)
			face_z = lambda x, y: q.z - (n.x * (x - q.x) + n.y * (y - q.y)) / n.z
			z0 = face_z((x0 + x1) / 2, low)
			pieces.append(prism([[x0, z0 - side * 0.05], [x1, z0 - side * 0.05], [x1, z0 + side * out_], [x0, z0 + side * out_]], low - thick, low))
			count, drop = o.get("knees", 0), o.get("drop", 0.4)
			for k in range(count):
				x = x0 + (x1 - x0) * (k + 0.5) / count
				foot = face_z(x, low - thick - drop)
				pieces.append(shape({"kind": "extrusion", "plane": "zy", "profile": [[z0 - side * 0.05, low - thick], [z0 + side * out_, low - thick],
					[foot - side * 0.05, low - thick - drop]], "along": [x - 0.04, x + 0.04]}))
		if kind == "recess" and o.get("railing"):
			# across its floor `inset` in from the face, from wall to wall
			low = min(c.y for c in outline)
			floor = [c for c in outline if abs(c.y - low) < 1e-6]
			x0, x1 = min(c.x for c in floor) + 0.05, max(c.x for c in floor) - 0.05
			z = (floor[0] - Vector((0, 0, 1 if n.z > 0 else -1)) * o.get("inset", 0.3)).z
			pieces.append(shape({"kind": "railing", "path": [[x0, low, z], [x1, low, z]], "height": o["railing"], "posts": o.get("posts", 1.5)}))
		if o.get("mark"):
			MARKS[o["mark"]] = (at(*q), name)
	# openings whose regions share a face cut together (pierce()'s rings, each
	# in its own plane), so no cut takes in faces filled round another's
	for name, found in cuts.items():
		groups = []
		for region, n, hole in found:
			joined = [g for g in groups if g[0] & region]
			merged = (set(region), [n], [hole])
			for g in joined:
				merged[0].update(g[0]); merged[1].extend(g[1]); merged[2].extend(g[2])
				groups.remove(g)
			groups.append(merged)
		pierce(NODES[name], [{"name": "+".join(r["name"] for r in rings), "normal": list(sum(normals, Vector()).normalized()), "rings": rings}
			for region, normals, rings in groups])
	if pieces:
		node("frames", mesh=merge(pieces))
	if lettering:
		node("side_lettering", mesh=merge(lettering))
		lettered("side_lettering", frames_)


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


def lid():
	# The hull's sections end at the deck's underside, an open edge there that
	# the deck closes; but where that edge strays outside the deck's outline
	# (both fitted to the photos: by up to half a metre at the port quarter's
	# walls, about 10 cm along the starboard gallery's foot and at the stem)
	# nothing closed the strip between the two, and the hull's inside showed
	# through it. Each stretch of the edge outside the outline is closed with
	# a lid at that height facing up, the hull's own: the stretch, where its
	# ends meet the outline, and the outline's corners between
	import bmesh
	from mathutils.geometry import tessellate_polygon
	d = LAYOUT["deck"]
	bottom = d["height"] - d["thickness"]
	ring = d["outline"] if area(d["outline"]) < 0 else d["outline"][::-1]
	ring = [Vector(q) for q in rounded_ring(ring, round_down(d))]
	obj, hinge = NODES["hull"], HINGES["hull"]
	plan = lambda v: Vector(((v.co + hinge).x, -(v.co + hinge).y))

	def nearest(p):
		# the closest point on the outline: its distance, and where along it
		best = None
		for k, (a, b) in enumerate(zip(ring, ring[1:] + ring[:1])):
			ab = b - a
			t = max(0.0, min(1.0, (p - a).dot(ab) / ab.length_squared))
			q = a + ab * t
			if best is None or (p - q).length < best[0]:
				best = ((p - q).length, k + t, q)
		return best

	def inside(p):
		c = False
		for a, b in zip(ring, ring[1:] + ring[:1]):
			if (a.y > p.y) != (b.y > p.y) and p.x < a.x + (p.y - a.y) * (b.x - a.x) / (b.y - a.y):
				c = not c
		return c

	bm = bmesh.new()
	bm.from_mesh(obj.data)
	paint = max(obj.data.materials.find("grey"), 0)
	n = len(ring)
	made, touched, on = 0, [], {}

	def onto(v):
		# a point of the edge, and where it meets the outline (itself, on it)
		far, at_, q = nearest(plan(v))
		if far <= 0.01:
			return v, at_
		key = (round(q.x, 4), round(q.y, 4))
		if key not in on:
			on[key] = bm.verts.new(Vector((q.x, -q.y, bottom)) - hinge)
		return on[key], at_
	def top(e):
		return e.is_boundary and all(abs((v.co + hinge).z - bottom) < 2e-3 for v in e.verts)

	def crossing(e):
		# how far along the edge it first crosses the outline (None: it
		# doesn't, but at its ends)
		pa, pb = plan(e.verts[0]), plan(e.verts[1])
		d, best = pb - pa, None
		for p, q in zip(ring, ring[1:] + ring[:1]):
			f = q - p
			den = d.x * f.y - d.y * f.x
			if abs(den) < 1e-12:
				continue
			w = p - pa
			t, u = (w.x * f.y - w.y * f.x) / den, (w.x * d.y - w.y * d.x) / den
			if 0 < t < 1 and min(t, 1 - t) * d.length > 1e-3 and -1e-9 <= u <= 1 + 1e-9 and (best is None or t < best):
				best = t
		return best
	# an edge crossing the outline split where it does, so each piece lies
	# wholly inside or outside it: the stretch outside then closes cleanly,
	# where the lid round an edge from outside to inside (the port wall's end
	# at elevator 3's aft edge) crossed itself and lay over itself
	split = True
	while split:
		split = False
		for e in [e for e in bm.edges if top(e)]:
			t = crossing(e)
			if t is not None:
				bmesh.utils.edge_split(e, e.verts[0], t)
				split = True
				break
	edges = [e for e in bm.edges if top(e)]
	for e in edges:
		a, b = e.verts
		middle = (plan(a) + plan(b)) / 2
		# along the outline, or inside it, it needs nothing (an edge from one
		# of the outline's corners to another can cut across outside it)
		if inside(middle) or nearest(middle)[0] <= 0.01:
			continue
		(qa, ta), (qb, tb) = onto(a), onto(b)
		# the outline's corners between the two, the shorter way round
		forward = (ta - tb) % n
		step = 1 if forward <= n / 2 else -1
		corners, i = [], math.floor(tb) + (1 if step > 0 else 0)
		while (step > 0 and (i - tb) % n < forward) or (step < 0 and (tb - i) % n < n - forward):
			key = (round(ring[i % n].x, 4), round(ring[i % n].y, 4))
			if key not in on:
				on[key] = bm.verts.new(Vector((ring[i % n].x, -ring[i % n].y, bottom)) - hinge)
			corners.append(on[key])
			i += step
		polygon = []
		for v in [a, b, qb] + corners + [qa]:
			if not polygon or polygon[-1] is not v:
				polygon.append(v)
		if polygon[-1] is polygon[0]:
			polygon.pop()
		touched += polygon
		if len(polygon) < 3:
			continue
		for tri in tessellate_polygon([[(*plan(v), 0.0) for v in polygon]]):
			face = [polygon[k] for k in tri]
			if len(set(face)) < 3:
				continue
			if (face[1].co - face[0].co).cross(face[2].co - face[1].co).z < 0:
				face = face[::-1]
			try:
				bm.faces.new(face).material_index = paint
				made += 1
			except ValueError:
				pass   # a face the hull has already
	bmesh.ops.remove_doubles(bm, verts=[v for v in set(touched) if v.is_valid], dist=1e-4)
	bm.normal_update()
	bm.to_mesh(obj.data)
	bm.free()
	return made


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


# The cache's version: bump it to drop every cached atlas
CACHE = "1"


def placed(o):
	# An object's vertices in the world (N, 3)
	import numpy as np
	co = np.empty(len(o.data.vertices) * 3, np.float32)
	o.data.vertices.foreach_get("co", co)
	matrix = np.array(o.matrix_world, np.float64)
	return (co.reshape(-1, 3).astype(np.float64) @ matrix[:3, :3].T + matrix[:3, 3]).astype(np.float32)


def cycles(o, target=None, turned=False):
	# Each face of an object (in `target` only, when given) by its vertices
	# in its own winding, turned to start at its least: the same face whatever
	# order the faces were made in. Returns the faces' indices and their cycles
	# (and with `turned`, how far each was turned)
	import numpy as np
	mesh = o.data
	n = len(mesh.polygons)
	starts, totals, slots = (np.empty(n, np.int32) for _ in range(3))
	mesh.polygons.foreach_get("loop_start", starts)
	mesh.polygons.foreach_get("loop_total", totals)
	mesh.polygons.foreach_get("material_index", slots)
	corners = np.empty(len(mesh.loops), np.int32)
	mesh.loops.foreach_get("vertex_index", corners)
	chosen = np.arange(n)
	if target is not None:
		mine = np.array([m == target for m in mesh.materials] + [False])
		chosen = chosen[mine[np.minimum(slots, len(mesh.materials))]]
	out, turns = [], []
	for p in chosen:
		cycle = corners[starts[p] : starts[p] + totals[p]].tolist()
		k = cycle.index(min(cycle))
		out.append(tuple(cycle[k:] + cycle[:k]))
		turns.append(k)
	return (chosen, out, turns) if turned else (chosen, out)


def scene_faces():
	# Every mesh's faces in the world: each one's bounding box (low, high) and
	# a digest of it (its object, its vertices and their places, its
	# material's alpha, which a see-through face's shadow could carry), the
	# same whatever order the faces were made or cut into triangles in
	import hashlib
	import numpy as np
	lows, highs, digests = [], [], []
	for o in sorted(bpy.context.scene.objects, key=lambda o: o.name):
		if o.type != "MESH" or not len(o.data.polygons):
			continue
		mesh = o.data
		world = placed(o)
		slots = np.empty(len(mesh.polygons), np.int32)
		mesh.polygons.foreach_get("material_index", slots)
		alpha = np.array([m.diffuse_color[3] if m else 1.0 for m in mesh.materials] + [1.0], np.float32)[np.minimum(slots, len(mesh.materials))]
		_, faces = cycles(o)
		name = o.name.encode()
		for face, a in zip(faces, alpha):
			at = world[list(face)]
			lows.append(at.min(0))
			highs.append(at.max(0))
			digests.append(hashlib.blake2b(name + np.array(face, np.int32).tobytes() + at.tobytes() + a.tobytes(), digest_size=16).digest())
	return np.array(lows), np.array(highs), digests


def surface(tris, spacing):
	# Points over triangles (N, 3, 3), none of whose edges they divide into
	# pieces longer than `spacing`
	import numpy as np
	longest = np.linalg.norm(tris - np.roll(tris, 1, axis=1), axis=2).max(1)
	steps = np.maximum(1, np.ceil(longest / spacing)).astype(int)
	out = []
	for n in np.unique(steps):
		i, j = np.mgrid[0 : n + 1, 0 : n + 1]
		keep = i + j <= n
		weights = np.stack([i[keep], j[keep], n - i[keep] - j[keep]], 1) / n
		out.append(np.einsum("pk,tkd->tpd", weights, tris[steps == n]).reshape(-1, 3))
	return np.concatenate(out)


def near(points, low, high, reach, cell=1.0):
	# Which boxes (low, high: (N, 3)) come within `reach` of any of the points:
	# space cut into cells `cell` across, a box kept when it meets a cell
	# within reach of a point's cell (their nearest corners). It may keep a box
	# up to a cell's diagonal further off, never drop a nearer one
	import numpy as np

	def code(c):
		c = c.astype(np.int64) + (1 << 20)
		return (c[..., 0] << 42) | (c[..., 1] << 21) | c[..., 2]

	cells = np.unique(np.floor(points / cell).astype(np.int64), axis=0)
	steps = int(math.ceil(reach / cell)) + 1
	around = np.array(list(itertools.product(range(-steps, steps + 1), repeat=3)))
	# a neighbour whose nearest point to the cell lies within reach
	gap = np.maximum(np.abs(around) - 1, 0) * cell
	around = around[(gap ** 2).sum(1) <= reach ** 2]
	occupied = np.unique(code((cells[:, None, :] + around[None]).reshape(-1, 3)))

	def member(codes):
		at = np.minimum(np.searchsorted(occupied, codes), len(occupied) - 1)
		return occupied[at] == codes

	low, high = np.floor(low / cell).astype(np.int64), np.floor(high / cell).astype(np.int64)
	# boxes up to 8 cells along each axis a cell at a time, all at once; the
	# few larger ones each on its own
	small = ((high - low) < 8).all(1)
	hit = np.zeros(len(low), bool)
	for step in itertools.product(range(8), repeat=3):
		hit[small] |= member(code(np.minimum(low[small] + step, high[small])))
	for t in np.nonzero(~small)[0]:
		grid = np.stack(np.meshgrid(*[np.arange(low[t, d], high[t, d] + 1) for d in range(3)], indexing="ij"), -1)
		hit[t] = member(code(grid.reshape(-1, 3))).any()
	return hit


def fingerprint(group, objs, target, spec, inputs, scene):
	# A weathered group's cache key: everything its atlas comes from. Its own
	# faces (their cycles, which carry their winding, their vertices' places,
	# their shading and sharp edges, from which their normals follow), every
	# face in the world within reach of its occlusion's rays, the group's and
	# the shared weathering spec, the facts weather.py reads, and the code that
	# bakes and draws it. None of it hangs on the order faces were made in
	import hashlib, inspect
	import numpy as np
	h = hashlib.sha256()

	def add(data):
		data = data if isinstance(data, bytes) else json.dumps(data, sort_keys=True).encode()
		h.update(len(data).to_bytes(8, "little"))
		h.update(data)

	# the weathering block the rules read is the shared spec and the group's
	# own, never another group's (test_weather checks)
	read = {k: v for k, v in inputs.items() if k != "layout/weathering"}
	# (the joints `raised` reach it through the faces they move, so only the
	# atlases those faces or their neighbours make re-bake when it changes)
	shared = {k: v for k, v in spec.items() if k not in ("groups", "raised")}
	add([CACHE, bpy.app.version_string, group, shared, read, list(FRAME_LOW), list(FRAME_SPAN)])
	for f in (weathered, baked, emitting, fingerprint, placed, cycles, scene_faces, surface, near, face_uvs, restored, stored):
		add(inspect.getsource(f).encode())
	for name in ("weather.py", "plates.py"):
		add((HERE / name).read_bytes())
	own = []
	for o in objs:
		mesh = o.data
		world = placed(o)
		chosen, faces = cycles(o, target)
		smooth = np.empty(len(mesh.polygons), bool)
		mesh.polygons.foreach_get("use_smooth", smooth)
		add(o.name.encode())
		add(repr(sorted(zip(faces, smooth[chosen].tolist()))).encode())
		used = np.unique(np.concatenate([np.array(f, np.int64) for f in faces])) if faces else np.zeros(0, np.int64)
		add(used.tobytes())
		add(world[used].tobytes())
		sharp = mesh.attributes.get("sharp_edge")
		if sharp is not None and len(mesh.edges):
			flags = np.empty(len(mesh.edges), bool)
			sharp.data.foreach_get("value", flags)
			ends = np.empty(len(mesh.edges) * 2, np.int32)
			mesh.edges.foreach_get("vertices", ends)
			pairs = np.sort(ends.reshape(-1, 2)[flags], 1)
			pairs = pairs[np.isin(pairs, used).all(1)]
			add(pairs[np.lexsort(pairs.T[::-1])].tobytes())
		# its faces as triangles, any cut of them, for where its surface lies
		for face in faces:
			for k in range(1, len(face) - 1):
				own.append(world[[face[0], face[k], face[k + 1]]])
	low, high, digests = scene
	# a texel's occlusion looks spec.occlusion metres; the points over the
	# group's faces lie no more than 1 m apart along their edges
	keep = near(surface(np.array(own), 1.0), low, high, spec.get("occlusion", 3.0) + 1.0)
	add(b"".join(sorted(digests[i] for i in np.nonzero(keep)[0])))
	return h.hexdigest()


def face_uvs(o, target, uv=None):
	# The object's faces in `target`, each by its cycle, with its corners' UVs
	# from the layer's (N, 2) `uv` taken in the cycle's order: [(cycle, uvs)]
	import numpy as np
	starts = np.empty(len(o.data.polygons), np.int32)
	o.data.polygons.foreach_get("loop_start", starts)
	chosen, faces, turns = cycles(o, target, turned=True)
	out = []
	for p, face, k in zip(chosen, faces, turns):
		loops = starts[p] + (np.arange(len(face)) + k) % len(face)
		out.append((face, loops, None if uv is None else uv[loops]))
	return out


def stored(entry, objs, target, colour_png, normals):
	# A group's atlas into the cache: its faces' UVs, each face by its cycle,
	# its colour map's file and its normal map (8-bit, as baked); the three
	# newest of its entries kept
	import shutil
	import numpy as np
	partial = entry.with_name(entry.name + ".part")
	shutil.rmtree(partial, ignore_errors=True)
	partial.mkdir(parents=True)
	uvs = {}
	for o in objs:
		layer = o.data.uv_layers["atlas"]
		uv = np.empty(len(layer.data) * 2, np.float32)
		layer.data.foreach_get("uv", uv)
		faces = face_uvs(o, target, uv.reshape(-1, 2))
		uvs[o.name + "/sizes"] = np.array([len(f) for f, _, _ in faces], np.int32)
		uvs[o.name + "/cycles"] = np.array([v for f, _, _ in faces for v in f], np.int32)
		uvs[o.name + "/uv"] = np.concatenate([u for _, _, u in faces]) if faces else np.zeros((0, 2), np.float32)
	np.savez(partial / "uv.npz", **uvs)
	shutil.copyfile(colour_png, partial / colour_png.name)
	if normals is not None:
		np.save(partial / "normal.npy", np.round(normals * 255).astype(np.uint8))
	shutil.rmtree(entry, ignore_errors=True)
	partial.rename(entry)
	material = entry.name.rsplit("-", 1)[0]
	kept = sorted((p for p in entry.parent.glob(material + "-*") if not p.name.endswith(".part")), key=lambda p: p.stat().st_mtime)
	for p in kept[:-3]:
		shutil.rmtree(p, ignore_errors=True)


def restored(entry, objs, target):
	# A cached atlas's UVs onto the group's faces, each face found by its
	# cycle; a cycle twice over (a face doubled) takes the cached UVs of its
	# twins in turn, which lie on the same place. False, changing nothing,
	# when the faces and the cache's differ
	import numpy as np
	uvs = np.load(entry / "uv.npz")
	found = []
	for o in objs:
		sizes, flat, values = uvs[o.name + "/sizes"], uvs[o.name + "/cycles"], uvs[o.name + "/uv"]
		cached, at = {}, 0
		for n in sizes:
			cached.setdefault(tuple(flat[at : at + n].tolist()), []).append(values[at : at + n])
			at += n
		layer = o.data.uv_layers["atlas"]
		uv = np.empty(len(layer.data) * 2, np.float32)
		layer.data.foreach_get("uv", uv)
		uv = uv.reshape(-1, 2)
		for face, loops, _ in face_uvs(o, target):
			if not cached.get(face):
				return False
			uv[loops] = cached[face].pop(0)
		if any(cached.values()):
			return False
		found.append((o, uv))
	for o, uv in found:
		o.data.uv_layers["atlas"].data.foreach_set("uv", uv.ravel())
	return True


def weathered(facts, out, cache=None):
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
	if cache:
		# a group whose inputs a build has seen takes its atlas from the cache,
		# keyed (fingerprint()) on the facts weather.py reads and the faces round it
		inputs = json.loads(subprocess.run(["python3", "-I", str(HERE / "weather.py"), "--inputs", "--facts", str(facts)],
			check=True, capture_output=True, text=True).stdout)
		bpy.context.view_layer.update()
		scene = scene_faces()
		# every group's key first, on the meshes as built: making one group's
		# atlas leaves its meshes changed for the next group on them
		keys = {}
		for group in spec["groups"]:
			objs = [NODES[n] for n in group["meshes"] if n in NODES and NODES[n].type == "MESH"]
			if objs:
				keys[group["material"]] = fingerprint(group, objs, MATERIALS[group["material"]], spec, inputs, scene)
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
				# a copy of the mesh's active layer (the deck's paint, the
				# lettering), which its other faces keep (single_layers())
				o.data.uv_layers.new(name="atlas", do_init=True)
			o.data.uv_layers.active = o.data.uv_layers["atlas"]
			for poly in o.data.polygons:
				poly.select = o.data.materials[poly.material_index] == target
				if poly.select:
					area += poly.area
		entry = Path(cache) / f"{group['material']}-{keys[group['material']][:24]}" if cache else None
		if entry is not None and (entry / "uv.npz").exists() and restored(entry, objs, target):
			print(f"weathered {group['material']}: from the cache, {entry.name}", flush=True)
			colour_png = entry / f"{group['material']}.png"   # the file's name the exported image's
			normals = None if group.get("flat") else np.load(entry / "normal.npy").astype(np.float32) / np.float32(255)
		else:
			print(f"weathered {group['material']}: baked", flush=True)
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
			if entry is not None:
				stored(entry, objs, target, colour_png, normals)
		colour = bpy.data.images.load(str(colour_png))
		colour.name = group["material"]
		colour.pack()
		if colour_png.parent == folder:
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
	if LAYOUT.get("lens", {}).get("housing"):
		# the model carries the lens's housing: the engine draws only its lights
		out["lens"] = {**{k: v for k, v in LAYOUT["lens"].items() if k != "housing"}, "housed": True}
	if LAYOUT.get("island"):
		# the island as the server collides with it (decision 20): its prisms'
		# plans and heights, and the mast's top
		i = LAYOUT["island"]
		out["island"] = {"prisms": [{"outline": p["outline"], "bottom": p["bottom"], "top": p["top"]} for p in i.get("prisms", [])]}
		poles = i.get("poles", [])
		if poles:
			mast = max(poles, key=lambda p: p["top"])
			out["island"]["mast"] = {"position": mast["base"], "top": mast["top"]}
	if LAYOUT.get("vehicles", {}).get("parked"):
		# the deck's vehicles as the server collides with them
		out["vehicles"] = [footprint(p) for p in LAYOUT["vehicles"]["parked"]]
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
	# --cache DIR: weathered atlases kept between builds (weathered())
	cache = None
	if "--cache" in args:
		i = args.index("--cache")
		cache = Path(args[i + 1])
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
	hatches()
	antennas()
	island()
	sides()
	hulled = hull()
	openings()
	print(f"hull lid: {lid()} faces where the deck leaves the hull's top open")
	anchors()
	vehicles()
	regroup()
	if "--draft" not in args:
		deck_texture(facts)
		if "lettering" in MATERIALS:
			lettering_texture(facts)
		# the joints seen posed (a deflector raised behind a jet) baked so,
		# their occlusion as they are seen, and put back to rest for export
		undo = posed(LAYOUT.get("weathering", {}).get("raised", []))
		weathered(facts, out[0], cache)
		undo()
		single_layers()
	# every paint drawn on its faces' fronts only (glTF doubleSided false),
	# but the sheets seen from both sides (BOTH): a face's back drawn too
	# lies a plate's thickness behind the face in front of it, where the
	# depth buffer draws the two through each other (stacks.py). Set after
	# the bakes, which see both sides
	for m in bpy.data.materials:
		m.use_backface_culling = m.name not in BOTH
	# the glTF exporter calls mesh.validate() on each mesh it exports, deletes
	# what that finds and goes on with a warning: a mesh it would change fails
	# the build here instead, so the model exported is the one built
	for o in bpy.data.objects:
		if o.type == "MESH":
			copy = o.data.copy()
			changed = copy.validate()
			bpy.data.meshes.remove(copy)
			if changed:
				raise RuntimeError(f"mesh {o.name} is not valid: the glTF exporter would change it")
	bpy.ops.export_scene.gltf(filepath=out[0], export_format="GLB", export_yup=True, use_selection=False,
		export_apply=False, export_animations=False, export_extras=False)
	Path(out[1]).write_text(json.dumps(ship_file(hulled), indent="\t") + "\n")
	if len(out) > 2:
		features = {"about": "The model's named points and curves, each on the node it rides on, at rest in the ship frame (build.py).",
			"landmarks": {name: {"at": exported(p), "node": n} for name, (p, n) in sorted(MARKS.items())},
			"curves": {name: {"points": [exported(p) for p in points], "node": n} for name, (points, n) in sorted(CURVES.items())}}
		Path(out[2]).write_text(json.dumps(features, indent="\t") + "\n")


if __name__ == "__main__":
	main()
