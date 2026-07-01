#!/usr/bin/env python3
# midway-prep — offline build tool that turns the public-domain NOAA/NCEI Midway
# data into game-ready assets for the furball client (per midway.md §5).
#
# Outputs (to web/public/maps/midway/):
#   map.json           metadata: world origin, texture region half-extent, size, ground region
#   coastline.json     island outlines (Sand/Eastern/Spit) in world metres
#   water.jpg          ocean base colour: Sentinel-2 true colour over the atoll (real reef/lagoon
#                      and breakers), deep ocean cleaned toward a proper deep blue
#   ground.jpg         Sentinel-2 imagery cropped to the islands (island surface texture)
#
# Source data:
#   NOAA NCCOS midway_cover_geog.shp (public domain), unzipped under data/ — coastline only
#   Sentinel-2 L2A TCI (public sentinel-cogs bucket) — read remotely, see SENTINEL_TCI
#
# World frame (furball.md / midway.md): 1 unit = 1 m, x = east, z = south,
# atoll centred on the origin.
import os, json, shapefile
import numpy as np, rasterio
from rasterio.warp import reproject, Resampling
from rasterio.transform import Affine
from pyproj import Transformer
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
OUT = os.path.abspath(os.path.join(HERE, "..", "web", "public", "maps", "midway"))

ORIGIN_LAT, ORIGIN_LON = 28.2334, -177.3668   # atoll centre -> world origin
REGION_HALF = 12000                            # metres; coarse search area for the atoll extent
MAPTEX = 4096                                   # single water+island texture size (px)

# Sentinel-2 L2A true-colour COG for the island ground texture (public sentinel-cogs bucket, no auth).
# Picked via the Earth Search STAC API (bbox over Midway, lowest cloud): MGRS 1RDM, 2026-01-26, 0% cloud.
SENTINEL_TCI = "https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/1/R/DM/2026/1/S2C_1RDM_20260126_0_L2A/TCI.tif"
os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")   # efficient /vsicurl windowed reads
os.environ.setdefault("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", ".tif")

_to_local = Transformer.from_crs(
    "EPSG:4326",
    f"+proj=aeqd +lat_0={ORIGIN_LAT} +lon_0={ORIGIN_LON} +datum=WGS84 +units=m +no_defs",
    always_xy=True,
).transform

def to_world(lon, lat):
    e, n = _to_local(lon, lat)
    return e, -n            # x east, z south

def rings(shape):
    parts = list(shape.parts) + [len(shape.points)]
    for i in range(len(parts) - 1):
        yield shape.points[parts[i]:parts[i + 1]]

def load(name):
    return shapefile.Reader(os.path.join(DATA, name))

def reproject_sentinel(cx, cz, gh, size):
    """Reproject the Sentinel-2 TCI onto a square region (centre cx,cz, half gh, world m) → (size,size,3)
    uint8 RGB. Reads only that window from the remote COG."""
    aeqd = f"+proj=aeqd +lat_0={ORIGIN_LAT} +lon_0={ORIGIN_LON} +datum=WGS84 +units=m +no_defs"
    pixel = 2 * gh / size
    dst_transform = Affine(pixel, 0, cx - gh, 0, -pixel, gh - cz)   # world x=east, z=south; aeqd northing = −z
    rgb = np.zeros((3, size, size), dtype="uint8")
    with rasterio.open("/vsicurl/" + SENTINEL_TCI) as src:
        for b in range(3):
            reproject(source=rasterio.band(src, b + 1), destination=rgb[b],
                      src_transform=src.transform, src_crs=src.crs,
                      dst_transform=dst_transform, dst_crs=aeqd, resampling=Resampling.bilinear)
    return np.transpose(rgb, (1, 2, 0))

