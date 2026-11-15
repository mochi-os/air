# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# Tests for pack.py: the merge of the parts that never move, the meshes named
# after their parts, and the check of a packed model against its build, on
# small models written here; and, where gltfpack and node are installed, a
# model packed and decoded the way the game reads it.
#
# usage: python3 -I test_pack.py
import json, shutil, struct, sys, unittest
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import pack  # noqa: E402

# grey and lettering draw images, red does not
PAINTS = {"grey": True, "red": False, "lettering": True}


def square(x, y=0.0, z=0.0, size=1.0):
	# Two triangles facing +y, one corner at (x, y, z)
	a, b, c, d = [x, y, z], [x + size, y, z], [x + size, y, z + size], [x, y, z + size]
	return np.array([[a, c, b], [a, d, c]], np.float32)


def glb(nodes, paints=PAINTS, image=b"\x89PNG fake image bytes"):
	# A model from [{name, parts: [(triangles, paint)], translation, scale, rotation, children: [names],
	# mesh: a name for the mesh, uv: a function of the corners}]: each corner its own vertex, its normal
	# from the winding, its UV from where it lies unless uv says
	names = list(paints)
	gltf = {"asset": {"version": "2.0"}, "scene": 0, "nodes": [], "meshes": [], "accessors": [], "bufferViews": [],
		"materials": [{"name": n, "pbrMetallicRoughness": dict({"baseColorFactor": [0.3, 0.32, 0.33, 1.0]}, **({"baseColorTexture": {"index": 0}} if t else {}))} for n, t in paints.items()],
		"images": [{"name": "grey", "mimeType": "image/png", "bufferView": 0}], "textures": [{"source": 0}]}
	chunks = [image + b"\0" * (-len(image) % 4)]
	gltf["bufferViews"].append({"buffer": 0, "byteOffset": 0, "byteLength": len(image)})

	def add(values, kind, kind_name, target):
		blob = np.ascontiguousarray(values).tobytes()
		offset = sum(len(c) for c in chunks)
		chunks.append(blob + b"\0" * (-len(blob) % 4))
		gltf["bufferViews"].append({"buffer": 0, "byteOffset": offset, "byteLength": len(blob), "target": target})
		a = {"bufferView": len(gltf["bufferViews"]) - 1, "componentType": kind, "count": len(values), "type": kind_name}
		if kind_name == "VEC3":
			a["min"], a["max"] = values.min(axis=0).tolist(), values.max(axis=0).tolist()
		gltf["accessors"].append(a)
		return len(gltf["accessors"]) - 1

	index = {n["name"]: i for i, n in enumerate(nodes) if n.get("name")}
	for spec in nodes:
		node = {k: spec[k] for k in ("name", "translation", "scale", "rotation") if spec.get(k) is not None}
		if spec.get("parts"):
			primitives = []
			for tris, paint in spec["parts"]:
				tris = np.asarray(tris, np.float32)
				corners = tris.reshape(-1, 3)
				normal = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
				normal = np.repeat(normal / np.maximum(np.linalg.norm(normal, axis=1), 1e-12)[:, None], 3, axis=0).astype(np.float32)
				uv = (spec["uv"](corners) if spec.get("uv") else corners[:, [0, 2]] * 0.1).astype(np.float32)
				primitives.append({"attributes": {"POSITION": add(corners, 5126, "VEC3", 34962), "NORMAL": add(normal, 5126, "VEC3", 34962),
					"TEXCOORD_0": add(uv, 5126, "VEC2", 34962)}, "indices": add(np.arange(len(corners), dtype=np.uint16), 5123, "SCALAR", 34963),
					"material": names.index(paint)})
			gltf["meshes"].append({"name": spec.get("mesh", spec.get("name")), "primitives": primitives})
			node["mesh"] = len(gltf["meshes"]) - 1
		if spec.get("children"):
			node["children"] = [c if isinstance(c, int) else index[c] for c in spec["children"]]
		gltf["nodes"].append(node)
	children = {c for n in gltf["nodes"] for c in n.get("children", [])}
	gltf["scenes"] = [{"nodes": [i for i in range(len(nodes)) if i not in children]}]
	binary = b"".join(chunks)
	gltf["buffers"] = [{"byteLength": len(binary)}]
	return pack.write(gltf, binary)


