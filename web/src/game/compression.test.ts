// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as compression from './compression'
import {
  FASTEST,
  SLOWEST,
  chunking,
  faster,
  slower,
  stepping,
  written,
  shortfall,
  attained,
} from './compression'
import { Hysteresis, Pacing } from './pacing'

// engine.ts cannot be imported (WebGL at module scope): lift cuts one top-level
// function out of its source, to run against stand-ins.
const source = readFileSync(
  fileURLToPath(new URL('./engine.ts', import.meta.url)),
  'utf8'
)
function lift(name: string): string {
  const start = source.indexOf(`function ${name}(`)
  expect(start, `${name} in engine.ts`).toBeGreaterThan(0)
  const rest = source.slice(start)
  const end = /\n(?=\S)/.exec(rest.slice(1))
  return end ? rest.slice(0, end.index + 1) : rest
}
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

describe('time compression', () => {
  it('Home doubles and End halves, from ¼× to 64× and no further', () => {
    const up: number[] = []
    for (let rate = SLOWEST; up.length < 12; rate = faster(rate)) up.push(rate)
    expect(up).toEqual([0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 64, 64, 64])
    expect(slower(1)).toBe(0.5)
    expect(slower(slower(slower(1)))).toBe(SLOWEST)
    expect(faster(FASTEST)).toBe(FASTEST)
  })
  it('keeps the 1/240 s core step to 16×, then lengthens it to 1/60 s at 64×', () => {
    for (const rate of [0.25, 1, 4, 16]) expect(stepping(rate)).toBe(1 / 240)
    expect(stepping(32)).toBeCloseTo(1 / 120, 12)
    expect(stepping(64)).toBeCloseTo(1 / 60, 12)
    // ...so a 60 fps frame needs about 64 core steps at every rate from 16× up
    for (const rate of [16, 32, 64])
      expect(Math.round(rate / 60 / stepping(rate))).toBe(64)
  })
  it('lengthens the world step past 16×, so a 60 fps frame runs at most 16', () => {
    for (const rate of [0.25, 1, 4, 16]) expect(chunking(rate)).toBe(1 / 60)
    expect(chunking(32)).toBeCloseTo(1 / 30, 12)
    expect(chunking(64)).toBeCloseTo(1 / 15, 12)
    for (const rate of [16, 32, 64])
      expect(Math.round(rate / 60 / chunking(rate))).toBe(16)
    for (const rate of [16, 32, 64])
      expect(
        Number.isInteger(
          Math.round((chunking(rate) / stepping(rate)) * 1e9) / 1e9
        )
      ).toBe(true) // whole core steps in each
  })
  it('writes the rate with the multiplication sign, slow motion as a fraction', () => {
    expect([0.25, 0.5, 2, 64].map(written)).toEqual(['¼×', '½×', '2×', '64×'])
  })
})

// The frame's world steps stop at the budget, and the time they owed is dropped.
describe('the frame budget', () => {
  // simulate lifted against a clock that each world step moves on by `cost` ms
  const ran = (cost: number, crash = 0) =>
    new Function(
      'chunking',
      'stepping',
      'cost',
      'crash',
      `
      let compression=64, framed=0, presenting=true, beat=0, now=0, steps=0; const MULTIPLAYER=false, running=true, net_waiting=false, crash_t=0, mission_done=false, simulated={};
      const performance={ now:()=>now }, flight_interval=()=>{}, audio_pace=()=>{}, read_input=()=>{}, step_world=()=>{ now+=cost; if(++steps===crash) compression=1; }, radar_step=()=>{}, rwr_step=()=>{}, recording_checkpoint=()=>{}, sea_advance=()=>{};
      ${/\nconst BUDGET=[^\n]*\n/.exec(source)?.[0] ?? ''}${lift('simulate')}
      simulate(1/60); return framed*60;`
    )(chunking, stepping, cost, crash) as number
  it('fits 64× in free flight into a 60 fps frame', () => {
    expect(ran(0.45)).toBeCloseTo(64, 6) // free flight's world step, measured headless
  })
  it('drops what a costlier world cannot fit, rather than carrying it', () => {
    expect(ran(0.9)).toBeLessThan(64 * 0.95) // a joust's, the bandit's brain included
  })
  it('ends the frame a step after a crash returns the world to 1×', () => {
    expect(ran(0.45, 3)).toBeCloseTo(16, 6) // four of the frame's sixteen fifteenths of a second
  })
})

