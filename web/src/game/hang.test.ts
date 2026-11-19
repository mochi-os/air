// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import points from '../assets/fa18c.json'
import { outfit, parts, place, rounds, type Fittings } from './hang'
import { departed, entries, normalize, PRESETS, sequence, SHOWCASE } from './stores'

const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 6)

describe('rounds', () => {
  it('hangs each round on the rail that suits it (claude/plans/air-fa18c.md #9)', () => {
    expect(rounds(9, { fixture: 'rail', stores: ['9m'] })).toEqual([{ name: 'tip9', part: 'rail_9', kind: 'aim9m' }])
    expect(rounds(2, { fixture: 'twin', stores: ['9m', '120c'] })).toEqual([
      { name: '9m2a', part: 'rail_2a', kind: 'aim9m' },
      { name: '120c2b', part: 'launcher_2b', kind: 'aim120c' },
    ])
    expect(rounds(8, { fixture: 'rail', stores: ['9m'] })).toEqual([{ name: '9m8', part: 'rail_8a', kind: 'aim9m' }])
    expect(rounds(8, { fixture: 'rail', stores: ['120c'] })).toEqual([{ name: '120c8', part: 'rack_8', kind: 'aim120c' }])
    expect(rounds(3, { fixture: 'pylon', stores: ['120c'] })).toEqual([{ name: '120c3', part: 'rack_3', kind: 'aim120c' }])
    expect(rounds(6, { fixture: 'rail', stores: ['120c'] })).toEqual([{ name: '120c6', part: 'ejector_6', kind: 'aim120c' }])
    expect(rounds(7, { fixture: 'pylon', stores: ['tank'] })).toEqual([])
  })
})

describe('parts', () => {
  it('shows what each fixture and store needs', () => {
    expect(parts(1, { fixture: 'rail', stores: ['9m'] })).toEqual([])
    expect(parts(2, { fixture: '', stores: [] })).toEqual([])
    expect(parts(2, { fixture: 'twin', stores: ['9m', '120c'] }).sort()).toEqual(['launcher_2b', 'pylon_2', 'rack_2', 'rail_2a'])
    expect(parts(2, { fixture: 'twin', stores: ['', '120c'] }).sort()).toEqual(['launcher_2a', 'launcher_2b', 'pylon_2', 'rack_2'])
    expect(parts(2, { fixture: 'twin', stores: ['', ''] }).sort()).toEqual(['pylon_2', 'rack_2', 'rail_2a', 'rail_2b'])
    // a single AIM-9 rides the outboard LAU-7 with the inboard one fitted and
    // empty, on the outboard pylon's rail and the inboard pylon alike
    expect(parts(8, { fixture: 'rail', stores: ['9m'] }).sort()).toEqual(['pylon_8', 'rack_8', 'rail_8a', 'rail_8b'])
    expect(parts(3, { fixture: 'pylon', stores: ['9m'] }).sort()).toEqual(['pylon_3', 'rack_3', 'rail_3a', 'rail_3b'])
    expect(parts(8, { fixture: 'rail', stores: [''] }).sort()).toEqual(['pylon_8', 'rack_8'])
    expect(parts(7, { fixture: 'pylon', stores: ['tank'] }).sort()).toEqual(['pylon_7', 'tank_7'])
    expect(parts(7, { fixture: 'pylon', stores: [''] })).toEqual(['pylon_7'])
    expect(parts(5, { fixture: 'pylon', stores: ['tank'] }).sort()).toEqual(['pylon_5', 'tank_5'])
    expect(parts(4, { fixture: 'rail', stores: ['120c'] })).toEqual(['ejector_4'])
  })
  // Every part and round a loadout can name is one the model builds and the
  // points file seats: a preset or a hand-built loadout never asks for a part
  // fa18c.glb lacks.
  it('names only parts the points file lists, and seats every round', () => {
    const doc = points as unknown as { points: { stores: string[]; hardpoints: Record<string, { rounds: Record<string, { kind: string }> }> } }
    const built = new Set([...doc.points.stores, 'rail_1', 'rail_9'])
    const loadouts = [...Object.values(PRESETS), normalize({
      2: { fixture: 'twin', stores: ['9m', '120c'] }, 3: { fixture: 'twin', stores: ['120c', '9m'] }, 4: { fixture: 'rail', stores: ['120c'] },
      5: { fixture: 'pylon', stores: ['tank'] }, 6: { fixture: 'rail', stores: ['120c'] }, 7: { fixture: 'pylon', stores: ['9m'] }, 8: { fixture: 'rail', stores: ['120c'] },
    })]
    for (const loadout of loadouts) {
      for (const [station, slot] of Object.entries(normalize(loadout))) {
        for (const part of parts(Number(station), slot)) expect(built.has(part), part).toBe(true)
        for (const r of rounds(Number(station), slot)) {
          const seat = doc.points.hardpoints[station].rounds[r.part]
          expect(seat, `${station} ${r.part}`).toBeTruthy()
          expect(seat.kind).toBe(r.kind)
        }
      }
    }
  })
})

