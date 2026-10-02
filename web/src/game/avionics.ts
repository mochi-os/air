// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The mission computers, the status of the avionic equipment and its built-in
// test (NATOPS A1-F18AC-NFM-000 2.13.1, 2.13.4.2.1, 2.20.3, 2.20.5 and figures
// 2-46 and 2-47), for an F/A-18C with MC OFP 13C. Pure: the engine says what
// each unit's condition is and which pushbuttons were pressed, and reads back
// the status messages the BIT display writes.

// ---- the mission computers (2.13.1) ----

// The MC switch on the MC/HYD ISOL panel: 1 OFF, NORM, 2 OFF (2.13.1.3). Each
// computer runs with its switch position and the ac buses.
export type Selection = 'one' | 'norm' | 'two'
export const SWITCH: readonly Selection[] = ['one', 'norm', 'two']
export interface Computers {
  one: boolean // MC1, the navigation computer
  two: boolean // MC2, the weapon delivery computer
}
export function computers(selection: Selection, power: boolean): Computers {
  return { one: power && selection !== 'one', two: power && selection !== 'two' }
}
// standby: with neither computer the displays show only a flashing STANDBY
// (2.13.4.2.1).
export function standby(mc: Computers): boolean {
  return !mc.one && !mc.two
}
// offered: whether a menu still lists a page. Without MC1 the SUPT menu shows
// only HSI and the TAC menu loses SA; without MC2 the TAC menu loses STORES
// (2.13.4.2.1, 2.20.5).
export function offered(menu: 'tac' | 'supt', page: string, mc: Computers): boolean {
  if (!mc.one && (menu === 'supt' ? page !== 'hsi' : page === 'sa')) return false
  return mc.two || page !== 'sms'
}
// cautions: what the DDI still shows of the cautions raised. MC2 monitors in
// MC1's place and has only MC 1 to show, with AUTO PILOT (2.20.5, figure 12-1
// MC 1; its HYD cautions have no system here); MC1 adds MC 2 for a dead MC2;
// with neither there is no one to show any.
export function cautions(raised: readonly string[], mc: Computers): string[] {
  if (standby(mc)) return []
  if (!mc.one) return [...raised.filter((c) => c === 'AUTO PILOT'), 'MC 1']
  return mc.two ? [...raised] : [...raised, 'MC 2']
}
// advised: the advisories go with MC1 (2.20.5).
export function advised<T>(raised: readonly T[], mc: Computers): T[] {
  return mc.one ? [...raised] : []
}

// ---- equipment status (2.20.3.2) ----

