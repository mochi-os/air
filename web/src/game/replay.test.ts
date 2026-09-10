// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { describe, expect, it } from 'vitest'
import { identity } from './replay'

// The recording has to carry the key of the history row it belongs to, and the
// two kinds of row are keyed differently (#118). Getting this wrong is silent:
// the recorder keeps filling memory for a whole match and nothing can reach
// what it produced, because MatchLog offers the in-memory copy only when
// `replay.session === m.session` and the upload binds on (session, started).
describe('identity', () => {
  it('keys a single-player recording on the local pair', () => {
    expect(identity(false, '', 0, 1700)).toEqual({
      session: 'local-1700',
      started: 1700,
    })
  })

  it('keys a multiplayer recording on the world session and the match start', () => {
    // NOT "local-"+mission_began, which is what shipped: net_finish writes the
    // row with the world's session and match_started, so a local key matched
    // no row and the recording was unreachable by either route.
    expect(identity(true, 'world-session-42', 900, 1700)).toEqual({
      session: 'world-session-42',
      started: 900,
    })
  })

  it('uses the match start, not the local mission start, when they differ', () => {
    // They always differ: mission_began is set when the flight begins,
    // match_started when net_dial resolves. Pinning this separately means the
    // session half of the previous case cannot carry the test on its own.
    const row = identity(true, 'world-session-42', 900, 1700)
    expect(row?.started).not.toBe(1700)
  })

  it('binds to nothing when multiplayer never got a welcome', () => {
    // match_started stays 0, net_finish writes no row, so there is nothing for
    // an upload to attach to and it must not be attempted.
    expect(identity(true, 'world-session-42', 0, 1700)).toBeNull()
  })

  it('still produces a single-player row when the world session is absent', () => {
    expect(identity(false, '', 0, 42)).toEqual({
      session: 'local-42',
      started: 42,
    })
  })
})
