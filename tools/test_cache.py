# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# Tests cache.py on small scenes of boxes: a key changes with every piece of
# what a bake comes from (a vertex's place, a face's winding, its shading,
# a sharp edge, its material, the object's name and place, a weighted shape
# key, a face of another part within reach) and with nothing else (the order
# faces were made in, the corner a face starts at, a part out of reach); an
# entry gives back the UVs it was baked on, face by face, and its arrays as
# they were; a build's faces differing from an entry's take nothing from it.
# Runs inside Blender:
#
#   systemd-run --user --scope --slice=probe.slice -p MemoryMax=6G -p MemorySwapMax=0 \
#     blender -b --factory-startup --python-exit-code 1 -P test_cache.py
import sys, tempfile, unittest
from pathlib import Path

import bpy
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cache  # noqa: E402

VERTICES = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0), (0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1)]
FACES = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]


def box(name, faces=FACES, vertices=VERTICES, location=(0, 0, 0), paints=None):
	# A closed box, its faces as given (`paints`: a material's name per face)
	mesh = bpy.data.meshes.new(name)
	mesh.from_pydata(vertices, [], faces)
	if paints:
		names = sorted(set(paints))
		for n in names:
			mesh.materials.append(bpy.data.materials.get(n) or bpy.data.materials.new(n))
		for polygon, n in zip(mesh.polygons, paints):
			polygon.material_index = names.index(n)
	mesh.update()
	obj = bpy.data.objects.new(name, mesh)
	bpy.context.scene.collection.objects.link(obj)
	obj.location = location
	return obj


def fresh():
	bpy.ops.wm.read_factory_settings(use_empty=True)


def key(objects, others=(), reach=0.3, spacing=0.05):
	k = cache.Key("test")
	k.meshes(objects)
	if others:
		k.surroundings(objects, list(others), reach, spacing)
	return k.hex()


def mapped(o):
	# Each face's corners' UVs, by the face's cycle and the corner's vertex:
	# {(cycle, vertex): uv}
	layer = o.data.uv_layers.active
	out = {}
	for p in o.data.polygons:
		ring = tuple(p.vertices)
		k = ring.index(min(ring))
		cycle = ring[k:] + ring[:k]
		for loop, vertex in zip(p.loop_indices, p.vertices):
			out[(cycle, vertex)] = tuple(round(float(c), 6) for c in layer.data[loop].uv)
	return out


def unwrapped(o, seed=1):
	# A UV layer with a distinct, known UV on every corner
	layer = o.data.uv_layers.new(name="UVMap")
	o.data.uv_layers.active = layer
	values = np.random.default_rng(seed).random((len(o.data.loops), 2)).astype(np.float32)
	layer.data.foreach_set("uv", values.ravel())
	return values


