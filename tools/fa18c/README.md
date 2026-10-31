# F/A-18C

## Our own model: sources

The F/A-18C is being rebuilt as our own model (`claude/plans/air-fa18c.md`); the sections after this one
describe tools for the model it replaces. Every source the build draws on is listed in `references.json`, with
its licence and what the build may do with it: `trace` (a US government work, may be traced and matched),
`facts` (its numbers may be cited, its figures are never traced into the repository: NATOPS, and the contractor,
grant and AIAA reports) or `look`. Every dimension the build uses is in `facts.json` with its source and where
in it.

```
python3 -I fetch.py    # downloads each reference into references/ (ignored by git), checked by hash
python3 -I views.py    # true-scale top, side and front silhouettes from the HATP three-view
```

- **`fetch.py`** - fetches every `references.json` entry with a url into `references/` and checks its
  SHA-256; a file already there with the right hash is kept.
- **`views.py`** - renders the HATP overview's figure 2 (NASA, public domain) at 600 DPI and fills each view's
  outline into a silhouette mask, written to `references/<view>.png` with `references/views.json` (metres per
  pixel, nose apex, centreline). The side and front views are scaled by their dimension bars, 56.00 ft and
  37.417 ft. The figure draws the top view about 1.5% smaller, so it is scaled by its own 56 ft length; its
  span with missiles then reads 12.33 m, NATOPS's 40 ft 5 in to 0.1%. The figure is a sketch: the masks
  check outlines to a few centimetres.

  It also traces TP-3111 figure 5's six sections (FS 107 to 357, the last three with the LEX) into
  `references/sections.json`, at the one scale that fits TM-101724's heights and widths at FS 107, 142 and
  184 to 0.8 in. Where sources disagree, measured and dimensioned data win over the sketches. The HATP
  silhouettes run 2-6 in larger than these sections, partly the drawn line's width, and its top view draws the
  LEX 9-15 in wider than TP-3111 and TM-101724 agree on.

  Last, `references/profiles.json`: the HATP side view's top and keel lines and the top view's half-width at
  each inch of station, registered on the nose apex (FS 60.5, WL 100) and moved in by half the drawn line.

```
blender -b --factory-startup -P build.py -- OUT.glb OUT.json FEATURES.json [--draft]   # under the probe.slice memory cap
python3 -I check.py OUT.glb OUT.json
python3 -I outline.py OUT.glb [OVERLAY.png] [--threshold INCHES]
```

The model is checked by the procedure in `../verify/README.md`; these are its F/A-18C parts.

