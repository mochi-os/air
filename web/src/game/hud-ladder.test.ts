// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'

// The pitch ladder rotates about the velocity vector (NATOPS A1-F18AC-NFM-000,
// I-2-102), so the two are drawn from one flight path and the ladder hangs on
// the marker as it is drawn. engine.ts reaches for WebGL at module scope and
// cannot be imported, so it is read as text, as hud-stack.test.ts does. The
// behaviour itself is flown in claude/scripts/air/hudcheck.py parts C and D.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
const conformal = source.slice(source.indexOf('if(flight_symbols){'), source.indexOf('// ---- E bracket'))

describe('the pitch ladder hangs on the velocity vector', () => {
  it('fades the flight path in from the nose rather than switching at a speed', () => {
    // vel_dir switches from the nose to the velocity at 0.5 m/s, and a HUD
    // drawn on it snapped the marker and the ladder sideways as a taxi turn
    // crossed that speed.
    expect(conformal).toMatch(
      /const path=new THREE\.Vector3\(ownship\.velx[^;]*\.addScaledVector\(ownship\.fwd,Math\.max\(0,2-ownship\.speed\)\)/,
    )
    expect(conformal).toMatch(/fpm=proj_dir\(path\)/)
    expect(conformal).not.toMatch(/proj_dir\(ownship\.vel_dir\)/)
  })

  it('keeps the ghost for the NAV cage and not for the limit', () => {
    // I-2-102 item 10: at its limit the velocity vector flashes; the ghost is
    // drawn when the vector is caged and the true position is more than 2° from
    // the caged one. A ghost on every limited marker read as a cage that was
    // never selected.
    expect(source).toMatch(/if\(master==="120c"\)\{[^}]*\} else if\(master==="nav"\) caged=!caged;/)
    expect(conformal).toMatch(/const cage=master==="nav"\?caged:!pa;/)
    expect(conformal).toMatch(/if\(cage\) fpm=\[bore\[0\],truth\[1\]\];/)
    expect(conformal).toMatch(/if\(cage&&Math\.abs\(truth\[0\]-bore\[0\]\)>2\*ppd\) \[ghost,ghost_limited\]=limit\(truth\);/)
    expect(conformal).not.toMatch(/fpm_true/)
  })

  it('cages on the key in NAV, always in the A/A masters, never with the landing symbology', () => {
    // ED manual: "In A/A it is always caged"; the uncage key only toggles NAV.
    const line = /const cage=[^\n]*;/.exec(conformal)?.[0] ?? ''
    const cage = new Function('master', 'pa', 'caged', `${line} return cage;`) as (master: string, pa: boolean, caged: boolean) => boolean
    expect(cage('nav', false, true)).toBe(true)
    expect(cage('nav', false, false)).toBe(false)
    for (const master of ['gun', '9m', '120c']) {
      expect(cage(master, false, false)).toBe(true)
      expect(cage(master, false, true)).toBe(true)
      expect(cage(master, true, true)).toBe(false)
    }
  })

  it('centres the limit, the cage and the boresight symbols on the nose in both first-person views', () => {
    // The HUD view took the screen centre for the boresight, which is where the
    // head looks, and the head holds where it is left: a look 12° up clamped a
    // level flight path to the 10° ring and flashed it (#35).
    const line = /const bore=[^\n]*;/.exec(source)?.[0] ?? ''
    expect(line).toMatch(/^const bore=proj_dir\(ownship\.fwd\)\|\|\[cx,cy\];/)
    const bore = new Function('glass', 'proj_dir', 'ownship', 'cx', 'cy', `${line} return bore;`) as (
      glass: object | null, proj_dir: (d: string) => number[] | null, ownship: { fwd: string }, cx: number, cy: number) => number[]
    const nose = (d: string) => (d === 'nose' ? [300, 500] : null)
    expect(bore(null, nose, { fwd: 'nose' }, 640, 380)).toEqual([300, 500])
    expect(bore({}, nose, { fwd: 'nose' }, 640, 380)).toEqual([300, 500])
    expect(bore(null, () => null, { fwd: 'nose' }, 640, 380)).toEqual([640, 380])
    expect(conformal).toMatch(/const centre=proj_dir\([^\n]*\)\|\|bore;/) // the limit's own centre, the optical centre, is found from the nose
  })

  it('references the ladder to the marker as drawn, limit included', () => {
    // On the unlimited flight path the ladder sat a crab angle's width to the
    // side of a marker held at its limit.
    expect(conformal.indexOf('const marked=')).toBeGreaterThan(conformal.indexOf('fpm_limited=true'))
    expect(conformal).toMatch(/const marked=fpm\?/)
    expect(conformal).toMatch(/const ladFwd=new THREE\.Vector3\(marked\.x,0,marked\.z\)/)
  })
})

