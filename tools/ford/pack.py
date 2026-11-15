# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
"""Packs a build for the game: the parts that never move merged by paint, so the ship draws in fewer
calls; the images in KTX2 (../texswap.py); the geometry meshopt-compressed (gltfpack, unquantised), which
the game's loader decodes; each mesh named after its node again, since gltfpack drops mesh names and the
engine tells parts apart by them. The packed model is then decoded with the game's own decoder
(unpack.mjs) and checked against the build: every triangle under the same part, in the same place,
wound the same way, with the same normals and UVs; the joints where they were; every material as it was.

A part stays whole if it moves (a joint of the ship file, or under one), or if the engine or the far
stage finds it by name (KEEP). A part that only holds a joint keeps its node, empty.

usage: python3 -I pack.py OUT.glb OUT.json GAME.glb [--work DIR]
(DIR, default references/pack, must lie inside the project: the encoders run sandboxed to it)"""
import collections, json, os, struct, subprocess, sys, tempfile
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
GLTFPACK = HERE.parent / "gltfpack-native"   # not committed: ../texswap.py says where it comes from
UNPACK = HERE / "unpack.mjs"
# Parts kept whole though they never move: the engine's deck grid leaves out the vehicles and tells
# the island's walkways from its body by these names (engine.ts build_deck_grid), and the far stage
# keeps drawing the full model's deck, its skirt and underside at every range (#36)
KEEP = ("vehicles", "island_details", "deck", "deck_skirt", "deck_underside")
MERGED = "ship"   # the node the merged parts are drawn from
# Images encoded UASTC: the lettering (ETC1S's 4x4 blocks smear it) and the three normal maps
UASTC = ("lettering", "hull_normal", "island_normal", "domes_normal")
KIND = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
WIDTH = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def read(data):
	# A GLB's JSON and binary chunk
	assert struct.unpack_from("<I", data, 0)[0] == 0x46546C67, "not a GLB"
	size = struct.unpack_from("<I", data, 12)[0]
	gltf = json.loads(data[20:20 + size])
	start = 20 + size
	binary = data[start + 8:start + 8 + struct.unpack_from("<I", data, start)[0]] if len(data) > start else b""
	return gltf, binary


def write(gltf, binary):
	text = json.dumps(gltf, separators=(",", ":")).encode()
	text += b" " * (-len(text) % 4)
	binary = binary + b"\0" * (-len(binary) % 4)
	return (struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(text) + 8 + len(binary)) + struct.pack("<I", len(text)) + b"JSON" + text
		+ struct.pack("<I", len(binary)) + b"BIN\0" + binary)


def accessor(gltf, binary, i):
	# An accessor's values, one row an element
	a = gltf["accessors"][i]
	assert "sparse" not in a, "a sparse accessor"
	view = gltf["bufferViews"][a["bufferView"]]
	assert "extensions" not in view and view.get("buffer", 0) == 0, "a compressed buffer: unpack it first (plain())"
	kind, width = np.dtype(KIND[a["componentType"]]), WIDTH[a["type"]]
	stride = view.get("byteStride") or kind.itemsize * width
	start = view.get("byteOffset", 0) + a.get("byteOffset", 0)
	rows = np.lib.stride_tricks.as_strided(np.frombuffer(binary, np.uint8, offset=start), (a["count"], kind.itemsize * width), (stride, 1))
	values = np.ascontiguousarray(rows).view(kind)
	return values.reshape(a["count"], width) if width > 1 else values.reshape(a["count"])


def local(n):
	m = np.eye(4)
	if "matrix" in n:
		return np.array(n["matrix"], float).reshape(4, 4).T
	x, y, z, w = n.get("rotation", [0, 0, 0, 1])
	m[:3, :3] = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
		[2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
		[2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]]) * np.array(n.get("scale", [1, 1, 1]))[None, :]
	m[:3, 3] = n.get("translation", [0, 0, 0])
	return m


