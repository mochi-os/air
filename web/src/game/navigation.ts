// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The navigation suite the mission computer keeps (NATOPS A1-F18AC-NFM-000
// chapter 24), for the jet the game flies: an AN/ASN-139 ring laser INS with
// GPS, MC OFP 13C. The INS and its mode select knob, alignment and drift
// (24.1.6.1, 24.2.1, 24.2.3); GPS and the aided INS (24.2.1.3, 24.2.1.5); the
// position keeping sources and their reversion (24.2.6); position updates
// (24.2.7); waypoints, offset aimpoints, marks and sequences (24.2.5); the
// steering to them (24.2.9) and designation (24.2.10). Pure: the engine feeds
// it what the sensors measure each step and draws what it holds. Metres in the
// flat world (x east, z south), radians true clockwise from north, seconds.

import { position as degrees, metres } from './acmi'

const NM = 1852
const KNOT = NM / 3600
const TURN = Math.PI * 2

export interface Fix {
  x: number
  z: number
}

// ---- the INS ----

// KNOB: the mode select knob's positions, clockwise (24.1.6.1, FO-5).
export const KNOB = ['off', 'cv', 'gnd', 'nav', 'ifa', 'gyro', 'gb', 'test'] as const
export type Knob = (typeof KNOB)[number]

// LEVEL: the platform levels, NO ATT showing, for the first 10 to 25 s of an
// AN/ASN-139 alignment (24.2.3.4). SETTLE: the time it must spend at OFF before
// it will start again (24.2.3.1.2). GAP: an IFA GPS holds this long for lost
// satellites before it goes on as a radar IFA (24.2.3.4.1).
export const LEVEL = 20
export const SETTLE = 5
export const GAP = 65
// The quality number against alignment time: 99.9 as the platform levels, 0.5
// the lowest displayed (24.2.3.2). The curve passes figure 24-4's 18.8 at 1:08
// and reaches 0.5 at eight minutes, a carrier alignment being "normally less
// than 10 minutes" (24.2.3.1.2). NATOPS gives no curve: the shape is a fit.
const BEND = 39
const POWER = 2.08
export const COMPLETE = 0.5
// VALID: the INS's velocities become valid at about quality 5 (24.2.3.4).
export const VALID = 5
// RATES: how fast each alignment runs against the carrier one. A manual carrier
// alignment takes about 15 minutes (24.2.3.1.3) and a GPS IFA about 10
// (24.2.3.4.1); a stored heading alignment is given only as shorter
// (24.2.3.2.1), and the two minutes here are a judgement.
export const RATES = { cv: 1, gnd: 1, manual: 460 / 880, ifa: 460 / 580, stored: 460 / 100 }
// DRIFT: a fully aligned INS wanders about a nautical mile an hour.
export const DRIFT = KNOT

export type Mode = 'off' | 'align' | 'nav' | 'gyro' | 'bias' | 'test'

export interface Ins {
  knob: Knob
  applied: Knob // the position the INS last acted on
  mode: Mode
  kind: '' | 'cv' | 'gnd' | 'ifa' // the alignment in hand
  manual: boolean // CV MAN selected
  stored: boolean // STD HDG selected
  heading: boolean // a stored heading is there to use
  time: number // the alignment display's TIME
  progress: number // alignment achieved, in carrier-alignment seconds
  held: boolean // the alignment is interrupted: TIME stops and flashes
  radar: boolean // an IFA aligning on the radar, not GPS
  lapse: number // seconds an IFA GPS has gone without satellites
  partial: boolean // navigating on an incomplete alignment: the ALGN advisory
  dark: number // seconds spent at OFF since it last shut down
  error: Fix // INS position less the true one
  drift: Fix // the rate that error grows, m/s
  angle: number // which way this INS drifts
  motion: Fix // the deck's velocity as a manual carrier alignment was given it, less the true one, m/s
  aided: { position: number; velocity: number; held: boolean } // the aided INS's update clocks, and its velocities corrected
}

// quality is the alignment display's QUAL for the progress made: null while the
// platform levels (NO ATT), then 99.9 down to 0.5.
export function quality(progress: number): number | null {
  if (progress < LEVEL) return null
  return Math.max(COMPLETE, 99.9 / (1 + (progress - LEVEL) / BEND) ** POWER)
}
function finished(ins: Ins): boolean {
  const q = quality(ins.progress)
  return q !== null && q <= COMPLETE
}
// attitude: the INS gives attitude once powered and levelled. velocity: its
// velocities are valid, navigating or far enough into an alignment.
export function attitude(ins: Ins): boolean {
  return ins.mode !== 'off' && ins.progress >= LEVEL
}
export function velocity(ins: Ins): boolean {
  if (ins.mode === 'nav') return true
  const q = quality(ins.progress)
  return ins.mode === 'align' && q !== null && q <= VALID
}

// ---- GPS ----

// ACQUIRE: satellite acquisition "may take up to 12 minutes" (24.2.6). HERR
// and VERR: the estimated errors while tracking, metres; GPS data is good with
// each under 100 ft. NORM and APPR: the flight phase limits on the horizontal
// error (24.2.5.7.3).
export const ACQUIRE = 720
export const HERR = 10
export const VERR = 15
const GOOD = 100 * 0.3048
export const NORM = 333
export const APPR = 33

export interface Gps {
  on: boolean
  search: number // seconds until it tracks
  secure: boolean // NOSEC GPS unboxed (24.2.5.7.2)
  phase: 'norm' | 'appr'
  error: Fix // GPS position less the true one
  over: number // seconds the horizontal error has been past the APPR limit
}
export function tracking(gps: Gps): boolean {
  return gps.on && gps.search <= 0
}
// horizontal and vertical: the estimated errors as the A/C data display reads
// them, metres; null when no satellites are tracked.
export function horizontal(gps: Gps): number | null {
  return tracking(gps) ? Math.hypot(gps.error.x, gps.error.z) : null
}
export function vertical(gps: Gps): number | null {
  return tracking(gps) ? VERR : null
}
export function good(gps: Gps): boolean {
  const h = horizontal(gps)
  return h !== null && h < GOOD && VERR < GOOD
}

// ---- waypoints ----

export const WAYPOINTS = 60 // 0 to 59 with MC OFP 13C (24.2.5.1)
export const MARKS = 9
export const LEGS = 15 // waypoints to a sequence (24.2.5.5)
export const SEQUENCES = 3
export const STATIONS = 10 // stored TACAN stations (24.4.3)

export interface Offset {
  range: number
  bearing: number
  elevation: number
}
export interface Waypoint extends Fix {
  elevation: number
  name: string // a GPS point's ID code, kept when one is transferred (24.2.5.1.1)
  offset: Offset | null // an offset makes it an offset aimpoint
}
export interface Station extends Fix {
  channel: number
  band: 'X' | 'Y'
  elevation: number
  name: string
  variation?: number // the station's magnetic variation, east positive (24.4.3)
}
export interface Named extends Fix {
  name: string
  elevation: number
}
export interface Designation extends Fix {
  elevation: number
  stage: 'oap' | 'tgt' // an OAP designated waits for O/S to add its offset
}
export type Source = 'ains' | 'ins' | 'gps' | 'adc' | 'tcn'
export const SOURCES: readonly Source[] = ['ains', 'ins', 'gps', 'adc']
export interface Update {
  kind: 'tcn' | 'gps' | 'dsg' | 'map'
  delta: Fix // the onboard position less the computed one
}

