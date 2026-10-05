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
import * as countermeasures from './countermeasures'
import * as communication from './communication'
import * as identification from './identification'
import * as mids from './mids'
import * as helmet from './helmet'

// The cockpit's side of the mission computers and the BIT display (G4: #95, #90,
// #96, #79): the MC switch, what each unit is found to be doing, the frame's
// step, the BIT display's pushbuttons and drawing, and the displays' test
// pattern. engine.ts cannot be imported (WebGL at module scope), so its
// functions are lifted as text and run around the real avionics and navigation
// modules, with stand-ins for the jet.
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
const menus = /\nconst DDI_MENUS=\{[\s\S]*?\};/.exec(source)?.[0] ?? ''
const legends = /\nconst BIT_LEGENDS=\{[\s\S]*?\};/.exec(source)?.[0] ?? ''
const world = `const NM=1852, D2R=Math.PI/180, DDI_ORDER=["left","right","center"], STATE={ jam:0 }, FCS_CHANNELS=[0,1,2,3,4,5];
  let sim_time=100, ddi_dirty=false, ufc_dirty=false, buses={ ac:true, essential:true, left:true, right:true }, last_out=[0,0,0,0,0,0], radalt_on=true;
  const suite=countermeasures.fresh(true), squawk=identification.fresh(), uhf={ one:communication.fresh(), two:communication.fresh() }, terminal=mids.fresh();
  const ownship={ grounded:true, torn:false, gearTarget:0, pos:{ x:0, y:0, z:0 } }, electrics={ mech:false }, displays={ left:{ mode:"auto", brt:1 }, right:{ mode:"auto", brt:1 }, center:{ mode:"day", brt:1 } };
  const radios={ tacan:{ on:true }, ils:{ on:true }, link:{ on:true }, beacon:{ on:true } }, knobs={ symbology:1 }, knob_level=(k)=>knobs[k], RADAR={ testing:false };
  const ddi_state={ left:{ page:"fcs", menu:"" }, right:{ page:"bit", menu:"" }, center:{ page:"hsi", menu:"" } }, hsi_state={ level:"", slew:false };
  const nav=navigate.fresh(1); navigate.ready(nav,{ x:0, z:0 }); const nav_sense=()=>({ dt:0, x:0, z:0, east:0, south:0, tas:0, heading:0, pitch:0, bank:0, airborne:false, brake:true, power:true, radar:false, deck:false, tacan:null });`
const defs = [menus + '\n', legends + '\n', line('mc_switch'), line('bit'), line('bit_state'), line('display_test'), line('ufc_test'), line('hmd'), line('PATTERN_BARS')].join('')
const functions = ['fcs_jams', 'mc', 'pattern_start', 'pattern_stop', 'equipment', 'avionics_frame', 'pattern_spot', 'pattern_draw', 'bit_press', 'ddi_bit', 'ddi_legend'].map(lift).join('\n')
function cockpit<T>(body: string): T {
  return new Function('navigate', 'avionics', 'THREE', 'countermeasures', 'communication', 'identification', 'mids', 'helmet', `${world} ${defs} ${functions}
    const helmet_frame=()=>{};   // the helmet's own frame is helmet-cockpit.test.ts's
    const text=[], rects=[], lines=[], arcs=[], fills=[]; let at=[0,0], font="";
    const x=new Proxy({}, { get:(t,k)=>k==="fillText"?(s,px,py)=>text.push([String(s),px,py,font]):k==="strokeRect"?(a,b,c,d)=>rects.push([a,b,c,d]):k==="fillRect"?(a,b,c,d)=>fills.push([a,b,c,d]):k==="arc"?(ax,ay,r)=>arcs.push([ax,ay,r])
      :k==="moveTo"?(px,py)=>{ at=[px,py]; }:k==="lineTo"?(px,py)=>{ lines.push([at[0],at[1],px,py]); at=[px,py]; }:k==="measureText"?(s)=>({ width:10*String(s).length }):()=>{}, set:(t,k,v)=>{ if(k==="font") font=v; return true; } });
    const drawn=()=>({ text:text.map(([s,px,py])=>[s,px,py]), rects, lines, arcs, fills });
    ${body}`)(navigate, avionics, THREE, countermeasures, communication, identification, mids, helmet) as T
}
interface Drawn { text: [string, number, number][]; rects: number[][]; lines: number[][]; arcs: number[][]; fills: number[][] }
const at = (d: Drawn, s: string) => d.text.find((t) => t[0] === s)?.slice(1)
const texts = (d: Drawn) => d.text.map((t) => t[0])

