// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The director gun solution: where this burst's rounds will arrive, pulled back
// by where the target will be, so that putting the pipper ON the target IS the
// deflection solution — and so the pipper tells the pilot the true nose angle
// to pull at any range.
//
// Three defects fixed 2026-08-17, each of which made it lie:
//
//   The span was CLAMPED at 2,000 m, so beyond that the solution was computed
//   for a target 2 km away however far away it actually was.
//
//   The time of flight came from an approximated closing speed with a 250 m/s
//   floor rather than from the drag law the rounds fly. At 1,315 m and 4 km
//   altitude that read 1.20 s against a true 1.47 s, and lead scales with it.
//
//   The round was modelled as a barrel component decaying under drag PLUS an
//   undragged inherited velocity. The real round decays as one vector, so the
//   split over-credited the inherited part — worth about 8 m at 800 m, which is
//   more than the gun's own dispersion.
//
// Quadratic drag on the whole velocity gives v(t) = v0/(1 + v0·t/L) along a
// fixed direction, so the round flies straight down its launch vector and slows,
// with gravity dropping it. That is what battle.Fly marches, and matching it is
// what makes pipper-on-target mean a hit.
//
// The pipper is deliberately NOT gated on the gun's reach: the ring and the
// shoot cue say whether a shot is worth taking, the pipper says where to point.

export const MUZZLE = 1050 // m/s at the barrel
export const LENGTH = 2600 // m, the round's drag length at sea level
export const GRAVITY = 9.8
export const LIFE = 2.0 // s a round stays dangerous, matching battle.Life

export interface Vector {
  x: number
  y: number
  z: number
}

const minus = (a: Vector, b: Vector): Vector => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const plus = (a: Vector, b: Vector): Vector => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z })
const scale = (a: Vector, k: number): Vector => ({ x: a.x * k, y: a.y * k, z: a.z * k })
const dot = (a: Vector, b: Vector): number => a.x * b.x + a.y * b.y + a.z * b.z
const size = (a: Vector): number => Math.hypot(a.x, a.y, a.z)
const unit = (a: Vector): Vector => scale(a, 1 / (size(a) || 1))

// length is the drag length at an altitude, on an 8.5 km density scale: thin air
// genuinely shoots further.
export function length(altitude: number): number {
  return LENGTH * Math.exp(Math.max(altitude, 0) / 8500)
}

// travel is how far a round launched at speed v0 has flown after t seconds.
export function travel(v0: number, t: number, altitude: number): number {
  const l = length(altitude)
  return l * Math.log1p((v0 * t) / l)
}

// flight inverts travel: how long to cover span at launch speed v0.
export function flight(span: number, v0: number, altitude: number): number {
  const l = length(altitude)
  return (l / Math.max(v0, 1)) * Math.expm1(Math.max(span, 0) / l)
}

// reach is how far a round gets before its life runs out — about 1,540 m at sea
// level from a standing start, further with the shooter's own speed behind it.
export function reach(altitude: number, v0: number = MUZZLE): number {
  return travel(v0, LIFE, altitude)
}

// launch is the round's initial velocity: the barrel plus the jet's own motion.
export function launch(bore: Vector, own: Vector): Vector {
  return plus(scale(bore, MUZZLE), own)
}

// timing solves how long the round is in the air before it meets the target,
// accounting for the target's own motion during that time. Independent of the
// bore, so `aim` and `impact` share one answer and stay exact inverses.
function timing(muzzle: Vector, v0: number, target: Vector, drift: Vector, altitude: number): number {
  let t = flight(size(minus(target, muzzle)), v0, altitude)
  for (let pass = 0; pass < 6; pass++) {
    const lead = plus(minus(plus(target, scale(drift, t)), muzzle), { x: 0, y: 0.5 * GRAVITY * t * t, z: 0 })
    t = flight(size(lead), v0, altitude)
  }
  return t
}

// impact is where this burst arrives, pulled back by the target's motion. Draw
// this point: sitting on the target, it is a hit.
export function impact(
  muzzle: Vector,
  bore: Vector,
  own: Vector,
  target: Vector,
  drift: Vector,
  altitude: number,
): { point: Vector; seconds: number } {
  const u = launch(bore, own)
  const v0 = size(u)
  const t = timing(muzzle, v0, target, drift, altitude)
  const point = plus(muzzle, scale(unit(u), travel(v0, t, altitude)))
  point.y -= 0.5 * GRAVITY * t * t
  return { point: minus(point, scale(drift, t)), seconds: t }
}

// aim answers the pilot's question: which way must the nose point for the rounds
// to arrive on the target? The pipper says this by sitting on him.
export function aim(muzzle: Vector, own: Vector, target: Vector, drift: Vector, altitude: number): Vector {
  let bore = unit(minus(target, muzzle))
  for (let pass = 0; pass < 8; pass++) {
    const v0 = size(launch(bore, own))
    const t = timing(muzzle, v0, target, drift, altitude)
    // The path the round must fly: to where he will be, plus the gravity drop.
    const path = unit(plus(minus(plus(target, scale(drift, t)), muzzle), { x: 0, y: 0.5 * GRAVITY * t * t, z: 0 }))
    // The barrel that puts the LAUNCH vector on that path. |bore·MUZZLE + own|
    // = speed along `path`, so solve the quadratic for that speed and subtract
    // the jet's own motion back out.
    const along = dot(path, own)
    const speed = along + Math.sqrt(Math.max(along * along - dot(own, own) + MUZZLE * MUZZLE, 0))
    bore = unit(minus(scale(path, speed), own))
  }
  return bore
}
