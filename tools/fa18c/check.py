# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# The facts check (air-fa18c.md, Verification; verify/README.md step 2):
# measures the built model back against every entry in facts.json, posed where
# the fact needs it (gear down for heights, wings folded for the folded span),
# and fails any measurement outside its tolerance. The build reads these facts,
# but its lofts, blends and fractions can still land somewhere else; this is
# what catches it. Every facts.json entry is either measured here or listed in
# EXEMPT with the reason (not geometry, or not built yet), so a new fact cannot
# go unchecked.
#
# usage: python3 -I check.py MODEL.glb MODEL.json [--only GROUP[,GROUP...]] [--json]
# --only runs just the groups named, each by the fact its guard reports under
# (overall, layout, layout.gear, layout.motion, paint, ...; a name several groups
# share runs them all), and skips the rest unrun; it answers for no fact outside
# them, so it reports no unaccounted or stale entries, and a name no group has
# fails the run, listing the groups
import json, math, re, subprocess, sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "verify"))   # run with -I, which leaves the script's own folder off the path
import model as verify  # noqa: E402

FACTS = json.loads((HERE / "facts.json").read_text())
FRAME = verify.Frame({"names": ["station", "waterline", "buttline"], "unit": 0.0254, "origin": [456, 105, 0],
	"axes": [[-1, 0, 0], [0, 1, 0], [0, 0, 1]], "mirror": "buttline"})
WING = ["wing_inner_{s}", "wing_outer_{s}", "flap_leading_inner_{s}", "flap_leading_outer_{s}", "flap_trailing_{s}", "aileron_{s}"]

# Entries the check does not measure, and why
PAINTED = {"layout.stencils"}   # facts only the paint's atlas shows

# A shape no source shows is asked about, never guessed: every facts.json
# text saying it is guessed (verify's GUESS words: "by eye", "estimated",
# "not measured", "unseen" and the like) is listed here with the user's
# sign-off (its path, how many guesses the text held when they signed it, the
# date and what they approved), or test_check fails; a text that gains a
# guess fails again until it is signed again
GUESSES = {
	"layout.wells.note": (1, "user, 2026-11-16: as recommended: the speedbrake well's floor 9.5 in under the skin, as deep as its stowed actuator and hose need; the three photos of it open look up at it from ahead, its inside hidden by the panel"),
	"layout.paint.where": (1, "user, 2026-11-13: the speedbrake's and the probe's wells keep the airframe's greys; the refuelling photos show the probe's bay only in deep shadow; user, 2026-11-16: the speedbrake's well's inside hidden by its open panel in the three photos that show it open"),
	"layout.aoa.note": (2, "user, 2026-11-18: the AoA probe's flange 0.1 in thick, the photo seeing its face obliquely, and the profile's last two diameters (0.4 in at 3.0 in out, 0.28 at 3.45), read by eye where the column reads blur, signed off as estimated"),
	"layout.nacelle.cheek.slot.note": (1, "user, 2026-11-17: the cheek box's slot's depth estimated as its width along the jet (3.5 in), its floor in shadow in every photo that sees into it; 2026-11-18: sunk inboard, its walls level, its floor up to 1.4 in inside the nacelle's side line, the station running on inside the side round it"),
	"layout.nacelle.cheek.section.note": (1, "user, 2026-11-18: the cheek station's section between the measured lines estimated: the box's top corner rounded over 0.15 in, its top meeting the nacelle's skin turned 30 deg into it, the fairing over the box flattening onto its top below 2 in of height, the curve from the face's top to the skin with end slopes 0.4 of its chord, the block's face on the face's plane up to the box's top's height, the fairing over the box leaving its foot upright, the bottom corner rounded as the front edge's 0.45 in band, and the ramp's sections the front edge's scaled to its line and drawn in"),
	"layout.nacelle.cheek.sweep.note": (1, "user, 2026-11-18: the cheek box's aft face sweeping from the skin out to the aft edge on a quarter ellipse, leaving the skin along it, the face rounding into it over its last 1.5 in, the edge at least 0.1 in thick; dvids9393266 shows the aft face only as a band of shade softening forward"),
	"layout.inlet.duct.note": (3, "user, 2026-11-17: the duct's path and area between the mouth and the engine face, fitted for room over the stowed main gear; user, 2026-11-19: its section at FS 460 raised 2.5 in for the refitted side brace's knee; the F404 hub's 5 in radius and 7 in length; the engine's axis level, the face's centre at the nozzles' waterline"),
	"layout.pitot.note": (1,"user, 2026-11-17: the pitot strut 0.5 in thick at its root and 0.35 at the tube, a symmetric section; every photo sees its face, none its edge, and it is under an inch, as the blades' 0.4"),
	"layout.nacelle.cheek.note": (1, "user, 2026-11-17: the cheek box's front below its photographed top corner, which the LAU-116's fitting and the round hide in both photos that show it, unseen; 2026-11-18: the block's face runs on into the box's there, one loft"),
	"layout.stores.lau116.hooks.note": (1, "user, 2026-11-17: the LAU-116's hooks built as each hanger's footprint running up into the airframe; the round hides them closed in every photo of a loaded station, and dvids9393257's shadow hints the forward one stands about 1.5 in lower"),
	"layout.speedbrake.note": (2, "user, 2026-11-16: as recommended: the speedbrake's actuator built as the narrow member the photos show under the panel, its foot's pin, its lug under the panel and the hose's ends placed to stand as the photos show them, their tops hidden in every view, and two stages to reach (29.8 to 64.0 in pin to pin); the panel turned about the point its photographed corners solve, nothing drawn there, what holds its forward edge shown by no photo"),
	"layout.stores.centreline.note": (2, "user, 2026-11-11: the SUU-62's width 9.5 in with its 7 in taper, consistent with dvids8025511, 9393257 and 9393262 but fixed by none; its aft end at FS 445, shaped as dvids_4642578 shows"),
	"layout.stores.rack.note": (1, "user, 2026-11-11: keep the 3 in block joining each side rail to its LAU-115 until a solvable photo shows the shoulder fittings (dvids7378817 shows them, but no landmark lets its camera be solved)"),
	"layout.stores.rails.tip.note": (1, "user, 2026-11-11: keep the LAU-7 channel 1.0 in deep; no public-domain end view of an empty LAU-7 was found"),
	"layout.stores.rails.tip.adapter.note": (1, "user's ruling, 2026-11-11: the lower housing and the fairing's underside mirror the upper side about the rail (dvids_7440917, dvids_7847377)"),
	"layout.strips.where": (1, "user's ruling, 2026-11-11: the strip under the tip rail held at the upper strip's buttlines, the mirror of the upper housing"),
	"layout.stores.rails.tip.across": (1, "user, 2026-11-12: the wingtip LAU-7's cap and cone take their measured standing shares across the rail too; every view from above has a round on the rail hiding the ends and no photo of an empty rail from below was found"),
	"layout.antennas.note": (3, "user, 2026-11-12: keep, under an inch and not seen at close range: the blades' thickness (0.4 in, as the nose blade's) and the comb posts' size"),
	"layout.blade.note": (1, "user, 2026-11-12: keep, under an inch and not seen at close range: the nose blade's thickness"),
	"layout.blisters.note": (1, "user, 2026-11-12: keep, under an inch and not seen at close range: how far the nose antenna blisters stand proud, in the ECM cover's proportion"),
	"layout.strips.note": (1, "user, 2026-11-12: keep, under an inch and not seen at close range: the formation strips' width, the nose strip's measured 1.7 in"),
	"layout.lights.gear.where": (1, "user, 2026-11-12: keep, under an inch and not seen at close range: the landing light box's facing angle"),
	"layout.keel.note": (1, "user, 2026-11-12: keep; no photo can see it: the keel's forward end, rising to the body over FS 589-619 under the jet"),
	"layout.nacelle.where": (1, "user, 2026-11-12: keep; no photo can see it: the nacelles' inboard sides in the tunnel, the section's own curve"),
	"layout.panels.note": (1, "user, 2026-11-12: keep; no photo can see it: the spine panel joints' tops, continued over the crown"),
	"layout.stores.pylon.note": (1, "user, 2026-11-12: keep; no photo can see it: the wing pylons' trailing edges rising to the wing"),
	"layout.petals.where": (1, "user, 2026-11-12: keep; no photo can see it: the divergent flaps' length (nothing of known size at their depth)"),
	"layout.petals.note": (1, "user, 2026-11-12: keep; no photo can see it: the divergent flaps' length"),
	"layout.paint.note": (1, "user, 2026-11-12: keep; no photo can see it: the nozzle's divergent flap faces, convergent flaps and duct colours, in shadow in every photo"),
	"layout.motion.fold.note": (1, "user, 2026-11-12: keep the wing fold's 8 s; NATOPS gives no time"),
	"layout.motion.swing.note": (2, "user, 2026-11-12: keep the hook's 20 deg sideways travel each way; NATOPS 2.10.5 gives no figure; user, 2026-11-13: the swing's rate 40 deg/s both ways (0.5 s from centre to either stop), the game's and the model viewer's alike"),
	"layout.motion.bar.note": (2, "user, 2026-11-12: keep the launch bar's 1.25 s swing; NATOPS gives no time; user, 2026-11-14: the bar folds down along the post's front as the leg retracts, as far as the post and fork let it (no photo shows it in transit; raised it would stow through the cockpit floor)"),
	"layout.motion.stroke.note": (1, "user, 2026-11-15: the gear's legs and doors stroke at a steady speed between short cushioned ends, in place of an ease over the whole stroke that left the main wheels standing flat in the open bays; the ramps' 15% share of the stroke time is Claude's estimate"),
	"layout.motion.doors.note": (1, "user, 2026-11-12: keep the gear doors opening over the first 15% of the gear's travel; NATOPS gives only that every door stays open with the gear down"),
	"layout.motion.hook.note": (1, "user, 2026-11-12: keep the hook's 2 s stroke, within NATOPS's 3 s down and 6 s up maxima"),
	"layout.motion.probe.note": (3, "user, 2026-11-16: as recommended: the probe's root, on which the door rides, 2.5 in behind the door's aft edge (2-3 in), so that edge rises as it swings out aft; no photo shows the root; user, 2026-11-17: the forward door opening over the stroke's first 0.15 while the probe waits, and closing over as long once the probe is clear of it"),
	"layout.probe.note": (2, "user, 2026-11-16: as recommended: the skin opened ahead of the probe door to FS 129, half an inch ahead of the stowed nozzle's tip; user, 2026-11-17: the panel ahead of the probe door over FS 129-145 a door of its own, opening while the nozzle passes and closed at rest and with the probe out, as dvids6690145 shows; its hinge and timing estimated"),
	"layout.motion.canopy.note": (2, "user, 2026-11-16: as recommended: the canopy's shell 0.2 in proud of the loft, a visible step at the sill and the aft joint, and its slide rising 0.15 in over the 1.5 in aft, the least that clear the skin it rests on; its hinge at the aft top (FS 326, WL 152.6), whose place the photos do not tell apart"),
	"layout.hook.note": (3, "user, 2026-11-16 and 2026-11-18: the hook's hold-down rod estimated from the proportions in US Navy 050124-N-4308O-018 (no solved camera) scaled to the solved shank (user, 2026-11-16: as recommended); the point's body as long as it is wide with its 3.5 in flare, the shoe's 5.0 in reach, dished sole and 0.35 in recess, the bolts 0.9 in ahead of the face, the forging's web and socket, the damper's lengths (cylinder 2.5 + 5.8 in, piston 7.7 in, rod end 1.6 in) and the keel's aft end turning with the sideways swing, signed off as estimated (user, 2026-11-18)"),
	"layout.motion.extension.note": (1, "user, 2026-11-16: the mains' start, hidden behind the camera jet's own nose tyres in DVIDS 781086, taken with the nose leg's once the doors are open"),
	"layout.motion.braces.note": (6, "user, 2026-11-16: the main side brace's foot's clevis's lower end crossing the open inner door and the bay's edge at gear 0.375-0.45 kept, a known crossing; user, 2026-11-16: the main side brace's foot's clevis, spool, nut and end built from dvids8678626 alone, the bolt's lean across the sight line and the lugs' width round it estimated; user, 2026-11-16: the main side brace's fork at its bolt with 0.4 in cheeks, which no photo shows edge on; user, 2026-11-12: the nose drag brace's 6 in reach into its tube at full stretch kept; user, 2026-11-14: the drag brace rebuilt to the photos as the actuator they show, the hidden rod dropped; user, 2026-11-13: the main side brace's pin at WL 78 and its knee halfway (user, 2026-11-14: moved up off halfway, to 0.57, clear of the open inner door and the post), the connecting link's pin at WL 82, the bell crank's pin at WL 56 with its 6 in arm on a bracket off the pivot boss, and the link's 1.8 in diameter, placed for room and signed off from the retraction renders; user, 2026-11-19: the main side brace refitted with its knee where dvids4642471 shows it, its structure pin re-placed for room (FS 462.0, WL 80.2, BL 24.2) and the boss's length along its pin and the spring's length into the bay estimated"),
	"layout.scoop.note": (1, "user, 2026-11-12: the FCS ram air scoop's can 4.8 in long, a 12 oz can's height from the maintainers' name for it, and its red the gear doors' edges' red in dvids8678626; no photo shows it deployed"),
	"layout.motion.scoop.note": (2, "user, 2026-11-12: the FCS ram air scoop hinged at its cap's aft edge, swinging 90 deg in 1 s until its mouth faces forward; no photo shows it deployed"),
	"layout.gear.note": (13, "user, 2026-11-16: the nose holdback folding evenly with the oleo's stroke from out to standing, its fold between estimated; user, 2026-11-16: the main pivot nut's 0.8 in thickness; the nose post's eye rings' 0.6 in stock; the nose post's port wiring, read by eye; user, 2026-11-16: the main wheels' 0.6 in web, their holes' 2 in reach, the cap plate's 0.2 in thickness and the sidewall widest 0.45 of the way to the tread; the main lower casting's 1 in pocket over half its length; the nose leg's two hydraulic hoses, their bearings, the waterline they leave the bay at and their fittings, read by eye; user, 2026-11-14: the main shock turning about the boss dvids8678626 shows where it meets the skin, its white upper cylinder running on up its line into the bay as far as the piston's travel needs, so the 12 in stroke and the approach photos' droop hold with the eye where three solved photos put it; user, 2026-11-14: the planing rod riding the arm from a pin on the pivot's axis to the axle's fitting"),
	"layout.motion.stowed.note": (2, "user, 2026-11-13: the main gear as the source has its mechanism (no turn about the post, the shrink link, the axle's quarter turn) in a bay as deep as that needs; user, 2026-11-14: the trunnion axis, swing and axle turn fitted to the take-off photos, the bay deepened to WL 107.4 and out to BL 42.7 to hold it, the stowed wheel left 27.8 deg off flat"),
	"layout.eye.note": (1, "user, 2026-11-12: keep; no photo can see it: the design eye on the pilot's helmet in the reference photo"),
	"layout.cockpit.note": (1, "user, 2026-11-12: keep; no photo can see it: the simple cockpit's tub, panel and pilot's limbs, seen only through the canopy and replaced in first person"),
}

EXEMPT = {
	"overall.span.missiles": "needs the wingtip launchers and missiles (step 5, stores)",
	"nose.junction": "the radome's joint is a paint line, not a shape",
	"fittings.probe": "the research jet's probe doors (FS 128.5 to 188); the reference airframe's door is shorter (layout.probe, checked there)",
	"lex.hardware": "the fleet fence's lengths (top 27.9 in) disagree with tp3111's model fence (22.58 in); the photos' top corners (layout.lex) stand 23.8 in apart, so the build follows tp3111 and the photos",
	"model.scale": "the wind-tunnel model's scale, not a dimension",
	"reference.gravity": "a moment reference, not a shape",
	"reference.station": "a moment reference; checked through reference.leading and reference.chord",
	"surfaces.lef.ground": "a flap schedule the engine applies",
	"surfaces.lef.fixed": "a flap schedule the engine applies",
	"surfaces.lef.check": "a flap schedule the engine applies",
	"surfaces.lef.differential": "a flap schedule the engine applies",
	"surfaces.tef.half": "a flap schedule the engine applies",
	"surfaces.tef.full": "a flap schedule the engine applies",
	"surfaces.droop.half": "a flap schedule the engine applies",
	"surfaces.droop.full": "a flap schedule the engine applies",
	"surfaces.trim": "a trim setting the engine applies",
	"surfaces.limits": "motion limits stay in code (Contract)",
	"datum.waterline": "the frame's definition",
	"datum.buttline": "the frame's definition",
	"datum.apex": "the frame's definition; checked through nose.apex",
	"wing.aspect": "checked through wing.root, wing.tip and the span",
	"wing.taper": "checked through wing.root and wing.tip",
	"wing.incidence": "no twist is published; checked as a flat chord plane through layout.wing's anhedral",
	"wing.dihedral": "cr201687's -3 deg: the photos put the tips about 5 in higher, so the build takes layout.wing's anhedral, checked there",
	"wing.chord": "checked through reference.chord",
	"fin.rudder": "cr201687's area; the rudders' outline is the photos' (layout.rudder, checked there), 6% larger",
	"engine.thrust": "where the flight model applies thrust, not a shape",
	"canopy": "the two-seat canopy's differences; this is the single-seat jet",
	"gravity@HARV phase 1, 60% fuel, clean, gear up": "a centre of gravity, not a shape",
	"gravity@HARV phases 2-3, 60% fuel, clean, gear up": "a centre of gravity, not a shape",
	"gravity@HARV simulation": "a centre of gravity, not a shape",
	"gravity@F-18B SRA, 66% fuel, clean, gear up": "a centre of gravity, not a shape",
	"layout.eye": "the design eye is a point the build writes as given",
	"layout.hardpoints": "store mounts the build writes as given, the fuselage ones draped onto the skin (shape.mount); step 5 checks them against the stores",
	"layout.paint": "colours the paint bake writes into the atlas, not a shape (looked at on the comparison sheets)",
	"stores.bru32.length": "the rack inside the pylon: not built",
	"stores.lau116.length": "the LAU-116's body inside the nacelle behind its shut bay: not built; its exposed block and hooks are layout.stores.lau116's, checked there",
	"stores.lau116.width": "the LAU-116's body inside the nacelle behind its shut bay: not built; its exposed block and hooks are layout.stores.lau116's, checked there",
	"stores.lau116.height": "the LAU-116's body inside the nacelle behind its shut bay: not built; its exposed block and hooks are layout.stores.lau116's, checked there",
	"stores.bru32.hooks": "where the rack hangs the LAU-115: the build places it on them (step 5c)",
	"stores.lau115.rails": "which rail carries which missile, not a shape",
	"stores.tank.capacity": "a fuel capacity, not a shape: the tank's size is the photos' (layout.stores.tank)",
}


def value(entry):
	return entry["value"] if isinstance(entry, dict) and "value" in entry else entry


def entries(facts):
	# Every entry a check must account for: dicts that cite a source, list
	# items that do, and layout's placements
	out = []

	def walk(o, path):
		if isinstance(o, dict):
			if "source" in o or (path.startswith("layout.") and path.count(".") == 1):
				out.append(path)
				return
			for k, v in o.items():
				if k not in ("about", "note", "where", "also", "unit"):
					walk(v, f"{path}.{k}" if path else k)
		elif isinstance(o, list):
			for item in o:
				if isinstance(item, dict) and "source" in item:
					out.append(f"{path}@{item.get('aircraft', item.get('station'))}")

	walk(facts, "")
	return out


def leading_sweep(quarter, aspect, taper):
	return math.degrees(math.atan(math.tan(math.radians(quarter)) + (4 / aspect) * 0.25 * (1 - taper) / (1 + taper)))


def hidden(glb, points):
	# The model's triangles no view can see, per part, [triangles, square
	# inches]: inside or against another part that moves with it, as
	# ../hidden.py judges them in Blender (the build removes them with it)
	run = subprocess.run(["blender", "-b", "--factory-startup", "--python-exit-code", "1", "-P", str(HERE.parent / "hidden.py"), "--", str(glb), str(points)],
		capture_output=True, text=True)
	line = next((l for l in run.stdout.splitlines() if l.startswith("hidden ")), None)
	if run.returncode or line is None:
		raise RuntimeError(run.stdout[-2000:] + run.stderr[-2000:])
	return json.loads(line[len("hidden ") :])


class Jet:
	def __init__(self, glb, points):
		self.path = glb
		self.file = points
		self.model = verify.Model(glb)
		self.document = json.loads(Path(points).read_text())
		self.joints = verify.joints(self.document)
		self.cache = {}

	def parts(self, drives=None):
		# Every part, posed. The fuselage is the skin as the checks measure it:
		# each opening closed by the skin its door was cut from (plugs())
		key = tuple(sorted((drives or {}).items()))
		if key not in self.cache:
			parts = self.model.parts(verify.pose(self.joints, drives or {}))
			if "fuselage" in parts:
				parts = {**parts, "fuselage": np.concatenate([parts["fuselage"], self.plugs()])}
			self.cache[key] = parts
		return self.cache[key]

	def opened(self):
		# the fuselage as built, its openings open, at rest
		return self.model.parts(verify.pose(self.joints, {}))["fuselage"]

	def plugs(self, names=None):
		# The skin under each closed door (build.py wells() cuts it away, as
		# cut() copied it for the door): the door's outer face at rest moved
		# back in by the PROUD it stands off (none, but the probe's doors). A door is its outer face, its
		# inner face a quarter inch under it, and an edge square to both round
		# its outline: an outer face is turned to the door's side (down, or up
		# for the speedbrake's and the probe's), and a ray in from it meets the
		# door again within 0.4 in, where one in from its edge crosses the
		# whole door. Model frame
		if "plugs" not in self.cache:
			rest = self.model.parts(verify.pose(self.joints, {}))
			up = np.array([0.0, 1.0, 0.0]) @ FRAME.axes.T
			out = {}
			for name, below in FLUSH:
				if name not in rest:
					continue
				t = rest[name]
				n = np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0])
				n /= np.linalg.norm(n, axis=1)[:, None]
				side = np.flatnonzero((n @ up) * (-1 if below else 1) > 0)
				reach = np.array([inward(t, t[k].mean(0), -n[k]) for k in side])
				outer = side[reach < 0.4 * FRAME.unit]
				# moved back along each corner's normal, its faces' mean, as cut()
				# moved the skin out, so neighbouring faces stay joined
				key = lambda v: tuple(np.round(v, 7))
				normals = {}
				for tri, m in zip(t[outer], n[outer]):
					for v in tri:
						normals.setdefault(key(v), []).append(m)
				normals = {k: np.mean(v, 0) / np.linalg.norm(np.mean(v, 0)) for k, v in normals.items()}
				moved = np.array([[v - normals[key(v)] * PROUD.get(name, 0.0) * FRAME.unit for v in tri] for tri in t[outer]]).reshape(-1, 3, 3)
				out[name] = (t[outer], moved)
			self.cache["plugs"] = out
		chosen = [v[1] for k, v in self.cache["plugs"].items() if names is None or k in names]
		return np.concatenate(chosen) if chosen else np.zeros((0, 3, 3))

	def faces(self, name):
		# a door's outer face at rest, as built (model frame)
		self.plugs()
		return self.cache["plugs"][name][0]

	def shaded(self, name):
		# a part's triangles at rest as exported, its openings open, and each
		# corner's normal (model frame)
		i = self.model.index[name]
		mesh, W = self.model.nodes[i]["mesh"], self.model.rest[i]
		normals = self.model.normals[mesh]
		if any(n is None for n in normals):
			raise KeyError(f"{name}'s normals")
		tris = np.concatenate([t for t, _ in self.model.meshes[mesh]])
		return tris @ W[:3, :3].T + W[:3, 3], np.concatenate(normals) @ W[:3, :3].T

	def has(self, *names):
		return all(n in self.parts() for n in names)

	def tris(self, names, drives=None):
		parts = self.parts(drives)
		chosen = [parts[n] for n in names if n in parts]
		if not names:
			raise KeyError("not built: no parts asked for")
		if len(chosen) != len(names):
			raise KeyError(f"not built: {sorted(set(names) - set(parts))}")
		return np.concatenate(chosen)

	def textured(self, materials=("paint", "team"), names=None, drives=None):
		# The painted triangles at rest (or posed by drives), in stations,
		# waterlines and buttlines, with their corners' UVs: (triangles (N, 3,
		# 3), UVs (N, 3, 2)); of the named parts alone if names are given
		worlds = self.model.worlds(verify.pose(self.joints, drives) if drives else {})
		tris, uvs = [], []
		for i, n in enumerate(self.model.nodes):
			if n["mesh"] is None or i not in worlds or (names is not None and n["name"] not in names):
				continue
			W = worlds[i]
			for (t, material), uv in zip(self.model.meshes[n["mesh"]], self.model.uvs[n["mesh"]]):
				if uv is not None and material in materials:
					tris.append(FRAME.source((t @ W[:3, :3].T + W[:3, 3]).reshape(-1, 3)).reshape(-1, 3, 3))
					uvs.append(uv)
		if not tris:
			raise KeyError("no painted triangles with UVs")
		return np.concatenate(tris), np.concatenate(uvs)

	def points(self, names, drives=None):
		# every corner, in stations, waterlines and buttlines
		return FRAME.source(self.tris(names, drives).reshape(-1, 3))

	def cut(self, names, point, normal, drives=None):
		# a plane given in source coordinates (point, normal), crossing points in source coordinates
		segments = verify.cut(self.tris(names, drives), FRAME.model(point), FRAME.axes @ np.asarray(normal, float))
		return FRAME.source(segments.reshape(-1, 3))

	def hinge(self, name):
		i = self.model.index[name]
		return FRAME.source(self.model.rest[i][:3, 3])


def loops(segments, tolerance=1e-6):
	# Chains a cut's segments (M, 2, D) into closed loops
	segments = [tuple(map(tuple, s)) for s in segments]
	ends = {}
	for k, (a, b) in enumerate(segments):
		for p in (a, b):
			ends.setdefault(tuple(np.round(p, 5)), []).append(k)
	used, out = set(), []
	for start in range(len(segments)):
		if start in used:
			continue
		used.add(start)
		loop = [segments[start][0], segments[start][1]]
		while True:
			key = tuple(np.round(loop[-1], 5))
			nxt = next((k for k in ends.get(key, []) if k not in used), None)
			if nxt is None:
				break
			used.add(nxt)
			a, b = segments[nxt]
			loop.append(b if tuple(np.round(a, 5)) == key else a)
		# and back from its first segment, which may lie part way along it
		while True:
			key = tuple(np.round(loop[0], 5))
			nxt = next((k for k in ends.get(key, []) if k not in used), None)
			if nxt is None:
				break
			used.add(nxt)
			a, b = segments[nxt]
			loop.insert(0, b if tuple(np.round(a, 5)) == key else a)
		out.append(np.array(loop))
	return out


def held(segments, centre, across, up):
	# The largest closed loop of a cut's segments (M, 2, 3) that holds
	# `centre`, in the cut's plane by its `across` and `up` directions: (its
	# points as [across, up] about the centre, its area), or None
	best = None
	for loop in loops(segments):
		x, y = (loop - centre) @ across, (loop - centre) @ up
		area = 0.5 * abs(float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))))
		# the centre inside it: a ray from it along `across` crosses it an odd number of times
		crossings = sum(1 for i in range(len(x)) if (y[i] > 0) != (y[i - 1] > 0) and x[i - 1] + (x[i] - x[i - 1]) * (0 - y[i - 1]) / (y[i] - y[i - 1]) > 0)
		if crossings % 2 and (best is None or area > best[1]):
			best = (np.c_[x, y], area)
	return best


def steepest(jet, names, origin, axis, across, up, stations):
	# The steepest change along a line of the named parts' section round it
	# (held(), cut square to it at each of the evenly spaced `stations` along
	# it from `origin`, source coordinates), in inches of its equivalent radius
	# (a circle's of its area) an inch: a casting flaring from one section to
	# another changes gently, one part butted on another steps
	radii = []
	for s in stations:
		best = held(jet.cut(names, origin + axis * s, axis).reshape(-1, 2, 3), origin + axis * s, across, up)
		if best is None:
			raise KeyError(f"no section of {', '.join(names)} round its line {s:.1f} in along it")
		radii.append(math.sqrt(best[1] / math.pi))
	return float(np.abs(np.diff(radii)).max() / (stations[1] - stations[0]))


def area_within(tris, origin, axis, lo, hi):
	# The area of the triangles ((N, 3, 3), source coordinates) whose middles
	# lie between lo and hi along a line from origin
	s = (tris.mean(1) - origin) @ axis
	t = tris[(s > lo) & (s < hi)]
	return float(np.linalg.norm(np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0]), axis=1).sum() / 2)


def corners(outline, turn=20.0):
	# How many corners a closed outline ([x, y] points, its first repeated
	# last or not) turns through by more than `turn` degrees, the points along
	# its sides (a cut's segments meet there) passed over
	flat = np.asarray(outline, float)
	flat = flat[:-1] if np.allclose(flat[0], flat[-1]) else flat
	edges = np.roll(flat, -1, 0) - flat
	edges = edges[np.linalg.norm(edges, axis=1) > 1e-6]
	heading = np.arctan2(edges[:, 1], edges[:, 0])
	return int((np.abs(np.angle(np.exp(1j * (np.roll(heading, -1) - heading)))) > math.radians(turn)).sum())


def heights(tris, stations, buttlines, tilt=False):
	# A top-down height map: the highest waterline of the triangles (source
	# coordinates, (N, 3, 3)) over each (buttline, station) cell, NaN where
	# none. With tilt, also each cell's cosine of the slope of the triangle
	# that gives its height
	H = np.full((len(buttlines), len(stations)), np.nan)
	C = np.full_like(H, np.nan)
	s0, b0 = stations[0], buttlines[0]
	ds, db = stations[1] - stations[0], buttlines[1] - buttlines[0]
	keep = (tris[..., 0].max(1) >= stations[0]) & (tris[..., 0].min(1) <= stations[-1]) & (tris[..., 2].max(1) >= buttlines[0]) & (tris[..., 2].min(1) <= buttlines[-1])
	for t in tris[keep]:
		a, b, c = t[:, [0, 2]]
		i0 = max(int(np.floor((min(a[0], b[0], c[0]) - s0) / ds)), 0)
		i1 = min(int(np.ceil((max(a[0], b[0], c[0]) - s0) / ds)), len(stations) - 1)
		j0 = max(int(np.floor((min(a[1], b[1], c[1]) - b0) / db)), 0)
		j1 = min(int(np.ceil((max(a[1], b[1], c[1]) - b0) / db)), len(buttlines) - 1)
		if i1 < i0 or j1 < j0:
			continue
		gx, gy = np.meshgrid(stations[i0 : i1 + 1], buttlines[j0 : j1 + 1])
		v0, v1 = b - a, c - a
		d = v0[0] * v1[1] - v0[1] * v1[0]
		if abs(d) < 1e-12:
			continue
		px, py = gx - a[0], gy - a[1]
		u = (px * v1[1] - py * v1[0]) / d
		v = (v0[0] * py - v0[1] * px) / d
		inside = (u >= -1e-9) & (v >= -1e-9) & (u + v <= 1 + 1e-9)
		h = t[0, 1] + u * (t[1, 1] - t[0, 1]) + v * (t[2, 1] - t[0, 1])
		sub = H[j0 : j1 + 1, i0 : i1 + 1]
		take = inside & ~(sub >= h)
		H[j0 : j1 + 1, i0 : i1 + 1] = np.where(take, h, sub)
		if tilt:
			n = np.cross(t[1] - t[0], t[2] - t[0])
			C[j0 : j1 + 1, i0 : i1 + 1] = np.where(take, abs(n[1]) / np.linalg.norm(n), C[j0 : j1 + 1, i0 : i1 + 1])
	return (H, C) if tilt else H


def shoelace(loop):
	# a closed 2D loop's area
	x, y = loop[:, 0], loop[:, 1]
	return abs((x[:-1] * y[1:] - x[1:] * y[:-1]).sum()) / 2


# The airframe's closed shells, the parts that must lie inside them at rest
# (stowed, or under the canopy), and the panels that lie flush on the skin
# with the side they face
HULL = ["fuselage", "lex_left", "lex_right", "inlet_left", "inlet_right", "wing_inner_left", "wing_inner_right", "canopy", "windscreen",
	"fin_left", "fin_right",
	# and the parts on the skin, where the hidden faces under them are gone
	"fairings_left", "fairings_right", "fin_root_left", "fin_root_right", "fin_fairing_left", "fin_fairing_right", "keel", "fairing_cheek_left", "fairing_cheek_right",
	"antenna_chin", "antenna_dome", "antenna_dorsal", "antenna_spine", "antenna_ventral", "blade_nose", "aoa_left", "aoa_right",
	"pitot_left", "pitot_right", "splitter_left", "splitter_right", "lex_fence_left", "lex_fence_right",
	"formation_body_left", "formation_body_right", "formation_fin_left", "formation_fin_right", "formation_left", "formation_right",
	"formation_tip_left", "formation_tip_right", "formation_undertip_left", "formation_undertip_right"]
STOWED = [f"gear_{leg}_{piece}" for leg in ("left", "right", "nose") for piece in ("strut", "oleo", "wheel")] + [
	f"gear_{leg}_{piece}" for leg in ("left", "right") for piece in ("axle", "shock", "shock_can", "brace", "brace_upper", "brace_fittings", "spool", "link", "crank", "casting")] + ["gear_nose_brace", "gear_nose_brace_rod", "gear_nose_holdback"] + [
	"launch_bar", "gear_nose_lamps", "gear_nose_block", "lamp_gear_nose", "lamp_approach_green", "lamp_approach_amber", "lamp_approach_red", "probe",
	"speedbrake_actuator", "speedbrake_actuator_middle", "speedbrake_actuator_inner", "speedbrake_hose", "speedbrake_lug", "cockpit_tub", "cockpit_panel", "cockpit_seat", "cockpit_stick", "cockpit_hud", "pilot"]
# how far a door's outer face stands off the skin it was cut from (build.py
# cut(): on it, flush; the probe's doors, a loft over the skin's rings, 0.15
# in off), and its inner face, or a well's wall's foot, inside it (UNDER)
PROUD = {"probe_door": 0.15, "probe_door_forward": 0.15}
UNDER = 0.1
FLUSH = [("speedbrake", False), ("gear_nose_door_left", True), ("gear_nose_door_right", True), ("gear_nose_door_long", True), ("gear_nose_door_brace", True),
	("gear_door_inner_left", True), ("gear_door_inner_right", True), ("gear_door_strip_left", True), ("gear_door_strip_right", True), ("gear_door_outer_left", True), ("gear_door_outer_right", True), ("probe_door", False), ("probe_door_forward", False)]
# The parts with no twin that stand to one side; every other one is
# symmetric about the centreline
# a store part's name, its station and its side of a twin (the contract's Stores)
STATION = re.compile(r"^((?:pylon|rack|rail|launcher|ejector|tank))_([1-9])([ab]?)$")
ONE_SIDED = {"antenna_dome", "antenna_ventral", "gear_nose_door_long", "gear_nose_lamps", "gear_nose_block", "lamp_gear_nose", "lamp_approach_green", "lamp_approach_amber", "lamp_approach_red", "lamp_position_tail", "pilot", "probe", "probe_door", "probe_door_forward", "scoop", "speedbrake_hose", "well_probe"}
# Each well (layout.wells): the doors that close its opening and the parts it
# holds at rest
WELLS = {f"main_{side}": ([f"gear_door_{d}_{side}" for d in ("inner", "strip", "outer")], [f"gear_{side}_{p}" for p in ("strut", "oleo", "wheel", "axle", "shock", "shock_can", "brace", "brace_upper", "brace_fittings", "spool", "link", "crank", "casting", "rod")]) for side in ("left", "right")}
WELLS["nose"] = (["gear_nose_door_left", "gear_nose_door_right", "gear_nose_door_long", "gear_nose_door_brace"], ["gear_nose_strut", "gear_nose_oleo", "gear_nose_wheel", "gear_nose_brace", "gear_nose_brace_rod",
	"gear_nose_lamps", "gear_nose_block", "lamp_gear_nose", "lamp_approach_green", "lamp_approach_amber", "lamp_approach_red", "launch_bar", "gear_nose_holdback"])
WELLS["speedbrake"] = (["speedbrake"], ["speedbrake_actuator", "speedbrake_actuator_middle", "speedbrake_actuator_inner", "speedbrake_hose", "speedbrake_lug"])
WELLS["probe"] = (["probe_door", "probe_door_forward"], ["probe"])
# The gear's parts that meet by design, neither carrying the other: a side
# brace's foot on its bolt, a connecting link's end on its bell crank's pin,
# the spool on the clevis's lugs and the brace's foot in the spool's block,
# the bell crank's boss on its bracket and the bracket and the trailing arm
# both on the arm's pivot boss, the shock absorber's can on its eye at the
# arm's end where the axle's stub begins, the nose drag brace's eye on the
# web's pin, the nose block on the post, the nose lamps' lenses in their
# housing, the speedbrake actuator's eye on its lug's pin, the hook's
# hold-down damper on its trunnion in the keel's pivot fitting and the skin
# and its piston in its cylinder, the fitting, which turns with the hook's
# swing, up inside the skin (clearance(): each seat taken stowed, the swing's
# at a stop)
JOINED = [(f"gear_{side}_{a}", f"gear_{side}_{b}") for side in ("left", "right") for a, b in (("casting", "brace"), ("casting", "spool"), ("spool", "brace"), ("crank", "link"), ("casting", "crank"),
	("casting", "oleo"), ("shock_can", "oleo"), ("shock_can", "axle"))] + [("gear_nose_strut", "gear_nose_brace_rod"), ("gear_nose_strut", "gear_nose_block")] + [
	("gear_nose_lamps", lens) for lens in ("lamp_gear_nose", "lamp_approach_green", "lamp_approach_amber", "lamp_approach_red")] + [
	("speedbrake_lug", "speedbrake_actuator_inner")] + [("hook_rod", "hook_swing"), ("hook_rod", "fuselage"), ("hook_rod", "hook_piston"),
	("hook_piston", "hook_swing"), ("hook_piston", "fuselage"), ("hook_swing", "fuselage")]
# designed contacts whose crossing stays put in the named part's frame rather
# than the moving part's: the hook's damper's piston sliding in its cylinder,
# out through the skin and its pivot fitting (clearance())
SEATED = {frozenset(("hook_rod", "hook_piston")): "hook_rod", frozenset(("hook_piston", "fuselage")): "fuselage", frozenset(("hook_piston", "hook_swing")): "hook_swing"}
# how far a moving part's surface stands back from what it passes, in: each
# is pulled in by this before the crossings are sought (clearance())
SEAM = 0.1
# the steepest a casting's section may grow or shrink along it, in of its
# equivalent radius (the radius of a circle of its area) an inch: the hook's
# point flaring from its shank into its body (layout.hook head)
FLARE = 0.5
# Crossings signed off as hidden inside a main bay (user, 2026-11-14): the main
# shock absorber's white upper cylinder runs on up its line past its pin, the
# boss where it meets the skin, into the bay as far as its piston's travel
# needs, and the connecting link beside it passes through that hidden part;
# only above the pin, each pair's crossings in the shock's own frame
OVERLAPS = {frozenset((f"gear_{side}_{a}", f"gear_{side}_link")): f"gear_{side}_shock" for side in ("left", "right") for a in ("shock", "shock_can")}
# A crossing signed off on the main leg's path (user, 2026-11-16, layout.motion
# braces): the side brace's foot's clevis, from its lower lug down the bolt to
# the end (layout.motion braces side foot), passes through the open inner door
# and the skin at the bay's edge mid-stroke. Only those points of the casting
# count as its, by how far down the foot's bolt they lie, along the spool's own
# line
FOOTED = {frozenset((f"gear_{side}_casting", other)): f"gear_{side}_spool" for side in ("left", "right") for other in (f"gear_door_inner_{side}", "fuselage")}
# how far from its hinge line a door's crossings of the skin round it are the
# hinge's own (its fittings, and the relief the skin is cut back by): the
# inner main doors turn about axes 1-2 in inside the skin (layout.gear doors),
# and the forward door's inboard edge, cast from the views from below, lies
# inboard of its fitted axis (2.3 in at the front corner, 0.3 at the aft), so
# that edge turns through the belly 2.0-2.4 in from the axis (FS 470-499)
HINGE = 2.5


def enclosed(points, tris):
	# Whether each point (N, 3) is enclosed by the triangles (M, 3, 3): a ray
	# along each axis, both ways, meets one of them
	out = np.ones(len(points), bool)
	lo, hi = tris.min(1), tris.max(1)
	for axis in range(3):
		u, v = [i for i in range(3) if i != axis]
		# the triangles that can lie across this part's rays at all
		box = (lo[:, u] <= points[:, u].max()) & (hi[:, u] >= points[:, u].min()) & (lo[:, v] <= points[:, v].max()) & (hi[:, v] >= points[:, v].min())
		t, tl, th = tris[box], lo[box], hi[box]
		a, b, c = t[:, 0], t[:, 1], t[:, 2]
		d = (b[:, u] - a[:, u]) * (c[:, v] - a[:, v]) - (c[:, u] - a[:, u]) * (b[:, v] - a[:, v])
		flat = np.abs(d) < 1e-12
		d = np.where(flat, 1, d)
		for k, p in enumerate(points):
			if not out[k]:
				continue
			near = ~flat & (tl[:, u] <= p[u]) & (th[:, u] >= p[u]) & (tl[:, v] <= p[v]) & (th[:, v] >= p[v])
			if not near.any():
				out[k] = False
				continue
			an, bn, cn, dn = a[near], b[near], c[near], d[near]
			s = ((p[u] - an[:, u]) * (cn[:, v] - an[:, v]) - (cn[:, u] - an[:, u]) * (p[v] - an[:, v])) / dn
			r = ((bn[:, u] - an[:, u]) * (p[v] - an[:, v]) - (p[u] - an[:, u]) * (bn[:, v] - an[:, v])) / dn
			inside = (s >= 0) & (r >= 0) & (s + r <= 1)
			depth = an[:, axis] + s * (bn[:, axis] - an[:, axis]) + r * (cn[:, axis] - an[:, axis]) - p[axis]
			out[k] = (inside & (depth > 0)).any() and (inside & (depth < 0)).any()
	return out


# Oblique rays, none along an axis or in a plane the builds' faces lie in
OBLIQUE = np.array([[0.577, 0.601, 0.552], [-0.432, 0.742, -0.513], [0.811, -0.322, 0.488], [-0.263, -0.579, 0.772],
	[0.659, 0.207, -0.723], [-0.705, -0.461, -0.539], [0.134, -0.911, -0.390]])


def crossed(point, tris):
	# Whether a point lies inside closed triangles (source coordinates): an
	# odd count of crossings along most of the oblique rays
	a, b, c = tris[:, 0], tris[:, 1], tris[:, 2]
	e1, e2 = b - a, c - a
	odd = 0
	for d in OBLIQUE / np.linalg.norm(OBLIQUE, axis=1)[:, None]:
		q = np.cross(d, e2)
		det = (e1 * q).sum(1)
		ok = np.abs(det) > 1e-12
		inv = np.where(ok, 1 / np.where(ok, det, 1), 0)
		s = point - a
		u = (s * q).sum(1) * inv
		w = np.cross(s, e1)
		v = (w @ d) * inv
		t = (e2 * w).sum(1) * inv
		odd += int((ok & (u >= 0) & (v >= 0) & (u + v <= 1) & (t > 0)).sum()) % 2
	return odd > len(OBLIQUE) // 2


def inward(tris, origin, direction):
	# How far a ray from a point goes before it leaves through one of the
	# triangles turned along it, within 25 deg (Moller-Trumbore, a hair's
	# tolerance at their edges so a ray down a shared edge counts); inf if none
	a, b, c = tris[:, 0], tris[:, 1], tris[:, 2]
	e1, e2 = b - a, c - a
	n = np.cross(e1, e2)
	along = (n @ direction) > 0.9 * np.linalg.norm(n, axis=1)
	p = np.cross(direction, e2)
	det = (e1 * p).sum(1)
	ok = (np.abs(det) > 1e-15) & along
	inv = np.where(ok, 1 / np.where(ok, det, 1), 0)
	s = origin - a
	u = (s * p).sum(1) * inv
	q = np.cross(s, e1)
	v = (q @ direction) * inv
	d = (e2 * q).sum(1) * inv
	hit = ok & (u >= -1e-6) & (v >= -1e-6) & (u + v <= 1 + 1e-6) & (d > 1e-7)
	return float(d[hit].min()) if hit.any() else np.inf


def outline(jet, name, normals=False):
	# A closed door's outline moved back to the skin it was cut from: its
	# outer face's edges no other face of it shares, every quarter inch along
	# them, moved in as plugs() moves its corners; not where two of its
	# panels, cut from the skin one by one, meet (the door goes on past the
	# edge there: just across it from its own face lies another of its
	# faces). Model frame; with `normals`, also the outward normal of the
	# face each point's edge bounds, in source coordinates
	t, moved = jet.faces(name), jet.plugs([name])
	key = lambda v: tuple(np.round(v, 7))
	back = {key(v): w for tri, shifted in zip(t, moved) for v, w in zip(tri, shifted)}
	count, owner = {}, {}
	for k_, tri in enumerate(t):
		for i in range(3):
			e = tuple(sorted((key(tri[i]), key(tri[(i + 1) % 3]))))
			count[e] = count.get(e, 0) + 1
			owner[e] = k_
	faces_ = FRAME.source(t.reshape(-1, 3)).reshape(-1, 3, 3)
	facing = outward(faces_)
	points, across, ups = [], [], []
	for e, k in count.items():
		if k != 1:
			continue
		a, b = back[e[0]], back[e[1]]
		a_, b_ = FRAME.source(np.array([e[0], e[1]]))
		face = faces_[owner[e]]
		away = np.cross(b_ - a_, np.cross(face[1] - face[0], face[2] - face[0]))
		away /= np.linalg.norm(away)
		if away @ (face.mean(0) - (a_ + b_) / 2) > 0:
			away = -away
		steps = max(1, int(np.ceil(np.linalg.norm(b - a) / (0.25 * FRAME.unit))))
		for f in np.linspace(0, 1, steps + 1):
			points.append(a + (b - a) * f)
			across.append(a_ + (b_ - a_) * f + away * 0.05)
			ups.append(facing[owner[e]])
	if not points:
		raise ValueError(f"{name} has no outline")
	kept = closest(np.array(across), faces_) >= 0.02
	points, ups = np.array(points)[kept], np.array(ups)[kept]
	if not len(points):
		raise ValueError(f"{name} has no outline")
	return (points, ups) if normals else points


def rim(jet, name):
	# How far a closed door's outline, moved back to the skin it was cut
	# from, stands off what closes the skin round it, at its furthest, in
	# inches: the skin as built, and where it borders another door, that
	# door's closed face moved back the same way
	points = outline(jet, name)
	skin = np.concatenate([jet.opened(), jet.plugs([n for n, _ in FLUSH if n != name])])
	lo, hi = points.min(0) - 0.05, points.max(0) + 0.05
	skin = skin[((skin.max(1) >= lo) & (skin.min(1) <= hi)).all(1)]
	return float(closest(FRAME.source(points), FRAME.source(skin.reshape(-1, 3)).reshape(-1, 3, 3)).max())


def depths(jet, name, finish):
	# How deep each corner of a door's faces in a finish lies under its
	# outer face at rest, inches
	t = jet.model.parts(verify.pose(jet.joints, {}), materials=(finish,)).get(name)
	if t is None or not len(t):
		raise KeyError(f"{name} has no faces in {finish}")
	face = FRAME.source(jet.faces(name).reshape(-1, 3)).reshape(-1, 3, 3)
	return closest(FRAME.source(t.reshape(-1, 3)), face)


def stacked(jet, doors):
	# How many points on each door's closed face, its faces' middles and
	# halfway to their corners, more than 0.15 in in from its outline (where
	# neighbours meet), have another of the doors' closed faces on them: two
	# doors cut from one band of skin lie on each other
	count = 0
	for d in doors:
		t = FRAME.source(jet.plugs([d]).reshape(-1, 3)).reshape(-1, 3, 3)
		middle = t.mean(1)
		own = np.concatenate([middle[:, None, :], (middle[:, None, :] + t) / 2], 1).reshape(-1, 3)
		line = FRAME.source(outline(jet, d))
		own = own[np.array([np.linalg.norm(line - p, axis=1).min() for p in own]) > 0.15]
		others = jet.plugs([o for o in doors if o != d])
		if len(own) and len(others):
			count += int((closest(own, FRAME.source(others.reshape(-1, 3)).reshape(-1, 3, 3)) < 0.01).sum())
	return count


# The parts that lie against each other's skin, each pair seen from above,
# below and outboard: where two lie within half an inch of each other, one
# stays on top
SEAMS = [("inlet", "fuselage"), ("lex", "fuselage"), ("lex", "inlet"), ("lex", "wing_inner"), ("wing_inner", "fuselage"), ("flap_leading_inner", "lex")]


def seam(a, b, every, view, step=0.5, near=0.5):
	# The area (square inches) where two parts (triangles, source coordinates)
	# lying within `near` of each other cross back and forth, seen from a view
	# ("above", "below", "outboard" on the right): over their overlap, where
	# either is the outermost of `every` part, two cells in from its edge
	# (where they meet or cross along a line), the cells in which the one
	# mostly beneath stands on top. A near-level crossing shows as a ragged
	# line; one hidden beneath another part, or one crossing steeply, does not
	axes = [0, 2, 1] if view == "outboard" else [0, 1, 2]
	flip = -1.0 if view == "below" else 1.0

	def seen(tris):
		t = tris[..., axes].copy()
		t[..., 1] *= flip
		return t

	a, b, every = seen(a), seen(b), seen(every)
	lo = np.maximum(a.reshape(-1, 3).min(0), b.reshape(-1, 3).min(0))
	hi = np.minimum(a.reshape(-1, 3).max(0), b.reshape(-1, 3).max(0))
	if (hi[[0, 2]] - lo[[0, 2]] < 2 * step).any():
		return 0.0
	stations, across = np.arange(lo[0], hi[0], step), np.arange(lo[2], hi[2], step)
	ha, hb, top = heights(a, stations, across), heights(b, stations, across), heights(every, stations, across)
	d = ha - hb
	zone = np.isfinite(d) & (np.abs(d) < near) & (np.fmax(ha, hb) >= top - 1e-6)
	inner = zone.copy()
	for _ in range(2):
		z = inner.copy()
		inner[1:] &= z[:-1]
		inner[:-1] &= z[1:]
		inner[:, 1:] &= z[:, :-1]
		inner[:, :-1] &= z[:, 1:]
	return float(min((inner & (d > 0)).sum(), (inner & (d < 0)).sum()) * step * step)


def segment_distance(point, segments):
	# A point's (2) distance to the nearest of segments (N, 2, 2)
	a, b = segments[:, 0], segments[:, 1]
	e = b - a
	t = np.clip(((point - a) * e).sum(1) / np.maximum((e * e).sum(1), 1e-12), 0, 1)
	return float(np.linalg.norm(a + t[:, None] * e - point, axis=1).min())


def inside_polygon(point, polygon):
	# Whether a point (2) lies inside a closed polygon (N, 2), by crossings
	x, y = point
	a, b = polygon, np.roll(polygon, -1, axis=0)
	cross = (a[:, 1] > y) != (b[:, 1] > y)
	at = a[:, 0] + (y - a[:, 1]) * (b[:, 0] - a[:, 0]) / np.where(b[:, 1] != a[:, 1], b[:, 1] - a[:, 1], 1)
	return bool(np.count_nonzero(cross & (at > x)) % 2)


def inside_segments(point, segments):
	# Whether a point (2) lies inside a closed outline given as segments (N, 2,
	# 2) in any order, by crossings
	x, y = point
	a, b = segments[:, 0], segments[:, 1]
	cross = (a[:, 1] > y) != (b[:, 1] > y)
	at = a[:, 0] + (y - a[:, 1]) * (b[:, 0] - a[:, 0]) / np.where(b[:, 1] != a[:, 1], b[:, 1] - a[:, 1], 1)
	return bool(np.count_nonzero(cross & (at > x)) % 2)


def lines(tris, view, stations, across):
	# The skin's fixed lines seen from a view ("above" and "below": waterline at
	# fixed buttlines; "outboard" on the right: buttline at fixed waterlines),
	# as heights over (across, stations), NaN off the skin
	axes = [0, 2, 1] if view == "outboard" else [0, 1, 2]
	flip = -1.0 if view == "below" else 1.0
	t = tris[..., axes].copy()
	t[..., 1] *= flip
	return heights(t, stations, across) * flip


def bends(H, step, free, jump=0.6):
	# Each line's bend (degrees) at each station, the stations an inch apart:
	# over 4 in either side, and the same again where more than 60% of it lies
	# within 2 in (a crease; else 0: a smooth curve keeps only half its bend in
	# the inner window). Lines are averaged over 3 in first, against the
	# loft's facets, so a sharp kink reads at about five-sixths of its angle;
	# a station counts only where its window is whole and free (one mask, or
	# one per line)
	# of the skin's edges (free), on a face within 35 deg of the view (the
	# surface across the line no steeper than 0.7, step apart) and on one
	# surface (no step over jump inches; None where no step is an edge, so a
	# cliff reads as the bend it is). Returns [(line, station's index, bend, crease)]
	slope = np.abs(np.gradient(H, step, axis=0))
	out = []
	for j in range(1, len(H) - 1):
		raw = H[j]
		h = np.convolve(np.pad(raw, 1, mode="edge"), np.ones(3) / 3, mode="valid")
		for i in range(7, len(raw) - 7):
			w = slice(i - 7, i + 8)
			if not (free[j] if free.ndim == 2 else free)[w].all() or not np.isfinite(H[j - 1:j + 2, w]).all() or (slope[j, w] > 0.7).any() or (jump is not None and (np.abs(np.diff(raw[w])) > jump).any()):
				continue

			def bend(b):
				return math.degrees(math.atan((h[i + b] - h[i]) / b) - math.atan((h[i] - h[i - b]) / b))

			wide, narrow = bend(4), bend(2)
			out.append((j, i, wide, wide if abs(narrow) > 0.6 * abs(wide) else 0.0))
	return out


def turns(h, noise=0.05):
	# A line's turns, as (index, +1 for a hump or -1 for a dip), each standing
	# noise above or below the run either side of it, alternating
	out, kind, best = [], 0, 0
	for i in range(1, len(h)):
		if kind == 0:
			if abs(h[i] - h[0]) > noise:
				kind = 1 if h[i] > h[0] else -1
				best = int(np.argmax(h[:i + 1]) if kind == 1 else np.argmin(h[:i + 1]))
		elif kind * (h[i] - h[best]) > 0:
			best = i
		elif kind * (h[best] - h[i]) > noise:
			out.append((best, kind))
			kind, best = -kind, i
	return out


def interp(keys, x):
	# a joint's schedule read at x: piecewise linear, held at the ends
	return float(np.interp(x, [k[0] for k in keys], [k[1] for k in keys]))


def closest(points, tris, chunk=256):
	# Each point's distance (N) to the nearest of the triangles (M, 3, 3): the
	# closest point on each triangle by Ericson's regions, taken in his order,
	# each point and triangle keeping the first region it falls in
	a, b, c = tris[:, 0], tris[:, 1], tris[:, 2]
	ab, ac, bc = b - a, c - a, c - b
	safe = lambda v: np.where(v == 0, 1e-20, v)
	out = np.full(len(points), np.inf)
	for start in range(0, len(points), chunk):
		q = points[start : start + chunk, None, :]
		ap, bp, cp = q - a, q - b, q - c
		d1, d2 = (ab * ap).sum(-1), (ac * ap).sum(-1)
		d3, d4 = (ab * bp).sum(-1), (ac * bp).sum(-1)
		d5, d6 = (ab * cp).sum(-1), (ac * cp).sum(-1)
		va, vb, vc = d3 * d6 - d5 * d4, d5 * d2 - d1 * d6, d1 * d4 - d3 * d2
		total = safe(va + vb + vc)
		regions = [
			((d1 <= 0) & (d2 <= 0), lambda: a + 0 * q),
			((d3 >= 0) & (d4 <= d3), lambda: b + 0 * q),
			((vc <= 0) & (d1 >= 0) & (d3 <= 0), lambda: a + ab * (d1 / safe(d1 - d3))[..., None]),
			((d6 >= 0) & (d5 <= d6), lambda: c + 0 * q),
			((vb <= 0) & (d2 >= 0) & (d6 <= 0), lambda: a + ac * (d2 / safe(d2 - d6))[..., None]),
			((va <= 0) & (d4 - d3 >= 0) & (d5 - d6 >= 0), lambda: b + bc * ((d4 - d3) / safe((d4 - d3) + (d5 - d6)))[..., None]),
		]
		x = a + ab * (vb / total)[..., None] + ac * (vc / total)[..., None]
		done = np.zeros(x.shape[:2], bool)
		for inside, point in regions:
			take = inside & ~done
			if take.any():
				x = np.where(take[..., None], point(), x)
			done |= take
		out[start : start + chunk] = np.linalg.norm(x - q, axis=-1).min(1)
	return out


def apart(one, other):
	# How far two parts (triangles, (N, 3, 3)) stand apart at their nearest:
	# 0 where a corner of either lies inside the other (they cross), else every
	# corner of each against the other's triangles near it (a triangle near by
	# its own bounds: a long face's corners can lie far off while it passes
	# close)
	def near(tris, other_tris):
		low, high = other_tris.reshape(-1, 3).min(0) - 2.0, other_tris.reshape(-1, 3).max(0) + 2.0
		return tris[(tris.max(1) >= low).all(-1) & (tris.min(1) <= high).all(-1)]

	a, b = near(one, other), near(other, one)
	if not len(a) or not len(b):
		return float("inf")
	corners = lambda tris: np.unique(tris.reshape(-1, 3), axis=0)
	if enclosed(corners(one), other).any() or enclosed(corners(other), one).any():
		return 0.0
	return float(min(closest(corners(one), b).min(), closest(corners(other), a).min()))


def through(one, other, margin=1e-4, chunk=512):
	# Where two parts' surfaces cross (triangles (N, 3, 3) and (M, 3, 3)): each
	# point where an edge of either passes through a triangle of the other,
	# clear of the triangle's edges and of the edge's ends by a margin (a share
	# of each), so faces that only touch, or lie on one another, do not count
	# (K, 3)
	out = []
	for a, b in ((one, other), (other, one)):
		if not len(a) or not len(b):
			continue
		low, high = b.reshape(-1, 3).min(0), b.reshape(-1, 3).max(0)
		a = a[(a.max(1) >= low).all(-1) & (a.min(1) <= high).all(-1)]
		if not len(a):
			continue
		low, high = a.reshape(-1, 3).min(0), a.reshape(-1, 3).max(0)
		b = b[(b.max(1) >= low).all(-1) & (b.min(1) <= high).all(-1)]
		if not len(b):
			continue
		starts, ends = a.reshape(-1, 3), a[:, [1, 2, 0]].reshape(-1, 3)
		lows, highs = np.minimum(starts, ends), np.maximum(starts, ends)
		corner, first, second = b[:, 0], b[:, 1] - b[:, 0], b[:, 2] - b[:, 0]
		tlow, thigh = b.min(1), b.max(1)
		for s in range(0, len(starts), chunk):
			i, j = np.nonzero((lows[s : s + chunk, None] <= thigh[None]).all(-1) & (highs[s : s + chunk, None] >= tlow[None]).all(-1))
			if not len(i):
				continue
			p, d = starts[s + i], ends[s + i] - starts[s + i]
			e1, e2 = first[j], second[j]
			h = np.cross(d, e2)
			det = (e1 * h).sum(-1)
			scale = np.linalg.norm(d, axis=-1) * np.linalg.norm(e1, axis=-1) * np.linalg.norm(e2, axis=-1)
			ok = np.abs(det) > 1e-9 * np.maximum(scale, 1e-30)
			inverse = np.where(ok, 1.0 / np.where(ok, det, 1.0), 0.0)
			o = p - corner[j]
			u = (o * h).sum(-1) * inverse
			q = np.cross(o, e1)
			v = (d * q).sum(-1) * inverse
			t = (e2 * q).sum(-1) * inverse
			hit = ok & (u > margin) & (v > margin) & (u + v < 1 - margin) & (t > margin) & (t < 1 - margin)
			out.append(p[hit] + d[hit] * t[hit, None])
	return np.concatenate(out) if out else np.zeros((0, 3))


def shrunk(tris, by):
	# A closed part (triangles (N, 3, 3), faces turned out) pulled in by `by`:
	# each corner moved so that every face it touches steps in by `by` as
	# nearly as one move can (least squares over the faces' normals: a box's
	# corner goes in along all three), the seam a real part keeps from what it
	# passes
	flat = tris.reshape(-1, 3)
	_, index = np.unique(np.round(flat, 7), axis=0, return_inverse=True)
	index = index.reshape(-1)
	n = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
	n /= np.maximum(np.linalg.norm(n, axis=1), 1e-30)[:, None]
	n = np.repeat(n, 3, axis=0)
	a = np.zeros((index.max() + 1, 3, 3))
	b = np.zeros((index.max() + 1, 3))
	np.add.at(a, index, n[:, :, None] * n[:, None, :])
	np.add.at(b, index, -by * n)
	move = (np.linalg.pinv(a, rcond=1e-6) @ b[:, :, None])[:, :, 0]
	return (flat + move[index]).reshape(-1, 3, 3)


def boundary(tris):
	# The corners of a shell's edge (triangles (N, 3, 3)): those on a side
	# only one triangle has
	key = lambda v: tuple(np.round(v, 7))
	count = {}
	for t in tris:
		for a, b in ((0, 1), (1, 2), (2, 0)):
			e = frozenset((key(t[a]), key(t[b])))
			count[e] = count.get(e, 0) + 1
	return np.array(sorted({v for e, k in count.items() if k == 1 for v in e})).reshape(-1, 3)


def pinned(jet, pin, names, drives, steps=81):
	# How far apart a pin (a point in the model frame at rest) stands, carried
	# from rest by each of the named nodes through a drive's stroke (drives:
	# value to {drive: value}) at `steps` steps: the most, in inches. A
	# linkage's members, each carrying their shared pin, drift apart between
	# keys that read their motions at different shares
	index = jet.model.index
	rest = jet.model.worlds(verify.pose(jet.joints, {}))
	homes = [np.linalg.inv(rest[index[n]]) @ np.append(pin, 1.0) for n in names]
	worst = 0.0
	for d in np.linspace(0, 1, steps):
		w = jet.model.worlds(verify.pose(jet.joints, drives(float(d))))
		at = [(w[index[n]] @ h)[:3] for n, h in zip(names, homes)]
		worst = max(worst, max(float(np.linalg.norm(p - at[0])) for p in at[1:]) / FRAME.unit)
	return worst


# The missiles the loadout hangs on the jet (our own builds, ../missiles), as
# the game ships them
ROUNDS = HERE.parent.parent / "web" / "src" / "assets"


def hung(seat):
	# A round laid on its seat as the engine lays it (web/src/game/hang.ts
	# place): the missile's own mount on the seat's, its nose along the
	# seat's forward, its lugs toward its up. Its triangles in the model frame
	model = verify.Model(str(ROUNDS / f"{seat['kind']}.glb"))
	mount = np.array(json.loads((ROUNDS / f"{seat['kind']}.json").read_text())["points"]["mount"], float)
	f = np.array(seat["forward"], float)
	f /= np.linalg.norm(f)
	u = np.array(seat["up"], float)
	u -= f * (u @ f)
	u /= np.linalg.norm(u)
	R = np.stack([f, u, np.cross(f, u)], 1)
	return model.triangles() @ R.T + (np.array(seat["mount"], float) - R @ mount)


def vertical(tris, x, z):
	# The heights (y) where a vertical line at (x, z) crosses the triangles
	# (N, 3, 3), each in the frame's [x, y, z]
	a, b, c = tris[:, 0], tris[:, 1], tris[:, 2]
	d = (b[:, 0] - a[:, 0]) * (c[:, 2] - a[:, 2]) - (c[:, 0] - a[:, 0]) * (b[:, 2] - a[:, 2])
	ok = np.abs(d) > 1e-12
	a, b, c, d = a[ok], b[ok], c[ok], d[ok]
	s = ((x - a[:, 0]) * (c[:, 2] - a[:, 2]) - (c[:, 0] - a[:, 0]) * (z - a[:, 2])) / d
	t = ((b[:, 0] - a[:, 0]) * (z - a[:, 2]) - (x - a[:, 0]) * (b[:, 2] - a[:, 2])) / d
	inside = (s >= 0) & (t >= 0) & (s + t <= 1)
	return (a[:, 1] + s * (b[:, 1] - a[:, 1]) + t * (c[:, 1] - a[:, 1]))[inside]


def carrier(part):
	# What a store part hangs from: a pylon from the wing (the centreline's
	# from the fuselage), a rack or a tank from its pylon, a side rail from its
	# rack, a LAU-116 from the fuselage, a wingtip rail from the outer wing
	kind, station, point = STATION.match(part).groups()
	station = int(station)
	side = "left" if station < 5 else "right"
	if kind == "rail" and station in (1, 9):
		return f"wing_outer_{side}"
	if kind in ("rack", "tank"):
		return f"pylon_{station}"
	if kind in ("rail", "launcher"):
		return f"rack_{station}"
	if kind == "pylon":
		return "fuselage" if station == 5 else f"wing_inner_{side}"
	return "fuselage"


def seated(part, skin, stations, plane=None):
	# How far a thin part standing on the skin (a fin; triangles, source
	# coordinates) stands off it at its foot, the furthest over the stations:
	# at each, on each side of the part's own mid-plane (through its middle,
	# square to its thinnest direction), the section's corners lowest along the
	# part's span (within a tenth of an inch), each against the skin's top at
	# its buttline. 0 or less where every foot lies on or in the skin, NaN
	# where no station cuts the part. Lowest by waterline instead, a face
	# slanting down into the skin was judged halfway up, and a face meeting
	# another part (a fin's root on a fairing under it) was judged at the
	# closing face between them. plane: the part's mid-plane as a point on it
	# and its normal, or the triangles whose own mid-plane it is; the part's
	# by default
	if isinstance(plane, tuple):
		centre, normal = (np.asarray(v, float) for v in plane)
		normal = normal / np.linalg.norm(normal)
	else:
		points = (part if plane is None else plane).reshape(-1, 3)
		centre = points.mean(0)
		normal = np.linalg.svd(points - centre, full_matrices=False)[2][-1]
	span = np.cross(normal, [1.0, 0.0, 0.0])
	span = span / np.linalg.norm(span) * (1.0 if span[1] >= 0 else -1.0)
	worst = np.nan
	for station in stations:
		ends = verify.cut(part, [station, 0.0, 0.0], [1.0, 0.0, 0.0]).reshape(-1, 3)
		if not len(ends):
			continue
		offsets, along = (ends - centre) @ normal, ends @ span
		for sign in (1.0, -1.0):
			on = sign * offsets >= 0
			if not on.any():
				continue
			for foot in ends[on & (along <= along[on].min() + 0.1)]:
				# a foot over a hole in the skin stands in it: the hole is skin
				# the part encloses, which a part lifted off the skin would not
				if holed(skin, station, foot[2]):
					continue
				top = heights(skin, np.array([station - 0.01, station, station + 0.01]), np.array([foot[2], foot[2] + 0.01]))[0][1]
				worst = foot[1] - top if np.isnan(worst) else max(worst, foot[1] - top)
	return worst


# How far the skin's top drops at the edge of a hole in it, inches: more than
# any step its own shape takes over a quarter inch
DROP = 2.0
DEEP = 6.0   # inches under the skin on both sides that a top read through a hole lies (holed())


def holed(skin, station, buttline, reach=8.0, step=0.25):
	# Whether the skin has a hole at a station and buttline: the build leaves
	# none of the skin a closed part encloses (a fin's root fairing:
	# ../hidden.py), and through the hole the top read is whatever lies below
	# (the far skin, a duct). A quadratic across the buttlines within reach is
	# fitted to the skin's tops, those lying no more than DROP under it; a hole
	# is a top further under the fit, with skin on both sides of it
	buttlines = buttline + np.arange(-reach, reach + step / 2, step)
	tops = heights(skin, np.array([station - 0.01, station, station + 0.01]), buttlines)[:, 1]
	k = len(buttlines) // 2
	found = np.isfinite(tops)
	if found.sum() < 3:
		return False
	# a top read far below the skin on both sides of it (the floor, a duct)
	# is a hole however the skin beside it curves: beside a fin's root
	# fairing the nacelle's shoulder falls away within an inch or two
	# outboard of the hole, under the fit below, which then missed it
	with np.errstate(invalid="ignore"):
		if np.isfinite(tops[k]) and (tops[:k] > tops[k] + DEEP).any() and (tops[k + 1 :] > tops[k] + DEEP).any():
			return True
	# from the upper half of the tops (a fit to them all bends down into the
	# hole), then every top within DROP of the fit, until that settles
	keep = found & (tops >= np.median(tops[found]))
	for _ in range(6):
		fit = np.polyval(np.polyfit(buttlines[keep] - buttline, tops[keep], 2), buttlines - buttline)
		settled = found & (tops >= fit - DROP)
		if (settled == keep).all():
			break
		keep = settled
	return bool(keep[:k].any() and keep[k + 1 :].any() and (not np.isfinite(tops[k]) or tops[k] < fit[k] - DROP))


def waves(H, stations, free, span=40.0, jump=0.6, step=None):
	# Each line's waves: a dip between two humps, or a hump between two dips,
	# the three turns within 2 * span inches, over a run of stations free of
	# the skin's edges (free: one mask, or one per line), on the skin
	# throughout and on one surface (no step over jump inches between
	# neighbours: where a line leaves one surface for another). With step (the
	# lines' spacing), only on a face within 35 deg of the view (the surface
	# across the line no steeper than 0.7), as bends() reads it: on a steeper
	# face a sideways wiggle of hundredths shows as tenths, and the view across
	# it measures it squarely. Lines are averaged over 3 stations first, against
	# the loft's facets. Returns [(line, station, +1 hump or -1 dip, its height
	# above or depth below the lower or higher of the turns either side)]
	out = []
	slope = np.abs(np.gradient(H, step, axis=0)) if step is not None and len(H) > 1 else None
	for j, raw in enumerate(H):
		ok = np.isfinite(raw) & (free[j] if free.ndim == 2 else free)
		if slope is not None:
			ok &= ~(slope[j] > 0.7)
		step = np.abs(np.diff(np.where(np.isfinite(raw), raw, 0.0))) > jump
		i = 0
		while i < len(raw):
			if not ok[i]:
				i += 1
				continue
			k = i + 1
			while k < len(raw) and ok[k] and not step[k - 1]:
				k += 1
			h = np.convolve(np.pad(raw[i:k], 1, mode="edge"), np.ones(3) / 3, mode="valid")
			found = [(a, s) for a, s in turns(h) if 0 < a < len(h) - 1]
			for (a, _), (b, s), (c, _) in zip(found, found[1:], found[2:]):
				if stations[i + c] - stations[i + a] <= 2 * span:
					out.append((j, float(stations[i + b]), s, float(min(abs(h[b] - h[a]), abs(h[b] - h[c])))))
			i = k
	return out


def surface_distance(points, tris, chunk=256):
	# Each point's (N, 3) distance to the nearest of the triangles (M, 3, 3):
	# to the plane where the point stands over a triangle, else to its edges
	out = np.full(len(points), np.inf)
	a, b, c = tris[:, 0], tris[:, 1], tris[:, 2]
	n = np.cross(b - a, c - a)
	size = np.linalg.norm(n, axis=1)
	keep = size > 1e-12
	if not keep.any():
		return out
	a, b, c, n = a[keep], b[keep], c[keep], n[keep] / size[keep, None]
	v0, v1 = b - a, c - a
	d00, d01, d11 = (v0 * v0).sum(1), (v0 * v1).sum(1), (v1 * v1).sum(1)
	den = d00 * d11 - d01 * d01

	def edge(p, s0, s1):
		e = s1 - s0
		t = np.clip(((p[:, None] - s0[None]) * e[None]).sum(-1) / np.maximum((e * e).sum(1), 1e-12)[None], 0, 1)
		return np.linalg.norm(s0[None] + t[..., None] * e[None] - p[:, None], axis=-1)

	for i in range(0, len(points), chunk):
		p = points[i:i + chunk]
		w = p[:, None] - a[None]
		h = (w * n[None]).sum(-1)
		q = w - h[..., None] * n[None]
		d20, d21 = (q * v0[None]).sum(-1), (q * v1[None]).sum(-1)
		u, v = (d11 * d20 - d01 * d21) / den, (d00 * d21 - d01 * d20) / den
		over = (u >= 0) & (v >= 0) & (u + v <= 1)
		rim = np.minimum(np.minimum(edge(p, a, b), edge(p, b, c)), edge(p, c, a))
		out[i:i + chunk] = np.where(over, np.abs(h), rim).min(1)
	return out


def standing(points, tris, chunk=256):
	# Each point's (N, 3) distance from the nearest of the triangles (M, 3, 3),
	# negative where it lies behind that triangle's face, inside what it
	# bounds. Source coordinates mirror the model's frame, so an outward
	# face's cross product there points in
	out = np.full(len(points), -np.inf)
	a, b, c = tris[:, 0], tris[:, 1], tris[:, 2]
	n = -np.cross(b - a, c - a)
	size = np.linalg.norm(n, axis=1)
	keep = size > 1e-12
	if not keep.any():
		return out
	a, b, c, n = a[keep], b[keep], c[keep], n[keep] / size[keep, None]
	v0, v1 = b - a, c - a
	d00, d01, d11 = (v0 * v0).sum(1), (v0 * v1).sum(1), (v1 * v1).sum(1)
	den = d00 * d11 - d01 * d01

	def edge(p, s0, s1):
		e = s1 - s0
		t = np.clip(((p[:, None] - s0[None]) * e[None]).sum(-1) / np.maximum((e * e).sum(1), 1e-12)[None], 0, 1)
		return np.linalg.norm(s0[None] + t[..., None] * e[None] - p[:, None], axis=-1)

	for i in range(0, len(points), chunk):
		p = points[i:i + chunk]
		w = p[:, None] - a[None]
		h = (w * n[None]).sum(-1)
		q = w - h[..., None] * n[None]
		d20, d21 = (q * v0[None]).sum(-1), (q * v1[None]).sum(-1)
		u, v = (d11 * d20 - d01 * d21) / den, (d00 * d21 - d01 * d20) / den
		over = (u >= 0) & (v >= 0) & (u + v <= 1)
		d = np.where(over, np.abs(h), np.minimum(np.minimum(edge(p, a, b), edge(p, b, c)), edge(p, c, a)))
		k = d.argmin(1)
		rows = np.arange(len(p))
		out[i:i + chunk] = d[rows, k] * np.where(h[rows, k] < 0, -1.0, 1.0)
	return out


def proud(tris, behind, step=0.05):
	# How far the triangles (N, 3, 3) that face aft (within 30 deg of it: a
	# ramp turned further, a fillet drawing in, is no end) stand proud of what
	# lies behind them, the furthest: each one's corners, edges' middles and middle,
	# from the nearest of `behind` (M, 3, 3) reaching more than `step` in aft
	# of it or turned forward back to back with it, where it stands outside
	# that (a face's hidden part, inside the parts behind it, stands proud of
	# nothing). A face turned aft's cross product points forward here
	# (standing())
	n = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
	size = np.linalg.norm(n, axis=1)
	t = tris[(size > 1e-12) & (n[:, 0] < -math.cos(math.radians(30)) * size)]
	if not len(t):
		return 0.0
	m = np.cross(behind[:, 1] - behind[:, 0], behind[:, 2] - behind[:, 0])
	forward = m[:, 0] > 0.5 * np.linalg.norm(m, axis=1)
	points = np.concatenate([t.reshape(-1, 3), t.mean(1), ((t + np.roll(t, -1, axis=1)) / 2).reshape(-1, 3)])
	worst = 0.0
	for station in np.unique(np.round(points[:, 0], 2)):
		here = points[np.abs(points[:, 0] - station) < 0.006]
		later = behind[(behind[:, :, 0].max(1) > station + step) | (forward & (np.abs(behind[:, :, 0] - station) < step).all(1))]
		if len(later):
			worst = max(worst, float(standing(here, later).max()))
	return worst


def outward(tris):
	# Unit normals out of the jet for triangles (N, 3, 3) as it reads in
	# source coordinates, where their cross products point in (the
	# coordinates mirror the model's frame)
	n = -np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
	return n / np.maximum(np.linalg.norm(n, axis=1), 1e-12)[:, None]


def folds(tris):
	# The sharpest fold between two of the triangles (N, 3, 3) that share an
	# edge: the angle between their normals, degrees (0 lying flat; slivers
	# passed over)
	n = outward(tris)
	edges = {}
	for i, t in enumerate(np.round(tris, 4)):
		for a, b in ((0, 1), (1, 2), (2, 0)):
			edges.setdefault(tuple(sorted((tuple(t[a]), tuple(t[b])))), []).append(i)
	pairs = np.array([faces for faces in edges.values() if len(faces) == 2], int).reshape(-1, 2)
	# a sliver's direction is its rounding's (under a thousandth of a square
	# inch: the speedbrake's opening cuts some at its corners)
	area = np.linalg.norm(np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0]), axis=1) / 2
	pairs = pairs[(area[pairs] > 1e-3).all(1)] if len(pairs) else pairs
	if not len(pairs):
		return 0.0
	return float(np.degrees(np.arccos(np.clip((n[pairs[:, 0]] * n[pairs[:, 1]]).sum(1), -1.0, 1.0))).max())


# The nacelles' skin round the main gear's openings and the cheek station:
# stations, waterlines and buttlines either side of the centreline
SMOOTH = ((455.0, 600.0), (60.0, 100.0), (15.0, 50.0))


def shading(tris, normals):
	# How triangles (N, 3, 3) shade as exported, each corner with its own
	# normal (N, 3, 3), model frame: (the triangles of no area, under a
	# thousandth of an inch across their longest edge; the worst angle between a
	# corner's normal and its triangle's, degrees, and that triangle; the worst
	# turn between two triangles sharing an edge shaded smooth, its ends
	# carrying one normal in both, degrees, and the first of the two)
	face = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
	twice = np.linalg.norm(face, axis=1)
	longest = np.max([np.linalg.norm(tris[:, k] - tris[:, (k + 1) % 3], axis=1) for k in range(3)], axis=0)
	flat = twice < 0.001 * FRAME.unit * np.maximum(longest, 1e-12)
	unit = face / np.where(flat, 1.0, twice)[:, None]
	corners = normals / np.maximum(np.linalg.norm(normals, axis=2, keepdims=True), 1e-12)
	off = np.degrees(np.arccos(np.clip(np.einsum("tk,tvk->tv", unit, corners), -1.0, 1.0))).max(1)
	off[flat] = 0.0
	worst = int(np.argmax(off)) if len(off) else None
	# the edges, by their ends' places (to a hundredth of a millimetre)
	key = np.round(tris / 1e-5).astype(np.int64)
	edges = {}
	for i in np.flatnonzero(~flat):
		for a, b in ((0, 1), (1, 2), (2, 0)):
			ends = sorted(((tuple(key[i, a]), a), (tuple(key[i, b]), b)))
			edges.setdefault((ends[0][0], ends[1][0]), []).append((i, ends[0][1], ends[1][1]))
	turn, where = 0.0, None
	for pair in edges.values():
		if len(pair) != 2:
			continue
		(i, a0, b0), (j, a1, b1) = pair
		if (corners[i, a0] @ corners[j, a1]) < 0.9999 or (corners[i, b0] @ corners[j, b1]) < 0.9999:
			continue
		angle = float(np.degrees(np.arccos(np.clip(unit[i] @ unit[j], -1.0, 1.0))))
		if angle > turn:
			turn, where = angle, i
	return int(flat.sum()), (float(off[worst]) if worst is not None else 0.0), worst, turn, where


def lip(inner, outer, turns, width=2.0):
	# The least by which points `inner` stand outside points `outer` round
	# an axis, each set given as (up, out) from it: at each of the angles
	# `turns` (degrees from straight up, + out), the nearest of inner's
	# within width/2 degrees against the furthest of outer's; NaN where no
	# angle has both
	def round_(points):
		return np.degrees(np.arctan2(points[:, 1], points[:, 0])), np.hypot(points[:, 0], points[:, 1])

	a, r = round_(np.asarray(inner, float).reshape(-1, 2))
	b, q = round_(np.asarray(outer, float).reshape(-1, 2))
	least = [float(r[np.abs(a - t) <= width / 2].min() - q[np.abs(b - t) <= width / 2].max()) for t in turns
		if (np.abs(a - t) <= width / 2).any() and (np.abs(b - t) <= width / 2).any()]
	return min(least) if least else float("nan")


def buried(jet, part, carrier, outward, reach=1.0):
	# The share of a flush lens's or strip's outer face (its faces turned
	# toward `outward`, model frame) lying under the skin of what it stands
	# on: a ray out along each such face's normal from its middle that meets
	# the carrier within `reach` inches. A plate laid as a chord across a
	# curved face sinks its middle under it
	t, c = jet.tris([part]), jet.tris([carrier])
	low, high = t.reshape(-1, 3).min(0) - 3 * FRAME.unit, t.reshape(-1, 3).max(0) + 3 * FRAME.unit
	c = c[(c.min(1) <= high).all(-1) & (c.max(1) >= low).all(-1)]   # the carrier's triangles whose bounds meet the lens's
	n = np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0])
	area = np.linalg.norm(n, axis=1) / 2
	unit = n / np.maximum(2 * area, 1e-12)[:, None]
	outer = (unit @ outward > 0.3) & (area > 0)
	if not outer.any():
		return math.nan
	under = sum(area[k] for k in np.nonzero(outer)[0]
		if (d := first_hit(c, t[k].mean(0) + unit[k] * 1e-6, unit[k])) is not None and d < reach * FRAME.unit)
	return float(under / area[outer].sum())


def aloft(t, c, reach=3.0):
	# How far a plate laid on a skin stands off it, the furthest: its faces
	# (N, 3, 3) turned the skin's way out beneath it (the skin's triangles `c`
	# within `reach` inches, their normals' mean), each from its middle back
	# along its own normal to the skin, in inches; NaN when none turns that
	# way. A flat plate on a curved face stands off it along one side
	if not len(t):
		return math.nan
	low, high = t.reshape(-1, 3).min(0) - reach * FRAME.unit, t.reshape(-1, 3).max(0) + reach * FRAME.unit
	c = c[(c.min(1) <= high).all(-1) & (c.max(1) >= low).all(-1)]
	m = np.cross(c[:, 1] - c[:, 0], c[:, 2] - c[:, 0]).sum(0)
	outward = m / max(np.linalg.norm(m), 1e-12)
	n = np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0])
	area = np.linalg.norm(n, axis=1) / 2
	unit = n / np.maximum(2 * area, 1e-12)[:, None]
	outer = (unit @ outward > 0.3) & (area > 0)
	if not outer.any():
		return math.nan
	found = [d for k in np.nonzero(outer)[0] if (d := first_hit(c, t[k].mean(0), -unit[k])) is not None and d < reach * FRAME.unit]
	return max(found) / FRAME.unit if found else math.nan


def first_hit(tris, origin, direction):
	# The distance along a ray to the nearest triangle it meets (model units), or None
	v0, v1, v2 = tris[:, 0], tris[:, 1], tris[:, 2]
	e1, e2 = v1 - v0, v2 - v0
	p = np.cross(direction, e2)
	det = (e1 * p).sum(1)
	ok = np.abs(det) > 1e-12
	inv = np.where(ok, 1 / np.where(ok, det, 1), 0)
	s = origin - v0
	u = (s * p).sum(1) * inv
	q = np.cross(s, e1)
	v = (direction * q).sum(1) * inv
	d = (e2 * q).sum(1) * inv
	met = ok & (u >= 0) & (v >= 0) & (u + v <= 1) & (d > 1e-9)
	return float(d[met].min()) if met.any() else None


def hits(tris, origins, direction):
	# Where rays from each origin (N, 3) along one direction first meet the
	# triangles: (triangle index, barycentric (u, v)) per ray, index -1 for a miss
	v0, e1, e2 = tris[:, 0], tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0]
	p = np.cross(direction, e2)
	det = (e1 * p).sum(1)
	ok = np.abs(det) > 1e-12
	inv = np.where(ok, 1 / np.where(ok, det, 1), 0)
	q = np.cross(e1, direction)
	out, bary = np.full(len(origins), -1), np.zeros((len(origins), 2))
	for i, o in enumerate(origins):
		s = o - v0
		u = (s * p).sum(1) * inv
		c = np.cross(s, e1)
		v = (direction * c).sum(1) * inv
		d = (e2 * c).sum(1) * inv
		met = ok & (u >= -1e-6) & (v >= -1e-6) & (u + v <= 1 + 1e-6) & (d > 1e-9)
		if met.any():
			k = int(np.argmin(np.where(met, d, np.inf)))
			out[i], bary[i] = k, (u[k], v[k])
	return out, bary


def head_on(tris, origin, direction):
	# Where a ray first meets the triangles (model frame), as a station, and
	# whether that face stands across the jet's axis, its normal within 37 deg
	# of it (a cap across a duct; a wall lies along it); None for a miss
	k, bary = hits(tris, origin[None], direction)
	if k[0] < 0:
		return None
	t = tris[k[0]]
	n = np.cross(t[1] - t[0], t[2] - t[0])
	point = t[0] + (t[1] - t[0]) * bary[0, 0] + (t[2] - t[0]) * bary[0, 1]
	return float(FRAME.source(point[None])[0, 0]), bool(abs(n[0]) > 0.8 * np.linalg.norm(n))


def strays(jet, name, stations, count=24):
	# Rays from a duct's axis meeting another part, or nothing, before the
	# duct's own faces, or meeting those from behind (turned away from the
	# duct, the bake shades them from outside it, at the occlusion's floor):
	# from the middle of its section at each station (the cut's loop smallest
	# across, inside an outer skin's), `count` of them aft and sideways; a
	# station the duct does not reach counts every ray
	names = sorted(jet.parts())
	tris = [jet.tris([n]) for n in names]
	owner = np.concatenate([np.full(len(t), i) for i, t in enumerate(tris)])
	every = np.concatenate(tris)
	turns = [(math.sqrt(1 - z * z), z, 2.39996 * i) for i, z in enumerate(np.linspace(0.05, 1.0, count))]
	directions = [FRAME.axes @ np.array([z, r * math.cos(a), r * math.sin(a)]) for r, z, a in turns]
	origins, stray = [], 0
	for station in stations:
		q = jet.cut([name], [station, 100, 0], [1, 0, 0])
		found = [l for l in loops(q[:, 1:].reshape(-1, 2, 2)) if len(l) > 8] if len(q) else []
		if not found:
			stray += count
			continue
		loop = min(found, key=lambda l: float(np.ptp(l, axis=0).sum()))
		origins.append([station, *loop.mean(0)])
	if not origins:
		return stray
	# the faces within 60 in of the origins: a ray that goes further has left the duct
	source = FRAME.source(every.reshape(-1, 3)).reshape(-1, 3, 3)
	lo, hi = np.min(origins, 0) - 60, np.max(origins, 0) + 60
	near = ((source.max(1) >= lo) & (source.min(1) <= hi)).all(1)
	every, owner = every[near], owner[near]
	origins = FRAME.model(np.array(origins))
	normals = np.cross(every[:, 1] - every[:, 0], every[:, 2] - every[:, 0])
	for direction in directions:
		met = hits(every, origins, direction / np.linalg.norm(direction))[0]
		k = np.maximum(met, 0)
		stray += int(((met < 0) | (owner[k] != names.index(name)) | (normals[k] @ direction > 0)).sum())
	return stray


def shades(jet, image, name, eyes, aims, keep):
	# The atlas's brightness where rays from each eye toward each aim (source
	# frame) first meet the named part, with where they meet it: (values,
	# points); a ray meeting another part first, or meeting it where keep(point)
	# is false, left out
	names = sorted(jet.parts())
	tris = [FRAME.source(jet.tris([n]).reshape(-1, 3)).reshape(-1, 3, 3) for n in names]
	owner = np.concatenate([np.full(len(t), i) for i, t in enumerate(tris)])
	every = np.concatenate(tris)
	own, uvs = jet.textured(names=[name])
	values, points = [], []
	for eye in eyes:
		for aim in aims:
			d = (aim - eye) / np.linalg.norm(aim - eye)
			k, bary = hits(every, eye[None], d)
			if k[0] < 0 or names[owner[k[0]]] != name:
				continue
			t = every[k[0]]
			point = t[0] + (t[1] - t[0]) * bary[0, 0] + (t[2] - t[0]) * bary[0, 1]
			if not keep(point):
				continue
			j, b = hits(own, (point - 0.2 * d)[None], d)
			if j[0] < 0:
				continue
			uv = uvs[j[0], 0] * (1 - b[0].sum()) + uvs[j[0], 1] * b[0, 0] + uvs[j[0], 2] * b[0, 1]
			values.append(float(sample(image, uv[None])[0]))
			points.append(point)
	return np.array(values), np.array(points).reshape(-1, 3)


def atlas(path, material="paint"):
	# A material's atlas a GLB carries (the paint's, or the stores' own), as
	# brightness 0..1 (H, W), or None (a draft, unpainted)
	import io
	from PIL import Image
	data = Path(path).read_bytes()
	length = int.from_bytes(data[12:16], "little")
	gltf = json.loads(data[20:20 + length])
	start = 20 + length
	binary = data[start + 8:]
	materials = {m.get("name"): m for m in gltf.get("materials", [])}
	texture = materials.get(material, {}).get("pbrMetallicRoughness", {}).get("baseColorTexture")
	if texture is None:
		return None
	image = gltf["images"][gltf["textures"][texture["index"]]["source"]]
	view = gltf["bufferViews"][image["bufferView"]]
	raw = binary[view.get("byteOffset", 0): view.get("byteOffset", 0) + view["byteLength"]]
	return np.asarray(Image.open(io.BytesIO(raw)).convert("L"), float) / 255


def sample(image, uv):
	# The atlas's brightness at UVs (N, 2), read between texels (glTF's v runs down the image)
	h, w = image.shape
	x, y = np.clip(uv[:, 0] * w - 0.5, 0, w - 1), np.clip(uv[:, 1] * h - 0.5, 0, h - 1)
	x0, y0 = np.minimum(x.astype(int), w - 2), np.minimum(y.astype(int), h - 2)
	fx, fy = x - x0, y - y0
	return (image[y0, x0] * (1 - fx) * (1 - fy) + image[y0, x0 + 1] * fx * (1 - fy) + image[y0 + 1, x0] * (1 - fx) * fy + image[y0 + 1, x0 + 1] * fx * fy)


def coverage(uvs, size):
	# How many triangles (N, 3, 2 in UV) hold each texel's centre strictly
	# inside, over a size x size atlas: islands laid over each other count 2
	count = np.zeros((size, size), np.int32)
	p = uvs * size
	lo = np.floor(p.min(1) - 0.5).astype(int)
	span = np.ceil(p.max(1) - 0.5).astype(int) - lo + 1
	cross = lambda a, b: a[..., 0] * b[..., 1] - a[..., 1] * b[..., 0]
	whole = cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0])
	for s in np.unique(span.max(1)):
		pick = np.where((span.max(1) == s) & (np.abs(whole) > 1e-12))[0]
		for chunk in np.array_split(pick, max(1, len(pick) * s * s // 2000000 + 1)):
			grid = np.stack(np.meshgrid(np.arange(s), np.arange(s), indexing="ij"), -1).reshape(-1, 2)
			q = lo[chunk, None, :] + grid[None] + 0.5
			a, b, c = (p[chunk, k, None, :] for k in range(3))
			w0, w1 = cross(b - q, c - q) / whole[chunk, None], cross(c - q, a - q) / whole[chunk, None]
			inside = (w0 > 1e-6) & (w1 > 1e-6) & (1 - w0 - w1 > 1e-6)
			x, y = q[..., 0].astype(int), q[..., 1].astype(int)
			inside &= (x >= 0) & (x < size) & (y >= 0) & (y < size)
			np.add.at(count, (y[inside], x[inside]), 1)
	return count


def slope_at(buttlines, rises, bl):
	# The bent wing's slope at a buttline (rises by sorted buttlines, in), over
	# 4 in about it kept on the wing: past the tip the rise holds, and a span
	# reaching there would read half the slope
	low, high = max(bl - 2, buttlines[0]), min(bl + 2, buttlines[-1])
	return (np.interp(high, buttlines, rises) - np.interp(low, buttlines, rises)) / (high - low)


def mirrored(left, right):
	# How far a left part's bounds (points, source coordinates) miss its right
	# twin's, reflected across the centreline
	right = right * np.array([1.0, 1.0, -1.0])
	return float(max(np.abs(left.min(0) - right.min(0)).max(), np.abs(left.max(0) - right.max(0)).max()))


# Clearance (layout.motion): through each mechanism's stroke (SWEPT) no part
# it moves passes through another part it neither carries nor rides: not the
# skin round an opening, not a door, not another leg's member, by more than
# the seam a real part keeps (SEAM: each moving part is pulled in by it
# first; a door cut to its opening's own outline grazes the opening's walls
# as it starts to turn). Where two parts meet by design (JOINED) their
# crossings at the sweep's first pose (gear down, the speedbrake open, the
# hook stowed) are the joint, and only a crossing further than 2 in from it,
# in the first part's own frame (or SEATED's), is a clash; a door's crossings of the skin, its well or another
# door within HINGE of its hinge line are its turn in the skin, and closed
# (where it stands as it rests: gear 0, or the probe still waiting) its
# seat, which the wells check judges
# The mechanisms swept, each by its drive from 0 to 1 over its steps: the
# gear by the one value through the retraction's timeline, every part on one
# of its mechanisms' drives moving with it
SWEPT = {"gear": 41, "probe": 21, "canopy": 21, "fold": 21, "speedbrake": 21, "hook": 21, "swing": 21}
# a drive's values through its sweep, first to last (the first pose is where
# JOINED seats are taken), where they are not 1 to 0: the hook from stowed,
# where its hold-down rod's seats in the keel and the skin are, and its
# sideways swing from stop to stop (the points file's travel each way), held
# down, the only way the wire swings it (engine.ts hook_swing())
STROKES = {"hook": lambda jet, steps: np.linspace(0, 1, steps),
	"swing": lambda jet, steps: math.radians(jet.document["motion"]["swing"]) * np.linspace(-1, 1, steps)}
HELD = {"swing": {"hook": 1.0}}


def clearance(jet, drive="gear", steps=41):
	model, nodes, inch = jet.model, jet.model.nodes, FRAME.unit

	def lineage(i):
		out = []
		while i is not None:
			out.append(i)
			i = nodes[i]["parent"]
		return out

	def rides(name):
		own = jet.joints.get(name, {}).get("drive") or ""
		return own.startswith("gear.") if drive == "gear" else own == drive

	lines = [lineage(i) for i in range(len(nodes))]
	driven = [frozenset(k for k in lines[i] if rides(nodes[k]["name"])) for i in range(len(nodes))]
	moving = [i for i, n in enumerate(nodes) if n["mesh"] is not None and driven[i]]
	if not moving:
		raise KeyError(f"no part the {drive} moves")
	meshed = [i for i, n in enumerate(nodes) if n["mesh"] is not None]
	pairs = [(i, k) for i in moving for k in meshed if k != i and i not in lines[k] and k not in lines[i] and not (k in moving and k < i)]
	if drive != "gear":
		# the gear judges its parts riding one joint as well, their seats by
		# JOINED; another mechanism's parts riding its joints together (a rail
		# on the folding panel, the fairing hung half an inch into it) keep
		# their places against each other through its stroke, which the
		# static checks judge
		pairs = [(i, k) for i, k in pairs if driven[i] != driven[k]]
	joined = {frozenset(p) for p in JOINED}
	# the doors: the gear's on joints of their own; another mechanism's, each
	# part cut from the skin to close its opening (FLUSH), which may ride the
	# part it opens for with no hinge of its own (the probe's door)
	flush = {n for n, _ in FLUSH}
	doors = {i for i in moving if (("door" in nodes[i]["name"] and nodes[i]["name"] in jet.joints) if drive == "gear" else nodes[i]["name"] in flush)}
	hinges = {i: (model.rest[i][:3, 3], np.asarray(jet.joints[nodes[i]["name"]]["axis"], float) / np.linalg.norm(jet.joints[nodes[i]["name"]]["axis"])) for i in doors if nodes[i]["name"] in jet.joints}
	seats, found = {}, {}
	# each overlap's shock: its pin (the node's hinge) and its line toward
	# the eye in its own frame, from the can's far end at rest
	shock_axes, foot_axes, lower = {}, {}, 0.0
	if drive == "gear":
		rest_worlds = model.worlds(verify.pose(jet.joints, {}))
		rest_parts = model.parts(verify.pose(jet.joints, {}))
		for name in set(OVERLAPS.values()):
			i = model.index[name]
			can = rest_parts[name.replace("_shock", "_shock_can")].reshape(-1, 3)
			local = (can - rest_worlds[i][:3, 3]) @ rest_worlds[i][:3, :3]
			far = local[np.argmax(np.linalg.norm(local, axis=1))]
			shock_axes[name] = far / np.linalg.norm(far)
		# each foot's bolt, down from the spool's hinge, and where its lower lug begins
		foot_axes = {n: np.asarray(jet.joints[n]["axis"], float) / np.linalg.norm(jet.joints[n]["axis"]) for n in set(FOOTED.values())}
		lower = FACTS["layout"]["motion"]["braces"]["value"]["side"]["foot"]["lugs"][1][0]
	values = STROKES[drive](jet, steps) if drive in STROKES else np.linspace(1, 0, steps)
	for step, t in enumerate(values):
		posed = verify.pose(jet.joints, {**HELD.get(drive, {}), drive: float(t)})
		parts, worlds = model.parts(posed), model.worlds(posed)
		boxes = {name: (p.reshape(-1, 3).min(0), p.reshape(-1, 3).max(0)) for name, p in parts.items()}
		pulled = {}
		for i, k in pairs:
			a, b = nodes[i]["name"], nodes[k]["name"]
			if a not in parts or b not in parts or (boxes[a][0] > boxes[b][1]).any() or (boxes[b][0] > boxes[a][1]).any():
				continue
			for n in (a, b) if k in moving else (a,):
				if n not in pulled:
					pulled[n] = shrunk(parts[n], SEAM * inch)
			hits = through(pulled[a], pulled[b] if k in moving else parts[b])
			pair = frozenset((a, b))
			if len(hits) and pair in joined:
				w = worlds[model.index[SEATED[pair]]] if pair in SEATED else worlds[i]
				local = (hits - w[:3, 3]) @ w[:3, :3]
				if step == 0:
					seats[pair] = local
					continue
				seat = seats.get(pair)
				if seat is not None:
					hits = hits[np.array([np.linalg.norm(seat - p, axis=1).min() for p in local]) > 2 * inch]
			if len(hits) and pair in OVERLAPS:
				w = worlds[model.index[OVERLAPS[pair]]]
				along = ((hits - w[:3, 3]) @ w[:3, :3]) @ shock_axes[OVERLAPS[pair]]
				hits = hits[along > 0]
			if len(hits) and pair in FOOTED:
				w = worlds[model.index[FOOTED[pair]]]
				bolt = w[:3, :3] @ foot_axes[FOOTED[pair]]
				hits = hits[(hits - w[:3, 3]) @ bolt < (lower - 0.2) * inch]
			for door, other in ((i, k), (k, i)):
				if len(hits) and door in doors and (other not in moving or other in doors):
					if np.allclose(worlds[door], model.rest[door], atol=1e-9):
						hits = hits[:0]   # closed: the wells check judges a door's seat
						break
					if door in hinges:
						origin, axis = hinges[door]
						off = hits - origin
						hits = hits[np.linalg.norm(off - np.outer(off @ axis, axis), axis=1) > HINGE * inch]
			if len(hits):
				entry = found.setdefault((a, b), {"at": [], "points": []})
				entry["at"].append(round(float(t), 3))
				entry["points"].append(FRAME.source(hits))
	for (a, b), entry in sorted(found.items()):
		p = np.concatenate(entry["points"])
		lo, hi = p.min(0), p.max(0)
		yield result("layout.motion", f"{a} through {b}, {drive} {min(entry['at'])}-{max(entry['at'])} at FS {lo[0]:.0f}-{hi[0]:.0f}, WL {lo[1]:.0f}-{hi[1]:.0f}, BL {lo[2]:.0f}-{hi[2]:.0f}",
			0, len(entry["at"]), 0, "steps")
	yield result("layout.motion", f"pairs of parts crossing as the {drive} moves, of {len(pairs)} pairs over {steps} steps", 0, len(found), 0, "pairs")
	if drive != "gear":
		return
	# the sweep poses the gear along the retraction, the nose leg leading;
	# the extension lowers both legs together, the doors open either way, so
	# its poses differ only in where one leg stands against the other: no
	# pose of the nose leg's parts reaches a main leg's through their strokes
	def riding(part):
		return [nodes[i]["name"] for i in moving if any(jet.joints.get(nodes[k]["name"], {}).get("drive") == f"gear.{part}" for k in lines[i])]
	reach = {}
	for part in ("nose", "main"):
		swept = np.concatenate([jet.points(riding(part), {"gear.doors": 1.0, f"gear.{part}": float(t)}).reshape(-1, 3) for t in np.linspace(0, 1, 11)])
		reach[part] = (swept.min(0), swept.max(0))
	overlap = np.minimum(reach["nose"][1], reach["main"][1]) - np.maximum(reach["nose"][0], reach["main"][0])
	yield result("layout.motion", "nose leg's and main legs' reaches overlapping through their strokes", 0.0, max(0.0, float(overlap.min())), 0.0)


def result(fact, what, expected, measured, tolerance, unit="in"):
	# One measurement. A measurement of nothing (NaN off the skin) fails: NaN
	# compares false against any tolerance, and would pass
	measured = float(measured)
	return {"fact": fact, "what": what, "expected": round(float(expected), 3), "measured": round(measured, 3) if math.isfinite(measured) else math.inf,
		"tolerance": tolerance, "unit": unit}


def failed(r):
	return "missing" in r or abs(r["measured"] - r["expected"]) > r["tolerance"]


def cheek_face(station, waterline):
	# The cheek station's outboard face's buttline at a station and waterline,
	# as the build lays it (layout.nacelle cheek face): its plane leaning in
	# going up, measured at the slot, and ahead of it through the LAU-116's
	# front_top mark at the same lean, straight between
	face, lau = FACTS["layout"]["nacelle"]["cheek"]["face"], FACTS["layout"]["stores"]["lau116"]
	front = (lau["front_top"][0] + lau["front_bottom"][0]) / 2
	ahead = lau["front_top"][2] + face["lean"] * (lau["front_top"][1] - face["waterline"])
	base = np.interp(station, [front, face["station"]], [ahead, face["buttline"]])
	return base + face["lean"] * (face["waterline"] - np.asarray(waterline, float))


def across_at(points, waterline, inboard=False):
	# Where a section's segments (a cut's points, in pairs) cross a waterline:
	# the outermost buttline, or the innermost; NaN where none does
	a, b = points.reshape(-1, 2, 3)[:, 0], points.reshape(-1, 2, 3)[:, 1]
	hit = (a[:, 1] - waterline) * (b[:, 1] - waterline) < 0
	t = (waterline - a[hit, 1]) / (b[hit, 1] - a[hit, 1])
	bl = a[hit, 2] + (b[hit, 2] - a[hit, 2]) * t
	return float(bl.min() if inboard else bl.max()) if len(bl) else math.nan


def chosen(fact, only):
	# whether a group runs under --only: every group without it, else a group
	# whose guard's fact is one named
	return not only or fact in only


def checks(jet, only=(), seen=None):
	# Yields {"fact", "what", "expected", "measured", "tolerance", "unit"} or {"fact", "what", "missing"},
	# from the groups chosen() keeps; `seen` collects every group's fact, run or not
	F = FACTS

	def guard(fact, what, fn):
		if seen is not None:
			seen.add(fact)
		if not chosen(fact, only):
			return []
		# a group that cannot measure reports it, as a failure, and the rest run
		# on: a fact or part not found (KeyError), or nothing left to measure (a
		# reduction over an empty selection: ValueError, IndexError)
		try:
			return list(fn())
		except KeyError as e:
			return [{"fact": fact, "what": what, "missing": str(e).strip("'\"")}]
		except (ValueError, IndexError) as e:
			return [{"fact": fact, "what": what, "missing": f"nothing to measure ({type(e).__name__}: {e})"}]

	apex = value(F["nose"]["apex"])
	# gear down as the photos stand the jet: the nose oleo in by its stroke
	# from its length in flight, where the model rests it, and the main legs'
	# arms pushed up by their droop, as the points file gives it (a jet
	# without its gear's points reports their checks failing, not a crash)
	down = {"gear": 1, "oleo.nose": F["layout"]["gear"]["legs"]["nose"]["extension"] * FRAME.unit}
	down.update({f"oleo.{leg}": jet.document.get("points", {}).get("gear", {}).get(leg, {}).get("static", 0.0) for leg in ("left", "right")})
	every = list(jet.parts())

	# Overall
	def overall():
		p = jet.points(every)
		# to the foot NATOPS gives it in (facts: overall.length)
		yield result("overall.length", "nose apex to the aftmost point", value(F["overall"]["length"]) * 12, p[:, 0].max() - p[:, 0].min(), 6.0)
		w = jet.points([n.format(s=s) for n in WING for s in ("left", "right")])
		yield result("overall.span.spread", "wingtip to wingtip", value(F["overall"]["span"]["spread"]) * 12, w[:, 2].max() - w[:, 2].min(), 1.0)
		# the folded panels' span, without the fairings under them (layout.wing_fairing),
		# which turn outboard with the panel 4.3 in a side: see facts overall.span.folded
		folded = jet.points([n for n in every if not n.startswith("gear") and not n.startswith("fairing_") and not n.startswith("lamp_position_fold")], {"fold": 1})
		yield result("overall.span.folded", "span with the wings folded, the panels without their underwing fairings", value(F["overall"]["span"]["folded"]) * 12, folded[:, 2].max() - folded[:, 2].min(), 3.0)
		# the outer panel turned as far as the photos fold it (layout.fold): the
		# rigid turn taking its points at rest onto its points folded
		for side in ("left", "right"):
			spread, turned = jet.points([f"wing_outer_{side}"]), jet.points([f"wing_outer_{side}"], {"fold": 1})
			u, _, vt = np.linalg.svd((turned - turned.mean(0)).T @ (spread - spread.mean(0)))
			rotation = u @ vt
			angle = math.degrees(math.acos(max(-1.0, min(1.0, (np.trace(rotation) - 1) / 2))))
			yield result("layout.fold", f"{side} outer wing's fold", F["layout"]["fold"]["angle"], angle, 1.0, "deg")
		# the ground: the plane through the three tyres' lowest points (the jet
		# need not sit level on its gear)
		contacts = []
		for wheel in ("gear_left_wheel", "gear_right_wheel", "gear_nose_wheel"):
			w = jet.points([wheel], down)
			contacts.append(w[np.argmin(w[:, 1])])
		a, b, c = contacts
		normal = np.cross(b - a, c - a)
		normal = normal / np.linalg.norm(normal) * (1 if normal[1] > 0 else -1)
		above = lambda pts: float(((pts - a) @ normal).max())
		yield result("overall.height.fins", "ground to the fin tops, gear down", value(F["overall"]["height"]["fins"]) * 12, above(jet.points(["fin_left", "fin_right"])), 1.5)
		yield result("overall.height.canopy", "ground to the closed canopy's top", value(F["overall"]["height"]["canopy"]) * 12, above(jet.points(["canopy"])), 1.5)
		g = F["layout"]["gear"]
		yield result("layout.gear", "main tyres' contact", g["axles"]["main"] - g["tyres"]["main"]["diameter"] / 2, (a[1] + b[1]) / 2, 0.5, "WL in")
		flaps = sorted(n for n in jet.parts() if "_petal_" in n)
		nozzles = jet.points(flaps)
		yield result("layout.nozzle", "nozzles' exit", F["layout"]["nozzle"]["exit"], nozzles[:, 0].max(), 0.5, "FS in")
		yield result("overall.exhaust", "nose apex to the nozzles' exit", value(F["overall"]["exhaust"]) * 12, nozzles[:, 0].max() - jet.points(["fuselage"])[:, 0].min(), 0.5)
		lip = nozzles[nozzles[:, 0] > nozzles[:, 0].max() - 0.5]
		yield result("layout.nozzle", "nozzle exit's lower lip", F["layout"]["nozzle"]["waterline"] - F["layout"]["nozzle"]["radius"][1], lip[:, 1].min(), 0.5, "WL in")
		# the burner's glowing faces sit inside the nozzles, short of the exit
		burner = jet.points(["burner_left", "burner_right"])
		yield result("layout.nozzle", "burner's faces short of the nozzles' exit", 0.0, max(0.0, burner[:, 0].max() - F["layout"]["nozzle"]["exit"] + 1.0), 0.01, "FS in")
		yield result("layout.nozzle", "burner inside the nozzle's exit", 0.0, max(0.0, F["layout"]["nozzle"]["waterline"] - F["layout"]["nozzle"]["radius"][1] - burner[:, 1].min()), 0.01, "WL in")
		# the outer flaps: twelve a side, closing on the drive to tm100159's exit, the burner as wide as the open throat
		petals = F["layout"]["petals"]
		for side in ("left", "right"):
			yield result("layout.petals", f"{side} nozzle's outer flaps", petals["count"], sum(n.startswith(f"nozzle_{side}_petal_") for n in flaps), 0, "flaps")
		bottom = f"nozzle_right_petal_{petals['count'] // 2 + 1}"
		# closed, the bottom flap's aft end on the vertical through the engine's
		# axis: its divergent flap's face (the gas path's exit) the closed
		# radius from the axis
		p = jet.points([bottom], {"nozzle": 1})
		e = F["engine"]
		axis = value(e["buttline"]) * 12 - (p[:, 0] - value(F["reference"]["station"])) * math.tan(math.radians(value(e["angle"])))
		below = p[(p[:, 0] > p[:, 0].max() - 0.5) & (np.abs(p[:, 2] - axis) <= 0.6)]
		yield result("layout.petals", "closed nozzle's exit radius", petals["closed"], F["layout"]["nozzle"]["waterline"] - below[:, 1].max(), 0.1)
		# open (at rest), on the same vertical: the gas path from the exit in to
		# the throat (the divergent flap) and on to the tailpipe (the convergent
		# flap), their faces' points and the lengths between them
		n = F["layout"]["nozzle"]
		p = jet.points([bottom])
		axis = value(e["buttline"]) * 12 - (p[:, 0] - value(F["reference"]["station"])) * math.tan(math.radians(value(e["angle"])))
		line = p[np.abs(p[:, 2] - axis) <= 0.6]
		radius = n["waterline"] - line[:, 1]
		inside = line[radius < n["radius"][1] - 1.0]
		gas = n["waterline"] - inside[:, 1]
		throat = inside[np.argmin(gas)]
		exit_ = inside[inside[:, 0] > inside[:, 0].max() - 0.1]
		exit_ = exit_[np.argmax(exit_[:, 1])]
		front = inside[inside[:, 0] < inside[:, 0].min() + 0.1]
		front = front[np.argmax(front[:, 1])]
		yield result("layout.petals", "open throat's radius, where the divergent flaps end", petals["throat"][1], n["waterline"] - throat[1], 0.1)
		yield result("layout.petals", "tailpipe's radius, where the convergent flaps start", petals["tailpipe"], n["waterline"] - front[1], 0.1)
		yield result("layout.petals", "divergent flaps' length", petals["divergent"], np.linalg.norm((exit_ - throat)[:2]), 0.1)
		yield result("layout.petals", "convergent flaps' length", petals["convergent"], np.linalg.norm((throat - front)[:2]), 0.1)
		# the gas path's wall unbroken: straight down from the axis every half
		# inch from the tailpipe to the exit, the first face met on the bottom
		# flap lies on the convergent and divergent flaps' cones
		inner = n["radius"][1] - 1.5
		waist = n["exit"] - petals["divergent"] * math.cos(math.asin((inner - petals["throat"][1]) / petals["divergent"]))
		tail = waist - petals["convergent"] * math.cos(math.asin((petals["tailpipe"] - petals["throat"][1]) / petals["convergent"]))
		tris = jet.tris([bottom])
		downward = FRAME.axes @ np.array([0.0, -1.0, 0.0])
		worst = 0.0
		for station in np.arange(tail + 0.25, n["exit"] - 0.25, 0.5):
			bl = value(e["buttline"]) * 12 - (station - value(F["reference"]["station"])) * math.tan(math.radians(value(e["angle"])))
			origin = FRAME.model(np.array([station, n["waterline"], bl]))
			met = first_hit(tris, origin, downward)
			wall = met / 0.0254 if met is not None else 99.0
			if station < waist:
				cone = petals["tailpipe"] + (petals["throat"][1] - petals["tailpipe"]) * (station - tail) / (waist - tail)
			else:
				cone = petals["throat"][1] + (inner - petals["throat"][1]) * (station - waist) / (n["exit"] - waist)
			worst = max(worst, abs(wall - cone))
		yield result("layout.petals", "gas path's wall off the flaps' cones, worst, from the tailpipe to the exit", 0.0, worst, 0.15)
		# the stepped tabs: the bottom flap's outer face round its engine's
		# axis, as angles from the bottom (positive outboard): what only its
		# forward part covers ends at the step, and its aft part reaches round
		# past the forward part's edge by the step
		for side in ("left", "right"):
			flap = jet.points([f"nozzle_{side}_petal_{petals['count'] // 2 + 1}"])
			sign = 1 if side == "right" else -1
			axis = value(e["buttline"]) * 12 - (flap[:, 0] - value(F["reference"]["station"])) * math.tan(math.radians(value(e["angle"])))
			radius = np.hypot(flap[:, 1] - n["waterline"], flap[:, 2] - sign * axis)
			outer = flap[radius > n["radius"][1] - 0.3]
			angle = np.degrees(np.arctan2(sign * (outer[:, 2] - sign * axis[radius > n["radius"][1] - 0.3]), n["waterline"] - outer[:, 1]))
			# the build's angles run from the top round outboard, so past the
			# bottom they run inboard; its turn, the same seen from behind on
			# both engines, is towards larger angles on the right and smaller on
			# the left: here, inboard on the right, outboard on the left
			turned = -angle * sign
			step = 360 / petals["count"] * petals["step"][1]
			lone = turned < turned.min() + step / 2
			yield result("layout.petals", f"{side} nozzle's stepped tabs' station, from the exit as a share of the flaps' length", petals["step"][0], (n["exit"] - outer[lone, 0].max()) / (n["exit"] - n["start"]), 0.02, "of the length")
			aft, forward = outer[:, 0] > outer[lone, 0].max() + 0.5, outer[:, 0] < outer[lone, 0].max() - 0.5
			# (nothing aft of a step that is not there: no step round)
			reach = (turned[aft].max() - turned[forward].max()) / (360 / petals["count"]) if aft.any() and forward.any() else 0.0
			yield result("layout.petals", f"{side} nozzle's stepped tabs' step round, as a share of a flap's width", petals["step"][1], reach, 0.02, "of the width")
		glow = jet.points(["burner_right"])
		ring = glow[glow[:, 0] > glow[:, 0].max() - 1.0][:, 1:]   # the near end, square to the converging axis
		yield result("layout.petals", "burner's radius, the open throat's", petals["throat"][1], np.linalg.norm(ring - ring.mean(0), axis=1).max(), 0.1)

	yield from guard("overall", "overall", overall)

	# Nose and forebody sections
	def nose():
		p = jet.points(["fuselage"])
		tip = p[np.argmin(p[:, 0])]
		yield result("nose.apex", "nose apex station", apex, tip[0], 0.3, "FS in")
		yield result("nose.apex", "nose apex on the fuselage reference line", value(F["datum"]["apex"]), tip[1], 0.5, "WL in")
		droop = math.radians(value(F["nose"]["droop"]))
		centres = {}
		for row in F["sections"]:
			s = row["station"]
			canted = "canted" in row.get("note", "")
			flat = jet.cut(["fuselage"], [s, 100, 0], [1, 0, 0])
			middle = (flat[:, 1].max() + flat[:, 1].min()) / 2
			if canted:
				# square to the nosecone's drooped axis: the top leans forward
				normal = [math.cos(droop), math.sin(droop), 0]
				q = jet.cut(["fuselage"], [s, middle, 0], normal)
				up = np.array([-math.sin(droop), math.cos(droop), 0])
				height = (q @ up).max() - (q @ up).min()
			else:
				q = flat
				height = q[:, 1].max() - q[:, 1].min()
			centres[s] = middle
			fact = f"sections@{s}"
			yield result(fact, f"FS {s} section height", row["height"], height, 0.5)
			yield result(fact, f"FS {s} section width", row["width"], q[:, 2].max() - q[:, 2].min(), 0.5)
		slope = math.degrees(math.atan((centres[107] - centres[70]) / (107 - 70)))
		yield result("nose.droop", "nosecone axis droop, FS 70 to 107", value(F["nose"]["droop"]), slope, 1.0, "deg")
		# ahead of the first cited section, a circle, the nosecone round to its
		# tip: each section's width against its height
		first = min(r["station"] for r in F["sections"])
		for s in (61.5, 63.0, 65.0, 67.5):
			q = jet.cut(["fuselage"], [s, 100, 0], [1, 0, 0])
			yield result("sections", f"FS {s:g} section's width over its height, the nosecone round ahead of FS {first:g}", 1.0, (q[:, 2].max() - q[:, 2].min()) / (q[:, 1].max() - q[:, 1].min()), 0.05, "ratio")
		for row in F["forebody"]["value"]:
			s = row["station"]
			q = jet.cut(["fuselage"], [s, 100, 0], [1, 0, 0])
			yield result("forebody", f"FS {s} height (McDonnell Douglas drawing)", row["height"], q[:, 1].max() - q[:, 1].min(), 1.5)
			yield result("forebody", f"FS {s} width (McDonnell Douglas drawing)", row["width"], q[:, 2].max() - q[:, 2].min(), 1.5)

	yield from guard("sections", "forebody", nose)

	# LEX
	def lex():
		graph = F["lex"]["graph"]["value"]
		rows = [(r["station"], r["span"], f"lex.sections@{r['station']}", 1.0) for r in F["lex"]["sections"]]
		rows += [(s, span, "lex.graph", 2.5) for s, span in graph if s >= 220]
		for s, span, fact, tolerance in rows:
			q = jet.cut(["lex_right"], [s, 100, 0], [1, 0, 0])
			edge = q[np.argmax(q[:, 2])]
			body = jet.cut(["fuselage"], [s, 100, 0], [1, 0, 0])
			band = body[np.abs(body[:, 1] - q[np.argmin(q[:, 2]), 1]) < 3]
			yield result(fact, f"FS {s} LEX span from its root", span, edge[2] - band[:, 2].max(), tolerance)

	yield from guard("lex", "LEX", lex)

	# The LEX's underside at the traced sections (lex.underside): each
	# section registered on the LEX's top, where the build places the top from
	# the same trace, then the underside's height above that keel at each of
	# the trace's buttlines between its root's fillet and its edge
	def underside():
		traced = json.loads((HERE / "references" / "sections.json").read_text())["sections"]

		def crossing(segments, bl):
			# the waterlines (or heights) where segments ((N, 2, 2) BL, WL) cross a buttline
			a, b = segments[:, 0], segments[:, 1]
			across = (a[:, 0] - bl) * (b[:, 0] - bl) <= 0
			a, b = a[across], b[across]
			f = (bl - a[:, 0]) / np.where(b[:, 0] != a[:, 0], b[:, 0] - a[:, 0], 1)
			return a[:, 1] + f * (b[:, 1] - a[:, 1])

		for sec in F["lex"]["underside"]["value"]:
			station = sec["station"]
			if station not in (296, 357):
				continue
			outline = np.array(traced[str(station)]["outline"], float)
			halves = [np.stack([outline[:-1] * [k, 1], outline[1:] * [k, 1]], 1) for k in (1, -1)]
			q = jet.cut(["lex_right"], [station, 100, 0], [1, 0, 0])[:, [2, 1]].reshape(-1, 2, 2)
			flat = [bl for bl, _ in sec["heights"] if 26 <= bl <= 38]
			keel = float(np.median([crossing(q, bl).max() - np.mean([crossing(h, bl).max() for h in halves]) for bl in flat]))
			for bl, height in sec["heights"]:
				low = crossing(q, bl)
				yield result("lex.underside", f"FS {station} LEX underside at BL {bl:g}, above the keel its top sets", height, float(low.min()) - keel if len(low) else math.nan, 1.0)

	yield from guard("lex.underside", "LEX underside", underside)

	# The LEX's apex and fence (tp3111's base; the photos' apex and top corners)
	def lex_parts():
		start = F["layout"]["lex"]["apex"]
		edge = jet.points(["lex_right"])
		tip = edge[edge[:, 0] < edge[:, 0].min() + 0.3]
		yield result("layout.lex", "LEX apex", start["station"], edge[:, 0].min(), 0.5, "FS in")
		yield result("layout.lex", "LEX apex", start["waterline"], tip[:, 1].mean(), 1.0, "WL in")
		# from its apex the blade leaves the wall as an edge, not a slab, and
		# its top climbs aft with its root, without steps, where its span grows
		# (ahead of FS 253): the change in its climb between sections 1.5 in apart
		first = jet.cut(["lex_right"], [start["station"] + 0.1, 100, 0], [1, 0, 0])
		yield result("layout.lex", "LEX's section at its apex, its height", 0.0, float(np.ptp(first[:, 1])) if len(first) else math.nan, 0.1)
		tops = [jet.cut(["lex_right"], [s, 100, 0], [1, 0, 0])[:, 1].max() for s in np.arange(start["station"] + 1.5, 253, 1.5)]
		yield result("layout.lex", "LEX's top ahead of FS 253, its largest change of climb between sections 1.5 in apart", 0.0, float(np.abs(np.diff(tops, 2)).max()), 0.15)
		# its edge's waterline where the side photos see it: the top of the
		# lip at the section's outermost buttline
		for station, waterline in F["layout"]["lex"]["edge"]:
			cut = jet.cut(["lex_right"], [station, 100, 0], [1, 0, 0]).reshape(-1, 3)
			lip = cut[cut[:, 2] > cut[:, 2].max() - 0.05] if len(cut) else cut
			yield result("layout.lex", f"LEX edge at FS {station}", waterline, float(lip[:, 1].max()) if len(lip) else math.nan, 0.3, "WL in")
		base = F["lex"]["fence"]["value"]
		plate = jet.points(["lex_fence_right"])
		low = plate[plate[:, 1] < plate[:, 1].min() + 1.5]
		yield result("lex.fence", "fence base's leading end", base["leading"], low[:, 0].min(), 0.5, "FS in")
		yield result("lex.fence", "fence base's trailing end", base["trailing"], low[:, 0].max(), 0.5, "FS in")
		yield result("lex.fence", "fence base", base["buttline"], low[:, 2].mean(), 0.5, "BL in")
		lex_top = jet.cut(["lex_right"], [(base["leading"] + base["trailing"]) / 2, 100, 0], [1, 0, 0])
		floor = lex_top[np.abs(lex_top[:, 2] - base["buttline"]) < 1.0][:, 1].max()
		yield result("lex.fence", "fence height above the LEX", base["height"], plate[:, 1].max() - floor, 1.0)
		for key, corner in (("front", 0), ("aft", 1)):
			want = F["layout"]["lex"]["fence"][key]
			top = plate[plate[:, 1] > plate[:, 1].max() - 1.0]
			got = top[np.argmin(top[:, 0])] if key == "front" else top[np.argmax(top[:, 0])]
			yield result("layout.lex", f"fence's top {key} corner", want[0], got[0], 0.6, "FS in")

	yield from guard("lex.fence", "LEX fence", lex_parts)

	# The panel lines, cast onto the skin as the photos saw it, lie on the skin
	# as built: the paint lays each on the nearest surface and refuses one
	# standing more than an inch off, so a skin moved since a line was cast
	# shows here, in a draft, rather than only when the paint is baked
	def panels():
		p = F["layout"]["panels"]
		skin = jet.points(every).reshape(-1, 3, 3)
		for k, (line, sides) in enumerate([(l, [1]) for l in p["lines"]] + [(l, [1, -1]) for l in p["mirrored"]]):
			worst = 0.0
			for side in sides:
				corners = np.array(line, float) * [1, 1, side]
				dense = np.concatenate([np.linspace(q, r, max(2, int(np.ceil(np.linalg.norm(r - q) / 0.5)) + 1)) for q, r in zip(corners, corners[1:])])
				low, high = dense.min(0) - 3, dense.max(0) + 3
				# every triangle whose box meets the line's (a large one may have no corner near it)
				near = skin[((skin.min(1) <= high) & (skin.max(1) >= low)).all(1)]
				if not len(near):
					raise KeyError(f"no skin near panel line {k}")
				worst = max(worst, float(surface_distance(dense, near).max()))
			yield result("layout.panels", f"panel line {k} (FS {line[0][0]:.0f}-{line[-1][0]:.0f}) off the skin, the furthest", 0.0, worst, 1.0)
		# and the LEX's root slot, painted the same way (layout.lex slot)
		slot = F["layout"]["lex"]["slot"]
		for side, name in ((1, "right"), (-1, "left")):
			ends = np.array([slot["front"], slot["aft"]], float) * [1, 1, side]
			dense = np.linspace(ends[0], ends[1], int(np.ceil(np.linalg.norm(ends[1] - ends[0]) / 0.5)) + 1)
			low, high = dense.min(0) - 3, dense.max(0) + 3
			near = skin[((skin.min(1) <= high) & (skin.max(1) >= low)).all(1)]
			if not len(near):
				raise KeyError(f"no skin near the {name} LEX's slot")
			yield result("layout.lex", f"{name} LEX's slot off the skin, the furthest", 0.0, float(surface_distance(dense, near).max()), 1.0)

	yield from guard("layout.panels", "panel lines", panels)

	# The LEX runs into the wing with no step: its aft end, behind the
	# junction, settles onto what lies beneath it, and nothing beneath pokes up
	# through its upper surface (a near-level crossing shows as a ragged line)
	def blend():
		junction = value(F["wing"]["junction"])
		lex_points = jet.points(["lex_right"])
		end = lex_points[:, 0].max()
		yield result("shape.lex", "LEX's aft end behind the LEX-wing junction (a square end sits on it)", 40.0, min(end - junction, 40.0), 20.0)
		beneath = ["fuselage", "inlet_right", "splitter_right", "wing_inner_right", "flap_leading_inner_right"]
		under = np.concatenate([jet.points([n]).reshape(-1, 3, 3) for n in beneath if n in jet.parts()])
		stations, buttlines = np.arange(200.0, end + 0.5, 1.0), np.arange(15.0, 60.5, 1.0)
		L = heights(jet.points(["lex_right"]).reshape(-1, 3, 3), stations, buttlines)
		U = heights(under, stations, buttlines)
		covered = ~np.isnan(L)
		# the body's own wall rises at the LEX's root: judge the blade, 2 in out from it
		root = np.array([np.nanmin(np.where(covered[:, i], buttlines, np.nan)) if covered[:, i].any() else np.inf for i in range(len(stations))])
		blade = covered & (buttlines[:, None] > root[None, :] + 2)
		# any at all: a skin a hundredth of an inch through shows as a speck
		poke = blade & (U > L)
		yield result("shape.lex", "LEX's upper surface something pokes through", 0.0, float(poke.sum()), 0.0, "sq in")
		tail = blade & (stations[None, :] > end - 4)
		# most of it: a cell on the wing's root rib sees the fuselage below the rib
		gap = float(np.nanpercentile(np.where(tail, L - U, np.nan), 95)) if tail.any() else 0.0
		yield result("shape.lex", "LEX's end standing above what lies beneath (a step), 95% of it", 0.0, gap, 0.6)
		# the inner wing's root ends at BL 39.9 standing above the nacelle's shoulder: the fairing beside it
		# covers it (the wing read half an inch out, clear of its root's edge)
		cells = np.array([39.5, 40.5])
		over = heights(jet.points(["lex_right"]).reshape(-1, 3, 3), stations, cells)[0]
		wing = heights(jet.points(["wing_inner_right"]).reshape(-1, 3, 3), stations, cells)[1]
		span = (stations > junction) & np.isfinite(wing)
		bare = np.where(span & np.isfinite(over), wing - over, np.where(span, np.inf, -np.inf))
		yield result("shape.lex", "wing's root end standing above the LEX fairing beside it, the most", 0.0, max(float(bare.max()), 0.0), 0.05)
		# no hollow under the LEX: the inner wing's leading edge inboard of the
		# junction, every inch over BL 40-54, lies inside the LEX, the fuselage,
		# the inlet and the splitter (a ray each way along each axis meets one),
		# and a ray aft from FS 300 between the body and the LEX's edge, WL
		# 112-124, meets the LEX (or the splitter under it) first, not the
		# fuselage or the wing through a cavity
		front = []
		for bl in np.arange(40.5, 54.5, 1.0):
			q = jet.cut(["wing_inner_right"], [400, 100, bl], [0, 0, 1])
			if len(q):
				front.append(q[np.argmin(q[:, 0])])
		if len(front) < 14:
			raise KeyError("the inner wing's leading edge over BL 40-54")
		shell = jet.points(["lex_right", "fuselage", "inlet_right", "splitter_right"]).reshape(-1, 3, 3)
		yield result("shape.lex", "inner wing's leading edge points over BL 40-54 not enclosed by the LEX, fuselage, inlet and splitter", 0, int((~enclosed(np.array(front), shell)).sum()), 0, "points")
		names = sorted(jet.parts())
		every = [jet.points([n]).reshape(-1, 3, 3) for n in names]
		owner = np.concatenate([np.full(len(t), k) for k, t in enumerate(every)])
		every = np.concatenate(every)
		# those under the LEX's top at the junction, half an inch down (a ray
		# over it runs on above the wing to the fins)
		section = jet.cut(["lex_right"], [junction, 100, 0], [1, 0, 0]).reshape(-1, 2, 3)

		def lid(b):
			a, c = section[:, 0], section[:, 1]
			across = (a[:, 2] - b) * (c[:, 2] - b) <= 0
			f = (b - a[across, 2]) / np.where(c[across, 2] != a[across, 2], c[across, 2] - a[across, 2], 1)
			return float((a[across, 1] + f * (c[across, 1] - a[across, 1])).max(initial=-np.inf))
		rays = np.array([[300.0, w, b] for w in np.arange(112.0, 124.5, 1.0) for b in np.arange(25.0, 52.5, 1.0) if w <= lid(b) - 0.5])
		if not len(rays):
			raise ValueError("no LEX over the rays")
		# the triangles their path can cross
		path = (every[:, :, 0].max(1) >= 300.0) & (every[:, :, 1].max(1) >= 112.0) & (every[:, :, 1].min(1) <= 124.0) & (every[:, :, 2].max(1) >= 25.0) & (every[:, :, 2].min(1) <= 52.0)
		index, _ = hits(every[path], rays, np.array([1.0, 0.0, 0.0]))
		owner = owner[path]
		# the position lamp's lens lies on the LEX's top near its edge, where a
		# ray kept half an inch under the top at the junction can skim the top
		wrong = [names[owner[k]] for k in index if k >= 0 and not (names[owner[k]].startswith(("lex_", "lamp_position_lex_")) or names[owner[k]] == "splitter_right")]
		yield result("shape.lex", f"rays aft under the LEX, WL 112-124, BL 25-52, meeting another part first, of {len(rays)}" + (f" ({', '.join(sorted(set(wrong)))})" if wrong else ""), 0, len(wrong), 0, "rays")

	yield from guard("shape.lex", "LEX blend", blend)

	# Wing planform, thickness, dihedral
	w = F["wing"]
	semispan = value(F["reference"]["span"]) * 12 / 2
	root, tip = value(w["root"]), value(w["tip"])
	taper = tip / root
	sweep = leading_sweep(value(w["sweep"]), value(w["aspect"]), taper)
	mean = (semispan / 3) * (1 + 2 * taper) / (1 + taper)
	leading = value(F["reference"]["leading"]) - mean * math.tan(math.radians(sweep))

	def wing():
		names = [n.format(s="right") for n in WING]
		samples = {}
		for b in (60, 80, 100, 130, 160, 180, 200, 220):
			q = jet.cut(names, [400, 100, b], [0, 0, 1])
			front, back = q[np.argmin(q[:, 0])], q[np.argmax(q[:, 0])]
			samples[b] = (front, back)
			yield result("wing.root", f"BL {b} leading edge", leading + b * math.tan(math.radians(sweep)), front[0], 0.5, "FS in")
			yield result("wing.tip", f"BL {b} chord", root + (tip - root) * b / semispan, back[0] - front[0], 0.5)
		# chord plane falls outboard with the anhedral
		a, b = samples[80][0], samples[220][0]
		yield result("layout.wing", "leading edge's slope, BL 80 to 220", F["layout"]["wing"]["dihedral"], math.degrees(math.atan((b[1] - a[1]) / 140)), 0.2, "deg")
		plane = F["layout"]["wing"]
		q = jet.cut(names, [400, 100, plane["buttline"]], [0, 0, 1])
		front, back = q[np.argmin(q[:, 0])], q[np.argmax(q[:, 0])]
		yield result("layout.wing", f"chord plane at BL {plane['buttline']}", plane["value"], (front[1] + back[1]) / 2, 0.5, "WL in")
		# thickness: cr3608's stations (wing station taken as buttline)
		for fact, station, expected in (("wing.airfoil.root", 56.876, value(w["airfoil"]["root"])), ("wing.airfoil.middle", 145.39, value(w["airfoil"]["middle"])),
				("wing.airfoil.tip", semispan - 1, value(w["airfoil"]["tip"]))):
			q = jet.cut(names, [400, 100, station], [0, 0, 1])
			chord = q[:, 0].max() - q[:, 0].min()
			thickest, where = 0.0, 0.0
			for x in np.linspace(q[:, 0].min() + chord * 0.05, q[:, 0].max() - chord * 0.05, 60):
				near = q[np.abs(q[:, 0] - x) < chord * 0.012]
				if len(near) >= 2 and near[:, 1].max() - near[:, 1].min() > thickest:
					thickest, where = near[:, 1].max() - near[:, 1].min(), (x - q[:, 0].min()) / chord
			yield result(fact, f"BL {station:.1f} thickness", expected, 100 * thickest / chord, 0.15, "% chord")
			if fact == "wing.airfoil.middle":
				yield result("airfoils", "NACA 65A's thickest point", 0.40, where, 0.06, "of chord")
		fold = jet.hinge("wing_right")
		yield result("wing.fold", "fold line", value(w["fold"]), fold[2], 0.3, "BL in")
		# the fold's hinge along the upper skin's peak over the fold line, so the
		# outer panel's root face swings up clear of the inner panel's
		skin = jet.cut(["wing_inner_right"], [400, 100, value(w["fold"]) - 0.1], [0, 0, 1])
		yield result("wing.fold", "fold hinge's height, the inner panel's upper skin's peak at the fold line", skin[:, 1].max(), fold[1], 0.1, "WL in")
		yield result("wing.span", "wingtip at the launcher rail (a sketch, so loosely)", value(w["span"]), jet.points(names)[:, 2].max(), 3.0, "BL in")
		inner = jet.points(["flap_leading_inner_right"])
		end = inner[inner[:, 2] < inner[:, 2].min() + 0.2]
		yield result("wing.junction", "inboard leading-edge flap's inner end (the LEX-wing junction)", value(w["junction"]),
			end[:, 0].min(), 1.0, "FS in")
		# the reference planform: area, mean chord and its leading edge, from the cuts
		bs = np.linspace(60, semispan - 0.5, 40)
		chords, fronts = [], []
		for b in bs:
			q = jet.cut(names, [400, 100, b], [0, 0, 1])
			chords.append(q[:, 0].max() - q[:, 0].min())
			fronts.append(q[:, 0].min())
		c0, c1 = np.polyfit(bs, chords, 1)[::-1]
		f0, f1 = np.polyfit(bs, fronts, 1)[::-1]
		yield result("reference.area", "trapezoidal wing area, to the centreline", value(F["reference"]["area"]), 2 * (c0 + (c0 + c1 * semispan)) / 2 * semispan / 144, 4, "ft2")
		lam = (c0 + c1 * semispan) / c0
		mac = c0 * (2 / 3) * (1 + lam + lam * lam) / (1 + lam)
		ymac = (semispan / 3) * (1 + 2 * lam) / (1 + lam)
		yield result("reference.chord", "mean aerodynamic chord", value(F["reference"]["chord"]) * 12, mac, 1.0)
		yield result("reference.leading", "mean chord's leading edge", value(F["reference"]["leading"]), f0 + f1 * ymac, 0.5, "FS in")
		yield result("reference.span", "reference span (wingtip to wingtip)", value(F["reference"]["span"]) * 12, 2 * jet.points(names)[:, 2].max(), 1.0)
		yield result("wing.sweep", "quarter-chord sweep", value(w["sweep"]), math.degrees(math.atan(f1 + 0.25 * c1)), 0.2, "deg")
		# hinged surfaces: planform areas, both sides. The flaps' area is not
		# built: their fronts stand on the hinge line (layout.hinge), below
		areas = value(w["areas"])
		for fact_key, nodes in (("aileron", ["aileron_{s}"]), ("lef", ["flap_leading_inner_{s}", "flap_leading_outer_{s}"])):
			total = sum(verify.area(jet.tris([n.format(s=s)]), FRAME.axes @ [0, 1, 0]) / 2 for n in nodes for s in ("left", "right")) / 0.0254 ** 2 / 144
			yield result("wing.areas", f"{fact_key} area, both sides", areas[fact_key], total, areas[fact_key] * 0.03, "ft2")
		# the flap's and aileron's fronts, as shares of the wing's chord half-way
		# along each, against the hinge line the photos from below show
		hinge = value(F["layout"]["hinge"])
		# (the flap's built on it; the aileron's, set by its cited area, within an inch)
		for part, reach_, tolerance in (("flap_trailing", F["layout"]["surfaces"]["tef"], 0.003), ("aileron", F["layout"]["surfaces"]["aileron"], 0.015)):
			b = (reach_[0] + reach_[1]) / 2
			chord = jet.cut([n.format(s="right") for n in WING], [0, 0, b], [0, 0, 1])
			front = jet.cut([f"{part}_right"], [0, 0, b], [0, 0, 1])[:, 0].min()
			yield result("layout.hinge", f"{part.split('_')[0]}'s front at BL {b:.0f}, share of the chord", hinge, (front - chord[:, 0].min()) / np.ptp(chord[:, 0]), tolerance, "of chord")
		inner_area = verify.area(jet.tris(["flap_leading_inner_right"]), FRAME.axes @ [0, 1, 0]) / 2 / 0.0254 ** 2 / 144
		yield result("wing.lef", "each inboard leading-edge flap's share of the total", value(w["lef"]), inner_area / areas["lef"], 0.01, "of total")

	yield from guard("wing", "wing", wing)

	# The bend under load (layout.flex): the tips rise as the facts say at 1 g,
	# along the span as the ground test bent, nothing inboard of the junction
	# moves, and the outer panel and the hinged surfaces stay on the bent wing:
	# closely at 1 g, and within the limit load's slip at 7.5 g (a shape key
	# moves in a straight line and cannot follow a bend joint's turn to second
	# order, so the long flaps' ends slide along their seams by about the
	# square of the turn: 0.2 in at 7.5 g with a 2.1 in rise, 1.1 in with 5 in)
	def flex():
		f = F["layout"]["flex"]
		for side in ("left", "right"):
			outer, inner = f"wing_outer_{side}", f"wing_inner_{side}"
			rest, one = jet.points([outer]), jet.points([outer], {"load": 1})
			tip = np.abs(rest[:, 2]) >= np.abs(rest[:, 2]).max() - 0.5
			yield result("layout.flex", f"{side} wingtip's rise at 1 g", f["rise"], (one - rest)[tip, 1].mean(), 0.1)
			# the bend's shape along the span, against the ground test's
			both = jet.points([inner, outer]); lifted = jet.points([inner, outer], {"load": 1})
			rise = (one - rest)[tip, 1].mean()
			# (each streamwise section moves whole, so the rise is a function of the buttline)
			buttlines, rises = np.abs(both[:, 2]), (lifted - both)[:, 1]
			order = np.argsort(buttlines)
			for station, share in f["shape"]:
				if not buttlines.min() <= station <= buttlines.max():
					raise KeyError(f"not built: the {side} wing at BL {station}")
				yield result("layout.flex", f"{side} wing's rise at BL {station}, as a share of the tip's", share, np.interp(station, buttlines[order], rises[order]) / rise, 0.07, "of the tip's")
			# each bend joint turns its part, with the bend joints above it, by the
			# wing's own slope at its buttline: the hinge lines follow the bend.
			# The mesh's slope is its ring segment's (rings about 20 in apart),
			# within 1 mrad of the bend's; a turn left out misses by all of it
			# (7.5 mrad and up, 2.6 for one riding the fold's)
			def slope(bl):
				return slope_at(buttlines[order], rises[order], bl)

			posed = verify.pose(jet.joints, {"load": 1})
			carriers = sorted(n for n in jet.joints if n.startswith("flex_") and n.endswith(f"_{side}"))
			if not carriers:
				raise KeyError(f"not built: the {side} wing's bend joints")
			for name in carriers:
				turn, i = 0.0, jet.model.index[name]
				while i is not None:
					node = jet.model.nodes[i]["name"]
					if jet.joints.get(node, {}).get("motion") == "bend":
						turn += posed[node][2][0]
					i = jet.model.nodes[i]["parent"]
				yield result("layout.flex", f"{name}'s turn at 1 g, the wing's slope at its buttline", slope(abs(jet.hinge(name)[2])) * 1000, turn * 1000, 1.5, "mrad")
				# and its hinge point rises with the wing there
				origin = FRAME.source(jet.model.worlds(posed)[jet.model.index[name]][:3, 3][None])[0]
				bl = abs(jet.hinge(name)[2])
				yield result("layout.flex", f"{name}'s point's rise at 1 g, the wing's at its buttline", np.interp(bl, buttlines[order], rises[order]), origin[1] - jet.hinge(name)[1], 0.05)
			still = np.abs(jet.points([inner])[:, 2]) <= f["root"]
			if not still.any():
				raise KeyError(f"not built: {inner} inboard of the junction")
			yield result("layout.flex", f"{side} wing inboard of the junction moving at 7.5 g", 0.0, np.abs(jet.points([inner], {"load": 7.5}) - jet.points([inner]))[still].max(), 0.01)
			for a, b in ((inner, outer), (inner, f"flap_trailing_{side}"), (inner, f"flap_leading_inner_{side}"), (outer, f"aileron_{side}"), (outer, f"flap_leading_outer_{side}")):
				A, B = jet.points([a]), jet.points([b])
				near = np.linalg.norm(A[:, None] - B[None], axis=2) < 0.01
				i, j = np.nonzero(near)
				if not len(i):
					raise KeyError(f"not built: a seam between {a} and {b}")
				for load, tolerance in ((1, 0.01), (7.5, 0.3)):
					gap = np.linalg.norm(jet.points([a], {"load": load})[i] - jet.points([b], {"load": load})[j], axis=1).max()
					yield result("layout.flex", f"{b} on {a}'s seam at {load} g", 0.0, gap, tolerance)

	yield from guard("layout.flex", "wing flex", flex)

	# Stabilator
	s_ = F["stabilator"]

	def stabilator():
		p = jet.points(["stabilator_left", "stabilator_right"])
		yield result("stabilator.span", "tip to tip", value(s_["span"]) * 12, p[:, 2].max() - p[:, 2].min(), 0.5)
		r = jet.points(["stabilator_right"])
		yield result("stabilator.exposed", "exposed panels' span", value(s_["exposed"]) * 12, 2 * (r[:, 2].max() - r[:, 2].min()), 1.0)
		inner, outer = r[:, 2].min(), r[:, 2].max()
		rc, tc = value(s_["root"]), value(s_["tip"])
		exposed = outer - inner
		aspect = (value(s_["exposed"]) * 12) ** 2 / (value(s_["area"]) * 144)
		lsweep = leading_sweep(value(s_["sweep"]), aspect, tc / rc)
		# the trailing corner's round (layout.stabilator_corner): the angle the
		# cited planform's tip and trailing edge include, and the station out
		# where the round leaves the trailing edge
		radius = value(F["layout"]["stabilator_corner"])
		run = exposed * math.tan(math.radians(lsweep)) + tc - rc
		included = math.pi / 2 - math.atan2(run, exposed)
		begins = outer - radius / math.tan(included / 2) * math.sin(included)
		samples = {}
		for f in (0.03, 0.5, 0.75, 0.97):
			b = inner + exposed * f
			q = jet.cut(["stabilator_right"], [600, 100, b], [0, 0, 1])
			samples[f] = q
			chord = q[:, 0].max() - q[:, 0].min()
			if b < begins:
				# a chord on the round is the round's, checked below
				yield result("stabilator.root" if f < 0.5 else "stabilator.tip", f"chord {f:.0%} out", rc + (tc - rc) * f, chord, 0.6)
		a, b = samples[0.03], samples[0.97]
		slope = (b[:, 0].min() - a[:, 0].min()) / (exposed * 0.94)
		yield result("stabilator.sweep", "leading-edge sweep (from the quarter-chord's)", lsweep, math.degrees(math.atan(slope)), 0.3, "deg")
		fa, fb = a[np.argmin(a[:, 0])], b[np.argmin(b[:, 0])]
		yield result("stabilator.dihedral", "leading edge's slope", value(s_["dihedral"]), math.degrees(math.atan((fb[1] - fa[1]) / (fb[2] - fa[2]))), 0.2, "deg")
		# cr201687's area is the theoretical planform's, with sharp corners: less
		# the two trailing corners' rounds, each the corner's sliver between the
		# round and the tip and trailing edge
		sliver = radius * radius * (1 / math.tan(included / 2) - (math.pi - included) / 2)
		area = sum(verify.area(jet.tris([f"stabilator_{s}"]), FRAME.axes @ [0, 1, 0]) / 2 for s in ("left", "right")) / 0.0254 ** 2 / 144
		yield result("stabilator.area", "exposed area, both sides, less the corners' rounds", value(s_["area"]) - 2 * sliver / 144, area, 0.3, "ft2")
		for f, key in ((0.03, "root"), (0.97, "tip")):
			q = samples[f]
			chord = q[:, 0].max() - q[:, 0].min()
			yield result("stabilator.airfoil", f"{key} thickness", value(s_["airfoil"])[key], 100 * (q[:, 1].max() - q[:, 1].min()) / chord, 0.4, "% chord")
		place = F["layout"]["stabilator"]
		front = a[:, 0].min() - (b[:, 0].min() - a[:, 0].min()) * 0.03 / 0.94
		yield result("layout.stabilator", "exposed root's leading edge", place["value"], front, 1.5, "FS in")
		yield result("layout.stabilator", "exposed root", place["buttline"], inner, 0.5, "BL in")
		yield result("layout.stabilator", "exposed root's leading edge height", place["waterline"], fa[1] - 0.03 * (fb[1] - fa[1]) / 0.94, 0.3, "WL in")
		# The tip's trailing corner rounded to layout.stabilator_corner, tangent to
		# the tip and the trailing edge: the trailing edge's line measured clear of
		# the round (3% and 70% out), and the outline at the tip and half-way
		# round the corner where a circle of that radius puts it
		clear = {}
		for f in (0.03, 0.7):
			b = inner + exposed * f
			clear[b] = jet.cut(["stabilator_right"], [600, 100, b], [0, 0, 1])[:, 0].max()
		(b0, t0), (b1, t1) = clear.items()
		slope = (t1 - t0) / (b1 - b0)
		cos = 1 / math.sqrt(1 + slope * slope)
		middle = outer - radius
		behind = t0 + slope * (middle - b0) - radius / cos
		for b, where in ((outer - 0.3, "at the tip"), (outer - radius * 0.5, "half-way round")):
			edge = jet.cut(["stabilator_right"], [600, 100, b], [0, 0, 1])[:, 0].max()
			yield result("layout.stabilator_corner", f"trailing corner's round, {where}", behind + math.sqrt(radius * radius - (b - middle) ** 2), edge, 0.4, "FS in")

	yield from guard("stabilator", "stabilator", stabilator)

	# Fins
	f_ = F["fin"]

	def fin():
		cant = math.radians(value(f_["cant"]))
		span = np.array([0, math.cos(cant), math.sin(cant)])   # (station, waterline, buttline), right fin
		p = jet.points(["fin_right", "rudder_right"])
		h = p @ span
		yield result("fin.top", "fin tip", value(f_["top"]), p[:, 1].max(), 0.5, "WL in")
		rc, tc = value(f_["root"]), value(f_["tip"])
		low, high = h.min(), h.max()
		sections = {}
		for frac in (0.03, 0.97):
			d = low + (high - low) * frac
			q = jet.cut(["fin_right", "rudder_right"], [0, 0, 0] + span * d, span)
			sections[frac] = q
			yield result("fin.root" if frac < 0.5 else "fin.tip", f"chord {frac:.0%} up", rc + (tc - rc) * frac, q[:, 0].max() - q[:, 0].min(), 0.6)
		a, b = sections[0.03], sections[0.97]
		# the leading edge's ends: the foremost point of the root's and the tip's lowest and highest inch
		root_end = p[p[:, 1] < p[:, 1].min() + 1.0]
		tip_end = p[p[:, 1] > p[:, 1].max() - 1.0]
		ends = root_end[np.argmin(root_end[:, 0])], tip_end[np.argmin(tip_end[:, 0])]
		yield result("fin.height", "height along its span (leading edge, root to tip)", value(f_["height"]), (ends[1] - ends[0]) @ span, 0.5)
		lsweep = math.degrees(math.atan(math.tan(math.radians(value(f_["sweep"]))) + 0.25 * (rc - tc) / value(f_["height"])))
		measured = math.degrees(math.atan((b[:, 0].min() - a[:, 0].min()) / ((high - low) * 0.94)))
		yield result("fin.sweep", "leading-edge sweep (from the quarter-chord's)", lsweep, measured, 0.3, "deg")
		top, bottom = b[np.argmin(b[:, 0])], a[np.argmin(a[:, 0])]
		lean = math.degrees(math.atan2(top[2] - bottom[2], top[1] - bottom[1]))
		yield result("fin.cant", "outboard lean", value(f_["cant"]), lean, 0.3, "deg")
		# toe: the root chord's heading in plan, + with the leading edge outboard
		front, back = a[np.argmin(a[:, 0])], a[np.argmax(a[:, 0])]
		yield result("fin.toe", "toe out (leading edge outboard)", value(f_["toe"]), math.degrees(math.atan2(front[2] - back[2], back[0] - front[0])), 0.2, "deg")
		normal = FRAME.axes @ np.cross([1.0, 0, 0], span)
		area = sum(verify.area(jet.tris([f"fin_{s}", f"rudder_{s}"]), normal * ([1, 1, -1] if s == "left" else 1)) / 2 for s in ("left", "right")) / 0.0254 ** 2 / 144
		yield result("fin.area", "area, both fins", value(f_["area"]), area, 2.0, "ft2")
		for frac, key in ((0.03, "root"), (0.97, "tip")):
			q = sections[frac]
			chord = q[:, 0].max() - q[:, 0].min()
			across = np.cross(span, [1, 0, 0])
			yield result("fin.airfoil", f"{key} thickness", value(f_["airfoil"])[key], 100 * ((q @ across).max() - (q @ across).min()) / chord, 0.4, "% chord")
		place = F["layout"]["fin"]
		run = (top[0] - bottom[0]) / 0.94
		yield result("layout.fin", "tip leading edge", place["tip"]["station"], top[0] + run * 0.03, 1.0, "FS in")
		yield result("layout.fin", "root leading edge", place["root"]["station"], bottom[0] - run * 0.03, 1.5, "FS in")
		# the fairing along the right fin's root, outboard: where its upper edge
		# meets the leading edge, its upper edge's height and its foot's
		# buttline at the photos' stations, its front, its upper edge's step
		# off the fin's face, and how far its foot stands outboard of the
		# face carried down (the views from behind)
		fair = place["fairing"]
		q = jet.points(["fin_fairing_right"])
		peak = q[np.argmax(q[:, 1])]
		front_top = fair["top"][0]
		yield result("layout.fin", "fairing's upper edge meeting the leading edge", front_top[0], peak[0], 1.5, "FS in")
		yield result("layout.fin", "fairing's upper edge meeting the leading edge", front_top[1], peak[1], 1.0, "WL in")
		yield result("layout.fin", "fairing's front", fair["foot"][0][0], q[:, 0].min(), 1.5, "FS in")
		for station, waterline in fair["top"][1:]:
			c = jet.cut(["fin_fairing_right"], [station, 0, 0], [1, 0, 0])
			if not len(c):
				raise KeyError(f"no fin_fairing_right at FS {station}")
			yield result("layout.fin", f"fairing's upper edge at FS {station:.0f}", waterline, c[:, 1].max(), 1.0, "WL in")
		for station, buttline in fair["foot"][1:]:
			c = jet.cut(["fin_fairing_right"], [min(station, fair["top"][-1][0] - 0.5), 0, 0], [1, 0, 0])
			if not len(c):
				raise KeyError(f"no fin_fairing_right at FS {station}")
			low = c[c[:, 1] < c[:, 1].min() + 1.0]
			yield result("layout.fin", f"fairing's foot at FS {station:.0f}", buttline, low[:, 2].max(), 1.0, "BL in")
		station, waterline = fair["top"][2]
		c = jet.cut(["fin_fairing_right"], [station, 0, 0], [1, 0, 0])
		f = jet.cut(["fin_right"], [station, 0, 0], [1, 0, 0])

		def face(wl):
			# the outermost buttline where the fin's cut (segments, point pairs) crosses WL wl
			a, b = f[0::2], f[1::2]
			hit = (a[:, 1] - wl) * (b[:, 1] - wl) < 0
			if not hit.any():
				raise KeyError(f"no fin_right face at FS {station}, WL {wl}")
			t = (wl - a[hit, 1]) / (b[hit, 1] - a[hit, 1])
			return float((a[hit, 2] + (b[hit, 2] - a[hit, 2]) * t).max())

		edge = c[c[:, 1] > c[:, 1].max() - 0.3]
		yield result("layout.fin", f"fairing's upper edge's step off the fin's face at FS {station:.0f}", fair["step"], edge[:, 2].max() - face(c[:, 1].max() - 0.15), 0.3, "in")
		w0, w1 = waterline + 5.0, waterline + 15.0
		low = c[c[:, 1] < c[:, 1].min() + 1.0]
		foot = low[np.argmax(low[:, 2])]
		carried = face(w0) + (face(w1) - face(w0)) * (foot[1] - w0) / (w1 - w0)
		yield result("layout.fin", f"fairing's foot outboard of the fin's face carried down, FS {station:.0f}", fair["standoff"], foot[2] - carried, 0.75, "in")
	yield from guard("fin", "fins", fin)

	# The plate behind the fin's root fairing (layout.fin fairing aft): its
	# upper edge's height where the photos cast it, short of its end on the
	# hinge line, and the seam step in from the band where the band ends
	def plate():
		fair = F["layout"]["fin"]["fairing"]
		q = jet.points(["fin_fairing_right"])
		end = q[:, 0].max()
		for station, waterline in fair["aft"]["top"]:
			c = jet.cut(["fin_fairing_right"], [min(station, end - 0.3), 0, 0], [1, 0, 0])
			if not len(c):
				raise KeyError(f"no fin_fairing_right at FS {station}")
			yield result("layout.fin", f"fairing's plate's upper edge at FS {station:.0f}", waterline, c[:, 1].max(), 1.0, "WL in")
		band = fair["top"][-1][0]

		def edge(station):
			# the upper edge's outermost buttline, its top 0.3 in
			c = jet.cut(["fin_fairing_right"], [station, 0, 0], [1, 0, 0])
			if not len(c):
				raise KeyError(f"no fin_fairing_right at FS {station}")
			return float(c[c[:, 1] > c[:, 1].max() - 0.3][:, 2].max())

		yield result("layout.fin", "fairing's seam step in from the band to the plate", fair["aft"]["seam"], edge(band - 0.1) - edge(band + 0.1), 0.1, "in")
		# its foot on the fin root's line the photos cast, where it turns in
		# behind the band and along the fin
		for station, buttline in fair["aft"]["foot"]:
			if not band + 0.2 < station < end - 0.2:
				continue
			c = jet.cut(["fin_fairing_right"], [station, 0, 0], [1, 0, 0])
			if not len(c):
				raise KeyError(f"no fin_fairing_right at FS {station}")
			low = c[c[:, 1] < c[:, 1].min() + 1.0]
			yield result("layout.fin", f"fairing's plate's foot at FS {station:g}", buttline, low[:, 2].max(), 0.3, "BL in")

	yield from guard("layout.fin", "fin's fairing's plate", plate)

	# The rudder's outline (layout.rudder), the right one's, in the fin's own
	# frame: each point's span from the root chord and its share of the chord
	# there, the toed chord and the swept leading edge solved out
	def rudder():
		r = F["layout"]["rudder"]
		cant, toe = math.radians(value(f_["cant"])), math.radians(value(f_["toe"]))
		rc, tc, height = value(f_["root"]), value(f_["tip"]), value(f_["height"])
		span = np.array([0.0, math.cos(cant), math.sin(cant)])
		chordwise = np.array([math.cos(toe), 0.0, -math.sin(toe)])
		sweep = math.tan(math.radians(value(f_["sweep"]))) + 0.25 * (rc - tc) / height
		basis = np.stack([span + np.array([1.0, 0.0, 0.0]) * sweep, chordwise, np.cross(span, chordwise)], 1)
		root = F["layout"]["fin"]["root"]
		points = jet.points(["rudder_right"])
		u, w, _ = np.linalg.solve(basis, (points - np.array([root["station"], root["waterline"], root["buttline"]])).T)
		x = w / (rc + (tc - rc) * u / height)
		yield result("layout.rudder", "rudder's top, of the fin's span", r["span"][1], u.max() / height, 0.005, "of the span")
		yield result("layout.rudder", "rudder's lower edge, of the fin's span", r["span"][0], u.min() / height, 0.005, "of the span")
		# its front at each of its rings, bottom to top
		rings = np.round(u, 1)
		fronts = [float(x[rings == level].min()) for level in np.unique(rings)]
		yield result("layout.rudder", f"rudder's hinge line at each of its {len(fronts)} rings, the furthest off, of the fin's chord", r["hinge"], max(fronts, key=lambda v: abs(v - r["hinge"])), 0.01, "of the chord")
		yield result("layout.rudder", "rudder's trailing edge, of the fin's chord", 1.0, float(x.max()), 0.005, "of the chord")
		low = points[points[:, 1] < points[:, 1].min() + 0.6]
		corner = low[low[:, 0] < low[:, 0].min() + 0.6].mean(0)
		yield result("layout.rudder", "rudder's lower leading corner", r["corner"][0], corner[0], 1.5, "FS in")
		yield result("layout.rudder", "rudder's lower leading corner", r["corner"][1], corner[1], 1.0, "WL in")

	yield from guard("layout.rudder", "rudders", rudder)

	# Engine, nozzles, inlets
	e_ = F["engine"]

	def engine():
		n = jet.points(sorted(n for n in jet.parts() if n.startswith("nozzle_right_petal_")))
		exit_ = n[n[:, 0] > n[:, 0].max() - 0.5]
		centre = (exit_[:, 2].max() + exit_[:, 2].min()) / 2
		at = n[:, 0].max()
		expected = value(e_["buttline"]) * 12 - (at - value(F["reference"]["station"])) * math.tan(math.radians(value(e_["angle"])))
		yield result("engine.buttline", "nozzle exit's centre on the engine axis", expected, centre, 0.5, "BL in")
		start = n[n[:, 0] < n[:, 0].min() + 0.5]
		slope = math.degrees(math.atan(((start[:, 2].max() + start[:, 2].min()) / 2 - centre) / (at - n[:, 0].min())))
		yield result("engine.angle", "nozzle axis converging aft", value(e_["angle"]), slope, 0.5, "deg")
		# 4 in behind the raked lip's aftmost point, where the cut crosses the duct whole
		lip = max(p[0] for p in F["layout"]["inlet"]["lip"].values())
		q = jet.cut(["inlet_right"], [lip + 4, 100, 0], [1, 0, 0])
		inner = min((l for l in loops(q[:, 1:].reshape(-1, 2, 2)) if len(l) > 8), key=shoelace)
		a = shoelace(inner)
		perimeter = np.linalg.norm(np.diff(inner, axis=0), axis=1).sum()
		yield result("engine.inlet", "inlet duct's hydraulic diameter, 4 in in", value(e_["inlet"]), 4 * a / perimeter, 1.0)
		# its end: the engine face's disc, its rim the duct's last ring, on the
		# engine's axis, and the duct's section a tenth of an inch ahead of it
		# (round the hub's foot, the larger loop)
		duct = jet.points(["inlet_right"])
		face = float(duct[:, 0].max())
		rim = duct[duct[:, 0] > face - 0.05]
		yield result("engine.face", "engine face's diameter, its disc's rim", value(e_["face"]), (np.ptp(rim[:, 1]) + np.ptp(rim[:, 2])) / 2, 0.3)
		axis = value(e_["buttline"]) * 12 - (face - value(F["reference"]["station"])) * math.tan(math.radians(value(e_["angle"])))
		yield result("engine.buttline", "engine face's centre on the engine axis", axis, (rim[:, 2].max() + rim[:, 2].min()) / 2, 0.3, "BL in")
		yield result("layout.nozzle", "engine face's centre on the nozzles' axis's waterline", F["layout"]["nozzle"]["waterline"], (rim[:, 1].max() + rim[:, 1].min()) / 2, 0.3, "WL in")
		q = jet.cut(["inlet_right"], [face - 0.1, 100, 0], [1, 0, 0])
		outer = max((l for l in loops(q[:, 1:].reshape(-1, 2, 2)) if len(l) > 8), key=shoelace)
		perimeter = np.linalg.norm(np.diff(outer, axis=0), axis=1).sum()
		yield result("engine.face", "inlet duct's hydraulic diameter at the engine face", value(e_["face"]), 4 * shoelace(outer) / perimeter, 0.5)

	yield from guard("engine", "engine", engine)

	# The inlet's mouth and splitter plate where the photos put them
	def inlet():
		place = F["layout"]["inlet"]
		lip = place["lip"]
		measured = np.array([lip[k] for k in ("top", "bottom", "outer", "corner_top", "corner_bottom")], float)
		plane = np.linalg.lstsq(np.c_[np.ones(len(measured)), measured[:, 1], measured[:, 2]], measured[:, 0], rcond=None)[0]
		duct = jet.points(["inlet_right"])
		# the lip as built: the front edge and the ring 1.6 in behind it, found
		# from the mesh (the most forward points along the lip's slant), so an
		# inlet built in the wrong place reads as misses, not as nothing
		ahead = plane[0] + plane[1] * duct[:, 1] + plane[2] * duct[:, 2] - duct[:, 0]
		front = duct[ahead > ahead.max() - 1.9]

		def pick(values, how):
			return float(how(values)) if len(values) else float("nan")

		yield result("layout.inlet", "lip's top", lip["top"][1], pick(front[:, 1], np.max), 1.0, "WL in")
		yield result("layout.inlet", "lip's bottom", lip["bottom"][1], pick(front[:, 1], np.min), 1.0, "WL in")
		yield result("layout.inlet", "lip's outboard side", lip["outer"][2], pick(front[:, 2], np.max), 1.0, "BL in")
		for key in ("top", "bottom"):
			p = lip[f"corner_{key}"]
			near = front[np.abs(front[:, 1] - p[1]) < 1.0]
			yield result("layout.inlet", f"flat inboard side at its {key} corner", p[2], pick(near[:, 2], np.min), 1.0, "BL in")
			p = lip[key]
			near = front[np.abs(front[:, 1] - p[1]) < 1.0]
			yield result("layout.inlet", f"lip's station at its {key}", p[0], pick(near[:, 0], np.min), 1.0, "FS in")
		# the front edge (the one ring ahead of the rest) against the traced outline
		edge = np.unique(duct[ahead > ahead.max() - 0.2][:, [1, 2]].round(4), axis=0)
		centre = edge.mean(axis=0)
		edge = edge[np.argsort(np.arctan2(edge[:, 1] - centre[1], edge[:, 0] - centre[0]))]
		a, b = edge, np.roll(edge, -1, axis=0)
		worst = 0.0
		for q in np.array(place["outline"], float):
			s = np.clip(((q - a) * (b - a)).sum(1) / np.maximum(((b - a) ** 2).sum(1), 1e-12), 0, 1)
			worst = max(worst, float(np.linalg.norm(a + s[:, None] * (b - a) - q, axis=1).min()))
		yield result("layout.inlet", "lip's front edge off the traced outline, worst", 0.0, worst, 1.0)
		plate = jet.points(["splitter_right"])
		traced = place["splitter"]["edge"]
		for what, p in (("top", traced[0]), ("middle", traced[len(traced) // 2]), ("bottom", traced[-1])):
			near = plate[np.abs(plate[:, 1] - p[1]) < 0.6]
			yield result("layout.inlet", f"splitter's leading edge at its {what}", p[0], pick(near[:, 0], np.min), 1.0, "FS in")
			yield result("layout.inlet", f"splitter's buttline at its {what}", p[2], pick(near[:, 2], np.max), 0.5, "BL in")
		# the duct runs to the engine face, X/D 6.5 behind the lip's top
		# (layout.inlet duct face, engine.inlet), its hub ahead of it
		face = lip["top"][0] + place["duct"]["face"] * value(F["engine"]["inlet"])
		hub = place["duct"]["hub"][1]
		yield result("layout.inlet", "inlet duct's end, the engine face's station", face, float(jet.points(["inlet_left"])[:, 0].max()), 0.3, "FS in")
		# the duct as deep as dvids8025511 sees into it: each sight line through
		# the far edge of its lit floor and walls ends on the left inlet's duct,
		# nothing else ahead of it, at least 30 in past the lip, on its walls
		# (a face across the duct short of the engine face, a cap, meets the
		# line head on: its normal within 37 deg of the jet's axis)
		sight = place["duct"]["sight"]
		eye = np.array(sight["eye"], float)
		every, own = jet.tris(sorted(jet.parts())), jet.tris(["inlet_left"])
		for k, far in enumerate(sight["far"]):
			direction = FRAME.axes @ (np.array(far, float) - eye)
			direction /= np.linalg.norm(direction)
			start = FRAME.model(eye[None])[0]
			d, mine = first_hit(every, start, direction), first_hit(own, start, direction)
			if d is None:
				raise ValueError(f"sight line {k + 1} meets nothing")
			hit = FRAME.source((start + direction * d)[None])[0]
			past = hit[0] - (plane[0] + plane[1] * hit[1] + plane[2] * abs(hit[2]))
			yield result("layout.inlet", f"dvids8025511's sight line {k + 1} into the left duct ending on another part", 0, int(mine is None or mine > d + 1e-6), 0, "lines")
			yield result("layout.inlet", f"dvids8025511's sight line {k + 1} into the left duct ending short of 30 in past the lip", 0.0, max(30.0 - past, 0.0), 0.0)
			met = head_on(own, start, direction)
			across = met is not None and met[1] and met[0] < face - hub - 0.5
			yield result("layout.inlet", f"dvids8025511's sight line {k + 1} into the left duct ending on a face across it short of the engine face", 0, int(across), 0, "lines")
		# nothing else of the jet inside the ducts: rays from each duct's axis
		# (the middle of its section, the inner loop ahead of where the outer
		# skin ends), every 6 in from 20 in behind the lip to the hub, aft and
		# sideways, meet its own walls or engine face first and from the front:
		# another part met first stands in the duct, none at all leaves through
		# a hole, and a face met from behind is turned away from the duct
		stations = np.arange(lip["top"][0] + 20, face - hub - 1, 6.0)
		for side in ("left", "right"):
			count = strays(jet, f"inlet_{side}", stations)
			yield result("layout.inlet", f"rays from the {side} duct's axis, aft and sideways, 24 from each of {len(stations)} points, meeting another part or none before its walls and engine face, or those from behind", 0, count, 0, "rays")

	yield from guard("layout.inlet", "inlet", inlet)

	# The nacelles' lowest line: on the HATP side view's keel line (its traced
	# centre, unsmoothed), through the in-flight photo's outline behind the
	# lip, and on to the nozzles
	def nacelle():
		n = F["layout"]["nacelle"]
		drawn = json.loads((HERE / "references" / "profiles.json").read_text())["side"]
		keel = dict(zip(drawn["stations"], drawn["keel"]))
		low, high = n["keel"]

		def bottom(station, side):
			q = jet.cut(["fuselage", f"inlet_{side}"], [station, 100, 0], [1, 0, 0])
			out = q[:, 2] * (1 if side == "right" else -1)
			near = q[(out > 12) & (out < 50)]
			if not len(near):
				raise KeyError(f"nothing of the {side} nacelle at FS {station}")
			return float(near[:, 1].min())

		aft = n["aft"]
		# the outline follows the keel line until the doors' blister leaves it
		high = min(high, n["door"][0][0])
		for side in ("left", "right"):
			misses = [bottom(s, side) - keel[s] for s in range(int(low), int(high) + 1, 8)]
			yield result("layout.nacelle", f"{side} nacelle's bottom off the HATP keel line, FS {low}-{high}, worst", 0.0, max(misses, key=abs), 1.0)
			for s in (650, 666, 685):
				yield result("layout.nacelle", f"{side} nacelle's bottom at FS {s}", float(np.interp(s, [k[0] for k in aft], [k[1] for k in aft])), bottom(s, side), 1.0, "WL in")
			# the blister's knots, but its last, which only shapes its step up
			# onto the nacelle's own line, crossing it before
			for s, w in n["door"][:-1]:
				yield result("layout.nacelle", f"{side} nacelle's bottom at FS {s:g} (the main gear doors' blister)", w, bottom(s, side), 0.5, "WL in")
			for s, w in n["line"]:
				yield result("layout.nacelle", f"{side} nacelle's bottom at FS {s:g} (the photos' lower outline)", w, bottom(s, side), 0.5, "WL in")
		# the outer face between the flap and the stabilator through the photos'
		# strips at its widest line and its lower corner seen from below
		def outer(station, waterline, side):
			# the outline's buttline at the waterline, between its points just
			# above and just below, on the outer face
			q = jet.cut(["fuselage"], [station, 100, 0], [1, 0, 0])
			sign = 1 if side == "right" else -1
			face = q[(q[:, 2] * sign > 30) & (np.abs(q[:, 1] - waterline) < 4)]
			above, below = face[face[:, 1] >= waterline], face[face[:, 1] < waterline]
			if not len(above) or not len(below):
				raise KeyError(f"nothing of the {side} nacelle's side at FS {station}, WL {waterline}")
			a = above[np.argmax(above[:, 2] * sign - 10 * (above[:, 1] - waterline))]
			b = below[np.argmax(below[:, 2] * sign - 10 * (waterline - below[:, 1]))]
			f = (waterline - b[1]) / ((a[1] - b[1]) or 1)
			return float(abs(b[2] + (a[2] - b[2]) * f))

		# the main gear bay's corner (layout.nacelle bay): the bottom's outboard
		# edge along its knots, where the eases leave it whole; the band above
		# it at the outer door's hinge, and the crease
		bay = F["layout"]["nacelle"]["bay"]

		def edge(station, buttline, side):
			# the skin's lowest waterline where the station's cut crosses the buttline
			q = jet.cut(["fuselage"], [station, 100, 0], [1, 0, 0]).reshape(-1, 2, 3)
			sign = 1 if side == "right" else -1
			a, b = q[:, 0], q[:, 1]
			hit = (a[:, 2] * sign - buttline) * (b[:, 2] * sign - buttline) < 0
			if not hit.any():
				raise KeyError(f"nothing of the {side} nacelle at FS {station}, BL {buttline}")
			t = (buttline - a[hit, 2] * sign) / (b[hit, 2] * sign - a[hit, 2] * sign)
			return float((a[hit, 1] + (b[hit, 1] - a[hit, 1]) * t).min())

		f0, f1, f2, f3 = bay["fade"]
		hinge = F["layout"]["gear"]["doors"]["outer"]["hinge"]
		across = lambda s: float(np.interp(s, [k[0] for k in bay["buttline"]], [k[1] for k in bay["buttline"]]))
		crease, beside = bay["crease"]
		for side in ("left", "right"):
			for s, w in bay["edge"]:
				if f1 <= s <= f2:
					yield result("layout.nacelle", f"{side} main gear bay's outboard edge at FS {s:g}", w, edge(s, across(s) - 0.5, side), 1.0, "WL in")
			for s in hinge[:2]:
				yield result("layout.nacelle", f"{side} main gear bay's band at the outer door's hinge, FS {s:g}", across(s), outer(s, (edge(s, across(s) - 0.5, side) + crease) / 2, side), 1.0, "BL in")
			yield result("layout.nacelle", f"{side} main gear bay's crease, FS {hinge[0]:g}", beside, outer(hinge[0], crease, side), 1.0, "BL in")
			# aft of the door, where its buttline eases in
			yield result("layout.nacelle", f"{side} main gear bay's corner at FS 594", across(594), outer(594, edge(594, across(594) - 0.5, side) + 1.0, side), 1.0, "BL in")
		# and between them the face is not hollow: no point of it inside the
		# chord from the line to the corner, wherever the side reshapes it (the
		# union swelling the face at the line pinched it 0.6 in at FS 548)
		top = float(np.mean([p[1] for p in n["side"]["line"]]))
		low = float(np.mean([p[1] for p in n["side"]["corner"]]))
		start, end = n["side"]["fade"]
		for side in ("left", "right"):
			for s, w, b in n["side"]["line"] + n["side"]["corner"]:
				yield result("layout.nacelle", f"{side} nacelle's outer face at FS {s:g}, WL {w:g}", b, outer(s, w, side), 0.5, "BL in")
			worst, where = 0.0, None
			# where the LAU-116's fairing stands over the cheek box, the skin
			# under it is gone (the hidden faces' cull): its own rows judge it
			covered = (F["layout"]["nacelle"]["cheek"]["front"], F["layout"]["stores"]["lau116"]["fairing"]["top"][-1][0])
			for station in range(int(start) + 40, int(end) - 39, 4):
				if covered[0] <= station <= covered[1]:
					continue
				upper, lower = outer(station, top, side), outer(station, low, side)
				for share in (0.25, 0.5, 0.75):
					w = low + (top - low) * share
					hollow = lower + (upper - lower) * share - outer(station, w, side)
					if hollow > worst:
						worst, where = hollow, (station, w)
			label = f" (at FS {where[0]}, WL {where[1]:.1f})" if where else ""
			yield result("layout.nacelle", f"{side} nacelle's outer face hollow between its line and its lower corner, the deepest{label}", 0.0, worst, 0.25)
		for s, w, sigma in n["photo"]:
			yield result("layout.nacelle", f"left nacelle's bottom at FS {s} (dvids6696790's outline)", w, bottom(s, "left"), sigma, "WL in")
		# the photo's outline falls from just behind the lip's rim, stepping 0.8
		# in below it and on at 0.13 in/in to FS 447: no level stretch first
		rim = F["layout"]["inlet"]["lip"]["bottom"][0] + 1.5
		yield result("layout.nacelle", "underside's fall over the 4 in behind the lip's rim", -0.15, (bottom(rim + 4, "left") - bottom(rim, "left")) / 4, 0.07, "in/in")

	yield from guard("layout.nacelle", "nacelle", nacelle)

	# The box on the right nacelle's side over the cheek station, airframe, at
	# rest with no stores: its aft edge at its station, on the face's plane,
	# its front, its top and bottom along their lines, its face on its leaning
	# plane, its aft face sweeping back from the skin, and its outboard face
	# where a ray in from outboard meets the jet first
	def outboard():
		every = jet.tris(sorted(jet.parts()))
		for station in (545.0, 560.0):
			d = first_hit(every, FRAME.model(np.array([[station, 82.0, 80.0]]))[0], FRAME.axes @ np.array([0.0, 0.0, -1.0]))
			yield result("layout.nacelle", f"first skin a ray in from outboard meets at FS {station:g}, WL 82, no stores", cheek_face(station, 82.0), 80.0 - d / FRAME.unit if d is not None else math.nan, 0.1, "BL in")

	yield from guard("layout.nacelle", "cheek box's face", outboard)

	def cheek():
		box = F["layout"]["nacelle"]["cheek"]
		edge, front, face, inset = box["edge"], box["front"], box["face"], F["layout"]["stores"]["lau116"]["fairing"]["inset"]
		line = lambda knots, s: float(np.interp(s, *zip(*knots)))
		q = jet.points(["fairing_cheek_right"])
		section = lambda station: jet.cut(["fairing_cheek_right"], [station, 100, 0], [1, 0, 0])
		aft = q[q[:, 0] > edge - 0.05]
		middle = (line(box["top"], edge) + line(box["bottom"], edge)) / 2
		yield result("layout.nacelle", "cheek box's aft edge, its station", edge, q[:, 0].max(), 0.05, "FS in")
		run, round_ = box["sweep"]["run"], box["sweep"]["round"]
		quarter = lambda u: 1 - math.sqrt(1 - min(1.0, max(0.0, u)) ** 2)
		yield result("layout.nacelle", "cheek box's aft edge halfway up 0.05 in ahead of its tip, its buttline (the face's plane, rounding in)",
			cheek_face(edge, middle) - round_ * quarter(1 - 0.05 / round_), across_at(section(edge - 0.05), middle), 0.05, "BL in")
		yield result("layout.nacelle", "cheek box's aft edge, its top", line(box["top"], edge), aft[:, 1].max(), 0.05, "WL in")
		yield result("layout.nacelle", "cheek box's aft edge, its bottom", line(box["bottom"], edge), aft[:, 1].min(), 0.05, "WL in")
		# its outboard face on its plane, leaning in going up: an inch above its
		# bottom and below its top, beside the slot where the lean was measured
		# and over the box behind the louvres
		for station in (face["station"] - 1.0, 545.0):
			for w in (line(box["bottom"], station) + 1.0, line(box["top"], station) - 1.0):
				yield result("layout.nacelle", f"cheek box's face at FS {station:g}, WL {w:.1f}, its buttline", cheek_face(station, w), across_at(section(station), w), 0.1, "BL in")
		# its front, where the fairing over it steps in from its top corner (the
		# block's face ahead of it running on up its plane, cheek_ring()), and
		# its top corner just behind it at its height; its top along its line,
		# read at its outboard corner
		over = np.interp(q[:, 0], *zip(*box["top"]))
		band = q[(q[:, 1] > over + 0.2) & (q[:, 1] < over + 0.5)]
		flush = band[np.abs(band[:, 2] - cheek_face(band[:, 0], band[:, 1])) < inset / 3]
		yield result("layout.nacelle", "cheek box's front, its station (where the fairing over it steps in from the LAU-116's face)", front, flush[:, 0].max() if len(flush) else math.nan, 0.05, "FS in")
		def corner(station, want):
			# the section's highest point within a tenth of an inch of the face's
			# plane, short of half an inch over the top's line (above it the
			# fairing over the box, set in, crosses the plane run on)
			c = section(station)
			return c[(np.abs(c[:, 2] - cheek_face(station, c[:, 1])) < 0.1) & (c[:, 1] < want + 0.5)]

		c = corner(front + 0.3, line(box["top"], front + 0.3))
		yield result("layout.nacelle", "cheek box's top front corner, its height", line(box["top"], front + 0.3), c[:, 1].max() if len(c) else math.nan, 0.05, "WL in")
		for station, want in box["top"][1:4]:
			c = corner(station, want)
			yield result("layout.nacelle", f"cheek box's top at FS {station:g}", want, c[:, 1].max() if len(c) else math.nan, 0.1, "WL in")
		# the slot in its face behind its front (cheek slot): a ray in from
		# outboard at its middle falls to its floor, its depth inside the face;
		# its front and aft ends and its bottom and top edges where rays 0.1 in
		# apart along its middle start and stop falling in past half that
		slot = box["slot"]
		(s0, s1), (w0, w1) = slot["stations"], slot["waterlines"]
		faces = jet.tris(["fairing_cheek_right"])
		inward = FRAME.axes @ np.array([0.0, 0.0, -1.0])

		def sunk(station, waterline):
			d = first_hit(faces, FRAME.model(np.array([[station, waterline, 80.0]]))[0], inward)
			return cheek_face(station, waterline) - (80.0 - d / FRAME.unit) if d is not None else math.nan

		ms, mw = (s0 + s1) / 2, (w0 + w1) / 2
		yield result("layout.nacelle", "cheek box's slot's depth at its middle", slot["depth"], sunk(ms, mw), 0.05)
		fell = [st for st in np.arange(s0 - 1.0, s1 + 1.0, 0.1) if sunk(st, mw) > slot["depth"] / 2]
		yield result("layout.nacelle", "cheek box's slot's front", s0, min(fell) if fell else math.nan, 0.15, "FS in")
		yield result("layout.nacelle", "cheek box's slot's aft end", s1, max(fell) if fell else math.nan, 0.15, "FS in")
		fell = [w for w in np.arange(w0 - 1.0, w1 + 1.0, 0.1) if sunk(ms, w) > slot["depth"] / 2]
		yield result("layout.nacelle", "cheek box's slot's bottom edge", w0, min(fell) if fell else math.nan, 0.15, "WL in")
		yield result("layout.nacelle", "cheek box's slot's top edge", w1, max(fell) if fell else math.nan, 0.15, "WL in")
		for station, want in box["bottom"][1:-1]:
			c = section(station)
			yield result("layout.nacelle", f"cheek box's bottom at FS {station:g}", want, c[:, 1].min() if len(c) else math.nan, 0.1, "WL in")
		# the station's top meeting the nacelle's skin (cheek_ring()): its highest
		# point at each of the ramp's and the fairing's knots, and behind the
		# fairing where the box's top meets it (the innermost of its level top),
		# on the skin the station stands on
		lau = F["layout"]["stores"]["lau116"]
		knots = [k[0] for k in lau["fairing"]["ramp"]["top"][1:] + lau["fairing"]["top"][:-1]] + [550.0, 555.0]
		for station in knots:
			c = section(station).reshape(-1, 3)
			skin = jet.cut(["fuselage"], [station, 100, 0], [1, 0, 0]).reshape(-1, 2, 3)
			skin = skin[(skin[:, :, 2] > 30).all(1)][:, :, 1:]
			gap = math.nan
			if len(c) and len(skin):
				level = c[c[:, 1] > c[:, 1].max() - 0.05]
				top = level[np.argmin(level[:, 2]), 1:]
				a_, d_ = skin[:, 0], skin[:, 1] - skin[:, 0]
				t = np.clip(((top - a_) * d_).sum(1) / np.maximum((d_ * d_).sum(1), 1e-12), 0, 1)
				gap = float(np.linalg.norm(a_ + d_ * t[:, None] - top, axis=1).min())
			yield result("layout.nacelle", f"cheek station's top at FS {station:g}, how far off the nacelle's skin", 0.0, gap, 0.1)
		# its aft face, sweeping back from the skin out to the aft edge (sweep):
		# where it leaves the skin, the foremost station whose section halfway
		# up shows a face inboard of the outboard face's (ahead of it the skin
		# under the box is culled, and the box's side on it); and halfway along
		# its run its standoff from the skin, as a share of the tip's:
		# a quarter ellipse's (layout.nacelle cheek sweep), concave, leaving the
		# skin along it
		half = lambda station: (line(box["top"], station) + line(box["bottom"], station)) / 2
		leaves = next((st for st in np.arange(edge - run - 3.0, edge, 0.1) if across_at(section(st), half(st), inboard=True) < cheek_face(st, half(st)) - 0.5), math.nan)
		yield result("layout.nacelle", "cheek box's aft face, where it leaves the skin", edge - run, leaves, 1.0, "FS in")
		st = edge - run / 2
		skin = jet.cut(["fuselage"], [st, 100, 0], [1, 0, 0]).reshape(-1, 2, 3)
		skin = across_at(skin[(skin[:, :, 2] > 30).all(1)].reshape(-1, 3), half(st))
		yield result("layout.nacelle", f"cheek box's aft face halfway along its run (FS {st:g}), its standoff from the skin as a share of the aft edge's tip's",
			quarter(0.5), (across_at(section(st), half(st), inboard=True) - skin) / (cheek_face(st, half(st)) - round_ - skin), 0.05)

	yield from guard("layout.nacelle", "cheek box", cheek)

	# Every store part shown, nothing standing outside the cheek box's outboard
	# face over its length: a ray in from outboard every inch along the box and
	# every half inch up its face meets the box before any store part, or a
	# store part no further out than the box's face beside it
	def clear():
		box = F["layout"]["nacelle"]["cheek"]
		edge, front = box["edge"], box["front"]
		line = lambda knots, s: float(np.interp(s, *zip(*knots)))
		drives = {"stores": 1}
		stored = jet.tris(sorted(n for n in jet.parts(drives) if STATION.match(n)), drives)
		face = jet.tris(["fairing_cheek_right"], drives)
		inward = FRAME.axes @ np.array([0.0, 0.0, -1.0])
		worst, where = 0.0, None
		for station in np.arange(front + 0.5, edge - 0.25, 1.0):
			for w in np.arange(line(box["bottom"], station) + 0.25, line(box["top"], station) - 0.2, 0.5):
				origin = FRAME.model(np.array([[station, w, 80.0]]))[0]
				hit = first_hit(stored, origin, inward)
				if hit is None:
					continue
				wall = first_hit(face, origin, inward)
				out = (wall - hit) / FRAME.unit if wall is not None else (80.0 - hit / FRAME.unit) - cheek_face(station, w)
				if out > worst:
					worst, where = out, (station, w)
		label = f" (at FS {where[0]:g}, WL {where[1]:.1f})" if where else ""
		yield result("layout.nacelle", f"store parts standing outside the cheek box's outboard face, stores shown, the furthest{label}", 0.0, worst, 0.05)

	yield from guard("layout.nacelle", "cheek box's face with the stores", clear)

	# The band between the nacelles: the skin's lowest point at each measured
	# drain, grille corner, hole, pin and seam (both sides where off the
	# centreline) and at the inner doors' triangulated inboard corners, within
	# the photos' spread
	def band():
		b = F["layout"]["band"]
		m = b["measured"]

		def lowest(station, buttline):
			# the section's segments across the buttline, the lowest crossing
			q = jet.cut(["fuselage"], [station, 100, 0], [1, 0, 0]).reshape(-1, 2, 3)
			a, b = q[:, 0], q[:, 1]
			across = (a[:, 2] - buttline) * (b[:, 2] - buttline) <= 0
			f = (buttline - a[across, 2]) / np.where(b[across, 2] != a[across, 2], b[across, 2] - a[across, 2], 1)
			wl = a[across, 1] + f * (b[across, 1] - a[across, 1])
			wl = wl[wl < 95]
			if not len(wl):
				raise KeyError(f"no skin under BL {buttline} at FS {station}")
			return float(wl.min())

		for s, w, bl, what in m["centre"]:
			for side in ((1, -1) if abs(bl) > 1 else (1,)):
				yield result("layout.band", f"belly at the {what}, FS {s:g}, BL {side * abs(bl):g}", w, lowest(s, side * abs(bl)), m["tolerance"], "WL in")
		for s, bl, w in m["floor"]:
			for side in (1, -1):
				yield result("layout.band", f"belly at the inner door's inboard edge, FS {s:g}, BL {side * bl:g}", w, lowest(s, side * bl), m["tolerance"], "WL in")

	yield from guard("layout.band", "band", band)

	# The spine and the deck behind the LEX where the photos place them: the
	# crown in the profile, the spine's flank at its panel joints' lower ends,
	# and the deck where it meets the spine's wall
	def spine():
		sp = F["layout"]["spine"]
		skin = jet.points(["fuselage", "canopy", "lex_left", "lex_right"]).reshape(-1, 3, 3)

		def at(view, station, across):
			# the skin's height seen from a view, at one station and line, on a small even grid round it
			return float(lines(skin, view, np.array([station - 0.5, station, station + 0.5]), np.array([across - 0.5, across, across + 0.5]))[1, 1])

		for station, waterline in sp["crown"]:
			yield result("layout.spine", f"crown at FS {station:g} (dvids9820808's profile)", waterline, at("above", station, 0.0), 0.5, "WL in")
		for station, waterline, buttline in sp["flank"]:
			yield result("layout.spine", f"spine's flank at FS {station:g}, WL {waterline:g} (its panel joints' lower ends)", buttline, at("outboard", station, waterline), 1.0, "BL in")
		# the side seam behind the canopy, triangulated by two photo pairs that part
		# by 0.4-1.3 in along it: held to 0.75 in
		for station, waterline, buttline in sp["side"]:
			yield result("layout.spine", f"spine's side seam behind the canopy at FS {station:g}, WL {waterline:g}", buttline, at("outboard", station, waterline), 0.75, "BL in")
		for station, waterline, buttline in sp["rear"]:
			yield result("layout.spine", f"spine's top between the fins at FS {station:g}, BL {buttline:g}", waterline, at("above", station, buttline), 1.0, "WL in")
		for station, waterline in sp["deck"]:
			yield result("layout.spine", f"deck beside the spine at FS {station:g} (dvids9820788)", waterline, at("above", station, 24.0), 1.0, "WL in")
		# the top outline seen from the side behind the crown's last point, where
		# the sky check puts it: the highest the skin stands across the
		# buttlines (the centreline at the speedbrake's aft edge, the nacelles'
		# tops at the nozzles)
		top = jet.points(["fuselage", "speedbrake"]).reshape(-1, 3, 3)
		for station, waterline in sp["crest"]:
			crest = float(np.nanmax(lines(top, "above", np.array([station - 0.5, station, station + 0.5]), np.arange(-40.0, 40.5, 0.5))[:, 1]))
			yield result("layout.spine", f"crest at FS {station:g} (the sky check's top outline)", waterline, crest, 0.5, "WL in")

	yield from guard("layout.spine", "spine", spine)

	# The tail end (layout.spine tail): behind the speedbrake the top's
	# centreline falls into the V between the nacelles' tops, and the
	# fuselage ends inside its nozzles, but for the strip between them: every
	# face of it turned aft within an inch of its end lies inside a nozzle's
	# outer flaps' start circle (with the alternate flaps' stand) or on the
	# strip (ended on the crest it stood a flat cap between the nozzles up to
	# WL 122; on its own section, an annulus round the flaps)
	def tail():
		t = F["layout"]["spine"]["tail"]
		skin = jet.points(["fuselage"]).reshape(-1, 3, 3)
		knots = [tuple(k) for k in t["top"] if k[0] > F["layout"]["speedbrake"]["back"]]
		middle = ((knots[-2][0] + knots[-1][0]) / 2, (knots[-2][1] + knots[-1][1]) / 2)
		for station, waterline in sorted(knots + [middle]):
			at = min(station, float(skin[..., 0].max()) - 0.5)
			height = float(lines(skin, "above", np.array([at - 0.5, at, at + 0.5]), np.array([-0.5, 0.0, 0.5]))[1, 1])
			yield result("shape.tail", f"skin's top on the centreline at FS {station:g}", waterline, height, 2.0, "WL in")
		nozzle, petals = F["layout"]["nozzle"], F["layout"]["petals"]
		radius = nozzle["radius"][0] + 0.3   # the alternate flaps stand 0.3 in proud (build.py nozzles())
		end = float(skin[..., 0].max())
		n = np.cross(skin[:, 1] - skin[:, 0], skin[:, 2] - skin[:, 0])
		size = np.linalg.norm(n, axis=1)
		aft = (size > 1e-12) & (n[:, 0] < -0.5 * size) & (skin[..., 0].min(1) > end - 1.0)   # source coordinates mirror the frame's handedness
		corners = np.concatenate([skin[aft].reshape(-1, 3), skin[aft].mean(1)])
		if not len(corners):
			raise KeyError("no face of the fuselage turned aft at its end")
		e = F["engine"]
		axis = value(e["buttline"]) * 12 - (corners[:, 0] - value(F["reference"]["station"])) * math.tan(math.radians(value(e["angle"])))
		off = np.hypot(np.abs(corners[:, 2]) - axis, corners[:, 1] - nozzle["waterline"]) - radius
		# the strip between the rings, below the V's floor: the gap between
		# the two circles at each height
		rise = corners[:, 1] - nozzle["waterline"]
		gap = axis - np.sqrt(np.maximum(radius * radius - rise * rise, 0.0))
		strip = (np.abs(corners[:, 2]) <= np.maximum(gap, t["strip"] / 2 + 0.5)) & (np.abs(rise) < radius) & (corners[:, 1] <= t["top"][-1][1] + 1.5)
		yield result("shape.tail", "fuselage's end, faces turned aft outside a nozzle's flaps' start circle, off the strip between them, the furthest", 0.0, float(max(off[~strip].max(), 0.0)) if (~strip).any() else 0.0, 0.5)
		# the lip over the flaps' forward ends (layout.nacelle end), round its
		# upper half from the V's wall to the nacelle's widest line, half an
		# inch aft of their start: the least the skin stands outside the
		# flaps, along its facets (on the circle itself the alternate flaps
		# showed through it in teeth)
		station = nozzle["start"] + 0.5
		axis = value(e["buttline"]) * 12 - (station - value(F["reference"]["station"])) * math.tan(math.radians(value(e["angle"])))

		def round_axis(names):
			# the right side's cut, along its segments, as (up, out) from the axis
			cut = jet.cut(names, np.array([station, 0.0, 0.0]), np.array([1.0, 0.0, 0.0])).reshape(-1, 2, 3)
			p = (cut[:, :1, :] + (cut[:, 1:, :] - cut[:, :1, :]) * np.linspace(0.0, 1.0, 11)[None, :, None]).reshape(-1, 3)
			p = p[p[:, 2] > 0]
			return np.c_[p[:, 1] - nozzle["waterline"], p[:, 2] - axis]

		skin_ = round_axis(["fuselage"])
		skin_ = skin_[np.hypot(skin_[:, 0], skin_[:, 1]) < F["layout"]["nacelle"]["end"]["radius"] + 1.0]
		least = lip(skin_, round_axis(sorted(n for n in jet.parts() if n.startswith("nozzle_right_petal_"))), range(-60, 96, 2))
		if np.isnan(least):
			raise KeyError("no lip over the right nozzle's flaps")
		yield result("shape.tail", "nacelle's lip over its flaps' forward ends: the least it stands outside them round its upper half", 0.1, least, 0.08)
		# the V's skin, from the speedbrake's aft edge to an inch short of the
		# end and inside the nacelles' tops, folds no sharper than its floor's
		# edges (the union of the body and the nacelles left a groove along
		# each of the strip's edges at FS 680-684, and twisted the facets
		# between 60-100 deg)
		v = skin[(skin[..., 0].min(1) > F["layout"]["speedbrake"]["back"]) & (skin[..., 0].max(1) <= end - 1.0 + 1e-3) & (np.abs(skin[..., 2]).max(1) < 16.0) & (skin[..., 1].min(1) > nozzle["waterline"] + 4.0)]
		yield result("shape.tail", "the V's skin behind the speedbrake: its sharpest fold between neighbouring faces (its floor's edges turn up to 45 deg)", 0.0, folds(v), 45.0, "deg")

	yield from guard("shape.tail", "tail", tail)

	# The forebody's keel where the photos' lower outline puts it (layout.belly)
	def belly():
		skin = jet.points(["fuselage"]).reshape(-1, 3, 3)
		for station, waterline in F["layout"]["belly"]["keel"][1:-1]:
			low = float(lines(skin, "below", np.array([station - 0.5, station, station + 0.5]), np.array([-0.5, 0.0, 0.5]))[1, 1])
			yield result("layout.belly", f"keel at FS {station:g} (the photos' lower outline)", waterline, low, 0.4, "WL in")

	yield from guard("layout.belly", "belly", belly)

	# Fittings
	def fittings():
		g = F["fittings"]["gun"]
		muzzle = FRAME.source(jet.document["points"]["gun"]["muzzle"])
		yield result("fittings.gun", "gun muzzle station", g["station"], muzzle[0], 1.0, "FS in")
		q = jet.cut(["fuselage"], [g["station"], 100, 0], [1, 0, 0])
		yield result("fittings.gun", "gun muzzle on the top centreline", q[:, 1].max(), muzzle[1], 0.5, "WL in")
		pr = F["layout"]["probe"]
		door = jet.points(["probe_door"])
		yield result("layout.probe", "probe door's forward end", pr["from"], door[:, 0].min(), 1.0, "FS in")
		yield result("layout.probe", "probe door's aft end", pr["to"], door[:, 0].max(), 1.0, "FS in")
		# the door lies on the skin: no corner more than an inch outside the fuselage's section there
		worst = 0.0
		for s in np.linspace(pr["from"] + 2, pr["to"] - 2, 8):
			body = jet.cut(["fuselage"], [s, 100, 0], [1, 0, 0])
			centre = np.array([(body[:, 1].max() + body[:, 1].min()) / 2, 0.0])
			d = jet.cut(["probe_door"], [s, 100, 0], [1, 0, 0])
			for wl, bl in d[:, 1:]:
				theta = math.atan2(bl, wl - centre[0])
				rays = body[:, 1:] - centre
				angle = np.arctan2(rays[:, 1], rays[:, 0])
				skin = np.linalg.norm(rays[np.argmin(np.abs(angle - theta))])
				worst = max(worst, math.hypot(wl - centre[0], bl) - skin)
		yield result("layout.probe", "probe door's height above the skin", 0.3, worst, 0.7)
		# its edges round the section at its middle: the lower from the photos, the upper from tm101724
		s = (pr["from"] + pr["to"]) / 2
		body = jet.cut(["fuselage"], [s, 100, 0], [1, 0, 0])
		middle = (body[:, 1].max() + body[:, 1].min()) / 2
		d = jet.cut(["probe_door"], [s, 100, 0], [1, 0, 0])
		round_from_top = np.degrees(np.arctan2(np.abs(d[:, 2]), d[:, 1] - middle))
		yield result("layout.probe", "probe door's lower edge round from the top", pr["lower"], round_from_top.max(), 2.0, "deg")
		yield result("layout.probe", "probe door's upper edge round from the top", pr["upper"], round_from_top.min(), 2.0, "deg")
		# the skin opened ahead of the door for the stowed nozzle, closed by a
		# door of its own from the opening's forward end to the probe door (the
		# seam between them shape.flush's); the stowed probe within it
		forward = jet.points(["probe_door_forward"])
		yield result("layout.probe", "probe's forward door's forward end, the opening's", pr["opening"], forward[:, 0].min(), 0.1, "FS in")
		probe = jet.points(["probe"])
		yield result("layout.probe", "stowed probe reaching ahead of the skin's opening", 0.0, max(0.0, pr["opening"] - probe[:, 0].min()), 0.01)
		# the angle-of-attack probes: the plate's centre, and the cone standing out of it
		aoa = F["layout"]["aoa"]
		for name in ("aoa_left", "aoa_right"):
			p = jet.points([name])
			# the plate: all but the cone's outer part
			plate = p[np.abs(p[:, 2]) < np.abs(p[:, 2]).max() - 2.0]
			middle = np.array([(plate[:, 0].min() + plate[:, 0].max()) / 2, (plate[:, 1].min() + plate[:, 1].max()) / 2])
			rim = plate[np.hypot(plate[:, 0] - middle[0], plate[:, 1] - middle[1]) > 2.0]
			yield result("layout.aoa", f"{name} plate's station", aoa["station"], middle[0], 0.5, "FS in")
			yield result("layout.aoa", f"{name} plate's waterline", aoa["waterline"], middle[1], 0.5, "WL in")
			yield result("layout.aoa", f"{name} plate's diameter", aoa["plate"], plate[:, 0].max() - plate[:, 0].min(), 0.3)
			yield result("layout.aoa", f"{name} cone standing out of the plate", aoa["cone"], np.abs(p[:, 2]).max() - np.abs(rim[:, 2]).mean(), 0.5)
			# the plate laid on the skin, not a flat disc standing off its curve
			painted = jet.model.parts(verify.pose(jet.joints, {}), materials=("paint",)).get(name, np.zeros((0, 3, 3)))
			yield result("layout.aoa", f"{name} plate off the skin, its furthest", 0.06, aloft(painted, jet.tris(["fuselage"])), 0.03)
			# and laid once where it shows, round the flange: lofted apart, the
			# plate and its seam each closed an end with a disc lying on the
			# plate's face, and the three fought there in shards. Under the
			# flange the plate's disc and the flange's foot lie hidden in each
			# other
			own = jet.tris([name])
			normal = np.cross(own[:, 1] - own[:, 0], own[:, 2] - own[:, 0])
			size = np.linalg.norm(normal, axis=1)
			normal = normal / np.maximum(size, 1e-12)[:, None]
			step = 0.005 * FRAME.unit
			sealant = jet.model.parts(verify.pose(jet.joints, {}), materials=("rubber",)).get(name)
			centre = sealant.reshape(-1, 3).mean(0) if sealant is not None else own.reshape(-1, 3).mean(0)
			seen = np.linalg.norm(own.mean(1) - centre, axis=1) > (aoa["flange"][0] / 2 + 0.05) * FRAME.unit
			doubled = sum(1 for k in np.nonzero((size > 0) & seen)[0]
				if (d := first_hit(np.delete(own, k, 0), own[k].mean(0) - normal[k] * step, normal[k])) is not None and d < 2 * step)
			yield result("layout.aoa", f"{name}'s faces lying on another of its own", 0, doubled, 0, "faces")
			# and painted as the skin round it: joined to its seam, the seam's
			# rubber took the plate's edge texels and drew in dark scallops
			# (on a painted build)
			image = atlas(jet.path, "paint")
			if image is not None:
				tris, uvs = jet.textured(("paint",), [name])
				skin, skin_uvs = jet.textured(("paint",), ["fuselage"])
				middle = tris.reshape(-1, 3).mean(0)
				around = np.linalg.norm(skin.mean(1) - middle, axis=1)
				skin, skin_uvs = skin[(around > 4) & (around < 8)], skin_uvs[(around > 4) & (around < 8)]
				spread = np.random.default_rng(0).dirichlet([1, 1, 1], 8)
				plate = sample(image, np.einsum("pk,tkc->tpc", spread, uvs).reshape(-1, 2))
				beside = float(np.median(sample(image, np.einsum("pk,tkc->tpc", spread, skin_uvs).reshape(-1, 2))))
				yield result("layout.aoa", f"{name} plate's share darker than the skin round it", 0.0, float((plate < 0.85 * beside).mean()), 0.03, "share")
			# the probe polished metal, as the photos show it, on its flange and
			# tapering the whole way out to a blunt tip: its diameters read
			# square to its own axis, out from the flange's top
			metal = jet.model.parts(verify.pose(jet.joints, {}), materials=("chrome",)).get(name)
			if metal is None:
				raise KeyError(f"{name}: no polished metal")
			c = FRAME.source(metal.reshape(-1, 3))
			along = np.linalg.svd(c - c.mean(0))[2][0]
			if (c[np.argmax(np.abs(c[:, 2]))] - c.mean(0)) @ along < 0:
				along = -along
			s = (c - c.mean(0)) @ along
			s -= s.min()
			r = np.linalg.norm((c - c.mean(0)) - np.outer((c - c.mean(0)) @ along, along), axis=1)
			width, thick = aoa["flange"]
			# out from the flange's top, its wall's highest corner: its foot
			# lies under the plate's face, where the cull of hidden faces
			# takes what it will
			top = float(s[r > width / 2 - 0.03].max())
			yield result("layout.aoa", f"{name} flange's diameter", width, 2 * float(r[s < top + 0.005].max()), 0.05)
			for d, w in aoa["profile"][1:-1:2]:
				ring = r[np.abs(s - (top + d)) < 0.01]
				yield result("layout.aoa", f"{name} probe's diameter {d:g} in out", w, 2 * float(ring.max()) if len(ring) else 0.0, 0.03)
			# blunt: its last ring before the tip's round as wide as the photos' tip
			d, w = aoa["profile"][-1]
			ring = r[np.abs(s - (top + d)) < 0.01]
			yield result("layout.aoa", f"{name} probe's tip, its width before its round", w, 2 * float(ring.max()) if len(ring) else 0.0, 0.03)
			grey = jet.model.parts(verify.pose(jet.joints, {}), materials=("hub",)).get(name)
			yield result("layout.aoa", f"{name} probe's faces in the gear's grey, not metal", 0, 0 if grey is None else len(grey), 0, "faces")
			# the plate's rim a dark seam, the photos' sealant ring
			dark = jet.model.parts(verify.pose(jet.joints, {}), materials=("rubber",)).get(name)
			ring = FRAME.source(dark.reshape(-1, 3)) if dark is not None else np.zeros((0, 3))
			reach = np.hypot(ring[:, 0] - middle[0], ring[:, 1] - middle[1]) if len(ring) else np.zeros(1)
			yield result("layout.aoa", f"{name} plate's dark rim, its inner edge from the centre", aoa["plate"] / 2 - aoa["rim"], float(reach.min()), 0.15)
		# the pitot-static tubes: the photos' tip and strut, tm101724's extent
		pt, cited = F["layout"]["pitot"], F["fittings"]["pitot"]
		parts = jet.model.parts(verify.pose(jet.joints, {}), materials=("chrome",))
		plates = jet.model.parts(verify.pose(jet.joints, {}), materials=("rubber",))
		for name in ("pitot_left", "pitot_right"):
			p = jet.points([name])
			yield result("layout.pitot", f"{name} tip", pt["tip"][0], p[:, 0].min(), 0.5, "FS in")
			front = p[p[:, 0] < pt["tip"][0] + 0.5]
			yield result("layout.pitot", f"{name} tip's waterline", pt["tip"][1], (front[:, 1].min() + front[:, 1].max()) / 2, 0.5, "WL in")
			yield result("layout.pitot", f"{name} tube's buttline", pt["buttline"], np.abs((front[:, 2].min() + front[:, 2].max()) / 2), 0.3, "BL in")
			metal = FRAME.source(parts[name].reshape(-1, 3)) if name in parts else np.full((1, 3), np.nan)
			yield result("layout.pitot", f"{name} strut's aft root", pt["root"][1], metal[:, 0].max(), 0.5, "FS in")
			yield result("fittings.pitot", f"{name} forward end", cited["from"], p[:, 0].min(), 1.0, "FS in")
			yield result("fittings.pitot", f"{name} aft end", cited["to"], p[:, 0].max(), 1.0, "FS in")
			# the tube's taper, its diameter across at each station of its
			# profile and where it holds the tube's diameter, ahead of the strut
			(point, end), (lead, trail) = pt["tip"], pt["foot"]
			for d, width in [(d, w) for d, w in pt["profile"] if d > 0] + [((lead - point) - 0.4, pt["tube"])]:
				q = jet.cut([name], [point + d, 100, 0], [1, 0, 0])
				got = np.ptp(q[:, 1]) if len(q) else math.nan
				yield result("layout.pitot", f"{name} tube's diameter {d:g} in aft of its tip", width, got, 0.05)
			# the tube's aft end at the strut's trailing foot, and the strut's
			# chord halfway down, between its root's and its foot's
			axis = end + pt["rise"]
			tube = metal[metal[:, 1] < axis + pt["tube"] / 2 + 0.05]
			yield result("layout.pitot", f"{name} tube's aft end", trail, tube[:, 0].max() if len(tube) else math.nan, 0.2, "FS in")
			middle = (pt["waterline"] + axis) / 2
			q = jet.cut([name], [170, middle, 0], [0, 1, 0])
			q = q[q[:, 0] < pt["root"][1] + 1] if len(q) else q
			yield result("layout.pitot", f"{name} strut's leading edge halfway down", (pt["root"][0] + lead) / 2, q[:, 0].min() if len(q) else math.nan, 0.4, "FS in")
			yield result("layout.pitot", f"{name} strut's trailing edge halfway down", (pt["root"][1] + trail) / 2, q[:, 0].max() if len(q) else math.nan, 0.4, "FS in")
			# the dark plate round its root laid on the skin, a pin's height off it
			outline = np.array(pt["plate"])
			flange = FRAME.source(plates[name].reshape(-1, 3)) if name in plates else np.full((1, 3), np.nan)
			yield result("layout.pitot", f"{name} plate's forward end", outline[:, 0].min(), flange[:, 0].min(), 0.2, "FS in")
			yield result("layout.pitot", f"{name} plate's aft end", outline[:, 0].max(), flange[:, 0].max(), 0.2, "FS in")
			yield result("layout.pitot", f"{name} plate off the skin, its furthest", 0.15, aloft(plates.get(name, np.zeros((0, 3, 3))), jet.tris(["fuselage"])), 0.05)
		# the fairings on each side: tm101724's ECM covers and the photos' antenna fairings
		ecm, blisters = F["fittings"]["ecm"], F["layout"]["blisters"]
		for name in ("fairings_left", "fairings_right"):
			p = jet.points([name])
			cover = p[(p[:, 0] > ecm["station"] - ecm["length"]) & (p[:, 0] < ecm["station"] + ecm["length"] * 0.6)]
			yield result("fittings.ecm", f"{name} ECM cover's middle", ecm["station"], (cover[:, 0].min() + cover[:, 0].max()) / 2, 0.5, "FS in")
			yield result("fittings.ecm", f"{name} ECM cover's length", ecm["length"], cover[:, 0].max() - cover[:, 0].min(), 0.6)
			cut = jet.cut([name], [ecm["station"], 100, 0], [1, 0, 0])
			top = cut[np.argmax(np.abs(cut[:, 2]))]
			body = jet.cut(["fuselage"], [ecm["station"], 100, 0], [1, 0, 0])
			side = body[np.sign(body[:, 2]) == np.sign(top[2])]
			skin = np.abs(side[np.argmin(np.abs(side[:, 1] - top[1])), 2])
			yield result("fittings.ecm", f"{name} ECM cover standing off the skin", ecm["proud"], abs(top[2]) - skin, 0.3)
			for key, spec in blisters.items():
				if not isinstance(spec, list):
					continue
				first, last, wl, width, proud = spec
				q = p[(p[:, 0] > first - 1) & (p[:, 0] < last + 1) & (np.abs(p[:, 1] - wl) < width)]
				yield result("layout.blisters", f"{name} {key} fairing's forward end", first, q[:, 0].min(), 0.5, "FS in")
				yield result("layout.blisters", f"{name} {key} fairing's aft end", last, q[:, 0].max(), 0.5, "FS in")
				yield result("layout.blisters", f"{name} {key} fairing's middle", wl, (q[:, 1].min() + q[:, 1].max()) / 2, 0.7, "WL in")
		# the formation light strips
		f = F["layout"]["formation"]
		for name in ("formation_left", "formation_right"):
			p = jet.points([name])
			yield result("layout.formation", f"{name} forward end", f["from"], p[:, 0].min(), 0.5, "FS in")
			yield result("layout.formation", f"{name} aft end", f["to"], p[:, 0].max(), 0.5, "FS in")
			yield result("layout.formation", f"{name} middle", f["waterline"], (p[:, 1].min() + p[:, 1].max()) / 2, 0.5, "WL in")
			yield result("layout.formation", f"{name} height", f["height"], p[:, 1].max() - p[:, 1].min(), 0.4)
		# the simple cockpit, placed by what the reference photo shows through the canopy
		ck = F["layout"]["cockpit"]
		seat = jet.points(["cockpit_seat"])
		head = seat[seat[:, 1] > ck["headbox"][3][1] + 0.5]
		yield result("layout.cockpit", "seat's headbox top", max(p[1] for p in ck["headbox"]), seat[:, 1].max(), 0.3, "WL in")
		yield result("layout.cockpit", "seat's headbox front", min(p[0] for p in ck["headbox"]), head[:, 0].min(), 0.4, "FS in")
		yield result("layout.cockpit", "seat's headbox aft", max(p[0] for p in ck["headbox"]), head[:, 0].max(), 0.4, "FS in")
		pilot = jet.points(["pilot"])
		helmet = pilot[pilot[:, 1] > ck["helmet"]["bottom"] + 1.0]
		yield result("layout.cockpit", "helmet's top", ck["helmet"]["top"], pilot[:, 1].max(), 0.3, "WL in")
		yield result("layout.cockpit", "helmet's front", ck["helmet"]["front"], helmet[:, 0].min(), 0.5, "FS in")
		yield result("layout.cockpit", "helmet's back", ck["helmet"]["back"], helmet[:, 0].max(), 0.5, "FS in")
		hud = jet.points(["cockpit_hud"])
		yield result("layout.cockpit", "HUD frame's top", ck["hud"][1][1], hud[:, 1].max(), 0.5, "WL in")
		yield result("layout.cockpit", "HUD frame's foot", ck["hud"][0][0], hud[:, 0].min(), 0.5, "FS in")
		posts = np.abs(hud[:, 2])
		yield result("layout.cockpit", "HUD frame's posts off the centreline", ck["widths"]["hud"], float(posts[posts > ck["widths"]["hud"] / 2].mean()), 0.3, "BL in")
		top = seat[seat[:, 1] > min(p[1] for p in ck["headbox"][1:3]) - 1.0]
		yield result("layout.cockpit", "seat's headbox top, either side", ck["widths"]["headbox"], float(np.abs(top[:, 2]).max()), 0.3, "BL in")
		panel = jet.points(["cockpit_panel"])
		hood = panel[panel[:, 1] > ck["glareshield"][1] + 0.2]   # the glareshield, above the panel that meets it
		yield result("layout.cockpit", "glareshield's aft edge", ck["glareshield"][0], hood[:, 0].max(), 0.3, "FS in")
		# the cockpit lies under the canopy: nothing of it stands outside the fuselage's and canopy's sections
		inside = 0.0
		for s in np.arange(236.0, 300.0, 2.0):
			hull = jet.cut(["fuselage", "canopy"], [s, 100, 0], [1, 0, 0])
			parts = jet.cut(["cockpit_tub", "cockpit_panel", "cockpit_seat", "pilot"], [s, 100, 0], [1, 0, 0])
			if not len(hull) or not len(parts):
				continue
			for wl, bl in parts[:, 1:]:
				# the hull's half-width at this waterline, from the cut's segments' points nearest it above and below
				side = hull[np.sign(hull[:, 2]) == (np.sign(bl) or 1)]
				above, below = side[side[:, 1] >= wl], side[side[:, 1] < wl]
				if wl > hull[:, 1].max():
					inside = max(inside, wl - hull[:, 1].max())
					continue
				if not len(above) or not len(below):
					continue
				a = above[np.argmin(above[:, 1] - wl)]
				b = below[np.argmin(wl - below[:, 1])]
				f = (wl - b[1]) / ((a[1] - b[1]) or 1)
				inside = max(inside, abs(bl) - abs(b[2] + (a[2] - b[2]) * f))
		yield result("layout.cockpit", "cockpit standing outside the fuselage and canopy", 0.0, max(0.0, inside), 0.05)
		# the formation strips on the fins' and nacelles' faces and on the
		# wingtip launchers' adapters, above the rail and below it
		# (layout.strips), and the lenses on the fins, the LEX's edges and the
		# right fin's pod (layout.lights): each flush on the built face where
		# the photos put it, so a buttline off the photos' is the face's, not
		# the strip's
		st, lamps = F["layout"]["strips"], F["layout"]["lights"]["points"]
		for side, sign in (("left", -1), ("right", 1)):
			for key in ("fin", "body", "tip", "undertip"):
				p = jet.points([f"formation_{key}_{side}"])
				ends = np.array(st[key], float) * [1, 1, sign]
				middle = ends.mean(axis=0)
				axis = (ends[1] - ends[0]) / np.linalg.norm(ends[1] - ends[0])
				centre = (p.min(axis=0) + p.max(axis=0)) / 2
				# along the face where the photos put it; the face itself (the
				# buttline) within the rays' own misses, up to 2.1 in
				for i, word, tolerance in ((0, "FS", 0.8), (1, "WL", 0.8), (2, "BL", 2.0)):
					yield result("layout.strips", f"{key} strip's middle on the {side}" + (", the face it stands on" if word == "BL" else ""), middle[i], centre[i], tolerance, f"{word} in")
				along = (p - middle) @ axis
				yield result("layout.strips", f"{key} strip's length on the {side}", float(np.linalg.norm(ends[1] - ends[0])), float(along.max() - along.min()), 0.8, "in")
				if key in st["gap"]:
					# a tip strip's edge against the LAU-7's nearer edge, at the
					# strip's middle: the gap the photos show within themselves
					# the rail's edge where a vertical line through its middle
					# meets it at the strip's middle station (the rail
					# outboard of the adapter's faces); the strip's own edge
					rail = jet.points([f"rail_{1 if sign < 0 else 9}"]).reshape(-1, 3, 3)
					body = rail[(np.abs(rail[..., 2]) > 227.5).all(-1)].reshape(-1, 3)
					column = vertical(rail, middle[0], (body[:, 2].min() + body[:, 2].max()) / 2)
					near = p[np.abs(p[:, 0] - middle[0]) < 1.0]
					gap = near[:, 1].min() - column.max() if key == "tip" else column.min() - near[:, 1].max()
					yield result("layout.strips", f"{key} strip's gap to the wingtip rail's {'top' if key == 'tip' else 'bottom'} edge on the {side}", st["gap"][key], float(gap), 0.3, "in")
			# the strobes on the fins' faces (the buttline the face's), the position
			# lights under the LEX's edges (the waterline the face's)
			# and the position lights on the underwing fairings' noses, cast aft
			# and up onto them (both the station and the height the nose's)
			for key, faces in ((f"strobe_{side}", (2,)), (f"position_lex_{side}", (2,)), (f"position_fold_{side}", (0, 1))):
				p = jet.points([f"lamp_{key}"])
				centre = (p.min(axis=0) + p.max(axis=0)) / 2
				at = np.array(lamps[key]["at"], float)
				for i, word in enumerate(("FS", "WL", "BL")):
					yield result("layout.strips", f"{key} lens" + (", the face it stands on" if i in faces else ""), at[i], centre[i], 2.0 if i in faces else 0.8, f"{word} in")
			# each flush lens and strip whole on its face, none of it under the
			# skin it stands on
			for part, carrier in ((f"formation_fin_{side}", f"fin_{side}"), (f"formation_body_{side}", "fuselage"),
					(f"lamp_strobe_{side}", f"fin_{side}"), (f"lamp_position_lex_{side}", f"lex_{side}")):
				yield result("layout.strips", f"{part}'s outer face under the skin it stands on, its share", 0.0, buried(jet, part, carrier, np.array([0.0, 0.0, float(sign)])), 0.02, "share")
		# the fairings under the outer panels (layout.wing_fairing): their tips,
		# their buttline and width at the widest, their depth under the wing
		# ahead of the aileron's hinge
		uw = F["layout"]["wing_fairing"]
		body, tail = jet.points(["fairing_wing_right"]), jet.points(["fairing_aileron_right"])
		yield result("layout.wing_fairing", "front tip", uw["front"][0], body[:, 0].min(), 1.0, "FS in")
		yield result("layout.wing_fairing", "aft tip", uw["aft"][0], tail[:, 0].max(), 1.0, "FS in")
		middle = (uw["front"][0] + uw["aft"][0]) / 2
		c = jet.cut(["fairing_wing_right", "fairing_aileron_right"], [middle, 0, 0], [1, 0, 0])
		if not len(c):
			raise KeyError(f"no underwing fairing at FS {middle}")
		yield result("layout.wing_fairing", "width at its middle", uw["width"], c[:, 2].max() - c[:, 2].min(), 0.5, "in")
		yield result("layout.wing_fairing", "buttline at its middle", (uw["front"][2] + uw["aft"][2]) / 2, (c[:, 2].max() + c[:, 2].min()) / 2, 0.5, "BL in")
		station = uw["front"][0] + uw["nose"] + 4.0
		c, wing = jet.cut(["fairing_wing_right"], [station, 0, 0], [1, 0, 0]), jet.cut(["wing_outer_right", "flap_leading_outer_right"], [station, 0, 0], [1, 0, 0])
		across = (uw["front"][2] + uw["aft"][2]) / 2
		a_, b_ = wing[0::2], wing[1::2]
		hit = (a_[:, 2] - across) * (b_[:, 2] - across) < 0
		if not len(c) or not hit.any():
			raise KeyError(f"no underwing fairing or wing at FS {station}")
		t = (across - a_[hit, 2]) / (b_[hit, 2] - a_[hit, 2])
		lower = float((a_[hit, 1] + (b_[hit, 1] - a_[hit, 1]) * t).min())
		yield result("layout.wing_fairing", f"depth under the wing at FS {station:g}", uw["depth"], lower - c[:, 1].min(), 1.0, "in")
		p = jet.points(["lamp_position_tail"])
		centre = (p.min(axis=0) + p.max(axis=0)) / 2
		yield result("layout.strips", "tail light's lens, on its pod's end, off where the photos put the light", 0.0, float(np.linalg.norm(centre - np.array(lamps["position_tail"]["at"], float))), 1.5, "in")
		# the spine's antennas and the small ones under the radome
		an = F["layout"]["antennas"]
		for key in ("dorsal", "spine"):
			p = jet.points([f"antenna_{key}"])
			corners = an[key]
			yield result("layout.antennas", f"{key} blade's tip", max(w for _, w in corners), p[:, 1].max(), 0.3, "WL in")
			tip = p[p[:, 1] > p[:, 1].max() - 0.3]
			yield result("layout.antennas", f"{key} blade's tip front", corners[3][0], tip[:, 0].min(), 0.4, "FS in")
			yield result("layout.antennas", f"{key} blade's tip aft", corners[2][0], tip[:, 0].max(), 0.4, "FS in")
			yield result("layout.antennas", f"{key} blade on the centreline", 0.0, (p[:, 2].min() + p[:, 2].max()) / 2, 0.1, "BL in")
		# the blade under the forward fuselage, off the centreline
		p = jet.points(["antenna_ventral"])
		corners = an["ventral"]
		yield result("layout.antennas", "ventral blade's tip", min(c[1] for c in corners), p[:, 1].min(), 0.3, "WL in")
		# the tip's edge slopes 0.3 in, and the slab stands 0.4 in through
		tip = p[p[:, 1] < max(c[1] for c in corners[2:]) + 0.2]
		yield result("layout.antennas", "ventral blade's tip front", corners[3][0], tip[:, 0].min(), 0.4, "FS in")
		yield result("layout.antennas", "ventral blade's tip aft", corners[2][0], tip[:, 0].max(), 0.4, "FS in")
		yield result("layout.antennas", "ventral blade's tip off the centreline", (corners[2][2] + corners[3][2]) / 2, float(tip[:, 2].mean()), 0.4, "BL in")
		base = p[p[:, 1] > p[:, 1].max() - 1.3]
		yield result("layout.antennas", "ventral blade's base off the centreline", (corners[0][2] + corners[1][2]) / 2, float(base[:, 2].mean()), 0.4, "BL in")
		dome = jet.points(["antenna_dome"])
		station, waterline, buttline, diameter, proud = an["dome"]
		yield result("layout.antennas", "dome's middle", station, (dome[:, 0].min() + dome[:, 0].max()) / 2, 0.5, "FS in")
		yield result("layout.antennas", "dome's side", buttline, (dome[:, 2].min() + dome[:, 2].max()) / 2, 1.0, "BL in")
		chin = jet.points(["antenna_chin"])
		yield result("layout.antennas", "chin fairing and posts' forward end", an["chin"][0], chin[:, 0].min(), 0.5, "FS in")
		yield result("layout.antennas", "comb's aft post", an["comb"][-1] + 0.3, chin[:, 0].max(), 0.5, "FS in")
		# the antenna pods on the fins' trailing edges, each read within its own
		# band of waterlines (an empty band reads as a miss)
		for name in ("pod_left", "pod_right"):
			every = jet.points([name])
			for k, (start, end, waterline, diameter) in enumerate(F["layout"]["pods"]["list"]):
				p = every[np.abs(every[:, 1] - waterline) < diameter / 2 + 0.3]
				if not len(p):
					yield result("layout.pods", f"{name} {k}: its points", 1.0, 0.0, 0.5, "found")
					continue
				yield result("layout.pods", f"{name} {k}: front", start, p[:, 0].min(), 0.5, "FS in")
				yield result("layout.pods", f"{name} {k}: aft end", end, p[:, 0].max(), 0.5, "FS in")
				yield result("layout.pods", f"{name} {k}: middle", waterline, (p[:, 1].min() + p[:, 1].max()) / 2, 0.5, "WL in")
				yield result("layout.pods", f"{name} {k}: diameter", diameter, p[:, 1].max() - p[:, 1].min(), 0.3)
				# it straddles the fin at its middle; its blunt end stands at or past the trailing edge
				fin = jet.cut([name.replace("pod", "fin")], [(start + end) / 2, 100, 0], [1, 0, 0])
				sides = [a[2] + (b[2] - a[2]) * (waterline - a[1]) / (b[1] - a[1]) for a, b in fin.reshape(-1, 2, 3) if (a[1] - waterline) * (b[1] - waterline) <= 0 and a[1] != b[1]]
				yield result("layout.pods", f"{name} {k}: on its fin", (min(sides) + max(sides)) / 2 if sides else np.inf,
					(p[:, 2].min() + p[:, 2].max()) / 2, 0.5, "BL in")
		# the blade antenna under the nose
		b = F["layout"]["blade"]
		p = jet.points(["blade_nose"])
		bottom = p[p[:, 1] < p[:, 1].min() + 0.5]
		yield result("layout.blade", "nose blade's bottom edge", b["bottom"][2], p[:, 1].min(), 0.3, "WL in")
		yield result("layout.blade", "nose blade's bottom front corner", b["bottom"][0], bottom[:, 0].min(), 0.5, "FS in")
		yield result("layout.blade", "nose blade's bottom aft corner", b["bottom"][1], bottom[:, 0].max(), 0.5, "FS in")
		yield result("layout.blade", "nose blade on the centreline", 0.0, (p[:, 2].min() + p[:, 2].max()) / 2, 0.1, "BL in")
		hook = F["layout"]["hook"]
		h = jet.points(["hook"])
		yield result("layout.hook", "stowed hook's aftmost point, the point's", hook["point"][0], h[:, 0].max(), 0.5, "FS in")
		# the photo marks the middle of the point's end face: the mean of the
		# corners within a tenth of an inch of the furthest along the shank
		pivot = np.array(jet.hinge("hook"))
		corners = np.unique(np.round(h, 4), axis=0)
		axis = (np.array(hook["point"]) - pivot[:2]) / np.linalg.norm(np.array(hook["point"]) - pivot[:2])
		reach = (corners[:, :2] - pivot[:2]) @ axis
		face = corners[reach > reach.max() - 0.1]
		yield result("layout.hook", "stowed hook's tip height, its end face's middle", hook["point"][1], float(face[:, 1].mean()), 1.0, "WL in")
		yield result("layout.hook", "hook's pivot station", hook["pivot"][0], pivot[0], 0.1, "FS in")
		yield result("layout.hook", "hook's pivot height", hook["pivot"][1], pivot[1], 0.1, "WL in")
		yield result("layout.hook", "hook's length, pivot to tip", hook["length"], float(np.hypot(*(np.array(hook["point"]) - pivot[:2]))), 0.3, "in")
		# lowered, the shoe's lowest point in the direction the photos put it
		# from the pivot (its distance, 2.9 in past the stowed tip's, unsettled)
		down_hook = jet.points(["hook"], {"hook": 1})
		low = down_hook[np.argmin(down_hook[:, 1])]
		want = math.degrees(math.atan2(pivot[1] - hook["lowered"][1], hook["lowered"][0] - pivot[0]))
		yield result("layout.hook", "lowered hook's lowest point below the pivot's horizontal, aft", want, math.degrees(math.atan2(pivot[1] - low[1], low[0] - pivot[0])), 1.0, "deg")
		# the keel: its bottom on the photos' line, its aft end at the pivot,
		# its forward end where it leaves the body
		keel = F["layout"]["keel"]
		# the keel with its aft end, the hook's pivot fitting, which turns with
		# the hook's swing (build.py mechanisms())
		k = jet.points(["keel", "hook_swing"])
		for station, waterline in keel["bottom"]:
			near = k[np.abs(k[:, 0] - station) < 2.0]
			yield result("layout.keel", f"keel's bottom at FS {station}", waterline, float(near[:, 1].min()) if len(near) else 999.0, 0.5, "WL in")
		blade = k[k[:, 1] < 90]
		# its aft end along its bottom, below the pivot fitting that closes it
		fitting = F["layout"]["hook"]["pivot"][1] - F["layout"]["hook"]["fitting"]["radius"]
		bottom = k[k[:, 1] < fitting - 0.3]
		yield result("layout.keel", "keel's aft end, along its bottom below the pivot fitting", keel["stations"][1], float(bottom[:, 0].max()) if len(bottom) else 0.0, 1.0, "FS in")
		# measured just forward of the pivot fitting, against the taper's width there
		front, back = keel["stations"]
		at = back - F["layout"]["hook"]["fitting"]["radius"] - 2.0
		near = blade[np.abs(blade[:, 0] - at) < 1.5]
		yield result("layout.keel", f"keel's width at FS {at:.0f}, tapering to its front", keel["width"] * (at - front) / (back - front), float(np.ptp(near[:, 2])) if len(near) else 0.0, 0.6, "in")

	yield from guard("fittings", "fittings", fittings)

	# The hook's castings (layout.hook shank, head, fittings): the shank round
	# (its width across the jet and its depth square to that, cut square to its
	# line at a quarter, half and three quarters of its length); the point one
	# casting, the shank flaring into its body with no edge between them (its
	# section round the shank's line, cut every tenth of an inch from the shank
	# to the bore's ring, its equivalent radius growing by no more than FLARE
	# an inch: a body cylinder on a two-inch neck grew 0.7), the body's width
	# and top, the shoe's width, its lowest point's depth below the line and
	# place ahead of the aft face, its thickness along the shank, the through
	# bolt's heads hexagons as wide as the bolts' size spanning the bolts'
	# span, and the bore facing straight aft: a ray in along the shank's line
	# from behind meets it first (a box shank 4.4 in wide and 2.8 deep, and a
	# box shoe, were what the photos show round; a cylinder boss on a box skid
	# with round bolts what they show cast in one)
	def hook():
		k = F["layout"]["hook"]
		pivot = np.array(jet.hinge("hook"))
		line = np.array(k["point"]) - pivot[:2]
		length = float(np.linalg.norm(line))
		axis = np.array([line[0], line[1], 0.0]) / length
		up = np.array([-axis[1], axis[0], 0.0])
		up = up if up[1] > 0 else -up
		across = np.array([0.0, 0.0, 1.0])
		for share in (0.25, 0.5, 0.75):
			c = jet.cut(["hook"], pivot + axis * share * length, axis)
			if not len(c):
				raise KeyError(f"no hook shank {share:.0%} along it")
			want = float(np.interp(share, [q[0] for q in k["shank"]], [q[1] for q in k["shank"]]))
			width, depth = float(np.ptp(c[:, 2])), float(np.ptp(c @ up))
			yield result("layout.hook", f"shank's width across, {share:.0%} along it", want, width, 0.3)
			yield result("layout.hook", f"shank's depth, {share:.0%} along it", want, depth, 0.3)
			yield result("layout.hook", f"shank's depth over its width, {share:.0%} along it", 1.0, depth / width, 0.15, "ratio")
		head = k["head"]
		body, shoe, bolts = head["body"], head["shoe"], head["bolts"]
		h = jet.points(["hook"])
		end = float(((h - pivot) @ axis).max())
		face = end - head["ring"][1]   # the body's aft face, the bore's ring proud of it

		def section(s):
			# the hook's section at s along the shank square to it, round its line
			best = held(jet.cut(["hook"], pivot + axis * s, axis).reshape(-1, 2, 3), pivot + axis * s, across, up)
			if best is None:
				raise KeyError(f"no hook section round its line {s:.1f} in along it")
			return best[0][:, 0], best[0][:, 1], best[1]

		# from 2 in ahead of the flare 0.8 in into the body, ahead of the shoe
		# (the faces it encloses are culled, so the body's section opens there)
		stations = np.arange(face - body["length"] - head["flare"] - 2.0, face - body["length"] + 0.8, 0.1)
		yield result("layout.hook", "point's casting, shank into body: its section's equivalent radius's steepest change along the shank", 0.0, steepest(jet, ["hook"], pivot, axis, across, up, stations), FLARE, "in/in")
		x, y, _ = section(face - body["length"] / 2)
		yield result("layout.hook", "point's body's width across", body["width"], float(np.ptp(x)), 0.2)
		yield result("layout.hook", "point's body's top above the shank's line", body["top"], float(y.max()), 0.2)
		# the shoe: below the body
		rel = h - pivot
		low = h[(rel @ up < -(body["bottom"] + 0.5)) & (rel @ axis > face - body["length"] - head["flare"])]
		if not len(low):
			raise KeyError("no hook shoe")
		yield result("layout.hook", "point's shoe's width across", shoe["width"], float(np.ptp(low[:, 2])), 0.3)
		deepest = low[np.argmin((low - pivot) @ up)]
		yield result("layout.hook", "point's shoe's lowest point below the shank's line", shoe["reach"], float(-(deepest - pivot) @ up), 0.3)
		lean = math.radians(shoe["lean"])
		yield result("layout.hook", "point's shoe's lowest point ahead of the aft face (its lean)", shoe["recess"] + (shoe["reach"] - shoe["root"]) * math.tan(lean),
			face - float((deepest - pivot) @ axis), 0.5)
		middle = -(shoe["root"] + shoe["reach"]) / 2
		c = jet.cut(["hook"], pivot + up * middle, up)
		c = c[np.abs(c[:, 2]) < shoe["width"] / 2 - 1.0]
		if not len(c):
			raise KeyError("no hook shoe half way down it")
		yield result("layout.hook", "point's shoe's thickness along the shank half way down it", shoe["thickness"] / math.cos(lean), float(np.ptp((c - pivot) @ axis)), 0.3)
		# the bolt's heads: hexagons, cut half way out from the body's sides
		back, lift = bolts["place"]
		middle = (bolts["span"] / 2 + body["width"] / 2) / 2
		chrome = FRAME.source(jet.model.parts(verify.pose(jet.joints, {}), materials=("chrome",)).get("hook", np.zeros((0, 3, 3))).reshape(-1, 3))
		heads = []
		for sign in (-1, 1):
			centre = pivot + axis * (face - back) + up * lift
			loop = None
			for candidate in loops(jet.cut(["hook"], centre + across * sign * middle, across).reshape(-1, 2, 3)):
				if np.linalg.norm(candidate.mean(0) - (centre + across * sign * middle)) < bolts["size"]:
					loop = candidate
			if loop is None:
				raise KeyError(f"no bolt head on the hook's point, {'starboard' if sign > 0 else 'port'}")
			flat = np.c_[(loop - centre) @ axis, (loop - centre) @ up]
			yield result("layout.hook", f"point's {'starboard' if sign > 0 else 'port'} bolt head's corners, half way out", 6, corners(flat), 0, "corners")
			yield result("layout.hook", f"point's {'starboard' if sign > 0 else 'port'} bolt head across its corners", bolts["size"], float(np.max(np.linalg.norm(flat[:, None] - flat[None], axis=2))), 0.1)
			# its outer face: the farthest of its corners (the thread's end inside them)
			off = chrome - centre
			radial = np.linalg.norm(off - np.outer(off @ across, across), axis=1)
			near = chrome[(radial > 0.45) & (radial < bolts["size"] / 2 + 0.05) & (off @ across * sign > body["width"] / 2)]
			heads.append(float(np.abs((near - centre) @ across).max()) if len(near) else 0.0)
		yield result("layout.hook", "point's bolts' span across their heads", bolts["span"], sum(heads), 0.2)
		tris = jet.tris(["hook"])
		bores = jet.model.parts(verify.pose(jet.joints, {}), materials=("hub",)).get("hook")
		if bores is None:
			raise KeyError("no bore in the hook's point")
		origin = FRAME.model(pivot + axis * (end + 20.0))
		direction = FRAME.axes @ -axis
		every, bore = first_hit(tris, origin, direction), first_hit(bores, origin, direction)
		yield result("layout.hook", "point's bore: a ray in along the shank's line from behind meets it first", 0.0, abs(every - bore) / FRAME.unit if every is not None and bore is not None else 99.0, 0.01)
		# its finishes (layout.paint gear): the shank, the forging at the pivot
		# and the point white, their bolts polished and their bores dark; the
		# hold-down damper's cylinder and rod end white, its piston polished
		finishes = {}
		for tri, material in jet.model.meshes[jet.model.nodes[jet.model.index["hook"]]["mesh"]]:
			finishes[material] = finishes.get(material, 0.0) + float(np.linalg.norm(np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]), axis=1).sum() / 2)
		total = sum(finishes.values())
		yield result("layout.hook", "hook's area in neither white, the bolts' chrome nor the bores' dark", 0.0, (total - sum(finishes.get(m, 0.0) for m in ("white", "chrome", "hub"))) / total, 0.0, "share")
		source = lambda t: FRAME.source(t.reshape(-1, 3)).reshape(-1, 3, 3) if t is not None else np.zeros((0, 3, 3))
		whites = source(jet.model.parts(verify.pose(jet.joints, {}), materials=("white",)).get("hook"))
		every = source(jet.model.parts(verify.pose(jet.joints, {})).get("hook"))
		# the forging and the point all but their bolts and bores; the shank all
		for what, lo, hi, within in (("the forging at the pivot", -3.0, 8.0, 0.15), ("the shank", 0.2 * length, 0.8 * length, 0.01), ("the point", face - body["length"] - head["flare"], end, 0.15)):
			yield result("layout.hook", f"hook's {what}: its area in white", 1.0, area_within(whites, pivot, axis, lo, hi) / max(area_within(every, pivot, axis, lo, hi), 1e-9), within, "share")
		# the hold-down damper (fittings rod) telescoping between its pins: stowed,
		# its cylinder's end clear of its rod end's top; down, its piston still
		# that far inside it (its top read on the line to its rod end)
		rod = k["fittings"]["rod"]
		top = np.array([rod["top"][0], rod["top"][1], 0.0])
		for drives, what in (({}, "stowed"), ({"hook": 1}, "down")):
			cylinder_ = jet.points(["hook_rod"], drives)
			white = FRAME.source(jet.model.parts(verify.pose(jet.joints, drives), materials=("white",)).get("hook_piston", np.zeros((0, 3, 3))).reshape(-1, 3))
			chrome = FRAME.source(jet.model.parts(verify.pose(jet.joints, drives), materials=("chrome",)).get("hook_piston", np.zeros((0, 3, 3))).reshape(-1, 3))
			if not len(white) or not len(chrome):
				raise KeyError("no hook damper's rod end or piston")
			# its rod end's eye: the piston's hinge, posed
			eye = FRAME.source(jet.model.worlds(verify.pose(jet.joints, drives))[jet.model.index["hook_piston"]][:3, 3][None])[0]
			towards = eye - top
			pins = float(np.linalg.norm(towards))
			towards /= pins
			end = float(((cylinder_ - top) @ towards).max())
			if what == "stowed":
				yield result("layout.hook", "hook's damper stowed: its cylinder's end clear of its rod end's top", pins - rod["end"][0] - rod["cylinder"][1],
					float(((white - top) @ towards).min()) - end, 0.3)
			else:
				yield result("layout.hook", "hook's damper down: its piston's length still inside its cylinder", rod["cylinder"][1] - (pins - rod["end"][0] - rod["piston"]),
					end - float(((chrome - top) @ towards).min()), 0.3)
		for name, want in (("hook_rod", ("white",)), ("hook_piston", ("white", "chrome"))):
			f = {}
			for tri, material in jet.model.meshes[jet.model.nodes[jet.model.index[name]]["mesh"]]:
				f[material] = f.get(material, 0) + len(tri)
			yield result("layout.hook", f"{name}'s faces in neither {' nor '.join(want)}", 0, sum(n for m, n in f.items() if m not in want), 0, "faces")

	yield from guard("layout.hook", "hook", hook)

	# Layout placements the build should land on
	L = F["layout"]

	def placements():
		gear = L["gear"]
		for name, station, tyre in (("gear_right_wheel", gear["main"], "main"), ("gear_nose_wheel", gear["nose"], "nose")):
			p = jet.points([name], down)
			yield result("layout.gear", f"{name} axle", station, (p[:, 0].max() + p[:, 0].min()) / 2, 0.5, "FS in")
			yield result("layout.gear", f"{name} diameter", gear["tyres"][tyre]["diameter"], p[:, 1].max() - p[:, 1].min(), 0.3)
		# the tyres alone: the hubs' caps and the brakes stand out of them
		tyres = {k: FRAME.source(v.reshape(-1, 3)) for k, v in jet.model.parts(verify.pose(jet.joints, down), materials=("rubber",)).items()}
		p = tyres["gear_right_wheel"]
		p = p[np.hypot(*(p[:, :2] - (p[:, :2].max(0) + p[:, :2].min(0)) / 2).T) > 0.5 * gear["tyres"]["main"]["diameter"] / 2]
		yield result("layout.gear", "main wheels' track", gear["track"], p[:, 2].max() + p[:, 2].min(), 0.5)
		# the nose pair's outer sidewalls, less one tyre's width: the centres' spacing
		p = tyres["gear_nose_wheel"]
		yield result("layout.gear", "nose wheels' spacing", gear["spacing"], p[:, 2].max() - p[:, 2].min() - gear["tyres"]["nose"]["width"], 0.3)
		# each tyre's hub, gear down: the rubber reaching in from the tread to
		# the hub's edge, its share of the tyre's radius seen from the side
		rubber = jet.model.parts(verify.pose(jet.joints, down), materials=("rubber",))
		for name, tyre in (("gear_right_wheel", "main"), ("gear_left_wheel", "main"), ("gear_nose_wheel", "nose")):
			if name not in rubber:
				raise KeyError(f"no rubber on {name}")
			p = FRAME.source(rubber[name].reshape(-1, 3))
			for half in ((p[:, 2] > 0, p[:, 2] < 0) if tyre == "nose" else (np.ones(len(p), bool),)):
				q = p[half]
				centre = (q.max(0) + q.min(0)) / 2
				r = np.hypot(q[:, 0] - centre[0], q[:, 1] - centre[1])
				r = r[r > 0.5 * r.max()]   # the tyre's: past the lightening holes' dark ovals on the hub's face
				yield result("layout.gear", f"{name}'s hub at BL {centre[2]:.1f}, of its tyre's radius", gear["tyres"][tyre]["hub"], r.min() / r.max(), 0.01, "share")
		# the legs where the photos put them, gear down (layout.gear legs)
		legs, axes = gear["legs"], (("FS", 0), ("WL", 1), ("BL", 2))
		m = legs["main"]
		for side in ("left", "right"):
			# where the post crosses the photos' top's waterline (it runs on up
			# inside the airframe to its retraction pivot), the arm's pivot end
			# (its foremost ring), the side brace's top (its innermost ring)
			# The post's head and the shock's clevis stand round the post at the
			# photos' top, so its axis is taken from two plain rings below them,
			# between the clamp bands (their outlines' middles), and run up to the
			# top's waterline; the arm's from two rings of its own white metal
			# (not its sleeve round the boss, nor its brake line), run back to
			# the pivot by their distances from it
			sgn = 1 if side == "right" else -1
			mc = m["castings"]
			rings = []
			plain = (mc["bands"][0] + 0.8, mc["bands"][1] - 0.8)   # in from the top, between the bands
			for waterline in (m["top"][1] - plain[0], m["top"][1] - plain[1]):
				ring = jet.cut([f"gear_{side}_strut"], [0, waterline, 0], [0, 1, 0], down)
				if not len(ring):
					raise KeyError(f"no {side} main post at WL {waterline:.1f}")
				rings.append((ring.max(0) + ring.min(0)) / 2)
			top = rings[0] + (rings[0] - rings[1]) * ((m["top"][1] - rings[0][1]) / (rings[0][1] - rings[1][1]))
			white = jet.model.parts(verify.pose(jet.joints, down), materials=("white",)).get(f"gear_{side}_oleo")
			if white is None:
				raise KeyError(f"no white metal on gear_{side}_oleo")
			facts_pivot = np.array(m["pivot"], float) * [1, 1, sgn]
			facts_tip = np.array(m["arm"]["tip"], float) * [1, 1, sgn]
			along_ = (facts_tip - facts_pivot) / np.linalg.norm(facts_tip - facts_pivot)
			centres = []
			for s_ in (5.0, 8.0):
				q = FRAME.source(verify.cut(white, FRAME.model((facts_pivot + along_ * s_)[None])[0], FRAME.axes @ along_).reshape(-1, 3))
				if not len(q):
					raise KeyError(f"no {side} main arm {s_} in aft of its pivot")
				centres.append(q.mean(0))
			pivot = centres[0] + (centres[0] - centres[1]) * (5.0 / 3.0)
			# the side brace gear down: its knee (the lower half's hinge) where
			# the photos last see the brace before it enters the bay, its lower
			# half's axis on from there to its foot at the bolt, and the knee's
			# boss across its pin (layout.motion braces side boss)
			worlds = jet.model.worlds(verify.pose(jet.joints, down))
			pose_ = worlds[jet.model.index[f"gear_{side}_brace"]]
			knee = FRAME.source(pose_[:3, 3])
			lower_ = np.unique(jet.points([f"gear_{side}_brace"], down), axis=0)
			bolt_ = np.array(m["brace"][1], float) * [1, 1, sgn]
			line = (bolt_ - knee) / np.linalg.norm(bolt_ - knee)
			tube = lower_[((lower_ - knee) @ line > 3.0)]
			off = np.linalg.norm((tube - knee) - np.outer((tube - knee) @ line, line), axis=1)
			foot = knee + line * float(((tube - knee) @ line).max())
			for label, want, got, axes_ in (("post at the photos' top", m["top"], top, (("FS", 0), ("BL", 2))), ("arm's pivot end", m["pivot"], pivot, axes),
					("side brace's knee where the photos last see the brace", m["brace"][0], knee, axes), ("side brace's foot at its bolt", m["brace"][1], foot, axes)):
				for unit, i in axes_:
					yield result("layout.gear", f"{side} main {label}", want[i], abs(got[i]) if i == 2 else got[i], 1.0, f"{unit} in")
			yield result("layout.gear", f"{side} main side brace's lower half running from its knee to its bolt, its tube off that line", 0.0, float(np.median(off)) - FACTS["layout"]["motion"]["braces"]["value"]["link"] / 2, 0.1, "in")
			hinge = (pose_[:3, :3] @ np.array(jet.joints[f"gear_{side}_brace"]["axis"], float)) @ FRAME.axes
			hinge /= np.linalg.norm(hinge)
			near = lower_[np.linalg.norm(lower_ - knee, axis=1) < 2.0]
			radial = np.linalg.norm((near - knee) - np.outer((near - knee) @ hinge, hinge), axis=1)
			yield result("layout.gear", f"{side} main side brace's knee boss across", FACTS["layout"]["motion"]["braces"]["value"]["side"]["boss"][0], 2 * float(radial.max()), 0.15, "in")
			# the connecting link's axis, gear down, through the rod's two ends,
			# within their disagreement with the axis fitted to the views'
			# centrelines (0.9-1.1 in)
			link = np.unique(jet.points([f"gear_{side}_link"], down), axis=0)
			middle = link.mean(0)
			line = np.linalg.svd(link - middle, full_matrices=False)[2][0]
			for k, collar in enumerate(m["link"]["collars"]):
				q = np.array(collar, float) * [1, 1, 1 if side == "right" else -1]
				off = float(np.linalg.norm((q - middle) - line * ((q - middle) @ line)))
				yield result("layout.gear", f"{side} main connecting link off its rod's {('upper', 'lower')[k]} end", 0.0, off, 1.2, "in")
		n = legs["nose"]
		# the polished piston where it leaves the post, gear down as the photos
		# stand the jet: the post's lowest metal round the piston's axis (the
		# strut's points inside the post's footprint), and the piston's axis
		# just under it, a level cut through the oleo round the column
		column, post = n["oleo"][0], n["post"] / 2
		strut = np.unique(jet.points(["gear_nose_strut"], down), axis=0)
		inside = strut[(np.abs(strut[:, 0] - column) < post - 0.3) & (np.abs(strut[:, 2]) < post - 0.3)]
		if not len(inside):
			raise KeyError("no nose post round the piston's axis")
		yield result("layout.gear", "nose piston's top, where it leaves the post", n["oleo"][1], inside[:, 1].min(), 0.5, "WL in")
		cut = jet.cut(["gear_nose_oleo"], [0.0, n["oleo"][1] - 1.0, 0.0], [0.0, 1.0, 0.0], down)
		cut = cut[np.abs(cut[:, 0] - column) < n["piston"]]
		if not len(cut):
			raise KeyError("no nose piston under the post")
		yield result("layout.gear", "nose piston's axis under the post", column, (cut[:, 0].min() + cut[:, 0].max()) / 2, 0.5, "FS in")
		# the piston stays in the post through the oleo's stroke: out in flight
		# its top 2 in or more above the post's foot, in by the whole stroke
		# under the post's head (2 in over the trunnion)
		def piston_top(drives):
			chrome = jet.model.parts(verify.pose(jet.joints, drives), materials=("chrome",)).get("gear_nose_oleo")
			if chrome is None:
				raise KeyError("no chrome on gear_nose_oleo")
			q = np.unique(FRAME.source(chrome.reshape(-1, 3)), axis=0)
			return q[np.abs(q[:, 0] - column) < n["piston"]][:, 1].max()
		yield result("layout.gear", "nose piston's top short of 2 in into the post in flight", 0.0, max(0.0, n["oleo"][1] + 2.0 - piston_top({"gear": 1})), 0.05)
		yield result("layout.gear", "nose piston's top past the post's head, the oleo in", 0.0, max(0.0, piston_top(down) - (n["trunnion"][1] + 2.0)), 0.05)
		# and fully in, at the points file's full (the most the engine pushes
		# it), the piston's top meets the head
		full = jet.document["points"]["gear"]["nose"]["full"]
		yield result("layout.gear", "nose piston's top off the post's head, fully in", n["trunnion"][1] + 2.0, piston_top({**down, "oleo.nose": full}), 0.05, "WL in")
		bar = np.unique(jet.points(["launch_bar"], down), axis=0)
		tip = bar[np.argsort(bar[:, 0])[:8]].mean(0)
		yield result("layout.gear", "launch bar's raised tip", n["bar"]["tip"][0], tip[0], 1.0, "FS in")
		yield result("layout.gear", "launch bar's raised tip", n["bar"]["tip"][1], tip[1], 1.0, "WL in")
		# the bar's section and its head: across the bar at its middle, square
		# to it in the side view and across the jet; the head across at the tip
		b = n["bar"]
		pivot, far = np.array(b["pivot"], float), np.array(b["tip"], float)
		along = (far - pivot) / np.linalg.norm(far - pivot)
		middle = jet.cut(["launch_bar"], [*((pivot + far) / 2), 0.0], [along[0], along[1], 0.0], down)
		if not len(middle):
			raise KeyError("no launch bar at its middle")
		yield result("layout.gear", "launch bar's depth at its middle", b["section"][0], float(np.ptp(middle[:, :2] @ np.array([-along[1], along[0]]))), 0.1)
		yield result("layout.gear", "launch bar across at its middle", b["section"][1], float(np.ptp(middle[:, 2])), 0.1)
		yield result("layout.gear", "launch bar's head across", b["head"][1], float(np.ptp(bar[:, 2])), 0.1)
		# the strut's castings, gear down (layout.gear legs nose castings),
		# measured on cuts through the strut's metal where only the part
		# measured reaches: across at a waterline, or down a buttline
		c = n["castings"]

		# the post's metal: its castings, not the hoses down its front, which
		# would stand for the steering block's top where they pass it
		metal = jet.model.parts(verify.pose(jet.joints, down), materials=tuple({m for mesh in jet.model.meshes for _, m in mesh} - {"rubber"}))["gear_nose_strut"]

		def level(waterline):
			return FRAME.source(verify.cut(metal, FRAME.model([0.0, waterline, 0.0]), FRAME.axes @ np.array([0.0, 1.0, 0.0])).reshape(-1, 3))

		def upright(buttline):
			return FRAME.source(verify.cut(metal, FRAME.model([0.0, 0.0, buttline]), FRAME.axes @ np.array([0.0, 0.0, 1.0])).reshape(-1, 3))

		def some(p, what):
			if not len(p):
				raise KeyError(f"no nose strut metal {what}")
			return p
		# the housing just under its top, above the steering block: its front on
		# the centreline (the post's front, which the side view's silhouette is),
		# its back beside the web, its width; its top and the collar's bottom
		# down a buttline outboard of the post, the web, the block and the plates
		k = c["housing"]
		cut = level(k["waterlines"][1] - 0.4)
		yield result("layout.gear", "nose housing's front", k["stations"][0], some(cut[np.abs(cut[:, 2]) < 0.5], "at the housing's top")[:, 0].min(), 0.3, "FS in")
		beside = c["web"]["thickness"] / 2 + c["fittings"]["rim"] / 2 + 0.1   # clear of the web and the rim on its faces
		yield result("layout.gear", "nose housing's back", k["stations"][1], some(cut[(np.abs(cut[:, 2]) > beside) & (np.abs(cut[:, 2]) < beside + 0.8)], "beside the web")[:, 0].max(), 0.3, "FS in")
		yield result("layout.gear", "nose housing's width", k["width"], 2 * np.abs(cut[:, 2]).max(), 0.3)
		# under the post's head, its web and the trunnion's cross tube
		below = n["trunnion"][1] - 4.0
		side = upright(3.5)
		side = some(side[side[:, 1] < below], "down BL 3.5")
		yield result("layout.gear", "nose housing's top", k["waterlines"][1], side[:, 1].max(), 0.3, "WL in")
		yield result("layout.gear", "nose collar's bottom", c["collar"]["waterlines"][0], side[:, 1].min(), 0.3, "WL in")
		k = c["collar"]
		cut = some(level(sum(k["waterlines"]) / 2), "at the collar")
		middle = some(cut[np.abs(cut[:, 2]) < 0.5], "at the collar's middle")
		yield result("layout.gear", "nose collar's front", k["stations"][0], middle[:, 0].min(), 0.3, "FS in")
		yield result("layout.gear", "nose collar's back", k["stations"][1], middle[:, 0].max(), 0.3, "FS in")
		yield result("layout.gear", "nose collar's width", k["width"], 2 * np.abs(cut[:, 2]).max(), 0.3)
		k = c["steering"]
		cut = some(level(sum(k["waterlines"]) / 2), "at the steering block")
		front = some(cut[cut[:, 0] < c["housing"]["stations"][0] - 0.3], "ahead of the post")
		yield result("layout.gear", "nose steering block's front", k["stations"][0], front[:, 0].min(), 0.3, "FS in")
		yield result("layout.gear", "nose steering block's width", k["width"], 2 * np.abs(front[:, 2]).max(), 0.3)
		ahead = some(upright(1.0), "down BL 1")
		ahead = ahead[ahead[:, 0] < c["housing"]["stations"][0] - 0.3]
		yield result("layout.gear", "nose steering block's top", k["waterlines"][1], some(ahead[ahead[:, 1] > c["collar"]["waterlines"][1]], "ahead of the post above the collar")[:, 1].max(), 0.3, "WL in")
		# the block on the post's port front over the housing (castings block):
		# the post's metal outboard of the housing's side between the collar and
		# the eye rings is the block's, each extreme a face of it; its inner face
		# the nearest the post among its points between its top and bottom,
		# outboard of the pipe; the pipe the metal between the block and the
		# post, ahead of the post's round
		k = c["block"]
		vertices = FRAME.source(jet.model.parts(verify.pose(jet.joints, down))["gear_nose_block"].reshape(-1, 3))
		outboard = some(vertices[(vertices[:, 2] < -(c["housing"]["width"] / 2 + 0.2)) & (vertices[:, 1] > c["collar"]["waterlines"][1] + 2.0) & (vertices[:, 1] < c["eyes"]["at"][1] - 1.5)], "outboard of the housing over it")
		yield result("layout.gear", "nose post's block's front", k["stations"][0], outboard[:, 0].min(), 0.1, "FS in")
		yield result("layout.gear", "nose post's block's back", k["stations"][1], outboard[:, 0].max(), 0.1, "FS in")
		yield result("layout.gear", "nose post's block's bottom", k["waterlines"][0], outboard[:, 1].min(), 0.1, "WL in")
		yield result("layout.gear", "nose post's block's top", k["waterlines"][1], outboard[:, 1].max(), 0.1, "WL in")
		yield result("layout.gear", "nose post's block's outer side", k["buttlines"][1], outboard[:, 2].min(), 0.1, "BL in")
		pipe = k["pipe"]
		low, high = k["waterlines"][0] + 0.1, pipe["top"] - 0.1
		inner = some(vertices[(vertices[:, 2] < pipe["at"][1] - pipe["diameter"] / 2 - 0.05) & (vertices[:, 1] > low) & (vertices[:, 1] < high) & (vertices[:, 0] > k["stations"][0] + 0.1) & (vertices[:, 0] < k["stations"][1] - 0.1)], "on the block's inner face")
		yield result("layout.gear", "nose post's block's inner side", k["buttlines"][0], inner[:, 2].max(), 0.1, "BL in")
		tube = some(vertices[(np.abs(vertices[:, 2] - pipe["at"][1]) < pipe["diameter"] / 2 + 0.05) & (vertices[:, 1] > k["waterlines"][0] - 0.1) & (vertices[:, 1] < pipe["top"] + 0.5) & (vertices[:, 0] < n["oleo"][0] - n["post"] / 2)], "between the block and the post")
		yield result("layout.gear", "nose post's block's pipe's middle", pipe["at"][0], float((tube[:, 0].min() + tube[:, 0].max()) / 2), 0.1, "FS in")
		yield result("layout.gear", "nose post's block's pipe's middle", pipe["at"][1], float((tube[:, 2].min() + tube[:, 2].max()) / 2), 0.1, "BL in")
		yield result("layout.gear", "nose post's block's pipe across", pipe["diameter"], float(np.ptp(tube[:, 0])), 0.1)
		yield result("layout.gear", "nose post's block's pipe's top", pipe["top"], tube[:, 1].max(), 0.1, "WL in")
		# the web aft of the housing: its top and thickness, the pin's boss
		k = c["web"]
		behind = n["oleo"][0] + n["post"] / 2 + 0.2   # aft of the post
		# its top edge an inch aft of the post and half way from the housing to
		# the pin, its rim riding on it: the outline crossed at each station,
		# and a cut square to the stations there
		edge = k["outline"] + k["outline"][:1]
		for station in (behind + 1.0, (c["housing"]["stations"][1] + n["brace"][0]) / 2):
			crossing = max(w0 + (w1 - w0) * (station - f0) / (f1 - f0) for (f0, w0), (f1, w1) in zip(edge, edge[1:]) if (f0 - station) * (f1 - station) < 0)
			across = jet.cut(["gear_nose_strut"], [station, 0.0, 0.0], [1.0, 0.0, 0.0], down)
			web_ = some(across[(np.abs(across[:, 2]) < k["thickness"] / 2 + c["fittings"]["rim"] + 0.1) & (across[:, 1] < below)], f"at FS {station:.1f}")
			yield result("layout.gear", f"nose web's top with its rim, at FS {station:.1f}", crossing + c["fittings"]["rim"] / 2, web_[:, 1].max(), 0.15, "WL in")
		# the plate's thickness inside it, clear of its rim, the housing and the pin's boss
		cut = level((min(w for _, w in k["outline"]) + n["brace"][1]) / 2 + 0.5)
		inside = cut[(cut[:, 0] > c["housing"]["stations"][1] + 0.4) & (cut[:, 0] < n["brace"][0] - k["boss"][0] / 2 - 0.3)]
		yield result("layout.gear", "nose web's thickness", k["thickness"], 2 * np.abs(some(inside, "inside the web")[:, 2]).max(), 0.1)
		# the rim standing off each face at the web's top edge
		yield result("layout.gear", "nose web's rim, how far it stands off each face", c["fittings"]["rim"], 2 * float(np.abs(web_[:, 2]).max()) - k["thickness"], 0.15)
		cut = level(n["brace"][1])
		boss = some(cut[np.abs(cut[:, 0] - n["brace"][0]) < k["boss"][0] / 2 + 0.2], "at the pin")
		yield result("layout.gear", "nose web's pin boss's length", k["boss"][1], 2 * np.abs(boss[:, 2]).max(), 0.1)
		# the torque link's bosses either side, their inner faces and aft edges
		k = c["disk"]
		cut = level(k["at"][1] + 0.8 * k["radius"])   # above the bracket and the link, which leave at its middle
		bosses = some(cut[cut[:, 0] > c["collar"]["stations"][1] + 0.5], "aft of the collar")
		yield result("layout.gear", "nose torque link's bosses' inner faces", k["buttline"], np.abs(bosses[:, 2]).min(), 0.1, "BL in")
		# their aft edge at their middle's height, where the round reaches furthest
		cut = level(k["at"][1])
		bosses = some(cut[(cut[:, 0] > c["collar"]["stations"][1] + 0.5) & (np.abs(cut[:, 2]) > k["buttline"] - 0.05)], "aft of the collar at the bosses' middle")
		yield result("layout.gear", "nose torque link's bosses' aft edge", k["at"][0] + k["radius"], bosses[:, 0].max(), 0.3, "FS in")
		# the oleo's fork and the holdback, gear down
		oleo = np.unique(jet.points(["gear_nose_oleo"], down), axis=0)
		k = c["holdback"]
		held = np.unique(jet.points(["gear_nose_holdback"], down), axis=0)
		p = held[held[:, 0] > max(f for f, _ in c["fork"]["outline"]) + 0.5]
		if not len(p):
			raise KeyError("no nose holdback aft of the fork")
		yield result("layout.gear", "nose holdback's tail", max(f for f, _ in k["outline"]), p[:, 0].max(), 0.3, "FS in")
		yield result("layout.gear", "nose holdback's spring's top", max(w for _, w in k["spring"]) + k["coil"] / 2, p[:, 1].max(), 0.3, "WL in")
		# with the oleo out, in flight, the bar lies folded up along the piston's
		# aft face as the photos in flight show it (layout.gear where): nothing of
		# it further aft of its root than its own depth with the spring on it
		root_ = min(f for f, _ in k["outline"])
		depth = max(w for _, w in k["spring"]) + k["coil"] / 2 - min(w for _, w in k["outline"])
		held = np.unique(jet.points(["gear_nose_holdback"], {"gear": 1}), axis=0)
		yield result("layout.gear", "nose holdback's reach aft of its root past its own depth, the oleo out", 0.0, max(0.0, float(held[:, 0].max()) - root_ - depth - 0.5), 0.0, "in")
		k = c["fork"]
		p = oleo[(oleo[:, 1] < gear["axles"]["nose"] + 0.5) & (oleo[:, 0] < 285.0)]
		yield result("layout.gear", "nose fork's bottom", min(w for _, w in k["outline"]), p[:, 1].min(), 0.3, "WL in")
		# the strut's lamps, gear down (layout.lights gear): the landing lamp's
		# lens (its front, its middle, its size) and the approach lights' three
		# lenses (the middle one's place, their spacing)
		lit, spots = np.unique(jet.points(["lamp_gear_nose", "lamp_approach_green", "lamp_approach_amber", "lamp_approach_red"], down), axis=0), F["layout"]["lights"]
		landing = np.array(spots["points"]["landing"]["at"], float)
		near = lit[np.linalg.norm(lit - landing, axis=1) < 4.0]
		if not len(near):
			raise KeyError("no landing lens near the landing light's point")
		yield result("layout.lights", "landing lamp's lens front", landing[0], near[:, 0].min(), 0.8, "FS in")
		for i, unit in ((1, "WL"), (2, "BL")):
			yield result("layout.lights", "landing lamp's lens middle", landing[i], (near[:, i].min() + near[:, i].max()) / 2, 0.8, f"{unit} in")
		yield result("layout.lights", "landing lamp's lens across", spots["gear"]["landing"]["diameter"] - 0.6, near[:, 1].max() - near[:, 1].min(), 0.5, "in")
		approach = np.array(spots["points"]["approach"]["at"], float)
		spacing = spots["gear"]["approach"]["spacing"]
		middles = []
		for k in (1, 0, -1):
			lens = lit[np.linalg.norm(lit - (approach + [0, k * spacing, 0]), axis=1) < 0.9]
			if not len(lens):
				raise KeyError(f"no approach lens {k:+d} from the amber one")
			middles.append((lens.min(axis=0) + lens.max(axis=0)) / 2)
		for i, unit in enumerate(("FS", "WL", "BL")):
			yield result("layout.lights", "approach lights' amber lens", approach[i], middles[1][i], 0.8, f"{unit} in")
		yield result("layout.lights", "approach lights' lenses apart, green to red", 2 * spacing, middles[0][1] - middles[2][1], 0.3, "in")
		# the box behind its lenses: none of the housing round them stands
		# further out along the way the lenses face than their own fronts
		turn = math.radians(spots["gear"]["approach"]["facing"])
		facing = np.array([-math.cos(turn), 0.0, -math.sin(turn)])   # forward and to the left, in stations and buttlines
		housing = np.unique(jet.points(["gear_nose_lamps"], down), axis=0)
		box = housing[np.linalg.norm(housing - approach, axis=1) < 6.0]
		lenses = lit[np.linalg.norm(lit - approach, axis=1) < 2 * spacing + 1.0]
		if not len(box):
			raise KeyError("no approach lights' box near the amber lens")
		yield result("layout.lights", "approach lights' box standing out ahead of its lenses' fronts", 0.0, max(0.0, float((box @ facing).max() - (lenses @ facing).max())), 0.05, "in")
		# the nose drag brace with the gear down (layout.gear legs nose): the
		# cylinder's pin in the fuselage and the rod's eye on the web's pin,
		# each its part's hinge; the brace's lean between them; the rod showing
		# past the cylinder's end
		worlds = jet.model.worlds(verify.pose(jet.joints, down))
		def origin(name):
			if name not in jet.model.index:
				raise KeyError(f"not built: {name}")
			return FRAME.source(worlds[jet.model.index[name]][:3, 3][None])[0]
		act = n["actuator"]
		cylinder_pin, eye = origin("gear_nose_brace"), origin("gear_nose_brace_rod")
		for i, unit in enumerate(("FS", "WL", "BL")):
			yield result("layout.gear", "nose drag brace's cylinder pin", (act["pin"] + [0.0])[i], cylinder_pin[i], 0.05, f"{unit} in")
			yield result("layout.gear", "nose drag brace's rod eye", (n["brace"][:2] + [0.0])[i], eye[i], 0.5, f"{unit} in")
		line = cylinder_pin - eye
		yield result("layout.gear", "nose drag brace's lean from vertical", n["brace"][2], math.degrees(math.atan2(math.hypot(line[0], line[2]), line[1])), 1.0, "deg")
		yield result("layout.gear", "nose drag brace's rod showing", act["showing"], float(np.linalg.norm(line)) - act["cylinder"], 1.0)
		# the cylinder's diameter, cut square to the brace 6 in out from its pin
		# (clear of the pin's cross tube and the strip's brackets), and the
		# rod's, its polished body's furthest from the brace's axis
		u = -line / np.linalg.norm(line)
		c = jet.cut(["gear_nose_brace"], cylinder_pin + u * 6.0, u, down) - (cylinder_pin + u * 6.0)
		if not len(c):
			raise KeyError("no nose drag brace cylinder 6 in from its pin")
		yield result("layout.gear", "nose drag brace's cylinder diameter, across its widest", act["diameters"][0], 2 * float(np.linalg.norm(c, axis=1).max()), 0.1)
		body = jet.model.parts(verify.pose(jet.joints, down), materials=("chrome",)).get("gear_nose_brace_rod")
		if body is None:
			raise KeyError("no polished nose drag brace rod")
		q = FRAME.source(body.reshape(-1, 3)) - cylinder_pin
		yield result("layout.gear", "nose drag brace's rod diameter, across its widest", act["diameters"][1], 2 * float(np.linalg.norm(q - np.outer(q @ u, u), axis=1).max()), 0.1)
		# the rod's end fitting: from the web's pin to where the polished body begins
		yield result("layout.gear", "nose drag brace's rod fitting, the pin to its polished body", act["fitting"], float(np.linalg.norm(line)) - float((q @ u).max()), 0.3)
		# the points file's gear, which the engine seats the wheels by: each
		# axle where the model stands it as the photos do (the wheel's hinge),
		# and the nose oleo's static drive, its stroke from its length in flight
		told_gear = jet.document["points"]["gear"]
		for leg in ("nose", "left", "right"):
			hub, axle = origin(f"gear_{leg}_wheel"), FRAME.source(np.array(told_gear[leg]["axle"], float)[None])[0]
			yield result("layout.gear", f"{leg} axle in the points file off the wheel's hub as the jet stands", 0.0, float(np.linalg.norm(hub - axle)), 0.1)
		yield result("layout.gear", "nose oleo's static drive in the points file", down["oleo.nose"], told_gear["nose"]["static"], 1e-4, "m")
		# nothing of the cylinder (its strip's brackets) reaches past its end
		q = np.unique(jet.points(["gear_nose_brace"], down), axis=0)
		yield result("layout.gear", "nose drag brace's cylinder's parts past its end", 0.0, max(0.0, float(((q - cylinder_pin) @ u).max()) - act["cylinder"]), 0.05)
		# each door open as the photos show it: its lowest point
		doors = gear["doors"]
		def skin(station, height):
			# the fuselage's outboard buttline at a height, on the right, a hair
			# aft of the station: a hinge station is a seam of the skin, where a
			# cut through it meets only edges
			c = jet.cut(["fuselage"], [station + 0.01, 0, 0], [1, 0, 0])
			a_, b_ = c[0::2], c[1::2]
			hit = ((a_[:, 1] - height) * (b_[:, 1] - height) < 0) & (np.maximum(a_[:, 2], b_[:, 2]) > 0)
			if not hit.any():
				raise KeyError(f"no fuselage at FS {station}, WL {height}")
			t = (height - a_[hit, 1]) / (b_[hit, 1] - a_[hit, 1])
			return float((a_[hit, 2] + (b_[hit, 2] - a_[hit, 2]) * t).max())

		# the forward doors open, their tops where they hinge, at the marks' heights
		fwd = doors["forward"]
		q = jet.points(["gear_nose_door_right"], down)
		for (station, _), height in zip(fwd["hinge"], fwd["height"]):
			near = q[np.abs(q[:, 0] - station) < 2.0]
			if not len(near):
				raise KeyError(f"no gear_nose_door_right near FS {station}")
			yield result("layout.gear", f"gear_nose_door_right open, its top at FS {station:g}", height, near[:, 1].max(), 1.0, "WL in")
		# each nose door's free edge, open: the middle of its two ends (a rigid
		# door hinged on the build's skin leans 2-2.5 in otherwise than the
		# photos' at one end of the forward and long doors, the skin's slope at
		# the bay's edges: #71)
		for key, names in (("forward", ["gear_nose_door_right", "gear_nose_door_left"]), ("long", ["gear_nose_door_long"])):
			for name in names:
				q = jet.points([name], down)
				ends = []
				for fs, wl, bl in doors[key]["edge"]:
					near = q[np.abs(q[:, 0] - fs) < 2.0]
					if not len(near):
						raise KeyError(f"no {name} near FS {fs}")
					ends.append(near[np.argmin(near[:, 1])])
				got, want = np.mean(ends, axis=0), np.mean(np.array(doors[key]["edge"], float), axis=0)
				if "height" in doors[key]:
					# the forward doors' marks are their open outer faces: their
					# hinges stand on the skin at the marks' heights, and the free
					# edge comes in by as much
					want[2] -= float(np.mean([b - skin(f, h) for (f, b), h in zip(doors[key]["hinge"], doors[key]["height"])]))
				yield result("layout.gear", f"{name} open, its free edge's middle", want[1], got[1], 1.5, "WL in")
				yield result("layout.gear", f"{name} open, its free edge's middle", want[2], abs(got[2]), 1.5, "BL in")
		# closed, the long nose door and the outer main doors span what the
		# views from below see: their edges' buttlines at each end, the outer
		# doors' front and aft stations
		q = jet.points(["gear_nose_door_long"])
		for (fs, hinge), (_, free) in zip(doors["long"]["hinge"], doors["long"]["free"]):
			near = q[np.abs(q[:, 0] - fs) < 1.5]
			if not len(near):
				raise KeyError(f"no gear_nose_door_long near FS {fs}")
			yield result("layout.gear", f"long nose door closed, its hinge at FS {fs:g}", hinge, near[:, 2].max(), 0.5, "BL in")
			yield result("layout.gear", f"long nose door closed, its free edge at FS {fs:g}", free, near[:, 2].min(), 0.5, "BL in")
		o = doors["outer"]
		for side in ("left", "right"):
			q = jet.points([f"gear_door_outer_{side}"])
			yield result("layout.gear", f"{side} outer main door closed, its front", o["hinge"][0], q[:, 0].min(), 0.5, "FS in")
			yield result("layout.gear", f"{side} outer main door closed, its aft edge", o["hinge"][1], q[:, 0].max(), 0.5, "FS in")
			yield result("layout.gear", f"{side} outer main door closed, its hinge", o["hinge"][2], np.abs(q[:, 2]).max(), 0.5, "BL in")
			yield result("layout.gear", f"{side} outer main door closed, its inboard edge", o["seam"], np.abs(q[:, 2]).min(), 0.5, "BL in")
		# each main door panel: closed, a corner of the build's at each corner
		# the views from below put; open, each of those corners where the
		# gear-down photos put it (the corner pairs its turn was fitted to),
		# less the stations' common offset between the two solves
		panels = (("gear_door_inner", doors["inner"]["forward"]), ("gear_door_strip", doors["inner"]["strip"]), ("gear_door_outer", doors["outer"]))
		for side, sign in (("left", -1), ("right", 1)):
			for name, e in panels:
				rest, opened = jet.points([f"{name}_{side}"]), jet.points([f"{name}_{side}"], down)
				outline = e.get("outline") or [[e["hinge"][0], e["seam"]], [e["hinge"][0], e["hinge"][2]], [e["hinge"][1], e["hinge"][2]], [e["hinge"][1], e["seam"]]]
				for fs, bl in outline:
					gap = np.hypot(rest[:, 0] - fs, rest[:, 2] - sign * bl).min()
					yield result("layout.gear", f"{name}_{side} closed, a corner at FS {fs:g}, BL {sign * bl:g}", 0.0, float(gap), 0.6, "in")
				# the forward panel's corner panel, outboard of its edge
				for fs, bl in (q for piece in e.get("corner", []) for q in piece):
					gap = np.hypot(rest[:, 0] - fs, rest[:, 2] - sign * bl).min()
					yield result("layout.gear", f"{name}_{side} closed, its corner panel's corner at FS {fs:g}, BL {sign * bl:g}", 0.0, float(gap), 0.6, "in")
				for (fs, bl), (tf, tw, tb) in e["free"]:
					k = np.argmin(np.hypot(rest[:, 0] - fs, rest[:, 2] - sign * bl) + np.where(rest[:, 1] < 85, 0.0, 99.0))
					miss = float(np.linalg.norm(opened[k] - [tf - doors["offset"], tw, sign * tb]))
					yield result("layout.gear", f"{name}_{side} open, its corner from FS {fs:g}, BL {sign * bl:g} off the photos'", 0.0, miss, 1.5, "in")
		c = L["canopy"]
		for k, (st, wl, bl) in enumerate(c["sill"]):
			sill = jet.cut(["canopy"], [st, 100, 0], [1, 0, 0])
			low = sill[sill[:, 2] > 0]
			yield result("layout.canopy", f"canopy's sill at FS {st}", wl, low[:, 1].min() if len(low) else np.inf, 1.0, "WL in")
		# the glass's section: its half-width halfway from the sill to the top, against the fitted superellipse,
		# near each end of the canopy (the exponent runs from one at the bow's foot to the other at the aft
		# corner), aft where the glass alone still makes the section: behind FS 290 the fairing's shoulders
		# rise beside it (flared())
		for st in (250.0, 290.0):
			b = np.interp(st, [p[0] for p in c["sill"]], [p[2] for p in c["sill"]])
			w = np.interp(st, [p[0] for p in c["sill"]], [p[1] for p in c["sill"]])
			glass = jet.cut(["canopy"], [st, 100, 0], [1, 0, 0])
			halfway = w + (glass[:, 1].max() - w) / 2
			near = glass[np.abs(glass[:, 1] - halfway) < 0.4]
			n = np.interp(st, [c["sill"][0][0], c["sill"][-1][0]], c["glass"])
			# the section the exponent draws, and the shell stood the seal's step
			# proud of it along its normal there (layout.motion canopy seal)
			x = (1 - 0.5 ** n) ** (1 / n)
			across, up = x ** (n - 1) / b, 0.5 ** (n - 1) / (glass[:, 1].max() - w)
			seal = F["layout"]["motion"]["canopy"]["value"]["seal"] * across / math.hypot(across, up)
			yield result("layout.canopy", f"glass's half-width halfway up at FS {st:.0f}", b * x + seal, np.abs(near[:, 2]).max() if len(near) else np.inf, 0.3, "BL in")
		# the glass's lower edge, where the metal panel below it meets it, read off two left-side photos
		glass = jet.model.parts(verify.pose(jet.joints, {}), materials=("glass",)).get("canopy", np.zeros((0, 3, 3)))
		crown = lambda st: float(np.interp(st, [p[0] for p in L["spine"]["crown"]], [p[1] for p in L["spine"]["crown"]]))
		for st, wl in c["glass_edge"]:
			across = FRAME.source(verify.cut(glass, FRAME.model([st, 100, 0]), FRAME.axes @ np.array([1.0, 0, 0])).reshape(-1, 3)) if len(glass) else np.zeros((0, 3))
			left = across[across[:, 2] < 0]
			yield result("layout.canopy", f"glass's lower edge at FS {st:g}, left", wl, left[:, 1].min() if len(left) else np.inf, 0.75, "WL in")
		# the bow and the aft edge lean: the glass's lowest stretch starts at the bow's foot and ends at the aft corner
		whole = jet.points(["canopy"])
		foot = whole[whole[:, 1] < c["bow"]["foot"] + 1.0]
		yield result("layout.canopy", "canopy's lowest front (the bow's foot)", c["sill"][0][0], foot[:, 0].min() if len(foot) else np.inf, 0.6, "FS in")
		corner = whole[whole[:, 1] < c["sill"][-1][1] + 1.0]
		yield result("layout.canopy", "canopy's lowest aft (the aft corner)", c["sill"][-1][0], corner[:, 0].max() if len(corner) else np.inf, 0.6, "FS in")
		# no ledge under the sill: the body an inch below it stands within an inch of the sill's buttline
		ledge = 0.0
		for st in (250.0, 280.0, 310.0):
			b = np.interp(st, [p[0] for p in c["sill"]], [p[2] for p in c["sill"]])
			w = np.interp(st, [p[0] for p in c["sill"]], [p[1] for p in c["sill"]])
			body = jet.cut(["fuselage"], [st, 100, 0], [1, 0, 0])
			level = body[np.abs(body[:, 1] - (w - 1.0)) < 0.4]
			if len(level):
				ledge = max(ledge, np.abs(level[:, 2]).max() - b)
		yield result("layout.canopy", "body standing out an inch under the sill", 0.0, max(0.0, ledge), 1.0)
		# the top line behind the crown, as the profiles show it
		for st, wl in c["top"]:
			cut = jet.cut(["canopy"], [st, 100, 0], [1, 0, 0])
			yield result("layout.canopy", f"canopy's top at FS {st:.0f}", wl, cut[:, 1].max() if len(cut) else np.inf, 0.3, "WL in")
		# the canopy's top falling to the photos' height over the crown at its
		# aft end and the spine flat behind it (layout.canopy tail, the sky
		# check's side photos)
		whole = np.concatenate([jet.points(["fuselage"]).reshape(-1, 3, 3), jet.points(["canopy"]).reshape(-1, 3, 3)])
		for offset in (0.0, 4.0, 8.0):
			st = c["aft"]["station"] + offset
			top = lines(whole, "above", np.array([st - 0.01, st, st + 0.01]), np.array([0.0, 0.01]))[0][1]
			yield result("layout.canopy", f"canopy's top {offset:g} in aft of its aft end, above the crown (the photos' sky check)", c["tail"]["height"], top - crown(st), 0.3, "WL in")
		hood = jet.cut(["canopy"], [c["crown"]["station"], 100, 0], [1, 0, 0])
		yield result("layout.canopy", "canopy crown", c["crown"]["waterline"], hood[:, 1].max(), 0.4, "WL in")
		whole = jet.points(["canopy"])
		yield result("layout.canopy", "canopy's aft end", c["aft"]["station"], whole[:, 0].max(), 0.6, "FS in")
		# the windscreen's glass reaches its frame along the sides at the base
		# line, from the front base down to the bow's foot (a wide U in plan)
		front, bow = c["windscreen"]["station"], c["bow"]["station"]
		glass = jet.points(["windscreen"])
		for station in (front + 8, (front + bow) / 2, bow - 6):
			base = c["windscreen"]["waterline"] + (c["bow"]["foot"] - c["windscreen"]["waterline"]) * (station - front) / (bow - front)
			# within 3 in: the rings near the bow lean with it, their columns moved along
			near = glass[np.abs(glass[:, 0] - station) < 3.0]
			yield result("layout.canopy", f"windscreen glass's lowest at FS {station:.0f}, on its base line", base, float(near[:, 1].min()) if len(near) else 999.0, 1.0, "WL in")
		# the windscreen's section above its frame sill (screen): its half-width
		# halfway from the sill to the top against the fitted superellipse, where
		# its exponent is held (FS 198) and rising to the canopy's (FS 220)
		sill = c["screen"] + c["sill"]
		for st in (198.0, 220.0):
			b = np.interp(st, [p[0] for p in sill], [p[2] for p in sill])
			w = np.interp(st, [p[0] for p in sill], [p[1] for p in sill])
			cut = jet.cut(["fuselage", "windscreen"], [st, 100, 0], [1, 0, 0])
			halfway = w + (cut[:, 1].max() - w) / 2 if len(cut) else 0.0
			# where the section's segments cross the halfway height (none: a failure)
			crossings = [a[2] + (b_[2] - a[2]) * (halfway - a[1]) / (b_[1] - a[1]) for a, b_ in cut.reshape(-1, 2, 3) if (a[1] - halfway) * (b_[1] - halfway) <= 0 and a[1] != b_[1]]
			n = np.interp(st, [c["screen_glass"][0], c["sill"][0][0], c["sill"][-1][0]], [c["screen_glass"][1], c["glass"][0], c["glass"][1]])
			yield result("layout.canopy", f"windscreen's half-width halfway up at FS {st:.0f}", b * (1 - 0.5 ** n) ** (1 / n),
				max(np.abs(crossings)) if crossings else np.inf, 0.3, "BL in")
		screen = jet.points(["windscreen"])
		yield result("layout.canopy", "windscreen's front base", c["windscreen"]["station"], screen[:, 0].min(), 0.6, "FS in")
		bow = jet.cut(["canopy", "windscreen"], [c["bow"]["station"], 100, 0], [1, 0, 0])
		yield result("layout.canopy", "bow's top", c["bow"]["waterline"], bow[:, 1].max(), 0.4, "WL in")
		yield result("layout.surfaces", "inboard leading-edge flap's outer end", L["surfaces"]["lef"]["inner"][1],
			jet.points(["flap_leading_inner_right"])[:, 2].max(), 0.5, "BL in")
		yield result("layout.surfaces", "aileron's outer end", L["surfaces"]["aileron"][1], jet.points(["aileron_right"])[:, 2].max(), 0.5, "BL in")
		yield result("layout.surfaces", "aileron's inner end", L["surfaces"]["aileron"][0], jet.points(["aileron_right"])[:, 2].min(), 0.5, "BL in")
		yield result("layout.surfaces", "trailing-edge flap's outer end", L["surfaces"]["tef"][1], jet.points(["flap_trailing_right"])[:, 2].max(), 0.5, "BL in")
		# where the aileron runs inboard of the fold line, the inner panel stops
		# at its hinge, its aft edge streamwise (parallel to the fold's axis) a
		# seam ahead of the aileron's leading edge at its inner end, so the
		# aileron's nose, turned about the fold, clears it
		stub, fold_ = L["surfaces"]["aileron"][0], value(F["wing"]["fold"])
		hinge = jet.cut(["aileron_right"], [0, 0, stub + 0.05], [0, 0, 1])
		for between in (stub + 1.0, (stub + fold_) / 2, fold_ - 0.5):
			inner = jet.cut(["wing_inner_right"], [0, 0, between], [0, 0, 1])
			yield result("layout.surfaces", f"inner panel's aft edge at BL {between:.1f}, a seam ahead of the aileron's leading edge at its inner end",
				float(hinge[:, 0].min()) - SEAM if len(hinge) else 999.0, float(inner[:, 0].max()) if len(inner) else -999.0, 0.05, "FS in")

	yield from guard("layout", "placements", placements)

	def castings():
		# The main legs' castings and every wheel's detail (layout.gear legs
		# main castings, tyres), gear down: each part's girth on cuts square to
		# its axis, the median over the angles round it of the farthest metal
		# (a lug or a line beside it fills only a few of them); each wheel's
		# tread grooves, holes, bolts, cap and brake counted round its axis
		gear = L["gear"]
		m = gear["legs"]["main"]
		mc = m["castings"]

		def frame(along):
			e1 = np.cross(along, [0.0, 0.0, 1.0]) if abs(along[2]) < 0.9 else np.cross(along, [1.0, 0.0, 0.0])
			e1 /= np.linalg.norm(e1)
			return e1, np.cross(along, e1)

		def girth(names, origin, along, s, drives=down, reach=8.0):
			q = jet.cut(names, list(origin + along * s), list(along), drives)
			if not len(q):
				raise KeyError(f"nothing of {names[0]} {s:.1f} in along it")
			e1, e2 = frame(along)
			v = q - origin
			d = np.linalg.norm(np.cross(v, along), axis=1)
			keep = d < reach
			bins = np.floor((np.arctan2(v[keep] @ e2, v[keep] @ e1) + np.pi) / (2 * np.pi) * 36).astype(int) % 36
			best = np.zeros(36)
			np.maximum.at(best, bins, d[keep])
			return 2 * float(np.median(best[best > 0]))

		def around(q, centre, axis, gap=5.0):
			# how many groups the points make round the axis, a group's
			# neighbours more than `gap` degrees from it (more than the widest
			# step between one part's own corners: the brakes' pistons, wide on
			# a small circle, need 8.5)
			e1, e2 = frame(axis)
			v = q - centre
			a = np.sort(np.degrees(np.arctan2(v @ e2, v @ e1)))
			steps = np.append(np.diff(a), a[0] + 360.0 - a[-1])
			return max(1, int(np.sum(steps > gap)))

		for leg, sgn in (("left", -1), ("right", 1)):
			top = np.array(m["top"], float) * [1, 1, sgn]
			pivot = np.array(m["pivot"], float) * [1, 1, sgn]
			fork = pivot + [0.0, 1.5, -sgn * 3.0]
			length = float(np.linalg.norm(fork - top))
			post = (fork - top) / length
			strut = [f"gear_{leg}_strut"]
			yield result("layout.gear", f"{leg} main post's head across", mc["head"]["diameter"], girth(strut, top, post, mc["head"]["length"] - 0.8), 0.15)
			yield result("layout.gear", f"{leg} main post across between its bands", m["post"], girth(strut, top, post, (mc["bands"][0] + mc["bands"][1]) / 2), 0.15)
			# the bands: where the post stands proud of its own girth
			ss = np.arange(mc["head"]["length"] + 1.5, mc["flare"]["from"] - 0.5, 0.1)
			proud = np.array([girth(strut, top, post, s_) > m["post"] + 0.3 for s_ in ss])
			edges = np.flatnonzero(np.diff(proud.astype(int)))
			found = [float((ss[a + 1] + ss[b]) / 2) for a, b in zip(edges[::2], edges[1::2])]
			yield result("layout.gear", f"{leg} main post's clamp bands", len(mc["bands"]), len(found), 0, "bands")
			for want, got in zip(mc["bands"], found):
				yield result("layout.gear", f"{leg} main post's clamp band, in from its top", want, got, 0.2)
			# the tie-down: the lug and its ring past the head's girth, under
			# the head; the ring's lowest point down the post, its reach out of
			# it and its bearing round from forward toward outboard
			strut_points = jet.points(strut, down)
			v = strut_points - top
			s_ = v @ post
			radial = v - np.outer(s_, post)
			d = np.linalg.norm(radial, axis=1)
			td = mc["tiedown"]
			tie = (d > m["post"] / 2 + 1.0) & (s_ > mc["head"]["length"]) & (s_ < mc["bands"][1])
			if not tie.any():
				raise KeyError(f"no {leg} main tie-down past the post")
			yield result("layout.gear", f"{leg} main tie-down ring's lowest point, down the post", td["at"] + td["ring"][0] - td["ring"][1] / 2, float(s_[tie].max()), 0.1)
			yield result("layout.gear", f"{leg} main tie-down's reach from the post's axis", m["post"] / 2 - 0.3 + td["lug"][1] - 0.5 + td["ring"][0] / 2, float(d[tie].max()), 0.1)
			forward = np.array([-1.0, 0.0, 0.0]) - post * (-post[0])
			forward /= np.linalg.norm(forward)
			far = radial[tie][np.argmax(d[tie])]
			outboard = np.array([0.0, 0.0, float(sgn)]) - post * post[2] * sgn
			bearing = math.degrees(math.atan2(far @ (outboard / np.linalg.norm(outboard)), far @ forward))
			yield result("layout.gear", f"{leg} main tie-down's bearing outboard of forward", td["turn"], bearing, 5.0, "deg")
			# the lower casting half way down: its section fore and aft, half
			# way from the post's to the fork's, and its web across the
			# middle of each side face, sunk by the pocket's depth either side
			# (layout.gear legs main castings flare)
			fl = mc["flare"]
			middle = (fl["from"] + length) / 2
			q = jet.cut(strut, list(top + post * middle), list(post), down)
			fore_ = np.array([-1.0, 0.0, 0.0]) - post * (-post[0])
			fore_ /= np.linalg.norm(fore_)
			side_ = np.cross(post, fore_)
			v = q - (top + post * middle)
			near_ = np.linalg.norm(v, axis=1) < 7.0
			f_, s__ = v[near_] @ fore_, v[near_] @ side_
			yield result("layout.gear", f"{leg} main lower casting fore and aft, half way down", (m["post"] + fl["diameter"]) / 2, float(f_.max() - f_.min()) if len(f_) else 0.0, 0.2)
			web = np.abs(f_) < 0.3
			yield result("layout.gear", f"{leg} main lower casting's web across its side faces' pockets, half way down", (m["post"] + fl["across"]) / 2 - 2 * fl["pocket"][0], 2 * float(np.abs(s__[web]).max()) if web.any() else 0.0, 0.2)
			# the arm, standing: from the pivot to its tip, where the axle's stub
			# begins; the shock's eye on the lug on its top
			tip = np.array(m["arm"]["tip"], float) * [1, 1, sgn]
			reach = float(np.linalg.norm(tip - pivot))
			arm = (tip - pivot) / reach
			eye = np.array(m["shock"]["ends"][1], float) * [1, 1, sgn]
			metal = jet.points([f"gear_{leg}_oleo"], down)
			yield result("layout.gear", f"{leg} main arm's lug at the shock's eye, its nearest metal", 0.0, max(0.0, float(np.linalg.norm(metal - eye, axis=1).min()) - 1.2), 0.0, "in over 1.2")
			a_ = mc["arm"]
			yield result("layout.gear", f"{leg} main arm across, a third of the way to its tip", a_["diameters"][0] + (a_["diameters"][1] - a_["diameters"][0]) * 0.3, girth([f"gear_{leg}_oleo"], pivot, arm, reach * 0.3), 0.15)
			ss = np.arange(0.25, 0.65, 0.01)
			g_ = np.array([girth([f"gear_{leg}_oleo"], pivot, arm, reach * f) for f in ss])
			yield result("layout.gear", f"{leg} main arm's flange, of the way to its tip", a_["flange"], float(ss[int(np.argmax(g_ - (a_["diameters"][0] + (a_["diameters"][1] - a_["diameters"][0]) * ss)))]), 0.02, "share")
			# the planing rod riding the arm: across half way along; its front
			# pin on the pivot's axis (across the jet at the pivot's station and
			# waterline) out past the pivot; its far end over the arm's tip and
			# outboard of it
			ro = mc["rod"]
			rod = np.unique(jet.points([f"gear_{leg}_rod"], down), axis=0)
			u_ = np.linalg.svd(rod - rod.mean(0), full_matrices=False)[2][0]
			t_ = (rod - rod.mean(0)) @ u_
			# each pin the middle of its eye: the points standing off the rod's
			# own axis further than the rod, at its end (the eye round a pin is
			# symmetric about it)
			wide = np.linalg.norm((rod - rod.mean(0)) - np.outer(t_, u_), axis=1) > ro["diameter"] / 2 + 0.1
			ends_ = [rod[wide & (t_ < 0)].mean(0), rod[wide & (t_ > 0)].mean(0)]
			front_, back_ = sorted(ends_, key=lambda e: float(np.linalg.norm(e - pivot)))
			span_ = float(np.linalg.norm(back_ - front_))
			yield result("layout.gear", f"{leg} main planing rod across, half way along", ro["diameter"], girth([f"gear_{leg}_rod"], front_, (back_ - front_) / span_, span_ / 2, reach=2.0), 0.1)
			yield result("layout.gear", f"{leg} main planing rod's front pin off the pivot's axis", 0.0, float(np.linalg.norm((front_ - pivot)[:2])), 0.3)
			yield result("layout.gear", f"{leg} main planing rod's front pin out past the pivot", ro["front"], float((front_ - pivot)[2] * sgn), 0.3)
			yield result("layout.gear", f"{leg} main planing rod's far end off the arm's tip", float(np.hypot(*ro["back"])), float(np.linalg.norm(back_ - tip)), 0.3)
			# the shock absorber, standing: its cap, the red band on it, the
			# polished piston and the ribbed collar at the can's top, each down
			# its line from its pin, the boss where it meets the skin
			lug = np.array(m["shock"]["ends"][0], float) * [1, 1, sgn]
			span = float(np.linalg.norm(eye - lug))
			axis = (eye - lug) / span
			sc = mc["shock"]
			yield result("layout.gear", f"{leg} main shock's cap across", sc["cap"][0], girth([f"gear_{leg}_shock"], lug, axis, sc["cap"][1] - 1.5), 0.15)
			yield result("layout.gear", f"{leg} main shock's piston across, under its cap", m["shock"]["diameters"][0], girth([f"gear_{leg}_shock_can"], lug, axis, sc["cap"][1] + 3.0), 0.15)
			red = jet.model.parts(verify.pose(jet.joints, down), materials=("red",)).get(f"gear_{leg}_shock")
			if red is None:
				raise KeyError(f"no red band on gear_{leg}_shock")
			t = (FRAME.source(red.reshape(-1, 3)) - lug) @ axis
			yield result("layout.gear", f"{leg} main shock's red band's top, down from its pin", sc["band"][0], float(t.min()), 0.1)
			yield result("layout.gear", f"{leg} main shock's red band's depth", sc["band"][1], float(np.ptp(t)), 0.1)
			can = jet.points([f"gear_{leg}_shock_can"], down)
			t = (can - lug) @ axis
			d = np.linalg.norm(np.cross(can - lug, axis), axis=1)
			ribbed = t[d > m["shock"]["diameters"][1] / 2 + 0.2]
			yield result("layout.gear", f"{leg} main shock can's ribbed collar, along it", sc["collar"], float(np.ptp(ribbed)) if len(ribbed) else 0.0, 0.1)
			yield result("layout.gear", f"{leg} main shock can's ribbed collar, at the can's top", span * m["shock"]["collar"], float(ribbed.min()) + 0.2 if len(ribbed) else 0.0, 0.2)
			# the castings' fittings (layout.gear legs main castings fittings):
			# the can's lower end narrowing to its neck, across half way down
			# the narrowing; the pivot's pin hollow, standing off the boss's
			# outboard end, its face and its dark bore across
			fit = mc["fittings"]
			yield result("layout.gear", f"{leg} main shock can's lower end, half way down its narrowing", (m["shock"]["diameters"][1] + fit["neck"][0]) / 2,
				girth([f"gear_{leg}_shock_can"], lug, axis, span - 1.5 - fit["neck"][1] / 2), 0.15)
			nut_ = fit["nut"]
			face_bl = pivot[2] + sgn * (2.5 + nut_[1] + 0.15)
			metal_ = jet.points([f"gear_{leg}_strut"], down)
			# the hex nut on the pin's outboard end (fittings nut): its outer
			# face's corners, out past the cheek's face (2.5 in out, where a
			# 2 in ring of the cheek lies too) and round the pin: across its
			# flats from their reach, and its thickness out from the cheek
			off_ = sgn * (metal_[:, 2] - pivot[2])
			reach_ = np.linalg.norm(metal_[:, :2] - pivot[:2], axis=1)
			hexed = (off_ > 2.55) & (off_ < 2.5 + 2 * nut_[1]) & (reach_ > 1.45) & (reach_ < 2.3)
			yield result("layout.gear", f"{leg} main pivot's nut across its flats", nut_[0], 2 * float(reach_[hexed].max()) * math.cos(math.pi / 6) if hexed.any() else 0.0, 0.1)
			yield result("layout.gear", f"{leg} main pivot's nut's thickness", nut_[1], float(off_[hexed].max()) - 2.5 if hexed.any() else 0.0, 0.05)
			ring_ = metal_[(np.abs(metal_[:, 2] - face_bl) < 0.02) & (np.linalg.norm(metal_[:, :2] - pivot[:2], axis=1) < 2.0)]
			yield result("layout.gear", f"{leg} main pivot's pin end across", fit["pin"][0], 2 * float(np.linalg.norm(ring_[:, :2] - pivot[:2], axis=1).max()) if len(ring_) else 0.0, 0.1)
			bore = jet.model.parts(verify.pose(jet.joints, down), materials=("hub",)).get(f"gear_{leg}_strut")
			bore = FRAME.source(bore.reshape(-1, 3)) if bore is not None else np.zeros((0, 3))
			bore = bore[np.abs(bore[:, 2] - face_bl) < 0.1]
			yield result("layout.gear", f"{leg} main pivot's pin end's bore across", fit["pin"][1], 2 * float(np.linalg.norm(bore[:, :2] - pivot[:2], axis=1).max()) if len(bore) else 0.0, 0.1)
			# the bell crank's round bolt heads: its two ends along the axis it
			# turns about (layout.motion stowed main axis), each a head's face
			crank_ = jet.points([f"gear_{leg}_crank"], down)
			ax = np.array(F["layout"]["motion"]["stowed"]["value"]["main"]["axis"], float) * [1, 1, -sgn]   # the left's, the right its mirror
			ax = ax / np.linalg.norm(ax)
			t_ = (crank_ - crank_.mean(0)) @ ax
			for label, face in (("one", crank_[t_ > t_.max() - 0.02]), ("other", crank_[t_ < t_.min() + 0.02])):
				flat_ = face - face.mean(0)
				yield result("layout.gear", f"{leg} main bell crank's bolt head across, its {label} end", fit["bolt"], 2 * float(np.linalg.norm(flat_ - np.outer(flat_ @ ax, ax), axis=1).max()), 0.1)
			# the connecting link as dvids8678626 shows it (layout.motion braces
			# connecting): its sleeve, polished rod and rod end, each across at
			# its middle, gear down, up its axis from the crank's pin
			k_ = F["layout"]["motion"]["braces"]["value"]["connecting"]
			lk = m["link"]
			u_ = np.array(lk["direction"], float) * [1, 1, sgn]
			u_ = u_ / np.linalg.norm(u_)
			through = np.array(lk["through"], float) * [1, 1, sgn]
			pin_ = through + u_ * ((k_["crank"] - through[1]) / u_[1])
			upper, lower = lk["collars"][0][1], lk["collars"][1][1]
			for label, w, want in (("sleeve", (k_["pin"] + upper) / 2, k_["sleeve"]), ("polished rod", (upper + lower) / 2, k_["rod"]), ("rod end", (lower + k_["crank"]) / 2, k_["end"])):
				yield result("layout.gear", f"{leg} main connecting link's {label} across, at its middle", want, girth([f"gear_{leg}_link"], pin_, u_, (w - k_["crank"]) / u_[1], reach=2.0), 0.1)
		# the nose collar's top band, the steering's ring gear (layout.gear legs
		# nose castings fittings teeth): its teeth round it half way up, and
		# its height
		k = F["layout"]["gear"]["legs"]["nose"]["castings"]
		t_ = k["fittings"]["teeth"]
		middle_ = np.array([sum(k["collar"]["stations"]) / 2, 0.0, 0.0])
		band = jet.cut(["gear_nose_strut"], [0.0, k["collar"]["waterlines"][1] - t_["height"] / 2, 0.0], [0.0, 1.0, 0.0], down)
		r_ = np.linalg.norm((band - middle_)[:, [0, 2]], axis=1)
		# the teeth's tips, at the ring's own radius; counted by their spacing,
		# the median step between neighbours, as the steering block on the
		# collar's front hides the teeth inside it
		tips = band[(r_ > k["collar"]["width"] / 2 - 0.1) & (r_ < k["collar"]["width"] / 2 + 0.05)]
		angles = np.sort(np.degrees(np.arctan2(tips[:, 2] - middle_[2], tips[:, 0] - middle_[0])))
		groups = np.split(angles, np.flatnonzero(np.diff(angles) > 1.0) + 1) if len(angles) else []
		steps = np.diff([g.mean() for g in groups])
		yield result("layout.gear", "nose collar's ring gear's teeth, from their spacing", t_["count"], int(round(360.0 / float(np.median(steps)))) if len(steps) else 0, 0, "teeth")
		gear_ = jet.model.parts(verify.pose(jet.joints, down), materials=("hub",)).get("gear_nose_strut")
		gear_ = FRAME.source(gear_.reshape(-1, 3)) if gear_ is not None else np.zeros((1, 3))
		yield result("layout.gear", "nose collar's ring gear's height", t_["height"], float(np.ptp(gear_[:, 1])), 0.05)
		# the hydraulic hoses down the post's starboard front to the steering
		# block (castings hoses), black on the post: half way between the
		# housing and where they leave the bay, how many and each one's
		# bearing round the post from forward toward starboard; and how high
		# they come out of the bay
		hs = k["hoses"]
		hoses_ = jet.model.parts(verify.pose(jet.joints, down), materials=("rubber",)).get("gear_nose_strut")
		rubber_ = FRAME.source(hoses_.reshape(-1, 3)) if hoses_ is not None else np.zeros((0, 3))
		hoses_ = rubber_[rubber_[:, 2] > 0]   # to starboard: the wiring runs down the port front
		column_ = F["layout"]["gear"]["legs"]["nose"]["oleo"][0]
		on_ = hoses_[np.abs(hoses_[:, 1] - (hs["top"] + k["housing"]["waterlines"][1]) / 2) < 0.6]
		bearings_ = np.sort(np.degrees(np.arctan2(on_[:, 2], column_ - on_[:, 0])))
		runs = np.split(bearings_, np.flatnonzero(np.diff(bearings_) > 6.0) + 1) if len(bearings_) else []
		yield result("layout.gear", "nose post's hydraulic hoses", len(hs["bearings"]), len(runs), 0, "hoses")
		for want, run_ in zip(sorted(hs["bearings"]), runs):
			yield result("layout.gear", "nose post's hydraulic hose's bearing round the post, from forward to starboard", want, float(run_.mean()), 4.0, "deg")
		yield result("layout.gear", "nose post's hydraulic hoses out of the bay", hs["top"], float(hoses_[:, 1].max()) if len(hoses_) else 0.0, 0.2, "WL in")
		# the wiring down the post's port front (castings harness): one run,
		# its bearing half way down, where it leaves the bay, and its diameter
		hn = k["harness"]
		wires_ = rubber_[rubber_[:, 2] < 0]
		on_ = wires_[np.abs(wires_[:, 1] - (hn["top"] + k["housing"]["waterlines"][1]) / 2) < 0.6]
		bearings_ = np.sort(np.degrees(np.arctan2(on_[:, 2], column_ - on_[:, 0])))
		runs = np.split(bearings_, np.flatnonzero(np.diff(bearings_) > 6.0) + 1) if len(bearings_) else []
		yield result("layout.gear", "nose post's wiring runs down its port front", 1, len(runs), 0, "runs")
		yield result("layout.gear", "nose post's wiring's bearing round the post, from forward to starboard", hn["bearing"], float(bearings_.mean()) if len(bearings_) else 0.0, 4.0, "deg")
		yield result("layout.gear", "nose post's wiring out of the bay", hn["top"], float(wires_[:, 1].max()) if len(wires_) else 0.0, 0.2, "WL in")
		yield result("layout.gear", "nose post's wiring across", hn["diameter"], float(np.linalg.norm(on_[:, [0, 2]] - on_[:, [0, 2]].mean(0), axis=1).max() * 2) if len(on_) else 0.0, 0.05)
		# the eye rings on either side of the post under the bay (castings
		# eyes), white: each one's middle, its outer and inner diameters round
		# it, and its stock's thickness across the jet
		ey = k["eyes"]
		white_ = jet.model.parts(verify.pose(jet.joints, down), materials=("white",)).get("gear_nose_strut")
		white_ = FRAME.source(white_.reshape(-1, 3)) if white_ is not None else np.zeros((0, 3))
		for side, sgn in (("port", -1), ("starboard", 1)):
			eye_ = white_[(sgn * white_[:, 2] > 2.3) & (np.abs(white_[:, 0] - ey["at"][0]) < 2.2) & (np.abs(white_[:, 1] - ey["at"][1]) < 2.2)]
			if not len(eye_):
				yield result("layout.gear", f"nose post's {side} eye ring's outer diameter", ey["diameters"][0], 0.0, 0.1)
				continue
			middle = (eye_[:, :2].min(0) + eye_[:, :2].max(0)) / 2
			r = np.linalg.norm(eye_[:, :2] - middle, axis=1)
			yield result("layout.gear", f"nose post's {side} eye ring's middle", ey["at"][0], float(middle[0]), 0.1, "FS in")
			yield result("layout.gear", f"nose post's {side} eye ring's middle", ey["at"][1], float(middle[1]), 0.1, "WL in")
			yield result("layout.gear", f"nose post's {side} eye ring's outer diameter", ey["diameters"][0], 2 * float(r.max()), 0.1)
			yield result("layout.gear", f"nose post's {side} eye ring's hole", ey["diameters"][1], 2 * float(r.min()), 0.1)
			yield result("layout.gear", f"nose post's {side} eye ring's stock across the jet", ey["stock"], float(np.ptp(eye_[:, 2])), 0.05)
		# the round bolt heads on the launch bar's pivot and the torque link's
		# pin, on the pivot plates' outer faces, and the drag brace's clevis
		# pin's hollow ends, its face and its bore (castings fittings)
		nose_ = F["layout"]["gear"]["legs"]["nose"]
		fit = k["fittings"]
		strut_ = jet.points(["gear_nose_strut"], down)
		for label, (f_, w_) in (("launch bar's pivot", nose_["bar"]["pivot"]), ("torque link's pin", k["link"]["to"])):
			face_ = k["plates"]["buttline"] + 0.3 + 0.15   # the plate's outer face, and a head's standing off it
			near = strut_[(np.abs(np.abs(strut_[:, 2]) - face_) < 0.02) & (np.hypot(strut_[:, 0] - f_, strut_[:, 1] - w_) < 1.2)]
			yield result("layout.gear", f"nose {label}'s bolt heads across", fit["bolt"], 2 * float(np.hypot(near[:, 0] - f_, near[:, 1] - w_).max()) if len(near) else 0.0, 0.1)
		# the axle's fork cast with its edges rounded (fittings round): its
		# bottom at its faces lifted off its bottom on the centreline by the
		# round, at a station clear of the piston
		f_ = (k["fork"]["outline"][2][0] + k["fork"]["outline"][1][0]) / 2
		q = jet.cut(["gear_nose_oleo"], [f_, 0.0, 0.0], [1.0, 0.0, 0.0], down)
		q = q[q[:, 1] < min(w for _, w in k["fork"]["outline"]) + 2.0] if len(q) else q
		middle_ = q[np.abs(q[:, 2]) < 0.5]
		faces_ = q[np.abs(q[:, 2]) > k["fork"]["width"] / 2 - 0.03]
		yield result("layout.gear", f"nose axle's fork's edges rounded, its bottom at its faces over its middle's at FS {f_:.1f}", fit["round"],
			float(faces_[:, 1].min() - middle_[:, 1].min()) if len(middle_) and len(faces_) else 0.0, 0.05)
		rod_ = jet.points(["gear_nose_brace_rod"], down)
		f_, w_ = nose_["brace"][:2]
		ends_ = rod_[np.abs(rod_[:, 2]) > np.abs(rod_[:, 2]).max() - 0.02]
		yield result("layout.gear", "nose drag brace's clevis pin's ends across", fit["pin"][0], 2 * float(np.hypot(ends_[:, 0] - f_, ends_[:, 1] - w_).max()), 0.1)
		bore = jet.model.parts(verify.pose(jet.joints, down), materials=("hub",)).get("gear_nose_brace_rod")
		bore = FRAME.source(bore.reshape(-1, 3)) if bore is not None else np.zeros((1, 3))
		yield result("layout.gear", "nose drag brace's clevis pin's bore across", fit["pin"][1], 2 * float(np.hypot(bore[:, 0] - f_, bore[:, 1] - w_).max()), 0.1)
		# the clevis's yoke round where it leaves the polished rod (dvids9820806):
		# its last section up the rod as wide across the jet as it is deep
		chrome_ = jet.model.parts(verify.pose(jet.joints, down), materials=("chrome",)).get("gear_nose_brace_rod")
		chrome_ = FRAME.source(chrome_.reshape(-1, 3)) if chrome_ is not None else np.zeros((0, 3))
		rodwhite = jet.model.parts(verify.pose(jet.joints, down), materials=("white",)).get("gear_nose_brace_rod")
		rodwhite = FRAME.source(rodwhite.reshape(-1, 3)) if rodwhite is not None else np.zeros((0, 3))
		if len(chrome_) and len(rodwhite):
			pinned = np.array([f_, w_, 0.0])
			axis_ = np.linalg.svd(chrome_ - chrome_.mean(0), full_matrices=False)[2][0]
			axis_ = axis_ if (chrome_.mean(0) - pinned) @ axis_ > 0 else -axis_
			t = (rodwhite - pinned) @ axis_
			last = rodwhite[t > t.max() - 0.02] - pinned
			deep = np.cross(axis_, [0.0, 0.0, 1.0])
			deep /= np.linalg.norm(deep)
			ratio = float(np.ptp(last[:, 2]) / np.ptp(last @ deep)) if np.ptp(last @ deep) > 0 else 0.0
		else:
			ratio = 0.0
		yield result("layout.gear", "nose drag brace's yoke where it leaves the polished rod, across the jet against its depth", 1.0, ratio, 0.05, "share")
		# the wheels: each tyre's grooves round its tread, and its outer face's
		# holes, bolts and cap; the main wheels' brakes on their inner faces
		parts = jet.model.parts(verify.pose(jet.joints, down))
		finishes = jet.model.parts(verify.pose(jet.joints, down), materials=("rubber",))
		metals = jet.model.parts(verify.pose(jet.joints, down), materials=("hub", "white"))
		wheels = [("gear_left_wheel", "main", -1, "hub"), ("gear_right_wheel", "main", 1, "hub"), ("gear_nose_wheel", "nose", -1, "white"), ("gear_nose_wheel", "nose", 1, "white")]
		for name, tyre, sgn, metal in wheels:
			t_ = gear["tyres"][tyre]
			label = f"{name}{'' if tyre == 'main' else (' port' if sgn < 0 else ' starboard')}"
			everything = FRAME.source(parts[name].reshape(-1, 3))
			rubber = FRAME.source(finishes[name].reshape(-1, 3))
			if tyre == "nose":
				everything, rubber = everything[everything[:, 2] * sgn > 0], rubber[rubber[:, 2] * sgn > 0]
			axis = np.array([0.0, 0.0, float(sgn)])   # outboard
			tread = rubber[np.hypot(*(rubber[:, :2] - (rubber[:, :2].max(0) + rubber[:, :2].min(0)) / 2).T) > 0.5 * t_["diameter"] / 2]
			centre = (tread.max(0) + tread.min(0)) / 2
			r = np.hypot(rubber[:, 0] - centre[0], rubber[:, 1] - centre[1])
			z = (rubber - centre) @ axis
			outer = r.max()
			flat = np.abs(z) < t_["width"] / 4 + 0.05   # the tread's flat, between its shoulders
			bottoms = z[flat & (r > outer - 0.4) & (r < outer - gear["tyres"]["groove"]["depth"] * 0.5)]
			grooves = 0
			if len(bottoms):
				zs = np.sort(np.round(bottoms, 2))
				grooves = 1 + int(np.sum(np.diff(zs) > 0.25))
			yield result("layout.gear", f"{label}'s tread grooves", t_["grooves"], grooves, 0, "grooves")
			yield result("layout.gear", f"{label}'s tread grooves' depth", gear["tyres"]["groove"]["depth"], float(outer - r[flat & (r > outer - 0.4)].min()), 0.03)
			f_ = t_["face"]
			face = t_["width"] / 2 * 0.7
			holes = rubber[(r < t_["diameter"] / 2 * t_["hub"] - f_["flange"]) & (z > 0)]
			yield result("layout.gear", f"{label}'s lightening holes", f_["holes"]["count"], around(holes, centre, axis) if len(holes) else 0, 0, "holes")
			e = everything
			re = np.hypot(e[:, 0] - centre[0], e[:, 1] - centre[1])
			ze = (e - centre) @ axis
			disc = face - f_["recess"]
			bolts = e[(np.abs(re - f_["bolts"]["radius"]) < f_["bolts"]["diameter"]) & (ze > disc + 0.15) & (ze < disc + 0.5)]
			yield result("layout.gear", f"{label}'s bolts round its hub", f_["bolts"]["count"], around(bolts, centre, axis) if len(bolts) else 0, 0, "bolts")
			cap = re[(ze > disc + 0.5) & (ze < disc + 1.3) & (re < f_["cap"][0])]
			yield result("layout.gear", f"{label}'s hub cap across", f_["cap"][0], 2 * float(cap.max()) if len(cap) else 0.0, 0.1)
			# the tyre's section on this side, from the tread's edge round the
			# shoulder and down the sidewall to the bead: where it is widest,
			# and no corner on the way (the section had a 65 deg one at the
			# shoulder, a chamfer the photos' round tyres do not show)
			bead, edge = t_["diameter"] / 2 * t_["hub"], t_["width"] / 4
			# the section's points: every ring's vertices fall on one (r, z),
			# but a fifth of an inch apart at most from rounding, so merge
			# what lies closer than that, in order out from the tread
			wall = np.stack([r, z], 1)[(r > bead - 0.05) & (z > edge - 0.01)]
			wall = wall[np.argsort(-wall[:, 0])]
			merged = []
			for q in wall:
				if merged and np.hypot(*(q - merged[-1][-1])) < 0.02:
					merged[-1].append(q)
				else:
					merged.append([q])
			wall = np.array([np.mean(g, axis=0) for g in merged]) if merged else np.zeros((0, 2))
			widest = wall[np.argmax(wall[:, 1]), 0] if len(wall) else 0.0
			yield result("layout.gear", f"{label}'s sidewall widest, of the way from the bead to the tread", gear["tyres"]["bulge"], (widest - bead) / (outer - bead), 0.03, "share")
			legs_ = np.diff(wall, axis=0)
			heading = np.degrees(np.arctan2(legs_[:, 1], legs_[:, 0])) if len(legs_) else np.zeros(1)
			bends = np.abs((np.diff(heading) + 180) % 360 - 180) if len(heading) > 1 else np.zeros(1)
			yield result("shape.gear", f"{label}'s section from the tread round the shoulder to the bead: its sharpest bend", 0.0, float(bends.max()), 25.0, "deg")
			h_ = f_["holes"]
			if h_["count"]:
				# the lightening holes open through the web into the wheel's
				# dark inside, not dark patches on its face
				inside = rubber[(r < t_["diameter"] / 2 * t_["hub"] - f_["flange"]) & (z > 0)]
				zi = (inside - centre) @ axis
				yield result("layout.gear", f"{label}'s lightening holes' reach into the wheel below its web", h_["depth"], float(disc - zi.min()) if len(zi) else 0.0, 0.1)
				# the web's thickness, round each hole's wall in the hub's finish
				m_ = FRAME.source(metals[name].reshape(-1, 3))
				if tyre == "nose":
					m_ = m_[m_[:, 2] * sgn > 0]
				rm, zm = np.hypot(m_[:, 0] - centre[0], m_[:, 1] - centre[1]), (m_ - centre) @ axis
				wall_ = zm[(np.abs(rm - h_["radius"]) < h_["size"][1] / 2 + 0.05) & (zm < disc - 0.02) & (zm > disc - h_["depth"] - 0.1)]
				yield result("layout.gear", f"{label}'s web round its lightening holes", f_["web"], float(disc - wall_.min()) if len(wall_) else 0.0, 0.05)
			pl = f_.get("plate")
			if pl:
				# the hub cap's three-lobed plate on the web, outside the boss
				m_ = FRAME.source(metals[name].reshape(-1, 3))
				rm, zm = np.hypot(m_[:, 0] - centre[0], m_[:, 1] - centre[1]), (m_ - centre) @ axis
				on = (zm > disc + 0.02) & (zm < disc + pl["thickness"] + 0.02) & (rm > f_["cap"][0] / 2 + 0.05) & (rm < pl["radius"] + 0.5)
				yield result("layout.gear", f"{label}'s cap plate's lobes from the axle", pl["radius"], float(rm[on].max()) if on.any() else 0.0, 0.05)
				tips = m_[on & (rm > pl["radius"] - 0.3)]
				yield result("layout.gear", f"{label}'s cap plate's lobes", 3, around(tips, centre, axis, gap=40.0) if len(tips) else 0, 0, "lobes")
				top = zm[(rm > pl["radius"] - 0.1) & (rm < pl["radius"] + 0.05) & (zm > disc - 0.02) & (zm < disc + 0.5)]   # past its bolts' heads
				yield result("layout.gear", f"{label}'s cap plate's thickness", pl["thickness"], float(top.max() - disc) if len(top) else 0.0, 0.03)
			b_ = t_.get("brake")
			if b_:
				within = re < b_["diameter"] / 2 + 1.0
				housing = re[within & (ze > -face - b_["depth"] - 0.05) & (ze < -face - b_["depth"] + 0.3)]
				yield result("layout.gear", f"{label}'s brake housing across", b_["diameter"], 2 * float(housing.max()) if len(housing) else 0.0, 0.1)
				pistons = e[within & (ze < -face - b_["depth"] - 0.1)]
				yield result("layout.gear", f"{label}'s brake pistons", b_["pistons"]["count"], around(pistons, centre, -axis, gap=8.5) if len(pistons) else 0, 0, "pistons")

	yield from guard("layout.gear", "castings and wheels", castings)

	# The whole shape's own rules, which no fact states (shape.*): stowed parts
	# and the cockpit lie inside the airframe at rest, flush panels lie on the
	# skin with none of it poking through, each left part is its
	# right twin's mirror image, and every other part but the one-sided is
	# symmetric about the centreline
	def shapes():
		# no triangle is built that no view can see, inside or against another
		# part: drawn and painted for nothing
		found = hidden(jet.path, jet.file)
		worst = max(found, key=lambda name: found[name][0], default=None)
		yield result("shape.hidden", f"triangles no view can see{f', most on {worst}' if worst else ''}", 0, sum(n for n, _ in found.values()), 0, "triangles")
		# every store part hangs from what carries it, touching it: no daylight
		# between a side rail and its LAU-115, a tank and its pylon (the user
		# saw both)
		shown = {"stores": 1}
		parts = jet.parts(shown)
		for name in sorted(n for n in parts if STATION.match(n)):
			gap = apart(jet.points([name], shown).reshape(-1, 3, 3), jet.points([carrier(name)], shown).reshape(-1, 3, 3))
			yield result("shape.attached", f"{name} off {carrier(name)}, at its nearest", 0.0, gap, 0.1)
		# and every round on its seat touches the part it hangs from: its
		# hooks on its rail
		for station, hardpoint in sorted(jet.document["points"]["hardpoints"].items(), key=lambda kv: int(kv[0])):
			for name, seat in sorted(hardpoint.get("rounds", {}).items()):
				round_ = FRAME.source(hung(seat).reshape(-1, 3)).reshape(-1, 3, 3)
				yield result("shape.attached", f"{seat['kind']} off {name}, at its nearest", 0.0, apart(round_, jet.points([name], shown).reshape(-1, 3, 3)), 0.1)
		hull = jet.points(HULL).reshape(-1, 3, 3)
		for name in STOWED:
			corners = np.unique(jet.points([name]), axis=0)
			yield result("shape.stowed", f"{name}'s corners outside the airframe at rest", 0, (~enclosed(corners, hull)).sum(), 0, "corners")
		skin = jet.points(["fuselage"]).reshape(-1, 3, 3)
		# each fin, with its rudder's lower end, stands on the skin all along
		# its root: no daylight under it (the user saw the background through
		# a 5.2 in gap there)
		# Judged either side of the fin's chord plane, through its root's leading
		# edge at its cited cant and toe: fitted to the fin's own points, the
		# plane leaned with the faces the culling takes from under its fairing,
		# and the thin trailing edge's foot fell all to one side
		place, chord = F["layout"]["fin"]["root"], value(F["fin"]["root"])
		cant, toe = math.radians(value(F["fin"]["cant"])), math.radians(value(F["fin"]["toe"]))
		for side in ("left", "right"):
			sign = 1.0 if side == "right" else -1.0
			part = jet.points([f"fin_{side}", f"rudder_{side}", f"fin_root_{side}"]).reshape(-1, 3, 3)
			normal = np.cross([0.0, math.cos(cant), sign * math.sin(cant)], [math.cos(toe), 0.0, -sign * math.sin(toe)])
			gap = seated(part, skin, np.arange(place["station"] + 1.0, place["station"] + chord - 1.0, 2.0), (np.array([place["station"], place["waterline"], sign * place["buttline"]]), normal))
			yield result("shape.seated", f"fin_{side}'s root standing off the skin beneath it, its furthest", 0.0, float(np.maximum(gap, 0.0)), 0.05)
		# each fin's root fairing runs on to its rudder's lower leading corner and
		# ends there on the fin: no face of it turned aft stands proud of what
		# lies behind it by more than its seam (ended square at the band's end,
		# it stood a wedge 5.3 in across off the fin)
		for side in ("left", "right"):
			fair = jet.points([f"fin_fairing_{side}"]).reshape(-1, 3, 3)
			rudder = jet.points([f"rudder_{side}"])
			low = rudder[rudder[:, 1] < rudder[:, 1].min() + 0.6]
			corner = low[low[:, 0] < low[:, 0].min() + 0.6].mean(0)
			yield result("shape.fairing", f"fin_fairing_{side}'s nearest to its rudder's lower leading corner", 0.0, float(np.linalg.norm(fair.reshape(-1, 3) - corner, axis=1).min()), 1.5)
			behind = jet.points([f"fin_{side}", f"rudder_{side}", f"fin_root_{side}", f"fin_fairing_{side}", "fuselage"]).reshape(-1, 3, 3)
			yield result("shape.fairing", f"fin_fairing_{side}'s faces turned aft standing proud of what lies behind them, the furthest", 0.0, proud(fair, behind), 0.5)
		for name, below in FLUSH:
			gap = rim(jet, name)
			yield result("shape.flush", f"{name}'s closed face off the skin round its opening, its furthest", 0.0, gap, 0.1 if name.startswith("probe_") else 0.02)
			if name.startswith("gear_"):
				# its inside finish beginning half its inner depth under the
				# skin it was cut from: the edge's band in the outer face's
				# down past the hole's rim (white begun on the rim itself
				# showed along the closed doors' edges)
				yield result("shape.flush", f"{name}'s white faces under its outer face, their shallowest", PROUD.get(name, 0.0) + UNDER / 2, float(depths(jet, name, "white").min()), 0.01, "in")
				yield result("shape.flush", f"{name}'s painted faces under its outer face, their deepest", PROUD.get(name, 0.0) + UNDER / 2, float(depths(jet, name, "paint").max()), 0.01, "in")
		for spot in F["layout"]["hardpoints"]["stations"]:
			if spot["kind"] != "fuselage":
				continue
			mount = FRAME.source(jet.document["points"]["hardpoints"][str(spot["number"])]["mount"])
			# the section's segments that cross the station's buttline, where they
			# cross it: the skin's, and the cheek fairings' standing on it (the
			# skin under them is gone, the hidden faces' cull)
			a, b = jet.cut(["fuselage", "inlet_left", "inlet_right", "fairing_cheek_left", "fairing_cheek_right"], [spot["station"], 100, 0], [1, 0, 0]).reshape(-1, 2, 3).transpose(1, 0, 2)
			bl = spot["buttline"]
			across = (a[:, 2] - bl) * (b[:, 2] - bl) <= 0
			f = (bl - a[across, 2]) / np.where(b[across, 2] != a[across, 2], b[across, 2] - a[across, 2], 1)
			skin = a[across, 1] + f * (b[across, 1] - a[across, 1])
			if not len(skin):
				raise KeyError(f"no skin below station {spot['number']}")
			yield result("shape.mount", f"station {spot['number']}'s mount off the skin below it", 0.0, float(mount[1] - skin.min()), 0.1)
		# The skin turns sharply only at its real edges: a crease anywhere else is
		# the build joining its sources with straight runs or reading a traced
		# line pixel by pixel. Left out: the nose ahead of FS 95, the windscreen
		# and canopy (on the lines that meet them: from above, and from the side
		# down to 9 in under the sill, where the section is drawn in to it), the
		# inlets from their lips to 12 in behind where their skins hand over to
		# the fuselage (a blend between two shapes, held by shape.joint and
		# layout.nacelle instead), the gear doors' aft step (held by
		# layout.nacelle) and the nozzles
		skin = jet.points(["fuselage", "canopy", "windscreen", "inlet_left", "inlet_right"]).reshape(-1, 3, 3)
		stations = np.arange(95.0, 661.0, 1.0)
		cp = F["layout"]["canopy"]
		lip = min(p[0] for p in F["layout"]["inlet"]["lip"].values())
		# where the inlet's outer skin hands over: its last ring, the inlet's
		# open edge furthest aft (its duct runs on past it inside, closed by
		# the engine face)
		edge = FRAME.source(boundary(jet.tris(["inlet_right"])))
		join = float(edge[:, 0].max())

		def clear(*windows):
			keep = np.ones(len(stations), bool)
			for a, b in windows:
				keep &= ~((stations >= a) & (stations <= b))
			return keep

		# the canopy's top meets the spine's flat top at its aft end at the corner
		# the profiles show there (layout.canopy tail): an edge by design; so is
		# the step up at the aft end of the main gear doors' blister under each
		# nacelle (layout.nacelle door), seen from below and below the sill
		glass, inlet = (cp["windscreen"]["station"] - 14, cp["aft"]["station"] + 4), (lip - 8, join + 12)
		door = F["layout"]["nacelle"]["door"]
		blister = (door[-2][0] - 4, door[-1][0] + 8)
		side = np.arange(88.0, 148.0, 2.0)
		sill = min(p[1] for p in cp["sill"]) - 9
		# Each view's tolerance lies between the fixed build's worst (2.5, 2.9
		# and 2.8 deg: the tunnel's bump at FS 475 and the radome's junction at
		# FS 129 are smooth turns of the shape) and the loft's rings spread out
		# as they were: 20 in apart behind the canopy (3.2 above), 7-8 in over
		# the nose (3.2 outboard)
		for view, across, step, free, tolerance in (("above", np.arange(0.0, 16.0, 1.5), 1.5, clear(glass), 2.8), ("below", np.arange(0.0, 37.0, 1.5), 1.5, clear(inlet, blister), 3.5),
				("outboard", side, 2.0, np.array([clear(glass, inlet) if wl >= sill else clear(inlet, blister) for wl in side]), 3.0)):
			found = bends(lines(skin, view, stations, across), step, free)
			if not found:
				raise KeyError(f"no skin measured seen from {view}")
			yield result("shape.bend", f"skin's sharpest crease seen from {view}, away from its edges", 0.0, max(abs(f[3]) for f in found), tolerance, "deg")
		# the skin's waves on the same lines, from above out to the spine's
		# shoulder: a dip between humps or a hump between dips within 80 in,
		# which no crease check sees (the user saw a 0.4-0.8 in dip then hump
		# behind the canopy three times, where the forebody's sections were
		# blended into the rear fuselage and fitted to the side seam point by
		# point; the smooth loft behind the canopy carries none)
		for view, across, free in (("above", np.arange(0.0, 22.0, 1.5), clear(glass)), ("below", np.arange(0.0, 37.0, 1.5), clear(inlet, blister)),
				("outboard", side, np.array([clear(glass, inlet) if wl >= sill else clear(inlet, blister) for wl in side]))):
			H = lines(skin, view, stations, across)
			if not np.isfinite(H).any():
				raise KeyError(f"no skin measured seen from {view}")
			found = waves(H, stations, free, step=float(across[1] - across[0]))
			worst = max(found, key=lambda f: f[3], default=None)
			where = f" (at FS {worst[1]:g}, {'BL' if view != 'outboard' else 'WL'} {across[worst[0]]:g})" if worst else ""
			yield result("shape.wave", f"skin's largest dip then hump seen from {view}{where}", 0.0, worst[3] if worst else 0.0, 0.15)
		# the LEX's upper surface and its fairing, which eases it down behind the
		# junction onto the nacelle's shoulder: beside the body's wall (where the
		# root meets it) to inside the wing's root, and short of its square aft end
		top = jet.points(["lex_right", "fuselage", "inlet_right", "wing_inner_right"]).reshape(-1, 3, 3)
		end = float(jet.points(["lex_right"])[:, 0].max())
		# (the fixed build's worst 4.5 deg, where it lands on the skin; 11.5 when
		# it dived to the nacelle's top at JOIN and rose again, 6.9 settling twice).
		# No step on it is an edge: one that stood level and dropped onto the
		# skin at JOIN read as two surfaces meeting
		found = bends(lines(top, "above", stations, np.arange(26.5, 36.0, 1.5)), 1.5, clear(glass, (end - 6, stations[-1])), jump=None)
		yield result("shape.bend", "LEX's and its fairing's sharpest crease seen from above", 0.0, max((abs(f[3]) for f in found), default=np.inf), 5.0, "deg")
		# the belly from the nose to the inlets, where a traced line's pixel
		# steps would lie as ledges, spread over inches rather than creased
		found = bends(lines(skin, "below", stations, np.arange(0.0, 12.0, 1.5)), 1.5, clear(inlet) & (stations < lip - 8))
		yield result("shape.bend", "belly's sharpest bend between the nose and the inlets", 0.0, max((abs(f[2]) for f in found), default=np.inf), 2.8, "deg")
		# the deck between the fins falls aft with no hump: along its lines outboard
		# of the ridge, the most it rises going aft over FS 520-660 (the user saw a
		# 2.1 in hump at FS 592 behind a dip, the body fitted through the
		# speedbrake's edges; 0.2 in on the old deck)
		run = np.arange(520.0, 661.0, 2.0)
		H = lines(jet.points(["fuselage"]).reshape(-1, 3, 3), "above", run, np.arange(13.0, 24.1, 1.0))
		rise = max((float(np.nanmax(h[i:]) - h[i]) for h in H for i in range(len(h)) if np.isfinite(h[i])), default=np.inf)
		yield result("shape.deck", "deck between the fins: the most it rises going aft, BL 13-24", 0.0, rise, 1.2)
		sb = F["layout"]["speedbrake"]
		# the speedbrake's place: its front, back and side edges
		brake = jet.points(["speedbrake"])
		yield result("layout.speedbrake", "speedbrake's forward edge", sb["front"], brake[:, 0].min(), 0.5, "FS in")
		yield result("layout.speedbrake", "speedbrake's aft edge", sb["back"], brake[:, 0].max(), 0.5, "FS in")
		yield result("layout.speedbrake", "speedbrake's half-width", sb["half"], np.abs(brake[:, 2]).max(), 0.3, "BL in")
		# the canopy's aft end, which the crease checks leave out as an edge: its
		# fairing lifts the canopy's section onto the spine's within inches, but
		# turns no sharper than a fillet would (the fitted 11 deg an inch; 67
		# where the spine stood up to 2 in proud of the canopy within an inch)
		aft = cp["aft"]["station"]
		near = np.arange(aft - 8, aft + 17, 1.0)
		H = lines(jet.points(["fuselage", "canopy"]).reshape(-1, 3, 3), "above", near, np.arange(2.0, 16.01, 2.0))
		turns = np.degrees(np.arctan(H[:, 2:] - H[:, 1:-1]) - np.arctan(H[:, 1:-1] - H[:, :-2]))
		yield result("shape.bend", "skin's sharpest turn across the canopy's aft end seen from above, an inch either side", 0.0,
			float(np.nanmax(np.abs(turns))) if np.isfinite(turns).any() else np.inf, 20.0, "deg")
		# where each inlet's outer skin hands over to the fuselage: the part of the
		# fuselage's section that the nacelle adds stands nowhere outside the
		# inlet's last ring (its jump from the body to the nacelle, just ahead,
		# would show beside the ring). Added: outside the section 4.5 in ahead,
		# and away from it (the spine narrowing there moves its points inside),
		# and not inside the LEX over it (the body's wall under the LEX goes
		# as hidden faces)
		ring = np.unique(edge[np.abs(edge[:, 0] - join) < 0.02][:, [2, 1]].round(4), axis=0)
		middle = ring.mean(0)
		ring = ring[np.argsort(np.arctan2(ring[:, 1] - middle[1], ring[:, 0] - middle[0]))]
		behind = jet.cut(["fuselage"], [join + 0.1, 100, 0], [1, 0, 0])[:, [2, 1]]
		ahead = jet.cut(["fuselage"], [join - 4.5, 100, 0], [1, 0, 0])[:, [2, 1]].reshape(-1, 2, 2)
		over = jet.cut(["lex_right"], [join + 0.1, 100, 0], [1, 0, 0])[:, [2, 1]].reshape(-1, 2, 2)
		added = [q for q in behind if q[0] > 0 and segment_distance(q, ahead) > 0.5 and not inside_segments(q, ahead) and not inside_segments(q, over)]
		if not added:
			raise KeyError("the fuselage adds no nacelle where the inlet ends")
		outside = [segment_distance(q, np.stack([ring, np.roll(ring, -1, axis=0)], 1)) for q in added if not inside_polygon(q, ring)]
		yield result("shape.joint", "fuselage standing out of an inlet's end where it hands over", 0.0, max(outside, default=0.0), 0.1)
		every = jet.points(sorted(jet.parts())).reshape(-1, 3, 3)
		for first, second in SEAMS:
			for side in ("left", "right"):
				a, b = (jet.points([n if n == "fuselage" else f"{n}_{side}"]).reshape(-1, 3, 3) for n in (first, second))
				mirror = np.array([1.0, 1.0, -1.0 if side == "left" else 1.0])
				worst = max(((seam(a * mirror, b * mirror, every * mirror, view), view) for view in ("above", "below", "outboard")))
				yield result("shape.seam", f"{first}_{side} and {second} crossing back and forth, worst seen from {worst[1]}", 0, worst[0], 3.0, "sq in")
		for drives, pose in (({}, "at rest"), (down, "gear down"), ({"stores": 1}, "every store shown")):
			parts = jet.parts(drives)
			# the side is a segment of the name, last (aileron_left) or not (gear_left_wheel)
			for left in sorted(n for n in parts if "left" in n.split("_") and not n.startswith("nozzle_")):
				right = "_".join("right" if s == "left" else s for s in left.split("_"))
				if right in parts:
					yield result("shape.mirror", f"{left} against {right}, {pose}", 0, mirrored(jet.points([left], drives), jet.points([right], drives)), 0.1)
			# a store's station is its side (the contract's Stores): station 2 is
			# station 8's mirror, an "a" side the other "a"
			for left in sorted(n for n in parts if STATION.match(n) and int(STATION.match(n)[2]) < 5):
				base, number, point = STATION.match(left).groups()
				right = f"{base}_{10 - int(number)}{point}"
				if right in parts:
					yield result("shape.mirror", f"{left} against {right}, {pose}", 0, mirrored(jet.points([left], drives), jet.points([right], drives)), 0.1)
			# the nozzles whole: their flaps' stepped tabs turn the same way on
			# both engines (one engine, fitted either side: usaf120811FON144293
			# from below shows both staircases running the same way), so a
			# flap is no mirror of its twin, but the ring of them is, but for
			# the tabs' turn
			flaps = {side: sorted(n for n in parts if n.startswith(f"nozzle_{side}_petal_")) for side in ("left", "right")}
			if flaps["left"] and flaps["right"]:
				yield result("shape.mirror", f"left nozzle's flaps against the right's, {pose}", 0, mirrored(jet.points(flaps["left"], drives), jet.points(flaps["right"], drives)), 0.3)
			for name in sorted(n for n in parts if not {"left", "right"} & set(n.split("_")) and n not in ONE_SIDED
					and not (STATION.match(n) and STATION.match(n)[2] != "5")):
				p = jet.points([name], drives)
				yield result("shape.mirror", f"{name} about the centreline, {pose}", 0, mirrored(p, p), 0.1)

	yield from guard("shape", "shapes", shapes)

	# The nacelles' skin round the main gear's openings and the cheek station
	# (SMOOTH) shades smooth as exported: no triangle of no area, which a
	# point a cut leaves on an edge of a face it did not reach makes once that
	# face is split into triangles, and whose half turn there bends every
	# normal round the point into spikes; no corner's normal over 30 deg off
	# its triangle's, and no edge shaded smooth turning over 45 deg (the built
	# skin's worst 17 and 29, its real creases shaded sharp)
	def smooth():
		tris, normals = jet.shaded("fuselage")
		middle = FRAME.source(tris.mean(1))
		(f0, f1), (w0, w1), (b0, b1) = SMOOTH
		inside = (middle[:, 0] > f0) & (middle[:, 0] < f1) & (middle[:, 1] > w0) & (middle[:, 1] < w1) & (np.abs(middle[:, 2]) > b0) & (np.abs(middle[:, 2]) < b1)
		if not inside.any():
			raise KeyError("no fuselage skin round the main gear's openings")
		flat, off, worst, turn, where = shading(tris[inside], normals[inside])
		at = lambda k: " (at FS {:.0f}, WL {:.0f}, BL {:.0f})".format(*middle[inside][k]) if k is not None else ""
		yield result("shape.smooth", "nacelles' skin round the main gear's openings and the cheek station: triangles of no area", 0, flat, 0, "triangles")
		yield result("shape.smooth", f"there, a corner's normal off its triangle's, the worst{at(worst)}", 0.0, off, 30.0, "deg")
		yield result("shape.smooth", f"there, an edge shaded smooth turning, the worst{at(where)}", 0.0, turn, 45.0, "deg")

	yield from guard("shape.smooth", "nacelles' shading", smooth)

	# The stores' shapes (layout.stores, stores.lau7, stores.lau115,
	# stores.lau127), every store part shown: a group per store,
	# so one that cannot measure hides none of the others
	def stores():
		S, drives = F["layout"]["stores"], {"stores": 1}

		def section(names, point, normal):
			# The largest loop where a plane across `normal` through `point` cuts
			# the parts, in the plane's own axes (the first level), and its area
			normal = np.asarray(normal, float) / np.linalg.norm(normal)
			across = np.cross(normal, [0.0, 1.0, 0.0])
			across = across / np.linalg.norm(across)
			upward = np.cross(across, normal)
			best = None
			for loop in loops(jet.cut(names, point, normal, drives).reshape(-1, 2, 3)):
				if len(loop) < 4 or not np.allclose(loop[0], loop[-1]):
					continue
				flat = np.stack([(loop - point) @ across, (loop - point) @ upward], -1)
				if best is None or shoelace(flat) > best[1]:
					best = (flat, shoelace(flat))
			if best is None:
				raise ValueError(f"no section of {names} at {np.round(point, 1)}")
			return best

		def channel(names, point, normal, toward):
			# The channel along a launcher's face toward its round, across a plane
			# through `point`: its depth, the face's level less the section's reach
			# at the face's middle, and its width, where the reach falls more than
			# half that depth short
			normal = np.asarray(normal, float) / np.linalg.norm(normal)
			toward = np.asarray(toward, float) - normal * (np.asarray(toward, float) @ normal)
			toward = toward / np.linalg.norm(toward)
			side = np.cross(normal, toward)
			segments = jet.cut(names, point, normal, drives).reshape(-1, 2, 3) - point
			x, y = segments @ side, segments @ toward
			def reach(c):
				lo, hi = x.min(1), x.max(1)
				on = (lo <= c) & (hi >= c) & (hi > lo)
				k = (c - x[on, 0]) / (x[on, 1] - x[on, 0])
				return (y[on, 0] + k * (y[on, 1] - y[on, 0])).max()
			level = y.max()
			flat = x[y >= level - 0.02]
			middle = (flat.min() + flat.max()) / 2
			depth = level - reach(middle)
			if depth < 0.01:
				return depth, 0.0   # no channel
			edges = []
			for step in (-0.005, 0.005):
				c = middle
				while reach(c) < level - depth / 2:
					c += step
				edges.append(c)
			return depth, edges[1] - edges[0]

		def axes(name, station):
			# a launcher's or rack's axes from the round it carries: aft along
			# it, and from it toward the round (against the round's up)
			seat = jet.document["points"]["hardpoints"][station]["rounds"][name]
			ends = FRAME.source(np.array([seat["mount"], np.add(seat["mount"], seat["forward"]), np.add(seat["mount"], seat["up"])]))
			aft, up = ends[0] - ends[1], ends[2] - ends[0]
			return aft / np.linalg.norm(aft), -up / np.linalg.norm(up)

		def square(rounding, w, h):
			# a section's area against its box's, its corners rounded by
			# `rounding` of its smaller half
			r = rounding * min(w, h) / 2
			return 1 - (4 - math.pi) * r * r / (w * h)
		def tip():
			# The wingtip LAU-7: its length tip to tip, its section, its forward
			# cap and aft cone (where its section first and last stands whole), and
			# the channel along its outboard face
			tip = S["rails"]["tip"]
			front, aft = np.array(tip["front"], float), np.array(tip["aft"], float)
			axis = (aft - front) / np.linalg.norm(aft - front)
			p = jet.points(["rail_9"], drives)
			along = (p - front) @ axis
			off = p - front - np.outer(along, axis)
			rail = np.abs(off[:, 1]) <= value(F["stores"]["lau7"]["width"]) / 2 + 0.05   # the rail's own corners, not its housings
			ends = along[rail]
			yield result("stores.lau7.length", "wingtip rail, tip to tip", value(F["stores"]["lau7"]["length"]), ends.max() - ends.min(), 0.3)
			middle = front + axis * 25.0   # clear of the fitting strip (40 to 90 in) and the housings
			flat, _ = section(["rail_9"], middle, axis)
			yield result("stores.lau7.width", "wingtip rail's section, standing", value(F["stores"]["lau7"]["width"]), np.ptp(flat[:, 1]), 0.05)
			yield result("stores.lau7.height", "wingtip rail's section, across", value(F["stores"]["lau7"]["height"]), np.ptp(flat[:, 0]), 0.05)
			depth, width = channel(["rail_9"], middle, axis, axes("rail_9", "9")[1])
			yield result("layout.stores", "wingtip rail's channel, deep", tip["channel"][1], depth, 0.05)
			yield result("layout.stores", "wingtip rail's channel, wide", tip["channel"][0], width, 0.05)
			stations = np.unique(np.round(ends, 2))
			full = np.array([np.ptp(p[rail][np.abs(along[rail] - t) < 0.01][:, 1]) for t in stations])
			whole = stations[full >= 0.995 * np.ptp(flat[:, 1])]   # its section whole, as half way along it
			yield result("layout.stores", "wingtip rail's forward cap, whole behind its tip", tip["nose"]["run"], whole.min() - ends.min(), 0.5)
			yield result("layout.stores", "wingtip rail's aft cone", tip["cone"], ends.max() - whole.max(), 0.5)
			# the ends' profiles (nose, taper): the section's standing height as a
			# share of the whole, between the rings either side
			standing = np.ptp(flat[:, 1])
			# the rail's own rings: a ring's worth of points within its section
			# across, not a stray vertex of the strips or the fairing's last ring
			counts = np.array([np.sum(np.abs(ends - t) < 0.01) for t in stations])
			across = np.array([np.ptp(off[rail][np.abs(ends - t) < 0.01][:, 2]) for t in stations])
			ring = (counts >= 20) & (across <= value(F["stores"]["lau7"]["height"]) + 0.1)
			share = lambda t: float(np.interp(t, stations[ring] - ends.min(), full[ring])) / standing
			nose, taper = tip["nose"], tip["taper"]
			for t in (1.1, 2.0):
				expect = nose["tip"] + (1 - nose["tip"]) * math.sin(math.pi / 2 * min(t / nose["run"], 1.0))
				yield result("layout.stores", f"wingtip rail's cap {t} in behind its tip, its share of the section", round(expect, 3), share(t), 0.03, "share")
			for d in (4.4, 7.7):
				expect = max(0.01, taper["close"] + (1 - taper["close"]) * min(d / tip["cone"], 1.0) ** taper["power"])
				yield result("layout.stores", f"wingtip rail's cone {d} in ahead of its tip, its share of the section", round(expect, 3), share(ends.max() - ends.min() - d), 0.03, "share")
			# the fairing and the formation lights' housings joining it to the tip
			# (layout.stores.rails.tip.adapter): each housing's outline, across it
			# at its middle buttline; the fairing's top at the rail's level out to
			# the step and at the wing's edge beyond it, clear of the housings
			adapter = tip["adapter"]
			most = lambda a: a.max() if len(a) else math.nan
			least = lambda a: a.min() if len(a) else math.nan
			strips, housing = F["layout"]["strips"], adapter["housings"]
			for key, above in (("tip", True), ("undertip", False)):
				(f0, w0, b0), (f1, w1, b1) = sorted(strips[key])
				face = (abs(b0) + abs(b1)) / 2
				cut = jet.cut(["rail_9"], np.array([(f0 + f1) / 2, (w0 + w1) / 2, face - housing["thick"] / 2]), [0.0, 0.0, 1.0], drives).reshape(-1, 3)
				cut = cut[(cut[:, 0] > f0 - 8) & (cut[:, 0] < f1 + 8) & ((cut[:, 1] > w0) if above else (cut[:, 1] < w0))]
				sign = 1 if above else -1
				for word, f, w in (("forward", f0, w0), ("aft", f1, w1)):
					edge = w + sign * (strips["width"] / 2 + housing["rim"])
					near = cut[np.abs(cut[:, 0] - (f + (housing["end"] if word == "aft" else -housing["end"]))) < 0.4]
					yield result("layout.stores", f"{key} strip's housing, its outer edge at its {word} end", edge, (most(near[:, 1]) if above else least(near[:, 1])), 0.05, "WL in")
				line = lambda f: w0 + (f - f0) * (w1 - w0) / (f1 - f0) + sign * (strips["width"] / 2 + housing["rim"])
				outer = cut[np.abs(cut[:, 1] - line(cut[:, 0])) < 0.1]
				yield result("layout.stores", f"{key} strip's housing, its outer edge's length", f1 - f0 + 2 * housing["end"], np.ptp(outer[:, 0]) if len(outer) else math.nan, 0.3)
				# its thickness 0.3 in inside its outer edge, clear of the fairing below it
				middle = (f0 + f1) / 2
				across = jet.cut(["rail_9"], np.array([middle, line(middle) - sign * 0.3, face]), [0.0, 1.0, 0.0], drives).reshape(-1, 3)
				across = across[(across[:, 2] > face - housing["thick"] - 0.6) & (across[:, 2] < face + 0.6)]
				yield result("layout.stores", f"{key} strip's housing, thick", housing["thick"], np.ptp(across[:, 2]) if len(across) else math.nan, 0.05)
			station = 530.0
			k = (station - front[0]) / (aft[0] - front[0])
			half = value(F["stores"]["lau7"]["width"]) / 2
			top, bottom = front[1] + k * (aft[1] - front[1]) + half - 0.15, front[1] + k * (aft[1] - front[1]) - half + 0.15
			# the section's waterlines where its segments cross the buttline just
			# outboard of the step
			segments = jet.cut(["rail_9"], np.array([station, top, 226.0]), [1.0, 0.0, 0.0], drives).reshape(-1, 2, 3)
			def crossing(at):
				spans = segments[(segments[:, 0, 2] - at) * (segments[:, 1, 2] - at) <= 0]
				share = (at - spans[:, 0, 2]) / np.where(spans[:, 1, 2] == spans[:, 0, 2], 1.0, spans[:, 1, 2] - spans[:, 0, 2])
				wl = spans[:, 0, 1] + share * (spans[:, 1, 1] - spans[:, 0, 1])
				return most(wl), least(wl)
			beside = crossing(adapter["step"] + 0.5)
			yield result("layout.stores", "wingtip fairing's top just outboard of the step, against the rail's", top, beside[0], 0.05, "WL in")
			yield result("layout.stores", "wingtip fairing's underside just outboard of the step, against the rail's", bottom, beside[1], 0.05, "WL in")
			ends = crossing(adapter["edge"] - 0.3 + 0.02)
			inboard = crossing(adapter["step"] - 0.5)
			k = 0.5 / (adapter["step"] - adapter["edge"] + 0.3)
			yield result("layout.stores", "wingtip fairing's top just inboard of the step, on its rise to the tip's edge", top + k * (ends[0] - top), inboard[0], 0.05, "WL in")
			yield result("layout.stores", "wingtip fairing's underside just inboard of the step, on its rise to the tip's edge", bottom + k * (ends[1] - bottom), inboard[1], 0.05, "WL in")
			# the lower housing the upper's mirror about the rail: its outer edge
			# as far under the rail's bottom as the upper's stands over its top,
			# less their strips' gaps to the rail, half way along each, and its
			# plate at the upper's buttline
			reach = {}
			for key, above in (("tip", True), ("undertip", False)):
				(f0, w0, b0), (f1, w1, b1) = sorted(strips[key])
				middle = (f0 + f1) / 2
				k = (middle - front[0]) / (aft[0] - front[0])
				axis_wl = front[1] + k * (aft[1] - front[1])
				face = (abs(b0) + abs(b1)) / 2
				cut = jet.cut(["rail_9"], np.array([middle, axis_wl, face - housing["thick"] / 2]), [0.0, 0.0, 1.0], drives).reshape(-1, 3)
				cut = cut[np.abs(cut[:, 0] - middle) < 0.5]
				reach[key] = most(cut[:, 1]) - (axis_wl + half) if above else (axis_wl - half) - least(cut[:, 1])
				across = jet.cut(["rail_9"], np.array([middle, (w0 + w1) / 2 + (1 if above else -1) * strips["width"] / 2, face]), [0.0, 1.0, 0.0], drives).reshape(-1, 3)
				across = across[(across[:, 2] > face - housing["thick"] - 0.6) & (across[:, 2] < face + 0.6) & (across[:, 0] > f0 - 6.0) & (across[:, 0] < f1 + 6.0)]
				reach[key + " face"] = most(across[:, 2])
			gap = strips["gap"]
			yield result("layout.stores", "wingtip lower housing's reach under the rail against the upper's over it, less the strips' gaps", reach["tip"] - gap["tip"], reach["undertip"] - gap["undertip"], 0.15)
			yield result("layout.stores", "wingtip lower housing's outboard face against the upper's", reach["tip face"], reach["undertip face"], 0.05, "BL in")

		def side():
			# a side rail's channel, the same LAU-7's: across station 8's outer
			# rail half way along it
			q = jet.points(["rail_8a"], drives)
			lead, down = axes("rail_8a", "8")
			reach = (q - q.mean(0)) @ lead
			depth, width = channel(["rail_8a"], q.mean(0) + lead * ((reach.min() + reach.max()) / 2 + 3.0), lead, down)
			yield result("layout.stores", "station 8's outer side rail's channel, deep", S["rails"]["tip"]["channel"][1], depth, 0.05)
			yield result("layout.stores", "station 8's outer side rail's channel, wide", S["rails"]["tip"]["channel"][0], width, 0.05)

		def rack():
			# The LAU-115 under station 8's pylon: its length, and its section half
			# way along
			r = jet.points(["rack_8"], drives)
			lead = axes("rack_8", "8")[0]
			reach = (r - r.mean(0)) @ lead
			# its length along its axis at mid-height: its end faces stand upright
			# on its sloping axis, so their corners reach past its middle line's ends
			level = np.array([0.0, 1.0, 0.0]) - lead * lead[1]
			level = level / np.linalg.norm(level)
			height = r @ level
			cut = jet.cut(["rack_8"], r.mean(0) + level * ((height.min() + height.max()) / 2 - r.mean(0) @ level), level, drives).reshape(-1, 3)
			yield result("stores.lau115.length", "station 8's LAU-115, end to end at mid-height", value(F["stores"]["lau115"]["length"]), np.ptp(cut @ lead), 0.3)
			flat, area = section(["rack_8"], r.mean(0) + lead * ((reach.min() + reach.max()) / 2), lead)
			w, h = np.ptp(flat[:, 0]), np.ptp(flat[:, 1])
			yield result("stores.lau115.width", "station 8's LAU-115's section, across", value(F["stores"]["lau115"]["width"]), w, 0.1)
			yield result("stores.lau115.height", "station 8's LAU-115's section, standing", value(F["stores"]["lau115"]["height"]), h, 0.1)
			yield result("layout.stores", "station 8's LAU-115's section against its box", square(S["rack"]["corner"], w, h), area / (w * h), 0.005, "share")
			# its front: upright, a ring in the upright plane across its axis 0.05 in
			# behind the front's middle standing `tip` of its height
			flat_ = np.array([lead[0], 0.0, lead[2]]) / np.linalg.norm([lead[0], lead[2]])
			front = cut[np.argmin(cut @ lead)]
			ring = jet.cut(["rack_8"], front + flat_ * 0.05, flat_, drives).reshape(-1, 3)
			tips = S["rack"]["tip"] if isinstance(S["rack"]["tip"], list) else [S["rack"]["tip"]] * 2
			yield result("layout.stores", "station 8's LAU-115's front, its height 0.05 in behind it", tips[1] * value(F["stores"]["lau115"]["height"]), np.ptp(ring[:, 1]), 0.2)
			yield result("layout.stores", "station 8's LAU-115's front, its width 0.05 in behind it", tips[0] * value(F["stores"]["lau115"]["width"]), np.ptp(ring @ np.cross(flat_, [0.0, 1.0, 0.0])), 0.2)

		def launcher():
			# station 8's outer LAU-127: its length; its section aft of the fitting
			# joining it to the LAU-115, in its own axes; its nose
			body = S["rails"]["launcher"]
			q = jet.points(["launcher_8a"], drives)
			lead, down = axes("launcher_8a", "8")
			reach = (q - q.mean(0)) @ lead
			yield result("stores.lau127.length", "station 8's outer LAU-127, end to end", value(F["stores"]["lau127"]["length"]), np.ptp(reach), 0.3)
			side = np.cross(lead, down)
			at = q.mean(0) + lead * (reach.max() - 10.0)
			cut = jet.cut(["launcher_8a"], at, lead, drives).reshape(-1, 3) - at
			yield result("stores.lau127.width", "station 8's outer LAU-127's section, across", value(F["stores"]["lau127"]["width"]), np.ptp(cut @ side), 0.1)
			yield result("stores.lau127.height", "station 8's outer LAU-127's section, standing", value(F["stores"]["lau127"]["height"]), np.ptp(cut @ down), 0.1)
			flat, area = section(["launcher_8a"], at, lead)
			w, h = np.ptp(cut @ side), np.ptp(cut @ down)
			yield result("layout.stores", "station 8's outer LAU-127's section against its box", square(body["corner"], w, h), area / (w * h), 0.005, "share")
			# its nose: each face (the round's, toward `down`, and the one away
			# from it) against its full line just behind both runs, ahead of the
			# fitting (which starts 3 in behind the LAU-115's front), at its own
			# run's ring and half way along it; the tip's height and where it
			# stands between them
			height = value(F["stores"]["lau127"]["height"])
			face = (q - q.mean(0)) @ down
			plus, minus = body["faces"]["runs"]
			full = (reach > reach.min() + max(plus, minus) + 0.5) & (reach < reach.min() + 15.0)
			toward, away = face[full].max(), face[full].min()
			def ring(run):
				# the ring nearest `run` behind the tip
				d = np.abs(reach - (reach.min() + run))
				return d < d.min() + 0.02
			yield result("layout.stores", f"station 8's outer LAU-127's round's face, {minus} in behind its tip, against its line", 0.0, face[ring(minus)].max() - toward, 0.05)
			yield result("layout.stores", f"station 8's outer LAU-127's far face, {plus} in behind its tip, against its line", 0.0, face[ring(plus)].min() - away, 0.05)
			for run, at_, sign, line, name in ((minus, body["faces"]["at"] - body["tip"] / 2, 1.0, toward, "round's face"), (plus, 1 - body["faces"]["at"] - body["tip"] / 2, -1.0, away, "far face")):
				drop = at_ * height * (1 - math.sin(math.pi / 4))
				reached = face[ring(run / 2)].max() if sign > 0 else face[ring(run / 2)].min()
				yield result("layout.stores", f"station 8's outer LAU-127's {name}, {run / 2} in behind its tip, short of its line", drop, sign * (line - reached), 0.05)
			tip_ = q[np.argmin(reach)]
			cut = jet.cut(["launcher_8a"], tip_ + lead * 0.05, lead, drives).reshape(-1, 3) - q.mean(0)
			yield result("layout.stores", "station 8's outer LAU-127's nose, its height 0.05 in behind its tip", body["tip"] * height, np.ptp(cut @ down), 0.1)
			yield result("layout.stores", "station 8's outer LAU-127's tip, its middle up from its round's face", body["faces"]["at"] * height, toward - ((cut @ down).max() + (cut @ down).min()) / 2, 0.1)

		def ejector():
			# station 6's LAU-116 as the photos show it (layout.stores.lau116): its
			# block and the fairing over it, the airframe's (the cheek station's
			# node, so shown with no stores as on the clean jets' photos: read at
			# rest), its front edge where the photos mark it (the crease where the
			# ramp, drawn in, meets the face's plane, 0.8 in), its face at the
			# marks' buttlines (0.3 in) and its bottom (0.1 in) 2 in behind it, the
			# crest's height (0.1 in) just behind it and its buttline at its own
			# station (the section's top, within its marks' spread); the station's
			# top along the fairing's line at its knots, over the box set in from
			# the box's top corner and ending on its top; the ramp's line at its
			# knots and its front; and at its joint with the box, its face and its
			# bottom running on into the box's: each read 0.5 in either side of the
			# joint
			lau, box = S["lau116"], F["layout"]["nacelle"]["cheek"]
			fairing, ramp = lau["fairing"], lau["fairing"]["ramp"]
			e = jet.points(["fairing_cheek_right"])
			front = (lau["front_top"][0] + lau["front_bottom"][0]) / 2
			line = lambda knots, s: float(np.interp(s, *zip(*knots)))
			section = lambda station: jet.cut(["fairing_cheek_right"], [station, 100, 0], [1, 0, 0])

			def across(station, outer=-math.inf):
				# the section at a station: its lowest and highest waterline and its
				# outboard buttline, of its points outboard of `outer`
				c = section(station).reshape(-1, 3)
				c = c[c[:, 2] > outer]
				return (c[:, 1].min(), c[:, 1].max(), c[:, 2].max()) if len(c) else (math.nan,) * 3

			# its front edge, the foremost corner on the face's plane between its
			# bottom's corner and an inch under the box's top's height, within 8 in
			# of the marks (ahead of it the ramp's sections are drawn in off the
			# plane, by little near the top where the skin flares out to it)
			knee = line(box["top"], box["front"])
			on = e[(np.abs(e[:, 2] - cheek_face(e[:, 0], e[:, 1])) < 0.02) & (e[:, 1] > lau["front_bottom"][1] + 0.3) & (e[:, 1] < knee - 1.0) & (np.abs(e[:, 0] - front) < 8)]
			built = on[:, 0].min() if len(on) else math.nan
			for key, mark in (("front_top", lau["front_top"]), ("front_bottom", lau["front_bottom"])):
				yield result("layout.stores", f"station 6's LAU-116's front edge against {key}'s station", mark[0], built, 0.8, "FS in")
			yield result("layout.stores", "station 6's LAU-116's face against front_top's buttline", lau["front_top"][2], across_at(section(front + 2.0), lau["front_top"][1]), 0.3, "BL in")
			yield result("layout.stores", "station 6's LAU-116's bottom against front_bottom's waterline", lau["front_bottom"][1], across(front + 2.0)[0], 0.1, "WL in")
			yield result("layout.stores", "station 6's LAU-116's face against the hole's buttline", lau["hole"][2], across_at(section(lau["hole"][0]), lau["hole"][1]), 0.3, "BL in")
			yield result("layout.stores", "station 6's LAU-116's front edge's crest, 0.05 in behind it", lau["crest"][1], across(front + 0.05)[1], 0.1, "WL in")
			c = section(lau["crest"][0]).reshape(-1, 3)
			yield result("layout.stores", f"station 6's LAU-116's crest, its buttline (the section's top at FS {lau['crest'][0]:g})", lau["crest"][2], c[np.argmax(c[:, 1]), 2] if len(c) else math.nan, 0.38, "BL in")
			for station, want in fairing["top"][:-1]:
				yield result("layout.stores", f"station 6's LAU-116's fairing's top at FS {station:g}", want, across(station)[1], 0.1, "WL in")
			end = fairing["top"][-1][0]
			risen = e[e[:, 1] > np.interp(e[:, 0], *zip(*box["top"])) + 0.2]
			yield result("layout.stores", "station 6's LAU-116's fairing's aft end on the box's top", end, risen[:, 0].max() if len(risen) else math.nan, 1.0, "FS in")
			middle = (box["front"] + end) / 2
			top = line(box["top"], middle)
			yield result("layout.stores", f"station 6's LAU-116's fairing over the box set in from its top corner, 0.3 in over it at FS {middle:g}",
				fairing["inset"], cheek_face(middle, top) - across_at(section(middle), top + 0.3), 0.1, "BL in")
			for station, want in ramp["top"][1:]:
				yield result("layout.stores", f"station 6's LAU-116's ramp's top at FS {station:g}", want, across(station)[1], 0.1, "WL in")
			yield result("layout.stores", "station 6's LAU-116's ramp's front", ramp["top"][0][0], e[:, 0].min(), 0.05, "FS in")
			# its forward hook, the store's, where the photos put it (hooks
			# forward): the middle of the foot of the hook ahead of the hooks'
			# middle, where it stands on the round
			hooks = jet.points(["ejector_6"], {"stores": 1})
			forward = hooks[hooks[:, 0] < (hooks[:, 0].min() + hooks[:, 0].max()) / 2]
			forward = forward[forward[:, 1] < forward[:, 1].min() + 0.3]
			yield result("layout.stores", "station 6's LAU-116's forward hook's middle", lau["hooks"]["forward"]["station"], (forward[:, 0].min() + forward[:, 0].max()) / 2, 0.1, "FS in")
			ahead, behind = across(box["front"] - 0.5), across(box["front"] + 0.5)
			yield result("layout.stores", "station 6's LAU-116's face 0.5 in ahead of its aft end against the cheek box's 0.5 in behind its front", behind[2], ahead[2], 0.05, "BL in")
			yield result("layout.stores", "station 6's LAU-116's bottom 0.5 in ahead of its aft end against the cheek box's 0.5 in behind its front", behind[0], ahead[0], 0.1, "WL in")

		def pylon():
			# The SUU-62: its bottom flat at its front's lower end, clear of the
			# tank (the braces apart), and its sides flat: its section's area
			# against its box's, as its corners' rounding gives
			line = S["centreline"]
			c = jet.points(["pylon_5"], drives)
			clear = (c[:, 0] > line["front"] + 3) & (c[:, 0] < line["back"] - 14) & np.all([np.abs(c[:, 0] - b) > 3.0 for b in line["braces"]], 0)
			yield result("layout.stores", "SUU-62's bottom, between its braces", line["bottom"], c[clear][:, 1].min(), 0.05, "WL in")
			pads = c[c[:, 1] < line["bottom"] - 0.5]
			yield result("layout.stores", "SUU-62's brace pads, their station", np.mean(line["braces"]), (pads[:, 0].min() + pads[:, 0].max()) / 2, 0.1, "FS in")
			flat, area = section(["pylon_5"], np.array([(line["front"] + line["back"]) / 2, 80.0, 0.0]), [1.0, 0.0, 0.0])
			w, h = np.ptp(flat[:, 0]), np.ptp(flat[:, 1])
			# its corners' radius from the section's area short of its box
			yield result("layout.stores", "SUU-62's section's corners, their radius", line["corner"] * min(w, h) / 2, math.sqrt(max(0.0, w * h - area) / (4 - math.pi)), 0.1)
			# its sides closing to its leading edge in straight lines: half its
			# width half way along the taper
			lead = (line["front"] + line["top"]) / 2
			flat, _ = section(["pylon_5"], np.array([lead + line["taper"] / 2, 81.0, 0.0]), [1.0, 0.0, 0.0])
			yield result("layout.stores", "SUU-62's width half way along its nose's taper", line["width"] / 2, np.ptp(flat[:, 0]), 0.1)
			# its aft end (dvids_4642578): full width to the upright aft face, and
			# the bottom rising into it round its corner (its first ring aft)
			flat, _ = section(["pylon_5"], np.array([line["back"] - line["round"] - 1.0, 81.0, 0.0]), [1.0, 0.0, 0.0])
			yield result("layout.stores", "SUU-62's width 1 in ahead of its aft corner", line["width"], np.ptp(flat[:, 0]), 0.1)
			r = line["round"]
			at_ = line["back"] - r * math.sin(math.pi / 12)
			ring = c[np.abs(c[:, 0] - at_) < 0.02]
			yield result("layout.stores", "SUU-62's bottom where it rounds into its aft face", line["bottom"] + r - math.sqrt(r * r - (at_ - (line["back"] - r)) ** 2),
				ring[:, 1].min() if len(ring) else math.nan, 0.03, "WL in")
			yield result("layout.stores", "SUU-62's aft face, its station", line["back"], c[:, 0].max(), 0.05, "FS in")
			# the wing pylons' width, square across their middles (the right
			# outboard and inboard)
			for station in (7, 8):
				p = jet.points([f"pylon_{station}"], drives)
				middle = (p[:, 0].min() + p[:, 0].max()) / 2
				flat, _ = section([f"pylon_{station}"], np.array([middle, p[:, 1].min() + 2.0, np.median(p[:, 2])]), [1.0, 0.0, 0.0])
				yield result("layout.stores", f"station {station}'s pylon's width, across its middle", S["pylon"]["width"], np.ptp(flat[:, 0]), 0.1)

		return [("the wingtip LAU-7", tip), ("station 8's outer side rail", side), ("station 8's LAU-115", rack), ("station 8's outer LAU-127", launcher), ("station 6's LAU-116", ejector), ("the pylons", pylon)]

	for what, fn in stores():
		yield from guard("layout.stores", f"{what}'s shape", fn)

	# The stores' own atlas (layout.stores.paint, finish.py), read through the
	# station 7 tank's UVs: its joint rings darker than the paint beside them
	# all round, and its filler cap in the lid's colour on its right and not on
	# its left
	stores = atlas(jet.path, "stores")

	def stores_paint():
		if stores is None:
			return
		spec, tank = F["layout"]["stores"]["paint"], F["layout"]["stores"]["tank"]
		tris, uvs = jet.textured(("stores",), ["tank_7"])
		nose, tail = np.array(tank["nose"], float), np.array(tank["tail"], float)
		axis = (tail - nose) / np.linalg.norm(tail - nose)
		# the tank's right (+BL) and up (+WL), square to its axis (the source
		# frame's FS, WL, BL is left-handed: no cross products)
		right = np.array([0.0, 0.0, 1.0]) - axis * axis[2]
		right /= np.linalg.norm(right)
		up = np.array([0.0, 1.0, 0.0]) - axis * axis[1] - right * right[1]
		up /= np.linalg.norm(up)
		profile = np.array(tank["profile"], float)
		scale = np.linalg.norm(tail - nose) / profile[-1, 0]

		def read(station, turns):
			# the stores' atlas where the tank's skin is at a station (inches
			# from its nose) and turns (degrees from its top toward its right)
			t = np.radians(np.asarray(turns, float))
			out = np.outer(np.cos(t), up) + np.outer(np.sin(t), right)
			radius = np.interp(station / scale, profile[:, 0], profile[:, 1])
			points = nose + axis * station + out * radius
			values = []
			for p, n in zip(points, out):
				k, b = hits(tris, (p + 2.0 * n)[None], -n)
				if k[0] < 0:
					values.append(np.nan)
					continue
				u, v = b[0]
				uv = uvs[k[0], 0] * (1 - u - v) + uvs[k[0], 1] * u + uvs[k[0], 2] * v
				values.append(float(sample(stores, uv[None])[0]))
			return np.array(values)

		# a ring darkens the texels it crosses by its depth times the share of
		# them its width covers: the tank's texels' size from its triangles'
		# UVs, the ring read at its darkest across a texel either side
		e1, e2 = uvs[:, 1] - uvs[:, 0], uvs[:, 2] - uvs[:, 0]
		area = np.linalg.norm(np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0]), axis=1) / 2
		texel = float(np.median(np.sqrt(area / np.maximum(np.abs(e1[:, 0] * e2[:, 1] - e1[:, 1] * e2[:, 0]) / 2 * stores.shape[0] ** 2, 1e-12))))
		darker = spec["line"]["depth"] * min(1.0, spec["line"]["width"] / texel)
		turns = np.linspace(-150, 150, 13)
		for joint, step in zip(spec["tank"]["joints"], (2.0, -2.0)):
			ring = np.nanmin([read(joint + d, turns) for d in np.arange(-texel, texel + 1e-9, texel / 4)], axis=0)
			ratio = float(np.nanmedian(ring / read(joint + step, turns)))
			yield result("paint.stores", f"tank's joint ring at {joint} in against the paint beside, {texel:.2f} in texels", round(1 - darker, 3), ratio, round(darker / 2, 3), "share")
		cap = spec["tank"]["cap"]
		lid = np.array(cap["colour"], float) @ [0.299, 0.587, 0.114]
		paint = np.array(F["layout"]["paint"]["lower"], float) @ [0.299, 0.587, 0.114]
		on, off = read(cap["station"], [cap["turn"]])[0], read(cap["station"], [-cap["turn"]])[0]
		yield result("paint.stores", "tank's filler cap on its right against its left", lid / paint, on / off, 0.15, "share")

	yield from guard("paint", "stores' paint", stores_paint)

	# The landing gear's finishes (layout.paint gear): its legs, braces and
	# fittings white or chrome, its tyres rubber, its hubs white or the main's
	# hub finish, its doors' outer faces the paint and the rest of them white,
	# its bays white
	def gear_finishes():
		finishes = {}   # node: {material: triangles}
		for n in jet.model.nodes:
			name = n["name"]
			if n["mesh"] is None or not (name.startswith(("gear_", "well_")) or name == "launch_bar"):
				continue
			for tris, material in jet.model.meshes[n["mesh"]]:
				finishes.setdefault(name, {})
				finishes[name][material] = finishes[name].get(material, 0) + len(tris)
		legs = [n for n in finishes if n.startswith("gear_") and "door" not in n and "wheel" not in n and n != "gear_nose_lamps"] + ["launch_bar", "gear_nose_lamps"]
		if len(legs) < 20:
			raise KeyError(f"gear: only {len(legs)} legs' parts built")
		yield result("shape.gear", "legs' faces in neither white nor chrome", 0, sum(c for n in legs for m, c in finishes.get(n, {}).items() if m not in ("white", "chrome") and not (n == "launch_bar" and m == "rubber") and not (n.endswith("_shock") and m == "red") and not (n in ("gear_left_strut", "gear_right_strut", "gear_nose_strut", "gear_nose_brace_rod", "gear_left_brace_fittings", "gear_right_brace_fittings") and m == "hub") and not (n == "gear_nose_strut" and m == "rubber")), 0, "faces")
		# the main shock absorbers' red band (layout.gear legs main castings
		# shock band), on each shock's cap and nowhere else on the legs
		for leg in ("left", "right"):
			yield result("shape.gear", f"{leg} main shock's red band faces", 1, int(finishes.get(f"gear_{leg}_shock", {}).get("red", 0) > 0), 0, "present")
		# the launch bar's black band (layout.gear legs nose bar band): its
		# faces black, along the bar where the band lies
		band = jet.model.parts(verify.pose(jet.joints, {"gear": 1}), materials=("rubber",)).get("launch_bar")
		if band is None:
			raise KeyError("no launch bar band")
		b = F["layout"]["gear"]["legs"]["nose"]["bar"]
		tip, pivot = np.array(b["tip"], float), np.array(b["pivot"], float)
		back = np.linalg.norm(FRAME.source(band.reshape(-1, 3))[:, :2] - tip, axis=1)
		yield result("shape.gear", "launch bar's black band's far end back from the tip", b["band"][0], float(back.min()), 0.3)
		yield result("shape.gear", "launch bar's black band's near end back from the tip", b["band"][1], float(back.max()), 0.3)
		for name, hub in (("gear_right_wheel", "hub"), ("gear_left_wheel", "hub"), ("gear_nose_wheel", "white")):
			f = finishes.get(name, {})
			# rubber, the hub's finish, and the polished axle nut (layout.gear
			# tyres face cap)
			yield result("shape.gear", f"{name}'s faces in neither rubber nor {hub} nor the nut's chrome", 0, sum(c for m, c in f.items() if m not in ("rubber", hub, "chrome")), 0, "faces")
			yield result("shape.gear", f"{name}'s hub faces", 1, int(f.get(hub, 0) > 0), 0, "present")
		for name, below in FLUSH:
			if not name.startswith("gear_"):
				continue
			# its outer face, and its edges' band proud of the skin, in the
			# paint; the rest white (shape.flush)
			painted = {tuple(np.round(t, 6).ravel()) for t in jet.model.parts(verify.pose(jet.joints, {}), materials=("paint",)).get(name, [])}
			f = finishes.get(name, {})
			yield result("shape.gear", f"{name}'s outer face, faces not in the paint", 0, sum(tuple(np.round(t, 6).ravel()) not in painted for t in jet.faces(name)), 0, "faces")
			yield result("shape.gear", f"{name}'s other faces in neither the paint nor white", 0, sum(f.values()) - f.get("paint", 0) - f.get("white", 0), 0, "faces")
		skin = FRAME.source(jet.tris(["fuselage"]).reshape(-1, 3)).reshape(-1, 3, 3)
		# under the LAU-116's ramp, block and fairing and the cheek box the
		# hidden faces' cull took the skin away (layout.stores.lau116 fairing,
		# layout.nacelle.cheek): a main bay's wall meets nothing there, its band
		# hidden behind them
		lau, box = F["layout"]["stores"]["lau116"]["fairing"], F["layout"]["nacelle"]["cheek"]
		stations = (lau["ramp"]["top"][0][0], box["edge"])
		waterlines = (min(w for _, w in box["bottom"]), max(w for _, w in lau["top"]))

		def covered(c):
			return (c[:, 0] >= stations[0]) & (c[:, 0] <= stations[1]) & (c[:, 1] >= waterlines[0]) & (c[:, 1] <= waterlines[1]) & (np.abs(c[:, 2]) >= box["face"]["buttline"] - 6)

		for name, want in (("well_main_left", "white"), ("well_main_right", "white"), ("well_nose", "white"), ("well_speedbrake", "paint"), ("well_probe", "paint")):
			f = finishes.get(name, {})
			# but the band along the skin, from the walls' feet to UNDER inside
			# it, in the paint (build.py wells())
			band = 0
			painted = jet.model.parts(verify.pose(jet.joints, {}), materials=("paint",)).get(name)
			if want != "paint" and painted is not None:
				corners = FRAME.source(painted.reshape(-1, 3))
				near = skin[((skin.max(1) >= corners.min(0) - 1) & (skin.min(1) <= corners.max(0) + 1)).all(1)]
				band = int(((closest(corners, near) <= UNDER + 0.02) | covered(corners)).reshape(-1, 3).all(1).sum())
			yield result("shape.gear", f"{name}'s faces not in {want}, but its band along the skin", 0, sum(f.values()) - f.get(want, 0) - band if f else 1, 0, "faces")

	yield from guard("shape", "gear's finishes", gear_finishes)

	# no face of no area, in any part: its normal is undefined, and smoothing
	# folds it into its neighbours' corners, which shade as if on a crease
	def degenerate():
		least = (0.001 * FRAME.unit) ** 2
		parts = jet.model.parts(verify.pose(jet.joints, {}))
		flat = {name: int((np.linalg.norm(np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0]), axis=1) / 2 < least).sum()) for name, t in parts.items()}
		worst = sorted((n, name) for name, n in flat.items() if n)[::-1][:3]
		yield result("shape.faces", "faces of no area in any part" + (f" (most in {', '.join(f'{name} {n}' for n, name in worst)})" if worst else ""), 0, sum(flat.values()), 0, "faces")

	yield from guard("shape", "faces of no area", degenerate)

	# with the atlas, each leg lit as it stands gear down, not in the dark of
	# the bay it is stowed in: over the faces it shows, outside the bay gear
	# down and not enclosed by the leg itself (a cylinder's end inside the
	# casting it meets, which no light reaches), each face by its area, read
	# at points spread over it. Five views through the photos' cameras read
	# the faces they see at 0.93-0.96 of white; by triangle, the fittings'
	# small faces in the castings' corners outnumber the large ones
	barycentres = np.array([(i, j) for i in range(6) for j in range(6 - i)], float)
	barycentres = (barycentres + 1 / 3) / 6
	barycentres = np.c_[1 - barycentres.sum(1), barycentres]

	def gear_paint():
		image = atlas(jet.path, "white")
		if image is None:
			return
		white = float(np.mean(F["layout"]["paint"]["gear"]["white"])) / 255
		down = {"gear": 1}
		hull = jet.points(HULL, down).reshape(-1, 3, 3)
		for name in ("gear_right_strut", "gear_left_strut", "gear_nose_strut"):
			_, uvs = jet.textured(("white",), [name])
			tris, _ = jet.textured(("white",), [name], down)
			own = jet.points([name], down).reshape(-1, 3, 3)
			normal = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
			area = np.linalg.norm(normal, axis=1) / 2
			normal = normal / (2 * area[:, None] + 1e-12)
			centre = tris.mean(1)
			shown = ~enclosed(centre, hull) & ~(enclosed(centre + 0.05 * normal, own) & enclosed(centre - 0.05 * normal, own))
			lit = 0.0
			if shown.any():
				value = sample(image, np.einsum("pk,tkc->tpc", barycentres, uvs[shown]).reshape(-1, 2)) / white
				weight = np.repeat(area[shown], len(barycentres))
				order = np.argsort(value)
				lit = float(value[order][np.searchsorted(np.cumsum(weight[order]) / weight.sum(), 0.5)])
			yield result("paint.gear", f"{name}'s paint, of white at its median by area over the faces it shows, its shading baked gear down", 1.0, lit, 0.3, "share")

	yield from guard("paint", "gear's paint", gear_paint)

	# a door or the speedbrake, closed, painted as the skin round it: the
	# median of its outer faces' paint against the skin's within 6 in of
	# them and turned the same way, read at points spread over each face,
	# each by its area. Shaded where it stands open, with the open pose's
	# short reach, it reads lighter than the skin it closes into. Within 6%:
	# shaded closed, each reads 1.00-1.04. Not within 1.5 in of any door's
	# outline, where the paint draws its seam (build.py rims(): the seam's
	# texel and the next one's blend, a texel being about 0.7 in): the skin
	# round the forward nose doors, a strip between several doors, is mostly
	# seam, and its median read 10% darker than the skin's own shading
	def closure_paint():
		image = atlas(jet.path, "paint")
		if image is None:
			return
		skin, skin_uvs = jet.textured(("paint",), ["fuselage"])
		seams = np.concatenate([FRAME.source(outline(jet, d)) for d, _ in FLUSH])

		def unit(tris):
			# the faces' outward normals: the stations run against the model's
			# x, so a cross product in this frame points in
			n = -np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
			return n / np.maximum(np.linalg.norm(n, axis=1), 1e-12)[:, None]

		def painted(tris, uvs):
			# the paint at points spread over each face, each by its area
			area = np.linalg.norm(np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0]), axis=1) / 2
			value = sample(image, np.einsum("pk,tkc->tpc", barycentres, uvs).reshape(-1, 2))
			return value, np.repeat(area, len(barycentres)), np.einsum("pk,tkc->tpc", barycentres, tris).reshape(-1, 3)

		def median(tris, uvs):
			value, weight, points = painted(tris, uvs)
			near = seams[((seams >= points.min(0) - 1.5) & (seams <= points.max(0) + 1.5)).all(1)]
			off = np.full(len(points), np.inf)
			for start in range(0, len(points), 4096):
				if len(near):
					off[start : start + 4096] = np.linalg.norm(points[start : start + 4096, None] - near[None], axis=-1).min(1)
			value, weight = value[off > 1.5], weight[off > 1.5]
			order = np.argsort(value)
			return float(value[order][np.searchsorted(np.cumsum(weight[order]) / weight.sum(), 0.5)]) if weight.sum() > 0 else math.nan

		for name, below in FLUSH:
			tris, uvs = jet.textured(("paint",), [name])
			outward = np.array([0.0, -1.0 if below else 1.0, 0.0])
			outer = unit(tris) @ outward > 0.3 if len(tris) else np.zeros(0, bool)
			if not outer.any():
				yield result("paint.closures", f"{name}'s paint closed, of the skin's beside it", 1.0, math.nan, 0.06, "share")
				continue
			low, high = tris[outer].reshape(-1, 3).min(0) - 6, tris[outer].reshape(-1, 3).max(0) + 6
			centre = skin.mean(1)
			beside = (centre >= low).all(1) & (centre <= high).all(1) & (unit(skin) @ outward > 0.3)
			door = median(tris[outer], uvs[outer])
			yield result("paint.closures", f"{name}'s paint closed, of the skin's beside it", 1.0, door / median(skin[beside], skin_uvs[beside]), 0.06, "share")
			# a flush door's edges, closed, stand in a gap of no width against
			# the hole's rim and show only through the crack the two rims
			# leave at a glancing view: shaded at rest, no lighter than the
			# seam drawn along them (layout.panels shade); shaded open,
			# unshaded, they lit there as a dashed light line round the door.
			# An edge stands square to the outer face nearest it: the forward
			# nose doors wrap round the bay's sides, their outer faces turning
			# past 60 deg from the vertical, and read against the vertical
			# alone those passed for edges
			normals, middles = unit(tris), tris.mean(1)
			nearest = np.flatnonzero(outer)[np.argmin(np.linalg.norm(middles[:, None] - middles[outer][None], axis=-1), axis=1)]
			edges = ~outer & (np.abs((normals * normals[nearest]).sum(1)) < 0.5)
			if not PROUD.get(name, 0.0):
				if not edges.any():
					raise ValueError(f"{name} has no edges")
				value, weight, _ = painted(tris[edges], uvs[edges])
				lighter = weight[value > F["layout"]["panels"]["shade"] * door].sum() / weight.sum()
				yield result("paint.closures", f"{name}'s edges' share lighter than its seam", 0.0, float(lighter), 0.05, "share")

	yield from guard("paint", "closures' paint", closure_paint)

	# The mechanisms' strokes (layout.motion): each joint's last key against its
	# fact, what the points file hands the engine, and the poses no key states
	# outright measured off the posed model
	def motion():
		m = {k: v["value"] for k, v in F["layout"]["motion"].items() if isinstance(v, dict)}
		J = jet.joints
		last = lambda name: J[name]["keys"][-1][1]
		yield result("layout.motion", "canopy's opening", m["canopy"]["open"], math.degrees(last("canopy")), 0.05, "deg")
		# the slide along the sill (NATOPS 2.15.1): aft, and rising as it goes
		slide = np.asarray(J["canopy_slide"]["axis"], float) / np.linalg.norm(J["canopy_slide"]["axis"]) * last("canopy_slide") / 0.0254
		yield result("layout.motion", "canopy's slide aft", m["canopy"]["slide"], -slide[0], 0.01)
		yield result("layout.motion", "canopy's rise over its slide", m["canopy"]["rise"], slide[1], 0.01)
		yield result("layout.motion", "canopy's slide's share of the stroke", m["canopy"]["unlatch"], J["canopy"]["keys"][1][0], 0.001, "share")
		# its hinge at its aft top
		for i, unit in ((0, "FS"), (1, "WL")):
			yield result("layout.motion", f"canopy's hinge's {unit}", m["canopy"]["hinge"][i], jet.hinge("canopy")[i], 0.05, f"{unit} in")
		# its shell a seal's step proud of the skin under its rim: each corner
		# of its edge (a side of one face only) off the fuselage
		edge = boundary(jet.points(["canopy"]).reshape(-1, 3, 3))
		if not len(edge):
			raise KeyError("no edge on the canopy")
		skin = jet.points(["fuselage"]).reshape(-1, 3, 3)
		lo, hi = edge.min(0) - 1.0, edge.max(0) + 1.0
		skin = skin[((skin.max(1) >= lo) & (skin.min(1) <= hi)).all(1)]
		off = closest(edge, skin)
		yield result("layout.motion", "canopy's edge off the skin under it, its least", m["canopy"]["seal"], float(off.min()), 0.02)
		yield result("layout.motion", "canopy's edge off the skin under it, its most", m["canopy"]["seal"], float(off.max()), 0.02)
		# the probe out: its nozzle where the photos put it (layout.motion probe
		# nozzle and tip), read off the posed mesh: the probe's axis from its
		# root through its tip, the far ring's middle, and the ball's centre the
		# middle of its ring as far back along that axis as the photos' tip
		# stands ahead of it
		out = jet.points(["probe"], {"probe": 1})
		root = FRAME.source(jet.model.worlds(verify.pose(J, {"probe": 1}))[jet.model.index["probe"]][:3, 3][None])[0]
		ahead = (out[np.argmax(np.linalg.norm(out - root, axis=1))] - root)
		ahead /= np.linalg.norm(ahead)
		along = (out - root) @ ahead
		tip = out[along >= along.max() - 0.05].mean(0)
		head = float(np.linalg.norm(np.array(m["probe"]["tip"]) - np.array(m["probe"]["nozzle"])))
		ring = np.abs(along - (along.max() - head)) < 0.05
		ball = out[ring].mean(0) if ring.any() else np.full(3, np.inf)
		yield result("layout.motion", "probe out: its nozzle's ball centre off the photos'", 0.0, float(np.linalg.norm(ball - np.array(m["probe"]["nozzle"]))), 2.0)
		yield result("layout.motion", "probe out: its nozzle's tip off the photos'", 0.0, float(np.linalg.norm(tip - np.array(m["probe"]["tip"]))), 2.0)
		# its door rides it, with no joint of its own; the forward door ahead of
		# it, on its own, closed at rest and with the probe out (layout.motion
		# probe forward)
		yield result("layout.motion", "probe door on a joint of its own", 0, int("probe_door" in J), 0, "joints")
		shut = jet.points(["probe_door_forward"])
		for end in (0, 1):
			moved = float(np.linalg.norm(jet.points(["probe_door_forward"], {"probe": end}) - shut, axis=1).max())
			yield result("layout.motion", f"probe's forward door off closed with the probe at {end}", 0.0, moved, 0.01)
		# it opens over the stroke's first share, the probe waiting as long
		door = J.get("probe_door_forward", {}).get("keys", [[1, 0]])
		widest = max(abs(k[1]) for k in door)
		yield result("layout.motion", "probe's forward door open by its share of the stroke", m["probe"]["forward"],
			min(k[0] for k in door if abs(k[1]) >= widest - 1e-6) if widest > 0 else 1.0, 0.01, "share")
		yield result("layout.motion", "probe waiting as long", m["probe"]["forward"], max(k[0] for k in J["probe"]["keys"] if abs(k[1]) < 1e-6), 0.01, "share")
		# the gear's mechanisms each on its own drive (the points file's motion
		# gear: each one's share of the stroke's time each way): every door on
		# the doors', the nose leg and the launch bar on the nose's, the rest
		# on the mains'; each door open by its stroke's end, which the
		# retraction's timeline gives the last of its time (layout.motion
		# doors), the legs' parts of it from the sequence, and the extension's
		# timeline the footage's (layout.motion extension)
		told = jet.document["motion"]
		line = told["gear"]
		gear = {n: j for n, j in J.items() if (j.get("drive") or "").startswith("gear.") and j["motion"] in ("rotate", "slide")}
		if len(gear) < 30:
			raise KeyError(f"only {len(gear)} gear joints")
		owned = sum(1 for n, j in gear.items() if j["drive"] != ("gear.doors" if "door" in n else "gear.nose" if n.startswith(("gear_nose", "launch_bar")) else "gear.main"))
		yield result("layout.motion", "gear joints on another mechanism's drive", 0, owned, 0, "joints")
		yield result("layout.motion", "joints on the plain gear drive", 0, sum(1 for j in J.values() if j.get("drive") == "gear"), 0, "joints")
		doors = [n for n in J if n.startswith("gear_door_")]
		if not doors:
			raise KeyError("no gear doors")
		closing = line["up"]["doors"]
		for n in doors:
			opened = min(k[0] for k in J[n]["keys"] if abs(k[1] - J[n]["keys"][-1][1]) < 1e-6)
			yield result("layout.motion", f"{n}'s share of the gear's travel to open", m["doors"]["open"], (1 - closing[0]) * opened if closing[1] == 1.0 else 0.0, 0.001, "share")
		legs = 1 - m["doors"]["open"]
		for leg in ("nose", "main"):
			order = m["sequence"][leg]
			for end, want, got in (("start", legs * (1 - order[1]), line["up"][leg][0]), ("end", legs * (1 - order[0]), line["up"][leg][1])):
				yield result("layout.motion", f"{leg} leg's retraction's {end}, its share of the time in the points file", want, got, 0.001, "share")
		for part in ("doors", "nose", "main"):
			for i, end in enumerate(("start", "end")):
				yield result("layout.motion", f"{part}' extension's {end}, its share of the time in the points file", m["extension"][part][i], line["down"][part][i], 0.001, "share")
		# each mechanism moves only its own parts: the nose leg alone down (the
		# doors open) puts the nose wheel where the gear down does and leaves
		# the main wheels stowed, and the mains alone the other way round
		wheels = {leg: [f"gear_{leg}_wheel"] for leg in ("nose", "left", "right")}
		centre = lambda leg, drives: jet.points(wheels[leg], drives).reshape(-1, 3).mean(0)
		for alone, moved in (("nose", ("nose",)), ("main", ("left", "right"))):
			drives = {"gear.doors": 1.0, f"gear.{alone}": 1.0}
			for leg in ("nose", "left", "right"):
				want = {"gear": 1.0} if leg in moved else {}
				yield result("layout.motion", f"{leg} wheel off where it stands {'down' if leg in moved else 'stowed'}, the {alone} leg{'s' if alone == 'main' else ''} alone down", 0.0,
					float(np.linalg.norm(centre(leg, drives) - centre(leg, want))), 0.01)
		# the gear's sequence and pace: no part but a door moving before the
		# doors are open, either way (retracting, the legs stowed before the
		# doors start to close; extending, the doors open before a leg starts);
		# every gear joint starting and stopping gently, its rate over its first
		# and last keys' span a small share of its fastest (a joint driven at a
		# steady rate jerks to speed and stops dead); and no sampled schedule
		# turning more than a half turn between neighbouring keys (a turn read
		# past a half turn wraps, and the part spins the wrong way round
		# between them)
		share = m["doors"]["open"]
		early = 0.0
		for f in (0.25, 0.5, 0.75, 1.0):
			posed = verify.pose(J, {"gear": share * f})
			early = max([early] + [abs(posed[n][2] - j["keys"][0][1]) for n, j in gear.items() if "door" not in n])
		yield result("layout.motion", "gear's largest move of a part but a door before the doors are open, retracting", 0.0, early, 1e-6, "rad or m")
		yield result("layout.motion", "gear's earliest leg's start before the doors are open, extending", 0.0, max(0.0, line["down"]["doors"][1] - min(line["down"]["nose"][0], line["down"]["main"][0])), 0.0, "share")
		abrupt = []
		for n, j in gear.items():
			xs, ys = [k[0] for k in j["keys"]], [k[1] for k in j["keys"]]
			rates = [abs((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i])) for i in range(len(xs) - 1) if xs[i + 1] > xs[i]]
			moving = [i for i, r in enumerate(rates) if r > 1e-9]
			if moving:
				abrupt.append(max(rates[moving[0]], rates[moving[-1]]) / max(rates))
		yield result("layout.motion", "gear joints' rate at their stroke's ends, of their fastest, the most", 0.0, max(abrupt), 0.15, "share")
		# each main leg strokes as an actuator does (layout.motion stroke):
		# steady between short ramps, so the last fifth of its swing, where its
		# wheel rises straight into the bay, takes no more of the stroke's time
		# than the ramps and the steady speed give it
		ramp = m["stroke"]["ramp"]
		speed = 1 / (1 - ramp)

		def stroked(f):
			# as build.py's: speed rising and falling as smoothsteps over the ramps
			gathered = lambda x: x ** 3 - x ** 4 / 2
			if f <= ramp:
				return speed * ramp * gathered(f / ramp)
			if f >= 1 - ramp:
				return 1 - speed * ramp * gathered((1 - f) / ramp)
			return speed * (ramp / 2 + f - ramp)
		grid = np.linspace(0, 1, 2001)
		fifth = 1 - float(np.interp(0.8, [stroked(f) for f in grid], grid))
		for leg in ("left", "right"):
			keys = J[f"gear_{leg}_strut"]["keys"]
			xs, ys = np.array([k[0] for k in keys]), np.array([k[1] for k in keys])
			moving = np.nonzero(np.abs(np.diff(ys)) > 1e-9)[0]
			a, b = xs[moving[0]], xs[moving[-1] + 1]
			swing = ys[moving[-1] + 1] - ys[moving[0]]
			reach = ys[moving[0]] + 0.8 * swing
			at = float(np.interp(reach, ys[moving[0]:moving[-1] + 2], xs[moving[0]:moving[-1] + 2])) if swing > 0 else a
			yield result("layout.motion", f"{leg} main leg's last fifth of its swing, its share of the stroke's time", fifth, (b - at) / (b - a), 0.02, "share")
		wraps = sum(1 for j in J.values() if j["motion"] == "rotate" and len(j.get("keys", [])) > 2 and isinstance(j["keys"][0][1], (int, float))
			for a, b in zip(j["keys"], j["keys"][1:]) if abs(b[1] - a[1]) > math.pi)
		yield result("layout.motion", "sampled schedules' turns of over a half turn between neighbouring keys", 0, wraps, 0, "keys")
		for leg in ("left", "right"):
			yield result("layout.motion", f"{leg} main axle's turn, stowed", 90.0, math.degrees(last(f"gear_{leg}_axle")), 0.05, "deg")
		for k in ("canopy", "probe", "bar", "fold", "hook", "scoop", "swing"):
			yield result("layout.motion", f"{k}'s stroke time in the points file", m[k]["seconds"], told["seconds"][k], 0.001, "s")
		for k in ("unlatch", "fall", "lock"):
			yield result("layout.motion", f"canopy's closing {k} in the points file", m["canopy"][k], told["canopy"][k], 0.001, "s" if k != "unlatch" else "share")
		yield result("layout.motion", "scoop's travel", m["scoop"]["travel"], math.degrees(last("scoop")), 0.05, "deg")
		# the FCS ram air scoop (layout.scoop): its cap where the photos put it,
		# its can inside the skin stowed; deployed, the can fore and aft with
		# its mouth forward, standing out of the skin. Its ends: each the middle
		# of the points at the end of its own axis, the cap the outboard one at
		# rest, carried by index into the deployed pose
		sc, hull = F["layout"]["scoop"], jet.points(HULL).reshape(-1, 3, 3)
		rest, out = jet.points(["scoop"]).reshape(-1, 3), jet.points(["scoop"], {"scoop": 1}).reshape(-1, 3)
		if not len(rest):
			raise KeyError("no scoop")
		axis = np.linalg.svd(rest - rest.mean(0), full_matrices=False)[2][0]
		along = (rest - rest.mean(0)) @ axis
		ends = [along <= along.min() + 0.05, along >= along.max() - 0.05]
		if rest[ends[0]][:, 2].mean() > rest[ends[1]][:, 2].mean():
			ends.reverse()
		mouth, cap = ends
		centre = rest[cap].mean(0)
		for unit, i in (("FS", 0), ("WL", 1), ("BL", 2)):
			yield result("layout.scoop", "scoop's cap", sc["cap"][i], centre[i], 0.5, f"{unit} in")
		yield result("layout.scoop", "scoop's diameter", sc["diameter"], 2 * np.linalg.norm((rest - rest.mean(0)) - np.outer(along, axis), axis=1).max(), 0.1)
		yield result("layout.scoop", "scoop's length", sc["length"], along.max() - along.min(), 0.1)
		yield result("layout.scoop", "stowed scoop's mouth outside the airframe", 0, (~enclosed(np.unique(rest[mouth], axis=0), hull)).sum(), 0, "corners")
		line = out[mouth].mean(0) - out[cap].mean(0)
		yield result("layout.motion", "deployed scoop's mouth off straight ahead", 0.0, math.degrees(math.acos(min(1.0, -line[0] / np.linalg.norm(line)))), 5.0, "deg")
		yield result("layout.motion", "deployed scoop's points inside the airframe", 0, enclosed(np.unique(out, axis=0), hull).sum(), 0, "corners")
		yield result("layout.motion", "rudders' toe-in in the points file", m["toe"], told["toe"], 0.001, "deg")
		yield result("layout.motion", "hook's sideways travel in the points file", m["swing"]["travel"], told["swing"], 0.001, "deg")

		def stowed(name, post):
			# the post's axis as the facts give it gear down (layout.gear legs),
			# carried by the rigid turn that takes the built part from its
			# gear-down pose to its rest
			down, rest = jet.points([name], {"gear": 1}), jet.points([name])
			u, _, vt = np.linalg.svd((rest - rest.mean(0)).T @ (down - down.mean(0)))
			return (u @ vt) @ (post / np.linalg.norm(post))
		g = F["layout"]["gear"]["legs"]
		post = stowed("gear_nose_strut", np.array([0.0, -1.0, 0.0]))
		yield result("layout.motion", "nose leg's rise above forward, stowed", m["stowed"]["nose"], math.degrees(math.asin(post[1])), 0.1, "deg")
		yield result("layout.motion", "nose leg stowed forward", math.cos(math.radians(m["stowed"]["nose"])), -post[0], 0.002, "share")
		def carried(name):
			# the rigid turn that takes a built part from its gear-down pose to
			# its rest, and the offset: (rotation, down's centre, rest's centre)
			down, rest = jet.points([name], {"gear": 1}), jet.points([name])
			u, _, vt = np.linalg.svd((rest - rest.mean(0)).T @ (down - down.mean(0)))
			return u @ vt, down.mean(0), rest.mean(0)

		main = m["stowed"]["main"]
		for leg, side in (("left", -1), ("right", 1)):
			# the leg turns about the trunnion's axis (the right's the mirror of
			# the left's) by the swing, never about its post
			want = np.array(main["axis"], float) * ([1, 1, 1] if side < 0 else [-1, -1, 1])
			want /= np.linalg.norm(want)
			R, _, _ = carried(f"gear_{leg}_strut")
			angle = math.degrees(math.acos(max(-1.0, min(1.0, (np.trace(R) - 1) / 2))))
			axis = np.array([R[2, 1] - R[1, 2], R[0, 2] - R[2, 0], R[1, 0] - R[0, 1]])
			axis /= np.linalg.norm(axis)
			yield result("layout.motion", f"{leg} main leg's swing about its trunnion, stowed", main["swing"], angle, 0.1, "deg")
			yield result("layout.motion", f"{leg} main leg's trunnion axis off the facts'", 0.0, math.degrees(math.acos(min(1.0, abs(float(axis @ want))))), 0.2, "deg")
			# the shock absorber's stroke: the distance from the lug on the post
			# to the eye on the arm, the leg hanging in flight, standing as the
			# photos show it, and stowed, each end carried by its own part from
			# where the photos put it standing; out in flight by the stroke over
			# standing, and the shrink link drawing it back in to standing
			lug, eye = (np.array(p, float) * [1, 1, side] for p in g["main"]["shock"]["ends"])
			hidden = g["main"]["shock"]["hidden"]   # the upper cylinder's top, up its line from the pin
			def length(drives):
				ends = []
				for name_, p in ((f"gear_{leg}_strut", lug), (f"gear_{leg}_oleo", eye)):
					i = jet.model.index[name_]
					w0, w1 = jet.model.worlds(verify.pose(jet.joints, down))[i], jet.model.worlds(verify.pose(jet.joints, drives))[i]
					ends.append(FRAME.source((w1 @ np.linalg.inv(w0) @ np.append(FRAME.model(p[None])[0], 1.0))[:3][None])[0])
				return float(np.linalg.norm(ends[1] - ends[0])), ends[1]
			standing, flying, stowed_ = length(down), length({"gear": 1}), length({})
			yield result("layout.motion", f"{leg} main shock absorber's stroke, out in flight over standing", main["shrink"], flying[0] - standing[0], 0.1, "in")
			yield result("layout.motion", f"{leg} main shock absorber drawn in, stowed, off its standing length", 0.0, stowed_[0] - standing[0], 0.1, "in")
			# the drawn shock absorber holds together through both drives (the
			# gear's, flying, and the oleo's from hanging to the points file's
			# full): the can's closed end on the arm's eye and both pieces on the
			# line from the lug to it, the body never out of the can's top nor
			# through its end; and at full the body meets the end, so the
			# points file's stroke is the drawn one's
			full = jet.document["points"]["gear"][leg]["full"]
			shock_ = g["main"]["shock"]
			mc_ = g["main"]["castings"]
			radii = [mc_["shock"]["cap"][0] / 2, shock_["diameters"][1] / 2]   # the upper cylinder's, the can's
			ends_off, aim_off, gaps = 0.0, 0.0, []
			poses = [{"gear": k / 20} for k in range(21)] + [{"gear": 1, f"oleo.{leg}": full * k / 10} for k in range(1, 11)]
			for drives in poses:
				distance, eye_ = length(drives)
				parts = jet.model.parts(verify.pose(jet.joints, drives))
				i = jet.model.index[f"gear_{leg}_strut"]
				w0, w1 = jet.model.worlds(verify.pose(jet.joints, down))[i], jet.model.worlds(verify.pose(jet.joints, drives))[i]
				top_ = FRAME.source((w1 @ np.linalg.inv(w0) @ np.append(FRAME.model(lug[None])[0], 1.0))[:3][None])[0]
				along = (eye_ - top_) / distance
				reach_ = {}
				for piece, radius in (("shock", radii[0]), ("shock_can", radii[1])):
					q = FRAME.source(parts[f"gear_{leg}_{piece}"].reshape(-1, 3)) - top_
					t = q @ along
					aim_off = max(aim_off, float(np.linalg.norm(q - np.outer(t, along), axis=1).max()) - radius)
					reach_[piece] = (float(t.min()), float(t.max()))
				ends_off = max(ends_off, abs(reach_["shock_can"][1] - distance))
				# the piston's top inside the upper cylinder (in past its end), and
				# short of half an inch under the cylinder's top
				gaps.append((reach_["shock"][1] - reach_["shock_can"][0], reach_["shock_can"][0] + hidden - 0.5))
			yield result("layout.motion", f"{leg} main shock can's end off the arm's eye through both drives, its most", 0.0, ends_off, 0.1, "in")
			yield result("layout.motion", f"{leg} main shock absorber off its line from the lug to the eye through both drives, its most", 0.0, max(0.0, aim_off), 0.5, "in")
			yield result("layout.motion", f"{leg} main shock piston's top inside the upper cylinder through both drives, its least", 1.0, min(a for a, _ in gaps), 0.1, "in")
			yield result("layout.motion", f"{leg} main shock piston's top past half an inch under the upper cylinder's top through both drives, its most", 0.0, max(0.0, -min(b for _, b in gaps)), 0.05, "in")
			yield result("layout.motion", f"{leg} main shock piston's top off half an inch under the upper cylinder's top, fully in", 0.0, gaps[-1][1], 0.1, "in")
			# the trailing arm's droop in flight, as the approach photos show it:
			# the arm from its pivot to the eye, standing against flying
			pivot_ = np.array(g["main"]["pivot"], float) * [1, 1, side]
			a_, b_ = standing[1] - pivot_, flying[1] - pivot_
			yield result("layout.gear", f"{leg} main trailing arm's droop in flight", g["main"]["droop"], math.degrees(math.acos(float(a_ @ b_) / float(np.linalg.norm(a_) * np.linalg.norm(b_)))), 6.0, "deg")
		# the lowered launch bar's tip, its end ring's lowest point, over the
		# ground under the nose tyres: one tube, whose end ring is the far end
		# along its own axis
		bar = jet.points(["launch_bar"], {**down, "bar": 1})
		axis = np.linalg.svd(bar - bar.mean(0), full_matrices=False)[2][0]
		axis = axis * (1 if axis[0] < 0 else -1)
		along = (bar - bar.mean(0)) @ axis
		tip = bar[along >= along.max() - 0.05]
		nose = jet.points(["gear_nose_wheel"], down)
		yield result("layout.motion", "lowered launch bar's tip's underside over the ground", m["bar"]["deck"], tip[:, 1].min() - nose[:, 1].min(), 0.2)

		def ends(name, drives):
			# a tube's two end rings' middles, each the mean of the points at
			# the end of its own axis
			p = np.unique(jet.points([name], drives), axis=0)
			axis = np.linalg.svd(p - p.mean(0), full_matrices=False)[2][0]
			along = (p - p.mean(0)) @ axis
			return p[along <= along.min() + 0.05].mean(0), p[along >= along.max() - 0.05].mean(0)
		# the nose drag brace holds together through the stroke (layout.gear
		# legs nose actuator): the rod's eye on the web's pin, carried by the
		# post as a rigid body from gear down; the rod's inner end in the
		# cylinder by the overlap (layout.motion braces) and 3 in or more short
		# of the cylinder's pin; the cylinder's pin fixed
		act = F["layout"]["gear"]["legs"]["nose"]["actuator"]
		web = np.array(F["layout"]["gear"]["legs"]["nose"]["brace"][:2] + [0.0])
		index = jet.model.index
		def frames(d):
			w = jet.model.worlds(verify.pose(jet.joints, {"gear": d}))
			return {k: w[index[k]] for k in ("gear_nose_strut", "gear_nose_brace", "gear_nose_brace_rod")}
		down_ = frames(1.0)
		lug = np.linalg.inv(down_["gear_nose_strut"]) @ np.append(FRAME.model(web), 1.0)
		off, moved, overlap, short = 0.0, 0.0, math.inf, math.inf
		for d in np.linspace(0, 1, 81):
			w = frames(d)
			pin_d = FRAME.source((w["gear_nose_strut"] @ lug)[:3][None])[0]
			cylinder_pin, eye = (FRAME.source(w[k][:3, 3][None])[0] for k in ("gear_nose_brace", "gear_nose_brace_rod"))
			off = max(off, float(np.linalg.norm(eye - pin_d)))
			moved = max(moved, float(np.linalg.norm(cylinder_pin - np.array(act["pin"] + [0.0]))))
			u = (eye - cylinder_pin) / np.linalg.norm(eye - cylinder_pin)
			rod = jet.model.parts(verify.pose(jet.joints, {"gear": d}), materials=("chrome",)).get("gear_nose_brace_rod")
			if rod is None:
				raise KeyError("no chrome nose drag brace rod")
			inner = float(((FRAME.source(rod.reshape(-1, 3)) - cylinder_pin) @ u).min())
			overlap = min(overlap, act["cylinder"] - inner)
			short = min(short, inner)
		yield result("layout.motion", "nose drag brace's rod eye off the web's pin, its most", 0.0, off, 0.05)
		yield result("layout.motion", "nose drag brace's cylinder pin moving, its most", 0.0, moved, 0.05)
		yield result("layout.motion", "nose drag brace's rod in its cylinder at full stretch", m["braces"]["overlap"], overlap, 0.25)
		yield result("layout.motion", "nose drag brace's rod's inner end short of 3 in from the cylinder's pin, its most", 0.0, max(0.0, 3.0 - short), 0.0)
		# each main leg's side brace keeps its foot on the bolt, and its
		# connecting link its end on the bell crank's pin, through the stroke:
		# each pin where it lies gear down (the facts' bolt, and the link's
		# line at the crank's waterline, layout.motion braces connecting),
		# carried by the node of each member that shares it, at steps fine
		# enough to see the keys' spans (the side brace breaking from straight
		# turns fastest just after the gear starts up)
		legs_ = F["layout"]["gear"]["legs"]["main"]
		connecting = F["layout"]["motion"]["braces"]["value"]["connecting"]
		for side, sign in (("left", -1), ("right", 1)):
			bolt = np.array(legs_["brace"][1], float) * [1, 1, sign]
			through_, direction_ = (np.array(legs_["link"][k], float) * [1, 1, sign] for k in ("through", "direction"))
			crank_pin = through_ + direction_ * ((connecting["crank"] - through_[1]) / direction_[1])
			members = {"foot": (f"gear_{side}_strut", f"gear_{side}_brace_fittings", bolt), "end": (f"gear_{side}_crank", f"gear_{side}_link", crank_pin)}
			down_w = jet.model.worlds(verify.pose(jet.joints, {"gear": 1.0}))
			homes = {k: [np.linalg.inv(down_w[index[a]]) @ np.append(FRAME.model(q[None])[0], 1.0) for a in (a, b)] for k, (a, b, q) in members.items()}
			off_ = {"foot": 0.0, "end": 0.0}
			for d in np.linspace(0, 1, 81):
				w = jet.model.worlds(verify.pose(jet.joints, {"gear": float(d)}))
				for k, (a, b, _) in members.items():
					pa, pb = (FRAME.source((w[index[n]] @ h)[:3][None])[0] for n, h in zip((a, b), homes[k]))
					off_[k] = max(off_[k], float(np.linalg.norm(pa - pb)))
			foot_off, end_off = off_["foot"], off_["end"]
			yield result("layout.motion", f"{side} main side brace's foot off its bolt through the stroke, its most", 0.0, foot_off, 0.05, "in")
			# its fittings (layout.motion braces side fitting), gear down, about
			# the fork's pin, which the universal joint at the foot holds square
			# to the brace and to the foot's bolt (layout.motion braces side
			# foot): the fork's eye round the pin, its reach up the brace to the
			# tube, and a cheek's thickness
			fit_ = F["layout"]["motion"]["braces"]["value"]["side"]["fitting"]
			# the lower half's axis from its knee, the node's own origin, to
			# the bolt its tube ends on: its mesh's ends would carry the knee's
			# boss, which tilts a fitted axis
			foot, knee = bolt, FRAME.source(down_w[index[f"gear_{side}_brace"]][:3, 3])
			q = jet.points([f"gear_{side}_brace_fittings"], {"gear": 1})
			footbolt = np.array(F["layout"]["motion"]["braces"]["value"]["side"]["foot"]["bolt"], float) * [1, 1, sign]
			footbolt /= np.linalg.norm(footbolt)
			turn = np.cross(footbolt, knee - foot)
			turn /= np.linalg.norm(turn)
			up = (knee - foot) - turn * ((knee - foot) @ turn)
			up /= np.linalg.norm(up)
			rel = q - foot
			x, z = rel @ up, rel @ turn
			plane = np.linalg.norm(rel - np.outer(z, turn), axis=1)
			near = np.linalg.norm(rel, axis=1) < 8.0
			beyond = near & (x < -0.2)
			yield result("layout.motion", f"{side} main side brace's fork's eye round its bolt", fit_["eye"], 2 * float(plane[beyond].max()) if beyond.any() else 0.0, 0.1)
			yield result("layout.motion", f"{side} main side brace's fork up the brace from its bolt", fit_["length"], float(x[near].max()) if near.any() else 0.0, 0.1)
			cheek = near & (plane > fit_["eye"] / 2 - 0.15) & (x < fit_["length"] - 1.0) & (z > 0)
			yield result("layout.motion", f"{side} main side brace's fork's cheek", fit_["cheek"], float(z[cheek].max() - z[cheek].min()) if cheek.any() else 0.0, 0.05)
			# and through the stroke: the pin's hollow end's bore, a disc square to
			# the pin, against the foot's bolt as the post carries it
			worst = 0.0
			worlds_down = jet.model.worlds(verify.pose(jet.joints, {"gear": 1}))[jet.model.index[f"gear_{side}_strut"]][:3, :3]
			for g in (1.0, 0.75, 0.5, 0.25, 0.0):
				bore = jet.model.parts(verify.pose(jet.joints, {"gear": g}), materials=("hub",)).get(f"gear_{side}_brace_fittings")
				if bore is None:
					raise KeyError(f"no bore in the {side} side brace's fork's pin")
				disc = FRAME.source(bore.reshape(-1, 3))
				axis_ = np.linalg.svd(disc - disc.mean(0), full_matrices=False)[2][2]
				turned_ = jet.model.worlds(verify.pose(jet.joints, {"gear": g}))[jet.model.index[f"gear_{side}_strut"]][:3, :3] @ worlds_down.T
				zero = FRAME.model(np.zeros((1, 3)))[0]
				carried = FRAME.source(np.array([zero + turned_ @ (FRAME.model(np.array([footbolt]))[0] - zero)]))[0] - FRAME.source(np.array([zero]))[0]
				carried /= np.linalg.norm(carried)
				worst = max(worst, abs(90.0 - math.degrees(math.acos(min(1.0, abs(float(axis_ @ carried)))))))
			yield result("layout.motion", f"{side} main side brace's fork's pin off square to the foot's bolt through the stroke, its most", 0.0, worst, 1.0, "deg")
			# the foot's clevis under the fork (layout.motion braces side foot):
			# the casting's metal down the bolt through the fork's middle, by how
			# far down it and how far off it, past the bolt's boss between the
			# cheeks (within 1.8 in of the fork's middle): each lug a plate wider
			# than the spool, the spool between them, the nut past the bolt's
			# thread under the lower lug, and the bolt's end beyond the nut
			ft = F["layout"]["motion"]["braces"]["value"]["side"]["foot"]
			down_ = np.array(ft["bolt"], float) * [1, 1, sign]
			down_ /= np.linalg.norm(down_)
			metal_ = np.unique(jet.points([f"gear_{side}_casting"], {"gear": 1}), axis=0) - bolt
			t = metal_ @ down_
			r = np.linalg.norm(metal_ - np.outer(t, down_), axis=1)
			past = np.linalg.norm(metal_, axis=1) > 1.8
			spool_ = ft["spool"] / 2
			(l0, l1), (m0, m1) = ft["lugs"]
			across, n0, n1 = ft["nut"]
			for label, (top_, bottom_), low, high in (("upper", ft["lugs"][0], 0.9, (l1 + m0) / 2), ("lower", ft["lugs"][1], (l1 + m0) / 2, n0 - 0.05)):
				plate = past & (r > spool_ + 0.05) & (r < 12.0) & (t > low) & (t < high)
				yield result("layout.motion", f"{side} main side brace's foot's {label} lug's top down the bolt", top_, float(t[plate].min()) if plate.any() else 0.0, 0.1)
				yield result("layout.motion", f"{side} main side brace's foot's {label} lug's bottom down the bolt", bottom_, float(t[plate].max()) if plate.any() else 0.0, 0.1)
			spool_q = np.unique(jet.points([f"gear_{side}_spool"], {"gear": 1}), axis=0) - bolt
			ts, rs = spool_q @ down_, np.linalg.norm(spool_q - np.outer(spool_q @ down_, down_), axis=1)
			between = (ts > l0 - 0.05) & (ts < m0 + 0.05) & (rs > spool_ - 0.3) & (rs < spool_ + 0.1)
			yield result("layout.motion", f"{side} main side brace's foot's spool across", ft["spool"], 2 * float(rs[between].max()) if between.any() else 0.0, 0.1)
			yield result("layout.motion", f"{side} main side brace's foot's spool down to the lower lug", m0, float(ts.max()), 0.1)
			nut_ = (t > n0 - 0.05) & (t < n1 + 0.05) & (r > spool_ - 0.4 + 0.05) & (r < 3.0)
			yield result("layout.motion", f"{side} main side brace's foot's nut across its flats", across, 2 * float(r[nut_].max()) * math.cos(math.pi / 12) if nut_.any() else 0.0, 0.1)
			yield result("layout.motion", f"{side} main side brace's foot's nut's top down the bolt", n0, float(t[nut_].min()) if nut_.any() else 0.0, 0.1)
			yield result("layout.motion", f"{side} main side brace's foot's nut's bottom down the bolt", n1, float(t[nut_].max()) if nut_.any() else 0.0, 0.1)
			tail = (t > n1 + 0.05) & (r < 3.0)
			yield result("layout.motion", f"{side} main side brace's foot's end down the bolt", ft["end"][1], float(t[tail].max()) if tail.any() else 0.0, 0.1)
			yield result("layout.motion", f"{side} main side brace's foot's end across", ft["end"][0], 2 * float(r[tail].max()) if tail.any() else 0.0, 0.1)
			# the bolt and the bell crank's boss each on the post's own metal,
			# gear down: the nearest vertex of the post or its casting to each,
			# within the radius of the arm's pivot boss (2 in) and a half inch
			# the crank's boss is its end away from the link
			c, e = ends(f"gear_{side}_crank", {"gear": 1})
			g_, h = ends(f"gear_{side}_link", {"gear": 1})
			boss = c if min(np.linalg.norm(c - g_), np.linalg.norm(c - h)) > min(np.linalg.norm(e - g_), np.linalg.norm(e - h)) else e
			metal = jet.points([f"gear_{side}_strut", f"gear_{side}_casting"], {"gear": 1})
			# and the metal unbroken from each back to the post: the post's
			# axis through its sections, the pivot boss's along BL through the
			# arm's pivot; cuts square to the way back, at steps along it, each
			# crossing metal within 2 in of the way
			rings = [jet.cut([f"gear_{side}_strut"], [0, w, 0], [0, 1, 0], {"gear": 1}) for w in (64.0, 72.0)]
			a, u = rings[0].mean(0), rings[1].mean(0) - rings[0].mean(0)
			u = u / np.linalg.norm(u)
			pivot = np.array(legs_["pivot"], float) * [1, 1, sign]
			for label, q, home in (("side brace's bolt", bolt, a + u * ((bolt - a) @ u)),
					("bell crank's boss", boss, np.array([pivot[0], pivot[1], boss[2]]))):
				gap = float(np.min(np.linalg.norm(metal - q, axis=1)))
				yield result("layout.motion", f"{side} main {label} off the post's metal, gear down", 0.0, gap, 2.5, "in")
				way = (q - home) / np.linalg.norm(q - home)
				broken = 0
				for f in np.linspace(0.15, 0.85, 8):
					at_ = home + (q - home) * f
					cross = jet.cut([f"gear_{side}_strut", f"gear_{side}_casting"], at_, way, {"gear": 1})
					broken += not len(cross) or float(np.min(np.linalg.norm(cross - at_, axis=1))) > 2.0
				yield result("layout.motion", f"{side} main {label}'s way back to the post, its steps crossing no metal", 0.0, broken, 0, "steps")
			yield result("layout.motion", f"{side} main connecting link's end off the bell crank's pin through the stroke, its most", 0.0, end_off, 0.05, "in")

	yield from guard("layout.motion", "mechanisms' strokes", motion)

	# The speedbrake open (layout.speedbrake open): where the photos put it
	def speedbrake_open():
		sb = F["layout"]["speedbrake"]
		brake = jet.points(["speedbrake"])
		# its aft corners where the photos put them (layout.speedbrake open):
		# each the outer face's corner at rest, carried by the panel
		i = jet.model.index["speedbrake"]
		carry = jet.model.worlds(verify.pose(jet.joints, {"speedbrake": 1}))[i] @ np.linalg.inv(jet.model.rest[i])
		for side, sign in (("left", -1), ("right", 1)):
			mine = brake[np.sign(brake[:, 2]) == sign]
			corner = mine[np.argmax(mine[:, 0] + sign * mine[:, 2] + 0.01 * mine[:, 1])]
			out = FRAME.source((carry @ np.append(FRAME.model(corner[None])[0], 1.0))[:3][None])[0]
			yield result("layout.speedbrake", f"speedbrake open: its {side} aft corner off the photos'", 0.0, float(np.linalg.norm(out - np.array(sb["open"]["aft"]) * [1, 1, sign])), 1.0)
		# its actuator open standing where the photos put the narrow member under
		# it: its axis's station at the photos' two waterlines, and its width
		i = jet.model.index["speedbrake_actuator"]
		w = jet.model.worlds(verify.pose(jet.joints, {"speedbrake": 1}))[i]
		foot = FRAME.source(w[:3, 3][None])[0]
		tube = jet.points(["speedbrake_actuator"], {"speedbrake": 1})
		ahead = np.linalg.svd(tube - tube.mean(0), full_matrices=False)[2][0]
		ahead = ahead * np.sign(ahead[1])
		for station, waterline in sb["open"]["strut"]:
			yield result("layout.speedbrake", f"speedbrake open: its actuator's axis at WL {waterline:g}", station, foot[0] + (waterline - foot[1]) * ahead[0] / ahead[1], 1.5, "FS in")
		across = np.linalg.norm((tube - foot) - np.outer((tube - foot) @ ahead, ahead), axis=1)
		yield result("layout.speedbrake", "speedbrake's actuator across", sb["mechanism"]["actuator"]["diameters"][0], 2 * float(np.median(across[across > 1.5])), 0.1)

	yield from guard("layout.speedbrake", "speedbrake open", speedbrake_open)

	# The speedbrake's actuator holds together through the stroke (layout.speedbrake
	# mechanism): its eye on the lug's pin under the panel, the pin where the
	# facts put it at rest (its station, the depth under the panel's inner face,
	# a tenth under the closed skin), carried by the lug's node and by the
	# actuator's last stage at steps finer than their keys; and each stage
	# still in the one below it by the overlap at full stretch
	def speedbrake():
		act = F["layout"]["speedbrake"]["mechanism"]["actuator"]
		index = jet.model.index
		station, depth = act["lug"]
		skin = first_hit(jet.points(["fuselage"]).reshape(-1, 3, 3), np.array([station, 300.0, 0.0]), np.array([0.0, -1.0, 0.0]))
		if skin is None:
			raise KeyError("no skin over the speedbrake's lug")
		pin = FRAME.model(np.array([[station, 300.0 - skin - 0.1 - depth, 0.0]]))[0]
		# the stages in the order each rides the one before
		stages, parent = [], index["speedbrake_actuator"]
		while True:
			child = [c for c in jet.model.nodes[parent]["children"] if jet.model.nodes[c]["name"].startswith("speedbrake_actuator_")]
			if not child:
				break
			parent = child[0]
			stages.append(jet.model.nodes[parent]["name"])
		if len(stages) != act["stages"]:
			raise KeyError(f"{len(stages)} speedbrake actuator stages")
		off = pinned(jet, pin, ["speedbrake_lug", stages[-1]], lambda d: {"speedbrake": d})
		yield result("layout.motion", "speedbrake actuator's eye off its lug's pin through the stroke, its most", 0.0, off, 0.05)
		w = jet.model.worlds(verify.pose(jet.joints, {"speedbrake": 1}))
		foot = FRAME.source(w[index["speedbrake_actuator"]][:3, 3][None])[0]
		ends = {}
		for n in ["speedbrake_actuator"] + stages:
			tube = jet.model.parts(verify.pose(jet.joints, {"speedbrake": 1}))[n]
			ends[n] = FRAME.source(tube.reshape(-1, 3))
		ahead = np.linalg.svd(ends["speedbrake_actuator"] - ends["speedbrake_actuator"].mean(0), full_matrices=False)[2][0]
		ahead = ahead * np.sign(ahead[1])
		for outer, inner in zip(["speedbrake_actuator"] + stages, stages):
			overlap = float(((ends[outer] - foot) @ ahead).max() - ((ends[inner] - foot) @ ahead).min())
			yield result("layout.motion", f"{inner} in {outer} at full stretch, short of the overlap", 0.0, max(0.0, act["overlap"] - overlap), 0.0)

	yield from guard("layout.motion", "speedbrake's actuator", speedbrake)

	# Wells (layout.wells): under each closed door the skin is open, and the
	# well behind the opening, closed by its doors and the skin round it,
	# holds its parts at rest, stands inside the airframe, and holds no other
	# part
	def wells():
		opened = jet.opened()
		hull = jet.points(HULL).reshape(-1, 3, 3)
		rest = jet.parts()
		for well, (doors, members) in WELLS.items():
			box = jet.tris([f"well_{well}"])
			plug = jet.plugs(doors)
			if not len(plug):
				raise KeyError(f"no closed face on {doors}")
			# no skin left where the doors close: points on the skin the doors
			# were cut from, more than 0.15 in in from any door's outline (where
			# the cut's slivers lie), with the skin as built on them
			edge = FRAME.source(np.concatenate([outline(jet, d) for d in doors]))
			middle = FRAME.source(plug.mean(1))
			middle = middle[np.array([np.linalg.norm(edge - m, axis=1).min() for m in middle]) > 0.15]
			lo, hi = plug.reshape(-1, 3).min(0) - 0.02, plug.reshape(-1, 3).max(0) + 0.02
			near = FRAME.source(opened[((opened.max(1) >= lo) & (opened.min(1) <= hi)).all(1)].reshape(-1, 3)).reshape(-1, 3, 3)
			left = int((closest(middle, near) < 0.01).sum()) if len(near) and len(middle) else 0
			yield result("layout.wells", f"{well}'s closed face with skin on it, points more than 0.15 in from its outline", 0, left, 0, "points")
			# no door closing on another (two cut from one band of skin)
			yield result("layout.wells", f"{well}'s doors closing on one another, points more than 0.15 in from their outlines", 0, stacked(jet, doors), 0, "points")
			# its faces turned into the well: those square to the opening facing
			# out through it, as its doors' outer faces do (the bake shades a face
			# from the side it faces: turned away, the well bakes black)
			out = sum(np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0]).sum(0) for t in (jet.faces(d) for d in doors))
			out = out / np.linalg.norm(out)
			n = np.cross(box[:, 1] - box[:, 0], box[:, 2] - box[:, 0])
			area = np.linalg.norm(n, axis=1)
			facing = (n / np.maximum(area, 1e-12)[:, None]) @ out
			square = np.abs(facing) > 0.5
			turned = float(area[square & (facing < 0)].sum() / area[square].sum()) if square.any() else 1.0
			yield result("layout.wells", f"well_{well}'s faces square to its opening turned away from it, of their area", 0, round(turned, 3), 0, "share")
			# the space the well, its closed doors and the skin round its opening
			# close: every skin face reaching into the well's bounds (one whose
			# middle lies just outside them, where a wall's foot meets the skin,
			# would leave a gap under the wall)
			lo, hi = box.reshape(-1, 3).min(0) - 0.3 * FRAME.unit, box.reshape(-1, 3).max(0) + 0.3 * FRAME.unit
			# and the parts standing on that skin within 3 in of the well, where
			# the hidden faces under them are gone (HULL's: the cheek box and
			# the LAU-116's fairing over the main bays)
			reach = 3.0 * FRAME.unit
			cover = jet.tris([n for n in HULL[HULL.index("fairings_left"):] if n in jet.parts()])
			cover = cover[((cover.max(1) >= lo - reach) & (cover.min(1) <= hi + reach)).all(1)]
			cavity = FRAME.source(np.concatenate([box, plug, opened[((opened.max(1) >= lo) & (opened.min(1) <= hi)).all(1)], cover]).reshape(-1, 3)).reshape(-1, 3, 3)
			for m in members:
				corners = np.unique(jet.points([m]), axis=0)
				yield result("layout.wells", f"{m}'s corners outside the {well} well at rest", 0, int((~enclosed(corners, cavity)).sum()), 0, "corners")
			# four points over each face, its middle and halfway from it to each
			# corner, a few hundredths off it so that none lies on the plane of
			# an opening's edge; one an axis ray finds outside is judged again by
			# its crossings along oblique rays, since an axis ray can run down a
			# seam where an opening's rim meets its closed face, and passed if it
			# lies on the skin, where a well's rim stands
			t = FRAME.source(box.reshape(-1, 3)).reshape(-1, 3, 3)
			middle = t.mean(1)
			spots = np.concatenate([middle[:, None, :], (middle[:, None, :] + t) / 2], 1) + np.array([0.013, 0.007, 0.011])
			flat = spots.reshape(-1, 3)
			out = np.zeros(len(flat), bool)
			out[~enclosed(flat, hull)] = True
			out[out] = [not crossed(p, hull) for p in flat[out]]
			if out.any():
				skin = FRAME.source(jet.tris(["fuselage"]).reshape(-1, 3)).reshape(-1, 3, 3)
				out[out] = closest(flat[out], skin) > 0.02
			yield result("layout.wells", f"well_{well}'s faces reaching outside the airframe", 0, int(out.reshape(-1, 4).any(1).sum()), 0, "faces")
			# its white UNDER inside the skin, the band from its feet on the
			# skin to there in the paint: white laid on the skin, a foot's
			# straight run between stations passed in and out of the skin's
			# facets, and showed through in dashes
			white = jet.model.parts(verify.pose(jet.joints, {}), materials=("white",)).get(f"well_{well}")
			if white is not None:
				corners = np.unique(FRAME.source(white.reshape(-1, 3)), axis=0)
				skin = FRAME.source(jet.tris(["fuselage"]).reshape(-1, 3)).reshape(-1, 3, 3)
				skin = skin[((skin.max(1) >= corners.min(0) - 1) & (skin.min(1) <= corners.max(0) + 1)).all(1)]
				yield result("layout.wells", f"well_{well}'s white corners' nearest to the skin", UNDER, float(closest(corners, skin).min()), 0.03, "in")
			# its feet UNDER/2 inside the skin, as a door's edge band is split:
			# feet on the skin, their runs between stations level with it or
			# standing out of the tunnel's hollow between the nacelles, drew
			# through it in dots. Read as how far its nearest corner falls
			# short of that: in the hollow a foot laid along one face's normal
			# comes nearer the next face (0.04 in), and the probe's well stands
			# deeper (0.08)
			corners = np.unique(jet.points([f"well_{well}"]), axis=0)
			skin = FRAME.source(jet.tris(["fuselage"]).reshape(-1, 3)).reshape(-1, 3, 3)
			skin = skin[((skin.max(1) >= corners.min(0) - 1) & (skin.min(1) <= corners.max(0) + 1)).all(1)]
			yield result("layout.wells", f"well_{well}'s nearest corner to the skin, short of half the inner depth", 0.0, max(0.0, UNDER / 2 - float(closest(corners, skin).min())), 0.015, "in")
			# no other part inside it: each part near it at rest, but its own,
			# the skin's and the launch bar (a fault of its own)
			own = set(members) | set(doors) | set(HULL) | {f"well_{well}", "launch_bar"}
			blo, bhi = FRAME.source(lo), FRAME.source(hi)
			blo, bhi = np.minimum(blo, bhi), np.maximum(blo, bhi)
			inside = []
			for name, tris in rest.items():
				if name in own or name.startswith("well_"):
					continue
				p = np.unique(FRAME.source(tris.reshape(-1, 3)), axis=0)
				p = p[((p >= blo) & (p <= bhi)).all(1)]
				if len(p) and enclosed(p, cavity).any():
					inside.append(name)
			yield result("layout.wells", f"other parts inside the {well} well at rest{': ' + ', '.join(sorted(inside)) if inside else ''}", 0, len(inside), 0, "parts")

	yield from guard("layout.wells", "wells", wells)

	for drive, steps in SWEPT.items():
		yield from guard("layout.motion", f"clearance through the {drive}'s stroke", lambda drive=drive, steps=steps: clearance(jet, drive, steps))

	# The paint, on a painted build (a draft carries no atlas: main() says so)
	image = atlas(jet.path)
	if image is None:
		return

	def paint():
		tris, uvs = jet.textured()
		size = image.shape[0]
		# no texel lies under two painted faces: islands laid over each other
		# let the bake write one over the other (the LEX's root over the warning
		# box's corner, while its island took in faces turned away from it; 225
		# texels where smart_project folded faces over others)
		count = coverage(uvs, size)
		yield result("paint.overlap", "atlas texels two painted faces both lie on", 0, int((count >= 2).sum()), 0, "texels")
		normals = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
		area = np.linalg.norm(normals, axis=1)
		normals = normals / np.maximum(area, 1e-12)[:, None]
		facing = outward(tris)
		e1, e2 = uvs[:, 1] - uvs[:, 0], uvs[:, 2] - uvs[:, 0]
		texel = np.sqrt(area / 2 / np.maximum(np.abs(e1[:, 0] * e2[:, 1] - e1[:, 1] * e2[:, 0]) / 2 * size * size, 1e-12))
		centres = tris.mean(1)

		def read(points, normal, near):
			# the atlas's brightness where each point, moved out along the normal
			# and cast back, meets the near triangles; NaN for a miss
			k, bary = hits(tris[near], points + 2.0 * normal, -normal)
			out = np.full(len(points), np.nan)
			hit = k >= 0
			if hit.any():
				i = np.where(near)[0][k[hit]]
				u, v = bary[hit].T
				uv = uvs[i, 0] * (1 - u - v)[:, None] + uvs[i, 1] * u[:, None] + uvs[i, 2] * v[:, None]
				out[hit] = sample(image, uv)
			return out

		# each stencil drawn on skin dense enough for its lettering (each
		# stencil's own island), and whole: its ink just inside its edges dark
		# against the paint beside it (a plane leaning off the skin left the
		# warning box's top and bottom undrawn)
		for key, spec in F["layout"]["stencils"].items():
			if not isinstance(spec, dict):
				continue
			(fs, wl), (length, height) = spec["at"], spec["size"]
			for side in (1, -1):
				name = "right" if side > 0 else "left"
				box = (np.abs(centres[:, 0] - fs) < length / 2) & (np.abs(centres[:, 1] - wl) < height / 2) & (centres[:, 2] * side > 0)
				if not box.any():
					raise KeyError(f"no painted skin under the {key} stencil, {name}")
				outer = box & (centres[:, 2] * side > (centres[box, 2] * side).max() - 2.0)
				yield result("layout.stencils", f"{key} stencil's skin, {name}: its coarsest texel", 0.0, float(texel[outer].max()), 0.15)
				k, bary = hits(tris, np.array([[fs, wl, side * 80.0]]), np.array([0.0, 0.0, -side]))
				if k[0] < 0:
					raise KeyError(f"no skin at the {key} stencil's middle, {name}")
				centre = tris[k[0], 0] + (tris[k[0], 1] - tris[k[0], 0]) * bary[0, 0] + (tris[k[0], 2] - tris[k[0], 0]) * bary[0, 1]
				normal = normals[k[0]] * np.sign(normals[k[0], 2] * side)
				up = np.array([0.0, 1.0, 0.0]) - normal * normal[1]
				up /= np.linalg.norm(up)
				across = np.cross(up, normal)
				corners = [(-0.5, 0.5), (0.5, 0.5), (0.5, -0.5), (-0.5, -0.5)] if spec["kind"] == "box" else [(-0.5, 0.5), (0.0, -0.5), (0.5, 0.5)]
				inset = 0.2
				edges = list(zip(corners, corners[1:] + corners[:1])) if spec["kind"] == "box" else list(zip(corners, corners[1:]))
				inner, outside = [], []
				middle = np.mean(corners, 0)
				for a, b in edges:
					a, b = np.array(a) * (length, height), np.array(b) * (length, height)
					inward = (middle * (length, height) - (a + b) / 2)
					inward /= np.linalg.norm(inward)
					for f in np.linspace(0.05, 0.95, 24):
						q = a + (b - a) * f
						inner.append(q + inward * inset)
						outside.append(q - inward * 1.0)
				near = (np.abs(centres - centre) < max(length, height)).all(1)
				place = lambda qs: centre + np.array(qs)[:, :1] * across + np.array(qs)[:, 1:] * up
				ink, paint_ = read(place(inner), normal, near), read(place(outside), normal, near)
				ok = np.isfinite(ink)
				if not ok.any() or not np.isfinite(paint_).any():
					raise ValueError(f"the {key} stencil's edges are off the painted skin, {name}")
				dark = float(np.mean(ink[ok] < 0.75 * np.nanmedian(paint_)))
				yield result("layout.stencils", f"{key} stencil's edges inked, {name}: their share", 1.0, dark, 0.05, "share")

		# the panel lines read along their whole length: each half inch of a line
		# darker than the skin an inch either side (a line narrower than two
		# texels, each texel wholly on it or off it by its centre, broke into dots)
		p = F["layout"]["panels"]
		every_line = [np.array(l, float) for l in p["lines"] + p["mirrored"]] + [np.array(l, float) * [1, 1, -1] for l in p["mirrored"]]
		for station in p.get("rings", []):
			segments = verify.cut(tris, [station, 100, 0], [1, 0, 0])
			if not len(segments):
				raise KeyError(f"no painted skin at the ring at FS {station}")
			every_line += [s for s in segments]
		gaps, total = 0, 0
		for line in every_line:
			points = np.concatenate([np.linspace(q, r, max(2, int(np.ceil(np.linalg.norm(r - q) / 0.5)) + 1))[:-1] for q, r in zip(line, line[1:])] + [line[-1:]])
			if len(points) < 3:
				continue
			low, high = points.min(0) - 3, points.max(0) + 3
			near = ((tris.min(1) <= high) & (tris.max(1) >= low)).all(1)
			if not near.any():
				raise KeyError("no painted skin near a panel line")
			for i in range(1, len(points) - 1):
				q = points[i]
				j = np.where(near)[0][np.argmin(np.linalg.norm(centres[near] - q, axis=1))]
				n = normals[j]
				along = points[i + 1] - points[i - 1]
				beside = np.cross(n, along)
				if np.linalg.norm(beside) < 1e-9:
					continue
				beside /= np.linalg.norm(beside)
				# read from outside, where the line is seen (read from inside,
				# the fin root's fillet line along the fairing's foot was read
				# on the skin under the fairing, which only the bake's buried
				# texels darkened)
				line_, left, right = read(np.array([q, q + 1.0 * beside, q - 1.0 * beside]), facing[j], near)
				reference = np.nanmax([left, right]) if np.isfinite([left, right]).any() else np.nan
				if np.isfinite(line_) and np.isfinite(reference):
					total += 1
					gaps += line_ > 0.95 * reference
		if not total:
			raise ValueError("no panel line read off the paint")
		yield result("layout.panels", "panel lines' share of their length no darker than the skin beside them", 0.0, gaps / total, 0.05, "share")

		# each closed door's outline painted as a seam, the panel lines' way
		# (build.py panels(), rims()): a door lies flush in its opening, so
		# the paint alone draws its edge; read a quarter inch at a time,
		# square to the door's outer face there (the triangle nearest an
		# outline point is most often the edge's wall, a sliver standing on
		# it: read along its normal, the reads ran sideways into the slivers,
		# whose texels lie elsewhere on the jet). The seam is the darker of
		# the paint a tenth of an inch either side of the outline, against the
		# door and the skin an inch either side: on the outline itself a read
		# lands on the islands' edge, the wall's white sliver or the bake's
		# margin, and a seam is one dark line whichever side of the edge its
		# texels lie
		for name, _ in FLUSH:
			line, ups = outline(jet, name, normals=True)
			line = FRAME.source(line)
			low, high = line.min(0) - 3, line.max(0) + 3
			near = ((tris.min(1) <= high) & (tris.max(1) >= low)).all(1)
			if not near.any():
				raise KeyError(f"no painted skin near {name}")
			gaps, total = 0, 0
			for q, up in zip(line, ups):
				# its run here: the outline's points within half an inch of it
				close = line[np.linalg.norm(line - q, axis=1) < 0.5]
				if len(close) < 3:
					continue
				along = np.linalg.svd(close - close.mean(0))[2][0]
				beside = np.cross(up, along)
				if np.linalg.norm(beside) < 1e-9:
					continue
				beside /= np.linalg.norm(beside)
				inner, outer, left, right = read(np.array([q + 0.1 * beside, q - 0.1 * beside, q + 1.0 * beside, q - 1.0 * beside]), up, near)
				seam = np.nanmin([inner, outer]) if np.isfinite([inner, outer]).any() else np.nan
				reference = np.nanmax([left, right]) if np.isfinite([left, right]).any() else np.nan
				if np.isfinite(seam) and np.isfinite(reference):
					total += 1
					gaps += seam > 0.95 * reference
			if not total:
				raise ValueError(f"{name}'s outline read nowhere off the paint")
			yield result("layout.panels", f"{name}'s outline's share no darker than the door and skin beside it", 0.0, gaps / total, 0.05, "share")

		# the LEX's root slot dark along its length against the LEX's top 4 in
		# outboard of it (layout.lex slot)
		slot = F["layout"]["lex"]["slot"]
		for side, name in ((1, "right"), (-1, "left")):
			ends = np.array([slot["front"], slot["aft"]], float) * [1, 1, side]
			low, high = ends.min(0) - 6, ends.max(0) + 6
			near = ((tris.min(1) <= high) & (tris.max(1) >= low)).all(1)
			if not near.any():
				raise KeyError(f"no painted skin near the {name} LEX's slot")
			ratios = []
			for t in np.linspace(0.1, 0.9, 9):
				q = ends[0] + (ends[1] - ends[0]) * t
				inside, outside = read(np.array([q, q + [0, 0, 4.0 * side]]), np.array([0.0, 1.0, 0.0]), near)
				if np.isfinite(inside) and np.isfinite(outside):
					ratios.append(inside / outside)
			if not ratios:
				raise ValueError(f"the {name} LEX's slot is off the painted skin")
			yield result("layout.lex", f"{name} LEX's slot's paint against the LEX beside it, the lightest", slot["shade"], max(ratios), 0.2, "share")

	yield from guard("paint", "paint", paint)

	# The inlet ducts' walls in view keep the airframe's greys, shaded by the
	# occlusion alone, never darker than its floor, 0.4 of the upper grey
	# (build.py paint(); the engine face's own colour aside): rays from
	# dvids8025511's eye and from 80 in ahead of the left mouth, across it,
	# meeting the left duct's walls first, the darkest twentieth of them
	def ducts():
		place = F["layout"]["inlet"]
		lip = place["lip"]
		measured = np.array([lip[k] for k in ("top", "bottom", "outer", "corner_top", "corner_bottom")], float)
		plane = np.linalg.lstsq(np.c_[np.ones(len(measured)), measured[:, 1], measured[:, 2]], measured[:, 0], rcond=None)[0]
		face = lip["top"][0] + place["duct"]["face"] * value(F["engine"]["inlet"])
		upper = float(np.array(F["layout"]["paint"]["upper"]) @ [0.299, 0.587, 0.114]) / 255
		centre = np.array([(lip["top"][0] + lip["bottom"][0]) / 2, (lip["top"][1] + lip["bottom"][1]) / 2, -(lip["outer"][2] + lip["corner_bottom"][2]) / 2])
		eyes = [np.array(place["duct"]["sight"]["eye"], float), centre - np.array([80.0, 0.0, 0.0])]
		aims = [centre + np.array([0.0, w, b]) for w in np.linspace(-12, 12, 13) for b in np.linspace(-11, 11, 12)]
		depth = lambda p: p[..., 0] - (plane[0] + plane[1] * p[..., 1] + plane[2] * np.abs(p[..., 2]))
		values, points = shades(jet, image, "inlet_left", eyes, aims, lambda p: depth(p) >= 3 and p[0] <= face - place["duct"]["hub"][1] - 1)
		if len(values) < 20:
			raise ValueError(f"only {len(values)} rays meet the left duct's walls")
		dark = float(np.percentile(values / upper, 5))
		reach = depth(points)
		yield result("layout.inlet", f"left duct's walls in view, {len(values)} rays {reach.min():.0f}-{reach.max():.0f} in past the lip, their darkest twentieth below the occlusion's floor (0.4 of the upper grey), of the grey", 0.0, max(0.0, 0.4 - dark), 0.05, "share")
		# and light near the lip, darkening with depth: their median within 10
		# in of the lip at least 0.08 of the grey over theirs past 40 in (all at
		# the floor, as when the inlet's faces turned away from the duct and
		# the bake shaded them from outside, they do not darken)
		near, far = values[reach <= 10] / upper, values[reach >= 40] / upper
		if not len(near) or not len(far):
			raise ValueError("no rays meet the left duct's walls near the lip or past 40 in")
		yield result("layout.inlet", f"left duct's walls in view darkening with depth: their median within 10 in of the lip ({len(near)} rays) short of 0.08 of the upper grey over theirs past 40 in ({len(far)})", 0.0, max(0.0, 0.08 - float(np.median(near) - np.median(far))), 0.0, "share")

	yield from guard("paint", "inlet ducts' paint", ducts)


def main():
	only = [g for k, a in enumerate(sys.argv) if a == "--only" and k + 1 < len(sys.argv) for g in sys.argv[k + 1].split(",") if g]
	if "--only" in sys.argv and not only:
		sys.exit("--only names no group")
	jet = Jet(sys.argv[1], sys.argv[2])
	seen = set()
	results = list(checks(jet, only, seen))
	unknown = [o for o in only if o not in seen]
	if unknown:
		sys.exit(f"--only {', '.join(unknown)}: no group of that name; the groups are {', '.join(sorted(seen))}")
	covered = {r["fact"] for r in results}
	# a draft's paint is unbaked: what only the paint shows goes unchecked, and says so
	if atlas(sys.argv[1]) is None:
		covered |= PAINTED
	# a run of some groups answers for no fact outside them
	unaccounted = [] if only else [e for e in entries(FACTS) if e not in covered and e not in EXEMPT]
	stale = [] if only else [e for e in EXEMPT if e not in entries(FACTS)]
	failures = [r for r in results if failed(r)]
	if "--json" in sys.argv:
		print(json.dumps({"results": results, "unaccounted": unaccounted, "stale": stale, "exempt": EXEMPT, "only": only}, indent="\t"))
	else:
		for r in results:
			if "missing" in r:
				print(f"MISSING  {r['fact']:28s} {r['what']}: {r['missing']}")
				continue
			miss = r["measured"] - r["expected"]
			flag = "FAIL" if abs(miss) > r["tolerance"] else "ok"
			print(f"{flag:8s} {r['fact']:28s} {r['what']:58s} {r['expected']:9.2f} {r['measured']:9.2f} {miss:+8.2f} (±{r['tolerance']}) {r['unit']}")
		for e in unaccounted:
			print(f"UNCHECKED {e}: facts.json entry with no check and no exemption")
		for e in stale:
			print(f"STALE    {e}: exempted but no longer in facts.json")
		if atlas(sys.argv[1]) is None and chosen("paint", only):
			print("PAINT    unchecked: the model carries no atlas (a draft)")
		if only:
			print(f"{len(results)} measurements in {', '.join(only)} only, {len(failures)} outside tolerance")
		else:
			print(f"{len(results)} measurements, {len(failures)} outside tolerance; {len(EXEMPT)} entries exempt; {len(unaccounted)} unaccounted")
	sys.exit(1 if failures or unaccounted or stale else 0)


if __name__ == "__main__":
	main()
