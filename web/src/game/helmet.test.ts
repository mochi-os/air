// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { describe, expect, it } from 'vitest'
import * as H from './helmet'

const D = Math.PI / 180
const unaligned = { azimuth: 2 * D, elevation: -1 * D, roll: 3 * D }
const air = () => H.fresh(true, unaligned, 0)
const deck = (direction = 0) => H.fresh(false, unaligned, direction)
const run = (h: H.Helmet, seconds: number, power = true) => { for (let t = 0; t < seconds; t += 0.25) H.step(h, power, 0.25) }

describe('a spawn', () => {
  it('in the air is powered, warmed up and aligned with no error', () => {
    const h = air()
    expect([h.on, H.ready(h), h.coarse, H.advisory(h)]).toEqual([true, true, true, false])
    expect(H.offset(h)).toEqual({ azimuth: 0, elevation: 0, roll: 0 })
  })
  it('on the deck is off and has never been aligned, so its line of sight reads off', () => {
    const h = deck()
    expect([h.on, H.ready(h), h.coarse, H.advisory(h)]).toEqual([false, false, false, false]) // no advisory while it is off
    expect(H.offset(h)).toEqual(unaligned)
  })
})

describe('power', () => {
  it('runs the start-up BIT, which cannot be cut short, then is ready', () => {
    const h = deck()
    H.step(h, true, 0.1)
    expect([H.starting(h), H.ready(h), H.advisory(h)]).toEqual([true, false, true]) // the HMD advisory: not aligned
    run(h, H.SBIT)
    expect([H.starting(h), H.ready(h)]).toEqual([false, true])
  })
  it('turned off ends the alignment, the TDC priority and the test patterns; on again, the BIT and the warm-up start over', () => {
    const h = air()
    Object.assign(h, { mode: 'fine', priority: true, patterns: 5 })
    H.step(h, false, 0.1)
    expect([h.on, h.mode, h.priority, h.patterns]).toEqual([false, '', false, -1])
    H.step(h, true, 0.1)
    expect([h.time, H.ready(h), h.coarse]).toEqual([0.1, false, true]) // the alignment itself is kept
  })
})

describe('coarse alignment', () => {
  const aligning = () => { const h = deck(); run(h, H.SBIT); H.align(h); return h }
  it('waits for the start-up BIT', () => {
    const h = deck()
    H.step(h, true, 0.1)
    H.align(h)
    expect(h.mode).toBe('')
  })
  it('reads READY, ALIGNING while the switch is held, and ALIGN OK, leaving what the pilot\'s aim was off by', () => {
    const h = aligning()
    expect([h.mode, H.message(h)]).toEqual(['coarse', 'READY'])
    H.hold(h, true, 0.5, { azimuth: 0.3 * D, elevation: -0.2 * D }, true)
    expect(H.message(h)).toBe('ALIGNING')
    H.hold(h, true, 0.5, { azimuth: 0.3 * D, elevation: -0.2 * D }, true)
    expect([h.coarse, h.mode, h.axis, H.confirmed(h), H.advisory(h)]).toEqual([true, 'fine', 'position', true, false]) // fine alignment follows by itself
    expect(H.offset(h).azimuth).toBeCloseTo(0.3 * D, 12)
    expect(H.offset(h).elevation).toBeCloseTo(-0.2 * D, 12)
    expect(H.offset(h).roll).toBe(3 * D) // a cross laid on a cross says nothing of roll
  })
  it('starts again if the switch is let go too soon', () => {
    const h = aligning()
    H.hold(h, true, 0.6, { azimuth: 0, elevation: 0 }, true)
    H.hold(h, false, 0.1, { azimuth: 0, elevation: 0 }, true)
    H.hold(h, true, 0.6, { azimuth: 0, elevation: 0 }, true)
    expect(h.coarse).toBe(false)
  })
  it('fails with the canopy up, and the old error stands', () => {
    const h = aligning()
    H.hold(h, true, H.HOLD, { azimuth: 0, elevation: 0 }, false)
    expect([h.coarse, h.mode, H.message(h)]).toEqual([false, 'coarse', 'ALIGN FAIL'])
    expect(H.offset(h)).toEqual(unaligned)
  })
  it('made before warm-up drifts up to half a degree by its end; made after, it does not', () => {
    const h = aligning()
    H.hold(h, true, H.HOLD, { azimuth: 0, elevation: 0 }, true)
    const early = h.time
    run(h, H.WARM)
    expect(H.offset(h).azimuth).toBeCloseTo(H.DRIFT * (1 - early / H.WARM), 9)
    const late = deck(Math.PI / 2)
    run(late, H.WARM)
    H.align(late)
    H.hold(late, true, H.HOLD, { azimuth: 0, elevation: 0 }, true)
    run(late, 600)
    expect([H.offset(late).azimuth, H.offset(late).elevation]).toEqual([0, 0])
  })
  it('the drift grows as warm-up goes on, in its own direction', () => {
    const h = deck(Math.PI / 2)
    run(h, H.SBIT)
    H.align(h)
    H.hold(h, true, H.HOLD, { azimuth: 0, elevation: 0 }, true)
    run(h, (H.WARM - h.time) / 2)
    const half = H.offset(h)
    expect(half.azimuth).toBeCloseTo(0, 12)
    expect(half.elevation).toBeGreaterThan(0)
    expect(half.elevation).toBeLessThan(H.DRIFT * 0.6)
  })
})

