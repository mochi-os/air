# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
"""The Ford's distant model: what the game draws in place of the full model once the ship is small on
screen (engine.ts CARRIER_LIMIT). The build is posed as the game draws it (the deck-edge whips lowered,
as the engine sets them on loading, every other part at rest) and drawn in one call: every part but the
deck, its skirt and underside (which the full model keeps drawing at every range, CARRIER_KEEP) carried
into the model frame, each corner coloured by its paint as an area of the paint's image round its UV
(linear light, as glTF vertex colours are), then simplified and meshopt-compressed by gltfpack. A cut-out
paint keeps the triangles whose image round their corners is mostly solid, coloured by its solid part (the
island's plating round its windows), and loses those mostly holes (the nets); a see-through one (the
vehicles' panes) reads as its own tint. Then checked against the build: the same extent, one primitive, no images.

usage: python3 -I far.py OUT.glb OUT.json FAR.glb [--ratio R] [--work DIR]
(R the share of triangles gltfpack keeps, default RATIO; DIR as pack.py's)"""
import io, json, re, struct, sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "verify"))
import model as verify  # noqa: E402
import pack  # noqa: E402

KEEP = re.compile(r"^deck(_baked|_underside|_skirt)?$")   # engine.ts CARRIER_KEEP
# The nearest the game draws the far model: until the ship's length is back up to CARRIER_LIMIT times
# STAGE_MARGIN reference pixels (engine.ts), each 1/1080 of the view's 45 degrees, so a pixel there spans
# PIXEL metres; the far model's extent holds to within one
LENGTH, LIMIT, MARGIN = 332.6, 150, 1.15
PIXEL = LENGTH / (LIMIT * MARGIN)
RATIO = 0.25
BOX = 512   # an image is averaged over a box 1/BOX of its width round each UV: its colour as a few pixels see it


def linear(srgb):
	return np.where(srgb <= 0.04045, srgb / 12.92, ((srgb + 0.055) / 1.055) ** 2.4)


