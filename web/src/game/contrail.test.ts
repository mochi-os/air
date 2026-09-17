// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Contrails: where the air is cold enough a running engine leaves a trail
// that starts a few tens of metres behind the nozzle, widens from a metre to
// tens of metres, sinks in the wake, and dissolves from a ragged far end. The band follows the core's standard atmosphere and each
// engine's power; the trail outlives the jet that laid it. engine.ts cannot
// be imported (WebGL at module scope), so the functions are lifted out of the
// source and run against stand-ins.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')

// lift cuts one top-level function out of the source: from its head to the
// next line that starts at column 0 (the bodies are tab-indented).
function lift(name: string): string {
  const start = source.indexOf(`function ${name}(`)
  expect(start, `${name} in engine.ts`).toBeGreaterThan(0)
  const rest = source.slice(start)
  const end = /\n(?=\S)/.exec(rest.slice(1))
  return end ? rest.slice(0, end.index + 1) : rest
}

const FEET = 0.3048
const air = new Function(`${lift('contrail_air')}\nreturn contrail_air;`)() as (y: number) => number
const band = new Function(`${lift('contrail_air')}\n${lift('contrail_band')}\nreturn contrail_band;`)() as (
  y: number, spool: number, reheat: number, time: number, seed: number) => { strength: number; life: number }
const shape = new Function(`${lift('contrail_shape')}\nreturn contrail_shape;`)() as (
  age: number, life: number, rag: number) => { width: number; alpha: number; sink: number; apart: number }

describe('the air', () => {
  it('is the standard atmosphere the core flies: 15 °C at the sea, -40 near 28,000 ft, isothermal above the tropopause', () => {
    expect(air(0)).toBeCloseTo(15, 6)
    expect(air(8462)).toBeCloseTo(-40, 1)
    expect(air(11000)).toBeCloseTo(-56.5, 6)
    expect(air(15000)).toBeCloseTo(-56.5, 6)
    expect(air(-50)).toBeCloseTo(15, 6)
  })
})

describe('the band', () => {
  it('forms nothing at the BVR block and a full trail at military power well inside the band', () => {
    expect(band(20000 * FEET, 1, 0, 0, 0).strength).toBe(0)
    expect(band(9500, 1, 0, 0, 0)).toEqual({ strength: 1, life: 90 })
  })

  it('needs colder air in burner: a jet that trails at military power inside the lower band thins in reheat', () => {
    const mil = band(9500, 1, 0, 0, 0).strength
    const burner = band(9500, 1, 1, 0, 0).strength
    expect(mil).toBe(1)
    expect(burner).toBeCloseTo(0.6875, 6) // threshold -44 against -46.75
    expect(band(8900, 1, 1, 0, 0).strength).toBe(0) // and nothing at all where military power still trails
    expect(band(8900, 1, 0, 0, 0).strength).toBeGreaterThan(0)
  })

  it('follows the engine: nothing from a dead one, a thin trail at idle', () => {
    expect(band(9500, 0, 0, 0, 0).strength).toBe(0)
    expect(band(9500, 0.3, 0, 0, 0).strength).toBeCloseTo(0.4, 6)
    expect(band(9500, 0.6, 0, 0, 0).strength).toBe(1)
  })

  it('comes and goes in the marginal band as the air along the track varies', () => {
    const seen = Array.from({ length: 80 }, (_, i) => band(8680, 1, 0, i * 0.25, 0.3).strength)
    expect(Math.min(...seen)).toBe(0)
    expect(Math.max(...seen)).toBeGreaterThan(0.7)
    expect(band(8700, 1, 0, 0, 0).strength).toBeCloseTo(0.3875, 6)
    // well inside the band the same pockets change nothing
    expect(Math.min(...Array.from({ length: 80 }, (_, i) => band(9800, 1, 0, i * 0.25, 0.3).strength))).toBe(1)
  })

  it("lasts a minute and a half anywhere the jet can reach: the dry air is above Midway's subtropical tropopause near 16 km, not ISA's 11 km", () => {
    expect(band(9500, 1, 0, 0, 0).life).toBe(90)
    expect(band(11000, 1, 0, 0, 0).life).toBe(90) // the ISA tropopause is a temperature convention, not this sky's humidity
    expect(band(41500 * FEET, 1, 0, 0, 0).life).toBe(90) // a burner climb tops out here and trails like it did at 33,000 ft
    expect(band(16000, 1, 0, 0, 0).life).toBe(50)
    expect(band(16500, 1, 0, 0, 0).life).toBe(10)
    expect(band(16500, 1, 0, 0, 0).strength).toBe(1) // cold enough: it still forms
  })
})