// The setup preview and the model viewer hang the loadout through outfit.
describe('outfit', () => {
  const nine = { kind: 'aim9m', mount: [0.2, -0.6, 3.4], forward: [1, 0, 0], up: [0, 1, 0] }
  const tip = { kind: 'aim9m', mount: [1, 0.1, 5.4], forward: [1, 0, 0], up: [0, 0, -1] }
  const fittings: Fittings = {
    stores: ['pylon_8', 'rack_8', 'rail_8a', 'rail_8b', 'pylon_5', 'tank_5'],
    hardpoints: { 8: { rounds: { rail_8a: nine } }, 9: { rounds: { rail_9: tip } } },
    mounts: { aim9m: [-0.2, 0.0635, 0], aim120c: [-0.8, 0.0889, 0] },
  }
  const missiles = { aim9m: new THREE.Group(), aim120c: new THREE.Group() }
  missiles.aim9m.name = 'aim9m'
  missiles.aim120c.name = 'aim120c'
  function jet() {
    const root = new THREE.Group()
    const flex = new THREE.Group()
    flex.name = 'flex_rail_right'
    flex.position.set(0, 0, 5)
    const rail = new THREE.Mesh()
    rail.name = 'rail_9'
    rail.position.set(0, 0, 0.3)
    flex.add(rail)
    const pylon = new THREE.Group()
    pylon.name = 'flex_pylon_8'
    pylon.position.set(0.5, 0, 3.4)
    for (const name of ['pylon_8', 'rack_8', 'rail_8a', 'rail_8b']) pylon.add(Object.assign(new THREE.Mesh(), { name }))
    for (const name of ['pylon_5', 'tank_5']) root.add(Object.assign(new THREE.Mesh(), { name }))
    root.add(flex, pylon)
    return root
  }
  const hung = (root: THREE.Object3D) => root.children.flatMap((c) => c.children).filter((o) => o.name === 'aim9m' || o.name === 'aim120c')
  const visible = (root: THREE.Object3D) => fittings.stores.filter((name) => root.getObjectByName(name)!.visible).sort()
  const loadout = { 5: { fixture: 'pylon', stores: ['tank'] }, 8: { fixture: 'rail', stores: ['9m'] }, 9: { fixture: 'rail', stores: ['9m'] } }

  it('shows the parts the loadout needs and lays each round on its seat beside its part', () => {
    const root = jet()
    outfit(root, loadout, missiles, fittings)
    expect(visible(root)).toEqual(['pylon_5', 'pylon_8', 'rack_8', 'rail_8a', 'rail_8b', 'tank_5'])
    const rounds = hung(root)
    expect(rounds.map((r) => r.parent!.name).sort()).toEqual(['flex_pylon_8', 'flex_rail_right'])
    expect(rounds).not.toContain(missiles.aim9m) // clones: the model stays shared
    root.updateMatrixWorld(true)
    for (const [parent, seat] of [['flex_pylon_8', nine], ['flex_rail_right', tip]] as const) {
      const round = rounds.find((r) => r.parent!.name === parent)!
      const mount = new THREE.Vector3(...fittings.mounts.aim9m).applyMatrix4(round.matrixWorld)
      expect(mount.distanceTo(new THREE.Vector3(...seat.mount)), parent).toBeLessThan(1e-9)
    }
  })
  it('takes the old rounds away and hides the old parts when the loadout changes', () => {
    const root = jet()
    outfit(root, loadout, missiles, fittings)
    outfit(root, {}, missiles, fittings)
    expect(hung(root)).toEqual([])
    expect(visible(root)).toEqual([])
  })
  it('shows the parts alone until the missiles have loaded', () => {
    const root = jet()
    outfit(root, loadout, null, fittings)
    expect(visible(root)).toEqual(['pylon_5', 'pylon_8', 'rack_8', 'rail_8a', 'rail_8b', 'tank_5'])
    expect(hung(root)).toEqual([])
  })
})

