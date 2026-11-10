# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# The stores' paint (claude/plans/air-fa18c.md #9; layout.stores.paint),
# texel by texel in plain numpy, as the missiles' paint is: the airframe's
# lower grey under the baked shading, each part a shade of its own, the
# mottle and grain the missiles' paint is calibrated to (good but not perfect
# condition), and the joints and filler cap the photos show, with grime along
# the joints. build.py bakes what it reads and saves what it returns.
import importlib.util
import math
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("missile_paint", HERE.parent / "missiles" / "paint.py")
missile = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(missile)
INCH = 0.0254


def along(where, frame):
	# A texel's place on its part: inches aft of the part's nose along its
	# axis, its turn about the axis in degrees from the part's up toward its
	# right, and its distance from the axis in inches (frame: nose, axis and
	# up as unit vectors, Blender's axes: x forward, y left, z up)
	d = where - np.asarray(frame["nose"])
	axis, up = np.asarray(frame["axis"], float), np.asarray(frame["up"], float)
	right = np.cross(up, axis)
	station = d @ axis / INCH
	across = d - np.outer(d @ axis, axis).reshape(d.shape)
	turn = np.degrees(np.arctan2(across @ right, across @ up))
	return station, turn, np.linalg.norm(across, axis=-1) / INCH


def colour(layout, grey, occlusion, where, part, frames, size):
	# The stores' atlas, sRGB 0..1. grey: the paint's sRGB colour (3);
	# occlusion: ambient occlusion 0..1; where: each texel's place (metres,
	# Blender's axes); part: the index of the part it lies on in frames, from
	# 1 (0: no part); frames: per part its kind ("tank", "pylon", ...) and
	# axis frame (along); size: each texel's width (inches)
	wear = layout.get("wear", {})
	inches = where / INCH
	shading = 0.4 + 0.6 * occlusion[..., None]
	out = np.asarray(grey, float) * shading
	tone = 1 + wear.get("parts", 0.04) * missile.shade(part)
	# each scale of the noise as strong as the missiles' calibration where the
	# atlas resolves it, fading out as its features shrink to a texel (the
	# grain's 0.15 in, under the stores' half-inch texels, would only speckle)
	resolved = lambda scale: np.clip(scale / size - 1, 0, 1)
	mottle = (resolved(1.5) * (missile.noise(inches, 1.5, 11) - 0.5) + 0.5 * resolved(0.6) * (missile.noise(inches, 0.6, 17) - 0.5)) / (missile.SPREAD * math.sqrt(1.25))
	grain = resolved(0.15) * (missile.noise(inches, 0.15, 18) - 0.5) / missile.SPREAD
	out = out * (tone * (1 + wear.get("mottle", 0.03) * mottle + wear.get("grain", 0.012) * grain))[..., None]
	# what the photos show on each kind of part (layout.<kind>): its joint
	# rings, darker than the paint with grime beside them, and a tank's
	# filler cap, a coloured lid in a ring
	line = layout.get("line", {"width": 0.06, "depth": 0.45})
	ink = np.zeros(part.shape)
	grime = np.zeros(part.shape)
	for index, frame in enumerate(frames, start=1):
		mine = part == index
		spec = layout.get(frame["kind"], {})
		if not mine.any() or not spec:
			continue
		station, turn, radius = along(where[mine], frame)
		lines = np.zeros(station.shape)
		near = np.zeros(station.shape)
		for joint in spec.get("joints", []):
			lines = np.maximum(lines, missile.band(station - joint, line["width"], size[mine]))
			near = np.maximum(near, np.clip(1 - np.abs(station - joint) / 0.8, 0, 1))
		cap = spec.get("cap")
		if cap:
			# the distance on the skin from the cap's middle, along the axis
			# and round it: the lid in its colour, a ring round it
			d = np.hypot(station - cap["station"], np.radians((turn - cap["turn"] + 180) % 360 - 180) * radius)
			lid = np.clip((cap["diameter"] / 2 - d) / size[mine] + 0.5, 0, 1)
			lines = np.maximum(lines, missile.band(d - cap["ring"] / 2, line["width"], size[mine]))
			out[mine] = out[mine] + (np.asarray(cap["colour"]) / 255 * shading[mine] - out[mine]) * lid[..., None]
		ink[mine] = lines
		grime[mine] = near * wear.get("grime", 0.08) * (0.5 + missile.noise(inches[mine], 0.6, 19))
	out = out * np.clip(1 - grime, 0.6, 1.2)[..., None]
	out = out * (1 - line["depth"] * ink)[..., None]
	return np.clip(out, 0, 1)
