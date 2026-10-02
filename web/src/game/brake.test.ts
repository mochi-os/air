// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

// A remote jet's speed brake is animated from the target the wire carries,
// eased at the actuator's own travel (2.5 s stowed to full, the flight
// core's Rate.Brake) so a wingman's panel opens at the pace the ownship's
// does. engine.ts cannot be imported (WebGL at module scope).
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')

describe('the remote speed brake', () => {
  it("opens at the actuator's pace", () => {
    const line = /st\.speedbrake\+=THREE\.MathUtils\.clamp\(\(st\.speedbrakeTarget\?\?0\)-st\.speedbrake,-([\d.]+)\*dt,([\d.]+)\*dt\);/.exec(source)
    expect(line).not.toBeNull()
    expect(Number(line?.[1])).toBeCloseTo(0.4, 5)
    expect(Number(line?.[2])).toBeCloseTo(0.4, 5)
  })
})

// The ANTI SKID switch (NATOPS 2.10.3.2, #114). ON, touchdown protection holds
// the pedals off from touchdown until the wheels spin up past 50 kt, or for
// 3 s if they do not, and does nothing below 10 kt. OFF, the sample says so and
// the flight core blows the main tyres under braking at speed (gear.go).
// Carrier operations fly it OFF (NATOPS 8.2.3).
const bridge = readFileSync(fileURLToPath(new URL('./flight.ts', import.meta.url)), 'utf8')
const wire = readFileSync(fileURLToPath(new URL('./net.ts', import.meta.url)), 'utf8')
const protection = /\nlet pulled=false;[^\n]*\nlet antiskid=true;\nfunction guarded\(\)\{[^\n]*\nlet spun=[^\n]*\nfunction brakes_held\(\)\{[^\n]*\n[^\n]*\n[^\n]*\n[^\n]*\n/.exec(source)?.[0] ?? ''
const pressfn = /\nfunction pit_press\(action,direction\)\{ const d=[\s\S]*?\n\t\} \}\n/.exec(source)?.[0] ?? ''
const KT = 1 / 1.94384

// roll feeds brakes_held a run of [time, grounded, knots, touchdown] frames
// with the switch and the brake handle as given, and returns whether each
// frame held the pedals.
function roll(frames: [number, boolean, number, number][], on = true, handle = 'norm'): boolean[] {
  if (!protection) throw new Error('the anti-skid block not found in engine.ts')
  return new Function('frames', 'on', 'handle', `let sim_time=0, parking=false; const ownship={ speed:0, grounded:false }, landing={ at:-Infinity }; ${protection}
    antiskid=on; pulled=handle==="emerg"; parking=handle==="park";
    return frames.map(([t,grounded,knots,at])=>{ sim_time=t; ownship.grounded=grounded; ownship.speed=knots; landing.at=at; return brakes_held(); });`)(
    frames.map(([t, grounded, knots, at]) => [t, grounded, knots * KT, at]), on, handle) as boolean[]
}

describe('the ANTI SKID switch', () => {
  it('holds the pedals for 3 s after a touchdown the wheels do not spin up from', () => {
    expect(roll([[9, false, 45, -Infinity], [10, true, 45, 10], [12.9, true, 40, 10], [13.1, true, 38, 10]])).toEqual([false, true, true, false])
  })

  it('lets the pedals go the moment the wheels pass 50 kt, and keeps them free as the jet slows', () => {
    expect(roll([[9, false, 130, -Infinity], [10, true, 130, 10], [11, true, 45, 10], [12, true, 30, 10]])).toEqual([false, false, false, false])
  })

  it('protects each touchdown afresh after a bounce', () => {
    expect(roll([[10, true, 60, 10], [10.5, false, 48, 10], [11, true, 45, 11]])).toEqual([false, false, true])
  })

  it('does nothing below 10 kt, in the air, or with the switch OFF', () => {
    expect(roll([[10, true, 8, 10]])).toEqual([false])
    expect(roll([[10, false, 45, 9]])).toEqual([false])
    expect(roll([[10, true, 45, 10], [11, true, 40, 10]], false)).toEqual([false, false])
  })

  it('works on the normal brakes only: EMERG and PARK run without it (2.10.3.3)', () => {
    expect(roll([[10, true, 45, 10]], true, 'emerg')).toEqual([false])
    expect(roll([[10, true, 45, 10]], true, 'park')).toEqual([false])
  })

  it('holds the pedals only, never the parking brake, and watches the spin-up every frame', () => {
    expect(source).toMatch(/\n\tconst withheld=brakes_held\(\);[^\n]*\n\tinput\.brake=brakes_step\(keys\.has\(key_of\("brake\.wheel"\)\)&&!withheld,dt\);/)
    // read_input calls the module's held() for the trim switches: a local of that
    // name shadows it for the whole function and kills the frame loop at its first read
    const reader = /\nfunction read_input\(dt\)\{[\s\S]*?\n\}\n/.exec(source)?.[0] ?? ''
    expect(reader).toMatch(/held\("trim\.up"\)/)
    expect(reader).not.toMatch(/\b(?:const|let|var) held\b/)
  })

  it('spawns OFF for a cat shot and every recovery, ON from the field and in the air', () => {
    const line = /\n\tantiskid=st!=="carrier"&&!recovery_start\(\);[^\n]*\n/.exec(source)?.[0] ?? ''
    const recovery = /\nfunction recovery_start\(\)\{[^\n]*\n/.exec(source)?.[0] ?? ''
    expect(line).not.toBe('')
    expect(recovery).not.toBe('')
    const spawn = (st: string) => new Function('st', `let antiskid=null; const mission_start=()=>st; ${recovery} ${line} return antiskid;`)(st) as boolean
    expect(['carrier', 'case1', 'case2', 'case3'].map(spawn)).toEqual([false, false, false, false])
    expect(['runway', 'air', 'joust'].map(spawn)).toEqual([true, true, true])
  })

  it('is rigged OFF level and ON up, and a click throws it', () => {
    expect(source).toMatch(/\{ name:"antiskid", track:\/\^Switch_FULL_ANTISKID_LeftPanel_AN\/i, drive:"antiskid" \}/)
    expect(source).toMatch(/case "antiskid": f=\(st===ownship&&antiskid\)\?1:0; break;/)
    expect(/const PIT_SWITCHES=\{([\s\S]*?)\};/.exec(source)?.[1] ?? '').toContain('antiskid:"antiskid"')
    if (!pressfn) throw new Error('pit_press not found in engine.ts')
    const press = new Function('on', `let antiskid=on; ${pressfn} pit_press("antiskid",1); return antiskid;`)
    expect(press(true)).toBe(false)
    expect(press(false)).toBe(true)
  })

  it('reaches the flight core as bypass, flag bit 2048, in both samples', () => {
    expect(source).toMatch(/\n\t\tbypass:!guarded\(\), [^\n]*gear:\(ownship\.gearTarget\?\?0\)<0\.5,/)
    expect(source).toMatch(/brake:input\.brake, bypass:!guarded\(\), [^\n]*trim:/)
    expect(bridge).toMatch(/\n {2}bypass: boolean/)
    expect(bridge).toMatch(/\n {4}\(controls\.bypass \? 2048 : 0\) \|\n/)
    expect(wire).toMatch(/\n {2}bypass: boolean/)
  })
})

// The brakes' hydraulics (NATOPS 2.7.1, 2.7.4, 2.10.3.3, #13). The normal
// brakes need HYD 2, the right engine's pump; EMERG and PARK run on HYD 2B or,
// without it, on the brake accumulator, whose gas charge makes each application
// cost more the fuller it is: 1/p rises by 1/80,000 an application.
const hydraulics = /\nconst ACCUMULATOR=[^\n]*\nlet brake_accumulator=[^\n]*\nlet drawn=[^\n]*\nfunction hydraulic\(\)\{[^\n]*\nfunction brakes_step\(pedals,dt\)\{[^\n]*\n[^\n]*\n[^\n]*\n[^\n]*\n[^\n]*\n/.exec(source)?.[0] ?? ''
type Step = [boolean, string, boolean, number]   // pedals, handle, HYD 2 up, seconds
// run feeds brakes_step a run of steps and returns what each braked and the
// accumulator's pressure after it.
function run(steps: Step[], start?: number): { braked: boolean[]; psi: number[] } {
  if (!hydraulics) throw new Error('the brake hydraulics not found in engine.ts')
  return new Function('steps', 'start', `let pulled=false, parking=false; const ownship={ gauges:{ spoolR:0.5 } }; ${hydraulics}
    if(start!==undefined) brake_accumulator=start;
    const braked=[], psi=[];
    for(const [pedals,handle,pump,dt] of steps){ pulled=handle==="emerg"; parking=handle==="park"; ownship.gauges.spoolR=pump?0.5:0; braked.push(brakes_step(pedals,dt)); psi.push(brake_accumulator); }
    return { braked, psi };`)(steps, start) as { braked: boolean[]; psi: number[] }
}
// presses: n presses and releases of the pedals in EMERG without HYD 2
const presses = (n: number): Step[] => Array.from({ length: n }, () => [[true, 'emerg', false, 0.1], [false, 'emerg', false, 0.1]] as Step[]).flat()

describe('the brake hydraulics', () => {
  it('brake on HYD 2 alone at NORM, and not at all without it', () => {
    expect(run([[true, 'norm', true, 0.1], [true, 'norm', false, 0.1]])).toEqual({ braked: [true, false], psi: [3000, 3000] })
  })

  it('run EMERG and PARK on HYD 2B while the pump turns, drawing nothing', () => {
    expect(run([[true, 'emerg', true, 0.1], [false, 'park', true, 0.1]])).toEqual({ braked: [true, true], psi: [3000, 3000] })
  })

  it('draw one application a press from the accumulator without HYD 2, however long it is held', () => {
    const { braked, psi } = run([[true, 'emerg', false, 0.1], [true, 'emerg', false, 0.1], [false, 'emerg', false, 0.1], [true, 'emerg', false, 0.1]])
    expect(braked).toEqual([true, true, false, true])
    expect(psi[0]).toBeCloseTo(3000 / (1 + 3000 / 80000), 6)
    expect(psi[1]).toBe(psi[0])
    expect(psi[3]).toBeCloseTo(psi[0] / (1 + psi[0] / 80000), 6)
  })

  it('give about fourteen applications down to the 2,000 psi redline and five more to BRK ACCUM, where it is empty', () => {
    const { braked, psi } = run(presses(21))
    const after = psi.filter((_, i) => i % 2 === 0)   // the pressure after each press
    expect(after[12]).toBeGreaterThan(2000)
    expect(after[13]).toBeLessThan(2000)
    expect(after.slice(14, 19).every((p) => p > 1750)).toBe(true)   // five full applications past the redline
    expect(after[19]).toBe(1750)
    expect(braked.filter((_, i) => i % 2 === 0)).toEqual([...Array(20).fill(true), false])   // the twenty-first finds it empty
  })

  it('hold the parking brake on its one application', () => {
    const { braked, psi } = run([[false, 'park', false, 0.1], [false, 'park', false, 5], [true, 'park', false, 0.1]])
    expect(braked).toEqual([true, true, true])
    expect(new Set(psi).size).toBe(1)
    expect(psi[0]).toBeLessThan(3000)
  })

  it('keep an EMERG application going on the accumulator when HYD 2 goes in the middle of it', () => {
    const { braked, psi } = run([[true, 'emerg', true, 0.1], [true, 'emerg', false, 0.1], [true, 'emerg', false, 0.1]])
    expect(braked).toEqual([true, true, true])
    expect(psi[0]).toBe(3000)
    expect(psi[1]).toBeLessThan(3000)
    expect(psi[2]).toBe(psi[1])
  })

  it('recharge from HYD 2 at 20 psi a second, to full and no further', () => {
    expect(run([[false, 'norm', true, 10]], 2000).psi).toEqual([2200])
    expect(run([[false, 'norm', true, 100]], 2000).psi).toEqual([3000])
    expect(run([[false, 'norm', false, 100]], 2000).psi).toEqual([2000])
  })

  it('read HYD 2 from the right engine, as the gauges do', () => {
    expect(hydraulics).toMatch(/function hydraulic\(\)\{ return \(\(ownship\.gauges\|\|\{\}\)\.spoolR\?\?1\)>0\.03; \}/)
    expect(source).toMatch(/spoolL:gL, spoolR:gR,/)
  })

  it('refill a fresh jet, and raise BRK ACCUM on the left DDI at 1,750 psi', () => {
    expect(source).toMatch(/\n\tbrake_accumulator=ACCUMULATOR\.full; drawn=false;/)
    const line = /\n\tif\(brake_accumulator<=ACCUMULATOR\.empty\) captions\.push\("BRK ACCUM"\);[^\n]*\n/.exec(source)?.[0] ?? ''
    expect(line).not.toBe('')
    const raised = (psi: number) => new Function('psi', `const ACCUMULATOR={ empty:1750 }, brake_accumulator=psi, captions=[]; ${line}
      return captions;`)(psi) as string[]
    expect(raised(1750)).toEqual(['BRK ACCUM'])
    expect(raised(1751)).toEqual([])
  })
})

// The emergency/parking brake handle (NATOPS 2.10.3.3, 2.10.3.4): out to its
// detent is EMERG, out and turned is PARK. A click steps it, the key toggles PARK.
describe('the emergency/parking brake handle', () => {
  const handle = (d: number, at: string) => {
    if (!pressfn) throw new Error('pit_press not found in engine.ts')
    return new Function('d', 'at', `let parking=at==="park", pulled=at==="emerg"; const THREE={MathUtils:{clamp:(v,lo,hi)=>Math.min(hi,Math.max(lo,v))}};
      ${pressfn} pit_press("brake.parking",d); return parking&&pulled?"both":parking?"park":pulled?"emerg":"norm";`)(d, at) as string
  }

  it('steps out NORM, EMERG, PARK on the right button and back in on the left, without wrapping', () => {
    expect([handle(1, 'norm'), handle(1, 'emerg'), handle(1, 'park')]).toEqual(['emerg', 'park', 'park'])
    expect([handle(-1, 'park'), handle(-1, 'emerg'), handle(-1, 'norm')]).toEqual(['emerg', 'norm', 'norm'])
  })

  it('toggles PARK on the key, from EMERG too', () => {
    expect([handle(0, 'norm'), handle(0, 'park'), handle(0, 'emerg')]).toEqual(['park', 'norm', 'park'])
  })

  it('draws the handle out for EMERG and PARK and turns it for PARK alone', () => {
    expect(source).toMatch(/\{ name:"parkpull",\s+track:\/\^LANDING_GEAR_Switch_ParkingBrake_AN_287\/i,\s+drive:"parkpull" \}/)
    expect(source).toMatch(/case "parkbrake": f=\(st===ownship&&parking\)\?1:0; break;/)
    expect(source).toMatch(/case "parkpull": f=\(st===ownship&&\(parking\|\|pulled\)\)\?1:0; break;/)
  })
})

// The brake accumulator pressure gauge (FO-5 item 33): psi x1000, 3 straight up
// and 45 degrees a thousand, redrawn whenever the pressure moves.
describe('the brake pressure gauge', () => {
  const draw = /\nfunction brake_draw\(b, psi\)\{[\s\S]*?\n\tb\.psi=Math\.round\(psi\); b\.tex\.needsUpdate=true; \}\n/.exec(source)?.[0] ?? ''
  // the needle: the last stroke drawn, from its tail through the pivot to its tip
  const needle = (psi: number) => {
    if (!draw) throw new Error('brake_draw not found in engine.ts')
    return new Function('psi', `const D2R=Math.PI/180, THREE={MathUtils:{clamp:(v,lo,hi)=>Math.min(hi,Math.max(lo,v))}}; const moves=[], lines=[];
      const x=new Proxy({}, { get:(o,k)=>k==="lineTo"?((a,b)=>lines.push([a,b])):k==="moveTo"?((a,b)=>moves.push([a,b])):()=>{}, set:()=>true });
      const b={ canvas:{ getContext:()=>x }, tex:{} }; ${draw} brake_draw(b,psi); return { tail:moves[moves.length-1], tip:lines[lines.length-1], psi:b.psi };`)(psi) as { tail: [number, number]; tip: [number, number]; psi: number }
  }

  it('points up at 3,000 psi, 45 degrees a thousand either side, and stops at the dial ends', () => {
    const at = (psi: number) => { const { tail, tip } = needle(psi); return Math.round(Math.atan2(tip[0] - tail[0], tail[1] - tip[1]) * 180 / Math.PI) }
    expect([at(3000), at(2000), at(4000), at(1750)]).toEqual([0, -45, 45, -56])
    expect(at(500)).toBe(at(1000))
    expect(needle(2891.6).psi).toBe(2892)
  })

  it('is built on the ownship and redrawn as the accumulator moves', () => {
    expect(source).toMatch(/build_standby\(g\); build_brake\(g\); build_cabin\(g\); build_clock\(g\); build_screens\(g\);/)
    expect(source).toMatch(/\n\tif\(bk&&bk\.psi!==Math\.round\(brake_accumulator\)\) brake_draw\(bk,brake_accumulator\);/)
  })
})

// The cockpit shell (Object_1372) is a low-detail copy of the pit, and over the
// lower left panel it stood as a block 4 cm in front of the modelled one. The
// cut is checked on the real model: the shell's triangles are read from the
// GLB, cut by model_cut, and the lines from the design eye to the gauge and the
// controls the block hid are traced through what is left of it.
describe('the cockpit shell over the lower left panel', () => {
  const glb = readFileSync(fileURLToPath(new URL('../assets/fa18c.glb', import.meta.url)))
  const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'))
  const bin = glb.subarray(28 + glb.readUInt32LE(12))
  const read = (i: number) => {
    const a = json.accessors[i], view = json.bufferViews[a.bufferView], n = { SCALAR: 1, VEC3: 3 }[a.type as 'SCALAR' | 'VEC3'] ?? 1
    const start = (view.byteOffset ?? 0) + (a.byteOffset ?? 0), data = bin.buffer.slice(bin.byteOffset + start, bin.byteOffset + start + a.count * n * (a.componentType === 5126 || a.componentType === 5125 ? 4 : 2))
    return a.componentType === 5126 ? new Float32Array(data) : a.componentType === 5125 ? new Uint32Array(data) : new Uint16Array(data)
  }
  const parent = new Map<number, number>()
  json.nodes.forEach((n: { children?: number[] }, i: number) => (n.children ?? []).forEach((c) => parent.set(c, i)))
  const matrix = (i: number | undefined): THREE.Matrix4 => {
    if (i === undefined) return new THREE.Matrix4()
    const n = json.nodes[i], m = n.matrix ? new THREE.Matrix4().fromArray(n.matrix) : new THREE.Matrix4().compose(new THREE.Vector3(...(n.translation ?? [0, 0, 0])), new THREE.Quaternion(...(n.rotation ?? [0, 0, 0, 1])), new THREE.Vector3(...(n.scale ?? [1, 1, 1])))
    return matrix(parent.get(i)).multiply(m)
  }
  // a node's mesh as model_cut meets it: one mesh named for its node, in the GLB's scene frame; the shell by default
  const scene = (name = 'Object_1372') => {
    const node = json.nodes.findIndex((n: { name?: string }) => n.name === name), primitive = json.meshes[json.nodes[node].mesh].primitives[0]
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(read(primitive.attributes.POSITION) as Float32Array, 3))
    geometry.setIndex(new THREE.BufferAttribute(read(primitive.indices), 1))
    const mesh = new THREE.Mesh(geometry); mesh.name = name; mesh.applyMatrix4(matrix(node))
    const root = new THREE.Group(); root.add(mesh); root.updateMatrixWorld(true); return { root, mesh }
  }
  const cutfn = /\nfunction model_cut\(scene, cut\)\{[\s\S]*?\n\treturn \(index\.length-kept\.length\)\/3; \}\n/.exec(source)?.[0] ?? ''
  const spec = /\n\t\tcut:\[ (\{ node:"Object_1372", boxes:\[[\s\S]*?\} \] \}),/.exec(source)?.[1] ?? ''
  const levers = /\n\t\t\t(\{ node:"Object_1101", boxes:\[[\s\S]*?\} \] \}) \],/.exec(source)?.[1] ?? ''   // the second cut: the fixed levers under the faces (G5)
  const cut = (box: string, name?: string) => { const s = scene(name); const n = new Function('THREE', 'scene', `${cutfn} return model_cut(scene, ${box});`)(THREE, s.root) as number; return { ...s, n } }
  // the first shell triangle between the design eye and a point, if any
  const eye = new THREE.Vector3(0, 1.379, 3.971)
  const blocked = (mesh: THREE.Mesh, point: number[]) => {
    const target = new THREE.Vector3(...point), ray = new THREE.Raycaster(eye, target.clone().sub(eye).normalize(), 0, eye.distanceTo(target) - 0.004)
    mesh.material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })
    return ray.intersectObject(mesh).length > 0
  }
  // in the GLB's frame: the brake gauge's centre (fitted to FO-5's layout) and the controls the lower left block hid;
  // the clock's hub and the cockpit altimeter under the pedestal block; AV COOL under the right one
  const hidden: Record<string, number[]> = { gauge: [0.331, 0.675, 4.45], hookbypass: [0.376, 0.675, 4.424], ldg: [0.358, 0.711, 4.457], parkbrake: [0.306, 0.664, 4.494], firetest: [0.293, 0.648, 4.433], apu: [0.353, 0.654, 4.378], ground: [0.384, 0.659, 4.386],
    clock: [-0.068, 0.615, 4.529], cabin: [-0.066, 0.56, 4.515], avcool: [-0.404, 0.709, 4.434] }

  it('is cut once, on load, before the model is normalised', () => {
    expect(spec).not.toBe('')
    expect(source).toMatch(/\n\t\t\t\tfor\(const cut of spec\.cut\|\|\[\]\) model_cut\(gltf\.scene, cut\);\n\t\t\t\tconst proto=normalise_model\(gltf\.scene, spec\);/)
  })

  it('stood in front of the gauge and the controls, and is cut clear of them', () => {
    const whole = scene(), open = cut(spec)
    for (const [name, point] of Object.entries(hidden)) {
      expect(blocked(whole.mesh, point), name).toBe(true)
      expect(blocked(open.mesh, point), name).toBe(false)
    }
  })

  it('takes only those blocks: 136 of the shell\'s 2,226 triangles, none outside the boxes, and leaves the main panel\'s face', () => {
    const open = cut(spec)
    expect(open.n).toBe(136)
    expect(open.mesh.geometry.index?.count).toBe((2226 - 136) * 3)
    // the AMPCD's aperture on the shell's panel face, which the AMPCD's screen is seated on, stays
    expect(blocked(open.mesh, [0, 0.85, 4.47])).toBe(true)
  })

  // The levers the model stands on the panels a face is drawn over (faces.ts, G5): the MASTER ARM switch's beside the
  // left DDI, and the earlier dispenser panel's switches and ECM knob on the pedestal. within counts the mesh's
  // triangles wholly inside a box, in the GLB's frame; behind are points on the pedestal panel behind three of them.
  const within = (mesh: THREE.Mesh, lo: number[], hi: number[]) => {
    const at = mesh.geometry.attributes.position, index = mesh.geometry.index?.array ?? [], box = new THREE.Box3(new THREE.Vector3(...lo), new THREE.Vector3(...hi)), v = new THREE.Vector3()
    let n = 0
    for (let t = 0; t < index.length; t += 3) if ([0, 1, 2].every((k) => box.containsPoint(v.fromBufferAttribute(at, index[t + k]).applyMatrix4(mesh.matrixWorld)))) n++
    return n
  }
  const arm = [[0.3107, 1.0068, 4.3864], [0.3495, 1.0699, 4.4738]], pedestal = [[-0.0194, 0.5262, 4.4641], [0.0922, 0.6524, 4.5369]]
  const behind: Record<string, number[]> = { mode: [-0.0055, 0.615, 4.5369], receiver: [0.0364, 0.589, 4.5369], jammer: [0.0713, 0.602, 4.5369] }
  it('takes the fixed levers off the panels the faces are drawn on: 242 of that mesh\'s 5,572 triangles', () => {
    expect(levers).not.toBe('')
    expect(levers).toContain(JSON.stringify(arm[0]).replace(/"/g, '')); expect(levers).toContain(JSON.stringify(pedestal[1]).replace(/"/g, ''))   // the boxes checked are the boxes cut
    const whole = scene('Object_1101'), open = cut(levers, 'Object_1101')
    expect(within(whole.mesh, arm[0], arm[1])).toBeGreaterThan(0); expect(within(open.mesh, arm[0], arm[1])).toBe(0)
    expect(within(whole.mesh, pedestal[0], pedestal[1])).toBeGreaterThan(0); expect(within(open.mesh, pedestal[0], pedestal[1])).toBe(0)
    for (const [name, point] of Object.entries(behind)) {
      expect(blocked(whole.mesh, point), name).toBe(true)
      expect(blocked(open.mesh, point), name).toBe(false)
    }
    expect(open.n).toBe(242)
    expect(open.mesh.geometry.index?.count).toBe((5572 - 242) * 3)   // the rest of the cockpit's levers stay
  })
})