// The model viewer's showcase hangs every kind of store part the jet builds,
// the centreline's pylon and tank beside the wings'.
describe('the showcase', () => {
  it('shows every kind of store part, each with its rounds seated', () => {
    const doc = points as unknown as { points: { stores: string[] } }
    const kind = (part: string) => part.replace(/_(\d)[ab]?$/, (_, station) => (station === '5' ? '_centreline' : ''))
    const shown = new Set<string>()
    const carried = new Set<string>()
    for (const [station, slot] of Object.entries(SHOWCASE)) {
      for (const part of parts(Number(station), slot)) shown.add(kind(part))
      for (const r of rounds(Number(station), slot)) carried.add(`${r.kind} ${kind(r.part)}`)
    }
    expect([...shown].sort()).toEqual([...new Set(doc.points.stores.map(kind))].sort())
    expect([...carried].sort()).toEqual(['aim120c ejector', 'aim120c launcher', 'aim120c rack', 'aim9m rail'])
  })
})

describe('place', () => {
  it('lays the missile\'s mount on its seat', () => {
    const { position, quaternion } = place({ kind: 'aim9m', mount: [1, 1, 1], forward: [1, 0, 0], up: [0, 1, 0] }, [-0.2, 0.06, 0])
    close(position.x, 1.2)
    close(position.y, 0.94)
    close(position.z, 1)
    close(quaternion.angleTo(new THREE.Quaternion()), 0)
  })
  it('turns the missile so its lugs face its rail', () => {
    // a tip round on the right wing: nose forward, lugs inboard (-z)
    const { position, quaternion } = place({ kind: 'aim9m', mount: [0, 0, 5], forward: [1, 0, 0], up: [0, 0, -1] }, [0.5, 0.0635, 0])
    const lugs = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion)
    close(lugs.z, -1)
    const nose = new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion)
    close(nose.x, 1)
    // the mount, carried by the same turn, lands on the seat
    const mount = new THREE.Vector3(0.5, 0.0635, 0).applyQuaternion(quaternion).add(position)
    close(mount.x, 0)
    close(mount.y, 0)
    close(mount.z, 5)
  })
})

// The engine's side (engine.ts apply_stores, update_rails, store_position): the
// loadout hung on our own model, run on a small scene with the engine's own
// functions.
const engine = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
function lift(name: string): string {
  const start = ((at: number) => (at >= 0 ? at : engine.search(new RegExp(`\\n(?:const|let) ${name}=`)) + 1))(engine.indexOf(`function ${name}(`)) // a function, or a scratch record declared on a line of its own
  if (start < 0) throw new Error(`${name} not found in engine.ts`)
  const rest = engine.slice(start)
  const end = /\n(?=\S)/.exec(rest.slice(1))
  return end ? rest.slice(0, end.index + 1) : rest
}

