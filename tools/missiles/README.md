# Missiles

Our own AIM-9M and AIM-120C (claude/plans/air-fa18c.md #9), built as Blender scripts from cited facts and photo
measurements. Each is its own file with its own points file, so another aircraft can carry it later. The F/A-18C's
own launchers, racks and pylons are part of `fa18c.glb` (../fa18c), not these.

## Files

- `references.json`: the sources and their tiers (`trace`, `facts`, `look`), fetched by `../fa18c/fetch.py
  --catalogue references.json` into `references/` (ignored), each checked by its hash. The NAVAIR pages are live and
  local-only.
- `facts.json`: every cited size (length, diameter, span, the AIM-120's centre of gravity) and `layout`, what the
  photos measure: the body's profile, each fin's planform, the rollerons, lugs, bands and the mount, and the
  bare-metal `finishes`: each part's colour measured against the paint in the same photo, and their sheen (the
  game's loader keeps it for these names, `model.ts` `SHEEN`).
- `photos.json`: the single photos of each missile and their marks, which `measure.py` reads.
- `measure.py`: reads a photo's marks as stations (inches aft of the nose) and distances off the axis. The axis and
  the scale across it come from the body's outline in pairs and its cited diameter; the stations through a pinhole's
  projective map, scaled by the nose and tail, by a launcher of cited length beside the body (`"scale"`), or by the
  width alone when the body lies across the line of sight; a photo without the nose or tail takes its origin from a
  mark of known station (`"anchor"`). A photo square to the body is `"level"`: its widths change only where the
  body's sections do (the AIM-120's armament section is 2% wider), so the scale across is held constant; a slope
  fitted to such a step reads as perspective and skews the stations mid-body by inches. A photo at a slant
  `"pin"`s its perspective instead, with a mark of known station (a joint ring) besides the nose and tail. A `tail` mark is the end's aftmost outline point, moved back to the end's
  centre by how far the body is seen off its side. A photo well off the side is `"oblique"` (a body with nothing of
  known length along it is left out) and lists in `"planform"` the bodies whose fins span square to the line of
  sight; the others' fins stay out of the medians. Average a round's opposite fins: a pair rolled off square reads
  its tips apart along the axis in opposite senses (the AIM-120's wings, 3-5 in). A part seen close up with no axis in frame
  (a wing's trailing corner) is read on its own plane: the photo's `"plane"` names the part, its four corners
  marked in the photo fit a projective map onto the part's planform, and marks along its edges check the map
  (four corners fit any quadrilateral exactly, so a misplaced one shows only there).
- `build.py`: the model and its points file. Besides the body, wings and fins: `fittings`, each one of a side
  profile extruded to a width at a roll (a hook's stem, the harness cover), an outline on the body's surface as
  (station, roll) (wing fittings, fin-shaft sockets), a cross-section along the body (the forward hook's railed
  flange), a box with its top corners rounded seen from the side (the C-hangers), a level plate with rounded
  corners and holes (the aft shoe's flange) or a round post, mirrored to the other side where the missile is
  symmetric, and `bevel`led where the part is machined; a rolleron's flap, bearing bracket, tip block and toothed
  wheel; a nozzle's liner recessed in the aft face.
- `paint.py`: the paint over the atlas's bakes, plain numpy and Pillow: the joints, screw rows, stencils, placards,
  symbols, covers and ports of `layout.markings`, each given for the left side as (station, arc round the surface
  from the side's middle) and painted on the right mirrored, its lettering upright with the lugs up, reading aft on
  the left and forward on the right; and `layout.wear`'s light service wear: each section's own shade, a mottle
  and a fine grain at the spreads the photos measure, grime by the joints and lugs, smudges round the lifting
  points, scuffs, the wings' and fins' leading edges and tips worn toward bare metal, faded stencils.
- `check.py`: the facts check, each cited size measured back off the build.

## Build

    blender -b --factory-startup --python-exit-code 1 -P build.py -- aim9m OUT.glb OUT.json [--draft] [--bakes BAKES.npz]
    python3 -I check.py aim9m OUT.glb OUT.json

The build paints an atlas (`layout.atlas` texels a side, the base colour of every material but the glass): the
body's skin unrolled in pieces between its joints and the fins' rolls, every other part projected flat, then
Cycles' bakes of ambient occlusion, normals, and by emission each material's colour, each texel's place and the part
it lies on, and `paint.py` over them, saved as JPEG (quality 90, full colour resolution: a quarter of PNG's size,
the mottle and grain being what PNG compresses worst). That takes one to two minutes; `--draft` leaves it out, and `--bakes` keeps the
bakes for a look at the paint without Blender.

Run Blender under `systemd-run --user --scope --slice=probe.slice -p MemoryMax=6G -p MemorySwapMax=0`. The frame:
x forward along the missile, y up toward its lugs, z to its right, metres, origin on the axis at the centre of gravity.
The points file gives `nose`, `exit`, `gravity`, `mount` (the top of the body at the station its launcher seats) and
`lugs`; the joints are the movable fins (`control`) and the rollerons (`rolleron`).

Copy `OUT.glb` and `OUT.json` to `../../web/src/assets/<missile>.glb` and `.json`. A committed copy adds the whole
file to the public repository's history every time.

## Tests

    python3 -I test_measure.py
    python3 -I test_check.py
    python3 -I test_paint.py
    python3 -I test_build.py

`test_build.py` builds the AIM-120C with Blender (run it under the memory cap above) and probes its hooks, points
the layout makes solid and points it leaves empty, by the built mesh's winding number; and its paint, by the atlas
the body's own UVs show where the markings and joints are.