export interface Navigation {
  ins: Ins
  gps: Gps
  adc: { error: Fix; wind: Fix }
  source: Source
  reverted: boolean // position keeping fell to the ADC by itself: POS/ADC
  bias: number // the TACAN's bearing error, radians
  waypoints: (Waypoint | null)[]
  marks: (Waypoint | null)[]
  mark: number // the next mark, 0 for MK1
  current: number // the steer-to point: 0 to 59, then the marks
  steer: '' | 'wypt' | 'tcn'
  course: number | null // the selected course, true, with a course line on show
  kept: number // where the course select switch last left it
  heading: number // the heading select marker, true
  sequences: number[][]
  sequence: number
  lines: boolean // SEQ # boxed: the sequence drawn
  auto: boolean
  designation: Designation | null
  target: number | null // the sequence's target waypoint
  tot: number | null // time on target, seconds of the day
  speed: number // the groundspeed entered for the final leg, kt, 0 for none
  updating: '' | 'dsg' | 'auto' | 'map'
  update: Update | null // awaiting ACPT or REJ
  previous: { source: Source; error: Fix } | null // what CANCEL puts back
  slew: Fix // the map slewed under the designation, m
  stations: Station[]
  station: number
  points: Named[] // the GPS's stored points
  memory: { identifier: string; files: string[]; loaded: string[] }
  magnetic: boolean // HDG MAG selected
  variation: number // magnetic variation, east positive
  decimal: boolean // LATLN DCML
  precise: boolean // PRECISE boxed: hundredths of a second, and the grid to a metre (24.2.5.1)
  units: { waypoint: Unit; offset: Unit; station: Unit; range: Unit } // what a waypoint's, an offset's and a TACAN station's elevation and an offset's range are entered and shown in (24.2.5.1.2)
  meridian: 'true' | 'magnetic' // what an offset's bearing is entered and shown against
  local: boolean // TCN MGVAR: the TACAN station's own variation for its readouts, not the aircraft's (24.4.3.1)
  home: number // the FPAS home waypoint
  span: number // the world's wrap, 0 for none
}

// What the sensors measure in one step.
export interface Truth extends Fix {
  dt: number
  east: number // ground velocity, m/s
  south: number
  tas: number
  heading: number
  pitch: number
  bank: number
  airborne: boolean
  brake: boolean // parking brake set
  power: boolean
  radar: boolean // the radar can give the INS its velocities (operating, NAV master mode)
  deck: boolean // aboard the ship: its inertial system reaches the jet
  tacan: (Fix & { bearing: number; range: number }) | null // a stored station received with range: where it is, and what the set reads
}

const none = (): Fix => ({ x: 0, z: 0 })
const polar = (bearing: number, range: number): Fix => ({ x: Math.sin(bearing) * range, z: -Math.cos(bearing) * range })
// noise: a number in 0..1 from a seed, the same each time.
function noise(seed: number): number {
  const v = Math.sin(seed * 12.9898 + 78.233) * 43758.5453
  return v - Math.floor(v)
}

export function fresh(seed: number, span = 0): Navigation {
  const ins: Ins = {
    knob: 'off', applied: 'off', mode: 'off', kind: '', manual: false, stored: false, heading: false, time: 0, progress: 0, held: false, radar: false, lapse: 0,
    partial: false, dark: Infinity, error: none(), drift: none(), angle: noise(seed) * TURN, motion: none(), aided: { position: 0, velocity: 0, held: false },
  }
  const gps: Gps = { on: false, search: ACQUIRE, secure: true, phase: 'norm', error: polar(noise(seed + 1) * TURN, HERR), over: 0 }
  return {
    ins, gps, adc: { error: none(), wind: none() }, source: 'adc', reverted: false, bias: (noise(seed + 2) - 0.5) * (Math.PI / 180),
    waypoints: Array.from({ length: WAYPOINTS }, () => null), marks: Array.from({ length: MARKS }, () => null), mark: 0, current: 0,
    steer: '', course: null, kept: 0, heading: 0, sequences: Array.from({ length: SEQUENCES }, () => []), sequence: 0, lines: false, auto: false,
    designation: null, target: null, tot: null, speed: 0, updating: '', update: null, previous: null, slew: none(),
    stations: [], station: 0, points: [], memory: { identifier: '', files: [], loaded: [] },
    magnetic: false, variation: 0, decimal: false, precise: false, units: { waypoint: 'feet', offset: 'feet', station: 'feet', range: 'feet' }, meridian: 'true', local: false, home: 0, span,
  }
}

// ready leaves the suite as the pre-flight does before a spawn: the INS fully
// aligned and navigating, the knob at NAV, GPS tracking, the present position in
// waypoint 0.
export function ready(nav: Navigation, truth: Fix): void {
  const ins = nav.ins
  ins.knob = ins.applied = 'nav'
  ins.mode = 'nav'
  ins.progress = LEVEL + 460
  ins.dark = 0
  ins.drift = polar(ins.angle, DRIFT)
  nav.gps.on = true
  nav.gps.search = 0
  nav.source = 'ins'
  nav.waypoints[0] = { x: truth.x, z: truth.z, elevation: 0, name: '', offset: null }
}

// ---- stepping ----