describe('the engine hangs the loadout on our model', () => {
  const tip = { kind: 'aim9m', mount: [1, 0.1, 5.4], forward: [1, 0, 0], up: [0, 0, -1] }
  const rack = { kind: 'aim120c', mount: [0.4, -0.7, 3.4], forward: [1, 0, 0], up: [0, 1, 0] }
  function jet() {
    const object = new THREE.Group()
    const flex = new THREE.Group()
    flex.name = 'flex_rail_right'
    flex.position.set(0, 0, 5)
    const rail = new THREE.Mesh()
    rail.name = 'rail_9'
    rail.position.set(0, 0, 0.3)
    flex.add(rail)
    const pylon = new THREE.Group()
    pylon.name = 'flex_pylon_8'
    pylon.position.set(0.5, 0, 3.4)
    for (const name of ['pylon_8', 'rack_8', 'rail_8a', 'launcher_8a']) {
      const part = new THREE.Mesh()
      part.name = name
      pylon.add(part)
    }
    object.add(flex, pylon)
    const x = { object, joints: [], points: { hardpoints: { 9: { rounds: { rail_9: tip } }, 8: { rounds: { rack_8: rack } } } } }
    const group = new THREE.Group()
    group.add(object)
    group.userData = { exterior: x, player: false }
    return { group, x, msl: 1, amraam: 1, loadout: null as unknown, order: undefined as unknown }
  }
  const run = new Function('THREE', 'hang_parts', 'hang_rounds', 'hang_place', 'stores_entries', 'stores_normalize', 'sequence', 'departed', `
    const cfg={ shadows:false }, layer_own_group=()=>{}, init_missile_model=()=>{}, _v=new THREE.Vector3();
    const TIP_PAIR=["tip9","tip1"], TIPS_ONLY=stores_normalize({ 1:{fixture:"rail",stores:["9m"]}, 9:{fixture:"rail",stores:["9m"]} });
    const missile_protos={ aim9m:new THREE.Group(), aim120c:new THREE.Group() };
    const MISSILE_POINTS={ aim9m:{ points:{ mount:[-0.2,0.0635,0] } }, aim120c:{ points:{ mount:[-0.8,0.0889,0] } } };
    ${lift('exterior_origin')}
    ${lift('store_position')}
    ${lift('update_rails')}
    ${lift('apply_stores')}
    return { apply_stores, store_position };`)(THREE, parts, rounds, place, entries, normalize, sequence, departed) as {
    apply_stores: (st: ReturnType<typeof jet>) => void
    store_position: (st: ReturnType<typeof jet>, name: string) => { x: number; y: number; z: number } | null
  }

  it('lays each round on its seat beside its part, and shows the parts the loadout needs', () => {
    const st = jet()
    st.loadout = normalize({ 9: { fixture: 'rail', stores: ['9m'] }, 8: { fixture: 'rail', stores: ['120c'] } })
    run.apply_stores(st)
    const racks = (st as unknown as { racks: { nodes: Record<string, THREE.Object3D> } }).racks
    // the tip round beside its rail, under the bend joint carrying both
    expect(racks.nodes.tip9.parent?.name).toBe('flex_rail_right')
    // its mount, turned with it (forward x, lugs inboard), lands on the seat
    const mount = new THREE.Vector3(-0.2, 0.0635, 0).applyQuaternion(racks.nodes.tip9.quaternion).add(racks.nodes.tip9.getWorldPosition(new THREE.Vector3()))
    close(mount.x, 1)
    close(mount.y, 0.1)
    close(mount.z, 5.4)
    expect(racks.nodes['120c8'].parent?.name).toBe('flex_pylon_8')
    const shown = (st.x as unknown as { shown: Set<string> }).shown
    expect([...shown].sort()).toEqual(['pylon_8', 'rack_8'])
    // the round's place in the world is its own origin, on its axis: its lugs
    // face inboard, so the axis lies outboard of the mount by its radius
    const at = run.store_position(st, 'tip9')!
    close(at.z, 5.4 + 0.0635)
  })
  it('takes the old rounds away when the loadout changes', () => {
    const st = jet()
    st.loadout = normalize({ 9: { fixture: 'rail', stores: ['9m'] }, 8: { fixture: 'rail', stores: ['120c'] } })
    run.apply_stores(st)
    st.loadout = normalize({ 9: { fixture: 'rail', stores: ['9m'] } })
    run.apply_stores(st)
    let rounds = 0
    st.group.traverse((o) => { if (o.name.startsWith('round_')) rounds++ })
    expect(rounds).toBe(1)
    expect([...(st.x as unknown as { shown: Set<string> }).shown]).toEqual([])
  })
  it('hangs the wingtip pair on a jet whose loadout is not known', () => {
    const st = jet()
    run.apply_stores(st)
    expect(Object.keys((st as unknown as { racks: { nodes: object } }).racks.nodes)).toEqual(['tip9'])
  })
})

describe('the jettison drops our parts', () => {
  it('lets a dropped tank and its pylon fall as copies of the parts the loadout shows', () => {
    const scene = new THREE.Scene()
    const holder = new THREE.Group()
    const tank = new THREE.Mesh()
    tank.name = 'tank_7'
    const pylon = new THREE.Mesh()
    pylon.name = 'pylon_7'
    holder.add(tank, pylon)
    scene.add(holder)
    const falling: { piece: THREE.Object3D }[] = []
    const separate = new Function('THREE', 'scene', 'falling', `${lift('separate_debris')} return separate_debris;`)(THREE, scene, falling) as (
      st: object, names: string[]) => void
    const st = { racks: { nodes: {}, parts: { tank7: [tank], pylon7: [pylon] } }, speed: 0, velx: 0, vely: 0, velz: 0 }
    separate(st, ['tank7'])
    expect(falling.map((f) => f.piece.name)).toEqual(['tank_7'])
    separate(st, ['pylon7'])
    expect(falling.map((f) => f.piece.name)).toEqual(['tank_7', 'pylon_7'])
  })
})
