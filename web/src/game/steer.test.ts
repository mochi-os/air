// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { describe, it, expect } from 'vitest'
import { command, radius, merge, reach, REACH_DEFAULT, GAINS, type Frame, type Vector } from './steer'

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

// off_axis measures the TRUE angle between the boresight and the ray through a
// pixel offset, the way three.js builds it: the camera carries a VERTICAL fov
// and aspect = width/height, which keeps pixels square, so a pixel offset maps
// to camera-space tangent through the vertical field on BOTH axes. Note the
// width never enters — that is the property the clamp depends on, and these
// tests assert it rather than assuming it.
function off_axis(px: number, py: number, fov: number, height: number): number {
  const t = Math.tan(fov / 2)
  return Math.atan(Math.hypot((px / (height / 2)) * t, (py / (height / 2)) * t))
}

describe('radius holds a true angular cone', () => {
  const LIMIT = (25 * Math.PI) / 180
  // The three fields the engine actually produces: chase and HUD at 45 deg, the
  // cockpit's wide 72 deg base, and the deepest optical zoom (base / 4).
  const fields = [45, 72, 45 / 4, 72 / 4].map((d) => (d * Math.PI) / 180)
  // 21:9 and 4:3 bracket any window the game will meet.
  const shapes = [
    { w: 2560, h: 1080 },
    { w: 1440, h: 1080 },
    { w: 1920, h: 1080 },
    { w: 1280, h: 720 },
  ]

  it('measures exactly the limit horizontally and vertically, at every field and aspect', () => {
    for (const fov of fields) {
      for (const { h } of shapes) {
        const r = radius(LIMIT, fov, h)
        expect(off_axis(r, 0, fov, h)).toBeCloseTo(LIMIT, 9) // horizontal edge
        expect(off_axis(0, r, fov, h)).toBeCloseTo(LIMIT, 9) // vertical edge
        expect(off_axis(r * Math.SQRT1_2, r * Math.SQRT1_2, fov, h)).toBeCloseTo(LIMIT, 9) // diagonal
      }
    }
  })

  it('is width-independent because the aspect cancels, proved the long way', () => {
    // radius() never sees the width, which only holds because three.js scales
    // NDC x by aspect * tan(fov/2) and aspect is width/height. Derive the
    // horizontal angle the LONG way, through NDC and aspect, and check it still
    // lands on the limit at 21:9, 4:3 and 16:9. Comparing radius() to itself
    // would assert nothing.
    for (const fov of fields) {
      for (const { w, h } of shapes) {
        const r = radius(LIMIT, fov, h)
        const long = Math.atan(Math.abs((r / (w / 2)) * (w / h) * Math.tan(fov / 2)))
        expect(long).toBeCloseTo(LIMIT, 9)
      }
    }
  })
})

describe('merge', () => {
  it('is zero with nothing commanded', () => {
    expect(merge()).toBe(0)
    expect(merge(0, 0, 0)).toBe(0)
  })

  it('takes the largest magnitude regardless of sign', () => {
    expect(merge(0.3, -0.7, 0)).toBeCloseTo(-0.7)
    expect(merge(-0.2, 0, 0.9)).toBeCloseTo(0.9)
    expect(merge(0, -1, 0.5)).toBeCloseTo(-1)
  })

  it('keeps the earlier argument on an equal-magnitude sign conflict', () => {
    // Engine call order is pad, keyboard, mouse: a physical control is never
    // silently overridden by a software one commanding exactly as much.
    expect(merge(0.5, -0.5, 0)).toBeCloseTo(0.5)
    expect(merge(-0.5, 0.5, 0)).toBeCloseTo(-0.5)
    expect(merge(0, 0.4, -0.4)).toBeCloseTo(0.4)
  })

  it('lets a centred mouse leave a deflected stick alone', () => {
    expect(merge(0.62, 0, 0)).toBeCloseTo(0.62)
  })

  it('lets a deflected mouse command past a centred stick', () => {
    expect(merge(0, 0, -0.44)).toBeCloseTo(-0.44)
  })

  it('cannot be beaten by stick drift inside the deadzone', () => {
    // pad_axis zeroes anything under 0.05 raw before the merge sees it, so
    // resting-stick drift arrives here as exactly 0.
    expect(merge(0, 0, 0.25)).toBeCloseTo(0.25)
    expect(merge(0, 0, 0)).toBe(0)
  })

  it('lets real deflection past the deadzone win, which is the point of it', () => {
    expect(merge(0.31, 0, 0.25)).toBeCloseTo(0.31)
  })
})

