# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# The stacks check: surfaces the depth buffer can't tell apart. Where a face
# lies a little behind another and overlaps it as seen along its normal, both
# are drawn at nearly the same depth, and from far enough off (or with a near
# plane close enough) the buffer draws the one behind through the one in front
# in stripes and teeth: the hangar doors 5 cm in front of their rooms' backs
# did. A face behind counts when it faces the same way, or the other way with
# a paint drawn on both sides (glTF doubleSided), whose back is then drawn.
# A cutout paint (alphaMode MASK: the lettering) writes depth only where its
# texture is drawn, so its overlap is only where its marks are (the strokes
# of a number, not the plate they are drawn on).
# Each place is the overlap of one node's paint behind another's at one gap,
# its size the side of the largest square inside it. It fails when the face
# in front can be seen (a ray along its normal from the overlap meets nothing
# opaque) and its gap is under STEPS steps of the game's depth buffer at the
# distance where the place still spans PIXELS pixels: the game's camera
# (engine.ts) has its near plane at NEAR, a FIELD of view over LINES lines,
# and a 24-bit buffer, whose step at distance d is d^2 / (NEAR 2^24). A plate
# 0.5 m across needs 4 mm, a door 8 m across 0.96 m. The model viewer draws
# with a logarithmic depth buffer, fine enough everywhere but at no gap at
# all, which fails at any size. The model is posed at rest and with every
# joint at the far end of its keys.
#
# usage: python3 -I stacks.py MODEL.glb SHIP.json
import json, struct, sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "verify"))   # run with -I, which leaves the script's own folder off the path
import model as verify  # noqa: E402
sys.path.insert(0, str(HERE))
from depth import NEAR, FIELD, LINES, PIXELS, STEPS, needed  # noqa: E402,F401

GAP = 1.5        # metres behind a face that count (a place 10 m across needs 1.5)
EDGE = 2e-3      # metres: a face this near another's plane lies in it
FACING = 0.999   # cosine within which two faces are parallel
CELL = 40        # stacks() files faces' normals to this fraction
STRAY = 0.025    # the most a normal strays from its cell's axis (half a CELL'th in each of three)
SPACING = 0.2    # metres between the points sampled over a triangle for the overlap (8 to 48 along a side)


def paints(path):
	# Each material's name: (drawn on both sides, see-through), from the glTF's own JSON
	data = Path(path).read_bytes()
	size = struct.unpack_from("<I", data, 12)[0]
	gltf = json.loads(data[20:20 + size])
	return {m.get("name", f"material{i}"): (bool(m.get("doubleSided", False)), m.get("alphaMode", "OPAQUE") != "OPAQUE")
		for i, m in enumerate(gltf.get("materials", []))}


def cutouts(path):
	# Each cutout paint's (alphaMode MASK, a base colour texture) alpha as an
	# array of rows (the image's top row first, as glTF's v runs) and its
	# cutoff: {name: (alpha, cutoff)}
	import io
	from PIL import Image
	data = Path(path).read_bytes()
	size = struct.unpack_from("<I", data, 12)[0]
	gltf = json.loads(data[20:20 + size])
	start = 20 + size
	binary = data[start + 8:start + 8 + struct.unpack_from("<I", data, start)[0]] if len(data) > start else b""
	out = {}
	for i, m in enumerate(gltf.get("materials", [])):
		texture = m.get("pbrMetallicRoughness", {}).get("baseColorTexture")
		if m.get("alphaMode") != "MASK" or texture is None:
			continue
		image = gltf["images"][gltf["textures"][texture["index"]]["source"]]
		if "bufferView" not in image:
			continue
		view = gltf["bufferViews"][image["bufferView"]]
		raw = binary[view.get("byteOffset", 0):view.get("byteOffset", 0) + view["byteLength"]]
		alpha = np.asarray(Image.open(io.BytesIO(raw)).convert("RGBA"))[:, :, 3].astype(float) / 255
		out[m.get("name", f"material{i}")] = (alpha, float(m.get("alphaCutoff", 0.5)))
	return out


