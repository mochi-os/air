// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PERIOD,
  cadence,
  PANEL_DEFAULT,
  RING,
  WINDOW,
  budget,
  narrow,
  recent_window,
  restore,
  type Panel,
  type Sample,
} from './governor'

// ---------------------------------------------------------------------------
// 1. The window. This is the regression guard for engine.ts's ft_ring.slice(-30):
//    a ring buffer read at a fixed array position instead of at the write index.
//    Every value written is distinct and increasing, so a wrong window cannot
//    coincidentally match a right one.
// ---------------------------------------------------------------------------

// Write `count` distinct increasing values into a RING-slot ring and return the
// ring plus the NEXT write index, exactly as engine.ts maintains ft_i.
function fill(count: number): { ring: number[]; next: number } {
  const ring = new Array(RING).fill(0)
  let next = 0
  for (let k = 1; k <= count; k++) {
    ring[next] = k
    next = (next + 1) % RING
  }
  return { ring, next }
}

describe('recent_window reads the last N frames at every ring phase', () => {
  it('returns the last WINDOW values written, in write order, at all 180 phases', () => {
    const wrong: number[] = []
    for (let phase = 0; phase < RING; phase++) {
      // RING + phase writes: every slot has been written at least once and the
      // next write index lands on `phase`.
      const total = RING + phase
      const { ring, next } = fill(total)
      expect(next).toBe(phase % RING)
      const want = Array.from({ length: WINDOW }, (_, i) => total - WINDOW + 1 + i)
      const got = recent_window(ring, next)
      if (JSON.stringify(got) !== JSON.stringify(want)) wrong.push(phase)
    }
    expect(wrong, `wrong at ${wrong.length} of ${RING} ring phases`).toEqual([])
  })

  it('never returns a slot that has not been written yet', () => {
    // Only WINDOW + 5 frames in: the rest of the ring is still zero-filled, and
    // a correct read must not reach into it.
    const { ring, next } = fill(WINDOW + 5)
    expect(recent_window(ring, next)).not.toContain(0)
  })

  it('honours a shorter window', () => {
    const { ring, next } = fill(RING + 77)
    expect(recent_window(ring, next, 3)).toEqual([RING + 75, RING + 76, RING + 77])
  })
})

// ---------------------------------------------------------------------------
// 2. The budget. The 60 Hz row is the behaviour-preservation contract: deriving
//    the thresholds must reproduce the historic hardcoded 18 / 17.2 / 17.5 that
//    every existing measurement was taken against.
// ---------------------------------------------------------------------------

describe('budget derives the thresholds from the panel period', () => {
  // hz, drop, raise, spike — LITERALS, not DROP * period. Deriving the
  // expectation from the multipliers under test would make it move with the bug.
  const TABLE: [number, number, number, number][] = [
    [144, 7.5, 7.1667, 7.2917],
    [120, 9.0, 8.6, 8.75],
    [90, 12.0, 11.4667, 11.6667],
    [75, 14.4, 13.76, 14.0],
    [60, 18.0, 17.2, 17.5],
    [50, 21.6, 20.64, 21.0],
  ]

  for (const [hz, drop, raise, spike] of TABLE) {
    it(`${hz} Hz: drop ${drop}, raise ${raise}, spike ${spike}`, () => {
      const b = budget({ period: 1000 / hz, source: 'declared' })
      expect(b.drop).toBeCloseTo(drop, 3)
      expect(b.raise).toBeCloseTo(raise, 3)
      expect(b.spike).toBeCloseTo(spike, 3)
    })
  }

  it('the 60 Hz row is exactly what engine.ts hardcodes today', () => {
    const b = budget(PANEL_DEFAULT)
    expect(b.drop).toBeCloseTo(18.0, 6)
    expect(b.raise).toBeCloseTo(17.2, 6)
    expect(b.spike).toBeCloseTo(17.5, 6)
  })
})

