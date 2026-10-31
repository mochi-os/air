# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# Casts pixels of a solved photo onto the model: where each pixel's sight line
# meets the model's surface, posed as the photo has it, or a plane of the
# project's frame ("buttline=13.1"). A mark on a surface the model already has
# right lies on it, where the bundle, seeing it from one side, can leave it
# inches deep along the sight line (README.md, Pitfalls). With --project it
# goes the other way: project coordinates to pixels, to find where to look.
#
# usage: python3 -I cast.py CATALOGUE MODEL.glb POINTS.json CAMERAS.json PHOTO [--onto NODE,...] name=x,y[@plane] ...
#        python3 -I cast.py CATALOGUE MODEL.glb POINTS.json CAMERAS.json PHOTO --project name=a,b,c ...
#
# CAMERAS.json is photos.py's --cameras output; --onto limits the surface to
# named nodes (a trailing * matches a prefix); a pixel given @plane is cast
# onto that plane instead (for a part standing off the surface).
import json, sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))   # run with -I, which leaves the script's own folder off the path
import camera as cam  # noqa: E402
import model as mod  # noqa: E402


def hit(triangles, origin, direction):
	# The nearest point ahead along a ray where it meets any of the triangles
	# (N, 3, 3), or None
	a, b, c = triangles[:, 0], triangles[:, 1], triangles[:, 2]
	e1, e2 = b - a, c - a
	p = np.cross(direction, e2)
	det = (e1 * p).sum(1)
	ok = np.abs(det) > 1e-12
	inverse = np.where(ok, 1 / np.where(ok, det, 1), 0)
	s = origin - a
	u = (s * p).sum(1) * inverse
	q = np.cross(s, e1)
	v = (q * direction).sum(1) * inverse
	t = (e2 * q).sum(1) * inverse
	good = ok & (u >= 0) & (v >= 0) & (u + v <= 1) & (t > 1e-9)
	return origin + direction * t[good].min() if good.any() else None


class Caster:
	# One solved photo of the catalogue, and the model posed as it shows it
	def __init__(self, catalogue, model, points, cameras, photo, onto=None):
		self.frame = mod.Frame(catalogue["frame"])
		entry = {c["photo"]: c for c in cameras}[photo]
		self.camera = np.array(entry["camera"], float)
		self.centre = np.array(entry["size"], float) / 2
		posed = mod.pose(points.get("joints", {}), entry.get("pose", {}))
		self.triangles = model.triangles(posed, include=onto)

	def cast(self, pixel, plane=None):
		# (how, source coordinates): the surface the pixel shows, or the plane
		if plane is None:
			p = hit(self.triangles, cam.eye(self.camera), cam.ray(self.camera, pixel, self.centre))
			if p is not None:
				return "surface", self.frame.source(p)
		if plane is None:
			return "missed", None
		normal, offset = self.frame.plane(plane)
		return plane, self.frame.source(cam.cast(self.camera, pixel, self.centre, normal, offset))

	def project(self, coordinates):
		# The pixel and depth (metres) of a point in source coordinates
		pixels, depth = cam.project(self.camera, self.frame.model(coordinates)[None], self.centre)
		return pixels[0], float(depth[0])


def main():
	args = [a for a in sys.argv[1:]]
	onto = None
	if "--onto" in args:
		i = args.index("--onto")
		onto = args[i + 1].split(",")
		del args[i: i + 2]
	backwards = "--project" in args
	if backwards:
		args.remove("--project")
	catalogue, model, points, cameras, photo = args[:5]
	caster = Caster(json.loads(Path(catalogue).read_text()), mod.Model(model), json.loads(Path(points).read_text()),
		json.loads(Path(cameras).read_text()), photo, onto)
	names = caster.frame.names
	for request in args[5:]:
		name, rest = request.split("=", 1)
		if backwards:
			pixel, depth = caster.project([float(v) for v in rest.split(",")])
			print(f"{name:28s} pixel {pixel[0]:8.1f} {pixel[1]:8.1f}   depth {depth:.2f} m")
			continue
		plane = None
		if "@" in rest:
			rest, plane = rest.split("@", 1)
		how, p = caster.cast([float(v) for v in rest.split(",")], plane)
		if p is None:
			print(f"{name:28s} misses the surface: give a plane (@{names[2]}=...)")
			continue
		print(f"{name:28s} {how:16s} " + "  ".join(f"{n} {v:8.2f}" for n, v in zip(names, p)))


if __name__ == "__main__":
	main()
