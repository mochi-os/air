# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# Each photo's moving parts fitted to its own outline. Most photos'
# catalogue poses are guesses, and a surface posed wrong reads in the sky
# check (skyline.py) as a miss of its shape. For every solved photo and every
# joint scanned (scans(): the catalogue's "poses" section, or the jet's
# hinged surfaces) whose part's outline the photo judges against the sky at
# its catalogue pose (at least PLACES places), the joint is turned or slid
# across its range on its own, every other joint held at the catalogue pose,
# and the value kept at which the places on that part miss least: the mean
# size of their misses with the worst TRIM of them left out. A value at
# which the part keeps fewer than FLOOR of its places (turned edge-on, or
# hidden) does not count, nor a least at either end of the range. The part's
# own travel limits are the reviewer's to apply: they are the model's facts.
#
# It prints each photo's parts, the catalogue's value and miss beside the
# fitted ones, and writes every fit to OUT.json with the "joints" entry
# (radians, or metres for a slide) a photo's catalogue pose takes for the
# fits that halve the miss or better (model.py setting). It changes nothing:
# a fit goes into the catalogue by hand, after a look at the photo.
#
# usage: python3 -I poses.py CATALOGUE.json MODEL.glb POINTS.json CAMERAS.json OUT.json [--only ID,ID]
import json, math, sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))   # run with -I, which leaves the script's own folder off the path
import model as mod  # noqa: E402
import skyline  # noqa: E402

SURFACES = ("rudder_", "stabilator_", "flap_trailing_", "aileron_", "flap_leading_")   # the hinged surfaces' joints, by name
TRAVEL = 0.8    # radians either way of rest the scan covers (46 deg: past every surface's limit)
STEP = 0.1      # radians between the scan's angles, then halved twice about the best
MOTIONS = ("rotate", "slide")   # the joints' motions a scan can move
PLACES = 8      # places a photo must judge on a surface at its catalogue pose to fit it
FLOOR = 0.75    # share of those places an angle must keep to count: losing more, it measures some other edge
TRIM = 0.2      # share of the largest misses left out of the score
BETTER = 0.5    # a fit enters the catalogue entry when its score is at most this share of the catalogue pose's


def score(misses):
	# The mean size of the misses, the largest TRIM of them left out
	sizes = np.sort(np.abs(np.asarray(misses, float)))
	keep = max(1, math.ceil(len(sizes) * (1 - TRIM)))
	return float(sizes[:keep].mean())


def scans(catalogue):
	# The joints to scan: {name prefix: (low, high, step)}, in each joint's
	# own units (radians, or metres for a slide), from the catalogue's
	# "poses": {"joints": {prefix: [low, high, step]}}; without it, the hinged
	# surfaces across TRAVEL either way of rest by STEP. A least at either end
	# is no fit, so a range runs past the travel it scans
	spec = catalogue.get("poses", {}).get("joints")
	if spec is None:
		return {prefix: (-TRAVEL, TRAVEL, STEP) for prefix in SURFACES}
	return {prefix: tuple(float(v) for v in values) for prefix, values in spec.items()}


def shown(joint, value):
	# A joint's value as printed: degrees for a turn, metres for a slide
	return f"{math.degrees(value):+6.1f} deg" if joint["motion"] == "rotate" else f"{value:+6.2f} m"


def fit(evaluate, start, needed, low=-TRAVEL, high=TRAVEL, step=STEP):
	# The value in [low, high] at which evaluate(value) -> (score, places)
	# scores least with at least `needed` places: a scan every step, then
	# halving the step twice about the best. None where no value keeps enough
	results = {}

	def look(angle):
		angle = round(float(angle), 4)
		if angle not in results:
			results[angle] = evaluate(angle)
		return results[angle]

	angles = list(np.arange(low, high + 1e-9, step)) + [start]
	for a in angles:
		look(a)
	for _ in range(2):
		good = {a: s for a, (s, n) in results.items() if n >= needed}
		if not good:
			return None
		best = min(good, key=good.get)
		step /= 2
		for a in (best - step, best + step):
			if low <= a <= high:
				look(a)
	good = {a: s for a, (s, n) in results.items() if n >= needed}
	if not good:
		return None
	best = min(good, key=good.get)
	# the least at the scan's end is no minimum: the part would go on moving
	if best <= low + 1e-6 or best >= high - 1e-6:
		return None
	return best, results[best][0], results[best][1]


def main():
	args = [a for a in sys.argv[1:] if not a.startswith("--")]
	only = sys.argv[sys.argv.index("--only") + 1].split(",") if "--only" in sys.argv else None
	if only:
		args = [a for a in args if a != ",".join(only)]
	catalogue_path, glb, points_path, cameras_path, out = args[:5]
	root = Path(catalogue_path).resolve().parent
	catalogue = json.loads(Path(catalogue_path).read_text())
	frame = mod.Frame(catalogue["frame"])
	model = mod.Model(glb)
	points_file = json.loads(Path(points_path).read_text())
	joints, hardpoints = points_file["joints"], points_file.get("points", {}).get("hardpoints", {})
	scan = scans(catalogue)

	def ranged(name):
		# the range of the first prefix the joint's name starts with, or None
		return next((scan[prefix] for prefix in scan if name.startswith(prefix)), None)

	surfaces = sorted(n for n in joints if ranged(n) and joints[n]["motion"] in MOTIONS)
	report = {}
	for entry in json.loads(Path(cameras_path).read_text()):
		photo = entry["photo"]
		if only and photo not in only:
			continue
		scene = skyline.Scene(catalogue, root, frame, hardpoints, entry)
		pose = entry.get("pose", {})
		places, _ = scene.places(model, joints, pose, parts=set(surfaces))
		counts = {n: [p["miss"] for p in places if p["part"] == n] for n in surfaces}
		fits, entry_joints = {}, dict(pose.get("joints", {}))
		lines = [f"photo {photo}:"]
		for name in surfaces:
			misses = counts[name]
			if len(misses) < PLACES:
				continue
			start = mod.setting(joints[name], name, pose)
			before = score(misses)

			def evaluate(angle, name=name):
				posed = dict(pose)
				posed["joints"] = dict(pose.get("joints", {}), **{name: angle})
				found, _ = scene.places(model, joints, posed, parts={name})
				mine = [p["miss"] for p in found if p["part"] == name]
				return (score(mine) if mine else math.inf), len(mine)

			result = fit(evaluate, start, max(PLACES, math.ceil(FLOOR * len(misses))), *ranged(name))
			if result is None:
				lines.append(f"  {name:26s} catalogue {shown(joints[name], start)}, {before:5.2f} {frame.symbol} over {len(misses):3d} places; no fit (too few places kept, or the least at the scan's end)")
				continue
			angle, after, kept = result
			fits[name] = {"catalogue": round(start, 4), "before": round(before, 2), "places": len(misses), "fitted": angle, "after": round(after, 2), "kept": kept}
			if after <= BETTER * before:
				entry_joints[name] = angle
			lines.append(f"  {name:26s} catalogue {shown(joints[name], start)}, {before:5.2f} {frame.symbol} over {len(misses):3d} places; fitted {shown(joints[name], angle)}, {after:5.2f} {frame.symbol} over {kept:3d}")
		report[photo] = {"fits": fits, "joints": entry_joints}
		print("\n".join(lines), flush=True)
	Path(out).write_text(json.dumps(report, indent="\t") + "\n")


if __name__ == "__main__":
	main()
