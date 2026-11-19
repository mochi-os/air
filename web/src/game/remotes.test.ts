// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { HOME, settle, theatre } from './earth'

// Another player's jet in a match: what it is drawn with, and what it takes
// with it when it goes. engine.ts cannot be imported (WebGL at module scope),
// so the functions are lifted from its source and run against stand-ins.
const engine = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
function lift(name: string): string {
  const start = engine.indexOf(`\nfunction ${name}(`) + 1
  expect(start, name).toBeGreaterThan(0)
  const rest = engine.slice(start)
  const end = /\n(?=\S)/.exec(rest.slice(1))
  return end ? rest.slice(0, end.index + 1) : rest
}
const OCCUPANT = /\nconst OCCUPANT=[^\n]*\n/.exec(engine)?.[0] ?? ''
const JETS = /\nlet jets_every=[^\n]*\n/.exec(engine)?.[0] ?? ''
// whole lifts a function whose closing brace stands on a line of its own
function whole(name: string): string {
  const start = engine.indexOf(`\nfunction ${name}(`) + 1
  expect(start, name).toBeGreaterThan(0)
  return engine.slice(start, engine.indexOf('\n}\n', start) + 3)
}

class Material {
  disposed = 0
  constructor(public name: string) {}
  dispose() {
    this.disposed++
  }
}
// group is a jet as apply_model_to leaves it: meshes drawn with the fleet's
// shared materials, its own glow and burner clones, a gear lamp, and a painted
// part apply_livery cloned
function group() {
  const shared = new Material('shared'), glow = new Material('glow'), burner = new Material('burner'), lamp = new Material('lamp'), paint = new Material('paint')
  const meshes = [
    { isMesh: true, material: shared, userData: {} },
    { isMesh: true, material: glow, userData: {} },
    { isMesh: true, material: paint, userData: { liveried: true } },
    { isMesh: true, material: [shared, burner], userData: {} },
  ]
  const g = { visible: true, userData: { glow: [glow], burner: [burner], gearLamps: { landing: lamp } }, traverse: (f: (o: unknown) => void) => meshes.forEach(f) }
  return { g, shared, owned: [glow, burner, lamp, paint] }
}

describe('a jet that leaves the match', () => {
  it('disposes the materials it made for itself and none of the fleet’s', () => {
    const { g, shared, owned } = group()
    const remotes = new Map<number, unknown>([[3, { group: g }]])
    const removed: unknown[] = []
    new Function('remotes', 'scene', `const bandit = {}, audio_remote_drop = () => {}
      ${lift('jet_owned')}${lift('remote_drop')} remote_drop(3)`)(remotes, { remove: (o: unknown) => removed.push(o) })
    expect(removed).toEqual([g])
    expect(owned.map((m) => m.disposed)).toEqual([1, 1, 1, 1])
    expect(shared.disposed, 'the fleet prototype’s, every other jet’s too').toBe(0)
  })
})

