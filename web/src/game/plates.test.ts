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
import * as avionics from './avionics'
import * as communication from './communication'
import * as identification from './identification'
import * as plates from './plates'

// The plates (plates.ts, #141-#146): the spin recovery panel, the panel under the IFEI and the side consoles' panels,
// each a face over the model's paint with its legends drawn sharp and its controls built to move; the SELECT JETT knob
// and the canopy jettison handle. engine.ts cannot be imported (WebGL at module scope), so the build and what turns it
// are lifted as text and run against stand-ins: canvases that keep what is drawn on them.
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
const tables = ['BEZEL', 'CENTRE_LEVER', 'CENTRE_COLOURS', 'SELECTOR_DETENTS', 'LEGEND_DENSITY', 'PLATE_OPEN', 'PLATE_KNOBS', 'PLATE_TOGGLES', 'TIE_HOLD'].map(decl).join('')
const helpers = ['legend', 'centre_lever', 'plate_values', 'plates_draw', 'build_plates', 'plate_knob', 'plate_toggle', 'plates_turn', 'plate_spots'].map(lift).join('')
const PLATES = plates.PLATES
const EYE = [5.6777, 0.669, 0] // the design eye, in the jet's frame
const D2R = Math.PI / 180

// a context that keeps the text drawn on it, each fresh picture marked by its clearRect
function context(drawn: string[]) {
  const store: Record<string | symbol, unknown> = {}
  return new Proxy(store, {
    get: (t, k) => k === 'fillText' ? (s: string) => drawn.push(String(s)) : k === 'clearRect' ? () => drawn.push('|') : k === 'measureText' ? (s: string) => ({ width: String(s).length * 5 }) : k in t ? t[k] : () => {},
    set: (t, k, v) => { t[k] = v; return true },
  })
}
const canvas = (width: number, height: number, drawn: string[]) => ({ width, height, getContext: () => context(drawn) })
interface Face { plate: plates.Plate; drawn: string[]; mesh: THREE.Mesh }
interface Root extends THREE.Group {
  userData: { faces: Record<string, Face>; pointers: Record<string, THREE.Group>; levers: Record<string, THREE.Group>; guards: Record<string, THREE.Group>; select: { turn: THREE.Group; push: THREE.Group }; handle: THREE.Group }
}
interface Built {
  g: THREE.Group
  root: Root
  set: (name: string, value: unknown) => void
  turn: () => void
  plate_toggle: (action: string) => string | null
  plate_knob: (action: string) => number
  plate_spots: () => { action: string; at: number[]; r: number }[]
  materials: THREE.MeshStandardMaterial[]
  BEZEL: { lift: number }
  CENTRE_LEVER: { depth: number; length: number; throw: number }
  PLATE_OPEN: number
}
function built(): Built {
  const face_canvas = (w: number, h: number) => { const drawn: string[] = []; return { canvas: canvas(w, h, drawn), tex: new THREE.Texture(), scale: 1, drawn } }
  const document = { createElement: () => canvas(0, 0, []) }
  return new Function('THREE', 'RoundedBoxGeometry', 'mergeGeometries', 'plates', 'communication', 'identification', 'face_canvas', 'document',
    `const D2R=Math.PI/180, LAYER_OWN=1, lighting={ instrument:0.3 }, instrument_mats=[], renderer={ capabilities:{ getMaxAnisotropy:()=>4 } };
    const face_context=(f)=>f.canvas.getContext("2d"), levels={}, knob_level=(k)=>k in levels?levels[k]:1;
    let taping="automatic", taping_source="hud", ir_cool="norm", spin_switch="norm", wing_inhibit=false, mc_switch="norm", held=false, glance=100, tie_flicked=-Infinity, jettison_pushed=-Infinity, canopy_gone=false;
    const isolate_held=()=>held, uhf={ panel:communication.panel(11) }, squawk=identification.fresh(), arms={ select:"safe" };
    ${tables} ${helpers}
    const g=new THREE.Group(); g.userData.lamps={}; g.userData.tested=[]; build_plates(g); const root=g.userData.plates; g.updateMatrixWorld(true);
    return { g, root, set:(name,value)=>{ if(name==="levels") Object.assign(levels,value); else eval(name+"=value"); }, turn:()=>{ plates_turn(root); g.updateMatrixWorld(true); },
      plate_toggle, plate_knob, plate_spots, materials:instrument_mats, BEZEL, CENTRE_LEVER, PLATE_OPEN };`)(THREE, RoundedBoxGeometry, mergeGeometries, plates, communication, identification, face_canvas, document) as Built
}

