// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { HOLD, LIMIT, STEP, elapsed, face, flow, fresh, noz, oil, press, rpm, type Reading } from './ifei'

// The IFEI readout against NATOPS A1-F18AC-NFM-000 2.1.1.7.5, 2.2.10.1 and
// 2.12.8: the display increments, the fuel counters, the QTY sub-levels, the
// BINGO arrows and the two time lines.
const reading = (over: Partial<Reading> = {}): Reading => ({
  rpm: [66.4, 99.2],
  egt: [464.4, 812.6],
  flow: [3231, 12345],
  noz: [83, 14],
  oil: [58, 97],
  internal: 8642,
  external: 2400,
  tanks: { left: true, right: true, centre: false },
  ...over,
})
const noon = new Date(2026, 8, 16, 13, 4, 9) // local 13:04:09

describe('the engine columns', () => {
  it('read RPM and TEMP whole, NOZ in tens and OIL in fives', () => {
    const f = face(reading(), fresh(), noon, 0)
    expect(f.engine.map((r) => [r.label, r.left, r.right])).toEqual([
      ['RPM', '66', '99'],
      ['TEMP', '464', '813'],
      ['FF', '3200', '12300'],
      ['NOZ', '80', '10'],
      ['OIL', '60', '95'],
    ])
  })

  it('round fuel flow to hundreds and read zero below 320 pph', () => {
    expect(flow(319)).toBe('0')
    expect(flow(320)).toBe('300')
    expect(flow(349)).toBe('300')
    expect(flow(350)).toBe('400')
    expect(flow(250000)).toBe('199900')
  })

  it('clamp each display to its range', () => {
    expect(rpm(240)).toBe('199')
    expect(noz(130)).toBe('100')
    expect(oil(300)).toBe('195')
    expect(rpm(NaN)).toBe('')
  })
})

describe('the fuel window', () => {
  it('shows total and internal in 10 lb steps with BINGO beneath', () => {
    const f = face(reading(), fresh(3000), noon, 0)
    expect(f.fuel.upper).toEqual({ legend: 'T', value: '11040' })
    expect(f.fuel.middle).toEqual({ legend: 'I', value: '8640' })
    expect(f.fuel.lower).toEqual({ legend: 'BINGO', value: '3000' })
  })

  it('cycles QTY through the five sub-levels and back, total replacing BINGO', () => {
    let s = fresh()
    const seen: string[][] = []
    for (let i = 0; i < 6; i++) {
      s = press(s, 'qty', 0)
      const f = face(reading(), s, noon, 0)
      seen.push([f.fuel.upper.legend, f.fuel.middle.legend, f.fuel.lower.legend])
    }
    expect(seen).toEqual([
      ['FL', 'FR', 'T'],
      ['TL', 'TR', 'T'],
      ['WL', 'WR', 'T'],
      ['XL', 'XR', 'T'],
      ['C', '', 'T'],
      ['T', 'I', 'BINGO'],
    ])
  })

  it('leaves the internal tank pairs blank and shares the externals across the tanks fitted', () => {
    let s = press(fresh(), 'qty', 0) // FL/FR
    expect(face(reading(), s, noon, 0).fuel.upper.value).toBe('')
    s = press(press(press(s, 'qty', 0), 'qty', 0), 'qty', 0) // XL/XR
    expect(face(reading(), s, noon, 0).fuel.upper.value).toBe('1200')
    expect(face(reading(), s, noon, 0).fuel.middle.value).toBe('1200')
    expect(face(reading({ tanks: { left: false, right: true, centre: true } }), s, noon, 0).fuel.upper.value).toBe('')
    s = press(s, 'qty', 0) // C
    expect(face(reading(), s, noon, 0).fuel.upper.value).toBe('')
    expect(face(reading({ tanks: { left: false, right: false, centre: true } }), s, noon, 0).fuel.upper.value).toBe('2400')
    expect(face(reading(), s, noon, 0).fuel.lower).toEqual({ legend: 'T', value: '11040' })
  })

  it('steps BINGO by 100 lb inside 0 to 20,000, and not in a sub-level', () => {
    let s = fresh(3000)
    s = press(s, 'up', 0)
    expect(s.bingo).toBe(3000 + STEP)
    s = press(press(s, 'down', 0), 'down', 0)
    expect(s.bingo).toBe(3000 - STEP)
    expect(press(fresh(LIMIT), 'up', 0).bingo).toBe(LIMIT)
    expect(press(fresh(0), 'down', 0).bingo).toBe(0)
    const sub = press(fresh(3000), 'qty', 0)
    expect(press(sub, 'up', 0).bingo).toBe(3000)
  })
})

