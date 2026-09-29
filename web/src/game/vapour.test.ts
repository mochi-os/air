// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { humidity, shows, vapour, type Flight } from './vapour'

const cruise: Flight = { alpha: 3, g: 1, speed: 180, mach: 0.55 }

describe('the sky', () => {
  it('is moist under its cloud, saturated in it and dry above it', () => {
    expect(humidity('cumulus', 0)).toBeCloseTo(0.75, 6)
    expect(humidity('cumulus', 300)).toBeGreaterThan(0.75)
    expect(humidity('cumulus', 1000)).toBeCloseTo(0.98, 6)
    expect(humidity('cumulus', 5000)).toBeCloseTo(0.35, 6)
    expect(humidity('low_stratus', 400)).toBe(1)
  })

  it('never quite saturates in a clear sky, and is dry at a joust’s 15,000 ft', () => {
    expect(humidity('none', 1800)).toBeCloseTo(0.85, 6)
    expect(humidity('none', 4572)).toBeCloseTo(0.35, 6)
    expect(humidity('no such preset', 0)).toBeCloseTo(0.75, 6)
  })
})

describe('condensation', () => {
  it('needs both a strong enough flow and moist enough air', () => {
    expect(shows(0, 1)).toBe(0)
    expect(shows(1, 0.35)).toBe(0) // dry air aloft: nothing, however hard the pull
    expect(shows(1, 0.75)).toBeGreaterThan(0.5) // moist air low down: a strong core shows
    expect(shows(0.2, 0.75)).toBeLessThan(shows(1, 0.75))
    expect(shows(0.5, 0.75)).toBeLessThan(shows(0.5, 0.98))
  })
})

describe('the vapour a jet shows', () => {
  it('shows nothing cruising, or parked', () => {
    const v = vapour(cruise, 0.98, 500)
    expect(v.lex + v.tips + v.flaps + v.collar + v.wing + v.film).toBe(0)
    const parked = vapour({ alpha: 30, g: 1, speed: 0, mach: 0 }, 1, 0)
    expect(parked.lex + parked.tips).toBe(0)
  })

  it('draws the LEX ropes at high alpha, and the tip streamers at high lift', () => {
    const pulling = vapour(
      { alpha: 22, g: 6, speed: 150, mach: 0.45 },
      0.75,
      300
    )
    expect(pulling.lex).toBeGreaterThan(0.5)
    expect(pulling.tips).toBeGreaterThan(0.5)
    expect(pulling.collar).toBe(0)
  })

  it('draws the flap edges slow at high lift, as on approach, and not fast', () => {
    const approach = vapour(
      { alpha: 8.1, g: 1.2, speed: 70, mach: 0.21 },
      0.98,
      150
    )
    expect(approach.flaps).toBeGreaterThan(0.3)
    const fast = vapour({ alpha: 12, g: 7, speed: 200, mach: 0.6 }, 0.98, 150)
    expect(fast.flaps).toBe(0)
  })

  it('draws the transonic cloud around Mach 1 low down, and loses it well above', () => {
    const below = vapour({ alpha: 2, g: 1, speed: 300, mach: 0.88 }, 0.75, 100)
    const near = vapour({ alpha: 2, g: 1, speed: 330, mach: 0.97 }, 0.75, 100)
    const beyond = vapour({ alpha: 2, g: 1, speed: 420, mach: 1.25 }, 0.75, 100)
    expect(below.collar).toBe(0)
    expect(near.collar).toBeGreaterThan(0.5)
    expect(beyond.collar).toBe(0)
    expect(near.edge).toBeGreaterThan(below.edge) // the shock stands further aft
  })

  it('lays a film over the wings in a hard pull in wet air, and none cruising or in dry air', () => {
    const pull = vapour({ alpha: 14, g: 7, speed: 170, mach: 0.5 }, 0.9, 300)
    expect(pull.film).toBeGreaterThan(0.4)
    expect(vapour(cruise, 0.95, 300).film).toBe(0)
    expect(
      vapour({ alpha: 14, g: 7, speed: 170, mach: 0.5 }, 0.35, 4572).film
    ).toBe(0)
  })

  it('puts the sheet over the wing at a lower Mach under g', () => {
    const level = vapour({ alpha: 3, g: 1, speed: 290, mach: 0.86 }, 0.75, 100)
    const pulling = vapour(
      { alpha: 8, g: 5, speed: 290, mach: 0.86 },
      0.75,
      100
    )
    expect(pulling.wing).toBeGreaterThan(level.wing)
    expect(pulling.wing).toBeGreaterThan(0.2)
  })

  it('shows nothing in the dry air aloft', () => {
    const v = vapour(
      { alpha: 24, g: 7, speed: 180, mach: 0.97 },
      humidity('none', 4572),
      4572
    )
    expect(v.lex + v.tips + v.collar + v.wing).toBe(0)
  })
})

// engine.ts cannot be imported (WebGL at module scope): what draws the vapour
// is lifted out of its source and run against stand-ins.
const source = readFileSync(
  fileURLToPath(new URL('./engine.ts', import.meta.url)),
  'utf8'
)
// lift cuts one top-level function out of the source: from its head to the
// next line that starts at column 0 (the bodies are tab-indented).
function lift(name: string): string {
  const start = source.indexOf(`function ${name}(`)
  expect(start, `${name} in engine.ts`).toBeGreaterThan(0)
  const rest = source.slice(start)
  const end = /\n(?=\S)/.exec(rest.slice(1))
  return end ? rest.slice(0, end.index + 1) : rest
}

