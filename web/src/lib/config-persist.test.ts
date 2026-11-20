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
  DEVICE,
  loadOutcome,
  merged,
  PendingConfig,
  RETIRED,
  SAVE_DELAY,
  Saver,
  seeded,
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
    pending.spend({ servers: '127.0.0.1:4433', pilot: 'p1', tod: 'night' })
    expect(pending.partial()).toEqual({})
    pending.sync(DEFAULT_CONFIG) // settled: renders may sync again
    expect(pending.current()).toBe(DEFAULT_CONFIG)
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
    const out = late.saver.save(false)
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

// The hook (config-store.ts) is a thin shell over Saver, read as text: React
// hooks need a renderer this suite does not have.
describe('the config hook', () => {
  const hook = readFileSync(fileURLToPath(new URL('./config-store.ts', import.meta.url)), 'utf8')

  it('settles once config/load has answered, whatever it answered (#96)', () => {
    expect(hook).toMatch(/loadConfig\(\)\.then\(\(answer\) => \{\s*const whole = saver\.load\(answer\)\s*if \(whole\) setStored\(whole\)\s*setSettled\(true\)/)
    expect(hook).toMatch(/catch \{\s*return \{ signed: false, saved: null \}/) // a failed load answers too
    expect(hook).toMatch(/return \[config, setConfig, settled\]/)
  })

  it('flushes when the page hides or goes away and when it unmounts (#105)', () => {
    expect(hook).toMatch(/return saver\.attach\(window, document\)/)
  })

  it('sends a save kept alive when asked (#105)', () => {
    expect(hook).toMatch(/\{ config: JSON\.stringify\(config\), identity: config_identity \},\s*\{ keepalive \}/)
  })
})
