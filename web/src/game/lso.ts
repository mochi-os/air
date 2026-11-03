// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The landing signal officer's pass: what a pass is written up for, segment
// by segment, the grade the write-up earns, and its points. The LSO watches
// the whole groove and remembers the worst of each thing in each part of it -
// not an average, which let a pass that was clean far out and five metres off
// at the wire read as clean - and the grade is the worst thing anywhere,
// weighted by where it was: a deviation at the ramp costs more than the same
// one at the start. The wire is recorded beside the grade and never sets it
// (LSO NATOPS's trend forms keep it in its own column).
//
// The write-up uses the LSO's own shorthand, which is the same in every
// language: H and LO for high and low, LUL and LUR for lined up left and
// right, F and SLO for fast and slow, S for a settle; in parentheses for a
// little, plain, and underlined (_X_) for a lot; X, IM, IC, AR and IW for the
// start, in the middle, in close, at the ramp and in the wires; OWO and WOFD
// for an own and a foul-deck wave-off. Dependency-free, so the rules are
// testable.

export type Segment = 'X' | 'IM' | 'IC' | 'AR' | 'IW'
export const SEGMENTS: Segment[] = ['X', 'IM', 'IC', 'AR', 'IW']

// The worst of each kind seen in one segment, signed: glideslope in degrees
// off the slope (+ high), and at the ramp the hook's height off the optimum
// path in metres as it crosses the round-down (pass_ramp); lineup as an angle
// in degrees far out and metres from IC on (+ left of the centreline); speed
// as degrees of alpha off on-speed (+ slow); settle as metres a second sunk
// faster than the slope's own rate, in close only. null until the segment has
// been flown.
export interface Worst {
  glideslope: number
  lineup: number
  speed: number
  settle: number
}

export interface Pass {
  segments: Record<Segment, Worst | null>
}

export interface Touch {
  sink: number // m/s
  bank: number // rad
  short: number // metres the touchdown fell aft of the first wire's crossing (+ aft)
}

// trap and bolter; waveoff, the LSO's for the pass (technique); own, the
// pilot's, flown past the touchdown without a wave-off; foul, waved off for a
// foul deck, the ship turning or steaming away from the wind
export type Ending = 'trap' | 'bolter' | 'waveoff' | 'own' | 'foul'
export type Grade =
  'PERFECT' | 'OK' | 'FAIR' | 'NO-GRADE' | 'CUT' | 'BOLTER' | 'WAVE OFF'

export const ONSPEED = 8.1

// Where each segment begins, in metres short of the touchdown. IW is the
// wire itself and is recorded at the catch rather than by distance.
const START = { X: 1850, IM: 1200, IC: 600, AR: 250 }
const END = 40 // the watch's own lower bound: the last metres are the touchdown's

// Each deviation's three sizes: written a little from the first, plain from
// the second, underlined past the third. The ramp's are metres of hook height,
// half a wire spacing, one and two of the touchdown's (the Ford's wires
// 12.2-12.8 m apart, NATOPS's 16.4 ft of touchdown per foot of height on a
// 3.5 degree slope).
const SIZES = {
  glideslope: [0.4, 0.7, 1.0], // degrees
  ramp: [0.4, 0.75, 1.5], // metres
  angle: [1, 1.75, 2.5], // lineup in degrees, far out
  metres: [2, 3.5, 5], // lineup in metres, from in close
  speed: [0.7, 1.1, 1.5], // degrees of alpha
  settle: [1, 1.75, 2.5], // metres a second
}

// The touchdown short of the wires: the main gear more than this aft of the
// first wire puts the hook down before it, toward the round-down.
const SHORT = 4.4

export function pass_start(): Pass {
  return { segments: { X: null, IM: null, IC: null, AR: null, IW: null } }
}

// segment_of names the part of the groove `along` metres short of the
// touchdown falls in, or null outside the graded groove.
export function segment_of(along: number): Segment | null {
  if (along > START.X || along < END) return null
  if (along > START.IM) return 'X'
  if (along > START.IC) return 'IM'
  if (along > START.AR) return 'IC'
  return 'AR'
}

