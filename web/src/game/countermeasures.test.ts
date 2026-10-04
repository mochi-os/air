// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { describe, expect, it } from 'vitest'
import * as C from './countermeasures'
import type { RwrContact } from './rwr'

// The dispenser/EMC panel and the RWR control indicator (#10, #9, FO-5 items 35
// and 36, NATOPS 2.13.12).
const air = () => C.fresh(true)
const D = Math.PI / 180
const { heat, mixed, radar } = C.PROGRAMMES
// run: a programme pressed at t=5 on a dispenser at ON, stepped at 60 Hz to t=12 - what left when.
function run(p: C.Programme, s = air()): [number, number, number][] {
  const out: [number, number, number][] = []
  const first = C.dispense(s, -1, false, 5, p)
  if (first) out.push([5, first.flare, first.chaff])
  for (let k = 1; k <= 7 * 60; k++) {
    const now = 5 + k / 60, drop = C.due(s, now, false)
    if (drop) out.push([Math.round(now * 1000) / 1000, drop.flare, drop.chaff])
  }
  return out
}

describe('a spawn', () => {
  it('finds the dispenser on and the jammer listening in the air', () => {
    const s = air()
    expect([s.dispenser, s.jammer, s.receiver.power, s.running]).toEqual(['on', 'receive', true, null])
  })
  it('finds both off on the deck, the RWR on', () => {
    const s = C.fresh(false)
    expect([s.dispenser, s.jammer, s.receiver.power]).toEqual(['off', 'off', true])
  })
})

describe('the programmes', () => {
  it('puts flares a second apart, past the seeker\'s 0.8 s look at each, and chaff two seconds apart, a bloom\'s life', () => {
    for (const p of [heat, mixed, radar]) {
      if (p.flare.count) expect(p.flare.interval).toBe(1)
      if (p.chaff.count) expect(p.chaff.interval).toBe(2)
    }
    expect([heat.flare.count, heat.chaff.count]).toEqual([4, 0])
    expect([mixed.flare.count, mixed.chaff.count]).toEqual([3, 2])
    expect([radar.flare.count, radar.chaff.count]).toEqual([2, 3])
  })
  it('chooses by what can be fired at the jet: heat missiles alone, both, or the radar round first beyond visual range', () => {
    expect(C.programme('fox2', false)).toBe(heat)
    expect(C.programme('guns', false)).toBe(heat) // nothing to decoy: the switch runs the same everywhere
    expect(C.programme('open', false)).toBe(mixed)
    expect(C.programme('open', true)).toBe(radar)
    expect(C.programme('fox2', true)).toBe(heat) // a BVR start without radar missiles has none to decoy
  })
  it('sets D LOW at two programmes left of each category it releases, and at empty for one it does not', () => {
    expect(C.bingo(heat)).toEqual({ flare: 8, chaff: 0 })
    expect(C.bingo(mixed)).toEqual({ flare: 6, chaff: 4 })
    expect(C.bingo(radar)).toEqual({ flare: 4, chaff: 6 })
  })
})

