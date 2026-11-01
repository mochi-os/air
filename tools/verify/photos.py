# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# The photo match (README.md, step 4): solves every reference photo's camera
# and every marked point together (camera.Bundle), from a catalogue that says
# where points fall in each photo, which points' coordinates sources cite
# (anchors, any of their three coordinates, each with its uncertainty), and
# which edges were traced. Then it reports, in the project's own units:
#
#   photos   each camera, and how well its marks fit (pixels)
#   points   each point the photos measure, with its uncertainty, beside where
#            the model puts it (the build's features file) and the miss
#   anchors  how far the photos pull each cited coordinate
#   edges    each traced edge's distance from the model: the posed model's
#            silhouette ("outline") or one of the build's curves, at the depth
#            the edge lies at
#   locate   pixels cast back onto planes ("buttline=28")
#
# Overlays (--overlays DIR) draw the model and every mark on each photo;
# --cameras FILE writes the solved cameras for view.py, and --sheets RENDERS
# DIR lays view.py's renders beside and over the photos. --check holds the
# match to the catalogue's gate (gate()) and exits non-zero on a miss it does
# not already know of.
#
# The catalogue (JSON):
#   frame    model.Frame's spec
#   points   {name: {"at": [3 numbers or null], "sigma": number or [3], "why": text}}: cited coordinates
#   mirror   [left suffix, right suffix]: pairs solved as one point and its mirror image
#   photos   {id: {"file": path under the catalogue's references folder, "pose": {drive: value, "joints": {joint: value}}
#                  (a joint named there takes that value past its drive), "solve": false to leave it out,
#                  "marks": {point: [x, y]}, "edges": {name: {"against": "outline" | curve name,
#                  "points": [[x, y], ...], "snap": pixels}}, "locate": {name: [x, y, "plane=value"]}}}
#   gate     {"edge": inches, "sigmas": n, "floor": inches, "field": degrees, "rms": pixels,
#             "known": {"edge PHOTO:NAME" or "point NAME": why}}: what --check fails on (gate())
#
# usage: python3 -I photos.py CATALOGUE.json MODEL.glb POINTS.json FEATURES.json [--json] [--check]
#        [--overlays DIR] [--cameras FILE] [--sheets RENDERS DIR] [--only ID,ID]
import json, math, sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))   # run with -I, which leaves the script's own folder off the path
import camera as cam  # noqa: E402
import model as mod  # noqa: E402

Image.MAX_IMAGE_PIXELS = None


def options(argv):
	args, flags = [], {}
	i = 0
	while i < len(argv):
		a = argv[i]
		if a in ("--json", "--check"):
			flags[a[2:]] = True
		elif a == "--sheets":
			flags["sheets"] = (argv[i + 1], argv[i + 2])
			i += 2
		elif a.startswith("--"):
			flags[a[2:]] = argv[i + 1]
			i += 1
		else:
			args.append(a)
		i += 1
	return args, flags


def priors(frame, spec):
	# A catalogue point's cited coordinates as model-frame planes: (normal, offset, sigma metres)
	at = spec.get("at", [None, None, None])
	sigma = spec.get("sigma", 1.0)
	sigmas = sigma if isinstance(sigma, list) else [sigma] * 3
	out = []
	for i, (v, s) in enumerate(zip(at, sigmas)):
		if v is None:
			continue
		normal = frame.axes[:, i].copy()
		out.append((normal, (v - frame.origin[i]) * frame.unit, s * frame.unit))
	return out


class Features:
	# The build's landmarks and curves, posed with the model
	def __init__(self, model, joints, path):
		data = json.loads(Path(path).read_text())
		self.model, self.joints = model, joints
		self.landmarks = data.get("landmarks", {})
		self.curves = data.get("curves", {})

	def moved(self, drives, node, points):
		points = np.asarray(points, float).reshape(-1, 3)
		if node not in self.model.index:
			return points
		i = self.model.index[node]
		posed = self.model.worlds(mod.pose(self.joints, drives))[i]
		M = posed @ np.linalg.inv(self.model.rest[i])
		return points @ M[:3, :3].T + M[:3, 3]

	def landmark(self, name, drives=None):
		spec = self.landmarks[name]
		return self.moved(drives or {}, spec.get("node"), spec["at"])[0]

	def curve(self, name, drives=None):
		spec = self.curves[name]
		return self.moved(drives or {}, spec.get("node"), spec["points"])


