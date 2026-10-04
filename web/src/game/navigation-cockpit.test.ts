// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import * as navigate from './navigation'
import * as communication from './communication'
import * as identification from './identification'
import * as mids from './mids'

// The cockpit's side of the navigation suite (G3): the engine's glue between the
// jet and navigation.ts, the INS knob and the set switches, the HSI's pushbuttons
// and the TDC on it, the UFC's data entry, the MUMI display's options and the
// HUD's steering. engine.ts cannot be imported (WebGL at module scope), so its
// functions are lifted as text and run around the real navigation module, with
// stand-ins for the jet.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
function lift(name: string): string {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`${name} not found in engine.ts`)
  const rest = source.slice(start)
  const end = /\n(?=\S)/.exec(rest.slice(1))
  return end ? rest.slice(0, end.index + 1) : rest
}
function line(name: string): string {
  const m = new RegExp(`\\n(?:const|let) ${name}=[^\\n]*\\n`).exec(source)
  if (!m) throw new Error(`${name} not found in engine.ts`)
  return m[0]
}
const pages = /\nconst UFC_PAGES=\{[\s\S]*?\n\tstation:[^\n]*\n/.exec(source)?.[0] ?? ''
const D = Math.PI / 180, NM = 1852
// The jet: at 3,000 m over the map's origin heading north at 200 m/s, the ship 10.8 nm to the west-south-west.
const world = `const D2R=Math.PI/180, NM=1852;
  let sim_time=0, ddi_dirty=false, WORLD_WRAP=0, parking=false, master="nav", designator="center", last_out=null, ufc_dirty=false, law_primary=false, law_disabled=false, emcon=false, designated=-1, radar_calls=0;
  const wrap_axis=(v)=>v, CARRIER={ x:-18500, z:7500, deckY:20 }, SHIP={ ident:"NIM", tacan:{ channel:74, band:"X" } }, buses={ ac:true }, STATE={ mach:0 };
  const RADAR={ silent:()=>false, mode:"rws", stt:null, tracks:[], ls:null }, radar_undesignate=()=>{ radar_calls++; return false; }, radar_events=[], carrier_ols=true;
  const ownship={ pos:{ x:0, y:3000, z:0 }, velx:0, vely:0, velz:-200, speed:200, grounded:false, vel_dir:{ x:0, y:0, z:-1 }, gauges:{ heading:0, pitch:0, bank:0, track:0, ground:389, zulu:0 } };
  const airports=[{ x:-1429, z:3537, sy:5.7, code:"PMDY" }, { x:9, z:9, sy:3 }], radios={ tacan:{ on:true, channel:74, band:"X", mode:"tr", air:false }, ils:{ on:true, channel:11 } };
  const keys_down=new Set(), held=(a)=>keys_down.has(a), airspeed=(mach)=>mach*340, emcon_set=()=>{}, ufc_update=()=>{}, performance={ now:()=>1000 }, timer_enter=()=>false, timer={ shown:"" };
  const ddi_state={ left:{ page:"fpas", menu:"" }, right:{ page:"rdr", menu:"" }, center:{ page:"hsi", menu:"" } };
  const altitude_set={ radar:0, baro:5000 }, altitude_armed={ radar:true, baro:true };
  let computers={ one:true, two:true }, acl=0; const mc=()=>computers, acl_select=()=>{ acl++; };
  const uhf={ one:communication.fresh(), two:communication.fresh(), panel:communication.panel(11), keypad:communication.backup(), pulled:"" }, squawk=identification.fresh(), terminal=mids.fresh();`
const defs = [line('HSI_SCALES'), line('hsi_state'), line('VARIATION'), line('nav'), line('INS_KNOB'), line('sets'), line('carrier_given'), line('mumi'), line('MUMI_FILES'), line('fpas'), pages, line('UFC_ENTRY'), line('UFC_UNITS'), line('ufc'), line('grid_state'), line('GRID_SHIFTS'), line('GRID_BOX')].join('')
const functions = ['button_of', 'hundredths', 'tacan', 'tacan_variation', 'grid_reference', 'grid_open', 'grid_sync', 'grid_shifts', 'grid_press', 'tdc_grid', 'grid_designate', 'grid_slew', 'grid_face', 'nav_reset', 'aboard', 'nav_sense', 'mission', 'set_press', 'nav_ready', 'nav_frame', 'waypoint_edit', 'station_edit', 'tdc_hsi', 'hsi_designate', 'hsi_slew', 'hsi_press', 'data_press', 'data_enter', 'ufc_enter', 'ufc_press',
  'hud_steer', 'mumi_press', 'undesignate_press'].map(lift).join('\n')
// cockpit runs a body against the engine's navigation glue, booted as a spawn in the air is unless raw
function cockpit<T>(body: string, raw = false): T {
  return new Function('navigate', 'THREE', 'communication', 'identification', 'mids', `${world} ${defs} ${functions}
    map_name="MIDWAY ATOLL"; const point=(x,z,more)=>({ x, z, elevation:0, name:"", offset:null, ...more }), keys=(...b)=>{ for(const k of b) ufc_press(k); };
    ${raw ? '' : 'nav_reset(); nav_frame(0.1);'}
    ${body}`)(navigate, THREE, communication, identification, mids) as T
}

describe('what the jet tells the suite', () => {
  it('measures position, velocities, attitude and the switches that matter to an alignment', () => {
    const t = cockpit<navigate.Truth>('parking=true; ownship.gauges.bank=0.3; return nav_sense(0.25);')
    expect(t).toMatchObject({ dt: 0.25, x: 0, z: 0, east: 0, south: -200, tas: 200, heading: 0, bank: 0.3, airborne: true, brake: true, power: true, radar: true, deck: false })
  })
  it('says whether mission computer 1 is running, for the GPS that works through it', () => {
    expect(cockpit<boolean[]>('const a=nav_sense(0).computer; computers={ one:false, two:true }; return [a, nav_sense(0).computer];')).toEqual([true, false])
  })
  it('takes true airspeed from the core\'s Mach number, not the speed over the ground', () => {
    expect(cockpit<number>('last_out=[0.5]; return nav_sense(0).tas;')).toBe(170)
  })
  it('counts the radar only when it is operating in the NAV master mode, and power from the ac buses', () => {
    expect(cockpit<boolean[]>('const a=nav_sense(0).radar; master="9m"; const b=nav_sense(0).radar; master="nav"; RADAR.silent=()=>true; const c=nav_sense(0).radar; buses.ac=false; return [a,b,c,nav_sense(0).power];')).toEqual([true, false, false, false])
  })
  it('gives a TACAN fix only from a stored station, received with range', () => {
    const fix = cockpit<navigate.Truth['tacan']>('return nav_sense(0).tacan;')
    expect(fix).toMatchObject({ x: -18500, z: 7500 })
    expect(fix?.range).toBeCloseTo(Math.hypot(18500, 7500), 6)
    expect(cockpit('nav.stations=[]; return nav_sense(0).tacan;')).toBeNull()
    expect(cockpit('radios.tacan.mode="rcv"; return nav_sense(0).tacan;')).toBeNull()
    expect(cockpit('nav.stations[0].channel=12; return nav_sense(0).tacan;')).toBeNull()
  })
  it('is aboard only on the wheels within the ship\'s length of it', () => {
    expect(cockpit<boolean[]>('const air=aboard(); ownship.grounded=true; const far=aboard(); ownship.pos.x=-18400; ownship.pos.z=7450; const on=[aboard(),nav_sense(0).deck]; ownship.grounded=false; return [air,far,...on,aboard()];')).toEqual([false, false, true, true, false]) // not while flying over it
  })
})

describe('the mission data load', () => {
  it('carries the ship and the first airfield as waypoints 1 and 2, the ship\'s TACAN station, and the GPS points', () => {
    const m = cockpit<navigate.Mission>('return mission();')
    expect(m.identifier).toBe('MIDWAY')
    expect(m.waypoints).toEqual([{ index: 1, point: { name: 'NIM', x: -18500, z: 7500, elevation: 20 } }, { index: 2, point: { name: 'PMDY', x: -1429, z: 3537, elevation: 3.5 } }])
    expect(m.stations).toEqual([{ channel: 74, band: 'X', x: -18500, z: 7500, elevation: 20, name: 'NIM', variation: 7 * D }])
    expect(m.points.map((p) => p.name)).toEqual(['NIM', 'PMDY']) // an airfield without a code is left out
  })
})

describe('a spawn', () => {
  it('finds the INS aligned at NAV, the mission loaded and TACAN steering selected', () => {
    const s = cockpit<{ knob: string; mode: string; source: string; steer: string; variation: number; heading: number; identifier: string; loaded: string[]; one: unknown; two: unknown; stations: number; points: number; cautions: string[] }>(
      'ownship.gauges.heading=1; nav_reset(); nav_frame(0.1); return { knob:nav.ins.knob, mode:nav.ins.mode, source:nav.source, steer:nav.steer, variation:nav.variation, heading:nav.heading, identifier:nav.memory.identifier, loaded:nav.memory.loaded, one:nav.waypoints[1], two:nav.waypoints[2], stations:nav.stations.length, points:nav.points.length, cautions:navigate.cautions(nav) };')
    expect(s).toMatchObject({ knob: 'nav', mode: 'nav', source: 'ins', steer: 'tcn', heading: 1, identifier: 'MIDWAY', stations: 1, points: 2, cautions: [] })
    expect(s.variation).toBeCloseTo(7 * D, 9)
    expect(s.loaded).toEqual(['WYPT', 'TCN', 'GPS WYPT', 'GPS ALM', 'IFF', 'COMM']) // the mission's IFF codes and comm presets with them (23.6.1.5.1, G5)
    expect(s.one).toMatchObject({ x: -18500, z: 7500, name: 'NIM' }); expect(s.two).toMatchObject({ name: 'PMDY' })
  })
  it('stores the place it aligned in waypoint 0: where it stands on the ground, the ship for a start in the air', () => {
    expect(cockpit('return nav.waypoints[0];')).toMatchObject({ x: -18500, z: 7500 })
    expect(cockpit('ownship.grounded=true; ownship.pos.x=40; ownship.pos.z=60; nav_reset(); nav_frame(0.1); return nav.waypoints[0];')).toMatchObject({ x: 40, z: 60 })
  })
  it('is readied once, as soon as the core has given the pose and before that frame\'s cautions are judged', () => {
    // a suite still off reads as a new INS ATT, which latches MASTER CAUTION and sounds its tone, and
    // without waypoint 0 FPAS cannot work out the fuel home
    const s = cockpit<{ cold: string[]; ready: string[]; mode: string; home: boolean; heading: number }>(
      'nav_reset(); const cold=navigate.cautions(nav); ownship.gauges.heading=1; nav_ready(); const ready=navigate.cautions(nav); ownship.gauges.heading=2; nav_ready(); nav_frame(0.1); return { cold, ready, mode:nav.ins.mode, home:nav.waypoints[0]!==null, heading:nav.heading };', true)
    expect(s).toEqual({ cold: ['INS ATT'], ready: [], mode: 'nav', home: true, heading: 1 }) // a later call, or nav_frame, does not ready it again
    const fly = lift('fly_player'), at = fly.indexOf('\tsync_core(out); last_out=out;\n\tnav_ready();')
    expect(at).toBeGreaterThan(0)
    expect(fly.indexOf('cautions_update();')).toBeGreaterThan(at)
  })
  it('loads the airfields when they arrive after it', () => {
    expect(cockpit<unknown[]>('const late=airports.splice(0); nav_reset(); nav_frame(0.1); const before=nav.waypoints[2]; airports.push(...late); nav_frame(0.1); return [before, nav.waypoints[2].name];')).toEqual([null, 'PMDY'])
  })
  it('steps the INS every frame, and moves AUTO steering on to the next waypoint', () => {
    const s = cockpit<{ error: number; current: number; dirty: boolean }>(`nav.waypoints[5]=point(0,3000); nav.waypoints[6]=point(0,-90000); navigate.insert(nav,5); navigate.insert(nav,6); navigate.automatic(nav);
      ddi_dirty=false; for(let k=0;k<100;k++) nav_frame(1);
      return { error:Math.hypot(nav.ins.error.x,nav.ins.error.z), current:nav.current, dirty:ddi_dirty };`)
    expect(s.error).toBeCloseTo(100.1 * navigate.DRIFT, 6) // the spawn's first frame and a hundred more
    expect(s).toMatchObject({ current: 6, dirty: true }) // waypoint 5 lay 3 km behind
  })
})

describe('the INS knob and the set switches', () => {
  const cases = /\n\tcase "ins":[^\n]*\n\tcase "heading\.set":[^\n]*\n\tcase "course\.set":[^\n]*\n/.exec(source)?.[0] ?? ''
  const press = (steps: string) => cockpit<unknown>(`const pit=(action,d)=>{ switch(action){ ${cases} } }; ${steps}`)
  it('turns the knob a position a click, clockwise from OFF to TEST and no further', () => {
    expect(cases).not.toBe('')
    expect(press('const seen=[]; for(let k=0;k<6;k++){ pit("ins",1); seen.push(nav.ins.knob); } for(let k=0;k<9;k++) pit("ins",-1); seen.push(nav.ins.knob); pit("ins",0); seen.push(nav.ins.knob); return seen;'))
      .toEqual(['ifa', 'gyro', 'gb', 'test', 'test', 'test', 'off', 'cv'])
  })
  it('moves the heading marker 5° a click, and the course line only with steering selected', () => {
    const s = press(`nav.heading=0; nav.steer=""; pit("heading.set",1); pit("heading.set",1); pit("heading.set",-1); const none=(pit("course.set",1), nav.course);
      nav.steer="tcn"; ddi_dirty=false; pit("course.set",-1); return { heading:nav.heading, none, course:nav.course, dirty:ddi_dirty };`) as { heading: number; none: unknown; course: number; dirty: boolean }
    expect(s.heading).toBeCloseTo(5 * D, 9); expect(s.none).toBeNull(); expect(s.course).toBeCloseTo(355 * D, 9)
    expect(s.dirty).toBe(true)
  })
  it('slews on a held key: a degree on the press, then 30° a second after 0.4 s', () => {
    const s = cockpit<number[]>(`nav.heading=0; sim_time=10; keys_down.add("heading.right"); nav_frame(0.1); const pressed=nav.heading; sim_time=10.2; nav_frame(0.1); const waiting=nav.heading;
      sim_time=10.5; nav_frame(0.1); const slewing=nav.heading; keys_down.clear(); sim_time=11; nav_frame(0.1); const released=nav.heading;
      keys_down.add("heading.left"); nav_frame(0.1); return [pressed,waiting,slewing,released,nav.heading].map(v=>Math.round(v/D2R*1000)/1000);`)
    expect(s).toEqual([1, 1, 4, 4, 3])
  })
  it('sets the course from its own keys, not the heading\'s', () => {
    const s = cockpit<{ course: number; heading: number }>('nav.heading=0; keys_down.add("course.right"); nav_frame(0.1); return { course:nav.course, heading:nav.heading };')
    expect(s.course).toBeCloseTo(1 * D, 9); expect(s.heading).toBe(0)
  })
  it('turns the knob\'s node 45° a position from OFF about its own axis, every other jet\'s standing at NAV', () => {
    const turn = /\n\tif\(g\.userData\.insknob\)\{[^\n]*\n[^\n]*\}\n/.exec(source)?.[0] ?? ''
    expect(turn).not.toBe('')
    const angle = (steps: string) => cockpit<number>(`const rest=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),0.4), g={ userData:{ insknob:{ object:{ quaternion:new THREE.Quaternion() }, rest } } }, other={};
      let st=ownship; ${steps} ${turn}
      const q=g.userData.insknob.object.quaternion, back=q.clone().multiply(rest.clone().invert()); return [2*Math.acos(Math.min(1,Math.abs(back.w)))/D2R, back.y/Math.sin(Math.acos(Math.min(1,Math.abs(back.w)))||1)*Math.sign(back.w||1)];`) as unknown as number[]
    expect(angle('nav.ins.knob="off";')[0]).toBeCloseTo(0, 6)
    const nav = angle('')
    expect(nav[0]).toBeCloseTo(135, 6); expect(nav[1]).toBeCloseTo(-1, 6) // about the parent's -y, before the node's own rotation
    expect(angle('nav.ins.knob="test";')[0]).toBeCloseTo(360 - 315, 6)
    expect(angle('nav.ins.knob="off"; st=other;')[0]).toBeCloseTo(135, 6)
  })
  it('holds the knob\'s clip at OFF, and takes clicks on the painted set switches at the AMPCD\'s upper corners', () => {
    expect(source).toMatch(/\n\t\tcase "insknob": f=0; break;/)
    expect(source).toMatch(/\{ action:"heading\.set", at:\[6\.163,0\.211,-0\.095\] \}, \{ action:"course\.set", at:\[6\.163,0\.209,0\.091\] \}/)
    expect(source).not.toMatch(/EFD_Switch/) // the model's own pair, an older panel's behind the shell, are not driven
  })
})

describe('the HSI\'s pushbuttons', () => {
  it('selects TACAN or waypoint steering, each deselecting the other and the course line', () => {
    const s = cockpit<unknown[]>(`const seen=[]; const note=()=>seen.push(nav.steer+"/"+(nav.course===null?"-":"c"));
      navigate.set(nav,"course",10); note(); hsi_press(11,"left"); note(); navigate.set(nav,"course",10); hsi_press(5,"left"); note(); hsi_press(5,"left"); note(); hsi_press(11,"left"); hsi_press(11,"left"); note(); return seen;`)
    expect(s).toEqual(['tcn/c', 'wypt/-', 'tcn/-', '/-', '/-'])
  })
  it('drops AUTO when waypoint steering is deselected', () => {
    expect(cockpit<boolean[]>(`nav.waypoints[5]=point(1,1); nav.waypoints[6]=point(2,2); navigate.insert(nav,5); navigate.insert(nav,6);
      const on=hsi_press(16,"left"), was=nav.auto; hsi_press(5,"left"); return [on, was, nav.auto, nav.steer==="tcn"];`)).toEqual([true, true, false, true])
  })
  it('steps the steer-to point, marks, designates, cycles the sequence and offers AUTO only with a sequence', () => {
    const s = cockpit<unknown[]>(`const r=[hsi_press(12,"left"), nav.current, hsi_press(13,"left"), hsi_press(13,"left"), nav.current, hsi_press(9,"left"), nav.mark, !!nav.marks[0],
      hsi_press(16,"left"), hsi_press(15,"left"), nav.lines, hsi_press(15,"left"), nav.sequence];
      nav.current=1; r.push(hsi_press(14,"left"), nav.designation.x, hsi_press(14,"left")); return r;`)
    expect(s).toEqual([true, 1, true, true, 59, true, 1, true, false, true, true, true, 1, true, -18500, false])
  })
  it('marks the position the suite keeps, not the true one', () => {
    expect(cockpit('nav.ins.error={ x:500, z:-200 }; hsi_press(9,"left"); return nav.marks[0];')).toMatchObject({ x: 500, z: -200 })
  })
  it('opens the sublevels, and UPDT only while updates are offered', () => {
    const s = cockpit<unknown[]>(`const r=[hsi_press(6,"left"), hsi_state.level, hsi_press(10,"left"), hsi_state.level, hsi_press(7,"left"), hsi_state.level, hsi_press(10,"left"), hsi_press(3,"left"), hsi_state.level, hsi_press(10,"left"),
      hsi_press(10,"left"), hsi_state.level, hsi_state.data, hsi_press(10,"left"), hsi_state.level];
      nav.source="ains"; r.push(hsi_press(7,"left"), hsi_state.level); return r;`)
    expect(s).toEqual([true, 'pos', true, '', true, 'updt', true, true, 'mode', true, true, 'data', 'wypt', true, '', false, ''])
  })
  it('shows the steer-to waypoint first on the DATA sublevel', () => {
    expect(cockpit('nav.current=7; hsi_press(10,"left"); return hsi_state.shown;')).toBe(7)
  })
  it('selects a position keeping source that has data and returns, and refuses one without', () => {
    const s = cockpit<unknown[]>(`hsi_press(6,"left"); const r=[hsi_press(5,"left"), hsi_state.level, nav.source, hsi_press(9,"left"), hsi_state.level, nav.source];
      hsi_press(6,"left"); r.push(hsi_press(8,"left"), nav.source); hsi_press(6,"left"); r.push(hsi_press(7,"left"), nav.source); hsi_press(6,"left"); r.push(hsi_press(6,"left"), nav.source, hsi_press(4,"left")); return r;`)
    expect(s).toEqual([false, 'pos', 'ins', true, '', 'gps', true, 'adc', true, 'tcn', true, 'ins', false])
  })
  it('keeps SCL off the sublevels whose top row it shares', () => {
    expect(cockpit<unknown[]>('const r=[hsi_press(8,"left"), hsi_state.scale]; hsi_press(6,"left"); hsi_press(8,"left"); r.push(hsi_state.scale, nav.source); return r;')).toEqual([true, 20, 20, 'adc'])
  })
  it('gives MAN and STD HDG their places during a carrier alignment, and holds AUTO off', () => {
    const s = cockpit<unknown[]>(`nav.waypoints[5]=point(1,1); nav.waypoints[6]=point(2,2); navigate.insert(nav,5); navigate.insert(nav,6);
      ownship.grounded=true; parking=true; nav.ins.knob="cv"; nav_frame(1);
      const r=[hsi_press(16,"left"), hsi_press(19,"left"), hsi_press(17,"left"), nav.ins.manual, ufc.func, hsi_press(17,"left"), nav.ins.manual, ufc.func];
      nav.ins.heading=true; r.push(hsi_press(19,"left"), nav.ins.stored); return r;`)
    expect(s).toEqual([false, false, true, true, 'cv', true, false, '', true, true])
  })
  it('loads the UFC\'s timer options with TIMEUFC outside an alignment', () => {
    expect(cockpit('hsi_press(17,"left"); return ufc.func;')).toBe('time')
  })
})

describe('the update sublevel', () => {
  it('finds the TACAN\'s error for ACPT or REJ, and returns to the HSI on either', () => {
    const s = cockpit<unknown[]>(`nav.bias=0; nav.ins.error={ x:3000, z:0 }; hsi_press(7,"left");
      const r=[hsi_press(6,"left"), Math.round(navigate.reading(nav).range), hsi_press(7,"left"), hsi_press(10,"left"), hsi_state.level, nav.ins.error.x];
      hsi_press(7,"left"); hsi_press(6,"left"); r.push(hsi_press(6,"left"), hsi_state.level, Math.round(nav.ins.error.x), !!nav.previous);
      hsi_press(7,"left"); r.push(hsi_press(3,"left"), nav.ins.error.x, hsi_press(3,"left")); return r;`)
    expect(s).toEqual([true, 3000, false, true, '', 3000, true, '', 0, true, true, 3000, false])
  })
  it('takes a GPS update from the left, and refuses the TACAN\'s without a fix', () => {
    expect(cockpit<unknown[]>('radios.tacan.on=false; hsi_press(7,"left"); return [hsi_press(6,"left"), hsi_press(4,"left"), nav.update.kind];')).toEqual([false, true, 'gps'])
  })
  it('boxes DSG and AUTO, AUTO taking the other options away', () => {
    const s = cockpit<unknown[]>(`hsi_press(7,"left"); const r=[hsi_press(7,"left"), nav.updating, hsi_press(7,"left"), nav.updating, hsi_press(8,"left"), nav.updating, hsi_press(6,"left"), hsi_press(7,"left"), hsi_press(8,"left"), nav.updating];
      hsi_press(8,"left"); r.push(hsi_press(10,"left"), nav.updating, hsi_state.level); return r;`)
    expect(s).toEqual([true, 'dsg', true, '', true, 'auto', false, false, true, '', true, '', ''])
  })
  it('offers MAP only on the display with the map and with a target designated, and takes the TDC there', () => {
    const s = cockpit<unknown[]>(`hsi_press(7,"left"); designator="right"; const r=[hsi_press(9,"center")]; nav.current=1; navigate.designate(nav);
      r.push(hsi_press(9,"left"), hsi_press(9,"center"), nav.updating, designator, nav.update.kind); return r;`)
    expect(s).toEqual([false, false, true, 'map', 'center', 'map'])
    expect(cockpit('hsi_state.map=false; nav.current=1; navigate.designate(nav); hsi_press(7,"center"); return hsi_press(9,"center");')).toBe(false)
  })
})

describe('the TDC on the HSI', () => {
  it('designates the point overflown, from the position the suite keeps', () => {
    const s = cockpit<{ designation: navigate.Designation; dirty: boolean }>('nav.current=1; nav.ins.error={ x:100, z:50 }; ddi_dirty=false; hsi_designate(); return { designation:nav.designation, dirty:ddi_dirty };')
    expect(s.designation).toMatchObject({ x: 100, z: 50, stage: 'tgt' }); expect(s.dirty).toBe(true)
  })
  it('adds an offset aimpoint\'s offset once NAVDSG has designated it', () => {
    expect(cockpit(`nav.waypoints[4]=point(1000,2000,{ offset:{ range:500, bearing:Math.PI/2, elevation:9 } }); nav.current=4; navigate.designate(nav); hsi_designate(); return nav.designation;`))
      .toMatchObject({ x: 1500, z: 2000, elevation: 9, stage: 'tgt' })
  })
  it('gives a designation update the waypoint overflown for the aircraft\'s position, with DSG boxed', () => {
    const s = cockpit<{ kind: string; range: number; plain: unknown }>(`nav.waypoints[4]=point(0,0); nav.current=4; nav.ins.error={ x:300, z:400 }; hsi_designate(); const plain=nav.update;
      navigate.undesignate(nav); nav.updating="dsg"; hsi_designate(); return { kind:nav.update.kind, range:navigate.reading(nav).range, plain };`)
    expect(s.plain).toBeNull(); expect(s.kind).toBe('dsg'); expect(s.range).toBeCloseTo(500, 6)
  })
  it('makes an AUTO update over the waypoint and returns the HSI', () => {
    const s = cockpit<unknown[]>(`nav.waypoints[4]=point(0,0); nav.waypoints[5]=point(9,9); nav.current=4; nav.ins.error={ x:300, z:400 }; hsi_press(7,"center"); hsi_press(8,"center"); hsi_designate();
      return [Math.round(Math.hypot(nav.ins.error.x,nav.ins.error.z)), nav.current, hsi_state.level, nav.designation];`)
    expect(s).toEqual([0, 5, '', null])
  })
  it('is the display\'s only when the TDC is assigned to one showing the HSI', () => {
    expect(cockpit<boolean[]>('const a=tdc_hsi(); designator="right"; const b=tdc_hsi(); designator="center"; ddi_state.center.menu="supt"; return [a,b,tdc_hsi()];')).toEqual([true, false, false])
  })
  it('slews the map for a MAP update, turned as the display is, a full deflection crossing the scale in two seconds', () => {
    const s = cockpit<{ none: navigate.Fix; up: navigate.Fix; right: navigate.Fix; north: navigate.Fix; delta: navigate.Fix }>(`hsi_slew(0,1,1); const none={ ...nav.slew };
      nav.current=1; navigate.designate(nav); nav.updating="map"; ownship.gauges.track=Math.PI/2;
      hsi_slew(0,1,1); const up={ ...nav.slew }; nav.slew={ x:0, z:0 }; hsi_slew(1,0,0.5); const right={ ...nav.slew }; const delta={ ...nav.update.delta };
      nav.slew={ x:0, z:0 }; hsi_state.north=true; hsi_slew(0,1,1); return { none, up, right, north:{ ...nav.slew }, delta };`)
    const half = 40 * NM / 2
    expect(s.none).toEqual({ x: 0, z: 0 })
    expect(s.up.x).toBeCloseTo(half, 6); expect(s.up.z).toBeCloseTo(0, 6) // track east: up the display is east
    expect(s.right.x).toBeCloseTo(0, 6); expect(s.right.z).toBeCloseTo(half / 2, 6) // and right of it south
    expect(s.delta.z).toBeCloseTo(half / 2, 6)
    expect(s.north.x).toBeCloseTo(0, 6); expect(s.north.z).toBeCloseTo(-half, 6)
  })
  it('lets the undesignate button drop a navigation designation first in NAV, and work the radar otherwise', () => {
    expect(cockpit<unknown[]>(`nav.current=1; navigate.designate(nav); undesignate_press(); const first=[!!nav.designation, radar_calls]; undesignate_press();
      navigate.designate(nav); master="9m"; undesignate_press(); return [...first, radar_calls, !!nav.designation];`)).toEqual([false, 0, 2, true])
  })
})

describe('the DATA sublevels\' pushbuttons', () => {
  const data = (steps: string) => cockpit<unknown[]>(`hsi_press(10,"left"); const p=(pb)=>hsi_press(pb,"left"); ${steps}`)
  it('switches between A/C, WYPT and TCN, puts NAVCK over them, and returns to the HSI', () => {
    expect(data('return [p(6), hsi_state.data, p(8), hsi_state.data, p(11), hsi_state.check, p(5), p(7), hsi_state.check, hsi_state.data, p(11), p(10), hsi_state.level, hsi_state.check];'))
      .toEqual([true, 'ac', true, 'tcn', true, true, false, true, false, 'wypt', true, true, '', false])
  })
  it('steps the waypoint shown round the waypoints and marks, apart from the steer-to point', () => {
    expect(data('const r=[p(13), hsi_state.shown, p(12), p(12), hsi_state.shown, nav.current]; return r;')).toEqual([true, 68, true, true, 1, 0])
  })
  it('gives the UFC the waypoint and sequence options, and steps the sequence to program', () => {
    expect(data('const r=[p(5), ufc.func, p(1), ufc.func, p(1), ufc.func, p(15), nav.sequence, nav.lines, p(15), p(15), nav.sequence, p(3)&&hsi_state.data]; return r;'))
      .toEqual([true, 'wypt', true, 'seq', true, '', true, 1, false, true, true, 0, 'gps'])
  })
  it('makes the waypoint shown the air-to-air waypoint with A/A WP, and takes it off with a second press (figure 24-9 sheet 3)', () => {
    expect(data('const r=[hsi_state.air, p(2), hsi_state.air, p(12), p(2), hsi_state.air, p(2), hsi_state.air]; return r;')).toEqual([null, true, 0, true, true, 1, true, null])
    expect(cockpit('hsi_state.air=3; nav_reset(); return hsi_state.air;')).toBeNull() // a new flight has none
  })
  it('works the A/C options: the UFC, NOSEC GPS restarting acquisition, the flight phase, the heading reference and the lat/long format', () => {
    expect(data(`p(6); const r=[p(5), ufc.func, p(2), nav.gps.secure, nav.gps.search, p(2), nav.gps.secure, p(1), nav.gps.phase, p(1), nav.gps.phase, p(13), nav.magnetic, p(15), nav.decimal, p(12)]; return r;`))
      .toEqual([true, 'ac', true, false, navigate.ACQUIRE, true, true, true, 'appr', true, 'norm', true, true, true, true, false])
  })
  it('gives the UFC the ALT option for the barometric or the radar warning', () => {
    expect(data('p(6); const r=[p(20), ufc.func, ufc.kind, ufc.option, p(19), ufc.func, ufc.kind, p(19), ufc.func]; return r;')).toEqual([true, 'alt', 'baro', 0, true, 'alt', 'radar', true, ''])
  })
  it('steps the TACAN station shown through the stored ones and the next free place', () => {
    expect(data('p(8); const r=[p(5), ufc.func, p(12), nav.station, p(12), nav.station, p(13), nav.station]; return r;')).toEqual([true, 'station', true, 1, true, 0, true, 1])
  })
  it('moves the GPS display\'s cursor down and across, wrapping, and pages', () => {
    const s = data(`nav.points=Array.from({ length:60 },(_,k)=>({ name:"P"+String(k).padStart(2,"0"), x:k, z:k, elevation:0 })); sim_time=50;
      const r=[p(3), hsi_state.data, hsi_state.gps.cursor, hsi_state.gps.asked]; const at=()=>hsi_state.gps.cursor;
      sim_time=60; p(1); r.push(at(), hsi_state.gps.asked); for(let k=0;k<7;k++) p(1); r.push(at()); p(20); r.push(at()); p(20); r.push(at()); p(20); r.push(at()); p(16); r.push(at()); p(1); r.push(at()); p(20); r.push(at()); p(16); r.push(at()); p(17); r.push(at()); return r;`)
    expect(s).toEqual([true, 'gps', 0, 50, 1, 60, 0, 8, 16, 0, 24, 25, 33, 48, 24]) // a move asks for the point afresh; three pages of 24, 24 and 12
  })
  it('transfers the GPS point under the cursor into the waypoint shown once its data has come, and never into a mark', () => {
    const s = data(`sim_time=50; p(3); p(12); p(12); p(12); const early=p(5); sim_time=53; const done=p(5), into=nav.waypoints[3]; hsi_state.shown=60; return [early, done, into.name, into.x, p(5)];`)
    expect(s).toEqual([false, true, 'NIM', -18500, false])
  })
})

describe('the UFC\'s data entry', () => {
  const entry = (steps: string) => cockpit<unknown[]>(`hsi_press(10,"left"); const p=(pb)=>hsi_press(pb,"left"); ${steps}`)
  it('takes a waypoint\'s position as latitude then longitude, each led by its hemisphere, and its elevation in feet', () => {
    const s = entry(`p(12); p(12); p(12); p(5); keys("opt0","2","2","8","3","0","0","0"); const lettered=[ufc.letter, ufc.entry]; keys("ent"); const half=ufc.half;
      keys("4","1","7","7","0","0","0","0","ent"); const w=nav.waypoints[3], c=navigate.coordinates(w); keys("opt2","1","5","0","0","ent");
      return [lettered, Math.round(half*1000)/1000, Math.round(c.latitude*1000)/1000, Math.round(c.longitude*1000)/1000, Math.round(w.elevation*100)/100, ufc.error, ufc.half, ddi_dirty];`)
    expect(s).toEqual([['N', '283000'], 28.5, 28.5, -177, 457.2, false, null, true])
  })
  it('starts the next position at its latitude again once the longitude is in', () => {
    expect(entry('p(12); p(5); keys("opt0","2","2","8","0","0","0","0","ent","4","1","7","7","0","0","0","0","ent","2"); return [ufc.half, ufc.letter];')).toEqual([null, 'N'])
  })
  it('flags ERROR for a longitude where the latitude goes, a bad angle, or ENT with nothing keyed', () => {
    expect(entry('p(5); keys("opt0","6","1","0","0","0","0","0","ent"); return [ufc.error, ufc.letter, ufc.entry];')).toEqual([true, '', '']) // 6 is no latitude's letter: nothing is keyed until N or S leads
    expect(entry('p(5); keys("opt0","2","2","8","6","0","0","0","ent"); return [ufc.error];')).toEqual([true])
    expect(entry('p(5); keys("opt2","ent"); return [ufc.error];')).toEqual([true])
    expect(entry('p(5); keys("1","ent"); return [ufc.error];')).toEqual([true]) // no option selected
  })
  it('clears the entry and its letter first, then the page', () => {
    expect(entry('p(5); keys("opt0","2","1"); const a=[ufc.letter, ufc.entry]; keys("clr"); const b=[ufc.letter, ufc.entry, ufc.func]; keys("clr"); return [a, b, ufc.func, ufc.option];')).toEqual([['N', '1'], ['', '', 'wypt'], '', -1])
    expect(entry('p(5); keys("opt0","2","clr"); return [ufc.letter, ufc.func];')).toEqual(['', 'wypt']) // a letter alone is an entry to clear
  })
  it('opens the offset\'s options from O/S, and takes its range, bearing and elevation', () => {
    const s = entry(`p(12); p(5); keys("opt4"); const page=ufc.func; keys("opt0","6","5","0","0","0","ent","opt1","0","3","0","1","5","0","0","ent","opt2","1","2","5","0","ent");
      const o=nav.waypoints[1].offset; keys("opt0","4","0","0","0","0","1","ent"); return [page, Math.round(o.range), Math.round(o.bearing/D2R*1000)/1000, Math.round(o.elevation), ufc.error];`)
    expect(s).toEqual(['offset', 19812, 30.25, 381, true]) // past 400,000 ft is refused
  })
  it('programs a sequence: INS at the end or behind a waypoint already in it, DEL, the target, the time on target and the groundspeed', () => {
    const s = entry(`p(1); keys("opt3","1","ent","2","ent","7","ent","1","ent","4","ent"); const built=[...nav.sequences[0]]; keys("opt4","2","ent"); const cut=[...nav.sequences[0]];
      keys("opt1","7","ent"); const set=nav.target; keys("7","ent"); const again=nav.target; keys("7","ent","9","ent"); const cleared=[ufc.error, nav.target]; keys("7","ent","opt2","1","3","4","5","3","0","ent","opt0","1","2","0","0","ent");
      keys("opt2","2","5","0","0","0","0","ent"); return [built, cut, [set, again], cleared, nav.target, nav.tot, nav.speed, ufc.error];`)
    expect(s).toEqual([[1, 4, 2, 7], [1, 4, 7], [7, null], [false, null], 7, 13 * 3600 + 45 * 60 + 30, 999, true]) // the target entered again, or one in no sequence, clears it
  })
  it('takes the aircraft\'s position, wind and magnetic variation on the A/C page', () => {
    const s = entry(`p(6); p(5); keys("opt0","2","2","8","0","0","0","0","ent","4","1","7","7","3","0","0","0","ent"); const here=navigate.coordinates(navigate.place(nav,nav_sense(0)));
      keys("opt2","2","0","ent","opt3","9","0","ent"); const wind={ ...nav.adc.wind }; keys("opt4","4","1","0","3","0","ent"); const west=nav.variation; keys("opt4","6","5","ent");
      return [Math.round(here.latitude*1e4)/1e4, Math.round(here.longitude*1e4)/1e4, Math.round(wind.x*100)/100, Math.round(wind.z*100)/100, Math.round(west/D2R*1000)/1000, Math.round(nav.variation/D2R*1000)/1000];`)
    expect(s).toEqual([28, -177.5, -10.29, 0, -10.5, 0.083]) // 20 kt from the east; W 10°30'; E 0°05'
  })
  it('sets the low altitude warnings: to 25,000 ft barometric, the radar\'s held to 5,000', () => {
    expect(entry('p(6); p(20); keys("3","0","0","0","0","ent"); const high=[ufc.error, altitude_set.baro]; keys("clr","8","0","0","0","ent"); p(19); keys("9","0","0","0","ent"); return [high, altitude_set.baro, altitude_set.radar, altitude_armed.baro, altitude_armed.radar];'))
      .toEqual([[true, 5000], 8000, 5000, false, false])
  })
  it('programs a TACAN station: its channel and band, position, elevation and variation', () => {
    const s = entry(`p(8); p(12); p(5); keys("opt1","1","1","8","ent","opt2","2","3","8","2","5","0","6","ent","4","1","1","2","3","0","3","0","ent","opt3","1","5","0","0","ent","opt4","6","1","8","3","7","ent");
      const st=nav.stations[1], c=navigate.coordinates(st); keys("opt0","2","0","0","ent"); return [st.channel, st.band, Math.round(c.latitude*1e4)/1e4, Math.round(c.longitude*1e4)/1e4, Math.round(st.elevation*10)/10, Math.round(st.variation/D2R*1000)/1000, ufc.error];`)
    expect(s).toEqual([118, 'Y', 38.4183, -112.5083, 457.2, 18.617, true])
  })
  it('gives a manual carrier alignment the ship\'s heading and speed', () => {
    const s = cockpit<unknown[]>(`ownship.grounded=true; parking=true; nav.ins.knob="cv"; nav_frame(1); hsi_press(17,"left"); keys("opt2","9","0","ent","opt3","1","2","ent");
      return [Math.round(carrier_given.heading/D2R), carrier_given.speed, Math.round(nav.ins.motion.x*1000)/1000, Math.round(nav.ins.motion.z*1000)/1000+0, ufc.error];`)
    expect(s).toEqual([90, 12, 6.173, 0, false])
  })
})

describe('the UFC\'s units pages', () => {
  const entry = (steps: string) => cockpit<unknown[]>(`hsi_press(10,"left"); const p=(pb)=>hsi_press(pb,"left"); ${steps}`)
  it('takes an elevation on its units page, in feet or metres, and returns to the page it came from', () => {
    const s = entry(`p(12); p(5); keys("opt2"); const page=[ufc.func, ufc.back, ufc.unit, ufc.option]; keys("opt1","5","0","0","ent");
      return [page, nav.waypoints[1].elevation, ufc.func, ufc.back, nav.units.waypoint, nav.units.offset, nav.units.station];`)
    expect(s).toEqual([['elevation', 'wypt', 'waypoint', -1], 500, 'wypt', '', 'mtrs', 'feet', 'feet']) // each elevation keeps its own unit
  })
  it('takes an offset\'s range in feet, metres, nautical miles or yards, each inside its limit', () => {
    const s = entry(`p(12); p(5); keys("opt4","opt0"); const page=[ufc.func, ufc.back, ufc.unit]; keys("opt2","1","0","ent"); const miles=nav.waypoints[1].offset.range;
      keys("opt0","6","7","ent"); const far=[ufc.error, ufc.func, nav.waypoints[1].offset.range]; keys("clr","opt3","1","0","0","0","ent"); const yards=nav.waypoints[1].offset.range;
      keys("opt0","opt1","1","2","2","0","0","1","ent"); return [page, miles, far, Math.round(yards*10)/10, ufc.error, nav.units.range];`)
    expect(s).toEqual([['range', 'offset', 'range'], 18520, [true, 'range', 18520], 914.4, true, 'mtrs']) // 67 nm and 122,001 m are past the limit
  })
  it('takes an offset\'s elevation in its own unit, apart from the waypoint\'s', () => {
    expect(entry('p(12); p(5); keys("opt4","opt2"); const page=[ufc.func, ufc.back, ufc.unit]; keys("opt1","2","0","0","ent"); return [page, nav.waypoints[1].offset.elevation, nav.units.offset, nav.units.waypoint, ufc.func];'))
      .toEqual([['elevation', 'offset', 'offset'], 200, 'mtrs', 'feet', 'offset'])
  })
  it('takes an offset\'s bearing true or magnetic, the option changing the meridian', () => {
    const s = entry(`p(12); p(5); keys("opt4","opt1"); const page=[ufc.func, ufc.back, nav.meridian]; keys("0","9","0","ent"); const truly=nav.waypoints[1].offset.bearing/D2R;
      keys("opt1","opt0"); const meridian=nav.meridian; keys("0","9","0","ent"); const magnetic=nav.waypoints[1].offset.bearing/D2R; keys("opt1","opt0"); return [page, Math.round(truly*1e6)/1e6, meridian, Math.round(magnetic*1e6)/1e6, nav.meridian];`)
    expect(s).toEqual([['bearing', 'offset', 'true'], 90, 'magnetic', 97, 'true']) // 090 magnetic with 7° E variation
  })
  it('takes a TACAN station\'s elevation in its own unit', () => {
    expect(entry('p(8); p(5); keys("opt3"); const page=[ufc.func, ufc.back, ufc.unit]; keys("opt1","1","0","0","ent"); return [page, nav.stations[0].elevation, nav.units.station, nav.units.waypoint, ufc.func];'))
      .toEqual([['elevation', 'station', 'station'], 100, 'mtrs', 'feet', 'station'])
  })
  it('goes back from a units page with CLR, the entry first, and flags ERROR on ENT with nothing keyed', () => {
    expect(entry('p(5); keys("opt2","5","clr"); const a=[ufc.func, ufc.entry]; keys("ent"); const b=ufc.error; keys("clr","clr"); const c=[ufc.func, ufc.back]; keys("clr"); return [a, b, c, ufc.func];'))
      .toEqual([['elevation', ''], true, ['wypt', ''], ''])
  })
  it('leaves the units alone on a blank option', () => {
    expect(entry('p(5); keys("opt2","opt3"); return [nav.units.waypoint, ufc.func];')).toEqual(['feet', 'elevation'])
  })
})

describe('grid coordinates through the UFC and the grid display', () => {
  const entry = (steps: string) => cockpit<unknown[]>(`designator="right"; hsi_press(10,"left"); const p=(pb)=>hsi_press(pb,"left"), grid=(w)=>{ const c=navigate.coordinates(w); return navigate.grid(c.latitude,c.longitude,nav.precise); }; ${steps}`)
  it('puts the grid on the right DDI with GRID, and takes it off when the UFC leaves the option', () => {
    const s = entry(`p(5); keys("opt3"); const up=[ddi_state.right.page, grid_state.prior, ufc.option]; ddi_state.right.menu="tac"; grid_state.shift={ east:1, north:0 }; grid_state.chosen={ zone:1, band:"R", id:"DM" }; grid_state.cursor={ x:1, y:1 }; keys("opt3");
      const again=[ddi_state.right.menu, grid_state.prior, grid_state.shift.east, grid_state.chosen, grid_state.cursor.x]; keys("opt0"); const off=ddi_state.right.page; keys("opt3","wypt"); return [up, again, off, ddi_state.right.page, ufc.func];`)
    expect(s).toEqual([['grid', 'rdr', 3], ['', 'rdr', 0, null, 256], 'rdr', 'rdr', '']) // GRID again builds the grid about the reference once more
  })
  it('picks the square under the cursor with the TDC, and takes the easting and northing keyed in it', () => {
    const s = entry(`p(12); p(5); keys("opt3","6","3","4","3","8","6","ent"); const none=ufc.error; keys("clr"); grid_state.cursor={ x:256, y:256 }; grid_designate(); const chosen={ ...grid_state.chosen };
      keys("6","3","4","3","8","6","1"); const keyed=ufc.entry; keys("ent"); return [none, chosen, keyed, grid(nav.waypoints[1]), ufc.error, ddi_state.right.page];`)
    expect(s).toEqual([true, { zone: 1, band: 'R', id: 'DM' }, '634386', '1RDM634386', false, 'grid']) // no square chosen: ERROR; six digits and no more
  })
  it('flags ERROR for ENT with no easting and northing keyed', () => {
    expect(entry('p(12); const before={ ...nav.waypoints[1] }; p(5); keys("opt3"); grid_face(256,256); keys("ent"); return [ufc.error, nav.waypoints[1].x===before.x];')).toEqual([true, true])
  })
  it('takes ten digits with PRECISE, to a metre, and the leading zeros need not be keyed', () => {
    const s = entry(`p(12); p(19); p(5); keys("opt3"); grid_face(256,256); keys("6","3","4","0","3","3","8","6","4","2","9"); const keyed=ufc.entry; keys("ent"); const precise=grid(nav.waypoints[1]);
      keys("5","0","0","0","0","7","ent"); return [nav.precise, keyed, precise, grid(nav.waypoints[1])];`)
    expect(s).toEqual([true, '6340338642', '1RDM6340338642', '1RDM0000500007'])
  })
  it('turns an offset\'s grid into a range and bearing from its aimpoint, and holds one past 400,000 ft off, flashing', () => {
    const s = entry(`p(12); nav.waypoints[1]={ x:0, z:-18520, elevation:0, name:"", offset:null }; p(5); keys("opt4","opt3"); const up=[ufc.func, ddi_state.right.page]; grid_face(256,256); keys("7","3","3","5","5","6","ent");
      const o={ ...nav.waypoints[1].offset }; grid_face(76+4.5*72,256); const east=grid_state.chosen.id; keys("0","ent"); return [up, Math.abs(o.range-19812)<150, Math.abs(o.bearing/D2R-30)<0.5, o.elevation, east, nav.waypoints[1].offset.range===o.range, grid_state.far, ufc.error];`)
    expect(s).toEqual([['offset', 'grid'], true, true, 0, 'FM', true, { shown: 1, text: '1RFM000000' }, false])
  })
  it('keeps the offset\'s elevation when its grid is keyed', () => {
    expect(entry('p(12); nav.waypoints[1]={ x:0, z:-18520, elevation:0, name:"", offset:{ range:5, bearing:1, elevation:100 } }; p(5); keys("opt4","opt3"); grid_face(256,256); keys("7","3","3","5","5","6","ent"); const o=nav.waypoints[1].offset; return [o.elevation, o.range>19000];')).toEqual([100, true])
  })
  it('clears the offset held off when one inside the limit is keyed', () => {
    expect(entry('p(12); p(5); keys("opt4","opt3"); grid_face(76+4.5*72,256); keys("0","ent"); const off=!!grid_state.far; grid_face(256,256); keys("7","3","3","5","5","6","ent"); return [off, grid_state.far];')).toEqual([true, null])
  })
  it('shifts the grid a whole grid from the pushbuttons or under the cursor, only while the reference is in the centre square', () => {
    const s = entry(`p(5); keys("opt3"); const all=grid_shifts().sort((a,b)=>a-b); grid_state.chosen={ zone:1, band:"R", id:"DM" }; const north=[grid_press(8), { ...grid_state.shift }, grid_state.chosen, grid_shifts(), grid_press(13)];
      keys("opt3"); grid_state.cursor={ x:20, y:416 }; const under=[grid_designate(), { ...grid_state.shift }]; return [all, north, under, grid_press(2)];`)
    expect(s).toEqual([[1, 3, 5, 8, 11, 13, 15, 18], [true, { east: 0, north: 1 }, null, [], false], [true, { east: -1, north: -1 }], false])
  })
  it('offers no shift to a grid that does not exist', () => {
    expect(entry('nav.waypoints[1]=navigate.world(83.5,-177.3735); nav.waypoints[1].offset=null; p(12); p(14); p(5); keys("opt3"); return [grid_state.waypoint, grid_shifts().sort((a,b)=>a-b)];')).toEqual([true, [1, 3, 5, 11, 13, 15, 18]]) // nothing due north: every row there is past N84
  })
  it('builds the grid about the waypoint shown with REF WP, and about the aircraft without', () => {
    const s = entry(`nav.waypoints[1]={ x:200000, z:0, elevation:0, name:"", offset:null }; p(12); p(5); keys("opt3"); grid_face(256,256); const own=grid_state.chosen.id; grid_state.shift={ east:1, north:0 };
      const on=[p(14), grid_state.waypoint, grid_state.shift.east, grid_state.chosen]; grid_face(256,256); const about=grid_state.chosen.id; return [own, on, about, p(14), grid_state.waypoint];`)
    expect(s).toEqual(['DM', [true, true, 0, null], 'FM', true, false])
  })
  it('moves the cursor with the TDC, a full deflection crossing half the display in a second, and keeps it on the display', () => {
    expect(entry('grid_slew(1,0,0.5); grid_slew(0,1,0.25); const a={ ...grid_state.cursor }; grid_slew(1,-1,5); return [a, grid_state.cursor, ddi_dirty];')).toEqual([{ x: 384, y: 192 }, { x: 504, y: 504 }, true])
  })
  it('gives the TDC to the grid only on the display it is assigned to, out of the menu', () => {
    expect(entry('p(5); keys("opt3"); const on=tdc_grid(); ddi_state.right.menu="tac"; const menu=tdc_grid(); ddi_state.right.menu=""; designator="left"; return [on, menu, tdc_grid()];')).toEqual([true, false, false])
  })
  it('picks nothing on a blank square or off the grid', () => {
    expect(entry('nav.waypoints[1]=navigate.world(83.5,-177.3735); nav.waypoints[1].offset=null; p(12); p(14); p(5); keys("opt3"); return [grid_face(256,76+0.5*72), grid_state.chosen, grid_face(60,256), grid_face(256,256), grid_state.chosen.band];')).toEqual([false, null, false, true, 'X'])
  })
  it('puts the grid\'s S shift where MENU is on every other display', () => {
    const s = entry(`${lift('ddi_press')} const DDI_MENUS={ tac:[], supt:[] }, DDI_PAGES={ grid:{ press:grid_press }, rdr:{} }, ddi_show=()=>{}, caution_page=()=>null, avionics={ standby:()=>false, offered:()=>true }, display_test={ on:false };
      const menu=[ddi_press("right",18), ddi_state.right.menu]; ddi_press("right",18); ddi_state.right.menu=""; p(5); keys("opt3"); const south=[ddi_press("right",18), ddi_state.right.menu, grid_state.shift.north];
      ddi_state.right.menu="tac"; ddi_press("right",18); return [menu, south, ddi_state.right.menu];`)
    expect(s).toEqual([[true, 'tac'], [true, '', -1], 'supt'])
  })
})

describe('precise waypoint entry', () => {
  const entry = (steps: string) => cockpit<unknown[]>(`hsi_press(10,"left"); const p=(pb)=>hsi_press(pb,"left"); ${steps}`)
  it('boxes PRECISE from the waypoint data, and offers HDTH only then', () => {
    expect(entry('p(5); keys("opt0","2","2"); keys("opt1"); const without=[ufc.option, ufc.entry]; ufc_dirty=false; const r=[p(19), nav.precise, ufc_dirty]; keys("opt1"); return [without, r, ufc.option, p(19), nav.precise];'))
      .toEqual([[0, '2'], [true, true, true], 1, true, false])
  })
  it('adds the hundredths of a second to the latitude keyed, then to the longitude', () => {
    const s = entry(`p(12); p(19); p(5); keys("opt0","2","2","8","2","2","2","5","ent","opt1","5","0","ent"); const half=ufc.half, back=ufc.option;
      keys("4","1","7","7","2","2","2","4","ent","opt1","2","5","ent"); const c=navigate.coordinates(nav.waypoints[1]); return [Math.round(half*3600*100), back, Math.round(c.latitude*3600*100), Math.round(c.longitude*3600*100), ufc.error];`)
    expect(s).toEqual([(28 * 3600 + 22 * 60 + 25) * 100 + 50, 0, (28 * 3600 + 22 * 60 + 25) * 100 + 50, -((177 * 3600 + 22 * 60 + 24) * 100 + 25), false])
  })
  it('replaces hundredths keyed before, on the latitude and on the longitude', () => {
    const s = entry(`p(12); p(19); p(5); keys("opt0","2","2","8","2","2","2","5","ent","opt1","5","0","ent","opt1","2","5","ent"); const half=ufc.half;
      keys("4","1","7","7","2","2","2","4","ent","opt1","2","5","ent","opt1","7","5","ent"); const c=navigate.coordinates(nav.waypoints[1]); return [Math.round(half*3600*100), Math.round(c.latitude*3600*100), Math.round(c.longitude*3600*100)];`)
    expect(s).toEqual([(28 * 3600 + 22 * 60 + 25) * 100 + 25, (28 * 3600 + 22 * 60 + 25) * 100 + 25, -((177 * 3600 + 22 * 60 + 24) * 100 + 75)])
  })
  it('adds them away from the equator in the south', () => {
    expect(entry('p(12); p(19); p(5); keys("opt0","8","1","0","0","0","0","0","ent","opt1","5","0","ent"); return [Math.round(ufc.half*3600*100)];')).toEqual([-(10 * 3600 * 100 + 50)])
  })
  it('takes no hundredths once PRECISE is unboxed', () => {
    expect(entry('p(12); p(19); p(5); keys("opt0","2","2","8","0","0","0","0","ent","opt1"); p(19); keys("5","0","ent"); return [ufc.error, ufc.half];')).toEqual([true, 28])
  })
  it('flags ERROR for hundredths past 99, with nothing keyed, or with no position keyed first', () => {
    expect(entry('p(19); p(5); keys("opt0","2","2","8","0","0","0","0","ent","opt1","1","0","0","ent"); const a=ufc.error; keys("clr","ent"); return [a, ufc.error];')).toEqual([true, true])
    expect(entry('p(19); p(5); keys("opt1","5","ent"); return [ufc.error];')).toEqual([true])
  })
})

describe('entering a waypoint by slewing the map', () => {
  const slew = (steps: string) => cockpit<unknown[]>(`designator="right"; hsi_state.map=false; hsi_press(10,"center"); const p=(pb)=>hsi_press(pb,"center"); p(12); nav.waypoints[1]={ x:1000, z:2000, elevation:0, name:"", offset:null }; ${steps}`)
  it('boxes SLEW, giving the TDC to that display and boxing MAP, and unboxes it on leaving the waypoint data', () => {
    expect(slew('const on=[p(4), hsi_state.slew, designator, hsi_state.map]; p(4); const off=hsi_state.slew; p(4); p(6); const tab=hsi_state.slew; p(7); p(4); p(11); const check=hsi_state.slew; p(11); p(4); p(3); const gps=hsi_state.slew; p(7); p(4); p(10); return [on, off, tab, check, gps, hsi_state.slew];'))
      .toEqual([[true, true, 'center', true], false, false, false, false, false])
  })
  it('moves the waypoint the other way as the map slews under its symbol, at the scale\'s rate', () => {
    const s = slew('designator="center"; hsi_slew(1,0,1); const idle={ ...nav.waypoints[1] }; p(4); hsi_slew(1,0,1); const east=nav.waypoints[1].x; hsi_slew(0,1,0.5); return [idle.x, east, nav.waypoints[1].z, ddi_dirty];')
    expect(s).toEqual([1000, 1000 - 20 * NM, 2000 + 10 * NM, true]) // 40 nm scale: 20 nm a second
  })
  it('turns with the map: track up, the slew follows the track', () => {
    const s = slew('ownship.gauges.track=Math.PI/2; p(4); hsi_slew(0,1,1); return [Math.round(nav.waypoints[1].x), Math.round(nav.waypoints[1].z)];')
    expect(s).toEqual([1000 - 20 * NM, 2000]) // up the display is east: the map goes east, the waypoint west
  })
  it('starts a waypoint never stored from where the aircraft is', () => {
    const s = slew('ownship.pos.x=5000; ownship.pos.z=3000; p(12); p(12); p(4); hsi_slew(0,-1,0.5); const w=nav.waypoints[3]; return [Math.round(w.x), Math.round(w.z), hsi_state.shown];')
    expect(s).toEqual([5000, 3000 - 10 * NM, 3])
  })
  it('leaves a MAP update\'s slew alone while it enters a waypoint', () => {
    expect(slew('p(4); hsi_slew(1,1,1); return [nav.slew.x, nav.slew.z, nav.waypoints[1].x!==1000];')).toEqual([0, 0, true])
  })
  it('slews nothing with the TDC on another display', () => {
    expect(slew('p(4); designator="right"; hsi_slew(1,0,1); return [nav.waypoints[1].x];')).toEqual([1000])
  })
})

describe('the TACAN data\'s magnetic variation option', () => {
  it('changes between the aircraft\'s variation and the station\'s for the TACAN readouts', () => {
    const s = cockpit<unknown[]>(`hsi_press(10,"left"); hsi_press(8,"left"); nav.stations[0].variation=10*D2R; const own=tacan_variation()/D2R; const r=[hsi_press(1,"left"), nav.local]; const local=tacan_variation()/D2R;
      radios.tacan.channel=12; const other=tacan_variation()/D2R; radios.tacan.channel=74; delete nav.stations[0].variation; const none=tacan_variation()/D2R; hsi_press(1,"left"); return [own, r, local, other, none, nav.local].map(v=>typeof v==="number"?Math.round(v*1e6)/1e6:v);`)
    expect(s).toEqual([7, [true, true], 10, 7, 7, false]) // a station not stored, or stored without one, leaves the aircraft's
  })
})

describe('the MUMI display\'s options', () => {
  it('reads a file again, the waypoint and TACAN ones only on the wheels', () => {
    const s = cockpit<unknown[]>(`nav.waypoints[1]=point(1,1); nav.points=[]; sim_time=30; const air=mumi_press(5), kept=nav.waypoints[1].x, gps=mumi_press(20), points=nav.points.length, read=[mumi.file, mumi.at], still=nav.waypoints[1].x;
      ownship.grounded=true; return [air, kept, gps, points, read, still, mumi_press(5), nav.waypoints[1].x, mumi.file, mumi_press(9)];`)
    expect(s).toEqual([false, 1, true, 2, ['GPS WYPT', 30], 1, true, -18500, 'WYPT', false]) // the GPS points' file leaves the waypoints alone
  })
  it('offers nothing for a file the memory unit does not hold', () => {
    expect(cockpit('ownship.grounded=true; nav.memory.files=["TCN"]; return [mumi_press(5), mumi_press(4)];')).toEqual([false, true])
  })
})

describe('the steering the HUD shows', () => {
  it('follows the HSI: the TACAN\'s slant range and ident, a waypoint, a mark, an offset aimpoint or the target', () => {
    const s = cockpit<{ label: string; range: number; bearing: number; target: boolean; course: number | null }[]>(`const seen=[]; const note=()=>{ const v=hud_steer(); seen.push(v&&{ label:v.label, range:v.range, bearing:v.bearing, target:v.target, course:v.course }); };
      note(); nav.steer="wypt"; nav.current=1; note(); nav.waypoints[4]=point(0,-9260,{ offset:{ range:1, bearing:0, elevation:0 } }); nav.current=4; navigate.set(nav,"course",20); note();
      nav.marks[0]=point(9260,0); nav.current=60; note(); nav.current=4; navigate.designate(nav); navigate.designate(nav); note(); nav.steer=""; note(); navigate.undesignate(nav); note(); return seen;`)
    expect(s[0]).toMatchObject({ label: 'NIM', target: false, course: null }); expect(s[0].range).toBeCloseTo(Math.hypot(18500, 7500, 3000), 6)
    expect(s[1]).toMatchObject({ label: 'W1', target: false }); expect(s[1].range).toBeCloseTo(Math.hypot(18500, 7500), 0)
    expect(s[2]).toMatchObject({ label: 'O4' }); expect(s[2].course).toBeCloseTo(20 * D, 9)
    expect(s[3]).toMatchObject({ label: 'M1' }); expect(s[3].bearing).toBeCloseTo(90 * D, 4)
    expect(s[4]).toMatchObject({ label: 'TGT', target: true })
    expect(s[5]).toMatchObject({ label: 'TGT' }) // a designated target is steered to whatever is boxed
    expect(s[6]).toBeNull()
  })
  it('steers from the position the suite keeps, so an INS that has drifted leads astray', () => {
    const s = cockpit<number[]>('nav.steer="wypt"; nav.waypoints[4]=point(0,-10000); nav.current=4; const true_=hud_steer().bearing; nav.ins.error={ x:1000, z:0 }; return [true_, hud_steer().bearing];')
    expect(Math.sin(s[0])).toBeCloseTo(0, 4); expect(Math.cos(s[0])).toBeCloseTo(1, 4) // north, give or take the spawn frame's drift
    expect(s[1]).toBeCloseTo(2 * Math.PI - Math.atan2(1000, 10000), 9)
  })
  it('has no TACAN steering without the station, and no course line without its range', () => {
    expect(cockpit('radios.tacan.on=false; return hud_steer();')).toBeNull()
    expect(cockpit('navigate.set(nav,"course",20); radios.tacan.mode="rcv"; return hud_steer().course;')).toBeNull()
  })

  const arrow = /\n\t\/\/ ---- the course line's steering arrow[\s\S]*?(?=\n\n\t\/\/ ---- E bracket)/.exec(source)?.[0] ?? ''
  const drawn = (steer: string, master = 'nav', declutter = 0) => new Function('navigate', 'THREE', `const D2R=Math.PI/180, GR='g', hs=1, sim_time=0, master=${JSON.stringify(master)}, declutter=${declutter}, fpm=[400,300], ownship={ gauges:{ track:0, heading:0 } };
    const hud_steer=()=>(${steer}); const paths=[], dots=[]; let points=[];
    const hctx=new Proxy({}, { get:(t,k)=>k==='beginPath'?()=>{ points=[]; }:k==='moveTo'||k==='lineTo'?(x,y)=>points.push([x,y]):k==='stroke'?()=>paths.push(points):k==='arc'?(x,y)=>dots.push([x,y]):()=>{}, set:()=>true });
    ${arrow} return { paths, dots };`)(navigate, THREE) as { paths: number[][][]; dots: number[][] }
  it('puts the course line\'s arrow beside the velocity vector by the angle off the line, full scale at 8°, with two dots toward it', () => {
    expect(arrow).not.toBe('')
    const d = drawn(`{ bearing:10*D2R, course:14*D2R }`) // the line 4° to the right
    expect(d.paths.length).toBe(1)
    expect((d.paths[0][0][0] + d.paths[0][1][0]) / 2).toBeCloseTo(400 + 20, 6) // the shaft's middle at half scale
    expect(d.dots).toEqual([[420, 300], [440, 300]])
    const far = drawn(`{ bearing:10*D2R, course:350*D2R }`) // 20° to the left: held at full scale
    expect(far.dots).toEqual([[380, 300], [360, 300]])
    expect((far.paths[0][0][0] + far.paths[0][1][0]) / 2).toBeCloseTo(360, 6)
  })
  it('turns the arrow to the course against the ground track, and drops the dots within 1.25° of the line', () => {
    const along = drawn(`{ bearing:0, course:0 }`)
    expect(along.dots).toEqual([])
    expect(along.paths[0][0][1] - along.paths[0][1][1]).toBeCloseTo(26, 6) // the shaft upright: 13 either side of the velocity vector's height
    const across = drawn(`{ bearing:0, course:1*D2R }`)
    expect(across.dots).toEqual([])
    const crossing = drawn(`{ bearing:90*D2R, course:90*D2R }`)
    expect(crossing.paths[0][1][0] - crossing.paths[0][0][0]).toBeCloseTo(26, 6) // the shaft level, pointing right
  })
  it('draws the arrow only with a course line selected, in NAV, and not at REJ 2', () => {
    expect(drawn(`{ bearing:0, course:null }`).paths).toEqual([])
    expect(drawn('null').paths).toEqual([])
    expect(drawn(`{ bearing:10*D2R, course:14*D2R }`, '9m').paths).toEqual([])
    expect(drawn(`{ bearing:10*D2R, course:14*D2R }`, 'nav', 2).paths).toEqual([])
  })

  const cue = /\n\t\{ const gz=ownship\.gauges\|\|\{\}, need=master==="nav"[\s\S]*?\n\t\t\thctx\.beginPath\(\);[^\n]*\} \}\n/.exec(source)?.[0] ?? ''
  const cued = (ground: number, need: string, master = 'nav') => new Function('THREE', `const master=${JSON.stringify(master)}, declutter=0, ax=300, wly=200, ownship={ gauges:{ ground:${ground}, zulu:0 } }, nav={}, nav_sense=()=>({}), navigate={ place:()=>({}), required:()=>(${need}) };
    const moves=[]; const hctx={ beginPath(){}, stroke(){}, moveTo(x,y){ moves.push([x,y]); }, lineTo(x,y){ moves.push([x,y]); } }; ${cue} return moves;`)(THREE) as number[][]
  it('cues the groundspeed for the time on target under the airspeed box: the arrowhead left of the tick when slow, 30 knots at full displacement', () => {
    expect(cue).not.toBe('')
    expect(cued(400, 'null')).toEqual([])
    expect(cued(400, '400', '9m')).toEqual([])
    const tick = [[258, 234], [258, 241]]
    expect(cued(400, '400')).toEqual([...tick, [253, 250], [258, 243], [263, 250]])
    expect(cued(385, '400')[3]).toEqual([250, 243]) // 15 kt slow: half way left
    expect(cued(300, '400')[3]).toEqual([242, 243])
    expect(cued(460, '400')[3]).toEqual([274, 243])
  })
})