describe("a remote jet's rails", () => {
  // world runs body with remote_for and remote_magazine over a match whose
  // roster grants slot 5 a two-heater loadout, the player's own magazine six
  const world = (body: string) =>
    new Function(
      'body',
      `const remotes = new Map(), stores_rounds = (lo) => lo.rounds, magazine = () => 6, update_rails = () => {}, rearm_order = () => {}
       const roster = new Map([[5, { rounds: [1, 2] }]])
       const remote_racks = (st, slot) => { if (roster.has(slot) && !st.loadout) st.loadout = roster.get(slot) }
       const bandit = { group: { visible: false }, msl: 1, amraam: 0, loadout: { rounds: [1, 2, 3, 4, 5, 6, 7, 8] }, order: ['9m'], struck: 40, spent: 300, mechanisms: { nose: 1 } }
       const make_state = () => ({}), make_jet = () => ({ visible: false, traverse: () => {}, userData: {} }), scene = { add: () => {}, remove: () => {} }, model_active = false, apply_model_to = () => {}
       const THREE = { Vector3: class {} }, ownship = { own: true }, audio_remote_drop = () => {}, jet_owned = () => []
       ${OCCUPANT}${JETS}${lift('jets_refresh')}${lift('jets_all')}${lift('jets_other')}${lift('remote_magazine')}${lift('remote_for')}${lift('remote_drop')}
       ${body}`
    )() as Record<string, unknown>

  it('are his own loadout’s when he respawns, not the player’s', () => {
    const respawn = /\n\t\telse \{ const st=remotes\.get\(slot\); if\(st\)\{ st\.msl=[^\n]*\n/.exec(engine)?.[0] ?? ''
    expect(respawn).not.toBe('')
    const st = world(`const st = remote_for(5); st.msl = 0; const slot = 5; ${respawn.trim().replace(/^else /, '')}\n return st`)
    expect(st.msl).toBe(2)
  })

  it('are walked with every jet in the match: one that joins at once, none that has left', () => {
    expect(JETS).not.toBe('')
    const seen = world(`const n = () => [jets_all().length, jets_other().length]; const at = [n()]
      const a = remote_for(5); at.push(n()); const b = remote_for(6); at.push(n()); remote_drop(6); at.push(n())
      return { at, other: jets_other().includes(a) && !jets_other().includes(b) && !jets_other().includes(ownship) }`)
    expect(seen).toEqual({ at: [[2, 1], [2, 1], [3, 2], [2, 1]], other: true })
  })

  it('start fresh on the bandit’s state, with nothing of the last pilot who flew it', () => {
    const st = world(`return remote_for(5)`)
    expect(st.loadout).toEqual({ rounds: [1, 2] }) // the roster's grant, and no jettison from the last loadout
    expect(st.msl).toBe(2)
    expect([st.struck, st.spent, st.order, st.mechanisms]).toEqual([undefined, undefined, undefined, undefined])
  })
})

describe('the external padlock view', () => {
  const view = /\n\telse if\(cfg\.view==="padlock"\)\{[^\n]*\n[^\n]*\n/.exec(engine)?.[0] ?? ''
  // aimed runs the view's lines with look_target naming a jet or none, and
  // answers where the camera was pointed
  const aimed = (target: unknown) => {
    const seen: unknown[] = []
    new Function(
      'target',
      'seen',
      `const cfg = { view: 'padlock' }, ahead = { ahead: true }
       const eye = {}, _cam_eye = {}, _cam_target = { copy: () => ({ addScaledVector: () => ahead }) }
       const camera = { position: { copy: () => {} }, up: { set: () => {} }, lookAt: (p) => seen.push(p) }
       const camera_floor = () => eye, body_offset = () => eye, ownship = { fwd: {} }
       const look_target = () => target, datum = (t) => ({ drawn: t.name })
       const has_enemy = false, bandit = { pos: { bandit: true } }
       if (false) {} ${view.trim()}`
    )(target, seen)
    return seen[0]
  }
  it('watches the jet the cockpit padlock would, where it is drawn, in a match too', () => {
    expect(view).not.toBe('')
    expect(aimed({ name: 'remote' })).toEqual({ drawn: 'remote' })
  })
  it('looks ahead with no one to watch', () => {
    expect(aimed(null)).toEqual({ ahead: true })
  })
})

describe('the sea', () => {
  // ended runs check_collisions with the jet at a height over open water
  const ended = (height: number, multiplayer: boolean) => {
    const deaths: string[] = []
    new Function(
      'height',
      'multiplayer',
      'deaths',
      `const MULTIPLAYER = multiplayer, crash_t = 0, has_enemy = false, ownship = { pos: {} }
       const theatre = { frame: { altitude: () => height } }, ground_height = () => -1e9
       const crash_ownship = (why) => deaths.push(why)
       ${/\nconst SEA=[^\n]*\n/.exec(engine)?.[0] ?? ''}${whole('check_collisions')} check_collisions(1 / 60)`
    )(height, multiplayer, deaths)
    return deaths
  }
  it('ends a flight at the height the core and the server are given', () => {
    expect(engine).toMatch(/return \{ sea:SEA, fields/)
    expect([ended(3.2, false), ended(2.9, false)]).toEqual([[], ['sea']])
  })
  it('is the server’s to judge in a match', () => {
    expect(ended(1, true)).toEqual([])
  })
})

// A move of the engine's frame carries every point a round holds: a heater a
// flare has blinded steers for the lure for a second and a half, and a lure
// left in the old frame lay some 4 km from the flare.
describe('a round through a move of the frame', () => {
  it('carries its lure with its position', () => {
    const line = /\n\tfor\(const m of missiles\) if\(m\.active\)\{ moved_fields[^\n]*\n/.exec(engine)?.[0] ?? ''
    expect(line).not.toBe('')
    const m = { active: true, px: 10, py: 1000, pz: 0, vx: 1, vy: 0, vz: 0, lx: 50, ly: 990, lz: 5 }
    new Function(
      'missiles',
      `const _carried = {}, moved = (v) => { v.x -= 4000; return v }, turned = () => {}
       ${lift('moved_fields')}
       ${lift('turned_fields')}
       ${line}`
    )([m])
    expect([m.px, m.lx, m.ly, m.lz]).toEqual([-3990, -3950, 990, 5])
  })
})

// A round goes out at the sea, judged by its height over the water: the
// frame's own y is that only beneath the frame's anchor, and 40 km out the
// frame's level stands 125 m above the sea.
describe('a round low over the sea, far from the frame’s anchor', () => {
  it('flies on above the water, and goes out under it', () => {
    settle(HOME)
    const sunk = new Function('theatre', `${/\nconst _sunk=[^\n]*\n/.exec(engine)?.[0] ?? ''}${lift('sunk')} return sunk`)(theatre) as (x: number, y: number, z: number) => boolean
    expect([sunk(40000, -50, 0), sunk(40000, -130, 0)]).toEqual([false, true])
    expect([sunk(0, 1, 0), sunk(0, -1, 0)]).toEqual([false, true])
  })
  it('is how the AMRAAM, the 9M and a falling store meet the sea', () => {
    expect(engine).toMatch(/\n\tconst wet=sunk\(m\.px,m\.py,m\.pz\);/) // step_amraam
    expect(engine).toMatch(/\n\tif\(sunk\(m\.px,m\.py,m\.pz\)\)\{ m\.active=false; m\.mesh\.visible=false; post\("ocean"\); continue; \}/) // step_missiles
    expect(engine).toMatch(/if\(f\.age>15\|\|sunk\(f\.piece\.position\.x,f\.piece\.position\.y,f\.piece\.position\.z\)\)/) // falling_update
    expect(engine).not.toMatch(/m\.py<=0|f\.piece\.position\.y<0/)
  })
})

describe('the attack format', () => {
  it('reads a contact’s height over the sea, which far out lies well under the frame’s level', () => {
    settle(HOME)
    const height = new Function('theatre', `${/\nconst _rdr_at=[^\n]*\n/.exec(engine)?.[0] ?? ''}${lift('rdr_height')}
 return rdr_height`)(theatre) as (o: object, a: number, r: number, e: number) => number
    const own = { x: 0, y: 3000, z: 0, heading: 0 }
    expect(height(own, 0, 0, 0)).toBeCloseTo(3000 * 3.281, -1)
    expect(height(own, 0, 40 * 1852, 0) - 3000 * 3.281).toBeGreaterThan(1300) // 40 nm out, level with the jet in the frame: some 1,400 ft higher over the sea
  })
  it('shows the trackfiles and the data block at that height', () => {
    expect(engine).toMatch(/x\.fillText\(Math\.round\(theatre\.frame\.altitude\(t\)\*3\.281\/1000\)\+" KFT"/)
    expect(engine).toMatch(/x\.fillText\(String\(Math\.round\(theatre\.frame\.altitude\(t\)\*3\.281\/1000\)\),px,py\+26\)/)
    expect(engine).not.toMatch(/t\.y\*3\.281\/1000/)
  })
})

describe("another jet's jettisoned stores", () => {
  it('leave it at its own velocity', () => {
    const falling: { vel: { x: number; y: number; z: number } }[] = []
    const node = { visible: true, parent: { updateWorldMatrix: () => {}, matrixWorld: {} }, clone: () => ({ applyMatrix4: () => {}, traverse: () => {} }) }
    const st = { racks: { nodes: { tank: node }, parts: {} }, speed: 250, fwd: { x: 1, y: 0, z: 0 }, velx: 0, vely: 0, velz: -250 }
    class Vector3 {
      constructor(public x = 0, public y = 0, public z = 0) {}
      multiplyScalar(k: number) {
        this.x *= k
        this.y *= k
        this.z *= k
        return this
      }
    }
    // the names the function reaches that this does not ask about answer as inert stand-ins
    const inert: unknown = new Proxy(function () {}, { get: () => inert, apply: () => inert })
    const vars: Record<string, unknown> = { st, falling, THREE: { Vector3 }, scene: { add: () => {} } }
    const scope = new Proxy(vars, {
      has: (_, k) => typeof k === 'string' && !['Math', 'Object', 'Array', 'String', 'Set', 'Map', 'undefined'].includes(k),
      get: (t, k) => (k === Symbol.unscopables ? undefined : k in t ? t[k as string] : inert),
    })
    new Function('scope', `with (scope) { ${lift('separate_debris')}\n separate_debris(st, ['tank']) }`)(scope)
    expect(falling).toHaveLength(1)
    expect(falling[0].vel.z).toBeCloseTo(-247.5, 6) // his velocity, not his nose and not a standstill
    expect(falling[0].vel.x).toBeCloseTo(0, 6)
  })
})
