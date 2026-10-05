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
const data = /\n\t\/\/ ---- target ranging data[\s\S]*?,top\+3\.3\*ppdv\); \}/.exec(source)?.[0] ?? ''
const legend = /\n\t\{ \/\/ The selected weapon and its count[\s\S]*?hctx\.textAlign="left"; \}\n/.exec(source)?.[0] ?? ''

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
    const GR='g', hs=1, THREE={ MathUtils:{ clamp:(v,a,b)=>Math.min(Math.max(v,a),b) } }, pip=[500,400];
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


// The ranging data under the altitude box, as text with its right edge and
// baseline: [text, x, y].
function readouts(world: { master?: string; boxed?: boolean; declutter?: number; rng: number; vc: number }): [string, number, number][] {
  if (!data) throw new Error('target ranging data block not found in engine.ts')
  const run = new Function('w', `const text=[]; const hctx={ fillStyle:'', font:'', textAlign:'', fillText(t,x,y){ text.push([t,x,y]); } };
    const master=w.master??'gun', aa=master!=='nav', boxed=w.boxed===false?null:{}, rej=w.declutter||0, limited=false, lx=584, wly=140, ppdv=20, GR='g', rng=w.rng, vc=w.vc;
    ${data}
    return text;`) as (w: object) => [string, number, number][]
  return run(world)
}
const KNOT = 0.514444, FOOT = 0.3048

describe('the gun ranging data under the altitude box', () => {
  it('names the radar as the source, the closure in knots and the range in feet inside a mile', () => {
    const shown = readouts({ rng: 1600 * FOOT, vc: -10 * KNOT }).map(([t]) => t)
    expect(shown).toEqual(['RDR', '-10V', 'c', '1600 FT'])
    expect(readouts({ rng: 1600 * FOOT, vc: 250 * KNOT }).map(([t]) => t)[1]).toBe('250V') // closing reads without a sign
    expect(readouts({ rng: 1600 * FOOT, vc: -14 * KNOT }).map(([t]) => t)[1]).toBe('-10V') // to the nearest 10 knots
  })

  it('reads the range in miles beyond one', () => {
    expect(readouts({ rng: 2500, vc: 0 }).map(([t]) => t)[3]).toBe('1.3 NM')
    expect(readouts({ rng: 6000 * FOOT, vc: 0 }).map(([t]) => t)[3]).toBe('6000 FT')
  })

  it('stacks under the box, the source at its right edge and the numbers inside it', () => {
    const [rdr, vc, , ft] = readouts({ rng: 500, vc: 0 })
    const right = 584 + 96, bottom = 140 + 30
    expect(rdr[2]).toBeGreaterThan(bottom)
    expect(vc[2]).toBeGreaterThan(rdr[2])
    expect(ft[2]).toBeGreaterThan(vc[2])
    expect(rdr[1]).toBeLessThan(right)
    expect(rdr[1]).toBeGreaterThan(ft[1])
    expect(ft[1]).toBeGreaterThan(584)
  })

  it('shows in every A/A master with a boxed target, not in NAV, and at every reject level (2.13.4.8.1 names it at neither)', () => {
    expect(readouts({ rng: 500, vc: 0, boxed: false })).toEqual([])
    expect(readouts({ rng: 500, vc: 0, master: '9m' }).map(([t]) => t)).toEqual(['RDR', '0V', 'c', '1640 FT'])
    expect(readouts({ rng: 500, vc: 0, master: '120c' })).toHaveLength(4)
    expect(readouts({ rng: 500, vc: 0, master: 'nav' })).toEqual([])
    expect(readouts({ rng: 500, vc: 0, declutter: 1 })).toHaveLength(4)
    expect(readouts({ rng: 500, vc: 0, declutter: 2 })).toHaveLength(4)
  })

  it('is the only range and closure readout: the older miles-and-knots block is gone', () => {
    expect(source).not.toMatch(/\(rng\/1852\)\.toFixed\(1\)\+" NM",lx/)
    expect(source).not.toMatch(/Math\.round\(vc\*1\.94384\)\+" kt"/)
  })
})

