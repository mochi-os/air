// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, it, expect, vi } from 'vitest'
import { migrate, normalize } from '../game/stores'
import { DEFAULT_CONFIG, TAB_FIELDS, type MissionConfig } from './config'
import {
  absorb,
  anonymous,
  answered,
  ask,
  DEVICE,
  disclosed,
  loadOutcome,
  merged,
  PendingConfig,
  RETIRED,
  RETRY,
  SAVE_DELAY,
  Saver,
  seeded,
  type Label,
  type Taken,
  stripRetired,
} from './config-persist'

// Minimal stand-ins; PendingConfig only stores/returns the reference.
const cfg = (fuel: number) => ({ fuel }) as unknown as MissionConfig

describe('loadOutcome', () => {
  it('flushes an edit made during load — it is persisted, never discarded', () => {
    // The regression: an edit during a slow load whose debounced save was
    // dropped (identity not yet known) must be saved at load completion.
    expect(loadOutcome(true, null)).toBe('flush')
    expect(loadOutcome(true, { fuel: 6000 })).toBe('flush')
  })

  it('applies the stored config when the user has not edited and one exists', () => {
    expect(loadOutcome(false, { fuel: 6000 })).toBe('apply')
  })

  it('seeds the server on a fresh account with no edit and no stored config', () => {
    expect(loadOutcome(false, null)).toBe('seed')
  })

  it('keeps what is shown when the load named no account, edited or not', () => {
    expect(loadOutcome(false, null, false)).toBe('keep')
    expect(loadOutcome(true, null, false)).toBe('keep')
  })
})

describe('PendingConfig', () => {
  it('reflects the latest edit synchronously — before any render sync (the load-race fix)', () => {
    const a = cfg(1)
    const b = cfg(2)
    const pending = new PendingConfig(a)
    expect(pending.dirty).toBe(false)
    expect(pending.current()).toBe(a)
    // The player edits. config/load could resolve on the very next microtask,
    // before React commits the render that would sync() the new value — the
    // flush must read b, not the stale a.
    pending.edit(b)
    expect(pending.dirty).toBe(true)
    expect(pending.current()).toBe(b)
  })

  it('mirrors external state via sync until the user edits, then holds the edit', () => {
    const a = cfg(1)
    const b = cfg(2)
    const c = cfg(3)
    const pending = new PendingConfig(a)
    pending.sync(b) // a render delivered new component state
    expect(pending.current()).toBe(b)
    pending.edit(c)
    pending.sync(a) // a later/stale render must not clobber the user's edit
    expect(pending.current()).toBe(c)
    expect(pending.dirty).toBe(true)
  })
})

describe('stripRetired', () => {
  it('drops the retired Sensitivity value a legacy account still carries', () => {
    expect(stripRetired({ fuel: 6000, sens: 0.6 })).toEqual({ fuel: 6000 })
  })

  it('drops the retired missiles boolean the per-station loadout replaced', () => {
    expect(stripRetired({ fuel: 6000, missiles: false })).toEqual({
      fuel: 6000,
    })
  })

  it('leaves a config that carries no retired key untouched', () => {
    expect(stripRetired({ fuel: 6000, callsign: 'Hornet' })).toEqual({
      fuel: 6000,
      callsign: 'Hornet',
    })
  })

  it('copies rather than mutates, so the caller can still read what it strips', () => {
    // loadConfig reads `missiles` to migrate the loadout AFTER stripping; a
    // mutating strip would pull that value out from under it.
    const saved = { fuel: 6000, missiles: false, sens: 0.6 }
    stripRetired(saved)
    expect(saved.missiles).toBe(false)
    expect(saved.sens).toBe(0.6)
  })

  it('names every retired key in one place', () => {
    expect([...RETIRED]).toEqual(['missiles', 'sens'])
  })
})