// A crash returns the world to real time, as a respawn and a new mission do.
describe('the crash', () => {
  it('returns the world to 1×', () => {
    const rate = new Function(`
      let crash_t=0, own_written=true, compression=64, own_killer='', own_deaths=0, look_home=true, has_enemy=false; const MULTIPLAYER=false;
      const ownship={ pos:{ x:0, y:0, z:0 }, group:{ visible:true }, speed:200 }, bandit={ group:{} }, cfg={}, latch=()=>{}, feed=()=>{}, explosion_at=()=>{};
      ${lift('crash_ownship').replace(/ as any/g, '')}
      crash_ownship('sea'); return compression;`)() as number
    expect(rate).toBe(1)
  })
})

// The corner: refresh_perf with its state, lifted, against a stand-in element
// of two lines. fly runs frames of `ms` wall milliseconds, the world advancing
// `ran` times each one's length.
interface Corner {
  fly: (ms: number, frames: number, ran: number) => void
  set: (change: { rate?: number; paused?: boolean }) => void
  settle: () => void
  read: () => { shown: string; corner: string; warning: string }
}
const perf = source.slice(
  source.indexOf('\nconst pacing=new Pacing()'),
  source.indexOf('\nfunction refresh_perf(')
)
function corner(
  rate: number,
  options: { multiplayer?: boolean; fps?: boolean } = {}
): Corner {
  expect(perf).toMatch(/^\nconst pacing=new Pacing\(\)/)
  return new Function(
    'Pacing',
    'Hysteresis',
    ...Object.keys(compression),
    'rate',
    'options',
    `
    let running=true, game_paused=false, framed=0; const MULTIPLAYER=!!options.multiplayer;
    const cfg={ framerate:!!options.fps }, lines=[{ textContent:'' }, { textContent:'' }], framerate={ style:{ display:'' }, children:lines };
    const world_rate=()=>rate, translate=(t,v)=>v?t.replace('{rate}',v.rate):t, figure=(v,d)=>v+'/'+d;
    ${perf}${lift('refresh_perf')}
    return {
      fly(ms,frames,ran){ for(let k=0;k<frames;k++){ framed=Math.min(ms,50)/1000*ran; refresh_perf(ms/1000); } },
      set(change){ if(change.rate!==undefined) rate=change.rate; if(change.paused!==undefined) game_paused=change.paused; },
      settle(){ pacing.reset(); },
      read(){ return { shown:framerate.style.display, corner:lines[0].textContent, warning:lines[1].textContent }; },
    };`
  )(Pacing, Hysteresis, ...Object.values(compression), rate, options) as Corner
}
const FRAME = 1000 / 60
const seconds = (n: number) => Math.round((n * 1000) / FRAME)

