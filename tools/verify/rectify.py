# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# Lays solved photos onto charts of the model's skin: each chart is an
# orthographic view of the model from one side (a side, the top, the bottom)
# at a fixed scale in source units, and each of its pixels takes the photo's
# pixel showing the same point of the skin, where the photo's camera sees it.
# A line or mark traced on a chart is then in the source's own coordinates,
# free of the photo's perspective, and every photo that sees it lands in the
# same place to be compared. Rendered in Cycles, the model posed as each
# photo has it: where each chart pixel lies on the skin, which way the skin
# faces there, and whether a point light at the photo's camera reaches it.
#
# usage: blender -b --factory-startup --python-exit-code 1 -P rectify.py -- CATALOGUE MODEL.glb POINTS.json CAMERAS.json CHARTS.json OUTDIR [PHOTO ...]
#
# CHARTS.json: {"charts": [{"name", "normal" (source vector toward the viewer),
# "up" (source vector, the chart's up), "box" ([[lo, hi]] per source
# coordinate: what the chart frames), "scale" (pixels per source unit)}]}.
# Writes OUTDIR/<chart>/chart.json (each pixel's source coordinates: the top
# left pixel's centre and the steps right and down, at the box's middle
# depth), OUTDIR/<chart>/place.npy (each pixel's point on the skin at rest,
# source coordinates, NaN off the model) and per photo
# OUTDIR/<chart>/<photo>.npz: grey (the photo's brightness 0..1, NaN unseen),
# facing (the cosine between the skin's normal and the way to the camera) and
# reach (the photo's pixels per chart pixel there), over the window of the
# chart the photo sees, its top left pixel at origin ([column, row]).
import json, math, sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
import camera as cam  # noqa: E402
import model as mod  # noqa: E402

GLTF = Matrix(((1, 0, 0), (0, 0, -1), (0, 1, 0)))   # a glTF (y up) vector in Blender's z-up frame
FACING = 0.15   # least cosine between the skin's normal and the way to the camera a sample keeps
HIDDEN = []   # objects no render shows (glass)
RESTS = {}   # each chart's place on the skin at rest
NORMALS = {}   # and the skin's normal there, glTF frame
MOVED = 2.5   # source units: a chart pixel whose skin stands further than this from where it rests shows a moved part (the wing bends 2.1 in at 1 g, which is kept)


def lookup(keys, x):
	if len(keys[0]) > 2:
		return tuple(lookup([[k[0], k[i]] for k in keys], x) for i in range(1, len(keys[0])))
	if x <= keys[0][0]:
		return keys[0][1]
	for (x0, y0), (x1, y1) in zip(keys, keys[1:]):
		if x <= x1:
			return y0 + (y1 - y0) * (x - x0) / (x1 - x0)
	return keys[-1][1]


def blender(frame, coordinates):
	# source coordinates to Blender's frame
	return GLTF @ Vector(frame.model(coordinates))


def direction(frame, vector):
	# a source direction in Blender's frame
	return (blender(frame, frame.origin + np.asarray(vector, float)) - blender(frame, frame.origin)).normalized()


def material(name, build):
	m = bpy.data.materials.new(name)
	m.use_nodes = True
	nodes, links = m.node_tree.nodes, m.node_tree.links
	nodes.clear()
	out = nodes.new("ShaderNodeOutputMaterial")
	links.new(build(nodes, links), out.inputs["Surface"])
	return m


def emitting(attribute):
	def build(nodes, links):
		geometry = nodes.new("ShaderNodeNewGeometry")
		emission = nodes.new("ShaderNodeEmission")
		links.new(geometry.outputs[attribute], emission.inputs["Color"])
		return emission.outputs["Emission"]
	return build


def diffuse(nodes, links):
	shader = nodes.new("ShaderNodeBsdfDiffuse")
	shader.inputs["Color"].default_value = (1, 1, 1, 1)
	return shader.outputs["BSDF"]