class KeyTest(unittest.TestCase):
	def setUp(self):
		fresh()

	def test_the_same_scene_keys_the_same(self):
		first = key([box("a", paints=["x"] * 6)])
		fresh()
		self.assertEqual(key([box("a", paints=["x"] * 6)]), first)

	def test_the_order_faces_were_made_in_does_not_count(self):
		first = key([box("a")])
		fresh()
		self.assertEqual(key([box("a", faces=FACES[::-1])]), first)

	def test_the_corner_a_face_starts_at_does_not_count(self):
		first = key([box("a")])
		fresh()
		turned = [f[2:] + f[:2] for f in FACES]
		self.assertEqual(key([box("a", faces=turned)]), first)

	def test_a_vertex_moved_counts(self):
		first = key([box("a")])
		fresh()
		moved = list(VERTICES)
		moved[6] = (1, 1, 1.001)
		self.assertNotEqual(key([box("a", vertices=moved)]), first)

	def test_a_face_turned_over_counts(self):
		first = key([box("a")])
		fresh()
		flipped = [tuple(reversed(FACES[0]))] + FACES[1:]
		self.assertNotEqual(key([box("a", faces=flipped)]), first)

	def test_shading_counts(self):
		o = box("a")
		first = key([o])
		o.data.polygons[2].use_smooth = True
		self.assertNotEqual(key([o]), first)

	def test_a_sharp_edge_counts(self):
		o = box("a")
		o.data.shade_smooth()
		first = key([o])
		o.data.set_sharp_from_angle(angle=0.5)
		self.assertNotEqual(key([o]), first)

	def test_a_faces_material_counts(self):
		first = key([box("a", paints=["x"] * 6)])
		fresh()
		self.assertNotEqual(key([box("a", paints=["x"] * 5 + ["y"])]), first)

	def test_the_objects_name_counts(self):
		first = key([box("a")])
		fresh()
		self.assertNotEqual(key([box("b")]), first)

	def test_the_objects_place_counts(self):
		o = box("a")
		first = key([o])
		o.location = (0, 0, 0.01)
		self.assertNotEqual(key([o]), first)

	def test_a_shape_key_counts_by_its_weight_and_its_shape_when_weighted(self):
		o = box("a")
		o.shape_key_add(name="Basis", from_mix=False)
		flex = o.shape_key_add(name="flex", from_mix=False)
		flex.value = 0.0   # Blender 5 gives a new key weight 1
		first = key([o])
		flex.data[6].co = (1, 1, 1.5)
		self.assertEqual(key([o]), first)   # unweighted, its shape bakes nowhere
		flex.value = 0.5
		weighted = key([o])
		self.assertNotEqual(weighted, first)
		flex.data[6].co = (1, 1, 1.7)
		reshaped = key([o])
		self.assertNotEqual(reshaped, weighted)
		flex.value = 0.7   # the same shape, weighted more
		self.assertNotEqual(key([o]), reshaped)

	def test_a_modifier_is_refused(self):
		o = box("a")
		o.modifiers.new("bevel", "BEVEL")
		with self.assertRaises(ValueError):
			key([o])

	def test_pieces_of_a_key_do_not_run_together(self):
		a, b = cache.Key("test"), cache.Key("test")
		a.add(b"ab", b"c")
		b.add(b"a", b"bc")
		self.assertNotEqual(a.hex(), b.hex())

	def test_the_group_and_the_code_count(self):
		self.assertNotEqual(cache.Key("one").hex(), cache.Key("two").hex())
		a, b = cache.Key("test"), cache.Key("test")
		a.code(key)
		b.code(mapped)
		self.assertNotEqual(a.hex(), b.hex())


class SurroundingsTest(unittest.TestCase):
	def setUp(self):
		fresh()

	def test_a_part_within_reach_counts(self):
		own = box("own")
		other = box("other", location=(1.2, 0, 0))   # 0.2 m off, within 0.3
		first = key([own], [other])
		other.location = (1.25, 0, 0)
		self.assertNotEqual(key([own], [other]), first)

	def test_a_part_moved_counts_where_it_now_is(self):
		# the surroundings alone, after a move Blender has not yet evaluated
		own = box("own")
		other = box("other", location=(5, 0, 0))
		before = cache.Key("test")
		before.surroundings([own], [other], 0.3, 0.05)
		other.location = (1.2, 0, 0)
		after = cache.Key("test")
		after.surroundings([own], [other], 0.3, 0.05)
		self.assertNotEqual(after.hex(), before.hex())

	def test_the_reach_counts_where_it_reaches_the_same_faces(self):
		own, other = box("own"), box("other", location=(5, 0, 0))
		self.assertNotEqual(key([own], [other], reach=0.3), key([own], [other], reach=0.4))

	def test_a_part_out_of_reach_does_not_count(self):
		own = box("own")
		other = box("other", location=(5, 0, 0))   # 4 m off
		first = key([own], [other])
		other.location = (6, 0, 0)
		self.assertEqual(key([own], [other]), first)

	def test_only_the_faces_within_reach_count(self):
		# a part of two faces, one 0.2 m off and one 10 m off: the far one
		# moved changes nothing, the near one moved does
		quads = [(1.2, 0, 0), (1.2, 1, 0), (1.2, 1, 1), (1.2, 0, 1), (11, 0, 0), (11, 1, 0), (11, 1, 1), (11, 0, 1)]

		def keyed(vertices):
			fresh()
			return key([box("own")], [box("other", vertices=vertices, faces=[(0, 1, 2, 3), (4, 5, 6, 7)])])

		first = keyed(quads)
		far, close = list(quads), list(quads)
		far[5] = (11, 1, 0.5)
		close[1] = (1.2, 1, 0.5)
		self.assertEqual(keyed(far), first)
		self.assertNotEqual(keyed(close), first)


