# Air: frametime, allocation and code-quality audit

**Revision 3, 2026-08-21.** Revision 1 lived in `/opt/mochi/docs/`, which is not a
git repository. This copy sits in `apps/air/web/docs/`, inside the `air` repo and
inside Claude's editable scope, so it can be committed with the work it describes.
It is untracked and uncommitted; nothing has been staged.

> **Baseline moved between revisions 2 and 3, and not by the auditor.** Revision 2
> measured branch `pause-menu-settings` at `332f9517` plus an uncommitted
> `engine.ts` change. That change has since been committed as `45f88df4` and
> `main` has been merged in at `d041209d`. The audit was re-verified against the
> new baseline:
>
> - `git diff --diff-filter=D --name-only main...HEAD` is **empty** — the main
>   merge deleted nothing, which is the check `CLAUDE.md` requires after one.
> - All six audited constructs are byte-identical: `ft_ring.slice(-30)`,
>   the `recent>18` arms, the pitch-ladder loop, `scene.add(light)` in
>   `transient_blast`, the absent `shadowMap.autoUpdate`, and `@ts-nocheck`.
> - `engine.ts` is now **7,227 lines**, up from the 7,179 measured. Every
>   *count* in this document was taken at 7,179 and is unchanged by the merge;
>   the *line numbers* have shifted. Current positions for the constructs cited
>   most often: `ft_ring.slice(-30)` 6500 → **6544**, `draw_hud` 5955 → **5991**,
>   the pitch-ladder loop 6072 → **6108**, `transient_blast` 4531 → **4562**.
>   Everything else in this document is cited by identifier, not by line, which
>   is why the merge did not invalidate it.
>
> **One thing to flag rather than fix.** `45f88df4` is titled *"refine frametime
> monitoring logic in engine.ts"*, but `git show 45f88df4 -- web/src/game/engine.ts
> | grep -c 'ft_ring\|perf_ring\|refresh_perf\|dynamic_res\|raw_frame'` returns
> **0**. The diff is the JHMCS helmet sight, the labelled chase data block and
> `caution_stack` — HUD symbology, no frametime logic at all. Anyone searching the
> history for when the frametime monitoring changed will land on a commit that did
> not change it, and will not find `b0d075d7`, which is where `perf_ring` actually
> came from.

Nothing was edited, staged or committed. Every figure carries the command that
produced it. Two labels are used throughout and never mixed:

- **Measured** — a command was run and its output is quoted.
- **Derived** — worked out from the code's own branch structure or from stated
  constants. The derivation is shown so it can be checked.
- **Unmeasured** — could not be run here. Named, with the seam it needs. Never
  filled in with judgement.

---

## 0. Premises that did not survive checking

Four of these came from the brief, and two of those came from claims made earlier
in this same thread. They are stated first because three of them change what the
rest of the audit can mean.

### `air-steer` carries no work, and none of the three files are someone else's

```
$ git rev-parse air-steer air-menu-pass
551a5a1904e6ebec88c573cde19247035bbd6769
551a5a1904e6ebec88c573cde19247035bbd6769
$ git diff --stat air-steer air-menu-pass
(no output)
```

Same commit as `air-menu-pass`, identical tree. `steer.ts` does not exist on it.
`bench.ts` and `keys.ts` do, but they are on `main`, written by Alistair
Cunningham (`ad8f5518` 2026-07-22, `2869b785` 2026-07-23). `steer.ts` and
`steer.test.ts` were written by Numan in `b0d075d7` on `mouse-aim-steering`.

The requested exclusion excludes nothing. The whole tree was measured.

### The 50 ms clamp — half right, and already fixed on this branch

```
$ git show main:web/src/game/engine.ts | grep -n 'ft_ring\[ft_i\]'
6160: function refresh_perf(dt){ ft_ring[ft_i]=dt*1000; ...
$ git log --all --oneline -S'perf_ring' -- web/src/game/engine.ts
b0d075d7 feat: add mouse-aim steering law, chase symbology and instrument fixes
$ git show main:web/src/game/engine.ts | grep -c perf_ring
0
```

On `main` there is one ring, fed the clamped `dt`, so the worst frame it can
report is exactly 50 ms. The true-value ring landed in `b0d075d7`, on this branch
line. Everything quoted before 2026-08-19 is void. The current readout is sound.

### There are no 6 lint errors

```
$ npx eslint .
✖ 2 problems (0 errors, 2 warnings)
```

Cleared in `6e69c1ad`. Two warnings remain and they are breaking CI — §4.

### "Per-frame allocation is the usual cause of spikes" — not here, and §2 now shows the working

Resolved properly in §2.4. Short version: the worst single loop in the engine is
0.50–0.86 MB/s, and the only recorded total is 2.5 MB/s. Allocation is a real
CPU cost and worth fixing, but on these numbers it is not what is spiking.
**A stronger spike candidate turned up in §3.4 and it is not allocation at all.**

---

## 1. Frametime

### 1.1 How it is sampled, and where the clamp sits

| | source | value | consumer |
|---|---|---|---|
| `dt` | `frame()` — `Math.min(clock.getDelta(), 0.05)` | clamped at 50 ms | the integrators, and `ft_ring` |
| `raw_frame` | `frame()` — `clock.getDelta()` | true | `perf_ring` → the on-screen readout |
| bench deltas | `bench.ts:129`, independent RAF loop | true, never clamped | the `?bench=` beacon |

`frame()` calls `refresh_perf(dt, raw_frame)` then `dynamic_res(dt)`.
`refresh_perf` writes the clamped value into `ft_ring` and the true value into
`perf_ring`; the readout reads `perf_ring`. **Yes, something downstream of the
clamp still sees the true value** — the readout does, and `bench.ts` never went
through the clamp at all.

The one consumer still on the clamped ring is `dynamic_res`, and the comment
above `perf_ring` says that is deliberate: feeding true loading hitches to the
governor would slam the render scale down on a machine that is fine. That
reasoning holds. The bug is in *which* clamped samples it reads.

### 1.2 The governor reads a fixed window — restated as latency, not failure

`dynamic_res`, first line of the body:

```js
const last=ft_ring.slice(-30), recent=last.reduce((s,v)=>s+v,0)/30, spike=[...last].sort((a,b)=>a-b)[27];
```

`ft_ring` is a 180-slot **ring buffer** with a rotating write index `ft_i`.
`slice(-30)` returns positions 150–179 — the same 30 positions every time,
wherever `ft_i` happens to be. Those slots are refreshed once per 180 frames.

**Revision 1 said "never drops the scale". That overstated it and the correction
is taken.** Positions 150–179 do refresh, so a sustained overload is eventually
caught — late. Revision 1's single simulation happened to place the overload at a
ring phase that missed the window, and one phase is not a result.

Swept across ring phase and overload duration:

```
$ node scratch/ring2.mjs

DETECTION LATENCY — seconds from overload onset to the first governor tick that reacts.
Baseline 16.7 ms (60 Hz vsynced). Overload 40 ms (25 fps). "never" = not caught in 40 s.

  ring slot at onset |  0.5 s overload |    2 s overload |    5 s overload
  -------------------|-----------------|-----------------|----------------
  slot   0 of 180    |          never |          never |          never
  slot  15 of 180    |          never |          never |          never
  slot  30 of 180    |          never |          never |         5.22 s
  slot  45 of 180    |          never |          never |         4.68 s
  slot  60 of 180    |          never |          never |         3.64 s
  slot  75 of 180    |          never |          never |         3.12 s
  slot  90 of 180    |          never |          never |         2.60 s
  slot 105 of 180    |          never |         2.08 s |         2.08 s
  slot 120 of 180    |          never |         1.56 s |         1.56 s
  slot 135 of 180    |          never |         1.04 s |         1.04 s
  slot 150 of 180    |         0.54 s |         0.52 s |         0.52 s
  slot 165 of 180    |         0.54 s |         0.52 s |         0.52 s

  0.5 s overload, all 180 onset phases: caught  40/180 = 22%
    2 s overload, all 180 onset phases: caught  77/180 = 43%
    5 s overload, all 180 onset phases: caught 152/180 = 84%
```

**Restated finding: transient-blindness plus detection latency, not total
failure.**

- A half-second hitch is invisible at **78%** of ring phases.
- A two-second overload is missed at **57%** of phases.
- A five-second overload is caught at 84% of phases, but at a **median 2.60 s and
  worst 5.22 s** after onset — against a governor that ticks every 0.5 s and is
  written to react in one tick.

A correct window catches every one of these cases at the first tick, 0.5 s.

One thing the table understates: during an overload the ring advances in *frames*,
not seconds. At 40 ms a full 180-frame sweep takes 7.2 s instead of 3.0 s, so the
window goes stale more slowly exactly when it most needs to be fresh.

Two cosmetic errors on the same line: `[27]` of a 30-element sorted array is p93,
and the comment says p90. And `refresh_perf`'s `s[Math.floor(180*0.99)]` is
`s[178]`, the second-worst of 180, labelled "1% low".

### 1.3 The masking hypothesis — refuted

**Hypothesis under test:** the stale window has been sparing 50 Hz panels from the
18 ms threshold, so fixing the window alone would switch on a governor that
immediately condemns every healthy 50 Hz machine.

**And it is not opt-in.** `cfg` at the top of `engine.ts` and `lib/config.ts:235`
both set `dyn_res: true`, and `config.ts:233` names the 18 ms threshold in the
comment beside it. Every player who has not gone into Settings and turned it off
is running this governor. The ranking assumes field impact and the assumption
holds.

**Refuted, and the code says why.** The masking is a *transient* effect. A
perfectly vsynced 50 Hz panel writes 20 ms into **every** slot in the ring,
including 150–179. There is nothing for a stale window to hide: the window's
contents are 20 ms whenever you read it, at every phase.

```
$ node scratch/ring.mjs   (steady-state section)

 refresh | frame ms | recent | drop (>18) | raise (<17.2 & p90<17.5) | verdict
---------|----------|--------|------------|--------------------------|--------
   144 Hz |     6.94 |   6.94 |         no |                      YES | raises to 1.0 and holds
   120 Hz |     8.33 |   8.33 |         no |                      YES | raises to 1.0 and holds
    90 Hz |    11.11 |  11.11 |         no |                      YES | raises to 1.0 and holds
    75 Hz |    13.33 |  13.33 |         no |                      YES | raises to 1.0 and holds
    60 Hz |    16.67 |  16.67 |         no |                      YES | raises to 1.0 and holds
    50 Hz |    20.00 |  20.00 |        YES |                       no | ratchets to 0.45 floor, then "cannot hold it"
    30 Hz |    33.33 |  33.33 |        YES |                       no | ratchets to 0.45 floor, then "cannot hold it"
```

**50 Hz panels are being condemned today, on `main`, with the stale window in
place.** The drop fires on the first governor tick and every 0.5 s after. From
scale 1.0 the six 0.1 steps reach the 0.45 floor in 3 s. At the floor the
`else if(recent>18)` arm accumulates `dyn_strain += 0.5` per tick, and at 30 it
writes `air.performance = "1"` — 30 s of gameplay. And under vsync **cutting the
render scale cannot help**: the frame cannot come in under the panel period no
matter how few pixels are drawn, so `recent` stays at 20 ms forever and the raise
arm, which needs `recent < 17.2`, can never fire. The verdict is permanent.

That is precisely what `bench.ts:47-56` predicts. Finding 15 is not latent behind
finding 1. **It is live, it is worse than revision 1 ranked it, and it should move
up.**

**Revision 2 said these two must ship as one commit. That was wrong, and it is
retracted here.** The argument was that fixing the window makes a governor with a
miscalibrated threshold act faster and more often, so a sharper trigger on a wrong
threshold is worse than a blunt one. Worked through per refresh rate, no such case
exists:

| panel | today, stale window | with a fresh window | worse? |
|---|---|---|---|
| 50 Hz | fires at every tick from steady state | fires at every tick from steady state | **no change** — the ring is uniformly 20 ms, so freshness is irrelevant |
| 60 Hz | transients missed at 78% of phases | transients caught in one tick | **better** — 18 ms is the *correct* threshold at 60 Hz |
| 75 / 90 Hz | never drops (frames far under 18 ms) | never drops | no change |
| 120 / 144 Hz | never drops | never drops | no change |

The only behaviour a fresh window adds is reacting to transients, and a transient
that carries the 30-frame mean past 18 ms is a genuinely bad stretch at 60 Hz and
an even worse one relative to budget above it. There is no refresh rate at which
seeing it sooner is a regression.

**So the two findings are independent and the window fix is safe alone.** The
ordering that matters is a different one: a commit that fixes the window must say
in its body that it does **not** fix the threshold, or the next reader sees
"dynamic resolution governor fixed" and closes finding 1 with the 50 Hz and 144 Hz
halves still live.

### 1.4 What 18 ms should be derived from, and what it does at 144 Hz

`18`, `17.2` and `17.5` are hardcoded and are all 60 Hz numbers. Against the
60 Hz period of 16.667 ms they are exact multiples:

| constant | value | ÷ 16.667 ms | meaning |
|---|---:|---:|---|
| drop threshold | 18.0 | **1.080** | mean is 8% over the panel period |
| raise threshold | 17.2 | **1.032** | mean is within 3.2% of the period |
| raise p90 gate | 17.5 | **1.050** | tail is within 5% of the period |

So the thresholds should be **multiples of the measured refresh interval**, and
deriving them that way reproduces today's 60 Hz behaviour to three decimal places.
Derived:

| panel | period | drop above | raise below | p90 gate |
|---|---:|---:|---:|---:|
| 144 Hz | 6.94 | 7.50 | 7.17 | 7.29 |
| 120 Hz | 8.33 | 9.00 | 8.60 | 8.75 |
| 90 Hz | 11.11 | 12.00 | 11.47 | 11.67 |
| 75 Hz | 13.33 | 14.40 | 13.76 | 14.00 |
| **60 Hz** | **16.67** | **18.00** | **17.20** | **17.50** |
| 50 Hz | 20.00 | 21.60 | 20.64 | 21.00 |

**The measurement exists in this codebase, and feeding it straight to the
governor would be a bug.** `bench.ts` has `cadence()`, which takes the mode of a
0.5 ms histogram of frame deltas and returns `{ beat, locked, refresh }`. It is
tempting to call that the panel period and derive the budget from it. It is also
circular, and revision 2 of this document made exactly that mistake.

**The governor controls the frame interval.** Deriving its threshold from the
measured frame interval is a control loop reading its own output as its setpoint.
A 60 Hz machine struggling at 30 fps sits on half-rate vsync: every frame is
33.3 ms, the modal beat is a rock-solid 33.5 with a high `locked` share, and from
the deltas alone that is indistinguishable from a genuine 30 Hz panel. The budget
becomes drop-above-36 ms and the governor stops governing on precisely the machine
that needs it most. **The worse it gets, the more permissive the threshold gets.**

The panel estimate therefore has to be **monotone**: it narrows freely and never
widens on the strength of a loaded measurement. That is a safety property held by
construction rather than by tuning — no sequence of frame samples, however
adversarial, can relax the budget. Widening needs evidence that load cannot
manufacture:

- **`screen.refreshRate`** where the browser exposes it. Non-standard and usually
  absent, so it cannot be the primary source, but authoritative when present.
  `bench.ts` already reports it as `declared`, with a comment saying exactly that.
- **An idle sample** — taken where the app knows the frame is cheap. The menu
  backdrop is the natural seam: the frame loop already runs there and draws almost
  nothing, so a beat measured in the menu is the panel's own period before any
  mission load exists to confound it.

And even an idle sample has to clear the half-rate test. Under vsync every delta
is an integer multiple of the panel period, so a candidate that is an exact
multiple of what is already believed (33.3 = 2 x 16.667, 50.0 = 3 x) is the
ambiguous case and is refused; a candidate that is not (20.0 is 1.2 x 16.667)
can only have come from a different panel and is accepted. That is what lets a
real 50 Hz display be recognised while half-rate vsync on a 60 Hz display is not.

**Deliberate cost, stated rather than hidden.** A genuine 30 Hz panel reads as
exactly 2 x the 60 Hz default, is refused, keeps the 60 Hz budget, and gets
condemned the same way 50 Hz panels are today. 30 Hz displays are rare and
`screen.refreshRate` is the escape hatch. Half-rate vsync on a common panel is
both more likely and more damaging to get wrong, so it wins the ambiguity. A
50 Hz machine already overloaded *in the menu* also seeds wrong. Both holes are
real, and both are narrower than the hole that exists today.

**At 144 Hz today, the governor is inert in the wrong direction.** The table in
§1.3 shows it raises to 1.0 and holds. It will not drop until frame time passes
18 ms, which is **below 55.6 fps**. A 144 Hz player can fall from 144 fps to 56 fps
with the governor doing nothing at all, because 18 ms is not their budget — 6.94 ms
is. Derived thresholds fix both ends with one change: the 50 Hz false condemnation
and the 144 Hz sleeping governor are the same bug with the sign flipped.

**Unmeasured:** whether `cadence()`'s mode is stable enough to drive a control
loop on a real machine. It has only ever been used to annotate a report. The seam
is to add `beat` to the bench payload's non-dev path, or to log it for a session
before wiring it to the governor.

### 1.5 Unmeasured: the distribution, the phase breakdown, the spikes

No browser on this host, and the project forbids running a dev server:

```
$ which chromium chromium-browser google-chrome chrome firefox node
/root/.nvm/versions/node/v22.22.3/bin/node
$ ls /root/.cache/ms-playwright
(no such directory)
```

So p50/p95/p99/max, frame count, run length, per-phase cost and spike attribution
are **unmeasured**. Seams, in build order:

1. **p99 and max do not exist.** `bench.ts` `finish()` reports `avg`, `median`,
   `p95`, `fastest`, `p5` and the cadence histogram. Three lines.
2. **One phase is instrumented.** The `acc_submit` wrapper around
   `renderer.render` is the only one; `bench.ts` diffs any `acc_*` field over the
   window. Four more in the same style — `acc_hud`, `acc_step`, `acc_input`,
   `acc_shadow` — give a per-phase breakdown with no new tooling. **Until they
   exist a phase breakdown cannot be produced**, and it will not be estimated.
3. **Spike attribution needs the raw deltas, not order statistics.** `deltas[]`
   is already retained; beaconing it alongside a marker of what was running turns
   "p99 is X" into "the p99 frames are the merge frames".
4. A browser. `?developer=1&bench=12&benchto=<url>` plus `bench_arm()` is the
   whole harness.

### 1.6 A pure helper, so this bug can never come back without a browser

The window calculation is the only part of the governor that needs a GPU to
*matter* and no GPU at all to *test*. Extracting it the way `steer.ts` was
extracted gives a permanent regression guard that runs in node.

Proposed `src/game/governor.ts` — no THREE, no DOM, no engine imports:

```ts
export const RING = 180
export const WINDOW = 30

/** The most recent `window` samples from a ring buffer whose NEXT write index
 *  is `next`. This is the thing engine.ts gets wrong with slice(-30). */
export function recent_window(ring: readonly number[], next: number, window = WINDOW): number[]

export interface Budget { drop: number; raise: number; spike: number }

/** Thresholds as multiples of the panel's measured period. The multipliers
 *  reproduce the historic 60 Hz constants exactly: 16.667 x 1.080 = 18.00,
 *  x 1.032 = 17.20, x 1.050 = 17.50. */
export function budget(beat_ms: number): Budget

export type Verdict = 'drop' | 'raise' | 'hold' | 'strain'
export function verdict(samples: readonly number[], scale: number, ceiling: number, b: Budget): Verdict
```

The test that makes it permanent: write a known sequence into a ring at **every**
phase 0–179 and assert `recent_window` returns the last N written. That test fails
against `slice(-30)` at 150 of 180 phases and passes against a correct
implementation — no browser, no GPU, runs in the existing vitest suite.

`budget` gets a table test pinning the 60 Hz row to the historic constants, which
is what makes the change provably behaviour-preserving on the panel everyone has
been testing on.

**One correction to the framing.** This would not be *the first* thing pulled out
of `engine.ts` — `keys.ts` took `KEY_DEFAULTS` and `pretty()` out in `ad8f5518`,
and `servers.ts`, `pipper.ts`, `menace.ts` and `steer.ts` followed. It would be
the first piece of the **frame loop's control logic** to come out. Everything
extracted so far has been policy or data; this is the first behavioural loop.

---

## 2. Allocation and GC

### 2.1 Sites in the hot path

```
$ node scratch/hotalloc.mjs
functions reachable from frame(): 266  (of 397 named functions in engine.ts)
total allocation-expression sites in reachable set: 595
```

| sites | function | breakdown |
|---:|---|---|
| 76 | `draw_hud` | 37 array literals, 18 `.toFixed()`, 7 Vector3, 7 object literals |
| 32 | `flight_world` | 26 object literals, 5 `.map()` |
| 30 | `apply_model_to` | init only, not per frame |
| 29 | `recording_sample` | 28 object literals |
| 13 | `apply_anim` | 4 Vector3, 4 Quaternion |
| 12 | `draw_chase` | 9 array literals |
| 11 | `fly_bandit` | 5 `.clone()`, 4 Vector3 |

116 of the 595 are THREE objects or `.clone()`. **A site count is not an execution
count.** For one loop the execution count follows from the branch structure, so
that one gets real numbers.

### 2.2 The pitch ladder — derived from its branches, and it is a snapshot

Revision 1 gave a flat "282 per frame". That was right on the arithmetic and
wrong on the label: it is a **ceiling that varies with pitch attitude**, not a
per-frame constant. The branch structure, from the loop body:

```js
for(let p=-90;p<=90;p+=5){ const pr=p*D2R;
  if(Math.abs(p)===90){ const Z=proj_dir(dir_at(ladFwd,rightH,0,pr)); if(!Z) continue;
    ...zenith/nadir circle...
    continue; }
  const wide=(p===0&&pa)?20:(p===0?12:5.2);
  const L=proj_dir(dir_at(ladFwd,rightH,wide*D2R,pr)),
        R=proj_dir(dir_at(ladFwd,rightH,-wide*D2R,pr)); if(!L||!R) continue;
  ...
  hctx.setLineDash(p<0?[7,6]:[]);
  ...
  for(const half of [-1,1]){ ... }
  if(p!==0){ hctx.setLineDash([]);
    for(const half of [-1,1]){ ...fillText(String(Math.abs(p)),...) } }
```

```
$ node -e 'const b=[];for(let p=-90;p<=90;p+=5) if(Math.abs(p)!==90) b.push(p);
  console.log("branch-B iterations:",b.length,"| p<0:",b.filter(p=>p<0).length,
  "| p>=0:",b.filter(p=>p>=0).length,"| p!==0:",b.filter(p=>p!==0).length)'
branch-B iterations: 35 | p<0: 17 | p>=0: 18 | p!==0: 34
```

**37 × 2 = 74 is not the `dir_at` count, and this is why.** The two `|p| === 90`
iterations take the zenith/nadir branch, which calls `dir_at` **once** and then
`continue`s. The other 35 call it twice.

| allocation | site | count | gated by? |
|---|---|---:|---|
| `dir_at()` → `headFwd.clone()` | both branches | **2×1 + 35×2 = 72 Vector3** | **no** — both calls are arguments to `proj_dir`, so they execute *before* `if(!Z)` and `if(!L||!R)` |
| `proj_dir()` → `[x,y]` | both branches | 0–72 arrays | yes — returns `null` when `_p.z > 1`, i.e. the direction is behind the camera |
| `[7,6]` / `[]` dash | `setLineDash`, first | 17 + 18 = 35 | yes — after the `!L||!R` guard |
| `[-1,1]` | first `for…of` | 35 | yes |
| `[]` dash | `setLineDash`, second | 34 | yes, and `p !== 0` |
| `[-1,1]` | second `for…of` | 34 | yes, and `p !== 0` |
| `String(Math.abs(p))` | `fillText` | 68 strings | yes, and `p !== 0` |

**Floor: 72 Vector3 per frame, attitude-independent.** They are allocated before
either guard, so no attitude can reduce them.

**Ceiling: 282 objects per frame excluding strings, 350 including them.** Reached
when all 37 ladder directions project in front of the camera.

**What the attitude assumption is.** The ladder is 37 directions spanning ±90° of
pitch about the velocity vector's horizontal azimuth. `proj_dir` pushes each 1000 m
out from the camera and returns `null` past the far plane. In roughly level flight
with the camera looking along the velocity vector, nearly every rung projects in
front and the count sits at the ceiling. In a steep climb or dive, or with the
camera swung away from the velocity vector, a growing share of the rungs fall
behind the camera, `proj_dir` returns `null`, and the iteration `continue`s before
the dash arrays, the `[-1,1]` pairs and the label strings. **The ceiling is the
level-flight, looking-forward case. Treat 282 as a snapshot at that attitude, not
a constant.** The 72 Vector3 floor is the only number here that holds at every
attitude.

Everything above is removable without changing a pixel: `dir_at` can write into a
scratch vector the way `proj_dir` already writes into `_p`; `proj_dir` can fill a
scratch pair; the dash arrays and `[-1,1]` are module constants; the nine tick
labels never change for the life of the program.

Confirmed the loop is not new: it was present at `#148`, so the 2.5 MB/s figure
below was measured with it running.

```
$ git show 2869b785:web/src/game/engine.ts | grep -c 'for(let p=-90;p<=90;p+=5)'
1
```

### 2.3 Per-frame closures

```
$ node scratch/closures.mjs frame draw_hud draw_chase hud_insets hud_inset \
    render_frame update_camera step_world refresh_perf dynamic_res
total closure literals in the listed per-frame functions: 19
```

Unconditional: `closure` and `y_of` in `draw_hud`, the `comms.filter` predicate,
two in `update_camera`, two in `step_world`, and two in `hud_insets` whenever the
corner instruments are on. `draw_chase` allocates none — measured, zero closures
and zero THREE objects.

### 2.4 Resolving the 2.5 MB/s contradiction, and the cross-check

**The contradiction was real and it was mine.** Revision 1 used the 2.5 MB/s
figure from `2869b785` to deprioritise allocation in premise 0.4, while §2 said
that same figure must not be quoted as current. A number cannot be too stale to
quote and solid enough to rank on. Resolution:

1. It is the **only** allocation measurement this project has ever taken, and it
   is stale (2026-07-23, before corner-instruments, mouse-aim and the JHMCS work).
2. It should be **re-measured**, and it stays on the unmeasured list.
3. In the meantime the static count can be **cross-checked against** it, which is
   the step revision 1 skipped. Doing so either corroborates both or breaks one.

The arithmetic, with V8 object sizes stated (64-bit, pointer compression, the
default since V8 8.0: JSObject header 12 B, in-object double field 8 B, JSArray
16 B, FixedDoubleArray header 8 B, FixedArray header 8 B, SeqOneByteString header
12 B, 8 B alignment):

```
$ node scratch/alloc.mjs
objects per frame, ceiling: 350  (282 excluding strings)

           bytes/frame   bytes/s @60fps    MB/s     % of the recorded 2.5 MB/s
  low          8704         522240     0.50    20 %
  mid         10432         625920     0.60    24 %
  high        14960         897600     0.86    34 %

floor (attitude-independent): 72 Vector3 from dir_at, allocated before either guard
  low    0.10 MB/s
  mid    0.16 MB/s
  high   0.23 MB/s
```

**The pitch ladder is 20–34% of the recorded total, central estimate 24%.**

The proposed "roughly 1 MB/s, about 40%" is above the top of that range. It needs
about 56 bytes per object across the board, which is the upper bound for a
`Vector3` and roughly double what a two-element SMI array costs. The `[]` empty
arrays are 16 B and the `[-1,1]` pairs are 32 B, and there are 121 of those; they
pull the average down hard. 40% is reachable only with the "high" sizes on every
category at once.

**What the cross-check buys.** One loop at ~24% of a 2.5 MB/s total is a
*consistent* picture — it leaves ~1.9 MB/s for the other 594 sites, which is what
595 sites across 266 functions should look like. The static count and the stale
measurement corroborate each other rather than fighting. That raises confidence in
both, and it means the deprioritisation stands but **on different grounds**: not
"2.5 MB/s is low" (a stale number), but "the single worst loop in the engine is
0.6 MB/s, so no plausible total puts allocation in spike territory unless the GC
is behaving pathologically" — which is itself testable, and on the list.

**Still unmeasured:** bytes and GC pause frequency and duration. No browser, so no
heap profile. `performance.memory` is Chrome-only and too coarse at this scale.
The seams are a DevTools allocation-sampling profile over a recorded fight, or
`performance.measureUserAgentSpecificMemory()` in the bench payload for a coarse
before/after.

---

## 3. Render and scene

### 3.1 Unmeasured, but already plumbed

`renderer.info.render.calls`, `.triangles`, `(renderer.info.programs||[]).length`,
`renderer.info.memory.textures` and `.geometries` are all already reported into
the bench payload. They need a browser and nothing else. Cheapest unmeasured item
in this audit — and see §3.4 for why `programs.length` in particular is the one to
watch.

### 3.2 What is rebuilt per frame

- **Render targets** — `size_rt()` creates once, `setSize` on change. Correct.
- **DDI face** — 120 ms throttle, or per frame only for pages flagged `animated`.
  Correct.
- **HUD corner insets** — one offscreen canvas per key, 120 ms throttle. Correct.
- **The main HUD canvas** — the exception. Cleared and fully repainted every frame.

### 3.3 The HUD

Canvas, not DOM. `hctx.clearRect(0,0,HW,HH)` then a complete repaint:

```
$ sed -n '5955,6462p' engine.ts | grep -o 'hctx\.[a-zA-Z]*' | sort | uniq -c | sort -rn
     57 hctx.fillText      47 hctx.fillStyle     44 hctx.lineTo
     34 hctx.moveTo        31 hctx.beginPath     26 hctx.stroke
     27 hctx.font          25 hctx.textAlign     21 hctx.strokeStyle
     17 hctx.setLineDash   17 hctx.lineWidth      7 hctx.save
```

The canvas is `innerWidth × dpr`, so 5120 × 2880 on a dpr-2 1440p display.

**And all of it goes through a shadow blur.** `draw_hud` sets `shadowColor` and
`shadowBlur=3` for the whole pass; only the two offscreen face paths clear it.
Every glyph and every line in the main HUD is drawn through the blur path, which
is the most expensive property on the Canvas2D context.

**Unmeasured:** what that costs in ms. Seam is one `acc_hud` accumulator around
the `draw_hud()` call, two lines, in the `acc_submit` style. No number until then.

### 3.4 Three.js per-frame costs, checked statically

Revision 1 skipped these as browser-blocked. They are greppable and one of them is
a stronger spike candidate than anything else in this audit.

#### Light churn invalidates every shader program — and it fires on every explosion

`transient_blast` adds a `PointLight` to the scene for each explosion and water
splash:

```js
const light=new THREE.PointLight(water?0xcceeff:0xff8b32,water?14:38,water?35:75,2);
light.position.set(x,y+1,z); scene.add(light);
transient_fx.push({mesh,light,age:0,life:water?.75:.34,water}); }
```

and `update_transient_fx` removes it 0.34 s later (0.75 s for water):

```js
if(t>=1){ scene.remove(f.mesh,f.light); f.mesh.material.dispose(); ... }
```

Three.js folds the scene's light counts into the program cache key —
`WebGLPrograms.getParameters()` includes `numPointLights`, `numSpotLights`,
`numDirLights`, `numHemiLights` and the matching shadow counts. **Changing the
number of point lights changes that key for every lit material in the scene.**
The first time each new count is seen, every lit material compiles and links a
fresh GLSL program.

Base light set, from the greps: 1 `DirectionalLight` (shadow-casting),
1 `HemisphereLight`, 1 `AmbientLight`, 3 `SpotLight` (two deck floods and the
landing light), 1 `PointLight` (the cockpit flood, on `LAYER_OWN`). Every blast
pushes the point-light count up by one and drops it back 0.34 s later.

**Why this is the spike shape you asked about.** Programs are cached, so this is
not a per-frame cost — it is a **first-encounter cost per light count**. A quiet
flight never sees more than one or two simultaneous blasts and pays once. A gun
burst landing five hits inside a third of a second pushes the count to a value the
renderer has never compiled for, **mid-merge**, and every lit material in the
scene — carrier, deck, airframe, runway, buildings — relinks at once. That is a
1% spike that lands exactly where it hurts, and it will not reproduce in a quiet
benchmark run.

**Confidence: high on the mechanism** (the three.js program-key behaviour is
documented and the add/remove calls are quoted above). **Unmeasured: the cost.**
The fingerprint is already reported — `renderer.info.programs.length` climbing
during a fight is the whole test, and it is in the bench payload today.

**The fix is cheap and matches this codebase's own idiom.** Missiles are pooled at
`MSL_MAX=32`, debris and smoke are pooled. The blast light is the one effect that
is not: pool a fixed set of `PointLight`s, add them once at startup, and animate
`intensity` to and from zero instead of adding and removing. The light count then
never changes and no recompile can occur.

#### The shadow map re-renders every frame, into a box that holds nothing

```
$ grep -rn "autoUpdate" engine.ts *.ts
(no output — never set)
```

`renderer.shadowMap.autoUpdate` therefore defaults to `true`: with
`cfg.shadows` on, the 1024×1024 `PCFSoftShadowMap` is re-rendered every frame,
traversing the scene and drawing every `castShadow` mesh.

The shadow camera never moves:

```js
const sun = new THREE.DirectionalLight(0xfff4e0,2.4);
sun.position.copy(sun_dir).multiplyScalar(4000); sun.castShadow=true;
sun.shadow.mapSize.set(1024,1024); sun.shadow.camera.near=100; sun.shadow.camera.far=8000;
sun.shadow.camera.left=-800; sun.shadow.camera.right=800; sun.shadow.camera.top=800; sun.shadow.camera.bottom=-800;
```

and the only other write is `sun.target.position.set(0,0,0)` in the time-of-day
path. So the orthographic shadow volume is a **±800 m box centred on the world
origin**, which is Midway Atoll (`acmi.ts:14`). Against the world's actual
contents:

```
$ node -e 'const c={x:-18500,z:7500}; console.log("carrier", Math.round(Math.hypot(c.x,c.z)),"m from origin")'
carrier 19962 m from origin
```

- The carrier is at `{x:-18500, z:7500}` — **20 km outside** the shadow box.
- The Sand Island runway centroid is `{x:-1125, z:2898}` — 3.1 km out, also
  outside.

**Derived:** in any carrier mission, and in any runway mission, the shadow pass
runs every frame and produces a map covering a patch of ocean that the player is
nowhere near. The ownship, the carrier and the airfield cannot receive a shadow
from it at all.

**Confidence: high on the geometry** (all four numbers are constants in the
source). **Inference, not measurement,** on "no visible shadow anywhere in a
carrier mission" — I have not seen it rendered, and there may be atoll geometry
inside the box that does shadow correctly. What is certain is the cost is paid
every frame and the two places the player spends their time are outside the volume.

**Two things bound how much this matters, and both were missing from revision 2.**

First, `lib/config.ts:237` sets `shadows: false` by default, and only the `high`
and `ultra` graphics presets turn it on. So this costs nothing at all for a player
on the default settings, which moves it well down the list.

Second — and this is the correction that matters — **this audit established what
is OUTSIDE the box and never established what is INSIDE it.** The atoll is built
by `build_islands` from coastline polygons fetched at runtime, so its geometry
cannot be enumerated from source, and the joust spawns *"head-on east-west
directly over the atoll"*, which is over the origin. There may well be geometry
inside the box that shadows correctly today.

That makes `shadowMap.autoUpdate = false` the wrong fix to reach for first.
Freezing the map means stale shadows whenever anything inside the box moves, and
`apply_time_of_day` writes `sun.target.position` — a frozen map would not follow
the sun. **This needs `acc_shadow` measuring the pass first, and a look at what
actually renders into it.** It belongs with the browser work, not in fix-now.

The two candidate fixes are independent and neither should be chosen blind: move
the shadow camera to follow the player (makes shadows work, and costs more), or
freeze the map and raise `needsUpdate` only on change (makes the cost match the
value, and risks staleness).

#### Matrix updates are never disabled

```
$ grep -n "matrixAutoUpdate\|matrixWorldAutoUpdate" engine.ts *.ts
(no output — never set)
```

Both default to `true`, so `scene.updateMatrixWorld()` recomposes the local matrix
of **every** object in the graph, every frame. The static scenery is large and
never moves: runway and taxiway meshes, buildings, the arrestor wires, the JBD
panels and their stiffener ribs, windsock poles, PAPI and OLS point clouds, 68
deck-flood fixtures, the 32-slot missile pool with its 32 trail `Line` objects.
Setting `matrixAutoUpdate=false` on the static branches after placement is the
standard fix and costs one line per branch.

**Unmeasured:** the object count and therefore the size of the win. 47 `scene.add`
call sites, many inside loops, so the graph cannot be counted statically with any
honesty. `renderer.info.memory.geometries` in the bench payload gives the real
number the moment there is a browser.

#### `frustumCulled = false` — 13 objects, all defensible

sky sphere, stars, ocean, the 32 missile trails, and eight `Points` clouds
(runway lights, PAPI base and white, OLS ball, deck floods, aircraft lights, the
dev cursor). Sky and ocean are always in view; the `Points` clouds are
screen-space lamps that would pop at the frustum edge if culled. Nothing here
looks accidental, and each carries a comment explaining itself. **Leave alone.**

### 3.5 Offscreen and never-visible work

- `render_frame` returns immediately in DDI view; the world passes are skipped.
- Cockpit view issues **two** `renderer.render(scene, …)` calls per frame — the
  world without `LAYER_OWN`, then ownship-only with depth cleared. Deliberate and
  documented.
- The cloud path runs **five** render passes when `cloud_active()`.
- Plus the shadow pass every frame when shadows are on — see §3.4.
- Nothing found that is drawn and never seen, apart from the shadow map.

---

## 4. Code quality

### 4.1 engine.ts

**7,179 lines, 712,598 bytes**, and one fact dominates the rest:

```
$ node scratch/fnstats.mjs src/game/engine.ts lines
 7108 lines  cx=4348  engine.ts:72-7179  startGame
```

All 397 other named functions are nested inside `startGame`. That is why nothing
in the engine can be imported, and therefore why nothing in the engine can be
tested. Top 15 by length:

| lines | cx | function |
|---:|---:|---|
| 508 | 342 | `draw_hud` |
| 163 | 125 | `read_input` |
| 124 | 46 | `build_carrier_deck_aids` |
| 108 | 131 | `fly_player` |
| 108 | 55 | `fly_bandit` |
| 105 | 105 | `step_missiles` |
| 90 | 68 | `update_camera` |
| 85 | 30 | `reset_ownship` |
| 84 | 111 | `recording_sample` |
| 80 | 68 | `net_frame` |
| 79 | 137 | (anonymous, `engine.ts:4668`) |
| 74 | 158 | (anonymous, `engine.ts:3774`) |
| 71 | 63 | `init_external_model` |
| 63 | 121 | `apply_anim` |
| 57 | 59 | `frame` |

By complexity the ranking is nearly the same; the three that appear only there are
`net_event` (49 lines, cx 78), `update_anim` (25 lines, cx 67) and `frame`. Note
the anonymous function at `engine.ts:3774` — 158 branches in 74 lines, the densest
thing in the file, and it has no name.

### 4.2 Dead code

```
$ node scratch/dead.mjs
total dead exports: 36
```

28 are type-only and are noise. The eight value-level ones: `net.ts:929
recording_pin`, `lib/config-store.ts:128 saveConfig`, `steer.ts:215 REACH_EASE`,
`pipper.ts:34 LENGTH`, `pipper.ts:36 LIFE`, `servers.ts:23 OFFLINE_AFTER`,
`stores.ts:46 STATIONS`, `SettingsDialog.tsx:841 HEAD_MESSAGES`.

Three are orphans of a good decision: `REACH_EASE`, `LIFE` and `OFFLINE_AFTER`
went dead because `0bb3ac7e` stopped the tests deriving expectations from them.
`HEAD_MESSAGES` causes one of the two lint warnings.

### 4.3 The dev hooks ship

`DEV_MODE` is a runtime read of `?developer=1`, so nothing tree-shakes.

```
$ BUILD_LOCALES=en npx vite build --outDir <scratch>/dist-audit
$ grep -ho 'dev_[a-z_]*' <scratch>/dist-audit/assets/*.js | sort -u | wc -l
21
```

`dev_acmi dev_approach dev_ball dev_bandit dev_bandit_state dev_close dev_crash
dev_dispense dev_effects dev_flight dev_heat dev_hook dev_measure dev_missiles
dev_mouse dev_panels dev_pools dev_probe dev_radar dev_wound dev_zone`, plus the
whole bench harness (`bench_arm`, `bench_result`, `benchto`,
`bench-module-loaded`). 101 lines of `engine.ts` mention `DEV_MODE` or `dev_`.

| chunk | raw | gzip |
|---|---:|---:|
| three.js (named `aim120c-*.js`) | 685,974 | 186,151 |
| `index-*.js` | 474,837 | 151,200 |
| `GameCanvas-*.js` (the engine) | 349,875 | 129,420 |

The `aim120c` name is a Rollup artifact from an entry in `weapons.ts`, not a
defect.

### 4.4 Duplication

```
$ node scratch/dup.mjs 5 3
window=5 lines, min occurrences=3  ->  0 duplicated blocks
$ node scratch/dup.mjs 4 3
window=4 lines, min occurrences=3  ->  2 duplicated blocks
```

Three or more occurrences: the glTF texture-stripping block (`engine.ts:2192`,
`:2265`, `:2405`); `<SelectTrigger>/<SelectValue>/<SelectContent>`
(`MissionSetup.tsx:139`, `SettingsDialog.tsx:357`, `:810`); the POST fetch
preamble (`net.ts:128`, `:152`, `:180`); the match-record field set
(`net.ts:860`, `:883`, `:940`).

The largest one a fixed window cannot catch: `SettingsDialog.tsx` `GAMEPAD_ROWS`
(`:107-184`) and `KEY_ROWS` (`:186-240`) share 36 identical `id`/`label`/`group`
rows, verbatim including trailing comments.

```
$ awk 'NR>=100 && NR<=300' src/components/SettingsDialog.tsx \
    | grep -o "id: '[a-z.]*'" | sort | uniq -c | awk '$1>1' | wc -l
36
```

And `fly_bandit` unpacks the flight-core state words into the bandit twice, eleven
lines each.

### 4.5 Lint, and why it is not noise

```
$ npx eslint .
  src/components/ServerList.tsx      31:17  warning  react-refresh/only-export-components
  src/components/SettingsDialog.tsx 841:14  warning  react-refresh/only-export-components
✖ 2 problems (0 errors, 2 warnings)
$ npx eslint . --max-warnings=0 ; echo "exit=$?"
exit=1
```

`ServerList.tsx:31` is pre-existing and identical to `main`. `SettingsDialog.tsx:841`
arrived with `d38b83d8`. Neither is a runtime defect — both say the file exports
something alongside its component, so Fast Refresh full-reloads instead of
hot-swapping. Dev-experience only, **but they fail the CI gate**.

### 4.6 tsc and CI — four separate answers

**Does tsc pass?** Yes. `npx tsc -b --noEmit` → exit 0, 19.0 s.

**Does it cover the hot path?** No. `engine.ts` line 1 is `// @ts-nocheck`.

```
$ grep -rl '@ts-nocheck' src/ | xargs wc -l
    77 src/routeTree.gen.ts
  7179 src/game/engine.ts
```

7,179 of 21,361 source lines — 34% of the app, and exactly the 34% this audit is
about — are exempt. A clean `tsc` says nothing about the engine.

**Does CI run it before the tests?** No — CI never runs it.
`.github/workflows/frontend-lint.yml` delegates to
`mochi-os/web/.github/workflows/reusable-frontend-lint.yml`, whose steps are:
install → `pnpm lint --max-warnings=0` → `pnpm test` → four i18n checks. `tsc`
only runs inside `pnpm build`, which CI does not invoke. The local and release
path does gate on it: `make app-air` → `pnpm run build` → `tsc -b && vite build`.

**Does the test step get reached?** No. Lint exits 1 and runs first. **The 304
tests have not run in CI on this branch.** Same failure shape as lib/web. Locally:

```
$ npx vitest run
 Test Files  22 passed (22)
      Tests  304 passed (304)
   Duration  4.71s
```

### 4.7 Coverage

```
$ npx vitest run --coverage --coverage.provider=v8 \
    --coverage.include='src/game/**' --coverage.include='src/lib/**'
```

| file | % stmts | % branch | % funcs | % lines |
|---|---:|---:|---:|---:|
| **All files** | **9.16** | **7.82** | **14.98** | **14.53** |
| `game/engine.ts` | **0** | **0** | **0** | **0** |
| `game/audio.ts` | 0 | 0 | 0 | 0 |
| `game/model.ts` | 0 | 0 | 0 | 0 |
| `game/bench.ts` | 0 | 0 | 0 | 0 |
| `lib/config-store.ts` | 0 | 0 | 0 | 0 |
| `game/flight.ts` | 9.72 | 0 | 0 | 13.97 |
| `game/keys.ts` | 18.75 | 21.42 | 100 | 18.18 |
| `game/net.ts` | 26.31 | 17.82 | 23.52 | 28.44 |
| `game/head.ts` | 32.14 | 20.51 | 50 | 38.23 |
| `game/rwr.ts` | 88.33 | 92.3 | 80 | 88.46 |
| `game/cbor.ts` | 91.35 | 88.63 | 100 | 94.31 |
| `game/weapons.ts` | 92.41 | 71.42 | 100 | 98.01 |
| `game/radar.ts` | 94.54 | 90.69 | 95.23 | 97.01 |
| `game/stores.ts` | 95.16 | 87.66 | 92.85 | 95.8 |
| `game/acmi.ts` | 97.29 | 92.42 | 88.88 | 98.24 |
| `game/framing.ts` | 100 | 95.83 | 100 | 100 |
| `game/pipper.ts` | 100 | 66.66 | 100 | 100 |
| `game/servers.ts` | 100 | 87.5 | 100 | 100 |

**On the hot path: zero.** `engine.ts` is 0% on all four metrics.

**What the 9.16% excludes:** `src/components/**` and `src/routes/**` were outside
the include globs, so no React component has a measured figure. Nothing inside the
included set is excluded. The number is also not a fair summary of the project's
testing — seven extracted modules are above 90%. **The 9.16% is one file.**

### 4.8 Tests that assert nothing

**None found.** Four scans: all-weak-assertion blocks; textually identical
actual/expected; assertions built from identifiers imported from the unit under
test (33 hits, all reviewed, all legitimate); assertions in loops over
possibly-empty collections (8 hits, all over non-empty literals or length-guarded).

**The two remembered tautologies were real and `0bb3ac7e` already fixed them.** The
file now carries the comments naming them — *"LITERALS, not REACH_FLOOR and
REACH_CLEAR: deriving the expectation from the constants under test makes the
assertion move with the bug"*, and *"Written first as REACH_CLEAR / (REACH_CLEAR -
1), which is Infinity at REACH_CLEAR = 1 and so passed against the exact mutation
it was written to catch."*

Three weak-but-not-vacuous assertions remain: `steer.test.ts:51`
(`toBeGreaterThanOrEqual(0)` on pitch — passes if the channel is dead);
`steer.test.ts:418-421` (`gain_at(d, 4000)` — the clearance multiple never binds
at range 4000, so both bounds pass with `REACH_CLEAR` set to 0);
`radar.test.ts:42` (expected derived from the function's own other output times
the implementation's own 0.65 — cannot catch a change that scales both).

---

## 5. Correctness risks

**The governor's stale window.** §1.2. *Certain, simulated across all 180 phases.*

**The 18 ms threshold is a 60 Hz constant with no panel behind it.** §1.3–1.4.
Live today, condemns 50 Hz panels permanently, and leaves 144 Hz panels
ungoverned down to 56 fps. *High — the code's own `bench.ts:47-56` predicts it and
the steady-state table confirms it.*

**Light churn invalidates every shader program.** §3.4. *High on mechanism,
unmeasured on cost.*

**The shadow map renders every frame into a box containing neither the carrier nor
the runway.** §3.4. *High on the geometry, inference on the visual consequence.*

**The caution stack does not reach every view.** The uncommitted change adds
`caution_stack()` to `draw_chase` with the comment *"so every view shows the same
set"*, but `draw_hud` still returns early for any view that is not `hud`,
`cockpit` or `chase`. `flypast` and `ddi` still show a burning jet with nothing
said about it. The fix is right; the claim over-reaches by two views. *High.*

**The new JHMCS box is bound to the wrong camera.** `draw_jhmcs` projects through
`proj_point`, which uses `camera`; cockpit view renders its near pass with
`cockpit_cam`. They agree today because position, quaternion, fov and aspect are
copied across every frame. It becomes a real bug the moment `cockpit_cam` gains
any offset of its own, which is the reason it exists as a separate camera.
*Medium. Not a live bug.*

**The knip script has never audited air.**
`"knip": "pnpm -C ../../.. exec knip --workspace apps/help/web"`. It also cannot
run at all — `npx knip` → `knip: not found`. *Certain.*

**Two labels that do not match their maths, and an orphaned comment.** `[27]` of
30 sorted is p93 (commented p90); `s[Math.floor(180*0.99)]` is the second-worst of
180 (labelled "1% low"); `// ---- catapult prompt ----` now sits above the JHMCS
call. *Certain, cosmetic.*

---

## Ranked findings

Ranked by impact over effort.

| # | finding | evidence | est. impact | est. effort | confidence |
|---:|---|---|---|---|---|
| 1 | 18 ms drop threshold is hardcoded for 60 Hz — 50 Hz panels ratchet to the 0.45 floor and take a permanent "cannot hold it" verdict; 144 Hz panels are ungoverned down to 56 fps | steady-state table, §1.3; `bench.ts:47-56` predicts it | wrong render scale for every non-60 Hz player, and `dyn_res: true` by default | derive from a monotone panel estimate, §1.4 | high |
| 2 | `dynamic_res` reads `ft_ring.slice(-30)` from a ring buffer — transient-blind and late | phase sweep, §1.2: 0.5 s hitch missed at 78% of phases; 5 s overload median 2.60 s / worst 5.22 s late | governs the whole dyn-res feature | 1 line, or the §1.6 module | certain |
| 3 | Every explosion adds and removes a `PointLight`, changing the three.js program cache key and relinking every lit material | `transient_blast` / `update_transient_fx` quoted, §3.4 | a compile stall mid-merge; ms unmeasured | pool the lights, ~15 lines | high on mechanism, cost unmeasured |
| 4 | CI lint gate fails, so 304 tests never run | `eslint . --max-warnings=0` → exit 1; lint precedes tests | quality only, but the suite is dark | move 2 exports | certain |
| 5 | Shadow map re-renders every frame into a ±800 m box at the world origin; carrier is 20 km away, runway 3.1 km | §3.4, all four constants quoted | a full 1024² depth pass per frame — **but `shadows: false` by default, so high/ultra presets only** | needs `acc_shadow` first — see §3.4 | high on geometry, unknown on what is inside the box |
| 6 | `bench.ts` reports no p99 and no max | `finish()` field list | unblocks §1 | 3 lines | certain |
| 7 | Only one phase instrumented (`acc_submit`) | sole wrapper in the file | unblocks §1 | ~10 lines | certain |
| 8 | `knip` script audits `apps/help/web`, and knip is not installed | `package.json`; `npx knip` → not found | quality only | 1 line + install | certain |
| 9 | Pitch ladder: 72 Vector3/frame floor, ~282 objects/frame ceiling, 0.50–0.86 MB/s = 20–34% of the recorded total | branch derivation §2.2, arithmetic §2.4 | ~24% of allocation; CPU cost unmeasured | half a day | count derived, cost unmeasured |
| 10 | `matrixAutoUpdate` never disabled — every static mesh recomposes its matrix per frame | `grep autoUpdate` → nothing | unmeasured, scales with graph size | 1 line per static branch | certain that it is on, size unmeasured |
| 11 | Whole HUD repainted every frame through `shadowBlur=3` | §3.3 counts; canvas 5120×2880 at dpr 2 | plausibly large; unmeasured | medium | counts measured, ms not |
| 12 | Caution stack claim covers 5 views, code covers 3 | `draw_hud` early return | quality only | 1 line | high |
| 13 | 21 `dev_*` hooks + the bench harness ship to production | bundle grep | part of 129,420 B gz | medium | certain |
| 14 | `SettingsDialog.tsx` duplicates 36 binding rows verbatim | awk count = 36 | quality only | small | certain |
| 15 | 8 dead value-level exports | `dead.mjs` | quality only | small | certain |
| 16 | `engine.ts` is one 7,108-line function, cx 4,348 | `fnstats.mjs` | 0% of the hot path is testable | large | certain |
| 17 | `engine.ts` is `@ts-nocheck` — 34% of source unchecked | line 1; 7179/21361 | quality only | large | certain |
| 18 | CI never runs `tsc` | workflow step list | quality only | 1 step | certain |
| 19 | JHMCS box projected through `camera`, not `cockpit_cam` | `proj_point` vs the near pass | latent only | small | medium |
| 20 | glTF strip ×3, `net.ts` POST ×3, `fly_bandit` unpack ×2 | `dup.mjs` | quality only | small | certain |
| 21 | Three weak assertions | `steer.test.ts:51`, `:418-421`; `radar.test.ts:42` | quality only | small | high |
| 22 | p90/p93 and "1% low" mislabels, orphaned catapult comment | three sites | quality only | trivial | certain |

**Findings 1 and 2 are independent and can ship separately.** Revision 2 claimed
they had to ship together; §1.3 retracts that with the per-refresh-rate working.
A fresh window is not a regression at any refresh rate. What a window-only commit
must do is say in its body that it does not fix the threshold.

---

## Fix now — cheap and measurable

1. **The threshold and the window, as one commit**, via the `governor.ts` module
   in §1.6. The window fix is one line; deriving the thresholds from
   `cadence().beat` is ten; the module makes both permanently testable in node
   with no browser, and the 60 Hz table test proves the change is
   behaviour-preserving on the panel everyone has been testing on.
2. **Pool the blast lights.** Cheapest plausible fix for a real merge-time spike,
   and it matches the pooling this codebase already does for missiles and debris.
3. **p99 and max in `bench.ts`.** Three lines, and every remaining frametime
   question depends on them.
4. **`acc_hud`, `acc_step`, `acc_input`, `acc_shadow`.** Four accumulators in the
   `acc_submit` pattern. `acc_shadow` is the one that answers §3.4's shadow
   question directly.
5. **The `knip` script**, and install knip.
6. **The two lint warnings.** Move `HEAD_MESSAGES` and the `ServerList` constant
   into their own modules. This is what turns CI back on.
7. **The two mislabels and the orphaned comment.** Each is currently telling the
   next reader something false.

## Worth quoting as its own piece of work

1. **Get a browser onto the measurement path.** Everything under **Unmeasured**
   collapses into one afternoon once Chromium plus the existing
   `?developer=1&bench=` harness can run. Items 3 and 4 above land first so the
   run produces a complete report — and `renderer.info.programs.length` over a
   fight is the direct test of finding 3.
2. **The pitch-ladder allocation pass.** ~24% of measured allocation from one
   loop, all removable, no visual change. Worth a measured before/after rather
   than faith.
3. **The HUD repaint.** Two questions: what `shadowBlur=3` costs across 57
   `fillText` calls at 5120×2880, and whether the static furniture can go to a
   cached layer the way the DDI faces already do. Needs `acc_hud` first.
4. **The shadow pass.** `acc_shadow` first, then a look at what actually renders
   into the ±800 m box, then a choice between moving the camera and freezing the
   map. Default-off shadows mean this is a high/ultra-preset question, not a
   default-experience one.
5. **`matrixAutoUpdate` on the static scene graph.** Needs the object count from a
   browser before it can be sized, then it is mechanical.
6. **Breaking up `startGame`.** Not a refactor for its own sake — it is the only
   thing between the engine and any test at all, and it is why `@ts-nocheck` has
   survived. `governor.ts` is the first slice and a good test of the approach.

## Leave alone

- **The 50 ms clamp on `dt`.** Correct, and the reasoning above `perf_ring` is
  right. The readout already reads the true ring. The problem was never the clamp.
- **`frustumCulled = false` on the 13 objects.** Sky and ocean are always in view;
  the rest are screen-space lamps that would pop at the frustum edge. Each carries
  a comment explaining itself.
- **The DDI faces and corner insets.** Already cached at 120 ms with per-key
  offscreen canvases.
- **The render targets.** Created once, resized on change.
- **The two cockpit render passes and the five cloud passes.** Both deliberate,
  both documented.
- **The 28 type-only dead exports.** Exporting an interface for documentation is
  not dead code.
- **The `<Select…>` markup repetition.** Three occurrences of a four-line Radix
  shape is what the library looks like.
- **`draw_chase`.** Measured at zero closures and zero THREE allocations. The one
  part of the draw path that already does what the comment above it claims.
- **The seven well-covered extracted modules.** All above 90% with sound tests.
  The 9.16% headline is one file.

---

## Coverage of this audit

**Reviewed:** `src/game/**` (all 22 modules, plus `engine.ts` in full for the
frame loop, HUD, allocation, scene-graph and dead-code passes), `src/lib/**`,
`SettingsDialog.tsx`, `MissionSetup.tsx`, `GameCanvas.tsx`, `ServerList.tsx`, all
22 test files, `package.json`, `vite.config.ts`, `knip.config.ts`,
`.github/workflows/**`, and `lib/web/.github/workflows/reusable-frontend-lint.yml`.

**Not reviewed:** `air.star`, `app.json` (server side), `src/locales/**` (97
catalogs, no bearing on frametime), `tools/**`, `midway-prep/**`.

**Could not verify:** every live runtime figure — frametime distribution, phase
breakdown, spike attribution, GC pause frequency and duration, allocation bytes,
draw calls, triangles, texture memory, program-switch counts, scene-graph object
count, the cost of the HUD's shadow blur, the cost of the per-frame shadow pass,
and the cost of a light-count shader relink. One cause: no browser on this host
and no dev server permitted. All of it is reachable through `bench.ts` once that
changes.