describe('fine alignment', () => {
  const fined = () => { const h = deck(); run(h, H.SBIT); H.align(h); H.hold(h, true, H.HOLD, { azimuth: 0, elevation: 0 }, true); return h }
  it('moves the crosses the way the TDC is pushed, in azimuth and elevation', () => {
    const h = fined()
    H.nudge(h, 1, 0.5, 1)
    expect(H.offset(h).azimuth).toBeCloseTo(-H.NUDGE, 9) // crosses drawn at -error: right pushes them right
    expect(H.offset(h).elevation).toBeCloseTo(-0.5 * H.NUDGE, 9)
    expect(H.message(h)).toBe('FA DXDY')
  })
  it('toggles to roll on a press of the cage/uncage switch, and the TDC then turns the crosses', () => {
    const h = fined()
    H.toggle(h)
    expect(H.message(h)).toBe('FA DROLL')
    H.nudge(h, -1, 1, 1)
    expect(H.offset(h).roll).toBeCloseTo(3 * D + H.NUDGE, 9)
    expect(H.offset(h).azimuth).toBeCloseTo(0, 12)
    H.toggle(h)
    expect(h.axis).toBe('position')
  })
  it('keeps what has drifted when it is nudged, and what is left to drift shrinks with the warm-up', () => {
    const h = fined()
    run(h, 300)
    const drifted = H.offset(h).azimuth
    H.nudge(h, 0, 0.001, 0.001)
    expect(H.offset(h).azimuth).toBeCloseTo(drifted, 12)
    expect(h.drift).toBeCloseTo(H.DRIFT * (1 - h.time / H.WARM), 12)
  })
  it('FINE is offered only with a coarse alignment, and unboxed returns to coarse', () => {
    const h = deck()
    run(h, H.SBIT)
    H.align(h)
    expect(H.press(h, 1)).toBe(false)
    expect(H.legends(h).some(([pb]) => pb === 1)).toBe(false)
    H.hold(h, true, H.HOLD, { azimuth: 0, elevation: 0 }, true)
    expect(H.legends(h).find(([pb]) => pb === 1)).toEqual([1, 'FINE', true])
    H.press(h, 1)
    expect([h.mode, H.message(h)]).toEqual(['coarse', 'READY'])
  })
  it('ends on ALIGN unboxed', () => {
    const h = fined()
    H.press(h, 20)
    expect([h.mode, H.message(h), H.legends(h).find(([pb]) => pb === 20)]).toEqual(['', '', [20, 'ALIGN', false]])
  })
})

