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
// The standard normal's inverse distribution (Acklam), for fixed quasi-random draws.
const normal = (u: number) => {
  const a = [2.50662823884, -18.61500062529, 41.39119773534, -25.44106049637],
    b = [-8.4735109309, 23.08336743743, -21.06224101826, 3.13082909833]
  const q = u - 0.5
  if (Math.abs(q) < 0.42) { const r = q * q; return (q * (((a[3] * r + a[2]) * r + a[1]) * r + a[0])) / ((((b[3] * r + b[2]) * r + b[1]) * r + b[0]) * r + 1) }
  const r = Math.log(-Math.log(q > 0 ? 1 - u : u))
  const c = [0.3374754822726147, 0.9761690190917186, 0.1607979714918209, 0.0276438810333863, 0.0038405729373609, 0.0003951896511919, 0.0000321767881768, 0.0000002888167364, 0.0000003960315187]
  let x = c[8]; for (let i = 7; i >= 0; i--) x = x * r + c[i]
  return q > 0 ? x : -x
}

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
      engine.indexOf('vec3 unshown(vec3 colour,')
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
      /vec3 d=normalize\(v_dir\); vec3 col=sky_dome\(d,normalize\(u_sun\),u_dip,u_fog,u_ovc,u_ovct,u_ovcw,u_sun_col,u_exposure,max\(length\(fwidth\(d\)\),1\.0e-5\)\);/
    )
    expect(engine).toMatch(
      /vec3 skybg=sky_dome\(ray,uSun,uDip,uFog,uOvc,uOvcT,uOvcW,uSunCol,uExposure,blur\);/
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

describe("the sea's reflection", () => {
  const engine = readFileSync(
    fileURLToPath(new URL('./engine.ts', import.meta.url)),
    'utf8'
  )
  const shader = engine.slice(engine.indexOf('const TONE='))
  // A GLSL mat3 from its source, column by column, as m[row][column].
  function matrix(name: string) {
    const m = new RegExp(`const mat3 ${name}=mat3\\(([^)]*)\\);`).exec(shader)
    expect(m, `${name} in SKY_SHOWN`).not.toBeNull()
    const v = m![1].split(',').map(Number)
    expect(v).toHaveLength(9)
    return [0, 1, 2].map((r) => [0, 1, 2].map((c) => v[c * 3 + r]))
  }
  const times = (m: number[][], v: number[]) =>
    m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2])
  const inm = matrix('inm'), outm = matrix('outm'), outi = matrix('outi'), ini = matrix('ini')
  const fit = (v: number) =>
    (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081)
  const clamp = (v: number) => Math.min(Math.max(v, 0), 1)
  // shown() and unshown() as the shader writes them, on the source's own matrices.
  const shown = (colour: number[], exposure: number) =>
    times(outm, times(inm, colour.map((c) => (c * exposure) / 0.6)).map(fit))
      .map(clamp)
      .map((c) => (c < 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055))
  const unshown = (colour: number[], exposure: number) => {
    const c = colour.map(clamp).map((c) => (c < 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    const v = times(outi, c).map(clamp).map((y) => {
      const a = 1 - 0.983729 * y, b = 0.0245786 - 0.432951 * y, k = -(0.000090537 + 0.238081 * y)
      return (-b + Math.sqrt(b * b - 4 * a * k)) / (2 * a)
    })
    return times(ini, v).map((x) => (Math.max(x, 0) * 0.6) / exposure)
  }

  it('undoes the curve the sky is shown through', () => {
    for (const [m, n] of [[outi, outm], [ini, inm]])
      for (let r = 0; r < 3; r++)
        for (let c = 0; c < 3; c++)
          expect(m[r][0] * n[0][c] + m[r][1] * n[1][c] + m[r][2] * n[2][c]).toBeCloseTo(r === c ? 1 : 0, 5)
    expect(shader).toMatch(
      /vec3 a=1\.0-0\.983729\*y, b=0\.0245786-0\.4329510\*y, k=-\(0\.000090537\+0\.238081\*y\);/
    )
    expect(shader).toMatch(/vec3 shown_tone\(vec3 v\)\{ vec3 a=v\*\(v\+0\.0245786\)-0\.000090537; vec3 b=v\*\(0\.983729\*v\+0\.4329510\)\+0\.238081;/)
    // Light the screen can show comes back exactly; a colour past the display's gamut or white is clipped by shown() and cannot.
    for (const light of [[0.01, 0.01, 0.01], [0.02, 0.04, 0.07], [0.05, 0.1, 0.2], [0.2, 0.2, 0.2], [0.3, 0.35, 0.5], [1.2, 1.0, 0.8]]) {
      const display = shown(light, 1.05)
      for (const c of display) { expect(c).toBeGreaterThan(0); expect(c).toBeLessThan(1) }
      const back = unshown(display, 1.05)
      for (let i = 0; i < 3; i++) expect(back[i] / light[i]).toBeCloseTo(1, 3)
    }
  })

  it('adds the sky to the water in linear light, not as displayed colours', () => {
    expect(engine).toMatch(
      /vec3 ray=reflect\(-V,N\), water=unshown\(body,u_exposure\), sky=unshown\(refl\*mix\(shade,1\.0,0\.25\),u_exposure\);/
    )
    expect(engine).toMatch(
      /vec3 surface=mix\(water,sky,clamp\(fres\*mix\(1\.0,0\.35,shallow\)\*seen,0\.0,1\.0\)\);/
    )
    expect(engine).toMatch(/vec3 col=shown\(surface\+glint,u_exposure\);/)
    expect(engine).not.toMatch(/vec3 col=mix\(body,/)
  })

  it('shows a ray reflected down the next wave: its water, and the sky it mirrors, joining the sky at the horizon', () => {
    const m = /sky=mix\(water,unshown\(mirrored\*mix\(shade,1\.0,0\.25\),u_exposure\),([^;]+)\); \}/.exec(engine)
    expect(m, 'the downward ray in the sea shader').not.toBeNull()
    expect(engine).toMatch(/if\(ray\.y<0\.0\)\{[^\n]*\n\t*vec3 mirrored=sky_at\(vec3\(ray\.x,-ray\.y,ray\.z\)\);/)
    const fresnel = new Function('ray', `return ${m![1].replace(/pow\(/g, 'Math.pow(')};`) as (ray: { y: number }) => number
    expect(fresnel({ y: 0 })).toBeCloseTo(1, 9)   // at the horizon the next wave is a mirror: no seam with the sky above it
    expect(fresnel({ y: -1 })).toBeCloseTo(0.02, 9)
    expect(fresnel({ y: -0.1 })).toBeLessThan(fresnel({ y: -0.05 }))
  })

  it("weights each ripple by how much of it the eye sees, averaging 1 over the sea's slopes at every angle", () => {
    expect(engine).toMatch(
      /float facing=dot\(vn,V\), grazing=max\(facing,0\.02\), margin=grazing\/\(length\(V-vn\*facing\)\*rw\+1\.0e-4\);/
    )
    expect(engine).toMatch(
      /float seen=max\(dot\(N,V\),0\.0\)\/\(max\(dot\(N,vn\),0\.2\)\*grazing\*expected\);/
    )
    const line = /float expected=([^;]+);/.exec(engine)
    expect(line, 'expected in the sea shader').not.toBeNull()
    const expected = new Function('margin', 'tanh', 'exp', `return ${line![1]};`) as (
      margin: number, tanh: (x: number) => number, exp: (x: number) => number) => number
    // Slopes along the line of sight, Gaussian with the spread rw, by a fixed quasi-random draw.
    for (const spread of [0.1, 0.234, 0.4])
      for (const degrees of [3, 5, 12, 30, 60, 85]) {
        const d = (degrees * Math.PI) / 180, grazing = Math.max(Math.sin(d), 0.02)
        const margin = grazing / (Math.cos(d) * spread + 1e-4)
        const mean = expected(margin, Math.tanh, Math.exp)
        let sum = 0
        const n = 20000
        for (let i = 0; i < n; i++) {
          const slope = normal((i + 0.5) / n) * spread
          sum += Math.max(Math.sin(d) - slope * Math.cos(d), 0) / (grazing * mean)   // N.V over N.vn: the normalisation shared by both cancels
        }
        expect(sum / n, `${degrees} degrees, spread ${spread}`).toBeCloseTo(1, 1)
        expect(Math.abs(sum / n - 1), `${degrees} degrees, spread ${spread}`).toBeLessThan(0.02)
      }
  })
})

describe("the sun's glint", () => {
  const engine = readFileSync(
    fileURLToPath(new URL('./engine.ts', import.meta.url)),
    'utf8'
  )
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
  // A scalar GLSL expression from the sea shader, run as JavaScript with the names it reads.
  function expression(pattern: RegExp, names: string[]) {
    const m = pattern.exec(engine)
    expect(m, String(pattern)).not.toBeNull()
    const js = m![1]
      .replace(/\bdot\((\w+),\1\)/g, '($1_x*$1_x+$1_y*$1_y)')
      .replace(/\b(exp|sqrt|min|max|pow)\(/g, 'Math.$1(')
      .replace(/(\w+)\.([xy])\b/g, '$1_$2')
    return new Function(...names, `return ${js};`) as (...values: number[]) => number
  }

  it("reflects the beam by Cox-Munk's slope density, which integrates to one, split along the weather's wind", () => {
    const shares = /float upwind=([\d.]+)\*rw\*rw, crosswind=([\d.]+)\*rw\*rw;/.exec(engine)
    expect(shares, 'the upwind and crosswind shares').not.toBeNull()
    const upwind = Number(shares![1]), crosswind = Number(shares![2])
    // Cox-Munk at the wind the weather blows: 3.16e-3 U upwind, 0.003 + 1.92e-3 U crosswind
    const wind = new Function('CLOUDS', 'cfg', 'DEV_MODE', 'D2R', 'WORLD_WRAP', 'cheat', `${lift('weather')}\nreturn weather;`)(
      {}, { clouds: 'none' }, false, Math.PI / 180, 250000, () => false)().wind
    const speed = Math.hypot(wind.x, wind.z)
    const total = 0.003 + 5.12e-3 * speed
    expect(upwind).toBeCloseTo((3.16e-3 * speed) / total, 2)
    expect(crosswind).toBeCloseTo((0.003 + 1.92e-3 * speed) / total, 2)
    expect(upwind + crosswind).toBeCloseTo(1, 9)
    expect(engine).toMatch(/vec2 along=vec2\(dot\(dv,u_downwind\),dot\(dv,vec2\(-u_downwind\.y,u_downwind\.x\)\)\);/)
    const density = expression(/float density=([^;]+);/, ['along_x', 'along_y', 'upwind', 'crosswind'])
    for (const rw of [0.15, 0.234, 0.3]) {
      let sum = 0
      const step = 0.004
      for (let x = -1.5; x <= 1.5; x += step)
        for (let y = -1.5; y <= 1.5; y += step) sum += density(x, y, upwind * rw * rw, crosswind * rw * rw) * step * step
      expect(sum, `rw ${rw}`).toBeCloseTo(1, 3)
    }
  })

  it("takes the sea's roughness from the weather's wind, by day and by night", () => {
    expect(engine).toMatch(/float rw=sqrt\(u_slope\)\*mix\(1\.0,0\.4,v_calm\);/)
    expect(engine).toMatch(/float ra=rw\/2\.4;/)
    expect(engine).not.toMatch(/u_rough|rough:0\./)
    const slope = (wind: { x: number; z: number }) => {
      const ocean_mat = { uniforms: { u_slope: { value: 0 } } }
      new Function('weather', 'downwind', 'ocean_mat', `${lift('apply_wind')}\napply_wind();`)(
        () => ({ wind }), { value: { set() {} } }, ocean_mat)
      return ocean_mat.uniforms.u_slope.value
    }
    // Cox-Munk's mean square slope, 0.003 + 5.12e-3 U, at the trades and in a calm
    expect(slope({ x: -12.12, z: 4.41 })).toBeCloseTo(0.003 + 5.12e-3 * Math.hypot(12.12, 4.41), 9)
    expect(slope({ x: 0, z: 0 })).toBeCloseTo(0.003, 9)
  })

  it('adds the glint to the sea in linear light, from the hour\'s own beam', () => {
    expect(engine).toMatch(
      /vec3 glint=u_beam\*fresH\*density\*tilt\*tilt\/\(4\.0\*max\(dot\(Ne,V\),0\.05\)\)\*glitter\*\(1\.0-0\.85\*u_cloud_flat\)\*shade\*shade;/
    )
    expect(engine).toMatch(/float tilt=1\.0\+dot\(dv,dv\);/)
    expect(engine).toMatch(/vec3 col=shown\(surface\+glint,u_exposure\);/)
    expect(engine).toMatch(/ocean_mat\.uniforms\.u_beam\.value\.copy\(sun\.color\)\.multiplyScalar\(p\.sunI\);/)
    expect(engine).not.toMatch(/u_glint|glint\/\(1\.0\+0\.22\*glint\)/)
  })

  it('scatters it into glitter without changing how much light there is', () => {
    // The ripples' variance is the baked texture's own, through the octave weights the slope uses.
    const baked = (() => {
      const THREE = { DataTexture: function (this: { image: { data: Uint8Array } }, data: Uint8Array) { this.image = { data } }, RGBAFormat: 0, RepeatWrapping: 0, LinearFilter: 0, LinearMipmapLinearFilter: 0 }
      const texture = new Function('THREE', 'renderer', `${lift('build_water_detail')}\nreturn build_water_detail();`)(
        THREE, { capabilities: { getMaxAnisotropy: () => 2 } }) as { image: { data: Uint8Array } }
      const data = texture.image.data, n = data.length / 4
      let sum = 0, square = 0
      for (let i = 0; i < n; i++)
        for (const k of [0, 1]) { const v = (data[i * 4 + k] / 255 - 0.5) * 2; sum += v; square += v * v }
      return square / (2 * n) - (sum / (2 * n)) ** 2
    })()
    const ripples = /float ripples=([\d.]+)\*u_wind\*u_wind\*\(1\.0-0\.85\*v_calm\)\*\(1\.0-0\.85\*v_calm\)\*\(([\d.]+)\+([\d.]+)\*f2\*f2\+([\d.]+)\*far\*far\);/.exec(engine)
    expect(ripples, 'the ripples line').not.toBeNull()
    expect(Number(ripples![1])).toBeCloseTo(baked, 3)
    const weights = /vec2 slope=\(s0\*([\d.]+) \+ s1\*([\d.]+)\*f2 \+ s3\*([\d.]+)\*far\)\*u_wind\*\(1\.0-0\.85\*v_calm\);/.exec(engine)
    expect(weights, 'the slope line').not.toBeNull()
    for (let i = 1; i <= 3; i++) expect(Number(ripples![i + 1])).toBeCloseTo(Number(weights![i]) ** 2, 6)
    // Over the ripples a pixel can hold, the glitter averages 1 wherever the needed slope sits in the pool.
    expect(engine).toMatch(/float spark=exp\(-dot\(dv2,dv2\)\/\(rs\*rs\)\);/)
    expect(engine).toMatch(/float kernel=rs\*rs\+2\.0\*ripples;/)
    const glitter = expression(/float glitter=([^;]+);/, ['spark', 'rs', 'kernel', 'ev_x', 'ev_y'])
    const dot = (x: number, y: number) => x * x + y * y
    for (const [rs, variance] of [[0.156, 0.0129], [0.156, 0.004], [0.11, 0.008]]) {
      const kernel = rs * rs + 2 * variance, reach = Math.sqrt(kernel / 2)
      for (const offset of [0, reach, 1.5 * reach]) {
        let sum = 0
        const n = 300
        for (let i = 0; i < n; i++)
          for (let j = 0; j < n; j++) {
            const x = offset + normal((i + 0.5) / n) * Math.sqrt(variance), y = normal((j + 0.5) / n) * Math.sqrt(variance)
            sum += glitter(Math.exp(-dot(x, y) / (rs * rs)), rs, kernel, offset, 0)
          }
        expect(sum / (n * n), `rs ${rs}, variance ${variance}, offset ${offset}`).toBeCloseTo(1, 1)
        expect(Math.abs(sum / (n * n) - 1)).toBeLessThan(0.03)
      }
    }
  })
})

describe('the sun', () => {
  const engine = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
  const shader = engine.slice(engine.indexOf('const SKY_SHOWN='), engine.indexOf('const sky_mat'))

  it('is drawn its own size, 0.53 degrees across, with a pixel-soft edge', () => {
    const m = /float a=length\(cross\(d,sun\)\), disc=dot\(d,sun\)>0\.0\?1\.0-smoothstep\(([\d.]+)-blur,\1\+blur,a\):0\.0;/.exec(shader)
    expect(m, 'the disc in sky_dome').not.toBeNull()
    expect(shader).toMatch(/return col\+suncol\*1\.4\*disc; \}/)
    const radius = Number(m![1])
    expect(Math.asin(radius) * 2 * (180 / Math.PI)).toBeCloseTo(0.533, 2)   // the sun's mean angular diameter from the Earth
    // The disc against the angle from the sun, as the shader draws it, at a pixel of 0.09 degrees.
    const smooth = (a: number, b: number, x: number) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t) }
    const disc = (degrees: number, blur: number) => {
      const r = (degrees * Math.PI) / 180
      return Math.cos(r) > 0 ? 1 - smooth(radius - blur, radius + blur, Math.sin(r)) : 0
    }
    const pixel = (0.0885 * Math.PI) / 180
    expect(disc(0, pixel)).toBe(1)
    expect(disc(0.15, pixel)).toBe(1)
    expect(disc(0.27, pixel)).toBeGreaterThan(0.3)
    expect(disc(0.27, pixel)).toBeLessThan(0.7)
    expect(disc(0.45, pixel)).toBe(0)
    expect(disc(180, pixel)).toBe(0)
  })

  it('takes each pixel\'s angle outside any branch, where its derivatives hold', () => {
    expect(engine).toMatch(/vec3 ray=normalize\(fp\.xyz\/fp\.w-uCamPos\); float blur=max\(length\(fwidth\(ray\)\),1\.0e-5\);/)
  })

  it('draws no glow of its own: the air\'s is in the sky, and its reflection is the glint', () => {
    const dome = shader.slice(shader.indexOf('vec3 sky_dome('), shader.indexOf('}`;'))
    expect(dome.length).toBeGreaterThan(200)
    expect(dome, 'a power of the angle to the sun is a drawn glow').not.toMatch(/pow\(/)
    expect(engine).not.toMatch(/pow\(s,14\.0\)\*0\.07/)
  })
})

describe("the sun's glare", () => {
  const engine = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
  const pass = engine.slice(engine.indexOf('const glare_mat='), engine.indexOf('function glare_render('))
  const linear = (hex: number) => [16, 8, 0].map((shift) => { const c = ((hex >> shift) & 255) / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 })
  const luma = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
  const smooth = (a: number, b: number, x: number) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t) }

  it("lays the CIE's veil over the view for a young pilot, from the sun's own beam: white near the sun, fading over tens of degrees", () => {
    const cie = /vec3 veil=u_beam\*\(10\.0\/\(angle\*angle\*angle\)\+\(5\.0\/\(angle\*angle\)\+([\d.]+)\/angle\)\*([\d.]+)\+([\d.]+)\)\*seen;/.exec(pass)
    expect(cie, 'the CIE 146:2002 glare equation').not.toBeNull()
    const pigment = 0.5, age = 25
    expect(Number(cie![1])).toBeCloseTo(0.1 * pigment, 9)
    expect(Number(cie![2])).toBeCloseTo(1 + (age / 62.5) ** 4, 4)
    expect(Number(cie![3])).toBeCloseTo(0.0025 * pigment, 9)
    const hold = /float angle=max\(degrees\(atan\(length\(cross\(ray,u_sun\)\),dot\(ray,u_sun\)\)\),([\d.]+)\);/.exec(pass)
    expect(hold, 'the angle, held at the disc').not.toBeNull()
    expect(Number(hold![1])).toBeCloseTo((Math.asin(0.004651) * 180) / Math.PI, 2)
    expect(engine).toMatch(/u_beam:ocean_mat\.uniforms\.u_beam,/)
    // Against white paint under the same day light (TOD.day): the beam, and flat ground's light over pi.
    const day = /\tday: {2}\{ sky:[\d.]+, sun:\[([\d.]+),([\d.]+),([\d.]+)\], sunCol:(0x[0-9a-f]+), sunI:([\d.]+),.*?hs:(0x[0-9a-f]+),.*?hi:([\d.]+),\s*ac:(0x[0-9a-f]+),\s*ai:([\d.]+),/.exec(engine)
    expect(day, 'TOD.day').not.toBeNull()
    const [x, y, z] = [1, 2, 3].map((i) => Number(day![i])), up = y / Math.hypot(x, y, z)
    const beam = Number(day![5]) * luma(linear(Number(day![4])))
    const paint = (beam * up + Number(day![7]) * luma(linear(Number(day![6]))) + Number(day![9]) * luma(linear(Number(day![8])))) / Math.PI
    const spread = (t: number) => 10 / t ** 3 + (5 / t ** 2 + Number(cie![1]) / t) * Number(cie![2]) + Number(cie![3])
    const veil = (degrees: number) => (beam * spread(degrees)) / paint
    expect(veil(6)).toBeGreaterThan(0.45)
    expect(veil(6)).toBeLessThan(0.65)
    expect(veil(10)).toBeCloseTo(0.185, 1)
    expect(veil(20)).toBeLessThan(0.06)
    expect(veil(30)).toBeLessThan(0.03)
    expect(spread(10) / (10 / 10 ** 2), 'a third under Holladay at 10 degrees').toBeLessThan(0.75)
  })

  it("is there only while the frame shows the sun's own disc: a cloud, the jet or the canopy across it takes the glare away", () => {
    const m = /float lit\(vec2 p\)\{ vec3 c=texture2D\(u_frame,p\/u_size\)\.rgb\/min\(u_disc\*1\.4,vec3\(1\.0\)\); return smoothstep\(([\d.]+),([\d.]+),min\(c\.r,min\(c\.g,c\.b\)\)\); \}/.exec(pass)
    expect(m, 'lit() in the glare pass').not.toBeNull()
    const lit = (pixel: number[], disc: number) => {
      const expected = linear(disc).map((c) => Math.min(c * 1.4, 1))
      return smooth(Number(m![1]), Number(m![2]), Math.min(...pixel.map((c, i) => c / 255 / expected[i])))
    }
    expect(lit([255, 255, 255], 0xfff3da)).toBe(1)   // the day's disc, unhidden
    expect(lit([218, 245, 255], 0xcdd8f0)).toBe(1)   // the moon's, by its own colour
    expect(lit([163, 166, 179], 0xfff3da)).toBe(0)   // the bright haze beside it
    expect(lit([240, 240, 240], 0xfff3da)).toBeLessThan(0.2)   // a white cloud across it
    expect(pass).toMatch(/float disc=0\.2\*\(lit\(u_at\)\+lit\(u_at\+vec2\(u_radius\*0\.5,0\.0\)\)\+lit\(u_at-vec2\(u_radius\*0\.5,0\.0\)\)\+lit\(u_at\+vec2\(0\.0,u_radius\*0\.5\)\)\+lit\(u_at-vec2\(0\.0,u_radius\*0\.5\)\)\);/)
    expect(engine).toMatch(/u\.u_inside\.value=ahead\?THREE\.MathUtils\.smoothstep\(Math\.min\(x,w-x,y,h-y\),0\.0,u\.u_radius\.value\*3\.0\):0\.0;/)
  })

  it('comes on smoothly as the sun nears the screen: off it, the clouds\' shadow map says whether it is hidden', () => {
    expect(pass).toMatch(/float seen=mix\(clear\(\),disc,u_inside\)\*smoothstep\(-0\.174,0\.174,dot\(u_forward,u_sun\)\);/)
    expect(pass).toMatch(/if\(u_shadow_deck\.z>0\.0\) return 1\.0-cloud_shadow_below\(u_eye\);/)
    expect(pass).toMatch(/if\(u_shadow_patch\.w<=0\.0\) return 1\.0;/)
    expect(pass).toMatch(/return mix\(open,1\.0,smoothstep\(u_shadow_deck\.x,u_shadow_deck\.y,u_eye\.y\)\); \}/)
    // the ground point whose sun line runs through the eye, by the shadow map's own projection
    const ground = 'u_shadow_sun.xz*(world.y/max(u_shadow_sun.y,0.05))'
    expect(engine).toContain(ground)
    expect(pass).toContain(ground.replace(/world/g, 'u_eye'))
    expect(engine).toMatch(/u_sun:\{value:sun_dir\}, u_beam:ocean_mat\.uniforms\.u_beam, u_disc:\{value:col_sundisc\}, \.\.\.cloud_shadow_uniforms,/)
    expect(engine).toMatch(/camera\.getWorldDirection\(u\.u_forward\.value\);/)
  })

  it('adds it in linear light, as the change it makes, over everything drawn', () => {
    expect(pass).toMatch(/vec3 col=frame\+shown\(base\+veil,u_exposure\)-shown\(base,u_exposure\);/)
    expect(pass).toMatch(/vec3 base=unshown\(frame,u_exposure\);/)
    expect(engine).toMatch(/renderer\.render\(scene,cockpit_cam\); renderer\.autoClear=true;\n\t\}\n\tglare_render\(\);\n\}/)   // every frame, last
  })
})
