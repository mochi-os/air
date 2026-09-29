// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The Integrated Fuel/Engine Indicator, the LCD block under the left DDI of
// the F/A-18C/D (NATOPS A1-F18AC-NFM-000 2.1.1.7.5, 2.2.10.1, 2.12.8). This
// module is the readout and the button logic, pure so it can be tested; the
// engine draws the face it returns onto the panel quad and feeds the presses.
//
// Engine columns: RPM (N2, 0-199 %), TEMP (EGT, 0-1,999 °C), FF (pounds per
// hour in 100 lb steps, zero below 320), NOZ (0-100 % in tens), OIL (0-195 psi
// in fives). Fuel window: three counters in 10 lb steps - total (legend T),
// internal (legend I) and the BINGO setting - with QTY cycling five sub-levels
// of tank pairs where the BINGO counter is replaced by the total. The arrows
// step BINGO by 100 lb between 0 and 20,000 and only in the normal level. Two
// time lines: the clock in local or zulu (a Z legend) on ZONE, and elapsed time
// on ET - start, freeze the display while timing continues, return to running,
// and a hold of two seconds or more stops it and resets to zero. MODE pressed
// twice within 5 s enters the time set mode, which sets the clock, the zulu
// offset and the date (2.12.8.1).

export type Button = 'mode' | 'qty' | 'up' | 'down' | 'zone' | 'et'
export const BUTTONS: readonly Button[] = ['mode', 'qty', 'up', 'down', 'zone', 'et']

export const STEP = 100 // lb, one arrow press
export const LIMIT = 20000 // lb, the top of the BINGO range
export const HOLD = 2 // s, the ET press that resets
export const ARM = 5 // s, MODE pressed twice within this enters the time set mode
export const IDLE = 30 // s, the time set mode returns to the normal mode after this long without a press
const HOUR = 3600000 // ms

// The time set mode's fields, in the order QTY steps through them (2.12.8.1).
export type Field = 'hours' | 'minutes' | 'delta' | 'year' | 'month' | 'day'
const FIELDS: readonly Field[] = ['hours', 'minutes', 'delta', 'year', 'month', 'day']

// The signal data computer's clock, which the IFEI shows and the mission
// computer's ZTOD reads: a local reading, the host's instant plus an offset,
// frozen while the minutes are set, with zulu delta hours ahead of it.
export interface Clock {
  offset: number // ms from the host's UTC instant to the local reading
  held: number | null // the frozen local reading, ms; null while the clock runs
  delta: number // hours zulu runs ahead of local
}

export interface State {
  level: number // 0 normal, 1-5 the QTY sub-levels
  zulu: boolean // the ZONE selection
  bingo: number // lb, the pilot's setting
  started: number | null // elapsed time's start, in the caller's seconds; null = stopped at zero
  frozen: number | null // the held elapsed display, while timing continues underneath
  clock: Clock
  armed: number | null // the first MODE press's time, awaiting the second
  setting: { field: Field; touched: number } | null // the time set mode's field and its last press; null in the normal mode
}

// The tanks' pounds, from the engine's apportionment of its fuel totals.
export interface Tanks {
  one: number
  four: number
  feed: { left: number; right: number }
  wing: { left: number; right: number }
  external: Record<number, number> // by station, the tanks aboard only
}

export interface Reading {
  rpm: [number, number]
  egt: [number, number]
  flow: [number, number] // pph
  noz: [number, number] // %
  oil: [number, number] // psi
  internal: number // lb
  external: number // lb, every external tank together
  tanks: Tanks
}

interface Counter {
  legend: string
  value: string // '' when the jet has no reading to show
}

export interface Face {
  engine: { label: string; left: string; right: string }[]
  fuel: { upper: Counter; middle: Counter; lower: Counter }
  clock: string
  zulu: boolean
  elapsed: string
}

// fresh is the unit at power-up, delta the host's zulu offset in hours.
export function fresh(bingo = 3000, delta = 0): State {
  return { level: 0, zulu: false, bingo, started: null, frozen: null, clock: start(delta), armed: null, setting: null }
}