describe('the designated target on the HUD', () => {
  const block = /\n\tif\(nav\.designation&&master==="nav"\)\{ const here=[^\n]*\n[^\n]*\n\t\tif\(at\)\{[^\n]*\} \}\n/.exec(source)?.[0] ?? ''
  const run = (designation: string, master = 'nav', error = '{ x:0, z:0 }') => new Function('navigate', 'THREE', `const master=${JSON.stringify(master)}, GR='g', hs=1, wrap_axis=(v)=>v, ownship={ pos:{ x:0, y:1000, z:0 } };
    const nav=navigate.fresh(1); navigate.ready(nav,{ x:0, z:0 }); nav.ins.error=${error}; nav.designation=${designation};
    const nav_sense=()=>({ dt:0, x:0, z:0, east:0, south:0, tas:0, heading:0, pitch:0, bank:0, airborne:true, brake:false, power:true, radar:false, deck:false, tacan:null });
    const sights=[], points=[]; const proj_dir=(v)=>{ sights.push([v.x,v.y,v.z]); return [400,300]; };
    const hctx={ beginPath(){}, closePath(){}, stroke(){}, setLineDash(){}, moveTo(x,y){ points.push([x,y]); }, lineTo(x,y){ points.push([x,y]); } };
    ${block} return { sights, points };`)(navigate, THREE) as { sights: number[][]; points: number[][] }
  it('draws the target diamond on the designated point\'s line of sight, at its elevation', () => {
    expect(block).not.toBe('')
    const d = run('{ x:0, z:-3000, elevation:0, stage:"tgt" }')
    const length = Math.hypot(3000, 1000)
    expect(d.sights[0][0]).toBeCloseTo(0, 9); expect(d.sights[0][1]).toBeCloseTo(-1000 / length, 9); expect(d.sights[0][2]).toBeCloseTo(-3000 / length, 9)
    expect(d.points).toEqual([[400, 292], [408, 300], [400, 308], [392, 300]])
  })
  it('sights it from the position the suite keeps', () => {
    const d = run('{ x:0, z:-3000, elevation:1000, stage:"tgt" }', 'nav', '{ x:3000, z:0 }')
    expect(d.sights[0][0]).toBeCloseTo(-Math.SQRT1_2, 9); expect(d.sights[0][1]).toBeCloseTo(0, 9)
  })
  it('draws none without a designation, nor outside the NAV master mode', () => {
    expect(run('null').points).toEqual([])
    expect(run('{ x:0, z:-3000, elevation:0, stage:"tgt" }', '9m').points).toEqual([])
  })
})

