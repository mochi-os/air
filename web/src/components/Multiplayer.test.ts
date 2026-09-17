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
    expect(source).toMatch(/\{pilot && s\.mine && \(s\.offer \|\| \(s\.players \?\? \[\]\)\.length === 0\) && \(/)
    expect(source).toMatch(/await world_withdraw\(address, pilot\)/)
  })
})
