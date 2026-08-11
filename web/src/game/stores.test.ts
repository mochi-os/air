// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { describe, expect, it } from 'vitest'
import { LIMITS, RELEASE, PRESETS, amraams, asymmetry, entries, jettison, mask, matches, migrate, missiles_loaded, normalize, options, outcome, outcomes, points, rounds, strip, weight, type Catalog, type Fitment } from './stores'

// A catalog mirroring the core's fa18c table (order matters: tips first).
const FITMENTS: Fitment[] = [
  { name: 'tip1', station: 1, mass: 86, area: 0.05, fuel: 0, lateral: -5.94 },
  { name: 'tip9', station: 9, mass: 86, area: 0.05, fuel: 0, lateral: 5.94 },
  { name: 'rail2', station: 2, mass: 179, area: 0.04, fuel: 0, lateral: -3.35 },
  { name: 'twin2', station: 2, mass: 290, area: 0.06, fuel: 0, lateral: -3.35 },
  { name: '9m2', station: 2, mass: 86, area: 0.05, fuel: 0, lateral: -3.35 },
  { name: '9m2a', station: 2, mass: 86, area: 0.05, fuel: 0, lateral: -3.5 },
  { name: '9m2b', station: 2, mass: 86, area: 0.05, fuel: 0, lateral: -3.2 },
  { name: 'rail8', station: 8, mass: 179, area: 0.04, fuel: 0, lateral: 3.35 },
  { name: 'twin8', station: 8, mass: 290, area: 0.06, fuel: 0, lateral: 3.35 },
  { name: '9m8', station: 8, mass: 86, area: 0.05, fuel: 0, lateral: 3.35 },
  { name: '9m8a', station: 8, mass: 86, area: 0.05, fuel: 0, lateral: 3.5 },
  { name: '9m8b', station: 8, mass: 86, area: 0.05, fuel: 0, lateral: 3.2 },
  { name: 'pylon3', station: 3, mass: 136, area: 0.03, fuel: 0, lateral: -2.24 },
  { name: 'tank3', station: 3, mass: 158, area: 0.07, fuel: 1010, lateral: -2.24 },
  { name: 'pylon7', station: 7, mass: 136, area: 0.03, fuel: 0, lateral: 2.24 },
  { name: 'tank7', station: 7, mass: 158, area: 0.07, fuel: 1010, lateral: 2.24 },
  { name: 'pylon5', station: 5, mass: 120, area: 0.03, fuel: 0, lateral: 0 },
  { name: 'tank5', station: 5, mass: 158, area: 0.07, fuel: 1010, lateral: 0 },
  { name: 'rail4', station: 4, mass: 31, area: 0.01, fuel: 0, lateral: -0.55 },
  { name: '120c4', station: 4, mass: 156, area: 0.04, fuel: 0, lateral: -0.55 },
  { name: 'rail6', station: 6, mass: 31, area: 0.01, fuel: 0, lateral: 0.55 },
  { name: '120c6', station: 6, mass: 156, area: 0.04, fuel: 0, lateral: 0.55 },
  { name: '120c2', station: 2, mass: 156, area: 0.05, fuel: 0, lateral: -3.35 },
  { name: '120c8', station: 8, mass: 156, area: 0.05, fuel: 0, lateral: 3.35 },
  { name: '120c3', station: 3, mass: 156, area: 0.05, fuel: 0, lateral: -2.24 },
  { name: '120c7', station: 7, mass: 156, area: 0.05, fuel: 0, lateral: 2.24 },
  { name: 'twin3', station: 3, mass: 290, area: 0.06, fuel: 0, lateral: -2.24 },
  { name: 'twin7', station: 7, mass: 290, area: 0.06, fuel: 0, lateral: 2.24 },
  { name: '120c2a', station: 2, mass: 156, area: 0.05, fuel: 0, lateral: -3.5 },
  { name: '120c2b', station: 2, mass: 156, area: 0.05, fuel: 0, lateral: -3.2 },
  { name: '120c8a', station: 8, mass: 156, area: 0.05, fuel: 0, lateral: 3.5 },
  { name: '120c8b', station: 8, mass: 156, area: 0.05, fuel: 0, lateral: 3.2 },
  { name: '120c3a', station: 3, mass: 156, area: 0.05, fuel: 0, lateral: -2.39 },
  { name: '120c3b', station: 3, mass: 156, area: 0.05, fuel: 0, lateral: -2.09 },
  { name: '120c7a', station: 7, mass: 156, area: 0.05, fuel: 0, lateral: 2.39 },
  { name: '120c7b', station: 7, mass: 156, area: 0.05, fuel: 0, lateral: 2.09 },
  { name: '9m3', station: 3, mass: 86, area: 0.05, fuel: 0, lateral: -2.24 },
  { name: '9m3a', station: 3, mass: 86, area: 0.05, fuel: 0, lateral: -2.39 },
  { name: '9m3b', station: 3, mass: 86, area: 0.05, fuel: 0, lateral: -2.09 },
  { name: '9m7', station: 7, mass: 86, area: 0.05, fuel: 0, lateral: 2.24 },
  { name: '9m7a', station: 7, mass: 86, area: 0.05, fuel: 0, lateral: 2.39 },
  { name: '9m7b', station: 7, mass: 86, area: 0.05, fuel: 0, lateral: 2.09 },
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
  it('fox2 is six rounds: tips plus four wing singles', () => {
    expect(rounds(PRESETS.fox2).map((r) => r.name)).toEqual(['tip9', 'tip1', '9m8', '9m2', '9m7', '9m3'])
  })
  it('fox3 is tip heaters, six AMRAAM singles, and the centreline tank', () => {
    expect(PRESETS.fox3['5']).toEqual({ fixture: 'pylon', stores: ['tank'] })
    expect(rounds(PRESETS.fox3).map((r) => r.name)).toEqual(['tip9', 'tip1'])
    expect(amraams(PRESETS.fox3)).toEqual(['120c4', '120c6', '120c2', '120c8', '120c3', '120c7'])
  })
  it('gun carries nothing', () => {
    expect(rounds(PRESETS.gun)).toHaveLength(0)
    expect(missiles_loaded(PRESETS.gun)).toBe(false)
  })
  it('matches recognises presets and rejects customs', () => {
    expect(matches(PRESETS.fox3)).toBe('fox3')
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
    const lo = strip(PRESETS.fox3)
    expect(missiles_loaded(lo)).toBe(false)
    expect(amraams(lo)).toEqual([])
    expect(lo['5']).toEqual({ fixture: 'pylon', stores: ['tank'] })
    expect(lo['2']).toEqual({ fixture: 'rail', stores: [''] }) // the rail stays, empty and draggy
  })
})

