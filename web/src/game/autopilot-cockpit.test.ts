// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as navigate from './navigation'
import * as autopilot from './autopilot'
import * as datalink from './datalink'

// The cockpit's side of the autopilot and the data link (G4: #100, #101, #86):
// what the jet tells them, what CPL couples to, the ACL option, the frame that
// puts the autopilot's stick in the pilot's place, and what the Link 4 display
// and the HUD show of it. engine.ts cannot be imported (WebGL at module scope),
// so its functions are lifted as text and run around the real modules, with
// stand-ins for the jet.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
function lift(name: string): string {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`${name} not found in engine.ts`)
  const rest = source.slice(start)
  const end = /\n(?=\S)/.exec(rest.slice(1))
  return end ? rest.slice(0, end.index + 1) : rest
}
const D = Math.PI / 180, FOOT = 0.3048
// The jet: 13 km astern on the final bearing of 060 at 1,200 ft over the deck, on speed with full flaps and the
// ATC, everything on; the suite aligned with the steering on the TACAN.
const world = `const D2R=Math.PI/180, HOOK_AFT=9, HOOK_DROP=4;
  let sim_time=100, master="nav", emcon=false, flap_select=2, atc_on=true, atc_speed=null, demonstration=null, ddi_dirty=false, ufc_dirty=false, law=true, inhibited=false, surface=-1e9, station={ bearing:1, range:20000 }, computers={ one:true, two:true };
  let carrier_ols={ dy:20 }; const shown=[], mc=()=>computers, buses={ ac:true }, radios={ tacan:{ on:true }, ils:{ on:false, channel:11 }, link:{ on:false }, beacon:{ on:false } }, hotas={ paddle:false }, input={ pitch:0, roll:0, trim:0, lean:0 };
  const ownship={ pos:{ x:0, y:20+4+1200*0.3048, z:0 }, grounded:false, waving:false, speed:70, gauges:{ track:61*D2R } };
  let picture={ pitch:2, bank:0, heading:60, track:61, altitude:ownship.pos.y, vertical:0, cas:70, roll:0.01, rate:0.02, groove:{ along:13000-9, right:0, heading:60 } };
  const demonstration_picture=()=>picture, trim_law=()=>law, on_ground=()=>!!ownship.grounded, radalt_inhibited=()=>inhibited, ground_height=()=>surface, ddi_show=(d,p)=>shown.push([d,p]), tacan=()=>station;
  const nav=navigate.fresh(1); navigate.ready(nav,{ x:0, z:0 }); nav.gps.error={ x:0, z:0 }; nav.ins.error={ x:0, z:0 }; nav.steer="tcn";
  const nav_sense=()=>({ dt:0, x:ownship.pos.x, z:ownship.pos.z, east:0, south:-70, tas:70, heading:60*D2R, pitch:0, bank:0, airborne:true, brake:false, power:true, radar:false, deck:false, tacan:null });`
const state = /\nconst hold=autopilot\.fresh\(\), link=datalink\.fresh\(\); let coupled="";\n/.exec(source)?.[0] ?? ''
const functions = ['link_picture', 'couple_now', 'autopilot_sense', 'acl_select', 'autopilot_frame', 'link_draw', 'hud_link', 'hud_coupled'].map(lift).join('\n')
function cockpit<T>(body: string): T {
  if (!state) throw new Error('the autopilot state not found in engine.ts')
  return new Function('navigate', 'autopilot', 'datalink', `${world} ${state} ${functions}
    const point=(x,z,more)=>({ x, z, elevation:0, name:"", offset:null, ...more }), boxed=()=>{ acl_select(); link.test=0; datalink.step(link,link_picture(),1/60); };
    ${body}`)(navigate, autopilot, datalink) as T
}

