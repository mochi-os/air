// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// What the engine releases when it stops, and what it makes once rather than
// again each time. engine.ts cannot be imported (WebGL at module scope), so
// its code is lifted from the source and run against stand-ins.
const engine = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
function lift(name: string): string {
  const start = engine.indexOf(`\nfunction ${name}(`) + 1
  expect(start, name).toBeGreaterThan(0)
  const rest = engine.slice(start)
  const end = /\n(?=\S)/.exec(rest.slice(1))
  return end ? rest.slice(0, end.index + 1) : rest
}

// sandbox runs code with the names in vars read and written through it, and
// every other name an inert stand-in that answers any call or property
function sandbox(code: string, vars: Record<string, unknown>): void {
  const real = new Set(['Math', 'JSON', 'Object', 'Array', 'Number', 'String', 'Boolean', 'Set', 'Map', 'Proxy', 'Reflect', 'Infinity', 'NaN', 'undefined', 'console', 'globalThis'])
  const inert: unknown = new Proxy(function () {}, { get: (_, k) => (k === Symbol.toPrimitive ? () => 0 : inert), apply: () => inert, construct: () => inert as object })
  const scope = new Proxy(vars, {
    has: (_, k) => typeof k === 'string' && !real.has(k),
    get: (t, k) => (k === Symbol.unscopables ? undefined : k in t ? t[k as string] : inert),
    set: (t, k, v) => ((t[k as string] = v), true),
  })
  new Function('scope', `with (scope) { ${code}
 }`)(scope)
}

describe('an engine that stops', () => {
  const at = engine.indexOf('  function stop() {')
  const stop = engine.slice(at, engine.indexOf('\n  }\n', at) + 4).replace(/ as any/g, '')
  it('releases what it registered, then the renderer, then the GL context itself', () => {
    const order: string[] = []
    const vars = {
      teardown: [() => order.push('released')],
      renderer: { dispose: () => order.push('disposed'), forceContextLoss: () => order.push('lost') },
      playback: true,
      MULTIPLAYER: false,
      globe: null,
    }
    sandbox(`${stop} stop()`, vars)
    expect(order).toEqual(['released', 'disposed', 'lost'])
    expect(vars.teardown).toEqual([])
  })

  it('disposes the texture transcoder, whose workers outlive it otherwise', () => {
    let made = 0, disposed = 0
    class KTX2Loader {
      constructor() {
        made++
      }
      setTranscoderPath() {
        return this
      }
      detectSupport() {
        return this
      }
      dispose() {
        disposed++
      }
    }
    const vars = { teardown: [] as (() => void)[], ktx2: null, KTX2Loader, renderer: {} }
    sandbox(`const on_stop = (f) => teardown.push(f); ${lift('ktx2_loader')}
 ktx2_loader(); ktx2_loader()`, vars)
    for (const release of vars.teardown) release()
    expect([made, disposed]).toEqual([1, 1])
  })

  it('takes back the developer probes it published, and none a later engine has set since', () => {
    const at = engine.indexOf('  const dev_published')
    const block = engine.slice(at, engine.indexOf('\n', engine.indexOf('  on_stop(() => { for (const [key, value] of dev_published)', at)) + 1)
    expect(block).toContain('const dev_global')
    const vars = { teardown: [] as (() => void)[], made: {} as Record<string, unknown> }
    sandbox(`const on_stop = (f) => teardown.push(f); ${block.replace(/ as any|<PropertyKey, unknown>/g, '')}
      made.probe = () => 1; made.later = () => 2; made.log = [];
      dev_global.dev_test_probe = made.probe; dev_global.dev_test_log ??= made.log; dev_global.dev_test_later = () => 0`, vars)
    const scope = globalThis as unknown as Record<string, unknown>
    scope.dev_test_later = vars.made.later // a newer engine's, published after this one's
    const seen = [typeof scope.dev_test_probe, scope.dev_test_log === vars.made.log]
    for (const release of vars.teardown) release()
    expect(seen).toEqual(['function', true])
    expect([scope.dev_test_probe, scope.dev_test_log, scope.dev_test_later]).toEqual([undefined, undefined, vars.made.later])
    delete scope.dev_test_later
  })

  it('keeps a zoom it was still waiting to save', () => {
    const start = engine.indexOf('\nfunction zoom_persist(') + 1
    const block = engine.slice(start, engine.indexOf('\n', engine.indexOf('on_stop(()=>{ if(zoom_save)', start)) + 1)
    expect(block).toContain('zoom_pending')
    const saved: unknown[] = []
    const vars = {
      teardown: [] as (() => void)[],
      cfg: { view: 'hud' },
      zoom_held: {},
      zoom_target: 1.5,
      zoom_save: 0,
      on_config: (c: unknown) => saved.push(c),
      window: { setTimeout: () => 7 },
      clearTimeout: () => {},
    }
    sandbox(`const on_stop = (f) => teardown.push(f); ${block} zoom_persist()`, vars)
    expect(saved).toEqual([])
    for (const release of vars.teardown) release()
    expect(saved).toEqual([{ zoom_hud: 1.5 }])
  })
})

