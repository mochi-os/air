// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  baking,
  between,
  climatology,
  extinction,
  medium,
  sphere,
  AIR,
  FOG,
  GROUND,
  radiance,
  SCATTERING,
  sunlight,
  tables,
  transmittance,
  TRANSMITTANCE,
} from './atmosphere'
import { DEGREE, tangent } from './earth'
import { DAY as MOON_DAY, NIGHT as MOON_NIGHT, OBSERVER } from './moon'
import { moon as sky_moon, seen as sky_seen } from './sky'

// The air over Midway at the day's moment, as the engine bakes it at boot.
const midway = climatology(
  OBSERVER.latitude * DEGREE,
  OBSERVER.longitude * DEGREE,
  MOON_DAY.time
)
const air = tables(midway)
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
    // Rayleigh 8 km, the aerosol's own depth, ozone a 15 km tent: blue loses most
    const up = transmittance(air.transmittance, GROUND, 1)
    expect(up[0]).toBeCloseTo(
      Math.exp(-(5.802e-3 * 8 + 0.65e-3 * 15 + midway)),
      2
    )
    expect(up[2]).toBeCloseTo(
      Math.exp(-(33.1e-3 * 8 + 0.085e-3 * 15 + midway)),
      2
    )
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
  it('is blue away from the sun, paler and brighter toward the horizon, and whitens toward the sun, where the aerosol scatters forward', () => {
    const away = radiance(air, [0, 0.5, -0.866], 10, noon, midway) // 30 degrees up, opposite the sun
    const horizon = radiance(air, [0, 0.02, -1], 10, noon, midway)
    const near = radiance(air, [0, 1, 0], 10, noon, midway) // overhead: 30 degrees from the noon sun
    expect(away[2] / away[0]).toBeGreaterThan(2.5)
    expect(horizon[2] / horizon[0]).toBeLessThan(away[2] / away[0])
    expect(luminance(horizon)).toBeGreaterThan(luminance(away) * 1.5)
    expect(near[2] / near[0]).toBeLessThan((away[2] / away[0]) * 0.7)
  })

  it('darkens overhead as the jet climbs out of the air', () => {
    const low = radiance(air, [0, 1, 0], 100, noon, midway)
    const high = radiance(air, [0, 1, 0], 12000, noon, midway)
    expect(luminance(high)).toBeLessThan(luminance(low) * 0.5)
  })

  it('brightens toward the sun, where the aerosols scatter forward', () => {
    const toward = radiance(air, [0, 0.5, 0.866], 10, noon, midway)
    const away = radiance(air, [0, 0.5, -0.866], 10, noon, midway)
    expect(luminance(toward)).toBeGreaterThan(luminance(away) * 1.5)
  })
})

// The aerosol is measured, its optical depth at 550 nm over the place and month
// (tools/aerosol.py bakes NASA's MERRA-2 into aerosol.ts), and the model holds
// exactly that depth in its column.
describe('the aerosol', () => {
  const at = (latitude: number, longitude: number, time: Date) =>
    climatology(latitude * DEGREE, longitude * DEGREE, time)
  const middle = (year: number, month: number) => {
    const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
    return new Date(Date.UTC(year, month, 1) + (days / 2) * 86400000)
  }

  it('is the optical depth the column holds: its extinction integrates to it from the sea up', () => {
    let column = 0
    for (let h = 0.005; h < 60; h += 0.01)
      column +=
        (medium(h, 0.145).extinction[1] - medium(h, 0).extinction[1]) * 0.01
    expect(column).toBeCloseTo(0.145, 3)
    // in a 2 km scale height: part of it aloft over the marine layer, as in the spring's Asian outflow
    expect(
      medium(0, 0.145).extinction[1] - medium(0, 0).extinction[1]
    ).toBeCloseTo(0.145 / 2, 6)
    expect(
      medium(2, 0.145).extinction[1] - medium(2, 0).extinction[1]
    ).toBeCloseTo((0.145 / 2) * Math.exp(-1), 6)
  })

  it("is MERRA-2's over Midway: March's 0.145 at the day's moment, September's half April's", () => {
    expect(midway).toBeGreaterThan(0.12)
    expect(midway).toBeLessThan(0.17)
    expect(
      at(OBSERVER.latitude, OBSERVER.longitude, middle(2020, 8))
    ).toBeLessThan(
      at(OBSERVER.latitude, OBSERVER.longitude, middle(2020, 3)) * 0.6
    )
  })

  it('lies the right way round on the earth: the Sahara dusty in July, the South Pacific clean', () => {
    expect(at(20, 0, middle(2020, 6))).toBeGreaterThan(0.35)
    expect(at(-30, -130, middle(2020, 6))).toBeLessThan(0.1)
  })

  it("is each month its mean at the month's middle, and halfway between two on the first", () => {
    const april = middle(2021, 3),
      march = middle(2021, 2)
    const first = at(35, 140, new Date(Date.UTC(2021, 3, 1)))
    expect(first).toBeCloseTo((at(35, 140, march) + at(35, 140, april)) / 2, 3)
  })

  it('joins across the antimeridian and the turn of the year', () => {
    expect(at(28, 179.99, MOON_DAY.time)).toBeCloseTo(
      at(28, -179.99, MOON_DAY.time),
      3
    )
    expect(at(30, 150, new Date(Date.UTC(2020, 11, 31, 23)))).toBeCloseTo(
      at(30, 150, new Date(Date.UTC(2021, 0, 1, 1))),
      3
    )
  })

  it('bakes the same tables a slice at a time, a row or a texel each', () => {
    const steps = baking(0.1)
    let count = 0
    let step = steps.next()
    while (!step.done) {
      count++
      step = steps.next()
    }
    expect(count).toBe(TRANSMITTANCE.height + SCATTERING * SCATTERING)
    const whole = tables(0.1)
    expect(step.value.transmittance).toEqual(whole.transmittance)
    expect(step.value.scattering).toEqual(whole.scattering)
  })
})

