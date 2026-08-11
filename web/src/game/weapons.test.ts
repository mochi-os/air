// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { normalize_round, node_centre, amraam_anchor, AMRAAM_LENGTH } from './weapons'

// A synthetic download-shaped round: a 2-long cylinder along X with a cone at
// +x — the nose — in arbitrary units, off-centre. What Sketchfab hands us.
function raw_round(noseAt: 1 | -1): THREE.Group {
  const group = new THREE.Group()
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 1.6, 8))
  body.rotation.z = Math.PI / 2
  body.position.set(noseAt * -0.2 + 3, 1, 2) // deliberately not at the origin
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.4, 8))
  nose.rotation.z = noseAt > 0 ? -Math.PI / 2 : Math.PI / 2
  nose.position.set(noseAt * 0.8 + 3, 1, 2)
  group.add(body, nose)
  return group
}

describe('normalize_round', () => {
  it('bakes the convention: true length along +z, centred at the origin', () => {
    const wrap = normalize_round(raw_round(1))
    const box = new THREE.Box3().setFromObject(wrap)
    const size = box.getSize(new THREE.Vector3())
    const centre = box.getCenter(new THREE.Vector3())
    expect(size.z).toBeCloseTo(AMRAAM_LENGTH, 3)
    expect(size.x).toBeLessThan(0.5)
    expect(centre.length()).toBeLessThan(0.01)
  })
  it('detects the nose at either end — the slimmer cross-section wins', () => {
    for (const noseAt of [1, -1] as const) {
      const wrap = normalize_round(raw_round(noseAt))
      // the cone's tip vertex must land at +z after normalisation
      let tip = -Infinity
      const v = new THREE.Vector3()
      wrap.updateMatrixWorld(true)
      wrap.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (!mesh.isMesh) return
        const pos = mesh.geometry.attributes.position
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld)
          if (v.z > tip) tip = v.z
        }
      })
      expect(tip).toBeCloseTo(AMRAAM_LENGTH / 2, 2)
    }
  })
})

describe('amraam_anchor', () => {
  function labelled(name: string, at: [number, number, number]): THREE.Mesh {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([at[0], at[1], at[2], at[0] + 0.1, at[1], at[2], at[0], at[1] + 0.1, at[2]]), 3))
    const mesh = new THREE.Mesh(g)
    mesh.name = name
    return mesh
  }
  it('inherits source rounds directly and derives the inboard pylons', () => {
    const root = new THREE.Group()
    root.add(labelled('Missile_2', [3.3, -1.0, -0.2]))
    root.add(labelled('Tank_3', [2.2, -1.4, 0.4]))
    const wing = amraam_anchor(root, 2)!
    expect(wing.x).toBeCloseTo(3.33, 1)
    const inboard = amraam_anchor(root, 3)!
    expect(inboard.x).toBeCloseTo(2.23, 1) // the tank's buttline
    expect(inboard.y).toBeCloseTo(wing.y, 5) // the rail round's hang height
    expect(inboard.z).toBeCloseTo(0.43, 1) // the tank's longitudinal centre
    expect(amraam_anchor(root, 7)).toBeNull() // no starboard sources in this rig
    expect(amraam_anchor(root, 5)).toBeNull() // the centreline never derives
  })
  it('twin points spread laterally off the single anchor, outer away from the keel', () => {
    const root = new THREE.Group()
    root.add(labelled('Missile_2', [3.3, -1.0, -0.2]))
    root.add(labelled('Missile_8', [-3.3, -1.0, -0.2]))
    const single = amraam_anchor(root, 2)!
    const outer = amraam_anchor(root, 2, 'a')!
    const inner = amraam_anchor(root, 2, 'b')!
    expect(outer.x).toBeCloseTo(single.x + 0.15, 5) // model x is port-positive
    expect(inner.x).toBeCloseTo(single.x - 0.15, 5)
    expect(outer.y).toBeCloseTo(single.y - 0.04, 5) // pairs hang a touch lower, like the heater twins
    expect(outer.z).toBeCloseTo(single.z, 5)
    const starboard = amraam_anchor(root, 8, 'a')!
    expect(starboard.x).toBeCloseTo(amraam_anchor(root, 8)!.x - 0.15, 5) // outer flips sign across the keel
  })
})

describe('node_centre', () => {
  it('is index-aware: two nodes sharing one vertex buffer get their own centroids', () => {
    // one buffer holding two triangles far apart; each node indexes ONE
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 10, 0, 0, 11, 0, 0, 10, 1, 0])
    const make = (indices: number[]) => {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      g.setIndex(indices)
      return new THREE.Mesh(g)
    }
    const root = new THREE.Group()
    const near = make([0, 1, 2]); near.name = 'Missile_4'
    const far = make([3, 4, 5]); far.name = 'Missile_6'
    root.add(near, far)
    expect(node_centre(root, 'Missile_4')!.x).toBeLessThan(1)
    expect(node_centre(root, 'Missile_6')!.x).toBeGreaterThan(9)
    expect(node_centre(root, 'Missile_5')).toBeNull()
  })
})
