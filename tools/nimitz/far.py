"""The Nimitz's distant model, built in headless Blender from nimitz-clean.glb: everything but the deck
strip, its underside and the deck-edge skirt, which the full model keeps drawing at every range (so the
deck texture is never downloaded twice), with coplanar faces dissolved and every mesh then collapsed
towards BUDGET triangles in all. The engine swaps it in once the ship stands under FAR_SIZE reference
pixels long on screen (engine.ts, carrier_stage).

Usage (from this directory):
  PYTHONPATH=$HOME/.local/lib/python3.14/site-packages \\
  blender -b --factory-startup --python-use-system-env -P far.py -- nimitz-clean.glb nimitz-far.glb
then pack it: ../gltfpack-native -i nimitz-far.glb -o ../../web/src/assets/nimitz-far.glb -cc -noq
and check it with farcheck.py."""
import bpy, bmesh, math, sys

KEEP = {'deck_baked', 'deck_underside', 'deck_skirt'}   # drawn by the full model at every range
BUDGET = 50000      # triangles in all
PLANAR = 2.0        # degrees: faces this close to coplanar merge first, which costs nothing to the eye

argv = sys.argv[sys.argv.index('--') + 1:]
src, dst = argv[0], argv[1]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)

for o in list(bpy.data.objects):
    if o.type == 'MESH' and (o.name in KEEP or (o.data and o.data.name in KEEP)):
        bpy.data.objects.remove(o, do_unlink=True)

def triangles(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)

meshes = [o for o in bpy.data.objects if o.type == 'MESH']
for o in meshes:   # planar dissolve, then triangulate so the collapse ratio counts triangles
    bm = bmesh.new(); bm.from_mesh(o.data)
    bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(PLANAR), verts=bm.verts, edges=bm.edges)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    bm.to_mesh(o.data); bm.free()
total = sum(triangles(o) for o in meshes)
ratio = min(1.0, BUDGET / max(total, 1))
print(f'far: {len(meshes)} meshes, {total} triangles after the planar dissolve, collapsing by {ratio:.3f}')
if ratio < 1.0:
    for o in meshes:
        bpy.context.view_layer.objects.active = o
        m = o.modifiers.new('collapse', 'DECIMATE'); m.decimate_type = 'COLLAPSE'; m.ratio = ratio
        bpy.ops.object.modifier_apply(modifier=m.name)
print(f'far: {sum(triangles(o) for o in meshes)} triangles after the collapse')
for img in list(bpy.data.images):
    bpy.data.images.remove(img)
bpy.ops.export_scene.gltf(filepath=dst, export_format='GLB', export_image_format='NONE', export_texcoords=False,
                          export_animations=False, export_apply=True, export_yup=True)
