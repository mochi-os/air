// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import type * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { CASCADES, SIZE } from './spectrum'
import { FFT, Waves } from './waves'

// The FFT pass's own index and twiddle lines, run as JavaScript: the GLSL's integer
// division truncates, and the rest is the same syntax once the types are dropped
function butterfly(): (
  o: number,
  stage: number
) => { j: number; angle: number; sign: number } {
  const body = FFT.slice(
    FFT.indexOf('int span=1<<u_stage;'),
    FFT.indexOf('o_first=a0+s*ta')
  )
  const lines = body
    .split(/;\s*/)
    .filter((line) =>
      /^(int|float) (span|block|q|r|m|j|angle|s)=/.test(line.trim())
    )
  const script = lines
    .map((line) =>
      line
        .trim()
        .replace(/^(int|float) /, 'let ')
        .replace(/float\(/g, '(')
        .replace(/\/\(2\*span\)/, '/(2*span)|0')
        .replace(/q\/span/, 'q/span|0')
    )
    .join(';\n')
  expect(
    lines.length,
    'the pass computes span, block, q, r, m, j, angle and its sign'
  ).toBe(8)
  return new Function(
    'o',
    'u_stage',
    `${script};\nreturn { j, angle, sign: s }`
  ) as never
}

// One axis of N points through the passes as the strip runs them: inputs j and
// j + N/2, the second turned by the twiddle, added or taken away
function transform(re: number[], im: number[]): [number[], number[]] {
  const pass = butterfly()
  const n = re.length
  let a = [re.slice(), im.slice()]
  for (let stage = 0; stage < Math.log2(n); stage++) {
    const b = [new Array(n).fill(0), new Array(n).fill(0)]
    for (let o = 0; o < n; o++) {
      const { j, angle, sign } = pass(o, stage)
      const c = Math.cos(angle),
        s = Math.sin(angle)
      const xr = a[0][j + n / 2] * c - a[1][j + n / 2] * s,
        xi = a[0][j + n / 2] * s + a[1][j + n / 2] * c
      b[0][o] = a[0][j] + sign * xr
      b[1][o] = a[1][j] + sign * xi
    }
    a = b
  }
  return [a[0], a[1]]
}

describe('the transform', () => {
  it("is the inverse DFT, in natural order, with the shader's own butterflies", () => {
    const n = SIZE
    const re = Array.from(
      { length: n },
      (_, k) => Math.sin(k * 1.7) + 0.3 * Math.cos(k * 0.11)
    )
    const im = Array.from({ length: n }, (_, k) => Math.cos(k * 0.53) - 0.2)
    const [gr, gi] = transform(re, im)
    for (const x of [0, 1, 37, 128, 255]) {
      let wr = 0,
        wi = 0
      for (let k = 0; k < n; k++) {
        const t = (2 * Math.PI * k * x) / n
        wr += re[k] * Math.cos(t) - im[k] * Math.sin(t)
        wi += re[k] * Math.sin(t) + im[k] * Math.cos(t)
      }
      expect(gr[x]).toBeCloseTo(wr, 6)
      expect(gi[x]).toBeCloseTo(wi, 6)
    }
  })

})

// A renderer that records what it is asked to draw
function recorder() {
  const log: {
    target: unknown
    material: THREE.ShaderMaterial
    uniforms: Record<string, unknown>
    clear: boolean
  }[] = []
  let target: unknown = 'canvas'
  const renderer = {
    autoClear: true,
    getRenderTarget: () => target,
    setRenderTarget: (t: unknown) => {
      target = t
    },
    render: (room: THREE.Scene) => {
      const mesh = room.children[0] as THREE.Mesh
      const material = mesh.material as THREE.ShaderMaterial
      const uniforms: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(material.uniforms))
        uniforms[k] = v.value
      log.push({ target, material, uniforms, clear: renderer.autoClear })
    },
  }
  return { renderer: renderer as unknown as THREE.WebGLRenderer, log }
}

describe('a step of the sea', () => {
  const waves = new Waves({ speed: 12.9, direction: 0.29, fetch: 200000 }, 1)

  it('evolves, transforms along each axis and finishes each cascade, without clearing', () => {
    const { renderer, log } = recorder()
    waves.update(renderer, 10)
    const stages = Math.log2(SIZE)
    expect(log.length).toBe(1 + 2 * stages + CASCADES.length)
    expect(log[0].uniforms.u_time).toBe(10)
    for (let k = 0; k < 2 * stages; k++) {
      expect(log[1 + k].uniforms.u_stage).toBe(k % stages)
      expect(log[1 + k].uniforms.u_axis).toBe(k < stages ? 0 : 1)
      expect(
        log[1 + k].target,
        'each pass writes the target the last one did not'
      ).not.toBe(log[k].target)
      expect(
        log[1 + k].uniforms.u_first,
        'and reads what the last one wrote'
      ).toBe((log[k].target as THREE.WebGLMultipleRenderTargets).texture[0])
    }
    for (let c = 0; c < CASCADES.length; c++)
      expect(log[1 + 2 * stages + c].uniforms.u_cascade).toBe(c)
    expect(
      log.every((pass) => !pass.clear),
      'every pass writes every texel'
    ).toBe(true)
    expect(renderer.autoClear).toBe(true)
    expect(renderer.getRenderTarget()).toBe('canvas')
  })

  it('does nothing while the clock stands still', () => {
    const still = recorder()
    waves.update(still.renderer, 10)
    expect(still.log.length).toBe(0)
  })
})
