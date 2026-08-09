// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, seedStart } from './config'

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
