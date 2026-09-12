// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { beforeEach, describe, expect, it } from 'vitest'
import { audio_explosion, BLAST_REACH } from './audio'

// audio.ts logs every play INTENT to globalThis.dev_sounds before it looks at
// the AudioContext, precisely so the decision can be tested where no context
// exists — the same surface firecheck.py and gearcheck.py assert against. So
// these run without a browser: what is under test is which sounds a burst at a
// given range asks for, which is where #192 lived.
const sounded = (distance: number) => {
  const log: string[] = []
  ;(globalThis as unknown as { dev_sounds: string[] }).dev_sounds = log
  audio_explosion(distance, 0, 0, 0)
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
