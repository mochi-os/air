# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# Photogrammetry for the checks: a pinhole camera with square pixels, its
# principal point at the image's centre and one radial distortion term; a
# camera solved from known points; and a bundle adjustment that solves every
# photo's camera and every marked point at once, from points whose source
# coordinates are cited (priors, any of their three coordinates) and points
# nothing cites, which it measures. All in the model frame, metres. numpy only.
#
# A camera is 8 numbers: focal length in pixels, rotation (axis times angle),
# translation, and k1. Camera coordinates: x right, y down, z forward.
import math

import numpy as np


def rotation(v):
	angle = float(np.linalg.norm(v))
	if angle < 1e-12:
		return np.eye(3)
	k = np.asarray(v, float) / angle
	K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
	return np.eye(3) + math.sin(angle) * K + (1 - math.cos(angle)) * K @ K


def vector(R):
	# A rotation matrix back to axis times angle
	angle = math.acos(max(-1.0, min(1.0, (np.trace(R) - 1) / 2)))
	if angle < 1e-9:
		return np.zeros(3)
	if math.pi - angle < 1e-6:
		# half turn: the axis is the eigenvector of the largest diagonal entry
		i = int(np.argmax(np.diag(R)))
		axis = (R[:, i] + np.eye(3)[:, i]) / math.sqrt(2 * (1 + R[i, i]))
		return axis / np.linalg.norm(axis) * angle
	axis = np.array([R[2, 1] - R[1, 2], R[0, 2] - R[2, 0], R[1, 0] - R[0, 1]]) / (2 * math.sin(angle))
	return axis * angle


def project(camera, points, centre):
	# Pixels (N, 2) and depths (N,) of model-frame points
	f, R, t = camera[0], rotation(camera[1:4]), camera[4:7]
	k1 = camera[7] if len(camera) > 7 else 0.0
	c = np.asarray(points, float) @ R.T + t
	x, y = c[:, 0] / c[:, 2], c[:, 1] / c[:, 2]
	s = 1 + k1 * (x * x + y * y)
	return np.stack([centre[0] + f * x * s, centre[1] + f * y * s], -1), c[:, 2]


def undistort(camera, pixels, centre):
	# Pixels as an ideal pinhole would see them (k1 removed): normalised
	# image coordinates (N, 2)
	f = camera[0]
	k1 = camera[7] if len(camera) > 7 else 0.0
	d = (np.asarray(pixels, float) - centre) / f
	x = d.copy()
	for _ in range(20):
		x = d / (1 + k1 * (x ** 2).sum(-1, keepdims=True))
	return x


def eye(camera):
	return -rotation(camera[1:4]).T @ camera[4:7]


def ray(camera, pixel, centre):
	# The model-frame direction through a pixel
	x = undistort(camera, [pixel], centre)[0]
	d = rotation(camera[1:4]).T @ np.array([x[0], x[1], 1.0])
	return d / np.linalg.norm(d)


def cast(camera, pixel, centre, normal, offset):
	# Where a pixel's ray meets the plane normal . p = offset
	o, d = eye(camera), ray(camera, pixel, centre)
	return o + d * (offset - normal @ o) / (normal @ d)


def looking(position, target, focal):
	# A level camera (model y up) at position, aimed at target
	forward = (target - position) / np.linalg.norm(target - position)
	right = np.cross(forward, [0.0, 1.0, 0.0])
	if np.linalg.norm(right) < 1e-6:
		right = np.cross(forward, [1.0, 0.0, 0.0])
	right /= np.linalg.norm(right)
	down = np.cross(forward, right)
	R = np.array([right, down, forward])
	return np.concatenate([[focal], vector(R), -R @ position, [0.0]])


def robust(r, k):
	# Cauchy's loss as a residual: quadratic near zero, its pull fading for
	# gross errors, so one mis-click cannot drag a point the other photos agree
	# on (Huber's linear tail still compromises when the photos' scales differ)
	return np.sign(r) * k * np.sqrt(np.log1p((r / k) ** 2))




