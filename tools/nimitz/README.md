# Nimitz carrier model pipeline

Builds the playable air carrier (`web/src/assets/nimitz.glb`) directly from
the pristine Sketchfab download (`../../downloads/uss_nimitz_cvn-68_aircraft_carrier.glb`,
gitignored) — no Blender round-trip. Each script reads that original and writes derived
artifacts into this directory (all gitignored; regenerate on demand).

**`PLAN.md`** — the design for rebuilding the deck from the 1:200 CVN-68 general-arrangement
drawing (correct proportions, bow shape, and equipment placement). Read it before attempting
that rebuild; it holds the locked decisions, coordinate registration, verification checklist,
and iteration knobs, so multiple attempts don't lose the design.

## Scripts

- **`build_carrier.py`** — the main build. Edge-line purge → auto-traced deck rim
  (`flush_walk`, writes the outline to the ship file) → boundary-owned deck-band clear (keep boxes,
  ELEV_CLEAR, material-blind life-raft zone kill, deck-tone/steel repaint, walkway
  clear, interior purge) → sheer-following textured deck polygon + steel underside
  plate → 2 m skirt (the generated fascia) → generated catapult control cabs + railings →
  generated catwalks and life-raft racks → GC repack. Reads
  `decktex12.png` and the ship file. Writes `nimitz-clean.glb`, and the ship file's outline
  when the trace changes it.
  The header docstring carries the accumulated lessons (sources of truth, why the catwalk
  and rafts are generated whole, why every generated mesh's winding is flipped,
  verification protocol) —
  read it before changing any rule.
- **`bake_decktex.py`** — bakes the deck texture (`decktex12.png`, 8192×2400) from the
  original's up-facing paint + catapult tracks + rubber + the cabs' deck plates, all
  anti-aliased. Reads the outline, catapults, deflector boxes, landing line and cabs from the
  ship file.
- **`ship.py`** — loads `web/src/assets/nimitz.json`, the deck layout `engine.ts` flies and
  draws: the catapults with their blast deflector boxes, the landing line and wires, the OLS,
  the elevator openings, the cabs, the deck texture's extent and the outline. Every script
  here reads it too, so the jet, the paint and the cabs cannot drift apart; its notes say
  where each number came from. `test_ship.py` is its unit test (`python3 -m unittest test_ship`).
- **`cabs.py`** — how big the two catapult control cabs (ICCS "bubbles") are, from the 1:200
  plan, navysite.de and Navy photographs; where they stand is the ship file's. The bake paints
  their deck plates, the build makes the cabs, and `edgecheck.py` checks the two agree.
- **`plan_check.py`** — checks the ship file's layout (outline, cats, wires) against the
  1:200 GA drawing `nimitz-plan.jpg` by registering the outline onto the scan and
  ridge-fitting the equipment lines (Stage C of PLAN.md; found + fixed the cat-1/cat-4
  misplacements 2026-07-10). Run after changing the ship file's equipment; `fit` arg
  refits the registration frame. The scan itself is NOT in the repository
  (third-party drawing, rights unverified — gitignored): it lives only in the
  local working tree, so keep a copy before wiping this checkout.
- **`cdp_shot.py`** — headless capture via Chrome DevTools Protocol (the old
  `--virtual-time-budget` one-shot broke in Chrome 141). `cdp_shot.py "<query>" out.png [wait-s]`.
- **`raycheck.py`** — sky-through-ship regression rays: exact triangle ray-casts of the
  known see-through path classes against `nimitz-clean.glb`. A ray passes only if the
  first surface it meets faces it: every ship material is single-sided, so a face met
  from behind is culled. Non-zero exit on a see-through ray. Run after any edit touching
  the hull, skirt, deck strip, underside, or band-clear rules. A new sighting: add the
  in-game camera as a ray first and watch it fail.
- **`edgecheck.py`** — the generated catwalks and life rafts: exactly the ship file's count of canisters, each
  on its cradle beside the catwalk and along the deck edge; nothing generated crossing the
  ship or lying in a catwalk's plane over an authored plate (z-fighting); every slab on
  the skirt or the ship's side, every post on a slab, every brace slab-to-side; every face
  outward. Each check is what the authored-raft attempts (v57-v74) got wrong. It also checks
  the two catapult control cabs: where the ship file puts them, at their size, on the deck, on a
  painted plate in the deck texture, facing out, with the original bow cab gone; and that each of
  the ship file's elevator spans is the platform the deck texture paints, with the catwalk breaking
  there. Run after any
  change to the catwalk plan, the walkway clear, the generator or the cabs; `-v` lists where each
  failure is.
- **`skyprobe.py`** — bulk corridor finder: voxelizes the built GLB at 0.5 m and scans
  straight lines per height/angle for free stretches flanked by hull on both sides.
  Discovery tool only; over-reports open air under the bow/stern overhangs and the hull
  flare. Verify each candidate with an exact ray in `raycheck.py`.
