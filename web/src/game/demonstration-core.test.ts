// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  demonstration_start,
  demonstration_step,
  wrap,
  type Demonstration,
  type Picture,
} from './demonstration'

// The demonstration's final turn flown against the flight core itself: the
// built wasm run under node, the scripted pilot's stick, lever and switches
// going in where the engine puts them (engine.ts demonstration_drive), and
// the picture it reads made from the core's state as demonstration_picture
// makes it, about a landing line that stands still. The core is a build
// product (assets/flight.wasm, untracked), so without one the suite is
// skipped. demonstrationcheck flies the same turn in the game, with the ship
// under way.
const assets = fileURLToPath(new URL('../assets/', import.meta.url))
const built =
  existsSync(assets + 'flight.wasm') && existsSync(assets + 'wasm_exec.js')
interface Core {
  init(world: string): string
  frame(input: Uint8Array, output: Uint8Array): string
  approach(
    x: number,
    y: number,
    z: number,
    dx: number,
    dz: number,
    slope: number,
    fuel: number
  ): number
  power?(altitude: number, slope: number): [number, number] | string
}
let core: Core
const SIZE = 124,
  TAIL = 8,
  ALPHA = 124,
  CAS = 128 // flight.ts SIZE, STATE.alpha and STATE.cas: that module pulls in the interface's message macros, which this suite cannot load
const input = new Float64Array(16),
  out = new Float64Array(SIZE + TAIL),
  sent = new Uint8Array(input.buffer),
  read = new Uint8Array(out.buffer)
const D = Math.PI / 180,
  FOOT = 0.3048,
  KNOT = 0.514444,
  DT = 1 / 60
const LANDING = 61 // the landing line's heading: the ship's 070 less the angled deck
const DECK = 20 // m: the slope's height over the touchdown
function turned(q: number[], v: number[]): number[] {
  const [w, x, y, z] = q,
    [a, b, c] = v
  const ix = w * a + y * c - z * b,
    iy = w * b + z * a - x * c,
    iz = w * c + x * b - y * a,
    iw = -x * a - y * b - z * c
  return [
    ix * w + iw * -x + iy * -z - iz * -y,
    iy * w + iw * -y + iz * -x - ix * -z,
    iz * w + iw * -z + ix * -y - iy * -x,
  ]
}
const degrees = (radians: number) => (((radians / D) % 360) + 360) % 360

// picture: the jet as the engine shows it to the pilot, the touchdown at the
// origin and the line running in on LANDING.
function picture(time: number, throttle: number, power: Picture['power']): Picture {
  const q = [out[6], out[7], out[8], out[9]],
    f = turned(q, [1, 0, 0]),
    u = turned(q, [0, 1, 0]),
    r = turned(q, [0, 0, 1])
  const x = out[0],
    z = out[2]
  const along = x * -Math.sin(LANDING * D) + z * Math.cos(LANDING * D) // aft of the touchdown
  const right = x * Math.cos(LANDING * D) + z * Math.sin(LANDING * D)
  return {
    time,
    altitude: out[1],
    vertical: out[4],
    speed: Math.hypot(out[3], out[4], out[5]),
    cas: out[CAS],
    alpha: out[ALPHA] / D,
    heading: degrees(Math.atan2(f[0], -f[2])),
    track: degrees(Math.atan2(out[3], -out[5])),
    bank: -Math.atan2(r[1], u[1]) / D,
    pitch: Math.asin(Math.max(-1, Math.min(1, f[1]))) / D,
    roll: out[10],
    rate: out[12],
    throttle,
    gear: true,
    flap: 2,
    hook: true,
    grounded: false,
    trapped: false,
    waving: false,
    crashed: false,
    coached: true,
    power,
    ship: { along: -along, starboard: right, bow: 166, course: 70 },
    groove: {
      along,
      right,
      deviation: 0,
      slope: DECK + Math.tan(3.5 * D) * Math.max(0, along),
      heading: LANDING,
      drift: 0,
    },
  }
}