class EntryTest(unittest.TestCase):
	def setUp(self):
		fresh()
		self.folder = tempfile.TemporaryDirectory()
		self.place = Path(self.folder.name) / "test-0123"

	def tearDown(self):
		self.folder.cleanup()

	def test_the_uvs_and_arrays_come_back_as_they_were(self):
		o = box("a")
		unwrapped(o)
		before = mapped(o)
		arrays = {"shade": np.random.default_rng(2).random((4, 4)).astype(np.float32), "mask": np.eye(4, dtype=bool), "part": np.arange(16, dtype=np.int32).reshape(4, 4)}
		cache.stored(self.place, [o], arrays)
		fresh()
		o = box("a")
		got = cache.restored(self.place, [o])
		self.assertEqual(o.data.uv_layers.active.name, "UVMap")
		self.assertEqual(mapped(o), before)
		self.assertEqual(sorted(got), sorted(arrays))
		for name, value in arrays.items():
			self.assertEqual(got[name].dtype, value.dtype)
			np.testing.assert_array_equal(got[name], value)

	def test_the_uvs_follow_each_face_made_in_another_order_or_from_another_corner(self):
		o = box("a")
		unwrapped(o)
		before = mapped(o)
		cache.stored(self.place, [o], {"x": np.zeros(1)})
		fresh()
		o = box("a", faces=[f[1:] + f[:1] for f in FACES[::-1]])
		self.assertIsNotNone(cache.restored(self.place, [o]))
		self.assertEqual(mapped(o), before)

	def test_a_face_twice_over_takes_both_its_uvs(self):
		doubled = FACES + [FACES[0]]
		o = box("a", faces=doubled)
		unwrapped(o)
		before = sorted(tuple(o.data.uv_layers.active.data[loop].uv) for p in o.data.polygons[:1] + o.data.polygons[-1:] for loop in p.loop_indices)
		cache.stored(self.place, [o], {"x": np.zeros(1)})
		fresh()
		o = box("a", faces=doubled)
		self.assertIsNotNone(cache.restored(self.place, [o]))
		after = sorted(tuple(o.data.uv_layers.active.data[loop].uv) for p in o.data.polygons[:1] + o.data.polygons[-1:] for loop in p.loop_indices)
		self.assertEqual(after, before)

	def test_other_faces_take_nothing(self):
		o = box("a")
		unwrapped(o)
		cache.stored(self.place, [o], {"x": np.zeros(1)})
		for faces in (FACES[:5], FACES + [FACES[0]], [tuple(reversed(FACES[0]))] + FACES[1:]):
			fresh()
			o = box("a", faces=faces)
			values = unwrapped(o, seed=9)
			self.assertIsNone(cache.restored(self.place, [o]), faces)
			uv = np.empty(len(o.data.loops) * 2, np.float32)
			o.data.uv_layers.active.data.foreach_get("uv", uv)
			np.testing.assert_array_equal(uv.reshape(-1, 2), values)   # nothing changed
		fresh()
		self.assertIsNone(cache.restored(self.place, [box("b")]))   # another part
		self.assertIsNone(cache.restored(self.place.with_name("test-none"), [box("a")]))   # no entry

	def test_a_part_that_differs_leaves_every_part_as_it_was(self):
		a, b = box("a"), box("b", location=(3, 0, 0))
		unwrapped(a)
		unwrapped(b)
		cache.stored(self.place, [a, b], {"x": np.zeros(1)})
		fresh()
		a, b = box("a"), box("b", faces=FACES[:5], location=(3, 0, 0))
		values = unwrapped(a, seed=9)
		self.assertIsNone(cache.restored(self.place, [a, b]))
		uv = np.empty(len(a.data.loops) * 2, np.float32)
		a.data.uv_layers.active.data.foreach_get("uv", uv)
		np.testing.assert_array_equal(uv.reshape(-1, 2), values)   # the part that matched, untouched

	def test_a_part_with_no_uvs_keeps_none(self):
		o = box("a")
		cache.stored(self.place, [o], {"x": np.zeros(1)})
		fresh()
		o = box("a")
		self.assertIsNotNone(cache.restored(self.place, [o]))
		self.assertEqual(len(o.data.uv_layers), 0)

	def test_a_group_keeps_its_newest_entries(self):
		import os, time
		o = box("a")
		folder = Path(self.folder.name)
		other = folder / "test-old-0000"   # another group's, its name starting with this one's, older than all
		cache.stored(other, [o], {"x": np.zeros(1)})
		now = time.time()
		os.utime(other, (now - 1000, now - 1000))
		names = [f"test-{i:04d}" for i in range(cache.KEPT + 2)]
		for i, name in enumerate(names):
			cache.stored(folder / name, [o], {"x": np.zeros(1)})
			os.utime(folder / name, (now - 100 + i, now - 100 + i))   # each older than the next one stored
		self.assertEqual(sorted(p.name for p in folder.glob("test-*") if p != other), names[-cache.KEPT :])
		self.assertTrue(other.exists())


