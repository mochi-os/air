// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { describe, expect, it } from 'vitest'
import { type Contract, deflectors, followers, layout, STATIONS, stations } from './ship'

// A small deck: a landing line angled to port, one wire whose pendant runs
// between sheaves 16 m to port and 18 to starboard of where it crosses the
// line, a port elevator, a lens and a hull 30 m across at the stern
const contract: Contract = {
  deck: {
    height: 18.27,
    outline: [
      [-100, -30],
      [100, -30],
      [100, 30],
      [-100, 30],
    ],
  },
  catapults: [
    {
      x: 40,
      z: 5,
      heading: 2,
      stroke: 90,
      speed: 100,
      deflector: { x: 30, z: 5, width: 10, depth: 4, heading: 0 },
    },
  ],
  landing: {
    line: [
      [-90, 0],
      [10, -10],
    ],
    wires: [
      {
        number: 1,
        x: 30,
        ends: [
          [-61.6, 18.35, -13.0 - 15.9],
          [-58.0, 18.35, -13.0 + 18.0],
        ],
      },
    ],
    target: 1,
  },
  lens: {
    position: [-20, 18.9, -28],
    facing: [-1, 0, 0],
    cells: 12,
    pitch: 0.165,
    lights: { datum: [], cut: [], waveoff: [] },
  },
  elevators: [
    {
      number: 3,
      side: 'port',
      outline: [
        [-60, -20],
        [-40, -20],
        [-38, -30],
        [-62, -30],
      ],
    },
  ],
  texture: { x: [-110, 110], z: [-35, 35] },
  hull: {
    draught: 11.5,
    screws: { lateral: [6, 13], diameter: 6.4 },
    entrance: 13.5,
    waterline: {
      stern: -90,
      stem: 95,
      half: [
        [-90, 15],
        [0, 15],
        [80, 5],
      ],
    },
  },
}

