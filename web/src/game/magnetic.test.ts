// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { describe, expect, it } from 'vitest'
import { DEGREE, type Vec } from './earth'
import { dip, field, rest, settled, swing, TILT, variation, year, type Field } from './magnetic'

// NOAA's test values for WMM2025 (WMM2025_TEST_VALUES.txt): date, height
// above the ellipsoid in km, latitude and longitude in degrees, then X, Y and
// Z in nT and the inclination and declination in degrees, as published.
const TESTS = [
  [2025.0, 0, 80, 0, 6521.6, 145.9, 54791.5, 83.21, 1.28],
  [2025.0, 0, 0, 120, 39677.8, -109.6, -10580.2, -14.93, -0.16],
  [2025.0, 0, -80, 240, 6117.5, 15751.9, -52022.5, -72.0, 68.78],
  [2025.0, 100, 80, 0, 6216.0, 92.4, 52598.8, 83.26, 0.85],
  [2025.0, 100, 0, 120, 37688.6, -96.2, -10152.1, -15.08, -0.15],
  [2025.0, 100, -80, 240, 5907.6, 14780.3, -49540.7, -72.19, 68.21],
  [2027.5, 0, 80, 0, 6500.8, 294.5, 54869.4, 83.24, 2.59],
  [2027.5, 0, 0, 120, 39701.6, -167.4, -10381.8, -14.65, -0.24],
  [2027.5, 0, -80, 240, 6200.7, 15730.3, -51783.7, -71.92, 68.49],
  [2027.5, 100, 80, 0, 6196.7, 233.8, 52670.5, 83.29, 2.16],
  [2027.5, 100, 0, 120, 37711.5, -148.7, -9969.8, -14.81, -0.23],
  [2027.5, 100, -80, 240, 5984.0, 14760.1, -49317.7, -72.1, 67.93],
]
const at = (latitude: number, longitude: number, altitude = 0) => ({ latitude: latitude * DEGREE, longitude: longitude * DEGREE, altitude })
const MIDWAY = at(28.2072, -177.3735)

describe('the World Magnetic Model', () => {
  it("matches every one of NOAA's published test values", () => {
    for (const [time, height, latitude, longitude, x, y, z, inclination, declination] of TESTS) {
      const f = field(at(latitude, longitude, height * 1000), time)
      const where = `${time} ${height} km ${latitude} ${longitude}`
      expect(Math.abs(f.north - x), where).toBeLessThan(0.5)
      expect(Math.abs(f.east - y), where).toBeLessThan(0.5)
      expect(Math.abs(f.down - z), where).toBeLessThan(0.5)
      expect(Math.abs(variation(at(latitude, longitude, height * 1000), time) / DEGREE - declination), where).toBeLessThan(0.006)
      expect(Math.abs(dip(f) / DEGREE - inclination), where).toBeLessThan(0.006)
    }
  })

  it('reads Midway about 7° east, the game had as a constant, drifting west a twentieth of a degree a year', () => {
    const now = variation(MIDWAY, 2026.83) / DEGREE
    expect(now).toBeCloseTo(7.07, 1)
    expect(variation(MIDWAY, 2027.83) / DEGREE - now).toBeCloseTo(-0.054, 2)
    expect(dip(field(MIDWAY, 2026.83)) / DEGREE).toBeCloseTo(42.1, 0)
  })

  it('gives each place its own: Norfolk and Iceland west, San Diego east', () => {
    expect(variation(at(36.95, -76.3), 2026.83) / DEGREE).toBeCloseTo(-10.8, 0)
    expect(variation(at(64, -22), 2026.83) / DEGREE).toBeCloseTo(-11, 0)
    expect(variation(at(32.7, -117.2), 2026.83) / DEGREE).toBeCloseTo(10.9, 0)
  })

  it('holds a date outside 2025-2030 to the nearer end of the model', () => {
    expect(variation(MIDWAY, 2031)).toBe(variation(MIDWAY, 2030))
    expect(variation(MIDWAY, 2020)).toBe(variation(MIDWAY, 2025))
  })

  it('counts a date as a year and its fraction, UTC', () => {
    expect(year(new Date(Date.UTC(2025, 0, 1)))).toBe(2025)
    expect(year(new Date(Date.UTC(2027, 6, 2, 12)))).toBeCloseTo(2027.5, 3)
    expect(year(new Date(Date.UTC(2026, 11, 31, 23, 59, 59)))).toBeCloseTo(2027, 4)
  })
})

