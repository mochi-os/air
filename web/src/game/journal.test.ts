// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { describe, expect, it } from 'vitest'
import { acmi, type Sample } from './acmi'
import { journal_notes, journal_parse, type Journal } from './journal'

const drained: Journal = {
  decisions: [
    {
      tick: 5412,
      play: 'high',
      scores: { press: 0.3981, high: 0.4122, lag: 0.371 },
      horizon: 12,
      intent: 'convert',
      promise: 0.0312,
    },
  ],
  forecasts: [
    { tick: 5172, subject: 'his', span: 4, error: 84.4 },
    { tick: 5172, subject: 'own', span: 2, error: 11.6 },
  ],
  bypasses: [{ tick: 7440, name: 'rebuild', speed: 97.2, gate: 109.1 }],
  demand: { law: 7.5, corner: 5.484, capped: 2.618, stick: 0.2487 },
}

describe('the decision journal crosses into the recording', () => {
  it('lists the candidates best first, so the winner and its margin lead', () => {
    const notes = journal_notes(drained)
    expect(notes.decision).toBe(
      '5412|high|12|convert|0.031|high:0.412/press:0.398/lag:0.371'
    )
  })

  it('carries who was forecast, how far ahead, and how wrong', () => {
    expect(journal_notes(drained).forecast).toBe('5172|his|4|84;5172|own|2|12')
  })

  it('carries the numbers that tripped a bypass', () => {
    expect(journal_notes(drained).bypass).toBe('7440|rebuild|97|109')
  })

  it('carries the demand at every stage between the law and the stick', () => {
    expect(journal_notes(drained).demand).toBe('7.5|5.48|2.62|0.249')
  })

  it('writes no event channel when nothing happened, but always the demand', () => {
    const quiet = journal_notes({
      decisions: null,
      forecasts: null,
      bypasses: null,
      demand: drained.demand,
    })
    expect(quiet.decision).toBeUndefined()
    expect(quiet.forecast).toBeUndefined()
    expect(quiet.bypass).toBeUndefined()
    expect(quiet.demand).toBe('7.5|5.48|2.62|0.249')
  })

  it('names the novice posture rather than leaving the field empty', () => {
    // An empty field between two pipes reads as a parse error to a human and
    // shifts every column for a naive splitter.
    const notes = journal_notes({
      ...drained,
      decisions: [{ ...drained.decisions![0], intent: '' }],
    })
    expect(notes.decision).toContain('|neutral|')
  })

  it('uses no comma, which the recorder would turn into a space', () => {
    const notes = journal_notes(drained)
    for (const value of Object.values(notes)) expect(value).not.toContain(',')
  })

  it('treats a malformed or empty payload as no journal at all', () => {
    // An instrument must never be able to take the recorder down with it.
    expect(journal_parse('')).toBeNull()
    expect(journal_parse('{not json')).toBeNull()
    expect(journal_parse('{"decisions":[]}')).toBeNull() // no demand: not a journal
    expect(journal_parse(JSON.stringify(drained))).toEqual(drained)
  })

  it('reads Go nil slices as nothing', () => {
    const parsed = journal_parse(
      '{"decisions":null,"forecasts":null,"bypasses":null,"demand":{"law":1,"corner":1,"capped":1,"stick":0}}'
    )
    expect(parsed).not.toBeNull()
    expect(journal_notes(parsed!).decision).toBeUndefined()
  })
})

describe('the recorder writes the journal channels', () => {
  const bandit = (
    notes: ReturnType<typeof journal_notes>
  ): Sample['objects'][number] => ({
    id: 2,
    x: 0,
    y: 1000,
    z: 0,
    roll: 0,
    pitch: 0,
    yaw: 0,
    name: 'FA-18C',
    label: 'Bandit',
    colour: 'Red',
    kind: 'Air+FixedWing',
    data: { rounds: 578, ...notes },
  })
  const flown = (samples: ReturnType<typeof journal_notes>[]) =>
    acmi(
      samples.map((notes, n) => ({ time: n * 0.1, objects: [bandit(notes)] })),
      new Date(0),
      't'
    )
      .split('\n')
      .filter((l) => l.startsWith('2,T='))

  it('emits every event once and the demand only when it moves', () => {
    const first = journal_notes(drained)
    const still = { demand: first.demand } // nothing new, same stack
    const moved = { demand: '7.5|5.1|2.4|0.231' }
    const mine = flown([first, still, moved])
    expect(mine[0]).toContain(
      'Decision=5412|high|12|convert|0.031|high:0.412/press:0.398/lag:0.371'
    )
    expect(mine[0]).toContain('Forecast=5172|his|4|84;5172|own|2|12')
    expect(mine[0]).toContain('Bypass=7440|rebuild|97|109')
    expect(mine[0]).toContain('Demand=7.5|5.48|2.62|0.249')
    expect(mine[1]).not.toContain('Decision=')
    expect(mine[1]).not.toContain('Demand=') // unchanged: suppressed like every other channel
    expect(mine[2]).toContain('Demand=7.5|5.1|2.4|0.231')
    expect(mine[2]).not.toContain('Decision=')
  })

  it('emits a second decision even when the play is the same', () => {
    // The tick leads the value, so re-choosing the same play is still a new
    // string. Without that the delta encoding would swallow every re-plan that
    // kept the incumbent, which is most of them.
    const again = journal_notes({
      ...drained,
      decisions: [{ ...drained.decisions![0], tick: 5508 }],
    })
    const mine = flown([journal_notes(drained), again])
    expect(mine[1]).toContain('Decision=5508|high|')
  })
})
