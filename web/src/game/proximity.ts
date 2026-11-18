// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The ground proximity warning's escape model (NATOPS 2.17.5.2). The warning
// sounds when the height the escape takes, plus a terrain clearance, reaches
// the height above the surface. The escape is flown forward from the jet's
// state in the vertical plane of its flight path: the pilot's reaction, with
// the jet holding the load it had; the roll that brings the lift vector
// upright, at 1 g and at the rate the speed allows; then the pull, its g
// building at the onset rate to a target short of what the wing gives. A rule on the present sink alone cannot lead a
// dive that keeps steepening: every second of the reaction and the roll adds
// to the sink the pull must then take out, and the g arrives over half a
// second, not at once.

export interface Vector {
  x: number
  y: number
  z: number
}

const GRAVITY = 9.81

export const PROXIMITY = {
  reaction: 1, // seconds before the pilot moves the stick
  // The roll to wings level, flown at 1 g on full lateral stick: 165 degrees a second from 208 m/s
  // (405 kt), falling with the speed toward nothing at 54 m/s (105 kt), as the flight core rolls.
  roll: { rate: 2.88, from: 54, full: 208, least: 0.2 },
  lag: 0.3, // seconds the stick's travel and the flight control system take to bring the roll rate up, and before the g starts to build
  onset: 4, // g a second as the pull builds
  pull: 4, // g of the pull, at most: deliberately short of the jet's limit, so that the call errs early
  share: 0.8, // of the g the wing gives at the speed, as NATOPS's target recovery g
  // metres a second: the wing gives (speed / stall)^2 g, fitted to the flight core's full-stick peak of
  // 3.95 g at 250 kt and 2,000 ft. Slower, the leading-edge flaps raise the lift and the figure errs low:
  // the core pulls 2.7 g at 180 kt, where this gives 2.0.
  stall: 65,
  clearance: 15, // metres: the terrain clearance the escape must leave (50 ft)
  floor: 91, // metres: the least height it ever allows
  sink: 10, // metres a second of sink before it looks at all
  slowest: 50, // metres a second: a slower jet is taken at this speed
  step: 0.02, // seconds of the escape's integration step
  longest: 30, // seconds: the escape flown at most
}

// rolling: the roll rate, radians a second, the escape flies at `speed` metres a second.
export function rolling(speed: number): number {
  const { rate, from, full, least } = PROXIMITY.roll
  return rate * Math.min(1, Math.max(least, (speed - from) / (full - from)))
}

// available: the g the escape's pull aims for at `speed` metres a second.
export function available(speed: number): number {
  const wing = (speed / PROXIMITY.stall) ** 2
  return Math.max(1.2, Math.min(PROXIMITY.pull, wing * PROXIMITY.share))
}

// bank: the roll in radians, from 0 to pi, that brings the lift vector
// upright: the angle about the flight path between the up axis's part
// square to it and the vertical plane's up. Zero in a vertical dive, where
// any roll will do.
export function bank(velocity: Vector, up: Vector): number {
  const speed = Math.hypot(velocity.x, velocity.y, velocity.z)
  if (speed < 1e-6) return 0
  const vx = velocity.x / speed, vy = velocity.y / speed, vz = velocity.z / speed
  const along = up.x * vx + up.y * vy + up.z * vz
  const lx = up.x - along * vx, ly = up.y - along * vy, lz = up.z - along * vz
  const lift = Math.hypot(lx, ly, lz), level = Math.sqrt(Math.max(0, 1 - vy * vy))
  if (lift < 1e-6 || level < 1e-3) return 0
  return Math.acos(Math.min(1, Math.max(-1, ly / lift / level)))
}

// escape: the height in metres the escape loses from a jet flying `velocity`
// (metres a second) with its up axis along `up` and `load` g on it.
export function escape(velocity: Vector, up: Vector, load: number): number {
  let speed = Math.max(Math.hypot(velocity.x, velocity.y, velocity.z), PROXIMITY.slowest)
  let path = Math.asin(Math.min(1, Math.max(-1, velocity.y / Math.max(Math.hypot(velocity.x, velocity.y, velocity.z), 1e-6))))
  let roll = bank(velocity, up), g = load, lost = 0, pulled = -1
  const dt = PROXIMITY.step
  for (let t = 0; path < 0 && t < PROXIMITY.longest; t += dt) {
    if (t >= PROXIMITY.reaction) {
      const moved = t - PROXIMITY.reaction
      if (roll > 0) {
        roll = Math.max(0, roll - rolling(speed) * Math.min(1, moved / PROXIMITY.lag) * dt)
        g = 1
      } else {
        if (pulled < 0) pulled = t
        if (t - pulled >= PROXIMITY.lag) g = Math.max(g, Math.min(available(speed), g + PROXIMITY.onset * dt))
      }
    }
    path += (GRAVITY / speed) * (g * Math.cos(roll) - Math.cos(path)) * dt
    speed = Math.max(PROXIMITY.slowest, speed - GRAVITY * Math.sin(path) * dt) // gravity along the path; thrust and drag left out
    lost -= speed * Math.sin(path) * dt
  }
  return Math.max(0, lost)
}

// warns: whether the warning sounds for a jet `height` metres over the
// surface, flying as escape takes it.
export function warns(height: number, velocity: Vector, up: Vector, load: number): boolean {
  if (-velocity.y <= PROXIMITY.sink) return false
  return height < Math.max(PROXIMITY.floor, escape(velocity, up, load) + PROXIMITY.clearance)
}
