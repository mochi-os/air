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
import * as communication from './communication'

// The centre panel (#139): the UFC's face, its function row and the HUD control panel under it, each a plate over the
// model's coarse paint with its legends drawn sharp and its controls as geometry, as the displays' bezels are (#132).
// engine.ts cannot be imported (WebGL at module scope), so the tables and builders are lifted as text and run
// against stand-ins; the canvases are stand-ins that keep what is drawn on them.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
function lift(name: string): string {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`${name} not found in engine.ts`)
  const rest = source.slice(start)
  const end = /\n(?=\S)/.exec(rest.slice(1))
  return end ? rest.slice(0, end.index + 1) : rest
}
// decl: a top-level const, to the next line that starts in column one
function decl(name: string): string {
  const m = new RegExp(`\\nconst ${name}=[\\s\\S]*?\\n(?=\\S)`).exec(source)
  if (!m) throw new Error(`${name} not found in engine.ts`)
  return m[0]
}
const tables = ['CENTRE', 'CENTRE_KEYS', 'CENTRE_KNOBS', 'CENTRE_TOGGLES', 'CENTRE_LEVER', 'CENTRE_LEGENDS', 'BEZEL', 'CENTRE_PIXELS', 'CENTRE_COLOURS', 'UFC_SCRATCH', 'UFC_OPTIONS', 'UFC_CHANNELS', 'SELECTOR_DETENTS'].map(decl).join('')
const helpers = ['centre_point', 'centre_seat', 'centre_spots', 'centre_frame', 'centre_pose', 'centre_plate_draw', 'centre_letters', 'build_centre', 'centre_turn'].map(lift).join('')

type Face = { x: number; slope: number; y: [number, number]; z: [number, number]; below?: { y: [number, number]; z: [number, number] } }
type Key = [string, number, number, number, number, string[]]
type Knob = [string, number, number, number, number]
type Toggle = [string, number, number, string[]]
interface Layout {
  CENTRE: Record<string, Face>
  CENTRE_KEYS: Record<string, Key>
  CENTRE_KNOBS: Record<string, Knob>
  CENTRE_TOGGLES: Record<string, Toggle>
  CENTRE_LEVER: { nut: number; depth: number; length: number; base: number; tip: number; throw: number }
  CENTRE_LEGENDS: [string, number, number, string][]
  BEZEL: { lift: number; cap: number }
  UFC_OPTIONS: { rows: number[] }
  centre_point: (face: string, y: number, z: number, w: number) => number[]
  centre_seat: (action: string) => { at: number[]; r: number }
  centre_spots: () => { action: string; at: number[]; r: number; hold?: string }[]
}
const layout = new Function('THREE', `${tables} ${helpers} return { CENTRE, CENTRE_KEYS, CENTRE_KNOBS, CENTRE_TOGGLES, CENTRE_LEVER, CENTRE_LEGENDS, BEZEL, UFC_OPTIONS, centre_point, centre_seat, centre_spots };`)(THREE) as Layout
const { CENTRE, CENTRE_KEYS, CENTRE_KNOBS, CENTRE_TOGGLES, CENTRE_LEVER, CENTRE_LEGENDS, BEZEL } = layout

// each control's footprint on its face, [y, z, half height, half width]: a key's cap, a knob's disc, and a toggle's nut
// across with its lever's reach up and down
const footprints = (face: string) => [
  ...Object.entries(CENTRE_KEYS).filter(([, k]) => k[0] === face).map(([name, [, y, z, w, h]]) => ({ name, y, z, dy: h / 2, dz: (w || h) / 2 })),
  ...Object.entries(CENTRE_KNOBS).filter(([, k]) => k[0] === face).map(([name, [, y, z, r]]) => ({ name, y, z, dy: r, dz: r })),
  ...Object.entries(CENTRE_TOGGLES).filter(([, k]) => k[0] === face).map(([name, [, y, z]]) => ({ name, y, z, dy: CENTRE_LEVER.length * Math.sin((CENTRE_LEVER.throw * Math.PI) / 180) + CENTRE_LEVER.tip, dz: CENTRE_LEVER.nut })),
]
// whether a box [y0, y1, z0, z1] lies on a face, its HUD control panel's extension included
const on = (face: string, [y0, y1, z0, z1]: number[], margin = 0) => {
  const f = CENTRE[face], inside = (r: { y: number[]; z: number[] }) => y0 >= r.y[0] + margin && y1 <= r.y[1] - margin && z0 >= r.z[0] + margin && z1 <= r.z[1] - margin
  if (inside(f)) return true
  if (!f.below) return false
  const b = f.below // straddling the step down: the part below on the extension, the rest on the panel
  return z0 >= b.z[0] + margin && z1 <= b.z[1] - margin && y0 >= b.y[0] + margin && y1 <= f.y[1] - margin
}
const LETTER = [0.0016, 0.0019] // m: a legend letter's width and height at the plates' 2.6 mm type, generously

