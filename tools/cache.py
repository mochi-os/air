# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# The bakes a Blender build keeps between runs (its --cache DIR): an atlas's
# UVs and the arrays baked on them, each entry under a key of everything they
# come from, so a build whose inputs an earlier build has seen takes them from
# the cache instead of baking them again.
#
# A key (Key) is built from the parts' own faces, the faces round them within
# reach of the occlusion's rays, and what the caller adds: its specs, the
# facts its bakes read, the code that unwraps and bakes. None of it hangs on
# the order the faces were made in: a face is its vertices in its own
# winding, turned to start at its least (cycles()), with their exact places,
# its shading, its sharp edges and its material. The UVs go back face by
# face, found by those cycles.
#
# Runs inside Blender (bpy).
import hashlib, inspect, itertools, json, math, os, shutil
from pathlib import Path

import bpy
import numpy as np

# The cache's version: bump it to drop every cached entry
VERSION = "1"
# Entries kept of each group, the latest made or used
KEPT = 3


def placed(o):
	# An object's vertices in the world (N, 3), as Blender has them now (call
	# view_layer.update() first after moving or parenting anything)
	co = np.empty(len(o.data.vertices) * 3, np.float32)
	o.data.vertices.foreach_get("co", co)
	matrix = np.array(o.matrix_world, np.float64)
	return co.reshape(-1, 3).astype(np.float64) @ matrix[:3, :3].T + matrix[:3, 3]


def cycles(o, turned=False):
	# Each face of an object by its vertices in its own winding, turned to
	# start at its least: the same face whatever order the faces were made in.
	# With `turned`, also how far each was turned
	mesh = o.data
	n = len(mesh.polygons)
	starts, totals = np.empty(n, np.int32), np.empty(n, np.int32)
	mesh.polygons.foreach_get("loop_start", starts)
	mesh.polygons.foreach_get("loop_total", totals)
	corners = np.empty(len(mesh.loops), np.int32)
	mesh.loops.foreach_get("vertex_index", corners)
	out, turns = [], []
	for p in range(n):
		cycle = corners[starts[p] : starts[p] + totals[p]].tolist()
		k = cycle.index(min(cycle))
		out.append(tuple(cycle[k:] + cycle[:k]))
		turns.append(k)
	return (out, turns) if turned else out


def surface(triangles, spacing):
	# Points over triangles (N, 3, 3), none of whose edges they divide into
	# pieces longer than `spacing`
	longest = np.linalg.norm(triangles - np.roll(triangles, 1, axis=1), axis=2).max(1)
	steps = np.maximum(1, np.ceil(longest / spacing)).astype(int)
	out = []
	for n in np.unique(steps):
		i, j = np.mgrid[0 : n + 1, 0 : n + 1]
		keep = i + j <= n
		weights = np.stack([i[keep], j[keep], n - i[keep] - j[keep]], 1) / n
		out.append(np.einsum("pk,tkd->tpd", weights, triangles[steps == n]).reshape(-1, 3))
	return np.concatenate(out) if out else np.zeros((0, 3))


def near(points, low, high, reach, cell):
	# Which boxes (low, high: (N, 3)) come within `reach` of any of the points:
	# space cut into cells `cell` across, a box kept when it meets a cell
	# within reach of a point's cell (their nearest corners). It may keep a box
	# up to a cell's diagonal further off, never drop a nearer one
	if not len(points) or not len(low):
		return np.zeros(len(low), bool)

	def code(c):
		c = c.astype(np.int64) + (1 << 20)
		return (c[..., 0] << 42) | (c[..., 1] << 21) | c[..., 2]

	cells = np.unique(np.floor(points / cell).astype(np.int64), axis=0)
	steps = int(math.ceil(reach / cell)) + 1
	around = np.array(list(itertools.product(range(-steps, steps + 1), repeat=3)))
	# a neighbour whose nearest point to the cell lies within reach
	gap = np.maximum(np.abs(around) - 1, 0) * cell
	around = around[(gap ** 2).sum(1) <= reach ** 2]
	occupied = np.unique(code((cells[:, None, :] + around[None]).reshape(-1, 3)))

	def member(codes):
		at = np.minimum(np.searchsorted(occupied, codes), len(occupied) - 1)
		return occupied[at] == codes

	low, high = np.floor(low / cell).astype(np.int64), np.floor(high / cell).astype(np.int64)
	# boxes up to 8 cells along each axis a cell at a time, all at once; the
	# few larger ones each on its own
	small = ((high - low) < 8).all(1)
	hit = np.zeros(len(low), bool)
	for step in itertools.product(range(8), repeat=3):
		hit[small] |= member(code(np.minimum(low[small] + step, high[small])))
	for t in np.nonzero(~small)[0]:
		grid = np.stack(np.meshgrid(*[np.arange(low[t, d], high[t, d] + 1) for d in range(3)], indexing="ij"), -1)
		hit[t] = member(code(grid.reshape(-1, 3))).any()
	return hit


