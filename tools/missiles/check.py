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
# A shape no source shows is asked about, never guessed: every facts.json
# text saying it is guessed (verify's GUESS words: "by eye", "estimated",
# "not measured", "unseen" and the like) is listed here with the user's
# sign-off (its path, how many guesses the text held when they signed it, the
# date and what they approved), or test_check fails; a text that gains a
# guess fails again until it is signed again
GUESSES = {
	"layout.aim9m.profile.measured": (1, "user, 2026-11-12: keep the dome's curve; no public-domain side view of an uncovered dome was found (041102-N-5345W-096 sees it head-on, DF-ST-82-10199 a training dome at 40 deg)"),
	"layout.aim9m.canards.measured": (1, "user, 2026-11-12: keep the canards 0.3 in thick; dvids7471726's near edge-on canard bounds them at 0.4 in, its view's angle off the plane unknown"),
	"layout.aim9m.rollerons.measured": (1, "user, 2026-11-12: keep the wheel 0.35 in wide (dvids7680990's blurred edge view reads 0.33-0.43), the bracket 0.12 and the tip block 0.35 thick; neither is seen in any photo found (dvids7680970 and 7680990 carry a different dark block clamped across each housing's aft face by the hinge)"),
	"layout.aim9m.nozzle.measured": (1, "user, 2026-11-12: keep the nozzle 4.0 in deep; no sharp view into a nozzle was found (shop rounds carry caps; dvids6457086 is out of focus)"),
	"layout.aim9m.finishes.measured": (1, "user, 2026-11-12: keep the bare metal's sheen; a sheen can't be read off a photo without its lighting, and the sunlit views (dvids7471726, dvids1497062) show the highlights it gives"),
	"layout.aim120c.wings.measured": (1, "user, 2026-11-12: keep the wings 0.3 in thick; dvids1497062 sees them only obliquely from aft"),
	"layout.aim120c.fittings.measured": (3, "user, 2026-11-12: keep the clip plates 0.1 in proud (dvids1497062's low-sun profile reads 0.11-0.17 with the plate's shadow), and the hooks' cross-sections and the C-hangers' jaws from dvids9245725 (dvids9687343 agrees with the jaw reaching in as far as the lip, but obliquely and soft)"),
	"layout.aim120c.finishes.measured": (1, "user, 2026-11-12: keep the bare metal's sheen, as the AIM-9M's"),
	"layout.aim9m.wings.measured": (1, "user's ruling, 2026-11-11: the tip's wedge section (measured) across the full span; no photo shows the root's"),
	"layout.aim9m.paint.measured": (1, "user, 2026-11-12: keep the AIM-120's measured paint; no photo shows an AIM-9M beside a grey of known tone"),
	"layout.aim9m.fittings.measured": (1, "user, 2026-11-12: keep the AIM-120 aft shoe's measured stem (1.6 in) and flange (2.1 in); both ride the LAU-127's rail"),
	"layout.aim120c.markings.measured": (1, "user, 2026-11-12: keep the right side's markings mirrored from the measured left (usmc090528 shows the same set there)"),
}

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
