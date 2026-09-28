// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
// Replay: a stored flight recording (the ACMI text the recorder writes,
// acmi.ts) read back into one track per object, and the scene at any moment of
// it - every jet and missile where the recording had it, interpolated between
// the samples. The engine draws what this returns; nothing here flies.
// Dependency-free so it unit-tests without WebGL.
import { metres } from './acmi'

export interface Frame {
  time: number // s from the start of the recording
  x: number // world metres, the engine's frame
  y: number
  z: number
  roll: number // degrees, the recorder's own conventions
  pitch: number
  yaw: number
  properties: Record<string, string> // everything the object carries at this sample, the delta-suppressed ones carried forward
}

export interface Track {
  id: number
  samples: number[] // the recording's sample indices this object appears in, ascending
  frames: Frame[] // one per entry in samples
  rates?: number[][] // each frame's velocity, m/s, fitted when first drawn (rate)
  rated?: number // the world wrap the rates were fitted for
}

export interface Playback {
  information: Record<string, string> // the header's global properties: Title, ReferenceTime, Match_*
  times: number[] // every sample's time, s from the start
  tracks: Map<number, Track>
  own: number // the recorded id of the pilot's own jet, -1 when there is none
  duration: number // s
}

export interface Pose {
  id: number
  x: number
  y: number
  z: number
  roll: number
  pitch: number
  yaw: number
  vx: number // m/s, from the samples either side
  vy: number
  vz: number
  properties: Record<string, string>
  final: boolean // the object's last sample: it is gone after this one
}

// EVENTS are the channels that happen rather than hold: written on the sample
// they happened on and never carried forward, so a replay raises each once.
const EVENTS = ['Radio', 'Notice']
// LISTS hold several texts joined by semicolons (acmi.ts list), kept escaped
// so items can split them.
const LISTS = ['Coach', 'Radio', 'Notice']

// split cuts a line at the separators a backslash does not escape.
function split(line: string, separator: string): string[] {
  const parts: string[] = []
  let part = ''
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '\\' && i + 1 < line.length) {
      part += c + line[i + 1]
      i++
    } else if (c === separator) {
      parts.push(part)
      part = ''
    } else part += c
  }
  parts.push(part)
  return parts
}

// unescape undoes acmi.ts text.
function unescape(value: string): string {
  return value.replace(/\\(.)/g, '$1')
}

// items reads a list channel (Coach, Radio, Notice) back into its texts.
export function items(value: string | undefined): string[] {
  if (!value) return []
  return split(value, ';').map(unescape)
}

