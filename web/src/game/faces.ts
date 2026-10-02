// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The panels the cockpit model paints too coarsely to read, or as an earlier
// aircraft's, drawn over it as the foldout draws them (NATOPS A1-F18AC-NFM-000
// FO-5, aircraft 163985 and up): the master arm panel (item 12), the emergency
// jettison button (17), the station jettison select buttons (20), and the
// dispenser/EMC panel with the RWR control indicator (35, 36). Each face is a
// flat picture with its controls at points on it: the engine seats it on the
// model, redraws it when what it shows changes, and sends a click on it to the
// control under the pointer. A face's lights are lit by power and by the
// lights test, as the lenses elsewhere in the cockpit are.

import { BUTTONS } from './armament'
import { DISPENSER, JAMMER, type Dispenser, type Indicator, type Jammer } from './countermeasures'

// A control on a face: the action a click on it sends, and where it is - its
// centre and its reach, in the face's own pixels.
export interface Control {
  action: string
  x: number
  y: number
  r: number
}
export interface Face {
  width: number
  height: number
  controls: readonly Control[]
}
export type Name = 'arm' | 'emergency' | 'stations' | 'defence'

// What the faces show.
export interface Shown {
  power: boolean // the lights have power
  test: boolean // the lights test is on
  arm: boolean // MASTER ARM at ARM
  air: boolean // the A/A master mode
  ready: boolean // the extinguisher's READY
  discharged: boolean // and DISCH
  stations: readonly number[] // the station select buttons pressed in
  dispenser: Dispenser
  jammer: Jammer
  indicator: Indicator // the RWR control indicator's lights
}

// The station select buttons' places: CTR over LI and RI over LO and RO. FO-5
// centres CTR over the pairs; here it stands over LI, the model's emergency
// jettison knob hiding the corner beside it from the pilot's eye.
const STATIONS: Record<number, [number, number]> = { 5: [40, 30], 3: [40, 92], 7: [120, 92], 2: [40, 154], 8: [120, 154] }
// The RWR control indicator's pushbuttons, left to right as FO-5 draws them,
// each with the light over it.
const RECEIVER: readonly { button: string; label: string; light: string; lit: keyof Indicator }[] = [
  { button: 'test', label: 'BIT', light: 'FAIL', lit: 'fail' },
  { button: 'offset', label: 'OFFSET', light: 'ENABLE', lit: 'offset' },
  { button: 'special', label: 'SPECIAL', light: 'ENABLE', lit: 'special' },
  { button: 'display', label: 'DISPLAY', light: 'LIMIT', lit: 'limit' },
  { button: 'power', label: 'POWER', light: 'ON', lit: 'power' },
]
const PITCH = 84 // the indicator's button pitch
const receiver = (k: number) => 50 + k * PITCH
const KNOB = { x: 346, y: 290, r: 38 } // the ECM knob
const SWITCH = { x: 178, y: 290 } // the DISPENSER switch

export const FACES: Record<Name, Face> = {
  arm: {
    width: 204, height: 436,
    controls: [
      { action: 'extinguisher', x: 149, y: 57, r: 46 },
      { action: 'mode.air', x: 100, y: 174, r: 30 },
      { action: 'mode.ground', x: 100, y: 218, r: 30 },
      { action: 'arm', x: 124, y: 320, r: 50 },
    ],
  },
  emergency: { width: 136, height: 136, controls: [{ action: 'jettison.emergency', x: 68, y: 68, r: 68 }] },
  stations: { width: 160, height: 184, controls: BUTTONS.map((b) => ({ action: 'jettison.station.' + b.station, x: STATIONS[b.station][0], y: STATIONS[b.station][1], r: 36 })) },
  defence: {
    width: 436, height: 452,
    controls: [
      ...RECEIVER.map((b, k) => ({ action: 'receiver.' + b.button, x: receiver(k), y: 144, r: 42 })),
      { action: 'jammer.jettison', x: 56, y: 276, r: 44 },
      { action: 'dispenser', x: SWITCH.x, y: SWITCH.y, r: 46 },
      { action: 'jammer', x: KNOB.x, y: KNOB.y, r: 62 },
    ],
  },
}
// control: the control under a point of a face - the nearest whose reach holds
// it - or null.
export function control(face: Face, x: number, y: number): Control | null {
  let best: Control | null = null, least = Infinity
  for (const c of face.controls) {
    const d = Math.hypot(c.x - x, c.y - y)
    if (d <= c.r && d < least) { best = c; least = d }
  }
  return best
}

