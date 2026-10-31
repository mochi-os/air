#!/usr/bin/env python3
# Copyright © 2026 Mochisoft OÜ
# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
"""Bake the low quality global map into web/public/maps/world/: the earth's land as
NASA's Blue Marble shows it, flat at sea level, for the simulator beyond Midway and for
the map out to the whole globe (#162).

The grid is latitude and longitude with its pixel sized in metres of equatorial arc, so
every layer sits on one power-of-two ladder (2,048 m here; 32 m, 16 m and 1 m overlays
later): a level's pixel spans METRES / EQUATOR radians of longitude and of latitude,
pixel (0, 0) starts at 180 W, 90 N, and the last column runs a fraction of a pixel past
the antimeridian, the last row past the south pole. Two levels are baked:
  fine/<row>-<column>.webp       2,048 m colour, 1,024 pixel tiles, only those touching land
  fine/<row>-<column>-land.png   and the share of each pixel that is land
  global.webp, global-land.png   8,192 m, the whole earth in one image, for the globe
  land.bin                       the land outline as rows of sea/land toggles, which the
                                 flight core reads (copied into the world server's maps too)
The land share comes from Natural Earth's 1:50m outline drawn at four times the
resolution: the simulator draws land where it passes one half, and the sea everywhere
else. It is its own greyscale image, not the colour's alpha, because the browser
composites the tiles on a canvas, which keeps colour multiplied by alpha and would
blacken every pixel under the sea. Colour under the sea is carried in from the coast, so
filtering never pulls the ocean's blue onto the shore.

Sources:
  NASA Earth Observatory, Blue Marble: Next Generation, July 2004 (world.200407,
  3x21600x10800), free to reuse with credit to NASA Earth Observatory:
  https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/bmng-base/july/world.200407.3x21600x10800.jpg
  Natural Earth 1:50m land (public domain):
  https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_land.geojson

Usage: world.py <world.200407.3x21600x10800.jpg> <ne_50m_land.geojson>
"""
import hashlib
import json
import math
import struct
import sys
from pathlib import Path

import numpy as np
from PIL import Image

EQUATOR = 6378137.0   # WGS84 semi-major axis, m
FINE = 2048           # metres of equatorial arc in one fine pixel
GLOBAL = 8192         # and in one global pixel
TILE = 1024           # fine tile, pixels
SUPER = 4             # the land outline is drawn at this many times the fine resolution
QUALITY = 80          # WebP quality for the colour; the land share is lossless PNG
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "web/public/maps/world"
SERVER = ROOT.parent.parent / "world/games/air/maps"   # the world server embeds the same land file


def size(metres):
    """The grid's width and height in pixels for a pixel of so many metres of arc."""
    step = metres / EQUATOR
    return math.ceil(2 * math.pi / step), math.ceil(math.pi / step)


def centre(metres, column, row):
    """The longitude and latitude, degrees, of a pixel's centre."""
    step = math.degrees(metres / EQUATOR)
    return -180 + (column + 0.5) * step, 90 - (row + 0.5) * step


def place(metres, longitude, latitude):
    """Where a longitude and latitude, degrees, fall on the grid, in pixels (continuous)."""
    step = math.degrees(metres / EQUATOR)
    return (longitude + 180) / step, (90 - latitude) / step


def resample(source, metres, top, rows):
    """Rows top..top+rows of the grid at so many metres, sampled bilinearly from an
    equirectangular source covering 180 W to 180 E and 90 N to 90 S, wrapping east-west."""
    height, width = source.shape[:2]
    step = math.degrees(metres / EQUATOR)
    columns = size(metres)[0]
    x = ((np.arange(columns) + 0.5) * step) * (width / 360) - 0.5
    y = ((np.arange(top, top + rows) + 0.5) * step) * (height / 180) - 0.5
    x0 = np.floor(x).astype(np.int64)
    fx = (x - x0)[None, :, None]
    y = np.clip(y, 0, height - 1)
    y0 = np.minimum(np.floor(y).astype(np.int64), height - 2)
    fy = (y - y0)[:, None, None]
    xa, xb = x0 % width, (x0 + 1) % width
    out = np.empty((rows, columns, source.shape[2]), np.float32)
    a = source[y0][:, xa].astype(np.float32)
    b = source[y0][:, xb].astype(np.float32)
    c = source[y0 + 1][:, xa].astype(np.float32)
    d = source[y0 + 1][:, xb].astype(np.float32)
    out[:] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy
    return out


def rings(path):
    """Natural Earth's land as polygons of (longitude, latitude) rings: each an outline
    and its holes."""
    data = json.load(open(path))
    polygons = []
    for feature in data["features"]:
        geometry = feature["geometry"]
        for polygon in [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]:
            polygons.append([[(float(x), float(y)) for x, y in ring] for ring in polygon])
    return polygons


