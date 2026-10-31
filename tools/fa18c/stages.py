# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# Our F/A-18C's distant models, step one (before decimate.py and farcheck.py):
# from the model build.py wrote and its points file, posed gear up and gear down
# as the engine poses it, the vertex-coloured parts decimate.py reduces
# (PARTS.glb), and the posed jet farcheck.py checks the stages against (POSE.json,
# in the format it reads):
#   airframe   everything that does not move with the gear, gear up
#   up, down   what moves with the gear (legs, wheels, doors), in each pose
#   burner     the flames' faces, in their glow (none until the build makes them)
# Each corner takes its colour from the paint atlas where its UV falls, in linear
# light as glTF vertex colours are; glass reads as a dark tint at range, the
# other materials their own colour. Faces no ray from outside reaches (the ducts,
# the cockpit under the closed canopy, the wheel wells) are dropped by a voxel
# flood from outside, so the decimator spends nothing on them.
#
# usage: python3 -I stages.py MODEL.glb POINTS.json PARTS.glb POSE.json
import io, json, struct, sys
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "verify"))   # run with -I, which leaves the script's folders off the path
import model as mod  # noqa: E402

VOXEL = 0.08   # metres
TINT = np.array([0.020, 0.026, 0.034])   # canopy glass seen from outside at range, linear
FLAT = {"lights": (0.34, 0.35, 0.32), "display": (0.05, 0.08, 0.05), "burner": (1.0, 0.6, 0.2)}   # build.py's COLOURS


def linear(srgb):
	s = np.asarray(srgb, np.float64)
	return np.where(s <= 0.04045, s / 12.92, ((s + 0.055) / 1.055) ** 2.4)


def sample(image, uv):
	# The nearest texel at each UV, repeating, glTF's top-left origin
	h, w, _ = image.shape
	x = np.floor(np.mod(uv[:, 0], 1.0) * w).astype(int) % w
	y = np.floor(np.mod(uv[:, 1], 1.0) * h).astype(int) % h
	return image[y, x]


def exterior(tris, voxel):
	# Which triangles touch air a flood from outside the bounding box reaches
	lo = tris.reshape(-1, 3).min(0) - 2 * voxel
	dims = np.ceil((tris.reshape(-1, 3).max(0) + 2 * voxel - lo) / voxel).astype(int) + 1
	solid = np.zeros(dims, bool)
	owner_points, owner = [], []
	a, b, c = tris[:, 0], tris[:, 1], tris[:, 2]
	longest = np.max(np.stack([np.linalg.norm(b - a, axis=1), np.linalg.norm(c - b, axis=1), np.linalg.norm(a - c, axis=1)]), 0)
	steps = np.clip(np.ceil(longest / (voxel * 0.5)).astype(int), 1, 400)
	for k in np.unique(steps):
		sel = np.where(steps == k)[0]
		u, v = np.meshgrid(np.arange(k + 1) / k, np.arange(k + 1) / k)
		keep = (u + v) <= 1.0 + 1e-9
		u, v = u[keep], v[keep]
		pts = a[sel, None] + u[None, :, None] * (b - a)[sel, None] + v[None, :, None] * (c - a)[sel, None]
		cells = np.floor((pts - lo) / voxel).astype(int)
		solid[cells[..., 0], cells[..., 1], cells[..., 2]] = True
		owner_points.append(cells.reshape(-1, 3))
		owner.append(np.repeat(sel, cells.shape[1]))
	air = ~solid
	outside = np.zeros(dims, bool)
	outside[0, :, :] = outside[-1, :, :] = outside[:, 0, :] = outside[:, -1, :] = outside[:, :, 0] = outside[:, :, -1] = True
	outside &= air
	while True:
		grown = outside.copy()
		grown[1:] |= outside[:-1]
		grown[:-1] |= outside[1:]
		grown[:, 1:] |= outside[:, :-1]
		grown[:, :-1] |= outside[:, 1:]
		grown[:, :, 1:] |= outside[:, :, :-1]
		grown[:, :, :-1] |= outside[:, :, 1:]
		grown &= air
		if grown.sum() == outside.sum():
			break
		outside = grown
	near = outside.copy()   # solid voxels with outside air beside them
	near[1:] |= outside[:-1]
	near[:-1] |= outside[1:]
	near[:, 1:] |= outside[:, :-1]
	near[:, :-1] |= outside[:, 1:]
	near[:, :, 1:] |= outside[:, :, :-1]
	near[:, :, :-1] |= outside[:, :, 1:]
	cells = np.concatenate(owner_points)
	who = np.concatenate(owner)
	hit = near[cells[:, 0], cells[:, 1], cells[:, 2]]
	keep = np.zeros(len(tris), bool)
	keep[who[hit]] = True
	return keep


