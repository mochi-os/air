// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// A physical lever that has lost its control - the keyboard or ATC took the
// throttle, or the stick dropped out for a frame - takes it back softly, where it
// meets the setting. Reported on short final: once the lever had lost control,
// small corrections did nothing and the first large one jumped the throttle.
// engine.ts cannot be imported (WebGL at module scope), so pad_lever() is read as
// text and run against a stand-in stick, as trim-law.test.ts does.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
const code = /\nfunction pad_lever\([\s\S]*?\n\treturn [^\n]*\}\n/.exec(source)?.[0] ?? ''

// One lever on axis 0, released: step(travel, current) is one frame at that lever
// travel (0..1) with the control set to `current`, returning what the lever commands.
function released() {
  if (!code) throw new Error('pad_lever() not found in engine.ts')
  const run = new Function(`const THREE={MathUtils:{clamp:(v,a,b)=>Math.min(Math.max(v,a),b)}}; const pad_levers={};
    ${code}
    const pad={axes:[0]};
    return { step:(travel,current)=>{ pad.axes[0]=travel*2-1; return pad_lever(pad,"0","lever",current); },
             release:()=>{ if(pad_levers.lever){ pad_levers.lever.armed=false; pad_levers.lever.rest=undefined; } } };`)
  return run() as { step: (travel: number, current: number) => number | null; release: () => void }
}

describe('a lever that lost its control takes it back softly', () => {
  it('takes effect on a small correction where it already meets the setting', () => {
    const lever = released()
    expect(lever.step(0.4, 0.4)).toBeNull() // first sight after the release: nothing commanded yet
    const took = lever.step(0.407, 0.4) // a 0.7% nudge - far under the old 7.5% sweep
    expect(took).not.toBeNull()
    expect(Math.abs((took ?? 0) - 0.4)).toBeLessThan(0.02) // and no jump
  })

  it('ignores a lever parked away from the setting, however far it is moved short of it', () => {
    const lever = released()
    expect(lever.step(0.2, 0.6)).toBeNull()
    expect(lever.step(0.25, 0.6)).toBeNull()
    expect(lever.step(0.45, 0.6)).toBeNull() // a 25% sweep that still stops short: the old rule armed and snapped here
  })

  it('takes over as it moves through the setting, at the setting', () => {
    const lever = released()
    lever.step(0.5, 0.6)
    let took: number | null = null
    for (let travel = 0.5; travel <= 0.7 && took === null; travel += 0.04) took = lever.step(travel, 0.6) // 4% a frame: steps over the 1% window at 0.58 -> 0.62
    expect(took).not.toBeNull()
    expect(Math.abs((took ?? 0) - 0.6)).toBeLessThan(0.045) // within one frame's movement of the setting
  })

  it('never hands the control to a parked lever that ATC drives the setting past', () => {
    const lever = released()
    lever.step(0.5, 0.45)
    for (let current = 0.45; current <= 0.56; current += 0.005) expect(lever.step(0.5, current)).toBeNull()
  })

  it('does not take over on a phantom-centre jump over the setting', () => {
    const lever = released()
    expect(lever.step(0.5, 0.3)).toBeNull() // a reconnected stick reporting its phantom centre
    expect(lever.step(0.2, 0.3)).toBeNull() // the real position arrives, far past the setting in one frame
  })

  it('passes each lever the setting it would command, in its own travel units', () => {
    expect(source).toContain('pad_lever(pad,bind.axes.throttle,"throttle",1-throttle_travel())')
    expect(source).toContain('pad_lever(pad,bind.axes.speedbrake,"speedbrake",ownship.speedbrakeTarget??0)')
  })
})

// The pit's levers stand where a physical lever would (NATOPS 2.1.1.7.2): the dry
// range to the MIL detent over the first three quarters of their travel and the
// afterburner zones over the last, so MIL and MAX no longer look the same.
describe('the throttle levers', () => {
  const body = /\nfunction throttle_travel\(\)\{[^\n]*\}\n/.exec(source)?.[0] ?? ''
  const travel = (throttle: number, burner: number) =>
    new Function('ownship', `${body} return throttle_travel();`)({ throttle, burner }) as number

  it('run from IDLE through the MIL detent into MAX', () => {
    expect(body).not.toBe('')
    expect(travel(0, 0)).toBe(0)
    expect(travel(0.5, 0)).toBeCloseTo(0.375)
    expect(travel(1, 0)).toBe(0.75)
    expect(travel(1, 0.5)).toBeCloseTo(0.875)
    expect(travel(1, 1)).toBe(1)
  })

  it('turn each lever through the whole clip from its own gauge', () => {
    expect(source).toMatch(/\{ name:"throttleA",[^\n]*gain:0\.698, gauge:"throttleL" \}/)
    expect(source).toMatch(/\{ name:"throttleB",[^\n]*gain:0\.698, gauge:"throttleR" \}/)
    expect(source).toContain('throttleL:secured[0]?THROTTLE_OFF:throttle_travel(), throttleR:secured[1]?THROTTLE_OFF:throttle_travel(),')
  })
})

