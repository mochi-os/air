// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { GROUND, radiance, sunlight, tables, transmittance } from './atmosphere'

const air = tables(2.5)
const noon: [number, number, number] = [0, 0.866, 0.5]
const luminance = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]

describe('the transmittance table', () => {
  it('passes what the vertical optical depths of the air say, from the sea straight up', () => {
    // Rayleigh 8 km, Mie 1.2 km (times the haze), ozone a 15 km tent: blue loses most
    const up = transmittance(air.transmittance, GROUND, 1)
    expect(up[0]).toBeCloseTo(0.932, 2)
    expect(up[2]).toBeCloseTo(0.753, 2)
    expect(up[0]).toBeGreaterThan(up[1])
    expect(up[1]).toBeGreaterThan(up[2])
  })

  it('is nothing below the horizon, where the ray meets the sea', () => {
    expect(transmittance(air.transmittance, GROUND + 1, -0.5)).toEqual([
      0, 0, 0,
    ])
  })

  it('reddens and dims the sun as it sinks', () => {
    const high = sunlight(air, 10, noon)
    const low = sunlight(air, 10, [0, 0.05, 0.9987])
    expect(luminance(low)).toBeLessThan(luminance(high) * 0.6)
    expect(low[0] / low[2]).toBeGreaterThan((high[0] / high[2]) * 2)
  })
})

describe('the sky', () => {
  it('is blue overhead and paler, brighter, toward the horizon', () => {
    const zenith = radiance(air, [0, 1, 0], 10, noon, 2.5)
    const horizon = radiance(air, [0, 0.02, -1], 10, noon, 2.5)
    expect(zenith[2] / zenith[0]).toBeGreaterThan(3)
    expect(horizon[2] / horizon[0]).toBeLessThan(zenith[2] / zenith[0])
    expect(luminance(horizon)).toBeGreaterThan(luminance(zenith) * 3)
  })

  it('darkens overhead as the jet climbs out of the air', () => {
    const low = radiance(air, [0, 1, 0], 100, noon, 2.5)
    const high = radiance(air, [0, 1, 0], 12000, noon, 2.5)
    expect(luminance(high)).toBeLessThan(luminance(low) * 0.5)
  })

  it('brightens toward the sun, where the aerosols scatter forward', () => {
    const toward = radiance(air, [0, 0.5, 0.866], 10, noon, 2.5)
    const away = radiance(air, [0, 0.5, -0.866], 10, noon, 2.5)
    expect(luminance(toward)).toBeGreaterThan(luminance(away) * 1.5)
  })
})

describe('the wiring', () => {
  const engine = readFileSync(
    fileURLToPath(new URL('./engine.ts', import.meta.url)),
    'utf8'
  )
  const numbers = (text: string) =>
    (text.match(/-?\d+\.\d+/g) || []).map((n) => Number(n))

  it("shows the sky through the land's own curve, number for number", () => {
    const shown = engine.slice(
      engine.indexOf('vec3 shown_tone(vec3 v){'),
      engine.indexOf('vec3 sky_dome(vec3 d,')
    )
    const land = engine.slice(
      engine.indexOf('vec3 rrtodt(vec3 v){'),
      engine.indexOf('vec3 srgb(vec3 c){')
    )
    expect(numbers(land).length).toBeGreaterThan(20)
    for (const n of numbers(land))
      expect(numbers(shown), `the cloud pass's ${n}`).toContain(n)
    expect(engine).toMatch(
      /renderer\.toneMapping=THREE\.ACESFilmicToneMapping;/
    )
  })

  it('has the dome, the sea and the clouds read the one sky-view table', () => {
    expect(engine).toMatch(
      /vec3 col=sky_dome\(normalize\(v_dir\),normalize\(u_sun\),u_dip,u_fog,u_ovc,u_ovct,u_ovcw,u_sun_col,u_exposure\);/
    )
    expect(engine).toMatch(
      /vec3 skybg=sky_dome\(ray,uSun,uDip,uFog,uOvc,uOvcT,uOvcW,uSunCol,uExposure\);/
    )
    expect(engine).toMatch(
      /vec3 col=shown\(at_sky\(normalize\(d\),normalize\(u_sun\)\)\*u_illuminance,u_exposure\);/
    )
    expect(engine).toMatch(
      /sky_view_render\(camera\.position\.y\); {3}\/\/ the sky from this height/
    )
    expect(engine).toMatch(
      /function mirror_bake\(\)\{\n\tsky_view_render\(camera\.position\.y\);/
    )
  })

  it("fogs the lit materials to the sky's own horizon, each frame", () => {
    expect(engine).toMatch(
      /scene\.fog\.color\.setRGB\(r\[0\]\*e,r\[1\]\*e,r\[2\]\*e\);/
    )
  })

  it('lights the sky by the hour', () => {
    expect(engine).toMatch(/\tday: {2}\{ sky:4\.5, sun:/)
    expect(engine).toMatch(/\tnight:\{ sky:0\.1, sun:/)
    expect(engine).toMatch(
      /atmosphere_uniforms\.u_exposure\.value=p\.exp; atmosphere_uniforms\.u_illuminance\.value=p\.sky;/
    )
  })
})
