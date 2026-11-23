// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
// The mission config's persistence, isolated from the React hook so it is unit
// testable. On config/load: no account (anonymous) -> KEEP what is shown, less
// the last account's own settings (ACCOUNT), an
// edit made while it was in flight -> FLUSH (apply it onto the saved config, or
// the seed on a fresh account, and persist it), a saved config -> APPLY,
// nothing saved -> SEED the server from local. A load that failed is no
// answer: it is asked again, and until one comes the account is unknown.
import { migrate, normalize } from '../game/stores'
import { DEFAULT_CONFIG, type MissionConfig } from './config'

export type LoadOutcome = 'keep' | 'flush' | 'apply' | 'seed'

export function loadOutcome(
  dirty: boolean,
  saved: Partial<MissionConfig> | null,
  signed = true
): LoadOutcome {
  if (!signed) return 'keep'
  if (dirty) return 'flush'
  return saved ? 'apply' : 'seed'
}

// Answer is what config/load came back with: whether it named the account the
// config belongs to, and that account's saved keys (null when none are).
export interface Answer {
  signed: boolean
  saved: Partial<MissionConfig> | null
}

// anonymous is whether a config/load that failed said no one is signed in: a
// 401 to a request that carried no token, outside the menu shell, which frames
// only signed-in players. Anything else - the network, the server, a token
// refused, the shell's token still on its way - leaves the account unknown, and
// the cache is not read as this player's.
export function anonymous(
  status: number | undefined,
  token: string,
  shell: boolean
): boolean {
  return status === 401 && !token && !shell
}

// RETRY is how long each failed config/load waits before the next, in
// milliseconds; the last repeats.
export const RETRY = [1000, 2000, 5000, 10000, 30000]

// ask asks config/load until it answers (load gives null for a failure),
// waiting RETRY between the tries, and gives up with null once stopped (the
// hook unmounted). A load under way when it stops still answers.
export async function ask(
  load: () => Promise<Answer | null>,
  stopped: () => boolean,
  wait: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds))
): Promise<Answer | null> {
  for (let attempt = 0; ; attempt++) {
    const answer = await load()
    if (answer) return answer
    if (stopped()) return null
    await wait(RETRY[Math.min(attempt, RETRY.length - 1)])
    if (stopped()) return null
  }
}

// A pilot secret in the shape crypto.randomUUID() gives: the secret from
// before per-server tokens, which went verbatim to every world server the
// account entered, so each of them holds it. pilot_mint's are 32 hex digits.
const DISCLOSED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function disclosed(pilot: unknown): boolean {
  return typeof pilot === 'string' && DISCLOSED.test(pilot)
}

// Settings that no longer exist but whose saved VALUES still arrive: the
// per-account config keeps every key ever written. Retiring a setting means
// three things - delete the control, delete the reads, and add the key here so
// the stored value stops travelling.
export const RETIRED = ['missiles', 'sens'] as const

// stripRetired returns the saved config without any retired key. It copies
// rather than mutating: the caller reads `missiles` to migrate the loadout, and
// a mutating strip would pull that value out from under it.
export function stripRetired<T extends Record<string, unknown>>(saved: T): T {
  const out = { ...saved }
  for (const key of RETIRED) delete out[key]
  return out
}

// The bandit tiers' former names: a config saved while the intermediate was
// called the pilot and the expert the ace still names them so.
const TIERS = new Map<string, MissionConfig['bandit']>([
  ['pilot', 'intermediate'],
  ['ace', 'expert'],
])

// absorb turns what config/load returned into a whole config: the defaults
// under it, every retired key gone, the stores map normalized (a legacy save
// carries the retired missiles boolean and no stores map, and migrates to the
// matching preset, #17), and a bandit saved under a tier's former name renamed.
// Read `missiles` BEFORE stripping: it still decides the preset, and
// stripRetired copies, so it survives here.
export function absorb(saved: Partial<MissionConfig>): MissionConfig {
  const legacy = saved as Partial<MissionConfig> & { missiles?: boolean }
  const stores = normalize(legacy.stores ?? migrate(legacy.missiles !== false))
  const kept = stripRetired(legacy) as Partial<MissionConfig>
  const bandit = TIERS.get(String(kept.bandit))
  if (bandit) kept.bandit = bandit
  return { ...DEFAULT_CONFIG, ...kept, stores } as MissionConfig
}

