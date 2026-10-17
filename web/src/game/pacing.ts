// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The frame-time record the dynamic resolution governor and the frame rate
// readout read. A frame is recorded at its real length, never at the
// simulation's 50 ms step clamp: a GPU queue that backs up shows as runs of
// 4 ms frames broken by 260 ms stalls, and fed the clamped step the governor
// averaged that to 7 ms and never lowered the scale while the pilot saw 45 fps.

const SIZE = 180 // frames kept
const SPAN = 1000 // ms of the most recent frames the governor judges
const SUSPENDED = 1000 // ms: a longer frame is a hidden or suspended page, not rendering load
const SETTLE = 1000 // ms of frames discarded after a mission starts or the canvas is resized

export class Pacing {
  ring: number[] = new Array(SIZE).fill(16.7)
  next = 0
  skip = 0 // ms still to discard
  since = 0 // ms recorded since the last reset

  // Shaders compile on a mission's first frames (one measured 817 ms) and a
  // resize reallocates every render target (67 ms): neither is load. Judged,
  // they lowered the scale, whose resize was then judged in turn, walking it
  // from 1.0 to 0.5 in two seconds on a machine running 178 fps.
  reset() {
    this.skip = SETTLE
    this.since = 0
  }

  record(seconds: number) {
    const length = seconds * 1000
    if (!(length >= 0) || length > SUSPENDED) return
    if (this.skip > 0) {
      this.skip -= length
      return
    }
    this.ring[this.next] = length
    this.next = (this.next + 1) % this.ring.length
    this.since += length
  }

  // The newest frames covering at least span ms, so one shader-compile hitch
  // is diluted by a second of frames while stalls arriving several times a
  // second still lift the mean. Mean and 90th percentile, in ms; null until a
  // full span has been recorded since the last reset.
  recent(span = SPAN): { mean: number; spike: number } | null {
    if (this.since < span) return null
    const taken: number[] = []
    let total = 0
    for (let k = 1; k <= this.ring.length && total < span; k++) {
      const length =
        this.ring[(this.next - k + this.ring.length) % this.ring.length]
      taken.push(length)
      total += length
    }
    taken.sort((a, b) => a - b)
    return {
      mean: total / taken.length,
      spike: taken[Math.floor(taken.length * 0.9)],
    }
  }

  // Average and 99th percentile over the whole ring, in ms.
  readout(): { average: number; low: number } {
    const sorted = [...this.ring].sort((a, b) => a - b)
    return {
      average: sorted.reduce((sum, v) => sum + v, 0) / sorted.length,
      low: sorted[Math.floor(sorted.length * 0.99)],
    }
  }
}