// The afterburner lockout (NATOPS 2.1.1.7.2, #118): with weight on the wheels and
// the launch bar extended or the hook down, the throttles stop at MIL. The keys
// pass it with a second push straight after the first (the finger lifts raised),
// a physical lever only at its forward stop (the 32 lb that forces it).
describe('the afterburner lockout', () => {
  const state = /\nconst lockout=\{[^\n]*\nfunction locked_out\(\)\{[^\n]*\n/.exec(source)?.[0] ?? ''
  const keys = /\n\tconst advancing=keys\.has\(key_of\("throttle\.up"\)\);\n[\s\S]*?\n\tif\(advancing\)\{[^\n]*\n/.exec(source)?.[0] ?? ''
  type Throttle = { frame(held: boolean, dt: number): number; pull(): void }
  const throttle = (w: { bar?: number; hook?: number; ground?: boolean }) => {
    if (!state || !keys) throw new Error('the lockout not found in engine.ts')
    return new Function('w', `const keys=new Set(), key_of=(a)=>a, ownship={ throttle:1, burner:0, bar:w.bar??0, hook:w.hook??0 }; let sim_time=0;
      const on_ground=()=>w.ground??true; ${state}
      return { frame(held,dt){ if(held) keys.add("throttle.up"); else keys.delete("throttle.up"); sim_time+=dt; ${keys} return ownship.burner; }, pull(){ ownship.burner=0; } };`)(w) as Throttle
  }
  const hold = (t: Throttle, seconds: number, held = true) => { let b = 0; for (let i = 0; i < seconds * 10; i++) b = t.frame(held, 0.1); return b }

  it('lets the keys through MIL with nothing extended, and in the air whatever is down', () => {
    expect(hold(throttle({}), 1)).toBeGreaterThan(0.5)
    expect(hold(throttle({ hook: 1, ground: false }), 1)).toBeGreaterThan(0.5)
  })

  it('holds the keys at MIL with the launch bar or the hook down until a second push straight after the first', () => {
    for (const w of [{ bar: 1 }, { hook: 1 }]) {
      const t = throttle(w)
      expect(hold(t, 1), JSON.stringify(w)).toBe(0)
      hold(t, 0.3, false)
      expect(hold(t, 1), JSON.stringify(w)).toBeGreaterThan(0.5) // pushed again within half a second: through the detent
      const slow = throttle(w)
      hold(slow, 1); hold(slow, 0.8, false)
      expect(hold(slow, 1), JSON.stringify(w)).toBe(0) // too late: the lifts dropped back
    }
  })

  it('drops the finger lifts back once the levers come back to MIL', () => {
    const t = throttle({ bar: 1 })
    hold(t, 1); hold(t, 0.3, false)
    expect(hold(t, 1)).toBeGreaterThan(0.5)
    t.pull(); hold(t, 1, false)
    expect(hold(t, 1)).toBe(0)
  })

  it('takes a physical lever into the burner range only at its forward stop while the lockout is out', () => {
    expect(source).toMatch(/ownship\.burner=locked_out\(\)&&lever<0\.99\?0:THREE\.MathUtils\.clamp\(\(lever-0\.75\)\/0\.25,0,1\);/)
    expect(source).toMatch(/ownship\.burner=locked_out\(\)&&power<0\.99\?0:THREE\.MathUtils\.clamp\(\(power-0\.75\)\/0\.25,0,1\);/)
    const out = (w: { bar?: number; burner?: number; ground?: boolean }) => new Function('w', `const ownship={ bar:w.bar??0, hook:0, burner:w.burner??0 }, on_ground=()=>w.ground??true; ${state} return locked_out();`)(w) as boolean
    expect(out({ bar: 1 })).toBe(true)
    expect(out({ bar: 1, burner: 0.2 })).toBe(false) // past the detent there is nothing to hold
    expect(out({ bar: 1, ground: false })).toBe(false)
    expect(out({})).toBe(false)
  })
})

// A secured engine's lever goes over its finger lift to OFF, 4° aft of IDLE
// (NATOPS 2.1.1.7.2, #34): the gauge the lever's rig entry turns it by.
describe('the throttle at OFF', () => {
  it('stands a secured engine\'s lever aft of IDLE', () => {
    const off = Number(/\nconst THROTTLE_OFF=(-?[\d.]+);/.exec(source)?.[1])
    expect(off).toBeCloseTo(-0.1)
    expect(off * 40).toBeCloseTo(-4) // degrees of the 40° IDLE-to-MAX clip
  })
})