// ---------------------------------------------------------------------------
// 3. Half-rate vsync. The governor controls the frame interval, so the panel
//    estimate must never be widened by a loaded measurement — otherwise the
//    threshold relaxes on exactly the machine that needs it to tighten.
// ---------------------------------------------------------------------------

const loaded = (beat: number): Sample => ({
  beat,
  locked: 0.98,
  idle: false,
  declared: null,
})

describe('the panel estimate never widens under load', () => {
  it('a 60 Hz panel at half rate is still judged against a 16.667 ms budget', () => {
    // 33.3 ms with a rock-solid locked share: from the deltas alone this is
    // indistinguishable from a genuine 30 Hz panel, and it is what a 60 Hz
    // machine rendering at 30 fps looks like.
    const p = narrow(PANEL_DEFAULT, loaded(33.3))
    expect(p.period).toBeCloseTo(DEFAULT_PERIOD, 3)
    expect(budget(p).drop).toBeCloseTo(18.0, 3)
  })

  // idle: true on purpose. With idle: false the `!s.idle` early return catches
  // these before is_multiple is ever consulted, so a loaded version of this test
  // would pass whatever the multiple guard did — it would be testing the wrong
  // branch under the right name.
  it('refuses every integer multiple of the believed period, even from idle', () => {
    for (const mult of [2, 3, 4]) {
      const beat = DEFAULT_PERIOD * mult
      const p = narrow(PANEL_DEFAULT, { beat, locked: 0.98, idle: true, declared: null })
      expect(p.period, `${mult}x the period must not widen the estimate`).toBeCloseTo(DEFAULT_PERIOD, 3)
    }
  })

  it('refuses a bench-bucketed 2x beat, which reads 33.5 not 33.333', () => {
    // cadence() buckets to 0.5 ms, so a true half-rate frame never arrives as
    // the exact multiple. The tolerance has to clear one bucket.
    const p = narrow(PANEL_DEFAULT, { beat: 33.5, locked: 0.98, idle: true, declared: null })
    expect(p.period).toBeCloseTo(DEFAULT_PERIOD, 3)
  })

  it('no sequence of loaded samples can relax the budget', () => {
    let p: Panel = PANEL_DEFAULT
    for (const beat of [20, 33.3, 25, 50, 40, 66.7, 22.5, 100]) p = narrow(p, loaded(beat))
    expect(budget(p).drop).toBeLessThanOrEqual(18.0 + 1e-9)
  })

  it('narrows freely toward a faster panel', () => {
    const p = narrow(PANEL_DEFAULT, loaded(1000 / 144))
    expect(p.period).toBeCloseTo(1000 / 144, 3)
    expect(budget(p).drop).toBeCloseTo(7.5, 3)
  })

  it('accepts a real 50 Hz panel from an idle sample — 20 ms is not a multiple of 16.667', () => {
    const p = narrow(PANEL_DEFAULT, { beat: 20, locked: 0.98, idle: true, declared: null })
    expect(p.period).toBeCloseTo(20, 3)
    expect(budget(p).drop).toBeCloseTo(21.6, 3)
  })

  it('still refuses half rate even when the sample is idle', () => {
    const p = narrow(PANEL_DEFAULT, { beat: 33.3, locked: 0.98, idle: true, declared: null })
    expect(p.period).toBeCloseTo(DEFAULT_PERIOD, 3)
  })

  // 8.333 ms is EXACTLY half of the 16.667 default. If the multiple guard were
  // applied to narrowing this would be refused as a 2x artifact, which is
  // backwards: half-rate vsync is always slower than the panel, never faster.
  it('accepts a real 120 Hz panel, which is exactly half the default period', () => {
    const p = narrow(PANEL_DEFAULT, loaded(1000 / 120))
    expect(p.period).toBeCloseTo(1000 / 120, 3)
    expect(budget(p).drop).toBeCloseTo(9.0, 3)
  })

  it('ignores a beat that is not a positive number', () => {
    for (const beat of [0, -16.7, NaN]) {
      const p = narrow(PANEL_DEFAULT, { beat, locked: 0.98, idle: true, declared: null })
      expect(p.period, `beat ${beat} must not move the estimate`).toBeCloseTo(DEFAULT_PERIOD, 3)
    }
  })

  it('does not ratchet down on jitter inside one bench bucket', () => {
    // 16.4 is 0.27 below the default — noise on the same panel, not a faster one.
    const p = narrow(PANEL_DEFAULT, loaded(16.4))
    expect(p.period).toBeCloseTo(DEFAULT_PERIOD, 3)
  })

  it('refuses a beat just ABOVE the period — 1x is jitter, not a new panel', () => {
    // Without the 1x case in is_multiple this widens to 16.9, which quietly
    // loosens the drop threshold from 18.00 to 18.25 on measurement noise.
    const p = narrow(PANEL_DEFAULT, { beat: 16.9, locked: 0.98, idle: true, declared: null })
    expect(p.period).toBeCloseTo(DEFAULT_PERIOD, 3)
    expect(budget(p).drop).toBeCloseTo(18.0, 3)
  })

  it('a declared refresh rate overrides everything', () => {
    const p = narrow(PANEL_DEFAULT, { beat: 33.3, locked: 0.98, idle: false, declared: 20 })
    expect(p.period).toBeCloseTo(20, 3)
    expect(p.source).toBe('declared')
  })

  it('ignores a beat the client is not actually locked to', () => {
    const p = narrow(PANEL_DEFAULT, { beat: 9.1, locked: 0.11, idle: true, declared: null })
    expect(p.period).toBeCloseTo(DEFAULT_PERIOD, 3)
  })
})

