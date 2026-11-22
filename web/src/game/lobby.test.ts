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
const net = await import('./net')
const { lobby_watch, world_poll, LobbyError } = net

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
    await expect(world_poll('https://busy.example:4433', 'air', 0)).rejects.toMatchObject({ kind: 'refused', status: 429, reason: 'rate' })
    expect(asked).toEqual(['/poll'])
  })

  it('reports a server that is down as down, and keeps asking it the new way', async () => {
    const asked = serve(true, true)
    await expect(world_poll('https://down.example:4433', 'air', 0)).rejects.toMatchObject({ kind: 'unreachable' })
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

// A lobby address as typed or listed (#117): only a bare host is a world
// server on its conventional port; a URL keeps its own port and its path.
describe('a server address', () => {
  it('gives a bare host the world server port, and keeps a URL its own port and path', () => {
    vi.stubGlobal('location', { protocol: 'https:', hostname: 'mochi.example' })
    const n = net.normalize_server
    expect(n('host')).toBe('https://host:4433')
    expect(n('  host/  ')).toBe('https://host:4433')
    expect(n('host:5000')).toBe('https://host:5000')
    expect(n('host/world')).toBe('https://host:4433/world')
    expect(n('[::1]:4433')).toBe('https://[::1]:4433')
    expect(n('')).toBe('')
    expect(n('https://example.org')).toBe('https://example.org') // 443
    expect(n('http://example.org')).toBe('http://example.org') // 80
    expect(n('https://example.org:4433')).toBe('https://example.org:4433')
    expect(n('HTTPS://Example.org/world/')).toBe('https://example.org/world')
    vi.stubGlobal('location', { protocol: 'http:', hostname: 'mochi.example' })
    expect(n('host')).toBe('http://host:4433')
  })

  it('keeps a port typed on a bare host even when it is the scheme\'s own', () => {
    vi.stubGlobal('location', { protocol: 'https:', hostname: 'mochi.example' })
    expect(net.normalize_server('host:443')).toBe('https://host')
  })
})

// A lobby failure reaches the page as a kind it words in the player's language
// (#99), never as the browser's or the server's English.
describe('a failed lobby request', () => {
  const answer = (response: Partial<Response>) => vi.stubGlobal('fetch', vi.fn(async () => response as Response))
  const failing = (error: unknown) => vi.stubGlobal('fetch', vi.fn(async () => { throw error }))

  it('names a server that does not answer in time', async () => {
    failing(new DOMException('signal timed out', 'TimeoutError'))
    const error = await net.world_status('https://slow.example').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LobbyError)
    expect(error).toMatchObject({ kind: 'timeout' })
  })

  it('names a server that cannot be reached', async () => {
    failing(new TypeError('Failed to fetch'))
    await expect(net.world_say('https://gone.example', 'a', 'hi')).rejects.toMatchObject({ kind: 'unreachable' })
  })

  it('names an error status, and a refusal with the reason the server gave as data', async () => {
    answer({ ok: false, status: 502, json: async () => { throw new SyntaxError('Unexpected token <') } }) // a proxy's HTML page
    await expect(net.world_status('https://proxy.example')).rejects.toMatchObject({ kind: 'status', status: 502, reason: '' })
    answer({ ok: false, status: 400, json: async () => ({ error: 'full' }) })
    await expect(net.world_create('https://full.example', { game: 'air', mode: 'furball', label: 'x' })).rejects.toMatchObject({ kind: 'refused', status: 400, reason: 'full' })
    answer({ ok: true, status: 200, json: async () => ({ error: 'offers' }) })
    await expect(net.world_create('https://crowded.example', { game: 'air', mode: 'furball', label: 'x' })).rejects.toMatchObject({ kind: 'refused', reason: 'offers' })
  })

  it('names an answer that is not JSON as malformed', async () => {
    answer({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token') } })
    await expect(net.world_chat('https://garbled.example', 0)).rejects.toMatchObject({ kind: 'malformed' })
  })

  it('lets the caller\'s own abort through as it came', async () => {
    const stop = new AbortController()
    const abort = new DOMException('stopped', 'AbortError')
    stop.abort(abort)
    failing(abort)
    await expect(net.world_status('https://left.example', stop.signal)).rejects.toBe(abort)
  })
})

// The lobby's JSON is untrusted (#101): a reply of the wrong shape must reach
// React in the shape its type promises, or not at all.
describe('a lobby answer', () => {
  const answering = (body: unknown) =>
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => body }) as Response))

  it('reaches the page in the shape its type promises, whatever the server sent', async () => {
    answering({
      status: { name: { evil: 1 }, version: 3, protocol: 'x', games: 'air', sessions: NaN, players: '9', present: null, address: ['x'], certificate: { hash: 5 } },
      sessions: [
        null,
        7,
        { session: 's1', label: { x: 1 }, players: {}, capacity: 'two', mine: 'yes', parameters: [1] },
        { session: 's1', label: 'again' },
        { label: 'no id' },
        { session: 's2', players: [null, { name: 4, slot: 'x' }, { name: 'Ann', slot: 2 }] },
      ],
      chat: { lines: [null, { sequence: 'x' }, { sequence: 3, name: {}, text: 5 }, { sequence: 4, name: 'Bo', text: 'hi' }], sequence: 'nope' },
    })
    const poll = await world_poll('https://hostile.example', 'air', 2)
    expect(poll.status).toEqual({ name: '', version: '', protocol: 0, games: [], sessions: 0, players: 0, address: '' })
    expect(poll.sessions.map((s) => s.session)).toEqual(['s1', 's2'])
    expect(poll.sessions[0]).toMatchObject({ label: '', mode: '', players: [], capacity: 0, mine: false })
    expect(poll.sessions[0].parameters).toBeUndefined()
    expect(poll.sessions[1].players).toEqual([{ name: '', slot: 0 }, { name: 'Ann', slot: 2 }])
    expect(poll.chat).toEqual({ lines: [{ sequence: 3, time: 0 }, { sequence: 4, time: 0, name: 'Bo', text: 'hi' }], sequence: 2 })
  })

  it('caps its lists and its strings', async () => {
    const long = 'x'.repeat(5000)
    answering({
      status: { ...status, name: long },
      sessions: Array.from({ length: 500 }, (_, i) => ({ session: 's' + i, label: long })),
      chat: { lines: Array.from({ length: 300 }, (_, i) => ({ sequence: i + 1, text: long })), sequence: 300 },
    })
    const poll = await world_poll('https://flood.example', 'air', 0)
    expect(poll.status.name).toHaveLength(256)
    expect(poll.sessions).toHaveLength(200)
    expect(poll.sessions[0].label).toHaveLength(256)
    expect(poll.chat.lines).toHaveLength(100)
    expect(poll.chat.lines[0].sequence).toBe(201) // the newest hundred
  })

  it('reads an answer that is not an object, or a poll without a status, as malformed', async () => {
    answering(null)
    await expect(world_poll('https://null.example', 'air', 0)).rejects.toMatchObject({ kind: 'malformed' })
    answering([1, 2])
    await expect(world_poll('https://list.example', 'air', 0)).rejects.toMatchObject({ kind: 'malformed' })
    answering({ sessions: [] })
    await expect(world_poll('https://statusless.example', 'air', 0)).rejects.toMatchObject({ kind: 'malformed' })
  })

  it('takes a poll without a chat as one with no new lines', async () => {
    vi.useFakeTimers()
    answering({ status, sessions: [] })
    const seen: unknown[] = []
    const watch = lobby_watch('https://chatless.example:4433', 'air', undefined, (view) => seen.push([view.failure, view.lines]))
    await vi.advanceTimersByTimeAsync(0)
    expect(seen).toEqual([[null, []]])
    watch.stop()
  })
})

