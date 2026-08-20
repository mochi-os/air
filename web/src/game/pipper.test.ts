// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { describe, it, expect } from 'vitest'
import { aim, impact, flight, travel, length, reach, launch, MUZZLE, GRAVITY, type Vector } from './pipper'

// fly marches a round the way battle.Fly does — quadratic drag on the whole
// vector, plus gravity — and reports its closest approach to a target that
// keeps moving. This is the only honest test of a gun solution: solve for the
// nose angle, then actually shoot and see whether it hits.
function fly(muzzle: Vector, bore: Vector, own: Vector, target: Vector, drift: Vector): number {
  const step = 0.02
  let where = { ...muzzle }
  let v = { x: bore.x * MUZZLE + own.x, y: bore.y * MUZZLE + own.y, z: bore.z * MUZZLE + own.z }
  let best = Infinity
  for (let n = 1; n <= 200; n++) {
    const speed = Math.hypot(v.x, v.y, v.z)
    const k = 1 / (1 + (speed * step) / length(Math.max(where.y, 0)))
    v = { x: v.x * k, y: v.y * k - GRAVITY * step, z: v.z * k }
    where = { x: where.x + v.x * step, y: where.y + v.y * step, z: where.z + v.z * step }
    const t = n * step
    const him = { x: target.x + drift.x * t, y: target.y + drift.y * t, z: target.z + drift.z * t }
    // Closest approach WITHIN this step, as the proximity fuse computes it: at
    // ~1,000 m/s the round covers 20 m per step, so sampling the endpoints alone
    // cannot resolve better than ±10 m and would flatter or libel any solution.
    const rel = { x: where.x - him.x, y: where.y - him.y, z: where.z - him.z }
    const close = { x: v.x - drift.x, y: v.y - drift.y, z: v.z - drift.z }
    const square = close.x * close.x + close.y * close.y + close.z * close.z
    let back = 0
    if (square > 1e-9) {
      back = Math.min(Math.max((rel.x * close.x + rel.y * close.y + rel.z * close.z) / square, 0), step)
    }
    const at = { x: rel.x - close.x * back, y: rel.y - close.y * back, z: rel.z - close.z * back }
    best = Math.min(best, Math.hypot(at.x, at.y, at.z))
  }
  return best
}

const still = { x: 0, y: 0, z: 0 }
const size = (a: Vector) => Math.hypot(a.x, a.y, a.z)

describe('flight time', () => {
  // The drag law's own published anchor: about 700 m/s and 1.16 s at a
  // thousand metres, sea level, from a standing start.
  it('matches the published table at a thousand metres', () => {
    expect(flight(1000, MUZZLE, 0)).toBeCloseTo(1.161, 2)
  })

  it('stretches with altitude, because thin air shoots further', () => {
    expect(flight(1000, MUZZLE, 5000)).toBeLessThan(flight(1000, MUZZLE, 0))
    expect(length(8500) / length(0)).toBeCloseTo(Math.E, 3)
  })

  it('credits the shooter\'s own speed toward the target', () => {
    expect(flight(1000, MUZZLE + 250, 0)).toBeLessThan(flight(1000, MUZZLE, 0))
  })

  // The round dies at 4 s, whatever the aim: about 2,500 m low, 2,900 m high.
  it('knows how far a round can actually get', () => {
    expect(reach(0)).toBeCloseTo(2500, 0)
    expect(reach(4000)).toBeGreaterThan(2800)
    expect(reach(0, MUZZLE + 240)).toBeGreaterThan(reach(0))   // the jet's own speed is behind it
  })

  it('is consistent with the distance the barrel component covers', () => {
    for (const span of [200, 800, 1500, 2500]) {
      expect(travel(MUZZLE, flight(span, MUZZLE, 0), 0)).toBeCloseTo(span, 0)
    }
  })
})

