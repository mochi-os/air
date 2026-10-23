// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

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
  'CLOUDS', 'cfg', 'DEV_MODE', 'D2R', 'WORLD_WRAP', 'cheat',
  `${lift('weather')}\nreturn weather;`
)({}, { clouds: 'none' }, false, DEGREE, 250000, () => false) as () => { wind: { x: number; z: number } }
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
const frame = (() => {
  const m = /vec2 xz=([^;]+);/.exec(fragment)
  expect(m, 'xz in the fragment shader').not.toBeNull()
  const to = (world: V, downwind: V) =>
    glsl(`return ${m![1]};`, ['v_world', 'unturn'])({ xz: world }, (v: V) => unturn(v, downwind), vec2, dot, normalize)
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
    expect(source).toMatch(/uniform vec2 uGate,uDownwind;/)
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