def triangles(shown, posed, with_uvs=False):
	# Every triangle posed, with its node's and paint's names (and, asked,
	# its corners' UVs, NaN where its mesh has none)
	worlds = shown.worlds(posed)
	tris, nodes, names, uvs = [], [], [], []
	for i, n in enumerate(shown.nodes):
		if n["mesh"] is None or i not in worlds:
			continue
		if n["name"] in posed and posed[n["name"]][0] == "show" and posed[n["name"]][2] <= 0.5:
			continue
		world = worlds[i]
		for k, (t, paint) in enumerate(shown.meshes[n["mesh"]]):
			tris.append(t @ world[:3, :3].T + world[:3, 3])
			nodes += [n["name"]] * len(t)
			names += [paint] * len(t)
			uv = shown.uvs[n["mesh"]][k]
			uvs.append(uv if uv is not None else np.full((len(t), 3, 2), np.nan))
	out = (np.concatenate(tris).astype(float), np.array(nodes), np.array(names))
	return out + (np.concatenate(uvs).astype(float),) if with_uvs else out


def drawer(tris, names, uvs, cut):
	# Whether face f is drawn at each of some points in its plane: everywhere
	# for an opaque paint, and for a cutout where its texture's alpha there
	# reaches its cutoff (UVs wrapping, as the texture repeats)
	def drawn(f, points):
		if names[f] not in cut or np.isnan(uvs[f]).any():
			return np.ones(len(points), bool)
		alpha, cutoff = cut[names[f]]
		a, b, c = tris[f]
		e1, e2, q = b - a, c - a, points - a
		d11, d12, d22 = e1 @ e1, e1 @ e2, e2 @ e2
		det = d11 * d22 - d12 * d12
		if abs(det) < 1e-18:
			return np.zeros(len(points), bool)
		q1, q2 = q @ e1, q @ e2
		v = (d22 * q1 - d12 * q2) / det
		w = (d11 * q2 - d12 * q1) / det
		uv = uvs[f][0] + v[:, None] * (uvs[f][1] - uvs[f][0]) + w[:, None] * (uvs[f][2] - uvs[f][0])
		rows, columns = alpha.shape
		row = np.clip(((uv[:, 1] % 1.0) * rows).astype(int), 0, rows - 1)
		column = np.clip(((uv[:, 0] % 1.0) * columns).astype(int), 0, columns - 1)
		return alpha[row, column] >= cutoff
	return drawn


def poses(ship):
	# At rest, and every drive at the far end of its joints' keys
	far = {}
	for joint in ship.get("joints", {}).values():
		far[joint["drive"]] = max(far.get(joint["drive"], 0.0), max(k[0] for k in joint["keys"]))
	return {"rest": verify.pose(ship.get("joints", {}), {}), "far": verify.pose(ship.get("joints", {}), far)}


def escapes(tris, points, direction):
	# Of the points, how many see out along the direction without meeting a triangle
	a, e1, e2 = tris[:, 0], tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0]
	p = np.cross(direction, e2)
	det = np.einsum("ij,ij->i", e1, p)
	ok = np.abs(det) > 1e-12
	inv = np.where(ok, 1 / np.where(ok, det, 1), 0)
	out = 0
	for origin in points:
		q = origin - a
		u = np.einsum("ij,ij->i", q, p) * inv
		c = np.cross(q, e1)
		v = (c @ direction) * inv
		t = np.einsum("ij,ij->i", e2, c) * inv
		out += not (ok & (u >= -1e-9) & (v >= -1e-9) & (u + v <= 1 + 1e-9) & (t > 1e-6)).any()
	return out


