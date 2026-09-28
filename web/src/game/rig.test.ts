// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// engine.ts cannot be imported (WebGL at module scope): the rig's drivers are
// read from its source, and burners is lifted out and run.
const source = readFileSync(
  fileURLToPath(new URL('./engine.ts', import.meta.url)),
  'utf8'
)
function lift(name: string): string {
  const start = source.indexOf(`function ${name}(`)
  expect(start, `${name} in engine.ts`).toBeGreaterThan(0)
  return source.slice(start, source.indexOf('\n', start))
}

describe("every jet's moving parts", () => {
  it('are eased and drawn for every remote in sight, not only the first', () => {
    // A furball's second remote onward used to fly its whole match in the
    // model's authored pose: the loop walked the pilot and the bandit alone.
    expect(source).toMatch(
      /function update_anim\(dt\)\{ const jets=\[ownship,bandit\];\n\tfor\(const st of remotes\.values\(\)\) if\(st!==bandit&&st\.group&&st\.group\.visible\) jets\.push\(st\);\n\tfor\(const st of jets\)\{/
    )
    expect(source).not.toMatch(/for\(const st of \[ownship,bandit\]\)/)
  })

  it("light another jet's flames, nozzle and cones from its own burner, not the setting", () => {
    expect(source).toMatch(
      /const rh=\(st===ownship\)\?\(ownship\.reheats\|\|\[0,0\]\):\(cfg\.afterburner\?burners\(st\):\[0,0\]\);/
    )
    expect(source).toMatch(
      /stage=own\?\(ownship\.stage\?\?0\):Math\.max\(\.\.\.burners\(st\)\);/
    )
    expect(source).toMatch(
      /afterburner\(bandit\.group,cfg\.afterburner&&Math\.max\(\.\.\.burners\(bandit\)\)>0\.15\);/
    )
    expect(source).toMatch(
      /for\(const st of remotes\.values\(\)\) if\(st!==bandit&&st\.group\.visible\) afterburner\(st\.group,cfg\.afterburner&&Math\.max\(\.\.\.burners\(st\)\)>0\.15\);/
    )
    // The stand-in that lit every other jet's burner for the whole flight.
    expect(source).not.toMatch(
      /\[cfg\.afterburner\?1:0,cfg\.afterburner\?1:0\]/
    )
    expect(source).not.toMatch(
      /stage=own\?\(ownship\.stage\?\?0\):\(cfg\.afterburner\?1:0\)/
    )
  })

  it("reads each jet's burner where it has one: per engine, or a remote's one burner on both", () => {
    const ownship = { reheats: [0.4, 0.6] }
    const burners = new Function(
      'ownship',
      `${lift('burners')}; return burners`
    )(ownship) as (st: object) => number[]
    expect(burners(ownship)).toEqual([0.4, 0.6])
    expect(burners({ reheats: [0, 1], reheat: 1 })).toEqual([0, 1]) // the bandit: per engine, achieved
    expect(burners({ reheat: 0.8 })).toEqual([0.8, 0.8]) // a remote: the pose's one burner
    expect(burners({})).toEqual([0, 0])
  })
})