// ---- drawing ----

const PANEL = '#17191a', INK = '#cfd2cc', DIM = '#3a3c38', GREEN = '#2fd24a', AMBER = '#ffc23a'
type Context = CanvasRenderingContext2D
function text(c: Context, words: string, x: number, y: number, size = 15, colour = INK): void {
  c.fillStyle = colour
  c.font = 'bold ' + size + 'px sans-serif'
  c.textAlign = 'center'
  c.textBaseline = 'middle'
  c.fillText(words, x, y)
}
// lens: a lit legend - dark on its face until lit, then in its colour.
function lens(c: Context, s: Shown, words: string, x: number, y: number, w: number, h: number, on: boolean, colour = GREEN, size = 15): void {
  const lit = s.power && (on || s.test)
  c.fillStyle = lit ? '#262826' : '#101210'
  c.fillRect(x - w / 2, y - h / 2, w, h)
  c.strokeStyle = '#4a4d48'
  c.lineWidth = 2
  c.strokeRect(x - w / 2, y - h / 2, w, h)
  text(c, words, x, y, size, lit ? colour : DIM)
}
// hatch: the black and yellow stripes round a guarded control.
function hatch(c: Context, x: number, y: number, w: number, h: number): void {
  c.save()
  c.beginPath(); c.rect(x, y, w, h); c.clip()
  c.fillStyle = '#e8b923'; c.fillRect(x, y, w, h)
  c.strokeStyle = '#141414'; c.lineWidth = 9
  for (let k = -h; k < w; k += 22) { c.beginPath(); c.moveTo(x + k, y + h); c.lineTo(x + k + h, y); c.stroke() }
  c.restore()
}
// toggle: a lever switch seen end on - its collar, and the lever thrown up
// (+1), centred (0) or down (-1).
function toggle(c: Context, x: number, y: number, way: number): void {
  c.fillStyle = '#0c0d0c'; c.beginPath(); c.arc(x, y, 20, 0, 7); c.fill()
  c.strokeStyle = '#6c706a'; c.lineWidth = 3; c.beginPath(); c.arc(x, y, 20, 0, 7); c.stroke()
  c.strokeStyle = '#e4e4dc'; c.lineWidth = 12; c.lineCap = 'round'
  c.beginPath(); c.moveTo(x, y); c.lineTo(x, y - way * 24); c.stroke()
  c.fillStyle = '#f4f4ec'; c.beginPath(); c.arc(x, y - way * 24, 9, 0, 7); c.fill()
  c.lineCap = 'butt'
}

