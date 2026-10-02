// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The dispenser/EMC panel and the RWR control indicator (NATOPS
// A1-F18AC-NFM-000 FO-5 items 35 and 36, 2.13.12, 2.22.9.23.6): the DISPENSER
// switch over the ALE-47, the ECM knob over the jammer, and the ALR-67's five
// pushbuttons with their lights. NATOPS draws these controls and names their
// positions but leaves what they do to the NATIP, which we do not hold: the
// behaviour here follows the public descriptions of the equipment, except
// where a NATOPS paragraph is cited. Pure: the engine says what the jet's
// receivers hear and reads back what is dispensed, radiated, shown and lit.

import type { RwrContact } from './rwr'

// The DISPENSER switch, from the bottom of its throw up: OFF, ON, BYPASS.
export type Dispenser = 'off' | 'on' | 'bypass'
export const DISPENSER: readonly Dispenser[] = ['off', 'on', 'bypass']
// The ECM knob, clockwise: OFF, STBY, BIT, REC, XMIT.
export type Jammer = 'off' | 'standby' | 'test' | 'receive' | 'transmit'
export const JAMMER: readonly Jammer[] = ['off', 'standby', 'test', 'receive', 'transmit']

// The RWR control indicator: POWER, DISPLAY (whose light is LIMIT), SPECIAL and
// OFFSET (ENABLE), and BIT (FAIL).
export interface Receiver {
  power: boolean
  limit: boolean
  offset: boolean
  special: boolean
  tested: number // when BIT was last pressed, sim seconds
}
export interface Suite {
  dispenser: Dispenser
  jammer: Jammer
  tested: number // when the ECM knob came to BIT
  dispensed: number // when a programme last ran
  bingo: { chaff: number; flare: number } // the levels D LOW shows at
  receiver: Receiver
}
// QUARTER: the bingo level the load carries for each category, as a share of
// its magazine. The jet's are set in mission planning; this is the game's.
const QUARTER = 0.25
// fresh: how a spawn finds the panel - in the air the dispenser on and the
// jammer listening, on the deck both off. The RWR is on, as the pre-flight
// leaves the other receivers.
export function fresh(airborne: boolean, load: { chaff: number; flare: number }): Suite {
  return {
    dispenser: airborne ? 'on' : 'off', jammer: airborne ? 'receive' : 'off', tested: -Infinity, dispensed: -Infinity,
    bingo: { chaff: Math.ceil(load.chaff * QUARTER), flare: Math.ceil(load.flare * QUARTER) },
    receiver: { power: true, limit: false, offset: false, special: false, tested: -Infinity },
  }
}

// ---- the dispenser ----

// What one press of the dispense switch releases. way: aft (-1) or forward (+1)
// on the throttle's switch, 0 for the console's dispense button, which runs
// the programme as the switch's aft position does (2.22.9.23.6). ON runs the
// programme aft - a flare and a chaff bundle - and gives chaff singles
// forward; BYPASS goes round the programmer, a flare aft and a bundle forward
// and nothing from the button. Weight on wheels inhibits it.
export interface Drop {
  flare: number
  chaff: number
  programme: boolean
}
export function dispense(s: Suite, way: number, grounded: boolean, now: number): Drop | null {
  if (s.dispenser === 'off' || grounded) return null
  if (s.dispenser === 'bypass') return way < 0 ? { flare: 1, chaff: 0, programme: false } : way > 0 ? { flare: 0, chaff: 1, programme: false } : null
  if (way > 0) return { flare: 0, chaff: 1, programme: false }
  s.dispensed = now
  return { flare: 1, chaff: 1, programme: true }
}
// advisories: D LOW with a category down to its bingo level (2.13.12.1); none
// from a set that is off. D BAD, its misfire advisory, has nothing here to
// raise it: no cartridge in the game fails to fire.
export function advisories(s: Suite, left: { chaff: number; flare: number }): string[] {
  return s.dispenser !== 'off' && (left.chaff <= s.bingo.chaff || left.flare <= s.bingo.flare) ? ['D LOW'] : []
}
// FLASH: how long the DISP light stays on after a programme runs, seconds.
export const FLASH = 1
export function dispensing(s: Suite, now: number): boolean {
  return now - s.dispensed < FLASH
}

// ---- the jammer ----

