// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// A move of the engine's frame (#134) carries what stands on the earth into
// the new frame, and leaves alone what is laid in the frame's own terms - the
// sea, the sky and the light - and what is drawn from points it carries
// itself. engine.ts runs on import, so its functions are lifted from its text
// and run with stand-ins.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')

function lift(name: string): string {
  const start = source.search(new RegExp(`function ${name}\\(`))
  if (start < 0) throw new Error(`no function ${name} in engine.ts`)
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1) + '\n'
  }
  throw new Error(`unbalanced function ${name}`)
}

function line(pattern: RegExp): string {
  const found = pattern.exec(source)?.[0]
  if (!found) throw new Error(`no line ${pattern} in engine.ts`)
  return found + '\n'
}

interface Pool {
  activeList: number[]
  px: Float32Array
  py: Float32Array
  pz: Float32Array
  vx: Float32Array
  vy: Float32Array
  vz: Float32Array
}
interface Harness {
  scene: THREE.Scene
  move(turn: THREE.Quaternion, by: THREE.Vector3): void
  carry(): void
  pool: Pool
}

function harness(): Harness {
  return new Function(
    'THREE',
    `const scene=new THREE.Scene(), home_root=new THREE.Group(), camera=new THREE.PerspectiveCamera(), render_offset=new THREE.Vector3();
    scene.add(home_root);
    let flyby_pos=null, flight_active=false, heat_prev=null, placed=null, zone=null, heat=null, hist_valid=true, shadow_frame=1;
    const stand=()=>({ pos:new THREE.Vector3(), fwd:new THREE.Vector3(1,0,0), up:new THREE.Vector3(0,1,0), right:new THREE.Vector3(0,0,1), vel_dir:new THREE.Vector3(1,0,0), q:new THREE.Quaternion() });
    const ownship=stand(), bandit=stand(), remotes=new Map(), sync_core=()=>{}, flight_get=()=>null;
    const pool=()=>({ activeList:[], px:new Float32Array(4), py:new Float32Array(4), pz:new Float32Array(4), vx:new Float32Array(4), vy:new Float32Array(4), vz:new Float32Array(4) });
    const tracers=pool(), flares=pool(), smoke=pool(), strikes=pool(), debris=pool(), vapour_pool=pool();
    const missiles=[], contrails=[], falling=[], soot_queue=[], RADAR={ tracks:[], bricks:[] }, navigate={ carry(){} }, nav={};
    ${line(/^const moving=[^\n]*/m)}
    ${line(/^const _carried=[^\n]*/m)}
    ${lift('moved')}${lift('turned')}${lift('moved_at')}${lift('turned_at')}${lift('turned_fields')}${lift('carry_state')}${lift('theatre_carry')}
    return { scene, pool:smoke, carry:()=>theatre_carry(null,null),
      move:(q,by)=>{ const x=q.x, y=q.y, z=q.z, w=q.w;
        moving.rows=[1-2*(y*y+z*z),2*(x*y-w*z),2*(x*z+w*y), 2*(x*y+w*z),1-2*(x*x+z*z),2*(y*z-w*x), 2*(x*z-w*y),2*(y*z+w*x),1-2*(x*x+y*y)];
        moving.move={ x:by.x, y:by.y, z:by.z }; moving.turn.copy(q); } };`
  )(THREE) as Harness
}

describe("a move of the engine's frame", () => {
  // the frame moves 4 km west and the earth turns 0.036 degrees under it, as one move does
  const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0.2, 0, 1).normalize(), 6.3e-4)
  const by = new THREE.Vector3(4000, 1.26, -150)

  it('carries what stands on the earth, and leaves the sea, the sky and the light where the frame lays them', () => {
    const h = harness()
    h.move(turn, by)
    const jet = new THREE.Group()
    jet.position.set(-3990, 6000, 140)
    const sea = new THREE.Mesh()
    sea.position.set(-3990, 0, 140) // under the camera, level in the frame
    sea.userData.framed = true
    const sun = new THREE.DirectionalLight()
    sun.position.set(0, 4000, 0)
    sun.userData.framed = true
    h.scene.add(jet, sea, sun)
    h.carry()
    const want = new THREE.Vector3(-3990, 6000, 140).applyQuaternion(turn).add(by)
    expect(jet.position.distanceTo(want)).toBeLessThan(1e-9)
    expect(jet.quaternion.angleTo(turn)).toBeLessThan(1e-7)
    expect(sea.position.y).toBe(0) // carried, it sank 37.8 m on a carrier start and the hull stood out of the water
    expect(sea.quaternion.equals(new THREE.Quaternion())).toBe(true)
    expect(sun.position.toArray()).toEqual([0, 4000, 0])
  })

  it('moves a pool\'s points once, through the pool, and never its object at the origin as well', () => {
    const h = harness()
    h.move(turn, by)
    const points = new THREE.Points()
    points.userData.framed = true
    h.scene.add(points)
    h.pool.activeList.push(0)
    h.pool.px[0] = -3990
    h.pool.py[0] = 6000
    h.pool.pz[0] = 140
    h.carry()
    const want = new THREE.Vector3(-3990, 6000, 140).applyQuaternion(turn).add(by)
    expect(Math.hypot(h.pool.px[0] - want.x, h.pool.py[0] - want.y, h.pool.pz[0] - want.z)).toBeLessThan(0.01) // single precision
    expect(points.position.toArray()).toEqual([0, 0, 0])
  })

  it("reads the server's rounds in the engine's frame, as everything it draws or warns of from the wire", () => {
    // the RWR measures a seeker's reach and closure against the jet: from the
    // raw wire, 20 km from Midway, every round was out of reach and B never heard MISSILE
    expect(source).toMatch(/const r=theatre\.inward; for\(const d of \(net\.darts\|\|\[\]\)\)\{\n\t+if\(!d\.radar\|\|d\.shooter===net\.slot\) continue;\n\t+const at=earth_point\(r,\{ x:d\.position\[0\], y:d\.position\[1\], z:d\.position\[2\] \}\), v=earth_vector\(r,/)
    expect(source).not.toMatch(/d\.position\[0\]-ownship\.pos\.x/)
    expect(lift('update_darts')).toMatch(/const r=theatre\.inward;/)
  })

  it('marks everything laid in the frame or drawn from carried points', () => {
    expect(source).toMatch(/for\(const o of \[sun,sun\.target,hemi,amb\]\) o\.userData\.framed=true;/)
    expect(source).toMatch(/const sky = new THREE\.Mesh\([^\n]*sky\.userData\.framed=true; scene\.add\(sky\);/)
    expect(source).toMatch(/stars\.frustumCulled=false; stars\.userData\.framed=true; scene\.add\(stars\);/)
    expect(lift('build_ocean')).toMatch(/ocean\.userData\.framed=true; scene\.add\(ocean\);/)
    expect(lift('dots_build')).toMatch(/p\.userData\.framed=true; scene\.add\(p\);/)
    expect(source).toMatch(/pts\.userData\.framed=true; scene\.add\(pts\); return pts; \}/)
    expect(source).toMatch(/const mesh=new THREE\.Mesh\(geo,contrail_mat\); mesh\.frustumCulled=false; mesh\.userData\.framed=true; scene\.add\(mesh\);/)
  })
})
