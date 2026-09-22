// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The gun's signature: a strobing tongue of flame at the port on frames a
// round leaves, a warm light on the nose, a gas streak riding the skin back
// over the canopy that fills in a tenth of a second and thins for a third,
// and one puff a round left in the air behind. The trigger the flight core
// sees for its recoil is the same answer fire_gun acts on, and follows the
// magazine. engine.ts cannot be imported (WebGL at module scope), so the
// functions are lifted out of the source and run against stand-ins.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
const bridge = readFileSync(fileURLToPath(new URL('./flight.ts', import.meta.url)), 'utf8')

// lift cuts one top-level function out of the source: from its head to the
// next line that starts at column 0 (the bodies are tab-indented).
function lift(name: string): string {
  const start = source.indexOf(`function ${name}(`)
  expect(start, `${name} in engine.ts`).toBeGreaterThan(0)
  const rest = source.slice(start)
  const end = /\n(?=\S)/.exec(rest.slice(1))
  return end ? rest.slice(0, end.index + 1) : rest
}

// A seeded generator in Math.random's place, so the flicker and the spread
// are the same run to run.
function seeded(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Rig {
  gas: number
  flash: { visible: boolean; scale: { x: number; y: number; z: number; set(x: number, y: number, z: number): void }; rotation: { x: number } }
  plume: { visible: boolean; material: { opacity: number } }
  light: { intensity: number } | null
}
interface Jet {
  burst: number
  gun: Rig | null
}

function rig(light = true): Rig {
  return {
    gas: 0,
    flash: { visible: false, scale: { x: 1, y: 1, z: 1, set(x, y, z) { this.x = x; this.y = y; this.z = z } }, rotation: { x: 0 } },
    plume: { visible: false, material: { opacity: 0 } },
    light: light ? { intensity: 0 } : null,
  }
}
const jet = (rigged = true, light = true): Jet => ({ burst: 0, gun: rigged ? rig(light) : null })

// effects builds gun_effects over stand-in jets: gun_rig hands back the jet's
// own rig (null for one whose model is not measured yet).
function effects(ownship: Jet, bandit: Jet, remotes: Map<number, Jet>) {
  const streaks = { offset: { x: 0 } }
  const run = new Function('gas_streaks', 'ownship', 'bandit', 'remotes', 'gun_rig', `${lift('gun_effects')}\nreturn gun_effects;`)(
    streaks, ownship, bandit, remotes, (st: Jet) => st.gun) as (dt: number) => void
  return { run, streaks }
}
const dt = 1 / 60

describe('the muzzle flash, nose light and gas streak', () => {
  afterEach(() => vi.restoreAllMocks())

  it('stay dark and clear while the trigger is up', () => {
    const own = jet()
    const { run } = effects(own, jet(), new Map())
    for (let frame = 0; frame < 100; frame++) run(dt)
    expect(own.gun!.flash.visible).toBe(false)
    expect(own.gun!.gas).toBe(0)
    expect(own.gun!.plume.visible).toBe(false)
    expect(own.gun!.light!.intensity).toBe(0)
  })

  it('strobe the flame on most firing frames, light the nose with it, and fill the gas within a tenth of a second', () => {
    vi.spyOn(Math, 'random').mockImplementation(seeded(3))
    const own = jet()
    const { run } = effects(own, jet(), new Map())
    let lit = 0
    const sizes = new Set<number>()
    for (let frame = 0; frame < 200; frame++) {
      own.burst = 2
      run(dt)
      expect(own.burst).toBe(0) // consumed
      if (own.gun!.flash.visible) {
        lit++
        sizes.add(own.gun!.flash.scale.y)
        expect(own.gun!.flash.scale.x).not.toBe(own.gun!.flash.scale.y) // stretched and widened independently
        expect(own.gun!.light!.intensity).toBeGreaterThan(0)
      } else {
        expect(own.gun!.light!.intensity).toBe(0)
      }
      if (frame === 9) expect(own.gun!.gas).toBeGreaterThanOrEqual(0.9) // 0.15 s in
      expect(own.gun!.plume.material.opacity).toBeCloseTo(0.55 * own.gun!.gas, 6)
    }
    expect(lit).toBeGreaterThan(140) // most frames
    expect(lit).toBeLessThan(190) // not every frame: it strobes
    expect(sizes.size).toBeGreaterThan(20) // resized every lit frame
    expect(own.gun!.gas).toBe(1)
    expect(own.gun!.plume.visible).toBe(true)
  })

  it('thins the gas for a third of a second after the last round', () => {
    const own = jet()
    const { run } = effects(own, jet(), new Map())
    for (let frame = 0; frame < 30; frame++) { own.burst = 2; run(dt) }
    expect(own.gun!.gas).toBe(1)
    for (let frame = 0; frame < 12; frame++) run(dt) // 0.2 s
    expect(own.gun!.gas).toBeGreaterThan(0.2)
    expect(own.gun!.plume.visible).toBe(true)
    for (let frame = 0; frame < 28; frame++) run(dt) // 0.67 s in all
    expect(own.gun!.gas).toBeLessThan(0.02)
    expect(own.gun!.plume.visible).toBe(false)
    expect(own.gun!.flash.visible).toBe(false)
  })

  it('drives every jet in the match once a frame, the ownship, the bandit and the remotes, and skips one whose model is not measured', () => {
    vi.spyOn(Math, 'random').mockImplementation(seeded(5))
    const own = jet()
    const bandit = jet(true, false)
    const other = jet(true, false)
    const bare = jet(false)
    const remotes = new Map<number, Jet>([[1, bandit], [2, other], [3, bare]]) // the bandit also stands in as a remote
    const { run } = effects(own, bandit, remotes)
    bandit.burst = 3
    bare.burst = 3
    run(0.05)
    expect(bandit.gun!.gas).toBeCloseTo(0.5, 6) // once, not twice: dt/0.1 per frame
    expect(bandit.burst).toBe(0)
    expect(bare.burst).toBe(0)
    expect(own.gun!.gas).toBe(0)
    expect(other.gun!.gas).toBe(0)
    let lit = 0
    for (let frame = 0; frame < 20; frame++) { other.burst = 2; run(dt); if (other.gun!.flash.visible) lit++ }
    expect(lit).toBeGreaterThan(10)
    expect(own.gun!.flash.visible).toBe(false)
  })

  it('runs the streaks aft', () => {
    const { run, streaks } = effects(jet(), jet(), new Map())
    run(0.1)
    expect(streaks.offset.x).toBeCloseTo(-0.5, 6)
  })

  it('is a flame with a hot core and a bloom facing every camera, and the nose light rides the ownship alone, above the skin', () => {
    expect(source).toMatch(/flash\.add\(new THREE\.Mesh\(flash_geo,flash_mat\),new THREE\.Mesh\(flash_core_geo,flash_core_mat\),bloom\);/)
    expect(source).toMatch(/bloom=new THREE\.Sprite\(flash_glow\); bloom\.position\.x=0\.2; bloom\.scale\.set\(1\.1,1\.1,1\);/)
    expect(source).toMatch(/\n\tif\(st===ownship\)\{ light=new THREE\.PointLight\(0xffb060,0,5,2\); light\.position\.copy\(flash\.position\); light\.position\.y\+=0\.35; g\.add\(light\); \}/)
  })
})

describe('the gas streak over the skin', () => {
  const path = new Function(`${lift('plume_path')}\nreturn plume_path;`)() as (profile: { top: number[][] }) => { x: number; y: number; z: number; radius: number; alpha: number }[]

  it('lifts clear of the measured skin and swells aft, fading toward its tail', () => {
    const spine = path({ top: [[8, 0.1], [7.5, 0.2], [7, 0.5], [6.5, 0.9]] })
    expect(spine.map((p) => p.x)).toEqual([8, 7.5, 7, 6.5])
    expect(spine[0]).toEqual({ x: 8, y: 0.22, z: 0, radius: 0.14, alpha: 1 })
    expect(spine[3].y).toBeCloseTo(1.52, 6)
    expect(spine[3].radius).toBeCloseTo(0.69, 6)
    expect(spine[3].alpha).toBeCloseTo(0.2, 6)
    for (let i = 1; i < spine.length; i++) {
      expect(spine[i].radius).toBeGreaterThan(spine[i - 1].radius)
      expect(spine[i].alpha).toBeLessThan(spine[i - 1].alpha)
      expect(spine[i].y - spine[i].radius).toBeGreaterThan(0.1 + 0.4 * (i - 1) / 3 - 0.01) // never below the skin under it
    }
  })
})

describe('the trail behind the jet', () => {
  afterEach(() => vi.restoreAllMocks())
  interface Pool { [field: string]: Float32Array | number; count: number; max: number }
  function pool(max = 4000): Pool {
    const field = () => new Float32Array(max)
    return { px: field(), py: field(), pz: field(), vx: field(), vy: field(), vz: field(), life: field(), ttl: field(), r: field(), g: field(), b: field(), sz: field(), gr: field(), spin: field(), seed: field(), count: 0, max }
  }
  const spawn = (p: Pool) => (p.count < p.max ? p.count++ : -1)
  const trail = (smoke: Pool, spawner = spawn) =>
    new Function('pool_spawn', 'smoke', `${lift('gun_trail')}\nreturn gun_trail;`)(spawner, smoke) as (st: unknown, port: unknown, fired: number, dt: number) => void
  const flying = { fwd: { x: 1, y: 0, z: 0 }, velx: 200, vely: 0, velz: 0 }
  const port = { x: 1000, y: 500, z: -20 }
  const f = (p: Pool, name: string, k: number) => (p[name] as Float32Array)[k]

  it('leaves one puff a round along the path the port flew this frame, born visible and left behind', () => {
    vi.spyOn(Math, 'random').mockImplementation(seeded(1))
    const smoke = pool()
    trail(smoke)(flying, port, 3, dt)
    expect(smoke.count).toBe(3)
    const travel = flying.velx * dt
    const behind = [0, 1, 2].map((k) => port.x - f(smoke, 'px', k))
    expect(Math.max(...behind)).toBeGreaterThan(travel * 0.5) // spread along the frame's path, not bunched at the port
    expect(Math.min(...behind)).toBeLessThan(travel * 0.5)
    for (let k = 0; k < 3; k++) {
      expect(behind[k]).toBeGreaterThan(-0.2)
      expect(behind[k]).toBeLessThan(travel + 0.2)
      expect(Math.abs(f(smoke, 'py', k) - port.y)).toBeLessThan(0.2)
      expect(Math.abs(f(smoke, 'pz', k) - port.z)).toBeLessThan(0.2)
      expect(Math.hypot(f(smoke, 'vx', k), f(smoke, 'vy', k), f(smoke, 'vz', k))).toBeLessThan(0.15 * flying.velx) // the gas stops in the air almost at once
      expect(f(smoke, 'ttl', k)).toBeGreaterThanOrEqual(1.2)
      expect(f(smoke, 'ttl', k)).toBeLessThanOrEqual(2)
      expect(f(smoke, 'ttl', k) - f(smoke, 'life', k)).toBeCloseTo(0.12, 5) // past the pool's fade-in at birth
      const shades = [f(smoke, 'r', k), f(smoke, 'g', k), f(smoke, 'b', k)]
      expect(Math.max(...shades) - Math.min(...shades)).toBeLessThan(0.1) // grey
      expect(Math.max(...shades)).toBeLessThan(0.7) // burnt propellant, darker than the launch cloud
    }
  })

  it("stops at the pool's quality limit", () => {
    const smoke = pool()
    expect(() => trail(smoke, () => -1)(flying, port, 3, dt)).not.toThrow()
    expect(smoke.count).toBe(0)
  })
})

describe('the port', () => {
  const station = (fleet: object, st: object) =>
    new Function('fleet', `${lift('gun_station')}\nreturn gun_station;`)(fleet)(st) as { x: number; y: number; z: number }

  it('is where the model was measured, and the old hand-placed spot until it is', () => {
    const measured = { x: 8.1, y: -0.3, z: 0 }
    const fleet = { fa18c: { profile: { port: measured } }, bare: { profile: null } }
    expect(station(fleet, { group: { userData: { hasModel: 'fa18c' } } })).toBe(measured)
    expect(station(fleet, { group: { userData: { hasModel: 'bare' } } })).toEqual({ x: 6.53, y: 0.43, z: 0 })
    expect(station(fleet, { group: null })).toEqual({ x: 6.53, y: 0.43, z: 0 })
  })

  it('is measured from the mesh when the model loads, at the spec distance aft of the radome tip', () => {
    expect(source).toMatch(/fleet\[kind\]=\{ proto, rig, profile:gun_profile\(proto,AIRCRAFT_MODELS\[kind\]\|\|\{\}\) \};/)
    expect(source).toMatch(/\n\t\tmuzzle:2\.4,/)
    expect(source).toMatch(/const station=box\.max\.x-\(spec\.muzzle\|\|2\.4\), height=skin\(station\);/)
    expect(source).toMatch(/return \{ port:\{ x:station, y:height\+0\.04, z:0 \}, top, tip:box\.max\.x \};/)
  })

  it('is where the tracers leave, the trail starts and the burst is recorded for the rig', () => {
    expect(source).toMatch(/const k=pool_spawn\(tracers\); if\(k<0\) break; const sp=gun_port\(st\);/)
    expect(source).toMatch(/\n\tspend\(fired\);\n\tst\.burst=fired; if\(fired>0\) gun_trail\(st,gun_port\(st\),fired,dt\);/)
    expect(source).toMatch(/battle_volley\(0,battle_pose\(ownship\),fired,battle_tick\); \} \}\n\tgun_effects\(dt\);/)
  })
})

