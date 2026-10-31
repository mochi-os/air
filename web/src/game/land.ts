// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The earth's land beyond the map (#162): flat ground at sea level wherever
// Natural Earth's 1:50m outline says land, the outline the low quality global
// map is drawn from. land.bin (web/public/maps/world, written by
// tools/world.py) is the one file every host reads: the flight core in the
// browser and on the world server (flight/land.go), and this, which the engine
// asks where the ground is. Rows a fixed arc apart from the north pole, each
// the longitudes where it passes between sea and land; a place is land when an
// odd number of its row's toggles lie at or west of it.

import { EQUATOR } from './earth'

export interface Land {
  row: number // metres of equatorial arc between rows, from 90 N
  unit: number // metres of equatorial arc in a toggle's unit, from 180 W
  units: number // units around the earth
  starts: Uint32Array // each row's first toggle, and one past the last row's
  toggles: Uint32Array
}

// outline reads land.bin: "LAND", then little-endian u8 version 1, u16 metres
// between rows, u16 metres in a unit, u32 rows, u32 units around the earth;
// each row an unsigned LEB128 count and that many LEB128 gaps, the first from 0.
export function outline(bytes: Uint8Array): Land {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 17 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'LAND' || bytes[4] !== 1) throw new Error('land: not a version 1 land file')
  const row = view.getUint16(5, true), unit = view.getUint16(7, true), rows = view.getUint32(9, true), units = view.getUint32(13, true)
  if (!row || !unit || !rows) throw new Error('land: empty grid')
  let at = 17
  const next = () => {
    let value = 0, scale = 1
    for (;;) {
      if (at >= bytes.length) throw new Error('land: truncated')
      const byte = bytes[at++]
      value += (byte & 0x7f) * scale
      if (!(byte & 0x80)) return value
      scale *= 128
    }
  }
  const starts = new Uint32Array(rows + 1)
  const toggles: number[] = []
  for (let r = 0; r < rows; r++) {
    starts[r] = toggles.length
    let last = 0
    for (let count = next(), k = 0; k < count; k++) toggles.push((last += next()))
  }
  starts[rows] = toggles.length
  if (at !== bytes.length) throw new Error('land: trailing bytes')
  return { row, unit, units, starts, toggles: Uint32Array.from(toggles) }
}

// landed reports whether a place, radians, is land.
export function landed(land: Land, latitude: number, longitude: number): boolean {
  const rows = land.starts.length - 1
  const r = Math.min(rows - 1, Math.max(0, Math.floor(((Math.PI / 2 - latitude) * EQUATOR) / land.row)))
  let east = (longitude + Math.PI) % (2 * Math.PI)
  if (east < 0) east += 2 * Math.PI
  const unit = Math.min(land.units - 1, Math.floor((east * EQUATOR) / land.unit))
  let low = land.starts[r], high = land.starts[r + 1]
  const first = low
  while (low < high) {   // the toggles at or west of the place
    const middle = (low + high) >> 1
    if (land.toggles[middle] <= unit) low = middle + 1
    else high = middle
  }
  return (low - first) % 2 === 1
}
