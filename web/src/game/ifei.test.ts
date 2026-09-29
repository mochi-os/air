// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ARM, HOLD, IDLE, LIMIT, STEP, elapsed, face, flow, fresh, noz, oil, press, reset, rpm, settle, zulu, type Button, type Reading, type State, type Tanks } from './ifei'

// The IFEI readout against NATOPS A1-F18AC-NFM-000 2.1.1.7.5, 2.2.10.1 and
// 2.12.8: the display increments, the fuel counters, the QTY sub-levels, the
// BINGO arrows, the two time lines and the time set mode.
const tanks: Tanks = { one: 2012, four: 3050, feed: { left: 1600, right: 1200 }, wing: { left: 400, right: 380 }, external: { 3: 1200, 7: 1200 } }
const reading = (over: Partial<Reading> = {}): Reading => ({
  rpm: [66.4, 99.2],
  egt: [464.4, 812.6],
  flow: [3231, 12345],
  noz: [83, 14],
  oil: [58, 97],
  internal: 8642,
  external: 2400,
  tanks,
  ...over,
})
const noon = new Date(Date.UTC(2026, 8, 16, 19, 4, 9)) // 13:04:09 local six hours behind zulu
const ZONE = 6 // hours zulu runs ahead of local

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

  it('reads each tank on its sub-level in 10 lb steps, blank for a station without one (2.2.10.2)', () => {
    const levels = (over: Partial<Reading> = {}) => {
      let s = fresh()
      const seen: string[][] = []
      for (let i = 0; i < 5; i++) {
        s = press(s, 'qty', 0)
        const f = face(reading(over), s, noon, 0)
        seen.push([f.fuel.upper.value, f.fuel.middle.value])
      }
      return seen
    }
    expect(levels()).toEqual([
      ['1600', '1200'], // FL, FR: feed tanks 2 and 3
      ['2010', '3050'], // TL, TR: transfer tanks 1 and 4
      ['400', '380'], // WL, WR
      ['1200', '1200'], // XL, XR: stations 3 and 7
      ['', ''], // C: no centreline tank
    ])
    expect(levels({ tanks: { ...tanks, external: { 5: 2240 } } }).slice(3)).toEqual([['', ''], ['2240', '']])
    expect(face(reading(), press(fresh(), 'qty', 0), noon, 0).fuel.lower).toEqual({ legend: 'T', value: '11040' })
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
    const s = fresh(3000, ZONE)
    expect(face(reading(), s, noon, 0).clock).toBe('13:04:09')
    const z = press(s, 'zone', 0)
    const f = face(reading(), z, noon, 0)
    expect(f.zulu).toBe(true)
    expect(f.clock).toBe('19:04:09')
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

})

// The time set mode (2.12.8.1): MODE twice within 5 s enters it; the arrows set
// the field, QTY steps from the hours to the minutes, the zulu offset, then the
// year, month and day; MODE or ET returns to the normal mode, as does 30 s
// without a press. The clock is the signal data computer's, and the mission
// computer's ZTOD reads it. A step is a button, or a number moving the clock
// that many seconds on from noon; each press lands at that moment.
function sequence(steps: (Button | number)[], state = fresh(3000, ZONE)): { state: State; at: number; now: Date } {
  let at = 0
  for (const step of steps) {
    if (typeof step === 'number') at = step
    else state = press(state, step, at, 0, new Date(noon.getTime() + at * 1000))
  }
  return { state, at, now: new Date(noon.getTime() + at * 1000) }
}
const shown = (steps: (Button | number)[], state?: State, later = 0) => {
  const r = sequence(steps, state)
  return face(reading(), r.state, new Date(r.now.getTime() + later * 1000), r.at + later)
}
const enter: (Button | number)[] = ['mode', 1, 'mode']

