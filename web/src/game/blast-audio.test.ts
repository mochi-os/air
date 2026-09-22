// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { beforeEach, describe, expect, it } from 'vitest'
import { audio_explosion, blast_level, blast_shape, BLAST_REACH, NEAR } from './audio'

// audio.ts logs every play INTENT to globalThis.dev_sounds before it looks at
// the AudioContext, precisely so the decision can be tested where no context
// exists — the same surface firecheck.py and gearcheck.py assert against. So
// these run without a browser: what is under test is which sounds a burst at a
// given range asks for, which is where #192 lived.
const sounded = (distance: number, muffled = false) => {
  const log: string[] = []
  ;(globalThis as unknown as { dev_sounds: string[] }).dev_sounds = log
  audio_explosion(distance, 0, 0, 0, muffled)
  return log
}

describe('a detonation is heard at the range it carries', () => {
  beforeEach(() => {
    delete (globalThis as unknown as { dev_sounds?: string[] }).dev_sounds
  })

  it('cracks and thumps through the airframe up close', () => {
    // Inside 150 m the blast is felt as well as heard: the structure-borne
    // thump rides the aircraft bus, which is why it should have been audible
    // even when the weapons bus was the suspect.
    expect(sounded(20)).toEqual(['explosion', 'hit'])
  })

  it('is heard without the thump at a distance', () => {
    expect(sounded(400)).toEqual(['explosion'])
  })

  it('is still heard past the old 700 m gate', () => {
    // The whole of #192: every one of these was silent, and in a missile fight
    // almost every burst is further out than 700 m.
    for (const distance of [701, 1200, 2500, 4000]) {
      expect(sounded(distance), `${distance} m`).toEqual(['explosion'])
    }
  })

  it('goes quiet only beyond the reach it declares', () => {
    expect(sounded(BLAST_REACH - 1)).toEqual(['explosion'])
    expect(sounded(BLAST_REACH + 1)).toEqual([])
  })

  // The level a burst plays at. Close bursts already peak at the limiter, so
  // they stay where they are; far ones were too quiet on headphones.
  const decibels = (distance: number) => 20 * Math.log10(blast_level(distance) / NEAR)

  it('holds the near field at the level a close burst can carry', () => {
    for (const distance of [0, 9, 50, 150]) expect(blast_level(distance), `${distance} m`).toBe(NEAR)
  })

  it('is heard well at the ranges a missile fight is fought at', () => {
    expect(decibels(600)).toBeGreaterThan(-9) // was -11.5 dB
    expect(decibels(3000)).toBeGreaterThan(-20) // was -26.5 dB
  })

  it('is never louder further away', () => {
    for (let distance = 0; distance < BLAST_REACH; distance += 50)
      expect(blast_level(distance + 50), `${distance + 50} m`).toBeLessThanOrEqual(blast_level(distance))
  })

  it('reaches far enough to cover a fight', () => {
    // A gate this cue can hide behind is the defect, so the number is asserted
    // rather than left to whatever the constant happens to say.
    expect(BLAST_REACH).toBeGreaterThanOrEqual(3000)
  })
})

// A heater fused 9 m off the canopy and the pilot it killed heard a crash with
// no crack (recording 01a0c91b, 2026-09-22): the buffer was a low rumble with
// 30 ms of noise on the front, and the jet's own fireball then played the same
// buffer again over it. These pin the repair: the crack carries the buffer,
// and the jet's own death is muffled.
const RATE = 48000

// A seeded noise source in Math.random's place, so every buffer here is the
// same run to run, and a claim is checked across many draws rather than one.
function seeded(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1)

const shaped = (seed: number) => {
  const data = new Float32Array(Math.ceil(RATE * 2.2))
  blast_shape(data, RATE, seeded(seed))
  return data
}

// The buffer as it stood before the crack was reshaped: 30 ms of noise at 1.2
// over the rumble at 3.2. Drawn from the same noise, it is the reference a
// distant burst must not fall below.
const original = (seed: number) => {
  const data = new Float32Array(Math.ceil(RATE * 2.2))
  const random = seeded(seed)
  const decay = (i: number, t: number) => Math.exp(-i / (RATE * t))
  let last = 0
  for (let i = 0; i < data.length; i++) {
    const white = random() * 2 - 1
    if (i < RATE * 0.03) data[i] += white * decay(i, 0.012) * 1.2
    last = (last + 0.03 * white) / 1.03
    data[i] += last * 3.2 * decay(i, 0.7)
  }
  return data
}

const energy = (data: Float32Array, from: number, to: number) => {
  let sum = 0
  for (let i = from; i < to; i++) sum += data[i] * data[i]
  return sum
}

describe('a warhead beside the canopy is a crack, not a crash', () => {
  beforeEach(() => {
    delete (globalThis as unknown as { dev_sounds?: string[] }).dev_sounds
  })

  it('carries its energy in the first 80 ms', () => {
    // The whole defect: the rumble used to hold six times the crack's energy.
    const window = Math.floor(RATE * 0.08)
    for (const seed of SEEDS) {
      const data = shaped(seed)
      const crack = energy(data, 0, window)
      let later = 0
      for (let from = window; from + window <= data.length; from += window)
        later = Math.max(later, energy(data, from, from + window))
      expect(crack, `seed ${seed}`).toBeGreaterThan(later * 3)
    }
  })

  it('peaks inside the crack', () => {
    for (const seed of SEEDS) {
      const data = shaped(seed)
      let at = 0
      let peak = 0
      for (let i = 0; i < data.length; i++)
        if (Math.abs(data[i]) > peak) {
          peak = Math.abs(data[i])
          at = i
        }
      expect(at, `seed ${seed}`).toBeLessThan(RATE * 0.08)
      expect(peak, `seed ${seed}`).toBeLessThan(2.5) // and stays inside the mix's headroom at the near-field level of 1.4
    }
  })

  it('is no quieter far away than it was', () => {
    // Past 150 m the play-time lowpass strips the crack, so a distant burst is
    // the rumble after it. Cutting that rumble to make room for the crack made
    // every far burst about 3 dB quieter on a small speaker, and nothing here
    // noticed: the rumble must carry at least what it always did.
    const after = Math.floor(RATE * 0.3)
    for (const seed of SEEDS) {
      const now = shaped(seed)
      const before = original(seed)
      expect(energy(now, after, now.length), `seed ${seed}`).toBeGreaterThan(
        0.98 * energy(before, after, before.length)
      )
    }
  })

  it("muffles the jet's own fireball", () => {
    // The burst that killed it has already cracked; the fireball is the rumble.
    expect(sounded(0, true)).toEqual(['explosion'])
  })
})
