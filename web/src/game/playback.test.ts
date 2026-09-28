// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { describe, expect, it } from 'vitest'
import { acmi, metres, position, type Recorded, type Sample } from './acmi'
import { items, number, parse, scene } from './playback'

// Recordings are made by the recorder's own writer, so a change on either side
// that parts them fails here.
const jet = (over: Partial<Recorded> = {}): Recorded => ({
  id: 1,
  x: 0,
  y: 500,
  z: 0,
  roll: 0,
  pitch: 0,
  yaw: 90,
  name: 'FA-18C',
  label: 'Viper',
  colour: 'Blue',
  kind: 'Air+FixedWing',
  ...over,
})
const record = (samples: Sample[], match?: Record<string, string>) =>
  acmi(samples, new Date('2026-09-25T10:00:00Z'), 'Mochi Air: flight', match)

describe('metres', () => {
  it('is position undone', () => {
    for (const [x, z] of [
      [0, 0],
      [12345.6, -9876.5],
      [-120000, 80000],
    ]) {
      const p = position(x, z)
      const back = metres(p.longitude, p.latitude)
      expect(back.x).toBeCloseTo(x, 6)
      expect(back.z).toBeCloseTo(z, 6)
    }
  })
})

describe('parse', () => {
  it('reads back every sample where the recorder wrote it, and the header', () => {
    const text = record(
      [
        {
          time: 0,
          objects: [
            jet({ x: 1000, y: 300, z: -2000, roll: -10, pitch: 5, yaw: 70 }),
          ],
        },
        {
          time: 0.1,
          objects: [
            jet({ x: 1008, y: 301, z: -2003, roll: -12, pitch: 5.5, yaw: 71 }),
          ],
        },
      ],
      { start: 'case1', tod: 'dusk' }
    )
    const p = parse(text)
    expect(p.times).toEqual([0, 0.1])
    expect(p.duration).toBeCloseTo(0.1, 6)
    expect(p.own).toBe(1)
    expect(p.information.Match_start).toBe('case1')
    expect(p.information.Match_tod).toBe('dusk')
    expect(p.information.Title).toBe('Mochi Air: flight')
    const [pose] = scene(p, 0)
    // Seven decimal places of a degree is about a centimetre; altitude and the angles are written to 0.1.
    expect(pose.x).toBeCloseTo(1000, 1)
    expect(pose.z).toBeCloseTo(-2000, 1)
    expect(pose.y).toBeCloseTo(300, 1)
    expect(pose.roll).toBeCloseTo(-10, 1)
    expect(pose.pitch).toBeCloseTo(5, 1)
    expect(pose.yaw).toBeCloseTo(70, 1)
    expect(pose.properties.Name).toBe('FA-18C')
    expect(pose.properties.Pilot).toBe('Viper')
  })

  it('carries a property the writer suppressed forward to the samples that did not repeat it', () => {
    const data = { gear: 0, flaps: 2, trim: 0, hook: 1 }
    const text = record(
      [0, 0.1, 0.2, 0.3].map((time) => ({ time, objects: [jet({ data })] }))
    )
    // Written once, on the first sample.
    expect(text.match(/Gear=/g)?.length).toBe(1)
    expect(text.match(/Hook=1/g)?.length).toBe(1)
    const p = parse(text)
    const [late] = scene(p, 0.3)
    expect(number(late.properties, 'Gear', 1)).toBe(0)
    expect(number(late.properties, 'Flaps', 0)).toBe(2)
    expect(number(late.properties, 'Hook', 0)).toBe(1)
  })

  it('writes the speed brake only as it moves, and reads it back blended between samples', () => {
    const board = [0, 0, 0.4, 0.8, 1, 1, 1]
    const text = record(
      board.map((speedbrake, k) => ({
        time: k / 10,
        objects: [jet({ data: { speedbrake } })],
      }))
    )
    // Written on the first sample and on each that moved, not while it rests.
    expect(text.match(/SpeedBrake=/g)?.length).toBe(4)
    const p = parse(text)
    const at = (t: number) =>
      number(scene(p, t)[0].properties, 'SpeedBrake', -1)
    expect(at(0.05)).toBe(0)
    expect(at(0.25)).toBeCloseTo(0.6, 5)
    expect(at(0.55)).toBe(1) // carried forward from the sample that last wrote it
  })

  it('raises a message on its own sample only, and carries the coaching and the loadout', () => {
    const stores = JSON.stringify({ '1': { fixture: 'rail', stores: ['9m'] } })
    const p = parse(
      record([
        {
          time: 0,
          objects: [
            jet({
              data: {
                radio: ['#8fd0ff Tower, 701; ready \\ out'],
                notice: ['BINGO FUEL', 'FUEL LO'],
                coach: ['Gear down, hook down'],
                stores,
              },
            }),
          ],
        },
        {
          time: 0.1,
          objects: [jet({ data: { coach: ['Gear down, hook down'], stores } })],
        },
      ])
    )
    const [first, second] = p.tracks.get(1)!.frames
    expect(items(first.properties.Radio)).toEqual([
      '#8fd0ff Tower, 701; ready \\ out',
    ])
    expect(items(first.properties.Notice)).toEqual(['BINGO FUEL', 'FUEL LO'])
    expect(second.properties.Radio).toBeUndefined()
    expect(second.properties.Notice).toBeUndefined()
    expect(items(second.properties.Coach)).toEqual(['Gear down, hook down'])
    expect(JSON.parse(second.properties.Stores)).toEqual(JSON.parse(stores))
    expect(items(undefined)).toEqual([])
    expect(items('')).toEqual([])
  })

  it('follows the first aircraft when the recording has no own jet', () => {
    const text = record([
      {
        time: 0,
        objects: [
          jet({ id: 0x2c, kind: 'Weapon+Missile', name: 'AIM-9M' }),
          jet({ id: 0x0b, colour: 'Red' }),
        ],
      },
    ])
    expect(parse(text).own).toBe(0x0b)
  })

  it('is empty for text that holds no samples, and skips a line it cannot read', () => {
    expect(parse('').duration).toBe(0)
    expect(scene(parse(''), 3)).toEqual([])
    expect(parse('not a recording\nat all').tracks.size).toBe(0)
    const text = record([{ time: 0, objects: [jet()] }]).replace(
      '#0\n',
      '#0\nzz,T=||\n,,,\n'
    )
    expect(parse(text).tracks.size).toBe(1)
    // A Windows line ending is still a line ending.
    expect(
      parse(
        record([{ time: 0, objects: [jet()] }]).replace(/\n/g, '\r\n')
      ).tracks.get(1)?.frames[0].properties.Name
    ).toBe('FA-18C')
  })
})

