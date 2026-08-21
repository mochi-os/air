// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The single-player menace wire: every round in the air, declared to the
// bandit's brain once a frame. The client flies the rounds, so it is the only
// source of truth the brain has for them.

export const MENACE_STRIDE = 8 // words per round
export const MENACE_MOST = 56 // seven rounds; the brain needs the picture, not the census

// Phase sentinels for the eighth word. A radar round carries its real guidance
// phase (0 and up); a heater has none, so the slot carries its fate instead.
export const MENACE_HEATER = -1 // still guiding
export const MENACE_BEATEN = -2 // seduced onto a flare, or gimballed off and ballistic

export interface Round {
  active?: boolean
  enemy?: boolean
  target?: unknown
  kind?: string
  phase?: number
  loose?: boolean
  blind?: number
  px: number
  py: number
  pz: number
  vx: number
  vy: number
  vz: number
}

// phase names what the eighth word says about this round. BEATEN is
// load-bearing: the stubs the brain builds from this wire carry loose/blind at
// zero, so without it the bandit breaks for every round the player's flares
// have already defeated.
export function phase(round: Round): number {
  if (round.kind === '120c') return round.phase ?? 0
  return round.loose || (round.blind ?? 0) > 0 ? MENACE_BEATEN : MENACE_HEATER
}

// words builds the declaration: position, velocity, shooter (0 the player, 1
// the bandit), phase. Only rounds that concern the bandit are declared — its
// own, and the player's aimed at it.
export function words(rounds: Round[], bandit: unknown, most: number = MENACE_MOST): number[] {
  const out: number[] = []
  for (const round of rounds) {
    if (!round.active) continue
    if (round.target !== bandit && !round.enemy) continue
    if (out.length >= most) break
    out.push(round.px, round.py, round.pz, round.vx, round.vy, round.vz, round.enemy ? 1 : 0, phase(round))
  }
  return out
}
