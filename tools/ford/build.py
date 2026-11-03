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
import json, math, subprocess, sys, tempfile
from pathlib import Path

import bmesh
import bpy
from mathutils import Matrix, Vector

HERE = Path(__file__).resolve().parent
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
	"lights": (0.5, 0.5, 0.45, 1), "panel": (0.24, 0.27, 0.30, 1),
	# the raft canisters white and the small ones blue, by eye in the overhead;
	# the nets' cord from their image
	"raft": (0.62, 0.62, 0.6, 1), "blue": (0.13, 0.35, 0.52, 1), "net": (0.03, 0.03, 0.03, 1),
	# the transom's recess, its paint in shade there (0.35-0.4 of the face's
	# brightness in the same light); the drop-light bar the deck's yellow
	"recess": (0.11, 0.12, 0.12, 1), "yellow": (0.67, 0.39, 0.03, 1),
	# the Phalanx's radome, white
	"radome": (0.7, 0.7, 0.68, 1),
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
		MATERIALS[name] = m
	return MATERIALS[name]


NODES, HINGES, JOINTS = {}, {}, {}
STEP = 1.5   # metres between the hull's sections
# The features file's points and curves, each with the node it rides on: name
# to (point, node) and name to ([points], node)
MARKS, CURVES = {}, {}


def node(name, parent=None, hinge=None, mesh=None, paint="grey", smooth=False):
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
		tidy(data, smooth)
	obj = bpy.data.objects.new(name, data)
	bpy.context.scene.collection.objects.link(obj)
	if parent:
		obj.parent = NODES[parent]
	obj.location = hinge - (HINGES[parent] if parent else Vector())
	NODES[name], HINGES[name] = obj, hinge.copy()
	return obj


def tidy(data, smooth):
	# Welds coincident vertices and turns every face outward. A ship is mostly
	# flat plate: smooth shading only where asked, and then sharp above 30 degrees
	bm = bmesh.new()
	bm.from_mesh(data)
	bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
	# only a closed mesh has an outside to turn to; an open one (the deck's
	# top, its edge plate) keeps the winding it was built with
	if all(len(e.link_faces) == 2 for e in bm.edges):
		bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
	bm.to_mesh(data)
	bm.free()
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
	# A radome: a sphere on a cylinder reaching `plinth` below its centre
	c = at(*centre)
	pieces = [primitive(lambda bm: bmesh.ops.create_uvsphere(bm, u_segments=16, v_segments=8, radius=radius, matrix=Matrix.Translation(c)))]
	if plinth > 0:
		middle = c + DOWN * (plinth / 2)
		pieces.append(primitive(lambda bm: bmesh.ops.create_cone(bm, cap_ends=True, segments=16, radius1=radius, radius2=radius,
			depth=plinth, matrix=Matrix.Translation(middle))))
	return merge(pieces)


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


def flight_deck():
	# The flight deck: its top (`deck`, the painted texture), its edge plate
	# (`deck_skirt`) and the underside of its overhang (`deck_underside`). The
	# elevators' platforms are their own nodes, so the outline leaves them out.
	d = LAYOUT["deck"]
	top, bottom = d["height"], d["height"] - d["thickness"]
	outline = d["outline"]
	ring = outline if area(outline) < 0 else outline[::-1]
	n = len(ring)
	node("deck", mesh=([at(x, top, z) for x, z in ring], [tuple(range(n))], ["deck"]))
	data = NODES["deck"].data
	bm = bmesh.new()
	bm.from_mesh(data)
	bmesh.ops.triangulate(bm, faces=bm.faces, quad_method="BEAUTY", ngon_method="BEAUTY")
	bm.to_mesh(data)
	bm.free()
	painted("deck")
	sides = [(i, n + i, n + (i + 1) % n, (i + 1) % n) for i in range(n)]
	vertices = [at(x, top, z) for x, z in ring] + [at(x, bottom, z) for x, z in ring]
	node("deck_skirt", mesh=(vertices, sides, ["grey"] * n))
	node("deck_underside", mesh=([at(x, bottom, z) for x, z in ring[::-1]], [tuple(range(n))], ["grey"]))
	for name, (x, z) in d.get("marks", {}).items():
		MARKS[f"deck_{name}"] = (at(x, top, z), "deck")
	CURVES["deck_edge"] = ([at(x, top, z) for x, z in outline], "deck")


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
	# The catapults' control consoles, stowed flush in the deck and rising out
	# of it while the catapults are manned
	fittings = LAYOUT["fittings"]
	top = LAYOUT["deck"]["height"]
	for c in LAYOUT.get("consoles", []):
		k = fittings["console"]
		centre = at(c["centre"][0], top - k["height"], c["centre"][1])
		name = f"catapult_console_{c['name']}"
		node(name, hinge=centre, mesh=box(centre, FORWARD, STARBOARD, k["length"], k["width"], k["height"]))
		joint(name, UP, Vector(), UP, "raised while the catapults are manned", [[0, 0], [1, k["height"]]], motion="slide")


