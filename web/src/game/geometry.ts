// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// Map geometry as one canonical text - keys sorted, numbers to the
// millimetre - so the hash a world server publishes for the map it serves can
// be compared with what this client built itself, and the export that becomes
// the server's file is byte-for-byte what the client would build again.

export function geometry_canonical(value: unknown): string {
  if (typeof value === 'number') {
    const rounded = Math.round(value * 1000) / 1000
    return JSON.stringify(Object.is(rounded, -0) ? 0 : rounded)
  }
  if (Array.isArray(value)) return '[' + value.map(geometry_canonical).join(',') + ']'
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return (
      '{' +
      Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + geometry_canonical(record[key]))
        .join(',') +
      '}'
    )
  }
  return JSON.stringify(value ?? null)
}

// The SHA-256 of a text, hex - the same digest the world server takes of the
// file it serves.
export async function geometry_hash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
