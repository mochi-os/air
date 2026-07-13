# Nimitz carrier model pipeline

Builds the playable furball carrier (`web/public/vessels/nimitz/model.glb`) directly from
the pristine Sketchfab download (`../../downloads/uss_nimitz_cvn-68_aircraft_carrier.glb`,
gitignored) — no Blender round-trip. Each script reads that original and writes derived
artifacts into this directory (all gitignored; regenerate on demand).

**`PLAN.md`** — the design for rebuilding the deck from the 1:200 CVN-68 general-arrangement
drawing (correct proportions, bow shape, and equipment placement). Read it before attempting
that rebuild; it holds the locked decisions, coordinate registration, verification checklist,
and iteration knobs, so multiple attempts don't lose the design.

## Scripts

- **`build_carrier.py`** — the main build. Edge-line purge → auto-traced deck rim
  (`flush_walk`, writes `outline.json`) → boundary-owned deck-band clear (keep boxes,
  ELEV_CLEAR, material-blind life-raft zone kill, deck-tone/steel repaint, interior
  purge) → sheer-following textured deck polygon + steel underside plate → 2 m skirt
  (the generated fascia) → ICCS cab transplant + generated railings → GC repack. Reads
  `decktex12.png` + `cab38.npy`/`cab1.npy`. Writes `nimitz-clean.glb` + `outline.json`.
  The header docstring carries the accumulated lessons (sources of truth, why the life
  rafts are gone, the accepted-unresolved sky-from-below class, verification protocol) —
  read it before changing any rule.
- **`bake_decktex.py`** — bakes the deck texture (`decktex12.png`, 8192×2400) from the
  original's up-facing paint + catapult tracks + rubber, all anti-aliased. Reads
  `outline.json` when present.
- **`extract_cab.py`** — extracts the ICCS cab geometry (`cab38.npy` walls + `cab1.npy`
  glass) from the original, dropped 0.64 m flush. Run once; `build_carrier` loads the `.npy`.
- **`splice_outline.py`** — splices `outline.json` into `engine.ts` `SHIP.outline` (the
  physics polygon must match the drawn deck strip).
- **`plan_check.py`** — checks the engine layout (outline, cats, wires) against the
  1:200 GA drawing `nimitz-plan.jpg` by registering the outline onto the scan and
  ridge-fitting the equipment lines (Stage C of PLAN.md; found + fixed the cat-1/cat-4
  misplacements 2026-07-10). Run after changing SHIP equipment constants; `fit` arg
  refits the registration frame.
- **`cdp_shot.py`** — headless capture via Chrome DevTools Protocol (the old
  `--virtual-time-budget` one-shot broke in Chrome 141). `cdp_shot.py "<query>" out.png [wait-s]`.
- **`raycheck.py`** — sky-through-ship regression rays: exact triangle ray-casts of the
  known see-through path classes against `nimitz-clean.glb`; non-zero exit on a clear
  ray. Run after any edit touching the hull, skirt, deck strip, underside, or band-clear
  rules. Necessary but NOT sufficient — see its header for the v76-v80 history and the
  reproduce-the-camera-first rule.
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

## Regen chain (order matters — bake reads outline.json, build writes it then reads the texture)

```
python3 extract_cab.py                 # once (writes cab38.npy, cab1.npy)
python3 bake_decktex.py                # bootstrap texture (uses previous/placeholder outline)
python3 build_carrier.py               # writes outline.json, reads decktex12.png
python3 bake_decktex.py                # re-bake with the real traced outline
python3 build_carrier.py               # final model
cp nimitz-clean.glb ../../web/public/vessels/nimitz/model.glb
python3 splice_outline.py              # outline.json -> engine.ts SHIP.outline
# then bump NIMITZ_MODEL_VERSION in engine.ts and run `make` in apps/furball
```

The vite build copies `web/public/` → `web/dist/`; the server serves `dist`. After the cp,
`touch web/src/game/engine.ts && make`, then `md5sum` dist vs public model.glb to confirm
dist got the new bytes (the copy can race the build).

## Verification (do these, in this order, after any model change)

1. **Counters** — compare `band clear: deleted N, repainted M` against the previous run.
   Rule edits move them; an intended revert must reproduce them exactly (byte-identical
   GLB is the strongest form — v66 and v80 both hit it).
2. **`raycheck.py`** — must exit 0 after any hull/skirt/deck/band-clear edit.
3. **In-game captures** (`cdp_shot.py`, `start=carrier&cat=4&view=chase`) at the standard
   angles: close (`az=-0.85&el=0.25&dist=32`), straight down (`az=-1.2&el=1.45&dist=55`),
   beam (`az=-1.6&el=0.06&dist=60`), and from below (`el<0`, incl. grazing `el=-0.12`
   close in). The HUD stamps `nimitz vNN` — confirm the version before trusting a capture.
4. **Judge recesses in game, never in Cycles.** Cycles sun+sky renders any overhung
   cavity as pure black and misleads (it nearly misdiagnosed the authored-fascia
   prototype); the engine's ambient-rich lighting is the target look. Blender renders
   are still useful for *geometry* checks — remember the glTF import converts Y-up to
   Z-up (camera coords `(gx, -gz, gy)`).
5. **Bake edits**: verify texture changes numerically (sample pixel rows at known
   fa/lat), and after any mark-rule change run the lost-bright-pixel diff against the
   previous texture clustered by fa — per-spot probes miss systemic damage.

## Standing decisions (why the model is the way it is)

- **Life rafts removed** (v75/v76 after fourteen failed placement schemes, v57-v74):
  the authored racks belong to the authored catwalk, which the rebuild deletes; every
  exemption/transplant/relocation scheme produced floating, buried, sliced, bent, or
  askew rafts, and preserving the authored catwalk brought back the shredded edge the
  band clear exists to remove. The zone kill is material-blind (brackets included).
  Do not re-add without a fresh design discussion.
- **Sources of truth**: 1:200 GA plan = 2D layout (markings, fixtures; outranks the
  model's own paint). Model = 3D structure (outline shape, sheer, hull, island). The
  fascia is generated — the skirt IS the ship's side below the deck edge.
- **Sky-from-below is accepted-unresolved** (v80, user decision, v77-v79 reverted).
  Four successive fixes sealed every measurable path; the user still saw sky from
  viewpoints the measurements never reproduced. If reopened: capture the user's exact
  camera, add it as a failing ray to `raycheck.py` first, and do not patch sightlines
  one screenshot at a time.
