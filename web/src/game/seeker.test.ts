// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { describe, expect, it } from 'vitest'
import {
  SEEKERS,
  seeker_break,
  seeker_sight,
  seeker_steer,
  type Vector,
} from './seeker'

// The engine moves every aircraft for the WHOLE render frame and only then
// sub-steps the missiles on their own 60 Hz accumulator. These tests replay
// that order, because the order is the defect: measured by finite difference,
// the first missile step of a frame sees the target's whole-frame motion and
// the second sees none.
const STEP = 1 / 60

const add = (a: Vector, b: Vector, k = 1): Vector => ({
  x: a.x + b.x * k,
  y: a.y + b.y * k,
  z: a.z + b.z * k,
})

// differenced is the OLD measurement, kept here as the control: the sight
// line's change between two missile steps, over one step.
const differenced = (before: Vector, after: Vector): number => {
  let x = (after.x - before.x) / STEP,
    y = (after.y - before.y) / STEP,
    z = (after.z - before.z) / STEP
  const along = x * after.x + y * after.y + z * after.z
  x -= along * after.x
  y -= along * after.y
  z -= along * after.z
  return Math.hypot(x, y, z)
}

// crossing flies a target across a stationary seeker's nose at a chosen TRUE
// sight-line rate, in the engine's update order, and reports the worst rate
// each method measured.
const crossing = (truth: number, frames: number) => {
  const range = 450
  const seat: Vector = { x: 0, y: 0, z: 0 }
  const still: Vector = { x: 1e-9, y: 0, z: 0 }
  const drift: Vector = { x: 0, y: 0, z: truth * range }
  let target: Vector = { x: range, y: 0, z: -drift.z * 0.2 } // starts just before abeam so the rate is near its peak throughout
  let before = seeker_sight(seat, still, target, drift).unit
  let worst = { analytic: 0, differenced: 0 }
  let owed = 0
  const frame = 1 / frames
  for (let n = 0; n < Math.round(0.4 * frames); n++) {
    target = add(target, drift, frame) // the aircraft: the whole frame at once
    owed += frame
    while (owed >= STEP - 1e-12) {
      owed -= STEP // then the missile, in 60 Hz steps against a target already moved
      const sight = seeker_sight(seat, still, target, drift)
      worst = {
        analytic: Math.max(worst.analytic, sight.rate),
        differenced: Math.max(worst.differenced, differenced(before, sight.unit)),
      }
      before = sight.unit
    }
  }
  return worst
}

describe('the sight-line rate does not depend on the frame rate', () => {
  it('the old finite difference doubled at 30 fps: the control', () => {
    // A true 0.2 rad/s pass is comfortably inside the 0.35 ceiling. Measured
    // the old way at 30 fps it reads double and the lock would have dropped.
    expect(crossing(0.2, 60).differenced).toBeLessThan(0.35)
    expect(crossing(0.2, 30).differenced).toBeGreaterThan(0.35)
  })

  it('reads the true rate at any frame rate', () => {
    for (const frames of [24, 30, 45, 60, 144]) {
      const measured = crossing(0.2, frames).analytic
      expect(measured, `${frames} fps`).toBeGreaterThan(0.19)
      expect(measured, `${frames} fps`).toBeLessThan(0.201)
    }
  })

  it('holds a 0.2 rad/s pass at 30 fps and still breaks a 0.4 one at any rate', () => {
    const verdict = (truth: number, frames: number) => {
      const rate = crossing(truth, frames).analytic
      return rate > SEEKERS.heater.ceiling ? 'rate' : ''
    }
    expect(verdict(0.2, 30)).toBe('')
    expect(verdict(0.4, 30)).toBe('rate')
    expect(verdict(0.4, 60)).toBe('rate')
  })
})

describe('what breaks a lock', () => {
  const ahead: Vector = { x: 1000, y: 0, z: 0 }
  const fast: Vector = { x: 700, y: 0, z: 0 }

  it('holds a target dead ahead and still', () => {
    const sight = seeker_sight({ x: 0, y: 0, z: 0 }, fast, ahead, { x: 0, y: 0, z: 0 })
    expect(sight.rate).toBeCloseTo(0, 9)
    expect(sight.bearing).toBeCloseTo(1, 9)
    expect(sight.closing).toBeCloseTo(700, 6)
    expect(seeker_break(sight, SEEKERS.heater)).toBe('')
  })

  it('breaks on the gimbal past forty degrees, and says so before the rate', () => {
    const wide: Vector = { x: 600, y: 0, z: 800 } // 53 degrees off the flight path
    const sight = seeker_sight({ x: 0, y: 0, z: 0 }, fast, wide, { x: 0, y: 0, z: 900 })
    expect(seeker_break(sight, SEEKERS.heater)).toBe('gimbal')
    expect(seeker_break(sight, SEEKERS.radar)).not.toBe('gimbal') // the radar round's own seeker gimbals to sixty
  })

  it('breaks on the rate when the target beams it', () => {
    const near: Vector = { x: 400, y: 0, z: 0 }
    const sight = seeker_sight({ x: 0, y: 0, z: 0 }, fast, near, { x: 0, y: 0, z: 200 })
    expect(sight.rate).toBeCloseTo(0.5, 6)
    expect(seeker_break(sight, SEEKERS.heater)).toBe('rate')
    expect(seeker_break(sight, SEEKERS.radar)).toBe('') // which tracks harder
  })

  it('does not spike when the aim point swaps to a flare', () => {
    // The old measurement differenced the sight line across the swap and read
    // the jump as rotation, which is why the engine re-referenced it by hand at
    // the seduction instant. A rate with no memory has nothing to spike.
    const round: Vector = { x: 0, y: 0, z: 0 }
    const target: Vector = { x: 800, y: 0, z: 0 }
    const flare: Vector = { x: 790, y: -30, z: 6 }
    const onTarget = seeker_sight(round, fast, target, { x: -200, y: 0, z: 0 })
    const onFlare = seeker_sight(round, fast, flare, { x: 0, y: -45, z: 0 })
    expect(differenced(onTarget.unit, onFlare.unit)).toBeGreaterThan(2) // the control: a lock-breaking phantom
    expect(onFlare.rate).toBeLessThan(0.1)
    expect(seeker_break(onFlare, SEEKERS.heater)).toBe('')
  })
})