// The standby compass. A level frame at the jet: x east, y up, z south.
const G = 9.80665
const vec = (x: number, y: number, z: number): Vec => ({ x, y, z })
// a jet on a true heading, banked right by bank and pitched up by pitch: its
// nose and its up, in the level frame
function axes(heading: number, bank = 0, pitch = 0) {
  const h = heading * DEGREE, b = bank * DEGREE, p = pitch * DEGREE
  const forward = vec(Math.sin(h) * Math.cos(p), Math.sin(p), -Math.cos(h) * Math.cos(p))
  const level = vec(-Math.sin(h) * Math.sin(p), Math.cos(p), Math.cos(h) * Math.sin(p)) // up with no bank
  const right = vec(Math.cos(h), 0, Math.sin(h))
  const up = vec(level.x * Math.cos(b) + right.x * Math.sin(b), level.y * Math.cos(b) + right.y * Math.sin(b), level.z * Math.cos(b) + right.z * Math.sin(b)) // the lift tilts toward the low wing
  return { nose: forward, up }
}
const scale = (v: Vec, s: number) => vec(v.x * s, v.y * s, v.z * s)
const sum = (a: Vec, b: Vec) => vec(a.x + b.x, a.y + b.y, a.z + b.z)
const degrees = (r: number) => r / DEGREE
const off = (reading: number, heading: number) => ((((reading - heading * DEGREE) / DEGREE + 540) % 360) + 360) % 360 - 180 // signed, degrees
// the jet in a coordinated turn: the load along its up, one g over the cosine of the bank
const turning = (f: Field, heading: number, bank: number) => {
  const a = axes(heading, bank)
  return rest(f, a.nose, a.up, scale(a.up, G / Math.cos(bank * DEGREE)))
}
// the jet level, its speed changing: the load tilted back by acceleration, forward by slowing
const speeding = (f: Field, heading: number, acceleration: number) => {
  const a = axes(heading)
  return rest(f, a.nose, a.up, sum(scale(a.up, G), scale(a.nose, acceleration)))
}

describe('the standby compass card', () => {
  const midway = field(MIDWAY, 2026.83)
  const D = degrees(variation(MIDWAY, 2026.83))
  const equator: Field = { north: 30000, east: 0, down: 0 }

  it('reads magnetic in steady level flight: true heading less the variation', () => {
    for (const heading of [0, 45, 90, 180, 270, 333]) {
      const a = axes(heading)
      expect(off(rest(midway, a.nose, a.up, vec(0, G, 0)).heading, heading - D)).toBeCloseTo(0, 6)
    }
  })

  it('reads magnetic climbing and diving inside its stop, the float level', () => {
    for (const pitch of [-15, 10, 17]) {
      const a = axes(120, 0, pitch)
      expect(Math.abs(off(rest(midway, a.nose, a.up, vec(0, G, 0)).heading, 120 - D))).toBeLessThan(0.01)
    }
  })

  it('turns the wrong way at first in a turn off north and leads in a turn off south, as the dip says, and not at all off east or west or with no dip', () => {
    // a right turn: heading east of north lags, heading south leads
    expect(off(turning(midway, D, 30).heading, 0)).toBeLessThan(-10)
    expect(off(turning(midway, 180 + D, 30).heading, 180)).toBeGreaterThan(10)
    // and the left turn mirrors it
    expect(off(turning(midway, D, -30).heading, 0)).toBeGreaterThan(10)
    // off magnetic east and west the turn shows true
    expect(Math.abs(off(turning(midway, 90 + D, 30).heading, 90))).toBeLessThan(1)
    expect(Math.abs(off(turning(midway, 270 + D, 30).heading, 270))).toBeLessThan(1)
    // with no dip there is no turning error at all
    expect(Math.abs(off(turning(equator, 0, 30).heading, 0))).toBeLessThan(1e-9)
  })

  it('grows the turning error with the dip: Norfolk shows more than Midway', () => {
    const norfolk = field(at(36.95, -76.3), 2026.83), d = degrees(variation(at(36.95, -76.3), 2026.83))
    expect(Math.abs(off(turning(norfolk, d, 30).heading, 0))).toBeGreaterThan(Math.abs(off(turning(midway, D, 30).heading, 0)))
  })

  it('swings toward north as the jet speeds up on an east or west heading, toward south as it slows', () => {
    expect(off(speeding(midway, 90 + D, 5).heading, 90)).toBeLessThan(-1) // east, accelerating: toward north
    expect(off(speeding(midway, 270 + D, 5).heading, 270)).toBeGreaterThan(1) // west, accelerating: toward north
    expect(off(speeding(midway, 90 + D, -5).heading, 90)).toBeGreaterThan(1) // east, slowing: toward south
    expect(Math.abs(off(speeding(midway, D, 5).heading, 0))).toBeLessThan(0.01) // north: none
  })

  it('leans no further than its stop, about 18°', () => {
    const a = axes(90 + D)
    const hard = rest(midway, a.nose, a.up, sum(scale(a.up, G), scale(a.nose, 3 * G))) // 72° back
    const stop = rest(midway, a.nose, a.up, sum(scale(a.up, G * Math.cos(TILT)), scale(a.nose, G * Math.sin(TILT))))
    expect(hard.heading).toBeCloseTo(stop.heading, 9)
  })

  it('carries the field strength across the card, weaker where the field dips more', () => {
    const a = axes(0)
    const here = rest(midway, a.nose, a.up, vec(0, G, 0)).strength
    expect(here).toBeCloseTo(Math.hypot(midway.north, midway.east), 6)
    const iceland = field(at(64, -22), 2026.83)
    expect(rest(iceland, a.nose, a.up, vec(0, G, 0)).strength).toBeLessThan(here / 1.5)
  })
})