describe('the centre panel\'s layout (#139)', () => {
  it('stands every control on its face, at least 2 mm in from the edge', () => {
    for (const face of Object.keys(CENTRE)) for (const c of footprints(face))
      expect(on(face, [c.y - c.dy, c.y + c.dy, c.z - c.dz, c.z + c.dz], 0.002), `${face} ${c.name}`).toBe(true)
  })

  it('keeps every two controls on a face at least 3 mm apart', () => {
    for (const face of Object.keys(CENTRE)) {
      const list = footprints(face)
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j], gap = Math.max(Math.abs(a.y - b.y) - a.dy - b.dy, Math.abs(a.z - b.z) - a.dz - b.dz)
        expect(gap, `${a.name} ${b.name}`).toBeGreaterThanOrEqual(0.003)
      }
    }
  })

  it('prints every legend on its face, clear of every control', () => {
    for (const [face, y, z, text] of CENTRE_LEGENDS) {
      const half = [LETTER[1] / 2, (text.length * LETTER[0]) / 2]
      expect(on(face, [y - half[0], y + half[0], z - half[1], z + half[1]]), `${text} at ${y} ${z}`).toBe(true)
      for (const c of footprints(face)) {
        const clear = Math.abs(y - c.y) >= half[0] + c.dy || Math.abs(z - c.z) >= half[1] + c.dz
        expect(clear, `${text} at ${y} ${z} over ${c.name}`).toBe(true)
      }
    }
  })

  it('lays the HUD control panel out as figure 2-25 and the paint do: the AOA knob, ALT and ATT on the lower row', () => {
    const row = (lower: boolean) => [...Object.entries(CENTRE_KNOBS), ...Object.entries(CENTRE_TOGGLES)]
      .filter(([, c]) => c[0] === 'hud' && (c[1] < CENTRE.hud.y[0]) === lower).sort((a, b) => a[1][2] - b[1][2]).map(([name]) => name)
    expect(row(false)).toEqual(['reject', 'knob.symbology', 'hud.range', 'knob.black', 'hud.video', 'knob.balance'])
    expect(row(true)).toEqual(['knob.indexer', 'altitude', 'attitude'])
    expect(CENTRE_TOGGLES.attitude[3]).toEqual(['ins', 'auto', 'stby']) // INS up (2.13.4.8.9), as the legend column beside it reads
    expect(CENTRE_LEGENDS.filter(([face, , z]) => face === 'hud' && z === 0.0405).map(([, , , text]) => text)).toEqual(['INS', 'AUTO', 'STBY'])
  })

  it('sets the keypad in three columns and four rows, the function selectors along the row, and each option select beside its window', () => {
    const keypad = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clr', '0', 'ent'].map((k) => CENTRE_KEYS[k])
    for (let i = 0; i < 12; i++) {
      expect(keypad[i][0]).toBe('ufc')
      expect(keypad[i][1], `row of ${i}`).toBe(keypad[i - (i % 3)][1])
      expect(keypad[i][2], `column of ${i}`).toBe(keypad[i % 3][2])
    }
    const row = ['ap', 'iff', 'tcn', 'ils', 'dl', 'bcn', 'onoff'].map((k) => CENTRE_KEYS[k])
    expect(row.every((k) => k[0] === 'row' && k[1] === row[0][1])).toBe(true)
    expect(row.map((k) => k[2])).toEqual([...row.map((k) => k[2])].sort((a, b) => a - b))
    expect([0, 1, 2, 3, 4].map((i) => CENTRE_KEYS['opt' + i][1])).toEqual(layout.UFC_OPTIONS.rows)
    expect(CENTRE_KEYS['2'][5]).toEqual(['N', '2']) // a letter over four of the digits (2.13.5.9)
  })
})