function wrap(d: number, span: number): number {
  return span > 0 ? d - Math.round(d / span) * span : d
}
function shut(ins: Ins): void {
  ins.heading = ins.mode === 'align' && ins.kind !== 'ifa' && finished(ins) // shut down after a good alignment without NAV selected: the heading is kept (24.2.3.2.1)
  ins.mode = 'off'
  ins.kind = ''
  ins.progress = 0
  ins.time = 0
  ins.held = false
  ins.partial = false
  ins.manual = false
  ins.stored = false
  ins.dark = 0
  ins.aided = { position: 0, velocity: 0, held: false }
}
// begin starts a carrier or ground alignment afresh. A ground alignment takes
// waypoint 0 for the present position, once (24.2.3.2); the ship's inertial
// system gives a carrier alignment its own.
function begin(nav: Navigation, truth: Truth, kind: 'cv' | 'gnd'): void {
  const ins = nav.ins
  ins.mode = 'align'
  ins.kind = kind
  ins.progress = 0
  ins.time = 0
  ins.manual = false
  ins.stored = false
  ins.partial = false
  const zero = nav.waypoints[0]
  ins.error = kind === 'gnd' && zero ? { x: wrap(zero.x - truth.x, nav.span), z: wrap(zero.z - truth.z, nav.span) } : none()
}
// navigate takes the INS into NAV from an alignment: with its velocities valid
// it navigates, drifting the faster the less complete the alignment; without, it
// is an attitude reference only (24.2.3.4.4). A carrier or ground alignment
// stores the present position in waypoint 0 (24.2.3.1.1).
function navigate(nav: Navigation, truth: Truth): void {
  const ins = nav.ins
  const q = quality(ins.progress) as number
  ins.partial = q > COMPLETE
  ins.heading = false
  if (q > VALID) {
    ins.mode = 'gyro'
    return
  }
  if (ins.kind === 'ifa') ins.error = { ...offset(nav, truth) } // an inflight alignment takes up the position the jet was keeping
  ins.mode = 'nav'
  ins.drift = polar(ins.angle, DRIFT * (q / COMPLETE))
  if (ins.kind === 'cv' && ins.manual) {
    // a manual carrier alignment tracked the deck by the heading and speed entered: what they got wrong stays as a velocity error (24.2.3.1.3)
    ins.drift.x += ins.motion.x
    ins.drift.z += ins.motion.z
  }
  if (ins.kind !== 'ifa') nav.waypoints[0] = { x: truth.x + ins.error.x, z: truth.z + ins.error.z, elevation: nav.waypoints[0]?.elevation ?? 0, name: '', offset: null }
  nav.source = ins.knob === 'ifa' && good(nav.gps) ? 'ains' : 'ins'
  nav.reverted = false
}
// apply acts on the knob where it now stands (24.1.6.1).
function apply(nav: Navigation, truth: Truth): void {
  const ins = nav.ins
  const knob = ins.knob
  ins.applied = knob
  if (knob === 'off') {
    if (ins.mode !== 'off') shut(ins)
    return
  }
  if (ins.mode === 'off') {
    if (ins.dark < SETTLE || !truth.power) return // not yet: back to OFF and wait
    ins.error = { ...offset(nav, truth) }
  }
  const leaving = ins.mode === 'nav'
  switch (knob) {
    case 'cv':
    case 'gnd':
      begin(nav, truth, knob)
      break
    case 'nav':
      if (ins.mode === 'off' || ins.mode === 'bias' || ins.mode === 'test') {
        ins.mode = 'align'
        ins.kind = 'ifa'
        ins.radar = !good(nav.gps)
      }
      break // an alignment in hand is taken into NAV by step once the platform is level
    case 'ifa':
      if (ins.mode === 'nav' && !ins.partial) break // aligned: the aided INS, with satellites
      ins.mode = 'align'
      ins.kind = 'ifa'
      ins.time = 0
      ins.lapse = 0
      ins.radar = !good(nav.gps) // without satellites at the start it is a radar IFA at once
      break
    case 'gyro':
    case 'gb':
    case 'test':
      ins.mode = knob === 'gyro' ? 'gyro' : knob === 'gb' ? 'bias' : 'test'
      ins.progress = Math.min(ins.progress, LEVEL) // the platform stays level; the navigation is given up
      ins.partial = false
      break
  }
  if (leaving && ins.mode !== 'nav') ins.aided = { position: 0, velocity: 0, held: false }
}
// align runs the alignment in hand for one step.
function align(nav: Navigation, truth: Truth): void {
  const ins = nav.ins
  let rate = 0
  if (ins.kind === 'ifa') {
    const satellites = good(nav.gps)
    ins.lapse = satellites ? 0 : ins.lapse + truth.dt
    if (satellites) ins.radar = false
    else if (ins.lapse >= GAP) ins.radar = true
    if (truth.airborne && satellites) rate = RATES.ifa
    else if (truth.airborne && ins.radar && truth.radar && Math.abs(truth.bank) <= Math.PI / 6) rate = RATES.ifa // a radar IFA holds through a turn past 30° of bank (24.2.3.4.2)
  } else if (truth.brake && !truth.airborne && (ins.kind === 'gnd' || ins.manual || truth.deck)) {
    rate = ins.stored ? RATES.stored : ins.manual ? RATES.manual : ins.kind === 'cv' ? RATES.cv : RATES.gnd
  }
  const flown = ins.kind !== 'ifa' && truth.airborne && Math.hypot(truth.east, truth.south) > 80 * KNOT // off the ground past 80 knots, the INS goes to NAV by itself (24.2.3.1.1)
  ins.held = rate === 0
  if (!ins.held) {
    ins.time += truth.dt
    ins.progress += truth.dt * (ins.progress < LEVEL ? 1 : rate)
  } else if (flown && ins.progress < LEVEL) ins.progress += truth.dt // the platform goes on levelling in the air
  const level = ins.progress >= LEVEL
  if (ins.kind === 'ifa') {
    if (finished(ins) || (ins.knob === 'nav' && level)) navigate(nav, truth)
  } else if (level && (ins.knob === 'nav' || flown)) navigate(nav, truth)
}

// available: the position keeping sources that can be selected now (24.2.6).
// The aided INS needs the knob at IFA and good satellites; TACAN a stored
// station received with range.
export function available(nav: Navigation, truth: Truth): Record<Source, boolean> {
  const ins = nav.ins.mode === 'nav'
  const satellites = good(nav.gps)
  return { ains: ins && satellites && nav.ins.knob === 'ifa', ins, gps: satellites, adc: true, tcn: !!truth.tacan }
}
// offset: the error of the position being kept - the selected source's.
export function offset(nav: Navigation, truth: Truth): Fix {
  switch (nav.source) {
    case 'ains':
    case 'ins':
      return nav.ins.error
    case 'gps':
      return nav.gps.error
    case 'tcn':
      if (truth.tacan) {
        const read = polar(truth.tacan.bearing + nav.bias, truth.tacan.range)
        const real = polar(truth.tacan.bearing, truth.tacan.range)
        return { x: real.x - read.x, z: real.z - read.z }
      }
      return nav.adc.error
    default:
      return nav.adc.error
  }
}
// place: the aircraft's present position as the mission computer has it.
export function place(nav: Navigation, truth: Truth): Fix {
  const e = offset(nav, truth)
  return { x: truth.x + e.x, z: truth.z + e.z }
}
// select chooses a position keeping source by hand; false when it has no data.
export function select(nav: Navigation, truth: Truth, source: Source): boolean {
  if (!available(nav, truth)[source]) return false
  nav.source = source
  nav.reverted = false
  return true
}

export function step(nav: Navigation, truth: Truth): void {
  const ins = nav.ins
  const gps = nav.gps
  const dt = truth.dt
  // GPS: on with the aircraft's power, tracking once it has its satellites
  if (!truth.power) {
    gps.on = false
    gps.search = ACQUIRE
  } else {
    gps.on = true
    gps.search = Math.max(0, gps.search - dt)
  }
  const h = horizontal(gps)
  gps.over = h !== null && h > APPR ? gps.over + dt : 0
  // the INS: a power loss shuts it down, and its time at OFF starts over, so it wants the knob there before it restarts (24.2.3.1.2)
  if (!truth.power && ins.mode !== 'off') shut(ins)
  if (ins.knob === 'off') ins.dark += dt
  if (ins.knob !== ins.applied || (ins.mode === 'off' && ins.knob !== 'off')) apply(nav, truth)
  if (ins.mode === 'align') align(nav, truth)
  else if (ins.mode !== 'off' && ins.mode !== 'nav' && ins.progress < LEVEL) ins.progress += dt // an attitude-only mode levels its platform too
  if (ins.mode === 'nav') {
    const aided = ins.knob === 'ifa' && good(gps) && !ins.partial
    if (aided) {
      // the aided INS: the velocities corrected every 5 s, the position every 40 (24.2.1.5)
      ins.aided.velocity += dt
      ins.aided.position += dt
      if (ins.aided.velocity >= 5) {
        ins.aided.velocity = 0
        ins.aided.held = true
      }
      if (ins.aided.position >= 40) {
        ins.aided.position = 0
        ins.error = { ...gps.error }
      }
    } else ins.aided = { position: 0, velocity: 0, held: false }
    if (!ins.aided.held) {
      ins.error.x += ins.drift.x * dt
      ins.error.z += ins.drift.z * dt
    }
  }
  // position keeping: a source that has lost its data gives way down the hierarchy (24.2.6)
  const have = available(nav, truth)
  if (ins.mode === 'nav' && ins.knob === 'ifa' && have.ains && nav.source === 'ins') nav.source = 'ains' // the knob at IFA selects the aided INS
  if (nav.source === 'ains' && ins.knob !== 'ifa' && have.ins) nav.source = 'ins'
  if (!have[nav.source]) {
    const from = nav.source
    nav.source = SOURCES.find((s) => have[s]) as Source
    if (nav.source === 'adc' && (from === 'ins' || from === 'ains')) nav.reverted = true
  }
  if (nav.source !== 'adc') nav.reverted = false
  // air data: the wind is found while there are true velocities to find it from; dead reckoning runs on the last one
  const air = { x: truth.tas * Math.cos(truth.pitch) * Math.sin(truth.heading), z: -truth.tas * Math.cos(truth.pitch) * Math.cos(truth.heading) }
  if (velocity(ins) || good(gps)) nav.adc.wind = { x: truth.east - air.x, z: truth.south - air.z }
  if (nav.source === 'adc') {
    nav.adc.error.x += (air.x + nav.adc.wind.x - truth.east) * dt
    nav.adc.error.z += (air.z + nav.adc.wind.z - truth.south) * dt
  } else nav.adc.error = { ...offset(nav, truth) } // dead reckoning starts from the last position kept
}

