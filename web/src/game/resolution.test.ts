// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

// The cockpit's text when the view is zoomed in (#121). The faces the game draws over the model follow their size
// on screen, as the DDIs do, and the model's own panel atlases keep the codec that keeps their lettering. engine.ts
// cannot be imported (WebGL at module scope), so its functions are lifted as text and run against stand-ins.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
function lift(name: string): string {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`${name} not found in engine.ts`)
  const rest = source.slice(start)
  const end = /\n(?=\S)/.exec(rest.slice(1))
  return end ? rest.slice(0, end.index + 1) : rest
}
function line(name: string): string {
  const m = new RegExp(`\\n(?:const|let) ${name}=[^\\n]*\\n`).exec(source)
  if (!m) throw new Error(`${name} not found in engine.ts`)
  return m[0]
}

// A canvas stand-in whose context records what is drawn on it.
const canvases = `const document={ createElement:()=>{ const c={ width:0, height:0, calls:[] };
  c.getContext=()=>new Proxy({}, { get:(t,k)=>(...a)=>{ c.calls.push([k,...a]); }, set:()=>true }); return c; } };`

interface Face { canvas: { width: number; height: number; calls: unknown[][] }; tex: THREE.CanvasTexture; pixels: number[]; scale: number; mesh?: THREE.Mesh }
interface Kit {
  camera: THREE.PerspectiveCamera
  face_canvas: (w: number, h: number) => Face
  face_context: (f: Face) => unknown
  face_extent: (mesh: THREE.Mesh, dpr: number) => number[] | null
  face_step: (scale: number, need: number, most: number) => number
  face_sharpen: (f: Face, dpr: number) => boolean
}
// The pit's eye on a 1280 x 760 screen, looking down -z, with the helpers that size a face to it.
function kit(): Kit {
  return new Function('THREE', `const HW=1280, HH=760, cockpit_cam=new THREE.PerspectiveCamera(60,HW/HH,0.01,10); ${canvases}
    ${line('FACE_STEPS')} ${line('_face_corners')} ${lift('face_canvas')} ${lift('face_context')} ${lift('face_extent')} ${lift('face_step')} ${lift('face_sharpen')}
    return { camera:cockpit_cam, face_canvas, face_context, face_extent, face_step, face_sharpen };`)(THREE) as Kit
}
// the eye zoomed: the field narrowed as view_zoom narrows it, and the matrices brought up to date
function look(k: Kit, zoom: number, at = new THREE.Vector3(0, 0, -1)) {
  k.camera.fov = 2 * Math.atan(Math.tan(30 * Math.PI / 180) / zoom) * 180 / Math.PI
  k.camera.updateProjectionMatrix(); k.camera.lookAt(at); k.camera.updateMatrixWorld(true)
}
// the UFC's face: 536 x 356 of its own pixels over 0.191 x 0.127 m, 0.6 m in front of the eye
function ufc(k: Kit, x = 0): Face {
  const f = k.face_canvas(536, 356), mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.191, 0.127))
  mesh.position.set(x, 0, -0.6); mesh.updateMatrixWorld(true); f.mesh = mesh; return f
}