describe('reach', () => {
  it('takes the target range when one is designated and it clears everything', () => {
    expect(reach(3000, 24, 3000, 1 / 60)).toBeCloseTo(3000, 6)
  })

  it('falls back to the default with nothing designated', () => {
    expect(reach(null, 24, 0, 1 / 60)).toBe(REACH_DEFAULT)
  })

  it('honours the absolute floor', () => {
    expect(reach(50, 10, 0, 1 / 60)).toBe(250) // literal: asserting the floor equals REACH_FLOOR asserts nothing
  })

  it('keeps clear of the camera offset at every dolly distance', () => {
    // Chase dollies 14 m to 140 m. A reach comparable to the offset makes the
    // geometry degenerate; below it the commanded direction inverts outright.
    for (const offset of [14, 24, 60, 100, 140]) {
      const out = reach(200, offset, 0, 1 / 60)
      expect(out).toBeGreaterThanOrEqual(4 * offset) // literal, for the same reason
      expect(out).toBeGreaterThan(offset)
    }
  })

  it('never steps: acquiring a close target moves the reach a bounded amount per frame', () => {
    // The defect this exists for: with the cursor stationary, a step in reach
    // is a step in the commanded direction, so acquire/drop would jerk the nose.
    const dt = 1 / 60
    const before = reach(null, 24, 0, dt) // cruising, nothing boxed
    const after = reach(400, 24, before, dt) // target acquired at 400 m
    expect(after).toBeLessThan(before)
    expect(before - after).toBeLessThan((before - 400) * 0.2) // a fraction of the gap, not the gap
  })

  it('converges on the wanted reach rather than easing forever', () => {
    let r = reach(null, 24, 0, 1 / 60)
    for (let i = 0; i < 240; i++) r = reach(900, 24, r, 1 / 60)
    expect(r).toBeCloseTo(900, 3)
  })

  it('holds still on a zero or negative timestep', () => {
    expect(reach(900, 24, 1500, 0)).toBe(1500)
    expect(reach(900, 24, 1500, -1)).toBe(1500)
  })

  it('seeds instantly on the first frame, with no ease from zero', () => {
    expect(reach(800, 24, 0, 1 / 60)).toBe(800)
    expect(reach(800, 24, -1, 1 / 60)).toBe(800)
  })
})

// aim_direction mirrors what the engine does: march the camera ray out to the
// reach, then take the direction from the AIRCRAFT to that point. The camera is
// not at the aircraft in chase, which is the whole reason this indirection
// exists.
function aim_direction(camera: Vector, ray: Vector, aircraft: Vector, r: number): Vector {
  return { x: camera.x + ray.x * r - aircraft.x, y: camera.y + ray.y * r - aircraft.y, z: camera.z + ray.z * r - aircraft.z }
}

function between(a: Vector, b: Vector): number {
  const la = Math.hypot(a.x, a.y, a.z) || 1
  const lb = Math.hypot(b.x, b.y, b.z) || 1
  const d = (a.x * b.x + a.y * b.y + a.z * b.z) / (la * lb)
  return Math.acos(Math.min(1, Math.max(-1, d)))
}