describe('the corner', () => {
  it('writes the rate asked for, even when the frame budget holds the world short of it', () => {
    const read = (rate: number, ran: number, fps = false) => {
      const c = corner(rate, { fps })
      c.fly(FRAME, seconds(1), ran)
      return c.read()
    }
    expect(read(64, 30).corner).toBe('64×') // the world ran 30× in the budget
    expect(read(64, 64)).toEqual({ shown: 'block', corner: '64×', warning: '' })
    expect(read(0.25, 0.25).corner).toBe('¼×')
    expect(read(1, 1)).toEqual({ shown: 'none', corner: '', warning: '' })
    expect(read(8, 8, true).corner).toMatch(/^8× · \d+ fps · \d+ 1% low$/)
  })
  it('warns once the world has run short of the rate for a second, with the rate it reached, until three seconds clear', () => {
    const c = corner(64)
    c.fly(FRAME, seconds(0.75), 30)
    expect(c.read().warning).toBe('')
    c.fly(FRAME, seconds(0.5), 30)
    expect(c.read().warning).toBe('Slowed to 30/0×')
    c.fly(FRAME, seconds(2.5), 64)
    expect(
      Number(/^Slowed to (\d+)\/0×$/.exec(c.read().warning)?.[1])
    ).toBeLessThan(64 * 0.95) // held at the rate it last fell short at
    c.fly(FRAME, seconds(1), 64)
    expect(c.read().warning).toBe('')
  })
  it('writes the rate reached in tenths below 2×, the corner shown for the warning alone', () => {
    const c = corner(1)
    c.fly(80, 25, 1) // 12.5 fps: the world steps 50 ms of each 80
    expect(c.read()).toEqual({
      shown: 'block',
      corner: '',
      warning: 'Slowed to 0.6/1×',
    })
  })
  it("warns of no slowdown in multiplayer, where the world is the server's", () => {
    const c = corner(1, { multiplayer: true })
    c.fly(80, 50, 1)
    expect(c.read().warning).toBe('')
  })
  it('warns of nothing while paused, and judges afresh after', () => {
    const c = corner(64)
    c.fly(FRAME, seconds(1.5), 30)
    expect(c.read().warning).toBe('Slowed to 30/0×')
    c.set({ paused: true })
    c.fly(FRAME, seconds(0.25), 0)
    expect(c.read().warning).toBe('')
    c.set({ paused: false })
    c.fly(FRAME, seconds(0.75), 30)
    expect(c.read().warning).toBe('')
    c.fly(FRAME, seconds(0.5), 30)
    expect(c.read().warning).toBe('Slowed to 30/0×')
  })
  it('judges a new rate afresh', () => {
    const c = corner(64)
    c.fly(FRAME, seconds(1.5), 30)
    c.set({ rate: 32 })
    c.fly(FRAME, seconds(0.25), 32)
    expect(c.read().warning).toBe('') // the warning was 64×'s, and 32× keeps up
  })
  it("says nothing of frames that miss the display's refreshes while the world keeps its rate", () => {
    for (const rate of [0.25, 1, 64]) {
      const c = corner(rate)
      c.fly(FRAME, seconds(4), rate)
      for (let k = 0; k < 90; k++) {
        c.fly(FRAME, 1, rate)
        c.fly(2 * FRAME, 1, rate) // every other frame a refresh late
      }
      expect(c.read().warning, `${rate}×`).toBe('')
    }
  })
  it('warns of nothing in the settling second after a start or a resize, and judges afresh after', () => {
    const c = corner(64)
    c.fly(FRAME, seconds(1.5), 30)
    expect(c.read().warning).toBe('Slowed to 30/0×')
    c.settle()
    c.fly(FRAME, seconds(0.25), 30)
    expect(c.read().warning).toBe('')
    c.fly(FRAME, seconds(1.25), 30)
    expect(c.read().warning).toBe('')
    c.fly(FRAME, seconds(1), 30)
    expect(c.read().warning).toBe('Slowed to 30/0×')
  })
  it('falls a twentieth short before it warns, and writes the rate rounded down', () => {
    expect(shortfall(64, 60.8)).toBe(false)
    expect(shortfall(64, 60.7)).toBe(true)
    expect(shortfall(1, 0.96)).toBe(false)
    expect(attained(60.79)).toEqual([60, 0]) // never the 64× asked for
    expect(attained(2)).toEqual([2, 0])
    expect(attained(1.96)).toEqual([1.9, 1])
    expect(attained(0.625)).toEqual([0.6, 1])
  })
})

