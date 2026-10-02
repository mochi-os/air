// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The Link 4 data link's automatic carrier landing mode (NATOPS
// A1-F18AC-NFM-000 24.6.1, figures 24-23 to 24-29): the carrier's side - its
// controller and the SPN-42 radar, sending the label 5 and label 6 messages -
// and the aircraft's, which shows them, judges what it can do with them, and
// offers them to the autopilot. Pure: the engine says where the jet is against
// the carrier's approach (Picture) and reads back what the displays show and
// what there is to couple to.

import type { Couple } from './autopilot'

const NM = 1852
const FOOT = 0.3048
const DEGREE = Math.PI / 180

// Where the jet is, as the carrier's radar and the aircraft's own equipment
// have it. The approach's frame: along the final bearing aft of the touchdown
// point, across it to the right as the approach is flown, and the hook's height
// above the touchdown.
export interface Picture {
  time: number // sim seconds
  along: number // m aft of the touchdown
  across: number // m right of the centreline
  height: number // m, the hook above the touchdown
  final: number // the final bearing, the course flown up the centreline, degrees true
  altitude: number // m, barometric
  waved: boolean // the pass has been waved off
  link: boolean // the data link receiver is on
  beacon: boolean // and the radar beacon the SPN-42 tracks
  able: boolean // the flight controls can couple: the autopilot could engage
  flaps: boolean // full flaps, which a mode 1 couple needs (24.6.1.2.3)
  throttle: boolean // the ATC is holding the approach's angle of attack
  coupled: '' | Couple['axis'] // what the flight controls are coupled to now
}

// The label 5 message (24.6.1): what the controller commands, and the group 1
// discrete it sends with it. Feet, knots, feet a minute, degrees true.
export type Discrete = '' | 'LND CHK' | 'ACL RDY' | 'CMD CNT' | 'W/O'
export interface Five {
  altitude: number
  airspeed: number
  descent: number
  heading: number
  discrete: Discrete
}
// The label 6 message: the SPN-42's errors off its glidepath and centreline for
// the HUD's situation display, and its commands for the flight controls - a
// rate of climb and a roll angle, both zero until command control.
export interface Six {
  vertical: number // m the jet is above the glidepath
  lateral: number // m right of the centreline
  rate: number // ft/s, + climbing
  roll: number // degrees, + right wing down
}
// What can be underlined on the Link 4 display: the item that last changed
// (figure 24-23's note).
export type Item = 'airspeed' | 'altitude' | 'descent' | 'discrete' | 'mode' | 'notice'

export interface Link {
  selected: boolean // ACL boxed on the HSI
  test: number // seconds of the ACL test left
  five: Five | null
  six: Six | null
  acquired: boolean // the SPN-42 has the aircraft
  reported: number | null // when the couple to its commands was first seen: command control follows
  control: boolean // CMD CNT: its commands are active
  level: number // the height the commands hold until the glidepath comes down to it, m
  ten: number // when 10 SEC was received
  data: number // when new data last came up: DATA flashes on the HUD
  changed: Item | '' // the item underlined
  last: { time: number; along: number; across: number } | null // the radar's last look, for its rates
  closure: number // m/s toward the touchdown
  drift: number // m/s to the right
  shown: string // the displayed items as last seen, to find a change
}

// The canned approach (figure 24-29). Out of marshal the controller brings the
// jet down at 4,000 ft/min to the 5,000 ft platform by 20 nm, then at 2,000 to
// 1,200 ft by 10 nm, at 250 knots; from the landing check, inside 6 nm, the
// approach speed. The SPN-42 acquires inside 5 nm through its entry window,
// 10,000 ft wide and 630 high, and its glidepath is the lens's 3.5°.
const REACH = 100 * NM // the data link's reach: past it nothing is updated, TILT
const PLATFORM = 20 * NM
const CHECK = 6 * NM
const ACQUIRE = 5 * NM
const WINDOW = { wide: 5000 * FOOT, high: 315 * FOOT }
const PATTERN = 1200 * FOOT
const SLOPE = Math.tan(3.5 * DEGREE)
const GATE = 12 * NM // where a jet outside the approach's cone is sent, aft on the final bearing
const REPORT = 5 // seconds from the couple to command control: the pilot's report
const WARNING = 12.5 // seconds from touchdown, 10 SEC
const NOTICE = 30 // seconds a group 2c cue stays up
const TESTING = 10 // seconds the ACL test takes: the manual gives none
// The SPN-42's control law: its roll command closes the centreline like a
// spring and damper through the bank's turn, and its rate command flies the
// height of the glidepath, or of the level the jet coupled at until the
// glidepath comes down to it. The gains were found against the flight core
// (autopilot-core.test.ts flies an approach).
const K = { spring: 0.04, damper: 0.36, roll: 20, height: 0.25, sink: -25, climb: 10 }

