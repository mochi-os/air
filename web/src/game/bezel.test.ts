// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { describe, expect, it } from 'vitest'

// The displays' bezels (#132): each DDI's and the AMPCD's pushbuttons, knobs and rockers as geometry over a plate
// that hides the model's coarse paint, and each screen placed clear of them. engine.ts cannot be imported (WebGL
// at module scope), so the tables and builders are lifted as text and run against stand-ins.
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
const buttons = /\nconst DDI_BUTTONS=\{[\s\S]*?\} \};\n/.exec(source)?.[0] ?? ''
const knobs = /\nconst DDI_KNOBS=\{[\s\S]*?\} \};\n/.exec(source)?.[0] ?? ''
const tables = [line('DDI_FACE'), buttons, line('DDI_BUTTON'), knobs, line('DDI_ROCKERS'), line('BEZEL'), line('DDI_CLEAR'), line('DDI_CUT')].join('')
const DISPLAYS = ['left', 'right', 'center'] as const
type Display = (typeof DISPLAYS)[number]
interface Layout {
  rect: Record<Display, { y: number; z: number; w: number; h: number }>
  buttons: Record<Display, [number, number][]>
  knobs: Record<Display, Record<string, [number, number, number]>>
  rockers: Record<string, Record<string, [number, number, number, number, number]>>
  half: number
  cut: number
}
const layout = new Function('THREE', `${tables} ${lift('ddi_rect')} ${lift('ddi_button')}
  const all=["left","right","center"], rect={}, buttons={};
  for(const d of all){ rect[d]=ddi_rect(d); buttons[d]=[]; for(let pb=1;pb<=20;pb++){ const p=ddi_button(d,pb); buttons[d].push([p.y,p.z]); } }
  return { rect, buttons, knobs:DDI_KNOBS, rockers:DDI_ROCKERS, half:DDI_BUTTON, cut:DDI_CUT };`)(THREE) as Layout

// a screen's outline in (z, y), the AMPCD's top corners cut
const screen = (d: Display) => {
  const r = layout.rect[d], l = r.z - r.w / 2, rt = r.z + r.w / 2, b = r.y - r.h / 2, t = r.y + r.h / 2, c = layout.cut
  return d === 'center' ? [[l, b], [rt, b], [rt, t - c], [rt - c, t], [l + c, t], [l, t - c]] : [[l, b], [rt, b], [rt, t], [l, t]]
}
const inside = (poly: number[][], [z, y]: number[]) => {
  let n = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [zi, yi] = poly[i], [zj, yj] = poly[j]
    if (yi > y !== yj > y && z < ((zj - zi) * (y - yi)) / (yj - yi) + zi) n = !n
  }
  return n
}
const gap = (poly: number[][], p: number[]) => {   // how far a point outside the outline is from it, negative inside
  let least = Infinity
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], dz = b[0] - a[0], dy = b[1] - a[1]
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dz + (p[1] - a[1]) * dy) / (dz * dz + dy * dy)))
    least = Math.min(least, Math.hypot(p[0] - a[0] - t * dz, p[1] - a[1] - t * dy))
  }
  return inside(poly, p) ? -least : least
}
// every control's outline, sampled, in (z, y)
const outlines = (d: Display) => {
  const out: { what: string; points: number[][] }[] = [], circle = (y: number, z: number, r: number) => Array.from({ length: 48 }, (_v, k) => [z + r * Math.cos((k / 48) * 2 * Math.PI), y + r * Math.sin((k / 48) * 2 * Math.PI)])
  const box = (y: number, z: number, length: number, width: number, turn: number) => {
    const a = (turn * Math.PI) / 180, along = [Math.sin(a), Math.cos(a)], across = [Math.cos(a), -Math.sin(a)], pts: number[][] = []
    for (let k = 0; k <= 16; k++) for (const [s, t] of [[k / 16 - 0.5, -0.5], [k / 16 - 0.5, 0.5], [-0.5, k / 16 - 0.5], [0.5, k / 16 - 0.5]])
      pts.push([z + along[0] * s * length + across[0] * t * width, y + along[1] * s * length + across[1] * t * width])
    return pts
  }
  layout.buttons[d].forEach(([y, z], i) => out.push({ what: `pushbutton ${i + 1}`, points: box(y, z, 2 * layout.half, 2 * layout.half, 0) }))
  for (const [name, [y, z, r]] of Object.entries(layout.knobs[d])) out.push({ what: `${name} knob`, points: circle(y, z, r) })
  for (const [name, [y, z, length, width, turn]] of Object.entries(layout.rockers[d] ?? {})) out.push({ what: `${name} rocker`, points: box(y, z, length, width, turn) })
  return out
}

