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
const block = (/\n\telse if\(ind\)\{ const devd=[\s\S]*?ind\.donut\.opacity=[^\n]*\n/.exec(source)?.[0] ?? '').replace(/\} \}\n$/, '}\n')

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
interface Own { parking?: boolean; alt_radar?: boolean; declutter?: number; fuel_dump?: boolean; sil?: boolean }
// Runs one drive case for the aircraft st, which is the ownship unless foreign is set.
function drive(name: string, st: Craft, own: Own = {}, foreign = false): number | undefined {
  if (!cases) throw new Error('switch drive cases not found in engine.ts')
  const run = new Function('name', 'st', 'ownship', 'parking', 'alt_radar', 'declutter', 'fuel_dump', 'RADAR',
    `let f; switch(name){ ${cases} } return f;`)
  const ownship = foreign ? {} : st
  return run(name, st, ownship, !!own.parking, !!own.alt_radar, own.declutter ?? 0, !!own.fuel_dump, { sil: !!own.sil }) as number | undefined
}

describe('the state-driven switches', () => {
  it('bind one rig entry per animated switch node, and the parking brake both of its nodes', () => {
    const entries: [string, string, string][] = [
      ['canopyswitch', 'Canopy_Switch_AN', 'canopyswitch'], ['foldswitch', 'Wing_Fold_Switch_AN', 'foldswitch'],
      ['parkbrake', 'LANDING_GEAR_Switch_ParkingBrake_AN_ParkingBrake', 'parkbrake'], ['parkpull', 'LANDING_GEAR_Switch_ParkingBrake_AN_287', 'parkbrake'],
      ['probeswitch', 'Refuel_Switch_Action_AN', 'probeswitch'],
      ['altswitch', 'Switch_ALT_HudPanel_AN', 'altswitch'], ['rejswitch', 'Switch_REJ2_HudPanel_AN', 'rejswitch'],
      ['ldglight', 'Switch_LDG_Light_LeftPanel_AN', 'lightswitch'], ['strobe', 'Switch_Strobe_LeftPanel_AN', 'lightswitch'],
      ['formation', 'FormationLightsAction_AN', 'lightswitch'], ['dumpswitch', 'Fuel_Dump_AN', 'dumpswitch'], ['radaropr', 'RADAR_OPR_AN', 'radaropr'],
    ]
    for (const [name, node, drive] of entries)
      expect(source, name).toMatch(new RegExp(`\\{ name:"${name}",\\s+track:/\\^${node}/i,\\s+drive:"${drive}" \\}`))
    // the launch bar clip is authored from EXTEND (its rest pose, lever down) to RETRACT, so it runs flipped
    expect(source).toMatch(/\{ name:"barswitch",\s+track:\/\^Switch_LAUNCHBAR_LeftPanel_AN\/i,\s+drive:"barswitch", flip:true \}/)
  })

  it('read the canopy, fold, launch bar and probe switches from their targets', () => {
    // the canopy switch is OPEN while the canopy rises and springs back to HOLD once it is up (NATOPS 2.15.1.1.1)
    expect(drive('canopyswitch', { canopyTarget: 1, canopy: 0.3 })).toBe(1)
    expect(drive('canopyswitch', { canopyTarget: 1, canopy: 1 })).toBe(0)
    expect(drive('canopyswitch', { canopyTarget: 0, canopy: 0.3 })).toBe(0)
    expect(drive('foldswitch', { foldTarget: 1 })).toBe(1)
    expect(drive('foldswitch', { foldTarget: 0 })).toBe(0)
    expect(drive('barswitch', { barTarget: 1 })).toBe(1)
    expect(drive('barswitch', {})).toBe(0)
    expect(drive('probeswitch', { probeTarget: 1 })).toBe(1)
    expect(drive('probeswitch', { probeTarget: 0 })).toBe(0)
  })

  it('read the light switches from the aircraft lights', () => {
    expect(drive('lightswitch', { lights: true })).toBe(1)
    expect(drive('lightswitch', { lights: false })).toBe(0)
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

  it('spring the DUMP switch back to OFF when BINGO comes on', () => {
    const line = /\n\tif\(fuel_dump&&bingo_low\(\)\) fuel_dump=false;/.exec(source)?.[0] ?? ''
    expect(line).not.toBe('')
    const run = new Function('fuel_dump', 'bingo_low', `${line} return fuel_dump;`)
    expect(run(true, () => false)).toBe(true)
    expect(run(true, () => true)).toBe(false)
    expect(run(false, () => false)).toBe(false)
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
interface Pit {
  squish?: number; speed?: number; ground?: boolean; canopyTarget?: number; foldTarget?: number; gearTarget?: number; hookTarget?: number
  probeTarget?: number; lights?: boolean; parking?: boolean; alt_radar?: boolean; declutter?: number; fuel_dump?: boolean; sil?: boolean
  hook_bypass?: string; flap_select?: number
}
interface Pressed {
  ownship: { canopyTarget: number; foldTarget: number; gearTarget: number; hookTarget: number; probeTarget: number; lights: boolean }
  parking: boolean; alt_radar: boolean; declutter: number; fuel_dump: boolean; hook_bypass: string; flap_select: number; flap_armed: number; sil: boolean; notices: string[]
}
function press(action: string, direction: number, state: Pit = {}): Pressed {
  if (!pressfn) throw new Error('pit_press not found in engine.ts')
  const run = new Function('action', 'direction', 'state', `
    const ownship={ squish:state.squish??1, speed:state.speed??0, canopyTarget:state.canopyTarget??0, foldTarget:state.foldTarget??0, gearTarget:state.gearTarget??0, hookTarget:state.hookTarget??0, probeTarget:state.probeTarget??0, lights:!!state.lights };
    let parking=!!state.parking, alt_radar=!!state.alt_radar, declutter=state.declutter??0, fuel_dump=!!state.fuel_dump, hook_bypass=state.hook_bypass??"carrier", flap_select=state.flap_select??0, flap_armed=0;
    const RADAR={ sil:!!state.sil }, sim_time=10, notices=[], notice=(t)=>notices.push(t), translate=(t)=>t, on_ground=()=>state.ground??true;
    ${pressfn}
    pit_press(action, direction);
    return { ownship, parking, alt_radar, declutter, fuel_dump, hook_bypass, flap_select, flap_armed, sil:RADAR.sil, notices };`)
  return run(action, direction, state) as Pressed
}

describe('the clickable switches', () => {
  it('list every driven switch and handle with the action a click fires, the launch bar with none', () => {
    const table = /const PIT_SWITCHES=\{([\s\S]*?)\};/.exec(source)?.[1] ?? ''
    const expected: [string, string | null][] = [
      ['canopyswitch', 'canopy'], ['foldswitch', 'fold'], ['parkbrake', 'brake.parking'], ['parkpull', 'brake.parking'], ['barswitch', null],
      ['probeswitch', 'probe'], ['altswitch', 'altitude'], ['rejswitch', 'reject'], ['ldglight', 'lights'], ['strobe', 'lights'], ['formation', 'lights'],
      ['dumpswitch', 'dump'], ['radaropr', 'radar'], ['hookbypass', 'hook.bypass'], ['gearlever', 'gear'], ['hooklever', 'hook'], ['flaplever', 'flaps'],
    ]
    for (const [name, action] of expected) expect(table, name).toContain(`${name}:${action === null ? 'null' : `"${action}"`}`)
    expect(table.match(/\w+:/g)?.length).toBe(expected.length)
    // the targets are built from the rig: the clip's nodes and every mesh under them
    expect(source).toMatch(/g\.userData\.switches=g\.userData\.rig\.filter\(r=>r\.clip&&r\.name in PIT_SWITCHES\)/)
  })

  it('route the right button to the switches and keep the context menu closed', () => {
    expect(source).toMatch(/stage\.addEventListener\("contextmenu",e=>e\.preventDefault\(\)/)
    expect(source).toMatch(/if\(e\.button===2\)\{ right_press=\(cfg\.view==="cockpit"&&running&&!map_on\)\?\{ x:e\.clientX, y:e\.clientY \}:null; e\.preventDefault\(\); return; \}/)
    expect(source).toMatch(/if\(e\.button===2\)\{ const r=right_press; right_press=null; if\(r&&Math\.abs\(e\.clientX-r\.x\)\+Math\.abs\(e\.clientY-r\.y\)<6\) pit_click\(e\); return; \}/)
    expect(source).toMatch(/if\(e\.button===2\)\{ pit_switch\(e\); return; \}/)
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

  it('fold the wings on a left click, counterclockwise, and spread them on a right', () => {
    expect(press('fold', -1).ownship.foldTarget).toBe(1)
    expect(press('fold', 1, { foldTarget: 1 }).ownship.foldTarget).toBe(0)
    expect(press('fold', -1, { speed: 20 }).notices).toEqual(['WINGS LOCKED'])
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
      expect(press('brake.parking', d).parking).toBe(true)
      expect(press('probe', d).ownship.probeTarget).toBe(1)
      expect(press('altitude', d).alt_radar).toBe(true)
      expect(press('lights', d).ownship.lights).toBe(true)
      expect(press('dump', d).fuel_dump).toBe(true)
      expect(press('hook.bypass', d).hook_bypass).toBe('field')
      expect(press('hook', d).ownship.hookTarget).toBe(1)
    }
  })
})
