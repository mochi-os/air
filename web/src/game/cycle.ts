// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
// The model viewer's motion (/air/models): every moving part of the F/A-18C
// driven back and forth through its whole travel without end, each at the
// pace the game moves it. Where nothing in the game sets a pace - the part
// follows the jet's state (a wheel the ground, the wing its lift) or no game
// code drives it yet - the pace is an estimate, marked as one where it is set.
import fa18c_points from '../assets/fa18c.json'
import { advance, settled, type Timeline } from './gear'

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

// The F/A-18C's drives that move only with weight on its wheels, its gear's
// mechanisms (gear.ts), and the seconds the gear holds at each end:
// estimates, long enough to see each pose
const GROUND = ['oleo.nose', 'oleo.left', 'oleo.right', 'steering', 'bar', 'wheel.nose', 'wheel.left', 'wheel.right'] as const
const MECHANISMS = ['doors', 'nose', 'main'] as const
const HOLD = { down: 1, stowed: 1 }
const GEAR = 5 // s each way on HYD 2 (flight/events.go)
const STEP = 1 / 120 // s: the longest step the sequence takes at once

// flight runs the gear down and up without end, as the engine draws a jet's
// in the air: the handle down for the stroke and a hold, then up for the
// stroke and a hold, each mechanism moving in its sequence (gear.ts: the
// doors, then both legs together, down; the nose leg, the mains, then the
// doors, up). Every oleo stays at its length in flight, the nosewheel
// straight, the launch bar up and the wheels still: the engine seats a leg,
// steers, lowers the bar and rolls the wheels only with weight on the wheels
// (engine.ts exterior_pose, update_anim), which the viewer's jet never has; a
// touchdown and taxi between the gear's strokes read as the gear going in and
// out part way.
export function flight(timeline: Timeline): Record<string, Mover> {
  const lowered = GEAR + HOLD.down
  const cycle = lowered + GEAR + HOLD.stowed
  let clock = 0
  const state = settled(timeline, 0)
  const still: Mover = {
    get value() {
      return 0
    },
    step() {},
  }
  const out: Record<string, Mover> = Object.fromEntries(GROUND.map((drive) => [drive, still]))
  MECHANISMS.forEach((name, i) => {
    out[`gear.${name}`] = {
      get value() {
        return state[name]
      },
      // the first steps the handle and the sequence for all three, in steps no
      // longer than STEP and none across the handle's move
      step:
        i > 0
          ? () => {}
          : (seconds: number) => {
              let left = seconds
              while (left > 1e-12) {
                const at = clock % cycle
                const chunk = Math.min(left, STEP, at < lowered ? lowered - at : cycle - at)
                advance(timeline, state, at < lowered, chunk, GEAR)
                clock += chunk
                left -= chunk
              }
            },
    }
  })
  return out
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

// hooked runs the hook down, swings it to each stop and back while it is
// down, and raises it, without end: the engine swings the shank only on a
// wire, the hook down, and stowed a swing would take its point through the
// nozzles. The hook strokes in its own seconds; the swing reaches either stop
// from the centre in its own (fa18c.json motion.seconds.swing)
export function hooked(hook: number, swing: number, seconds: number): { hook: Mover; swing: Mover } {
  const legs = [hook, seconds, 2 * seconds, seconds, hook]
  const cycle = legs.reduce((a, b) => a + b, 0)
  let clock = 0
  // the leg the clock stands in, and how far through it
  const at = (): [number, number] => {
    let t = clock % cycle
    let leg = 0
    while (leg < legs.length - 1 && t >= legs[leg]) t -= legs[leg++]
    return [leg, t / legs[leg]]
  }
  return {
    hook: {
      get value() {
        const [leg, share] = at()
        return leg === 0 ? share : leg === 4 ? 1 - share : 1
      },
      step(seconds: number) {
        clock += seconds
      },
    },
    swing: {
      get value() {
        const [leg, share] = at()
        return leg === 1 ? swing * share : leg === 2 ? swing * (1 - 2 * share) : leg === 3 ? -swing * (1 - share) : 0
      },
      // the hook's step moves both
      step() {},
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
    gear: Timeline
  }
}

// fa18c drives every joint of our F/A-18C (fa18c.json): the gear down and
// up, with everything that moves only on the ground still (flight), its
// other mechanisms at their stroke times, its flight controls through their
// throws at their rate limits (world aircraft/fa18c/fa18c.go Control.Throw
// and Control.Rate), and its other passive parts at estimated paces
export function fa18c(points: Points = fa18c_points as unknown as Points): Motion {
  const { seconds, canopy } = points.motion
  const stroked = (s: number) => stroke(0, 1, 1 / s)
  // the hook's sideways travel each way (fa18c.json motion.swing) at the
  // game's own rate, its time from centre to either stop
  // (motion.seconds.swing), and only with the hook down
  const hook = hooked(seconds.hook, points.motion.swing * DEGREE, seconds.swing)
  return by({
    ...flight(points.motion.gear),
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
    fold: stroked(seconds.fold),
    hook: hook.hook,
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
    nozzle: engine(6),
    // the wing's bend through its whole -3 to 7.5 g at 5 g/s: an estimate
    // (it follows the lift)
    load: stroke(-3, 7.5, 5),
    swing: hook.swing,
  })
}