// The keys an early edit touched, and what a flush makes of them (#41): a
// server deep link enters the server as the page mounts, an edit made on the
// defaults because the saved config has not come back yet. Flushing the
// in-memory config wholesale put the defaults over every saved setting; the
// flush now lays only the edited keys onto what the server had.
describe('the partial a flush applies', () => {
  const saved: Partial<MissionConfig> = {
    callsign: 'Little Nellie',
    tod: 'night',
    clouds: 'cumulus',
    fuel: 6000,
  }

  it('records only the keys an edit changed, accumulates across edits, and keeps them past settle until a save spends them', () => {
    const pending = new PendingConfig(DEFAULT_CONFIG)
    expect(pending.partial()).toEqual({})
    pending.edit({ ...DEFAULT_CONFIG, servers: '127.0.0.1:4433', pilot: 'p1' })
    expect(pending.partial()).toEqual({
      servers: '127.0.0.1:4433',
      pilot: 'p1',
    })
    pending.edit({ ...pending.current(), tod: 'night' })
    expect(pending.partial()).toEqual({
      servers: '127.0.0.1:4433',
      pilot: 'p1',
      tod: 'night',
    })
    const whole = merged(saved, pending.partial())
    pending.settle(whole)
    expect(pending.partial()).toEqual({
      servers: '127.0.0.1:4433',
      pilot: 'p1',
      tod: 'night',
    }) // not yet saved
    expect(pending.dirty).toBe(false)
    expect(pending.current()).toBe(whole)
    const sent = pending.partial()
    pending.spend(sent, pending.stamp(Object.keys(sent)))
    expect(pending.partial()).toEqual({})
    pending.sync(DEFAULT_CONFIG) // settled: renders may sync again
    expect(pending.current()).toBe(DEFAULT_CONFIG)
  })

  it('keeps a key owed after a save went, though the save carried that key', () => {
    const pending = new PendingConfig(DEFAULT_CONFIG)
    pending.edit({ ...DEFAULT_CONFIG, pilot: 'a'.repeat(32) })
    const sent = pending.partial()
    const stamps = pending.stamp(Object.keys(sent))
    pending.owe({ pilot: '' })
    pending.spend(sent, stamps)
    expect(pending.partial()).toEqual({ pilot: '' })
  })

  it('lays the edit onto the saved config, keeping every saved key the edit did not touch', () => {
    const whole = merged(saved, { servers: '127.0.0.1:4433', pilot: 'p1' })
    expect(whole.callsign).toBe('Little Nellie')
    expect(whole.tod).toBe('night')
    expect(whole.clouds).toBe('cumulus')
    expect(whole.fuel).toBe(6000)
    expect(whole.servers).toBe('127.0.0.1:4433')
    expect(whole.pilot).toBe('p1')
    expect(whole.start).toBe(DEFAULT_CONFIG.start) // a key nobody set: the default under it
    expect(merged(null, { servers: 's' })).toEqual({
      ...DEFAULT_CONFIG,
      servers: 's',
    }) // a fresh account: the defaults plus the edit
  })

  it('does not carry the defaults an early edit was made on over the saved config', () => {
    const pending = new PendingConfig(DEFAULT_CONFIG) // a fresh page: nothing loaded yet
    pending.edit({ ...DEFAULT_CONFIG, servers: '127.0.0.1:4433', pilot: 'p1' }) // the deep link entering the server
    expect(pending.current().callsign).toBe('') // what a wholesale flush would have saved
    expect(merged(saved, pending.partial()).callsign).toBe('Little Nellie')
    expect(merged(saved, pending.partial()).tod).toBe('night')
  })

  it('reads a saved config with the retired keys gone and the stores migrated, the same way apply does', () => {
    const whole = absorb({
      fuel: 6000,
      sens: 0.6,
      missiles: false,
    } as unknown as Partial<MissionConfig>)
    expect('sens' in whole).toBe(false)
    expect('missiles' in whole).toBe(false)
    expect(whole.fuel).toBe(6000)
    expect(whole.stores).toEqual(normalize(migrate(false)))
    expect(absorb({ callsign: 'x' }).stores).toEqual(normalize(migrate(true)))
  })

  it("reads a bandit saved under a tier's former name as the tier it became", () => {
    const former = (bandit: string) => absorb({ bandit } as unknown as Partial<MissionConfig>).bandit
    expect(former('pilot')).toBe('intermediate')
    expect(former('ace')).toBe('expert')
    for (const tier of ['novice', 'intermediate', 'expert', 'superhuman']) expect(former(tier)).toBe(tier)
    expect(absorb({ callsign: 'x' }).bandit).toBe(DEFAULT_CONFIG.bandit)
  })
})

describe('the answer on sharing', () => {
  it('has no default, so a config never asked reads as unset', () => {
    expect('sharing' in DEFAULT_CONFIG).toBe(false)
    expect(absorb({ callsign: 'x' }).sharing).toBeUndefined()
  })

  it('reads a saved answer either way', () => {
    expect(absorb({ sharing: true }).sharing).toBe(true)
    expect(absorb({ sharing: false }).sharing).toBe(false)
  })

  it('is never seeded onto an account from the config in memory', () => {
    // A shared browser's cache is the last account's settings: its answer is not this one's.
    const cached = { ...DEFAULT_CONFIG, callsign: 'Maverick', sharing: true } as MissionConfig
    const first = seeded(cached)
    expect('sharing' in first).toBe(false)
    expect(cached.sharing).toBe(true) // a copy: the caller's config is untouched
  })
})

// A first-time player has nothing saved: the menu shows DEFAULT_CONFIG, and the
// first load seeds the account with it. A returning player's saved task stands.
describe('a first-time player', () => {
  it('starts in free flight, in the air', () => {
    expect(DEFAULT_CONFIG.task).toBe('free')
    expect(DEFAULT_CONFIG.start).toBe('air')
    expect(loadOutcome(false, null)).toBe('seed')
    expect(seeded(DEFAULT_CONFIG).task).toBe('free')
    expect(seeded(DEFAULT_CONFIG).start).toBe('air')
  })

  it('keeps free flight when an edit lands before the first load', () => {
    expect(merged(null, { callsign: 'x' }).task).toBe('free')
    expect(merged(null, { callsign: 'x' }).start).toBe('air')
  })

  it('leaves a returning player on the task and start they saved', () => {
    expect(absorb({ task: 'joust' }).task).toBe('joust')
    expect(absorb({ start: 'carrier' }).start).toBe('carrier')
    expect(merged({ task: 'joust' }, { callsign: 'x' }).task).toBe('joust')
  })

  it("matches the engine's own fallback", () => {
    // engine.ts cannot be imported (WebGL at module scope), so its cfg literal is read as text.
    const engine = readFileSync(fileURLToPath(new URL('../game/engine.ts', import.meta.url)), 'utf8')
    const literal = /\nconst cfg = \{[\s\S]*?\};/.exec(engine)?.[0] ?? ''
    expect(literal).toContain(`task:"${DEFAULT_CONFIG.task}"`)
    expect(literal).toContain(`start:"${DEFAULT_CONFIG.start}"`)
  })
})

