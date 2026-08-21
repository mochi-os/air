// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// Host identity for the multiplayer join gate. Dependency-free by design: the
// rule below is a security control, and it is unit-tested in isolation.

// loopback recognises every spelling of "this machine": the names are not
// interchangeable as strings but address the same host.
export function loopback(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '') // IPv6 literals arrive bracketed
  return bare === 'localhost' || bare === '::1' || /^127\.\d+\.\d+\.\d+$/.test(bare)
}

// crossHost returns the transport hostname when it differs from the lobby the
// player chose, else null. The untrusted lobby supplies that address, so an
// unparseable one counts as cross-host and loopback spellings collapse only
// when BOTH ends are loopback.
export function crossHost(transport: string, lobby: string): string | null {
  try {
    const other = new URL(transport).hostname
    const chosen = new URL(lobby).hostname
    if (other === chosen) return null
    if (loopback(other) && loopback(chosen)) return null
    return other
  } catch {
    return transport
  }
}
