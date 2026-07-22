// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// Missile "dart" parser for the poses datagram. The 25-byte records arrive from
// an UNTRUSTED server as an opaque byte string, so the float fields are
// validated HERE: the CBOR finite guard only inspects decoded numbers, not
// floats packed inside a byte string, so NaN/Inf can otherwise reach the
// renderer's dead reckoning. The record count is also capped. Dependency-free
// so it is unit testable in isolation (matching framing.ts / wrap.ts / cbor.ts).

export type Dart = {
  position: [number, number, number]
  velocity: [number, number, number]
  shooter: number
}

// DART_MOST caps the rendered darts: the server sends the nearest six, so a
// hostile server that packs more must not grow the render/dead-reckoning work.
export const DART_MOST = 6

// DART_STRIDE is the wire size of one dart: position f32x3, velocity f32x3,
// shooter u8 — all little-endian, matching the server's snapshot assembly.
export const DART_STRIDE = 25

// parseDarts decodes darts from the missile byte string. A length that is not a
// whole number of records is a build/stride mismatch and yields no darts (show
// nothing rather than garbage); any dart with a non-finite float is dropped;
// at most DART_MOST are returned.
export function parseDarts(missiles: Uint8Array): Dart[] {
  const list: Dart[] = []
  if (missiles.byteLength % DART_STRIDE !== 0) return list
  const view = new DataView(missiles.buffer, missiles.byteOffset, missiles.byteLength)
  for (let base = 0; base + DART_STRIDE <= missiles.byteLength && list.length < DART_MOST; base += DART_STRIDE) {
    const position: [number, number, number] = [
      view.getFloat32(base, true),
      view.getFloat32(base + 4, true),
      view.getFloat32(base + 8, true),
    ]
    const velocity: [number, number, number] = [
      view.getFloat32(base + 12, true),
      view.getFloat32(base + 16, true),
      view.getFloat32(base + 20, true),
    ]
    if (!position.every(Number.isFinite) || !velocity.every(Number.isFinite)) continue
    list.push({ position, velocity, shooter: view.getUint8(base + 24) })
  }
  return list
}