// A new account seeded from a shared browser's cache (#103): the cache is not
// keyed by account, so only the device's own settings may carry over.
describe('a new account on a shared browser', () => {
  const cached = {
    ...DEFAULT_CONFIG,
    pilot: 'secret of the last account',
    callsign: 'Maverick',
    world: 'https://w.example',
    servers: 'https://w.example',
    sharing: true,
    tod: 'night',
    joystick: 'pad',
    keys: { fire: 'KeyF' },
    volume: { ...(DEFAULT_CONFIG.volume as Record<string, number>), master: 20 },
    render_scale: 0.6,
    framerate: true,
  } as MissionConfig

  it("takes the device's settings and none of the last account's own", () => {
    const first = seeded(cached)
    expect(first.joystick).toBe('pad')
    expect(first.keys).toEqual({ fire: 'KeyF' })
    expect((first.volume as Record<string, number>).master).toBe(20)
    expect(first.render_scale).toBe(0.6)
    expect(first.framerate).toBe(true)
    expect(first.pilot).toBe('')
    expect(first.callsign).toBe('')
    expect(first.world).toBe('')
    expect(first.servers).toBe('')
    expect(first.tod).toBe(DEFAULT_CONFIG.tod)
    expect('sharing' in first).toBe(false)
  })

  it("names every field of the device's tabs, and nothing else", () => {
    const tabs = ['controls', 'keys', 'sound', 'graphics'].flatMap((tab) => TAB_FIELDS[tab])
    expect([...DEVICE].sort()).toEqual([...tabs].sort())
  })
})

// The saves (#104, #105): only the keys the player edited since the last save
// that took, sent as the edits pause, and at once when the page hides or the
// menu goes away.
describe('the saves', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function saving(answers: boolean[] = []) {
    const posts: [Partial<MissionConfig>, boolean][] = []
    const pending = new PendingConfig(DEFAULT_CONFIG)
    const saver = new Saver(pending, async (config, keepalive) => {
      posts.push([config, keepalive])
      return answers.shift() ?? true
    })
    return { posts, pending, saver }
  }
  const settled = { signed: true, saved: { callsign: 'Little Nellie' } }

  it('send only the keys edited, once the edits pause', async () => {
    vi.useFakeTimers()
    const { posts, pending, saver } = saving()
    saver.load(settled)
    saver.edit({ ...pending.current(), tod: 'night' })
    saver.edit({ ...pending.current(), clouds: 'cumulus' })
    await vi.advanceTimersByTimeAsync(SAVE_DELAY - 1)
    expect(posts).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(posts).toEqual([[{ tod: 'night', clouds: 'cumulus' }, false]])
    saver.edit({ ...pending.current(), fuel: 6000 })
    await vi.advanceTimersByTimeAsync(SAVE_DELAY)
    expect(posts[1]).toEqual([{ fuel: 6000 }, false]) // the keys the last save took are spent
  })

  it('send again a key the server did not take, and keep a key edited while its save was out', async () => {
    vi.useFakeTimers()
    const { posts, pending, saver } = saving([false])
    saver.load(settled)
    saver.edit({ ...pending.current(), tod: 'night' })
    await vi.advanceTimersByTimeAsync(SAVE_DELAY)
    saver.edit({ ...pending.current(), fuel: 6000 })
    await vi.advanceTimersByTimeAsync(SAVE_DELAY)
    expect(posts[1][0]).toEqual({ tod: 'night', fuel: 6000 })
    // A save that lands after the player changed a key again spends only what it carried.
    const late = saving()
    late.saver.load(settled)
    late.saver.edit({ ...late.pending.current(), tod: 'night' })
    const out = late.saver.save()
    late.saver.edit({ ...late.pending.current(), tod: 'day' })
    await out
    expect(late.pending.partial()).toEqual({ tod: 'day' })
  })

  it('send the edits made while loading laid on the saved config, and only those', () => {
    const { posts, pending, saver } = saving()
    saver.edit({ ...pending.current(), world: 'https://w.example' })
    const whole = saver.load({ signed: true, saved: { callsign: 'Little Nellie', tod: 'night' } })
    expect(whole).toMatchObject({ callsign: 'Little Nellie', tod: 'night', world: 'https://w.example' })
    expect(posts).toEqual([[{ world: 'https://w.example' }, false]])
  })

  it('seed a fresh account whole, apply a saved one, and send nothing for one never loaded', () => {
    const fresh = saving()
    expect(fresh.saver.load({ signed: true, saved: null })).toEqual(seeded(DEFAULT_CONFIG))
    expect(fresh.posts).toEqual([[seeded(DEFAULT_CONFIG), false]])
    const returning = saving()
    expect(returning.saver.load(settled)?.callsign).toBe('Little Nellie')
    expect(returning.posts).toEqual([])
    const anonymous = saving()
    anonymous.saver.edit({ ...anonymous.pending.current(), callsign: 'Goose' })
    expect(anonymous.saver.load({ signed: false, saved: null })).toBeNull() // the cache shown stays as it is
    expect(anonymous.posts).toEqual([])
  })

  it("seed a fresh account edited while loading over the device's own settings, and send it whole", async () => {
    // The browser's cache holds this device's stick, keys, sound and graphics;
    // a server entered as the page opened edits the config before the load
    // answers that nothing is saved yet.
    const cached = {
      ...DEFAULT_CONFIG,
      joystick: 'pad',
      keys: { fire: 'KeyF' },
      render_scale: 0.6,
      callsign: 'Maverick', // the last account's, not the device's
    } as MissionConfig
    const posts: [Partial<MissionConfig>, boolean][] = []
    const pending = new PendingConfig(cached)
    const saver = new Saver(pending, async (config, keepalive) => {
      posts.push([config, keepalive])
      return true
    })
    saver.edit({ ...pending.current(), world: 'https://w.example' })
    const whole = saver.load({ signed: true, saved: null })
    expect(whole).toMatchObject({ joystick: 'pad', keys: { fire: 'KeyF' }, render_scale: 0.6, world: 'https://w.example' })
    expect(whole?.callsign).toBe('')
    expect(posts).toEqual([[whole, false]]) // the seed, the edit in it, as a first load sends one
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(pending.partial()).toEqual({}) // spent once the server took it
    expect(merged(null, { world: 'w' }, cached).joystick).toBe('pad')
  })

  it('send what is unsaved at once, kept alive, when the page hides or goes away', async () => {
    vi.useFakeTimers()
    const { posts, pending, saver } = saving()
    saver.load(settled)
    const page = new EventTarget()
    const document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
    const detach = saver.attach(page, document)
    saver.edit({ ...pending.current(), tod: 'night' })
    document.dispatchEvent(new Event('visibilitychange')) // still visible: nothing yet
    await vi.advanceTimersByTimeAsync(0)
    expect(posts).toEqual([])
    document.visibilityState = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(posts).toEqual([[{ tod: 'night' }, true]])
    await vi.advanceTimersByTimeAsync(SAVE_DELAY)
    expect(posts).toHaveLength(1) // the debounced save went with the flush, not after it
    saver.edit({ ...pending.current(), clouds: 'cumulus' })
    page.dispatchEvent(new Event('pagehide'))
    await vi.advanceTimersByTimeAsync(0)
    expect(posts[1]).toEqual([{ clouds: 'cumulus' }, true])
    page.dispatchEvent(new Event('pagehide'))
    await vi.advanceTimersByTimeAsync(0)
    expect(posts).toHaveLength(2) // nothing unsaved, nothing sent
    saver.edit({ ...pending.current(), fuel: 6000 })
    detach() // the menu unmounting
    await vi.advanceTimersByTimeAsync(0)
    expect(posts[2]).toEqual([{ fuel: 6000 }, true])
    saver.edit({ ...pending.current(), fuel: 7000 })
    page.dispatchEvent(new Event('pagehide'))
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(posts).toHaveLength(3) // detached: the page's events are no longer heard
  })
})

