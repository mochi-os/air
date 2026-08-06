// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { describe, expect, it } from 'vitest'
import { PRESETS, entries, mask, matches, migrate, missiles_loaded, normalize, options, points, rounds, strip, weight, type Catalog, type Fitment } from './stores'

// A catalog mirroring the core's fa18c table (order matters: tips first).
const FITMENTS: Fitment[] = [
  { name: 'tip1', station: 1, mass: 86, area: 0.05, fuel: 0 },
  { name: 'tip9', station: 9, mass: 86, area: 0.05, fuel: 0 },
  { name: 'rail2', station: 2, mass: 179, area: 0.04, fuel: 0 },
  { name: 'twin2', station: 2, mass: 290, area: 0.06, fuel: 0 },
  { name: '9m2', station: 2, mass: 86, area: 0.05, fuel: 0 },
  { name: '9m2a', station: 2, mass: 86, area: 0.05, fuel: 0 },
  { name: '9m2b', station: 2, mass: 86, area: 0.05, fuel: 0 },
  { name: 'rail8', station: 8, mass: 179, area: 0.04, fuel: 0 },
  { name: 'twin8', station: 8, mass: 290, area: 0.06, fuel: 0 },
  { name: '9m8', station: 8, mass: 86, area: 0.05, fuel: 0 },
  { name: '9m8a', station: 8, mass: 86, area: 0.05, fuel: 0 },
  { name: '9m8b', station: 8, mass: 86, area: 0.05, fuel: 0 },
  { name: 'pylon3', station: 3, mass: 136, area: 0.03, fuel: 0 },
  { name: 'tank3', station: 3, mass: 158, area: 0.07, fuel: 1010 },
  { name: 'pylon7', station: 7, mass: 136, area: 0.03, fuel: 0 },
  { name: 'tank7', station: 7, mass: 158, area: 0.07, fuel: 1010 },
  { name: 'pylon5', station: 5, mass: 120, area: 0.03, fuel: 0 },
  { name: 'tank5', station: 5, mass: 158, area: 0.07, fuel: 1010 },
]
const BOOK: Catalog = {
  stores: FITMENTS,
  default: 0b11,
  internal: 4900,
  empty: 10700,
  index: new Map(FITMENTS.map((f, i) => [f.name, i])),
}

describe('normalize', () => {
  it('produces all nine stations from nothing', () => {
    const lo = normalize({})
    expect(Object.keys(lo)).toHaveLength(9)
    expect(lo['1']).toEqual({ fixture: 'rail', stores: [''] }) // tips: integral rail, empty point
    expect(lo['4']).toEqual({ fixture: '', stores: [] }) // cheeks: nothing until a future version
  })
  it('drops unknown fixtures and stores and resizes points', () => {
    const lo = normalize({ 2: { fixture: 'catapult', stores: ['brick'] }, 8: { fixture: 'twin', stores: ['9m', 'brick', '9m'] } })
    expect(lo['2']).toEqual({ fixture: '', stores: [] })
    expect(lo['8']).toEqual({ fixture: 'twin', stores: ['9m', ''] })
  })
  it('locks the tips to their rail', () => {
    expect(normalize({ 1: { fixture: '', stores: [] } })['1'].fixture).toBe('rail')
  })
})

describe('presets', () => {
  it('fox2 is four rounds, tips plus outboard singles', () => {
    expect(rounds(PRESETS.fox2).map((r) => r.name)).toEqual(['tip9', 'tip1', '9m8', '9m2'])
  })
  it('cap adds the centerline tank to fox2', () => {
    expect(PRESETS.cap['5']).toEqual({ fixture: 'pylon', stores: ['tank'] })
    expect(rounds(PRESETS.cap)).toHaveLength(4)
  })
  it('gun carries nothing', () => {
    expect(rounds(PRESETS.gun)).toHaveLength(0)
    expect(missiles_loaded(PRESETS.gun)).toBe(false)
  })
  it('matches recognises presets and rejects customs', () => {
    expect(matches(PRESETS.cap)).toBe('cap')
    const custom = structuredClone(PRESETS.fox2)
    custom['2'].stores[0] = ''
    expect(matches(custom)).toBe('')
  })
  it('migrate maps the retired boolean', () => {
    expect(matches(migrate(true))).toBe('fox2')
    expect(matches(migrate(false))).toBe('gun')
  })
})

