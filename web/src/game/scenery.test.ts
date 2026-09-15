// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The scenery the flight core collides against (#28): one build of it on the
// client, flown directly in single player and, in a match, replaced by the
// copy the world server serves so prediction and the server's verdict agree.
// engine.ts cannot be imported (WebGL at module scope), so the pieces are read
// as text; scenery() is run with stand-ins.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
const wire = readFileSync(fileURLToPath(new URL('./net.ts', import.meta.url)), 'utf8')

function body(name: string): string {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`${name} not found in engine.ts`)
  const end = source.indexOf('\nfunction ', start + 1)
  return source.slice(start, end < 0 ? undefined : end)
}

interface Prism {
  outline: { x: number; z: number }[]
  top: number
}
interface Post {
  position: { x: number; z: number }
  radius: number
  top: number
}
interface Field {
  height: number
  strips?: unknown[]
  coast?: unknown[]
}
interface Scenery {
  sea: number
  fields: Field[]
  carrier: unknown
  prisms: Prism[]
  posts: Post[]
}

// Runs scenery() over a two-building, one-post map with a carrier island.
function scenery(): Scenery {
  const block = /function scenery\(\)\{[\s\S]*?return \{ sea:3, fields, carrier, prisms, posts \};[^\n]*\n\}/.exec(source)?.[0] ?? ''
  if (!block) throw new Error('scenery not found in engine.ts')
  const run = new Function(`const ISLAND_H=3.5, AIRFIELD_FLOAT=1.46, RUNWAY_FLOAT=1.5, D2R=Math.PI/180, CARRIER_YD=0, STRIP_ULAT=1, STRIP_UFA=0, strip_lat=()=>0;
    const CARRIER={x:0,z:0,deckY:20}, SHIP={outline:[[0,0],[1,0],[1,1]], shuttles:[], wires:[], halfspan:1, stroke:1, speed:1};
    const physics_strips=[{a:[0,0],b:[100,0],w:46}];
    const runway_strips=[{a:[-1500,0],b:[1500,0],w:60}];
    const obstacles={ islands:[{pts:[[0,0],[10,0],[10,10]]}], buildings:[{pts:[[0,0],[10,0],[10,10],[0,10]],topY:12},{pts:[[20,0],[30,0],[30,10]],topY:8}], posts:[{x:5,z:5,r:2,y1:9}] };
    const carrier_island=()=>({ prism:{ outline:[{x:-10,z:-10},{x:10,z:-10},{x:10,z:10},{x:-10,z:10}], top:44 }, post:{ position:{x:0,z:0}, radius:1.5, top:60 } });
    ${block}
    return scenery();`) as () => Scenery
  return run()
}

describe('the scenery', () => {
  it('carries the buildings as prisms, the posts as posts, and the carrier island as a prism with its mast as a post', () => {
    const world = scenery()
    expect(world.sea).toBe(3)
    expect(world.fields).toHaveLength(3)
    expect(world.prisms).toHaveLength(3)
    expect(world.prisms[0]).toEqual({ outline: [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 10 }], top: 12 })
    expect(world.prisms[2].top).toBe(44)
    expect(world.posts).toEqual([{ position: { x: 5, z: 5 }, radius: 2, top: 9 }, { position: { x: 0, z: 0 }, radius: 1.5, top: 60 }])
  })

  // The runway sits PROUD of the taxiways and aprons, so it needs its own field
  // at its own height. World.surface returns the FIRST strip it hits, so the
  // runway field must lead: where the two overlap, the runway is the real
  // surface. It was collided at AIRFIELD_FLOAT while being drawn at
  // RUNWAY_FLOAT, which rested the jet 4 cm below its own runway (#220).
  it('collides the runway at the height it is drawn, and ahead of the aprons', () => {
    const world = scenery()
    expect(world.fields[0].height).toBeCloseTo(3.5 + 1.5, 6)
    expect(world.fields[0].strips).toHaveLength(1)
    expect(world.fields[1].height).toBeCloseTo(3.5 + 1.46, 6)
    expect(world.fields[0].height).toBeGreaterThan(world.fields[1].height)
    // and the drawn surface reads the same constant, not a repeated literal
    expect(source).toMatch(/_ground_kind="runway"; return ISLAND_H\+RUNWAY_FLOAT;/)
  })

  it('is what single player flies, and what the developer export writes', () => {
    expect(source).toMatch(/return \{ aircraft:cfg\.aircraft\|\|"fa18c", environment:weather\(\), world:scenery\(\) \};/)
    expect(source).toMatch(/dev_geometry=\(\)=>\(airports\.length&&carrier_model\)\?geometry_canonical\(scenery\(\)\):null/)
  })

  it('is replaced in a match by the copy the server serves, which the core waits for', () => {
    expect(source).toMatch(/if\(MULTIPLAYER\) return \{ aircraft:own_aircraft\(\),[^\n]*world:\(net&&net\.geometry\)\|\|\{ sea:3 \} \};/)
    expect(source).toMatch(/if\(MULTIPLAYER && !\(net&&net\.welcome&&net\.geometry\)\) return;/)
    expect(wire).toMatch(/net\.geometry = \{ sea: 3 \}/)
    expect(wire).toMatch(/fetch\(join\.server \+ '\/maps\/' \+ encodeURIComponent\(chart\.name\)/)
    expect(wire).toMatch(/map\?: \{ name: string; hash: string \}/)
  })

  it('leaves the client no scenery test of its own: the crash probes judge buildings, masts and the island', () => {
    const check = body('check_collisions')
    expect(check).not.toMatch(/obstacles\.buildings|obstacles\.posts|deck_y_at|"building"|"post"|"island"/)
    expect(check).toMatch(/crash_ownship\("sea"\)/)
    expect(check).toMatch(/crash_ownship\("midair",BANDIT\)/)
    expect(source).toMatch(/if\(out\[STATE\.contact\]>=0\)\{ flight_clear\(\);[^\n]*crash_ownship\("probe"\)/)
  })
})
