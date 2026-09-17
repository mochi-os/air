// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The standby attitude reference indicator (NATOPS 2.12.2) carries pitch,
// roll, an OFF flag and a needle and ball - no ILS bars. The model has
// glideslope and localizer carriages on it; the pit must neither show nor
// drive them, while the HUD needles and the ADI page keep their deviation.
// engine.ts cannot be imported (WebGL at module scope), so the spec is read as
// text, as the IFEI wiring test does.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')

describe('the standby attitude indicator', () => {
  it('hides the ILS bar carriages and nothing else on the instrument', () => {
    const hide = /fa18c:\{[\s\S]*?\n\t\thide:(\/[^\n]*?\/[a-z]*),/.exec(source)?.[1] ?? ''
    expect(hide).not.toBe('')
    const re = new Function('return ' + hide)() as RegExp
    for (const bar of ['INSTRUMENT_AttitudeIndicator_Glide_509', 'INSTRUMENT_AttitudeIndicator_Glide_AN_Glide_508', 'INSTRUMENT_AttitudeIndicator_Localizer_512', 'INSTRUMENT_AttitudeIndicator_Localizer_AN_Localizer_511'])
      expect(re.test(bar), bar).toBe(true)
    for (const keep of ['INSTRUMENT_AttitudeIndicator_Bank_506', 'INSTRUMENT_AttitudeIndicator_Pitch_AN_Pitch_503', 'INSTRUMENT_AttitudeIndicator_Slip_AN_Slip_514', 'INSTRUMENT_MagneticCompass_AN_MagneticCompass_517'])
      expect(re.test(keep), keep).toBe(false)
  })

  it('drives pitch, bank and the slip ball, and no ILS channel', () => {
    const rig = /rig:\[[\s\S]*?\{ name:"flaplever"[^\n]*\n/.exec(source)?.[0] ?? ''
    expect(rig).not.toBe('')
    for (const gauge of ['pitch', 'bank', 'slip']) expect(rig).toMatch(new RegExp('gauge:"' + gauge + '"'))
    expect(rig).not.toMatch(/gauge:"(glide|loc)"/)
    expect(rig).not.toMatch(/AttitudeIndicator_(Glide|Localizer)/)
  })

  it('seats the magnetic compass card in the arch housing and keeps its heading drive', () => {
    // NATOPS 2.12.9: the standby magnetic compass is on the right windshield
    // arch. The model spins its card in the right vertical panel's bezel and
    // carries the arch housing (Object_622) empty; mount_compass re-seats the
    // card there from build_indexer, reparented so it rides the housing's frame.
    const mount = /\nfunction mount_compass\(g\)\{[\s\S]*?card\.userData\.mounted=true;[^\n]*\n/.exec(source)?.[0] ?? ''
    expect(mount).not.toBe('')
    expect(mount).toMatch(/getObjectByName\("INSTRUMENT_MagneticCompass_518"\)/)
    expect(mount).toMatch(/getObjectByName\("Object_622"\)/)
    expect(mount).toMatch(/housing\.parent\.attach\(card\)/)
    expect(source).toMatch(/build_ifei\(g\); mount_compass\(g\); \}/)
    const rig = /rig:\[[\s\S]*?\{ name:"flaplever"[^\n]*\n/.exec(source)?.[0] ?? ''
    expect(rig).toMatch(/name:"compass",\s+node:"INSTRUMENT_MagneticCompass_AN_MagneticCompass_517",\s+axis:"y", gauge:"heading"/)
  })

  it('draws the radar altimeter bug and red light at the index the aural fires on, with a BIT light', () => {
    // NATOPS 2.12.5.4: the index pointer sets the altitude the red light and the
    // voice come on at. The face once painted the bug and lit the lamp at a
    // fixed 250 ft while the aural fired at law_index (200 in the pattern, 40
    // for a cat shot).
    const draw = /\nfunction radalt_draw\(r, agl, index, silent\)\{[\s\S]*?r\.tex\.needsUpdate=true; \}\n/.exec(source)?.[0] ?? ''
    expect(draw).not.toBe('')
    expect(draw).toMatch(/dial\(RADALT_DIAL,index\)/)
    expect(draw).toMatch(/lamp=!off&&agl<index/)
    expect(draw).not.toMatch(/250/)
    expect(draw).toMatch(/the green BIT light/)
    expect(source).toMatch(/radalt_draw\(r, ownship\.pos\.y-\(surface>-1e8\?surface:0\), law_index, RADAR\.sil\);/)
    expect(source).toMatch(/radalt_draw\(g\.userData\.radalt, 1e9, law_index, RADAR\.sil\);/)
  })

  it('keeps the approach deviation for the HUD and the ADI page only', () => {
    const gauges = /function update_gauges\(out\)\{[\s\S]*?\n\township\.gauges=\{[\s\S]*?\n\t\t[^\n]*ground:[^\n]*\};/.exec(source)?.[0] ?? ''
    expect(gauges).not.toBe('')
    expect(gauges).not.toMatch(/approach_deviation\(\)/)
    expect(gauges).not.toMatch(/\bglide:|\bloc:/)
    expect(source).toMatch(/function ddi_adi\([\s\S]*?const dev=approach_deviation\(\);/)
    expect(source).toMatch(/if\(fpm\)\{ const dev=approach_deviation\(\);/)
  })
})

// The ALR-67 azimuth indicator (#28): the EW page's picture, drawn by one
// function at the DDI's geometry and at the disc's in the right vertical
// panel's housing, so the two cannot drift. The function runs against a
// recording context.
interface Emitter { bearing: number; at?: number; locked?: boolean; missile?: boolean }
function ew_calls(cx: number, cy: number, R: number, contacts: Emitter[]): { text: [string, number, number][]; arcs: [number, number, number][] } {
  const fn = /\nfunction ew_draw\(x,cx,cy,R,size\)\{[\s\S]*?\n\tx\.globalAlpha=1; \}\n/.exec(source)?.[0] ?? ''
  if (!fn) throw new Error('ew_draw not found in engine.ts')
  const run = new Function('cx', 'cy', 'R', 'contacts', `const D2R=Math.PI/180, RWR={contacts, time:10}, ownship={gauges:{heading:0}};
    const text=[], arcs=[];
    const x=new Proxy({}, { get:(t,k)=>{ if(k==='fillText') return (s,px,py)=>text.push([s,px,py]); if(k==='arc') return (ax,ay,r)=>arcs.push([ax,ay,r]); return ()=>{}; }, set:()=>true });
    ${fn} ew_draw(x,cx,cy,R,18); return { text, arcs };`)
  return run(cx, cy, R, contacts) as { text: [string, number, number][]; arcs: [number, number, number][] }
}
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6

describe('the ALR-67 azimuth indicator', () => {
  it('puts a search emitter on the right beam right of centre at the outer band, at both geometries', () => {
    for (const [cx, cy, R] of [[256, 266, 190], [80, 80, 68]]) {
      const { text } = ew_calls(cx, cy, R, [{ bearing: Math.PI / 2, at: 10 }])
      expect(text.length).toBe(1)
      expect(text[0][0]).toBe('18')
      expect(near(text[0][1], cx + 0.74 * R) && near(text[0][2], cy), `${cx},${cy},${R}`).toBe(true)
    }
  })

  it('draws a lock on the inner band with one ring and a missile innermost with two, scaled to the ring', () => {
    const lock = ew_calls(80, 80, 68, [{ bearing: 0, locked: true }])
    expect(near(lock.text[0][1], 80) && near(lock.text[0][2], 80 - 0.34 * 68)).toBe(true)
    expect(lock.arcs.slice(2)).toEqual([[80, 80 - 0.34 * 68, 13 * 68 / 190]]) // after the two band rings
    const missile = ew_calls(80, 80, 68, [{ bearing: 0, missile: true }])
    expect(missile.text[0][0]).toBe('M')
    expect(missile.arcs.slice(2).map((a) => a[2])).toEqual([13 * 68 / 190, 17 * 68 / 190])
  })

  it('is drawn through the shared function by the EW page and by the disc', () => {
    expect(source).toMatch(/function ddi_ew\(x\)\{ x\.fillText\("EW",256,36\); ew_draw\(x,256,266,190,18\); \}/)
    expect(source).toMatch(/ew_draw\(x,80,80,68,11\); w\.count=RWR\.contacts\.length; w\.tex\.needsUpdate=true;/)
  })

  it('seats the disc in the right vertical panel housing on the ownship layer, refreshed with the radar altimeter', () => {
    expect(source).toMatch(/const RWR_FACE=\{ x:6\.020, y:0\.353, z:0\.305, r:0\.024 \};/) // the housing bezel, measured by panel click
    expect(source).toMatch(/build_radalt\(g\); build_rwr\(g\);/)
    expect(source).toMatch(/new THREE\.CircleGeometry\(RWR_FACE\.r,36\)/)
    expect(source).toMatch(/surface_pose\(mesh,RWR_FACE\.x,0,RWR_FACE\.y,RWR_FACE\.z\); mesh\.layers\.set\(LAYER_OWN\);/)
    expect(source).toMatch(/if\(w\)\{ const now=performance\.now\(\); if\(now-w\.last>250\)\{ w\.last=now; rwr_draw\(w\); \} \} \}/)
  })
})

// Radar silence inhibits the radar altimeter (NATOPS 2.12.5, the EMCON
// inhibit; #29): the face shows OFF with the light out, the HUD falls from
// radar altitude to baro with the flashing B (2.12.5.4.7), and the primary
// low-altitude warning, the set's own (2.12.5.1), stays quiet.
function radalt_face(agl: number, index: number, silent: boolean): { off: boolean; lamp: boolean } {
  const draw = /\nfunction radalt_draw\(r, agl, index, silent\)\{[\s\S]*?r\.tex\.needsUpdate=true; \}\n/.exec(source)?.[0] ?? ''
  if (!draw) throw new Error('radalt_draw not found in engine.ts')
  const run = new Function('agl', 'index', 'silent', `const D2R=Math.PI/180, RADALT_DIAL=[], dial=()=>0;
    const x=new Proxy({}, { get:()=>()=>{}, set:()=>true }); const r={ canvas:{ getContext:()=>x }, tex:{} };
    ${draw} radalt_draw(r,agl,index,silent); return { off:!!r.off, lamp:!!r.lamp };`)
  return run(agl, index, silent) as { off: boolean; lamp: boolean }
}
function hud_altitude(feet: number, rdr: boolean, silent: boolean): { alt: number; radar: boolean; flashB: boolean } {
  const block = /\n\tlet alt=baro, radar=false, flashB=false;[\s\S]*?else flashB=true; \}[^\n]*\n/.exec(source)?.[0] ?? ''
  if (!block) throw new Error('HUD altitude source block not found in engine.ts')
  const run = new Function('feet', 'rdr', 'silent', `const ownship={pos:{x:0,y:feet/3.28084,z:0}}, baro=feet, ground_height=()=>0, alt_radar=rdr, RADAR={sil:silent};
    ${block} return { alt:Math.round(alt), radar, flashB };`)
  return run(feet, rdr, silent) as { alt: number; radar: boolean; flashB: boolean }
}
function law_call(silent: boolean): { calls: number; armed: boolean } {
  const block = (/\n\t\t\tlaw_active=closure&&flying;[\s\S]*?else if\(law_index<200&&agl>law_index\) law_armed=true; \} \}\n/.exec(source)?.[0] ?? '').replace(/\} \}\n$/, '}\n')
  if (!block) throw new Error('low-altitude warning block not found in engine.ts')
  const run = new Function('silent', `const closure=false, flying=true, dirty=true, agl=100, RADAR={sil:silent};
    let law_active=false, law_armed=true, law_index=200, law_calls=0, calls=0; const audio_law=()=>{ calls++; };
    ${block} return { calls, armed:law_armed };`)
  return run(silent) as { calls: number; armed: boolean }
}

describe('the radar altimeter under radar silence', () => {
  it('shows OFF with the red light out while silent, and reads again once the set is back', () => {
    expect(radalt_face(100, 200, false)).toEqual({ off: false, lamp: true })
    expect(radalt_face(100, 200, true)).toEqual({ off: true, lamp: false })
    expect(radalt_face(6000, 200, false)).toEqual({ off: true, lamp: false })
  })

  it('drops the HUD from radar altitude to baro with the flashing B while silent', () => {
    expect(hud_altitude(1000, true, false)).toEqual({ alt: 1000, radar: true, flashB: false })
    expect(hud_altitude(1000, true, true)).toEqual({ alt: 1000, radar: false, flashB: true })
    expect(hud_altitude(1000, false, true)).toEqual({ alt: 1000, radar: false, flashB: false })
  })

  it('withholds the primary low-altitude call while silent and keeps the set armed', () => {
    expect(law_call(false)).toEqual({ calls: 1, armed: false })
    expect(law_call(true)).toEqual({ calls: 0, armed: true })
  })
})

// The standby altimeter's barometric setting (NATOPS 2.12.4) and the HUD
// baro-set readout (2.13.4.8.11 item 4): the four window drums read the
// setting, and the HUD shows it below the altitude for 5 s after a change
// and flashing for 5 s on a descent through 10,000 ft below 300 knots.
interface Moment { feet: number; knots: number; t: number; set?: number }
function baroset(moments: Moment[]): (string | null)[] {
  const block = /\n\t\{ const knots=\(ownship\.cas\?\?ownship\.speed\)\*1\.944;[\s\S]*?fixed-format like the real instrument\n/.exec(source)?.[0] ?? ''
  if (!block) throw new Error('baro-set block not found in engine.ts')
  const run = new Function('moments', `let baro_set=2992, baro_last=2992, baro_shown=-1e9, baro_flash=false, baro_armed=false;
    const GR='#0f0', lx=0, wly=0, declutter=0, ownship={cas:0, speed:0};
    return moments.map((m)=>{ let drawn=null; const hctx={ fillText:(s)=>{ drawn=s; }, font:'', textAlign:'', fillStyle:'' };
      const baro=m.feet, sim_time=m.t; ownship.cas=m.knots/1.944; if(m.set!==undefined) baro_set=m.set;
      ${block} return drawn; });`)
  return run(moments) as (string | null)[]
}

describe('the standby altimeter baro setting', () => {
  it('drives the four window drums from the setting, tens first, and publishes it as a gauge', () => {
    const rig = /rig:\[[\s\S]*?\{ name:"flaplever"[^\n]*\n/.exec(source)?.[0] ?? ''
    for (const [name, node, gain] of [['baro1', 'Drum_Baro_1_AN_1_397', '10000'], ['baro2', 'Drum_Baro_2_AN_2_400', '1000'], ['baro3', 'Drum_Baro_3_AN_3_403', '100'], ['baro4', 'Drum_Baro_4_AN_4_406', '10']])
      expect(rig, name).toMatch(new RegExp('name:"' + name + '",\\s+node:"' + node + '",\\s+axis:"x", sign:-1, gain:6\\.2832/' + gain + ',\\s+gauge:"baro"'))
    expect(source).toMatch(/\n\t\tbaro:baro_set,/)
    expect(source).toMatch(/\nconst baro_set=2992;/) // no knob and no sea-level pressure reach it yet; the change display waits for one
  })

  it('flashes the setting for 5 s on a descent through 10,000 ft below 300 knots, armed from above', () => {
    const on = 100.1, off = 100.6 // (t*3)%2: 0.3 lit, 1.8 dark
    expect(baroset([{ feet: 5000, knots: 250, t: 0.1 }])).toEqual([null]) // a spawn below the level never arms
    expect(baroset([{ feet: 12000, knots: 250, t: 50 }, { feet: 9900, knots: 250, t: on }, { feet: 9800, knots: 250, t: off }, { feet: 9700, knots: 250, t: 104.9 }, { feet: 9600, knots: 250, t: 105.5 }]))
      .toEqual([null, '29.92', null, '29.92', null])
    expect(baroset([{ feet: 12000, knots: 320, t: 50 }, { feet: 9900, knots: 320, t: on }])).toEqual([null, null]) // fast through the level: no reminder
    expect(baroset([{ feet: 12000, knots: 250, t: 50 }, { feet: 9900, knots: 250, t: on }, { feet: 12000, knots: 250, t: 120 }, { feet: 9900, knots: 250, t: 200.1 }]))
      .toEqual([null, '29.92', null, '29.92']) // re-armed by the climb back above
  })

  it('shows a changed setting steadily for 5 s', () => {
    expect(baroset([{ feet: 5000, knots: 250, t: 0.1 }, { feet: 5000, knots: 250, t: 200, set: 3010 }, { feet: 5000, knots: 250, t: 200.6 }, { feet: 5000, knots: 250, t: 205.1 }]))
      .toEqual([null, '30.10', '30.10', null])
  })
})
