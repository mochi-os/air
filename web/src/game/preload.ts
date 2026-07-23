// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// Single-flight loader for the big flight assets (models + flight core).
// The menu calls preload() as soon as the app opens, so the downloads run
// while the player is still choosing a mission; the engine consumes the SAME
// in-flight fetches through asset(), so nothing ever downloads twice. Bytes
// are counted as they stream, giving the loading screen a real percentage
// and a stall signal — the honest replacements for the old fixed 20 s cap,
// which force-started missions with missing models on slow connections.

import nimitz_model_url from '../assets/nimitz.glb?url'
import fa18c_model_url from '../assets/fa18c.glb?url'
import flight_wasm_url from '../assets/flight.wasm?url'

interface Load {
  promise: Promise<ArrayBuffer>
  received: number
  total: number // Content-Length when known, else 0
  done: boolean
  failed: boolean
}

const loads = new Map<string, Load>()
let moved = 0 // performance.now() of the last byte progress anywhere

function begin(url: string): Load {
  const existing = loads.get(url)
  if (existing) return existing
  moved = performance.now() // a fresh fetch starts the stall clock now, not at the last byte of some earlier download
  const load: Load = { promise: Promise.resolve(new ArrayBuffer(0)), received: 0, total: 0, done: false, failed: false }
  load.promise = (async () => {
    try {
      const response = await fetch(url)
      if (!response.ok) throw new Error('HTTP ' + response.status)
      load.total = Number(response.headers.get('Content-Length')) || 0
      if (!response.body) {
        const buffer = await response.arrayBuffer()
        load.received = buffer.byteLength
        load.done = true
        moved = performance.now()
        return buffer
      }
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        chunks.push(value)
        load.received += value.length
        moved = performance.now()
      }
      const buffer = new Uint8Array(load.received)
      let at = 0
      for (const chunk of chunks) {
        buffer.set(chunk, at)
        at += chunk.length
      }
      load.done = true
      return buffer.buffer
    } catch (error) {
      load.failed = true
      throw error
    }
  })()
  loads.set(url, load)
  return load
}

// preload starts the big downloads; idempotent, call from the menu on mount.
export function preload(): void {
  moved = performance.now()
  begin(nimitz_model_url)
  begin(fa18c_model_url)
  begin(flight_wasm_url)
}

// asset returns the bytes for a URL, joining the in-flight download if the
// menu already started it.
export function asset(url: string): Promise<ArrayBuffer> {
  return begin(url).promise
}

// progress reports the aggregate download state for the loading screen.
export function progress(): { percent: number; failed: boolean; idle: number } {
  let received = 0
  let total = 0
  let failed = false
  let outstanding = false
  for (const load of loads.values()) {
    received += load.received
    total += load.total
    failed = failed || load.failed
    outstanding = outstanding || (!load.done && !load.failed)
  }
  return {
    percent: total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : 0,
    failed,
    // A stall needs OUTSTANDING work with no bytes moving. With every download
    // complete, "ms since the last byte" grows forever — on a match RESTART the
    // cached assets fetch nothing, so the old unconditional clock read minutes
    // idle and the engine declared LOADING FAILED on the first frame.
    idle: outstanding ? performance.now() - moved : 0,
  }
}