def scan(polygons, metres, left, top, columns, rows):
    """The land along each sample row of a window of the grid, SUPER rows to a pixel:
    for each row, the spans [start, end) it lies inside a ring by the even-odd rule (so a
    hole is a hole), in sample columns from the window's west edge, unclipped. A ring is
    scanned a turn east and west too, so the window past the antimeridian sees the land
    there; whole rings are kept or dropped, so every row crosses each one an even number
    of times."""
    step = math.degrees(metres / EQUATOR)
    height = rows * SUPER
    west, east = -180 + left * step, -180 + (left + columns) * step
    north, south = 90 - top * step, 90 - (top + rows) * step
    edges = []
    for polygon in polygons:
        for ring in polygon:
            points = np.asarray(ring, np.float64)
            if points[0, 0] != points[-1, 0] or points[0, 1] != points[-1, 1]:
                points = np.vstack([points, points[:1]])
            xs, ys = points[:, 0], points[:, 1]
            if ys.max() < south or ys.min() > north:
                continue
            for shift in (-360, 0, 360):
                if xs.max() + shift < west or xs.min() + shift > east:
                    continue
                x = ((xs + shift + 180) / step - left) * SUPER
                y = ((90 - ys) / step - top) * SUPER
                edges.append(np.stack([x[:-1], y[:-1], x[1:], y[1:]], 1))
    spans = [np.zeros((0, 2)) for _ in range(height)]
    if not edges:
        return spans
    e = np.concatenate(edges)
    e = e[e[:, 1] != e[:, 3]]   # level edges cross no row
    low, high = np.minimum(e[:, 1], e[:, 3]), np.maximum(e[:, 1], e[:, 3])
    keep = (high > 0) & (low < height)
    e, low, high = e[keep], low[keep], high[keep]
    slope = (e[:, 2] - e[:, 0]) / (e[:, 3] - e[:, 1])
    for row in range(height):
        centre = row + 0.5
        on = (low <= centre) & (centre < high)
        if on.any():
            crossings = np.sort(e[on, 0] + (centre - e[on, 1]) * slope[on])
            spans[row] = np.stack([crossings[0::2], crossings[1::2]], 1)
    return spans


def fill(spans, columns, rows):
    """The share of each pixel that is land, 0 to 255, from scan()'s spans: a sample is
    land when its centre lies in a span, and SUPER by SUPER samples make a pixel."""
    width = columns * SUPER
    image = np.zeros((rows * SUPER, width), np.uint8)
    for row, span in enumerate(spans):
        if not len(span):
            continue
        start = np.clip(np.ceil(span[:, 0] - 0.5), 0, width).astype(np.int64)
        end = np.clip(np.ceil(span[:, 1] - 0.5), 0, width).astype(np.int64)
        change = np.zeros(width + 1, np.int32)
        np.add.at(change, start, 1)
        np.add.at(change, end, -1)
        image[row] = np.cumsum(change)[:width] > 0
    count = image.reshape(rows, SUPER, columns, SUPER).sum(axis=(1, 3), dtype=np.uint16)
    return np.rint(count * (255 / (SUPER * SUPER))).astype(np.uint8)


def land(polygons, metres, left, top, columns, rows):
    """The share of each pixel of a window of the grid that is land, 0 to 255."""
    return fill(scan(polygons, metres, left, top, columns, rows), columns, rows)


# The land file every host reads to tell land from sea (land.bin): the scan's rows, one
# every ROW metres of arc from 90 N, each the longitudes where it passes between sea and
# land, in UNIT metres of equatorial arc east of 180 W. A place is land when an odd number
# of a row's toggles lie at or west of it. Header: b"LAND", then little-endian u8 version,
# u16 ROW, u16 UNIT, u32 rows, u32 units around the earth; each row is an unsigned LEB128
# count followed by that many LEB128 gaps (the first from 0).
ROW = FINE // SUPER   # 512 m: the scan's own rows, so the file and the textures share them
UNIT = 64


def toggles(span, metres, limit):
    """A row's spans, in sample columns from 180 W at so many metres a sample, as the
    sorted UNIT positions where it changes between sea and land: clipped to the earth's
    width in units and merged where they meet or overlap."""
    scale = metres / SUPER / UNIT
    merged = []
    for start, end in sorted(span.tolist()):
        a, b = max(0, round(start * scale)), min(limit, round(end * scale))
        if b <= a:
            continue
        if merged and a <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    return [x for pair in merged for x in pair]


def varint(value):
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        out.append(byte | (0x80 if value else 0))
        if not value:
            return bytes(out)


def encode(rows, units):
    """land.bin from each row's toggles."""
    out = bytearray(b"LAND")
    out += struct.pack("<BHHII", 1, ROW, UNIT, len(rows), units)
    for row in rows:
        out += varint(len(row))
        last = 0
        for x in row:
            out += varint(x - last)
            last = x
    return bytes(out)


