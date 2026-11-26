// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The lobby row's Cancel button (#34). A match is an offer only until anyone
// connects, and its creator flies it the moment it is made, so a Cancel tied
// to the offer flag vanished a second after the match appeared. The button
// stays for the creator's own match while it stands empty, which is what the
// server's withdraw now honours too.
const source = readFileSync(fileURLToPath(new URL('./Multiplayer.tsx', import.meta.url)), 'utf8')

describe('the lobby row', () => {
  it('offers Cancel on your own match while it is an offer or stands empty', () => {
    expect(source).toMatch(/\{pilot\s*&&\s*s\.mine\s*&&\s*\(s\.offer \|\| \(s\.players \?\? \[\]\)\.length === 0\)\s*&&\s*\(/)
    expect(source).toMatch(/await world_withdraw\(address, pilot\)/)
  })
})

// A failed create (#97): its own message beside its own button, where the
// player who pressed it is looking, and kept after the loadout dialog that
// made the create has closed.
describe('creating a match', () => {
  it('shows a failure beside Create and fly, until the next attempt', () => {
    expect(source).toMatch(/const create = async \(\) => \{\s*setFault\(null\)/)
    expect(source).toMatch(/\} catch \(e\) \{\s*setFault\(e\)\s*\}/)
    const start = source.indexOf('{fault !== null && (')
    expect(start).toBeGreaterThan(0)
    const row = source.slice(start, source.indexOf('<Trans>Create and fly</Trans>', start))
    expect(row).toMatch(/<LobbyFailure\s+error=\{fault\}\s+fallback=\{<Trans>Could not create the match<\/Trans>\}/)
  })
})

// A lobby failure in the player's language (#99): by its kind, and a reason a
// server named only through the reasons the page knows.
describe('a lobby failure', () => {
  it('is worded by its kind, never as the browser or the server put it', () => {
    expect(source).not.toMatch(/getErrorMessage/)
    expect(source).toMatch(/Object\.prototype\.hasOwnProperty\.call\(REFUSALS, error\.reason\)\s*\)\s*return <>\{REFUSALS\[error\.reason\]\}<\/>/)
    for (const kind of ['unreachable', 'timeout', 'malformed']) expect(source).toContain(`error.kind === '${kind}'`)
    expect(source).toContain('<Trans>The world server answered with error {status}</Trans>')
    expect(source).not.toMatch(/\{error\.(reason|message)\}/)
  })

  it("shows the poll's failure on the status line", () => {
    expect(source).toMatch(/setFailure\(view\.failure \?\? null\)/)
    expect(source).toMatch(/\{failure \? \(\s*<LobbyFailure\s+error=\{failure\}\s+fallback=\{<Trans>World server not reachable<\/Trans>\}/)
  })
})

// The recordings question on the way into a match (#106): every join and
// create passes through the loadout dialog, so it is asked there.
describe('the loadout dialog', () => {
  it('asks the recordings question, and its Join or Create and fly answers it', () => {
    expect(source).toMatch(/\{loadout\}\s*\{sharing\}\s*<ResponsiveDialogFooter>/)
    expect(source).toMatch(/const fly = \(\) => \{\s*const now = pending\s*setPending\(null\)\s*if \(!now\) return\s*onFly\?\.\(\)/)
  })
})

describe('the match mode', () => {
  it("names the open mode in its own sense, as the flight log does (#120)", () => {
    expect(source).toContain("<Trans context='match mode'>Open</Trans>")
    expect(source).not.toMatch(/<Trans>Open<\/Trans>/)
  })
})

// The server page around the panel (MissionSetup.tsx).
const menu = readFileSync(fileURLToPath(new URL('./MissionSetup.tsx', import.meta.url)), 'utf8')
const flow = menu.slice(menu.indexOf('function ServerFlow('), menu.indexOf('function SharingSwitch('))
const chat = menu.slice(menu.indexOf('function LobbyChat('), menu.indexOf('function bookmarked('))

describe('entering a server', () => {
  it('writes the entry to the config only once it has loaded (#96)', () => {
    expect(flow).toMatch(/if \(settled\) onChange\(lobby_enter\(config, chosen\)\)\s*else setHeld\(chosen\)/)
    expect(flow).toMatch(/if \(!settled \|\| !held\) return\s*onChange\(lobby_enter\(config, held\)\)\s*setHeld\(''\)/)
    expect(flow).toMatch(/const \[held, setHeld\] = useState\(initial\)/)
  })

  it('mints nothing during render (#110)', () => {
    expect(menu).not.toContain('randomUUID')
  })

  it("hands the server its own token, worked out from the account's loaded secret (#102)", () => {
    expect(flow).toMatch(/const secret = settled \? String\(config\.pilot \?\? ''\) : ''/)
    expect(flow).toMatch(/void pilot_token\(secret, lobby\)\.then/)
    expect(flow).toMatch(/const pilot = secret && token\?\.key === key \? token\.value : undefined/)
    expect(flow).toMatch(/\n\s*pilot=\{pilot\}\n/)
    expect(flow).toMatch(/if \(pilot\) void world_withdraw\(lobby, pilot\)/)
    expect(flow).not.toMatch(/config\.pilot\s*\|\|/)
  })

  it('asks the recordings question in the loadout dialog, and records the answer on flying (#106)', () => {
    expect(flow).toMatch(/sharing=\{\s*<SharingSwitch\s+sharing=\{config\.sharing\}\s+onChange=\{\(v\) => set\('sharing', v\)\}\s*\/>\s*\}/)
    expect(flow).toMatch(/onFly=\{\(\) => \{\s*if \(config\.sharing === undefined\) set\('sharing', true\)\s*\}\}/)
  })
})

describe('the lobby chat', () => {
  it('keeps the line until the server has it, and sends one line once (#112)', () => {
    const say = chat.slice(chat.indexOf('const say = async'), chat.indexOf('return (', chat.indexOf('const say = async')))
    const sent = say.indexOf('await world_say(address, name, words)')
    const cleared = say.indexOf("lineRef.current.value = ''")
    expect(sent).toBeGreaterThan(0)
    expect(cleared).toBeGreaterThan(sent)
    expect(say).toMatch(/if \(!words \|\| flight\.current\) return\s*flight\.current = true/)
    expect(say).toMatch(/finally \{\s*flight\.current = false\s*setSending\(false\)/)
    expect(chat).toMatch(/loading=\{sending\}\s*icon=\{<Send className='size-4' \/>\}/)
  })

  it('words a failed send by its kind (#99)', () => {
    expect(chat).toMatch(/<LobbyFailure\s+error=\{failure\}\s+fallback=\{<Trans>Could not send the message<\/Trans>\}/)
    expect(menu).not.toMatch(/getErrorMessage/)
  })
})

describe('the loadout', () => {
  it('spells the centre station as the rest of the base English does (#119)', () => {
    expect(menu).toContain('<Trans>Centreline</Trans>')
    expect(menu).not.toContain('Centerline')
  })

  it('marks the preset in force with a tint, never the filled primary button (#123)', () => {
    const presets = menu.slice(menu.indexOf('{presets.map((entry) => {'), menu.indexOf('{entry.title}'))
    expect(presets).toContain("variant='outline'")
    expect(presets).not.toMatch(/variant=\{active/)
    expect(presets).toMatch(/active && 'bg-primary\/10 text-primary'/)
    expect(presets).toContain('aria-pressed={active}')
  })
})
