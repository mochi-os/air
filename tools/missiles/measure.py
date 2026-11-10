# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# Measures a missile's shape off single photos (photos.json beside this file):
# each photo's marks of the body's outline in pairs straight across it give
# the axis and the scale, from the body's cited diameter (facts.json), and
# every other mark is then read as a station (inches aft of the nose's tip)
# and a distance off the axis. The scale is fitted along the axis, so a body
# seen at an angle, its far end smaller, still reads true stations.
#
# A fin's tip off the axis reads its full span only when the fin lies across
# the line of sight: in an X (each fin 45 deg from the vertical) a side view
# sees it at cos 45. The photo's "fins" says which, and the reading is scaled
# back. A photo seen well off the side lists in "planform" the bodies whose
# fins span square to the line of sight, read whole; the other bodies' fins
# then stay out of the medians, their spans and stations skewed by their roll.
# A photo square to the body is "level": its widths change only where the
# body's sections do (an armament section 2% wider than the guidance), not
# with depth, so the scale across is their mean, held constant. A slope
# fitted to such steps would read as perspective and skew every station
# and distance far from the pairs. A photo seen at a slant instead "pins"
# its perspective: with the nose and the tail, one more mark of known station
# (a joint ring, its front and aft points' mean) sets how the scale runs
# along the body, and the widths give only the scale across. Such a photo is
# also "oblique": a body there with nothing of known length
# along it (its tail, a launcher) is left out, as its width's scale holds only
# side-on.
#
# A part seen close up with no axis in frame (a wing's trailing corner) is
# read on its own plane instead: the photo's "plane" names the part (wings,
# canards), the part's four corners (root and tip, leading and trailing,
# from facts.json's layout) fit a projective map from the photo to the
# planform, and every mark of that part is read through it as a station and
# a distance off the axis. Marks along the part's edges check the map.
#
# usage: python3 -I measure.py [MISSILE]   (prints each mark per photo, then the medians)
import json, math, sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
FACTS = json.loads((HERE / "facts.json").read_text())
KINDS = {"AIM-9M": "aim9m", "AIM-120C": "aim120c"}
FINS = ("canard", "wing", "fin")


def kind(name):
	for prefix, key in KINDS.items():
		if name.startswith(prefix):
			return key
	return None


def pairs(marks):
	# The outline pairs: body_top_N with body_bottom_N, and the same with a
	# body suffix (_a, _b) when one photo shows several bodies
	out = {}
	for name, at in marks.items():
		if name.startswith("body_top_"):
			rest = name[len("body_top_") :]
			other = marks.get("body_bottom_" + rest)
			if other is not None:
				body = rest.split("_", 1)[1] if "_" in rest else ""
				out.setdefault(body, []).append((np.asarray(at, float), np.asarray(other, float)))
	return out


def frame(pairs_, nose):
	# The axis through the pairs' middles, pointing nose-ward; each pair's
	# distance along it from their centre (pixels) and its width across it
	middles = np.array([(a + b) / 2 for a, b in pairs_])
	centre = middles.mean(axis=0)
	_, _, vt = np.linalg.svd(middles - centre)
	direction = vt[0]
	if nose is not None and np.dot(np.asarray(nose, float) - centre, direction) < 0:
		direction = -direction
	normal = np.array([-direction[1], direction[0]])
	along = np.array([np.dot(m - centre, direction) for m in middles])
	widths = np.array([abs(np.dot(a - b, normal)) for a, b in pairs_])
	return centre, direction, normal, along, widths


def stations(u0, widths_fit, diameter, known=None):
	# Through a pinhole, a point at station s on the axis falls at pixel u
	# with s = (u - u0) / (alpha - gamma u), s counted from the point at u0:
	# a projective map, its gamma from the body's width, which runs straight
	# in u (it shrinks as the depth grows, and the depth runs as gamma s).
	# Alpha comes from two points a known distance apart along the axis
	# (known: (u_a, u_b, inches), b aft of a: the nose and the tail, or a
	# launcher's two ends beside the body); without them, from the width at
	# u0, true only for a body lying across the line of sight. Returns s(u)
	# and the scale across the axis at u (inches per pixel).
	p, q = widths_fit[1], widths_fit[0]   # width = p + q u
	ratio = -q / p                          # gamma / alpha
	if known:
		a, b, distance = known
		alpha = ((b - u0) / (1 - ratio * b) - (a - u0) / (1 - ratio * a)) / distance
	else:
		alpha = -(p + q * u0) / diameter / (1 - ratio * u0)
	gamma = ratio * alpha

	def station(u):
		return (u - u0) / (alpha - gamma * u)

	def across(u):
		return diameter / (p + q * u)

	return station, across