def rendered(scene, path):
	# Renders the scene to a float EXR and reads it back, rows from the top
	scene.render.filepath = str(path)
	bpy.ops.render.render(write_still=True)
	image = bpy.data.images.load(str(path))
	out = np.empty(len(image.pixels), np.float32)
	image.pixels.foreach_get(out)
	w, h = image.size
	bpy.data.images.remove(image)
	Path(path).unlink()
	return out.reshape(h, w, 4)[::-1]


def pose(joints, entry, rest):
	for name, (location, quaternion, hidden) in rest.items():
		obj = bpy.data.objects[name]
		obj.location, obj.rotation_mode, obj.rotation_quaternion, obj.hide_render = location, "QUATERNION", quaternion, hidden
	drives = mod.driven(joints, entry.get("pose", {}) if entry else {})
	for name, j in joints.items():
		obj = bpy.data.objects.get(name)
		if obj is None:
			continue
		keys = obj.data.shape_keys.key_blocks if getattr(obj.data, "shape_keys", None) else {}
		for key, morph in j.get("morphs", {}).items():
			if key in keys:
				keys[key].slider_min, keys[key].slider_max = -10.0, 10.0
				keys[key].value = lookup(morph["keys"], float(drives.get(morph["drive"], 0.0)))
		if j["motion"] == "morph":
			continue
		own = drives.get("joints", {})
		value = (tuple(own[name]) if isinstance(own[name], list) else float(own[name])) if name in own else lookup(j["keys"], float(drives.get(j["drive"], 0.0)))
		if j["motion"] == "show":
			obj.hide_render = value <= 0.5
			continue
		axis = GLTF @ Vector(j["axis"])
		if j["motion"] == "rotate":
			obj.rotation_quaternion = obj.rotation_quaternion @ Quaternion(axis, value)
		elif j["motion"] == "bend":
			obj.rotation_quaternion = obj.rotation_quaternion @ Quaternion(axis, value[0])
			obj.location += (GLTF @ Vector(j["direction"])).normalized() * value[1]
		else:
			obj.location += axis * value
	for obj in HIDDEN:
		obj.hide_render = True
	bpy.context.view_layer.update()


def chart_camera(scene, frame, chart):
	# An orthographic camera framing the chart's box from its normal side;
	# returns the chart's pixel grid in source coordinates
	normal, up = np.asarray(chart["normal"], float), np.asarray(chart["up"], float)
	normal, up = normal / np.linalg.norm(normal), up / np.linalg.norm(up)
	z, y = direction(frame, normal), direction(frame, up)
	x = y.cross(z)
	# the chart's right in source coordinates, from Blender's
	right = np.asarray(GLTF.transposed() @ x) @ frame.axes
	right /= np.linalg.norm(right)
	box = np.array(chart["box"], float)
	corners = np.array([[a, b, c] for a in box[0] for b in box[1] for c in box[2]])
	u, v, depth = corners @ right, corners @ up, corners @ normal
	pixel = 1.0 / chart["scale"]
	width, height = int(math.ceil((u.max() - u.min()) / pixel)), int(math.ceil((v.max() - v.min()) / pixel))
	middle = right * (u.max() + u.min()) / 2 + up * (v.max() + v.min()) / 2 + normal * (depth.max() + depth.min()) / 2
	margin = 0.1 * float(np.ptp(depth)) + 1
	far = normal * (np.ptp(depth) / 2 + margin)   # the camera stands outside the box
	camera = scene.camera
	camera.data.type = "ORTHO"
	camera.data.sensor_fit = "AUTO"
	camera.data.ortho_scale = max(width, height) * pixel * frame.unit
	camera.data.clip_start = 0.001
	camera.data.clip_end = (float(np.ptp(depth)) + 2 * margin) * frame.unit
	camera.matrix_world = Matrix.Translation(blender(frame, middle + far)) @ Matrix((x, y, z)).transposed().to_4x4()
	scene.render.resolution_x, scene.render.resolution_y = width, height
	origin = middle - right * pixel * (width / 2 - 0.5) + up * pixel * (height / 2 - 0.5)
	return {"origin": list(origin), "right": list(right * pixel), "down": list(-up * pixel), "size": [width, height], "normal": list(normal), "scale": chart["scale"]}


