// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  amplitudes,
  bands,
  CASCADES,
  peak,
  SIZE,
  slopes,
  variance,
  type Wind,
} from './spectrum'

const trades: Wind = { speed: 12.9, direction: 0.29, fetch: 200000 }
const table = amplitudes(trades, 1)
const width = SIZE * CASCADES.length

describe('the spectrum', () => {
  it('builds the sea a 25 kt trade wind raises over the open ocean', () => {
    // Beaufort 6: large waves of 3 to 4 m, the peak near 8.5 s
    const height = 4 * Math.sqrt(variance(trades))
    expect(height).toBeGreaterThan(3)
    expect(height).toBeLessThan(4.5)
    const period = (2 * Math.PI) / peak(trades)
    expect(period).toBeGreaterThan(7.5)
    expect(period).toBeLessThan(9.5)
  })

  it('gives each wavenumber to exactly one cascade', () => {
    const limits = bands()
    expect(limits[0][0]).toBe(0)
    for (let c = 1; c < CASCADES.length; c++)
      expect(limits[c][0]).toBeCloseTo(limits[c - 1][1], 12)
    for (let c = 0; c < CASCADES.length; c++)
      expect(limits[c][1]).toBeLessThan((Math.PI * SIZE) / CASCADES[c])
  })

  it("draws amplitudes whose sea holds the spectrum's variance", () => {
    // each wavevector's wave is 2 Re(h0 e^(i(kx - wt))): variance 2|h0|^2
    let sum = 0
    for (let i = 0; i < SIZE * width; i++)
      sum += 2 * (table[i * 4] ** 2 + table[i * 4 + 1] ** 2)
    expect(sum / variance(trades)).toBeGreaterThan(0.9)
    expect(sum / variance(trades)).toBeLessThan(1.1)
  })

  it('pairs each amplitude with the conjugate of its opposite', () => {
    for (let c = 0; c < CASCADES.length; c++)
      for (const [x, y] of [
        [3, 140],
        [131, 129],
        [200, 17],
      ]) {
        const o = (y * width + c * SIZE + x) * 4
        const m = ((SIZE - y) * width + c * SIZE + (SIZE - x)) * 4
        expect(table[o + 2]).toBe(table[m])
        expect(table[o + 3]).toBe(-table[m + 1])
      }
  })

  it('spreads its slopes evenly in log wavenumber above the peak', () => {
    // what the sea shader's account of unresolved slopes assumes, per cascade
    const limits = bands()
    const lengths = limits.map(([low, high], c) =>
      Math.log(high / (c === 0 ? peak(trades) ** 2 / 9.81 : low))
    )
    const density = slopes(trades).map((s, c) => s / lengths[c])
    for (const d of density) expect(d / density[1]).toBeGreaterThan(0.75)
    for (const d of density) expect(d / density[1]).toBeLessThan(1.25)
  })
})