describe('where the jet is on the carrier\'s approach', () => {
  it('gives the data link the hook against the touchdown point, as the lens has it', () => {
    const p = cockpit<datalink.Picture>('picture.groove.right=-30; ownship.waving=true; radios.link.on=radios.beacon.on=true; return link_picture();')
    expect(p).toMatchObject({ time: 100, along: 13000, across: -30, final: 60, waved: true, link: true, beacon: true, able: true, flaps: true, throttle: true, coupled: '' })
    expect(p.height).toBeCloseTo(1200 * FOOT, 6); expect(p.altitude).toBeCloseTo(24 + 1200 * FOOT, 6)
  })
  it('has the data link and the beacon only switched on, with ac power, out of EMCON, and a ship to talk to', () => {
    const on = 'radios.link.on=radios.beacon.on=true;'
    const got = (setup: string) => { const p = cockpit<datalink.Picture>(`${on} ${setup} return link_picture();`); return [p.link, p.beacon] }
    expect(got('')).toEqual([true, true])
    expect(got('radios.link.on=false;')).toEqual([false, true]); expect(got('radios.beacon.on=false;')).toEqual([true, false])
    expect(got('buses.ac=false;')).toEqual([false, false]); expect(got('emcon=true;')).toEqual([false, false])
    expect(got('carrier_ols=null;')).toEqual([false, true])
  })
  it('can couple with the INS\'s attitude and mission computer 1, flies mode 1 with FULL flaps and the ATC in approach mode', () => {
    const got = (setup: string) => { const p = cockpit<datalink.Picture>(`${setup} return link_picture();`); return [p.able, p.flaps, p.throttle] }
    expect(got('nav.ins.mode="off";')).toEqual([false, true, true]); expect(got('computers={ one:false, two:true };')).toEqual([false, true, true])
    expect(got('flap_select=1;')).toEqual([true, false, true])
    expect(got('atc_on=false;')).toEqual([true, true, false]); expect(got('atc_speed=250;')).toEqual([true, true, false]) // cruise mode is not it
  })
  it('says what the flight controls are coupled to', () => {
    expect(cockpit('hold.modes.coupled=true; hold.source="heading"; return link_picture().coupled;')).toBe('heading')
    expect(cockpit('hold.source="bank"; return link_picture().coupled;')).toBe('')
  })
})

describe('what CPL couples to', () => {
  interface Now { couple: autopilot.Couple; label: string; passed: boolean }
  it('is the steering boxed on the HSI: the TACAN station by its bearing and range, flown as a track', () => {
    const now = cockpit<Now>('return couple_now();')
    expect(now.label).toBe('CPL TCN'); expect(now.passed).toBe(false); expect(now.couple.axis).toBe('track'); expect(now.couple.vertical).toBeNull()
    expect(now.couple.value).toBeCloseTo(1 / D, 6)
    expect(cockpit('station={ bearing:1, range:null }; return couple_now();')).toBeNull() // receive only: no range, no steering
    expect(cockpit('nav.steer=""; return couple_now();')).toBeNull()
  })
  it('is the waypoint, from the position the suite keeps, or the sequence with AUTO boxed', () => {
    const now = cockpit<Now>('nav.steer="wypt"; nav.waypoints[3]=point(5000,-5000); nav.current=3; return couple_now();')
    expect(now.label).toBe('CPL WYPT'); expect(now.couple.value).toBeCloseTo(45, 6)
    expect(cockpit<Now>('nav.steer="wypt"; nav.waypoints[3]=point(5000,-5000); nav.waypoints[4]=point(9000,0); nav.sequences[2]=[3,4]; nav.sequence=2; nav.current=3; nav.auto=true; return couple_now();').label).toBe('CPL SEQ3')
    expect(cockpit<Now>('nav.steer="wypt"; nav.waypoints[3]=point(300,300); nav.current=3; ownship.gauges.track=315*D2R; return couple_now();').passed).toBe(true) // behind, inside a mile
  })
  it('is the carrier\'s heading with ACL boxed and traffic control up, its commands in mode 1', () => {
    const tc = cockpit<Now>('picture.groove.right=400; boxed(); return couple_now();')
    expect(tc.label).toBe('CPLD HDG'); expect(tc.couple.axis).toBe('heading'); expect(tc.couple.value).toBeLessThan(60)
    const acl = cockpit<Now>('picture.groove.along=4*1852; boxed(); return couple_now();')
    expect(acl).toEqual({ couple: { axis: 'bank', value: 0, vertical: 0 }, label: 'CPLD P/R', passed: false })
  })
  it('falls back to the HSI\'s steering when the uplink offers nothing', () => {
    expect(cockpit<Now>('picture.groove.along=4*1852; boxed(); atc_on=false; return couple_now();').label).toBe('CPL TCN') // mode 2
    expect(cockpit<Now>('boxed(); ownship.waving=true; datalink.step(link,link_picture(),1/60); return couple_now();').label).toBe('CPL TCN') // waved off
  })
})

