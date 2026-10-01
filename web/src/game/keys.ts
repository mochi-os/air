// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// Keyboard input mapping for the setup UI, co-located with the game layer: the
// codes mirror the engine's KEYS table (engine.ts key_of), and neither the
// KeyboardEvent.code identifiers nor the physical key display names are
// translatable UI prose — so this lives under the game/ lint scope.

// KEY_DEFAULTS maps each action to its default KeyboardEvent.code for display.
export const KEY_DEFAULTS: Record<string, string> = {
  'pitch.up': 'KeyS',
  'pitch.down': 'KeyW',
  'roll.right': 'KeyD',
  'roll.left': 'KeyA',
  'yaw.right': 'KeyE',
  'yaw.left': 'KeyQ',
  'throttle.up': 'BracketRight',
  'throttle.down': 'BracketLeft',
  fire: 'Space', // renamed from 'guns': the trigger serves the SELECTED weapon, not only the cannon.
  select: 'Tab', // the biggest left-edge key, and clear of X's Shift-chord neighbour (Shift+X secures an engine)
  uncage: 'Delete', // one switch on the real jet: CIA <-> VISUAL for the AIM-120 (#27), the velocity vector cage in NAV; the 9M's SEAM slaving joins it later
  acquire: 'Enter',
  launch: 'Enter',
  'brake.wheel': 'KeyB',
  'brake.parking': 'Shift+KeyB',
  'trim.up': 'Period',
  'trim.down': 'Comma',
  'trim.left': 'Shift+Comma',
  'trim.right': 'Shift+Period',
  'trim.reset': 'None',
  'flaps.extend': 'KeyF',
  'flaps.retract': 'Shift+KeyF',
  override: 'KeyO',
  'brake.speed': 'Slash',
  gear: 'KeyG',
  'gear.emergency': 'None', // the gear handle turned and pulled (NATOPS 2.10.1.6): unbound, as a middle click on the handle does it
  hook: 'KeyH',
  'index.down': 'KeyN', // the radar altimeter's low-altitude index knob, anticlockwise (NATOPS 2.12.5.4.1): for the views without the panel
  'index.up': 'Shift+KeyN',
  'baro.down': 'None', // the standby altimeter's barometric set knob (NATOPS 2.12.4): unbound, as a click on the altimeter turns it
  'baro.up': 'None',
  'hook.bypass': 'Shift+KeyH', // the hook bypass switch, CARRIER <-> FIELD: FIELD stops the AOA indexer flashing with the hook up (NATOPS 2.12.10) and drops back to CARRIER when the hook comes down
  atc: 'KeyP',
  lights: 'KeyL',
  'lights.test': 'Shift+KeyL', // the LT TEST switch, held (NATOPS 2.6.2.11)
  flares: 'KeyC', // the dispense switch aft (#31): the manual programme, a flare and a chaff bloom
  chaff: 'KeyZ', // ...and forward: chaff singles
  eject: 'Shift+KeyE',
  map: 'KeyM',
  chat: 'Backquote',
  shout: 'Shift+Backquote',
  menu: 'Escape',
  view: 'None',
  probe: 'KeyR',
  canopy: 'Shift+KeyC',
  'canopy.jettison': 'None', // the canopy jettison handle (#113): unbound, as a middle click on it pulls it
  fold: 'Shift+KeyW',
  altitude: 'KeyK',
  reject: 'None',
  repeater: 'KeyI',
  'view.reset': 'Digit0',
  'look.target': 'KeyY',
  'zoom.in': 'Equal',
  'zoom.out': 'Minus',
  'jettison.tanks': 'KeyJ',
  'jettison.emergency': 'Shift+KeyJ',
  'caution.reset': 'Shift+KeyM',
  'tone.silence': 'Shift+KeyG', // the warning tone silence button next to the gear handle
  dump: 'Shift+KeyD',
  'secure.port': 'Shift+KeyZ',
  'secure.starboard': 'Shift+KeyX',
  'radar.silent': 'Shift+KeyR',
  'sensor.forward': 'KeyV', // the stick's sensor control switch (#27): forward is ACM, its one keyboard default; aft, left and right assign the TDC, unbound like the TDC itself, whose slew the mouse is on the attack format
  'sensor.aft': 'None',
  'sensor.left': 'None',
  'sensor.right': 'None',
  'tdc.up': 'None', // the throttle designator controller (#32): for a stick or throttle with a hat to spare
  'tdc.down': 'None',
  'tdc.left': 'None',
  'tdc.right': 'None',
  'tdc.designate': 'None',
  'antenna.down': 'KeyT', // the throttle's antenna elevation wheel, a step each press
  'antenna.up': 'Shift+KeyT',
  jammer: 'KeyX', // XMIT on the key marked X (#31): arm the jammer; it radiates only while a threat paints us
  'radar.undesignate': 'Backspace', // the erase key un-designates; in TWS it steps the L&S to the next trackfile
}

// pretty renders a KeyboardEvent.code as its physical key label (a glyph or the
// key's own printed name); '—' for an unbound action.
export function pretty(code: string): string {
  if (!code || code === 'None') return '—'
  // Chords are stored as "Shift+<code>" — prettify the code half and keep the
  // modifier, or the settings screen shows raw KeyboardEvent codes back to the
  // player ("Shift+KeyB" where the key cap says B).
  if (code.includes('+')) {
    const parts = code.split('+')
    return parts
      .slice(0, -1)
      .concat(pretty(parts[parts.length - 1]))
      .join('+')
  }
  const table: Record<string, string> = {
    Space: 'Space',
    Enter: 'Enter',
    Escape: 'Esc', // the cap is printed Esc, and the help line said Esc before it was derived
    Slash: '/',
    Backslash: '\\',
    BracketLeft: '[',
    BracketRight: ']',
    Comma: ',',
    Period: '.',
    Semicolon: ';',
    Quote: "'",
    Backquote: '`',
    Minus: '−',
    Equal: '=',
    Tab: 'Tab',
    Backspace: 'Backspace',
    Delete: 'Del',
    ShiftLeft: 'Shift',
    ShiftRight: 'Shift',
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
  }
  if (table[code]) return table[code]
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  if (code.startsWith('Numpad')) return 'Num ' + code.slice(6)
  return code
}
