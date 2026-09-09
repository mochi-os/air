// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { describe, expect, it } from 'vitest'
import { demise, opponent, report } from './fate'

// Reported from live testing: shot down twice by the bandit's missiles, nowhere
// near the ground, and the banner read CRASHED both times. The engine knew - it
// records the cause and writes it to the recording - and then showed the pilot
// the one word that contradicted it.
describe('demise', () => {
  it('names the killer for every battle-damage death', () => {
    for (const fate of ['missile', 'fire', 'pilot', 'battle']) {
      expect(demise(fate, 'BANDIT', false)).toEqual({ text: 'DESTROYED BY {callsign}', callsign: 'BANDIT' })
    }
  })

  it('names the other aircraft in a midair', () => {
    expect(demise('midair', 'BANDIT', false)).toEqual({ text: 'COLLIDED WITH {callsign}', callsign: 'BANDIT' })
  })

  it('still says what happened when nobody is credited', () => {
    // Multiplayer: the server credits a kill to the last player to damage you
    // within a minute, so a longer fire is nobody's. The banner must not read
    // "DESTROYED BY " with an empty name.
    expect(demise('fire', '', false)).toEqual({ text: 'DESTROYED' })
    expect(demise('battle', '', false)).toEqual({ text: 'DESTROYED' })
    expect(demise('midair', '', false)).toEqual({ text: 'COLLIDED' })
  })

  it('calls flying into something a crash, killer or not', () => {
    for (const fate of ['sea', 'building', 'post', 'island', 'probe', 'verdict', 'nonesuch']) {
      expect(demise(fate, 'BANDIT', false)).toEqual({ text: 'CRASHED' })
    }
  })

  it('treats an unset fate as a crash rather than inventing a killer', () => {
    expect(demise(undefined, 'BANDIT', false)).toEqual({ text: 'CRASHED' })
  })

  it('reports an ejection as an ejection whatever ended the jet', () => {
    // The seat fires before the airframe is gone, so a fate is usually set too.
    for (const fate of ['missile', 'sea', 'midair', undefined]) {
      expect(demise(fate, 'BANDIT', true)).toEqual({ text: 'EJECTED' })
    }
  })
})

// The comms-log feed. The "KILL" banner is easy to miss when busy, and then
// nothing on screen says where the bandit went; these lines merge into the chat
// log and outlive it.
describe('report', () => {
  it('names both aircraft when someone is credited', () => {
    expect(report('battle', 'NUMAN', 'CHRIS')).toEqual({
      text: '{killer} destroyed {victim}',
      values: { killer: 'NUMAN', victim: 'CHRIS' },
    })
  })

  it('accepts every battle fate the banner does', () => {
    for (const fate of ['missile', 'fire', 'pilot', 'battle']) {
      expect(report(fate, 'NUMAN', 'CHRIS')?.text).toBe('{killer} destroyed {victim}')
    }
  })

  it('reports an uncredited death as a crash', () => {
    // Multiplayer: the server credits the last player to damage the victim
    // within a minute and says nothing when nobody qualifies. Naming a killer
    // there would be an invention.
    expect(report('battle', '', 'CHRIS')).toEqual({ text: '{victim} crashed', values: { victim: 'CHRIS' } })
  })

  it('calls flying into something a crash even when someone shot at you', () => {
    for (const fate of ['sea', 'building', 'post', 'island', 'probe', 'verdict']) {
      expect(report(fate, 'NUMAN', 'CHRIS')).toEqual({ text: '{victim} crashed', values: { victim: 'CHRIS' } })
    }
  })

  it('names both jets in a midair', () => {
    expect(report('midair', 'BANDIT', 'CHRIS')).toEqual({
      text: '{victim} collided with {other}',
      values: { victim: 'CHRIS', other: 'BANDIT' },
    })
  })

  it('says nothing at all when the victim has no name', () => {
    // A roster entry that has not arrived must not print " crashed".
    expect(report('battle', 'NUMAN', '')).toBeNull()
    expect(report('sea', '', '')).toBeNull()
  })
})

describe('opponent', () => {
  it('reads the bandit verdict as the kill it is', () => {
    // The same token on the ownship is a wrecked landing, and stays a crash.
    expect(report(opponent('verdict'), 'CHRIS', 'BANDIT')?.text).toBe('{killer} destroyed {victim}')
    expect(report('verdict', 'CHRIS', 'CHRIS')?.text).toBe('{victim} crashed')
  })

  it('leaves every other fate alone', () => {
    for (const fate of ['sea', 'building', 'post', 'island', 'fire', 'midair', undefined]) {
      expect(opponent(fate)).toBe(fate)
    }
  })
})