// The saves in turn (#236, #253, #275): config_save takes nothing from a save
// numbered below one its page already had taken, and otherwise each key a
// save carries unless the same page last saved it under a later number; a key
// another page saved last is taken, the later save winning.
describe('the saves in turn', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  // The server behind the posts, ordering each key as config_save does.
  function storage() {
    const values: Partial<MissionConfig> = {}
    const last: Record<string, { session: string; sequence: number }> = {}
    // Each page's highest save number taken, by key.
    const saves: Record<string, number> = {}
    const take = (config: Partial<MissionConfig>, label: Label) => {
      for (const [key, value] of Object.entries(config)) {
        const mark = label.session + '\n' + key
        saves[mark] = Math.max(saves[mark] ?? -1, label.sequence)
        if (saves[mark] > label.sequence) continue
        const before = last[key]
        if (before && before.session === label.session && label.sequence < before.sequence) continue
        ;(values as Record<string, unknown>)[key] = value
        last[key] = { session: label.session, sequence: label.sequence }
      }
    }
    return { values, take }
  }

  // A page's poster whose answers the test gives: answer has the server take
  // a post, if it has not yet, and answers it; take only has it taken, for an
  // answer that comes back late; refuse fails it untaken.
  function holding(store = storage()) {
    const posts: [Partial<MissionConfig>, boolean][] = []
    const takes: (() => void)[] = []
    const answers: ((taken: boolean) => void)[] = []
    const pending = new PendingConfig(DEFAULT_CONFIG)
    const saver = new Saver(
      pending,
      (config, keepalive, label) =>
        new Promise((resolve) => {
          posts.push([config, keepalive])
          let taken = false
          takes.push(() => {
            if (!taken) store.take(config, label)
            taken = true
          })
          answers.push(resolve)
        })
    )
    const take = async (index: number) => {
      takes[index]()
      await vi.advanceTimersByTimeAsync(0)
    }
    const answer = async (index: number) => {
      takes[index]()
      answers[index](true)
      await vi.advanceTimersByTimeAsync(0)
    }
    const refuse = async (index: number) => {
      answers[index](false)
      await vi.advanceTimersByTimeAsync(0)
    }
    saver.load({ signed: true, saved: { callsign: 'Little Nellie' } })
    return { posts, pending, saver, server: store.values, store, take, answer, refuse }
  }

  it('send a save only once the one before it has answered, carrying the edits made meanwhile', async () => {
    vi.useFakeTimers()
    const { posts, pending, saver, server, answer } = holding()
    saver.edit({ ...pending.current(), tod: 'night' })
    await vi.advanceTimersByTimeAsync(SAVE_DELAY)
    saver.edit({ ...pending.current(), tod: 'day', clouds: 'cumulus' })
    await vi.advanceTimersByTimeAsync(SAVE_DELAY)
    expect(posts).toEqual([[{ tod: 'night' }, false]]) // the second waits for the first
    await answer(0)
    expect(posts).toEqual([
      [{ tod: 'night' }, false],
      [{ tod: 'day', clouds: 'cumulus' }, false],
    ])
    await answer(1)
    expect(server).toMatchObject({ tod: 'day', clouds: 'cumulus' })
    expect(pending.partial()).toEqual({})
  })

  for (const [order, first, second] of [
    ['the flush first', 1, 0],
    ['the save first', 0, 1],
  ] as const) {
    it(`send a flush at once over a save still out, and nothing again once both have answered, ${order}`, async () => {
      vi.useFakeTimers()
      const { posts, pending, saver, server, answer } = holding()
      const page = new EventTarget()
      saver.attach(page, Object.assign(new EventTarget(), { visibilityState: 'visible' }))
      saver.edit({ ...pending.current(), tod: 'night', fuel: 6000 })
      await vi.advanceTimersByTimeAsync(SAVE_DELAY)
      saver.edit({ ...pending.current(), tod: 'day' })
      page.dispatchEvent(new Event('pagehide'))
      // The page may be going: the flush goes now, kept alive, with every key unsaved.
      expect(posts).toEqual([
        [{ tod: 'night', fuel: 6000 }, false],
        [{ tod: 'day', fuel: 6000 }, true],
      ])
      await answer(first)
      await answer(second)
      // The server keeps the flush, the page's later save, whichever it took last.
      expect(server).toMatchObject({ tod: 'day', fuel: 6000 })
      expect(pending.partial()).toEqual({})
      await vi.advanceTimersByTimeAsync(SAVE_DELAY)
      expect(posts).toHaveLength(2)
    })
  }

  for (const [order, first, second] of [
    ['the flush taken last', 0, 1],
    ['the save taken last', 1, 0],
  ] as const) {
    it(`leave the server on a value changed back while a flush was out over a save, ${order}`, async () => {
      vi.useFakeTimers()
      const { posts, pending, saver, server, answer } = holding()
      const page = new EventTarget()
      saver.attach(page, Object.assign(new EventTarget(), { visibilityState: 'visible' }))
      saver.edit({ ...pending.current(), tod: 'night' })
      await vi.advanceTimersByTimeAsync(SAVE_DELAY)
      saver.edit({ ...pending.current(), tod: 'day' })
      page.dispatchEvent(new Event('pagehide'))
      // The page stays, and the player goes back to night before either
      // answers: the older save carried night too, but not this edit.
      saver.edit({ ...pending.current(), tod: 'night' })
      await answer(first)
      await answer(second)
      expect(server.tod).toBe('day')
      expect(pending.partial()).toEqual({ tod: 'night' })
      await vi.advanceTimersByTimeAsync(SAVE_DELAY)
      expect(posts[2]).toEqual([{ tod: 'night' }, false])
      await answer(2)
      expect(server.tod).toBe('night')
      expect(pending.partial()).toEqual({})
    })
  }

  it('send the keys of a flush that failed again, in turn, while the page stays', async () => {
    vi.useFakeTimers()
    const { posts, pending, saver, server, answer, refuse } = holding()
    const page = new EventTarget()
    saver.attach(page, Object.assign(new EventTarget(), { visibilityState: 'visible' }))
    saver.edit({ ...pending.current(), fuel: 6000 })
    await vi.advanceTimersByTimeAsync(SAVE_DELAY)
    saver.edit({ ...pending.current(), tod: 'night' })
    page.dispatchEvent(new Event('pagehide')) // the flush goes beside the save
    expect(posts[1]).toEqual([{ fuel: 6000, tod: 'night' }, true])
    await refuse(1)
    expect(posts).toHaveLength(2) // waiting for the save still out
    await answer(0)
    expect(posts[2]).toEqual([{ tod: 'night' }, false]) // fuel went with the save
    await answer(2)
    expect(server).toMatchObject({ fuel: 6000, tod: 'night' })
    expect(pending.partial()).toEqual({})
    // A flush alone that failed goes again at once.
    saver.edit({ ...pending.current(), clouds: 'cumulus' })
    page.dispatchEvent(new Event('pagehide'))
    await refuse(3)
    expect(posts[4]).toEqual([{ clouds: 'cumulus' }, false])
  })

  it('seed a fresh account with the edits made while the seed waited behind a save', async () => {
    vi.useFakeTimers()
    const posts: Partial<MissionConfig>[] = []
    const answers: (() => void)[] = []
    const pending = new PendingConfig(DEFAULT_CONFIG)
    const saver = new Saver(
      pending,
      (config) =>
        new Promise((resolve) => {
          posts.push(config)
          answers.push(() => resolve(true))
        })
    )
    saver.edit({ ...pending.current(), world: 'https://w.example' })
    await vi.advanceTimersByTimeAsync(SAVE_DELAY)
    saver.load({ signed: true, saved: null }) // the seed waits for the save
    saver.edit({ ...pending.current(), tod: 'night' })
    answers[0]()
    await vi.advanceTimersByTimeAsync(0)
    expect(posts[1]).toMatchObject({ world: 'https://w.example', tod: 'night' })
    answers[1]()
    await vi.advanceTimersByTimeAsync(SAVE_DELAY)
    expect(pending.partial()).toEqual({})
    expect(posts).toHaveLength(2) // the seed carried the edit, so nothing goes after it
  })

  it("send nothing again after a flush over a save still out, so another page's later save stands", async () => {
    vi.useFakeTimers()
    const store = storage()
    const one = holding(store)
    const two = holding(store)
    const page = new EventTarget()
    one.saver.attach(page, Object.assign(new EventTarget(), { visibilityState: 'visible' }))
    one.saver.edit({ ...one.pending.current(), fuel: 6000 })
    await vi.advanceTimersByTimeAsync(SAVE_DELAY)
    page.dispatchEvent(new Event('pagehide')) // the player goes to the other tab
    expect(one.posts).toHaveLength(2)
    await one.take(0)
    await one.take(1)
    two.saver.edit({ ...two.pending.current(), fuel: 7000 })
    await vi.advanceTimersByTimeAsync(SAVE_DELAY)
    await two.answer(0)
    expect(store.values.fuel).toBe(7000)
    // The first tab's answers come back late, on a slow link.
    await one.answer(0)
    await one.answer(1)
    await vi.advanceTimersByTimeAsync(SAVE_DELAY)
    expect(one.posts).toHaveLength(2)
    expect(one.pending.partial()).toEqual({})
    expect(store.values.fuel).toBe(7000)
  })

  it('seed a fresh account only once a save made before the load has answered', async () => {
    vi.useFakeTimers()
    const posts: Partial<MissionConfig>[] = []
    const answers: (() => void)[] = []
    const pending = new PendingConfig(DEFAULT_CONFIG)
    const saver = new Saver(
      pending,
      (config) =>
        new Promise((resolve) => {
          posts.push(config)
          answers.push(() => resolve(true))
        })
    )
    saver.edit({ ...pending.current(), world: 'https://w.example' })
    await vi.advanceTimersByTimeAsync(SAVE_DELAY)
    const whole = saver.load({ signed: true, saved: null })
    expect(posts).toEqual([{ world: 'https://w.example' }])
    answers[0]()
    await vi.advanceTimersByTimeAsync(0)
    expect(posts).toEqual([{ world: 'https://w.example' }, whole])
  })
})

