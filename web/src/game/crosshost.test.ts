// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { describe, expect, it } from 'vitest'
import { crossHost } from './host'

// crossHost gates every multiplayer join: the lobby is untrusted and hands out
// both the WebTransport address AND the certificate hash to trust, so a
// redirect it invents must be surfaced before the browser dials it.
describe('crossHost', () => {
  it('passes an exact match', () => {
    expect(crossHost('https://play.example.org:4433/play', 'https://play.example.org')).toBeNull()
  })

  it('passes loopback spellings of the same machine', () => {
    // The world server's own default advertises 127.0.0.1 while the player
    // typed localhost — the false positive this rule exists to remove.
    expect(crossHost('https://127.0.0.1:4433/play', 'http://localhost:8081')).toBeNull()
    expect(crossHost('https://localhost:4433/play', 'http://127.0.0.1:8081')).toBeNull()
    expect(crossHost('https://[::1]:4433/play', 'http://localhost:8081')).toBeNull()
    expect(crossHost('https://127.0.0.2:4433/play', 'http://127.0.0.1:8081')).toBeNull()
  })

  it('WARNS when a remote lobby redirects to loopback', () => {
    // The private-service attack: a remote server pointing the browser at the
    // player's own machine. Collapsing loopback names must not reach this.
    expect(crossHost('https://127.0.0.1:4433/play', 'https://evil.example.org')).toBe('127.0.0.1')
    expect(crossHost('https://localhost:4433/play', 'https://evil.example.org')).toBe('localhost')
  })

  it('warns on a plain cross-host redirect', () => {
    expect(crossHost('https://elsewhere.example.net:4433/play', 'https://play.example.org')).toBe(
      'elsewhere.example.net'
    )
  })

  it('warns on a private-network redirect from a remote lobby', () => {
    expect(crossHost('https://192.168.1.10:4433/play', 'https://play.example.org')).toBe('192.168.1.10')
  })

  it('treats an unparseable transport address as cross-host', () => {
    expect(crossHost('not a url', 'https://play.example.org')).toBe('not a url')
  })
})
