// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Configuration is a state, so it lives on the bottom-right status stack where
// it can be read back; the centre banner keeps the events. Wing fold and the
// parking brake follow their handles with no in-motion state (NATOPS 2.11.1,
// 2.10.3.4), and the cockpit view gets the NATOPS cautions the jet shows.
// engine.ts cannot be imported (WebGL at module scope), so the status stack
// and the configuration cautions are read as text and run against a stand-in
// jet, as trim-law.test.ts does.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
const catalogue = readFileSync(fileURLToPath(new URL('../components/GameCanvas.tsx', import.meta.url)), 'utf8')

const stackCode = /\n\t\{ const rows=\[\]; {3}\/\/ bottom of the stack first\n[\s\S]*?\n\t\thud_stack\.right=stack_draw\(rows,HW-40,HH-52\); \}\n/.exec(source)?.[0] ?? ''
const cautionCode = /\n\tif\(fold_handle!=="lock"\) push\("WING UNLK"\);[\s\S]*?push\("PROBE UNLK"\);/.exec(source)?.[0] ?? ''

interface Jet { hook?: number; gear?: number; speedbrake?: number; fold?: number; foldTarget?: number; canopy?: number; canopyTarget?: number; probe?: number; probeTarget?: number; gauges?: { rpmL: number; rpmR: number } }
interface World { jet?: Jet; handle?: string; parking?: boolean; gone?: boolean; dump?: boolean; secured?: [boolean, boolean]; sil?: boolean; acm?: string | null; jammer?: 'off' | 'armed' | 'loud'; declutter?: number; authentic?: boolean }

// The rows the stack draws for a world, as [colour, text] with GR/AM as names.
function stack(world: World): string[] {
  if (!stackCode) throw new Error('status stack not found in engine.ts')
  const run = new Function('w', `const ownship={gear:1,hook:0,...w.jet}, authentic=!!w.authentic, GR="GR", AM="AM", STATE={datum:0,bank:1}, last_out=null, trim_manual=false, stab_cycle=0, flap_select=0;
    const parking=!!w.parking, fuel_dump=!!w.dump, secured=w.secured||[false,false], declutter=w.declutter||0, fold_handle=w.handle||"lock";
    const RADAR={sil:!!w.sil, auto:!!w.acm, acm:w.acm||"bst"}, jammer_armed=()=>(w.jammer||"off")!=="off", jammer_loud=()=>w.jammer==="loud";
    const translate=t=>t, hud_stack={}, hctx={}, HW=0, HH=0; let drawn=[];
    const stack_draw=(rows)=>{ drawn=rows.map(([c,t])=>c+":"+t); return drawn; };
    ${stackCode}
    return drawn;`) as (w: World) => string[]
  return run(world)
}
// The configuration cautions raised for a jet.
function cautions(world: World): string[] {
  if (!cautionCode) throw new Error('configuration cautions not found in engine.ts')
  const run = new Function('w', `const ownship={...w.jet}, parking=!!w.parking, fold_handle=w.handle||"lock", canopy_gone=!!w.gone, rows=[]; const push=k=>rows.push(k);
    ${cautionCode}
    return rows;`) as (w: World) => string[]
  return run(world)
}