- **`build.py`** - builds the model in Blender from `facts.json` and the traced references, into the
  plan's contract (Contract in `air-fa18c.md`): true metres in the engine's axes, origin FS 456, WL 105, each
  moving part a node on its hinge resting unrotated, and its joints in OUT.json. The lifting surfaces take
  NACA 65A sections from TR-84's tables; the hinged surfaces' chord fractions follow from their published
  areas over the spans in `facts.json` `layout`. The forebody lofts the cited sections over the HATP keel
  line, its nosecone on TM-101724's drooped axis; the LEX is a blade whose span and heights come from
  TM-101724, cr186938 and the traced sections, faired behind the LEX-wing junction onto the wing root. Every
  trace is read through its pixel steps, never step by step: the HATP profiles through each step's midpoint
  and then a 4 in Gaussian (`smoothed()`), the traced sections' outlines by a 1 in Gaussian along them
  (`destaired()`). Every run between cited values (section shapes, ratios, widths, the rear body's and the
  nacelles' knots) is a monotone cubic that arrives level at its last knot (`onward()`), never a straight run,
  which creases the skin at each knot. The top line follows the canopy's located points and then the rear
  fuselage's top through the blend (FS 357-404). The loft has a ring every 3 in over the nose and every 4 in
  from the canopy's aft end to the nozzles. The fairing settles once onto the line the skin runs along where
  it lands (85% of `FAIRING` behind the junction), from the blade as it stands at the junction with its edge
  riding the wing. Each inlet is a raked D-shaped mouth through the lip points the photos measure
  (`layout.inlet`), its flat side inboard beside a splitter plate. Behind the lip its outer skin rides the
  nacelle as it grows (`target()`), carrying the mouth's D as it stands off the nacelle at the lip, that
  difference fading out by `JOIN` (FS 440), where it hands over to the rear fuselage on one ring, behind the
  duct's plug, where the nacelles join the fuselage whole; each nacelle's bottom follows `layout.nacelle`.
  From `JOIN` aft the points that bridge the tunnel between the nacelles run evenly along the outline
  (`along()`). Behind the forebody the sections' lower
  steps run evenly along the outline, not round its centre, and the fuselage is split into triangles before
  any panel is cut from it, so panel and skin share them. The canopy's sill, top line and
  leaning bow and aft edge are where the photos put them (`layout.canopy`), the glass's section a
  superellipse fitted to the photos' outlines. The nose carries the probes, fairings, light strips and blade
  the photos place (`layout.aoa`, `pitot`, `blisters`, `formation`, `blade`), the fins their tip pods
  (`layout.pod`), and a simple cockpit with its pilot sits under the canopy (`layout.cockpit`). Each nozzle
  is twelve outer flaps, each its own joint (`layout.petals`). Flush panels (the speedbrake, the nose-gear
  doors) are cut from the fuselage's own built skin (`cut()`) and offset off every facet; parts that stow
  inside it (the gear, the ladder in the LEX) are placed by ray casts on the built parts (`built()`). The third
  output, the features file, names points and curves on the model with the node each rides on, for the photo
  match. `--draft` leaves out the paint bake (seconds instead of minutes).
- **`check.py`** - the facts check: measures the built model back against every `facts.json` entry, posed
  where the entry needs it, and fails outside each tolerance; entries it does not measure are listed in
  `EXEMPT` with the reason, and `test_check.py` fails on an entry that is neither. Shape checks (`shape.*`)
  cover what no number does: the LEX running into the wing with no step; every stowed part, and the
  cockpit, inside the airframe at rest (`STOWED`: a ray each way along each axis meets it); each flush panel
  0.15 in off the skin along its normal, with no skin poking through (`FLUSH`); each left part the mirror
  image of its right twin, at rest and gear down; parts lying against each other (`SEAMS`: the inlets, the
  LEX and its fairing, the wing root, the fuselage) never crossing back and forth where they show; nothing
  poking through the LEX's fairing, which covers the wing's root end; the fuselage's store mounts on the
  skin; no crease in the skin away from its real edges (`shape.bend`: fixed lines on the skin seen from
  above, below and outboard, and over the LEX and its fairing from above, each bend over 4 in either side
  counted where most of it lies within 2 in, so smooth curvature is not; the canopy is left out only on the
  lines that meet it; each view's tolerance lies between the fixed build and one with its rings spread out;
  on the fairing a step counts as a bend, not as an edge);
  the belly between the nose and the inlets bending no more than its curve; and the fuselage's section,
  where each inlet hands over, standing nowhere outside the inlet's last ring (`shape.joint`).
- **`outline.py`** - the outline check: the model's top, side and front silhouettes at the HATP masks' scale,
  registered on the apex and centreline, with the share of their union both cover, and every place the
  outlines part by more than a threshold, worst first, in stations, waterlines and buttlines.
- **`photos.json`** - the photo match's catalogue (`../verify/photos.py`): the frame, the anchors the sources
  cite, and per photo its marks, traced edges and pose. **`marking.md`** names every point and edge and how to
  mark them.
- **`checklist.json`** - every visible shape, region by region, with the photos that show it and whether the
  model matches.
- **`tips.py`** - the wing's and the stabilators' tip heights from the solved photos (`photos.py --cameras`):
  one offset per surface shared by every photo, the whole surface raised or (`--rotate`) turned about its
  root, each photo's deflections fitted beside it or (`--neutral`) held at rest, and each photo left out in
  turn. Ground photos droop the flaps and ailerons 40-45 deg; in-flight photos show the wing bent up at 1 g.
  The model rests at the ground shape (`layout.wing`).
- **`render.py`** - renders the model posed from its points file as the engine poses it (`gear=1 canopy=1`
  ...), in Workbench: the rig contract's check that every joint turns, slides or shows as its keys say.

```
python3 -I ../verify/photos.py photos.json OUT.glb OUT.json FEATURES.json --overlays DIR --cameras CAMERAS.json
blender -b --factory-startup -P ../verify/view.py -- OUT.glb OUT.json CAMERAS.json RENDERS
python3 -I ../verify/photos.py photos.json OUT.glb OUT.json FEATURES.json --sheets RENDERS SHEETS
blender -b --factory-startup -P render.py -- OUT.glb OUT.json DIR gear=1 canopy=1
python3 -I tips.py photos.json CAMERAS.json OUT.glb OUT.json FEATURES.json --photos ID,... [--drop ID:MARK,...] [--neutral] [--rotate]
python3 -I test_check.py
```

The build also unwraps every part into one atlas and bakes its ambient occlusion in Cycles (`paint.png`
beside OUT.glb), the shading the paint is laid over, and each texel's surface normal, which picks the
upper grey or, facing down, the lower (`layout.paint`, sampled in the reference photo).

The distant stages come from the painted build (the old model's own pipeline is below):

```
python3 -I stages.py OUT.glb OUT.json PARTS.glb POSE.json   # coloured parts and the posed jet, gear up and down
blender -b --factory-startup -P decimate.py -- PARTS.glb FAR.glb
python3 -I farcheck.py [-v] FAR.glb POSE.json
```

- **`stages.py`** - poses our model gear up and gear down through its points file, colours every corner
  from the paint atlas, splits what moves with the gear from the airframe, and drops the faces a flood from
  outside never reaches. It writes the parts for `decimate.py` and the posed jet in the form `farcheck.py`
  reads. `test_check.py` holds a provenance test: none of our model's scripts names the old model, its
  stages or the vendor downloads.

The model viewer (`/air/models`) shows the latest painted build as `fa18c-new.glb`, beside the model it
replaces. After a build, copy it in: `cp OUT.glb ../../web/src/assets/fa18c-new.glb`, then `/build air`.

## Factory-fresh paint

`web/src/assets/fa18c.glb` is the JPEG model from before #200 with its atlases repainted clean (#147), then
encoded to KTX2. The source atlases carry a service jet's wear: grime on the skin, and chipped paint on the
cockpit's sills, walls and throttle grips.

```
git show bdd7ebc63^:web/src/assets/fa18c.glb > /tmp/source.glb
python3 fresh.py /tmp/source.glb /tmp/fresh.glb [preview]                    # preview: each atlas before and after
python3 ../texswap.py /tmp/fresh.glb ../../web/src/assets/fa18c.glb etc1s 15,19,20,21,22
```

- **`fresh.py`** - repaints each atlas in `ATLASES` over the texels its materials' triangles cover. The exterior
  (`skin`) keeps a broad base, the panel lines, rivets and stencils above a noise floor, and every marking that
  stands well off the base; the nozzle petals' grain goes under a higher floor. The cockpit and the gear (`pit`)
  take an edge-preserving smoothing that keeps hard edges and the baked shading. Per atlas, rectangles name what
  else to fill: paint chips on an island's edge (`chips`), light scuffs and worn bands on dark frames (`light`, and
  `faint` for fainter ones on plain paint), a strip's dashed worn edge, averaged along the strip (`along`), every
  flake (`clean`), whole islands to repaint as the exterior is (`skin`), parts to paint whole in their colour
  (`flat`, and `discs` for round button faces, their legend kept), whole islands to paint in a colour of their own
  (`paint`: the shoulder spotlights' housings and arms, in the cockpit's grey), triangles to point at a patch of
  their own where their UVs lie on a neighbour's (`patch`: the spotlights' lenses, which share their barrels' ends),
  and what to leave as it was (`keep`: the pilot, the engine faces, the compass card). Every texel outside the triangles' coverage then takes its island's edge, so
  filtering never meets the background or the wear the source painted past an island. The canopy sills' rivets are
  cleared from atlas 9: the engine builds them as geometry (`RIVETS` in engine.ts), since at three texels across
  the painted ones stretch to soft dashes.
- **`../texswap.py`** - encodes the atlases to KTX2: UASTC for the panel atlases that carry lettering, ETC1S for
  the rest. Its temporary files go beside the output and are removed.

## Distant stages

Builds `web/src/assets/fa18c-far.glb`, the stages the engine draws another jet with once it is small
on screen (engine.ts, distance stages): a merged **medium** model of about 5,000 triangles from 80 down
to 8 reference pixels long (1/1080 of the view's height; 280 m to 2.8 km at normal zoom), a **far**
silhouette of 400 from 8 to 2, then a dot. The shipped `fa18c.glb` is never rewritten: its rig finds
parts by name, so nothing here round-trips it.

```
cd ../../web && pnpm exec tsx tools/pose.ts ../tools/fa18c/pose.json   # posed as the engine draws it
cd ../tools/fa18c
python3 far.py                                                         # coloured parts, interior dropped
PYTHONPATH=$HOME/.local/lib/python3.14/site-packages blender -b --factory-startup \
  --python-use-system-env -P decimate.py -- parts.glb fa18c-far.glb   # each part to its budget
python3 farcheck.py -v                                                 # and views.png to look at
../gltfpack-native -i fa18c-far.glb -o ../../web/src/assets/fa18c-far.glb -cc -kn
```

- **`web/tools/pose.ts`** — poses the shipped jet with model.ts's own `posed()` (the static fixes,
  every scrubbed family at neutral, the surfaces at neutral: gear up) and again with the gear family
  at the end of its moving span (gear down), and writes every mesh in the model's own frame.
- **`far.py`** — splits the meshes into the airframe, what moves with the gear (in each pose) and
  the burner's glowing faces; colours every corner from the original download's textures by
  material name (the shipped KTX2 cannot be decoded here; the UVs are the same); makes glass a dark
  opaque tint and leaves out the near-invisible helpers and the decal overlays; and drops the faces
  a voxel flood from outside never reaches (the cockpit behind the closed canopy, the engine cans).
- **`decimate.py`** — welds and collapses each part to its budget; the far silhouette is first
  remeshed to one watertight shell, since a collapse cannot merge the jet's separate panels.
- **`farcheck.py`** — every stage present and within budget, nearly every vertex on the posed jet,
  the airframe and far stages spanning the jet, and the far colours matching the airframe's.

The burner keeps its own glow; the formation strips' night glow is not carried into the stages.
