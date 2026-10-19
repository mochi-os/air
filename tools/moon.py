#!/usr/bin/env python3
# Copyright © 2026 Mochisoft OÜ
# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
"""Bake the moon as Midway sees it at the game's two fixed moments into
web/src/assets/moon-day.png, web/src/assets/moon-night.png and web/src/game/moon.ts.

The game's day is a real noon whose sun stood 60 degrees up due south over Midway, the
sun the merge is lit by; its night is a real midnight whose full moon stood there, the
slot the night is lit from. Each image is the near side as seen at that moment: the face
turned by the moon's axis and the sky's own rotation, the libration's view of the limb,
and the sunlight across it by Lommel-Seeliger's law, which leaves a full moon evenly
bright to its edge and darkens a crescent toward the terminator.

Source: NASA's Scientific Visualization Studio, CGI Moon Kit (2025 colour map, from the
LRO camera's Hapke-normalised WAC mosaic): https://svs.gsfc.nasa.gov/4720
  lroc_color_2k.jpg

Geometry: JPL Horizons, observer tables for the Moon (301) and the Sun (10) from geodetic
-177.3735 E, 28.2072 N, 0 km, QUANTITIES='4,10,13,14,15,17', ANG_FORMAT='DEG', airless,
interpolated to the moment. Found by a search of 1950-2100 (Meeus's low-precision theory)
and confirmed against Horizons to 0.1 degree.

Usage: moon.py <lroc_color_2k.jpg>
"""
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image

SIZE = 256
LATITUDE = 28.2072
ROOT = Path(__file__).resolve().parent.parent

# Each moment: when, the moon's apparent azimuth and elevation (degrees), its illuminated
# percentage and angular diameter (arcseconds), the sub-observer and sub-solar points
# (selenographic, east positive) and the north pole's position angle (from celestial north
# through east). The day also carries the sun's azimuth and elevation, the sun the game draws.
MOMENTS = {
    "night": dict(
        time="2018-09-25T12:04:36Z", azimuth=179.94919, elevation=59.90286, lit=99.6776, diameter=1848.825,
        observer=(355.32986, 6.32309), solar=(351.12280, 1.34609), pole=336.0186,
    ),
    "day": dict(
        time="2005-03-15T23:58:16Z", azimuth=76.63146, elevation=30.02024, lit=33.4599, diameter=1828.437,
        observer=(5.86257, -4.18386), solar=(115.29077, -0.74040), pole=350.9203,
        sun=(180.00347, 60.00278),
    ),
}

# Disc-integrated brightness: the full moon at mean distance, magnitude -12.73 against the
# sun's -26.74, dimmed with phase angle by Allen's law and with distance by its square.
FULL, SUN, MEAN = -12.73, -26.74, 384400.0


def enu(azimuth, elevation):
    """A direction from its azimuth (from north, through east) and elevation, as east, north, up."""
    a, e = math.radians(azimuth), math.radians(elevation)
    return np.array([math.cos(e) * math.sin(a), math.cos(e) * math.cos(a), math.sin(e)])


def world(v):
    """East, north, up to the engine's axes: +x east, +y up, -z north."""
    return [float(v[0]), float(v[2]), float(-v[1])]


def unit(v):
    return v / np.linalg.norm(v)


def frame(m, latitude, pole_angle, observer):
    """The image's right and up on the sky, and the moon's own axes (lon 0, lon 90 E, north)."""
    zenith = np.array([0.0, 0.0, 1.0])
    up = unit(zenith - zenith.dot(m) * m)
    right = np.cross(m, up)   # looking along m with up above: right-handed, so east lies left facing south
    celestial = np.array([0.0, math.cos(math.radians(latitude)), math.sin(math.radians(latitude))])
    north = unit(celestial - celestial.dot(m) * m)
    east = np.cross(north, m)   # east on the sky, left of north as an observer sees it
    p = math.radians(pole_angle)
    longitude, latitude_o = math.radians(observer[0]), math.radians(observer[1])
    toward = -m   # from the moon's centre to the observer, at the sub-observer point
    axis = unit(math.cos(latitude_o) * (math.cos(p) * north + math.sin(p) * east) + math.sin(latitude_o) * toward)
    level = unit(toward - toward.dot(axis) * axis)
    ahead = np.cross(axis, level)
    zero = math.cos(longitude) * level - math.sin(longitude) * ahead
    return right, up, (zero, np.cross(axis, zero), axis)


def selenographic(longitude, latitude, axes):
    zero, ninety, axis = axes
    lo, la = math.radians(longitude), math.radians(latitude)
    return math.cos(la) * (math.cos(lo) * zero + math.sin(lo) * ninety) + math.sin(la) * axis