describe('the suite\'s cautions on the DDI', () => {
  it('are added to the caution captions', () => {
    expect(source).toMatch(/\n\tfor\(const caption of navigate\.cautions\(nav\)\) captions\.push\(caption\);/)
    expect(cockpit('nav.ins.knob="off"; nav_frame(0.1); return navigate.cautions(nav);')).toEqual(['INS ATT'])
  })
})

describe('the HSI and the HUD without mission computer 1 (25.1.2)', () => {
  it('takes only the scale, the TACAN and ACL on the backup HSI, and the orientation and decentre on its MODE sublevel', () => {
    const top = cockpit<unknown[]>('computers={ one:false, two:true }; const r=[]; for(let pb=1;pb<=20;pb++){ hsi_state.level=""; if(hsi_press(pb,"center")) r.push(pb); } return r;')
    expect(top).toEqual([1, 3, 5, 8])
    const mode = cockpit<unknown[]>('computers={ one:false, two:true }; const r=[]; for(let pb=1;pb<=20;pb++){ hsi_state.level="mode"; if(hsi_press(pb,"center")) r.push(pb); } return r;')
    expect(mode).toEqual([2, 4, 8, 10]) // no MAP
    expect(cockpit('const r=[]; for(const pb of [6,9,10]){ hsi_state.level=""; r.push(hsi_press(pb,"center")); } return r;')).toEqual([true, true, true]) // with it: POS, MK and DATA
  })
  it('takes the steering off the HUD, the TACAN\'s too', () => {
    expect(cockpit('return !!hud_steer();')).toBe(true)
    expect(cockpit('computers={ one:false, two:true }; return hud_steer();')).toBeNull()
    expect(cockpit('computers={ one:false, two:true }; nav.steer="wypt"; nav.waypoints[1]=point(5000,0); nav.current=1; return hud_steer();')).toBeNull()
  })
})

