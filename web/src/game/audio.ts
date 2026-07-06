// Copyright © 2026 Mochi OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// Game audio (#73): everything is SYNTHESIZED — continuous sources (engines,
// wind, fires) as live Web Audio graphs modulated per frame from the flight
// core's own values, one-shots (gun, explosions, clunks) pre-rendered once
// at startup with an OfflineAudioContext. No recorded assets: nothing to
// license, nothing to download, and the engine note tracks the spool
// continuously instead of pitch-shifting a loop. Any single voice here can
// later be swapped for a real recording (DVIDS carrier audio is public
// domain) without touching the callers.
//
// The context starts suspended until the first user gesture (browser
// policy); every entry point is safe to call before init or with audio off.

let context: AudioContext | null = null
let master: GainNode | null = null
let enabled = true
// Mixer buses (#73): every voice routes through one; the menu's Sound tab
// drives the levels (0..1). Master multiplies into the enable ramp.
const BUSES = ['engine', 'aircraft', 'weapons', 'environment', 'alerts'] as const
type Bus = (typeof BUSES)[number]
const buses: Partial<Record<Bus, GainNode>> = {}
const levels: Record<string, number> = { master: 1, engine: 1, aircraft: 1, weapons: 1, environment: 1, alerts: 1 }
// one-shot routing
const SHOT_BUS: Record<string, Bus> = {
  gun: 'weapons', explosion: 'weapons', launch: 'weapons', flare: 'weapons',
  hit: 'aircraft', catapult: 'aircraft', trap: 'aircraft', touchdown: 'aircraft', servo: 'aircraft', eject: 'aircraft',
  caution: 'alerts', horn: 'alerts',
}
function bus(name: Bus): GainNode {
  return buses[name] ?? (master as GainNode)
}
// audio_volumes applies the menu mix (values 0..100); cheap enough per frame.
export function audio_volumes(volume: Record<string, number> | undefined): void {
  if (!context) return
  for (const name of ['master', ...BUSES]) {
    const v = volume && volume[name] !== undefined ? Number(volume[name]) / 100 : 1
    if (levels[name] !== v) {
      levels[name] = v
      if (name === 'master') { if (master && enabled) master.gain.setTargetAtTime(v, now(), 0.05) }
      else buses[name as Bus]?.gain.setTargetAtTime(v, now(), 0.05)
    }
  }
}

// Continuous voices, built once.
interface Voice {
  gain: GainNode
  tune?: (value: number) => void
}
let engines: { whine: OscillatorNode; second: OscillatorNode; whineGain: GainNode; rumble: BiquadFilterNode; hiss: BiquadFilterNode; hissGain: GainNode; gain: GainNode }[] = []
let burner: Voice | null = null
let wind: { source: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode } | null = null
let buffet: Voice | null = null
let fire: Voice | null = null
let deck: Voice | null = null

// Pre-rendered one-shot buffers.
const shots: Record<string, AudioBuffer> = {}
let gunLoop: AudioBufferSourceNode | null = null

// A long looping noise buffer shared by every noise-based voice.
let noiseBuffer: AudioBuffer | null = null
let brownBuffer: AudioBuffer | null = null

const smooth = 0.06 // setTargetAtTime constant for per-frame parameter moves

function now(): number {
  return context ? context.currentTime : 0
}

// gesture starts (or resumes) the context — call from any input handler.
export function audio_gesture(): void {
  if (!enabled) return
  if (!context) build()
  if (context && context.state === 'suspended') void context.resume()
}

let lastEnable: boolean | null = null
export function audio_enable(on: boolean): void {
  if (on === lastEnable) return
  lastEnable = on
  enabled = on
  if (master) master.gain.setTargetAtTime(on ? levels.master : 0, now(), 0.05)
  if (!on && context && context.state === 'running') void context.suspend()
  if (on && context && context.state === 'suspended') void context.resume()
}

// ---------------------------------------------------------------- builders

function noise(length: number, brown: boolean): AudioBuffer {
  const c = context as AudioContext
  const buffer = c.createBuffer(1, Math.floor(c.sampleRate * length), c.sampleRate)
  const data = buffer.getChannelData(0)
  let last = 0
  for (let i = 0; i < data.length; i++) {
    const white = Math.random() * 2 - 1
    if (brown) {
      last = (last + 0.02 * white) / 1.02
      data[i] = last * 3.5
    } else data[i] = white
  }
  return buffer
}

function looper(buffer: AudioBuffer): AudioBufferSourceNode {
  const c = context as AudioContext
  const source = c.createBufferSource()
  source.buffer = buffer
  source.loop = true
  source.start()
  return source
}