describe('what the jet tells the autopilot', () => {
  it('is its attitude, rates and path, the pilot\'s stick and trim, the heading set on the HSI and the bank limit', () => {
    const s = cockpit<autopilot.Sense>('input.pitch=0.2; input.roll=-0.1; input.trim=1; input.lean=-1; nav.heading=120*D2R; nav.limit="tac"; return autopilot_sense({ couple:{ axis:"track", value:30, vertical:null } });')
    expect(s).toMatchObject({ time: 100, pitch: 2, bank: 0, heading: 60, track: 61, vertical: 0, cas: 70, roll: 0.01, rate: 0.02, approach: true, airborne: true, attitude: true, computer: true,
      stick: { pitch: 0.2, roll: -0.1 }, trim: { pitch: 1, roll: -1 }, couple: { axis: 'track', value: 30, vertical: null }, limit: 'tac' })
    expect(s.selected).toBeCloseTo(120, 6); expect(s.height).toBeCloseTo(s.altitude, 6) // over the sea
    expect(cockpit<autopilot.Sense>('return autopilot_sense(null);').couple).toBeNull()
  })
  it('reads the radar altitude over the ground, and none with the altimeter off or silenced', () => {
    const s = cockpit<autopilot.Sense>('surface=150; return autopilot_sense(null);')
    expect(s.height).toBeCloseTo(s.altitude - 150, 6)
    expect(cockpit<autopilot.Sense>('inhibited=true; return autopilot_sense(null);').height).toBeNull()
  })
  it('says which control law flies, whether the jet is in the air, and what the autopilot needs of the INS and MC1', () => {
    const got = (setup: string) => { const s = cockpit<autopilot.Sense>(`${setup} return autopilot_sense(null);`); return [s.approach, s.airborne, s.attitude, s.computer] }
    expect(got('law=false;')).toEqual([false, true, true, true]); expect(got('ownship.grounded=true;')).toEqual([true, false, true, true])
    expect(got('nav.ins.mode="off";')).toEqual([true, true, false, true]); expect(got('computers={ one:false, two:true };')).toEqual([true, true, true, false])
  })
})

describe('the ACL option', () => {
  it('boxes ACL: the test runs, the Link 4 display comes up on the left DDI, and the ILS, data link and beacon are turned on (24.6.1.2.1)', () => {
    const s = cockpit<unknown[]>('acl_select(); return [link.selected, link.test, shown, radios.ils.on, radios.link.on, radios.beacon.on, ddi_dirty, ufc_dirty];')
    expect(s).toEqual([true, 10, [['left', 'sa']], true, true, true, true, true])
  })
  it('drops waypoint steering and any designation, and leaves TACAN steering (24.6.1.1.2 e)', () => {
    const s = cockpit<unknown[]>('nav.steer="wypt"; nav.auto=true; nav.course=1; nav.designation={ x:1, z:1, elevation:0, stage:"tgt" }; acl_select(); return [nav.steer, nav.auto, nav.course, nav.designation];')
    expect(s).toEqual(['', false, null, null])
    expect(cockpit('nav.course=1; acl_select(); return [nav.steer, nav.course];')).toEqual(['tcn', 1])
  })
  it('unboxes it clean, changing nothing else', () => {
    const s = cockpit<unknown[]>('acl_select(); radios.ils.on=false; shown.length=0; acl_select(); return [link.selected, link.test, link.five, shown, radios.ils.on, radios.link.on];')
    expect(s).toEqual([false, 0, null, [], false, true])
  })
})

