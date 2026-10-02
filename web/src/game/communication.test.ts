// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { describe, expect, it } from 'vitest'
import * as C from './communication'

// Comm 1 and comm 2, the UFC's comm display, the communication panel and the
// backup frequency control (#20, #81, NATOPS 23.2, 25.4, figure 23-2).
const SHIP = [305000, 262500, 275360]

describe('frequencies', () => {
  it('are taken inside the ARC-182 bands on 25 kHz spacing', () => {
    for (const khz of [30000, 87975, 108000, 155975, 156000, 173975, 225000, 399975, 251025]) expect(C.valid(khz)).toBe(true)
    for (const khz of [29975, 88000, 107975, 174000, 224975, 400000, 251010, 251000.5]) expect(C.valid(khz)).toBe(false)
  })
  it('are worked in the band\'s modulation, the operator choosing only in UHF', () => {
    expect(C.modulation(40500, 'am')).toBe('fm')
    expect(C.modulation(121500, 'fm')).toBe('am')
    expect(C.modulation(156800, 'am')).toBe('fm')
    expect(C.modulation(243000, 'fm')).toBe('fm')
    expect(C.modulation(243000, 'am')).toBe('am')
    expect(C.modulation(200000, 'am')).toBeNull()
    expect([C.selectable(243000), C.selectable(121500)]).toEqual([true, false])
  })
  it('read as megahertz to the kilohertz', () => {
    expect(C.megahertz(251000)).toBe('251.000')
    expect(C.megahertz(40525)).toBe('40.525')
  })
})

describe('a radio', () => {
  it('starts on, on preset 1, with the load\'s presets and the rest unset', () => {
    const r = C.fresh(SHIP)
    expect([r.on, r.channel, r.presets.length]).toEqual([true, 1, 20])
    expect(r.presets.slice(0, 4)).toEqual([305000, 262500, 225000, 225000])   // 275.360 is off the spacing and is not taken
    expect(C.tuned(r)).toBe(305000)
  })
  it('turns its channel selector through the presets, guard and manual, and round again', () => {
    const r = C.fresh(SHIP)
    C.rotate(r, -1); expect(r.channel).toBe('M')
    C.rotate(r, -1); expect(r.channel).toBe('G')
    C.rotate(r, -1); expect(r.channel).toBe(20)
    C.rotate(r, 1); C.rotate(r, 1); C.rotate(r, 1); expect(r.channel).toBe(1)
    C.rotate(r, 1); expect(C.tuned(r)).toBe(262500)
  })
  it('works the guard and manual frequencies at G and M', () => {
    const r = C.fresh(SHIP)
    r.channel = 'G'; expect(C.tuned(r)).toBe(243000)
    r.channel = 'M'; r.manual = 127500; expect(C.tuned(r)).toBe(127500)
  })
  it('goes to the guard frequency of its band with G XMT set to it', () => {
    const r = C.fresh(SHIP)
    expect(C.tuned(r, true)).toBe(243000)
    r.channel = 'M'; r.manual = 127500
    expect(C.tuned(r, true)).toBe(121500)
  })
  it('is off with its volume fully down, and on again off the bottom', () => {
    const r = C.fresh(SHIP)
    for (let k = 0; k < 5; k++) C.turn(r, -1)
    expect([r.volume, r.on]).toEqual([0, false])
    C.turn(r, 1)
    expect([r.volume, r.on]).toEqual([0.2, true])
    for (let k = 0; k < 9; k++) C.turn(r, 1)
    expect(r.volume).toBe(1)
  })
  it('stores a keyed frequency in the channel selected', () => {
    const r = C.fresh(SHIP)
    expect(C.enter(r, '251000')).toBe(true)
    expect(r.presets[0]).toBe(251000)
    r.channel = 'M'; expect(C.enter(r, '127500')).toBe(true); expect(r.manual).toBe(127500)
    r.channel = 'G'; expect(C.enter(r, '121500')).toBe(true); expect(r.guard).toBe(121500)
  })
  it('refuses an entry that is not six digits of a frequency it tunes', () => {
    const r = C.fresh(SHIP)
    for (const entry of ['2510', '2510000', '200000', '251010', '', '30500', '0305000']) expect(C.enter(r, entry), entry).toBe(false) // 30.500 is keyed 030500
    expect(C.keyed('030500')).toBe(30500)
    expect(r.presets[0]).toBe(305000)
  })
  it('takes the mission load\'s presets again from the COMM file', () => {
    const r = C.fresh()
    C.load(r, SHIP)
    expect(r.presets.slice(0, 3)).toEqual([305000, 262500, 225000])
  })
})

