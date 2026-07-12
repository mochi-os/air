# Plan-based Nimitz deck rebuild

Rebuild the furball carrier using the 1:200 CVN-68 general-arrangement drawing
(`nimitz-plan.jpg`, in this directory — the durable copy of the original `~/tmp/nimitz.jpg`)
as the authoritative source for the **horizontal** layout, correcting
three defects the model-traced pipeline can't fix from the model alone:

1. **Bow gap** — the traced outline stops short of the real bow point (deck doesn't reach the hull).
2. **Concave deck** — the interior is drawn flat at `DECKY` while the edge rims sit ~0.65 m higher, so each cross-section is a shallow bowl.
3. **Too beamy** — the source model is ~9% too wide; you cannot fix proportions by tracing the model, only against an external reference.

This is a re-sourcing of the existing pipeline (outline + equipment come from the plan instead of the model), plus a one-time global model scale. The current pipeline stays working as a fallback until this is verified.

## What each source of truth provides

- **Plan (top-down, normalized)** — 2D fore-aft x lateral truth: deck-edge outline (bow point, round-downs, beam), and equipment X/Y (catapult tracks + angles, arrestor wires, landing centreline/foul lines, four elevators, island footprint, JBDs).
- **Published real-ship specs** — the precise angles/spacings the low-res plan can't resolve: angled deck 9.05°, catapult spacing/stroke, wire spacing. Snap plan-derived positions to these where they're tighter than the plan.
- **Profile (side elevation)** — the vertical: deck height and sheer. The profile shows the deck as near-flat with slight bow sheer, which is what fixes the concavity.
- **Original model GLB** — the 3D structures the plan can't give: hull, island, sponsons, radomes, catwalks, round-down curvature.

The plan has NO Z; the profile/height model owns concavity, not the plan.

## Scope: the flight core takes its geometry from JS (no wasm rebuild)

`flight_world()` (engine.ts ~2400) builds the core's `deck` polygon, `catapults`, and `wires`
from the `SHIP` constants and passes them to `flight_init()`. So the physics deck/cats/wires
are handed in from JS, not hardcoded in Go. The whole rebuild — outline, proportions,
equipment — is a `SHIP`-constants + GLB change; the core picks up the new geometry
automatically. `flight.wasm` only needs rebuilding if we change physics *logic* (we don't).
The core deck is a 2D polygon at its own y=0; deck height is a VISUAL alignment between the
built deck and `CARRIER.deckY` (raycast from the drawn deck), not a core change.

## Locked decisions

- **Normalize the plan to real dimensions**: length 332.8 m, max flight-deck beam 76.8 m. This neutralizes any scan distortion (measured ~+-10% on this low-res scan) — trace the *shape* from the plan, scale it to the known real size.
- **Global lateral squash of the imported model** so its hull/island register with the plan-derived deck. Squashing the island is approved.
- ~~Preserve round objects~~ **REVERSED (v48-v50, tried twice, torn both times)**: any blend between shape-preserved (translated) and squashed geometry has a transition zone, and the dome clusters are dense enough that the falloff always runs through a neighbouring shell or pedestal (v48: small dome shells exceed their tight boxes; v49: an unpreserved pedestal inside a preserved neighbour's falloff). **Uniform squash everywhere**: 4% on even a 6-8 m sphere is 24-32 cm of ellipticity — invisible in game — and uniform scaling cannot displace anything relative to anything. `DOME_PRESERVE=[]` remains as a knob.
- **Deck height**: flat (or gentle bow sheer from the profile), one surface height for interior AND edges per cross-section, so no bowl. The physics contact plane follows (`CARRIER.deckY` is raycast from the drawn deck). NOTE the height change ripples: spawn Y, OLS datum, wire heights, and floods all reference `CARRIER.deckY` — re-verify a launch and a landing (glideslope/ball) after.
- **The plan is the SINGLE horizontal source of truth for ALL equipment** — outline, catapults, wires, landing line, elevators, OLS — snapped to published specs for exact angles/spacings, with the in-game align tool (key 0 / Shift+1-4) as the final touch-up. This REVERSES the earlier "keep the hand-calibrated cats" idea: the shuttles were total-least-squares fitted to the MODEL's painted tracks, i.e. precisely fitted to a low-confidence reference, so they inherit the model's errors. Deriving everything from one source (the plan) also guarantees the drawn deck, the baked track markings, and the shuttle/physics positions all agree. (Wires + line were already plan-measured; cats + OLS were the model-derived ones that now move to the plan.)
- **Hybrid architecture**: plan -> 2D layout (outline + all equipment); scaled model -> 3D structures only (hull, island, sponsons, radomes); profile -> heights. All current fixes (texture AA, deck-tone repaint, railings, ICCS transplant, floods) still apply on top.

## Coordinate registration

Deck-ops frame: `fa = (worldX - CX)*S`, `lat = (worldZ - CZ)*S`, `S = 0.025` (1 unit = 2.5 cm), `CX=6361.3`, `CZ=-469.3`. `fa`/`lat` are metres. The engine and build already work in this frame.

Plan image -> deck-ops metres (in `extract_plan.py`, reading `nimitz-plan.jpg`):
1. Identify in the plan (px): bow tip, stern round-down (length axis), the ship centreline (lat origin), and the max-beam lateral extent.
2. Fit an affine map px -> metres so bow-to-stern = 332.8 m and centreline -> lat 0, then set the lateral scale so max beam = 76.8 m (this IS the normalization; the two axes are scaled independently to the known real dims, which corrects any scan aspect error).
3. Align fore-aft origin so the plan's deck maps onto the existing `fa` range (register the bow point / a known feature such as cat-1 shuttle to the current values as a sanity check).
4. Emit `plan.json`: `{ outline:[[fa,lat],...], catapults:[{fa,lat,heading}], wires:[fa...], line, elevators:[[fa0,fa1,lat0,lat1]], island, jbds:[...] }`.

Model lateral squash factor: `S_lat = 76.8 / (measured model max beam in m)`. Expected ~0.91. Verify by overlaying the squashed model's traced edge on `plan.json` outline; if some stations don't land on the plan edge, the over-width isn't uniform -> switch to a per-region (piecewise fore-aft) scale.

**Angled-deck angle = the squash acid test.** A lateral squash changes angles. After squashing, the model's angled deck must still read ~9.05°; if it doesn't, the over-width isn't a uniform stretch (go per-region). Also round-trip-verify the frame: map a known feature (e.g. a catapult) plan -> deck-ops metres and confirm it lands where expected before trusting the rest.

## Staging (verifiable, revertable — not big-bang)

- **Stage A — DONE (v43/v44/v46/v47).** Concavity fixed (all 4 strip columns at rim height — flat cross-sections; the raise desynced ICCS/railings, re-based in v46); bow tip reached (stations to fa 165); deck-edge fascia skirt (v44); bow walkways preserved (v47: margin kill by `hmax>0.60` — the old ys>-0.30 threshold was in the pre-raise h=0 frame and wiped the bow's near-lip walkways).
- **Stage B — DONE (v48).** True beam measured 80.0 m (not ~9% over; not the 78.9 inset-outline figure) -> S_LAT=0.96 applied as a per-accessor world-frame vertex edit (no multi-instance meshes exist, verified); DOME_KEEP contents preserved via blend-to-translation with 1.2 m falloff; all measured build constants + bake lats + engine deck-ops constants scaled consistently. Accepted trade: angled deck 8.99->8.64 deg vs real 9.05 (invisible). Deck plates now exactly 76.8 m.
- **Stage C — DONE 2026-07-10, as a CHECK, not a re-source.** Automated outline extraction from the scan failed (leader lines, part drawings, compass rose corrupt the trace; lateral reads +-1.5-2 m) — see `plan_check.py`'s header for the method that worked: register the CURRENT outline onto the plan (whole-outline darkness fit; the tips are unusable anchors — there is no bow point, the deck front is a blunt ~23 m edge) and ridge-fit specific features. Verdict: outline, wires, landing line, OLS, cat 2 and cat 3 all agree with the plan within the scan's noise (+-0.5-1.7 m), so wholesale re-sourcing was NOT justified. Two real discrepancies found and FIXED: cat 1 was 3.9 m starboard with +2.4 deg excess heading (the model's painted track lies on no plan feature; the exact fit had been made to misplaced paint) -> (15.50, 3.30 deg); cat 4 was 0.93 m starboard -> -27.75. Both moved coherently: engine shuttles + bake CATS + the cat-1 JBD box/panel-frame paint transplanted onto the new line (the blast-zone rectangle stays as authored — its bottom hugs the deck edge, which did not move). The superseded model-paint track pairs are killed in the bake (`OLD`/`superseded`). Launches on cats 1 and 4 need in-game re-verification.

## Pipeline (scripts + data flow)

```
nimitz-plan.jpg ──> extract_plan.py ──> plan.json  (normalized outline + equipment, deck-ops metres)
                                      │
original GLB ─┐                       │
              ├─> build_carrier.py ───┴─> nimitz-clean.glb
plan.json ────┘        │  steps:
                       │   1. import original
                       │   2. GLOBAL lateral squash S_lat, with dome preservation (counter-scale-about-centre)
                       │   3. edge-line purge
                       │   4. band clear (existing boundary-owned rules, now against the plan outline)
                       │   5. flat deck polygon from plan.json outline at the profile height (fixes concavity + bow)
                       │   6. ICCS transplant + railings (existing)
                       │   7. empty-mesh strip + GC repack
plan.json ──> bake_decktex.py ──> decktex.png   (markings drawn at plan positions, not model-traced)
plan.json ──> splice_layout.py ──> engine.ts    (SHIP.outline + shuttles/wires/line/elevators from the plan)
```

New/changed scripts:
- **`extract_plan.py`** (new) — the plan -> `plan.json` extractor. Semi-manual: pick the reference px points (bow, stern, centreline, beam, cat ends, wire crossings, elevator corners) off the gridded plan, apply the normalization, write `plan.json`. Keep the picked px points in the file as constants so re-runs are deterministic and tweakable.
- **`build_carrier.py`** (revise) — add step 2 (squash + dome preservation) up front; change the deck-polygon source from the traced outline to `plan.json` outline; set the deck height from the profile/flat instead of the DECKY-flat-interior + rim-edge bowl.
- **`bake_decktex.py`** (revise) — draw catapult tracks/centreline/wires/elevator borders from `plan.json` positions instead of tracing the model's painted geometry.
- **`splice_layout.py`** (new, replaces `splice_outline.py`) — splice `plan.json` outline AND equipment constants into `engine.ts` (`SHIP.outline`, `shuttles`, `wires`, `line`, elevator zones).
- **`measure_scale.py`** (new) — measure the model's beam and compute `S_lat`; overlay the squashed edge on `plan.json` to validate uniformity.

## Verification checklist (each attempt)

1. Overlay squashed-model edge on `plan.json` outline — every station lands on the plan edge (else go per-region scale).
2. `md5` dist vs public model after `make` (the vite copy races the cp).
3. Captures (via `cdp_shot.py`):
   - Bow from ahead + low side: deck reaches the bow point, no gap, no concavity.
   - Beam-on side: deck cross-section flat, meets the hull rim flush.
   - Top-down: proportions match the plan (overlay if needed); radomes still spherical.
   - Rear/quarter: island squashed but radomes round; equipment (cats/wires/elevators) at plan positions.
4. Physics: spawn on each cat, wheels sit on the deck (not sunk/floating); `envelope_test.go` still green if touched.

## Iteration knobs (when an attempt is wrong)

- `S_lat` global scale, or switch to piecewise per-fore-aft-region scale.
- Deck height / sheer profile (flat vs measured bow sheer).
- Dome-roundness threshold + the `DOME_KEEP` safety-net list.
- Plan reference-point px picks in `extract_plan.py` (the normalization anchors).
- Fore-aft registration offset (align plan to the existing `fa` frame / cat positions).

## Fallback

The current model-traced pipeline (this same `build_carrier.py`/`bake_decktex.py` before the revisions, and the committed model) stays working. Keep the current `nimitz-clean.glb` build reproducible until the plan-based build passes the checklist. The quick concavity + bow-gap fixes can also be done in the current pipeline independently of this rebuild if we want interim wins.
