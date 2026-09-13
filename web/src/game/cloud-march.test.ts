// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The cloud raymarch's stride schedule, taken from the shader source in
// engine.ts (WebGL at module scope, so it is read as text) and stepped here.
// Opacity accumulates stride by stride, so the stride boundaries are where the
// march quantises a cloud. If they sit at the same distances every frame, the
// temporal accumulation averages the jittered samples inside each stride but
// never the boundaries themselves, and on a cloud base seen edge-on those
// fixed shells show as horizontal stripes.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')

const clamp = (v: number, a: number, b: number) => Math.min(Math.max(v, a), b)
const glsl = (expression: string) => new Function('t', 'ign', 'clamp', 'max', `return ${expression}`) as (t: number, ign: number, c: typeof clamp, m: typeof Math.max) => number

const stride = source.match(/float dt=(clamp\(t\*[\d.]+,[\d.]+,[\d.]+\));/)
const first = source.match(/if\(i==0\) dt\*=(max\(ign,[\d.]+\));/)
const steps = source.match(/for\(int i=0;i<(\d+);i\+\+\)\{ if\(t>t1\|\|tr<0\.03\) break;/)
const far = source.match(/float cfar=([\d.]+);/)

// The stride boundaries of one ray entering the cloud slab at t0, for one frame's jitter.
function boundaries(t0: number, ign: number): number[] {
  const length = glsl(stride![1]), fraction = first ? glsl(first[1]) : () => 1
  const out: number[] = []
  let t = t0
  for (let i = 0; i < Number(steps![1]); i++) {
    let dt = length(t, ign, clamp, Math.max)
    if (i === 0) dt *= fraction(t, ign, clamp, Math.max)
    t += dt
    out.push(t)
  }
  return out
}

const JITTER = Array.from({ length: 10 }, (_, i) => 0.05 + i * 0.1) // the per-frame rotation sweeps ign across [0,1)

describe('the cloud march stride schedule', () => {
  it('is found in the shader', () => {
    expect(stride, 'stride expression').not.toBeNull()
    expect(steps, 'step loop').not.toBeNull()
    expect(far, 'far cutoff').not.toBeNull()
  })

  it('moves every stride boundary across its stride as the jitter rotates', () => {
    for (const t0 of [0, 2500, 12000]) {   // inside the slab, a cloud base above the jet, a distant tower
      const frames = JITTER.map((ign) => boundaries(t0, ign))
      for (const k of [3, 15, 40]) {
        const at = frames.map((b) => b[k])
        const local = glsl(stride![1])(Math.min(...at), 0.5, clamp, Math.max)
        expect((Math.max(...at) - Math.min(...at)) / local, `boundary ${k} from ${t0} m`).toBeGreaterThan(0.8)
      }
    }
  })

  it('still reaches the far cutoff from inside the slab at every jitter', () => {
    for (const ign of JITTER) {
      const b = boundaries(0, ign)
      expect(b[b.length - 1], `ign ${ign}`).toBeGreaterThan(Number(far![1]))
    }
  })
})
