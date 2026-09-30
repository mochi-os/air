// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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

interface Moment { hook: number; bypass: 'carrier' | 'field'; time: number }
interface Result { lit: boolean; bypass: string }
// Steps the block once per moment, on speed with the gear down and flying, and
// returns whether the donut is lit and where the switch ended up.
function indexer(moments: Moment[]): Result[] {
  if (!block) throw new Error('indexer block not found in engine.ts')
  const run = new Function('moments', `const D2R=Math.PI/180, STATE={alpha:0, extension:1}, THREE={MathUtils:{clamp:(v,lo,hi)=>Math.min(hi,Math.max(lo,v))}};
    const ind={slow:{opacity:0},donut:{opacity:0},fast:{opacity:0}}, ownship={hook:0,grounded:false};
    let sim_time=0, hook_bypass="carrier";
    const out=[8.1*D2R, 1];
    return moments.map((m)=>{ ownship.hook=m.hook; hook_bypass=m.bypass; sim_time=m.time;
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
  return new Function('on', `const D2R=Math.PI/180, STATE={alpha:0, extension:1}, INDEXER_TEST="", lamps_testing=on;
    const ind={slow:{opacity:0},donut:{opacity:0},fast:{opacity:0}}, ownship={hook:1,grounded:true};
    let sim_time=0, hook_bypass="carrier";
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
  return new Function('alpha', `const D2R=Math.PI/180, STATE={alpha:0, extension:1}, THREE={MathUtils:{clamp:(v,lo,hi)=>Math.min(hi,Math.max(lo,v))}};
    const ind={slow:{opacity:0},donut:{opacity:0},fast:{opacity:0}}, ownship={hook:1,grounded:false};
    let sim_time=0, hook_bypass="carrier";
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
    expect(settings.match(/id: 'hook\.bypass', label: msg`Hook bypass`, group: 'aircraft'/g)?.length).toBe(2)
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
interface Own { parking?: boolean; alt_radar?: boolean; declutter?: number; fuel_dump?: boolean; sil?: boolean; exterior?: Partial<Panel>; handle?: string }
// The exterior lights panel's state and the STROBE switch's positions, aft to forward, as engine.ts declares them.
const strobe = JSON.parse(/\nconst STROBE=(\[[^\n]*\]);/.exec(source)?.[1] ?? 'null') as string[] | null
const panel = new Function(`return ${/\nconst exterior=(\{[^\n]*\});/.exec(source)?.[1] ?? 'null'};`)() as Panel | null
// Runs one drive case for the aircraft st, which is the ownship unless foreign is set.
function drive(name: string, st: Craft, own: Own = {}, foreign = false): number | undefined {
  if (!cases) throw new Error('switch drive cases not found in engine.ts')
  const run = new Function('name', 'st', 'ownship', 'parking', 'alt_radar', 'declutter', 'fuel_dump', 'RADAR', 'exterior', 'STROBE', 'fold_handle',
    `let f; switch(name){ ${cases} } return f;`)
  const ownship = foreign ? {} : st
  return run(name, st, ownship, !!own.parking, !!own.alt_radar, own.declutter ?? 0, !!own.fuel_dump, { sil: !!own.sil }, { ...panel, ...own.exterior }, strobe, own.handle ?? 'lock') as number | undefined
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
const foldfn = /\nconst FOLD_HANDLE=[^\n]*\nlet fold_handle="lock";\nfunction fold_set\(handle\)\{[^\n]*\n(?:\/\/[^\n]*\n)*function fold_turn\(d\)\{[^\n]*\n[^\n]*\n[^\n]*\n[^\n]*\n/.exec(source)?.[0] ?? ''
interface Pit {
  squish?: number; speed?: number; ground?: boolean; canopyTarget?: number; foldTarget?: number; gearTarget?: number; hookTarget?: number
  probeTarget?: number; lights?: boolean; parking?: boolean; alt_radar?: boolean; declutter?: number; fuel_dump?: boolean; sil?: boolean
  hook_bypass?: string; flap_select?: number; peak_g?: number; index?: number; on?: boolean; bingo?: boolean; fuellow?: boolean
  exterior?: Partial<Panel>; handle?: string; fold?: number
}
interface Pressed {
  ownship: { canopyTarget: number; foldTarget: number; gearTarget: number; hookTarget: number; probeTarget: number; lights: boolean }
  parking: boolean; alt_radar: boolean; declutter: number; fuel_dump: boolean; hook_bypass: string; flap_select: number; flap_armed: number; sil: boolean; notices: string[]; masters: string[]; peak_g: number; index: number; on: boolean; greet: boolean; test: number
  exterior: Panel; clicked: number; handle: string; sari: number
}
function press(action: string, direction: number, state: Pit = {}): Pressed {
  if (!pressfn || !foldfn) throw new Error('pit_press or the fold handle not found in engine.ts')
  const run = new Function('action', 'direction', 'state', 'panel', 'STROBE', `
    const exterior={ ...panel, ...state.exterior }, ownship={ squish:state.squish??1, speed:state.speed??0, canopyTarget:state.canopyTarget??0, foldTarget:state.foldTarget??0, gearTarget:state.gearTarget??0, hookTarget:state.hookTarget??0, probeTarget:state.probeTarget??0, lights:!!state.lights, grounded:state.ground??true };
    let parking=!!state.parking, alt_radar=!!state.alt_radar, declutter=state.declutter??0, fuel_dump=!!state.fuel_dump, hook_bypass=state.hook_bypass??"carrier", flap_select=state.flap_select??0, flap_armed=0, peak_g=state.peak_g??1, law_index=state.index??200, radalt_on=state.on??true, radalt_test=-Infinity, radalt_greet=false, lights_clicked=-Infinity, sari_clicked=-Infinity;
    const THREE={MathUtils:{clamp:(v,lo,hi)=>Math.min(hi,Math.max(lo,v))}}, RADAR={ sil:!!state.sil }, bingo_low=()=>!!state.bingo, fuel_low=()=>!!state.fuellow, sim_time=10, notices=[], notice=(t)=>notices.push(t), translate=(t)=>t, on_ground=()=>state.ground??true, masters=[], set_master=(m)=>masters.push(m);
    ${pressfn} ${indexfn} ${foldfn}
    fold_handle=state.handle??"lock"; ownship.fold=state.fold??0;
    pit_press(action, direction);
    return { ownship, parking, alt_radar, declutter, fuel_dump, hook_bypass, flap_select, flap_armed, sil:RADAR.sil, notices, masters, peak_g, index:law_index, on:radalt_on, greet:radalt_greet, test:radalt_test, exterior, clicked:lights_clicked, handle:fold_handle, sari:sari_clicked };`)
  return run(action, direction, state, panel, strobe) as Pressed
}

describe('the clickable switches', () => {
  it('list every driven switch and handle with the action a click fires, the launch bar with none', () => {
    const table = /const PIT_SWITCHES=\{([\s\S]*?)\};/.exec(source)?.[1] ?? ''
    const expected: [string, string | null][] = [
      ['canopyswitch', 'canopy'], ['foldswitch', 'fold'], ['parkbrake', 'brake.parking'], ['parkpull', 'brake.parking'], ['barswitch', null],
      ['probeswitch', 'probe'], ['altswitch', 'altitude'], ['rejswitch', 'reject'], ['ldglight', 'landing'], ['strobe', 'strobe'], ['formation', 'formation'], ['position', 'position'],
      ['dumpswitch', 'dump'], ['radaropr', 'radar'], ['hookbypass', 'hook.bypass'], ['antiskid', 'antiskid'], ['gearlever', 'gear'], ['hooklever', 'hook'], ['flaplever', 'flaps'], ['lttest', 'lights.test'],
    ]
    for (const [name, action] of expected) expect(table, name).toContain(`${name}:${action === null ? 'null' : `"${action}"`}`)
    expect(table.match(/\w+:/g)?.length).toBe(expected.length)
    // the targets are built from the rig: the clip's nodes and every mesh under them
    expect(source).toMatch(/g\.userData\.switches=g\.userData\.rig\.filter\(r=>r\.clip&&r\.name in PIT_SWITCHES\)/)
  })

  it('route the right button to the switches and keep the context menu closed', () => {
    expect(source).toMatch(/stage\.addEventListener\("contextmenu",e=>e\.preventDefault\(\)/)
    // the middle button too: a stationary press, the height indicator's push-to-test (#58)
    expect(source).toMatch(/if\(e\.button===2\|\|e\.button===1\)\{ right_press=\(cfg\.view==="cockpit"&&running&&!map_on\)\?\{ x:e\.clientX, y:e\.clientY \}:null; e\.preventDefault\(\); return; \}/)
    expect(source).toMatch(/if\(e\.button===2\|\|e\.button===1\)\{ const r=right_press; right_press=null; if\(r&&Math\.abs\(e\.clientX-r\.x\)\+Math\.abs\(e\.clientY-r\.y\)<6\) pit_click\(e\); return; \}/)
    expect(source).toMatch(/if\(e\.button===2\)\{ if\(!playback\) pit_switch\(e\); return; \}/)   // a replay's switches are the recording's
    // a left click reaches the switches only after the screens miss, ahead of the panel-point measurement
    expect(source).toMatch(/if\(!hit\|\|!hit\.uv\)\{\n\t\tif\(pit_switch\(e\)\) return;[^\n]*\n\t\tif\(PANEL_POINT\)/)
    expect(source).toMatch(/if\(hit\.action\) pit_press\(hit\.action,e\.button===2\?1:-1\);/)
  })

  it('send every clickable key through pit_press so a click and its key share one gate', () => {
    for (const [action, direction] of [['canopy', 0], ['fold', 0], ['probe', 0], ['altitude', 0], ['reject', 0], ['hook', 0], ['brake.parking', 0], ['gear', 0], ['hook.bypass', 0], ['dump', 0]] as [string, number][])
      expect(source, action).toMatch(new RegExp(`if\\(ch===key_of\\("${action.replace('.', '\\.')}"\\)\\) pit_press\\("${action.replace('.', '\\.')}",${direction}\\);`))
    expect(source).toMatch(/if\(ch===key_of\("lights"\) && !dev_parked\) pit_press\("lights",0\);/)
    expect(source).toMatch(/if\(ch===key_of\("radar\.silent"\)\) pit_press\("radar",0\);/)
    expect(source).toMatch(/if\(ch===key_of\("flaps\.extend"\)\) pit_press\("flaps",-1\);/)
    expect(source).toMatch(/if\(ch===key_of\("flaps\.retract"\)\) pit_press\("flaps",1\);/)
    expect(source).toMatch(/if\(k==="Digit2"\)\{ if\(cfg\.view==="hud"\) pit_press\("reject",0\); else set_view\("hud"\); \}/)
  })

  it('open the canopy on a right click and close it on a left, on the ground only', () => {
    expect(press('canopy', 1).ownship.canopyTarget).toBe(1)
    expect(press('canopy', -1, { canopyTarget: 1 }).ownship.canopyTarget).toBe(0)
    expect(press('canopy', 0, { canopyTarget: 1 }).ownship.canopyTarget).toBe(0)
    const airborne = press('canopy', 1, { squish: 0, speed: 200 })
    expect(airborne.ownship.canopyTarget).toBe(0)
    expect(airborne.notices).toEqual(['CANOPY LOCKED'])
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
    expect(press('lights.test', 1).clicked).toBe(10) // the click's sim_time
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
