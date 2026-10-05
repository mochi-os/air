// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { atc_step, cruise_step, ATC_ONSPEED, ATC_LEAST, ATC_MOST } from './atc'

// A toy backside-of-the-power-curve surrogate: thrust above the drag-balance
// point accelerates the jet, and alpha falls as speed rises (level flight at
// fixed lift). Crude, but it has the essential property the law must respect:
// MORE power LOWERS alpha. Constants chosen for on-speed at throttle 0.55.
function simulate(
  alpha0: number,
  seconds: number
): { alpha: number; throttle: number; overshoot: number } {
  const dt = 1 / 60
  let speed = 70 - (alpha0 - ATC_ONSPEED) * 2.5 // slow when alpha high
  let throttle = 0.4
  let alpha = alpha0
  let previous = alpha0
  let overshoot = 0
  for (let t = 0; t < seconds; t += dt) {
    const rate = (alpha - previous) / dt
    previous = alpha
    throttle = atc_step(throttle, alpha, rate, dt)
    const accel = (throttle - 0.55) * 3.5 - (speed - 70) * 0.05 // thrust minus speed-stable drag trim
    speed += accel * dt
    alpha = ATC_ONSPEED - (speed - 70) / 2.5 // level-flight alpha falls with speed
    overshoot = Math.max(overshoot, Math.abs(alpha - ATC_ONSPEED))
  }
  return { alpha, throttle, overshoot }
}

describe('atc_step', () => {
  it('adds power when slow (alpha above on-speed) — the backside sign', () => {
    expect(atc_step(0.5, ATC_ONSPEED + 2, 0, 1 / 60)).toBeGreaterThan(0.5)
  })

  it('reduces power when fast (alpha below on-speed)', () => {
    expect(atc_step(0.5, ATC_ONSPEED - 2, 0, 1 / 60)).toBeLessThan(0.5)
  })

  it('damps against a rising alpha it is already correcting', () => {
    // alpha above on-speed but falling fast: the rate term backs the correction off
    const withRate = atc_step(0.5, ATC_ONSPEED + 1, -4, 1 / 60)
    const withoutRate = atc_step(0.5, ATC_ONSPEED + 1, 0, 1 / 60)
    expect(withRate).toBeLessThan(withoutRate)
  })

  it('clamps to the spool floor and the MIL ceiling — never afterburner', () => {
    expect(atc_step(1.0, ATC_ONSPEED + 5, 0, 1)).toBe(ATC_MOST)
    expect(atc_step(0.0, ATC_ONSPEED - 5, 0, 1)).toBe(ATC_LEAST)
  })

  it('converges a slow entry onto on-speed without divergent oscillation', () => {
    const r = simulate(ATC_ONSPEED + 2.5, 30)
    expect(Math.abs(r.alpha - ATC_ONSPEED)).toBeLessThan(0.3)
  })

  it('converges a fast entry onto on-speed', () => {
    const r = simulate(ATC_ONSPEED - 2.5, 30)
    expect(Math.abs(r.alpha - ATC_ONSPEED)).toBeLessThan(0.3)
  })

  it('spike-limits the rate input so a gust cannot slam the levers', () => {
    const calm = atc_step(0.5, ATC_ONSPEED, 10, 1 / 60)
    const spike = atc_step(0.5, ATC_ONSPEED, 500, 1 / 60)
    expect(spike).toBe(calm)
  })
})

// A toy cruise plant: thrust past the drag balance accelerates the jet, drag rising
// with speed; about 14 kt/s for the full throttle range, and the engines' spool
// lag, a first-order second. Balanced at 300 kt on throttle 0.6.
function cruise(entry: number, target: number, seconds: number): { speed: number; overshoot: number } {
  const dt = 1 / 60
  let speed = entry, throttle = 0.6, thrust = 0.6, last = entry, overshoot = 0
  for (let t = 0; t < seconds; t += dt) {
    const accel = (speed - last) / dt
    last = speed
    throttle = cruise_step(throttle, speed, target, accel, dt)
    thrust += (throttle - thrust) * dt / 1.0
    speed += ((thrust - 0.6) * 14 - (speed - 300) * 0.02) * dt
    if (Math.sign(target - entry) !== Math.sign(target - speed)) overshoot = Math.max(overshoot, Math.abs(speed - target))
  }
  return { speed, overshoot }
}

describe('cruise_step', () => {
  it('adds power below the engaged airspeed and takes it off above', () => {
    expect(cruise_step(0.5, 290, 300, 0, 1 / 60)).toBeGreaterThan(0.5)
    expect(cruise_step(0.5, 310, 300, 0, 1 / 60)).toBeLessThan(0.5)
  })

  it('damps against an acceleration already closing the error', () => {
    expect(cruise_step(0.5, 290, 300, 4, 1 / 60)).toBeLessThan(cruise_step(0.5, 290, 300, 0, 1 / 60))
  })

  it('clamps to the spool floor and the MIL ceiling, and spike-limits the acceleration', () => {
    expect(cruise_step(1.0, 200, 300, 0, 1)).toBe(ATC_MOST)
    expect(cruise_step(0.0, 400, 300, 0, 1)).toBe(ATC_LEAST)
    expect(cruise_step(0.5, 300, 300, 500, 1 / 60)).toBe(cruise_step(0.5, 300, 300, 20, 1 / 60))
  })

  it('holds the engaged airspeed from either side without a divergent swing', () => {
    for (const entry of [280, 320]) {
      const r = cruise(entry, 300, 60)
      expect(Math.abs(r.speed - 300), `${entry}`).toBeLessThan(1)
      expect(r.overshoot, `${entry}`).toBeLessThan(5)
    }
  })
})

