// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The VHF/UHF radios and their controls (NATOPS A1-F18AC-NFM-000 23.1, 23.2,
// 25.4, figures 23-1 and 23-2, FO-5 sheet 2 items 7 and 13): comm 1 and comm
// 2 as a pair of ARC-182s, one of the fits 23.2 lists - twenty presets, the
// manual and guard channels, plain fixed frequency, no anti-jam - with the
// UFC's comm display, the communication and antenna select panels, and the
// DDI's backup frequency control. Pure: frequencies are whole kilohertz.

// ---- frequencies (23.2) ----

// The ARC-182's bands: megahertz, the modulation each takes, and whether it
// may transmit there. Channels are spaced 25 kHz.
type Modulation = 'am' | 'fm'
const BANDS: readonly { low: number; high: number; modulation: Modulation | 'either'; transmit: boolean }[] = [
  { low: 30000, high: 87975, modulation: 'fm', transmit: true },
  { low: 108000, high: 117975, modulation: 'am', transmit: false },
  { low: 118000, high: 155975, modulation: 'am', transmit: true },
  { low: 156000, high: 173975, modulation: 'fm', transmit: true },
  { low: 225000, high: 399975, modulation: 'either', transmit: true },
]
const SPACING = 25
// GUARD: the guard frequency of the band a radio is working in - 243.0 in UHF
// and 121.5 in VHF.
export const GUARD = { uhf: 243000, vhf: 121500 }
const band = (khz: number) => BANDS.find((b) => khz >= b.low && khz <= b.high)
// valid: a frequency the radio tunes - inside a band and on its spacing.
export function valid(khz: number): boolean {
  return Number.isInteger(khz) && khz % SPACING === 0 && !!band(khz)
}
// modulation: what a frequency is worked in - the band's own, or the
// operator's choice where the band takes either; null off the bands.
export function modulation(khz: number, choice: Modulation): Modulation | null {
  const b = band(khz)
  return !b ? null : b.modulation === 'either' ? choice : b.modulation
}
// selectable: the operator may choose the modulation only in the UHF band.
export function selectable(khz: number): boolean {
  return band(khz)?.modulation === 'either'
}

// ---- a radio ----

// The channel selector knob's positions: the twenty presets, guard and manual
// (23.2.1.1.2; cue and maritime are the ARC-210's).
export type Channel = number | 'G' | 'M'
export const CHANNELS: readonly Channel[] = [...Array.from({ length: 20 }, (_, k) => k + 1), 'G', 'M']
export interface Radio {
  on: boolean
  volume: number // 0 to 1; the volume control turned fully down is off (23.2.1.1.1)
  channel: Channel
  presets: number[] // the twenty, kHz
  manual: number
  guard: number // the guard channel's frequency, which the operator can change (23.2.2.3)
  choice: Modulation // the operator's modulation where the band takes either
  receiver: boolean // GRCV: the guard receiver
  squelch: boolean
  cipher: boolean
  override: boolean // the backup control's OVRD (25.4)
  stored: number // and the frequency the mission computer holds for it
}
// UNSET: what a preset nobody has loaded holds - the bottom of the UHF band.
const UNSET = 225000
// fresh: a radio as the pre-flight leaves it - on, on its first preset, the
// presets the mission load gave and the rest unset, the mission computer's
// backup frequency the one it is working (25.4).
export function fresh(loaded: readonly number[] = []): Radio {
  const presets = Array.from({ length: 20 }, (_, k) => (valid(loaded[k]) ? loaded[k] : UNSET))
  return { on: true, volume: 1, channel: 1, presets, manual: UNSET, guard: GUARD.uhf, choice: 'am', receiver: true, squelch: true, cipher: false, override: false, stored: presets[0] }
}
// load puts the mission's presets into a radio (the MUMI's COMM file).
export function load(r: Radio, loaded: readonly number[]): void {
  loaded.forEach((khz, k) => { if (k < 20 && valid(khz)) r.presets[k] = khz })
}
// selected: the frequency the channel selector has chosen.
export function selected(r: Radio): number {
  return r.channel === 'G' ? r.guard : r.channel === 'M' ? r.manual : r.presets[r.channel - 1]
}
// tuned: the frequency the radio is working - the guard frequency of its band
// with the G XMT switch set to it, the mission computer's with OVRD, else the
// channel selector's.
export function tuned(r: Radio, guarded = false): number {
  const own = r.override ? r.stored : selected(r)
  return guarded ? (own < 225000 ? GUARD.vhf : GUARD.uhf) : own
}
// rotate turns the channel selector a position, clockwise for a positive
// direction; it turns all the way round.
export function rotate(r: Radio, direction: number): void {
  const at = CHANNELS.indexOf(r.channel) + (direction < 0 ? -1 : 1)
  r.channel = CHANNELS[(at + CHANNELS.length) % CHANNELS.length]
}
// turn is the volume control: a fifth of its throw a click, off at the bottom.
export function turn(r: Radio, direction: number): void {
  r.volume = Math.max(0, Math.min(1, Math.round((r.volume + (direction < 0 ? -0.2 : 0.2)) * 100) / 100))
  r.on = r.volume > 0
}
// megahertz writes a frequency as the displays show it: 251.000.
export function megahertz(khz: number): string {
  return (khz / 1000).toFixed(3) // i18n-format-ok: a radio frequency readout, not locale-formatted text
}
// keyed reads a keypad entry as a frequency: six digits of megahertz to the
// kilohertz (MC OFP 13C; 25.4, 23.2.2.1), or null when it is not one the radio
// tunes.
export function keyed(entry: string): number | null {
  if (!/^\d{6}$/.test(entry)) return null
  const khz = +entry
  return valid(khz) ? khz : null
}
// enter stores a keyed frequency in the channel selected - a preset, the
// manual frequency or the guard channel's (23.2.2). false: not a frequency.
export function enter(r: Radio, entry: string): boolean {
  const khz = keyed(entry)
  if (khz === null) return false
  if (r.channel === 'G') r.guard = khz
  else if (r.channel === 'M') r.manual = khz
  else r.presets[r.channel - 1] = khz
  return true
}