// The build, against stand-ins: canvases that keep what is drawn on them.
interface Drawn { texts: string[]; fills: number[][] }
function canvas(width: number, height: number, drawn: Drawn) {
  const context = {
    font: '', fillStyle: '', strokeStyle: '', lineWidth: 1, textAlign: '', textBaseline: '',
    setTransform() {}, clearRect() {}, beginPath() {}, arc() {}, stroke() {},
    fillRect(...box: number[]) { drawn.fills.push(box) },
    fillText(text: string) { drawn.texts.push(text) },
    measureText(text: string) { return { width: text.length * 0.6 * parseFloat(this.font.replace('bold ', '')) } },
  }
  return { width, height, getContext: () => context }
}
interface Built {
  g: THREE.Group
  root: THREE.Group
  plates: Record<string, Drawn>
  materials: THREE.MeshStandardMaterial[]
  set: (state: Record<string, unknown>) => void
  atlas: Drawn
}
function built(): Built {
  const plates: Record<string, Drawn> = {}, atlas: Drawn = { texts: [], fills: [] }
  let next: Drawn | null = null
  const face_canvas = (w: number, h: number) => { next = { texts: [], fills: [] }; return { canvas: canvas(w, h, next), tex: new THREE.Texture(), pixels: [w, h], scale: 1, drawn: next } }
  const document = { createElement: () => canvas(0, 0, atlas) }
  const b = new Function('THREE', 'RoundedBoxGeometry', 'mergeGeometries', 'communication', 'face_canvas', 'document', 'plates', `const D2R=Math.PI/180, LAYER_OWN=1, lighting={ instrument:0.5 }, instrument_mats=[], renderer={ capabilities:{ getMaxAnisotropy:()=>4 } }, ownship={ group:{ userData:{} } };
    const face_context=(p)=>p.canvas.getContext("2d"), levels={}, knob_level=(k)=>k in levels?levels[k]:(k==="black"||k==="balance")?0.5:1;
    const uhf={ one:communication.fresh(), two:communication.fresh() }, hud_panel={ range:"day", video:"off" };
    let declutter=0, alt_radar=false, reference="auto", finder="off";
    ${tables} ${helpers}
    const g=new THREE.Group(); build_centre(g); const root=g.userData.centre; g.updateMatrixWorld(true);
    for(const [face,p] of Object.entries(root.userData.plates)) plates[face]=p.drawn;
    return { g, root, plates, materials:instrument_mats, set:(state)=>{ for(const [k,v] of Object.entries(state)){
        if(k==="levels") Object.assign(levels,v); else if(k==="declutter") declutter=v; else if(k==="alt_radar") alt_radar=v; else if(k==="reference") reference=v; else if(k==="finder") finder=v;
        else if(k==="hud") Object.assign(hud_panel,v); else if(k==="one"||k==="two") Object.assign(uhf[k],v); }
      centre_turn(root); g.updateMatrixWorld(true); } };`)(THREE, RoundedBoxGeometry, mergeGeometries, communication, face_canvas, document, plates) as Built
  b.atlas = atlas
  return b
}