// turn steps the ECM knob a position, clockwise for a positive direction;
// coming to BIT starts the test.
export function turn(s: Suite, direction: number, now: number): void {
  const at = Math.max(0, Math.min(JAMMER.length - 1, JAMMER.indexOf(s.jammer) + (direction < 0 ? -1 : 1)))
  if (JAMMER[at] === 'test' && s.jammer !== 'test') s.tested = now
  s.jammer = JAMMER[at]
}
// toggle is the jammer's key: to XMIT, and from XMIT back to REC.
export function toggle(s: Suite): void {
  s.jammer = s.jammer === 'transmit' ? 'receive' : 'transmit'
}
// operating: the set is up and listening, at REC or XMIT, on ac power.
export function operating(s: Suite, power: boolean): boolean {
  return power && (s.jammer === 'receive' || s.jammer === 'transmit')
}
// radiating: at XMIT it transmits only while a threat radar paints the jet.
export function radiating(s: Suite, painted: boolean, power: boolean): boolean {
  return power && s.jammer === 'transmit' && painted
}
// lamps: the jammer's lights on the left warning/caution/advisory panel -
// STBY at the knob's STBY, ASPJ ON while it operates, XMIT while it radiates
// and REC while it listens, and GO once the test at BIT has run its span.
// NO GO, the test's other answer, has no failure here to show. Without ac
// power the set is dead and all are out.
export interface Lamps {
  standby: boolean
  on: boolean
  receive: boolean
  transmit: boolean
  go: boolean
}
// painted: a threat radar has the jet. power: the ac buses are up.
export function lamps(s: Suite, painted: boolean, power: boolean, span: number, now: number): Lamps {
  const loud = radiating(s, painted, power), up = operating(s, power)
  return { standby: power && s.jammer === 'standby', on: up, receive: up && !loud, transmit: loud, go: power && s.jammer === 'test' && now - s.tested >= span }
}

// ---- the RWR ----

// LIMIT: with DISPLAY's LIMIT light on the azimuth indicator shows only the
// six emitters of the highest priority.
export const LIMIT = 6
// rank orders the emitters heard by priority: a missile's seeker, then a radar
// locked on, then the search radars, the latest heard first.
function rank(a: RwrContact, b: RwrContact): number {
  const weight = (c: RwrContact) => (c.missile ? 2 : c.locked ? 1 : 0)
  return weight(b) - weight(a) || b.at - a.at
}
// shown: what the azimuth indicator and the EW page draw - nothing with the
// set off, and the six of the highest priority with LIMIT.
export function shown(r: Receiver, contacts: readonly RwrContact[]): RwrContact[] {
  if (!r.power) return []
  const ranked = [...contacts].sort(rank)
  return r.limit ? ranked.slice(0, LIMIT) : ranked
}
// APART: the least bearing between two symbols on the same ring with OFFSET
// enabled, which moves overlapping symbols apart to be read.
export const APART = (12 * Math.PI) / 180
// spread returns the bearings to draw a ring's symbols at: their own, or with
// OFFSET those closer than APART pushed apart about their mean.
export function spread(r: Receiver, bearings: readonly number[]): number[] {
  if (!r.offset || bearings.length < 2) return [...bearings]
  const circle = 2 * Math.PI, turn = (a: number) => ((a % circle) + circle) % circle
  const round = bearings.map((b, i) => ({ i, at: turn(b) })).sort((a, b) => a.at - b.at)
  // the ring is cut at its widest gap, so no group of neighbours straddles the cut
  let cut = 0, widest = -1
  round.forEach((o, k) => { const gap = turn(o.at - round[(k + round.length - 1) % round.length].at); if (gap > widest) { widest = gap; cut = k } })
  const order = round.map((_, k) => round[(cut + k) % round.length]).map((o, _k, all) => ({ i: o.i, at: all[0].at + turn(o.at - all[0].at) }))
  const out = [...bearings]
  for (let k = 0; k < order.length; ) {
    let end = k + 1
    while (end < order.length && order[end].at - order[end - 1].at < APART) end++
    const mean = order.slice(k, end).reduce((sum, o) => sum + o.at, 0) / (end - k)
    for (let j = k; j < end; j++) { const at = mean + (j - k - (end - k - 1) / 2) * APART; out[order[j].i] = Math.atan2(Math.sin(at), Math.cos(at)) }
    k = end
  }
  return out
}
// TEST: how long the indicator's own test holds its lights on, seconds.
export const TEST = 2
// indicator: the control indicator's lights - ON with the power, LIMIT and the
// two ENABLEs with their functions; BIT lights them all for its span, FAIL
// with them, which no failure here lights otherwise.
export interface Indicator {
  power: boolean
  limit: boolean
  offset: boolean
  special: boolean
  fail: boolean
}
export function indicator(r: Receiver, now: number): Indicator {
  if (!r.power) return { power: false, limit: false, offset: false, special: false, fail: false }
  if (now - r.tested < TEST) return { power: true, limit: true, offset: true, special: true, fail: true }
  return { power: true, limit: r.limit, offset: r.offset, special: r.special, fail: false }
}
// press works one of the indicator's pushbuttons. With the power off only
// POWER answers.
export type Button = 'power' | 'display' | 'special' | 'offset' | 'test'
export function press(r: Receiver, button: Button, now: number): void {
  if (button === 'power') r.power = !r.power
  else if (!r.power) return
  else if (button === 'display') r.limit = !r.limit
  else if (button === 'special') r.special = !r.special
  else if (button === 'offset') r.offset = !r.offset
  else r.tested = now
}
