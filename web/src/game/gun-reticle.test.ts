// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The gun director reticle is the real 50 mil circle, sized in degrees so the
// zoom scales it with the ladder, and its own rim carries the range analog.
// engine.ts cannot be imported (WebGL at module scope), so the director block
// is read as text and drawn into a recording canvas, as hud-status.test.ts
// runs the status stack.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
const block = /\n\t\t\tif\(pip\)\{ hctx\.strokeStyle=GR;[\s\S]*?hctx\.fillText\("SHOOT",pip\[0\],[^\n]*\); \} \}/.exec(source)?.[0] ?? ''

interface Arc { x: number; y: number; r: number; start: number; end: number; fill: boolean }
interface Line { from: [number, number]; to: [number, number] }
interface Drawn { arcs: Arc[]; lines: Line[]; text: [string, number, number][] }

// Draws the director at pixels-per-degree ppd with the target at range metres,
// shootable when the solution says so, and returns what reached the canvas.
function director(ppd: number, range: number, shoot = true): Drawn {
  if (!block) throw new Error('director block not found in engine.ts')
  const run = new Function('ppd', 'rng', 'shoot', `const arcs=[], lines=[], text=[]; let pen=null, path=[];
    const hctx={ strokeStyle:'', fillStyle:'', lineWidth:1, font:'', textAlign:'', setLineDash(){},
      beginPath(){ path=[]; }, moveTo(x,y){ pen=[x,y]; }, lineTo(x,y){ lines.push({from:pen, to:[x,y]}); pen=[x,y]; },
      arc(x,y,r,start,end){ path.push({x,y,r,start,end}); }, stroke(){ for(const a of path) arcs.push({...a, fill:false}); path=[]; },
      fill(){ for(const a of path) arcs.push({...a, fill:true}); path=[]; }, fillText(t,x,y){ text.push([t,x,y]); } };
    const GR='g', THREE={ MathUtils:{ clamp:(v,a,b)=>Math.min(Math.max(v,a),b) } }, pip=[500,400];
    const impact={x:0,y:0,z:0}, boxed={pos:{x:shoot?0:100,y:0,z:0}}, wrap_axis=(v)=>v, brk=false, weapons_hold=false, ownship={rounds:500}, sim_time=0;
    let hud_cue='';
    ${block}
    return { arcs, lines, text, cue:hud_cue };`) as (ppd: number, rng: number, shoot: boolean) => Drawn
  return run(ppd, range, shoot)
}
const full = (a: Arc) => Math.abs(a.end - a.start - Math.PI * 2) < 1e-9

describe('the gun director reticle', () => {
  it('is the 50 mil circle, sized in degrees', () => {
    for (const ppd of [12.5, 20, 40]) {
      const rings = director(ppd, 500).arcs.filter((a) => !a.fill && full(a))
      expect(rings, `ppd ${ppd}`).toHaveLength(1)
      expect(rings[0].r).toBeCloseTo(1.43 * ppd, 6)
    }
  })

  it('carries the range analog on its own rim, unwinding from 12 o\'clock with the range', () => {
    const ring = director(20, 500).arcs.find((a) => !a.fill && full(a)) as Arc
    const analog = director(20, 500).arcs.find((a) => !a.fill && !full(a)) as Arc
    expect(analog.r).toBe(ring.r)
    expect(analog.start).toBeCloseTo(-Math.PI / 2, 9)
    expect(analog.end - analog.start).toBeCloseTo((500 / 914) * Math.PI * 2, 9)
    expect(director(20, 3000).arcs.filter((a) => !a.fill && full(a))).toHaveLength(2) // past full scale the analog pegs as a second full ring on the rim
  })

  it('crosses the rim with the 1,000 ft tick', () => {
    const { arcs, lines } = director(20, 500)
    const R = (arcs.find((a) => !a.fill && full(a)) as Arc).r
    const tick = lines.find((l) => Math.hypot(l.from[0] - 500, l.from[1] - 400) < R && Math.hypot(l.to[0] - 500, l.to[1] - 400) > R)
    expect(tick).toBeDefined()
    const angle = Math.atan2(tick!.to[1] - 400, tick!.to[0] - 500)
    expect(angle).toBeCloseTo(-Math.PI / 2 + (305 / 914) * Math.PI * 2, 9)
  })

  it('has a centre pipper flanked by short dashes at 3 and 9 o\'clock', () => {
    const { arcs, lines } = director(20, 500)
    const dot = arcs.find((a) => a.fill) as Arc
    expect(dot.r).toBeLessThan(0.2 * 20)
    const level = lines.filter((l) => l.from[1] === 400 && l.to[1] === 400)
    expect(level).toHaveLength(2)
    expect(level.map((l) => Math.sign(l.from[0] - 500)).sort()).toEqual([-1, 1])
    for (const l of level) expect(Math.abs(l.to[0] - l.from[0])).toBeCloseTo(0.15 * 20, 9)
  })

  it('lifts the SHOOT cue clear of the circle', () => {
    const { arcs, text } = director(20, 500)
    const R = (arcs.find((a) => !a.fill && full(a)) as Arc).r
    expect(text).toHaveLength(1)
    expect(text[0][0]).toBe('SHOOT')
    expect(400 - text[0][2]).toBeGreaterThan(R)
    expect(director(20, 500, false).text).toHaveLength(0)
  })
})
