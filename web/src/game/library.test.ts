// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type * as THREE from 'three'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { beforeEach, describe, expect, it } from 'vitest'
import { WARM, model, reset, warm, type Tools } from './library'

// The parsed-model library: one parse per model for the session, shared by
// the loadout preview and the flight, warmed by the menu on a hidden renderer
// that is released when the last model is in. Everything here runs on
// stand-ins: no download, no GLTF, no GPU.
interface Renderer {
  lost: number
  disposed: number
}
function renderer(): Renderer & THREE.WebGLRenderer {
  const r = {
    lost: 0,
    disposed: 0,
    forceContextLoss() {
      r.lost++
    },
    dispose() {
      r.disposed++
    },
  }
  return r as unknown as Renderer & THREE.WebGLRenderer
}
// A controllable parse: each call's promise resolves or rejects on demand.
interface Call {
  url: string
  renderer: THREE.WebGLRenderer
  resolve: (g: GLTF) => void
  reject: (e: Error) => void
}
function tools(hidden: () => THREE.WebGLRenderer | null = renderer) {
  const calls: Call[] = []
  const idle: (() => void)[] = []
  const fetched: string[] = []
  const t: Tools = {
    fetch: async (url) => {
      fetched.push(url)
      return new ArrayBuffer(4)
    },
    parse: (bytes, r) =>
      new Promise<GLTF>((resolve, reject) => {
        // the url rides in the fetch order: parse n is fetch n
        calls.push({ url: fetched[calls.length], renderer: r, resolve, reject })
        void bytes
      }),
    hidden,
    idle: (work) => idle.push(work),
  }
  // settle drains the microtasks so a fetch has reached its parse
  const settle = () => new Promise((r) => setTimeout(r, 0))
  return { t, calls, idle, fetched, settle }
}
const gltf = (name: string) => ({ scene: { name } }) as unknown as GLTF

describe('the library', () => {
  beforeEach(() => reset())

  it('parses a model once and hands the same parse to every asker', async () => {
    const { t, calls, fetched, settle } = tools()
    const r = renderer()
    const first = model('jet.glb', r, t)
    const second = model('jet.glb', r, t)
    expect(second).toBe(first)
    await settle()
    expect(fetched).toEqual(['jet.glb'])
    expect(calls).toHaveLength(1)
    calls[0].resolve(gltf('jet'))
    expect((await first).scene.name).toBe('jet')
    expect((await model('jet.glb', renderer(), t)).scene.name).toBe('jet') // a later asker, another renderer: the result, no parse
    expect(calls).toHaveLength(1)
  })

  it('drops a failed parse so the next ask tries again', async () => {
    const { t, calls, settle } = tools()
    const r = renderer()
    const first = model('jet.glb', r, t)
    await settle()
    calls[0].reject(new Error('bad glTF'))
    await expect(first).rejects.toThrow('bad glTF')
    const second = model('jet.glb', r, t)
    expect(second).not.toBe(first)
    await settle()
    expect(calls).toHaveLength(2)
    calls[1].resolve(gltf('jet'))
    expect((await second).scene.name).toBe('jet')
  })

  it('warms the standard list in order, each when idle, on one hidden renderer released once the last is in', async () => {
    const hidden = renderer()
    let made = 0
    const { t, calls, idle, settle } = tools(() => {
      made++
      return hidden
    })
    const over = warm(WARM, t)
    expect(idle).toHaveLength(1) // the first parse waits for an idle moment
    expect(calls).toHaveLength(0)
    for (let i = 0; i < WARM.length; i++) {
      idle[i]()
      await settle()
      expect(calls).toHaveLength(i + 1)
      expect(calls[i].url).toBe(WARM[i])
      expect(calls[i].renderer).toBe(hidden)
      expect(hidden.lost).toBe(0) // the context lives until the last model is in
      calls[i].resolve(gltf(WARM[i]))
      await settle()
    }
    await over
    expect(made).toBe(1)
    expect(hidden.lost).toBe(1)
    expect(hidden.disposed).toBe(1)
    expect(idle).toHaveLength(WARM.length)
  })

  it('lets a consumer join the warm-up parse, and hands the warmed model to the flight later', async () => {
    const { t, calls, idle, settle } = tools()
    const over = warm(['jet.glb', 'stores.glb'], t)
    idle[0]()
    await settle()
    const own = renderer()
    const joined = model('jet.glb', own, t) // the preview asks while the menu is parsing
    await settle()
    expect(calls).toHaveLength(1)
    calls[0].resolve(gltf('jet'))
    expect((await joined).scene.name).toBe('jet')
    await settle() // the warm-up moves on after its own then
    idle[1]()
    await settle()
    calls[1].resolve(gltf('stores'))
    await over
    expect((await model('stores.glb', own, t)).scene.name).toBe('stores')
    expect(calls).toHaveLength(2)
  })

  it('skips what is already stocked, does nothing without WebGL, and runs once', async () => {
    const { t, calls, idle, settle } = tools()
    const r = renderer()
    void model('jet.glb', r, t)
    await settle()
    calls[0].resolve(gltf('jet'))
    const over = warm(['jet.glb', 'stores.glb'], t)
    idle[0]()
    await settle()
    expect(calls).toHaveLength(2)
    expect(calls[1].url).toBe('stores.glb')
    calls[1].resolve(gltf('stores'))
    await over
    await warm(['aim120c.glb'], t) // idempotent: no second warm-up this session
    expect(idle).toHaveLength(1)
    reset()
    const bare = tools(() => null)
    await bare.t.hidden() // no WebGL
    const none = warm(['jet.glb'], bare.t)
    bare.idle[0]()
    await none
    expect(bare.calls).toHaveLength(0)
  })

  it('keeps a failed warm-up parse from stopping the rest', async () => {
    const { t, calls, idle, settle } = tools()
    const over = warm(['jet.glb', 'stores.glb'], t)
    idle[0]()
    await settle()
    calls[0].reject(new Error('bad glTF'))
    await settle()
    idle[1]()
    await settle()
    expect(calls).toHaveLength(2)
    expect(calls[1].url).toBe('stores.glb')
    calls[1].resolve(gltf('stores'))
    await over
  })
})

