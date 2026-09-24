// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The Case I demonstration: a scripted pilot that flies the visual pattern
// from the initial to the wire through the same controls a player has - the
// stick as a demand the flight control laws interpret, the throttle lever,
// the speedbrake, and the gear, flap and hook switches. It never places the
// jet or prescribes its state; every metre of the pattern is flown. Its
// numbers are the flight hints' (engine.ts HINT): up the wake at 800 ft and
// 350 knots, the level break past the bow at idle with the boards out, the
// roll-out a mile abeam, gear, full flaps and hook below 250 knots, 600 ft
// on the downwind, the 200-300 fpm start-down abeam, 450 ft at the 90, the
// slope from the 45, the ball flown with power, and the bolter's full power
// climb back to 600 ft and the downwind.
//
// The pilot is a little sloppy on purpose: a seeded set of habits - a break
// a few hundred metres late, a bank a few degrees off the book, a pattern a
// little wide, a slow wander in height and speed, hands that reach for the
// switches a second or three after the call, and a lineup that drifts and is
// corrected - so that a pass looks flown rather than computed, while still
// arriving on speed, on the ball, and on the 2 or 3 wire.
//
// Dependency-free: the engine builds the Picture each frame from the ownship
// and the ship's geometry, and applies the Commands. The maths is testable
// without WebGL.

export interface Picture {
  time: number // sim seconds
  altitude: number // m above the sea
  vertical: number // vertical speed, m/s (+ climbing)
  speed: number // true airspeed, m/s
  cas: number // calibrated airspeed, m/s
  alpha: number // angle of attack, degrees
  heading: number // degrees, 0..360
  track: number // the velocity vector's heading, degrees, 0..360: what a crosswind makes of the heading
  bank: number // degrees, + right wing down
  pitch: number // degrees nose up
  roll: number // body roll rate, rad/s, + rolling right
  rate: number // body pitch rate, rad/s, + nose up
  throttle: number // the lever, 0 idle .. 1 military
  gear: boolean // the handle: down
  flap: number // the switch: 0 AUTO, 1 HALF, 2 FULL
  hook: boolean // the handle: down
  grounded: boolean
  trapped: boolean
  waving: boolean // the LSO is waving this pass off
  crashed: boolean
  coached: boolean // the dirty-up line has been raised on the glass
  ship: {
    along: number // m ahead of the ship's origin along the hull
    starboard: number // m to starboard of the hull axis
    bow: number // the bow's along, m
    course: number // the hull heading, degrees
  }
  groove: {
    along: number // m short of the touchdown, along the approach
    right: number // m right of the landing centreline, from the pilot's seat
    deviation: number // the hook's glideslope deviation, degrees, + high
    slope: number // the eye height that puts the hook on the 3.5° slope here, m
    heading: number // the landing line's heading, degrees
  }
}

export interface Commands {
  pitch: number
  roll: number
  yaw: number
  throttle: number
  speedbrake: number
  gear: boolean
  flap: number
  hook: boolean
  released: boolean // the pass is over: the pilot has let go of the controls
}

export type Phase =
  | 'wake'
  | 'break'
  | 'downwind'
  | 'turn'
  | 'groove'
  | 'around'
  | 'released'

// One pilot's habits, drawn once per pattern from the seed.
export interface Habits {
  late: number // the break past the bow, m
  steep: number // the break's bank, degrees
  wide: number // the abeam distance, m
  slow: number // seconds between a call and the hands moving
  height: number // the height wander's amplitude, m
  pace: number // the speed wander's amplitude, m/s
  drift: number // the lineup wander's amplitude, m
  ball: number // the glideslope gain, as a fraction of the book's
  phase: number[] // the wanders' phases, rad
}

export interface Demonstration {
  seed: number
  habits: Habits
  phase: Phase
  since: number // sim time the phase began
  configured: boolean // the switches have been thrown this pattern
  told: number // sim time the dirty-up was called (or crossed), -1 before
  vertical: number // last frame's vertical speed, for the acceleration term
  acceleration: number // filtered vertical acceleration, m/s²
  closing: number // filtered closure on the touchdown, m/s
  along: number // last frame's distance to the touchdown
  cas: number // last frame's calibrated airspeed
  trend: number // filtered airspeed rate, m/s²
  throttle: number // the lever the pilot holds, 0..1
  lever: number // the lever last commanded, which a hand moves from at its own pace
  trim: number // what the path has taught the pilot to add to the book's approach power, -0.25..0.25
  idling: boolean // the lever is at idle for the speed to come off, rather than flying the path
  pull: number // the up-and-away stick's slow trim: what the load loop has learned it takes to hold the path
  nose: number // the approach stick's slow trim: what it takes to hold on-speed alpha against the law's own datum, -0.15..0.15
  carry: number // the final turn's stick trim: what holding its path has taken beyond the bank's share, carried into the groove's handover, -0.12..0.12
  seated: boolean // the first airborne frame has been read: the lever starts where the spawn's trim left it
  targets: {
    altitude: number
    vertical: number
    cas: number
    heading: number
    bank: number
  }
}

