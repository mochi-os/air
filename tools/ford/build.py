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
	"lights": (0.5, 0.5, 0.45, 1)}


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
	# many corners, in step) where its faces slope
	upper = upper or outline
	if area(outline) > 0:
		outline, upper = outline[::-1], upper[::-1]
	n = len(outline)
	vertices = [at(x, top, z) for x, z in upper] + [at(x, bottom, z) for x, z in outline]
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


def box(centre, along, across, length, width, height, paint="grey"):
	# A box standing on `centre`'s height: length along `along`, width across it
	along, across = along.normalized(), across.normalized()
	corners = []
	for z in (0, height):
		for a, b in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
			corners.append(centre + along * (a * length / 2) + across * (b * width / 2) + UP * z)
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
	# Each catapult's shuttle (sliding forward along its track from battery),
	# its blast deflector (hinged at its forward edge, rising behind the jet)
	# and its control cab (rising out of the deck). Their shapes are the
	# photos' (layout.fittings); their places the deck plan's.
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
		node(name, hinge=battery, mesh=box(battery, along, across, s["length"], s["width"], s["height"]))
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
		cab = c.get("cab")
		if cab:
			k = fittings["cab"]
			centre = at(cab[0], top - k["height"], cab[1])
			name = f"catapult_{number}_cab"
			node(name, hinge=centre, mesh=box(centre, along, across, k["length"], k["width"], k["height"]))
			joint(name, UP, Vector(), UP, "raised while the catapults are manned", [[0, 0], [1, k["rise"]]], motion="slide")


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
	for p in i.get("prisms", []):
		for k, (x, z) in enumerate(p.get("upper") or p["outline"]):
			MARKS[f"island_{p['name']}_top_{k + 1}"] = (at(x, p["top"], z), "island")


