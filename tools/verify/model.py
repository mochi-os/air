# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# A generated model as the checks see it: its triangles in the model's own
# frame, posed by the joints its points file names, cut by planes and drawn as
# silhouettes; and the project's frame (stations, frames, decks...) that its
# sources give coordinates in. numpy and PIL only.
import json, math, struct
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

SYMBOL = "in"       # the source unit as printed after a number
PLURAL = "inches"   # and as a word, in prose


class Frame:
	# A project's coordinates (the sources' stations, waterlines and
	# buttlines, say) and the model frame (metres, glTF axes). spec:
	#   names   the three coordinates' names, as planes are written ("buttline=28")
	#   unit    metres per source unit
	#   symbol  the source unit as printed after a number (optional, "in")
	#   plural  the source unit as a word, in prose (optional, "inches")
	#   origin  the model frame's origin in source coordinates
	#   axes    rows: each model axis (x, y, z) as a combination of the source coordinates
	#   mirror  the source coordinate a mirrored pair differs in (optional)
	def __init__(self, spec):
		self.names = list(spec["names"])
		self.unit = float(spec["unit"])
		self.symbol = spec.get("symbol", SYMBOL)
		self.plural = spec.get("plural", PLURAL)
		self.origin = np.array(spec["origin"], float)
		self.axes = np.array(spec["axes"], float)
		if not np.allclose(self.axes @ self.axes.T, np.eye(3), atol=1e-9):
			raise ValueError("frame axes must be orthonormal")
		self.mirror = self.names.index(spec["mirror"]) if spec.get("mirror") else None

	def model(self, coordinates):
		# Source coordinates to the model frame
		return ((np.asarray(coordinates, float) - self.origin) @ self.axes.T) * self.unit

	def source(self, points):
		# The model frame to source coordinates
		return (np.asarray(points, float) / self.unit) @ self.axes + self.origin

	def plane(self, text):
		# "buttline=28" as a model-frame plane: (normal, offset) with normal . p = offset
		name, number = text.split("=")
		i = self.names.index(name.strip())
		return self.axes[:, i].copy(), (float(number) - self.origin[i]) * self.unit

	def reflection(self):
		# The model-frame matrix taking a point to its mirror image
		if self.mirror is None:
			raise ValueError("frame has no mirror coordinate")
		n = self.axes[:, self.mirror]
		return np.eye(3) - 2 * np.outer(n, n)


def rotation(axis, angle):
	axis = np.asarray(axis, float)
	axis = axis / np.linalg.norm(axis)
	K = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
	return np.eye(3) + math.sin(angle) * K + (1 - math.cos(angle)) * K @ K


