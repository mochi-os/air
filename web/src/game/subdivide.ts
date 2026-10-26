// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// Curved subdivision of a small mesh (#132): every triangle split into four at
// its edges' midpoints, each midpoint moved onto the curve its edge's ends
// imply, so a 12-sided knob reads round zoomed in. The model's own vertices
// stay where they are, and so do pivots and anything measured on them.
//
// An edge's curve is a cubic through its ends whose tangents lie in the
// surface there. Where the faces either side share a normal at an end, the
// tangent is the edge projected into that normal's plane (point-normal
// triangles); where they meet at a crease, it is the edge projected onto the
// crease line, the cross product of the two normals. So a cylinder's rim
// rounds to a circle while its flat cap and straight sides stay flat and
// straight. A midpoint is computed once per edge, from both faces, so
// neighbouring triangles meet without cracks.

import * as THREE from 'three'

const SAME = 0.9998 // normals closer than about a degree are one normal

interface Corner {
  key: number // the welded position
  vertex: number // the input vertex
}

// subdivide returns a new, non-indexed geometry with four times the triangles
// at each level; position, normal and uv are the attributes it carries.
export function subdivide(geometry: THREE.BufferGeometry, levels = 1): THREE.BufferGeometry {
  if (!geometry.attributes.normal || geometry.groups.length) return geometry // nothing to curve along, or faces split between materials
  let out = geometry
  for (let i = 0; i < levels; i++) out = level(out)
  out.computeBoundingBox()
  out.computeBoundingSphere()
  return out
}

function level(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const position = geometry.attributes.position, normal = geometry.attributes.normal, uv = geometry.attributes.uv
  const index = geometry.index
  const count = index ? index.count : position.count
  const corner = (i: number) => (index ? index.getX(i) : i)

  // weld positions, so faces that share an edge find each other across split vertices
  if (!geometry.boundingBox) geometry.computeBoundingBox()
  const size = geometry.boundingBox!.getSize(new THREE.Vector3()).length() || 1
  const grain = size * 1e-6
  const keys = new Map<string, number>()
  const weld = (v: number) => {
    const id = `${Math.round(position.getX(v) / grain)},${Math.round(position.getY(v) / grain)},${Math.round(position.getZ(v) / grain)}`
    let k = keys.get(id)
    if (k === undefined) { k = keys.size; keys.set(id, k) }
    return k
  }
  const triangles: Corner[][] = []
  for (let i = 0; i + 2 < count; i += 3) triangles.push([0, 1, 2].map((j) => { const v = corner(i + j); return { key: weld(v), vertex: v } }))

  // the faces on each edge, by the welded ends
  const edges = new Map<string, Corner[][]>()
  const edge = (a: Corner, b: Corner) => (a.key < b.key ? `${a.key}:${b.key}` : `${b.key}:${a.key}`)
  for (const t of triangles) for (let j = 0; j < 3; j++) {
    const id = edge(t[j], t[(j + 1) % 3])
    const list = edges.get(id) ?? []; list.push(t); edges.set(id, list)
  }

  const p = (v: number) => new THREE.Vector3().fromBufferAttribute(position, v)
  const n = (v: number) => new THREE.Vector3().fromBufferAttribute(normal, v).normalize()
  // the tangent at an edge's end, along the edge's direction d: the normals at that end are the faces' on the edge
  const tangent = (d: THREE.Vector3, normals: THREE.Vector3[]) => {
    const distinct: THREE.Vector3[] = []
    for (const m of normals) if (!distinct.some((k) => k.dot(m) > SAME)) distinct.push(m)
    if (distinct.length === 1) return d.clone().addScaledVector(distinct[0], -d.dot(distinct[0]))
    if (distinct.length === 2) {
      const line = new THREE.Vector3().crossVectors(distinct[0], distinct[1])
      if (line.lengthSq() > 1e-12) { line.normalize(); return line.multiplyScalar(d.dot(line)) }
    }
    return d.clone() // three faces meet here: the edge stays straight at this end
  }
  const middle = new Map<string, THREE.Vector3>()
  const midpoint = (a: Corner, b: Corner) => {
    const id = edge(a, b)
    let m = middle.get(id)
    if (m) return m
    const [lo, hi] = a.key < b.key ? [a, b] : [b, a] // the same direction whichever face asks
    const faces = edges.get(id)!
    const at = (key: number) => faces.map((t) => n(t.find((c) => c.key === key)!.vertex))
    const p0 = p(lo.vertex), p1 = p(hi.vertex), d = p1.clone().sub(p0)
    const t0 = tangent(d, at(lo.key)), t1 = tangent(d, at(hi.key))
    m = p0.clone().add(p1).multiplyScalar(0.5).addScaledVector(t0.sub(t1), 1 / 8) // the cubic at its middle
    middle.set(id, m)
    return m
  }

  const positions: number[] = [], normals: number[] = [], uvs: number[] = []
  const put = (at: THREE.Vector3, nm: THREE.Vector3, u: number[] | null) => {
    positions.push(at.x, at.y, at.z); normals.push(nm.x, nm.y, nm.z)
    if (u) uvs.push(u[0], u[1])
  }
  for (const t of triangles) {
    const at = t.map((c) => p(c.vertex)), nm = t.map((c) => n(c.vertex))
    const u = uv ? t.map((c) => [uv.getX(c.vertex), uv.getY(c.vertex)]) : null
    // each side's middle: its curved position, and this face's own normal and uv there
    const mid = [0, 1, 2].map((j) => {
      const k = (j + 1) % 3
      return { at: midpoint(t[j], t[k]), nm: nm[j].clone().add(nm[k]).normalize(), u: u ? [(u[j][0] + u[k][0]) / 2, (u[j][1] + u[k][1]) / 2] : null }
    })
    const one = (j: number) => ({ at: at[j], nm: nm[j], u: u ? u[j] : null })
    for (const [x, y, z] of [[one(0), mid[0], mid[2]], [mid[0], one(1), mid[1]], [mid[2], mid[1], one(2)], [mid[0], mid[1], mid[2]]])
      for (const c of [x, y, z]) put(c.at, c.nm, c.u)
  }
  const result = new THREE.BufferGeometry()
  result.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  result.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  if (uv) result.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  result.computeBoundingBox()
  return result
}