// metres says whether a segment's lineup is judged in metres (from in close
// on) rather than as an angle (far out, where the LSO sees a wing line).
function metres(segment: Segment): boolean {
  return segment === 'IC' || segment === 'AR' || segment === 'IW'
}

function worse(current: number, candidate: number): number {
  return Math.abs(candidate) > Math.abs(current) ? candidate : current
}

function blank(): Worst {
  return { glideslope: 0, lineup: 0, speed: 0, settle: 0 }
}

// pass_sample records one frame of the groove: the hook's deviation off the
// slope in degrees (+ high), the lateral offset from the centreline in metres
// (+ left), alpha in degrees, and how much faster than the slope's own rate
// the jet is sinking (m/s), at `along` metres short of the touchdown.
export function pass_sample(
  pass: Pass,
  along: number,
  deviation: number,
  lateral: number,
  alpha: number,
  settle = 0
): void {
  const segment = segment_of(along)
  if (!segment) return
  const lineup = metres(segment)
    ? lateral
    : (Math.atan2(lateral, Math.max(along, 1)) * 180) / Math.PI
  const w = pass.segments[segment] ?? blank()
  // At the ramp the glideslope is not read off the lens geometry: the hook's
  // angle there magnifies a few centimetres into degrees, which is why the
  // LSO's low call also stops at 250 m. It is the hook's height at the
  // round-down instead (pass_ramp).
  if (segment !== 'AR') w.glideslope = worse(w.glideslope, deviation)
  w.lineup = worse(w.lineup, lineup)
  w.speed = worse(w.speed, alpha - ONSPEED)
  if (segment === 'IC' || segment === 'AR')
    w.settle = Math.max(w.settle, settle)
  pass.segments[segment] = w
}

// pass_ramp records the hook's height off the optimum path as it crosses the
// round-down, in metres (+ high): the ramp's glideslope.
export function pass_ramp(pass: Pass, height: number): void {
  const w = pass.segments.AR ?? blank()
  w.glideslope = worse(w.glideslope, height)
  pass.segments.AR = w
}

// pass_wire records the lineup at the catch, in metres (+ left).
export function pass_wire(pass: Pass, lateral: number): void {
  pass.segments.IW = { ...blank(), lineup: lateral }
}

type Kind = keyof Worst
const KINDS: Kind[] = ['glideslope', 'settle', 'lineup', 'speed']

// size grades one deviation: 0 not worth writing, 1 a little, 2 plain, 3
// underlined.
function size(kind: Kind, value: number, segment: Segment): 0 | 1 | 2 | 3 {
  const sizes =
    kind === 'lineup'
      ? metres(segment)
        ? SIZES.metres
        : SIZES.angle
      : kind === 'glideslope' && segment === 'AR'
        ? SIZES.ramp
        : SIZES[kind]
  const magnitude = kind === 'settle' ? value : Math.abs(value)
  return magnitude > sizes[2]
    ? 3
    : magnitude >= sizes[1]
      ? 2
      : magnitude >= sizes[0]
        ? 1
        : 0
}

function word(kind: Kind, value: number): string {
  if (kind === 'glideslope') return value > 0 ? 'H' : 'LO'
  if (kind === 'lineup') return value > 0 ? 'LUL' : 'LUR'
  if (kind === 'settle') return 'S'
  return value > 0 ? 'SLO' : 'F'
}

function written(text: string, sized: 0 | 1 | 2 | 3): string {
  return sized === 3 ? '_' + text + '_' : sized === 2 ? text : '(' + text + ')'
}

// remarks writes the pass up, segment by segment: "(LO) (LUL) IC · _LUL_ IW".
export function remarks(pass: Pass): string {
  const parts: string[] = []
  for (const segment of SEGMENTS) {
    const w = pass.segments[segment]
    if (!w) continue
    const words: string[] = []
    for (const kind of KINDS) {
      const sized = size(kind, w[kind], segment)
      if (sized) words.push(written(word(kind, w[kind]), sized))
    }
    if (words.length) parts.push(words.join(' ') + ' ' + segment)
  }
  return parts.join(' · ')
}

function worst(pass: Pass, ...segments: Segment[]): 0 | 1 | 2 | 3 {
  let most: 0 | 1 | 2 | 3 = 0
  for (const segment of segments) {
    const w = pass.segments[segment]
    if (!w) continue
    for (const kind of KINDS)
      most = Math.max(most, size(kind, w[kind], segment)) as 0 | 1 | 2 | 3
  }
  return most
}

