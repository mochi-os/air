# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# Tests the atlases the F/A-18C's build keeps between runs (build.py --cache,
# ../cache.py). KeyTest builds drafts that only write the keys the jet's and
# the stores' bakes would be kept under (--keys), and holds each key to what
# it comes from: the paint's colours count in neither, a stencil and the nose
# in the jet's alone, the tanks in the stores' alone, a part of the airframe
# within the stores' reach in both, and so do the code that bakes each and
# the constants it bakes by. CacheTest builds the jet painted, four times: a
# build whose inputs are unchanged takes both atlases' UVs and bakes from the
# cache and makes the same model, byte for byte; a change to the paint alone
# bakes nothing again, one to the tanks the stores alone. Also that the model
# rests as built: the wing's flex morph weighted 0. About 20 minutes.
#
# usage: systemd-run --user --scope --slice=probe.slice -p MemoryMax=6G -p MemorySwapMax=0 python3 -I test_build.py
import json, os, re, struct, subprocess, tempfile, unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
FACTS = json.loads((HERE / "facts.json").read_text())


def gltf(glb):
	# The JSON chunk of a glTF binary
	length = struct.unpack("<I", glb[12:16])[0]
	return json.loads(glb[20 : 20 + length])


def changed(change):
	# A copy of the facts, changed in place by `change`
	facts = json.loads(json.dumps(FACTS))
	change(facts["layout"])
	return facts


class KeyTest(unittest.TestCase):
	# Each case a draft build writing its keys (build.py --keys): a changed
	# facts file, or a copy of build.py beside it with its code changed
	CASES = {
		"base": (None, None),
		"colour": (lambda l: l["paint"].update(upper=[90, 93, 104]), None),
		"stencil": (lambda l: l["stencils"]["warning"].update(at=[310.4, 134.0]), None),
		"tanks": (lambda l: l["stores"]["tank"]["profile"][7].__setitem__(1, 14.6), None),
		"pitot": (lambda l: l["pitot"].update(tube=0.9), None),
		"near": (lambda l: l["antennas"]["ventral"][2].__setitem__(1, 75.3), None),   # the blade under the nose, within the centreline tank's reach
		"bakes": (None, ("	bpy.ops.object.bake(type=\"AO\", use_clear=True)\n", "	bpy.ops.object.bake(type=\"AO\", use_clear=True)   # changed\n")),
		"atlas": (None, ("ATLAS = 2048\n", "ATLAS = 4096\n")),
		"store_bakes": (None, ("	occlusion = np.ones((size, size), np.float32)\n", "	occlusion = np.ones((size, size), np.float32)   # changed\n")),
		"reach": (None, ("STORE_REACH = 12.0\n", "STORE_REACH = 12.5\n")),
		"store_atlas": (lambda l: l["stores"]["paint"].update(atlas=512), None),
		"strip": (None, ("STRIP = 0.03   #", "STRIP = 0.04   #")),
		"density": (None, ("STENCIL_DENSITY = 4.0   #", "STENCIL_DENSITY = 3.0   #")),
		"margin": (None, ("STENCIL_MARGIN = 1.5    #", "STENCIL_MARGIN = 2.0    #")),
		"nozzles": (None, ("			NOZZLE_PARTS.append(petal)\n", "			NOZZLE_PARTS.append(petal) if k else None\n")),
	}

	@classmethod
	def setUpClass(cls):
		cls.folder = tempfile.TemporaryDirectory()
		with ThreadPoolExecutor(3) as pool:
			cls.keys = dict(zip(cls.CASES, pool.map(cls.keyed, cls.CASES)))

	@classmethod
	def tearDownClass(cls):
		cls.folder.cleanup()

	@classmethod
	def keyed(cls, name):
		change, edit = cls.CASES[name]
		where = Path(cls.folder.name) / name
		where.mkdir()
		script = HERE / "build.py"
		if edit:
			# beside the original, so it finds the facts, the references and the shared modules as it does
			old, new = edit
			source = script.read_text()
			if source.count(old) != 1:
				raise RuntimeError(f"{name}: the line to change is not in build.py once")
			script = HERE / f".keys-{os.getpid()}-{name}.py"
			script.write_text(source.replace(old, new))
		options = ["--facts", str(where / "facts.json")] if change else []
		if change:
			(where / "facts.json").write_text(json.dumps(changed(change)))
		try:
			run = subprocess.run(["blender", "-b", "--factory-startup", "--python-use-system-env", "--python-exit-code", "1", "-P", str(script), "--",
				str(where / "fa18c.glb"), str(where / "fa18c.json"), "--draft", "--keys", str(where / "keys.json"), *options], capture_output=True, text=True)
		finally:
			if edit:
				script.unlink()
		if run.returncode or "Traceback" in run.stdout + run.stderr:
			raise RuntimeError(run.stdout[-3000:] + run.stderr[-3000:])
		return json.loads((where / "keys.json").read_text())

	def moved(self, name):
		# which keys the case changes from the base's
		return {group: self.keys[name][group] != self.keys["base"][group] for group in ("paint", "stores")}

	def test_the_paints_colours_bake_nowhere(self):
		self.assertEqual(self.moved("colour"), {"paint": False, "stores": False})

	def test_a_stencil_bakes_the_jet_alone(self):
		self.assertEqual(self.moved("stencil"), {"paint": True, "stores": False})

	def test_the_tanks_bake_the_stores_alone(self):
		self.assertEqual(self.moved("tanks"), {"paint": False, "stores": True})

	def test_the_nose_out_of_the_stores_reach_bakes_the_jet_alone(self):
		self.assertEqual(self.moved("pitot"), {"paint": True, "stores": False})

	def test_the_airframe_within_the_stores_reach_bakes_both(self):
		self.assertEqual(self.moved("near"), {"paint": True, "stores": True})

	def test_the_code_that_bakes_the_jet_counts_in_its_key_alone(self):
		self.assertEqual(self.moved("bakes"), {"paint": True, "stores": False})

	def test_the_atlas_size_counts_in_the_jets_key_alone(self):
		self.assertEqual(self.moved("atlas"), {"paint": True, "stores": False})

	def test_the_code_that_bakes_the_stores_counts_in_their_key_alone(self):
		self.assertEqual(self.moved("store_bakes"), {"paint": False, "stores": True})

	def test_the_stores_reach_counts_in_their_key_alone(self):
		self.assertEqual(self.moved("reach"), {"paint": False, "stores": True})

	def test_the_stores_atlas_size_counts_in_their_key_alone(self):
		self.assertEqual(self.moved("store_atlas"), {"paint": False, "stores": True})

	def test_the_atlas_strip_counts_in_the_jets_key_alone(self):
		self.assertEqual(self.moved("strip"), {"paint": True, "stores": False})

	def test_the_stencils_density_counts_in_the_jets_key_alone(self):
		self.assertEqual(self.moved("density"), {"paint": True, "stores": False})

	def test_the_stencils_margin_counts_in_the_jets_key_alone(self):
		self.assertEqual(self.moved("margin"), {"paint": True, "stores": False})

	def test_the_nozzles_flaps_count_in_the_jets_key_alone(self):
		self.assertEqual(self.moved("nozzles"), {"paint": True, "stores": False})