describe('the centre panel\'s build (#139)', () => {
  const b = built()
  // what a sightline square to the panel, from in front of it, meets first at [y, z]
  const hit = (y: number, z: number) => {
    const ray = new THREE.Raycaster(new THREE.Vector3(6.0, y, z), new THREE.Vector3(1, 0, 0)); ray.layers.enableAll()
    const h = ray.intersectObject(b.g, true)[0]
    return h ? { name: h.object.name, x: h.point.x } : null
  }
  // the depth of a point w proud of a face at y, along a sightline square to the panel
  const depth = (face: string, y: number, w: number) => { const f = CENTRE[face]; return f.x + f.slope * y - w * Math.hypot(1, f.slope) }

  it('caps every UFC key 3 mm proud of its face, its legend on its top', () => {
    for (const [name, [face, y, z, , , lines]] of Object.entries(CENTRE_KEYS)) {
      const h = hit(y, z)
      expect(h?.name, name).toBe(lines.length ? 'centre.letters' : 'centre.keys')
      expect(h!.x, name).toBeCloseTo(depth(face, y, BEZEL.lift + BEZEL.cap + (lines.length ? 0.0002 : 0)), 5)
    }
  })

  it('raises every knob, its pointer turning with what it sets, a channel selector a 22nd of a turn a channel', () => {
    for (const [name, [face, y, z, r, height]] of Object.entries(CENTRE_KNOBS)) {
      const h = hit(y - r * 0.6, z) // below its middle, clear of its pointer
      expect(h?.name, name).toBe('centre.knobs')
      expect(h!.x, name).toBeCloseTo(depth(face, y - r * 0.6, BEZEL.lift + height), 5)
    }
    const pointers = b.root.userData.pointers as Record<string, THREE.Mesh>, degrees = (k: string) => Math.round((-pointers[k].rotation.z * 180) / Math.PI * 100) / 100
    expect(Object.keys(pointers).sort()).toEqual(Object.keys(CENTRE_KNOBS).sort())
    b.set({ levels: { ufc: 0, symbology: 1, indexer: 0.5 }, one: { volume: 0.2 } })
    expect([degrees('knob.ufc'), degrees('knob.symbology'), degrees('knob.indexer'), degrees('comm.one.volume'), degrees('knob.black')]).toEqual([-135, 135, 0, -81, 0])
    b.set({ one: { channel: 'G' }, two: { channel: 1 } })
    expect([degrees('comm.one.channel'), degrees('comm.two.channel')]).toEqual([327.27, 0])
  })

  it('tips each toggle\'s lever to its position: the top one up, the bottom down, a three-position switch\'s centre upright', () => {
    const levers = b.root.userData.levers as Record<string, THREE.Group>, degrees = (k: string) => Math.round((-levers[k].rotation.x * 180) / Math.PI)
    expect(Object.keys(levers).sort()).toEqual(Object.keys(CENTRE_TOGGLES).sort())
    b.set({ declutter: 0, hud: { range: 'day', video: 'off' }, alt_radar: false, reference: 'auto', finder: 'one' })
    expect(['reject', 'hud.range', 'hud.video', 'altitude', 'attitude', 'finder'].map(degrees)).toEqual([25, 25, -25, 25, 0, 25])
    b.set({ declutter: 2, hud: { range: 'night', video: 'video' }, alt_radar: true, reference: 'stby', finder: 'two' })
    expect(['reject', 'hud.range', 'hud.video', 'altitude', 'attitude', 'finder'].map(degrees)).toEqual([-25, -25, 0, -25, -25, -25])
    b.set({ declutter: 1, reference: 'ins' })
    expect(['reject', 'attitude'].map(degrees)).toEqual([0, 25])
    const tip = (k: string) => levers[k].localToWorld(new THREE.Vector3(0, 0, CENTRE_LEVER.length))
    expect(tip('attitude').y).toBeGreaterThan(CENTRE_TOGGLES.attitude[1] + 0.004) // INS: the tip up the panel
    expect(tip('altitude').y).toBeLessThan(CENTRE_TOGGLES.altitude[1] - 0.004) // RDR: down
  })

  it('lays a plate over each face\'s paint, the HUD control panel\'s down its lower row\'s extension and no further', () => {
    for (const [face, y, z] of [['ufc', 0.495, -0.099], ['ufc', 0.366, 0.097], ['row', 0.3236, -0.099], ['row', 0.362, 0.097], ['hud', 0.322, -0.099], ['hud', 0.2745, 0.097], ['hud', 0.2465, -0.05], ['hud', 0.2465, 0.048]] as const)
      expect(hit(y, z), `${face} ${y} ${z}`).toEqual({ name: 'centre.plate', x: expect.closeTo(depth(face, y, BEZEL.lift), 5) })
    expect(hit(0.26, -0.08)).toBeNull() // beside the extension: the panel steps back there
    expect(hit(0.26, 0.07)).toBeNull()
  })

  it('draws the UFC\'s window glass under its windows, and each legend on its own plate', () => {
    for (const face of Object.keys(CENTRE)) expect([...b.plates[face].texts].sort(), face).toEqual(CENTRE_LEGENDS.filter(([f]) => f === face).map(([, , , text]) => text).sort())
    expect(b.plates.ufc.fills).toHaveLength(1 + 1 + 5 + 2) // the panel, the scratchpad, the five option windows and the two channel windows
    expect(b.plates.row.fills).toHaveLength(1)
  })

  it('prints each key\'s legend in the atlas', () => {
    const texts = b.atlas.texts
    expect(texts.length).toBeGreaterThan(0)
    expect([...texts].sort()).toEqual(Object.values(CENTRE_KEYS).flatMap((k) => k[5]).sort())
  })

  it('draws on the ownship\'s cockpit layer, out of the pit\'s clicks, the plates and legends lit by the panel\'s integral lighting', () => {
    let count = 0
    b.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) { count++; expect(o.userData.overlay, o.name).toBe(true); expect(o.layers.mask, o.name).toBe(1 << 1) } })
    expect(count).toBe(3 + 2 + 3 + 2 + Object.keys(CENTRE_KNOBS).length + Object.keys(CENTRE_TOGGLES).length + 1) // the plates; the keys on two faces, the knobs on three and the nuts on two; a pointer a knob, a lever a toggle and the key legends
    expect(b.materials).toHaveLength(4) // three plates and the key legends
    for (const m of b.materials) { expect(m.emissiveIntensity).toBe(0.5); expect(m.emissiveMap).toBe(m.map) }
  })
})