describe('the display screens', () => {
  it('stand clear of every pushbutton, knob, ring and rocker round them by at least 5 mm', () => {
    for (const d of DISPLAYS) for (const { what, points } of outlines(d)) {
      const least = Math.min(...points.map((p) => gap(screen(d), p)))
      expect(least, `${d} ${what}`).toBeGreaterThan(0.005 - 1e-7) // DDI_CLEAR, which binds the AMPCD's sides
    }
  })

  // The AMPCD's side columns stand 7.5 mm below the middle of its top and bottom rows in the model's paint, so no
  // centring puts both its side legends and its rows' beside their buttons: the screen keeps clear of all of them,
  // and its 5 mm clearance narrows it enough to carry the rows' outer legends up to 4 mm in.
  it('sit centred in their pushbuttons\' rings, so the legends land beside their buttons', () => {
    for (const d of DISPLAYS) {
      const r = layout.rect[d], b = layout.buttons[d]
      for (let k = 0; k < 5; k++) {
        const across = r.z - r.w / 2 + ((96 + 80 * k) / 512) * r.w, down = r.y + r.h / 2 - ((96 + 80 * k) / 512) * r.h   // the pages' slot centres (ddi_legend)
        expect(Math.abs(across - b[5 + k][1]), `${d} top row ${k}`).toBeLessThan(d === 'center' ? 0.004 : 0.003)
        if (d !== 'center') expect(Math.abs(down - b[4 - k][0]), `${d} left column ${k}`).toBeLessThan(0.003)
      }
    }
  })

  it('cut the AMPCD\'s top corners, and only there, in its mask', () => {
    const run = new Function(`${line('DDI_CUT')} const fills=[]; let path=[];
      const document={ createElement:()=>({ getContext:()=>({ set fillStyle(v){ this.style=v; }, get fillStyle(){ return this.style; }, fillRect:()=>{}, beginPath:()=>{ path=[]; }, moveTo:(x,y)=>path.push([x,y]), lineTo:(x,y)=>path.push([x,y]), closePath:()=>{}, fill(){ fills.push({ style:this.style, path }); } }) }) };
      const THREE={ CanvasTexture:function(c){ this.image=c; }, LinearFilter:1 };
      ${lift('ampcd_corners')} ampcd_corners(0.14,0.13); return fills;`)
    const fills = run() as { style: string; path: number[][] }[]
    const a = (256 * 0.016) / 0.14, b = (256 * 0.016) / 0.13
    expect(fills.map((f) => f.style)).toEqual(['#000', '#000'])
    expect(fills[0].path).toEqual([[0, 0], [a, 0], [0, b]]) // the top left: the canvas's top is the screen's
    expect(fills[1].path).toEqual([[256, 0], [256 - a, 0], [256, b]])
    expect(source).toMatch(/\.\.\.\(display==="center"\?\{ alphaMap:ampcd_corners\(w,h\), alphaTest:0\.5 \}:\{\}\)/)
  })
})

