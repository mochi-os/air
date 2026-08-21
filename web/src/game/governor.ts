// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The dynamic-resolution governor's arithmetic, extracted so it can be tested
// without a GPU. No THREE, no DOM, no engine imports: everything here is a pure
// function of numbers, which is the whole point — the two bugs it exists to
// prevent are both arithmetic, and neither needs a browser to catch.
//
// ---- Bug one: the window ----------------------------------------------------
//
// engine.ts keeps frame times in a 180-slot RING with a rotating write index,
// and reads the governor's window with `ft_ring.slice(-30)`. slice(-30) returns
// array positions 150-179 whatever the write index is, so the governor reads a
// fixed slot that refreshes once per 180 frames rather than the last 30 frames.
// Measured consequence: a 0.5 s hitch is invisible at 78% of ring phases, and a
// sustained 5 s overload is caught a median 2.6 s late (worst 5.2 s) against a
// governor that ticks every 0.5 s. recent_window is the correct read.
//
// ---- Bug two: the budget ----------------------------------------------------
//
// The thresholds 18 / 17.2 / 17.5 ms are 60 Hz numbers, and they are exact
// multiples of the 60 Hz frame period: 16.667 x 1.080, x 1.032, x 1.050. On a
// 50 Hz panel a PERFECTLY vsynced frame is 20 ms, already past the 18 ms drop
// threshold, so the governor ratchets the render scale to its 0.45 floor and
// then writes the "this machine cannot hold it" verdict — and under vsync
// cutting pixels cannot bring the frame in under the panel period, so the raise
// arm (which needs < 17.2) can never fire and the verdict is permanent. The
// same constant leaves a 144 Hz panel ungoverned all the way down to 56 fps.
// budget() derives all three from the panel period instead.
//
// ---- Why the budget must NOT read the current frame rate --------------------
//
// This is the trap, and it is the reason Panel exists rather than budget()
// simply taking a measured beat.
//
// The governor CONTROLS the frame interval. Deriving its threshold from the
// measured frame interval is a control loop reading its own output as its
// setpoint. Concretely: a 60 Hz machine struggling at 30 fps sits on half-rate
// vsync, so every frame is 33.3 ms and the modal beat is a rock-solid 33.5 with
// a high locked share — indistinguishable, from the deltas alone, from a
// genuine 30 Hz panel. A budget derived from that becomes drop-above-36 ms, and
// the governor stops governing on precisely the machine that needs it most. The
// worse it gets, the more permissive the threshold gets.
//
// So the panel estimate is MONOTONE: it narrows freely and never widens on the
// strength of a loaded measurement. That is the safety property, and it holds
// by construction rather than by tuning — no sequence of frame samples, however
// adversarial, can relax the budget.
//
// Widening needs evidence that cannot be manufactured by load:
//
//   - `declared` — screen.refreshRate, where the browser exposes it. It is
//     non-standard and usually absent, so it cannot be the primary source, but
//     when present it is authoritative and overrides everything.
//   - an `idle` sample — taken in a state the app knows is cheap. The menu
//     backdrop is the natural seam: the frame loop is already running there and
//     drawing almost nothing, so a beat measured in the menu is the panel's own
//     period with very high confidence, before any mission load exists to
//     confound it.
//
// And even an idle sample has to clear the half-rate test. Under vsync every
// delta is an integer multiple of the panel period, so a candidate that is an
// exact multiple of what we already believe (33.3 = 2 x 16.667, 50.0 = 3 x) is
// exactly the ambiguous case and is refused. A candidate that is NOT a multiple
// (20.0 is 1.2 x 16.667) can only have come from a different panel, so it is
// accepted. That is what lets a real 50 Hz display be recognised while half-rate
// vsync on a 60 Hz display is not.
//
// KNOWN LIMITATION, stated rather than hidden: a 50 Hz machine already
// overloaded in the MENU seeds wrong and keeps the 60 Hz budget. The menu draws
// a near-empty scene so this is unlikely, and screen.refreshRate covers it where
// the browser provides it, but it is a real hole and not a theoretical one.
//
// ---- Convergence, and why narrowing is not persisted ------------------------
//
// narrow() is pure; the caller holds the Panel. What the caller should do with
// it depends on how fast each case converges, and the cases are not alike.
//
// NARROWING needs no idle sample — it is accepted from any locked reading — so
// a 144, 120, 90 or 75 Hz panel converges on the first cadence sample of every
// session, in seconds. It should NOT be persisted: it is cheap to re-derive,
// and a stale narrow is the harmful direction (too tight a budget pins the
// render scale at the 0.45 floor, and the raise arm then cannot lift it).
//
// WIDENING is the slow case, and worse than it first looks. There is no idle
// frame before the first mission: start_mission() sets running = true at module
// load, so the menu backdrop path (!running) is only reached AFTER a mission
// ends. The loading screen is cheap to DRAW but the main thread is busy parsing
// GLBs and compiling wasm, so it is not idle in the sense that matters. A 50 Hz
// player therefore gets no usable idle sample until their first mission is over.
//
// So a widened estimate SHOULD be persisted, or it never helps the session that
// earned it — with two guards, because persistence is what makes a bad reading
// permanent: `declared` is authoritative and can be stored on sight, and an
// idle measurement needs two agreeing samples before it is written.
//
//   panel                      converges
//   144 / 120 / 90 / 75 Hz     first locked sample, every session
//   50 Hz, refreshRate present  first sample, every session
//   50 Hz, no refreshRate       after the first mission ends, then persisted
//   anything else               never — and "never" is today's behaviour
//
// ---- The default is the bug ------------------------------------------------
//
// PANEL_DEFAULT is 16.667 ms, so the fallback budget is 18.00 / 17.20 / 17.50 —
// exactly the hardcoded constants this module exists to replace. That is the
// right default: it makes adopting the module provably behaviour-neutral on the
// 60 Hz panels every existing measurement was taken against. But it means the
// 144 Hz half of the problem stays live until a client actually narrows, and
// the 50 Hz half stays live for a client that never widens. Wiring the module
// in is not the same as fixing the finding, and neither is landing it.