describe('a segment', () => {
  it('is clear air for the first 30-70 m and condensed by a third of a second', () => {
    expect(shape(0.1, 90, 0.5).alpha).toBe(0)
    expect(shape(0.25, 90, 0.5).alpha).toBeGreaterThan(0)
    expect(shape(0.35, 90, 0.5).alpha).toBeCloseTo(0.85, 6)
  })

  it('widens from a metre to tens of metres and thins as it spreads', () => {
    const ages = [0, 1, 3, 10, 30, 60, 89]
    const widths = ages.map((age) => shape(age, 90, 1).width)
    expect(widths[0]).toBeCloseTo(1.2, 6)
    expect(widths[2]).toBeGreaterThan(5)
    expect(widths[2]).toBeLessThan(10)
    expect(widths[6]).toBeGreaterThan(30)
    for (let i = 1; i < widths.length; i++) expect(widths[i]).toBeGreaterThan(widths[i - 1])
    const alphas = ages.slice(1).map((age) => shape(age, 90, 1).alpha)
    for (let i = 1; i < alphas.length; i++) expect(alphas[i]).toBeLessThan(alphas[i - 1])
  })

  it('sinks in the wake for the first half minute and then holds', () => {
    expect(shape(0, 90, 0.5).sink).toBe(0)
    const early = shape(5, 90, 0.5).sink
    expect(early).toBeGreaterThan(8)
    expect(early).toBeLessThan(15)
    expect(shape(60, 90, 0.5).sink).toBeCloseTo(36.3, 0)
    expect(shape(90, 90, 0.5).sink - shape(60, 90, 0.5).sink).toBeLessThan(1)
  })

  it('rolls the two engines\' lines into one within a couple of spans', () => {
    expect(shape(0, 90, 0.5).apart).toBe(1)
    expect(shape(0.5, 90, 0.5).apart).toBeCloseTo(Math.exp(-1), 6)
    expect(shape(2, 90, 0.5).apart).toBeLessThan(0.02)
  })

  it('carries no pattern along its length: the width is the spread alone and the brightness follows it, at every age', () => {
    const spread = (age: number) => 1.2 + 8 * (1 - Math.exp(-age / 3)) + 0.4 * age
    for (const age of [7, 12, 20, 30, 45]) {
      const at = shape(age, 90, 1)
      expect(Object.keys(at).sort()).toEqual(['alpha', 'apart', 'sink', 'width']) // no bead depth: the wake's puffs read as pearls on a ribbon a few pixels wide
      expect(at.width).toBeCloseTo(spread(age), 6)
      expect(at.alpha).toBeCloseTo(0.85 * 6 / spread(age), 6)
    }
  })

  it('dissolves from a ragged end: each segment starts fading at its own point past half life, and is gone by its life', () => {
    expect(shape(45, 90, 0).alpha).toBeGreaterThan(0)
    const smooth = shape(45, 90, 0).alpha
    expect(shape(60, 90, 0).alpha).toBeLessThan(smooth * 0.9) // rag 0 starts dissolving at 0.55 life
    expect(shape(70, 90, 1).alpha).toBeCloseTo(0.85 * 6 / (1.2 + 8 * (1 - Math.exp(-70 / 3)) + 28), 6) // rag 1 has not started dissolving at 0.78 life: only the spread thins it
    expect(shape(70, 90, 1).alpha).toBeGreaterThan(shape(70, 90, 0).alpha * 3)
    expect(shape(90, 90, 0).alpha).toBe(0)
    expect(shape(90, 90, 1).alpha).toBe(0)
    expect(shape(10, 10, 0.5).alpha).toBe(0) // the stratospheric dash too
  })
})