describe('the bezels', () => {
  const turning = [line('SELECTOR'), line('SELECTOR_DETENTS'), lift('bezel_turn')].join('')
  const built = () => new Function('THREE', 'RoundedBoxGeometry', 'mergeGeometries', `const D2R=Math.PI/180, LAYER_OWN=1, ownship={ group:{ userData:{} } };
    const displays={ left:{ mode:"auto", brt:1, contrast:1 }, right:{ mode:"auto", brt:1, contrast:1 }, center:{ mode:"day", brt:1, contrast:1 } };
    ${tables} ${turning} ${lift('ddi_button')} ${lift('build_bezels')} const g=new THREE.Group(); build_bezels(g); g.updateMatrixWorld(true);
    return { g, turn:(set)=>{ for(const [d,v] of Object.entries(set)) Object.assign(displays[d],v); bezel_turn(g.userData.bezels); g.updateMatrixWorld(true); } };`)(THREE, RoundedBoxGeometry, mergeGeometries) as { g: THREE.Group; turn: (set: Record<string, Record<string, unknown>>) => void }
  const { g, turn } = built()
  // what a sightline from the pilot, square to the panel, meets first at a point on it
  const hit = (y: number, z: number) => {
    const ray = new THREE.Raycaster(new THREE.Vector3(6.0, y, z), new THREE.Vector3(1, 0, 0)); ray.layers.enableAll()
    const h = ray.intersectObject(g, true)[0]
    return h ? { name: h.object.name, x: Math.round(h.point.x * 1e4) / 1e4 } : null
  }

  it('cap every pushbutton 3 mm proud of the plate', () => {
    for (const d of DISPLAYS) for (const [y, z] of layout.buttons[d]) expect(hit(y, z), `${d} ${y} ${z}`).toEqual({ name: 'bezel.light', x: 6.1596 })
  })

  it('raise every knob 7 mm, the DDIs\' and the AMPCD\'s OFF/BRT light and the set switches dark', () => {
    for (const d of DISPLAYS) for (const [name, [y, z, r]] of Object.entries(layout.knobs[d])) {
      const side = hit(y - r * 0.6, z) // below its middle, clear of its pointer
      expect(side, `${d} ${name}`).toEqual({ name: name === 'heading' || name === 'course' ? 'bezel.dark' : 'bezel.light', x: 6.1556 })
    }
  })

  it('make a DDI\'s BRT and contrast knobs alike in size, as the paint draws them', () => {
    for (const d of ['left', 'right'] as const) expect(layout.knobs[d].brt[2], d).toBe(layout.knobs[d].contrast[2])
  })

  it('put the AMPCD\'s rockers where the paint has them, along their own angle', () => {
    for (const [name, [y, z, length, , turn]] of Object.entries(layout.rockers.center)) {
      const a = (turn * Math.PI) / 180, s = 0.4 * length
      expect(hit(y + Math.cos(a) * s, z + Math.sin(a) * s), `${name} along`).toEqual({ name: 'bezel.light', x: 6.1596 })
      expect(hit(y - Math.sin(a) * 0.006, z + Math.cos(a) * 0.006), `${name} beside`)?.not.toEqual({ name: 'bezel.light', x: 6.1596 })
    }
  })

  it('turn the selectors\', BRT knobs\' and contrast knobs\' pointers with their settings', () => {
    const pointers = g.userData.bezels.userData.pointers as Record<string, THREE.Mesh>
    const degrees = (k: string) => Math.round((-pointers[k].rotation.z * 180) / Math.PI * 10) / 10
    expect(Object.keys(pointers).sort()).toEqual(['center.brt', 'left.brt', 'left.contrast', 'left.selector', 'right.brt', 'right.contrast', 'right.selector'])
    const at: Record<string, number[]> = { off: [], night: [], auto: [], day: [] }
    for (const mode of Object.keys(at)) { turn({ left: { mode }, right: { mode } }); at[mode] = [degrees('left.selector'), degrees('right.selector')] }
    expect(at).toEqual({ off: [-67.5, -67.5], night: [-22.5, -22.5], auto: [22.5, 22.5], day: [67.5, 67.5] })
    turn({ left: { brt: 0 }, right: { brt: 0.5 }, center: { brt: 1 } })
    expect([degrees('left.brt'), degrees('right.brt'), degrees('center.brt')]).toEqual([-135, 0, 135])
    turn({ left: { contrast: 0 }, right: { contrast: 0.6 } })
    expect([degrees('left.contrast'), degrees('right.contrast'), degrees('left.brt')]).toEqual([-135, 27, -135]) // each knob its own setting
    for (const k of ['brt', 'contrast']) {
      const [y, z] = layout.knobs.left[k], tip = new THREE.Vector3(); pointers[`left.${k}`].geometry.computeBoundingBox()
      pointers[`left.${k}`].localToWorld(tip.set(0, pointers[`left.${k}`].geometry.boundingBox!.max.y, 0))
      expect(tip.y < y && tip.z < z, k).toBe(true) // at the bottom stop, the pointer leans down and to the left, toward seven o'clock, on its own knob
      expect(Math.hypot(tip.y - y, tip.z - z), k).toBeLessThan(layout.knobs.left[k][2])
    }
  })

  it('lay a plate over the paint between the buttons and the screen, where the painted screen showed', () => {
    expect(hit(0.37, -0.139)).toEqual({ name: 'bezel.plates', x: 6.1626 }) // the left DDI's painted green ran to z -0.1372
    expect(hit((layout.buttons.left[0][0] + layout.buttons.left[1][0]) / 2, layout.buttons.left[0][1])).toEqual({ name: 'bezel.plates', x: 6.1626 })
    expect(hit(0.37, -0.40)).toBeNull() // and stop at the bezel
  })

  it('draw on the ownship\'s cockpit layer and stay out of the pit\'s clicks', () => {
    const meshes = g.children[0].children as THREE.Mesh[]
    expect(meshes.map((m) => m.name).sort()).toEqual(['bezel.dark', 'bezel.light', 'bezel.plates', ...Array(7).fill('bezel.pointer')])
    for (const m of meshes) { expect(m.userData.overlay).toBe(true); expect(m.layers.mask).toBe(1 << 1) }
    expect(source).toMatch(/build_screens\(g\); build_bezels\(g\); build_ifei\(g\);/)
    expect(source).toMatch(/power_step\(out\); displays_light\(\); bezel_turn\(\);/)
  })
})