describe('the frame', () => {
  it('leaves the pilot\'s controls alone while the autopilot is off, and runs the data link', () => {
    const s = cockpit<unknown[]>('boxed(); link.five=null; input.pitch=0.3; input.roll=0.2; input.trim=1; input.lean=1; autopilot_frame(1/60); return [input, !!link.five];')
    expect(s).toEqual([{ pitch: 0.3, roll: 0.2, trim: 1, lean: 1 }, true])
  })
  it('gives the flight controls the autopilot\'s stick on the axes it holds, and keeps the trim switch from the control law', () => {
    const s = cockpit<{ input: Record<string, number>; pitch: number }>(`autopilot.select(hold,"barometric",autopilot_sense(null)); picture.altitude-=20; picture.heading=50; input.trim=1; input.lean=1;
      autopilot_frame(1/60); return { input, pitch:hold.pitch };`)
    expect(s.input.pitch).toBeGreaterThan(0.05); expect(s.input.roll).toBeGreaterThan(0.05) // low and left of the heading held: up and right
    expect([s.input.trim, s.input.lean]).toEqual([0, 0])
  })
  it('leaves an axis the pilot flies through the stick to him, trim and all', () => {
    const s = cockpit<Record<string, number>>('autopilot.engage(hold,autopilot_sense(null)); input.roll=0.4; input.lean=1; input.trim=1; autopilot_frame(1/60); return input;')
    expect([s.roll, s.lean, s.trim]).toEqual([0.4, 1, 0]); expect(s.pitch).not.toBe(0)
  })
  it('takes every mode off with the paddle switch, and while the scripted pilot flies', () => {
    for (const how of ['hotas.paddle=true;', 'demonstration={};']) {
      const s = cockpit<unknown[]>(`autopilot.select(hold,"barometric",autopilot_sense(null)); hold.caution=200; ${how} input.pitch=0.1; autopilot_frame(1/60); return [hold.engaged, hold.modes.barometric, hold.caution, input.pitch];`)
      expect(s, how).toEqual([false, false, -Infinity, 0.1])
    }
  })
  it('unboxes ACL when the master mode leaves NAV (24.6.1)', () => {
    expect(cockpit('boxed(); master="gun"; autopilot_frame(1/60); return [link.selected, link.five];')).toEqual([false, null])
    expect(cockpit('boxed(); autopilot_frame(1/60); return link.selected;')).toBe(true)
  })
  it('uncouples over a point flown direct, with no caution, the altitude hold kept (24.2.9.3)', () => {
    const s = cockpit<unknown[]>(`nav.steer="wypt"; nav.waypoints[3]=point(0,-3000); nav.current=3; ownship.gauges.track=0; const now=couple_now(), sense=autopilot_sense(now);
      autopilot.select(hold,"barometric",sense); autopilot.select(hold,"coupled",sense); coupled=now.label; autopilot_frame(1/60); const on=hold.modes.coupled;
      ownship.pos.z=-3300; autopilot_frame(1/60); return [on, hold.modes.coupled, hold.modes.barometric, hold.engaged, hold.lateral, autopilot.cautions(hold,sim_time), coupled];`)
    expect(s).toEqual([true, false, true, true, 'heading', [], 'CPL WYPT'])
  })
  const sequence = 'nav.steer="wypt"; nav.waypoints[3]=point(0,-20000); nav.waypoints[4]=point(20000,-20000); nav.sequences[0]=[3,4]; nav.current=3; nav.auto=true; ownship.gauges.track=0; ownship.speed=200; picture.cas=200;'
  it('turns a coupled sequence ahead of its waypoint, and leaves an uncoupled one to the 5 nm rule (24.2.9.5)', () => {
    const coupled = cockpit<unknown[]>(`${sequence} const now=couple_now(), sense=autopilot_sense(now); autopilot.select(hold,"coupled",sense); coupled=now.label; autopilot_frame(1/60); const far=nav.current;
      ownship.pos.z=-20000+7500; autopilot_frame(1/60); return [far, nav.current, coupled, hold.modes.coupled];`)
    expect(coupled).toEqual([3, 4, 'CPL SEQ1', true])
    expect(cockpit(`${sequence} autopilot.engage(hold,autopilot_sense(null)); ownship.pos.z=-20000+7500; autopilot_frame(1/60); return nav.current;`)).toBe(3)
  })
  it('uncouples at the end of the sequence, AUTO gone, with no caution', () => {
    const s = cockpit<unknown[]>(`${sequence} nav.current=4; const now=couple_now(), sense=autopilot_sense(now); autopilot.select(hold,"coupled",sense); coupled=now.label; autopilot_frame(1/60); const on=hold.modes.coupled;
      nav.auto=false; autopilot_frame(1/60); return [on, hold.modes.coupled, hold.engaged, autopilot.cautions(hold,sim_time)];`)
    expect(s).toEqual([true, false, true, []])
  })
  it('lets go with the caution when the steering coupled to is taken away, keeping what it was coupled to for the flashing cue', () => {
    const s = cockpit<unknown[]>(`const now=couple_now(), sense=autopilot_sense(now); autopilot.select(hold,"coupled",sense); coupled=now.label; autopilot_frame(1/60);
      nav.steer=""; autopilot_frame(1/60); return [hold.modes.coupled, autopilot.cautions(hold,sim_time), coupled, autopilot.cue(hold,sim_time)];`)
    expect(s).toEqual([false, ['AUTO PILOT'], 'CPL TCN', true])
  })
  it('follows the steering\'s name while coupled to it: a waypoint, then its sequence once AUTO is boxed', () => {
    const s = cockpit<unknown[]>(`nav.steer="wypt"; nav.waypoints[3]=point(0,-20000); nav.waypoints[4]=point(20000,-20000); nav.sequences[1]=[3,4]; nav.sequence=1; nav.current=3; ownship.gauges.track=0;
      const now=couple_now(), sense=autopilot_sense(now); autopilot.select(hold,"coupled",sense); coupled=now.label; autopilot_frame(1/60); const first=coupled; nav.auto=true; autopilot_frame(1/60); return [first, coupled, hold.modes.coupled];`)
    expect(s).toEqual(['CPL WYPT', 'CPL SEQ2', true])
  })
  it('keeps the label of what is coupled when another source turns up beside it', () => {
    const s = cockpit<unknown[]>(`const now=couple_now(), sense=autopilot_sense(now); autopilot.select(hold,"coupled",sense); coupled=now.label; boxed(); const offered=couple_now().label;
      autopilot_frame(1/60); return [offered, coupled, hold.modes.coupled];`)
    expect(s).toEqual(['CPLD HDG', 'CPL TCN', false]) // the uplink's heading is not the steering it coupled to: it lets go
  })
  it('redraws the displays and the UFC when a mode, the caution or the uplink changes, and not otherwise', () => {
    expect(cockpit('autopilot_frame(1/60); return [ddi_dirty, ufc_dirty];')).toEqual([false, false])
    expect(cockpit('autopilot.engage(hold,autopilot_sense(null)); autopilot_frame(1/60); ddi_dirty=ufc_dirty=false; autopilot_frame(1/60); const steady=ddi_dirty; hotas.paddle=true; autopilot_frame(1/60); return [steady, ddi_dirty, ufc_dirty];')).toEqual([false, true, true])
    expect(cockpit('acl_select(); link.test=0; ddi_dirty=ufc_dirty=false; autopilot_frame(1/60); return [ddi_dirty, ufc_dirty];')).toEqual([true, true])
  })
  it('runs in the step once the pilot\'s controls are read, ahead of the scripted pilot', () => {
    expect(source).toMatch(/\n\tautopilot_frame\(dt\);[^\n]*\n\tif\(demonstration\) demonstration_drive\(dt\);/)
  })
})

