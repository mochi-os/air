// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The join page's ordering rules. These decide what a player sees before they
// have clicked anything, and until 2026-08-13 they had no test and had never
// been seen with more than one server in the list, because only one public
// world server existed.

import { describe, expect, it } from 'vitest'
import { server_mismatch, server_offline, server_order, type Server } from './servers'

const now = 1_700_000_000

function server(name: string, players: number, options: Partial<Server> = {}): Server {
  return {
    world: name,
    name,
    address: `https://${name}.example:4433`,
    version: 3,
    players,
    seen: now,
    ...options,
  }
}

describe('server_offline', () => {
  it('holds a listing live through two refresh floors', () => {
    expect(server_offline(server('fresh', 1), now)).toBe(false)
    expect(server_offline(server('recent', 1, { seen: now - 1499 }), now)).toBe(false)
  })

  it('marks a listing offline once it has gone quiet past them', () => {
    expect(server_offline(server('quiet', 1, { seen: now - 1501 }), now)).toBe(true)
  })
})

describe('server_mismatch', () => {
  it('does not grey the list out before the wasm reports its version', () => {
    expect(server_mismatch(server('any', 1, { version: 99 }), 0)).toBe(false)
  })

  it('flags a server flying a different flight model', () => {
    expect(server_mismatch(server('old', 1, { version: 2 }), 3)).toBe(true)
    expect(server_mismatch(server('same', 1, { version: 3 }), 3)).toBe(false)
  })
})

describe('server_order', () => {
  it('puts the busiest server first', () => {
    const order = server_order([server('quiet', 0), server('busy', 7), server('some', 2)], now)
    expect(order.map((s) => s.name)).toEqual(['busy', 'some', 'quiet'])
  })

  it('sinks an offline server below every live one, whatever it last reported', () => {
    const order = server_order([server('gone', 40, { seen: now - 3000 }), server('here', 1)], now)
    expect(order.map((s) => s.name)).toEqual(['here', 'gone'])
  })

  it('leaves a version-mismatched server in its place rather than demoting it', () => {
    // It is shown greyed WITH the reason: a hidden or buried server reads as a
    // dead network, an explained one reads as a server you cannot join yet.
    const order = server_order([server('current', 2), server('ahead', 6, { version: 99 })], now)
    expect(order.map((s) => s.name)).toEqual(['ahead', 'current'])
  })

  it('does not mutate the list it was handed', () => {
    const servers = [server('a', 1), server('b', 9)]
    server_order(servers, now)
    expect(servers.map((s) => s.name)).toEqual(['a', 'b'])
  })
})
