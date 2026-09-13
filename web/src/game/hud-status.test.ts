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

const stackCode = /\n\t\{ const rows=\[\];   \/\/ bottom of the stack first\n[\s\S]*?\n\t\thud_stack\.right=stack_draw\(rows,HW-40,HH-52\); \}\n/.exec(source)?.[0] ?? ''
const cautionCode = /\n\tif\(\(ownship\.foldTarget\?\?0\)>0\.5\|\|\(ownship\.fold\?\?0\)>0\.02\) push\("WING UNLK"\);[\s\S]*?push\("PROBE UNLK"\);/.exec(source)?.[0] ?? ''

interface Jet { hook?: number; gear?: number; speedbrake?: number; fold?: number; foldTarget?: number; canopy?: number; canopyTarget?: number; probe?: number; probeTarget?: number; gauges?: { rpmL: number; rpmR: number } }
interface World { jet?: Jet; parking?: boolean; dump?: boolean; secured?: [boolean, boolean]; sil?: boolean; acm?: string | null; jammer?: 'off' | 'armed' | 'loud'; declutter?: number }

// The rows the stack draws for a world, as [colour, text] with GR/AM as names.
function stack(world: World): string[] {
  if (!stackCode) throw new Error('status stack not found in engine.ts')
  const run = new Function('w', `const ownship={gear:1,hook:0,...w.jet}, authentic=false, GR="GR", AM="AM", STATE={datum:0,bank:1}, last_out=null, trim_manual=false, stab_cycle=0, flap_select=0;
    const parking=!!w.parking, fuel_dump=!!w.dump, secured=w.secured||[false,false], declutter=w.declutter||0;
    const RADAR={sil:!!w.sil, auto:!!w.acm, acm:w.acm||"bst"}, jammer_armed=(w.jammer||"off")!=="off", jammer_loud=()=>w.jammer==="loud";
    const translate=t=>t, hud_stack={}, hctx={}, HW=0, HH=0; let drawn=[];
    const stack_draw=(rows)=>{ drawn=rows.map(([c,t])=>c+":"+t); return drawn; };
    ${stackCode}
    return drawn;`) as (w: World) => string[]
  return run(world)
}
// The configuration cautions raised for a jet.
function cautions(world: World): string[] {
  if (!cautionCode) throw new Error('configuration cautions not found in engine.ts')
  const run = new Function('w', `const ownship={...w.jet}, parking=!!w.parking, rows=[]; const push=k=>rows.push(k);
    ${cautionCode}
    return rows;`) as (w: World) => string[]
  return run(world)
}

describe('wing fold and the parking brake follow their handles', () => {
  it('lights WINGS green from the fold command, through the spread, until the panels are down', () => {
    expect(stack({ jet: { foldTarget: 1, fold: 0 } })).toContain('GR:WINGS') // commanded, panels not yet moving
    expect(stack({ jet: { foldTarget: 0, fold: 0.5 } })).toContain('GR:WINGS') // spreading, not yet locked
    expect(stack({ jet: { foldTarget: 0, fold: 0 } }).some((row) => row.endsWith('WINGS'))).toBe(false)
  })

  it('lights PARK green on the handle, with no in-motion state', () => {
    expect(stack({ parking: true })).toContain('GR:PARK')
    expect(stack({ parking: false }).some((row) => row.endsWith('PARK'))).toBe(false)
  })

  it('raises WING UNLK on the same handle condition, and PARK BRK only with both engines above 80%', () => {
    expect(cautions({ jet: { foldTarget: 1, fold: 0 } })).toContain('WING UNLK')
    expect(cautions({ jet: { foldTarget: 0, fold: 0.4 } })).toContain('WING UNLK')
    expect(cautions({ jet: { foldTarget: 0, fold: 0 } })).not.toContain('WING UNLK')
    expect(cautions({ parking: true, jet: { gauges: { rpmL: 85, rpmR: 85 } } })).toContain('PARK BRK')
    expect(cautions({ parking: true, jet: { gauges: { rpmL: 70, rpmR: 99 } } })).not.toContain('PARK BRK')
    expect(cautions({ parking: false, jet: { gauges: { rpmL: 99, rpmR: 99 } } })).not.toContain('PARK BRK')
  })

  it('raises CANOPY until down and locked, and PROBE UNLK only on a retract that has not finished', () => {
    expect(cautions({ jet: { canopyTarget: 1, canopy: 0 } })).toContain('CANOPY')
    expect(cautions({ jet: { canopyTarget: 0, canopy: 0.3 } })).toContain('CANOPY')
    expect(cautions({ jet: { canopyTarget: 0, canopy: 0 } })).not.toContain('CANOPY')
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