def quaternion(q):
	x, y, z, w = q
	return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
		[2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
		[2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def lookup(keys, x):
	# A schedule's output at input x: linear between [input, output] keys, held past the ends
	if x <= keys[0][0]:
		return keys[0][1]
	for (x0, y0), (x1, y1) in zip(keys, keys[1:]):
		if x <= x1:
			return y0 + (y1 - y0) * (x - x0) / (x1 - x0)
	return keys[-1][1]


def pose(joints, drives):
	# The points file's joints driven to the given values (drives not given
	# rest at 0): {node: (motion, axis, value)}, the axis in the model frame
	out = {}
	for name, joint in joints.items():
		out[name] = (joint["motion"], np.array(joint["axis"], float), setting(joint, name, drives))
	return out


def setting(joint, name, drives):
	# A joint's value under the drives: its drive's through its schedule, or
	# the value drives["joints"] gives it by name (radians, or metres for a
	# slide), which poses what no drive can: rudders toed in, one surface of a
	# pair that share a drive deflected apart from the other
	own = drives.get("joints", {})
	if name in own:
		return float(own[name])
	return lookup(joint["keys"], float(drives.get(joint["drive"], 0.0)))


class Model:
	# A glTF binary's nodes and meshes
	def __init__(self, path):
		data = Path(path).read_bytes()
		if data[:4] != b"glTF":
			raise ValueError(f"{path}: not a glTF binary")
		length = struct.unpack_from("<I", data, 12)[0]
		gltf = json.loads(data[20 : 20 + length])
		start = 20 + length
		binary = data[start + 8 : start + 8 + struct.unpack_from("<I", data, start)[0]] if len(data) > start else b""
		sizes = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}
		kinds = {5126: np.float32, 5125: np.uint32, 5123: np.uint16, 5121: np.uint8}

		def accessor(index):
			a = gltf["accessors"][index]
			view = gltf["bufferViews"][a["bufferView"]]
			kind, width = kinds[a["componentType"]], sizes[a["type"]]
			offset = view.get("byteOffset", 0) + a.get("byteOffset", 0)
			stride = view.get("byteStride", 0)
			item = np.dtype(kind).itemsize * width
			if stride and stride != item:
				raw = np.frombuffer(binary, np.uint8, stride * (a["count"] - 1) + item, offset)
				rows = np.lib.stride_tricks.as_strided(raw, (a["count"], item), (stride, 1))
				return np.frombuffer(rows.copy().tobytes(), kind).reshape(a["count"], width)
			return np.frombuffer(binary, kind, a["count"] * width, offset).reshape(a["count"], width)

		materials = [m.get("name", f"material{i}") for i, m in enumerate(gltf.get("materials", []))]
		self.meshes = []
		self.uvs = []   # per mesh, per primitive: each triangle's corners' UVs (n, 3, 2), or None
		for mesh in gltf.get("meshes", []):
			parts, uvs = [], []
			for p in mesh["primitives"]:
				if p.get("mode", 4) != 4:
					continue
				positions = accessor(p["attributes"]["POSITION"]).astype(float)
				indices = accessor(p["indices"]).reshape(-1).astype(np.int64) if "indices" in p else np.arange(len(positions))
				material = materials[p["material"]] if "material" in p else None
				parts.append((positions[indices.reshape(-1, 3)], material))
				uv = p["attributes"].get("TEXCOORD_0")
				uvs.append(accessor(uv).astype(float)[indices.reshape(-1, 3)] if uv is not None else None)
			self.meshes.append(parts)
			self.uvs.append(uvs)
		self.nodes = []
		for i, n in enumerate(gltf.get("nodes", [])):
			local = np.eye(4)
			if "matrix" in n:
				local = np.array(n["matrix"], float).reshape(4, 4).T
			else:
				R = quaternion(n.get("rotation", [0, 0, 0, 1]))
				S = np.diag(n.get("scale", [1, 1, 1]))
				local[:3, :3] = R @ S
				local[:3, 3] = n.get("translation", [0, 0, 0])
			self.nodes.append({"name": n.get("name", f"node{i}"), "local": local, "mesh": n.get("mesh"), "children": n.get("children", []), "parent": None})
		for i, n in enumerate(self.nodes):
			for c in n["children"]:
				self.nodes[c]["parent"] = i
		scene = gltf.get("scenes", [{"nodes": [i for i, n in enumerate(self.nodes) if n["parent"] is None]}])[gltf.get("scene", 0)]
		self.roots = scene["nodes"]
		self.index = {n["name"]: i for i, n in enumerate(self.nodes)}
		self.rest = {}
		for root in self.roots:
			self._rest(root, np.eye(4))

	def _rest(self, i, parent):
		world = parent @ self.nodes[i]["local"]
		self.rest[i] = world
		for c in self.nodes[i]["children"]:
			self._rest(c, world)

	def rotated(self):
		# Nodes resting rotated or scaled (a rig contract that rests every
		# joint at identity forbids them)
		return [n["name"] for n in self.nodes if not np.allclose(n["local"][:3, :3], np.eye(3), atol=1e-6)]

	def worlds(self, posed=None):
		# Each node's world matrix, posed: posed is pose()'s output
		posed = posed or {}
		out = {}

		def walk(i, parent):
			n = self.nodes[i]
			local = n["local"].copy()
			if n["name"] in posed:
				motion, axis, value = posed[n["name"]]
				# the joint's axis is given in the model frame at rest
				inward = np.linalg.inv(self.rest[i][:3, :3]) @ axis
				move = np.eye(4)
				if motion == "rotate":
					move[:3, :3] = rotation(inward, value)
				elif motion == "slide":
					move[:3, 3] = inward / np.linalg.norm(inward) * value
				local = local @ move
			world = parent @ local
			out[i] = world
			for c in n["children"]:
				walk(c, world)

		for root in self.roots:
			walk(root, np.eye(4))
		return out

	def parts(self, posed=None, materials=None):
		# {node name: its own triangles (N, 3, 3) in the model frame}; a joint
		# shown or hidden by a "show" motion is left out while hidden
		posed = posed or {}
		worlds = self.worlds(posed)
		out = {}
		for i, n in enumerate(self.nodes):
			if n["mesh"] is None or i not in worlds:
				continue
			if n["name"] in posed and posed[n["name"]][0] == "show" and posed[n["name"]][2] <= 0.5:
				continue
			pieces = [t for t, m in self.meshes[n["mesh"]] if materials is None or m in materials]
			if not pieces:
				continue
			tris = np.concatenate(pieces)
			W = worlds[i]
			out[n["name"]] = tris @ W[:3, :3].T + W[:3, 3]
		return out

	def triangles(self, posed=None, include=None, exclude=None, materials=None):
		# Every triangle, posed, optionally only the named nodes (include) or
		# all but them (exclude); names match whole node names or prefixes
		# ending in "*"
		def match(name, patterns):
			return any(name == p or (p.endswith("*") and name.startswith(p[:-1])) for p in patterns)

		parts = self.parts(posed, materials)
		chosen = [t for name, t in parts.items() if (include is None or match(name, include)) and not (exclude and match(name, exclude))]
		return np.concatenate(chosen) if chosen else np.zeros((0, 3, 3))


def cut(tris, point, normal):
	# The segments where a plane (through point, with normal) crosses the
	# triangles: (M, 2, 3)
	normal = np.asarray(normal, float) / np.linalg.norm(normal)
	d = (tris - np.asarray(point, float)) @ normal
	d = np.where(np.abs(d) < 1e-12, 1e-12, d)
	crossing = (d.min(1) < 0) & (d.max(1) > 0)
	t, d = tris[crossing], d[crossing]
	out = []
	for a, b in ((0, 1), (1, 2), (2, 0)):
		hit = d[:, a] * d[:, b] < 0
		f = d[:, a] / np.where(hit, d[:, a] - d[:, b], 1.0)
		p = t[:, a] + (t[:, b] - t[:, a]) * f[:, None]
		out.append((hit, p))
	segments = []
	for k in range(len(t)):
		points = [p[k] for hit, p in out if hit[k]]
		if len(points) == 2:
			segments.append(points)
	return np.array(segments).reshape(-1, 2, 3)


def area(tris, normal=None):
	# Total area, or projected along a direction (each face counted once,
	# whichever way it faces: a closed surface projects twice its outline)
	cross = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0]) / 2
	if normal is None:
		return float(np.linalg.norm(cross, axis=1).sum())
	return float(np.abs(cross @ (np.asarray(normal, float) / np.linalg.norm(normal))).sum())