// The room the page shows (#111): each line once, however the requests that
// fetched it overlapped.
describe('the lobby room', () => {
  type Line = { sequence: number; time: number; name: string; text: string }
  // chatting stands in for a server's chat, honest about the cursor unless told
  // otherwise; held keeps the first answer back until release is called.
  function chatting(room: Line[], options: { ignore?: boolean; held?: boolean } = {}) {
    const cursors: number[] = []
    let release = () => {}
    const holding = options.held ? new Promise<void>((resolve) => (release = resolve)) : null
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const since = Number(new URL(url).searchParams.get('since'))
      cursors.push(since)
      if (holding && cursors.length === 1) await holding
      const lines = options.ignore ? [...room] : room.filter((l) => l.sequence > since)
      const sequence = room.length ? room[room.length - 1].sequence : 0
      return { ok: true, status: 200, json: async () => ({ status, sessions: [], chat: { lines, sequence } }) } as Response
    }))
    return { cursors, release: () => release() }
  }
  const line = (sequence: number, text = 'line ' + sequence): Line => ({ sequence, time: 0, name: 'a', text })

  it('asks after a send from where the poll in flight left off, and appends each line once', async () => {
    vi.useFakeTimers()
    const room = [line(1)]
    const server = chatting(room, { held: true })
    const seen: number[][] = []
    const watch = lobby_watch('https://overlap.example:4433', 'air', undefined, (view) => seen.push(view.lines.map((l) => l.sequence)))
    room.push(line(2)) // a send lands while the poll is still out
    const refreshed = watch.refresh()
    server.release()
    await vi.advanceTimersByTimeAsync(0)
    await refreshed
    expect(server.cursors).toEqual([0, 2])
    expect(seen[seen.length - 1]).toEqual([1, 2])
    watch.stop()
  })

  it('appends a line a server repeats only once', async () => {
    vi.useFakeTimers()
    chatting([line(1), line(2)], { ignore: true }) // answers every line, whatever the cursor
    const seen: number[][] = []
    const watch = lobby_watch('https://repeating.example:4433', 'air', undefined, (view) => seen.push(view.lines.map((l) => l.sequence)))
    await vi.advanceTimersByTimeAsync(0)
    await watch.refresh()
    await vi.advanceTimersByTimeAsync(3000)
    expect(seen).toEqual([[1, 2], [1, 2], [1, 2]])
    watch.stop()
  })

  it('starts the room again when the server restarts and its numbering with it', async () => {
    vi.useFakeTimers()
    const room = [line(1), line(2), line(3)]
    const server = chatting(room)
    const seen: string[][] = []
    const watch = lobby_watch('https://restarted.example:4433', 'air', undefined, (view) => seen.push(view.lines.map((l) => l.text ?? '')))
    await vi.advanceTimersByTimeAsync(0)
    room.splice(0, room.length, line(1, 'after the restart'))
    await vi.advanceTimersByTimeAsync(3000)
    await vi.advanceTimersByTimeAsync(3000)
    expect(server.cursors).toEqual([0, 3, 0])
    expect(seen[seen.length - 1]).toEqual(['after the restart'])
    watch.stop()
  })
})