def exif_focal(image):
	# The lens's focal length in pixels from the photo's EXIF (focal length
	# and the sensor's pixels per unit), or None where the EXIF was stripped
	exif = image.getexif()
	sub = exif.get_ifd(0x8769)
	focal, pitch, unit = sub.get(0x920A), sub.get(0xA20E), sub.get(0xA210)
	if not focal or not pitch or unit not in (2, 3):
		return None
	return float(focal) * float(pitch) / (25.4 if unit == 2 else 10.0)


def snap(gray, points, radius):
	# Moves each traced point along its local normal to the strongest edge
	# within radius pixels
	pts = np.asarray(points, float)
	if len(pts) < 2 or radius <= 0:
		return pts
	out = pts.copy()
	h, w = gray.shape
	for k in range(len(pts)):
		a, b = pts[max(k - 1, 0)], pts[min(k + 1, len(pts) - 1)]
		t = b - a
		n = np.array([-t[1], t[0]]) / (np.linalg.norm(t) or 1)
		steps = np.arange(-radius, radius + 1)
		samples = pts[k] + steps[:, None] * n
		x = np.clip(samples[:, 0].round().astype(int), 0, w - 1)
		y = np.clip(samples[:, 1].round().astype(int), 0, h - 1)
		profile = gray[y, x]
		gradient = np.abs(np.gradient(profile))
		out[k] = samples[int(np.argmax(gradient))]
	return out


def to_segments(flat):
	return np.stack([flat[:-1], flat[1:]], 1)


def segment_distance(points, segments):
	# Each point's distance to the nearest segment, and that segment's index
	p = np.asarray(points, float)[:, None, :]
	a, b = segments[None, :, 0], segments[None, :, 1]
	ab = b - a
	t = np.clip(((p - a) * ab).sum(-1) / np.maximum((ab * ab).sum(-1), 1e-12), 0, 1)
	d = np.linalg.norm(a + ab * t[..., None] - p, axis=-1)
	return d.min(1), d.argmin(1)


