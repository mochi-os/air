# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# The outline check (air-fa18c.md, Verification): draws the built model's top,
# side and front silhouettes at the scale of the HATP three-view's masks
# (views.py), registered on the nose apex (FS 60.5 on WL 100) and the
# centreline. For each view it reports the share of the union both cover, how
# far the two outlines part (each outline pixel's distance to the other's),
# and every place they part by more than a threshold, worst first, in
# stations, waterlines and buttlines. A single overlap share hides a local
# miss; the places do not. The HATP figure is a sketch, good to a few inches:
# a miss here is a question for the photos (verify/photos.py), not a verdict.
# With an output path it also writes the overlays: the NASA view grey, the
# model's own pixels red where the view lacks them and blue where they agree,
# and the model's outline shaded by its miss.
#
# usage: python3 -I outline.py MODEL.glb [OVERLAY.png] [--threshold INCHES]
import json, sys
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "verify"))   # run with -I, which leaves the script's own folder off the path
import model as verify  # noqa: E402

CACHE = HERE / "references"
INCH = 0.0254
ORIGIN = {"station": 456, "waterline": 105}
APEX = 60.5   # facts.json nose.apex


def triangles(path):
	# Every triangle of a glTF binary at rest, in the model's frame
	m = verify.Model(path)
	if m.rotated():
		raise SystemExit(f"{m.rotated()[0]}: rests rotated, which the contract forbids")
	return m.triangles()


def project(tris, name, v, mask):
	# The model's triangles in a view's pixels, and the view's pixel-to-place map
	station = ORIGIN["station"] - tris[..., 0] / INCH
	waterline = ORIGIN["waterline"] + tris[..., 1] / INCH
	buttline = tris[..., 2] / INCH
	per = v["scale"] / INCH   # inches per pixel
	if name == "top":
		x, y = v["apex"] + (station - APEX) / per, v["centre"] + buttline / per
		place = lambda r, c: ("FS", APEX + (c - v["apex"]) * per, "BL", (r - v["centre"]) * per)
	elif name == "side":
		row = float(np.nonzero(mask[:, v["apex"]])[0].mean())
		x, y = v["apex"] + (station - APEX) / per, row + (100 - waterline) / per
		place = lambda r, c: ("FS", APEX + (c - v["apex"]) * per, "WL", 100 + (row - r) * per)
	else:
		# The front view has no apex: its fin tips stand at cr3608's WL 213.4
		top = np.nonzero(mask.any(1))[0].min()
		x, y = v["centre"] + buttline / per, top + (213.4 - waterline) / per
		place = lambda r, c: ("BL", (c - v["centre"]) * per, "WL", 213.4 - (r - top) * per)
	return np.stack([x, y], -1), place, per


def main():
	args, threshold = list(sys.argv[1:]), 4.0
	if "--threshold" in args:
		i = args.index("--threshold")
		threshold = float(args[i + 1])
		del args[i : i + 2]
	tris = triangles(args[0])
	views = json.loads((CACHE / "views.json").read_text())["views"]
	results, panels = {}, []
	for name in ("top", "side", "front"):
		v = views[name]
		mask = np.array(Image.open(CACHE / f"{name}.png")) > 0
		flat, place, per = project(tris, name, v, mask)
		ours = verify.silhouette(flat, (mask.shape[1], mask.shape[0]))
		both, either = (ours & mask).sum(), (ours | mask).sum()
		(a, da), (b, db) = verify.outlines(ours, mask)
		da, db = da * per, db * per
		where = lambda r, c: place(r, c)[1::2]
		found = verify.regions(np.concatenate([a, b]), np.concatenate([da, db]), where, threshold, 24)
		labels = place(0, 0)[0::2]
		results[name] = {"agree": round(both / either, 3), "outline": {"median": round(float(np.median(np.abs(da))), 1),
			"90%": round(float(np.percentile(np.abs(da), 90)), 1), "max": round(float(np.abs(da).max()), 1)},
			"places": [{"miss": round(d, 1), labels[0]: round(p, 1), labels[1]: round(q, 1)} for d, p, q in found]}
		overlay = np.full(mask.shape + (3,), 255, np.uint8)
		overlay[mask] = (200, 200, 200)
		overlay[ours & ~mask] = (220, 40, 40)
		overlay[ours & mask] = (60, 90, 200)
		t = np.clip(np.abs(da) / 12.0, 0, 1)[:, None]
		overlay[a[:, 0], a[:, 1]] = (np.array([255, 0, 0]) * t + np.array([0, 150, 0]) * (1 - t)).astype(np.uint8)
		panels.append(overlay)
	print(json.dumps(results, indent="\t"))
	if len(args) > 1:
		width = sum(p.shape[1] for p in panels)
		height = max(p.shape[0] for p in panels)
		sheet = np.full((height, width, 3), 255, np.uint8)
		x = 0
		for p in panels:
			sheet[: p.shape[0], x : x + p.shape[1]] = p
			x += p.shape[1]
		Image.fromarray(sheet).save(args[1])


if __name__ == "__main__":
	main()