describe('the wiring', () => {
  const engine = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
  // lift cuts one top-level function out of the source, keeping its closing brace.
  function lift(name: string): string {
    const start = engine.indexOf(`function ${name}(`)
    expect(start, `${name} in engine.ts`).toBeGreaterThan(0)
    const rest = engine.slice(start)
    const end = /\n(?=\S)/.exec(rest.slice(1))
    if (!end) return rest
    const cut = end.index + 1
    return rest.startsWith('\n}', cut) ? rest.slice(0, cut + 2) : rest.slice(0, cut)
  }
  // apply_waves against stand-ins: the setting, the weather's wind, the sea's material and Waves.
  function sea() {
    const made: Wind[] = []
    const vector = () => ({ x: 0, y: 0, z: 0, set(x: number, y: number, z: number) { Object.assign(this, { x, y, z }) } })
    const material = {
      defines: {} as Record<string, string>, needsUpdate: false,
      uniforms: Object.fromEntries(['u_displacement0', 'u_displacement1', 'u_derivative0', 'u_derivative1', 'u_derivative2'].map((k) => [k, { value: null as unknown }]).concat([['u_spectrum', { value: vector() }]])),
    }
    const state = { cfg: { effects_quality: 2 } as { effects_quality?: number }, wind: { x: -12.12, z: 4.41 } }
    class Stand { displacement = ['d0', 'd1']; derivative = ['s0', 's1', 's2']; constructor(wind: Wind) { made.push(wind) } }
    const run = new Function('cfg', 'weather', 'ocean_mat', 'Waves', 'spectrum_slopes', `let waves=null;\n${lift('apply_waves')}\nreturn apply_waves;`)(
      state.cfg, () => ({ wind: state.wind }), material, Stand, () => [0.01, 0.02, 0.03]) as () => void
    return { run, made, material, state }
  }

  it('draws the spectrum at high and ultra only, makes it once, and raises none in a calm', () => {
    const { run, made, material, state } = sea()
    state.cfg.effects_quality = 1; run()
    expect('WAVES' in material.defines).toBe(false)
    expect(made).toHaveLength(0)
    for (const q of [2, 3]) { state.cfg.effects_quality = q; material.needsUpdate = false; run() }
    expect('WAVES' in material.defines).toBe(true)
    expect(made).toHaveLength(1)
    expect(material.uniforms.u_derivative2.value).toBe('s2')
    expect(material.uniforms.u_spectrum.value).toMatchObject({ x: 0.01, y: 0.02, z: 0.03 })
    state.cfg.effects_quality = 1; material.needsUpdate = false; run()
    expect('WAVES' in material.defines).toBe(false)
    expect(material.needsUpdate).toBe(true)
    const calm = sea(); calm.state.wind = { x: 0, z: 0 }; calm.run()
    expect('WAVES' in calm.material.defines).toBe(false)
    expect(calm.made).toHaveLength(0)
    expect(engine).toMatch(/function apply_effects\(\)\{[^\n]*effects_limits\(\); apply_waves\(\);/)
  })

  it("raises the sea the weather's wind blows, running toward 250 degrees", () => {
    const { run, made } = sea(); run()
    const wind = made[0]
    expect(wind.speed).toBeCloseTo(Math.hypot(12.12, 4.41), 9)
    expect(wind.fetch).toBe(200000)
    const bearing = ((Math.atan2(Math.cos(wind.direction), -Math.sin(wind.direction)) * 180) / Math.PI + 360) % 360   // x east, z south
    expect(bearing).toBeCloseTo(250, 0)
  })

  it('keeps the crossing swell and replaces only the wind sea', () => {
    expect(engine).toMatch(/h\+=wave\(xz,W0,2\.0\*fit\(gap,W0\.z\),g\);gt\+=g;\n\t+#ifdef WAVES\n\t+vec3 d=\(cascade\(u_displacement0,xz,u_lengths\.x,gap\)\+cascade\(u_displacement1,xz,u_lengths\.y,gap\)\)\*ws;/)
    expect(engine).toMatch(/#else\n\t+h\+=wave\(xz,W1,1\.1\*fit\(gap,W1\.z\),g\);gt\+=g;/)
  })

  it("shades the near sea with the cascades' slopes, and its glitter by their slope variance", () => {
    expect(engine).toMatch(/float near=1\.0-smoothstep\(1200\.0,2400\.0,dist\);/)
    expect(engine).toMatch(/lean=mix\(lean,-vec2\(q\.x\/max\(1\.0\+q\.z,0\.2\),q\.y\/max\(1\.0\+q\.w,0\.2\)\)\*\(1\.0-0\.85\*v_calm\),near\);/)
    expect(engine).toMatch(/ripples=mix\(ripples,0\.5\*\(u_spectrum\.x\+u_spectrum\.y\+u_spectrum\.z\)\*\(1\.0-0\.85\*v_calm\)\*\(1\.0-0\.85\*v_calm\),near\);/)
  })

  it('steps the cascades each frame it draws them, and keeps the foam the sines have', () => {
    expect(engine).toMatch(/if\(waves&&\("WAVES" in ocean_mat\.defines\)\) waves\.update\(renderer,ocean_mat\.uniforms\.u_time\.value\);/)
    expect(engine).not.toMatch(/u_foam_field|waves\.foam/)
  })
})