// The pilot token (#102): each world server sees its own, derived from the
// account's one secret, so a token one server holds is useless at another.
describe('the pilot token', () => {
  it('is the SHA-256 of the secret and the server\'s lobby address', async () => {
    vi.stubGlobal('location', { protocol: 'https:', hostname: 'mochi.example' })
    const { createHash } = await import('node:crypto')
    const expected = createHash('sha256').update('secret\nhttps://a.example:4433').digest('hex')
    expect(await net.pilot_token('secret', 'https://a.example:4433')).toBe(expected)
    expect(await net.pilot_token('secret', 'a.example')).toBe(expected) // the same server, however it was typed
    expect(await net.pilot_token('secret', 'https://b.example:4433')).not.toBe(expected)
    expect(await net.pilot_token('', 'https://a.example:4433')).toBeUndefined()
  })

  it('is undefined, not a throw, where the page has no SubtleCrypto', async () => {
    const real = globalThis.crypto
    vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => real.getRandomValues(bytes) })
    expect(await net.pilot_token('secret', 'https://a.example:4433')).toBeUndefined()
  })
})

// The account's pilot secret (#110), minted where a context has no randomUUID,
// and entering a server with the config as loaded (#96).
describe('entering a server', () => {
  it('mints the secret from getRandomValues alone', () => {
    const real = globalThis.crypto
    vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => real.getRandomValues(bytes) })
    const one = net.pilot_mint()
    expect(one).toMatch(/^[0-9a-f]{32}$/)
    expect(net.pilot_mint()).not.toBe(one)
  })

  it('keeps the secret and the recent servers the account has, the server first', () => {
    expect(net.lobby_enter({ world: '', pilot: 'mine', servers: 'b\na\nc' }, 'a')).toEqual({ world: 'a', pilot: 'mine', servers: 'a\nb\nc' })
  })

  it('mints a secret only for an account that has none, and keeps five servers', () => {
    const next = net.lobby_enter({ world: '', pilot: '', servers: '1\n2\n3\n4\n5' }, '6')
    expect(next.pilot).toMatch(/^[0-9a-f]{32}$/)
    expect(next.servers).toBe('6\n1\n2\n3\n4')
  })

  it('mints a secret the config store never takes for one of the old, disclosed shape', async () => {
    // Otherwise every load would blank the account's new secret again.
    const { disclosed } = await import('../lib/config-persist')
    expect(disclosed(net.pilot_mint())).toBe(false)
    expect(disclosed(net.lobby_enter({ world: '', pilot: '', servers: '' }, 'a').pilot)).toBe(false)
  })

  it("mints a visitor no one signed in as a secret of their own, not the cached account's (#242)", async () => {
    const { PendingConfig, Saver } = await import('../lib/config-persist')
    const { DEFAULT_CONFIG } = await import('../lib/config')
    const cached = { ...DEFAULT_CONFIG, pilot: 'a'.repeat(32), servers: 'https://w.example' }
    const shown = new Saver(new PendingConfig(cached), async () => true).load({ signed: false, saved: null })
    const entered = net.lobby_enter(shown ?? cached, 'https://x.example')
    expect(entered.pilot).toMatch(/^[0-9a-f]{32}$/)
    expect(entered.pilot).not.toBe(cached.pilot)
    expect(entered.servers).toBe('https://x.example')
  })
})