def write(path, parts):
	# A glTF with one node and mesh per part: positions and linear vertex colours, a triangle soup
	data, views, accessors, meshes, nodes = bytearray(), [], [], [], []

	def add(array, kind, target):
		offset = len(data)
		raw = np.ascontiguousarray(array, np.float32).tobytes()
		data.extend(raw)
		while len(data) % 4:
			data.append(0)
		views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(raw), "target": target})
		accessor = {"bufferView": len(views) - 1, "componentType": 5126, "count": len(array), "type": kind}
		if kind == "VEC3" and target == 34962 and len(accessors) % 2 == 0:
			accessor["min"] = np.asarray(array).min(0).tolist()
			accessor["max"] = np.asarray(array).max(0).tolist()
		accessors.append(accessor)
		return len(accessors) - 1

	for name, (tris, colours) in parts.items():
		if not len(tris):
			continue
		p = add(tris.reshape(-1, 3), "VEC3", 34962)
		c = add(colours.reshape(-1, 3), "VEC3", 34962)
		meshes.append({"name": name, "primitives": [{"attributes": {"POSITION": p, "COLOR_0": c}}]})
		nodes.append({"name": name, "mesh": len(meshes) - 1})
	document = {"asset": {"version": "2.0", "generator": "apps/air/tools/fa18c/stages.py"}, "scene": 0,
		"scenes": [{"nodes": list(range(len(nodes)))}], "nodes": nodes, "meshes": meshes,
		"accessors": accessors, "bufferViews": views, "buffers": [{"byteLength": len(data)}]}
	text = json.dumps(document).encode()
	text += b" " * ((4 - len(text) % 4) % 4)
	out = (struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(text) + 8 + len(data)) + struct.pack("<II", len(text), 0x4E4F534A) + text
		+ struct.pack("<II", len(data), 0x004E4942) + bytes(data))
	Path(path).write_bytes(out)


def atlas(path):
	# The paint atlas the model carries (build.py bakes one image), as linear RGB
	data = Path(path).read_bytes()
	length = struct.unpack_from("<I", data, 12)[0]
	gltf = json.loads(data[20:20 + length])
	binary = data[20 + length + 8:]
	images = gltf.get("images", [])
	if not images:
		return None
	view = gltf["bufferViews"][images[0]["bufferView"]]
	raw = binary[view.get("byteOffset", 0):view.get("byteOffset", 0) + view["byteLength"]]
	return linear(np.asarray(Image.open(io.BytesIO(raw)).convert("RGB"), np.float64) / 255.0)


def posed(model, joints, drives, image):
	# Every triangle of the model posed, with its UVs' colours: {node: (tris, colours, material)}
	worlds = model.worlds(mod.pose(joints, drives))
	out = []
	for i, node in enumerate(model.nodes):
		if node["mesh"] is None or i not in worlds:
			continue
		W = worlds[i]
		for (tris, material), uv in zip(model.meshes[node["mesh"]], model.uvs[node["mesh"]]):
			placed = tris @ W[:3, :3].T + W[:3, 3]
			n = len(tris)
			if material == "glass":
				colours = np.broadcast_to(TINT, (n, 3, 3)).copy()
			elif material in FLAT:
				colours = np.broadcast_to(np.array(FLAT[material]), (n, 3, 3)).copy()
			elif image is not None and uv is not None:
				colours = sample(image, uv.reshape(-1, 2)).reshape(n, 3, 3)
			else:
				colours = np.broadcast_to(linear(np.array([0.42, 0.45, 0.48])), (n, 3, 3)).copy()
			out.append((node["name"], placed, colours, material))
	return out


def build(model_path, points_path, parts_path, pose_path):
	model = mod.Model(model_path)
	joints = json.loads(Path(points_path).read_text())["joints"]
	image = atlas(model_path)
	up = posed(model, joints, {}, image)
	down = posed(model, joints, {"gear": 1}, image)
	groups = {"airframe": [], "up": [], "down": [], "burner": []}
	pose = {"up": [], "down": []}
	for (name, tu, cu, material), (_, td, cd, _) in zip(up, down):
		for key, tris in (("up", tu), ("down", td)):
			pose[key].append({"name": name, "material": material, "positions": tris.reshape(-1).tolist(), "indices": None})
		if material == "burner":
			groups["burner"].append((tu, cu))
		elif np.abs(tu - td).max() > 1e-5:
			groups["up"].append((tu, cu))
			groups["down"].append((td, cd))
		else:
			groups["airframe"].append((tu, cu))
	joined = {k: (np.concatenate([t for t, _ in v]) if v else np.zeros((0, 3, 3)), np.concatenate([c for _, c in v]) if v else np.zeros((0, 3, 3)))
		for k, v in groups.items()}
	keep = {}
	for gear in ("up", "down"):
		frame = np.concatenate([joined["airframe"][0], joined[gear][0]])
		outside = exterior(frame, VOXEL)
		n = len(joined["airframe"][0])
		keep["airframe"] = keep.get("airframe", np.zeros(n, bool)) | outside[:n]
		keep[gear] = outside[n:]
	parts = {}
	for k in ("airframe", "up", "down"):
		tris, colours = joined[k]
		parts[k] = (tris[keep[k]], colours[keep[k]])
		print(f"stages: {k}: {keep[k].sum()} of {len(keep[k])} triangles face the outside")
	parts["burner"] = joined["burner"]
	write(parts_path, parts)
	Path(pose_path).write_text(json.dumps(pose))
	print(f"stages: wrote {parts_path} and {pose_path}")


if __name__ == "__main__":
	build(*sys.argv[1:5])