// A pilot secret from before per-server tokens (#102) was crypto.randomUUID(),
// sent as the token itself to every world server entered: any of them holds
// it, and could work out every token made from it.
describe('a disclosed pilot secret', () => {
  const uuid = '3f2a9c1e-7b4d-4e8a-9c0f-1a2b3c4d5e6f'
  const posting = () => {
    const posts: [Partial<MissionConfig>, boolean][] = []
    const pending = new PendingConfig(DEFAULT_CONFIG)
    const saver = new Saver(pending, async (config, keepalive) => {
      posts.push([config, keepalive])
      return true
    })
    return { posts, pending, saver }
  }

  it('is one of the shape randomUUID gives, and never a minted one', () => {
    expect(disclosed(uuid)).toBe(true)
    expect(disclosed(uuid.toUpperCase())).toBe(true)
    expect(disclosed(crypto.randomUUID())).toBe(true)
    expect(disclosed('3f2a9c1e7b4d4e8a9c0f1a2b3c4d5e6f')).toBe(false) // pilot_mint's 32 hex digits
    expect(disclosed('')).toBe(false)
    expect(disclosed(undefined)).toBe(false)
  })

  it('is blanked as the saved config is applied, and the blank is saved', async () => {
    const { posts, saver } = posting()
    const whole = saver.load({ signed: true, saved: { callsign: 'Goose', pilot: uuid } })
    expect(whole?.pilot).toBe('')
    expect(whole?.callsign).toBe('Goose')
    expect(posts).toEqual([[{ pilot: '' }, false]])
    const minted = posting()
    expect(minted.saver.load({ signed: true, saved: { pilot: 'a'.repeat(32) } })?.pilot).toBe('a'.repeat(32))
    expect(minted.posts).toEqual([]) // a secret of the new shape stands, and nothing is sent
  })

  it('is blanked under an edit made while loading, and the blank goes with the edit', () => {
    const { posts, pending, saver } = posting()
    saver.edit({ ...pending.current(), tod: 'night' })
    const whole = saver.load({ signed: true, saved: { pilot: uuid } })
    expect(whole?.pilot).toBe('')
    expect(posts).toEqual([[{ tod: 'night', pilot: '' }, false]])
  })

  it('is blanked in the cache of a player no one signed in as, with nothing sent', () => {
    const posts: unknown[] = []
    const pending = new PendingConfig({ ...DEFAULT_CONFIG, pilot: uuid })
    const saver = new Saver(pending, async (config) => {
      posts.push(config)
      return true
    })
    expect(saver.load({ signed: false, saved: null })?.pilot).toBe('')
    expect(posts).toEqual([])
    const plain = new Saver(new PendingConfig(DEFAULT_CONFIG), async () => true)
    expect(plain.load({ signed: false, saved: null })).toBeNull() // nothing to blank: the cache shown stays
  })
})