describe('the mirror bake', () => {
  it('draws its room with the one sphere, however many times it bakes', () => {
    let spheres = 0
    const THREE = new Proxy(
      {
        SphereGeometry: class {
          constructor() {
            spheres++
          }
        },
      },
      { get: (t, k) => (k in t ? t[k as 'SphereGeometry'] : class { fromScene() { return { texture: {}, dispose() {} } } add() {} dispose() {} }) }
    )
    const vault = /\nconst vault=[^\n]*\n/.exec(engine)?.[0] ?? ''
    expect(vault).not.toBe('')
    sandbox(`${vault}${lift('mirror_bake')}
 mirror_bake(); mirror_bake()`, { THREE, mirror_mats: [], mirror_env: null, sky_mat: { fragmentShader: '' } })
    expect(spheres).toBe(1)
  })
})

// A replay held - paused, or at its end - holds everything with the jets: the
// sea, and all that integrates over the frame's step.
describe('a replay held', () => {
  it('steps nothing: neither the sea nor the frame', () => {
    const line = /\n\t\t\tif\(playback\)\{ const rate=world_rate\(\); [^\n]*\n/.exec(engine)?.[0] ?? ''
    expect(line).not.toBe('')
    const seen = (held: boolean) => {
      const vars = { playback: {}, playback_held: held, framed: -1, dt: 0.016, steps: [] as number[] }
      sandbox(`const world_rate = () => 4, audio_pace = () => {}, sea_advance = (d) => steps.push(d), playback_step = (d) => steps.push(d)
        ${line}`, vars)
      return [vars.framed, ...vars.steps]
    }
    expect(seen(true)).toEqual([0, 0, 0])
    expect(seen(false)).toEqual([0.064, 0.064, 0.064])
  })
})

// A replay's core state carries the recording's clock, which the gauges that
// step on the core's own time read; a seek sets back those that only move on a
// later time than they hold.
describe("a replay's clock", () => {
  it('is the core state’s time', () => {
    let fed = -1
    const vars = {
      playback_out: new Float64Array(16),
      playback_clock: 42.5,
      STATE: new Proxy({}, { get: (_, k) => (k === 'time' ? 3 : 9) }),
      sync_core: (o: Float64Array) => {
        fed = o[3]
      },
    }
    sandbox(`${lift('playback_own')}\n playback_own({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, properties: {} }, 0.016)`, vars)
    expect(fed).toBe(42.5)
  })
  it('sets back the turn needle and the cabin altimeter on a seek', () => {
    const vars = {
      playback: { duration: 100, tracks: new Map(), own: 1 },
      yaw_state: { t: 80, heading: 0, rate: 0.1 },
      cabin_feet: 9000 as number | null,
      ownship: {},
      THREE: { MathUtils: { clamp: (v: number, a: number, b: number) => Math.min(b, Math.max(a, v)) } },
    }
    sandbox(`${lift('playback_seek')}\n playback_seek(10)`, vars)
    expect([vars.yaw_state.t, vars.cabin_feet]).toEqual([-Infinity, null])
  })
})