def tree(gltf):
	# Each node's parent and world matrix
	parent = {c: i for i, n in enumerate(gltf["nodes"]) for c in n.get("children", [])}
	world = {}

	def walk(i, above):
		world[i] = above @ local(gltf["nodes"][i])
		for c in gltf["nodes"][i].get("children", []):
			walk(c, world[i])
	for r in gltf["scenes"][gltf.get("scene", 0)]["nodes"]:
		walk(r, np.eye(4))
	return parent, world


def owner(gltf, parent, i):
	# The nearest node at or above i with a name (gltfpack hangs unnamed nodes under named ones)
	while i is not None and "name" not in gltf["nodes"][i]:
		i = parent.get(i)
	return i


def merging(gltf, joints, keep=KEEP):
	# The nodes whose meshes merge: neither moving (a joint or under one) nor kept by name
	parent, _ = tree(gltf)

	def moves(i):
		while i is not None:
			if gltf["nodes"][i].get("name") in joints:
				return True
			i = parent.get(i)
		return False
	return [i for i, n in enumerate(gltf["nodes"]) if "mesh" in n and not moves(i) and n.get("name") not in keep]


class Writer:
	# A fresh binary chunk, its buffer views and accessors
	def __init__(self):
		self.chunks, self.views, self.accessors, self.size = [], [], [], 0

	def view(self, blob, target=None):
		pad = -self.size % 4
		self.chunks.append(b"\0" * pad + blob)
		self.size += pad
		v = {"buffer": 0, "byteOffset": self.size, "byteLength": len(blob)}
		if target:
			v["target"] = target
		self.views.append(v)
		self.size += len(blob)
		return len(self.views) - 1

	def accessor(self, values, like, target):
		a = {k: v for k, v in like.items() if k not in ("bufferView", "byteOffset", "count", "min", "max", "sparse")}
		a["bufferView"] = self.view(np.ascontiguousarray(values).tobytes(), target)
		a["count"] = len(values)
		if "min" in like:
			flat = values.reshape(len(values), -1)
			a["min"], a["max"] = flat.min(axis=0).tolist(), flat.max(axis=0).tolist()
		self.accessors.append(a)
		return len(self.accessors) - 1


