// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { carried } from './carried'

// The shell's side, as the web library answers it: inside the shell, with
// whatever shellGet the test gives it.
const shellGet = vi.fn()
vi.mock('@mochi/web', () => ({
  isInShell: () => true,
  initShellBridge: async () => ({ inShell: true }),
  shellGet: (...args: unknown[]) => shellGet(...args),
}))

// The game's tests run outside a browser; the asset addresses resolve
// against the frame's page.
beforeEach(() => {
  vi.stubGlobal('window', { location: { href: 'https://mochi.test/air/' } })
})
afterEach(() => {
  shellGet.mockReset()
  vi.unstubAllGlobals()
})

describe('an asset carried by the shell', () => {
  it('asks with the progress listener, so a shell that reports none leaves it to the caller', async () => {
    shellGet.mockResolvedValue(null)
    const progress = () => {}
    expect(await carried('/air/assets/ford.glb', progress)).toBeNull()
    expect(shellGet).toHaveBeenCalledTimes(1)
    expect(shellGet.mock.calls[0][0]).toBe(
      'https://mochi.test/air/assets/ford.glb'
    )
    expect(shellGet.mock.calls[0][2]).toEqual({ progress })
  })

  it('takes the bytes of a 200 and nothing else', async () => {
    const body = new ArrayBuffer(8)
    shellGet.mockResolvedValueOnce({ status: 200, headers: [], body })
    expect(await carried('/air/assets/ford.glb')).toBe(body)
    // CONTROL: any other status is the caller's to fetch itself.
    shellGet.mockResolvedValueOnce({ status: 503, headers: [], body })
    expect(await carried('/air/assets/ford.glb')).toBeNull()
  })
})