function build(): void {
  try {
    context = new AudioContext()
  } catch {
    enabled = false
    return
  }
  const c = context
  master = c.createGain()
  master.gain.value = enabled ? levels.master : 0
  master.connect(c.destination)
  for (const name of BUSES) { const g = c.createGain(); g.gain.value = levels[name]; g.connect(master); buses[name] = g }
  noiseBuffer = noise(2.0, false)
  brownBuffer = noise(2.0, true)

  // Two turbofans. A jet's voice is NOISE, not a note (a pitched sawtooth here
  // read as a lawnmower): deep exhaust rumble + a mid "tearing" hiss that opens
  // with spool, and only a thin, distant compressor whine far up top — two
  // slightly detuned tones so the pair beats like real N1/N2 spools.
  for (let e = 0; e < 2; e++) {
    const gain = c.createGain()
    gain.gain.value = 0
    gain.connect(bus('engine'))
    const rumble = c.createBiquadFilter()
    rumble.type = 'lowpass'
    rumble.frequency.value = 140
    const rumbleGain = c.createGain()
    rumbleGain.gain.value = 0.6
    looper(brownBuffer).connect(rumble).connect(rumbleGain).connect(gain)
    const hiss = c.createBiquadFilter()
    hiss.type = 'bandpass'
    hiss.frequency.value = 500
    hiss.Q.value = 0.6
    const hissGain = c.createGain()
    hissGain.gain.value = 0.1
    looper(noiseBuffer).connect(hiss).connect(hissGain).connect(gain)
    const whine = c.createOscillator()
    whine.type = 'sine'
    whine.frequency.value = 2400
    const second = c.createOscillator()
    second.type = 'sine'
    second.frequency.value = 3050
    const whineGain = c.createGain()
    whineGain.gain.value = 0.02
    whine.connect(whineGain)
    second.connect(whineGain)
    whineGain.connect(gain)
    whine.start()
    second.start()
    engines.push({ whine, second, whineGain, rumble, hiss, hissGain, gain })
  }

  // Afterburner: heavy brown rumble.
  {
    const gain = c.createGain()
    gain.gain.value = 0
    const source = looper(brownBuffer)
    const filter = c.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 160
    source.connect(filter).connect(gain).connect(bus('engine'))
    burner = { gain }
  }

  // Airflow: white noise through a speed-tracking lowpass.
  {
    const gain = c.createGain()
    gain.gain.value = 0
    const source = looper(noiseBuffer)
    const filter = c.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 400
    source.connect(filter).connect(gain).connect(bus('aircraft'))
    wind = { source, filter, gain }
  }

  // Buffet: low rumble amplitude-wobbled near the alpha limiter.
  {
    const gain = c.createGain()
    gain.gain.value = 0
    const source = looper(brownBuffer)
    const filter = c.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 60
    const wobble = c.createOscillator()
    wobble.frequency.value = 9
    const depth = c.createGain()
    depth.gain.value = 0.5
    const carrier = c.createGain()
    carrier.gain.value = 0.5
    wobble.connect(depth).connect(carrier.gain)
    wobble.start()
    source.connect(filter).connect(carrier).connect(gain).connect(bus('aircraft'))
    buffet = { gain }
  }

  // Fire: crackling — brown noise with random impulse bursts baked into a loop.
  {
    const gain = c.createGain()
    gain.gain.value = 0
    const buffer = c.createBuffer(1, c.sampleRate * 2, c.sampleRate)
    const data = buffer.getChannelData(0)
    let last = 0
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1
      last = (last + 0.02 * white) / 1.02
      data[i] = last * 2.5
      if (Math.random() < 0.0004) {
        const burst = Math.min(220, data.length - i)
        for (let k = 0; k < burst; k++) data[i + k] += (Math.random() * 2 - 1) * Math.exp(-k / 40) * 0.8
        i += burst - 1
      }
    }
    const source = c.createBufferSource()
    source.buffer = buffer
    source.loop = true
    source.start()
    source.connect(gain).connect(bus('aircraft'))
    fire = { gain }
  }

  // Deck/sea ambience: slow-breathing filtered noise, on when parked.
  {
    const gain = c.createGain()
    gain.gain.value = 0
    const source = looper(noiseBuffer)
    const filter = c.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 500
    const swell = c.createOscillator()
    swell.frequency.value = 0.13
    const depth = c.createGain()
    depth.gain.value = 0.3
    const carrier = c.createGain()
    carrier.gain.value = 0.7
    swell.connect(depth).connect(carrier.gain)
    swell.start()
    source.connect(filter).connect(carrier).connect(gain).connect(bus('environment'))
    deck = { gain }
  }

  void bake()
}

