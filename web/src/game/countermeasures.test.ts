// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { describe, expect, it } from 'vitest'
import * as C from './countermeasures'
import type { RwrContact } from './rwr'

// The dispenser/EMC panel and the RWR control indicator (#10, #9, FO-5 items 35
// and 36, NATOPS 2.13.12).
const LOAD = { chaff: 20, flare: 40 }
const air = () => C.fresh(true, LOAD)
const D = Math.PI / 180

describe('a spawn', () => {
  it('finds the dispenser on and the jammer listening in the air', () => {
    const s = air()
    expect([s.dispenser, s.jammer, s.receiver.power]).toEqual(['on', 'receive', true])
  })
  it('finds both off on the deck, the RWR on', () => {
    const s = C.fresh(false, LOAD)
    expect([s.dispenser, s.jammer, s.receiver.power]).toEqual(['off', 'off', true])
  })
  it('carries a bingo level of a quarter of each magazine', () => {
    expect(air().bingo).toEqual({ chaff: 5, flare: 10 })
  })
})

describe('the DISPENSER switch', () => {
  it('dispenses nothing at OFF', () => {
    const s = air(); s.dispenser = 'off'
    expect(C.dispense(s, -1, false, 5)).toBeNull()
    expect(C.dispense(s, 1, false, 5)).toBeNull()
  })
  it('runs the programme aft and gives a chaff single forward at ON', () => {
    const s = air()
    expect(C.dispense(s, -1, false, 5)).toEqual({ flare: 1, chaff: 1, programme: true })
    expect(C.dispense(s, 1, false, 6)).toEqual({ flare: 0, chaff: 1, programme: false })
  })
  it('runs the programme from the console button at ON', () => {
    expect(C.dispense(air(), 0, false, 5)).toEqual({ flare: 1, chaff: 1, programme: true })
  })
  it('goes round the programmer at BYPASS: a flare aft, a bundle forward, nothing from the button', () => {
    const s = air(); s.dispenser = 'bypass'
    expect(C.dispense(s, -1, false, 5)).toEqual({ flare: 1, chaff: 0, programme: false })
    expect(C.dispense(s, 1, false, 5)).toEqual({ flare: 0, chaff: 1, programme: false })
    expect(C.dispense(s, 0, false, 5)).toBeNull()
  })
  it('is inhibited with weight on wheels', () => {
    expect(C.dispense(air(), -1, true, 5)).toBeNull()
  })
  it('lights DISP for a second after a programme, and not for a single', () => {
    const s = air()
    C.dispense(s, 1, false, 5)
    expect(C.dispensing(s, 5.1)).toBe(false)
    C.dispense(s, -1, false, 6)
    expect(C.dispensing(s, 6.9)).toBe(true)
    expect(C.dispensing(s, 7)).toBe(false)
  })
  it('does not light DISP for a release that went round the programmer', () => {
    const s = air(); s.dispenser = 'bypass'
    C.dispense(s, -1, false, 5)
    expect(C.dispensing(s, 5.1)).toBe(false)
  })
})

describe('the dispenser advisories', () => {
  it('show D LOW with either category at its bingo level', () => {
    const s = air()
    expect(C.advisories(s, { chaff: 6, flare: 11 })).toEqual([])
    expect(C.advisories(s, { chaff: 5, flare: 11 })).toEqual(['D LOW'])
    expect(C.advisories(s, { chaff: 6, flare: 10 })).toEqual(['D LOW'])
  })
  it('show nothing from a set that is off', () => {
    const s = air(); s.dispenser = 'off'
    expect(C.advisories(s, { chaff: 0, flare: 0 })).toEqual([])
  })
})

describe('the ECM knob', () => {
  it('steps OFF, STBY, BIT, REC, XMIT and stops at its ends', () => {
    const s = C.fresh(false, LOAD), seen: string[] = []
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
    const s = C.fresh(false, LOAD)
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
    const s = C.fresh(false, LOAD)
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