// A rig with the ring the engine's contrail_rig builds, over a stand-in geometry.
interface Geo { attributes: { position: { array: Float32Array; needsUpdate: boolean }; color: { array: Float32Array; needsUpdate: boolean } }; range: number[]; disposed: number; setDrawRange(a: number, b: number): void; dispose(): void }
interface Rig { [field: string]: unknown; owner: unknown; n: number; head: number; count: number; laid: number; trailing: boolean; phase: number; mesh: { visible: boolean }; geo: Geo; cx: Float32Array; cy: Float32Array; cz: Float32Array; ox: Float32Array; oy: Float32Array; oz: Float32Array; fx: Float32Array; fy: Float32Array; fz: Float32Array; born: Float32Array; life: Float32Array; rag: Float32Array; arc: Float32Array; sa: Float32Array; sb: Float32Array }
function rig(owner: unknown, n = 8): Rig {
  const field = () => new Float32Array(n)
  const geo: Geo = {
    attributes: { position: { array: new Float32Array(n * 18), needsUpdate: false }, color: { array: new Float32Array(n * 24), needsUpdate: false } },
    range: [0, 0], disposed: 0, setDrawRange(a, b) { this.range = [a, b] }, dispose() { this.disposed++ },
  }
  return { owner, n, head: 0, count: 0, laid: -1, trailing: false, phase: 0, mesh: { visible: false }, geo,
    cx: field(), cy: field(), cz: field(), ox: field(), oy: field(), oz: field(), fx: field(), fy: field(), fz: field(), born: field(), life: field(), rag: field(), arc: field(), sa: field(), sb: field() }
}
interface Jet { pos: { x: number; y: number; z: number }; fwd: { x: number; y: number; z: number }; velx: number; vely: number; velz: number; group?: { visible: boolean } | null; spools?: number[]; reheats?: number[]; thrust?: number; reheat?: number; contrail?: Rig | null; pockets?: number[] }
const jet = (y: number, extra: Partial<Jet> = {}): Jet => ({ pos: { x: 0, y, z: 0 }, fwd: { x: 1, y: 0, z: 0 }, velx: 200, vely: 0, velz: 0, group: { visible: true }, ...extra })
// body_offset in a level jet flying +x: x forward, y up, z right
const offset = (st: Jet, x: number, y: number, z: number) => ({ x: st.pos.x + x, y: st.pos.y + y, z: st.pos.z + z })
const nozzle = { x: -9.3, y: -0.37, z: 0.48 }
const lay = new Function('body_offset', 'nozzle', `${lift('contrail_lay')}\nreturn contrail_lay;`)(offset, nozzle) as (rig: Rig, st: Jet, time: number, a: number, b: number, life: number) => void
// a row's three vertices: positions, alpha and colour
const row = (r: Rig, j: number, strip: number) => {
  const p = r.geo.attributes.position.array, c = r.geo.attributes.color.array
  return [-1, 0, 1].map((t, i) => { const v = j * 6 + strip * 3 + i; return { x: p[v * 3], y: p[v * 3 + 1], z: p[v * 3 + 2], alpha: c[v * 4 + 3], rgb: [c[v * 4], c[v * 4 + 1], c[v * 4 + 2]], t } })
}
const span = (a: { x: number; y: number; z: number }[]) => Math.hypot(a[2].x - a[0].x, a[2].y - a[0].y, a[2].z - a[0].z)

