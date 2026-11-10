// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { KINDS } from './hang'
import { dress, holder } from './weapons'

// A model as the missile builds lay one out: a body along x, named.
function model(name: string, length: number): THREE.Group {
  const group = new THREE.Group()
  group.name = name
  group.add(new THREE.Mesh(new THREE.BoxGeometry(length, 0.13, 0.13)))
  return group
}

const PROTOTYPES = {
  aim9m: model('aim9m', 2.87),
  aim120c: model('aim120c', 3.66),
}

function dart(): THREE.Mesh {
  return new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 2.4))
}

// the models a holder shows, by name, besides its fallback
function shown(group: THREE.Object3D): string[] {
  return group.children
    .filter((c) => c !== group.userData.fallback)
    .map((c) => c.name)
}

describe('dress', () => {
  it("shows a round as its own kind's model, in the model's own frame", () => {
    const group = holder(dart())
    expect(dress(group, '120c', PROTOTYPES)).toBe(true)
    expect(shown(group)).toEqual(['aim120c'])
    const model = group.userData.model as THREE.Object3D
    expect(model).not.toBe(PROTOTYPES.aim120c) // a clone: the prototype stays shared
    expect(model.position.length()).toBe(0)
    expect(model.quaternion.equals(new THREE.Quaternion())).toBe(true)
    const size = new THREE.Box3()
      .setFromObject(group.userData.model)
      .getSize(new THREE.Vector3())
    expect(size.x).toBeCloseTo(3.66, 5)
    expect(group.userData.fallback.visible).toBe(false)
  })

  it("dresses the 9M as the 9M's model", () => {
    const group = holder(dart())
    expect(dress(group, '9m', PROTOTYPES)).toBe(true)
    expect(shown(group)).toEqual(['aim9m'])
  })

  it('swaps the model when the holder flies another kind', () => {
    const group = holder(dart())
    dress(group, '9m', PROTOTYPES)
    dress(group, '120c', PROTOTYPES)
    expect(shown(group)).toEqual(['aim120c'])
  })

  it('changes nothing when dressed as the same kind again', () => {
    const group = holder(dart())
    let prepared = 0
    dress(group, '9m', PROTOTYPES, () => prepared++)
    const first = group.userData.model
    dress(group, '9m', PROTOTYPES, () => prepared++)
    expect(group.userData.model).toBe(first)
    expect(prepared).toBe(1)
  })

  it('keeps the fallback until the model has loaded', () => {
    const group = holder(dart())
    dress(group, '9m', PROTOTYPES)
    expect(dress(group, '120c', { aim9m: PROTOTYPES.aim9m })).toBe(false)
    expect(shown(group)).toEqual([])
    expect(group.userData.fallback.visible).toBe(true)
    // and takes the model once it is in
    expect(dress(group, '120c', PROTOTYPES)).toBe(true)
    expect(shown(group)).toEqual(['aim120c'])
  })
})

// The engine's side (engine.ts dress_round, draw_darts and the launches): every
// round in flight, ours, the bandit's or another player's, is drawn as its own
// model, pointing along its flight.
const engine = readFileSync(
  fileURLToPath(new URL('./engine.ts', import.meta.url)),
  'utf8'
)
function lift(name: string): string {
  const start = engine.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`${name} not found in engine.ts`)
  const rest = engine.slice(start)
  const end = /\n(?=[^\s}])/.exec(rest.slice(1)) // a lone closing brace ends the function, not the next line
  return end ? rest.slice(0, end.index + 1) : rest
}

