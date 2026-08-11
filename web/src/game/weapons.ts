// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// Shared ordnance helpers (#27). Each round ships as its own GLB named by
// designation, like the airframe (aim120c.glb — "AIM-120C AMRAAM" by
// Pippa/Planetrix23, Sketchfab, CC BY 4.0): per-designation files cache and
// update independently and map one-to-one onto their licensed sources.
// Sources arrive in arbitrary units and axes, so normalize_round bakes the
// convention every consumer relies on: the round lies along +z (nose forward,
// the airframe model space's longitudinal axis), spans its true length in
// metres, and is centred at the origin — which makes placement everywhere
// "position = anchor". The airframe-specific half of the fit (WHERE a round
// hangs) comes from node_centre over the aircraft's own split stores model,
// so the source artist's station positions transfer without hand measurement.

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

// amraam_anchor: where a station's AIM-120 hangs, in model space. Stations
// with a source-art round (the cheeks 4/6 and the wing rails 2/8) inherit its
// centroid directly. The inboard pylons 3/7 have only tanks in the source, so
// their anchor is DERIVED: the tank's buttline and longitudinal centre with
// the hang height of the same wing's rail round — a rail-hung slim store
// under the same pylon family. Twin points ('a' outer, 'b' inner) spread the
// pair laterally off the single-round anchor and hang slightly lower, the
// same geometry the heater twins' hand-measured anchors encode.
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

// node_centre: the centre of a named node's mesh — the middle of its
// bounding box, NOT the vertex mean — in the ROOT's model space. Three traps
// live here, all learned the hard way: the split stores models share ONE
// vertex buffer across every station's primitive, so only the index selects
// this piece's triangles; gltfpack QUANTIZES positions, hanging the
// dequantization transform on the node, so raw vertex coordinates are
// meaningless until they go through the mesh's world matrix; and a vertex
// MEAN is skewed by wherever the artist spent triangles — a round's dense
// tail fins dragged the mean below the tube axis, and every AMRAAM anchored
// to it hung off its rail with an air gap. The box middle is the tube axis
// for a radially symmetric round, and it is the same convention
// normalize_round centres our own model by, so anchoring box-middle to
// box-middle makes the drawn round occupy the source round's exact envelope.
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