def merge(data, joints, keep=KEEP, name=MERGED):
	# The model with the meshes of the parts that never move merged into one node's, a primitive a
	# paint (and attribute set), each part's triangles carried into the world frame
	gltf, binary = read(data)
	assert not gltf.get("animations") and not gltf.get("skins"), "animated or skinned"
	parent, world = tree(gltf)
	merged = set(merging(gltf, joints, keep))
	groups = collections.OrderedDict()
	for i in sorted(merged):
		M = world[i]
		R, t = M[:3, :3], M[:3, 3]
		flip = np.linalg.det(R) < 0
		inverse = np.linalg.inv(R).T
		for p in gltf["meshes"][gltf["nodes"][i]["mesh"]]["primitives"]:
			assert p.get("mode", 4) == 4 and not p.get("targets"), "only plain triangles merge"
			attributes = {k: accessor(gltf, binary, a) for k, a in p["attributes"].items()}
			count = len(attributes["POSITION"])
			index = accessor(gltf, binary, p["indices"]).astype(np.int64) if "indices" in p else np.arange(count)
			if "POSITION" in attributes:
				attributes["POSITION"] = (attributes["POSITION"].astype(float) @ R.T + t).astype(np.float32)
			if "NORMAL" in attributes:
				n = attributes["NORMAL"].astype(float) @ inverse.T
				attributes["NORMAL"] = (n / np.maximum(np.linalg.norm(n, axis=1), 1e-12)[:, None]).astype(np.float32)
			if "TANGENT" in attributes:
				tangent = attributes["TANGENT"].astype(float)
				d = tangent[:, :3] @ R.T
				tangent[:, :3] = d / np.maximum(np.linalg.norm(d, axis=1), 1e-12)[:, None]
				tangent[:, 3] *= -1 if flip else 1
				attributes["TANGENT"] = tangent.astype(np.float32)
			tris = index.reshape(-1, 3)
			if flip:
				tris = tris[:, [0, 2, 1]]
			like = {k: gltf["accessors"][a] for k, a in p["attributes"].items()}
			key = (p.get("material"), tuple(sorted(attributes)), tuple((k, like[k]["componentType"], like[k]["type"], like[k].get("normalized", False)) for k in sorted(like)))
			group = groups.setdefault(key, {"values": collections.defaultdict(list), "index": [], "count": 0, "like": like})
			for k, v in attributes.items():
				group["values"][k].append(v)
			group["index"].append(tris + group["count"])
			group["count"] += count
	out = Writer()
	# the images first, in order, each copied
	images = {}
	for image in gltf.get("images", []):
		if "bufferView" in image:
			v = gltf["bufferViews"][image["bufferView"]]
			blob = binary[v.get("byteOffset", 0):v.get("byteOffset", 0) + v["byteLength"]]
			if image["bufferView"] not in images:
				images[image["bufferView"]] = out.view(blob)
			image["bufferView"] = images[image["bufferView"]]
	# every mesh still used, rewritten; the merged one appended
	used = sorted({n["mesh"] for i, n in enumerate(gltf["nodes"]) if "mesh" in n and i not in merged})
	renumber = {m: k for k, m in enumerate(used)}
	meshes = []
	for m in used:
		mesh = gltf["meshes"][m]
		for p in mesh["primitives"]:
			attributes = {}
			for k, a in p["attributes"].items():
				attributes[k] = out.accessor(accessor(gltf, binary, a), gltf["accessors"][a], 34962)
			p["attributes"] = attributes
			if "indices" in p:
				p["indices"] = out.accessor(accessor(gltf, binary, p["indices"]), gltf["accessors"][p["indices"]], 34963)
		meshes.append(mesh)
	if groups:
		primitives = []
		for (material, _, _), g in groups.items():
			attributes = {k: out.accessor(np.concatenate(v), g["like"][k], 34962) for k, v in g["values"].items()}
			index = np.concatenate(g["index"]).reshape(-1)
			kind = np.uint32 if g["count"] > 65535 else np.uint16
			indices = out.accessor(index.astype(kind), {"componentType": 5125 if kind is np.uint32 else 5123, "type": "SCALAR"}, 34963)
			primitive = {"attributes": attributes, "indices": indices}
			if material is not None:
				primitive["material"] = material
			primitives.append(primitive)
		meshes.append({"name": name, "primitives": primitives})
	# the merged parts' nodes lose their meshes; those left holding nothing go
	nodes = gltf["nodes"]
	for i in merged:
		del nodes[i]["mesh"]
	gone = {i for i in merged if not nodes[i].get("children")}
	keep_index = [i for i in range(len(nodes)) if i not in gone]
	renode = {old: new for new, old in enumerate(keep_index)}
	fresh = []
	for old in keep_index:
		n = nodes[old]
		if "mesh" in n:
			n["mesh"] = renumber[n["mesh"]]
		if "children" in n:
			n["children"] = [renode[c] for c in n["children"] if c in renode]
			if not n["children"]:
				del n["children"]
		fresh.append(n)
	scene = gltf["scenes"][gltf.get("scene", 0)]
	scene["nodes"] = [renode[r] for r in scene["nodes"] if r in renode]
	if groups:
		fresh.append({"name": name, "mesh": len(meshes) - 1})
		scene["nodes"].append(len(fresh) - 1)
	gltf["nodes"], gltf["meshes"] = fresh, meshes
	gltf["accessors"], gltf["bufferViews"] = out.accessors, out.views
	blob = b"".join(out.chunks)
	gltf["buffers"] = [{"byteLength": len(blob)}]
	return write(gltf, blob)


