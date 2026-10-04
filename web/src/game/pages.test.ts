// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import * as navigate from './navigation'
import * as avionics from './avionics'
import * as autopilot from './autopilot'
import * as communication from './communication'
import * as identification from './identification'
import * as mids from './mids'

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
// navdefs: the navigation suite the pages read (navigation.ts) - aligned and navigating on the INS with GPS
// tracking, TACAN steering selected and no waypoints - and what the jet's sensors measure for it.
const navdefs = `const nav=navigate.fresh(1); navigate.ready(nav,{ x:0, z:0 }); nav.waypoints[0]=null; nav.ins.drift={ x:0, z:0 }; nav.steer="tcn";
  const nav_sense=()=>({ dt:0, x:ownship.pos?ownship.pos.x:0, z:ownship.pos?ownship.pos.z:0, east:0, south:0, tas:ownship.tas??ownship.speed??0, heading:0, pitch:0, bank:0, airborne:!ownship.grounded, brake:false, power:true, radar:false, deck:false, tacan:null });`
interface Drawn { text: [string, number, number][]; rects: [number, number, number, number][]; arcs: [number, number, number][]; rotate: number[]; moves: [number, number][]; styled: [string, number, number][]; lines: [number, number, number, number, string][]; fills: [number, number, number, number, string][]; fonts: [string, string][] }
function page(name: string, setup: string, display = 'left'): Drawn {
  const run = new Function('navigate', `const hold={ engaged:false, modes:{ attitude:false, select:false, barometric:false, radar:false, coupled:false }, source:"track", caution:-Infinity, flash:-Infinity }, link={ selected:false, five:null, six:null }, autopilot={ cue:()=>false, cautions:()=>[], advisories:()=>[] }, hud_link=()=>"", hud_coupled=()=>""; let coupled=""; const master="nav"; const D2R=Math.PI/180, NM=1852, THREE={MathUtils:{clamp:(v,lo,hi)=>Math.min(hi,Math.max(lo,v))}};
    ${setup}
    ${lift('ddi_legend')} ${lift(name)}
    const text=[], rects=[], arcs=[], rotate=[], moves=[], styled=[], lines=[], fills=[], fonts=[]; let style='', fill='', font='', at=[0,0];
    const x=new Proxy({}, { get:(t,k)=>{ if(k==='fillText') return (s,px,py)=>{ text.push([String(s),px,py]); fonts.push([String(s),font]); }; if(k==='strokeRect') return (a,b,c,d)=>rects.push([a,b,c,d]); if(k==='fillRect') return (a,b,c,d)=>fills.push([a,b,c,d,fill]); if(k==='arc') return (ax,ay,r)=>arcs.push([ax,ay,r]); if(k==='rotate') return (a)=>rotate.push(a); if(k==='moveTo') return (mx,my)=>{ moves.push([mx,my]); styled.push([style,mx,my]); at=[mx,my]; }; if(k==='lineTo') return (lx,ly)=>{ lines.push([at[0],at[1],lx,ly,style]); at=[lx,ly]; }; if(k==='measureText') return (s)=>({ width:10*String(s).length }); return ()=>{}; }, set:(t,k,v)=>{ if(k==='strokeStyle') style=v; if(k==='fillStyle') fill=v; if(k==='font') font=v; return true; } });
    ${name}(x, ${JSON.stringify(display)}); return { text, rects, arcs, rotate, moves, styled, lines, fills, fonts };`)
  return run(navigate) as Drawn
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
interface Repeat { pitch?: number; bank?: number; gear?: number; master?: string; declutter?: number; reading?: string; climb?: number; reference?: string; nav?: string }
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
  const names = ['ddi_hud', 'hud_pitch', 'hud_symbols', 'hud_cluster', 'hud_steer', 'closure', 'dir_at', 'gpws_arrow', 'breakaway_shown', 'breakaway']
  return new Function('THREE', 'ownship', 'navigate', `const mc=()=>({ one:true, two:true }), fpas={ climb:false }; const hold={ engaged:false, modes:{ attitude:false, select:false, barometric:false, radar:false, coupled:false }, source:"track", caution:-Infinity, flash:-Infinity }, link={ selected:false, five:null, six:null }, autopilot={ cue:()=>false, cautions:()=>[], advisories:()=>[] }, hud_link=()=>"", hud_coupled=()=>""; let coupled=""; const D2R=Math.PI/180, HH=900, reference=${JSON.stringify(o.reference ?? 'auto')}, world_up=new THREE.Vector3(0,1,0), master=${JSON.stringify(o.master ?? 'nav')}, caged=false, declutter=${o.declutter ?? 0};
    const law_active=false, hud_cue="", sim_time=0, carrier_ols=false, CARRIER={ x:0, z:0 }, SHIP={ ident:"NIM" }, atc_on=false, atc_flash=-99, steering=-1, amraam_visual=false, peak_g=1, last_out=null, STATE={ mach:0 };
    let baro_armed=false, baro_shown=-99, baro_flash=false, baro_set=2992, baro_last=2992;
    const baro_error=()=>0, altitude_reading=()=>(${o.reading ?? '{ feet:9843, radar:false, fallback:false }'}), approach_deviation=()=>null, hud_target=()=>null, wrap_distance=()=>0, wrap_axis=(v)=>v;
    const cheat=()=>false, translate=(s)=>s, timer_text=()=>"", tacan=()=>({ slant:0 }), hud_launch_zone=()=>{};
    ${navdefs} ${o.nav ?? ''}
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
    ddi_hud(x); return { text, rects, lines, arcs, rotations };`)(THREE, ownship, navigate) as Shown
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

// The FUEL display against figure 2-5 and 2.2.10.5, its tanks apportioned from the
// core's two totals by the C/D's transfer order (2.2.3.2, 2.2.3.4 and figure 2-4,
// capacities from figure 2-6), and the FLBIT (2.2.10.3).
const tanksource = (/\nconst FUEL_TANKS=[^\n]*\n/.exec(source)?.[0] ?? '') + lift('fuel_tanks')
interface Tanks { one: number; four: number; feed: { left: number; right: number }; wing: { left: number; right: number }; external: Record<string, number> }
function apportion(internal: number, external: { wing?: number; centre?: number } = {}, aboard: { station: number; capacity: number }[] = [], held: number | null = null): Tanks {
  return new Function('internal', 'external', 'aboard', 'held', `const THREE={MathUtils:{clamp:(v,lo,hi)=>Math.min(hi,Math.max(lo,v))}}; ${tanksource} return fuel_tanks(internal,external,aboard,held);`)(internal, external, aboard, held) as Tanks
}
const sum = (k: Tanks) => k.one + k.four + k.feed.left + k.feed.right + k.wing.left + k.wing.right
describe('the fuel tanks, apportioned', () => {
  it('fills every tank at the full internal load', () => {
    const k = apportion(10810)
    expect([k.one, k.four, k.feed.left, k.feed.right, k.wing.left, k.wing.right]).toEqual([2840, 3620, 1790, 1400, 580, 580])
  })

  it('empties the wings first', () => {
    const k = apportion(10810 - 1160)
    expect([k.wing.left, k.wing.right, k.one, k.four, k.feed.left, k.feed.right]).toEqual([0, 0, 2840, 3620, 1790, 1400])
  })

  it('takes tank 1 to its band, then 1 and 4 down the band together, then 1 empty and 4\'s last', () => {
    const alone = apportion(9650 - 400)
    expect([alone.one, alone.four]).toEqual([2440, 3620])
    const onband = apportion(9650 - 479.25 - 1620 * 1.3875)
    expect(onband.four).toBeCloseTo(2000, 6)
    expect(onband.one).toBeCloseTo(958 + 0.3875 * 2000, 6)
    const late = apportion(9650 - 479.25 - 3495 * 1.3875 - 500)
    expect(late.four).toBeCloseTo(125, 6)
    expect(late.one).toBeCloseTo(958 + 0.3875 * 125 - 500, 6)
    const last = apportion(3190 + 50)
    expect([last.one, last.four, last.feed.left, last.feed.right]).toEqual([0, 50, 1790, 1400])
  })

  it('keeps the feed tanks full to the last, each engine burning its own', () => {
    const k = apportion(2190)
    expect([k.feed.left, k.feed.right, k.one, k.four]).toEqual([1290, 900, 0, 0])
    expect([apportion(390).feed.left, apportion(390).feed.right]).toEqual([390, 0])
  })

  it('never loses or makes fuel', () => {
    for (let internal = 0; internal <= 10810; internal += 37) expect(sum(apportion(internal))).toBeCloseTo(internal, 6)
  })

  it('splits each external quantity over its own tanks, the wing pair together on WING and the centre tank on CTR (2.2.4, #18)', () => {
    const wings = apportion(10810, { wing: 2240 }, [{ station: 3, capacity: 2240 }, { station: 7, capacity: 2240 }])
    expect(wings.external).toEqual({ 3: 1120, 7: 1120 })
    expect(apportion(10810, { centre: 2240 }, [{ station: 5, capacity: 2240 }]).external).toEqual({ 5: 2240 })
    const three = [{ station: 3, capacity: 2240 }, { station: 5, capacity: 2240 }, { station: 7, capacity: 2240 }]
    expect(apportion(10810, { wing: 0, centre: 1000 }, three).external).toEqual({ 3: 0, 5: 1000, 7: 0 }) // WING at STOP while the centre tank feeds
    expect(apportion(10810, { wing: 4480, centre: 0 }, three).external).toEqual({ 3: 2240, 5: 0, 7: 2240 })
    expect(apportion(10810, {}, []).external).toEqual({})
  })

  it('holds the wings\' fuel under INTR WING\'s INHIBIT, the fuselage tanks giving theirs first (2.2.3.3, #18)', () => {
    const held = apportion(10810 - 1160, {}, [], 1160), plain = apportion(10810 - 2320)
    expect([held.wing.left, held.wing.right]).toEqual([580, 580])
    expect([held.one, held.four, held.feed.left, held.feed.right]).toEqual([plain.one, plain.four, plain.feed.left, plain.feed.right])
    expect(sum(held)).toBeCloseTo(10810 - 1160, 6)
    expect([apportion(500, {}, [], 1160).wing.left, apportion(500, {}, [], 1160).one]).toEqual([250, 0]) // never more than is aboard
    expect(apportion(10810, {}, [], 200).wing.left).toBe(580) // less held than NORM leaves: NORM's order stands
  })
})

function fuelpage(over: { internal?: number; external?: number; stations?: number[]; time?: number; flbit?: number } = {}): Drawn {
  const stations = over.stations ?? []
  const lo = Object.fromEntries(stations.map((s) => [String(s), { fixture: 'pylon', stores: ['tank'] }]))
  const centre = stations.length > 0 && stations.every((s) => s === 5)
  return page('ddi_fuel', `const ownship={ gauges:{ fuelRaw:${over.internal ?? 10810}, externalRaw:${over.external ?? 0}, wingRaw:${centre ? 0 : over.external ?? 0}, centreRaw:${centre ? over.external ?? 0 : 0} }, loadout:${JSON.stringify(lo)} };
    const fuel_state={ bingo:3000 }, sim_time=${over.time ?? 100}, flbit=${over.flbit ?? '-Infinity'}, FLBIT_RESULT=10, stores_catalog=()=>null, loadout=()=>({}), wing_held=null;
    ${tanksource} ${lift('fuel_aboard')} ${lift('flbit_running')}`)
}
describe('the FUEL display', () => {
  it('shows TOTAL and INTERNAL at the upper left and the BINGO setting at the upper right, with no title', () => {
    const d = fuelpage({ internal: 9000, external: 1200, stations: [5] })
    expect(at(d, 'TOTAL')).toEqual([20, 64])
    expect(at(d, '10200')).toEqual([20, 90])
    expect(at(d, 'INTERNAL')).toEqual([20, 128])
    expect(at(d, '9000')).toEqual([20, 154])
    expect(at(d, 'BINGO')).toEqual([492, 64])
    expect(at(d, '3000')).toEqual([492, 90])
    for (const gone of ['FUEL', 'LB', 'DUMP', '\u2191', '\u2193']) expect(texts(d)).not.toContain(gone)
    expect(texts(d).some((s) => /^(FF|EXT|TIME) /.test(s))).toBe(false)
  })

  it('boxes each tank with its pounds, the externals only where one is carried', () => {
    const d = fuelpage({ internal: 10810, external: 2240, stations: [3, 7] })
    const shown = (label: string, cx: number, cy: number, pounds: string) => {
      expect(at(d, label)).toEqual([cx, cy - 26])
      expect(d.rects).toContainEqual([cx - 44, cy - 15, 88, 30])
      expect(d.text).toContainEqual([pounds, cx, cy])
    }
    shown('TK 1', 256, 96, '2840'); shown('L FD', 256, 166, '1790'); shown('R FD', 256, 236, '1400'); shown('TK 4', 256, 306, '3620')
    shown('L WG', 100, 236, '580'); shown('R WG', 412, 236, '580')
    shown('L EXT', 120, 392, '1120'); shown('R EXT', 392, 392, '1120')
    expect(texts(d)).not.toContain('C/L')
    expect(texts(fuelpage())).not.toContain('L EXT')
  })

  it('puts each tank\'s caret up its right side with its fill', () => {
    const caret = (d: Drawn, cx: number) => d.moves.find(([mx]) => mx === cx + 56)
    const full = fuelpage({ internal: 10810 }), drawn = fuelpage({ internal: 10810 - 1420 }) // both wings empty, then 260 lb of tank 1
    expect(caret(full, 256)![1]).toBeCloseTo(96 - 15 - 6, 6) // TK 1 full: at the top
    expect(caret(drawn, 100)![1]).toBeCloseTo(236 + 15 - 6, 6) // L WG empty: at the bottom
    expect(caret(drawn, 256)![1]).toBeCloseTo(96 + 15 - 30 * 2580 / 2840 - 6, 6) // TK 1 at 2,580 of 2,840
  })

  it('boxes FLBIT while the test runs', () => {
    const running = fuelpage({ flbit: 95 }), idle = fuelpage()
    expect(at(running, 'FLBIT')).toEqual([96, 482])
    expect(running.rects.some(([bx, by]) => by === 482 - 14 && bx === 96 - 25 - 6)).toBe(true)
    expect(idle.rects.some(([, by]) => by === 482 - 14)).toBe(false)
  })
})

describe('the fuel low BIT', () => {
  const flbits = (/\nlet flbit=-Infinity;\nconst FLBIT_RESULT=[^\n]*\n/.exec(source)?.[0] ?? '') + lift('flbit_running') + lift('flbit_lit') + lift('fuel_press')
  const run = (steps: string) => new Function(`let sim_time=0; const fuel_lo={ on:false }; ${flbits} ${steps}`)() as unknown[]
  it('raises FUEL LO within 13 s of the press and holds it the minute any FUEL LO holds', () => {
    expect(flbits).toMatch(/^\nlet flbit=/)
    expect(run('const r=[fuel_press(20)]; for(const t of [5,9.9,10,69.9,70]){ sim_time=t; r.push(flbit_running(), flbit_lit()); } return r;'))
      .toEqual([true, true, false, true, false, false, true, false, true, false, false])
  })

  it('is inoperative while FUEL LO is up, or while it runs, and the page has no BINGO arrows', () => {
    expect(run('fuel_lo.on=true; return [fuel_press(20)];')).toEqual([false])
    expect(run('fuel_press(20); sim_time=5; const again=fuel_press(20); sim_time=30; return [again, fuel_press(20)];')).toEqual([false, false])
    expect(run('return [fuel_press(3), fuel_press(4)];')).toEqual([false, false])
  })

  it('carries its FUEL LO through the caution, the light and the voice, and clears at a spawn', () => {
    const section = /\n\tlet low=false, below=false;[\s\S]*?\n\t\tif\(below\) push\("BINGO"\); \}/.exec(source)?.[0] ?? ''
    expect(section).not.toBe('')
    const rows = (fuel: number, low: boolean, lit: boolean) => new Function(`const rows=[], push=(k)=>rows.push(k), cheat=()=>false, fuel_lo={ on:${low} }, BINGO=1361, ownship={ fuel:${fuel} }, flbit_lit=()=>${lit}; ${section} return [rows, low, below];`)() as [string[], boolean, boolean]
    expect(rows(3000, false, true)).toEqual([['FUEL LO'], false, false]) // the test's FUEL LO, the fuel itself above both
    expect(rows(3000, false, false)).toEqual([[], false, false])
    expect(rows(500, true, false)).toEqual([['FUEL LO', 'BINGO'], true, true]) // both, as their own conditions
    expect(source).toMatch(/lamp_set\(l\.fuello,fuel_low\(\)\);/)
    expect(source).toMatch(/function fuel_low\(\)\{ return fuel_lo\.on\|\|flbit_lit\(\); \}/)
    expect(source).toMatch(/\n\tflbit=-Infinity; fuel_lo\.on=false; fuel_lo\.at=-Infinity;[^\n]*\n\tbaro_armed=false;/)
  })
})