interface Vector {
  x: number
  y: number
  z: number
}
interface Jet {
  velx: number
  vely: number
  velz: number
  fwd: Vector
  up: Vector
  pos: Vector
  right: Vector
  aoa?: number
  gload?: number
  mach?: number
  vapour: {
    gone: { vx: number; vy: number; vz: number; g: number; primed: boolean }
  }
}
const D2R = Math.PI / 180
const STATE = { alpha: 0, nz: 1, mach: 2 }
const sound = (y: number) => Math.sqrt(1.4 * 287.053 * (288.15 - 0.0065 * y))
function jet(speed: number, alpha: number, extra: Partial<Jet> = {}): Jet {
  // level, nose along +x, flying alpha below the nose
  return {
    velx: speed * Math.cos(alpha * D2R),
    vely: -speed * Math.sin(alpha * D2R),
    velz: 0,
    fwd: { x: 1, y: 0, z: 0 },
    up: { x: 0, y: 1, z: 0 },
    pos: { x: 0, y: 300, z: 0 },
    right: { x: 0, y: 0, z: 1 },
    vapour: { gone: { vx: 0, vy: 0, vz: 0, g: 1, primed: false } },
    ...extra,
  }
}
function flight_for(
  others: {
    ownship?: object
    bandit?: object
    words?: number[] | null
    out?: number[] | null
  } = {}
) {
  return new Function(
    'ownship',
    'bandit',
    'bandit_words',
    'last_out',
    'STATE',
    'airspeed',
    'presented',
    'world_up',
    'D2R',
    'vapour_force',
    `${lift('vapour_flight')}\nreturn vapour_flight;`
  )(
    others.ownship ?? {},
    others.bandit ?? {},
    others.words ?? null,
    others.out ?? null,
    STATE,
    (m: number, y: number) => m * sound(y),
    (st: Jet) => st.pos,
    { x: 0, y: 1, z: 0 },
    D2R,
    null
  ) as (st: Jet, dt: number) => Flight
}

describe("what each jet's vapour is drawn for", () => {
  it("reads a remote's alpha and g off its pose, and its Mach from its speed", () => {
    const f = flight_for()(jet(250, 3, { aoa: 17, gload: 6.5 }), 1 / 60)
    expect(f.alpha).toBe(17)
    expect(f.g).toBe(6.5)
    expect(f.mach).toBeCloseTo(250 / sound(300), 6)
    expect(f.speed).toBeCloseTo(250, 6)
  })

  it("reads a replay's recorded Mach, and its alpha from its motion where the recording has none", () => {
    const f = flight_for()(
      jet(200, 11, { aoa: NaN, gload: NaN, mach: 0.93 }),
      1 / 60
    )
    expect(f.alpha).toBeCloseTo(11, 6)
    expect(f.mach).toBe(0.93)
  })

  it('reads the load factor from how the velocity turns when nothing carries it', () => {
    // a level turn at 5 g: banked so the lift is along the up axis, the
    // velocity turning at g*sqrt(n^2-1)/v
    const n = 5,
      v = 200,
      bank = Math.acos(1 / n),
      rate = (9.81 * Math.sqrt(n * n - 1)) / v
    const st = jet(v, 0, { aoa: NaN, gload: NaN })
    const flight = flight_for()
    let f: Flight = flight(st, 0)
    for (let k = 0; k <= 120; k++) {
      const heading = (rate * k) / 60
      st.velx = v * Math.cos(heading)
      st.velz = v * Math.sin(heading)
      st.vely = 0
      // up: tilted toward the centre of the turn (+z side of the velocity)
      const inward = { x: -Math.sin(heading), z: Math.cos(heading) }
      st.up = {
        x: inward.x * Math.sin(bank),
        y: Math.cos(bank),
        z: inward.z * Math.sin(bank),
      }
      st.fwd = { x: Math.cos(heading), y: 0, z: Math.sin(heading) }
      f = flight(st, 1 / 60)
    }
    expect(f.g).toBeCloseTo(n, 1)
  })

  it("reads the pilot's and the bandit's from their cores", () => {
    const ownship = jet(180, 2, { aoa: 21, gload: 7.2 })
    const own = flight_for({ ownship, out: [0, 0, 0.61] })(ownship, 1 / 60)
    expect([own.alpha, own.g, own.mach]).toEqual([21, 7.2, 0.61])
    const bandit = jet(180, 2)
    const theirs = flight_for({ bandit, words: [19 * D2R, 6.1, 0.58] })(
      bandit,
      1 / 60
    )
    expect(theirs.alpha).toBeCloseTo(19, 6)
    expect([theirs.g, theirs.mach]).toEqual([6.1, 0.58])
  })
})