// start is the clock on the host's time.
function start(delta: number): Clock {
  return { offset: -delta * HOUR, held: null, delta }
}

// reset puts the clock back on the host's time, in the normal mode: a fresh jet.
export function reset(state: State, delta: number): State {
  return { ...state, clock: start(delta), armed: null, setting: null }
}

// local is the clock's local reading at now, ms on the UTC scale.
function local(clock: Clock, now: Date): number {
  return clock.held ?? now.getTime() + clock.offset
}

// zulu is the clock's zulu time of day in whole seconds.
export function zulu(state: State, now: Date): number {
  const seconds = Math.floor((local(state.clock, now) + state.clock.delta * HOUR) / 1000)
  return ((seconds % 86400) + 86400) % 86400
}

// restart runs a frozen clock on from its frozen reading.
function restart(clock: Clock, now: Date): Clock {
  return clock.held === null ? clock : { ...clock, offset: clock.held - now.getTime(), held: null }
}

// shift moves the clock's reading by ms, frozen or running.
function shift(clock: Clock, ms: number): Clock {
  return clock.held === null ? { ...clock, offset: clock.offset + ms } : { ...clock, held: clock.held + ms }
}

function wrap(v: number, n: number): number {
  return ((v % n) + n) % n
}

function days(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
}

// set steps one field of the clock by one: the hours turn within the day and the
// minutes within the hour, the minutes zeroing the seconds and freezing the
// clock; the zulu offset by an hour; the year, month and day each on its own,
// the day held inside its month.
function set(clock: Clock, field: Field, by: number, now: Date): Clock {
  if (field === 'delta') return { ...clock, delta: clamp(clock.delta + by, -14, 14) }
  const t = local(clock, now)
  const d = new Date(t)
  const year = d.getUTCFullYear(),
    month = d.getUTCMonth(),
    day = d.getUTCDate(),
    hour = d.getUTCHours(),
    minute = d.getUTCMinutes()
  const date = (y: number, m: number, dd: number) => Date.UTC(y, m, Math.min(dd, days(y, m)), hour, minute, d.getUTCSeconds(), d.getUTCMilliseconds()) - t
  switch (field) {
    case 'hours':
      return shift(clock, (wrap(hour + by, 24) - hour) * HOUR)
    case 'minutes':
      return { ...clock, held: t - (t % 60000) + (wrap(minute + by, 60) - minute) * 60000 }
    case 'year':
      return shift(clock, date(year + by, month, day))
    case 'month':
      return shift(clock, date(year, wrap(month + by, 12), day))
    case 'day':
      return shift(clock, date(year, month, wrap(day - 1 + by, days(year, month)) + 1))
  }
}

// normal leaves the time set mode with the clock running.
function normal(state: State, now: Date): State {
  return { ...state, clock: restart(state.clock, now), armed: null, setting: null }
}

// settle returns the time set mode to the normal mode once IDLE seconds pass
// without a press.
export function settle(state: State, at: number, now: Date): State {
  return state.setting && at - state.setting.touched > IDLE ? normal(state, now) : state
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

// step rounds to the display's increment and clamps to its range, blank-safe.
function step(v: number, unit: number, hi: number): string {
  if (!isFinite(v)) return ''
  return String(clamp(Math.round(v / unit) * unit, 0, hi))
}

export function rpm(v: number): string {
  return step(v, 1, 199)
}
function egt(v: number): string {
  return step(v, 1, 1999)
}
export function flow(v: number): string {
  if (!isFinite(v) || v < 320) return '0' // below 320 pph the display reads zero
  return step(v, 100, 199900)
}
export function noz(v: number): string {
  return step(v, 10, 100)
}
export function oil(v: number): string {
  return step(v, 5, 195)
}
function pounds(v: number): string {
  return step(v, 10, 99990)
}

function two(v: number): string {
  return String(v).padStart(2, '0')
}

// shown is the clock's reading on the time line at now, local or zulu, ms on the UTC scale.
function shown(state: State, now: Date): Date {
  return new Date(local(state.clock, now) + (state.zulu ? state.clock.delta * HOUR : 0))
}

// The clock line, 24-hour.
function line(d: Date): string {
  return two(d.getUTCHours()) + ':' + two(d.getUTCMinutes()) + ':' + two(d.getUTCSeconds())
}

// The elapsed line, five positions: hours, minutes, seconds.
export function elapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return Math.min(9, Math.floor(s / 3600)) + ':' + two(Math.floor(s / 60) % 60) + ':' + two(s % 60)
}