def names(data):
	# Each mesh named after the node it hangs from, or the nearest named node above it (gltfpack drops
	# mesh names, and the glTF loader names a mesh's parts after them). A mesh gltfpack shares between
	# parts of different names (two sheaves alike) is described again for each: the copies read the
	# same accessors, so the file carries its data once and the loader builds it once
	gltf, binary = read(data)
	parent, _ = tree(gltf)
	given = {}
	for i, n in enumerate(gltf["nodes"]):
		if "mesh" not in n:
			continue
		o = owner(gltf, parent, i)
		assert o is not None, f"node {i} hangs from no named node"
		name = gltf["nodes"][o]["name"]
		if given.setdefault(n["mesh"], name) != name:
			gltf["meshes"].append(json.loads(json.dumps(gltf["meshes"][n["mesh"]])))
			n["mesh"] = len(gltf["meshes"]) - 1
			given[n["mesh"]] = name
	for m, name in given.items():
		gltf["meshes"][m]["name"] = name
	return write(gltf, binary)


def plain(path):
	# A model's bytes with its buffers decoded, if compressed, by the game's own decoder
	data = Path(path).read_bytes()
	gltf, _ = read(data)
	if "EXT_meshopt_compression" not in gltf.get("extensionsUsed", []):
		return data
	with tempfile.TemporaryDirectory() as folder:
		out = Path(folder) / "plain.glb"
		subprocess.run(["node", str(UNPACK), str(path), str(out)], check=True)
		return out.read_bytes()


def textured(m):
	# Whether a material draws an image: only then are its UVs read (gltfpack drops them elsewhere)
	return any(k.endswith("Texture") for k in list(m) + list(m.get("pbrMetallicRoughness", {})))


def triangles(data, owners):
	# {(owner, paint): [triangles]}: each triangle a (3, 8) array of its corners' position, normal and
	# UV (NaN where missing or where its paint has no image), in its owner's frame; owners(gltf, parent)
	# gives each mesh node's owner
	gltf, binary = read(data)
	parent, world = tree(gltf)
	out = collections.defaultdict(list)
	for i, frame in owners(gltf, parent).items():
		o, base = frame
		M = np.linalg.inv(world[o]) @ world[i] if base is None else base
		R, t = M[:3, :3], M[:3, 3]
		flip = np.linalg.det(R) < 0
		for p in gltf["meshes"][gltf["nodes"][i]["mesh"]]["primitives"]:
			at = p["attributes"]
			index = accessor(gltf, binary, p["indices"]).astype(np.int64).reshape(-1, 3) if "indices" in p else np.arange(gltf["accessors"][at["POSITION"]]["count"]).reshape(-1, 3)
			if flip:
				index = index[:, [0, 2, 1]]
			corner = np.full((gltf["accessors"][at["POSITION"]]["count"], 8), np.nan)
			corner[:, :3] = accessor(gltf, binary, at["POSITION"]).astype(float) @ R.T + t
			if "NORMAL" in at:
				n = accessor(gltf, binary, at["NORMAL"]).astype(float) @ np.linalg.inv(R)
				corner[:, 3:6] = n / np.maximum(np.linalg.norm(n, axis=1), 1e-12)[:, None]
			drawn = gltf["materials"][p["material"]] if "material" in p else {}
			if "TEXCOORD_0" in at and textured(drawn):
				corner[:, 6:8] = accessor(gltf, binary, at["TEXCOORD_0"]).astype(float)
			paint = drawn.get("name")
			out[(gltf["nodes"][o]["name"], paint)].append(corner[index])
	return {k: np.concatenate(v) for k, v in out.items()}


def canonical(tris):
	# Each triangle turned to start at its least corner, its winding kept, and rounded: two copies of
	# one triangle read alike
	position = np.round(tris[:, :, :3], 5)
	first = np.lexsort((position[:, :, 2], position[:, :, 1], position[:, :, 0]), axis=-1)[:, 0] if len(tris) else np.zeros(0, int)
	turned = tris[np.arange(len(tris))[:, None], (first[:, None] + np.arange(3)) % 3]
	rounded = np.concatenate([np.round(turned[:, :, :3], 5), np.round(turned[:, :, 3:6], 3), np.round(turned[:, :, 6:8], 5)], axis=2)
	return turned, [r.tobytes() for r in np.nan_to_num(rounded, nan=9e9)]


