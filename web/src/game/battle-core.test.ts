// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { PRESETS, mask, masked, resolve, type Fitment } from './stores'

// A store fire as single player meets it: gun rounds into the bandit's battle
// hulk through the built wasm under node, the battle output's word 63 naming
// the rounds whose motors burn on its rails, and the fire going out when the
// client's rack mask says the round has left. The core is a build product
// (assets/flight.wasm, untracked), so without one the suite is skipped.
const assets = fileURLToPath(new URL('../assets/', import.meta.url))
const built = existsSync(assets + 'flight.wasm') && existsSync(assets + 'wasm_exec.js')
interface Core {
  init(world: string): string
  level(x: number, y: number, z: number, dx: number, dz: number, speed: number, fuel: number): string
  catalog(aircraft: string): string
  hulk(index: number, aircraft: string, stores: number): boolean
  racks(index: number, stores: number): boolean
  volley(input: Uint8Array, output: Uint8Array): number
  fly(input: Uint8Array, output: Uint8Array): number
  progress(input: Uint8Array, output: Uint8Array): void
}
let core: Core
const input = new Float64Array(32), out = new Float64Array(64)
const sent = new Uint8Array(input.buffer), read = new Uint8Array(out.buffer)
const BANDIT = { x: 0, y: 4000, z: 0 }

// burst fires two rounds from 250 m dead astern of the hulk, both jets flying
// north at 200 m/s, and steps the battle one frame.
function burst(tick: number) {
  input.fill(0)
  input.set([0, BANDIT.x, BANDIT.y, BANDIT.z + 250, 0, 0, -1, 0, 1, 0, 1, 0, 0, 0, 0, -200, 2, tick])
  core.volley(sent, read)
  step(tick)
}

// step flies the rounds in the air one frame against the hulk, then runs the
// damage cascade with the fire drill's word, and leaves the cascade's words in
// out.
function step(tick: number, reset = false, bandit = BANDIT, drill = 0) {
  input.fill(0)
  input.set([1 / 60, 0, 1, bandit.x, bandit.y, bandit.z, 1, 0, 0, 0, 0, 0, -200])
  core.fly(sent, read)
  input.fill(0)
  input.set([0.8, tick, reset ? 1 : 0, drill])
  core.progress(sent, read)
}

describe.skipIf(!built)('a store fire in the battle core', () => {
  beforeAll(async () => {
    const require = createRequire(import.meta.url)
    require(assets + 'wasm_exec.js')
    const g = globalThis as unknown as { Go: new () => { importObject: WebAssembly.Imports; run(instance: WebAssembly.Instance): Promise<void> }; air_flight?: Core }
    const go = new g.Go()
    const { instance } = await WebAssembly.instantiate(readFileSync(assets + 'flight.wasm'), go.importObject)
    void go.run(instance)
    for (let k = 0; k < 500 && !g.air_flight; k++) await new Promise((r) => setTimeout(r, 10))
    core = g.air_flight as Core
  }, 30000)

  it('names the burning round on the bandit, and puts the fire out when the round leaves', () => {
    const book = resolve(JSON.parse(core.catalog('fa18c')) as { stores: Fitment[]; default: number; internal: number; empty: number })
    const rack = mask(PRESETS.fox2, 0, book)
    let tick = 1, lit: string[] = []
    for (let attempt = 0; attempt < 40 && !lit.length; attempt++) {
      step(tick++, true) // a fresh hulk each attempt: a kill ends the attempt
      core.hulk(0, 'fa18c', rack)
      for (let frame = 0; frame < 60 && !lit.length && !out[9]; frame++) {
        burst(tick++)
        lit = masked(out[63], book.index)
      }
    }
    expect(lit.length).toBeGreaterThan(0)
    for (const name of lit) expect(name).toMatch(/^(tip|9m|120c)/) // only a round on a rail burns there
    expect(out[62]).toBe(0) // no ownship model, no ownship fires
    for (let k = 0; k < 30; k++) step(tick++)
    expect(masked(out[63], book.index)).toEqual(lit) // the motor burns on while the round is carried
    const gone = lit.reduce((m, name) => m - 2 ** book.index.get(name)!, rack)
    core.racks(0, gone)
    step(tick++)
    expect(out[63]).toBe(0) // the round has left the rail: nothing burns there
  }, 60000)

  // The ownship's engine fire feeds on its throttle and dies to the pilot's
  // drill (word 3: 1 port secured, 2 starboard, 4 the extinguisher). Neither
  // reached the cascade: progress cleared its output in the buffer it had read
  // its input into, so every fire starved at a zero throttle and the bottle
  // never fired.
  it("feeds the ownship's engine fire on the throttle and puts it out with the drill", () => {
    core.init(JSON.stringify({ aircraft: 'fa18c', environment: { seed: 1 }, world: { sea: 3 } }))
    core.level(0, 3000, 0, 0, -1, 200, 3000)
    let tick = 100000, alight = false
    for (let attempt = 0; attempt < 40 && !alight; attempt++) {
      step(tick++, true)
      for (let frame = 0; frame < 60 && !alight && !out[3]; frame++) {
        input.fill(0)
        input.set([1, 0, 3000, 250, 0, 0, -1, 0, 1, 0, 1, 0, 0, 0, 0, -200, 2, tick]) // the bandit's guns, from 250 m astern of us
        core.volley(sent, read)
        step(tick++)
        alight = out[0] > 0 || out[1] > 0
      }
    }
    expect(alight).toBe(true)
    const bay = out[0] > 0 ? 0 : 1, lit = out[bay]
    for (let k = 0; k < 30; k++) step(tick++)
    expect(out[bay]).toBeGreaterThan(lit) // fed at 0.8 throttle, it grows
    step(tick++, false, BANDIT, (bay === 0 ? 1 : 2) | 4) // that engine secured and the bottle into its bay
    expect(out[bay]).toBe(0)
  }, 60000)
})