def materials(o):
	# The material's name on each face of an object ("" for an empty slot)
	slots = np.empty(len(o.data.polygons), np.int32)
	o.data.polygons.foreach_get("material_index", slots)
	names = [m.name if m else "" for m in o.data.materials] + [""]
	return [names[min(s, len(names) - 1)] for s in slots.tolist()]


def faces(objects):
	# Every face of the objects in the world: each one's bounding box (low,
	# high) and a digest of it (its object, its vertices and their places, its
	# material), the same whatever order the faces were made in
	lows, highs, digests = [], [], []
	for o in sorted(objects, key=lambda o: o.name):
		world = placed(o)
		name = o.name.encode()
		for face, paint in zip(cycles(o), materials(o)):
			at = world[list(face)]
			lows.append(at.min(0))
			highs.append(at.max(0))
			digests.append(hashlib.blake2b(name + np.array(face, np.int32).tobytes() + at.tobytes() + paint.encode(), digest_size=16).digest())
	return np.array(lows).reshape(-1, 3), np.array(highs).reshape(-1, 3), digests


class Key:
	# A sha256 over what an entry comes from, each piece length-prefixed so
	# no two lists of pieces read the same
	def __init__(self, group):
		self.hash = hashlib.sha256()
		self.add([VERSION, bpy.app.version_string, group], Path(__file__).read_bytes())

	def add(self, *pieces):
		for data in pieces:
			data = data if isinstance(data, bytes) else json.dumps(data, sort_keys=True).encode()
			self.hash.update(len(data).to_bytes(8, "little"))
			self.hash.update(data)

	def code(self, *functions):
		# the source of the functions (or classes) that make what is cached
		for f in functions:
			self.add(inspect.getsource(f).encode())

	def meshes(self, objects):
		# The objects' own faces: their cycles (which carry their winding),
		# their vertices' places in the world, their shading and sharp edges
		# (from which their normals follow), their materials, and any shape
		# key's weight (with its shape, when it is weighted at all). An object
		# whose mesh a modifier changes would bake what no key here sees
		bpy.context.view_layer.update()
		for o in sorted(objects, key=lambda o: o.name):
			if o.modifiers:
				raise ValueError(f"{o.name}: a modifier changes what bakes, and the key reads the mesh alone")
			mesh = o.data
			world = placed(o)
			found = cycles(o)
			smooth = np.empty(len(mesh.polygons), bool)
			mesh.polygons.foreach_get("use_smooth", smooth)
			self.add(o.name.encode())
			self.add(repr(sorted(zip(found, smooth.tolist(), materials(o)))).encode())
			used = np.unique(np.concatenate([np.array(f, np.int64) for f in found])) if found else np.zeros(0, np.int64)
			self.add(used.tobytes(), world[used].tobytes())
			sharp = mesh.attributes.get("sharp_edge")
			if sharp is not None and len(mesh.edges):
				flags = np.empty(len(mesh.edges), bool)
				sharp.data.foreach_get("value", flags)
				ends = np.empty(len(mesh.edges) * 2, np.int32)
				mesh.edges.foreach_get("vertices", ends)
				pairs = np.sort(ends.reshape(-1, 2)[flags], 1)
				pairs = pairs[np.isin(pairs, used).all(1)]
				self.add(pairs[np.lexsort(pairs.T[::-1])].tobytes())
			else:
				self.add(b"")
			blocks = mesh.shape_keys.key_blocks if mesh.shape_keys else []
			for block in blocks:
				self.add([block.name, block.value, block.mute])
				if block.value and not block.mute:
					co = np.empty(len(block.data) * 3, np.float32)
					block.data.foreach_get("co", co)
					self.add(co.tobytes())

	def surroundings(self, objects, others, reach, spacing):
		# Every face of `others` within `reach` (metres) of the objects' faces,
		# whose rays could meet it: the objects' faces sampled no more than
		# `spacing` apart along their edges, so a face up to reach + spacing off
		# counts; and the reach itself, which the bake's rays go as far as
		bpy.context.view_layer.update()
		self.add([reach, spacing])
		own = []
		for o in objects:
			world = placed(o)
			for face in cycles(o):
				for k in range(1, len(face) - 1):
					own.append(world[[face[0], face[k], face[k + 1]]])
		low, high, digests = faces(others)
		keep = near(surface(np.array(own).reshape(-1, 3, 3), spacing), low, high, reach + spacing, max(reach, spacing))
		self.add(b"".join(sorted(digests[i] for i in np.nonzero(keep)[0])))

	def hex(self):
		return self.hash.hexdigest()


