// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The automatic flight control system's autopilot (NATOPS A1-F18AC-NFM-000
// 2.9, MC OFP 13C): the pilot relief modes - the basic autopilot's heading
// hold, attitude hold, heading select, barometric and radar altitude hold,
// control stick steering through all of them - and the couple to a steering
// source: the steering boxed on the HSI, the data link's traffic control
// heading, or its automatic carrier landing commands (24.6.1). Like the ATC
// (atc.ts) it works the jet through the pilot's own controls: it gives the
// flight control laws a stick, and the engine sends that in place of the
// pilot's while a mode holds an axis. Dependency-free: the engine says what the
// jet is doing (Sense) and which options were pressed, and applies the stick
// that comes back.

// What a steering source asks of the flight controls. track: a track over the
// ground to fly, the navigation steering (2.9.2.6). heading: a heading to
// capture and hold, the traffic control couple (24.6.1.2.2). bank: the roll
// angle itself, with a rate of climb for the pitch axis - the carrier's
// commands in ACL mode 1, the one couple that flies both axes (24.6.1.2.3).
export interface Couple {
  axis: 'track' | 'heading' | 'bank'
  value: number // degrees
  vertical: number | null // m/s, + climbing; with bank only
}

// What the jet tells it each frame. Angles in degrees, + nose up, + right wing
// down, headings and tracks true; lengths in metres; rates in radians a second.
export interface Sense {
  time: number // sim seconds
  pitch: number
  bank: number
  heading: number
  track: number // the ground track, which coupled steering flies
  altitude: number // barometric
  height: number | null // radar altitude; null with no reading
  vertical: number // m/s, + climbing
  cas: number // m/s
  roll: number // body roll rate, + rolling right
  rate: number // body pitch rate, + nose up
  approach: boolean // the powered approach law is flying: the stick commands alpha, not load (fcs.go)
  airborne: boolean
  attitude: boolean // the INS's attitude reaches the flight control computers: without it the autopilot is inoperative (figure 12-1, HIAOA)
  computer: boolean // mission computer 1 is communicating with the FCS (2.9.2.6, 25.1.1)
  stick: { pitch: number; roll: number } // the pilot's stick, -1..1
  trim: { pitch: number; roll: number } // the trim switch held, -1..1, + nose up and + right wing down
  selected: number // the heading selected on the HSI
  couple: Couple | null // what there is to couple to; null with nothing
  limit: 'nav' | 'tac' // the A/C data's BLIM
}

// The options on the UFC's A/P page: ATTH, HSEL, BALT, RALT and CPL.
export type Mode = 'attitude' | 'select' | 'barometric' | 'radar' | 'coupled'
export const MODES: readonly Mode[] = ['attitude', 'select', 'barometric', 'radar', 'coupled']
export const LABELS: Record<Mode, string> = { attitude: 'ATTH', select: 'HSEL', barometric: 'BALT', radar: 'RALT', coupled: 'CPLD' }

export interface Autopilot {
  engaged: boolean // the basic autopilot: heading or roll attitude held, and the pitch attitude
  modes: Record<Mode, boolean>
  lateral: 'heading' | 'bank' // what the basic autopilot holds: the heading, or past 5° of bank the roll attitude
  pitch: number // the pitch attitude held
  bank: number // the roll attitude held
  heading: number // the heading held
  altitude: number // the altitude held, barometric or radar
  source: Couple['axis'] // what it is, or was last, coupled to
  command: number // the bank coupled steering is asking for, brought on at its rate
  caution: number // the AUTO PILOT caution stands until this time
  flash: number // the coupled cue flashes until this time: a couple that failed, or let go by itself
  hands: { pitch: boolean; roll: boolean } // the pilot is flying that axis through the stick: control stick steering
  vertical: number // last frame's vertical speed
  acceleration: number // filtered vertical acceleration, m/s²
  pull: number // the slow trim the path loop learns, as stick
}