// The match connection's writes (#114): a write to a connection that has gone
// rejects, and nothing awaits it.
describe('the match connection', () => {
  it('drops the rejection of a write to a connection that has gone, and sends nothing once closed but the goodbye', async () => {
    const unhandled: unknown[] = []
    const note = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', note)
    const writes: string[] = []
    // A plain function, not vi.fn: a mock watches the promises it returns,
    // which handles their rejections and would hide the very thing tested.
    const writer = (name: string) => ({
      write: () => {
        writes.push(name)
        return Promise.reject(new TypeError('the connection has gone'))
      },
    })
    const control = writer('control')
    const datagrams = writer('datagrams')
    const transport = {
      datagrams: { writable: { getWriter: () => datagrams }, readable: { getReader: () => ({ read: () => new Promise(() => {}) }) } },
      closed: new Promise(() => {}),
      close: () => {},
    }
    const link = new net.Net(transport as unknown as WebTransport, {})
    link.start(control as unknown as WritableStreamDefaultWriter<Uint8Array>, (async function* () { yield await new Promise<Uint8Array>(() => {}) })())
    link.input({ status: { reply: false, challenge: false, link: false, antenna: 'both', tracks: [] } } as unknown as Parameters<typeof link.input>[0])
    link.chat('hi', 'all')
    link.jettison([])
    link.radar(0, -1)
    link.leave()
    link.chat('after', 'all')
    await new Promise((resolve) => setTimeout(resolve, 10))
    process.off('unhandledRejection', note)
    expect(writes).toEqual(['datagrams', 'control', 'control', 'control', 'control'])
    expect(unhandled).toEqual([])
  })
})