// The HUD's ATC advisory (NATOPS 2.1.2, 2.13.4.8.15, figure 2-26): green, above
// the distance display, while ATC is engaged; flashing for 10 seconds when ATC
// drops out by any means but its switch, or when an engage is refused. engine.ts
// cannot be imported (WebGL at module scope), so its lines are read as text.
describe('the ATC advisory', () => {
  const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
  const press = /\n\tcase "atc":[^\n]*\n[^\n]*break;[^\n]*\n/.exec(source)?.[0] ?? ''
  const drop = /\n\tif\(atc_on\)\{[^\n]*\n[\s\S]*?\n\t\}\n/.exec(source)?.[0] ?? ''
  const engage = /\nconst TEF_FULL=[^\n]*\n(?:[^\n]*\n)*?function atc_engage\(\)\{[^\n]*\n[^\n]*\n[^\n]*\n/.exec(source)?.[0] ?? ''
  const draw = /\n\thctx\.font="13px 'Hornet Display', monospace"; hctx\.textAlign="left"; hctx\.fillStyle=GR;\n\tif\(limited\)\{\}\n\telse if\(atc_on[^\n]*\n/.exec(source)?.[0] ?? '' // limited: a mission computer's backup set on the helmet, which has no ATC

  // The engage: the FLAP switch (flap_select: 0 AUTO, 1 HALF, 2 FULL) and the trailing-edge flaps' travel, degrees of the
  // flight core's angle: 26 at FULL where the jet has 45, 17.3 at HALF where it has 30.
  interface Jet { on?: boolean; flap?: number; tef?: number; grounded?: boolean; speed?: number; gearTarget?: number }
  const switched = (j: Jet) =>
    new Function('j', `let atc_on=!!j.on, atc_flash=5, atc_alpha=0, atc_speed=null, atc_last=0; const sim_time=50, D2R=Math.PI/180, STATE={ flap:0 }, last_out=[(j.tef??26)*D2R];
      const flap_select=j.flap??1, ownship={ gearTarget:j.gearTarget??0, aoa:8, speed:j.speed??150 }, on_ground=()=>!!j.grounded, pad_levers={};
      ${engage} switch("atc"){ ${press} } return { on:atc_on, flash:atc_flash, speed:atc_speed };`)(j) as { on: boolean; flash: number; speed: number | null }

  it('is silent when the switch disengages it, and clears on engage', () => {
    expect(press).not.toBe('')
    expect(switched({ on: true })).toMatchObject({ on: false, flash: -Infinity })
    expect(switched({})).toMatchObject({ on: true, flash: -Infinity })
  })

  it('engages approach mode with the FLAP switch at HALF or FULL and the flaps down 27°, gear up or down (2.1.2.1)', () => {
    for (const [flap, tef] of [[1, 17.3], [2, 26]]) expect(switched({ flap, tef }), `${flap}`).toEqual({ on: true, flash: -Infinity, speed: null }) // the core's HALF and FULL: the jet's 30° and 45°
    expect(switched({ flap: 1, tef: 17.3, gearTarget: 1 })).toMatchObject({ on: true, speed: null }) // the gear is no condition
    expect(switched({ flap: 2, tef: 15.7 })).toMatchObject({ on: true }); expect(switched({ flap: 2, tef: 15.5 })).toMatchObject({ on: false }) // the jet's 27° is 15.6° of the core's
  })

  it('engages cruise mode with the FLAP switch at AUTO, holding the true airspeed of the moment (2.1.2.2)', () => {
    const r = switched({ flap: 0, tef: 0, speed: 154.3 })
    expect(r.on).toBe(true)
    expect(r.speed).toBeCloseTo(154.3 * 1.944, 6)
  })

  it('flashes when an engage is refused: the flaps short of 27° with HALF or FULL, or on the deck', () => {
    expect(switched({ flap: 1, tef: 12 })).toMatchObject({ on: false, flash: 50 })
    expect(switched({ flap: 1, tef: 17.3, grounded: true })).toMatchObject({ on: false, flash: 50 })
    expect(switched({ flap: 0, grounded: true })).toMatchObject({ on: false, flash: 50 })
  })

  // The drop-outs, run against a jet in either mode: approach (speed null) or cruise.
  interface Flight { cruise?: boolean; flap?: number; tef?: number; bank?: number; grounded?: boolean; throttling?: boolean; gearTarget?: number }
  const flown = (f: Flight) =>
    new Function('f', `let atc_on=true, atc_flash=-Infinity, atc_alpha=8, atc_speed=f.cruise?300:null, atc_last=300; const sim_time=70, dt=1/60, D2R=Math.PI/180, STATE={ flap:0 }, TEF_DOWN=26*D2R*27/45;
      const last_out=[(f.tef??26)*D2R], flap_select=f.flap??(f.cruise?0:1), throttling=!!f.throttling;
      const ownship={ gearTarget:f.gearTarget??0, aoa:8, throttle:0.5, speed:300/1.944, gauges:{ bank:(f.bank??0)*D2R } }, on_ground=()=>!!f.grounded, pad_levers={};
      let stepped=""; const atc_step=(t)=>{ stepped="approach"; return t; }, cruise_step=(t)=>{ stepped="cruise"; return t; };
      ${drop} return { on:atc_on, flash:atc_flash, stepped };`)(f) as { on: boolean; flash: number; stepped: string }

  it('flies each mode with its own law while nothing drops it out, the gear up included', () => {
    expect(drop).not.toBe('')
    expect(flown({})).toEqual({ on: true, flash: -Infinity, stepped: 'approach' })
    expect(flown({ gearTarget: 1 })).toEqual({ on: true, flash: -Infinity, stepped: 'approach' }) // no gear drop-out
    expect(flown({ cruise: true, tef: 0 })).toEqual({ on: true, flash: -Infinity, stepped: 'cruise' })
    expect(flown({ cruise: true, tef: 0, bank: 80 })).toMatchObject({ on: true }) // bank is approach mode's
  })

  it('drops out and flashes on the FLAP switch moving between AUTO and HALF or FULL, either way', () => {
    expect(flown({ flap: 0 })).toEqual({ on: false, flash: 70, stepped: '' })
    expect(flown({ cruise: true, flap: 1 })).toEqual({ on: false, flash: 70, stepped: '' })
    expect(flown({ flap: 2 })).toMatchObject({ on: true }) // HALF to FULL is no change of mode
  })

  it('drops approach mode on the flaps short of 27° and on bank past 70° (2.1.2.1)', () => {
    expect(flown({ tef: 15 })).toMatchObject({ on: false, flash: 70 }); expect(flown({ tef: 17.3 })).toMatchObject({ on: true })
    expect(flown({ bank: 71 })).toMatchObject({ on: false, flash: 70 })
    expect(flown({ bank: -71 })).toMatchObject({ on: false, flash: 70 })
    expect(flown({ bank: 69 })).toMatchObject({ on: true })
  })

  it('drops either mode on a throttle input and on the deck', () => {
    for (const cruise of [false, true]) {
      expect(flown({ cruise, tef: cruise ? 0 : 26, throttling: true }), `${cruise}`).toMatchObject({ on: false, flash: 70 })
      expect(flown({ cruise, tef: cruise ? 0 : 26, grounded: true }), `${cruise}`).toMatchObject({ on: false, flash: 70 })
    }
  })

  it('makes the AUTO ball call in approach mode only, and clears cruise at a spawn', () => {
    expect(source).toMatch(/\(atc_on&&atc_speed===null\?" "\+translate\("AUTO"\):""\)/)
    expect(source).toMatch(/atc_on=false; atc_flash=-Infinity; atc_speed=null;/)
  })

  const shown = (on: boolean, flash: number, time: number) => {
    const drawn: { text: string; x: number; y: number; style: string }[] = []
    let style = ''
    const hctx = new Proxy({}, { get: (_, k) => k === 'fillText' ? (text: string, x: number, y: number) => drawn.push({ text, x, y, style }) : () => {},
      set: (_, k, v) => { if (k === 'fillStyle') style = v; return true } })
    new Function('hctx', 'atc_on', 'atc_flash', 'sim_time', 'GR', 'lx', 'cy', 'ppdv', 'const limited=false; ' + draw)(hctx, on, flash, time, 'green', 700, 400, 16)
    return drawn
  }

  it('is green, one line above the distance display', () => {
    expect(draw).not.toBe('')
    expect(shown(true, -Infinity, 3)).toEqual([{ text: 'ATC', x: 700, y: 400 + 7.2 * 16 - 17, style: 'green' }])
    expect(source).not.toMatch(/hctx\.fillStyle=AM; hctx\.fillText\("ATC"/)
  })

  it('flashes twice a second for 10 seconds, then goes', () => {
    let on = 0, frames = 0
    for (let time = 100; time < 110; time += 0.05) { frames++; if (shown(false, 100, time).length) on++ }
    expect(on / frames).toBeGreaterThan(0.4)
    expect(on / frames).toBeLessThan(0.6)
    for (const time of [110.1, 112, 130]) expect(shown(false, 100, time), `${time}`).toEqual([])
    expect(shown(false, -Infinity, 3)).toEqual([])
  })

  it('starts a fresh jet with no flash pending', () => {
    expect(source).toMatch(/ownship\.wire=0; atc_on=false; atc_flash=-Infinity;/)
  })
})

