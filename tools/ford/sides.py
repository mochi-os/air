# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# The sides check: no face is seen from behind where its paint is opaque and
# drawn on its front only (glTF doubleSided false, every paint but the sheets
# build.py's BOTH names; a see-through one, the lettering, shows what lies past
# it from behind as a painted mark does). A renderer skips such a face seen from behind and shows what
# lies beyond it: a part wound inside out shows its far side, a sheet seen
# from its back vanishes, and a crack in a closed hull shows the sea through
# the ship. A face in the same plane facing the other way covers a face's
# back (a floor and the underside beneath it). From each face (its middle, and on a large one three more points)
# RAYS rays go out into the half of space in front of it and as many behind
# it; one behind that meets nothing (the see-through paints let rays through)
# fails the face. The model is posed at rest and with every joint at the far
# end of its keys (stacks.py's poses).
#
# usage: blender -b --factory-startup --python-use-system-env -P sides.py -- MODEL.glb SHIP.json [FACES.json]
# (FACES.json: every failing face, its node, paint, pose, middle, normal, area and rays)
import json, sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "verify"))
import stacks  # noqa: E402

RAYS = 12        # rays a side from each point
LARGE = 0.5      # m2: a face this large is tried from four points
SMALL = 1e-4     # m2: a face this small (a sliver) can't be seen from behind at any range, and isn't tried
REACH = 5000.0   # metres a ray runs
PLANE = 2e-3     # metres: a face this near another's plane lies in it (stacks.py's EDGE)
BUCKET = 0.25    # metres: the step twins() files faces' planes at


def hemisphere(count=RAYS):
	# Directions spread over the half of space above the plane z = 0
	golden = (1 + 5 ** 0.5) / 2
	out = []
	for k in range(count):
		z = 1 - (k + 0.5) / count
		r = (1 - z * z) ** 0.5
		a = 2 * np.pi * k / golden
		out.append((r * np.cos(a), r * np.sin(a), z))
	return np.array(out)


def caster(tris):
	# A ray cast against the triangles: in Blender a BVH tree, else numpy
	# (slow: for a small model)
	try:
		from mathutils import Vector
		from mathutils.bvhtree import BVHTree
	except ImportError:
		a, e1, e2 = tris[:, 0], tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0]

		def cast(origin, direction):
			p = np.cross(direction, e2)
			det = np.einsum("ij,ij->i", e1, p)
			ok = np.abs(det) > 1e-12
			inv = np.where(ok, 1 / np.where(ok, det, 1), 0)
			q = origin - a
			u = np.einsum("ij,ij->i", q, p) * inv
			c = np.cross(q, e1)
			v = (c @ direction) * inv
			t = np.einsum("ij,ij->i", e2, c) * inv
			return bool((ok & (u >= 0) & (v >= 0) & (u + v <= 1) & (t > 1e-6) & (t < REACH)).any())
		return cast
	verts = tris.reshape(-1, 3)
	tree = BVHTree.FromPolygons([Vector(v) for v in verts], [tuple(f) for f in np.arange(len(verts)).reshape(-1, 3)], all_triangles=True, epsilon=0.0)
	return lambda origin, direction: tree.ray_cast(Vector(origin), Vector(direction), REACH)[0] is not None


def twins(others):
	# For a triangle's points, whether a face of others in its plane facing
	# the other way covers each: its back is that face's front (a floor and
	# the underside under it, a sheet built of two faces), which no ray from
	# behind it meets. A point is in another's plane when it lies within
	# PLANE of it. The others are filed by their normals turned round (to
	# the hundredth) and how far along that rounded normal their middles lie
	# (to BUCKET): measured along each face's own normal, a face 2 mm out of
	# level 18 m from the origin lay 7 mm from its twin's plane, and its twin
	# went unfound
	normal = np.cross(others[:, 1] - others[:, 0], others[:, 2] - others[:, 0])
	normal /= np.maximum(np.linalg.norm(normal, axis=1), 1e-12)[:, None]
	offset = np.einsum("ij,ij->i", normal, others[:, 0])
	middle = others.mean(axis=1)

	def filing(n):
		key = np.round(n * 100).astype(int)
		return tuple(key), key / max(np.linalg.norm(key), 1e-12)
	filed = {}
	for k in range(len(others)):
		key, axis = filing(-normal[k])
		filed.setdefault((key, int(round(float(axis @ middle[k]) / BUCKET))), []).append(k)
	nearby = [(i, j, k) for i in (-1, 0, 1) for j in (-1, 0, 1) for k in (-1, 0, 1)]

	def covered(points, n):
		out = np.zeros(len(points), bool)
		key, _ = filing(n)
		for shift in nearby:
			near = tuple(a + b for a, b in zip(key, shift))
			axis = np.array(near) / max(np.linalg.norm(near), 1e-12)
			d = float((points @ axis).mean())
			for step in (-1, 0, 1):
				for k in filed.get((near, int(round(d / BUCKET)) + step), []):
					if normal[k] @ n > -0.999:
						continue
					a, b, c = others[k]
					for j, q in enumerate(points):
						if not out[j] and abs(normal[k] @ q - offset[k]) <= PLANE:
							e = [np.cross(b - a, q - a) @ n, np.cross(c - b, q - b) @ n, np.cross(a - c, q - c) @ n]
							out[j] = min(e) >= -1e-9 or max(e) <= 1e-9
		return out
	return covered


