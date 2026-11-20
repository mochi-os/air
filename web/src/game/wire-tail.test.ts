// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

// The snapshot core's quantised tail: the world server maps each word's range
// onto a uint16 and this client maps it back, each from a table of its own.
// The signed words were clamped to zero on the way out, so a trim, a raised
// flap or toe-out arrived as nothing. The two tables must say the same thing.
vi.mock('@mochi/web', () => ({ createAppClient: () => ({}) }))
const { WIRE_TAIL, wire_expand } = await import('./net')
const { SIZE, STATE } = await import('./flight')

const server = readFileSync(fileURLToPath(new URL('../../../../../world/games/air/air.go', import.meta.url)), 'utf8')

describe('the snapshot core tail', () => {
  it('expands every word over the range the server sends it in', () => {
    const block = /var wire_tail = func\(\) map\[int\]\[2\]float64 \{([\s\S]*?)\n\}\(\)/.exec(server)?.[1] ?? ''
    const tail = STATE.loss // 57 + Elements + Channels
    const flaps = /flaps := \[2\]float64\{([-\d.]+), ([-\d.]+)\}/.exec(block)
    const ranges: Record<number, [number, number]> = {}
    for (const [, offset, least, most, named] of block.matchAll(/tail(?: \+ (\d+))?:\s+(?:\{([-\d.]+), ([-\d.]+)\}|(flaps)),/g)) {
      ranges[tail + Number(offset ?? 0)] = named ? [Number(flaps![1]), Number(flaps![2])] : [Number(least), Number(most)]
    }
    expect(Object.keys(ranges).length).toBeGreaterThan(8)
    expect(ranges).toEqual(WIRE_TAIL)
  })
  it('reads each tail word back over its range', () => {
    const bytes = new Uint8Array(57 * 8 + (SIZE - 57) * 2)
    const view = new DataView(bytes.buffer)
    for (let i = 57; i < SIZE; i++) view.setUint16(57 * 8 + (i - 57) * 2, 0, true) // every word at the low end of its range
    const low = wire_expand(bytes)!
    expect([low[STATE.datum], low[STATE.toe], low[STATE.trailing]]).toEqual([-0.07, -0.27, -0.14])
    view.setUint16(57 * 8 + (STATE.loss - 57) * 2, 65535, true)
    expect(wire_expand(bytes)![STATE.loss]).toBe(8000)
    view.setFloat64(0, NaN, true)
    expect(wire_expand(bytes)).toBeNull() // a non-finite base word would poison the prediction
  })
  it('carries the signed words below zero', () => {
    for (const word of [STATE.datum, STATE.bank, STATE.trailing, STATE.trailing + 1, STATE.toe]) expect(WIRE_TAIL[word][0]).toBeLessThan(0)
  })
})