// The limits: no mode can be selected past 70° of bank or 45° of pitch, and
// the references go no further (2.9, 2.9.2.1); the roll attitude held is at
// least 5°, under which the heading is held instead; radar altitude hold
// reaches 5,000 ft (2.9.2.5); heading select, heading hold and the traffic
// control couple bank to 30° (24.6.1.2.2).
export const BANK = 70
export const PITCH = 45
export const LEVEL = 5
export const TURN = 30
export const CEILING = 5000 * 0.3048
export const WARNED = 10 // seconds the AUTO PILOT caution stands, and a coupled cue flashes (2.9.1, 24.2.9.3)
// The trim switch moves the references: half a degree a second in pitch, two
// in roll, and the heading with the roll's (2.9.2.1).
const NOSE = 0.5
const WING = 2
// Stick past these is the pilot's: control stick steering, and coupled
// steering let go by half an inch of lateral stick (2.9.2.6), about a sixth of
// its throw.
const HAND = 0.05
const DECOUPLE = 0.15
// What the carrier's commands may ask in ACL: the FCS limits what it accepts
// of them (24.6.1.2.3). The manual gives no figures; these are the game's.
const ROLL = 30
const SINK = -8
const CLIMB = 4
// The stick's meaning, from the flight control laws (fcs.go): up and away a
// stick fraction demands a load over G_SPAN; in the powered approach law it
// moves the angle of attack, which with the throttle holding that (atc.ts)
// flies the path. The loops' gains were found against the flight core
// (autopilot-core.test.ts flies them).
const G_SPAN = 6.3
const DEGREE = Math.PI / 180
const K = {
  close: 0.15, // m/s of climb wanted per metre below the altitude held
  path: 1, // g per m/s of climb wanted, up and away
  damp: 0.1, // g per m/s² of vertical acceleration
  learn: 0.01, // stick a second per m/s the path is off: the slow trim
  leak: 10, // seconds the slow trim takes to forget
  attitude: 0.5, // g per degree the nose is off the attitude held
  rate: 0.1, // g per degree a second of pitch rate
  trim: 0.03, // stick a second per degree the nose is off
  approach: { path: 0.05, damp: 0.08, learn: 0.01, leak: 15, attitude: 0.06, rate: 1 }, // the same loops through the powered approach law's stick
}

export function fresh(): Autopilot {
  return {
    engaged: false, modes: { attitude: false, select: false, barometric: false, radar: false, coupled: false }, lateral: 'heading',
    pitch: 0, bank: 0, heading: 0, altitude: 0, source: 'track', command: 0, caution: -Infinity, flash: -Infinity, hands: { pitch: false, roll: false },
    vertical: 0, acceleration: 0, pull: 0,
  }
}

const clamp = (v: number, low: number, high: number) => Math.max(low, Math.min(high, v))
// wrap: a heading difference in -180..180
export function wrap(degrees: number): number {
  return ((((degrees + 180) % 360) + 360) % 360) - 180
}

// able: the autopilot can be engaged or a mode selected - in the air, the INS's
// attitude with the flight control computers, inside 70° of bank and 45° of
// pitch (2.9).
export function able(s: Sense): boolean {
  return s.airborne && s.attitude && Math.abs(s.bank) <= BANK && Math.abs(s.pitch) <= PITCH
}
// offered: the options the A/P page shows - one that is not available is not
// displayed (2.9). CPL needs something to couple to and MC1; coupled, ATTH and
// HSEL are not available (2.9.2.6), and coupled to the carrier's commands
// nothing else is (figure 24-29); RALT needs the radar altimeter reading
// inside its 5,000 ft.
export function offered(ap: Autopilot, s: Sense): Record<Mode, boolean> {
  const coupled = ap.modes.coupled
  const both = coupled && ap.source === 'bank'
  return {
    attitude: !coupled,
    select: !coupled,
    barometric: !both,
    radar: !both && s.height !== null && s.height <= CEILING,
    coupled: coupled || (s.couple !== null && s.computer),
  }
}
// bound: the bank coupled steering may use and the rate it rolls at - NAV 30°
// at 10° a second, TAC from 30° to 60° and 10° to 30° a second with airspeed
// (24.2.8). The manual gives TAC's ends and not its schedule: here the least
// to 250 knots and the most from 450.
export function bound(s: Sense): { bank: number; rate: number } {
  const fast = s.limit === 'nav' ? 0 : clamp((s.cas / 0.514444 - 250) / 200, 0, 1)
  return { bank: 30 + fast * 30, rate: 10 + fast * 20 }
}