// bake pre-renders every one-shot into a named buffer.
async function bake(): Promise<void> {
  const c = context as AudioContext
  const render = async (length: number, fill: (data: Float32Array, rate: number) => void): Promise<AudioBuffer> => {
    const offline = new OfflineAudioContext(1, Math.ceil(c.sampleRate * length), c.sampleRate)
    const buffer = offline.createBuffer(1, offline.length, offline.sampleRate)
    fill(buffer.getChannelData(0), offline.sampleRate)
    return buffer
  }
  const decay = (i: number, rate: number, t: number) => Math.exp(-i / (rate * t))

  // M61 burr: 100 rounds/s — each round a 3 ms crack over a 140 Hz thump.
  shots.gun = await render(0.5, (d, r) => {
    for (let shot = 0; shot < 50; shot++) {
      const at = Math.floor((shot / 100) * r)
      for (let i = 0; i < r * 0.008 && at + i < d.length; i++) {
        d[at + i] += (Math.random() * 2 - 1) * decay(i, r, 0.002) * 0.9
        d[at + i] += Math.sin((i / r) * 2 * Math.PI * 140) * decay(i, r, 0.005) * 0.7
      }
    }
  })
  // Rounds striking us: a metallic clank cluster.
  shots.hit = await render(0.25, (d, r) => {
    for (const [f, a] of [[2100, 0.5], [3400, 0.3], [820, 0.6]] as [number, number][])
      for (let i = 0; i < d.length; i++) d[i] += Math.sin((i / r) * 2 * Math.PI * f) * decay(i, r, 0.03) * a
    for (let i = 0; i < r * 0.01; i++) d[i] += (Math.random() * 2 - 1) * decay(i, r, 0.004) * 0.8
  })
  // Explosion: crack into a long low rumble (distance shaping at play time).
  shots.explosion = await render(2.2, (d, r) => {
    let last = 0
    for (let i = 0; i < d.length; i++) {
      const white = Math.random() * 2 - 1
      if (i < r * 0.03) d[i] += white * decay(i, r, 0.012) * 1.2
      last = (last + 0.03 * white) / 1.03
      d[i] += last * 3.2 * decay(i, r, 0.7)
    }
  })
  // Missile away: a bandpass whoosh sweeping down with a rumble tail.
  shots.launch = await render(1.4, (d, r) => {
    let last = 0
    for (let i = 0; i < d.length; i++) {
      const white = Math.random() * 2 - 1
      last = last + (white - last) * (0.35 - 0.28 * (i / d.length))
      d[i] = last * decay(i, r, 0.6) * 0.9
    }
  })
  // Flare pop.
  shots.flare = await render(0.3, (d, r) => {
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * decay(i, r, 0.05) * 0.5
  })
  // Catapult: holdback clunk, building rumble, end clunk.
  shots.catapult = await render(2.6, (d, r) => {
    const clunk = (at: number, f: number, a: number) => {
      const base = Math.floor(at * r)
      for (let i = 0; i < r * 0.15 && base + i < d.length; i++)
        d[base + i] += Math.sin((i / r) * 2 * Math.PI * f) * decay(i, r, 0.04) * a
    }
    clunk(0, 70, 1.0)
    let last = 0
    for (let i = 0; i < d.length; i++) {
      const white = Math.random() * 2 - 1
      last = (last + 0.02 * white) / 1.02
      d[i] += last * 3 * Math.min(1, (i / d.length) * 1.6) * 0.8
    }
    clunk(2.3, 55, 1.1)
  })
  // Trap: wire twang and a tyre-screech decaying under deceleration.
  shots.trap = await render(1.6, (d, r) => {
    for (let i = 0; i < d.length; i++) {
      d[i] += Math.sin((i / r) * 2 * Math.PI * (190 - 60 * (i / d.length))) * decay(i, r, 0.35) * 0.5
      if (i < r * 1.1) d[i] += (Math.random() * 2 - 1) * (0.4 + 0.3 * Math.sin((i / r) * 2 * Math.PI * 13)) * decay(i, r, 0.4) * 0.5
    }
  })
  // Touchdown: a thump and a tyre chirp.
  shots.touchdown = await render(0.5, (d, r) => {
    for (let i = 0; i < d.length; i++) {
      d[i] += Math.sin((i / r) * 2 * Math.PI * 55) * decay(i, r, 0.09) * 1.0
      if (i < r * 0.06) d[i] += (Math.random() * 2 - 1) * decay(i, r, 0.02) * 0.45
    }
  })
  // Actuator servo: a soft falling whine for gear/flap/hook travel.
  shots.servo = await render(1.8, (d, r) => {
    for (let i = 0; i < d.length; i++) {
      const f = 420 - 90 * (i / d.length)
      d[i] = (Math.sin((i / r) * 2 * Math.PI * f) + 0.3 * Math.sin((i / r) * 2 * Math.PI * f * 2.01)) * 0.09
    }
  })
  // Ejection: canopy bang, rocket roar, wind tail.
  shots.eject = await render(2.0, (d, r) => {
    let last = 0
    for (let i = 0; i < d.length; i++) {
      const white = Math.random() * 2 - 1
      if (i < r * 0.05) d[i] += white * decay(i, r, 0.015) * 1.3
      if (i > r * 0.08 && i < r * 0.7) d[i] += white * 0.6
      last = (last + 0.04 * white) / 1.04
      if (i >= r * 0.6) d[i] += last * 2.5 * decay(i - r * 0.6, r, 0.5)
    }
  })
  // Master caution: the double beep.
  shots.caution = await render(0.55, (d, r) => {
    const beep = (at: number) => {
      const base = Math.floor(at * r)
      for (let i = 0; i < r * 0.18 && base + i < d.length; i++)
        d[base + i] += Math.sin((i / r) * 2 * Math.PI * 1000) * Math.min(1, i / (r * 0.01)) * decay(i, r, 0.12) * 0.35
    }
    beep(0)
    beep(0.28)
  })
  // Gear warning horn: a slow insistent low beep (looped while active).
  shots.horn = await render(1.0, (d, r) => {
    for (let i = 0; i < r * 0.55; i++) d[i] = Math.sin((i / r) * 2 * Math.PI * 250) * Math.min(1, i / (r * 0.01), (r * 0.55 - i) / (r * 0.02)) * 0.3
  })
}