// ---- the UFC's comm display (23.2.1.1.5 to 23.2.1.1.7, figure 23-2) ----

// scratch: the scratchpad with a channel selector pulled - the preset's
// number, or M- or G-, and the frequency in its seven digits, whose decimal
// point is part of a digit and leaves the first of them blank.
export function scratch(r: Radio): string {
  return (typeof r.channel === 'number' ? String(r.channel).padStart(2) : r.channel + '-') + ' ' + megahertz(selected(r))
}
// options: the five option windows - GRCV, SQCH, CPHR and the modulation, each
// with its colon when on; the modulation window is blank where the band leaves
// no choice. The fifth, MENU, leads to the anti-jam displays this fit has not.
export function options(r: Radio): string[] {
  const khz = selected(r), mode = modulation(khz, r.choice)
  return [(r.receiver ? ':' : ' ') + 'GRCV', (r.squelch ? ':' : ' ') + 'SQCH', (r.cipher ? ':' : ' ') + 'CPHR', selectable(khz) && mode ? ':' + mode.toUpperCase() : '', '']
}
// option presses one of the option select pushbuttons.
export function option(r: Radio, index: number): void {
  if (index === 0) r.receiver = !r.receiver
  else if (index === 1) r.squelch = !r.squelch
  else if (index === 2) r.cipher = !r.cipher
  else if (index === 3 && selectable(selected(r))) r.choice = r.choice === 'am' ? 'fm' : 'am'
}
// window: the channel display window beside each selector - the preset's
// number, G or M.
export function window(r: Radio): string {
  return r.on ? String(r.channel) : ''
}

// ---- the communication and antenna select panels (23.1, 23.6.2.2, 23.6.2.8) ----

export interface Panel {
  relay: 'cipher' | 'off' | 'plain' // RLY
  guard: 'one' | 'off' | 'two' // G XMT: the radio transmitting on guard
  landing: 'ufc' | 'manual' // ILS UFC or MAN
  channel: number // and the channel its own selector sets, 1 to 20
  antenna: 'upper' | 'auto' | 'lower' // ANT SEL COMM 1; the IFF's selector is the identification set's own
  volume: { tacan: number; receiver: number; weapon: number } // the TCN, RWR and WPN volume controls, 0 to 1
}
export function panel(channel: number): Panel {
  return { relay: 'off', guard: 'off', landing: 'ufc', channel, antenna: 'auto', volume: { tacan: 1, receiver: 1, weapon: 1 } }
}
// step moves a three-position switch a position along its throw, stopping at
// the ends.
export function step<T>(positions: readonly T[], at: T, direction: number): T {
  return positions[Math.max(0, Math.min(positions.length - 1, positions.indexOf(at) + (direction < 0 ? -1 : 1)))]
}
// landing: the ILS channel in use - the UFC's, or the panel's own with the
// switch at MAN.
export function landing(p: Panel, ufc: number): number {
  return p.landing === 'manual' ? p.channel : ufc
}

// ---- the backup frequency control (25.4) ----

// The UFC BU display: COM1 or COM2 pressed shows that radio; the keypad down
// the display's sides builds a frequency in the scratchpad, ENT stores it as
// the mission computer's frequency for the radio and CLR clears it; OVRD puts
// the radio on that frequency in place of the UFC's.
export interface Backup {
  radio: '' | 'one' | 'two'
  entry: string
}
export function backup(): Backup {
  return { radio: '', entry: '' }
}
export type Key = 'one' | 'two' | 'override' | 'enter' | 'clear' | '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9'
// key works one pushbutton of the display. false: a press it does not take -
// a digit, ENT or OVRD with no radio shown, or ENT on an entry that is not a
// frequency, which stays in the scratchpad to be cleared.
export function key(b: Backup, radios: { one: Radio; two: Radio }, name: Key): boolean {
  if (name === 'one' || name === 'two') { b.radio = name; b.entry = ''; return true }
  if (name === 'clear') { b.entry = ''; return true }
  if (!b.radio) return false
  const r = radios[b.radio]
  if (name === 'override') { r.override = !r.override; return true }
  if (name === 'enter') { const khz = keyed(b.entry); if (khz === null) return false; r.stored = khz; b.entry = ''; return true }
  if (b.entry.length >= 6) return false
  b.entry += name
  return true
}
