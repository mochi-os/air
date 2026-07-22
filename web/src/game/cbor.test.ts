// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.


import { describe, it, expect } from 'vitest'
import { cbor_encode, cbor_decode, CborError } from './cbor'

const bytes = (...n: number[]) => new Uint8Array(n)

describe('cbor_decode round-trip', () => {
  it('preserves legitimate values through encode/decode', () => {
    for (const value of [
      0,
      -1,
      42,
      -1000,
      'kind',
      '',
      true,
      false,
      null,
      [1, 2, 3],
      { kind: 'poses', tick: 12, alive: true },
      { nested: { a: [1, { b: 2 }] } },
      3.5,
      -0.25,
    ]) {
      expect(cbor_decode(cbor_encode(value))).toEqual(value)
    }
  })

  it('decodes float64 fractional values', () => {
    expect(cbor_decode(cbor_encode(1.5))).toBe(1.5)
  })
})

describe('cbor_decode hardening', () => {
  it('rejects a truncated item', () => {
    expect(() => cbor_decode(bytes(0x18))).toThrow(CborError) // uint8 header, no byte
  })

  it('rejects an array whose declared length exceeds the remaining bytes', () => {
    // array (major 4) with 4-byte length 0xffffffff and no elements
    expect(() => cbor_decode(bytes(0x9a, 0xff, 0xff, 0xff, 0xff))).toThrow(CborError)
  })

  it('rejects a map whose declared length exceeds the remaining bytes', () => {
    expect(() => cbor_decode(bytes(0xba, 0xff, 0xff, 0xff, 0xff))).toThrow(CborError)
  })

  it('rejects nesting deeper than the limit', () => {
    // 20 nested single-element arrays (0x81) then a leaf — past MAX_DEPTH (16)
    const deep = new Uint8Array([...Array(20).fill(0x81), 0x00])
    expect(() => cbor_decode(deep)).toThrow(CborError)
  })

  it('rejects indefinite-length encodings', () => {
    expect(() => cbor_decode(bytes(0x9f, 0xff))).toThrow(CborError) // indefinite array
    expect(() => cbor_decode(bytes(0xbf, 0xff))).toThrow(CborError) // indefinite map
    expect(() => cbor_decode(bytes(0x5f, 0xff))).toThrow(CborError) // indefinite bytes
  })

  it('rejects reserved additional-info values (28-30)', () => {
    expect(() => cbor_decode(bytes(0x1c))).toThrow(CborError)
    expect(() => cbor_decode(bytes(0x1d))).toThrow(CborError)
    expect(() => cbor_decode(bytes(0x1e))).toThrow(CborError)
  })

  it('rejects non-finite floats (Infinity and NaN)', () => {
    expect(() => cbor_decode(bytes(0xfb, 0x7f, 0xf0, 0, 0, 0, 0, 0, 0))).toThrow(CborError) // +Inf f64
    expect(() => cbor_decode(bytes(0xfb, 0x7f, 0xf8, 0, 0, 0, 0, 0, 0))).toThrow(CborError) // NaN f64
    expect(() => cbor_decode(bytes(0xf9, 0x7c, 0x00))).toThrow(CborError) // +Inf f16
  })

  it('rejects trailing bytes after a complete item', () => {
    expect(() => cbor_decode(bytes(0x00, 0x00))).toThrow(CborError)
  })

  it('rejects duplicate map keys', () => {
    // map(2) { "a": 0, "a": 1 } — 0x61 0x61 is text(1) "a"
    expect(() => cbor_decode(bytes(0xa2, 0x61, 0x61, 0x00, 0x61, 0x61, 0x01))).toThrow(CborError)
  })

  it('isolates a __proto__ key on the null prototype, leaving Object.prototype intact', () => {
    // map(1) { "__proto__": 0 } — 0x69 is text(9)
    const raw = new Uint8Array([0xa1, 0x69, ...new TextEncoder().encode('__proto__'), 0x00])
    const result = cbor_decode(raw) as Record<string, unknown>
    expect(Object.getPrototypeOf(result)).toBeNull()
    expect(result.__proto__).toBe(0) // an ordinary own property, not the prototype
    expect(Object.getPrototypeOf({})).toBe(Object.prototype) // global prototype untouched
  })
})