def arresting():
	# The arresting gear's deck fittings: each pendant's round sheaves, raised
	# while it is rigged and sinking flush when it is not; the leaf-spring
	# supports under it, which a wheel or the hook presses flat; and the
	# barricade's stanchions, lying flush in their trays and rising about
	# their heads. The pendants themselves are the engine's, drawn between
	# their ends (decision 25).
	landing = LAYOUT.get("landing", {})
	fittings = LAYOUT["fittings"]
	top = LAYOUT["deck"]["height"]
	(ax, az), (fx, fz) = landing.get("line", [[0, 0], [1, 0]])
	along = (at(fx, top, fz) - at(ax, top, az)).normalized()
	across = UP.cross(along).normalized()
	for sheave in landing.get("sheaves", []):
		k = fittings["sheave"]
		base = plan(sheave["centre"])
		name = sheave["name"].replace("_port", "_sheave_port").replace("_starboard", "_sheave_starboard")
		node(name, hinge=base + UP * k["height"], mesh=merge([primitive(lambda bm: bmesh.ops.create_cone(bm, cap_ends=True,
			segments=16, radius1=k["diameter"] / 2, radius2=k["diameter"] / 2, depth=k["height"],
			matrix=Matrix.Translation(base + UP * (k["height"] / 2))))]))
		joint(name, DOWN, Vector(), DOWN, "its wire's: sunk flush while the wire is not rigged", [[0, 0], [1, k["height"]]], motion="slide")
	for support in landing.get("supports", []):
		k = fittings["support"]
		base = plan(support["centre"])
		name = f"wire_{support['wire']}_support_{support['number']}"
		node(name, hinge=base + UP * k["height"], mesh=box(base, along, across, k["length"], k["width"], k["height"]))
		joint(name, DOWN, Vector(), DOWN, "pressed flat by a wheel or the hook; nothing drives it yet", [[0, 0], [1, k["height"]]], motion="slide")
	for stanchion in landing.get("barricade", {}).get("stanchions", []):
		k = fittings["stanchion"]
		hinge, tip = plan(stanchion["hinge"]), plan(stanchion["tip"])
		run = tip - hinge
		name = f"barricade_{stanchion['side']}"
		# flush: its top is the deck's
		node(name, hinge=hinge, mesh=box(hinge + run / 2 + DOWN * k["thickness"], run, UP.cross(run), run.length, k["width"], k["thickness"]))
		joint(name, UP.cross(run), run, UP, "none yet: rigged for a barricade arrestment", [[0, 0], [1, round(math.pi / 2, 4)]])