// The settings a new account takes from the browser it first signs in on: the
// device's own - its sticks and their bindings, the keys, the sound and the
// graphics, the fields of the Controls, Keys, Sound and Graphics tabs
// (TAB_FIELDS in lib/config.ts). The browser's cache is not keyed by account,
// so on a shared browser everything else in it is the last account's: its
// pilot secret (which owns that account's match offers), callsign, server,
// recent servers and answer on sharing. A setting added later is left out
// until it is named here.
export const DEVICE: readonly (keyof MissionConfig)[] = [
  'joystick',
  'sticks',
  'keys',
  'sound',
  'volume',
  'render_scale',
  'dyn_res',
  'shadows',
  'exterior_detail',
  'effects_quality',
  'ocean_segments',
  'afterburner',
  'tracers',
  'framerate',
]

// The settings in the cache that are the account's own, named above: a visitor
// no one signed in as is shown the cache without them.
export const ACCOUNT: readonly (keyof MissionConfig)[] = [
  'pilot',
  'callsign',
  'world',
  'servers',
  'sharing',
]

// visitor is the config shown to a visitor no one signed in as: `config` with
// every ACCOUNT setting at its default, and sharing unasked.
export function visitor(config: MissionConfig): MissionConfig {
  const out: Record<string, unknown> = { ...config }
  for (const key of ACCOUNT) {
    if (key in DEFAULT_CONFIG) out[key] = DEFAULT_CONFIG[key]
    else delete out[key]
  }
  return out as MissionConfig
}

// seeded is what the first save on an account with nothing stored writes: the
// defaults, with the device settings of the config in memory.
export function seeded(config: MissionConfig): MissionConfig {
  const out: Record<string, unknown> = { ...DEFAULT_CONFIG }
  for (const key of DEVICE) if (config[key] !== undefined) out[key] = config[key]
  return out as MissionConfig
}

// merged is what a flush persists: the saved config (or, on a fresh account,
// the seed of `current`, the config in memory, which keeps the device's
// settings) with the keys edited while it was loading laid on top. Never the
// in-memory config wholesale - on a fresh or top-window load that is the
// defaults, and saving it clobbered every setting the account had (#41: a
// server deep link entered the server at boot, and the callsign, the weather
// and everything else went back to their defaults on every visit).
export function merged(
  saved: Partial<MissionConfig> | null,
  partial: Partial<MissionConfig>,
  current: MissionConfig = DEFAULT_CONFIG
): MissionConfig {
  return {
    ...(saved ? absorb(saved) : seeded(current)),
    ...partial,
  } as MissionConfig
}

// PendingConfig bundles the latest edited config, the keys those edits touched
// and the dirty flag so an edit updates ALL of them synchronously. A React ref
// only refreshes on render, so a config/load resolving between an edit and its
// commit would flush a stale value; and the keys are what a flush applies onto
// the saved config, since the in-memory config an early edit was made on may
// be nothing but the defaults. The keys are also what every save sends: those
// edited since the last save that succeeded.
export class PendingConfig {
  private value: MissionConfig
  private edits: Partial<MissionConfig> = {}
  // When each key was last edited, in a count of edits: a save notes it for
  // the keys it carries, and its answer spends a key only if no edit came
  // since. Compared by value instead, a key changed and changed back while a
  // save was out read as spent, though a later save had carried the change.
  private stamps: Record<string, number> = {}
  private clock = 0
  dirty = false

  constructor(initial: MissionConfig) {
    this.value = initial
  }

  // edit records a user change; current() reflects it immediately, before the
  // render that would otherwise sync it. The keys whose value changed are
  // kept as the partial a flush applies.
  edit(next: MissionConfig): void {
    for (const key of Object.keys(next) as (keyof MissionConfig)[]) {
      if (next[key] !== this.value[key]) {
        ;(this.edits as Record<string, unknown>)[key] = next[key]
        this.stamps[key] = ++this.clock
      }
    }
    this.dirty = true
    this.value = next
  }

  // partial is what the edits not yet saved changed.
  partial(): Partial<MissionConfig> {
    return { ...this.edits }
  }

