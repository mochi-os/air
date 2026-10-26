// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The plates laid over the cockpit model's paint where it blurs zoomed in, as the
// centre panel's were (#139): each a flat face seated on the panel the model paints,
// its legends drawn sharp on a canvas, with the controls on it - knobs, toggles, a
// guard, a light - built as geometry by the engine and set to what they work. A
// plate's frame is its origin and two unit vectors in the jet's frame, right and up
// as the pilot reads it; a point on it is [along right, along up] in metres from the
// origin, and the plate's normal, right x up, faces the pilot.
//
// The faces and what they carry are NATOPS A1-F18AC-NFM-000 FO-5 (aircraft 163985
// and up): the map gain/spin recovery panel right of the right DDI (item 16), whose
// MAP GAIN knob is the HMD's OFF/BRT knob on this jet (2.21.6); and the panel under
// the IFEI with its brightness knob, the video selector and the video record mode
// selector (item 23). Each is measured on the cockpit shell, whose face the pilot
// sees: its outline from the shell's own triangles, and what is on it from the
// shell's paint, laid out as the model's detailed copy of the panel lays it out.
// The side consoles' panels (sheet 2, #146) are measured on the consoles' own
// paint, each on the face of its panel where it stands proud of the console.

export type Vector = readonly [number, number, number]
export type Point = readonly [number, number]
// A legend: its centre, its capital height (m), turned anticlockwise (degrees) as
// read; stacked, its letters one under another; boxed, on a dark box, as the spin
// recovery switch's positions are on the stripes.
export interface Legend { at: Point; text: string; size: number; turn?: number; stacked?: boolean; boxed?: boolean }
// A knob: its centre, radius and height off the plate; its pointer turned to what it
// sets. A lever is a bar-shaped knob, its blade the pointer.
export interface Knob { at: Point; radius: number; height: number; shape: 'round' | 'lever' }
// A toggle: its centre and its positions from the top of its throw to the bottom, the
// throw turned anticlockwise (degrees) where the panel reads sideways, and the lever's
// size against the centre panel's (#139), a console's standing longer.
export interface Toggle { at: Point; positions: readonly string[]; turn?: number; scale?: number }
// A window showing a value the engine names (show): its corners [a0, b0, a1, b1] and
// the turn its figures read at.
export interface Window { at: readonly [number, number, number, number]; turn: number; show: string }
// A light: its centre and size (m) on the plate, its legend, colour, and turn.
export interface Lamp { at: Point; size: Point; text: string; colour: string; turn: number }
// A guard over a toggle: its outline's centre and size, how far it stands off the
// plate closed, and the toggle position it holds closed over.
export interface Guard { at: Point; size: Point; height: number; closed: string }
export interface Plate {
  origin: Vector
  right: Vector
  up: Vector
  outline: readonly Point[]
  lighting: 'instrument' | 'console'
  legends: readonly Legend[]
  stripes?: readonly (readonly [number, number, number, number])[] // hazard-striped rectangles, [a0, b0, a1, b1]
  lines?: readonly (readonly [number, number, number, number])[] // rules and ticks, [a0, b0, a1, b1]
  rings?: readonly (readonly [number, number, number, string?])[] // a switch's bushing or a lens, [a, b, radius, fill]
  boxes?: readonly (readonly [number, number, number, number, string?])[] // a housing's outline, or a slot filled, [a0, b0, a1, b1, fill]
  slots?: readonly (readonly [number, number, number, number])[] // rounded light slots, [a0, b0, a1, b1]
  trefoils?: readonly (readonly [number, number, number])[] // the yellow and black radiation marks, [a, b, radius]
  needles?: readonly (readonly [number, number, number, number, number])[] // a gauge's pointer, [a, b, length, degrees clockwise from up, width]
  windows?: readonly Window[]
  knobs?: Readonly<Record<string, Knob>>
  toggles?: Readonly<Record<string, Toggle>>
  lamps?: Readonly<Record<string, Lamp>>
  guards?: Readonly<Record<string, Guard>>
}

export const PIXELS = 4000 // canvas pixels a metre of plate at scale 1, as the centre panel's
export const COLOURS = { plate: '#2f322f', console: '#1d1f1e', ink: '#e6e6dc', box: '#141514', yellow: '#e2a73a', black: '#1a1a18', ring: '#a9aaa4', slot: '#b8b9b2' }
// The hazard stripes, fitted to the model's paint by its strongest spatial frequency:
// black bands across a wave angle degrees anticlockwise from the face's right, period
// metres apart, duty of each period black - the spin recovery panel's, scaled onto the
// shell's face, and the canopy jettison handle's along its length.
export interface Stripe { angle: number; period: number; duty: number }
export const STRIPES: Record<'panel' | 'handle', Stripe> = { panel: { angle: -40.6, period: 0.021, duty: 0.45 }, handle: { angle: 39.8, period: 0.0117, duty: 0.25 } }

