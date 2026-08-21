// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// Multiplayer networking: lobby helpers, the WebTransport data plane (framed
// control stream, CBOR datagrams), remote-aircraft interpolation ~100 ms behind
// live, and match history. World servers are open and UNTRUSTED, and identity
// is self-asserted.

import { createAppClient } from '@mochi/web'
import { SIZE, STATE } from './flight'
import { frame, frames } from './framing'
import { sanitizeWrap, minimumImage, fold } from './wrap'
import { cbor_encode, cbor_decode } from './cbor'
import { parseDarts, type Dart } from './darts'
export { crossHost } from './host'

const PROTOCOL = 2 // 2: the 35-byte pose record — byte 34 carries the emitter state (#30)

// isEnvelope is the minimal shape every server message must have before it
// reaches handle(): an object with a string `kind` discriminator.
function isEnvelope(message: unknown): message is Record<string, unknown> {
  return typeof message === 'object' && message !== null && typeof (message as { kind?: unknown }).kind === 'string'
}

// MAX_SLOT bounds a slot index from an untrusted server - a slot is a map key
// and an identity, so a NaN or absurd value must not get through.
const MAX_SLOT = 256

function validSlot(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) < MAX_SLOT
}

// finiteScore keeps only the finite numeric entries of an untrusted score map,
// so a non-finite or wrongly-typed value cannot reach the scoreboard.
function finiteScore(value: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const n = Number(v)
      if (Number.isFinite(n)) out[k] = n
    }
  }
  return out
}

// ---------------------------------------------------------------- lobby API

export interface WorldStatus {
  name: string
  version: string
  protocol: number
  games: string[]
  sessions: number
  players: number
  address: string
  certificate?: { hash: string; expires: number }
}

export interface WorldSession {
  session: string
  game: string
  mode: string
  label: string
  capacity: number
  players: { name: string; slot: number }[]
  created: number
  state: string
  permanent?: boolean
  mine?: boolean // this poll's own pilot made it (#77): the server matches our token rather than publishing anyone's
  offer?: boolean
  parameters?: Record<string, unknown> // curated rules subset (#17/#19): missiles, tod, clouds — what a joiner cares about before entering
}

// normalize_server turns user input like "host", "host:4433" or a full URL
// into a lobby base URL.
export function normalize_server(address: string): string {
  let a = address.trim().replace(/\/+$/, '')
  if (!a) return a
  if (!/^https?:\/\//.test(a)) a = (location.protocol === 'https:' ? 'https://' : 'http://') + a
  if (!/:\d+$/.test(a)) a += ':4433'
  return a
}

// default_server is the conventional lobby URL on the page's own host — the
// natural default when the Mochi server's operator also runs a world server.
export function default_server(): string {
  return `${location.protocol === 'https:' ? 'https' : 'http'}://${location.hostname}:4433`
}

// LOBBY_TIMEOUT bounds every lobby request: an untrusted server that accepts a
// connection but never responds must not hang the UI (a stuck refresh, a busy
// state that never clears). withTimeout also folds in an optional caller signal
// so a polled request can be aborted on unmount or a server-address change.
const LOBBY_TIMEOUT = 8000

function withTimeout(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(LOBBY_TIMEOUT)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

export async function world_status(server: string, signal?: AbortSignal): Promise<WorldStatus> {
  const response = await fetch(server + '/status', { mode: 'cors', signal: withTimeout(signal) })
  if (!response.ok) throw new Error('status ' + response.status)
  return (await response.json()) as WorldStatus
}

export async function world_sessions(server: string, game: string, signal?: AbortSignal, pilot?: string): Promise<WorldSession[]> {
  // The pilot token rides the poll: on the server side the match-list request
  // IS the heartbeat that keeps this player's own offer alive (#77).
  const query = '/sessions?game=' + encodeURIComponent(game) + (pilot ? '&pilot=' + encodeURIComponent(pilot) : '')
  const response = await fetch(server + query, { mode: 'cors', signal: withTimeout(signal) })
  if (!response.ok) throw new Error('status ' + response.status)
  const body = (await response.json()) as { sessions: WorldSession[] }
  return body.sessions ?? []
}

export async function world_create(
  server: string,
  request: { game: string; mode: string; label: string; name?: string; pilot?: string; capacity?: number; parameters?: Record<string, unknown> }
): Promise<{ session: string; address: string; certificate?: { hash: string } }> {
  const response = await fetch(server + '/sessions', {
    method: 'POST',
    mode: 'cors',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal: withTimeout(),
  })
  // Parse only after the status check: an HTML 502 from a proxy would otherwise
  // surface as a JSON parse error instead of the status. Failed creates do
  // answer JSON ({error}).
  if (!response.ok) {
    const failure = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(failure?.error || 'status ' + response.status)
  }
  const body = (await response.json()) as { error?: string; session: string; address: string; certificate?: { hash: string } }
  if (body.error) throw new Error(body.error)
  return body
}

// world_withdraw retires this pilot's own offer immediately — leaving the
// server page, or joining somebody else's match. The server's heartbeat
// timeout is only the backstop for a tab that vanished without saying so.
export async function world_withdraw(server: string, pilot: string): Promise<void> {
  await fetch(server + '/withdraw', {
    method: 'POST',
    mode: 'cors',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pilot }),
    signal: withTimeout(),
  }).catch(() => {}) // best effort: the grace period covers a failed withdraw
}