export const RING = 180 // frame-time ring slots, matching engine.ts
export const WINDOW = 30 // frames the governor judges on
export const DEFAULT_PERIOD = 1000 / 60 // ms, the assumed panel period

// The historic constants, as multiples of the panel period. Pinned by test:
// at DEFAULT_PERIOD these reproduce 18.00 / 17.20 / 17.50 exactly, so deriving
// the budget changes nothing on the 60 Hz panels everything was tuned against.
export const DROP = 1.08 // drop the scale above this multiple of the period
export const RAISE = 1.032 // raise it below this multiple
export const SPIKE = 1.05 // ...and only if the tail is under this multiple

export interface Budget {
  drop: number
  raise: number
  spike: number
}

export type PanelSource = 'default' | 'declared' | 'idle' | 'narrowed'

export interface Panel {
  readonly period: number
  readonly source: PanelSource
}

export const PANEL_DEFAULT: Panel = {
  period: DEFAULT_PERIOD,
  source: 'default',
}

export interface Sample {
  /** Modal frame delta in ms — bench.ts cadence().beat. */
  beat: number
  /** Share of frames sitting on that mode, 0..1 — bench.ts cadence().locked. */
  locked: number
  /** True only for a sample taken in a state the app knows is cheap. */
  idle: boolean
  /** screen.refreshRate as a PERIOD in ms, or null when unavailable. */
  declared: number | null
}

// Below LOCKED_MIN the client is not vsynced to anything and the modal beat
// says nothing about the panel.
const LOCKED_MIN = 0.6

