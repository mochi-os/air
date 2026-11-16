// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
// The model viewer's motion (/air/models): every moving part of the F/A-18C
// driven back and forth through its whole travel without end, each at the
// pace the game moves it. Where nothing in the game sets a pace - the part
// follows the jet's state (a wheel the ground, the wing its lift) or no game
// code drives it yet - the pace is an estimate, marked as one where it is set.
import * as THREE from 'three'
import fa18c_points from '../assets/fa18c.json'
import { pose, roll, type Posed } from './joints'
import { PACE, REACH } from './oleo'

const DEGREE = Math.PI / 180

// A drive's value as it moves, stepped by the seconds that pass
export interface Mover {
  readonly value: number
  step(seconds: number): void
}

// A model's motion: every mover stepped together, and each joint's drive
// value (undefined holds the joint, as joints.ts pose reads it)
export interface Motion {
  step(seconds: number): void
  value(drive: string, name: string): number | undefined
}

// stroke moves a drive from its rest (0, or the end nearest it) to high, back
// to low and on without end, at a pace in units a second: one number, or one
// for where it stands and which way it is going, which changes only at the
// stops given
export function stroke(
  low: number,
  high: number,
  pace: number | ((value: number, rising: boolean) => number),
  stops: number[] = []
): Mover {
  const rate = typeof pace === 'number' ? () => pace : pace
  let value = Math.min(Math.max(0, low), high)
  let rising = value < high
  return {
    get value() {
      return value
    },
    step(seconds: number) {
      let left = seconds
      // a step that reaches a stop goes on at the pace beyond it, and one
      // that reaches an end turns back, for what is left of it
      for (let legs = 0; left > 0 && legs < 4 + 2 * stops.length; legs++) {
        const speed = rate(value, rising)
        if (!(speed > 0)) return
        const end = rising ? high : low
        const ahead = stops.filter((s) => (rising ? s > value && s < end : s < value && s > end))
        const next = ahead.length ? (rising ? Math.min(...ahead) : Math.max(...ahead)) : end
        const need = Math.abs(next - value) / speed
        if (need > left) {
          value += (rising ? speed : -speed) * left
          return
        }
        value = next
        left -= need
        if (next === end) rising = !rising
      }
    },
  }
}

// spin turns a wheel at a speed in radians a second one way for some seconds,
// then the other way, without end: its value the angle wrapped into one turn,
// as a wheel's joint reads it (joints.ts roll)
export function spin(speed: number, seconds: number): Mover {
  let angle = 0
  let clock = 0
  let sense = 1
  return {
    get value() {
      return roll(angle)
    },
    step(dt: number) {
      let left = dt
      while (left > 0) {
        const run = Math.min(left, seconds - clock)
        angle += sense * speed * run
        clock += run
        left -= run
        if (clock >= seconds) {
          clock = 0
          sense = -sense
        }
      }
    },
  }
}

// The F404's spool and reheat as the flight core runs them (world
// flight/propulsion.go): the core follows the throttle with a 1.0 s time
// constant spooling up and 0.6 s down, and its reheat lights (whole, the
// throttle at its stop) once the core passes 0.85 and follows with 0.5 s.
// Idle is a throttle of 0.06.
const SPOOL = { up: 1.0, down: 0.6, stage: 0.5, idle: 0.06, lit: 0.85 }

// nozzle is the drive the exhaust nozzles' petals take from the spool and the
// reheat stage, as the engine poses them (engine.ts exterior_pose): open at
// idle, closed by military power, opening again with the reheat; the drive is
// how far they are closed
export function nozzle(spool: number, stage: number): number {
  const clamp = (v: number) => Math.min(Math.max(v, 0), 1)
  return 1 - Math.max(clamp((0.7 - spool) / 0.55), clamp(stage))
}

// engine moves the nozzles through the throttle slammed from idle to full
// reheat and back, held at each end for some seconds (an estimate: as long as
// the spool takes to settle), the spool and the reheat following it as the
// core's do
export function engine(hold: number): Mover {
  let spool = SPOOL.idle
  let stage = 0
  let clock = 0
  let full = false
  return {
    get value() {
      return nozzle(spool, stage)
    },
    step(seconds: number) {
      // in slices no longer than the shortest time constant's tenth, so a
      // long frame cannot overshoot
      let left = seconds
      while (left > 0) {
        const dt = Math.min(left, 0.05, hold - clock)
        const target = full ? 1 : SPOOL.idle
        spool += ((target - spool) * dt) / (target < spool ? SPOOL.down : SPOOL.up)
        const lit = full && spool > SPOOL.lit ? 1 : 0
        stage += ((lit - stage) * dt) / SPOOL.stage
        clock += dt
        left -= dt
        if (clock >= hold) {
          clock = 0
          full = !full
        }
      }
    },
  }
}

// by builds a motion from movers keyed by drive
function by(movers: Record<string, Mover>): Motion {
  return {
    step(seconds: number) {
      for (const m of Object.values(movers)) m.step(seconds)
    },
    value(drive: string) {
      return movers[drive]?.value
    },
  }
}

type Points = {
  motion: {
    seconds: Record<'canopy' | 'probe' | 'bar' | 'fold' | 'hook' | 'scoop' | 'swing', number>
    swing: number
    canopy: { unlatch: number; fall: number; lock: number }
  }
  points: { gear: Record<'nose' | 'left' | 'right', { radius: number }> }
}