// play a named one-shot at a volume, optionally lowpassed (distance dulling).
function play(name: string, volume: number, lowpass?: number, delay?: number): void {
  if (!context || !master || !shots[name] || context.state !== 'running') return
  const source = context.createBufferSource()
  source.buffer = shots[name]
  const gain = context.createGain()
  gain.gain.value = volume
  const out = SHOT_BUS[name] ? bus(SHOT_BUS[name]) : (master as GainNode)
  if (lowpass) {
    const filter = context.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = lowpass
    source.connect(filter).connect(gain).connect(out)
  } else source.connect(gain).connect(out)
  source.start(now() + (delay || 0))
}

// ---------------------------------------------------------------- exports

// audio_frame drives the continuous voices from the flight state.
export function audio_frame(state: {
  spool: number // achieved engine fraction 0..1
  stage: number // reheat fraction 0..1
  speed: number // airspeed m/s
  alpha: number // deg
  wow: boolean
  burn: number // max fire intensity 0..1
  harm: [number, number] // per-engine thrust loss (dying engines fade and detune)
}): void {
  if (!context || context.state !== 'running') return
  const t = now()
  for (let e = 0; e < 2; e++) {
    const engine = engines[e]
    const health = 1 - (state.harm[e] || 0)
    const level = state.spool * (0.25 + 0.75 * health)
    engine.rumble.frequency.setTargetAtTime(120 + 420 * level, t, smooth)
    engine.hiss.frequency.setTargetAtTime(350 + 2500 * level, t, smooth)
    engine.hissGain.gain.setTargetAtTime(0.08 + 0.5 * level * level, t, smooth)
    engine.whine.frequency.setTargetAtTime(2200 + 5200 * level, t, smooth)
    engine.second.frequency.setTargetAtTime((2200 + 5200 * level) * 1.26, t, smooth)   // the other spool, geared apart
    engine.whineGain.gain.setTargetAtTime((0.018 + 0.055 * level) * (e ? 0.92 : 1), t, smooth)   // the whine EMERGES with power — the audible spool-up pitch; per-side offset keeps the pair shimmering
    engine.gain.gain.setTargetAtTime(0.06 + 0.3 * level * level, t, smooth)
  }
  burner?.gain.gain.setTargetAtTime(0.5 * state.stage, t, smooth)
  if (wind) {
    const v = Math.min(1, state.speed / 320)
    wind.filter.frequency.setTargetAtTime(200 + 2600 * v, t, smooth)
    wind.gain.gain.setTargetAtTime(0.28 * v * v, t, smooth)
  }
  buffet?.gain.gain.setTargetAtTime(Math.max(0, Math.min(1, (state.alpha - 14) / 12)) * 0.9, t, smooth)
  fire?.gain.gain.setTargetAtTime(0.7 * state.burn, t, smooth)
  deck?.gain.gain.setTargetAtTime(state.wow ? 0.12 : 0, t, 0.4)
}