export function fresh(): Link {
  return {
    selected: false, test: 0, five: null, six: null, acquired: false, reported: null, control: false, level: 0, ten: -Infinity, data: -Infinity, changed: '',
    last: null, closure: 0, drift: 0, shown: '',
  }
}
const clamp = (v: number, low: number, high: number) => Math.max(low, Math.min(high, v))

// select works the ACL option on the HSI: boxed, the mode runs its test, the
// data link's own and the beacon's among it (24.6.1.2.1); unboxed, the uplink
// is let go.
export function select(link: Link): void {
  const selected = !link.selected
  Object.assign(link, fresh(), { selected, test: selected ? TESTING : 0 })
}
// cone: inside the approach's cone aft of the ship, where the controller lines
// the jet up on the final bearing; outside it he sends it round to the gate.
function cone(p: Picture): boolean {
  return p.along > 2 * NM && Math.abs(p.across) < p.along
}
// controller: the label 5 message for where the jet is.
function controller(link: Link, p: Picture): Five {
  const range = Math.hypot(p.along, p.across)
  const lined = cone(p)
  const altitude = range > PLATFORM ? 5000 : 1200
  const check = lined && range <= CHECK
  const high = p.altitude > (altitude + 50) * FOOT
  const heading = lined
    ? p.final - clamp(Math.atan(p.across / Math.max(3000, p.along / 4)) / DEGREE, -30, 30) // a cut at the centreline, easing off as it closes
    : p.final + Math.atan2(-p.across, p.along - GATE) / DEGREE
  const discrete: Discrete = p.waved ? 'W/O' : link.control ? 'CMD CNT' : link.acquired ? 'ACL RDY' : check ? 'LND CHK' : ''
  return { altitude, airspeed: check ? 130 : 250, descent: high ? (altitude === 5000 ? 4000 : 2000) : 0, heading: ((Math.round(heading) % 360) + 360) % 360, discrete }
}
// radar: the SPN-42. It acquires a jet coming through its entry window, and
// keeps it until a waveoff, the jet leaving the cone, or the ramp. Its commands
// are zero until command control (24.6.1.1.1's ACL RDY).
function radar(link: Link, p: Picture, dt: number): Six | null {
  const glide = p.along * SLOPE
  if (link.last && dt > 0) {
    const blend = Math.min(1, dt / 0.3)
    link.closure += ((link.last.along - p.along) / dt - link.closure) * blend
    link.drift += ((p.across - link.last.across) / dt - link.drift) * blend
  }
  link.last = { time: p.time, along: p.along, across: p.across }
  const inside = p.along > 0 && Math.abs(p.across) < Math.max(p.along, 200) && p.beacon && !p.waved
  if (!inside) link.acquired = false
  else if (!link.acquired && Math.hypot(p.along, p.across) <= ACQUIRE && Math.abs(p.across) <= WINDOW.wide && Math.abs(p.height - Math.min(glide, PATTERN)) <= WINDOW.high) {
    link.acquired = true
    link.level = p.height
  }
  if (!link.acquired) {
    link.reported = null
    link.control = false
    return null
  }
  // command control: the carrier has the pilot's report that he is coupled
  if (p.coupled !== 'bank') {
    link.reported = null
    link.control = false
    link.level = p.height
  } else {
    link.reported ??= p.time
    if (p.time - link.reported >= REPORT) link.control = true
  }
  const target = Math.min(glide, link.level)
  const falling = glide < link.level ? -link.closure * SLOPE : 0 // the glidepath's own rate at the speed the jet closes
  const rate = link.control ? clamp((falling + (target - p.height) * K.height) / FOOT, K.sink, K.climb) : 0
  const roll = link.control ? clamp((-(K.spring * p.across + K.damper * link.drift) / 9.80665) / DEGREE, -K.roll, K.roll) : 0
  return { vertical: p.height - glide, lateral: p.across, rate, roll }
}
// step runs the link a frame: the test, the two messages while the uplink
// reaches the jet, the 10 SEC notice, and what changed on the display.
export function step(link: Link, p: Picture, dt: number): void {
  if (!link.selected) return
  link.test = Math.max(0, link.test - dt)
  const up = p.link && link.test === 0 && Math.hypot(p.along, p.across) <= REACH
  link.six = up ? radar(link, p, dt) : null
  link.five = up ? controller(link, p) : null
  if (!up) {
    link.acquired = link.control = false
    link.reported = link.last = null
  }
  if (link.six && link.closure > 1 && p.along / link.closure <= WARNING && p.time - link.ten > NOTICE) link.ten = p.time
  // the item that changed is underlined, and DATA flashes for what is new
  const f = link.five
  const items: [Item, string][] = [['airspeed', f ? String(f.airspeed) : ''], ['altitude', f ? String(f.altitude) : ''], ['descent', f ? String(f.descent) : ''], ['discrete', f ? f.discrete : ''], ['mode', mode(link, p)], ['notice', notice(link, p.time)]]
  const before = link.shown.split('|')
  const moved = items.find(([, value], k) => link.shown !== '' && value !== before[k] && value !== '')
  if (moved) {
    link.changed = moved[0]
    link.data = p.time
  }
  link.shown = items.map(([, value]) => value).join('|')
}