JOINTS = {"lift", "arm"}


def ship(**change):
	# A small ship: two parts that never move in grey, one in red, a lift (a joint) holding an arm (a
	# joint) holding a bolt (no joint, so moving with it) on a fixed frame, and the vehicles (kept whole
	# by name); change replaces any part
	parts = {
		"hull": {"name": "hull", "parts": [(square(0), "grey"), (square(0, 1), "lettering")], "children": ["lift"]},
		"island": {"name": "island", "parts": [(square(2), "grey"), (square(2, 1), "red")], "translation": [0, 0, 3]},
		"lift": {"name": "lift", "parts": [(square(4), "grey")], "translation": [1, 0, 0], "children": ["arm"]},
		"arm": {"name": "arm", "parts": [(square(6), "red")], "translation": [0, 1, 0], "children": ["bolt"]},
		"bolt": {"name": "bolt", "parts": [(square(7), "grey")]},
		"vehicles": {"name": "vehicles", "parts": [(square(8), "grey"), (square(8, 1), "red")]},
	}
	parts.update(change)
	return glb([p for p in parts.values() if p is not None])


def mesh(gltf, name):
	# The mesh a named node draws
	return gltf["meshes"][next(n["mesh"] for n in gltf["nodes"] if n.get("name") == name)]


def merged(data):
	return pack.merge(data, JOINTS, keep=("vehicles",))


def check(build, game):
	return pack.compare(build, game, JOINTS, keep=("vehicles",))


