// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// Toroidal-world coordinate maths, isolated so the security-critical parts are
// unit testable and dependency-free. The wrap size comes from an UNTRUSTED
// server, so it is validated on arrival (sanitizeWrap) and the normalization is
// constant-time — a hostile tiny wrap fed to a subtraction loop would freeze
// the render thread (the client twin of the server's flight.Shortest fix).

// MIN_WRAP mirrors the server's Create clamp (wrap is 0 or >= 10 km): a world
// smaller than this is geometric nonsense, and a tiny value is the freeze
// vector through minimumImage().
export const MIN_WRAP = 10000

// sanitizeWrap accepts a server-advertised toroidal world size only when it is
// finite and either 0 (wrapping off) or at least MIN_WRAP; anything else keeps
// the fallback (the current/default world size).
export function sanitizeWrap(value: unknown, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  if (n === 0 || n >= MIN_WRAP) return n
  return fallback
}

// minimumImage is the shortest signed difference to-from on the torus. Loop
// free: the old `while (d > half) d -= wrap` ran ~|d|/wrap iterations, so a
// hostile tiny wrap froze the render thread on ordinary coordinates. Round
// gives the identical minimum-image result in one step.
export function minimumImage(wrap: number, from: number, to: number): number {
  const d = to - from
  if (wrap <= 0) return d
  return d - wrap * Math.round(d / wrap)
}

// fold brings a coordinate back into the world's canonical span.
export function fold(wrap: number, value: number): number {
  if (wrap <= 0) return value
  return value - wrap * Math.round(value / wrap)
}