class Match:
	def __init__(self, catalogue, glb, points_file, features_file, only=None):
		self.root = Path(catalogue).resolve().parent
		self.catalogue = json.loads(Path(catalogue).read_text())
		self.frame = mod.Frame(self.catalogue["frame"])
		self.model = mod.Model(glb)
		self.joints = json.loads(Path(points_file).read_text())["joints"]
		self.features = Features(self.model, self.joints, features_file)
		# a photo marked "solve": false stays catalogued but out of the solve (too
		# few marks to fix its camera: it needs six or more, spread in depth)
		self.ids = [i for i, e in self.catalogue["photos"].items() if (not only or i in only) and e.get("solve", True)]
		self.photos = []
		for pid in self.ids:
			entry = self.catalogue["photos"][pid]
			with Image.open(self.root / "references" / entry["file"]) as image:
				size = image.size
				lens = exif_focal(image)
			self.photos.append({"id": pid, "entry": entry, "size": size, "centre": (size[0] / 2, size[1] / 2), "width": size[0],
				"sigma": entry.get("sigma", max(1.5, size[0] / 2500)), "marks": {n: tuple(p) for n, p in entry.get("marks", {}).items()},
				"distortion": entry.get("distortion", len(entry.get("marks", {})) >= 20), "camera": None,
				"focal": (lens, 0.1) if lens else None})

	def solve(self, log=print):
		points = {}
		for name, spec in self.catalogue.get("points", {}).items():
			points[name] = {"priors": priors(self.frame, spec)}
		for photo in self.photos:
			for name in photo["marks"]:
				points.setdefault(name, {"priors": []})
		# The model's own positions only start the solve (cameras need four
		# known points to begin); the answer rests on the marks and the cited
		# priors alone, and each point's spread shows what they leave loose
		for name in points:
			if name in self.features.landmarks:
				points[name]["value"] = self.features.landmark(name, self.pose_for(name))
		pairs = []
		suffixes = self.catalogue.get("mirror")
		if suffixes:
			left, right = suffixes
			for name in points:
				if name.endswith(left) and name[: -len(left)] + right in points:
					pairs.append((name, name[: -len(left)] + right))
		self.bundle = cam.Bundle(self.photos, points, mirror=(self.frame.reflection(), pairs) if pairs else None)
		missing = self.bundle.initialise(log=log)
		for k in missing:
			log(f"photo {self.photos[k]['id']}: too few known points to start its camera; left out")
		self.cameras, self.points = self.bundle.solve()
		return self

	def report(self):
		out = {"photos": {}, "points": {}, "anchors": {}, "edges": {}, "locate": {}}
		misses = self.bundle.misses()
		f = self.frame
		for k, photo in enumerate(self.photos):
			if k not in self.cameras:
				out["photos"][photo["id"]] = {"solved": False}
				continue
			c = self.cameras[k]
			m = misses.get(k, {})
			pixels = [math.hypot(du, dv) for du, dv, _ in m.values()]
			inches = {n: round(math.hypot(du, dv) * d / c[0] / f.unit, 2) for n, (du, dv, d) in m.items()}
			outliers = sorted(n for n, (du, dv, _) in m.items() if math.hypot(du, dv) > 5 * photo["sigma"])
			out["photos"][photo["id"]] = {"solved": True, "focal": round(float(c[0])), "field": round(math.degrees(2 * math.atan(photo["width"] / 2 / c[0])), 2),
				"outliers": outliers,
				"k1": round(float(c[7]), 4), "camera": [round(float(v), 1) for v in f.source(cam.eye(c))], "marks": len(m),
				"rms": round(float(np.sqrt(np.mean(np.square(pixels)))) if pixels else 0.0, 1), "worst": max(inches.items(), key=lambda kv: kv[1]) if inches else None,
				"misses": inches}
		for name, p in self.points.items():
			seen = sum(1 for ph in self.photos if name in ph["marks"])
			at = f.source(p)
			spread = self.bundle.spread.get(name)
			sigma = (np.sqrt(np.abs(np.diag(f.axes.T @ spread @ f.axes))) / f.unit) if spread is not None else np.zeros(3)
			row = {"photos": seen, "sigma": [round(float(v), 2) for v in sigma]}
			# Directions the photos leave unfixed (one photo's line of sight),
			# in the project's axes: along them the solved position means nothing
			loose = self.bundle.loose.get(name, np.zeros((0, 3))) @ f.axes
			if len(loose):
				loose = loose / np.linalg.norm(loose, axis=1, keepdims=True)
				row["loose"] = [[round(float(v), 3) for v in r] for r in loose]
			spec = self.catalogue.get("points", {}).get(name)
			if spec:
				cited = spec.get("at")
				share = np.abs(loose).max(axis=0) if len(loose) else np.zeros(3)
				out["anchors"][name] = {"cited": cited, "pull": [None if c is None or s > 0.1 else round(float(m - c), 2) for c, m, s in zip(cited, at, share)],
					"why": spec.get("why")}
			if name in self.features.landmarks:
				ours = f.source(self.features.landmark(name, self.pose_for(name)))
				if len(loose):
					# the photos fix a line (or plane): measure at its point nearest the model's
					basis = np.linalg.qr(loose.T)[0]
					at = at + basis @ (basis.T @ (ours - at))
				row["model"] = [round(float(v), 2) for v in ours]
				row["miss"] = [round(float(v), 2) for v in ours - at]
			row["measured"] = [round(float(v), 2) for v in at]
			out["points"][name] = row
		for k, photo in enumerate(self.photos):
			if k not in self.cameras:
				continue
			for name, edge in photo["entry"].get("edges", {}).items():
				out["edges"][f"{photo['id']}:{name}"] = self.edge(k, edge)
			for name, (u, v, plane) in photo["entry"].get("locate", {}).items():
				normal, offset = f.plane(plane)
				hit = cam.cast(self.cameras[k], (u, v), photo["centre"], normal, offset)
				out["locate"][f"{photo['id']}:{name}"] = {n: round(float(x), 1) for n, x in zip(f.names, f.source(hit))}
		return out

	def pose_for(self, name):
		# the drives of the first photo that marks the point
		for ph in self.photos:
			if name in ph["marks"]:
				return ph["entry"].get("pose", {})
		return {}

	def silhouette(self, k, scale):
		photo = self.photos[k]
		tris = self.model.triangles(mod.pose(self.joints, photo["entry"].get("pose", {})))
		flat, depth = cam.project(self.cameras[k], tris.reshape(-1, 3), photo["centre"])
		size = (int(photo["size"][0] * scale), int(photo["size"][1] * scale))
		return mod.silhouette(flat.reshape(-1, 3, 2) * scale, size, depth.reshape(-1, 3)), tris

	def edge(self, k, edge):
		# A traced edge against the model, each traced point's miss in the project's units
		photo, c, f = self.photos[k], self.cameras[k], self.frame
		points = np.asarray(edge["points"], float)
		if edge["against"] != "outline" and edge["against"] not in self.features.curves:
			# a curve this build does not export yet (a part not built): say so, not crash
			return {"against": edge["against"], "points": len(points), "missing": True}
		if edge.get("snap"):
			with Image.open(self.root / "references" / photo["entry"]["file"]) as image:
				gray = np.asarray(image.convert("L"), float)
			points = snap(gray, points, int(edge["snap"]))
		drives = photo["entry"].get("pose", {})
		if edge["against"] == "outline":
			scale = min(1.0, 4000 / max(photo["size"]))
			mask, tris = self.silhouette(k, scale)
			rim = mod.boundary(mask)[:, ::-1] / scale   # (x, y) pixels
			d, i = mod.nearest(points, rim)
			inside = mask[np.clip((points[:, 1] * scale).astype(int), 0, mask.shape[0] - 1), np.clip((points[:, 0] * scale).astype(int), 0, mask.shape[1] - 1)]
			sign = np.where(inside, 1.0, -1.0)   # + the model stands outside the photo's edge
			flat, depth = cam.project(c, tris.reshape(-1, 3), photo["centre"])
			_, j = mod.nearest(rim[i], flat)
			depths = depth[j]
		else:
			curve = self.features.curve(edge["against"], drives)
			flat, depth = cam.project(c, curve, photo["centre"])
			d, i = segment_distance(points, to_segments(flat))
			sign = np.ones(len(points))
			depths = (depth[i] + depth[i + 1]) / 2
		inches = d * sign * depths / c[0] / f.unit
		# an outline's misses are signed (+ the model outside); a curve's are
		# distances only, with no side
		return {"against": edge["against"], "points": len(points), "signed": edge["against"] == "outline", "median": round(float(np.median(np.abs(inches))), 2),
			"worst": round(float(inches[np.argmax(np.abs(inches))]), 2), "misses": [round(float(v), 2) for v in inches]}

	def overlays(self, directory, width=2400):
		Path(directory).mkdir(parents=True, exist_ok=True)
		for k, photo in enumerate(self.photos):
			if k not in self.cameras:
				continue
			c = self.cameras[k]
			scale = width / photo["size"][0]
			with Image.open(self.root / "references" / photo["entry"]["file"]) as image:
				base = np.asarray(image.convert("RGB").resize((width, int(photo["size"][1] * scale))), np.uint8).copy()
			mask, _ = self.silhouette(k, scale)
			rim = mod.boundary(mask)
			base[mask] = (base[mask] * 0.7 + np.array([40, 80, 220]) * 0.3).astype(np.uint8)
			base[rim[:, 0], rim[:, 1]] = (255, 40, 40)
			out = Image.fromarray(base)
			pen = ImageDraw.Draw(out)
			drives = photo["entry"].get("pose", {})
			for name in self.features.curves:
				flat, depth = cam.project(c, self.features.curve(name, drives), photo["centre"])
				if (depth > 0).all():
					pen.line([tuple(p * scale) for p in flat], fill=(0, 230, 230), width=2)
			for name, (u, v) in photo["marks"].items():
				if name not in self.points:
					continue
				(p,), _ = cam.project(c, [self.points[name]], photo["centre"])
				pen.ellipse([u * scale - 5, v * scale - 5, u * scale + 5, v * scale + 5], outline=(255, 255, 0), width=2)
				pen.line([u * scale, v * scale, p[0] * scale, p[1] * scale], fill=(0, 255, 0), width=2)
				if name in self.features.landmarks:
					(q,), _ = cam.project(c, [self.features.landmark(name, drives)], photo["centre"])
					pen.rectangle([q[0] * scale - 4, q[1] * scale - 4, q[0] * scale + 4, q[1] * scale + 4], outline=(255, 0, 255), width=2)
			for name, edge in photo["entry"].get("edges", {}).items():
				pts = [tuple(np.asarray(p) * scale) for p in edge["points"]]
				pen.line(pts, fill=(255, 200, 0), width=2)
			out.save(Path(directory) / f"{photo['id']}.jpg", quality=88)

	def write_cameras(self, path):
		# each solved camera, with its field of view and fit (the gate's
		# measure of a weak camera, which skyline.py applies too)
		out = []
		report = self.report()["photos"]
		for k, photo in enumerate(self.photos):
			if k in self.cameras:
				fit = report[photo["id"]]
				out.append({"photo": photo["id"], "file": photo["entry"]["file"], "size": photo["size"], "camera": [float(v) for v in self.cameras[k]],
					"pose": photo["entry"].get("pose", {}), "field": fit["field"], "rms": fit["rms"]})
		Path(path).write_text(json.dumps(out, indent="\t") + "\n")

	def sheets(self, renders, directory, width=1600):
		# Each photo (its lens distortion removed) beside the model rendered
		# through its camera, and the two laid over each other
		Path(directory).mkdir(parents=True, exist_ok=True)
		for k, photo in enumerate(self.photos):
			render = Path(renders) / f"{photo['id']}.png"
			if k not in self.cameras or not render.exists():
				continue
			c = self.cameras[k]
			with Image.open(self.root / "references" / photo["entry"]["file"]) as image:
				flat = straighten(image.convert("RGB"), c, photo["centre"], width)
			shaded = Image.open(render).convert("RGBA").resize(flat.size)
			alpha = np.asarray(shaded)[..., 3:] / 255.0
			over = (np.asarray(flat, float) * (1 - 0.55 * alpha) + np.asarray(shaded)[..., :3] * 0.55 * alpha).astype(np.uint8)
			edge = mod.boundary(alpha[..., 0] > 0.5)
			over[edge[:, 0], edge[:, 1]] = (255, 40, 40)
			plain = Image.alpha_composite(Image.new("RGBA", flat.size, (235, 235, 235, 255)), shaded).convert("RGB")
			for name, picture in (("photo", flat), ("model", plain), ("over", Image.fromarray(over))):
				picture.save(Path(directory) / f"{photo['id']}-{name}.jpg", quality=85)


