// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import * as P from './autopilot'
import * as L from './datalink'
import * as N from './navigation'
import { atc_step, cruise_step } from './atc'

// The autopilot, coupled steering and the carrier's approach flown against the
// flight core itself (#100, #101): the built wasm run under node, the autopilot's
// stick going in where the pilot's would, and the ATC on the throttle as in the
// game. The loops' gains live in autopilot.ts and datalink.ts; this is what they
// were found against, and what says they still hold the jet. The core is a
// build product (assets/flight.wasm, untracked), so without one the suite is
// skipped.
const assets = fileURLToPath(new URL('../assets/', import.meta.url))
const built = existsSync(assets + 'flight.wasm') && existsSync(assets + 'wasm_exec.js')
interface Core { init(world: string): string; level(x: number, y: number, z: number, dx: number, dz: number, speed: number, fuel: number): string; frame(input: Uint8Array, output: Uint8Array): string }
let core: Core
// The core's frame: sixteen input words and the state with its instrument tail (flight.ts).
const SIZE = 117, TAIL = 8, ALPHA = 117, CAS = 121
const input = new Float64Array(16), out = new Float64Array(SIZE + TAIL), sent = new Uint8Array(input.buffer), read = new Uint8Array(out.buffer)
const D = Math.PI / 180, FOOT = 0.3048, DT = 1 / 60
function turned(q: number[], v: number[]): number[] {
  const [w, x, y, z] = q, [a, b, c] = v
  const ix = w * a + y * c - z * b, iy = w * b + z * a - x * c, iz = w * c + x * b - y * a, iw = -x * a - y * b - z * c
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x]
}
// sense: the jet as the engine would give it to the autopilot.
function sense(time: number, approach: boolean): P.Sense {
  const q = [out[6], out[7], out[8], out[9]], f = turned(q, [1, 0, 0]), u = turned(q, [0, 1, 0]), r = turned(q, [0, 0, 1])
  return {
    time, pitch: Math.asin(Math.max(-1, Math.min(1, f[1]))) / D, bank: -Math.atan2(r[1], u[1]) / D, heading: (Math.atan2(f[0], -f[2]) / D + 360) % 360, track: (Math.atan2(out[3], -out[5]) / D + 360) % 360,
    altitude: out[1], height: out[1], vertical: out[4], cas: out[CAS], roll: out[10], rate: out[12], approach, airborne: true, attitude: true, computer: true,
    stick: { pitch: 0, roll: 0 }, trim: { pitch: 0, roll: 0 }, selected: 0, couple: null, limit: 'nav',
  }
}
interface Start { altitude: number; speed: number; landing?: boolean }
type Script = (ap: P.Autopilot, s: P.Sense, time: number) => Partial<P.Sense> | void | 'stop'
// fly: a jet started level, the script saying each frame what the pilot does and what there is to
// couple to; the throttle holds the speed up and away and the angle of attack in the landing
// configuration, as the ATC does. Returns the autopilot and what the jet did, a sample a frame.
function fly(start: Start, seconds: number, script: Script): { ap: P.Autopilot; log: P.Sense[] } {
  core.init(JSON.stringify({ aircraft: 'fa18c', environment: { seed: 1 }, world: { sea: 3 } }))
  core.level(0, start.altitude, 0, 0, -1, start.speed, 3000)
  const ap = P.fresh(), log: P.Sense[] = []
  let throttle = 0.5, sequence = 0, speed = 0, alpha = 0
  input.fill(0); input[3] = throttle; input[7] = 4
  core.frame(sent, read)
  const held = Math.hypot(out[3], out[4], out[5]) / 0.514444
  for (let time = 0; time < seconds; time += DT) {
    let s = sense(time, !!start.landing)
    const said = script(ap, s, time)
    if (said === 'stop') break
    if (said) s = { ...s, ...said }
    const stick = P.step(ap, s, DT)
    const knots = Math.hypot(out[3], out[4], out[5]) / 0.514444, angle = out[ALPHA] / D
    throttle = start.landing ? atc_step(throttle, angle, (angle - alpha) / DT, DT) : cruise_step(throttle, knots, held, (knots - speed) / DT, DT)
    speed = knots; alpha = angle
    input[0] = stick.pitch ?? s.stick.pitch; input[1] = stick.roll ?? s.stick.roll; input[3] = throttle; input[5] = start.landing ? 4 : 0; input[6] = ++sequence; input[7] = 4; input[10] = start.landing ? 2 : 0
    core.frame(sent, read)
    log.push(s)
  }
  return { ap, log }
}
const after = (log: P.Sense[], time: number) => log.filter((s) => s.time >= time)
const span = (values: number[]) => Math.max(...values) - Math.min(...values)
const once = (time: number, at: number) => time >= at && time < at + DT
const last = <T>(values: T[]): T => values[values.length - 1]