describe('scene', () => {
  const two = (a: Partial<Recorded>, b: Partial<Recorded>) =>
    parse(
      record([
        { time: 0, objects: [jet(a)] },
        { time: 0.1, objects: [jet(b)] },
      ])
    )

  it('interpolates between samples, and gives the velocity the samples imply', () => {
    const p = two({ x: 0, y: 100, z: 0 }, { x: 20, y: 101, z: -10 })
    const [pose] = scene(p, 0.05)
    expect(pose.x).toBeCloseTo(10, 1)
    expect(pose.y).toBeCloseTo(100.5, 1)
    expect(pose.z).toBeCloseTo(-5, 1)
    expect(pose.vx).toBeCloseTo(200, 0)
    expect(pose.vy).toBeCloseTo(10, 0)
    expect(pose.vz).toBeCloseTo(-100, 0)
  })

  it('turns through north the short way, for the heading and the bank alike', () => {
    const [pose] = scene(
      two({ yaw: 358, roll: 179 }, { yaw: 2, roll: -179 }),
      0.05
    )
    expect(pose.yaw).toBeCloseTo(0, 0)
    expect(Math.abs(pose.roll)).toBeCloseTo(180, 0)
  })

  it('crosses the seam of a wrapped world rather than sweeping back across it', () => {
    const wrap = 250000
    const [pose] = scene(two({ x: 124990 }, { x: -124990 }), 0.05, wrap)
    expect(Math.abs(pose.x)).toBeGreaterThan(124990)
    expect(pose.vx).toBeCloseTo(200, 0)
  })

  it('gives a steady velocity through the writer’s rounding, and one that carries across a sample', () => {
    // A 4.73 m/s climb at 70 m/s, sampled at 10 Hz: the writer rounds altitude
    // to a decimetre, so the step between two samples reads 4 or 5 m/s by turns.
    const climb = parse(
      record(
        Array.from({ length: 40 }, (_, k) => ({
          time: k / 10,
          objects: [jet({ x: 70 * (k / 10), y: 300 + 4.73 * (k / 10) })],
        }))
      )
    )
    let previous: number | null = null
    let jump = 0
    for (let t = 0.5; t < 3.4; t += 1 / 60) {
      const [pose] = scene(climb, t)
      expect(pose.vy).toBeGreaterThan(4.53)
      expect(pose.vy).toBeLessThan(4.93)
      expect(pose.vx).toBeCloseTo(70, 0)
      if (previous !== null) jump = Math.max(jump, Math.abs(pose.vy - previous))
      previous = pose.vy
    }
    // Frame to frame the vertical speed moves by hundredths, not the metre a second a raw difference steps by.
    expect(jump).toBeLessThan(0.1)
    // Either side of a sample the velocity is the same.
    const [early] = scene(climb, 1.9999)
    const [late] = scene(climb, 2.0001)
    expect(Math.abs(early.vy - late.vy)).toBeLessThan(0.01)
  })

  it('never fits a velocity across the gap where an object was not recorded', () => {
    const bandit = (x: number) => jet({ id: 2, x, colour: 'Red' })
    const p = parse(
      record([
        { time: 0, objects: [jet(), bandit(0)] },
        { time: 0.1, objects: [jet(), bandit(10)] },
        { time: 0.2, objects: [jet(), bandit(20)] },
        { time: 0.3, objects: [jet()] },
        { time: 0.4, objects: [jet()] },
        { time: 0.5, objects: [jet(), bandit(5000)] },
        { time: 0.6, objects: [jet(), bandit(5010)] },
      ])
    )
    const at = (t: number) => scene(p, t).find((pose) => pose.id === 2)!
    expect(at(0.2).vx).toBeCloseTo(100, 0)
    expect(at(0.5).vx).toBeCloseTo(100, 0)
  })

  it('blends the channels a replay reads as quantities, and leaves a switch where it was', () => {
    const p = parse(
      record([
        {
          time: 0,
          objects: [
            jet({ data: { aoa: 5, beta: -2, yawrate: 10, g: 1, flaps: 0 } }),
          ],
        },
        {
          time: 0.1,
          objects: [
            jet({ data: { aoa: 7, beta: 4, yawrate: 30, g: 2, flaps: 2 } }),
          ],
        },
      ])
    )
    const [pose] = scene(p, 0.05)
    expect(number(pose.properties, 'AOA', 0)).toBeCloseTo(6, 5)
    expect(number(pose.properties, 'Beta', 0)).toBeCloseTo(1, 5)
    expect(number(pose.properties, 'YawRate', 0)).toBeCloseTo(20, 5)
    expect(number(pose.properties, 'G', 0)).toBeCloseTo(1.5, 5)
    expect(number(pose.properties, 'Flaps', -1)).toBe(0)
  })

  it('blends the control surfaces number by number, and the hands on the controls', () => {
    const d = Math.PI / 180
    const p = parse(
      record([
        {
          time: 0,
          objects: [
            jet({
              data: { surfaces: [0, 0, 10 * d, 10 * d, -4 * d, 0], stick: 0 },
            }),
          ],
        },
        {
          time: 0.1,
          objects: [
            jet({
              data: {
                surfaces: [4 * d, 4 * d, 20 * d, 20 * d, 4 * d, 0],
                stick: 0.5,
              },
            }),
          ],
        },
      ])
    )
    const [pose] = scene(p, 0.05)
    expect(pose.properties.Surfaces.split('|').map(Number)).toEqual([
      2, 2, 15, 15, 0, 0,
    ])
    expect(number(pose.properties, 'Stick', -1)).toBeCloseTo(0.25, 5)
  })

  it('shows an object only while it is recorded, and marks its last sample', () => {
    const missile = { id: 0x80, kind: 'Weapon+Missile', name: 'AIM-9M' }
    const p = parse(
      record([
        { time: 0, objects: [jet()] },
        { time: 0.1, objects: [jet(), jet(missile)] },
        { time: 0.2, objects: [jet(), jet({ ...missile, x: 50 })] },
        { time: 0.3, objects: [jet()] },
      ])
    )
    const ids = (t: number) =>
      scene(p, t)
        .map((pose) => pose.id)
        .sort((a, b) => a - b)
    expect(ids(0.05)).toEqual([1])
    expect(ids(0.15)).toEqual([1, 0x80])
    expect(ids(0.25)).toEqual([1, 0x80])
    expect(ids(0.35)).toEqual([1])
    const last = scene(p, 0.2).find((pose) => pose.id === 0x80)!
    expect(last.final).toBe(true)
    expect(scene(p, 0.1).find((pose) => pose.id === 0x80)!.final).toBe(false)
    // Past the end the recording holds its last sample.
    expect(scene(p, 9).map((pose) => pose.id)).toEqual([1])
  })
})