describe('the streamers', () => {
  // A pool of puffs, as the engine's own, with the vapour pool's opacity.
  const make = new Function(
    `${lift('pool')}\n${lift('pool_spawn')}\nreturn { pool, pool_spawn };`
  )() as {
    pool: (max: number) => Puffs
    pool_spawn: (p: object) => number
  }
  interface Puffs {
    activeList: number[]
    px: Float32Array
    py: Float32Array
    pz: Float32Array
    vx: Float32Array
    vy: Float32Array
    vz: Float32Array
    ttl: Float32Array
    sz: Float32Array
    alpha: Float32Array
  }
  function puffs(): Puffs {
    const pool = make.pool(8000)
    pool.alpha = new Float32Array(8000)
    return pool
  }
  interface Shown {
    tips: number
    flaps: number
    lex: number
  }
  // The starboard LEX core: where it starts over the strake, where it leaves
  // the airframe, and how far outboard it runs per metre aft.
  const APEX = { x: 5.0, y: 0.35, z: 0.85 }
  const LEX = { x: -2.4, spread: 0.09, tail: 20, fade: 2.0 }
  function streamers(pool: object, air = { x: 0, z: 0 }) {
    return new Function(
      'THREE',
      'D2R',
      'pool_spawn',
      'vapour_pool',
      'contrail_mat',
      'body_offset',
      'world_up',
      'vapour_time',
      'vapour_air',
      'VAPOUR_TIP',
      'VAPOUR_FLAP',
      'vapour_light',
      `${lift('vapour_streamers')}\nreturn vapour_streamers;`
    )(
      THREE,
      D2R,
      make.pool_spawn,
      pool,
      { color: { r: 1, g: 1, b: 1 } },
      (st: Jet, x: number, y: number, z: number) => ({
        x: st.pos.x + x,
        y: st.pos.y + y,
        z: st.pos.z + z,
      }),
      { x: 0, y: 1, z: 0 },
      0,
      air,
      { x: -1.8, y: -0.45, z: 5.95 },
      { x: -2.1, y: -0.33, z: 3.95 },
      () => ({ r: 1, g: 1, b: 1 })
    ) as (st: Jet, shown: Shown, dt: number) => void
  }
  const none = { tips: 0, flaps: 0, lex: 0 }

  it('leave one line from each wingtip at any frame rate, a puff every 30 cm along the path', () => {
    const pool = puffs()
    streamers(pool)(jet(200, 0), { ...none, tips: 1 }, 1 / 20) // 10 m flown in the frame
    const port = pool.activeList.filter((i) => pool.pz[i] < 0),
      starboard = pool.activeList.filter((i) => pool.pz[i] > 0)
    expect(port.length).toBe(34)
    expect(starboard.length).toBe(34)
    const xs = starboard.map((i) => pool.px[i]).sort((a, b) => a - b)
    expect(xs[0]).toBeGreaterThanOrEqual(-1.8 - 10 - 0.01) // back along the frame's path, no further
    expect(xs[xs.length - 1]).toBeLessThanOrEqual(-1.8 + 1e-3)
  })

  it('leave nothing when nothing shows, or when the jet is barely moving', () => {
    const pool = puffs()
    streamers(pool)(jet(200, 0), none, 1 / 60)
    streamers(pool)(jet(20, 0), { tips: 1, flaps: 1, lex: 1 }, 1 / 60)
    expect(pool.activeList.length).toBe(0)
  })

  it('draw a marginal streamer fainter and thinner, never broken, and a strong one longer', () => {
    const faint = puffs(),
      strong = puffs()
    streamers(faint)(jet(200, 0), { ...none, tips: 0.3 }, 1 / 20)
    streamers(strong)(jet(200, 0), { ...none, tips: 1 }, 1 / 20)
    expect(faint.activeList.length).toBe(strong.activeList.length)
    const mean = (p: Puffs, field: 'alpha' | 'ttl' | 'sz') =>
      p.activeList.reduce((a, i) => a + p[field][i], 0) / p.activeList.length
    expect(mean(faint, 'alpha')).toBeLessThan(mean(strong, 'alpha') * 0.6)
    expect(mean(faint, 'sz')).toBeLessThan(mean(strong, 'sz'))
    expect(mean(strong, 'ttl')).toBeGreaterThan(mean(faint, 'ttl'))
  })

  it("take the engine's own core: from over the strake to the wing root's trailing edge, a little outboard", () => {
    const line = (name: string) =>
      source.slice(
        source.indexOf(name),
        source.indexOf('\n', source.indexOf(name))
      )
    const [apex, lex] = new Function(
      `${line('const VAPOUR_APEX=')}\n${line('const VAPOUR_LEX=')}\nreturn [VAPOUR_APEX, VAPOUR_LEX];`
    )() as [typeof APEX, typeof LEX]
    expect(apex).toEqual(APEX)
    expect(lex).toEqual(LEX)
    expect(lex.spread).toBeGreaterThan(0.02)
    expect(lex.spread).toBeLessThan(0.15)
    expect(lex.tail).toBeGreaterThan(5) // fading out behind the airframe over some metres
    expect(lex.tail).toBeLessThan(40) // not a long tail rigid on the jet
    expect(lex.fade).toBeLessThan(4) // gone within a few metres past its burst
  })

  it('are left in the air the jet flies through, drifting with the wind', () => {
    const pool = puffs()
    streamers(pool, { x: 9, z: -4 })(jet(200, 0), { ...none, tips: 1 }, 1 / 60)
    for (const i of pool.activeList) {
      expect(Math.abs(pool.vx[i] - 9)).toBeLessThan(0.31)
      expect(Math.abs(pool.vz[i] + 4)).toBeLessThan(0.31)
    }
  })
})

