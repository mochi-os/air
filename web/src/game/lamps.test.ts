// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The pit's flap position lights (NATOPS 2.8.4.3): HALF and FULL are green
// for the switch in that position below 250 kt; FLAPS is amber for HALF or
// FULL selected above 250 kt, or any flap off; none of them reads flap
// position. engine.ts cannot be imported (WebGL at module scope), so the flap
// lines of lamps_update are read as text and stepped against stand-ins.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
const block = /\n\tif\(l\.half\)\{ const slow=[\s\S]*?l\.flaps\.material\.opacity=[^\n]*\n/.exec(source)?.[0] ?? ''

interface Case { flap: number; kt: number; jam?: number }
// Returns the names of the flap lights on for a switch position, an airspeed
// (knots calibrated) and the leading-edge flap jam word.
function lit(c: Case): string[] {
  if (!block) throw new Error('flap lamp block not found in engine.ts')
  const run = new Function('c', `const STATE={cas:0, jam:1}, out=[c.kt/1.944, 0,0,0,0,0, c.jam||0];
    const lamp=()=>({material:{opacity:0}}), l={half:lamp(), full:lamp(), flaps:lamp()};
    const flap_select=c.flap; ${block}
    return Object.keys(l).filter((k)=>l[k].material.opacity>0.5);`)
  return run(c) as string[]
}

describe('the flap position lights', () => {
  it('show HALF or FULL in green for the switch below 250 kt', () => {
    expect(lit({ flap: 1, kt: 150 })).toEqual(['half'])
    expect(lit({ flap: 2, kt: 150 })).toEqual(['full'])
    expect(lit({ flap: 0, kt: 150 })).toEqual([])
  })

  it('show amber FLAPS instead once the switch is out of AUTO above 250 kt', () => {
    expect(lit({ flap: 1, kt: 260 })).toEqual(['flaps'])
    expect(lit({ flap: 2, kt: 300 })).toEqual(['flaps'])
    expect(lit({ flap: 0, kt: 300 })).toEqual([])
  })

  it('show amber FLAPS for a flap off at any speed, beside the green', () => {
    expect(lit({ flap: 1, kt: 150, jam: 1 })).toEqual(['half', 'flaps'])
    expect(lit({ flap: 0, kt: 400, jam: 1 })).toEqual(['flaps'])
  })

  it('build the three lamps into the gear light unit', () => {
    const build = /\nfunction build_lamps\(g\)\{[\s\S]*?g\.userData\.lamps=lamps;/.exec(source)?.[0] ?? ''
    expect(build).toMatch(/lamps\.half=lamp\(0x2fd24a/)
    expect(build).toMatch(/lamps\.full=lamp\(0x2fd24a/)
    expect(build).toMatch(/lamps\.flaps=lamp\(0xffc23a/)
    expect(build).toMatch(/gear\.add\(lamps\.transit,lamps\.nose,lamps\.left,lamps\.right,lamps\.half,lamps\.full,lamps\.flaps\)/)
  })
})
