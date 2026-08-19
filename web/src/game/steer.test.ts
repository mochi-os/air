// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { describe, it, expect } from 'vitest'
import { command, radius, GAINS, type Frame, type Vector } from './steer'

// LEVEL is the jet upright and pointing down -z, the engine's own convention
// (bearing is atan2(dx, -dz)). Every case below aims relative to this so the
// expected sign of each command is arguable from the geometry alone.
const LEVEL: Frame = {
  fwd: { x: 0, y: 0, z: -1 },
  up: { x: 0, y: 1, z: 0 },
  right: { x: 1, y: 0, z: 0 },
}

// at builds an aim direction `degrees` off the nose, rotated `clock` degrees
// around the boresight from straight up in the body frame. clock 0 = above,
// 90 = off the right wing, 180 = below.
function at(degrees: number, clock: number): Vector {
  const t = (degrees * Math.PI) / 180
  const c = (clock * Math.PI) / 180
  const across = Math.sin(t)
  return { x: across * Math.sin(c), y: across * Math.cos(c), z: -Math.cos(t) }
}

describe('command', () => {
  it('commands nothing when the target is already on the nose', () => {
    const out = command(LEVEL.fwd, LEVEL)
    expect(out.pitch).toBe(0)
    expect(out.roll).toBe(0)
    expect(out.yaw).toBe(0)
  })

  it('holds the deadzone, so a settled nose does not hunt', () => {
    const inside = command(at(0.4, 0), LEVEL) // 0.4° < the ~0.5° deadzone
    expect(inside.pitch).toBe(0)
    expect(inside.roll).toBe(0)
    const outside = command(at(3, 0), LEVEL)
    expect(outside.pitch).toBeGreaterThan(0)
  })

  it('pulls straight up for a target above the nose, without rolling', () => {
    const out = command(at(20, 0), LEVEL)
    expect(out.pitch).toBeGreaterThan(0)
    expect(Math.abs(out.roll)).toBeLessThan(1e-9)
  })

  it('rolls right for a target off the right wing and does not push', () => {
    const out = command(at(20, 90), LEVEL)
    expect(out.roll).toBeGreaterThan(0)
    expect(out.pitch).toBeGreaterThanOrEqual(0)
  })

  it('rolls left for a target off the left wing', () => {
    const out = command(at(20, -90), LEVEL)
    expect(out.roll).toBeLessThan(0)
  })

  it('rolls and pulls for a target below the nose, never pushing', () => {
    const out = command(at(40, 180), LEVEL)
    expect(out.pitch).toBe(0) // clamped: roll it round instead
    expect(Math.abs(out.roll)).toBeGreaterThan(0)
  })

  it('allows a small push for a target barely below the nose', () => {
    // Inside PUSH a half roll to fix a couple of degrees would be absurd.
    const out = command(at(4, 180), LEVEL)
    expect(out.pitch).toBeLessThan(0)
  })

  it('refuses to push once past the push allowance', () => {
    const inside = command(at((GAINS.push * 180) / Math.PI - 1, 180), LEVEL)
    const outside = command(at((GAINS.push * 180) / Math.PI + 1, 180), LEVEL)
    expect(inside.pitch).toBeLessThan(0)
    expect(outside.pitch).toBe(0)
  })

  it('fades roll authority in with the off-axis angle', () => {
    // Same lift-vector error, different distance off the nose: the far target
    // gets the bank, the near one is left alone.
    const near = command(at(2, 90), LEVEL)
    const far = command(at(30, 90), LEVEL)
    expect(far.roll).toBeGreaterThan(near.roll)
  })

  it('answers a target directly astern with a pure pull, not an arbitrary roll', () => {
    const out = command({ x: 0, y: 0, z: 1 }, LEVEL)
    expect(out.pitch).toBeGreaterThan(0)
    expect(Math.abs(out.roll)).toBeLessThan(1e-9)
  })

  it('never yaws', () => {
    for (let clock = 0; clock < 360; clock += 15) {
      for (const off of [1, 5, 20, 60, 120, 179]) {
        expect(command(at(off, clock), LEVEL).yaw).toBe(0)
      }
    }
  })

  it('stays inside the stick range at every angle and gain', () => {
    for (const gain of [0.5, 1, 2]) {
      for (let clock = 0; clock < 360; clock += 10) {
        for (const off of [0.6, 5, 20, 60, 120, 179.9]) {
          const out = command(at(off, clock), LEVEL, gain)
          expect(out.pitch).toBeGreaterThanOrEqual(-1)
          expect(out.pitch).toBeLessThanOrEqual(1)
          expect(out.roll).toBeGreaterThanOrEqual(-1)
          expect(out.roll).toBeLessThanOrEqual(1)
        }
      }
    }
  })

  it('scales with the player gain until it saturates', () => {
    const slow = command(at(6, 0), LEVEL, 0.5)
    const fast = command(at(6, 0), LEVEL, 2)
    expect(fast.pitch).toBeGreaterThan(slow.pitch)
  })

  it('survives a degenerate aim vector', () => {
    const out = command({ x: 0, y: 0, z: 0 }, LEVEL)
    expect(out).toEqual({ pitch: 0, roll: 0, yaw: 0 })
  })

  it('works in a rolled frame, not just upright', () => {
    // Banked 90° right: the jet's "up" now points out the right wing, so a
    // target to the WORLD right is straight up the lift vector and needs a
    // pull with no roll.
    const banked: Frame = {
      fwd: { x: 0, y: 0, z: -1 },
      up: { x: 1, y: 0, z: 0 },
      right: { x: 0, y: -1, z: 0 },
    }
    const out = command({ x: Math.sin(0.35), y: 0, z: -Math.cos(0.35) }, banked)
    expect(out.pitch).toBeGreaterThan(0)
    expect(Math.abs(out.roll)).toBeLessThan(1e-9)
  })
})

describe('radius', () => {
  it('gives a smaller pixel radius at a wider field for the same angle', () => {
    const limit = (25 * Math.PI) / 180
    const wide = radius(limit, (72 * Math.PI) / 180, 1080) // cockpit base
    const narrow = radius(limit, (45 * Math.PI) / 180, 1080) // every other view
    expect(narrow).toBeGreaterThan(wide)
  })

  it('shrinks as the optical zoom narrows the field, which is why it is per-frame', () => {
    const limit = (25 * Math.PI) / 180
    const base = (45 * Math.PI) / 180
    expect(radius(limit, base / 2, 1080)).toBeGreaterThan(radius(limit, base, 1080))
  })

  it('scales with viewport height', () => {
    const limit = (25 * Math.PI) / 180
    const fov = (45 * Math.PI) / 180
    expect(radius(limit, fov, 2160)).toBeCloseTo(2 * radius(limit, fov, 1080), 6)
  })

  it('puts half the field at exactly half the viewport height', () => {
    const fov = (45 * Math.PI) / 180
    expect(radius(fov / 2, fov, 1000)).toBeCloseTo(500, 6)
  })

  it('does not divide by zero on a degenerate field', () => {
    expect(Number.isFinite(radius(0.4, 0, 1080))).toBe(true)
  })
})
