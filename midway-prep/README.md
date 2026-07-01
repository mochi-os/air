# midway-prep

Offline build tool that turns public-domain NOAA/NCEI Midway Atoll data into
game-ready assets for the furball client. See `midway.md` §5.

World frame (furball.md / midway.md): 1 unit = 1 m, x = east, z = south, atoll
centred on the world origin.

## Source data (public domain, NOAA NCCOS + NCEI)

Downloaded to `data/` (git-ignored; re-fetch any time):

    mkdir -p data && cd data
    for f in midway_cover_shapes.zip midway_class_shapes.zip midway_bathy_4m.zip; do
      curl -O "https://cdn.coastalscience.noaa.gov/datasets/e98/data/$f"
    done
    for z in *.zip; do unzip -o "$z"; done

- `midway_cover_geog.shp` — aggregated habitat cover (`HABCOVER`, incl. `land`).
- `midway_class_geog.shp` — detailed habitat class (`HABCLASS`, incl. `surf` reef crest).
- `midway_bathy_4m.tif` — IKONOS-estimated bathymetry, metres (folded into the depth tint later).

Still to add (midway.md §3): Sentinel-2 ground texture, OSM runway/taxiway vectors,
NCEI integrated DEM.

## Run

    python3 -m venv venv && ./venv/bin/pip install pyshp pyproj numpy Pillow
    ./venv/bin/python prep.py

## Outputs → `../web/public/maps/midway/`

- `map.json` — world origin (lat/lon), water-map region half-extent (m), texture size.
- `coastline.json` — Sand / Eastern / Spit island outlines as world-metre polygons.
- `water.png` — opaque reef/lagoon/deep colour map (deep blue → teal reef flat →
  turquoise lagoon → pale foam at the reef crest → sand island footprints), sampled
  by the ocean shader for base water colour.
