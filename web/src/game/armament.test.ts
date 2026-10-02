// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { describe, expect, it } from 'vitest'
import * as A from './armament'

// The master arm panel, the selective jettison controls and the fire
// extinguisher (#7, NATOPS 2.17.1.2, 2.14.2 to 2.14.4).
const flying: A.Sense = { airborne: true, handle: true, locked: true }
const sense = (over: Partial<A.Sense> = {}): A.Sense => ({ ...flying, ...over })

describe('the MASTER ARM switch', () => {
  it('is at ARM for a start in the air and SAFE on the deck', () => {
    expect(A.fresh(true).arm).toBe(true)
    expect(A.fresh(false).arm).toBe(false)
  })
  it('meets the ARM conditions only at ARM, off the wheels, with the gear handle up', () => {
    const a = A.fresh(true)
    expect(A.armed(a, flying)).toBe(true)
    expect(A.armed(a, sense({ airborne: false }))).toBe(false)
    expect(A.armed(a, sense({ handle: false }))).toBe(false)
    a.arm = false
    expect(A.armed(a, flying)).toBe(false)
  })
})

describe('the SELECT JETT knob', () => {
  it('starts at SAFE and steps a position a click, stopping at its ends', () => {
    const a = A.fresh(true)
    expect(a.select).toBe('safe')
    A.turn(a, 1); expect(a.select).toBe('right')
    A.turn(a, 1); A.turn(a, 1); expect(a.select).toBe('stores')
    A.turn(a, 1); expect(a.select).toBe('stores')
    for (let k = 0; k < 6; k++) A.turn(a, -1)
    expect(a.select).toBe('left')
  })
})

describe('the station jettison select buttons', () => {
  it('light and go out on alternate presses, each for its own station', () => {
    const a = A.fresh(true)
    A.press(a, 5); A.press(a, 2)
    expect(a.stations).toEqual([5, 2])
    A.press(a, 5)
    expect(a.stations).toEqual([2])
  })
  it('take no station that has no button', () => {
    const a = A.fresh(true)
    A.press(a, 4); A.press(a, 1)
    expect(a.stations).toEqual([])
  })
  it('are the centreline, the inboard and the outboard wing stations', () => {
    expect(A.BUTTONS.map((b) => [b.label, b.station])).toEqual([['CTR', 5], ['LI', 3], ['RI', 7], ['LO', 2], ['RO', 8]])
  })
})

describe('the JETT button', () => {
  const selected = (select: A.Select, stations: number[] = []): A.Armament => ({ ...A.fresh(true), select, stations })
  it('releases nothing at SAFE', () => {
    expect(A.release(selected('safe', [5]), flying)).toBeNull()
  })
  it('drops the stores of the stations selected, or their racks with them', () => {
    expect(A.release(selected('stores', [7, 3]), flying)).toEqual({ stations: [3, 7], what: 'stores' })
    expect(A.release(selected('rack', [5]), flying)).toEqual({ stations: [5], what: 'rack' })
  })
  it('releases nothing from the wing with no station selected', () => {
    expect(A.release(selected('stores'), flying)).toBeNull()
    expect(A.release(selected('rack'), flying)).toBeNull()
  })
  it('drops a fuselage missile alone, whatever stations are selected', () => {
    expect(A.release(selected('left', [5]), flying)).toEqual({ stations: [4], what: 'stores' })
    expect(A.release(selected('right'), flying)).toEqual({ stations: [6], what: 'stores' })
  })
  it('needs the ARM conditions and every landing gear up and locked', () => {
    const a = selected('stores', [5])
    expect(A.release({ ...a, arm: false }, flying)).toBeNull()
    expect(A.release(a, sense({ airborne: false }))).toBeNull()
    expect(A.release(a, sense({ handle: false }))).toBeNull()
    expect(A.release(a, sense({ locked: false }))).toBeNull()
  })
})

describe('the fire extinguisher', () => {
  it('shows READY with a fire light pushed in', () => {
    expect(A.ready([false, false])).toBe(false)
    expect(A.ready([false, true])).toBe(true)
  })
  it('discharges with READY on, once', () => {
    const a = A.fresh(true)
    expect(A.discharge(a, [true, false])).toBe(true)
    expect(a.discharged).toBe(true)
    expect(A.discharge(a, [true, false])).toBe(false)
  })
  it('does not discharge without READY', () => {
    const a = A.fresh(true)
    expect(A.discharge(a, [false, false])).toBe(false)
    expect(a.discharged).toBe(false)
  })
})