describe('layout', () => {
  const read = layout(contract)

  it('keeps the deck, the catapults and their deflectors, and the end speed a shot is capped at', () => {
    expect(read.deck).toBe(18.27)
    expect(read.outline).toEqual(contract.deck.outline)
    expect(read.catapults[0]).toEqual({
      x: 40,
      z: 5,
      heading: 2,
      stroke: 90,
      speed: 100,
      deflector: { x: 30, z: 5, width: 10, depth: 4, heading: 0 },
    })
  })

  it('finds where each pendant crosses the landing line, and keeps its ends', () => {
    // the line runs z = -(x + 90) / 10; the pendant from (-61.6, -28.9) to (-58, 5)
    const t =
      (-28.9 + (-61.6 + 90) / 10) /
      (-28.9 + (-61.6 + 90) / 10 - (5 + (-58 + 90) / 10))
    expect(read.landing.wires[0]).toBeCloseTo(-61.6 + 3.6 * t, 6)
    expect(read.landing.ends).toEqual([contract.landing.wires[0].ends])
    expect(read.landing.span).toBeCloseTo(Math.hypot(3.6, 33.9), 6)
    expect(read.landing.target).toBe(1)
  })

  it('passes the lights, the lens and the parking spot through', () => {
    const lights = {
      centreline: {
        positions: [[-80, 18.27, -1] as [number, number, number]],
        colour: 'white',
        kind: 'recovery',
      },
    }
    const parked = layout({
      ...contract,
      lights,
      parking: { x: -70, z: 20, heading: 0 },
    })
    expect(parked.lights).toEqual(lights)
    expect(parked.lens).toEqual(contract.lens)
    expect(parked.parking).toEqual({ x: -70, z: 20, heading: 0 })
    expect(read.lights).toEqual({})
    expect(read.parking).toBeUndefined()
    expect(read.joints).toEqual({})
    const slide = {
      motion: 'slide',
      axis: [1, 0, 0] as [number, number, number],
      drive: 'the launch',
      keys: [
        [0, 0],
        [1, 90],
      ] as [number, number][],
    }
    expect(
      layout({ ...contract, joints: { catapult_1_shuttle: slide } }).joints
    ).toEqual({ catapult_1_shuttle: slide })
  })

  it('takes the lens from its position and the elevators by their outboard sides', () => {
    expect(read.ols).toEqual({ x: -20, z: -28, model: false })
    expect(read.elevators).toEqual([{ aft: -62, forward: -38, side: -1 }])
  })

  it('gives the waterline at evenly spaced stations, closing to nothing at the stem', () => {
    const w = read.waterline!
    expect([w.stern, w.stem, w.sides.length]).toEqual([-90, 95, STATIONS])
    expect(w.sides[0]).toEqual([-15, 15])
    expect(w.sides[STATIONS - 1]).toEqual([-0, 0])
    // the station nearest x 80 lies between it and the stem, tapering from 5 to 0
    const step = 185 / (STATIONS - 1)
    const i = Math.ceil((80 + 90) / step)
    const x = -90 + i * step
    expect(w.sides[i][1]).toBeCloseTo((5 * (95 - x)) / 15, 6)
    expect(read.draught).toBe(11.5)
    expect(read.entrance).toBe(13.5)
    expect(read.screws).toEqual({ lateral: [6, 13], diameter: 6.4 })
  })

  it('stands the catapult control stations up by their last key, along their axes, and nothing else', () => {
    const raised = stations({
      catapult_console_bow: { motion: 'slide', axis: [0, 1, 0], drive: '', keys: [[0, 0], [1, 0.72]] },
      catapult_console_waist: { motion: 'slide', axis: [0, 1, 0], drive: '', keys: [[0, 0], [1, 0.67]] },
      catapult_1_shuttle: { motion: 'slide', axis: [1, 0, 0], drive: '', keys: [[0, 0], [1, 90]] },
      catapult_1_deflector: { motion: 'rotate', axis: [0, 0, 1], drive: '', keys: [[0, 0], [1, 0.87]] },
    })
    expect(raised).toEqual({ catapult_console_bow: [0, 0.72, 0], catapult_console_waist: [0, 0.67, 0] })
  })

  it('groups the joints that follow another by the joint they follow, in name order, and lays them out', () => {
    const joints = {
      catapult_1_deflector: { motion: 'rotate', axis: [0, 0, 1], drive: '', keys: [[0, 0], [1, 0.87]] },
      catapult_1_deflector_rod: { motion: 'rotate', axis: [0, 0, 1], drive: '', keys: [[0, 0], [0.87, -0.4]], follows: 'catapult_1_deflector' },
      catapult_1_deflector_crank: { motion: 'rotate', axis: [0, 0, 1], drive: '', keys: [[0, 0], [0.87, 1.2]], follows: 'catapult_1_deflector' },
      catapult_2_deflector_crank: { motion: 'rotate', axis: [0, 0, 1], drive: '', keys: [[0, 0], [0.87, 1.2]], follows: 'catapult_2_deflector' },
      catapult_1_shuttle: { motion: 'slide', axis: [1, 0, 0], drive: '', keys: [[0, 0], [1, 90]] },
    } as Contract['joints']
    const groups = {
      catapult_1_deflector: ['catapult_1_deflector_crank', 'catapult_1_deflector_rod'],
      catapult_2_deflector: ['catapult_2_deflector_crank'],
    }
    expect(followers(joints!)).toEqual(groups)
    expect(layout({ ...contract, joints }).followers).toEqual(groups)
    expect(layout(contract).followers).toEqual({})
  })

  it("poses every blast deflector at a share of its travel, its struts through their keys on its angle, and nothing else", () => {
    const joints = {
      catapult_1_deflector: { motion: 'rotate', axis: [0, 0, 1], drive: '', keys: [[0, 0], [0.5, 0.2], [1, 0.8]] },
      catapult_1_deflector_crank: { motion: 'rotate', axis: [0, 0, 1], drive: '', keys: [[0, 0], [0.8, 1.6]], follows: 'catapult_1_deflector' },
      catapult_2_deflector: { motion: 'rotate', axis: [0, 0, 1], drive: '', keys: [[0, 0], [1, 0.8]] },
      catapult_1_shuttle: { motion: 'slide', axis: [1, 0, 0], drive: '', keys: [[0, 0], [1, 90]] },
      catapult_console_bow: { motion: 'slide', axis: [0, 1, 0], drive: '', keys: [[0, 0], [1, 0.72]] },
    } as Contract['joints']
    const ship = layout({ ...contract, joints })
    expect(deflectors(ship, 0)).toEqual({ catapult_1_deflector: 0, catapult_1_deflector_crank: 0, catapult_2_deflector: 0 })
    const half = deflectors(ship, 0.5)
    expect(half.catapult_1_deflector).toBeCloseTo(0.2)
    expect(half.catapult_1_deflector_crank).toBeCloseTo(0.4)   // its keys at the panel's 0.2
    expect(half.catapult_2_deflector).toBeCloseTo(0.4)
    expect(deflectors(ship, 1)).toEqual({ catapult_1_deflector: 0.8, catapult_1_deflector_crank: 1.6, catapult_2_deflector: 0.8 })
  })
})
