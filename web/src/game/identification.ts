// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The identification system (NATOPS A1-F18AC-NFM-000 23.6, figure 23-8): the
// combined interrogator transponder - a transponder answering challenges in
// modes 1, 2, 3/A, C and the secure mode 4, and an air interrogator making
// them - with its UFC displays, the communication panel's IFF switches and the
// antenna selector. Pure: the engine says who is challenging whom and reads
// back who answers, what the UFC shows and which cautions stand. Mode 4's key
// is a side's own: only a challenge from the same side is a valid one.

// The modes one set works, and its codes as their octal digits.
export interface Modes {
  one: boolean
  two: boolean
  three: boolean
  altitude: boolean // mode C
  four: boolean
  key: 'A' | 'B' // the mode 4 code in use
}
export interface Codes {
  one: string // two digits, the first 0-7 and the second 0-3
  two: string // four digits, each 0-7
  three: string
}
export interface Set {
  modes: Modes
  codes: Codes
}
export type Display = 'transponder' | 'interrogator'
export interface Identification {
  on: boolean
  shown: Display // which of the UFC's two IFF displays is up
  option: number // the option whose code the scratchpad shows: 0 mode 1, 1 mode 2, 2 mode 3
  transponder: Set
  interrogator: Set
  master: 'normal' | 'emergency' // the IFF MASTER switch: NORM or EMER
  alert: 'off' | 'display' | 'audible' // the MODE 4 switch: OFF, DIS, DIS/AUD
  crypto: 'hold' | 'normal' | 'zero'
  held: boolean // the mode 4 codes are still in the set
  antenna: 'upper' | 'both' | 'lower'
}
const set = (codes: Partial<Codes> = {}): Set => ({ modes: { one: true, two: true, three: true, altitude: true, four: true, key: 'A' }, codes: { one: '00', two: '0000', three: '0000', ...codes } })
// fresh: the set as the pre-flight leaves it - on, every mode enabled, the
// codes the mission load gave.
export function fresh(codes: Partial<Codes> = {}): Identification {
  return { on: true, shown: 'transponder', option: 2, transponder: set(codes), interrogator: set(codes), master: 'normal', alert: 'display', crypto: 'normal', held: true, antenna: 'both' }
}
// load puts the mission's codes back into both sets (the MUMI's IFF file,
// 23.6.1.5.1).
export function load(id: Identification, codes: Partial<Codes>): void {
  for (const s of [id.transponder, id.interrogator]) Object.assign(s.codes, codes)
}

// ---- the UFC's IFF displays (23.6.1.2, 23.6.1.4, 23.6.2.1, figure 23-8) ----