describe('the MC switch', () => {
  const press = /\n\tcase "computer":[^\n]*\n/.exec(source)?.[0] ?? ''
  it('steps from NORM to 1 OFF one way and 2 OFF the other, a position a click, and stops at the ends', () => {
    expect(press).not.toBe('')
    const s = cockpit<string[]>(`const pit_press=(action,d)=>{ switch(action){ ${press} } }; const r=[mc_switch];
      pit_press("computer",-1); r.push(mc_switch); pit_press("computer",-1); r.push(mc_switch); pit_press("computer",1); pit_press("computer",1); r.push(mc_switch); pit_press("computer",1); r.push(mc_switch, String(ddi_dirty)); return r;`)
    expect(s).toEqual(['norm', 'one', 'one', 'two', 'two', 'true'])
  })
  it('runs mission computer 1 on the left ac bus and 2 on the right, which differ with the bus tie open (FO-8)', () => {
    expect(cockpit('buses={ ac:true, essential:true, left:false, right:true }; const a=mc(); buses={ ac:true, essential:true, left:true, right:false }; return [a,mc()];'))
      .toEqual([{ one: false, two: true }, { one: true, two: false }])
  })
  it('runs each computer with its switch position and the ac buses', () => {
    expect(cockpit('const a=mc(); mc_switch="one"; const b=mc(); mc_switch="two"; const c=mc(); mc_switch="norm"; buses={ ac:false, essential:true }; return [a,b,c,mc()];'))
      .toEqual([{ one: true, two: true }, { one: false, two: true }, { one: true, two: false }, { one: false, two: false }])
  })
  it('has its click spot aft of HYD ISOL on the left console', () => {
    expect(source).toMatch(/\{ action:"computer", at:\[5\.42,-0\.027,-0\.451\] \}/)
  })
})

