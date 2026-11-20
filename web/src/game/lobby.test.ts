// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { afterEach, describe, expect, it, vi } from 'vitest'

// The server page's reads of a world server. The match list and the lobby chat
// each polled on their own - the status, the list and the chat, 44 reads a
// minute - and the server's per-address budget refused a third player behind
// one address. They now share one poll that carries all three.

vi.mock('@mochi/web', () => ({ createAppClient: () => ({}) }))
const { lobby_watch, world_poll } = await import('./net')

const status = { name: 'w', version: 'v', protocol: 1, games: ['air'], sessions: 0, players: 0, address: 'https://w/play' }

// serve stands in for fetch: old servers have no /poll, and a browser reports
// that as a failed fetch (the 404 carries no CORS header), not as a 404.
function serve(old: boolean, down = false, refusing = 0) {
  const asked: string[] = []
  let sequence = 0
  const fetch = vi.fn(async (url: string) => {
    const path = new URL(url).pathname
    asked.push(path)
    if (down || (old && path === '/poll')) throw new TypeError('Failed to fetch')
    if (refusing) return { ok: false, status: refusing, json: async () => ({ error: 'rate' }) } as Response
    const since = Number(new URL(url).searchParams.get('since') ?? 0)
    sequence++
    const chat = { lines: [{ sequence, time: 0, name: 'a', text: 'line ' + sequence }].filter((l) => l.sequence > since), sequence }
    const body = path === '/poll' ? { status, sessions: [], chat } : path === '/status' ? status : path === '/sessions' ? { sessions: [] } : chat
    return { ok: true, status: 200, json: async () => body } as Response
  })
  vi.stubGlobal('fetch', fetch)
  return asked
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('a poll of a world server', () => {
  it('asks once for the status, the list and the chat', async () => {
    const asked = serve(false)
    const poll = await world_poll('https://new.example:4433', 'air', 0)
    expect(asked).toEqual(['/poll'])
    expect([poll.status.name, poll.sessions, poll.chat.lines.length]).toEqual(['w', [], 1])
  })

  it('asks a server that predates it the old way, and from then on goes straight there', async () => {
    const asked = serve(true)
    const poll = await world_poll('https://old.example:4433', 'air', 0)
    expect(poll.status.name).toBe('w')
    await world_poll('https://old.example:4433', 'air', poll.chat.sequence)
    expect(asked.filter((p) => p === '/poll')).toHaveLength(1)
    expect(asked).toHaveLength(7)
  })

  it('takes an error from /poll as the poll\'s, without asking three times over', async () => {
    const asked = serve(false, false, 429)
    await expect(world_poll('https://busy.example:4433', 'air', 0)).rejects.toThrow('status 429')
    expect(asked).toEqual(['/poll'])
  })

  it('reports a server that is down as down, and keeps asking it the new way', async () => {
    const asked = serve(true, true)
    await expect(world_poll('https://down.example:4433', 'air', 0)).rejects.toThrow('Failed to fetch')
    await expect(world_poll('https://down.example:4433', 'air', 0)).rejects.toThrow()
    expect(asked.filter((p) => p === '/poll')).toHaveLength(2)
  })
})

describe('the page watching a server', () => {
  it('shares one poll between the match list and the chat', async () => {
    vi.useFakeTimers()
    const asked = serve(false)
    const list: unknown[] = [], room: unknown[] = []
    const matches = lobby_watch('https://shared.example:4433', 'air', 'pilot', (view) => list.push(view.status))
    const chat = lobby_watch('https://shared.example:4433', 'air', undefined, (view) => room.push(view.lines.length))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(3000)
    expect(asked).toEqual(['/poll', '/poll'])
    expect(list).toEqual([status, status])
    expect(room).toEqual([1, 2]) // the chat gathers across polls
    matches.stop()
    chat.stop()
    await vi.advanceTimersByTimeAsync(6000)
    expect(asked).toHaveLength(2) // nothing watching, nothing asked
  })

  it('carries the pilot token, so the shared poll is the offer heartbeat', async () => {
    vi.useFakeTimers()
    serve(false)
    const watch = lobby_watch('https://beat.example:4433', 'air', undefined, () => {})
    const mine = lobby_watch('https://beat.example:4433', 'air', 'me', () => {})
    await vi.advanceTimersByTimeAsync(3000)
    const calls = (fetch as unknown as { mock: { calls: string[][] } }).mock.calls
    expect(calls[calls.length - 1][0]).toContain('pilot=me')
    watch.stop()
    mine.stop()
  })

  it('polls again after a send, rather than handing back the poll already in flight', async () => {
    vi.useFakeTimers()
    const asked = serve(false)
    const watch = lobby_watch('https://send.example:4433', 'air', undefined, () => {})
    const refreshed = watch.refresh() // while the first poll is still out
    await vi.advanceTimersByTimeAsync(0)
    await refreshed
    expect(asked).toEqual(['/poll', '/poll'])
    watch.stop()
  })
})