const MODE = ['one', 'two', 'three'] as const
function current(id: Identification): Set {
  return id[id.shown]
}
// scratch: XP or AI with the set on, then the mode and code the scratchpad
// holds - mode 3's when the display comes up.
export function scratch(id: Identification, entry: string): string {
  const s = current(id), mode = id.option + 1
  return (id.on ? (id.shown === 'transponder' ? 'XP' : 'AI') : '  ') + (mode + '-' + (entry !== '' ? entry : s.codes[MODE[id.option]])).padStart(7)
}
// options: the five windows - 1 with its code, 2, 3 with C, and 4A or 4B, a
// colon before each mode enabled. C leaves the third window when mode 3 is
// enabled alone.
export function options(id: Identification): string[] {
  const m = current(id).modes, colon = (on: boolean) => (on ? ':' : ' ')
  return [colon(m.one) + '1-' + current(id).codes.one, colon(m.two) + '2', colon(m.three) + '3' + (m.three && !m.altitude ? '' : ' C'), id.held ? colon(m.four) + '4' + m.key : '', '']
}
// option presses an option select pushbutton: 1 and 2 enable and disable their
// modes; 3 steps through 3 and C disabled, both enabled, 3 alone; 4 steps
// through 4A, :4A, 4B and :4B. Each of the first three puts its code in the
// scratchpad.
export function option(id: Identification, index: number): void {
  const m = current(id).modes
  if (index === 0) m.one = !m.one
  else if (index === 1) m.two = !m.two
  else if (index === 2) {
    if (!m.three) { m.three = true; m.altitude = true }
    else if (m.altitude) m.altitude = false
    else m.three = false
  } else if (index === 3 && id.held) {
    if (m.four) { m.four = false; m.key = m.key === 'A' ? 'B' : 'A' }
    else m.four = true
  }
  if (index < 3) id.option = index
}
// enter takes a keyed code for the mode in the scratchpad (23.6.1.2): mode 1's
// two digits, the first 0-7 and the second 0-3; modes 2 and 3's four digits,
// each 0-7. false: not a code.
export function enter(id: Identification, entry: string): boolean {
  const ok = id.option === 0 ? /^[0-7][0-3]$/.test(entry) : /^[0-7]{4}$/.test(entry)
  if (!ok) return false
  current(id).codes[MODE[id.option]] = entry
  return true
}
// press is the IFF function key: it brings up the transponder display, and
// pressed again changes between it and the interrogator's.
export function press(id: Identification, up: boolean): void {
  id.shown = up && id.shown === 'transponder' ? 'interrogator' : 'transponder'
  id.option = 2
}

// ---- answering and asking ----

// What the set has to work with: ac power, the UFC's EMCON, which puts it in
// standby (23.6.2.6), and which side of the wings the other aircraft is on,
// for the antenna selected.
export interface Sense {
  power: boolean
  emission: boolean // EMCON is on
  above: boolean // the other aircraft is above the wings
}
// facing: the antenna selected is on the challenger's side - either of them
// at BOTH.
export function facing(antenna: Identification['antenna'], above: boolean): boolean {
  return antenna === 'both' || (antenna === 'upper') === above
}
// answering: the transponder answers mode 4 challenges at all - on, powered,
// out of EMCON, mode 4 enabled with its codes held.
export function answering(id: Identification, s: { power: boolean; emission: boolean }): boolean {
  return id.on && s.power && !s.emission && id.transponder.modes.four && id.held
}
// replying: and answers this one, the selected antenna on its side.
export function replying(id: Identification, s: Sense): boolean {
  return answering(id, s) && facing(id.antenna, s.above)
}
// challenging: the interrogator challenges in mode 4.
export function challenging(id: Identification, s: { power: boolean; emission: boolean }): boolean {
  return id.on && s.power && !s.emission && id.interrogator.modes.four && id.held
}
// step holds or loses the mode 4 codes (23.6.2.2.2): ZERO erases them; at NORM
// they go with the power; HOLD keeps them through a loss of power with the
// gear handle down. handle: the gear handle is up.
export function step(id: Identification, power: boolean, handle: boolean): void {
  if (id.crypto === 'zero' || (!power && !(id.crypto === 'hold' && !handle))) id.held = false
}
// cautions: IFF 4 with the mode 4 codes gone or a valid challenge left
// unanswered, unless the MODE 4 switch is OFF; IFFAI with the codes gone, which
// that switch does not silence (23.6.2.3, 23.6.2.4). challenged: a valid mode
// 4 challenge is arriving; answered: and the transponder is replying to it.
export function cautions(id: Identification, challenged: boolean, answered: boolean): string[] {
  if (!id.on) return []
  const out: string[] = []
  if (id.alert !== 'off' && (!id.held || (challenged && !answered))) out.push('IFF 4')
  if (!id.held) out.push('IFFAI')
  return out
}
// advisories: M4 OK while the transponder answers valid mode 4 challenges,
// with the MODE 4 switch at DIS or DIS/AUD (23.6.2.2.1).
export function advisories(id: Identification, challenged: boolean, answered: boolean): string[] {
  return id.on && id.alert !== 'off' && challenged && answered ? ['M4 OK'] : []
}