class Paint:
	# A material's colour at a UV: its factor times its image, averaged over a box round the UV; for a
	# cut-out paint, over the box's solid texels, with the share of them (its cover)
	def __init__(self, material, image):
		pbr = material.get("pbrMetallicRoughness", {})
		self.factor = np.array(pbr.get("baseColorFactor", [1, 1, 1, 1])[:3], float)
		self.cut = material.get("alphaMode") == "MASK"
		self.table = None
		if image is not None:
			from PIL import Image
			rgba = np.asarray(Image.open(io.BytesIO(image)).convert("RGBA"), float) / 255
			solid = rgba[:, :, 3] >= material.get("alphaCutoff", 0.5) if self.cut else np.ones(rgba.shape[:2], bool)
			pixels = np.concatenate([linear(rgba[:, :, :3]) * solid[:, :, None], solid[:, :, None]], axis=2)
			self.height, self.width = pixels.shape[:2]
			self.table = np.zeros((self.height + 1, self.width + 1, 4))
			self.table[1:, 1:] = pixels.cumsum(axis=0).cumsum(axis=1)
			self.reach = max(1, self.width // BOX)

	def colour(self, uv):
		# (colours, covers) at each UV
		if self.table is None or uv is None:
			n = len(uv) if uv is not None else 1
			return np.tile(self.factor, (n, 1)), np.ones(n)
		x = np.floor((uv[:, 0] % 1.0) * self.width).astype(int)
		y = np.floor((uv[:, 1] % 1.0) * self.height).astype(int)
		x0, x1 = np.clip(x - self.reach, 0, self.width), np.clip(x + self.reach + 1, 0, self.width)
		y0, y1 = np.clip(y - self.reach, 0, self.height), np.clip(y + self.reach + 1, 0, self.height)
		t = self.table
		total = t[y1, x1] - t[y0, x1] - t[y1, x0] + t[y0, x0]
		solid = total[:, 3]
		return self.factor * total[:, :3] / np.maximum(solid, 1)[:, None], solid / ((x1 - x0) * (y1 - y0))


def posed(path, ship):
	# Each node's world matrix as the game draws the ship: the whips lowered (engine.ts init_carrier_model
	# sets every antenna_ joint to its last key), every other joint at rest
	joints = ship.get("joints", {})
	lowered = {name: j["keys"][-1][1] for name, j in joints.items() if name.startswith("antenna_")}
	return verify.Model(path).worlds(verify.pose(joints, {"joints": lowered}))


def kept(gltf, parent, i):
	# Whether the full model keeps drawing node i at every range (it or a node above it is CARRIER_KEEP's)
	while i is not None:
		if KEEP.match(gltf["nodes"][i].get("name", "")):
			return True
		i = parent.get(i)
	return False


def gather(path, ship):
	# The parts the far model draws, as (positions, normals, colours, triangles) in the model frame
	data = Path(path).read_bytes()
	gltf, binary = pack.read(data)
	parent, _ = pack.tree(gltf)
	worlds = posed(path, ship)
	images = []
	for image in gltf.get("images", []):
		v = gltf["bufferViews"][image["bufferView"]]
		images.append(binary[v.get("byteOffset", 0):v.get("byteOffset", 0) + v["byteLength"]])
	paints = {}

	def paint(m):
		if m not in paints:
			material = gltf["materials"][m]
			texture = material.get("pbrMetallicRoughness", {}).get("baseColorTexture")
			source = gltf["textures"][texture["index"]].get("source") if texture else None
			paints[m] = Paint(material, images[source] if source is not None else None)
		return paints[m]

	out = {"positions": [], "normals": [], "colours": [], "triangles": []}
	count = 0
	for i, n in enumerate(gltf["nodes"]):
		if "mesh" not in n or i not in worlds or kept(gltf, parent, i):
			continue
		M = worlds[i]
		R, t = M[:3, :3], M[:3, 3]
		flip = np.linalg.det(R) < 0
		for p in gltf["meshes"][n["mesh"]]["primitives"]:
			at = p["attributes"]
			corners = pack.accessor(gltf, binary, at["POSITION"]).astype(float)
			index = pack.accessor(gltf, binary, p["indices"]).astype(np.int64).reshape(-1, 3) if "indices" in p else np.arange(len(corners)).reshape(-1, 3)
			if flip:
				index = index[:, [0, 2, 1]]
			normal = pack.accessor(gltf, binary, at["NORMAL"]).astype(float) @ np.linalg.inv(R) if "NORMAL" in at else np.zeros_like(corners)
			normal /= np.maximum(np.linalg.norm(normal, axis=1), 1e-12)[:, None]
			uv = pack.accessor(gltf, binary, at["TEXCOORD_0"]).astype(float) if "TEXCOORD_0" in at else None
			colour, cover = paint(p["material"]).colour(uv) if "material" in p else (np.ones((len(corners), 3)), np.ones(len(corners)))
			cover = np.broadcast_to(cover, (len(corners),))
			index = index[cover[index].mean(axis=1) >= 0.5]   # a cut-out's triangles mostly holes go
			out["positions"].append(corners @ R.T + t)
			out["normals"].append(normal)
			out["colours"].append(np.broadcast_to(colour, (len(corners), 3)))
			out["triangles"].append(index + count)
			count += len(corners)
	return {k: np.concatenate(v) for k, v in out.items()}


def model(parts):
	# A GLB of one node drawing the parts in one primitive, its colours in its vertices
	out = pack.Writer()
	positions = parts["positions"].astype(np.float32)
	attributes = {
		"POSITION": out.accessor(positions, {"componentType": 5126, "type": "VEC3", "min": [], "max": []}, 34962),
		"NORMAL": out.accessor(parts["normals"].astype(np.float32), {"componentType": 5126, "type": "VEC3"}, 34962),
		"COLOR_0": out.accessor(np.clip(parts["colours"], 0, 1).astype(np.float32), {"componentType": 5126, "type": "VEC3"}, 34962),
	}
	indices = out.accessor(parts["triangles"].reshape(-1).astype(np.uint32), {"componentType": 5125, "type": "SCALAR"}, 34963)
	gltf = {"asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"name": "far", "mesh": 0}],
		"meshes": [{"name": "far", "primitives": [{"attributes": attributes, "indices": indices, "material": 0}]}],
		"materials": [{"name": "far", "pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1], "metallicFactor": 0, "roughnessFactor": 0.9}}],
		"accessors": out.accessors, "bufferViews": out.views}
	blob = b"".join(out.chunks)
	gltf["buffers"] = [{"byteLength": len(blob)}]
	return pack.write(gltf, blob)


def extent(positions):
	return positions.min(axis=0), positions.max(axis=0)


def check(parts, far, slack=PIXEL):
	# What is wrong with a far model (plain) against the parts it was made from: a list, none if sound
	gltf, binary = pack.read(far)
	problems = []
	if gltf.get("images"):
		problems.append("it carries images")
	drawn = [p for n in gltf["nodes"] if "mesh" in n for p in gltf["meshes"][n["mesh"]]["primitives"]]
	if len(drawn) != 1:
		problems.append(f"it draws in {len(drawn)} calls, not 1")
	parent, world = pack.tree(gltf)
	corners = []
	for i, n in enumerate(gltf["nodes"]):
		if "mesh" in n:
			for p in gltf["meshes"][n["mesh"]]["primitives"]:
				if "COLOR_0" not in p["attributes"]:
					problems.append("a primitive without vertex colours")
				raw = pack.accessor(gltf, binary, p["attributes"]["POSITION"])
				v = raw.astype(float)
				if gltf["accessors"][p["attributes"]["POSITION"]].get("normalized"):
					v /= np.iinfo(raw.dtype).max
				corners.append(v @ world[i][:3, :3].T + world[i][:3, 3])
	if corners:
		low, high = extent(np.concatenate(corners))
		want_low, want_high = extent(parts["positions"])
		for axis, name in enumerate("xyz"):
			if abs(low[axis] - want_low[axis]) > slack or abs(high[axis] - want_high[axis]) > slack:
				problems.append(f"its extent in {name} is {low[axis]:.2f}..{high[axis]:.2f}, the parts' {want_low[axis]:.2f}..{want_high[axis]:.2f}")
	return problems


def main():
	args = sys.argv[1:]
	ratio = float(args[args.index("--ratio") + 1]) if "--ratio" in args else RATIO
	work = Path(args[args.index("--work") + 1]) if "--work" in args else HERE / "references" / "pack"
	source, ship, out = [Path(a).resolve() for a in args[:3]]
	work = work.resolve()
	work.mkdir(parents=True, exist_ok=True)
	parts = gather(source, json.loads(ship.read_text()))
	(work / "far-raw.glb").write_bytes(model(parts))
	pack.sandboxed([str(pack.GLTFPACK), "-i", str(work / "far-raw.glb"), "-o", str(work / "far.glb"), "-cc", "-si", str(ratio)])
	out.write_bytes((work / "far.glb").read_bytes())
	problems = check(parts, pack.plain(out))
	for p in problems:
		print("FAIL", p)
	gltf, _ = pack.read(pack.plain(out))
	triangles = sum(gltf["accessors"][p["indices"]]["count"] // 3 for m in gltf["meshes"] for p in m["primitives"])
	print(f"far: {len(parts['triangles'])} triangles -> {triangles}, {out.stat().st_size / 1e6:.2f} MB, {len(problems)} findings")
	sys.exit(1 if problems else 0)


if __name__ == "__main__":
	main()