def shape(p, frame=None):
	# One part of the layout's (layout.island.details, a weapon kind's parts, a
	# mast's fittings) as (vertices, faces, paints), its points in the ship's
	# frame, or carried by `frame` (a matrix on Blender's points) from a
	# kind's own: box {centre, size [x, y, z]}; cylinder {base, axis and
	# length, or end; radius}; prism {outline, bottom, top}; railing {path,
	# height, posts}: a top and a mid rail and posts; dish {centre, diameter,
	# facing}: a disc; dome {centre, radius}: a sphere
	paint = p.get("paint", "rail" if p["kind"] == "railing" else "grey")
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
		vertices, faces = primitive(lambda bm: bmesh.ops.create_cone(bm, cap_ends=True, segments=12, radius1=radius, radius2=radius,
			depth=(b - a).length, matrix=place))
		piece = (vertices, faces, [paint] * len(faces))
	elif kind == "prism":
		piece = prism(p["outline"], p["bottom"], p["top"], paint=paint)
	elif kind == "dome":
		c, r = at(*p["centre"]), p["radius"]
		vertices, faces = primitive(lambda bm: bmesh.ops.create_uvsphere(bm, u_segments=16, v_segments=8, radius=r, matrix=Matrix.Translation(c)))
		piece = (vertices, faces, [paint] * len(faces))
	elif kind == "railing":
		height, rails = p["height"], []
		for a, b in zip(p["path"], p["path"][1:]):
			for rise, size in ((height, 0.05), (height / 2, 0.04)):
				rails.append(bar([a[0], a[1] + rise, a[2]], [b[0], b[1] + rise, b[2]], size, paint))
			for q, _ in along_line([[a[0], a[2]], [b[0], b[2]]], p.get("posts", 1.5)):
				y = a[1] + (b[1] - a[1]) * (math.dist([a[0], a[2]], q) / max(math.dist([a[0], a[2]], [b[0], b[2]]), 1e-9))
				rails.append(bar([q[0], y, q[1]], [q[0], y + height, q[1]], 0.05, paint))
		piece = merge(rails)
	else:
		raise ValueError(f"part {p.get('name')}: unknown kind {kind}")
	if frame is not None:
		piece = ([frame @ v for v in piece[0]], piece[1], piece[2])
	return piece


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
	pieces = [prism(p["outline"], p["bottom"], p["top"], p.get("upper")) for p in i.get("prisms", [])]
	pieces += [dome(d["centre"], d["radius"], d.get("plinth", 0)) for d in i.get("domes", [])]
	pieces += [pole(p["base"], p["bottom"], p["top"], p["radius"]) for p in i.get("poles", [])]
	node("island", mesh=merge(pieces))
	if i.get("details"):
		# the mast's and the body's fittings, walkways and railings
		node("island_details", mesh=merge([shape(p) for p in i["details"]]))
	# its windows (glass) and the radar's faces (panel), on its faces
	middle = [sum(c[0] for p in i.get("prisms", []) for c in p["outline"]) / max(1, sum(len(p["outline"]) for p in i.get("prisms", []))),
		sum(c[1] for p in i.get("prisms", []) for c in p["outline"]) / max(1, sum(len(p["outline"]) for p in i.get("prisms", [])))]
	details = [face(w, middle, "glass") for w in i.get("windows", [])] + [face(f, middle, "panel") for f in i.get("panels", [])]
	plates = [p for p in LAYOUT.get("lettering", {}).get("plates", []) if p.get("on") == "island"]
	details += [face(p, middle, "lettering") for p in plates]
	if details:
		node("island_faces", mesh=merge(details))
		if plates:
			lettered("island_faces", [framed(p, middle) for p in plates])
	for p in i.get("prisms", []):
		for k, (x, z) in enumerate(p.get("upper") or p["outline"]):
			MARKS[f"island_{p['name']}_top_{k + 1}"] = (at(x, p["top"], z), "island")