def stacks(tris, nodes, names, sides, gap=GAP, drawn=None):
	# The places where a face lies within gap behind another (see the top):
	# each {behind: (node, paint, way), front: (node, paint), gap, area, size,
	# points (the overlap's sample points in the front face's plane), normal}.
	# drawn(face, points), where given, says where each face is drawn: the
	# overlap is sized over the cells both are drawn in
	e1, e2 = tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0]
	normal = np.cross(e1, e2)
	area = np.linalg.norm(normal, axis=1) / 2
	keep = area > 1e-6
	normal = normal / np.maximum(2 * area, 1e-12)[:, None]
	both = np.array([sides.get(n, (True, False))[0] for n in names])
	# one way round each plane, so opposite faces meet in one list
	sign = np.where(normal @ np.array([0.5773, 0.5774, 0.5775]) < 0, -1.0, 1.0)
	plane = normal * sign[:, None]
	low, high = tris.min(axis=1), tris.max(axis=1)
	grids = {}

	def sampled(t):
		# points inside a triangle, about SPACING apart
		count = int(np.clip(np.ceil(np.ptp(t, axis=0).max() / SPACING), 8, 48))
		if count not in grids:
			g = np.array([(a, b) for a in range(count) for b in range(count - a)], float)
			grids[count] = (g + 1 / 3) / count
		g = grids[count]
		return t[0] + g[:, :1] * (t[1] - t[0]) + g[:, 1:] * (t[2] - t[0])

	def within(points, t, n):
		a, b, c = t
		return ((np.cross(b - a, points - a) @ n) > 1e-9) & ((np.cross(c - b, points - b) @ n) > 1e-9) & ((np.cross(a - c, points - c) @ n) > 1e-9)
	# the faces filed by their planes' normals to the CELL'th, each sought
	# among its own cell's and the neighbouring cells' (normals either side of
	# a cell's edge fell in two lists that never met), along the cell's own
	# axis: along each face's own normal, two faces a degree apart 160 m from
	# the origin lay metres apart. A face's normal strays from its cell's axis
	# by up to STRAY, so two faces r and r' across lie as much as
	# STRAY (r + r') further apart along the axis than along the normal
	groups = {}
	for k in np.flatnonzero(keep):
		groups.setdefault(tuple(np.round(plane[k] * CELL).astype(int)), []).append(k)
	middle = tris.mean(axis=1)
	radius = np.linalg.norm(tris - middle[:, None], axis=2).max(axis=1)
	around = [(i, j, k) for i in (-1, 0, 1) for j in (-1, 0, 1) for k in (-1, 0, 1)]
	pairs = []
	for key, members in groups.items():
		pool = np.array([m for shift in around for m in groups.get(tuple(a + b for a, b in zip(key, shift)), [])])
		axis = np.array(key, float) / max(np.linalg.norm(key), 1e-12)
		along = middle[pool] @ axis
		order = pool[np.argsort(along)]
		sorted_along = np.sort(along)
		largest = radius[pool].max()
		for j in members:
			# j in front: the others within gap of its plane, behind it along its own normal
			reach = gap + EDGE + STRAY * (radius[j] + largest + gap)
			lo = np.searchsorted(sorted_along, middle[j] @ axis - reach)
			hi = np.searchsorted(sorted_along, middle[j] @ axis + reach, side="right")
			near = order[lo:hi]
			near = near[(near != j) & (np.abs(normal[near] @ normal[j]) > FACING)]
			depth = ((tris[j, 0] - tris[near].mean(axis=1)) @ normal[j])
			near, depth = near[(depth >= -EDGE / 2) & (depth <= gap)], depth[(depth >= -EDGE / 2) & (depth <= gap)]
			same = normal[near] @ normal[j] > 0
			# a face facing away counts only when its back is drawn (a face in
			# j's own plane beside it overlaps it nowhere, and drops out below)
			counts = np.where(same, True, both[near])
			near, depth, same = near[counts], depth[counts], same[counts]
			near_box = (low[near] <= high[j] + gap).all(axis=1) & (high[near] >= low[j] - gap).all(axis=1)
			near, depth, same = near[near_box], depth[near_box], same[near_box]
			if not len(near):
				continue
			n = normal[j]
			mine = sampled(tris[j])
			for i, d, s in zip(near, depth, same):
				# i's points over j, and j's over i, in j's plane
				points = sampled(tris[i])
				points = points + n * ((tris[j, 0] - points) @ n)[:, None]
				inside = within(points, tris[j], n)
				if inside.any():
					over = within(mine, tris[i] + n * ((tris[j, 0] - tris[i, 0]) @ n), n)
					pairs.append((i, j, max(float(d), 0.0), bool(s), inside.mean() * area[i], np.concatenate([points[inside], mine[over]]),
						overlap(tris[i], tris[j], n)))
	# a place: the pairs of one node's paint behind another's, one way round,
	# at one gap to the millimetre, facing one way, whose overlaps touch
	parent = list(range(len(pairs)))

	def root(x):
		while parent[x] != x:
			parent[x] = parent[parent[x]]
			x = parent[x]
		return x
	keyed = {}
	for p, (i, j, d, s, _, _, _) in enumerate(pairs):
		keyed.setdefault((nodes[i], names[i], nodes[j], names[j], s, round(d, 3), tuple(np.round(normal[j], 2))), []).append(p)
	for members in keyed.values():
		boxes = [(pairs[p][5].min(axis=0) - 0.05, pairs[p][5].max(axis=0) + 0.05) for p in members]
		for x in range(len(members)):
			for y in range(x + 1, len(members)):
				if (boxes[x][0] <= boxes[y][1]).all() and (boxes[y][0] <= boxes[x][1]).all():
					parent[root(members[x])] = root(members[y])
	places = {}
	for p in range(len(pairs)):
		places.setdefault(root(p), []).append(p)
	out = []
	for members in places.values():
		i, j, d, s, _, _, _ = pairs[members[0]]
		points = np.concatenate([pairs[p][5] for p in members])
		n = normal[j]
		u, w = frame(n)
		used = [p for p in members if len(pairs[p][6]) >= 3]
		masks = None
		if drawn is not None:
			def mask(pair):
				front, back = pairs[pair][1], pairs[pair][0]
				# a cell's centre lifted back onto each face's plane
				lift = lambda c, f: c[:, :1] * u + c[:, 1:] * w + (tris[f, 0] @ n) * n
				return lambda c: drawn(front, lift(c, front)) & drawn(back, lift(c, back))
			masks = [mask(p) for p in used]
		out.append({"behind": (str(nodes[i]), str(names[i]), "same" if s else "back"), "front": (str(nodes[j]), str(names[j])),
			"gap": d, "area": sum(pairs[p][4] for p in members),
			"size": widest([np.stack([pairs[p][6] @ u, pairs[p][6] @ w], axis=1) for p in used], masks),
			"points": points, "normal": n})
	return out