// The gun loops while held: restartable half-second burr segments.
export function audio_gun(firing: boolean): void {
  if (!context || context.state !== 'running') return
  if (firing && !gunLoop && shots.gun) {
    gunLoop = context.createBufferSource()
    gunLoop.buffer = shots.gun
    gunLoop.loop = true
    const gain = context.createGain()
    gain.gain.value = 0.6
    gunLoop.connect(gain).connect(bus('weapons'))
    gunLoop.start()
  } else if (!firing && gunLoop) {
    gunLoop.stop()
    gunLoop = null
  }
}

export function audio_hit(count: number): void {
  play('hit', Math.min(0.8, 0.3 + count * 0.1))
}

// Explosions dull and quieten with range, and arrive late — sound is slow.
export function audio_explosion(distance: number): void {
  const range = Math.max(0, Math.min(1, 1 - distance / 4000))
  if (range <= 0) return
  play('explosion', 0.25 + 0.75 * range * range, 400 + 5600 * range * range, distance / 343)
}

export function audio_launch(): void {
  play('launch', 0.7)
}
export function audio_flare(): void {
  play('flare', 0.35)
}
export function audio_catapult(): void {
  play('catapult', 0.9)
}
export function audio_trap(): void {
  play('trap', 0.85)
}
export function audio_touchdown(): void {
  play('touchdown', 0.7)
}
export function audio_servo(): void {
  play('servo', 0.5)
}
export function audio_eject(): void {
  play('eject', 1.0)
}
export function audio_caution(): void {
  play('caution', 0.8)
}

// The gear horn repeats while the condition holds.
let hornAt = 0
export function audio_horn(active: boolean): void {
  if (!active || !context || context.state !== 'running') return
  if (now() - hornAt > 1.1) {
    hornAt = now()
    play('horn', 0.6)
  }
}

// ---------------------------------------------------------------- remotes
// Positional engine hum per remote aircraft with a cheap Doppler factor —
// three.js positional audio does distance, we bend the pitch.

interface Distant {
  gain: GainNode
  panner: PannerNode
  filter: BiquadFilterNode
}
const distants = new Map<string, Distant>()

export function audio_remote(key: string, x: number, y: number, z: number, closure: number, reheat: boolean): void {
  if (!context || !master || context.state !== 'running') return
  let d = distants.get(key)
  if (!d) {
    const panner = context.createPanner()
    panner.panningModel = 'equalpower'
    panner.distanceModel = 'inverse'
    panner.refDistance = 60
    panner.maxDistance = 8000
    const gain = context.createGain()
    gain.gain.value = 0.5
    const roar = looper(brownBuffer as AudioBuffer)
    const filter = context.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 600
    const mix = context.createGain()
    mix.gain.value = 0.5
    roar.connect(filter).connect(mix)
    mix.connect(panner).connect(gain).connect(bus('environment'))
    d = { gain, panner, filter }
    distants.set(key, d)
  }
  const t = now()
  d.panner.positionX.setTargetAtTime(x, t, smooth)
  d.panner.positionY.setTargetAtTime(y, t, smooth)
  d.panner.positionZ.setTargetAtTime(z, t, smooth)
  const doppler = Math.max(0.7, Math.min(1.3, 1 + closure / 343))
  d.filter.frequency.setTargetAtTime((reheat ? 900 : 600) * doppler, t, smooth)   // Doppler bends the roar's colour — noise has no pitch to bend
  d.gain.gain.setTargetAtTime(reheat ? 0.75 : 0.5, t, smooth)
}

export function audio_remote_drop(key: string): void {
  const d = distants.get(key)
  if (!d) return
  d.gain.gain.value = 0
  d.panner.disconnect()
  distants.delete(key)
}

// The listener rides the camera.
export function audio_listener(x: number, y: number, z: number, fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void {
  if (!context || context.state !== 'running') return
  const l = context.listener
  const t = now()
  if (l.positionX) {
    l.positionX.setTargetAtTime(x, t, smooth)
    l.positionY.setTargetAtTime(y, t, smooth)
    l.positionZ.setTargetAtTime(z, t, smooth)
    l.forwardX.setTargetAtTime(fx, t, smooth)
    l.forwardY.setTargetAtTime(fy, t, smooth)
    l.forwardZ.setTargetAtTime(fz, t, smooth)
    l.upX.setTargetAtTime(ux, t, smooth)
    l.upY.setTargetAtTime(uy, t, smooth)
    l.upZ.setTargetAtTime(uz, t, smooth)
  }
}
