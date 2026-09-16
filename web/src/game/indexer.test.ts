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
