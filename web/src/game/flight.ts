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
export const SIZE = 109 // 57 base + 40 element losses + 8 channel jams + lost mass + 3 gear-leg damages (#78, flight Version 24)
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
  engine_harm: 45, // per-engine thrust loss × 4 (#78 damage words)
  leak: 49, // fuel loss, kg/s
  element: 57, // per-element loss 0..1 × 40 (zero = pristine)
  jam: 97, // per-channel restriction 0..1 × 8 (stabL, stabR, flapL, flapR, rudder, slat, brake)
  gear_harm: 106, // per-strut damage 0..1 × 3 (nose, left, right) — tyre blown past 0.3, leg folded past 0.7 (#78)
  loss: 105, // shed structure mass, kg
  // Instrument tail appended by frame()/get() — starts at flight.Size (encode.go),
  // so it moves whenever the encoded state grows. #78's three gear words pushed
  // Size to 109 and this tail was left at 106, silently reading gear damage as
  // alpha/nz and nz as the throttle spool (#133 found it via a dead CAS box).
  alpha: 109,
  beta: 110,
  nz: 111,
  mach: 112,
  cas: 113,
  power: 114, // achieved spool fraction across the airframe's engines
  stage: 115, // achieved reheat stage
} as const
const EXTRA = 7

export const DT = 1 / 240
// Bump on any flight.wasm rebuild that must reach already-loaded browsers. The
// cache:'reload' fetch below makes this belt-and-suspenders, but the version
// query also breaks any entry a proxy or old cache is still pinning by URL.
const WASM_VERSION = '2026-07-13a' // burst wire gains shooter/target velocities (time-of-flight gunnery)
const CAP = 30 // accumulator cap: tab throttling must not spiral into replay storms

