// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The DDI pages against NATOPS (#24): the EADI (2.13.4.3), the engine monitor
// display (2.1.1.7.6) and the HSI (2.13.4.7). engine.ts cannot be imported
// (WebGL at module scope), so each page's draw is lifted as text and run
// against a recording context with stand-ins for the engine's state.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
function lift(name: string): string {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`${name} not found in engine.ts`)
  const rest = source.slice(start)
  const end = /\n(?=\S)/.exec(rest.slice(1))
  return end ? rest.slice(0, end.index + 1) : rest
}
interface Drawn { text: [string, number, number][]; rects: [number, number, number, number][]; arcs: [number, number, number][] }
function page(name: string, setup: string, display = 'left'): Drawn {
  const run = new Function(`const D2R=Math.PI/180, NM=1852, THREE={MathUtils:{clamp:(v,lo,hi)=>Math.min(hi,Math.max(lo,v))}};
    ${setup}
    ${lift('ddi_legend')} ${lift(name)}
    const text=[], rects=[], arcs=[];
    const x=new Proxy({}, { get:(t,k)=>{ if(k==='fillText') return (s,px,py)=>text.push([String(s),px,py]); if(k==='strokeRect') return (a,b,c,d)=>rects.push([a,b,c,d]); if(k==='arc') return (ax,ay,r)=>arcs.push([ax,ay,r]); if(k==='measureText') return (s)=>({ width:10*String(s).length }); return ()=>{}; }, set:()=>true });
    ${name}(x, ${JSON.stringify(display)}); return { text, rects, arcs };`)
  return run() as Drawn
}
const texts = (d: Drawn) => d.text.map((t) => t[0])
const at = (d: Drawn, s: string) => d.text.find((t) => t[0] === s)?.slice(1)

describe('the EADI page', () => {
  const setup = (yaw: number, source: string) => `const ownship={ cas:100, speed:100, gauges:{ pitch:10*D2R, bank:0, yaw:${yaw}, altitude:1500, vspeed:-480, slip:0 } };
    const alt_radar=false, adi_source=${JSON.stringify(source)}, approach_deviation=()=>null;`
  it('draws the zenith circle and the nadir circle with a cross on the ball', () => {
    const d = page('ddi_adi', setup(0, 'ins'))
    const ppd = 5.2, off = 10 * ppd
    expect(d.arcs.some(([ax, ay, r]) => ax === 0 && Math.abs(ay - (off - 90 * ppd)) < 1e-9 && r === 10)).toBe(true)
    expect(d.arcs.some(([ax, ay, r]) => ax === 0 && Math.abs(ay - (off + 90 * ppd)) < 1e-9 && r === 10)).toBe(true)
  })

  it('puts the turn indicator\'s lower box under an end box at a standard rate turn', () => {
    const cx = 256, cy = 246, R = 186, sy = cy + R + 12
    const level = page('ddi_adi', setup(0, 'ins'))
    expect(level.rects).toContainEqual([cx - 12, sy + 12, 24, 16])
    const standard = page('ddi_adi', setup(3 * Math.PI / 180, 'ins'))
    expect(standard.rects).toContainEqual([cx + 60 - 12, sy + 12, 24, 16])
    expect(standard.rects).toContainEqual([cx + 60 - 12, sy - 8, 24, 16]) // the end box it sits under
    expect(texts(level)).not.toContain('slip') // the slip ball went with it
  })

  it('shows airspeed and altitude boxed at the top left, the source beside and vertical velocity above', () => {
    const d = page('ddi_adi', setup(0, 'ins'))
    expect(at(d, '194')).toEqual([22, 89]) // 100 m/s in knots, in the airspeed box
    expect(at(d, '1500')).toEqual([22, 125])
    expect(at(d, 'BARO')).toEqual([130, 125])
    expect(at(d, '-480')).toEqual([22, 60])
    expect(d.rects).toContainEqual([16, 74, 88, 30])
    expect(d.rects).toContainEqual([16, 110, 104, 30])
  })

  it('offers INS and STBY at the bottom, boxes the source and switches it on a press', () => {
    const d = page('ddi_adi', setup(0, 'stby'))
    expect(texts(d)).toContain('INS')
    expect(texts(d)).toContain('STBY')
    const press = new Function(`let adi_source='stby'; ${lift('adi_press')}
      const a=adi_press(20), s1=adi_source; const b=adi_press(19), s2=adi_source; const c=adi_press(17); return [a,s1,b,s2,c];`)() as [boolean, string, boolean, string, boolean]
    expect(press).toEqual([true, 'ins', true, 'stby', false])
    expect(source).toMatch(/adi:\{draw:ddi_adi,press:adi_press\}/)
    expect(source).toMatch(/adi_source=\(st==="runway"\|\|st==="carrier"\)\?"stby":"ins";/)
  })
})