describe.skipIf(!built)('the autopilot against the flight core', () => {
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

  it('holds the heading and the pitch attitude it engaged at', () => {
    const { ap, log } = fly({ altitude: 3000, speed: 200 }, 35, (ap, s, time) => { if (once(time, 2)) P.engage(ap, s) })
    const held = after(log, 12)
    expect(ap.engaged).toBe(true)
    expect(Math.max(...held.map((s) => Math.abs(s.pitch - ap.pitch)))).toBeLessThan(0.2)
    expect(Math.max(...held.map((s) => Math.abs(P.wrap(s.heading - ap.heading))))).toBeLessThan(0.2)
    expect(Math.max(...held.map((s) => Math.abs(s.bank)))).toBeLessThan(0.5)
  }, 60000)

  it('holds the roll and pitch attitude in ATTH, a turn with the nose where it was', () => {
    const { ap, log } = fly({ altitude: 3000, speed: 200 }, 35, (ap, s, time) => {
      if (time < 2.5) return { stick: { pitch: 0.06, roll: 0.12 } }
      if (once(time, 3)) P.select(ap, 'attitude', s)
    })
    const held = after(log, 15)
    expect(ap.bank).toBeGreaterThan(20)
    expect(Math.max(...held.map((s) => Math.abs(s.bank - ap.bank)))).toBeLessThan(1)
    expect(Math.max(...held.map((s) => Math.abs(s.pitch - ap.pitch)))).toBeLessThan(0.3)
  }, 60000)

  it('holds the barometric altitude level and through a heading select turn of 90°, banked 30°', () => {
    const { ap, log } = fly({ altitude: 3000, speed: 200 }, 100, (ap, s, time) => {
      if (once(time, 2)) P.select(ap, 'barometric', s)
      if (once(time, 20)) P.select(ap, 'select', { ...s, selected: 90 })
      return { selected: 90 }
    })
    expect(Math.max(...log.filter((s) => s.time > 10 && s.time < 20).map((s) => Math.abs(s.altitude - ap.altitude)))).toBeLessThan(1) // level: inside a metre
    expect(Math.max(...after(log, 20).map((s) => Math.abs(s.altitude - ap.altitude)))).toBeLessThan(4) // and inside four through the turn
    expect(Math.max(...log.map((s) => s.bank))).toBeGreaterThan(29); expect(Math.max(...log.map((s) => s.bank))).toBeLessThan(31)
    expect(Math.abs(P.wrap(last(log).heading - 90))).toBeLessThan(1.5); expect(Math.max(...log.map((s) => P.wrap(s.heading - 90)))).toBeLessThan(0.5) // no swing past it
  }, 60000)

  it('captures the altitude of the moment from a climb, and comes back to it', () => {
    const { ap, log } = fly({ altitude: 3000, speed: 200 }, 50, (ap, s, time) => {
      if (time < 4) return { stick: { pitch: 0.12, roll: 0 } }
      if (once(time, 4.5)) P.select(ap, 'barometric', s)
    })
    expect(log.find((s) => s.time >= 4.5)?.vertical).toBeGreaterThan(8)
    expect(Math.max(...after(log, 40).map((s) => Math.abs(s.altitude - ap.altitude)))).toBeLessThan(3)
    expect(Math.max(...after(log, 40).map((s) => Math.abs(s.vertical)))).toBeLessThan(0.5)
  }, 60000)

  it('holds the radar altitude through the approach law\'s stick with the ATC on the throttle, and turns there', () => {
    const { ap, log } = fly({ altitude: 400, speed: 75, landing: true }, 85, (ap, s, time) => {
      if (once(time, 15)) P.select(ap, 'radar', s)
      if (once(time, 40)) P.select(ap, 'select', { ...s, selected: 60 })
      return { selected: 60 }
    })
    expect(ap.modes.radar).toBe(true)
    expect(Math.max(...log.filter((s) => s.time > 28 && s.time < 40).map((s) => Math.abs((s.height as number) - ap.altitude)))).toBeLessThan(3)
    expect(Math.max(...after(log, 40).map((s) => Math.abs((s.height as number) - ap.altitude)))).toBeLessThan(10)
    expect(Math.abs(P.wrap(last(log).heading - 60))).toBeLessThan(1.5)
  }, 60000)

  // steering: the engine's part - the coupling the navigation gives, the lead turn of a coupled sequence
  const steering = (nav: N.Navigation, limit: 'nav' | 'tac', at = 2): Script => (ap, s, time) => {
    const here = { x: out[0], z: out[2] }, speed = Math.hypot(out[3], out[5])
    if (ap.modes.coupled) N.anticipate(nav, here, speed, P.bound({ ...s, limit }).bank * D)
    N.sequential(nav, here, s.track * D)
    const c = N.coupling(nav, here, s.track * D, speed, null)
    const couple: P.Couple | null = c ? { axis: 'track', value: c.track / D, vertical: null } : null
    if (c?.passed) P.uncouple(ap, s, false)
    if (once(time, at)) { P.select(ap, 'barometric', { ...s, couple, limit }); P.select(ap, 'coupled', { ...s, couple, limit }) }
    return { couple, limit }
  }
  const world = (plan: (nav: N.Navigation) => void): N.Navigation => { const nav = N.fresh(1); N.ready(nav, { x: 0, z: 0 }); plan(nav); return nav }
  const point = (x: number, z: number): N.Waypoint => ({ x, z, elevation: 0, name: '', offset: null })

  it('couples to a course line: a cut of up to 45° at it, a capture that does not swing through, and the line held', () => {
    const nav = world((n) => { n.waypoints[1] = point(6000, -30000); n.current = 1; n.steer = 'wypt'; n.course = 0 })
    const off: number[] = [] // the jet's distance east of the line
    const { ap, log } = fly({ altitude: 3000, speed: 200 }, 120, (ap, s, time) => { off.push(out[0] - 6000); return steering(nav, 'nav')(ap, s, time) })
    expect([ap.modes.coupled, ap.source]).toEqual([true, 'track'])
    const cut = Math.max(...log.map((s) => (s.track > 180 ? 0 : s.track)))
    expect(cut).toBeGreaterThan(35); expect(cut).toBeLessThan(46) // the cut eases as the line nears: 45° is its most
    expect(Math.max(...off)).toBeLessThan(30) // never more than 30 m past the line
    expect(Math.abs(last(off))).toBeLessThan(40)
    expect(Math.max(...log.map((s) => Math.abs(s.bank)))).toBeLessThan(31) // NAV: 30°
  }, 60000)

  it('flies direct to a waypoint, uncouples over it without a caution, and holds the heading it had', () => {
    const nav = world((n) => { n.waypoints[1] = point(4000, -9000); n.current = 1; n.steer = 'wypt' })
    let miss = Infinity
    const { ap, log } = fly({ altitude: 3000, speed: 200 }, 75, (ap, s, time) => { miss = Math.min(miss, Math.hypot(out[0] - 4000, out[2] + 9000)); return steering(nav, 'nav')(ap, s, time) })
    expect(miss).toBeLessThan(100)
    expect([ap.modes.coupled, ap.engaged, ap.modes.barometric, ap.lateral, P.cautions(ap, 75)]).toEqual([false, true, true, 'heading', []])
    expect(span(after(log, 68).map((s) => s.heading))).toBeLessThan(0.5); expect(Math.abs(last(log).bank)).toBeLessThan(1)
  }, 60000)

  it('turns ahead of a sequence\'s waypoint onto the course to the next, to TAC\'s bank at speed', () => {
    const nav = world((n) => { n.waypoints[1] = point(0, -9000); n.waypoints[2] = point(30000, -9000); n.sequences[0] = [1, 2]; n.current = 1; n.steer = 'wypt'; n.auto = true })
    let switched = -1, north = Infinity
    const { log } = fly({ altitude: 3000, speed: 240 }, 100, (ap, s, time) => {
      const said = steering(nav, 'tac')(ap, s, time)
      if (nav.current === 2 && switched < 0) switched = -out[2]
      if (nav.current === 2) north = Math.min(north, out[2] + 9000)
      return said
    })
    expect(switched).toBeGreaterThan(3000); expect(switched).toBeLessThan(7500) // the turn begins short of the waypoint, 9 km out
    expect(north).toBeGreaterThan(-250) // and rolls out on the new course without crossing far past it
    expect(Math.abs(out[2] + 9000)).toBeLessThan(150); expect(Math.abs(P.wrap(last(log).track - 90))).toBeLessThan(3)
    const steepest = Math.max(...log.map((s) => Math.abs(s.bank)))
    expect(steepest).toBeGreaterThan(45); expect(steepest).toBeLessThan(61) // TAC at 410 knots: past NAV's 30°, inside 60°
  }, 60000)

  it('flies the carrier\'s commands to the touchdown point of a deck steaming away at an angle', () => {
    const link = L.fresh(); L.select(link); link.test = 0
    const deck = 20, ship = { x: 13 * Math.sin(-9 * D), z: -13 * Math.cos(9 * D) }, from = { x: -150, z: -4.5 * 1852 }
    let touch: { across: number; height: number; vertical: number; bank: number } | null = null
    const seen = new Set<string>(); let coupled = -1, tipped = false
    const { ap, log } = fly({ altitude: deck + 1200 * FOOT, speed: 75, landing: true }, 200, (ap, s, time) => {
      const p: L.Picture = {
        time, along: out[2] - (from.z + ship.z * time), across: out[0] - (from.x + ship.x * time), height: out[1] - deck, final: 0, altitude: out[1], waved: false,
        link: true, beacon: true, able: P.able(s), flaps: true, throttle: true, coupled: ap.modes.coupled ? ap.source : '',
      }
      L.step(link, p, DT)
      if (link.five) seen.add(link.five.discrete)
      const couple = L.couple(link, p)
      if (once(time, 20)) { P.select(ap, 'radar', { ...s, couple }); P.select(ap, 'coupled', { ...s, couple }); coupled = time }
      if (link.six && link.six.rate < -5) tipped = true
      if (p.along <= 0) { touch = { across: p.across, height: p.height, vertical: out[4], bank: s.bank }; return 'stop' }
      return { couple }
    })
    expect(coupled).toBeCloseTo(20, 6); expect([ap.modes.coupled, ap.source, ap.modes.radar]).toEqual([true, 'bank', false]) // both axes: the altitude hold went with the couple
    expect([...seen]).toEqual(expect.arrayContaining(['ACL RDY', 'CMD CNT'])); expect(tipped).toBe(true)
    expect(touch).not.toBeNull()
    const t = touch as unknown as { across: number; height: number; vertical: number; bank: number }
    expect(Math.abs(t.across)).toBeLessThan(0.5); expect(Math.abs(t.height)).toBeLessThan(0.5) // on the centreline and the glidepath at the wires
    expect(t.vertical).toBeLessThan(-3); expect(t.vertical).toBeGreaterThan(-5); expect(Math.abs(t.bank)).toBeLessThan(1)
    expect(Math.max(...log.map((s) => Math.abs(s.bank)))).toBeLessThan(21) // the SPN-42 asks no more than 20°
  }, 60000)

  // What the cockpit's systems tell the core through the frame's input words (flight.ts fill, the wasm's
  // controls): the wings' held fuel in word 15, mission computer 1 lost as flag 16384, and the pitch
  // trim's reset to on-speed as flag 32768.
  describe('the systems the cockpit tells the core of', () => {
    const FUEL = 13, SPOOL = 14, NORMAL = 34, DATUM = 110, BANK = 112, GEAR = 4, RESET = 128, REVERTED = 16384, ONSPEED = 32768
    const start = (altitude: number, speed: number, fuel: number) => {
      core.init(JSON.stringify({ aircraft: 'fa18c', environment: { seed: 1 }, world: { sea: 3 } }))
      core.level(0, altitude, 0, 0, -1, speed, fuel)
      input.fill(0); input[7] = 4
    }
    const run = (frames: number, each?: () => void) => { for (let k = 0; k < frames; k++) { input[6]++; core.frame(sent, read); each?.() } }

    it('leaves the fuel INTR WING holds in the wings unburned, the engines flaming out with it aboard (#130)', () => {
      const left = (held: number) => { start(6000, 220, 504); input[3] = 1; input[15] = held; run(1200); return [out[FUEL], out[SPOOL]] }
      const [free, turning] = left(0), [kept, stopped] = left(500)
      expect(free).toBeLessThan(490); expect(turning).toBeGreaterThan(0.9)
      expect(kept).toBeCloseTo(500, 6); expect(stopped).toBeLessThan(0.2)
    }, 60000)

    it('pulls to the 7.5 g placard at full tanks without mission computer 1, where the schedule holds it under (#134)', () => {
      const pull = (flags: number) => {
        start(2000, 250, 4900); input[3] = 1; input[8] = 1; input[5] = flags; run(120)
        let peak = 0
        input[0] = 1; run(360, () => { peak = Math.max(peak, out[NORMAL]) })
        return peak
      }
      const scheduled = pull(0), reverted = pull(REVERTED)
      expect(scheduled).toBeLessThan(7.15)
      expect(reverted).toBeGreaterThan(7.15); expect(reverted).toBeLessThan(8.1)
      expect(reverted - scheduled).toBeGreaterThan(0.25)
    }, 60000)

    it('puts the pitch trim back to on-speed and keeps the roll trim, where the trim reset zeroes both (#135)', () => {
      const trimmed = (flag: number) => {
        start(600, 72, 2000); input[3] = 0.5; input[5] = GEAR; input[10] = 2; input[9] = 1; input[11] = 1; run(60)
        const walked = [out[DATUM], out[BANK]]
        input[9] = 0; input[11] = 0; input[5] = GEAR | flag; run(1)
        return { walked, left: [out[DATUM], out[BANK]] }
      }
      const kept = trimmed(0), onspeed = trimmed(ONSPEED), reset = trimmed(RESET)
      expect(kept.walked[0]).toBeGreaterThan(0.005); expect(kept.walked[1]).toBeGreaterThan(0.005)
      expect(kept.left).toEqual(kept.walked)
      expect(onspeed.left).toEqual([0, onspeed.walked[1]])
      expect(reset.left).toEqual([0, 0])
    }, 60000)
  })
})