  // stamp is when each of the keys given was last edited, noted by a save
  // that carries them for spend.
  stamp(keys: string[]): Record<string, number> {
    return Object.fromEntries(keys.map((key) => [key, this.stamps[key] ?? 0]))
  }

  // spend forgets the edits a save carried, once it succeeded, by the stamps
  // noted as it went. A key edited again while the save was out keeps its
  // edit, which the save did not carry, even when it is back at the value the
  // save did.
  spend(saved: Partial<MissionConfig>, stamps: Record<string, number>): void {
    for (const key of Object.keys(saved)) {
      if ((this.stamps[key] ?? 0) === stamps[key]) delete this.edits[key]
    }
  }

  // adopt takes the values the server kept over the ones it was sent (a
  // stored pilot secret): they are the account's, and an edit of the same key
  // is dropped rather than sent again.
  adopt(kept: Partial<MissionConfig>): void {
    for (const key of Object.keys(kept)) delete (this.edits as Record<string, unknown>)[key]
    this.value = { ...this.value, ...kept } as MissionConfig
  }

  // owe records keys the server is to be sent that no edit of the player's
  // changed, saved with the edits: a disclosed pilot secret's blank.
  owe(partial: Partial<MissionConfig>): void {
    Object.assign(this.edits, partial)
    for (const key of Object.keys(partial)) this.stamps[key] = ++this.clock
  }

  // settle adopts the config a load answered with, the edits merged in: the
  // next sync may follow renders again. The edits stay until a save spends them.
  settle(value: MissionConfig): void {
    this.value = value
    this.dirty = false
  }

  // sync mirrors external/component state (a render). Once the user has edited,
  // their pending value is authoritative, so a later render can't clobber it.
  sync(value: MissionConfig): void {
    if (!this.dirty) this.value = value
  }

  current(): MissionConfig {
    return this.value
  }
}

export const SAVE_DELAY = 600

// Label is what a save is sent under. identity is the account it was queued
// under, read then and not when it goes, so an account that changed in the
// meantime has the server refuse it rather than write one account's edit onto
// another. session names this page and sequence counts its saves, by which the
// server orders two saves of one page that it takes out of turn: a page
// leaving sends its flush beside a save still out.
export interface Label {
  identity: string
  session: string
  sequence: number
}

// Taken is what a post answers: whether the server took the save, or that it
// took it and kept its own value of the keys named (a stored pilot secret).
export type Taken = boolean | { kept: Partial<MissionConfig> }

// Outgoing is what one post carries: config, the keys it sets, and fill, the
// keys it stores only where the account has no value yet: a seed's defaults
// and this device's settings, which must not overwrite what another page
// saved since.
interface Outgoing {
  config: Partial<MissionConfig>
  fill?: Partial<MissionConfig>
}

// unwrap is an action's answer: the app client hands back the body, which the
// response handling may or may not have taken out of its {data: ...}.
export const unwrap = <T>(raw: unknown): T =>
  raw && typeof raw === 'object' && 'data' in raw
    ? (raw as { data: T }).data
    : (raw as T)

// answered reads what config/save answered. A save it took says so, with the
// pilot secret it kept over the one sent when it kept one, to adopt; it
// refuses any other with an error, which never reaches here.
export function answered(raw: unknown): Taken {
  const body = unwrap<{ saved?: unknown; kept?: { pilot?: unknown } } | null>(raw)
  if (!body || typeof body !== 'object' || body.saved !== true) return false
  const pilot = body.kept?.pilot
  return { kept: typeof pilot === 'string' ? { pilot } : {} }
}

