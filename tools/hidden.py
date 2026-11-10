# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# Faces no view can see, for the Blender builds: a triangle every one of
# whose sample points lies inside another closed shell, or against one
# (within `depth`, facing into it). A build removes them before it unwraps,
# so they cost neither triangles nor atlas texels; its tests find any left.
#
# Only parts that move together hide each other's faces: `group` gives each
# object a key, the same for objects nothing between which moves (no joint,
# no part a loadout shows or hides), and a face is judged against the shells
# of its own group alone. A fin's root against the body stays when the fin
# turns, since turned it stands off the body; a pylon's against the wing when
# the loadout may hide the pylon.
#
# Runs inside Blender (bmesh, mathutils).
import bmesh
import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

# Two rays for the inside test, neither along an axis nor in a plane the
# builds' faces lie in; a point is inside only when both cross an odd number
# of faces, so a ray grazing a shared edge cannot call it inside
RAYS = (Vector((0.5773, 0.6012, 0.5523)).normalized(), Vector((-0.4317, 0.7421, -0.5125)).normalized())
# How far past a face a ray goes on, metres (0.0004 in, thinner than any part)
STEP = 1e-5


class Shell:
	# One connected piece of an object's surface, in world space
	def __init__(self, faces):
		index, vertices = {}, []
		polygons = []
		for f in faces:
			ring = []
			for v in f.verts:
				if v not in index:
					index[v] = len(vertices)
					vertices.append(v.co.copy())
				ring.append(index[v])
			polygons.append(ring)
		self.tree = BVHTree.FromPolygons(vertices, polygons)
		self.low = Vector(tuple(min(v[k] for v in vertices) for k in range(3)))
		self.high = Vector(tuple(max(v[k] for v in vertices) for k in range(3)))
		edges = {e for f in faces for e in f.edges}
		self.closed = all(len(e.link_faces) == 2 for e in edges)

	def near(self, p, depth):
		return all(self.low[k] - depth <= p[k] <= self.high[k] + depth for k in range(3))

	def inside(self, p):
		for ray in RAYS:
			count, origin = 0, p.copy()
			while True:
				hit = self.tree.ray_cast(origin, ray)[0]
				if hit is None:
					break
				count += 1
				# on past the face: the tree holds single-precision
				# coordinates, whose step at a jet's length (1e-6 m at 10 m)
				# would find the same face again
				origin = hit + ray * STEP
			if count % 2 == 0:
				return False
		return True

	def covers(self, p, normal, depth):
		# The point lies inside this shell, or on a face of it (within depth)
		# with its own face turned into that one; every face in reach, not the
		# nearest alone, since at an edge the nearest may be a side face
		if not self.near(p, depth):
			return False
		if any(facing.dot(normal) < -0.7 for _, facing, _, _ in self.tree.find_nearest_range(p, depth)):
			return True
		return self.closed and self.inside(p)


def welded(obj):
	# The object's surface in world space, its coincident vertices merged (an
	# imported glTF splits them at every seam), each face carrying the index
	# of the polygon it came from, wound outward (a mirrored object's world
	# matrix turns its winding inside out)
	bm = bmesh.new()
	bm.from_mesh(obj.data)
	bm.transform(obj.matrix_world)
	if obj.matrix_world.determinant() < 0:
		bmesh.ops.reverse_faces(bm, faces=bm.faces)
	layer = bm.faces.layers.int.new("polygon")
	for f in bm.faces:
		f[layer] = f.index
	bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-7)
	bm.faces.ensure_lookup_table()
	return bm, layer


def pieces(bm):
	# The connected pieces of a surface, each a list of its faces
	seen, out = set(), []
	for start in bm.faces:
		if start in seen:
			continue
		piece, stack = [], [start]
		seen.add(start)
		while stack:
			f = stack.pop()
			piece.append(f)
			for e in f.edges:
				for g in e.link_faces:
					if g not in seen:
						seen.add(g)
						stack.append(g)
		out.append(piece)
	return out


def samples(corners, steps):
	# Points over a triangle: its middle first (most triangles are seen there,
	# and the search stops at the first point seen), then a grid, corners and
	# edges included
	a, b, c = corners
	yield (a + b + c) / 3
	for i in range(steps + 1):
		for j in range(steps + 1 - i):
			k = steps - i - j
			yield (a * i + b * j + c * k) / steps


