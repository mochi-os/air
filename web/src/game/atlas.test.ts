// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { aim, column, due, framing, grid, local, origin, pieces, row, SIZE, type Manifest } from './atlas'
import { centred, DEGREE, tangent } from './earth'

const m: Manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../../public/maps/world/world.json', import.meta.url)), 'utf8'))
const C = (2 * Math.PI * m.equator) / m.fine.metres // the circumference, fine pixels
const places: [number, number][] = []
for (let latitude = -89; latitude <= 89; latitude += 7) for (let longitude = -180; longitude < 180; longitude += 3.7) places.push([latitude * DEGREE, longitude * DEGREE])
for (const longitude of [-180, -179.999, -179.95, 179.95, 179.999]) for (const latitude of [-17.8, 0, 66]) places.push([latitude * DEGREE, longitude * DEGREE]) // about the antimeridian: Fiji, the equator, Chukotka

describe('the global map grid', () => {
  it('starts at 180 W and 90 N, in pixels of equatorial arc', () => {
    expect(column(m, -Math.PI)).toBeCloseTo(0, 9)
    expect(column(m, 0)).toBeCloseTo(C / 2, 6)
    expect(column(m, Math.PI - 1e-12)).toBeCloseTo(C, 6)
    expect(row(m, Math.PI / 2)).toBe(0)
    expect(row(m, -Math.PI / 2)).toBeCloseTo(C / 2, 6)
    expect(m.fine.width).toBe(Math.ceil(C)) // the last column runs a fraction past the antimeridian
  })
  it('holds the jet in the middle half of the window, wherever it flies', () => {
    for (const [latitude, longitude] of places) {
      const at = origin(m, latitude, longitude), w = local(m, at, column(m, longitude)), r = row(m, latitude) - at.y
      expect(Math.abs(at.x % m.fine.tile), 'on the tiles').toBe(0)
      expect(w, `column at ${latitude / DEGREE}, ${longitude / DEGREE}`).toBeGreaterThanOrEqual(SIZE / 4)
      expect(w).toBeLessThanOrEqual((3 * SIZE) / 4)
      expect(r).toBeGreaterThanOrEqual(0)
      expect(r).toBeLessThan(SIZE)
      if (at.y > 0 && at.y + SIZE < m.fine.height) {
        expect(r).toBeGreaterThanOrEqual(SIZE / 4) // away from the poles, in its middle half too
        expect(r).toBeLessThanOrEqual((3 * SIZE) / 4)
      }
      expect(due(m, at, latitude, longitude)).toBe(false)
    }
  })
  it('moves the window only once the jet has wandered from its middle', () => {
    const at = origin(m, 0, 0), centre = column(m, 0) - at.x
    const east = (pixels: number) => ((at.x + centre + pixels) * m.fine.metres) / m.equator - Math.PI
    expect(due(m, at, 0, east(500))).toBe(false)
    expect(due(m, at, 0, east(1100))).toBe(true)
    expect(due(m, at, 0, east(-1100))).toBe(true)
    expect(due(m, origin(m, 0, east(1100)), 0, east(1100))).toBe(false)
  })
  it('composes a window from whole tile pixels, each once, true to the grid across the antimeridian', () => {
    const tiles = new Set(m.fine.tiles.map(([r, c]) => r + '-' + c))
    for (const [latitude, longitude] of places) {
      const at = origin(m, latitude, longitude), parts = pieces(m, at)
      const covered = new Map<string, number>()
      for (const p of parts) {
        expect(tiles.has(p.row + '-' + p.column)).toBe(true)
        expect(p.dx).toBeGreaterThanOrEqual(0)
        expect(p.dy).toBeGreaterThanOrEqual(0)
        expect(p.dx + p.width).toBeLessThanOrEqual(SIZE)
        expect(p.dy + p.height).toBeLessThanOrEqual(SIZE)
        expect(p.column * m.fine.tile + p.sx + p.width).toBeLessThanOrEqual(m.fine.width) // only the tile's real pixels
        expect(p.row * m.fine.tile + p.sy + p.height).toBeLessThanOrEqual(m.fine.height)
        for (const x of [p.dx, p.dx + p.width - 1]) for (const y of [p.dy, p.dy + p.height - 1]) {
          const key = x + ',' + y
          covered.set(key, (covered.get(key) ?? 0) + 1)
        }
      }
      for (const [key, count] of covered) expect(count, key).toBe(1)
      // Where the shaders read the jet's pixel, and the places round it out to the sea's edge, across the
      // antimeridian from it too, the piece there holds that pixel of the grid.
      for (const [north, east] of [[0, 0], [0, -0.6], [0, 0.6], [0, -1.08], [0, 1.08], [1.08, 0], [-1.08, 0]]) { // degrees of arc: 1.08 is the sea's 120 km
        const lat = latitude + north * DEGREE, lon = longitude + (east * DEGREE) / Math.max(Math.cos(latitude), 0.2)
        const s = column(m, lon), t = row(m, lat), w = local(m, at, s), v = t - at.y
        if (Math.abs(lat) > Math.PI / 2 || v < 0 || v >= SIZE) continue // off the earth past a pole, or the pole's edge of a window held at the grid's end
        const where = `${lat / DEGREE}, ${lon / DEGREE} from ${latitude / DEGREE}, ${longitude / DEGREE}`
        if (Math.abs(latitude) > 80 * DEGREE && (w < 0 || w >= SIZE)) continue // near a pole a disc spans more columns than the window: the shaders read the global level there
        expect(w, where).toBeGreaterThanOrEqual(0)
        expect(w, where).toBeLessThan(SIZE)
        const p = parts.find((q) => w >= q.dx && w < q.dx + q.width && v >= q.dy && v < q.dy + q.height)
        if (!p) {
          expect(tiles.has(Math.floor(t / m.fine.tile) + '-' + Math.floor(s / m.fine.tile)), where).toBe(false) // a tile with no land is no piece
          continue
        }
        expect(Math.abs(p.column * m.fine.tile + p.sx + (w - p.dx) - s), where).toBeLessThan(1e-6)
        expect(Math.abs(p.row * m.fine.tile + p.sy + (v - p.dy) - t), where).toBeLessThan(1e-6)
      }
    }
  })
})