describe('the time set mode', () => {
  it('is entered by MODE twice within 5 s, from any sub-level, and not by presses further apart', () => {
    expect(sequence(['mode']).state.setting).toBe(null)
    expect(sequence(enter).state.setting).toEqual({ field: 'hours', touched: 1 })
    expect(sequence(['mode', ARM + 0.5, 'mode']).state.setting).toBe(null)
    expect(sequence(['mode', ARM + 0.5, 'mode', ARM + 2, 'mode']).state.setting?.field).toBe('hours')
    expect(sequence(['qty', 'qty', ...enter]).state.level).toBe(0)
  })

  it('blanks the engine, fuel and elapsed displays, and flashes the hours with T over a flashing H', () => {
    const f = shown(enter, undefined, 1) // the flash's lit half
    expect(f.engine.map((e) => [e.label, e.left, e.right])).toEqual(['RPM', 'TEMP', 'FF', 'NOZ', 'OIL'].map((l) => [l, '', '']))
    expect(f.fuel).toEqual({ upper: { legend: '', value: 'T' }, middle: { legend: '', value: '' }, lower: { legend: '', value: 'H' } })
    expect(f.clock).toBe('13:04:11')
    expect(f.elapsed).toBe('')
    const dark = shown(enter, undefined, 1.5)
    expect(dark.clock).toBe('  :04:11')
    expect(dark.fuel.lower.value).toBe(' ')
  })

  it('turns the hours within the day, moving the ZTOD with them', () => {
    const r = sequence([...enter, 'up'])
    expect(face(reading(), r.state, r.now, 2).clock).toBe('14:04:10')
    expect(zulu(r.state, r.now)).toBe(20 * 3600 + 4 * 60 + 10)
    const late = [...enter, ...Array(11).fill('up'), 'qty', 'qty', 'qty', 'qty', 'qty'] as Button[]
    expect(shown(late, undefined, 1).clock).toBe('16') // midnight passed on the hours, not the date
    expect(shown([...enter, 'down'], undefined, 1).clock).toBe('12:04:11')
  })

  it('turns the minutes within the hour, zeroing the seconds and freezing the clock under M', () => {
    const minutes = [...enter, 'qty', 'up'] as (Button | number)[]
    const f = shown(minutes)
    expect(f.fuel.upper.value).toBe('T')
    expect(f.fuel.lower.value).toBe('M')
    expect(f.clock).toBe('13:05:00')
    expect(shown(minutes, undefined, 40).clock).toBe('13:05:00') // frozen
    expect(shown([...enter, 'qty', 'down', 'down', 'down', 'down', 'down'], undefined, 2).clock).toBe('13:59:00')
    expect(shown([...enter, 'qty'], undefined, 1.5).clock).toBe('13:  :11') // the minutes flash
  })

  it('sets the zulu offset in hours over DIF, local time kept', () => {
    const delta = [...enter, 'qty', 'qty'] as (Button | number)[]
    expect(shown(delta).fuel).toEqual({ upper: { legend: '', value: '6+' }, middle: { legend: '', value: '' }, lower: { legend: '', value: 'DIF' } })
    const r = sequence([...delta, 'up'])
    expect(face(reading(), r.state, r.now, 1).fuel.upper.value).toBe('7+')
    expect(face(reading(), r.state, r.now, 1).clock).toBe('13:04:10')
    expect(zulu(r.state, r.now)).toBe(20 * 3600 + 4 * 60 + 10)
    expect(shown([...delta, ...Array(8).fill('down')]).fuel.upper.value).toBe('2-')
    expect(shown([...delta, ...Array(30).fill('up')]).fuel.upper.value).toBe('14+')
  })

  it('sets the year, month and day under a flashing D, the clock running again', () => {
    const year = [...enter, 'qty', 'up', 'qty', 'qty'] as (Button | number)[] // the minutes set, which froze the clock
    const f = shown(year, undefined, 1)
    expect(f.clock).toBe('2026')
    expect(f.fuel.upper.value).toBe('D')
    expect(f.fuel.lower.value).toBe('Y')
    expect(f.zulu).toBe(false)
    expect(sequence(year).state.clock.held).toBe(null)
    expect(shown([...year, 'up'], undefined, 1).clock).toBe('2027')
    expect(shown([...year, 'qty'], undefined, 1).clock).toBe('09')
    expect(shown([...year, 'qty'], undefined, 1).fuel.lower.value).toBe('M')
    expect(shown([...year, 'qty'], undefined, 1.5).fuel.upper.value).toBe(' ')
    const december = [...year, 'up', 'qty', ...Array(9).fill('down')] as (Button | number)[] // September back through January to December
    expect(shown(december, undefined, 1).clock).toBe('12')
    expect(shown([...december, 'mode', ...enter, 'qty', 'qty', 'qty'], undefined, 1).clock).toBe('2027') // the year stays put
    expect(shown([...december, 'qty', ...Array(16).fill('up')], undefined, 1).clock).toBe('01') // the 16th on to the 31st and round to the 1st
    const thirtyfirst = sequence([...december, 'qty', ...Array(15).fill('up'), 'mode']).state
    expect(shown([...enter, 'qty', 'qty', 'qty', 'qty', 'down', 'qty'], thirtyfirst, 1).clock).toBe('30') // December 31st back to November: its last day
  })

  it('returns to the normal mode on MODE or ET with the clock running from its setting, and after 30 s idle', () => {
    const set = [...enter, 'qty', 'up'] as (Button | number)[] // 13:05:00, frozen
    const back = sequence([...set, 'mode'])
    expect(back.state.setting).toBe(null)
    expect(face(reading(), back.state, new Date(back.now.getTime() + 10000), 11).clock).toBe('13:05:10')
    const et = sequence([...set, 'et'])
    expect(et.state.setting).toBe(null)
    expect(et.state.started).toBe(null) // the stopwatch untouched
    const idle = sequence(set)
    expect(settle(idle.state, idle.at + IDLE, idle.now).setting).not.toBe(null)
    const lapsed = settle(idle.state, idle.at + IDLE + 1, idle.now)
    expect(lapsed.setting).toBe(null)
    expect(lapsed.clock.held).toBe(null)
    expect(sequence([...enter, 'zone']).state.zulu).toBe(true)
  })

  it('powers up on the host clock, out of any time set', () => {
    const r = sequence([...enter, 'up'])
    const fresh_ = reset(r.state, ZONE)
    expect(fresh_.setting).toBe(null)
    expect(face(reading(), fresh_, noon, 0).clock).toBe('13:04:09')
    expect(zulu(fresh_, noon)).toBe(19 * 3600 + 4 * 60 + 9)
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

  it('reads the tanks from the FUEL page\'s apportionment, and gives the ZTOD the IFEI\'s clock, reset on a fresh jet', () => {
    expect(source).toMatch(/internal, external, tanks:fuel_tanks\(internal,external,fuel_aboard\(\)\) \}; \}/)
    expect(source).toMatch(/zulu:ifei_zulu\(ifei_view\(\),now\),/)
    expect(source).toMatch(/function ifei_view\(\)\{ ifei_state=ifei_settle\(ifei_state,performance\.now\(\)\/1000,new Date\(\)\);/)
    expect(source).toMatch(/const next=ifei_press\(ifei_view\(\),button,performance\.now\(\)\/1000,hold\|\|0,new Date\(\)\);/)
    expect(source).toMatch(/\n\ttimer_reset\(\);[^\n]*\n\tifei_state=ifei_reset\(ifei_state,new Date\(\)\.getTimezoneOffset\(\)\/60\);/)
    expect(source).toMatch(/let ifei_state=ifei_fresh\(fuel_state\.bingo,new Date\(\)\.getTimezoneOffset\(\)\/60\)/)
  })

  it('lets the IFEI setting own the BINGO the cautions and calls read', () => {
    expect(source).toMatch(/\nlet BINGO=/)
    expect(source).toMatch(/function bingo_set\(lb\)\{[^\n]*BINGO=[^\n]*fuel_state\.bingo/)
  })
})

// NATOPS 2.1.1.7.5: the IFEI's FF "displays main engine fuel flow only
// (afterburner fuel flow is not displayed)"; the engine page's FF row is the
// same number. The per-engine flows are the measured total burn split by each
// engine's demand - idle, core and reheat - and the display takes each
// engine's main share only. The two lines are lifted from the gauges block.
describe('the displayed fuel flow', () => {
  const engine = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
  const lines = /\n\t\tflowL:[^\n]*\n\t\tflowR:[^\n]*\n/.exec(engine)?.[0] ?? ''
  const flows = (pph: number, hL: number, gL: number, bL: number, hR: number, gR: number, bR: number) =>
    new Function('pph', 'hL', 'gL', 'bL', 'hR', 'gR', 'bR', `const flow_state={ pph }, THREE={MathUtils:{clamp:(v,lo,hi)=>Math.min(hi,Math.max(lo,v))}};
      return {${lines}};`)(pph, hL, gL, bL, hR, gR, bR) as { flowL: number; flowR: number }

  it('splits the measured burn by demand in dry power', () => {
    expect(lines).not.toBe('')
    const { flowL, flowR } = flows(9000, 1, 1, 0, 1, 0.5, 0)
    expect(flowL + flowR).toBeCloseTo(9000, 6)
    expect(flowL / flowR).toBeCloseTo(1.12 / 0.62, 6)
  })

  it('leaves the afterburner out, each engine showing its main share of the burn', () => {
    const { flowL, flowR } = flows(40000, 1, 1, 1, 1, 1, 0)
    const demand = (0.12 + 1 + 3.4) + (0.12 + 1)
    expect(flowL).toBeCloseTo(40000 * 1.12 / demand, 6) // the reheating engine: its core only
    expect(flowR).toBeCloseTo(40000 * 1.12 / demand, 6)
    expect(flows(40000, 1, 1, 0, 1, 1, 1).flowR).toBeCloseTo(40000 * 1.12 / demand, 6) // and the right engine in reheat
  })

  it('winds a dead engine down to zero', () => {
    expect(flows(5000, 0, 0, 0, 1, 1, 0).flowL).toBe(0)
  })
})