class MergeTest(unittest.TestCase):
	def test_the_parts_that_never_move_draw_from_one_node_a_primitive_a_paint(self):
		build = ship()
		out = merged(build)
		gltf, _ = pack.read(out)
		names = [n.get("name") for n in gltf["nodes"]]
		self.assertNotIn("island", names)
		self.assertIn("hull", names)   # it holds the lift
		self.assertNotIn("mesh", gltf["nodes"][names.index("hull")])
		one = mesh(gltf, pack.MERGED)
		self.assertEqual(sorted(gltf["materials"][p["material"]]["name"] for p in one["primitives"]), ["grey", "lettering", "red"])
		self.assertEqual(pack.draws(build), 9)
		self.assertEqual(pack.draws(out), 3 + 1 + 1 + 1 + 2)
		self.assertEqual(check(build, out), [])

	def test_a_moved_part_lands_in_the_world_frame(self):
		build = ship()
		gltf, binary = pack.read(merged(build))
		red = next(p for p in mesh(gltf, pack.MERGED)["primitives"] if gltf["materials"][p["material"]]["name"] == "red")
		corners = pack.accessor(gltf, binary, red["attributes"]["POSITION"])
		# the island's red square, (2, 1, 0) up to (3, 1, 1), carried 3 to starboard
		np.testing.assert_allclose(corners.min(axis=0), [2, 1, 3], atol=1e-6)
		np.testing.assert_allclose(corners.max(axis=0), [3, 1, 4], atol=1e-6)

	def test_a_turned_part_turns_its_normals(self):
		# the island turned a quarter about x: its squares, facing +y, face +z
		s = 0.5 ** 0.5
		build = ship(island={"name": "island", "parts": [(square(2), "grey")], "rotation": [s, 0, 0, s]})
		gltf, binary = pack.read(merged(build))
		grey = next(p for p in mesh(gltf, pack.MERGED)["primitives"] if gltf["materials"][p["material"]]["name"] == "grey")
		corners = pack.accessor(gltf, binary, grey["attributes"]["POSITION"])
		normals = pack.accessor(gltf, binary, grey["attributes"]["NORMAL"])
		turned = corners[:, 0] > 1.5   # the island's, at x 2..3; the hull's lie at 0..1
		self.assertEqual(int(turned.sum()), 6)
		np.testing.assert_allclose(corners[turned][:, 2], 0, atol=1e-6)   # lying in z 0 now, y down to -1
		np.testing.assert_allclose(normals[turned], [[0, 0, 1]] * 6, atol=1e-6)
		self.assertEqual(check(build, merged(build)), [])

	def test_a_mirrored_part_keeps_facing_out(self):
		build = ship(island={"name": "island", "parts": [(square(2), "grey")], "scale": [-1, 1, 1]})
		gltf, binary = pack.read(merged(build))
		grey = next(p for p in mesh(gltf, pack.MERGED)["primitives"] if gltf["materials"][p["material"]]["name"] == "grey")
		corners = pack.accessor(gltf, binary, grey["attributes"]["POSITION"])
		index = pack.accessor(gltf, binary, grey["indices"]).reshape(-1, 3)
		normals = pack.accessor(gltf, binary, grey["attributes"]["NORMAL"])
		mirrored = corners[index][:, :, 0].max(axis=1) <= 0   # the island's, at x -3..-2
		self.assertEqual(int(mirrored.sum()), 2)
		for t in index[mirrored]:
			front = np.cross(corners[t[1]] - corners[t[0]], corners[t[2]] - corners[t[0]])
			# the square faced +y and still does: the winding turned with the mirror, the normal kept
			self.assertGreater(front[1], 0)
			np.testing.assert_allclose(normals[t], [[0, 1, 0]] * 3, atol=1e-6)
		self.assertEqual(check(build, merged(build)), [])

	def test_the_joints_and_the_kept_parts_stay_whole(self):
		build = ship()
		gltf, binary = pack.read(merged(build))
		source, sbinary = pack.read(build)
		for name in ("lift", "arm", "bolt", "vehicles"):
			a = next(n for n in gltf["nodes"] if n.get("name") == name)
			b = next(n for n in source["nodes"] if n.get("name") == name)
			self.assertEqual({k: v for k, v in a.items() if k not in ("mesh", "children")}, {k: v for k, v in b.items() if k not in ("mesh", "children")})
			pa, pb = gltf["meshes"][a["mesh"]]["primitives"], source["meshes"][b["mesh"]]["primitives"]
			self.assertEqual(len(pa), len(pb))
			for x, y in zip(pa, pb):
				np.testing.assert_array_equal(pack.accessor(gltf, binary, x["attributes"]["POSITION"]), pack.accessor(source, sbinary, y["attributes"]["POSITION"]))
		# the bolt still hangs from the arm, the arm from the lift, the lift from the hull
		names = [n.get("name") for n in gltf["nodes"]]
		self.assertIn(names.index("bolt"), gltf["nodes"][names.index("arm")]["children"])
		self.assertIn(names.index("arm"), gltf["nodes"][names.index("lift")]["children"])
		self.assertIn(names.index("lift"), gltf["nodes"][names.index("hull")]["children"])

	def test_the_images_are_copied_as_they_were(self):
		build = glb([{"name": "hull", "parts": [(square(0), "grey")]}], image=b"\x89PNG" + bytes(range(200)))
		gltf, binary = pack.read(merged(build))
		v = gltf["bufferViews"][gltf["images"][0]["bufferView"]]
		self.assertEqual(binary[v["byteOffset"]:v["byteOffset"] + v["byteLength"]], b"\x89PNG" + bytes(range(200)))


class NamesTest(unittest.TestCase):
	def test_each_mesh_is_named_after_its_part_and_a_shared_one_described_for_each(self):
		gltf, binary = pack.read(glb([
			{"name": "one", "parts": [(square(0), "grey")], "mesh": None, "children": [1]},
			{"name": None, "parts": [(square(1), "red")], "mesh": None},
			{"name": "two", "parts": [(square(2), "grey")], "mesh": None}]))
		gltf["nodes"][1].pop("name", None)
		gltf["nodes"][2]["mesh"] = gltf["nodes"][0]["mesh"]   # two shares one's mesh, as gltfpack shares alike meshes
		named, nbinary = pack.read(pack.names(pack.write(gltf, binary)))
		self.assertEqual(named["meshes"][named["nodes"][0]["mesh"]]["name"], "one")
		self.assertEqual(named["meshes"][named["nodes"][1]["mesh"]]["name"], "one")   # unnamed: its part's
		self.assertEqual(named["meshes"][named["nodes"][2]["mesh"]]["name"], "two")
		self.assertNotEqual(named["nodes"][2]["mesh"], named["nodes"][0]["mesh"])
		# the copy reads the same data
		self.assertEqual(named["meshes"][named["nodes"][2]["mesh"]]["primitives"], named["meshes"][named["nodes"][0]["mesh"]]["primitives"])
		self.assertEqual(nbinary, binary)


