# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# Renders a model through each camera photos.py solved (--cameras), posed as
# each photo's catalogue entry says, shaded grey with cavity lines on a
# transparent background, at the photo's aspect: what photos.py --sheets lays
# beside and over the photo. The cameras are pinholes; the photos are
# straightened to match (photos.py removes k1).
#
# usage: blender -b --factory-startup -P view.py -- MODEL.glb POINTS.json CAMERAS.json OUTDIR [WIDTH]
import json, math, sys
from pathlib import Path

import bpy
from mathutils import Matrix, Quaternion, Vector


def lookup(keys, x):
	if x <= keys[0][0]:
		return keys[0][1]
	for (x0, y0), (x1, y1) in zip(keys, keys[1:]):
		if x <= x1:
			return y0 + (y1 - y0) * (x - x0) / (x1 - x0)
	return keys[-1][1]


def rodrigues(v):
	angle = math.sqrt(sum(c * c for c in v))
	if angle < 1e-12:
		return Matrix.Identity(3)
	return Quaternion(Vector(v) / angle, angle).to_matrix()


GLTF = Matrix(((1, 0, 0), (0, 0, -1), (0, 1, 0)))   # a glTF (y up) vector in Blender's z-up frame


def main():
	args = sys.argv[sys.argv.index("--") + 1 :]
	model, points, cameras, outdir = args[:4]
	width = int(args[4]) if len(args) > 4 else 1600
	bpy.ops.wm.read_factory_settings(use_empty=True)
	bpy.ops.import_scene.gltf(filepath=model)
	joints = json.loads(Path(points).read_text())["joints"]
	rest = {name: (obj.location.copy(), obj.rotation_mode, obj.rotation_quaternion.copy(), obj.hide_render)
		for name, obj in ((n, bpy.data.objects.get(n)) for n in joints) if obj is not None}
	scene = bpy.context.scene
	scene.render.engine = "BLENDER_WORKBENCH"
	scene.display.shading.light = "STUDIO"
	scene.display.shading.color_type = "SINGLE"
	scene.display.shading.single_color = (0.72, 0.74, 0.77)
	scene.display.shading.show_cavity = True
	scene.display.shading.cavity_type = "BOTH"
	scene.render.film_transparent = True
	scene.render.image_settings.file_format = "PNG"
	scene.render.image_settings.color_mode = "RGBA"
	camera = bpy.data.objects.new("camera", bpy.data.cameras.new("camera"))
	scene.collection.objects.link(camera)
	scene.camera = camera
	for entry in json.loads(Path(cameras).read_text()):
		for name, (location, mode, quaternion, hidden) in rest.items():
			obj = bpy.data.objects[name]
			obj.location, obj.rotation_mode, obj.rotation_quaternion, obj.hide_render = location, "QUATERNION", quaternion, hidden
		drives = entry.get("pose", {})
		for name, j in joints.items():
			obj = bpy.data.objects.get(name)
			if obj is None:
				continue
			value = lookup(j["keys"], float(drives.get(j["drive"], 0.0)))
			if j["motion"] == "show":
				obj.hide_render = value <= 0.5
				continue
			axis = GLTF @ Vector(j["axis"])
			if j["motion"] == "rotate":
				obj.rotation_quaternion = obj.rotation_quaternion @ Quaternion(axis, value)
			else:
				obj.location += axis * value
		f, r, t = entry["camera"][0], entry["camera"][1:4], Vector(entry["camera"][4:7])
		R = rodrigues(r)   # model (glTF frame) to camera (x right, y down, z forward)
		# Blender's camera looks down its -z with +y up
		to_world = R.transposed() @ Matrix(((1, 0, 0), (0, -1, 0), (0, 0, -1)))
		camera.matrix_world = Matrix.Translation(GLTF @ (-(R.transposed() @ t))) @ (GLTF @ to_world).to_4x4()
		w, h = entry["size"]
		data = camera.data
		data.sensor_fit = "HORIZONTAL"
		data.sensor_width = 36.0
		data.lens = f * 36.0 / w
		data.clip_start, data.clip_end = 0.05, 2000.0
		scene.render.resolution_x, scene.render.resolution_y = width, round(width * h / w)
		scene.render.filepath = str(Path(outdir) / f"{entry['photo']}.png")
		bpy.ops.render.render(write_still=True)


main()
