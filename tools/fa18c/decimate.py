"""The F/A-18C's distant models, step three (after far.py): in headless Blender, weld parts.glb's
triangle soup, collapse each part to its budget and write fa18c-far.glb with vertex colours:
  airframe, up, down, burner   the medium stage (the engine draws airframe, burner and the gear part
                               for the gear's position)
  far                          the airframe and the gear-up part as one silhouette, for the far stage
The colours sit on face corners, so welding keeps every colour edge.

Usage (from this directory):
  PYTHONPATH=$HOME/.local/lib/python3.14/site-packages \\
  blender -b --factory-startup --python-use-system-env -P decimate.py -- parts.glb fa18c-far.glb
then copy fa18c-far.glb to ../../web/src/assets/ and check it with farcheck.py."""
import bpy, bmesh, math, sys

BUDGET = {'airframe': 4200, 'up': 250, 'down': 700, 'burner': 80, 'far': 400}
WELD = 0.0005    # model units (metres): soup corners closer than this are one vertex
SHELL = 0.12     # the far silhouette is first remeshed to one watertight shell on a grid this fine: the jet is
                 # many separate panels, and a collapse cannot merge pieces that share no vertex
SMOOTH = 40.0    # degrees: edges sharper than this stay hard

argv = sys.argv[sys.argv.index('--') + 1:]
src, dst = argv[0], argv[1]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)

def triangles(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)

def collapse(o, budget, shell=0.0):
    bm = bmesh.new(); bm.from_mesh(o.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=WELD)
    bm.to_mesh(o.data); bm.free()
    if shell:
        o.data.remesh_voxel_size = shell; o.data.use_remesh_preserve_attributes = True
        bpy.ops.object.select_all(action='DESELECT'); o.select_set(True); bpy.context.view_layer.objects.active = o
        bpy.ops.object.voxel_remesh()
        bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT'); bpy.ops.mesh.quads_convert_to_tris(); bpy.ops.object.mode_set(mode='OBJECT')
    have = triangles(o)
    if have > budget:
        bpy.context.view_layer.objects.active = o
        m = o.modifiers.new('collapse', 'DECIMATE'); m.decimate_type = 'COLLAPSE'; m.ratio = budget / have
        bpy.ops.object.modifier_apply(modifier=m.name)
    bpy.ops.object.select_all(action='DESELECT'); o.select_set(True); bpy.context.view_layer.objects.active = o
    bpy.ops.object.shade_smooth_by_angle(angle=math.radians(SMOOTH))
    print(f'decimate: {o.name}: {have} -> {triangles(o)} triangles (budget {budget})')

objects = {o.name: o for o in bpy.data.objects if o.type == 'MESH'}
# the far silhouette: the airframe and the closed gear doors, joined before either is reduced
bpy.ops.object.select_all(action='DESELECT')
copies = []
for name in ('airframe', 'up'):
    c = objects[name].copy(); c.data = objects[name].data.copy(); bpy.context.collection.objects.link(c); copies.append(c)
for c in copies: c.select_set(True)
bpy.context.view_layer.objects.active = copies[0]
bpy.ops.object.join()
far = bpy.context.view_layer.objects.active; far.name = 'far'; far.data.name = 'far'
objects['far'] = far
for name, o in objects.items():
    collapse(o, BUDGET[name], SHELL if name == 'far' else 0.0)
for o in bpy.data.objects:
    for slot in list(o.material_slots): o.active_material_index = 0
bpy.ops.export_scene.gltf(filepath=dst, export_format='GLB', export_materials='NONE', export_vertex_color='ACTIVE',
                          export_texcoords=False, export_animations=False, export_apply=True, export_yup=True)