describe('the engine draws each round in flight as its own model', () => {
  function engine_draw(prototypes: Record<string, THREE.Object3D>) {
    const fetched: string[] = []
    const scene = new THREE.Group()
    const darts_pool: { mesh: THREE.Group }[] = []
    const fox3_pool: { mesh: THREE.Group }[] = []
    const draw = new Function(
      'THREE',
      'dress',
      'holder',
      'missile_protos',
      'cfg',
      'init_missile_model',
      'round_kinds',
      'scene',
      'darts_pool',
      'fox3_pool',
      'missile_geo',
      'missile_mat',
      'flight_wind',
      'trail_puff',
      `const _v=new THREE.Vector3(), _dart_axis=new THREE.Vector3(1,0,0), _dart_q=new THREE.Quaternion();
      ${lift('dress_round')}\n${lift('draw_darts')}\nreturn draw_darts;`
    )(
      THREE,
      dress,
      holder,
      prototypes,
      { shadows: true },
      (kind: string) => fetched.push(kind),
      KINDS,
      scene,
      darts_pool,
      fox3_pool,
      new THREE.BoxGeometry(2.4, 0.24, 0.24),
      new THREE.MeshBasicMaterial(),
      () => ({ x: 0, y: 0, z: 0 }),
      () => true
    )
    return { draw, darts_pool, fox3_pool, fetched }
  }
  const darts = [
    { radar: true, position: [0, 3000, 0], velocity: [0, 0, 600] },
    { radar: false, position: [100, 3000, 0], velocity: [0, 600, 0] },
  ]

  it("draws another player's AIM-120 and AIM-9 as their models, nose along the flight", () => {
    const { draw, darts_pool, fox3_pool } = engine_draw(PROTOTYPES)
    draw(darts, 0, 0)
    const fox3 = fox3_pool[0].mesh,
      heater = darts_pool[0].mesh
    expect(fox3.userData.round).toBe('aim120c')
    expect(heater.userData.round).toBe('aim9m')
    for (const [group, along] of [
      [fox3, [0, 0, 1]],
      [heater, [0, 1, 0]],
    ] as const) {
      const nose = new THREE.Vector3(1, 0, 0).applyQuaternion(group.quaternion)
      expect(nose.distanceTo(new THREE.Vector3(...along))).toBeLessThan(1e-9)
      group.userData.model.traverse((o: THREE.Object3D) => {
        if ((o as THREE.Mesh).isMesh) expect(o.castShadow).toBe(true)
      })
    }
  })

  it('flies a round as the dart until its model lands, and fetches the model', () => {
    const { draw, fox3_pool, fetched } = engine_draw({
      aim9m: PROTOTYPES.aim9m,
    })
    draw(darts, 0, 0)
    expect(fox3_pool[0].mesh.userData.fallback.visible).toBe(true)
    expect(fetched).toContain('aim120c')
  })

  it('dresses a round fired before its model landed once it lands', async () => {
    const round = { active: true, kind: '9m', mesh: holder(new THREE.Mesh()) }
    const prototypes: Record<string, THREE.Object3D> = {}
    const load = new Function(
      'THREE',
      'dress',
      'missile_protos',
      'missile_pending',
      'cfg',
      'round_kinds',
      'missiles',
      'load_split',
      'MISSILE_URLS',
      'apply_stores',
      'ownship',
      'bandit',
      'remotes',
      `${lift('dress_round')}\n${lift('init_missile_model')}\nreturn init_missile_model;`
    )(
      THREE,
      dress,
      prototypes,
      {},
      { shadows: false },
      KINDS,
      [round],
      async () => PROTOTYPES.aim9m,
      { aim9m: 'aim9m.glb' },
      () => {},
      null,
      null,
      new Map()
    )
    expect(round.mesh.userData.round).toBeUndefined()
    await load('aim9m')
    expect(round.mesh.userData.round).toBe('aim9m')
  })

  it("dresses our own and the bandit's rounds at launch, by their kind", () => {
    for (const name of [
      'launch_missile',
      'launch_amraam',
      'launch_bandit_round',
    ])
      expect(lift(name), name).toMatch(
        /m\.kind="(9m|120c)"; dress_round\(m\.mesh,m\.kind\);/
      )
    expect(engine).toMatch(
      /const missiles=\[\]; for\(let i=0;i<MSL_MAX;i\+\+\)\{ const m=holder\(new THREE\.Mesh\(missile_geo,missile_mat\)\);/
    )
  })
})