class FetchTest(unittest.TestCase):
	def setUp(self):
		fresh()
		self.folder = tempfile.TemporaryDirectory()

	def tearDown(self):
		self.folder.cleanup()

	def test_a_second_fetch_takes_the_bake_from_the_cache_with_its_uvs(self):
		baked = []

		def bake(o, seed):
			def run():
				baked.append(seed)
				unwrapped(o, seed)
				return {"shade": np.full((2, 2), seed, np.float32)}
			return run

		o = box("a")
		first = cache.fetch(self.folder.name, "test", cache.Key("one"), [o], bake(o, 1))
		before = mapped(o)
		fresh()
		o = box("a")
		again = cache.fetch(self.folder.name, "test", cache.Key("one"), [o], bake(o, 2))
		self.assertEqual(baked, [1])
		self.assertEqual(mapped(o), before)
		np.testing.assert_array_equal(again["shade"], first["shade"])
		# another key bakes; no folder bakes every time and keeps nothing
		cache.fetch(self.folder.name, "test", cache.Key("two"), [o], bake(o, 3))
		cache.fetch(None, "test", cache.Key("one"), [o], bake(o, 4))
		self.assertEqual(baked, [1, 3, 4])
		self.assertEqual(len(list(Path(self.folder.name).glob("test-*"))), 2)

	def test_an_entry_used_counts_as_the_latest(self):
		import os, time
		o = box("a")
		folder = Path(self.folder.name)
		now = time.time()
		keys = [cache.Key(f"k{i}") for i in range(cache.KEPT + 1)]
		for i, key in enumerate(keys[: cache.KEPT]):
			cache.fetch(folder, "test", key, [o], lambda: {"x": np.zeros(1)})
			place = cache.entry(folder, "test", key.hex())
			os.utime(place, (now - 100 + i, now - 100 + i))
		used = cache.entry(folder, "test", keys[0].hex())   # the oldest, used again
		cache.fetch(folder, "test", keys[0], [o], lambda: self.fail("baked an entry the cache holds"))
		cache.fetch(folder, "test", keys[-1], [o], lambda: {"x": np.zeros(1)})
		self.assertTrue(used.exists())
		self.assertFalse(cache.entry(folder, "test", keys[1].hex()).exists())   # the oldest unused went


if __name__ == "__main__":
	result = unittest.main(argv=[sys.argv[0]], exit=False).result
	sys.exit(0 if result.wasSuccessful() else 1)