describe('the shaders reading the map', () => {
  const frames = [tangent(28.2 * DEGREE, -177.37 * DEGREE), tangent(48.86 * DEGREE, 2.35 * DEGREE), tangent(-17.8 * DEGREE, 179.99 * DEGREE), tangent(66 * DEGREE, -179.99 * DEGREE), tangent(-89.9 * DEGREE, 10 * DEGREE)]
  it('finds the grid pixel of every point of the sea a frame draws', () => {
    for (const frame of frames)
      for (const x of [-120000, -3000, 0, 50000, 120000])
        for (const z of [-120000, 0, 7000, 120000]) {
          const p = frame.sea(x, z).point, place = frame.place(p), [s, t] = grid(m, frame, p)
          const wrapped = s - C * Math.floor(s / C), expected = column(m, place.longitude)
          const seam = Math.abs(wrapped - expected) > C / 2 ? C : 0 // either side of the antimeridian
          expect(Math.abs(Math.abs(wrapped - expected) - seam), `column at ${frame.latitude / DEGREE}`).toBeLessThan(1e-6)
          expect(Math.abs(t - row(m, place.latitude))).toBeLessThan(1e-6)
        }
  })
  it('lays a frame earth-centred and turned onto its own meridian', () => {
    const u = framing()
    for (const frame of frames) {
      aim(u, frame, m)
      for (const p of [{ x: 0, y: 0, z: 0 }, { x: 90000, y: -600, z: -40000 }, { x: -2000, y: 12000, z: 110000 }]) {
        const e = centred(frame.place(p)), cos = Math.cos(-frame.longitude), sin = Math.sin(-frame.longitude)
        const turned = new THREE.Vector3(e.x * cos - e.y * sin, e.x * sin + e.y * cos, e.z)
        const shader = new THREE.Vector3(p.x, p.y, p.z).applyMatrix3(u.u_atlas_turn.value).add(u.u_atlas_anchor.value)
        expect(shader.distanceTo(turned), `${frame.latitude / DEGREE}`).toBeLessThan(1e-4)
      }
      expect(u.u_atlas_meridian.value).toBeCloseTo(column(m, frame.longitude), 9)
    }
  })
})