describe('laying a segment', () => {
  afterEach(() => vi.restoreAllMocks())

  it('records the centre between the nozzles, the half-offset to each, the flight direction, the strengths and the life', () => {
    const r = rig(null)
    lay(r, jet(9000, { velx: 0, vely: 0, velz: -240 }), 12.5, 1, 0.5, 90)
    expect(r.count).toBe(1)
    expect(r.head).toBe(1)
    expect(r.laid).toBe(12.5)
    const close = (got: Float32Array[], want: number[]) => want.forEach((v, i) => expect(got[i][0]).toBeCloseTo(v, 3))
    close([r.cx, r.cy, r.cz], [-9.3, 9000 - 0.37, 0])
    close([r.ox, r.oy, r.oz], [0, 0, 0.48])
    close([r.fx, r.fy, r.fz], [0, 0, -1])
    expect(r.born[0]).toBe(12.5)
    expect(r.life[0]).toBe(90)
    expect([r.sa[0], r.sb[0]]).toEqual([1, 0.5])
    expect(r.arc[0]).toBe(0)
    expect(r.rag[0]).toBeCloseTo(0.5, 6) // the dissolve point at the trail's start, phase 0
  })

  it('sets where each segment starts to dissolve by a slow drift along the trail, so neighbours fade together and the far end goes in patches', () => {
    const r = rig(null, 64)
    r.phase = 1.0
    const st = jet(9000)
    for (let i = 0; i < 60; i++) { st.pos.x = i * 40; lay(r, st, i * 0.15, 1, 1, 90) }
    const rags = Array.from(r.rag.slice(0, 60))
    for (let i = 1; i < 60; i++) expect(Math.abs(rags[i] - rags[i - 1])).toBeLessThan(0.1) // 40 m rows: a few percent of the range each
    expect(Math.max(...rags) - Math.min(...rags)).toBeGreaterThan(0.5) // and the whole range over 2.4 km
    for (const g of rags) { expect(g).toBeGreaterThanOrEqual(0); expect(g).toBeLessThanOrEqual(1) }
    expect(rags[10]).toBeCloseTo(0.5 + 0.25 * Math.sin(400 / 150 + 1) + 0.25 * Math.sin(400 / 330 + 2.7), 5)
  })

  it('lays a jet that is not moving along its nose, and runs the arc along the trail', () => {
    const r = rig(null)
    lay(r, jet(9000, { velx: 0, vely: 0, velz: 0, fwd: { x: 0, y: 0, z: 1 } }), 0, 1, 1, 90)
    expect([r.fx[0], r.fy[0], r.fz[0]]).toEqual([0, 0, 1])
    const moved = jet(9000)
    moved.pos.x = 30
    lay(r, moved, 0.15, 1, 1, 90)
    expect(r.arc[1]).toBeCloseTo(30, 6)
    moved.pos.x = 70
    lay(r, moved, 0.3, 1, 1, 90)
    expect(r.arc[2]).toBeCloseTo(70, 6)
  })

  it('overwrites the oldest once the ring is full', () => {
    const r = rig(null, 4)
    for (let i = 0; i < 6; i++) { const st = jet(9000); st.pos.x = i * 30; lay(r, st, i * 0.15, 1, 1, 90) }
    expect(r.count).toBe(4)
    expect(r.head).toBe(2)
    expect(r.born[0]).toBeCloseTo(0.6, 6) // the fifth lay took slot 0
    expect(r.born[1]).toBeCloseTo(0.75, 6)
    expect(r.born[2]).toBeCloseTo(0.3, 6)
  })
})

