// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { describe, expect, it } from 'vitest'
import * as I from './identification'

// The combined interrogator transponder (#98, NATOPS 23.6, figure 23-8).
const up = () => I.fresh({ one: '33', two: '5532', three: '4500' })
const clear: I.Sense = { power: true, emission: false, above: false }

describe('the UFC IFF displays', () => {
  it('come up on the transponder with mode 3\'s code, every mode enabled', () => {
    const id = up()
    expect(I.scratch(id, '')).toBe('XP 3-4500')
    expect(I.options(id)).toEqual([':1-33', ':2', ':3 C', ':4A', ''])
  })
  it('change between the transponder and the interrogator on the IFF key', () => {
    const id = up()
    I.press(id, false); expect(id.shown).toBe('transponder')
    I.press(id, true); expect(I.scratch(id, '').slice(0, 2)).toBe('AI')
    I.press(id, true); expect(I.scratch(id, '').slice(0, 2)).toBe('XP')
  })
  it('come back to the transponder, on mode 3, when the key brings the display up again', () => {
    const id = up()
    I.press(id, true)
    I.press(id, false)
    expect(id.shown).toBe('transponder')
    I.option(id, 0)
    I.press(id, false) // up again from another display, the transponder's having been the last shown
    expect([id.shown, id.option]).toEqual(['transponder', 2])
  })
  it('blank XP with the set off', () => {
    const id = up(); id.on = false
    expect(I.scratch(id, '')).toBe('   3-4500')
  })
  it('show the keypad entry in place of the code', () => {
    expect(I.scratch(up(), '12')).toBe('XP   3-12')
  })
  it('enable and disable modes 1 and 2, each putting its code in the scratchpad', () => {
    const id = up()
    I.option(id, 0)
    expect([I.options(id)[0], I.scratch(id, '')]).toEqual([' 1-33', 'XP   1-33'])
    I.option(id, 1)
    expect([I.options(id)[1], I.scratch(id, '')]).toEqual([' 2', 'XP 2-5532'])
    I.option(id, 1)
    expect(I.options(id)[1]).toBe(':2')
  })
  it('step option 3 through 3 alone, both off, and 3 with C', () => {
    const id = up(), seen: string[] = []
    for (let k = 0; k < 3; k++) { I.option(id, 2); seen.push(I.options(id)[2]) }
    expect(seen).toEqual([':3', ' 3 C', ':3 C'])
    expect(id.transponder.modes).toMatchObject({ three: true, altitude: true })
  })
  it('step option 4 through 4B, :4B, 4A and :4A', () => {
    const id = up(), seen: string[] = []
    for (let k = 0; k < 4; k++) { I.option(id, 3); seen.push(I.options(id)[3]) }
    expect(seen).toEqual([' 4B', ':4B', ' 4A', ':4A'])
  })
  it('keep the interrogator\'s modes and codes apart from the transponder\'s', () => {
    const id = up()
    I.press(id, true)
    I.option(id, 0); I.option(id, 2); I.enter(id, '1234')
    expect(I.options(id).slice(0, 3)).toEqual([' 1-33', ':2', ':3'])
    expect([id.interrogator.codes.three, id.transponder.codes.three]).toEqual(['1234', '4500'])
    expect(id.transponder.modes).toMatchObject({ one: true, altitude: true })
  })
  it('take a mode 1 code of two digits, the first to 7 and the second to 3', () => {
    const id = up(); I.option(id, 0); I.option(id, 0)
    expect(I.enter(id, '73')).toBe(true)
    expect(id.transponder.codes.one).toBe('73')
    for (const entry of ['74', '83', '7', '733', '']) expect(I.enter(id, entry)).toBe(false)
    expect(id.transponder.codes.one).toBe('73')
  })
  it('take mode 2 and 3 codes of four digits, each to 7', () => {
    const id = up()
    expect(I.enter(id, '7700')).toBe(true)
    expect(id.transponder.codes.three).toBe('7700')
    for (const entry of ['7800', '770', '77000']) expect(I.enter(id, entry)).toBe(false)
    I.option(id, 1); I.option(id, 1)
    expect(I.enter(id, '0123')).toBe(true)
    expect(id.transponder.codes.two).toBe('0123')
  })
  it('blank the mode 4 window, and take no press there, once the codes are gone', () => {
    const id = up(); id.held = false
    expect(I.options(id)[3]).toBe('')
    I.option(id, 3)
    expect(id.transponder.modes).toMatchObject({ four: true, key: 'A' })
  })
  it('take the mission load\'s codes again into both sets', () => {
    const id = I.fresh()
    I.load(id, { three: '4500' })
    expect([id.transponder.codes.three, id.interrogator.codes.three, id.transponder.codes.one]).toEqual(['4500', '4500', '00'])
  })
})