function counted(pass: Pass, ...segments: Segment[]): number {
  let n = 0
  for (const segment of segments) {
    const w = pass.segments[segment]
    if (!w) continue
    for (const kind of KINDS) if (size(kind, w[kind], segment) >= 1) n++
  }
  return n
}

// pass_grade is the grade the pass earns and its write-up, from the approach
// alone. A bolter or a wave-off is not graded but is written up the same way,
// so the pilot sees why. The perfect pass is a clean one at night: the one
// hard condition a trap can meet here, since the deck is closed while the ship
// turns and she always steams into the wind.
export function pass_grade(
  pass: Pass,
  touch: Touch | null,
  waved: boolean,
  ending: Ending,
  night = false
): { grade: Grade; remarks: string } {
  const text = remarks(pass)
  if (ending === 'bolter') return { grade: 'BOLTER', remarks: text }
  if (ending === 'waveoff') return { grade: 'WAVE OFF', remarks: text }
  if (ending === 'own')
    return { grade: 'WAVE OFF', remarks: text ? 'OWO · ' + text : 'OWO' }
  if (ending === 'foul') return { grade: 'WAVE OFF', remarks: 'WOFD' } // the deck's wave-off, not the pilot's: nothing in the pass is written up against the pilot
  const t = touch ?? { sink: 0, bank: 0, short: 0 }
  const early = worst(pass, 'X', 'IM', 'IC')
  const late = worst(pass, 'AR', 'IW')
  const settled = size('settle', pass.segments.AR?.settle ?? 0, 'AR') >= 2
  // CUT: dangerously hard, a wing down, short of the wires, through a
  // wave-off, a settle at the ramp, or a lot at the ramp or in the wires.
  if (
    t.sink > 7 ||
    t.bank > 0.14 ||
    t.short > SHORT ||
    waved ||
    settled ||
    late === 3
  )
    return { grade: 'CUT', remarks: text }
  // NO GRADE: a lot earlier, or plain at the ramp or in the wires.
  if (early === 3 || late === 2) return { grade: 'NO-GRADE', remarks: text }
  // FAIR: plain earlier, a little at the ramp or in the wires, or more than
  // one little earlier.
  if (early === 2 || late === 1 || counted(pass, 'X', 'IM', 'IC') > 1)
    return { grade: 'FAIR', remarks: text }
  if (!text && night) return { grade: 'PERFECT', remarks: text }
  return { grade: 'OK', remarks: text }
}

// points is a graded pass's worth on the training command's scale (CNATRAINST
// 3740.9D 314.h: 5 perfect, 4 OK, 3 fair, 2.5 bolter, 2 no grade, 1 technique
// wave-off, 0 cut), or null for a pass that does not count, the foul deck's.
// The pilot's own wave-off counts 2, as one after the LSO's "Roger ball":
// the game's LSO never refuses a ball call.
export function points(grade: string, written: string): number | null {
  switch (grade) {
    case 'PERFECT':
      return 5
    case 'OK':
      return 4
    case 'FAIR':
      return 3
    case 'BOLTER':
      return 2.5
    case 'NO-GRADE':
      return 2
    case 'CUT':
      return 0
    case 'WAVE OFF':
      return written.startsWith('WOFD')
        ? null
        : written.startsWith('OWO')
          ? 2
          : 1
  }
  return null
}

// Tally is a sortie's passes summed for the log: those that count toward the
// boarding rate (all but the foul deck's), the traps among them, and the
// points of those that score, with their number.
export interface Tally {
  passes: number
  traps: number
  points: number
  scored: number
}

export function tally(
  passes: { grade: string; remarks: string; wire: number }[]
): Tally {
  const out: Tally = { passes: 0, traps: 0, points: 0, scored: 0 }
  for (const pass of passes) {
    if (pass.grade === 'WAVE OFF' && pass.remarks.startsWith('WOFD')) continue
    out.passes++
    if (pass.wire) out.traps++
    const worth = points(pass.grade, pass.remarks)
    if (worth !== null) {
      out.points += worth
      out.scored++
    }
  }
  return out
}