def straighten(image, camera, centre, width):
	# The photo resampled as the pinhole without k1 sees it, scaled to width
	k1 = camera[7]
	scale = width / image.width
	size = (width, int(image.height * scale))
	if abs(k1) < 1e-6:
		return image.resize(size)
	f = camera[0]
	ys, xs = np.mgrid[0 : size[1], 0 : size[0]]
	x = (xs / scale - centre[0]) / f
	y = (ys / scale - centre[1]) / f
	s = 1 + k1 * (x * x + y * y)
	u = np.clip(centre[0] + f * x * s, 0, image.width - 1)
	v = np.clip(centre[1] + f * y * s, 0, image.height - 1)
	source = np.asarray(image)
	return Image.fromarray(source[v.round().astype(int), u.round().astype(int)])


def text(report):
	lines = []
	for pid, p in report["photos"].items():
		if not p["solved"]:
			lines.append(f"photo {pid}: not solved")
			continue
		worst = f"{p['worst'][0]} {p['worst'][1]:.1f} in" if p["worst"] else "-"
		lines.append(f"photo {pid}: {p['marks']} marks, rms {p['rms']} px, field {p['field']} deg, k1 {p['k1']}, camera at {p['camera']}, worst {worst}")
		if p["outliers"]:
			lines.append(f"  marks missing by more than 5 sigma (check them): {', '.join(p['outliers'])}")
	lines.append("")
	for name, p in sorted(report["points"].items()):
		row = f"{name:34s} {p['photos']} photos  measured {p['measured']} +- {p['sigma']}"
		if "miss" in p:
			row += f"  model {p['model']}  miss {p['miss']}"
		if "loose" in p:
			row += f"  loose along {p['loose']}" + (" (miss across it only)" if "miss" in p else "")
		lines.append(row)
	lines.append("")
	for name, a in report["anchors"].items():
		lines.append(f"anchor {name:27s} cited {a['cited']} pulled {a['pull']}")
	lines.append("")
	for name, e in report["edges"].items():
		if e.get("missing"):
			lines.append(f"edge {name:40s} against {e['against']:24s} {e['points']:3d} points: the model has no such curve")
			continue
		worst = f"{e['worst']:+6.2f} in" if e.get("signed", True) else f"{abs(e['worst']):6.2f} in, no side (a curve)"
		lines.append(f"edge {name:40s} against {e['against']:24s} {e['points']:3d} points, median {e['median']:5.2f} in, worst {worst}")
	for name, l in report["locate"].items():
		lines.append(f"locate {name}: {l}")
	return "\n".join(lines)