describe('jettison', () => {
  it('stores drop empties the mounts and keeps the fixture', () => {
    const lo = jettison(PRESETS.fox3, 5, 'stores')
    expect(lo['5']).toEqual({ fixture: 'pylon', stores: [''] })
    expect(lo['2']).toEqual(PRESETS.fox3['2']) // untouched stations survive verbatim
  })
  it('rack drop clears the fixture with everything on it', () => {
    const lo = jettison(PRESETS.fox3, 2, 'rack')
    expect(lo['2']).toEqual({ fixture: '', stores: [] })
  })
  it('wingtips never jettison', () => {
    const lo = jettison(PRESETS.fox2, 9, 'rack')
    expect(lo['9']).toEqual(PRESETS.fox2['9'])
  })
  it('out-of-range stations are refused untouched', () => {
    expect(jettison(PRESETS.fox3, 0, 'rack')).toEqual(PRESETS.fox3)
    expect(jettison(PRESETS.fox3, 12, 'stores')).toEqual(PRESETS.fox3)
  })
  it('carriage limits are NATOPS figure 4-4: tanks only, per station, no g term', () => {
    // Air-to-air missiles, rails and pylons are inside the basic-aircraft
    // envelope (4.1.2, figure 4-3 title block) — an entry for them would shed
    // racks in a failure mode the real jet does not have.
    for (const f of FITMENTS) {
      if (f.fuel > 0) {
        expect(LIMITS[f.name]).toBeDefined()
      } else {
        expect(LIMITS[f.name]).toBeUndefined()
        expect(LIMITS[f.name.replace(/[0-9ab]+$/, '')]).toBeUndefined()
      }
    }
    expect(LIMITS.tank3).toEqual({ knots: 635, mach: 1.6 })
    expect(LIMITS.tank7).toEqual({ knots: 635, mach: 1.6 })
    expect(LIMITS.tank5).toEqual({ mach: 1.8 }) // the centreline has NO KCAS figure — the airframe's own envelope is the airspeed side
    for (const limit of Object.values(LIMITS)) expect('g' in limit).toBe(false) // LBA: no store g limit exists
    expect(RELEASE).toEqual({ knots: 575, mach: 0.95, low: 1.0, high: 2.0 }) // the figure's jettison half
  })
})