// The selected-weapon block as text with its x, baseline and alignment.
function weapon(master: string, guns = false): { align: string; text: [string, number, number, string][]; styles: string[] } {
  if (!legend) throw new Error('selected weapon block not found in engine.ts')
  const run = new Function('master', 'guns', `const text=[], styles=[]; let align='left'; const hctx={ fillStyle:'g', get textAlign(){ return align; }, set textAlign(v){ align=v; }, fillText(t,x,y){ text.push([t,x,y,align]); styles.push(this.fillStyle); } };
    const aa=master!=='nav', cx=500, cy=400, ppdv=20, AM='a', GR='g', amraam_visual=false, input={guns}, cheat=()=>false, translate=(t)=>t;
    const ownship={ rounds:572, msl:2, amraam:6 };
    ${legend}
    return { align, text, styles };`) as (master: string, guns: boolean) => { align: string; text: [string, number, number, string][]; styles: string[] }
  return run(master, guns)
}

describe('the selected weapon block', () => {
  it('centres the gun over its rounds at the bottom of the field', () => {
    const { text, align } = weapon('gun')
    expect(text.map(([t]) => t)).toEqual(['GUN', '572'])
    expect(text.every(([, x]) => x === 500)).toBe(true)
    expect(text.every((row) => row[3] === 'center')).toBe(true)
    expect(text[1][2]).toBeGreaterThan(text[0][2]) // the count on the line below the name
    expect(align).toBe('left') // and the alignment handed back for what follows
  })

  it("puts a missile's count beside its name on one line", () => {
    expect(weapon('9m').text).toEqual([['9M 2', 500, 400 + 7.2 * 20, 'center']])
    expect(weapon('120c').text.map(([t]) => t)).toEqual(['120C 6'])
  })

  it('stays green while the gun fires, as the whole HUD is', () => {
    expect(weapon('gun', true).styles).toEqual(['g', 'g'])
  })

  it('draws nothing in NAV, where the real HUD has no weapon block (figure 2-26)', () => {
    expect(weapon('nav').text).toEqual([])
  })
})