// The spin recovery panel's face is the shell's at x 6.1673 (three triangles); its
// controls are the detailed copy's, scaled from that copy's 45 x 144 mm onto the
// shell's 58 x 161 mm face.
const SPIN_KNOB: Point = [0.3403, 0.341]
export const PLATES: Record<string, Plate> = {
  spin: {
    origin: [6.1673, 0, 0], right: [0, 0, 1], up: [0, 1, 0],
    outline: [[0.3124, 0.2434], [0.37, 0.2434], [0.37, 0.3641], [0.3477, 0.4039], [0.3124, 0.4039]],
    lighting: 'instrument',
    stripes: [[0.3124, 0.2434, 0.37, 0.3111]],
    legends: [
      { at: [0.3289, 0.3973], text: 'IR COOL', size: 0.0031 },
      { at: [0.3317, 0.3918], text: 'ORIDE', size: 0.0031 },
      { at: [0.3505, 0.3761], text: 'NORM', size: 0.0031, stacked: true },
      { at: [0.3327, 0.3602], text: 'OFF', size: 0.0031 },
      { at: [0.3398, 0.3536], text: 'HMD', size: 0.0031 },
      { at: [SPIN_KNOB[0] - 0.0105, SPIN_KNOB[1] - 0.0075], text: 'OFF', size: 0.0024 },
      { at: [SPIN_KNOB[0] + 0.0105, SPIN_KNOB[1] - 0.0075], text: 'BRT', size: 0.0024 },
      { at: [0.3298, 0.3173], text: 'SPIN', size: 0.0036 },
      { at: [0.327, 0.3052], text: 'RCVY', size: 0.0031, boxed: true },
      { at: [0.327, 0.2613], text: 'NORM', size: 0.0031, boxed: true },
    ],
    knobs: { 'knob.hmd': { at: SPIN_KNOB, radius: 0.0062, height: 0.007, shape: 'round' } },
    toggles: { ircool: { at: [0.3336, 0.377], positions: ['oride', 'norm', 'off'] }, 'spin.recovery': { at: [0.3576, 0.2868], positions: ['rcvy', 'norm'] } },
    lamps: { spin: { at: [0.3265, 0.2864], size: [0.0095, 0.02], text: 'SPN\nRCVY', colour: '#ffc23a', turn: 90 } },
    guards: { 'spin.recovery': { at: [0.3576, 0.2868], size: [0.0174, 0.0434], height: 0.012, closed: 'norm' } },
  },
  // The panel under the IFEI is the shell's tub face at x 6.2111, below the IFEI's bezel.
  record: {
    origin: [6.2111, 0, 0], right: [0, 0, 1], up: [0, 1, 0],
    outline: [[-0.3205, 0.0405], [-0.118, 0.0405], [-0.118, 0.0785], [-0.3205, 0.0785]],
    lighting: 'instrument',
    legends: [
      { at: [-0.3009, 0.0702], text: 'IFEI', size: 0.0028 },
      { at: [-0.313, 0.044], text: 'OFF', size: 0.0024 },
      { at: [-0.289, 0.044], text: 'BRT', size: 0.0024 },
      { at: [-0.2665, 0.0525], text: 'L', size: 0.0024 },
      { at: [-0.2665, 0.047], text: 'DDI', size: 0.0024 },
      { at: [-0.2325, 0.057], text: 'HUD', size: 0.0024 },
      { at: [-0.1795, 0.0702], text: 'VIDEO RECORD', size: 0.0028 },
      { at: [-0.1885, 0.0625], text: 'MAN', size: 0.0024 },
      { at: [-0.1885, 0.0555], text: 'OFF', size: 0.0024 },
      { at: [-0.1885, 0.048], text: 'AUTO', size: 0.0024 },
    ],
    knobs: {
      'knob.ifei': { at: [-0.3053, 0.051], radius: 0.0055, height: 0.007, shape: 'round' },
      'record.source': { at: [-0.252, 0.057], radius: 0.007, height: 0.008, shape: 'round' },
      recorder: { at: [-0.2085, 0.057], radius: 0.007, height: 0.008, shape: 'lever' },
    },
  },
  // The consoles (#146, FO-5 sheet 2): each panel's face where the model paints it, the frame
  // fitted to the console's triangles under the panel's paint and anchored on that paint,
  // up toward the nose; what is on it measured on the paint rendered flat in that frame.
  // The switches and knobs the model animates stand on these plates as they did on the paint;
  // the levers it merged into a fixed mesh are cut away and built here (toggles).
  // the APU panel's ENG CRANK switch (FO-5 sheet 2 item 14)
  crank: {
    origin: [5.7229, -0.0379, -0.4428], right: [0, -0.1733, 0.9849], up: [1, 0, 0],
    outline: [[-0.0277, -0.0173], [0.0268, -0.0173], [0.0268, 0.0199], [-0.0277, 0.0199]],
    lighting: 'console',
    legends: [
      { at: [0.002, 0.0157], text: 'ENG CRANK', size: 0.0042 }, { at: [-0.0073, 0], text: 'L', size: 0.0036 }, { at: [0.0162, 0.0003], text: 'R', size: 0.0036 },
      { at: [0.0044, -0.0119], text: 'OFF', size: 0.0038 },
    ],
    rings: [[-0.015, 0.0046, 0.005], [0.0043, 0.0009, 0.0087]],
  },
  // the auxiliary power unit panel (item 14)
  apu: {
    origin: [5.7857, -0.0379, -0.4428], right: [0, -0.1733, 0.9849], up: [1, 0, 0],
    outline: [[-0.0277, -0.0434], [0.0268, -0.0434], [0.0268, 0.0448], [-0.0277, 0.0448]],
    lighting: 'console',
    legends: [
      { at: [0.0021, 0.0283], text: 'APU', size: 0.0044 }, { at: [-0.0096, 0.0097], text: 'ON', size: 0.004 }, { at: [0.0147, 0.0097], text: 'READY', size: 0.0038 },
      { at: [-0.0098, -0.0201], text: 'OFF', size: 0.004 },
    ],
    lines: [[-0.0185, -0.041, 0.022, -0.041]],
    rings: [[-0.0096, -0.0044, 0.0087], [0.0145, -0.0035, 0.008, '#22402a']],
  },
  // the flight control system panel with the rudder trim knob (item 6)
  trim: {
    origin: [5.7347, -0.0561, -0.3371], right: [0, -0.1733, 0.9849], up: [1, 0, 0],
    outline: [[-0.0777, -0.027], [0.0768, -0.027], [0.0768, 0.0308], [-0.0777, 0.0308]],
    lighting: 'console',
    legends: [
      { at: [-0.0452, 0.0225], text: 'RUD TRIM', size: 0.0046 }, { at: [-0.0602, 0.014], text: 'L', size: 0.0045 }, { at: [-0.0287, 0.014], text: 'R', size: 0.0045 },
      { at: [-0.0447, -0.0185], text: 'T/O TRIM', size: 0.0038 }, { at: [-0.0447, -0.0229], text: 'PUSH', size: 0.0038 }, { at: [0.0218, 0.0158], text: 'GAIN', size: 0.0038 },
      { at: [0.0233, 0.002], text: 'ORIDE', size: 0.0038 }, { at: [0.0233, -0.013], text: 'NORM', size: 0.0038 }, { at: [0.0468, 0.0135], text: 'RESET', size: 0.0038 },
      { at: [0.0603, 0.0008], text: 'FCS', size: 0.0046, stacked: true },
    ],
    lines: [
      [-0.0528, -0.0076, -0.056, -0.0108], [-0.0562, 0.0005, -0.0607, 0.0005], [-0.0528, 0.0086, -0.056, 0.0118], [-0.0447, 0.012, -0.0447, 0.0165],
      [-0.0366, 0.0086, -0.0334, 0.0118], [-0.0332, 0.0005, -0.0287, 0.0005], [-0.0366, -0.0076, -0.0334, -0.0108], [0.012, 0.0185, 0.012, -0.016],
    ],
    rings: [[0.0053, 0.0025, 0.0045], [0.0468, 0.0025, 0.007, '#9b9d99']],
    boxes: [[-0.0007, -0.016, 0.0118, 0.0185]],
  },
  // the fuel panel (item 5)
  fuel: {
    origin: [5.8118, -0.056, -0.3371], right: [0, -0.1731, 0.9849], up: [1, 0, 0],
    outline: [[-0.064, -0.043], [0.0743, -0.043], [0.0743, 0.0445], [-0.064, 0.0445]],
    lighting: 'console',
    legends: [
      { at: [-0.0447, 0.0338], text: 'PROBE', size: 0.0036 }, { at: [-0.0447, 0.0295], text: 'EMERGENCY', size: 0.0036 }, { at: [-0.0447, 0.0252], text: 'EXTD', size: 0.0036 },
      { at: [-0.0447, -0.0328], text: 'RETRACT', size: 0.0036 }, { at: [-0.0267, -0.0035], text: 'EXTEND', size: 0.0032, stacked: true }, { at: [0.0278, 0.038], text: 'EXT TANKS', size: 0.0046 },
      { at: [-0.0007, 0.0295], text: 'WINGS', size: 0.0038 }, { at: [0.0553, 0.0297], text: 'CTR', size: 0.0038 }, { at: [0.0286, 0.0282], text: 'ORIDE', size: 0.0038 },
      { at: [0.0278, 0.0157], text: 'NORM', size: 0.0038 }, { at: [0.0278, 0.0025], text: 'STOP', size: 0.0038 }, { at: [0.0443, -0.0065], text: 'DUMP', size: 0.0046 },
      { at: [0.0443, -0.0125], text: 'ON', size: 0.0038 }, { at: [0.0443, -0.0385], text: 'OFF', size: 0.0038 }, { at: [0.0686, 0.0025], text: 'FUEL', size: 0.0042, stacked: true },
    ],
    lines: [[-0.0012, 0.034, -0.0012, 0.038], [-0.0012, 0.038, 0.0035, 0.038], [0.0511, 0.038, 0.0561, 0.038], [0.0561, 0.038, 0.0561, 0.034]],
    rings: [[-0.0447, -0.003, 0.0085], [0.0101, 0.0152, 0.0085, '#6b2621'], [0.0458, 0.0152, 0.0085, '#6b2621'], [0.0443, -0.025, 0.0085]],
    boxes: [[-0.0542, -0.028, -0.0352, 0.0225]],
  },
  // the exterior lights panel with INTR WING (items 4, 2.2.3.3)
  exterior: {
    origin: [5.9363, -0.0491, -0.3776], right: [0, -0.1732, 0.9849], up: [1, 0, 0],
    outline: [[-0.0365, -0.073], [0.0364, -0.073], [0.0364, 0.074], [-0.0365, 0.074]],
    lighting: 'console',
    legends: [
      { at: [0.0016, 0.0689], text: 'FORMATION', size: 0.0045 }, { at: [0.0006, 0.0412], text: 'OFF', size: 0.0038 }, { at: [0.0188, 0.0412], text: 'BRT', size: 0.0038 },
      { at: [-0.0186, 0.0304], text: 'POSITION', size: 0.0046 }, { at: [-0.0285, 0.0016], text: 'OFF', size: 0.0038 }, { at: [-0.0117, 0.001], text: 'BRT', size: 0.0038 },
      { at: [0.0112, 0.0314], text: 'STROBE', size: 0.0046 }, { at: [0.0112, 0.025], text: 'BRT', size: 0.0046 }, { at: [0.0258, 0.0101], text: 'OFF', size: 0.004, stacked: true },
      { at: [0.0016, -0.0165], text: 'INTR WING', size: 0.0046 }, { at: [0.0016, -0.0309], text: 'INHIBIT', size: 0.004 }, { at: [0.0016, -0.0552], text: 'NORM', size: 0.004 },
    ],
    lines: [
      [0.01, 0.0641, 0.01, 0.0599], [0, 0.0593, 0.004, 0.0554], [0.016, 0.0554, 0.02, 0.0593], [0.0034, 0.0446, 0.0064, 0.0478],
      [0.0142, 0.0478, 0.0175, 0.0446], [-0.0198, 0.0246, -0.0198, 0.0196], [-0.0297, 0.0189, -0.0257, 0.0154], [-0.0141, 0.0154, -0.0101, 0.0189],
      [-0.0267, 0.0046, -0.0231, 0.0078], [-0.0159, 0.0078, -0.012, 0.0046], [-0.0315, -0.0078, 0.0286, -0.0078],
    ],
    rings: [[0.0106, 0.0112, 0.0084], [0.0011, -0.045, 0.0066]],
    toggles: {
      'wing.inhibit': { at: [0.0011, -0.045], positions: ['inhibit', 'norm'], scale: 1.5 },
    },
  },
  // the ground power panel (item 2)
  power: {
    origin: [6.0818, -0.055, -0.3786], right: [0, -0.1735, 0.9848], up: [1, 0, 0],
    outline: [[-0.0367, -0.0689], [0.0361, -0.0689], [0.0361, 0.0667], [-0.0367, 0.0379]],
    lighting: 'console',
    legends: [
      { at: [-0.0183, 0.0393], text: 'GND', size: 0.0044 }, { at: [-0.0183, 0.034], text: 'PWR', size: 0.0044 }, { at: [0.0118, 0.0565], text: '1', size: 0.0028 },
      { at: [0.0148, 0.0523], text: 'A ON', size: 0.004 }, { at: [0.0148, 0.027], text: 'B ON', size: 0.004 }, { at: [0.0294, 0.0338], text: 'AUTO', size: 0.004, stacked: true },
      { at: [-0.0216, 0.027], text: '2', size: 0.0028 }, { at: [-0.0186, 0.0225], text: 'A ON', size: 0.004 }, { at: [-0.0195, -0.0034], text: 'B ON', size: 0.004 },
      { at: [-0.0058, 0.0099], text: 'AUTO', size: 0.004, stacked: true }, { at: [0.0118, 0.018], text: '3', size: 0.0028 }, { at: [0.0148, 0.0138], text: 'A ON', size: 0.004 },
      { at: [0.0148, -0.0123], text: 'B ON', size: 0.004 }, { at: [0.0294, 0.0005], text: 'AUTO', size: 0.004, stacked: true }, { at: [-0.0222, -0.018], text: '4', size: 0.0028 },
      { at: [-0.0186, -0.0222], text: 'A ON', size: 0.004 }, { at: [-0.0195, -0.0483], text: 'B ON', size: 0.004 }, { at: [-0.0058, -0.036], text: 'AUTO', size: 0.004, stacked: true },
      { at: [0.0153, -0.0256], text: 'RESET', size: 0.004 }, { at: [0.0153, -0.0525], text: 'OFF', size: 0.004 }, { at: [0.0294, -0.0394], text: 'NORM', size: 0.004, stacked: true },
      { at: [0.0018, -0.0635], text: 'EXT PWR', size: 0.0054 },
    ],
    rings: [
      [0.0144, 0.04, 0.0086], [-0.0195, 0.0096, 0.0086], [0.0144, 0.0008, 0.0086], [-0.0195, -0.0355, 0.0086],
      [0.0144, -0.0391, 0.0086],
    ],
  },
  // the throttle quadrant's inboard strip (item 3)
  throttle: {
    origin: [5.9695, -0.0641, -0.2999], right: [0, -0.1733, 0.9849], up: [1, 0, 0],
    outline: [[-0.0243, -0.084], [-0.0099, -0.084], [-0.0099, 0.11], [-0.0243, 0.11]],
    lighting: 'console',
    legends: [
      { at: [-0.0178, 0.0995], text: 'MAX', size: 0.0042, stacked: true }, { at: [-0.0178, 0.033], text: 'MIL', size: 0.0042, stacked: true }, { at: [-0.0178, -0.0284], text: 'IDLE', size: 0.0042, stacked: true },
      { at: [-0.0178, -0.0587], text: 'OFF', size: 0.0042, stacked: true },
    ],
  },
  // and its outboard strip
  friction: {
    origin: [5.9695, -0.0641, -0.2999], right: [0, -0.1733, 0.9849], up: [1, 0, 0],
    outline: [[0.0131, -0.084], [0.0249, -0.084], [0.0249, 0.11], [0.0131, 0.11]],
    lighting: 'console',
    legends: [{ at: [0.0187, 0.0463], text: 'FRICTION', size: 0.0044, stacked: true }],
  },
  // the fire test panel (item 1)
  fire: {
    origin: [6.1401, -0.0625, -0.2996], right: [0, -0.1733, 0.9849], up: [1, -0, 0],
    outline: [[-0.0423, -0.037], [0.034, -0.037], [0.034, 0.0387], [0.0166, 0.0387], [-0.0423, 0.0129]],
    lighting: 'console',
    legends: [
      { at: [-0.0038, 0.0162], text: 'FIRE', size: 0.0038 }, { at: [-0.0048, 0.0117], text: 'TEST A', size: 0.0038 }, { at: [-0.0053, -0.0148], text: 'TEST B', size: 0.0038 },
      { at: [0.0288, -0.0026], text: 'NORM', size: 0.0044, stacked: true },
    ],
    rings: [[-0.0044, -0.0006, 0.0086]],
  },
  // the mission computer and hydraulic isolate panel (item 12)
  computer: {
    origin: [5.4361, -0.0353, -0.4583], right: [0, -0.1733, 0.9849], up: [1, -0, -0],
    outline: [[-0.0229, -0.049], [-0.0074, -0.058], [0.0221, -0.058], [0.0221, 0.0592], [-0.0184, 0.0592], [-0.0229, 0.0508]],
    lighting: 'console',
    legends: [
      { at: [-0.0169, 0.0324], text: 'HYD ISOL', size: 0.0035, turn: 90 }, { at: [-0.0086, 0.0334], text: 'ORIDE', size: 0.0035, turn: 90 }, { at: [0.0166, 0.0334], text: 'NORM', size: 0.0035, turn: 90 },
      { at: [0.0034, -0.017], text: 'NORM', size: 0.0035, turn: 90, stacked: true }, { at: [-0.0169, -0.0284], text: 'MC', size: 0.0035, turn: 90 }, { at: [-0.008, -0.0286], text: '1 OFF', size: 0.0035, turn: 90 },
      { at: [0.0166, -0.029], text: '2 OFF', size: 0.0035, turn: 90 },
    ],
    lines: [[-0.0143, 0.005, 0.0175, 0.005]],
    rings: [[0.0048, 0.0325, 0.0087, '#6b2621'], [0.0048, -0.0299, 0.0087, '#6b2621']],
    toggles: {
      'hydraulic.isolate': { at: [0.0048, 0.0325], positions: ['oride', 'norm'], turn: 90, scale: 1.5 },
      'computer': { at: [0.0048, -0.0299], positions: ['one', 'norm', 'two'], turn: 90, scale: 1.5 },
    },
  },
  // the oxygen panel (items 8, 10)
  oxygen: {
    origin: [5.4396, -0.0613, -0.3424], right: [0, -0.1735, 0.9848], up: [1, -0.0001, -0],
    outline: [[-0.08, -0.08], [0.079, -0.0716], [0.079, 0.081], [-0.08, 0.081]],
    lighting: 'console',
    legends: [
      { at: [-0.0624, 0.0405], text: 'OXYGEN', size: 0.0046, turn: 90 }, { at: [-0.0541, 0.0422], text: 'ON', size: 0.0038, turn: 90 }, { at: [-0.0398, 0.056], text: 'OFF', size: 0.0038, turn: 90 },
      { at: [0.0168, 0.0466], text: '10', size: 0.0036, turn: 90 }, { at: [0.0083, 0.0438], text: '8', size: 0.0036, turn: 90 }, { at: [0.003, 0.0366], text: '6', size: 0.0036, turn: 90 },
      { at: [0.003, 0.0276], text: '4', size: 0.0036, turn: 90 }, { at: [0.0168, 0.0176], text: '0', size: 0.0036, turn: 90 }, { at: [0.0243, 0.0321], text: 'LITERS', size: 0.0028, turn: 90 },
      { at: [0.0289, 0.0321], text: 'LIQUID OXYGEN', size: 0.0028, turn: 90 }, { at: [0.0369, 0.0296], text: 'OFF', size: 0.0028, turn: 90 },
    ],
    lines: [
      [0.0168, 0.0516, 0.0168, 0.0551], [0.0053, 0.0479, 0.0033, 0.0507], [-0.0017, 0.0381, -0.0051, 0.0392], [-0.0017, 0.0261, -0.0051, 0.025],
      [0.0053, 0.0163, 0.0033, 0.0135], [0.0168, 0.0126, 0.0168, 0.0091],
    ],
    rings: [[-0.04, 0.0427, 0.0087], [0.0168, 0.0321, 0.028, '#262827'], [0.0168, 0.0321, 0.024, '#0c0d0c']],
    needles: [[0.0168, 0.0321, 0.017, 0, 0.0024]],
  },
  // the antenna select panel (item 13)
  antenna: {
    origin: [5.5925, -0.0383, -0.4408], right: [0, -0.1733, 0.9849], up: [1, -0, -0],
    outline: [[-0.0291, -0.059], [0.0278, -0.059], [0.0278, 0.061], [-0.0291, 0.061]],
    lighting: 'console',
    legends: [
      { at: [-0.024, 0.0006], text: 'ANT SEL', size: 0.004, turn: 90 }, { at: [-0.016, 0.025], text: 'IFF', size: 0.0035, turn: 90 }, { at: [-0.0077, 0.0265], text: 'UPPER', size: 0.0032, turn: 90 },
      { at: [0.0173, 0.0265], text: 'LOWER', size: 0.0032, turn: 90 }, { at: [0.0044, 0.0403], text: 'BOTH', size: 0.0032, turn: 90, stacked: true }, { at: [-0.016, -0.0264], text: 'COMM 1', size: 0.0035, turn: 90 },
      { at: [-0.0077, -0.0261], text: 'UPPER', size: 0.0032, turn: 90 }, { at: [0.0173, -0.0255], text: 'LOWER', size: 0.0032, turn: 90 }, { at: [0.0044, -0.0121], text: 'AUTO', size: 0.0032, turn: 90, stacked: true },
    ],
    rings: [[0.0051, 0.0251, 0.0087, '#6b2621'], [0.0051, -0.0256, 0.0087, '#6b2621']],
    toggles: {
      'antenna.identification': { at: [0.0051, 0.0251], positions: ['upper', 'both', 'lower'], turn: 90, scale: 1.5 },
      'antenna.comm': { at: [0.0051, -0.0256], positions: ['upper', 'auto', 'lower'], turn: 90, scale: 1.5 },
    },
  },
  // the communication panel as before AFC 270 (item 7)
  comm: {
    origin: [5.6138, -0.0561, -0.3366], right: [0, -0.1727, 0.985], up: [1, -0, -0],
    outline: [[-0.0675, -0.0905], [0.0665, -0.0905], [0.0765, -0.0805], [0.0765, 0.0755], [0.0665, 0.0855], [-0.0675, 0.0855], [-0.0775, 0.0755], [-0.0775, -0.0805]],
    lighting: 'console',
    legends: [
      { at: [-0.0687, 0.0588], text: 'VOL', size: 0.0032, turn: 90 }, { at: [-0.0584, 0.058], text: 'TCN', size: 0.003, turn: 90 }, { at: [-0.0584, 0.083], text: 'ICS', size: 0.003, turn: 90 },
      { at: [-0.0232, 0.0605], text: 'LOW', size: 0.003, turn: 90 }, { at: [-0.0232, 0.0818], text: 'HI', size: 0.003, turn: 90 }, { at: [-0.0157, 0.0574], text: 'RWR', size: 0.003, turn: 90 },
      { at: [-0.0142, 0.0799], text: 'AUX 2', size: 0.003, turn: 90 }, { at: [0.0203, 0.0605], text: 'LOW', size: 0.003, turn: 90 }, { at: [0.0208, 0.081], text: 'HI', size: 0.003, turn: 90 },
      { at: [0.0313, 0.0566], text: 'WPN', size: 0.003, turn: 90 }, { at: [0.0323, 0.0799], text: 'AUX 1', size: 0.003, turn: 90 }, { at: [0.0623, 0.0605], text: 'LOW', size: 0.003, turn: 90 },
      { at: [0.0618, 0.0816], text: 'HI', size: 0.003, turn: 90 }, { at: [-0.0697, -0.0212], text: 'COMM', size: 0.0045, turn: 90 }, { at: [-0.0627, 0.0156], text: 'G XMT', size: 0.0032, turn: 90 },
      { at: [-0.0567, 0.0158], text: 'COMM 1', size: 0.0032, turn: 90 }, { at: [-0.0427, 0.0308], text: 'OFF', size: 0.0032, turn: 90, stacked: true }, { at: [-0.0279, 0.016], text: 'COMM 2', size: 0.0032, turn: 90 },
      { at: [-0.0627, -0.0556], text: 'RLY', size: 0.0032, turn: 90 }, { at: [-0.0567, -0.0592], text: 'CIPHER', size: 0.0032, turn: 90 }, { at: [-0.0428, -0.045], text: 'OFF', size: 0.0032, turn: 90, stacked: true },
      { at: [-0.0292, -0.0595], text: 'PLAIN', size: 0.0032, turn: 90 }, { at: [-0.0167, 0.0193], text: 'ILS', size: 0.0034, turn: 90 }, { at: [-0.0129, 0.0333], text: 'UFC', size: 0.003, turn: 90 },
      { at: [0.0118, 0.0323], text: 'MAN', size: 0.003, turn: 90 }, { at: [-0.0167, -0.017], text: 'CHANNEL', size: 0.0034, turn: 90 }, { at: [0.0268, 0.0269], text: 'MASTER', size: 0.0038, turn: 90 },
      { at: [0.0331, 0.0268], text: 'EMERG', size: 0.0038, turn: 90 }, { at: [0.0631, 0.0265], text: 'NORM', size: 0.0036, turn: 90 }, { at: [0.0268, -0.0144], text: 'MODE 4', size: 0.0038, turn: 90 },
      { at: [0.0331, -0.0149], text: 'DIS/AUD', size: 0.0038, turn: 90 }, { at: [0.0475, -0.0022], text: 'DIS', size: 0.0034, turn: 90, stacked: true }, { at: [0.0598, -0.0149], text: 'OFF', size: 0.0034, turn: 90 },
      { at: [0.0703, -0.0156], text: 'IFF', size: 0.0036, turn: 90 }, { at: [0.0268, -0.0584], text: 'CRYPTO', size: 0.0038, turn: 90 }, { at: [0.0331, -0.0582], text: 'HOLD', size: 0.0038, turn: 90 },
      { at: [0.0495, -0.0447], text: 'NORM', size: 0.0034, turn: 90, stacked: true }, { at: [0.0618, -0.0584], text: 'ZERO', size: 0.0034, turn: 90 },
    ],
    lines: [[-0.0692, 0.048, 0.0718, 0.048], [-0.022, 0.0473, -0.022, -0.09], [0.0196, 0.0473, 0.0196, -0.0897], [-0.0217, -0.0452, 0.0193, -0.0452]],
    rings: [
      [-0.0433, 0.0151, 0.0085], [-0.0424, -0.0604, 0.0085], [-0.0017, 0.0329, 0.0085], [0.0498, 0.0256, 0.0085],
      [0.048, -0.016, 0.0065, '#6b2621'], [0.0493, -0.0587, 0.0085],
    ],
    trefoils: [[-0.0079, -0.0582, 0.007]],
    windows: [{ at: [-0.0107, -0.0132, 0.0178, -0.0032], turn: 90, show: 'channel.units' }, { at: [-0.0107, -0.0347, 0.0178, -0.0247], turn: 90, show: 'channel.tens' }],
    toggles: {
      'comm.guard': { at: [-0.0433, 0.0151], positions: ['one', 'off', 'two'], turn: 90, scale: 1.5 },
      'comm.relay': { at: [-0.0424, -0.0604], positions: ['cipher', 'off', 'plain'], turn: 90, scale: 1.5 },
      'comm.landing': { at: [-0.0017, 0.0329], positions: ['ufc', 'manual'], turn: 90, scale: 1.5 },
      'identification.master': { at: [0.0498, 0.0256], positions: ['emergency', 'normal'], turn: 90, scale: 1.5 },
      'identification.alert': { at: [0.048, -0.016], positions: ['audible', 'display', 'off'], turn: 90, scale: 1.5 },
      'identification.crypto': { at: [0.0493, -0.0587], positions: ['hold', 'normal', 'zero'], turn: 90, scale: 1.5 },
    },
  },
  // the KY-58 control panel (item 6)
  secure: {
    origin: [5.7685, -0.0575, 0.3386], right: [0, 0.1733, 0.9849], up: [1, -0.0001, 0],
    outline: [[-0.079, -0.042], [0.0786, -0.042], [0.0786, 0.0256], [0.0503, 0.0256], [0.0503, 0.0443], [-0.0568, 0.0443], [-0.0568, 0.0256], [-0.079, 0.0256]],
    lighting: 'console',
    legends: [
      { at: [-0.038, 0.0394], text: 'MODE', size: 0.0042 }, { at: [-0.0388, 0.0335], text: 'C', size: 0.005 }, { at: [-0.0524, 0.0272], text: 'P', size: 0.0042 },
      { at: [-0.0235, 0.0272], text: 'LD', size: 0.0042 }, { at: [-0.0215, 0.0114], text: 'RV', size: 0.0042 }, { at: [-0.0344, -0.0074], text: 'VOLUME', size: 0.0038 },
      { at: [-0.0721, 0.0109], text: 'KY', size: 0.0046 }, { at: [-0.0721, 0.0043], text: '58', size: 0.0046 }, { at: [0.0155, 0.0162], text: '1', size: 0.005 },
      { at: [0.0188, 0.0269], text: '2', size: 0.005 }, { at: [0.0283, 0.0335], text: '3', size: 0.005 }, { at: [0.0396, 0.0335], text: '4', size: 0.005 },
      { at: [0.0466, 0.0269], text: '5', size: 0.005 }, { at: [0.051, 0.0167], text: '6', size: 0.005 }, { at: [0.0177, 0.007], text: 'Z', size: 0.005 },
      { at: [0.0484, 0.007], text: 'Z', size: 0.005 }, { at: [0.0133, -0.0035], text: '1-5', size: 0.0046 }, { at: [0.0536, -0.0035], text: 'ALL', size: 0.0046 },
      { at: [0.033, -0.0072], text: 'PULL', size: 0.0034 }, { at: [0.0177, -0.0164], text: 'TD', size: 0.0042 }, { at: [0.0159, -0.0237], text: 'ON', size: 0.0042 },
      { at: [0.0188, -0.0319], text: 'OFF', size: 0.0042 },
    ],
  },
  // the sensor panel (item 5)
  sensor: {
    origin: [5.8548, -0.0578, 0.3399], right: [0, 0.1733, 0.9849], up: [1, -0.0001, 0],
    outline: [[-0.0802, -0.0175], [-0.0703, -0.0175], [-0.0703, -0.0396], [0.0641, -0.0396], [0.0641, 0.0409], [-0.0703, 0.0409], [-0.0703, 0.0189], [-0.0802, 0.0189]],
    lighting: 'console',
    legends: [
      { at: [-0.0466, 0.0353], text: 'LST/NFLR', size: 0.0042 }, { at: [-0.0615, 0.028], text: 'ON', size: 0.0042 }, { at: [-0.0622, 0.0155], text: 'OFF', size: 0.0042 },
      { at: [-0.0035, 0.0359], text: 'FLIR', size: 0.0042 }, { at: [-0.0193, 0.0288], text: 'ON', size: 0.0042 }, { at: [-0.023, 0.0212], text: 'STBY', size: 0.0042 },
      { at: [-0.0197, 0.0139], text: 'OFF', size: 0.0042 }, { at: [-0.0427, 0.0087], text: 'RADAR', size: 0.0042 }, { at: [-0.0398, 0.0034], text: 'OPR', size: 0.0042 },
      { at: [-0.018, 0.0028], text: 'PULL', size: 0.0042 }, { at: [-0.018, -0.0038], text: 'EMERG', size: 0.0042 }, { at: [-0.0568, -0.0012], text: 'STBY', size: 0.0042 },
      { at: [-0.0587, -0.0141], text: 'OFF', size: 0.0042 }, { at: [0.033, 0.0166], text: 'NORM', size: 0.0042 }, { at: [0.0194, 0.0014], text: 'CV', size: 0.0042 },
      { at: [0.0381, 0.0057], text: 'GND', size: 0.0042 }, { at: [0.0536, 0.0028], text: 'NAV', size: 0.0042 }, { at: [0.0154, -0.0143], text: 'OFF', size: 0.0042 },
      { at: [0.0585, -0.0143], text: 'IFA', size: 0.0042 }, { at: [0.0191, -0.033], text: 'TEST', size: 0.0042 }, { at: [0.0375, -0.0347], text: 'GB', size: 0.0042 },
      { at: [0.053, -0.0327], text: 'GYRO', size: 0.0042 }, { at: [-0.0773, 0.0036], text: 'SNSR', size: 0.004, stacked: true },
    ],
    lines: [
      [-0.0484, -0.0022, -0.0453, -0.0056], [-0.0384, 0.0009, -0.0384, -0.0049], [-0.0317, -0.005, -0.0268, -0.0005], [-0.0524, -0.0141, -0.0475, -0.0141],
      [0.0259, 0.01, 0.0127, 0.01], [0.0127, 0.01, 0.0127, -0.0055], [0.0127, -0.0055, 0.0158, -0.0055], [0.0434, 0.01, 0.046, 0.01],
      [0.046, 0.01, 0.046, 0.0014], [0.0263, -0.0046, 0.0293, -0.0076], [0.0375, -0.0011, 0.0375, -0.0069], [0.0447, -0.0076, 0.048, -0.0043],
      [0.0217, -0.0143, 0.028, -0.0143], [0.0476, -0.0143, 0.0522, -0.0143],
    ],
    rings: [[-0.0464, 0.0218, 0.0092, '#6b2621'], [-0.0035, 0.0218, 0.0092, '#6b2621']],
  },
  // the interior lights panel (item 3)
  interior: {
    origin: [5.9379, -0.0578, 0.3399], right: [0, 0.1733, 0.9849], up: [1, -0.0001, 0],
    outline: [[-0.0802, -0.02], [-0.0703, -0.02], [-0.0703, -0.0417], [0.0641, -0.0417], [0.0641, 0.0448], [-0.0703, 0.0448], [-0.0703, 0.02], [-0.0802, 0.02]],
    lighting: 'console',
    legends: [
      { at: [-0.0443, 0.0382], text: 'CONSOLES', size: 0.0044 }, { at: [-0.0026, 0.0382], text: 'INST PNL', size: 0.0044 }, { at: [0.0381, 0.0382], text: 'FLOOD', size: 0.0044 },
      { at: [-0.0581, 0.0067], text: 'OFF', size: 0.0038 }, { at: [-0.0305, 0.0071], text: 'BRT', size: 0.0038 }, { at: [-0.0164, 0.0071], text: 'OFF', size: 0.0038 },
      { at: [0.0122, 0.0071], text: 'BRT', size: 0.0038 }, { at: [0.0273, 0.0071], text: 'OFF', size: 0.0038 }, { at: [0.0543, 0.0071], text: 'BRT', size: 0.0038 },
      { at: [-0.0495, -0.0029], text: 'LT TEST', size: 0.0038 }, { at: [-0.0495, -0.0071], text: 'TEST', size: 0.0038 }, { at: [-0.0495, -0.0356], text: 'OFF', size: 0.0038 },
      { at: [-0.0084, -0.0021], text: 'WARN/CAUT', size: 0.0046 }, { at: [-0.0252, -0.0334], text: 'DIM', size: 0.0038 }, { at: [-0.0108, -0.0343], text: 'RESET', size: 0.0038 },
      { at: [0.0034, -0.0334], text: 'BRT', size: 0.0038 }, { at: [0.03, -0.0018], text: 'FLOOD', size: 0.0038 }, { at: [0.03, -0.0062], text: 'COCKPIT', size: 0.0038 },
      { at: [0.0302, -0.0353], text: 'CHART', size: 0.0038 }, { at: [-0.0762, 0.0124], text: 'INTR', size: 0.004, stacked: true }, { at: [-0.0762, -0.0104], text: 'LT', size: 0.004, stacked: true },
    ],
    lines: [
      [-0.0557, 0.0113, -0.0508, 0.0159], [-0.0358, 0.0159, -0.0317, 0.0116], [-0.0145, 0.0113, -0.0102, 0.0156], [0.0059, 0.0156, 0.0099, 0.0116],
      [0.0264, 0.0113, 0.0309, 0.0156], [0.047, 0.0156, 0.051, 0.0116], [-0.0239, -0.0285, -0.0191, -0.0248], [-0.0112, -0.0242, -0.0099, -0.0294],
      [-0.0037, -0.0252, 0.0011, -0.0294],
    ],
    rings: [[-0.0486, -0.0213, 0.0092, '#6b2621'], [0.0302, -0.0213, 0.0092, '#6b2621']],
  },
  // the environmental control system panel (item 2)
  environment: {
    origin: [6.0328, -0.0574, 0.3423], right: [0, 0.1733, 0.9849], up: [1, -0.0001, 0],
    outline: [[-0.0828, -0.0287], [-0.0707, -0.0287], [-0.0707, -0.0479], [0.0607, -0.0479], [0.0607, -0.0287], [0.0821, -0.0287], [0.0821, 0.031], [0.0607, 0.031], [0.0607, 0.0496], [-0.0707, 0.0496], [-0.0707, 0.031], [-0.0828, 0.031]],
    lighting: 'console',
    legends: [
      { at: [-0.0526, 0.0428], text: 'MODE', size: 0.0046 }, { at: [-0.0526, 0.0374], text: 'AUTO', size: 0.004 }, { at: [-0.0524, 0.0079], text: 'OFF/RAM', size: 0.004 },
      { at: [-0.009, 0.0464], text: 'TEMP', size: 0.0044 }, { at: [-0.009, 0.0412], text: 'CABIN', size: 0.0044 }, { at: [-0.0241, 0.0101], text: 'COLD', size: 0.004 },
      { at: [0.0063, 0.0099], text: 'HOT', size: 0.004 }, { at: [0.0379, 0.0464], text: 'CABIN', size: 0.0044 }, { at: [0.0379, 0.0415], text: 'PRESS', size: 0.0044 },
      { at: [0.0379, 0.0363], text: 'NORM', size: 0.0044 }, { at: [0.0229, 0.0237], text: 'DUMP', size: 0.004, stacked: true }, { at: [0.0379, 0.0076], text: 'RAM/DUMP', size: 0.004 },
      { at: [-0.0327, -0.0023], text: 'ANTI ICE', size: 0.0046 }, { at: [-0.0546, -0.0056], text: 'PITOT', size: 0.0038 }, { at: [-0.0515, -0.0099], text: 'ON', size: 0.0038 },
      { at: [-0.0526, -0.0383], text: 'AUTO', size: 0.004 }, { at: [-0.0107, -0.0056], text: 'ENG', size: 0.0038 }, { at: [-0.0095, -0.0099], text: 'ON', size: 0.0038 },
      { at: [-0.0284, -0.0236], text: 'OFF', size: 0.0036, stacked: true }, { at: [-0.0162, -0.0383], text: 'TEST', size: 0.004 }, { at: [0.0271, 0.0006], text: 'BLEED AIR', size: 0.0044 },
      { at: [0.0271, -0.0042], text: 'NORM', size: 0.0044 }, { at: [0.0079, -0.022], text: 'L', size: 0.004 }, { at: [0.0046, -0.0263], text: 'OFF', size: 0.004 },
      { at: [0.0528, -0.0216], text: 'R', size: 0.004 }, { at: [0.0496, -0.0263], text: 'OFF', size: 0.004 }, { at: [0.0271, -0.0437], text: 'OFF', size: 0.004 },
      { at: [0.0539, -0.0059], text: 'AUG', size: 0.0044 }, { at: [0.0537, -0.0104], text: 'PULL', size: 0.0044 }, { at: [-0.0769, 0.0036], text: 'ECS', size: 0.004, stacked: true },
    ],
    lines: [
      [-0.0211, 0.0141, -0.0163, 0.0178], [0, 0.0169, 0.0048, 0.0135], [-0.0617, -0.0023, -0.0481, -0.0023], [-0.0617, -0.0023, -0.0617, -0.0073],
      [-0.0194, -0.0023, -0.005, -0.0023], [-0.005, -0.0023, -0.005, -0.0085], [0.0276, -0.0079, 0.0276, -0.0406], [0.0108, -0.0246, 0.0432, -0.0246],
    ],
    rings: [[-0.0521, 0.0228, 0.0096], [0.0379, 0.0223, 0.0096], [-0.0517, -0.0237, 0.0096, '#6b2621'], [-0.0162, -0.0237, 0.0096, '#6b2621']],
  },
  // the electrical power panel, round the battery voltmeter (item 1)
  electrical: {
    origin: [6.1182, -0.0574, 0.3422], right: [0, 0.1734, 0.9848], up: [1, -0.0001, 0],
    outline: [[-0.0828, -0.0342], [0.0821, -0.0342], [0.0821, -0.0037], [-0.0054, 0.0352], [-0.014, 0.0352], [-0.014, 0.0095], [-0.068, 0.0095], [-0.068, 0.0352], [-0.0828, 0.0352]],
    lighting: 'console',
    legends: [
      { at: [-0.0519, 0.0042], text: 'L GEN', size: 0.0044 }, { at: [-0.0519, -0.0012], text: 'NORM', size: 0.0044 }, { at: [-0.0519, -0.0274], text: 'OFF', size: 0.004 },
      { at: [-0.0059, 0.0062], text: 'BATT', size: 0.0046 }, { at: [-0.0059, -0.0001], text: 'ON', size: 0.0046 }, { at: [-0.023, -0.0142], text: 'OFF', size: 0.004 },
      { at: [-0.0062, -0.0274], text: 'ORIDE', size: 0.004 }, { at: [0.0437, 0.0059], text: 'R GEN', size: 0.0044 }, { at: [0.0437, 0.0002], text: 'NORM', size: 0.0044 },
      { at: [0.0437, -0.0274], text: 'OFF', size: 0.004 }, { at: [-0.078, 0.0146], text: 'ELEC', size: 0.004, stacked: true },
    ],
    rings: [[-0.0513, -0.0142, 0.0096, '#6b2621'], [-0.0059, -0.0142, 0.0096], [0.044, -0.0139, 0.0096, '#6b2621']],
  },
  // the battery and audio strip under the KY-58
  cells: {
    origin: [5.7141, -0.0589, 0.3315], right: [0, 0.1736, 0.9848], up: [1, -0.0001, 0],
    outline: [[-0.0721, -0.0087], [0.0713, -0.0087], [0.0713, 0.0105], [-0.0721, 0.0105]],
    lighting: 'console',
    legends: [
      { at: [-0.0532, 0.0046], text: '1', size: 0.004 }, { at: [-0.013, 0.0046], text: '2', size: 0.004 }, { at: [0.0271, 0.0046], text: '3', size: 0.004 },
      { at: [-0.0334, -0.0059], text: 'BATT', size: 0.0044 }, { at: [0.0451, -0.0059], text: 'AUDIO', size: 0.0044 },
    ],
    slots: [
      [-0.0492, 0.0009, -0.02, 0.0077], [-0.0087, 0.0009, 0.0207, 0.0077], [0.031, 0.0009, 0.0605, 0.0077],
      [-0.0087, -0.0087, 0.0207, -0.003],
    ],
  },
  // and the row behind it
  sockets: {
    origin: [5.6946, -0.0572, 0.3408], right: [0, 0.1737, 0.9848], up: [1, 0.0001, -0],
    outline: [[-0.068, -0.0088], [0.0812, -0.0088], [0.0812, 0.0106], [-0.068, 0.0106]],
    lighting: 'console',
    legends: [
      { at: [-0.0451, 0.0076], text: 'INSTL', size: 0.004 }, { at: [0.0285, 0.0073], text: 'IN', size: 0.004 }, { at: [-0.0572, 0.001], text: '4', size: 0.004 },
      { at: [-0.0194, 0.0002], text: '5', size: 0.004 }, { at: [0.0172, 0.0006], text: '6', size: 0.004 },
    ],
    slots: [[-0.0541, -0.0026, -0.0254, 0.0042], [-0.0158, -0.0026, 0.0127, 0.0042], [0.0203, -0.0026, 0.049, 0.0042]],
  },
  // the defog panel (item 11)
  defog: {
    origin: [5.9493, -0.039, 0.4484], right: [0, 0.1735, 0.9848], up: [1, -0.0001, 0],
    outline: [[-0.0207, -0.081], [0.0206, -0.081], [0.0206, 0.0824], [-0.0207, 0.0824]],
    lighting: 'console',
    legends: [
      { at: [-0.002, 0.0695], text: 'DEFOG', size: 0.0044 }, { at: [-0.0114, 0.0549], text: 'HIGH', size: 0.004 }, { at: [-0.012, -0.039], text: 'LOW', size: 0.004 },
      { at: [-0.0029, -0.0478], text: 'WINDSHIELD', size: 0.004 }, { at: [-0.0072, -0.0535], text: 'ANTI ICE', size: 0.004 }, { at: [-0.016, -0.0676], text: 'OFF', size: 0.0038, stacked: true },
      { at: [-0.0066, -0.0761], text: 'RAIN', size: 0.004 },
    ],
    lines: [[-0.0157, -0.0435, 0.0156, -0.0435]],
    rings: [[-0.0047, -0.0649, 0.0084, '#6b2621']],
    boxes: [[-0.0207, -0.0328, -0.0068, 0.0471, '#0c0d0c']],
  },
  // the armament monitor control panel (item 4)
  monitor: {
    origin: [5.6129, -0.0572, 0.3408], right: [0, 0.1731, 0.9849], up: [1, 0.0001, -0],
    outline: [[-0.0786, -0.0535], [-0.0693, -0.0535], [-0.0693, -0.061], [0.0596, -0.061], [0.0596, -0.045], [0.0683, -0.045], [0.0683, 0.054], [0.0596, 0.054], [0.0596, 0.0717], [-0.0693, 0.0717], [-0.0693, 0.055], [-0.0786, 0.055]],
    lighting: 'console',
    legends: [
      { at: [-0.0422, -0.002], text: 'BIT LO', size: 0.004, turn: -90 }, { at: [-0.0128, -0.002], text: 'BIT RO', size: 0.004, turn: -90 }, { at: [-0.023, -0.0176], text: 'AUX', size: 0.004, turn: -90 },
      { at: [-0.0283, -0.0182], text: 'SAFE', size: 0.004, turn: -90 }, { at: [-0.0019, 0.0401], text: 'FCTN SEL', size: 0.0044, turn: -90 }, { at: [-0.0351, 0.058], text: '1', size: 0.0034, turn: -90 },
      { at: [-0.0273, 0.0652], text: '2', size: 0.0034, turn: -90 }, { at: [-0.018, 0.0658], text: '3', size: 0.0034, turn: -90 }, { at: [-0.0089, 0.0594], text: '4', size: 0.0034, turn: -90 },
      { at: [0.0473, 0.038], text: 'LO/RO', size: 0.004, turn: -90 }, { at: [0.0427, 0.0385], text: 'SEL', size: 0.004, turn: -90 }, { at: [0.0622, -0.031], text: 'LAMP', size: 0.0036, turn: -90 },
      { at: [0.0585, -0.0306], text: 'TEST', size: 0.0036, turn: -90 }, { at: [0.0029, -0.0556], text: 'CMD SEL', size: 0.0044, turn: 180 },
    ],
    rings: [
      [-0.054, 0.0578, 0.008, '#6b2621'], [-0.054, 0.0396, 0.008, '#6b2621'], [-0.054, 0.0225, 0.008, '#6b2621'], [-0.054, -0.0251, 0.008, '#6b2621'],
      [-0.054, -0.0444, 0.008, '#6b2621'], [0.0266, 0.0342, 0.008, '#6b2621'], [0.0419, -0.0251, 0.008, '#6b2621'], [0.0419, -0.0444, 0.008, '#6b2621'],
      [0.0216, -0.0011, 0.008, '#9b9d99'],
    ],
    trefoils: [[-0.0554, -0.0019, 0.0078], [-0.0244, -0.0019, 0.0078]],
  },
  // the GEN TIE CONTROL switch (2.5.1.3, FO-5 sheet 2 item 15), on the left wall outboard of the
  // exterior lights panel where FO-5 draws it: the model has none, so its panel is built here too
  tie: {
    origin: [5.9, -0.02, -0.4394], right: [1, 0, 0], up: [0, 0.933, 0.36],
    outline: [[-0.015, -0.016], [0.015, -0.016], [0.015, 0.016], [-0.015, 0.016]],
    lighting: 'console',
    legends: [{ at: [0, 0.0128], text: 'GEN TIE CONTROL', size: 0.0024 }, { at: [0, 0.0078], text: 'RESET', size: 0.0026 }, { at: [0, -0.0115], text: 'NORM', size: 0.0026 }],
    rings: [[0, -0.0015, 0.005]],
    toggles: { 'generator.tie': { at: [0, -0.0015], positions: ['reset', 'norm'] } },
  },
}