// parse reads a recording. It never throws: a line it cannot read is skipped,
// and text with no samples at all is an empty playback of no duration.
export function parse(text: string): Playback {
  const information: Record<string, string> = {}
  const times: number[] = []
  const tracks = new Map<number, Track>()
  const latest = new Map<number, Frame>() // each object's newest frame, whose properties carry forward
  const degrees = new Map<number, [number, number]>() // each object's last longitude and latitude
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (!line) continue
    if (line.startsWith('#')) {
      const time = parseFloat(line.slice(1))
      if (Number.isFinite(time)) times.push(time)
      continue
    }
    if (line.startsWith('0,')) {
      // Global properties: the header's, and any written between samples.
      const at = line.indexOf('=')
      if (at > 2 && !times.length)
        information[line.slice(2, at)] = line.slice(at + 1)
      continue
    }
    // A removal line says the object is gone; the recorder writes every live
    // object at every sample, so its absence from the next one says the same.
    if (!times.length || line.startsWith('-')) continue
    const comma = line.indexOf(',')
    if (comma < 1) continue
    const id = parseInt(line.slice(0, comma), 16)
    if (!Number.isFinite(id)) continue
    const previous = latest.get(id)
    const frame: Frame = {
      time: times[times.length - 1],
      x: previous?.x ?? 0,
      y: previous?.y ?? 0,
      z: previous?.z ?? 0,
      roll: previous?.roll ?? 0,
      pitch: previous?.pitch ?? 0,
      yaw: previous?.yaw ?? 0,
      properties: { ...(previous?.properties ?? {}) },
    }
    for (const event of EVENTS) delete frame.properties[event]
    for (const part of split(line.slice(comma + 1), ',')) {
      const at = part.indexOf('=')
      if (at < 1) continue
      const key = part.slice(0, at)
      const value = part.slice(at + 1)
      if (key !== 'T') {
        frame.properties[key] = LISTS.includes(key) ? value : unescape(value)
        continue
      }
      // T=longitude|latitude|altitude|roll|pitch|yaw; an empty field is
      // unchanged since the object's last sample.
      const fields = value.split('|')
      const number = (i: number) => {
        const v = fields[i]
        if (v === undefined || v === '') return null
        const n = parseFloat(v)
        return Number.isFinite(n) ? n : null
      }
      const last = degrees.get(id)
      const longitude = number(0) ?? last?.[0]
      const latitude = number(1) ?? last?.[1]
      if (longitude !== undefined && latitude !== undefined) {
        degrees.set(id, [longitude, latitude])
        const at = metres(longitude, latitude)
        frame.x = at.x
        frame.z = at.z
      }
      frame.y = number(2) ?? frame.y
      if (fields.length >= 6) {
        frame.roll = number(3) ?? frame.roll
        frame.pitch = number(4) ?? frame.pitch
        frame.yaw = number(5) ?? frame.yaw
      }
    }
    let track = tracks.get(id)
    if (!track) {
      track = { id, samples: [], frames: [] }
      tracks.set(id, track)
    }
    const sample = times.length - 1
    if (track.samples[track.samples.length - 1] === sample)
      track.frames[track.frames.length - 1] = frame
    else {
      track.samples.push(sample)
      track.frames.push(frame)
    }
    latest.set(id, frame)
  }
  // The pilot's own jet is recorded as 1; a recording without it follows the
  // first aircraft there is.
  let own = tracks.has(1) ? 1 : -1
  if (own < 0) {
    for (const track of tracks.values()) {
      if ((track.frames[0].properties.Type ?? '').includes('Air')) {
        own = track.id
        break
      }
    }
  }
  return {
    information,
    times,
    tracks,
    own,
    duration: times.length ? times[times.length - 1] : 0,
  }
}

// turn folds an angle difference into -180..180, so a heading through north
// interpolates the short way round.
function turn(degrees: number): number {
  return ((((degrees + 180) % 360) + 360) % 360) - 180
}

// across is the shortest step between two coordinates on a wrapped axis.
function across(delta: number, wrap: number): number {
  return wrap > 0 ? delta - wrap * Math.round(delta / wrap) : delta
}

// search finds value in an ascending array, -1 when it is not there.
function search(values: number[], value: number): number {
  let low = 0
  let high = values.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    if (values[middle] === value) return middle
    if (values[middle] < value) low = middle + 1
    else high = middle - 1
  }
  return -1
}

// sample is the index of the last sample at or before time.
function sample(times: number[], time: number): number {
  let low = 0
  let high = times.length - 1
  if (high < 0) return -1
  if (time <= times[0]) return 0
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (times[middle] <= time) low = middle
    else high = middle - 1
  }
  return low
}

// REACH is how many samples either side of one its velocity is fitted over:
// seven samples, 0.6 s, average the writer's rounding out, and the fit is
// centred, so it lags nothing.
const REACH = 3

// rate fits every frame's velocity: the least-squares slope of the track's
// positions over the samples within REACH either side that it appears in
// without a break, so a jet that vanished and came back is never fitted
// across the gap. Fitted once per track, on first use.
function rate(track: Track, wrap: number): number[][] {
  if (track.rates && track.rated === wrap) return track.rates
  const rates: number[][] = []
  for (let i = 0; i < track.frames.length; i++) {
    let low = i
    let high = i
    while (
      low > i - REACH &&
      low > 0 &&
      track.samples[low - 1] === track.samples[low] - 1
    )
      low--
    while (
      high < i + REACH &&
      high < track.frames.length - 1 &&
      track.samples[high + 1] === track.samples[high] + 1
    )
      high++
    const centre = track.frames[i]
    if (high === low) {
      rates.push([0, 0, 0])
      continue
    }
    let mean = 0
    for (let j = low; j <= high; j++) mean += track.frames[j].time
    mean /= high - low + 1
    let spread = 0
    const slope = [0, 0, 0]
    for (let j = low; j <= high; j++) {
      const frame = track.frames[j]
      const dt = frame.time - mean
      spread += dt * dt
      slope[0] += dt * across(frame.x - centre.x, wrap)
      slope[1] += dt * (frame.y - centre.y)
      slope[2] += dt * across(frame.z - centre.z, wrap)
    }
    rates.push(spread > 0 ? slope.map((v) => v / spread) : [0, 0, 0])
  }
  track.rates = rates
  track.rated = wrap
  return rates
}

