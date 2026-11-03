// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
// Air's own assets through the shell's window. A fetch from the sandboxed app
// frame is never kept in the browser's cache, so every signed-in load
// downloaded the models, the flight wasm and the voices again; the shell's
// window is the server's own origin, and its cache keeps them.

// carried answers the asset's bytes fetched by the shell, or null outside the
// shell or when it will not carry it, and the caller fetches it itself.
// progress hears the bytes received so far.
export async function carried(
  url: string,
  progress?: (received: number) => void
): Promise<ArrayBuffer | null> {
  // Imported when first needed, so the game's own modules load without the
  // web library, as their tests do.
  let web: typeof import('@mochi/web')
  try {
    web = await import('@mochi/web')
  } catch {
    return null
  }
  if (!web.isInShell()) return null
  await web.initShellBridge() // the shell says whether it carries requests in its init
  const reply = await web.shellGet(new URL(url, window.location.href).href, [], {
    progress,
  })
  return reply && reply.status === 200 ? reply.body : null
}
