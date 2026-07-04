// Copyright © 2026 Mochi OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The flight simulation core: a Go blade-element model compiled to wasm
// (built from world/games/furball/flight into public/flight/), shared with
// the authoritative world server. This module owns loading, the fixed-dt
// accumulator, and the typed-array boundary — one crossing per rendered
// frame. Layouts mirror world/games/furball/flight/encode.go and
// world/wasm/main.go exactly; a mismatch is a version bump, not a patch.

import { getErrorMessage } from '@mochi/web'

// Encoded state layout (float64 words).
export const SIZE = 56
export const STATE = {
  position: 0, // x y z
  velocity: 3,
  attitude: 6, // w x y z
  omega: 10,
  fuel: 13,
  engine: 14, // spool, reheat × 4 slots (airframes declare 0..4)
  stabilator: 22, // left right
  flaperon: 24,
  rudder: 26,
  slat: 27,
  flap: 28,
  speedbrake: 29,
  demand: 33,
  normal: 34,
  extension: 35,
  catapult: 36,
  stroke: 37,
  wire: 38,
  wow: 39,
  contact: 40,
  touch: 41, // occurred, sink, bank, kind
  stress: 54,
  time: 55,
  // Instrument tail appended by frame()/get():
  alpha: 56,
  beta: 57,
  nz: 58,
  mach: 59,
  cas: 60,
  power: 61, // achieved spool fraction across the airframe's engines
  stage: 62, // achieved reheat stage
} as const
const EXTRA = 7

export const DT = 1 / 240
const CAP = 30 // accumulator cap: tab throttling must not spiral into replay storms

// Control sample for one frame; the FCS interprets pitch/roll/yaw as
// demands, ±1.
export interface Controls {
  pitch: number
  roll: number
  yaw: number
  throttle: number
  speedbrake: number
  reheat: boolean
  brake: boolean
  gear: boolean
  hook: boolean
  launch: boolean
  override: boolean
  sequence: number
}

interface Core {
  version(): number
  init(world: string): string
  set(state: Uint8Array): string
  get(state: Uint8Array): string
  frame(input: Uint8Array, output: Uint8Array): string
  mark(input: Uint8Array): string
  ack(sequence: number, state: Uint8Array): number
  level(x: number, y: number, z: number, dx: number, dz: number, speed: number, fuel: number): string
  clear(): string
}

declare global {
  // eslint-disable-next-line no-var
  var furball_flight: Core | undefined
  // eslint-disable-next-line no-var
  var Go: new () => { importObject: WebAssembly.Imports; run(instance: WebAssembly.Instance): Promise<void> }
}

let core: Core | null = null
let failure: string | null = null

// Preallocated boundary buffers: the same memory every frame, viewed as
// bytes for the copy and floats for access.
const input = new Float64Array(8)
const input_bytes = new Uint8Array(input.buffer)
const output = new Float64Array(SIZE + EXTRA)
const output_bytes = new Uint8Array(output.buffer)
const exchange = new Float64Array(SIZE)
const exchange_bytes = new Uint8Array(exchange.buffer)

// flight_load fetches and starts the wasm core; call once at boot. Failure
// is loud and terminal — there is no TypeScript physics to fall back to.
export async function flight_load(): Promise<void> {
  if (core || failure) return
  try {
    await new Promise<void>((resolve, reject) => {
      if (globalThis.Go) return resolve()
      const script = document.createElement('script')
      script.src = new URL('flight/wasm_exec.js', location.href).href
      script.onload = () => resolve()
      script.onerror = () => reject(new Error('wasm_exec.js failed to load'))
      document.head.appendChild(script)
    })
    const response = await fetch(new URL('flight/flight.wasm', location.href).href)
    if (!response.ok) throw new Error('flight.wasm HTTP ' + response.status)
    const go = new globalThis.Go!()
    const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), go.importObject)
    void go.run(instance) // resolves only if the core exits — it never should
    const started = performance.now()
    while (!globalThis.furball_flight) {
      if (performance.now() - started > 5000) throw new Error('flight core did not export')
      await new Promise((r) => setTimeout(r, 10))
    }
    core = globalThis.furball_flight
  } catch (error) {
    failure = getErrorMessage(error, 'flight core load failed')
    console.error('flight core load failed:', failure)
  }
}

export function flight_ready(): boolean {
  return core !== null
}

export function flight_failure(): string | null {
  return failure
}

export function flight_version(): number {
  return core ? core.version() : 0
}

// flight_init builds the model against a world payload (environment +
// geometry, JSON per the Go contract). Returns true on success.
export function flight_init(world: object): boolean {
  if (!core) return false
  const error = core.init(JSON.stringify(world))
  if (error) console.error('flight init:', error)
  accumulator = 0
  return !error
}

// flight_set / flight_get exchange the full encoded state (spawns, resets,
// test scenarios, reconciliation source).
export function flight_set(state: Float64Array): void {
  exchange.set(state.subarray(0, SIZE))
  core?.set(exchange_bytes)
}

export function flight_get(): Float64Array {
  core?.get(output_bytes)
  return output
}

function fill(controls: Controls, count: number): void {
  input[0] = controls.pitch
  input[1] = controls.roll
  input[2] = controls.yaw
  input[3] = controls.throttle
  input[4] = controls.speedbrake
  input[5] =
    (controls.reheat ? 1 : 0) |
    (controls.brake ? 2 : 0) |
    (controls.gear ? 4 : 0) |
    (controls.hook ? 8 : 0) |
    (controls.launch ? 16 : 0) |
    (controls.override ? 32 : 0)
  input[6] = controls.sequence
  input[7] = count
}

let accumulator = 0

// steps.value reports how many fixed steps the last flight_frame ran.
export const steps = { value: 0 }

// flight_frame advances the model by elapsed wall seconds at the fixed
// timestep and returns the state+instrument buffer (valid until the next
// call).
export function flight_frame(controls: Controls, elapsed: number): Float64Array {
  accumulator += Math.max(0, elapsed)
  let count = Math.floor(accumulator / DT)
  if (count > CAP) {
    count = CAP
    accumulator = 0 // a long stall: drop the debt rather than fast-forward
  } else {
    accumulator -= count * DT
  }
  steps.value = count
  fill(controls, count)
  core?.frame(input_bytes, output_bytes)
  return output
}

// flight_mark records the post-frame state under the sample's sequence for
// later reconciliation (multiplayer prediction). count is how many fixed
// steps this sequence covers — every step since the previous mark, since
// input sends are rate-limited below the render rate.
export function flight_mark(controls: Controls, count: number): void {
  fill(controls, count)
  core?.mark(input_bytes)
}

// flight_ack reconciles against the server state for an acknowledged
// sequence; returns the divergence in metres, or -1 when the history is
// gone and the caller must hard-snap.
export function flight_ack(sequence: number, state: Float64Array): number {
  if (!core) return -1
  exchange.set(state.subarray(0, SIZE))
  return core.ack(sequence, exchange_bytes)
}

// flight_level places the model in trimmed level flight — the
// transient-free air spawn.
export function flight_level(x: number, y: number, z: number, dx: number, dz: number, speed: number, fuel: number): void {
  core?.level(x, y, z, dx, dz, speed, fuel)
  accumulator = 0
}

// flight_clear acknowledges contact events (touchdown record, crash probe)
// after the host has read them.
export function flight_clear(): void {
  core?.clear()
}