describe('wing fold and the parking brake follow their handles', () => {
  it('lights WINGS green from the handle leaving LOCK until it is back in', () => {
    for (const handle of ['fold', 'hold', 'spread']) expect(stack({ handle, jet: { fold: 0 } }), handle).toContain('GR:WINGS') // spread and not yet locked too
    expect(stack({ handle: 'lock', jet: { fold: 0 } }).some((row) => row.endsWith('WINGS'))).toBe(false)
  })

  it('spreads folded or held wings on the takeoff roll and locks them once spread, the way the handle would be worked', () => {
    const lines = /\n\tif\(st===ownship && \(fold_handle==="fold"\|\|fold_handle==="hold"\) && st\.speed>13\) fold_set\("spread"\);[^\n]*\n\tif\(st===ownship && fold_handle==="spread" && \(st\.fold\?\?0\)<=0\.001 && st\.speed>13\) fold_handle="lock";[^\n]*\n/.exec(source)?.[0] ?? ''
    expect(lines).not.toBe('')
    const roll = (handle: string, fold: number, speed: number) => new Function('handle', 'fold', 'speed', `const ownship={ fold, speed, foldTarget:handle==="fold"?1:0 }, st=ownship; let fold_handle=handle;
      const fold_set=(h)=>{ fold_handle=h; ownship.foldTarget=h==="fold"?1:0; }; ${lines} return [fold_handle, ownship.foldTarget];`)(handle, fold, speed) as [string, number]
    expect(roll('fold', 1, 20)).toEqual(['spread', 0])
    expect(roll('hold', 0.5, 20)).toEqual(['spread', 0])
    expect(roll('spread', 0.3, 20)).toEqual(['spread', 0]) // still spreading
    expect(roll('spread', 0, 20)).toEqual(['lock', 0])
    expect(roll('fold', 1, 5)).toEqual(['fold', 1]) // taxiing
    expect(roll('spread', 0, 5)).toEqual(['spread', 0])
  })

  it('takes the handle from the wings in a replay, and a fresh jet\'s from its wings', () => {
    const replay = /\n\tfold_handle=ownship\.foldTarget>0\.5\?"fold":\(ownship\.fold\?\?0\)>0\.02\?"spread":"lock";[^\n]*\n/.exec(source)?.[0] ?? ''
    expect(replay).not.toBe('')
    const handle = (foldTarget: number, fold: number) => new Function('foldTarget', 'fold', `const ownship={ foldTarget, fold }; let fold_handle=""; ${replay} return fold_handle;`)(foldTarget, fold) as string
    expect([handle(1, 0.3), handle(0, 0.3), handle(0, 0)]).toEqual(['fold', 'spread', 'lock'])
    expect(source).toMatch(/\n\texterior\.landing=[^\n]*\n\tfold_handle=\(ownship\.foldTarget\?\?0\)>0\.5\?"fold":"lock";[^\n]*\n\tadi_source=/)
  })

  it('stands the handle out of the panel along its shaft while it is out of LOCK', () => {
    expect(source).toMatch(/\{ name:"foldpull",\s+node:"Wing_Fold_Switch_AN_Switch_743", trans:\[0,0,-1\], gain:0\.015, gauge:"foldpull" \}/)
    expect(source).toMatch(/\n\t\tfoldpull:fold_handle==="lock"\?0:1,/)
  })

  it('lights PARK green on the handle, with no in-motion state', () => {
    expect(stack({ parking: true })).toContain('GR:PARK')
    expect(stack({ parking: false }).some((row) => row.endsWith('PARK'))).toBe(false)
  })

  it('raises WING UNLK on the same handle condition, and PARK BRK only with both engines above 80%', () => {
    for (const handle of ['fold', 'hold', 'spread']) expect(cautions({ handle, jet: { fold: 0 } }), handle).toContain('WING UNLK')
    expect(cautions({ handle: 'lock', jet: { fold: 0 } })).not.toContain('WING UNLK')
    expect(cautions({ parking: true, jet: { gauges: { rpmL: 85, rpmR: 85 } } })).toContain('PARK BRK')
    expect(cautions({ parking: true, jet: { gauges: { rpmL: 70, rpmR: 99 } } })).not.toContain('PARK BRK')
    expect(cautions({ parking: false, jet: { gauges: { rpmL: 99, rpmR: 99 } } })).not.toContain('PARK BRK')
  })

  it('raises CANOPY until down and locked, and PROBE UNLK only on a retract that has not finished', () => {
    expect(cautions({ jet: { canopyTarget: 1, canopy: 0 } })).toContain('CANOPY')
    expect(cautions({ jet: { canopyTarget: 0, canopy: 0.3 } })).toContain('CANOPY')
    expect(cautions({ jet: { canopyTarget: 0, canopy: 0 } })).not.toContain('CANOPY')
    expect(cautions({ gone: true, jet: { canopyTarget: 0, canopy: 0 } })).toContain('CANOPY') // jettisoned (#113): never down and locked again
    expect(cautions({ jet: { probeTarget: 1, probe: 1 } })).not.toContain('PROBE UNLK') // extended normally: no light
    expect(cautions({ jet: { probeTarget: 0, probe: 0.5 } })).toContain('PROBE UNLK')
    expect(cautions({ jet: { probeTarget: 0, probe: 0 } })).not.toContain('PROBE UNLK')
  })
})

