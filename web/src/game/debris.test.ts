// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Debris: a kill's wreckage strikes a jet flying through it (world
// battle/debris.go decides it). engine.ts cannot be imported (WebGL at module
// scope): what lays and meets the wreckage is lifted from its source and run
// against stand-ins.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
function lift(name: string): string {
  const start = source.indexOf(`function ${name}(`)
  expect(start, `${name} in engine.ts`).toBeGreaterThan(0)
  const rest = source.slice(start)
  const end = /\n(?=\S)/.exec(rest.slice(1))
  return end ? rest.slice(0, end.index + 1) : rest
}

describe('the bandit falls', () => {
  const destroy = (why: string) => {
    const laid: unknown[][] = []
    new Function(
      'flight_debris_lay',
      `const bandit={ pos:{x:1,y:2000,z:3}, velx:150, vely:-5, velz:0, group:{ visible:true } };
       let has_enemy=true, sim_time=12; const cfg={}; const BANDIT="Bandit";
       const explosion_at=()=>{}, feed=()=>{}, opponent=()=>"", notice=()=>{}, translate=(t)=>t;
       ${lift('bandit_destroy')}
       bandit_destroy(${JSON.stringify(why)});`
    )((...args: unknown[]) => laid.push(args))
    return laid
  }

  it('leaves its wreckage in the air where it was killed there', () => {
    for (const why of ['verdict', 'fire', 'midair']) {
      expect(destroy(why), why).toEqual([[{ x: 1, y: 2000, z: 3 }, { x: 150, y: -5, z: 0 }]])
    }
  })

  it('leaves none in the air when it met the ground, the sea or something built', () => {
    for (const why of ['ground', 'sea', 'building', 'post', 'island']) {
      expect(destroy(why), why).toEqual([])
    }
  })
})

describe('the pilot flies through it', () => {
  const struck = (met: unknown) =>
    new Function(
      'flight_debris_meet',
      `const ownship={ struck:3 }; let hit_flash=0; const heard=[]; const audio_hit=(n)=>heard.push(n);
       ${lift('debris_struck')}
       debris_struck(); return { struck: ownship.struck, hit_flash, heard };`
    )(() => met) as { struck: number; hit_flash: number; heard: number[] }

  it('counts each strike as a hit taken, and flashes and thuds for it', () => {
    expect(struck({ strikes: 2, mask: 0, impacts: [] })).toEqual({ struck: 5, hit_flash: 0.5, heard: [2] })
  })

  it('feels nothing when nothing struck, or the core has no debris', () => {
    expect(struck({ strikes: 0, mask: 0, impacts: [] })).toEqual({ struck: 3, hit_flash: 0, heard: [] })
    expect(struck(null)).toEqual({ struck: 3, hit_flash: 0, heard: [] })
  })

  it('is met every frame the pilot flies alone, and never in a match, a replay, a crash or under the invulnerable cheat', () => {
    expect(lift('step_world')).toContain('fly_player(dt); if(!MULTIPLAYER&&!playback&&crash_t<=0&&!cheat("invulnerable")) debris_struck();')
  })
})
