// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { describe, expect, it } from 'vitest'
import { CAUTION_LENGTH, CAUTION_NOTES, caution_shape } from './audio'

// The MASTER CAUTION tone against NATOPS 2.17.2.1: 0.8 s made of a 0.25 s
// sound, a 0.15 s sound of higher pitch, and one repetition of the pair. The
// shape is a pure fill, so it renders here without an AudioContext; pitch is
// read back by counting zero crossings inside each note, clear of its edges.
const RATE = 48000
function rendered(): Float32Array {
  const d = new Float32Array(Math.ceil(RATE * CAUTION_LENGTH))
  caution_shape(d, RATE)
  return d
}
function pitch(d: Float32Array, from: number, to: number): number {
  let crossings = 0
  for (let i = Math.floor(from * RATE) + 1; i < Math.floor(to * RATE); i++) if (d[i - 1] < 0 !== d[i] < 0) crossings++
  return crossings / 2 / (to - from)
}
function level(d: Float32Array, from: number, to: number): number {
  let sum = 0
  const a = Math.floor(from * RATE), b = Math.floor(to * RATE)
  for (let i = a; i < b; i++) sum += d[i] * d[i]
  return Math.sqrt(sum / (b - a))
}

describe('the master caution tone', () => {
  it('is a 0.25 s note, a 0.15 s higher note, and the pair again, 0.8 s in all', () => {
    expect(CAUTION_LENGTH).toBe(0.8)
    expect(CAUTION_NOTES.map(([at, length]) => [at, length])).toEqual([
      [0, 0.25],
      [0.25, 0.15],
      [0.4, 0.25],
      [0.65, 0.15],
    ])
    const d = rendered()
    // Sound runs edge to edge: every note is live from its start to its end.
    expect(level(d, 0.02, 0.23)).toBeGreaterThan(0.1)
    expect(level(d, 0.27, 0.38)).toBeGreaterThan(0.1)
    expect(level(d, 0.42, 0.63)).toBeGreaterThan(0.1)
    expect(level(d, 0.67, 0.78)).toBeGreaterThan(0.1)
  })

  it('steps up in pitch for the second note and repeats the pair exactly', () => {
    const d = rendered()
    const low = pitch(d, 0.02, 0.23), high = pitch(d, 0.27, 0.38)
    expect(low).toBeCloseTo(1000, -1)
    expect(high).toBeGreaterThan(low * 1.3)
    expect(pitch(d, 0.42, 0.63)).toBeCloseTo(low, -1)
    expect(pitch(d, 0.67, 0.78)).toBeCloseTo(high, -1)
    // The repetition is the same sound, sample for sample.
    const shift = Math.floor(0.4 * RATE)
    let worst = 0
    for (let i = 0; i < shift; i++) worst = Math.max(worst, Math.abs(d[i] - d[i + shift]))
    expect(worst).toBeLessThan(1e-6)
  })

  it('holds the loudness the mix audit froze for the beep it replaces', () => {
    // claude/scripts/air/mixcheck.py carries the buffer RMS of every one-shot
    // and gates the alert family's ordering on it; this is the figure it holds
    // for the caution tone, so a reshape that moves it must move both.
    expect(level(rendered(), 0, CAUTION_LENGTH)).toBeCloseTo(0.132, 2)
  })
})