MARGIN = 16   # chart pixels round what a photo sees that its window renders too


def window(frame, rest, normals, camera, centre, size):
	# The chart pixels (rows r0:r1, columns c0:c1) whose skin at rest lands in
	# the photo facing its camera, with a margin, or None: a photo sees a part
	# of each chart, so only that part is rendered
	ys, xs = np.nonzero(np.isfinite(rest[..., 0]))
	points = frame.model(rest[ys, xs])
	pixels, depth = cam.project(camera, points, centre)
	towards = cam.eye(camera)[None] - points
	facing = (normals[ys, xs].astype(np.float64) * towards).sum(1) / np.maximum(np.linalg.norm(towards, axis=1), 1e-9)
	inside = (depth > 0) & (facing > FACING) & (pixels[:, 0] >= 0) & (pixels[:, 0] < size[0]) & (pixels[:, 1] >= 0) & (pixels[:, 1] < size[1])
	if not inside.any():
		return None
	h, w = rest.shape[:2]
	return (max(0, int(ys[inside].min()) - MARGIN), min(h, int(ys[inside].max()) + MARGIN + 1),
		max(0, int(xs[inside].min()) - MARGIN), min(w, int(xs[inside].max()) + MARGIN + 1))


def registered(frame, rendered_place, rest, r0, c0):
	# Where a window's render sits in the chart: the offset within a pixel of
	# (r0, c0) at which its places best match the chart's places at rest
	# (Blender rounds a render border to whole pixels its own way)
	h, w = rendered_place.shape[:2]
	on = rendered_place[..., 3] > 0.5
	ys, xs = np.nonzero(on)
	if not len(ys):
		return r0, c0
	pick = np.random.default_rng(0).choice(len(ys), min(20000, len(ys)), replace=False)
	ys, xs = ys[pick], xs[pick]
	places = frame.source(rendered_place[ys, xs, :3] @ np.asarray(GLTF.transposed(), np.float32).T)
	best, where = np.inf, (r0, c0)
	for dy in (-1, 0, 1):
		for dx in (-1, 0, 1):
			y, x = ys + r0 + dy, xs + c0 + dx
			ok = (y >= 0) & (y < rest.shape[0]) & (x >= 0) & (x < rest.shape[1])
			if not ok.any():
				continue
			d = np.linalg.norm(rest[y[ok], x[ok]] - places[ok], axis=1)
			miss = float(np.nanmedian(d)) if np.isfinite(d).any() else np.inf
			if miss < best:
				best, where = miss, (r0 + dy, c0 + dx)
	return where


def photo_grey(path):
	# The photo's brightness 0..1, rows from the top
	image = bpy.data.images.load(str(path))
	image.colorspace_settings.name = "Non-Color"
	out = np.empty(len(image.pixels), np.float32)
	image.pixels.foreach_get(out)
	w, h = image.size
	bpy.data.images.remove(image)
	rgba = out.reshape(h, w, 4)[::-1]
	return (0.2126 * rgba[..., 0] + 0.7152 * rgba[..., 1] + 0.0722 * rgba[..., 2]).astype(np.float32)


def sample(grey, pixels):
	# Bilinear brightness at pixels (N, 2), NaN outside the photo
	h, w = grey.shape
	x, y = pixels[:, 0] - 0.5, pixels[:, 1] - 0.5
	inside = (x >= 0) & (y >= 0) & (x < w - 1) & (y < h - 1)
	out = np.full(len(pixels), np.nan, np.float32)
	x0, y0 = x[inside].astype(int), y[inside].astype(int)
	fx, fy = x[inside] - x0, y[inside] - y0
	out[inside] = (grey[y0, x0] * (1 - fx) * (1 - fy) + grey[y0, x0 + 1] * fx * (1 - fy) + grey[y0 + 1, x0] * (1 - fx) * fy + grey[y0 + 1, x0 + 1] * fx * fy)
	return out


