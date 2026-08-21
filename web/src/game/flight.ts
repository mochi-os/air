// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The flight simulation core: a Go blade-element model compiled to wasm
// (built from world/games/air/flight into src/assets/), shared with
// the authoritative world server. This module owns loading, the fixed-dt
// accumulator, and the typed-array boundary — one crossing per rendered
// frame. Layouts mirror world/games/air/flight/encode.go and
// world/wasm/main.go exactly; a mismatch is a version bump, not a patch.

import { getErrorMessage } from '@mochi/web'
// Vite content-hashes these into the bundle (assets/flight-<hash>.wasm): the
// URL changes exactly when the bytes do, so stale-cache pairing of an old wasm
// with a fresh engine.js (the #72 trap-topple report) is impossible by
// construction — no manual version bumps, no cache:'reload'.
import wasm_exec_url from '../assets/wasm_exec.js?url'
import flight_wasm_url from '../assets/flight.wasm?url'
import { asset } from './preload'
import type { Fitment } from './stores'

// Encoded state layout (float64 words).
export const SIZE = 114 // 57 base + 40 element losses + 8 channel jams + lost mass + 3 gear-leg damages (#78) + pitch-damper washout + PA trim datum + buffet + roll-trim datum + external-tank fuel (#17; appended LAST so no earlier index moved)
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
  drag: 50, // added parasitic drag area, m² (dents, strikes)
  element: 57, // per-element loss 0..1 × 40 (zero = pristine)
  jam: 97, // per-channel restriction 0..1 × 8 (stabL, stabR, flapL, flapR, rudder, slat, brake)
  gear_harm: 106, // per-strut damage 0..1 × 3 (nose, left, right) — tyre blown past 0.3, leg folded past 0.7 (#78)
  loss: 105, // shed structure mass, kg
  datum: 110, // PA trim bias, rad of alpha (the pitch trim switch, landing configuration)
  buffet: 111, // aerodynamic buffet intensity 0..1 — the seat-of-pants shake cue
  bank: 112, // roll-trim datum, differential-flaperon stick fraction (the hat's roll half)
  external: 113, // external-tank fuel, kg over the attached tanks (#17) — burns before internal
  // Instrument tail appended by frame()/get() — starts at flight.Size (encode.go),
  // so it moves whenever the encoded state grows. #78's three gear words pushed
  // Size to 109 and this tail was left at 106, silently reading gear damage as
  // alpha/nz and nz as the throttle spool (#133 found it via a dead CAS box).
  alpha: 114,
  beta: 115,
  nz: 116,
  mach: 117,
  cas: 118,
  power: 119, // achieved spool fraction across the airframe's engines
  stage: 120, // achieved reheat stage
} as const
const EXTRA = 7

const DT = 1 / 240
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
  trim: number // -1..1 held pitch-trim rate, +1 = nose-up
  lean: number // -1..1 held roll-trim rate, +1 = right wing down
  reset: boolean // one-shot: zero the trim datums, re-datum the hold
  flap: number // flap switch: 0 AUTO, 1 HALF, 2 FULL
  brake: boolean
  gear: boolean
  hook: boolean
  probe: boolean // refuelling probe out (drag; the real ~300 KCAS limit stays procedural)
  launch: boolean
  override: boolean
  dump: boolean // fuel dump switch: the core drains toward the bingo floor while on
  port: boolean // port engine fuel OFF (the fire drill / runaway shutdown)
  starboard: boolean // starboard engine fuel OFF
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
  stores(mask: number): string
  catalog(aircraft: string): string
  approach(x: number, y: number, z: number, dx: number, dz: number, slope: number, fuel: number): number
  clear(): string
  hulk(index: number, aircraft: string, stores?: number): boolean
  volley(input: Uint8Array, output: Uint8Array): number
  fly(input: Uint8Array, output: Uint8Array): number
  blast(input: Uint8Array, output: Uint8Array): boolean
  progress(input: Uint8Array, output: Uint8Array): void
  round_launch(input: Uint8Array): string | null
  round_step(input: Uint8Array, output: Uint8Array): string | null
  round_ladder(input: Uint8Array, output: Uint8Array): string | null
  heater_ladder?(input: Uint8Array, output: Uint8Array): string | null
  round_distract(input: Uint8Array): boolean | string
  round_drop(input: Uint8Array): string | null
  bandit_init?(config: string): string
  bandit_place?(spawn: string): string
  bandit_mirror?(state: Uint8Array): string
  bandit_menace?(shots: Uint8Array, count: number): string
  bandit_step?(state: Uint8Array): number
  bandit_coast?(lean: number, state: Uint8Array): number
  racks?(index: number, mask: number): boolean
  bandit_mode?(): string
}