describe('the engine monitor display', () => {
  it('lists the thirteen EMD rows with the -402 EPE line and derives the rest from the spool', () => {
    const d = page('ddi_eng', `const ownship={ gauges:{ rpmL:99, rpmR:65, egtL:810, egtR:450, flowL:5000, flowR:1000, nozL:0, nozR:100, oilL:100, oilR:55, oat:-5 } };`)
    const shown = texts(d)
    for (const label of ['INLET °C', 'N1 %', 'N2 %', 'EGT °C', 'FF PPH', 'NOZ %', 'OIL PSI', 'THRUST %', 'VIB', 'FUEL °C', 'EPR', 'CDP PSI', 'TDP PSI', 'LEFT EPE', 'RIGHT EPE'])
      expect(shown, label).toContain(label)
    const row = (label: string) => { const y = at(d, label)![1]; return d.text.filter((t) => t[2] === y && t[0] !== label).map((t) => t[0]) }
    expect(row('N1 %')).toEqual(['100', '30']) // MIL on the left, idle on the right
    expect(row('THRUST %')).toEqual(['100', '0'])
    expect(row('EPR')).toEqual(['1.7', '1.0'])
    expect(row('INLET °C')).toEqual(['-5', '-5'])
    expect(row('CDP PSI')).toEqual(['300', '60'])
  })
})

describe('the HSI page', () => {
  const setup = `const ownship={ pos:{x:0,y:1000,z:0}, gauges:{ heading:0, ground:200, track:0, zulu:45296 } };
    const hsi_state={ scale:40, dctr:false, map:false }, CARRIER={ x:18520, z:0 }, island_polygons=[], airports=[], wrap_axis=(v)=>v;
    const ifei_current=()=>({ elapsed:'0:12:34' });`
  it('puts the TACAN data at the upper left, ZTOD lower left, ET lower right and a T under the lubber line', () => {
    const d = page('ddi_hsi', setup)
    expect(at(d, 'TCN 090')).toEqual([24, 92])
    expect(at(d, '10.0 NM  3 MIN')).toEqual([24, 118])
    expect(at(d, 'ZTOD 12:34:56')).toEqual([24, 458])
    expect(at(d, 'ET 0:12:34')).toEqual([488, 458])
    expect(at(d, 'T')).toEqual([256, 52])
  })
})

describe('the gauges the pages read', () => {
  it('carry a smoothed yaw rate, vertical speed, air temperature and zulu seconds', () => {
    expect(source).toMatch(/heading, yaw:yaw_state\.rate, vspeed:fpm, oat:15-0\.0065\*ownship\.pos\.y, zulu:now\.getUTCHours\(\)\*3600\+now\.getUTCMinutes\(\)\*60\+now\.getUTCSeconds\(\),/)
    expect(source).toMatch(/yaw_state\.rate\+=\(d\/\(t-yaw_state\.t\)-yaw_state\.rate\)\*Math\.min\(1,\(t-yaw_state\.t\)\/0\.5\);/)
  })
})