describe('the HMD format', () => {
  it('lays out NORM, BRT AUTO, BLNK boxed, REJECT SETUP and ALIGN as figure 2-56 does', () => {
    expect(H.legends(air())).toEqual([[7, 'NORM', false], [11, 'BRT AUTO', false], [12, 'BLNK', true], [19, 'REJECT SETUP', false], [20, 'ALIGN', false]])
  })
  it('steps the reject level, the brightness mode - DAY, NIGHT, AUTO - and the blanking', () => {
    const h = air()
    expect([H.press(h, 7), H.press(h, 7), H.press(h, 11), H.press(h, 12)]).toEqual([true, true, true, true])
    expect(H.legends(h).slice(0, 3)).toEqual([[7, 'REJ 2', false], [11, 'BRT DAY', false], [12, 'BLNK', false]])
    H.press(h, 11)
    expect(H.legends(h)[1]).toEqual([11, 'BRT NIGHT', false])
    H.press(h, 11)
    expect(H.legends(h)[1]).toEqual([11, 'BRT AUTO', false])
    H.press(h, 7)
    expect(h.reject).toBe(0)
  })
  it('is full bright on DAY, half on NIGHT, and on AUTO whichever the light outside calls for', () => {
    const h = air()
    expect([H.level(h, 0.8, false), H.level(h, 0.8, true)]).toEqual([0.8, 0.4])
    h.brightness = 'day'
    expect([H.level(h, 0.8, false), H.level(h, 0.8, true)]).toEqual([0.8, 0.8])
    h.brightness = 'night'
    expect([H.level(h, 0.8, false), H.level(h, 0.8, true)]).toEqual([0.4, 0.4])
  })
  it('shows the four test patterns a second each', () => {
    const h = air()
    expect(H.pattern(h)).toBe(-1)
    h.patterns = h.time
    expect([0, 1, 2, 3, 4].map((s) => { const k = { ...h, time: h.patterns + s + 0.5 }; return H.pattern(k) })).toEqual([0, 1, 2, 3, 0])
  })
})

describe('REJECT SETUP', () => {
  it('opens at 19 with its arrows, ON, 1, 2 and RETURN, and goes back to the format at RETURN', () => {
    const h = air()
    expect(H.press(h, 19)).toBe(true)
    expect(h.setup).toBe(true)
    expect(H.legends(h)).toEqual([[6, '←', false], [7, '→', false], [5, '↑', false], [4, '↓', false], [14, '↑', false], [15, '↓', false], [3, 'ON', false], [2, '1', false], [1, '2', false], [19, 'RETURN', false]])
    expect([H.press(h, 20), h.mode]).toEqual([false, '']) // ALIGN is the format's, not the sublevel's
    H.press(h, 19)
    expect([h.setup, H.legends(h)[0]]).toEqual([false, [7, 'NORM', false]])
  })
  it('lists the symbols in two columns at the levels the sublevel starts with', () => {
    const levels = H.fresh(true, { azimuth: 0, elevation: 0, roll: 0 }, 0).levels
    expect([levels.ALTITUDE, levels['HMD HEADING'], levels['HMD ELEV'], levels['A/C HEADING'], levels['TIME WINDOW'], levels['ALT_ASPD_BOX'], levels.MACH, levels['MAX G'], levels['WINDOW 10']]).toEqual([0, 2, 2, 2, 2, 1, 1, 1, 2])
    expect(H.SETUP.map((c) => c.length)).toEqual([18, 18])
    expect(H.SETUP[0][14]).toBeNull()
  })
  it('moves the selection up and down a column, over the blank row and no further than its ends, and across', () => {
    const h = air()
    H.press(h, 19)
    H.press(h, 5)
    expect(h.cursor).toEqual([0, 0])
    for (let k = 0; k < 13; k++) H.press(h, 4)
    expect(h.cursor).toEqual([0, 13])
    H.press(h, 15)
    expect(h.cursor).toEqual([0, 15]) // TIME WINDOW to MEMBERS
    H.press(h, 14)
    expect(h.cursor).toEqual([0, 13])
    H.press(h, 7)
    expect(h.cursor).toEqual([1, 13])
    H.press(h, 4); H.press(h, 6)
    expect(h.cursor).toEqual([0, 15]) // the blank row on the left: the next symbol down
    for (let k = 0; k < 5; k++) H.press(h, 4)
    expect(h.cursor).toEqual([0, 17])
  })
  it('sets the selected symbol to ON, 1 or 2, which the reject level then removes it at', () => {
    const h = air()
    H.press(h, 19)
    expect(H.shown(h, 'ALTITUDE')).toBe(true)
    H.press(h, 2)
    h.reject = 1
    expect([h.levels.ALTITUDE, H.shown(h, 'ALTITUDE')]).toEqual([1, false])
    H.press(h, 1)
    expect([h.levels.ALTITUDE, H.shown(h, 'ALTITUDE')]).toEqual([2, true])
    h.reject = 2
    expect(H.shown(h, 'ALTITUDE')).toBe(false)
    H.press(h, 3)
    expect([h.levels.ALTITUDE, H.shown(h, 'ALTITUDE')]).toEqual([0, true])
    expect([H.shown(h, 'MACH'), H.shown(h, 'HMD ELEV')]).toEqual([false, false])
    h.reject = 1
    expect([H.shown(h, 'MACH'), H.shown(h, 'HMD ELEV')]).toEqual([false, true])
  })
})