// Legs holds a number for each of the F/A-18C's legs
export type Legs = Record<'nose' | 'left' | 'right', number>

// rises measures how far each leg's wheel rises, metres per unit of its oleo
// drive, with the gear down, as the engine measures it (engine.ts
// exterior_legs): the drawn oleo lifts a wheel by a height, and its drive is
// that height over this. It poses the jet; the caller puts it back.
export function rises(scene: THREE.Object3D, posed: Posed[]): Legs {
  const at = new THREE.Vector3()
  const height = (leg: string, travel: number) => {
    pose(posed, (drive) => (drive === 'gear' ? 1 : drive === `oleo.${leg}` ? travel : undefined))
    scene.updateMatrixWorld(true)
    const wheel = scene.getObjectByName(`gear_${leg}_wheel`)
    return wheel ? scene.worldToLocal(wheel.getWorldPosition(at)).y : NaN
  }
  const out = { nose: 1, left: 1, right: 1 }
  for (const leg of ['nose', 'left', 'right'] as const) {
    const rate = (height(leg, 0.1) - height(leg, 0)) / 0.1
    out[leg] = rate > 1e-3 ? rate : 1
  }
  return out
}

// The F/A-18C's drives that move nothing of their own: the loadout shows and
// hides the stores (the viewer's Stores button)
export const STILL = new Set(['stores'])

// fa18c drives every joint of our F/A-18C (fa18c.json): its mechanisms at
// their stroke times, its flight controls through their throws at their rate
// limits (world aircraft/fa18c/fa18c.go Control.Throw and Control.Rate), its
// oleos as the engine draws them, by each leg's wheel rise per unit of drive
// (rises), and its other passive parts at estimated paces
export function fa18c(legs: Legs, points: Points = fa18c_points as unknown as Points): Motion {
  const { seconds, canopy } = points.motion
  const stroked = (s: number) => stroke(0, 1, 1 / s)
  const taxi = 5.1 // m/s, about 10 kt: an estimate (the wheels roll with the ground)
  const wheel = (leg: 'nose' | 'left' | 'right') => spin(taxi / points.points.gear[leg].radius, 4)
  // the drawn oleo's whole lift of its wheel at its pace (oleo.ts), in drive
  const oleo = (leg: 'nose' | 'left' | 'right') => stroke(0, REACH / legs[leg], PACE / legs[leg])
  return by({
    gear: stroke(0, 1, 1 / 5), // 5 s each way on HYD 2 (flight/events.go)
    speedbrake: stroke(0, 1, 0.4), // 2.5 s to full travel (Control.Rate.Brake)
    // the canopy's stroke as the engine times it (engine.ts update_anim):
    // opening at one pace, closing its fall and its slide forward to lock
    // each at its own
    canopy: stroke(
      0,
      1,
      (v, rising) => (rising ? 1 / seconds.canopy : v > canopy.unlatch ? (1 - canopy.unlatch) / canopy.fall : canopy.unlatch / canopy.lock),
      [canopy.unlatch]
    ),
    probe: stroked(seconds.probe),
    bar: stroked(seconds.bar),
    fold: stroked(seconds.fold),
    hook: stroked(seconds.hook),
    scoop: stroked(seconds.scoop),
    // +10.5 deg trailing edge down, -24 up, at 40 deg/s
    'stabilator.left': stroke(-0.42, 0.183, 40 * DEGREE),
    'stabilator.right': stroke(-0.42, 0.183, 40 * DEGREE),
    // 45 deg down and 25 up at 100 deg/s
    'aileron.left': stroke(-25 * DEGREE, 45 * DEGREE, 100 * DEGREE),
    'aileron.right': stroke(-25 * DEGREE, 45 * DEGREE, 100 * DEGREE),
    // 45 deg down and 8 up at 18 deg/s
    'trailing.left': stroke(-8 * DEGREE, 45 * DEGREE, 18 * DEGREE),
    'trailing.right': stroke(-8 * DEGREE, 45 * DEGREE, 18 * DEGREE),
    // the leading edges to their 25 deg limit at 0.6 rad/s (Control.Slat.Limit)
    slat: stroke(0, 25 * DEGREE, 0.6),
    rudder: stroke(-30 * DEGREE, 30 * DEGREE, 75 * DEGREE),
    // the nosewheel to NWS HI's 75 deg (Gear.Nose.Steer) at the engine's
    // 0.4 rad/s slew (engine.ts update_anim)
    steering: stroke(-75 * DEGREE, 75 * DEGREE, 0.4),
    nozzle: engine(6),
    'wheel.nose': wheel('nose'),
    'wheel.left': wheel('left'),
    'wheel.right': wheel('right'),
    'oleo.nose': oleo('nose'),
    'oleo.left': oleo('left'),
    'oleo.right': oleo('right'),
    // the wing's bend through its whole -3 to 7.5 g at 5 g/s: an estimate
    // (it follows the lift)
    load: stroke(-3, 7.5, 5),
    // the hook's sideways travel each way (fa18c.json motion.swing) at the
    // game's own rate, its time from centre to either stop
    // (motion.seconds.swing)
    swing: stroke(
      -points.motion.swing * DEGREE,
      points.motion.swing * DEGREE,
      (points.motion.swing * DEGREE) / points.motion.seconds.swing
    ),
  })
}