// NATOPS 2.13.4.8.11 item 13: the centre of the AOA bracket is the optimum
// approach AOA, and the bracket moves lower with respect to the velocity vector
// as AOA increases and higher as it decreases - a slow jet sees its marker ride
// high in the bracket. The section is run against a recording context.
describe('the AoA bracket rides the velocity vector', () => {
  const bracket = source.slice(source.indexOf('// ---- E bracket'), source.indexOf('// ---- ILS deviation bars'))
  const HH = 900, dpp = HH / 45, fpm = [400, 300]
  const offset = (aoa: number) => {
    const moves = new Function('aoa', `const fpm=[${fpm}], pa=true, HH=${HH}, hs=1, ownship={ grounded:false, aoa };
      const THREE={MathUtils:{clamp:(v,lo,hi)=>Math.min(hi,Math.max(lo,v))}};
      const moves=[]; const hctx=new Proxy({}, { get:(t,k)=>k==='moveTo'?(x,y)=>moves.push([x,y]):()=>{}, set:()=>true });
      ${bracket} return moves;`)(aoa) as [number, number][]
    expect(moves.length).toBe(2) // the bracket's open end, then its centre tick
    return moves[1][1] - fpm[1]
  }

  it('centres on the marker at the optimum approach AOA', () => {
    expect(bracket).toMatch(/^\/\/ ---- E bracket/)
    expect(offset(8.1)).toBeCloseTo(0, 9)
  })

  it('sits lower when slow and higher when fast, a degree of AOA to a degree of the HUD', () => {
    expect(offset(9.3)).toBeCloseTo(1.2 * dpp, 9) // canvas y runs down: positive is lower
    expect(offset(6.9)).toBeCloseTo(-1.2 * dpp, 9)
  })

  it('stops 3.5° off the marker', () => {
    expect(offset(20)).toBeCloseTo(3.5 * dpp, 9)
    expect(offset(0)).toBeCloseTo(-3.5 * dpp, 9)
  })
})

// NATOPS 2.13.4.8.11 item 13: when any two landing gear are down, Mach, g and
// peak g are deleted and the AOA bracket, extended horizon bar and waterline
// appear - the gear alone decides, at any airspeed. The section of draw_hud
// that sets the gate is run for a sequence of states, so any memory it keeps
// from frame to frame carries over as it does in flight.
describe('the landing symbology gate', () => {
  const start = source.indexOf('\tconst ppd=HH/camera.fov;'), end = source.indexOf('\tlet fpm=null;', start)
  const section = source.slice(start, end)
  const gate = (states: { gear: number; speed: number }[]) => new Function('states', `const HH=900, camera={ fov:60 }, trim_law=()=>0;
    let trim_manual=0, hud_pa=false;
    return states.map((s)=>{ const ownship={ gear:s.gear, cas:s.speed, speed:s.speed }; ${section} return pa; });`)(states) as boolean[]

  it('is on whenever the gear is down and locked, at any airspeed', () => {
    expect(section).toMatch(/const pa=/)
    expect(gate([{ gear: 0, speed: 60 }])).toEqual([true])
    expect(gate([{ gear: 0, speed: 130 }])).toEqual([true]) // 253 knots
  })

  it('is off whenever the gear is not down and locked, including just after it comes up', () => {
    expect(gate([{ gear: 1, speed: 60 }])).toEqual([false])
    expect(gate([{ gear: 0.3, speed: 60 }])).toEqual([false]) // in transit
    expect(gate([{ gear: 0, speed: 70 }, { gear: 1, speed: 70 }])).toEqual([true, false]) // a bolter's climb-out
  })
})

// NATOPS 2.13.4.8.11 item 10: the velocity vector is limited to an 8° radius
// circle centred at the HUD optical centre, which item 2 puts 4° below the
// waterline. The code between the flight path and the cage is run with the
// nose along -z and an equidistant projection, so a screen pixel is a degree
// off the nose, y down.
describe('the velocity vector limit', () => {
  const from = conformal.indexOf('\n', conformal.indexOf('if(path.lengthSq()>1e-9)')) + 1
  const section = conformal.slice(from, conformal.indexOf('\tconst cage='))
  const proj_dir = (d: THREE.Vector3) => [Math.atan2(d.x, -d.z) / (Math.PI / 180), -Math.atan2(d.y, Math.hypot(d.x, d.z)) / (Math.PI / 180)]
  const ownship = { fwd: new THREE.Vector3(0, 0, -1), up: new THREE.Vector3(0, 1, 0) }
  const limit = new Function('THREE', 'ownship', 'proj_dir', 'bore', 'ppd', 'D2R', `${section} return limit;`)(
    THREE, ownship, proj_dir, [0, 0], 1, Math.PI / 180) as (p: number[]) => [number[], boolean]

  it('leaves an on-speed approach and a path 11° below the nose alone', () => {
    expect(section).toMatch(/const limit=/)
    expect(limit([0, 8.1])[1]).toBe(false)
    expect(limit([0, 11])[1]).toBe(false)
  })

  it('holds a path 5° above the nose, or 8° to the side of it, on the circle 8° from the optical centre', () => {
    for (const path of [[0, -5], [8, 0], [-8, 0]]) {
      const [held, limited] = limit(path)
      expect(limited, String(path)).toBe(true)
      expect(Math.hypot(held[0], held[1] - 4), String(path)).toBeCloseTo(8, 6)
    }
    expect(limit([0, -5])[0][1]).toBeCloseTo(-4, 6) // straight up from the centre, 4° above the nose
  })
})