describe('mask', () => {
  it('bare tips loadout with rounds aboard is the default mask', () => {
    const tips = normalize({ 1: { fixture: 'rail', stores: ['9m'] }, 9: { fixture: 'rail', stores: ['9m'] } })
    expect(mask(tips, 0, BOOK)).toBe(0b11)
  })
  it('clears bits as rounds fire in order', () => {
    // f64 division, not int32 bitwise — the inboard heater bits sit past 31
    const has = (m: number, name: string) => Math.floor(m / 2 ** BOOK.index.get(name)!) % 2 === 1
    const full = mask(PRESETS.fox2, 0, BOOK)
    expect(has(full, 'tip9')).toBe(true)
    const one = mask(PRESETS.fox2, 1, BOOK) // tip9 departs first
    expect(has(one, 'tip9')).toBe(false)
    expect(has(one, 'tip1')).toBe(true)
    const spent = mask(PRESETS.fox2, 6, BOOK)
    for (const name of ['tip1', 'tip9', '9m2', '9m8', '9m3', '9m7']) expect(has(spent, name)).toBe(false)
    expect(has(spent, 'rail2')).toBe(true) // empty rails stay, with their drag
    expect(has(spent, 'pylon3')).toBe(true)
  })
  it('keeps tanks and fixtures regardless of fired count', () => {
    const has = (m: number, name: string) => Math.floor(m / 2 ** BOOK.index.get(name)!) % 2 === 1
    const bits = mask(PRESETS.fox3, 2, BOOK)
    expect(has(bits, 'tank5')).toBe(true)
    expect(has(bits, 'pylon5')).toBe(true)
  })
  it('carries the ten-round fit past bit 31 and sheds fired AMRAAMs in their own order', () => {
    // f64 division, not int32 bitwise — the pair entries sit on bits 32..35
    const has = (m: number, name: string) => Math.floor(m / 2 ** BOOK.index.get(name)!) % 2 === 1
    const lo = normalize({
      2: { fixture: 'twin', stores: ['120c', '120c'] },
      3: { fixture: 'twin', stores: ['120c', '120c'] },
      4: { fixture: 'rail', stores: ['120c'] },
      6: { fixture: 'rail', stores: ['120c'] },
      7: { fixture: 'twin', stores: ['120c', '120c'] },
      8: { fixture: 'twin', stores: ['120c', '120c'] },
    })
    const full = mask(lo, 0, BOOK)
    for (const name of ['120c4', '120c2a', '120c3b', '120c7b']) expect(has(full, name)).toBe(true)
    expect(full).toBeGreaterThan(2 ** 32) // the catalog outgrew uint32 — the chain is 64-bit/f64 throughout
    const two = mask(lo, 0, BOOK, 2) // both cheeks away
    expect(has(two, '120c4')).toBe(false)
    expect(has(two, '120c6')).toBe(false)
    expect(has(two, '120c2a')).toBe(true)
    expect(has(two, 'rail4')).toBe(true) // the empty ejector stays
    const dry = mask(lo, 0, BOOK, 10)
    for (const name of ['120c4', '120c2a', '120c2b', '120c3a', '120c7b']) expect(has(dry, name)).toBe(false)
    expect(has(dry, 'twin2')).toBe(true) // empty twins stay, with their drag
  })
})

describe('weight', () => {
  it('sums hardware and tank capacity', () => {
    const w = weight(PRESETS.fox3, BOOK)
    // 2 tips + wing rails + cheek ejectors + inboard pylons + centreline pylon and tank + 6 AMRAAMs
    expect(w.hardware).toBe(86 * 2 + 179 * 2 + 31 * 2 + 136 * 2 + 120 + 158 + 156 * 6)
    expect(w.fuel).toBe(1010)
  })
  it('gun weighs nothing', () => {
    expect(weight(PRESETS.gun, BOOK)).toEqual({ hardware: 0, fuel: 0 })
  })
})