describe('the UFC comm display', () => {
  it('shows the preset number, or M- or G-, and the frequency', () => {
    const r = C.fresh(SHIP)
    expect(C.scratch(r)).toBe(' 1 305.000')
    r.channel = 16; expect(C.scratch(r)).toBe('16 225.000')
    r.channel = 'M'; expect(C.scratch(r)).toBe('M- 225.000')
    r.channel = 'G'; expect(C.scratch(r)).toBe('G- 243.000')
  })
  it('lists GRCV, SQCH, CPHR and the modulation, colons on what is on', () => {
    const r = C.fresh(SHIP)
    expect(C.options(r)).toEqual([':GRCV', ':SQCH', ' CPHR', ':AM', ''])
    C.option(r, 0); C.option(r, 1); C.option(r, 2); C.option(r, 3)
    expect(C.options(r)).toEqual([' GRCV', ' SQCH', ':CPHR', ':FM', ''])
  })
  it('blanks the modulation window where the band leaves no choice, and takes no press there', () => {
    const r = C.fresh(SHIP)
    r.channel = 'M'; r.manual = 127500
    expect(C.options(r)[3]).toBe('')
    C.option(r, 3)
    expect(r.choice).toBe('am')
  })
  it('shows the channel in its window, blank with the radio off', () => {
    const r = C.fresh(SHIP)
    r.channel = 7; expect(C.window(r)).toBe('7')
    r.channel = 'G'; expect(C.window(r)).toBe('G')
    r.on = false; expect(C.window(r)).toBe('')
  })
})

describe('the communication panel', () => {
  it('starts with its switches centred, ILS on the UFC and the volumes up', () => {
    expect(C.panel(11)).toEqual({ relay: 'off', guard: 'off', landing: 'ufc', channel: 11, antenna: 'auto', volume: { tacan: 1, receiver: 1, weapon: 1 } })
  })
  it('steps a three-position switch along its throw, stopping at the ends', () => {
    const positions = ['upper', 'auto', 'lower'] as const
    expect(C.step(positions, 'auto', 1)).toBe('lower')
    expect(C.step(positions, 'lower', 1)).toBe('lower')
    expect(C.step(positions, 'auto', -1)).toBe('upper')
    expect(C.step(positions, 'upper', -1)).toBe('upper')
  })
  it('gives the ILS the UFC\'s channel, or its own selector\'s at MAN', () => {
    const p = C.panel(11)
    p.channel = 4
    expect(C.landing(p, 11)).toBe(11)
    p.landing = 'manual'
    expect(C.landing(p, 11)).toBe(4)
  })
})

describe('the backup frequency control', () => {
  const pair = () => ({ one: C.fresh(SHIP), two: C.fresh([262500]) })
  const type = (b: C.Backup, radios: { one: C.Radio; two: C.Radio }, digits: string) => [...digits].map((d) => C.key(b, radios, d as C.Key))
  it('holds each radio\'s working frequency as the mission computer\'s at power-up', () => {
    const radios = pair()
    expect([radios.one.stored, radios.two.stored]).toEqual([305000, 262500])
  })
  it('takes no digit, ENT or OVRD until COM1 or COM2 is pressed', () => {
    const b = C.backup(), radios = pair()
    expect([C.key(b, radios, '2'), C.key(b, radios, 'enter'), C.key(b, radios, 'override')]).toEqual([false, false, false])
    expect([b.entry, radios.one.override]).toEqual(['', false])
  })
  it('stores a six-digit entry as the radio\'s backup frequency on ENT', () => {
    const b = C.backup(), radios = pair()
    C.key(b, radios, 'two'); type(b, radios, '251000')
    expect(b.entry).toBe('251000')
    expect(C.key(b, radios, 'enter')).toBe(true)
    expect([radios.two.stored, radios.one.stored, b.entry]).toEqual([251000, 305000, ''])
  })
  it('takes no seventh digit and refuses an entry that is not a frequency', () => {
    const b = C.backup(), radios = pair()
    C.key(b, radios, 'one')
    expect(type(b, radios, '2510001').pop()).toBe(false)
    C.key(b, radios, 'clear'); type(b, radios, '2000')
    expect(C.key(b, radios, 'enter')).toBe(false)
    expect([radios.one.stored, b.entry]).toEqual([305000, '2000'])
  })
  it('clears the scratchpad on CLR and on choosing a radio', () => {
    const b = C.backup(), radios = pair()
    C.key(b, radios, 'one'); type(b, radios, '25')
    C.key(b, radios, 'clear'); expect(b.entry).toBe('')
    type(b, radios, '25'); C.key(b, radios, 'two')
    expect([b.radio, b.entry]).toEqual(['two', ''])
  })
  it('puts the radio on the stored frequency with OVRD, and back on the UFC\'s without', () => {
    const b = C.backup(), radios = pair()
    C.key(b, radios, 'one'); type(b, radios, '251000'); C.key(b, radios, 'enter')
    expect(C.tuned(radios.one)).toBe(305000)
    C.key(b, radios, 'override')
    expect([radios.one.override, C.tuned(radios.one), C.tuned(radios.two)]).toEqual([true, 251000, 262500])
    C.key(b, radios, 'override')
    expect(C.tuned(radios.one)).toBe(305000)
  })
})
