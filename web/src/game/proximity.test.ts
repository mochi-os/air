// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { available, bank, escape, PROXIMITY, rolling, warns, type Vector } from './proximity'

const FOOT = 0.3048, KNOT = 0.514444, D = Math.PI / 180

// A jet flying `knots` with its path `dive` degrees below the horizon, rolled `roll` degrees from wings
// level, its up axis `alpha` degrees back from the path's normal.
function jet(knots: number, dive: number, roll = 0, alpha = 0): { velocity: Vector; up: Vector } {
  const v = knots * KNOT, path = -dive * D
  const velocity = { x: 0, y: v * Math.sin(path), z: -v * Math.cos(path) }
  const nose = { x: 0, y: Math.sin(path), z: -Math.cos(path) }, normal = { x: 0, y: Math.cos(path), z: Math.sin(path) }, side = { x: 1, y: 0, z: 0 }
  const r = roll * D, a = alpha * D
  const lift = { x: normal.x * Math.cos(r) + side.x * Math.sin(r), y: normal.y * Math.cos(r) + side.y * Math.sin(r), z: normal.z * Math.cos(r) + side.z * Math.sin(r) }
  const up = { x: lift.x * Math.cos(a) - nose.x * Math.sin(a), y: lift.y * Math.cos(a) - nose.y * Math.sin(a), z: lift.z * Math.cos(a) - nose.z * Math.sin(a) }
  return { velocity, up }
}
const lost = (knots: number, dive: number, roll = 0, load = 1) => {
  const j = jet(knots, dive, roll)
  return escape(j.velocity, j.up, load)
}

describe('the warning models the escape', () => {
  it('never sounds for a jet that is not sinking hard, however low', () => {
    const level = jet(300, 0), shallow = jet(300, 1.5), climbing = jet(300, -10)
    expect(warns(5, level.velocity, level.up, 1)).toBe(false)
    expect(warns(5, shallow.velocity, shallow.up, 1)).toBe(false) // 4 m/s of sink
    expect(warns(5, climbing.velocity, climbing.up, 1)).toBe(false)
  })
  it('sounds below its floor for any real sink, and above the floor only when the escape and the clearance need more', () => {
    const gentle = jet(300, 5), steep = jet(450, 45)
    expect(warns(PROXIMITY.floor - 1, gentle.velocity, gentle.up, 1)).toBe(true)
    expect(escape(gentle.velocity, gentle.up, 1) + PROXIMITY.clearance).toBeLessThan(PROXIMITY.floor)
    expect(warns(PROXIMITY.floor + 1, gentle.velocity, gentle.up, 1)).toBe(false) // a 5 degree letdown at 300 ft is not a warning
    const need = escape(steep.velocity, steep.up, 1) + 50 * FOOT // the terrain clearance
    expect(need).toBeGreaterThan(PROXIMITY.floor)
    expect(warns(need - 1, steep.velocity, steep.up, 1)).toBe(true)
    expect(warns(need + 1, steep.velocity, steep.up, 1)).toBe(false)
  })
  it('reads the roll about the flight path, so a dive is not a bank', () => {
    for (const dive of [10, 45, 80]) {
      const level = jet(400, dive, 0, 6), side = jet(400, dive, 90, 3), back = jet(400, dive, 180)
      expect(bank(level.velocity, level.up)).toBeCloseTo(0, 6)
      expect(bank(side.velocity, side.up) / D).toBeCloseTo(90, 0)
      expect(bank(back.velocity, back.up) / D).toBeCloseTo(180, 4)
    }
    const straight = jet(400, 90, 120)
    expect(bank(straight.velocity, straight.up)).toBe(0) // straight down, any roll will do
  })
  it('rolls at the rate the speed allows', () => {
    expect(rolling(405 * KNOT) / D).toBeCloseTo(165, 0)
    expect(rolling(500 * KNOT)).toBe(rolling(405 * KNOT))
    expect(rolling(200 * KNOT) / D).toBeGreaterThan(45)
    expect(rolling(200 * KNOT) / D).toBeLessThan(60) // the flight core rolls 54 degrees a second at 200 kt
    expect(rolling(80 * KNOT)).toBeCloseTo(PROXIMITY.roll.rate * PROXIMITY.roll.least, 9)
    expect((lost(200, 45, 90) - lost(200, 45)) / (200 * KNOT)).toBeGreaterThan((lost(400, 45, 90) - lost(400, 45)) / (400 * KNOT) + 0.5) // the slow jet's roll takes a good half second longer
  })
  it('takes longer the further the lift vector is from upright', () => {
    const upright = lost(400, 45), side = lost(400, 45, 90), inverted = lost(400, 45, 180)
    expect(side).toBeGreaterThan(upright)
    expect(inverted).toBeGreaterThan(side)
    const sink = 400 * KNOT * Math.sin(45 * D)
    expect(inverted - upright).toBeGreaterThan(sink) // a second of the roll at the sink, and more: the sink grows while the lift points down
  })
  it('counts the sink that builds through the reaction, at the load the jet holds', () => {
    const sink = 400 * KNOT * Math.sin(45 * D)
    expect(lost(400, 45, 180, 4)).toBeGreaterThan(lost(400, 45, 180, 1) + sink * 0.3) // pulling toward the sea while he reacts
    expect(lost(400, 45, 0, 5)).toBeLessThan(lost(400, 45, 0, 1)) // already pulling out
    // Inverted at 1 g the lift adds to gravity: the sink grows by about 1.7 g through the second of the reaction.
    const inverted = jet(400, 45, 180), growth = 0.5 * 9.81 * (1 + Math.cos(45 * D)) * PROXIMITY.reaction ** 2
    const reacted = escape(inverted.velocity, inverted.up, 1) - escape(inverted.velocity, inverted.up, 1)
    expect(reacted).toBe(0)
    expect(lost(400, 45, 180)).toBeGreaterThan(sink * PROXIMITY.reaction + growth * 0.9 + sink * (180 / 180))
  })
  it('pulls to the target g over the onset, short of what the wing gives', () => {
    expect(available(170 * KNOT)).toBeCloseTo(0.8 * ((170 * KNOT) / PROXIMITY.stall) ** 2, 6)
    expect(available(250 * KNOT)).toBeLessThan(PROXIMITY.pull)
    expect(available(350 * KNOT)).toBe(PROXIMITY.pull)
    expect(available(60 * KNOT)).toBe(1.2)
    // A jet already pulling the target g wings level flies the pull from the start, with no reaction, roll or
    // onset to lose. Held at its speed it would lose (v^2/g) ln((4 - cos 30)/3), exactly; the dive's gravity
    // speeds it up on the way down, so the arc is wider.
    const v = 450 * KNOT, arc = ((v * v) / 9.81) * Math.log((PROXIMITY.pull - Math.cos(30 * D)) / (PROXIMITY.pull - 1))
    expect(lost(450, 30, 0, PROXIMITY.pull)).toBeGreaterThan(arc * 1.02)
    expect(lost(450, 30, 0, PROXIMITY.pull)).toBeLessThan(arc * 1.1)
    const sink = v * Math.sin(30 * D)
    // From 1 g it costs the half second the g takes to build, and the reaction at 1 g.
    expect(lost(450, 30, 0, 1)).toBeGreaterThan(lost(450, 30, 0, PROXIMITY.pull) + sink * 0.5)
  })
})