describe('the autopilot\'s options on the HSI', () => {
  it('boxes ACL from the top level\'s lower left pushbutton, in the NAV master mode only (24.1.3.19, 24.6.1)', () => {
    expect(cockpit('const pressed=hsi_press(1,"center"); return [pressed, acl];')).toEqual([true, 1])
    expect(cockpit('master="gun"; const pressed=hsi_press(1,"center"); return [pressed, acl];')).toEqual([false, 0])
    expect(cockpit('hsi_state.level="mode"; hsi_press(1,"center"); return acl;')).toBe(0) // the MODE sublevel has nothing there
  })
  it('toggles the bank limit between NAV and TAC on the A/C data (24.2.8)', () => {
    expect(cockpit('hsi_state.level="data"; hsi_state.data="ac"; const a=[hsi_press(4,"center"), nav.limit]; hsi_press(4,"center"); return [a, nav.limit];')).toEqual([[true, 'tac'], 'nav'])
  })
  it('boxes OVFLY for the waypoint shown on the waypoint data, and for no waypoint that is not there', () => {
    const s = cockpit<unknown[]>(`nav.waypoints[4]=point(1000,1000); hsi_state.level="data"; hsi_state.data="wypt"; hsi_state.shown=4; const on=[hsi_press(16,"center"), nav.waypoints[4].overfly];
      hsi_press(16,"center"); hsi_state.shown=9; return [on, nav.waypoints[4].overfly, hsi_press(16,"center")];`)
    expect(s).toEqual([[true, true], false, false])
    expect(cockpit('nav.waypoints[4]=point(1000,1000); hsi_state.level="data"; hsi_state.data="wypt"; hsi_state.shown=4; hsi_press(4,"center"); return [nav.limit, hsi_state.slew];')).toEqual(['nav', true]) // there, the same pushbutton is SLEW
  })
})