describe('the HUD\'s cues', () => {
  it('shows the data link\'s cue only with ACL boxed in NAV: W/O, TILT, 10 SEC, or DATA flashing (24.6.1.1.2 b)', () => {
    expect(cockpit('return hud_link();')).toBe('')
    expect(cockpit('boxed(); return hud_link();')).toBe('')
    expect(cockpit('boxed(); link.data=100; return [hud_link(), (sim_time=100.25, hud_link()), (sim_time=109.6, hud_link()), (sim_time=110.1, hud_link())];')).toEqual(['DATA', '', 'DATA', ''])
    expect(cockpit('boxed(); link.data=100; link.ten=90; return hud_link();')).toBe('10 SEC')
    expect(cockpit('boxed(); picture.groove.along=101*1852; datalink.step(link,link_picture(),1/60); link.ten=90; return hud_link();')).toBe('TILT')
    expect(cockpit('boxed(); ownship.waving=true; datalink.step(link,link_picture(),1/60); link.ten=90; return hud_link();')).toBe('W/O')
    expect(cockpit('boxed(); link.data=100; master="gun"; return hud_link();')).toBe('')
  })
  it('shows what the flight controls are coupled to, flashing after a couple that failed, else ACL RDY as it is sent (24.6.1.1.2 c)', () => {
    expect(cockpit('return hud_coupled();')).toBe('')
    expect(cockpit('hold.modes.coupled=true; coupled="CPL WYPT"; return hud_coupled();')).toBe('CPL WYPT')
    expect(cockpit('hold.flash=110; coupled="CPLD HDG"; return [hud_coupled(), (sim_time=100.25, hud_coupled()), (sim_time=110, hud_coupled())];')).toEqual(['CPLD HDG', '', ''])
    expect(cockpit('picture.groove.along=4*1852; boxed(); return hud_coupled();')).toBe('ACL RDY')
    expect(cockpit('picture.groove.along=4*1852; boxed(); hold.modes.coupled=true; coupled="CPLD P/R"; return hud_coupled();')).toBe('CPLD P/R')
    expect(cockpit('picture.groove.along=4*1852; boxed(); master="gun"; return hud_coupled();')).toBe('')
  })
  it('stacks them over ATC and the range, the data link\'s on top (figure 24-24)', () => {
    expect(source).toMatch(/if\(top\) hctx\.fillText\(top,lx,cy\+7\.2\*ppdv-51\);\n\t\tif\(cue\) hctx\.fillText\(cue,lx,cy\+7\.2\*ppdv-34\); \}/)
  })
  const heading = /\n\tif\(link\.five&&master==="nav"&&!\(hold\.modes\.coupled&&hold\.source==="bank"\)\)\{[^\n]*\n[\s\S]*?\n\t\thctx\.stroke\(\); \}/.exec(source)?.[0] ?? ''
  it('points at the controller\'s command heading below the heading scale with a double chevron (24.6.1.1.2 a)', () => {
    expect(heading).not.toBe('')
    const drawn = (setup: string) => new Function('navigate', `const D2R=Math.PI/180, cx=500, hty=46, hppx=7, GR="g", ownship={ fwd:{ x:0, z:-1 } }, link={ five:{ heading:4 } }, hold={ modes:{ coupled:false }, source:"track" }; let master="nav";
      const moves=[], lines=[]; let at=[0,0]; const hctx={ beginPath(){}, stroke(){}, setLineDash(){}, moveTo(x,y){ moves.push([x,y]); at=[x,y]; }, lineTo(x,y){ lines.push([at[0],at[1],x,y]); at=[x,y]; } };
      ${setup} ${heading} return { moves, lines };`)(navigate) as { moves: number[][]; lines: number[][] }
    const rounded = (rows: number[][]) => rows.map((row) => row.map((v) => Math.round(v * 1e6) / 1e6))
    const d = drawn('')
    expect(rounded(d.moves)).toEqual([[523, 59], [523, 64]]) // 4° right of the nose, two chevrons under the scale
    expect(rounded(d.lines)).toEqual([[523, 59, 528, 54], [528, 54, 533, 59], [523, 64, 528, 59], [528, 59, 533, 64]])
    expect(rounded(drawn('link.five.heading=90;').moves)[0][0]).toBe(495 + 15 * 7) // past 30°, at the scale's end
    expect(drawn('link.five=null;').moves).toEqual([]); expect(drawn('master="gun";').moves).toEqual([])
    expect(drawn('hold.modes.coupled=true; hold.source="bank";').moves).toEqual([]) // coupled to the carrier's commands, its heading is gone from the displays
    expect(drawn('hold.modes.coupled=true; hold.source="heading";').moves.length).toBe(2)
  })
  const tadpole = /\n\tif\(fpm&&link\.selected&&link\.six&&master==="nav"\)\{[^\n]*\n[^\n]*\n[^\n]*\} \}/.exec(source)?.[0] ?? ''
  it('draws the data link\'s tadpole from the velocity vector toward the glidepath and centreline, to the ILS bars\' scale (24.6.1.1.2 f)', () => {
    expect(tadpole).not.toBe('')
    const drawn = (six: string, more = '') => new Function(`const D2R=Math.PI/180, ppd=20, GR="g", THREE={ MathUtils:{ clamp:(v,lo,hi)=>Math.min(hi,Math.max(lo,v)) } }, link={ selected:true, six:${six} }, link_picture=()=>({ along:1000 }); let fpm=[400,300], master="nav";
      const arcs=[], stems=[]; let at=[0,0]; const hctx={ beginPath(){}, stroke(){}, setLineDash(){}, arc(x,y,r){ arcs.push([x,y,r]); }, moveTo(x,y){ at=[x,y]; }, lineTo(x,y){ stems.push([at[0],at[1],x,y]); } };
      ${more} { ${tadpole} return { arcs, stems };`)() as { arcs: number[][]; stems: number[][] }
    const on = drawn('{ vertical:0, lateral:0 }')
    expect(on.arcs).toEqual([[400, 300, 4]]); expect(on.stems).toEqual([[400, 296, 400, 286]])
    const off = drawn('{ vertical:10, lateral:30 }') // right of the centreline and above the glidepath: fly left and down
    expect(off.arcs[0][0]).toBeCloseTo(400 - (Math.atan2(30, 1000) / D / 3) * 44, 6); expect(off.arcs[0][1]).toBeCloseTo(300 + (Math.atan2(10, 1000) / D / 0.8) * 44, 6)
    const wide = drawn('{ vertical:-400, lateral:-900 }')
    expect(wide.arcs[0]).toEqual([444, 256, 4]) // full scale: 2.2° either way
    expect(drawn('null').arcs).toEqual([]); expect(drawn('{ vertical:0, lateral:0 }', 'master="gun";').arcs).toEqual([]); expect(drawn('{ vertical:0, lateral:0 }', 'fpm=null;').arcs).toEqual([])
  })
})