describe('what each unit is found to be doing', () => {
  const found = (setup: string) => cockpit<Record<string, string>>(`${setup} return equipment();`)
  it('finds everything working in a healthy jet with everything on', () => {
    expect(new Set(Object.values(found('')))).toEqual(new Set(['ok']))
    expect(Object.keys(found('')).sort()).toEqual(avionics.UNITS.map((u) => u.key).sort()) // a condition for every unit of the display
  })
  it('finds a mission computer off with its switch', () => {
    expect(found('mc_switch="two";')).toMatchObject({ mc1: 'ok', mc2: 'off' }); expect(found('mc_switch="one";')).toMatchObject({ mc1: 'off', mc2: 'ok' })
  })
  it('finds the flight control computers degraded with a channel failed, or on the mechanical link', () => {
    expect(found('last_out=[0,0,1,0,0,0];')).toMatchObject({ fcsa: 'degraded', fcsb: 'degraded' }); expect(found('electrics.mech=true;')).toMatchObject({ fcsa: 'degraded', fcsb: 'degraded' })
    expect(found('last_out=null;')).toMatchObject({ fcsa: 'ok', fcsb: 'ok' })
  })
  it('finds the SMS degraded once a store has been torn from its rack', () => {
    expect(found('ownship.torn=true;')).toMatchObject({ sms: 'degraded', wpns: 'ok' })
    expect(source).toMatch(/jettison_stations\(\[station\],"rack"\); ownship\.torn=true; \(ownship\.failures\|\|\(ownship\.failures=\[\]\)\)\.push\(station\); \}/) // a rack that lets go under load, and which station it was
  })
  // G5: the units whose controls came with the defensive panels, the radios, the IFF and MIDS
  it('finds the RWR, the dispenser and the jammer off with their own controls', () => {
    expect(found('suite.receiver.power=false;')).toMatchObject({ rwr: 'off', ale: 'ok', aspj: 'ok' })
    expect(found('suite.dispenser="off";')).toMatchObject({ rwr: 'ok', ale: 'off', aspj: 'ok' }); expect(found('suite.dispenser="bypass";').ale).toBe('ok')
    expect(found('suite.jammer="off";')).toMatchObject({ ale: 'ok', aspj: 'off' }); expect(found('suite.jammer="standby";').aspj).toBe('ok')
  })
  it('finds each radio, the IFF and the MIDS terminal off when it is turned off', () => {
    expect(found('uhf.one.on=false;')).toMatchObject({ com1: 'off', com2: 'ok' }); expect(found('uhf.two.on=false;')).toMatchObject({ com1: 'ok', com2: 'off' })
    expect(found('squawk.on=false;')).toMatchObject({ iff: 'off', l16: 'ok' }); expect(found('terminal.on=false;')).toMatchObject({ iff: 'ok', l16: 'off' })
    expect(found('')).toMatchObject({ csc: 'ok', ics: 'ok' })
  })
  // The mode 4 codes (23.6.2.2.2), held or lost each frame by the CRYPTO switch, the power and the gear handle.
  it('erases the mode 4 codes at ZERO, and loses them with the power at NORM', () => {
    const held = (setup: string) => cockpit<boolean>(`${setup} avionics_frame(0.1); return squawk.held;`)
    expect(held('')).toBe(true)
    expect(held('squawk.crypto="zero";')).toBe(false)
    expect(held('buses={ ac:false, essential:false, left:false, right:false };')).toBe(false)
    expect(held('buses={ ac:false, essential:true, left:false, right:false };')).toBe(true) // on the battery the set still has power
  })
  it('keeps them through a loss of power at HOLD with the gear handle down, and not with it up', () => {
    const held = (handle: number) => cockpit<boolean>(`squawk.crypto="hold"; ownship.gearTarget=${handle}; buses={ ac:false, essential:false, left:false, right:false }; avionics_frame(0.1); return squawk.held;`)
    expect(held(0)).toBe(true); expect(held(1)).toBe(false)
  })
  it('finds the INS off, coming up while it aligns, and working once it navigates', () => {
    expect(found('nav.ins.mode="off";').ins).toBe('off'); expect(found('nav.ins.mode="align";').ins).toBe('wait'); expect(found('nav.ins.mode="gyro";').ins).toBe('ok')
  })
  it('finds GPS off without power, coming up while it acquires, and degraded past its approach limit', () => {
    expect(found('nav.gps.on=false;').gps).toBe('off'); expect(found('nav.gps.search=30;').gps).toBe('wait')
    expect(found('nav.source="gps"; nav.gps.phase="appr"; nav.gps.over=10; nav.gps.error={ x:40, z:0 };').gps).toBe('degraded')
  })
  it('finds the radios, the radar altimeter, the displays and the HUD off with their switches', () => {
    expect(found('radios.tacan.on=false; radios.ils.on=false; radalt_on=false;')).toMatchObject({ tcn: 'off', ils: 'off', ralt: 'off', bcn: 'ok', dl: 'ok' })
    expect(found('radios.link.on=false;')).toMatchObject({ dl: 'off', bcn: 'ok' }); expect(found('radios.beacon.on=false;')).toMatchObject({ dl: 'ok', bcn: 'off' })
    expect(found('displays.left.mode="off"; displays.center.brt=0; knobs.symbology=0;')).toMatchObject({ lddi: 'off', rddi: 'ok', mpcd: 'off', hud: 'off' })
  })
})