// alignment: what the align display shows (figures 24-3 to 24-6), or null with
// none in hand.
export function alignment(nav: Navigation): { title: string; quality: number | null; time: number; held: boolean; complete: boolean } | null {
  const ins = nav.ins
  if (ins.mode !== 'align') return null
  const title = ins.kind === 'cv' ? (ins.manual ? 'CV MAN' : 'CV RF') : ins.kind === 'gnd' ? 'GRND' : ins.radar ? 'IFA RDR' : 'IFA GPS'
  return { title, quality: quality(ins.progress), time: ins.time, held: ins.held, complete: finished(ins) }
}
// manual selects the manual carrier alignment; stored the stored heading one,
// while it would still shorten the alignment (24.2.3.2.1).
export function manual(nav: Navigation): boolean {
  const ins = nav.ins
  if (ins.mode !== 'align' || ins.kind !== 'cv') return false
  ins.manual = !ins.manual
  ins.stored = false
  return true
}
// carrier gives a manual carrier alignment the ship's heading and speed
// (24.2.3.1.4). The game's ship holds still, so any speed given is error.
export function carrier(nav: Navigation, heading: number, speed: number): void {
  nav.ins.motion = polar(heading, speed)
}
export function storable(nav: Navigation): boolean {
  const ins = nav.ins
  return ins.mode === 'align' && ins.kind !== 'ifa' && ins.heading && !ins.stored && !ins.manual && ins.progress < LEVEL + 100
}
export function stored(nav: Navigation): boolean {
  if (!storable(nav)) return false
  nav.ins.stored = true
  return true
}
// locate enters the present position by hand (24.2.5.6): the kept position
// becomes the one given.
export function locate(nav: Navigation, truth: Truth, fix: Fix): void {
  const error = { x: wrap(fix.x - truth.x, nav.span), z: wrap(fix.z - truth.z, nav.span) }
  if (nav.source === 'adc' || nav.ins.mode !== 'nav') nav.adc.error = { ...error }
  if (nav.ins.mode !== 'off') nav.ins.error = error
}

// ---- cautions, advisories and the HUD ----

// cautions: INS ATT without INS attitude, POS/ADC when position keeping has
// fallen to the air data computer, GPS DEGD when GPS keeps the position in the
// approach phase and its error has been past 33 m for ten seconds (24.2.5.7.3).
export function cautions(nav: Navigation): string[] {
  const out: string[] = []
  if (!attitude(nav.ins)) out.push('INS ATT')
  if (nav.reverted) out.push('POS/ADC')
  if (nav.source === 'gps' && nav.gps.phase === 'appr' && nav.gps.over >= 10) out.push('GPS DEGD')
  return out
}
// advisories: ALGN for an INS navigating on an incomplete alignment
// (24.2.3.3), NO SEC with GPS out of its secure mode (24.2.1.3.3), GPS in the
// normal phase with its error past 333 m.
export function advisories(nav: Navigation): string[] {
  const out: string[] = []
  if (nav.ins.partial && (nav.ins.mode === 'nav' || nav.ins.mode === 'gyro')) out.push('ALGN')
  if (!nav.gps.secure) out.push('NO SEC')
  const h = horizontal(nav.gps)
  if (nav.source === 'gps' && nav.gps.phase === 'norm' && h !== null && h > NORM) out.push('GPS')
  return out
}
// vector: how the HUD shows the flight path (2.13.4.8.13). The waterline symbol
// stands in for the velocity vector without INS attitude, or with the attitude
// switch at STBY; the velocity vector flashes slowly on air data velocities, and
// is steady again on GPS ones.
export function vector(nav: Navigation, reference: 'ins' | 'auto' | 'stby'): 'vector' | 'flash' | 'waterline' {
  if (reference === 'stby' || !attitude(nav.ins)) return 'waterline'
  if (velocity(nav.ins) || good(nav.gps)) return 'vector'
  return 'flash'
}

// ---- waypoints, marks and sequences ----

// spot: a steer-to number's point - a waypoint, or past the last one a mark.
export function spot(nav: Navigation, index: number): Waypoint | null {
  return index < WAYPOINTS ? nav.waypoints[index] : (nav.marks[index - WAYPOINTS] ?? null)
}
// label: the number as the displays write it, M ahead of a mark's.
export function label(index: number): string {
  return index < WAYPOINTS ? String(index) : 'M' + (index - WAYPOINTS + 1)
}
// aim: where an offset aimpoint's offset lies.
export function aim(point: Waypoint): Fix & { elevation: number } {
  if (!point.offset) return { x: point.x, z: point.z, elevation: point.elevation }
  const d = polar(point.offset.bearing, point.offset.range)
  return { x: point.x + d.x, z: point.z + d.z, elevation: point.offset.elevation }
}
// advance steps the steer-to point with the arrows (24.1.3.11.1): through the
// waypoints, then the marks there are; with AUTO boxed, through the sequence
// (24.2.9.4). A new point starts direct great circle steering afresh (24.2.9.2).
export function advance(nav: Navigation, direction: number): void {
  const step = direction < 0 ? -1 : 1
  if (nav.auto) {
    const list = nav.sequences[nav.sequence]
    const at = list.indexOf(nav.current)
    nav.current = list[(Math.max(at, 0) + step + list.length) % list.length]
  } else {
    const count = WAYPOINTS + MARKS
    let next = nav.current
    do next = (next + step + count) % count
    while (next >= WAYPOINTS && !nav.marks[next - WAYPOINTS])
    nav.current = next
  }
  nav.course = null
}
// mark stores a mark point (24.1.3.9): the designated location with one, else
// the point overflown with its elevation zero. The tenth replaces MK1.
export function mark(nav: Navigation, here: Fix): number {
  const at = nav.mark
  const d = nav.designation
  nav.marks[at] = d ? { x: d.x, z: d.z, elevation: d.elevation, name: '', offset: null } : { x: here.x, z: here.z, elevation: 0, name: '', offset: null }
  nav.mark = (at + 1) % MARKS
  return at
}
// insert puts a waypoint into the selected sequence (24.2.5.5): after the one
// named when that is given, else at the end. A waypoint appears once; marks are
// not taken; a full sequence loses its first.
export function insert(nav: Navigation, index: number, after: number | null = null): boolean {
  const list = nav.sequences[nav.sequence]
  if (index < 0 || index >= WAYPOINTS || list.includes(index)) return false
  if (after !== null && !list.includes(after)) return false
  if (after === null) list.push(index)
  else list.splice(list.indexOf(after) + 1, 0, index)
  if (list.length > LEGS) list.shift()
  return true
}
export function remove(nav: Navigation, index: number): boolean {
  const list = nav.sequences[nav.sequence]
  const at = list.indexOf(index)
  if (at < 0) return false
  list.splice(at, 1)
  if (nav.target === index && !nav.sequences.some((s) => s.includes(index))) nav.target = null
  if (list.length < 2) nav.auto = false
  return true
}
// cycle works the SEQ # option (24.1.3.13): unboxed, boxed, then the next
// sequence.
export function cycle(nav: Navigation): void {
  if (!nav.lines) nav.lines = true
  else {
    nav.lines = false
    nav.sequence = (nav.sequence + 1) % SEQUENCES
    if (nav.sequences[nav.sequence].length < 2) nav.auto = false
  }
}
// automatic toggles AUTO sequential steering (24.1.3.14): it needs two
// waypoints in the sequence, and starts on the first.
export function automatic(nav: Navigation): boolean {
  if (nav.auto) {
    nav.auto = false
    return true
  }
  const list = nav.sequences[nav.sequence]
  if (list.length < 2 || nav.designation || nav.updating === 'auto') return false
  nav.auto = true
  nav.steer = 'wypt'
  nav.current = list[0]
  nav.course = null
  return true
}