// The core is a build product (assets/flight.wasm, untracked), as for the autopilot's suite: without one
// the dives are skipped.
const assets = fileURLToPath(new URL('../assets/', import.meta.url))
const built = existsSync(assets + 'flight.wasm') && existsSync(assets + 'wasm_exec.js')
interface Core { init(world: string): string; level(x: number, y: number, z: number, dx: number, dz: number, speed: number, fuel: number): string; frame(input: Uint8Array, output: Uint8Array): string }
let core: Core
const SIZE = 124, TAIL = 8, NZ = 126, DT = 1 / 60
const input = new Float64Array(16), out = new Float64Array(SIZE + TAIL), sent = new Uint8Array(input.buffer), read = new Uint8Array(out.buffer)
function turned(q: number[], v: number[]): number[] {
  const [w, x, y, z] = q, [a, b, c] = v
  const ix = w * a + y * c - z * b, iy = w * b + z * a - x * c, iz = w * c + x * b - y * a, iw = -x * a - y * b - z * c
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x]
}
// The jet as the warning reads it, and which side of the vertical its right wing is.
function sense() {
  const q = [out[6], out[7], out[8], out[9]], [ux, uy, uz] = turned(q, [0, 1, 0]), [, ry] = turned(q, [0, 0, 1])
  return { height: out[1], velocity: { x: out[3], y: out[4], z: out[5] }, up: { x: ux, y: uy, z: uz }, load: out[NZ], wing: ry }
}
// The keyboard's stick: deflection grows at 2 a second toward a held key and returns at 6 (engine.ts read_input).
const shape = (current: number, target: number) => {
  const toward = Math.abs(target) > Math.abs(current) && target * current >= 0, rate = (toward ? 2 : 6) * DT
  return current + Math.max(-rate, Math.min(rate, target - current))
}

