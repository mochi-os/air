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

// The server's 37-byte pose record (world/games/air/air.go, func pose): slot,
// position f32x3, ..., flags at 26, fire bytes at 29/30, leak at 31, the
// radar emitter at 34 (#30) and the gun expenditure at 35 (#163). Only the
// fields this test asserts on are filled; the rest stay zero — except the
// emitter byte, whose "nothing" is 63.
const RECORD = 37
function pose(options: {
  slot: number
  alive?: boolean
  burning?: boolean
  jamming?: boolean
  fire?: [number, number]
  leak?: number
  emitter?: number
  target?: number
  spent?: number
}): Uint8Array {
  const b = new Uint8Array(RECORD)
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
  v.setUint16(35, options.spent ?? 0, true)
  return b
}

function concat(list: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(list.length * RECORD)
  list.forEach((p, i) => out.set(p, i * RECORD))
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

  // Cross-language contract: these bytes were captured from the real server
  // encoder (world/games/air/air.go func pose), the same case Go's
  // TestSelfPoseDamage asserts on. If either side's layout drifts, one of the
  // two tests fails.
  it('decodes the bytes the server actually produces', () => {
    const golden = Uint8Array.from(
      '0000a02d4500e08e450000000000009503f27f0000810000980831000099000f00003ff000'.match(/../g)!.map((h) => parseInt(h, 16))
    )
    expect(golden.length).toBe(RECORD)
    const s = session(0)
    feed(s, golden)
    const mine = s.self()!
    expect(mine.burn[0]).toBeCloseTo(0.6, 2)
    expect(mine.burn[1]).toBe(0)
    expect(mine.burning).toBe(true)
    expect(mine.leak).toBeCloseTo(1.5, 2)
    expect(mine.alive).toBe(true)
    expect(mine.spent).toBe(240) // the uint16 tail, from the same encoder run
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

describe('gun expenditure (#163)', () => {
  // A remote used to record as position and attitude alone, so a debrief of
  // the first human-versus-human match could not say whether the opponent had
  // fired - he emptied all 578 rounds and the file showed nothing. The trigger
  // flag alone cannot answer it: at a 20 Hz snapshot rate a 100 rounds/s belt
  // falls between samples.
  it('reads each aircraft\'s cumulative rounds off the record tail', () => {
    const s = session(0)
    feed(s, concat([pose({ slot: 0, spent: 40 }), pose({ slot: 3, spent: 578 })]))
    expect(s.self()!.spent).toBe(40)
    expect(s.remote(3)!.spent).toBe(578)
  })

  it('steps with the bursts and never runs backwards', () => {
    const s = session(0)
    feed(s, concat([pose({ slot: 3, spent: 120 })]), 60)
    expect(s.remote(3)!.spent).toBe(120)
    feed(s, concat([pose({ slot: 3, spent: 245 })]), 120)
    expect(s.remote(3)!.spent).toBe(245) // the step IS the burst: 125 rounds between snapshots
  })

  it('a jet that has not fired reports zero, not the neighbour\'s belt', () => {
    const s = session(0)
    feed(s, concat([pose({ slot: 3, spent: 578 }), pose({ slot: 5 })]))
    expect(s.remote(5)!.spent).toBe(0)
  })
})
