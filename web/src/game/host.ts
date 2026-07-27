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
// player actually chose, or null when they match. The lobby (untrusted) hands
// out the separate WebTransport address, so it could point the browser at
// another host — a private-network or loopback service — without this check.
// It also supplies the certificate hash to trust, so an unchecked redirect
// dials an arbitrary host with validation the same untrusted party chose.
// An unparseable transport address is treated as cross-host (surfaced, not
// silently trusted).
//
// Loopback spellings are collapsed only when BOTH ends are loopback: a local
// lobby advertising 127.0.0.1 to a player who typed localhost is the same
// machine (the server's own default address does exactly this), while a
// REMOTE lobby redirecting to loopback is the private-service attack this
// check exists to catch — and stays a warning.
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