describe('the frame\'s step', () => {
  it('runs the tests, keeps the radar quiet while it is in test, and redraws when a status changes', () => {
    const s = cockpit<unknown[]>(`avionics.start(bit,["rdr"],{},{ grounded:true, consent:false, test:false }); avionics_frame(1); const during=[RADAR.testing, Math.round(bit.tests.rdr), ddi_dirty];
      ddi_dirty=false; avionics_frame(1); const steady=ddi_dirty; avionics_frame(200); return [during, steady, RADAR.testing, bit.results.rdr, ddi_dirty];`)
    expect(s).toEqual([[true, 119, false], false, false, 'go', true])
  })
  it('raises the BIT advisory for a failure, and takes it down while the BIT display is on a display', () => {
    const s = cockpit<boolean[]>(`ddi_state.right.page="adi"; last_out=[0,1,0,0,0,0]; avionics_frame(0.1); const raised=bit.advisory, redrawn=ddi_dirty;
      ddi_state.right.page="bit"; ddi_state.right.menu="tac"; avionics_frame(0.1); const behind=bit.advisory; ddi_state.right.menu=""; avionics_frame(0.1); return [raised, redrawn, behind, bit.advisory];`)
    expect(s).toEqual([true, true, true, false]) // the menu over it is not the BIT display
  })
  it('takes a display off a page its mission computer no longer drives, to the TAC menu, and leaves the HSI', () => {
    const s = cockpit<unknown[]>(`ddi_state.right.page="sa"; mc_switch="one"; ddi_dirty=false; avionics_frame(0.1); const one=[ddi_state.left.menu, ddi_state.right.menu, ddi_state.center.menu, ddi_dirty];
      mc_switch="norm"; hsi_state.level="data"; hsi_state.slew=true; avionics_frame(0.1); const kept=hsi_state.level; mc_switch="one"; avionics_frame(0.1); const dropped=[hsi_state.level, hsi_state.slew]; hsi_state.level="mode"; avionics_frame(0.1); one.push(kept, dropped, hsi_state.level);
      mc_switch="two"; ddi_state.left={ page:"sms", menu:"" }; ddi_state.right={ page:"rdr", menu:"" }; avionics_frame(0.1); return [one, ddi_state.left.menu, ddi_state.right.menu];`)
    expect(s).toEqual([['tac', 'tac', '', true, 'data', ['', false], 'mode'], 'tac', '']) // and the HSI's data, position and update sublevels go with MC1, MODE staying
  })
  it('runs the UFC\'s test for its two five-second periods', () => {
    const s = cockpit<unknown[]>(`ufc_test.at=95; avionics_frame(0.1); const running=[ufc_test.at, ufc_dirty]; ufc_test.at=90; avionics_frame(0.1); return [running, ufc_test.at];`)
    expect(s).toEqual([[95, true], -Infinity])
  })
})

describe('the BIT display\'s pushbuttons', () => {
  it('tests all but the FCS and the INS with AUTO, the INS too with its knob at TEST', () => {
    const s = cockpit<string[][]>(`const p=(pb)=>bit_press(pb); p(6); const auto=Object.keys(bit.tests).sort(), results={ ...bit.results }, asking=bit.asking; avionics.stop(bit);
      nav.ins.knob="test"; p(6); return [auto, Object.keys(results), [String(asking), String(bit.asking)]];`)
    const expected = avionics.UNITS.filter((u) => !u.plain && u.group !== 'fcs' && u.key !== 'ins').map((u) => u.key).sort()
    expect(s).toEqual([expected, [], ['false', 'true']]) // no RESTRT left on the FCS: AUTO does not try it
  })
  it('opens a group\'s sublevel, or tests the group with SELBIT boxed', () => {
    const s = cockpit<unknown[]>(`const p=(pb)=>bit_press(pb); const open=[p(1), bit_state.level, Object.keys(bit.tests)]; p(8); const back=bit_state.level;
      const boxed=[p(8), bit_state.select]; p(1); return [open, back, boxed, bit_state.level, Object.keys(bit.tests).sort(), p(2)];`)
    expect(s).toEqual([[true, 'nav', []], '', [true, true], '', ['adc', 'bcn', 'gps', 'ils', 'ralt', 'tcn'], true])
  })
  it('tests a unit from its pushbutton on the sublevel, and the whole group with ALL', () => {
    const s = cockpit<unknown[]>(`const p=(pb)=>bit_press(pb); p(1); const one=[p(1), Object.keys(bit.tests)]; p(10); const pair=[p(3), Object.keys(bit.tests).sort()]; const all=[p(6), Object.keys(bit.tests).sort()]; return [one, pair, all, p(9)];`)
    expect(s).toEqual([[true, ['tcn']], [true, ['bcn', 'ils']], [true, ['adc', 'bcn', 'gps', 'ils', 'ralt', 'tcn']], false]) // the beacon is tested with the ILS (24.5.3)
  })
  it('refuses a ground-only test in flight', () => {
    const s = cockpit<unknown[]>(`const p=(pb)=>bit_press(pb); ownship.grounded=false; p(1); return [p(4), p(5), p(13), Object.keys(bit.tests), p(19), bit_state.level];`)
    expect(s).toEqual([false, false, true, ['gps'], false, 'nav']) // ADC and INS are not tested in flight, nor is INS MAINT offered
  })
  it('takes GND or CV for the INS and nothing else while it asks, and reads RESTRT with the knob away from TEST', () => {
    const s = cockpit<unknown[]>(`const p=(pb)=>bit_press(pb); p(1); p(5); const refused=bit.results.ins; nav.ins.knob="test"; p(5); const asking=bit.asking;
      return [refused, asking, p(1), p(19), p(20), bit.asking, bit.tests.ins];`)
    expect(s).toEqual(['restart', true, false, false, true, false, 600])
  })
  it('shows the INS post flight data from INS MAINT on the wheels, and steps POST 1 and POST 2', () => {
    const s = cockpit<unknown[]>(`const p=(pb)=>bit_press(pb); p(1); const r=[p(19), bit_state.level, bit_state.post, p(13), bit_state.post, p(13), bit_state.post, p(8), bit_state.level]; return r;`)
    expect(s).toEqual([true, 'ins', 1, true, 2, true, 1, true, ''])
  })
  it('starts the displays\' test pattern, the UFC\'s test and the IFEI\'s from the DISPLAYS sublevel', () => {
    const s = cockpit<unknown[]>(`const p=(pb)=>bit_press(pb); p(11); const level=bit_state.level; p(5); const first=[display_test.on, display_test.at, Object.keys(bit.tests).sort()]; pattern_stop();
      const stopped=[display_test.on, Object.keys(bit.tests)]; p(3); const ufc=ufc_test.at; p(4); return [level, first, stopped, ufc, Object.keys(bit.tests)];`)
    expect(s).toEqual(['displays', [true, 100, ['hud', 'lddi', 'mpcd', 'rddi']], [false, []], 100, ['ifei']])
  })
  it('opens CONFIG and returns with BIT', () => {
    expect(cockpit('const p=(pb)=>bit_press(pb); return [p(7), bit_state.level, p(6), p(8), bit_state.level];')).toEqual([true, 'config', false, true, ''])
  })
  it('stops every test and the UFC\'s with STOP, at any level', () => {
    const s = cockpit<unknown[]>(`const p=(pb)=>bit_press(pb); p(6); ufc_test.at=99; const top=[p(10), Object.keys(bit.tests), ufc_test.at]; p(1); p(6); return [top, p(10), Object.keys(bit.tests), bit_state.level];`)
    expect(s).toEqual([[true, [], -Infinity], true, [], 'nav'])
  })
  it('pages the failures only when there are more than a page of them', () => {
    const s = cockpit<unknown[]>(`const p=(pb)=>bit_press(pb); const few=p(16); radios.tacan.on=radios.ils.on=radalt_on=false; nav.ins.mode="off"; nav.gps.on=false; displays.left.mode=displays.right.mode="off"; displays.center.brt=0; knobs.symbology=0;
      last_out=[1,0,0,0,0,0]; ownship.torn=true; mc_switch="two"; return [few, avionics.failures(equipment(),bit).length, p(16), bit_state.page, p(16), bit_state.page];`)
    expect(s).toEqual([false, 13, true, 1, true, 0])
  })
})