describe('the displays\' working controls', () => {
  const spots = new Function(`${line('DDI_BUTTON')} ${line('BEZEL')} ${knobs} ${line('DDI_ROCKERS')} ${lift('display_spots')} return display_spots();`)() as { action: string; at: number[]; r: number }[]

  it('are clicked on their faces, where the knobs and the rockers stand, ringed at their size', () => {
    const k = layout.knobs, rock = layout.rockers.center
    expect(spots).toEqual([
      { action: 'display.left.mode', at: [6.1556, k.left.selector[0], k.left.selector[1]], r: k.left.selector[2] },
      { action: 'display.left.brt', at: [6.1556, k.left.brt[0], k.left.brt[1]], r: k.left.brt[2] },
      { action: 'display.left.contrast', at: [6.1556, k.left.contrast[0], k.left.contrast[1]], r: k.left.contrast[2] },
      { action: 'display.right.mode', at: [6.1556, k.right.selector[0], k.right.selector[1]], r: k.right.selector[2] },
      { action: 'display.right.brt', at: [6.1556, k.right.brt[0], k.right.brt[1]], r: k.right.brt[2] },
      { action: 'display.right.contrast', at: [6.1556, k.right.contrast[0], k.right.contrast[1]], r: k.right.contrast[2] },
      { action: 'display.center.brt', at: [6.1556, k.center.brt[0], k.center.brt[1]], r: k.center.brt[2] },
      { action: 'display.center.mode', at: [6.1596, rock.mode[0], rock.mode[1]], r: rock.mode[2] / 2 },
      { action: 'display.center.contrast', at: [6.1596, rock.contrast[0], rock.contrast[1]], r: rock.contrast[2] / 2 },
    ].map((s) => ({ ...s, at: s.at.map((v) => expect.closeTo(v, 9)) })))
    expect(source).toMatch(/\nconst PIT_SPOTS=\[\n\t\.\.\.display_spots\(\),/)
  })
})

describe('the screens\' contrast (#132)', () => {
  const contrast = new Function('THREE', `${line('SCREEN_VEIL')} ${lift('screen_contrast')} return screen_contrast;`)(THREE) as (m: THREE.MeshBasicMaterial, d: string) => THREE.MeshBasicMaterial
  // the shader as three builds a basic material's, through the material's own hook
  const compiled = (m: THREE.Material) => { const sh = { fragmentShader: THREE.ShaderLib.basic.fragmentShader, vertexShader: THREE.ShaderLib.basic.vertexShader, uniforms: {} as Record<string, { value: unknown }> }; (m.onBeforeCompile as (s: typeof sh) => void)(sh); return sh }

  it('mixes each screen\'s face toward its veil after the face is sampled, by the uniform the displays\' lighting sets', () => {
    const m = contrast(new THREE.MeshBasicMaterial(), 'left'), sh = compiled(m)
    expect(sh.fragmentShader).toContain('#include <map_fragment>\n\tdiffuseColor.rgb=mix(diffuse*u_veil,diffuseColor.rgb,u_contrast);')
    expect(sh.fragmentShader.indexOf('uniform float u_contrast;')).toBe(0)
    expect(sh.uniforms.u_contrast).toBe(m.userData.contrast) // the one displays_light writes
    expect(THREE.ShaderLib.basic.fragmentShader.match(/#include <map_fragment>/g)).toHaveLength(1) // the token the patch lands on, once
  })

  it('veils a DDI in its own green and the colour AMPCD in grey', () => {
    const veil = (d: string) => (compiled(contrast(new THREE.MeshBasicMaterial(), d)).uniforms.u_veil.value as THREE.Color).getHex()
    const green = new THREE.Color(0x39e07a).multiplyScalar(0.35).getHex(), grey = new THREE.Color(0x9a9a9a).multiplyScalar(0.35).getHex()
    expect([veil('left'), veil('right'), veil('center')]).toEqual([green, green, grey])
  })

  it('leaves the symbology about twice its background at the bottom stop, and the face untouched at the top', () => {
    const floor = Number(/\nconst CONTRAST_FLOOR=([\d.]+);/.exec(source)?.[1])
    const veil = new THREE.Color(0x39e07a).multiplyScalar(0.35), ink = new THREE.Color(0x39e07a), dark = new THREE.Color(0x050b06) // the pages' green and background, as the shader reads them
    const shown = (texel: THREE.Color, k: number) => veil.g * (1 - k) + texel.g * k
    expect(shown(ink, floor) / shown(dark, floor)).toBeCloseTo(2, 0)
    expect([shown(ink, 1), shown(dark, 1)]).toEqual([ink.g, dark.g])
  })

  it('is on every screen, and set each frame from the display\'s contrast', () => {
    expect(lift('build_screens')).toMatch(/:screen_contrast\(new THREE\.MeshBasicMaterial\(\{ map:tex,[^\n]*\),display\)\);/)
    expect(lift('displays_light')).toMatch(/sc\.mesh\.material\.userData\.contrast\.value=display_contrast\(sc\.display\);/)
  })
})
