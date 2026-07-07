// Copyright © 2026 Mochi OÜ
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

export const PROTOCOL = 1

// ---------------------------------------------------------------- CBOR codec
// Minimal CBOR (RFC 8949) subset matching the server's fxamacker encoding:
// unsigned/negative integers, byte/text strings, arrays, string-keyed maps,
// booleans, null, and float16/32/64. No dependency, no indefinite lengths.

const text_encoder = new TextEncoder()
const text_decoder = new TextDecoder()

function cbor_encode(value: unknown): Uint8Array {
  const parts: number[] = []
  const head = (major: number, length: number) => {
    if (length < 24) parts.push((major << 5) | length)
    else if (length < 0x100) parts.push((major << 5) | 24, length)
    else if (length < 0x10000) parts.push((major << 5) | 25, length >> 8, length & 0xff)
    else parts.push((major << 5) | 26, (length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff)
  }
  const put = (v: unknown) => {
    if (v === null || v === undefined) { parts.push(0xf6); return }
    if (typeof v === 'boolean') { parts.push(v ? 0xf5 : 0xf4); return }
    if (typeof v === 'number') {
      if (Number.isSafeInteger(v) && Math.abs(v) < 0x100000000) {
        if (v >= 0) head(0, v)
        else head(1, -v - 1)
      } else {
        parts.push(0xfb)
        const b = new DataView(new ArrayBuffer(8))
        b.setFloat64(0, v)
        for (let i = 0; i < 8; i++) parts.push(b.getUint8(i))
      }
      return
    }
    if (typeof v === 'string') { const bytes = text_encoder.encode(v); head(3, bytes.length); for (const x of bytes) parts.push(x); return }
    if (Array.isArray(v)) { head(4, v.length); for (const item of v) put(item); return }
    if (typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined)
      head(5, entries.length)
      for (const [k, x] of entries) { put(k); put(x) }
      return
    }
    parts.push(0xf6)
  }
  put(value)
  return new Uint8Array(parts)
}

function cbor_decode(bytes: Uint8Array): unknown {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 0
  const length = (info: number): number => {
    if (info < 24) return info
    if (info === 24) return view.getUint8(at++)
    if (info === 25) { const v = view.getUint16(at); at += 2; return v }
    if (info === 26) { const v = view.getUint32(at); at += 4; return v }
    const v = Number(view.getBigUint64(at)); at += 8; return v
  }
  const half = (): number => {
    const h = view.getUint16(at); at += 2
    const sign = h & 0x8000 ? -1 : 1, exponent = (h >> 10) & 0x1f, fraction = h & 0x3ff
    if (exponent === 0) return sign * fraction * 2 ** -24
    if (exponent === 31) return fraction ? NaN : sign * Infinity
    return sign * (1024 + fraction) * 2 ** (exponent - 25)
  }
  const item = (): unknown => {
    const first = view.getUint8(at++)
    const major = first >> 5, info = first & 0x1f
    switch (major) {
      case 0: return length(info)
      case 1: return -1 - length(info)
      case 2: { const n = length(info); const v = bytes.slice(at, at + n); at += n; return v }
      case 3: { const n = length(info); const v = text_decoder.decode(bytes.subarray(at, at + n)); at += n; return v }
      case 4: { const n = length(info); const list = new Array(n); for (let i = 0; i < n; i++) list[i] = item(); return list }
      case 5: { const n = length(info); const map: Record<string, unknown> = {}; for (let i = 0; i < n; i++) { const k = item(); map[String(k)] = item() } return map }
      case 7:
        if (info === 20) return false
        if (info === 21) return true
        if (info === 22 || info === 23) return null
        if (info === 25) return half()
        if (info === 26) { const v = view.getFloat32(at); at += 4; return v }
        if (info === 27) { const v = view.getFloat64(at); at += 8; return v }
        return null
      default:
        return null
    }
  }
  return item()
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
  request: { game: string; mode: string; label: string; capacity?: number; parameters?: Record<string, unknown> }
): Promise<{ session: string; address: string; certificate?: { hash: string } }> {
  const response = await fetch(server + '/sessions', {
    method: 'POST',
    mode: 'cors',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })
  const body = (await response.json()) as { error?: string; session: string; address: string; certificate?: { hash: string } }
  if (!response.ok || body.error) throw new Error(body.error || 'status ' + response.status)
  return body
}