describe('asymmetry', () => {
  it('is zero for the symmetric presets', () => {
    expect(asymmetry(PRESETS.gun, BOOK)).toBeCloseTo(0)
    expect(asymmetry(PRESETS.fox2, BOOK)).toBeCloseTo(0)
    expect(asymmetry(PRESETS.fox3, BOOK)).toBeCloseTo(0)
  })
  it('one full tank to port is the NATOPS example — over every landing limit', () => {
    // Tank on 3, bare pylon on 7: the pylons cancel and the moment is the
    // full tank alone, (158 + 1010) kg × 2.24 m = -2616 kg·m ≈ 18,900 ft·lb —
    // legal in flight (26,000), illegal for any carrier landing (17,000).
    const lopsided = normalize({ 3: { fixture: 'pylon', stores: ['tank'] }, 7: { fixture: 'pylon', stores: [] } })
    const moment = asymmetry(lopsided, BOOK)
    expect(moment).toBeCloseTo(-(158 + 1010) * 2.24, 5)
    expect(Math.abs(moment) * 7.233).toBeGreaterThan(17000)
    expect(Math.abs(moment) * 7.233).toBeLessThan(26000)
  })
  it('a lone tip missile stays inside the catapult limit', () => {
    const odd = normalize({ 9: { fixture: 'rail', stores: ['9m'] } })
    expect(Math.abs(asymmetry(odd, BOOK)) * 7.233).toBeLessThan(6000)
  })
})

describe('outcomes', () => {
  it('round-trips every entry on every station', () => {
    for (let station = 1; station <= 9; station++) {
      for (const entry of outcomes(station)) {
        expect(outcome(station, entry.slot)).toBe(entry.id)
      }
    }
  })
  it('every outcome is a legal, normalize-stable slot', () => {
    for (let station = 1; station <= 9; station++) {
      for (const entry of outcomes(station)) {
        const lo = normalize({ [String(station)]: entry.slot })
        expect(lo[String(station)]).toEqual(entry.slot)
      }
    }
  })
  it('every normalized slot resolves to some outcome', () => {
    // the setup can only write outcomes, but older configs wrote raw slots —
    // whatever normalize() admits must render as a current value
    const twin = normalize({ 2: { fixture: 'twin', stores: ['9m', ''] } })
    expect(outcome(2, twin['2'])).toBe('twin1')
    expect(outcomes(2).find((o) => o.id === 'twin1')?.hidden).toBe(true)
  })
  it('presets are expressible as outcomes', () => {
    for (const preset of Object.values(PRESETS)) {
      for (let station = 1; station <= 9; station++) {
        expect(outcomes(station).some((o) => outcome(station, preset[String(station)]) === o.id)).toBe(true)
      }
    }
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
    expect(options(5, 'pylon')).toEqual(['', 'tank'])
    expect(options(1, 'rail')).toEqual(['', '9m'])
  })
})