def frame(n):
	# Two directions square to n and each other
	u = np.cross(n, [0, 1, 0] if abs(n[1]) < 0.9 else [1, 0, 0])
	u /= np.linalg.norm(u)
	return u, np.cross(n, u)


def overlap(behind, front, n):
	# Where one triangle, moved along n into another's plane, covers it: the
	# polygon (convex, in the front's plane) the two share
	u, w = frame(n)
	origin = front[0]
	flat = lambda q: np.stack([(q - origin) @ u, (q - origin) @ w], axis=1)
	polygon = list(flat(behind))
	clip = flat(front)
	if (clip[1][0] - clip[0][0]) * (clip[2][1] - clip[0][1]) - (clip[1][1] - clip[0][1]) * (clip[2][0] - clip[0][0]) < 0:
		clip = clip[::-1]
	for k in range(3):
		e, f = clip[k], clip[(k + 1) % 3]
		side = lambda p: (f[0] - e[0]) * (p[1] - e[1]) - (f[1] - e[1]) * (p[0] - e[0])
		kept = []
		for m in range(len(polygon)):
			p, q = polygon[m], polygon[(m + 1) % len(polygon)]
			sp, sq = side(p), side(q)
			if sp >= 0:
				kept.append(p)
			if (sp >= 0) != (sq >= 0):
				kept.append(p + (q - p) * (sp / (sp - sq)))
		polygon = kept
		if not polygon:
			return np.zeros((0, 3))
	return np.array([origin + a * u + b * w for a, b in polygon])