describe('the LEX ropes', () => {
  const APEX = { x: 5.0, y: 0.35, z: 0.85 },
    LEX = { x: -2.4, spread: 0.09, tail: 20, fade: 2.0 },
    LENGTH = APEX.x - LEX.x,
    FAR = -60 // a burst far behind the jet, past where the rope has faded
  const thin = (past: number) => Math.exp(-((past / LEX.fade) ** 2))
  const ROWS = Number(/const ROPE_ROWS=(\d+),/.exec(source)?.[1]),
    SIDES = Number(/ROPE_SIDES=(\d+);/.exec(source)?.[1])
  interface Row {
    x: number
    y: number
    z: number
    width: number
    alpha: number
  }
  // A rope's mesh as the engine fills it, without WebGL.
  function mesh(rows: number) {
    return {
      visible: false,
      geometry: {
        attributes: {
          position: {
            array: new Float32Array(rows * SIDES * 3),
            needsUpdate: false,
          },
          normal: {
            array: new Float32Array(rows * SIDES * 3),
            needsUpdate: false,
          },
          fade: { array: new Float32Array(rows * SIDES), needsUpdate: false },
        },
        drawn: 0,
        setDrawRange(_: number, count: number) {
          this.drawn = count
        },
        dispose() {},
      },
    }
  }
  function engine() {
    const camera = { position: new THREE.Vector3(0, 330, 40), fov: 60 }
    const made = new Function(
      'THREE',
      'D2R',
      'camera',
      'renderer',
      '_vapour_eye',
      '_vapour_turn',
      'VAPOUR_APEX',
      'VAPOUR_LEX',
      'ROPE_ROWS',
      'ROPE_SIDES',
      `${['rope_fill', 'vapour_burst', 'vapour_thin', 'vapour_point', 'vapour_core', 'vapour_ropes'].map(lift).join('\n')}\nreturn { rope_fill, vapour_burst, vapour_point, vapour_core, vapour_ropes };`
    )(
      THREE,
      D2R,
      camera,
      { domElement: { height: 900 } },
      new THREE.Vector3(),
      new THREE.Quaternion(),
      APEX,
      LEX,
      ROWS,
      SIDES
    )
    return made
  }
  const blank = (): Row[] =>
    Array.from({ length: ROWS }, () => ({ x: 0, y: 0, z: 0, width: 0, alpha: 0 }))
  const back = (i: number) => ((LENGTH + LEX.tail) * i) / (ROWS - 1)

  it('run in one straight line from the strake, climbing at half the alpha and running outboard, on behind the airframe without a bend', () => {
    const { vapour_core } = engine()
    for (const alpha of [12, 22, 30])
      for (const side of [1, -1]) {
        const rows = blank(),
          climb = Math.tan((alpha * D2R) / 2)
        expect(vapour_core(rows, side, 1, climb, FAR)).toBe(ROWS)
        rows.forEach((r, i) => {
          expect(r.x).toBeCloseTo(APEX.x - back(i), 9)
          expect(r.y).toBeCloseTo(APEX.y + climb * back(i), 9)
          expect(r.z).toBeCloseTo(side * (APEX.z + LEX.spread * back(i)), 9)
        })
        expect(rows[ROWS - 1].x).toBeCloseTo(LEX.x - LEX.tail, 9) // on past the airframe to where it has faded
      }
  })

  it('widen from a thin apex to their full width where they leave the airframe, and no wider behind it or past the burst', () => {
    const { vapour_core, vapour_point } = engine()
    for (const burst of [FAR, -1, 0]) {
      const rows = blank()
      vapour_core(rows, 1, 1, 0.2, burst)
      expect(rows[0].width).toBeCloseTo(0.2, 9)
      for (let i = 1; i < ROWS; i++)
        expect(rows[i].width).toBeGreaterThanOrEqual(rows[i - 1].width) // never narrowing
      for (let i = 0; i < ROWS; i++) {
        expect(rows[i].width).toBeLessThanOrEqual(0.7 + 1e-9) // never wider than where it leaves the airframe
        if (back(i) >= LENGTH) expect(rows[i].width).toBeCloseTo(0.7, 9)
      }
    }
    const step = 0.001,
      at = (b: number) => (vapour_point({}, b, 1, 1, 0.2, FAR) as Row).width
    expect(Math.abs((at(LENGTH) - at(LENGTH - step)) / step)).toBeLessThan(0.01) // its edge levels off where it leaves the airframe: no bend there
  })

  it('grow in from the apex and fade out to nothing behind the airframe, with no step or bend in their density', () => {
    const { vapour_core, vapour_point } = engine()
    const rows = blank()
    vapour_core(rows, 1, 0.8, 0.2, FAR)
    expect(rows[0].alpha).toBe(0) // growing in from the apex
    expect(rows[ROWS - 1].alpha).toBeCloseTo(0, 9) // gone at its end
    const whole = Math.min(1, 1.2 * 0.8)
    for (let i = 0; i < ROWS; i++) {
      if (back(i) >= 0.9 && back(i) <= LENGTH)
        expect(rows[i].alpha).toBeCloseTo(whole, 9) // whole over the airframe
      if (back(i) > LENGTH && i > 0)
        expect(rows[i].alpha).toBeLessThanOrEqual(rows[i - 1].alpha) // fading behind it
    }
    const step = 0.001,
      at = (b: number) => (vapour_point({}, b, 1, 0.8, 0.2, FAR) as Row).alpha
    expect(Math.abs((at(LENGTH + step) - at(LENGTH)) / step)).toBeLessThan(0.01) // fading in from where it leaves the airframe, not at once
    expect(at(LENGTH + LEX.tail / 2)).toBeCloseTo(whole / 2, 6) // half gone halfway
  })

  it('fizzle out within a few metres past the burst, easing in from it', () => {
    const { vapour_point } = engine()
    const burst = 0,
      whole = (b: number) => (vapour_point({}, b, 1, 1, 0.2, FAR) as Row).alpha
    for (const past of [0, 0.5, 1, 2, 3, 6]) {
      const b = APEX.x - burst + past,
        r = vapour_point({}, b, 1, 1, 0.2, burst) as Row
      expect(r.alpha).toBeCloseTo(whole(b) * thin(past), 9)
      expect(r.width).toBeCloseTo((vapour_point({}, b, 1, 1, 0.2, FAR) as Row).width, 9) // no wider for bursting
    }
    expect(thin(6)).toBeLessThan(0.05) // gone a few metres past the burst, as the pressure in the core recovers
    expect(thin(0.5)).toBeGreaterThan(0.75) // but not at once
    const step = 0.001,
      at = (b: number) => (vapour_point({}, b, 1, 1, 0.2, burst) as Row).alpha,
      point = APEX.x - burst
    expect((at(point + step) - at(point)) / step).toBeCloseTo((at(point) - at(point - step)) / step, 2) // no bend in its density at the burst
  })

  it('burst over the LEX at 35 degrees, at the wing root\'s trailing edge at 25, and ever further behind the jet below that', () => {
    const { vapour_burst } = engine()
    expect(vapour_burst(35)).toBeCloseTo(0, 9)
    expect(vapour_burst(45)).toBeCloseTo(0, 9) // no further forward
    expect(vapour_burst(25)).toBeCloseTo(LEX.x, 9)
    expect(vapour_burst(25.001)).toBeCloseTo(LEX.x, 2) // one position through 25 degrees, not a jump
    expect(vapour_burst(24.999)).toBeCloseTo(LEX.x, 2)
    expect(vapour_burst(18)).toBeLessThan(-20) // well behind the jet
    for (let a = 10; a < 40; a += 0.5)
      expect(vapour_burst(a + 0.5)).toBeGreaterThanOrEqual(vapour_burst(a))
  })

  it("are drawn on each jet while its LEX vapour shows, and hidden when it does not or the jet is barely moving", () => {
    const { vapour_ropes } = engine()
    const st = { ...jet(200, 20), group: { position: new THREE.Vector3(0, 300, 0), quaternion: new THREE.Quaternion() } },
      rig = { cores: [mesh(ROWS), mesh(ROWS)], rows: [blank(), blank()] }
    vapour_ropes(st, rig, { lex: 1 }, 20, FAR)
    for (const core of rig.cores) {
      expect(core.visible).toBe(true)
      expect(core.geometry.drawn).toBe((ROWS - 1) * SIDES * 6)
    }
    expect(rig.rows[0][5].z).toBeGreaterThan(0) // the starboard rope
    expect(rig.rows[1][5].z).toBeLessThan(0) // and the port
    expect(rig.rows[0][5].y).toBeCloseTo(APEX.y + Math.tan(10 * D2R) * back(5), 9) // climbing at half the alpha
    vapour_ropes(st, rig, { lex: 0 }, 20, FAR)
    expect(rig.cores.every((c) => !c.visible)).toBe(true)
    vapour_ropes({ ...st, ...jet(20, 20) }, rig, { lex: 1 }, 20, FAR)
    expect(rig.cores.every((c) => !c.visible)).toBe(true)
  })

  // A tube's rings, as rope_fill writes them: each row's points, its centre
  // and the direction its ring starts from.
  function rings(m: ReturnType<typeof mesh>, rows: Row[]) {
    const pos = m.geometry.attributes.position.array,
      nor = m.geometry.attributes.normal.array
    return rows.map((_, i) => {
      const points = Array.from({ length: SIDES }, (_, j) =>
        [0, 1, 2].map((c) => pos[(i * SIDES + j) * 3 + c])
      )
      const normals = Array.from({ length: SIDES }, (_, j) =>
        [0, 1, 2].map((c) => nor[(i * SIDES + j) * 3 + c])
      )
      return { points, normals, start: normals[0] }
    })
  }
  const dot = (a: number[], b: number[]) =>
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

  it('are round tubes, square to the rope and as wide as each row, their rings carried along without a twist', () => {
    const { rope_fill } = engine()
    const rows: Row[] = [
      [0, 0, 0],
      [0, 0, 0], // the core's end and this frame's row, on one point
      [-2, 0, 0],
      [-4, 0.5, 0.3],
      [-5, 2, 1.2],
      [-5.4, 4, 2.6],
      [-5.5, 6, 4.2], // bending up and round, out of any one plane
    ].map(([x, y, z], i) => ({ x, y, z, width: 0.6 + 0.2 * i, alpha: 0.8 }))
    const m = mesh(rows.length)
    rope_fill(m, rows, rows.length, { x: -5.8, y: 12, z: 9 }, 0.00001) // an eye looking straight down its last stretch
    const tube = rings(m, rows)
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i],
        a = rows[Math.max(0, i - 1)],
        b = rows[Math.min(rows.length - 1, i + 1)]
      let t = [b.x - a.x, b.y - a.y, b.z - a.z]
      if (Math.hypot(...t) < 1e-4)
        t = [rows[2].x - rows[0].x, rows[2].y - rows[0].y, 0]
      const tl = Math.hypot(...t)
      for (let j = 0; j < SIDES; j++) {
        const p = tube[i].points[j],
          o = [p[0] - r.x, p[1] - r.y, p[2] - r.z],
          n = tube[i].normals[j]
        expect(p.every(Number.isFinite)).toBe(true)
        expect(Math.hypot(...o)).toBeCloseTo(r.width / 2, 5) // as wide as its row
        expect(Math.abs(dot(o, t)) / tl).toBeLessThan(1e-4) // square to the rope
        expect(dot(n, o) / (r.width / 2)).toBeCloseTo(1, 5) // its normal pointing straight out, the facing the shader reads
      }
      if (i > 0)
        expect(dot(tube[i - 1].start, tube[i].start)).toBeGreaterThan(0.75) // carried along, not twisted, even round the bend
    }
    expect(m.geometry.drawn).toBe((rows.length - 1) * SIDES * 6)
  })

  it('look the same from any side: dense through the middle, clear at the outline, however the eye lies', () => {
    const shader =
      lift('rope_mesh') +
      source.slice(
        source.indexOf('const rope_mat='),
        source.indexOf('});', source.indexOf('const rope_mat='))
      )
    expect(shader).toMatch(
      /float facing=abs\(dot\(normalize\(vNormal\),normalize\(vView\)\)\);/
    )
    expect(shader).toMatch(/float alpha=vFade\*0\.55\*facing\*facing;/)
    const { rope_fill } = engine()
    const rows: Row[] = [0, 1, 2].map((i) => ({
      x: -10 * i,
      y: 0,
      z: 0,
      width: 1,
      alpha: 0.8,
    }))
    const side = mesh(3),
      along = mesh(3)
    rope_fill(side, rows, 3, { x: -10, y: 30, z: 0 }, 0.00001)
    rope_fill(along, rows, 3, { x: 40, y: 0, z: 0 }, 0.00001)
    expect(Array.from(side.geometry.attributes.position.array)).toEqual(
      Array.from(along.geometry.attributes.position.array)
    ) // the geometry does not turn to the eye: nothing to swing
  })

  it('hold a pixel and a half far off, dimmed as much, rather than breaking into dots', () => {
    const { rope_fill } = engine()
    const rows: Row[] = [0, 1, 2].map((i) => ({
      x: -10 * i,
      y: 0,
      z: 0,
      width: 0.05,
      alpha: 0.8,
    }))
    const m = mesh(3)
    rope_fill(m, rows, 3, { x: -10, y: 5000, z: 0 }, 0.001)
    const tube = rings(m, rows),
      least = 5000 * 0.001 * 1.5
    const o = tube[1].points[0]
    expect(Math.hypot(o[0] + 10, o[1], o[2])).toBeCloseTo(least / 2, 1)
    expect(m.geometry.attributes.fade.array[SIDES]).toBeCloseTo(
      (0.8 * 0.05) / least,
      4
    )
  })
})