// What the air between the eye and a point takes, from the transmittance table
// (between) or its integral (extinction, FOG), against the air itself.
describe('the air between two points', () => {
  // The light passed along a ray from r, at mu, for t km, by marching the air.
  const marched = (r: number, mu: number, t: number) => {
    const depth = [0, 0, 0],
      steps = 20000,
      dt = t / steps
    for (let i = 0; i < steps; i++) {
      const s = (i + 0.5) * dt
      const e = medium(
        Math.sqrt(r * r + s * s + 2 * r * mu * s) - GROUND,
        midway
      ).extinction
      for (let c = 0; c < 3; c++) depth[c] += e[c] * dt
    }
    return depth.map((d) => Math.exp(-d))
  }
  const near = (a: number[], b: number[], tolerance: number) =>
    a.forEach((v, c) =>
      expect(
        Math.abs(v - b[c]),
        `channel ${c}: ${v} against ${b[c]}`
      ).toBeLessThan(tolerance)
    )

  it('passes what the air along a rising ray takes', () => {
    near(
      between(air.transmittance, GROUND + 1.4, 0.1, 20),
      marched(GROUND + 1.4, 0.1, 20),
      0.01
    )
    near(
      between(air.transmittance, GROUND + 9, 0.02, 80),
      marched(GROUND + 9, 0.02, 80),
      0.01
    )
  })

  it('passes what the air along a ray down to the sea takes, read from the sea back', () => {
    for (const [height, mu] of [
      [1.4, -0.05],
      [1.4, -0.3],
      [12, -0.1],
    ]) {
      const r = GROUND + height,
        t = sphere(r, mu, GROUND)[0]
      expect(t).toBeGreaterThan(0)
      near(between(air.transmittance, r, mu, t), marched(r, mu, t), 0.015)
    }
  })

  it("has the shaders' at_between do what between() does, line for line", () => {
    const body =
      /vec3 at_between\(float r, float mu, float t\)\{([\s\S]*?)\}`?$/m.exec(
        AIR
      )
    expect(body, 'at_between in AIR').not.toBeNull()
    const js = body![1]
      .replace(/\b(float|bool|vec3) /g, 'let ')
      .replace(/vec3\(([^()]*)\)/g, '$1')
      .replace(/\b(sqrt|max|min)\(/g, 'Math.$1(')
      .replace(/AT_GROUND/g, String(GROUND))
    const channel = (c: number) =>
      new Function('at_transmittance', 'clamp', `return (r, mu, t) => {${js}}`)(
        (r: number, mu: number) => transmittance(air.transmittance, r, mu)[c],
        (v: number, a: number, b: number) => Math.min(Math.max(v, a), b)
      ) as (r: number, mu: number, t: number) => number
    for (const [r, mu, t] of [
      [GROUND + 1.4, 0.1, 20],
      [GROUND + 1.4, -0.05, sphere(GROUND + 1.4, -0.05, GROUND)[0]],
      [GROUND + 12, -0.1, 50],
    ])
      for (let c = 0; c < 3; c++)
        expect(channel(c)(r, mu, t)).toBeCloseTo(
          between(air.transmittance, r, mu, t)[c],
          9
        )
  })

  it('passes what the air along a ray skimming over the horizon takes', () => {
    near(
      between(air.transmittance, GROUND + 1.4, -0.015, 60),
      marched(GROUND + 1.4, -0.015, 60),
      0.015
    )
  })

  it("is extinction(): the mean of the air's extinction between two heights, whatever the slant", () => {
    const luminance3 = (c: number[]) =>
      0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
    for (const [low, high] of [
      [0, 4],
      [1, 2.5],
      [3, 0.5],
    ]) {
      let sum = 0
      const steps = 4000,
        a = Math.min(low, high),
        b = Math.max(low, high)
      for (let i = 0; i < steps; i++)
        sum += luminance3(
          medium(a + ((i + 0.5) * (b - a)) / steps, midway).extinction
        )
      expect(extinction(low, high, midway)).toBeCloseTo(sum / steps, 5)
    }
    expect(extinction(1, 1, midway)).toBeCloseTo(
      luminance3(medium(1, midway).extinction),
      6
    )
  })

  it("has the lit materials' fog (FOG's at_fog) take what extinction() says, number for number", () => {
    const js = FOG.replace(
      'float at_fog(float low, float high, float aerosol){',
      'return (low, high, aerosol) => {'
    )
      .replace(/float /g, 'let ')
      .replace(/\b(max|min|exp)\(/g, 'Math.$1(')
    const fog = new Function(js)() as (
      low: number,
      high: number,
      aerosol: number
    ) => number
    for (const [low, high] of [
      [0, 4],
      [1.4, 0],
      [5, 5],
      [0.2, 0.2005],
    ])
      expect(fog(low, high, midway)).toBeCloseTo(
        extinction(low, high, midway),
        6
      )
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
      /vec3 d=normalize\(v_dir\); vec3 col=sky_dome\(d,normalize\(u_sun\),u_dip,u_ovc,u_ovct,u_ovcw,u_sun_col,u_exposure,max\(length\(fwidth\(d\)\),1\.0e-5\)\);/
    )
    expect(engine).toMatch(
      /vec3 skybg=sky_dome\(ray,uSun,uDip,uOvc,uOvcT,uOvcW,uSunCol,uExposure,blur\);/
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
      /scene\.fog\.color\.setRGB\(r\[0\]\*e,r\[1\]\*e,r\[2\]\*e\); scene\.fog\.density=air_aerosol; \}/
    )
    expect(engine).toMatch(
      /const r=sky_radiance\(air_tables,\[f\.x\*k,0\.03,f\.z\*k\],camera\.position\.y,\[sun_dir\.x,sun_dir\.y,sun_dir\.z\],air_aerosol\)/
    )
  })

  it("hazes the lit materials by the air's own extinction between the eye's height and theirs, over the distance", () => {
    const start = engine.indexOf('{ const chunk=THREE.ShaderChunk,')
    const block = engine.slice(
      start,
      engine.indexOf('\n', engine.indexOf('swap("fog_fragment"', start))
    )
    const chunks: Record<string, string> = { ...THREE.ShaderChunk }
    new Function('THREE', 'AIR_FOG', block)({ ShaderChunk: chunks }, FOG)
    expect(chunks.fog_vertex).toContain(
      'vFogDepth = length( mvPosition.xyz ); vFogHeight = cameraPosition.y + ( vec4( mvPosition.xyz, 0.0 ) * viewMatrix ).y;'
    )
    expect(chunks.fog_pars_vertex).toContain('varying float vFogHeight;')
    expect(chunks.fog_pars_fragment).toContain('varying float vFogHeight;')
    expect(chunks.fog_pars_fragment).toContain(
      'float at_fog(float low, float high, float aerosol)'
    )
    expect(chunks.fog_fragment).toContain(
      'float fogFactor = 1.0 - exp( - at_fog( cameraPosition.y / 1000.0, vFogHeight / 1000.0, fogDensity ) * vFogDepth / 1000.0 );'
    )
    expect(chunks.fog_fragment).toContain(
      'mix( gl_FragColor.rgb, fogColor, fogFactor )'
    ) // the night's patch still finds its line
    expect(THREE.ShaderChunk.fog_fragment).toContain('fogDensity * fogDensity') // the test worked on a copy
    expect(start).toBeLessThan(
      engine.indexOf(
        '.replace("#include <fog_fragment>",THREE.ShaderChunk.fog_fragment'
      )
    ) // swapped before the night's patch reads it
  })

  it('hazes the sea through the air between it and the eye, in linear light, becoming the far sea the dome draws past its rim', () => {
    expect(engine).toMatch(
      /vec3 sight=-V, own=unshown\(col,u_exposure\);\n\t*if\(dist>70000\.0\) own=mix\(own,sea_far\(sight,L\)\*dark,smoothstep\(70000\.0,112000\.0,dist\)\);[^\n]*\n\t*col=shown\(sea_air\(sight,dist\/1000\.0,own,L,u_cloud_flat,u_shadow_hour\),u_exposure\);\n\t*gl_FragColor=vec4\(col,1\.0\); \}`/
    )
    expect(engine).toMatch(
      /return own\*at_between\(AT_GROUND\+u_altitude,d\.y,t\)\+air; \}/
    )
    expect(engine).toMatch(
      /vec3 col=shown\(sea>0\.0\?sea_air\(d,sea,sea_far\(d,sun\),sun,0\.0,1\.0\):at_sky\(d,sun\)\*u_illuminance\+moon,exposure\);/
    )
    expect(engine).not.toMatch(/u_fog_density|seafog|fog\*0\.88/)
  })

  it('hazes the clouds by what the air between the eye and each sample takes, under a sky with sun in it', () => {
    expect(engine).toMatch(
      /float hz=mix\(1\.0-dot\(at_between\(AT_GROUND\+u_altitude,ray\.y,ts\/1000\.0\),vec3\(0\.2126,0\.7152,0\.0722\)\),clamp\(1\.0-exp\(-ts\*ts\*1\.5e-9\),0\.0,0\.985\),uFlat\);/
    )
  })

  it("bakes the air over the place flown in the hour's month: at once for the hour, a slice a frame as the frame moves", () => {
    expect(engine).toMatch(
      /let air_aerosol=aerosol_climatology\(theatre\.frame\.latitude,theatre\.frame\.longitude,MOON_DAY\.time\);\nlet air_tables=atmosphere_tables\(air_aerosol\);/
    )
    expect(engine).toMatch(
      /function air_wanted\(\)\{ return aerosol_climatology\(theatre\.frame\.latitude,theatre\.frame\.longitude,\(tod_preset===TOD\.night\?MOON_NIGHT:MOON_DAY\)\.time\); \}/
    )
    expect(engine).toMatch(
      /function apply_time_of_day\(t\)\{ const p=TOD\[t\]\|\|TOD\.day; tod_preset=p; air_settle\(true\);/
    )
    expect(engine).toMatch(
      /moment_light\(tod_preset\); moon_place\(tod_preset\); air_settle\(false\); \}/
    )
    expect(engine).toMatch(
      /\tair_step\(\);[^\n]*\n\tsky_view_render\(camera\.position\.y\);/
    )
    expect(engine).toMatch(/u_aerosol:\{value:air_aerosol\}/)
  })

  it('holds the aerosol within its tolerance, bakes at once for the hour, and slices a bake over frames that the newest replaces', () => {
    const lift = (name: string) => {
      const start = engine.indexOf(`function ${name}(`)
      expect(start, name).toBeGreaterThan(0)
      const rest = engine.slice(start)
      return rest.slice(0, /\n(?=\S)/.exec(rest.slice(1))!.index + 1)
    }
    const limits = /const AIR_CHANGE=([\d.]+), AIR_SLICE=([\d.]+);/.exec(engine)
    expect(limits).not.toBeNull()
    let want = 0.1,
      clock = 0,
      whole = 0
    const texture = () => ({
      image: { data: null as unknown },
      needsUpdate: false,
    })
    const uniforms = {
      u_aerosol: { value: 0.1 },
      u_transmittance: { value: texture() },
      u_scattering: { value: texture() },
    }
    const baked = (a: number) => ({ transmittance: [a], scattering: [a] })
    const air = new Function(
      'air_wanted',
      'atmosphere_tables',
      'atmosphere_baking',
      'air_halves',
      'atmosphere_uniforms',
      'performance',
      `let air_aerosol=0.1, air_tables=null, air_bake=null; const AIR_CHANGE=${limits![1]}, AIR_SLICE=${limits![2]};
      ${lift('air_apply')}\n${lift('air_settle')}\n${lift('air_step')}
      return { settle:air_settle, step:air_step, aerosol:()=>air_aerosol, baking:()=>air_bake&&air_bake.aerosol }`
    )(
      () => want,
      (a: number) => {
        whole++
        return baked(a)
      },
      function* (a: number) {
        yield
        yield
        yield
        return baked(a)
      },
      (data: number[]) => data,
      uniforms,
      { now: () => (clock += 1) } // each look at the clock a millisecond on: two steps fit a frame's slice
    )
    want = 0.1015 // inside the tolerance: nothing baked
    air.settle(true)
    air.settle(false)
    expect([whole, air.baking()]).toEqual([0, null])
    want = 0.2 // the hour set: at once
    air.settle(true)
    expect([whole, air.aerosol(), uniforms.u_aerosol.value]).toEqual([
      1, 0.2, 0.2,
    ])
    expect([
      uniforms.u_transmittance.value.image.data,
      uniforms.u_scattering.value.needsUpdate,
    ]).toEqual([[0.2], true])
    want = 0.3 // the frame moved on: a slice a frame, three steps over two frames
    air.settle(false)
    air.step()
    expect([air.aerosol(), air.baking()]).toEqual([0.2, 0.3])
    air.settle(false) // the same aerosol asked for again: the bake under way goes on
    air.step()
    expect([air.aerosol(), air.baking()]).toEqual([0.3, null])
    want = 0.4
    air.settle(false)
    air.step()
    want = 0.5 // moved on again before it finished: the newest replaces it, from its start
    air.settle(false)
    air.step()
    expect([air.aerosol(), air.baking()]).toEqual([0.3, 0.5])
    air.step()
    expect([air.aerosol(), air.baking()]).toEqual([0.5, null])
    expect(whole).toBe(1)
    want = 0.5
    air.settle(false)
    want = 0.6
    air.settle(true) // the hour set over a slice under way
    expect([air.aerosol(), air.baking()]).toEqual([0.6, null])
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
    const wind = new Function('CLOUDS', 'cfg', 'DEV_MODE', 'D2R', 'WORLD_WRAP', 'cheat', 'MULTIPLAYER', 'match_wind', `${lift('weather')}\nreturn weather;`)(
      {}, { clouds: 'none' }, false, Math.PI / 180, 250000, () => false, false, () => null)().wind
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
    expect(shader).toMatch(/return col\+suncol\*1\.4\*disc\*u_sun_disc; \}/)   // by night the slot holds the moon's face instead
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
    const cie = /vec3 veil=u_veil\*\(10\.0\/\(angle\*angle\*angle\)\+\(5\.0\/\(angle\*angle\)\+([\d.]+)\/angle\)\*([\d.]+)\+([\d.]+)\)\*seen;/.exec(pass)
    expect(cie, 'the CIE 146:2002 glare equation').not.toBeNull()
    const pigment = 0.5, age = 25
    expect(Number(cie![1])).toBeCloseTo(0.1 * pigment, 9)
    expect(Number(cie![2])).toBeCloseTo(1 + (age / 62.5) ** 4, 4)
    expect(Number(cie![3])).toBeCloseTo(0.0025 * pigment, 9)
    const hold = /float angle=max\(degrees\(atan\(length\(cross\(ray,u_sun\)\),dot\(ray,u_sun\)\)\),([\d.]+)\);/.exec(pass)
    expect(hold, 'the angle, held at the disc').not.toBeNull()
    expect(Number(hold![1])).toBeCloseTo((Math.asin(0.004651) * 180) / Math.PI, 2)
    expect(engine).toContain('else glare_mat.uniforms.u_veil.value.copy(ocean_mat.uniforms.u_beam.value); }')   // by day the veil's source is the sun's own beam
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
    const m = /float lit\(vec2 p\)\{ vec3 f=texture2D\(u_frame,p\/u_size\)\.rgb;\s*if\(u_sun_disc>0\.5\)\{ vec3 c=f\/min\(u_disc\*1\.4,vec3\(1\.0\)\); return smoothstep\(([\d.]+),([\d.]+),min\(c\.r,min\(c\.g,c\.b\)\)\); \}/.exec(pass)
    expect(m, 'lit() in the glare pass').not.toBeNull()
    const lit = (pixel: number[], disc: number) => {
      const expected = linear(disc).map((c) => Math.min(c * 1.4, 1))
      return smooth(Number(m![1]), Number(m![2]), Math.min(...pixel.map((c, i) => c / 255 / expected[i])))
    }
    expect(lit([255, 255, 255], 0xfff3da)).toBe(1)   // the day's disc, unhidden
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
    expect(engine).toMatch(/u_sun:\{value:sun_dir\}, u_disc:\{value:col_sundisc\}, \.\.\.cloud_shadow_uniforms,/)
    expect(engine).toMatch(/camera\.getWorldDirection\(u\.u_forward\.value\);/)
  })

  it('adds it in linear light, as the change it makes, over everything drawn', () => {
    expect(pass).toMatch(/vec3 col=frame\+shown\(base\+veil,u_exposure\)-shown\(base,u_exposure\);/)
    expect(pass).toMatch(/vec3 base=unshown\(frame,u_exposure\);/)
    expect(engine).toMatch(/renderer\.render\(scene,cockpit_cam\); renderer\.autoClear=true;\n\t\}\n\tglare_render\(\);\n\}/)   // every frame, last
  })
})