// A visitor no one signed in as, on a browser an account last used (#242): the
// cache is that account's, so its own settings are not the visitor's.
describe('a visitor no one signed in as', () => {
  const cached = {
    ...DEFAULT_CONFIG,
    pilot: 'a'.repeat(32),
    callsign: 'Maverick',
    world: 'https://w.example',
    servers: 'https://w.example\nhttps://v.example',
    sharing: false,
    tod: 'night',
    joystick: 'pad',
    render_scale: 0.6,
  } as MissionConfig
  const anonymous = { signed: false, saved: null }
  const quiet = (pending: PendingConfig, posts: unknown[] = []) =>
    new Saver(pending, async (config) => {
      posts.push(config)
      return true
    })

  it("is shown the cache without the account's own settings, and nothing is sent", () => {
    const posts: unknown[] = []
    const pending = new PendingConfig(cached)
    const shown = quiet(pending, posts).load(anonymous)
    expect(shown).toMatchObject({ pilot: '', callsign: '', world: '', servers: '', tod: 'night', joystick: 'pad', render_scale: 0.6 })
    expect(shown && 'sharing' in shown).toBe(false)
    expect(pending.current()).toBe(shown)
    expect(posts).toEqual([])
  })

  it('keeps an edit the visitor made while loading', () => {
    const pending = new PendingConfig(cached)
    const saver = quiet(pending)
    saver.edit({ ...pending.current(), callsign: 'Goose' })
    expect(saver.load(anonymous)).toMatchObject({ callsign: 'Goose', pilot: '', servers: '' })
  })

  it("leaves the account's next load to take them from the server again", () => {
    // What the visitor was shown is what the cache holds when the account signs in again.
    const shown = quiet(new PendingConfig(cached)).load(anonymous) ?? cached
    const saved = { pilot: cached.pilot, callsign: 'Maverick', world: cached.world, servers: cached.servers, sharing: false }
    expect(quiet(new PendingConfig(shown)).load({ signed: true, saved })).toMatchObject(saved)
    const pending = new PendingConfig(shown)
    const edited = quiet(pending)
    edited.edit({ ...pending.current(), tod: 'day' })
    expect(edited.load({ signed: true, saved })).toMatchObject({ ...saved, tod: 'day' })
  })
})

