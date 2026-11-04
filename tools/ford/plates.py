# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# The lettering plates' frames and the lamps round their shapes, in plain
# Python so build.py (in Blender) and weather.py (in the system's Python)
# read them alike: a plate on a plane face (layout.lettering.plates), its
# middle, the viewer's right and up seen from outside, and its size; a cell
# drawn from shapes (letters.py) with `lamps` {"spacing", "offset",
# "diameter", "depth"} set round each polygon's outline and inside its holes,
# carried from the cell's frame (x to the viewer's right, y down, `size`
# metres) onto the plate.


def framed(p, centre):
	# A plane plate's frame (a plane with its ranges, facing away from
	# `centre` [x, z]): its middle, the viewer's right and up seen from
	# outside, and its size
	axis, value = p["plane"].split("=")
	value = float(value)
	(y0, y1) = p["y"]
	if axis == "z":
		(a0, a1) = p["x"]
		middle = ((a0 + a1) / 2, (y0 + y1) / 2, value)
		right = (1, 0, 0) if value > centre[1] else (-1, 0, 0)   # aft to forward seen from starboard, forward to aft from port
	else:
		(a0, a1) = p["z"]
		middle = (value, (y0 + y1) / 2, (a0 + a1) / 2)
		right = (0, 0, -1) if value > centre[0] else (0, 0, 1)   # starboard to port seen from forward, port to starboard from aft
	return {"middle": middle, "right": right, "up": (0, 1, 0), "size": (abs(a1 - a0), y1 - y0), "cell": p["cell"]}


def offset_ring(polygon, distance):
	# A closed polygon [[x, y], ...] moved out by `distance` square to each
	# edge (in by a negative one), its corners mitred
	n = len(polygon)
	signed = sum(polygon[i][0] * polygon[(i + 1) % n][1] - polygon[(i + 1) % n][0] * polygon[i][1] for i in range(n))
	sign = 1 if signed > 0 else -1
	normals = []
	for i in range(n):
		(x0, y0), (x1, y1) = polygon[i], polygon[(i + 1) % n]
		length = ((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5
		normals.append(((y1 - y0) / length * sign, -(x1 - x0) / length * sign))
	out = []
	for i in range(n):
		(ax, ay), (bx, by) = normals[i - 1], normals[i]
		k = distance / max(1 + ax * bx + ay * by, 0.2)
		out.append([polygon[i][0] + (ax + bx) * k, polygon[i][1] + (ay + by) * k])
	return out


def spaced(ring, spacing):
	# Points round a closed ring as near `spacing` apart as divides it evenly
	edges = list(zip(ring, ring[1:] + ring[:1]))
	lengths = [((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2) ** 0.5 for a, b in edges]
	total = sum(lengths)
	count = max(3, round(total / spacing))
	points, edge, start = [], 0, 0.0
	for k in range(count):
		d = k * total / count
		while d > start + lengths[edge]:
			start += lengths[edge]
			edge += 1
		(a, b), t = edges[edge], (d - start) / max(lengths[edge], 1e-9)
		points.append([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
	return points


def lamps(plate, cell, centre, thickness=0.03):
	# The lamps a cell's `lamps` sets, on the plate laid from it: each as (its
	# foot on the plate's face, the face's outward direction), ship frame
	spec = cell["lamps"]
	f = framed(plate, centre)
	width, height = cell["size"]
	(rx, ry, rz), (ux, uy, uz) = f["right"], f["up"]
	out = (ry * uz - rz * uy, rz * ux - rx * uz, rx * uy - ry * ux)   # right x up, toward the viewer outside
	feet = []
	for s in cell["shapes"]:
		if "polygon" not in s:
			continue
		rings = [offset_ring(s["polygon"], spec["offset"])] + [offset_ring(h, -spec["offset"]) for h in s.get("holes", [])]
		for ring in rings:
			for x, y in spaced(ring, spec["spacing"]):
				a, b = (x / width - 0.5) * f["size"][0], (0.5 - y / height) * f["size"][1]
				feet.append((tuple(f["middle"][i] + f["right"][i] * a + f["up"][i] * b + out[i] * thickness for i in range(3)), out))
	return feet