def weak(field, rms, spec):
	# A camera too narrow (spec["field"] degrees or less: its depth is barely
	# fixed) or fitting its marks too loosely (spec["rms"] pixels) to judge an
	# outline away from its marks
	return field <= spec["field"] or rms > spec["rms"]


def gate(report, spec):
	# What the match fails on, against the catalogue's gate: each traced edge
	# whose median miss passes spec["edge"] inches, and each point the photos
	# measure whose miss on any coordinate passes both spec["sigmas"] of its
	# uncertainty and spec["floor"] inches (a point one photo sees misses
	# across its sight line only). A camera at the field-of-view floor
	# (spec["field"] degrees or less) or fitting its marks worse than
	# spec["rms"] pixels judges no edge: its outlines away from its marks
	# cannot judge a shape. Returns (failures, known, unjudged), each a list of
	# (name, text); a miss spec["known"] names goes to known, with its why
	failures, known, unjudged = [], [], []
	accepted = spec.get("known", {})

	def add(name, text):
		(known if name in accepted else failures).append((name, f"{text}: {accepted[name]}" if name in accepted else text))

	weaks = {pid for pid, p in report["photos"].items() if p["solved"] and weak(p["field"], p["rms"], spec)}
	for name, e in sorted(report["edges"].items()):
		photo = name.split(":")[0]
		if photo in weaks:
			unjudged.append((f"edge {name}", f"camera {photo} at field {report['photos'][photo]['field']} deg, rms {report['photos'][photo]['rms']} px"))
		elif e.get("missing"):
			add(f"edge {name}", "the model has no such curve")
		elif e["median"] > spec["edge"]:
			worst = f"{e['worst']:+.2f}" if e.get("signed", True) else f"{abs(e['worst']):.2f} (a distance from the build's curve, without a side)"
			add(f"edge {name}", f"median miss {e['median']:.2f} in, worst {worst}")
	for name, p in sorted(report["points"].items()):
		if "miss" not in p:
			continue
		over = [abs(m) > max(spec["sigmas"] * s, spec["floor"]) for m, s in zip(p["miss"], p["sigma"])]
		if any(over):
			add(f"point {name}", f"miss {p['miss']} in, uncertainty {p['sigma']} ({p['photos']} photos)")
	return failures, known, unjudged


def main():
	args, flags = options(sys.argv[1:])
	only = flags["only"].split(",") if "only" in flags else None
	match = Match(*args[:4], only=only).solve(log=lambda m: print(m, file=sys.stderr))
	report = match.report()
	print(json.dumps(report, indent="\t") if flags.get("json") else text(report))
	failures = []
	if flags.get("check"):
		spec = json.loads(Path(args[0]).read_text()).get("gate")
		if spec is None:
			sys.exit("the catalogue has no gate")
		failures, known, unjudged = gate(report, spec)
		print("")
		for heading, rows in (("unjudged (a weak camera)", unjudged), ("known", known), ("FAILED", failures)):
			for name, why in rows:
				print(f"{heading}: {name}: {why}")
		print(f"gate: {len(failures)} failed, {len(known)} known, {len(unjudged)} unjudged")
	# the outputs first, so a run that fails the gate still leaves its
	# cameras and overlays to look into the failure with
	if "overlays" in flags:
		match.overlays(flags["overlays"])
	if "cameras" in flags:
		match.write_cameras(flags["cameras"])
	if "sheets" in flags:
		match.sheets(*flags["sheets"])
	if flags.get("check") and failures:
		sys.exit(1)


if __name__ == "__main__":
	main()
