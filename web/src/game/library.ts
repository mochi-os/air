// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
// The parsed-model library: the models every match draws, parsed once for the
// session and shared. The menu warms it in the background as the downloads
// land, the loadout preview and the flight take their prototypes from it, and
// every consumer clones what it takes - a stocked scene is never posed,
// dressed or re-textured in place. A parse needs a renderer only to pick the
// compressed-texture format this GPU decodes, so the warm-up borrows a hidden
// one and hands its context back when the last model is in; the textures
// upload lazily to whichever canvas draws them.
import * as THREE from 'three'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import amraam_model_url from '../assets/aim120c.glb?url'
import fa18c_model_url from '../assets/fa18c.glb?url'
import stores_model_url from '../assets/stores.glb?url'
import { load } from './model'
import { asset } from './preload'

// Tools are the library's dependencies, injectable so the cache can be tested
// without a download, a GLTF parse or a GPU.
export interface Tools {
  fetch: (url: string) => Promise<ArrayBuffer>
  parse: (bytes: ArrayBuffer, renderer: THREE.WebGLRenderer) => Promise<GLTF>
  hidden: () => THREE.WebGLRenderer | null // a renderer for the warm-up's format detection; null where WebGL is missing
  idle: (work: () => void) => void // when the browser has a moment
}

function offscreen(): THREE.WebGLRenderer | null {
  try {
    return new THREE.WebGLRenderer({ antialias: false, alpha: true })
  } catch {
    return null // no WebGL 2 (#55): the consumers parse on their own renderers, which will fail the same way and say so
  }
}

function later(work: () => void): void {
  const w = window as unknown as {
    requestIdleCallback?: (
      work: () => void,
      options?: { timeout: number }
    ) => void
  }
  if (w.requestIdleCallback) w.requestIdleCallback(work, { timeout: 2000 })
  else setTimeout(work, 200)
}

export const TOOLS: Tools = {
  fetch: asset,
  parse: load,
  hidden: offscreen,
  idle: later,
}

const stock = new Map<string, Promise<GLTF>>()
let warmed = false

// model returns a URL's parsed model, parsing it once: a second asker joins
// the parse in flight, a later one gets the result. A failed parse is dropped
// so the next ask tries again, the way preload drops a failed download.
export function model(
  url: string,
  renderer: THREE.WebGLRenderer,
  tools: Tools = TOOLS
): Promise<GLTF> {
  const held = stock.get(url)
  if (held) return held
  const parsing = (async () => tools.parse(await tools.fetch(url), renderer))()
  stock.set(url, parsing)
  parsing.catch(() => {
    if (stock.get(url) === parsing) stock.delete(url)
  })
  return parsing
}

// WARM is what every match needs, in the order the menu parses it: the jet
// first, then what hangs on it.
export const WARM = [fa18c_model_url, stores_model_url, amraam_model_url]

// warm parses the listed models in order, each when the browser is idle, on
// one hidden renderer released once the last is in. Idempotent: the menu
// mounts more than once a session. Resolves when the warm-up is over, a
// failed parse included - the consumer that needs that model asks again.
export function warm(
  urls: string[] = WARM,
  tools: Tools = TOOLS
): Promise<void> {
  if (warmed) return Promise.resolve()
  warmed = true
  return new Promise((done) => {
    let renderer: THREE.WebGLRenderer | null | undefined
    const pending = urls.filter((url) => !stock.has(url))
    const next = () => {
      const url = pending.shift()
      if (!url) {
        if (renderer) {
          renderer.forceContextLoss()
          renderer.dispose()
        }
        return done()
      }
      tools.idle(() => {
        if (renderer === undefined) renderer = tools.hidden()
        if (!renderer) return done()
        model(url, renderer, tools)
          .catch(() => {})
          .then(next)
      })
    }
    next()
  })
}

// reset empties the library and forgets the warm-up: for tests, which share
// the module across cases.
export function reset(): void {
  stock.clear()
  warmed = false
}