const inside = (poly: readonly plates.Point[], [a, b]: readonly number[]) => {
  let n = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [ai, bi] = poly[i], [aj, bj] = poly[j]; if (bi > b !== bj > b && a < ((aj - ai) * (b - bi)) / (bj - bi) + ai) n = !n }
  return n
}
const centroid = (p: plates.Plate): plates.Point => [p.outline.reduce((s, q) => s + q[0], 0) / p.outline.length, p.outline.reduce((s, q) => s + q[1], 0) / p.outline.length]
// each toggle's states: where it is read from, and every value its system can hold
const STATES: Record<string, [string, unknown[]]> = {
  ircool: ['ir_cool', ['oride', 'norm', 'off']], 'spin.recovery': ['spin_switch', ['rcvy', 'norm']], 'wing.inhibit': ['wing_inhibit', [true, false]], computer: ['mc_switch', [...avionics.SWITCH]],
  'hydraulic.isolate': ['held', [true, false]], 'comm.guard': ['uhf.panel.guard', ['one', 'off', 'two']], 'comm.relay': ['uhf.panel.relay', ['cipher', 'off', 'plain']], 'comm.landing': ['uhf.panel.landing', ['ufc', 'manual']],
  'antenna.comm': ['uhf.panel.antenna', ['upper', 'auto', 'lower']], 'identification.master': ['squawk.master', ['normal', 'emergency']], 'identification.alert': ['squawk.alert', ['off', 'display', 'audible']],
  'identification.crypto': ['squawk.crypto', ['hold', 'normal', 'zero']], 'antenna.identification': ['squawk.antenna', ['upper', 'both', 'lower']], 'generator.tie': ['tie_flicked', [99.8, -Infinity]],
}
const toggles = Object.entries(PLATES).flatMap(([name, p]) => Object.entries(p.toggles ?? {}).map(([action, t]) => ({ name, p, action, t })))
const knobs = Object.entries(PLATES).flatMap(([name, p]) => Object.entries(p.knobs ?? {}).map(([action, k]) => ({ name, p, action, k })))

describe('the plates\' layout (#141, #142, #146)', () => {
  it('faces the pilot from every plate, within 80 degrees of square to the design eye', () => {
    for (const [name, p] of Object.entries(PLATES)) {
      const c = plates.point(p, centroid(p)), n = plates.normal(p), v = EYE.map((e, k) => e - c[k]), length = Math.hypot(...v)
      expect(Math.hypot(...n), name).toBeCloseTo(1, 3)
      expect(n.reduce((s, x, k) => s + x * v[k], 0) / length, name).toBeGreaterThan(Math.cos(80 * D2R))
      const right = p.right, up = p.up
      expect(right.reduce((s, x, k) => s + x * up[k], 0), `${name} right square to up`).toBeCloseTo(0, 3)
    }
  })

  it('puts every legend, knob, toggle, light, guard and window inside its plate\'s outline', () => {
    for (const [name, p] of Object.entries(PLATES)) {
      const points: [string, readonly number[]][] = [...p.legends.map((l) => [l.text, l.at] as [string, readonly number[]]),
        ...Object.entries({ ...p.knobs, ...p.toggles, ...p.lamps, ...p.guards }).map(([k, c]) => [k, c.at] as [string, readonly number[]]),
        ...(p.windows ?? []).map((w) => [w.show, [(w.at[0] + w.at[2]) / 2, (w.at[1] + w.at[3]) / 2]] as [string, readonly number[]])]
      for (const [what, at] of points) expect(inside(p.outline, at), `${name} ${what}`).toBe(true)
    }
  })

  it('gives each toggle two or three positions from the top of its throw, a guard closing over one of them', () => {
    expect(toggles).toHaveLength(14)
    for (const { action, t } of toggles) expect([2, 3], action).toContain(t.positions.length)
    for (const [action, d] of Object.entries(PLATES.spin.guards!)) expect(PLATES.spin.toggles![action].positions, action).toContain(d.closed)
  })
})

