// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The Joint Helmet Mounted Cueing System (NATOPS A1-F18AC-NFM-000 2.21,
// figures 2-52 to 2-58, and the alignment checklists 7.x step 25 and 9.6.1):
// the helmet display's power and start-up test, its alignment to the jet and
// the boresight error an alignment leaves, the HMD format's options, which
// mission computer backs its symbology, and how far the AIM-9's seeker follows
// it. Pure: the engine says what the knob, the switches and the pilot's head
// are doing, and reads back what the helmet reports and shows. Where NATOPS
// says nothing - the brightness modes, REJECT SETUP's sublevel, the
// acquisition reticle - this follows the DCS F/A-18C guide's HMD chapter.

const D = Math.PI / 180
// SBIT: the start-up BIT's seconds, which cannot be stopped (2.21.11.1); the
// manual gives no figure. WARM: the magnetic transmitter's warm-up, 15 to 20
// minutes (2.21.4). DRIFT: how far an alignment made before warm-up may drift.
// HOLD: the seconds the cage/uncage switch is held before ALIGNING turns to
// ALIGN OK; the manual gives no figure. NUDGE: what full TDC deflection moves
// the fine alignment in a second. SHOWN: how long ALIGN OK stays up.
export const SBIT = 10
export const WARM = 1050
export const DRIFT = 0.5 * D
export const HOLD = 1
export const NUDGE = 1 * D
export const SHOWN = 3
// FIELD: the display's radius, a 20° monocular field (2.21, figure 2-55).
// SEEKER: the AIM-9's field about the line it looks along, the 5° circle;
// TRACK: the smaller circle it draws once uncaged and tracking (the DCS guide
// gives no size: half). GIMBAL: how far off the nose the seeker turns.
// ACQUIRE: the HACQ and LACQ reticle's half-angle - they lock what lies inside
// it, the DCS guide's 5° circle. RAISED: how far above the display's centre the
// coarse alignment cross crosses, at the HUD layout's waterline (figure 2-56).
export const FIELD = 10 * D
export const SEEKER = 2.5 * D
export const TRACK = 1.25 * D
export const GIMBAL = 40 * D
export const ACQUIRE = 2.5 * D
export const RAISED = 4 * D

// Angles about the pilot's eye: azimuth + right, elevation + up, roll +
// clockwise.
export interface Angles {
  azimuth: number
  elevation: number
  roll: number
}
export interface Helmet {
  on: boolean // powered last step: the knob off its OFF stop and ac power
  time: number // seconds powered, for the start-up BIT and the warm-up
  error: Angles // the reported line of sight less the true one, as last aligned
  direction: number // the way an early alignment drifts, radians about the line of sight
  drift: number // how far it drifts by the end of warm-up, radians
  aligned: number // seconds powered at the last alignment
  coarse: boolean // a valid coarse alignment (2.21.9)
  mode: '' | 'coarse' | 'fine' // ALIGN boxed, and which alignment (2.21.12)
  axis: 'position' | 'roll' // FA DXDY or FA DROLL (2.21.12.2)
  held: number // seconds the cage/uncage switch has been held in coarse alignment
  failed: boolean // the last coarse alignment read ALIGN FAIL
  reject: number // the HMD's own reject level: NORM, REJ 1, REJ 2
  brightness: 'day' | 'night' | 'auto' // BRT: full, half, or the auto-brightness circuitry's (2.21.1.1)
  blank: boolean // BLNK: blank while the line of sight is through the HUD
  priority: boolean // the TDC assigned to the HMD (2.21.14.1)
  patterns: number // seconds powered when the IBIT test patterns began, -1 for none
  levels: Record<string, Level> // REJECT SETUP: the reject level each symbol goes at
  setup: boolean // REJECT SETUP's sublevel shown
  cursor: [number, number] // its selected column and row
}

