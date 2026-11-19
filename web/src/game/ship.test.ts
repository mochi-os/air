// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { type Contract, type Deck, deflectors, followers, foul, glide, HOOK, layout, lit, meatball, raising, STATIONS, stations, view } from './ship'

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

  it('leaves a housed lens to the model: the engine draws only its lights', () => {
    expect(
      layout({ ...contract, lens: { ...contract.lens!, housed: true } }).ols
    ).toEqual({ x: -20, z: -28, model: true })
  })

  it("passes the deck's vehicles through as the core collides with them, and none where the file has none", () => {
    const tractor = {
      kind: 'tractor',
      outline: [
        [38.5, 9.0],
        [41.5, 9.0],
        [41.5, 11.0],
        [38.5, 11.0],
      ] as [number, number][],
      top: 20.6,
    }
    expect(layout({ ...contract, vehicles: [tractor] }).vehicles).toEqual([
      tractor,
    ])
    expect(read.vehicles).toEqual([])
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

  it("poses every blast deflector seconds into its raise, its struts through their keys on its angle, and nothing else", () => {
    const joints = {
      catapult_1_deflector: { motion: 'rotate', axis: [0, 0, 1], drive: '', keys: [[0, 0], [0.5, 0.2], [1.5, 0.8]] },
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
    expect(deflectors(ship, 1.5)).toEqual({ catapult_1_deflector: 0.8, catapult_1_deflector_crank: 1.6, catapult_2_deflector: 0.8 })
    expect(raising(ship)).toBe(1.5)   // the slowest deflector's raise, not the shuttle's or the console's travel
    expect(raising(layout(contract))).toBe(0)
  })
})

describe('meatball', () => {
  // The fixture's one wire is its target: the touchdown where it crosses the
  // landing line. An eye placed along the approach (aft along the line), to
  // its side and up.
  const ship = layout(contract)
  const [aft, forward] = ship.landing.line
  const x = ship.landing.wires[0]
  const z =
    aft[1] + ((forward[1] - aft[1]) * (x - aft[0])) / (forward[0] - aft[0])
  const length = Math.hypot(aft[0] - forward[0], aft[1] - forward[1])
  const a = [(aft[0] - forward[0]) / length, (aft[1] - forward[1]) / length]
  const eye = (
    along: number,
    across: number,
    height: number
  ): [number, number, number] => [
    x + a[0] * along - a[1] * across,
    height,
    z + a[1] * along + a[0] * across,
  ]
  // the eye's height that puts the hook (4 m under it, 9 m aft) a number of
  // degrees off the 3.5° glideslope
  const on = (along: number, off = 0) =>
    ship.deck + 4 + Math.tan(((3.5 + off) * Math.PI) / 180) * (along + 9)
  const travel = (12 * 0.165) / 2

  it('centres the ball on the datum for a hook on the glideslope, the datum lit', () => {
    const seen = meatball(ship, eye(800, 0, on(800)))
    expect(seen.lit).toBe(true)
    expect(seen.ball?.height).toBeCloseTo(18.9, 6)
    expect(seen.ball?.low).toBe(false)
  })

  it('takes the ball to the column end at 0.8°, and turns it red past 0.7° low', () => {
    expect(meatball(ship, eye(800, 0, on(800, 0.4))).ball?.height).toBeCloseTo(
      18.9 + travel / 2,
      6
    )
    expect(meatball(ship, eye(800, 0, on(800, 2))).ball?.height).toBeCloseTo(
      18.9 + travel,
      6
    )
    const low = meatball(ship, eye(800, 0, on(800, -0.75))).ball
    expect(low?.low).toBe(true)
    expect(low?.height).toBeCloseTo(18.9 - (travel * 0.75) / 0.8, 6)
    expect(meatball(ship, eye(800, 0, on(800, -0.65))).ball?.low).toBe(false)
  })

  it('lights the datum only in the wedge astern, and shows the ball only on an approach', () => {
    expect(
      meatball(ship, eye(800, 800 * Math.tan((39 * Math.PI) / 180), 200)).lit
    ).toBe(true)
    expect(
      meatball(ship, eye(800, 800 * Math.tan((41 * Math.PI) / 180), 200)).lit
    ).toBe(false)
    expect(meatball(ship, eye(-300, 0, 200))).toEqual({
      lit: false,
      ball: null,
    }) // ahead of the touchdown
    expect(meatball(ship, eye(30, 0, 25)).ball).toBeNull() // within 40 m
    expect(meatball(ship, eye(6000, 0, 400))).toEqual({ lit: true, ball: null }) // past 5 km, inside 7
    expect(meatball(ship, eye(800, 0, ship.deck - 1)).ball).toBeNull() // under the deck
  })
})

// The pilot's lens in the game is drawn by the engine (update_ols), from the
// same rule meatball draws the viewer's by: ship.ts view. engine.ts cannot be
// imported, so the two functions are lifted from its source and run against a
// stand-in lens.
describe("the pilot's lens", () => {
  const engine = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
  const lift = (name: string) => {
    const start = engine.indexOf(`\nfunction ${name}(`) + 1
    expect(start, name).toBeGreaterThan(0)
    return engine.slice(start, engine.indexOf('\n}\n', start) + 3) // both close on a line of their own
  }
  // shown flies the engine's lens for an eye `along` astern of a touchdown at
  // the origin (the approach from the south), `across` it, `above` the deck
  const shown = (along: number, across: number, above: number, climb = 0) => {
    const points = () => ({ visible: false, geometry: { attributes: { position: { setY(_: number, y: number) { this.y = y }, y: 0, needsUpdate: false }, color: { setXYZ(_: number, _r: number, g: number) { this.g = g }, g: 0, needsUpdate: false } } } })
    const o = { tdx: 0, tdz: 0, apx: 0, apz: 1, dy: 20, datumY: 18.9, travel: 1, datumPts: points(), ballPts: points(), wavePts: points() }
    new Function('carrier_ols', 'ownship', 'ship_glide', 'ship_view', 'THREE', 'sim_time', `${lift('ols_dev')}${lift('update_ols')} update_ols({ x: ${across}, y: ${20 + above}, z: ${along} })`)(
      o, { vely: climb, waving: false }, glide, view, {}, 0)
    return { lit: o.datumPts.visible, ball: o.ballPts.visible ? o.ballPts.geometry.attributes.position.y - 18.9 : null, red: o.ballPts.geometry.attributes.color.g < 0.5 }
  }
  const on = (along: number, off = 0) => HOOK.below + Math.tan(((3.5 + off) * Math.PI) / 180) * (along + HOOK.aft)
  it('shows what view shows: the wedge at 40° exactly, the ball and its red', () => {
    expect(shown(800, 800 * Math.tan((39.99 * Math.PI) / 180), 200).lit).toBe(true)
    expect(shown(800, 800 * 0.8395, 200).lit, 'past 40°, where a second copy of the rule read 0.84').toBe(false)
    expect(shown(800, 0, on(800)).ball).toBeCloseTo(0, 6)
    expect(shown(800, 0, on(800, 0.4)).ball).toBeCloseTo(0.5, 6)
    expect([shown(800, 0, on(800, -0.75)).red, shown(800, 0, on(800, -0.65)).red]).toEqual([true, false])
    expect(glide(on(800, 0.4), 800)).toBeCloseTo(0.4, 9)
  })
  it('takes the ball away from a jet climbing off the approach', () => {
    expect(shown(800, 0, on(800), 5).ball).toBeNull()
    expect(shown(800, 0, on(800), 5).lit).toBe(true)
  })
})

describe('lit', () => {
  // The fixture's landing line runs from (-90, 0) to (10, -10): a point a
  // distance along it and across it, to starboard
  const ship = layout(contract)
  const [[ax, az], [bx, bz]] = ship.landing.line
  const length = Math.hypot(bx - ax, bz - az)
  const [ux, uz] = [(bx - ax) / length, (bz - az) / length]
  const at = (along: number, across: number): [number, number] => [
    ax + ux * along - uz * across,
    az + uz * along + ux * across,
  ]
  const deck = (d: Partial<Deck>): Deck => ({
    dark: true,
    closed: false,
    aboard: null,
    ...d,
  })
  const group = (kind: string, colour: string) => ({
    positions: [],
    colour,
    kind,
  })

  it('lights the recovery aids at night while the deck is open, and puts them out when it closes', () => {
    const recovery = group('recovery', 'white')
    expect(lit(recovery, ship, deck({}))).toBe('white')
    expect(lit(recovery, ship, deck({ closed: true }))).toBeNull()
    expect(lit(recovery, ship, deck({ aboard: at(50, 0) }))).toBe('white') // foul only: lit
    expect(lit(recovery, ship, deck({ dark: false }))).toBeNull()
  })

  it('burns the outline and the navigation lights all night, open or closed', () => {
    for (const kind of ['outline', 'navigation']) {
      expect(lit(group(kind, 'blue'), ship, deck({ closed: true }))).toBe(
        'blue'
      )
      expect(lit(group(kind, 'blue'), ship, deck({ dark: false }))).toBeNull()
    }
  })

  it('lights the floods only at night with the jet aboard', () => {
    const flood = group('flood', 'green')
    expect(lit(flood, ship, deck({ aboard: [60, 20] }))).toBe('green')
    expect(lit(flood, ship, deck({}))).toBeNull()
    expect(lit(flood, ship, deck({ dark: false, aboard: [60, 20] }))).toBeNull()
  })

  it('shows the beacons and the status lights green on a clear deck and red on a foul one, by day too', () => {
    for (const kind of ['beacon', 'status']) {
      const signal = group(kind, 'red')
      expect(lit(signal, ship, deck({ dark: false }))).toBe('green')
      expect(lit(signal, ship, deck({ closed: true }))).toBe('red')
      expect(lit(signal, ship, deck({ dark: false, aboard: at(50, 0) }))).toBe(
        'red'
      )
      expect(lit(signal, ship, deck({ aboard: [60, 20] }))).toBe('green') // aboard, off the landing area
    }
  })

  it("fouls the deck with the jet within the landing area's 40 ft of the line, between its ends", () => {
    expect(foul(ship, deck({ aboard: at(50, 12.1) }))).toBe(true)
    expect(foul(ship, deck({ aboard: at(50, -12.1) }))).toBe(true)
    expect(foul(ship, deck({ aboard: at(50, 12.3) }))).toBe(false)
    expect(foul(ship, deck({ aboard: at(1, 0) }))).toBe(true)
    expect(foul(ship, deck({ aboard: at(-1, 0) }))).toBe(false) // aft of the ramp
    expect(foul(ship, deck({ aboard: at(length + 1, 0) }))).toBe(false) // past the line's forward end
    expect(foul(ship, deck({ closed: true }))).toBe(true)
    expect(foul(ship, deck({}))).toBe(false)
  })

  it('lights no group of a kind it does not know', () => {
    expect(lit(group('parking', 'white'), ship, deck({}))).toBeNull()
  })
})