def widest(polygons, masks=None):
	# The side of the largest square inside the union of convex polygons:
	# drawn on a grid and worn away a cell at a time from every side. A grid
	# of thin strips is as wide as a strip, a door as wide as the door. With
	# masks (one a polygon, from cells' centres to whether they count), only
	# the cells they keep
	def anticlockwise(p):
		turn = np.sum(p[:, 0] * np.roll(p[:, 1], -1) - np.roll(p[:, 0], -1) * p[:, 1])
		return p if turn >= 0 else p[::-1]
	if masks is None:
		masks = [None] * len(polygons)
	kept = [(anticlockwise(p), m) for p, m in zip(polygons, masks) if len(p) >= 3]
	polygons = [p for p, _ in kept]
	if not polygons:
		return 0.0
	every = np.concatenate(polygons)
	low, high = every.min(axis=0), every.max(axis=0)
	cell = max(0.01, (high - low).max() / 300)
	shape = np.ceil((high - low) / cell).astype(int) + 3
	mask = np.zeros(shape, bool)
	for p, keep in kept:
		a, b = np.floor((p.min(axis=0) - low) / cell).astype(int), np.ceil((p.max(axis=0) - low) / cell).astype(int) + 1
		gu, gw = np.meshgrid(np.arange(a[0], b[0]), np.arange(a[1], b[1]), indexing="ij")
		centres = np.stack([gu, gw], axis=-1) * cell + low + cell / 2
		inside = np.ones(gu.shape, bool)
		for k in range(len(p)):
			e, f = p[k], p[(k + 1) % len(p)]
			inside &= (f[0] - e[0]) * (centres[..., 1] - e[1]) - (f[1] - e[1]) * (centres[..., 0] - e[0]) >= -1e-9
		if keep is not None and inside.any():
			inside[inside] = keep(centres[inside])
		mask[gu[inside] + 1, gw[inside] + 1] = True
	worn = 0
	while mask.any():
		# a cell stays while all eight round it do: a square wears to its middle
		kept = mask.copy()
		for du in (-1, 0, 1):
			for dw in (-1, 0, 1):
				kept &= np.roll(np.roll(mask, du, 0), dw, 1)
		mask = kept
		worn += 1
	return max(2 * worn - 1, 0) * cell


def failing(tris, names, sides, places):
	# The places whose gap is under what their size needs and whose front face
	# can be seen (see the top)
	opaque = tris[np.array([not sides.get(n, (True, False))[1] for n in names])]
	out = []
	for place in places:
		if place["size"] <= 0 or place["gap"] >= needed(place["size"]) and place["gap"] > 1e-4:
			continue
		points = place["points"][np.linspace(0, len(place["points"]) - 1, min(7, len(place["points"]))).astype(int)]
		seen = escapes(opaque, points + place["normal"] * 2e-3, place["normal"])
		if seen:
			out.append(dict(place, needed=needed(place["size"]), seen=seen, tried=len(points)))
	return sorted(out, key=lambda p: p["gap"] / p["needed"])


def main():
	shown = verify.Model(sys.argv[1])
	ship = json.loads(Path(sys.argv[2]).read_text())
	sides = paints(sys.argv[1])
	cut = cutouts(sys.argv[1])
	found = {}
	for label, posed in poses(ship).items():
		tris, nodes, names, uvs = triangles(shown, posed, with_uvs=True)
		for place in failing(tris, names, sides, stacks(tris, nodes, names, sides, drawn=drawer(tris, names, uvs, cut))):
			box = np.round(np.concatenate([place["points"].min(axis=0), place["points"].max(axis=0)]), 1)
			key = (place["behind"], place["front"], round(place["gap"], 3), tuple(box))
			found.setdefault(key, (place, []))[1].append(label)
	for (behind, front, gap, box), (place, labels) in sorted(found.items(), key=lambda kv: kv[1][0]["gap"] / kv[1][0]["needed"]):
		print(f"FAIL {behind[0]}/{behind[1]} ({'facing the same way' if behind[2] == 'same' else 'its back drawn'}) {gap * 100:.1f} cm behind {front[0]}/{front[1]}:"
			f" {place['area']:.2f} m2, {place['size']:.2f} m across, which needs {place['needed'] * 100:.1f} cm; seen {place['seen']}/{place['tried']},"
			f" x {box[0]}..{box[3]} y {box[1]}..{box[4]} z {box[2]}..{box[5]} ({', '.join(labels)})")
	print(f"stacks: {len(found)} seen with less gap than their size needs")
	sys.exit(1 if found else 0)


if __name__ == "__main__":
	main()