describe('the wiring', () => {
  const read = (path: string) =>
    readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
  const engine = read('./engine.ts')
  const preview = read('../components/LoadoutPreview.tsx')
  const index = read('../routes/index.tsx')
  const preload = read('./preload.ts')
  const loader = read('./model.ts')

  it('is warmed by the menu after the downloads start, and the downloads include what hangs on the jet', () => {
    expect(index).toMatch(/preload\(\)\n[\s\S]{0,600}?void warm\(\)/)
    expect(preload).toMatch(
      /begin\(stores_model_url\)\n\s+begin\(amraam_model_url\)/
    )
  })

  it('is where the flight takes its jet, stores and missile from, cloning each', () => {
    expect(engine).toMatch(
      /const stocked=await model_stock\(spec\.url, renderer\);/
    )
    expect(engine).toMatch(
      /const gltf=\{ scene:stocked\.scene\.clone\(true\), animations:stocked\.animations \};/
    )
    expect(engine).toMatch(
      /async function load_split\(url\)\{ return \(await model_stock\(url, renderer\)\)\.scene\.clone\(true\); \}/
    )
    expect(engine).toMatch(/const lit=mm\.clone\(\); lit\.emissiveMap=mm\.map;/) // the cockpit backlight on this jet's own copy of the material
    expect(engine).not.toMatch(/loader\.parse\(clean, "",\n\t\t\tasync gltf=>/)
  })

  it('is where the loadout preview takes its models from, cloning before posing, with a loading line until the first render', () => {
    expect(preview).toMatch(
      /model\(fa18c_model_url, renderer\),\n\s+model\(stores_model_url, renderer\),\n\s+model\(amraam_model_url, renderer\),/
    )
    expect(preview).toMatch(/airframe = jet\.scene\.clone\(true\)/)
    expect(preview).toMatch(/racks = stores\.scene\.clone\(true\)/)
    expect(preview).toMatch(
      /amraam = normalize_round\(round\.scene\.clone\(true\)\)/
    )
    expect(preview).toMatch(/\{!ready && \(/)
    expect(preview).toMatch(/<Trans>Loading aircraft<\/Trans>/)
    expect(preview).toMatch(
      /settled = true\n\s+flushSync\(\(\) => setReady\(true\)\)/
    )
  })

  it('decodes textures with the anisotropy the flight always gave them', () => {
    expect(loader).toMatch(/texture\.anisotropy = anisotropy/)
    expect(loader).toMatch(/renderer\.capabilities\.getMaxAnisotropy\(\)/)
  })
})