// The server-wide lobby chat (#84): a polled ring beside the match list.
// Lines are player chat ({name, text}) or structured system events
// ({event: "made", name, label}) the caller renders in its own language.
export interface WorldChatLine {
  sequence: number
  time: number
  name?: string
  text?: string
  event?: string
  label?: string
}

export async function world_chat(server: string, since: number, signal?: AbortSignal): Promise<{ lines: WorldChatLine[]; sequence: number }> {
  const response = await fetch(server + '/chat?since=' + since, { mode: 'cors', signal: withTimeout(signal) })
  if (!response.ok) throw new Error('status ' + response.status)
  return (await response.json()) as { lines: WorldChatLine[]; sequence: number }
}

export async function world_say(server: string, name: string, text: string): Promise<void> {
  const response = await fetch(server + '/chat', {
    method: 'POST',
    mode: 'cors',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, text }),
    signal: withTimeout(),
  })
  if (!response.ok) throw new Error('status ' + response.status)
}

// Join is everything the engine needs to enter a session.
export interface Join {
  server: string // lobby base URL (for match records)
  address: string // WebTransport URL
  certificate?: { hash: string }
  session: string
  name: string
  team?: string // teams mode side choice ('red'/'blue'); absent = the server assigns the smaller side
  stores?: Record<string, { fixture: string; stores: string[] }> // the requested loadout (#17); the server validates against the catalog and the match rules and spawns the granted result
}

// ---------------------------------------------------------------- connection

export interface RemotePose {
  position: [number, number, number]
  direction: [number, number, number]
  attitude: [number, number, number, number]
  speed: number
  name: string
  alive: boolean
  jamming: boolean // the jammer is radiating (#31)
  burn: [number, number]
  leak: number
  pilot: boolean
  loss: number
  kills: number
  deaths: number
  gear: boolean
  hook: boolean
  speedbrake: number
  reheat: number
  fire: boolean
  burning: boolean
}

interface Snapshot {
  at: number // performance.now() at arrival
  tick: number
  acknowledged: number
  core: Float64Array | null // the recipient's own encoded flight state
}

// One decoded 34-byte pose record with its arrival time — the per-slot rings
// these build replace per-snapshot player maps (#81): each slot updates at its
// own rate (nearest players every poses datagram, the far tail round-robin),
// so interpolation must bracket within the slot's own sample history.
interface TimedPose {
  at: number
  tick: number
  pose: RemotePose
}

export interface InputSample {
  pitch: number
  roll: number
  yaw: number
  throttle: number
  speedbrake: number
  reheat: number
  brake: boolean
  gear: boolean
  hook: boolean
  override: boolean
  dump: boolean
  port: boolean // per-engine fuel OFF, engine 0
  starboard: boolean
  fire: boolean
  flare: boolean
  missile: boolean
  radar: boolean // the AIM-120's own trigger (#27): its own magazine, its own edge
  jammer: boolean // the jammer's ARMED state (#31): a level — the server judges when it radiates
}

export interface Welcome {
  slot: number
  name: string
  tick: number
  rate: { tick: number; snapshot: number }
  seed: number
  parameters?: Record<string, unknown>
  spawn: { state?: SpawnState; wrap?: number; model?: number; aircraft?: string; waiting?: boolean; mode?: string; team?: string; score?: Record<string, number> }
  players: { slot: number; name: string; identity: string }[]
}

export interface SpawnState {
  position: [number, number, number]
  direction: [number, number, number]
  attitude: [number, number, number, number]
  speed: number
  core?: Uint8Array
}

export interface Handlers {
  event?: (event: Record<string, unknown>) => void
  end?: (reason: string, results: unknown) => void
  close?: (reason: string) => void
}