class CacheTest(unittest.TestCase):
	@classmethod
	def setUpClass(cls):
		cls.folder = tempfile.TemporaryDirectory()
		cls.cache = Path(cls.folder.name) / "cache"

	@classmethod
	def tearDownClass(cls):
		cls.folder.cleanup()

	def build(self, name, facts=None):
		where = Path(self.folder.name) / name
		where.mkdir()
		options = ["--cache", str(self.cache)]
		if facts is not None:
			(where / "facts.json").write_text(json.dumps(facts))
			options += ["--facts", str(where / "facts.json")]
		run = subprocess.run(["blender", "-b", "--factory-startup", "--python-use-system-env", "--python-exit-code", "1", "-P", str(HERE / "build.py"), "--",
			str(where / "fa18c.glb"), str(where / "fa18c.json"), *options], capture_output=True, text=True)
		if run.returncode or "Traceback" in run.stdout + run.stderr:
			raise RuntimeError(run.stdout[-3000:] + run.stderr[-3000:])
		said = dict(re.findall(r"^bakes (\w+): (baked|from the cache)", run.stdout, re.M))
		return (where / "fa18c.glb").read_bytes(), {group: way == "baked" for group, way in said.items()}

	def test_cached_atlases(self):
		first, baked = self.build("first")
		self.assertEqual(baked, {"paint": True, "stores": True})
		# the wing rests unbent: its flex morph weighted 0 (Blender 5 weights a new shape key 1)
		flexed = {m["name"]: m["weights"] for m in gltf(first)["meshes"] if "weights" in m}
		self.assertIn("wing_outer_left", flexed)
		self.assertEqual({name: w for name, w in flexed.items() if any(w)}, {})
		# again: both from the cache, the same model
		again, baked = self.build("again")
		self.assertEqual(baked, {"paint": False, "stores": False})
		self.assertEqual(again, first)
		# the upper grey lighter: the paint alone
		painted = json.loads(json.dumps(FACTS))
		painted["layout"]["paint"]["upper"] = [90, 93, 104]
		model, baked = self.build("painted", painted)
		self.assertEqual(baked, {"paint": False, "stores": False})
		self.assertNotEqual(model, first)
		# the wing tanks a tenth of an inch fatter: the stores alone
		tanks = json.loads(json.dumps(FACTS))
		tanks["layout"]["stores"]["tank"]["profile"][7][1] += 0.1
		model, baked = self.build("tanks", tanks)
		self.assertEqual(baked, {"paint": False, "stores": True})
		self.assertNotEqual(model, first)


if __name__ == "__main__":
	unittest.main()