describe('the card swinging', () => {
  const STRENGTH = 27000

  it('stays on a steady reading', () => {
    const card = settled(1, 0.6)
    for (let k = 0; k < 600; k++) expect(swing(card, 1, 0, 0.6, STRENGTH, 1 / 60)).toBeCloseTo(0.6, 9)
  })

  it('lags a steady turn, the fluid dragging it with the case', () => {
    const yaw = 10 * DEGREE, card = settled(0, 0)
    let heading = 0, reading = 0
    for (let k = 0; k < 60 * 20; k++) {
      heading += yaw / 60
      reading = swing(card, heading, yaw, heading, STRENGTH, 1 / 60)
    }
    const lag = off(reading, degrees(heading))
    expect(lag).toBeLessThan(0)
    expect(-lag).toBeCloseTo(degrees((2 * 0.5 * yaw) / ((2 * Math.PI) / 2.5)), 1) // 2ζ yaw / ω
  })

  it('overshoots a sudden change and settles inside a few seconds', () => {
    const card = settled(0, 0)
    let most = 0, reading = 0
    for (let k = 0; k < 60 * 8; k++) {
      reading = swing(card, 0, 0, 30 * DEGREE, STRENGTH, 1 / 60)
      most = Math.max(most, degrees(reading > Math.PI ? reading - 2 * Math.PI : reading))
    }
    expect(most).toBeGreaterThan(31)
    expect(most).toBeLessThan(40)
    expect(degrees(reading)).toBeCloseTo(30, 1)
  })

  it('swings slower in a weaker field', () => {
    const strong = settled(0, 0), weak = settled(0, 0)
    for (let k = 0; k < 30; k++) {
      swing(strong, 0, 0, 30 * DEGREE, STRENGTH, 1 / 60)
      swing(weak, 0, 0, 30 * DEGREE, STRENGTH / 4, 1 / 60)
    }
    expect(Math.abs(weak.azimuth)).toBeLessThan(Math.abs(strong.azimuth) / 2)
  })

  it('steps a long frame in short steps, so time compression cannot blow it up', () => {
    const card = settled(0, 0)
    let reading = 0
    for (let k = 0; k < 20; k++) reading = swing(card, 0, 0, 30 * DEGREE, STRENGTH, 1)
    expect(degrees(reading)).toBeCloseTo(30, 1)
  })
})