describe('amraam (#27)', () => {
  it('cheeks take only the AIM-120C; wing rails and twin points take either family', () => {
    expect(options(4, 'rail')).toEqual(['', '120c'])
    expect(options(2, 'rail')).toEqual(['', '9m', '120c'])
    expect(options(2, 'twin')).toEqual(['', '9m', '120c'])
    expect(entries(6, { fixture: 'rail', stores: ['120c'] })).toEqual(['rail6', '120c6'])
    expect(entries(2, { fixture: 'rail', stores: ['120c'] })).toEqual(['rail2', '120c2'])
    const lo = normalize({ 4: { fixture: 'rail', stores: ['9m'] }, 2: { fixture: 'twin', stores: ['120c', '120c'] } })
    expect(lo['4'].stores).toEqual(['']) // a heater on the cheek is not a thing
    expect(lo['2'].stores).toEqual(['120c', '120c']) // the twin's LAU-127 points carry the pair
    expect(entries(2, lo['2'])).toEqual(['twin2', '120c2a', '120c2b'])
  })
  it('the inboards carry heaters too: singles on the LAU-115C, pairs on its twin rails', () => {
    expect(options(3, 'twin')).toEqual(['', '9m', '120c'])
    expect(options(7, 'pylon')).toEqual(['', 'tank', '9m', '120c'])
    const lo = normalize({ 3: { fixture: 'twin', stores: ['9m', '120c'] }, 7: { fixture: 'pylon', stores: ['9m'] }, 5: { fixture: 'pylon', stores: ['9m'] } })
    expect(lo['3'].stores).toEqual(['9m', '120c']) // a mixed pair is real carriage, kept
    expect(entries(3, lo['3'])).toEqual(['twin3', '9m3a', '120c3b'])
    expect(entries(7, lo['7'])).toEqual(['pylon7', '9m7'])
    expect(lo['5'].stores).toEqual(['']) // the centreline never carries a missile
    expect(entries(7, { fixture: 'twin', stores: ['120c', '120c'] })).toEqual(['twin7', '120c7a', '120c7b'])
  })
  it('the 9M order steps inboard after the outboard ring, starboard seeding', () => {
    const lo = normalize({
      1: { fixture: 'rail', stores: ['9m'] },
      2: { fixture: 'twin', stores: ['9m', '9m'] },
      3: { fixture: 'twin', stores: ['9m', '9m'] },
      7: { fixture: 'pylon', stores: ['9m'] },
      8: { fixture: 'twin', stores: ['9m', '9m'] },
      9: { fixture: 'rail', stores: ['9m'] },
    })
    expect(rounds(lo).map((r) => r.name)).toEqual(['tip9', 'tip1', '9m8a', '9m2a', '9m8b', '9m2b', '9m7', '9m3a', '9m3b'])
  })
  it('amraams fires cheeks, then outboard rails, then inboard pylons, port first', () => {
    const lo = normalize({
      2: { fixture: 'rail', stores: ['120c'] },
      3: { fixture: 'pylon', stores: ['120c'] },
      4: { fixture: 'rail', stores: ['120c'] },
      6: { fixture: 'rail', stores: ['120c'] },
      7: { fixture: 'pylon', stores: ['120c'] },
      8: { fixture: 'rail', stores: ['120c'] },
    })
    expect(amraams(lo)).toEqual(['120c4', '120c6', '120c2', '120c8', '120c3', '120c7'])
    expect(amraams(PRESETS.fox2)).toEqual([])
  })
  it('the ten-round fit fires balanced: cheeks, outer pairs alternating, inner pairs alternating', () => {
    const lo = normalize({
      2: { fixture: 'twin', stores: ['120c', '120c'] },
      3: { fixture: 'twin', stores: ['120c', '120c'] },
      4: { fixture: 'rail', stores: ['120c'] },
      6: { fixture: 'rail', stores: ['120c'] },
      7: { fixture: 'twin', stores: ['120c', '120c'] },
      8: { fixture: 'twin', stores: ['120c', '120c'] },
    })
    expect(amraams(lo)).toEqual(['120c4', '120c6', '120c2a', '120c8a', '120c2b', '120c8b', '120c3a', '120c7a', '120c3b', '120c7b'])
    expect(missiles_loaded(lo)).toBe(true)
  })
  it('the setup offers the pair outcomes and represents hand-built partials', () => {
    expect(outcomes(2).find((o) => o.id === '120c2' && !o.hidden)).toBeTruthy()
    expect(outcomes(3).find((o) => o.id === '120c2' && !o.hidden)).toBeTruthy()
    expect(outcomes(3).find((o) => o.id === '9m' && !o.hidden)).toBeTruthy()
    expect(outcomes(7).find((o) => o.id === '9m2' && !o.hidden)).toBeTruthy()
    expect(outcome(2, { fixture: 'twin', stores: ['120c', '120c'] })).toBe('120c2')
    expect(outcome(3, { fixture: 'twin', stores: ['120c', ''] })).toBe('120c1')
    expect(outcome(3, { fixture: 'twin', stores: ['9m', ''] })).toBe('twin1')
    expect(outcome(7, { fixture: 'pylon', stores: ['9m'] })).toBe('9m')
    expect(outcome(8, { fixture: 'twin', stores: ['9m', '120c'] })).toBe('mixed')
    expect(outcomes(8).find((o) => o.id === 'mixed')?.hidden).toBe(true)
    expect(outcomes(3).find((o) => o.id === 'mixedb')?.hidden).toBe(true)
  })
  it('the inboard pylons trade fuel for magazine; the centreline never carries one', () => {
    expect(options(3, 'pylon')).toEqual(['', 'tank', '9m', '120c'])
    expect(options(5, 'pylon')).toEqual(['', 'tank'])
    expect(entries(7, { fixture: 'pylon', stores: ['120c'] })).toEqual(['pylon7', '120c7'])
    const lo = normalize({ 5: { fixture: 'pylon', stores: ['120c'] } })
    expect(lo['5'].stores).toEqual([''])
  })
  it('arms the fight and falls to the guns-only clamp like any missile', () => {
    const lo = normalize({ 4: { fixture: 'rail', stores: ['120c'] } })
    expect(missiles_loaded(lo)).toBe(true)
    const clamped = strip(lo)
    expect(missiles_loaded(clamped)).toBe(false)
    expect(clamped['4'].fixture).toBe('rail') // the empty ejector stays, like an empty rail
  })
  it('stays out of the 9M firing order and mask entries carry it', () => {
    const lo = normalize({ 1: { fixture: 'rail', stores: ['9m'] }, 4: { fixture: 'rail', stores: ['120c'] } })
    expect(rounds(lo).map((r) => r.name)).toEqual(['tip1'])
    expect(entries(4, lo['4'])).toContain('120c4')
  })
})
