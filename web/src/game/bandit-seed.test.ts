// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { PRESETS, amraams, normalize, rounds } from './stores'

// engine.ts cannot be imported (WebGL at module scope): bandit_seed is cut out
// of its source and run on its own, as blast.test.ts's lift() does.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
function lift(name: string): string {
  const start = source.indexOf(`function ${name}(`)
  expect(start, `${name} in engine.ts`).toBeGreaterThan(0)
  const rest = source.slice(start)
  const end = /\n(?=\S)/.exec(rest.slice(1))
  return end ? rest.slice(0, end.index + 1) : rest
}

function seeded(replay: number): () => number {
  return new Function('demonstration_seed', `${lift('bandit_seed')}\nreturn bandit_seed`)(replay)
}

describe('the single-player bandit is seeded per mission', () => {
  it('draws a fresh seed each mission, never zero', () => {
    const draw = vi.spyOn(Math, 'random').mockReturnValueOnce(0.25).mockReturnValueOnce(0.75).mockReturnValueOnce(0)
    const bandit_seed = seeded(0)
    const first = bandit_seed(), second = bandit_seed(), lowest = bandit_seed()
    draw.mockRestore()
    expect(first).not.toEqual(second)
    expect(lowest).toBeGreaterThan(0)
  })

  it("draws the dead bandit's fall from that seed, a different lean for a different mission", () => {
    const lean = (seed: number) =>
      new Function('seed', `const bandit = {}, bandit_seeded = seed; ${/\n\t\t\tbandit\.lean \?\?=[^\n]*\n/.exec(source)?.[0] ?? ''} return bandit.lean`)(seed) as number
    expect(source).not.toMatch(/cfg\.seed/)
    const leans = [1, 2, 3, 99, 2147483647].map(lean)
    expect(new Set(leans).size).toBe(leans.length)
    for (const l of leans) expect(Math.abs(l)).toBeLessThanOrEqual(0.1)
    expect(lean(42)).toBe(lean(42)) // a replay falls as the flight did
  })

  it('replays the developer seed when one is given', () => {
    expect(seeded(42)()).toBe(42)
  })

  it('is what the bandit brain is armed with, not a constant', () => {
    expect(source).toMatch(/bandit_seeded=bandit_seed\(\);\n\t\tbandit_brain=bandit_init\(\{[^}]*seed: bandit_seeded,/)
    expect(source).not.toMatch(/bandit_init\(\{[^}]*seed: \d/)
  })
})

// The bandit is drawn, counted and racked on the fit its brain carries: the
// server's bots_loadout of the class bandit_init names. The BVR bandit flew the
// AMRAAMs and was drawn with six heaters on twin rails.
describe('the single-player bandit carries the fit its brain flies', () => {
  const fits = new Function(
    'stores_normalize',
    'stores_presets',
    `${source.slice(source.indexOf('const BOT_ARMED='), source.indexOf('let loadout_rev'))}\nreturn { BOT_ARMED, BOT_CLEAN, BOT_OPEN }`
  )(normalize, PRESETS)
  function fit(duel: string, missiles: boolean, fox2 = false) {
    return new Function(
      'cfg',
      'missiles_on',
      'BOT_ARMED',
      'BOT_CLEAN',
      'BOT_OPEN',
      'bandit_fox2',
      `${lift('bandit_class')}\n${lift('bandit_fit')}\nreturn bandit_fit()`
    )(
      { duel },
      () => missiles,
      fits.BOT_ARMED,
      fits.BOT_CLEAN,
      fits.BOT_OPEN,
      fox2
    )
  }

  it('flies the Fox 3 preset beyond visual range, tank included', () => {
    expect(fit('bvr', true)).toEqual(normalize(PRESETS.fox3))
    expect(fit('bvr', false)).toEqual(normalize(PRESETS.fox3))
    expect(amraams(fit('bvr', true))).toHaveLength(6)
  })

  it('flies the twin-rail heaters or the gun within visual range', () => {
    expect(rounds(fit('wvr', true))).toHaveLength(6)
    expect(amraams(fit('wvr', true))).toHaveLength(0)
    expect(rounds(fit('wvr', false))).toHaveLength(0)
  })

  // burstcheck.py meets the bandit's heaters head-on at full closure, which only
  // the BVR start allows with the missiles free from spawn, and there the open
  // class's AMRAAM killed the pilot before any heater merge.
  it('flies the Fox 2 fit beyond visual range when a probe asks for it (&fit=fox2)', () => {
    expect(rounds(fit('bvr', true, true))).toHaveLength(6)
    expect(amraams(fit('bvr', true, true))).toHaveLength(0)
    expect(source).toMatch(/\n\tbandit_fox2=devq\.get\("fit"\)==="fox2";/) // read with the other developer options, afresh each mission
  })

  it('names the class the same way bandit_init does', () => {
    expect(source).toMatch(/weapons: bandit_class\(\), hold: weapons_hold/)
    expect(source).toMatch(
      /function bandit_fit\(\)\{ const c=bandit_class\(\);/
    )
    expect(source).toMatch(/assign_loadout\(bandit, bandit_fit\(\)\)/)
  })
})

// The bandit's state crosses from the core into the buffer flight.ts gives it,
// and a copy fills only as much as the buffer holds: one sized for the state
// and the instruments alone lost the centre of mass behind them, and the
// bandit was drawn from its centre as though that were its datum. flight.ts
// cannot be imported here, so its declaration is read from the source and the
// built core (untracked; without one this is skipped) fills a buffer of that
// length.
const assets = fileURLToPath(new URL('../assets/', import.meta.url))
const built = existsSync(assets + 'flight.wasm') && existsSync(assets + 'wasm_exec.js')
describe.skipIf(!built)("the bandit's state", () => {
  interface Core {
    init(world: string): string
    bandit_init(config: string): string
    bandit_place(spawn: string): void
    bandit_step(output: Uint8Array, rounds: number): number
    bandit_coast(lean: number, output: Uint8Array): number
  }
  let core: Core
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

  it("arrives whole, the centre of mass at the ownship's index with it", () => {
    const flight = readFileSync(fileURLToPath(new URL('./flight.ts', import.meta.url)), 'utf8')
    const constant = (name: string) => Number(new RegExp(`const ${name} = (\\d+)`).exec(flight)?.[1])
    const center = Number(/center: (\d+),/.exec(flight)?.[1])
    const size = /const bandit_out = new Float64Array\(([^)]*)\)/.exec(flight)?.[1] as string
    expect(size).toBeDefined()
    const length = new Function('SIZE', 'EXTRA', `return ${size}`)(constant('SIZE'), constant('EXTRA')) as number
    expect(core.bandit_init(JSON.stringify({ level: 'expert', seed: 7, sky: 'clear', night: false, missiles: false }))).toBe('')
    core.bandit_place(JSON.stringify({ position: [0, 4000, 0], velocity: [0, 0, -200] }))
    for (const fly of [(b: Uint8Array) => core.bandit_step(b, 0), (b: Uint8Array) => core.bandit_coast(0, b)]) {
      const state = new Float64Array(length)
      expect(fly(new Uint8Array(state.buffer))).toBeGreaterThanOrEqual(0)
      expect(state[1]).toBeGreaterThan(3900) // the state itself
      expect(Math.hypot(state[center], state[center + 1], state[center + 2]), 'the centre of mass, some way from the datum').toBeGreaterThan(0.01)
    }
  })
})
