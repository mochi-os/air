# midway-prep

Offline build tool that turns public-domain Midway Atoll data into game-ready
assets for the furball client. See `midway.md` §5.

World frame (furball.md / midway.md): 1 unit = 1 m, x = east, z = south, atoll
centred on the world origin.

## Source data

The **coastline** comes from the NOAA NCCOS habitat cover shapefile (public
domain), downloaded to `data/` (git-ignored; re-fetch any time):

    mkdir -p data && cd data
    curl -O https://cdn.coastalscience.noaa.gov/datasets/e98/data/midway_cover_shapes.zip
    unzip -o midway_cover_shapes.zip

- `midway_cover_geog.shp` — aggregated habitat cover (`HABCOVER`, incl. `land`); the `land` rings become the island outlines.

Everything visible (water + islands) is **Sentinel-2** true-colour imagery, read
remotely (windowed) from the public `sentinel-cogs` bucket — no download needed;
see `SENTINEL_TCI` in `prep.py`. The scene (MGRS 1RDM, 2026-01-26, 0% cloud) was
picked via the Earth Search STAC API:

    curl -X POST -H 'Content-Type: application/json' \
      -d '{"collections":["sentinel-2-l2a"],"bbox":[-177.43,28.13,-177.31,28.28],"query":{"eo:cloud_cover":{"lt":15}},"sortby":[{"field":"properties.eo:cloud_cover","direction":"asc"}]}' \
      https://earth-search.aws.element84.com/v1/search

Still to add (midway.md §3): OSM runway/taxiway vectors, NCEI integrated DEM.

## Run

    python3 -m venv venv && ./venv/bin/pip install pyshp pyproj numpy Pillow rasterio
    ./venv/bin/python prep.py

## Outputs → `../web/public/maps/midway/`

- `map.json` — world origin (lat/lon), region half-extent (m), texture size, wrap, ground region.
- `coastline.json` — Sand / Eastern / Spit island outlines as world-metre polygons.
- `water.jpg` — ocean base colour: Sentinel-2 true colour over the atoll (real reef,
  lagoon, and breakers), with the near-black deep ocean cleaned toward a proper deep
  blue; sampled by the ocean shader. The reef-crest surf is the real breakers in the photo.
- `ground.jpg` — Sentinel-2 imagery cropped to the islands (JPEG); planar-mapped onto
  the island meshes (real airfield / roads / vegetation).