// The elapsed seconds the display shows at time `at`.
function running(state: State, at: number): number {
  if (state.started === null) return 0
  if (state.frozen !== null) return state.frozen
  return at - state.started
}

// press applies one pushbutton at time `at` (seconds), held for `hold` seconds,
// the host's clock reading now.
export function press(state: State, button: Button, at: number, hold = 0, now = new Date(0)): State {
  if (state.setting) return adjust(state, button, at, now)
  const next = { ...state }
  switch (button) {
    case 'mode':
      if (state.armed !== null && at - state.armed <= ARM) return { ...state, level: 0, armed: null, setting: { field: 'hours', touched: at } }
      next.armed = at
      break
    case 'qty':
      next.level = (state.level + 1) % 6
      break
    case 'up':
    case 'down':
      if (state.level !== 0) break // BINGO is not adjustable in the sub-levels
      next.bingo = clamp(state.bingo + (button === 'up' ? STEP : -STEP), 0, LIMIT)
      break
    case 'zone':
      next.zulu = !state.zulu
      break
    case 'et':
      if (hold >= HOLD) {
        next.started = null
        next.frozen = null
      } else if (state.started === null) {
        next.started = at
        next.frozen = null
      } else if (state.frozen === null) {
        next.frozen = at - state.started
      } else {
        next.frozen = null
      }
      break
  }
  return next
}

// adjust is a press in the time set mode (2.12.8.1): the arrows set the field and
// QTY steps to the next, the clock running on again as the date fields begin;
// MODE or ET returns to the normal mode with the clock running, and ZONE still
// switches the time line.
function adjust(state: State, button: Button, at: number, now: Date): State {
  const field = (state.setting as { field: Field }).field
  const next = { ...state, setting: { field, touched: at } }
  switch (button) {
    case 'up':
    case 'down':
      next.clock = set(state.clock, field, button === 'up' ? 1 : -1, now)
      break
    case 'qty':
      next.setting.field = FIELDS[Math.min(FIELDS.indexOf(field) + 1, FIELDS.length - 1)]
      if (next.setting.field === 'year') next.clock = restart(state.clock, now)
      break
    case 'mode':
    case 'et':
      return normal(state, now)
    case 'zone':
      next.zulu = !state.zulu
      break
  }
  return next
}

// The five QTY sub-levels: which tanks the upper and middle counters show.
const LEVELS: { upper: string; middle: string }[] = [
  { upper: 'T', middle: 'I' },
  { upper: 'FL', middle: 'FR' },
  { upper: 'TL', middle: 'TR' },
  { upper: 'WL', middle: 'WR' },
  { upper: 'XL', middle: 'XR' },
  { upper: 'C', middle: '' },
]

// Each sub-level legend's tank (2.2.10.2): FL and FR the feed tanks 2 and 3, TL
// and TR the transfer tanks 1 and 4, the wing tanks, and the external tanks on
// stations 3 and 7 and the centreline, blank for a station without one.
function tank(tanks: Tanks, legend: string): number {
  const table: Record<string, number | undefined> = {
    FL: tanks.feed.left,
    FR: tanks.feed.right,
    TL: tanks.one,
    TR: tanks.four,
    WL: tanks.wing.left,
    WR: tanks.wing.right,
    XL: tanks.external[3],
    XR: tanks.external[7],
    C: tanks.external[5],
  }
  return table[legend] ?? NaN
}

