// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { describe, expect, it } from 'vitest'
import * as A from './avionics'

// The mission computers, equipment status and built-in test against NATOPS
// A1-F18AC-NFM-000 2.13.1, 2.13.4.2.1, 2.20.3 and 2.20.5.
const both = { one: true, two: true }, first = { one: true, two: false }, second = { one: false, two: true }, neither = { one: false, two: false }
const unit = (key: string) => A.UNITS.find((u) => u.key === key) as A.Unit
const consent = (more: Partial<A.Consent> = {}): A.Consent => ({ grounded: true, consent: false, test: false, ...more })

describe('the mission computers', () => {
  it('run with the MC switch at NORM, each off at its own OFF position, and neither without power', () => {
    expect(A.computers('norm', true)).toEqual(both)
    expect(A.computers('one', true)).toEqual(second)
    expect(A.computers('two', true)).toEqual(first)
    expect(A.computers('norm', false)).toEqual(neither)
    expect(A.SWITCH).toEqual(['one', 'norm', 'two'])
  })
  it('leave only STANDBY with neither running', () => {
    expect([A.standby(both), A.standby(first), A.standby(second), A.standby(neither)]).toEqual([false, false, false, true])
  })
  it('take SA and all of SUPT but HSI with MC1, and STORES with MC2', () => {
    for (const page of ['sms', 'rdr', 'hud', 'sa', 'ew']) expect(A.offered('tac', page, both), page).toBe(true)
    expect(['sms', 'rdr', 'hud', 'sa', 'ew'].filter((p) => A.offered('tac', p, second))).toEqual(['sms', 'rdr', 'hud', 'ew'])
    expect(['hsi', 'adi', 'chklst', 'eng', 'fcs', 'fuel', 'fpas', 'mumi', 'bit'].filter((p) => A.offered('supt', p, second))).toEqual(['hsi'])
    expect(['sms', 'rdr', 'hud', 'sa', 'ew'].filter((p) => A.offered('tac', p, first))).toEqual(['rdr', 'hud', 'sa', 'ew'])
    expect(['hsi', 'adi', 'fcs', 'bit'].every((p) => A.offered('supt', p, first))).toBe(true) // SUPT is unchanged without MC2
  })
  it('show only MC 1, and AUTO PILOT, without MC1; add MC 2 for a dead MC2; and nothing with neither', () => {
    const raised = ['FUEL LO', 'AUTO PILOT', 'L GEN']
    expect(A.cautions(raised, both)).toEqual(raised)
    expect(A.cautions(raised, second)).toEqual(['AUTO PILOT', 'MC 1'])
    expect(A.cautions(['FUEL LO'], second)).toEqual(['MC 1'])
    expect(A.cautions(raised, first)).toEqual([...raised, 'MC 2'])
    expect(A.cautions(raised, neither)).toEqual([])
  })
  it('lose the advisories with MC1', () => {
    expect(A.advised(['ALGN', 'SKID'], both)).toEqual(['ALGN', 'SKID']); expect(A.advised(['ALGN'], first)).toEqual(['ALGN']); expect(A.advised(['ALGN'], second)).toEqual([])
  })
})