describe('the DISPENSER switch', () => {
  it('dispenses nothing at OFF', () => {
    const s = air(); s.dispenser = 'off'
    expect(C.dispense(s, -1, false, 5, mixed)).toBeNull()
    expect(C.dispense(s, 1, false, 5, mixed)).toBeNull()
    expect(s.running).toBeNull()
  })
  it('runs the heat programme aft: four flares a second apart, the first at the press', () => {
    expect(run(heat)).toEqual([[5, 1, 0], [6, 1, 0], [7, 1, 0], [8, 1, 0]])
  })
  it('runs the mixed programme: three flares a second apart, two bundles two seconds apart', () => {
    expect(run(mixed)).toEqual([[5, 1, 1], [6, 1, 0], [7, 1, 1]])
  })
  it('runs the radar programme: three bundles two seconds apart, two flares a second apart', () => {
    expect(run(radar)).toEqual([[5, 1, 1], [6, 1, 0], [7, 0, 1], [9, 0, 1]])
  })
  it('gives a chaff single forward at ON, whatever the programme', () => {
    const s = air()
    expect(C.dispense(s, 1, false, 5, heat)).toEqual({ flare: 0, chaff: 1, programme: false })
    expect(s.running).toBeNull()
  })
  it('runs the programme from the console button at ON', () => {
    expect(C.dispense(air(), 0, false, 5, heat)).toEqual({ flare: 1, chaff: 0, programme: true })
  })
  it('adds nothing for a press while a programme runs, and runs it again once it has ended', () => {
    const s = air()
    C.dispense(s, -1, false, 5, heat)
    expect(C.dispense(s, -1, false, 5.5, heat)).toBeNull()
    for (const now of [6, 7, 8]) C.due(s, now, false)
    expect(s.running).toBeNull()
    expect(C.dispense(s, -1, false, 9, heat)).toEqual({ flare: 1, chaff: 0, programme: true })
  })
  it('stops the programme when the dispenser leaves ON or the wheels touch', () => {
    for (const stop of [(s: C.Suite) => { s.dispenser = 'off' }, (s: C.Suite) => { s.dispenser = 'bypass' }]) {
      const s = air()
      C.dispense(s, -1, false, 5, heat)
      stop(s)
      expect(C.due(s, 6, false)).toBeNull()
      expect(s.running).toBeNull()
    }
    const s = air()
    C.dispense(s, -1, false, 5, heat)
    expect(C.due(s, 6, true)).toBeNull()
    expect(s.running).toBeNull()
  })
  it('lets a release a frame late go on the next, one of each at a time', () => {
    const s = air()
    C.dispense(s, -1, false, 5, heat)
    expect(C.due(s, 8.5, false)).toEqual({ flare: 1, chaff: 0, programme: true }) // three were due; one goes
    expect(C.due(s, 8.5, false)).toEqual({ flare: 1, chaff: 0, programme: true })
    expect(C.due(s, 8.5, false)).toEqual({ flare: 1, chaff: 0, programme: true })
    expect(C.due(s, 8.5, false)).toBeNull()
  })
  it('goes round the programmer at BYPASS: a flare aft, a bundle forward, nothing from the button', () => {
    const s = air(); s.dispenser = 'bypass'
    expect(C.dispense(s, -1, false, 5, mixed)).toEqual({ flare: 1, chaff: 0, programme: false })
    expect(C.dispense(s, 1, false, 5, mixed)).toEqual({ flare: 0, chaff: 1, programme: false })
    expect(C.dispense(s, 0, false, 5, mixed)).toBeNull()
    expect(s.running).toBeNull()
  })
  it('is inhibited with weight on wheels', () => {
    expect(C.dispense(air(), -1, true, 5, mixed)).toBeNull()
  })
  it('lights DISP while a programme runs and for a second after its last release, and not for a single', () => {
    const s = air()
    C.dispense(s, 1, false, 4, heat)
    expect(C.dispensing(s, 4.1)).toBe(false)
    C.dispense(s, -1, false, 5, heat)
    for (const now of [5.5, 6, 6.5, 7, 7.5, 8]) {
      C.due(s, now, false)
      expect(C.dispensing(s, now), `at ${now}`).toBe(true)
    }
    expect(s.running).toBeNull()
    expect(C.dispensing(s, 8.99)).toBe(true)
    const r = air() // and across a gap longer than the light's second: the radar programme's last two bundles, two seconds apart
    C.dispense(r, -1, false, 5, radar)
    for (const now of [6, 7]) C.due(r, now, false)
    expect(C.dispensing(r, 8.5)).toBe(true)
    expect(C.dispensing(s, 9.01)).toBe(false)
  })
  it('does not light DISP for a release that went round the programmer', () => {
    const s = air(); s.dispenser = 'bypass'
    C.dispense(s, -1, false, 5, mixed)
    expect(C.dispensing(s, 5.1)).toBe(false)
  })
})