// CONTINUOUS are the channels a replay reads as quantities, blended between
// samples so the HUD's numbers and the engines move rather than step ten
// times a second.
const CONTINUOUS = [
  'AOA',
  'Beta',
  'YawRate',
  'G',
  'TAS',
  'IAS',
  'Mach',
  'FuelWeight',
  'Throttle',
  'Afterburner',
  'Gear',
  'Hook',
  'Stress',
  'Spool',
  'Thrust',
  'SpeedBrake',
  'Stick',
  'Lateral',
  'Pedal',
  'Surfaces',
]

// blend is a frame's properties with its continuous channels carried the
// fraction f of the way to the next frame's. A channel holding several
// numbers (Surfaces) is carried number by number.
function blend(
  a: Record<string, string>,
  b: Record<string, string>,
  f: number
): Record<string, string> {
  let out: Record<string, string> | null = null
  for (const key of CONTINUOUS) {
    const from = a[key]
    const to = b[key]
    if (from === undefined || to === undefined || from === to) continue
    const x = from.split('|').map(Number)
    const y = to.split('|').map(Number)
    if (x.length !== y.length || ![...x, ...y].every(Number.isFinite)) continue
    out ??= { ...a }
    out[key] = x.map((v, i) => v + (y[i] - v) * f).join('|')
  }
  return out ?? a
}

// scene is every object present at time, each interpolated toward its next
// sample. An object is present from its first sample to its last, and between
// two samples when it appears in the earlier one. wrap is the world's size
// when it wraps (0 when it does not), so a jet crossing the seam is drawn
// crossing it rather than sweeping back across the map.
export function scene(p: Playback, time: number, wrap = 0): Pose[] {
  const k = sample(p.times, time)
  if (k < 0) return []
  const poses: Pose[] = []
  for (const track of p.tracks.values()) {
    const i = search(track.samples, k)
    if (i < 0) continue
    const a = track.frames[i]
    const next = track.samples[i + 1] === k + 1 ? track.frames[i + 1] : null
    const span = next ? next.time - a.time : 0
    const f =
      next && span > 0 ? Math.min(1, Math.max(0, (time - a.time) / span)) : 0
    const dx = next ? across(next.x - a.x, wrap) : 0
    const dy = next ? next.y - a.y : 0
    const dz = next ? across(next.z - a.z, wrap) : 0
    // The velocity is each sample's fitted rate, blended across the interval,
    // not the step between two samples: that difference carried the writer's
    // rounding (altitude to a decimetre, 0.1 s apart, is a metre a second of
    // vertical speed) and changed at every sample, and the flight path marker
    // and the vertical speed drawn from it jumped by degrees and thousands of
    // feet a minute in a frame.
    const rates = rate(track, wrap)
    const va = rates[i]
    const vb = next ? rates[i + 1] : va
    const properties = next
      ? blend(a.properties, next.properties, f)
      : a.properties
    poses.push({
      id: track.id,
      x: a.x + dx * f,
      y: a.y + dy * f,
      z: a.z + dz * f,
      roll: next ? a.roll + turn(next.roll - a.roll) * f : a.roll,
      pitch: next ? a.pitch + (next.pitch - a.pitch) * f : a.pitch,
      yaw: next ? (a.yaw + turn(next.yaw - a.yaw) * f + 360) % 360 : a.yaw,
      vx: va[0] + (vb[0] - va[0]) * f,
      vy: va[1] + (vb[1] - va[1]) * f,
      vz: va[2] + (vb[2] - va[2]) * f,
      properties,
      final: !next && i === track.frames.length - 1,
    })
  }
  return poses
}

// number reads a numeric property, or the fallback when it is absent or empty.
export function number(
  properties: Record<string, string>,
  key: string,
  fallback: number
): number {
  const raw = properties[key]
  if (raw === undefined || raw === '') return fallback
  const value = parseFloat(raw)
  return Number.isFinite(value) ? value : fallback
}
