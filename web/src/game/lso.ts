// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The landing signal officer's pass: what a pass is written up for, segment
// by segment, and the grade the write-up earns. The LSO watches the whole
// groove and remembers the worst of each thing in each part of it - not an
// average, which let a pass that was clean far out and five metres off at
// the wire read as clean - and the grade is the worst thing anywhere,
// weighted by where it was: a deviation at the ramp costs more than the same
// one at the start.
//
// The write-up uses the LSO's own shorthand, which is the same in every
// language: H and LO for high and low, LUL and LUR for lined up left and
// right, F and S for fast and slow; parentheses for a little, plain for
// gross; X, IM, IC, AR and IW for the start, in the middle, in close, at the
// ramp and in the wires. Dependency-free, so the rules are testable.

export type Segment = 'X' | 'IM' | 'IC' | 'AR' | 'IW'
export const SEGMENTS: Segment[] = ['X', 'IM', 'IC', 'AR', 'IW']

// The worst of each kind seen in one segment, signed: glideslope in degrees
// off the slope (+ high), lineup as an angle in degrees far out and metres
// from IC on (+ left of the centreline), speed as degrees of alpha off
// on-speed (+ slow). null until the segment has been flown.
export interface Worst {
  glideslope: number
  lineup: number
  speed: number
}

export interface Pass {
  segments: Record<Segment, Worst | null>
}

export interface Touch {
  sink: number // m/s
  bank: number // rad
  fa: number // the touchdown's fore-aft on the deck, m; below -120 is at the round-down
}

export type Ending = 'trap' | 'bolter' | 'waveoff'
export type Grade = 'OK' | 'FAIR' | 'NO-GRADE' | 'CUT' | 'BOLTER' | 'WAVE OFF'

export const ONSPEED = 8.1

// Where each segment begins, in metres short of the touchdown. IW is the
// wire itself and is recorded at the catch rather than by distance.
const START = { X: 1850, IM: 1200, IC: 600, AR: 250 }
const END = 40 // the watch's own lower bound: the last metres are the touchdown's

// How big a deviation has to be to be written up at all, and to be gross.
const LITTLE = { glideslope: 0.4, angle: 1, metres: 2, speed: 0.7 }
const GROSS = { glideslope: 1.0, angle: 2.5, metres: 5, speed: 1.5 }

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

// pass_sample records one frame of the groove: the hook's deviation off the
// slope in degrees (+ high), the lateral offset from the centreline in metres
// (+ left), alpha in degrees, at `along` metres short of the touchdown.
export function pass_sample(pass: Pass, along: number, deviation: number, lateral: number, alpha: number): void {
  const segment = segment_of(along)
  if (!segment) return
  const lineup = metres(segment) ? lateral : (Math.atan2(lateral, Math.max(along, 1)) * 180) / Math.PI
  const w = pass.segments[segment] ?? { glideslope: 0, lineup: 0, speed: 0 }
  // At the ramp the glideslope is not read off the lens geometry: the hook's
  // angle there magnifies a metre into degrees and reads falsely low, which
  // is why the LSO's low call also stops at 250 m. The ramp's glideslope is
  // what the ramp produced - the wire - and pass_grade reads it from that.
  if (segment !== 'AR') w.glideslope = worse(w.glideslope, deviation)
  w.lineup = worse(w.lineup, lineup)
  w.speed = worse(w.speed, alpha - ONSPEED)
  pass.segments[segment] = w
}

// pass_wire records the lineup at the catch, in metres (+ left).
export function pass_wire(pass: Pass, lateral: number): void {
  pass.segments.IW = { glideslope: 0, lineup: lateral, speed: 0 }
}

// size grades one deviation: 0 not worth writing, 1 a little, 2 gross.
function size(kind: keyof Worst, value: number, segment: Segment): 0 | 1 | 2 {
  const magnitude = Math.abs(value)
  const little = kind === 'lineup' ? (metres(segment) ? LITTLE.metres : LITTLE.angle) : LITTLE[kind]
  const gross = kind === 'lineup' ? (metres(segment) ? GROSS.metres : GROSS.angle) : GROSS[kind]
  return magnitude > gross ? 2 : magnitude >= little ? 1 : 0
}