def measure(entry):
	# A photo's marks read as stations and distances off the axis. The
	# stations are absolute (inches aft of the nose's tip) where the photo
	# shows the nose, the tail, or a mark its "anchor" gives the station of;
	# otherwise they are relative to the first mark of its "scale".
	missile = kind(entry.get("missile", ""))
	if not missile:
		return None
	diameter = FACTS[missile]["diameter"]["value"]
	length = FACTS[missile]["length"]["value"]
	marks = entry["marks"]
	scale, anchor = entry.get("scale"), entry.get("anchor")
	found_all = pairs(marks)
	results = {}
	for body, found in found_all.items():
		suffix = f"_{body}" if body else ""

		def at(name):
			return np.asarray(marks[name + suffix], float) if name and name + suffix in marks else None

		nose = at("nose")
		tails = [at(n) for n in ("tail_top", "tail_bottom") if at(n) is not None]
		tail_px = np.mean(tails, axis=0) if tails else None
		end = at("tail")   # the aftmost point of the end's outline, placed below
		# the axis points nose-ward: by the nose, else away from the tail, else
		# from the scale's aft mark to its forward one
		toward = nose
		if toward is None and tail_px is not None:
			toward = 2 * np.mean([(a + b) / 2 for a, b in found], axis=0) - tail_px
		if toward is None and scale and at(scale["from"]) is not None and at(scale["to"]) is not None:
			toward = np.mean([(a + b) / 2 for a, b in found], axis=0) + (at(scale["from"]) - at(scale["to"])) * 1000
		if not found or (len(found) < 2 and toward is None):
			continue
		if len(found) >= 2:
			centre, direction, normal, along, widths = frame(found, toward)
		else:
			a, b = found[0]
			centre = (a + b) / 2
			direction = toward - centre
			direction /= np.linalg.norm(direction)
			normal = np.array([-direction[1], direction[0]])
			along, widths = np.array([0.0]), np.array([abs(np.dot(a - b, normal))])
		fit = np.polyfit(along, widths, 1) if len(found) >= 3 and np.ptp(along) > 0 and not entry.get("level") else np.array([0.0, widths.mean()])

		def u(px):
			return float(np.dot(px - centre, direction))

		if tail_px is None and end is not None and nose is not None:
			# The end is a disc across the axis: seen phi off the axis, its outline
			# reaches R cos phi beyond its centre, and the body's length shows at
			# sin phi against its width
			back = 0.0
			for _ in range(4):
				shown = (u(nose) - u(end) - back) / np.polyval(fit, (u(nose) + u(end)) / 2) / (length / diameter)
				back = np.polyval(fit, u(end)) / 2 * math.sqrt(max(0.0, 1 - min(1.0, shown) ** 2))
			tail_px = end + direction * back

		pin = entry.get("pin")
		pinned = [at(n) for n in pin["marks"]] if pin else []
		if pinned and all(m is not None for m in pinned) and nose is not None and tail_px is not None:
			# s = (u - u0) / (alpha - gamma u) through the nose (0), the tail
			# (length) and the pin (its station) sets gamma / alpha; the widths
			# run as (1 - ratio u), their mean setting the scale across
			u0, ut, um, sm = u(nose), u(tail_px), u(np.mean(pinned, axis=0)), pin["station"]
			a_, b_ = (ut - u0) * sm, (um - u0) * length
			ratio = (b_ - a_) / (b_ * ut - a_ * um)
			shape = 1 - ratio * along
			p_ = float(np.dot(widths, shape) / np.dot(shape, shape))
			fit = np.array([-ratio * p_, p_])
		known, scaled = None, "width"
		if nose is not None and tail_px is not None:
			known, scaled = (u(nose), u(tail_px), length), ("pin" if pinned and all(m is not None for m in pinned) else "tail")
		elif scale and at(scale["from"]) is not None and at(scale["to"]) is not None:
			known, scaled = (u(at(scale["from"])), u(at(scale["to"])), scale["length"]), "scale"
		if scaled == "width" and entry.get("oblique"):
			continue
		u0 = u(nose) if nose is not None else (u(tail_px) if tail_px is not None else (known[0] if known else 0.0))
		station, across = stations(u0, fit, diameter, known)
		if nose is not None:
			offset = 0.0
		elif tail_px is not None:
			offset = length - station(u(tail_px))
		elif anchor and at(anchor["mark"]) is not None:
			offset = anchor["station"] - station(u(at(anchor["mark"])))
		else:
			offset = None
		row = {"pairs": len(found), "width": [round(float(w), 1) for w in widths], "rolled": "planform" in entry and body not in entry["planform"],
			"straight": round(float(np.std(widths - np.polyval(fit, along))), 2), "scaled": scaled, "absolute": offset is not None}
		read = {}
		for name, px in marks.items():
			if suffix and not name.endswith(suffix):
				continue
			if not suffix and any(name.endswith(f"_{b}") for b in found_all if b):
				continue
			base = name[: -len(suffix)] if suffix else name
			d = np.asarray(px, float) - centre
			uu, v = float(np.dot(d, direction)), float(np.dot(d, normal))
			off = abs(v) * across(uu)
			if base.startswith(FINS) and "_tip" in base and entry.get("fins") == "X" and body not in entry.get("planform", []):
				off /= math.cos(math.radians(45))
			read[base] = {"station": round(float(station(uu) + (offset or 0.0)), 2), "off": round(off, 2)}
		row["marks"] = read
		if nose is not None and tail_px is not None:
			# the length from the body's width alone, against the cited one: how
			# far the view is from side-on
			s_width, _ = stations(u(nose), fit, diameter)
			row["length"] = round(float(s_width(u(tail_px))), 1)
		results[body or "-"] = row
	return {"missile": missile, "bodies": results}