describe('the plates\' build (#141-#146)', () => {
  const b = built(), { levers, pointers, guards, faces } = b.root.userData
  // a point in the group's frame, on a plate: [along right, along up, off the face]
  const on = (name: string, v: THREE.Vector3) => { const p = PLATES[name], d = v.toArray().map((x, k) => x - p.origin[k]); return [p.right, p.up, plates.normal(p)].map((e) => e.reduce((s, x, k) => s + x * d[k], 0)) }
  const tip = (name: string, action: string) => on(name, levers[action].localToWorld(new THREE.Vector3(0, 0, b.CENTRE_LEVER.length)))
  // the state that sets a toggle at a position
  const stand = (action: string, position: string) => {
    const [name, values] = STATES[action]
    for (const v of values) { b.set(name, v); if (b.plate_toggle(action) === position) { b.turn(); return } }
    throw new Error(`${action} never stands at ${position}`)
  }

  it('sets every toggle to one of its positions for every state its system holds, each state its own position and every position reached', () => {
    expect(Object.keys(STATES).sort()).toEqual(toggles.map((t) => t.action).sort())
    for (const { action, t } of toggles) {
      const [name, values] = STATES[action], seen = values.map((v) => { b.set(name, v); return b.plate_toggle(action) })
      expect(new Set(seen).size, action).toBe(values.length)
      expect([...seen].sort(), action).toEqual([...t.positions].sort())
    }
    b.set('glance', 100); b.set('tie_flicked', 100 - 0.39); expect(b.plate_toggle('generator.tie')).toBe('reset') // RESET for a moment after the click,
    b.set('tie_flicked', 100 - 0.41); expect(b.plate_toggle('generator.tie')).toBe('norm') // then back to NORM under its spring
  })

  it('throws each lever toward the legend of the position it stands at, upright at a three-position switch\'s centre', () => {
    const named: Record<string, [string, Record<string, string>]> = {
      ircool: ['spin', { oride: 'ORIDE', off: 'OFF' }], 'spin.recovery': ['spin', { rcvy: 'RCVY', norm: 'NORM' }], 'wing.inhibit': ['exterior', { inhibit: 'INHIBIT', norm: 'NORM' }],
      'hydraulic.isolate': ['computer', { oride: 'ORIDE', norm: 'NORM' }], computer: ['computer', { one: '1 OFF', two: '2 OFF' }],
      'comm.guard': ['comm', { one: 'COMM 1', two: 'COMM 2' }], 'comm.relay': ['comm', { cipher: 'CIPHER', plain: 'PLAIN' }], 'comm.landing': ['comm', { ufc: 'UFC', manual: 'MAN' }],
      'identification.master': ['comm', { emergency: 'EMERG', normal: 'NORM' }], 'identification.alert': ['comm', { audible: 'DIS/AUD', off: 'OFF' }], 'identification.crypto': ['comm', { hold: 'HOLD', zero: 'ZERO' }],
      'antenna.comm': ['antenna', { upper: 'UPPER', lower: 'LOWER' }], 'antenna.identification': ['antenna', { upper: 'UPPER', lower: 'LOWER' }], 'generator.tie': ['tie', { reset: 'RESET', norm: 'NORM' }],
    }
    expect(Object.keys(named).sort()).toEqual(toggles.map((t) => t.action).sort())
    for (const [action, [name, positions]] of Object.entries(named)) {
      const p = PLATES[name], at = p.toggles![action].at
      const legend = (text: string) => p.legends.filter((l) => l.text === text).sort((l, m) => Math.hypot(l.at[0] - at[0], l.at[1] - at[1]) - Math.hypot(m.at[0] - at[0], m.at[1] - at[1]))[0].at
      const [first, second] = Object.keys(positions)
      for (const [here, there] of [[first, second], [second, first]]) {
        stand(action, here)
        const t = tip(name, action), near = legend(positions[here]), far = legend(positions[there])
        expect(Math.hypot(t[0] - near[0], t[1] - near[1]), `${action} at ${here}`).toBeLessThan(Math.hypot(t[0] - far[0], t[1] - far[1]))
        expect(t[2], `${action} at ${here}: off the face`).toBeGreaterThan(b.BEZEL.lift)
      }
      const middle = p.toggles![action].positions[1]
      if (p.toggles![action].positions.length === 3) { stand(action, middle); expect(Math.round(-levers[action].rotation.x / D2R), `${action} at ${middle}`).toBe(0) }
    }
  })

  it('stands a console\'s levers half again the centre panel\'s, and turns them to throw across a panel that reads sideways', () => {
    for (const { name, action, t } of toggles) {
      const seat = levers[action].parent as THREE.Group
      expect(seat.scale.x, action).toBeCloseTo(t.scale ?? 1, 6)
      expect(Math.round(seat.rotation.z / D2R), action).toBe(t.turn ?? 0)
      expect(PLATES[name].lighting === 'console' || (t.scale ?? 1) === 1, action).toBe(true)
    }
  })

  it('turns each knob\'s pointer to what it sets: a brightness knob from its OFF stop, the video selector and the record mode selector to their legends', () => {
    expect(Object.keys(pointers).sort()).toEqual(knobs.map((k) => k.action).sort())
    const degrees = (k: string) => Math.round(-pointers[k].rotation.z / D2R)
    b.set('levels', { hmd: 0, ifei: 1 }); b.turn()
    expect([degrees('knob.hmd'), degrees('knob.ifei')]).toEqual([-135, 135])
    const toward = (action: string, text: string) => {
      const p = PLATES.record, k = p.knobs![action].at, t = degrees(action) * D2R
      const l = p.legends.filter((m) => m.text === text).sort((m, n) => Math.hypot(m.at[0] - k[0], m.at[1] - k[1]) - Math.hypot(n.at[0] - k[0], n.at[1] - k[1]))[0].at // the nearest of its name
      const d = [l[0] - k[0], l[1] - k[1]], n = Math.hypot(d[0], d[1])
      return (Math.sin(t) * d[0] + Math.cos(t) * d[1]) / n
    }
    for (const [source, text] of [['left', 'L'], ['hud', 'HUD']]) { b.set('taping_source', source); b.turn(); expect(toward('record.source', text), source).toBeGreaterThan(Math.cos(30 * D2R)) }
    for (const [mode, text] of [['manual', 'MAN'], ['off', 'OFF'], ['automatic', 'AUTO']]) { b.set('taping', mode); b.turn(); expect(toward('recorder', text), mode).toBeGreaterThan(Math.cos(30 * D2R)) }
  })

  it('closes the spin recovery switch\'s guard over NORM and swings it open at RCVY, lighting SPN RCVY with the lights test\'s lenses', () => {
    stand('spin.recovery', 'norm'); expect(guards['spin.recovery'].rotation.x).toBe(0)
    stand('spin.recovery', 'rcvy'); expect(guards['spin.recovery'].rotation.x).toBeCloseTo(b.PLATE_OPEN * D2R, 6)
    stand('spin.recovery', 'norm')
    const lamp = b.g.userData.lamps.spin as THREE.Mesh
    expect(lamp.userData.lens).toBeDefined(); expect(lamp.renderOrder).toBe(1)
    expect(b.g.userData.tested).toContain(lamp)
    expect(Math.round(lamp.rotation.z / D2R)).toBe(90)
  })

  it('draws every legend on its plate, a stacked one a letter at a time, and the ILS channel in the comm panel\'s windows', () => {
    for (const [name, p] of Object.entries(PLATES)) {
      const want = [...p.legends.flatMap((l) => l.stacked ? [...l.text] : [l.text]), ...(name === 'comm' ? ['1', '1'] : [])].sort()
      expect(faces[name].drawn.filter((t) => t !== '|').sort(), name).toEqual(want)
    }
  })

  it('redraws the comm panel when the channel changes, and not otherwise', () => {
    const drawn = faces.comm.drawn, pictures = () => drawn.filter((t) => t === '|').length, before = pictures()
    b.turn(); b.turn()
    expect(pictures()).toBe(before)
    b.set('uhf.panel.channel', 7); b.turn()
    expect(pictures()).toBe(before + 1)
    expect(drawn.slice(drawn.lastIndexOf('|'))).toEqual(expect.arrayContaining(['0', '7']))
    b.turn(); expect(pictures()).toBe(before + 1)
  })

  it('lights the instrument panel\'s plates with its integral lighting, the consoles\' as the model\'s console paint under the floods', () => {
    const lit = Object.entries(PLATES).filter(([, p]) => p.lighting === 'instrument').map(([name]) => faces[name].mesh.material as THREE.MeshStandardMaterial)
    expect(lit).toHaveLength(2)
    expect(b.materials).toEqual(expect.arrayContaining(lit))
    for (const m of b.materials) { expect(m.emissiveIntensity).toBe(0.3); expect(m.emissiveMap).toBe(m.map) }
    for (const [name, p] of Object.entries(PLATES)) if (p.lighting === 'console') expect((faces[name].mesh.material as THREE.MeshStandardMaterial).emissiveMap, name).toBeNull()
  })

  it('turns the SELECT JETT knob to its position as FO-5 draws them, and pushes its JETT button in for a moment (#145)', () => {
    const { turn, push } = b.root.userData.select
    for (const [select, degrees] of Object.entries(plates.SELECT.angles)) { b.set('arms.select', select); b.turn(); expect(Math.round(-turn.rotation.z / D2R), select).toBe(degrees) }
    b.set('jettison_pushed', 100 - 0.1); b.turn(); expect(push.position.z).toBeCloseTo(-plates.SELECT.button.push, 6)
    b.set('jettison_pushed', 100 - 0.4); b.turn(); expect(push.position.z).toBe(0)
  })

  it('pulls the canopy jettison handle aft once the canopy has gone (#144)', () => {
    b.set('canopy_gone', false); b.turn(); expect(b.root.userData.handle.rotation.z).toBe(0)
    b.set('canopy_gone', true); b.turn(); expect(b.root.userData.handle.rotation.z).toBeCloseTo(-plates.HANDLE.pull * D2R, 6)
    b.set('canopy_gone', false); b.turn()
  })

  it('draws on the ownship\'s cockpit layer, out of the pit\'s raycasts', () => {
    let count = 0
    b.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) { count++; expect(o.userData.overlay, o.name).toBe(true); expect(o.layers.mask, o.name).toBe(1 << 1) } })
    expect(count).toBeGreaterThan(Object.keys(PLATES).length + toggles.length * 2 + knobs.length * 2)
  })
})

