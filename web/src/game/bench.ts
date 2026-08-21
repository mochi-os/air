// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// Frame-time benchmark sampler (#148, developer mode only): &bench=<sample s>
// &benchto=<url> [&benchwarm=<s>]. Imported FIRST by engine.ts and free of
// engine dependencies, so it still reports (including any module-evaluation
// error that kills the engine) when later engine init fails. An independent
// RAF loop records per-frame deltas after warmup, then beacons the
// distribution; the engine registers a state callback (bench_state) so the
// report carries the resolved quality knobs when the engine is alive.

import { cadence } from './governor'

const params = new URLSearchParams(location.search)
const active = params.get('developer') === '1' && !!params.get('bench')

// The engine sets this to report its resolved knobs (render scale, ssaa, msaa).
export let bench_state: (() => Record<string, unknown>) | null = null
export function bench_register(fn: () => Record<string, unknown>): void {
  bench_state = fn
}

if (active) {
  const to = params.get('benchto') || ''
  const send = (payload: Record<string, unknown>) => {
    const body = JSON.stringify(payload)
    ;(globalThis as { bench_result?: unknown }).bench_result = payload
    if (to) navigator.sendBeacon(to, body)
  }
  send({ debug: 'bench-module-loaded' })
  addEventListener('unhandledrejection', (e) => {
    send({ debug: 'unhandledrejection', reason: String((e as PromiseRejectionEvent).reason).slice(0, 400) })
  })
  addEventListener('error', (e) => {
    const ev = e as ErrorEvent
    if (ev.message) send({ debug: 'error', message: String(ev.message).slice(0, 300), file: String(ev.filename || '').split('/').pop(), line: ev.lineno })
  }, true)

  const sample = parseFloat(params.get('bench') || '12') || 12
  const warm = parseFloat(params.get('benchwarm') || '10') || 10
  const deltas: number[] = []
  let prev = 0
  let t0 = 0
  // Engine state at the start of the sample window: acc_* fields are cumulative
  // counters (e.g. render-submission ms); finish() diffs them over the window so
  // the report carries per-frame costs (#197).
  let state0: Record<string, unknown> | null = null
  const finish = () => {
    const s = [...deltas].sort((a, b) => a - b)
    const sum = s.reduce((a, v) => a + v, 0) || 1
    const canvas = document.querySelector('canvas')
    const out: Record<string, unknown> = {
      ua: navigator.userAgent,
      dpr: devicePixelRatio,
      back: canvas ? [canvas.width, canvas.height] : null,
      frames: s.length,
      avg: +(sum / s.length).toFixed(2),   // i18n-format-ok: developer benchmark payload, never shown to a user
      median: +(s[s.length >> 1] || 0).toFixed(2),   // i18n-format-ok: developer benchmark payload, never shown to a user
      p95: +(s[Math.floor(s.length * 0.95)] || 0).toFixed(2),   // i18n-format-ok: developer benchmark payload, never shown to a user
      fps: +(1000 / (sum / s.length)).toFixed(1),   // i18n-format-ok: developer benchmark payload, never shown to a user
      // The fast tail: under vsync the quickest frames ARE the panel period, so
      // these two bound the refresh from below even when the mean is loaded.
      fastest: +(s[0] || 0).toFixed(2),   // i18n-format-ok: developer benchmark payload, never shown to a user
      p5: +(s[Math.floor(s.length * 0.05)] || 0).toFixed(2),   // i18n-format-ok: developer benchmark payload, never shown to a user
      ...cadence(deltas),
      // Non-standard and absent on most browsers; reported when present as a
      // cross-check on the measured beat, never as the primary source.
      declared: (screen as unknown as { refreshRate?: number }).refreshRate ?? null,
    }
    try {
      const gl = canvas?.getContext('webgl2') || canvas?.getContext('webgl')
      const dbg = gl?.getExtension('WEBGL_debug_renderer_info')
      out.gpu = dbg && gl ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '?'
    } catch { out.gpu = '?' }
    if (bench_state) {
      const state = bench_state()
      for (const [k, v] of Object.entries(state)) {
        if (k.startsWith('acc_') && typeof v === 'number') {
          const base = typeof state0?.[k] === 'number' ? (state0[k] as number) : 0
          out['frame_' + k.slice(4)] = +((v - base) / (s.length || 1)).toFixed(2)   // i18n-format-ok: developer benchmark payload, never shown to a user
        } else {
          out[k] = v
        }
      }
    }
    send(out)
  }
  // bench_arm() ends the warmup NOW and starts the sample window from this
  // instant. The timer's own clock starts at page load, so a fixed warmup only
  // catches a fight if the timer happens to line up with one — and a sample
  // spent dead or disengaged is a wasted run. Call it from the console the
  // moment the fight is actually joined.
  ;(globalThis as { bench_arm?: () => string }).bench_arm = () => {
    if (deltas.length) return 'already sampling'
    t0 = performance.now() - warm * 1000 - 1
    return 'sampling ' + sample + 's from now — read bench_result when it lands'
  }
  console.warn('bench: call bench_arm() to start the ' + sample + 's sample immediately')   // warn, not info: the lint scope allows warn/error only, and this line has to reach a console the player is already looking at

  const tick = (now: number) => {
    if (!t0) { t0 = now; prev = now; requestAnimationFrame(tick); return }
    const dt = now - prev
    prev = now
    if (now - t0 > warm * 1000) {
      if (!state0 && bench_state) state0 = bench_state()
      deltas.push(dt)
      if (now - t0 > (warm + sample) * 1000) { finish(); return }
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}
