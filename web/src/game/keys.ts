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
  guns: 'Space',
  select: 'KeyX',
  acquire: 'Enter',
  launch: 'Enter',
  'brake.wheel': 'KeyB',
  'brake.speed': 'Slash',
  gear: 'KeyG',
  hook: 'KeyH',
  lights: 'KeyL',
  flares: 'KeyF',
  eject: 'KeyJ',
  map: 'KeyM',
  chat: 'KeyT',
  shout: 'Shift+KeyT',
  menu: 'Escape',
  view: 'KeyV',
  probe: 'Shift+KeyF',
  canopy: 'Shift+KeyC',
  fold: 'Shift+KeyW',
  altitude: 'KeyK',
  reject: 'KeyU',
}

// pretty renders a KeyboardEvent.code as its physical key label (a glyph or the
// key's own printed name); '—' for an unbound action.
export function pretty(code: string): string {
  if (!code || code === 'None') return '—'
  const table: Record<string, string> = {
    Space: 'Space',
    Enter: 'Enter',
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