def faces(objects, group, depth=0.0005, steps=6):
	# {object name: {polygon index: the vertex indices of each of its
	# triangles no view can see}}. Judged by triangle, as the model is drawn:
	# a polygon partly seen can have whole triangles hidden. Each object's
	# place is its world matrix, which a build that has only just parented
	# and placed its objects has not yet had evaluated
	bpy.context.view_layer.update()
	surfaces = {}
	for obj in objects:
		bm, layer = welded(obj)
		shells, owner = [], {}
		for piece in pieces(bm):
			shell = Shell(piece)
			shells.append(shell)
			for f in piece:
				owner[f[layer]] = shell
		bm.free()
		surfaces[obj.name] = (shells, owner)
	keys = {obj.name: group(obj) for obj in objects}
	out = {}
	for obj in objects:
		_, owner = surfaces[obj.name]
		others = [s for name, (shells, _) in surfaces.items() if keys[name] == keys[obj.name] for s in shells]
		mesh, matrix = obj.data, obj.matrix_world
		flip = -1 if matrix.determinant() < 0 else 1
		mesh.calc_loop_triangles()
		found = {}
		for t in mesh.loop_triangles:
			own = owner.get(t.polygon_index)
			rest = [s for s in others if s is not own]
			corners = [matrix @ mesh.vertices[i].co for i in t.vertices]
			normal = (corners[1] - corners[0]).cross(corners[2] - corners[0]) * flip
			if not rest or normal.length == 0:
				continue
			normal.normalize()
			if all(any(s.covers(p, normal, depth) for s in rest) for p in samples(corners, steps)):
				found.setdefault(t.polygon_index, []).append(tuple(t.vertices))
		out[obj.name] = found
	return out


def remove(objects, group, **options):
	# Removes the triangles no view can see from each object's mesh, and the
	# vertices nothing then uses: {object name: triangles removed}. Each mesh
	# is first cut into triangles, a quad across its first corner's diagonal
	# as the mesh's own triangles split it, so the triangles judged are the
	# ones exported: the exporter's split of a polygon need not be the
	# mesh's (a quad judged whole was exported with a hidden half). A twisted
	# quad the build split itself is already two triangles
	for obj in objects:
		bm = bmesh.new()
		bm.from_mesh(obj.data)
		bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3], quad_method="FIXED")
		bm.to_mesh(obj.data)
		bm.free()
	found = faces(objects, group, **options)
	counts = {}
	for obj in objects:
		gone = found.get(obj.name)
		if not gone:
			continue
		bm = bmesh.new()
		bm.from_mesh(obj.data)
		bm.faces.ensure_lookup_table()
		bmesh.ops.delete(bm, geom=[bm.faces[i] for i in gone], context="FACES_ONLY")
		bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
		bm.to_mesh(obj.data)
		bm.free()
		obj.data.update()
		counts[obj.name] = len(gone)
	return counts


def report(glb, points):
	# The model's hidden triangles as its tests read them: {object name:
	# [triangles, square inches]}, each object grouped as the builds group
	# it: by the joint it rides in its points file (the joints a build
	# writes), or on its own if it has shape keys (the F/A-18C's flexing wing)
	import json
	import mathutils
	bpy.ops.wm.read_factory_settings(use_empty=True)
	bpy.ops.import_scene.gltf(filepath=glb)
	joints = set(json.loads(open(points).read())["joints"])

	def rider(obj):
		while obj is not None:
			if obj.name in joints or (obj.data is not None and getattr(obj.data, "shape_keys", None)):
				return obj.name
			obj = obj.parent
		return None

	out = {}
	for name, polygons in faces([o for o in bpy.data.objects if o.type == "MESH"], rider).items():
		if polygons:
			obj = bpy.data.objects[name]
			corners = [[obj.matrix_world @ obj.data.vertices[i].co for i in t] for found in polygons.values() for t in found]
			out[name] = [len(corners), round(sum(mathutils.geometry.area_tri(*c) for c in corners) / 0.0254 ** 2, 3)]
	return out


if __name__ == "__main__":
	# blender -b --factory-startup -P hidden.py -- MODEL.glb POINTS.json: prints
	# "hidden" and the JSON of report()
	import json, sys
	glb, points = sys.argv[sys.argv.index("--") + 1 :][:2]
	print("hidden", json.dumps(report(glb, points)))