describe('the mission computers', () => {
  it('pick the symbology set: MC2 backs a failed MC1, MC1 a failed MC2', () => {
    expect([H.backup({ one: true, two: true }), H.backup({ one: false, two: true }), H.backup({ one: true, two: false }), H.backup({ one: false, two: false })]).toEqual(['full', 'two', 'one', 'none'])
  })
  it('slave the radar and the AIM-9 only through MC2, and only with the helmet working', () => {
    const h = air()
    expect([H.slaving(h, { one: true, two: true }), H.slaving(h, { one: false, two: true }), H.slaving(h, { one: true, two: false })]).toEqual([true, true, false])
    const off = deck()
    expect(H.slaving(off, { one: true, two: true })).toBe(false)
  })
})

describe('the seeker', () => {
  const nose = { x: 1, y: 0, z: 0 }
  const at = (az: number, el = 0) => ({ x: Math.cos(el * D) * Math.cos(az * D), y: Math.sin(el * D), z: Math.cos(el * D) * Math.sin(az * D) })
  const angle = (a: H.Vector, b: H.Vector) => Math.acos(Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z)) / D
  it('looks where the helmet looks inside its gimbal', () => {
    expect(H.slave(at(30, 10), nose)).toEqual(at(30, 10))
  })
  it('stops at its gimbal limit on the way the pilot looks beyond it', () => {
    const s = H.slave(at(70), nose)
    expect(angle(s, nose)).toBeCloseTo(40, 9)
    expect(angle(s, at(70))).toBeCloseTo(30, 9)
    expect(H.slave(at(0, 0), { x: -1, y: 0, z: 0 })).toEqual({ x: -1, y: 0, z: 0 }) // dead astern: the nose itself
  })
  it('sees what is inside its field and nothing outside it', () => {
    expect([H.within(at(20), at(22), H.SEEKER), H.within(at(20), at(23), H.SEEKER)]).toEqual([true, false])
  })
  it('travels as two small integers and back within a hundredth of a degree', () => {
    for (const [az, el] of [[0, 0], [37.5, 12.25], [-120, -45], [179.99, 80]]) {
      const v = at(az, el)
      const packed = H.pack(v)
      expect(packed.every((n) => Number.isInteger(n) && Math.abs(n) <= 18000)).toBe(true)
      expect(angle(H.unpack(packed), v)).toBeLessThan(0.011)
    }
    expect(H.pack(at(90, 0))).toEqual([9000, 0])
  })
})