const FEET = 0.3048
const KNOT = 0.514444
const DEGREE = Math.PI / 180
const SLOPE = Math.tan(3.5 * DEGREE)

// The pattern's numbers, from the hints.
const WAKE_ALTITUDE = 800 * FEET
const WAKE_SPEED = 350 * KNOT
const DIRTY_SPEED = 250 * KNOT
const DOWNWIND_ALTITUDE = 600 * FEET
const BREAK_SPEED = 215 * KNOT // held through the back half of the break: at idle with the boards out a 64° break is below 210 knots before the nose is round
const SETTLED_SPEED = 150 * KNOT // the turn waits for this: above it the arc from a mile abeam needs more bank than the pattern allows, and the groove is entered fast
const ONSPEED_CAS = 140 * KNOT // the lever's speed target while the jet is dirty and fast; on-speed itself is the alpha the stick holds
const ONSPEED_ALPHA = 8.1 // degrees: the indexer's doughnut, and the alpha the approach law's datum settles on
const PATTERN_BANK = 27 // "bank 27-30°"
const ABEAM_SINK = -(250 / 60) * FEET // "start down at 200-300 FPM"
const NINETY_SINK = -(500 / 60) * FEET // "The 90: 450', 500 FPM"
const TURN_START = 1300 // m short of the touchdown where the final turn begins. The arc rolls out on the line at the along it started from - its first half carries the jet a radius further astern, the second brings it back - so where the turn starts is the length of the groove: 1.3 km is the three-quarter-mile groove the book flies, and the 90 falls about 1.3 NM out. Started abeam the stern, as a go-around's re-entry once did, the roll-out came a few hundred metres out and high
const INTERCEPT = 0.035 // degrees of intercept angle per metre off the landing line, for the last of the turn: 45° a mile out, 10° at 300 m, so the line is joined tangentially rather than crossed
const TURN_TOTAL = 189 // degrees from the downwind to the landing heading: the reciprocal plus the angled deck

// The stick's meaning, from the flight control laws (fcs.go). Up and away a
// stick fraction demands a load: level + s*(ceiling-level), the ceiling a
// little under 7 g at pattern weight. In the powered approach law the stick
// commands alpha about the trimmed alpha, and a centred stick is on-speed.
const G_SPAN = 6.3
const UA_SPEED = 124 // m/s: below this with HALF or FULL selected the powered-approach law flies

// How fast a hand moves the lever on approach, in travel per second: the
// path loop's corrections run well inside it, and what it stops is a lever
// stepped across half its travel in one frame. A go-around's full power is
// thrown, not moved, and is not held to it.
const HAND = 0.15

// The final turn's stick and lever (see the approach law below). TILT is the
// stick for the bank's share of lift, per unit of 1/cos - 1: 0.15 at 30°,
// about two degrees of alpha. INDEXER is the lever per degree of alpha off
// on-speed.
const TILT = 1
const INDEXER = 0.06

// mulberry32: a seeded pseudo-random stream, so a seed replays a pilot.
function stream(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function clamp(v: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, v))
}

// wrap folds a heading difference into -180..180.
export function wrap(degrees: number): number {
  return ((((degrees + 180) % 360) + 360) % 360) - 180
}

// habits draws one pilot from the seed. Every figure sits inside what a
// competent pass allows: the break late by up to half a kilometre, the bank
// in the low sixties to low seventies, the pattern between 1.0 and 1.25 NM,
// the wanders a few dozen feet and a few knots.
export function habits(seed: number): Habits {
  const next = stream(seed)
  return {
    late: 80 + next() * 420,
    steep: 64 + next() * 8,
    wide: 1900 + next() * 420,
    slow: 1 + next() * 3,
    height: (25 + next() * 20) * FEET,
    pace: (3 + next() * 4) * KNOT,
    drift: 15 + next() * 20,
    ball: 0.8 + next() * 0.3,
    phase: [next(), next(), next(), next()].map((p) => p * 2 * Math.PI),
  }
}

export function demonstration_start(seed: number): Demonstration {
  return {
    seed,
    habits: habits(seed),
    phase: 'wake',
    since: 0,
    configured: false,
    told: -1,
    vertical: 0,
    acceleration: 0,
    closing: 0,
    along: 0,
    cas: 0,
    trend: 0,
    throttle: 0.5,
    lever: 0.5,
    trim: 0,
    idling: false,
    pull: 0,
    nose: 0,
    carry: 0,
    seated: false,
    targets: { altitude: WAKE_ALTITUDE, vertical: 0, cas: WAKE_SPEED, heading: 0, bank: 0 },
  }
}