const DELAY = 100 // remote interpolation delay, ms

export class Net {
  slot = -1
  wrap = 250000
  welcome: Welcome | null = null
  private transport: WebTransport
  private handlers: Handlers
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  private datagrams: WritableStreamDefaultWriter<Uint8Array> | null = null
  private snapshots: Snapshot[] = []
  private rings = new Map<number, TimedPose[]>() // per-slot pose history (#81)
  private clock = NaN // EMA of (local seconds - server tick seconds): the jitter-filtered clock the pose timeline runs on
  private glide = new Map<number, { x: number; y: number; z: number; ox: number; oy: number; oz: number; at: number }>() // per-slot discontinuity smoothing: raw stream memory + decaying offset
  names = new Map<number, string>() // slot -> callsign (welcome + roster events)
  teams = new Map<number, string>() // slot -> side ('red'/'blue'; teams mode roster events)
  racks = new Map<number, Record<string, { fixture: string; stores: string[] }>>() // slot -> granted loadout (#17, roster events) — how remotes render each other's stores
  racksRevision = 0 // bumped on every roster stores update (#18) — the engine re-applies remote loadouts when it moves, so a mid-flight jettison shows
  score: Record<string, number> = {} // teams mode running score (welcome + kill events)
  darts: Dart[] = [] // the recipient's nearest server missiles, from the poses datagram — the engine renders every dart another player fired
  dartsAt = 0 // arrival time of the dart set (performance.now()), for dead reckoning
  emitters = new Map<number, { mode: number; target: number }>() // slot -> radar emitter state from the pose records (#30): 0 silent / 1 search / 2 STT with the locked slot — the RWR's feed (#28)
  private tallies = new Map<number, { kills: number; deaths: number }>() // counted from kill events
  private corrected = 0 // highest acknowledged sequence already reconciled
  cored = false // the server has sent at least one own-state core
  private sequence = 0
  private batch: (InputSample & { sequence: number })[] = []
  private last = 0 // last input send, performance.now()
  private closed = false

  constructor(transport: WebTransport, handlers: Handlers) {
    this.transport = transport
    this.handlers = handlers
  }

  // input queues one control sample; sends at most 60/s with the previous
  // two samples batched in for loss tolerance.
  // input queues one control sample; returns the sequence it was assigned,
  // or 0 when rate-limited (sends are capped at the server tick rate).
  input(sample: InputSample): number {
    const now = performance.now()
    if (now - this.last < 1000 / 60 - 1) return 0
    this.last = now
    this.sequence++
    this.batch.push({ ...sample, sequence: this.sequence })
    if (this.batch.length > 3) this.batch.shift()
    try {
      this.datagrams?.write(cbor_encode({ kind: 'input', inputs: this.batch }))
    } catch {
      // datagram writes fail only once the connection is gone; the reader notices
    }
    return this.sequence
  }

  // soften absorbs position discontinuities (interest-set entry after a long
  // dead-reckon, late samples on a turning jet): any step between the raw
  // stream and its velocity-extrapolated expectation folds into an offset that
  // bleeds out over ~⅓ s.
  private soften(slot: number, pose: RemotePose): RemotePose {
    const now = performance.now()
    const memo = this.glide.get(slot)
    const [x, y, z] = pose.position
    if (!memo) {
      this.glide.set(slot, { x, y, z, ox: 0, oy: 0, oz: 0, at: now })
      return pose
    }
    const dt = Math.min(0.25, (now - memo.at) / 1000)
    const fade = Math.exp(-3.5 * dt)
    let ox = memo.ox * fade
    let oy = memo.oy * fade
    let oz = memo.oz * fade
    const reach = pose.speed * dt
    const jx = this.shortest(x, memo.x + pose.direction[0] * reach)
    const jy = memo.y + pose.direction[1] * reach - y
    const jz = this.shortest(z, memo.z + pose.direction[2] * reach)
    const step = Math.hypot(jx, jy, jz)
    if (step > 1.2 && step < 60) {
      ox += jx
      oy += jy
      oz += jz
    } // beyond 60 m it's a respawn/teleport: snap honestly
    const cap = Math.hypot(ox, oy, oz)
    if (cap > 40) {
      ox *= 40 / cap
      oy *= 40 / cap
      oz *= 40 / cap
    }
    this.glide.set(slot, { x, y, z, ox, oy, oz, at: now })
    return { ...pose, position: [this.rewrap(x + ox), y + oy, this.rewrap(z + oz)] }
  }