// The world's effects move by its seconds, not by how often a frame or a world
// step comes round: the same at 60 and 120 fps, and in the short steps time
// compression and slow motion fly.
describe('the effects on the world clock', () => {
  const ballistic = new Function(
    'smoke',
    'round_length',
    `${lift('update_pool_ballistic')} return update_pool_ballistic;`
  )(null, () => 1) as (
    p: unknown,
    dt: number,
    grav: number,
    drag: number
  ) => void
  const pool = () => ({
    activeList: [0],
    active: [1],
    px: [0],
    py: [100],
    pz: [0],
    vx: [50],
    vy: [0],
    vz: [0],
    life: [9],
    ttl: [9],
    pos: [0],
  })
  it('slows a particle by the same drag a second at any step', () => {
    const after = (step: number) => {
      const p = pool()
      for (let k = 0; k < Math.round(1 / step); k++) ballistic(p, step, 0, 0.96)
      return p.vx[0]
    }
    expect(after(1 / 60)).toBeCloseTo(50 * 0.96 ** 60, 6)
    expect(after(1 / 120)).toBeCloseTo(after(1 / 60), 6) // it once kept 0.96 a call, so 120 fps slowed smoke twice as fast
    expect(after(1 / 240)).toBeCloseTo(after(1 / 60), 6)
  })
  it('lets a trail out at the same rate of puffs a second at any step', () => {
    const emitted = (step: number) => {
      const random = Math.random
      Math.random = seeded(7)
      try {
        const count = new Function(`${lift('emitted')} return emitted;`)() as (
          rate: number,
          dt: number
        ) => number
        let n = 0
        for (let k = 0; k < Math.round(100 / step); k++) n += count(0.4, step)
        return n
      } finally {
        Math.random = random
      }
    }
    for (const step of [1 / 60, 1 / 120, 1 / 240, 0.05]) {
      expect(emitted(step) / 2400, `${step}`).toBeGreaterThan(0.95) // 0.4 a 60th of a second for 100 s
      expect(emitted(step) / 2400, `${step}`).toBeLessThan(1.05)
    }
  })
})

// The damage cascade and the bandit's gun run on the world's clock too: both
// once ran at the display's rate.
describe('the battle on the world clock', () => {
  it('advances the damage cascade a 60th of a second at a time, whatever the step', () => {
    const block = /\n\t\tbattle_acc\+=dt;[\s\S]*?if\(battle\[3\]>0\) downed=true; \}/.exec(source)?.[0] ?? ''
    expect(block).not.toBe('')
    const calls = (step: number) => new Function('step', `let battle_acc=0, battle_tick=0, battle_reset=false, extinguish_flag=false, n=0, own_burning=false, own_leak=0; const secured=[false,false], ownship={ throttle:1 }, own_burn=[0,0];
      const battle_progress=()=>{ n++; return []; }, cooked=()=>{}, has_enemy=false, BATTLE={ explode:1 };
      for(let k=0;k<Math.round(2/step);k++){ const dt=step; ${block}
      }
      return n;`)(step) as number
    for (const step of [1 / 30, 1 / 60, 1 / 120, 1 / 240, 1 / 15]) expect(calls(step), `${step}`).toBe(120) // two seconds of the world: a fire burns as long at 120 fps
  })
  it('meters the bandit\'s gun by the time its brain flew, so 120 fps fires its 100 rounds a second', () => {
    const flown = /fire_gun\(bandit,ownship,"bandit",([^,]+),step\.fire&&!weapons_hold\)/.exec(source)?.[1] ?? ''
    expect(flown).not.toBe('')
    const fired = (fps: number) => new Function('fps', `let bandit_acc=0, rounds=0; const gun={};
      for(let k=0;k<fps*2;k++){ const dt=1/fps; bandit_acc+=dt; let count=Math.floor(bandit_acc*60+1e-9); bandit_acc-=count/60;
        if(count>0){ gun.b=(gun.b||0)+100*(${flown}); while(gun.b>=1){ gun.b-=1; rounds++; } } }
      return rounds;`)(fps) as number
    for (const fps of [30, 60, 120, 144]) expect(Math.abs(fired(fps) - 200), `${fps} fps`).toBeLessThanOrEqual(2) // two seconds of trigger
  })
})

