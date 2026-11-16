// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

// The core's position is the jet's centre of mass, which its fuel and stores
// move about the datum its airframe is drawn and placed from (#188): placed at
// the datum's stance, a loaded jet fell the 0.2 m its stores pull the centre
// below the datum, and its drawn tyres sat 11-28 cm into the deck.
// engine.ts cannot be imported (WebGL at module scope), so datum() is lifted
// from its source and the wiring is asserted against it.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
const start = source.indexOf('const _datum=')
const end = source.indexOf('\n', source.indexOf('function datum(') + 1)
const datum = new Function('THREE', 'world_up', `${source.slice(start, source.indexOf('\n', end + 1))}; return datum;`)(
  THREE,
  new THREE.Vector3(0, 1, 0)
) as (st: object) => THREE.Vector3

const jet = (pitch: number, center?: THREE.Vector3) => {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), pitch)
  return {
    pos: new THREE.Vector3(10, 2.4, -3),
    fwd: new THREE.Vector3(1, 0, 0).applyQuaternion(q),
    up: new THREE.Vector3(0, 1, 0).applyQuaternion(q),
    right: new THREE.Vector3(0, 0, 1).applyQuaternion(q),
    center,
    q,
  }
}

describe('datum', () => {
  it('is the position less the attitude-turned centre of mass', () => {
    const center = new THREE.Vector3(-0.08, -0.21, 0.01)
    for (const pitch of [0, 0.3, -0.5]) {
      const st = jet(pitch, center)
      const want = st.pos.clone().sub(center.clone().applyQuaternion(st.q))
      expect(datum(st).distanceTo(want)).toBeLessThan(1e-12)
    }
  })

  it('is the position for a jet with no centre (another player, drawn from the datum the server packs)', () => {
    const st = jet(0.2)
    expect(datum(st).toArray()).toEqual(st.pos.toArray())
  })
})

describe('datum wiring', () => {
  it('reads the centre from the core tail after the instruments', () => {
    // flight.ts pulls in the UI kit, so its layout is read as text too: the
    // three words follow the spin display's, where wasm/main.go emits them
    const flight = readFileSync(fileURLToPath(new URL('./flight.ts', import.meta.url)), 'utf8')
    expect(flight).toMatch(/\n  spin: 131,[^\n]*\n  center: 132,[^\n]*\n  rest: 135,/)
    expect(flight).toMatch(/\nconst EXTRA = 13\n/)
    expect(source).toMatch(/ownship\.center\?\?=new THREE\.Vector3\(\)\)\.set\(out\[STATE\.center\]/)
    expect(source.match(/bandit\.center\?\?=new THREE\.Vector3\(\)\)\.set\(w\[STATE\.center\]/g)?.length).toBe(2)
  })

  it('draws every jet group at its datum, never at the centre of mass', () => {
    expect(source).not.toMatch(/group\.position\.copy\(ownship\.pos\)/)
    expect(source).not.toMatch(/bandit\.group\.position\.copy\(bandit\.pos\)/)
    expect(source).toMatch(/function presented\(st\)\{ const at=datum\(st\);/)
  })

  it('places a spawn by its datum and hands the core the centre of mass', () => {
    const push = source.slice(source.indexOf('function flight_push()'), source.indexOf('function verdict('))
    // the air starts seat after the loadout goes on, the ground start after the state that weighs the tanks
    expect(push.match(/flight_stores\(own_mask\(\)\); seated\(\);/g)?.length).toBe(2)
    // the ground start stands on the core's rest, then seats: the rest's pitch turns the centre too
    expect(push).toMatch(/flight_set\(b\);[^\n]*\n\tif\(ownship\.speed<1&&rested\(\)\)[^\n]*\n\tseated\(\); b\[STATE\.position\]=ownship\.pos\.x;/)
  })
})

// A clean jet's constant stance put a loaded one 3 cm high, and it sank as
// its struts took the weight: a ground spawn stands where the core rests it.
describe('rested', () => {
  const from = source.indexOf('const _level=')
  const to = source.indexOf('\treturn true; }', from) + '\treturn true; }'.length
  const lift = (ground: number, words: Record<number, number>, fwd: THREE.Vector3) => {
    const ownship = { pos: new THREE.Vector3(4, 99, -7), fwd: fwd.clone(), q: new THREE.Quaternion() }
    const STATE = { rest: 135 }
    const out: number[] = []
    for (const [k, v] of Object.entries(words)) out[Number(k)] = v
    const rested = new Function('THREE', 'world_up', 'ownship', 'STATE', 'ground_height', 'flight_get', `${source.slice(from, to)}; return rested;`)(
      THREE,
      new THREE.Vector3(0, 1, 0),
      ownship,
      STATE,
      () => ground,
      () => out
    ) as () => boolean
    return { ok: rested(), ownship }
  }

  it('puts the datum at the rest height over the surface, pitched as the rest has it, the heading kept', () => {
    const heading = new THREE.Vector3(0.6, 0, -0.8)
    const { ok, ownship } = lift(19.5, { 135: 2.54, 136: 0.0065 }, heading)
    expect(ok).toBe(true)
    expect(ownship.pos.y).toBeCloseTo(22.04, 12)
    expect(Math.asin(ownship.fwd.y)).toBeCloseTo(0.0065, 12)
    expect(new THREE.Vector3(ownship.fwd.x, 0, ownship.fwd.z).normalize().distanceTo(heading)).toBeLessThan(1e-12)
    // the attitude carries the body's nose along that line, its wings level
    expect(new THREE.Vector3(1, 0, 0).applyQuaternion(ownship.q).distanceTo(ownship.fwd)).toBeLessThan(1e-12)
    expect(new THREE.Vector3(0, 0, 1).applyQuaternion(ownship.q).y).toBeCloseTo(0, 12)
  })

  it('leaves the spawn alone over the sea or before the core reports a rest', () => {
    expect(lift(-1e9, { 135: 2.54 }, new THREE.Vector3(1, 0, 0)).ok).toBe(false)
    const { ok, ownship } = lift(3.5, {}, new THREE.Vector3(1, 0, 0))
    expect(ok).toBe(false)
    expect(ownship.pos.y).toBe(99)
  })
})
