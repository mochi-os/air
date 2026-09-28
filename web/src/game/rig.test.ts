// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
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

// The pit's sightline casts (calibrate_eye, build_indexer, surface_fit) carry
// no camera, and a sprite cannot be ray-cast without one: they test only the
// airframe, never the group's effects - the gun's bloom is a sprite on the
// group, and a join re-fits the pit after it is hung there.
describe("the pit's sightline casts", () => {
  function block(name: string): string {
    const start = source.indexOf(`function ${name}(`)
    expect(start, `${name} in engine.ts`).toBeGreaterThan(0)
    const rest = source.slice(start)
    const end = /\n(?=\S)/.exec(rest.slice(1))
    return end ? rest.slice(0, end.index + 1) : rest
  }
  const script = block('surface_fit').replace(/ as THREE\.[A-Za-z]+(&\{[^}]*\})?/g, '') // engine.ts's type casts, which plain JS cannot parse
  const fit = new Function('THREE', `${block('shown')} ${block('model_of')} ${script} return surface_fit`)(THREE) as (
    g: THREE.Group,
    box: { lo: { x: number; y: number; z: number }; hi: { x: number; y: number; z: number } }
  ) => { x: number } | null
  // jet is an airframe with one panel face a metre ahead of the eye, and the
  // gun's rig beside it on the group as gun_rig hangs it: a hidden flash group
  // holding the bloom sprite.
  function jet(): THREE.Group {
    const g = new THREE.Group()
    const model = new THREE.Group()
    model.userData.model = true
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.4), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }))
    panel.rotation.y = Math.PI / 2
    panel.position.set(1, 0.5, 0)
    model.add(panel)
    const flash = new THREE.Group()
    flash.add(new THREE.Sprite(new THREE.SpriteMaterial()))
    flash.visible = false
    g.add(model, flash)
    g.userData.eye = { x: 0, y: 0.5 }
    g.updateMatrixWorld(true)
    return g
  }
  const box = { lo: { x: 1, y: 0.4, z: -0.1 }, hi: { x: 1.02, y: 0.6, z: 0.1 } }

  it('fits a panel on a jet carrying the gun\'s bloom sprite', () => {
    expect(fit(jet(), box)?.x).toBeCloseTo(1, 3)
  })
  it('casts every sightline against the airframe, not the whole group', () => {
    expect(source).not.toMatch(/rc\.intersectObject\(g,true\)/)
    for (const [name, count] of [['calibrate_eye', 1], ['build_indexer', 1], ['surface_fit', 2]] as const)
      expect(block(name).split('rc.intersectObject(model_of(g),true)').length - 1, name).toBe(count)
  })
})
