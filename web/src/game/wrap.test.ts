// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.


import { describe, it, expect } from 'vitest'
import { sanitizeWrap, minimumImage, fold, MIN_WRAP } from './wrap'

describe('sanitizeWrap', () => {
  const fallback = 50000
  it('accepts 0 (wrapping off) and any finite value >= MIN_WRAP', () => {
    expect(sanitizeWrap(0, fallback)).toBe(0)
    expect(sanitizeWrap(MIN_WRAP, fallback)).toBe(MIN_WRAP)
    expect(sanitizeWrap(123456, fallback)).toBe(123456)
  })
  it('rejects a hostile tiny wrap, sub-minimum, and negative values', () => {
    expect(sanitizeWrap(1e-12, fallback)).toBe(fallback)
    expect(sanitizeWrap(MIN_WRAP - 1, fallback)).toBe(fallback)
    expect(sanitizeWrap(-5, fallback)).toBe(fallback)
  })
  it('rejects non-finite and non-numeric values', () => {
    expect(sanitizeWrap(NaN, fallback)).toBe(fallback)
    expect(sanitizeWrap(Infinity, fallback)).toBe(fallback)
    expect(sanitizeWrap(-Infinity, fallback)).toBe(fallback)
    expect(sanitizeWrap('nonsense', fallback)).toBe(fallback)
    expect(sanitizeWrap(undefined, fallback)).toBe(fallback)
  })
})

describe('minimumImage', () => {
  it('returns the shortest signed difference on the torus', () => {
    expect(minimumImage(1000, 0, 100)).toBe(100)
    expect(minimumImage(1000, 0, 900)).toBe(-100) // 900 forward == 100 back
    expect(minimumImage(1000, 950, 50)).toBe(100) // wraps across the seam
  })
  it('returns the raw difference when wrapping is off (wrap <= 0)', () => {
    expect(minimumImage(0, 0, 8000)).toBe(8000)
    expect(minimumImage(-1, 10, 40)).toBe(30)
  })
  it('is constant time — a hostile tiny wrap resolves instantly and finitely', () => {
    const started = performance.now()
    const d = minimumImage(1e-12, 0, 5000) // the old while-loop ran ~5e15 iterations
    expect(Number.isFinite(d)).toBe(true)
    expect(performance.now() - started).toBeLessThan(50)
  })
})

describe('fold', () => {
  it('brings a coordinate into the world span centred on zero', () => {
    expect(fold(1000, 400)).toBe(400)
    expect(fold(1000, 1600)).toBe(-400) // 1600 folds to -400, not 600
    expect(fold(1000, -1600)).toBe(400)
  })
  it('passes the value through when wrapping is off', () => {
    expect(fold(0, 12345)).toBe(12345)
  })
})
