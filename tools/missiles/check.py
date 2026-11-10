# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# Measures a built missile back against its facts (facts.json): its length,
# its body's diameter, the wings' span tip to tip, and where its points file
# puts the nose, the exit and the mount. Every cited size of the missile is
# measured or listed in EXEMPT with the reason, so a new fact cannot go
# unchecked. Exits non-zero on a miss past its tolerance.
#
# usage: python3 -I check.py MISSILE MODEL.glb POINTS.json
import json, math, sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "verify"))
import model as verify  # noqa: E402

FACTS = json.loads((HERE / "facts.json").read_text())
INCH = 0.0254
EXEMPT = {
	"weight": "a mass, not a shape (the flight model's)",
	"surfaces": "which surfaces it has, built from the layout",
	"gravity": "the points file's origin, checked as the gravity point",
	"sections": "the motor's and control section's lengths, not drawn apart",
	"hooks": "where the launch hooks sit is the layout's (measured)",
}


def value(entry):
	return entry["value"] if isinstance(entry, dict) and "value" in entry else entry


def measure(missile, glb, points):
	facts = FACTS[missile]
	model = verify.Model(glb)
	document = json.loads(Path(points).read_text())
	parts = model.parts(verify.pose(document["joints"], {}))
	body = parts["body"].reshape(-1, 3)
	radial = lambda p: np.hypot(p[:, 1], p[:, 2])
	out = []

	def result(name, what, expected, measured, tolerance):
		out.append({"fact": name, "what": what, "expected": round(float(expected), 3), "measured": round(float(measured), 3), "tolerance": tolerance})

	result("length", "nose to tail along the axis", value(facts["length"]), np.ptp(body[:, 0]) / INCH, 0.1)
	result("diameter", "the body's widest", value(facts["diameter"]), 2 * radial(body).max() / INCH, 0.05)
	if "span" in facts:
		fins = [n for n in parts if n.startswith("wing_")] or [n for n in parts if n.startswith("fin_")]
		# no wings built measures nothing, which fails (failed())
		reach = 2 * radial(np.concatenate([parts[n].reshape(-1, 3) for n in fins])).max() / INCH if fins else math.nan
		result("span", "the wings' tips, tip to tip", value(facts["span"]), reach, 0.3)
	p = document["points"]
	result("gravity", "the points file's gravity on the origin", 0.0, np.linalg.norm(p["gravity"]) / INCH, 0.01)
	result("nose", "the points file's nose on the body's tip", body[:, 0].max() / INCH, p["nose"][0] / INCH, 0.05)
	result("exit", "the points file's exit on the body's end", body[:, 0].min() / INCH, p["exit"][0] / INCH, 0.05)
	result("mount", "the mount on top of the body", value(facts["diameter"]) / 2, p["mount"][1] / INCH, 0.05)
	return out


def failed(r):
	# past its tolerance, or nothing measured (NaN compares false against any tolerance, and would pass)
	return not math.isfinite(r["measured"]) or abs(r["measured"] - r["expected"]) > r["tolerance"]


def unaccounted(missile, results):
	measured = {r["fact"] for r in results}
	return [k for k in FACTS[missile] if k not in measured and k not in EXEMPT]


def main():
	missile, glb, points = sys.argv[1:4]
	results = measure(missile, glb, points)
	failures = [r for r in results if failed(r)]
	for r in results:
		state = "FAIL" if r in failures else "ok"
		print(f"{state:5s} {missile}.{r['fact']:9s} {r['what']:45s} {r['expected']:9.3f} {r['measured']:9.3f} (+-{r['tolerance']}) in")
	missing = unaccounted(missile, results)
	for name in missing:
		print(f"FAIL  {missile}.{name}: neither measured nor exempt")
	print(f"{len(results)} measurements, {len(failures)} outside tolerance, {len(missing)} unaccounted")
	sys.exit(1 if failures or missing else 0)


if __name__ == "__main__":
	main()