// capability: what the aircraft's own systems can do with the uplink (figure
// 24-23, slot d). TEST while the mode tests; ACL N/A without the data link or
// the beacon; ACL 2 with them but no couple to the flight controls; ACL 1 with
// that too.
export function capability(link: Link, p: Picture): string {
  if (!link.selected) return ''
  if (link.test > 0) return 'TEST'
  if (!p.link || !p.beacon) return 'ACL N/A'
  return p.able ? 'ACL 1' : 'ACL 2'
}
// mode: what the whole loop is ready for (slot b). TILT with nothing coming
// up; MODE 1 with the SPN-42's commands and an aircraft that can couple to
// them, MODE 2 with its steering only; T/C with the controller's heading to
// couple to and no label 6. The couple to its commands is flown with full
// flaps and the ATC engaged, as the landing check asks (24.6.1.1.1): in the
// approach's control law the stick sets the angle of attack, and it is the
// throttle holding that which turns it into a rate of climb. The manual
// names the flaps as a condition and not the ATC; the game needs both.
export function mode(link: Link, p: Picture): string {
  if (!link.selected || link.test > 0 || !p.link) return ''
  if (!link.five) return 'TILT'
  if (link.six) return p.able && p.beacon && p.flaps && p.throttle ? 'MODE 1' : 'MODE 2'
  return p.able && link.five.discrete !== 'W/O' ? 'T/C' : ''
}
// notice: the group 2c cue (slot c), up for 30 seconds from its receipt.
export function notice(link: Link, time: number): string {
  return time - link.ten < NOTICE ? '10 SEC' : ''
}
// flashing: DATA on the HUD, twice a second for ten seconds after new data
// comes up on the Link 4 display (24.6.1.1.2).
export function flashing(link: Link, time: number): boolean {
  return time - link.data < 10 && Math.floor(time * 4) % 2 === 0
}
// couple: what the autopilot's CPL option couples to. The SPN-42's commands
// in mode 1, both axes; else the controller's heading. A traffic control
// couple already made is kept when label 6 arrives, until the pilot lets it
// go: the next CPL asks for the ACL couple (24.6.1.2.3's note, figure 24-29).
export function couple(link: Link, p: Picture): Couple | null {
  const cue = mode(link, p)
  const five = link.five
  if (!five || five.discrete === 'W/O' || !p.able) return null
  if (cue === 'T/C' || (p.coupled === 'heading' && cue !== 'TILT')) return { axis: 'heading', value: five.heading, vertical: null }
  if (cue === 'MODE 1' && link.six) return { axis: 'bank', value: link.six.roll, vertical: link.six.rate * FOOT }
  return null
}
