// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// The remote-aircraft interpolation (#81): the REAL net.ts decode and
// smoothing (Net.handle, Net.remote) fed a synthetic snapshot stream of a
// remote jet in a hard 5 g turn - the case where 20 Hz linear samples between
// snapshots facet the arc - and the frame-to-frame jerk a viewer sees. It was a
// standalone esbuild harness under web/tools whose stub no longer covered
// net.ts's imports and whose 34-byte records net.ts no longer reads.

vi.mock('@mochi/web', () => ({ createAppClient: () => ({}) }))
const { Net, local } = await import('./net')

// A controllable local clock: net.ts reads performance.now() for arrival
// times (Net.handle) and the render target (Net.remote).
let clock = 0 // ms
beforeAll(() => {
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
})
afterAll(() => {
  vi.restoreAllMocks()
})

const SPEED = 200 // m/s
const RATE = 0.24 // rad/s, about 5 g at 200 m/s: the faceting-worst manoeuvre
const RADIUS = SPEED / RATE
const ALTITUDE = 3000
const SECONDS = 6

type V3 = [number, number, number]

function truth(t: number): { position: V3; direction: V3 } {
  const turned = RATE * t
  return {
    position: [RADIUS * Math.sin(turned), ALTITUDE, RADIUS * Math.cos(turned)],
    direction: [Math.cos(turned), 0, -Math.sin(turned)],
  }
}

// The server's 40-byte pose record (world/games/air/air.go, func pose), with
// only what the smoothing reads filled: slot, position, flight path, speed and
// the alive flags.
const RECORD = 40
function record(slot: number, position: V3, direction: V3, speed: number): Uint8Array {
  const bytes = new Uint8Array(RECORD)
  const view = new DataView(bytes.buffer)
  view.setUint8(0, slot)
  view.setFloat32(1, position[0], true)
  view.setFloat32(5, position[1], true)
  view.setFloat32(9, position[2], true)
  view.setInt16(19, 32767, true) // attitude w near 1 (unused by the smoothing)
  view.setInt8(21, Math.round(direction[0] * 127))
  view.setInt8(22, Math.round(direction[1] * 127))
  view.setInt8(23, Math.round(direction[2] * 127))
  view.setUint16(24, Math.round(speed * 10), true)
  view.setUint8(26, 1 | 16) // alive, pilot alive
  return bytes
}

// Deterministic, so a run is reproducible.
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// The magnitude of the frame-to-frame change in acceleration, m/s².
function roughness(track: V3[]): number[] {
  const step: V3[] = []
  for (let i = 1; i < track.length; i++)
    step.push([track[i][0] - track[i - 1][0], track[i][1] - track[i - 1][1], track[i][2] - track[i - 1][2]])
  const out: number[] = []
  for (let i = 1; i < step.length; i++)
    out.push(Math.hypot((step[i][0] - step[i - 1][0]) * 3600, (step[i][1] - step[i - 1][1]) * 3600, (step[i][2] - step[i - 1][2]) * 3600))
  return out
}

function percentile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
}

// fly feeds the stream at the given rate, latency, jitter and loss and returns
// the p99 jerk of the smoothed track, of the newest raw pose each frame, and
// of the true arc sampled at 60 Hz, with the worst track error.
function fly(rate: number, latency: number, jitter: number, loss: number) {
  const net = new Net({} as never, {} as never)
  ;(net as unknown as { slot: number }).slot = 0 // the remote is slot 1
  const roll = random(12345)
  const slot = 1
  const smoothed: V3[] = []
  const raw: V3[] = []
  const errors: number[] = []
  const stride = 60 / rate // server ticks between snapshots
  let next = 0
  for (let frame = 0; frame < SECONDS * 60; frame++) {
    const now = frame / 60
    clock = now * 1000
    for (;;) {
      const tick = next
      const arrive = tick / 60 + (latency + (roll() * 2 - 1) * jitter) / 1000
      if (arrive > now) break
      next += stride
      if (roll() < loss) continue // dropped
      const sample = truth(tick / 60)
      const saved = clock
      clock = arrive * 1000
      ;(net as unknown as { handle(m: Record<string, unknown>): void }).handle({
        kind: 'poses',
        tick,
        blob: record(slot, sample.position, sample.direction, SPEED),
      })
      clock = saved
    }
    const ring = (net as unknown as { rings: Map<number, { pose: { position: V3 } }[]> }).rings.get(slot)
    if (ring && ring.length) raw.push([...ring[ring.length - 1].pose.position])
    const shown = net.remote(slot)
    if (shown) {
      smoothed.push([shown.position[0], shown.position[1], shown.position[2]])
      // The pose is shown in the engine's frame: the truth goes through the same carry.
      const target = now - (net as unknown as { clock: number }).clock - 0.1
      const expected = local({ ...shown, position: truth(target).position }).position
      errors.push(Math.hypot(shown.position[0] - expected[0], shown.position[1] - expected[1], shown.position[2] - expected[2]))
    }
  }
  const arc: V3[] = []
  for (let frame = 0; frame < SECONDS * 60; frame++) arc.push(truth(frame / 60).position)
  return {
    smoothed: percentile(roughness(smoothed), 0.99),
    raw: percentile(roughness(raw), 0.99),
    arc: percentile(roughness(arc), 0.99),
    error: percentile(errors, 1),
    frames: smoothed.length,
  }
}

describe('a remote jet in a 5 g turn', () => {
  for (const [label, rate, latency, jitter, loss] of [
    ['20 Hz', 20, 50, 0, 0],
    ['20 Hz with 15 ms jitter', 20, 50, 15, 0],
    ['20 Hz with jitter and 15% loss', 20, 50, 15, 0.15],
    ['6.7 Hz, the far tail', 6.67, 50, 15, 0.1],
  ] as const) {
    it(`is drawn smooth: ${label}`, () => {
      const r = fly(rate, latency, jitter, loss)
      expect(r.frames).toBeGreaterThan(SECONDS * 60 * 0.8)
      // Measured 2026-11-20: p99 jerk 571-1286 m/s² smoothed against 36,000-
      // 324,000 raw (the arc itself is 48), and the track within 20 m.
      expect(r.raw / r.smoothed, 'smoother than the newest raw packet').toBeGreaterThan(20)
      expect(r.smoothed, 'p99 jerk, m/s²').toBeLessThan(2000)
      expect(r.error, 'worst track error, m').toBeLessThan(40)
    })
  }
})