def uvs(o, uv=None):
	# The object's faces, each by its cycle, with the loops of its corners in
	# the cycle's order, and those corners' UVs from the layer's (N, 2) `uv`:
	# [(cycle, loops, uvs)]
	starts = np.empty(len(o.data.polygons), np.int32)
	o.data.polygons.foreach_get("loop_start", starts)
	found, turns = cycles(o, turned=True)
	out = []
	for p, (face, k) in enumerate(zip(found, turns)):
		loops = starts[p] + (np.arange(len(face)) + k) % len(face)
		out.append((face, loops, None if uv is None else uv[loops]))
	return out


def entry(folder, group, key):
	# Where a group's entry under a key lies in the cache
	return Path(folder) / f"{group}-{key[:24]}"


def fetch(folder, group, key, objects, bake):
	# The arrays a group's bake makes (bake(): {name: array}, the objects'
	# active UV layer laid as it bakes): from the cache folder, with the UVs
	# they were baked on, when it holds an entry under the key (Key) whose faces
	# are the objects' (the entry then counts as the group's latest, so the
	# KEPT outlive it no sooner than the newest); else baked, and kept there.
	# Says which it was
	place = entry(folder, group, key.hex()) if folder else None
	arrays = restored(place, objects) if place else None
	if arrays is not None:
		os.utime(place)
		print(f"bakes {group}: from the cache, {place.name}", flush=True)
		return arrays
	print(f"bakes {group}: baked", flush=True)
	arrays = bake()
	if place:
		stored(place, objects, arrays)
	return arrays


def stored(place, objects, arrays):
	# An entry into the cache: each object's active UV layer, by name, face by
	# face (each face's cycle and its corners' UVs in the cycle's order), and
	# the arrays baked on them, each as it is; the group's KEPT latest made
	# or used kept
	partial = place.with_name(place.name + ".part")
	shutil.rmtree(partial, ignore_errors=True)
	partial.mkdir(parents=True)
	saved, layers = {}, {}
	for o in objects:
		layer = o.data.uv_layers.active
		uv = np.zeros(len(o.data.loops) * 2, np.float32)
		if layer is not None:
			layer.data.foreach_get("uv", uv)
		found = uvs(o, uv.reshape(-1, 2))
		layers[o.name] = layer.name if layer is not None else None
		saved[o.name + "/sizes"] = np.array([len(f) for f, _, _ in found], np.int32)
		saved[o.name + "/cycles"] = np.array([v for f, _, _ in found for v in f], np.int32)
		saved[o.name + "/uv"] = np.concatenate([u for _, _, u in found]) if found else np.zeros((0, 2), np.float32)
	np.savez(partial / "uv.npz", **saved)
	(partial / "layers.json").write_text(json.dumps(layers, sort_keys=True))
	np.savez_compressed(partial / "baked.npz", **arrays)
	shutil.rmtree(place, ignore_errors=True)
	partial.rename(place)
	group = place.name.rsplit("-", 1)[0]
	kept = sorted((p for p in place.parent.glob(group + "-*") if not p.name.endswith(".part") and p.name.rsplit("-", 1)[0] == group),
		key=lambda p: p.stat().st_mtime)
	for p in kept[:-KEPT]:
		shutil.rmtree(p, ignore_errors=True)


def restored(place, objects):
	# A cached entry's UVs onto the objects, each face found by its cycle (a
	# cycle twice over, a face doubled, takes the cached UVs of its twins in
	# turn), and its arrays; None, changing nothing, when there is no entry or
	# its faces and the objects' differ
	if not (place / "baked.npz").exists():
		return None
	saved = np.load(place / "uv.npz")
	layers = json.loads((place / "layers.json").read_text())
	if sorted(layers) != sorted(o.name for o in objects):
		return None
	found = []
	for o in objects:
		sizes, flat, values = saved[o.name + "/sizes"], saved[o.name + "/cycles"], saved[o.name + "/uv"]
		cached, at = {}, 0
		for n in sizes.tolist():
			cached.setdefault(tuple(flat[at : at + n].tolist()), []).append(values[at : at + n])
			at += n
		uv = np.zeros((len(o.data.loops), 2), np.float32)
		for face, loops, _ in uvs(o):
			if not cached.get(face):
				return None
			uv[loops] = cached[face].pop(0)
		if any(cached.values()):
			return None
		found.append((o, uv))
	for o, uv in found:
		name = layers[o.name]
		if name is None:
			continue
		layer = o.data.uv_layers.get(name) or o.data.uv_layers.new(name=name)
		o.data.uv_layers.active = layer
		layer.data.foreach_set("uv", uv.ravel())
	with np.load(place / "baked.npz") as baked:
		return {k: baked[k] for k in baked.files}