describe('the dispenser advisories', () => {
  it('show D LOW with either category at its bingo level, two programmes left', () => {
    const s = air()
    expect(C.advisories(s, { chaff: 5, flare: 7 }, mixed)).toEqual([])
    expect(C.advisories(s, { chaff: 4, flare: 7 }, mixed)).toEqual(['D LOW'])
    expect(C.advisories(s, { chaff: 5, flare: 6 }, mixed)).toEqual(['D LOW'])
  })
  it('show D LOW for a category the programme leaves alone only once it is empty', () => {
    const s = air()
    expect(C.advisories(s, { chaff: 1, flare: 9 }, heat)).toEqual([])
    expect(C.advisories(s, { chaff: 0, flare: 9 }, heat)).toEqual(['D LOW'])
  })
  it('show nothing from a set that is off', () => {
    const s = air(); s.dispenser = 'off'
    expect(C.advisories(s, { chaff: 0, flare: 0 }, mixed)).toEqual([])
  })
})

describe('the ECM knob', () => {
  it('steps OFF, STBY, BIT, REC, XMIT and stops at its ends', () => {
    const s = C.fresh(false), seen: string[] = []
    for (let k = 0; k < 5; k++) { C.turn(s, 1, k); seen.push(s.jammer) }
    expect(seen).toEqual(['standby', 'test', 'receive', 'transmit', 'transmit'])
    for (let k = 0; k < 6; k++) C.turn(s, -1, 10)
    expect(s.jammer).toBe('off')
  })
  it('radiates only at XMIT and only while painted', () => {
    const s = air()
    expect(C.radiating(s, true, true)).toBe(false)
    s.jammer = 'transmit'
    expect(C.radiating(s, true, true)).toBe(true)
    expect(C.radiating(s, false, true)).toBe(false)
  })
  it('neither listens nor radiates without ac power', () => {
    const s = air()
    s.jammer = 'transmit'
    expect(C.operating(s, true)).toBe(true)
    expect(C.operating(s, false)).toBe(false)
    expect(C.radiating(s, true, false)).toBe(false)
  })
  it('goes to XMIT on its key from any position, and back to REC', () => {
    const s = C.fresh(false)
    C.toggle(s); expect(s.jammer).toBe('transmit')
    C.toggle(s); expect(s.jammer).toBe('receive')
  })
})

describe('the jammer lights', () => {
  const at = (jammer: C.Jammer, painted = false, now = 100, power = true) => { const s = air(); s.jammer = jammer; s.tested = 0; return C.lamps(s, painted, power, 60, now) }
  const dark = { standby: false, on: false, receive: false, transmit: false, go: false }
  it('are all out at OFF', () => {
    expect(at('off', true)).toEqual(dark)
  })
  it('are all out without ac power, whatever the knob', () => {
    for (const jammer of C.JAMMER) expect(at(jammer, true, 100, false), jammer).toEqual(dark)
  })
  it('show STBY alone at STBY', () => {
    expect(at('standby', true)).toEqual({ ...dark, standby: true })
  })
  it('show ASPJ ON and REC while listening, at REC whatever paints the jet', () => {
    expect(at('receive')).toEqual({ ...dark, on: true, receive: true })
    expect(at('receive', true)).toEqual({ ...dark, on: true, receive: true })
  })
  it('show XMIT in place of REC while radiating', () => {
    expect(at('transmit')).toEqual({ ...dark, on: true, receive: true })
    expect(at('transmit', true)).toEqual({ ...dark, on: true, transmit: true })
  })
  it('show GO once the test at BIT has run', () => {
    expect(at('test', false, 59)).toEqual(dark)
    expect(at('test', false, 60)).toEqual({ ...dark, go: true })
  })
  it('time the test from the knob reaching BIT', () => {
    const s = C.fresh(false)
    C.turn(s, 1, 10); C.turn(s, 1, 20)
    expect(s.tested).toBe(20)
    C.turn(s, 1, 30); C.turn(s, -1, 40)
    expect(s.tested).toBe(40)
  })
})