// The moon (#90) at the hour's fixed moment: its face added to the sky's light before the tone,
// placed and lit by moon_place from moon.ts, with the glare's source set to match.
describe('the moon', () => {
  const engine = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
  const shader = engine.slice(engine.indexOf('const MOON='), engine.indexOf('const sky_mat'))
  function lift(name: string): string {
    const start = engine.indexOf(`function ${name}(`)
    expect(start, `${name} in engine.ts`).toBeGreaterThan(0)
    const rest = engine.slice(start)
    const end = /\n(?=\S)/.exec(rest.slice(1))
    if (!end) return rest
    const cut = end.index + 1
    return rest.startsWith('\n}', cut) ? rest.slice(0, cut + 2) : rest.slice(0, cut)
  }
  // moon_place run against stand-ins for the uniforms it sets
  function place(hour: 'day' | 'night') {
    const gain = /const MOON_NIGHT_GAIN=([\d.]+);/.exec(engine)
    expect(gain, 'MOON_NIGHT_GAIN').not.toBeNull()
    const v = () => new THREE.Vector3()
    const atmosphere = { u_moon: { value: null }, u_moon_dir: { value: v() }, u_moon_right: { value: v() }, u_moon_up: { value: v() }, u_moon_gain: { value: v() }, u_moon_radius: { value: 0 }, u_sun_disc: { value: -1 } }
    const glare = { uniforms: { u_moon_mean: { value: new THREE.Color() }, u_veil: { value: new THREE.Color() } } }
    const ocean = { uniforms: { u_beam: { value: new THREE.Color(2.4, 2.2, 1.9) } } }
    const TOD = { day: { sky: 4.5 }, night: { sky: 0.1 } }
    const sun = new THREE.Vector3(0, 0.866, 0.5).normalize()
    const theatre = { frame: tangent(OBSERVER.latitude * DEGREE, OBSERVER.longitude * DEGREE) } // the engine's frame over where the moments were seen from
    new Function('THREE', 'TOD', 'MOON_DAY', 'MOON_NIGHT', 'MOON_NIGHT_GAIN', 'atmosphere_uniforms', 'moon_faces', 'sun_dir', 'glare_mat', 'ocean_mat', 'sky_moon', 'sky_seen', 'theatre',
      `const _moon_up=new THREE.Vector3();\n${lift('moon_place')}\nmoon_place(TOD.${hour});`)(
      THREE, TOD, MOON_DAY, MOON_NIGHT, Number(gain![1]), atmosphere, { day: 'day face', night: 'night face' }, sun, glare, ocean, sky_moon, sky_seen, theatre)
    return { u: atmosphere, glare: glare.uniforms, beam: ocean.uniforms.u_beam.value, sun, gain: Number(gain![1]) }
  }

  it("adds its light to the sky's before the tone, through the air in front of it", () => {
    expect(shader).toContain(
      'vec3 moon=moon_light(d,blur)*at_transmittance(AT_GROUND+u_altitude,max(d.y,0.0));'
    )
    expect(shader).toContain(
      'vec3 col=shown(sea>0.0?sea_air(d,sea,sea_far(d,sun),sun,0.0,1.0):at_sky(d,sun)*u_illuminance+moon,exposure);'
    )
    expect(shader).toContain(
      'const SKY_SHOWN=`uniform float u_illuminance,u_sun_disc;\n\t`+TONE+`\n\t`+MOON+`'
    )
  })

  it("lays the face on the sky by the image's right and up, a disc its own size, read at the mip a pixel resolves", () => {
    expect(shader).toContain('vec2 p=vec2(dot(d,u_moon_right),dot(d,u_moon_up))/u_moon_radius;')
    expect(shader).toContain('float edge=(1.0-smoothstep(1.0-blur/u_moon_radius,1.0+blur/u_moon_radius,length(p)))*step(0.0,dot(d,u_moon_dir));')
    expect(shader).toContain('float lod=log2(max(blur*${MOON_SIZE}.0/(2.0*u_moon_radius),1.0));')
    expect(shader).toContain('return textureLod(u_moon,clamp(p*0.5+0.5,0.0,1.0),lod).rgb*u_moon_gain*edge; }')
    expect(engine).toContain('t.colorSpace=THREE.SRGBColorSpace;')   // the images are sRGB-encoded linear light
  })

  it("puts the noon's crescent where it stood, at its true light against the sky, beside the sun's disc", () => {
    const { u, glare, beam } = place('day')
    expect(u.u_moon.value).toBe('day face')
    expect(u.u_sun_disc.value).toBe(1)
    expect(u.u_moon_radius.value).toBe(MOON_DAY.radius)
    for (const [got, want] of [[u.u_moon_dir.value, MOON_DAY.direction], [u.u_moon_up.value, MOON_DAY.up], [u.u_moon_right.value, MOON_DAY.right]] as const)
      got.toArray().forEach((c, i) => expect(c).toBeCloseTo(want[i], 5))
    expect(u.u_moon_gain.value.x).toBeCloseTo(MOON_DAY.scale * 4.5, 9)   // radiance per unit sun light, in the sky table's units
    expect(glare.u_veil.value.toArray()).toEqual(beam.toArray())   // the sun's glare, from its beam
  })

  it('puts the full moon in the slot the night is lit from, shown as an adapted eye sees it, with the glare its own light makes', () => {
    const { u, glare, sun, gain } = place('night')
    expect(u.u_moon.value).toBe('night face')
    expect(u.u_sun_disc.value).toBe(0)
    expect(u.u_moon_dir.value.toArray()).toEqual(sun.toArray())
    expect(Math.abs(u.u_moon_up.value.dot(sun))).toBeLessThan(1e-9)   // the frame squared to the slot, 0.1 degrees from the moment's own place
    expect(u.u_moon_right.value.distanceTo(new THREE.Vector3().crossVectors(sun, u.u_moon_up.value))).toBeLessThan(1e-9)
    expect(u.u_moon_gain.value.x).toBe(gain)
    const mean = MOON_NIGHT.mean * gain
    expect(glare.u_moon_mean.value.r).toBeCloseTo(mean, 9)
    expect(glare.u_veil.value.r).toBeCloseTo(mean * Math.PI * MOON_NIGHT.radius ** 2, 12)   // a disc of its shown light over its solid angle
  })

  it('is placed with every hour', () => {
    expect(engine).toContain('atmosphere_uniforms.u_illuminance.value=p.sky; moon_place(p);')
  })

  it('tells the night moon unhidden by its own mean light: its seas pass, a cloud or a jet across it does not', () => {
    const pass = engine.slice(engine.indexOf('const glare_mat='), engine.indexOf('function glare_render('))
    const m = /return smoothstep\(([\d.]+),([\d.]+),dot\(f,vec3\(1\.0\)\)\/dot\(shown\(u_moon_mean,u_exposure\),vec3\(1\.0\)\)\); \}/.exec(pass)
    expect(m, 'the night branch of lit()').not.toBeNull()
    const smooth = (a: number, b: number, x: number) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t) }
    const lit = (ratio: number) => smooth(Number(m![1]), Number(m![2]), ratio)
    expect(lit(1)).toBe(1)
    expect(lit(0.8)).toBe(1)   // its darkest seas, as the tone shows them at the night's gain
    expect(lit(0.35)).toBe(0)   // a moonlit cloud across it
    expect(lit(0.1)).toBe(0)   // a jet or the canopy frame
  })
})
