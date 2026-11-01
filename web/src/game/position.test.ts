// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEGREE, HOME, between, inverse, tangent, vector } from './earth'
import {
  FREE,
  LIMITS,
  SPAN,
  at,
  clamp,
  on,
  parse,
  spawn,
  speed,
} from './position'

const KNOT = 1852 / 3600,
  FOOT = 0.3048

describe("the free start's airspeed (#167)", () => {
  it('flies the calibrated airspeed the HUD shows, true at the sea and faster aloft', () => {
    expect(speed(350, 0) / KNOT).toBeCloseTo(350, 6)
    // Published standard-day figures: 300 KCAS at 10,000 ft is about 346 KTAS,
    // and 250 KCAS at 35,000 ft about Mach 0.745 (432 KTAS).
    expect(speed(300, 10000 * FOOT) / KNOT).toBeGreaterThan(343)
    expect(speed(300, 10000 * FOOT) / KNOT).toBeLessThan(349)
    expect(speed(250, 35000 * FOOT) / KNOT).toBeGreaterThan(427)
    expect(speed(250, 35000 * FOOT) / KNOT).toBeLessThan(437)
  })
})

describe("the free start's place and heading (#167)", () => {
  it("lays a start at Midway over the world frame's origin, its heading the frame's own", () => {
    const s = spawn({ ...FREE, heading: 0 })
    expect(Math.hypot(s.position.x, s.position.z)).toBeLessThan(1)
    expect(s.position.y).toBeCloseTo(FREE.altitude * FOOT, 0)
    expect(s.direction.x).toBeCloseTo(0, 6)
    expect(s.direction.z).toBeCloseTo(-1, 6) // north is the frame's -z
    const east = spawn({ ...FREE, heading: 90 })
    expect(east.direction.x).toBeCloseTo(1, 6)
  })
  it('gives the core a direction it turns back into the heading chosen, anywhere on the earth', () => {
    const places = [
      [48.86, 2.35],
      [-33.9, 151.2],
      [64.1, -21.9],
      [-54.8, -68.3],
      [0, 0],
      [10, 179.9],
      [-10, -179.9],
    ]
    for (const [latitude, longitude] of places)
      for (const heading of [0, 45, 90, 180, 271]) {
        const s = spawn({
          latitude,
          longitude,
          altitude: 20000,
          heading,
          airspeed: 300,
        })
        expect(HOME.place(s.position).latitude / DEGREE).toBeCloseTo(
          latitude,
          6
        )
        expect(HOME.place(s.position).altitude / FOOT).toBeCloseTo(20000, 3)
        // What flight/trim.go Level does with it: the direction (x, 0, z) carried into
        // the frame level under the point, and flown across that level.
        const level = tangent(latitude * DEGREE, longitude * DEGREE)
        const local = vector(inverse(between(level, HOME)), {
          x: s.direction.x,
          y: 0,
          z: s.direction.z,
        })
        const flown = (Math.atan2(local.x, -local.z) / DEGREE + 360) % 360
        expect(
          Math.abs(((flown - heading + 540) % 360) - 180),
          `${latitude}, ${longitude} heading ${heading}`
        ).toBeLessThan(1e-6)
      }
  })
  it("keeps a choice on the earth and inside the dialog's limits, filling what is missing", () => {
    expect(clamp({})).toEqual(FREE)
    expect(
      clamp({
        latitude: 95,
        longitude: 190,
        altitude: 99999,
        heading: -10,
        airspeed: 1,
      })
    ).toEqual({
      latitude: 90,
      longitude: -170,
      altitude: LIMITS.altitude.maximum,
      heading: 350,
      airspeed: LIMITS.airspeed.minimum,
    })
    expect(clamp({ latitude: Number.NaN }).latitude).toBe(FREE.latitude)
  })
})

describe("the free start's latitude and longitude as typed (#167)", () => {
  it('reads signed decimal degrees with either decimal mark, or a hemisphere letter', () => {
    expect(parse('28.2334', 'latitude')).toBeCloseTo(28.2334, 9)
    expect(parse(' -177,3668 ', 'longitude')).toBeCloseTo(-177.3668, 9)
    expect(parse('177.37 W', 'longitude')).toBeCloseTo(-177.37, 9)
    expect(parse('33.9°S', 'latitude')).toBeCloseTo(-33.9, 9)
    expect(parse('.5', 'latitude')).toBe(0.5)
  })
  it('refuses what is not a place', () => {
    for (const [text, axis] of [
      ['91', 'latitude'],
      ['181', 'longitude'],
      ['12 E', 'latitude'],
      ['12 N', 'longitude'],
      ['-12 S', 'latitude'],
      ['north', 'latitude'],
      ['', 'longitude'],
    ] as const)
      expect(parse(text, axis), text).toBeNull()
  })
})

describe("the free start's map (#167)", () => {
  const manifest = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL('../../public/maps/world/world.json', import.meta.url)
      ),
      'utf8'
    )
  )
  it("reads the global image's projection from the map it is cut from", () => {
    const g = manifest.global
    expect(SPAN.width).toBeCloseTo(
      (2 * Math.PI * manifest.equator) / g.metres / g.width,
      12
    )
    expect(SPAN.height).toBeCloseTo(
      (Math.PI * manifest.equator) / g.metres / g.height,
      12
    )
  })
  it('turns a click into the place under it and back', () => {
    expect(at(90, -180)).toEqual({ across: 0, down: 0 })
    for (const [latitude, longitude] of [
      [28.2334, -177.3668],
      [-45, 100],
      [0, 0],
    ]) {
      const p = at(latitude, longitude),
        q = on(p.across, p.down)
      expect(q.latitude).toBeCloseTo(latitude, 9)
      expect(q.longitude).toBeCloseTo(longitude, 9)
    }
    expect(on(0.5 * SPAN.width, 0.5 * SPAN.height)).toEqual({
      latitude: 0,
      longitude: 0,
    })
  })
})