// The breakaway X (#120): one cue for every weapon - the AMRAAM inside Rmin, the
// 9M inside its own minimum, or closing to minimum range within 1.5 s - drawn as
// a large X across the HUD's optical centre, about 7° across, in the symbology's
// green and line (the HUD draws in green only; Chuck's guide p.391 shows it), and
// across the radar attack format's centre too, both flashing ("displayed and
// flashed when the L&S target range is within Rmin", VRS AIM-7 documentation).
describe('the breakaway X', () => {
  const helpers = ['breakaway_shown', 'breakaway'].map((name) => new RegExp(`\\nfunction ${name}\\([^\\n]*\\n`).exec(source)?.[0] ?? '').join('')
  const hud = /\n\t\/\/ ---- the breakaway X[\s\S]*?\n\tif\(breakaway_shown\(\)&&!limited\)\{[^\n]*?\}/.exec(source)?.[0] ?? '' // limited: a mission computer's backup set on the helmet, which has none
  const rdr = /\n\t(if\(breakaway_shown\(\)\)\{ x\.strokeStyle=[^}]*\})/.exec(source)?.[1] ?? ''
  const draw = (code: string, cue: string, time = 0) => {
    const segments: number[][] = [], state: Record<string, unknown> = {}
    let at = [0, 0]
    const canvas = new Proxy(state, { get: (s, k) => {
      if (k === 'moveTo') return (x: number, y: number) => { at = [x, y] }
      if (k === 'lineTo') return (x: number, y: number) => { segments.push([...at, x, y]); at = [x, y] }
      if (k === 'setLineDash') return (d: number[]) => { s.dash = d.length }
      return k in s ? s[k as string] : () => {}
    }, set: (s, k, v) => { s[k as string] = v; return true } })
    new Function('hctx', 'x', 'hud_cue', 'sim_time', 'cx', 'cy', 'ppdv', 'GR', 'AM', `const limited=false; ${helpers} ${code}`)(canvas, canvas, cue, time, 640, 360, 20, 'g', 'a')
    return { segments, state }
  }

  it('is a large green X across the HUD\'s optical centre, about 7° across, in the symbology line', () => {
    expect(helpers).toMatch(/function breakaway_shown[\s\S]*function breakaway\(/)
    expect(hud).not.toBe('')
    const { segments, state } = draw(hud, 'break')
    expect(segments).toEqual([[570, 290, 710, 430], [710, 290, 570, 430]])
    expect(state.strokeStyle).toBe('g')
    expect(state.lineWidth).toBe(1.5)
    expect(state.dash).toBe(0)
  })

  it('flashes twice a second', () => {
    const shown = (time: number) => draw(hud, 'break', time).segments.length > 0
    expect([0, 0.1, 0.24].map(shown)).toEqual([true, true, true])
    expect([0.26, 0.4, 0.49].map(shown)).toEqual([false, false, false])
    expect(shown(0.5)).toBe(true)
  })

  it('shows only with the break cue', () => {
    for (const cue of ['', 'steady', 'flash', '9m', 'gun', 'tone']) expect(draw(hud, cue).segments, cue).toEqual([])
  })

  it('crosses the radar attack format\'s centre with it, flashing in step', () => {
    expect(rdr).not.toBe('')
    const start = source.indexOf('function ddi_rdr('), end = source.indexOf('\nfunction ', start + 1)
    expect(source.slice(start, end)).toContain(rdr.trim())
    const { segments, state } = draw(rdr, 'break')
    expect(segments).toEqual([[191, 185, 321, 315], [321, 185, 191, 315]])
    expect(state.strokeStyle).toBe('#39e07a')
    expect(draw(rdr, 'break', 0.3).segments).toEqual([])
    expect(draw(rdr, '').segments).toEqual([])
  })

  it('takes the cue from every weapon: the AMRAAM zone draws first, the 9M and the closure breakaway before the cluster', () => {
    const before = (line: string | RegExp, mark: string) => { // the line is there, and ahead of the mark
      const at = typeof line === 'string' ? source.indexOf(line) : source.search(line)
      expect(at, String(line)).toBeGreaterThan(0)
      expect(at, String(line)).toBeLessThan(source.indexOf(mark))
    }
    before(/\n\tif\(master==="120c"&&keep\("NIRD CIRCLE",\d\)&&!limited\) hud_launch_zone\(hctx,GR,cx,cy,ppdv,ax,lx,axes\);/, '\t// ---- the breakaway X')
    before('\tif(brk) hud_cue="break";', '\t// ---- instrument furniture (#133)')
    before('hud_cue=(cue==="steady"||cue==="flash")?"9m":(cue==="break"?"break":"tone");', '\t// ---- instrument furniture (#133)')
    expect(source).toMatch(/const cue=shoot_cue\(z\);\n\tif\(cue\) hud_cue=cue;/)
  })

  it('is the only X: no weapon draws its own', () => {
    expect(source).not.toMatch(/breakaway X[^\n]*\n[^\n]*const R=2\.2\*ppd/)
    expect(source).not.toMatch(/inside the heater's own minimum: the breakaway X/)
    expect(source).not.toMatch(/const r=28;   \/\/ breakaway X/)
    expect(source.match(/(?<!function )breakaway\((hctx|x),/g)?.length).toBe(2)
  })

  it('keeps the AMRAAM\'s SHOOT off while it is inside Rmin', () => {
    const line = /\n\tif\(cue&&cue!=="break"&&\(cue==="steady"\|\|\(sim_time\*4\)%2<1\)\)\{[^\n]*\n[^\n]*\n/.exec(source)?.[0] ?? ''
    expect(line).not.toBe('')
    const shoot = (cue: string) => new Function('cue', `const text=[]; let hud_shoot=false; const sim_time=0, GR='g', cx=0, cy=0, ppdv=20;
      const hctx={ fillStyle:'', font:'', textAlign:'', fillText(t){ text.push(t); } }; ${line} return text;`)(cue) as string[]
    expect(shoot('break')).toEqual([])
    expect(shoot('steady')).toEqual(['SHOOT'])
  })
})