describe("each jet's cloud", () => {
  // The uniforms as the engine sets them, recorded.
  function vector() {
    const v = {
      x: 0,
      y: 0,
      z: 0,
      w: 0,
      set(x: number, y: number, z = 0, w = 0) {
        Object.assign(v, { x, y, z, w })
        return v
      },
      copy() {
        return v
      },
      applyQuaternion() {
        return v
      },
    }
    return v
  }
  function rig() {
    const uniforms = {
      uStrength: { value: 0 },
      uWing: { value: vector() },
      uSun: { value: vector() },
      uColour: { value: vector() },
      uTime: { value: 0 },
    }
    const volume = {
      uStrength: { value: vector() },
      uCone: { value: vector() },
      uCanopy: { value: 0 },
      uCentre: { value: vector() },
      uRadius: { value: 0 },
      uSun: { value: vector() },
      uColour: { value: vector() },
      uTime: { value: 0 },
    }
    return {
      cloud: { visible: true },
      material: { uniforms },
      volume: { visible: true },
      haze: { uniforms: volume },
      drawn: [] as string[],
      flight: null,
      shown: null,
    }
  }
  type Rig = ReturnType<typeof rig>
  interface Stand {
    rig: Rig
    group: { visible: boolean; quaternion: object }
    roped?: { shown: object | null; alpha: number; burst: number }
  }
  const stand = (visible = true): Stand => ({
    rig: rig(),
    group: { visible, quaternion: {} },
  })
  const smoothstep = (x: number, low: number, high: number) => {
    const t = Math.min(1, Math.max(0, (x - low) / (high - low)))
    return t * t * (3 - 2 * t)
  }
  function effects(
    jets: {
      ownship: Stand
      bandit: Stand
      remotes: Map<number, Stand>
      pool?: object
      air?: { x: number; z: number }
    },
    flights: Map<object, Flight>,
    humid: number
  ) {
    return new Function(
      'THREE',
      'D2R',
      'contrail_mat',
      'sun_dir',
      '_vapour_turn',
      'ownship',
      'bandit',
      'remotes',
      'crash_t',
      'vapour_rig',
      'presented',
      'vapour_flight',
      'vapour_show',
      'vapour_humid',
      'humidity',
      'cfg',
      'vapour_streamers',
      'update_pool_ballistic',
      'vapour_pool',
      'vapour_time',
      'vapour_air',
      'VAPOUR_APEX',
      'VAPOUR_LEX',
      '_vapour_at',
      'vapour_light',
      'vapour_ropes',
      `${lift('vapour_bounds')}\n${lift('vapour_burst')}\n${lift('vapour_effects')}\nreturn vapour_effects;`
    )(
      {
        MathUtils: {
          clamp: (v: number, a: number, b: number) =>
            Math.min(b, Math.max(a, v)),
          lerp: (a: number, b: number, t: number) => a + (b - a) * t,
          smoothstep,
        },
      },
      D2R,
      { color: {} },
      {},
      { copy: () => ({ invert: () => ({}) }) },
      jets.ownship,
      jets.bandit,
      jets.remotes,
      0,
      (st: Stand) => st.rig,
      () => ({ y: 300 }),
      (st: object) => flights.get(st),
      vapour,
      humid,
      humidity,
      { clouds: 'none' },
      () => {},
      () => {},
      jets.pool ?? { activeList: [] },
      0,
      jets.air ?? { x: 0, z: 0 },
      { x: 5.0, y: 0.35, z: 0.85 },
      { x: -2.4, spread: 0.09, tail: 20, fade: 2.0 },
      vector(),
      () => ({}),
      (
        st: Stand,
        _rig: object,
        shown: object,
        alpha: number,
        burst: number
      ) => {
        st.roped = { shown, alpha, burst }
      }
    ) as (dt: number) => void
  }

  it('is drawn for the pilot, the bandit and every remote, each by its own flight', () => {
    const ownship = stand(),
      bandit = stand(),
      remote = stand()
    const flights = new Map<object, Flight>([
      [ownship, { alpha: 24, g: 6, speed: 150, mach: 0.45 }],
      [bandit, { alpha: 3, g: 1, speed: 180, mach: 0.55 }],
      [remote, { alpha: 3, g: 1.5, speed: 330, mach: 0.98 }],
    ])
    effects(
      { ownship, bandit, remotes: new Map([[7, remote]]) },
      flights,
      0.95
    )(1 / 60)
    expect(ownship.rig.drawn).toEqual(['lex', 'wing']) // the ropes, and the film of a 6 g pull
    expect(bandit.rig.drawn).toEqual([])
    expect(bandit.rig.cloud.visible).toBe(false)
    expect(remote.rig.drawn).toEqual(['collar', 'canopy', 'wing'])
    expect(remote.rig.cloud.visible).toBe(true) // its wing sheet
    expect(remote.rig.volume.visible).toBe(true) // its cloud and canopy plume
    expect(ownship.rig.volume.visible).toBe(false)
    expect(ownship.roped?.alpha).toBe(24) // its ropes drawn for its own alpha
    expect(bandit.roped?.shown).not.toBeNull()
  })

  it("hides a jet's cloud when it is not flying", () => {
    const ownship = stand(),
      bandit = stand(false)
    const flights = new Map<object, Flight>([
      [ownship, { alpha: 3, g: 1, speed: 180, mach: 0.55 }],
      [bandit, { alpha: 24, g: 6, speed: 150, mach: 0.45 }],
    ])
    effects({ ownship, bandit, remotes: new Map() }, flights, 0.95)(1 / 60)
    expect(bandit.rig.cloud.visible).toBe(false)
    expect(bandit.rig.volume.visible).toBe(false)
    expect(bandit.rig.drawn).toEqual([])
  })

  it('stands the shock further aft, and deepens and widens the cloud, nearer Mach 1', () => {
    const ownship = stand(),
      bandit = stand(false)
    const flights = new Map<object, Flight>([
      [ownship, { alpha: 3, g: 1.2, speed: 318, mach: 0.94 }],
    ])
    effects({ ownship, bandit, remotes: new Map() }, flights, 0.95)(1 / 60)
    const cone = ownship.rig.haze.uniforms.uCone.value
    const early = { shock: cone.x, depth: cone.y, radius: cone.z }
    flights.set(ownship, { alpha: 3, g: 1.2, speed: 335, mach: 0.99 })
    effects({ ownship, bandit, remotes: new Map() }, flights, 0.95)(1 / 60)
    expect(cone.x).toBeLessThan(early.shock - 1)
    expect(cone.y).toBeGreaterThan(early.depth)
    expect(cone.z).toBeGreaterThan(early.radius)
  })

  it('lets the air take out of each puff what it was given beyond the wind', () => {
    const ownship = stand(false),
      bandit = stand(false)
    const pool = {
      activeList: [0],
      vx: new Float32Array([29]),
      vy: new Float32Array([6]),
      vz: new Float32Array([-10]),
    }
    effects(
      { ownship, bandit, remotes: new Map(), pool, air: { x: 9, z: -4 } },
      new Map(),
      0.95
    )(0.6)
    expect(pool.vx[0]).toBeCloseTo(9 + 20 * Math.exp(-1), 4)
    expect(pool.vy[0]).toBeCloseTo(6 * Math.exp(-1), 4)
    expect(pool.vz[0]).toBeCloseTo(-4 - 6 * Math.exp(-1), 4)
  })

  it('bursts the LEX cores further forward the higher the alpha', () => {
    const ownship = stand(),
      bandit = stand(false)
    const flights = new Map<object, Flight>([
      [ownship, { alpha: 18, g: 6, speed: 160, mach: 0.48 }],
    ])
    effects({ ownship, bandit, remotes: new Map() }, flights, 0.95)(1 / 60)
    const low = ownship.roped!.burst
    flights.set(ownship, { alpha: 32, g: 5, speed: 120, mach: 0.36 })
    effects({ ownship, bandit, remotes: new Map() }, flights, 0.95)(1 / 60)
    expect(ownship.roped!.burst).toBeGreaterThan(low + 2)
  })
})

