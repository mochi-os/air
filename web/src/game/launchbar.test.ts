// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { KEY_DEFAULTS } from './keys'

// The LAUNCH BAR switch (NATOPS 2.10.4, #127), EXTEND or RETRACT. Extended with
// weight on the wheels the bar rides on the deck and the crew can hook it over a
// shuttle; retracted, the flight core refuses the hook-up (flight/events.go).
// The shuttle holds the bar down through the stroke and its springs raise it as
// the jet flies off, whatever the switch says; the green L BAR follows the
// switch. engine.ts cannot be imported (WebGL at module scope).
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
const bridge = readFileSync(fileURLToPath(new URL('./flight.ts', import.meta.url)), 'utf8')
const wire = readFileSync(fileURLToPath(new URL('./net.ts', import.meta.url)), 'utf8')
const writer = readFileSync(fileURLToPath(new URL('./acmi.ts', import.meta.url)), 'utf8')
const settings = readFileSync(fileURLToPath(new URL('../components/SettingsDialog.tsx', import.meta.url)), 'utf8')
const canvas = readFileSync(fileURLToPath(new URL('../components/GameCanvas.tsx', import.meta.url)), 'utf8')
const pressfn = /\nfunction pit_press\(action,direction\)\{ const d=[\s\S]*?\n\t\} \}\n/.exec(source)?.[0] ?? ''