CORNERS = ("root_leading", "tip_leading", "tip_trailing", "root_trailing")
EDGES = {"trailing_edge": ("root_trailing", "tip_trailing"), "tip_edge": ("tip_leading", "tip_trailing"),
	"leading_edge": ("root_leading", "tip_leading")}


def homography(source, target):
	# The projective map of a plane taking each source point to its target:
	# the direct linear transform, exact on four pairs
	if len(source) < 4:
		raise ValueError(f"a plane needs four known points, {len(source)} given")
	rows = []
	for (x, y), (u, v) in zip(source, target):
		rows.append([x, y, 1, 0, 0, 0, -u * x, -u * y, -u])
		rows.append([0, 0, 0, x, y, 1, -v * x, -v * y, -v])
	return np.linalg.svd(np.array(rows))[2][-1].reshape(3, 3)


def apply(h, point):
	x, y, w = h @ (point[0], point[1], 1)
	return np.array([x / w, y / w])


def on_plane(entry):
	# A photo's marks of one planar part read on its planform: (station, off)
	missile = kind(entry.get("missile", ""))
	part = entry["plane"]["part"]
	outline = FACTS["layout"][missile][part]["value"]["outline"]
	if len(outline) != 4:
		raise ValueError(f"{part}: a plane is fitted to a four-cornered outline")
	prefix = part[:-1] + "_"
	known = {prefix + c: outline[i] for i, c in enumerate(CORNERS)}
	marks = entry["marks"]
	used = [n for n in known if n in marks]
	h = homography([marks[n] for n in used], [known[n] for n in used])
	read = {}
	for name, px in marks.items():
		s, off = apply(h, px)
		read[name] = {"station": round(float(s), 2), "off": round(float(off), 2)}
	checks = {}
	for name in marks:
		for edge, (one, two) in EDGES.items():
			if name.startswith(prefix + edge):
				a, b, q = np.asarray(known[prefix + one], float), np.asarray(known[prefix + two], float), np.array([read[name]["station"], read[name]["off"]])
				d = b - a
				checks[name] = round(float(abs(d[0] * (q - a)[1] - d[1] * (q - a)[0]) / np.linalg.norm(d)), 2)
	return {"missile": missile, "part": part, "known": used, "marks": read, "edges": checks}


def plain(name):
	# a mark's name without the photo's near/far word, to set photos together
	return name.replace("_near", "").replace("_far", "")


def main():
	wanted = sys.argv[1] if len(sys.argv) > 1 else None
	catalogue = json.loads((HERE / "photos.json").read_text())["photos"]
	combined = {}
	for pid, entry in catalogue.items():
		if "plane" in entry:
			m = on_plane(entry)
			if wanted and m["missile"] != wanted:
				continue
			print(f"{pid} {m['missile']} on its {m['part']}' plane, fitted to {', '.join(m['known'])}; edge marks off their edge: {m['edges']}")
			for name, r in sorted(m["marks"].items(), key=lambda kv: kv[1]["station"]):
				print(f"    {name:32s} station {r['station']:8.2f}  off {r['off']:6.2f}")
			continue
		m = measure(entry)
		if not m or (wanted and m["missile"] != wanted):
			continue
		for body, row in m["bodies"].items():
			print(f"{pid} [{body}] {m['missile']}: {row['pairs']} pairs (widths off a line by {row['straight']} px), scaled by the {row['scaled']},"
				f" {'absolute' if row['absolute'] else 'relative'}; the width alone reads the length {row.get('length')}")
			for name, r in sorted(row["marks"].items(), key=lambda kv: kv[1]["station"]):
				print(f"    {name:32s} station {r['station']:8.2f}  off {r['off']:6.2f}")
				if row["absolute"] and not (row["rolled"] and name.startswith(FINS)):
					combined.setdefault((m["missile"], plain(name)), []).append((r["station"], r["off"], pid))
	print("\nmedians over the photos whose stations are absolute (station, off):")
	for (missile, name), rows in sorted(combined.items(), key=lambda kv: (kv[0][0], np.median([s for s, _, _ in kv[1]]))):
		stations_ = [s for s, _, _ in rows]
		offs = [o for _, o, _ in rows]
		print(f"  {missile} {name:28s} station {np.median(stations_):7.2f} (+-{np.std(stations_) if len(rows) > 1 else 0:4.2f})"
			f"  off {np.median(offs):6.2f} (+-{np.std(offs) if len(rows) > 1 else 0:4.2f})  n={len(rows)}")


if __name__ == "__main__":
	main()
