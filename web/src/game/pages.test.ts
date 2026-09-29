// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'

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
interface Drawn { text: [string, number, number][]; rects: [number, number, number, number][]; arcs: [number, number, number][]; rotate: number[]; moves: [number, number][]; styled: [string, number, number][]; lines: [number, number, number, number, string][]; fills: [number, number, number, number, string][]; fonts: [string, string][] }
function page(name: string, setup: string, display = 'left'): Drawn {
  const run = new Function(`const D2R=Math.PI/180, NM=1852, THREE={MathUtils:{clamp:(v,lo,hi)=>Math.min(hi,Math.max(lo,v))}};
    ${setup}
    ${lift('ddi_legend')} ${lift(name)}
    const text=[], rects=[], arcs=[], rotate=[], moves=[], styled=[], lines=[], fills=[], fonts=[]; let style='', fill='', font='', at=[0,0];
    const x=new Proxy({}, { get:(t,k)=>{ if(k==='fillText') return (s,px,py)=>{ text.push([String(s),px,py]); fonts.push([String(s),font]); }; if(k==='strokeRect') return (a,b,c,d)=>rects.push([a,b,c,d]); if(k==='fillRect') return (a,b,c,d)=>fills.push([a,b,c,d,fill]); if(k==='arc') return (ax,ay,r)=>arcs.push([ax,ay,r]); if(k==='rotate') return (a)=>rotate.push(a); if(k==='moveTo') return (mx,my)=>{ moves.push([mx,my]); styled.push([style,mx,my]); at=[mx,my]; }; if(k==='lineTo') return (lx,ly)=>{ lines.push([at[0],at[1],lx,ly,style]); at=[lx,ly]; }; if(k==='measureText') return (s)=>({ width:10*String(s).length }); return ()=>{}; }, set:(t,k,v)=>{ if(k==='strokeStyle') style=v; if(k==='fillStyle') fill=v; if(k==='font') font=v; return true; } });
    ${name}(x, ${JSON.stringify(display)}); return { text, rects, arcs, rotate, moves, styled, lines, fills, fonts };`)
  return run() as Drawn
}
// The bank gauge every attitude display reads, lifted from the gauges block and
// evaluated for a jet facing +x rolled right: the right wing (+z) dips.
function bank_right(degrees: number): number {
  const expression = /\n\township\.gauges=\{[\s\S]*?\n\t\tbank:(.*?),(?:\s*\/\/[^\n]*)?\n/.exec(source)?.[1] ?? ''
  if (!expression) throw new Error('the bank gauge not found in engine.ts')
  const r = degrees * Math.PI / 180
  const ownship = { right: { x: 0, y: -Math.sin(r), z: Math.cos(r) }, up: { x: 0, y: Math.cos(r), z: Math.sin(r) } }
  return new Function('ownship', `return ${expression}`)(ownship) as number
}
const texts = (d: Drawn) => d.text.map((t) => t[0])
const at = (d: Drawn, s: string) => d.text.find((t) => t[0] === s)?.slice(1)

// The EADI against figures 2-23 and 24-22 and 2.13.4.3. The ball's own marks are
// recorded in its rotated frame (origin at the ball's centre), the rest on the page.
interface Eadi { pitch?: number; bank?: number; yaw?: number; source?: string; reading?: string; time?: number; deviation?: string }
function eadi(o: Eadi = {}, display = 'left'): Drawn {
  return page('ddi_adi', `const ownship={ cas:100, speed:100, gauges:{ pitch:${o.pitch ?? 10}*D2R, bank:${o.bank ?? 0}, yaw:${o.yaw ?? 0}, vspeed:-480 } };
    const adi_source=${JSON.stringify(o.source ?? 'ins')}, sim_time=${o.time ?? 0}, altitude_reading=()=>(${o.reading ?? '{ feet:1500, radar:false, fallback:false }'}), approach_deviation=()=>(${o.deviation ?? 'null'});`, display)
}
describe('the EADI page', () => {
  const cx = 256, cy = 240, R = 176, T = 10, ppd = 5.2
  it('draws the zenith circle and the nadir circle with a cross on the ball', () => {
    const d = eadi()
    const off = 10 * ppd
    expect(d.arcs.some(([ax, ay, r]) => ax === 0 && Math.abs(ay - (off - 90 * ppd)) < 1e-9 && r === 10)).toBe(true)
    expect(d.arcs.some(([ax, ay, r]) => ax === 0 && Math.abs(ay - (off + 90 * ppd)) < 1e-9 && r === 10)).toBe(true)
  })

  it('marks every 10° to 80° each way, crosses above the horizon and bars at and below it', () => {
    const d = eadi({ pitch: 0 })
    const crosses = d.lines.filter(([x0, y0, x1, y1]) => x0 === -9 && x1 === 9 && y0 === y1).map((l) => l[1])
    expect(crosses).toEqual([80, 70, 60, 50, 40, 30, 20, 10].map((n) => 0 - n * ppd))
    const bars = d.fills.filter(([fx, , w, h]) => fx === -10 && w === 20 && h === 6).map((f) => f[1] + 3)
    expect(bars).toEqual([0, -10, -20, -30, -40, -50, -60, -70, -80].map((n) => 0 - n * ppd))
    for (const n of [10, 20, 30, 40, 50, 60, 70, 80]) {
      expect(d.text).toContainEqual([String(n), 0, -n * ppd - 22]) // the figure on the zenith side of its mark
      expect(d.text).toContainEqual([String(n), 0, n * ppd - 22])
    }
    expect(d.text).toContainEqual(['0', 0, -22])
    expect(texts(d)).not.toContain('90')
  })

  it('keeps the ladder at steep pitch, and the sky over the ball at the vertical', () => {
    const d = eadi({ pitch: 60 })
    expect(d.lines).toContainEqual([-9, 0, 9, 0, '#39e07a']) // the 60° cross on the waterline
    const vertical = eadi({ pitch: 90 })
    const [, sy, , sh] = vertical.fills[0]
    expect(sy).toBeLessThanOrEqual(-R)
    expect(sy + sh).toBeGreaterThanOrEqual(R)
    const line = vertical.lines.filter(([x0, y0, x1, y1]) => x0 === 0 && x1 === 0 && Math.abs(y1 - y0) > 20)
    const covered = (y: number) => line.some(([, y0, , y1]) => Math.min(y0, y1) <= y && y <= Math.max(y0, y1))
    expect(covered(-20)).toBe(true)
    expect(covered(0)).toBe(false) // broken for the zenith circle
  })

  it('runs one line down the meridian, broken for each figure and ending at the rim', () => {
    const d = eadi({ pitch: 0 })
    const line = d.lines.filter(([x0, y0, x1, y1]) => x0 === 0 && x1 === 0 && Math.abs((y0 + y1) / 2 - 90 * ppd) > 1e-9) // less the nadir's cross
    for (const [, y0, , y1] of line) {
      expect(Math.min(y0, y1)).toBeGreaterThanOrEqual(-R)
      expect(Math.max(y0, y1)).toBeLessThanOrEqual(R)
    }
    const covered = (y: number) => line.some(([, y0, , y1]) => Math.min(y0, y1) <= y && y <= Math.max(y0, y1))
    for (const y of [-160, -100, -50, -5, 5, 60, 100, 170]) expect(covered(y)).toBe(true)
    for (let n = -30; n <= 30; n += 10) expect(covered(-n * ppd - 22)).toBe(false)
  })

  it('ticks the bank scale on the lower arc at 0, 10, 20, 30, 60 and 90° each side', () => {
    const d = eadi({ bank: 45 * Math.PI / 180 })
    const outside = d.lines.filter(([x0, y0, x1, y1]) => Math.abs(Math.hypot(x0 - cx, y0 - cy) - R) < 1e-6 && Math.abs(Math.hypot(x1 - cx, y1 - cy) - R - T) < 1e-6)
    const angles = outside.map(([x0, y0]) => Math.round(Math.atan2(x0 - cx, y0 - cy) * 180 / Math.PI)).sort((a, b) => a - b)
    expect(angles).toEqual([-90, -60, -30, -20, -10, 0, 10, 20, 30, 45, 60, 90]) // the eleven ticks, and the pointer at 45° right
  })

  it('points at the bank with the ladder line carried out past the rim', () => {
    const level = eadi({ bank: 0 })
    const bottom = level.lines.filter(([x0, y0, x1, y1]) => x0 === cx && x1 === cx && Math.abs(y0 - (cy + R)) < 1e-9 && Math.abs(y1 - (cy + R + T)) < 1e-9)
    expect(bottom).toHaveLength(2) // the 0° tick and the pointer over it
    const banked = eadi({ bank: 45 * Math.PI / 180 })
    const [pointer] = banked.lines.filter(([x0, y0]) => Math.abs(x0 - (cx + Math.sin(Math.PI / 4) * R)) < 1e-6 && Math.abs(y0 - (cy + Math.cos(Math.PI / 4) * R)) < 1e-6)
    expect(pointer).toBeDefined()
    expect(pointer[4]).toBe('#39e07a')
    const [colour] = eadi({ bank: 45 * Math.PI / 180 }, 'center').lines.filter(([x0, y0]) => Math.abs(x0 - (cx + Math.sin(Math.PI / 4) * R)) < 1e-6 && Math.abs(y0 - (cy + Math.cos(Math.PI / 4) * R)) < 1e-6)
    expect(colour[4]).toBe('#e8e8e0') // the ladder's ink on the AMPCD
  })

  it('draws the waterline as a W at the ball\'s centre', () => {
    const d = eadi()
    const w = [[cx - 24, cy], [cx - 14, cy], [cx - 7, cy + 11], [cx, cy], [cx + 7, cy + 11], [cx + 14, cy], [cx + 24, cy]]
    for (let i = 1; i < w.length; i++) expect(d.lines).toContainEqual([w[i - 1][0], w[i - 1][1], w[i][0], w[i][1], '#39e07a'])
  })

  it('draws the ILS needles full length about the waterline, full scale a fifth of the radius off it', () => {
    const L = R * 0.325, F = R * 0.2
    const needles = (display: string) => eadi({ deviation: '{ gs:1, az:-1 }' }, display).lines
    const near = (a: (number | string)[], b: (number | string)[]) => a.length === b.length && a.every((v, i) => typeof v === 'number' ? Math.abs(v - (b[i] as number)) < 1e-9 : v === b[i])
    const left = needles('left')
    expect(left.some((l) => near(l, [cx - L, cy + F, cx + L, cy + F, '#39e07a']))).toBe(true)
    expect(left.some((l) => near(l, [cx - F, cy - L, cx - F, cy + L, '#39e07a']))).toBe(true)
    const centre = needles('center')
    expect(centre.some((l) => near(l, [cx - L, cy + F, cx + L, cy + F, '#ffd24a']))).toBe(true)
  })

  it('puts the turn indicator\'s lower box under an end box at a standard rate turn', () => {
    const sy = cy + R + 20
    const level = eadi({ yaw: 0 })
    expect(level.rects).toContainEqual([cx - 12, sy + 12, 24, 16])
    const standard = eadi({ yaw: 3 * Math.PI / 180 })
    expect(standard.rects).toContainEqual([cx + 60 - 12, sy + 12, 24, 16])
    expect(standard.rects).toContainEqual([cx + 60 - 12, sy - 8, 24, 16]) // the end box it sits under
    expect(sy + 12 + 16).toBeLessThan(482 - 10) // clear of the bottom legends
    expect(sy - 8).toBeGreaterThan(cy + R + T) // clear of the bank scale
  })

  it('boxes airspeed at the top left and altitude at the top right, vertical velocity above it', () => {
    const d = eadi()
    expect(d.rects).toContainEqual([40, 44, 88, 30])
    expect(d.rects).toContainEqual([360, 44, 104, 30])
    expect(at(d, '194')).toEqual([120, 59]) // 100 m/s in knots
    expect(at(d, '500')).toEqual([456, 60])
    expect(at(d, '1')).toEqual([425, 59]) // the thousands left of the hundreds, larger
    expect(d.fonts).toContainEqual(['1', '24px monospace'])
    expect(d.fonts).toContainEqual(['500', '18px monospace'])
    expect(at(d, '-480')).toEqual([456, 30])
    const low = eadi({ reading: '{ feet:850, radar:false, fallback:false }' })
    expect(at(low, '850')).toEqual([456, 59])
    for (const word of ['R', 'B', 'RDR', 'BARO']) expect(texts(d)).not.toContain(word)
  })

  it('shows the altitude the HUD shows, with R for radar and the flashing B for its fallback', () => {
    const radar = eadi({ reading: '{ feet:420, radar:true, fallback:false }' })
    expect(at(radar, '420')).toEqual([456, 59])
    expect(at(radar, 'R')).toEqual([470, 59])
    expect(at(eadi({ reading: '{ feet:9000, radar:false, fallback:true }', time: 0 }), 'B')).toEqual([470, 59])
    expect(texts(eadi({ reading: '{ feet:9000, radar:false, fallback:true }', time: 0.5 }))).not.toContain('B')
    expect(source).toMatch(/\n\tconst reading=altitude_reading\(\), alt=reading\.feet, radar=reading\.radar, flashB=reading\.fallback;/)
  })

  it('offers INS at the bottom left and STBY at the bottom right, boxes the source and switches it on a press', () => {
    const d = eadi({ source: 'stby' })
    expect(at(d, 'INS')).toEqual([96, 482])
    expect(at(d, 'STBY')).toEqual([416, 482])
    expect(d.rects.some(([bx, by]) => bx === 416 - 20 - 6 && by === 482 - 14)).toBe(true) // STBY boxed
    const press = new Function(`let adi_source='stby'; ${lift('adi_press')}
      const a=adi_press(20), s1=adi_source; const b=adi_press(16), s2=adi_source; const c=adi_press(19); return [a,s1,b,s2,c];`)() as [boolean, string, boolean, string, boolean]
    expect(press).toEqual([true, 'ins', true, 'stby', false])
    expect(source).toMatch(/adi:\{draw:ddi_adi,press:adi_press\}/)
    expect(source).toMatch(/adi_source=\(st==="runway"\|\|st==="carrier"\)\?"stby":"ins";/)
  })
})

// In a right bank the world turns anticlockwise about the jet: the attitude
// ball and ladder turn that way, a sky pointer at the top swings left, and a
// pointer at the bottom (the HUD's) swings right.
describe('the attitude pages in a right bank', () => {
  const gauges = `pitch:0, bank:${bank_right(30)}, yaw:0, slip:0, altitude:1500, vspeed:0, casKt:250, mach:0.4, fpm:0, heading:0`
  const turn = -30 * Math.PI / 180 // the canvas y axis runs down, so a negative turn is anticlockwise

  it('turns the EADI ball anticlockwise and swings the ladder line\'s lower end right', () => {
    const d = page('ddi_adi', `const ownship={ cas:100, speed:100, gauges:{ ${gauges} } };
      const adi_source="ins", sim_time=0, altitude_reading=()=>({ feet:1500, radar:false, fallback:false }), approach_deviation=()=>null;`)
    expect(d.rotate[0]).toBeCloseTo(turn, 9)
    const pointer = d.lines.filter(([x0, y0]) => Math.abs(x0 - (256 + Math.sin(Math.PI / 6) * 176)) < 1e-6 && Math.abs(y0 - (240 + Math.cos(Math.PI / 6) * 176)) < 1e-6)
    expect(pointer).toHaveLength(2) // over the 30° tick
    expect(pointer[0][0]).toBeGreaterThan(256)
  })

})

// The HUD format on a DDI (#62): the HUD's own furniture, ladder and symbols,
// drawn through a fixed field about the nose. The recording canvas applies the
// transforms, so everything is read in display pixels.
interface Repeat { pitch?: number; bank?: number; gear?: number; master?: string; declutter?: number; reading?: string; climb?: number }
interface Shown { text: [string, number, number][]; rects: [number, number, number, number][]; lines: [number, number, number, number][]; arcs: [number, number, number][]; rotations: number[] }
function repeat(o: Repeat = {}): Shown {
  const r = (o.pitch ?? 0) * Math.PI / 180, b = (o.bank ?? 0) * Math.PI / 180
  // a jet heading east (+x), pitched then banked right wing down
  const fwd = new THREE.Vector3(Math.cos(r), Math.sin(r), 0)
  const up0 = new THREE.Vector3(-Math.sin(r), Math.cos(r), 0), right0 = new THREE.Vector3(0, 0, 1)
  const right = right0.clone().multiplyScalar(Math.cos(b)).addScaledVector(up0, -Math.sin(b))
  const up = up0.clone().multiplyScalar(Math.cos(b)).addScaledVector(right0, Math.sin(b))
  const climb = o.climb ?? 0, speed = 150
  const vel = fwd.clone().multiplyScalar(speed).add(new THREE.Vector3(0, climb, 0))
  const ownship = { fwd, right, up, speed, cas: speed, velx: vel.x, vely: vel.y, velz: vel.z, vel_dir: vel.clone().normalize(), aoa: 0, gload: 1, gear: o.gear ?? 1, grounded: false, pos: { x: 0, y: 3000, z: 0 }, rounds: 578, msl: 2, amraam: 4 }
  const names = ['ddi_hud', 'hud_pitch', 'hud_symbols', 'hud_cluster', 'closure', 'dir_at', 'gpws_arrow', 'breakaway_shown', 'breakaway']
  return new Function('THREE', 'ownship', `const D2R=Math.PI/180, HH=900, world_up=new THREE.Vector3(0,1,0), master=${JSON.stringify(o.master ?? 'nav')}, caged=false, declutter=${o.declutter ?? 0};
    const law_active=false, hud_cue="", sim_time=0, carrier_ols=false, CARRIER={ x:0, z:0 }, SHIP={ ident:"NIM" }, atc_on=false, atc_flash=-99, amraam_visual=false, peak_g=1, last_out=null, STATE={ mach:0 };
    let baro_armed=false, baro_shown=-99, baro_flash=false, baro_set=2992, baro_last=2992;
    const baro_error=()=>0, altitude_reading=()=>(${o.reading ?? '{ feet:9843, radar:false, fallback:false }'}), approach_deviation=()=>null, hud_target=()=>null, wrap_distance=()=>0, wrap_axis=(v)=>v;
    const cheat=()=>false, translate=(s)=>s, timer_text=()=>"", tacan=()=>({ slant:0 }), hud_launch_zone=()=>{};
    ${names.map((n) => lift(n)).join(' ')}
    const text=[], rects=[], lines=[], arcs=[], rotations=[]; let m=[1,0,0,1,0,0], stack=[], at=[0,0];
    const apply=(px,py)=>[m[0]*px+m[2]*py+m[4], m[1]*px+m[3]*py+m[5]];
    const mul=(n)=>{ m=[m[0]*n[0]+m[2]*n[1], m[1]*n[0]+m[3]*n[1], m[0]*n[2]+m[2]*n[3], m[1]*n[2]+m[3]*n[3], m[0]*n[4]+m[2]*n[5]+m[4], m[1]*n[4]+m[3]*n[5]+m[5]]; };
    const x=new Proxy({}, { get:(o,k)=>{
      if(k==='save') return ()=>stack.push(m.slice()); if(k==='restore') return ()=>{ m=stack.pop()||m; };
      if(k==='translate') return (tx,ty)=>mul([1,0,0,1,tx,ty]); if(k==='scale') return (sx,sy)=>mul([sx,0,0,sy,0,0]);
      if(k==='rotate') return (a)=>{ rotations.push(a); mul([Math.cos(a),Math.sin(a),-Math.sin(a),Math.cos(a),0,0]); };
      if(k==='getTransform') return ()=>({ a:m[0], b:m[1], c:m[2], d:m[3], e:m[4], f:m[5] }); if(k==='setTransform') return (tr)=>{ m=[tr.a,tr.b,tr.c,tr.d,tr.e,tr.f]; };
      if(k==='fillText') return (s,px,py)=>text.push([String(s),...apply(px,py)]);
      if(k==='strokeRect') return (rx,ry,w,h)=>{ const [ax,ay]=apply(rx,ry); rects.push([ax,ay,w*m[0],h*m[3]]); };
      if(k==='moveTo') return (px,py)=>{ at=apply(px,py); }; if(k==='lineTo') return (px,py)=>{ const q=apply(px,py); lines.push([...at,...q]); at=q; };
      if(k==='arc') return (ax,ay,rr)=>arcs.push([...apply(ax,ay),rr*m[0]]);
      if(k==='measureText') return (s)=>({ width:7*String(s).length });
      return ()=>{}; }, set:()=>true });
    ddi_hud(x); return { text, rects, lines, arcs, rotations };`)(THREE, ownship) as Shown
}
describe('the HUD format on a DDI', () => {
  const ppd = 512 / 26, k = ppd / 20, wly = 256 - 4 * ppd
  const labels = (d: Shown) => d.text.map((s) => s[0])

  it('boxes airspeed and altitude with their tops on the waterline, as the HUD does', () => {
    const d = repeat()
    const tops = d.rects.map((q) => q[1])
    expect(tops.length).toBe(2)
    for (const y of tops) expect(y).toBeCloseTo(wly, 9)
    expect(labels(repeat({ declutter: 1 })).length).toBeGreaterThan(0)
    expect(repeat({ declutter: 1 }).rects).toEqual([]) // REJ 1 takes the boxes, as on the HUD
  })

  it('runs the moving 30° heading scale across the top, not a digital heading', () => {
    const d = repeat()
    for (const label of ['080', '090', '100']) expect(labels(d)).toContain(label)
    const [, hx, hy] = d.text.find((s) => s[0] === '090')!
    expect(hx).toBeCloseTo(256, 6)
    expect(hy).toBeLessThan(wly)
  })

  it('shows the altitude the HUD shows, with R for radar', () => {
    const d = repeat({ reading: '{ feet:420, radar:true, fallback:false }' })
    expect(labels(d)).toContain('420')
    expect(labels(d)).toContain('R')
  })

  it('puts the vertical velocity above the altitude box in NAV and on approach only', () => {
    const vv = (d: Shown) => d.text.find((s) => s[0] === '980')
    const nav = vv(repeat({ climb: 5 }))
    expect(nav).toBeDefined()
    expect(nav![2]).toBeLessThan(wly)
    expect(vv(repeat({ climb: 5, master: 'gun' }))).toBeUndefined()
    expect(vv(repeat({ climb: 5, master: 'gun', gear: 0 }))).toBeDefined()
  })

  it('switches to the landing symbology with the gear down: the waterline, and Mach and g gone', () => {
    const w = (d: Shown) => d.lines.some(([x0, y0, x1, y1]) => Math.abs(x0 - (256 - 8 * k)) < 1e-6 && Math.abs(y0 - wly) < 1e-6 && Math.abs(x1 - (256 - 4 * k)) < 1e-6 && Math.abs(y1 - (wly + 7 * k)) < 1e-6)
    const up = repeat(), down = repeat({ gear: 0 })
    expect(w(up)).toBe(false)
    expect(w(down)).toBe(true)
    expect(labels(up).some((s) => s.startsWith('M '))).toBe(true)
    expect(labels(down).some((s) => s.startsWith('M ') || s.startsWith('G '))).toBe(false)
  })

  it('carries the ladder every 5° to the vertical, with the zenith', () => {
    const steep = repeat({ pitch: 60 })
    expect(labels(steep)).toContain('60')
    expect(labels(steep)).toContain('65')
    const near = repeat({ pitch: 82 })
    const zenith = near.arcs.find((a) => Math.abs(a[2] - 7 * k) < 1e-9)
    expect(zenith).toBeDefined()
    expect(zenith![1]).toBeCloseTo(wly - Math.tan(8 * Math.PI / 180) * ppd * 180 / Math.PI, 3)
  })

  it('turns the ladder anticlockwise in a right bank and swings the bank pointer right, as the HUD does', () => {
    const d = repeat({ bank: 30 })
    expect(d.rotations.every((a) => a < 0)).toBe(true)
    expect(d.rotations.some((a) => Math.abs(a + 30 * Math.PI / 180) < 0.02)).toBe(true)
    const pointer = repeat({ bank: 30 }).lines.find(([x0, y0, x1, y1]) => y0 > 256 && x0 > 256 && Math.hypot(x1 - x0, y1 - y0) > 5 * k && Math.hypot(x1 - x0, y1 - y0) < 12 * k)
    expect(pointer).toBeDefined()
  })

  it('takes the AMRAAM steering dot in the frame it is drawn in: the airframe on a DDI', () => {
    const dot = (axes: string, lead: string) => new Function('THREE', `const D2R=Math.PI/180, GR='g', sim_time=0, missiles=[], ownship={ pos:{x:0,y:0,z:0}, amraam:4 }, wrap_axis=(v)=>v, shoot_cue=()=>null;
      const launch_zone=()=>({ aero:0, lead:${lead} }), camera={ quaternion:new THREE.Quaternion() }, _q=new THREE.Quaternion(); let hud_cue="", hud_shoot=false;
      const arcs=[]; const hctx=new Proxy({}, { get:(o,k)=>k==='arc'?(ax,ay,r)=>arcs.push([ax,ay,r]):()=>{}, set:()=>true });
      ${lift('hud_launch_zone')} hud_launch_zone(hctx,GR,0,0,20,0,0,${axes}); return arcs.find((a)=>a[2]===3.5);`)(THREE) as number[]
    const east = '{ fwd:new THREE.Vector3(1,0,0), right:new THREE.Vector3(0,0,1), up:new THREE.Vector3(0,1,0) }' // an airframe heading east
    const [x, y] = dot(east, '{ x:1000*Math.cos(2*D2R), y:0, z:1000*Math.sin(2*D2R) }') // 2° right of its nose, inside the dot's peg
    expect(x).toBeCloseTo(2 * 20, 6)
    expect(y).toBeCloseTo(0, 6)
  })

  it('is drawn by the HUD\'s own code', () => {
    const body = lift('ddi_hud')
    for (const call of ['hud_pitch(x,GREEN,place,', 'hud_symbols(x,GREEN,bore,', 'hud_cluster(x,GREEN,0,0,HH/45,true,null,pa,']) expect(body).toContain(call)
    expect(source).toMatch(/\n\thud_cluster\(hctx,GR,cx,cy,ppdv,glass,screen,pa,boxed,vc,ranged\?rng:null,/)
    expect(source).toMatch(/const horizon=hud_pitch\(hctx,GR,proj_dir,ladFwd,rightH,pa,hs\);/)
    expect(source).toMatch(/\n\thud_symbols\(hctx,GR,bore,fpm,fpm_limited,ghost,ghost_limited,pa,ppd,hs\);/)
  })
})

describe('the engine monitor display', () => {
  const eng = (grounded: boolean) => page('ddi_eng', `const ownship={ grounded:${grounded}, gauges:{ rpmL:99, rpmR:65, egtL:810, egtR:450, flowL:5004, flowR:1000, nozL:0, nozR:100, oilL:100, oilR:55, oat:-5 } };`)
  const row = (d: Drawn, label: string) => { const y = at(d, label)![1]; return d.text.filter((t) => t[2] === y && t[0] !== label).map((t) => t[0]) }
  it('lists the thirteen EMD rows by figure 2-3\'s names under the -402 EPE line, with no title', () => {
    const d = eng(true)
    const labels = ['INLET TEMP', 'N1 RPM', 'N2 RPM', 'EGT', 'FF', 'NOZ POS', 'OIL PRESS', 'THRUST', 'VIB', 'FUEL TEMP', 'EPR', 'CDP', 'TDP']
    expect(labels.map((l) => at(d, l))).toEqual(labels.map((_, i) => [200, 100 + 29 * i]))
    expect(texts(d)).toContain('LEFT EPE')
    expect(texts(d)).toContain('RIGHT EPE')
    expect(texts(d)).not.toContain('ENG')
  })

  it('writes each value in the figure\'s digits, from the spool', () => {
    const d = eng(true)
    expect(row(d, 'N1 RPM')).toEqual(['100', '30']) // MIL on the left, idle on the right
    expect(row(d, 'FF')).toEqual(['5000', '1000']) // to the ten
    expect(row(d, 'VIB')).toEqual(['1.0', '1.0'])
    expect(row(d, 'EPR')).toEqual(['1.70', '1.00'])
    expect(row(d, 'TDP')).toEqual(['45.0', '15.0'])
    expect(row(d, 'INLET TEMP')).toEqual(['-5', '-5'])
    expect(row(d, 'CDP')).toEqual(['300', '60'])
  })

  it('left-aligns each engine\'s column', () => {
    const d = eng(true)
    const y = at(d, 'EGT')![1]
    expect(d.text.filter((t) => t[2] === y && t[0] !== 'EGT').map((t) => t[1])).toEqual([96, 390])
  })

  it('shows THRUST for the ground run-up only', () => {
    expect(row(eng(true), 'THRUST')).toEqual(['100', '0'])
    const flying = eng(false)
    expect(texts(flying)).not.toContain('THRUST')
    expect(at(flying, 'VIB')![1]).toBe(100 + 29 * 8) // the rows below keep their places
  })
})

// The HSI against 2.13.4.7, 24.1.3 and figures 2-24 and 24-2. Marks inside the
// rose are recorded relative to the aircraft (the translated frame); the aircraft
// symbol and the text on the page.
interface Hsi { altitude?: number; heading?: number; track?: number | null; ground?: number; speed?: number; scale?: number; dctr?: boolean; north?: boolean; mode?: boolean; map?: boolean; timer?: string; east?: number; north_m?: number; wrap?: string }
function hsi(o: Hsi = {}, display = 'left'): Drawn {
  const deg = (v: number | null | undefined, d: number) => v === null ? 'null' : `${(v ?? d)}*D2R`
  return page('ddi_hsi', `const ownship={ pos:{x:0,y:${o.altitude ?? 1000},z:0}, speed:${o.speed ?? 100}, gauges:{ heading:${deg(o.heading, 0)}, ground:${o.ground ?? 200}, track:${deg(o.track, 0)}, zulu:45296 } };
    const hsi_state={ scale:${o.scale ?? 40}, dctr:${o.dctr ?? false}, map:${o.map ?? false}, north:${o.north ?? false}, mode:${o.mode ?? false} }, ufc={ func:"" }, CARRIER={ x:${o.east ?? 18520}, z:${-(o.north_m ?? 0)} };
    const island_polygons=[], airports=[], wrap_axis=${o.wrap ?? '(v)=>v'}, SHIP={ ident:"NIM" }, timer={ shown:${JSON.stringify(o.timer ?? '')} }, timer_text=()=>"01:30";
    ${lift('tacan')} ${lift('time_to_go')}`, display)
}
const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6)
const polar = (r: number, degrees: number) => [Math.sin(degrees * Math.PI / 180) * r, -Math.cos(degrees * Math.PI / 180) * r]
describe('the HSI page', () => {
  const R = 164, T = 12

  it('scales to the inside of the rose, holding the station there beyond the scale', () => {
    const d = hsi() // the station 10 nm east at SCL/40: a quarter of the way to the rose
    expect(d.moves.some((m) => near(m, [R / 4, -9]))).toBe(true)
    const beyond = hsi({ scale: 5 })
    expect(beyond.moves.some((m) => near(m, [R, -9]))).toBe(true)
  })

  it('shows the scale as SCL at the top centre, doubled in DCTR, and steps it down on a press', () => {
    expect(at(hsi(), 'SCL/40')).toEqual([256, 30])
    expect(texts(hsi({ dctr: true }))).toContain('SCL/80')
    const steps = new Function(`const HSI_SCALES=[5,10,20,40,80,160], hsi_state={ scale:40, mode:false }, ufc_press=()=>{}; ${lift('hsi_press')}
      const seen=[]; for(let i=0;i<6;i++){ hsi_press(8,"left"); seen.push(hsi_state.scale); } return seen;`)() as number[]
    expect(steps).toEqual([20, 10, 5, 160, 80, 40])
  })

  it('ticks the rose every 10° with the figures every 30°, and draws no ring', () => {
    const d = hsi()
    const ticks = d.lines.filter(([x0, y0, x1, y1]) => Math.abs(Math.hypot(x0, y0) - R) < 1e-6 && Math.abs(Math.hypot(x1, y1) - R - T) < 1e-6)
    const angles = ticks.map(([x0, y0]) => Math.round((Math.atan2(x0, -y0) * 180 / Math.PI + 360) % 360)).sort((a, b) => a - b)
    expect(angles).toEqual([...Array(36).keys()].map((i) => i * 10).filter((a) => a % 30))
    const figures = ['N', '3', '6', 'E', '12', '15', 'S', '21', '24', 'W', '30', '33']
    figures.forEach((f, i) => expect(d.text.some(([s, fx, fy]) => s === f && near([fx, fy], polar(R + T / 2, i * 30)))).toBe(true))
    expect(d.arcs).toEqual([])
  })

  it('turns the rose to the ground track, with the lubber line and the T at the heading', () => {
    const d = hsi({ heading: 40, track: 30 })
    expect(d.text.some(([s, fx, fy]) => s === '3' && near([fx, fy], polar(R + T / 2, 0)))).toBe(true) // 030 at the top
    expect(d.lines.some((l) => near(l.slice(0, 4) as number[], [...polar(R - 18, 10), ...polar(R + T + 6, 10)]))).toBe(true)
    expect(d.text.some(([s, fx, fy]) => s === 'T' && near([fx, fy], polar(R - 30, 10)))).toBe(true)
    expect(d.moves.some((m) => near(m, polar(R - 2, 0)))).toBe(true) // the ground track diamond at the top
    expect(texts(d)).not.toContain('040')
  })

  it('turns the rose to north in N UP, and to the heading below taxi speed', () => {
    const north = hsi({ heading: 40, track: 30, north: true })
    expect(north.text.some(([s, fx, fy]) => s === 'N' && near([fx, fy], polar(R + T / 2, 0)))).toBe(true)
    expect(north.moves.some((m) => near(m, polar(R - 2, 30)))).toBe(true)
    const taxi = hsi({ heading: 40, track: null })
    expect(taxi.lines.some((l) => near(l.slice(0, 4) as number[], [...polar(R - 18, 0), ...polar(R + T + 6, 0)]))).toBe(true)
    expect(taxi.moves.some((m) => near(m, polar(R - 2, 0)))).toBe(false) // no track, no diamond
  })

  it('draws the aircraft symbol as a cross at the heading, true airspeed left and groundspeed right', () => {
    const d = hsi({ heading: 40, track: 30 })
    const a = 10 * Math.PI / 180, f = ([px, py]: number[]) => [256 + Math.cos(a) * px - Math.sin(a) * py, 260 + Math.sin(a) * px + Math.cos(a) * py]
    for (const [p, q] of [[[0, -7], [0, 27]], [[-18, 0], [18, 0]], [[-6, 25], [6, 25]]]) expect(d.lines.some((l) => near(l.slice(0, 4) as number[], [...f(p), ...f(q)]))).toBe(true)
    expect(at(d, '194T')).toEqual([240, 282])
    expect(at(d, '200G')).toEqual([272, 282])
    expect(texts(d).some((s) => s.startsWith('GS'))).toBe(false)
  })

  it('puts the TACAN pointer outside the rose with its tail outside the far side, in colour only on the AMPCD', () => {
    for (const [display, ink] of [['left', '#39e07a'], ['right', '#39e07a'], ['center', '#ffd24a']]) {
      const d = hsi({}, display)
      const head = d.styled.find(([, mx, my]) => near([mx, my], polar(R + T + 3, 90)))
      expect(head?.[0]).toBe(ink)
      const tail = d.lines.find((l) => near(l.slice(0, 4) as number[], [...polar(R + T + 3, 270), ...polar(R + T + 17, 270)]))
      expect(tail?.[4]).toBe(ink)
    }
  })

  it('reads the TACAN block as bearing and slant range, TTG at the groundspeed, and the ident, across the world wrap', () => {
    const d = hsi()
    expect(at(d, '090°/ 10.0')).toEqual([20, 66])
    expect(at(d, '3:00')).toEqual([120, 90]) // right-aligned under the range
    expect(at(d, 'NIM')).toEqual([36, 114])
    expect(texts(hsi({ ground: 20 })).filter((s) => /^\d+:\d\d(:\d\d)?$/.test(s))).toEqual(['12:34:56']) // no TTG at taxi speed, only ZTOD
    expect(texts(hsi({ altitude: 5000 }))).toContain('090°/ 10.4') // slant: 10 nm out and 5 km up
    const wrapped = hsi({ east: 81480, wrap: '(v)=>v>50000?v-100000:v' })
    expect(texts(wrapped)).toContain('270°/ 10.0')
    const run = new Function(`${lift('time_to_go')} return [time_to_go(346), time_to_go(3827), time_to_go(40000)];`)() as string[]
    expect(run).toEqual(['5:46', '1:03:47', '8:59:59'])
  })

  it('shows ZTOD at the lower left and the timer shown, ET or CD, at the lower right', () => {
    const d = hsi()
    expect(at(d, '12:34:56')).toEqual([20, 458])
    expect(texts(d)).not.toContain('ET')
    const et = hsi({ timer: 'et' })
    expect(at(et, 'ET')).toEqual([452, 434])
    expect(at(et, '01:30')).toEqual([452, 458])
    expect(texts(hsi({ timer: 'cd' }))).toContain('CD')
    expect(texts(hsi({ timer: 'ztod' }))).not.toContain('01:30')
  })

  it('writes TRUE under the scale', () => {
    expect(at(hsi(), 'TRUE')).toEqual([256, 52])
  })

  it('keeps DCTR, MAP and the orientation on the MODE sublevel, as figure 24-2 does', () => {
    const top = hsi({}, 'center')
    expect(at(top, 'MODE')).toEqual([10, 256])
    expect(at(top, 'TIMEUFC')).toEqual([336, 482])
    for (const gone of ['DCTR', 'MAP', 'T UP', 'HSI', '↑', '↓']) expect(texts(top)).not.toContain(gone)
    const sub = hsi({ mode: true }, 'center')
    expect(at(sub, 'T UP')).toEqual([10, 176])
    expect(at(sub, 'DCTR')).toEqual([10, 336])
    expect(at(sub, 'MAP')).toEqual([96, 30])
    expect(at(sub, 'HSI')).toEqual([416, 30])
    for (const gone of ['MODE', 'TIMEUFC']) expect(texts(sub)).not.toContain(gone)
    expect(texts(hsi({ mode: true, north: true }))).toContain('N UP')
    expect(texts(hsi({ mode: true }, 'left'))).not.toContain('MAP')
    const presses = new Function(`const HSI_SCALES=[5,10,20,40,80,160], hsi_state={ scale:40, dctr:false, map:true, north:false, mode:false }, pressed=[], ufc_press=(b)=>pressed.push(b); ${lift('hsi_press')}
      const r=[hsi_press(4,"left"), hsi_press(9,"left"), hsi_press(3,"left"), hsi_state.mode, hsi_press(4,"left"), hsi_state.north, hsi_press(2,"left"), hsi_state.dctr,
        hsi_press(6,"left"), hsi_state.map, hsi_press(6,"center"), hsi_state.map, hsi_press(17,"left"), hsi_press(10,"left"), hsi_state.mode, hsi_press(17,"left"), pressed.join()];
      return r;`)() as unknown[]
    expect(presses).toEqual([false, false, true, true, true, true, true, true, false, true, true, false, false, true, false, true, 'time'])
  })

  it('in DCTR puts the aircraft near the bottom with the rose centred on it at twice the radius, at the same scale', () => {
    const d = hsi({ dctr: true })
    expect(d.lines.some(([x0, y0, x1, y1]) => Math.abs(Math.hypot(x0, y0) - 2 * R) < 1e-6 && Math.abs(Math.hypot(x1, y1) - 2 * R - T) < 1e-6)).toBe(true)
    expect(d.moves.some((m) => near(m, [R / 4, -9]))).toBe(true) // the station where it was
    expect(at(d, '194T')).toEqual([240, 452])
  })

  it('turns the AMPCD map as the rose turns', () => {
    const d = hsi({ heading: 40, track: 30, map: true }, 'center')
    expect(d.rotate[0]).toBeCloseTo(-30 * Math.PI / 180, 9)
  })
})

describe('the gauges the pages read', () => {
  it('carry a smoothed yaw rate, vertical speed, air temperature and zulu seconds', () => {
    expect(source).toMatch(/heading, yaw:yaw_state\.rate, vspeed:fpm, oat:15-0\.0065\*ownship\.pos\.y, zulu:now\.getUTCHours\(\)\*3600\+now\.getUTCMinutes\(\)\*60\+now\.getUTCSeconds\(\),/)
    expect(source).toMatch(/yaw_state\.rate\+=\(d\/\(t-yaw_state\.t\)-yaw_state\.rate\)\*Math\.min\(1,\(t-yaw_state\.t\)\/0\.5\);/)
  })
})

// The UFC (#15, NATOPS 2.13.5): ufc_face is what the windows show for a state and
// the equipment it reads; ufc_press is one pushbutton against stand-ins for the
// index, the warning latch and the actions it fires; ufc_button_at maps a panel
// point to the painted button under it.
const ufcdefs = ['UFC_PAGES', 'UFC_CUES', 'UFC_BUTTONS', 'UFC_RADIUS'].map((n) => {
  const m = new RegExp(`\\nconst ${n}=[\\s\\S]*?;`).exec(source)?.[0]
  if (!m) throw new Error(`${n} not found in engine.ts`)
  return m
}).join('\n')
interface Face { scratch: string; options: string[] }
interface Ufc { func: string; ralt: boolean; entry: string; error: boolean; blink: number }
interface Live { silent?: boolean; atc?: boolean; ils?: boolean; index?: number }
interface Pressed { ufc: Ufc; index: number; disabled: boolean; pressed: string[]; silent: boolean; atc: boolean }
const fresh = (over: Partial<Ufc> = {}): Ufc => ({ func: '', ralt: false, entry: '', error: false, blink: 0, ...over })
function ufcface(state: Ufc, live: Live, now = 0): Face {
  const run = new Function('state', 'live', 'now', `${ufcdefs} ${lift('ufc_face')} return ufc_face(state, { silent:false, atc:false, ils:false, index:200, ...live }, now);`)
  return run(state, live, now) as Face
}
function ufcpress(buttons: string[], start: Partial<Ufc> = {}, index = 200, sounding = false): Pressed {
  const run = new Function('buttons', 'start', 'index', 'sounding', `${ufcdefs}
    let law_index=index, law_primary=sounding, law_disabled=false, atc_on=false, ufc_dirty=false; const RADAR={ sil:false }, pressed=[];
    const pit_press=(a)=>{ pressed.push(a); if(a==="radar") RADAR.sil=!RADAR.sil; if(a==="atc") atc_on=!atc_on; };
    const ufc_update=()=>{}; const performance={ now:()=>1000 };
    const ufc={ func:"", ralt:false, entry:"", error:false, blink:0, ...start };
    ${lift('ufc_press')}
    for(const b of buttons) ufc_press(b);
    return { ufc, index:law_index, disabled:law_disabled, pressed, silent:RADAR.sil, atc:atc_on };`)
  return run(buttons, start, index, sounding) as Pressed
}
function ufcbutton(y: number, z: number): string | null {
  const run = new Function('y', 'z', `${ufcdefs} ${lift('ufc_button_at')} return ufc_button_at(y, z);`)
  return run(y, z) as string | null
}
const blank = ' '.repeat(9)

describe('the UFC windows', () => {
  it('power up clear', () => {
    expect(ufcface(fresh(), {})).toEqual({ scratch: blank, options: ['', '', '', '', ''] })
  })

  it('show the autopilot page with ON while the approach power compensator is engaged', () => {
    expect(ufcface(fresh({ func: 'ap' }), {}).options).toEqual([' ATTH', ' HSEL', ' BALT', ' RALT', ' CPL'])
    expect(ufcface(fresh({ func: 'ap' }), {}).scratch).toBe(blank)
    expect(ufcface(fresh({ func: 'ap' }), { atc: true }).scratch).toBe('ON       ')
  })

  it('cue :RALT, with only a keyed entry in the scratchpad: the index is the knob\'s (NATOPS 2.12.5.4.1)', () => {
    const f = ufcface(fresh({ func: 'ap', ralt: true }), {})
    expect(f.options[3]).toBe(':RALT')
    expect(f.scratch).toBe(blank)
    expect(ufcface(fresh({ func: 'ap', ralt: true, entry: '500' }), {}).scratch).toBe('      500')
  })

  it('show TACAN on in T/R on the X band, and ILS on only while the needles are live', () => {
    const t = ufcface(fresh({ func: 'tcn' }), {})
    expect(t.options).toEqual([':T/R', ' RCV', ' A/A', ':X', ' Y'])
    expect(t.scratch.slice(0, 2)).toBe('ON')
    expect(ufcface(fresh({ func: 'ils' }), { ils: true }).scratch.slice(0, 2)).toBe('ON')
    expect(ufcface(fresh({ func: 'ils' }), { ils: false }).scratch.slice(0, 2)).toBe('  ')
    expect(ufcface(fresh({ func: 'ils' }), {}).options[0]).toBe(':CHNL')
  })

  it('run E M C O N down the option windows under radar silence, whatever the page', () => {
    expect(ufcface(fresh({ func: 'tcn' }), { silent: true }).options).toEqual(['E', 'M', 'C', 'O', 'N'])
    expect(ufcface(fresh(), { silent: true }).options).toEqual(['E', 'M', 'C', 'O', 'N'])
  })

  it('flash ERROR at 2 Hz and blank the scratchpad once after a valid entry', () => {
    expect(ufcface(fresh({ error: true }), {}, 0).scratch).toBe('ERROR    ')
    expect(ufcface(fresh({ error: true }), {}, 0.5).scratch).toBe(blank)
    expect(ufcface(fresh({ error: true }), {}, 1.0).scratch).toBe('ERROR    ')
    expect(ufcface(fresh({ func: 'tcn', blink: 2 }), {}, 1.9).scratch).toBe(blank)
    expect(ufcface(fresh({ func: 'tcn', blink: 2 }), {}, 2.1).scratch.slice(0, 2)).toBe('ON')
  })
})

// The IFEI's six pushbuttons are painted on the cockpit shell down the unit's
// middle column; a click on the unit's quad answers the nearest painted legend.
function ifeibutton(y: number, z: number): string | null {
  const defs = /\nconst IFEI_BUTTONS=[^\n]*\n/.exec(source)?.[0] ?? ''
  const run = new Function('y', 'z', `${defs} const ifei_buttons=["mode","qty","up","down","zone","et"], ownship={ group:{ worldToLocal:(p)=>p } };
    ${lift('ifei_button_at')} return ifei_button_at({ clone:()=>({ x:6.211, y, z }) });`)
  return run(y, z) as string | null
}

describe('the IFEI pushbuttons', () => {
  it('answer at their painted legends, MODE at the top of the column to ET at its foot', () => {
    expect(ifeibutton(0.200, -0.205)).toBe('mode')
    expect(ifeibutton(0.163, -0.203)).toBe('up')
    expect(ifeibutton(0.142, -0.207)).toBe('down')
    expect(ifeibutton(0.102, -0.205)).toBe('et')
  })

  it('leave the windows either side and the panel below to the rest of the pit', () => {
    expect(ifeibutton(0.150, -0.265)).toBe(null) // the engine window
    expect(ifeibutton(0.190, -0.160)).toBe(null) // the fuel window
    expect(ifeibutton(0.080, -0.205)).toBe(null)
  })
})

describe('the UFC pushbuttons', () => {
  it('fill the entry from the keypad to seven digits, and CLR clears it first and the windows second', () => {
    expect(ufcpress(['1', '2', '3', '4', '5', '6', '7', '8'], { func: 'ap' }).ufc.entry).toBe('1234567')
    const once = ufcpress(['1', '2', 'clr'], { func: 'ap' })
    expect(once.ufc.entry).toBe('')
    expect(once.ufc.func).toBe('ap')
    expect(ufcpress(['1', '2', 'clr', 'clr'], { func: 'ap' }).ufc.func).toBe('')
  })

  it('key nothing with ENT: the low-altitude index is the knob\'s, not the UFC\'s, so an entry flags ERROR', () => {
    const keyed = ufcpress(['ap', 'opt3', '5', '0', '0', 'ent'])
    expect(keyed.index).toBe(200)
    expect(keyed.ufc.error).toBe(true)
    expect(ufcpress(['ap', 'opt3', 'ent']).ufc.error).toBe(true)
    expect(ufcpress(['ap', '5', 'ent']).ufc.error).toBe(true)
    expect(ufcpress(['ap', 'opt3', '5', '0', '0', 'ent', '7']).ufc.entry).toBe('500')
    expect(ufcpress(['ap', 'opt3', '5', '0', '0', 'ent', 'clr']).ufc.error).toBe(false)
  })

  it('select :RALT on the autopilot page only, and disable a sounding primary warning with it or with another UFC mode (NATOPS 2.12.5.1)', () => {
    expect(ufcpress(['ap', 'opt3']).ufc.ralt).toBe(true)
    expect(ufcpress(['ap', 'opt3', 'opt3']).ufc.ralt).toBe(false)
    expect(ufcpress(['opt3'], { func: 'ap' }, 200, true).disabled).toBe(true)
    expect(ufcpress(['tcn'], {}, 200, true).disabled).toBe(true)
    expect(ufcpress(['opt3'], { func: 'ap' }, 200, false).disabled).toBe(false) // nothing sounding, nothing to disable
    expect(ufcpress(['1', 'clr'], { func: 'ap' }, 200, true).disabled).toBe(false) // the keypad is not a mode change
    expect(ufcpress(['tcn', 'opt3']).ufc.ralt).toBe(false)
    expect(ufcpress(['ap', 'opt2']).ufc.ralt).toBe(false)
  })

  it('engage the approach power compensator from the A/P selector once, and clear the display on the second press', () => {
    const on = ufcpress(['ap'])
    expect(on.ufc.func).toBe('ap')
    expect(on.pressed).toEqual(['atc'])
    const twice = ufcpress(['ap', 'ap'])
    expect(twice.ufc.func).toBe('')
    expect(twice.pressed).toEqual(['atc'])
    expect(ufcpress(['tcn']).pressed).toEqual([])
  })

  it('toggle the radar silence from EMCON and drop the entry on a page change', () => {
    const e = ufcpress(['emcon'])
    expect(e.pressed).toEqual(['radar'])
    expect(e.silent).toBe(true)
    expect(ufcpress(['emcon', 'emcon']).silent).toBe(false)
    const moved = ufcpress(['ap', 'opt3', '5', 'tcn'])
    expect(moved.ufc).toMatchObject({ func: 'tcn', ralt: false, entry: '' })
  })

  it('map a panel point to the painted button under it, within the key pitch', () => {
    expect(ufcbutton(0.453, -0.061)).toBe('1')
    expect(ufcbutton(0.386, -0.018)).toBe('ent')
    expect(ufcbutton(0.351, -0.065)).toBe('ap')
    expect(ufcbutton(0.412, 0.006)).toBe('opt3')
    expect(ufcbutton(0.450, -0.085)).toBe('emcon')
    expect(ufcbutton(0.453 + 0.008, -0.061)).toBe('1')
    expect(ufcbutton(0.470, -0.050)).toBe(null)
    expect(ufcbutton(0.300, 0)).toBe(null)
  })

  it('are wired: built with the faces, redrawn on the 120 ms economy, clicked through the panel point, ATC and the index shared', () => {
    expect(source).toMatch(/build_ifei\(g\); build_ufc\(g\); \}/)
    expect(source).toMatch(/if\(pit\)\{ ifei_update\(stale\); ufc_update\(stale\); \}/)
    expect(source).toMatch(/if\(ownship\.group\.userData\.ufc\)\{ const h=_click_ray\.intersectObject\(ownship\.group,true\)\.find\(k=>!k\.object\.userData\.overlay&&shown\(k\.object\)\);/)
    expect(source).toMatch(/button=p&&p\.x>6\.10&&p\.x<6\.18\?ufc_button_at\(p\.y,p\.z\):null;\n\t\tif\(button\)\{ ufc_press\(button\); return; \}/)
    expect(source).toMatch(/if\(ch===key_of\("atc"\)\) pit_press\("atc",0\);/)
    expect(source).toMatch(/case "atc": if\(atc_on\)\{ atc_on=false; atc_flash=-Infinity; \} else if\(ownship\.gearTarget<0\.5 && !on_ground\(\)\)\{ atc_on=true;/)
    expect(source).toMatch(/law_primary=false; law_disabled=false; law_index=st==="carrier"\?40:200;/)
    expect(source).toMatch(/ufc\.func=""; ufc\.ralt=false; ufc\.entry=""; ufc\.error=false; ufc\.blink=0; ufc_dirty=true;/)
    expect(source).toMatch(/new THREE\.MeshBasicMaterial\(\{ map:tex, toneMapped:false, transparent:true, depthWrite:false, side:THREE\.DoubleSide \}\)\);   \/\/ transparent: the painted keypad/)
  })
})

// The HSI's TIMEUFC (NATOPS 24.1.3.15, figure 24-9) loads the UFC with the timer
// options; each shows or blanks its timer on the HUD, one at a time; ENT starts
// and stops the one shown, and a keypad entry (MMSS) presets CD and starts it, a
// value past 59:59 setting 59:59 frozen (24.2.5.7.4-6). A number in the button
// list moves the sim clock to that time.
describe('the TIMEUFC page', () => {
  const timers = /\n\/\/ The mission computer's timers[\s\S]*?\n(?=const ufc=\{)/.exec(source)?.[0] ?? ''
  interface Timed { ufc: Ufc; shown: string; et: number; cd: number; running: { et: boolean; cd: boolean }; face: Face }
  const timeufc = (buttons: (string | number)[]): Timed => new Function('buttons', `${ufcdefs} let sim_time=0; ${timers}
    let law_primary=false, law_disabled=false, atc_on=false, ufc_dirty=false; const RADAR={ sil:false }, pit_press=()=>{}, ufc_update=()=>{}, performance={ now:()=>1000 };
    const ufc={ func:"", ralt:false, entry:"", error:false, blink:0 }, hsi_state={ dctr:false, map:false }, hsi_range=()=>{};
    ${lift('ufc_press')} ${lift('hsi_press')} ${lift('ufc_face')}
    for(const b of buttons){ if(typeof b==="number") sim_time=b; else if(b==="timeufc") hsi_press(17,"left"); else ufc_press(b); }
    return { ufc, shown:timer.shown, et:timer_seconds("et"), cd:timer_seconds("cd"), running:{ et:timer.et.since!==null, cd:timer.cd.since!==null },
      face:ufc_face(ufc, { silent:false, atc:false, ils:false, timer:timer.shown }, 0) };`)(buttons) as Timed

  it('is loaded by TIMEUFC, boxed while it holds the UFC, and cleared by a second press', () => {
    expect(timers).not.toBe('')
    expect(timeufc(['timeufc']).ufc.func).toBe('time')
    expect(timeufc(['timeufc']).face.options).toEqual(['', ' ET', ' CD', ' ZTOD', ''])
    expect(timeufc(['timeufc', 'timeufc']).ufc.func).toBe('')
    expect(source).toMatch(/ddi_legend\(x,17,"TIMEUFC",true,ufc\.func==="time"\);/)
  })

  it('shows one timer at a time, cued with a colon, and blanks it on a second press', () => {
    expect(timeufc(['timeufc', 'opt1']).shown).toBe('et')
    expect(timeufc(['timeufc', 'opt1']).face.options[1]).toBe(':ET')
    expect(timeufc(['timeufc', 'opt1', 'opt2']).shown).toBe('cd')
    expect(timeufc(['timeufc', 'opt3']).shown).toBe('ztod')
    expect(timeufc(['timeufc', 'opt1', 'opt1']).shown).toBe('')
    expect(timeufc(['timeufc', 'opt0', 'opt4']).shown).toBe('')
  })

  it('starts and stops the timer shown with ENT, and flags ERROR with none to start', () => {
    const run = timeufc(['timeufc', 'opt1', 'ent', 100])
    expect(run.running.et).toBe(true)
    expect(run.et).toBe(100)
    const stopped = timeufc(['timeufc', 'opt1', 'ent', 100, 'ent', 250])
    expect(stopped.running.et).toBe(false)
    expect(stopped.et).toBe(100)
    expect(timeufc(['timeufc', 'ent']).ufc.error).toBe(true)
    expect(timeufc(['timeufc', 'opt3', 'ent']).ufc.error).toBe(true)
  })

  it('presets CD from the keypad and starts it, freezes a value past 59:59 at 59:59, and flags ERROR on bad seconds', () => {
    const set = timeufc(['timeufc', '0', '3', '3', '0', 'ent', 10])
    expect(set.cd).toBe(200)
    expect(set.running.cd).toBe(true)
    expect(set.ufc.entry).toBe('')
    expect(set.ufc.error).toBe(false)
    const frozen = timeufc(['timeufc', '9', '9', '0', '0', 'ent', 10])
    expect(frozen.cd).toBe(3599)
    expect(frozen.running.cd).toBe(false)
    expect(timeufc(['timeufc', '0', '0', '7', '5', 'ent']).ufc.error).toBe(true)
  })
})


// The DDI view (#12): the first 3 of a mission opens the display carrying the
// radar page, so a BVR fight starts on the attack format whichever display the
// pilot last looked at; after that 3 returns to the display last shown.
describe('the DDI view', () => {
  const start = source.indexOf('function set_view(v){')
  const view = source.slice(start, source.indexOf('\n}\n', start) + 2)
  function rig(pages: Record<string, string>, remembered: string) {
    const run = new Function('pages', 'remembered', `
      const DDI_ORDER=["left","right","center"];
      const cfg={ view:"hud", ddi:remembered }, saved=[];
      const ddi_state={ left:{page:pages.left,menu:""}, right:{page:pages.right,menu:""}, center:{page:pages.center,menu:""} };
      const on_config=(c)=>saved.push(c.ddi);
      let ddi_view_last=0, cam_psi=0, cam_az=0, cam_el=0, cam_dist=0, flyby_pos=null, hist_valid=true, zoom_target=1, view_zoom=1;
      const ownship={ fwd:{x:0,z:1} }, zoom_recall=()=>1, cockpit_hidden=()=>{};
      let ddi_fresh=true;
      ${lift('ddi_focus')} ${lift('ddi_open')} ${view}
      return { press:(v)=>set_view(v), shown:()=>cfg.view==="ddi"?ddi_focus():null, saved, spawn:()=>{ ddi_fresh=true; if(cfg.view==="ddi") ddi_open(); }, move:(d,p)=>{ ddi_state[d].page=p; } };`)
    return run(pages, remembered) as { press(v: string): void; shown(): string | null; saved: string[]; spawn(): void; move(d: string, p: string): void }
  }
  const aa = { left: 'sms', right: 'rdr', center: 'sa' }

  it('opens the radar on the first 3 of a mission, whichever display was looked at last', () => {
    const r = rig(aa, 'left')
    r.press('ddi')
    expect(r.shown()).toBe('right')
  })
  it('does not save that pick: it is the game\'s, not the pilot\'s', () => {
    const r = rig(aa, 'left')
    r.press('ddi')
    expect(r.saved).toEqual([])
  })
  it('cycles from the radar on a re-press, and saves the pilot\'s choice', () => {
    const r = rig(aa, 'left')
    r.press('ddi'); r.press('ddi')
    expect(r.shown()).toBe('center')
    expect(r.saved).toEqual(['center'])
  })
  it('returns to the display last shown after that, not to the radar', () => {
    const r = rig(aa, 'left')
    r.press('ddi'); r.press('ddi'); r.press('hud'); r.press('ddi')
    expect(r.shown()).toBe('center')
  })
  it('follows the radar page to whichever display carries it', () => {
    const r = rig({ left: 'rdr', right: 'fuel', center: 'sa' }, 'center')
    r.press('ddi')
    expect(r.shown()).toBe('left')
  })
  it('keeps the remembered display when it carries the radar too', () => {
    const r = rig({ left: 'rdr', right: 'rdr', center: 'sa' }, 'right')
    r.press('ddi')
    expect(r.shown()).toBe('right')
  })
  it('keeps the remembered display when no display carries the radar', () => {
    const r = rig({ left: 'chklst', right: 'fuel', center: 'hsi' }, 'center')
    r.press('ddi')
    expect(r.shown()).toBe('center')
  })
  it('opens the radar again on the first 3 of the next mission, and at once if the view is already up', () => {
    const r = rig(aa, 'left')
    r.press('ddi'); r.press('ddi'); r.press('hud')
    r.spawn(); r.press('ddi')
    expect(r.shown()).toBe('right')
    r.press('ddi'); r.spawn()
    expect(r.shown()).toBe('right')
  })
  it('re-arms at every spawn, after the spawn\'s display set is recalled', () => {
    expect(source).toMatch(/\tddi_recall\(\);[^\n]*\n\tddi_fresh=true; if\(cfg\.view==="ddi"\) ddi_open\(\);/)
  })
})

// The TAC and SUPT menus against figure 2-22: each option at its jet pushbutton,
// no legend for a page the game does not build, and the menu's name boxed just
// above MENU (2.13.4.2.1).
describe('the TAC and SUPT menus', () => {
  const menus = new Function(`${/\nconst DDI_MENUS=\{[\s\S]*?\};/.exec(source)?.[0] ?? ''}; return DDI_MENUS`)() as Record<string, [number, string, string][]>
  const built = [...(/\nconst DDI_PAGES=\{([\s\S]*?)\};/.exec(source)?.[1] ?? '').matchAll(/(\w+):\{draw:/g)].map((m) => m[1])
  function run(menu: string, press = 0) {
    return new Function(`let ddi_draws=0, ddi_dirty=false, shown='';
      const ddi_state={ left:{ page:'hud', menu:${JSON.stringify(menu)} } }, DDI_PAGES={}, DDI_MENUS=${JSON.stringify(menus)};
      function cautions_draw(){} function ddi_show(d,p){ shown=p; }
      ${lift('ddi_legend')} ${lift('ddi_render')} ${lift('ddi_press')}
      const text=[], rects=[];
      const x=new Proxy({}, { get:(t,k)=>{ if(k==='fillText') return (s,px,py)=>text.push([String(s),px,py]); if(k==='strokeRect') return (a,b,c,d)=>rects.push([a,b,c,d]); if(k==='measureText') return (s)=>({ width:10*String(s).length }); return ()=>{}; }, set:()=>true });
      if(${press}) ddi_press('left',${press}); else ddi_render(x,512,'left');
      return { text, rects, shown };`)() as { text: [string, number, number][]; rects: [number, number, number, number][]; shown: string }
  }
  it('puts each TAC option at its pushbutton', () => {
    const d = run('tac')
    expect(d.text.filter((t) => t[0] !== 'TAC')).toEqual([['STORES', 10, 96], ['RDR ATTK', 10, 176], ['HUD', 10, 256], ['SA', 502, 256], ['EW', 336, 482], ['MENU', 256, 482]])
  })
  it('puts each SUPT option at its pushbutton', () => {
    const d = run('supt')
    expect(d.text.filter((t) => t[0] !== 'SUPT')).toEqual([['HSI', 10, 336], ['ADI', 10, 416], ['CHKLST', 502, 96], ['ENG', 502, 176], ['FCS', 502, 416], ['FUEL', 96, 482], ['FPAS', 176, 482], ['MENU', 256, 482]])
  })
  it('shows only options the game builds', () => {
    for (const rows of Object.values(menus)) for (const [, , target] of rows) expect(built).toContain(target)
  })
  it('opens the page at the pushbutton the jet has it on', () => {
    expect(run('tac', 5).shown).toBe('sms')
    expect(run('tac', 13).shown).toBe('sa')
    expect(run('supt', 20).shown).toBe('fuel')
    expect(run('supt', 11).shown).toBe('chklst')
    expect(run('tac', 7).shown).toBe('')
    expect(run('supt', 13).shown).toBe('')
  })
  it('boxes the menu name just above MENU', () => {
    for (const [menu, name] of [['tac', 'TAC'], ['supt', 'SUPT']]) {
      const d = run(menu)
      const [, nx, ny] = d.text.find((t) => t[0] === name) ?? []
      expect([nx, ny]).toEqual([256, 446])
      const box = d.rects.find(([bx, by, bw, bh]) => bx < 256 - 5 * name.length && bx + bw > 256 + 5 * name.length && by < 446 && by + bh > 446)
      expect(box).toBeDefined()
      const [, by, , bh] = box!
      expect(by + bh).toBeLessThan(482 - 14)   // clear of the MENU legend's box
    }
  })
})