// wander is the slow drift a hand-flown target carries: two sines that never
// quite repeat, of the given amplitude.
function wander(time: number, amplitude: number, phase: number): number {
  return (
    amplitude *
    (0.7 * Math.sin((2 * Math.PI * time) / 41 + phase) +
      0.3 * Math.sin((2 * Math.PI * time) / 17 + phase * 1.7))
  )
}

function enter(d: Demonstration, phase: Phase, time: number): void {
  d.phase = phase
  d.since = time
  d.pull = 0 // what the last phase's path took says nothing about this one's: the break's pull carried into the roll-out is a 130 ft balloon
}

// demonstration_step flies one frame: reads the picture, advances the
// pattern, and returns the controls. dt is the frame's seconds.
export function demonstration_step(
  d: Demonstration,
  pic: Picture,
  dt: number
): Commands {
  const h = d.habits
  const time = pic.time
  const step = Math.max(dt, 1e-3)
  // Filtered derivatives: the vertical acceleration and the airspeed trend
  // damp their loops, and the closure rides the slope's own descent rate.
  d.acceleration += ((pic.vertical - d.vertical) / step - d.acceleration) * Math.min(1, step * 4)
  d.vertical = pic.vertical
  d.trend += ((pic.cas - d.cas) / step - d.trend) * Math.min(1, step * 2)
  d.cas = pic.cas
  d.closing += ((d.along - pic.groove.along) / step - d.closing) * Math.min(1, step * 2)
  d.along = pic.groove.along
  if (!d.seated && pic.speed > 50) {
    d.seated = true
    d.throttle = pic.throttle // the lever starts where the spawn's trim left it
    d.lever = pic.throttle
  }

  const downwind = (pic.ship.course + 180) % 360
  const pa = pic.flap >= 1 && pic.cas < UA_SPEED // which pitch law the stick is talking to
  // Where the lineup will be in a few seconds, not where it is: the jet's
  // lateral rate across the landing line, times the seconds a roll-out
  // takes. Joined on the present offset alone the jet crosses the line.
  // From the track, not the heading: a crosswind puts the two apart by the
  // crab, and a lineup held on the nose drifts downwind of the line.
  const crab = wrap(pic.track - pic.heading)
  const drifting = pic.speed * Math.sin(wrap(pic.track - pic.groove.heading) * DEGREE) // m/s, + moving right
  const lead = pic.groove.right + drifting * 2.5 // the roll to the correcting bank and the turn through it: at four seconds the roll-out came 250 m short of the line and the whole groove was flown in a correcting bank

  let altitude: number | null = null // m, held through the vertical-speed loop
  let vertical: number | null = null // m/s, the vertical-speed target when the altitude is not the point
  let cas: number | null = null // m/s, the speed the throttle flies (up and away)
  let heading: number | null = null
  let bank: number | null = null // a fixed bank (the break) instead of a heading
  let limit = 25 // the heading-hold's bank limit, degrees
  let speedbrake = 0
  let power: number | null = null // a lever position instead of a loop
  let decelerating = false // dirty and slowing to on-speed: the lever idles while the jet is fast
  const margin = 10 * KNOT // how far over on-speed counts as fast for that
  let climb = 3 // m/s: the fastest climb the height loop may ask for
  let released = false

  // The pass is over: the sea, or a jet that has stopped rolling. Through
  // the wire's runout the pilot stays on the controls - centred, idle, no
  // brake - and lets go only when the jet has stopped, so a physical lever
  // or stick left off-centre does not take the jet on the wire.
  if (pic.crashed || (pic.grounded && pic.speed < 3)) {
    enter(d, 'released', time)
  } else if (pic.trapped && d.phase !== 'released') {
    d.phase = 'released'
  }
  // A wave-off, or wheels on the deck with no wire (a bolter, or a touch
  // past the wires), goes around: full power, boards in, wings level, climb
  // to 600 ft and turn downwind.
  if ((pic.waving || pic.grounded) && (d.phase === 'groove' || d.phase === 'turn') && !pic.trapped) {
    enter(d, 'around', time)
  }

  switch (d.phase) {
    case 'wake': {
      // Up the wake at 800 ft and 350 knots, on the starboard side.
      altitude = WAKE_ALTITUDE + wander(time, h.height, h.phase[0])
      cas = WAKE_SPEED + wander(time, h.pace, h.phase[1])
      const offset = 60 + (h.late / 500) * 200 // this pilot's starboard offset, m
      heading = pic.ship.course + clamp((offset - pic.ship.starboard) * 0.02, -15, 15)
      if (pic.ship.along > pic.ship.bow + h.late) enter(d, 'break', time)
      break
    }
    case 'break': {
      // The level left turn: idle and boards out to 250 knots, the pull
      // holding the height, the bank held until the nose is nearly round.
      // Then 220 knots is held through the rest of the turn: a break flown at
      // idle to the roll-out arrived at 210 knots and mushing.
      altitude = WAKE_ALTITUDE
      bank = -h.steep
      if (pic.cas > 235 * KNOT) power = 0
      else cas = BREAK_SPEED // and never past 80%: a lever at the wall through the roll-out climbs the jet out of the pattern band
      speedbrake = pic.cas > DIRTY_SPEED ? 1 : 0
      if (Math.abs(wrap(pic.heading - downwind)) < 25) enter(d, 'downwind', time)
      break
    }
    case 'downwind': {
      // Roll out on the reciprocal, a mile abeam. Below 250 knots the boards
      // come in and, when the coaching says so (or a moment later if it does
      // not), the gear, full flaps and hook go down. Slow level to 165 knots
      // before starting down to 600 ft, then on to the abeam.
      const wide = h.wide + wander(time, h.drift * 3, h.phase[2])
      heading = downwind + clamp((pic.ship.starboard + wide) * 0.02, -25, 25) // gently: opened out hard, the groove was joined 250 m left of the line and the lineup was still being flown at the ramp
      speedbrake = pic.cas > DIRTY_SPEED ? 1 : 0
      if (pic.cas < DIRTY_SPEED && d.told < 0) d.told = time
      // "descend to 600', slow to on-speed": both at once, from the
      // dirty-up - the downwind here is short, the ship being stationary.
      const settled = d.configured && pic.cas < SETTLED_SPEED && pic.altitude < DOWNWIND_ALTITUDE + 20 // slow AND down: a tight break rolled out at 800 ft turned 180 ft high into a 1.4 km groove
      altitude =
        (d.configured ? DOWNWIND_ALTITUDE : WAKE_ALTITUDE) +
        wander(time, h.height, h.phase[0])
      cas = ONSPEED_CAS // idle from the roll-out: the boards stay out to 250, and nothing below it is worth holding
      decelerating = true
      // The turn begins TURN_START astern of the touchdown (the groove's
      // `along` grows as the downwind runs aft), once the jet is slow; a jet
      // still fast there flies on and turns later, up to a mile further.
      const astern = pic.groove.along - TURN_START - (h.late / 500) * 300
      if (d.configured && astern > 0 && (settled || astern > 1852)) {
        enter(d, 'turn', time)
        d.carry = 0
        d.trim = 0 // the turn learns its own, on the indexer
      }
      break
    }
    case 'turn': {
      // The turn to the final bearing is one arc that ends tangent to the
      // landing line: with `remaining` degrees still to turn and the line
      // `lateral` metres away, the arc's radius is lateral/(1-cos remaining),
      // and the bank that flies it at this speed is atan(v²/gR) - 27-30° from
      // a mile abeam at on-speed, as the hint says, shallower from a wide
      // abeam and steeper from a tight one, exactly as a pilot corrects.
      // 450 ft at the 90 at up to 500 fpm; from there the slope itself is
      // the ceiling, so the 45 arrives at 325-375 ft on it.
      const g = pic.groove
      cas = ONSPEED_CAS
      const remaining = Math.abs(wrap(pic.heading - g.heading))
      limit = PATTERN_BANK + 3
      if (remaining > 60) {
        // The bank the arc needs at the speed flown, to the pattern's limit:
        // on-speed alpha in a bank is a faster jet, so the arc steepens a
        // little, and a bank sized for on-speed instead let a jet ten knots
        // over cross the line by 285 m. Past the limit the intercept absorbs it.
        const radius = clamp(Math.abs(g.right) / Math.max(1 - Math.cos(remaining * DEGREE), 0.02), 400, 6000)
        const needed = Math.atan((pic.speed * pic.speed) / (9.81 * radius)) / DEGREE
        bank = -clamp(needed, 10, limit)
      } else {
        // The last of the turn is an intercept: the angle off the landing
        // heading shrinks with the distance still to close, so the jet
        // joins the line rather than crossing it - an arc held to the end
        // arrives 30° off and drifts through the LSO's 6° lineup limit.
        heading = g.heading - clamp(pic.groove.right * INTERCEPT, -45, 45) // on the present offset and the heading: with the lead and the crab in it the roll-out came 250 m short of the line
      }
      // The first half of the turn carries the jet AWAY from the ship, so
      // the slope is no target there: 600 ft is held (a jet still high
      // comes down to it at the abeam's 200-300 fpm). From the 90 the jet
      // closes, and the slope is the ceiling wherever it meets the descent,
      // at up to the 90's 500 fpm - on this geometry the 90 falls about
      // 1.3 NM out, so it is flown on the slope near 550 ft rather than at
      // the moving-ship pattern's 450.
      // No idle through the turn: the jet began it slow, and a lever idled
      // for the speed a dive had built sank the turn further, then came back
      // to approach power in one step. Speed still over is the book power's
      // to bleed, the path the stick's to hold meanwhile.
      const outbound = remaining > TURN_TOTAL / 2
      if (outbound) {
        altitude = DOWNWIND_ALTITUDE
        vertical = ABEAM_SINK
        climb = 0 // a turn a little under 600 ft levels off rather than climbing back to it: the climb asked on top of a roll-in's sink swung the lever idle to 0.8
      } else {
        // Inbound the slope is flown as the groove flies it (below), at the
        // slope's own rate about the aim: a height loop capped at 500 fpm
        // handed the groove a jet sinking 2.5 m/s where the slope runs at
        // 4.4, and the entry ballooned high.
        const riding = -Math.max(0, Math.min(80, d.closing)) * SLOPE
        const high = pic.altitude - Math.min(DOWNWIND_ALTITUDE, g.slope + 2)
        vertical = clamp(riding - high * 0.05 * h.ball, riding - 2.5, 3) // and up to the slope when the roll-out lands under it, as a go-around's wide re-entry does
        if (pic.altitude > DOWNWIND_ALTITUDE) vertical = Math.max(vertical, NINETY_SINK) // still above the pattern: down at the 90's rate, no faster
      }
      if (Math.abs(g.right) < 300 && remaining < 12 && Math.abs(lead) < 250) {
        enter(d, 'groove', time)
        d.trim = 0
      }
      break
    }
    case 'groove': {
      // The ball with power, the lineup with the wings. The eye rides above
      // the hook's slope; inside 250 m the lens geometry reads falsely low,
      // so the last of the pass rides the slope's own rate without chasing.
      limit = pic.groove.along < 300 ? 8 : 20
      const g = pic.groove
      cas = ONSPEED_CAS
      // The lineup has to be within a metre or two at the wire: the cable's
      // V pulls an off-centre hook toward the middle, and five metres off it
      // yawed the jet twenty degrees and rolled it onto its back on the
      // deck. So the drift habit is gone by 800 m, and the correction
      // tightens as the deck nears, under a bank that cannot strike a tip.
      const right = lead + wander(time, h.drift, h.phase[2]) * clamp((g.along - 900) / 1000, 0, 1) // the drift is worked out by 900 m: the LSO writes up two metres from in close, five is gross
      // Three and a half times the angle to the line: at 1.8 a roll-out ten
      // metres right closed at half a metre a second and was still five
      // metres right in close.
      const correction = clamp(-(Math.atan2(right, Math.max(150, g.along + 150)) / DEGREE) * 3.5, -15, 15)
      heading = g.heading + correction - crab // the heading that puts the TRACK there
      const riding = -Math.max(0, Math.min(80, d.closing)) * SLOPE
      // The aim: a metre and a half above the slope through the groove - the
      // lens allows the hook 1.8° high but only 0.7° low, the LSO writes up
      // 0.4° either way, and the loop's own wander is a metre or two - coming
      // down onto it over the last 180 m. Never under it: a jet asked for
      // extra sink over the round-down, with the lever's answer four seconds
      // behind, struck the ramp; a float over the wires is only a bolter.
      const above = Math.min(1.5, 2.5 * clamp(g.along / 300, 0, 1))
      const aim = Math.min(DOWNWIND_ALTITUDE, g.slope + above)
      const high = pic.altitude - aim
      // The lens is asymmetric - the hook may ride 1.8° high but only 0.7° low
      // before the wave-off - so the loop is too: a high ball is worked off
      // gently, at no more than 1.2 m/s past the slope's own rate, and a low
      // one is climbed back to promptly. A correction that dived a 30 ft high
      // ball at a kilometre sailed through the slope to the low call.
      const gain = (g.along > 1500 ? 0.04 : g.along > 900 ? 0.1 : 0.12) * h.ball
      // A high ball is worked off at no more than 1.5 m/s past the slope's
      // own rate through the middle of the groove: the lever's answer runs
      // four seconds behind, and a steeper catch-up carried the jet from 50
      // ft high at 1,300 m through the slope to the low call at 700. The
      // low limit is the lens's (0.7° beyond 250 m); over the round-down
      // there is no call, only the wires, and the ground effect to fly through.
      const spare = g.along > 1500 ? 2.5 : g.along > 300 ? 1.5 : 1
      vertical = clamp(riding - high * gain, riding - spare, riding + (g.along > 900 ? 3.5 : 1.5))
      // Settling low over the round-down, past where the lens calls it: the
      // pilot's own wave-off, full power and the nose up, before the ramp.
      // On height, not the hook's angle, which at 130 m reads a landable
      // metre and a half low as 0.6°; and only while still sinking faster
      // than the slope - a jet three metres low and already coming back
      // up to it clears the ramp by four, and waved off it was a pass lost.
      if (g.along < 300 && g.along > 40 && pic.altitude < g.slope - 3 && pic.vertical < riding) enter(d, 'around', time)
      if (g.along < -40) enter(d, 'around', time) // past the wires still flying, and no wave-off called: a fly-through is a go-around
      break
    }
    case 'around': {
      // Full power, boards in, wings level until the climb is established,
      // then the left turn back to the downwind at 600 ft with everything
      // still down, the lever coming back from the wall once the nose is up
      // (left there, the dirty jet runs away to 550 knots and never turns).
      const climbing = !pic.grounded && pic.altitude > 45 && (pic.vertical > 0.5 || time - d.since > 8)
      if (!climbing) power = 1
      else {
        cas = ONSPEED_CAS
        decelerating = true // the lever comes back to idle while the jet is fast: left with the path loop it ran the climb-out up to 240 knots and the downwind two and a half miles out
      }
      heading = climbing ? downwind : pic.heading
      if (pic.grounded) vertical = 3 // rolling through the wires: the nose comes up and the jet flies off the angled deck
      limit = 30
      altitude = DOWNWIND_ALTITUDE
      if (climbing && Math.abs(wrap(pic.heading - downwind)) < 20) enter(d, 'downwind', time)
      break
    }
    case 'released':
      released = pic.crashed || (pic.grounded && pic.speed < 3) // in the wire the controls are held centred until the jet has stopped
      break
  }

  // The switches: gear, full flaps and hook once the call has been read and
  // this pilot's hands have caught up, one after another. Never on the
  // ground, and they stay down through a bolter.
  let gear = pic.gear
  let flap = pic.flap
  let hook = pic.hook
  if (d.phase === 'downwind' && !d.configured && d.told >= 0) {
    const due = pic.coached ? d.told + h.slow * 0.5 : d.told + h.slow
    if (time >= due) gear = true
    if (time >= due + 0.8) flap = 2
    if (time >= due + 1.6) {
      hook = true
      d.configured = true
    }
  }
  if (d.phase === 'released') {
    return {
      pitch: 0,
      roll: 0,
      yaw: 0,
      throttle: 0,
      speedbrake: 0,
      gear,
      flap,
      hook,
      released,
    }
  }

  // The vertical-speed target: from the altitude when one is held, else the
  // phase's own rate.
  let want = vertical ?? 0
  if (altitude !== null) {
    want = clamp((altitude - pic.altitude) * 0.25, -4, climb)
    if (vertical !== null) want = Math.max(want, vertical) // the phase's rate is the fastest the height loop may descend
  }

  // Bank from the heading error, or the break's fixed bank.
  let bankWant = bank ?? 0
  if (bank === null && heading !== null) {
    bankWant = clamp(wrap(heading - pic.heading) * 2.5, -limit, limit)
  }
  const roll = clamp((bankWant - pic.bank) * (pa ? 0.045 : 0.022) - pic.roll * 0.18, -0.7, 0.7)

  // Pitch and power.
  let pitch: number
  let throttle = d.throttle
  const speeding = cas === null ? 0 : (cas - pic.cas) * 0.035 - d.trend * 0.15 // the lever's rate toward a speed
  // The lever for a sink rate on-speed is known to a pilot before the error
  // is: on the model the dirty jet holds level flight at about 0.34 of the
  // lever, the 3.5° slope at 0.25, and idle sinks it 8.5 m/s. Banked, the
  // same path takes more (lift by 1/cos of the bank, the induced drag with
  // its square), so the book grows by (1/cos)^1.5 and comes back down as
  // the wings level onto the groove. A slow trim learns what this weight
  // and this day add, and a correction rides on top in proportion to the
  // sink error, damped on the acceleration. On the backside a lever change
  // reaches the path through the speed, four or five seconds on, and the
  // lever swings the sink by some thirty metres a second per unit, so both
  // the correction and the trim are kept far below what a first look at the
  // error asks for: at three times these gains the ball is flown idle to
  // full and back every twelve seconds.
  // Asymmetric, as the lens is: sinking past the wanted rate is met three
  // times as firmly as riding above it, since the low call comes at 0.7°
  // and the high one at 1.8°.
  const error = want - pic.vertical
  // In the final turn the book is read off the bank the pilot is rolling
  // to, not the bank the jet has yet: the power goes on with the roll-in and
  // comes off with the roll-out, ahead of the sink or the float it would
  // otherwise chase four seconds late.
  const leading = d.phase === 'turn' ? bankWant : pic.bank
  const banked = Math.pow(Math.cos(clamp(Math.abs(leading), 0, 60) * DEGREE), -1.5)
  const book = clamp((0.34 + 0.023 * want) * banked, 0.02, 0.6)
  // A sink still building past the wanted rate is met on the acceleration,
  // before the rate itself has run away: the lever's answer arrives four
  // seconds on, and waiting for the error alone put the jet 20 ft under the
  // slope at 600 m every time. A wanted sink beginning is left to build.
  // On the groove only: in the final turn the roll-in itself is a building
  // sink, and met on the acceleration the lever went to 0.75 and the turn
  // was flown at 165 knots.
  const arresting = d.phase === 'groove' && d.acceleration < 0 && error > -0.5 ? 0.25 : 0.06
  const correcting = clamp(error * 0.08 - d.acceleration * arresting, -0.25, 0.35) // a high ball met at 0.02 let the roll-out's excess speed ride the whole start of the groove as height, and at 0.05 a metre and a half above the aim was carried from the middle to the ramp
  // The burble: astern of the island the air sinks, more the lower the jet,
  // and the lever's answer to the sink it makes arrives too late for the
  // ramp. A little power in close, before the sink shows, as the LSO teaches.
  const burble = d.phase === 'groove' ? 0.035 * clamp((300 - pic.groove.along) / 150, 0, 1) : 0
  if (!pa) {
    // Up and away the stick is a load: the one that holds the path in this
    // bank, plus the vertical-speed error, less the acceleration already
    // closing it. The lever flies the speed.
    // A small stick is mostly the law's own damping (its g share fades in
    // with deflection), so a slow trim learns what the path really takes.
    const upright = Math.cos(clamp(Math.abs(pic.bank), 0, 75) * DEGREE)
    d.pull = clamp(d.pull * (1 - dt / 4) + (want - pic.vertical) * 0.03 * dt, -0.1, 0.12) // leaks over ~4 s, so it can only ever hold what the error keeps asking for
    const load = clamp(1 / upright + (want - pic.vertical) * 0.2 - d.acceleration * 0.05, 0.6, 4)
    pitch = clamp((load - 1) / G_SPAN + d.pull, -0.3, 0.5)
    if (power !== null) throttle = power
    else if (cas !== null) throttle += speeding * dt
  } else {
    // The powered approach law commands alpha, and which control flies the
    // path depends on how fast the jet is. Dirty and fast the law's datum is
    // the level-flight alpha for the speed, so power only accelerates: the
    // stick sets the path and the lever the speed. From 155 knots down the
    // stick holds on-speed alpha, as the pilot's does on the indexer, and
    // the height is flown with power - the lever the integrator, the sink
    // error its rate, the vertical acceleration its damping. Held at 8.1°
    // while still a few knots fast, the nose trades the excess for height
    // and the lever answers with less, so the speed settles on-speed by the
    // 90 rather than riding into the groove ten knots over; a stick that
    // flew the path here left the speed wherever the turn had it.
    // The law gives about 14° of alpha to a full pull, so 0.06 of stick per
    // degree of error asks for most of the error back, and the law's own
    // integrator holds the rest; the pitch rate damps it.
    // Which regime is read on the indexer, not the airspeed: banked, the jet
    // is on-speed ten or fifteen knots faster than level, and a hold keyed
    // to 150 knots switched itself off through the whole final turn.
    const onspeed = clamp(pic.alpha - 6, 0, 1) // 0 at 6° and below, 1 from 7° up: blended wider, the two regimes fought through the final turn and the lever rang with them
    // Slowing dirty, the lever stays at idle and the speed comes off - low
    // as well as fast, it is the nose that trades the speed for height (the
    // stick's frontside share), never the lever: power on a fast dirty jet
    // only makes it faster. Everywhere else the path loop owns the lever,
    // taking it at the book's approach power when the idle regime hands
    // over. Fast is read on the indexer, not the airspeed alone: banked, the
    // jet is on-speed at 150 knots, and a lever idled for those ten knots
    // sank the whole final turn at idle and rolled out 100 ft under the slope.
    const idling = decelerating && pic.cas > (cas ?? ONSPEED_CAS) + margin && pic.alpha < ONSPEED_ALPHA - 1.5
    const pathing = (want - pic.vertical) * 0.08
    // The law's datum is the level-flight alpha until the jet is nearly
    // on-speed, so a proportional pull alone leaves the nose a degree short
    // of the doughnut while the speed is still coming off, as it is through
    // the whole final turn; the pilot trims that out, and so does this: a
    // slow stick offset learned from the alpha error, held while the hold
    // is flying and let go as the jet speeds up again.
    const turning = d.phase === 'turn'
    if (turning) {
      // held: the turn's stick is the path's, and what it trims is the groove's
    } else if (onspeed > 0.5) d.nose = clamp(d.nose + (ONSPEED_ALPHA - pic.alpha) * 0.03 * dt, -0.15, 0.15)
    else d.nose *= Math.max(0, 1 - dt / 2)
    // On-speed the stick still lends the path a little: the lever alone
    // works the path through the speed and swings the jet through the
    // phugoid every ten seconds, and a touch of nose with the power - as
    // the pilot gives it - damps that. A sink error of two metres a second
    // costs half a degree of alpha, inside what the LSO writes up.
    const holding = (ONSPEED_ALPHA - pic.alpha) * 0.06 - pic.rate * 0.3 + (want - pic.vertical) * 0.015 + d.nose
    const approaching = clamp(pathing * (1 - onspeed) + holding * onspeed, -0.5, 0.5) // a push of 0.35 held a fast dirty jet level against the law's rising datum and never started it down
    // The final turn is flown the other way round: the stick for the path,
    // the lever for the indexer. Rolling in tilts a seventh of the lift away
    // at once, and only the nose answers that in time - the lever, flying
    // the path, chased the sink it could not stop to 0.8, bred a dive and a
    // float, and swung idle to half and back through the whole turn. So the
    // stick pulls the bank's share as the wings go down (the law's datum is
    // the one-g alpha) and holds the path; the jet reads a little slow, and
    // the lever adds power for it until the speed the bank wants has built
    // and the indexer is back on the doughnut, and takes it off as the
    // wings level. Past 9.8° the nose eases whatever the path asks, and the
    // roll-in sinks a little rather than flying that slow: held to the path
    // at 10.9° from a 133-knot start, the lever added 0.4 for it and the
    // speed then overshot to 155.
    // What the bank's share leaves over - less once the jet is fast, more
    // while it is still slow - a slow trim learns, leaking over six seconds
    // so it only ever holds what the path keeps asking for: on the share
    // alone a turn 15 knots fast climbed 200 fpm against a wanted descent.
    if (turning) d.carry = clamp(d.carry * (1 - dt / 6) + (want - pic.vertical) * 0.03 * dt, -0.12, 0.12)
    const banking = (1 / Math.cos(clamp(Math.abs(pic.bank), 0, 60) * DEGREE) - 1) * TILT
    const steering = clamp(pathing - d.acceleration * 0.03 + banking + d.carry - Math.max(0, pic.alpha - 9.8) * 0.12, -0.5, 0.5)
    // Into the groove the ball is flown with power and the nose on the
    // doughnut; the change of hands is made over three seconds, not in one
    // frame, or the nose steps as the pass begins.
    const handover = d.phase === 'groove' ? clamp((time - d.since) / 3, 0, 1) : 1
    pitch = turning ? steering : steering * (1 - handover) + approaching * handover
    if (power !== null) throttle = power
    else if (idling) {
      d.idling = true
      d.throttle = clamp(d.throttle + speeding * dt, 0, 1)
      throttle = d.throttle
    } else if (turning) {
      // The lever for the indexer: the book's power for the bank being
      // rolled to, and more while the jet reads slow, less while fast -
      // one loop for both, so a jet still fast from the downwind is slowed
      // without the lever ever going to idle, and the speed a dive would
      // have built is never asked for.
      // A slow trim learns what the book misses on this descent in this
      // bank: on the proportional term alone the turn settled a degree fast
      // and handed the groove 155 knots, which the lever then had to idle off.
      // And the speed's own trend damps it: power still on while the speed is
      // already building is what carries it past on-speed, so the handful
      // comes off as the speed comes up, before the indexer reads fast.
      d.idling = false
      d.trim = clamp(d.trim + (pic.alpha - ONSPEED_ALPHA) * 0.01 * dt, -0.1, 0.1)
      throttle = Math.max(0.05, book + d.trim + (pic.alpha - ONSPEED_ALPHA) * INDEXER - d.trend * 0.06)
      d.throttle = clamp(book + d.trim, 0.05, 1)
    } else {
      if (d.idling) d.trim = 0 // the idle regime hands over: the book value alone, until the path says otherwise
      d.idling = false
      if (d.phase === 'groove' && pic.groove.along < 1500) d.trim = clamp(d.trim + error * 0.006 * dt, -0.08, 0.08) // learnt on the groove alone, and only once the entry has settled: the turn's errors are its bank's, and a trim that learned the entry's swing flew the rest of the groove a tenth of a lever short. Quick enough inside the mile to take out the book's own error, which at half this rate carried the jet four metres high from the middle to the wires and over them
      // Slow is the one thing a pass must not be: above 10° the lever comes
      // up whatever the height loop says.
      if (pic.alpha > 10) d.trim = Math.min(0.25, d.trim + 0.4 * dt)
      // Never quite idle on the path: idle sinks the jet at 8.5 m/s, twice
      // the slope's rate, and a few seconds of it is a hole the LSO's low
      // call finds before the lever can fill it.
      throttle = Math.max(0.05, book + d.trim + correcting + burble)
      d.throttle = clamp(book + d.trim, 0.05, 1) // the lever the idle regime resumes from
    }
  }
  throttle = clamp(throttle, 0, cas === BREAK_SPEED ? 0.8 : 1)
  if (pa && power === null) throttle = d.lever + clamp(throttle - d.lever, -HAND * dt, HAND * dt) // the hand's pace: leaving the idle regime stepped the lever from 0 to 0.51 in one frame
  d.lever = throttle
  if (!pa || power !== null) d.throttle = throttle
  d.targets = {
    altitude: altitude ?? pic.altitude,
    vertical: want,
    cas: cas ?? pic.cas,
    heading: heading ?? pic.heading,
    bank: bankWant,
  }
  return { pitch, roll, yaw: 0, throttle, speedbrake, gear, flap, hook, released }
}
