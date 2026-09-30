// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// A remote jet's speed brake is animated from the target the wire carries,
// eased at the actuator's own travel (2.5 s stowed to full, the flight
// core's Rate.Brake) so a wingman's panel opens at the pace the ownship's
// does. engine.ts cannot be imported (WebGL at module scope).
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')

describe('the remote speed brake', () => {
  it("opens at the actuator's pace", () => {
    const line = /st\.speedbrake\+=THREE\.MathUtils\.clamp\(\(st\.speedbrakeTarget\?\?0\)-st\.speedbrake,-([\d.]+)\*dt,([\d.]+)\*dt\);/.exec(source)
    expect(line).not.toBeNull()
    expect(Number(line?.[1])).toBeCloseTo(0.4, 5)
    expect(Number(line?.[2])).toBeCloseTo(0.4, 5)
  })
})

// The ANTI SKID switch (NATOPS 2.10.3.2, #114). ON, touchdown protection holds
// the pedals off from touchdown until the wheels spin up past 50 kt, or for
// 3 s if they do not, and does nothing below 10 kt. OFF, the sample says so and
// the flight core blows the main tyres under braking at speed (gear.go).
// Carrier operations fly it OFF (NATOPS 8.2.3).
const bridge = readFileSync(fileURLToPath(new URL('./flight.ts', import.meta.url)), 'utf8')
const wire = readFileSync(fileURLToPath(new URL('./net.ts', import.meta.url)), 'utf8')
const protection = /\nlet antiskid=true;\nlet spun=[^\n]*\nfunction brakes_held\(\)\{[^\n]*\n[^\n]*\n[^\n]*\n[^\n]*\n/.exec(source)?.[0] ?? ''
const pressfn = /\nfunction pit_press\(action,direction\)\{ const d=[\s\S]*?\n\t\} \}\n/.exec(source)?.[0] ?? ''
const KT = 1 / 1.94384

// roll feeds brakes_held a run of [time, grounded, knots, touchdown] frames
// with the switch as given and returns whether each frame held the pedals.
function roll(frames: [number, boolean, number, number][], on = true): boolean[] {
  if (!protection) throw new Error('the anti-skid block not found in engine.ts')
  return new Function('frames', 'on', `let sim_time=0; const ownship={ speed:0, grounded:false }, landing={ at:-Infinity }; ${protection}
    antiskid=on;
    return frames.map(([t,grounded,knots,at])=>{ sim_time=t; ownship.grounded=grounded; ownship.speed=knots; landing.at=at; return brakes_held(); });`)(
    frames.map(([t, grounded, knots, at]) => [t, grounded, knots * KT, at]), on) as boolean[]
}

describe('the ANTI SKID switch', () => {
  it('holds the pedals for 3 s after a touchdown the wheels do not spin up from', () => {
    expect(roll([[9, false, 45, -Infinity], [10, true, 45, 10], [12.9, true, 40, 10], [13.1, true, 38, 10]])).toEqual([false, true, true, false])
  })

  it('lets the pedals go the moment the wheels pass 50 kt, and keeps them free as the jet slows', () => {
    expect(roll([[9, false, 130, -Infinity], [10, true, 130, 10], [11, true, 45, 10], [12, true, 30, 10]])).toEqual([false, false, false, false])
  })

  it('protects each touchdown afresh after a bounce', () => {
    expect(roll([[10, true, 60, 10], [10.5, false, 48, 10], [11, true, 45, 11]])).toEqual([false, false, true])
  })

  it('does nothing below 10 kt, in the air, or with the switch OFF', () => {
    expect(roll([[10, true, 8, 10]])).toEqual([false])
    expect(roll([[10, false, 45, 9]])).toEqual([false])
    expect(roll([[10, true, 45, 10], [11, true, 40, 10]], false)).toEqual([false, false])
  })

  it('holds the pedals only, never the parking brake, and watches the spin-up every frame', () => {
    expect(source).toMatch(/\n\tconst withheld=brakes_held\(\);[^\n]*\n\tinput\.brake=\(keys\.has\(key_of\("brake\.wheel"\)\)&&!withheld\)\|\|parking;/)
    // read_input calls the module's held() for the trim switches: a local of that
    // name shadows it for the whole function and kills the frame loop at its first read
    const reader = /\nfunction read_input\(dt\)\{[\s\S]*?\n\}\n/.exec(source)?.[0] ?? ''
    expect(reader).toMatch(/held\("trim\.up"\)/)
    expect(reader).not.toMatch(/\b(?:const|let|var) held\b/)
  })

  it('spawns OFF for a cat shot and every recovery, ON from the field and in the air', () => {
    const line = /\n\tantiskid=st!=="carrier"&&!recovery_start\(\);[^\n]*\n/.exec(source)?.[0] ?? ''
    const recovery = /\nfunction recovery_start\(\)\{[^\n]*\n/.exec(source)?.[0] ?? ''
    expect(line).not.toBe('')
    expect(recovery).not.toBe('')
    const spawn = (st: string) => new Function('st', `let antiskid=null; const mission_start=()=>st; ${recovery} ${line} return antiskid;`)(st) as boolean
    expect(['carrier', 'case1', 'case2', 'case3'].map(spawn)).toEqual([false, false, false, false])
    expect(['runway', 'air', 'joust'].map(spawn)).toEqual([true, true, true])
  })

  it('is rigged OFF level and ON up, and a click throws it', () => {
    expect(source).toMatch(/\{ name:"antiskid", track:\/\^Switch_FULL_ANTISKID_LeftPanel_AN\/i, drive:"antiskid" \}/)
    expect(source).toMatch(/case "antiskid": f=\(st===ownship&&antiskid\)\?1:0; break;/)
    expect(/const PIT_SWITCHES=\{([\s\S]*?)\};/.exec(source)?.[1] ?? '').toContain('antiskid:"antiskid"')
    if (!pressfn) throw new Error('pit_press not found in engine.ts')
    const press = new Function('on', `let antiskid=on; ${pressfn} pit_press("antiskid",1); return antiskid;`)
    expect(press(true)).toBe(false)
    expect(press(false)).toBe(true)
  })

  it('reaches the flight core as bypass, flag bit 2048, in both samples', () => {
    expect(source).toMatch(/\n\t\tbypass:!antiskid, gear:\(ownship\.gearTarget\?\?0\)<0\.5,/)
    expect(source).toMatch(/brake:input\.brake, bypass:!antiskid, trim:/)
    expect(bridge).toMatch(/\n {2}bypass: boolean/)
    expect(bridge).toMatch(/\n {4}\(controls\.bypass \? 2048 : 0\) \|\n/)
    expect(wire).toMatch(/\n {2}bypass: boolean/)
  })
})