function arm(c: Context, s: Shown): void {
  // FIRE EXTGH: the pushbutton's two lights, READY over DISCH (2.14.2), in its guard's stripes
  hatch(c, 8, 96, 92, 44)
  lens(c, s, 'READY', 149, 39, 86, 34, s.ready, AMBER)
  lens(c, s, 'DISCH', 149, 75, 86, 34, s.discharged, GREEN)
  text(c, 'FIRE', 150, 108, 15); text(c, 'EXTGH', 150, 126, 15)
  lens(c, s, 'A/A', 100, 174, 78, 36, s.air, GREEN, 17); text(c, 'A/A', 174, 174, 15)
  lens(c, s, 'A/G', 100, 218, 78, 36, false, GREEN, 17); text(c, 'A/G', 174, 218, 15)
  text(c, 'ARM', 124, 262, 16)
  toggle(c, 124, 320, s.arm ? 1 : -1)
  text(c, 'SAFE', 124, 378, 16)
  'MASTER'.split('').forEach((letter, k) => text(c, letter, 186, 262 + k * 21, 14))
  text(c, 'EMERG JETT', 102, 420, 14)
}
function emergency(c: Context): void {
  c.save()
  c.beginPath(); c.arc(68, 68, 64, 0, 7); c.clip()
  hatch(c, 0, 0, 136, 136)
  c.restore()
  c.fillStyle = '#101210'; c.fillRect(22, 44, 92, 48)
  text(c, 'PUSH TO', 68, 58, 15); text(c, 'JETT', 68, 78, 15)
}
// The station select buttons: each a pushbutton whose legend is read lit or
// not, with a light inside that comes on when it is pressed in.
function stations(c: Context, s: Shown): void {
  for (const b of BUTTONS) {
    const [x, y] = STATIONS[b.station], lit = s.power && (s.stations.includes(b.station) || s.test)
    c.fillStyle = lit ? '#5a4812' : '#2a2c2a'; c.fillRect(x - 34, y - 26, 68, 52)
    c.strokeStyle = '#6c706a'; c.lineWidth = 2; c.strokeRect(x - 34, y - 26, 68, 52)
    text(c, b.label, x, y, 22, lit ? AMBER : INK)
  }
}
function defence(c: Context, s: Shown): void {
  // the RWR control indicator: each pushbutton's light over its name
  c.strokeStyle = '#4a4d48'; c.lineWidth = 2; c.strokeRect(6, 100, 424, 96)
  RECEIVER.forEach((b, k) => {
    lens(c, s, b.light, receiver(k), 126, 78, 30, s.indicator[b.lit], b.lit === 'fail' ? AMBER : GREEN, 13)
    lens(c, s, b.label, receiver(k), 160, 78, 34, false, INK, 12)
  })
  text(c, 'AN/ALR-67(V)', 218, 188, 10)
  // ECM JETT in its stripes
  hatch(c, 8, 214, 96, 112)
  c.fillStyle = '#101210'; c.fillRect(30, 256, 52, 52); c.strokeStyle = '#8a8d86'; c.lineWidth = 3; c.strokeRect(30, 256, 52, 52)
  c.fillStyle = '#101210'; c.fillRect(12, 220, 88, 24); text(c, 'ECM JETT', 56, 232, 14)
  // the DISPENSER switch: BYPASS, ON, OFF
  text(c, 'DISPENSER', SWITCH.x, 216, 14); text(c, 'BYPASS', SWITCH.x, 236, 14); text(c, 'ON', SWITCH.x - 40, SWITCH.y, 14); text(c, 'OFF', SWITCH.x, 340, 14)
  toggle(c, SWITCH.x, SWITCH.y, DISPENSER.indexOf(s.dispenser) - 1)
  // the ECM knob: OFF at the bottom left, clockwise to XMIT past the top
  const angle = (k: number) => ((235 - k * 40) * Math.PI) / 180
  ;['OFF', 'STBY', 'BIT', 'REC', 'XMIT'].forEach((label, k) => text(c, label, KNOB.x + Math.cos(angle(k)) * (KNOB.r + 30), KNOB.y - Math.sin(angle(k)) * (KNOB.r + 18), 14))
  text(c, 'ECM', KNOB.x, 214, 14)
  c.fillStyle = '#2a2c2a'; c.beginPath(); c.arc(KNOB.x, KNOB.y, KNOB.r, 0, 7); c.fill()
  c.strokeStyle = '#6c706a'; c.lineWidth = 3; c.beginPath(); c.arc(KNOB.x, KNOB.y, KNOB.r, 0, 7); c.stroke()
  const at = angle(JAMMER.indexOf(s.jammer))
  c.strokeStyle = '#f4f4ec'; c.lineWidth = 8
  c.beginPath(); c.moveTo(KNOB.x - Math.cos(at) * KNOB.r * 0.6, KNOB.y + Math.sin(at) * KNOB.r * 0.6); c.lineTo(KNOB.x + Math.cos(at) * KNOB.r, KNOB.y - Math.sin(at) * KNOB.r); c.stroke()
  // AUX REL, which has no hung store to release: at NORM
  c.strokeStyle = '#4a4d48'; c.lineWidth = 2; c.beginPath(); c.moveTo(130, 352); c.lineTo(424, 352); c.stroke()
  text(c, 'AUX REL', 178, 370, 14); text(c, 'ENABLE', 178, 388, 14); toggle(c, 262, 398, -1); text(c, 'NORM', 262, 438, 14)
}

// draw paints a face.
export function draw(name: Name, c: Context, s: Shown): void {
  const face = FACES[name]
  c.clearRect(0, 0, face.width, face.height)
  if (name !== 'emergency') { c.fillStyle = PANEL; c.fillRect(0, 0, face.width, face.height) }
  if (name === 'arm') arm(c, s)
  else if (name === 'emergency') emergency(c)
  else if (name === 'stations') stations(c, s)
  else defence(c, s)
}
