// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// Mouse-aim steering: the nose-to-cursor law for the optional mouse control
// mode. The player points at a place on screen and this works out what the
// stick has to do to put the nose there. The engine feeds the result into the
// same pitch/roll/yaw merge the keyboard and the gamepad already share, so the
// FCS downstream cannot tell where the command came from.
//
// The whole design lives in this header on purpose. It was written up in
// docs/superpowers/specs/2026-08-18-mouse-aim-design.md, but that tree is not
// under version control here and would not survive a fresh clone, so the
// reasoning that a future reader actually needs is repeated below.
//
// ---- The law ---------------------------------------------------------------
//
// Bank-to-turn, the way a pilot flies: roll the lift vector onto the target,
// then pull. A fighter has one big force available and it points out of the
// canopy, so "turn toward" means "roll until up points at it, then pull g".
//
//   1. Project the aim direction into the body frame:
//        ax = aim·right   ay = aim·up   az = aim·fwd
//   2. Off-axis angle  theta = atan2(hypot(ax, ay), az).
//      Below DEAD the command is zero on every axis, so a settled nose does
//      not hunt around the cursor.
//   3. Roll angle  phi = atan2(ax, ay): the angle from the jet's own "up" round
//      to the target, measured in the plane across the nose. Roll command is
//      proportional to phi and fades out as theta shrinks — there is nothing to
//      roll toward once the target is already on the nose, and rolling anyway
//      is what makes an autopilot look drunk in level flight.
//   4. Pitch pulls, and pulls only. The command scales with theta and with
//      cos(phi), which is how well the lift vector is already lined up, so the
//      jet rolls first and the pull arrives as it gets there. A target BELOW
//      the nose gives cos(phi) < 0, and rather than push we clamp to zero and
//      let the roll carry it round — that is the real technique and it also
//      keeps the negative-g fuel interruption in the core (NATOPS ten-second
//      business, flight/propulsion.go) out of normal flying. The one exception
//      is a target barely below the nose, inside PUSH: forbidding a small push
//      there would mean a half roll to correct a one-degree error.
//   5. Yaw is ALWAYS zero. War Thunder's instructor uses rudder for fine
//      tracking and that is what rips wings at speed; the pedals stay with the
//      player.
//   6. No limiter of any kind lives here. The core FCS already carries the g
//      limiter and the alpha limiter, and this module commands stick, so the
//      mode cannot fly the jet outside its own envelope.
//
// ---- Frame rate ------------------------------------------------------------
//
// command() is a pure function of the CURRENT geometry. It holds no state and
// takes no dt, so it is frame-rate independent by construction. That is
// deliberate: the flight core steps a fixed Dt = 1/240 and the bot brain a
// fixed 1/60, so everything else in the loop is already display-rate
// independent and the steering law must not be the one thing that is not.
// If smoothing or a rate limit is ever added it takes dt as an explicit
// argument. Nothing in this file may count frames.
//
// ---- Key map for the mode --------------------------------------------------
//
// The engine owns the bindings; they are recorded here so the law and its
// controls are read together.
//
//   mouse.aim   KeyN        toggle the mode (N, U and Z are the only free
//                           letters — digits 1-6 are the view selector and
//                           Digit0 is view.reset)
//   left button             fire the SELECTED weapon, through the same path as
//                           the fire key, so GUN/9M/120C selection still works
//   right button held       free look; the cursor freezes and holds its
//                           command, the mouse pans the head or chase orbit
//   hud.hide    Shift+KeyH  hide all 2D symbology (plain H stays the hook)
//
// Left-drag camera orbit is disabled while the mode is on; the right button
// above replaces it. Cursor travel is clamped as an ANGLE off boresight, never
// as a pixel radius — see radius() for why.

export interface Vector {
  x: number
  y: number
  z: number
}

// The jet's body axes, as the engine already keeps them on a state.
export interface Frame {
  fwd: Vector
  up: Vector
  right: Vector
}

// Stick command, in the same -1..1 the FCS takes from the keyboard and stick.
export interface Command {
  pitch: number
  roll: number
  yaw: number
}

export interface Gains {
  /** Roll command per radian of lift-vector error. */
  roll: number
  /** Pitch command per radian of off-axis angle. */
  pitch: number
  /** Off-axis angle below which nothing is commanded, radians. */
  dead: number
  /** Off-axis angle below which a small push is allowed, radians. */
  push: number
  /** Off-axis angle at which roll authority is full, radians. */
  bank: number
}

// Starting values. Tuned by flying, not by argument — and deliberately NOT
// tuned against a stuttering frame rate, which produces gains that feel wrong
// once frametimes settle.
export const GAINS: Gains = {
  roll: 1.6,
  pitch: 2.2,
  dead: 0.009, // ~0.5°
  push: 0.14, // ~8°
  bank: 0.20, // ~11°
}

const dot = (a: Vector, b: Vector): number => a.x * b.x + a.y * b.y + a.z * b.z
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

// command returns the stick deflection that swings the nose onto `aim`.
// `aim` is a direction in the same world space as the frame axes; it does not
// have to be normalised. `gain` is the player's sensitivity multiplier.
export function command(aim: Vector, frame: Frame, gain = 1, gains: Gains = GAINS): Command {
  const size = Math.hypot(aim.x, aim.y, aim.z)
  if (size < 1e-9) return { pitch: 0, roll: 0, yaw: 0 }
  const unit = { x: aim.x / size, y: aim.y / size, z: aim.z / size }

  const ax = dot(unit, frame.right)
  const ay = dot(unit, frame.up)
  const az = dot(unit, frame.fwd)

  const across = Math.hypot(ax, ay)
  const theta = Math.atan2(across, az)
  if (theta <= gains.dead) return { pitch: 0, roll: 0, yaw: 0 }

  // Straight astern: `across` collapses and phi is undefined. Treat it as
  // straight up in the body frame, which commands a pure pull — a loop is the
  // right answer to a target directly behind, and leaving phi to atan2(0,0)
  // would have picked an arbitrary roll instead.
  const along = across < 1e-7 ? 1 : ay / across
  const phi = across < 1e-7 ? 0 : Math.atan2(ax, ay)

  // Roll fades in with theta: on-nose targets need no bank.
  const authority = Math.min(1, theta / gains.bank)
  const roll = clamp(gains.roll * phi * authority * gain, -1, 1)

  let pitch = gains.pitch * theta * along * gain
  if (along < 0 && theta >= gains.push) pitch = 0 // roll it round rather than push
  pitch = clamp(pitch, -1, 1)

  return { pitch, roll, yaw: 0 }
}

// radius converts the cursor's angular travel limit into a pixel radius at the
// CURRENT field of view.
//
// This must be recomputed every frame. The camera's field is divided by the
// live optical zoom, and the cockpit view runs a 72° base against 45°
// everywhere else, so a limit stored in pixels would silently change what it
// means on every zoom notch and every view change — the cursor would be worth
// a different number of degrees in the pit than in chase, which is exactly the
// sensitivity drift a mouse mode cannot afford.
//
// `limit` and `fov` are radians (fov is the camera's VERTICAL field), `height`
// is the viewport height in CSS pixels.
export function radius(limit: number, fov: number, height: number): number {
  const half = Math.tan(Math.max(1e-4, fov / 2))
  return (Math.tan(clamp(limit, 0, 1.4)) / half) * (height / 2)
}