// A load that fails for a signed-in player is not an answer (#229): the cache
// may be another account's, so it stays unsettled and asks again.
describe('a failed load', () => {
  it('reads as anonymous only for a 401 to a request with no token, outside the shell', () => {
    expect(anonymous(401, '', false)).toBe(true)
    expect(anonymous(401, 'token', false)).toBe(false) // a token refused
    expect(anonymous(401, '', true)).toBe(false) // the shell frames signed-in players only; its token is on its way
    expect(anonymous(500, '', false)).toBe(false)
    expect(anonymous(undefined, '', false)).toBe(false) // the network
  })

  it('is asked again, waiting longer each time, until it answers', async () => {
    const answers: (null | { signed: boolean; saved: null })[] = [null, null, null, { signed: true, saved: null }]
    const waits: number[] = []
    const answer = await ask(
      async () => answers.shift() ?? null,
      () => false,
      async (milliseconds) => {
        waits.push(milliseconds)
      }
    )
    expect(answer).toEqual({ signed: true, saved: null })
    expect(waits).toEqual(RETRY.slice(0, 3))
  })

  it('waits the last delay from then on', async () => {
    let tries = 0
    const waits: number[] = []
    await ask(
      async () => (++tries > RETRY.length + 2 ? { signed: false, saved: null } : null),
      () => false,
      async (milliseconds) => {
        waits.push(milliseconds)
      }
    )
    expect(waits.slice(-3)).toEqual([RETRY[RETRY.length - 1], RETRY[RETRY.length - 1], RETRY[RETRY.length - 1]])
  })

  it('stops asking once the hook has gone, but keeps an answer already on its way', async () => {
    let stopped = false
    let tries = 0
    const gone = await ask(
      async () => {
        tries++
        return null
      },
      () => stopped,
      async () => {
        stopped = true
      }
    )
    expect(gone).toBeNull()
    expect(tries).toBe(1)
    expect(await ask(async () => ({ signed: true, saved: null }), () => true)).toEqual({ signed: true, saved: null })
  })
})

