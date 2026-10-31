// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { describe, expect, it } from 'vitest'
import { centred, DEGREE, destination, geodesic, tangent } from './earth'
import { heading, offset, project, ring, step } from './globe'

const NM = 1852

describe('the map seen from above its centre', () => {
  const view = tangent(28.2 * DEGREE, -177.37 * DEGREE), centre = { latitude: view.latitude, longitude: view.longitude, altitude: 0 }
  it('draws the centre at the middle and the earth close by as the flat map did', () => {
    const middle = project(view, centred(centre))
    expect(middle.seen).toBe(true)
    expect(Math.hypot(middle.x, middle.z)).toBeLessThan(1e-6)
    const east = project(view, centred(destination(centre, Math.PI / 2, 40000)))
    expect(east.x).toBeCloseTo(40000, -1) // within 10 m at 40 km
    expect(Math.abs(east.z)).toBeLessThan(150)
    const north = project(view, centred(destination(centre, 0, 40000)))
    expect(north.z).toBeLessThan(-39900)
  })
  it('hides what lies beyond the limb', () => {
    for (const bearing of [0, 1, 2.5, 4]) {
      expect(project(view, centred(destination(centre, bearing, 9000000))).seen).toBe(true) // 81 degrees round the earth
      expect(project(view, centred(destination(centre, bearing, 11000000))).seen).toBe(false) // 99
    }
    const antipode = { latitude: -centre.latitude, longitude: centre.longitude + Math.PI, altitude: 0 }
    expect(project(view, centred(antipode)).seen).toBe(false)
  })
  it('turns a direction of the earth onto the map, north up', () => {
    const north = heading(view, { x: -view.south.x, y: -view.south.y, z: -view.south.z })
    expect(north.x).toBeCloseTo(0, 9)
    expect(north.z).toBeCloseTo(-1, 9)
    const east = heading(view, view.east)
    expect(east.x).toBeCloseTo(1, 9)
  })
})

describe('the range rings', () => {
  it('space 1, 2 or 5 in a power of ten, at most four across the half width', () => {
    expect(step(40000 / NM)).toBe(10) // the default view, as the rings always were
    expect(step(5)).toBe(2)
    expect(step(100)).toBe(50)
    expect(step(3600)).toBe(1000)
    for (let range = 3; range < 4000; range *= 1.07) expect(range / step(range)).toBeLessThanOrEqual(4)
  })
  it('are circles on the earth', () => {
    const centre = { latitude: 50 * DEGREE, longitude: 5 * DEGREE, altitude: 0 }
    for (const distance of [18520, 1852000, 9000000]) {
      const points = ring(centre, distance, 36)
      expect(points).toHaveLength(37)
      for (const p of points) expect(geodesic(centre, p).distance).toBeCloseTo(distance, -1)
    }
  })
})

describe('the map panned', () => {
  it('moves its centre along the great circle the pan points', () => {
    const from = { latitude: 28.2 * DEGREE, longitude: -177.37 * DEGREE, altitude: 0 }
    expect(offset(from, 0, 0)).toBe(from)
    const east = offset(from, 100000, 0), there = geodesic(from, east)
    expect(there.distance).toBeCloseTo(100000, -1)
    expect(there.bearing).toBeCloseTo(Math.PI / 2, 6)
    const round = offset(from, 0, -40007863) // north, once round the earth through both poles: home again
    expect(geodesic(from, round).distance).toBeLessThan(2000)
  })
})
