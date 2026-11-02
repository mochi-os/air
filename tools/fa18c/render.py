# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# Renders a built model from a few angles, posed from its points file as the
# engine poses it: each joint's drive value through its keys, then a turn
# about its axis, a slide along it, both (a bend), or shown or hidden, and
# each of its morphs' shape keys weighted. Drives not given rest at zero
# (gear and canopy stowed, surfaces neutral, the wing unloaded), so a render
# with no drives is the rest pose. Workbench, textured.
#
# usage: blender -b --factory-startup -P render.py -- MODEL.glb MODEL.json OUTDIR [drive=value ...]
#   e.g. gear=1 canopy=1 hook=1 probe=1 speedbrake=1 ladder=1 bar=1 load=7.5
import json, sys

import bpy
from mathutils import Quaternion, Vector

VIEWS = {
	"quarter": ((14, 11, 7), (-1, 0, 0)),
	"front": ((22, 0, 1.5), (0, 0, 0.5)),
	"side": ((2, -16, 0.2), (1, 0, -0.8)),
	"cockpit": ((8.5, 4.5, 3.2), (5.0, 0, 1.0)),
	"inlet": ((9, -6, -1.2), (1.5, -0.9, -0.3)),
	"under": ((6, -12, -6), (-1, 0, 0)),
	"rear": ((-22, 9, 6), (-2, 0, 0)),
}


def lookup(keys, x):
	if len(keys[0]) > 2:
		return tuple(lookup([[k[0], k[i]] for k in keys], x) for i in range(1, len(keys[0])))
	if x <= keys[0][0]:
		return keys[0][1]
	for (x0, y0), (x1, y1) in zip(keys, keys[1:]):
		if x <= x1:
			return y0 + (y1 - y0) * (x - x0) / (x1 - x0)
	return keys[-1][1]


def main():
	args = sys.argv[sys.argv.index("--") + 1 :]
	model, points, outdir = args[:3]
	drives = {k: float(v) for k, v in (a.split("=") for a in args[3:])}
	bpy.ops.wm.read_factory_settings(use_empty=True)
	bpy.ops.import_scene.gltf(filepath=model)
	for name, j in json.loads(open(points).read())["joints"].items():
		obj = bpy.data.objects.get(name)
		if obj is None:
			raise SystemExit(f"{name}: a joint with no node")
		keys = obj.data.shape_keys.key_blocks if getattr(obj.data, "shape_keys", None) else {}
		for key, morph in j.get("morphs", {}).items():
			if key not in keys:
				raise SystemExit(f"{name}: no shape key {key}")
			keys[key].slider_min, keys[key].slider_max = -10.0, 10.0
			keys[key].value = lookup(morph["keys"], drives.get(morph["drive"], 0.0))
		if j["motion"] == "morph":
			continue
		value = lookup(j["keys"], drives.get(j["drive"], 0.0))
		if j["motion"] == "show":
			obj.hide_render = value <= 0.5
			continue
		gltf = lambda a: Vector((a[0], -a[2], a[1]))   # glTF to Blender
		axis = gltf(j["axis"])
		if j["motion"] in ("rotate", "bend"):
			obj.rotation_mode = "QUATERNION"
			obj.rotation_quaternion = obj.rotation_quaternion @ Quaternion(axis, value[0] if j["motion"] == "bend" else value)
		if j["motion"] == "bend":
			obj.location += gltf(j["direction"]).normalized() * value[1]
		elif j["motion"] == "slide":
			obj.location += axis * value
	scene = bpy.context.scene
	scene.render.engine = "BLENDER_WORKBENCH"
	scene.display.shading.light = "STUDIO"
	scene.display.shading.color_type = "TEXTURE"
	scene.display.shading.show_cavity = True
	scene.render.resolution_x, scene.render.resolution_y = 1600, 1000
	scene.world = bpy.data.worlds.new("world")
	scene.world.color = (0.8, 0.8, 0.8)
	camera = bpy.data.objects.new("camera", bpy.data.cameras.new("camera"))
	scene.collection.objects.link(camera)
	scene.camera = camera
	for name, (eye, target) in VIEWS.items():
		camera.location = Vector(eye)
		camera.rotation_euler = (Vector(target) - Vector(eye)).to_track_quat("-Z", "Y").to_euler()
		scene.render.filepath = f"{outdir}/{name}.png"
		bpy.ops.render.render(write_still=True)


main()