describe('the launch bar switch', () => {
  it('is clicked up to RETRACT and down to EXTEND, and its key toggles it', () => {
    expect(pressfn).not.toBe('')
    const press = (at: string, direction: number) => new Function('at', 'direction', `let bar_switch=at; ${pressfn} pit_press("launch.bar",direction); return bar_switch;`)(at, direction) as string
    expect([press('extend', 1), press('retract', 1)]).toEqual(['retract', 'retract'])
    expect([press('retract', -1), press('extend', -1)]).toEqual(['extend', 'extend'])
    expect([press('extend', 0), press('retract', 0)]).toEqual(['retract', 'extend'])
    expect(source).toMatch(/const PIT_SWITCHES=\{ canopyswitch:"canopy", foldswitch:"fold", parkbrake:"brake\.parking", parkpull:"brake\.parking", barswitch:"launch\.bar",/)
    expect(source).toMatch(/\n\t\tif\(ch===key_of\("launch\.bar"\)\) pit_press\("launch\.bar",0\);/)
  })

  it('lowers the bar from the switch with weight on the wheels, holds it down through the stroke, and lets it up in the air', () => {
    const line = /\n\tif\(st===ownship\) st\.barTarget=[^\n]*\n/.exec(source)?.[0] ?? ''
    expect(line).not.toBe('')
    const target = (at: string, squish: number, launching: boolean) =>
      new Function('at', 'squish', 'launching', `const bar_switch=at, st={ squish, launching }, ownship=st; ${line} return st.barTarget;`)(at, squish, launching) as number
    expect(target('extend', 1, false)).toBe(1) // on the deck
    expect(target('retract', 1, false)).toBe(0)
    expect(target('retract', 0, true)).toBe(1) // the shuttle holds it through the stroke
    expect(target('extend', 0, false)).toBe(0) // the springs raise it off the bow, the switch left at EXTEND
  })

  it('lights the green L BAR and throws the lever from the switch, not the catapult spot', () => {
    expect(source).toMatch(/lamp_set\(l\.lbar,bar_switch==="extend"\);/)
    expect(source).toMatch(/case "barswitch": f=\(st===ownship\?bar_switch==="extend":\(st\.barTarget\?\?0\)>0\.5\)\?1:0; break;/)
  })

  it('reaches the flight core as retract, flag bit 65536, in both samples', () => {
    expect(source).toMatch(/\n\t\tlaunch:launch_flag, retract:bar_switch==="retract", override:/)
    expect(source).toMatch(/override:c\?c\.override:false, retract:bar_switch==="retract"&&!!ownship\.grounded, dump:/) // on the wheels alone, where the crew could hook up: the airborne datagrams, the full ones, carry none of it
    expect(bridge).toMatch(/\n {2}retract: boolean/)
    expect(bridge).toMatch(/\n {4}\(controls\.retract \? 65536 : 0\) \|\n/)
    expect(wire).toMatch(/\n {2}retract: boolean/)
  })

  it('starts down on a catapult start and up on every other', () => {
    const line = /\n\tbar_switch=st==="carrier"[^\n]*\n/.exec(source)?.[0] ?? ''
    expect(line).not.toBe('')
    const start = (st: string) => new Function('st', `let bar_switch=null; ${line} return bar_switch;`)(st) as string
    expect(start('carrier')).toBe('extend')
    for (const st of ['runway', 'case1', 'case2', 'case3', 'joust', 'free']) expect(start(st), st).toBe('retract')
  })

  it('asks for the bar on a catapult spot with it up, and takes the line down once it is down or the jet leaves the spot', () => {
    const lines = /\n\tif\(\(ownship\.squish\?\?0\)>0\.5&&!ownship\.launching&&bar_switch==="retract"&&on_cat_spot\(\)>=0\) hint\(HINT\.bar\);\n\telse \{ hint_retire\(HINT\.bar\); delete hinted\[HINT\.bar\]; \}\n/.exec(source)?.[0] ?? ''
    expect(lines).not.toBe('')
    // frames: the switch, the cat spot (-1 for none), and whether the jet is on its wheels; returns what the slot shows after each
    const watch = (frames: [string, number, number][]) => new Function('frames', `const HINT={ bar:"BAR" }, hinted={}, ownship={ launching:false, squish:1 };
      let bar_switch="retract", spot=-1, shown=null;
      const on_cat_spot=()=>spot, hint=(key)=>{ if(hinted[key]) return; hinted[key]=1; shown=key; }, hint_retire=(...keys)=>{ if(keys.includes(shown)) shown=null; };
      return frames.map(([at,cat,squish])=>{ bar_switch=at; spot=cat; ownship.squish=squish; ${lines} return shown; });`)(frames) as (string | null)[]
    expect(watch([['retract', -1, 1], ['retract', 0, 1], ['retract', 0, 1], ['extend', 0, 1]])).toEqual([null, 'BAR', 'BAR', null])
    expect(watch([['retract', 0, 1], ['retract', -1, 1], ['retract', 1, 1]])).toEqual(['BAR', null, 'BAR']) // re-armed for the next catapult
    expect(watch([['retract', 0, 0]])).toEqual([null]) // a jet in the air over a catapult is not on it
    expect(source).toMatch(/\tbar:"On catapult: extend launch bar to hook up",/)
    expect(source).toMatch(/const WAITING=new Set\(\[HINT\.bar,/) // it waits on the pilot, not the read
    expect(canvas).toMatch(/'On catapult: extend launch bar to hook up': msg`On catapult: extend launch bar to hook up`,/)
  })

  it('is recorded, and a replay lowers the bar from it before the shot', () => {
    expect(source).toMatch(/lights:!!ownship\.lights, bar:bar_switch==="extend", canopy:/)
    expect(writer).toMatch(/\['Bar', flag\(d\.bar\)\],/)
    const line = /\n\tconst bar=n\("Bar",-1\);[^\n]*\n/.exec(source)?.[0] ?? ''
    expect(line).not.toBe('')
    const replay = (channels: Record<string, number>, at: string) =>
      new Function('channels', 'at', `let bar_switch=at; const n=(k,d)=>k in channels?channels[k]:d; ${line} return bar_switch;`)(channels, at) as string
    expect(replay({ Bar: 1 }, 'retract')).toBe('extend')
    expect(replay({ Bar: 0 }, 'extend')).toBe('retract')
    expect(replay({}, 'extend')).toBe('extend') // a recording from before the channel keeps the start's
  })

  it('is bound to Shift+Enter, a chord on the launch key, and offered in the Keys and Buttons tabs', () => {
    expect(KEY_DEFAULTS['launch.bar']).toBe('Shift+Enter')
    expect(KEY_DEFAULTS.launch).toBe('Enter')
    expect(settings).toMatch(/\{ id: 'launch\.bar', label: msg`Launch bar`, group: 'landing' \},/)
    expect(settings).toMatch(/\n {2}'launch',\n {2}'launch\.bar',\n/)
  })
})