interface Dive { name: string; feet: number; knots: number; throttle: number; script: { seconds: number; pitch: number; roll: number }[] }
interface Flown { warned: number | null; height: number; need: number; impact: number | null; bottom: number; escaped: boolean }
// fly: the dive's keys held in turn, then hands off. With `escaping`, the pilot answers the warning as the
// model has him do, on the keyboard: a second with the stick where it was, full lateral stick the shorter
// way to wings level, then full aft stick until the jet climbs.
function fly(dive: Dive, escaping: boolean): Flown {
  core.init(JSON.stringify({ aircraft: 'fa18c', environment: { seed: 1 }, world: { sea: 3 } }))
  core.level(0, dive.feet * FOOT, 0, 0, -1, dive.knots * KNOT, 4000)
  input.fill(0); input[3] = dive.throttle; input[7] = 4
  core.frame(sent, read)
  let warned: number | null = null, height = 0, need = 0, bottom = Infinity, phase = 'dive', pitch = 0, roll = 0
  const ends = dive.script.reduce<number[]>((at, s) => [...at, (at[at.length - 1] ?? 0) + s.seconds], [])
  for (let t = 0, k = 0; t < 120; t += DT, k++) {
    const s = sense()
    if (s.height <= 0) return { warned, height, need, impact: t, bottom: 0, escaped: false }
    if (warned === null && warns(s.height, s.velocity, s.up, s.load)) {
      warned = t
      height = s.height
      need = escape(s.velocity, s.up, s.load)
    }
    if (warned !== null) bottom = Math.min(bottom, s.height)
    const step = ends.findIndex((end) => t < end)
    let p = step < 0 ? 0 : dive.script[step].pitch, r = step < 0 ? 0 : dive.script[step].roll
    if (escaping && warned !== null && t >= warned + PROXIMITY.reaction) {
      if (phase === 'dive') phase = 'roll'
      if (phase === 'roll' && bank(s.velocity, s.up) < 10 * D) phase = 'pull'
      p = phase === 'pull' ? 1 : 0
      r = phase === 'roll' ? (s.wing > 0 ? 1 : -1) : 0
      if (phase === 'pull' && s.velocity.y > 0) return { warned, height, need, impact: null, bottom, escaped: true }
    }
    pitch = shape(pitch, p)
    roll = shape(roll, r)
    input[0] = pitch; input[1] = roll; input[3] = dive.throttle; input[6] = k + 1; input[7] = 4
    core.frame(sent, read)
  }
  return { warned, height, need, impact: null, bottom, escaped: false }
}

// The dives the warning must lead: each flown hands off meets the sea, and each one's escape is flown.
const DIVES: Dive[] = [
  // lawcheck's: the crash shape of recording 01a0496af718, from the Case III marshal at angels 6 and 250 kt
  { name: 'rolling slice from the Case III marshal', feet: 6000, knots: 250, throttle: 0.7, script: [{ seconds: 1.2, pitch: 0, roll: 1 }, { seconds: 2.8, pitch: 1, roll: 0 }] },
  // the recorded crash profile: faster and steeper at the entry
  { name: 'rolling slice at 430 kt in burner', feet: 5000, knots: 430, throttle: 1, script: [{ seconds: 1.2, pitch: 0, roll: 1 }, { seconds: 2.8, pitch: 1, roll: 0 }] },
  // a split-S begun too low, the pull eased off past the vertical
  { name: 'split-S begun at 4,000 ft', feet: 4000, knots: 300, throttle: 0.5, script: [{ seconds: 0.9, pitch: 0, roll: 1 }, { seconds: 0.4, pitch: 0, roll: 0 }, { seconds: 3, pitch: 1, roll: 0 }] },
  // a wings-level gun pass pushed over into a dive
  { name: 'wings-level push into a dive', feet: 3000, knots: 450, throttle: 1, script: [{ seconds: 1.5, pitch: -0.6, roll: 0 }] },
  // a slow jet's sliced turn, left to settle into a shallow banked descent at idle
  { name: 'slow sliced turn left to descend at idle', feet: 5000, knots: 200, throttle: 0, script: [{ seconds: 0.9, pitch: 0, roll: 1 }, { seconds: 0.4, pitch: 0, roll: 0 }, { seconds: 2, pitch: 1, roll: 0 }] },
  // a descending turn tightened past 90 degrees of bank
  { name: 'overbanked descending turn', feet: 3000, knots: 350, throttle: 0.8, script: [{ seconds: 0.7, pitch: 0, roll: 1 }, { seconds: 2, pitch: 0.5, roll: 0 }] },
]

describe.skipIf(!built)('the warning against the flight core', () => {
  beforeAll(async () => {
    const require = createRequire(import.meta.url)
    require(assets + 'wasm_exec.js')
    const g = globalThis as unknown as { Go: new () => { importObject: WebAssembly.Imports; run(instance: WebAssembly.Instance): Promise<void> }; air_flight?: Core }
    const go = new g.Go()
    const { instance } = await WebAssembly.instantiate(readFileSync(assets + 'flight.wasm'), go.importObject)
    void go.run(instance)
    for (let k = 0; k < 500 && !g.air_flight; k++) await new Promise((resolve) => setTimeout(resolve, 10))
    core = g.air_flight as Core
  }, 30000)

  for (const dive of DIVES)
    it(`leads the ${dive.name} by an escape that clears the sea`, () => {
      const crash = fly(dive, false), flown = fly(dive, true)
      expect(crash.impact, 'flown hands off, the dive meets the sea').not.toBeNull()
      expect(crash.warned, 'the warning sounds before it does').not.toBeNull()
      expect(flown.escaped, 'the escape climbs away').toBe(true)
      expect(flown.height - flown.bottom, 'the escape loses no more than the model says').toBeLessThanOrEqual(flown.need)
      expect(flown.bottom, 'and leaves the clearance').toBeGreaterThanOrEqual(PROXIMITY.clearance)
    }, 60000)
})
