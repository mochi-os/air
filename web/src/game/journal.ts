// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The bandit's decision journal, as the flight recorder carries it. The Go
// brain drains what its arbiter weighed at each re-plan, the forecast errors
// that have come due, the bypasses that pre-empted it, and the g it asked for at
// each stage between the play and the stick (world/games/air/journal.go). This
// turns one drain into the four developer-only ACMI channels.
//
// Decision, Forecast and Bypass are EVENTS riding a delta-encoded format: each
// value opens with the brain's tick, so two events are never the same string
// and the writer's change detection emits every one. A reader takes each
// distinct value once. Separators avoid the comma, which field() would strip.

export interface Decision {
  tick: number
  play: string
  scores: Record<string, number>
  horizon: number
  intent: string
  promise: number
}

export interface Forecast {
  tick: number
  subject: string // 'his': the opponent phantom; 'own': the winner's rehearsed track
  span: number // seconds of lookahead
  error: number // metres from where the subject really was
}

export interface Bypass {
  tick: number
  name: string
  speed: number
  gate: number
}

export interface Demand {
  law: number
  corner: number
  capped: number
  stick: number
}

export interface Journal {
  decisions: Decision[] | null
  forecasts: Forecast[] | null
  bypasses: Bypass[] | null
  demand: Demand
}

export interface Notes {
  decision?: string
  forecast?: string
  bypass?: string
  demand?: string
}

const fixed = (value: number, places: number): string => {
  const scaled = Math.round(value * 10 ** places) / 10 ** places
  return Number.isFinite(scaled) ? String(scaled) : '0'
}

// parse reads the wasm export's JSON. Anything malformed is simply no journal:
// an instrument must never be able to take the recorder down with it.
export function journal_parse(payload: string): Journal | null {
  if (!payload) return null
  try {
    const raw = JSON.parse(payload) as Partial<Journal>
    if (!raw || typeof raw !== 'object' || !raw.demand) return null
    return {
      decisions: raw.decisions ?? null,
      forecasts: raw.forecasts ?? null,
      bypasses: raw.bypasses ?? null,
      demand: raw.demand,
    }
  } catch {
    return null
  }
}

// notes renders one drain. Candidates are listed best first, so the winner
// leads and the margin it won by is the first thing a reader sees.
export function journal_notes(journal: Journal): Notes {
  const notes: Notes = {}
  if (journal.decisions?.length)
    notes.decision = journal.decisions
      .map((d) => {
        const ranked = Object.entries(d.scores ?? {})
          .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
          .map(([name, score]) => `${name}:${fixed(score, 3)}`)
          .join('/')
        return [
          d.tick,
          d.play,
          fixed(d.horizon, 1),
          d.intent || 'neutral',
          fixed(d.promise, 3),
          ranked,
        ].join('|')
      })
      .join(';')
  if (journal.forecasts?.length)
    notes.forecast = journal.forecasts
      .map((f) =>
        [f.tick, f.subject, fixed(f.span, 0), fixed(f.error, 0)].join('|')
      )
      .join(';')
  if (journal.bypasses?.length)
    notes.bypass = journal.bypasses
      .map((b) =>
        [b.tick, b.name, fixed(b.speed, 0), fixed(b.gate, 0)].join('|')
      )
      .join(';')
  const d = journal.demand
  notes.demand = [
    fixed(d.law, 2),
    fixed(d.corner, 2),
    fixed(d.capped, 2),
    fixed(d.stick, 3),
  ].join('|')
  return notes
}