// REJECT SETUP's list, two columns as the sublevel shows them, each symbol at
// the level it leaves the display: 0 never (ON), 1 from REJ 1, 2 from REJ 2.
// Null is the left column's blank row.
export type Level = 0 | 1 | 2
const WINDOWS: [string, Level][] = Array.from({ length: 10 }, (_, k) => [`WINDOW ${k + 1}`, 2])
export const SETUP: ([string, Level] | null)[][] = [
  [['ALTITUDE', 0], ['AIRSPEED', 0], ['BARO/RADALT', 0], ['BARO PRES', 0], ['VSI', 0], ['ALPHA', 0], ['NIRD CIRCLE', 0], ['MSL FOR', 0], ['SP/AMR FOV', 0], ['EW', 0],
    ['HMD HEADING', 2], ['HMD ELEV', 2], ['A/C HEADING', 2], ['TIME WINDOW', 2], null, ['MEMBERS', 2], ['CLOSEST FRND', 1], ['TUCO TRACK', 1]],
  [...WINDOWS, ['ALT_ASPD_BOX', 1], ['CLIMB_ASPD', 1], ['MACH', 1], ['G', 1], ['MAX G', 1], ['DONORS', 2], ['OTHERS', 2], ['MIDS INFO', 1]],
]
function defaults(): Record<string, Level> {
  return Object.fromEntries(SETUP.flat().filter((e): e is [string, Level] => !!e))
}

// fresh is the helmet a spawn hands over. ready: an air start's, powered,
// warmed and aligned. Otherwise the knob is off and the helmet has never been
// aligned: error is where its line of sight then reads, and direction the way
// an early alignment will drift.
export function fresh(ready: boolean, error: Angles, direction: number): Helmet {
  return {
    on: ready, time: ready ? WARM : 0, error: ready ? { azimuth: 0, elevation: 0, roll: 0 } : { ...error }, direction, drift: 0, aligned: ready ? WARM : 0,
    coarse: ready, mode: '', axis: 'position', held: 0, failed: false, reject: 0, brightness: 'auto', blank: true, priority: false, patterns: -1,
    levels: defaults(), setup: false, cursor: [0, 0],
  }
}

// step runs the helmet with power or without. Power applied starts the
// start-up BIT and the warm-up over; power removed ends an alignment, the TDC
// priority and the test patterns.
export function step(h: Helmet, power: boolean, dt: number): void {
  if (!power) {
    if (h.on) Object.assign(h, { on: false, mode: '', held: 0, axis: 'position', priority: false, patterns: -1 })
    return
  }
  if (!h.on) Object.assign(h, { on: true, time: 0 })
  h.time += dt
}
// ready: the start-up BIT is done and the helmet is working.
export function ready(h: Helmet): boolean {
  return h.on && h.time >= SBIT
}
// starting: powered and still in its start-up BIT.
export function starting(h: Helmet): boolean {
  return h.on && h.time < SBIT
}
// advisory: the HMD advisory, while coarse alignment is invalid or has not
// been done (2.21.9).
export function advisory(h: Helmet): boolean {
  return h.on && !h.coarse
}

// offset is the error the helmet reports its line of sight with now: the
// alignment's, and the drift an alignment made before warm-up has grown since,
// reaching its full amount as warm-up ends (2.21.4).
export function offset(h: Helmet): Angles {
  const span = WARM - h.aligned
  const grown = span > 0 ? Math.min(1, Math.max(0, (Math.min(h.time, WARM) - h.aligned) / span)) : 0
  return { azimuth: h.error.azimuth + Math.cos(h.direction) * h.drift * grown, elevation: h.error.elevation + Math.sin(h.direction) * h.drift * grown, roll: h.error.roll }
}
// settle makes the present error the alignment's, as of now: what has drifted
// is kept, and what an alignment now may still drift is set by how far warm-up
// has to go.
function settle(h: Helmet): void {
  h.error = offset(h)
  h.aligned = h.time
  h.drift = DRIFT * Math.max(0, 1 - h.time / WARM)
}

// ---- alignment (2.21.12) ----

