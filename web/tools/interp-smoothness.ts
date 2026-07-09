// Remote-aircraft interpolation smoothness probe (#81).
//
// Drives the REAL client interpolation (net.ts Net.handle / Net.remote /
// soften) with a synthetic snapshot stream of a remote jet in a hard 5 g turn
// — the case where 20 Hz linear samples between snapshots facet the arc — and
// measures the frame-to-frame velocity discontinuity ("jerk") a viewer sees.
//
// It compares three tracks per condition:
//   arc-floor : the true arc sampled at 60 Hz — the perfect-smoothness baseline
//   interp    : Net.remote() — the real smoothing under test
//   naive     : the newest raw packet each frame, no interp — the worst case
//
// Run: apps/furball/web/tools/run-interp-smoothness.sh
// (bundles this with esbuild, stubbing @mochi/web, then runs under Node.)

import { Net } from '../src/game/net'

// A controllable local clock: net.ts reads performance.now() for arrival times
// (Net.handle) and the render target (Net.remote).
let VT = 0 // ms
;(globalThis as { performance: { now(): number } }).performance = { now: () => VT }

const SPEED = 200 // m/s
const OMEGA = 0.24 // rad/s ≈ 5 g at 200 m/s — the faceting-worst maneuver
const RADIUS = SPEED / OMEGA
const ALT = 3000
const DURATION = 6 // seconds

type V3 = [number, number, number]

function truth(t: number): { pos: V3; dir: V3 } {
  const theta = OMEGA * t
  return {
    pos: [RADIUS * Math.sin(theta), ALT, RADIUS * Math.cos(theta)],
    dir: [Math.cos(theta), 0, -Math.sin(theta)],
  }
}

function encodePose(slot: number, pos: V3, dir: V3, speed: number): Uint8Array {
  const b = new Uint8Array(34)
  const v = new DataView(b.buffer)
  v.setUint8(0, slot)
  v.setFloat32(1, pos[0], true)
  v.setFloat32(5, pos[1], true)
  v.setFloat32(9, pos[2], true)
  v.setInt16(19, 32767, true) // attitude w ≈ 1 (unused by the smoothing)
  v.setInt8(21, Math.round(dir[0] * 127))
  v.setInt8(22, Math.round(dir[1] * 127))
  v.setInt8(23, Math.round(dir[2] * 127))
  v.setUint16(24, Math.round(speed * 10), true)
  v.setUint8(26, 1) // alive flag
  return b
}

// Deterministic RNG (no Math.random, so runs are reproducible).
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// jerk = magnitude of the frame-to-frame acceleration change, in m/s².
function roughness(track: V3[]): number[] {
  const step: V3[] = []
  for (let i = 1; i < track.length; i++)
    step.push([track[i][0] - track[i - 1][0], track[i][1] - track[i - 1][1], track[i][2] - track[i - 1][2]])
  const out: number[] = []
  for (let i = 1; i < step.length; i++)
    out.push(Math.hypot((step[i][0] - step[i - 1][0]) * 3600, (step[i][1] - step[i - 1][1]) * 3600, (step[i][2] - step[i - 1][2]) * 3600))
  return out
}

function percentile(a: number[], q: number): number {
  const s = [...a].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]
}

function run(label: string, snapHz: number, latency: number, jitter: number, loss: number) {
  const net = new Net({} as never, {} as never)
  ;(net as unknown as { slot: number }).slot = 0 // we observe slot 1
  const rand = rng(12345)
  const SLOT = 1
  const interp: V3[] = []
  const naive: V3[] = []
  const errs: number[] = []
  const snapStep = 60 / snapHz // server ticks between snapshots
  let nextSnapTick = 0

  for (let frame = 0; frame < DURATION * 60; frame++) {
    const localSec = frame / 60
    VT = localSec * 1000
    // deliver every snapshot whose (latency + jitter) arrival time has passed
    for (;;) {
      const tick = nextSnapTick
      const arrive = tick / 60 + (latency + (rand() * 2 - 1) * jitter) / 1000
      if (arrive > localSec) break
      nextSnapTick += snapStep
      if (rand() < loss) continue // dropped packet
      const g = truth(tick / 60)
      const saved = VT
      VT = arrive * 1000
      ;(net as unknown as { handle(m: Record<string, unknown>): void }).handle({ kind: 'poses', tick, blob: encodePose(SLOT, g.pos, g.dir, SPEED) })
      VT = saved
    }
    const ring = (net as unknown as { rings: Map<number, { pose: { position: V3 } }[]> }).rings.get(SLOT)
    if (ring && ring.length) naive.push([...ring[ring.length - 1].pose.position])
    const r = net.remote(SLOT)
    if (r) {
      interp.push([r.position[0], r.position[1], r.position[2]])
      const target = localSec - (net as unknown as { clock: number }).clock - 0.1
      const gt = truth(target)
      errs.push(Math.hypot(r.position[0] - gt.pos[0], r.position[1] - gt.pos[1], r.position[2] - gt.pos[2]))
    }
  }

  const floorTrack: V3[] = []
  for (let f = 0; f < DURATION * 60; f++) floorTrack.push(truth(f / 60).pos)
  const rInterp = percentile(roughness(interp), 0.99)
  const rNaive = percentile(roughness(naive), 0.99)
  const rFloor = percentile(roughness(floorTrack), 0.99)
  const ratio = (rInterp - rFloor > 0 ? rNaive / rInterp : Infinity).toFixed(0)
  console.log(
    `${label.padEnd(24)} interp ${rInterp.toFixed(0).padStart(6)}  naive ${rNaive.toFixed(0).padStart(7)}  floor ${rFloor.toFixed(0).padStart(3)}  (m/s²)   ${ratio}× smoother   trackErr ${percentile(errs, 1).toFixed(1)}m`,
  )
}

console.log('Remote-jet interpolation smoothness (5 g turn, 200 m/s, 6 s) — p99 frame-to-frame jerk:')
run('ideal 20 Hz', 20, 50, 0, 0)
run('20 Hz +15 ms jitter', 20, 50, 15, 0)
run('20 Hz +15 ms +15% loss', 20, 50, 15, 0.15)
run('far-tail 6.7 Hz (roving)', 6.67, 50, 15, 0.1)