// ---- steering ----

export interface Leg {
  bearing: number
  range: number
}
export function leg(nav: Navigation, from: Fix, to: Fix): Leg {
  const dx = wrap(to.x - from.x, nav.span)
  const dz = wrap(to.z - from.z, nav.span)
  return { bearing: (Math.atan2(dx, -dz) + TURN) % TURN, range: Math.hypot(dx, dz) }
}
// goal: the point steered to - the designated target, else the steer-to
// waypoint (an offset aimpoint's own position until its offset is designated).
export function goal(nav: Navigation): (Fix & { elevation: number; kind: 'tgt' | 'oap' | 'wypt' }) | null {
  const d = nav.designation
  const point = spot(nav, nav.current)
  if (d) return { x: d.x, z: d.z, elevation: d.elevation, kind: d.stage === 'oap' ? 'oap' : 'tgt' }
  if (!point) return null
  return { x: point.x, z: point.z, elevation: point.elevation, kind: point.offset ? 'oap' : 'wypt' }
}
// turn: the signed angle from one direction to another, -π to π.
export function turn(from: number, to: number): number {
  return ((((to - from) % TURN) + TURN + Math.PI) % TURN) - Math.PI
}
// command: where the HUD's command heading marker sits against the heading
// scale, degrees from its centre, for a steering error in degrees (24.2.9.1):
// the error itself within 5°, then compressed so 30° lies at the scale's end.
export function command(error: number): number {
  const size = Math.abs(error)
  const at = size <= 5 ? size : size >= 30 ? 15 : 5 + ((size - 5) * 10) / 25
  return Math.sign(error) * at
}
// deviation: how far the aircraft is off the selected course line through a
// point, degrees, positive with the line to the right; the HUD's arrow is at
// full scale at 8° (24.2.9.2). across: the same as a distance, metres.
export function deviation(bearing: number, course: number): number {
  return (turn(bearing, course) * 180) / Math.PI
}
export function across(leg: Leg, course: number): number {
  return Math.abs(Math.sin(turn(leg.bearing, course)) * leg.range)
}
// sequential moves AUTO steering on (24.2.9.4): inside 5 nm of the steer-to
// waypoint with it more than 90° off the track, the next in the sequence is
// selected and the course line dropped; past the last, AUTO is deselected.
export function sequential(nav: Navigation, here: Fix, track: number): boolean {
  if (!nav.auto || nav.updating === 'dsg') return false
  const point = spot(nav, nav.current)
  if (!point) return false
  const to = leg(nav, here, point)
  if (to.range >= 5 * NM || Math.abs(turn(track, to.bearing)) <= Math.PI / 2) return false
  const list = nav.sequences[nav.sequence]
  const at = list.indexOf(nav.current)
  if (at < 0 || at >= list.length - 1) nav.auto = false
  else {
    nav.current = list[at + 1]
    nav.course = null
  }
  return true
}
// required: the groundspeed to make the time on target, knots (24.2.9.6), or
// null without a target in a sequence and a TOT. Direct to the target it is the
// distance over the time left; with AUTO boxed the sequence's path, the final
// leg flown at the groundspeed entered when there is time for that.
export function required(nav: Navigation, here: Fix, now: number): number | null {
  if (nav.target === null || nav.tot === null || nav.steer !== 'wypt') return null
  const end = nav.waypoints[nav.target]
  const list = nav.sequences[nav.sequence]
  if (!end || !nav.sequences.some((s) => s.includes(nav.target as number))) return null
  let left = nav.tot - now
  if (left < -43200) left += 86400 // a time on target past midnight
  if (left <= 0) return 999
  const there = end.offset ? aim(end) : end
  let before = 0
  let final = 0
  const from = list.indexOf(nav.current)
  const to = list.indexOf(nav.target)
  if (nav.auto && from >= 0 && to > from) {
    before = leg(nav, here, nav.waypoints[nav.current] as Waypoint).range
    for (let k = from; k < to - 1; k++) before += leg(nav, nav.waypoints[list[k]] as Waypoint, nav.waypoints[list[k + 1]] as Waypoint).range
    final = leg(nav, nav.waypoints[list[to - 1]] as Waypoint, there).range
  } else if (nav.current === nav.target) final = leg(nav, here, there).range
  else return null
  const pace = nav.speed * KNOT
  const time = pace > 0 ? final / pace : Infinity
  const speed = before > 0 && time < left ? before / (left - time) : (before + final) / left
  return Math.min(999, speed / KNOT)
}

// set works the heading and course set switches (2.13.4.9, 2.13.4.10), by so
// many degrees: the heading select marker, or the course line through the
// point steered to, which appears when the switch is first worked with direct
// steering selected (24.1.7).
export function set(nav: Navigation, which: 'heading' | 'course', by: number): boolean {
  const radians = (by * Math.PI) / 180
  if (which === 'heading') {
    nav.heading = (((nav.heading + radians) % TURN) + TURN) % TURN
    return true
  }
  if (nav.steer === '') return false
  nav.kept = ((((nav.course ?? nav.kept) + radians) % TURN) + TURN) % TURN
  nav.course = nav.kept
  return true
}

// ---- designation ----

// designate works NAVDSG, and O/S after it on an offset aimpoint (24.2.10.1):
// the waypoint becomes the target, an OAP's offset once O/S adds it. overfly
// designates the present position as the waypoint's (24.2.10.2), an OAP's
// offset added at once.
export function designate(nav: Navigation): boolean {
  const d = nav.designation
  if (d && d.stage === 'oap') {
    const point = spot(nav, nav.current)
    if (!point) return false
    nav.designation = { ...aim(point), stage: 'tgt' }
    return true
  }
  const point = spot(nav, nav.current)
  if (d || !point) return false
  nav.designation = { x: point.x, z: point.z, elevation: point.elevation, stage: point.offset ? 'oap' : 'tgt' }
  nav.auto = false
  return true
}
export function overfly(nav: Navigation, here: Fix): boolean {
  const point = spot(nav, nav.current)
  if (!point) return false
  const d = point.offset ? polar(point.offset.bearing, point.offset.range) : none()
  nav.designation = { x: here.x + d.x, z: here.z + d.z, elevation: point.offset ? point.offset.elevation : point.elevation, stage: 'tgt' }
  nav.auto = false
  return true
}
export function undesignate(nav: Navigation): boolean {
  if (!nav.designation) return false
  nav.designation = null
  return true
}

