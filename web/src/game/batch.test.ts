// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BUDGET, DEPTH, queue, type Queued } from './batch'
import { cbor_encode } from './cbor'
import type { InputSample } from './net'

// The input datagram's batch: what each sample costs it, and that the whole
// stays inside what a datagram carries.
const sample = (over: Partial<InputSample> = {}): InputSample => ({
  pitch: -0.123456789, roll: 0.123456789, yaw: 0.0123456789, throttle: 0.87654321, speedbrake: 0.25, reheat: 0.5, brake: false, bypass: false, emergency: false, mechanical: false,
  wing: 0, centre: 0, steering: 0, trim: 0, lean: 0, reset: false, flap: 0, gear: false, hook: false, probe: false, eject: false, override: false, dump: false, port: false, starboard: false, fire: false, flare: false, chaff: false, missile: false, radar: false, jammer: false,
  solo: false, extinguish: false, onspeed: false, reverted: false, held: 0, status: { reply: true, challenge: true, link: true, antenna: 'both', tracks: [] }, steps: 1, ...over,
})
const filled = (samples: InputSample[]) => { const batch: Queued[] = []; samples.forEach((s, k) => queue(batch, s, 100 + k)); return batch }

describe('the input batch', () => {
  it('carries the newest three samples, each with its sequence number', () => {
    const batch = filled([sample({ throttle: 0.1 }), sample({ throttle: 0.2 }), sample({ throttle: 0.3 }), sample({ throttle: 0.4 })])
    expect(DEPTH).toBe(3)
    expect(batch.map((s) => [s.sequence, s.throttle])).toEqual([[101, 0.2], [102, 0.3], [103, 0.4]])
  })
  it('carries every control of a sample', () => {
    const [sent] = filled([sample()])
    for (const key of ['pitch', 'roll', 'yaw', 'throttle', 'speedbrake', 'reheat', 'brake', 'gear', 'hook', 'fire', 'flare', 'chaff', 'missile', 'radar', 'jammer', 'port', 'starboard', 'steps']) expect(sent, key).toHaveProperty(key)
  })
  it('leaves solo and extinguish out unless they are set', () => {
    const [plain] = filled([sample()])
    expect('solo' in plain || 'extinguish' in plain).toBe(false)
    const [set] = filled([sample({ solo: true, extinguish: true })])
    expect([set.solo, set.extinguish]).toEqual([true, true])
    expect(filled([sample({ solo: true })])[0]).not.toHaveProperty('extinguish')
  })
  it('leaves the trim reset, the reversion and the held fuel out unless there is one', () => {
    const [plain] = filled([sample()])
    expect('onspeed' in plain || 'reverted' in plain || 'held' in plain).toBe(false)
    const [set] = filled([sample({ onspeed: true, reverted: true, held: 263 })])
    expect([set.onspeed, set.reverted, set.held]).toEqual([true, true, 263])
    const [one] = filled([sample({ reverted: true })])
    expect(['onspeed' in one, one.reverted, 'held' in one]).toEqual([false, true, false])
    expect(filled([sample({ onspeed: true })])[0]).not.toHaveProperty('reverted')
    expect(filled([sample({ held: 1 })])[0].held).toBe(1)
  })
  it('carries the status packed, on the newest sample alone', () => {
    const tracking = { reply: true, challenge: false, link: true, antenna: 'upper' as const, tracks: [4, 9] }
    const batch = filled([sample(), sample(), sample({ status: tracking })])
    expect(batch.map((s) => s.status)).toEqual([undefined, undefined, [13, 4, 9]])
    expect('status' in batch[0]).toBe(false) // gone, not sent as an empty field
  })
  it('stays inside a datagram with sixteen tracks, every level set and every edge on its sample', () => {
    // The levels - the dispenser at BYPASS, mission computer 1 lost, both wings' fuel held - ride every
    // sample; an edge is one sample's, and the datagram carries that sample once.
    const tracks = Array.from({ length: 16 }, (_, k) => 40 + k)
    const level = sample({ solo: true, reverted: true, held: 526, trim: 1, lean: -1, status: { reply: true, challenge: true, link: true, antenna: 'lower', tracks } })
    const edge = { ...level, extinguish: true, onspeed: true }
    const size = cbor_encode({ kind: 'input', inputs: filled([edge, level, level]) }).length
    expect(BUDGET).toBe(1100)
    expect(size).toBeLessThanOrEqual(BUDGET)
    expect(size).toBeGreaterThan(BUDGET - 60) // which is most of the room: a field added to every sample has to be paid for
    expect(size - cbor_encode({ kind: 'input', inputs: filled([sample(), sample(), sample()]) }).length).toBeLessThan(130) // what the worst costs over a quiet one
  })
  it('measures the sample the engine sends: the same fields, no more and no fewer', () => {
    const engine = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
    const literal = /\n\tconst sample=\{ ([\s\S]*?) \};\n/.exec(engine)?.[1] ?? ''
    const sent = [...literal.replace(/\/\/[^\n]*/g, '').matchAll(/(?:^|[,{]\s*)([a-z]+)(?=[:,]|\s*$)/g)].map((m) => m[1])
    expect(sent.length).toBeGreaterThan(30)
    expect([...sent, 'steps'].sort()).toEqual(Object.keys(sample()).sort())
  })
  it('is what the session sends', () => {
    const net = readFileSync(fileURLToPath(new URL('./net.ts', import.meta.url)), 'utf8')
    expect(net).toMatch(/\n {4}queue\(this\.batch, sample, this\.sequence\)\n {4}try \{\n {6}this\.datagrams\?\.write\(cbor_encode\(\{ kind: 'input', inputs: this\.batch \}\)\)/)
  })
})
