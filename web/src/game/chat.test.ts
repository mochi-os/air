// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { advance, opening, wire } from './chat'

// The prompt's three scopes and the keys that move between them: ` opens
// Team in a teams match and Match otherwise, ` again cycles the two in a
// teams match, Shift+` goes to everyone on the server from anywhere. Team and
// Match ride the match wire; the server line goes to the lobby ring.
describe('the chat prompt scopes', () => {
  it('opens on the team in a teams match and on the match otherwise', () => {
    expect(opening(true)).toBe('team')
    expect(opening(false)).toBe('match')
  })

  it('cycles Team and Match with the chat key in a teams match', () => {
    expect(advance('team', true, false)).toBe('match')
    expect(advance('match', true, false)).toBe('team')
    expect(advance('server', true, false)).toBe('team') // back from the server to the default
  })

  it('has only Match for the chat key outside a teams match', () => {
    expect(advance('match', false, false)).toBe('match')
    expect(advance('server', false, false)).toBe('match')
    expect(advance('team', false, false)).toBe('match')
  })

  it('goes to everyone on the server with the shift chord from anywhere', () => {
    for (const scope of ['team', 'match', 'server'] as const) {
      expect(advance(scope, true, true)).toBe('server')
      expect(advance(scope, false, true)).toBe('server')
    }
  })

  it('carries Team and Match on the match wire and sends the server line to the lobby', () => {
    expect(wire('team')).toBe('team')
    expect(wire('match')).toBe('all')
    expect(wire('server')).toBeNull()
  })
})

describe('the wiring', () => {
  const engine = readFileSync(
    fileURLToPath(new URL('./engine.ts', import.meta.url)),
    'utf8'
  )
  const canvas = readFileSync(
    fileURLToPath(new URL('../components/GameCanvas.tsx', import.meta.url)),
    'utf8'
  )

  it('opens Match or Team on the chat key and Everyone on the server on its shift chord', () => {
    expect(engine).toMatch(
      /function chat_scope\(\)\{ return \(net&&net\.welcome&&net\.welcome\.spawn&&net\.welcome\.spawn\.mode==="teams"\)\?"team":"match"; \}/
    )
    expect(engine).toMatch(
      /if\(ch===key_of\("shout"\) && MULTIPLAYER && running && onChat\)\{ e\.preventDefault\(\); onChat\("server"\); \}/
    )
  })

  it('sends a server line to the lobby ring as the pilot, and the match scopes over the wire', () => {
    expect(engine).toMatch(
      /say: \(words\) => \{ if \(MULTIPLAYER && join\) world_say\(join\.server, join\.name, String\(words\)\.slice\(0, 200\)\)\.catch\(\(\) => \{\}\) \},/
    )
    expect(canvas).toMatch(
      /const carried = wire\(chat\)\n\s+if \(carried\) handleRef\.current\?\.chat\(words, carried\)\n\s+else handleRef\.current\?\.say\(words\)/
    )
  })

  it('polls the lobby ring in flight from the match start to its end, printing player lines under EVERYONE', () => {
    expect(engine).toMatch(
      /net=n; match_started=Date\.now\(\); lounge_start\(\);/
    )
    expect(engine).toMatch(
      /function net_finish\(reason\)\{ if\(session_over\) return; session_over=true; lounge_stop\(\);/
    )
    expect(engine).toMatch(
      /comm\("\["\+translate\("EVERYONE"\)\+"\] "\+l\.name\+": "\+l\.text,"#ffe08f"\)/
    )
    expect(engine).toMatch(/lounge=setInterval\(pull,3000\)/)
    expect(canvas).toMatch(/EVERYONE: msg`EVERYONE`,/)
  })

  it('cycles the scope with the chat keys inside the open prompt, and is one bordered element: label, field, X', () => {
    expect(canvas).toMatch(
      /setChat\(\s*advance\(\s*chat,\s*handleRef\.current\.scope\(\) === 'team',\s*chord === handleRef\.current\.key\('shout'\)\s*\)\s*\)/
    )
    expect(canvas).toMatch(
      /<div className='fixed top-56 left-10 z-30 flex items-center rounded border border-white\/30 bg-black\/70 font-mono'>/
    )
    expect(canvas).toMatch(
      /\{chat === 'team' \? \(\s*<Trans>Team<\/Trans>\s*\) : chat === 'match' \? \(\s*<Trans>Match<\/Trans>\s*\) : \(\s*<Trans>Everyone<\/Trans>\s*\)\}/
    )
  })
})