describe('the Link 4 display', () => {
  interface Drawn { text: [string, number, number, string][]; lines: number[][]; fills: number[][] }
  const draw = (setup: string) => cockpit<Drawn>(`${setup}
    const text=[], lines=[], fills=[]; let at=[0,0], align="";
    const x=new Proxy({}, { get:(t,k)=>k==="fillText"?(s,px,py)=>text.push([String(s),px,py,align]):k==="fillRect"?(a,b,c,d)=>fills.push([a,b,c,d]):k==="moveTo"?(px,py)=>{ at=[px,py]; }:k==="lineTo"?(px,py)=>{ lines.push([at[0],at[1],px,py]); at=[px,py]; }
      :k==="measureText"?(s)=>({ width:10*String(s).length }):()=>{}, set:(t,k,v)=>{ if(k==="textAlign") align=v; return true; } });
    link_draw(x,266,196,60*D2R); return { text, lines, fills };`)
  const shown = (d: Drawn) => d.text.filter(([s]) => s !== '').map(([s, px, py]) => [s, px, py])
  it('shows the controller\'s commands at the upper left, his discrete over the mode at the upper right, and the aircraft\'s capability under them (figure 24-23)', () => {
    const d = draw('picture.groove.along=5.5*1852; picture.altitude=ownship.pos.y=2000; boxed();')
    expect(shown(d)).toEqual([['CMD A/S', 44, 58], ['CMD ALT', 44, 80], ['CMD ROD', 44, 102], ['130', 176, 58], ['1200', 176, 80], ['2000', 176, 102], ['LND CHK', 400, 58], ['T/C', 400, 80], ['ACL 1', 446, 128]])
    expect(d.fills).toEqual([[40, 46, 140, 68], [344, 46, 112, 46], [396, 94, 100, 46]]) // the blocks masked clear of the rose
  })
  it('shows TEST while the mode tests, with nothing uplinked', () => {
    expect(shown(draw('acl_select();'))).toEqual([['CMD A/S', 44, 58], ['CMD ALT', 44, 80], ['CMD ROD', 44, 102], ['TEST', 446, 128]])
  })
  it('shows ACL RDY over MODE 1 once the radar has the jet, and the 10 SEC notice', () => {
    const d = draw('picture.groove.along=4*1852; boxed(); link.ten=95;')
    expect(shown(d)).toEqual(expect.arrayContaining([['ACL RDY', 400, 58], ['MODE 1', 400, 80], ['10 SEC', 446, 106], ['ACL 1', 446, 128]]))
  })
  it('takes the figures and the command heading off once coupled to the carrier\'s commands (figure 24-29)', () => {
    const d = draw('picture.groove.along=4*1852; boxed(); hold.modes.coupled=true; hold.source="bank";')
    expect(shown(d)).toEqual([['CMD A/S', 44, 58], ['CMD ALT', 44, 80], ['CMD ROD', 44, 102], ['ACL RDY', 400, 58], ['MODE 1', 400, 80], ['ACL 1', 446, 128]])
    expect(d.lines).toEqual([])
    expect(draw('picture.groove.along=4*1852; boxed(); hold.modes.coupled=true; hold.source="heading";').lines.length).toBe(4) // a traffic control couple keeps them
  })
  it('underlines the item that last changed, and nothing else', () => {
    expect(draw('boxed();').lines.length).toBe(4) // the chevrons only
    const d = draw('picture.groove.along=4*1852; boxed(); link.changed="discrete";')
    expect(d.lines).toContainEqual([365, 69, 435, 69]) // under ACL RDY, centred on 400
    const speed = draw('boxed(); link.changed="airspeed";')
    expect(speed.lines).toContainEqual([146, 69, 176, 69]) // under 250, right-aligned at 176
    expect(draw('boxed(); link.changed="notice";').lines.length).toBe(4) // no notice up: nothing to underline
  })
  it('puts the command heading\'s double chevron outside the rose, at the heading against the nose', () => {
    const d = draw('boxed();') // commanded 060, the nose on 060: straight up
    expect(d.lines.length).toBe(4)
    const tips = [d.lines[0], d.lines[2]].map(([, , px, py]) => [Math.round(px), Math.round(py)])
    expect(tips).toEqual([[256, 266 - 204], [256, 266 - 212]])
    expect(d.lines[0][1]).toBeLessThan(d.lines[0][3]) // its arms outboard: it points in at the rose
    const right = draw('picture.groove.right=-8000; picture.groove.along=6*1852; boxed();') // well left of the centreline: commanded 090, 30° right of the nose
    expect(Math.round(right.lines[0][2])).toBe(Math.round(256 + Math.sin(30 * D) * 204)); expect(Math.round(right.lines[0][3])).toBe(Math.round(266 - Math.cos(30 * D) * 204))
  })
  it('comes up on the SA display while ACL is boxed', () => {
    expect(source).toMatch(/\n\tif\(link\.selected\) link_draw\(x,cy,R,hdg\); \}/)
  })
})

describe('where the rest of the cockpit meets them', () => {
  it('raises AUTO PILOT among the cautions and the autopilot\'s advisories on the ADV line (2.9.1)', () => {
    expect(source).toMatch(/\n\tfor\(const caption of autopilot\.cautions\(hold,sim_time\)\) captions\.push\(caption\);/)
    expect(source).toMatch(/\n\tfor\(const a of autopilot\.advisories\(hold\)\) list\.push\(\[a,a\]\);/)
  })
  it('starts a mission with the autopilot off, ACL unboxed, and the data link and beacon on', () => {
    expect(source).toMatch(/\n\tObject\.assign\(hold,autopilot\.fresh\(\)\); Object\.assign\(link,datalink\.fresh\(\)\); coupled="";/)
    expect(source).toMatch(/const radios_tuned=\(\)=>\(\{[^\n]*link:\{ on:true \}, beacon:\{ on:true \} \}\);/)
  })
  it('counts the data link and the beacon among the BIT display\'s units', () => {
    expect(source).toMatch(/bcn:radios\.beacon\.on\?"ok":"off", dl:radios\.link\.on\?"ok":"off",/)
    expect(source).toMatch(/comm:\{ 2:\["D\/L"\] \}/)
  })
})
