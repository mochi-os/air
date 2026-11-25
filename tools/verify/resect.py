# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# Solves photos' cameras one at a time against the build, outside the shared
# solve: each named photo's marks against the build's landmarks posed as the
# photo stands. For a photo that measures a surface the model already has
# (its paint and panel lines, rectify.py), where adding it to the bundle could
# move every other camera (README.md, Pitfalls): catalogue it "solve": false.
# Writes the cameras in photos.py's --cameras form, each mark's miss, and with
# --overlays the build's curves and landmarks drawn over each photo.
#
# usage: python3 -I resect.py CATALOGUE MODEL.glb POINTS.json FEATURES.json OUT.json PHOTO ... [--references DIR] [--overlays DIR] [--distortion]
import json, math, sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))
import camera as cam  # noqa: E402
import model as mod  # noqa: E402
from photos import Features  # noqa: E402

LEAST = 6   # marks a camera needs: seven unknowns, two equations a mark


def resect(features, entry, size):
	# (camera, misses {name: pixels}) from a photo's marks
	drives = entry.get("pose", {})
	names = [n for n in entry.get("marks", {}) if n in features.landmarks]
	if len(names) < LEAST:
		raise ValueError(f"{len(names)} marks with landmarks, {LEAST} needed")
	points = np.array([features.landmark(n, drives) for n in names])
	pixels = np.array([entry["marks"][n] for n in names], float)
	centre = np.array(size, float) / 2
	return names, points, pixels, centre


def overlay(path, image, camera, centre, features, drives, entry, width=1600):
	# The photo with the build's curves (green) and landmarks (cyan) projected
	# through the camera, and each mark (red) joined to its landmark
	scale = width / image.width
	out = image.convert("RGB").resize((width, round(image.height * scale)))
	draw = ImageDraw.Draw(out)
	for name in features.curves:
		px, depth = cam.project(camera, features.curve(name, drives), centre)
		if (depth > 0).all():
			draw.line([tuple(p * scale) for p in px], fill=(60, 255, 60), width=1)
	for name in features.landmarks:
		(p,), (d,) = cam.project(camera, features.landmark(name, drives)[None], centre)
		if d > 0:
			x, y = p * scale
			draw.ellipse([x - 2, y - 2, x + 2, y + 2], outline=(0, 230, 255))
	for name, (mx, my) in entry.get("marks", {}).items():
		x, y = mx * scale, my * scale
		draw.line([x - 4, y, x + 4, y], fill=(255, 40, 40))
		draw.line([x, y - 4, x, y + 4], fill=(255, 40, 40))
		if name in features.landmarks:
			(p,), _ = cam.project(camera, features.landmark(name, drives)[None], centre)
			draw.line([x, y, p[0] * scale, p[1] * scale], fill=(255, 40, 40))
			draw.text((x + 5, y - 12), name, fill=(255, 220, 0))
	out.save(path, quality=88)


def main():
	args = sys.argv[1:]
	flags = {}
	for key in ("--references", "--overlays"):
		if key in args:
			i = args.index(key)
			flags[key] = args[i + 1]
			del args[i:i + 2]
	distortion = "--distortion" in args
	args = [a for a in args if a != "--distortion"]
	catalogue_path, model_path, points_path, features_path, out_path, *photos = args
	catalogue = json.loads(Path(catalogue_path).read_text())
	references = Path(flags.get("--references", Path(catalogue_path).resolve().parent / "references"))
	model = mod.Model(model_path)
	joints = mod.joints(json.loads(Path(points_path).read_text()))
	features = Features(model, joints, features_path)
	frame = mod.Frame(catalogue["frame"])
	out = []
	for photo in photos:
		entry = catalogue["photos"][photo]
		image = Image.open(references / entry["file"])
		size = [image.width, image.height]
		names, points, pixels, centre = resect(features, entry, size)
		camera, misses = cam.solve(points, pixels, centre, image.width, distortion=distortion)
		miss = np.hypot(*misses.T)
		rms = float(np.sqrt(np.mean(miss ** 2)))
		field = math.degrees(2 * math.atan(image.width / 2 / camera[0]))
		eye = frame.source(cam.eye(camera))
		print(f"{photo}: {len(names)} marks, rms {rms:.1f} px, field {field:.1f} deg, camera at {', '.join(f'{v:.0f}' for v in eye)} ({' '.join(frame.names)})")
		for n, m in sorted(zip(names, miss), key=lambda t: -t[1]):
			print(f"  {n:34s} {m:6.1f} px")
		out.append({"photo": photo, "file": entry["file"], "size": size, "camera": [float(v) for v in camera], "pose": entry.get("pose", {}), "field": round(field, 2), "rms": round(rms, 1)})
		if "--overlays" in flags:
			Path(flags["--overlays"]).mkdir(parents=True, exist_ok=True)
			overlay(Path(flags["--overlays"]) / f"{photo}.jpg", image, camera, centre, features, entry.get("pose", {}), entry)
	Path(out_path).write_text(json.dumps(out, indent="\t"))


if __name__ == "__main__":
	main()