// ---- position updates (24.2.7) ----

// updatable: updates go to the INS or the air data position, and are not
// offered while the aided INS keeps it.
export function updatable(nav: Navigation): boolean {
  return nav.source === 'ins' || nav.source === 'adc'
}
function shift(nav: Navigation, by: Fix): void {
  const error = nav.source === 'adc' ? nav.adc.error : nav.ins.error
  nav.previous = { source: nav.source, error: { ...error } }
  error.x += by.x
  error.z += by.z
}
// propose computes a position another way and holds the difference for ACPT or
// REJ: from the TACAN's bearing and range (24.4.5), from GPS, or - a designation
// update - from the waypoint just overflown, whose stored position is where the
// aircraft then was (24.2.7.1).
export function propose(nav: Navigation, truth: Truth, kind: 'tcn' | 'gps' | 'dsg', over: Fix | null = null): boolean {
  if (!updatable(nav)) return false
  const here = place(nav, truth)
  let computed: Fix | null = null
  if (kind === 'tcn' && truth.tacan) {
    const read = polar(truth.tacan.bearing + nav.bias, truth.tacan.range)
    computed = { x: truth.tacan.x - read.x, z: truth.tacan.z - read.z }
  } else if (kind === 'gps' && good(nav.gps)) computed = { x: truth.x + nav.gps.error.x, z: truth.z + nav.gps.error.z }
  else if (kind === 'dsg' && over) computed = over
  if (!computed) return false
  nav.update = { kind, delta: { x: wrap(here.x - computed.x, nav.span), z: wrap(here.z - computed.z, nav.span) } }
  return true
}
// reading: the error readout on the ACPT/REJ display, the bearing and range
// from the onboard position to the computed one.
export function reading(nav: Navigation): Leg | null {
  const u = nav.update
  if (!u) return null
  return { bearing: (Math.atan2(-u.delta.x, u.delta.z) + TURN) % TURN, range: Math.hypot(u.delta.x, u.delta.z) }
}
export function accept(nav: Navigation): boolean {
  const u = nav.update
  if (!u || !updatable(nav)) return false
  shift(nav, { x: -u.delta.x, z: -u.delta.z })
  nav.update = null
  nav.updating = ''
  nav.slew = none()
  return true
}
export function reject(nav: Navigation): boolean {
  if (!nav.update) return false
  nav.update = null
  nav.updating = ''
  nav.slew = none()
  return true
}
// cancel takes back the last update accepted (24.2.7).
export function cancel(nav: Navigation): boolean {
  const p = nav.previous
  if (!p) return false
  if (p.source === 'adc') nav.adc.error = { ...p.error }
  else nav.ins.error = { ...p.error }
  nav.previous = null
  return true
}
// overhead is an AUTO update (24.2.7.4): the TDC pressed over the steer-to
// waypoint makes its position the aircraft's, with no ACPT/REJ, and the next
// waypoint is selected.
export function overhead(nav: Navigation, truth: Truth): boolean {
  const point = spot(nav, nav.current)
  if (nav.updating !== 'auto' || !point || !updatable(nav)) return false
  const here = place(nav, truth)
  shift(nav, { x: wrap(point.x - here.x, nav.span), z: wrap(point.z - here.z, nav.span) })
  nav.updating = ''
  nav.auto = false
  advance(nav, 1)
  return true
}
// slewed is a MAP update (24.2.7.3): the map slewed until the designated point
// on it lies under the designation, the slew being the position's error.
export function slewed(nav: Navigation): boolean {
  if (nav.updating !== 'map' || !updatable(nav)) return false
  nav.update = { kind: 'map', delta: { ...nav.slew } }
  return true
}

// ---- the mission data load (2.13.1.2) ----