// The FCS status display against figure 2-16 (C/D) and 2.8.4.7. The core's words:
// STAB 0/1, AIL 2/3, RUD 4, LEF 5, TEF 6, jams from 10 in the harness's layout.
function fcspage(words: number[], o: { gross?: number; fuel?: number; aoa?: number; jams?: number[]; reference?: string } = {}): Drawn {
  const out = [...words.map((w) => w * Math.PI / 180), 0, 0, 0]
  for (const j of o.jams ?? []) out[10 + j] = 0.9
  return page('ddi_fcs', `const STATE={ stabilator:0, flaperon:2, rudder:4, slat:5, flap:6, jam:10 }, last_out=${JSON.stringify(out)}; ${/\nconst TEF_FULL=[^\n]*\n/.exec(source)?.[0] ?? ''} ${lift('flap_shown')} ${lift('droop_shown')}
    const ownship={ aoa:${o.aoa ?? 4.2}, gauges:{ fuelRaw:${o.fuel ?? 9000}, externalRaw:0 } }, gross_weight=()=>${o.gross ?? 30000}, reference=${JSON.stringify(o.reference ?? 'auto')};`)
}
describe('the FCS status display', () => {
  const words = [3, -4, 15, -15, 5, 1, 0, 0, 0, 0] // STAB 3 TED / 4 TEU, AIL 15 TED / 15 TEU, RUD 5 left, LEF 1 LED, the flaps up
  const line = (d: Drawn, want: number[]) => d.lines.some((l) => want.every((v, i) => Math.abs(v - (l[i] as number)) < 1e-9))

  it('lists LEF, TEF, AIL, RUD and STAB down the middle, each side\'s degrees unsigned beside it, with no title or extras', () => {
    const d = fcspage(words)
    const rows: [string, number, string, string][] = [['LEF', 56, '1', '1'], ['TEF', 80, '0', '0'], ['AIL', 128, '15', '15'], ['RUD', 152, '5', '5'], ['STAB', 176, '3', '4']]
    for (const [label, y, left, right] of rows) {
      expect(at(d, label)).toEqual([256, y])
      expect(d.text).toContainEqual([left, 190, y])
      expect(d.text).toContainEqual([right, 314, y])
    }
    for (const gone of ['FCS']) expect(texts(d)).not.toContain(gone)
    expect(texts(d).some((s) => /^(SPD BRK|TRIM|ROLL) |°|^-\d/.test(s))).toBe(false)
  })

  // The flight core's flap is a camber model, 26° at FULL and two thirds of it at HALF (fa18c.go): the display
  // writes the jet's angles for them (2.8.3).
  it('writes the jet\'s flap angle: 45 at FULL and 30 at HALF', () => {
    const tef = (core: number) => fcspage([0, 0, core, core, 0, 12, core]).text.find((t) => t[1] === 190 && t[2] === 80)?.[0]
    expect([tef(26), tef(26 * 2 / 3), tef(13), tef(0)]).toEqual(['45', '30', '23', '0'])
  })
  it('writes the ailerons drooped with the flaps, 42 at FULL and 30 at HALF, each with its own deflection on top', () => {
    const ail = (core: number, left = 0, right = 0) => { const d = fcspage([0, 0, core + left, core + right, 0, 12, core]); return [190, 314].map((x) => d.text.find((t) => t[1] === x && t[2] === 128)?.[0]) }
    expect(ail(26)).toEqual(['42', '42']); expect(ail(26 * 2 / 3)).toEqual(['30', '30']); expect(ail(0)).toEqual(['0', '0'])
    expect(ail(26, 10, -10)).toEqual(['52', '32']) // a roll command over the droop
    expect(ail(0, 15, -15)).toEqual(['15', '15'])
  })
  it('points each arrow the way the surface has gone from neutral', () => {
    const d = fcspage(words)
    expect(line(d, [176, 170, 176, 182])).toBe(true) // left STAB trailing edge down: the arrow points down
    expect(line(d, [300, 182, 300, 170])).toBe(true) // right STAB trailing edge up: up
    expect(line(d, [176, 50, 176, 62])).toBe(true) // LEF leading edge down: down
    expect(line(d, [182, 152, 170, 152])).toBe(true) // RUD trailing edge left: left
    expect(line(fcspage([0, 0, 0, 0, -5, 0, 0]), [170, 152, 182, 152])).toBe(true) // and right
  })

  it('puts a bold X through the number of a surface the FCC no longer commands', () => {
    const d = fcspage(words, { jams: [2] })
    expect(line(d, [186, 117, 216, 139])).toBe(true) // the left AIL
    expect(line(d, [310, 117, 340, 139])).toBe(false)
    expect(line(fcspage(words), [186, 117, 216, 139])).toBe(false)
  })

  it('boxes the channels: LEF, AIL and RUD on 1 and 4 at the left and 2 and 3 at the right, TEF and STAB on all four', () => {
    const d = fcspage(words)
    const box = (bx: number, by: number) => d.rects.some(([rx, ry, w, h]) => rx === bx && ry === by && w === 24 && h === 24)
    for (const y of [44, 116, 140]) {
      expect([box(40, y), box(64, y), box(88, y), box(112, y)]).toEqual([true, false, false, true])
      expect([box(376, y), box(400, y), box(424, y), box(448, y)]).toEqual([false, true, true, false])
    }
    for (const y of [68, 92, 164, 188]) for (const left of [40, 376]) for (let c = 0; c < 4; c++) expect(box(left + 24 * c, y)).toBe(true)
    expect(texts(d).filter((s) => s === 'SV1')).toHaveLength(4)
  })

  it('lists the CAS and sensor channels at the lower right, clear', () => {
    const d = fcspage(words)
    for (const name of ['CAS', 'P', 'R', 'Y', 'N ACC', 'L ACC', 'STICK', 'PEDAL', 'AOA', 'BADSA', 'PROC', 'DEGD']) expect(texts(d)).toContain(name)
    expect(d.rects.filter(([rx, , w, h]) => rx >= 376 && rx < 456 && w === 20 && h === 18)).toHaveLength(44)
  })

  it('crosses PROC channels 1 and 3 with the ATT switch at STBY, the FCCs off the INS attitude, and nothing at AUTO or INS (2.13.4.8.9, #11)', () => {
    const crossed = (d: Drawn) => [376, 396, 416, 436].map((left) => line(d, [left + 3, 405, left + 17, 417]) && line(d, [left + 17, 405, left + 3, 417]))
    expect(crossed(fcspage(words, { reference: 'stby' }))).toEqual([true, false, true, false])
    expect(crossed(fcspage(words, { reference: 'auto' }))).toEqual([false, false, false, false])
    expect(crossed(fcspage(words, { reference: 'ins' }))).toEqual([false, false, false, false])
  })

  it('shows the FCS\'s own g limit, crossed out under 3,300 lb of fuel or over 44,000 lb gross', () => {
    const cross = (d: Drawn) => line(d, [98, 276, 160, 304])
    const light = fcspage(words)
    expect(at(light, 'G-LIM 7.5G')).toEqual([20, 290])
    expect(cross(light)).toBe(false)
    const heavy = fcspage(words, { gross: 46000 })
    expect(texts(heavy)).toContain('G-LIM 5.3G') // 7.5 x 32,357 / 46,000
    expect(cross(heavy)).toBe(true)
    expect(cross(fcspage(words, { fuel: 2800 }))).toBe(true)
  })

  it('reads the L, INS and R AoA along the bottom', () => {
    const d = fcspage(words, { aoa: 11.25 })
    expect(at(d, 'L 11.3')).toEqual([90, 456])
    expect(at(d, 'R 11.3')).toEqual([360, 456])
    expect(at(d, 'AOA 11.3')).toEqual([236, 456])
    expect(d.rects.some(([, ry, , h]) => ry === 444 && h === 24)).toBe(true) // the INS readout boxed
  })
})

// The checklist display against figure 7-1 (NATOPS 7.2.1) for the C, and the landing
// record its MAX NZ reads.
function chklst(o: { stab?: [number, number]; gross?: number; nz?: number | null } = {}): Drawn {
  const [l, r] = o.stab ?? [-12, -12]
  return page('ddi_chklst', `const STATE={ stabilator:0 }, last_out=[${l}*D2R, ${r}*D2R], gross_pounds=()=>${o.gross ?? 32512.4}, landing={ nz:${o.nz === undefined ? 1.834 : o.nz} };`)
}
describe('the checklist display', () => {
  it('lists LAND at the left and T.O. at the right as figure 7-1 does, the C without EJECT SEL', () => {
    const d = chklst()
    expect(at(d, 'LAND')).toEqual([60, 72])
    expect(at(d, 'T.O.')).toEqual([286, 72])
    const land = ['WHEELS', 'FLAPS', 'HOOK', 'ANTI SKID', 'HARNESS', 'DISPENSER'], takeoff = ['CONTROLS', 'WINGS', 'TRIM', 'FLAPS', 'HOOK', 'HARNESS', 'WARN LITES', 'NWS LO', 'SEAT ARM']
    land.forEach((item, i) => expect(d.text).toContainEqual([item, 84, 100 + 22 * i]))
    takeoff.forEach((item, i) => expect(d.text).toContainEqual([item, 310, 100 + 22 * i]))
    for (const gone of ['EJECT SEL', 'CHKLST', 'T/O', 'LDG', 'GEAR', 'CANOPY', 'PARK BRK', 'ON SPEED', 'LDG WT']) expect(texts(d)).not.toContain(gone)
    expect(texts(d).some((s) => /^(VAPP|VS0|CAT|WT) /.test(s))).toBe(false)
    expect(d.rects).toEqual([]) // no boxes: the pilot checks by eye
  })

  it('gives the gross weight to the pound and the last landing\'s MAX NZ under LAND', () => {
    const d = chklst()
    expect(at(d, 'A/C WT 32512')).toEqual([84, 300])
    expect(at(d, 'MAX NZ 1.83')).toEqual([84, 366])
    expect(texts(chklst({ nz: null })).some((s) => s.startsWith('MAX NZ'))).toBe(false)
  })

  it('reads the stabilators along the bottom in degrees nose up or down', () => {
    expect(at(chklst(), '12° NU STAB POS 12° NU')).toEqual([256, 410])
    expect(texts(chklst({ stab: [3, -2] }))).toContain('3° ND STAB POS 2° NU')
  })
})