// The hook (config-store.ts) is a thin shell over Saver, read as text: React
// hooks need a renderer this suite does not have.
describe('the config hook', () => {
  const hook = readFileSync(fileURLToPath(new URL('./config-store.ts', import.meta.url)), 'utf8')

  it('settles once config/load has answered, and asks again while it fails (#96, #229)', () => {
    expect(hook).toMatch(/ask\(loadConfig, \(\) => stopped\)\.then\(\(answer\) => \{\s*if \(!answer\) return\s*const whole = saver\.load\(answer\)\s*if \(whole\) setStored\(whole\)\s*setSettled\(true\)/)
    expect(hook).toMatch(/catch \(problem\) \{\s*const status = isHttpError\(problem\) \? problem\.response\?\.status : undefined\s*return anonymous\(status, useAuthStore\.getState\(\)\.token, isInShell\(\)\)\s*\? \{ signed: false, saved: null \}\s*: null/) // only an anonymous failure answers
    expect(hook).toMatch(/return \(\) => \{\s*stopped = true\s*detach\(\)/)
    expect(hook).toMatch(/return \[config, setConfig, settled\]/)
  })

  it('flushes when the page hides or goes away and when it unmounts (#105)', () => {
    expect(hook).toMatch(/const detach = saver\.attach\(window, document\)/)
  })

  it('sends a save kept alive when asked (#105), under the label the saver gives it (#245, #253)', () => {
    expect(hook).toMatch(/config: JSON\.stringify\(config\),\s*identity: label\.identity,\s*session: label\.session,\s*sequence: String\(label\.sequence\),\s*\},\s*\{ keepalive \}/)
    expect(hook).toMatch(/new Saver\(\s*pending,\s*saveConfig,\s*undefined,\s*\(\) => config_identity,/)
    expect(hook).toMatch(/\{ keepalive \}\s*\)\s*return answered\(res\)\s*\} catch \{\s*return false/) // the answer is read by answered, below
  })
})

// What config/save answers, as the app client hands it back: the body, with
// or without the {data: ...} the response handling may already have taken off.
describe("a save's answer", () => {
  it('is taken, with nothing kept, when the server took the save as sent', () => {
    expect(answered({ data: { saved: true, kept: {} } })).toEqual({ kept: {} })
    expect(answered({ saved: true, kept: {} })).toEqual({ kept: {} })
  })

  it('carries the pilot secret the server kept, enveloped or not', () => {
    const stored = 'b'.repeat(32)
    expect(answered({ data: { saved: true, kept: { pilot: stored } } })).toEqual({ kept: { pilot: stored } })
    expect(answered({ saved: true, kept: { pilot: stored } })).toEqual({ kept: { pilot: stored } })
  })

  it('keeps nothing that is not a secret', () => {
    for (const kept of [{ pilot: 5 }, { pilot: null }, { pilot: { a: 1 } }, null, 'b', 7, undefined])
      expect(answered({ data: { saved: true, kept } })).toEqual({ kept: {} })
  })

  it('is not taken when it does not say the save was', () => {
    // A page the SPA catch-all served, a body with no saved flag, or none at all.
    for (const raw of ['<!doctype html><html></html>', { data: { kept: {} } }, { data: { saved: false } }, { data: null }, { saved: 'true' }, null, undefined, 3])
      expect(answered(raw)).toBe(false)
  })
})

// What a save goes under (#245, #253) and what its answer may carry (#254).
describe('the label on a save and its answer', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function labelled(
    owner: { identity: string },
    taken: (config: Partial<MissionConfig>) => Taken = () => true,
    show?: (config: MissionConfig) => void
  ) {
    const posts: [Partial<MissionConfig>, boolean, Label][] = []
    const answers: (() => void)[] = []
    const shown: MissionConfig[] = []
    const pending = new PendingConfig(DEFAULT_CONFIG)
    const saver = new Saver(
      pending,
      (config, keepalive, label) =>
        new Promise((resolve) => {
          posts.push([config, keepalive, label])
          answers.push(() => resolve(taken(config)))
        }),
      SAVE_DELAY,
      () => owner.identity,
      show ?? ((config) => shown.push(config))
    )
    const reply = async (index: number) => {
      answers[index]()
      await vi.advanceTimersByTimeAsync(0)
    }
    return { posts, pending, saver, shown, reply }
  }

  it('go under the account they were queued under, not the one current when they are sent', async () => {
    vi.useFakeTimers()
    const owner = { identity: 'alice' }
    const { posts, pending, saver, reply } = labelled(owner)
    saver.load({ signed: true, saved: { callsign: 'Goose' } })
    saver.edit({ ...pending.current(), tod: 'night' })
    await vi.advanceTimersByTimeAsync(SAVE_DELAY)
    saver.edit({ ...pending.current(), clouds: 'cumulus' })
    await vi.advanceTimersByTimeAsync(SAVE_DELAY) // queued behind the first, under alice
    owner.identity = 'bob' // an in-place switch answers a new config/load
    await reply(0)
    expect(posts.map(([config, , label]) => [config, label.identity])).toEqual([
      [{ tod: 'night' }, 'alice'],
      [{ clouds: 'cumulus' }, 'alice'], // the server refuses it, as bob's session
    ])
  })

  it('send a failed flush again under the account it went under', async () => {
    vi.useFakeTimers()
    const owner = { identity: 'alice' }
    let refused = 1
    const { posts, pending, saver, reply } = labelled(owner, () => refused-- <= 0)
    saver.load({ signed: true, saved: { callsign: 'Goose' } })
    const page = new EventTarget()
    saver.attach(page, Object.assign(new EventTarget(), { visibilityState: 'visible' }))
    saver.edit({ ...pending.current(), tod: 'night' })
    page.dispatchEvent(new Event('pagehide'))
    owner.identity = 'bob' // an in-place switch while the flush is out
    await reply(0) // refused: the flush's keys go again
    expect(posts.map(([config, , label]) => [config, label.identity])).toEqual([
      [{ tod: 'night' }, 'alice'],
      [{ tod: 'night' }, 'alice'],
    ])
  })

  it('number the saves of one page, so a flush over a save still out is the newer', async () => {
    vi.useFakeTimers()
    const { posts, pending, saver } = labelled({ identity: 'alice' })
    saver.load({ signed: true, saved: { callsign: 'Goose' } })
    const page = new EventTarget()
    saver.attach(page, Object.assign(new EventTarget(), { visibilityState: 'visible' }))
    saver.edit({ ...pending.current(), tod: 'night' })
    await vi.advanceTimersByTimeAsync(SAVE_DELAY)
    saver.edit({ ...pending.current(), tod: 'day' })
    page.dispatchEvent(new Event('pagehide'))
    const [[, , save], [, , flush]] = posts
    expect(save.session).toMatch(/^[0-9a-f]{24}$/)
    expect(flush.session).toBe(save.session)
    expect(flush.sequence).toBeGreaterThan(save.sequence) // the server keeps the flush, whichever it takes last
    const other = labelled({ identity: 'alice' })
    other.saver.load({ signed: true, saved: null })
    expect(other.posts[0][2].session).not.toBe(save.session) // another page is ordered by time
  })

  it('adopt the pilot secret the server kept over the one sent, and send it no more', async () => {
    vi.useFakeTimers()
    const stored = 'b'.repeat(32)
    const { posts, pending, saver, shown, reply } = labelled({ identity: 'alice' }, (config) =>
      'pilot' in config ? { kept: { pilot: stored } } : true
    )
    saver.load({ signed: true, saved: { callsign: 'Goose' } })
    // This tab minted on entering a server, after another tab had.
    saver.edit({ ...pending.current(), pilot: 'a'.repeat(32), world: 'https://w.example' })
    await vi.advanceTimersByTimeAsync(SAVE_DELAY)
    await reply(0)
    expect(pending.current().pilot).toBe(stored)
    expect(shown[shown.length - 1]?.pilot).toBe(stored)
    expect(pending.partial()).toEqual({})
    saver.edit({ ...pending.current(), tod: 'night' })
    await vi.advanceTimersByTimeAsync(SAVE_DELAY)
    expect(posts[1][0]).toEqual({ tod: 'night' })
  })

  it('go on once an answer has been handled, even when handling it throws', async () => {
    vi.useFakeTimers()
    const stored = 'b'.repeat(32)
    const { posts, pending, saver, reply } = labelled(
      { identity: 'alice' },
      (config) => ('pilot' in config ? { kept: { pilot: stored } } : true),
      () => {
        throw new Error('the cache would not take it')
      }
    )
    saver.load({ signed: true, saved: { callsign: 'Goose' } })
    saver.edit({ ...pending.current(), pilot: 'a'.repeat(32) })
    await vi.advanceTimersByTimeAsync(SAVE_DELAY)
    saver.edit({ ...pending.current(), tod: 'night' })
    await vi.advanceTimersByTimeAsync(SAVE_DELAY) // queued behind the first
    await reply(0)
    expect(pending.current().pilot).toBe(stored)
    expect(posts[1]?.[0]).toEqual({ tod: 'night' })
  })

  it('adopt the secret another tab minted in place of the blank this one owed', async () => {
    vi.useFakeTimers()
    const minted = 'c'.repeat(32)
    const { posts, pending, saver, reply } = labelled({ identity: 'alice' }, () => ({ kept: { pilot: minted } }))
    saver.load({ signed: true, saved: { pilot: '3f2a9c1e-7b4d-4e8a-9c0f-1a2b3c4d5e6f' } })
    expect(posts[0][0]).toEqual({ pilot: '' })
    await reply(0)
    expect(pending.current().pilot).toBe(minted)
    expect(pending.partial()).toEqual({})
  })
})
