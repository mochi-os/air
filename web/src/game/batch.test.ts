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
  wing: 0, centre: 0, steering: 0, gear: false, hook: false, override: false, dump: false, port: false, starboard: false, fire: false, flare: false, chaff: false, missile: false, radar: false, jammer: false,
  solo: false, extinguish: false, status: { reply: true, challenge: true, link: true, antenna: 'both', tracks: [] }, steps: 1, ...over,
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
  it('carries the status packed, on the newest sample alone', () => {
    const tracking = { reply: true, challenge: false, link: true, antenna: 'upper' as const, tracks: [4, 9] }
    const batch = filled([sample(), sample(), sample({ status: tracking })])
    expect(batch.map((s) => s.status)).toEqual([undefined, undefined, [13, 4, 9]])
    expect('status' in batch[0]).toBe(false) // gone, not sent as an empty field
  })
  it('stays inside a datagram with sixteen tracks and every flag set', () => {
    const tracks = Array.from({ length: 16 }, (_, k) => 40 + k)
    const worst = sample({ solo: true, extinguish: true, status: { reply: true, challenge: true, link: true, antenna: 'lower', tracks } })
    const size = cbor_encode({ kind: 'input', inputs: filled([worst, worst, worst]) }).length
    expect(BUDGET).toBe(1100)
    expect(size).toBeLessThanOrEqual(BUDGET)
    expect(size - cbor_encode({ kind: 'input', inputs: filled([sample(), sample(), sample()]) }).length).toBeLessThan(100) // what the worst status and both flags cost over a quiet one
  })
  it('is what the session sends', () => {
    const net = readFileSync(fileURLToPath(new URL('./net.ts', import.meta.url)), 'utf8')
    expect(net).toMatch(/\n {4}queue\(this\.batch, sample, this\.sequence\)\n {4}try \{\n {6}this\.datagrams\?\.write\(cbor_encode\(\{ kind: 'input', inputs: this\.batch \}\)\)/)
  })
})
