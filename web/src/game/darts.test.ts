// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

/* eslint-disable lingui/no-unlocalized-strings -- vitest describe/it names are not user-facing */
import { describe, it, expect } from 'vitest'
import { parseDarts, DART_STRIDE, DART_MOST } from './darts'

// dart packs one 25-byte record: position f32x3, velocity f32x3, shooter u8 (LE).
function dart(
  position: [number, number, number],
  velocity: [number, number, number],
  shooter: number
): Uint8Array {
  const b = new Uint8Array(DART_STRIDE)
  const v = new DataView(b.buffer)
  position.forEach((n, i) => v.setFloat32(i * 4, n, true))
  velocity.forEach((n, i) => v.setFloat32(12 + i * 4, n, true))
  v.setUint8(24, shooter)
  return b
}

function concat(list: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(list.length * DART_STRIDE)
  list.forEach((d, i) => out.set(d, i * DART_STRIDE))
  return out
}

describe('parseDarts', () => {
  it('decodes well-formed darts', () => {
    const out = parseDarts(concat([dart([1, 2, 3], [4, 5, 6], 7), dart([8, 9, 10], [11, 12, 13], 2)]))
    expect(out).toEqual([
      { position: [1, 2, 3], velocity: [4, 5, 6], shooter: 7 },
      { position: [8, 9, 10], velocity: [11, 12, 13], shooter: 2 },
    ])
  })

  it('drops any dart with a non-finite float (NaN/Inf from an opaque byte string)', () => {
    const out = parseDarts(
      concat([
        dart([1, 2, 3], [4, 5, 6], 1),
        dart([NaN, 0, 0], [0, 0, 0], 2), // bad position
        dart([0, 0, 0], [Infinity, 0, 0], 3), // bad velocity
        dart([9, 9, 9], [1, 1, 1], 4),
      ])
    )
    expect(out.map((d) => d.shooter)).toEqual([1, 4])
  })

  it('caps the result at DART_MOST even if the server packs more', () => {
    const many = concat(Array.from({ length: DART_MOST + 5 }, (_, i) => dart([i, 0, 0], [0, 0, 0], i)))
    const out = parseDarts(many)
    expect(out.length).toBe(DART_MOST)
  })

  it('yields nothing on a stride mismatch (byte length not a whole number of records)', () => {
    expect(parseDarts(new Uint8Array(DART_STRIDE + 3))).toEqual([])
    expect(parseDarts(new Uint8Array(7))).toEqual([])
  })

  it('yields nothing for an empty missile block', () => {
    expect(parseDarts(new Uint8Array(0))).toEqual([])
  })
})