  // self is the player's OWN latest pose, sent first in every poses datagram
  // and skipped by slots(). Newest sample, not interpolated: it feeds
  // annunciation and trails (engine fires, fuel fire, leak), not a rendered
  // position.
  self(): RemotePose | null {
    const ring = this.slot >= 0 ? this.rings.get(this.slot) : undefined
    if (!ring || !ring.length) return null
    return ring[ring.length - 1].pose
  }

  remote(slot: number): RemotePose | null {
    // Interpolate within the slot's OWN sample ring (#81): the nearest players
    // refresh every poses datagram, the far tail a few times a second — each
    // slot brackets the render time in its own history, whatever its rate.
    const ring = this.rings.get(slot)
    if (!ring || !ring.length || !Number.isFinite(this.clock)) return null
    // The pose timeline runs on SERVER TICK TIME through the smoothed clock:
    // bracketing by arrival time made every datagram's jitter a position wobble.
    const target = performance.now() / 1000 - this.clock - DELAY / 1000
    const when = (s: TimedPose) => s.tick / 60
    let after = ring.length - 1
    while (after > 0 && when(ring[after - 1]) >= target) after--
    const b = ring[after]
    const a = after > 0 ? ring[after - 1] : b
    const pb = b.pose
    const pa = a.pose
    // Beyond the newest sample (the far tail refreshes round-robin at a few
    // Hz), DEAD-RECKON along the last velocity instead of freezing: without
    // this every far update was a visible position snap.
    if (target > when(b) + 0.001) {
      const ahead = Math.min(1.2, target - when(b))
      const reach = pb.speed * ahead
      return this.soften(slot, {
        ...pb,
        position: [
          this.rewrap(pb.position[0] + pb.direction[0] * reach),
          pb.position[1] + pb.direction[1] * reach,
          this.rewrap(pb.position[2] + pb.direction[2] * reach),
        ],
      })
    }
    const span = when(b) - when(a)
    const t = span > 0.001 ? Math.min(1, Math.max(0, (target - when(a)) / span)) : 1
    const unwrap = (from: number, to: number) => from + this.shortest(from, to) * t
    const lerp = (from: number, to: number) => from + (to - from) * t
    return this.soften(slot, {
      ...pb,
      position: [
        this.rewrap(unwrap(pa.position[0], pb.position[0])),
        lerp(pa.position[1], pb.position[1]),
        this.rewrap(unwrap(pa.position[2], pb.position[2])),
      ],
      direction: pb.direction,
      attitude: slerp(pa.attitude, pb.attitude, t),
      speed: lerp(pa.speed, pb.speed),
    })
  }

  // correction returns the newest unconsumed own-state authority for
  // prediction reconciliation, or null when there is nothing new.
  correction(): { sequence: number; core: Float64Array } | null {
    const newest = this.snapshots[this.snapshots.length - 1]
    if (!newest || !newest.core || newest.acknowledged <= this.corrected) return null
    this.corrected = newest.acknowledged
    return { sequence: newest.acknowledged, core: newest.core }
  }

  // time returns the shared session clock in seconds - the server tick
  // extrapolated by wall time since the newest snapshot. World-anchored visuals
  // (cloud drift) must run on this; a local mission clock puts each player's
  // cloud field somewhere else.
  time(): number {
    const newest = this.snapshots[this.snapshots.length - 1]
    if (!newest) return 0
    return newest.tick / (this.welcome?.rate?.tick || 60) + (performance.now() - newest.at) / 1000
  }

  // slots lists the remote slots with a reasonably fresh pose — the far tail
  // refreshes round-robin, so anything seen within the last two seconds is
  // live; older rings belong to players who left (the wire stops mentioning
  // them) and their jets vanish.
  slots(): number[] {
    const now = performance.now()
    const live: number[] = []
    for (const [slot, ring] of this.rings) {
      if (slot === this.slot) continue
      if (ring.length && now - ring[ring.length - 1].at < 2000) live.push(slot)
    }
    return live
  }

  // own returns the newest authoritative state for our aircraft.
  own(): RemotePose | null {
    const ring = this.rings.get(this.slot)
    return ring?.length ? ring[ring.length - 1].pose : null   // self rides first in every poses datagram
  }

  shortest(from: number, to: number): number {
    return minimumImage(this.wrap, from, to)
  }

  private rewrap(value: number): number {
    return fold(this.wrap, value)
  }

  // chat sends one match-chat line (#84); the server sanitizes, scopes, and
  // echoes it back as a chat event — the echo is the delivery confirmation.
  chat(text: string, scope: string) {
    try {
      this.writer?.write(frame(cbor_encode({ kind: 'chat', text, scope })))
    } catch { /* already gone */ }
  }