// Control sample for one frame; the FCS interprets pitch/roll/yaw as
// demands, ±1.
export interface Controls {
  pitch: number
  roll: number
  yaw: number
  throttle: number
  speedbrake: number
  reheat: number // commanded afterburner-zone fraction 0..1 (0 = dry); the core quantizes to the five F404 zones
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
  hulk(index: number, aircraft: string): boolean
  burst(input: Uint8Array, output: Uint8Array): number
  blast(input: Uint8Array, output: Uint8Array): boolean
  progress(input: Uint8Array, output: Uint8Array): void
  bandit_init?(config: string): string
  bandit_place?(spawn: string): string
  bandit_mirror?(state: Uint8Array): string
  bandit_menace?(shots: Uint8Array, count: number): string
  bandit_step?(state: Uint8Array): number
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
const input = new Float64Array(9)
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
      script.src = new URL('flight/wasm_exec.js?v=' + WASM_VERSION, location.href).href
      script.onload = () => resolve()
      script.onerror = () => reject(new Error('wasm_exec.js failed to load'))
      document.head.appendChild(script)
    })
    // cache: 'reload' bypasses the browser HTTP cache on EVERY load — the wasm
    // is a build product with no content hash in its name, and browsers serve
    // programmatic fetches from cache even across hard refreshes (the same trap
    // documented for the model glb). A stale wasm paired with a fresh engine.js
    // silently runs old physics under new geometry (the #72 trap-topple report).
    const response = await fetch(new URL('flight/flight.wasm?v=' + WASM_VERSION, location.href).href, { cache: 'reload' })
    if (!response.ok) throw new Error('flight.wasm HTTP ' + response.status)
    const go = new globalThis.Go!()
    const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), go.importObject)
    void go.run(instance) // resolves only if the core exits — it never should
    const started = performance.now()
    while (!globalThis.furball_flight) {
      // 30 s, not a snappier 5: the Go runtime's first-boot main-thread slice is at the
      // mercy of machine load (busy laptops, software rasterizers, headless captures),
      // and a slow boot must not be declared a terminal core failure
      if (performance.now() - started > 30000) throw new Error('flight core did not export')
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
    (controls.brake ? 2 : 0) |
    (controls.gear ? 4 : 0) |
    (controls.hook ? 8 : 0) |
    (controls.launch ? 16 : 0) |
    (controls.override ? 32 : 0)
  input[6] = controls.sequence
  input[7] = count
  input[8] = controls.reheat   // analog reheat (flag bit 1 retired)
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

// ---- Battle (single-player damage authority, #78) ----------------------
// The same Go battle package the multiplayer server runs natively judges
// SP hits through these wrappers. Layouts mirror world/wasm/battle.go.

const battle_input = new Float64Array(26)
const battle_input_bytes = new Uint8Array(battle_input.buffer)
const battle_output = new Float64Array(64)
const battle_output_bytes = new Uint8Array(battle_output.buffer)

// Event mask bits (world/wasm/battle.go).
export const BATTLE = { fire: 1, pilot: 2, explode: 4, jam: 8, shed: 16 } as const

export interface Aim {
  position: { x: number; y: number; z: number }
  quaternion: { w: number; x: number; y: number; z: number }
  velocity?: { x: number; y: number; z: number } // the target's motion carries it across the rounds' time of flight
}

// battle_hulk builds or resets the model-less target body at an index
// (0 = the bandit, 1.. = neutral traffic).
// ============================================================ bandit boundary
// The SP joust opponent: the same brain the server flies for multiplayer
// bots, on a second flight core inside the same wasm module.

const mirror = new Float64Array(SIZE + 1)
const mirror_bytes = new Uint8Array(mirror.buffer)
const bandit_out = new Float64Array(SIZE)
const bandit_bytes = new Uint8Array(bandit_out.buffer)
const menace = new Float64Array(36)
const menace_bytes = new Uint8Array(menace.buffer)

export function bandit_init(config: { level: string; seed: number; wrap: number; sky: string; night: boolean }): boolean {
  if (!core?.bandit_init) return false
  const error = core.bandit_init(JSON.stringify(config))
  if (error) console.error('bandit init:', error)
  return !error
}

export function bandit_spawn(position: { x: number; y: number; z: number }, velocity: { x: number; y: number; z: number }): void {
  core?.bandit_place?.(JSON.stringify({ position: [position.x, position.y, position.z], velocity: [velocity.x, velocity.y, velocity.z] }))
}

// bandit_mirror reflects the player into the bandit's arena: the encoded own
// state, whether the player is firing (tracer perception), and alive.
export function bandit_mirror(state: Float64Array, firing: boolean, alive: boolean): void {
  if (!core?.bandit_mirror) return
  mirror.set(state.subarray(0, SIZE))
  mirror[SIZE] = (firing ? 1 : 0) | (alive ? 2 : 0)
  core.bandit_mirror(mirror_bytes)
}

// bandit_menace declares the player's missiles chasing the bandit: a flat
// array of six words each (position, velocity), up to six missiles.
export function bandit_menace(shots: number[]): void {
  if (!core?.bandit_menace) return
  const count = Math.min(6, Math.floor(shots.length / 6))
  for (let i = 0; i < count * 6; i++) menace[i] = shots[i]
  core.bandit_menace(menace_bytes, count)
}

// bandit_step advances one 60 Hz frame; returns the bandit's encoded state
// plus its trigger and flare decisions, or null when the core is absent.
export function bandit_step(): { state: Float64Array; fire: boolean; flare: boolean } | null {
  if (!core?.bandit_step) return null
  const flags = core.bandit_step(bandit_bytes)
  if (typeof flags !== 'number' || flags < 0) return null
  return { state: bandit_out, fire: (flags & 1) !== 0, flare: (flags & 2) !== 0 }
}

export function battle_hulk(index: number, aircraft: string): boolean {
  return !!core?.hulk(index, aircraft)
}

// battle_burst fires rounds at a target: -1 = the ownship model (the
// bandit shooting the player), else a hulk index. Returns hits + events.
export function battle_burst(
  target: number,
  shooter: { position: { x: number; y: number; z: number }; forward: { x: number; y: number; z: number }; up: { x: number; y: number; z: number }; velocity?: { x: number; y: number; z: number } },
  aim: Aim | null,
  rounds: number,
  identity: number,
  tick: number,
): { hits: number; mask: number } {
  if (!core) return { hits: 0, mask: 0 }
  const b = battle_input
  b[0] = target
  b[1] = shooter.position.x; b[2] = shooter.position.y; b[3] = shooter.position.z
  b[4] = shooter.forward.x; b[5] = shooter.forward.y; b[6] = shooter.forward.z
  b[7] = shooter.up.x; b[8] = shooter.up.y; b[9] = shooter.up.z
  if (aim) {
    b[10] = aim.position.x; b[11] = aim.position.y; b[12] = aim.position.z
    b[13] = aim.quaternion.w; b[14] = aim.quaternion.x; b[15] = aim.quaternion.y; b[16] = aim.quaternion.z
  }
  b[17] = rounds; b[18] = identity; b[19] = tick
  b[20] = shooter.velocity?.x ?? 0; b[21] = shooter.velocity?.y ?? 0; b[22] = shooter.velocity?.z ?? 0
  b[23] = aim?.velocity?.x ?? 0; b[24] = aim?.velocity?.y ?? 0; b[25] = aim?.velocity?.z ?? 0
  core.burst(battle_input_bytes, battle_output_bytes)
  return { hits: battle_output[0], mask: battle_output[1] }
}

// battle_blast detonates a missile warhead at a world point against a target.
export function battle_blast(target: number, point: { x: number; y: number; z: number }, aim: Aim | null, identity: number, tick: number): { kill: boolean; mask: number } {
  if (!core) return { kill: false, mask: 0 }
  const b = battle_input
  b[0] = target
  b[1] = point.x; b[2] = point.y; b[3] = point.z
  if (aim) {
    b[4] = aim.position.x; b[5] = aim.position.y; b[6] = aim.position.z
    b[7] = aim.quaternion.w; b[8] = aim.quaternion.x; b[9] = aim.quaternion.y; b[10] = aim.quaternion.z
  }
  b[11] = identity; b[12] = tick
  core.blast(battle_input_bytes, battle_output_bytes)
  return { kill: battle_output[0] !== 0, mask: battle_output[1] }
}

// battle_progress runs the damage cascade one frame for the ownship and
// every hulk; the returned view is valid until the next call. Layout:
// 0-5 ownship (fire L, fire R, burning, killed, mask, leak);
// 6+i*8.. per hulk (fire L, fire R, burning, killed, mask, thrust loss,
// wing loss, element total).
export function battle_progress(throttle: number, tick: number, reset: boolean): Float64Array {
  if (!core) return battle_output
  battle_input[0] = throttle
  battle_input[1] = tick
  battle_input[2] = reset ? 1 : 0
  core.progress(battle_input_bytes, battle_output_bytes)
  return battle_output
}