def save_map():
    """Single Sentinel-2 texture for BOTH the ocean and the islands, cropped to the atoll extent (so no
    pixels are wasted on open ocean and the islands keep their resolution), with the near-black deep
    ocean cleaned toward a proper deep blue. The ocean shader and the island meshes sample it; beyond
    the crop the ocean clamps to the deep-blue edge. Returns the crop half-extent (world m). JPEG."""
    # 1) coarse pass: find the atoll's half-extent from origin (bright reef/lagoon/land vs deep ocean)
    lum = reproject_sentinel(0.0, 0.0, REGION_HALF, 1024).astype("float32").mean(axis=2)
    ys, xs = np.where(lum > 55)
    per_px = 2 * REGION_HALF / 1024
    reach = max(np.percentile(np.abs(xs - 512), 99), np.percentile(np.abs(ys - 512), 99)) * per_px
    half = float(np.ceil((reach + 700) / 250) * 250)   # + margin, rounded to 250 m
    # 2) final crop at full resolution + deep-ocean clean
    sen = np.clip(reproject_sentinel(0.0, 0.0, half, MAPTEX).astype("float32") * 1.12, 0.0, 255.0)
    lm = sen.mean(axis=2)
    t = np.clip((60.0 - lm) / 40.0, 0.0, 1.0)[:, :, None]           # dark (deep-ocean) pixels → blue
    out = sen * (1.0 - t) + np.array([12, 52, 96], dtype="float32") * t
    gray = (out * np.array([0.2126, 0.7152, 0.0722], dtype="float32")).sum(axis=2, keepdims=True)
    out = out * 0.87 + gray * 0.13                                  # slightly duller / less vibrant
    Image.fromarray(np.clip(out, 0, 255).astype("uint8"), "RGB").save(os.path.join(OUT, "map.jpg"), quality=85, optimize=True)
    print(f"map.jpg: Sentinel-2 water+islands, cropped to ±{half:.0f} m ({MAPTEX}px, {2*half/MAPTEX:.1f} m/px)")

    # lagoon/calm mask: the whole atoll interior (reef flat + lagoon incl. the deep basin) is protected
    # water. Seal narrow reef channels (morphological closing), flood-fill the open ocean in from the
    # border, and mark everything the reef encloses as calm. Drives the ocean shader's wave damping —
    # the deep lagoon basin looks like open ocean by colour, so it can't be told apart pixel-wise.
    MASK = 1024
    lm_small = np.asarray(Image.fromarray(lm.astype("uint8")).resize((MASK, MASK), Image.BILINEAR))
    atoll = Image.fromarray(((lm_small > 60) * 255).astype("uint8"))                     # reef flat / lagoon shallow / land
    atoll = atoll.filter(ImageFilter.MaxFilter(31)).filter(ImageFilter.MinFilter(31))    # close reef channels ≲ 350 m
    ocean = atoll.point(lambda v: 0 if v > 127 else 255)                                 # deep water = not-atoll
    for corner in ((0, 0), (MASK - 1, 0), (0, MASK - 1), (MASK - 1, MASK - 1)):
        ImageDraw.floodfill(ocean, corner, 128, thresh=50)                               # flood the open ocean
    calm = (np.asarray(ocean) != 128).astype("uint8") * 255                              # everything the reef encloses
    Image.fromarray(calm).filter(ImageFilter.GaussianBlur(6)).save(os.path.join(OUT, "lagoon.png"))
    print("lagoon.png: atoll-interior calm mask (1024px)")
    return half

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

    # ---- single Sentinel-2 texture for the ocean AND the islands, cropped to the atoll ----
    half = save_map()

    # map.json — generic per-map metadata (same format for future maps). region_half is the texture's
    # half-extent (world m); wrap = toroidal world size in metres (engine treats it as optional, 0 = off).
    json.dump({"name": "Midway Atoll", "origin": [ORIGIN_LAT, ORIGIN_LON],
               "region_half": round(half, 1), "texture_size": MAPTEX, "wrap": 250000},
              open(os.path.join(OUT, "map.json"), "w"))
    print("map.json written")

if __name__ == "__main__":
    build()
