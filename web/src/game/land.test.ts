// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { EQUATOR, HOME, settle, tangent, theatre } from './earth'
import { landed, outline } from './land'

const file = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)))
const bytes = new Uint8Array(file('../../public/maps/world/land.bin'))
const manifest = JSON.parse(file('../../public/maps/world/world.json').toString())
const D = Math.PI / 180

// a land file by the format's rules
function grid(units: number, rows: number[][]): Uint8Array {
  const out: number[] = [...'LAND'].map((c) => c.charCodeAt(0))
  const head = new DataView(new ArrayBuffer(13))
  head.setUint8(0, 1)
  head.setUint16(1, 512, true)
  head.setUint16(3, 64, true)
  head.setUint32(5, rows.length, true)
  head.setUint32(9, units, true)
  out.push(...new Uint8Array(head.buffer))
  const varint = (v: number) => {
    do {
      const b = v % 128
      v = Math.floor(v / 128)
      out.push(b | (v ? 0x80 : 0))
    } while (v)
  }
  for (const row of rows) {
    varint(row.length)
    let last = 0
    for (const x of row) {
      varint(x - last)
      last = x
    }
  }
  return Uint8Array.from(out)
}

describe('the land outline', () => {
  const land = outline(bytes)
  it('is the file the world server embeds, by the hash both record', () => {
    const sum = createHash('sha256').update(bytes).digest('hex')
    expect(sum).toBe(manifest.land.sha256)
    const server = /const landSum = "([0-9a-f]{64})"/.exec(file('../../../../../world/games/air/land_test.go').toString())?.[1]
    if (server) expect(sum).toBe(server) // the world repository beside this one, when it is there
  })
  it('knows the land from the sea where the flight core and the world server do', () => {
    // the same places flight/land_test.go asks
    const places: [string, number, number, boolean][] = [
      ['Paris', 48.86, 2.35, true],
      ['London', 51.5, -0.12, true],
      ['the mid-Atlantic', 30, -40, false],
      ['the North Sea', 56, 3, false],
      ["Midway, which Natural Earth's 1:50m leaves to the map", 28.21, -177.37, false],
      ['Honolulu', 21.31, -157.86, true],
      ['the South Pole', -89.5, 0, true],
      ['Viti Levu, west of the antimeridian', -17.8, 178.0, true],
      ['Chukotka east of the antimeridian', 66, -175, true],
      ['Chukotka west of the antimeridian', 66, 179, true],
      ['the Caspian, a hole in Eurasia', 42, 51, false],
    ]
    for (const [name, latitude, longitude, isLand] of places) expect(landed(land, latitude * D, longitude * D), name).toBe(isLand)
  })
  it('reads each row by the odd rule, to the earth\'s end', () => {
    const units = Math.ceil((2 * Math.PI * EQUATOR) / 64)
    const synthetic = outline(grid(units, [[], [100, 200, 300, units]]))
    const latitude = Math.PI / 2 - (1.5 * 512) / EQUATOR
    const east = (unit: number) => -Math.PI + ((unit + 0.5) * 64) / EQUATOR
    expect([99, 100, 199, 200, 300].map((u) => landed(synthetic, latitude, east(u)))).toEqual([false, true, true, false, true])
    expect(landed(synthetic, latitude, Math.PI - 1e-12)).toBe(true)
    expect(landed(synthetic, Math.PI / 2 - (0.5 * 512) / EQUATOR, east(150))).toBe(false)
  })
  it('refuses a broken file', () => {
    const good = grid(1000, [[1, 2]])
    for (const broken of [new Uint8Array(0), Uint8Array.from([...good].map((b, i) => (i === 2 ? 77 : b))), Uint8Array.from([...good].map((b, i) => (i === 4 ? 2 : b))), good.subarray(0, good.length - 1), Uint8Array.from([...good, 0])])
      expect(() => outline(broken)).toThrow()
  })
})

// The engine's own reading of it: ground_height, which the crash checks, the
// radar altimeter, the gear and the cameras ask, finds the earth's land
// beyond the map. engine.ts cannot be imported (WebGL at module scope), so the
// functions are lifted as text and run with stand-ins.
describe('the ground under the engine', () => {
  const source = file('./engine.ts').toString()
  const lift = (name: string) => {
    const start = source.indexOf(`function ${name}(`)
    if (start < 0) throw new Error(`${name} not found in engine.ts`)
    const rest = source.slice(start), end = /\n(?=\S)/.exec(rest.slice(1))
    if (!end) return rest
    const cut = end.index + 1
    return rest.startsWith('\n}', cut) ? rest.slice(0, cut + 2) : rest.slice(0, cut)
  }
  const ground = (outline_read: unknown) =>
    new Function('theatre', 'earth_land', 'land_landed', `let _ground_kind=""; const CARRIER={ x:1e12, z:1e12, deckY:20 }, carrier_model=null;
      const homeward=p=>p, theatre_point=p=>p, land_height=()=>-1e9;   // the map's own ground: none out here
      ${lift('ground_height')}
      ${lift('earth_ground')}
      return (x,z)=>{ const h=ground_height(x,z); return [h,_ground_kind]; };`)(theatre, outline_read, landed) as (x: number, z: number) => [number, string]
  const land = outline(bytes)
  it('is soft ground at sea level over the land, and the open sea beyond it', () => {
    try {
      settle(tangent(48.86 * D, 2.35 * D)) // the engine's frame moved under a jet over Paris
      const read = ground(land)
      for (const [x, z] of [[0, 0], [60000, -40000]]) {
        const [height, kind] = read(x, z)
        expect(kind).toBe('ground')
        expect(height).toBeCloseTo(theatre.frame.sea(x, z).point.y, 6) // the sea's level there, the earth curving away
      }
      expect(ground(null)(0, 0)).toEqual([-1e9, '']) // before the outline is read: the sea, as before the land
      settle(tangent(30 * D, -40 * D))
      expect(read(0, 0)).toEqual([-1e9, ''])
    } finally {
      settle(HOME)
    }
  })
})
