#!/usr/bin/env python3
# Copyright © 2026 Mochisoft OÜ
# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
"""Bake the air's aerosol into the client (web/src/game/aerosol.ts): the aerosol optical depth at
550 nm for each calendar month, averaged over YEARS, every SPACING degrees of latitude and longitude.
The sky (atmosphere.ts) takes the depth over the place flown in the month of the
game's moment.

Source: NASA's Global Modeling and Assimilation Office, the MERRA-2 reanalysis's total aerosol
extinction optical thickness at 550 nm, as NASA's Global Imagery Browse Services serves it: one
image a month whose colours stand for bins 0.005 wide (the layer's colour map), read back to each
bin's middle. A reanalysis assimilates the satellites' and ground stations' measurements, so the
field has no gaps over land, under clouds or in the polar night. NASA data, free of copyright.
  https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi (layer LAYER below)
  https://gibs.earthdata.nasa.gov/colormaps/v1.3/<LAYER>.xml

Usage: aerosol.py <directory>   (the images and the colour map are fetched into it when absent)
"""
import base64
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # apps/air
TS = ROOT / "web/src/game/aerosol.ts"
LAYER = "MERRA2_Total_Aerosol_Optical_Thickness_550nm_Extinction_Monthly"
YEARS = range(2015, 2025)
WIDTH, HEIGHT = 360, 180  # the images: one pixel a whole degree, rows from 90 N, columns from 180 W
# The table: 90 N to 90 S and 180 W to 180 E every SPACING degrees. Ten keeps the haze's regions and
# seasons, the Sahara's dust and the clean South Pacific, in a twenty-third of the bytes a 2 degree
# table took: a jet 10 km off at 500 ft keeps within 1.3 points of the contrast the finer table gave
# it over half the world's area, and within 13 over all but 1% of it, the edges of the dust and
# smoke plumes.
SPACING = 10
ROWS, COLUMNS, MONTHS = 180 // SPACING + 1, 360 // SPACING + 1, 12
STEP = 0.004  # depth a byte's unit stands for: 255 is 1.02, past any month's mean but a dust source's
TOP = 0.95  # the open top bin, 0.9 and more, read as its likely middle


def address(year, month):
    return ("https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap"
            f"&VERSION=1.3.0&LAYERS={LAYER}&CRS=EPSG:4326&BBOX=-90,-180,90,180&WIDTH={WIDTH}"
            f"&HEIGHT={HEIGHT}&FORMAT=image/png&TIME={year}-{month:02d}-01&STYLES=")


def fetch(directory):
    """Fetch the colour map and every month's image that the directory lacks."""
    directory.mkdir(parents=True, exist_ok=True)
    wanted = [(directory / "colours.xml", f"https://gibs.earthdata.nasa.gov/colormaps/v1.3/{LAYER}.xml")]
    wanted += [(image(directory, y, m), address(y, m)) for y in YEARS for m in range(1, 13)]
    for path, url in wanted:
        if path.exists() and path.stat().st_size:
            continue
        with urllib.request.urlopen(url, timeout=60) as response:
            body = response.read()
        if path.suffix == ".png" and not body.startswith(b"\x89PNG"):
            raise ValueError(f"{url} answered something other than an image")
        path.write_bytes(body)


def image(directory, year, month):
    return directory / f"{year}-{month:02d}.png"


def colours(text):
    """The colour map: each bin's colour to the depth at its middle. The open bottom bin is 0, the
    open top bin TOP, and the transparent no-data entry is left out."""
    table = {}
    for m in re.finditer(r'<ColorMapEntry rgb="(\d+),(\d+),(\d+)"[^>]*?\svalue="\[([^,]+),([^)]+)\)"', text):
        low, high = m.group(4), m.group(5)
        if low == "-INF":
            depth = 0.0
        elif high == "+INF":
            depth = TOP
        else:
            depth = (float(low) + float(high)) / 2
        table[(int(m.group(1)), int(m.group(2)), int(m.group(3)))] = depth
    if not table:
        raise ValueError("the colour map holds no bins")
    return table