// The BIT display's groups, each at its pushbutton on the top level (figure
// 2-46 sheet 1), and the units of each the game has. A unit's own pushbutton
// on its group's sublevel (sheets 2 and 3) starts its test; 0 is a unit tested
// only with its group. ground: its initiated BIT is not allowed in flight, and
// its legend stands only on the wheels. plain: the mission computers and the
// RWR, which have no IN TEST or PBIT GO (2.20.3.2's table). dark: the units
// that read OFF, not NOT RDY, when switched off (MC OFP 13C). seconds: how
// long its initiated BIT runs - the manual's bounds are 2.5 minutes for all of
// AUTO but the FCS and INS, 180 s for the SMS, 25 s for the displays and 12
// minutes for the INS (2.20.3.6 to 2.20.3.9); inside them the figures are the
// game's.
export type Group = 'fcs' | 'sensors' | 'stores' | 'comm' | 'nav' | 'displays' | 'monitor' | 'ew'
export const GROUPS: readonly { key: Group; label: string; button: number }[] = [
  { key: 'fcs', label: 'FCS-MC', button: 5 },
  { key: 'sensors', label: 'SENSORS', button: 4 },
  { key: 'stores', label: 'STORES', button: 3 },
  { key: 'comm', label: 'COMM', button: 2 },
  { key: 'nav', label: 'NAV', button: 1 },
  { key: 'displays', label: 'DISPLAYS', button: 11 },
  { key: 'monitor', label: 'STATUS MONITOR', button: 12 },
  { key: 'ew', label: 'EW', button: 13 },
]
export interface Unit {
  key: string
  label: string
  group: Group
  button: number
  ground: boolean
  plain: boolean
  dark: boolean
  seconds: number
}
const unit = (key: string, label: string, group: Group, button: number, seconds: number, more: Partial<Unit> = {}): Unit => ({ key, label, group, button, seconds, ground: false, plain: false, dark: false, ...more })
export const UNITS: readonly Unit[] = [
  unit('mc1', 'MC1', 'fcs', 0, 0, { plain: true }),
  unit('mc2', 'MC2', 'fcs', 0, 0, { plain: true }),
  unit('fcsa', 'FCSA', 'fcs', 5, 60, { ground: true }),
  unit('fcsb', 'FCSB', 'fcs', 5, 60, { ground: true }),
  unit('rdr', 'RDR', 'sensors', 5, 120, { dark: true }),
  unit('sms', 'SMS', 'stores', 5, 150, { ground: true }),
  unit('wpns', 'WPNS', 'stores', 0, 30),
  unit('dl', 'D/L', 'comm', 2, 20),
  unit('ins', 'INS', 'nav', 5, 600, { ground: true }),
  unit('adc', 'ADC', 'nav', 4, 45, { ground: true }),
  unit('ils', 'ILS', 'nav', 3, 20, { dark: true }),
  unit('bcn', 'BCN', 'nav', 3, 20), // the radar beacon, tested with the ILS (24.5.3)
  unit('ralt', 'RALT', 'nav', 2, 15, { dark: true }),
  unit('tcn', 'TCN', 'nav', 1, 30, { dark: true }),
  unit('gps', 'GPS', 'nav', 13, 40),
  unit('lddi', 'LDDI', 'displays', 5, 25),
  unit('rddi', 'RDDI', 'displays', 5, 25),
  unit('mpcd', 'MPCD', 'displays', 5, 25),
  unit('hud', 'HUD', 'displays', 5, 25),
  unit('ifei', 'IFEI', 'displays', 4, 25),
  unit('dms', 'DMS', 'displays', 2, 30),
  unit('sdc', 'SDC', 'monitor', 5, 20),
  unit('mu', 'MU', 'monitor', 4, 20),
  unit('rwr', 'RWR', 'ew', 0, 0, { plain: true }),
  unit('ale', 'ALE-47', 'ew', 3, 30),
  unit('aspj', 'ASPJ', 'ew', 0, 60),
]
// What the engine finds each unit to be: working, switched off, still coming
// up (an INS aligning, a GPS acquiring), or degraded by a failure.
export type Condition = 'ok' | 'off' | 'wait' | 'degraded'
export type Conditions = Record<string, Condition>

// ---- built-in test (2.20.3.4) ----