// The time set mode's face (2.12.8.1): the engine window, the fuel quantities,
// BINGO and elapsed time blank; T in the upper fuel counter and the field's
// letter in the lower (a flashing H for the hours, M for the minutes) while the
// time is set, with the field flashing on the time line; the zulu offset with
// its sign in the upper counter over DIF; and for the date a flashing D over a
// flashing Y, M or D, the year, month or day on the time line.
function setting(state: State, field: Field, now: Date, at: number): Face {
  const lit = Math.floor(at * 2) % 2 === 0
  const flash = (s: string) => (lit ? s : ' '.repeat(s.length))
  const d = shown(state, now)
  const time = field === 'hours' || field === 'minutes' || field === 'delta'
  const hh = two(d.getUTCHours()),
    mm = two(d.getUTCMinutes())
  const clock = {
    hours: flash(hh) + ':' + mm + ':' + two(d.getUTCSeconds()),
    minutes: hh + ':' + flash(mm) + ':' + two(d.getUTCSeconds()),
    delta: line(d),
    year: String(d.getUTCFullYear()),
    month: two(d.getUTCMonth() + 1),
    day: two(d.getUTCDate()),
  }[field]
  const delta = state.clock.delta
  const upper = field === 'hours' || field === 'minutes' ? 'T' : field === 'delta' ? String(Math.abs(delta)) + (delta < 0 ? '-' : '+') : flash('D')
  const lower = { hours: flash('H'), minutes: 'M', delta: 'DIF', year: flash('Y'), month: flash('M'), day: flash('D') }[field]
  return {
    engine: ['RPM', 'TEMP', 'FF', 'NOZ', 'OIL'].map((label) => ({ label, left: '', right: '' })),
    fuel: { upper: { legend: '', value: upper }, middle: { legend: '', value: '' }, lower: { legend: '', value: lower } },
    clock,
    zulu: state.zulu && time,
    elapsed: '',
  }
}

export function face(reading: Reading, state: State, now: Date, at: number): Face {
  if (state.setting) return setting(state, state.setting.field, now, at)
  const total = reading.internal + reading.external
  const level = LEVELS[state.level] ?? LEVELS[0]
  const value = (legend: string): string => {
    switch (legend) {
      case 'T':
        return pounds(total)
      case 'I':
        return pounds(reading.internal)
      default:
        return pounds(tank(reading.tanks, legend))
    }
  }
  return {
    engine: [
      { label: 'RPM', left: rpm(reading.rpm[0]), right: rpm(reading.rpm[1]) },
      { label: 'TEMP', left: egt(reading.egt[0]), right: egt(reading.egt[1]) },
      { label: 'FF', left: flow(reading.flow[0]), right: flow(reading.flow[1]) },
      { label: 'NOZ', left: noz(reading.noz[0]), right: noz(reading.noz[1]) },
      { label: 'OIL', left: oil(reading.oil[0]), right: oil(reading.oil[1]) },
    ],
    fuel: {
      upper: { legend: level.upper, value: value(level.upper) },
      middle: { legend: level.middle, value: level.middle ? value(level.middle) : '' },
      lower: state.level === 0 ? { legend: 'BINGO', value: String(state.bingo) } : { legend: 'T', value: pounds(total) },
    },
    clock: line(shown(state, now)),
    zulu: state.zulu,
    elapsed: elapsed(running(state, at)),
  }
}

// test is the face the lights test shows (NATOPS 2.6.2.11): the leading 1s for
// RPM, TEMP, FF and OIL, and 0s in every other position of each field (RPM to
// 199, TEMP to 1999, FF to 199,900 pph, NOZ to 100, OIL to 195, the fuel
// counters to 99,990 lb), under the normal display's legends.
export function test(): Face {
  const level = LEVELS[0]
  const zeros = { value: '00000' }
  return {
    engine: [
      { label: 'RPM', left: '100', right: '100' },
      { label: 'TEMP', left: '1000', right: '1000' },
      { label: 'FF', left: '100000', right: '100000' },
      { label: 'NOZ', left: '000', right: '000' },
      { label: 'OIL', left: '100', right: '100' },
    ],
    fuel: {
      upper: { legend: level.upper, ...zeros },
      middle: { legend: level.middle, ...zeros },
      lower: { legend: 'BINGO', ...zeros },
    },
    clock: '00:00:00',
    zulu: false,
    elapsed: '0:00:00',
  }
}