def interpolate(x, xs, ys):
	# Piecewise linear, held at the ends
	if x <= xs[0]:
		return ys[0]
	for (x0, y0), (x1, y1) in zip(zip(xs, ys), zip(xs[1:], ys[1:])):
		if x <= x1:
			return y0 if x1 == x0 else y0 + (y1 - y0) * (x - x0) / (x1 - x0)
	return ys[-1]


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
	# along the sponsons' sloped underside to the foot of the gallery wall,
	# and up that wall to the deck's underside at the deck's edge. Below the
	# knuckle the hull is symmetric: its half-breadth at a height is read off
	# the stations either side (the transom the first of them), and ahead of
	# the last it narrows to the stem. Painted boot below the boot top, grey
	# above.
	h = LAYOUT.get("hull")
	if not h:
		return
	d = LAYOUT["deck"]
	under = d["height"] - d["thickness"]
	boot = h["boot"]
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

	def half(x, y):
		values = [interpolate(y, [p[0] for p in s["points"]], [p[1] for p in s["points"]]) for s in stations]
		value = interpolate(x, sx, values)
		if x > sx[-1]:
			front = ahead(y)
			value *= max(0.0, min(1.0, (front - x) / (front - sx[-1]))) if front > sx[-1] else 0.0
		return value

	def knuckle(x, side):
		line = sorted(h["knuckle"]["starboard" if side > 0 else "port"])
		y = max(interpolate(x, [p[0] for p in line], [p[1] for p in line]), low(x))
		return y, half(x, y)

	def gallery(x, side):
		line = sorted(h["gallery"]["starboard" if side > 0 else "port"])
		return interpolate(x, [p[0] for p in line], [p[1] for p in line])

	LOWER, UPPER = 6, 8
	rings = []
	count = max(2, int((bow - transom) / STEP) + 1)
	for k in range(count):
		x = transom + (bow - transom) * k / (count - 1)
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
		heights = [y0] + [y0 + (b - y0) * (j + 1) / LOWER for j in range(LOWER)] + [b + (lower - b) * (j + 1) / UPPER for j in range(UPPER)]
		sides = {}
		for side in (-1, 1):
			ky, kz = knuckles[side]
			points = [(y, half(x, y)) for y in heights] + [(ky, kz)]
			z = abs(edge(outlines, x, side))
			points += [(max(feet[side], ky), z), (under, z)]
			sides[side] = [at(x, y, side * z) for y, z in points]
		rings.append(sides[-1][::-1] + [at(x, y0, 0)] + sides[1])
	n = len(rings[0])
	vertices = [v for ring in rings for v in ring]
	faces, paints = [], []
	for i in range(len(rings) - 1):
		for j in range(n - 1):
			a, b = i * n + j, i * n + j + 1
			faces.append((a, a + n, b + n, b))
			paints.append("boot" if max(vertices[q].z for q in faces[-1]) <= boot + 1e-6 else "grey")
	faces.append(tuple(range(n)))   # the transom, facing aft
	faces.append(tuple(range(len(vertices) - 1, len(vertices) - n - 1, -1)))   # the bow's end, facing forward
	paints += ["grey", "grey"]
	node("hull", mesh=(vertices, faces, paints))
	if h.get("bulb"):
		b = h["bulb"]
		centre = at(*b["centre"])
		shape = Matrix.Translation(centre) @ Matrix.Diagonal((b["length"] / 2, b["width"] / 2, b["height"] / 2, 1))
		bulb = primitive(lambda bm: bmesh.ops.create_uvsphere(bm, u_segments=16, v_segments=8, radius=1.0, matrix=shape))
		node("hull_bulb", parent="hull", mesh=(bulb[0], bulb[1], ["boot"] * len(bulb[1])))
	waterline = [x for x in [transom + (bow - transom) * k / 120 for k in range(121)] if x <= ahead(0) and low(x) <= 0]
	CURVES["hull_waterline_starboard"] = ([at(x, 0, half(x, 0)) for x in waterline], "hull")
	for side, name in ((-1, "port"), (1, "starboard")):
		CURVES[f"hull_knuckle_{name}"] = ([at(x, knuckle(x, side)[0], side * knuckle(x, side)[1]) for x in [transom + (bow - transom) * k / 60 for k in range(61)]], "hull")
	front = ahead(0)
	entrance = math.degrees(math.atan2(half(front - 10, 0), 10))
	return {"draught": round(-min(keels), 3), "entrance": round(entrance, 2), "waterline": {"stern": round(waterline[0], 3), "stem": round(front, 3),
		"half": [[round(x, 2), round(half(x, 0), 3)] for x in waterline[:: max(1, len(waterline) // 30)]]}}


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
		if c.get("deflector"):
			f = c["deflector"]
			(px, pz), (sx, sz) = sorted(f["hinge"], key=lambda p: p[1])
			# the panel's heading: square to its hinge (port end to starboard
			# end), positive to port
			heading = math.degrees(math.atan2(sx - px, sz - pz))
			entry["deflector"] = {"x": round((px + sx) / 2, 3), "z": round((pz + sz) / 2, 3), "width": round(math.dist((px, pz), (sx, sz)), 3),
				"depth": f["depth"], "heading": round(heading, 3)}
		if c.get("cab"):
			entry["cab"] = c["cab"]
		out["catapults"].append(entry)
	for key in ("landing", "lens", "parking", "lights"):
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
	island()
	hulled = hull()
	if "--draft" not in args:
		deck_texture(facts)
	bpy.ops.export_scene.gltf(filepath=out[0], export_format="GLB", export_yup=True, use_selection=False,
		export_apply=False, export_animations=False, export_extras=False)
	Path(out[1]).write_text(json.dumps(ship_file(hulled), indent="\t") + "\n")
	if len(out) > 2:
		features = {"about": "The model's named points and curves, each on the node it rides on, at rest in the ship frame (build.py).",
			"landmarks": {name: {"at": exported(p), "node": n} for name, (p, n) in sorted(MARKS.items())},
			"curves": {name: {"points": [exported(p) for p in points], "node": n} for name, (points, n) in sorted(CURVES.items())}}
		Path(out[2]).write_text(json.dumps(features, indent="\t") + "\n")


main()