export interface Mission {
  identifier: string
  waypoints: { index: number; point: Named }[]
  stations: Station[]
  points: Named[]
}
// FILES: the memory unit's files the game's mission carries, each to the MUMI
// display's option (figure 2-21).
export const FILES = ['WYPT', 'TCN', 'GPS WYPT', 'GPS ALM'] as const
// load reads one file from the memory unit, or with none named all of them, as
// the automatic load at power-up does.
export function load(nav: Navigation, mission: Mission, file: string | null = null): void {
  nav.memory.identifier = mission.identifier
  nav.memory.files = [...FILES]
  for (const name of file ? [file] : FILES) {
    if (name === 'WYPT') for (const w of mission.waypoints) nav.waypoints[w.index] = { x: w.point.x, z: w.point.z, elevation: w.point.elevation, name: w.point.name, offset: null }
    if (name === 'TCN') nav.stations = mission.stations.slice(0, STATIONS).map((s) => ({ ...s }))
    if (name === 'GPS WYPT') nav.points = mission.points.map((p) => ({ ...p })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    if (!nav.memory.loaded.includes(name)) nav.memory.loaded.push(name)
  }
}
// transfer copies a GPS point into a waypoint (24.2.5.1.1): it keeps its ID.
export function transfer(nav: Navigation, name: string, index: number): boolean {
  const point = nav.points.find((p) => p.name === name)
  if (!point || index < 0 || index >= WAYPOINTS) return false
  nav.waypoints[index] = { x: point.x, z: point.z, elevation: point.elevation, name: point.name, offset: null }
  return true
}

// ---- latitude and longitude ----

export function coordinates(fix: Fix): { latitude: number; longitude: number } {
  const d = degrees(fix.x, fix.z)
  return { latitude: d.latitude, longitude: ((((d.longitude + 180) % 360) + 360) % 360) - 180 }
}
export function world(latitude: number, longitude: number): Fix {
  return metres(longitude, latitude)
}
// angle writes a latitude or longitude as the displays do: degrees, minutes
// and seconds, or with LATLN DCML degrees, minutes and thousandths (24.2.5.6).
export function angle(value: number, letters: 'NS' | 'EW', decimal: boolean, precise = false): string {
  const letter = letters[value < 0 ? 1 : 0]
  const width = letters === 'NS' ? 2 : 3
  const pad = (v: number, n: number) => String(v).padStart(n, '0')
  if (decimal) {
    let thousandths = Math.round(Math.abs(value) * 60000)
    const whole = Math.floor(thousandths / 60000)
    thousandths -= whole * 60000
    return letter + pad(whole, width).padStart(4) + '°' + pad(Math.floor(thousandths / 1000), 2) + '.' + pad(thousandths % 1000, 3) + "'"
  }
  // PRECISE adds the hundredths of a second (24.2.5.1)
  const per = precise ? 100 : 1
  let seconds = Math.round(Math.abs(value) * 3600 * per)
  const whole = Math.floor(seconds / (3600 * per))
  seconds -= whole * 3600 * per
  const rest = seconds % (60 * per)
  return letter + pad(whole, width).padStart(4) + '°' + pad(Math.floor(seconds / (60 * per)), 2) + "'" + pad(Math.floor(rest / per), 2) + (precise ? '.' + pad(rest % per, 2) : '') + '"'
}
// entered reads a keypad entry as a latitude or longitude: the hemisphere's
// letter (the keypad's N, S, E or W) and the digits, degrees then minutes then
// seconds or thousandths. null when it is no such angle.
export function entered(letter: string, digits: string, decimal: boolean): number | null {
  const north = letter === 'N' || letter === 'S'
  if (!north && letter !== 'E' && letter !== 'W') return null
  const tail = decimal ? 5 : 4
  if (!/^\d+$/.test(digits) || digits.length <= tail || digits.length > tail + (north ? 2 : 3)) return null
  const whole = +digits.slice(0, digits.length - tail)
  const minutes = +digits.slice(-tail, -tail + 2)
  const rest = +digits.slice(-tail + 2)
  if (minutes > 59 || (!decimal && rest > 59)) return null
  const value = whole + minutes / 60 + (decimal ? rest / 60000 : rest / 3600)
  if (value > (north ? 90 : 180)) return null
  return letter === 'S' || letter === 'W' ? -value : value
}
// shown: a true direction as the displays give it, magnetic with HDG MAG
// selected (24.2.5.7).
export function shown(nav: Navigation, direction: number, variation = nav.variation): number {
  return nav.magnetic ? (((direction - variation) % TURN) + TURN) % TURN : direction
}

// ---- units (24.2.5.1.2) ----

// Elevations are entered in feet or metres, offset ranges in feet, metres,
// nautical miles or yards; an offset lies within 400,000 ft of its aimpoint.
export type Unit = 'feet' | 'mtrs' | 'nm' | 'yard'
export const UNITS: Record<Unit, { metres: number; suffix: string; limit: number }> = {
  feet: { metres: 0.3048, suffix: 'FT', limit: 400000 },
  mtrs: { metres: 1, suffix: 'M', limit: 122000 },
  nm: { metres: NM, suffix: 'NM', limit: 66 },
  yard: { metres: 0.9144, suffix: 'YD', limit: 133000 },
}
// measure writes a length in a unit, as the DATA display does; taken reads a
// keypad entry in it, null past an offset's limit when one applies.
export function measure(metres: number, unit: Unit): string {
  return Math.round(metres / UNITS[unit].metres) + ' ' + UNITS[unit].suffix
}
export function taken(value: number, unit: Unit, limited: boolean): number | null {
  if (limited && value > UNITS[unit].limit) return null
  return value * UNITS[unit].metres
}

// ---- UTM grid coordinates (24.2.5.1.2) ----

// The military grid: the grid zone designation (a six-degree zone and an
// eight-degree band), the 100 km square's two letters, and the easting and
// northing within it - to 100 m, or with PRECISE to a metre. WGS-84; the
// manual's 47 datums are not listed in it, and the game has the one earth.
const MAJOR = 6378137
const FLAT = 1 / 298.257223563
const SCALE = 0.9996
const ECC = FLAT * (2 - FLAT)
const SECOND = ECC / (1 - ECC)
const BANDS = 'CDEFGHJKLMNPQRSTUVWX'
const COLUMNS = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ']
const ROWS = 'ABCDEFGHJKLMNPQRSTUV'
const RAD = Math.PI / 180
export interface Utm {
  zone: number
  band: string
  easting: number
  northing: number
}
export interface Square {
  zone: number
  band: string
  id: string
}
const arc = (phi: number) =>
  MAJOR * ((1 - ECC / 4 - (3 * ECC ** 2) / 64 - (5 * ECC ** 3) / 256) * phi - ((3 * ECC) / 8 + (3 * ECC ** 2) / 32 + (45 * ECC ** 3) / 1024) * Math.sin(2 * phi) +
    ((15 * ECC ** 2) / 256 + (45 * ECC ** 3) / 1024) * Math.sin(4 * phi) - ((35 * ECC ** 3) / 3072) * Math.sin(6 * phi))
// project: the transverse Mercator easting of a place in a zone, and its
// northing from the equator, negative south of it. lift is its inverse.
const own = (longitude: number) => (Math.floor((((longitude + 180) % 360) + 360) % 360 / 6) % 60) + 1
function project(latitude: number, longitude: number, zone: number): { easting: number; y: number } {
  const phi = latitude * RAD
  const turn = ((((longitude - ((zone - 1) * 6 - 177) + 180) % 360) + 360) % 360) - 180
  const n = MAJOR / Math.sqrt(1 - ECC * Math.sin(phi) ** 2)
  const t = Math.tan(phi) ** 2
  const c = SECOND * Math.cos(phi) ** 2
  const a = turn * RAD * Math.cos(phi)
  return {
    easting: SCALE * n * (a + ((1 - t + c) * a ** 3) / 6 + ((5 - 18 * t + t * t + 72 * c - 58 * SECOND) * a ** 5) / 120) + 500000,
    y: SCALE * (arc(phi) + n * Math.tan(phi) * ((a * a) / 2 + ((5 - t + 9 * c + 4 * c * c) * a ** 4) / 24 + ((61 - 58 * t + t * t + 600 * c - 330 * SECOND) * a ** 6) / 720)),
  }
}
function lift(zone: number, easting: number, y: number): { latitude: number; longitude: number } {
  const x = easting - 500000
  const mu = y / SCALE / (MAJOR * (1 - ECC / 4 - (3 * ECC ** 2) / 64 - (5 * ECC ** 3) / 256))
  const e = (1 - Math.sqrt(1 - ECC)) / (1 + Math.sqrt(1 - ECC))
  const phi = mu + ((3 * e) / 2 - (27 * e ** 3) / 32) * Math.sin(2 * mu) + ((21 * e * e) / 16 - (55 * e ** 4) / 32) * Math.sin(4 * mu) + ((151 * e ** 3) / 96) * Math.sin(6 * mu) + ((1097 * e ** 4) / 512) * Math.sin(8 * mu)
  const n = MAJOR / Math.sqrt(1 - ECC * Math.sin(phi) ** 2)
  const t = Math.tan(phi) ** 2
  const c = SECOND * Math.cos(phi) ** 2
  const r = (MAJOR * (1 - ECC)) / (1 - ECC * Math.sin(phi) ** 2) ** 1.5
  const d = x / (n * SCALE)
  const latitude = phi - ((n * Math.tan(phi)) / r) * ((d * d) / 2 - ((5 + 3 * t + 10 * c - 4 * c * c - 9 * SECOND) * d ** 4) / 24 + ((61 + 90 * t + 298 * c + 45 * t * t - 252 * SECOND - 3 * c * c) * d ** 6) / 720)
  const longitude = (d - ((1 + 2 * t + c) * d ** 3) / 6 + ((5 - 2 * c + 28 * t - 3 * c * c + 8 * SECOND + 24 * t * t) * d ** 5) / 120) / Math.cos(phi)
  return { latitude: latitude / RAD, longitude: (zone - 1) * 6 - 177 + longitude / RAD }
}
// utm: a latitude and longitude, degrees, as its zone's easting and northing,
// null outside N84 to S80. geodetic is its inverse.
export function utm(latitude: number, longitude: number): Utm | null {
  if (latitude > 84 || latitude < -80) return null
  const zone = own(longitude)
  const at = project(latitude, longitude, zone)
  return { zone, band: BANDS[Math.min(19, Math.floor((latitude + 80) / 8))], easting: at.easting, northing: latitude < 0 ? at.y + 10000000 : at.y }
}
export function geodetic(zone: number, easting: number, northing: number, south: boolean): { latitude: number; longitude: number } {
  return lift(zone, easting, south ? northing - 10000000 : northing)
}
function letters(u: Utm): string {
  return COLUMNS[(u.zone - 1) % 3][Math.floor(u.easting / 100000) - 1] + ROWS[(Math.floor(u.northing / 100000) + (u.zone % 2 === 0 ? 5 : 0)) % 20]
}
// square: the 100 km square a position lies in. grid: its grid coordinates as
// the DATA display writes them, three digits each way or with PRECISE five,
// cut short as the grid is and never rounded.
export function square(latitude: number, longitude: number): Square | null {
  const u = utm(latitude, longitude)
  return u && { zone: u.zone, band: u.band, id: letters(u) }
}
export function grid(latitude: number, longitude: number, precise: boolean): string {
  const u = utm(latitude, longitude)
  if (!u) return ''
  const digits = precise ? 5 : 3
  const part = (v: number) => String(Math.floor((v % 100000) / 10 ** (5 - digits))).padStart(digits, '0')
  return u.zone + u.band + letters(u) + part(u.easting) + part(u.northing)
}
// ungrid reads an easting and northing keyed for a square: six digits, or ten
// with PRECISE, the leading zeros optional. The square's row repeats every
// 2,000 km, so its band says which. The place taken is the middle of the
// 100 m or 1 m square keyed, so the display reads back what was keyed. null
// for digits that are no grid, or a square its zone and band do not hold.
export function ungrid(at: Square, digits: string, precise: boolean): { latitude: number; longitude: number } | null {
  const each = precise ? 5 : 3
  if (!/^\d+$/.test(digits) || digits.length > 2 * each) return null
  const full = digits.padStart(2 * each, '0')
  const column = COLUMNS[(at.zone - 1) % 3].indexOf(at.id[0])
  const row = ROWS.indexOf(at.id[1])
  if (column < 0 || row < 0) return null
  const size = 10 ** (5 - each)
  const easting = (column + 1) * 100000 + (+full.slice(0, each) + 0.5) * size
  const within = (((row - (at.zone % 2 === 0 ? 5 : 0)) % 20) + 20) % 20 * 100000 + (+full.slice(each) + 0.5) * size
  const south = at.band < 'N'
  for (let k = 0; k < 5; k++) {
    const found = geodetic(at.zone, easting, within + k * 2000000, south)
    if (BANDS[Math.min(19, Math.floor((found.latitude + 80) / 8))] === at.band) return found
  }
  return null
}
// centre: what a square identification grid is built about - the reference
// position, or the place a whole grid from it, in that place's own zone.
function centre(latitude: number, longitude: number, shift: { east: number; north: number }): { zone: number; easting: number; y: number } | null {
  const here = utm(latitude, longitude)
  if (!here) return null
  const y = latitude < 0 ? here.northing - 10000000 : here.northing
  if (!shift.east && !shift.north) return { zone: here.zone, easting: here.easting, y }
  const at = lift(here.zone, here.easting + 5 * shift.east * 100000, y + 5 * shift.north * 100000)
  return { zone: own(at.longitude), ...project(at.latitude, at.longitude, own(at.longitude)) }
}
// sig lays out the square identification grid (figure 24-9 sheet 4): five
// squares each way about a reference position, north up, each with its zone,
// band and letters - a neighbouring zone's where the grid runs across a zone's
// edge. A row past N84 or S80 is blank. shift moves it a whole grid at a time,
// for the grid shift options; a grid with no square in it does not exist.
export function sig(latitude: number, longitude: number, shift: { east: number; north: number }): (Square | null)[][] {
  const c = centre(latitude, longitude, shift)
  if (!c) return []
  const rows: (Square | null)[][] = []
  let any = false
  for (let i = 0; i < 5; i++) {
    const y = c.y + (2 - i) * 100000
    const middle = lift(c.zone, c.easting, y).latitude
    const row: (Square | null)[] = []
    for (let j = 0; j < 5; j++) {
      const at = lift(c.zone, c.easting + (j - 2) * 100000, y)
      row.push(middle > 84 || middle < -80 ? null : square(at.latitude, at.longitude))
      any = any || row[j] !== null
    }
    rows.push(row)
  }
  return any ? rows : []
}
// pin: where a place stands on that grid, in squares east of its left edge and
// north of its bottom one - the aircraft, the reference waypoint and an offset
// are drawn there. null off the grid.
export function pin(latitude: number, longitude: number, shift: { east: number; north: number }, at: { latitude: number; longitude: number }): { east: number; north: number } | null {
  const c = centre(latitude, longitude, shift)
  if (!c) return null
  const point = project(at.latitude, at.longitude, c.zone)
  const east = (point.easting - Math.floor(c.easting / 100000) * 100000) / 100000 + 2
  const north = (point.y - Math.floor(c.y / 100000) * 100000) / 100000 + 2
  return east >= 0 && east < 5 && north >= 0 && north < 5 ? { east, north } : null
}

// ---- cruise performance (2.3.1.1) ----

// The FPAS figures are searched from the flight core's own trimmed level
// flight: the fuel flow, kg/s, and true airspeed, m/s, at an altitude and Mach
// number for the jet as it is, or null where it cannot cruise on dry power.
export interface Cruise {
  flow: number
  speed: number
}
export type Lookup = (altitude: number, mach: number) => Cruise | null
export interface Best extends Cruise {
  mach: number
  altitude: number
}
const SLOWEST = 0.3
const FASTEST = 0.9 // past Mach 0.9 the FPAS range is invalid (2.3.1.1.2)
export const CEILING = 50000 * 0.3048
const LAYER = 1000 * 0.3048
// best finds, at an altitude, the Mach number that goes furthest over the
// ground on its fuel and the one that stays up longest: the least flow per
// metre with the wind along the track counted, and the least flow. Every
// twentieth of a Mach number from 0.30 to 0.90 first, then two hundredths and
// one hundredth either side of each best - some twenty looks, as each costs the
// flight core a trim.
export function best(lookup: Lookup, altitude: number, tail = 0): { range: Best | null; endurance: Best | null } {
  const found: { range: Best | null; endurance: Best | null } = { range: null, endurance: null }
  const per = (c: Cruise) => c.flow / (c.speed + tail)
  const look = (mach: number, which: 'range' | 'endurance' | 'both') => {
    if (mach < SLOWEST - 1e-9 || mach > FASTEST + 1e-9) return
    const c = lookup(altitude, mach)
    if (!c || c.speed + tail <= 0) return
    const here = { ...c, mach, altitude }
    if (which !== 'endurance' && (!found.range || per(c) < per(found.range))) found.range = here
    if (which !== 'range' && (!found.endurance || c.flow < found.endurance.flow)) found.endurance = here
  }
  for (let k = 0; SLOWEST + k * 0.05 <= FASTEST + 1e-9; k++) look(SLOWEST + k * 0.05, 'both')
  for (const which of ['range', 'endurance'] as const)
    for (const step of [0.02, 0.01]) {
      const at = found[which]
      if (at) for (const d of [-step, step]) look(Math.round((at.mach + d) * 100) / 100, which)
    }
  return found
}
// A survey climbs through the altitudes a thousand feet at a time, keeping the
// best range and the best endurance found: the FPAS optimum (2.3.1.1.4,
// 2.3.1.1.5). It is done at 50,000 ft.
export interface Survey {
  altitude: number
  range: Best | null
  endurance: Best | null
  tail: number
  done: boolean
}
export function survey(tail = 0): Survey {
  return { altitude: 0, range: null, endurance: null, tail, done: false }
}
export function sweep(s: Survey, lookup: Lookup, layers: number): void {
  for (let k = 0; k < layers && !s.done; k++) {
    const found = best(lookup, s.altitude, s.tail)
    const r = found.range
    const e = found.endurance
    if (r && (!s.range || r.flow / (r.speed + s.tail) < s.range.flow / (s.range.speed + s.tail))) s.range = r
    if (e && (!s.endurance || e.flow < s.endurance.flow)) s.endurance = e
    s.altitude += LAYER
    if (s.altitude > CEILING + 1e-6) s.done = true
  }
}