describe('the plates\' clicks (#141-#146)', () => {
  const b = built(), spots = b.plate_spots()
  it('seat a click on each knob and toggle, a guarded switch\'s on its guard\'s cover', () => {
    expect(spots.map((s) => s.action).sort()).toEqual([...knobs.map((k) => k.action), ...toggles.map((t) => t.action)].sort())
    for (const s of spots) {
      const plate = toggles.find((t) => t.action === s.action)?.p ?? knobs.find((k) => k.action === s.action)!.p
      const d = s.at.map((x, k) => x - plate.origin[k]), off = plates.normal(plate).reduce((sum, x, k) => sum + x * d[k], 0)
      const guard = plate.guards?.[s.action], toggle = plate.toggles?.[s.action], knob = plate.knobs?.[s.action]
      const height = guard ? guard.height : knob ? knob.height : (toggle!.scale ?? 1) * (b.CENTRE_LEVER.depth + b.CENTRE_LEVER.length / 2)
      expect(off, s.action).toBeCloseTo(b.BEZEL.lift + height, 5)
    }
  })
  it('are the plates\' own: none of their controls keeps a spot of its own in PIT_SPOTS, and the knob and handle built are clicked where they stand', () => {
    const table = decl('PIT_SPOTS')
    expect(table).toMatch(/\n\t\.\.\.plate_spots\(\),/)
    for (const s of spots) expect(table, s.action).not.toMatch(new RegExp(`\\{ action:"${s.action.replace(/\./g, '\\.')}"`))
    expect(table).toMatch(/\{ action:"jettison\.select", at:plates\.point\(\{ origin:plates\.SELECT\.centre, right:plates\.SELECT\.right, up:plates\.SELECT\.up \},\[0,0\],plates\.SELECT\.skirt\.height\), r:0\.016, hold:"jettison\.release" \}/)
    expect(table).toMatch(/\{ action:"canopy\.jettison", at:\[6\.0921,0\.2508,-0\.3196\], r:0\.017 \}/)
  })
})