// align works ALIGN: boxed, coarse alignment; unboxed, alignment ends.
export function align(h: Helmet): void {
  if (h.mode) exit(h)
  else if (ready(h)) Object.assign(h, { mode: 'coarse', held: 0, failed: false, axis: 'position' })
}
// fine works FINE, offered once a coarse alignment is valid: boxed, fine
// alignment; unboxed, back to coarse.
export function fine(h: Helmet): void {
  if (!h.mode || !h.coarse) return
  Object.assign(h, { mode: h.mode === 'fine' ? 'coarse' : 'fine', axis: 'position', held: 0 })
}
// exit ends alignment, which an A/A weapon, MENU, the TDC reassigned, ACM or a
// master mode change also do (2.21.12.3).
export function exit(h: Helmet): void {
  Object.assign(h, { mode: '', held: 0, axis: 'position' })
}
// hold is the cage/uncage switch in coarse alignment, pressed or not, with the
// HUD's alignment cross where the pilot's true line of sight finds it
// (residual) and whether the canopy is down and locked. Held long enough,
// ALIGNING turns to ALIGN OK and the helmet takes the cross to be where it
// looks, so what the pilot's aim was off by is the error left; fine
// alignment follows by itself. The canopy up, it turns to ALIGN FAIL
// (checklist step 25: canopy down and locked to align).
export function hold(h: Helmet, pressed: boolean, dt: number, residual: { azimuth: number; elevation: number }, closed: boolean): void {
  if (h.mode !== 'coarse') return
  if (!pressed) {
    h.held = 0
    return
  }
  if (h.held >= HOLD) return
  h.held += dt
  if (h.held < HOLD) return
  h.failed = !closed
  if (h.failed) return
  h.error = { azimuth: residual.azimuth, elevation: residual.elevation, roll: h.error.roll }
  h.aligned = h.time
  h.drift = DRIFT * Math.max(0, 1 - h.time / WARM)
  Object.assign(h, { coarse: true, mode: 'fine', axis: 'position' })
}
// toggle is a press of the cage/uncage switch in fine alignment: FA DXDY to FA
// DROLL and back.
export function toggle(h: Helmet): void {
  if (h.mode === 'fine') h.axis = h.axis === 'position' ? 'roll' : 'position'
}
// nudge is the TDC in fine alignment, x + right and y + up, moving the HMD's
// crosses the way it is pushed: azimuth and elevation, or roll.
export function nudge(h: Helmet, x: number, y: number, dt: number): void {
  if (h.mode !== 'fine' || (!x && !y)) return
  settle(h)
  if (h.axis === 'position') {
    h.error.azimuth -= x * NUDGE * dt
    h.error.elevation -= y * NUDGE * dt
  } else h.error.roll -= x * NUDGE * dt
}
// message: what the HMD says of the alignment, under its cross.
export function message(h: Helmet): string {
  if (h.mode === 'coarse') return h.failed ? 'ALIGN FAIL' : h.held > 0 ? 'ALIGNING' : 'READY'
  if (h.mode === 'fine') return h.axis === 'position' ? 'FA DXDY' : 'FA DROLL'
  return ''
}
// confirmed: ALIGN OK, for a while after a coarse alignment succeeds.
export function confirmed(h: Helmet): boolean {
  return h.mode === 'fine' && h.coarse && h.time - h.aligned < SHOWN
}

// ---- the HMD format (figures 2-56 and 2-57) and its REJECT SETUP sublevel ----

// press works the format's pushbuttons: ALIGN 20, FINE 1 with a coarse
// alignment made, the reject level 7 (NORM, REJ 1, REJ 2), BRT 11 (DAY, NIGHT,
// AUTO), BLNK 12 and REJECT SETUP 19. MENU is the display's.
export function press(h: Helmet, pb: number): boolean {
  if (h.setup) return choose(h, pb)
  if (pb === 20) align(h)
  else if (pb === 1 && h.mode && h.coarse) fine(h)
  else if (pb === 7) h.reject = (h.reject + 1) % 3
  else if (pb === 11) h.brightness = h.brightness === 'day' ? 'night' : h.brightness === 'night' ? 'auto' : 'day'
  else if (pb === 12) h.blank = !h.blank
  else if (pb === 19) h.setup = true
  else return false
  return true
}
// choose works the sublevel's pushbuttons: the arrows at 6 and 7 pick the
// column, those at 5 and 4 - and 14 and 15 - the symbol; ON at 3, 1 at 2 and 2
// at 1 set the level it leaves at; RETURN at 19 goes back to the format.
function choose(h: Helmet, pb: number): boolean {
  const [column, row] = h.cursor
  if (pb === 19) h.setup = false
  else if (pb === 6 || pb === 7) {
    h.cursor = [pb === 6 ? 0 : 1, row]
    if (!SETUP[h.cursor[0]][row]) move(h, 1)
  } else if (pb === 5 || pb === 14) move(h, -1)
  else if (pb === 4 || pb === 15) move(h, 1)
  else if (pb >= 1 && pb <= 3) {
    const entry = SETUP[column][row]
    if (entry) h.levels[entry[0]] = pb === 3 ? 0 : pb === 2 ? 1 : 2
  } else return false
  return true
}
// move steps the selection up or down its column, over the blank row, and
// stops at either end.
function move(h: Helmet, by: number): void {
  const [column, row] = h.cursor, list = SETUP[column]
  let to = row + by
  while (to >= 0 && to < list.length && !list[to]) to += by
  if (to >= 0 && to < list.length) h.cursor = [column, to]
}
// legends: what the format or the sublevel shows at each pushbutton, and
// whether it is boxed.
export function legends(h: Helmet): [number, string, boolean][] {
  if (h.setup)
    return [[6, '←', false], [7, '→', false], [5, '↑', false], [4, '↓', false], [14, '↑', false], [15, '↓', false], [3, 'ON', false], [2, '1', false], [1, '2', false], [19, 'RETURN', false]]
  const list: [number, string, boolean][] = [
    [7, ['NORM', 'REJ 1', 'REJ 2'][h.reject], false],
    [11, `BRT ${h.brightness.toUpperCase()}`, false],
    [12, 'BLNK', h.blank],
    [19, 'REJECT SETUP', false],
    [20, 'ALIGN', !!h.mode],
  ]
  if (h.mode && h.coarse) list.push([1, 'FINE', h.mode === 'fine'])
  return list
}
// shown: whether a symbol REJECT SETUP lists is on the display at the reject
// level selected.
export function shown(h: Helmet, symbol: string): boolean {
  const level = h.levels[symbol] ?? 0
  return level === 0 || h.reject < level
}
// level: the display's brightness from the knob: DAY full, NIGHT half, and AUTO
// whichever of them the light outside calls for.
export function level(h: Helmet, knob: number, night: boolean): number {
  return h.brightness === 'night' || (h.brightness === 'auto' && night) ? knob / 2 : knob
}
// pattern: which of the four test patterns IBIT shows, each a second
// (2.21.11.2, figure 2-55), or -1.
export function pattern(h: Helmet): number {
  return h.patterns < 0 ? -1 : Math.floor(Math.max(0, h.time - h.patterns)) % 4
}