def seen(tris, cast, rays=None, covered=None):
	# For each triangle, how many rays from it get away in front of it and
	# how many behind it (none from a point a twin covers behind, twins())
	rays = hemisphere() if rays is None else rays
	e1, e2 = tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0]
	normal = np.cross(e1, e2)
	area = np.linalg.norm(normal, axis=1) / 2
	normal = normal / np.maximum(2 * area, 1e-12)[:, None]
	front, back = np.zeros(len(tris), int), np.zeros(len(tris), int)
	for i in np.flatnonzero(area > SMALL):
		n = normal[i]
		u = np.cross(n, [0, 0, 1] if abs(n[2]) < 0.9 else [1, 0, 0])
		u /= np.linalg.norm(u)
		w = np.cross(n, u)
		middle = tris[i].mean(axis=0)
		points = [middle] if area[i] < LARGE else [middle] + [middle + 0.6 * (corner - middle) for corner in tris[i]]
		hidden = covered(np.array(points), n) if covered is not None else [False] * len(points)
		for side, count in ((1, front), (-1, back)):
			for p, twin in zip(points, hidden):
				if side < 0 and twin:
					continue
				origin = p + side * n * 2e-3
				for d in rays:
					count[i] += not cast(origin, d[0] * u + d[1] * w + d[2] * side * n)
	return front, back, area


def failing(tris, names, sides, cast_from=caster):
	# The faces of opaque paints drawn on one side whose backs are seen:
	# indices, with how many rays got away behind and in front of each. A
	# see-through paint drawn on one side (the lettering, clear but for its
	# marks) shows what lies past it from behind, as a painted mark does
	clear = np.array([not sides.get(n, (True, False))[1] for n in names])
	one = clear & np.array([not sides.get(n, (True, False))[0] for n in names])
	cast = cast_from(tris[clear])
	front, back, area = seen(tris[one], cast, covered=twins(tris[clear]))
	where = np.flatnonzero(one)
	bad = back > 0
	return [(int(i), int(b), int(f)) for i, b, f in zip(where[bad], back[bad], front[bad])], area


def main():
	args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
	shown = stacks.verify.Model(args[0])
	ship = json.loads(Path(args[1]).read_text())
	sides = stacks.paints(args[0])
	found, faces = {}, []
	for label, posed in stacks.poses(ship).items():
		tris, nodes, names = stacks.triangles(shown, posed)
		bad, _ = failing(tris, names, sides)
		for i, behind, ahead in bad:
			t = tris[i]
			normal = np.cross(t[1] - t[0], t[2] - t[0])
			faces.append({"node": str(nodes[i]), "paint": str(names[i]), "pose": label, "middle": np.round(t.mean(axis=0), 3).tolist(),
				"normal": np.round(normal / max(np.linalg.norm(normal), 1e-12), 3).tolist(), "area": round(float(np.linalg.norm(normal) / 2), 4),
				"behind": behind, "ahead": ahead})
			key = (str(nodes[i]), str(names[i]))
			entry = found.setdefault(key, {"faces": set(), "area": 0.0, "poses": set(), "worst": None})
			if (label, i) in entry["faces"]:
				continue
			entry["faces"].add((label, i))
			t = tris[i]
			entry["area"] += np.linalg.norm(np.cross(t[1] - t[0], t[2] - t[0])) / 2
			entry["poses"].add(label)
			if entry["worst"] is None or behind - ahead > entry["worst"][0]:
				entry["worst"] = (behind - ahead, behind, ahead, np.round(t.mean(axis=0), 2))
	for (node, paint), e in sorted(found.items(), key=lambda kv: -kv[1]["area"]):
		_, behind, ahead, at = e["worst"]
		print(f"FAIL {node}/{paint}: {len(e['faces'])} faces ({e['area']:.2f} m2) seen from behind ({', '.join(sorted(e['poses']))});"
			f" most at ({at[0]}, {at[1]}, {at[2]}), {behind} rays away behind it and {ahead} in front")
	if len(args) > 2:
		Path(args[2]).write_text(json.dumps(faces))
	print(f"sides: {sum(len(e['faces']) for e in found.values())} faces seen from behind in {len(found)} node paints")
	sys.stdout.flush()
	sys.exit(1 if found else 0)


if __name__ == "__main__":
	main()
