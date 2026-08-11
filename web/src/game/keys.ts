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
  select: 'KeyX',
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
  hook: 'KeyH',
  atc: 'KeyP',
  lights: 'KeyL',
  flares: 'KeyC',
  eject: 'Shift+KeyE',
  map: 'KeyM',
  chat: 'KeyT',
  shout: 'Shift+KeyT',
  menu: 'Escape',
  view: 'None',
  probe: 'KeyR',
  canopy: 'Shift+KeyC',
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
  dump: 'Shift+KeyD',
  'secure.port': 'Shift+KeyZ',
  'secure.starboard': 'Shift+KeyX',
  'radar.silent': 'Shift+KeyR',
  'radar.acm': 'KeyV',
  'radar.undesignate': 'Shift+Enter',
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
    return parts.slice(0, -1).concat(pretty(parts[parts.length - 1])).join('+')
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
    Minus: '−',
    Equal: '=',
    Tab: 'Tab',
    Backspace: 'Backspace',
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