  // jettison reports a stores departure (#18): station numbers with 'stores'
  // or 'rack' semantics. The server validates (removal only, never the tips),
  // updates the granted loadout, and re-emits the roster — every client's
  // rendering of this jet follows from that one authoritative event.
  jettison(stations: { station: number; what: string }[]) {
    try {
      this.writer?.write(frame(cbor_encode({ kind: 'jettison', stations })))
    } catch { /* already gone */ }
  }

  // radar reports the own emitter state (#30) on change: 0 silent, 1 search,
  // 2 STT with the locked slot (-1 none). The server validates and stamps it
  // into everyone's pose records — what their RWR reacts to (#28).
  radar(mode: number, target: number) {
    try {
      this.writer?.write(frame(cbor_encode({ kind: 'radar', mode, target })))
    } catch { /* already gone */ }
  }

  leave() {
    this.closed = true
    try {
      this.writer?.write(frame(cbor_encode({ kind: 'leave' })))
    } catch { /* already gone */ }
    try {
      this.transport.close()
    } catch { /* already gone */ }
  }

  // start runs the reader pumps after a successful handshake.
  start(writer: WritableStreamDefaultWriter<Uint8Array>, messages: AsyncGenerator<Uint8Array>) {
    this.writer = writer
    this.datagrams = this.transport.datagrams.writable.getWriter()
    void this.control(messages)
    void this.receive()
    this.transport.closed
      .catch(() => undefined)
      .then(() => {
        if (!this.closed) {
          this.closed = true
          this.handlers.close?.('gone')
        }
      })
  }