describe('equipment status', () => {
  it('reads PBIT GO before an initiated BIT and GO after one, the plain units GO throughout', () => {
    const bit = A.fresh()
    expect(A.status(unit('rdr'), {}, bit)).toBe('PBIT GO'); expect(A.status(unit('mc1'), {}, bit)).toBe('GO'); expect(A.status(unit('rwr'), {}, bit)).toBe('GO')
    bit.results.rdr = 'go'
    expect(A.status(unit('rdr'), {}, bit)).toBe('GO')
  })
  it('reads OFF for the units that say so and NOT RDY for the rest, and NOT RDY for one still coming up', () => {
    const bit = A.fresh()
    for (const key of ['rdr', 'ralt', 'tcn', 'ils']) expect(A.status(unit(key), { [key]: 'off' }, bit), key).toBe('OFF')
    for (const key of ['ins', 'gps', 'lddi', 'mc2']) expect(A.status(unit(key), { [key]: 'off' }, bit), key).toBe('NOT RDY')
    expect(A.status(unit('ins'), { ins: 'wait' }, bit)).toBe('NOT RDY'); expect(A.status(unit('rdr'), { rdr: 'wait' }, bit)).toBe('NOT RDY')
  })
  it('reads IN TEST over a failure, DEGD for one, and RESTRT for a test that could not start', () => {
    const bit = A.fresh()
    expect(A.status(unit('fcsa'), { fcsa: 'degraded' }, bit)).toBe('DEGD')
    bit.tests.fcsa = 10
    expect(A.status(unit('fcsa'), { fcsa: 'degraded' }, bit)).toBe('IN TEST')
    delete bit.tests.fcsa; bit.results.fcsa = 'restart'
    expect(A.status(unit('fcsa'), {}, bit)).toBe('RESTRT'); expect(A.status(unit('fcsa'), { fcsa: 'degraded' }, bit)).toBe('DEGD') // the failure shows first
    expect(A.status(unit('rdr'), { rdr: 'off' }, { ...bit, tests: { rdr: 5 } })).toBe('OFF') // switched off, whatever it was doing
  })
  it('reads GND/CV? for an INS waiting to be told where it is', () => {
    const bit = A.fresh(); bit.asking = true
    expect(A.status(unit('ins'), {}, bit)).toBe('GND/CV?'); expect(A.status(unit('adc'), {}, bit)).toBe('PBIT GO')
  })
  it('gives a group the lowest status any of its units reports', () => {
    const bit = A.fresh()
    expect(A.reading('nav', {}, bit)).toBe('PBIT GO')
    for (const u of A.within('nav')) bit.results[u.key] = 'go'
    expect(A.reading('nav', {}, bit)).toBe('GO')
    bit.tests.tcn = 5
    expect(A.reading('nav', {}, bit)).toBe('IN TEST')
    expect(A.reading('nav', { gps: 'degraded' }, bit)).toBe('DEGD')
    expect(A.reading('nav', { gps: 'degraded', ralt: 'off' }, bit)).toBe('OFF'); expect(A.reading('nav', { gps: 'degraded', ins: 'wait' }, bit)).toBe('NOT RDY')
    expect(A.reading('fcs', {}, A.fresh())).toBe('PBIT GO'); expect(A.reading('comm', {}, A.fresh())).toBe('PBIT GO'); expect(A.reading('comm', { dl: 'off' }, A.fresh())).toBe('NOT RDY')
  })
  it('lists the units with a failure to show, by name, and no others', () => {
    const bit = A.fresh(); bit.tests.tcn = 5; bit.results.fcsb = 'restart'
    expect(A.failures({ rdr: 'degraded', ralt: 'off', ins: 'wait', ale: 'degraded' }, bit)).toEqual([['FCSB', 'RESTRT'], ['RDR', 'DEGD'], ['INS', 'NOT RDY'], ['RALT', 'OFF'], ['ALE-47', 'DEGD']])
    expect(A.failures({}, A.fresh())).toEqual([])
  })
  it('puts each group at its pushbutton, and the game\'s units in their groups', () => {
    expect(A.GROUPS.map((g) => [g.label, g.button])).toEqual([['FCS-MC', 5], ['SENSORS', 4], ['STORES', 3], ['COMM', 2], ['NAV', 1], ['DISPLAYS', 11], ['STATUS MONITOR', 12], ['EW', 13]])
    expect(A.within('fcs').map((u) => u.label)).toEqual(['MC1', 'MC2', 'FCSA', 'FCSB']); expect(A.within('nav').map((u) => u.label)).toEqual(['INS', 'ADC', 'ILS', 'BCN', 'RALT', 'TCN', 'GPS'])
    expect(A.within('displays').map((u) => u.label)).toEqual(['LDDI', 'RDDI', 'MPCD', 'HUD', 'IFEI', 'DMS']); expect(A.within('comm').map((u) => u.label)).toEqual(['D/L'])
  })
})