def silhouette(flat, size, depth=None):
	# A mask (rows, columns) of triangles already projected to pixels
	# (N, 3, 2); triangles with any corner behind the camera (depth <= 0) are
	# left out
	image = Image.new("1", size)
	pen = ImageDraw.Draw(image)
	keep = np.ones(len(flat), bool) if depth is None else (depth > 0).all(1)
	for t in flat[keep]:
		pen.polygon([tuple(p) for p in t], fill=1, outline=1)
	return np.array(image)


def boundary(mask):
	# The mask's own pixels that touch an empty 4-neighbour: (K, 2) rows, columns
	p = np.pad(mask, 1)
	inner = p[1:-1, 1:-1] & p[:-2, 1:-1] & p[2:, 1:-1] & p[1:-1, :-2] & p[1:-1, 2:]
	return np.argwhere(mask & ~inner)


def nearest(points, others, chunk=1024):
	# For each point, the distance to the nearest of others and its index
	points, others = np.asarray(points, np.float64), np.asarray(others, np.float64)
	distance = np.empty(len(points))
	index = np.empty(len(points), np.int64)
	if len(others) == 0:
		distance[:] = np.inf
		index[:] = -1
		return distance, index
	for i in range(0, len(points), chunk):
		d = ((points[i : i + chunk, None, :] - others[None]) ** 2).sum(-1)
		index[i : i + chunk] = d.argmin(1)
		distance[i : i + chunk] = np.sqrt(d[np.arange(len(d)), index[i : i + chunk]])
	return distance, index


def outlines(ours, theirs):
	# How two masks' outlines part: for each boundary pixel of each, the
	# distance to the other's outline, signed + where ours stands outside
	# theirs and - inside. Returns (ours: (pixels, signed distance),
	# theirs: (pixels, signed distance))
	a, b = boundary(ours), boundary(theirs)
	da, _ = nearest(a, b)
	db, _ = nearest(b, a)
	sa = np.where(theirs[a[:, 0], a[:, 1]], -1.0, 1.0)
	sb = np.where(ours[b[:, 0], b[:, 1]], 1.0, -1.0)
	return (a, da * sa), (b, db * sb)


def regions(pixels, signed, place, threshold, cell):
	# Where outlines part by more than threshold: the worst miss in each cell
	# of the given size, as [(miss, place...)] worst first. place maps a
	# (row, column) pixel to the coordinates it is reported in
	best = {}
	for (r, c), d in zip(pixels, signed):
		if abs(d) <= threshold:
			continue
		where = place(r, c)
		key = tuple(round(w / cell) for w in where)
		if key not in best or abs(d) > abs(best[key][0]):
			best[key] = (float(d), *where)
	return sorted(best.values(), key=lambda v: -abs(v[0]))