  private handle(message: Record<string, unknown>) {
    switch (message.kind) {
      case 'poses': {
        // The interest-managed pose datagram (#81): fixed 35-byte records —
        // self first, then the nearest remotes, then the rotating far tail.
        // Byte 34 is the emitter state (#30); the stride is version-locked by
        // the join's protocol check, so a mismatched build never parses here.
        const blob = message.blob as Uint8Array | undefined
        if (!(blob instanceof Uint8Array)) break
        const at = performance.now()
        const tick = Number(message.tick)
        if (!Number.isFinite(tick)) break // a non-finite tick would poison the interpolation clock
        // Smooth the local-to-server clock offset: interpolating on ARRIVAL
        // times fed every network jitter wobble straight into aircraft motion.
        const offset = at / 1000 - tick / 60
        if (!Number.isFinite(this.clock) || Math.abs(offset - this.clock) > 0.25) this.clock = offset
        else this.clock += (offset - this.clock) * 0.08
        const view = new DataView(blob.buffer, blob.byteOffset)
        for (let base = 0; base + 35 <= blob.byteLength; base += 35) {
          const slot = view.getUint8(base)
          const flags = view.getUint8(base + 26)
          const tally = this.tallies.get(slot)
          const pose: RemotePose = {
            position: [view.getFloat32(base + 1, true), view.getFloat32(base + 5, true), view.getFloat32(base + 9, true)],
            attitude: [
              view.getInt16(base + 13, true) / 32767,
              view.getInt16(base + 15, true) / 32767,
              view.getInt16(base + 17, true) / 32767,
              view.getInt16(base + 19, true) / 32767,
            ],
            direction: [view.getInt8(base + 21) / 127, view.getInt8(base + 22) / 127, view.getInt8(base + 23) / 127],
            speed: view.getUint16(base + 24, true) / 10,
            name: this.names.get(slot) ?? '',
            alive: !!(flags & 1),
            gear: !!(flags & 2),
            hook: !!(flags & 4),
            fire: !!(flags & 8),
            pilot: !!(flags & 16),
            jamming: !!(flags & 64), // the jammer is radiating (#31): victims strobe and break locks on this
            burning: !!(flags & 32),
            reheat: view.getUint8(base + 27) / 255,
            speedbrake: view.getUint8(base + 28) / 255,
            burn: [view.getUint8(base + 29) / 255, view.getUint8(base + 30) / 255],
            leak: view.getUint8(base + 31) / 10,
            loss: view.getUint16(base + 32, true),
            kills: tally?.kills ?? 0,
            deaths: tally?.deaths ?? 0,
          }
          // The position floats are the only non-finite-capable field (a
          // hostile server can encode NaN/Inf in the Float32s); drop the
          // record rather than feed NaN through shortest()/rewrap() into
          // Three.js. Attitude/direction/speed are int-derived and finite.
          if (!pose.position.every(Number.isFinite)) continue
          const emitter = view.getUint8(base + 34) // #30: high two bits the mode, low six the locked slot (63 = none)
          this.emitters.set(slot, { mode: (emitter >> 6) & 3, target: (emitter & 63) === 63 ? -1 : emitter & 63 })
          let ring = this.rings.get(slot)
          if (!ring) {
            ring = []
            this.rings.set(slot, ring)
          }
          ring.push({ at, tick, pose })
          if (ring.length > 20) ring.shift()
        }
        // The missile block: 25-byte darts (position, velocity, shooter), the
        // recipient's nearest server missiles, capped at 6. The stride must
        // match the server's snapshot assembly; parseDarts drops non-finite
        // floats the CBOR guard cannot see.
        const missiles = message.missiles as Uint8Array | undefined
        if (missiles instanceof Uint8Array) {
          this.darts = parseDarts(missiles)
          this.dartsAt = at
        }
        break
      }
      case 'snapshot': {
        const tick = Number(message.tick)
        if (!Number.isFinite(tick)) break
        let core: Float64Array | null = null
        const bytes = message.core as Uint8Array | undefined
        if (bytes instanceof Uint8Array && bytes.byteLength >= 456 + (SIZE - 57) * 2) {
          // The wire core: 57 base words at full float64 precision, then the
          // damage tail quantised to uint16 (unit-interval losses; the final
          // word is shed mass at kg/8000) — full float64 burst the datagram
          // MTU. Re-expand to the flight core's 106-word layout.
          const expanded = new Float64Array(SIZE)
          const view = new DataView(bytes.buffer, bytes.byteOffset)
          let bad = false
          for (let i = 0; i < 57; i++) {
            const w = view.getFloat64(i * 8, true)
            if (!Number.isFinite(w)) { bad = true; break } // a non-finite core word would poison the WASM prediction
            expanded[i] = w
          }
          if (!bad) {
            for (let i = 57; i < SIZE; i++) {
              let v = view.getUint16(57 * 8 + (i - 57) * 2, true) / 65535 // the uint16 tail is always finite
              if (i === STATE.loss) v *= 8000 // Loss, kg — BY INDEX: scaling "the last word" broke when #78 appended the gear words after Loss (strut damage arrived x8000, Loss unscaled)
              if (i === STATE.loss + 4) v = (v - 0.5) * 3 // Pitchwash, signed rad/s off the unit-interval wire mapping — BY INDEX for the same reason: "SIZE - 1" silently slid onto the roll-trim datum when buffet and bank were appended
              if (i === STATE.external) v *= 8000 // external-tank fuel, kg — same scale as Loss
              expanded[i] = v
            }
            core = expanded
            this.cored = true
          }
        }
        this.snapshots.push({
          at: performance.now(),
          tick,
          acknowledged: Number.isFinite(Number(message.acknowledged)) ? Number(message.acknowledged) : 0,
          core,
        })
        if (this.snapshots.length > 40) this.snapshots.shift()
        break
      }
      case 'event': {
        const event = message.event
        if (typeof event !== 'object' || event === null) break // an event must be an object before it reaches the engine handler
        const ev = event as Record<string, unknown>
        if (ev.kind === 'roster' && validSlot(ev.slot)) {
          this.names.set(ev.slot as number, String(ev.name ?? ''))   // names arrive out of the hot path (#81)
          if (ev.team) this.teams.set(ev.slot as number, String(ev.team))
          if (ev.stores && typeof ev.stores === 'object') {
            this.racks.set(ev.slot as number, ev.stores as Record<string, { fixture: string; stores: string[] }>)
            this.racksRevision++
          }
        }
        if (ev.kind === 'kill' && ev.score) this.score = finiteScore(ev.score)
        if (ev.kind === 'kill' && validSlot(ev.slot)) {   // scores are counted, not shipped per snapshot (#81)
          const victim = ev.slot as number, killer = Number(ev.by)
          const down = this.tallies.get(victim) ?? { kills: 0, deaths: 0 }
          down.deaths++
          this.tallies.set(victim, down)
          if (validSlot(killer)) {
            const up = this.tallies.get(killer) ?? { kills: 0, deaths: 0 }
            up.kills++
            this.tallies.set(killer, up)
          }
        }
        this.handlers.event?.(ev)
        break
      }
      case 'end':
        this.closed = true
        this.handlers.end?.(String(message.reason ?? ''), message.results)
        break
    }
  }