def main():
	args = sys.argv[sys.argv.index("--") + 1:]
	catalogue_path, model, points, cameras, charts_path, outdir = args[:6]
	only = args[6:]   # the photos to lay, in the order given (all, in the cameras file's order, when none)
	catalogue = json.loads(Path(catalogue_path).read_text())
	frame = mod.Frame(catalogue["frame"])
	references = Path(catalogue_path).resolve().parent / "references"
	entries = json.loads(Path(cameras).read_text())
	if only:
		entries = sorted((e for e in entries if e["photo"] in only), key=lambda e: only.index(e["photo"]))
	charts = json.loads(Path(charts_path).read_text())["charts"]
	bpy.ops.wm.read_factory_settings(use_empty=True)
	bpy.ops.import_scene.gltf(filepath=model)
	joints = mod.joints(json.loads(Path(points).read_text()))
	rest = {name: (obj.location.copy(), obj.rotation_quaternion.copy(), obj.hide_render)
		for name, obj in ((n, bpy.data.objects.get(n)) for n in joints) if obj is not None}
	for obj in rest:
		bpy.data.objects[obj].rotation_mode = "QUATERNION"
	scene = bpy.context.scene
	scene.render.engine = "CYCLES"
	scene.cycles.device = "CPU"
	scene.cycles.samples = 1
	scene.cycles.use_denoising = False
	scene.cycles.max_bounces = 0
	scene.cycles.filter_width = 0.01
	scene.cycles.use_light_tree = False
	scene.render.use_persistent_data = True
	scene.render.film_transparent = True
	scene.render.image_settings.file_format = "OPEN_EXR"
	scene.render.image_settings.color_depth = "32"
	scene.render.image_settings.exr_codec = "NONE"   # written and read back at once: compressing 300 MB maps took most of each render
	scene.render.image_settings.color_mode = "RGBA"
	scene.view_settings.view_transform = "Standard"
	world = bpy.data.worlds.new("black")
	world.use_nodes = True
	world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.0
	scene.world = world
	camera = bpy.data.objects.new("chart", bpy.data.cameras.new("chart"))
	scene.collection.objects.link(camera)
	scene.camera = camera
	light = bpy.data.objects.new("lamp", bpy.data.lights.new("lamp", "POINT"))
	light.data.energy = 1e7
	light.data.shadow_soft_size = 0.0
	scene.collection.objects.link(light)
	# glass lets the photo see through it: hidden from every render
	HIDDEN.extend(obj for obj in scene.objects if obj.type == "MESH" and any(s.material and "glass" in s.material.name for s in obj.material_slots))
	place, normal, lit = material("place", emitting("Position")), material("normal", emitting("Normal")), material("lit", diffuse)
	layer = bpy.context.view_layer
	work = Path(outdir)
	for chart in charts:
		folder = work / chart["name"]
		folder.mkdir(parents=True, exist_ok=True)
		grid = chart_camera(scene, frame, chart)
		(folder / "chart.json").write_text(json.dumps(grid, indent="\t"))
		scene.render.use_border = False
		pose(joints, None, rest)
		light.hide_render = True
		layer.material_override = place
		at_rest = rendered(scene, folder / "place.exr")
		on = at_rest[..., 3] > 0.5
		where = np.full(on.shape + (3,), np.nan, np.float32)
		where[on] = frame.source(at_rest[on][:, :3] @ np.asarray(GLTF.transposed(), np.float32).T)
		del at_rest
		np.save(folder / "place.npy", where)
		RESTS[chart["name"]] = where
		layer.material_override = normal
		turned = rendered(scene, folder / "normal.exr")
		NORMALS[chart["name"]] = (turned[..., :3] @ np.asarray(GLTF.transposed(), np.float32).T).astype(np.float16)   # glTF frame
		del turned
		print(f"{chart['name']}: {grid['size'][0]} x {grid['size'][1]}, {int(np.isfinite(where[..., 0]).sum())} pixels on the model", flush=True)
	for entry in entries:
		grey = photo_grey(references / entry["file"])
		eye = cam.eye(np.array(entry["camera"], float))
		light.location = GLTF @ Vector(eye)
		centre = np.array(entry["size"], float) / 2
		for chart in charts:
			folder = work / chart["name"]
			# a camera behind the chart's middle sees none of it
			box = np.array(chart["box"], float)
			if (frame.source(eye) - box.mean(1)) @ np.asarray(chart["normal"], float) <= 0:
				continue
			chart_camera(scene, frame, chart)
			rested = RESTS[chart["name"]]
			win = window(frame, rested, NORMALS[chart["name"]], np.array(entry["camera"], float), centre, entry["size"])
			if win is None:
				continue
			r0, r1, c0, c1 = win
			H, W = rested.shape[:2]
			scene.render.use_border, scene.render.use_crop_to_border = True, True
			scene.render.border_min_x, scene.render.border_max_x = c0 / W, c1 / W
			scene.render.border_min_y, scene.render.border_max_y = 1 - r1 / H, 1 - r0 / H
			pose(joints, entry, rest)
			light.hide_render = True
			layer.material_override = place
			p = rendered(scene, folder / "p.exr")
			y0, x0 = registered(frame, p, rested, r0, c0)
			rested = rested[y0:y0 + p.shape[0], x0:x0 + p.shape[1]]
			if rested.shape[:2] != p.shape[:2]:
				raise SystemExit(f"{entry['photo']} on {chart['name']}: the window's render {p.shape[:2]} runs past the chart at {(y0, x0)}")
			layer.material_override = normal
			n = rendered(scene, folder / "n.exr")
			light.hide_render = False
			layer.material_override = lit
			seen = rendered(scene, folder / "l.exr")[..., 0] > 0
			on = p[..., 3] > 0.5
			# only the pixels on the model, in the glTF frame
			to = np.asarray(GLTF.transposed(), np.float32)
			points = p[on][:, :3] @ to.T
			normals = n[on][:, :3] @ to.T
			del p, n
			pixels, depth = cam.project(np.array(entry["camera"], float), points, centre)
			# a pixel showing a part moved from its rest (the gear down, a door
			# or surface open, a store hung) is no part of the chart
			still = np.linalg.norm(frame.source(points) - rested[on], axis=1) < MOVED
			towards = eye[None].astype(np.float32) - points
			towards /= np.maximum(np.linalg.norm(towards, axis=1, keepdims=True), 1e-9)
			facing = (normals * towards).sum(1)
			del towards, normals, points
			keep = seen[on] & (facing > FACING) & (depth > 0) & still
			shape = on.shape
			value, face, reach = (np.full(shape, np.nan, np.float32) for _ in range(3))
			value[on] = np.where(keep, sample(grey, pixels), np.nan)
			face[on] = np.where(keep, facing, np.nan)
			# the photo's pixels per chart pixel: how far apart two neighbouring
			# chart pixels land in the photo
			px = np.full(shape + (2,), np.nan, np.float32)
			px[on] = pixels
			del pixels
			step = np.zeros(shape, np.float32)
			for axis in (0, 1):
				d = np.diff(px, axis=axis, append=np.nan)
				step = np.fmax(step, np.sqrt((d ** 2).sum(-1)))
				del d
			reach[on] = np.where(keep, step[on], np.nan)
			del px, step
			np.savez_compressed(folder / f"{entry['photo']}.npz", grey=value.astype(np.float16), facing=face.astype(np.float16), reach=reach.astype(np.float16), origin=np.array([x0, y0]))
			print(f"{entry['photo']} on {chart['name']}: {int(np.isfinite(value).sum())} pixels seen, median reach {np.nanmedian(reach) if keep.any() else 0:.2f}, window {value.shape[1]} x {value.shape[0]} at {x0}, {y0} (registered {x0 - c0:+d}, {y0 - r0:+d})", flush=True)
		del grey


main()
