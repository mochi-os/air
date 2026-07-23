// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { describe, it, expect } from 'vitest'
import { atc_step, ATC_ONSPEED, ATC_LEAST, ATC_MOST } from './atc'

// A toy backside-of-the-power-curve surrogate: thrust above the drag-balance
// point accelerates the jet, and alpha falls as speed rises (level flight at
// fixed lift). Crude, but it has the essential property the law must respect:
// MORE power LOWERS alpha. Constants chosen for on-speed at throttle 0.55.
function simulate(alpha0: number, seconds: number): { alpha: number; throttle: number; overshoot: number } {
  const dt = 1 / 60
  let speed = 70 - (alpha0 - ATC_ONSPEED) * 2.5 // slow when alpha high
  let throttle = 0.4
  let alpha = alpha0
  let previous = alpha0
  let overshoot = 0
  for (let t = 0; t < seconds; t += dt) {
    const rate = (alpha - previous) / dt
    previous = alpha
    throttle = atc_step(throttle, alpha, rate, dt)
    const accel = (throttle - 0.55) * 3.5 - (speed - 70) * 0.05 // thrust minus speed-stable drag trim
    speed += accel * dt
    alpha = ATC_ONSPEED - (speed - 70) / 2.5 // level-flight alpha falls with speed
    overshoot = Math.max(overshoot, Math.abs(alpha - ATC_ONSPEED))
  }
  return { alpha, throttle, overshoot }
}

describe('atc_step', () => {
  it('adds power when slow (alpha above on-speed) — the backside sign', () => {
    expect(atc_step(0.5, ATC_ONSPEED + 2, 0, 1 / 60)).toBeGreaterThan(0.5)
  })

  it('reduces power when fast (alpha below on-speed)', () => {
    expect(atc_step(0.5, ATC_ONSPEED - 2, 0, 1 / 60)).toBeLessThan(0.5)
  })

  it('damps against a rising alpha it is already correcting', () => {
    // alpha above on-speed but falling fast: the rate term backs the correction off
    const withRate = atc_step(0.5, ATC_ONSPEED + 1, -4, 1 / 60)
    const withoutRate = atc_step(0.5, ATC_ONSPEED + 1, 0, 1 / 60)
    expect(withRate).toBeLessThan(withoutRate)
  })

  it('clamps to the spool floor and the MIL ceiling — never afterburner', () => {
    expect(atc_step(1.0, ATC_ONSPEED + 5, 0, 1)).toBe(ATC_MOST)
    expect(atc_step(0.0, ATC_ONSPEED - 5, 0, 1)).toBe(ATC_LEAST)
  })

  it('converges a slow entry onto on-speed without divergent oscillation', () => {
    const r = simulate(ATC_ONSPEED + 2.5, 30)
    expect(Math.abs(r.alpha - ATC_ONSPEED)).toBeLessThan(0.3)
  })

  it('converges a fast entry onto on-speed', () => {
    const r = simulate(ATC_ONSPEED - 2.5, 30)
    expect(Math.abs(r.alpha - ATC_ONSPEED)).toBeLessThan(0.3)
  })

  it('spike-limits the rate input so a gust cannot slam the levers', () => {
    const calm = atc_step(0.5, ATC_ONSPEED, 10, 1 / 60)
    const spike = atc_step(0.5, ATC_ONSPEED, 500, 1 / 60)
    expect(spike).toBe(calm)
  })
})
