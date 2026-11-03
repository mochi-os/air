// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { statSync } from 'fs'
import { fileURLToPath } from 'url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import stores_model_url from '../assets/stores.glb?url'

// Outside the shell, as a test runs: an asset is fetched directly.
vi.mock('@mochi/web', () => ({
  isInShell: () => false,
  initShellBridge: async () => ({}),
  shellGet: async () => null,
}))

// A response whose body the test feeds by hand, as a download arrives.
function feed(headers: Record<string, string>) {
  let push: (bytes: number) => void = () => {}
  let end: () => void = () => {}
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (bytes) => controller.enqueue(new Uint8Array(bytes))
      end = () => controller.close()
    },
  })
  return {
    response: new Response(body, { headers }),
    push: (n: number) => push(n),
    end: () => end(),
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('the loading percentage', () => {
  let preload: typeof import('./preload')
  beforeEach(async () => {
    vi.resetModules()
    preload = await import('./preload')
  })
  afterEach(() => vi.unstubAllGlobals())

  it('counts a compressed model against its size as built', async () => {
    const size = statSync(
      fileURLToPath(new URL('../assets/stores.glb', import.meta.url))
    ).size
    const download = feed({
      'Content-Encoding': 'br',
      'Content-Type': 'model/gltf-binary',
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => download.response)
    )

    const done = preload.asset(stores_model_url)
    await settle()
    const half = Math.floor(size / 2)
    download.push(half)
    await settle()
    expect(preload.progress().percent).toBe(Math.floor((half / size) * 100))
    download.push(size - half)
    download.end()
    expect((await done).byteLength).toBe(size)
    expect(preload.progress().percent).toBe(100)
  })

  it('takes a length only from a response that is not encoded', async () => {
    const plain = feed({ 'Content-Length': '200' })
    const packed = feed({ 'Content-Encoding': 'br', 'Content-Length': '40' })
    const responses = [plain.response, packed.response]
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => responses.shift()!)
    )

    void preload.asset('/elsewhere/plain.bin')
    await settle()
    plain.push(100)
    await settle()
    expect(preload.progress().percent).toBe(50)

    // The compressed length is not the decoded total: it adds nothing.
    void preload.asset('/elsewhere/packed.bin')
    await settle()
    packed.push(60)
    await settle()
    expect(preload.progress().percent).toBe(Math.floor((160 / 200) * 100))
  })
})

describe('through the shell', () => {
  afterEach(() => {
    vi.doUnmock('./carried')
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('takes a model the shell carried, counting its progress, and fetches nothing', async () => {
    const size = statSync(
      fileURLToPath(new URL('../assets/stores.glb', import.meta.url))
    ).size
    let report: (received: number) => void = () => {}
    let land: (bytes: ArrayBuffer) => void = () => {}
    vi.resetModules()
    vi.doMock('./carried', () => ({
      carried: (_url: string, progress?: (received: number) => void) => {
        report = progress ?? (() => {})
        return new Promise<ArrayBuffer>((resolve) => (land = resolve))
      },
    }))
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const preload = await import('./preload')

    const done = preload.asset(stores_model_url)
    await settle()
    const half = Math.floor(size / 2)
    report(half)
    expect(preload.progress().percent).toBe(Math.floor((half / size) * 100))
    land(new ArrayBuffer(size))
    expect((await done).byteLength).toBe(size)
    expect(preload.progress().percent).toBe(100)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('fetches it itself when the shell will not carry it', async () => {
    vi.resetModules()
    vi.doMock('./carried', () => ({ carried: async () => null }))
    const download = feed({ 'Content-Length': '10' })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => download.response)
    )
    const preload = await import('./preload')
    const done = preload.asset('/elsewhere/direct.bin')
    await settle()
    download.push(10)
    download.end()
    expect((await done).byteLength).toBe(10)
  })

  it('starts the count and the stall clock again when the shell fails part way', async () => {
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    let report: (received: number) => void = () => {}
    let fail: () => void = () => {}
    vi.resetModules()
    vi.doMock('./carried', () => ({
      carried: (_url: string, progress?: (received: number) => void) => {
        report = progress ?? (() => {})
        return new Promise<null>((resolve) => (fail = () => resolve(null)))
      },
    }))
    const download = feed({ 'Content-Length': '10' })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => download.response)
    )
    const preload = await import('./preload')
    const done = preload.asset('/elsewhere/broken.bin')
    await settle()
    report(7)
    clock = 15000
    fail()
    await settle()
    clock = 16000
    // The direct fetch has just begun: idle since it started, not since the
    // shell's last report.
    expect(preload.progress().idle).toBe(1000)
    download.push(10)
    download.end()
    const bytes = await done
    // Exactly the file: the shell's seven bytes are not added to it.
    expect(bytes.byteLength).toBe(10)
    expect(preload.progress().percent).toBe(100)
  })
})
