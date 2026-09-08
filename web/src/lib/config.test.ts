// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, TAB_FIELDS, seedStart } from './config'

describe('seedStart', () => {
  it('seeds a recovery fuel state for every pattern case', () => {
    for (const start of ['case1', 'case2', 'case3'] as const) {
      expect(seedStart(DEFAULT_CONFIG, start).fuel).toBe(4500)
    }
  })
  it('seeds full tanks back for the launch starts', () => {
    const light = seedStart(DEFAULT_CONFIG, 'case1')
    for (const start of ['air', 'runway', 'carrier'] as const) {
      expect(seedStart(light, start).fuel).toBe(10800)
    }
  })
  it('seeds the case weather alongside the fuel', () => {
    expect(seedStart(DEFAULT_CONFIG, 'case1')).toMatchObject({ tod: 'day', clouds: 'none' })
    expect(seedStart(DEFAULT_CONFIG, 'case2')).toMatchObject({ tod: 'day', clouds: 'mid_stratus' }) // the cases must NOT share a deck: 500 ft is a Case III ceiling
    expect(seedStart(DEFAULT_CONFIG, 'case3')).toMatchObject({ tod: 'night', clouds: 'low_stratus' })
  })
  it('leaves weather alone for the launch starts', () => {
    const night = { ...DEFAULT_CONFIG, tod: 'night' as const }
    expect(seedStart(night, 'air').tod).toBe('night')
  })
})

// The config's shipped-key invariants (#116). `hints` was read at five sites in
// the engine and shipped as a Settings switch while being absent from both the
// MissionConfig interface and DEFAULT_CONFIG. Nothing caught it: the interface
// carries a catch-all index signature, and engine.ts opens with @ts-nocheck.
describe('DEFAULT_CONFIG', () => {
  it('declares hints, defaulted ON', () => {
    // A COMPILE-TIME assertion, and it needs to be: MissionConfig carries a
    // catch-all index signature, so DEFAULT_CONFIG type-checks whether or not
    // `hints` is declared, and vitest strips types rather than checking them.
    // This binding only compiles if the interface narrows hints to boolean --
    // `tsc -b`, which the build runs, is what enforces it.
    const declared: boolean = DEFAULT_CONFIG.hints
    expect(declared).toBe(true)

    // Every consumer tests `cfg.hints !== false`, so ON is what the undeclared
    // key already meant; the declaration must not quietly change it.
    expect(DEFAULT_CONFIG.hints).toBe(true)
  })

  it('holds no undefined value', () => {
    // An undefined default is not a harmless gap. Reset assigns it,
    // JSON.stringify drops the key, and config/save upserts only what arrives —
    // so the stored row keeps its old value while the UI shows the default.
    const dropped = Object.keys(DEFAULT_CONFIG).filter(
      (key) => (DEFAULT_CONFIG as Record<string, unknown>)[key] === undefined,
    )
    expect(dropped).toEqual([])
    expect(Object.keys(JSON.parse(JSON.stringify(DEFAULT_CONFIG)))).toHaveLength(
      Object.keys(DEFAULT_CONFIG).length,
    )
  })

  it('has a default for every field a Settings tab can reset', () => {
    // This is the gate that would have caught #116 where it was introduced,
    // rather than at the far end of a save round-trip.
    const missing: string[] = []
    for (const [tab, fields] of Object.entries(TAB_FIELDS)) {
      for (const field of fields) {
        if ((DEFAULT_CONFIG as Record<string, unknown>)[field] === undefined) missing.push(`${tab}.${field}`)
      }
    }
    expect(missing).toEqual([])
  })
})
