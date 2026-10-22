// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { NIGHT } from './moon'
import { decode, direction, light, planet, sidereal, tint, type Star } from './sky'
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
    expect(STAR_COUNT).toBeGreaterThan(1550) // 1,630 to magnitude 5.0
    expect(STAR_COUNT).toBeLessThan(1700)
  })

  it('holds Sirius, the brightest star, where the sky has it', () => {
    const brightest = stars.reduce((a, b) => (b.magnitude < a.magnitude ? b : a))
    expect(brightest.magnitude).toBeCloseTo(-1.46, 1)
    expect(brightest.ascension / DEGREE).toBeCloseTo(101.287, 1) // 6h 45m 09s
    expect(brightest.declination / DEGREE).toBeCloseTo(-16.716, 1)
  })

  it('reaches the magnitude 5.0 limit it was packed to, and stops there', () => {
    const faintest = Math.max(...stars.map((s) => s.magnitude))
    expect(faintest).toBeLessThanOrEqual(5.0)
    expect(faintest).toBeGreaterThan(4.9)
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

  // The stars are placed for the night's moment (moon.ts), the midnight whose full moon stood
  // where the night is lit from: the moon's own place then, through the stars' own transform,
  // lands in that slot, so the moon and the stars agree. Its topocentric J2000 place from the
  // map origin at 2018-09-25 12:04:36 UTC is JPL Horizons'.
  it("puts the night's moon where the night is lit from, by the stars' own clock and transform", () => {
    const moon: Star = { ascension: 7.820176 * DEGREE, declination: -1.993816 * DEGREE, magnitude: -12.7, colour: 0.9 }
    const d = direction(moon, LATITUDE, sidereal(NIGHT.time) - 177.3668 * DEGREE)
    const slot = [0, 0.866, 0.5].map((c) => c / Math.hypot(0, 0.866, 0.5))
    const apart = Math.acos(d[0] * slot[0] + d[1] * slot[1] + d[2] * slot[2]) / DEGREE
    expect(apart).toBeLessThan(0.4) // J2000 places by today's sidereal clock: precession's quarter degree, and the 0.1 the moment misses by
    const engine = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
    expect(engine).toContain('const local=sky_sidereal(MOON_NIGHT.time)+longitude*Math.PI/180')
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

  // Brighter, not bigger: the brightness by the power 0.3 of the flux, the size still by the 0.45 it
  // was set by, so a star keeps the width it had.
  it('lights the faint stars at about a quarter of white, and leaves each star its width', () => {
    const before = (magnitude: number) => Math.pow(Math.min(Math.max(Math.pow(10, -0.4 * (magnitude - 6)), 1), 400) / 400, 0.45)
    expect(light(4.5).brightness).toBeCloseTo(0.251, 3)
    expect(light(5.0).brightness).toBeCloseTo(0.218, 3)
    expect(light(2.0).brightness).toBeCloseTo(0.5, 2)
    expect(light(0.03).brightness).toBeLessThan(0.9) // Vega: under white, so its core keeps its shape
    for (const magnitude of [5.0, 4.5, 3, 2, 1, 0, -1.46]) {
      expect(light(magnitude).size).toBeCloseTo(3.5 + 3.5 * before(magnitude), 9)
      expect(light(magnitude).brightness).toBeGreaterThanOrEqual(before(magnitude))
    }
  })

  it('tints hot stars blue and cool stars orange', () => {
    const [br, , bb] = tint(-0.3), [or, , ob] = tint(1.8)
    expect(bb).toBeGreaterThan(br)
    expect(or).toBeGreaterThan(ob)
  })
})

// Mars by JPL's approximate elements, held to JPL Horizons' geocentric J2000 place and visual magnitude.
describe('a planet', () => {
  const apart = (a: Star, ascension: number, declination: number) =>
    Math.acos(Math.min(1, Math.sin(a.declination) * Math.sin(declination * DEGREE) + Math.cos(a.declination) * Math.cos(declination * DEGREE) * Math.cos(a.ascension - ascension * DEGREE))) / DEGREE * 60

  it('stands Mars where Horizons has it, to an arcminute or so, and as bright', () => {
    for (const [time, ascension, declination, magnitude] of [
      ['2018-09-25T12:04:00Z', 307.042032, -23.419267, -1.418], // the night's moment
      ['2020-10-13T23:00:00Z', 20.338037, 5.337565, -2.67], // at opposition
      ['2005-03-15T23:58:00Z', 298.69625, -21.671523, 1.14], // beyond the sun
    ] as const) {
      const mars = planet('mars', new Date(time))
      expect(apart(mars, ascension, declination), time).toBeLessThan(1.5)
      expect(Math.abs(mars.magnitude - magnitude), time).toBeLessThan(0.15)
      expect(mars.colour).toBeCloseTo(1.36, 2)
    }
  })

  it("puts Mars low in the south-west at the night's moment, brighter than any star in the sky", () => {
    const mars = planet('mars', NIGHT.time)
    const d = direction(mars, LATITUDE, sidereal(NIGHT.time) - 177.3668 * DEGREE)
    expect(altitude(d)).toBeGreaterThan(10) // Horizons: 12.1 degrees up at azimuth 234.9
    expect(altitude(d)).toBeLessThan(14)
    const azimuth = ((Math.atan2(d[0], -d[2]) / DEGREE) % 360 + 360) % 360
    expect(azimuth).toBeGreaterThan(233)
    expect(azimuth).toBeLessThan(237)
    expect(mars.magnitude).toBeLessThan(Math.min(...stars.map((s) => s.magnitude)))
    const engine = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
    expect(engine).toContain('const star_catalogue=[...sky_decode(STAR_DATA,STAR_COUNT), sky_planet("mars",MOON_NIGHT.time)]')
  })
})