describe('the ribbons', () => {
  const vertices = (wrap = 0) =>
    new Function('wrap_axis', `${lift('contrail_shape')}\n${lift('contrail_vertices')}\nreturn contrail_vertices;`)(
      (v: number) => (wrap > 0 ? v - wrap * Math.round(v / wrap) : v)) as (rig: Rig, time: number, cam: { x: number; y: number; z: number }, pixel: number) => number
  // two segments 30 m apart along +x at 10,000 m, laid at 0 and 0.15 s, both engines trailing
  function laid(): Rig {
    const r = rig(null)
    lay(r, jet(10000), 0, 1, 0.5, 90)
    const next = jet(10000); next.pos.x = 30
    lay(r, next, 0.15, 1, 0.5, 90)
    return r
  }

  it('faces the camera: each row spans the width across the trail and the view, with soft edges', () => {
    const r = laid()
    const at = shape(2, 90, r.rag[0])
    expect(vertices()(r, 2, { x: 0, y: 10000 - 0.37 - at.sink, z: 800 }, 0)).toBe(2) // seen from the side, level with the sunk trail
    const a = row(r, 0, 0)
    expect(span(a)).toBeCloseTo(at.width, 2) // Float32 at 10 km resolves a millimetre
    expect(a[1].alpha).toBeCloseTo(at.alpha, 5)
    expect(a[0].alpha).toBe(0)
    expect(a[2].alpha).toBe(0)
    expect(a[1].rgb).toEqual([1, 1, 1])
    expect(Math.abs(a[2].x - a[0].x)).toBeLessThan(1e-3) // across a trail along x, seen from +z: the row runs along y
    expect(Math.abs(a[2].z - a[0].z)).toBeLessThan(1e-3)
    expect(Math.abs(a[2].y - a[0].y)).toBeCloseTo(at.width, 2)
    expect(a[1].y).toBeCloseTo(10000 - 0.37 - at.sink, 2) // sunk in the wake
    expect(r.geo.range).toEqual([0, 24])
    expect(r.geo.attributes.position.needsUpdate).toBe(true)
    expect(r.geo.attributes.color.needsUpdate).toBe(true)
  })

  it('draws one ribbon per engine at each engine\'s strength, apart at the nozzles and rolled together behind', () => {
    const r = laid()
    vertices()(r, 0.5, { x: 0, y: 10000, z: 800 }, 0)
    const near = shape(0.35, 90, r.rag[1]) // the newer segment, just condensed
    expect(near.alpha).toBeGreaterThan(0.5)
    const left = row(r, 1, 0), right = row(r, 1, 1)
    expect(right[1].z - left[1].z).toBeCloseTo(2 * 0.48 * near.apart, 4)
    expect(left[1].alpha).toBeCloseTo(near.alpha * 1, 5)
    expect(right[1].alpha).toBeCloseTo(near.alpha * 0.5, 5)
    vertices()(r, 20, { x: 0, y: 10000, z: 800 }, 0)
    expect(Math.abs(row(r, 1, 1)[1].z - row(r, 1, 0)[1].z)).toBeLessThan(1e-6)
  })

  it('still spans the width seen straight along the trail', () => {
    const r = laid()
    vertices()(r, 2, { x: 500, y: 10000 - 0.37 - shape(2, 90, 0).sink, z: 0 }, 0)
    expect(span(row(r, 0, 0))).toBeGreaterThan(1)
  })

  it('holds a ribbon seen from far away to a pixel and a half and dims it by the same ratio, and leaves a near one alone', () => {
    const r = laid()
    const at = shape(2, 90, r.rag[0])
    const pixel = 2 * Math.tan(22.5 * Math.PI / 180) / 2160 // a 45° camera on a 4K frame
    const far = { x: 0, y: 10000 - 0.37 - at.sink, z: 20000 }
    vertices()(r, 2, far, pixel)
    const least = 20000 * pixel * 1.5
    expect(at.width).toBeLessThan(least)
    expect(span(row(r, 0, 0))).toBeCloseTo(least, 1)
    expect(row(r, 0, 0)[1].alpha).toBeCloseTo(at.alpha * at.width / least, 5)
    vertices()(r, 2, { x: 0, y: far.y, z: 800 }, pixel) // 800 m: the width is many pixels
    expect(span(row(r, 0, 0))).toBeCloseTo(at.width, 2)
    expect(row(r, 0, 0)[1].alpha).toBeCloseTo(at.alpha, 5)
  })

  it('draws nothing across a jump: a segment far from the one before it clears both rows', () => {
    const r = laid()
    const far = jet(10000); far.pos.x = 2000
    lay(r, far, 0.3, 1, 1, 90)
    vertices()(r, 2, { x: 0, y: 10000, z: 800 }, 0)
    expect(row(r, 0, 0)[1].alpha).toBeGreaterThan(0)
    expect(row(r, 1, 0)[1].alpha).toBe(0)
    expect(row(r, 1, 1)[1].alpha).toBe(0)
    expect(row(r, 2, 0)[1].alpha).toBe(0)
  })

  it('draws each segment at its minimum image about the camera in a wrapped world', () => {
    const r = laid()
    r.cx[0] = 99000; r.cx[1] = 99030
    vertices(100000)(r, 2, { x: 0, y: 10000, z: 800 }, 0)
    expect(row(r, 0, 0)[1].x).toBeCloseTo(-1000, 3)
    expect(row(r, 1, 0)[1].x).toBeCloseTo(-970, 3)
    expect(row(r, 1, 0)[1].alpha).toBeGreaterThan(0) // 30 m apart on this side: no seam
  })
})

