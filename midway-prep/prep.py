#!/usr/bin/env python3
# midway-prep — offline build tool that turns the public-domain NOAA/NCEI Midway
# data into game-ready assets for the furball client (per midway.md §5).
#
# Outputs (to web/public/maps/midway/):
#   map.json           metadata: world origin, texture region half-extent, size
#   coastline.json     island outlines (Sand/Eastern/Spit) in world metres
#   water.png          RGBA reef/lagoon/deep map: RGB = base water colour
#                      (deep blue -> turquoise -> shallow), A = reef-crest foam mask
#
# Source data (public domain, NOAA NCCOS), unzipped under data/:
#   midway_cover_geog.shp   aggregated habitat cover (HABCOVER, has 'land')
#   midway_class_geog.shp   detailed habitat class (HABCLASS, has 'surf' reef crest)
#   midway_bathy_4m.tif     IKONOS-estimated bathymetry (metres) — folded in later
#
# World frame (furball.md / midway.md): 1 unit = 1 m, x = east, z = south,
# atoll centred on the origin.
import os, json, shapefile
from pyproj import Transformer
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
OUT = os.path.abspath(os.path.join(HERE, "..", "web", "public", "maps", "midway"))

ORIGIN_LAT, ORIGIN_LON = 28.2334, -177.3668   # atoll centre -> world origin
REGION_HALF = 12000                            # metres; water map covers ±12 km (24 km square)
TEX = 2048                                     # water map size (px) → ~11.7 m/px

_to_local = Transformer.from_crs(
    "EPSG:4326",
    f"+proj=aeqd +lat_0={ORIGIN_LAT} +lon_0={ORIGIN_LON} +datum=WGS84 +units=m +no_defs",
    always_xy=True,
).transform

def to_world(lon, lat):
    e, n = _to_local(lon, lat)
    return e, -n            # x east, z south

def to_px(x, z):
    return ((x + REGION_HALF) / (2 * REGION_HALF) * TEX,
            (z + REGION_HALF) / (2 * REGION_HALF) * TEX)   # north up (z south -> py down)

def rings(shape):
    parts = list(shape.parts) + [len(shape.points)]
    for i in range(len(parts) - 1):
        yield shape.points[parts[i]:parts[i + 1]]

def load(name):
    return shapefile.Reader(os.path.join(DATA, name))

# --- habitat class -> (draw priority, opaque base RGB) ------------------------
# priority: deep(0) < reef flat(1) < sand/shallow(2) < surf/foam(3) < land(4, on top)
DEEP  = (0, (9, 46, 88))       # deep ocean blue
REEF  = (1, (30, 120, 132))    # reef flat (hardbottom/coral/pavement) — teal
SAND  = (2, (104, 198, 188))   # lagoon sand / shallows — turquoise
SURF  = (3, (210, 240, 234))   # reef crest breakers — pale foam band
LAND  = (4, (200, 188, 150))   # island footprint (occluded by geometry, kept crisp)
def tier(hc):
    h = hc.lower()
    if "deep water" in h or "no data" in h: return DEEP
    if h == "surf":                          return SURF
    if h == "land":                          return LAND
    if "sand" in h or "unconsolidated" in h: return SAND
    return REEF                               # pavement/coral/reef/hardbottom/algae/…

def build():
    os.makedirs(OUT, exist_ok=True)
    # ---- coastline (land polygons) from the cover layer ----
    cover = load("midway_cover_geog")
    ci = [f[0] for f in cover.fields[1:]].index("HABCOVER")
    coast = []
    for sr in cover.shapeRecords():
        if sr.record[ci] != "land":
            continue
        for ring in rings(sr.shape):
            pts = [[round(x, 1), round(z, 1)] for x, z in (to_world(lo, la) for lo, la in ring)]
            if len(pts) >= 4:
                coast.append(pts)
    coast.sort(key=len, reverse=True)
    json.dump({"origin": [ORIGIN_LAT, ORIGIN_LON], "polygons": coast},
              open(os.path.join(OUT, "coastline.json"), "w"))
    print(f"coastline.json: {len(coast)} island polygons")

    # ---- water colour + foam map from the detailed class layer ----
    cls = load("midway_class_geog")
    hi = [f[0] for f in cls.fields[1:]].index("HABCLASS")
    polys = []
    for sr in cls.shapeRecords():
        t = tier(sr.record[hi])
        for ring in rings(sr.shape):
            if len(ring) >= 3:
                polys.append((t[0], t[1], [to_px(*to_world(lo, la)) for lo, la in ring]))
    polys.sort(key=lambda p: p[0])   # draw deep first, surf/land last
    img = Image.new("RGB", (TEX, TEX), DEEP[1])
    d = ImageDraw.Draw(img)
    for _, rgb, px in polys:
        d.polygon(px, fill=rgb)
    img.save(os.path.join(OUT, "water.png"))
    print(f"water.png: {TEX}x{TEX}, {len(polys)} habitat polygons rasterised")

    # map.json — generic per-map metadata (same format for future maps). wrap = toroidal
    # world size in metres; the engine treats it as optional (omit / 0 → no wrap).
    json.dump({"name": "Midway Atoll", "origin": [ORIGIN_LAT, ORIGIN_LON],
               "region_half": REGION_HALF, "texture_size": TEX, "wrap": 250000},
              open(os.path.join(OUT, "map.json"), "w"))
    print("map.json written")

if __name__ == "__main__":
    build()