// normal: a plate's normal toward the pilot, right x up.
export function normal(p: Plate): [number, number, number] {
  const [a, b, c] = p.right, [d, e, f] = p.up
  return [b * f - c * e, c * d - a * f, a * e - b * d]
}
// point: the jet-frame point at a place on a plate, w metres proud of it.
export function point(p: Plate, at: Point, w = 0): [number, number, number] {
  const n = normal(p)
  return [0, 1, 2].map((i) => p.origin[i] + at[0] * p.right[i] + at[1] * p.up[i] + w * n[i]) as [number, number, number]
}
// bounds: the box round a plate's outline, [a0, b0, a1, b1].
export function bounds(p: Plate): [number, number, number, number] {
  const a = p.outline.map((q) => q[0]), b = p.outline.map((q) => q[1])
  return [Math.min(...a), Math.min(...b), Math.max(...a), Math.max(...b)]
}
// pixels: a plate's canvas at scale 1, [width, height].
export function pixels(p: Plate): [number, number] {
  const [a0, b0, a1, b1] = bounds(p)
  return [Math.round((a1 - a0) * PIXELS), Math.round((b1 - b0) * PIXELS)]
}

type Context = CanvasRenderingContext2D
// stripes: hazard stripes over a rectangle of the canvas, in its pixels at pixels a
// metre: the bands' wave runs at the stripe's angle from the canvas's x, which is the
// face's right.
export function stripes(c: Context, x0: number, y0: number, x1: number, y1: number, pixels = PIXELS, stripe = STRIPES.panel): void {
  c.save()
  c.beginPath(); c.rect(x0, y0, x1 - x0, y1 - y0); c.clip()
  c.fillStyle = COLOURS.yellow; c.fillRect(x0, y0, x1 - x0, y1 - y0)
  const period = stripe.period * pixels, width = period * stripe.duty, turn = stripe.angle * Math.PI / 180
  const reach = Math.hypot(x1 - x0, y1 - y0)
  c.translate((x0 + x1) / 2, (y0 + y1) / 2); c.rotate(-turn)   // canvas y runs down, so a turn anticlockwise on the plate is negative here
  c.fillStyle = COLOURS.black
  for (let s = -reach; s < reach; s += period) c.fillRect(s, -reach, width, 2 * reach)
  c.restore()
}
// draw: a plate's picture on its canvas, the context scaled to the canvas's own
// pixels at scale 1 - the plate's colour, its stripes, housings, slots, rules,
// rings, marks and legends, and its windows showing the values named for them.
export function draw(p: Plate, c: Context, values: Readonly<Record<string, string>> = {}): void {
  const [a0, , , b1] = bounds(p), [w, h] = pixels(p)
  const x = (a: number) => (a - a0) * PIXELS, y = (b: number) => (b1 - b) * PIXELS, px = (m: number) => m * PIXELS
  c.clearRect(0, 0, w, h)
  c.fillStyle = p.lighting === 'console' ? COLOURS.console : COLOURS.plate; c.fillRect(0, 0, w, h)
  for (const [s0, t0, s1, t1] of p.stripes || []) stripes(c, x(s0), y(t1), x(s1), y(t0))
  c.lineWidth = px(0.0004)
  for (const [s0, t0, s1, t1, fill] of p.boxes || []) {
    if (fill) { c.fillStyle = fill; c.fillRect(x(s0), y(t1), x(s1) - x(s0), y(t0) - y(t1)) }
    c.strokeStyle = COLOURS.ring; c.strokeRect(x(s0), y(t1), x(s1) - x(s0), y(t0) - y(t1))
  }
  for (const [s0, t0, s1, t1] of p.slots || []) {
    const r = Math.min(x(s1) - x(s0), y(t0) - y(t1)) / 2
    c.fillStyle = COLOURS.slot; c.beginPath(); c.roundRect(x(s0), y(t1), x(s1) - x(s0), y(t0) - y(t1), r); c.fill()
  }
  for (const win of p.windows || []) {
    const [s0, t0, s1, t1] = win.at
    c.fillStyle = COLOURS.box; c.fillRect(x(s0), y(t1), x(s1) - x(s0), y(t0) - y(t1))
    c.strokeStyle = COLOURS.ring; c.strokeRect(x(s0), y(t1), x(s1) - x(s0), y(t0) - y(t1))
    const shown = values[win.show]
    if (shown) {
      const size = Math.min(Math.abs(x(s1) - x(s0)), Math.abs(y(t0) - y(t1))) * 0.7
      c.save(); c.translate((x(s0) + x(s1)) / 2, (y(t0) + y(t1)) / 2); c.rotate(-win.turn * Math.PI / 180)
      c.fillStyle = COLOURS.ink; c.font = 'bold ' + size + 'px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(shown, 0, 0); c.restore()
    }
  }
  c.strokeStyle = COLOURS.ink; c.lineWidth = px(0.0003); c.lineCap = 'round'
  for (const [s0, t0, s1, t1] of p.lines || []) { c.beginPath(); c.moveTo(x(s0), y(t0)); c.lineTo(x(s1), y(t1)); c.stroke() }
  for (const [a, b, r, fill] of p.rings || []) {
    c.beginPath(); c.arc(x(a), y(b), px(r), 0, 2 * Math.PI)
    if (fill) { c.fillStyle = fill; c.fill() }
    c.strokeStyle = COLOURS.ring; c.lineWidth = px(0.0006); c.stroke()
  }
  for (const [a, b, r] of p.trefoils || []) {
    c.fillStyle = COLOURS.yellow; c.beginPath(); c.arc(x(a), y(b), px(r), 0, 2 * Math.PI); c.fill()
    c.fillStyle = COLOURS.black
    for (let k = 0; k < 3; k++) { const t = (k * 120 - 90) * Math.PI / 180; c.beginPath(); c.moveTo(x(a), y(b)); c.arc(x(a), y(b), px(r * 0.85), t - Math.PI / 6, t + Math.PI / 6); c.closePath(); c.fill() }
    c.beginPath(); c.arc(x(a), y(b), px(r * 0.15), 0, 2 * Math.PI); c.fill()
    c.strokeStyle = COLOURS.ring; c.lineWidth = px(0.0006); c.beginPath(); c.arc(x(a), y(b), px(r), 0, 2 * Math.PI); c.stroke()
  }
  for (const [a, b, length, angle, width] of p.needles || []) {
    const t = angle * Math.PI / 180
    c.strokeStyle = COLOURS.ink; c.lineWidth = px(width); c.beginPath(); c.moveTo(x(a), y(b)); c.lineTo(x(a + length * Math.sin(t)), y(b + length * Math.cos(t))); c.stroke()
  }
  c.lineCap = 'butt'
  c.textAlign = 'center'; c.textBaseline = 'middle'
  for (const l of p.legends) {
    const size = (l.size / 0.72) * PIXELS   // a capital is about 0.72 of the font's size
    c.font = 'bold ' + size + 'px sans-serif'
    c.save(); c.translate(x(l.at[0]), y(l.at[1])); c.rotate(-(l.turn || 0) * Math.PI / 180)
    const letters = l.stacked ? [...l.text] : [l.text], pitch = l.size * 1.45 * PIXELS
    if (l.boxed) {
      const width = Math.max(...letters.map((t) => c.measureText(t).width)) + 0.0016 * PIXELS, height = pitch * letters.length + 0.0008 * PIXELS
      c.fillStyle = COLOURS.box; c.fillRect(-width / 2, -height / 2, width, height)
    }
    c.fillStyle = COLOURS.ink
    letters.forEach((t, k) => c.fillText(t, 0, (k - (letters.length - 1) / 2) * pitch))
    c.restore()
  }
}