def read(path, table):
    """One month's image as depths, rows from 90 N. Every pixel must be one of the map's colours:
    an image the server blended or scaled would not be, and is refused rather than misread."""
    from PIL import Image
    with Image.open(path) as picture:
        if picture.size != (WIDTH, HEIGHT):
            raise ValueError(f"{path} is {picture.size}, expected {(WIDTH, HEIGHT)}")
        pixels = picture.convert("RGBA").load()
        grid = []
        for y in range(HEIGHT):
            row = []
            for x in range(WIDTH):
                r, g, b, a = pixels[x, y]
                if a == 0 or (r, g, b) not in table:
                    raise ValueError(f"{path} has a pixel at {x},{y} that is no bin of the colour map: {(r, g, b, a)}")
                row.append(table[(r, g, b)])
            grid.append(row)
    return grid


def mean(grids):
    """The cell-by-cell mean of grids of one shape."""
    count = len(grids)
    return [[sum(g[y][x] for g in grids) / count for x in range(len(grids[0][0]))] for y in range(len(grids[0]))]


def nodes(grid):
    """The table's nodes from a month's whole-degree cells: each node the mean of the cells whose
    centres lie within half a SPACING of it, its longitudes across 180 W wrapping (and the last
    column repeating the first), its rows at the poles taking the half a SPACING of cells beside
    them."""
    half = SPACING // 2
    table = []
    for i in range(ROWS):
        latitude = 90 - SPACING * i
        rows = [90 - latitude - f for f in range(1 - half, half + 1) if 0 <= 90 - latitude - f < HEIGHT]
        row = []
        for j in range(COLUMNS):
            longitude = -180 + SPACING * j
            columns = [(longitude + 180 + d) % WIDTH for d in range(-half, half)]
            cells = [grid[k][c] for k in rows for c in columns]
            row.append(sum(cells) / len(cells))
        table.append(row)
    return table


def pack(months):
    """The months' nodes as bytes, month by month, row by row: each node's depth in STEPs."""
    return bytes(max(0, min(255, round(v / STEP))) for month in months for row in month for v in row)


def ts(data):
    encoded = base64.b64encode(data).decode()
    return (
        "// Copyright © 2026 Mochisoft OÜ\n"
        "// SPDX-License-Identifier: AGPL-3.0-only\n"
        "// This file is part of Mochi, licensed under the GNU AGPL v3 with the\n"
        "// Mochi Application Interface Exception - see license.txt and license-exception.md.\n"
        "// GENERATED by tools/aerosol.py from NASA's MERRA-2 - do not edit by hand.\n"
        f"// The aerosol optical depth at 550 nm, each calendar month's mean over {YEARS.start}-{YEARS.stop - 1}:\n"
        f"// {MONTHS} months from January, each {ROWS} rows from 90 N to 90 S every SPACING degrees, each of\n"
        f"// {COLUMNS} columns from 180 W to 180 E every SPACING degrees (the last repeats the first), one\n"
        "// byte a node in units of STEP.\n"
        f"export const SPACING = {SPACING}\n"
        f"export const ROWS = {ROWS}\n"
        f"export const COLUMNS = {COLUMNS}\n"
        f"export const MONTHS = {MONTHS}\n"
        f"export const STEP = {STEP}\n"
        f"export const AEROSOL = '{encoded}'\n"
    )


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    directory = Path(sys.argv[1])
    fetch(directory)
    table = colours((directory / "colours.xml").read_text())
    months = [nodes(mean([read(image(directory, y, m), table) for y in YEARS])) for m in range(1, 13)]
    data = pack(months)
    TS.write_text(ts(data))
    print(f"wrote {TS}: {len(data)} nodes, {min(data) * STEP:.3f} to {max(data) * STEP:.3f}")


if __name__ == "__main__":
    main()