// How close a candidate has to be to an exact multiple of the believed period
// to count as half/third/quarter rate. bench.ts buckets the beat to 0.5 ms, so
// a true 2x reads 33.5 against a 33.333 ideal — 0.167 out. The tolerance has to
// clear one bucket without being wide enough to swallow 20 ms, which sits
// 3.33 ms from the nearest multiple of 16.667.
const MULTIPLE_TOL = 0.4

// True when `beat` is an integer multiple of `period` within tolerance, 1x
// INCLUDED. Both cases mean the same thing — no evidence of a different panel:
// 1x is measurement jitter on the panel we already believe in, and 2x/3x/4x is
// rate division under load. Accepting either would loosen the budget for free.
// (k >= 1 is a floor guard only. narrow() returns before calling this whenever
// the beat is meaningfully shorter than the period, so k is never 0 in practice.)
//
// DO NOT change this back to k >= 2. It was written that way — the half-rate
// case is the one the design argument is about, and 1x looks like it cannot
// matter. It does: with k >= 2 an idle beat of 16.9 ms on a 60 Hz panel is not a
// multiple of anything, so it is accepted as a NEW panel, and the drop threshold
// silently widens from 18.00 to 18.25 on nothing but measurement noise. Every
// later reading is then judged against a budget derived from jitter.
//
// Neither derivation nor 100% branch coverage caught this. Mutation did: with
// k >= 2 in place, flipping it to k >= 1 killed no test, which is what exposed
// the guard as undefended and then as wrong. The test that pins it is
// 'refuses a beat just ABOVE the period — 1x is jitter, not a new panel'.
function is_multiple(beat: number, period: number): boolean {
  const k = Math.round(beat / period)
  return k >= 1 && Math.abs(beat - k * period) <= MULTIPLE_TOL
}

/**
 * The last `window` frame times from a ring buffer whose NEXT write index is
 * `next`, oldest first. This is the read engine.ts gets wrong: slice(-window)
 * returns a fixed set of array positions and is correct only when the write
 * index happens to be 0 — 1 ring phase in 180.
 */
export function recent_window(
  ring: readonly number[],
  next: number,
  window: number = WINDOW
): number[] {
  const n = ring.length
  const w = Math.min(window, n)
  const out = new Array<number>(w)
  // + 2n keeps the modulo positive for any next in [0, n) and any w <= n.
  for (let i = 0; i < w; i++) out[i] = ring[(next - w + i + 2 * n) % n]
  return out
}

/** The three thresholds, as multiples of the panel's own refresh period. */
export function budget(panel: Panel): Budget {
  const p = panel.period
  return { drop: p * DROP, raise: p * RAISE, spike: p * SPIKE }
}

/**
 * Fold one cadence sample into the panel estimate.
 *
 * Monotone by construction: narrowing is always accepted, widening never is
 * unless the evidence cannot have been manufactured by load. See the header —
 * this is the whole defence against the governor reading its own output.
 *
 * DELIBERATE COST: a genuine 30 Hz panel reads as exactly 2x the 60 Hz default
 * and is refused, so it keeps the 60 Hz budget and gets condemned the same way
 * 50 Hz panels are today. 30 Hz displays are rare and screen.refreshRate is the
 * escape hatch. Half-rate vsync on the common panel is the more likely case and
 * the more damaging one to get wrong, so it wins the ambiguity.
 */
