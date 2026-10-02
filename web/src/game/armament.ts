// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The master arm panel and the selective jettison controls (NATOPS
// A1-F18AC-NFM-000 2.17.1.2, 2.14.2 to 2.14.4, FO-5 items 12, 20 and 32): the
// MASTER ARM switch and the ARM conditions it is one of, the station jettison
// select buttons and the SELECT JETT knob with its JETT button, and the fire
// extinguisher the panel's FIRE EXTGH pushbutton discharges. Pure: the engine
// says where the jet is (Sense) and which fire lights are pushed, and reads
// back what leaves the aircraft and whether the bottle went.

// The SELECT JETT knob's positions, anticlockwise to clockwise as FO-5 draws
// them: L FUS MSL, SAFE, R FUS MSL, RACK/LCHR, STORES.
export type Select = 'left' | 'safe' | 'right' | 'rack' | 'stores'
export const SELECT: readonly Select[] = ['left', 'safe', 'right', 'rack', 'stores']
// The station jettison select buttons (2.17.1.2.1), each with the weapon
// station it selects: the centreline, the inboard wing stations and the
// outboard.
export const BUTTONS: readonly { station: number; label: string }[] = [
  { station: 5, label: 'CTR' },
  { station: 3, label: 'LI' },
  { station: 7, label: 'RI' },
  { station: 2, label: 'LO' },
  { station: 8, label: 'RO' },
]
// The fuselage stations a missile leaves from with the knob at L FUS MSL or R
// FUS MSL.
const FUSELAGE = { left: 4, right: 6 }

export interface Armament {
  arm: boolean // the MASTER ARM switch at ARM
  select: Select
  stations: number[] // the stations whose select buttons are lit
  discharged: boolean // the extinguisher bottle is spent: there is one
}
// fresh: how a spawn finds the panel - armed in the air, where the jet is
// already fenced in, and safe on the deck.
export function fresh(airborne: boolean): Armament {
  return { arm: airborne, select: 'safe', stations: [], discharged: false }
}

export interface Sense {
  airborne: boolean // weight off wheels
  handle: boolean // the landing gear handle is UP
  locked: boolean // every landing gear is up and locked
}
// armed: the ARM conditions (2.17.1.2) - weight off wheels, the gear handle up
// and MASTER ARM at ARM. Their fourth, SIM unboxed, has no option here.
export function armed(a: Armament, s: Sense): boolean {
  return a.arm && s.airborne && s.handle
}
// turn steps the SELECT JETT knob a position, clockwise for a positive
// direction, stopping at its ends.
export function turn(a: Armament, direction: number): void {
  const at = SELECT.indexOf(a.select) + (direction < 0 ? -1 : 1)
  a.select = SELECT[Math.max(0, Math.min(SELECT.length - 1, at))]
}
// press works a station jettison select button: it lights and selects its
// station, and pressed again goes out.
export function press(a: Armament, station: number): void {
  if (!BUTTONS.some((b) => b.station === station)) return
  a.stations = a.stations.includes(station) ? a.stations.filter((s) => s !== station) : [...a.stations, station]
}
// release is the JETT button pressed (2.17.1.2.2): what leaves, or null when
// nothing may - the ARM conditions not met, a landing gear not up and locked,
// the knob at SAFE, or no station selected for RACK/LCHR or STORES. A fuselage
// missile goes alone, as its store; the selected stations lose their stores,
// or their racks and launchers with whatever is on them.
export interface Release {
  stations: number[]
  what: 'stores' | 'rack'
}
export function release(a: Armament, s: Sense): Release | null {
  if (!armed(a, s) || !s.locked || a.select === 'safe') return null
  if (a.select === 'left' || a.select === 'right') return { stations: [FUSELAGE[a.select]], what: 'stores' }
  if (!a.stations.length) return null
  return { stations: BUTTONS.map((b) => b.station).filter((station) => a.stations.includes(station)), what: a.select }
}

// ---- the fire extinguisher (2.14.2) ----

// ready: the yellow READY light - the bottle armed by a fire light pushed in.
export function ready(pushed: readonly boolean[]): boolean {
  return pushed.some(Boolean)
}
// discharge is the FIRE EXTGH pushbutton pressed: with READY on it empties the
// one bottle and lights DISCH. Where the agent goes, and whether it puts a fire
// out, is the damage model's (2.14.4). false: nothing discharged.
export function discharge(a: Armament, pushed: readonly boolean[]): boolean {
  if (a.discharged || !ready(pushed)) return false
  a.discharged = true
  return true
}
