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
    expect(source).toContain('pad_lever(pad,bind.axes.throttle,"throttle",1-((ownship.burner??0)>0?0.75+0.25*ownship.burner:Math.min(1,ownship.throttle??0)*0.75))')
    expect(source).toContain('pad_lever(pad,bind.axes.speedbrake,"speedbrake",ownship.speedbrakeTarget??0)')
  })
})
