// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import aim9m_model_url from '../assets/aim9m.glb?url'

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
      fileURLToPath(new URL('../assets/aim9m.glb', import.meta.url))
    ).size
    const download = feed({
      'Content-Encoding': 'br',
      'Content-Type': 'model/gltf-binary',
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => download.response)
    )

    const done = preload.asset(aim9m_model_url)
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

describe('a failed download', () => {
  let preload: typeof import('./preload')
  beforeEach(async () => {
    vi.resetModules()
    preload = await import('./preload')
  })
  afterEach(() => vi.unstubAllGlobals())

  it('hands a failure to whoever asked, and fetches afresh when asked again', async () => {
    const download = feed({ 'Content-Length': '10' })
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(download.response)
    vi.stubGlobal('fetch', fetch)

    await expect(preload.asset('/elsewhere/lost.bin')).rejects.toThrow(
      'HTTP 503'
    )
    // A failed download is not outstanding work: no stall clock runs on it.
    expect(preload.progress().idle).toBe(0)

    // The next mission asks again, and the download starts afresh.
    const again = preload.asset('/elsewhere/lost.bin')
    await settle()
    download.push(10)
    download.end()
    expect((await again).byteLength).toBe(10)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('leaves no unhandled rejection when nobody waits on a preload', async () => {
    const unhandled: unknown[] = []
    const listen = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', listen)
    try {
      const fetch = vi.fn(async () => {
        throw new TypeError('network down')
      })
      vi.stubGlobal('fetch', fetch)
      preload.preload() // the menu's start: six downloads, none awaited
      for (let i = 0; i < 5; i++) await settle()
      expect(fetch).toHaveBeenCalled()
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', listen)
    }
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
      fileURLToPath(new URL('../assets/aim9m.glb', import.meta.url))
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

    const done = preload.asset(aim9m_model_url)
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

// The engine's LOADING screen. It used to leave only on a failed download in
// the preload map, which forgot the failure at once, so a failed carrier or
// aircraft held the screen for good; read off every download in the map, a
// model the menu began and this mission never asks for would fail every
// mission instead. The gate fails on its own loads.
describe("the engine's loading gate", () => {
  const engine = readFileSync(
    fileURLToPath(new URL('./engine.ts', import.meta.url)),
    'utf8'
  )

  it('hears the carrier and the aircraft fail', () => {
    expect(engine).toMatch(
      /\ninit_external_model\(cfg\.aircraft\|\|"fa18c"\)\.catch\(load_failed\);/
    )
    expect(engine).toMatch(/\ninit_carrier_model\(\)\.catch\(load_failed\);/)
  })

  it('fails on its own loads and the flight core, not on the preload map', () => {
    expect(engine).toMatch(
      /const failure=load_failure\|\|flight_failure\(\);\s*if\(failure \|\| lp\.idle>20000\)/
    )
    expect(engine).not.toMatch(/lp\.failed/)
  })
})