describe('every jet, every frame', () => {
  afterEach(() => vi.restoreAllMocks())
  interface World { own: Jet; bandit: Jet; remotes: Map<number, Jet>; scene: { removed: unknown[] }; contrails: Set<Rig>; run(dt: number): void; clock(t: number): void; crash(t: number): void; rigs: number }
  const HEIGHT = 1000 // the stand-in canvas, with a 45° camera at the origin
  function world(own: Jet, bandit: Jet, remotes = new Map<number, Jet>()): World {
    const scene = { removed: [] as unknown[], remove(m: unknown) { this.removed.push(m) } }
    const contrails = new Set<Rig>()
    const made = { rigs: 0 }
    const body = `let sim_time=0, crash_t=0;
      ${lift('contrail_air')}\n${lift('contrail_band')}\n${lift('contrail_shape')}\n${lift('contrail_lay')}\n${lift('contrail_vertices')}\n${lift('contrail_engines')}\n${lift('contrail_effects')}
      return { run:contrail_effects, clock:(t)=>{ sim_time=t }, crash:(t)=>{ crash_t=t } };`
    const w = new Function('ownship', 'bandit', 'remotes', 'scene', 'camera', 'renderer', 'contrails', 'presented', 'body_offset', 'nozzle', 'wrap_axis', 'contrail_rig', body)(
      own, bandit, remotes, scene, { position: { x: 0, y: 0, z: 0 }, fov: 45 }, { domElement: { height: HEIGHT } }, contrails, (st: Jet) => st.pos, offset, nozzle, (v: number) => v,
      (st: Jet) => { made.rigs++; const r = rig(st, 700); st.contrail = r; contrails.add(r); return r }) as { run(dt: number): void; clock(t: number): void; crash(t: number): void }
    return { own, bandit, remotes, scene, contrails, run: w.run, clock: w.clock, crash: w.crash, get rigs() { return made.rigs } }
  }
  const dt = 1 / 60
  // fly steps the world for seconds of sim time
  function fly(w: World, from: number, seconds: number) {
    for (let t = from; t < from + seconds; t += dt) { w.clock(t); w.run(dt) }
    return from + seconds
  }
  const high = (extra: Partial<Jet> = {}) => jet(9800, { spools: [1, 1], reheats: [0, 0], ...extra })
  const low = (extra: Partial<Jet> = {}) => jet(3000, { spools: [1, 1], reheats: [0, 0], ...extra })

  it('lays a segment every 0.15 s for a jet trailing inside the band, and none for one below it', () => {
    const w = world(high(), low({ group: { visible: true } }))
    fly(w, 0, 3)
    expect(w.rigs).toBe(1)
    expect(w.own.contrail!.count).toBeGreaterThanOrEqual(19)
    expect(w.own.contrail!.count).toBeLessThanOrEqual(21)
    expect(w.own.contrail!.mesh.visible).toBe(true)
    expect(w.bandit.contrail).toBeUndefined()
    expect(w.own.contrail!.sa[0]).toBe(1)
    expect(w.own.contrail!.sb[0]).toBe(1)
  })

  it('draws with the camera\'s pixel size: 9.8 km below a young trail, the rows hold a pixel and a half', () => {
    const w = world(high(), low())
    fly(w, 0, 3)
    const oldest = row(w.own.contrail!, 0, 0)
    const least = Math.hypot(oldest[1].x, oldest[1].y, oldest[1].z) * (2 * Math.tan(22.5 * Math.PI / 180) / HEIGHT) * 1.5
    expect(least).toBeGreaterThan(10)
    expect(span(oldest)).toBeCloseTo(least, 1)
  })

  it('reads each engine on its own: one shut down leaves a single ribbon', () => {
    const w = world(high({ spools: [1, 0], reheats: [0, 0] }), low())
    fly(w, 0, 1)
    expect(w.own.contrail!.sa[0]).toBe(1)
    expect(w.own.contrail!.sb[0]).toBe(0)
  })

  it('trails the bandit and the remotes while they are shown, and skips a remote whose pose says it is dead', () => {
    const shown = jet(9800, { thrust: 0.9, reheat: 0 }) // a remote carries one pair from its pose, not per-engine words
    const dead = jet(9800, { thrust: 0.9, reheat: 0, group: { visible: false } })
    const w = world(low(), high(), new Map([[1, shown], [2, dead]]))
    fly(w, 0, 1)
    expect(w.bandit.contrail!.count).toBeGreaterThan(4)
    expect(shown.contrail!.count).toBeGreaterThan(4)
    expect(dead.contrail).toBeUndefined()
    expect(w.own.contrail).toBeUndefined()
  })

  it('stops laying when the ownship crashes but keeps the trail it left, and the trail expires oldest-first', () => {
    const w = world(high(), low())
    let t = fly(w, 0, 2)
    const laid = w.own.contrail!.count
    w.crash(3)
    t = fly(w, t, 1)
    expect(w.own.contrail!.count).toBe(laid)
    expect(w.own.contrail!.mesh.visible).toBe(true)
    w.clock(t + 87.5); w.run(dt) // 90.5 s: the segments laid in the first half second are past their 90 s
    expect(w.own.contrail!.count).toBeLessThan(laid)
    expect(w.own.contrail!.count).toBeGreaterThan(laid - 5)
    w.clock(t + 95); w.run(dt)
    expect(w.own.contrail!.count).toBe(0)
    expect(w.own.contrail!.mesh.visible).toBe(false)
    expect(w.contrails.size).toBe(1) // the ownship's rig is kept for its next trail
    expect(w.scene.removed).toEqual([])
  })

  it('closes a trail that stops with one clear segment, then lays nothing until the air is cold again', () => {
    const w = world(high(), low())
    let t = fly(w, 0, 1)
    const r = w.own.contrail!
    const laid = r.count
    w.own.pos.y = 3000
    t = fly(w, t, 2)
    expect(r.count).toBe(laid + 1)
    expect(r.sa[laid]).toBe(0)
    expect(r.sb[laid]).toBe(0)
    expect(r.trailing).toBe(false)
    w.own.pos.y = 9800
    fly(w, t, 1)
    expect(r.count).toBeGreaterThan(laid + 4)
    expect(w.rigs).toBe(1)
  })

  it('lets a trail outlive a remote that left, and drops the rig once the trail is gone', () => {
    const gone = jet(9800, { thrust: 0.9 })
    const remotes = new Map([[1, gone]])
    const w = world(low(), low(), remotes)
    let t = fly(w, 0, 1)
    const r = gone.contrail!
    remotes.delete(1)
    t = fly(w, t, 1)
    expect(r.count).toBeGreaterThan(4)
    expect(r.mesh.visible).toBe(true)
    expect(w.contrails.has(r)).toBe(true)
    w.clock(t + 100); w.run(dt)
    expect(r.count).toBe(0)
    expect(w.contrails.has(r)).toBe(false)
    expect(w.scene.removed).toEqual([r.mesh])
    expect(r.geo.disposed).toBe(1)
  })
})

