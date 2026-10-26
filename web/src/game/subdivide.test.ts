// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { subdivide } from './subdivide'

// A knob as the model has them: a 12-sided cylinder, smooth around its side and
// creased at the rims of its flat caps.
const knob = () => { const g = new THREE.CylinderGeometry(1, 1, 1, 12, 1, false); g.clearGroups(); return g } // one material, as a model's mesh has
const points = (g: THREE.BufferGeometry) => {
  const a = g.attributes.position, out: THREE.Vector3[] = []
  for (let i = 0; i < a.count; i++) out.push(new THREE.Vector3().fromBufferAttribute(a, i))
  return out
}
const triangles = (g: THREE.BufferGeometry) => (g.index ? g.index.count : g.attributes.position.count) / 3
// the distinct points round the top rim, and how far the farthest is from the circle the polygon stands for
const rim = (g: THREE.BufferGeometry) => [...new Map(points(g).filter((p) => Math.abs(p.y - 0.5) < 1e-6 && Math.hypot(p.x, p.z) > 0.9).map((p) => [p.toArray().map((v) => Math.round(v * 1e6)).join(','), p])).values()]
const off = (g: THREE.BufferGeometry) => Math.max(...rim(g).map((p) => Math.abs(Math.hypot(p.x, p.z) - 1)))

describe('the curved subdivision of a cockpit control', () => {
  it('rounds a 12-sided knob\'s rim toward its circle', () => {
    const once = subdivide(knob()), twice = subdivide(knob(), 2)
    expect(1 - Math.cos(Math.PI / 12)).toBeGreaterThan(0.034) // a straight midpoint would sit 3.4% inside the circle
    expect(off(once)).toBeLessThan(0.002)
    expect(off(twice)).toBeLessThan(0.002)
    expect(rim(knob())).toHaveLength(12) // the seam's two copies of a point are one
    expect([rim(once).length, rim(twice).length]).toEqual([24, 48])
  })

  it('keeps flat caps flat and straight sides straight', () => {
    const g = subdivide(knob(), 2), n = g.attributes.normal
    const cap = points(g).filter((_p, i) => Math.abs(n.getY(i)) > 0.999)
    expect(cap.length).toBeGreaterThan(0)
    for (const p of cap) expect(Math.abs(p.y)).toBeCloseTo(0.5, 9)
    const box = new THREE.Box3().setFromBufferAttribute(g.attributes.position as THREE.BufferAttribute)
    expect([box.min.y, box.max.y]).toEqual([-0.5, 0.5]) // no taller, no shorter
    for (const p of points(g)) expect(Math.hypot(p.x, p.z)).toBeLessThan(1 + 1e-9) // never past the circle
  })

  it('keeps the model\'s own vertices where they were', () => {
    const before = points(knob()), after = points(subdivide(knob(), 2))
    for (const p of before) expect(after.some((q) => q.distanceTo(p) < 1e-6), `${p.toArray()}`).toBe(true)
  })

  it('meets its neighbours without cracks: every edge of the closed knob is still shared by two faces', () => {
    const g = subdivide(knob(), 2), at = points(g), key = (p: THREE.Vector3) => p.toArray().map((v) => Math.round(v * 1e6)).join(',')
    const edges = new Map<string, number>()
    for (let i = 0; i < at.length; i += 3) for (let j = 0; j < 3; j++) {
      const a = key(at[i + j]), b = key(at[i + (j + 1) % 3]), id = a < b ? `${a}|${b}` : `${b}|${a}`
      edges.set(id, (edges.get(id) ?? 0) + 1)
    }
    expect([...edges.values()].every((c) => c === 2)).toBe(true)
  })

  it('leaves a flat panel flat', () => {
    for (const p of points(subdivide(new THREE.PlaneGeometry(1, 1, 3, 3), 2))) expect(p.z).toBe(0)
  })

  it('rounds a smooth surface toward the shape its normals describe', () => {
    const ball = new THREE.SphereGeometry(1, 8, 6), err = (g: THREE.BufferGeometry) => Math.max(...points(g).map((p) => Math.abs(p.length() - 1)))
    const straight = new THREE.BufferGeometry() // the same split with straight midpoints: what a plain subdivision gives
    { const a = ball.toNonIndexed().attributes.position, out: number[] = []
      for (let i = 0; i < a.count; i += 3) {
        const v = [0, 1, 2].map((j) => new THREE.Vector3().fromBufferAttribute(a, i + j))
        const m = [0, 1, 2].map((j) => v[j].clone().add(v[(j + 1) % 3]).multiplyScalar(0.5))
        for (const t of [[v[0], m[0], m[2]], [m[0], v[1], m[1]], [m[2], m[1], v[2]], [m[0], m[1], m[2]]]) for (const q of t) out.push(q.x, q.y, q.z)
      }
      straight.setAttribute('position', new THREE.Float32BufferAttribute(out, 3)) }
    expect(err(subdivide(ball))).toBeLessThan(err(straight) / 3)
  })

  it('gives each face its own normal at a crease and carries the uv across', () => {
    const g = subdivide(knob()), n = g.attributes.normal, uv = g.attributes.uv
    for (let i = 0; i < g.attributes.position.count; i += 3) {
      const ys = [0, 1, 2].map((j) => n.getY(i + j))
      expect(ys.every((y) => Math.abs(y) > 0.999) || ys.every((y) => Math.abs(y) < 1e-6)).toBe(true) // a cap face up or down throughout, a side face level throughout
    }
    expect(uv.count).toBe(g.attributes.position.count)
    const panel = subdivide(new THREE.PlaneGeometry(1, 1, 3, 3), 2), at = panel.attributes.position, map = panel.attributes.uv // a panel's uv is its position plus a half
    for (let i = 0; i < at.count; i++) { expect(map.getX(i)).toBeCloseTo(at.getX(i) + 0.5, 6); expect(map.getY(i)).toBeCloseTo(at.getY(i) + 0.5, 6) }
  })

  it('makes four triangles of each, a level at a time', () => {
    expect(triangles(subdivide(knob()))).toBe(triangles(knob()) * 4)
    expect(triangles(subdivide(knob(), 2))).toBe(triangles(knob()) * 16)
  })

  it('leaves a mesh with no normals, or with faces split between materials, alone', () => {
    const bare = new THREE.BufferGeometry(); bare.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3))
    expect(subdivide(bare)).toBe(bare)
    const grouped = new THREE.CylinderGeometry(1, 1, 1, 12)
    expect(subdivide(grouped)).toBe(grouped)
  })
})