def same(a, b):
	# Two triangles alike to within rounding: the same corners in the same turn, normals, UVs
	for k in range(3):
		c = np.roll(b, -k, axis=0)
		if (np.allclose(a[:, :3], c[:, :3], atol=1e-4) and np.allclose(np.nan_to_num(a[:, 3:6], nan=9), np.nan_to_num(c[:, 3:6], nan=9), atol=2e-3)
			and np.allclose(np.nan_to_num(a[:, 6:8], nan=9), np.nan_to_num(c[:, 6:8], nan=9), atol=1e-5)):
			return True
	return False


def unmatched(a, b):
	# The places in a of keys b has no copy of left to pair with
	pool = collections.Counter(b)
	out = []
	for i, k in enumerate(a):
		if pool[k] > 0:
			pool[k] -= 1
		else:
			out.append(i)
	return out


def degenerate(t):
	return np.linalg.norm(np.cross(t[1, :3] - t[0, :3], t[2, :3] - t[0, :3])) < 1e-10


def material(m):
	# A material as drawn, less its images' indices (they renumber), its numbers as the float32 the
	# renderer reads (gltfpack writes them to 9 figures)
	def number(v):
		return [number(x) for x in v] if isinstance(v, list) else float(np.float32(v)) if isinstance(v, float) else v
	out = {}
	for k, v in m.items():
		if k.endswith("Texture"):
			out[k] = {x: number(y) for x, y in v.items() if x != "index"}
		elif k == "pbrMetallicRoughness":
			out[k] = material(v)
		elif k != "extensions":
			out[k] = number(v)
	return out