describe('the wiring', () => {
  it('runs the contrails after the gun effects each world step', () => {
    expect(source).toMatch(/\n\tgun_effects\(dt\);[^\n]*\n\tcontrail_effects\(\);/)
  })

  it('reads each engine\'s achieved power beside its reheat for the ownship and the bandit', () => {
    expect(source).toMatch(/\township\.spools=\[out\[STATE\.engine\]\*\(1-Math\.min\(1,out\[STATE\.engine_harm\]\|\|0\)\), out\[STATE\.engine\+2\]\*\(1-Math\.min\(1,out\[STATE\.engine_harm\+1\]\|\|0\)\)\];/)
    expect(source.match(/bandit\.spools=\[w\[STATE\.engine\],w\[STATE\.engine\+2\]\]; bandit\.reheats=\[w\[STATE\.engine\+1\],w\[STATE\.engine\+3\]\];/g)).toHaveLength(2)
  })

  it('starts at the same nozzles the burner cones sit on', () => {
    expect(source).toMatch(/\nconst nozzle=\{ x:-9\.3, y:-0\.37, z:0\.48 \};/)
    expect(source).toMatch(/ab\.position\.set\(nozzle\.x,nozzle\.y,side\*nozzle\.z\)/)
  })

  it('is lit by the time of day and sits in the scene facing every camera, plain white with no texture along it', () => {
    expect(source).toMatch(/contrail_mat\.color\.setHex\(p\.sunCol\)\.lerp\(new THREE\.Color\(0xffffff\),0\.5\)\.multiplyScalar\(Math\.pow\(ratio,1\/2\.2\)\);/)
    expect(source).toMatch(/const mesh=new THREE\.Mesh\(geo,contrail_mat\); mesh\.frustumCulled=false; scene\.add\(mesh\);/)
    expect(source).toMatch(/const contrail_mat=new THREE\.MeshBasicMaterial\(\{ color:0xffffff, transparent:true, vertexColors:true, depthWrite:false, side:THREE\.DoubleSide \}\);/)
    expect(source).not.toMatch(/contrail_map|contrail_beads|CN_WAVE|CN_ROWS/) // the puffs and their map are gone, not switched off
    expect(source).toMatch(/pixel=2\*Math\.tan\(camera\.fov\*Math\.PI\/360\)\/renderer\.domElement\.height;/)
    expect(source).toMatch(/contrail_vertices\(rig,sim_time,camera\.position,pixel\)/)
  })

  it('shows the ownship\'s trail to the dev probe', () => {
    expect(source).toMatch(/contrail:\(ownship\.contrail&&ownship\.contrail\.count\)\|\|0,/)
  })
})