def bake(albedo, moment):
    m = enu(moment["azimuth"], moment["elevation"])
    right, up, axes = frame(m, LATITUDE, moment["pole"], moment["observer"])
    zero, ninety, axis = axes
    sun = selenographic(*moment["solar"], axes)
    y, x = np.mgrid[0:SIZE, 0:SIZE].astype(np.float64)
    a = (x + 0.5) / SIZE * 2 - 1
    b = 1 - (y + 0.5) / SIZE * 2
    r2 = a * a + b * b
    inside = r2 < 1
    depth = np.sqrt(np.clip(1 - r2, 0, 1))
    point = a[..., None] * right + b[..., None] * up + depth[..., None] * (-m)
    lat = np.arcsin(np.clip(point @ axis, -1, 1))
    lon = np.arctan2(point @ ninety, point @ zero)
    H, W, _ = albedo.shape
    px = ((lon / (2 * math.pi) + 0.5) * W - 0.5) % W
    py = np.clip((0.5 - lat / math.pi) * H - 0.5, 0, H - 1)
    x0 = np.floor(px).astype(int) % W
    y0 = np.floor(py).astype(int)
    x1, y1 = (x0 + 1) % W, np.minimum(y0 + 1, H - 1)
    fx, fy = (px - np.floor(px))[..., None], (py - np.floor(py))[..., None]
    colour = albedo[y0, x0] * (1 - fx) * (1 - fy) + albedo[y0, x1] * fx * (1 - fy) + albedo[y1, x0] * (1 - fx) * fy + albedo[y1, x1] * fx * fy
    incidence = np.clip(point @ sun, 0, 1)
    emission = depth
    light = np.where(incidence > 0, incidence / np.maximum(incidence + emission, 1e-6), 0)
    pattern = colour * (light * inside)[..., None]
    # Absolute: the disc's light per unit of the sun's, spread over its solid angle
    phase = math.degrees(math.acos(2 * moment["lit"] / 100 - 1))   # the sun-moon-observer angle, from the illuminated fraction
    radius = math.radians(moment["diameter"] / 7200)
    distance = 1737.4 / math.sin(radius)
    magnitude = FULL + 0.026 * phase + 4e-9 * phase ** 4 + 5 * math.log10(distance / MEAN)
    total = 10 ** (-0.4 * (magnitude - SUN))
    texel = (2 * radius / SIZE) ** 2
    pattern *= total / (pattern.mean(axis=2).sum() * texel)
    peak = float(np.percentile(pattern[inside].max(axis=1), 99.9))
    image = np.clip(pattern / peak, 0, 1)
    mean = float(image[inside].mean())
    # The light's centre, in the image's right and up: where the bright limb faces
    weight = image.mean(axis=2)
    limb = [float((weight * a).sum() / weight.sum()), float((weight * b).sum() / weight.sum())]
    encoded = np.where(image <= 0.0031308, image * 12.92, 1.055 * np.power(image, 1 / 2.4) - 0.055)
    picture = Image.fromarray(np.round(encoded * 255).astype(np.uint8), "RGB")
    record = dict(time=moment["time"], direction=world(m), right=world(right), up=world(up), radius=radius,
                  scale=peak, mean=mean, lit=moment["lit"] / 100, phase=phase, limb=limb)
    if "sun" in moment:
        record["sun"] = world(enu(*moment["sun"]))
    return picture, record


def main():
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    source = np.asarray(Image.open(sys.argv[1]).convert("RGB")).astype(np.float64) / 255
    albedo = np.where(source <= 0.04045, source / 12.92, np.power((source + 0.055) / 1.055, 2.4))
    records = {}
    for name, moment in MOMENTS.items():
        picture, record = bake(albedo, moment)
        picture.save(ROOT / f"web/src/assets/moon-{name}.png", optimize=True)
        records[name] = record

    def vector(v):
        return "[" + ", ".join(f"{c:.6f}" for c in v) + "]"

    def moment(name, r, describe):
        lines = [f"// {describe}", f"export const {name.upper()}: Moment = {{",
                 f"  time: new Date('{r['time']}'),",
                 f"  direction: {vector(r['direction'])},",
                 f"  right: {vector(r['right'])},",
                 f"  up: {vector(r['up'])},",
                 f"  radius: {r['radius']:.7f},",
                 f"  scale: {r['scale']:.6e},",
                 f"  mean: {r['mean']:.5f},",
                 f"  lit: {r['lit']:.5f},",
                 f"  phase: {r['phase']:.3f},",
                 f"  limb: {vector(r['limb'])},"]
        if "sun" in r:
            lines.append(f"  sun: {vector(r['sun'])},")
        lines.append("}")
        return "\n".join(lines)

    text = f"""// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// GENERATED by tools/moon.py from NASA's CGI Moon Kit and JPL Horizons - do not edit by hand.
// The moon as Midway saw it at the game's two fixed moments, beside the images
// assets/moon-day.png and assets/moon-night.png. World axes as the engine's: +x east, +y up,
// -z north. An image's right and up are those vectors on the sky, its disc fills it edge to
// edge, and a texel of 1 stands for `scale`: the moon's radiance per unit of the sun's
// illuminance above the air (sr^-1), linear.

export const SIZE = {SIZE} // the images' width and height, texels

export interface Moment {{
  time: Date // the instant: the stars are placed for it as well
  direction: [number, number, number] // toward the moon's centre
  right: [number, number, number] // the image's +x on the sky
  up: [number, number, number] // the image's +y on the sky: toward the zenith
  radius: number // apparent, radians
  scale: number // radiance per unit sun illuminance a texel of 1 stands for, sr^-1
  mean: number // the image's mean over its disc, linear
  lit: number // illuminated fraction
  phase: number // sun-moon-observer angle, degrees
  limb: [number, number] // the light's centre in the image's right and up: where the bright limb faces
  sun?: [number, number, number] // toward the sun, by day
}}

{moment("night", records["night"], "The night: 2018-09-25, 00:15 at Midway, the full moon 60 degrees up due south, the slot the night is lit from.")}

{moment("day", records["day"], "The day: 2005-03-15, noon at Midway, the sun 60 degrees up due south and a waxing crescent 30 degrees up in the east-northeast.")}
"""
    (ROOT / "web/src/game/moon.ts").write_text(text)
    for name, r in records.items():
        print(name, {k: v for k, v in r.items() if k in ("radius", "scale", "mean", "lit", "phase", "limb")})


if __name__ == "__main__":
    main()
