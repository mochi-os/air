// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  audio_enable,
  audio_gesture,
  audio_listener,
  audio_remote,
  audio_remote_drop,
  audio_reset,
  audio_servo,
} from './audio'

// The live voices of audio.ts against a stand-in Web Audio context: one that
// records each node it makes, and what was done to it. Node has no
// AudioContext, so the module's own build runs on this one.

class Param {
  value = 0
  setTargetAtTime() {
    return this
  }
  setValueAtTime() {
    return this
  }
  linearRampToValueAtTime() {
    return this
  }
  exponentialRampToValueAtTime() {
    return this
  }
  cancelScheduledValues() {
    return this
  }
}

interface Made {
  kind: string
  loop?: boolean
  stopped: number
  disconnected: number
}

const made: Made[] = []
let buffers = 0
let offline = 0

// node is one stand-in AudioNode: connect, disconnect, start and stop are
// counted, and any parameter it is asked for (gain, frequency, positionX...)
// is a Param made on first use.
function node(kind: string): unknown {
  const record: Made = { kind, stopped: 0, disconnected: 0 }
  made.push(record)
  const fields: Record<string, unknown> = {
    connect: (next: unknown) => next,
    disconnect: () => {
      record.disconnected++
    },
    start: () => {},
    stop: () => {
      record.stopped++
    },
  }
  return new Proxy(fields, {
    get(target, key) {
      if (typeof key === 'symbol' || key === 'then') return undefined
      if (!(key in target)) target[key] = new Param()
      return target[key]
    },
    set(target, key, value) {
      if (key === 'loop') record.loop = value as boolean
      target[key as string] = value
      return true
    },
  })
}

class Context {
  state = 'running'
  currentTime = 0
  sampleRate = 8000
  destination = node('destination')
  listener: Record<string, unknown> = {
    positionX: new Param(),
    positionY: new Param(),
    positionZ: new Param(),
    forwardX: new Param(),
    forwardY: new Param(),
    forwardZ: new Param(),
    upX: new Param(),
    upY: new Param(),
    upZ: new Param(),
  }
  createGain = () => node('gain')
  createBiquadFilter = () => node('filter')
  createOscillator = () => node('oscillator')
  createPanner = () => node('panner')
  createWaveShaper = () => node('shaper')
  createDynamicsCompressor = () => node('compressor')
  createBufferSource = () => node('source')
  createBuffer(_channels: number, length: number, rate: number) {
    buffers++
    const data = new Float32Array(length)
    return { length, sampleRate: rate, numberOfChannels: 1, duration: length / rate, getChannelData: () => data }
  }
  decodeAudioData() {
    return Promise.reject(new Error('no recordings here'))
  }
  resume() {
    return Promise.resolve()
  }
  suspend() {
    return Promise.resolve()
  }
}

let context: Context
beforeAll(() => {
  const g = globalThis as unknown as Record<string, unknown>
  g.AudioContext = class extends Context {
    constructor() {
      super()
      context = this // eslint-disable-line @typescript-eslint/no-this-alias
    }
  }
  g.OfflineAudioContext = class {
    constructor() {
      offline++
    }
  }
  g.fetch = () => Promise.reject(new Error('offline'))
  audio_enable(true)
  audio_gesture()
})

afterEach(() => {
  vi.restoreAllMocks()
  audio_reset()
})

const sources = () => made.filter((m) => m.kind === 'source' && m.loop)

describe('the one-shots', () => {
  it('are filled into the live context’s buffers, with no offline context each', () => {
    expect(context).toBeDefined()
    expect(offline).toBe(0)
    expect(buffers).toBeGreaterThanOrEqual(18)
  })
})

