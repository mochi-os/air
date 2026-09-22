// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { beforeEach, describe, expect, it } from 'vitest'
import { audio_explosion, blast_shape, BLAST_REACH } from './audio'

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

const shaped = () => {
  const data = new Float32Array(Math.ceil(RATE * 2.2))
  blast_shape(data, RATE)
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
    const data = shaped()
    const window = Math.floor(RATE * 0.08)
    const crack = energy(data, 0, window)
    let later = 0
    for (let from = window; from + window <= data.length; from += window)
      later = Math.max(later, energy(data, from, from + window))
    expect(crack).toBeGreaterThan(later * 3)
  })

  it('peaks inside the crack', () => {
    const data = shaped()
    let at = 0
    let peak = 0
    for (let i = 0; i < data.length; i++)
      if (Math.abs(data[i]) > peak) {
        peak = Math.abs(data[i])
        at = i
      }
    expect(at).toBeLessThan(RATE * 0.08)
    expect(peak).toBeLessThan(2.5) // and stays inside the mix's headroom at the near-field level of 1.4
  })

  it("muffles the jet's own fireball", () => {
    // The burst that killed it has already cracked; the fireball is the rumble.
    expect(sounded(0, true)).toEqual(['explosion'])
  })
})
