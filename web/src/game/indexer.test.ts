// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

// The AOA indexer's flash rule (NATOPS 2.12.10): the symbols flash with the
// hook up and the hook bypass switch in CARRIER, hold steady in FIELD, and the
// solenoid lets FIELD go the moment the hook is lowered. engine.ts cannot be
// imported (WebGL at module scope), so the indexer block of update_gauges is
// read as text and stepped against stand-ins, as the voice test does.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
// The match ends on the line that also closes update_gauges, so its last brace
// is dropped to leave just the else-if block.
const block = (/\n\telse if\(ind\)\{ const [a-z]+=\(out\[STATE\.alpha\]\|\|0\)\/D2R[\s\S]*?ind\.donut\.opacity=[^\n]*\n/.exec(source)?.[0] ?? '').replace(/\} \}\n$/, '}\n')

interface Moment { hook: number; bypass: 'carrier' | 'field'; time: number; essential?: boolean }
interface Result { lit: boolean; bypass: string }
// Steps the block once per moment, on speed with the gear down and flying, and
// returns whether the donut is lit and where the switch ended up.
function indexer(moments: Moment[]): Result[] {
  if (!block) throw new Error('indexer block not found in engine.ts')
  const run = new Function('moments', `const D2R=Math.PI/180, glow=1, STATE={alpha:0, extension:1}, THREE={MathUtils:{clamp:(v,lo,hi)=>Math.min(hi,Math.max(lo,v))}};
    const ind={slow:{opacity:0},donut:{opacity:0},fast:{opacity:0}}, ownship={hook:0,grounded:false};
    let glance=0, hook_bypass="carrier", buses={ essential:true };
    const out=[8.1*D2R, 1];
    return moments.map((m)=>{ ownship.hook=m.hook; hook_bypass=m.bypass; glance=m.time; buses={ essential:m.essential??true };
      if(false){} ${block}
      return { lit: ind.donut.opacity>0.5, bypass: hook_bypass }; });`)
  return run(moments) as Result[]
}
const on = (t: number) => Math.floor(t * 3) % 2 === 1 // the flash's lit half
const dark = (t: number) => Math.floor(t * 3) % 2 === 0

