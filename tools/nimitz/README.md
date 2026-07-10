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
  ELEV_CLEAR, deck-tone/steel repaint, interior purge) → flat textured deck polygon →
  ICCS cab transplant + generated railings → GC repack. Reads `decktex12.png` +
  `cab38.npy`/`cab1.npy`. Writes `nimitz-clean.glb` + `outline.json`.
- **`bake_decktex.py`** — bakes the deck texture (`decktex12.png`, 8192×2400) from the
  original's up-facing paint + catapult tracks + rubber, all anti-aliased. Reads
  `outline.json` when present.
- **`extract_cab.py`** — extracts the ICCS cab geometry (`cab38.npy` walls + `cab1.npy`
  glass) from the original, dropped 0.64 m flush. Run once; `build_carrier` loads the `.npy`.
- **`splice_outline.py`** — splices `outline.json` into `engine.ts` `SHIP.outline` (the
  physics polygon must match the drawn deck strip).
- **`cdp_shot.py`** — headless capture via Chrome DevTools Protocol (the old
  `--virtual-time-budget` one-shot broke in Chrome 141). `cdp_shot.py "<query>" out.png [wait-s]`.
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
