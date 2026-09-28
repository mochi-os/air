// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The HUD's timer (NATOPS A1-F18AC-NFM-000 2.13.4.8.11 item 17, 24.2.5.7.4-6):
// ZTOD, ET or CD at the lower-left corner, one at a time, whichever the UFC's
// TIMEUFC page shows, as bare digits, and none until one is selected; REJ 2
// removes it and REJ 1 keeps it. ET counts 00:00 to 59:59 and wraps; CD counts
// down from 06:00 and leaves the display at 00:00. engine.ts cannot be imported
// (WebGL at module scope), so the timer's functions and the HUD block are read as
// text and run against a recording canvas on their own sim clock.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
const timers = (/\n\/\/ The mission computer's timers[\s\S]*?\n(?=const ufc=\{)/.exec(source)?.[0] ?? '')
const block = /\n\t\/\/ ---- the mission computer's timer, lower-left corner[\s\S]*?,ax-84,cy\+7\.2\*ppdv\); \} \}/.exec(source)?.[0] ?? ''

type Row = [string, number, number, string]
interface Panel {
  timer: { shown: string; et: { seconds: number; since: number | null }; cd: { seconds: number; since: number | null } }
  timer_run: (kind: string, on: boolean) => void
  timer_update: () => void
  timer_reset: () => void
  at: (time: number) => void
  draw: (declutter: number, zulu?: number) => Row[]
}
function panel(): Panel {
  if (!timers || !block) throw new Error('the HUD timer not found in engine.ts')
  return new Function(`let sim_time=0; ${timers}
    const at=(time)=>{ sim_time=time; };
    const draw=(declutter, zulu=0)=>{ const text=[]; let align='';
      const hctx={ font:'', fillStyle:'', get textAlign(){ return align; }, set textAlign(v){ align=v; }, fillText(t,x,y){ text.push([t,x,y,align]); } };
      const GR='g', ax=200, cy=400, ppdv=20, ownship={ gauges:{ zulu } };
      ${block}
      return text; };
    return { timer, timer_run, timer_update, timer_reset, at, draw };`)() as Panel
}
const shown = (p: Panel, declutter = 0, zulu = 0) => p.draw(declutter, zulu).map(([t]) => t)

describe('the HUD timer', () => {
  it('shows nothing until a timer is selected', () => {
    expect(panel().draw(0, 30000)).toEqual([])
  })

  it('shows ET as bare minutes and seconds at the lower-left corner, started and stopped', () => {
    const p = panel()
    p.timer.shown = 'et'
    expect(p.draw(0)).toEqual([['00:00', 200 - 84, 400 + 7.2 * 20, 'left']])
    p.timer_run('et', true)
    p.at(602)
    expect(shown(p)).toEqual(['10:02'])
    p.timer_run('et', false)
    p.at(700)
    expect(shown(p)).toEqual(['10:02'])
  })

  it('wraps ET at 59:59', () => {
    const p = panel()
    p.timer.shown = 'et'
    p.timer_run('et', true)
    p.at(3599.5)
    expect(shown(p)).toEqual(['59:59'])
    p.at(3662)
    expect(shown(p)).toEqual(['01:02'])
  })

  it('counts CD down from 06:00 and takes it off the HUD at 00:00', () => {
    const p = panel()
    p.timer.shown = 'cd'
    expect(shown(p)).toEqual(['06:00'])
    p.timer_run('cd', true)
    p.at(0.5)
    expect(shown(p)).toEqual(['06:00'])
    p.at(1)
    expect(shown(p)).toEqual(['05:59'])
    p.at(359.5)
    expect(shown(p)).toEqual(['00:01'])
    p.at(360)
    p.timer_update()
    expect(p.timer.shown).toBe('')
    expect(p.draw(0)).toEqual([])
  })

  it('shows ZTOD as hours, minutes and seconds', () => {
    const p = panel()
    p.timer.shown = 'ztod'
    expect(shown(p, 0, 8 * 3600 + 23 * 60 + 48)).toEqual(['08:23:48'])
  })

  it('survives REJ 1 and goes with REJ 2', () => {
    const p = panel()
    p.timer.shown = 'et'
    expect(p.draw(1)).toHaveLength(1)
    expect(p.draw(2)).toEqual([])
  })

  it('powers up with none shown, ET at zero and CD at six minutes, stopped', () => {
    const p = panel()
    p.timer.shown = 'cd'
    p.timer_run('et', true)
    p.at(50)
    p.timer_reset()
    expect(p.timer).toEqual({ shown: '', et: { seconds: 0, since: null }, cd: { seconds: 360, since: null } })
  })

  it('puts the Case III push time on the CD timer, running, where the push clock was', () => {
    expect(source).toMatch(/marshal=\{ push:sim_time\+MARSHAL_PUSH,[^\n]*\n\t\ttimer\.cd\.seconds=MARSHAL_PUSH; timer_run\("cd",true\); timer\.shown="cd";/)
    expect(source).toMatch(/\n\tufc\.func=""; ufc\.ralt=false;[^\n]*\n\ttimer_reset\(\);/)
    expect(source).toMatch(/hints_watch\(\); timer_update\(\);/)
  })
})

// The lower-right data block (NATOPS item 14, figure 2-26): TACAN slant range and
// the station's ident, "21.1 STL", with no invented push clock beside it.
describe('the lower-right data block', () => {
  const data = /\n\t\/\/ ---- data blocks: TCN slant range[\s\S]*?(?=\n\t\{ \/\/ The selected weapon and its count)/.exec(source)?.[0] ?? ''
  it('reads the TACAN block as slant range and ident, and draws no push clock', () => {
    expect(data).not.toBe('')
    const text = new Function(`const text=[]; const hctx={ font:'', fillStyle:'', textAlign:'', fillText(t){ text.push(t); } };
      const atc_on=false, atc_flash=-Infinity, sim_time=100, lx=700, cy=400, ppdv=20, GR='g', AM='a', carrier_ols=true, master='nav', declutter=0;
      const CARRIER={ x:0, z:-18520 }, ownship={ pos:{ x:0, y:0, z:0 } }, SHIP={ ident:'NIM' }, wrap_axis=(v)=>v;
      const marshal={ push:400, commenced:false }, clock_text=(s)=>String(s);
      ${data}
      return text;`)() as string[]
    expect(text).toEqual(['10.0 NIM'])
  })
})