describe('the time lines', () => {
  it('show the clock local or zulu on ZONE', () => {
    const s = fresh()
    expect(face(reading(), s, noon, 0).clock).toBe('13:04:09')
    const z = press(s, 'zone', 0)
    const f = face(reading(), z, noon, 0)
    expect(f.zulu).toBe(true)
    expect(f.clock).toBe(
      String(noon.getUTCHours()).padStart(2, '0') + ':' + String(noon.getUTCMinutes()).padStart(2, '0') + ':09',
    )
    expect(press(z, 'zone', 0).zulu).toBe(false)
  })

  it('ET starts, freezes the display while timing continues, resumes, and a long hold resets', () => {
    let s = fresh()
    expect(face(reading(), s, noon, 100).elapsed).toBe('0:00:00')
    s = press(s, 'et', 100) // start
    expect(face(reading(), s, noon, 165).elapsed).toBe('0:01:05')
    s = press(s, 'et', 170) // freeze at 1:10
    expect(face(reading(), s, noon, 200).elapsed).toBe('0:01:10')
    s = press(s, 'et', 200) // back to the running time, which never stopped
    expect(face(reading(), s, noon, 220).elapsed).toBe('0:02:00')
    s = press(s, 'et', 230, HOLD) // hold: stop and reset
    expect(face(reading(), s, noon, 300).elapsed).toBe('0:00:00')
    expect(elapsed(3600 * 12 + 61)).toBe('9:01:01')
  })

  it('MODE does nothing', () => {
    const s = fresh()
    expect(press(s, 'mode', 0)).toEqual(s)
  })
})

// The pit side: the A/B drum unit is hidden and no longer driven, and the
// caution BINGO follows the IFEI setting instead of a constant.
describe('the engine wiring', () => {
  const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')

  it('hides the drum counters and the pointer fuel gauge, and nothing else nearby', () => {
    const hide = /fa18c:\{[\s\S]*?\n\t\thide:(\/[^\n]*?\/[a-z]*),/.exec(source)?.[1] ?? ''
    expect(hide).not.toBe('')
    const re = new Function('return ' + hide)() as RegExp
    for (const drum of ['RPMNeedleL_647', 'RPMNeedleR2Action_AN__655', 'EGT_10_425', 'EGT2_1000_AN_1000_421', 'FuelFlowAction3_473', 'Fuel_Flow1b_458', 'Fuel_Needle_467', 'FuelNeedleAction_AN_Needle_466', 'Fuel_Drum_10000_452', 'NozzleL_626', 'NozzleR_629'])
      expect(re.test(drum), drum).toBe(true)
    for (const keep of ['Fuel_Dump_455', 'Fuel_Selector_470', 'Gear_handle_483', 'Object_1045', 'VSINeedleAction_AN__736', 'Airspeed_Action_AN__350'])
      expect(re.test(keep), keep).toBe(false)
  })

  it('no longer drives the drums from the gauge rig', () => {
    const rig = /rig:\[[\s\S]*?\{ name:"flaplever"[^\n]*\n/.exec(source)?.[0] ?? ''
    expect(rig).not.toBe('')
    expect(rig).not.toMatch(/gauge:"(rpmL|rpmR|egtL|egtR|flowL|flowR|fuelLbs)"/)
  })

  it('lets the IFEI setting own the BINGO the cautions and calls read', () => {
    expect(source).toMatch(/\nlet BINGO=/)
    expect(source).toMatch(/function bingo_set\(lb\)\{[^\n]*BINGO=[^\n]*fuel_state\.bingo/)
  })
})