  // fail tears the connection down with a reason: a framing/protocol violation
  // must not leave a silently-dead reader behind a frozen-looking match.
  private fail(reason: string) {
    if (!this.closed) {
      this.closed = true
      this.handlers.close?.(reason)
    }
    try {
      this.transport.close()
    } catch { /* already closing */ }
  }

  private async control(messages: AsyncGenerator<Uint8Array>) {
    try {
      for await (const payload of messages) {
        const message = cbor_decode(payload)
        if (!isEnvelope(message)) throw new Error('envelope')
        this.handle(message)
      }
    } catch {
      // A framing violation, decode failure, or malformed envelope on the
      // control stream is fatal — the server is hostile or broken.
      this.fail('protocol')
      return
    }
    // The generator ended without throwing: the control stream closed cleanly,
    // and it is the reliable channel a live match needs, so its end ends the
    // session. fail() is idempotent, so a user-initiated leave (which sets
    // this.closed first) no-ops here.
    this.fail('closed')
  }

  private async receive() {
    let malformed = 0
    try {
      const reader = this.transport.datagrams.readable.getReader() as ReadableStreamDefaultReader<Uint8Array>
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        if (!value) continue
        // A datagram is lossy by nature, so drop an ISOLATED malformed one
        // rather than kill the whole reader (which silently froze pose
        // updates). A burst means a hostile or broken server: terminate.
        try {
          const message = cbor_decode(value)
          if (!isEnvelope(message)) throw new Error('envelope')
          this.handle(message)
          malformed = 0
        } catch {
          if (++malformed > 8) {
            this.fail('protocol')
            return
          }
        }
      }
    } catch { /* reader gone; transport.closed fires the handler */ }
  }
}

function slerp(
  a: [number, number, number, number],
  b: [number, number, number, number],
  t: number
): [number, number, number, number] {
  // Normalised lerp — adequate for 50 ms snapshot gaps.
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
  const sign = dot < 0 ? -1 : 1
  const out: [number, number, number, number] = [
    a[0] + (sign * b[0] - a[0]) * t,
    a[1] + (sign * b[1] - a[1]) * t,
    a[2] + (sign * b[2] - a[2]) * t,
    a[3] + (sign * b[3] - a[3]) * t,
  ]
  const length = Math.hypot(out[0], out[1], out[2], out[3]) || 1
  return [out[0] / length, out[1] / length, out[2] / length, out[3] / length]
}

export function supported(): boolean {
  return typeof WebTransport !== 'undefined'
}

// connect dials the world server and completes the join handshake.
// CONNECT_DEADLINE bounds the transport open + stream, WELCOME_DEADLINE the
// wait for the first server frame - separate, so a server that never answers
// the join still fails promptly.
const CONNECT_DEADLINE = 10000
const WELCOME_DEADLINE = 10000

// deadline rejects if the operation has not settled in ms; the underlying work
// is torn down by the caller closing the transport.
function deadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' timeout')), ms)
  })
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer)) as Promise<T>
}

export async function connect(join: Join, handlers: Handlers): Promise<Net> {
  const options: WebTransportOptions = {}
  if (join.certificate?.hash) {
    const raw = atob(join.certificate.hash)
    const value = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) value[i] = raw.charCodeAt(i)
    options.serverCertificateHashes = [{ algorithm: 'sha-256', value }]
  }
  const transport = new WebTransport(join.address, options)
  try {
    await deadline(transport.ready, CONNECT_DEADLINE, 'connect')
    const stream = await deadline(transport.createBidirectionalStream(), CONNECT_DEADLINE, 'stream')
    const writer = stream.writable.getWriter() as WritableStreamDefaultWriter<Uint8Array>
    const reader = stream.readable.getReader() as ReadableStreamDefaultReader<Uint8Array>
    await writer.write(
      frame(cbor_encode({ kind: 'join', session: join.session, name: join.name, team: join.team ?? '', stores: join.stores ?? {}, protocol: PROTOCOL }))
    )
    // The handshake and the established connection share ONE bounded frame
    // reader (the same size caps and chunk-queue apply to the welcome/refuse):
    // pull the first frame here, then hand the live iterator to the Net so the
    // control loop continues from exactly where the handshake left off.
    const messages = frames(reader, new Uint8Array(0))
    const opening = await deadline(messages.next(), WELCOME_DEADLINE, 'welcome')
    if (opening.done) throw new Error('closed')
    const first = cbor_decode(opening.value) as Record<string, unknown>
    if (first.kind === 'refuse') throw new Error(String(first.reason ?? 'refused'))
    if (first.kind !== 'welcome') throw new Error('protocol')
    // Validate the welcome before it becomes our identity: an out-of-range or
    // non-integer slot corrupts every slot-keyed map, and players must be a
    // real array before we iterate it.
    const slot = Number(first.slot)
    if (!validSlot(slot)) throw new Error('slot')
    const net = new Net(transport, handlers)
    net.welcome = first as unknown as Welcome
    net.slot = slot
    const players = Array.isArray(first.players) ? first.players : []
    for (const p of players) {
      if (typeof p !== 'object' || p === null) continue
      const record = p as { slot?: unknown; name?: unknown }
      if (validSlot(record.slot)) net.names.set(record.slot as number, String(record.name ?? '')) // players present before us; later joiners arrive via roster events
    }
    const spawn = first.spawn as { wrap?: unknown; team?: unknown; score?: unknown } | undefined
    if (spawn && spawn.wrap !== undefined) net.wrap = sanitizeWrap(spawn.wrap, net.wrap)
    if (spawn?.team) net.teams.set(slot, String(spawn.team))
    if (spawn?.score) net.score = finiteScore(spawn.score)
    net.start(writer, messages)
    return net
  } catch (error) {
    // Any failure before the Net takes ownership — timeout, refuse, protocol,
    // bad welcome — must close the partially-opened transport so nothing is
    // left dangling.
    try {
      transport.close()
    } catch { /* already closing */ }
    throw error
  }
}