describe('the centre panel\'s clicks (#139)', () => {
  it('press the UFC key whose cap is under the pointer, and nothing between them or off the keys', () => {
    // a square-on view of the panel, 10 css px a millimetre
    const key = new Function('THREE', `${tables} ${lift('centre_point')} const _ufc_key=new THREE.Vector3();
      const screen_of=(v,r)=>[v.z*10000,-v.y*10000,r*10000]; ${lift('ufc_key_at')} return ufc_key_at;`)(THREE) as (x: number, y: number) => string | null
    const at = (y: number, z: number) => key(z * 10000, -y * 10000)
    for (const [name, [face, y, z, w, h]] of Object.entries(CENTRE_KEYS)) {
      const [, cy, cz] = layout.centre_point(face, y, z, BEZEL.lift + BEZEL.cap) // its cap's face
      expect(at(cy, cz), name).toBe(name)
      expect(at(cy + h * 0.35, cz + (w || h) * 0.25), `${name} near its edge`).toBe(name)
    }
    expect(at(CENTRE_TOGGLES.finder[1], CENTRE_TOGGLES.finder[2])).toBeNull() // the ADF switch, which is no pushbutton
    expect(at(0.4376, -0.0516)).toBeNull() // between 1, 2, 4 and 5
    expect(at(0.2978, 0)).toBeNull() // the HUD control panel
  })

  it('seat the hidden switches on their controls, the indexer\'s, ALT\'s and ATT\'s on the lower row, and spot the rest', () => {
    const seats = new Function('THREE', `${tables} ${lift('centre_point')} ${lift('centre_seat')} ${decl('SWITCH_SEATS')} return SWITCH_SEATS;`)(THREE) as Record<string, { at: number[]; r: number }>
    expect(seats).toEqual({ rejswitch: layout.centre_seat('reject'), symbology: layout.centre_seat('knob.symbology'), indexer: layout.centre_seat('knob.indexer'),
      altswitch: layout.centre_seat('altitude'), attswitch: layout.centre_seat('attitude'), ufcbrt: layout.centre_seat('knob.ufc') })
    for (const k of ['indexer', 'altswitch', 'attswitch']) expect(seats[k].at[1], k).toBeLessThan(CENTRE.hud.y[0])
    const [face, y, z, r, height] = CENTRE_KNOBS['knob.ufc']
    expect(layout.centre_seat('knob.ufc')).toEqual({ at: layout.centre_point(face, y, z, BEZEL.lift + height), r }) // on the knob's face
    expect(layout.centre_seat('reject').at).toEqual(layout.centre_point('hud', CENTRE_TOGGLES.reject[1], CENTRE_TOGGLES.reject[2], BEZEL.lift + CENTRE_LEVER.depth + CENTRE_LEVER.length / 2)) // halfway out along the lever
    const spots = layout.centre_spots()
    expect(spots.map((s) => s.action)).toEqual(['comm.one.volume', 'comm.two.volume', 'comm.one.channel', 'comm.two.channel', 'knob.black', 'knob.balance', 'finder', 'hud.range', 'hud.video'])
    expect(spots.filter((s) => s.hold).map((s) => [s.action, s.hold])).toEqual([['comm.one.channel', 'comm.one.channel'], ['comm.two.channel', 'comm.two.channel']]) // pulled by a middle click
    expect(source).toMatch(/\nconst PIT_SPOTS=\[\n\t\.\.\.display_spots\(\),[^\n]*\n\t\.\.\.centre_spots\(\),/)
  })

  it('are wired: built and turned with the displays\' bezels, sharpened with the faces, the UFC\'s windows on its plate and its clicks on the caps', () => {
    expect(source).toMatch(/build_screens\(g\); build_bezels\(g\); build_centre\(g\); build_ifei\(g\);/)
    expect(source).toMatch(/displays_light\(\); bezel_turn\(\); centre_turn\(\);/)
    expect(source).toMatch(/\.\.\.Object\.entries\(\(u\.centre&&u\.centre\.userData\.plates\)\|\|\{\}\)\.map\(\(\[k,f\]\)=>\["centre\."\+k,f,centre_plate_draw\]\)/)
    expect(lift('build_ufc')).toMatch(/centre_pose\(mesh,"ufc",y,z,BEZEL\.lift\+0\.0003\);/)
    expect(lift('pit_click')).toMatch(/ufc_key_at\(e\.clientX,e\.clientY\)/)
    expect(lift('pit_hover')).toMatch(/ufc_key_at\(x,y\)/)
    expect(source).not.toMatch(/ufc_button_at|UFC_BUTTONS/)
  })
})
