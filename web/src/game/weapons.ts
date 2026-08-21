// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// Shared ordnance helpers (#27). Each round ships as its own GLB named by
// designation (aim120c.glb - "AIM-120C AMRAAM" by Pippa/Planetrix23, Sketchfab,
// CC BY 4.0). normalize_round bakes the convention every consumer relies on:
// the round lies along +z, spans its true length in metres, and is centred at
// the origin, so placement everywhere is "position = anchor".

import * as THREE from 'three'

export const AMRAAM_LENGTH = 3.66 // AIM-120C, metres

// normalize_round wraps a raw glTF scene into the convention above. The nose
// is DETECTED, not assumed: the radome end of the long axis has the smaller
// cross-section radius.
export function normalize_round(scene: THREE.Group, length = AMRAAM_LENGTH): THREE.Group {
  scene.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(scene)
  const size = box.getSize(new THREE.Vector3())
  const centre = box.getCenter(new THREE.Vector3())
  const axis: 'x' | 'y' | 'z' = size.x >= size.y && size.x >= size.z ? 'x' : size.y >= size.z ? 'y' : 'z'
  const span = size[axis]
  // Cross-section radius near each end of the long axis, from every mesh's
  // world-space vertices (sampled — counts here are thousands, not millions).
  let low = 0, lowN = 0, high = 0, highN = 0
  const v = new THREE.Vector3()
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh || !mesh.geometry?.attributes?.position) return
    const pos = mesh.geometry.attributes.position
    for (let i = 0; i < pos.count; i += 3) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld)
      const along = v[axis] - centre[axis]
      const radial = axis === 'x' ? Math.hypot(v.y - centre.y, v.z - centre.z) : axis === 'y' ? Math.hypot(v.x - centre.x, v.z - centre.z) : Math.hypot(v.x - centre.x, v.y - centre.y)
      if (along < -span * 0.35) { low += radial; lowN++ }
      else if (along > span * 0.35) { high += radial; highN++ }
    }
  })
  const nose_high = highN > 0 && lowN > 0 ? high / highN < low / lowN : true
  scene.position.set(-centre.x, -centre.y, -centre.z)
  const spin = new THREE.Group()
  spin.add(scene)
  if (axis === 'x') spin.rotation.y = nose_high ? -Math.PI / 2 : Math.PI / 2 // ±x -> +z
  else if (axis === 'y') spin.rotation.x = nose_high ? Math.PI / 2 : -Math.PI / 2 // ±y -> +z
  else if (!nose_high) spin.rotation.y = Math.PI // -z -> +z
  const wrap = new THREE.Group()
  wrap.add(spin)
  wrap.scale.setScalar(length / (span || 1))
  return wrap
}

// amraam_anchor: where a station's AIM-120 hangs, in model space. Stations with
// a source-art round inherit its centroid; the inboard pylons 3/7 have only
// tanks, so their anchor takes the tank's buttline with the same wing's rail
// round's hang height. Twin points ('a' outer, 'b' inner) spread laterally and
// hang slightly lower.
export function amraam_anchor(root: THREE.Object3D, station: number, point = ''): THREE.Vector3 | null {
  const anchor = single_anchor(root, station)
  if (!anchor || !point) return anchor
  const outer = anchor.x >= 0 ? 0.15 : -0.15
  anchor.x += point === 'a' ? outer : -outer
  anchor.y -= 0.04
  return anchor
}

function single_anchor(root: THREE.Object3D, station: number): THREE.Vector3 | null {
  const direct = node_centre(root, 'Missile_' + station)
  if (direct) return direct
  if (station !== 3 && station !== 7) return null
  const tank = node_centre(root, 'Tank_' + station)
  const rail = node_centre(root, 'Missile_' + (station < 5 ? 2 : 8))
  if (!tank || !rail) return null
  return new THREE.Vector3(tank.x, rail.y, tank.z)
}

// amraam_aim: the round's ORIENTATION at a station, the long axis of the source
// art's own round as the dominant principal component of its vertices. Model
// space is not waterline-level, so a round laid along model z visibly diverges
// from its pylon.
export function amraam_aim(root: THREE.Object3D, station: number): THREE.Quaternion {
  const aim = new THREE.Quaternion()
  const source = root.getObjectByName('Missile_' + station) ? station : station === 3 ? 2 : station === 7 ? 8 : station
  const node = root.getObjectByName('Missile_' + source)
  if (!node) return aim
  let mesh: THREE.Mesh | null = null
  node.traverse((o) => { if (!mesh && (o as THREE.Mesh).isMesh) mesh = o as THREE.Mesh })
  const geometry = mesh ? (mesh as THREE.Mesh).geometry : null
  if (!mesh || !geometry?.attributes?.position) return aim
  const pos = geometry.attributes.position
  const idx = geometry.index
  const total = idx ? idx.count : pos.count
  const stride = Math.max(1, Math.floor(total / 2000))
  root.updateMatrixWorld(true)
  const v = new THREE.Vector3()
  const points: THREE.Vector3[] = []
  const mean = new THREE.Vector3()
  for (let k = 0; k < total; k += stride) {
    ;(mesh as THREE.Mesh).localToWorld(v.fromBufferAttribute(pos, idx ? idx.getX(k) : k))
    points.push(v.clone())
    mean.add(v)
  }
  if (points.length < 3) return aim
  mean.multiplyScalar(1 / points.length)
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0
  for (const p of points) {
    p.sub(mean)
    xx += p.x * p.x; xy += p.x * p.y; xz += p.x * p.z
    yy += p.y * p.y; yz += p.y * p.z; zz += p.z * p.z
  }
  const axis = new THREE.Vector3(0, 0, 1)
  for (let i = 0; i < 12; i++) {
    axis.set(xx * axis.x + xy * axis.y + xz * axis.z, xy * axis.x + yy * axis.y + yz * axis.z, xz * axis.x + yz * axis.y + zz * axis.z)
    if (!axis.length()) return aim
    axis.normalize()
  }
  if (axis.z < 0) axis.negate() // nose forward: the convention normalize_round bakes
  return aim.setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis)
}

// node_centre: the centre of a named node's mesh - the middle of its bounding
// box, NOT the vertex mean - in the ROOT's model space. The split stores models
// share one vertex buffer, so only the index selects this piece; gltfpack
// quantizes positions, so raw coordinates mean nothing until they go through
// the mesh's world matrix; and a vertex mean is skewed by where the artist
// spent triangles.
export function node_centre(root: THREE.Object3D, name: string): THREE.Vector3 | null {
  const node = root.getObjectByName(name)
  if (!node) return null
  let mesh: THREE.Mesh | null = null
  node.traverse((o) => { if (!mesh && (o as THREE.Mesh).isMesh) mesh = o as THREE.Mesh })
  if (!mesh) return null
  const geometry = (mesh as THREE.Mesh).geometry
  if (!geometry?.attributes?.position) return null
  const pos = geometry.attributes.position
  const idx = geometry.index
  root.updateMatrixWorld(true)
  const v = new THREE.Vector3()
  const low = new THREE.Vector3(Infinity, Infinity, Infinity)
  const high = new THREE.Vector3(-Infinity, -Infinity, -Infinity)
  let count = 0
  const take = (i: number) => {
    ;(mesh as THREE.Mesh).localToWorld(v.fromBufferAttribute(pos, i))
    low.min(v)
    high.max(v)
    count++
  }
  if (idx) {
    for (let k = 0; k < idx.count; k += 3) take(idx.getX(k))
  } else {
    for (let i = 0; i < pos.count; i++) take(i)
  }
  if (!count) return null
  return low.add(high).multiplyScalar(0.5)
}
