// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { describe, expect, it } from 'vitest'
import { decode, direction, light, midnight, sidereal, tint, type Star } from './sky'
import { STAR_COUNT, STAR_DATA } from './stars'

const DEGREE = Math.PI / 180
const stars = decode(STAR_DATA, STAR_COUNT)
const LATITUDE = 28.2334 // the Midway map's origin
const altitude = (d: [number, number, number]) => Math.asin(d[1]) / DEGREE

// The catalogue star nearest a J2000 position.
function nearest(ascension: number, declination: number): Star {
  let best = stars[0], score = Infinity
  for (const s of stars) {
    const d = Math.acos(Math.min(1, Math.sin(s.declination) * Math.sin(declination * DEGREE) + Math.cos(s.declination) * Math.cos(declination * DEGREE) * Math.cos(s.ascension - ascension * DEGREE)))
    if (d < score) { score = d; best = s }
  }
  return best
}

describe('the packed catalogue', () => {
  it('decodes every star', () => {
    expect(stars).toHaveLength(STAR_COUNT)
    expect(STAR_COUNT).toBeGreaterThan(800) // 904 to magnitude 4.5
    expect(STAR_COUNT).toBeLessThan(1000)
  })

  it('holds Sirius, the brightest star, where the sky has it', () => {
    const brightest = stars.reduce((a, b) => (b.magnitude < a.magnitude ? b : a))
    expect(brightest.magnitude).toBeCloseTo(-1.46, 1)
    expect(brightest.ascension / DEGREE).toBeCloseTo(101.287, 1) // 6h 45m 09s
    expect(brightest.declination / DEGREE).toBeCloseTo(-16.716, 1)
  })

  it('stops at the magnitude 4.5 limit it was packed to', () => {
    expect(Math.max(...stars.map((s) => s.magnitude))).toBeLessThanOrEqual(4.5)
  })
})

describe('sidereal time', () => {
  it('matches the J2000.0 epoch', () => {
    expect(sidereal(new Date('2000-01-01T12:00:00Z')) / DEGREE).toBeCloseTo(280.46061837, 4)
  })

  it('gains a sidereal day on a solar one', () => {
    const a = sidereal(new Date('2026-03-01T00:00:00Z')), b = sidereal(new Date('2026-03-02T00:00:00Z'))
    expect((((b - a) / DEGREE) % 360 + 360) % 360).toBeCloseTo(0.98565, 3)
  })

  it('puts local mean midnight at Midway near 11:49 UTC', () => {
    expect(midnight(new Date('2026-09-13T20:15:00Z'), -177.3668).toISOString()).toBe('2026-09-13T11:49:28.032Z')
  })
})

describe('a star in the local sky', () => {
  it('stands the celestial pole at the observer latitude above due north, at any hour', () => {
    const pole: Star = { ascension: 1.2, declination: Math.PI / 2, magnitude: 0, colour: 0 }
    for (const hour of [0, 1.7, 3.1, 5.2]) {
      const d = direction(pole, LATITUDE, hour)
      expect(altitude(d)).toBeCloseTo(LATITUDE, 6)
      expect(d[2]).toBeLessThan(0) // north is -z
      expect(Math.abs(d[0])).toBeLessThan(1e-9)
    }
  })

  it('keeps Polaris within its 0.74 deg polar distance of the pole', () => {
    const polaris = nearest(37.95, 89.264)
    expect(polaris.magnitude).toBeLessThan(2.1)
    for (const hour of [0, 1.7, 3.1, 5.2]) {
      const d = direction(polaris, LATITUDE, hour)
      expect(Math.abs(altitude(d) - LATITUDE)).toBeLessThan(0.75)
      expect(d[2]).toBeLessThan(0)
    }
  })

  it('rises in the east and sets in the west', () => {
    const equator: Star = { ascension: 0, declination: 0, magnitude: 0, colour: 0 }
    expect(direction(equator, LATITUDE, -Math.PI / 2)[0]).toBeGreaterThan(0.99) // hour angle -6h: rising, east is +x
    expect(direction(equator, LATITUDE, Math.PI / 2)[0]).toBeLessThan(-0.99)
  })

  it('crosses due south at 90 - latitude + declination', () => {
    const sirius = nearest(101.287, -16.716)
    const d = direction(sirius, LATITUDE, sirius.ascension)
    expect(altitude(d)).toBeCloseTo(90 - LATITUDE + sirius.declination / DEGREE, 3)
    expect(d[2]).toBeGreaterThan(0) // south is +z
    expect(Math.abs(d[0])).toBeLessThan(1e-9)
  })
})

describe('how a star shows', () => {
  it('brightens and grows with magnitude, and never shrinks below the 3.5 px that keeps a two-pixel core', () => {
    const faint = light(6.0), vega = light(0.03), sirius = light(-1.46)
    expect(faint.brightness).toBeGreaterThan(0)
    expect(faint.size).toBeGreaterThanOrEqual(3.5)
    expect(vega.brightness).toBeGreaterThan(faint.brightness)
    expect(sirius.brightness).toBeGreaterThan(vega.brightness)
    expect(sirius.size).toBeGreaterThan(vega.size)
    expect(sirius.brightness).toBeLessThanOrEqual(1)
  })

  it('tints hot stars blue and cool stars orange', () => {
    const [br, , bb] = tint(-0.3), [or, , ob] = tint(1.8)
    expect(bb).toBeGreaterThan(br)
    expect(or).toBeGreaterThan(ob)
  })
})