describe("a remote jet's roar", () => {
  it('stops its looping source and lets every node of it go when dropped', () => {
    const before = made.length
    audio_remote('r1', 0, 1000, 0, 0, false)
    const voice = made.slice(before)
    const roar = voice.find((m) => m.kind === 'source' && m.loop)
    expect(roar, 'a looping source').toBeDefined()
    audio_remote_drop('r1')
    expect(roar!.stopped).toBe(1)
    expect(voice.filter((m) => m.disconnected > 0).map((m) => m.kind).sort()).toEqual(['filter', 'gain', 'gain', 'panner', 'source'])
  })

  it('is ended with every other by the reset a mission start and stop run', () => {
    const before = sources().length
    audio_remote('bandit', 0, 1000, 0, 0, true)
    audio_remote('r2', 500, 1000, 0, 0, false)
    const roars = sources().slice(before)
    expect(roars).toHaveLength(2)
    audio_reset()
    expect(roars.map((r) => r.stopped)).toEqual([1, 1])
    audio_remote('bandit', 0, 1000, 0, 0, true)
    expect(sources().length, 'the next mission builds its own voice').toBe(before + 3)
  })
})

// engine.ts cannot be imported (WebGL at module scope), so the functions that
// end the bandit are lifted from its source and run against stand-ins.
const engine = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
function lift(name: string): string {
  const start = engine.indexOf(`\nfunction ${name}(`) + 1
  expect(start, `${name} in engine.ts`).toBeGreaterThan(0)
  const rest = engine.slice(start)
  const end = /\n(?=\S)/.exec(rest.slice(1))
  return end ? rest.slice(0, end.index + 1) : rest
}

describe("the bandit's roar", () => {
  const ended = (name: string, call: string, joust = false) => {
    const dropped: string[] = []
    new Function(
      'dropped',
      'joust',
      `let has_enemy = true, traded = false, crash_t = 0, sim_time = 1
       const bandit = { group: { visible: true }, pos: { x: 0, y: 0, z: 0 } }
       const audio_remote_drop = (key) => dropped.push(key)
       const joust_pending = () => joust
       const explosion_at = () => {}, flight_debris_lay = () => {}, feed = () => {}, opponent = () => '', notice = () => {}, translate = (s) => s
       const cfg = {}, BANDIT = 'bandit'
       ${lift(name)}
       ${call}`
    )(dropped, joust)
    return dropped
  }
  it('goes with the bandit when it is destroyed', () => {
    expect(ended('bandit_destroy', 'bandit_destroy("missile")')).toEqual(['bandit'])
  })
  it('goes with the bandit when the fight stands down, and not while a joust is undecided', () => {
    expect(ended('stand_down', 'stand_down()')).toEqual(['bandit'])
    expect(ended('stand_down', 'stand_down()', true)).toEqual([])
  })
  it('and every other voice ends when a mission starts and when the engine stops', () => {
    const start = lift('start_mission')
    expect(start).toMatch(/\baudio_reset\(\)/)
    const stop = engine.slice(engine.indexOf('  function stop() {'), engine.indexOf('\n  }\n', engine.indexOf('  function stop() {')))
    expect(stop).toMatch(/\baudio_reset\(\)/)
  })
})

describe('the flap whirr', () => {
  it('keeps its cadence on one clock, whichever the context was in when it last played', () => {
    const log: string[] = []
    ;(globalThis as unknown as { dev_sounds: string[] }).dev_sounds = log
    const page = vi.spyOn(performance, 'now')
    context.state = 'suspended' // sound off: the context stopped, its clock at zero
    context.currentTime = 0
    page.mockReturnValue(1_000_000) // twenty minutes into the page
    audio_servo(true)
    context.state = 'running' // sound back on: the context's clock starts from where it stopped
    context.currentTime = 1
    page.mockReturnValue(1_000_500)
    audio_servo(true)
    delete (globalThis as unknown as { dev_sounds?: string[] }).dev_sounds
    expect(log.filter((n) => n === 'servo')).toHaveLength(2)
  })
})

describe('the listener', () => {
  it('is placed with setPosition and setOrientation where it has no AudioParams', () => {
    const placed: unknown[][] = []
    const kept = context.listener
    context.listener = {
      setPosition: (...a: unknown[]) => placed.push(['position', ...a]),
      setOrientation: (...a: unknown[]) => placed.push(['orientation', ...a]),
    }
    audio_listener(1, 2, 3, 0, 0, -1, 0, 1, 0)
    context.listener = kept
    expect(placed).toEqual([
      ['position', 1, 2, 3],
      ['orientation', 0, 0, -1, 0, 1, 0],
    ])
  })
})