export interface Bit {
  tests: Record<string, number> // the units in initiated BIT, each with its seconds left
  results: Record<string, 'go' | 'restart'> // how each unit's last initiated BIT ended
  asking: boolean // the INS test waits to be told GND or CV (2.20.3.7)
  failed: string[] // the units a failure showed on last step, to know a new one
  advisory: boolean // the BIT advisory: a failure not yet looked at on the BIT display
}
export function fresh(): Bit {
  return { tests: {}, results: {}, asking: false, failed: [], advisory: false }
}
// status: the message beside a unit (2.20.3.2's table). In order: off or
// coming up; in test; the INS asking where it is; a failure; a test that could
// not start; then GO once its initiated BIT has passed, PBIT GO before.
export function status(u: Unit, conditions: Conditions, bit: Bit): string {
  const condition = conditions[u.key] ?? 'ok'
  if (condition === 'off') return u.dark ? 'OFF' : 'NOT RDY'
  if (condition === 'wait') return 'NOT RDY'
  if (u.key in bit.tests) return 'IN TEST'
  if (u.key === 'ins' && bit.asking) return 'GND/CV?'
  if (condition === 'degraded') return 'DEGD'
  if (bit.results[u.key] === 'restart') return 'RESTRT'
  return u.plain || bit.results[u.key] === 'go' ? 'GO' : 'PBIT GO'
}
// The messages that are failures: listed in the middle of the top level, and
// what the BIT advisory announces (2.20.3.2, 2.20.3.4.1).
const FAILURES = new Set(['DEGD', 'RESTRT', 'NOT RDY', 'OFF'])
const ANNOUNCED = new Set(['DEGD', 'RESTRT'])
// Worst first: what a group reads is the lowest status any of its units reports.
const ORDER = ['NOT RDY', 'OFF', 'DEGD', 'RESTRT', 'GND/CV?', 'IN TEST', 'PBIT GO', 'GO']
export function within(group: Group): Unit[] {
  return UNITS.filter((u) => u.group === group)
}
export function reading(group: Group, conditions: Conditions, bit: Bit): string {
  const all = within(group).map((u) => status(u, conditions, bit))
  return ORDER.find((s) => all.includes(s)) ?? ''
}
// failures: the units the top level lists by name, each with its message.
export function failures(conditions: Conditions, bit: Bit): [string, string][] {
  return UNITS.map((u): [string, string] => [u.label, status(u, conditions, bit)]).filter(([, s]) => FAILURES.has(s))
}
// What starting a test depends on: the wheels, the FCS BIT consent switch held
// (2.20.3.5.1), and the INS knob at TEST (2.20.3.7).
export interface Consent {
  grounded: boolean
  consent: boolean
  test: boolean
}
// start begins the initiated BIT of the units named. One that is off or
// coming up is left alone, as is a plain one; a ground-only unit is not tested
// in flight. The FCS without its consent switch, and the INS with its knob
// away from TEST, do not respond and read RESTRT; the INS otherwise first asks
// GND or CV.
export function start(bit: Bit, keys: readonly string[], conditions: Conditions, consent: Consent): void {
  for (const key of keys) {
    const u = UNITS.find((k) => k.key === key)
    const condition = conditions[key] ?? 'ok'
    if (!u || u.plain || condition === 'off' || condition === 'wait' || (u.ground && !consent.grounded)) continue
    delete bit.results[key]
    if ((u.group === 'fcs' && !consent.consent) || (key === 'ins' && !consent.test)) bit.results[key] = 'restart'
    else if (key === 'ins') bit.asking = true
    else bit.tests[key] = u.seconds
  }
}
// place answers the INS: on the ground or on the carrier, and its test runs.
export function place(bit: Bit): boolean {
  if (!bit.asking) return false
  bit.asking = false
  bit.tests.ins = (UNITS.find((u) => u.key === 'ins') as Unit).seconds
  return true
}
// stop ends every test in progress, the equipment going back to work
// (2.20.3.10.3).
export function stop(bit: Bit): void {
  bit.tests = {}
  bit.asking = false
}
// step runs the tests, a unit that finishes reading GO, one switched off in
// mid-test dropping out; and keeps the BIT advisory: raised by a new failure,
// taken down while the BIT display is on a display (2.20.3.2).
export function step(bit: Bit, conditions: Conditions, dt: number, looking: boolean): void {
  for (const key of Object.keys(bit.tests)) {
    const condition = conditions[key] ?? 'ok'
    if (condition === 'off' || condition === 'wait') {
      delete bit.tests[key]
      continue
    }
    bit.tests[key] -= dt
    if (bit.tests[key] <= 0) {
      delete bit.tests[key]
      bit.results[key] = 'go'
    }
  }
  const failed = UNITS.filter((u) => ANNOUNCED.has(status(u, conditions, bit))).map((u) => u.key)
  if (failed.some((key) => !bit.failed.includes(key))) bit.advisory = true
  if (looking) bit.advisory = false
  bit.failed = failed
}
// testing: a unit is in initiated BIT, and not doing its work.
export function testing(bit: Bit, key: string): boolean {
  return key in bit.tests
}