def landed(data, latitude, longitude):
    """Whether a place, degrees, is land by land.bin: the hosts' rule, for the tests."""
    version, row_metres, unit_metres, count, units = struct.unpack_from("<BHHII", data, 4)
    position = 4 + struct.calcsize("<BHHII")
    rows = []
    for _ in range(count):
        values = []
        n, position = unvarint(data, position)
        last = 0
        for _ in range(n):
            gap, position = unvarint(data, position)
            last += gap
            values.append(last)
        rows.append(values)
    row = min(count - 1, max(0, int(math.radians(90 - latitude) * EQUATOR / row_metres)))
    unit = int(math.radians((longitude + 180) % 360) * EQUATOR / unit_metres)
    return sum(1 for x in rows[row] if x <= unit) % 2 == 1


def unvarint(data, position):
    value, shift = 0, 0
    while True:
        byte = data[position]
        position += 1
        value |= (byte & 0x7F) << shift
        shift += 7
        if not byte & 0x80:
            return value, position


def spread(colour, share, passes=6):
    """Carries the land's colour out over the sea, a pixel a pass, so the colour beside
    the coast is the coast's own: a pixel with no land takes the mean of its neighbours
    that already have a colour."""
    colour = colour.astype(np.float32).copy()
    known = share > 0
    rows, columns = share.shape
    for _ in range(passes):
        weighted = np.pad(colour * known[..., None], ((1, 1), (1, 1), (0, 0)))
        weight = np.pad(known.astype(np.float32), 1)
        total = np.zeros_like(colour)
        count = np.zeros(share.shape, np.float32)
        for dy in (0, 1, 2):
            for dx in (0, 1, 2):
                if dx == 1 and dy == 1:
                    continue
                total += weighted[dy:dy + rows, dx:dx + columns]
                count += weight[dy:dy + rows, dx:dx + columns]
        fill = (~known) & (count > 0)
        colour[fill] = total[fill] / count[fill][:, None]
        known = known | fill
    return colour


def save(colour, share, stem):
    """Writes a tile's colour (<stem>.webp) and land share (<stem>-land.png); returns
    their bytes."""
    image = stem.with_name(stem.name + ".webp")
    land = stem.with_name(stem.name + "-land.png")
    Image.fromarray(colour, "RGB").save(image, format="WEBP", quality=QUALITY, method=6)
    Image.fromarray(share, "L").save(land, format="PNG", optimize=True)
    return image.stat().st_size + land.stat().st_size


def main(image_path, land_path):
    Image.MAX_IMAGE_PIXELS = None
    source = np.asarray(Image.open(image_path).convert("RGB"))
    polygons = rings(land_path)
    width, height = size(FINE)
    columns, rows = math.ceil(width / TILE), math.ceil(height / TILE)
    ratio = GLOBAL // FINE
    globe = np.zeros((height // ratio, width // ratio, 4), np.float32)
    (OUT / "fine").mkdir(parents=True, exist_ok=True)
    for old in [*(OUT / "fine").glob("*.webp"), *(OUT / "fine").glob("*.png")]:
        old.unlink()
    tiles, total, runs = [], 0, []
    units = math.ceil(2 * math.pi * EQUATOR / UNIT)
    for row in range(rows):
        top = row * TILE
        band = min(TILE, height - top)
        colour = resample(source, FINE, top, band)
        spans = scan(polygons, FINE, 0, top, width, band)
        share = fill(spans, width, band)
        runs += [toggles(span, FINE, units) for span in spans]
        globe[top // ratio:(top + band) // ratio] = np.concatenate([colour, share[..., None]], 2).reshape(band // ratio, ratio, width // ratio, ratio, 4).mean(axis=(1, 3))
        for column in range(columns):
            left = column * TILE
            across = min(TILE, width - left)
            part = share[:, left:left + across]
            if not part.any():
                continue
            tile = np.zeros((TILE, TILE, 3), np.uint8)
            tile[:band, :across] = np.clip(np.rint(spread(colour[:, left:left + across], part)), 0, 255)
            mask = np.zeros((TILE, TILE), np.uint8)
            mask[:band, :across] = part
            total += save(tile, mask, OUT / "fine" / f"{row}-{column}")
            tiles.append([row, column])
        print(f"row {row + 1}/{rows}: {len(tiles)} tiles, {total / 1e6:.1f} MB", flush=True)
    share = np.rint(globe[..., 3]).astype(np.uint8)
    colour = spread(globe[..., :3], share)
    whole = save(np.clip(np.rint(colour), 0, 255).astype(np.uint8), share, OUT / "global")
    data = encode(runs, units)
    for place in (OUT, SERVER):
        (place / "land.bin").write_bytes(data)
    manifest = {
        "equator": EQUATOR,
        "fine": {"metres": FINE, "width": width, "height": height, "tile": TILE, "tiles": tiles},
        "global": {"metres": GLOBAL, "width": width // ratio, "height": height // ratio},
        "land": {"row": ROW, "unit": UNIT, "rows": len(runs), "units": units, "sha256": hashlib.sha256(data).hexdigest()},
    }
    (OUT / "world.json").write_text(json.dumps(manifest, separators=(",", ":")) + "\n")
    print(f"{len(tiles)} fine tiles, {total / 1e6:.1f} MB; global {whole / 1e6:.1f} MB; land {len(data) / 1e6:.2f} MB")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
