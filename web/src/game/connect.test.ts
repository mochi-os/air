// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

// A pilot can leave while the dial to a match is still under way. The dial
// must then come to nothing: no transport left open and joined, and nothing
// applied to the engine that stopped.

vi.mock('@mochi/web', () => ({ createAppClient: () => ({}) }))
const { connect } = await import('./net')

// Transport is a stand-in WebTransport: ready when told, a stream whose
// reader never answers (the welcome still in flight), and its closes counted.
class Transport {
  static made: Transport[] = []
  closed = 0
  open: () => void = () => {}
  ready = new Promise<void>((resolve) => (this.open = resolve))
  constructor() {
    Transport.made.push(this)
  }
  createBidirectionalStream() {
    return Promise.resolve({
      writable: { getWriter: () => ({ write: () => Promise.resolve() }) },
      readable: { getReader: () => ({ read: () => new Promise(() => {}), releaseLock: () => {}, cancel: () => Promise.resolve() }) },
    })
  }
  close() {
    this.closed++
  }
}
;(globalThis as unknown as { WebTransport: unknown }).WebTransport = Transport
afterEach(() => {
  Transport.made = []
})

const join = { address: 'https://127.0.0.1:4433', session: 's', name: 'n', server: 'https://127.0.0.1:4433' } as Parameters<typeof connect>[0]
const handlers = { event: () => {}, end: () => {}, close: () => {} } as unknown as Parameters<typeof connect>[1]

describe('a dial the engine abandons', () => {
  it('closes its transport and rejects while the transport is still opening', async () => {
    const quit = new AbortController()
    const dialled = connect(join, handlers, quit.signal)
    quit.abort()
    await expect(dialled).rejects.toThrow()
    expect(Transport.made[0].closed).toBe(1)
  })

  it('closes its transport and rejects while the welcome is in flight', async () => {
    const quit = new AbortController()
    const dialled = connect(join, handlers, quit.signal)
    Transport.made[0].open()
    await new Promise((r) => setTimeout(r, 0)) // through the stream and the join, to the welcome's wait
    quit.abort()
    await expect(dialled).rejects.toThrow()
    expect(Transport.made[0].closed).toBe(1)
  })

  it('opens nothing when it was abandoned before it began', async () => {
    const quit = new AbortController()
    quit.abort()
    await expect(connect(join, handlers, quit.signal)).rejects.toThrow()
    expect(Transport.made).toHaveLength(0)
  })
})

// engine.ts cannot be imported (WebGL at module scope): net_connect is lifted
// from its source and run against stand-ins.
const engine = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
function lift(name: string): string {
  const start = engine.indexOf(`\nfunction ${name}(`) + 1
  expect(start, name).toBeGreaterThan(0)
  const rest = engine.slice(start)
  const end = /\n(?=\S)/.exec(rest.slice(1))
  return end ? rest.slice(0, end.index + 1) : rest
}

describe("the engine's dial", () => {
  // dial runs net_connect against a dial the test settles, with the engine
  // stopped (session_over, its signal aborted) before it settles or not
  async function dial(settle: 'resolve' | 'reject', stopped: boolean) {
    let finish: { resolve: (n: unknown) => void; reject: (e: unknown) => void } = { resolve: () => {}, reject: () => {} }
    const pending = new Promise((resolve, reject) => (finish = { resolve, reject }))
    const seen = { left: 0, lounge: 0, notices: [] as string[], joined: null as unknown }
    const quit = new AbortController()
    const world = new Function(
      'pending',
      'seen',
      'signal',
      `let net = null, session_over = false, match_started = 0
       const join = {}, net_event = () => {}, net_end = () => {}
       const net_dial = () => pending
       const lounge_start = () => seen.lounge++
       const notice = (s) => seen.notices.push(s), translate = (s) => s
       const apply_own_state = () => {}, arrival = () => {}, apply_model_all = () => {}, assign_loadout = () => {}, loadout = () => {}, magazine = () => 0, update_rails = () => {}, default_master = () => '', default_radar = () => {}
       const ownship = {}, cfg = {}, TOD = {}, CLOUDS = {}
       let net_waiting = false, weapons_hold = false, weapons_rule = '', master = ''
       let running = true, onExit = null
       ${lift('net_connect')}
       net_connect()
       return { stop() { session_over = true }, get net() { return net } }`
    )(pending, seen, quit.signal) as { stop(): void; net: unknown }
    if (stopped) {
      world.stop()
      quit.abort()
    }
    const n = { leave: () => seen.left++, welcome: { parameters: {} } }
    if (settle === 'resolve') finish.resolve(n)
    else finish.reject(new Error('aborted'))
    await new Promise((r) => setTimeout(r, 0))
    seen.joined = world.net
    return seen
  }

  it('leaves a match that answers after the engine stopped, and applies nothing', async () => {
    const seen = await dial('resolve', true)
    expect(seen.left).toBe(1)
    expect(seen.lounge).toBe(0)
    expect(seen.joined).toBeNull()
  })

  it('takes the match it dialled while it runs', async () => {
    const seen = await dial('resolve', false)
    expect([seen.left, seen.lounge]).toEqual([0, 1])
    expect(seen.joined).not.toBeNull()
  })

  it('reports no failure for a dial it abandoned, and does for one that failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await dial('reject', true)).notices).toEqual([])
    expect((await dial('reject', false)).notices).toEqual(['CONNECTION FAILED'])
  })
})