describe('the BIT display', () => {
  const show = (setup: string) => cockpit<Drawn>(`${setup} ddi_bit(x); return drawn();`)
  it('lays out the top level: AUTO, CONFIG, SELBIT and STOP, each group over its status, and no failures in a healthy jet', () => {
    const d = show('')
    for (const [label, px, py] of [['AUTO', 96, 30], ['CONFIG', 176, 30], ['SELBIT', 256, 30], ['STOP', 416, 30]] as [string, number, number][]) expect(at(d, label), label).toEqual([px, py])
    expect(at(d, 'FCS-MC')).toEqual([10, 84]); expect(at(d, 'SENSORS')).toEqual([10, 164]); expect(at(d, 'STORES')).toEqual([10, 244]); expect(at(d, 'NAV')).toEqual([10, 404])
    expect(at(d, 'DISPLAYS')).toEqual([502, 84]); expect(at(d, 'STATUS')).toEqual([502, 144]); expect(at(d, 'MONITOR')).toEqual([502, 164]); expect(at(d, 'EW')).toEqual([502, 244])
    expect(at(d, 'COMM')).toEqual([10, 324])
    expect(d.text.filter(([t]) => t === 'PBIT GO').map(([, px, py]) => [px, py])).toEqual([[10, 106], [10, 186], [10, 266], [10, 346], [10, 426], [502, 106], [502, 186], [502, 266]])
    expect(at(d, 'BIT FAILURES')).toEqual([256, 116]); expect(d.text.some(([, px, py]) => px === 176 && py >= 140)).toBe(false)
    expect(d.rects).toEqual([]) // SELBIT unboxed
  })
  it('boxes SELBIT, reads each group\'s lowest status, and lists the failures by name', () => {
    const d = show('bit_state.select=true; radalt_on=false; last_out=[0,0,1,0,0,0]; bit.tests.rdr=5;')
    expect(d.rects.length).toBe(1)
    expect(d.text).toContainEqual(['DEGD', 10, 106]); expect(d.text).toContainEqual(['IN TEST', 10, 186]); expect(d.text).toContainEqual(['OFF', 10, 426])
    expect(d.text.filter(([, px, py]) => (px === 176 || px === 300) && py >= 140)).toEqual([['FCSA', 176, 150], ['DEGD', 300, 150], ['FCSB', 176, 172], ['DEGD', 300, 172], ['RALT', 176, 194], ['OFF', 300, 194]])
    expect(texts(d)).not.toContain('PAGE')
  })
  it('offers PAGE past twelve failures and shows the second page', () => {
    const many = 'radios.tacan.on=radios.ils.on=radalt_on=false; nav.ins.mode="off"; nav.gps.on=false; displays.left.mode=displays.right.mode="off"; displays.center.brt=0; knobs.symbology=0; last_out=[1,0,0,0,0,0]; ownship.torn=true; mc_switch="two";'
    const first = show(many), second = show(many + 'bit_state.page=1;')
    expect(at(first, 'PAGE')).toEqual([416, 482]); expect(first.text.filter(([, px, py]) => px === 176 && py >= 140).length).toBe(12)
    expect(second.text.filter(([, px, py]) => px === 176 && py >= 140).map(([t]) => t)).toEqual(['HUD'])
  })
  it('lists a group\'s units with their status on its sublevel, with ALL, BIT, STOP and each unit\'s pushbutton', () => {
    const d = show('bit_state.level="nav"; bit.results.tcn="go"; nav.gps.search=20;')
    expect(at(d, 'NAV')).toEqual([256, 96])
    expect(d.text.filter(([, px]) => px === 180 || px === 290)).toEqual([['INS', 180, 130], ['PBIT GO', 290, 130], ['ADC', 180, 150], ['PBIT GO', 290, 150], ['ILS', 180, 170], ['PBIT GO', 290, 170], ['BCN', 180, 190], ['PBIT GO', 290, 190], ['RALT', 180, 210], ['PBIT GO', 290, 210], ['TCN', 180, 230], ['GO', 290, 230], ['GPS', 180, 250], ['NOT RDY', 290, 250]])
    for (const [label, px, py] of [['ALL', 96, 30], ['BIT', 256, 30], ['STOP', 416, 30], ['INS', 10, 96], ['ADC', 10, 176], ['ILS', 10, 256], ['RALT', 10, 336], ['TCN', 10, 416], ['GPS', 502, 256], ['MAINT', 176, 482]] as [string, number, number][]) expect(d.text, label).toContainEqual([label, px, py])
    expect(d.text).toContainEqual(['INS', 176, 460]) // INS over MAINT
  })
  it('takes the ground-only legends away in flight', () => {
    const d = show('bit_state.level="nav"; ownship.grounded=false;')
    expect(d.text.filter(([, px]) => px === 10).map(([t]) => t).sort()).toEqual(['ILS', 'RALT', 'TCN']); expect(texts(d)).not.toContain('MAINT')
    const stores = show('bit_state.level="stores"; ownship.grounded=false;')
    expect(stores.text.some(([t, px]) => t === 'SMS' && px === 10)).toBe(false); expect(show('bit_state.level="stores";').text).toContainEqual(['SMS', 10, 96])
  })
  it('offers GND and CV in INS MAINT\'s place while the INS asks', () => {
    const d = show('bit_state.level="nav"; bit.asking=true;')
    expect(at(d, 'GND')).toEqual([96, 482]); expect(at(d, 'CV')).toEqual([416, 482]); expect(texts(d)).not.toContain('MAINT'); expect(d.text).toContainEqual(['GND/CV?', 290, 130])
  })
  it('stacks DDI, MPCD and HUD at the pushbutton that tests them, and boxes UFC while its test runs', () => {
    const d = show('bit_state.level="displays"; ufc_test.at=95;')
    expect(d.text).toContainEqual(['DDI', 10, 76]); expect(d.text).toContainEqual(['MPCD', 10, 96]); expect(d.text).toContainEqual(['HUD', 10, 116])
    expect(d.text).toContainEqual(['IFEI', 10, 176]); expect(at(d, 'UFC')).toEqual([10, 256]); expect(d.rects.length).toBe(1)
    expect(show('bit_state.level="displays";').rects.length).toBe(0)
  })
  it('shows the configuration: the country code and the mission computers\' OFP', () => {
    const d = show('bit_state.level="config";')
    expect(at(d, 'S/W CONFIGURATION')).toEqual([256, 96]); expect(at(d, 'USN')).toEqual([256, 118])
    expect(d.text.filter(([, , py]) => py === 160 || py === 182)).toEqual([['MC1', 170, 160], ['13C', 290, 160], ['MC2', 170, 182], ['13C', 290, 182]])
    expect(at(d, 'BIT')).toEqual([256, 30]); expect(texts(d)).not.toContain('AUTO')
  })
  it('shows the INS post flight data: position, alignment and navigation time and the error rate, then the updates', () => {
    const logged = 'bit_state.level="ins"; nav.log={ alignment:322, navigation:2335, updates:1, error:{ north:-1852, east:926 }, cumulative:{ north:1852, east:926 }, rate:1852/3600 };'
    const one = show(logged), two = show(logged + 'bit_state.post=2;')
    expect(texts(one)).toEqual(expect.arrayContaining(["POS N  28°12.432' W 177°22.410'", 'ALN TIME=0322 AQ=0.5', 'NAV TIME=02335 PER=01.0']))
    expect(at(one, 'POST 1')).toEqual([502, 256]); expect(one.rects.length).toBe(1)
    expect(texts(two)).toEqual(expect.arrayContaining(['ERROR', 'CUM', 'N/S-01.0', '001.0', 'E/W+00.5', '000.5', 'UPDATE 1'])); expect(at(two, 'POST 2')).toEqual([502, 256])
    expect(texts(show('bit_state.level="ins";'))).toContain('NAV TIME=00000 PER=XX.X') // no update yet: no rate
  })
})