def framed(p, centre):
	# A plane plate's frame as lettered() reads it (a plane with its ranges,
	# facing away from `centre` [x, z] as face() builds it): its middle, the
	# viewer's right and up seen from outside, and its size
	axis, value = p["plane"].split("=")
	value = float(value)
	(y0, y1) = p["y"]
	if axis == "z":
		(a0, a1) = p["x"]
		middle = ((a0 + a1) / 2, (y0 + y1) / 2, value)
		right = (1, 0, 0) if value > centre[1] else (-1, 0, 0)   # aft to forward seen from starboard, forward to aft from port
	else:
		(a0, a1) = p["z"]
		middle = (value, (y0 + y1) / 2, (a0 + a1) / 2)
		right = (0, 0, -1) if value > centre[0] else (0, 0, 1)   # starboard to port seen from forward, port to starboard from aft
	return {"middle": middle, "right": right, "up": (0, 1, 0), "size": (a1 - a0, y1 - y0), "cell": p["cell"]}


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
	# it; facing away from `centre` [x, z]
	(y0, y1) = entry["y"] if "y" in entry else (0, 0)
	if "corners" in entry:
		corners = entry["corners"]
		mid = [sum(c[i] for c in corners) / 4 for i in range(3)]
		u = [corners[1][i] - corners[0][i] for i in range(3)]
		v = [corners[3][i] - corners[0][i] for i in range(3)]
		n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
		if n[0] * (mid[0] - centre[0]) + n[2] * (mid[2] - centre[1]) < 0:
			n = [-c for c in n]
		return plate(corners, n, paint=paint)
	if "line" in entry:
		(ax, az), (bx, bz) = entry["line"]
		length = math.hypot(bx - ax, bz - az)
		dx, dz = (bx - ax) / length, (bz - az) / length
		a0, a1 = entry["along"]
		p0, p1 = (ax + dx * a0, az + dz * a0), (ax + dx * a1, az + dz * a1)
		n = [-dz, 0, dx]
		if n[0] * (p0[0] - centre[0]) + n[2] * (p0[1] - centre[1]) < 0:
			n = [dz, 0, -dx]
		return plate([[p0[0], y0, p0[1]], [p1[0], y0, p1[1]], [p1[0], y1, p1[1]], [p0[0], y1, p0[1]]], n, paint=paint)
	axis, value = entry["plane"].split("=")
	value = float(value)
	if axis == "z":
		(x0, x1) = entry["x"]
		outward = [0, 0, 1 if value > centre[1] else -1]
		corners = [[x0, y0, value], [x1, y0, value], [x1, y1, value], [x0, y1, value]]
	else:
		(z0, z1) = entry["z"]
		outward = [1 if value > centre[0] else -1, 0, 0]
		corners = [[value, y0, z0], [value, y0, z1], [value, y1, z1], [value, y1, z0]]
	return plate(corners, outward, paint=paint)


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
	# The nets' material: a small net of dark cord, the holes cut out (glTF
	# alphaMode MASK: the image's alpha, rounded, as the surface's alpha), on
	# both faces
	if "net" in MATERIALS:
		return MATERIALS["net"]
	m = material("net")
	size, cell, cord = 64, 16, 3
	image = bpy.data.images.new("net", size, size, alpha=True)
	pixels = []
	for v in range(size):
		for u in range(size):
			on = u % cell < cord or v % cell < cord
			pixels += [0.08, 0.08, 0.08, 1.0 if on else 0.0]
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
		lines.append(([extra["from"], extra["to"]], -1, floor))
	strips, frames = [], []
	for line, side, base in lines:
		far, _ = offset(line, side, n["width"])
		y0, y1 = base + height, base + height + n["rise"]
		k = len(line)
		vertices = [at(x, y0, z) for x, z in line] + [at(x, y1, z) for x, z in far]
		faces = [(i, i + 1, k + i + 1, k + i) for i in range(k - 1)]
		strips.append((vertices, faces, ["net"] * len(faces)))
		frames += [bar([a[0], y1, a[1]], [b[0], y1, b[1]], 0.05, "rail") for a, b in zip(far, far[1:])]
		for p, d in along_line(line, n["frames"]):
			q = [p[0] - d[1] * side * n["width"], p[1] + d[0] * side * n["width"]]
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
	# post frame and its fenders, the drop-light bar and the Phalanx's plinth
	# (`transom_fittings`)
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
	fittings += railing(w["rail"], floor, rail)
	(ax, az), (bx, bz) = w["aft"]
	for (y0, y1), depth in ((w["fascia"], 0.1), (w["member"], 0.2)):
		fittings.append(prism([[ax, az], [ax - depth, az], [bx - depth, bz], [bx, bz]], y0, y1))
	f = t["frame"]
	(z0, z1) = f["z"]
	for k in range(f["members"]):
		z = z0 + (z1 - z0) * k / (f["members"] - 1)
		fittings.append(bar([f["x"], f["bottom"], z], [f["x"], f["top"], z], f["size"], "dark"))
	fittings.append(bar([f["x"], f["top"] - f["size"] / 2, z0], [f["x"], f["top"] - f["size"] / 2, z1], f["size"], "dark"))
	for fender in t["fenders"]:
		fittings.append(cylinder(fender["centre"], fender["diameter"] / 2, fender["length"], "dark", across=True))
	d = t["drop"]
	fittings.append(prism([[d["x"] - d["depth"] / 2, d["z"] - d["width"] / 2], [d["x"] + d["depth"] / 2, d["z"] - d["width"] / 2],
		[d["x"] + d["depth"] / 2, d["z"] + d["width"] / 2], [d["x"] - d["depth"] / 2, d["z"] + d["width"] / 2]], d["bottom"], d["top"], paint="yellow"))
	pl = t["plinth"]
	(cx, cz), half = pl["centre"], pl["size"] / 2
	fittings.append(prism([[cx - half, cz - half], [cx + half, cz - half], [cx + half, cz + half], [cx - half, cz + half]], pl["bottom"], pl["top"]))
	node("transom_fittings", mesh=merge(fittings))


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
	# wedges: a section across the ship ([z, y] corners) carried from x0 to x1
	for w in LAYOUT.get("wedges", []):
		(x0, x1), section = w["x"], w["section"]
		n = len(section)
		if area([[z, y] for z, y in section]) < 0:
			section = section[::-1]
		vertices = [at(x0, y, z) for z, y in section] + [at(x1, y, z) for z, y in section]
		faces = [tuple(range(n)), tuple(range(2 * n - 1, n - 1, -1))] + [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
		pieces.append((vertices, faces))
		for k, (z, y) in enumerate(w["section"]):
			MARKS[f"wedge_{w['name']}_{k + 1}"] = (at(x0, y, z), "sponsons")
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


def hull():
	# The hull, a loft of sections every STEP from the transom to the bow.
	# Each section runs from the keel up each side's hull to its knuckle, out
	# along the flare to the foot of the gallery wall, and up that wall to the
	# deck's underside at the deck's edge; along a wall (hull.walls: the
	# quarters' and the port midbody's), to the foot of that wall and up it.
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

	def half(x, y):
		values = [interpolate(y, [p[0] for p in s["points"]], [p[1] for p in s["points"]]) for s in stations]
		value = interpolate(x, sx, values)
		if x > sx[-1]:
			# ahead of the last station each height runs straight to the bow's
			# forward edge there: the stem, or the face's crease above it, whose
			# sections take the face as their flat bottom
			front, end = ahead(y), crease(y)
			share = max(0.0, min(1.0, (x - sx[-1]) / (front - sx[-1]))) if front > sx[-1] else 1.0
			value += (end - value) * share
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

	def wall(x, side):
		# where a wall stands under the deck's edge: its |z| and its foot's
		# height, or None outside every wall on that side
		for w in walls.get("starboard" if side > 0 else "port", []):
			line = w["wall"]
			if line[0][0] <= x <= line[-1][0]:
				return abs(interpolate(x, [p[0] for p in line], [p[1] for p in line])), w["foot"]
		return None

	# the sections: every STEP, and at every x where a line the flare runs
	# between turns (the deck's and elevators' corners, the knuckle's and the
	# gallery's knots, the walls' ends, the creases' ends), so the flare is
	# flat between them and creases only there
	turns = {p[0] for o in outlines for p in o}
	for name in ("port", "starboard"):
		turns |= {p[0] for p in h["knuckle"][name]} | {p[0] for p in h["gallery"][name]}
		turns |= {w["wall"][e][0] for w in walls.get(name, []) for e in (0, -1)}
		turns |= {c[e][0] for c in flare.get(name, []) for e in (0, -1)}
	if h.get("front"):
		# and at each knot of the stem the front runs up, so its edges follow
		# the stem's profile
		top = h["face"]["bottom"][0] if h.get("face") else h["front"][-1][0]
		turns |= {ahead(p[0]) for p in h["front"]} | {x for x, y in stem if h["front"][0][0] <= y <= top}
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
			if standing:
				# a wall: out from the knuckle to its foot and up it to the deck's
				# underside, the deck overhanging any inboard of its edge
				z, foot = standing
				points += [(max(foot, ky), z), (under, z)]
			else:
				z = abs(edge(outlines, x, side))
				points += [(max(feet[side], ky), z), (under, z)]
			sides[side] = [at(x, y, side * z) for y, z in points]
		rings.append(sides[-1][::-1] + [at(x, y0, 0)] + sides[1])
	n = len(rings[0])
	vertices = [v for ring in rings for v in ring]
	faces, paints = [], []

	def paint(face):
		# red anti-fouling below its top, the black boot-topping up to the boot
		# top, grey above
		top = max(vertices[q].z for q in face)
		return "antifouling" if top <= foul + 1e-6 else "boot" if top <= boot + 1e-6 else "grey"

	# each side's knuckle and the gallery wall's foot above it, as indices in
	# a ring: port first, reversed, then the keel, then starboard
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
			if skip:
				continue
			a, b = i * n + j, i * n + j + 1
			faces.append((a, a + n, b + n, b))
			paints.append(paint(faces[-1]))
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
	node("hull", mesh=(vertices, faces, paints))
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
		b = h["bulb"]
		centre = at(*b["centre"])
		shape = Matrix.Translation(centre) @ Matrix.Diagonal((b["length"] / 2, b["width"] / 2, b["height"] / 2, 1))
		bulb = primitive(lambda bm: bmesh.ops.create_uvsphere(bm, u_segments=16, v_segments=8, radius=1.0, matrix=shape))
		node("hull_bulb", parent="hull", mesh=(bulb[0], bulb[1], ["antifouling" if foul > -1e9 else "boot"] * len(bulb[1])))
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
	if "--draft" not in args:
		deck_texture(facts)
		if "lettering" in MATERIALS:
			lettering_texture(facts)
	bpy.ops.export_scene.gltf(filepath=out[0], export_format="GLB", export_yup=True, use_selection=False,
		export_apply=False, export_animations=False, export_extras=False)
	Path(out[1]).write_text(json.dumps(ship_file(hulled), indent="\t") + "\n")
	if len(out) > 2:
		features = {"about": "The model's named points and curves, each on the node it rides on, at rest in the ship frame (build.py).",
			"landmarks": {name: {"at": exported(p), "node": n} for name, (p, n) in sorted(MARKS.items())},
			"curves": {name: {"points": [exported(p) for p in points], "node": n} for name, (points, n) in sorted(CURVES.items())}}
		Path(out[2]).write_text(json.dumps(features, indent="\t") + "\n")


main()
