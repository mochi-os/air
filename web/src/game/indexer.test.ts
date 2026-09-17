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
    expect(source).toMatch(/if\(ch===key_of\("hook\.bypass"\)\) hook_bypass=hook_bypass==="field"\?"carrier":"field";/)
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