def levenberg(residual, params, free, iterations=100, tolerance=1e-10, valid=None):
	# Minimises |residual(params)|^2 over the free indices, numeric Jacobian
	params = np.array(params, float)
	free = np.asarray(free)
	error = residual(params)
	damping = 1e-3
	for _ in range(iterations):
		J = np.empty((len(error), len(free)))
		for k, i in enumerate(free):
			step = 1e-6 * max(1.0, abs(params[i]))
			trial = params.copy()
			trial[i] += step
			J[:, k] = (residual(trial) - error) / step
		A, g = J.T @ J, J.T @ error
		improved = False
		while damping < 1e12:
			delta = np.linalg.solve(A + damping * (np.diag(np.diag(A)) + 1e-9 * np.eye(len(free))), g)
			trial = params.copy()
			trial[free] -= delta
			if valid is None or valid(trial):
				trial_error = residual(trial)
				if trial_error @ trial_error < error @ error:
					gain = error @ error - trial_error @ trial_error
					params, error, damping = trial, trial_error, max(damping / 3, 1e-12)
					improved = True
					break
			damping *= 4
		if not improved or gain < tolerance * max(1.0, error @ error):
			break
	return params, error


def starts(points, width):
	# Level and tilted cameras all round the points at a few distances,
	# aimed at their middle
	target = points.mean(0)
	size = max(float(np.linalg.norm(points - target, axis=1).max()), 0.5)
	for distance in (1.5, 4.0, 10.0, 30.0):
		for elevation in (-55, -15, 15, 55):
			for azimuth in range(0, 360, 30):
				a, e = math.radians(azimuth), math.radians(elevation)
				position = target + size * distance * np.array([math.cos(a) * math.cos(e), math.sin(e), math.sin(a) * math.cos(e)])
				yield looking(position, target, width * distance / 2)


def solve(points, pixels, centre, width, distortion=False):
	# A camera from known points and where they fall: the best of many
	# starts. Returns (camera, residuals (N, 2))
	points, pixels = np.asarray(points, float), np.asarray(pixels, float)

	def residual(c):
		p, _ = project(c, points, centre)
		return (p - pixels).ravel()

	def valid(c):
		return c[0] > 0 and (project(c, points, centre)[1] > 0).all()

	best = None
	for guess in starts(points, width):
		if not valid(guess):
			continue
		c, e = levenberg(residual, guess, range(7), iterations=60, valid=valid)
		cost = e @ e
		if best is None or cost < best[0]:
			best = (cost, c)
	if best is None:
		raise ValueError("no camera sees every point")
	c = best[1]
	c, e = levenberg(residual, c, range(8) if distortion else range(7), iterations=200, valid=valid)
	return c, e.reshape(-1, 2)


def triangulate(cameras, pixels, centres, constraints=()):
	# A point from two or more views, and any planes it lies on
	# (constraints: (normal, offset, weight)), by linear least squares
	rows, values = [], []
	for camera, pixel, centre in zip(cameras, pixels, centres):
		x = undistort(camera, [pixel], centre)[0]
		R, t = rotation(camera[1:4]), camera[4:7]
		for i, v in enumerate(x):
			rows.append(v * R[2] - R[i])
			values.append(t[i] - v * t[2])
	for normal, offset, weight in constraints:
		rows.append(np.asarray(normal) * weight)
		values.append(offset * weight)
	A, b = np.array(rows), np.array(values)
	return np.linalg.lstsq(A, b, rcond=None)[0]