// basic takes up what the basic autopilot holds, from the jet as it is: the
// pitch attitude, and the heading inside 5° of bank, else the roll attitude
// (2.9.2.1).
function basic(ap: Autopilot, s: Sense): void {
  ap.pitch = clamp(s.pitch, -PITCH, PITCH)
  ap.lateral = Math.abs(s.bank) <= LEVEL ? 'heading' : 'bank'
  ap.heading = s.heading
  ap.bank = clamp(s.bank, -BANK, BANK)
}
// refuse: the AUTO PILOT caution for an autopilot that did not engage, or let go
// by itself.
function refuse(ap: Autopilot, s: Sense): false {
  ap.caution = s.time + WARNED
  return false
}
function release(ap: Autopilot): void {
  ap.engaged = false
  for (const mode of MODES) ap.modes[mode] = false
  ap.hands = { pitch: false, roll: false }
}
// uncouple lets the steering source go. The carrier's commands flew both axes,
// so everything goes with them, back to the pilot's controls (24.6.1.2.3); a
// steering or a traffic control couple falls back to the basic autopilot's
// heading hold (24.2.9.3, 24.6.1.2.2). warned: it let go by itself - the AUTO PILOT caution,
// and the coupled cue flashing (24.2.9.3); not for the pilot's own deselection
// nor a point reached.
export function uncouple(ap: Autopilot, s: Sense, warned: boolean): void {
  if (!ap.modes.coupled) return
  if (ap.source === 'bank') release(ap)
  else {
    ap.modes.coupled = false
    basic(ap, s)
    ap.lateral = 'heading' // whatever the bank it was let go in
  }
  if (warned) {
    refuse(ap, s)
    ap.flash = s.time + WARNED
  }
}
// engage: the ON/OFF pushbutton on the A/P page - the basic autopilot on, or
// everything off (2.9.2.1).
export function engage(ap: Autopilot, s: Sense): boolean {
  if (ap.engaged) {
    release(ap)
    return true
  }
  if (!able(s)) return refuse(ap, s)
  ap.engaged = true
  ap.pull = 0
  basic(ap, s)
  return true
}
// select: an option pushbutton. A mode not selected is selected, the basic
// autopilot coming on with it without ON/OFF; one selected loses its colon,
// which leaves the basic autopilot engaged (2.9.2.1). ATTH holds the pitch and
// roll attitude of the moment; HSEL turns to the heading selected; BALT and
// RALT capture the altitude of the moment, either lateral mode with them;
// CPL couples to the steering source there is and takes ATTH and HSEL off, and
// the altitude holds too when the source flies the pitch axis (2.9.2.2 to
// 2.9.2.6, 24.6.1.2).
export function select(ap: Autopilot, mode: Mode, s: Sense): boolean {
  if (ap.modes[mode]) {
    if (mode === 'coupled') uncouple(ap, s, false)
    else {
      ap.modes[mode] = false
      if (mode === 'attitude' || mode === 'select') basic(ap, s)
      else ap.pitch = clamp(s.pitch, -PITCH, PITCH)
    }
    return true
  }
  if (!able(s) || !offered(ap, s)[mode]) {
    if (mode === 'coupled') ap.flash = s.time + WARNED
    return refuse(ap, s)
  }
  if (!ap.engaged) {
    ap.engaged = true
    ap.pull = 0
    basic(ap, s)
  }
  ap.modes[mode] = true
  if (mode === 'attitude') {
    ap.modes.select = false
    ap.pitch = clamp(s.pitch, -PITCH, PITCH)
    ap.bank = clamp(s.bank, -BANK, BANK)
  } else if (mode === 'select') ap.modes.attitude = false
  else if (mode === 'coupled') {
    ap.modes.attitude = ap.modes.select = false
    ap.source = (s.couple as Couple).axis
    ap.command = s.bank
    ap.flash = -Infinity
    if (ap.source === 'bank') {
      ap.modes.barometric = ap.modes.radar = false
      ap.pull = 0
    }
  } else {
    ap.modes[mode === 'barometric' ? 'radar' : 'barometric'] = false
    ap.altitude = mode === 'radar' ? (s.height as number) : s.altitude
    ap.pull = 0
  }
  return true
}
// paddle: the autopilot disengage switch on the stick takes every mode off,
// and the AUTO PILOT caution and a flashing coupled cue with them (2.9.1,
// 2.9.2.1, 24.2.9.3).
export function paddle(ap: Autopilot): void {
  release(ap)
  ap.caution = ap.flash = -Infinity
}