describe('proportional navigation', () => {
  it('pulls across the sight line, toward where the target is going', () => {
    const sight = seeker_sight(
      { x: 0, y: 0, z: 0 },
      { x: 700, y: 0, z: 0 },
      { x: 1000, y: 0, z: 0 },
      { x: 0, y: 0, z: 100 }
    )
    const pull = seeker_steer(sight, 700)
    expect(pull.z).toBeGreaterThan(0)
    expect(Math.abs(pull.x)).toBeLessThan(1e-9)
    // a = N * Vc * rate = 3.5 * 700 * 0.1
    expect(Math.hypot(pull.x, pull.y, pull.z)).toBeCloseTo(245, 6)
  })

  it('is held to what the airframe can pull, less as it slows', () => {
    const sight = seeker_sight(
      { x: 0, y: 0, z: 0 },
      { x: 700, y: 0, z: 0 },
      { x: 300, y: 0, z: 0 },
      { x: 0, y: 0, z: 250 }
    )
    expect(Math.hypot(...Object.values(seeker_steer(sight, 700)))).toBeCloseTo(35 * 9.81, 6)
    expect(Math.hypot(...Object.values(seeker_steer(sight, 300)))).toBeCloseTo(35 * 9.81 * 0.5, 6)
    expect(Math.hypot(...Object.values(seeker_steer(sight, 30)))).toBeCloseTo(35 * 9.81 * 0.15, 6)
  })
})

// The recorded shot, end to end: a heater launched at 1,669 m, fifteen degrees
// off the shooter's nose, against a jet that breaks hard, flown in the engine's
// update order. It is the bandit's first pair from recording 01a0b090, which
// was tracking at one degree off boresight when it went ballistic at 422-438 m
// and passed at 43-48 m. The game was running at about 30 fps.
describe('the recorded head-on shot', () => {
  const fly = (measure: 'analytic' | 'differenced', frames: number) => {
    const frame = 1 / frames
    const pace = 237
    const offset = (15 * Math.PI) / 180
    let target: Vector = { x: 1669, y: 0, z: 0 }
    let course = Math.PI // flying at the shooter
    let round: Vector = { x: 0, y: 0, z: 0 }
    let velocity: Vector = { x: 276 * Math.cos(offset), y: 0, z: 276 * Math.sin(offset) } // off the rail at the shooter's speed plus 30
    let burn = 3
    let flew = 0
    let owed = 0
    let lost = -1
    let least = 1e9
    let before = seeker_sight(round, velocity, target, { x: -pace, y: 0, z: 0 }).unit
    for (let n = 0; n < 8 * frames; n++) {
      // the aircraft first, the whole frame at once: a 7.5 g break from 0.2 s
      const turning = n * frame > 0.2 ? (9.81 * Math.sqrt(7.5 * 7.5 - 1)) / pace : 0
      course += turning * frame
      const drift: Vector = { x: Math.cos(course) * pace, y: 0, z: Math.sin(course) * pace }
      target = add(target, drift, frame)
      owed += frame
      while (owed >= STEP - 1e-12) {
        owed -= STEP // then the round, in 60 Hz steps against a target already moved
        flew += STEP
        const sight = seeker_sight(round, velocity, target, drift)
        least = Math.min(least, sight.distance)
        if (sight.distance < 12) return { fused: true, lost, least }
        if (flew > 0.6 && lost < 0) {
          const rate = measure === 'analytic' ? sight.rate : differenced(before, sight.unit)
          if (sight.bearing < SEEKERS.heater.gimbal || rate > SEEKERS.heater.ceiling) lost = sight.distance
        }
        before = sight.unit
        let speed = Math.hypot(velocity.x, velocity.y, velocity.z)
        if (flew > 0.6 && lost < 0) velocity = add(velocity, seeker_steer(sight, speed), STEP)
        speed = Math.hypot(velocity.x, velocity.y, velocity.z)
        if (burn > 0) {
          burn -= STEP
          velocity = add(velocity, velocity, (260 * STEP) / speed)
        }
        round = add(round, velocity, STEP)
      }
    }
    return { fused: false, lost, least }
  }

  it('missed at 30 fps and hit at 60, measured the old way: the control', () => {
    // The same shot, the same target, the same seeker. Only the player's frame
    // rate differs, and it decides whether the missile arrives.
    const slow = fly('differenced', 30)
    expect(slow.fused).toBe(false)
    expect(slow.lost).toBeGreaterThan(300) // dropped far out, as recorded
    expect(slow.least).toBeGreaterThan(12) // and past the fuse
    expect(fly('differenced', 60).fused).toBe(true)
  })

  it('arrives at either frame rate, measured from the relative velocity', () => {
    expect(fly('analytic', 30).fused).toBe(true)
    expect(fly('analytic', 60).fused).toBe(true)
  })
})
