// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// Approach Power Compensator (#202): the carrier-landing autothrottle closes
// the alpha loop through the throttle, so the pilot flies glideslope and lineup
// with the stick alone. Engine-side: it modulates the throttle INPUT into the
// flight core, so the wasm ABI and multiplayer input protocol are untouched.
// Dependency-free so the law is unit testable.

// On-speed alpha in DEGREES (the airframe's Control.Onspeed, 8.1°).
export const ATC_ONSPEED = 8.1

// Throttle authority: never below a spool floor, never past MIL — the real ATC
// does not command afterburner; a waveoff is the pilot slamming past it.
export const ATC_LEAST = 0.12
export const ATC_MOST = 1.0

// Law gains. The throttle itself is the integrator: alpha error commands a
// throttle RATE (slow = high alpha = add power), and the alpha-rate term damps
// the phugoid the pure integrator would otherwise ride.
const GAIN_ERROR = 0.16 // throttle/s per degree of alpha error
const GAIN_RATE = 0.6 // throttle/s per (degree/second) of alpha rate

// atc_step returns the next throttle command holding on-speed alpha.
// alpha and alphaRate in degrees and degrees/second; throttle 0..1 (idle..MIL).
export function atc_step(
  throttle: number,
  alpha: number,
  alphaRate: number,
  dt: number
): number {
  const rate = Math.max(-10, Math.min(10, alphaRate)) // a spike (gust, catapult, state snap) must not slam the levers
  const command =
    throttle + ((alpha - ATC_ONSPEED) * GAIN_ERROR + rate * GAIN_RATE) * dt
  return Math.min(ATC_MOST, Math.max(ATC_LEAST, command))
}

// Cruise mode (NATOPS 2.1.2.2): with the FLAP switch at AUTO the same button
// holds the true airspeed of the moment of engagement. The throttle integrates
// again: the speed error commands a throttle rate and the acceleration damps it,
// over the same flight idle to MIL range.
const CRUISE_ERROR = 0.02 // throttle/s per knot below the engaged airspeed
const CRUISE_ACCEL = 0.08 // throttle/s per knot/s of acceleration

// cruise_step returns the next throttle command holding the engaged airspeed.
// speed and target in knots true, accel in knots/second; throttle 0..1 (idle..MIL).
export function cruise_step(
  throttle: number,
  speed: number,
  target: number,
  accel: number,
  dt: number
): number {
  const rate = Math.max(-20, Math.min(20, accel)) // a spike (a state snap, a catapult) must not slam the levers
  const command =
    throttle + ((target - speed) * CRUISE_ERROR - rate * CRUISE_ACCEL) * dt
  return Math.min(ATC_MOST, Math.max(ATC_LEAST, command))
}