// The lights test lights all three symbols whatever the jet is doing (NATOPS
// 2.6.2.11): the if that precedes the block, run with the gear up on deck.
const tested = /\n\tif\(ind&&\(INDEXER_TEST\|\|lamps_testing\)\)\{[^\n]*\n/.exec(source)?.[0] ?? ''
function testing(on: boolean): number[] {
  if (!block || !tested) throw new Error('indexer block not found in engine.ts')
  return new Function('on', `const D2R=Math.PI/180, glow=1, buses={ essential:true }, STATE={alpha:0, extension:1}, INDEXER_TEST="", lamps_testing=on;
    const ind={slow:{opacity:0},donut:{opacity:0},fast:{opacity:0}}, ownship={hook:1,grounded:true};
    let glance=0, hook_bypass="carrier";
    const out=[8.1*D2R, 0];
    ${tested}${block}
    return [ind.slow.opacity, ind.donut.opacity, ind.fast.opacity];`)(on) as number[]
}

describe('the AOA indexer under the lights test', () => {
  it('lights all three symbols while the test is on, and none on deck with the gear up otherwise', () => {
    expect(testing(true)).toEqual([1, 1, 1])
    expect(testing(false)).toEqual([0, 0, 0])
  })
})

describe('the AOA indexer flash', () => {
  it('flashes with the hook up in CARRIER', () => {
    const t1 = [0.1, 0.4].find(on) as number, t0 = [0.1, 0.4].find(dark) as number
    expect(indexer([{ hook: 0, bypass: 'carrier', time: t1 }])[0].lit).toBe(true)
    expect(indexer([{ hook: 0, bypass: 'carrier', time: t0 }])[0].lit).toBe(false)
  })

  it('holds steady with the hook up in FIELD, and with the hook down', () => {
    const t0 = [0.1, 0.4].find(dark) as number
    expect(indexer([{ hook: 0, bypass: 'field', time: t0 }])[0].lit).toBe(true)
    expect(indexer([{ hook: 1, bypass: 'carrier', time: t0 }])[0].lit).toBe(true)
  })

  it('drops FIELD back to CARRIER when the aircraft\'s power is removed (2.12.10, #116)', () => {
    const [dead] = indexer([{ hook: 0, bypass: 'field', time: 0.1, essential: false }])
    expect(dead.bypass).toBe('carrier')
  })

  it('drops FIELD back to CARRIER when the hook comes down', () => {
    const [up, down] = indexer([{ hook: 0, bypass: 'field', time: 0.1 }, { hook: 1, bypass: 'field', time: 0.2 }])
    expect(up.bypass).toBe('field')
    expect(down.bypass).toBe('carrier')
  })
})

// NATOPS figure 2-19 (aircraft 161520 and up): five indications, each a set
// of symbols fully lit or dark - SLOW 9.3-90° top chevron, SLIGHTLY SLOW
// 8.8-9.3° chevron and donut, ON SPEED 7.4-8.8° donut, SLIGHTLY FAST 6.9-7.4°
// donut and bottom chevron, FAST 0-6.9° bottom chevron.
function lamps(alpha: number): { slow: number; donut: number; fast: number } {
  if (!block) throw new Error('indexer block not found in engine.ts')
  return new Function('alpha', `const D2R=Math.PI/180, glow=1, buses={ essential:true }, STATE={alpha:0, extension:1}, THREE={MathUtils:{clamp:(v,lo,hi)=>Math.min(hi,Math.max(lo,v))}};
    const ind={slow:{opacity:0},donut:{opacity:0},fast:{opacity:0}}, ownship={hook:1,grounded:false};
    let glance=0, hook_bypass="carrier";
    const out=[alpha*D2R, 1];
    if(false){} ${block}
    return { slow:ind.slow.opacity, donut:ind.donut.opacity, fast:ind.fast.opacity };`)(alpha)
}
const lit = (alpha: number) => { const l = lamps(alpha); return [l.slow, l.donut, l.fast] }

describe('the AOA indexer bands', () => {
  it('shows the five indications of figure 2-19, each lamp fully lit or dark', () => {
    expect(lit(12)).toEqual([1, 0, 0]) // SLOW
    expect(lit(9)).toEqual([1, 1, 0]) // SLIGHTLY SLOW
    expect(lit(8.1)).toEqual([0, 1, 0]) // ON SPEED
    expect(lit(7.5)).toEqual([0, 1, 0])
    expect(lit(8.7)).toEqual([0, 1, 0])
    expect(lit(7.1)).toEqual([0, 1, 1]) // SLIGHTLY FAST
    expect(lit(5)).toEqual([0, 0, 1]) // FAST
  })

  it('changes indication at the figure\'s band edges', () => {
    expect(lit(9.29)).toEqual([1, 1, 0])
    expect(lit(9.3)).toEqual([1, 0, 0])
    expect(lit(8.79)).toEqual([0, 1, 0])
    expect(lit(8.8)).toEqual([1, 1, 0])
    expect(lit(7.39)).toEqual([0, 1, 1])
    expect(lit(7.4)).toEqual([0, 1, 0])
    expect(lit(6.89)).toEqual([0, 0, 1])
    expect(lit(6.9)).toEqual([0, 1, 1])
  })
})

describe('the hook bypass wiring', () => {
  it('has a key, a settings label and a rig entry that scrubs the modeled switch', () => {
    const keys = readFileSync(fileURLToPath(new URL('./keys.ts', import.meta.url)), 'utf8')
    expect(keys).toMatch(/'hook\.bypass': 'Shift\+KeyH'/)
    const settings = readFileSync(fileURLToPath(new URL('../components/SettingsDialog.tsx', import.meta.url)), 'utf8')
    expect(settings.match(/id: 'hook\.bypass',\s*label: msg`Hook bypass`,\s*group: 'landing'/g)?.length).toBe(1) // one row, which both tabs draw
    expect(/const BUTTONS = new Set\(\[[^\]]*'hook\.bypass',/.test(settings)).toBe(true)
    expect(source).toMatch(/if\(ch===key_of\("hook\.bypass"\)\) pit_press\("hook\.bypass",0\);/)
    expect(source).toMatch(/case "hook\.bypass": hook_bypass=hook_bypass==="field"\?"carrier":"field"; break;/)
    expect(source).toMatch(/\{ name:"hookbypass", track:\/\^SWITCH_HOOKBYPASS_LEFTPANEL_AN\/i, drive:"hookbypass" \}/)
    expect(source).toMatch(/case "hookbypass": f=\(st===ownship&&hook_bypass==="field"\)\?1:0; break;/)
  })
})

// The switches the game has state for scrub their clips from it (#18): each
// animated switch node is a rig entry, and its drive case turns the state into
// a clip fraction. The cases are lifted from the drive switch and run against
// stand-ins for the state they read.
const cases = /\/\/ switches from state \(#18\) ---\n([\s\S]*?)\t\t\/\/ --- end switches/.exec(source)?.[1] ?? ''
interface Craft { canopyTarget?: number; canopy?: number; foldTarget?: number; barTarget?: number; probeTarget?: number; lights?: boolean }
interface Panel { position: number; formation: number; strobe: string; landing: boolean }
interface Own { parking?: boolean; alt_radar?: boolean; declutter?: number; fuel_dump?: boolean; sil?: boolean; exterior?: Partial<Panel>; handle?: string; cranked?: boolean }
// The exterior lights panel's state and the STROBE switch's positions, aft to forward, as engine.ts declares them.
const strobe = JSON.parse(/\nconst STROBE=(\[[^\n]*\]);/.exec(source)?.[1] ?? 'null') as string[] | null
const panel = new Function(`return ${/\nconst exterior=(\{[^\n]*\});/.exec(source)?.[1] ?? 'null'};`)() as Panel | null
// Runs one drive case for the aircraft st, which is the ownship unless foreign is set.
function drive(name: string, st: Craft, own: Own = {}, foreign = false): number | undefined {
  if (!cases) throw new Error('switch drive cases not found in engine.ts')
  const run = new Function('name', 'st', 'ownship', 'parking', 'alt_radar', 'declutter', 'fuel_dump', 'RADAR', 'exterior', 'STROBE', 'fold_handle', 'cranked',
    `let f; switch(name){ ${cases} } return f;`)
  const ownship = foreign ? {} : st
  return run(name, st, ownship, !!own.parking, !!own.alt_radar, own.declutter ?? 0, !!own.fuel_dump, { sil: !!own.sil }, { ...panel, ...own.exterior }, strobe, own.handle ?? 'lock', !!own.cranked) as number | undefined
}

describe('the state-driven switches', () => {
  it('bind one rig entry per animated switch node, and the parking brake both of its nodes', () => {
    const entries: [string, string, string][] = [
      ['canopyswitch', 'Canopy_Switch_AN', 'canopyswitch'], ['foldswitch', 'Wing_Fold_Switch_AN', 'foldswitch'],
      ['parkbrake', 'LANDING_GEAR_Switch_ParkingBrake_AN_ParkingBrake', 'parkbrake'], ['parkpull', 'LANDING_GEAR_Switch_ParkingBrake_AN_287', 'parkpull'],
      ['probeswitch', 'Refuel_Switch_Action_AN', 'probeswitch'],
      ['altswitch', 'Switch_ALT_HudPanel_AN', 'altswitch'], ['rejswitch', 'Switch_REJ2_HudPanel_AN', 'rejswitch'],
      ['ldglight', 'Switch_LDG_Light_LeftPanel_AN', 'ldglight'], ['strobe', 'Switch_Strobe_LeftPanel_AN', 'strobe'],
      ['formation', 'FormationLightsAction_AN', 'formation'], ['position', 'Knob_POS_LeftPanel_AN', 'position'],
      ['dumpswitch', 'Fuel_Dump_AN', 'dumpswitch'], ['radaropr', 'RADAR_OPR_AN', 'radaropr'],
    ]
    for (const [name, node, drive] of entries)
      expect(source, name).toMatch(new RegExp(`\\{ name:"${name}",\\s+track:/\\^${node}/i,\\s+drive:"${drive}" \\}`))
    // the launch bar clip is authored from EXTEND (its rest pose, lever down) to RETRACT, so it runs flipped
    expect(source).toMatch(/\{ name:"barswitch",\s+track:\/\^Switch_LAUNCHBAR_LeftPanel_AN\/i,\s+drive:"barswitch", flip:true \}/)
  })

  it('read the canopy, fold, launch bar and probe switches from their targets', () => {
    // the canopy switch's clip runs CLOSE to OPEN with HOLD between: OPEN while the canopy rises, CLOSE while it
    // lowers, and HOLD once it stops either way, both springing back (NATOPS 2.15.1.1.1)
    expect(drive('canopyswitch', { canopyTarget: 1, canopy: 0.3 })).toBe(1)
    expect(drive('canopyswitch', { canopyTarget: 1, canopy: 1 })).toBe(0.5)
    expect(drive('canopyswitch', { canopyTarget: 0, canopy: 0.3 })).toBe(0)
    expect(drive('canopyswitch', { canopyTarget: 0, canopy: 0 })).toBe(0.5)
    expect(drive('canopyswitch', {})).toBe(0.5)
    expect(drive('canopyswitch', { canopyTarget: 1, canopy: 0.3 }, { cranked: true })).toBe(0.5) // the hand crank moves the canopy and leaves the switch at HOLD (#113)
    // the fold handle's clip turns SPREAD counterclockwise to FOLD, HOLD between; LOCK is SPREAD pushed in (foldpull)
    expect(['fold', 'hold', 'spread', 'lock'].map((handle) => drive('foldswitch', {}, { handle }))).toEqual([1, 0.5, 0, 0])
    expect(drive('foldswitch', { foldTarget: 1 }, { handle: 'lock' }, true)).toBe(1) // another jet's follows its wings
    expect(drive('foldswitch', { foldTarget: 0 }, {}, true)).toBe(0)
    expect(drive('barswitch', { barTarget: 1 })).toBe(1)
    expect(drive('barswitch', {})).toBe(0)
    // the PROBE clip runs EMERG EXTD (aft) to EXTEND (forward), RETRACT in the middle (FO-5)
    expect(drive('probeswitch', { probeTarget: 1 })).toBe(1)
    expect(drive('probeswitch', { probeTarget: 0 })).toBe(0.5)
  })

  it('read the exterior lights panel, each control from its own setting, and leave another jet\'s at rest', () => {
    expect(drive('ldglight', {}, { exterior: { landing: true } })).toBe(1)
    expect(drive('ldglight', {}, { exterior: { landing: false } })).toBe(0)
    expect(drive('ldglight', {}, { exterior: { landing: true } }, true)).toBe(0)
    // the STROBE clip runs aft to forward: DIM, OFF in the middle, BRT (2.6.1.4)
    expect(['dim', 'off', 'bright'].map((strobe) => drive('strobe', {}, { exterior: { strobe } }))).toEqual([0, 0.5, 1])
    expect(drive('strobe', {}, { exterior: { strobe: 'bright' } }, true)).toBe(0.5)
    expect(drive('formation', {}, { exterior: { formation: 0.75 } })).toBe(0.75)
    expect(drive('position', {}, { exterior: { position: 0.25 } })).toBe(0.25)
    expect(drive('formation', {}, { exterior: { formation: 0.75 } }, true)).toBe(0)
    expect(drive('position', {}, { exterior: { position: 0.25 } }, true)).toBe(0)
    // the master switch moves none of the panel's controls
    expect(drive('ldglight', { lights: true }, { exterior: { landing: false } })).toBe(0)
  })

  it('read the ownship-only switches from their state, and leave them at rest on other aircraft', () => {
    expect(drive('parkbrake', {}, { parking: true })).toBe(1)
    expect(drive('parkbrake', {}, { parking: false })).toBe(0)
    expect(drive('parkbrake', {}, { parking: true }, true)).toBe(0)
    expect(drive('altswitch', {}, { alt_radar: true })).toBe(1)
    expect(drive('altswitch', {}, { alt_radar: true }, true)).toBe(0)
    expect(drive('dumpswitch', {}, { fuel_dump: true })).toBe(1)
    expect(drive('dumpswitch', {}, { fuel_dump: true }, true)).toBe(0)
  })

  it('set the REJ switch to NORM, REJ 1 and REJ 2 from the declutter level', () => {
    expect(drive('rejswitch', {}, { declutter: 0 })).toBe(0)
    expect(drive('rejswitch', {}, { declutter: 1 })).toBe(0.5)
    expect(drive('rejswitch', {}, { declutter: 2 })).toBe(1)
    expect(drive('rejswitch', {}, { declutter: 2 }, true)).toBe(0)
  })

  it('set the RADAR knob to STBY under radar silence and OPR otherwise', () => {
    expect(drive('radaropr', {}, { sil: true })).toBeCloseTo(1 / 3)
    expect(drive('radaropr', {}, { sil: false })).toBeCloseTo(2 / 3)
    expect(drive('radaropr', {}, { sil: true }, true)).toBeCloseTo(2 / 3)
  })

  // The FLAP switch (NATOPS 2.8.2.2.1) stands where the pilot put it, whatever the
  // gear is doing; other aircraft send no selection, so theirs follows the gear.
  it('set the FLAP switch lever to AUTO, HALF and FULL from the selection', () => {
    const line = /\n\t\tcase "flaplever":[^\n]*\n/.exec(source)?.[0] ?? ''
    expect(line).not.toBe('')
    const run = new Function('st', 'ownship', 'flap_select', `let f; switch("flaplever"){ ${line} } return f;`)
    // gearTarget and gear run 0 down to 1 up
    const own = (flap: number, gearTarget: number, grounded: boolean) => { const st = { gearTarget, grounded }; return run(st, st, flap) }
    for (const [gear, grounded, where] of [[1, false, 'gear up'], [0, false, 'gear down'], [0, true, 'on deck']] as [number, boolean, string][]) {
      expect(own(0, gear, grounded), `AUTO, ${where}`).toBe(0)
      expect(own(1, gear, grounded), `HALF, ${where}`).toBe(0.5)
      expect(own(2, gear, grounded), `FULL, ${where}`).toBe(1)
    }
    const other = (gear: number, grounded: boolean) => run({ gear, grounded }, {}, 2)
    expect(other(1, false)).toBe(0)
    expect(other(0, true)).toBe(0.5)
    expect(other(0, false)).toBe(1)
  })

  it('spring the DUMP switch back to OFF when BINGO comes on, and end the dump at FUEL LO (NATOPS 2.2.7)', () => {
    const line = /\n\tif\(fuel_dump&&\(bingo_low\(\)\|\|fuel_low\(\)\)\) fuel_dump=false;/.exec(source)?.[0] ?? ''
    expect(line).not.toBe('')
    const run = new Function('fuel_dump', 'bingo_low', 'fuel_low', `${line} return fuel_dump;`)
    expect(run(true, () => false, () => false)).toBe(true)
    expect(run(true, () => true, () => false)).toBe(false)
    expect(run(true, () => false, () => true)).toBe(false)
    expect(run(false, () => false, () => false)).toBe(false)
  })

  it('store the scrubbed fraction on the entry and report it from the probe', () => {
    expect(source).toMatch(/if\(r\.flip\) f=1-f;\n\t\tr\.scrub=f;/)
    expect(source).toMatch(/scrub:Object\.fromEntries\(\(ownship\.group\.userData\.rig\|\|\[\]\)\.filter\(e=>e\.clip&&e\.scrub!==undefined\)\.map\(e=>\[e\.name,\+e\.scrub\.toFixed\(3\)\]\)\)/)
  })
})

// The switches are click targets (#19): a stationary press on a switch's mesh, or
// within a few pixels of its origin, fires the same action as its key through
// pit_press, the right button up, forward or clockwise and the left the other way.
// pit_press is lifted from engine.ts and run against stand-ins for the state it works.
const pressfn = /\nfunction pit_press\(action,direction\)\{ const d=[\s\S]*?\n\t\} \}\n/.exec(source)?.[0] ?? ''
const indexfn = /\nfunction index_step\(index,direction\)\{[^\n]*\n[^\n]*\n/.exec(source)?.[0] ?? ''
const crankfn = /\nfunction canopy_crank\(d\)\{[^\n]*\n[^\n]*\n[^\n]*\n/.exec(source)?.[0] ?? ''
const foldfn = /\nconst FOLD_HANDLE=[^\n]*\nlet fold_handle="lock";\nfunction fold_set\(handle\)\{[^\n]*\n(?:\/\/[^\n]*\n)*function fold_turn\(d\)\{[^\n]*\n[^\n]*\n[^\n]*\n[^\n]*\n/.exec(source)?.[0] ?? ''
interface Pit {
  squish?: number; speed?: number; ground?: boolean; canopyTarget?: number; foldTarget?: number; gearTarget?: number; hookTarget?: number
  probeTarget?: number; lights?: boolean; parking?: boolean; alt_radar?: boolean; declutter?: number; fuel_dump?: boolean; sil?: boolean
  hook_bypass?: string; flap_select?: number; peak_g?: number; index?: number; on?: boolean; bingo?: boolean; fuellow?: boolean
  exterior?: Partial<Panel>; handle?: string; fold?: number; gone?: boolean; essential?: boolean; armed?: boolean; canopy?: number
}
interface Pressed {
  ownship: { canopyTarget: number; foldTarget: number; gearTarget: number; hookTarget: number; probeTarget: number; lights: boolean }
  parking: boolean; alt_radar: boolean; declutter: number; fuel_dump: boolean; hook_bypass: string; flap_select: number; flap_armed: number; sil: boolean; notices: string[]; masters: string[]; peak_g: number; index: number; on: boolean; greet: boolean; test: number
  exterior: Panel; clicked: number; handle: string; sari: number; gone: boolean; cranked: boolean; armed: boolean
}
function press(action: string, direction: number, state: Pit = {}): Pressed {
  if (!pressfn || !foldfn) throw new Error('pit_press or the fold handle not found in engine.ts')
  const run = new Function('action', 'direction', 'state', 'panel', 'STROBE', `
    const exterior={ ...panel, ...state.exterior }, ownship={ squish:state.squish??1, speed:state.speed??0, canopy:state.canopy??0, canopyTarget:state.canopyTarget??0, foldTarget:state.foldTarget??0, gearTarget:state.gearTarget??0, hookTarget:state.hookTarget??0, probeTarget:state.probeTarget??0, lights:!!state.lights, grounded:state.ground??true };
    let canopy_gone=!!state.gone, cranked=false, seat_armed=state.armed??true; const buses={ essential:state.essential??true };
    let gear_emergency=!!state.emergency, parking=!!state.parking, alt_radar=!!state.alt_radar, declutter=state.declutter??0, fuel_dump=!!state.fuel_dump, hook_bypass=state.hook_bypass??"carrier", flap_select=state.flap_select??0, flap_armed=0, peak_g=state.peak_g??1, law_index=state.index??200, radalt_on=state.on??true, radalt_test=-Infinity, radalt_greet=false, lights_clicked=-Infinity, sari_clicked=-Infinity;
    const THREE={MathUtils:{clamp:(v,lo,hi)=>Math.min(hi,Math.max(lo,v))}}, RADAR={ sil:!!state.sil }, bingo_low=()=>!!state.bingo, fuel_low=()=>!!state.fuellow, sim_time=10, glance=10, notices=[], notice=(t)=>notices.push(t), translate=(t)=>t, on_ground=()=>state.ground??true, masters=[], set_master=(m)=>masters.push(m);
    ${pressfn} ${indexfn} ${foldfn} ${crankfn}
    fold_handle=state.handle??"lock"; ownship.fold=state.fold??0;
    pit_press(action, direction);
    return { ownship, parking, alt_radar, declutter, fuel_dump, hook_bypass, flap_select, flap_armed, sil:RADAR.sil, notices, masters, peak_g, index:law_index, on:radalt_on, greet:radalt_greet, test:radalt_test, exterior, clicked:lights_clicked, handle:fold_handle, sari:sari_clicked, gone:canopy_gone, cranked, armed:seat_armed };`)
  return run(action, direction, state, panel, strobe) as Pressed
}

describe('the clickable switches', () => {
  it('list every driven switch and handle with the action a click fires, the launch bar with none', () => {
    const table = /const PIT_SWITCHES=\{([\s\S]*?)\};/.exec(source)?.[1] ?? ''
    const expected: [string, string | null][] = [
      ['canopyswitch', 'canopy'], ['foldswitch', 'fold'], ['parkbrake', 'brake.parking'], ['parkpull', 'brake.parking'], ['barswitch', null],
      ['probeswitch', 'probe'], ['altswitch', 'altitude'], ['rejswitch', 'reject'], ['ldglight', 'landing'], ['strobe', 'strobe'], ['formation', 'formation'], ['position', 'position'],
      ['dumpswitch', 'dump'], ['radaropr', 'radar'], ['hookbypass', 'hook.bypass'], ['antiskid', 'antiskid'], ['gearlever', 'gear'], ['hooklever', 'hook'], ['flaplever', 'flaps'], ['lttest', 'lights.test'],
      // G1: the interior lights' knobs (#23), the HUD panel and the UFC's BRT (#11, #115), the electrical panel (#21), BLEED AIR (#22), FIRE TEST (#17), RUD TRIM (#19) and EXT TANKS (#18)
      ['instpnl', 'knob.instrument'], ['consoles', 'knob.consoles'], ['flood', 'knob.flood'], ['warncaut', 'knob.warn'], ['symbology', 'knob.symbology'], ['indexer', 'knob.indexer'], ['ufcbrt', 'knob.ufc'],
      ['attswitch', 'attitude'], ['battery', 'battery'], ['genleft', 'generator.left'], ['genright', 'generator.right'], ['bleed', 'bleed'], ['firetest', 'fire.test'], ['ruddertrim', 'rudder.trim'],
      ['wingtanks', 'transfer.wing'], ['centretank', 'transfer.centre'],
      // G3: the INS mode select knob (#24)
      ['insknob', 'ins'],
      // G5: the communication panel's RWR and WPN volume controls (#20)
      ['volumereceiver', 'volume.receiver'], ['volumeweapon', 'volume.weapon'],
    ]
    for (const [name, action] of expected) expect(table, name).toContain(`${name}:${action === null ? 'null' : `"${action}"`}`)
    expect(table.match(/\w+:/g)?.length).toBe(expected.length)
    expect(table).toMatch(/\.\.\.Object\.fromEntries\(Object\.keys\(TRAVEL\)\.map\(k=>\[k,"travel\."\+k\]\)\) $/) // and every travel-only control, to travel_press
    // the targets are built from the rig: the clip's nodes and every mesh under them
    expect(source).toMatch(/g\.userData\.switches=g\.userData\.rig\.filter\(r=>r\.clip&&r\.name in PIT_SWITCHES\)/)
  })

  it('route the right button to the switches and keep the context menu closed', () => {
    expect(source).toMatch(/stage\.addEventListener\("contextmenu",e=>e\.preventDefault\(\)/)
    // the middle button too: a stationary press, the height indicator's push-to-test (#58)
    expect(source).toMatch(/if\(e\.button===2\|\|e\.button===1\)\{ right_press=\(cfg\.view==="cockpit"&&running&&!map_on\)\?\{ x:e\.clientX, y:e\.clientY \}:null; e\.preventDefault\(\); return; \}/)
    expect(source).toMatch(/if\(e\.button===2\|\|e\.button===1\)\{ const r=right_press; right_press=null; if\(r&&Math\.abs\(e\.clientX-r\.x\)\+Math\.abs\(e\.clientY-r\.y\)<6\) pit_click\(e\); return; \}/)
    expect(source).toMatch(/if\(e\.button===2\)\{ if\(!playback\) pit_switch\(e\); return; \}/)   // a replay's switches are the recording's
    // a left click reaches the displays' bezel pushbuttons and then the switches only after the screens miss, ahead of the panel-point measurement
    expect(source).toMatch(/if\(!hit\|\|!hit\.uv\)\{\n\t\t\{ const b=ddi_button_at\(e\.clientX,e\.clientY\); if\(b\)\{ if\(ddi_press\(b\.display,b\.pb\)\) screens_update\(\); return; \} \}[^\n]*\n\t\tif\(pit_switch\(e\)\) return;[^\n]*\n\t\tif\(PANEL_POINT\)/)
    expect(source).toMatch(/if\(hit\.action\) pit_press\(hit\.action,e\.button===2\?1:-1\);/)
  })

  it('send every clickable key through pit_press so a click and its key share one gate', () => {
    for (const [action, direction] of [['canopy', 0], ['fold', 0], ['probe', 0], ['altitude', 0], ['reject', 0], ['hook', 0], ['brake.parking', 0], ['gear', 0], ['hook.bypass', 0], ['dump', 0]] as [string, number][])
      expect(source, action).toMatch(new RegExp(`if\\(ch===key_of\\("${action.replace('.', '\\.')}"\\)\\) pit_press\\("${action.replace('.', '\\.')}",${direction}\\);`))
    expect(source).toMatch(/if\(ch===key_of\("lights"\) && !dev_parked\) pit_press\("lights",0\);/)
    expect(source).toMatch(/if\(ch===key_of\("radar\.silent"\)\) pit_press\("radar",0\);/)
    expect(source).toMatch(/if\(ch===key_of\("flaps\.extend"\)\) pit_press\("flaps",-1\);/)
    expect(source).toMatch(/if\(ch===key_of\("flaps\.retract"\)\) pit_press\("flaps",1\);/)
    expect(source).toMatch(/if\(ch===key_of\("view\.hud"\)\)\{ if\(cfg\.view==="hud"\) pit_press\("reject",0\); else set_view\("hud",source\); \}/)
  })

  it('open the canopy on a right click and close it on a left, on the ground only', () => {
    expect(press('canopy', 1).ownship.canopyTarget).toBe(1)
    expect(press('canopy', -1, { canopyTarget: 1 }).ownship.canopyTarget).toBe(0)
    expect(press('canopy', 0, { canopyTarget: 1 }).ownship.canopyTarget).toBe(0)
    const airborne = press('canopy', 1, { squish: 0, speed: 200 })
    expect(airborne.ownship.canopyTarget).toBe(0)
    expect(airborne.notices).toEqual(['CANOPY LOCKED'])
  })

  // The canopy's emergency controls (#113, NATOPS 2.15.1.1.3, 2.15.1.2): the
  // switch runs on the essential bus and drives nothing once the canopy is gone;
  // the jettison handle fires only on a pull, a middle click or its key, never a
  // left or right click; the hand crank steps it without power, clockwise (the
  // right button) closed, on the ground only.
  it('needs the essential bus for the canopy switch, and leaves it nothing to drive once the canopy is gone', () => {
    expect(press('canopy', 1, { essential: false }).ownship.canopyTarget).toBe(0)
    expect(press('canopy', 1, { gone: true }).ownship.canopyTarget).toBe(0)
    expect(press('canopy', 1).cranked).toBe(false)
  })

  it('jettisons the canopy on a pull of its handle and on nothing else', () => {
    expect(press('canopy.jettison', 0).gone).toBe(true)
    expect(press('canopy.jettison', 1).gone).toBe(false)
    expect(press('canopy.jettison', -1).gone).toBe(false)
  })

  it('cranks the canopy a step a click without power, clockwise closed, on the ground only', () => {
    expect(crankfn).not.toBe('')
    const open = press('canopy.crank', -1, { essential: false })
    expect(open.ownship.canopyTarget).toBeCloseTo(0.05)
    expect(open.cranked).toBe(true)
    expect(press('canopy.crank', 1, { canopy: 0.5, canopyTarget: 0.5 }).ownship.canopyTarget).toBeCloseTo(0.45) // from where the canopy stands, clockwise toward closed
    const airborne = press('canopy.crank', -1, { squish: 0, speed: 200 })
    expect(airborne.ownship.canopyTarget).toBe(0)
    expect(airborne.notices).toEqual(['CANOPY LOCKED'])
    expect(press('canopy.crank', -1, { gone: true }).ownship.canopyTarget).toBe(0)
  })

  it('turns the seat between SAFE and ARMED on either button (#112, 2.15.3.5)', () => {
    expect(press('seat', 1).armed).toBe(false)
    expect(press('seat', -1, { armed: false }).armed).toBe(true)
  })

  it('work the wing fold handle through FOLD, HOLD, SPREAD and LOCK, a left click counterclockwise and a right clockwise and in', () => {
    // the wing fold handle (2.11.1): the left button counterclockwise, out of LOCK first, the right clockwise and then in
    const turn = (handle: string, d: number, fold = 0) => { const r = press('fold', d, { handle, fold }); return [r.handle, r.ownship.foldTarget] }
    expect([turn('lock', -1), turn('spread', -1), turn('hold', -1, 0.4), turn('fold', -1, 1)]).toEqual([['spread', 0], ['hold', 0], ['fold', 1], ['fold', 1]])
    expect([turn('fold', 1, 1), turn('hold', 1, 0.4), turn('spread', 1), turn('lock', 1)]).toEqual([['hold', 1], ['spread', 0], ['lock', 0], ['lock', 0]])
    expect(turn('hold', -1, 0.4)[0]).toBe('fold')
    expect(turn('fold', 1, 0.6)).toEqual(['hold', 0.6]) // HOLD stops the wings where they are
    expect(turn('spread', 1, 0.3)).toEqual(['spread', 0]) // no LOCK until the wings are fully spread
    // the key's cycle: LOCK to FOLD, FOLD or HOLD to SPREAD, SPREAD to LOCK once spread
    expect([turn('lock', 0), turn('fold', 0, 1), turn('hold', 0, 0.5), turn('spread', 0), turn('spread', 0, 0.5)]).toEqual([['fold', 1], ['spread', 0], ['spread', 0], ['lock', 0], ['spread', 0]])
    expect(press('fold', -1, { speed: 20 }).notices).toEqual(['WINGS LOCKED'])
    expect(press('fold', -1, { speed: 20 }).handle).toBe('lock')
  })

  it('step the reject switch down to REJ 2 and up to NORM without wrapping, and cycle it from the key', () => {
    expect(press('reject', -1, { declutter: 0 }).declutter).toBe(1)
    expect(press('reject', -1, { declutter: 2 }).declutter).toBe(2)
    expect(press('reject', 1, { declutter: 1 }).declutter).toBe(0)
    expect(press('reject', 1, { declutter: 0 }).declutter).toBe(0)
    expect(press('reject', 0, { declutter: 2 }).declutter).toBe(0)
  })

  it('turn the RADAR knob clockwise to OPR and back to STBY', () => {
    expect(press('radar', 1, { sil: true }).sil).toBe(false)
    expect(press('radar', -1, { sil: false }).sil).toBe(true)
    expect(press('radar', 0, { sil: false }).sil).toBe(true)
  })

  it('raise and lower the gear handle only once airborne', () => {
    expect(press('gear', 1, { ground: false }).ownship.gearTarget).toBe(1)
    expect(press('gear', -1, { ground: false, gearTarget: 1 }).ownship.gearTarget).toBe(0)
    expect(press('gear', 1, { ground: true }).ownship.gearTarget).toBe(0)
  })

  it('turn the radar altimeter\'s index knob a notch, the right button clockwise to raise it (NATOPS 2.12.5.4.1)', () => {
    expect(press('index', 1, { index: 200 }).index).toBe(250)
    expect(press('index', -1, { index: 200 }).index).toBe(150)
    expect(press('index', 1, { index: 40 }).index).toBe(50)
  })

  // NATOPS 2.12.5.4.1: turning the knob clockwise applies power to the set, further
  // clockwise raises the index; fully anticlockwise it is off. Pushing it runs the BIT.
  it('power the radar altimeter with its knob: off past index 0, on again clockwise with the familiarisation whoop on the ground', () => {
    expect(press('index', -1, { index: 10 })).toMatchObject({ index: 0, on: true })
    expect(press('index', -1, { index: 0 })).toMatchObject({ index: 0, on: false })
    expect(press('index', 1, { index: 0, on: false })).toMatchObject({ index: 0, on: true, greet: true })
    expect(press('index', 1, { index: 0, on: false, ground: false })).toMatchObject({ on: true, greet: false })
    expect(press('index', -1, { index: 0, on: false })).toMatchObject({ on: false })
  })

  it('run the BIT on a push, only with the set powered', () => {
    expect(press('radalt.test', 0).test).toBe(10)
    expect(press('radalt.test', 0, { on: false }).test).toBe(-Infinity)
  })

  it('clear peak g when the reject switch moves into a reject position, and not on the way back to NORM (NATOPS 2.13.4.8.11 item 8)', () => {
    expect(press('reject', -1, { declutter: 0, peak_g: 6.2 }).peak_g).toBe(1) // NORM to REJ 1
    expect(press('reject', -1, { declutter: 1, peak_g: 6.2 }).peak_g).toBe(1) // REJ 1 to REJ 2
    expect(press('reject', 1, { declutter: 1, peak_g: 6.2 }).peak_g).toBe(6.2) // REJ 1 to NORM
    expect(press('reject', 0, { declutter: 2, peak_g: 6.2 }).peak_g).toBe(6.2) // the key's cycle from REJ 2 wraps to NORM
  })

  it('enter the NAV master mode when the gear handle is lowered, and only then (NATOPS 2.13.2)', () => {
    expect(press('gear', -1, { ground: false, gearTarget: 1 }).masters).toEqual(['nav'])
    expect(press('gear', 0, { ground: false, gearTarget: 1 }).masters).toEqual(['nav'])
    expect(press('gear', 1, { ground: false, gearTarget: 0 }).masters).toEqual([]) // raising it leaves the mode alone
    expect(press('gear', -1, { ground: false, gearTarget: 0 }).masters).toEqual([]) // already down
    expect(press('gear', -1, { ground: true, gearTarget: 1 }).masters).toEqual([]) // the handle does not move on deck
  })

  it('move the flap lever one notch, FULL at the bottom, and arm the selection', () => {
    const down = press('flaps', -1, { flap_select: 0 })
    expect(down.flap_select).toBe(1)
    expect(down.flap_armed).toBe(14)
    expect(press('flaps', -1, { flap_select: 2 }).flap_select).toBe(2)
    expect(press('flaps', 1, { flap_select: 1 }).flap_select).toBe(0)
    expect(press('flaps', 1, { flap_select: 0 }).flap_select).toBe(0)
  })

  it('toggle the two-position controls on either button', () => {
    for (const d of [1, -1]) {
      expect(press('probe', d).ownship.probeTarget).toBe(1)
      expect(press('altitude', d).alt_radar).toBe(true)
      expect(press('lights', d).ownship.lights).toBe(true)
      expect(press('landing', d, { exterior: { landing: false } }).exterior.landing).toBe(true)
      expect(press('dump', d).fuel_dump).toBe(true)
      expect(press('hook.bypass', d).hook_bypass).toBe('field')
      expect(press('hook', d).ownship.hookTarget).toBe(1)
    }
  })

  it('set the exterior lights panel apart from the master switch (NATOPS 2.6.1)', () => {
    // STROBE: the right button forward toward BRT, the left aft toward DIM, stopping at each end
    const step = (from: string, d: number) => press('strobe', d, { exterior: { strobe: from } }).exterior.strobe
    expect([step('bright', -1), step('off', -1), step('dim', -1)]).toEqual(['off', 'dim', 'dim'])
    expect([step('dim', 1), step('off', 1), step('bright', 1)]).toEqual(['off', 'bright', 'bright'])
    // the knobs: a quarter of the way a click, clockwise brighter, between OFF and BRT
    for (const knob of ['position', 'formation'] as const) {
      const turn = (from: number, d: number) => press(knob, d, { exterior: { [knob]: from } }).exterior[knob]
      expect([turn(1, -1), turn(0.25, -1), turn(0, -1), turn(0.75, 1), turn(1, 1)], knob).toEqual([0.75, 0, 0, 1, 1])
    }
    // none of the panel's controls moves the master switch, nor the master the panel
    expect(press('landing', -1, { exterior: { landing: true } }).exterior.landing).toBe(false)
    const on = press('landing', 1, { lights: true, exterior: { landing: false } })
    expect([on.ownship.lights, on.exterior.landing]).toEqual([true, true])
    expect(press('lights', 1, { exterior: { landing: false, strobe: 'dim' } }).exterior).toEqual({ ...panel, landing: false, strobe: 'dim' })
    expect(panel).toEqual({ position: 1, formation: 1, strobe: 'bright', landing: false }) // BRT on both knobs and the strobes as the jet comes
    expect(strobe).toEqual(['dim', 'off', 'bright'])
  })

  it('put the LT TEST switch to TEST on a click, from which it springs back', () => {
    expect(press('lights.test', 1).clicked).toBe(10) // the click's time on the pilot's clock
    expect(press('lights.test', -1).clicked).toBe(10)
    expect(press('sari.test', 0).sari).toBe(10) // the standby attitude indicator's TEST switch too
  })

  it('hold the DUMP switch ON only with BINGO and FUEL LO off, and let it go OFF any time (NATOPS 2.2.7)', () => {
    expect(press('dump', 1, { bingo: true }).fuel_dump).toBe(false)
    expect(press('dump', 1, { fuellow: true }).fuel_dump).toBe(false)
    expect(press('dump', 1, { fuel_dump: true, fuellow: true }).fuel_dump).toBe(false)
    expect(press('dump', 1, { fuel_dump: true }).fuel_dump).toBe(false)
  })
})

// The cockpit pointer (#105): the mouse is the pilot's hand on the panel, so the
// pointer shows while it moves, and a ring marks what a click there would work.
describe('the cockpit pointer', () => {
  const top = (name: string) => {
    const start = source.indexOf(`function ${name}(`)
    expect(start, name).toBeGreaterThan(0)
    const rest = source.slice(start)
    const end = /\n(?=\S)/.exec(rest.slice(1))
    return end ? rest.slice(0, end.index + 1) : rest
  }

  it('shows in the cockpit view for two seconds after the mouse moves, and nowhere else', () => {
    const shown = (view: string, ago: number, map = false) => new Function('view', 'ago', 'map', `
      const POINTER_IDLE=2, cfg={ view }, map_on=map, performance={ now:()=>100000 }, pointer={ moved:100-ago };
      ${top('pointer_shown')} return pointer_shown();`)(view, ago, map) as boolean
    expect(shown('cockpit', 0.5)).toBe(true)
    expect(shown('cockpit', 1.9)).toBe(true)
    expect(shown('cockpit', 2.1)).toBe(false) // still: it hides again
    expect(shown('cockpit', 0.5, true)).toBe(false) // the map is up
    for (const view of ['hud', 'chase', 'flypast', 'padlock']) expect(shown(view, 0.5), view).toBe(false)
  })

  it('lets the pointer through the flying cursor rule while it is shown, and rings the target after the HUD', () => {
    expect(source).toMatch(/stage\.style\.cursor=\(running && !game_paused && !playback && cfg\.view!=="ddi" && !pointer_shown\(\) && !PANEL_POINT/)
    expect(source).toMatch(/if\(running\)\{ draw_hud\(\); pointer_draw\(\);/)
    expect(source).toMatch(/stage\.addEventListener\("pointermove",pointer_seen,\{ signal \}\);/)
    expect(source).toMatch(/stage\.addEventListener\("pointerdown",pointer_seen,\{ signal \}\);/)
  })

  // decl lifts a top-level const declaration, to the next line that starts in column one.
  const decl = (prefix: string) => {
    const start = source.indexOf(prefix)
    expect(start, prefix).toBeGreaterThan(0)
    const rest = source.slice(start)
    const end = /\n(?=\S)/.exec(rest.slice(1))
    return end ? rest.slice(0, end.index + 2) : rest
  }
  // The pilot's eye in the jet's frame, looking down at the displays, on a 1280 by 761 view.
  const eye = () => {
    const camera = new THREE.PerspectiveCamera(60, 1280 / 761, 0.01, 10)
    camera.position.set(5.55, 0.62, 0)
    camera.lookAt(6.163, 0.3, 0)
    camera.updateMatrixWorld(true)
    return camera
  }
  const displays = ['left', 'right', 'center'] as const
  type Display = (typeof displays)[number]

  it('presses the pushbutton beside each legend', () => {
    const lifted = new Function('THREE', `${decl('const DDI_BUTTONS=')}${decl('const DDI_BUTTON=')}${decl('const DDI_FACE=')}${top('button_of')}${top('ddi_button')} return { button_of, ddi_button, DDI_FACE };`)(THREE) as {
      button_of: (x: number, y: number) => number
      ddi_button: (display: Display, pb: number) => THREE.Vector3
      DDI_FACE: Record<Display, { y: [number, number]; z: [number, number] }>
    }
    for (const display of displays) {
      const face = lifted.DDI_FACE[display], sums = new Map<number, [number, number, number]>()
      for (let x = 2; x < 512; x += 4) for (let y = 2; y < 512; y += 4) {
        const pb = lifted.button_of(x, y), sum = sums.get(pb) ?? [0, 0, 0]
        if (pb) sums.set(pb, [sum[0] + x, sum[1] + y, sum[2] + 1])
      }
      expect(sums.size, display).toBe(20)
      // each legend's edge of the glass, and where along it the legend reads: across from the left, down from the top
      const sides = { left: [] as number[][], top: [] as number[][], right: [] as number[][], bottom: [] as number[][] }
      for (const [pb, [x, y, n]] of sums) {
        const [u, v] = [x / n, y / n]
        if (u < 56) sides.left.push([pb, v]); else if (v < 56) sides.top.push([pb, u]); else if (u > 456) sides.right.push([pb, v]); else sides.bottom.push([pb, u])
      }
      const outside = { left: (c: THREE.Vector3) => c.z < face.z[0], top: (c: THREE.Vector3) => c.y > face.y[1], right: (c: THREE.Vector3) => c.z > face.z[1], bottom: (c: THREE.Vector3) => c.y < face.y[0] }
      const along = { left: (c: THREE.Vector3) => -c.y, top: (c: THREE.Vector3) => c.z, right: (c: THREE.Vector3) => -c.y, bottom: (c: THREE.Vector3) => c.z }
      for (const side of ['left', 'top', 'right', 'bottom'] as const) {
        const legends = sides[side]
        expect(legends.length, `${display} ${side}`).toBe(5)
        for (const [pb] of legends) expect(outside[side](lifted.ddi_button(display, pb)), `${display} ${pb} beside the ${side} edge`).toBe(true)
        const byLegend = [...legends].sort((a, b) => a[1] - b[1]).map((l) => l[0])
        const byCap = [...legends].sort((a, b) => along[side](lifted.ddi_button(display, a[0])) - along[side](lifted.ddi_button(display, b[0]))).map((l) => l[0])
        expect(byCap, `${display} ${side}`).toEqual(byLegend)
      }
    }
  })

  it('finds the pushbutton under the pointer on each bezel, within its cap', () => {
    const lifted = new Function('THREE', 'ownship', 'cockpit_cam', 'HW', 'HH', `${decl('const DDI_BUTTONS=')}${decl('const DDI_BUTTON=')}${top('ddi_button')}${decl('const _screen_at=')}${top('screen_of')}${top('ddi_button_at')} return { ddi_button, screen_of, ddi_button_at, DDI_BUTTON };`)(
      THREE, { group: new THREE.Group() }, eye(), 1280, 761
    ) as {
      ddi_button: (display: Display, pb: number) => THREE.Vector3
      screen_of: (local: THREE.Vector3, radius: number) => [number, number, number] | null
      ddi_button_at: (x: number, y: number) => { display: Display; pb: number } | null
      DDI_BUTTON: number
    }
    for (const display of displays) for (let pb = 1; pb <= 20; pb++) {
      const at = lifted.screen_of(lifted.ddi_button(display, pb), lifted.DDI_BUTTON)
      expect(at, `${display} ${pb}`).not.toBeNull()
      const [x, y, r] = at as [number, number, number]
      expect(r, `${display} ${pb}`).toBeGreaterThan(3)
      expect(lifted.ddi_button_at(x, y), `${display} ${pb}`).toEqual({ display, pb })
      expect(lifted.ddi_button_at(x + r * 0.9, y), `${display} ${pb} at its edge`).toEqual({ display, pb })
    }
    const one = lifted.screen_of(lifted.ddi_button('left', 1), lifted.DDI_BUTTON) as number[], two = lifted.screen_of(lifted.ddi_button('left', 2), lifted.DDI_BUTTON) as number[]
    expect(lifted.ddi_button_at((one[0] + two[0]) / 2, (one[1] + two[1]) / 2)).toBeNull() // between two caps
  })

  it('rings every control round, at its centre, in one of three standard sizes', () => {
    const lifted = new Function('THREE', 'ownship', 'cockpit_cam', 'HW', 'HH', `${decl('const _screen_at=')}${top('screen_of')}${decl('const MARK_SIZES=')}${decl('const _ring_at=')}${top('mark_ring')} return { mark_ring, screen_of, MARK_SIZES };`)(
      THREE, { group: new THREE.Group() }, eye(), 1280, 761
    ) as {
      mark_ring: (mark: object) => [number, number, number] | null
      screen_of: (local: THREE.Vector3, radius: number) => [number, number, number] | null
      MARK_SIZES: { radius: number; bound: number }[]
    }
    const [small, medium, large] = lifted.MARK_SIZES.map((k) => k.radius)
    const at = new THREE.Vector3(6.163, 0.3, 0)
    const sized = (radius: number) => lifted.screen_of(at, radius)
    const cube = (half: number) => ({ box: new THREE.Box3(at.clone().subScalar(half), at.clone().addScalar(half)) })
    expect(lifted.mark_ring({ at, radius: 0.006 })).toEqual(sized(small)) // a display pushbutton
    expect(lifted.mark_ring({ at, radius: 0.003 })).toEqual(lifted.mark_ring({ at, radius: 0.0095 })) // a toggle and a lens: one size
    expect(lifted.mark_ring(cube(0.013))).toEqual(sized(medium)) // a console switch, measured by its box
    expect(lifted.mark_ring(cube(0.02))).toEqual(sized(medium))
    expect(lifted.mark_ring(cube(0.025))).toEqual(sized(large)) // a handle
    expect(lifted.mark_ring(cube(0.04))).toEqual(sized(large)) // an instrument's face
    const lever = new THREE.Box3(new THREE.Vector3(6.15, 0.29, -0.004), new THREE.Vector3(6.17, 0.33, 0.004)) // 4 cm tall: centred on its box, not its corner
    expect(lifted.mark_ring({ box: lever })?.slice(0, 2)).toEqual(lifted.screen_of(new THREE.Vector3(6.16, 0.31, 0), medium)?.slice(0, 2))
    expect(lifted.mark_ring({ at: new THREE.Vector3(14, 0.3, 0), radius: 0.006 })?.[2]).toBe(6) // a far one stays in sight
    const drawn: number[][] = []
    const hctx = { save() {}, restore() {}, setTransform() {}, beginPath() {}, stroke() {}, arc: (...a: number[]) => drawn.push(a) }
    const pointer = { x: 0, y: 0, key: '', mark: null, screen: null as number[] | null }
    new Function('THREE', 'hctx', 'pointer', 'mark_ring', `const running=true, game_paused=false, playback=null, head_az=0, head_el=0, view_zoom=1, devicePixelRatio=1;
      const pointer_shown=()=>true, pit_hover=()=>({});
      ${top('pointer_draw')} pointer_draw();`)(THREE, hctx, pointer, () => [400, 300, 12])
    expect(drawn[0].slice(0, 3)).toEqual([400, 300, 12]) // drawn round, at the size mark_ring gives
    expect(pointer.screen).toEqual([400, 300, 12])
  })

  it('rings only what the eye sees of a part that runs on into the panel, and looks again once the head turns', () => {
    const g = new THREE.Group(), model = new THREE.Group()
    g.add(model)
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.4), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }))
    panel.rotation.y = Math.PI / 2 // facing the pilot, at x 6.2
    panel.position.set(6.2, 0.3, 0)
    const lever = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.01, 0.01)) // x 6.15 to 6.25: half of it behind the panel
    lever.position.set(6.2, 0.3, 0)
    model.add(panel, lever)
    g.updateMatrixWorld(true)
    const run = new Function('THREE', 'ownship', 'cockpit_cam', 'model_of', `const D2R=Math.PI/180, LAYER_OWN=1; let head_az=0, head_el=0;
      ${top('shown')}${decl('const SEEN_VERTICES=')}${decl('const _seen_ray=')}${decl('const _seen=')}${top('seen_of')}
      return (az, meshes) => { head_az=az*D2R; return seen_of(meshes,"lever"); };`)(THREE, { group: g }, eye(), () => model) as (az: number, meshes: THREE.Mesh[]) => { box: THREE.Box3 }
    const seen = run(0, [lever])
    expect(seen.box.min.x).toBeCloseTo(6.15, 6)
    expect(seen.box.max.x).toBeCloseTo(6.15, 6) // the near end only: the far end is behind the panel
    expect(run(1, [lever]).box).toBe(seen.box) // kept while the head stays within two degrees
    panel.visible = false
    expect(run(1, [lever]).box).toBe(seen.box)
    expect(run(3, [lever]).box.max.x).toBeCloseTo(6.25, 6) // looked at again: with the panel gone, all of it
  })

  it('drags the cockpit with the pointer on both axes, what it grabbed staying under it at any zoom', () => {
    const handler = /stage\.addEventListener\("pointermove",e=>\{ if\(!dragging\) return;[\s\S]*?\}, \{ signal \}\);/.exec(source)?.[0] ?? ''
    const compose = /camera\.quaternion\.copy\(ownship\.q\)\.multiply\(_headq\.setFromAxisAngle\(_yaxis,head_az\)\)\.multiply\(_pitq\.setFromAxisAngle\(_zaxis,head_el\+PIT_REST\)\)\.multiply\(CAMFIX\);/.exec(source)?.[0] ?? ''
    expect(handler, 'the drag handler').not.toBe('')
    expect(compose, 'the cockpit camera').not.toBe('')
    // the point at the middle of the view, seen through the cockpit camera as update_camera turns it, before and
    // after a drag: how many pixels it moves, on a 1280 by 761 view, at the cockpit's 72 degrees over the zoom
    const drag = (zoom: number) => new Function('THREE', 'zoom', `const D2R=Math.PI/180, HW=1280, HH=761; ${decl('const PIT_REST=')}${decl('const _headq=')}${decl('const CAMFIX=')}
      let dragging=true, head_drag=true, drag_x=640, drag_y=380, press_moved=0, head_az=0, head_el=0, cam_az=0, cam_el=0, move=null;
      const latch=()=>{}, ownship={ q:new THREE.Quaternion() }, stage={ addEventListener:(type, f)=>{ move=f; } }, signal=null;
      const camera=new THREE.PerspectiveCamera(72/zoom, HW/HH, 0.01, 10), cockpit_cam=camera;
      ${handler}
      ${compose} camera.updateMatrixWorld(true);
      const grabbed=camera.getWorldDirection(new THREE.Vector3());
      const seen=()=>{ ${compose} camera.updateMatrixWorld(true); const p=grabbed.clone().project(camera); return [p.x*HW/2, -p.y*HH/2]; };
      return (dx, dy)=>{ const before=seen(); move({ clientX:drag_x+dx, clientY:drag_y+dy }); const after=seen(); return [after[0]-before[0], after[1]-before[1]]; };`)(THREE, zoom) as (dx: number, dy: number) => [number, number]
    for (const zoom of [1, 4]) {
      const right = drag(zoom)(20, 0) // the pointer 20 px right: the point it grabbed goes with it
      expect(right[0], `${zoom}x right`).toBeCloseTo(20, 0)
      expect(Math.abs(right[1]), `${zoom}x right`).toBeLessThan(1)
      const down = drag(zoom)(0, 20) // and 20 px down
      expect(down[1], `${zoom}x down`).toBeCloseTo(20, 0)
      expect(Math.abs(down[0]), `${zoom}x down`).toBeLessThan(1)
    }
  })

  it('maps a quad\'s texture coordinates to its corners in the world', () => {
    const plane_point = new Function('THREE', `${top('plane_point')} return plane_point;`)(THREE) as (
      mesh: THREE.Mesh,
      u: number,
      v: number
    ) => THREE.Vector3
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.2))
    mesh.position.set(6, 0.5, -0.2)
    mesh.updateMatrixWorld(true)
    expect(plane_point(mesh, 0, 1).toArray()).toEqual([5.8, 0.6, -0.2]) // u left, v top
    plane_point(mesh, 1, 0).toArray().forEach((n, k) => expect(n).toBeCloseTo([6.2, 0.4, -0.2][k], 9))
    expect(plane_point(mesh, 0.5, 0.5).toArray()).toEqual([6, 0.5, -0.2])
  })

  it('looks for the target in the order a click does', () => {
    const order = (fn: string, marks: string[]) => marks.map((mark) => top(fn).indexOf(mark))
    const hover = order('pit_hover', ['sb.alt.mesh', 'sb.adi.mesh', 'u.radalt.mesh', 'ifei_button_at', 'ufc_button_at', 'l.caution', 'list.map(sc=>sc.mesh)', 'ddi_button_at(x,y)', 'pit_target('])
    const click = order('pit_click', ['u.alt.mesh', 'u.adi.mesh', 'pit_press("index"', 'ifei_button_at', 'ufc_button_at', 'l.caution', 'list.map(sc=>sc.mesh)', 'ddi_button_at(e.clientX,e.clientY)', 'if(pit_switch(e)) return;'])
    for (const [name, at] of [['hover', hover], ['click', click]] as const) {
      expect(at.every((k) => k > 0), `${name}: ${at}`).toBe(true)
      expect([...at].sort((a, b) => a - b), name).toEqual(at)
    }
  })
})