describe('the trigger the core sees', () => {
  const trigger = (input: object, hold: boolean, ownship: object) =>
    new Function('input', 'weapons_hold', 'ownship', `${lift('trigger_own')}\nreturn trigger_own();`)(input, hold, ownship) as boolean
  const armed = { launching: false, gear: 1, rounds: 578 }

  it('is the button, with the weapons free, the gear up and rounds in the drum', () => {
    expect(trigger({ guns: true }, false, armed)).toBe(true)
    expect(trigger({ guns: false }, false, armed)).toBe(false)
    expect(trigger({ guns: true }, true, armed)).toBe(false)
    expect(trigger({ guns: true }, false, { ...armed, launching: true })).toBe(false)
    expect(trigger({ guns: true }, false, { ...armed, gear: 0.5 })).toBe(false)
    expect(trigger({ guns: true }, false, { ...armed, rounds: 0 })).toBe(false)
    expect(trigger({ guns: true }, false, { launching: false, gear: 1 })).toBe(false)
  })

  it('reaches the flight core in the controls sample, as flag bit 1024', () => {
    expect(source).toMatch(/starboard:secured\[1\], fire:trigger_own\(\), sequence:\+\+control_sequence \}/)
    // The trigger is read once into `pull` and used twice: the gun needs it,
    // and so does the burst boundary that resets the recorded near miss. It
    // must be the SAME read — `fired>0` is not a burst boundary, because at
    // 100 rounds/s a frame faster than 100 Hz often emits no whole round.
    expect(source).toMatch(/const pull=trigger_own\(\)/)
    expect(source).toMatch(/fire_gun\(ownship,MULTIPLAYER\?null:bandit,"own",dt,pull\)/)
    expect(bridge).toMatch(/\n {2}fire: boolean/)
    expect(bridge).toMatch(/\(controls\.starboard \? 512 : 0\) \|\n {4}\(controls\.fire \? 1024 : 0\)\n/)
  })

  it("mirrors the bandit's belt into its core each frame", () => {
    expect(source).toMatch(/const one=bandit_step\(bandit\.rounds\|0\); if\(!one\) break;/)
    expect(bridge).toMatch(/export function bandit_step\(rounds: number\)/)
    expect(bridge).toMatch(/core\.bandit_step\(bandit_bytes, rounds\)/)
  })
})
