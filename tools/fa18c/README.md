# F/A-18C distant stages

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