def compare(build, game, joints, keep=KEEP, name=MERGED):
	# What differs between the build and its packed copy (both plain): a list of findings, none if alike
	problems = []
	g, _ = read(game)
	b, _ = read(build)
	merged = set(merging(b, joints, keep))

	def built(gltf, parent):
		_, world = tree(gltf)
		return {i: ((i, None) if i not in merged else (i, world[i])) for i, n in enumerate(gltf["nodes"]) if "mesh" in n}

	def packed(gltf, parent):
		return {i: (owner(gltf, parent, i), None) for i, n in enumerate(gltf["nodes"]) if "mesh" in n}

	# the merged parts' triangles gathered under the one name they are drawn by
	called = {b["nodes"][i]["name"] for i in merged}
	gathered = collections.defaultdict(list)
	for (o, paint), v in triangles(build, built).items():
		gathered[(name if o in called else o, paint)].append(v)
	before = {k: np.concatenate(v) for k, v in gathered.items()}
	after = triangles(game, packed)
	for key in sorted(set(before) | set(after), key=str):
		x = before.get(key, np.zeros((0, 3, 8)))
		y = after.get(key, np.zeros((0, 3, 8)))
		tx, kx = canonical(x)
		ty, ky = canonical(y)
		missing, extra = unmatched(kx, ky), unmatched(ky, kx)
		# what rounding parted: paired within tolerance, looked up by their corners to the millimetre
		near = collections.defaultdict(list)
		for j in extra:
			near[np.round(ty[j][:, :3], 3).tobytes()].append(j)
		spare = set(extra)
		lost = []
		for i in missing:
			match = next((j for j in near[np.round(tx[i][:, :3], 3).tobytes()] if j in spare and same(tx[i], ty[j])), None)
			if match is None and len(spare) <= 500:
				match = next((j for j in spare if same(tx[i], ty[j])), None)
			if match is None:
				lost.append(i)
			else:
				spare.discard(match)
		lost = [i for i in lost if not degenerate(tx[i])]
		if lost or spare:
			problems.append(f"{key[0]}/{key[1]}: {len(lost)} triangles of the build not in the packed model, {len(spare)} in it not in the build")
	gn = {n["name"]: (i, n) for i, n in enumerate(g["nodes"]) if "name" in n}
	gp, _ = tree(g)
	bp, _ = tree(b)
	for joint in joints:
		if joint not in gn:
			problems.append(f"joint {joint}: missing")
			continue
		i, n = gn[joint]
		j = next(k for k, m in enumerate(b["nodes"]) if m.get("name") == joint)
		if not np.allclose(local(n), local(b["nodes"][j]), atol=1e-6):
			problems.append(f"joint {joint}: moved")
		above = owner(g, gp, gp.get(i))
		if (g["nodes"][above]["name"] if above is not None else None) != (b["nodes"][bp[j]]["name"] if j in bp else None):
			problems.append(f"joint {joint}: hangs from another node")
	for kept in keep:
		if kept in {n.get("name") for n in b["nodes"]} and (kept not in gn or "mesh" not in gn[kept][1]):
			problems.append(f"{kept}: not kept whole")
	for i, n in enumerate(g["nodes"]):
		if "mesh" in n:
			o = owner(g, gp, i)
			if g["meshes"][n["mesh"]].get("name") != g["nodes"][o]["name"]:
				problems.append(f"{g['nodes'][o]['name']}: its mesh is named {g['meshes'][n['mesh']].get('name')!r}")
	bm = {m.get("name"): material(m) for m in b.get("materials", [])}
	gm = {m.get("name"): material(m) for m in g.get("materials", [])}
	for k in sorted(set(bm) | set(gm), key=str):
		if bm.get(k) != gm.get(k):
			problems.append(f"material {k}: {bm.get(k)} became {gm.get(k)}")
	if sorted(i.get("name", "") for i in b.get("images", [])) != sorted(i.get("name", "") for i in g.get("images", [])):
		problems.append("the images differ")
	return problems


def draws(data):
	gltf, _ = read(data)
	return sum(len(gltf["meshes"][n["mesh"]]["primitives"]) for n in gltf["nodes"] if "mesh" in n)


def sandboxed(command):
	env = dict(os.environ, BWRAP_PROJECT=os.environ.get("BWRAP_PROJECT", str(ROOT)))
	subprocess.run([os.path.expanduser("~/bin/bwrap-build")] + command, check=True, env=env)


def main():
	args = sys.argv[1:]
	work = Path(args[args.index("--work") + 1]) if "--work" in args else HERE / "references" / "pack"
	source, ship, out = [Path(a).resolve() for a in args[:3]]
	work = work.resolve()
	work.mkdir(parents=True, exist_ok=True)
	joints = set(json.loads(ship.read_text())["joints"])
	build = source.read_bytes()
	(work / "merged.glb").write_bytes(merge(build, joints))
	gltf, _ = read((work / "merged.glb").read_bytes())
	uastc = ",".join(str(i) for i, image in enumerate(gltf.get("images", [])) if image.get("name") in UASTC)
	subprocess.run([sys.executable, "-I", str(HERE.parent / "texswap.py"), str(work / "merged.glb"), str(work / "ktx.glb"), "etc1s"] + ([uastc] if uastc else []), check=True)
	sandboxed([str(GLTFPACK), "-i", str(work / "ktx.glb"), "-o", str(work / "packed.glb"), "-cc", "-noq", "-kn", "-km", "-ke"])
	game = names((work / "packed.glb").read_bytes())
	out.write_bytes(game)
	problems = compare(build, plain(out), joints)
	for p in problems:
		print("FAIL", p)
	print(f"pack: {len(build) / 1e6:.2f} -> {len(game) / 1e6:.2f} MB, draws {draws(build)} -> {draws(game)}, {len(problems)} findings")
	sys.exit(1 if problems else 0)


if __name__ == "__main__":
	main()
