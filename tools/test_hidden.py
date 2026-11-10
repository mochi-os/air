# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# Tests hidden.py on small scenes of boxes: a box inside another, one against
# another's face, boxes in different groups, a box placed through a parent
# whose matrices Blender has not yet evaluated, and mirrored boxes on either
# side. Runs inside Blender:
#
#   systemd-run --user --scope --slice=probe.slice -p MemoryMax=6G -p MemorySwapMax=0 \
#     blender -b --factory-startup --python-exit-code 1 -P test_hidden.py
import sys, unittest
from pathlib import Path

import bpy
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hidden  # noqa: E402

# Less than hidden.py's depth (0.0005): a face this far off another counts as against it
GAP = 0.0002


def box(name, low, high, parent=None, scale=None, location=None):
	# A closed box from corner `low` to `high`, wound outward, in its own
	# frame; `location` and `scale` place it, under `parent` if given
	(x0, y0, z0), (x1, y1, z1) = low, high
	vertices = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0), (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
	faces = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
	mesh = bpy.data.meshes.new(name)
	mesh.from_pydata(vertices, [], faces)
	mesh.update()
	obj = bpy.data.objects.new(name, mesh)
	bpy.context.scene.collection.objects.link(obj)
	if parent:
		obj.parent = parent
	if location:
		obj.location = location
	if scale:
		obj.scale = scale
	return obj


def hidden_of(found, name):
	# the number of an object's triangles found hidden
	return sum(len(t) for t in found.get(name, {}).values())


def faces(*objects, group=lambda o: None):
	return hidden.faces(list(objects), group)


class HiddenTest(unittest.TestCase):
	def setUp(self):
		bpy.ops.wm.read_factory_settings(use_empty=True)

	def test_a_box_inside_another_is_hidden_and_hides_nothing(self):
		outer = box("outer", (0, 0, 0), (1, 1, 1))
		inner = box("inner", (0.2, 0.2, 0.2), (0.4, 0.4, 0.4))
		found = faces(outer, inner)
		self.assertEqual(hidden_of(found, "inner"), 12)
		self.assertEqual(hidden_of(found, "outer"), 0)

	def test_a_box_part_inside_keeps_what_shows(self):
		# sunk halfway into the other through its top: only its bottom lies
		# wholly inside; its sides cross the surface and its top stands out
		outer = box("outer", (0, 0, 0), (1, 1, 1))
		post = box("post", (0.4, 0.4, 0.8), (0.6, 0.6, 1.2))
		found = faces(outer, post)
		self.assertEqual(hidden_of(found, "post"), 2)
		self.assertEqual(hidden_of(found, "outer"), 0)

	def test_a_face_against_another_facing_into_it_is_hidden(self):
		# a small box standing on the big one's top, a hair above it: its
		# bottom faces into the top; the top, larger, is not wholly covered
		base = box("base", (0, 0, 0), (1, 1, 1))
		block = box("block", (0.4, 0.4, 1 + GAP), (0.6, 0.6, 1.2))
		found = faces(base, block)
		self.assertEqual(hidden_of(found, "block"), 2)
		self.assertEqual(hidden_of(found, "base"), 0)

	def test_faces_level_side_by_side_are_seen(self):
		# two boxes side by side, a hair apart: the two faces between them face
		# each other and are hidden; their tops, level, face the same way and
		# are seen
		left = box("left", (0, 0, 0), (1, 1, 1))
		right = box("right", (1 + GAP, 0, 0), (2, 1, 1))
		found = faces(left, right)
		self.assertEqual(hidden_of(found, "left") + hidden_of(found, "right"), 4)   # only the two faces that face each other

	def test_parts_that_move_apart_hide_nothing_of_each_other(self):
		outer = box("outer", (0, 0, 0), (1, 1, 1))
		inner = box("inner", (0.2, 0.2, 0.2), (0.4, 0.4, 0.4))
		found = faces(outer, inner, group=lambda o: o.name)
		self.assertEqual(found, {"outer": {}, "inner": {}})

	def test_a_part_is_judged_where_its_parent_puts_it(self):
		# placed inside through a parent's offset that Blender has not yet
		# evaluated: at its own frame's origin it would lie outside
		outer = box("outer", (0, 0, 0), (1, 1, 1))
		holder = bpy.data.objects.new("holder", None)
		bpy.context.scene.collection.objects.link(holder)
		holder.location = (0.5, 0.5, 2.5)
		inner = box("inner", (-0.1, -0.1, -0.1), (0.1, 0.1, 0.1), parent=holder, location=(0, 0, -2))
		found = faces(outer, inner)
		self.assertEqual(hidden_of(found, "inner"), 12)

	def test_a_mirrored_part_faces_the_way_it_is_drawn(self):
		# a box mirrored across x, against the big one's +x face: its face
		# toward the big one is hidden, judged by the normal it is drawn with
		base = box("base", (0, 0, 0), (1, 1, 1))
		block = box("block", (-1.2, 0.4, 0.4), (-1 - GAP, 0.6, 0.6), scale=(-1, 1, 1))
		found = faces(base, block)
		self.assertEqual(hidden_of(found, "block"), 2)

	def test_a_mirrored_part_hides_what_faces_into_it(self):
		# the big box mirrored: a small box against its face is hidden there,
		# which needs the big box's faces wound outward once mirrored
		base = box("base", (-1, 0, 0), (0, 1, 1), scale=(-1, 1, 1))
		block = box("block", (1 + GAP, 0.4, 0.4), (1.2, 0.6, 0.6))
		found = faces(base, block)
		self.assertEqual(hidden_of(found, "block"), 2)

	def test_remove_leaves_nothing_hidden_and_keeps_what_shows(self):
		outer = box("outer", (0, 0, 0), (1, 1, 1))
		post = box("post", (0.4, 0.4, 0.8), (0.6, 0.6, 1.2))
		counts = hidden.remove([outer, post], lambda o: None)
		self.assertEqual(counts, {"post": 2})
		self.assertEqual(len(post.data.polygons), 10)   # its four sides and top, in triangles
		self.assertEqual(faces(outer, post), {"outer": {}, "post": {}})
		self.assertEqual(len(outer.data.polygons), 12)

	def test_a_polygon_partly_hidden_keeps_the_triangles_that_show(self):
		# a quad lying in a box but for one corner: of its two triangles, split
		# as the mesh splits it, the one wholly inside goes and the other stays
		outer = box("outer", (0, 0, 0), (1, 1, 1))
		mesh = bpy.data.meshes.new("plate")
		mesh.from_pydata([(0.2, 0.2, 0.5), (0.8, 0.2, 0.5), (0.8, 0.8, 0.5), (0.2, 3.0, 0.5)], [], [(0, 1, 2, 3)])
		mesh.update()
		plate = bpy.data.objects.new("plate", mesh)
		bpy.context.scene.collection.objects.link(plate)
		mesh.calc_loop_triangles()
		inside = [t for t in mesh.loop_triangles if all(mesh.vertices[i].co.y < 1 for i in t.vertices)]
		self.assertEqual(len(inside), 1)   # the quad split across 0-2: the triangle 0, 1, 2 inside
		counts = hidden.remove([outer, plate], lambda o: None)
		self.assertEqual(counts, {"plate": 1})
		self.assertEqual([len(p.vertices) for p in plate.data.polygons], [3])
		self.assertTrue(any(v.co.y > 2 for v in plate.data.vertices))

if __name__ == "__main__":
	result = unittest.main(argv=[sys.argv[0]], exit=False).result
	if not result.wasSuccessful():
		raise SystemExit(1)
