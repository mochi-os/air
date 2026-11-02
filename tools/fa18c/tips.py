# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# The wing's and the stabilators' tip heights from the solved photos
# (layout.wing's anhedral, layout.stabilator's waterline). Their marked
# corners all ride on moving surfaces, so each photo's deflections are fitted
# too, unless --neutral holds them at rest (in-flight photos, the surfaces
# faired); every photo's solved camera is held (photos.py --cameras). One
# offset per surface kind, shared by every photo, moves its tips up by that
# many inches: the whole surface, or with --rotate a turn about its root, the
# shift growing from the root's buttline to the tip's. Each fit is repeated
# leaving out each photo in turn: a value that moves by more than its spread
# is not settled.
#
# usage: python3 -I tips.py CATALOGUE CAMERAS.json MODEL.glb POINTS.json FEATURES.json
#            [--photos ID,...] [--drop ID:MARK,...] [--neutral] [--rotate]
import json, sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "verify"))   # run with -I, which leaves the script's own folder off the path
import camera as cam  # noqa: E402
import model as mod  # noqa: E402
import photos as ph  # noqa: E402

FACTS = json.loads((HERE / "facts.json").read_text())
INCH = 0.0254


def kinds(facts=FACTS):
	# Each surface kind's marked corners and its span, root to tip, in BL inches
	L = facts["layout"]
	stab = L["stabilator"]["buttline"]
	value = lambda e: e["value"] if isinstance(e, dict) else e
	return {
		"wing": {"marks": ["wingtip_leading_left", "wingtip_trailing_left", "fold_trailing_left", "wingtip_leading_right", "wingtip_trailing_right", "fold_trailing_right"],
			"span": (L["wing"]["buttline"], value(facts["reference"]["span"]) * 12 / 2)},
		"stabilator": {"marks": ["stabilator_tip_leading_left", "stabilator_tip_trailing_left", "stabilator_tip_leading_right", "stabilator_tip_trailing_right"],
			"span": (stab, stab + value(facts["stabilator"]["exposed"]) * 12 / 2)},
	}


class Tips:
	def __init__(self, catalogue, cameras, model, joints, features):
		self.cameras = {c["photo"]: c for c in cameras}
		self.joints = joints
		self.features = features
		frame = mod.Frame(catalogue["frame"])
		self.up = frame.model([0, 1, 0]) - frame.model([0, 0, 0])   # one inch up, in model metres
		self.marks = {k: dict(p.get("marks", {})) for k, p in catalogue["photos"].items()}

	def drive(self, name):
		node = self.features.landmarks[name]["node"]
		return self.joints[node].get("drive") if node in self.joints else None   # none for a node only its shape keys move

	def fit(self, kind, photos=None, drop=(), neutral=False, rotate=False, leave=None):
		# The offset in inches, the fitted deflections {(photo, drive): radians},
		# and each mark's miss: [(photo, mark, pixels, inches)]; None without marks
		marks, (root, tip) = kind["marks"], kind["span"]
		rows = [(p, n) for p, m in self.marks.items() if p in self.cameras and p != leave and (photos is None or p in photos)
			for n in marks if n in m and n in self.features.landmarks and (p, n) not in drop]
		if not rows:
			return None
		free = [] if neutral else sorted({(p, self.drive(n)) for p, n in rows if self.drive(n)})
		index = {key: 1 + i for i, key in enumerate(free)}

		def place(photo, name, x):
			drives = dict(self.cameras[photo].get("pose", {}))
			for (p, d), i in index.items():
				if p == photo:
					drives[d] = x[i]
			base = self.features.landmark(name, drives)
			share = (abs(float(base[2])) / INCH - root) / (tip - root) if rotate else 1.0
			return base + self.up * x[0] * share

		def project(photo, point):
			c = self.cameras[photo]
			return cam.project(np.array(c["camera"]), point[None], np.array(c["size"], float) / 2)

		def residual(x):
			return np.concatenate([project(p, place(p, n, x))[0][0] - np.array(self.marks[p][n], float) for p, n in rows])

		x, error = cam.levenberg(residual, np.zeros(1 + len(free)), list(range(1 + len(free))), iterations=200)
		misses = []
		for k, (p, n) in enumerate(rows):
			pixels = float(np.linalg.norm(error[2 * k: 2 * k + 2]))
			depth = project(p, place(p, n, x))[1][0]
			misses.append((p, n, pixels, pixels * depth / self.cameras[p]["camera"][0] / INCH))
		return float(x[0]), {key: float(x[i]) for key, i in index.items()}, misses


def main():
	args, options = sys.argv[1:6], sys.argv[6:]
	value = lambda name: options[options.index(name) + 1] if name in options else None
	neutral, rotate = "--neutral" in options, "--rotate" in options
	catalogue = json.loads(Path(args[0]).read_text())
	model = mod.Model(args[2])
	joints = json.loads(Path(args[3]).read_text())["joints"]
	tips = Tips(catalogue, json.loads(Path(args[1]).read_text()), model, joints, ph.Features(model, joints, args[4]))
	photos = set(value("--photos").split(",")) if value("--photos") else None
	drop = {tuple(d.split(":")) for d in value("--drop").split(",")} if value("--drop") else set()
	for name, kind in kinds().items():
		result = tips.fit(kind, photos, drop, neutral, rotate)
		if result is None:
			print(f"{name}: no marks")
			continue
		offset, deflections, misses = result
		used = sorted({m[0] for m in misses})
		print(f"{name}: tips {offset:+.2f} in over {len(used)} photos, {len(misses)} marks")
		for (p, d), angle in deflections.items():
			print(f"   {p} {d}: {np.degrees(angle):+.1f} deg")
		for p, n, pixels, inches in misses:
			print(f"   miss {p} {n}: {pixels:.1f} px, {inches:.2f} in")
		if len(used) > 1:
			spread = [tips.fit(kind, photos, drop, neutral, rotate, leave)[0] for leave in used]
			print(f"   leaving each photo out: {min(spread):+.2f} to {max(spread):+.2f} in")


if __name__ == "__main__":
	main()