declare global {
   
  var air_flight: Core | undefined
   
  var Go: new () => { importObject: WebAssembly.Imports; run(instance: WebAssembly.Instance): Promise<void> }
}

let core: Core | null = null
let failure: string | null = null

// Preallocated boundary buffers: the same memory every frame, viewed as
// bytes for the copy and floats for access.
const input = new Float64Array(12)
const input_bytes = new Uint8Array(input.buffer)
const output = new Float64Array(SIZE + EXTRA)
const output_bytes = new Uint8Array(output.buffer)
const exchange = new Float64Array(SIZE)
const exchange_bytes = new Uint8Array(exchange.buffer)

// flight_load fetches and starts the wasm core; idempotent and single-flight
// (the setup menu boots it for the loadout catalog while the engine boots it
// for the mission — two concurrent instantiations would race). Failure is
// loud and terminal — there is no TypeScript physics to fall back to.
let loading: Promise<void> | null = null
export function flight_load(): Promise<void> {
  // Failure is RETRIABLE: `if (core || failure)` made one bad load —
  // a dropped fetch, wasm_exec blocked, the 30 s export timeout on a
  // hammered machine — permanent for the page, and every later mission
  // reported the stale error. A fresh mission now begins a fresh attempt;
  // only a live core short-circuits.
  if (core) return Promise.resolve()
  loading ??= load_core()
  return loading
}
async function load_core(): Promise<void> {
  failure = null
  try {
    await new Promise<void>((resolve, reject) => {
      if (globalThis.Go) return resolve()
      const script = document.createElement('script')
      script.src = wasm_exec_url
      script.onload = () => resolve()
      script.onerror = () => reject(new Error('wasm_exec.js failed to load'))
      document.head.appendChild(script)
    })
    // The preload module owns the download (single-flight with the menu's
    // early start, byte counting for the loading screen).
    const bytes = await asset(flight_wasm_url)
    const go = new globalThis.Go!()
    const { instance } = await WebAssembly.instantiate(bytes, go.importObject)
    // run() resolves only if the Go program EXITS — which only an unrecovered
    // panic causes. When it does, every later export call throws "Go program
    // has already exited", and the stale `core` used to satisfy flight_load
    // forever: the page was bricked until reload. A dead core now resets the
    // loader, so the next mission instantiates a fresh Go program from the
    // cached bytes and flies.
    void go.run(instance).then(() => {
      console.error('flight core exited — a panic killed the Go program; the next mission boots a fresh core')
      core = null
      loading = null
      failure = 'flight core exited'
      delete (globalThis as { air_flight?: unknown }).air_flight
    })
    const started = performance.now()
    while (!globalThis.air_flight) {
      // 30 s, not a snappier 5: the Go runtime's first-boot main-thread slice is at the
      // mercy of machine load (busy laptops, software rasterizers, headless captures),
      // and a slow boot must not be declared a terminal core failure
      if (performance.now() - started > 30000) throw new Error('flight core did not export')
      await new Promise((r) => setTimeout(r, 10))
    }
    core = globalThis.air_flight
  } catch (error) {
    failure = getErrorMessage(error, 'flight core load failed')
    console.error('flight core load failed:', failure)
    loading = null // retriable: the next flight_load begins a fresh attempt
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
    (controls.override ? 32 : 0) |
    (controls.probe ? 64 : 0) |
    (controls.reset ? 128 : 0) |
    (controls.dump ? 1 : 0) |
    (controls.port ? 256 : 0) |
    (controls.starboard ? 512 : 0)
  input[6] = controls.sequence
  input[7] = count
  input[8] = controls.reheat   // analog reheat (flag bit 1 retired)
  input[9] = controls.trim
  input[10] = controls.flap
  input[11] = controls.lean
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
const bandit_out = new Float64Array(SIZE + 5) // state plus the instrument tail (alpha, beta, nz, mach, cas) at the ownship's own indices (#33 debrief)
const bandit_bytes = new Uint8Array(bandit_out.buffer)
const menace = new Float64Array(64)
const menace_bytes = new Uint8Array(menace.buffer)

export function bandit_init(config: { level: string; seed: number; wrap: number; sky: string; night: boolean; missiles: boolean; weapons?: string; fuel?: number }): boolean {
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

// bandit_menace declares every missile in the air: a flat array of eight
// words each — position, velocity, shooter (0 the player, 1 the bandit),
// and phase (-1 a heater, otherwise the radar round's guidance phase). The
// client flies the rounds; the brain reads these stubs for its evasion, its
// radar-round defence, and its shoot-look-shoot discipline.
export function bandit_menace(shots: number[]): void {
  if (!core?.bandit_menace) return
  const count = Math.min(8, Math.floor(shots.length / 8))
  for (let i = 0; i < count * 8; i++) menace[i] = shots[i]
  core.bandit_menace(menace_bytes, count)
}

// bandit_step advances one 60 Hz frame; returns the bandit's encoded state
// plus its decisions: trigger, flare, an AMRAAM launch this frame (the
// client owns the round from there), the radar emitter state the RWR
// reads, whether the STT holds the player (datalink support for a
// bandit-shot round), and a chaff bloom (#43: its own magazine, no flare).
export function bandit_step(): { state: Float64Array; fire: boolean; flare: boolean; launch: boolean; emitter: number; locked: boolean; heater: boolean; chaff: boolean } | null {
  if (!core?.bandit_step) return null
  const flags = core.bandit_step(bandit_bytes)
  if (typeof flags !== 'number' || flags < 0) return null
  return { state: bandit_out, fire: (flags & 1) !== 0, flare: (flags & 2) !== 0,
    launch: (flags & 4) !== 0, emitter: (flags >> 3) & 3, locked: (flags & 32) !== 0, heater: (flags & 64) !== 0, chaff: (flags & 128) !== 0 }
}

// bandit_coast flies the DEAD bandit one frame on the real model: no thinking,
// the stick free so the FCS holds attitude, the levers as its pilot left them,
// and a standing roll so it spirals rather than gliding flat.
export function bandit_coast(lean: number): Float64Array | null {
  if (!core?.bandit_coast) return null
  if (core.bandit_coast(lean, bandit_bytes) < 0) return null
  return bandit_out
}

// bandit_mode reports the brain's chosen manoeuvre (press, defense, spiral...)
// for the flight recorder's developer-only doctrine channel (#212/#206).
export function bandit_mode(): string {
  return core?.bandit_mode ? core.bandit_mode() : ''
}

export function battle_hulk(index: number, aircraft: string, stores?: number): boolean {
  return !!core?.hulk(index, aircraft, stores ?? 0)
}

// battle_racks sets a hulk's attached-station mask (bit i = the airframe's
// store catalog index). A real aircraft's rails come from its flight model;
// a hulk has none, so the client pushes the bandit's mask as rounds leave —
// an empty rail must stop being a cook-off target.
export function battle_racks(index: number, stores: number): boolean {
  return !!(core?.racks && core.racks(index, stores))   // optional export: an older core simply has no rails to set
}

// battle_volley fires REAL rounds into the shared airborne set: identity 0 =
// the ownship shooting, 1 = the bandit. battle_fly resolves them tick by tick.
export function battle_volley(
  identity: number,
  shooter: { position: { x: number; y: number; z: number }; forward: { x: number; y: number; z: number }; up: { x: number; y: number; z: number }; right?: { x: number; y: number; z: number }; velocity?: { x: number; y: number; z: number } },
  rounds: number,
  tick: number,
): void {
  if (!core) return
  const b = battle_input
  b[0] = identity
  b[1] = shooter.position.x; b[2] = shooter.position.y; b[3] = shooter.position.z
  b[4] = shooter.forward.x; b[5] = shooter.forward.y; b[6] = shooter.forward.z
  b[7] = shooter.up.x; b[8] = shooter.up.y; b[9] = shooter.up.z
  // right = forward x up when the caller carries no basis
  const rx = shooter.right?.x ?? shooter.forward.y * shooter.up.z - shooter.forward.z * shooter.up.y
  const ry = shooter.right?.y ?? shooter.forward.z * shooter.up.x - shooter.forward.x * shooter.up.z
  const rz = shooter.right?.z ?? shooter.forward.x * shooter.up.y - shooter.forward.y * shooter.up.x
  b[10] = rx; b[11] = ry; b[12] = rz
  b[13] = shooter.velocity?.x ?? 0; b[14] = shooter.velocity?.y ?? 0; b[15] = shooter.velocity?.z ?? 0
  b[16] = rounds; b[17] = tick
  core.volley(battle_input_bytes, battle_output_bytes)
}

// battle_fly advances every airborne round one step: rounds from the ownship
// resolve against the bandit hulk (when aim is present), the bandit's against
// the ownship model. Impacts are in the BANDIT's body frame.
export function battle_fly(
  dt: number,
  invulnerable: boolean,
  aim: Aim | null,
): { bandit: number; own: number; impacts: { x: number; y: number; z: number }[] } {
  if (!core) return { bandit: 0, own: 0, impacts: [] }
  const b = battle_input
  b[0] = dt
  b[1] = invulnerable ? 1 : 0
  b[2] = aim ? 1 : 0
  if (aim) {
    b[3] = aim.position.x; b[4] = aim.position.y; b[5] = aim.position.z
    b[6] = aim.quaternion.w; b[7] = aim.quaternion.x; b[8] = aim.quaternion.y; b[9] = aim.quaternion.z
    b[10] = aim.velocity?.x ?? 0; b[11] = aim.velocity?.y ?? 0; b[12] = aim.velocity?.z ?? 0
  }
  core.fly(battle_input_bytes, battle_output_bytes)
  const count = Math.min(battle_output[2] || 0, 8)
  const impacts: { x: number; y: number; z: number }[] = []
  for (let n = 0; n < count; n++) {
    impacts.push({ x: battle_output[3 + 3 * n], y: battle_output[4 + 3 * n], z: battle_output[5 + 3 * n] })
  }
  return { bandit: battle_output[0], own: battle_output[1], impacts }
}

// battle_blast detonates a missile warhead at a world point against a target.
// battle_blast detonates a warhead. class scales the blast and fragment
// radii with the cube root of the charge: WARHEAD.heater is the 9M's 9.4 kg
// (the default), WARHEAD.radar the AIM-120's 22 kg directed-fragmentation charge.
export const WARHEAD = { heater: 1.0, radar: 2.0 }
export function battle_blast(target: number, point: { x: number; y: number; z: number }, aim: Aim | null, identity: number, tick: number, class_ = WARHEAD.heater): { kill: boolean; mask: number } {
  if (!core) return { kill: false, mask: 0 }
  const b = battle_input
  b[0] = target
  b[1] = point.x; b[2] = point.y; b[3] = point.z
  if (aim) {
    b[4] = aim.position.x; b[5] = aim.position.y; b[6] = aim.position.z
    b[7] = aim.quaternion.w; b[8] = aim.quaternion.x; b[9] = aim.quaternion.y; b[10] = aim.quaternion.z
  }
  b[11] = identity; b[12] = tick; b[13] = class_
  core.blast(battle_input_bytes, battle_output_bytes)
  return { kill: battle_output[0] !== 0, mask: battle_output[1] }
}

// battle_progress runs the damage cascade one frame for the ownship and
// every hulk; the returned view is valid until the next call. Layout:
// 0-5 ownship (fire L, fire R, burning, killed, mask, leak);
// 6+i*9.. per hulk (fire L, fire R, burning, killed, mask, thrust loss,
// wing loss, element total, leak) — #244 widened the stride for the leak.
export function battle_progress(throttle: number, tick: number, reset: boolean, secure: number): Float64Array {
  if (!core) return battle_output
  battle_input[0] = throttle
  battle_input[1] = tick
  battle_input[2] = reset ? 1 : 0
  battle_input[3] = secure // per-engine fuel-off bitmask (1 port, 2 starboard): the fire drill starves a secured engine's fire at any throttle
  core.progress(battle_input_bytes, battle_output_bytes)
  return battle_output
}

// ---- The AIM-120 round (#27 phase 2): the same Go integrator the
// multiplayer server flies, stepped per launched round through slot
// handles; the launch-zone ladder runs the identical model, so the
// cockpit's ranges can never disagree with the flight. Word layouts mirror
// wasm/round.go.

const round_input = new Float64Array(17)
const round_input_bytes = new Uint8Array(round_input.buffer)
const round_output = new Float64Array(15)
const round_output_bytes = new Uint8Array(round_output.buffer)

export interface Aimed {
  position: { x: number; y: number; z: number }
  velocity: { x: number; y: number; z: number }
}

export interface RoundState {
  alive: boolean
  phase: number // 0 midcourse, 1 active (husky), 2 pitbull, 3 loose
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  range: number // to the round's current estimate
  stale: number // seconds since the last datalink update
  time: number
  life: number
  fused: boolean
  mach: number
  least: number // closest approach to the target so far, m
}

export function round_launch(slot: number, position: { x: number; y: number; z: number }, velocity: { x: number; y: number; z: number }, estimate: Aimed | null, wrap: number, loft: boolean): void {
  if (!core) return
  const r = round_input
  r[0] = slot
  r[1] = position.x; r[2] = position.y; r[3] = position.z
  r[4] = velocity.x; r[5] = velocity.y; r[6] = velocity.z
  r[7] = estimate ? 0 : 1
  if (estimate) {
    r[8] = estimate.position.x; r[9] = estimate.position.y; r[10] = estimate.position.z
    r[11] = estimate.velocity.x; r[12] = estimate.velocity.y; r[13] = estimate.velocity.z
  }
  r[14] = wrap
  r[15] = loft ? 1 : 0
  core.round_launch(round_input_bytes)
}

export function round_step(slot: number, dt: number, support: Aimed | null, truth: Aimed | null): RoundState | null {
  if (!core) return null
  const r = round_input
  r[0] = slot
  r[1] = dt
  r[2] = support ? 1 : 0
  if (support) {
    r[3] = support.position.x; r[4] = support.position.y; r[5] = support.position.z
    r[6] = support.velocity.x; r[7] = support.velocity.y; r[8] = support.velocity.z
  }
  r[9] = truth ? 1 : 0
  if (truth) {
    r[10] = truth.position.x; r[11] = truth.position.y; r[12] = truth.position.z
    r[13] = truth.velocity.x; r[14] = truth.velocity.y; r[15] = truth.velocity.z
  }
  if (core.round_step(round_input_bytes, round_output_bytes) != null) return null
  const o = round_output
  return {
    alive: o[0] > 0.5, phase: o[1], x: o[2], y: o[3], z: o[4], vx: o[5], vy: o[6], vz: o[7],
    range: o[8], stale: o[9], time: o[10], life: o[11], fused: o[12] > 0.5, mach: o[13], least: o[14],
  }
}

export function round_ladder(shooter: Aimed, target: Aimed, wrap: number): { aero: number; max: number; escape: number; minimum: number; active: number } | null {
  if (!core) return null
  const r = round_input
  r[0] = shooter.position.x; r[1] = shooter.position.y; r[2] = shooter.position.z
  r[3] = shooter.velocity.x; r[4] = shooter.velocity.y; r[5] = shooter.velocity.z
  r[6] = target.position.x; r[7] = target.position.y; r[8] = target.position.z
  r[9] = target.velocity.x; r[10] = target.velocity.y; r[11] = target.velocity.z
  r[12] = wrap
  core.round_ladder(round_input_bytes, round_output_bytes)
  const o = round_output
  return { aero: o[0], max: o[1], escape: o[2], minimum: o[3], active: o[4] }
}

// heater_ladder is the AIM-9M's launch zone in the AMRAAM's shape (#47):
// Rmax is the outermost range the round arrives from against the target
// flying on as now (his present turn included), capped at what the seeker
// can lock at this aspect and burner state; escape is the no-escape rung;
// minimum the arming floor. The cockpit's SHOOT for the 9M reads this — and
// only with a radar lock, as the real jet does, because only the radar knows
// range.
export function heater_ladder(shooter: Aimed, target: Aimed, swing: { x: number; y: number; z: number }, lit: number, wrap: number): { aero: number; max: number; escape: number; minimum: number; active: number } | null {
  if (!core?.heater_ladder) return null
  const r = round_input
  r[0] = shooter.position.x; r[1] = shooter.position.y; r[2] = shooter.position.z
  r[3] = shooter.velocity.x; r[4] = shooter.velocity.y; r[5] = shooter.velocity.z
  r[6] = target.position.x; r[7] = target.position.y; r[8] = target.position.z
  r[9] = target.velocity.x; r[10] = target.velocity.y; r[11] = target.velocity.z
  r[12] = swing.x; r[13] = swing.y; r[14] = swing.z
  r[15] = lit; r[16] = wrap
  core.heater_ladder(round_input_bytes, round_output_bytes)
  const o = round_output
  return { aero: o[0], max: o[1], escape: o[2], minimum: o[3], active: o[4] }
}

// round_distract offers the seeker a chaff bloom (#29). The core's doppler
// gate decides: in the notch it seduces, out of it the velocity gate
// rejects it. Returns whether it took.
export function round_distract(slot: number, bloom: { x: number; y: number; z: number }, truth: Aimed): boolean {
  if (!core) return false
  const r = round_input
  r[0] = slot
  r[1] = bloom.x; r[2] = bloom.y; r[3] = bloom.z
  r[4] = truth.position.x; r[5] = truth.position.y; r[6] = truth.position.z
  r[7] = truth.velocity.x; r[8] = truth.velocity.y; r[9] = truth.velocity.z
  return core.round_distract(round_input_bytes) === true
}

export function round_drop(slot: number): void {
  if (!core) return
  round_input[0] = slot
  core.round_drop(round_input_bytes)
}

// flight_stores sets the attached-store bitmask over the airframe's fitment
// catalog (bit i = catalog entry i): the engine asserts the flown loadout and
// clears bits as stores depart, dropping their mass and carriage drag in the
// core. Tanks fill on the off-to-on transition and clamp on departure.
export function flight_stores(mask: number): void {
  core?.stores(mask)
}

// flight_catalog reads the named aircraft's fitment catalog from the core:
// the mask bit order, per-entry mass/drag/fuel, the default (bare) mask, and
// the internal fuel capacity and empty mass for gross-weight arithmetic.
export function flight_catalog(aircraft: string): { stores: Fitment[]; default: number; internal: number; empty: number } | null {
  const raw = core?.catalog(aircraft)
  if (!raw) return null
  try {
    return JSON.parse(raw) as { stores: Fitment[]; default: number; internal: number; empty: number }
  } catch {
    return null
  }
}

// flight_approach places the model on a trimmed on-speed descent — the landing
// spawn. The glideslope is in DEGREES below the horizon; it returns the
// throttle holding the trim, so the client's lever starts where the core put
// the engines rather than carrying its own measured constant (which goes stale
// the moment the airframe or the approach law moves).
export function flight_approach(x: number, y: number, z: number, dx: number, dz: number, slope: number, fuel: number): number {
  return (core?.approach(x, y, z, dx, dz, slope, fuel) as number) ?? 0
}