// cautions and advisories, as the DDI words them (2.9.1).
export function cautions(ap: Autopilot, time: number): string[] {
  return time < ap.caution ? ['AUTO PILOT'] : []
}
export function advisories(ap: Autopilot): string[] {
  return ap.engaged ? ['A/P', ...MODES.filter((mode) => ap.modes[mode]).map((mode) => LABELS[mode])] : []
}
// cue: whether the coupled cue shows on the HUD and HSI - steady while
// coupled, flashing twice a second for ten seconds after a couple that failed
// or let go by itself (24.2.9.3, 24.6.1.1.2).
export function cue(ap: Autopilot, time: number): boolean {
  return ap.modes.coupled || (time < ap.flash && Math.floor(time * 4) % 2 === 0)
}

// step flies a frame: the stick for each axis the autopilot holds, null for an
// axis the pilot has. On the wheels it is off. It lets go by itself, with the
// caution, when the INS's attitude or mission computer 1 is lost (25.1.1); a
// couple whose source is gone or has changed, and radar altitude hold out of
// the altimeter's reach, drop out the same way. A stick moved is control stick
// steering: the axis is the pilot's until it is let go, when the references
// are taken up afresh - pitch stick takes BALT and RALT off (2.9.2.3), half an
// inch of roll stick decouples (2.9.2.6), either stick lets the carrier's
// commands go (24.6.1.2.3), and under HSEL the turn simply resumes.
export function step(ap: Autopilot, s: Sense, dt: number): { pitch: number | null; roll: number | null } {
  const none = { pitch: null, roll: null }
  const tick = Math.max(dt, 1e-3)
  ap.acceleration += ((s.vertical - ap.vertical) / tick - ap.acceleration) * Math.min(1, tick * 4)
  ap.vertical = s.vertical
  if (!ap.engaged) return none
  if (!s.airborne) {
    release(ap)
    return none
  }
  if (!s.attitude || !s.computer) {
    if (ap.modes.coupled) ap.flash = s.time + WARNED
    release(ap)
    refuse(ap, s)
    return none
  }
  const nose = Math.abs(s.stick.pitch) > HAND
  const wing = Math.abs(s.stick.roll) > (ap.modes.coupled && ap.source !== 'bank' ? DECOUPLE : HAND)
  if (ap.modes.coupled && (s.couple === null || s.couple.axis !== ap.source || wing || (nose && ap.source === 'bank'))) uncouple(ap, s, true)
  if (!ap.engaged) return none
  if (ap.modes.radar && (s.height === null || s.height > CEILING)) {
    ap.modes.radar = false
    ap.pitch = clamp(s.pitch, -PITCH, PITCH)
    refuse(ap, s)
  }
  const couple = ap.modes.coupled ? (s.couple as Couple) : null

  // pitch: the pilot's stick, the trim switch, or the hold
  if (nose) {
    ap.modes.barometric = ap.modes.radar = false
    ap.pitch = clamp(s.pitch, -PITCH, PITCH)
  } else if (ap.hands.pitch) ap.pitch = clamp(s.pitch, -PITCH, PITCH)
  else if (!ap.modes.barometric && !ap.modes.radar) ap.pitch = clamp(ap.pitch + s.trim.pitch * NOSE * dt, -PITCH, PITCH)
  ap.hands.pitch = nose

  // roll: the same
  const held = ap.modes.attitude || (ap.lateral === 'bank' && !ap.modes.select && !couple)
  if (!wing && ap.hands.roll) {
    if (!ap.modes.select && !couple) basic(ap, { ...s, pitch: ap.pitch })
  } else if (!wing) {
    if (held) ap.bank = clamp(ap.bank + s.trim.roll * WING * dt, -BANK, BANK)
    else if (!ap.modes.select && !couple) ap.heading = (((ap.heading + s.trim.roll * WING * dt) % 360) + 360) % 360
  }
  ap.hands.roll = wing

  // the bank wanted, and the stick that rolls to it
  let roll: number | null = null
  if (!wing) {
    let want: number
    if (couple) {
      const limit = bound(s)
      const target =
        couple.axis === 'bank'
          ? clamp(couple.value, -ROLL, ROLL)
          : couple.axis === 'heading'
            ? clamp(wrap(couple.value - s.heading) * 2.5, -TURN, TURN)
            : clamp(wrap(couple.value - s.track) * 2.5, -limit.bank, limit.bank)
      const most = (couple.axis === 'track' ? limit.rate : 10) * dt
      ap.command += clamp(target - ap.command, -most, most)
      want = ap.command
    } else if (ap.modes.select) want = clamp(wrap(s.selected - s.heading) * 2.5, -TURN, TURN)
    else if (held) want = ap.bank
    else want = clamp(wrap(ap.heading - s.heading) * 2.5, -TURN, TURN)
    roll = clamp((want - s.bank) * (s.approach ? 0.045 : 0.022) - s.roll * 0.18, -0.7, 0.7)
  }

  // the path wanted, and the stick that flies it
  let pitch: number | null = null
  if (!nose) {
    const upright = Math.cos(clamp(Math.abs(s.bank), 0, 75) * DEGREE)
    // An altitude hold flies a rate of climb toward the altitude, the carrier's
    // commands give the rate itself, and an attitude hold flies the nose.
    const want =
      couple && couple.vertical !== null
        ? clamp(couple.vertical, SINK, CLIMB)
        : ap.modes.barometric || ap.modes.radar
          ? clamp((ap.altitude - (ap.modes.radar ? (s.height as number) : s.altitude)) * K.close, -8, 8)
          : null
    if (s.approach) {
      // The powered approach law: the stick moves the angle of attack about
      // the law's own datum, and the bank's share of the lift with it.
      const share = 1 / upright - 1
      const k = K.approach
      if (want !== null) {
        ap.pull = clamp(ap.pull * (1 - dt / k.leak) + (want - s.vertical) * k.learn * dt, -0.12, 0.12)
        pitch = clamp((want - s.vertical) * k.path - ap.acceleration * k.damp + share + ap.pull, -0.5, 0.5)
      } else pitch = clamp((ap.pitch - s.pitch) * k.attitude - s.rate * k.rate + share, -0.5, 0.5)
    } else if (want !== null) {
      ap.pull = clamp(ap.pull * (1 - dt / K.leak) + (want - s.vertical) * K.learn * dt, -0.1, 0.12)
      const load = clamp(1 / upright + (want - s.vertical) * K.path - ap.acceleration * K.damp, 0.6, 4)
      pitch = clamp((load - 1) / G_SPAN + ap.pull, -0.3, 0.5)
    } else {
      ap.pull = clamp(ap.pull + (ap.pitch - s.pitch) * K.trim * dt, -0.1, 0.12)
      const load = clamp(1 / upright + (ap.pitch - s.pitch) * K.attitude - (s.rate / DEGREE) * K.rate, 0.6, 3)
      pitch = clamp((load - 1) / G_SPAN + ap.pull, -0.3, 0.5)
    }
  }
  return { pitch, roll }
}
