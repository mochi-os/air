// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The exterior's lenses (#262): each painted its glass's own colour unlit and
// lit in its own light's colour with that light, the position lights' red,
// green and white on the POSITION knob and the strobes' red as they flash;
// none of them with the FORMATION knob, as the strips are. engine.ts cannot be
// imported (WebGL at module scope), so its functions are read as text and run.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')

// The body of one top-level `function name(` up to the next one; '' when absent
function body(name: string): string {
  const start = source.indexOf(`\nfunction ${name}(`)
  if (start < 0) return ''
  const rest = source.slice(start + 1)
  const end = rest.slice(1).search(/\n(function \w+\(|\/\/ )/)
  return end < 0 ? rest : rest.slice(0, end + 1)
}
const table = /\nconst LENSES=\{[^\n]*\n/.exec(source)?.[0] ?? ''

class Material {
  emissive: unknown = null
  emissiveIntensity = 1
  constructor(public name: string) {}
  clone() {
    return new Material(this.name)
  }
}
class Color {
  constructor(public r: number, public g: number, public b: number) {}
}
type Lit = { position: Material[]; strobe: Material[] }

// lenses_own over an exterior: two LEX lenses sharing the port finish, the
// starboard, tail and strobe lenses, a formation strip and the paint
function own() {
  const shared = { port: new Material('port'), lights: new Material('lights'), paint: new Material('paint') }
  const meshes = [
    { isMesh: true, name: 'lamp_position_lex_left', material: shared.port },
    { isMesh: true, name: 'lamp_position_fold_left', material: shared.port },
    { isMesh: true, name: 'lamp_position_lex_right', material: new Material('starboard') },
    { isMesh: true, name: 'lamp_position_tail', material: new Material('tail') },
    { isMesh: true, name: 'lamp_strobe_left', material: [shared.paint, new Material('strobe')] },
    { isMesh: true, name: 'formation_fin_left', material: shared.lights },
  ]
  const e = { traverse: (f: (o: unknown) => void) => meshes.forEach(f) }
  const lenses = new Function('e', 'THREE', `${table}${body('lenses_own')} return lenses_own(e);`)(e, { Color }) as Lit
  return { lenses, meshes, shared }
}

// lenses_update on a jet, the player's own or another, by the panel, the time
// of day and the strobes' clock (sim_time in seconds)
function update(own: boolean, lights: boolean, panel: { position: number; strobe: string }, tod: string, time: number): [number, number] {
  const l = { position: [new Material('port')], strobe: [new Material('strobe')] }
  const ownship = { lights }
  new Function('g', 'own', 'ownship', 'exterior', 'cfg', 'sim_time', `${body('strobing')}${body('lenses_update')} lenses_update(g, own);`)(
    { userData: { lenses: l } }, own, ownship, panel, { tod }, time)
  return [l.position[0].emissiveIntensity, l.strobe[0].emissiveIntensity]
}

describe('the lenses on the exterior', () => {
  it('each take a copy of their finish, lit in their own light\'s colour and dark until lit', () => {
    const { lenses, meshes, shared } = own()
    expect(lenses.position.map((m) => m.name)).toEqual(['port', 'starboard', 'tail'])
    expect(lenses.strobe.map((m) => m.name)).toEqual(['strobe'])
    expect(lenses.position.map((m) => m.emissive)).toEqual([new Color(1, 0.125, 0.125), new Color(0.125, 1, 0.125), new Color(1, 1, 1)])
    expect(lenses.strobe[0].emissive).toEqual(new Color(1, 0.125, 0.125))
    expect([...lenses.position, ...lenses.strobe].map((m) => m.emissiveIntensity)).toEqual([0, 0, 0, 0])
    expect(meshes[0].material, 'one copy for every lens wearing the finish').toBe(meshes[1].material)
    expect(meshes[0].material).not.toBe(shared.port)
    expect((meshes[4].material as Material[])[1]).toBe(lenses.strobe[0])
    expect((meshes[4].material as Material[])[0], 'a lens\'s other finishes untouched').toBe(shared.paint)
  })

  it('leave the formation strips and the paint to the FORMATION knob and the paint', () => {
    const { meshes, shared } = own()
    expect(meshes[5].material).toBe(shared.lights)
  })

  it('light the player\'s position lenses at the POSITION knob\'s level under the master switch', () => {
    expect(update(true, true, { position: 1, strobe: 'off' }, 'day', 0.5)).toEqual([3, 0])
    expect(update(true, true, { position: 0.4, strobe: 'off' }, 'day', 0.5)[0]).toBeCloseTo(1.2)
    expect(update(true, false, { position: 1, strobe: 'bright' }, 'night', 0.03)).toEqual([0, 0])
  })

  it('flash the player\'s strobe lenses with the strobes, at a third on DIM and dark OFF', () => {
    expect(update(true, true, { position: 0, strobe: 'bright' }, 'day', 1.1 + 0.03)).toEqual([0, 3])
    expect(update(true, true, { position: 0, strobe: 'bright' }, 'day', 1.1 + 0.5)).toEqual([0, 0])
    expect(update(true, true, { position: 0, strobe: 'dim' }, 'day', 0.03)[1]).toBeCloseTo(1.05)
    expect(update(true, true, { position: 0, strobe: 'off' }, 'day', 0.03)).toEqual([0, 0])
  })

  it('light another jet\'s lenses at night only, whatever the player\'s own panel', () => {
    expect(update(false, false, { position: 0, strobe: 'off' }, 'night', 0.03)).toEqual([3, 3])
    expect(update(false, false, { position: 0, strobe: 'off' }, 'night', 0.5)).toEqual([3, 0])
    expect(update(false, true, { position: 1, strobe: 'bright' }, 'day', 0.03)).toEqual([0, 0])
  })

  it('are lit each frame on every jet, and disposed with the jet', () => {
    expect(source).toMatch(/g\.userData\.gearLamps=lamps; g\.userData\.lenses=lenses_own\(e\);/)
    expect(source).toMatch(/\n\tlenses_update\(g,st===ownship\);\n/)
    expect(body('jet_owned')).toMatch(/\.\.\.\(g\.userData\.lenses\?\[\.\.\.g\.userData\.lenses\.position,\.\.\.g\.userData\.lenses\.strobe\]:\[\]\)/)
  })
})