describe('the RWR control indicator', () => {
  const heard = (id: number, bearing: number, at: number, more: Partial<RwrContact> = {}): RwrContact => ({ id, bearing, locked: false, at, ...more })
  const eight = [1, 2, 3, 4, 5, 6, 7, 8].map((k) => heard(k, k * 30 * D, k))
  it('shows nothing with the power off', () => {
    const s = air(); C.press(s.receiver, 'power', 0)
    expect(C.shown(s.receiver, eight)).toEqual([])
  })
  it('shows every emitter without LIMIT and the six of highest priority with it', () => {
    const s = air()
    expect(C.shown(s.receiver, eight)).toHaveLength(8)
    C.press(s.receiver, 'display', 0)
    expect(C.shown(s.receiver, eight).map((c) => c.id)).toEqual([8, 7, 6, 5, 4, 3])
  })
  it('ranks a missile over a lock and a lock over a search radar', () => {
    const s = air(); C.press(s.receiver, 'display', 0)
    const mixed = [...eight, heard(20, 0, 0, { locked: true }), heard(21, 0, 0, { locked: true, missile: true })]
    expect(C.shown(s.receiver, mixed).map((c) => c.id)).toEqual([21, 20, 8, 7, 6, 5])
  })
  it('lights ON, LIMIT and the ENABLEs with their functions', () => {
    const s = air(), r = s.receiver
    expect(C.indicator(r, 100)).toEqual({ power: true, limit: false, offset: false, special: false, fail: false })
    C.press(r, 'display', 0); C.press(r, 'offset', 0); C.press(r, 'special', 0)
    expect(C.indicator(r, 100)).toEqual({ power: true, limit: true, offset: true, special: true, fail: false })
  })
  it('lights every light for the span of its BIT', () => {
    const r = air().receiver
    C.press(r, 'test', 50)
    expect(C.indicator(r, 51)).toEqual({ power: true, limit: true, offset: true, special: true, fail: true })
    expect(C.indicator(r, 51.9).fail).toBe(true)
    expect(C.indicator(r, 52).fail).toBe(false) // two seconds
  })
  it('is dark, and answers only POWER, with the power off', () => {
    const r = air().receiver
    C.press(r, 'power', 0)
    C.press(r, 'display', 0); C.press(r, 'test', 10)
    expect([r.limit, r.tested]).toEqual([false, -Infinity])
    expect(C.indicator(r, 10)).toEqual({ power: false, limit: false, offset: false, special: false, fail: false })
    C.press(r, 'power', 0)
    expect(r.power).toBe(true)
  })
})

describe('OFFSET', () => {
  const near = (a: number, b: number) => expect(Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)))).toBeLessThan(1e-9)
  const on = () => { const r = air().receiver; C.press(r, 'offset', 0); return r }
  it('leaves the bearings alone when it is not enabled', () => {
    expect(C.spread(air().receiver, [10 * D, 12 * D])).toEqual([10 * D, 12 * D])
  })
  it('moves two overlapping symbols apart about their mean', () => {
    const out = C.spread(on(), [10 * D, 12 * D])
    near(out[0], 5 * D); near(out[1], 17 * D)
  })
  it('leaves symbols already apart where they are', () => {
    const out = C.spread(on(), [10 * D, 40 * D])
    near(out[0], 10 * D); near(out[1], 40 * D)
  })
  it('spreads a group of three evenly and keeps each in its order', () => {
    const out = C.spread(on(), [100 * D, 96 * D, 104 * D])
    near(out[1], 88 * D); near(out[0], 100 * D); near(out[2], 112 * D)
  })
  it('spreads a pair either side of dead astern', () => {
    const out = C.spread(on(), [179 * D, -179 * D])
    near(out[0], 174 * D); near(out[1], -174 * D)
  })
  it('spreads a pair either side of the nose, with the rest of the ring where it was', () => {
    const out = C.spread(on(), [1 * D, -1 * D, 90 * D])
    near(out[0], 6 * D); near(out[1], -6 * D); near(out[2], 90 * D)
  })
})