describe('initiated BIT', () => {
  it('runs a unit for its time, then reads GO', () => {
    const bit = A.fresh()
    A.start(bit, ['tcn'], {}, consent())
    expect(bit.tests.tcn).toBe(30); expect(A.testing(bit, 'tcn')).toBe(true); expect(A.testing(bit, 'ils')).toBe(false)
    A.step(bit, {}, 29, false)
    expect(A.status(unit('tcn'), {}, bit)).toBe('IN TEST')
    A.step(bit, {}, 1, false)
    expect([A.testing(bit, 'tcn'), A.status(unit('tcn'), {}, bit)]).toEqual([false, 'GO'])
  })
  it('keeps to the manual\'s bounds: AUTO done in two and a half minutes, the SMS in 180 s, the INS in 12 minutes', () => {
    const auto = A.UNITS.filter((u) => u.group !== 'fcs' && u.key !== 'ins')
    expect(Math.max(...auto.map((u) => u.seconds))).toBeLessThanOrEqual(150)
    expect(unit('sms').seconds).toBeLessThanOrEqual(180); expect(unit('ins').seconds).toBeLessThanOrEqual(720)
    for (const key of ['lddi', 'rddi', 'mpcd', 'hud', 'ifei']) expect(unit(key).seconds).toBeGreaterThanOrEqual(25)
  })
  it('leaves alone a unit that is off or coming up, and the plain ones', () => {
    const bit = A.fresh()
    A.start(bit, ['rdr', 'gps', 'mc1', 'rwr', 'nothing'], { rdr: 'off', gps: 'wait' }, consent())
    expect(bit.tests).toEqual({}); expect(bit.results).toEqual({})
  })
  it('tests a ground-only unit on the wheels and not in flight', () => {
    const air = A.fresh(), deck = A.fresh()
    A.start(air, ['sms', 'adc', 'tcn'], {}, consent({ grounded: false })); A.start(deck, ['sms', 'adc', 'tcn'], {}, consent())
    expect(Object.keys(air.tests)).toEqual(['tcn']); expect(Object.keys(deck.tests).sort()).toEqual(['adc', 'sms', 'tcn'])
  })
  it('reads RESTRT for the FCS without its consent switch held, and tests it with', () => {
    const without = A.fresh(), held = A.fresh()
    A.start(without, ['fcsa', 'fcsb'], {}, consent()); A.start(held, ['fcsa', 'fcsb'], {}, consent({ consent: true }))
    expect(without.tests).toEqual({}); expect(without.results).toEqual({ fcsa: 'restart', fcsb: 'restart' })
    expect(held.tests).toEqual({ fcsa: 60, fcsb: 60 })
  })
  it('asks the INS GND or CV with its knob at TEST, runs once told, and reads RESTRT with the knob elsewhere', () => {
    const bit = A.fresh()
    A.start(bit, ['ins'], {}, consent())
    expect([bit.asking, bit.results.ins]).toEqual([false, 'restart']); expect(A.place(bit)).toBe(false)
    A.start(bit, ['ins'], {}, consent({ test: true }))
    expect([bit.asking, bit.results.ins, bit.tests.ins]).toEqual([true, undefined, undefined])
    expect(A.place(bit)).toBe(true)
    expect([bit.asking, bit.tests.ins]).toEqual([false, 600])
  })
  it('forgets the last result when a test starts again', () => {
    const bit = A.fresh(); bit.results.tcn = 'go'
    A.start(bit, ['tcn'], {}, consent())
    expect(bit.results.tcn).toBeUndefined()
  })
  it('stops every test in progress, with no result, and the INS\'s question with them', () => {
    const bit = A.fresh()
    A.start(bit, ['tcn', 'ils'], {}, consent()); bit.asking = true
    A.stop(bit)
    expect([bit.tests, bit.asking, A.status(unit('tcn'), {}, bit)]).toEqual([{}, false, 'PBIT GO'])
  })
  it('drops a unit switched off in mid-test, with no result', () => {
    const bit = A.fresh()
    A.start(bit, ['tcn'], {}, consent())
    A.step(bit, { tcn: 'off' }, 1, false)
    expect([bit.tests, bit.results]).toEqual([{}, {}])
  })
})

describe('the BIT advisory', () => {
  it('comes with a new failure and goes when the BIT display is looked at, until another', () => {
    const bit = A.fresh()
    A.step(bit, {}, 1, false)
    expect(bit.advisory).toBe(false)
    A.step(bit, { rdr: 'degraded' }, 1, false)
    expect(bit.advisory).toBe(true)
    A.step(bit, { rdr: 'degraded' }, 1, true)
    expect(bit.advisory).toBe(false)
    A.step(bit, { rdr: 'degraded' }, 1, false)
    expect(bit.advisory).toBe(false) // the same failure, already looked at
    A.step(bit, { rdr: 'degraded', gps: 'degraded' }, 1, false)
    expect(bit.advisory).toBe(true)
  })
  it('is not raised by equipment switched off or coming up, and is by a test that could not start', () => {
    const bit = A.fresh()
    A.step(bit, { rdr: 'off', ins: 'wait', ralt: 'off' }, 1, false)
    expect(bit.advisory).toBe(false)
    A.start(bit, ['fcsa'], {}, consent())
    A.step(bit, {}, 1, false)
    expect(bit.advisory).toBe(true)
  })
  it('comes again for a failure that went and came back', () => {
    const bit = A.fresh()
    A.step(bit, { rdr: 'degraded' }, 1, true); A.step(bit, {}, 1, false); A.step(bit, { rdr: 'degraded' }, 1, false)
    expect(bit.advisory).toBe(true)
  })
})