function word(kind: keyof Worst, value: number): string {
  if (kind === 'glideslope') return value > 0 ? 'H' : 'LO'
  if (kind === 'lineup') return value > 0 ? 'LUL' : 'LUR'
  return value > 0 ? 'S' : 'F'
}

const KINDS: (keyof Worst)[] = ['glideslope', 'lineup', 'speed']

// remarks writes the pass up, segment by segment: "(LUL) IC · LUL IW". The
// wire is the ramp's own glideslope comment: a 1 wire is a little low in the
// wires, a 4 wire a little high.
export function remarks(pass: Pass, wire = 0): string {
  const parts: string[] = []
  for (const segment of SEGMENTS) {
    const w = pass.segments[segment]
    if (!w && !(segment === 'IW' && (wire === 1 || wire === 4))) continue
    const words: string[] = []
    if (segment === 'IW' && wire === 1) words.push('(LO)')
    if (segment === 'IW' && wire === 4) words.push('(H)')
    for (const kind of KINDS) {
      if (!w) break
      const s = size(kind, w[kind], segment)
      if (s === 2) words.push(word(kind, w[kind]))
      else if (s === 1) words.push('(' + word(kind, w[kind]) + ')')
    }
    if (words.length) parts.push(words.join('') + ' ' + segment)
  }
  return parts.join(' · ')
}

function worst(pass: Pass, segment: Segment): 0 | 1 | 2 {
  const w = pass.segments[segment]
  if (!w) return 0
  let most: 0 | 1 | 2 = 0
  for (const kind of KINDS) most = Math.max(most, size(kind, w[kind], segment)) as 0 | 1 | 2
  return most
}

function counted(pass: Pass, segment: Segment): number {
  const w = pass.segments[segment]
  if (!w) return 0
  let n = 0
  for (const kind of KINDS) if (size(kind, w[kind], segment) >= 1) n++
  return n
}

// pass_grade is the grade the pass earns and its write-up. A bolter or a
// wave-off is not graded as a trap but is written up the same way, so the
// pilot sees why.
export function pass_grade(
  pass: Pass,
  touch: Touch | null,
  wire: number,
  waved: boolean,
  ending: Ending
): { grade: Grade; remarks: string } {
  const written = remarks(pass, ending === 'trap' ? wire : 0)
  if (ending === 'bolter') return { grade: 'BOLTER', remarks: written }
  if (ending === 'waveoff') return { grade: 'WAVE OFF', remarks: written }
  const t = touch ?? { sink: 0, bank: 0, fa: 0 }
  const settled = wire === 1 && t.sink > 6 // a firm arrival in the 1 wire: the settle at the ramp
  // CUT: dangerously hard, a wing down at the deck, the round-down, through a
  // wave-off, gross at the ramp or in the wires, or a settle at the ramp
  // into the 1 wire.
  if (t.sink > 7 || t.bank > 0.14 || t.fa < -120 || waved) return { grade: 'CUT', remarks: written }
  if (worst(pass, 'AR') === 2 || worst(pass, 'IW') === 2 || settled) return { grade: 'CUT', remarks: written }
  // NO GRADE: gross anywhere earlier, anything at the ramp or in the wires,
  // the 1 wire, or a 4 wire that was not clean.
  if (worst(pass, 'X') === 2 || worst(pass, 'IM') === 2 || worst(pass, 'IC') === 2) return { grade: 'NO-GRADE', remarks: written }
  if (worst(pass, 'AR') >= 1 || worst(pass, 'IW') >= 1 || wire === 1) return { grade: 'NO-GRADE', remarks: written }
  const little = counted(pass, 'X') + counted(pass, 'IM') + counted(pass, 'IC')
  if (wire === 4) return { grade: little ? 'NO-GRADE' : 'FAIR', remarks: written }
  // OK: at most one little deviation, and only at the start or in the
  // middle; a 2 or 3 wire; not firm.
  if (little <= 1 && counted(pass, 'IC') === 0 && (wire === 2 || wire === 3) && t.sink < 6) return { grade: 'OK', remarks: written }
  return { grade: 'FAIR', remarks: written }
}