// What the pilot's hand does runs on the pilot's clock: a press is as long at
// 64x as at 1x, and a flash for the eye keeps its phase.
describe("the pilot's hand on the pilot's clock", () => {
  const line = (pattern: RegExp) => { const m = pattern.exec(source)?.[0] ?? ''; expect(m, String(pattern)).not.toBe(''); return m }
  it('jettisons the first pair for a quick press at any rate, and the rest only for as long as the button is held', () => {
    const call = /\n\temergency_update\(([^,]+), ([^;]+)\);/.exec(source)
    expect(call).not.toBeNull()
    const groups = (rate: number, held: number, click = false) => new Function('rate', 'held', 'click', 'step', `
      ${line(/\nconst EMERGENCY_PAIRS=[^\n]*\n/)}${line(/\nconst emergency=\{[^\n]*\n/)}${line(/\nconst EMERGENCY_HOLD=[^\n]*\n/)}
      let glance=0, sim_time=0, released=0; const keys=new Set(), key_of=(a)=>a, world_rate=()=>rate, notice=()=>{}, translate=(t)=>t;
      const jettison_stations=()=>{ released++; return true; };
      ${lift('emergency_update')}
      if(click) emergency_clicked=0; else keys.add('jettison.emergency');
      while(glance<3){ const dt=step; sim_time+=dt; glance+=dt/rate; if(!click&&glance>held) keys.delete('jettison.emergency');
        emergency_update(${call![1]}, ${call![2]}); }
      return released;`)(rate, held, click, chunking(rate)) as number
    for (const rate of [1, 64]) {
      expect(groups(rate, 0.2), `${rate}x press`).toBe(1) // the wing pair alone: at 64x the 0.3 s gaps once fell inside a press
      expect(groups(rate, 0.5), `${rate}x held`).toBe(2)
      expect(groups(rate, 0, true), `${rate}x click`).toBe(3) // a click holds the button 1.2 s of the pilot's time
    }
    expect(groups(0.25, 0.2)).toBe(1)
  })
  it("gives the autopilot the pilot's seconds for the trim switch, and the eye's clock for the CPL and DATA flashes", () => {
    expect(source).toMatch(/\n\tconst c=autopilot\.step\(hold,s,dt,dt\/world_rate\(\)\);/)
    expect(source.match(/autopilot\.cue\(hold,sim_time,glance\)/g)).toHaveLength(2) // the HSI's CPL and the HUD's
    expect(source).not.toMatch(/autopilot\.cue\(hold,sim_time\)/)
    expect(source).toMatch(/datalink\.flashing\(link,sim_time,glance\)/)
  })
})

// The map: a view, not a pause. The world flies on under it in single player,
// at whatever rate it runs, as it does in a match, and the corner stays on top.
describe('the map view', () => {
  it('pauses nothing: only the Esc popup holds single player', () => {
    const paused = /\n\tgame_paused = ([^;]*);/.exec(source)?.[1] ?? ''
    expect(paused).toBe('running && !MULTIPLAYER && menu_hold')
  })
  it('keeps the corner\'s rate and frame rate above the map', () => {
    const css = readFileSync(fileURLToPath(new URL('./game.css', import.meta.url)), 'utf8')
    const layer = (id: string) => Number(new RegExp(`\\.air-game #${id} \\{[^}]*z-index: (\\d+);`).exec(css)?.[1])
    expect(layer('map')).toBeGreaterThan(0)
    expect(layer('framerate')).toBeGreaterThan(layer('map'))
  })
})
