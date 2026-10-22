// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DAY, NIGHT, SIZE, type Moment } from './moon'

// The moon at the game's two fixed moments (#90), as tools/moon.py baked it from NASA's CGI Moon
// Kit and JPL Horizons. These hold the moments to the light the game already casts, and the
// baked frames and faces to the sky they are drawn on.
const engine = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
const DEGREE = Math.PI / 180
type Vector = [number, number, number]
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: number[], b: number[]): Vector => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const unit = (a: number[]): Vector => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l] }
const apart = (a: number[], b: number[]) => Math.acos(Math.min(1, dot(unit(a), unit(b)))) / DEGREE
// TOD's sun for an hour, the light the game casts
function slot(hour: 'day' | 'night'): Vector {
  const m = new RegExp(`\\t${hour}:\\s*\\{ sky:[\\d.]+, sun:\\[([\\d.]+),([\\d.]+),([\\d.]+)\\]`).exec(engine)
  expect(m, `TOD.${hour}`).not.toBeNull()
  return unit([Number(m![1]), Number(m![2]), Number(m![3])])
}

describe('the moments', () => {
  it("stand the night's full moon in the slot the night is lit from", () => {
    expect(apart(NIGHT.direction, slot('night'))).toBeLessThan(0.15)
    expect(NIGHT.lit).toBeGreaterThan(0.99)
    expect(NIGHT.phase).toBeGreaterThan(3) // clear of the Earth's penumbra, which would dim it
  })

  it("stand the noon's sun where the day is lit from, and its crescent well up and clear of it", () => {
    expect(apart(DAY.sun!, slot('day'))).toBeLessThan(0.05)
    expect(Math.asin(DAY.direction[1]) / DEGREE).toBeGreaterThan(25)
    expect(apart(DAY.direction, DAY.sun!)).toBeGreaterThan(45)
    expect(DAY.lit).toBeGreaterThan(0.2)
    expect(DAY.lit).toBeLessThan(0.6)
  })

  it('give each a disc its true size, about half a degree', () => {
    for (const m of [DAY, NIGHT]) {
      expect((2 * m.radius) / DEGREE).toBeGreaterThan(0.49)
      expect((2 * m.radius) / DEGREE).toBeLessThan(0.57)
    }
  })
})

describe('the faces', () => {
  it("lay each image on the sky square to the moon, its up toward the zenith and its right as a viewer's", () => {
    for (const m of [DAY, NIGHT] as Moment[]) {
      for (const v of [m.direction, m.right, m.up]) expect(Math.hypot(...v)).toBeCloseTo(1, 5)
      expect(dot(m.direction, m.right)).toBeCloseTo(0, 5)
      expect(dot(m.direction, m.up)).toBeCloseTo(0, 5)
      expect(dot(m.right, m.up)).toBeCloseTo(0, 5)
      const handed = cross(m.direction, m.up)
      for (let i = 0; i < 3; i++) expect(m.right[i]).toBeCloseTo(handed[i], 5) // looking along the moon, zenith up: right is direction x up
      expect(m.up[1]).toBeGreaterThan(0)
      expect(m.right[1]).toBeCloseTo(0, 5) // level: the zenith's plane holds the image's up, so its right lies flat
    }
    expect(NIGHT.right[0]).toBeCloseTo(-1, 3) // facing due south, a viewer's right is west
  })

  it("turn the crescent's bright limb toward the sun the game draws", () => {
    const sun = DAY.sun!
    const toward = Math.atan2(dot(sun, DAY.up), dot(sun, DAY.right)) / DEGREE
    const limb = Math.atan2(DAY.limb[1], DAY.limb[0]) / DEGREE
    expect(Math.abs(toward - limb)).toBeLessThan(5)
    expect(Math.hypot(...DAY.limb)).toBeGreaterThan(0.4) // a crescent: its light well off the centre
    expect(Math.hypot(...NIGHT.limb)).toBeLessThan(0.1) // nearly full: centred
  })

  it('carry the light a full moon and a crescent give, against the sun', () => {
    // the disc's whole light per unit of the sun's: mean radiance over its solid angle
    const light = (m: Moment) => m.scale * m.mean * Math.PI * m.radius * m.radius
    expect(light(NIGHT)).toBeGreaterThan(1.8e-6) // the full moon: magnitude about -12.6 against the sun's -26.74
    expect(light(NIGHT)).toBeLessThan(2.6e-6)
    const ratio = light(DAY) / light(NIGHT)
    expect(ratio).toBeGreaterThan(0.03) // a crescent 109 degrees round gives about a twentieth of a full moon's light
    expect(ratio).toBeLessThan(0.07)
  })

  it('come as images of the size the shader reads them at', () => {
    for (const name of ['day', 'night']) {
      const png = readFileSync(fileURLToPath(new URL(`../assets/moon-${name}.png`, import.meta.url)))
      expect(png.readUInt32BE(16), `moon-${name}.png width`).toBe(SIZE)
      expect(png.readUInt32BE(20), `moon-${name}.png height`).toBe(SIZE)
    }
  })
})