describe('chase geometry with a near target', () => {
  // Chase, dollied fully out: camera 140 m behind the jet, both pointing -z.
  const aircraft: Vector = { x: 0, y: 0, z: 0 }
  const camera: Vector = { x: 0, y: 0, z: 140 }
  const ahead: Vector = { x: 0, y: 0, z: -1 }

  it('commands nearly straight ahead for a centred cursor, even at a 200 m target', () => {
    const r = reach(200, 140, 0, 1 / 60)
    const dir = aim_direction(camera, ahead, aircraft, r)
    expect(between(dir, ahead)).toBeCloseTo(0, 9)
  })

  it('bounds the cursor-to-command gain, which an unguarded reach does not', () => {
    // The quantity that matters is GAIN: how many degrees of nose command one
    // degree of cursor buys. Unguarded, a 200 m reach against a 140 m camera
    // offset nearly cancels the two vectors, so the gain runs away and the jet
    // turns twitchy exactly when a target is close. The floor holds it near
    // unity, which is what "the cursor means what it looks like" requires.
    const off = (5 * Math.PI) / 180
    const ray: Vector = { x: Math.sin(off), y: 0, z: -Math.cos(off) }
    const guarded = between(aim_direction(camera, ray, aircraft, reach(200, 140, 0, 1 / 60)), ahead) / off
    const raw = between(aim_direction(camera, ray, aircraft, 200), ahead) / off
    expect(guarded).toBeLessThan(1.5)
    expect(raw).toBeGreaterThan(3)
  })

  it('has almost no parallax with the camera at the pilot, the first-person limit', () => {
    // Renamed from a claim about the clearance guard that it never tested: with
    // a 1200 m reach against a 6 m offset the gain is ~1.005 whatever the
    // clearance multiplier is, so this asserts the geometry, not the guard.
    // The guard is asserted by the gain-bound block below.
    const off = (5 * Math.PI) / 180
    const ray: Vector = { x: Math.sin(off), y: 0, z: -Math.cos(off) }
    const near = between(aim_direction({ x: 0, y: 0, z: 6 }, ray, aircraft, reach(1200, 6, 0, 1 / 60)), ahead) / off
    expect(near).toBeGreaterThan(0.9)
    expect(near).toBeLessThan(1.1)
  })

  it('never inverts the commanded direction, at any dolly distance', () => {
    for (const offset of [14, 24, 60, 100, 140]) {
      const cam: Vector = { x: 0, y: 0, z: offset }
      const dir = aim_direction(cam, ahead, aircraft, reach(200, offset, 0, 1 / 60))
      expect(dir.z).toBeLessThan(0) // still pointing forward, not back past the camera
    }
  })
})

// gain is how many degrees of nose command one degree of cursor buys. The aim
// point sits `r` along the ray from the CAMERA and the command is taken from
// the AIRCRAFT, so in the small-angle limit the across-track components match
// while the along-track ones differ by the camera offset: gain = r / (r - d).
// The whole point of the floor and the clearance multiple is to bound this.
const DOLLY = [14, 20, 24, 40, 62.5, 63, 80, 100, 120, 140] // the chase camera's full travel
function gain_at(offset: number, range: number | null = 200): number {
  const r = reach(range, offset, 0, 1 / 60)
  return r / (r - offset)
}

describe('reach bounds the parallax gain across the whole dolly range', () => {
  it('never returns a reach below the floor or the clearance multiple', () => {
    // LITERALS, not REACH_FLOOR and REACH_CLEAR: deriving the expectation from
    // the constants under test makes the assertion move with the bug and pass
    // whatever they are set to. That defect is why this comment exists.
    for (const d of DOLLY) {
      expect(reach(200, d, 0, 1 / 60)).toBeGreaterThanOrEqual(Math.max(250, 4 * d))
    }
  })

  it('never inverts: the reach always clears the camera offset outright', () => {
    for (const d of DOLLY) expect(reach(200, d, 0, 1 / 60)).toBeGreaterThan(d)
  })

  it('keeps the gain at or above unity, never shrinking the cursor', () => {
    for (const d of DOLLY) expect(gain_at(d)).toBeGreaterThanOrEqual(1)
  })

  it('bounds the gain at 4/3, which is what the clearance multiple buys', () => {
    // 4/3 as a LITERAL. Written first as REACH_CLEAR / (REACH_CLEAR - 1), which
    // is Infinity at REACH_CLEAR = 1 and so passed against the exact mutation it
    // was written to catch. At a 140 m dolly with clearance 1 the reach falls to
    // the floor and the gain runs to 2.27; this now catches that.
    for (const d of DOLLY) expect(gain_at(d)).toBeLessThanOrEqual(4 / 3 + 1e-9)
  })

  it('is monotone in the dolly distance, so pulling the camera back never gets twitchier in jumps', () => {
    for (let i = 1; i < DOLLY.length; i++) {
      expect(gain_at(DOLLY[i])).toBeGreaterThanOrEqual(gain_at(DOLLY[i - 1]) - 1e-12)
    }
  })

  it('holds the same bounds with a distant target, where the range dominates', () => {
    for (const d of DOLLY) {
      expect(gain_at(d, 4000)).toBeGreaterThanOrEqual(1)
      expect(gain_at(d, 4000)).toBeLessThanOrEqual(4 / 3 + 1e-9)
    }
  })
})