describe("the cloud's points", () => {
  const geometry = new Function(
    'THREE',
    `${['const VAPOUR_APEX=', 'const VAPOUR_LEX='].map((name) => source.slice(source.indexOf(name), source.indexOf('\n', source.indexOf(name)))).join('\n')}\n${lift('vapour_points')}\nreturn vapour_points();`
  )(THREE) as THREE.BufferGeometry
  const position = geometry.getAttribute('position'),
    part = geometry.getAttribute('part')
  const of = (k: number) =>
    Array.from({ length: part.count }, (_, i) => i)
      .filter((i) => part.getX(i) === k)
      .map((i) => ({
        x: position.getX(i),
        y: position.getY(i),
        z: position.getZ(i),
      }))

  it('lie over both wings between their edges, and nowhere else', () => {
    const wing = of(0)
    expect(wing.filter((p) => p.z > 0).length).toBe(
      wing.filter((p) => p.z < 0).length
    )
    for (const p of wing) {
      const span = Math.abs(p.z),
        lead = 1.29 - 0.5 * (span - 2.0)
      expect(p.x).toBeLessThan(lead + 0.1)
      expect(p.x).toBeGreaterThan(-2.2 - 0.1)
      expect(p.y).toBeGreaterThan(-0.22 - 0.06 * (span - 2.0)) // over the upper surface
    }
    expect(of(1).length).toBe(0) // nothing else: the ropes are ribbons, the cloud and the canopy's plume the volume
  })
})