export function narrow(panel: Panel, s: Sample): Panel {
  if (s.declared !== null && s.declared > 0) {
    return { period: s.declared, source: 'declared' }
  }
  if (!(s.beat > 0) || s.locked < LOCKED_MIN) return panel
  // Narrowing is always safe: it can only make the governor more eager, and it
  // returns BEFORE the multiple test on purpose. Half-rate vsync is always
  // SLOWER than the panel, never faster, so a shorter beat cannot be a rate
  // -division artifact — a real 120 Hz panel reads 8.333, exactly half of the
  // 60 Hz default, and must be accepted rather than refused as a "multiple".
  // The multiple guard is widening-only.
  //
  // The MULTIPLE_TOL band is hysteresis: a beat within a bucket of the believed
  // period is the same panel jittering, and ratcheting the estimate down on
  // every noisy sample would walk it away from the truth.
  if (s.beat < panel.period - MULTIPLE_TOL) {
    return { period: s.beat, source: 'narrowed' }
  }
  // Widening needs a sample taken somewhere load cannot reach.
  if (!s.idle) return panel
  if (is_multiple(s.beat, panel.period)) return panel
  return { period: s.beat, source: 'idle' }
}

export interface Cadence {
  /** The modal frame delta in ms — the panel's period when the client is vsynced. */
  beat: number
  /** Share of frames within 1.5 ms of the mode, 0..1. */
  locked: number
  /** The beat as a rate in Hz, or 0 when there is no beat. */
  refresh: number
}

/**
 * Read the display's own beat out of a list of frame deltas.
 *
 * A vsynced client cannot outrun the panel, so its deltas pile up on the
 * refresh period, and on multiples of it whenever a frame is missed. The mode
 * of a 0.5 ms histogram is that period, and the share of frames sitting on it
 * says whether the client is locked to the panel at all — a low share means the
 * deltas are spread, which is either an unsynced client or genuine stutter, and
 * the median/p95 split tells those two apart.
 *
 * Moved here from bench.ts unchanged. It lived inside that module's
 * developer-mode guard, so it existed only under ?developer=1 and could be
 * neither tested nor reused. It is a pure function of an array of numbers and
 * belongs with the rest of the governor's arithmetic.
 *
 * Read it from the TRUE frame times, never the clamped ones: engine.ts clamps
 * dt at 50 ms, and a ring full of clamped hitches would report a 20 Hz beat.
 */
export function cadence(list: readonly number[]): Cadence {
  const bucket = new Map<number, number>()
  for (const d of list) {
    const key = Math.round(d * 2) / 2
    bucket.set(key, (bucket.get(key) || 0) + 1)
  }
  let mode = 0
  let best = 0
  for (const [key, n] of bucket) if (n > best) { best = n; mode = key }
  const near = list.filter((d) => Math.abs(d - mode) <= 1.5).length
  return {
    beat: mode,
    locked: +(near / (list.length || 1)).toFixed(2),
    refresh: mode > 0 ? +(1000 / mode).toFixed(1) : 0,
  }
}

/** Widest and narrowest periods worth believing: 240 Hz to 24 Hz. */
const PERIOD_MIN = 1000 / 240
const PERIOD_MAX = 1000 / 24

/**
 * Rebuild a panel estimate from persisted storage.
 *
 * Only a WIDENED estimate is ever persisted, and the asymmetry is deliberate.
 * A narrowed estimate is re-derived from the first locked sample of every
 * session, in seconds, so persisting it buys nothing — and a stale narrow is
 * the harmful direction, because too tight a budget pins the render scale at
 * the 0.45 floor, which is exactly where the raise arm cannot lift it back.
 * A widen is the opposite: it can only be earned from an idle sample, the
 * engine has no idle frame before the first mission (start_mission sets
 * running = true at module load, so the menu backdrop is only reached after a
 * mission ENDS), and without persistence it would never help the session that
 * measured it.
 *
 * The source is reported as 'declared' because a value that survived the widen
 * guards and this range check is trusted the same way screen.refreshRate is.
 * Anything outside 240 Hz to 24 Hz is not a panel, it is a corrupted or
 * hand-edited key, and the caller gets the default instead.
 */
export function restore(period: unknown): Panel {
  const n = typeof period === 'number' ? period : parseFloat(String(period))
  if (!Number.isFinite(n) || n < PERIOD_MIN || n > PERIOD_MAX) return PANEL_DEFAULT
  return { period: n, source: 'declared' }
}
