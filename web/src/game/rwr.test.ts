// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { describe, expect, it } from 'vitest'
import { Rwr, NM, incoming, threats } from './rwr'

const wrap = (v: number) => v
const own = { x: 0, z: 0 }
const steady = () => 0 // no jitter: his sweep revisits every 2.2 s exactly

// An emitter 12 nmi due north, nose pointing south — straight at us: we sit on
// the axis of his scan cone.
const facing = {
  id: 3,
  x: 0,
  z: -12 * NM,
  nosex: 0,
  nosez: 1,
  mode: 1 as const,
  locked: false,
}

function run(rwr: Rwr, emitters: Parameters<Rwr['step']>[2], seconds: number) {
  let fresh = 0
  for (let i = 0; i < seconds * 60; i++)
    fresh += rwr.step(1 / 60, own, emitters, wrap, steady).fresh
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

// The third voice (#27 phase 2d): an active seeker. The Hornet has no
// missile warner and the AIM-120's motor is reduced-smoke, so the launch
// itself is silent — the receiver learns of the shot when the round's OWN
// radar wakes and starts painting.
describe('missile warning', () => {
  it('an active seeker raises MISSILE, distinct from a lock', () => {
    const rwr = new Rwr()
    const seeker = [{ id: 'm1', x: 0, z: -6 * NM }]
    expect(rwr.warned()).toBe(false)
    const first = rwr.step(1 / 60, own, [], wrap, steady, seeker)
    expect(first.fresh).toBe(1) // one chirp as the symbol appears
    expect(first.missile).toBe(true)
    expect(rwr.warned()).toBe(true)
    const contact = rwr.contacts.find((c) => c.id === 'm1')
    expect(contact?.missile).toBe(true)
    expect(contact?.locked).toBe(true) // continuous, like an STT — it is staring at us
  })

  it('goes quiet when the seeker stops painting — the round is gone or blind', () => {
    const rwr = new Rwr()
    rwr.step(1 / 60, own, [], wrap, steady, [{ id: 'm1', x: 0, z: -6 * NM }])
    expect(rwr.warned()).toBe(true)
    for (let i = 0; i < 90; i++) rwr.step(1 / 60, own, [], wrap, steady) // 1.5 s of silence
    expect(rwr.warned()).toBe(false)
  })

  // The single-player feed: the bandit's rounds, judged as the server's bots
  // judge them. We fly north at 250 m/s; a round 6 nmi ahead flies south at 900.
  const jet = { x: 0, y: 5000, z: 0, vx: 0, vy: 0, vz: -250 }
  const ahead = { x: 0, y: 5000, z: -6 * NM, vx: 0, vy: 0, vz: 900 }
  it('a round whose seeker is awake and still closing is incoming', () => {
    expect(incoming(1, ahead, jet, wrap)).toBe(true) // active
    expect(incoming(2, ahead, jet, wrap)).toBe(true) // pitbull
  })
  it('a round that has gone by is not, whatever its seeker', () => {
    const past = { ...ahead, z: 2000 } // 2 km behind us, still flying south
    expect(incoming(1, past, jet, wrap)).toBe(false)
    expect(incoming(3, past, jet, wrap)).toBe(false) // loose: ballistic after the miss
  })
  it('a round still in midcourse is silent: its own radar is not on yet', () => {
    expect(incoming(0, ahead, jet, wrap)).toBe(false)
  })
  it('judges the closure relative to us: a round we outrun is not closing', () => {
    const chasing = { x: 0, y: 5000, z: 3000, vx: 0, vy: 0, vz: -200 } // behind us, slower than we fly
    expect(incoming(1, chasing, jet, wrap)).toBe(false)
    expect(incoming(1, { ...chasing, vz: -400 }, jet, wrap)).toBe(true)
  })
  it('measures the line across the wrap seam', () => {
    const W = 250000
    const seam = (v: number) => v - W * Math.round(v / W)
    const near = { ...jet, z: -W / 2 + 1000 } // just short of the seam, flying north toward it
    const beyond = { ...ahead, z: W / 2 - 5000 } // 6 km ahead of us across the seam, flying south
    expect(incoming(1, beyond, near, seam)).toBe(true)
  })

  it("feeds the receiver the bandit's incoming rounds from the pool, and nothing else", () => {
    const round = (slot: number, more: object) => ({
      slot,
      active: true,
      enemy: true,
      phase: 1,
      px: 0,
      py: 5000,
      pz: -6 * NM,
      vx: 0,
      vy: 0,
      vz: 900,
      ...more,
    })
    const pool = [
      round(0, {}), // the bandit's, awake and closing
      round(1, { pz: 2000 }), // the bandit's, gone by
      round(2, { enemy: false }), // ours
      round(3, { active: false }), // an idle pool slot
      round(4, { phase: undefined }), // a heater: no seeker phase
    ]
    expect(threats(pool, jet, wrap)).toEqual([
      { id: 'bandit-round-0', x: 0, z: -6 * NM },
    ])
  })
  it('the warning clears once the round has gone by', () => {
    const rwr = new Rwr()
    const round = {
      slot: 0,
      active: true,
      enemy: true,
      phase: 2,
      px: 0,
      py: 5000,
      pz: -1000,
      vx: 0,
      vy: 0,
      vz: 900,
    }
    rwr.step(1 / 60, own, [], wrap, steady, threats([round], jet, wrap))
    expect(rwr.warned()).toBe(true)
    const past = { ...round, phase: 3, pz: 1500 } // through the fuse window and out behind us, ballistic
    for (let i = 0; i < 90; i++)
      rwr.step(1 / 60, own, [], wrap, steady, threats([past], jet, wrap))
    expect(rwr.warned()).toBe(false)
  })

  it('a lock alone is never a missile warning', () => {
    const rwr = new Rwr()
    rwr.step(1 / 60, own, [{ ...facing, mode: 2, locked: true }], wrap, steady)
    expect(rwr.locked()).toBe(true)
    expect(rwr.warned()).toBe(false)
  })
})