// ---- the mission computers (2.21.15) ----

// backup: whose symbology the HMD shows. Without MC1, MC2's: airspeed,
// altitude, the A/A weapon and its count, the L&S and the AIM-9's line of
// sight; without MC2, MC1's: airspeed, altitude and the weapon; with neither,
// none.
export type Backup = 'full' | 'two' | 'one' | 'none'
export function backup(mc: { one: boolean; two: boolean }): Backup {
  return mc.one && mc.two ? 'full' : mc.two ? 'two' : mc.one ? 'one' : 'none'
}
// slaving: the radar and the AIM-9 follow the helmet's line of sight - MC2
// does it, and MC1 alone suspends it.
export function slaving(h: Helmet, mc: { one: boolean; two: boolean }): boolean {
  return ready(h) && mc.two
}

// ---- the AIM-9's seeker (2.21.15, 9.6.3) ----

export interface Vector {
  x: number
  y: number
  z: number
}
const dot = (a: Vector, b: Vector) => a.x * b.x + a.y * b.y + a.z * b.z
// slave: where the seeker looks with the helmet slaving it - along the
// helmet's line of sight, held at its gimbal limit about the nose when the
// pilot looks farther off. Both unit vectors.
export function slave(sight: Vector, nose: Vector, limit = GIMBAL): Vector {
  const c = dot(sight, nose)
  if (c >= Math.cos(limit)) return { ...sight }
  const across = { x: sight.x - nose.x * c, y: sight.y - nose.y * c, z: sight.z - nose.z * c }
  const length = Math.hypot(across.x, across.y, across.z)
  if (length < 1e-9) return { ...nose } // looking straight aft: no way is nearer than another
  const s = Math.sin(limit) / length, k = Math.cos(limit)
  return { x: nose.x * k + across.x * s, y: nose.y * k + across.y * s, z: nose.z * k + across.z * s }
}
// within: a unit direction lies inside a cone about a unit line.
export function within(line: Vector, to: Vector, angle: number): boolean {
  return dot(line, to) >= Math.cos(angle)
}
// pack writes a world direction as the input datagram carries the seeker's
// line: its azimuth from +x toward +z and its elevation, in hundredths of a
// degree, two small integers where three floats would not fit the datagram.
export function pack(v: Vector): [number, number] {
  return [Math.round((Math.atan2(v.z, v.x) / D) * 100), Math.round((Math.asin(Math.max(-1, Math.min(1, v.y))) / D) * 100)]
}
// unpack reads it back.
export function unpack([azimuth, elevation]: [number, number]): Vector {
  const a = (azimuth / 100) * D, e = (elevation / 100) * D
  return { x: Math.cos(e) * Math.cos(a), y: Math.sin(e), z: Math.cos(e) * Math.sin(a) }
}
