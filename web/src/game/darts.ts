// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// Missile "dart" parser for the poses datagram. The 25-byte records arrive from
// an UNTRUSTED server as an opaque byte string, so float fields are validated
// here (the CBOR finite guard never sees floats packed inside a byte string)
// and the record count is capped.

export type Dart = {
  position: [number, number, number]
  velocity: [number, number, number]
  shooter: number
  radar: boolean // the round's kind (#27): an AIM-120 rather than a heater
}

// DART_MOST caps the rendered darts: the server sends the nearest six, so a
// hostile server that packs more must not grow the render/dead-reckoning work.
export const DART_MOST = 6

// DART_STRIDE is the wire size of one dart: position f32x3, velocity f32x3,
// shooter u8 (its high bit the round's kind) — all little-endian, matching
// the server's snapshot assembly.
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
    // The shooter byte carries the round's KIND in its high bit (#27):
    // slots stop at 62, so the bit is free and the record stays 25 bytes.
    const who = view.getUint8(base + 24)
    list.push({ position, velocity, shooter: who & 0x7f, radar: (who & 0x80) !== 0 })
  }
  return list
}