describe('rounds', () => {
  it('follows the SMS priority order: tips alternating, then outboards, twins outer first', () => {
    const lo = normalize({
      1: { fixture: 'rail', stores: ['9m'] },
      2: { fixture: 'twin', stores: ['9m', '9m'] },
      8: { fixture: 'twin', stores: ['9m', '9m'] },
      9: { fixture: 'rail', stores: ['9m'] },
    })
    expect(rounds(lo).map((r) => r.name)).toEqual(['tip9', 'tip1', '9m8a', '9m2a', '9m8b', '9m2b'])
  })
  it('handles asymmetry by exhausting the longer side', () => {
    const lo = normalize({ 2: { fixture: 'twin', stores: ['9m', '9m'] }, 9: { fixture: 'rail', stores: ['9m'] } })
    expect(rounds(lo).map((r) => r.name)).toEqual(['tip9', '9m2a', '9m2b'])
  })
})

describe('strip', () => {
  it('removes missiles and keeps fixtures and tanks', () => {
    const lo = strip(PRESETS.cap)
    expect(missiles_loaded(lo)).toBe(false)
    expect(lo['5']).toEqual({ fixture: 'pylon', stores: ['tank'] })
    expect(lo['2']).toEqual({ fixture: 'rail', stores: [''] }) // the rail stays, empty and draggy
  })
})

describe('mask', () => {
  it('bare tips loadout with rounds aboard is the default mask', () => {
    const tips = normalize({ 1: { fixture: 'rail', stores: ['9m'] }, 9: { fixture: 'rail', stores: ['9m'] } })
    expect(mask(tips, 0, BOOK)).toBe(0b11)
  })
  it('clears bits as rounds fire in order', () => {
    const bit = (name: string) => 1 << BOOK.index.get(name)!
    const full = mask(PRESETS.fox2, 0, BOOK)
    expect(full & bit('tip9')).toBeTruthy()
    const one = mask(PRESETS.fox2, 1, BOOK) // tip9 departs first
    expect(one & bit('tip9')).toBeFalsy()
    expect(one & bit('tip1')).toBeTruthy()
    const spent = mask(PRESETS.fox2, 4, BOOK)
    expect(spent & (bit('tip1') | bit('tip9') | bit('9m2') | bit('9m8'))).toBe(0)
    expect(spent & bit('rail2')).toBeTruthy() // empty rails stay, with their drag
  })
  it('keeps tanks and fixtures regardless of fired count', () => {
    const bits = mask(PRESETS.cap, 4, BOOK)
    expect(bits & (1 << BOOK.index.get('tank5')!)).toBeTruthy()
    expect(bits & (1 << BOOK.index.get('pylon5')!)).toBeTruthy()
  })
})

describe('weight', () => {
  it('sums hardware and tank capacity', () => {
    const w = weight(PRESETS.cap, BOOK)
    // 2 tips + 2 outboard rounds + 2 rails + pylon + tank
    expect(w.hardware).toBe(86 * 4 + 179 * 2 + 120 + 158)
    expect(w.fuel).toBe(1010)
  })
  it('gun fighter weighs nothing', () => {
    expect(weight(PRESETS.gun, BOOK)).toEqual({ hardware: 0, fuel: 0 })
  })
})

describe('entries', () => {
  it('twin points map outer then inner', () => {
    expect(entries(8, { fixture: 'twin', stores: ['9m', '9m'] })).toEqual(['twin8', '9m8a', '9m8b'])
  })
  it('a bare pylon is hardware only', () => {
    expect(entries(3, { fixture: 'pylon', stores: [''] })).toEqual(['pylon3'])
  })
  it('points and options describe the strip', () => {
    expect(points('twin')).toBe(2)
    expect(points('')).toBe(0)
    expect(options(3, 'pylon')).toEqual(['', 'tank'])
    expect(options(1, 'rail')).toEqual(['', '9m'])
  })
})