describe('what the mission computers take with them', () => {
  it('leaves the g limiter to the paddle switch alone, and holds the missiles on their rails without MC2', () => {
    expect(source).toMatch(/override:keys\.has\(key_of\("override"\)\)&&!\(DEV_MODE&&on_ground\(\)\),/) // without MC1 the limit goes to a fixed 7.5 g, not past it (25.1)
    const fire = (two: boolean, master: string) => new Function(`let fired=""; const mc=()=>({ one:true, two:${two} }), master=${JSON.stringify(master)}, trigger_amraam=()=>{ fired="amraam"; }, weapons_hold=false, ownship={ launching:false, gear:1, msl:2 }, MULTIPLAYER=false, has_enemy=false, arms={ arm:true }, notice=()=>{}, translate=(s)=>s;
      const launch_missile=()=>{ fired="sidewinder"; return true; }, cheat=()=>false, audio_launch=()=>{}, update_rails=()=>{}, seeker_now={ slaved:false, quarry:null }; ${lift('trigger_missile')}
} trigger_missile(); return fired;`)() as string // the lift stops at the function's own closing brace, which stands alone
    expect([fire(true, '120c'), fire(true, '9m'), fire(false, '120c'), fire(false, '9m')]).toEqual(['amraam', 'sidewinder', '', ''])
  })
  it('filters the cautions and advisories each sim step by the computers still running', () => {
    expect(source).toMatch(/\n\tconst computing=mc\(\);\n\tcaptions\.splice\(0,captions\.length,\.\.\.avionics\.cautions\(captions,computing\)\);/)
  })
  it('starts a mission with both on and nothing in test', () => {
    expect(source).toMatch(/mc_switch="norm"; Object\.assign\(bit,avionics\.fresh\(\)\); Object\.assign\(bit_state,\{ level:"", select:false, post:1, page:0 \}\); display_test\.on=false; ufc_test\.at=-Infinity; ownship\.torn=false;/)
  })
  it('gives the pushbuttons to the test pattern while it shows, and to nothing with neither computer', () => {
    const s = cockpit<unknown[]>(`${lift('ddi_press')} const DDI_PAGES={ fcs:{ press:()=>{ throw new Error("page pressed"); } } }, ddi_show=()=>{}, caution_page=()=>null;
      pattern_start(); bit.tests.lddi=20; ddi_dirty=false; const circle=[ddi_press("left",7), ddi_press("left",7), ddi_press("left",18), display_test.pressed.left, ddi_state.left.menu, ddi_dirty];
      const stop=[ddi_press("right",5), display_test.on, bit.tests]; mc_switch="norm"; buses={ ac:false, essential:true }; return [circle, stop, ddi_press("left",18), ddi_state.left.menu];`)
    expect(s).toEqual([[true, true, true, [7, 18], '', true], [true, false, {}], false, '']) // MENU is a button to test, not the menu
  })
  it('puts the test pattern on every display while it shows, in the page\'s place', () => {
    const s = cockpit<unknown[]>(`${lift('ddi_render')} let ddi_draws=0; const spin_up=false, designator="right", diamond=()=>{}, drew=[], DDI_PAGES={ fcs:{ draw:()=>drew.push("fcs") }, bit:{ draw:()=>drew.push("bit") }, hsi:{ draw:()=>drew.push("hsi") } }, caution_page=()=>null, caution_host=()=>"left", cautions_draw=()=>drew.push("cautions");
      ddi_render(x,512,"left"); const before=[...drew]; drew.length=0; pattern_start(); sim_time+=5; ddi_render(x,512,"left"); return [before, drew, drawn().text.some(([t])=>t==="0123456777")];`)
    expect(s).toEqual([['fcs', 'cautions'], [], true])
  })
  it('tells the UFC which of its test\'s two periods it is in', () => {
    const live = (since: number) => cockpit<number>(`const emcon=false, timer={ shown:"" }, ufc={ unit:"" }, hold={ modes:{} }, autopilot={ offered:()=>({}) }, autopilot_sense=()=>({}), couple_now=()=>null; ufc_test.at=sim_time-${since}; ${lift('ufc_live')} return ufc_live().test;`)
    expect([live(0), live(4.9), live(5), live(9.9), live(10), live(1e9)]).toEqual([1, 1, 2, 2, 0, 0])
  })
  it('takes the radar\'s silence in test into the radar itself', () => {
    expect(readFileSync(fileURLToPath(new URL('./radar.ts', import.meta.url)), 'utf8')).toMatch(/return this\.sil \|\| this\.emcon \|\| this\.unpowered \|\| this\.testing/)
  })
})

