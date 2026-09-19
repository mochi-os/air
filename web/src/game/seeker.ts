// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The missile seeker's sight line: how fast it is turning, whether the seeker
// can still hold it, and what proportional navigation asks for. Lifted out of
// the engine so it can be typed and tested, as radar.ts, rwr.ts, impact.ts and
// pipper.ts were.
//
// The rate is taken ANALYTICALLY, from the relative velocity, and that is the
// whole point of this file. It used to be the finite difference of the sight
// line between two missile steps. But the engine moves both aircraft for the
// whole render frame and only then sub-steps the missiles on their own 60 Hz
// accumulator, so in any frame longer than one step the first missile step saw
// the target's entire frame of motion and the second saw none. At 30 fps that
// doubled the measured rate on every frame and halved the seeker's real limit
// to about ten degrees a second. A lock is dropped permanently on a single
// step over the ceiling, so missile lethality depended on the player's frame
// rate. In recording 01a0b090 (2026-09-17, ~30 fps) all five of the bandit's
// heaters lost lock with the true rate at 0.16-0.24 rad/s against a ceiling of
// 0.35, the gimbal at 1-7 degrees and no flares in the air; the player's best
// shot went the same way at 367 m and still passed within 20 m ballistic. The
// server steps its missiles in lockstep with its aircraft and never saw it.
//
// A rate with no memory has nothing to alias: it reads the same at any frame
// rate and in any update order, and it cannot spike when the aim point swaps
// to a flare, which is what the old re-reference at the seduction instant was
// papering over.

export interface Vector {
  x: number
  y: number
  z: number
}

export interface Sight {
  unit: Vector // round -> aim point
  distance: number // metres
  swing: Vector // the sight line's rotation, rad/s: perpendicular to unit, and the direction PN pulls
  rate: number // |swing|
  bearing: number // cosine of the angle between the round's flight path and the sight line
  closing: number // speed along the sight line, m/s, unsigned as the guidance law uses it
}

export type Reason = '' | 'gimbal' | 'rate'

// The two seekers that share the pool. The heater's ±40° gimbal and 20°/s track
// ceiling mirror the server (world/games/air/air.go: missile_gimbal,
// missile_track); the radar round's own seeker gimbals wider and tracks harder.
export const SEEKERS = {
  heater: { gimbal: 0.766, ceiling: 0.35 },
  radar: { gimbal: 0.5, ceiling: 0.7 },
} as const

// seeker_sight measures the sight line from the round to its aim point. drift
// is the aim point's velocity: the target's, or a flare's fall.
export function seeker_sight(
  position: Vector,
  velocity: Vector,
  aim: Vector,
  drift: Vector
): Sight {
  const dx = aim.x - position.x,
    dy = aim.y - position.y,
    dz = aim.z - position.z
  const distance = Math.hypot(dx, dy, dz) || 1e-6
  const unit = { x: dx / distance, y: dy / distance, z: dz / distance }
  const rx = drift.x - velocity.x,
    ry = drift.y - velocity.y,
    rz = drift.z - velocity.z
  const along = rx * unit.x + ry * unit.y + rz * unit.z
  // d(unit)/dt: the part of the relative velocity ACROSS the sight line, over
  // the range. Exact, and a function of this instant alone.
  const swing = {
    x: (rx - along * unit.x) / distance,
    y: (ry - along * unit.y) / distance,
    z: (rz - along * unit.z) / distance,
  }
  const speed = Math.hypot(velocity.x, velocity.y, velocity.z) || 1
  return {
    unit,
    distance,
    swing,
    rate: Math.hypot(swing.x, swing.y, swing.z),
    bearing:
      (unit.x * velocity.x + unit.y * velocity.y + unit.z * velocity.z) / speed,
    closing: Math.abs(along),
  }
}

// seeker_break says why the seeker can no longer hold this sight line, or ''
// while it can. The gimbal is tested first, as it always was.
export function seeker_break(
  sight: Sight,
  seeker: { gimbal: number; ceiling: number }
): Reason {
  if (sight.bearing < seeker.gimbal) return 'gimbal'
  if (sight.rate > seeker.ceiling) return 'rate'
  return ''
}

// seeker_steer is proportional navigation, a = N·Vc·λ̇, held to what the
// airframe can pull at this speed: 35 g at 600 m/s and above, fading to 15% of
// it as the round slows.
export function seeker_steer(sight: Sight, speed: number): Vector {
  const gain = 3.5 * sight.closing
  let x = sight.swing.x * gain,
    y = sight.swing.y * gain,
    z = sight.swing.z * gain
  const limit = 35 * 9.81 * Math.min(1, Math.max(0.15, speed / 600))
  const pull = Math.hypot(x, y, z)
  if (pull > limit) {
    x *= limit / pull
    y *= limit / pull
    z *= limit / pull
  }
  return { x, y, z }
}