- **`audit.py`** — retention audit: matches every baseline triangle (original after
  squash + edge purge, via the build's own front half) against the built GLB and
  classifies every missing one as an intended kill or UNEXPLAINED. The unexplained
  bucket should stay tiny (v80: 176 tris, 0.045%). Run whenever "has the surgery
  eaten something?" comes up — the build is a fresh single pass from the original
  every run, so damage can only come from a current rule, and this finds it.
- **`purge_fa18c.py`** — rig-safe sealed-interior purge for the F/A-18C model.

## Regen chain (order matters — bake reads the ship file's outline, build writes it then reads the texture)

```
python3 bake_decktex.py                # texture from the ship file
python3 build_carrier.py               # reads decktex12.png; writes the outline to the ship file if the trace moved
python3 bake_decktex.py                # only when the build said the outline changed: re-bake on it
python3 build_carrier.py               # ... and rebuild with that texture
../gltfpack-native -i nimitz-clean.glb -o ../../web/src/assets/nimitz.glb -cc -kn -noq -tc -tu
# a changed outline, catapult or wire moves the physics too: re-export the world
# server's map with claude/scripts/air/geometry.py and rebuild the world
# then run `make` in apps/air — Vite content-hashes the GLB into the bundle,
# so the new bytes get a new URL automatically (no version constant to bump).
# Native gltfpack (meshoptimizer release binary, not committed; the npm build
# has no BasisU) meshopt-compresses the shipped copy and encodes the deck as
# KTX2/UASTC (-tc -tu, #200: ~70 MB of GPU memory as a PNG); ~21 MB -> ~12, most
# of it the deck texture. The engine's GLTFLoader has the meshopt decoder
# registered. -noq is REQUIRED: with
# quantization on, gltfpack moves UV dequantization into KHR_texture_transform,
# which the engine's manual texture rebinding bypasses (the deck paints
# vanished into a blur), and the quantized positions shifted the measured
# deck height 0.35 m (y 22.52 -> 22.87). nimitz-clean.glb stays UNCOMPRESSED —
# raycheck.py/audit.py/plan_check.py all read it, and gltfpack prunes unused
# materials, so tooling always works on the clean build.
```

`bake_decktex.py` caps its own memory at 8 GB (`RLIMIT_AS`) and rasterises marks in
256-row stripes. Uncapped, a stalled dash-walk loop once grew to 18.6 GB and the
kernel OOM killer reaped unrelated desktop processes (2026-07-13). A `MemoryError`
from the bake means a rule change introduced an unbounded allocation - fix the
allocation, do not raise the cap.

The server serves `web/dist`. After the cp, run `make`, then confirm dist got the new
bytes: `md5sum web/dist/assets/nimitz-*.glb web/src/assets/nimitz.glb` (a stale hash
means the build ran before the cp landed).

## Verification (do these, in this order, after any model change)

1. **Counters** — compare `band clear: deleted N, repainted M` against the previous run.
   Rule edits move them; an intended revert must reproduce them exactly (byte-identical
   GLB is the strongest form — v66 and v80 both hit it).
2. **`raycheck.py`** — must exit 0 after any hull/skirt/deck/band-clear edit, and
   **`edgecheck.py`** after any catwalk, raft or cab edit.
3. **In-game captures** (`cdp_shot.py`, `start=carrier&cat=4&view=chase`) at the standard
   angles: close (`az=-0.85&el=0.25&dist=32`), straight down (`az=-1.2&el=1.45&dist=55`),
   beam (`az=-1.6&el=0.06&dist=60`), and from below (`el<0`, incl. grazing `el=-0.12`
   close in). The HUD stamps `nimitz <hash>` (the bundled GLB's content hash) — confirm
   it matches the freshly built `dist/assets/nimitz-<hash>.glb` before trusting a capture.
4. **Judge recesses in game, never in Cycles.** Cycles sun+sky renders any overhung
   cavity as pure black and misleads (it nearly misdiagnosed the authored-fascia
   prototype); the engine's ambient-rich lighting is the target look. Blender renders
   are still useful for *geometry* checks — remember the glTF import converts Y-up to
   Z-up (camera coords `(gx, -gz, gy)`).
5. **Bake edits**: verify texture changes numerically (sample pixel rows at known
   fa/lat), and after any mark-rule change run the lost-bright-pixel diff against the
   previous texture clustered by fa — per-spot probes miss systemic damage.

## Standing decisions (why the model is the way it is)

- **Catwalks and life rafts are generated, never reused** (2026-10-25). The authored
  racks belong to the authored catwalk, which the rebuild deletes; every scheme that kept
  them (v57-v74) produced floating, buried, sliced, bent or askew rafts, so they were
  removed at v75/v76. Now the build plans catwalk runs along the long edges aft of the
  bows (the bows keep their authored walkways, which follow the flare), clears the
  authored walkway there, and generates a solid catwalk 1.5 m below the rim - starting on
  whichever is further out, skirt or measured ship's side, leaving out any metre that
  would cross the ship - with a railing, braces, and 226 canisters (25-person rafts: all the
  catwalks between the elevators and sponsons hold) stacked two high in rigid straight racks of five on straight stretches.
  The photographs (2013-2017) show both sides carrying rows and the bows bare.
  `edgecheck.py` holds every rule.
- **Sources of truth**: 1:200 GA plan = 2D layout (markings, fixtures; outranks the
  model's own paint). Model = 3D structure (outline shape, sheer, hull, island). The
  fascia is generated — the skirt IS the ship's side below the deck edge.
- **Sky from below was culling, not missing geometry** (resolved 2026-10-25). `add_soup`
  maps (fa, lat, h) to (x, y, z) by swapping two axes, a mirror that reversed every
  generated triangle's winding: the underside plate faced up and was culled from below,
  and the railings rendered inside out. The earlier fixes (v77-v79) were judged by a
  `raycheck.py` that counted culled faces as blocking, so they measured sealed while sky
  still showed. `add_soup` now restores the winding and `raycheck.py` counts only drawn
  faces.
