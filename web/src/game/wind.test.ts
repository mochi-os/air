// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { aim, GRAVITY, length, MUZZLE } from './pipper'
import { SEEKERS, seeker_break, seeker_sight, seeker_steer } from './seeker'

// The sea and the clouds follow the weather's wind: the wind sea and its foam
// travel downwind, the long swell crosses them from the north-west, and the
// cloud streets lie along the wind and drift down it. engine.ts cannot be
// imported (WebGL at module scope), so the shader's own expressions are run
// from their source, with GLSL's vec2 standing in as {x, y}.
const source = readFileSync(
  fileURLToPath(new URL('./engine.ts', import.meta.url)),
  'utf8'
)

type V = { x: number; y: number }
const DEGREE = Math.PI / 180
const vec2 = (x: number, y: number): V => ({ x, y })
const dot = (a: V, b: V) => a.x * b.x + a.y * b.y
const normalize = (a: V) => vec2(a.x / Math.hypot(a.x, a.y), a.y / Math.hypot(a.x, a.y))
// The compass bearing a world xz vector points toward: x east, z south.
const bearing = (v: V) => (Math.atan2(v.x, -v.y) / DEGREE + 360) % 360
// How far apart two bearings are, 0 to 180.
const apart = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180)
const toward = (degrees: number) => vec2(Math.sin(degrees * DEGREE), -Math.cos(degrees * DEGREE))

// lift cuts one top-level function out of the source: from its head to the
// next line that starts at column 0 (the bodies are tab-indented), keeping
// that line when it is the function's own closing brace.
function lift(name: string): string {
  const start = source.indexOf(`function ${name}(`)
  expect(start, `${name} in engine.ts`).toBeGreaterThan(0)
  const rest = source.slice(start)
  const end = /\n(?=\S)/.exec(rest.slice(1))
  if (!end) return rest
  const cut = end.index + 1
  return rest.startsWith('\n}', cut) ? rest.slice(0, cut + 2) : rest.slice(0, cut)
}

// The text of a const string, from its opening backtick to the next `;.
function block(name: string): string {
  const start = source.indexOf(`const ${name}=\``)
  expect(start, `${name} in engine.ts`).toBeGreaterThan(0)
  return source.slice(start, source.indexOf('`;', start))
}

// A GLSL statement list run as JavaScript: float and vec2 declarations become
// consts, and every name it reads is passed in.
function glsl(code: string, names: string[]) {
  const js = code.replace(/\b(?:float|vec2) /g, 'const ')
  return new Function(...names, 'vec2', 'dot', 'normalize', js) as (...values: unknown[]) => V
}

const turning = block('SEA_TURN')
const axis = (() => {
  const m = /const vec2 AXIS=normalize\(vec2\(([-\d.]+),([-\d.]+)\)\);/.exec(turning)
  expect(m, 'AXIS in SEA_TURN').not.toBeNull()
  return normalize(vec2(Number(m![1]), Number(m![2])))
})()
function shader(name: string) {
  const head = `vec2 ${name}(vec2 v){`
  const start = turning.indexOf(head)
  expect(start, `${name} in SEA_TURN`).toBeGreaterThan(0)
  const run = glsl(turning.slice(start + head.length, turning.indexOf('}', start)), ['v', 'u_downwind', 'AXIS'])
  return (v: V, downwind: V) => run(v, downwind, axis, vec2, dot, normalize)
}
const turn = shader('turn')
const unturn = shader('unturn')

// The weather the jet flies in, and the wind the sea and the clouds are set to.
const weather = new Function(
  'CLOUDS', 'cfg', 'DEV_MODE', 'D2R', 'WORLD_WRAP', 'cheat', 'MULTIPLAYER', 'match_wind',
  `${lift('weather')}\nreturn weather;`
)({}, { clouds: 'none' }, false, DEGREE, 250000, () => false, false, () => null) as () => { wind: { x: number; z: number } }
function applied(wind: { x: number; z: number }, before: V) {
  const downwind = { value: { ...before, set(x: number, y: number) { this.x = x; this.y = y } } }
  const ocean_mat = { uniforms: { u_slope: { value: 0 } } }
  new Function('weather', 'downwind', 'ocean_mat', `${lift('apply_wind')}\napply_wind();`)(() => ({ wind }), downwind, ocean_mat)
  return vec2(downwind.value.x, downwind.value.y)
}
const trades = (() => { const w = weather().wind; return applied(w, vec2(0, 1)) })()

// The ocean material, its two shaders as written: the fragment shader ends where the material does.
const ocean = source.slice(source.indexOf('const ocean_mat'), source.indexOf('` });', source.indexOf('const ocean_mat')))
const vertex = ocean.slice(ocean.indexOf('vertexShader:`'), ocean.indexOf('fragmentShader:`'))
const fragment = ocean.slice(ocean.indexOf('fragmentShader:`'))

