// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { describe, expect, it, vi } from 'vitest'
import { Euro, shape, start } from './head'

// The pipeline's two ends, stood in for: the landmark worker the module
// constructs, and the camera @mochi/web opens.
const worker = vi.hoisted(() => ({ made: [] as unknown[] }))
vi.mock('./landmark.ts?worker&inline', () => ({
  default: class {
    sent: unknown[] = []
    ended = 0
    onmessage: ((event: { data: unknown }) => void) | null = null
    onerror: ((event: { message: string; preventDefault(): void }) => void) | null = null
    constructor() {
      worker.made.push(this)
    }
    postMessage(message: unknown) {
      this.sent.push(message)
    }
    terminate() {
      this.ended++
    }
  },
}))
const camera = vi.hoisted(() => ({ frame: null as ((frame: { close(): void }) => void) | null, stopped: 0 }))
vi.mock('@mochi/web', () => ({
  cameraOpen: async (options: { frame: (frame: { close(): void }) => void }) => {
    camera.frame = options.frame
    return { session: { stop: () => camera.stopped++ }, opened: { ok: true, devices: [] } }
  },
}))
const vision = vi.hoisted(() => ({ fault: new Error('context lost') }))
vi.mock('@mediapipe/tasks-vision', () => ({
  FilesetResolver: { forVisionTasks: async () => ({}) },
  FaceLandmarker: {
    createFromOptions: async () => ({
      detectForVideo: () => {
        throw vision.fault
      },
    }),
  },
}))

describe('shape', () => {
  it('holds still inside the deadzone', () => {
    expect(shape(0, 5, 2.4)).toBe(0)
    expect(shape(0.015, 5, 2.4)).toBe(0)
    expect(shape(-0.015, 5, 2.4)).toBe(0)
  })
  it('is symmetric and monotonic beyond it', () => {
    const gain = 5
    let last = 0
    for (let a = 0.03; a < 0.5; a += 0.02) {
      const out = shape(a, gain, 2.4)
      expect(out).toBeGreaterThan(last)
      expect(shape(-a, gain, 2.4)).toBeCloseTo(-out, 10)
      last = out
    }
  })
  it('amplifies: a comfortable head turn sweeps the full view', () => {
    // ~25° of real head yaw must reach beyond 120° of view with default gain.
    expect(shape((25 * Math.PI) / 180, 5, 2.4)).toBeGreaterThan(2.0)
  })
  it('clamps at the view travel', () => {
    expect(shape(1.2, 5, 2.4)).toBe(2.4)
    expect(shape(-1.2, 5, 2.4)).toBe(-2.4)
  })
})

describe('Euro', () => {
  it('passes a constant through and converges onto steps', () => {
    const f = new Euro()
    expect(f.next(0.5, 1 / 30)).toBe(0.5)
    let out = 0.5
    for (let i = 0; i < 90; i++) out = f.next(0.8, 1 / 30)
    expect(out).toBeCloseTo(0.8, 2)
  })
  it('crushes jitter when still', () => {
    const f = new Euro()
    f.next(0, 1 / 30)
    let worst = 0
    for (let i = 0; i < 60; i++) {
      const noisy = (i % 2 === 0 ? 1 : -1) * 0.01 // ±0.57° sensor tremble
      worst = Math.max(worst, Math.abs(f.next(noisy, 1 / 30)))
    }
    expect(worst).toBeLessThan(0.004) // better than 2.5x quieter than the input
  })
  it('tracks fast motion with little lag', () => {
    const f = new Euro()
    let out = 0
    for (let i = 1; i <= 15; i++) out = f.next(i * 0.05, 1 / 30) // a brisk 0.75 rad sweep in half a second
    expect(out).toBeGreaterThan(0.55) // within ~25% of the moving target at speed
  })
  it('reset forgets the past', () => {
    const f = new Euro()
    f.next(1.0, 1 / 30)
    f.reset()
    expect(f.next(0.2, 1 / 30)).toBe(0.2)
  })
})

describe('a landmarker that fails on a frame', () => {
  it('says so from the worker, rather than leaving the frame unanswered', async () => {
    const posted: { kind: string; message?: string }[] = []
    const scope = globalThis as unknown as { self?: unknown }
    const kept = scope.self
    const self = { postMessage: (m: { kind: string }) => posted.push(m), onmessage: null as null | ((e: { data: unknown }) => void) }
    scope.self = self
    try {
      await import('./landmark')
      self.onmessage?.({ data: { kind: 'init', base: 'base/', model: 'face.task' } })
      await vi.waitFor(() => expect(posted.map((m) => m.kind)).toEqual(['ready']))
      let closed = 0
      self.onmessage?.({ data: { kind: 'frame', bitmap: { close: () => closed++ }, at: 1 } })
      expect(posted[1]).toEqual({ kind: 'dead', message: 'Error: context lost' })
      expect(closed).toBe(1)
    } finally {
      scope.self = kept
    }
  })

  it('ends the session on the main side when the worker throws, the camera and the worker with it', async () => {
    const ended: string[] = []
    const opened = await start({ base: 'base/', model: 'face.task', end: (reason: string) => ended.push(reason) })
    expect(opened.head).not.toBeNull()
    const made = worker.made[worker.made.length - 1] as { sent: { kind: string }[]; ended: number; onmessage(e: { data: unknown }): void; onerror(e: { message: string; preventDefault(): void }): void }
    made.onmessage({ data: { kind: 'ready' } })
    camera.frame?.({ close: () => {} })
    expect(made.sent.map((m) => m.kind)).toEqual(['init', 'frame'])
    made.onerror({ message: 'out of memory', preventDefault: () => {} })
    expect(ended).toEqual(['landmarker: out of memory'])
    expect([camera.stopped, made.ended]).toEqual([1, 1])
  })
})