describe('the landing record', () => {
  const block = (/\nconst landing=\{[^\n]*\n/.exec(source)?.[0] ?? '') + lift('landing_track')
  const run = (steps: [number, boolean, number][]) => new Function('steps', `let sim_time=0; ${block}
    return steps.map(([t,grounded,nz])=>{ sim_time=t; landing_track(grounded,nz); return landing.nz; });`)(steps) as (number | null)[]

  it('takes the peak vertical g over the first 3 s from the wheels touching', () => {
    expect(block).toMatch(/^\nconst landing=/)
    expect(run([[0, false, 1], [1, true, 1.5], [1.5, true, 2.1], [2, true, 1.2], [4.5, true, 3]])).toEqual([null, 1.5, 2.1, 2.1, 2.1])
  })

  it('starts again at the next touchdown, and counts none for a jet that spawned on the deck', () => {
    expect(run([[0, false, 1], [1, true, 2.4], [10, false, 1], [20, true, 1.6]])).toEqual([null, 2.4, 2.4, 1.6])
    expect(run([[0, true, 1], [1, true, 1]])).toEqual([null, null])
  })

  it('follows the core\'s weight on wheels each step, clears at a spawn, and leaves the other judgements the weight to the ten', () => {
    expect(source).toMatch(/\n\township\.grounded=out\[STATE\.wow\]>0\.5;\n\tlanding_track\(ownship\.grounded,ownship\.gload\?\?1\);/)
    expect(source).toMatch(/\n\tlanding\.nz=null; landing\.grounded=true;/)
    expect(new Function(`const gross_pounds=()=>32512.4; ${lift('gross_weight')}\n return gross_weight();`)()).toBe(32510)
  })
})

// The FPAS display against NATOPS 2.3.1 and figure 2-7.
interface Fpas { total?: number; pph?: number; gs?: number; mach?: number; grounded?: boolean; home?: string; time?: number; steer?: string; cruise?: string; homing?: number; climbing?: boolean }
function fpas(o: Fpas = {}): Drawn {
  return page('ddi_fpas', `const ownship={ grounded:${o.grounded ?? false}, gauges:{ fuelRaw:${o.total ?? 8000}, externalRaw:0, ground:${o.gs ?? 400}, mach:${o.mach ?? 0.7} } };
    ${navdefs} nav.steer=${JSON.stringify(o.steer ?? 'tcn')}; nav.home=${o.homing ?? 0};
    const fpas={ climb:${o.climbing ?? false} }, flow_state={ pph:${o.pph ?? 6000} }, sim_time=${o.time ?? 0}, fpas_steer=()=>(${o.home ?? '{ dist:160, hours:0.3958, arrive:5620, name:"TCN" }'}), fpas_cruise=()=>(${o.cruise ?? '{ best:null, optimum:null, tail:0 }'});`)
}
// fpasdefs: the FPAS's own functions over stand-ins for the gauges, the burn and the steering
const fpasdefs = `${navdefs} ${/\nconst fpas=\{[^\n]*\n/.exec(source)?.[0] ?? ''} ${lift('fpas_leg')} ${lift('fpas_home')} ${lift('fpas_steer')} ${lift('fpas_press')} ${lift('fpas_cruise')}`
describe('the FPAS display', () => {
  it('lays out the CURRENT and OPTIMUM areas, the steering row and the home waypoint as figure 2-7 does', () => {
    const d = fpas()
    expect(at(d, 'CURRENT')).toEqual([261, 40]); expect(at(d, 'RANGE')).toEqual([261, 68]); expect(at(d, 'ENDURANCE')).toEqual([408, 68])
    expect(d.text.filter(([t]) => t === 'TO 2000 LB').map(([, px, py]) => [px, py])).toEqual([[36, 96], [36, 144], [36, 346]])
    expect(at(d, 'BEST MACH')).toEqual([36, 120])
    expect(d.text).toContainEqual(['400', 261, 96]) // 6,000 lb spare at 6,000 pph and 400 kt
    expect(d.text).toContainEqual(['1:00', 408, 96])
    for (const [label, cx] of [['NAV TO', 66], ['TIME', 190], ['FUEL REMAIN', 330], ['LB/NM', 446]] as [string, number][]) expect(at(d, label)).toEqual([cx, 176])
    expect(d.text).toContainEqual(['TCN', 66, 202])
    expect(d.text).toContainEqual(['5620', 330, 202])
    expect(d.text).toContainEqual(['15', 446, 202]) // 6,000 pph over 400 kt
    expect(at(d, 'OPTIMUM')).toEqual([261, 244]); expect(at(d, 'ALTITUDE')).toEqual([36, 298]); expect(at(d, 'MACH')).toEqual([36, 322])
    expect(at(d, 'HOME')).toEqual([376, 462]); expect(d.text).toContainEqual(['0', 376, 440])
    expect(at(d, '↓')).toEqual([336, 482]); expect(at(d, '↑')).toEqual([416, 482])
    for (const gone of ['FPAS', 'ENGINES DEAD', 'HOME FUEL', 'FLOW']) expect(texts(d)).not.toContain(gone)
  })

  it('computes to 0 lb below 2,500 lb of fuel', () => {
    const d = fpas({ total: 2400, pph: 2400, gs: 300 })
    expect(texts(d)).toContain('TO 0 LB')
    expect(d.text).toContainEqual(['300', 261, 96]) // all 2,400 lb at 2,400 pph and 300 kt
    expect(d.text).toContainEqual(['1:00', 408, 96])
  })

  it('reads MACH under RANGE and LIM under ENDURANCE above Mach 0.9, and blanks the arrival fuel', () => {
    const d = fpas({ mach: 0.95 })
    expect(d.text).toContainEqual(['MACH', 261, 96])
    expect(d.text).toContainEqual(['LIM', 408, 96])
    expect(d.text.some(([, px, py]) => px === 330 && py === 202)).toBe(false)
  })

  it('shows arrival fuel below zero as 0, and writes the times as figure 2-7 does', () => {
    expect(fpas({ home: '{ dist:300, hours:0.75, arrive:-400, name:"TCN" }' }).text).toContainEqual(['0', 330, 202])
    const d = fpas()
    expect(d.text).toContainEqual([':23:45', 190, 202]) // 0.3958 h
    expect(fpas({ pph: 6000, total: 2000 + 2900 }).text).toContainEqual([':29', 408, 96])
    expect(fpas({ home: '{ dist:600, hours:1.25, arrive:3000, name:"TCN" }' }).text).toContainEqual(['1:15:00', 190, 202])
  })

  it('flashes NAV TO, the TO legend and the fuel when the arrival fuel is under the reserve', () => {
    const low = '{ dist:300, hours:0.75, arrive:1500, name:"TCN" }'
    const on = texts(fpas({ home: low, time: 0 })), off = texts(fpas({ home: low, time: 0.3 }))
    for (const s of ['TCN', 'TO 2000 LB', '1500']) { expect(on).toContain(s); expect(off).not.toContain(s) }
    expect(texts(fpas({ time: 0.3 }))).toContain('TCN') // steady when the fuel is enough
  })

  it('reads XXXX on the deck or with the engines not burning', () => {
    const deck = fpas({ grounded: true, home: 'null', gs: 0, cruise: cruise.replace('TAIL', '0') }) // whatever the cruise search would find
    expect(d_at(deck, 261, 96)).toBe('XXXX'); expect(d_at(deck, 408, 96)).toBe('XXXX'); expect(d_at(deck, 190, 202)).toBe('XXXX')
    expect(d_at(fpas({ pph: 0, home: 'null' }), 408, 96)).toBe('XXXX')
    for (const y of [120, 144, 298, 322, 346]) for (const x of [261, 408]) expect(d_at(deck, x, y)).toBe('XXXX') // no cruise figures either
  })

  it('names the waypoint steered to on the steering row, and leaves the row empty with no steering', () => {
    expect(fpas({ steer: 'wypt', home: '{ dist:40, hours:0.1, arrive:7000, name:"WYPT 3" }' }).text).toContainEqual(['WYPT 3', 66, 202])
    const none = fpas({ steer: '', home: 'null' })
    for (const x of [66, 190, 330]) expect(d_at(none, x, 202)).toBeUndefined()
  })

  // 6,000 lb to the reserve. Best range: 0.5 kg/s is 3,968 lb/h, so 1.512 h at 230 m/s (447 kt) is 676 nm; best
  // endurance: 0.4 kg/s is 3,175 lb/h, 1:53. The optimum's 0.45 kg/s at 235 m/s gives 767 nm, and 0.36 kg/s 2:06.
  const cruise = `{ best:{ range:{ flow:0.5, speed:230, mach:0.78, altitude:9000 }, endurance:{ flow:0.4, speed:190, mach:0.64, altitude:9000 } },
    optimum:{ range:{ flow:0.45, speed:235, mach:0.8, altitude:11277.6 }, endurance:{ flow:0.36, speed:200, mach:0.68, altitude:10058.4 } }, tail:TAIL }`
  it('shows the best Mach for range and endurance at this altitude, and what each gives (2.3.1.1.2, 2.3.1.1.3)', () => {
    const d = fpas({ cruise: cruise.replace('TAIL', '0') })
    expect(d.text).toContainEqual(['.78', 261, 120]); expect(d.text).toContainEqual(['.64', 408, 120])
    expect(d.text).toContainEqual(['676', 261, 144]); expect(d.text).toContainEqual(['1:53', 408, 144])
  })

  it('shows the optimum altitude and Mach for range and endurance, and what each gives (2.3.1.1.4, 2.3.1.1.5)', () => {
    const d = fpas({ cruise: cruise.replace('TAIL', '0') })
    expect(d.text).toContainEqual(['37000', 261, 298]); expect(d.text).toContainEqual(['33000', 408, 298])
    expect(d.text).toContainEqual(['.80', 261, 322]); expect(d.text).toContainEqual(['.68', 408, 322])
    expect(d.text).toContainEqual(['767', 261, 346]); expect(d.text).toContainEqual(['2:06', 408, 346])
  })

  it('counts the wind along the track in the ranges, and never in the endurances', () => {
    const d = fpas({ cruise: cruise.replace('TAIL', '-23') }) // 23 m/s on the nose: 207 m/s over the ground
    expect(d.text).toContainEqual(['608', 261, 144]); expect(d.text).toContainEqual(['1:53', 408, 144])
  })

  it('finds the leg to a point at the present groundspeed and burn, or none on deck, hovering or not burning', () => {
    const leg = (own: string, pph = 6000) => new Function('navigate', `const ownship=${own}, flow_state={ pph:${pph} }, cheat=()=>false; ${lift('fpas_leg')} return fpas_leg(185200);`)(navigate)
    expect(leg('{ grounded:false, gauges:{ ground:400, fuelRaw:6000, externalRaw:0 } }')).toEqual({ dist: 100, hours: 0.25, arrive: 4500 })
    expect(leg('{ grounded:true, gauges:{ ground:400, fuelRaw:6000, externalRaw:0 } }')).toBe(null)
    expect(leg('{ grounded:false, gauges:{ ground:40, fuelRaw:6000, externalRaw:0 } }')).toBe(null)
    expect(leg('{ grounded:false, gauges:{ ground:400, fuelRaw:6000, externalRaw:0 } }', 100)).toBe(null)
  })

  it('steers to the TACAN on its range or to the waypoint selected, and watches the home waypoint', () => {
    const run = (body: string) => new Function('navigate', `const ownship={ grounded:false, pos:{ x:0, z:0 }, gauges:{ ground:400, fuelRaw:6000, externalRaw:0 } }, flow_state={ pph:6000 }, cheat=()=>false;
      let station={ bearing:0, range:185200, slant:185300 }; const tacan=()=>station, hud_steer=()=>({ range:92600, target:false });
      ${fpasdefs} ${body}`)(navigate)
    expect(run('return fpas_steer();')).toEqual({ dist: 100, hours: 0.25, arrive: 4500, name: 'TCN' })
    expect(run('station={ bearing:0, range:null, slant:null }; return fpas_steer();')).toBe(null)
    expect(run('station=null; return fpas_steer();')).toBe(null)
    expect(run('nav.steer="wypt"; nav.current=3; return fpas_steer();')).toEqual({ dist: 50, hours: 0.125, arrive: 5250, name: 'WYPT 3' })
    expect(run('nav.steer=""; return fpas_steer();')).toBe(null)
    expect(run('return fpas_home();')).toBe(null) // no home waypoint stored
    expect(run('nav.waypoints[0]={ x:0, z:-370400, elevation:0, name:"", offset:null }; return fpas_home();')).toEqual({ dist: 200, hours: 0.5, arrive: 3000 })
    expect(run('nav.waypoints[7]={ x:185200, z:0, elevation:0, name:"", offset:null }; nav.home=7; return fpas_home().dist;')).toBeCloseTo(100, 9)
  })

  it('offers CLIMB at the lower left in the NAV master mode, boxed while it is selected (2.3.1.1.8, figure 2-7)', () => {
    const climbed = (d: Drawn) => d.rects.some(([bx, by]) => by === 482 - 14 && bx === 96 - 25 - 6)
    expect(at(fpas(), 'CLIMB')).toEqual([96, 482])
    expect(climbed(fpas())).toBe(false)
    expect(climbed(fpas({ climbing: true }))).toBe(true)
    expect(source).toMatch(/\n\tif\(master==="nav"\) ddi_legend\(x,20,"CLIMB",true,fpas\.climb\); \}/) // and removed outside it
  })

  it('selects and deselects CLIMB from its pushbutton in NAV, and not outside it', () => {
    const run = (body: string) => new Function('navigate', `const ownship={ grounded:false, pos:{ x:0, z:0 }, gauges:{} }, flow_state={ pph:0 }, cheat=()=>false, tacan=()=>null, hud_steer=()=>null; let sim_time=40, master="nav";
      ${fpasdefs} ${body}`)(navigate)
    expect(run('return [fpas_press(20), fpas.climb, fpas_press(20), fpas.climb];')).toEqual([true, true, true, false])
    expect(run('master="gun"; return [fpas_press(20), fpas.climb];')).toEqual([false, false])
  })

  it('hands the FPAS no climb where the core has none: the bridge reads its refusal, a negative rate, as null', () => {
    // flight.ts imports @mochi/web, which vitest cannot load, so the binding is read as text, as the other bridge checks are
    const bridge = readFileSync(fileURLToPath(new URL('./flight.ts', import.meta.url)), 'utf8')
    const binding = /\nexport function flight_climb\(altitude: number\)[^\n]*\{\n([\s\S]*?)\n\}\n/.exec(bridge)?.[1] ?? ''
    expect(binding).toMatch(/^ {2}const result = core\?\.climb\?\.\(altitude\)\n {2}if \(!Array\.isArray\(result\) \|\| !\(result\[1\] >= 0\)\) return null\n {2}return \{ speed: result\[0\], rate: result\[1\], calibrated: result\[2\] \}$/)
  })

  it('asks the flight core for the climb airspeed every two seconds, at the present height', () => {
    const run = new Function(`const asked=[]; const flight_climb=(altitude)=>{ asked.push(altitude); return { speed:260, rate:80, calibrated:200 }; }; const ownship={ pos:{ y:3000 } }; let sim_time=40;
      ${/\nconst fpas=\{[^\n]*\n/.exec(source)?.[0] ?? ''} ${lift('fpas_climb')}
      const first=fpas_climb(); sim_time=41.5; fpas_climb(); sim_time=42; ownship.pos.y=-5; fpas_climb();
      return { first, asked };`)
    expect(run()).toEqual({ first: { speed: 260, rate: 80, calibrated: 200 }, asked: [3000, 0] })
  })

  it('steps the home waypoint round the waypoints with its arrows, and notes the change', () => {
    const run = (body: string) => new Function('navigate', `const ownship={ grounded:false, pos:{ x:0, z:0 }, gauges:{} }, flow_state={ pph:0 }, cheat=()=>false, tacan=()=>null, hud_steer=()=>null; let sim_time=40;
      ${fpasdefs} ${body}`)(navigate)
    expect(run('return [fpas_press(16), nav.home, fpas.changed, fpas_press(17), fpas_press(17), nav.home, fpas_press(5)];')).toEqual([true, 1, 40, true, true, 59, false])
    expect(run('nav.home=59; fpas_press(16); return nav.home;')).toBe(0)
  })

  it('searches the cruise: the best Mach every two seconds, and the optimum from a survey that starts over when done', () => {
    const run = new Function('navigate', `const ownship={ grounded:false, pos:{ x:0, y:6000, z:0 }, speed:200, gauges:{ ground:400, pitch:0 } }, flow_state={ pph:6000 }, cheat=()=>false, tacan=()=>null, hud_steer=()=>null;
      let sim_time=0, looks=0; const flight_cruise=(altitude,mach)=>{ looks++; return altitude>12000?null:{ flow:0.5+(mach-0.6)*(mach-0.6)+Math.abs(altitude-9000)/90000, speed:mach*300 }; };
      ${fpasdefs}
      const first=fpas_cruise(), counted=looks; fpas_cruise(); const second=looks-counted;
      sim_time=2.5; fpas_cruise(); const third=looks-counted-second;
      for(let k=0;k<60;k++) fpas_cruise();
      return { first, second, third, calls:counted, optimum:fpas.optimum, layers:fpas.survey.altitude };`)(navigate) as { first: { best: { range: navigate.Best; endurance: navigate.Best }; optimum: unknown; tail: number }; second: number; third: number; calls: number; optimum: navigate.Survey; layers: number }
    expect(run.first.best.endurance.mach).toBeCloseTo(0.6, 9)
    expect(run.first.best.range.altitude).toBe(6000)
    expect(run.first.optimum).toBe(null) // the survey has not finished
    expect(run.first.tail).toBeCloseTo(400 * 0.514444 - 200, 6)
    expect(run.second).toBeLessThan(run.calls / 1.5) // within two seconds only the survey's next layer is searched
    expect(run.third).toBeGreaterThan(run.second) // past two seconds the best Mach is found afresh
    expect(run.optimum.done).toBe(true)
    expect(run.optimum.endurance?.altitude).toBeCloseTo(30000 * 0.3048, 6) // the layer nearest 9 km
    expect(run.optimum.endurance?.mach).toBeCloseTo(0.6, 9)
    expect(run.layers).toBeGreaterThan(0) // and the next survey is under way
  })

  it('holds the HOME FUEL caution off with the refuelling probe out, and for 5 s after the home waypoint is changed', () => {
    const section = /\n\t\{ const home=fpas_home\(\); if\(home&&home\.arrive<=2000[^\n]*push\("HOME FUEL"\); \}/.exec(source)?.[0] ?? ''
    expect(section).not.toBe('')
    const run = (probe: number, target: number, since = 100) => new Function(`const rows=[], push=(k)=>rows.push(k), fpas_home=()=>({ arrive:1800 }), fpas={ changed:${100 - since} }, sim_time=100, ownship={ probe:${probe}, probeTarget:${target} }; ${section} return rows;`)() as string[]
    expect(run(0, 0)).toEqual(['HOME FUEL'])
    expect(run(1, 1)).toEqual([])
    expect(run(0.3, 1)).toEqual([]) // extending
    expect(run(0, 0, 4)).toEqual([])
    expect(run(0, 0, 5)).toEqual(['HOME FUEL'])
  })
})
const d_at = (d: Drawn, x: number, y: number) => d.text.find(([, px, py]) => px === x && py === y)?.[0]

// The HSI against 2.13.4.7, 24.1.3 and figures 2-24 and 24-2. Marks inside the
// rose are recorded relative to the aircraft (the translated frame); the aircraft
// symbol and the text on the page.
interface Hsi { computer?: boolean; tas?: number; altitude?: number; heading?: number; track?: number | null; ground?: number; speed?: number; scale?: number; dctr?: boolean; north?: boolean; mode?: boolean; level?: string; map?: boolean; timer?: string; east?: number; north_m?: number; wrap?: string; tacan?: string; emcon?: boolean; nav?: string; time?: number; func?: string }
function hsi(o: Hsi = {}, display = 'left'): Drawn {
  const deg = (v: number | null | undefined, d: number) => v === null ? 'null' : `${(v ?? d)}*D2R`
  return page('ddi_hsi', `const ownship={ pos:{x:0,y:${o.altitude ?? 1000},z:0}, speed:${o.speed ?? 100}, tas:${o.tas ?? 'undefined'}, gauges:{ heading:${deg(o.heading, 0)}, ground:${o.ground ?? 200}, track:${deg(o.track, 0)}, zulu:45296 } };
    const hsi_state={ scale:${o.scale ?? 40}, dctr:${o.dctr ?? false}, map:${o.map ?? false}, north:${o.north ?? false}, level:${JSON.stringify(o.mode ? 'mode' : o.level ?? '')}, data:"wypt", shown:0, check:false, gps:{ cursor:0, asked:-1e9 } }, ufc={ func:${JSON.stringify(o.func ?? '')} }, CARRIER={ x:${o.east ?? 18520}, z:${-(o.north_m ?? 0)} };
    const sim_time=${o.time ?? 0}, carrier_given={ heading:0, speed:0 }, hsi_data=()=>{ throw new Error("the data sublevel drawn"); }, mc=()=>({ one:${o.computer ?? true}, two:true }); ${navdefs} ${o.nav ?? ''}
    const island_polygons=[], airports=[], wrap_axis=${o.wrap ?? '(v)=>v'}, SHIP={ ident:"NIM", tacan:{ channel:74, band:"X" } }, timer={ shown:${JSON.stringify(o.timer ?? '')} }, timer_text=()=>"01:30";
    const radios={ tacan:{ on:true, channel:74, band:"X", mode:"tr", air:false, ...${o.tacan ?? '{}'} } }, emcon=${o.emcon ?? false};
    ${lift('tacan')} ${lift('tacan_variation')} ${lift('hsi_chart')} ${lift('time_to_go')}`, display)
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
    const steps = new Function('navigate', `const HSI_SCALES=[5,10,20,40,80,160], hsi_state={ scale:40, level:"" }, ufc_press=()=>{}, ownship={}, mc=()=>({ one:true, two:true }); ${navdefs} ${lift('hsi_press')}
      const seen=[]; for(let i=0;i<6;i++){ hsi_press(8,"left"); seen.push(hsi_state.scale); } return seen;`)(navigate) as number[]
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
    expect(texts(hsi({ speed: 100, tas: 120 }))).toContain('233T') // the airspeed through the air, not the speed over the ground
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
    expect(at(d, '090°/ 10.0')).toEqual([60, 66])
    expect(at(d, '3:00')).toEqual([160, 90]) // right-aligned under the range
    expect(at(d, 'NIM')).toEqual([76, 114])
    expect(texts(hsi({ ground: 20 })).filter((s) => /^\d+:\d\d(:\d\d)?$/.test(s))).toEqual(['12:34:56']) // no TTG at taxi speed, only ZTOD
    expect(texts(hsi({ altitude: 5000 }))).toContain('090°/ 10.4') // slant: 10 nm out and 5 km up
    const wrapped = hsi({ east: 81480, wrap: '(v)=>v>50000?v-100000:v' })
    expect(texts(wrapped)).toContain('270°/ 10.0')
    const run = new Function(`${lift('time_to_go')} return [time_to_go(346), time_to_go(3827), time_to_go(40000)];`)() as string[]
    expect(run).toEqual(['5:46', '1:03:47', '8:59:59'])
  })

  it('draws the TACAN as the set receives it: nothing off, mistuned or in A/A, the bearing alone in RCV or under EMCON (24.4.2, 2.13.5.2)', () => {
    const pointer = (d: Drawn) => d.styled.some(([, mx, my]) => near([mx, my], polar(R + T + 3, 90)))
    expect(pointer(hsi())).toBe(true)
    for (const tacan of ['{ on:false }', '{ channel:75 }', '{ band:"Y" }', '{ air:true }']) {
      const d = hsi({ tacan })
      expect(pointer(d), tacan).toBe(false)
      expect(texts(d).filter((s) => s.includes('°') || s === 'NIM'), tacan).toEqual(['000°']) // only the heading selected
    }
    for (const o of [{ tacan: '{ mode:"rcv" }' }, { emcon: true }]) {
      const d = hsi(o)
      expect(pointer(d)).toBe(true)
      expect(at(d, '090°')).toEqual([60, 66])
      expect(at(d, 'NIM')).toEqual([76, 114])
      expect(d.moves.some((m) => near(m, [R / 4, -9]) || near(m, [0, -9]))).toBe(false) // no station without a range, where it lies or at the centre
      expect(texts(d).filter((s) => /^\d+:\d\d$/.test(s))).toEqual([]) // no TTG
    }
  })

  it('shows ZTOD at the lower left and the timer shown, ET or CD, at the lower right', () => {
    const d = hsi()
    expect(at(d, '12:34:56')).toEqual([56, 414]) // clear of ACL's legend at the pushbutton beside it
    expect(texts(d)).not.toContain('ET')
    const et = hsi({ timer: 'et' })
    expect(at(et, 'ET')).toEqual([444, 370])
    expect(at(et, '01:30')).toEqual([444, 392])
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
    for (const gone of ['DCTR', 'MAP', 'T UP', 'HSI']) expect(texts(top)).not.toContain(gone)
    const sub = hsi({ mode: true }, 'center')
    expect(at(sub, 'T UP')).toEqual([10, 176])
    expect(at(sub, 'DCTR')).toEqual([10, 336])
    expect(at(sub, 'MAP')).toEqual([96, 30])
    expect(at(sub, 'HSI')).toEqual([416, 30])
    for (const gone of ['MODE', 'TIMEUFC']) expect(texts(sub)).not.toContain(gone)
    expect(texts(hsi({ mode: true, north: true }))).toContain('N UP')
    expect(texts(hsi({ mode: true }, 'left'))).not.toContain('MAP')
    const presses = new Function('navigate', `const HSI_SCALES=[5,10,20,40,80,160], hsi_state={ scale:40, dctr:false, map:true, north:false, level:"" }, pressed=[], mc=()=>({ one:true, two:true }), ufc_press=(b)=>pressed.push(b), ownship={}; ${navdefs} ${lift('hsi_press')}
      const mode=()=>hsi_state.level==="mode";
      const r=[hsi_press(4,"left"), hsi_press(2,"left"), hsi_press(3,"left"), mode(), hsi_press(4,"left"), hsi_state.north, hsi_press(2,"left"), hsi_state.dctr,
        hsi_press(6,"left"), hsi_state.map, hsi_press(6,"center"), hsi_state.map, hsi_press(17,"left"), hsi_press(10,"left"), mode(), hsi_press(17,"left"), pressed.join()];
      return r;`)(navigate) as unknown[]
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

// The navigation symbology on the HSI (G3): the top level's options at figure 24-1's pushbuttons, the
// waypoint, target, course line, heading select marker and sequence drawn from the position the suite
// keeps, the alignment display (figures 24-3 to 24-6), and the POS and UPDT sublevels (figures 24-10, 24-11).
describe('the HSI\'s navigation symbology', () => {
  const R = 164, T = 12
  const north = 'nav.waypoints[3]={ x:0, z:-18520, elevation:0, name:"", offset:null }; nav.current=3;' // a waypoint 10 nm north
  const boxed = (d: Drawn, x: number, y: number) => d.rects.some(([rx, ry, , h]) => ry === y - 14 && h === 28 && rx <= x + 6 && rx >= x - 140)

  it('is MC2\'s backup without mission computer 1: the rose, the TACAN and the scale, and no map, waypoint, sequence or data (25.1.2)', () => {
    const plan = 'nav.steer="wypt"; nav.waypoints[1]={ x:9260, z:0, elevation:0, name:"ALPHA", offset:null }; nav.waypoints[2]={ x:0, z:-9260, elevation:0, name:"", offset:null }; nav.current=1; nav.sequences[0]=[1,2]; nav.lines=true; nav.course=1; nav.target=1; nav.tot=50000;'
    const full = hsi({ nav: plan, map: true }, 'center'), backup = hsi({ nav: plan, map: true, computer: false }, 'center')
    expect(texts(full)).toEqual(expect.arrayContaining(['POS/INS', 'DATA', 'MK 1', 'WYPT', 'SEQ1', 'ALPHA'])); expect(full.fills.length).toBeGreaterThan(backup.fills.length) // the chart
    for (const gone of ['POS/INS', 'UPDT', 'DATA', 'MK 1', 'WYPT', 'NAVDSG', 'SEQ1', 'TIMEUFC', 'AUTO', 'ALPHA', '↑', '↓']) expect(texts(backup), gone).not.toContain(gone)
    expect(texts(backup).some((t) => t.endsWith('G REQD'))).toBe(false); expect(texts(full).some((t) => t.endsWith('G REQD'))).toBe(true)
    for (const [label, px, py] of [['SCL/40', 256, 30], ['TCN', 10, 96], ['MODE', 10, 256], ['ACL', 10, 416]] as [string, number, number][]) expect(at(backup, label), label).toEqual([px, py])
    expect(texts(backup)).toEqual(expect.arrayContaining(['NIM', 'HSEL'])) // the TACAN block and the heading set stay
    expect(full.lines.length).toBeGreaterThan(backup.lines.length) // the waypoint's pointer, its course line and the sequence's lines
    expect(hsi({ nav: plan, computer: false }).lines.length).toBe(hsi({ nav: plan + ' nav.lines=false;', computer: false }).lines.length) // no sequence drawn
    expect(texts(hsi({ level: 'data', computer: false }))).toContain('SCL/40') // no data sublevel: the top level
    expect(texts(hsi({ mode: true, computer: false }, 'center'))).not.toContain('MAP'); expect(texts(hsi({ mode: true }, 'center'))).toContain('MAP')
  })
  it('offers ACL at the lower left in the NAV master mode, boxed while it is selected (24.1.3.19, 24.6.1)', () => {
    expect(at(hsi(), 'ACL')).toEqual([10, 416]); expect(boxed(hsi(), 10, 416)).toBe(false)
    expect(boxed(hsi({ nav: 'link.selected=true;' }), 10, 416)).toBe(true)
    expect(source).toMatch(/\n\tif\(!level&&master==="nav"\) ddi_legend\(x,1,"ACL",true,link\.selected\); \}/)
    expect(texts(hsi({ level: 'pos' }))).not.toContain('ACL'); expect(texts(hsi({ level: 'updt' }))).not.toContain('ACL')
    expect(texts(hsi({ mode: true }))).not.toContain('ACL') // the top level's
  })
  it('writes CPL and the steering\'s source either side of the aircraft symbol while coupled to it (2.13.4.7 item 8)', () => {
    expect(texts(hsi())).not.toContain('CPL')
    const d = hsi({ nav: 'autopilot.cue=()=>true; coupled="CPL SEQ2";' })
    const left = at(d, 'CPL') as number[], right = at(d, 'SEQ2') as number[]
    expect([left[0], right[0]]).toEqual([226, 286]); expect(left[1]).toBe(right[1])
    expect(d.text.filter(([t]) => t === 'CPL').length).toBe(1)
    expect(texts(hsi({ nav: 'autopilot.cue=()=>true; hold.source="bank"; coupled="CPLD P/R";' }))).not.toContain('CPL') // the carrier's couple is the HUD's to show
    expect(texts(hsi({ nav: 'autopilot.cue=()=>true; hold.source="heading"; coupled="CPLD HDG";' }))).not.toContain('CPL')
  })
  it('puts the top level\'s options at their pushbuttons, the steering selected boxed', () => {
    const d = hsi()
    for (const [label, px, py] of [['POS/INS', 96, 30], ['UPDT', 176, 30], ['SCL/40', 256, 30], ['MK 1', 336, 30], ['DATA', 416, 30], ['TCN', 10, 96], ['MODE', 10, 256], ['WYPT', 502, 96], ['↑', 502, 176], ['↓', 502, 256],
      ['NAVDSG', 502, 336], ['SEQ1', 502, 416], ['TIMEUFC', 336, 482]] as [string, number, number][]) expect(at(d, label), label).toEqual([px, py])
    expect(d.text).toContainEqual(['0', 502, 216]) // the steer-to number between its arrows
    expect(d.rects).toContainEqual([-11, 82, 42, 28]) // TCN boxed (the recording canvas keeps no alignment, so every box is centred on its legend's anchor)
    expect(boxed(d, 502, 96)).toBe(false)
    expect(texts(d)).not.toContain('AUTO')
    const wypt = hsi({ nav: 'nav.steer="wypt"; nav.current=60; nav.marks[0]={ x:0, z:0, elevation:0, name:"", offset:null }; nav.mark=4; nav.sequence=2; nav.lines=true;' })
    expect(wypt.rects).toContainEqual([476, 82, 52, 28]); expect(wypt.rects).not.toContainEqual([-11, 82, 42, 28])
    expect(wypt.text).toContainEqual(['M1', 502, 216]); expect(texts(wypt)).toContain('MK 5'); expect(texts(wypt)).toContain('SEQ3'); expect(boxed(wypt, 502, 416)).toBe(true)
  })

  it('names the source keeping the position, and offers UPDT only while updates are taken', () => {
    const aided = hsi({ nav: 'nav.source="ains";' })
    expect(texts(aided)).toContain('POS/AINS'); expect(texts(aided)).not.toContain('UPDT')
    expect(texts(hsi({ nav: 'nav.source="adc";' }))).toEqual(expect.arrayContaining(['POS/ADC', 'UPDT']))
  })

  it('offers AUTO with a sequence of two, boxed when engaged, and not with a target designated', () => {
    const seq = 'nav.waypoints[1]={ x:1, z:1, elevation:0, name:"", offset:null }; nav.waypoints[2]={ x:2, z:2, elevation:0, name:"", offset:null }; navigate.insert(nav,1); navigate.insert(nav,2);'
    expect(at(hsi({ nav: seq }), 'AUTO')).toEqual([416, 482])
    expect(boxed(hsi({ nav: seq }), 416, 482)).toBe(false)
    expect(boxed(hsi({ nav: seq + 'navigate.automatic(nav);' }), 416, 482)).toBe(true)
    expect(texts(hsi({ nav: seq + 'nav.current=1; navigate.designate(nav);' }))).not.toContain('AUTO')
  })

  it('draws the steer-to waypoint where it lies with its bearing pointer inside the rose, and its data at the upper right', () => {
    const d = hsi({ nav: north })
    expect(d.arcs).toContainEqual([0, -R / 4, 6])
    expect(d.moves.some((m) => near(m, polar(R - 4, 0)))).toBe(true) // the pointer's head
    expect(d.lines.some((l) => near(l.slice(0, 4) as number[], [...polar(R - 4, 180), ...polar(R - 18, 180)]))).toBe(true) // and its tail
    expect(at(d, '000°/ 10.0')).toEqual([440, 66]); expect(d.text).toContainEqual(['3:00', 440, 90])
    const far = hsi({ nav: north, scale: 5 })
    expect(far.arcs).toContainEqual([0, -(R - 26), 6]) // held at the pointer's head beyond the scale
    expect(texts(hsi({ nav: north + 'nav.waypoints[3].name="PMDY";' }))).toContain('PMDY')
    expect(hsi().arcs).toEqual([]) // no waypoint stored: no symbol
  })

  it('draws it from the position kept: an INS error displaces the waypoint, and never the TACAN', () => {
    const d = hsi({ nav: north + 'nav.ins.error={ x:0, z:-9260 };' }) // the INS believes itself 5 nm north of where it is
    expect(d.arcs).toContainEqual([0, -R / 8, 6])
    expect(texts(d)).toContain('000°/ 5.0'); expect(texts(d)).toContain('090°/ 10.0')
  })

  it('shows the target\'s diamond and TGT boxed once designated, an offset aimpoint with its cross, and O/S in NAVDSG\'s place', () => {
    const tgt = hsi({ nav: north + 'navigate.designate(nav);' })
    expect(tgt.arcs).toEqual([])
    expect(tgt.moves.some((m) => near(m, [0, -R / 4 - 8]))).toBe(true)
    expect(at(tgt, 'TGT')).toEqual([502, 96]); expect(boxed(tgt, 502, 96)).toBe(true)
    for (const gone of ['WYPT', 'NAVDSG', 'O/S']) expect(texts(tgt)).not.toContain(gone)
    const oap = north + 'nav.waypoints[3].offset={ range:9260, bearing:Math.PI/2, elevation:0 };'
    const before = hsi({ nav: oap })
    expect(at(before, 'OAP')).toEqual([502, 96]); expect(texts(before)).toContain('NAVDSG')
    expect(before.lines.some((l) => near(l.slice(0, 4) as number[], [R / 8 - 6, -R / 4, R / 8 + 6, -R / 4]))).toBe(true) // the offset's cross, 5 nm east of the aimpoint
    const half = hsi({ nav: oap + 'navigate.designate(nav);' })
    expect(at(half, 'O/S')).toEqual([502, 336]); expect(texts(half)).toContain('OAP'); expect(boxed(half, 502, 96)).toBe(true)
  })

  it('draws the course line through the waypoint steered to, with the course at the lower right and the distance off it above', () => {
    const d = hsi({ nav: north + 'nav.steer="wypt"; navigate.set(nav,"course",30);' })
    expect(d.arcs).toContainEqual([0, 0, R - 2]) // clipped inside the rose
    const [px, py] = [0, -R / 4], c = Math.sin(30 * Math.PI / 180), u = -Math.cos(30 * Math.PI / 180)
    expect(d.lines.some((l) => near(l.slice(0, 4) as number[], [px - c * 2 * R, py - u * 2 * R, px + c * 40, py + u * 40]))).toBe(true)
    expect(at(d, 'CSEL')).toEqual([444, 436]); expect(d.text).toContainEqual(['030°', 444, 458])
    expect(d.text).toContainEqual(['5.0C', 444, 414]) // 10 nm out, 30° off the line
    const none = hsi({ nav: north + 'nav.steer="wypt";' })
    expect(at(none, 'CSEL')).toEqual([444, 436]); expect(none.text.some(([, px2, py2]) => px2 === 444 && (py2 === 458 || py2 === 414))).toBe(false)
  })

  it('draws the course line through the TACAN station with TACAN steering, and none without its range', () => {
    const d = hsi({ nav: 'navigate.set(nav,"course",90);' })
    expect(d.lines.some((l) => near(l.slice(0, 4) as number[], [R / 4 - 2 * R, 0, R / 4 + 40, 0]))).toBe(true)
    expect(d.text).toContainEqual(['0.0C', 444, 414])
    expect(hsi({ nav: 'navigate.set(nav,"course",90);', tacan: '{ mode:"rcv" }' }).arcs).toEqual([])
    const both = hsi({ nav: north + 'navigate.set(nav,"course",90);' }) // a waypoint shown, the TACAN steered to: the line is the TACAN's alone
    expect(both.lines.some((l) => near(l.slice(0, 4) as number[], [R / 4 - 2 * R, 0, R / 4 + 40, 0]))).toBe(true)
    expect(both.lines.some((l) => near(l.slice(0, 4) as number[], [-2 * R, -R / 4, 40, -R / 4]))).toBe(false)
  })

  it('rides the heading select marker on the rose, with HSEL and the heading set at the lower left', () => {
    const d = hsi({ nav: 'nav.heading=60*D2R;' })
    const [mx, my] = polar(R + T + 8, 60), c = Math.cos(60 * Math.PI / 180), sn = Math.sin(60 * Math.PI / 180)
    for (const side of [-1, 1]) expect(d.fills.some(([fx, fy, w, h]) => near([fx, fy, w, h], [mx + side * 6 * c - 3, my + side * 6 * sn - 3, 6, 6]))).toBe(true)
    expect(at(d, 'HSEL')).toEqual([56, 436]); expect(d.text).toContainEqual(['060°', 56, 458])
  })

  it('joins the sequence\'s waypoints with lines when SEQ # is boxed', () => {
    const seq = 'nav.waypoints[1]={ x:0, z:-18520, elevation:0, name:"", offset:null }; nav.waypoints[2]={ x:18520, z:-18520, elevation:0, name:"", offset:null }; navigate.insert(nav,1); navigate.insert(nav,2);'
    const leg = (d: Drawn) => d.lines.some((l) => near(l.slice(0, 4) as number[], [0, -R / 4, R / 4, -R / 4]))
    expect(leg(hsi({ nav: seq }))).toBe(false)
    expect(leg(hsi({ nav: seq + 'nav.lines=true;' }))).toBe(true)
  })

  it('reads magnetic with HDG MAG: the rose turned by the variation, no T or TRUE, and the readouts magnetic', () => {
    const d = hsi({ nav: north + 'nav.magnetic=true; nav.variation=10*D2R;' })
    expect(d.text.some(([t, fx, fy]) => t === 'N' && near([fx, fy], polar(R + T / 2, 10)))).toBe(true)
    for (const gone of ['TRUE', 'T']) expect(texts(d)).not.toContain(gone)
    expect(texts(d)).toContain('350°/ 10.0'); expect(texts(d)).toContain('080°/ 10.0')
    expect(texts(hsi())).toEqual(expect.arrayContaining(['TRUE', 'T']))
  })

  it('reads the TACAN against the station\'s own variation with TCN MGVAR, and the course set while steering to it', () => {
    const stored = 'nav.magnetic=true; nav.variation=10*D2R; nav.stations=[{ channel:74, band:"X", x:18520, z:0, elevation:0, name:"", variation:4*D2R }]; nav.course=90*D2R;'
    const own = hsi({ nav: stored }), local = hsi({ nav: stored + 'nav.local=true;' })
    expect(own.text).toContainEqual(['080°/ 10.0', 60, 66]); expect(local.text).toContainEqual(['086°/ 10.0', 60, 66]) // the ship due east
    expect(own.text).toContainEqual(['080°', 444, 458]); expect(local.text).toContainEqual(['086°', 444, 458])
    expect(local.text).toContainEqual(['350°', 56, 458]) // the heading selected stays against the aircraft's
    expect(hsi({ nav: stored + 'nav.local=true; nav.stations[0].channel=12;' }).text).toContainEqual(['080°/ 10.0', 60, 66]) // the station tuned is not the one stored
    const waypoint = hsi({ nav: stored + 'nav.local=true; nav.waypoints[3]={ x:0, z:-18520, elevation:0, name:"", offset:null }; nav.current=3; nav.steer="wypt";' })
    expect(waypoint.text).toContainEqual(['080°', 444, 458]) // a waypoint's course is the aircraft's
  })

  it('shows the groundspeed required for the time on target under the present one', () => {
    const plan = north + 'navigate.insert(nav,3); nav.target=3; nav.steer="wypt"; nav.tot=45296+120;' // 10 nm in two minutes
    expect(hsi({ nav: plan }).text).toContainEqual(['300G REQD', 272, 304])
    expect(texts(hsi({ nav: north })).some((t) => t.endsWith('REQD'))).toBe(false)
  })

  const aligning = (kind: string, more = '') => `nav.ins.mode="align"; nav.ins.kind="${kind}"; nav.ins.progress=68; nav.ins.time=68; ${more}`
  it('shows a ground alignment: GRND, the quality counting down, the time, and the position it was given', () => {
    const d = hsi({ nav: aligning('gnd') })
    expect(at(d, 'GRND')).toEqual([256, 318])
    expect(d.text).toContainEqual(['QUAL: 18.8', 256, 342]); expect(d.text).toContainEqual(['TIME: 1:08', 256, 364])
    expect(d.text).toContainEqual(['N  28°12\'26"', 256, 128]); expect(d.text).toContainEqual(['W 177°22\'25"', 256, 150])
    expect(texts(d)).not.toContain('NO WYPTS')
    expect(texts(d)).toContain('TIMEUFC'); expect(texts(d)).not.toContain('MAN') // MAN is a carrier alignment's
    expect(texts(hsi({ nav: aligning('gnd', 'nav.ins.progress=5;') }))).toContain('QUAL: NO ATT')
    expect(texts(hsi({ nav: aligning('gnd', 'nav.ins.progress=600;') }))).toContain('QUAL: 0.5 OK')
  })

  it('flashes the time while the alignment is interrupted', () => {
    const held = aligning('gnd', 'nav.ins.held=true;')
    expect(texts(hsi({ nav: held, time: 0.2 }))).toContain('TIME: 1:08')
    expect(texts(hsi({ nav: held, time: 0.7 }))).not.toContain('TIME: 1:08')
    expect(texts(hsi({ nav: aligning('gnd'), time: 0.7 }))).toContain('TIME: 1:08')
  })

  it('shows a carrier alignment with MAN in TIMEUFC\'s place, NO WYPTS after 20 s, and the ship\'s data once manual', () => {
    const d = hsi({ nav: aligning('cv') })
    expect(at(d, 'CV RF')).toEqual([256, 318]); expect(d.text).toContainEqual(['NO WYPTS', 256, 386])
    expect(at(d, 'MAN')).toEqual([336, 482]); expect(texts(d)).not.toContain('TIMEUFC'); expect(boxed(d, 336, 482)).toBe(false)
    expect(texts(hsi({ nav: aligning('cv', 'nav.ins.time=10;') }))).not.toContain('NO WYPTS')
    const manual = hsi({ nav: aligning('cv', 'nav.ins.manual=true; carrier_given.heading=70*D2R; carrier_given.speed=17;') })
    expect(at(manual, 'CV MAN')).toEqual([256, 318]); expect(boxed(manual, 336, 482)).toBe(true)
    expect(manual.text).toContainEqual(['CV HDG 070°', 256, 172]); expect(manual.text).toContainEqual(['CV SPD 17KTS', 256, 194])
    expect(texts(d).some((t) => t.startsWith('CV HDG'))).toBe(false)
  })

  it('offers STD HDG while a stored heading would shorten the alignment, and no AUTO during one', () => {
    const seq = 'nav.waypoints[1]={ x:1, z:1, elevation:0, name:"", offset:null }; nav.waypoints[2]={ x:2, z:2, elevation:0, name:"", offset:null }; navigate.insert(nav,1); navigate.insert(nav,2);'
    const d = hsi({ nav: seq + aligning('gnd', 'nav.ins.heading=true;') })
    expect(at(d, 'STD HDG')).toEqual([176, 482]); expect(texts(d)).not.toContain('AUTO')
    expect(texts(hsi({ nav: aligning('gnd') }))).not.toContain('STD HDG')
  })

  it('shows an inflight alignment by its source, without a position', () => {
    const d = hsi({ nav: aligning('ifa') })
    expect(at(d, 'IFA GPS')).toEqual([256, 318]); expect(d.text.some(([, px, py]) => px === 256 && py === 128)).toBe(false)
    expect(texts(hsi({ nav: aligning('ifa', 'nav.ins.radar=true;') }))).toContain('IFA RDR')
  })

  it('lays out the position keeping options, dimming none it cannot tell and boxing the one in use', () => {
    const d = hsi({ level: 'pos' })
    for (const [label, px, py] of [['AINS', 10, 96], ['INS', 96, 30], ['TCN', 176, 30], ['ADC', 256, 30], ['GPS', 336, 30], ['HSI', 416, 30]] as [string, number, number][]) expect(at(d, label), label).toEqual([px, py])
    expect(boxed(d, 96, 30)).toBe(true)
    for (const gone of ['SCL/40', 'POS/INS', 'DATA', 'MODE', 'WYPT']) expect(texts(d)).not.toContain(gone)
  })

  it('lays out the update options, AUTO alone once boxed, and ACPT and REJ either side of the error found', () => {
    const d = hsi({ level: 'updt' }, 'center')
    for (const [label, px, py] of [['TCN', 96, 30], ['DSG', 176, 30], ['AUTO', 256, 30], ['HSI', 416, 30], ['GPS', 10, 176]] as [string, number, number][]) expect(at(d, label), label).toEqual([px, py])
    expect(texts(d)).not.toContain('MAP') // no map shown
    expect(at(hsi({ level: 'updt', map: true }, 'center'), 'MAP')).toEqual([336, 30])
    expect(texts(hsi({ level: 'updt', map: true }, 'left'))).not.toContain('MAP')
    expect(texts(d)).not.toContain('CANCEL')
    expect(at(hsi({ level: 'updt', nav: 'nav.previous={ source:"ins", error:{ x:0, z:0 } };' }), 'CANCEL')).toEqual([10, 256])
    expect(boxed(hsi({ level: 'updt', nav: 'nav.updating="dsg";' }), 176, 30)).toBe(true)
    const auto = hsi({ level: 'updt', nav: 'nav.updating="auto";' })
    expect(texts(auto)).toEqual(expect.arrayContaining(['AUTO', 'HSI'])); for (const gone of ['TCN', 'DSG']) expect(auto.text.some(([t, , py]) => t === gone && py === 30)).toBe(false)
    const found = hsi({ level: 'updt', nav: 'nav.update={ kind:"tcn", delta:{ x:1852, z:1852 } };' })
    expect(at(found, 'ACPT')).toEqual([96, 30]); expect(at(found, 'REJ')).toEqual([416, 30])
    expect(found.text).toContainEqual(['315°/ 1.4NM', 256, 30]) // the computed position north-west of the one kept
  })

  it('centres the AMPCD\'s map on the position kept, and slews it for a MAP update', () => {
    const boat = (d: Drawn) => d.fills.find(([, , w, h, ink]) => w === 12 && h === 12 && ink === '#ffd27a')?.slice(0, 2)
    expect(boat(hsi({ map: true }, 'center'))).toEqual([R / 4 - 6, -6])
    expect(boat(hsi({ map: true, nav: 'nav.ins.error={ x:9260, z:0 };' }, 'center'))?.[0]).toBeCloseTo(R / 8 - 6, 6)
    const slewed = hsi({ map: true, nav: 'nav.updating="map"; nav.slew={ x:9260, z:0 };' }, 'center')
    expect(boat(slewed)?.[0]).toBeCloseTo(R / 4 + R / 8 - 6, 6); expect(at(slewed, 'SLEW')).toEqual([430, 140])
  })
})

// The DATA sublevels (figure 24-9 sheets 3 and 5, figures 24-7, 24-8 and 24-18).
interface Data { tab?: string; check?: boolean; shown?: number; nav?: string; func?: string; back?: string; kind?: string; time?: number; cursor?: number; asked?: number; tas?: number; slew?: boolean; far?: string; reference?: boolean }
function data(o: Data = {}): Drawn {
  return page('hsi_data', `const ownship={ pos:{ x:0, y:1000, z:0 }, speed:${o.tas ?? 100}, vely:-2, gauges:{ ground:200, zulu:45296 } };
    const hsi_state={ data:${JSON.stringify(o.tab ?? 'wypt')}, shown:${o.shown ?? 1}, check:${o.check ?? false}, slew:${o.slew ?? false}, gps:{ cursor:${o.cursor ?? 0}, asked:${o.asked ?? -1e9} } }, ufc={ func:${JSON.stringify(o.func ?? '')}, back:${JSON.stringify(o.back ?? '')}, kind:${JSON.stringify(o.kind ?? '')} };
    const grid_state={ far:${o.far ?? 'null'}, waypoint:${o.reference ?? false} };
    const sim_time=${o.time ?? 0}, altitude_set={ radar:200, baro:5000 }; ${navdefs}
    nav.waypoints[1]={ x:0, z:-18520, elevation:304.8, name:"NIM", offset:null }; ${o.nav ?? ''}`)
}
describe('the HSI\'s DATA sublevels', () => {
  const boxed = (d: Drawn, y: number) => d.rects.some(([, ry, , h]) => ry === y - 14 && h === 28)
  it('offers the bank limit on the A/C data, NAV or TAC, under UFC (24.2.8, figure 24-9 sheet 5)', () => {
    expect(at(data({ tab: 'ac' }), 'NAV BLIM')).toEqual([10, 176]); expect(texts(data({ tab: 'ac' }))).not.toContain('TAC BLIM')
    expect(at(data({ tab: 'ac', nav: 'nav.limit="tac";' }), 'TAC BLIM')).toEqual([10, 176])
    expect(texts(data())).not.toContain('NAV BLIM') // the A/C data's, not the waypoint's
  })
  it('offers OVFLY on the waypoint data, boxed for a waypoint to be flown over (2.9, 24.2.9.5)', () => {
    expect(at(data(), 'OVFLY')).toEqual([416, 482]); expect(boxed(data(), 482)).toBe(false)
    expect(boxed(data({ nav: 'nav.waypoints[1].overfly=true;' }), 482)).toBe(true)
    expect(texts(data({ tab: 'ac' }))).not.toContain('OVFLY')
  })
  it('shows a waypoint: its ID and number, position, elevation, the time on target and groundspeed, and the options', () => {
    const d = data({ nav: 'nav.tot=13*3600+45*60+30; nav.speed=367;' })
    expect(d.text).toContainEqual(['NIM', 256, 62]); expect(d.text).toContainEqual(['WYPT 1', 256, 84])
    expect(d.text).toContainEqual(['N  28°22\'25"', 120, 112]); expect(d.text).toContainEqual(['W 177°22\'25"', 120, 134]); expect(d.text).toContainEqual(['ELEV 1000 FT', 120, 178])
    expect(d.text).toContainEqual(['GRID 1RDM634386', 120, 156]) // the grid under the lat/long: proj puts it at 463403 E 3138642 N in zone 1
    expect(d.text).toContainEqual(['TOT 13:45:30', 60, 302]); expect(d.text).toContainEqual(['GSPD 367', 320, 302])
    for (const [label, px, py] of [['A/C', 96, 30], ['WYPT', 176, 30], ['TCN', 256, 30], ['HSI', 416, 30], ['NAVCK', 502, 96], ['UFC', 10, 96], ['SLEW', 10, 176], ['GPS', 10, 256], ['SEQUFC', 10, 416], ['REF WP', 502, 336], ['SEQ1', 502, 416], ['↑', 502, 176], ['↓', 502, 256], ['PRECISE', 176, 482]] as [string, number, number][]) {
      expect(at(d, label), label).toEqual([px, py])
    }
    expect(d.text).toContainEqual(['1', 502, 216])
    expect(d.rects).toContainEqual([150, 16, 52, 28]) // WYPT boxed
    expect(texts(d).some((t) => t.startsWith('O/S'))).toBe(false)
  })
  it('shows an offset aimpoint\'s offset, a mark by its M number, and zeros for a waypoint never stored', () => {
    const d = data({ nav: 'nav.waypoints[1].offset={ range:19812, bearing:30*D2R, elevation:381 };' })
    expect(d.text).toContainEqual(['O/S RNG 65000 FT', 120, 208]); expect(d.text).toContainEqual(['O/S BRG 030°00\'00" T', 120, 228]); expect(d.text).toContainEqual(['O/S ELEV 1250 FT', 120, 268])
    expect(d.text).toContainEqual(['O/S GRID 1RDM733556', 120, 248]) // 65,000 ft on 030 from the waypoint: 473336 E 3155690 N
    expect(texts(data({ shown: 61, nav: 'nav.marks[1]={ x:0, z:0, elevation:0, name:"", offset:null };' }))).toContain('WYPT M2')
    expect(data({ shown: 9 }).text).toContainEqual(['ELEV 0 FT', 120, 178])
  })
  it('writes the sequence being programmed with its target boxed, and boxes the option holding the UFC', () => {
    const d = data({ nav: 'navigate.insert(nav,1); navigate.insert(nav,12); navigate.insert(nav,7); nav.target=12;', func: 'seq' })
    expect(texts(d).filter((t) => /^(\d+|-)$/.test(t)).slice(0, 5)).toEqual(['1', '-', '12', '-', '7'])
    const twelve = d.text.find(([t, , py]) => t === '12' && py === 328) as [string, number, number]
    expect(d.rects).toContainEqual([twelve[1] - 3, 317, 26, 22])
    expect(boxed(d, 416)).toBe(true); expect(boxed(d, 96)).toBe(false)
    expect(boxed(data({ func: 'wypt' }), 96)).toBe(true); expect(boxed(data({ func: 'offset' }), 96)).toBe(true)
  })
  it('shows the aircraft\'s data: the source, the position kept, the wind, the variation, GPS\'s errors and time, and the altitude warnings', () => {
    const d = data({ tab: 'ac', nav: 'nav.ins.error={ x:0, z:-18520 }; nav.adc.wind={ x:-10.289, z:0 }; nav.variation=(8+52/60)*D2R;' })
    expect(d.text).toContainEqual(['INS', 256, 92]); expect(d.text).toContainEqual(['N  28°22\'25"', 150, 124])
    expect(d.text).toContainEqual(['WSPD 20 KT', 150, 172]); expect(d.text).toContainEqual(['WDIR 090°', 150, 196]); expect(d.text).toContainEqual(['MVAR E 8°52\'', 150, 220])
    expect(d.text).toContainEqual(['GPS HERR 33FT', 150, 262]); expect(d.text).toContainEqual(['GPS VERR 49FT', 150, 286]); expect(d.text).toContainEqual(['GPS TIME 12:34:56Z', 150, 310])
    expect(d.text).toContainEqual(['WARN ALT', 136, 416]); expect(d.text).toContainEqual(['5000', 96, 462]); expect(d.text).toContainEqual(['200', 176, 462])
    for (const [label, px, py] of [['UFC', 10, 96], ['NOSEC GPS', 10, 336], ['NORM', 10, 416], ['HDG TRUE', 502, 256], ['LATLN SEC', 502, 416]] as [string, number, number][]) expect(at(d, label), label).toEqual([px, py])
    expect(d.rects).toContainEqual([75, 16, 42, 28]) // A/C boxed
  })
  it('follows the A/C options: W for a westerly variation, the estimated wind, the phase, the reference and the format', () => {
    const d = data({ tab: 'ac', nav: 'nav.variation=-10.5*D2R; nav.gps.search=99; nav.ins.mode="gyro"; nav.gps.phase="appr"; nav.magnetic=true; nav.decimal=true; nav.gps.secure=false; nav.source="adc";' })
    expect(texts(d)).toEqual(expect.arrayContaining(['ADC', "MVAR W 10°30'", 'APPR', 'HDG MAG', 'LATLN DCML', "N  28°12.432'"]))
    expect(texts(d).some((t) => t.endsWith('EST'))).toBe(true)
    expect(texts(d).some((t) => t.startsWith('GPS HERR'))).toBe(false) // no satellites
    expect(boxed(d, 336)).toBe(true) // NOSEC GPS boxed
    expect(texts(data({ tab: 'ac', nav: 'nav.gps.search=99;' }))).not.toContain('NOSEC GPS') // secure and hearing nothing: the option is gone
  })
  it('boxes the altitude warning the UFC is setting', () => {
    expect(data({ tab: 'ac', func: 'alt', kind: 'radar' }).rects).toContainEqual([147, 428, 58, 24])
    expect(data({ tab: 'ac', func: 'alt', kind: 'baro' }).rects).toContainEqual([72, 428, 48, 24])
    expect(data({ tab: 'ac' }).rects.some(([, ry]) => ry === 428)).toBe(false)
  })
  it('shows a TACAN station\'s channel, position, elevation and variation, and nothing for a free place', () => {
    const station = 'nav.stations=[{ channel:74, band:"X", x:0, z:-18520, elevation:20, name:"NIM", variation:7*D2R }];'
    const d = data({ tab: 'tcn', nav: station })
    expect(d.text).toContainEqual(['74X', 256, 92]); expect(d.text).toContainEqual(['N  28°22\'25"', 150, 124]); expect(d.text).toContainEqual(['ELEV 66 FT', 150, 172]); expect(d.text).toContainEqual(["MVAR E 7°00'", 150, 196])
    expect(d.text).toContainEqual(['1', 502, 216]); expect(at(d, 'UFC')).toEqual([10, 96])
    const free = data({ tab: 'tcn', nav: station + 'nav.station=1;' })
    expect(free.text).toContainEqual(['2', 502, 216]); expect(texts(free).some((t) => t.startsWith('ELEV'))).toBe(false)
  })
  it('writes the waypoint to PRECISE: hundredths of a second and the grid to a metre, with PRECISE boxed', () => {
    const d = data({ nav: 'nav.precise=true;' })
    expect(d.text).toContainEqual(['N  28°22\'24.84"', 120, 112]); expect(d.text).toContainEqual(['W 177°22\'24.60"', 120, 134]); expect(d.text).toContainEqual(['GRID 1RDM6340338642', 120, 156])
    expect(d.rects.some(([, ry, , h]) => ry === 468 && h === 28)).toBe(true); expect(data().rects.some(([, ry]) => ry === 468)).toBe(false)
    expect(texts(data({ nav: 'nav.precise=true; nav.decimal=true;' }))).toContain("N  28°22.414'") // not in decimal minutes
  })
  it('writes each length in the unit chosen for it, and the offset\'s bearing against the meridian chosen', () => {
    const d = data({ nav: 'nav.waypoints[1].offset={ range:19812, bearing:30.2575*D2R, elevation:381 }; nav.units={ waypoint:"feet", offset:"mtrs", station:"feet", range:"nm" }; nav.meridian="magnetic"; nav.variation=7*D2R;' })
    expect(texts(d)).toEqual(expect.arrayContaining(['ELEV 1000 FT', 'O/S RNG 11 NM', 'O/S BRG 023°15\'27" M', 'O/S ELEV 381 M']))
    expect(texts(data({ nav: 'nav.units.waypoint="mtrs";' }))).toContain('ELEV 305 M')
    const yards = data({ nav: 'nav.waypoints[1].offset={ range:914.4, bearing:0, elevation:0 }; nav.units.range="yard"; nav.magnetic=true; nav.variation=7*D2R;' })
    expect(texts(yards)).toEqual(expect.arrayContaining(['O/S RNG 1000 YD', 'O/S BRG 000°00\'00" T'])) // HDG MAG is the displays' reference, not the offset's
  })
  it('flashes an offset grid keyed past its limit in the O/S GRID field, for the waypoint it was keyed for', () => {
    const far = '{ shown:1, text:"1RFM000000" }', offset = 'nav.waypoints[1].offset={ range:19812, bearing:30*D2R, elevation:0 };'
    expect(data({ far, time: 0 }).text).toContainEqual(['O/S GRID 1RFM000000', 120, 248]); expect(texts(data({ far, time: 0.5 })).some((t) => t.startsWith('O/S GRID'))).toBe(false)
    expect(texts(data({ far, time: 0, nav: offset })).filter((t) => t.startsWith('O/S GRID'))).toEqual(['O/S GRID 1RFM000000']) // in place of the offset's own
    expect(texts(data({ far, time: 0.5, nav: offset })).some((t) => t.startsWith('O/S GRID'))).toBe(false)
    expect(texts(data({ far: '{ shown:2, text:"1RFM000000" }', time: 0, nav: offset }))).toContain('O/S GRID 1RDM733556')
  })
  it('writes no grid for a waypoint past N84', () => {
    const d = data({ nav: 'const far=navigate.world(85,-177.3735); nav.waypoints[1].x=far.x; nav.waypoints[1].z=far.z;' })
    expect(texts(d)).toContain('N  85°00\'00"'); expect(texts(d).some((t) => t.startsWith('GRID'))).toBe(false)
  })
  it('boxes SLEW with the word at the upper right, REF WP, and the UFC option through its units pages', () => {
    const d = data({ slew: true, reference: true })
    expect(d.text).toContainEqual(['SLEW', 452, 62]); expect(boxed(d, 176)).toBe(true); expect(boxed(d, 336)).toBe(true)
    const plain = data(); expect(texts(plain).filter((t) => t === 'SLEW').length).toBe(1); expect(boxed(plain, 176)).toBe(false); expect(boxed(plain, 336)).toBe(false)
    expect(boxed(data({ func: 'elevation', back: 'wypt' }), 96)).toBe(true); expect(boxed(data({ func: 'range', back: 'offset' }), 96)).toBe(true); expect(boxed(data({ func: 'elevation', back: 'station' }), 96)).toBe(false)
    expect(boxed(data({ tab: 'tcn', func: 'elevation', back: 'station' }), 96)).toBe(true); expect(boxed(data({ tab: 'tcn', func: 'elevation', back: 'wypt' }), 96)).toBe(false)
  })
  it('runs a long sequence onto a second row, eight to a row', () => {
    const d = data({ nav: 'for(const n of [2,4,7,11,12,14,17,21,23,36]) navigate.insert(nav,n); nav.target=23;' })
    const row = (y: number) => d.text.filter(([t, , py]) => py === y && /^\d+$/.test(t)).map(([t]) => t)
    expect(row(328)).toEqual(['2', '4', '7', '11', '12', '14', '17', '21']); expect(row(350)).toEqual(['23', '36'])
    const target = d.text.find(([t, , py]) => t === '23' && py === 350) as [string, number, number]
    expect(d.rects).toContainEqual([target[1] - 3, 339, 26, 22])
  })
  it('names the variation the TACAN readouts use on the TACAN data, and a station\'s elevation in its unit', () => {
    const station = 'nav.stations=[{ channel:74, band:"X", x:0, z:-18520, elevation:20, name:"NIM", variation:7*D2R }];'
    expect(at(data({ tab: 'tcn', nav: station }), 'AC MGVAR')).toEqual([10, 416]); expect(at(data({ tab: 'tcn', nav: station + 'nav.local=true;' }), 'TCN MGVAR')).toEqual([10, 416])
    expect(texts(data({ tab: 'tcn', nav: station + 'nav.units.station="mtrs";' }))).toContain('ELEV 20 M')
  })
  const points = 'nav.points=[{ name:"ALPHA", x:0, z:-9260, elevation:30.48 }, { name:"NIM", x:0, z:-18520, elevation:20 }];'
  it('lists the GPS\'s points with the cursor\'s boxed, its data once it has come, and XFER then', () => {
    const waiting = data({ tab: 'gps', nav: points, time: 10, asked: 8 })
    expect(waiting.text).toContainEqual(['ALPHA', 70, 68]); expect(waiting.text).toContainEqual(['ALPHA', 80, 206]); expect(waiting.text).toContainEqual(['NIM', 80, 230])
    expect(waiting.rects).toContainEqual([76, 194, 58, 24])
    expect(waiting.text.some(([, px, py]) => px === 70 && py === 96)).toBe(false); expect(texts(waiting)).not.toContain('XFER')
    const ready = data({ tab: 'gps', nav: points, time: 11, asked: 8 })
    expect(ready.text).toContainEqual(['N  28°17\'25"', 70, 96]); expect(ready.text).toContainEqual(['ELEV 100 FT', 70, 144]); expect(at(ready, 'XFER')).toEqual([10, 96])
    expect(ready.text).toContainEqual(['WYPT 1', 290, 96]); expect(ready.text).toContainEqual(['NIM', 290, 68]); expect(ready.text).toContainEqual(['PAGE 1', 416, 452])
    expect(texts(data({ tab: 'gps', nav: points, time: 11, asked: 8, shown: 60 }))).not.toContain('XFER') // not into a mark
    expect(data({ tab: 'gps', nav: points, time: 11, asked: 8, cursor: 1 }).rects).toContainEqual([76, 218, 38, 24])
  })
  it('lays the NAV check out: the INS, GPS and air data velocities, the wind, groundspeed and true airspeed', () => {
    const d = data({ check: true, tas: 100, nav: 'nav.adc.wind={ x:5.144, z:-10.289 };' })
    for (const [name, cx] of [['INS', 150], ['GPS', 260], ['ADC', 370]] as [string, number][]) expect(d.text).toContainEqual([name, cx, 90])
    expect(d.text).toContainEqual(['214', 370, 140]); expect(d.text).toContainEqual(['10', 370, 164]) // air data: 100 m/s north with the wind found
    expect(d.text).toContainEqual(['20', 150, 300]); expect(d.text).toContainEqual(['10', 150, 324]) // the wind's north and east
    expect(d.text).toContainEqual(['200', 410, 300]); expect(d.text).toContainEqual(['194', 410, 324])
    expect(d.rects.some(([, ry]) => ry === 82)).toBe(true) // NAVCK boxed
    for (const gone of ['UFC', 'SEQUFC', '# INVALID', '* EST']) expect(texts(d)).not.toContain(gone)
  })
  it('marks invalid velocities with a #, and an estimated wind with a *', () => {
    const d = data({ check: true, nav: 'nav.ins.mode="gyro"; nav.gps.search=99;' })
    expect(texts(d)).toEqual(expect.arrayContaining(['# INVALID', '* EST']))
    expect(d.text.filter(([t, px]) => t.endsWith('#') && px === 150).length).toBe(3); expect(d.text.filter(([t, px]) => t.endsWith('#') && px === 260).length).toBe(3)
    expect(d.text.filter(([t, px]) => t.endsWith('#') && px === 370).length).toBe(0)
  })
})

// The square identification grid (24.2.5.1.2, figure 24-9 sheet 4). The jet is over the map's origin,
// 463,347 E 3,120,212 N in square 1R DM; waypoint 1 lies ten miles north of it.
describe('the square identification grid', () => {
  const consts = ['grid_state', 'GRID_SHIFTS', 'GRID_BOX'].map((n) => new RegExp(`\\nconst ${n}=[^\\n]*\\n`).exec(source)?.[0] ?? '').join('')
  const grid = (o: { nav?: string; state?: string; shown?: number } = {}) => page('ddi_grid', `const ownship={ pos:{ x:0, y:1000, z:0 }, speed:100 }, hsi_state={ shown:${o.shown ?? 1} }; ${navdefs}
    nav.waypoints[1]={ x:0, z:-18520, elevation:0, name:"", offset:null }; ${o.nav ?? ''}
    ${consts} ${o.state ?? ''} ${lift('grid_reference')} ${lift('grid_shifts')}`, 'right')
  const cell = (j: number, i: number) => [76 + (j + 0.5) * 72, 76 + i * 72 + 16]
  it('rules five squares each way and letters each, north up, the aircraft\'s square in the middle', () => {
    const d = grid()
    for (const k of [0, 1, 2, 3, 4, 5]) { expect(d.lines.some(([ax, ay, bx, by]) => ax === 76 + k * 72 && ay === 76 && bx === 76 + k * 72 && by === 436)).toBe(true); expect(d.lines.some(([ax, ay, bx, by]) => ax === 76 && ay === 76 + k * 72 && bx === 436 && by === 76 + k * 72)).toBe(true) }
    for (const [id, j, i] of [['D M', 2, 2], ['D N', 2, 1], ['D P', 2, 0], ['D L', 2, 3], ['D K', 2, 4], ['B M', 0, 2], ['C M', 1, 2], ['E M', 3, 2], ['F M', 4, 2], ['F P', 4, 0], ['B K', 0, 4]] as [string, number, number][]) expect(d.text, id).toContainEqual([id, ...cell(j, i)])
    expect(d.text.filter(([t]) => /^[A-Z] [A-Z]$/.test(t)).length).toBe(25)
    expect(texts(d).some((t) => /^\d+ \d+$/.test(t))).toBe(false) // all one zone: no zone numbers
  })
  it('draws the aircraft as a cross, the waypoint shown as a star and its offset as a circle, where they lie', () => {
    const d = grid({ nav: 'nav.waypoints[1].offset={ range:19812, bearing:30*D2R, elevation:0 };' })
    const px = 76 + 2.63346877 * 72, py = 76 + (5 - 2.20211791) * 72
    expect(d.lines.some(([ax, ay, bx, by]) => Math.abs(ax - (px - 9)) < 0.01 && Math.abs(bx - (px + 9)) < 0.01 && Math.abs(ay - py) < 0.01 && Math.abs(by - py) < 0.01)).toBe(true)
    expect(d.lines.some(([ax, ay, bx, by]) => Math.abs(ax - px) < 0.01 && Math.abs(bx - px) < 0.01 && Math.abs(ay - (py - 9)) < 0.01 && Math.abs(by - (py + 9)) < 0.01)).toBe(true)
    const wx = 76 + 2.63403 * 72, wy = 76 + (5 - 2.38642) * 72 // 463,403 E 3,138,642 N
    expect(d.moves.some(([mx, my]) => Math.abs(mx - wx) < 0.05 && Math.abs(my - (wy - 9)) < 0.05)).toBe(true) // the star's top point
    const ox = 76 + 2.73336 * 72, oy = 76 + (5 - 2.5569) * 72 // 473,336 E 3,155,690 N
    expect(d.arcs.some(([ax, ay, r]) => Math.abs(ax - ox) < 0.05 && Math.abs(ay - oy) < 0.05 && r === 8)).toBe(true)
    expect(grid().arcs.some(([, , r]) => r === 8)).toBe(false) // no offset, no circle
    expect(grid({ shown: 9 }).moves.some(([mx, my]) => Math.abs(mx - wx) < 0.05 && Math.abs(my - (wy - 9)) < 0.05)).toBe(false) // a waypoint never stored draws no star
  })
  it('draws the cursor as two bars and boxes the square chosen', () => {
    const d = grid({ state: 'grid_state.cursor={ x:300, y:200 }; grid_state.chosen={ zone:1, band:"R", id:"EN" };' })
    expect(d.lines.some(([ax, ay, bx, by]) => ax === 292 && ay === 189 && bx === 292 && by === 211)).toBe(true); expect(d.lines.some(([ax, ay, bx, by]) => ax === 308 && ay === 189 && bx === 308 && by === 211)).toBe(true)
    const [cx, cy] = cell(3, 1); expect(d.rects).toContainEqual([cx - 26, cy - 13, 52, 26]); expect(d.rects.length).toBe(1)
    expect(grid({ state: 'grid_state.chosen={ zone:2, band:"R", id:"EN" };' }).rects.length).toBe(0) // the same letters in another zone are another square
    expect(grid().rects.length).toBe(0)
  })
  it('offers the eight grid shifts at their pushbuttons, S where MENU otherwise is, and none once shifted', () => {
    const d = grid()
    for (const [label, px, py] of [['N', 256, 30], ['S', 256, 482], ['NW', 10, 96], ['W', 10, 256], ['SW', 10, 416], ['NE', 502, 96], ['E', 502, 256], ['SE', 502, 416]] as [string, number, number][]) expect(at(d, label), label).toEqual([px, py])
    const shifted = grid({ state: 'grid_state.shift={ east:0, north:1 };' })
    for (const label of ['N', 'S', 'NW', 'W', 'SW', 'NE', 'E', 'SE']) expect(texts(shifted)).not.toContain(label)
    expect(shifted.text).toContainEqual(['D S', ...cell(2, 2)]) // five squares north of M: N, P, Q, R, S
    expect(shifted.lines.filter(([ax, , bx]) => bx - ax === 18).length).toBe(0) // the aircraft is off this grid
  })
  it('marks the zones either side of a zone\'s edge above and below where it crosses', () => {
    const d = grid({ nav: 'nav.waypoints[1]={ x:-200000, z:0, elevation:0, name:"", offset:null };', state: 'grid_state.waypoint=true;' }) // 200 km west: zone 1's edge, 206 km east of its false origin, runs through the grid
    const marks = d.text.filter(([t]) => /^\d+ \d+$/.test(t))
    expect(marks).toEqual([['60 1', 220, 64], ['60 1', 220, 448]]) // between the second and third columns
    const row = d.text.filter(([t, , py]) => /^[A-Z] [A-Z]$/.test(t) && py === cell(0, 2)[1]).map(([t]) => t[0])
    expect(row.slice(2)).toEqual(['B', 'C', 'D']); expect(row.slice(0, 2).every((c) => 'STUVWXYZ'.includes(c))).toBe(true) // zone 60's columns are lettered from the third set
  })
  it('builds it about the waypoint shown with REF WP boxed', () => {
    const d = grid({ nav: 'nav.waypoints[1]={ x:200000, z:0, elevation:0, name:"", offset:null };', state: 'grid_state.waypoint=true;' })
    expect(d.text).toContainEqual(['F M', ...cell(2, 2)]); expect(d.text).toContainEqual(['D M', ...cell(0, 2)])
    expect(grid({ nav: 'nav.waypoints[1]={ x:200000, z:0, elevation:0, name:"", offset:null };' }).text).toContainEqual(['D M', ...cell(2, 2)])
    expect(grid({ shown: 9, state: 'grid_state.waypoint=true;' }).text).toContainEqual(['D M', ...cell(2, 2)]) // no waypoint there: the aircraft
  })
  it('leaves a row past N84 blank', () => {
    const d = grid({ nav: 'nav.waypoints[1]={ ...navigate.world(83.5,-177.3735), elevation:0, name:"", offset:null };', state: 'grid_state.waypoint=true;' })
    const ids = d.text.filter(([t]) => /^[A-Z] [A-Z]$/.test(t))
    expect(ids.some(([, , py]) => py === cell(0, 0)[1] || py === cell(0, 1)[1])).toBe(false); expect(ids.filter(([, , py]) => py === cell(0, 2)[1]).length).toBe(5)
    for (const label of ['N']) expect(texts(d)).not.toContain(label)
    expect(texts(d)).toContain('S')
  })
})

// The MUMI display (2.13.1.2.2, figure 2-21).
describe('the MUMI display', () => {
  const mumi = (o: { grounded?: boolean; nav?: string; file?: string; at?: number; time?: number } = {}) => page('ddi_mumi', `const ownship={ grounded:${o.grounded ?? true} }, sim_time=${o.time ?? 10};
    ${navdefs} navigate.load(nav,{ identifier:"MIDWAY", waypoints:[], stations:[], points:[] }); ${o.nav ?? ''}
    const mumi={ file:${JSON.stringify(o.file ?? '')}, at:${o.at ?? -1e9} }, MUMI_FILES={ 5:"WYPT", 4:"TCN", 20:"GPS WYPT", 19:"GPS ALM" };`)
  it('shows the memory unit\'s identifier and an option for each file it holds, GPS over WYPT and over ALM', () => {
    const d = mumi()
    expect(d.text).toContainEqual(['MU ID MIDWAY', 256, 96])
    for (const [label, px, py] of [['WYPT', 10, 96], ['TCN', 10, 176], ['WYPT', 96, 482], ['ALM', 176, 482]] as [string, number, number][]) expect(d.text).toContainEqual([label, px, py])
    expect(d.text.filter(([t]) => t === 'GPS').map(([, px, py]) => [px, py])).toEqual([[176, 460], [96, 460]])
    expect(d.rects).toEqual([])
  })
  it('reads NO IDENT with no user files, and leaves their options off', () => {
    const d = mumi({ nav: 'nav.memory.files=[];' })
    expect(texts(d)).toContain('MU ID NO IDENT'); for (const gone of ['WYPT', 'TCN', 'GPS', 'ALM']) expect(texts(d)).not.toContain(gone)
  })
  it('boxes an option for the second its file is read', () => {
    expect(mumi({ file: 'TCN', at: 9.5 }).rects).toContainEqual([-11, 162, 42, 28])
    expect(mumi({ file: 'TCN', at: 8 }).rects).toEqual([])
  })
})

describe('the gauges the pages read', () => {
  it('carry a smoothed yaw rate, vertical speed, air temperature and zulu seconds from the IFEI\'s clock', () => {
    expect(source).toMatch(/heading, yaw:yaw_state\.rate, vspeed:fpm, oat:15-0\.0065\*ownship\.pos\.y, zulu:ifei_zulu\(ifei_view\(\),now\),/)
    expect(source).toMatch(/yaw_state\.rate\+=\(d\/\(t-yaw_state\.t\)-yaw_state\.rate\)\*Math\.min\(1,\(t-yaw_state\.t\)\/0\.5\);/)
  })
})

// The UFC (#15, NATOPS 2.13.5): ufc_face is what the windows show for a state and
// the equipment it reads; ufc_press is one pushbutton against the radios, EMCON and
// stand-ins for the index, the warning latch and the actions it fires;
// ufc_button_at maps a panel point to the painted button under it.
const ufcdefs = ['UFC_PAGES', 'UFC_ENTRY', 'UFC_UNITS', 'UFC_BUTTONS', 'UFC_RADIUS'].map((n) => {
  const m = new RegExp(`\\nconst ${n}=[\\s\\S]*?;`).exec(source)?.[0]
  if (!m) throw new Error(`${n} not found in engine.ts`)
  return m
}).join('\n')
const radiodefs = /\n\/\/ The radios the UFC works[\s\S]*?\nfunction emcon_set[^\n]*\n/.exec(source)?.[0] ?? ''
const shipdefs = 'const SHIP={ ident:"NIM", tacan:{ channel:74, band:"X" }, icls:11 };'
// The autopilot behind the A/P page: the real module, over a jet flying level at 3,000 m and 150 m/s with
// the radar altimeter reading, nothing to couple to unless the test gives a couple.
const pilotdefs = `const hold=autopilot.fresh(); let coupled="", couple=null; const couple_now=()=>couple&&{ couple, label:"CPL WYPT", passed:false };
  const autopilot_sense=(now)=>({ time:0, pitch:2, bank:0, heading:90, track:90, altitude:3000, height:900, vertical:0, cas:150, roll:0, rate:0, approach:false, airborne:true, attitude:true, computer:true,
    stick:{ pitch:0, roll:0 }, trim:{ pitch:0, roll:0 }, selected:120, couple:now?now.couple:null, limit:"nav", ...flying });`
interface Flown { engaged: boolean; modes: Record<string, boolean>; caution: number; altitude: number; source: string }
interface Face { scratch: string; options: string[] }
interface Whole extends Face { windows: string[] }
// The comm radios, the IFF and the Link 16 terminal behind the UFC (G5: #20, #98, #99): the real modules, with the
// ship's four preset frequencies loaded and the codes 11, 0000 and 1200.
const commdefs = `const uhf={ one:communication.fresh([305000,262500,275800,318500]), two:communication.fresh([305000,262500,275800,318500]), panel:communication.panel(11), keypad:communication.backup(), pulled:"" };
  uhf.two.channel=2; const squawk=identification.fresh({ one:"11", two:"0000", three:"1200" }), terminal=mids.fresh();`
interface Ufc { func: string; entry: string; error: boolean; blink: number }
interface Tacan { on: boolean; channel: number; band: string; mode: string; air: boolean }
interface Radios { tacan: Tacan; ils: { on: boolean; channel: number } }
interface Live { emcon?: boolean; tacan?: Partial<Tacan>; ils?: Partial<Radios['ils']>; timer?: string; precise?: boolean; unit?: string; meridian?: string; test?: number; modes?: string[]; offered?: string[]; link?: boolean; beacon?: boolean; pulled?: string; setup?: string }
interface Pressed { ufc: Ufc; index: number; disabled: boolean; pressed: string[]; emcon: boolean; radar: boolean; radios: Radios & { link: { on: boolean }; beacon: { on: boolean } }; face: Whole; hold: Flown; coupled: string
  uhf: { one: communication.Radio; two: communication.Radio; pulled: string }; squawk: identification.Identification; terminal: mids.Terminal }
const fresh = (over: Partial<Ufc> = {}): Ufc => ({ func: '', entry: '', error: false, blink: 0, ...over })
// ufcwhole: every window of the face - the scratchpad, the five options and the two comm channel windows; live.pulled
// is the comm channel selector pulled, and live.setup runs against the radios, the IFF and the terminal first.
function ufcwhole(state: Ufc, live: Live = {}, now = 0): Whole {
  const run = new Function('state', 'live', 'now', 'autopilot', 'communication', 'identification', 'mids', `${ufcdefs} ${commdefs} ${lift('ufc_face')}
    uhf.pulled=live.pulled||""; ${live.setup ?? ''}
    const radios={ tacan:{ on:true, channel:74, band:"X", mode:"tr", air:false, ...live.tacan }, ils:{ on:true, channel:11, ...live.ils }, link:{ on:live.link??true }, beacon:{ on:live.beacon??true } };
    const set=(names)=>Object.fromEntries(autopilot.MODES.map(m=>[m,names.includes(m)]));
    return ufc_face(state, { ...live, emcon:!!live.emcon, radios, comm:uhf, squawk, terminal, timer:live.timer ?? "", autopilot:{ modes:set(live.modes??[]), offered:set(live.offered??["attitude","select","barometric","radar"]) } }, now);`)
  return run(state, live, now, autopilot, communication, identification, mids) as Whole
}
// ufcface: the scratchpad and the options, which is all a page that is not a radio's changes
function ufcface(state: Ufc, live: Live = {}, now = 0): Face {
  const { scratch, options } = ufcwhole(state, live, now)
  return { scratch, options }
}
function ufcpress(buttons: string[], start: Partial<Ufc> = {}, index = 200, sounding = false, flying: Record<string, unknown> = {}, couple: autopilot.Couple | null = null): Pressed {
  const run = new Function('buttons', 'start', 'index', 'sounding', 'autopilot', 'flying', 'given', 'communication', 'identification', 'mids', `${ufcdefs} ${shipdefs} ${pilotdefs} ${commdefs} couple=given;
    let law_index=index, law_primary=sounding, law_disabled=false, ufc_dirty=false, ddi_dirty=false; const RADAR={ emcon:false }, pressed=[], data_enter=()=>false, grid_sync=()=>{}, grid_open=()=>{}, nav={ precise:false, units:{}, meridian:"true" };
    const pit_press=(a)=>pressed.push(a), timer_enter=()=>false, timer={ shown:"" };
    const ufc_update=()=>{}; const performance={ now:()=>1000 };
    const ufc={ func:"", entry:"", error:false, blink:0, option:-1, letter:"", half:null, after:null, kind:"", ...start };
    ${radiodefs} ${lift('ufc_enter')} ${lift('comm_knob')} ${lift('ufc_press')} ${lift('ufc_face')}
    ${lift('ufc_live')} const sim_time=0, ufc_test={ at:-Infinity };
    for(const b of buttons){ const knob=/^(one|two)([+-]?)$/.exec(b); if(knob) comm_knob(knob[1],knob[2]==="+"?1:knob[2]==="-"?-1:0); else ufc_press(b); }   // one, two: a comm channel selector pulled; one+, one-: turned
    return { ufc, index:law_index, disabled:law_disabled, pressed, emcon, radar:RADAR.emcon, radios, face:ufc_face(ufc, ufc_live(), 2000), hold, coupled, uhf, squawk, terminal };`)
  return run(buttons, start, index, sounding, autopilot, flying, couple, communication, identification, mids) as Pressed
}
function ufcbutton(y: number, z: number): string | null {
  const run = new Function('y', 'z', `${ufcdefs} ${lift('ufc_button_at')} return ufc_button_at(y, z);`)
  return run(y, z) as string | null
}
const blank = ' '.repeat(9)

describe('the UFC windows', () => {
  it('power up clear', () => {
    expect(ufcface(fresh())).toEqual({ scratch: blank, options: ['', '', '', '', ''] })
  })

  it('show the autopilot\'s options that are available, a colon ahead of each selected, the scratchpad holding only a keyed entry (2.9)', () => {
    expect(ufcface(fresh({ func: 'ap' }))).toEqual({ scratch: blank, options: [' ATTH', ' HSEL', ' BALT', ' RALT', ''] }) // nothing to couple to: no CPL
    expect(ufcface(fresh({ func: 'ap' }), { offered: ['attitude', 'select', 'barometric', 'radar', 'coupled'], modes: ['select', 'barometric'] }).options).toEqual([' ATTH', ':HSEL', ':BALT', ' RALT', ' CPL'])
    expect(ufcface(fresh({ func: 'ap' }), { offered: ['barometric', 'coupled'], modes: ['coupled'] }).options).toEqual(['', '', ' BALT', '', ':CPL']) // coupled: no ATTH or HSEL, and no RALT out of the altimeter's reach
    expect(ufcface(fresh({ func: 'ap', entry: '500' })).scratch).toBe('      500')
  })
  it('show the data link and the radar beacon ON, the data link with its link\'s number (2.13.5, 24.6.1.2.1)', () => {
    expect(ufcface(fresh({ func: 'dl' }))).toEqual({ scratch: 'ON      4', options: ['', '', '', '', ''] }); expect(ufcface(fresh({ func: 'dl' }), { link: false }).scratch).toBe('        4')
    expect(ufcface(fresh({ func: 'link' }))).toEqual({ scratch: 'ON     16', options: ['', '', '', '', ''] }); expect(ufcface(fresh({ func: 'link' }), { setup: 'terminal.on=false;' }).scratch).toBe('       16') // D/L's second display, the MIDS terminal's
    expect(ufcface(fresh({ func: 'bcn' })).scratch).toBe('ON       '); expect(ufcface(fresh({ func: 'bcn' }), { beacon: false }).scratch).toBe(blank)
  })

  it('show the TACAN ON with its channel, cueing its mode, A/A and band (NATOPS 24.4.2, 2.13.5.6)', () => {
    expect(ufcface(fresh({ func: 'tcn' }))).toEqual({ scratch: 'ON     74', options: [':T/R', ' RCV', ' A/A', ':X', ' Y'] })
    expect(ufcface(fresh({ func: 'tcn' }), { tacan: { mode: 'rcv', air: true, band: 'Y' } }).options).toEqual([' T/R', ':RCV', ':A/A', ' X', ':Y'])
    expect(ufcface(fresh({ func: 'tcn' }), { tacan: { on: false, channel: 109 } }).scratch).toBe('      109')
    expect(ufcface(fresh({ func: 'tcn', entry: '12' })).scratch).toBe('ON     12')
  })

  it('show the ILS ON with its channel under CHNL (24.5.4)', () => {
    expect(ufcface(fresh({ func: 'ils' }))).toEqual({ scratch: 'ON     11', options: [':CHNL', '', '', '', ''] })
    expect(ufcface(fresh({ func: 'ils' }), { ils: { on: false, channel: 3 } }).scratch).toBe('        3')
  })

  it('run E M C O N down the option windows under EMCON, whatever the page (2.13.5.2)', () => {
    for (const func of ['', 'tcn', 'ap', 'time']) expect(ufcface(fresh({ func }), { emcon: true }).options).toEqual(['E', 'M', 'C', 'O', 'N'])
    expect(ufcface(fresh({ func: 'tcn' }), { emcon: true }).scratch).toBe('ON     74')
  })

  it('flash ERROR at 2 Hz and blank the scratchpad once after a valid entry', () => {
    expect(ufcface(fresh({ error: true }), {}, 0).scratch).toBe('ERROR    ')
    expect(ufcface(fresh({ error: true }), {}, 0.5).scratch).toBe(blank)
    expect(ufcface(fresh({ error: true }), {}, 1.0).scratch).toBe('ERROR    ')
    expect(ufcface(fresh({ func: 'tcn', blink: 2 }), {}, 1.9).scratch).toBe(blank)
    expect(ufcface(fresh({ func: 'tcn', blink: 2 }), {}, 2.1).scratch).toBe('ON     74')
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

describe('the UFC\'s data pages', () => {
  it('offers the waypoint\'s options, HDTH only with PRECISE, and the offset\'s', () => {
    expect(ufcface(fresh({ func: 'wypt' })).options).toEqual([' POSN', '', ' ELEV', ' GRID', ' O/S'])
    expect(ufcface(fresh({ func: 'wypt' }), { precise: true }).options).toEqual([' POSN', ' HDTH', ' ELEV', ' GRID', ' O/S'])
    expect(ufcface(fresh({ func: 'offset' })).options).toEqual([' RNG', ' BRG', ' ELEV', ' GRID', ''])
  })
  it('cues the unit in use on a units page, and reads the bearing\'s meridian in its one option', () => {
    expect(ufcface(fresh({ func: 'elevation' }), { unit: 'mtrs' }).options).toEqual([' FEET', ':MTRS', '', '', ''])
    expect(ufcface(fresh({ func: 'elevation' }), { unit: 'feet' }).options).toEqual([':FEET', ' MTRS', '', '', ''])
    expect(ufcface(fresh({ func: 'range' }), { unit: 'yard' }).options).toEqual([' FEET', ' MTRS', ' NM', ':YARD', ''])
    expect(ufcface(fresh({ func: 'bearing' }), { meridian: 'true' }).options).toEqual([':TRUE', '', '', '', ''])
    expect(ufcface(fresh({ func: 'bearing' }), { meridian: 'magnetic' }).options).toEqual([':MAG', '', '', '', ''])
  })
  it('lights the outer segments for five seconds and the inner for the next five in its test, every option cue with them (figure 2-48)', () => {
    expect(ufcface(fresh({ func: 'tcn', entry: '12' }), { test: 1 })).toEqual({ scratch: '008888888', options: Array(5).fill(':0000') })
    expect(ufcface(fresh(), { test: 2 })).toEqual({ scratch: '**8888888', options: Array(5).fill(':****') })
    expect(ufcface(fresh(), { test: 0 }).scratch).toBe('         ')
  })
  it('runs a precise grid\'s ten digits off the left of the scratchpad', () => {
    expect(ufcface(fresh({ func: 'wypt', entry: '6340338642' })).scratch).toBe('340338642')
    expect(ufcface(fresh({ func: 'wypt', entry: '634386' })).scratch).toBe('   634386')
  })
})

// The comm channel display windows and the comm display (23.2.1.1, figures 23-1 and 23-2; #20).
describe('the UFC\'s comm windows and display', () => {
  it('shows each radio\'s channel in the window by its selector: a preset\'s number, G or M', () => {
    expect(ufcwhole(fresh()).windows).toEqual(['1', '2'])
    expect(ufcwhole(fresh(), { setup: 'uhf.one.channel="G"; uhf.two.channel="M";' }).windows).toEqual(['G', 'M'])
    expect(ufcwhole(fresh(), { setup: 'uhf.one.channel=20;' }).windows).toEqual(['20', '2'])
  })
  it('blanks the window of a radio that is off', () => {
    expect(ufcwhole(fresh(), { setup: 'uhf.two.on=false;' }).windows).toEqual(['1', ''])
  })
  it('lights the windows\' segments in the UFC\'s test with the rest', () => {
    expect(ufcwhole(fresh(), { test: 1 }).windows).toEqual(['00', '00']); expect(ufcwhole(fresh(), { test: 2 }).windows).toEqual(['**', '**'])
  })
  it('shows the channel and its frequency in the scratchpad with a selector pulled, and GRCV, SQCH, CPHR and the modulation as options', () => {
    expect(ufcwhole(fresh({ func: 'comm' }), { pulled: 'one' })).toEqual({ scratch: ' 1 305.000', options: [':GRCV', ':SQCH', ' CPHR', ':AM', ''], windows: ['1', '2'] })
    expect(ufcface(fresh({ func: 'comm' }), { pulled: 'two' }).scratch).toBe(' 2 262.500')
    expect(ufcface(fresh({ func: 'comm' }), { pulled: 'one', setup: 'uhf.one.channel="M";' }).scratch).toBe('M- 225.000')
    expect(ufcface(fresh({ func: 'comm' }), { pulled: 'one', setup: 'uhf.one.channel="G";' }).scratch).toBe('G- 243.000')
  })
  it('cues each option that is on with its colon, and leaves the modulation window blank where the band leaves no choice', () => {
    expect(ufcface(fresh({ func: 'comm' }), { pulled: 'one', setup: 'uhf.one.receiver=false; uhf.one.cipher=true; uhf.one.choice="fm";' }).options).toEqual([' GRCV', ':SQCH', ':CPHR', ':FM', ''])
    expect(ufcface(fresh({ func: 'comm' }), { pulled: 'one', setup: 'uhf.one.channel="M"; uhf.one.manual=121500;' }).options[3]).toBe('') // VHF AM
  })
  it('shows the frequency being keyed after the channel', () => {
    expect(ufcface(fresh({ func: 'comm', entry: '2513' }), { pulled: 'one' }).scratch).toBe(' 1   2513')
  })
  it('comes up when a channel selector is pulled, goes to the other radio when its is, and off when the same one is pulled again', () => {
    expect(ufcpress(['one'])).toMatchObject({ ufc: { func: 'comm' }, uhf: { pulled: 'one' } })
    expect(ufcpress(['one', 'two'])).toMatchObject({ ufc: { func: 'comm' }, uhf: { pulled: 'two' } })
    expect(ufcpress(['one', 'one'])).toMatchObject({ ufc: { func: '' }, uhf: { pulled: '' } })
    expect(ufcpress(['one', 'two']).face.scratch).toBe(' 2 262.500')
  })
  it('gives way to a function selector, and to CLR pressed on an empty scratchpad', () => {
    expect(ufcpress(['one', 'tcn'])).toMatchObject({ ufc: { func: 'tcn' }, uhf: { pulled: '' } })
    expect(ufcpress(['one', '2', 'clr'])).toMatchObject({ ufc: { func: 'comm', entry: '' }, uhf: { pulled: 'one' } })
    expect(ufcpress(['one', '2', 'clr', 'clr'])).toMatchObject({ ufc: { func: '' }, uhf: { pulled: '' } })
  })
  it('steps the channel as a selector is turned, the window following it', () => {
    const turned = ufcpress(['one+', 'one+', 'two-'])
    expect([turned.uhf.one.channel, turned.uhf.two.channel, turned.face.windows]).toEqual([3, 1, ['3', '1']])
    expect(ufcpress(['one+']).ufc.func).toBe('') // turning brings no display up
  })
  it('takes six digits and stores them with ENT in the channel selected, blinking once (23.2.2)', () => {
    const keyed = ufcpress(['one', '2', '5', '1', '0', '0', '0', '9', 'ent'])
    expect(keyed.uhf.one.presets[0]).toBe(251000); expect(keyed.ufc).toMatchObject({ entry: '', error: false, blink: 1.3 })
    expect(keyed.uhf.two.presets[0]).toBe(305000) // the other radio's preset 1 is its own
    expect(ufcpress(['one', 'one-', '2', '5', '1', '0', '0', '0', 'ent']).uhf.one.manual).toBe(251000) // back one from preset 1: M
    expect(ufcpress(['two', '1', '2', '1', '5', '0', '0', 'ent']).uhf.two.presets[1]).toBe(121500)
  })
  it('flags ERROR for an entry that is not a frequency the radio tunes', () => {
    expect(ufcpress(['one', '1', '2', '3', 'ent']).ufc.error).toBe(true)
    expect(ufcpress(['one', '2', '5', '1', '0', '1', '0', 'ent'])).toMatchObject({ ufc: { error: true }, uhf: { one: { presets: { 0: 305000 } } } }) // off the 25 kHz spacing
    expect(ufcpress(['one', '1', '0', '0', '0', '0', '0', 'ent']).ufc.error).toBe(true) // between the bands
  })
  it('turns each option on and off with its pushbutton, the modulation only where there is a choice', () => {
    expect(ufcpress(['one', 'opt0', 'opt1', 'opt2', 'opt3']).uhf.one).toMatchObject({ receiver: false, squelch: false, cipher: true, choice: 'fm' })
    expect(ufcpress(['two', 'opt0']).uhf).toMatchObject({ one: { receiver: true }, two: { receiver: false } })
    expect(ufcpress(['one', 'one-', 'one-', 'opt3']).uhf.one.choice).toBe('fm') // G, 243.0: UHF
  })
})

// The IFF displays (23.6.1.2, 23.6.2.1, figure 23-8; #98).
describe('the UFC\'s IFF displays', () => {
  it('bring up the transponder with XP, mode 3 and its code, and each mode as an option, a colon before those enabled', () => {
    const d = ufcpress(['iff'])
    expect(d.ufc.func).toBe('iff'); expect(d.squawk.shown).toBe('transponder')
    expect(d.face).toMatchObject({ scratch: 'XP 3-1200', options: [':1-11', ':2', ':3 C', ':4A', ''] })
  })
  it('change to the interrogator, AI, on a second press of IFF, and back on a third', () => {
    expect(ufcpress(['iff', 'iff'])).toMatchObject({ ufc: { func: 'iff' }, squawk: { shown: 'interrogator' }, face: { scratch: 'AI 3-1200' } })
    expect(ufcpress(['iff', 'iff', 'iff']).squawk.shown).toBe('transponder')
    expect(ufcpress(['iff', 'iff', 'tcn', 'iff']).squawk.shown).toBe('transponder') // from another page it is the transponder's again
  })
  it('enable and disable modes 1 and 2 with their options, each putting its code in the scratchpad', () => {
    const one = ufcpress(['iff', 'opt0'])
    expect(one.squawk.transponder.modes.one).toBe(false); expect(one.face).toMatchObject({ scratch: 'XP   1-11', options: [' 1-11', ':2', ':3 C', ':4A', ''] })
    expect(ufcpress(['iff', 'opt1']).face).toMatchObject({ scratch: 'XP 2-0000', options: [':1-11', ' 2', ':3 C', ':4A', ''] })
    expect(ufcpress(['iff', 'iff', 'opt0']).squawk).toMatchObject({ transponder: { modes: { one: true } }, interrogator: { modes: { one: false } } }) // each set its own
  })
  it('step mode 3 and C through 3 alone, both off and both on, and mode 4 through 4B and back', () => {
    const third = (n: number) => ufcpress(['iff', ...Array(n).fill('opt2')]).face.options[2], fourth = (n: number) => ufcpress(['iff', ...Array(n).fill('opt3')]).face.options[3]
    expect([0, 1, 2, 3].map(third)).toEqual([':3 C', ':3', ' 3 C', ':3 C'])
    expect([0, 1, 2, 3, 4].map(fourth)).toEqual([':4A', ' 4B', ':4B', ' 4A', ':4A'])
  })
  it('take a keyed code with ENT for the mode in the scratchpad: four octal digits, or mode 1\'s two', () => {
    const three = ufcpress(['iff', '7', '7', '0', '0', '1', 'ent'])
    expect(three.squawk.transponder.codes.three).toBe('7700'); expect(three.squawk.interrogator.codes.three).toBe('1200'); expect(three.ufc).toMatchObject({ entry: '', error: false })
    expect(ufcpress(['iff', 'opt1', '1', '2', '3', '4', 'ent']).squawk.transponder.codes.two).toBe('1234')
    expect(ufcpress(['iff', 'opt0', '7', '3', '5', 'ent']).squawk.transponder.codes.one).toBe('73') // two digits and no more
  })
  it('flag ERROR for a code that is not one', () => {
    expect(ufcpress(['iff', '1', '2', '8', '0', 'ent'])).toMatchObject({ ufc: { error: true }, squawk: { transponder: { codes: { three: '1200' } } } })
    expect(ufcpress(['iff', 'opt0', '4', '4', 'ent']).ufc.error).toBe(true) // mode 1's second digit runs to 3
    expect(ufcpress(['iff', '7', '7', 'ent']).ufc.error).toBe(true)
  })
  it('show the code being keyed in place of the one held', () => {
    expect(ufcpress(['iff', '7', '7']).face.scratch).toBe('XP   3-77')
  })
  it('turn the set off and on with ON/OFF, the XP or AI going with it', () => {
    const off = ufcpress(['iff', 'onoff'])
    expect(off.squawk.on).toBe(false); expect(off.face.scratch).toBe('   3-1200')
    expect(ufcpress(['iff', 'onoff', 'onoff']).squawk.on).toBe(true)
  })
  it('drop mode 4\'s option once its codes are gone', () => {
    expect(ufcwhole(fresh({ func: 'iff' }), { setup: 'squawk.held=false;' }).options).toEqual([':1-11', ':2', ':3 C', '', ''])
  })
})

// D/L with MIDS aboard (AFC 270, 2.13.5; #99): the key changes between the Link 4 and Link 16 displays.
describe('the UFC\'s D/L key', () => {
  it('brings up Link 4, then Link 16, then Link 4 again', () => {
    expect(ufcpress(['dl']).ufc.func).toBe('dl'); expect(ufcpress(['dl', 'dl']).ufc.func).toBe('link'); expect(ufcpress(['dl', 'dl', 'dl']).ufc.func).toBe('dl')
    expect(ufcpress(['tcn', 'dl']).ufc.func).toBe('dl') // from another page: Link 4 first
  })
  it('turns the MIDS terminal on and off with ON/OFF on its Link 16 display, and the Link 4 data link on its own', () => {
    const link = ufcpress(['dl', 'dl', 'onoff'])
    expect([link.terminal.on, link.radios.link.on, link.face.scratch]).toEqual([false, true, '       16'])
    const four = ufcpress(['dl', 'onoff'])
    expect([four.terminal.on, four.radios.link.on, four.face.scratch]).toEqual([true, false, '        4'])
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

  it('tune the TACAN (1-126) and the ILS (1-20) with ENT, blinking once, and flag ERROR out of range (24.4.2, 24.5.4)', () => {
    const tuned = ufcpress(['tcn', '1', '0', '9', 'ent'])
    expect(tuned.radios.tacan.channel).toBe(109)
    expect(tuned.ufc).toMatchObject({ entry: '', error: false, blink: 1.3 })
    expect(ufcpress(['ils', '3', 'ent']).radios.ils.channel).toBe(3)
    expect(ufcpress(['ils', '3', 'ent']).radios.tacan.channel).toBe(74)
    const untouched = ufcpress([]).radios
    for (const keys of [['tcn', '1', '2', '7'], ['tcn', '0'], ['ils', '2', '1'], ['ils', '0'], ['tcn'], ['ils']]) {
      const refused = ufcpress([...keys, 'ent'])
      expect(refused.ufc.error, keys.join()).toBe(true)
      expect(refused.radios, keys.join()).toEqual(untouched)
    }
  })

  it('key nothing with ENT from the autopilot page: the low-altitude index is the knob\'s, not the UFC\'s, so an entry flags ERROR', () => {
    const keyed = ufcpress(['ap', 'opt3', '5', '0', '0', 'ent'])
    expect(keyed.index).toBe(200)
    expect(keyed.ufc.error).toBe(true)
    expect(ufcpress(['ap', 'opt3', 'ent']).ufc.error).toBe(true)
    expect(ufcpress(['ap', '5', 'ent']).ufc.error).toBe(true)
    expect(ufcpress(['ap', 'opt3', '5', '0', '0', 'ent', '7']).ufc.entry).toBe('500')
    expect(ufcpress(['ap', 'opt3', '5', '0', '0', 'ent', 'clr']).ufc.error).toBe(false)
  })

  it('disable a sounding primary warning with :RALT or another UFC mode, and cue no autopilot mode (NATOPS 2.12.5.1)', () => {
    expect(ufcpress(['opt3'], { func: 'ap' }, 200, true).disabled).toBe(true)
    expect(ufcpress(['tcn'], {}, 200, true).disabled).toBe(true)
    expect(ufcpress(['opt3'], { func: 'ap' }, 200, false).disabled).toBe(false) // nothing sounding, nothing to disable
    expect(ufcpress(['1', 'clr'], { func: 'ap' }, 200, true).disabled).toBe(false) // the keypad is not a mode change
    expect(ufcpress(['opt2'], { func: 'ap' }, 200, true).disabled).toBe(false) // BALT is not :RALT
    expect(ufcpress(['opt3'], { func: 'tcn' }, 200, true).disabled).toBe(false) // nor is the TACAN's X
  })
  it('engage the basic autopilot with ON/OFF on the A/P page, and take everything off with it again (2.9.2.1)', () => {
    const on = ufcpress(['ap', 'onoff'])
    expect([on.hold.engaged, on.hold.modes, on.face.options]).toEqual([true, { attitude: false, select: false, barometric: false, radar: false, coupled: false }, [' ATTH', ' HSEL', ' BALT', ' RALT', '']])
    const off = ufcpress(['ap', 'opt2', 'onoff'])
    expect([off.hold.engaged, off.hold.modes.barometric]).toEqual([false, false])
    expect(ufcpress(['ap', 'onoff'], {}, 200, false, { bank: 75 }).hold).toMatchObject({ engaged: false, caution: 10 }) // past 70° of bank it does not engage: AUTO PILOT
  })
  it('select a mode with its option, the autopilot coming on with it, and deselect it with a second press (2.9.2.1)', () => {
    const balt = ufcpress(['ap', 'opt2'])
    expect([balt.hold.engaged, balt.hold.modes.barometric, balt.hold.altitude, balt.face.options]).toEqual([true, true, 3000, [' ATTH', ' HSEL', ':BALT', ' RALT', '']])
    expect(ufcpress(['ap', 'opt3']).hold).toMatchObject({ modes: { radar: true }, altitude: 900 }); expect(ufcpress(['ap', 'opt2', 'opt3']).hold.modes).toMatchObject({ barometric: false, radar: true })
    expect(ufcpress(['ap', 'opt0', 'opt1']).hold.modes).toMatchObject({ attitude: false, select: true })
    const again = ufcpress(['ap', 'opt2', 'opt2'])
    expect([again.hold.engaged, again.hold.modes.barometric]).toEqual([true, false]) // the basic autopilot stays
  })
  it('take no press on an option that is not displayed, and raise no caution for it', () => {
    const none = ufcpress(['ap', 'opt4'])
    expect([none.hold.engaged, none.hold.caution]).toEqual([false, -Infinity])
    expect(ufcpress(['ap', 'opt3'], {}, 200, false, { height: null }).hold.engaged).toBe(false) // no radar altitude: no RALT
  })
  it('couple with CPL to the steering there is, taking its label for the HUD and HSI, and uncouple with a second press (2.9.2.6)', () => {
    const steering: autopilot.Couple = { axis: 'track', value: 45, vertical: null }
    const on = ufcpress(['ap', 'opt0', 'opt4'], {}, 200, false, {}, steering)
    expect([on.hold.modes, on.hold.source, on.coupled, on.face.options]).toEqual([{ attitude: false, select: false, barometric: false, radar: false, coupled: true }, 'track', 'CPL WYPT', ['', '', ' BALT', ' RALT', ':CPL']])
    const off = ufcpress(['ap', 'opt4', 'opt4'], {}, 200, false, {}, steering)
    expect([off.hold.engaged, off.hold.modes.coupled, off.hold.caution]).toEqual([true, false, -Infinity]) // the pilot's own deselection: no caution
  })
  it('turn the data link and the radar beacon on and off with ON/OFF', () => {
    expect(ufcpress(['dl', 'onoff']).radios.link.on).toBe(false); expect(ufcpress(['bcn', 'onoff']).radios.beacon.on).toBe(false)
    expect(ufcpress(['dl', 'onoff', 'onoff']).radios.link.on).toBe(true); expect(ufcpress(['dl', 'onoff']).radios.beacon.on).toBe(true)
  })

  it('show the autopilot page from A/P without engaging ATC, which is the throttle\'s, and clear it on a second press', () => {
    const on = ufcpress(['ap'])
    expect(on.ufc.func).toBe('ap')
    expect(on.pressed).toEqual([])
    expect(ufcpress(['ap', 'ap']).ufc.func).toBe('')
  })

  it('turn the selected radio on and off with ON/OFF, and nothing on the other pages (2.13.5.10)', () => {
    expect(ufcpress(['tcn', 'onoff']).radios.tacan.on).toBe(false)
    expect(ufcpress(['tcn', 'onoff']).face.scratch).toBe('       74')
    expect(ufcpress(['tcn', 'onoff', 'onoff']).radios.tacan.on).toBe(true)
    expect(ufcpress(['ils', 'onoff']).radios).toEqual({ ...ufcpress([]).radios, ils: { on: false, channel: 11 } })
    for (const func of ['', 'ap', 'iff', 'time']) expect(ufcpress(['onoff'], { func }).radios, func).toEqual(ufcpress([]).radios)
  })

  it('select T/R or RCV, A/A and the X or Y band from the TCN options (24.4.2)', () => {
    const t = (keys: string[]) => ufcpress(['tcn', ...keys]).radios.tacan
    expect(t(['opt1'])).toMatchObject({ mode: 'rcv', air: false, band: 'X' })
    expect(t(['opt1', 'opt0']).mode).toBe('tr')
    expect(t(['opt2']).air).toBe(true)
    expect(t(['opt2', 'opt2']).air).toBe(false)
    expect(t(['opt4']).band).toBe('Y')
    expect(t(['opt4', 'opt3']).band).toBe('X')
    expect(ufcpress(['ils', 'opt1', 'opt2', 'opt4']).radios).toEqual(ufcpress([]).radios) // the TACAN's options only on its page
  })

  it('toggle EMCON, the radar\'s copy of the discrete with it, and drop the entry on a page change', () => {
    const e = ufcpress(['emcon'])
    expect([e.emcon, e.radar]).toEqual([true, true])
    expect(e.pressed).toEqual([]) // not the radar knob
    const twice = ufcpress(['emcon', 'emcon'])
    expect([twice.emcon, twice.radar]).toEqual([false, false])
    const moved = ufcpress(['ap', 'opt3', '5', 'tcn'])
    expect(moved.ufc).toMatchObject({ func: 'tcn', entry: '' })
  })

  it('map a panel point to the painted button under it, within the key pitch', () => {
    expect(ufcbutton(0.453, -0.061)).toBe('1')
    expect(ufcbutton(0.386, -0.018)).toBe('ent')
    expect(ufcbutton(0.351, -0.065)).toBe('ap')
    expect(ufcbutton(0.412, 0.006)).toBe('opt3')
    expect(ufcbutton(0.447, 0.086)).toBe('emcon') // second down the right column (figure 23-1)
    expect(ufcbutton(0.477, -0.088)).toBe('ip') // at the head of the left
    expect(ufcbutton(0.450, -0.085)).toBe(null) // the ADF switch, which is no pushbutton
    expect(ufcbutton(0.351, 0.041)).toBe('bcn')
    expect(ufcbutton(0.351, 0.062)).toBe('onoff')
    expect(ufcbutton(0.453 + 0.008, -0.061)).toBe('1')
    expect(ufcbutton(0.470, -0.050)).toBe(null)
    expect(ufcbutton(0.300, 0)).toBe(null)
  })

  it('are wired: built with the faces, redrawn on the 120 ms economy, clicked through the panel point, ATC on the throttle\'s key, and powered up clear with the radios tuned', () => {
    expect(source).toMatch(/build_ifei\(g\); build_ufc\(g\); build_faces\(g\); \}/)
    expect(source).toMatch(/if\(pit\)\{ ifei_update\(stale\); ufc_update\(stale\); \}/)
    expect(source).toMatch(/if\(ownship\.group\.userData\.ufc\)\{ const h=_click_ray\.intersectObject\(ownship\.group,true\)\.find\(k=>!k\.object\.userData\.overlay&&shown\(k\.object\)\);/)
    expect(source).toMatch(/button=p&&p\.x>6\.10&&p\.x<6\.18\?ufc_button_at\(p\.y,p\.z\):null;\n\t\tif\(button\)\{ ufc_press\(button\); return; \}/)
    expect(source).toMatch(/if\(ch===key_of\("atc"\)\)\{ hotas\.atc=sim_time; pit_press\("atc",0\); \}/)
    expect(source).toMatch(/case "atc": if\(atc_on\)\{ atc_on=false; atc_flash=-Infinity; \} else \{ const mode=atc_engage\(\); if\(mode\)\{ atc_on=true;/)
    expect(source).toMatch(/law_primary=false; law_disabled=false; law_index=st==="carrier"\?40:200;/)
    expect(source).toMatch(/ufc\.func=""; ufc\.entry=""; ufc\.error=false; ufc\.blink=0; ufc_dirty=true; Object\.assign\(radios,radios_tuned\(\)\); emcon_set\(false\);/)
    expect(source).toMatch(/new THREE\.MeshBasicMaterial\(\{ map:tex, toneMapped:false, transparent:true, depthWrite:false, side:THREE\.DoubleSide \}\)\);   \/\/ transparent: the painted keypad/)
  })
})

// The ICLS needles and bars live only with the ILS on and tuned to the ship (24.5.4),
// on an approach the stand-in geometry puts the jet on.
describe('the ILS needles', () => {
  const needles = (ils: string, panel = '') => new Function('communication', `const THREE={ MathUtils:{ clamp:(v,lo,hi)=>Math.min(hi,Math.max(lo,v)) } }, SHIP={ icls:11 }, radios={ ils:${ils} }, uhf={ panel:communication.panel(11) }; ${panel}
    const carrier_ols={ tdx:0, tdz:0, dy:0 }, ownship={ pos:{ x:0, y:100, z:1000 }, fwd:{ x:0, z:-1 }, gearTarget:0 }, ols_dev=()=>({ along:1000, dist:1000, lat:0, dev:0.4 });
    ${lift('approach_deviation')} return approach_deviation();`)(communication)
  it('live only with the ILS on and on the ship\'s channel', () => {
    expect(needles('{ on:true, channel:11 }')).toEqual({ az: 0, gs: 0.5 })
    expect(needles('{ on:false, channel:11 }')).toBe(null)
    expect(needles('{ on:true, channel:12 }')).toBe(null)
  })
  it('take the channel from the communication panel\'s own selector with its ILS switch at MAN (23.1)', () => {
    expect(needles('{ on:true, channel:11 }', 'uhf.panel.landing="manual"; uhf.panel.channel=7;')).toBe(null)
    expect(needles('{ on:true, channel:12 }', 'uhf.panel.landing="manual"; uhf.panel.channel=11;')).toEqual({ az: 0, gs: 0.5 })
    expect(needles('{ on:true, channel:12 }', 'uhf.panel.channel=11;')).toBe(null) // at UFC the panel's selector counts for nothing
  })
})

// EMCON silences the radar (2.13.5.2) wherever the game asks whether it transmits:
// those reads go through RADAR.silent(), and RADAR.sil, the radar's own silence, is
// read only for SIL's legends and the knob that sets it.
describe('the radar silence the game reads', () => {
  it('asks RADAR.silent(), leaving RADAR.sil to the SIL legends and the knob', () => {
    const reads = source.split('\n').filter((l) => /RADAR\.sil\b/.test(l)).map((l) => l.replace(/\s*\/\/.*$/, '').trim())
    expect(reads).toEqual([
      'if(pb===8){ RADAR.sil=!RADAR.sil; return true; }',
      'ddi_legend(x,8,"SIL",true,RADAR.sil);',
      'if(RADAR.sil){ x.font="22px monospace"; x.textAlign="center"; x.fillText("SIL",256,108); }',
      'case "radar": RADAR.sil=d>0?false:d<0?true:!RADAR.sil; break;',
      'case "radaropr": f=(st===ownship&&RADAR.sil)?1/3:2/3; break;',
      'if(RADAR.sil) rows.push([GR,"SIL"]);',
      'RADAR.sil=false; RADAR.width=0; RADAR.bars=2; RADAR.stt=null; RADAR.ls=null; RADAR.memory=0; RADAR.auto=false; RADAR.acm="bst";',
    ])
    expect(source.match(/RADAR\.silent\(\)/g)?.length).toBe(10) // the tenth: whether the radar can give an inflight alignment its velocities
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
  const timeufc = (buttons: (string | number)[]): Timed => new Function('buttons', 'navigate', 'autopilot', 'communication', 'identification', 'mids', `${ufcdefs} ${shipdefs} const flying={}; ${pilotdefs} ${commdefs} const master="nav", link={ selected:false }, mc=()=>({ one:true, two:true }); let sim_time=0; ${timers}
    let law_primary=false, law_disabled=false, ufc_dirty=false, ddi_dirty=false; const RADAR={ emcon:false }, ufc_update=()=>{}, performance={ now:()=>1000 }, data_enter=()=>false, grid_sync=()=>{}, grid_open=()=>{}, ownship={};
    const ufc={ func:"", entry:"", error:false, blink:0, option:-1, letter:"", half:null, after:null, kind:"" }, hsi_state={ dctr:false, map:false, level:"" }, hsi_range=()=>{}; ${navdefs}
    ${radiodefs} ${lift('ufc_enter')} ${lift('ufc_press')} ${lift('hsi_press')} ${lift('ufc_face')}
    for(const b of buttons){ if(typeof b==="number") sim_time=b; else if(b==="timeufc") hsi_press(17,"left"); else ufc_press(b); }
    return { ufc, shown:timer.shown, et:timer_seconds("et"), cd:timer_seconds("cd"), running:{ et:timer.et.since!==null, cd:timer.cd.since!==null },
      face:ufc_face(ufc, { emcon, radios, comm:uhf, squawk, terminal, timer:timer.shown, autopilot:{ modes:hold.modes, offered:{} } }, 0) };`)(buttons, navigate, autopilot, communication, identification, mids) as Timed

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
  function run(menu: string, press = 0, designator = 'center', shows = 'hud', computers = { one: true, two: true }, time = 0) {
    return new Function('avionics', `let ddi_draws=0, ddi_dirty=false, shown='', spin_up=false, last_out=[], designator=${JSON.stringify(designator)};
      const sim_time=${time}, mc=()=>(${JSON.stringify(computers)}), display_test={ on:false };
      const ddi_state={ left:{ page:${JSON.stringify(shows)}, menu:${JSON.stringify(menu)} } }, DDI_PAGES={}, DDI_MENUS=${JSON.stringify(menus)};
      function cautions_draw(){} function ddi_show(d,p){ shown=p; } const caution_page=()=>null, caution_host=()=>null;
      ${lift('ddi_legend')} ${lift('ddi_render')} ${lift('ddi_press')} ${lift('diamond')}
      const text=[], rects=[], moves=[];
      const x=new Proxy({}, { get:(t,k)=>{ if(k==='fillText') return (s,px,py)=>text.push([String(s),px,py]); if(k==='strokeRect') return (a,b,c,d)=>rects.push([a,b,c,d]); if(k==='measureText') return (s)=>({ width:10*String(s).length }); if(k==='moveTo'||k==='lineTo') return (px,py)=>moves.push([px,py]); return ()=>{}; }, set:()=>true });
      if(${press}) ddi_press('left',${press}); else ddi_render(x,512,'left');
      return { text, rects, shown, moves };`)(avionics) as { text: [string, number, number][]; rects: [number, number, number, number][]; shown: string; moves: [number, number][] }
  }
  // The TDC assignment diamond (#27, #32): the upper right corner of the display
  // the sensor control switch gave the TDC, and no other.
  it('writes MENU at its pushbutton on every page but the grid display, whose S shift is there', () => {
    const labels = (menu: string, shows: string) => run(menu, 0, 'center', shows).text.map((t) => t[0])
    expect(labels('', 'hud')).toEqual(['MENU']); expect(labels('', 'grid')).toEqual([])
    expect(labels('tac', 'grid')).toContain('MENU') // its menu, once up, is left the same way
  })
  const names = (menu: string, computers: { one: boolean; two: boolean }) => run(menu, 0, 'center', 'hud', computers).text.map((t) => t[0]).filter((t) => t !== 'TAC' && t !== 'SUPT' && t !== 'MENU')
  it('loses SA and all of SUPT but HSI without mission computer 1, and STORES without mission computer 2 (2.13.4.2.1)', () => {
    expect(names('tac', { one: false, two: true })).toEqual(['STORES', 'RDR ATTK', 'HUD', 'EW']); expect(names('supt', { one: false, two: true })).toEqual(['HSI'])
    expect(names('tac', { one: true, two: false })).toEqual(['RDR ATTK', 'HUD', 'SA', 'EW']); expect(names('supt', { one: true, two: false }).length).toBe(11)
    expect(run('supt', 1, 'center', 'hud', { one: false, two: true }).shown).toBe(''); expect(run('supt', 2, 'center', 'hud', { one: false, two: true }).shown).toBe('hsi') // an option that is gone opens nothing
    expect(run('tac', 5, 'center', 'hud', { one: true, two: false }).shown).toBe('')
  })
  it('shows only a flashing STANDBY with neither mission computer, and takes no press (2.13.4.2.1)', () => {
    const neither = { one: false, two: false }
    expect(run('', 0, 'center', 'hud', neither, 0).text).toEqual([['STANDBY', 256, 256]]); expect(run('', 0, 'center', 'hud', neither, 0.5).text).toEqual([])
    expect(run('tac', 0, 'center', 'hud', neither, 0).text).toEqual([['STANDBY', 256, 256]]) // whatever it was showing
    expect(run('supt', 2, 'center', 'hud', neither).shown).toBe('')
  })
  it('draws the TDC diamond in the upper right corner of the display that has the TDC', () => {
    expect(run('tac', 0, 'left').moves).toEqual([[476, 30], [488, 42], [476, 54], [464, 42]])
    expect(run('tac', 0, 'right').moves).toEqual([])
  })
  it('puts each TAC option at its pushbutton', () => {
    const d = run('tac')
    expect(d.text.filter((t) => t[0] !== 'TAC')).toEqual([['STORES', 10, 96], ['RDR ATTK', 10, 176], ['HUD', 10, 256], ['SA', 502, 256], ['EW', 336, 482], ['MENU', 256, 482]])
  })
  it('puts each SUPT option at its pushbutton', () => {
    const d = run('supt')
    expect(d.text.filter((t) => t[0] !== 'SUPT')).toEqual([['HSI', 10, 336], ['ADI', 10, 416], ['GPS', 10, 96], ['CHKLST', 502, 96], ['ENG', 502, 176], ['FCS', 502, 416], ['FUEL', 96, 482], ['FPAS', 176, 482], ['UFC BU', 416, 482], ['MUMI', 416, 30], ['BIT', 256, 30], ['MENU', 256, 482]])
  })
  // GPS (figure 2-22, pushbutton 5) has no page of its own: it is the HSI on its GPS point data display (figure 24-8).
  it('opens the HSI on its GPS point data display from GPS, whatever the DATA sublevel was showing', () => {
    const gps = (data: string) => new Function('avionics', `let ddi_dirty=false, shown="", pressed=[]; const mc=()=>({ one:true, two:true }), display_test={ on:false }, ddi_state={ left:{ page:"hud", menu:"supt" } }, DDI_PAGES={}, DDI_MENUS=${JSON.stringify(menus)};
      const hsi_state={ level:"", check:true, data:${JSON.stringify(data)} }, ddi_show=(d,p)=>{ shown=p; }, caution_page=()=>null, data_press=(pb)=>{ pressed.push(pb); hsi_state.data="gps"; return true; };
      ${lift('ddi_press')} const took=ddi_press("left",5); return { took, shown, pressed, ...hsi_state };`)(avionics)
    expect(gps('wypt')).toEqual({ took: true, shown: 'hsi', pressed: [3], level: 'data', check: false, data: 'gps' })
    expect(gps('gps')).toMatchObject({ took: true, shown: 'hsi', pressed: [], data: 'gps' }) // already there: its own pushbutton 3 is another option
  })
  it('shows only options the game builds', () => {
    for (const rows of Object.values(menus)) for (const [, , target] of rows) if (target !== 'gps') expect(built).toContain(target)
    expect(built).toContain('backup')
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