describe('the TCN volume knob (#146)', () => {
  // the model's copy of the RUD TRIM knob carries its own clip; the loader strips the dot from its node's name
  const rig = (name: string) => new RegExp(new RegExp(`\\{ name:"${name}",\\s+track:/(.*?)/i,`).exec(source)![1], 'i')
  it('binds the copy\'s clip and leaves RUD TRIM its own', () => {
    for (const track of ['HANDLING_Knob_RudderTrim001_AN_RudderTrim001_497.quaternion', 'HANDLING_Knob_RudderTrim.001_AN_RudderTrim.001_497.quaternion']) {
      expect(rig('volumetacan').test(track), track).toBe(true); expect(rig('ruddertrim').test(track), track).toBe(false)
    }
    expect(rig('volumetacan').test('HANDLING_Knob_RudderTrim_AN_RudderTrim_494.quaternion')).toBe(false)
    expect(decl('PIT_SWITCHES')).toMatch(/volumetacan:"volume\.tacan"/)
  })
  it('turns it over 240 degrees of its 281-degree clip, centred, with the volume', () => {
    const line = /\n\t\tcase "volumetacan": [^\n]*\n/.exec(source)?.[0] ?? ''
    const drive = (volume: number) => new Function('volume', `const ownship={}, st=ownship, uhf={ panel:{ volume:{ tacan:volume } } }; let f; switch("volumetacan"){ ${line} } return f;`)(volume) as number
    expect([drive(0), drive(0.5), drive(1)].map((f) => Math.round(f * 1000) / 1000)).toEqual([0.073, 0.5, 0.927])
    expect((drive(1) - drive(0)) * 281).toBeCloseTo(240, 0)
  })
})

describe('the spin recovery switch and IR COOL in the flight core (#141)', () => {
  const bridge = readFileSync(fileURLToPath(new URL('./flight.ts', import.meta.url)), 'utf8'), wire = readFileSync(fileURLToPath(new URL('./net.ts', import.meta.url)), 'utf8')
  it('reach the core as spin, flag bit 131072, and the server as spin and uncooled in every sample', () => {
    expect(bridge).toMatch(/\n {2}spin: boolean/)
    expect(bridge).toMatch(/\n {4}\(controls\.spin \? 131072 : 0\)/)
    expect(wire).toMatch(/\n {2}spin: boolean/); expect(wire).toMatch(/\n {2}uncooled: boolean/)
    expect(source).toMatch(/spin:spin_switch==="rcvy", transfer:/) // the core's own controls
    expect(source).toMatch(/spin:spin_switch==="rcvy", uncooled:uncooled\(\), wing:/) // and the server's sample
  })
  it('start each flight at NORM', () => {
    expect(source).toMatch(/ir_cool="norm"; spin_switch="norm";/)
  })
})
