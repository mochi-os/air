// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { describe, it, expect } from 'vitest'
import { phase, words, type Round, MENACE_STRIDE, MENACE_MOST, MENACE_HEATER, MENACE_BEATEN } from './menace'

const bandit = { name: 'bandit' }

function round(over: Partial<Round> = {}): Round {
  return { active: true, target: bandit, kind: '9m', px: 1, py: 2, pz: 3, vx: 4, vy: 5, vz: 6, ...over }
}

describe('phase', () => {
  it('marks a guiding heater live', () => {
    expect(phase(round())).toBe(MENACE_HEATER)
  })

  // The whole point of the sentinel: the brain reads it to decide whether a
  // round is worth abandoning the fight for. Both flags mean beaten — seduced
  // onto a flare (blind), or gimballed off and gone ballistic (loose).
  it('marks a heater seduced onto a flare beaten', () => {
    expect(phase(round({ blind: 1.5 }))).toBe(MENACE_BEATEN)
  })

  it('marks a heater gone ballistic beaten', () => {
    expect(phase(round({ loose: true }))).toBe(MENACE_BEATEN)
  })

  // blind counts down to zero and the round is then flagged loose; a zero must
  // not read as beaten on its own.
  it('does not call a heater beaten on a spent blind timer alone', () => {
    expect(phase(round({ blind: 0 }))).toBe(MENACE_HEATER)
  })

  // A radar round carries its real guidance phase, and its fate rides on that
  // phase rather than on these flags — the sentinels must never displace it.
  it('passes a radar round its guidance phase', () => {
    expect(phase(round({ kind: '120c', phase: 2 }))).toBe(2)
    expect(phase(round({ kind: '120c', phase: 0 }))).toBe(0)
    expect(phase(round({ kind: '120c' }))).toBe(0)
  })

  it('keeps a radar round on its phase even when its flags are set', () => {
    expect(phase(round({ kind: '120c', phase: 3, loose: true, blind: 1.5 }))).toBe(3)
  })
})

describe('words', () => {
  it('declares one eight-word record per round', () => {
    const out = words([round()], bandit)
    expect(out).toEqual([1, 2, 3, 4, 5, 6, 0, MENACE_HEATER])
    expect(out.length).toBe(MENACE_STRIDE)
  })

  it('marks the bandit its own shots', () => {
    expect(words([round({ enemy: true, target: null })], bandit)[6]).toBe(1)
  })

  it('declares nothing that does not concern the bandit', () => {
    expect(words([round({ active: false })], bandit)).toEqual([])
    expect(words([round({ target: { name: 'someone else' } })], bandit)).toEqual([])
  })

  it('caps the declaration rather than growing without bound', () => {
    const many = Array.from({ length: 20 }, () => round())
    expect(words(many, bandit).length).toBe(MENACE_MOST)
  })

  it('carries the beaten sentinel through to the wire', () => {
    const out = words([round(), round({ loose: true })], bandit)
    expect(out[7]).toBe(MENACE_HEATER)
    expect(out[MENACE_STRIDE + 7]).toBe(MENACE_BEATEN)
  })
})
