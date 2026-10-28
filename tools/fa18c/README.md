# F/A-18C

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