// Join is everything the engine needs to enter a session.
export interface Join {
  server: string // lobby base URL (for match records)
  address: string // WebTransport URL
  certificate?: { hash: string }
  session: string
  name: string
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
  spawn: { state?: SpawnState; wrap?: number; model?: number; aircraft?: string; waiting?: boolean; mode?: string }
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
  names = new Map<number, string>() // slot -> callsign (welcome + roster events)
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
  remote(slot: number): RemotePose | null {
    // Interpolate within the slot's OWN sample ring (#81): the nearest players
    // refresh every poses datagram, the far tail a few times a second — each
    // slot brackets the render time in its own history, whatever its rate.
    const ring = this.rings.get(slot)
    if (!ring || !ring.length) return null
    const target = performance.now() - DELAY
    let after = ring.length - 1
    while (after > 0 && ring[after - 1].at >= target) after--
    const b = ring[after]
    const a = after > 0 ? ring[after - 1] : b
    const pb = b.pose
    const pa = a.pose
    const span = b.at - a.at
    const t = span > 1 ? Math.min(1, Math.max(0, (target - a.at) / span)) : 1
    const unwrap = (from: number, to: number) => from + this.shortest(from, to) * t
    const lerp = (from: number, to: number) => from + (to - from) * t
    return {
      ...pb,
      position: [
        this.rewrap(unwrap(pa.position[0], pb.position[0])),
        lerp(pa.position[1], pb.position[1]),
        this.rewrap(unwrap(pa.position[2], pb.position[2])),
      ],
      direction: pb.direction,
      attitude: slerp(pa.attitude, pb.attitude, t),
      speed: lerp(pa.speed, pb.speed),
    }
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
    let d = to - from
    if (this.wrap > 0) {
      const half = this.wrap / 2
      while (d > half) d -= this.wrap
      while (d < -half) d += this.wrap
    }
    return d
  }

  private rewrap(value: number): number {
    if (this.wrap <= 0) return value
    return value - this.wrap * Math.round(value / this.wrap)
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
  start(writer: WritableStreamDefaultWriter<Uint8Array>, control: ReadableStreamDefaultReader<Uint8Array>, pending: Uint8Array) {
    this.writer = writer
    this.datagrams = this.transport.datagrams.writable.getWriter()
    void this.control(control, pending)
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
          let ring = this.rings.get(slot)
          if (!ring) {
            ring = []
            this.rings.set(slot, ring)
          }
          ring.push({ at, tick, pose })
          if (ring.length > 20) ring.shift()
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
        if (event?.kind === 'roster') this.names.set(Number(event.slot), String(event.name ?? ''))   // names arrive out of the hot path (#81)
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

  private async control(reader: ReadableStreamDefaultReader<Uint8Array>, pending: Uint8Array) {
    try {
      for await (const payload of frames(reader, pending)) {
        this.handle(cbor_decode(payload) as Record<string, unknown>)
      }
    } catch { /* connection gone; transport.closed fires the handler */ }
  }

  private async receive() {
    try {
      const reader = this.transport.datagrams.readable.getReader() as ReadableStreamDefaultReader<Uint8Array>
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        if (value) this.handle(cbor_decode(value) as Record<string, unknown>)
      }
    } catch { /* connection gone */ }
  }
}

function frame(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.length)
  new DataView(out.buffer).setUint32(0, payload.length)
  out.set(payload, 4)
  return out
}

// frames yields length-framed messages from a stream reader.
async function* frames(reader: ReadableStreamDefaultReader<Uint8Array>, pending: Uint8Array): AsyncGenerator<Uint8Array> {
  let buffer = pending
  for (;;) {
    while (buffer.length >= 4) {
      const size = new DataView(buffer.buffer, buffer.byteOffset).getUint32(0)
      if (buffer.length < 4 + size) break
      yield buffer.slice(4, 4 + size)
      buffer = buffer.slice(4 + size)
    }
    const { value, done } = await reader.read()
    if (done) return
    const joined = new Uint8Array(buffer.length + value.length)
    joined.set(buffer)
    joined.set(value, buffer.length)
    buffer = joined
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
    frame(cbor_encode({ kind: 'join', session: join.session, name: join.name, protocol: PROTOCOL }))
  )
  // Read the first frame: welcome or refuse.
  let buffer = new Uint8Array(0)
  for (;;) {
    if (buffer.length >= 4) {
      const size = new DataView(buffer.buffer, buffer.byteOffset).getUint32(0)
      if (buffer.length >= 4 + size) {
        const first = cbor_decode(buffer.slice(4, 4 + size)) as Record<string, unknown>
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
        for (const p of net.welcome.players ?? []) net.names.set(p.slot, p.name)   // players present before us; later joiners arrive via roster events
        net.slot = Number(first.slot)
        const spawn = first.spawn as { wrap?: number } | undefined
        if (spawn?.wrap) net.wrap = Number(spawn.wrap)
        net.start(writer, reader, buffer.slice(4 + size))
        return net
      }
    }
    const { value, done } = await reader.read()
    if (done) throw new Error('closed')
    const joined = new Uint8Array(buffer.length + value.length)
    joined.set(buffer)
    joined.set(value, buffer.length)
    buffer = joined
  }
}

// ---------------------------------------------------------------- history

const client = createAppClient({ appName: 'furball' })

// record stores this player's own view of a finished match through their own
// authenticated app connection (fails silently for anonymous players).
export async function record(match: {
  world: string
  session: string
  mode: string
  started: number
  ended: number
  reason: string
  players: string
  kills: number
  deaths: number
}): Promise<void> {
  try {
    await client.post('match/record', match)
  } catch { /* anonymous or offline — history is best-effort */ }
}