describe('the faces the game draws over the model', () => {
  it('step with the DDIs\' hysteresis: up past 1.15 times the scale, down below 0.45 of it, to the smallest step that holds', () => {
    const { face_step } = kit()
    expect(face_step(1, 1.1, 4)).toBe(1)
    expect(face_step(1, 1.2, 4)).toBe(2)
    expect(face_step(2, 2.2, 4)).toBe(2)
    expect(face_step(2, 2.4, 4)).toBe(4)
    expect(face_step(4, 1.9, 4)).toBe(4)
    expect(face_step(4, 1.7, 4)).toBe(2)
    expect(face_step(2, 0, 4)).toBe(1) // off screen: the face's own pixels
    expect(face_step(1, 9, 4)).toBe(4) // the largest step
  })

  it('draw at their own pixels from the default head, at the step zoom wants, and at their own again once off screen', () => {
    const k = kit(), f = ufc(k)
    look(k, 1)
    expect(k.face_sharpen(f, 1)).toBe(false)
    expect([f.scale, f.canvas.width, f.canvas.height]).toEqual([1, 536, 356])
    look(k, 4)
    const old = f.canvas; let disposed = 0; f.tex.addEventListener('dispose', () => { disposed++ })
    expect(k.face_sharpen(f, 1)).toBe(true)
    expect([f.scale, f.canvas.width, f.canvas.height]).toEqual([2, 1072, 712])
    expect(f.tex.image).toBe(f.canvas) // the texture shows the new canvas
    expect(disposed).toBe(1) // and is allocated afresh at its new size
    expect(f.canvas.calls.find((c) => c[0] === 'drawImage')?.slice(1)).toEqual([old, 0, 0, 1072, 712]) // the old picture until the owner redraws
    expect(k.face_sharpen(f, 1)).toBe(false) // held at the step
    look(k, 4, new THREE.Vector3(0, 0, 1)) // the head turned round
    expect(k.face_sharpen(f, 1)).toBe(true)
    expect([f.scale, f.canvas.width, f.canvas.height]).toEqual([1, 536, 356])
  })

  it('count device pixels, so a screen twice as dense steps twice as far', () => {
    const k = kit(), f = k.face_canvas(256, 256), mesh = new THREE.Mesh(new THREE.CircleGeometry(0.043, 48)) // the standby attitude indicator
    mesh.position.set(0, 0, -0.6); mesh.updateMatrixWorld(true); f.mesh = mesh
    look(k, 4)
    k.face_sharpen(f, 1)
    expect(f.scale).toBe(2)
    k.face_sharpen(f, 2)
    expect(f.scale).toBe(4)
  })

  it('keep a canvas to 2048 pixels a side', () => {
    const k = kit(), f = ufc(k)
    look(k, 16)
    k.face_sharpen(f, 2)
    expect(f.canvas.width).toBeLessThanOrEqual(2048)
    expect(f.canvas.width).toBeGreaterThan(2000)
  })

  it('are on screen when any of the quad is, and never behind the eye', () => {
    const k = kit()
    look(k, 4)
    expect(k.face_extent(ufc(k).mesh!, 1)).not.toBeNull()
    expect(k.face_extent(ufc(k, 0.12).mesh!, 1)).not.toBeNull() // the centre off the edge, a corner on
    expect(k.face_extent(ufc(k, 0.4).mesh!, 1)).toBeNull()
    look(k, 1, new THREE.Vector3(0, 0, 1))
    expect(k.face_extent(ufc(k).mesh!, 1)).toBeNull()
  })

  it('draw in their own pixels whatever the canvas, the context scaled to it', () => {
    const k = kit(), f = k.face_canvas(160, 160)
    f.scale = 2; k.face_context(f)
    expect(f.canvas.calls[0]).toEqual(['setTransform', 2, 0, 0, 2, 0, 0])
  })

  it('are every face built over the model: made by face_canvas, drawn through face_context, and listed to sharpen', () => {
    for (const name of ['build_faces', 'build_standby', 'build_rwr', 'build_radalt', 'build_brake', 'build_cabin', 'build_clock', 'build_ifei', 'build_ufc']) {
      expect(lift(name), name).toMatch(/face_canvas\(/)
      expect(lift(name), name).not.toMatch(/createElement\("canvas"\)/)
    }
    for (const name of ['face_start', 'rwr_draw', 'radalt_draw', 'brake_draw', 'cabin_draw', 'clock_draw', 'faces_update', 'ifei_update', 'ufc_update']) {
      expect(lift(name), name).toMatch(/face_context\(/)
      expect(lift(name), name).not.toMatch(/getContext\(/)
    }
  })

  it('are redrawn by their owners once they step', () => {
    const run = new Function(`let ufc_dirty=false, ifei_dirty=false, faces_key="drawn", clocked=0; const clock_draw=()=>{ clocked++; }, face_sharpen=()=>true;
      const u={ ufc:{}, ifei:{}, radalt:{ last:9 }, rwr:{ last:9 }, brake:{ psi:3000 }, cabin:{ feet:8000 }, clock:{},
        standby:{ asi:{}, alt:{}, vsi:{}, adi:{}, last:9 }, faces:{ arm:{}, emergency:{}, stations:{}, defence:{} } }, ownship={ group:{ userData:u } };
      ${lift('sharp_faces')} ${lift('faces_sharpen')}
      const names=sharp_faces(u).map(([name])=>name); faces_sharpen(1);
      return { names, ufc_dirty, ifei_dirty, faces_key, clocked, radalt:u.radalt.last, rwr:u.rwr.last, psi:u.brake.psi, feet:u.cabin.feet, standby:u.standby.last };`)
    expect(run()).toEqual({
      names: ['ufc', 'ifei', 'radalt', 'rwr', 'brake', 'cabin', 'clock', 'asi', 'alt', 'vsi', 'adi', 'arm', 'emergency', 'stations', 'defence'],
      ufc_dirty: true, ifei_dirty: true, faces_key: '', clocked: 1, radalt: 0, rwr: 0, psi: null, feet: null, standby: 0,
    })
  })
})

describe('the DDIs', () => {
  it('step to 2048 on a large screen, and to the smallest step off screen', () => {
    expect(line('DDI_STEPS')).toBe('\nconst DDI_STEPS=[256,512,1024,2048];\n')
    const update = lift('screens_update')
    expect(update).toMatch(/if\(pit\)\{ const e=face_extent\(sc\.mesh,dpr\); px=e\?Math\.max\(e\[0\],e\[1\]\):0; \}/)
    expect(update).toMatch(/const want=DDI_STEPS\.find\(v=>v>=px\)\|\|DDI_STEPS\[DDI_STEPS\.length-1\];/)
  })
})

describe('the annunciator lenses', () => {
  // a lens's two canvases and the scale its legend was laid out at
  const lens = (w: number, h: number) => new Function('THREE', `${canvases} ${line('LEGEND_DENSITY')} ${lift('legend')}
    const m=legend("GO","#2fd24a",${w},${h}), off=m.userData.lens.off.image, on=m.userData.lens.on.image;
    return { off:[off.width,off.height], on:[on.width,on.height], scale:off.calls.find((c)=>c[0]==="scale") };`)(THREE) as { off: number[]; on: number[]; scale: unknown[] }

  it('lay out at 8,000 canvas pixels a metre of their height, and never under their 160 x 64', () => {
    expect(lens(0.026, 0.010)).toEqual({ off: [200, 80], on: [200, 80], scale: ['scale', 1.25, 1.25] })
    expect(lens(0.028, 0.016)).toEqual({ off: [320, 128], on: [320, 128], scale: ['scale', 2, 2] })
    expect(lens(0.016, 0.008)).toEqual({ off: [160, 64], on: [160, 64], scale: ['scale', 1, 1] })
  })
})

// The model's panel lettering is a few texels tall in 1024 px atlases. ETC1S codes them in 4x4 blocks that smear
// it; UASTC keeps what the source has. tools/texswap.py encodes the cockpit's atlases so.
describe('the cockpit\'s panel atlases', () => {
  const glb = readFileSync(fileURLToPath(new URL('../assets/fa18c.glb', import.meta.url)))
  const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'))
  const bin = glb.subarray(28 + glb.readUInt32LE(12))
  // the KTX2 colour model of a texture's image: 163 ETC1S, 166 UASTC
  const codec = (texture: number) => {
    const t = json.textures[texture], view = json.bufferViews[json.images[t.extensions.KHR_texture_basisu.source].bufferView]
    const ktx = bin.subarray(view.byteOffset, view.byteOffset + view.byteLength)
    return ktx[ktx.readUInt32LE(48) + 12]
  }
  const textures = (name: string) => {
    const m = json.materials.find((k: { name: string }) => k.name === name)
    return [m.pbrMetallicRoughness?.baseColorTexture?.index, m.emissiveTexture?.index].filter((i) => i !== undefined) as number[]
  }

  it('are UASTC, the lit placards\' emissive map with them', () => {
    const cockpit = ['Material_12', 'Material_13.001', 'Material_19', 'Material_20', 'EMISSIVE_LIGHTS'].flatMap(textures)
    expect(cockpit).toHaveLength(6)
    for (const t of cockpit) expect(codec(t), `texture ${t}`).toBe(166)
  })

  it('leave the airframe\'s livery in ETC1S', () => {
    for (const t of ['Fuselage', 'Nose', 'WingL'].map((name) => textures(name)[0])) expect(codec(t), `texture ${t}`).toBe(163) // their base colour; the formation lights' emissive maps are small PNGs left as they are
  })
})