def edit(data, change):
	# The model with change(gltf, arrays) applied: arrays maps (mesh, primitive, attribute) to its
	# values, the indices under "indices"; everything rewritten after
	gltf, binary = pack.read(data)
	arrays = {}
	for m, mesh in enumerate(gltf["meshes"]):
		for k, p in enumerate(mesh["primitives"]):
			for a, i in list(p["attributes"].items()) + [("indices", p["indices"])]:
				arrays[(m, k, a)] = pack.accessor(gltf, binary, i).copy()
	change(gltf, arrays)
	out = pack.Writer()
	for image in gltf.get("images", []):
		v = gltf["bufferViews"][image["bufferView"]]
		image["bufferView"] = out.view(binary[v.get("byteOffset", 0):v.get("byteOffset", 0) + v["byteLength"]])
	for m, mesh in enumerate(gltf["meshes"]):
		for k, p in enumerate(mesh["primitives"]):
			for a, i in list(p["attributes"].items()):
				p["attributes"][a] = out.accessor(arrays[(m, k, a)], gltf["accessors"][i], 34962)
			p["indices"] = out.accessor(arrays[(m, k, "indices")], gltf["accessors"][p["indices"]], 34963)
	gltf["accessors"], gltf["bufferViews"] = out.accessors, out.views
	blob = b"".join(out.chunks)
	gltf["buffers"] = [{"byteLength": len(blob)}]
	return pack.write(gltf, blob)


def where(gltf, node, paint):
	# (mesh, primitive) of a node's paint
	m = next(n["mesh"] for n in gltf["nodes"] if n.get("name") == node)
	return m, next(k for k, p in enumerate(gltf["meshes"][m]["primitives"]) if gltf["materials"][p["material"]]["name"] == paint)


