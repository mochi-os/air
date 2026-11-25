# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# Lays lines sketched by hand on charts.py's sheets onto the lines the photos
# show. A sketch read off a sheet by eye is a few pixels out; each point of it,
# a pixel apart, moves across the sketch to the strongest valley within
# REACH pixels (the sharpest photo's, charts.py's valleys.png), the moves
# smoothed along the line so it does not hop to a neighbour, and the result is
# given the skin's place at rest (the chart's place.npy), in source
# coordinates. Where no valley is near, the sketch stands as drawn, and the
# share of the line that found one is reported with it.
#
# usage: python3 -I snap.py RECTIFIED LINES SKETCH.json OUT.json
#
# SKETCH.json: {"lines": [{"sheet": "right_01_02", "points": [[x, y], ...],
# "note": "..."}], "drop": {"right": [id, ...]}}, points in the sheet's own
# pixels (a sheet named chart_row_column is the chart's tile at row, column,
# TILE pixels each), or with "chart": "right" in place of "sheet", in the
# whole chart's (mosaic.png's) pixels; writes OUT.json: {"lines": [{"chart", "sheet", "points":
# [[source coordinates]], "length", "snapped", "note"}], "drop": ...}.
import json, math, sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import curate  # noqa: E402

TILE = (960, 720)   # a sheet's size in chart pixels (charts.py and curate.py sheets)
REACH = 5           # pixels a sketch may be off its line
WEAK = 0.012        # the least valley a point may move to (charts.py WEAK)
SMOOTH = 9          # points: the moves are the median of this many along the line
SCALE = 0.15        # valleys.png's strength at full white (charts.py)
JUMP = 2.0          # inches: neighbouring points of a line (a pixel apart) further apart than this on the skin, a line run off one surface onto another, end it there (where the skin curves away from the chart a pixel spans half an inch or more, so not less)


def where(sheet):
	# a sheet's chart and its tile's corner in chart pixels
	chart, row, column = sheet.rsplit("_", 2)
	return chart, (int(column) * TILE[0], int(row) * TILE[1])


def origin(line):
	# a sketched line's chart and the corner its points count from: a sheet's
	# tile, or with "chart" the whole chart (mosaic.png's own pixels)
	if "sheet" in line:
		return where(line["sheet"])
	return line["chart"], (0, 0)


def snapped(points, strength, reach=REACH, weak=WEAK, smooth=SMOOTH):
	# The sketch (N, 2 chart pixels) a pixel apart, each point moved across
	# the line to the strongest valley within `reach`: (M, 2) and whether
	# each point found one
	p = curate.dense(points, 1.0)
	if len(p) < 2:
		return p, np.zeros(len(p), bool)
	d = np.gradient(p, axis=0)
	d /= np.maximum(np.linalg.norm(d, axis=1, keepdims=True), 1e-9)
	across = np.stack([-d[:, 1], d[:, 0]], 1)
	h, w = strength.shape
	offsets = np.arange(-reach, reach + 1)
	best = np.zeros(len(p))
	found = np.zeros(len(p), bool)
	for i, (q, n) in enumerate(zip(p, across)):
		xs = np.clip(np.round(q[0] + offsets * n[0]).astype(int), 0, w - 1)
		ys = np.clip(np.round(q[1] + offsets * n[1]).astype(int), 0, h - 1)
		s = strength[ys, xs]
		k = int(np.argmax(s))
		if s[k] >= weak:
			best[i], found[i] = offsets[k], True
	# a point with no valley near takes its neighbours' move; then the
	# moves are smoothed so a point does not jump to a line beside it
	if found.any():
		best = np.interp(np.arange(len(p)), np.flatnonzero(found), best[found])
		half = smooth // 2
		padded = np.pad(best, half, mode="edge")
		best = np.array([np.median(padded[i:i + smooth]) for i in range(len(p))])
	return p + across * best[:, None], found


def main():
	rectified, lines, sketch_path, out = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]), Path(sys.argv[4])
	sketch = json.loads(sketch_path.read_text())
	cache = {}
	result = []
	for line in sketch["lines"]:
		chart, (x0, y0) = origin(line)
		if chart not in cache:
			strength = np.asarray(Image.open(lines / chart / "valleys.png"), float) / 255 * SCALE
			cache[chart] = (strength, np.load(rectified / chart / "place.npy").astype(np.float64))
		strength, place = cache[chart]
		points = np.array(line["points"], float) + [x0, y0]
		p, found = snapped(points, strength)
		h, w = place.shape[:2]
		at = place[np.clip(np.round(p[:, 1]).astype(int), 0, h - 1), np.clip(np.round(p[:, 0]).astype(int), 0, w - 1)]
		ok = np.isfinite(at).all(1)
		for a, b in curate.pieces(np.nan_to_num(at), ok, JUMP):
			if b - a < 2:
				continue
			q = at[a:b]
			result.append({"chart": chart, "sheet": line.get("sheet", chart), "points": np.round(curate.simplified(q, curate.TOLERANCE), 2).tolist(),
				"length": round(float(np.linalg.norm(np.diff(q, axis=0), axis=1).sum()), 1), "snapped": round(float(found[a:b].mean()), 2), "note": line.get("note", "")})
	out.write_text(json.dumps({"lines": result, "drop": sketch.get("drop", {})}))
	weak = [r for r in result if r["snapped"] < 0.5]
	print(f"{len(result)} lines ({sum(r['length'] for r in result):.0f} in) from {len(sketch['lines'])} sketches; {len(weak)} found a valley along under half their length")


if __name__ == "__main__":
	main()
