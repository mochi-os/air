// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { describe, it, expect, vi } from 'vitest'

// net.ts reaches @mochi/web for the lobby REST client, which drags in the
// Lingui macro chain. The pose decode under test never touches it.
vi.mock('@mochi/web', () => ({ createAppClient: () => ({}) }))

const { Net } = await import('./net')
type Net = InstanceType<typeof Net>

// The server's 35-byte pose record (world/games/air/air.go, func pose): slot,
// position f32x3, ..., flags at 26, fire bytes at 29/30, leak at 31, the
// radar emitter at 34 (#30). Only the fields this test asserts on are filled;
// the rest stay zero — except the emitter byte, whose "nothing" is 63.
function pose(options: {
  slot: number
  alive?: boolean
  burning?: boolean
  jamming?: boolean
  fire?: [number, number]
  leak?: number
  emitter?: number
  target?: number
}): Uint8Array {
  const b = new Uint8Array(35)
  const v = new DataView(b.buffer)
  v.setUint8(0, options.slot)
  let flags = 0
  if (options.alive ?? true) flags |= 1
  flags |= 16 // pilot alive
  if (options.burning) flags |= 32
  if (options.jamming) flags |= 64 // #31: the radiating-jammer bit
  v.setUint8(26, flags)
  v.setUint8(29, Math.round((options.fire?.[0] ?? 0) * 255))
  v.setUint8(30, Math.round((options.fire?.[1] ?? 0) * 255))
  v.setUint8(31, Math.round((options.leak ?? 0) * 10))
  v.setUint8(34, ((options.emitter ?? 0) << 6) | (options.target ?? 63))
  return b
}

function concat(list: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(list.length * 35)
  list.forEach((p, i) => out.set(p, i * 35))
  return out
}

// A session with the decode path reachable and no live transport: the
// constructor only stores its arguments.
function session(slot: number) {
  const s = new Net({} as WebTransport, {})
  ;(s as unknown as { slot: number }).slot = slot
  return s
}

function feed(s: Net, blob: Uint8Array, tick = 60) {
  ;(s as unknown as { handle(m: Record<string, unknown>): void }).handle({ kind: 'poses', blob, tick })
}

describe('self pose', () => {
  it('surfaces the ownship damage the cockpit annunciates (#40)', () => {
    const s = session(3)
    feed(s, concat([
      pose({ slot: 3, fire: [0.6, 0], burning: true, leak: 1.5 }), // self first, as the server packs it
      pose({ slot: 7 }),
    ]))
    const mine = s.self()
    expect(mine).not.toBeNull()
    expect(mine!.burn[0]).toBeCloseTo(0.6, 1)
    expect(mine!.burn[1]).toBe(0)
    expect(mine!.burning).toBe(true)
    expect(mine!.leak).toBeCloseTo(1.5, 1)
  })

  it('is null before any pose arrives, and never picks up another slot', () => {
    const s = session(3)
    expect(s.self()).toBeNull()
    feed(s, concat([pose({ slot: 7, fire: [1, 1], burning: true, leak: 2 })]))
    expect(s.self()).toBeNull() // slot 7 is not us: their fire must not light our cockpit
  })

  it('an undamaged own pose annunciates nothing', () => {
    const s = session(0)
    feed(s, concat([pose({ slot: 0 })]))
    const mine = s.self()!
    expect(mine.burn).toEqual([0, 0])
    expect(mine.burning).toBe(false)
    expect(mine.leak).toBe(0)
  })

  it('follows the newest sample as the fire grows', () => {
    const s = session(1)
    feed(s, concat([pose({ slot: 1, fire: [0.2, 0] })]), 60)
    feed(s, concat([pose({ slot: 1, fire: [0.9, 0], burning: true })]), 120)
    const mine = s.self()!
    expect(mine.burn[0]).toBeCloseTo(0.9, 1)
    expect(mine.burning).toBe(true)
  })

  // Cross-language contract: these bytes were captured from the REAL server
  // encoder (world/games/air/air.go func pose) for a jet with the left engine
  // alight at 0.6, a fuel fire, and a 1.5 leak — the same case the Go test
  // TestSelfPoseDamage asserts on. The record grew its 35th byte (the radar
  // emitter, #30): silent/no-lock encodes as 0x3f, appended here exactly as
  // the encoder now emits it (asserted by TestRadarPoseWire). If either
  // side's layout drifts, one of the two tests fails.
  it('decodes the bytes the server actually produces', () => {
    const golden = Uint8Array.from(
      '0000a02d4500e08e450000000000003303f47f0000810000980831000099000f00003f'.match(/../g)!.map((h) => parseInt(h, 16))
    )
    expect(golden.length).toBe(35)
    const s = session(0)
    feed(s, golden)
    const mine = s.self()!
    expect(mine.burn[0]).toBeCloseTo(0.6, 2)
    expect(mine.burn[1]).toBe(0)
    expect(mine.burning).toBe(true)
    expect(mine.leak).toBeCloseTo(1.5, 2)
    expect(mine.alive).toBe(true)
  })

  it('leaves remote decoding alone', () => {
    const s = session(0)
    feed(s, concat([pose({ slot: 0 }), pose({ slot: 5, fire: [0.4, 0.4], burning: true })]))
    expect(s.slots()).toContain(5)
    expect(s.slots()).not.toContain(0) // your own jet is never drawn from the wire
  })
})

describe('emitters (#30)', () => {
  it('reads each slot\'s radar state from byte 34 — the RWR\'s feed', () => {
    const s = session(0)
    feed(s, concat([
      pose({ slot: 0 }),
      pose({ slot: 3, emitter: 2, target: 0 }), // slot 3 has us locked
      pose({ slot: 5, emitter: 1 }), // slot 5 is searching
    ]))
    expect(s.emitters.get(3)).toEqual({ mode: 2, target: 0 })
    expect(s.emitters.get(5)).toEqual({ mode: 1, target: -1 })
    expect(s.emitters.get(0)).toEqual({ mode: 0, target: -1 })
  })
  it('a later record replaces the state — a broken lock goes quiet', () => {
    const s = session(0)
    feed(s, concat([pose({ slot: 3, emitter: 2, target: 0 })]), 60)
    feed(s, concat([pose({ slot: 3, emitter: 1 })]), 120)
    expect(s.emitters.get(3)).toEqual({ mode: 1, target: -1 })
  })
})

describe('jamming (#31)', () => {
  it('reads the radiating-jammer bit from the flags byte', () => {
    const s = session(0)
    feed(s, concat([pose({ slot: 3, jamming: true }), pose({ slot: 5 })]))
    expect(s.remote(3)?.jamming).toBe(true)
    expect(s.remote(5)?.jamming).toBe(false)
  })
})
