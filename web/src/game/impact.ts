// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// What a falling aircraft hit, named. The recorder's Fate channel is supposed
// to state the cause of death, and for the bandit it named "fire" for
// everything — a jet whose wing had been shot off and which then flew into the
// sea was recorded as destroyed by a fire it never had.
//
// The ownship's own crash check is deliberately NOT shared: its thresholds
// differ (sea at 3.4 m rather than the terrain floor, buildings gated on
// altitude) because it is a landing aircraft and this is a falling one.

export interface Building {
  minx: number
  maxx: number
  minz: number
  maxz: number
  topY: number
  pts: [number, number][]
}

export interface Post {
  x: number
  z: number
  r: number
  y1: number
}

export interface Island {
  x: number
  z: number
  deck: number
  height: (x: number, z: number) => number
}

// inside: is this point within the building's footprint polygon?
export function inside(x: number, z: number, poly: [number, number][]): boolean {
  let within = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], zi = poly[i][1], xj = poly[j][0], zj = poly[j][1]
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) within = !within
  }
  return within
}

// surface names what the aircraft is in contact with, or '' while it still
// flies. `floor` is the terrain height beneath it, or -1e9 over open water.
// The names are the ones the recording's Fate channel already uses.
export function surface(
  p: { x: number; y: number; z: number },
  floor: number,
  buildings: Building[],
  posts: Post[],
  island?: Island,
): string {
  if (p.y <= (floor > -1e8 ? floor + 2 : 6)) return floor > -1e8 ? 'ground' : 'sea'
  for (const b of buildings) {
    if (p.y < b.topY + 2 && p.x > b.minx && p.x < b.maxx && p.z > b.minz && p.z < b.maxz && inside(p.x, p.z, b.pts)) return 'building'
  }
  for (const m of posts) {
    if (p.y < m.y1 && Math.hypot(p.x - m.x, p.z - m.z) < m.r + 4) return 'post'
  }
  if (island && p.y < 80 && Math.abs(p.x - island.x) < 160 && Math.abs(p.z - island.z) < 160) {
    const h = island.height(p.x, p.z)
    if (h > island.deck + 4 && p.y < h) return 'island'
  }
  return ''
}