// The way a wave train travels, from the vertex shader's own wave().
function travel(train: V, downwind: V) {
  const m = /float wave\(vec2 p,vec4 w,float amp,out vec2 grad\)\{ vec2 dir=([^;]+);/.exec(vertex)
  expect(m, 'wave() in the vertex shader').not.toBeNull()
  return glsl(`return ${m![1]};`, ['w', 'turn'])({ xy: train }, (v: V) => turn(v, downwind), vec2, dot, normalize)
}
const trains = [...vertex.matchAll(/const vec4 (W\d)=vec4\(([-\d.]+),([-\d.]+),([\d.]+),([\d.]+)\);/g)].map(
  (m) => ({ name: m[1], direction: vec2(Number(m[2]), Number(m[3])) })
)

// The fragment shader's frame: xz from the world, as the shader computes it,
// and back. A pattern that moves m in that frame moves frame.back(m) in the world.
// The chart's shift (u_chart, which keeps the patterns unbroken as the engine's
// frame moves) is a translation, so a pattern's motion is the same without it.
const frame = (() => {
  const m = /vec2 xz=([^;]+);/.exec(fragment)
  expect(m, 'xz in the fragment shader').not.toBeNull()
  expect(m![1]).toContain('+u_chart')
  const to = (world: V, downwind: V) =>
    glsl(`return ${m![1].replace('+u_chart', '')};`, ['v_world', 'unturn'])({ xz: world }, (v: V) => unturn(v, downwind), vec2, dot, normalize)
  const back = (v: V, downwind: V) => {
    const a = to(vec2(1, 0), downwind), b = to(vec2(0, 1), downwind)
    const det = a.x * b.y - b.x * a.y
    return vec2((b.y * v.x - b.x * v.y) / det, (-a.y * v.x + a.x * v.y) / det)
  }
  return { to, back }
})()

describe('the wind the sea and the clouds follow', () => {
  it("is the weather's own, from 070 toward 250, as a unit vector", () => {
    expect(bearing(trades)).toBeCloseTo(250, 6)
    expect(Math.hypot(trades.x, trades.y)).toBeCloseTo(1, 9)
  })

  it('starts on the trades before the weather has been read', () => {
    const m = /^const downwind=(\{[^\n;]*\});/m.exec(source)
    expect(m, 'downwind in engine.ts').not.toBeNull()
    const start = new Function('THREE', `return ${m![1]};`)({ Vector2: class { constructor(public x: number, public y: number) {} } })
    expect(bearing(start.value)).toBeCloseTo(250, 6)
  })

  it('turns with any wind, and holds its line in a calm', () => {
    const north = applied({ x: 0, z: 9 }, trades)
    expect(bearing(north)).toBeCloseTo(180, 6)
    expect(applied({ x: 0.05, z: 0 }, trades)).toEqual(trades)
  })

  it('is set when a mission starts and when the page boots', () => {
    expect(lift('start_mission')).toMatch(/apply_time_of_day\(cfg\.tod\); apply_effects\(\); apply_wind\(\);/)
    expect(source).toMatch(/\/\/ =+ boot\napply_time_of_day\(cfg\.tod\); apply_effects\(\); apply_size\(\); apply_wind\(\);/)
  })

  it('is one uniform, shared by the sea and every cloud material', () => {
    expect(ocean).toMatch(/u_downwind:downwind,/)
    expect(source).toMatch(/const cloud_field_uniforms=\{[^\n]*uDownwind:downwind,/)
    expect(source).toMatch(/uniform vec2 uGate,uDownwind,uChart,uCurve;/)
  })
})

describe('the waves', () => {
  it('turn the sea axis onto the wind, and back', () => {
    for (const degrees of [250, 180, 33, 300]) {
      const downwind = toward(degrees)
      expect(bearing(turn(axis, downwind))).toBeCloseTo(degrees, 6)
      const v = vec2(0.3, -1.7)
      const back = unturn(turn(v, downwind), downwind)
      expect(back.x).toBeCloseTo(v.x, 9)
      expect(back.y).toBeCloseTo(v.y, 9)
    }
  })

  it('run downwind, the wind sea within 20 degrees of it', () => {
    expect(trains.map((t) => t.name)).toEqual(['W0', 'W1', 'W2', 'W3'])
    for (const t of trains.slice(1))
      expect(apart(bearing(travel(t.direction, trades)), 250), t.name).toBeLessThan(20)
  })

  it('cross with the long swell from the north-west', () => {
    const swell = bearing(travel(trains[0].direction, trades))
    const from = (swell + 180) % 360
    expect(from).toBeGreaterThan(292.5)
    expect(from).toBeLessThan(337.5)
    expect(apart(swell, 250)).toBeGreaterThan(100)
    expect(apart(swell, 250)).toBeLessThan(130)
  })

  it("let the foam's crest gate read the displaced crest: the shading swell in the sea's frame is the vertex swell in the world", () => {
    for (const p of [vec2(130, -4200), vec2(-9000, 77), vec2(512, 3333)])
      for (const t of trains) {
        const world = dot(travel(t.direction, trades), p)
        const shading = dot(normalize(t.direction), frame.to(p, trades))
        expect(shading).toBeCloseTo(world, 6)
      }
  })
})

describe("the sea's frame", () => {
  it('turns the detail slopes back into the world', () => {
    const m = /vec2 lean=([^;]+);/.exec(fragment)
    expect(m, 'lean in the fragment shader').not.toBeNull()
    expect(fragment).toMatch(/vec3 N=normalize\(vn\+vec3\(lean\.x,0\.0,lean\.y\)\);/)
    const lean = (slope: V) =>
      glsl(`return ${m![1]};`, ['slope', 'turn'])(slope, (v: V) => turn(v, trades), vec2, dot, normalize)
    // A ridge field sampled in the sea's frame, and its slope there; the
    // world's slope of the same field, taken by finite difference.
    const ridge = vec2(0.02, -0.013)
    const field = (world: V) => Math.sin(dot(ridge, frame.to(world, trades)))
    for (const p of [vec2(40, 90), vec2(-700, 1300)]) {
      const q = frame.to(p, trades), c = Math.cos(dot(ridge, q))
      const slope = vec2(ridge.x * c, ridge.y * c)
      const h = 1e-3
      const world = vec2((field(vec2(p.x + h, p.y)) - field(vec2(p.x - h, p.y))) / (2 * h),
        (field(vec2(p.x, p.y + h)) - field(vec2(p.x, p.y - h))) / (2 * h))
      const shown = lean(slope)
      expect(shown.x).toBeCloseTo(world.x, 6)
      expect(shown.y).toBeCloseTo(world.y, 6)
    }
  })

  it('carries every detail texture and colour patch downwind', () => {
    const octaves = Object.fromEntries(
      [...fragment.matchAll(/vec2 (xr\d)=vec2\(([^()]*)\)/g)].map((m) => [m[1], m[2]])
    )
    const drifts = [
      ...[...fragment.matchAll(/hexslope\((xr\d)\/[\d.]+, (-?)u_time\*sea_drift\(vec2\(([-\d.e]+),([-\d.e]+)\)\)\)/g)].map(
        (m) => ({ uv: octaves[m[1]], sign: m[2] === '-' ? -1 : 1, d: vec2(Number(m[3]), Number(m[4])) })
      ),
      ...[...fragment.matchAll(/texture2D\(u_detail,xz\/[\d.]+([+-])u_time\*sea_drift\(vec2\(([-\d.e]+),([-\d.e]+)\)\)\)/g)].map(
        (m) => ({ uv: 'xz.x, xz.y', sign: m[1] === '-' ? -1 : 1, d: vec2(Number(m[2]), Number(m[3])) })
      ),
    ]
    expect(drifts).toHaveLength(5)   // three slope octaves, the colour patches and the cap clustering
    for (const drift of drifts) {
      expect(drift.uv, 'the octave the drift is fetched in').toBeDefined()
      const uv = (xz: V) => new Function('xz', `return [${drift.uv}];`)(xz) as [number, number]
      // A fetch at uv + sign*t*d carries the pattern along -sign*d in uv.
      const a = uv(vec2(1, 0)), b = uv(vec2(0, 1)), det = a[0] * b[1] - b[0] * a[1]
      const m = vec2(-drift.sign * drift.d.x, -drift.sign * drift.d.y)
      const inframe = vec2((b[1] * m.x - b[0] * m.y) / det, (-a[1] * m.x + a[0] * m.y) / det)
      expect(apart(bearing(frame.back(inframe, trades)), 250), drift.uv).toBeLessThan(25)
    }
  })

  it('carries the foam downwind', () => {
    const m = /vec2 aw=vec2\(([-\d.]+),([-\d.]+)\);/.exec(fragment)
    expect(m, 'aw in the fragment shader').not.toBeNull()
    expect(fragment).toMatch(/vec2 xzc=xz-u_time\*aw\*1\.1;/)
    const aw = vec2(Number(m![1]), Number(m![2]))
    expect(apart(bearing(frame.back(aw, trades)), 250)).toBeLessThan(0.1)
  })
})

describe('the clouds', () => {
  const field = block('CLOUD_FIELD')

  it('lay their streets along the wind', () => {
    expect(field).toMatch(/vec4 cellfield\(vec2 xz\)\{ vec2 q=vec2\(dot\(xz,uDownwind\)\*0\.62, dot\(xz,vec2\(-uDownwind\.y,uDownwind\.x\)\)\);/)
  })

  it('comb a stratus deck along the wind', () => {
    expect(field).toMatch(/vec2 sw=vec2\(dot\(sp\.xz,uDownwind\), dot\(sp\.xz,vec2\(-uDownwind\.y,uDownwind\.x\)\)\); sw\.x\*=0\.32;/)
  })

  it('drift downwind, the cells and the virga beneath them together', () => {
    expect(field).toMatch(/vec3 sp=p-vec3\(uDownwind\.x,0\.0,uDownwind\.y\)\*\(uTime\*8\.54\);/)
    expect(field).toMatch(/texture\(tNoise,\(p-vec3\(uDownwind\.x,0\.0,uDownwind\.y\)\*\(uTime\*8\.54\)\)\*1\.6667e-4\)/)
  })

  it('keep no fixed direction of their own', () => {
    expect(field).not.toMatch(/0\.958|0\.286|uTime\*8\.0/)
  })
})

type W = { x: number; y: number; z: number }
const still: W = { x: 0, y: 0, z: 0 }
const gale: W = { x: -30, y: 0, z: 12 } // a strong wind, the way the air moves
const plus = (a: W, b: W): W => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z })
const minus = (a: W, b: W): W => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const scale = (a: W, k: number): W => ({ x: a.x * k, y: a.y * k, z: a.z * k })
const size = (a: W) => Math.hypot(a.x, a.y, a.z)
// The jet a weapon leaves: at 3,000 m, its nose along x, flying 250 m/s through the air given.
const jet = (wind: W) => ({ pos: { x: 0, y: 3000, z: 0 }, fwd: { x: 1, y: 0, z: 0 }, speed: size(plus({ x: 250, y: 0, z: 0 }, wind)), velx: 250 + wind.x, vely: wind.y, velz: wind.z })
const airflow = (wind: W) => new Function('flight_wind', `${lift('airflow')}\nreturn airflow;`)(() => wind)

describe("a match's wind", () => {
  it("is the server's, which the welcome carries; none from a server that predates it", () => {
    const blown = (welcome: unknown) => new Function('net', `${lift('match_wind')}\nreturn match_wind();`)({ welcome })
    expect(blown({ spawn: { wind: [-12.1, 0, 4.4] } })).toEqual({ x: -12.1, y: 0, z: 4.4 })
    expect(blown({ spawn: {} })).toBeNull()
  })

  it('is the weather a match draws and records; single player keeps its own', () => {
    const weathered = (multiplayer: boolean, blown: unknown) =>
      new Function('CLOUDS', 'cfg', 'DEV_MODE', 'D2R', 'WORLD_WRAP', 'cheat', 'MULTIPLAYER', 'match_wind', `${lift('weather')}\nreturn weather().wind;`)(
        {}, { clouds: 'none' }, false, DEGREE, 250000, () => false, multiplayer, () => blown)
    const trades = weathered(false, null)
    expect(weathered(true, { x: 1, y: 0, z: 2 })).toEqual({ x: 1, y: 0, z: 2 })
    expect(weathered(false, { x: 1, y: 0, z: 2 })).toEqual(trades)
    expect(weathered(true, null)).toEqual(trades) // the sea a match from an older server always drew
  })

  it("is the air a match's core flies, as the server's does", () => {
    const world = (blown: unknown) => JSON.parse(JSON.stringify(new Function('MULTIPLAYER', 'net', 'own_aircraft', 'cheat', 'WORLD_WRAP', 'match_wind', `${lift('flight_world')}\nreturn flight_world();`)(
      true, { welcome: { seed: 7 }, wrap: 250000, geometry: { sea: 3 } }, () => 'fa18c', () => false, 250000, () => blown)))
    expect(world({ x: 1, y: 0, z: 2 }).environment.wind).toEqual({ x: 1, y: 0, z: 2 })
    expect(world(null).environment.wind).toBeUndefined() // still air, as the older server flies
  })

  it('turns the sea once the core binds to the match', () => {
    expect(source).toMatch(/\n\t\tif\(MULTIPLAYER\) apply_wind\(\);/)
  })
})

describe('the weapons fly through the air', () => {
  it("leave the rail at the jet's speed through the air along the nose, the wind carrying them", () => {
    for (const wind of [still, gale]) {
      const a = airflow(wind)(jet(wind))
      expect(a.speed).toBeCloseTo(250, 9)
      expect(a.wind).toEqual(wind)
      const missiles = [{ active: false, mesh: { visible: false } } as Record<string, number | object | boolean>]
      const dressed: unknown[][] = []
      const launch = new Function('THREE', 'missiles', 'local_offset', 'launch_puff', 'wrap_axis', 'airflow', 'dress_round', `${lift('launch_missile')}\nreturn launch_missile;`)(
        THREE, missiles, () => ({ x: 0, y: 3000, z: 0 }), () => {}, (v: number) => v, airflow(wind), (...a: unknown[]) => dressed.push(a))
      expect(launch(jet(wind), null)).toBe(true)
      expect(dressed).toEqual([[missiles[0].mesh, '9m']]) // drawn as the 9M's own model
      const m = missiles[0] as unknown as { vx: number; vy: number; vz: number }
      expect(m.vx - wind.x).toBeCloseTo(280, 9)
      expect(m.vz - wind.z).toBeCloseTo(0, 9)
    }
  })

  it("leave the AMRAAM's rail and ejector the same way, as the server's departure", () => {
    const departure = (wind: W, eject: boolean) => new Function('flight_wind', 'sequence', 'departed', 'stores_eject',
      `${lift('airflow')} ${lift('amraam_departure')}\nreturn amraam_departure;`)(() => wind, () => ({ amraams: ['120c'] }), () => 0, () => eject)
    const climbing = (wind: W) => ({ ...jet(wind), fwd: { x: Math.cos(0.3), y: Math.sin(0.3), z: 0 } })
    for (const eject of [false, true]) {
      const calm = departure(still, eject)(climbing(still)).velocity
      const blown = departure(gale, eject)(climbing(gale)).velocity
      expect(size(minus(minus(blown, gale), calm))).toBeLessThan(1e-9)
    }
    const ejected = departure(still, true)(climbing(still)).velocity
    expect(ejected.y).toBeCloseTo(265 * Math.sin(0.3) - 8, 9) // 15 m/s along the nose and 8 m/s down
  })

  it('shed tracers, flares, smoke and wreckage that drift with the wind, slowing through the air', () => {
    const ballistic = new Function('smoke', 'round_length', `${lift('update_pool_ballistic')} return update_pool_ballistic;`)
    const pool = (velocity: W) => ({ activeList: [0], active: [1], px: [0], py: [3000], pz: [0], vx: [velocity.x], vy: [velocity.y], vz: [velocity.z], life: [9], ttl: [9], pos: [0], seed: [1.3] })
    for (const [name, drag, round, smoky] of [['tracer', 0, true, false], ['flare', 0.985, false, false], ['smoke', 0.96, false, true], ['wreckage', 0.998, false, false]] as const) {
      const run = (wind: W) => {
        const p = pool(plus({ x: 900, y: 40, z: -30 }, wind))
        const step = ballistic(smoky ? p : null, (y: number) => 2600 * Math.exp(Math.max(y, 0) / 8500))
        for (let k = 0; k < 120; k++) step(p, 1 / 60, 9.8, drag, round, wind)
        return p
      }
      const calm = run(still), blown = run(gale)
      expect(blown.px[0] - calm.px[0], name).toBeCloseTo(gale.x * 2, 6)
      expect(blown.pz[0] - calm.pz[0], name).toBeCloseTo(gale.z * 2, 6)
      expect(blown.vx[0] - gale.x, name).toBeCloseTo(calm.vx[0], 6)
    }
  })

  it("leave the bandit's rail the same way", () => {
    const missiles = [{ active: false, mesh: { visible: false } } as Record<string, unknown>]
    let launched: W | null = null
    const dressed: unknown[][] = []
    const bandit = { ...jet(gale), amraam: 2, msl: 2 }
    new Function('missiles', 'has_enemy', 'MULTIPLAYER', 'local_offset', 'launch_puff', 'airflow', 'round_launch', 'update_rails', 'bandit_remaining', 'bandit', 'ownship', 'WORLD_WRAP', 'dress_round',
      `${lift('launch_bandit_round')}\nlaunch_bandit_round();`)(
      missiles, true, false, () => ({ x: 0, y: 3000, z: 0 }), () => {}, airflow(gale), (_slot: number, _at: W, velocity: W) => { launched = velocity }, () => {}, () => 2, bandit,
      { pos: { x: 30000, y: 3000, z: 0 }, velx: -250, vely: 0, velz: 0 }, 0, (...a: unknown[]) => dressed.push(a))
    expect(size(minus(minus(launched!, gale), { x: 280, y: 0, z: 0 }))).toBeLessThan(1e-9)
    expect(dressed).toEqual([[missiles[0].mesh, '120c']]) // drawn as the AIM-120's own model
  })

  it("judge the BVR start's separation in still air, as the server does", () => {
    let still: unknown = null
    new Function('round_ladder', `let bvr_apart=0;\n${lift('bvr_separation')}\nbvr_separation();`)((_s: unknown, _t: unknown, _w: number, calm: boolean) => { still = calm; return { max: 80000 } })
    expect(still).toBe(true)
  })

  it('hand the frame\'s wind to every pool the weapons shed into', () => {
    const frame = lift('visuals')
    expect(frame).toMatch(/const air=flight_wind\(ownship\.pos\.x,ownship\.pos\.y,ownship\.pos\.z\);/)
    for (const call of ['tracers,dt,9.8,0,true,air', 'flares,dt,9.8,0.985,false,air', 'smoke,dt,-0.5,0.96,false,air', 'debris,dt,9.8,0.998,false,air'])
      expect(frame, call).toContain(`update_pool_ballistic(${call})`)
  })

  it('offer a seeker the chaff cloud where the wind has carried it since it bloomed', () => {
    const drifted = new Function('flight_wind', 'sim_time', `${lift('drifted')}\nreturn drifted;`)(() => gale, 11.5)
    expect(drifted({ bloom: { x: 100, y: 2000, z: 50 }, chaffed: 10 })).toEqual({ x: 100 + 1.5 * gale.x, y: 2000, z: 50 + 1.5 * gale.z })
    // to a round's time: the rounds step after the frame, behind its clock
    expect(
      drifted({ bloom: { x: 100, y: 2000, z: 50 }, chaffed: 10 }, 0.5)
    ).toEqual({ x: 100 + gale.x, y: 2000, z: 50 + gale.z })
  })

  it('are drawn pointing into the air they fly through', () => {
    for (const name of ['step_missiles', 'step_amraam']) expect(lift(name), name).toMatch(/setFromUnitVectors\(new THREE\.Vector3\(1,0,0\),new THREE\.Vector3\(m\.vx-w\.x,m\.vy-w\.y,m\.vz-w\.z\)\.normalize\(\)\)/)
    expect(lift('draw_darts').match(/_v\.set\(d\.velocity\[0\]-w\.x,d\.velocity\[1\]-w\.y,d\.velocity\[2\]-w\.z\)/g)).toHaveLength(2)
  })
})

// One step of the 9M as engine.ts flies it, from a state set through the air: in a wind it must do to
// the round's velocity through the air exactly what it does in still air.
describe("the heater's step through the air", () => {
  const flies = new Function('THREE', 'seeker_sight', 'seeker_break', 'seeker_steer', 'SEEKERS', 'Math',
    `let blowing={ x:0, y:0, z:0 }, sim_time=10, crash_t=0, bandit_acc=0;
     const flight_wind=()=>blowing, flight_debt=()=>0, missiles=[], ownship={ pos:{ x:0, y:0, z:0 } }, bandit={ group:{ visible:true } };
     const MULTIPLAYER=false, DEV_MODE=false, has_enemy=false, wrap_axis=(v)=>v, wrap_distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
     const step_amraam=()=>{}, trail_puff=()=>true, decoy_lure=(p)=>({ x:p.x, y:p.y-30, z:p.z });
     ${lift('stood')}
     ${lift('step_missiles').replace(/ as any/g, '')}
     return { missiles, step_missiles, blow:(w)=>{ blowing=w; } };`)
  type Round = { vx: number; vy: number; vz: number; active: boolean; loose: boolean }
  const tick = (wind: W, state: { round: W; target: W; at: W; burn: number; loose?: boolean; blind?: number }) => {
    const world = flies(THREE, seeker_sight, seeker_break, seeker_steer, SEEKERS, Object.assign(Object.create(Math), { random: () => 0.1 })) // the second look comes up good
    world.blow(wind)
    const target = { pos: state.at, velx: state.target.x + wind.x, vely: state.target.y + wind.y, velz: state.target.z + wind.z, fwd: scale(state.target, 1 / size(state.target)), speed: size(state.target), group: { visible: true } }
    const m = { active: true, kind: '9m', mesh: { visible: true, position: new THREE.Vector3(), quaternion: new THREE.Quaternion() }, px: 0, py: 3000, pz: 0,
      vx: state.round.x + wind.x, vy: state.round.y + wind.y, vz: state.round.z + wind.z, life: 10, flew: 2, target, burn: state.burn, loose: state.loose ?? false,
      blind: state.blind ?? 0, lx: state.at.x, ly: state.at.y - 30, lz: state.at.z, window: true, rejected: 0, least: 1e9, smoke_acc: 0, enemy: false }
    world.missiles.push(m)
    world.step_missiles(1 / 60)
    return { through: { x: m.vx - wind.x, y: m.vy - wind.y, z: m.vz - wind.z }, active: m.active, loose: m.loose } as unknown as { through: W } & Round
  }
  const lean = (degrees: number, speed: number) => ({ x: speed * Math.cos(degrees * DEGREE), y: 0, z: speed * Math.sin(degrees * DEGREE) })
  const across: W = { x: 0, y: 0, z: 34 }, along: W = { x: 34, y: 0, z: 0 } // the wind at 3,000 m of the server's trades, across the round's way and along it
  for (const [name, state, within, wind] of [
    ['boosting after a crossing target', { round: { x: 600, y: 0, z: 0 }, target: { x: 0, y: 0, z: 200 }, at: { x: 800, y: 3000, z: 150 }, burn: 1 }, 1e-9, across],
    ['slow, its turn at the limit', { round: { x: 200, y: 0, z: 0 }, target: { x: 0, y: 0, z: -250 }, at: { x: 800, y: 3000, z: 250 }, burn: 0 }, 1e-9, along],
    ['coasting loose', { round: { x: 500, y: 0, z: 0 }, target: { x: 200, y: 0, z: 0 }, at: { x: 800, y: 3000, z: 0 }, burn: 0, loose: true }, 1e-9, across],
    ['chasing a flare', { round: { x: 500, y: 0, z: 0 }, target: { x: 200, y: 0, z: 0 }, at: { x: 800, y: 3000, z: 300 }, burn: 0, blind: 1 }, 0.01, across], // the flare drifts before the seeker looks, the round after: a few millimetres a second apart
    ['slower than him, but not by enough to fall away', { round: lean(-35, 275), target: { x: 200, y: 0, z: 0 }, at: { x: 800, y: 3000, z: 0 }, burn: 0 }, 1e-9, along],
    ["at the gimbal's edge", { round: { x: 500, y: 0, z: 0 }, target: { x: 200, y: 0, z: 0 }, at: { x: 800 * Math.cos(39 * DEGREE), y: 3000, z: -800 * Math.sin(39 * DEGREE) }, burn: 0 }, 1e-9, across],
    ['its second look after the flare', { round: { x: 500, y: 0, z: 0 }, target: { x: 200, y: 0, z: 0 }, at: { x: 3000 * Math.cos(39 * DEGREE), y: 3000, z: -3000 * Math.sin(39 * DEGREE) }, burn: 0, blind: 0.5 / 60 }, 0.01, across], // the flare hangs in the air: it moves with the wind before the seeker looks
  ] as const) {
    it(`does in a wind what it does in still air: ${name}`, () => {
      const calm = tick(still, state), blown = tick(wind, state)
      expect(size(minus(blown.through, calm.through))).toBeLessThan(within)
      expect(blown.active).toBe(calm.active)
      expect(blown.loose).toBe(calm.loose)
    })
  }
  it('takes the jet back on its second look and flies at him as a round that had tracked him all along', () => {
    const step = (blind: number) => {
      const world = flies(
        THREE,
        seeker_sight,
        seeker_break,
        seeker_steer,
        SEEKERS,
        Object.assign(Object.create(Math), { random: () => 0.1 })
      ) // the second look comes up good
      const target = {
        pos: { x: 800, y: 3000, z: 150 },
        velx: 200,
        vely: 0,
        velz: 0,
        fwd: { x: 1, y: 0, z: 0 },
        speed: 200,
        group: { visible: true },
      }
      const m = {
        active: true,
        kind: '9m',
        mesh: {
          visible: true,
          position: new THREE.Vector3(),
          quaternion: new THREE.Quaternion(),
        },
        px: 0,
        py: 3000,
        pz: 0,
        vx: 500,
        vy: 0,
        vz: 0,
        life: 10,
        flew: 2,
        target,
        burn: 0,
        loose: false,
        blind,
        lx: -200,
        ly: 2950,
        lz: 0,
        window: true,
        rejected: 0,
        least: 1e9,
        smoke_acc: 0,
        enemy: false,
      } // the flare burns out behind the round, which has flown past it
      world.missiles.push(m)
      world.step_missiles(1 / 60)
      return m
    }
    const decoyed = step(0.5 / 60),
      tracked = step(0)
    expect(decoyed.rejected).toBe(1)
    expect(decoyed.loose).toBe(false)
    expect(decoyed.active).toBe(true)
    expect([decoyed.vx, decoyed.vy, decoyed.vz]).toEqual([
      tracked.vx,
      tracked.vy,
      tracked.vz,
    ])
  })
})

// The rounds step after both jets have flown the whole frame, each on its own
// accumulator, so a jet stands ahead of a round's step by the debt the round
// carries less his own. Read where he stands, the 9M's fuse and seeker and the
// AMRAAM's core saw him a tick ahead at 60 fps and two on a 30 fps frame's
// first step: 4 m of a 250 m/s jet against a 12 m fuse.
describe('the rounds read the jets at their own time', () => {
  it('steps each round from as far behind the frame as its accumulator leaves it', () => {
    const behind: number[] = []
    const run = new Function(
      'step_missiles',
      `let missile_acc=0;\n${lift('update_missiles')}\nreturn update_missiles;`
    )((_dt: number, b: number) => behind.push(b))
    run(2.5 / 60)
    expect(behind).toHaveLength(2)
    expect(behind[0]).toBeCloseTo(2.5 / 60, 12) // the frame's first step starts two and a half ticks back
    expect(behind[1]).toBeCloseTo(1.5 / 60, 12)
  })

  // One 9M step against the bandit: in lockstep, the jet where the round is in
  // time; as the frame runs it, the jet a tick on and the round a tick behind.
  const heater = new Function(
    'THREE',
    'seeker_sight',
    'seeker_break',
    'seeker_steer',
    'SEEKERS',
    `let sim_time=10, crash_t=0, bandit_acc=0;
     const flight_wind=()=>({ x:0, y:0, z:0 }), flight_debt=()=>0, missiles=[], ownship={ pos:{ x:0, y:0, z:0 } };
     const bandit={ group:{ visible:true }, fwd:{ x:0, y:0, z:-1 }, speed:250, velx:0, vely:0, velz:-250, pos:{ x:0, y:0, z:0 } };
     const MULTIPLAYER=false, DEV_MODE=false, has_enemy=false;
     const step_amraam=()=>{}, trail_puff=()=>true, decoy_lure=(p)=>({ x:p.x, y:p.y-30, z:p.z });
     ${lift('stood')}
     ${lift('step_missiles').replace(/ as any/g, '')}
     return (at, round, behind)=>{ bandit.pos={ ...at };
       const m={ active:true, kind:'9m', mesh:{ visible:true, position:new THREE.Vector3(), quaternion:new THREE.Quaternion() }, px:0, py:3000, pz:0,
         vx:round.x, vy:round.y, vz:round.z, life:10, flew:2, target:bandit, burn:1, loose:false, blind:0, window:false, rejected:0, least:1e9, smoke_acc:0, enemy:false };
       missiles.length=0; missiles.push(m); step_missiles(1/60, behind); return m; };`
  )(THREE, seeker_sight, seeker_break, seeker_steer, SEEKERS)
  const ticked = (p: W) => ({ x: p.x, y: p.y, z: p.z - 250 / 60 }) // the jet a tick on, crossing at 250 m/s
  it("steers a 9M at the jet as he stood at the round's time", () => {
    const at = { x: 1500, y: 3000, z: 300 },
      round = { x: 600, y: 0, z: 0 }
    const lockstep = heater(at, round, 0),
      framed = heater(ticked(at), round, 1 / 60)
    expect(lockstep.active).toBe(true)
    expect(
      Math.abs(framed.vx - lockstep.vx) +
        Math.abs(framed.vy - lockstep.vy) +
        Math.abs(framed.vz - lockstep.vz)
    ).toBeLessThan(1e-9)
  })
  it("fuses a 9M on the jet as he stood at the round's time", () => {
    const at = { x: 6, y: 3000, z: 8 },
      round = { x: 600, y: 0, z: 0 } // the true miss 5.1 m; a tick ahead it read 1.2 m
    const lockstep = heater(at, round, 0),
      framed = heater(ticked(at), round, 1 / 60)
    expect(lockstep.active).toBe(false)
    expect(lockstep.burst).toBeCloseTo(5.08, 2)
    expect(framed.active).toBe(false)
    expect(framed.burst).toBeCloseTo(lockstep.burst, 9)
  })

  // The AMRAAM's core is handed the jet at the round's own time and flies him
  // on across the step itself (round.go Advance): handed where he stands, he
  // was flown a tick too far.
  const radar = new Function(
    'THREE',
    `let sim_time=10, crash_t=0, bandit_acc=0, debt=0, bandit_locked=true, has_enemy=true, own_kills=0, battle_tick=0, next=null;
     const MULTIPLAYER=false, WARHEAD={ radar:2 }, RADAR={ silent:()=>false, stt:7, tracks:[] };
     const ownship={ pos:{ x:0, y:3000, z:0 }, velx:250, vely:0, velz:0, fwd:{ x:1, y:0, z:0 }, up:{ x:0, y:1, z:0 }, right:{ x:0, y:0, z:1 } };
     const bandit={ pos:{ x:5000, y:3000, z:0 }, velx:-250, vely:0, velz:0, fwd:{ x:-1, y:0, z:0 }, up:{ x:0, y:1, z:0 }, right:{ x:0, y:0, z:-1 }, speed:250, group:{ visible:true } };
     const flight_debt=()=>debt, flight_wind=()=>({ x:0, y:0, z:0 }), cheat=()=>false, jammer_loud=()=>false, trail_puff=()=>true;
     const handed=[], blasts=[], booms=[];
     const round_step=(_slot,_dt,support,truth)=>{ handed.push({ support, truth }); return next; };
     const round_drop=()=>{}, round_distract=()=>false, post_round=()=>{}, crash_ownship=()=>{}, bandit_destroy=()=>{};
     const explosion_at=(x,y,z)=>booms.push({ x, y, z }), battle_aim=(st)=>({ position:{ ...st.pos } });
     const battle_blast=(target,burst)=>{ blasts.push({ target, burst }); return { judged:0, spot:null, mask:0, kill:false, impacts:[] }; };
     ${lift('drifted')}
     ${lift('stood')}
     ${lift('step_amraam')}
     return { ownship, bandit, handed, blasts, booms, fly:(enemy, behind, own, state)=>{ debt=own; next=state;
       const m={ active:true, kind:'120c', enemy, target:enemy?null:bandit, track:7, slot:0, smoke_acc:0, mesh:{ visible:true, position:new THREE.Vector3(), quaternion:new THREE.Quaternion() } };
       step_amraam(m, 1/60, behind); return m; } };`
  )
  const flying = {
    alive: true,
    phase: 0,
    x: 1000,
    y: 3000,
    z: 0,
    vx: 800,
    vy: 0,
    vz: 0,
    range: 4000,
    stale: 0,
    time: 2,
    life: 40,
    fused: false,
    mach: 2.4,
    least: 4000,
    struck: { x: 0, y: 0, z: 0 },
  }
  it("hands an AMRAAM's core the bandit as he stood at the round's time", () => {
    const world = radar(THREE)
    world.fly(false, 1 / 60, 0, flying) // the bandit flew the tick before the round stepped; his own debt is none
    expect(world.handed[0].truth.position.x).toBeCloseTo(5000 + 250 / 60, 9)
    expect(world.handed[0].support.position.x).toBeCloseTo(5000 + 250 / 60, 9) // the datalink's estimate is of him at the same time
  })
  it("hands the bandit's AMRAAM the pilot as he stood at the round's time, his own debt counted", () => {
    const world = radar(THREE)
    world.fly(true, 1 / 60, 0.002, flying) // the pilot's core stepped to within 2 ms of the frame's clock
    expect(world.handed[0].truth.position.x).toBeCloseTo(
      -250 * (1 / 60 - 0.002),
      9
    )
  })
  it("judges an AMRAAM's burst against the jet as he stood as it burst", () => {
    const world = radar(THREE)
    world.fly(false, 1 / 60, 0, {
      ...flying,
      fused: true,
      x: 4990,
      y: 3005,
      z: 0,
      struck: { x: 4995.8, y: 3000, z: 0 },
    })
    expect(world.blasts).toHaveLength(1)
    // the burst 5.8 m short of him and 5 m above, kept from where he stands now
    expect(world.blasts[0].burst).toEqual({
      x: 4990 - 4995.8 + 5000,
      y: 3005,
      z: 0,
    })
    expect(world.booms[0]).toEqual(world.blasts[0].burst)
  })
})

// burstcheck.py reads the bandit's fused rounds out of the dev log by whose
// they were; the radar round's entries never said, so the probe could not see
// the AMRAAM that killed the pilot.
describe("the radar round's dev log", () => {
  it('says whose round it was, as the heater log does', () => {
    const shelf = { dev_missiles: [] as Record<string, unknown>[] }
    const post = new Function(
      'sim_time',
      'DEV_MODE',
      'globalThis',
      `${lift('post_round').replace(/ as any/g, '')}\nreturn post_round;`
    )(10, true, shelf)
    const round = {
      flew: 2,
      phase: 2,
      mach: 2,
      least: 4.2,
      took: 0,
      killed: true,
      mask: 1,
      burst: 4.2,
      judged: 4.2,
    }
    post({ ...round, enemy: true }, 'fuse')
    post({ ...round, enemy: false }, 'fuse')
    expect(shelf.dev_missiles.map((m) => [m.kind, m.enemy])).toEqual([
      ['120c', true],
      ['120c', false],
    ])
  })
})

describe("the director gunsight's solution", () => {
  it('lands the burst on the target in a wind, worked through the air at the muzzle', () => {
    // The rounds fly the air at the muzzle (battle.Fly), so the director is handed the jet's and the
    // target's velocities through it; the burst is then flown as the core flies it.
    const muzzle = { x: 0, y: 3000, z: 0 }, start = { x: 700, y: 3010, z: 80 }
    const miss = (wind: W, subtract: boolean) => {
      const own = plus({ x: 250, y: 0, z: 0 }, wind), drift = plus({ x: 200, y: 0, z: 60 }, wind)
      const bore = aim(muzzle, subtract ? minus(own, wind) : own, start, subtract ? minus(drift, wind) : drift, 3000)
      let p = { ...muzzle }, v = plus(scale(bore, MUZZLE), own), closest = Infinity
      const dt = 1 / 480
      for (let t = 0; t < 3; t += dt) {
        const through = minus(v, wind), s = size(through)
        v = plus(wind, scale(through, 1 / (1 + (s * dt) / length(p.y))))
        v.y -= GRAVITY * dt
        p = plus(p, scale(v, dt))
        closest = Math.min(closest, size(minus(p, plus(start, scale(drift, t + dt)))))
      }
      return closest
    }
    const calm = miss(still, true) // the director's own error, which the wind must not add to
    expect(calm).toBeLessThan(1)
    expect(Math.abs(miss(gale, true) - calm)).toBeLessThan(0.01)
    expect(miss(gale, false) - calm).toBeGreaterThan(0.3) // over the ground, the wind the rounds are carried by moves the burst off him: two thirds of a metre at 700 m in this gale
    expect(source).toMatch(/const mw=flight_wind\(muz\.x,muz\.y,muz\.z\);\n\t\t\tconst solution=pipper_impact\(muz,ownship\.fwd,\{x:\(ownship\.velx\?\?ownship\.fwd\.x\*ownship\.speed\)-mw\.x,/)
    expect(source).toMatch(/\{x:\(boxed\.velx\?\?boxed\.fwd\.x\*boxed\.speed\)-mw\.x,y:\(boxed\.vely\?\?boxed\.fwd\.y\*boxed\.speed\)-mw\.y,z:\(boxed\.velz\?\?boxed\.fwd\.z\*boxed\.speed\)-mw\.z\}/)
  })
})