class Bundle:
	# Photos' cameras and points solved together.
	#   photos  [{"centre": (cx, cy), "marks": {point: (u, v)}, "camera": 8 numbers or None,
	#             "distortion": bool, "sigma": pixels, "focal": (pixels, sigma of its log) or None}]
	#           a photo without a focal prior is held to a field of view between 1 and
	#           100 degrees, so one with few marks cannot run off to an infinitely
	#           distant, infinitely long lens; k1 is held near zero (sigma 0.1)
	#   points  {name: {"priors": [(normal, offset, sigma metres)], "value": xyz or None}}
	#           a point whose priors fix all three coordinates with sigma 0 is held fixed
	#   mirror  (matrix, [(left name, right name)]): each pair solved as one point and its image
	# After solve(): spread {point: 3x3 covariance over its fixed directions} and
	# loose {point: (k, 3) unit directions nothing fixes, empty for most}
	def __init__(self, photos, points, mirror=None):
		self.photos, self.points = photos, points
		self.reflect = np.eye(3)
		self.twin = {}
		if mirror:
			self.reflect = np.asarray(mirror[0], float)
			for left, right in mirror[1]:
				if left in points and right in points:
					self.twin[left] = right

	def fixed(self, name):
		priors = self.points[name]["priors"]
		return len(priors) >= 3 and all(s == 0 for _, _, s in priors) and np.linalg.matrix_rank(np.array([n for n, _, _ in priors])) == 3

	def fixed_value(self, name):
		priors = self.points[name]["priors"]
		return np.linalg.solve(np.array([n for n, _, _ in priors[:3]]), np.array([o for _, o, _ in priors[:3]]))

	def initialise(self, log=print):
		# Cameras from fixed and fully-cited points, then points from those
		# cameras, then cameras from points, until nothing more starts
		known = {}
		for name in self.points:
			if self.fixed(name):
				known[name] = self.fixed_value(name)
			elif len(self.points[name]["priors"]) >= 3 and np.linalg.matrix_rank(np.array([n for n, _, _ in self.points[name]["priors"]])) == 3:
				priors = self.points[name]["priors"]
				A = np.array([n for n, _, _ in priors])
				b = np.array([o for _, o, _ in priors])
				known[name] = np.linalg.lstsq(A, b, rcond=None)[0]
		for name, p in self.points.items():
			if p.get("value") is not None:
				known.setdefault(name, np.asarray(p["value"], float))
		changed = True
		while changed:
			changed = False
			for k, photo in enumerate(self.photos):
				if photo.get("camera") is not None:
					continue
				seen = [n for n in photo["marks"] if n in known]
				if len(seen) >= 4:
					c, e = solve([known[n] for n in seen], [photo["marks"][n] for n in seen], photo["centre"], photo["width"])
					photo["camera"] = c
					changed = True
					log(f"start: photo {k} from {len(seen)} points, rms {math.sqrt((e ** 2).sum(1).mean()):.1f} px")
			for name, p in self.points.items():
				if name in known:
					continue
				views = [ph for ph in self.photos if ph.get("camera") is not None and name in ph["marks"]]
				twin = self.twin.get(name) or next((l for l, r in self.twin.items() if r == name), None)
				constraints = [(n, o, 1.0) for n, o, _ in p["priors"]]
				if len(views) * 2 + len(constraints) >= 3 and (len(views) >= 2 or (views and constraints)):
					known[name] = triangulate([v["camera"] for v in views], [v["marks"][name] for v in views], [v["centre"] for v in views], constraints)
					changed = True
				elif twin in known and twin is not None:
					known[name] = self.reflect @ known[twin]
					changed = True
		self.known = known
		missing = [k for k, ph in enumerate(self.photos) if ph.get("camera") is None]
		return missing

	def layout(self):
		# Which numbers vary: each started photo's camera (7 or 8), and each
		# point not held fixed (pairs as one)
		slots, at = [], 0
		self.camera_slot = {}
		for k, photo in enumerate(self.photos):
			if photo.get("camera") is None:
				continue
			width = 8 if photo.get("distortion") else 7
			self.camera_slot[k] = (at, width)
			at += width
		self.point_slot = {}
		for name in self.points:
			if name not in self.known or self.fixed(name) or name in self.twin:
				continue
			self.point_slot[name] = at
			at += 3
		return at

	def unpack(self, x):
		cameras = {}
		for k, (at, width) in self.camera_slot.items():
			c = np.zeros(8)
			c[:width] = x[at : at + width]
			cameras[k] = c
		points = {}
		for name in self.known:
			if self.fixed(name):
				points[name] = self.fixed_value(name)
			elif name in self.point_slot:
				points[name] = x[self.point_slot[name] : self.point_slot[name] + 3]
		for left, right in self.twin.items():
			if right in points:
				points[left] = self.reflect @ points[right]
		return cameras, points

	def residuals(self, x, k=None):
		cameras, points = self.unpack(x)
		out = []
		for i, photo in cameras.items():
			ph = self.photos[i]
			names = [n for n in ph["marks"] if n in points]
			if not names:
				continue
			p, _ = project(photo, np.array([points[n] for n in names]), ph["centre"])
			r = ((p - np.array([ph["marks"][n] for n in names])) / ph["sigma"]).ravel()
			out.append(robust(r, k) if k else r)
		for name, p in points.items():
			for normal, offset, sigma in self.points[name]["priors"]:
				if sigma > 0:
					out.append(np.array([(normal @ p - offset) / sigma]))
		for i, photo in cameras.items():
			f = max(photo[0], 1e-9)
			if self.focal[i]:
				focal, sigma = self.focal[i]
				out.append(np.array([math.log(f / focal) / sigma]))
			else:
				low, high = self.band[i]
				out.append(np.array([min(0.0, math.log(f / low)) / 0.05 + max(0.0, math.log(f / high)) / 0.05]))
			out.append(np.array([photo[7] / 0.1]))
		return np.concatenate(out) if out else np.zeros(0)

	def solve(self, iterations=60, robustness=10.0):
		# robustness: the Cauchy scale in sigmas. Wide enough that a camera a
		# dozen pixels out stays in the quadratic zone and is pulled in; a
		# mis-click of a hundred sigmas still barely pulls
		x = np.zeros(self.layout())
		self.focal = {k: tuple(self.photos[k]["focal"]) if self.photos[k].get("focal") else None for k in self.camera_slot}
		self.band = {k: (self.photos[k]["width"] / 2 / math.tan(math.radians(50)), self.photos[k]["width"] / 2 / math.tan(math.radians(0.5))) for k in self.camera_slot}
		for k, (at, width) in self.camera_slot.items():
			x[at : at + width] = self.photos[k]["camera"][:width]
		for name, at in self.point_slot.items():
			x[at : at + 3] = self.known[name]

		def valid(x):
			cameras, points = self.unpack(x)
			for i, c in cameras.items():
				if c[0] <= 0:
					return False
				names = [n for n in self.photos[i]["marks"] if n in points]
				if names and (project(c, np.array([points[n] for n in names]), self.photos[i]["centre"])[1] <= 0).any():
					return False
			return True

		x, _ = levenberg(lambda v: self.residuals(v, robustness), x, range(len(x)), iterations=iterations, valid=valid)
		self.x = x
		self.cameras, self.solved = self.unpack(x)
		# Each point's uncertainty from the normal equations, scaled by how
		# well the marks fit
		error = self.residuals(x)
		J = np.empty((len(error), len(x)))
		for i in range(len(x)):
			step = 1e-6 * max(1.0, abs(x[i]))
			trial = x.copy()
			trial[i] += step
			J[:, i] = (self.residuals(trial) - error) / step
		dof = max(1, len(error) - len(x))
		scale = float(error @ error) / dof
		# The normal equations scaled to a unit diagonal, so pixels, radians and
		# metres compare. A direction they leave unfixed (a point seen by one
		# photo moves freely along that camera's ray) is loose, not certain: the
		# solve leaves such a point anywhere along it, so its spread covers only
		# the fixed directions and loose names the rest
		A = J.T @ J
		d = np.sqrt(np.diag(A))
		d[d == 0] = 1.0
		w, V = np.linalg.eigh(A / np.outer(d, d))
		null = w < 1e-9 * max(float(w.max()), 1e-300)
		fixed = V[:, ~null]
		cov = (fixed / w[~null]) @ fixed.T / np.outer(d, d) * max(scale, 1.0)
		free = V[:, null] / d[:, None]
		free /= np.maximum(np.linalg.norm(free, axis=0), 1e-300)
		self.spread, self.loose = {}, {}
		for name, at in self.point_slot.items():
			self.spread[name] = cov[at : at + 3, at : at + 3]
			u, s, _ = np.linalg.svd(free[at : at + 3], full_matrices=False)
			self.loose[name] = u[:, s > 0.1].T
		for left, right in self.twin.items():
			if right in self.spread:
				self.spread[left] = self.reflect @ self.spread[right] @ self.reflect.T
				self.loose[left] = self.loose[right] @ self.reflect.T
		return self.cameras, self.solved

	def misses(self):
		# Each mark's miss: {photo index: {point: (du, dv, depth metres)}}
		out = {}
		for i, c in self.cameras.items():
			ph = self.photos[i]
			names = [n for n in ph["marks"] if n in self.solved]
			if not names:
				continue
			p, depth = project(c, np.array([self.solved[n] for n in names]), ph["centre"])
			out[i] = {n: (float(q[0] - ph["marks"][n][0]), float(q[1] - ph["marks"][n][1]), float(d)) for n, q, d in zip(names, p, depth)}
		return out