// engine.ts cannot be imported (WebGL at module scope): its use is lifted as text and run against stand-ins.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
function lift(name: string): string {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`${name} not found in engine.ts`)
  const rest = source.slice(start)
  const end = /\n(?=\S)/.exec(rest.slice(1))
  return end ? rest.slice(0, end.index + 1) : rest
}

describe('the ownship\'s cockpit controls', () => {
  const constants = /\nconst CONTROL_MATERIALS=[^\n]*\nconst control_shapes=[^\n]*\n/.exec(source)?.[0] ?? ''
  // a model with a 3 cm knob and a 90 cm panel on the controls' atlas, and a 3 cm part on the airframe's
  const model = () => {
    const part = (name: string, material: string, size: number) => {
      const mesh = new THREE.Mesh(knob(), new THREE.MeshStandardMaterial({ name: material })); mesh.name = name; mesh.scale.setScalar(size / 2); return mesh
    }
    const m = new THREE.Group(); m.add(part('knob', 'Material_12', 0.03), part('panel', 'Material_12', 0.9), part('rivet', 'Material_7', 0.03)); return m
  }
  const run = () => new Function('THREE', 'subdivide', 'model', `${constants} ${lift('controls_round')}
    const g=new THREE.Group(), proto=model(), first=proto.clone(true), second=proto.clone(true); g.add(first,second);   // clones of one model share its geometry, as the fleet's do
    controls_round(g,first); controls_round(g,second);
    const tri=(m,name)=>{ const g=m.getObjectByName(name).geometry; return (g.index?g.index.count:g.attributes.position.count)/3; };
    return { knob:tri(first,'knob'), panel:tri(first,'panel'), rivet:tri(first,'rivet'), shared:first.getObjectByName('knob').geometry===second.getObjectByName('knob').geometry };`)(THREE, subdivide, model) as Record<string, number | boolean>

  it('rounds the small parts on the cockpit\'s atlases, and nothing else', () => {
    if (!constants) throw new Error('the control constants not found in engine.ts')
    const before = knob().toNonIndexed().attributes.position.count / 3
    expect(run()).toEqual({ knob: before * 16, panel: before, rivet: before, shared: true })
  })

  it('round the ownship\'s, which the cockpit pass draws, and never a bandit\'s', () => {
    expect(lift('apply_model_to')).toMatch(/\n\tif\(g\.userData\.player\)\{ layer_own_group\(g\); cockpit_hidden\(\); controls_round\(g,m\); \}/)
    expect(source.match(/controls_round\(/g)).toHaveLength(2) // the definition and that one call
  })
})