// ---------------------------------------------------------------- history

const client = createAppClient({ appName: 'air' })

// record stores this player's own view of a finished match through their own
// authenticated app connection (fails silently for anonymous players).
export async function record(match: {
  world: string
  session: string
  mode: string
  team: string
  started: number
  ended: number
  reason: string
  players: string
  kills: number
  deaths: number
  cheated: number
}): Promise<void> {
  try {
    await client.post('/-/match/record', match)
  } catch { /* anonymous or offline — history is best-effort */ }
}

// MatchRow is one recorded match as match_list returns it (players is the
// participant count as a string; cheated is 0/1).
export interface MatchRow {
  world: string
  session: string
  recording: string // attachment id, '' when nothing is stored
  size: number
  pinned: number // 1 = exempt from pruning
  mode: string
  team: string
  started: number
  ended: number
  reason: string
  players: string
  kills: number
  deaths: number
  cheated: number
}

// history reads this player's recorded matches, most recent first. Its totals
// come from the server over EVERY flight while the list is capped at fifty, so
// summing the rows on screen understates a career. recording_store uploads a
// gzipped ACMI as multipart: the 1 MB non-multipart body cap would reject
// anything but the shortest sortie.
export async function recording_store(session: string, started: number, text: string): Promise<boolean> {
  try {
    const gz = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
    const body = new FormData()
    body.append('session', session)
    body.append('started', String(started))
    // The type matters: a typeless Blob arrives as a part the attachment API does not take as a file.
    const bytes = await new Response(gz).arrayBuffer()
    body.append('recording', new Blob([bytes], { type: 'application/gzip' }), 'flight.acmi.gz')
    const res = (await client.post('/-/recording/save', body)) as { data?: { saved?: boolean } }
    return !!(res?.data?.saved ?? (res as { saved?: boolean })?.saved)
  } catch {
    return false // best effort: the player can still save the in-memory copy
  }
}

// recording_load fetches a stored recording and inflates it back to ACMI text.
export async function recording_load(id: string): Promise<string | null> {
  try {
    const res = await client.instance.get('/-/recording/fetch', {
      params: { id },
      responseType: 'blob',
    })
    const stream = (res.data as Blob).stream().pipeThrough(new DecompressionStream('gzip'))
    return await new Response(stream).text()
  } catch {
    return null
  }
}

export async function recording_pin(session: string, started: number, pinned: boolean): Promise<void> {
  try {
    await client.post('/-/recording/pin', { session, started: String(started), pinned: String(pinned) })
  } catch {
    /* best effort */
  }
}

export interface MatchTotals {
  flights: number
  seconds: number
  kills: number
  deaths: number
  cheated: number
}

export async function history(): Promise<{ matches: MatchRow[]; totals: MatchTotals | null }> {
  try {
    const res = (await client.get('/-/match/list')) as {
      data?: { matches?: MatchRow[]; totals?: MatchTotals }
      matches?: MatchRow[]
      totals?: MatchTotals
    }
    const body = res?.data ?? res
    return { matches: body?.matches ?? [], totals: body?.totals ?? null }
  } catch {
    return { matches: [], totals: null }
  }
}
