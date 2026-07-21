// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// Multiplayer networking: lobby API helpers, the WebTransport data plane
// (join handshake on a framed control stream, inputs up / snapshots down as
// CBOR datagrams), remote-aircraft interpolation ~100 ms behind live, and
// self-recorded match history. World servers are open and untrusted — the
// address comes from the player, identity is self-asserted (see the plan's
// verified-tier seam), and results are recorded per player via their own
// authenticated app connection.

import { createAppClient } from '@mochi/web'
import { SIZE } from './flight'
import { frame, frames } from './framing'
import { sanitizeWrap, minimumImage, fold } from './wrap'
import { cbor_encode, cbor_decode } from './cbor'

const PROTOCOL = 1

// isEnvelope is the minimal shape every server message must have before it
// reaches handle(): an object with a string `kind` discriminator. Per-message
// field validation (finite numbers, bounded slots, ...) is a separate layer.
function isEnvelope(message: unknown): message is Record<string, unknown> {
  return typeof message === 'object' && message !== null && typeof (message as { kind?: unknown }).kind === 'string'
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

export async function world_status(server: string): Promise<WorldStatus> {
  const response = await fetch(server + '/status', { mode: 'cors' })
  if (!response.ok) throw new Error('status ' + response.status)
  return (await response.json()) as WorldStatus
}

export async function world_sessions(server: string, game: string): Promise<WorldSession[]> {
  const response = await fetch(server + '/sessions?game=' + encodeURIComponent(game), { mode: 'cors' })
  if (!response.ok) throw new Error('status ' + response.status)
  const body = (await response.json()) as { sessions: WorldSession[] }
  return body.sessions ?? []
}

export async function world_create(
  server: string,
  request: { game: string; mode: string; label: string; name?: string; capacity?: number; parameters?: Record<string, unknown> }
): Promise<{ session: string; address: string; certificate?: { hash: string } }> {
  const response = await fetch(server + '/sessions', {
    method: 'POST',
    mode: 'cors',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })
  // Parse only after the status check falls through to the structured-error
  // case: an HTML 502 from a proxy used to surface as a JSON parse error
  // instead of the status. The server DOES answer failed creates with JSON
  // ({error}), so a failed parse on !ok falls back to the bare status.
  if (!response.ok) {
    const failure = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(failure?.error || 'status ' + response.status)
  }
  const body = (await response.json()) as { error?: string; session: string; address: string; certificate?: { hash: string } }
  if (body.error) throw new Error(body.error)
  return body
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

export async function world_chat(server: string, since: number): Promise<{ lines: WorldChatLine[]; sequence: number }> {
  const response = await fetch(server + '/chat?since=' + since, { mode: 'cors' })
  if (!response.ok) throw new Error('status ' + response.status)
  return (await response.json()) as { lines: WorldChatLine[]; sequence: number }
}

export async function world_say(server: string, name: string, text: string): Promise<void> {
  const response = await fetch(server + '/chat', {
    method: 'POST',
    mode: 'cors',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, text }),
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
}

// ---------------------------------------------------------------- connection

export interface RemotePose {
  position: [number, number, number]
  direction: [number, number, number]
  attitude: [number, number, number, number]
  speed: number
  name: string
  alive: boolean
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
  fire: boolean
  flare: boolean
  missile: boolean
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
  score: Record<string, number> = {} // teams mode running score (welcome + kill events)
  darts: { position: [number, number, number]; velocity: [number, number, number]; shooter: number }[] = [] // the recipient's nearest server missiles, from the poses datagram — the engine renders every dart another player fired
  dartsAt = 0 // arrival time of the dart set (performance.now()), for dead reckoning
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

  // remote returns the interpolated pose for a slot, ~DELAY ms behind live,
  // unwrapping across the toroidal seam before lerping.
  // soften absorbs position discontinuities (interest-set entry after a long
  // dead-reckon, late samples on a turning jet): any step between the raw
  // stream and its velocity-extrapolated expectation folds into an offset
  // that bleeds out over ~⅓ s, so near aircraft glide instead of snapping.
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

  // time returns the shared session clock in seconds — the server tick at a known
  // rate, extrapolated by wall time since the newest snapshot arrived. Every player
  // computes the same value (± network jitter), which is what world-anchored visuals
  // (cloud drift) must run on in multiplayer: a local mission clock puts each
  // player's cloud field in a different place.
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
        // The interest-managed pose datagram (#81): fixed 34-byte records —
        // self first, then the nearest remotes, then the rotating far tail.
        const blob = message.blob as Uint8Array | undefined
        if (!(blob instanceof Uint8Array)) break
        const at = performance.now()
        const tick = Number(message.tick)
        // Smooth the local-to-server clock offset: interpolating on ARRIVAL
        // times fed every network jitter wobble straight into aircraft motion.
        const offset = at / 1000 - tick / 60
        if (!Number.isFinite(this.clock) || Math.abs(offset - this.clock) > 0.25) this.clock = offset
        else this.clock += (offset - this.clock) * 0.08
        const view = new DataView(blob.buffer, blob.byteOffset)
        for (let base = 0; base + 34 <= blob.byteLength; base += 34) {
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
          let ring = this.rings.get(slot)
          if (!ring) {
            ring = []
            this.rings.set(slot, ring)
          }
          ring.push({ at, tick, pose })
          if (ring.length > 20) ring.shift()
        }
        // The missile block: 25-byte darts (position, velocity, shooter) —
        // the recipient's nearest server missiles, capped at 6. The stride
        // must match the server's snapshot assembly; the modulo guard shows
        // no darts on a mismatched build rather than garbage.
        const missiles = message.missiles as Uint8Array | undefined
        if (missiles instanceof Uint8Array && missiles.byteLength % 25 === 0) {
          const mv = new DataView(missiles.buffer, missiles.byteOffset)
          const list: typeof this.darts = []
          for (let base = 0; base + 25 <= missiles.byteLength; base += 25) {
            list.push({
              position: [mv.getFloat32(base, true), mv.getFloat32(base + 4, true), mv.getFloat32(base + 8, true)],
              velocity: [mv.getFloat32(base + 12, true), mv.getFloat32(base + 16, true), mv.getFloat32(base + 20, true)],
              shooter: mv.getUint8(base + 24),
            })
          }
          this.darts = list
          this.dartsAt = at
        }
        break
      }
      case 'snapshot': {
        let core: Float64Array | null = null
        const bytes = message.core as Uint8Array | undefined
        if (bytes instanceof Uint8Array && bytes.byteLength >= 456 + (SIZE - 57) * 2) {
          // The wire core: 57 base words at full float64 precision, then the
          // damage tail quantised to uint16 (unit-interval losses; the final
          // word is shed mass at kg/8000) — full float64 burst the datagram
          // MTU. Re-expand to the flight core's 106-word layout.
          core = new Float64Array(SIZE)
          const view = new DataView(bytes.buffer, bytes.byteOffset)
          for (let i = 0; i < 57; i++) core[i] = view.getFloat64(i * 8, true)
          for (let i = 57; i < SIZE; i++) {
            let v = view.getUint16(57 * 8 + (i - 57) * 2, true) / 65535
            if (i === SIZE - 1) v *= 8000 // Loss, kg
            core[i] = v
          }
          this.cored = true
        }
        this.snapshots.push({
          at: performance.now(),
          tick: Number(message.tick),
          acknowledged: Number(message.acknowledged ?? 0),
          core,
        })
        if (this.snapshots.length > 40) this.snapshots.shift()
        break
      }
      case 'event': {
        const event = message.event as Record<string, unknown>
        if (event?.kind === 'roster') {
          this.names.set(Number(event.slot), String(event.name ?? ''))   // names arrive out of the hot path (#81)
          if (event.team) this.teams.set(Number(event.slot), String(event.team))
        }
        if (event?.kind === 'kill' && event.score) this.score = event.score as Record<string, number>
        if (event?.kind === 'kill') {   // scores are counted, not shipped per snapshot (#81)
          const victim = Number(event.slot), killer = Number(event.by)
          const down = this.tallies.get(victim) ?? { kills: 0, deaths: 0 }
          down.deaths++
          this.tallies.set(victim, down)
          if (Number.isFinite(killer) && killer >= 0) {
            const up = this.tallies.get(killer) ?? { kills: 0, deaths: 0 }
            up.kills++
            this.tallies.set(killer, up)
          }
        }
        this.handlers.event?.(event)
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
    }
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
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
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
export async function connect(join: Join, handlers: Handlers): Promise<Net> {
  const options: WebTransportOptions = {}
  if (join.certificate?.hash) {
    const raw = atob(join.certificate.hash)
    const value = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) value[i] = raw.charCodeAt(i)
    options.serverCertificateHashes = [{ algorithm: 'sha-256', value }]
  }
  const transport = new WebTransport(join.address, options)
  await transport.ready
  const stream = await transport.createBidirectionalStream()
  const writer = stream.writable.getWriter() as WritableStreamDefaultWriter<Uint8Array>
  const reader = stream.readable.getReader() as ReadableStreamDefaultReader<Uint8Array>
  await writer.write(
    frame(cbor_encode({ kind: 'join', session: join.session, name: join.name, team: join.team ?? '', protocol: PROTOCOL }))
  )
  // The handshake and the established connection share ONE bounded frame
  // reader (the same size caps and chunk-queue apply to the welcome/refuse):
  // pull the first frame here, then hand the live iterator to the Net so the
  // control loop continues from exactly where the handshake left off.
  const messages = frames(reader, new Uint8Array(0))
  const opening = await messages.next()
  if (opening.done) throw new Error('closed')
  const first = cbor_decode(opening.value) as Record<string, unknown>
  if (first.kind === 'refuse') {
    transport.close()
    throw new Error(String(first.reason ?? 'refused'))
  }
  if (first.kind !== 'welcome') {
    transport.close()
    throw new Error('protocol')
  }
  const net = new Net(transport, handlers)
  net.welcome = first as unknown as Welcome
  for (const p of net.welcome.players ?? []) net.names.set(p.slot, p.name) // players present before us; later joiners arrive via roster events
  net.slot = Number(first.slot)
  const spawn = first.spawn as { wrap?: number; team?: string; score?: Record<string, number> } | undefined
  if (spawn && spawn.wrap !== undefined) net.wrap = sanitizeWrap(spawn.wrap, net.wrap)
  if (spawn?.team) net.teams.set(net.slot, spawn.team)
  if (spawn?.score) net.score = spawn.score
  net.start(writer, messages)
  return net
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