describe('the volume', () => {
  const bounds = new Function(
    `${lift('vapour_bounds')}\nreturn vapour_bounds;`
  )() as (
    collar: number,
    cap: number,
    cone: { x: number; y: number; z: number }
  ) => { x: number; y: number; z: number; radius: number }
  const inside = (
    b: { x: number; y: number; z: number; radius: number },
    p: number[]
  ) => Math.hypot(p[0] - b.x, p[1] - b.y, p[2] - b.z) <= b.radius + 1e-6

  it('lies inside the sphere its slices fill, at every Mach, with either part or both', () => {
    for (let edge = 0; edge <= 1.0001; edge += 0.05) {
      const cone = {
        x: 0.5 - 9.0 * edge,
        y: 2.0 + 10.0 * edge,
        z: 1.8 + 7.2 * edge,
      } // as the engine sets it: the shock on the axis, the length to the apex, the base's radius
      const rim = cone.x + 0.15 * cone.z
      const lens = [
        [cone.x - 0.25, 0.2, 0], // the shock on the axis, and its soft face
        [cone.x + cone.y, 0.2, 0], // the apex
        [rim, 0.2 + cone.z + 0.05, 0], // the base's rim, and its soft edge
        [rim, 0.2 - cone.z - 0.05, 0],
        [rim, 0.2, cone.z + 0.05],
        [rim, 0.2, -cone.z - 0.05],
      ]
      const at = 5.45 - 0.8 * edge // where the canopy's plume rises, as the engine stands it
      const glass = at > 5.2 ? 0.93 - 0.3 * (at - 5.2) : 0.93 - 0.13 * (5.2 - at) // the canopy's top there
      const puff = [
        [at, glass + 1.95, 0], // out to where it has faded to a hundredth: its top
        [at, glass - 0.1, 0], // its root on the glass
        [at + 0.85, glass + 0.3, 0], // ahead and behind
        [at - 0.88, glass + 0.3, 0],
        [at, glass + 0.3, 1.21], // either side
        [at, glass + 0.3, -1.21],
        [at + 0.6, glass + 1.2, 0], // and round its shoulders
        [at - 0.64, glass + 1.2, 0],
      ]
      for (const p of lens) expect(inside(bounds(1, 0, cone), p)).toBe(true)
      for (const p of puff) expect(inside(bounds(0, 1, cone), p)).toBe(true)
      for (const p of [...lens, ...puff])
        expect(inside(bounds(1, 1, cone), p)).toBe(true)
    }
    expect(bounds(0, 1, { x: 0, y: 5, z: 5 }).radius).toBeLessThan(1.8) // the canopy's alone: a tight sphere, so its slices lie close together
  })

  it('is a stack of slices, farthest first, each read as a density with no step in it', () => {
    const count = Number(/const VAPOUR_SLICES=(\d+);/.exec(source)?.[1])
    expect(count).toBeGreaterThanOrEqual(48)
    const stack = new Function(
      'THREE',
      `const VAPOUR_SLICES=${count};\n${lift('vapour_slices')}\nreturn vapour_slices();`
    )(THREE) as THREE.BufferGeometry
    const slice = stack.getAttribute('slice'),
      index = stack.getIndex()!
    expect(index.count).toBe(count * 6)
    const order = Array.from({ length: count }, (_, k) =>
      slice.getX(index.getX(k * 6))
    )
    expect(order[0]).toBe(0) // the farthest, drawn first
    expect(order[count - 1]).toBe(1)
    for (let k = 1; k < count; k++)
      expect(order[k]).toBeGreaterThan(order[k - 1])
    // The density the slices read changes smoothly: no step() in it, so the
    // cloud grows with the Mach rather than switching on a piece at a time.
    const fragment = source.slice(
      source.indexOf('const VAPOUR_VOLUME_FRAGMENT='),
      source.indexOf('`;', source.indexOf('const VAPOUR_VOLUME_FRAGMENT='))
    )
    expect(fragment).not.toMatch(/[^h]step\(/)
    expect(fragment).toMatch(/sigma\*=smoothstep\(1\.0,1\.15,inside\);/) // and none inside the canopy
  })
})

describe('the engine', () => {
  it("draws every jet's vapour in the shared frame, the replay's included, and flushes its puffs", () => {
    expect(source).toMatch(
      /\tcontrail_effects\(\);[^\n]*\n\tvapour_effects\(dt\);/
    )
    expect(source).toMatch(/\+flush_points\(vapour_pool,vp_pts\);/)
    expect(source).toMatch(
      /const jets=new Set\(\[ownship,bandit,\.\.\.remotes\.values\(\)\]\);\n\tfor\(const st of jets\)\{ if\(!st\) continue;\n\t\tconst rig=vapour_rig\(st\)/
    )
  })

  it("draws a replay's jets from their recorded alpha, g and Mach", () => {
    expect(source).toMatch(
      /st\.aoa=n\("AOA",NaN\); st\.gload=n\("G",NaN\); st\.mach=n\("Mach",NaN\);/
    )
  })

  it("lays every remote's wake in the pilot's core from its pose", () => {
    expect(source).toMatch(
      /if\(pose\.alive\) wakes\.push\(\{ slot, position:pose\.position, attitude:pose\.attitude, velocity:\[st\.velx,st\.vely,st\.velz\], g:pose\.g\|\|1 \}\);/
    )
    expect(source).toMatch(
      /\tflight_wake_shed\(wakes\);\n\tfor\(const slot of \[\.\.\.remotes\.keys\(\)\]\) if\(!seen\.has\(slot\)\) remote_drop\(slot\);/
    )
  })

  it('never lets a ray stop on the vapour: the cockpit clicks and the eye see through it', () => {
    expect(lift('vapour_rig')).toMatch(/cloud\.raycast=\(\)=>\{\};/)
    expect(lift('vapour_rig')).toMatch(/volume\.raycast=\(\)=>\{\};/)
    expect(lift('rope_mesh')).toMatch(/mesh\.raycast=\(\)=>\{\};/)
  })
})