interface Start {
  wind: number // m/s from 070, the trades' direction
  height: number // ft
  sink: number // m/s
  seed: number // the pilot's habits
}
interface Sample {
  lever: number
  knots: number
  vertical: number
}
// turn: the jet put on the downwind abeam, dirty and on-speed, a mile and a
// quarter off the line and 1.6 km aft of the touchdown where the turn
// begins, and the pilot's final turn flown until the groove takes it.
function turn(start: Start): { samples: Sample[]; d: Demonstration } {
  const blowing = {
    x: -start.wind * Math.sin(70 * D),
    z: start.wind * Math.cos(70 * D),
  }
  core.init(
    JSON.stringify({
      aircraft: 'fa18c',
      environment: { seed: 1, wind: blowing },
      world: { sea: 3 },
    })
  )
  const downwind = (LANDING + 189) * D // the turn's 189 degrees
  const along = 1600,
    right = -2000
  const x = along * -Math.sin(LANDING * D) + right * Math.cos(LANDING * D)
  const z = along * Math.cos(LANDING * D) + right * Math.sin(LANDING * D)
  const slope = Math.asin(start.sink / 68) / D // the spawn's path, on-speed
  let lever = core.approach(
    x,
    start.height * FOOT,
    z,
    Math.sin(downwind),
    -Math.cos(downwind),
    slope,
    2041
  )
  input.fill(0)
  input[3] = lever
  input[5] = 4 | 8
  input[7] = 4
  input[10] = 2
  core.frame(sent, read)
  const book = () => {
    const level = core.power?.(150, 0),
      sloped = core.power?.(150, 3.5)
    if (!Array.isArray(level) || !Array.isArray(sloped)) return null
    return {
      level: level[0],
      rate: (level[0] - sloped[0]) / (sloped[1] * Math.sin(3.5 * D)),
    }
  }
  let power = book(),
    read_at = 0
  const d = demonstration_start(start.seed)
  d.phase = 'turn'
  d.configured = true
  d.seated = true
  d.lever = lever
  d.throttle = lever
  d.vertical = out[4]
  d.cas = out[CAS]
  d.since = 0
  d.along = along
  const samples: Sample[] = []
  let sequence = 0
  for (let time = 0; time < 150 && d.phase === 'turn'; time += DT) {
    if (time - read_at >= 2) {
      power = book()
      read_at = time
    }
    const c = demonstration_step(d, picture(time, lever, power), DT)
    lever = c.throttle
    input[0] = c.pitch
    input[1] = c.roll
    input[2] = c.yaw
    input[3] = c.throttle
    input[4] = c.speedbrake
    input[5] = (c.gear ? 4 : 0) | (c.hook ? 8 : 0)
    input[6] = ++sequence
    input[10] = c.flap
    core.frame(sent, read)
    samples.push({ lever, knots: out[CAS] / KNOT, vertical: out[4] })
  }
  return { samples, d }
}

// judged: the probe's turn gates (demonstrationcheck.py), from samples a
// tenth of a second apart as near enough to its own 0.4 s.
function judged(samples: Sample[]) {
  const spaced = samples.filter((_, i) => i % 6 === 0)
  const levers = spaced.map((s) => s.lever)
  let travel = 0
  for (let i = 1; i < levers.length; i++)
    travel += Math.abs(levers[i] - levers[i - 1])
  const hunting = travel - Math.max(0, Math.max(...levers) - levers[0])
  const knots = spaced.map((s) => s.knots)
  const vertical = spaced.map((s) => s.vertical)
  return {
    hunting,
    least: Math.min(...levers),
    swing: Math.max(...knots) - Math.min(...knots),
    climb: Math.max(...vertical) / FOOT * 60,
    sink: -Math.min(...vertical) / FOOT * 60,
  }
}

describe.skipIf(!built)('the final turn against the flight core', () => {
  beforeAll(async () => {
    const require = createRequire(import.meta.url)
    require(assets + 'wasm_exec.js')
    const g = globalThis as unknown as {
      Go: new () => {
        importObject: WebAssembly.Imports
        run(instance: WebAssembly.Instance): Promise<void>
      }
      air_flight?: Core
    }
    const go = new g.Go()
    const { instance } = await WebAssembly.instantiate(
      readFileSync(assets + 'flight.wasm'),
      go.importObject
    )
    void go.run(instance)
    for (let k = 0; k < 500 && !g.air_flight; k++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    core = g.air_flight as Core
  }, 30000)

  // demonstrationcheck's gates on the turn, with room inside them for the
  // ship under way, which this line does not do: the lever's travel beyond
  // its one rise, never idle, the speed's swing, the climb and the sink. And
  // the groove is handed a jet still closing the line from the outside of
  // the turn, not one across it. In the trades the arc's bank falls from 35°
  // to under 20° as the turn comes into the wind, and the intercept that
  // stepped it back to 35° at 60° to go swung the lever with it; the roll-in
  // wound both slow trims to their limits and ballooned the jet. Each put
  // the travel past 0.85 here.
  it.each([
    ['still air, on the height', { wind: 0, height: 600, sink: 0, seed: 3 }],
    ['the trades, on the height', { wind: 12.9, height: 600, sink: 0, seed: 3 }],
    ['the trades, 45 ft high and sinking 500 fpm, as seed 3 begins it', { wind: 12.9, height: 645, sink: 2.5, seed: 3 }],
  ])('is flown on a steady hand and joins the line from outside: %s', (_, start) => {
    const { samples, d } = turn(start)
    expect(d.phase).toBe('groove')
    const j = judged(samples)
    expect(j.hunting).toBeLessThan(0.8)
    expect(j.least).toBeGreaterThan(0.05)
    expect(j.swing).toBeLessThan(25)
    expect(j.climb).toBeLessThan(500)
    expect(j.sink).toBeLessThan(1000)
    const handed = picture(0, 0, null)
    expect(handed.groove.right).toBeLessThan(0) // still left of the line: not crossed it
    expect(handed.groove.right).toBeGreaterThan(-150)
    expect(wrap(handed.heading - LANDING)).toBeGreaterThan(0) // and closing it
  }, 60000)
})