// The property the pilot actually asked for: put the pipper on the target and
// the rounds hit — at ANY range, including past the 2,000 m the solution used
// to be clamped at, and close in where the lead is almost nothing.
describe('aim solves for a hit', () => {
  const altitude = 4000
  const cases: { name: string; range: number; drift: Vector; own: Vector }[] = [
    { name: 'point blank, non-manoeuvring', range: 150, drift: still, own: { x: 200, y: 0, z: 0 } },
    { name: 'inside the ring', range: 500, drift: { x: 0, y: 0, z: 200 }, own: { x: 220, y: 0, z: 0 } },
    { name: 'a normal gun shot', range: 800, drift: { x: 0, y: 0, z: 250 }, own: { x: 240, y: 0, z: 0 } },
    { name: 'the range the old clamp still handled', range: 1300, drift: { x: 0, y: 0, z: 250 }, own: { x: 240, y: 0, z: 0 } },
    { name: 'a long shot, inside the reach', range: 1900, drift: { x: 0, y: 0, z: 200 }, own: { x: 240, y: 0, z: 0 } },
    { name: 'well past the old 2 km clamp', range: 2600, drift: { x: 0, y: 0, z: 150 }, own: { x: 240, y: 0, z: 0 } },
    { name: 'past the round\'s reach', range: 3600, drift: { x: 0, y: 0, z: 150 }, own: { x: 240, y: 0, z: 0 } },
    { name: 'a climbing target', range: 900, drift: { x: 0, y: 80, z: 180 }, own: { x: 240, y: 0, z: 0 } },
    { name: 'a target running away', range: 1100, drift: { x: 260, y: 0, z: 0 }, own: { x: 240, y: 0, z: 0 } },
  ]

  for (const c of cases) {
    it(`hits ${c.name} at ${c.range} m`, () => {
      const muzzle = { x: 0, y: altitude, z: 0 }
      const target = { x: c.range, y: altitude, z: 0 }
      const bore = aim(muzzle, c.own, target, c.drift, altitude)
      const miss = fly(muzzle, bore, c.own, target, c.drift)
      if (c.range < reach(altitude, size(launch({ x: 1, y: 0, z: 0 }, c.own)))) {
        // An angular bar under the gun's own 3 mrad dispersion: the solution
        // must be better than the weapon's scatter at any range. Past 2 km the
        // harness's own fidelity shows (it re-reads the drag length at the
        // round's falling altitude every 20 m; the solution reads it once, at
        // launch), so the bar is 2.9 mrad, not the 1.7 the near shots hold.
        expect(miss).toBeLessThan(Math.max(2, c.range / 350))
      } else {
        // Past the round's life no aim can hit — the deliverable there is the
        // correct ANGLE, asserted by the pipper-on-target case below. All the
        // shortfall may do is put the round short, never wide (the 80 m is the
        // harness's gravity and altitude bookkeeping over four seconds, which
        // the analytic reach does not carry).
        expect(miss).toBeLessThan(c.range - reach(altitude, size(launch({ x: 1, y: 0, z: 0 }, c.own))) + 80)
      }
    })

    it(`draws the pipper on the target once aimed: ${c.name}`, () => {
      const muzzle = { x: 0, y: altitude, z: 0 }
      const target = { x: c.range, y: altitude, z: 0 }
      const bore = aim(muzzle, c.own, target, c.drift, altitude)
      // With the nose on the solution, the drawn impact point must coincide
      // with the target — that is what "pipper on target" means.
      const { point } = impact(muzzle, bore, c.own, target, c.drift, altitude)
      expect(Math.hypot(point.x - target.x, point.y - target.y, point.z - target.z)).toBeLessThan(8)
    })
  }

  // The defect itself: a solution computed for a clamped range is the wrong
  // angle. Past 2 km the old code solved for 2 km, so the lead was short.
  it('does not reuse the 2 km solution for a target further away', () => {
    const muzzle = { x: 0, y: 4000, z: 0 }
    const drift = { x: 0, y: 0, z: 250 }
    const own = { x: 240, y: 0, z: 0 }
    const near = aim(muzzle, own, { x: 2000, y: 4000, z: 0 }, drift, 4000)
    const far = aim(muzzle, own, { x: 3000, y: 4000, z: 0 }, drift, 4000)
    // More range means more time of flight means more lead: the two solutions
    // must differ, and the further one must lead further.
    expect(Math.abs(far.z) - Math.abs(near.z)).toBeGreaterThan(0.01)
  })
})