// ---- the SELECT JETT knob and the canopy jettison handle ----

// The SELECT JETT knob (FO-5 item 32, NATOPS 2.17.1.2.2, #145): the model's is a
// fixed part, cut away and built here - a grey skirt round a recessed red JETT
// button, its index pointing at the position selected - each position's angle
// clockwise from up on its panel, as FO-5 draws them. Its frame is the model's
// knob's: its centre on the panel face, and the panel's right and up there.
export const SELECT = {
  centre: [6.2018, 0.0128, -0.287] as Vector, right: [0.125, -0.594, 0.794] as Vector, up: [0.391, 0.765, 0.511] as Vector,
  skirt: { radius: 0.0168, height: 0.02, bore: 0.0125 }, button: { radius: 0.0115, low: 0.01, top: 0.0155, push: 0.003 },
  angles: { left: -50, safe: 0, right: 50, rack: 88, stores: 130 } as Record<string, number>,
}
// The canopy jettison handle (FO-5 item 11, NATOPS 2.15.1.2.1, #144): a black and
// yellow striped bar on the left sill, pulled aft to fire the canopy away. The
// model's is part of a merged mesh that cannot move; cut away, it is built here as
// the model draws it - a bar along axis from its foot at origin, its section a
// polygon [inboard, aft] with the aft inboard corner chamfered, and the tip that
// leans forward over it - pivoting at its foot to lean pull degrees aft. The face
// toward the pilot carries the CANOPY JETT placard, its letters stacked up it.
export const HANDLE = {
  origin: [6.0873, 0.2493, -0.3279] as Vector, axis: [0.3035, 0.947, -0.1052] as Vector, aft: [-0.9528, 0.3016, -0.0335] as Vector,
  along: [-0.0855, 0.0855] as [number, number], tip: { along: 0.106, forward: -0.0214 },
  section: [[-0.0089, -0.0131], [0.0069, -0.0131], [0.0069, 0.0061], [0.004, 0.0099], [-0.0089, 0.0099]] as Point[],
  placard: { face: 3, along: [-0.064, 0.078] as [number, number], letters: 'CANOPY JETT', colour: '#c9994c', ink: '#1c1b18' },
  pull: 20,
}
export const HANDLE_PIXELS = 6000 // the handle's canvas pixels a metre
// handle_perimeter: each section edge's start round the handle's perimeter, m, and the whole.
export function handle_perimeter(): { starts: number[]; total: number } {
  const s = HANDLE.section, starts: number[] = []
  let total = 0
  for (let k = 0; k < s.length; k++) { starts.push(total); const [a, b] = s[k], [c, d] = s[(k + 1) % s.length]; total += Math.hypot(c - a, d - b) }
  return { starts, total }
}
// handle_draw: the handle's picture, x along it from its foot and y round its
// section from its first corner, both at HANDLE_PIXELS a metre: stripes over all of
// it, and the placard on the face toward the pilot with its letters stacked, each
// upright as the pilot reads it - its up along the handle, its right toward the
// cockpit's centre, which round the section runs back toward the face's start.
export function handle_draw(c: Context, scale = 1): void {
  const P = HANDLE_PIXELS, length = HANDLE.tip.along - HANDLE.along[0], { starts, total } = handle_perimeter()
  const w = length * P, h = total * P
  c.save(); c.scale(scale, scale)
  stripes(c, 0, 0, w, h, P, STRIPES.handle)
  const k = HANDLE.placard.face, [a, b] = HANDLE.section[k], [d, e] = HANDLE.section[(k + 1) % HANDLE.section.length]
  const y0 = starts[k] * P, y1 = (starts[k] + Math.hypot(d - a, e - b)) * P
  const x = (along: number) => (along - HANDLE.along[0]) * P, [l0, l1] = HANDLE.placard.along
  c.fillStyle = HANDLE.placard.colour; c.fillRect(x(l0), y0, x(l1) - x(l0), y1 - y0)
  const letters = [...HANDLE.placard.letters], pitch = (l1 - l0) / letters.length, size = (y1 - y0) * 0.62
  c.fillStyle = HANDLE.placard.ink; c.font = 'bold ' + size + 'px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'
  letters.forEach((t, n) => {
    c.save(); c.translate(x(l1 - (n + 0.5) * pitch), (y0 + y1) / 2); c.transform(0, -1, -1, 0, 0, 0); c.fillText(t, 0, 0); c.restore()
  })
  c.restore()
}