describe('the displays\' test pattern', () => {
  it('starts on every display with nothing pressed, and stopping it ends the tests', () => {
    const s = cockpit<unknown[]>(`display_test.pressed.left=[7]; bit.tests.lddi=20; sim_time=140; pattern_start(); const on=[display_test.on, display_test.at, display_test.pressed.left, ddi_dirty]; ddi_dirty=false; pattern_stop(); return [on, display_test.on, bit.tests, ddi_dirty];`)
    expect(s).toEqual([[true, 140, [], true], false, {}, true])
  })
  const shown = (after: number, pressed = '[]') => cockpit<Drawn>(`pattern_start(); display_test.pressed.left=${pressed}; sim_time=100+${after}; pattern_draw(x,"left"); return drawn();`)
  it('is blank for a moment, flashes IN TEST, then draws the pattern', () => {
    expect(shown(0.3).text).toEqual([])
    expect(shown(1.2).text).toEqual([['IN TEST', 256, 256]]); expect(shown(1.7).text).toEqual([])
    const d = shown(5)
    expect(texts(d)).toEqual(expect.arrayContaining(['TEST', '0123456777', 'STOP'])); expect(at(d, 'STOP')).toEqual([10, 96])
    expect(d.arcs).toContainEqual([256, 264, 180]); expect(d.rects).toContainEqual([251, 259, 10, 10]); expect(d.rects).toContainEqual([196, 364, 120, 24])
    expect(d.fills.length).toBe(8); expect(d.rects.filter(([, , w, h]) => w === 8 && h > 10).length).toBe(5) // the grey scale and the bars
    expect(d.lines.length).toBeGreaterThanOrEqual(12) // the cross
  })
  it('draws a circle beside each pushbutton pressed, on that display', () => {
    const d = shown(5, '[1,8,13,18]')
    for (const spot of [[18, 416, 7], [256, 18, 7], [494, 256, 7], [256, 494, 7]]) expect(d.arcs).toContainEqual(spot)
    expect(shown(5).arcs.filter(([, , r]) => r === 7)).toEqual([])
    expect(cockpit<Drawn>('pattern_start(); display_test.pressed.left=[1]; sim_time=105; pattern_draw(x,"right"); return drawn();').arcs.filter(([, , r]) => r === 7)).toEqual([])
  })
})
