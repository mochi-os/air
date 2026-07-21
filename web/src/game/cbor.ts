// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// Minimal CBOR (RFC 8949) subset matching the server's fxamacker encoding:
// unsigned/negative integers, byte/text strings, arrays, string-keyed maps,
// booleans, null, and float16/32/64. No dependency, no indefinite lengths.
//
// The decoder reads UNTRUSTED bytes from an open World server, so it is bounded
// on every axis: each read is checked against the input length, declared
// array/map sizes are capped (and can never exceed the bytes that remain),
// nesting depth is limited, indefinite/reserved encodings are rejected,
// non-finite floats are refused, maps are built on a null prototype so a
// __proto__ key cannot reach the prototype chain, and the whole input must be
// consumed. Isolated here so it is unit testable without app dependencies.

export class CborError extends Error {}

const MAX_DEPTH = 16 // the protocol nests shallowly: message map -> array of small pose/player maps
const MAX_ELEMENTS = 65536 // array/map element ceiling (also bounded below by remaining bytes)

const text_encoder = new TextEncoder()
const text_decoder = new TextDecoder('utf-8', { fatal: false })

export function cbor_encode(value: unknown): Uint8Array {
  const parts: number[] = []
  const head = (major: number, length: number) => {
    if (length < 24) parts.push((major << 5) | length)
    else if (length < 0x100) parts.push((major << 5) | 24, length)
    else if (length < 0x10000) parts.push((major << 5) | 25, length >> 8, length & 0xff)
    else parts.push((major << 5) | 26, (length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff)
  }
  const put = (v: unknown) => {
    if (v === null || v === undefined) { parts.push(0xf6); return }
    if (typeof v === 'boolean') { parts.push(v ? 0xf5 : 0xf4); return }
    if (typeof v === 'number') {
      if (Number.isSafeInteger(v) && Math.abs(v) < 0x100000000) {
        if (v >= 0) head(0, v)
        else head(1, -v - 1)
      } else {
        parts.push(0xfb)
        const b = new DataView(new ArrayBuffer(8))
        b.setFloat64(0, v)
        for (let i = 0; i < 8; i++) parts.push(b.getUint8(i))
      }
      return
    }
    if (typeof v === 'string') { const bytes = text_encoder.encode(v); head(3, bytes.length); for (const x of bytes) parts.push(x); return }
    if (Array.isArray(v)) { head(4, v.length); for (const item of v) put(item); return }
    if (typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined)
      head(5, entries.length)
      for (const [k, x] of entries) { put(k); put(x) }
      return
    }
    parts.push(0xf6)
  }
  put(value)
  return new Uint8Array(parts)
}

export function cbor_decode(bytes: Uint8Array): unknown {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 0

  // need asserts n more bytes are available before any DataView/slice read.
  const need = (n: number) => {
    if (n < 0 || at + n > bytes.byteLength) throw new CborError('truncated')
  }
  const remaining = () => bytes.byteLength - at

  const length = (info: number): number => {
    if (info < 24) return info
    if (info === 24) { need(1); return view.getUint8(at++) }
    if (info === 25) { need(2); const v = view.getUint16(at); at += 2; return v }
    if (info === 26) { need(4); const v = view.getUint32(at); at += 4; return v }
    if (info === 27) { need(8); const v = Number(view.getBigUint64(at)); at += 8; return v }
    // 28, 29, 30 are reserved; 31 is indefinite-length — neither is supported.
    throw new CborError(`unsupported length ${info}`)
  }

  const half = (): number => {
    need(2)
    const h = view.getUint16(at); at += 2
    const sign = h & 0x8000 ? -1 : 1, exponent = (h >> 10) & 0x1f, fraction = h & 0x3ff
    if (exponent === 0) return sign * fraction * 2 ** -24
    if (exponent === 31) return fraction ? NaN : sign * Infinity
    return sign * (1024 + fraction) * 2 ** (exponent - 25)
  }

  const finite = (n: number): number => {
    if (!Number.isFinite(n)) throw new CborError('non-finite number')
    return n
  }

  const item = (depth: number): unknown => {
    if (depth > MAX_DEPTH) throw new CborError('nesting too deep')
    need(1)
    const first = view.getUint8(at++)
    const major = first >> 5, info = first & 0x1f
    switch (major) {
      case 0: return length(info)
      case 1: return -1 - length(info)
      case 2: { const n = length(info); need(n); const v = bytes.slice(at, at + n); at += n; return v }
      case 3: { const n = length(info); need(n); const v = text_decoder.decode(bytes.subarray(at, at + n)); at += n; return v }
      case 4: {
        const n = length(info)
        if (n > MAX_ELEMENTS || n > remaining()) throw new CborError('array too large') // each element is >= 1 byte
        const list = new Array(n)
        for (let i = 0; i < n; i++) list[i] = item(depth + 1)
        return list
      }
      case 5: {
        const n = length(info)
        if (n > MAX_ELEMENTS || n > remaining()) throw new CborError('map too large') // each pair is >= 2 bytes
        const map: Record<string, unknown> = Object.create(null) // null prototype: a __proto__ key is a normal own key, not the prototype
        for (let i = 0; i < n; i++) {
          const key = String(item(depth + 1))
          if (key in map) throw new CborError('duplicate key')
          map[key] = item(depth + 1)
        }
        return map
      }
      case 7:
        if (info === 20) return false
        if (info === 21) return true
        if (info === 22 || info === 23) return null
        if (info === 25) return finite(half())
        if (info === 26) { need(4); const v = view.getFloat32(at); at += 4; return finite(v) }
        if (info === 27) { need(8); const v = view.getFloat64(at); at += 8; return finite(v) }
        throw new CborError(`unsupported simple ${info}`)
      default:
        throw new CborError(`unsupported major ${major}`)
    }
  }

  const result = item(0)
  if (at !== bytes.byteLength) throw new CborError('trailing bytes') // a well-formed message consumes exactly its bytes
  return result
}