describe('answering a mode 4 challenge', () => {
  it('needs the set on, power, no EMCON, mode 4 enabled and its codes held', () => {
    expect(I.replying(up(), clear)).toBe(true)
    expect(I.replying({ ...up(), on: false }, clear)).toBe(false)
    expect(I.replying(up(), { ...clear, power: false })).toBe(false)
    expect(I.replying(up(), { ...clear, emission: true })).toBe(false)
    expect(I.replying({ ...up(), held: false }, clear)).toBe(false)
    const off = up(); off.transponder.modes.four = false
    expect(I.replying(off, clear)).toBe(false)
  })
  it('follows the transponder\'s mode 4, not the interrogator\'s', () => {
    const id = up(); id.interrogator.modes.four = false
    expect(I.replying(id, clear)).toBe(true)
  })
  it('needs the selected antenna on the challenger\'s side', () => {
    const below = clear, above = { ...clear, above: true }
    expect([I.replying({ ...up(), antenna: 'lower' }, below), I.replying({ ...up(), antenna: 'lower' }, above)]).toEqual([true, false])
    expect([I.replying({ ...up(), antenna: 'upper' }, below), I.replying({ ...up(), antenna: 'upper' }, above)]).toEqual([false, true])
    expect(I.replying({ ...up(), antenna: 'both' }, above)).toBe(true)
  })
})

describe('the antenna selector', () => {
  it('faces a challenger on its own side, and either side at BOTH', () => {
    expect([I.facing('upper', true), I.facing('upper', false)]).toEqual([true, false])
    expect([I.facing('lower', true), I.facing('lower', false)]).toEqual([false, true])
    expect([I.facing('both', true), I.facing('both', false)]).toEqual([true, true])
  })
  it('does not come into whether the transponder answers at all', () => {
    const id = up(); id.antenna = 'upper'
    expect(I.answering(id, clear)).toBe(true)
    expect(I.answering({ ...id, on: false }, clear)).toBe(false)
    expect(I.answering(id, { power: true, emission: true })).toBe(false)
  })
})

describe('challenging', () => {
  it('needs the set on, power, no EMCON, the interrogator\'s mode 4 and its codes', () => {
    const live = { power: true, emission: false }
    expect(I.challenging(up(), live)).toBe(true)
    expect(I.challenging({ ...up(), on: false }, live)).toBe(false)
    expect(I.challenging(up(), { power: false, emission: false })).toBe(false)
    expect(I.challenging(up(), { power: true, emission: true })).toBe(false)
    expect(I.challenging({ ...up(), held: false }, live)).toBe(false)
    const off = up(); off.interrogator.modes.four = false
    expect(I.challenging(off, live)).toBe(false)
    const other = up(); other.transponder.modes.four = false
    expect(I.challenging(other, live)).toBe(true)
  })
})

describe('the mode 4 codes', () => {
  it('are erased at ZERO', () => {
    const id = up(); id.crypto = 'zero'
    I.step(id, true, true)
    expect(id.held).toBe(false)
  })
  it('go with the power at NORM and stay with it on', () => {
    const id = up()
    I.step(id, true, true); expect(id.held).toBe(true)
    I.step(id, false, true); expect(id.held).toBe(false)
    I.step(id, true, true); expect(id.held).toBe(false)
  })
  it('are kept through a loss of power at HOLD only with the gear handle down', () => {
    const down = up(); down.crypto = 'hold'
    I.step(down, false, false); expect(down.held).toBe(true)
    const raised = up(); raised.crypto = 'hold'
    I.step(raised, false, true); expect(raised.held).toBe(false)
  })
})

describe('the IFF cautions and advisory', () => {
  it('raise nothing while a valid challenge is answered, but M4 OK', () => {
    expect(I.cautions(up(), true, true)).toEqual([])
    expect(I.advisories(up(), true, true)).toEqual(['M4 OK'])
  })
  it('raise nothing with no challenge arriving', () => {
    expect(I.cautions(up(), false, false)).toEqual([])
    expect(I.advisories(up(), false, true)).toEqual([])
  })
  it('raise IFF 4 for a valid challenge left unanswered', () => {
    expect(I.cautions(up(), true, false)).toEqual(['IFF 4'])
    expect(I.advisories(up(), true, false)).toEqual([])
  })
  it('raise IFF 4 and IFFAI with the codes gone', () => {
    expect(I.cautions({ ...up(), held: false }, false, false)).toEqual(['IFF 4', 'IFFAI'])
  })
  it('silence IFF 4 and M4 OK, but not IFFAI, with the MODE 4 switch OFF', () => {
    expect(I.cautions({ ...up(), alert: 'off' }, true, false)).toEqual([])
    expect(I.cautions({ ...up(), alert: 'off', held: false }, false, false)).toEqual(['IFFAI'])
    expect(I.advisories({ ...up(), alert: 'off' }, true, true)).toEqual([])
  })
  it('raise nothing from a set that is off', () => {
    expect(I.cautions({ ...up(), on: false, held: false }, true, false)).toEqual([])
    expect(I.advisories({ ...up(), on: false }, true, true)).toEqual([])
  })
})