// ---------------------------------------------------------------------------
// 4. cadence. Moved here from bench.ts, where it sat inside the developer-mode
//    guard and could not be tested or reused.
// ---------------------------------------------------------------------------

describe('cadence reads the panel beat out of the frame deltas', () => {
  it('finds the mode of a 0.5 ms histogram and the share locked to it', () => {
    const list = [...Array(90).fill(16.7), ...Array(10).fill(33.4)]
    const c = cadence(list)
    expect(c.beat).toBeCloseTo(16.5, 3)
    expect(c.locked).toBeCloseTo(0.9, 2)
    expect(c.refresh).toBeCloseTo(60.6, 1)
  })

  it('reports a low locked share when the deltas are spread', () => {
    const list = Array.from({ length: 100 }, (_, i) => 10 + i * 0.4)
    expect(cadence(list).locked).toBeLessThan(0.2)
  })

  it('survives an empty list without dividing by zero', () => {
    const c = cadence([])
    expect(c.beat).toBe(0)
    expect(c.locked).toBe(0)
    expect(c.refresh).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 5. restore. Only a WIDENED estimate is ever persisted, so this is the one
//    path where a bad value could outlive the session that produced it.
// ---------------------------------------------------------------------------

describe('restore rebuilds a persisted panel estimate safely', () => {
  it('accepts a plausible stored period', () => {
    expect(restore('20').period).toBeCloseTo(20, 3)
    expect(restore('20').source).toBe('declared')
  })

  it('falls back to the default for anything implausible', () => {
    for (const bad of [null, undefined, '', 'abc', '0', '-5', '2', '900', NaN])
      expect(restore(bad).period, `${String(bad)} must not be trusted`).toBeCloseTo(DEFAULT_PERIOD, 3)
  })

  it('accepts the ends of the believable range and rejects just outside them', () => {
    expect(restore(1000 / 240).period).toBeCloseTo(1000 / 240, 3) // 240 Hz
    expect(restore(1000 / 24).period).toBeCloseTo(1000 / 24, 3) // 24 Hz
    expect(restore(1000 / 241).period).toBeCloseTo(DEFAULT_PERIOD, 3)
    expect(restore(1000 / 23).period).toBeCloseTo(DEFAULT_PERIOD, 3)
  })
})
