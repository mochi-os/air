// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { describe, expect, it } from 'vitest'
import { Euro, shape } from './head'

describe('shape', () => {
  it('holds still inside the deadzone', () => {
    expect(shape(0, 5, 2.4)).toBe(0)
    expect(shape(0.015, 5, 2.4)).toBe(0)
    expect(shape(-0.015, 5, 2.4)).toBe(0)
  })
  it('is symmetric and monotonic beyond it', () => {
    const gain = 5
    let last = 0
    for (let a = 0.03; a < 0.5; a += 0.02) {
      const out = shape(a, gain, 2.4)
      expect(out).toBeGreaterThan(last)
      expect(shape(-a, gain, 2.4)).toBeCloseTo(-out, 10)
      last = out
    }
  })
  it('amplifies: a comfortable head turn sweeps the full view', () => {
    // ~25° of real head yaw must reach beyond 120° of view with default gain.
    expect(shape(25 * Math.PI / 180, 5, 2.4)).toBeGreaterThan(2.0)
  })
  it('clamps at the view travel', () => {
    expect(shape(1.2, 5, 2.4)).toBe(2.4)
    expect(shape(-1.2, 5, 2.4)).toBe(-2.4)
  })
})

describe('Euro', () => {
  it('passes a constant through and converges onto steps', () => {
    const f = new Euro()
    expect(f.next(0.5, 1 / 30)).toBe(0.5)
    let out = 0.5
    for (let i = 0; i < 90; i++) out = f.next(0.8, 1 / 30)
    expect(out).toBeCloseTo(0.8, 2)
  })
  it('crushes jitter when still', () => {
    const f = new Euro()
    f.next(0, 1 / 30)
    let worst = 0
    for (let i = 0; i < 60; i++) {
      const noisy = (i % 2 === 0 ? 1 : -1) * 0.01 // ±0.57° sensor tremble
      worst = Math.max(worst, Math.abs(f.next(noisy, 1 / 30)))
    }
    expect(worst).toBeLessThan(0.004) // better than 2.5x quieter than the input
  })
  it('tracks fast motion with little lag', () => {
    const f = new Euro()
    let out = 0
    for (let i = 1; i <= 15; i++) out = f.next(i * 0.05, 1 / 30) // a brisk 0.75 rad sweep in half a second
    expect(out).toBeGreaterThan(0.55) // within ~25% of the moving target at speed
  })
  it('reset forgets the past', () => {
    const f = new Euro()
    f.next(1.0, 1 / 30)
    f.reset()
    expect(f.next(0.2, 1 / 30)).toBe(0.2)
  })
})
