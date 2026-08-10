// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// Webcam head tracking (#57): the player's real head pose drives the
// first-person view, TrackIR-style — a comfortable ±25° of real head turn
// sweeps the whole cockpit. This module owns the camera session (through the
// #56 cameraOpen dual-path helper: the shell streams frames in the sandboxed
// iframe, getUserMedia directly top-window), the landmark worker, and the pure
// shaping maths — deadzone, progressive curve, gain, and a one-euro filter per
// axis so a still head is rock steady while a fast turn stays snappy. Only
// the ~9 MB of runtime + model loads lazily, and only when tracking starts.

import type { CameraDevice, CameraSession } from '@mochi/web'
// The worker ships INLINE (a blob of the fully bundled script): the sandboxed
// shell iframe has an opaque origin, and `new Worker(url)` is refused
// cross-origin — a blob belongs to the iframe's own origin and is allowed.
// Another entry in the iframe-sandbox no-op family.
import LandmarkWorker from './landmark.ts?worker&inline'

// One-euro filter (Casiez, Roustan, Vogel — CHI 2012): adaptive low-pass whose
// cutoff RISES with speed. minimum: cutoff Hz when still (lower = steadier);
// slope: how much cutoff grows per unit speed (higher = less lag when moving).
export class Euro {
  private minimum: number
  private slope: number
  private derivative: number
  private value: number | null = null
  private trend = 0

  constructor(minimum = 1.2, slope = 0.6, derivative = 1.0) {
    this.minimum = minimum
    this.slope = slope
    this.derivative = derivative
  }

  reset(): void {
    this.value = null
    this.trend = 0
  }

  next(raw: number, dt: number): number {
    if (dt <= 0) return this.value ?? raw
    if (this.value === null) {
      this.value = raw
      return raw
    }
    const speed = (raw - this.value) / dt
    this.trend = mix(this.trend, speed, weight(this.derivative, dt))
    const cutoff = this.minimum + this.slope * Math.abs(this.trend)
    this.value = mix(this.value, raw, weight(cutoff, dt))
    return this.value
  }
}

function weight(cutoff: number, dt: number): number {
  const constant = 1 / (2 * Math.PI * cutoff)
  return 1 / (1 + constant / dt)
}

function mix(from: number, to: number, factor: number): number {
  return from + (to - from) * factor
}

// shape turns a raw head angle (radians from the datum) into a view angle:
// a small deadzone so a resting head is still, then a progressive curve
// (signed square) so precision lives near boresight and speed at the edges,
// amplified by the gain and clamped to the view's own travel.
export function shape(angle: number, gain: number, travel: number): number {
  const dead = 0.02 // ~1.1° of real head motion is "still"
  const magnitude = Math.abs(angle)
  if (magnitude <= dead) return 0
  const span = (magnitude - dead) / (1 - dead)
  const curved = span * (0.4 + 0.6 * Math.min(span * 2.5, 1)) // progressive: soft near centre, linear beyond
  const out = Math.sign(angle) * curved * gain
  return Math.max(-travel, Math.min(travel, out))
}

export type HeadPose = { ok: boolean; yaw: number; pitch: number; x: number; y: number; z: number }

export type HeadOptions = {
  /** Vendored runtime directory and model, app-relative. */
  base: string
  model: string
  /** Preferred camera deviceId ('' = default). */
  device?: string
  /** Raw camera frames for a preview tile (already mirrored is the CALLER's job); optional. */
  preview?: (frame: ImageBitmap) => void
  /** Every landmark result, including ok:false when the face is lost. */
  pose?: (pose: HeadPose) => void
  /** The session died underneath us (navigation, tab hide, unplug, worker failure). */
  end?: (reason: string) => void
}

export type Head = {
  stop: () => void
  devices: CameraDevice[]
}

// start opens the camera and the worker and runs the pipeline until stop().
// Resolves once the camera answers; worker readiness follows asynchronously
// (frames before readiness are simply dropped by the worker).
export async function start(options: HeadOptions): Promise<{ head: Head | null; error?: string }> {
  const worker: Worker = new LandmarkWorker()
  worker.postMessage({ kind: 'init', base: options.base, model: options.model })
  let live = true
  let ready = false
  let busy = false
  let died = ''
  worker.onmessage = (event: MessageEvent) => {
    const data = event.data as { kind: string; message?: string } & HeadPose
    if (data.kind === 'ready') { ready = true; return }
    if (data.kind === 'dead') { died = data.message ?? 'failed'; finish('landmarker: ' + died); return }
    if (data.kind === 'pose') {
      busy = false
      if (live) options.pose?.(data)
    }
  }

  let session: CameraSession | null = null
  const finish = (reason: string) => {
    if (!live) return
    live = false
    console.warn('head tracking ended:', reason)
    session?.stop()
    worker.terminate()
    options.end?.(reason)
  }

  // Lazily imported with the rest of the pipeline: the camera helper (and
  // through the worker, the ~9 MB runtime) costs nothing until tracking starts.
  const { cameraOpen } = await import('@mochi/web')
  const { session: opened, opened: result } = await cameraOpen({
    device: options.device,
    frame: (frame) => {
      if (!live) { try { frame.close() } catch { /* closed */ } return }
      options.preview?.(frame)
      // One frame in the worker at a time: inference slower than the camera
      // drops frames here rather than queueing transferred bitmaps.
      if (!ready || busy) { try { frame.close() } catch { /* closed */ } return }
      busy = true
      worker.postMessage({ kind: 'frame', bitmap: frame, at: performance.now() }, [frame])
    },
    end: (reason) => finish(reason),
  })
  session = opened

  if (!live) {
    // The worker died while the camera was still opening: finish() ran with
    // session unassigned, so release the just-granted camera HERE — without
    // this the stream (and the light) outlived a dead pipeline unstoppably.
    opened.stop()
    return { head: null, error: died || 'failed' }
  }
  if (!result.ok) {
    live = false
    worker.terminate()
    return { head: null, error: result.error ? result.error.message : 'cancelled' }
  }
  return {
    head: {
      devices: result.devices,
      stop: () => {
        if (!live) return
        live = false
        session?.stop()
        worker.terminate()
      },
    },
  }
}
