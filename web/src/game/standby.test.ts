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

  it('leaves the magnetic compass card in the model\'s housing and keeps its heading drive', () => {
    // NATOPS 2.12.9 and foldout FO-5 item 19: the standby magnetic compass sits
    // on the right windshield arch's foot beside the right DDI, which is where
    // the model spins its card. Nothing re-seats it.
    expect(source).not.toMatch(/function mount_compass\(/)
    expect(source).toMatch(/build_ifei\(g\); build_ufc\(g\); \}/)
    const rig = /rig:\[[\s\S]*?\{ name:"flaplever"[^\n]*\n/.exec(source)?.[0] ?? ''
    expect(rig).toMatch(/name:"compass",\s+node:"INSTRUMENT_MagneticCompass_AN_MagneticCompass_517",\s+axis:"y", gauge:"heading"/)
  })

  it('draws the radar altimeter bug and red light at the index the aural fires on, with a BIT light', () => {
    // NATOPS 2.12.5.4: the index pointer sets the altitude the red light and the
    // voice come on at. The face once painted the bug and lit the lamp at a
    // fixed 250 ft while the aural fired at law_index (200 in the pattern, 40
    // for a cat shot).
    const draw = /\nfunction radalt_draw\(r, agl, index, silent, test\)\{[\s\S]*?r\.tex\.needsUpdate=true; \}\n/.exec(source)?.[0] ?? ''
    expect(draw).not.toBe('')
    expect(draw).toMatch(/dial\(RADALT_DIAL,index\)/)
    expect(draw).toMatch(/lamp=!off&&agl<index/)
    expect(draw).not.toMatch(/250/)
    expect(draw).toMatch(/the green BIT light/)
    expect(source).toMatch(/radalt_draw\(r, \(ownship\.pos\.y-\(surface>-1e8\?Math\.max\(surface,0\):0\)\)\*3\.28084, law_index, radalt_inhibited\(\), radalt_on&&sim_time-radalt_test<5\);/) // feet, like the dial, the index and the aural
    expect(source).toMatch(/radalt_draw\(g\.userData\.radalt, 1e9, law_index, radalt_inhibited\(\), false\);/)
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

  it('seats the disc at the standby cluster\'s upper right (FO-5 item 26) on the ownship layer, refreshed with the radar altimeter', () => {
    expect(source).toMatch(/const RWR_FACE=\{ x:6\.207, y:0\.177, z:0\.277, r:0\.042 \};/) // the tub's disc beside the attitude indicator
    expect(source).toMatch(/build_radalt\(g\); build_rwr\(g\);/)
    expect(source).toMatch(/new THREE\.CircleGeometry\(RWR_FACE\.r,36\)/)
    expect(source).toMatch(/surface_pose\(mesh,RWR_FACE\.x,0,RWR_FACE\.y,RWR_FACE\.z\); mesh\.layers\.set\(LAYER_OWN\);/)
    expect(source).toMatch(/if\(w\)\{ const now=performance\.now\(\); if\(now-w\.last>250\)\{ w\.last=now; rwr_draw\(w\); \} \}\n/)
  })
})

// Radar silence inhibits the radar altimeter (NATOPS 2.12.5, the EMCON
// inhibit; #29): the face shows OFF with the light out, the HUD falls from
// radar altitude to baro with the flashing B (2.12.5.4.7), and the primary
// low-altitude warning, the set's own (2.12.5.1), stays quiet.
function radalt_face(agl: number, index: number, silent: boolean): { off: boolean; lamp: boolean } {
  const draw = /\nfunction radalt_draw\(r, agl, index, silent, test\)\{[\s\S]*?r\.tex\.needsUpdate=true; \}\n/.exec(source)?.[0] ?? ''
  if (!draw) throw new Error('radalt_draw not found in engine.ts')
  const run = new Function('agl', 'index', 'silent', `const D2R=Math.PI/180, RADALT_DIAL=[], dial=()=>0;
    const x=new Proxy({}, { get:()=>()=>{}, set:()=>true }); const r={ canvas:{ getContext:()=>x }, tex:{} };
    ${draw} radalt_draw(r,agl,index,silent,false); return { off:!!r.off, lamp:!!r.lamp };`)
  return run(agl, index, silent) as { off: boolean; lamp: boolean }
}
function hud_altitude(feet: number, rdr: boolean, silent: boolean): { alt: number; radar: boolean; flashB: boolean } {
  const reading = /\nfunction altitude_reading\(\)\{[\s\S]*?\n(?=\S)/.exec(source)?.[0] ?? ''
  if (!reading) throw new Error('altitude_reading not found in engine.ts')
  const run = new Function('feet', 'rdr', 'silent', `const ownship={pos:{x:0,y:feet/3.28084,z:0}}, baro_error=()=>0, ground_height=()=>0, alt_radar=rdr, RADAR={sil:silent}, radalt_inhibited=()=>RADAR.sil;
    ${reading} const r=altitude_reading(); return { alt:Math.round(r.feet), radar:r.radar, flashB:r.fallback };`)
  return run(feet, rdr, silent) as { alt: number; radar: boolean; flashB: boolean }
}
// The primary radar low-altitude warning (NATOPS 2.12.5.1), lifted from the
// low-altitude block and stepped frame by frame: each frame gives the gear
// (1 up), the radar altitude, the index, radar silence and whether the UFC
// disabled the warning before it, and returns whether the whoop sounded.
// The GPWS lines that open the same block run too: escape is the GPWS recovery
// model's verdict, bank + is right wing down, knots the calibrated airspeed and
// wheels the seconds since weight off wheels.
interface Frame { gear?: number; agl: number; index?: number; silent?: boolean; disable?: boolean; escape?: boolean; bank?: number; knots?: number; wheels?: number }
interface Heard { whoop: boolean; gpws: boolean; call: string }
const lowblock = /\n\t\t\tlaw_active=closure&&flying[^\n]*\n[\s\S]*?law_calls\+\+; \}[^\n]*\n/.exec(source)?.[0] ?? ''
function warned(frames: Frame[]): Heard[] {
  if (!lowblock) throw new Error('low-altitude warnings not found in engine.ts')
  const run = new Function('frames', `const D2R=Math.PI/180, flying=true, sim_time=100, RADAR={ sil:false }, radalt_inhibited=()=>RADAR.sil, ownship={ gear:1, cas:0, right:{ y:0 }, up:{ y:1 } }, gpws={ wheels:-Infinity, call:"" };
    let closure=false, law_active=false, law_primary=false, law_disabled=false, law_index=200, law_calls=0, sounded=false; const audio_law=()=>{ sounded=true; };
    return frames.map((f)=>{ ownship.gear=f.gear??1; RADAR.sil=!!f.silent; law_index=f.index??200; const agl=f.agl; sounded=false; closure=!!f.escape;
      const r=(f.bank??0)*D2R; ownship.right.y=-Math.sin(r); ownship.up.y=Math.cos(r); ownship.cas=(f.knots??300)/1.94384; gpws.wheels=f.wheels===undefined?-Infinity:sim_time-f.wheels;
      if(f.disable) law_disabled=law_disabled||law_primary;
      ${lowblock} return { whoop:sounded, gpws:law_active, call:gpws.call }; });`)
  return run(frames) as Heard[]
}
function primary(frames: Frame[]): boolean[] {
  return warned(frames).map((h) => h.whoop)
}

describe('the radar altimeter under EMCON', () => {
  it('shows OFF with the red light out while silent, and reads again once the set is back', () => {
    expect(radalt_face(100, 200, false)).toEqual({ off: false, lamp: true })
    expect(radalt_face(100, 200, true)).toEqual({ off: true, lamp: false })
    expect(radalt_face(6000, 200, false)).toEqual({ off: true, lamp: false })
  })

  it('drops the HUD from radar altitude to baro with the flashing B while silent', () => {
    expect(hud_altitude(1000, true, false)).toEqual({ alt: 1000, radar: true, flashB: false })
    expect(hud_altitude(1000, true, true)).toEqual({ alt: 1000, radar: false, flashB: true })
    expect(hud_altitude(1000, false, true)).toEqual({ alt: 1000, radar: false, flashB: false })
    expect(hud_altitude(6000, true, false)).toEqual({ alt: 6000, radar: false, flashB: true }) // above the set's 5,000 ft
    expect(source).toMatch(/\n\tconst reading=altitude_reading\(\), alt=reading\.feet, radar=reading\.radar, flashB=reading\.fallback;/) // the HUD reads it, as the EADI does
  })

  it('withholds the primary low-altitude warning while silent', () => {
    expect(primary([{ agl: 100 }])).toEqual([true])
    expect(primary([{ agl: 100, silent: true }])).toEqual([false])
  })
})

describe('the primary radar low-altitude warning (NATOPS 2.12.5.1)', () => {
  it('sounds with the gear up and locked below the index, and keeps sounding', () => {
    expect(primary([{ agl: 150 }, { agl: 150 }, { agl: 120 }])).toEqual([true, true, true])
    expect(primary([{ agl: 250 }])).toEqual([false])
  })

  it('is silent with the gear down or travelling, at any height below the index', () => {
    expect(primary([{ gear: 0, agl: 150 }, { gear: 0, agl: 20 }])).toEqual([false, false])
    expect(primary([{ gear: 0.5, agl: 150 }])).toEqual([false])
  })

  it('stays quiet once disabled until it is reset by a climb above the index', () => {
    expect(primary([{ agl: 150 }, { agl: 150, disable: true }, { agl: 120 }, { agl: 250 }, { agl: 150 }])).toEqual([true, false, false, false, true])
  })

  it('resets when the index is turned below the present altitude', () => {
    expect(primary([{ agl: 150 }, { agl: 150, disable: true }, { agl: 150, index: 100 }, { agl: 150, index: 200 }])).toEqual([true, false, false, true])
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
    expect(source).toMatch(/\nlet baro_set=2992;/) // set with its knob; the change display shows it
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

// The standby flight instrument faces (#32): the model hides its mechanical
// airspeed, altimeter, VSI and attitude parts behind opaque discs on the
// cockpit tub, so canvas faces drawn from the gauges sit proud of the discs.
// Each draw runs against a recording context.
function lift(name: string): string {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`${name} not found in engine.ts`)
  const rest = source.slice(start)
  const end = /\n(?=\S)/.exec(rest.slice(1))
  return end ? rest.slice(0, end.index + 1) : rest
}
interface Drawn { text: string[]; rotate: number[]; translate: [number, number][]; rects: [number, number, number, number][]; arcs: [number, number, number][]; strokes: number }
function face(name: string, ...args: number[]): Drawn {
  const consts = /\nconst ASI_DIAL=[^\n]*\nconst VSI_DIAL=[^\n]*\n/.exec(source)?.[0] ?? ''
  const sizes = /\nconst STANDBY_C=[^\n]*\nconst ADI_PIXELS=[^\n]*\n/.exec(source)?.[0] ?? ''
  if (!consts || !sizes) throw new Error('standby constants not found in engine.ts')
  const run = new Function('args', `const D2R=Math.PI/180, THREE={MathUtils:{clamp:(v,lo,hi)=>Math.min(hi,Math.max(lo,v))}}; ${consts} ${sizes}
    ${lift('dial')} ${lift('face_start')} ${lift('face_needle')} ${lift('face_tick')} ${lift('face_label')} ${lift(name)}
    const text=[], rotate=[], translate=[], rects=[], arcs=[]; let strokes=0;
    const x=new Proxy({}, { get:(t,k)=>{ if(k==='stroke') return ()=>{ strokes++; }; if(k==='fillText') return (s)=>text.push(String(s)); if(k==='rotate') return (a)=>rotate.push(a); if(k==='translate') return (dx,dy)=>translate.push([dx,dy]); if(k==='fillRect') return (a,b,c,d)=>rects.push([a,b,c,d]); if(k==='arc') return (a,b,r)=>arcs.push([a,b,r]); return ()=>{}; }, set:()=>true });
    ${name}({ canvas:{ getContext:()=>x } }, ...args); return { text, rotate, translate, rects, arcs, strokes };`)
  return run(args) as Drawn
}
const has = (list: number[], v: number) => list.some((a) => Math.abs(a - v) < 1e-6)
// The bank gauge every attitude display reads, lifted from the gauges block and
// evaluated for a jet facing +x rolled right: the right wing (+z) dips.
function bank_right(degrees: number): number {
  const expression = /\n\township\.gauges=\{[\s\S]*?\n\t\tbank:(.*?),(?:\s*\/\/[^\n]*)?\n/.exec(source)?.[1] ?? ''
  if (!expression) throw new Error('the bank gauge not found in engine.ts')
  const r = degrees * Math.PI / 180
  const ownship = { right: { x: 0, y: -Math.sin(r), z: Math.cos(r) }, up: { x: 0, y: Math.cos(r), z: Math.sin(r) } }
  return new Function('ownship', `return ${expression}`)(ownship) as number
}

describe('the standby instrument faces', () => {
  it('turn the airspeed needle to the dial angle the rig uses, over that dial\'s labels', () => {
    const angle = 242 * Math.PI / 180 // ASI_DIAL: 300 knots
    const d = face('asi_face', angle)
    expect(has(d.rotate, angle)).toBe(true)
    // FO-5 item 27: hundreds of knots, .6 to 8, and KNOTS X 100 about the hub
    for (const label of ['.6', '1', '1.5', '2', '3', '8', 'KNOTS', 'X 100']) expect(d.text).toContain(label)
    for (const label of ['100', '300', '800']) expect(d.text).not.toContain(label)
  })

  it('turn the altimeter pointer once per 1,000 ft and show the thousands and the baro setting', () => {
    const d = face('alt_face', 1500, 2992)
    expect(has(d.rotate, Math.PI)).toBe(true)
    expect(d.text).toContain('01')
    expect(d.text).toContain('2992') // the drums read hundredths of inHg with no point (FO-5 item 28)
    expect(d.text).not.toContain('29.92')
  })

  // NATOPS 2.12.4 and FO-5 item 28: 20 graduations, 50 ft each, labelled 0 to 9,
  // and the setting window centred below the hub under ALT and IN HG.
  it('graduate the altimeter in 50 ft steps and centre the window under ALT and IN HG', () => {
    const d = face('alt_face', 0, 3001)
    expect(d.strokes).toBe(20)
    for (const n of ['0', '1', '5', '9']) expect(d.text).toContain(n)
    expect(d.text).toEqual(expect.arrayContaining(['ALT', 'IN HG', '3001']))
    expect(d.rects).toContainEqual([128 - 32, 128 + 48, 64, 22]) // the window, centred on the hub's vertical
  })

  it('put the rate of climb needle at nine o\'clock plus the dial angle', () => {
    const angle = 60 * Math.PI / 180 // VSI_DIAL: 1,000 ft/min
    const d = face('vsi_face', angle)
    expect(has(d.rotate, -Math.PI / 2 + angle)).toBe(true)
    for (const label of ['0', '1', '6']) expect(d.text).toContain(label)
  })

  // FO-5 item 29, measured at 600 dpi from the dial's fitted centre, the climb and
  // dive sides averaged: 2,000 ft/min at twelve o'clock, 6,000 short of three.
  it('put the climb scale where FO-5 draws it', () => {
    const consts = /\nconst ASI_DIAL=[^\n]*\nconst VSI_DIAL=[^\n]*\n/.exec(source)?.[0] ?? ''
    const degrees = (fpm: number) => new Function('fpm', `const D2R=Math.PI/180; ${consts} ${lift('dial')} return dial(VSI_DIAL,fpm)/D2R;`)(fpm) as number
    expect(degrees(500)).toBeCloseTo(35.5, 1)
    expect(degrees(1000)).toBeCloseTo(60, 1)
    expect(degrees(2000)).toBeCloseTo(94, 1)
    expect(degrees(-4000)).toBeCloseTo(-140.5, 1)
    expect(degrees(6000)).toBeCloseTo(171, 1)
  })

  it('tick the climb scale every 100 ft/min to 1,000 and every 500 beyond, lettered as FO-5 is', () => {
    const d = face('vsi_face', 0)
    expect(d.strokes).toBe(41) // 20 each side and the zero
    expect(d.text).toEqual(expect.arrayContaining(['UP', 'DOWN', '1000 FT PER MN']))
    expect(d.text.filter((s) => s === '6')).toHaveLength(1) // one 6, at three o'clock between the climb and dive ticks
  })

  it('roll the ball against the bank and slide it with the pitch, as the ADI page does', () => {
    const bank = 30 * Math.PI / 180, pitch = 10 * Math.PI / 180
    const d = face('adi_face', pitch, bank)
    expect(d.rotate[0]).toBeCloseTo(-bank, 9) // the ball's roll comes first; the bank pointer's rotate follows
    const px = 118 * 0.22 // 10° of pitch
    expect(d.translate.some(([dx, dy]) => dx === 0 && Math.abs(dy - px) < 1e-6)).toBe(true)
  })

  it('roll the ball anticlockwise in a right bank, the sky pointer with it', () => {
    const d = face('adi_face', 0, bank_right(30))
    expect(d.rotate[0]).toBeCloseTo(-30 * Math.PI / 180, 9) // the canvas y axis runs down, so a negative turn is anticlockwise
    expect(d.rotate[1]).toBeCloseTo(-30 * Math.PI / 180, 9)
  })

  // NATOPS 2.12.2: pitch display is limited by mechanical stops at about 90° climb
  // and 80° dive; a needle and ball are at the bottom, one needle width a turn of
  // 90° a minute. C=128 and R=118, so the mask ring under the window (0.8 R) holds
  // them: the needle 4 px wide below the window, the ball's tube at C+R-7.
  it('stop the ball\'s pitch at about 90° climb and 80° dive', () => {
    const pitched = (degrees: number) => face('adi_face', degrees * Math.PI / 180, 0).translate.find(([dx]) => dx === 0 && true)?.[1]
    const px = 118 * 0.22 / 10
    expect(pitched(-89)).toBeCloseTo(-80 * px, 6)
    expect(pitched(-60)).toBeCloseTo(-60 * px, 6)
    expect(pitched(89)).toBeCloseTo(89 * px, 6)
  })

  it('deflect the turn needle one needle width for 90° a minute, to the side of the turn', () => {
    const needle = (rate: number) => face('adi_face', 0, 0, rate * Math.PI / 180, 0).rects.find(([, y, w, h]) => w === 4 && h === 8 && y > 128)?.[0]
    expect(needle(0)).toBe(128 - 2)
    expect(needle(1.5)).toBeCloseTo(128 + 4 - 2, 6)    // one needle width right for a turn right at 90° a minute
    expect(needle(-3)).toBeCloseTo(128 - 8 - 2, 6)
    expect(needle(30)).toBeCloseTo(128 + 24 - 2, 6)    // pegged
  })

  it('slide the ball along its tube with the slip, to the velocity vector\'s side', () => {
    const ball = (slip: number) => face('adi_face', 0, 0, 0, slip).arcs.find(([, y, r]) => r === 5 && y === 128 + 118 - 7)?.[0]
    expect(ball(0)).toBe(128)
    expect(ball(0.5)).toBe(128 + 12)
    expect(ball(-2)).toBe(128 - 24)
    expect(source).toMatch(/adi_face\(faces\.adi,gz\.pitch\|\|0,gz\.bank\|\|0,gz\.yaw\|\|0,gz\.slip\|\|0\);/)
  })

  it('letter the ball CLIMB on its white half and DIVE on its black half, as FO-5 item 25 draws it', () => {
    const d = face('adi_face', 0, 0)
    expect(d.text).toContain('CLIMB')
    expect(d.text).toContain('DIVE')
    const draw = lift('adi_face')
    expect(draw).toMatch(/white="#dcdcd4", black="#141514"/)
    expect(draw).not.toMatch(/#3a6ea8|#7a5230/) // no blue sky or brown earth
  })

  it('are seated proud of the tub\'s discs at the measured bezels and refreshed from the gauges', () => {
    expect(source).toMatch(/const STANDBY=\{ x:6\.207, asi:\{ y:0\.082, z:0\.132, r:0\.031 \}, alt:\{ y:0\.083, z:0\.218, r:0\.031 \}, vsi:\{ y:0\.083, z:0\.304, r:0\.031 \}, adi:\{ y:0\.177, z:0\.158, r:0\.043 \} \};/) // the tub's painted discs, fitted as circles
    expect(source).not.toMatch(/function clock_face\(/) // the clock is the model's rigged dial on the pedestal (FO-5 item 37)
    expect(source).toMatch(/for\(const name of \["asi","alt","vsi","adi"\]\)\{ const seat=STANDBY\[name\];/)
    expect(source).toMatch(/new THREE\.CircleGeometry\(seat\.r,48\), gauge_material\(tex\)\)/) // lit like the model's own gauges
    expect(source).toMatch(/build_radalt\(g\); build_rwr\(g\); build_standby\(g\);/)
    expect(source).toMatch(/surface_pose\(mesh,STANDBY\.x,0,seat\.y,seat\.z\); mesh\.layers\.set\(LAYER_OWN\);/)
    expect(source).toMatch(/if\(now-\(sb\.last\|\|0\)>100\)\{ sb\.last=now; standby_draw\(sb,ownship\.gauges\|\|\{\}\); \}/)
  })
})

// The secondary radar and barometric low-altitude warnings (NATOPS 2.12.5.2,
// 2.12.5.3): one ALTITUDE, ALTITUDE as the jet descends through the altitude
// set for each, 0 disabling it. The loop is lifted from the low-altitude block
// and stepped frame by frame; each frame returns whether the call was made.
interface Pass { radar?: number; baro: number; silent?: boolean; flying?: boolean }
function called(frames: Pass[], set: { radar: number; baro: number }): boolean[] {
  const block = /\n\t\t\t\{ const readings=[\s\S]*?altitude_called=sim_time; \} \} \}/.exec(source)?.[0] ?? ''
  if (!block) throw new Error('secondary low-altitude warnings not found in engine.ts')
  const run = new Function('frames', 'set', `const RADAR={ sil:false }, radalt_inhibited=()=>RADAR.sil, ownship={ pos:{ y:0 } }, altitude_set=set, altitude_armed={ radar:false, baro:false }, baro_error=()=>0;
    let altitude_called=-Infinity, sim_time=0, flying=true, agl=0;
    return frames.map((f)=>{ sim_time++; RADAR.sil=!!f.silent; flying=f.flying??true; agl=f.radar??9999; ownship.pos.y=f.baro/3.28084;
      ${block} return altitude_called===sim_time; });`)
  return run(frames, set) as boolean[]
}

describe('the secondary and barometric low-altitude warnings', () => {
  const power = { radar: 0, baro: 5000 } // power-up with weight on wheels (2.12.5.2, 2.12.5.3)

  it('call once descending through the barometric altitude, and again only after climbing back above it', () => {
    expect(called([{ baro: 5500 }, { baro: 5100 }, { baro: 4990 }, { baro: 4800 }, { baro: 4600 }], power)).toEqual([false, false, true, false, false])
    expect(called([{ baro: 5500 }, { baro: 4990 }, { baro: 5200 }, { baro: 4900 }], power)).toEqual([false, true, false, true])
  })

  it('stay quiet for a jet levelled at the setting', () => {
    expect(called([{ baro: 5000 }, { baro: 4999 }, { baro: 5020 }, { baro: 4998 }], power)).toEqual([false, false, false, false])
  })

  it('leave the radar warning off at its power-up 0, and call it once set', () => {
    expect(called([{ radar: 700, baro: 9000 }, { radar: 450, baro: 9000 }], power)).toEqual([false, false])
    expect(called([{ radar: 700, baro: 9000 }, { radar: 450, baro: 9000 }], { radar: 500, baro: 0 })).toEqual([false, true])
  })

  it('make no radar call while radar silence inhibits the set, and none on the ground', () => {
    expect(called([{ radar: 700, baro: 9000, silent: true }, { radar: 450, baro: 9000, silent: true }], { radar: 500, baro: 0 })).toEqual([false, false])
    expect(called([{ baro: 5500, flying: false }, { baro: 4900, flying: false }], power)).toEqual([false, false])
  })

  it('power up each spawn as the ground power-up leaves them, and speak through the voice queue', () => {
    expect(source).toMatch(/altitude_set\.radar=0; altitude_set\.baro=5000; altitude_armed\.radar=altitude_armed\.baro=false; altitude_called=-Infinity;/)
    expect(source).toMatch(/if\(sim_time-altitude_called<1\) active\.add\("ALTITUDE"\);/)
  })
})

// The height indicator's knob (NATOPS 2.12.5.4.1): clockwise raises the index,
// in notches that follow the dial's expanded scale, from 0 to 5,000 ft.
describe('the low-altitude index knob', () => {
  const fn = /\nfunction index_step\(index,direction\)\{[^\n]*\n[^\n]*\n/.exec(source)?.[0] ?? ''
  const step = (index: number, direction: number) => new Function('index', 'direction', `const THREE={MathUtils:{clamp:(v,lo,hi)=>Math.min(hi,Math.max(lo,v))}}; ${fn} return index_step(index, direction);`)(index, direction) as number

  it('turns in notches that follow the dial', () => {
    expect(fn).not.toBe('')
    expect([step(40, 1), step(200, 1), step(200, -1), step(100, -1), step(600, 1), step(1000, -1), step(1000, 1)]).toEqual([50, 250, 150, 90, 700, 900, 1500])
  })

  it('stops at 0 and 5,000 ft', () => {
    expect(step(0, -1)).toBe(0)
    expect(step(5000, 1)).toBe(5000)
  })

  it('is the only thing that moves the index, from the face, the keys and nothing else', () => {
    expect(source).toMatch(/case "index": if\(!radalt_on\)\{ if\(\(d\|\|1\)>0\)\{ radalt_on=true; radalt_greet=!!ownship\.grounded; \} \} else if\(\(d\|\|1\)<0&&law_index<=0\) radalt_on=false; else law_index=index_step\(law_index,d\|\|1\); break;/)
    expect(source).toMatch(/if\(u&&_click_ray\.intersectObject\(u\.mesh,false\)\[0\]\)\{ if\(!playback\) pit_press\("index",e\.button===2\?1:-1\); return; \}/)
    expect(source).toMatch(/if\(ch===key_of\("index\.up"\)\) pit_press\("index",1\);/)
    expect(source).toMatch(/if\(ch===key_of\("index\.down"\)\) pit_press\("index",-1\);/)
    expect((source.match(/law_index=/g) ?? []).length).toBe(3) // its declaration, the knob, and the spawn's pre-flight setting
  })
})

// The GPWS (NATOPS 2.17.5): its recovery model works in any gear position, stays
// out of the first 6 seconds after weight off wheels, and speaks the recovery the
// jet needs first (2.17.5.4) rather than sounding the radar altimeter's whoop.
describe('the GPWS warning', () => {
  it('calls ROLL LEFT or RIGHT past 45 degrees of bank, the shorter way to wings level', () => {
    const call = (bank: number) => warned([{ agl: 800, escape: true, bank }])[0].call
    expect([call(60), call(-60), call(170), call(-170)]).toEqual(['ROLL LEFT', 'ROLL RIGHT', 'ROLL LEFT', 'ROLL RIGHT'])
    expect(call(45)).toBe('PULL UP')
  })

  it('calls POWER below 210 knots and PULL UP at or above it', () => {
    expect(warned([{ agl: 800, escape: true, knots: 180 }])[0].call).toBe('POWER')
    expect(warned([{ agl: 800, escape: true, knots: 210 }])[0].call).toBe('PULL UP')
  })

  it('speaks instead of whooping, and warns with the gear down too', () => {
    expect(warned([{ agl: 800, escape: true }])[0]).toEqual({ whoop: false, gpws: true, call: 'PULL UP' })
    expect(warned([{ agl: 800, escape: true, gear: 0 }])[0].gpws).toBe(true)
    expect(warned([{ agl: 800 }])[0]).toEqual({ whoop: false, gpws: false, call: '' })
  })

  it('gives no protection in the first 6 seconds after weight off wheels', () => {
    expect(warned([{ agl: 800, escape: true, wheels: 3 }])[0]).toMatchObject({ gpws: false, call: '' })
    expect(warned([{ agl: 800, escape: true, wheels: 7 }])[0].gpws).toBe(true)
  })

  it('runs its recovery model whatever the gear', () => {
    const model = /const closure=\(\(\)=>\{[\s\S]*?\}\)\(\);/.exec(source)?.[0] ?? ''
    expect(model).not.toBe('')
    const escape = (gearTarget: number) => new Function('gearTarget', `const THREE={MathUtils:{clamp:(v,lo,hi)=>Math.min(hi,Math.max(lo,v))}};
      const ownship={ gearTarget, speed:200, up:{ y:1 } }, sink=40, agl=250; ${model} return closure;`)(gearTarget) as boolean
    expect(escape(0)).toBe(true) // gear down, diving at 250 ft
    expect(escape(1)).toBe(true)
  })
})

// The recovery arrow (NATOPS 2.17.5.3, figure 2-41): a steady arrow at the HUD
// centre, perpendicular to the horizon and pointing the way to pull, so it turns
// with the bank. The draw runs against a canvas stand-in that tracks the transform.
describe('the GPWS recovery arrow', () => {
  const fn = /\nfunction gpws_arrow\(x,cx,cy,dpp,bank\)\{[\s\S]*?\n\tx\.restore\(\); \}\n/.exec(source)?.[0] ?? ''
  const tip = (bank: number) => new Function('bank', `let a=1,b=0,c=0,d=1,e=0,f=0; const tips=[];
    const x={ save(){}, restore(){}, setLineDash(){}, beginPath(){}, lineTo(){}, closePath(){}, stroke(){}, set lineWidth(v){},
      translate(dx,dy){ e+=a*dx+c*dy; f+=b*dx+d*dy; }, rotate(t){ const k=Math.cos(t), s=Math.sin(t); [a,b,c,d]=[a*k+c*s, b*k+d*s, c*k-a*s, d*k-b*s]; },
      moveTo(px,py){ tips.push([a*px+c*py+e, b*px+d*py+f]); } };
    ${fn} gpws_arrow(x, 400, 300, 10, bank); return tips[0];`)(bank) as number[]

  it('points up the ladder when level and to the sky side in a bank', () => {
    expect(fn).not.toBe('')
    const [x0, y0] = tip(0)
    expect(x0).toBeCloseTo(400, 6)
    expect(y0).toBeCloseTo(300 - 45, 6)
    const [x1, y1] = tip(Math.PI / 2) // right wing down 90 degrees: the sky is to the left
    expect(x1).toBeCloseTo(400 - 45, 6)
    expect(y1).toBeCloseTo(300, 6)
  })

  it('is drawn at the HUD optical centre while the warning holds', () => {
    expect(source).toMatch(/if\(law_active\)\{ hctx\.strokeStyle=GR; gpws_arrow\(hctx,centre\[0\],centre\[1\],HH\/45\*hs,-Math\.atan2\(ownship\.right\.y,ownship\.up\.y\)\); \}/)
  })
})

// The altimeter's knob (NATOPS 2.12.4): a click on the face turns it, right raising
// the setting by 0.01 inHg and left lowering it, over the window's 28.10 to 31.00;
// the air data use the setting too, so the barometric altitude on the standby, the
// HUD and the barometric warning reads 10 ft high for every 0.01 inHg set too high.
describe('the standby altimeter knob', () => {
  it('reads the barometric altitude off the setting, 1,000 ft to the inch', () => {
    const line = /\nfunction baro_error\(\)[^\n]*\n/.exec(source)?.[0] ?? ''
    expect(line).not.toBe('')
    const error = (set: number) => new Function('baro_set', `${line} return baro_error();`)(set) as number
    expect(error(2992)).toBe(0)
    expect(error(3002)).toBe(100)
    expect(error(2982)).toBe(-100)
  })

  it('feeds the setting to every barometric altitude reader', () => {
    expect(source).toMatch(/altitude=Math\.max\(0,\(out\[STATE\.position\+1\]\|\|0\)\*3\.281\+baro_error\(\)\);/) // the standby altimeter and the ADI page
    expect(source).toMatch(/const baro=ownship\.pos\.y\*3\.28084\+baro_error\(\); const lx=/) // the HUD's altitude box
    expect(source).toMatch(/baro:ownship\.pos\.y\*3\.28084\+baro_error\(\) \};/) // the barometric low-altitude warning
  })

  it('turns 0.01 inHg a click between 28.10 and 31.00', () => {
    const line = /\n\tcase "baro":[^\n]*\n/.exec(source)?.[0] ?? ''
    expect(line).not.toBe('')
    const turn = (set: number, d: number) => new Function('set', 'd', `let baro_set=set; const THREE={MathUtils:{clamp:(v,lo,hi)=>Math.min(hi,Math.max(lo,v))}};
      switch("baro"){ ${line} } return baro_set;`)(set, d) as number
    expect(turn(2992, 1)).toBe(2993)
    expect(turn(2992, -1)).toBe(2991)
    expect(turn(3100, 1)).toBe(3100)
    expect(turn(2810, -1)).toBe(2810)
  })

  it('is turned by a click on the face and set back to 29.92 on a fresh jet', () => {
    expect(source).toMatch(/const u=ownship\.group\.userData\.standby;[^\n]*\n\t\tif\(u&&u\.alt&&_click_ray\.intersectObject\(u\.alt\.mesh,false\)\[0\]\)\{ if\(!playback\) pit_press\("baro",e\.button===2\?1:-1\); return; \} \}/)
    expect(source).toMatch(/baro_armed=false; baro_shown=-1e9; baro_flash=false; baro_set=2992; baro_last=2992;/)
  })

  it('is turned by its two keys, unbound until the player binds them, each with a settings label', () => {
    const lines = /\n\t\tif\(ch===key_of\("baro\.up"\)\)[^\n]*\n\t\tif\(ch===key_of\("baro\.down"\)\)[^\n]*\n/.exec(source)?.[0] ?? ''
    expect(lines).not.toBe('')
    const press = (ch: string) => new Function('ch', `const turned=[], key_of=(a)=>({ "baro.up":"KeyU", "baro.down":"KeyD" })[a], pit_press=(a,d)=>turned.push(a+" "+d); ${lines} return turned;`)(ch) as string[]
    expect([press('KeyU'), press('KeyD'), press('KeyX')]).toEqual([['baro 1'], ['baro -1'], []])
    const keys = readFileSync(fileURLToPath(new URL('./keys.ts', import.meta.url)), 'utf8')
    expect(keys).toMatch(/'baro\.down': 'None',[^\n]*\n  'baro\.up': 'None',/)
    const settings = readFileSync(fileURLToPath(new URL('../components/SettingsDialog.tsx', import.meta.url)), 'utf8')
    expect(settings).toMatch(/id: 'baro\.down', label: msg`Lower altimeter setting`, group: 'aircraft'/)
    expect(settings).toMatch(/id: 'baro\.up', label: msg`Raise altimeter setting`, group: 'aircraft'/)
  })
})

// The height indicator per FO-5 item 41 and NATOPS 2.12.5 (#58): the scale measured
// from FO-5's dial, 0 at twelve o'clock; ticks every 20 ft to 100, every 50 to 1,000
// and every 500 to 5,000; labelled 0 to 50 in hundreds under R ALT X100 FT; the green
// BIT and red warning lights either side of the hub and the OFF flag's window below
// it. The set's power (the knob) joins radar silence in every gate, and it sounds the
// familiarisation whoop at ground power-up.
describe('the radar altimeter height indicator', () => {
  const draw = /\nfunction radalt_draw\(r, agl, index, silent, test\)\{[\s\S]*?r\.tex\.needsUpdate=true; \}\n/.exec(source)?.[0] ?? ''
  const consts = /\nconst RADALT_DIAL=[^\n]*\n/.exec(source)?.[0] ?? ''
  const face = (agl: number, silent: boolean, test: boolean) => new Function('agl', 'silent', 'test', `const D2R=Math.PI/180; ${consts} ${lift('dial')}
    const text=[], lights=[]; let strokes=0, fill='';
    const x=new Proxy({}, { get:(t,k)=>{ if(k==='fillText') return (s)=>text.push(String(s)); if(k==='stroke') return ()=>{ strokes++; }; if(k==='arc') return (ax,ay,r)=>{ if(r===7) lights.push([ax,ay,fill]); }; return ()=>{}; },
      set:(t,k,v)=>{ if(k==='fillStyle') fill=v; return true; } });
    const r={ canvas:{ getContext:()=>x }, tex:{} };
    ${draw} radalt_draw(r,agl,200,silent,test); return { text, strokes, lights, off:!!r.off };`)(agl, silent, test) as { text: string[]; strokes: number; lights: [number, number, string][]; off: boolean }

  it('puts the scale where FO-5 draws it: 0 at twelve o\'clock, 1,000 ft at 258°, 5,000 at 320°', () => {
    const degrees = (ft: number) => new Function('ft', `const D2R=Math.PI/180; ${consts} ${lift('dial')} return dial(RADALT_DIAL,ft)/D2R;`)(ft) as number
    expect(degrees(0)).toBe(0)
    expect(degrees(50)).toBeCloseTo(20.1, 1)
    expect(degrees(200)).toBeCloseTo(79.2, 1)
    expect(degrees(1000)).toBeCloseTo(257.6, 1)
    expect(degrees(5000)).toBeCloseTo(319.9, 1)
  })

  it('ticks, labels and letters the dial as FO-5 does', () => {
    const d = face(100, false, false)
    expect(d.strokes).toBe(6 + 18 + 8 + 1) // 0-100 by 20, 150-1,000 by 50, 1,500-5,000 by 500, and the pointer
    for (const label of ['0', '1', '4', '6', '8', '10', '30', '50', 'R ALT', 'X100 FT']) expect(d.text).toContain(label)
    for (const label of ['5', '20', '40', 'RADAR ALT']) expect(d.text).not.toContain(label)
  })

  it('lights the green BIT light left of the hub while the BIT runs, and never with the set off', () => {
    const lit = (silent: boolean, test: boolean) => face(100, silent, test).lights.find(([lx]) => lx === 80 - 27)?.[2]
    expect(lit(false, true)).toBe('#30d040')
    expect(lit(false, false)).toBe('#173a17')
    expect(lit(true, true)).toBe('#173a17')
    expect(face(100, false, false).lights.map(([lx, ly]) => [lx, ly])).toEqual([[80 + 27, 80 - 9], [80 - 27, 80 - 9]]) // red right of the hub, green left, level with it
  })

  it('shows OFF with the set off, as under EMCON, and not for the radar\'s own silence (NATOPS 2.12.5, 2.13.5.2)', () => {
    const inhibited = /\nfunction radalt_inhibited\(\)[^\n]*\n/.exec(source)?.[0] ?? ''
    expect(inhibited).not.toBe('')
    const run = (emcon: boolean, on: boolean, sil = false) => new Function('emcon', 'on', 'sil', `const RADAR={ sil, silent:()=>sil||emcon }, radalt_on=on; ${inhibited} return radalt_inhibited();`)(emcon, on, sil) as boolean
    expect(run(false, true)).toBe(false)
    expect(run(true, true)).toBe(true)
    expect(run(false, false)).toBe(true)
    expect(run(false, true, true)).toBe(false)
    expect(face(100, run(false, false), false).off).toBe(true)
    // the gates the power joins: the primary warning, the secondary warning's reading and the HUD's radar altitude
    expect(source).toMatch(/const below=flying&&\(ownship\.gear\?\?1\)>0\.98&&!radalt_inhibited\(\)&&agl<law_index;/)
    expect(source).toMatch(/radar:\(!radalt_inhibited\(\)&&agl<=5000\)\?agl:null/)
    expect(source).toMatch(/if\(agl<=5000&&!radalt_inhibited\(\)\) return \{ feet:Math\.max\(agl,0\), radar:true, fallback:false \};/)
  })

  it('sounds the familiarisation whoop once at ground power-up, and a spawn on the deck or the runway is one', () => {
    const line = /\n\t\t\tif\(radalt_greet\)\{[^\n]*\n/.exec(source)?.[0] ?? ''
    expect(line).not.toBe('')
    const whoops = new Function(`let radalt_greet=true, whoops=0; const audio_law=()=>{ whoops++; }; for(let i=0;i<3;i++){ ${line} } return whoops;`)() as number
    expect(whoops).toBe(1)
    expect(source).toMatch(/radalt_on=true; radalt_test=-Infinity; radalt_greet=st==="carrier"\|\|st==="runway";/)
  })

  it('pushes the knob with the middle button on the face, and presses nothing else with it', () => {
    expect(source).toMatch(/if\(e\.button===1\)\{ const u=ownship\.group\.userData\.radalt;[^\n]*\n\t\tif\(u&&!playback&&_click_ray\.intersectObject\(u\.mesh,false\)\[0\]\) pit_press\("radalt\.test",0\); return; \}/)
  })
})