describe('switch states sit on the status stack', () => {
  it('shows fuel dump, a secured engine, radar silent, the jammer, the ACM condition and the reject level', () => {
    expect(stack({ dump: true })).toContain('GR:FUEL DUMP')
    expect(stack({ secured: [true, false] })).toContain('AM:L ENG SECURED')
    expect(stack({ secured: [false, true] })).toContain('AM:R ENG SECURED')
    expect(stack({ sil: true })).toContain('GR:SIL')
    expect(stack({ jammer: 'armed' })).toContain('GR:JAM ARM')
    expect(stack({ jammer: 'loud' })).toContain('AM:XMIT')
    expect(stack({ acm: 'bst' })).toContain('GR:ACM BST')
    expect(stack({ acm: 'vacq' })).toContain('GR:ACM VACQ')
    expect(stack({ acm: 'wacq' })).toContain('GR:ACM WACQ')
    expect(stack({ declutter: 2 })).toContain('GR:REJ 2')
    expect(stack({})).toEqual([]) // a clean jet in its default switch positions shows nothing
  })

  it('no longer announces those switches on the centre banner, keeping only the refusals', () => {
    const refusals = ['WINGS LOCKED', 'CANOPY LOCKED']
    for (const action of ['probe', 'fold', 'canopy', 'brake.parking', 'dump', 'secure.port', 'secure.starboard', 'jammer', 'radar.silent', 'reject', 'uncage']) {
      const line = source.split('\n').find((at) => at.includes(`ch===key_of("${action}")`)) ?? ''
      expect(line, action).not.toBe('')
      const calls = [...line.matchAll(/notice\(([^;]*?)\);/g)].map((m) => m[1])
      expect(calls.filter((call) => !refusals.some((word) => call.includes(word))), action).toEqual([])
    }
    const acm = /\nfunction acm_press\(\)\{[\s\S]*?\n(?=function |let |const )/.exec(source)?.[0] ?? source.slice(source.indexOf('RADAR.acm="vacq"') - 200, source.indexOf('RADAR.acm="vacq"') + 200)
    expect(acm).not.toMatch(/notice\("ACM/)
    expect(source).not.toMatch(/notice\(translate\("(CANOPY CLOSING|WINGS SPREADING)"\)\)/)
  })

  it('drops the retired announcements from the HUD catalogue', () => {
    for (const retired of ['PROBE IN', 'PROBE OUT', 'CANOPY OPEN', 'CANOPY CLOSED', 'CANOPY CLOSING', 'WINGS FOLDING', 'WINGS SPREADING']) {
      expect(catalogue, retired).not.toContain(`'${retired}': msg`)
    }
  })
})

// The cockpit has the gear lights in the handle and on the panel and the HOOK
// light (NATOPS 2.10.1, FO-5), so GEAR and HOOK leave the cockpit view's screen
// corner; the HUD view, which has no panel, keeps them.
describe('the gear and hook legends', () => {
  const jet = { gear: 0.5, hook: 1 }
  it('show in the HUD view', () => {
    expect(stack({ jet })).toEqual(expect.arrayContaining(['AM:GEAR', 'GR:HOOK']))
  })
  it('leave the cockpit view, where the panel lights show the gear and hook', () => {
    const rows = stack({ jet, authentic: true })
    expect(rows.some((row) => row.endsWith(':GEAR') || row.endsWith(':HOOK'))).toBe(false)
  })
})