// Figure 2-26: the waterline symbol is a W with level wings, the ghost velocity
// vector is the wings and tail without the circle, and the horizon bar, extended
// or not, ends in short downward ticks as the pitch lines end in ticks toward it.
describe('the HUD symbols as figure 2-26 draws them', () => {
  const record = () => {
    const paths: { points: number[][]; end: string; width: number; dash: number }[] = []
    let points: number[][] = [], width = 1, dash = 0
    const arcs: number[][] = []
    const hctx = new Proxy({}, { get: (_, k) => {
      if (k === 'beginPath') return () => { points = [] }
      if (k === 'moveTo' || k === 'lineTo') return (x: number, y: number) => points.push([k === 'moveTo' ? 0 : 1, x, y])
      if (k === 'arc') return (x: number, y: number, r: number) => arcs.push([x, y, r])
      if (k === 'setLineDash') return (d: number[]) => { dash = d.length }
      if (k === 'stroke' || k === 'fill') return () => paths.push({ points, end: String(k), width, dash })
      return () => {}
    }, set: (_, k, v) => { if (k === 'lineWidth') width = v; return true } })
    return { hctx, paths, arcs }
  }
  const section = (from: string, to: string) => {
    const start = source.indexOf(from), end = source.indexOf(to, start)
    if (start < 0 || end < 0) throw new Error(`${from} not found in engine.ts`)
    return source.slice(start, end)
  }

  it('draws the waterline symbol as a W', () => {
    const c = record()
    new Function('hctx', 'pa', 'bore', 'hs', 'GR', section('\t// ---- waterline symbol', '\t// ---- the velocity vector'))(c.hctx, true, [100, 100], 1, 'g')
    const [w] = c.paths
    expect(w.points.map(([, x, y]) => [x, y])).toEqual([[84, 100], [92, 100], [96, 107], [100, 100], [104, 107], [108, 100], [116, 100]])
  })

  it('draws the ghost as the wings and tail without the circle, solid', () => {
    const c = record()
    new Function('hctx', 'fpm', 'ghost', 'fpm_limited', 'ghost_limited', 'cage', 'bore', 'hs', 'GR', 'sim_time', 'hud_ladder',
      `${section('\t// ---- the velocity vector, placed above', '\t// ---- E bracket')}`)(c.hctx, [100, 100], [140, 100], false, false, true, [100, 80], 1, 'g', 0, {})
    expect(c.arcs.map(([x, y]) => [x, y])).toEqual([[100, 100]])
    const ghost = c.paths.find(path => path.points.some(([, x]) => x > 125))
    expect(ghost?.points.map(([, x, y]) => [x, y])).toEqual([[134, 100], [126, 100], [146, 100], [154, 100], [140, 94], [140, 88]])
    expect(ghost?.dash).toBe(0)
  })

  it('ends the horizon bar in short downward ticks, extended or not, and the pitch lines toward the horizon', () => {
    const body = /\n(\t\tconst wide=[\s\S]*?\n\t\thctx\.restore\(\);) \}/.exec(source)?.[1] ?? ''
    expect(body).not.toBe('')
    const ends = (p: number, pa: boolean) => {
      const c = record()
      const D2R = Math.PI / 180
      // the ladder line's ends straight across the screen, so the local frame is the screen's
      const dir_at = (_f: unknown, _r: unknown, across: number, up: number) => [400 - across * 1000, 300 - up * 1000]
      new Function('hctx', 'pitch', 'pa', 'hs', 'GR', 'D2R', 'proj_dir', 'dir_at', 'ladFwd', 'rightH', `let horizon=null; for(const p of [pitch]){ const pr=p*D2R; ${body} }`)(
        c.hctx, p, pa, 1, 'g', D2R, (d: number[]) => d, dir_at, null, null)
      return c.paths.filter(path => path.points.length === 3).map(path => { const [, [, x1, y1], [, x2, y2]] = path.points; return [x2 - x1, y2 - y1] })
    }
    expect(ends(0, false)).toEqual([[0, 9], [0, 9]])
    expect(ends(0, true)).toEqual([[0, 9], [0, 9]])
    expect(ends(5, false)).toEqual([[0, 9], [0, 9]])
    expect(ends(-5, false)).toEqual([[0, -9], [0, -9]])
  })
})