// page_session is a page's name for its saves: 96 random bits as hex.
export function page_session(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

// Saver sends the player's edits to the server: SAVE_DELAY after they pause,
// so dragging a slider does not spam it, and at once when the page hides or
// goes away. A save carries only the keys edited since the last save that
// succeeded: the server stamps each key it is sent, so a whole config from a
// tab that loaded earlier wrote its stale value of every key it had not
// touched. The saves go one at a time, each once the one before it has
// answered, and each is numbered (Label): two out at once are taken in either
// order, and the server keeps the newer by its number. post answers whether
// the server took the save. owner is the account a save is queued under, and
// shown is told the config when the server keeps a value over the one sent.
export class Saver {
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly pending: PendingConfig
  private readonly post: (
    config: Partial<MissionConfig>,
    keepalive: boolean,
    label: Label,
    fill: Partial<MissionConfig>
  ) => Promise<Taken>
  private readonly delay: number
  private readonly owner: () => string
  private readonly shown: (config: MissionConfig) => void
  private readonly session = page_session()
  private sequence = 0
  // The posts sent and not yet answered, and the sends waiting for them, in
  // the order made.
  private readonly out = new Set<Promise<void>>()
  private readonly waiting: (() => void)[] = []

  constructor(
    pending: PendingConfig,
    post: (
      config: Partial<MissionConfig>,
      keepalive: boolean,
      label: Label,
      fill: Partial<MissionConfig>
    ) => Promise<Taken>,
    delay = SAVE_DELAY,
    owner: () => string = () => '',
    shown: (config: MissionConfig) => void = () => {}
  ) {
    this.pending = pending
    this.post = post
    this.delay = delay
    this.owner = owner
    this.shown = shown
  }

  // edit records a change, and saves once the edits pause.
  edit(next: MissionConfig): void {
    this.pending.edit(next) // records the edit AND the value synchronously
    this.cancel()
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.save()
    }, this.delay)
  }

  // save sends the edits not yet saved, in turn, and spends them once the
  // server has them.
  save(): Promise<void> {
    return this.turn(() => ({ config: this.pending.partial() }), true)
  }

  // flush sends what is unsaved now, as a keepalive request that outlives the
  // page, rather than leave it to a timer the page takes with it.
  flush(): void {
    this.cancel()
    const partial = this.pending.partial()
    if (!Object.keys(partial).length) return
    // Not queued, since a page going away takes a waiting send with it. Sent
    // over a post still out, the server takes the two in either order and
    // keeps the flush, the later of the page's two by number, refusing the
    // older if it lands after; each answer spends only the keys not edited
    // since it went (PendingConfig.spend). A flush that failed while the
    // page stayed goes again in turn as it was, under its own number and
    // spent by its own stamps: the server may have taken it, with only the
    // answer lost, and takes a page's save once, so the second cannot undo
    // another page's save made in between. An edit made since goes in a save
    // of its own, numbered after it.
    const label = this.label(this.owner())
    const stamps = this.pending.stamp(Object.keys(partial))
    void this.send({ config: partial }, true, true, label, stamps).then((taken) => {
      if (!taken) void this.turn(() => ({ config: partial }), true, label, stamps)
    })
  }

  // turn sends what `what` gives once no post is out: at once, or after the
  // posts out and the sends queued before it. It is read as it goes, so it
  // carries the edits made while it waited and none already spent. It goes
  // under the label given, or else the next number and the account current
  // when it was queued.
  private turn(
    what: () => Outgoing,
    spend: boolean,
    label?: Label,
    stamps?: Record<string, number>
  ): Promise<void> {
    const identity = label?.identity ?? this.owner()
    return new Promise((resolve) => {
      const go = () => {
        const outgoing = what()
        if (Object.keys(outgoing.config).length || Object.keys(outgoing.fill ?? {}).length)
          void this.send(outgoing, false, spend, label ?? this.label(identity), stamps).then(() => resolve())
        else resolve()
      }
      if (this.out.size) this.waiting.push(go)
      else go()
    })
  }

  // label is the next number of this page's saves, under the account given.
  private label(identity: string): Label {
    return { identity, session: this.session, sequence: ++this.sequence }
  }

  // send posts `outgoing` under `label`, spends its config once answered if
  // the server took it and `spend` says to, by the stamps the keys carried as
  // it went (or as given, for one sent again), adopts what the server kept
  // over what it was sent, and then starts the sends that were waiting. It
  // answers whether the server took it.
  private send(
    outgoing: Outgoing,
    keepalive: boolean,
    spend: boolean,
    label: Label,
    stamps = this.pending.stamp(Object.keys(outgoing.config))
  ): Promise<boolean> {
    const config = outgoing.config
    let took = false
    const sent: Promise<void> = this.post(config, keepalive, label, outgoing.fill ?? {})
      .then((taken) => {
        took = Boolean(taken)
        if (taken && spend) this.pending.spend(config, stamps)
        const kept = typeof taken === 'object' ? taken.kept : {}
        if (Object.keys(kept).length) {
          this.pending.adopt(kept)
          this.shown(this.pending.current())
        }
      })
      // A post that failed leaves its edits for the next save. A throw in
      // handling an answer must not hold every later save behind this one.
      .catch(() => {})
      .finally(() => {
        this.out.delete(sent)
        while (!this.out.size && this.waiting.length) this.waiting.shift()?.()
      })
    this.out.add(sent)
    return sent.then(() => took)
  }

  private cancel(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  // load settles what config/load answered and sends what that owes the
  // server. It returns the config to show, or null to keep the one shown.
  load(answer: Answer): MissionConfig | null {
    const outcome = loadOutcome(this.pending.dirty, answer.saved, answer.signed)
    if (outcome === 'keep') {
      // No account: nothing is saved, and the cache is the last account's, so
      // the visitor keeps it without that account's own settings, under the
      // edits made on this page. Entering a server then mints the visitor a
      // secret of their own (lobby_enter). The account's next load takes its
      // settings from the server, never from the cache.
      const shown = this.pending.current()
      const kept = { ...visitor(shown), ...this.pending.partial() } as MissionConfig
      const same = Object.keys({ ...shown, ...kept }).every((key) => kept[key] === shown[key])
      this.pending.settle(same ? shown : kept)
      return same ? null : kept
    }
    if (outcome === 'flush') {
      // The player edited while loading: lay the keys they touched onto the
      // SAVED config and send those keys, now the account is known. Not
      // pending.current(): an edit made on a fresh page was made on the
      // defaults, and saving those wholesale clobbered every saved setting
      // (#41). The timer's save would send the same keys: this is it. An
      // account with nothing saved takes the seed under the keys, and is
      // seeded, as a first load with no edit would be.
      this.cancel()
      const whole = this.renew(
        merged(answer.saved, this.pending.partial(), this.pending.current())
      )
      this.pending.settle(whole)
      void (answer.saved ? this.save() : this.seed())
      return whole
    }
    if (outcome === 'apply' && answer.saved) {
      // Every retired key goes, the stores map is normalized, a legacy save
      // migrates its preset: absorb is the one reading of a saved config.
      const whole = this.renew(absorb(answer.saved))
      this.pending.settle(whole)
      void this.save() // what renew owes, if anything
      return whole
    }
    // First run on this account: seed the server.
    const fresh = seeded(this.pending.current())
    this.pending.settle(fresh)
    void this.seed()
    return fresh
  }

  // seed initialises an account with nothing saved, in turn: the edits not
  // yet saved as any save sends them, spent once the server has them, and the
  // defaults with this device's settings as fill, stored only where the
  // account still has no value. Both are read as it goes: queued behind a
  // post, a seed of the config the load answered with wrote back the older
  // value of a key a flush had saved meanwhile, and its defaults overwrote
  // another page's edits.
  private seed(): Promise<void> {
    return this.turn(() => ({ config: this.pending.partial(), fill: seeded(this.pending.current()) }), true)
  }

  // renew blanks a disclosed pilot secret in a config the server answered
  // with and owes the server the blank, before any token is worked out from
  // it: entering a server mints the next (lobby_enter), as it minted the first.
  private renew(whole: MissionConfig): MissionConfig {
    if (!disclosed(whole.pilot)) return whole
    this.pending.owe({ pilot: '' })
    return { ...whole, pilot: '' }
  }

  // attach flushes when the page hides (a hidden visibilitychange) or goes
  // away (pagehide), and the detach it returns flushes as well, for the menu
  // unmounting: a debounced save was cancelled on unmount and died with a
  // closing page, and config/load then put the old value back.
  attach(page: EventTarget, document: EventTarget & { visibilityState: string }): () => void {
    const hide = () => this.flush()
    const visibility = () => {
      if (document.visibilityState === 'hidden') this.flush()
    }
    page.addEventListener('pagehide', hide)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      page.removeEventListener('pagehide', hide)
      document.removeEventListener('visibilitychange', visibility)
      this.flush()
    }
  }
}
