// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { describe, expect, it } from 'vitest'
import { Rwr, NM } from './rwr'

const wrap = (v: number) => v
const own = { x: 0, z: 0 }
const steady = () => 0 // no jitter: his sweep revisits every 2.2 s exactly

// An emitter 12 nmi due north, nose pointing south — straight at us: we sit on
// the axis of his scan cone.
const facing = { id: 3, x: 0, z: -12 * NM, nosex: 0, nosez: 1, mode: 1 as const, locked: false }

function run(rwr: Rwr, emitters: Parameters<Rwr['step']>[2], seconds: number) {
  let fresh = 0
  for (let i = 0; i < seconds * 60; i++) fresh += rwr.step(1 / 60, own, emitters, wrap, steady).fresh
  return fresh
}

describe('search paints', () => {
  it('are periodic — his sweep, not a steady stare', () => {
    const rwr = new Rwr()
    const fresh = run(rwr, [facing], 9)
    // paints at 0, 2.2, 4.4, 6.6, 8.8 — five crossings, ONE symbol, ONE chirp
    expect(rwr.paints).toBe(5)
    expect(rwr.contacts.length).toBe(1)
    expect(fresh).toBe(1)
    expect(rwr.contacts[0].bearing).toBeCloseTo(0, 5) // due north
    expect(rwr.contacts[0].locked).toBe(false)
  })
  it('silence outside his scan cone — a radar pointed away cannot light us', () => {
    const rwr = new Rwr()
    const away = { ...facing, nosez: -1 } // nose north: we are behind him
    run(rwr, [away], 9)
    expect(rwr.paints).toBe(0)
    expect(rwr.contacts.length).toBe(0)
  })
  it('silence beyond the listening range', () => {
    const rwr = new Rwr()
    const far = { ...facing, z: -70 * NM }
    run(rwr, [far], 5)
    expect(rwr.paints).toBe(0)
  })
})

describe('lock', () => {
  it('an STT on us is continuous, one chirp on appearance', () => {
    const rwr = new Rwr()
    const stt = { ...facing, mode: 2 as const, locked: true }
    const fresh = run(rwr, [stt], 2)
    expect(fresh).toBe(1)
    expect(rwr.locked()).toBe(true)
    expect(rwr.time - rwr.contacts[0].at).toBeLessThan(0.05) // painted this frame, not periodically
  })
  it('an STT on someone else is silence', () => {
    const rwr = new Rwr()
    const other = { ...facing, mode: 2 as const, locked: false }
    run(rwr, [other], 5)
    expect(rwr.contacts.length).toBe(0)
  })
  it('a broken lock demotes to periodic paints without a fresh chirp', () => {
    const rwr = new Rwr()
    run(rwr, [{ ...facing, mode: 2 as const, locked: true }], 1)
    const fresh = run(rwr, [facing], 1)
    expect(fresh).toBe(0) // same symbol, quieter life
    expect(rwr.contacts[0].locked).toBe(false)
    expect(rwr.locked()).toBe(false)
  })
})

describe('aging', () => {
  it('a contact whose paints stop ages off the ring', () => {
    const rwr = new Rwr()
    run(rwr, [facing], 1)
    expect(rwr.contacts.length).toBe(1)
    run(rwr, [], 9)
    expect(rwr.contacts.length).toBe(0)
  })
  it('a re-appearing threat chirps again', () => {
    const rwr = new Rwr()
    run(rwr, [facing], 1)
    run(rwr, [], 9) // gone
    const fresh = run(rwr, [facing], 1)
    expect(fresh).toBe(1)
  })
})