class CompareTest(unittest.TestCase):
	@classmethod
	def setUpClass(cls):
		cls.build = ship()
		cls.game = merged(cls.build)

	def found(self, change):
		return check(self.build, edit(self.game, change))

	def test_alike_finds_nothing(self):
		self.assertEqual(self.found(lambda g, a: None), [])

	def test_a_lost_triangle(self):
		def change(g, a):
			m, k = where(g, pack.MERGED, "grey")
			a[(m, k, "indices")] = a[(m, k, "indices")][3:]
		self.assertTrue(any("1 triangles of the build not in the packed model" in p for p in self.found(change)))

	def test_a_triangle_turned_inside_out(self):
		def change(g, a):
			m, k = where(g, pack.MERGED, "grey")
			a[(m, k, "indices")][:3] = a[(m, k, "indices")][:3][::-1].copy()
		self.assertTrue(any(f"{pack.MERGED}/grey" in p for p in self.found(change)))

	def test_a_corner_moved_a_millimetre(self):
		def change(g, a):
			m, k = where(g, "vehicles", "grey")
			a[(m, k, "POSITION")][0, 1] += 0.001
		self.assertTrue(any("vehicles/grey" in p for p in self.found(change)))

	def test_a_normal_turned(self):
		def change(g, a):
			m, k = where(g, "arm", "red")
			a[(m, k, "NORMAL")][0] = [1, 0, 0]
		self.assertTrue(any("arm/red" in p for p in self.found(change)))

	def test_a_uv_moved_where_the_paint_draws_an_image_and_not_where_it_does_not(self):
		def textured(g, a):
			m, k = where(g, pack.MERGED, "grey")
			a[(m, k, "TEXCOORD_0")][0] += 0.01
		self.assertTrue(any(f"{pack.MERGED}/grey" in p for p in self.found(textured)))

		def plain(g, a):
			m, k = where(g, pack.MERGED, "red")
			a[(m, k, "TEXCOORD_0")][0] += 0.01
		self.assertEqual(self.found(plain), [])

	def test_a_degenerate_triangle_dropped(self):
		build = ship(island={"name": "island", "parts": [(np.concatenate([square(2), [[[2, 0, 0], [2, 0, 0], [3, 0, 1]]]]).astype(np.float32), "grey")]})
		game = merged(build)

		def change(g, a):
			m, k = where(g, pack.MERGED, "grey")
			index = a[(m, k, "indices")].reshape(-1, 3)
			corners = a[(m, k, "POSITION")][index]
			flat = np.linalg.norm(np.cross(corners[:, 1] - corners[:, 0], corners[:, 2] - corners[:, 0]), axis=1) < 1e-9
			a[(m, k, "indices")] = index[~flat].reshape(-1)
		self.assertEqual(check(build, edit(game, change)), [])

	def test_a_kept_part_merged(self):
		self.assertTrue(any("vehicles: not kept whole" in p for p in check(self.build, pack.merge(self.build, JOINTS, keep=()))))

	def test_a_joint_moved(self):
		def change(g, a):
			next(n for n in g["nodes"] if n.get("name") == "arm")["translation"] = [0, 1.001, 0]
		self.assertIn("joint arm: moved", self.found(change))

	def test_a_joint_hung_from_another_part(self):
		def change(g, a):
			names = [n.get("name") for n in g["nodes"]]
			g["nodes"][names.index("lift")]["children"].remove(names.index("arm"))
			g["nodes"][names.index("vehicles")]["children"] = [names.index("arm")]
		self.assertIn("joint arm: hangs from another node", self.found(change))

	def test_a_mesh_without_its_name(self):
		def change(g, a):
			m, _ = where(g, "vehicles", "grey")
			del g["meshes"][m]["name"]
		self.assertIn("vehicles: its mesh is named None", self.found(change))

	def test_a_paint_changed_and_one_written_to_fewer_figures(self):
		def changed(g, a):
			next(m for m in g["materials"] if m["name"] == "red")["pbrMetallicRoughness"]["baseColorFactor"] = [0.4, 0.32, 0.33, 1.0]
		self.assertTrue(any(p.startswith("material red") for p in self.found(changed)))

		def rounded(g, a):
			m = next(m for m in g["materials"] if m["name"] == "red")["pbrMetallicRoughness"]
			m["baseColorFactor"] = [float(f"{float(np.float32(v)):.9g}") for v in m["baseColorFactor"]]
		self.assertEqual(self.found(rounded), [])


TOOLS = shutil.which("node") and Path("~/bin/bwrap-build").expanduser().exists() and pack.GLTFPACK.exists()


@unittest.skipUnless(TOOLS, "needs node, ~/bin/bwrap-build and ../gltfpack-native")
class PackedTest(unittest.TestCase):
	def test_a_model_packed_and_decoded_reads_as_built(self):
		work = HERE / "references" / "pack" / "test"
		work.mkdir(parents=True, exist_ok=True)
		build = ship(island={"name": "island", "parts": [(square(2), "grey")], "scale": [-1, 1, 1]})
		(work / "merged.glb").write_bytes(merged(build))
		pack.sandboxed([str(pack.GLTFPACK), "-i", str(work / "merged.glb"), "-o", str(work / "packed.glb"), "-cc", "-noq", "-kn", "-km", "-ke"])
		(work / "game.glb").write_bytes(pack.names((work / "packed.glb").read_bytes()))
		gltf, _ = pack.read((work / "game.glb").read_bytes())
		self.assertIn("EXT_meshopt_compression", gltf["extensionsUsed"])
		self.assertEqual(check(build, pack.plain(work / "game.glb")), [])


if __name__ == "__main__":
	unittest.main()
