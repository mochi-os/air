// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { describe, expect, it } from 'vitest'
import { between, centred, DEGREE, destination, geodesic, geodetic, HOME, inverse, point, tangent } from './earth'

const near = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, tolerance: number) =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= tolerance

describe('the earth', () => {
  it('carries places to the earth-centred frame and back to under a millimetre, poles and antimeridian included', () => {
    const places = [
      { latitude: 28.2072 * DEGREE, longitude: -177.3735 * DEGREE, altitude: 0 },
      { latitude: 0, longitude: Math.PI, altitude: 12000 },
      { latitude: -0.3, longitude: -Math.PI + 1e-9, altitude: 300 },
      { latitude: Math.PI / 2 - 1e-7, longitude: 1, altitude: 15000 },
      { latitude: 0.7, longitude: 2.5, altitude: -10900 },
    ]
    for (const p of places) {
      const back = geodetic(centred(p))
      expect(Math.abs(back.latitude - p.latitude)).toBeLessThan(1e-11)
      expect(Math.abs(back.altitude - p.altitude)).toBeLessThan(1e-6)
    }
    expect(near(centred({ latitude: 0, longitude: 0, altitude: 0 }), { x: 6378137, y: 0, z: 0 }, 1e-6)).toBe(true)
    expect(Math.abs(centred({ latitude: Math.PI / 2, longitude: 0, altitude: 0 }).z - 6356752.314245)).toBeLessThan(1e-5)
  })

  it('agrees with the flight core to the millimetre', () => {
    // The flight core's own answers (earth.go), printed from Go.
    expect(near(HOME.sea(100000, -40000).point, { x: 100000, y: -909.381043557, z: -40000 }, 1e-6)).toBe(true)
    expect(near(point(between(HOME, tangent(0.4, 2)), { x: 1234.5, y: 8000, z: -4321 }), { x: 5221709.300023, y: -3266417.696665, z: -1962913.096599 }, 1e-3)).toBe(true)
    const p = HOME.place({ x: 300000, y: 9000, z: 200000 })
    expect(Math.abs(p.latitude - 0.460313328463161)).toBeLessThan(1e-12)
    expect(Math.abs(p.longitude - -3.043419313709856)).toBeLessThan(1e-12)
    expect(Math.abs(p.altitude - 19178.228288466)).toBeLessThan(1e-6)
    expect(near(HOME.upAt({ x: 300000, y: 9000, z: 200000 }), { x: 0.046863779267842, y: 0.998407330902596, z: 0.031409995108087 }, 1e-12)).toBe(true)
  })

  it('lays a frame east, up and south, and carries points between frames exactly', () => {
    const f = tangent(0.6, -2.9)
    expect(near(f.position({ latitude: 0.6, longitude: -2.9, altitude: 5000 }), { x: 0, y: 5000, z: 0 }, 1e-6)).toBe(true)
    const north = f.position({ latitude: 0.6 + 1e-4, longitude: -2.9, altitude: 0 })
    const east = f.position({ latitude: 0.6, longitude: -2.9 + 1e-4, altitude: 0 })
    expect(north.z).toBeLessThan(-600)
    expect(east.x).toBeGreaterThan(100)
    const r = between(HOME, f)
    const q = { x: 1234.5, y: 8000, z: -4321 }
    expect(near(point(inverse(r), point(r, q)), q, 1e-6)).toBe(true)
    expect(near(point(r, q), f.local(HOME.centred(q)), 1e-6)).toBe(true)
  })

  it('drops the sea 785 m below a level line a hundred kilometres out, and hides a low jet past the horizon', () => {
    expect(HOME.sea(100000, 0).point.y).toBeGreaterThan(-790)
    expect(HOME.sea(100000, 0).point.y).toBeLessThan(-780)
    const at = (d: number, h: number) => {
      const { point: p } = HOME.sea(d, 0)
      const up = HOME.upAt(p)
      return { x: p.x + up.x * h, y: p.y + up.y * h, z: p.z + up.z * h }
    }
    expect(HOME.clear(at(0, 100), at(70000, 100))).toBe(true)
    expect(HOME.clear(at(0, 100), at(75000, 100))).toBe(false)
    expect(HOME.clear(at(0, 10000), at(380000, 100))).toBe(true)
    expect(HOME.clear(at(0, 10000), at(420000, 100))).toBe(false)
  })

  it('measures the way along the ellipsoid as the surveyors do', () => {
    // Vincenty's own example (1975): Flinders Peak to Buninyong.
    const flinders = { latitude: -(37 + 57 / 60 + 3.7203 / 3600) * DEGREE, longitude: (144 + 25 / 60 + 29.5244 / 3600) * DEGREE, altitude: 0 }
    const buninyong = { latitude: -(37 + 39 / 60 + 10.1561 / 3600) * DEGREE, longitude: (143 + 55 / 60 + 35.3839 / 3600) * DEGREE, altitude: 0 }
    const way = geodesic(flinders, buninyong)
    expect(Math.abs(way.distance - 54972.271)).toBeLessThan(0.002)
    expect(Math.abs(way.bearing / DEGREE - (306 + 52 / 60 + 5.37 / 3600))).toBeLessThan(1e-5)
    const there = destination(flinders, way.bearing, way.distance)
    expect(Math.abs(there.latitude - buninyong.latitude)).toBeLessThan(1e-11)
    expect(Math.abs(there.longitude - buninyong.longitude)).toBeLessThan(1e-11)
    // A degree of longitude on the equator, and across the antimeridian.
    expect(Math.abs(geodesic({ latitude: 0, longitude: Math.PI - 0.5 * DEGREE, altitude: 0 }, { latitude: 0, longitude: -Math.PI + 0.5 * DEGREE, altitude: 0 }).distance - 111319.491)).toBeLessThan(0.01)
  })
})
