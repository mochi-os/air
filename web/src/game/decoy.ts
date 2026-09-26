// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
// A heater's flare roll: the chance a flare seduces the seeker, and where a
// seduced seeker then looks. Lifted out of the engine so it can be typed and
// tested, as seeker.ts was. It mirrors the server's seduction()
// (world/games/air/air.go), so single player and multiplayer judge a flare by
// one rule.
//
// Everything here is the TARGET's: its aspect to the round, its burner, the
// flare it dropped. The roll used to read the bandit whoever the target was,
// so the bandit's heaters judged the player's flares from the bandit itself:
// a round is always ahead of the jet that fired it, so every flare got the
// front-aspect chance, the player's burner never counted, and a seduced round
// turned back toward the point below its own launcher.
import type { Vector } from './seeker'

// The 9M's counter-countermeasures: a flare works this fraction as often
// (flare_reject on the server). A seduced seeker chases a point this many
// metres below the jet, where the flare falls.
export const FLARE = { reject: 0.55, drop: 30 }

// decoy_aspect is how far behind the target the round sits: 1 dead astern,
// 0 abeam or ahead. separation is the round's position less the target's,
// taken the short way across the world wrap; nose is the target's forward
// unit vector.
export function decoy_aspect(separation: Vector, nose: Vector): number {
  const distance = Math.hypot(separation.x, separation.y, separation.z) || 1
  const behind =
    -(separation.x * nose.x + separation.y * nose.y + separation.z * nose.z) /
    distance
  return Math.min(1, Math.max(0, behind))
}

// decoy_chance is one roll's odds: a flare seduces a round from the front more
// easily than from the tail, and half as often when the target's burner is
// lit, the brightest thing in the seeker's view. lit is the target's achieved
// reheat, 0..1.
export function decoy_chance(tail: number, lit: number): number {
  const aspect = Math.min(1, Math.max(0, tail))
  const chance = (0.35 + 0.4 * (1 - aspect)) * FLARE.reject
  return lit > 0.05 ? chance * 0.5 : chance
}

// decoy_lure is the point a seduced seeker chases: below the target that
// dropped the flare.
export function decoy_lure(target: Vector): Vector {
  return { x: target.x, y: target.y - FLARE.drop, z: target.z }
}
