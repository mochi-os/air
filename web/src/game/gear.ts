// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
// The landing gear's mechanisms in sequence (claude/plans/air-fa18c.md,
// Joints): a points file's gear joints each ride one mechanism's drive
// (gear.doors, gear.nose, gear.main: 0 stowed to 1 down), and its motion gear
// gives each mechanism's [from, to] share of the stroke's time each way, from
// the handle's move. Retracting, the nose leg leads, the mains follow and the
// doors close last (the take-off photos); extending, the doors open first and
// both legs fall together (DVIDS 781086). Each mechanism moves at its own
// steady pace once every one that started before it stands where it stood at
// its start, so a handle reversed mid-stroke turns each back from where it is.

export type Timeline = Record<'up' | 'down', Record<string, number[]>>
export type Mechanisms = Record<string, number>

const clamp = (v: number, low: number, high: number) => (v < low ? low : v > high ? high : v)

// settled returns each mechanism with the whole gear `down` of the way down
// along the retraction (tools/verify/model.py sequence): a gear drawn from one
// value, at its first sight or when set outright
export function settled(timeline: Timeline, down: number): Mechanisms {
  const gone = 1 - down
  const out: Mechanisms = {}
  for (const [name, [a, b]] of Object.entries(timeline.up)) out[name] = 1 - clamp((gone - a) / (b - a), 0, 1)
  return out
}

// advance moves each mechanism `seconds` of a gear whose whole stroke takes
// `stroke` seconds toward its down or stowed end, each that is free to start
export function advance(timeline: Timeline, state: Mechanisms, down: boolean, seconds: number, stroke: number): void {
  const line = timeline[down ? 'down' : 'up']
  const parts = Object.entries(line)
  for (const [name, [a, b]] of parts) {
    // the others started before this one, each where it stood at this one's start
    const free = parts.every(([other, [c, d]]) => {
      if (other === name || c >= a) return true
      const through = clamp((a - c) / (d - c), 0, 1)
      return down ? (state[other] ?? 0) >= through - 1e-9 : (state[other] ?? 1) <= 1 - through + 1e-9
    })
    if (!free) continue
    const step = seconds / ((b - a) * stroke)
    state[name] = down ? Math.min(1, (state[name] ?? 0) + step) : Math.max(0, (state[name] ?? 1) - step)
  }
}
