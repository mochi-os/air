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
// and a hold of two seconds or more stops it and resets to zero.

export type Button = 'mode' | 'qty' | 'up' | 'down' | 'zone' | 'et'
export const BUTTONS: readonly Button[] = ['mode', 'qty', 'up', 'down', 'zone', 'et']

export const STEP = 100 // lb, one arrow press
export const LIMIT = 20000 // lb, the top of the BINGO range
export const HOLD = 2 // s, the ET press that resets

export interface State {
  level: number // 0 normal, 1-5 the QTY sub-levels
  zulu: boolean // the ZONE selection
  bingo: number // lb, the pilot's setting
  started: number | null // elapsed time's start, in the caller's seconds; null = stopped at zero
  frozen: number | null // the held elapsed display, while timing continues underneath
}

export interface Reading {
  rpm: [number, number]
  egt: [number, number]
  flow: [number, number] // pph
  noz: [number, number] // %
  oil: [number, number] // psi
  internal: number // lb
  external: number // lb, every external tank together
  tanks: { left: boolean; right: boolean; centre: boolean } // which external stations carry a tank
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

export function fresh(bingo = 3000): State {
  return { level: 0, zulu: false, bingo, started: null, frozen: null }
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

// The clock line, 24-hour, local or zulu.
function clock(now: Date, zulu: boolean): string {
  return zulu
    ? two(now.getUTCHours()) + ':' + two(now.getUTCMinutes()) + ':' + two(now.getUTCSeconds())
    : two(now.getHours()) + ':' + two(now.getMinutes()) + ':' + two(now.getSeconds())
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

// press applies one pushbutton at time `at` (seconds), held for `hold` seconds.
export function press(state: State, button: Button, at: number, hold = 0): State {
  const next = { ...state }
  switch (button) {
    case 'mode':
      break // the time set mode is not modeled
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

// The five QTY sub-levels: which tanks the upper and middle counters show.
const LEVELS: { upper: string; middle: string }[] = [
  { upper: 'T', middle: 'I' },
  { upper: 'FL', middle: 'FR' },
  { upper: 'TL', middle: 'TR' },
  { upper: 'WL', middle: 'WR' },
  { upper: 'XL', middle: 'XR' },
  { upper: 'C', middle: '' },
]

// The core carries the internal tank as one quantity and every external tank
// together, so the fuselage and wing sub-levels have no per-tank reading to
// show and read blank; the external pair and the centreline share the external
// figure evenly across the tanks fitted.
function tank(reading: Reading, which: 'XL' | 'XR' | 'C'): string {
  const fitted = [reading.tanks.left, reading.tanks.right, reading.tanks.centre].filter(Boolean).length
  const here = which === 'XL' ? reading.tanks.left : which === 'XR' ? reading.tanks.right : reading.tanks.centre
  if (!here || !fitted) return ''
  return pounds(reading.external / fitted)
}

export function face(reading: Reading, state: State, now: Date, at: number): Face {
  const total = reading.internal + reading.external
  const level = LEVELS[state.level] ?? LEVELS[0]
  const value = (legend: string): string => {
    switch (legend) {
      case 'T':
        return pounds(total)
      case 'I':
        return pounds(reading.internal)
      case 'XL':
      case 'XR':
      case 'C':
        return tank(reading, legend)
      default:
        return ''
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
    clock: clock(now, state.zulu),
    zulu: state.zulu,
    elapsed: elapsed(running(state, at)),
  }
}
