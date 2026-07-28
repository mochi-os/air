// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// Flight recorder (#212): a rolling buffer of the last few minutes, written
// out as TacView ACMI 2.2 text. Dependency-free so it unit-tests in isolation.
//
// The world is flat with a wrap; TacView wants geographic coordinates, so the
// map carries a reference point and metres convert to degrees about it. At
// Midway's latitude the error from treating a degree of longitude as constant
// is far below anything a debrief cares about.

export const MIDWAY = { latitude: 28.2072, longitude: -177.3735 } // Midway Atoll, the v1 map's real position
const METRES_PER_DEGREE = 111320

export interface Sample {
  time: number // seconds since the recording started
  objects: Recorded[]
}

export interface Recorded {
  id: number // stable per object for the whole recording
  x: number // world metres: +x east, +z south (the engine's frame)
  y: number // altitude, metres
  z: number
  roll: number // degrees
  pitch: number
  yaw: number // true heading, degrees
  name: string // airframe, e.g. FA-18C
  label: string // pilot or bandit name
  colour: 'Blue' | 'Red' | 'Orange'
  kind: string // TacView type tag, e.g. Air+FixedWing
  mode?: string // bot doctrine state — developer builds only
  data?: Flight // per-sample flight data: TacView graphs these natively
}

// Flight is the standard ACMI telemetry set. TacView knows these property
// names and plots them, which is what makes a recording a handling-analysis
// tool and not just a 3D replay (#216).
export interface Flight {
  aoa?: number // degrees
  g?: number // load factor
  tas?: number // true airspeed, m/s
  ias?: number // indicated/calibrated airspeed, m/s
  mach?: number
  stick?: number // control-law channels: developer builds only
  stabilator?: number // degrees
}

// position converts the flat world's metres to the degrees ACMI carries.
export function position(x: number, z: number): { longitude: number; latitude: number } {
  const latitude = MIDWAY.latitude - z / METRES_PER_DEGREE // +z is south
  const longitude =
    MIDWAY.longitude + x / (METRES_PER_DEGREE * Math.cos((MIDWAY.latitude * Math.PI) / 180))
  return { longitude, latitude }
}

const round = (v: number, places: number) => {
  const f = Math.pow(10, places)
  return Math.round(v * f) / f
}

// acmi renders samples as an ACMI 2.2 flight recording. `started` stamps the
// reference time; TacView shows wall-clock from it.
export function acmi(samples: Sample[], started: Date, title: string): string {
  const out: string[] = [
    'FileType=text/acmi/tacview',
    'FileVersion=2.2',
    `0,ReferenceTime=${started.toISOString().replace(/\.\d+Z$/, 'Z')}`,
    '0,DataSource=Mochi Air',
    `0,Title=${title.replace(/[,\n]/g, ' ')}`,
    '0,Category=Flight',
  ]
  // Declared properties are written once per object and repeated only when
  // they change — ACMI is a delta format, and repeating them every frame
  // multiplies the file size for no information.
  const declared = new Map<number, string>()
  for (const sample of samples) {
    out.push(`#${round(sample.time, 2)}`)
    for (const o of sample.objects) {
      const { longitude, latitude } = position(o.x, o.z)
      const transform = [
        round(longitude, 7),
        round(latitude, 7),
        round(o.y, 1),
        round(o.roll, 1),
        round(o.pitch, 1),
        round(o.yaw, 1),
      ].join('|')
      let line = `${o.id.toString(16)},T=${transform}`
      // Flight data rides on the same line. These change every sample, so they
      // are never delta-suppressed the way the identity properties are.
      const d = o.data
      if (d) {
        if (d.aoa !== undefined) line += `,AOA=${round(d.aoa, 2)}`
        if (d.g !== undefined) line += `,G=${round(d.g, 2)}`
        if (d.tas !== undefined) line += `,TAS=${round(d.tas, 1)}`
        if (d.ias !== undefined) line += `,IAS=${round(d.ias, 1)}`
        if (d.mach !== undefined) line += `,Mach=${round(d.mach, 3)}`
        if (d.stick !== undefined) line += `,Stick=${round(d.stick, 3)}`
        if (d.stabilator !== undefined) line += `,Stabilator=${round(d.stabilator, 2)}`
      }
      const properties = `${o.name}|${o.label}|${o.colour}|${o.kind}|${o.mode ?? ''}`
      if (declared.get(o.id) !== properties) {
        declared.set(o.id, properties)
        line += `,Name=${o.name},Pilot=${o.label},Color=${o.colour},Type=${o.kind}`
        if (o.mode) line += `,Doctrine=${o.mode}` // developer builds only: the bot's chosen manoeuvre
      }
      out.push(line)
    }
  }
  return out.join('\n') + '\n'
}

// Recorder is the rolling buffer. Samples are dropped from the front once the
// window is full, so memory is bounded however long the sortie runs.
export class Recorder {
  private samples: Sample[] = []
  private last = -1
  constructor(
    private window = 0, // seconds kept; 0 = the WHOLE flight (a debrief wants the takeoff, not the last few minutes)
    private rate = 10 // samples per second
  ) {}

  clear() {
    this.samples = []
    this.last = -1
  }

  // add samples at the configured rate and drops anything older than the
  // window. `time` is seconds since the mission started.
  add(time: number, objects: Recorded[]) {
    if (this.last >= 0 && time - this.last < 1 / this.rate) return
    this.last = time
    this.samples.push({ time, objects })
    if (!this.window) return // whole-flight recording: ~35 KB per minute of a two-ship, so an hour still fits comfortably in memory
    const cut = time - this.window
    let drop = 0
    while (drop < this.samples.length && this.samples[drop].time < cut) drop++
    if (drop) this.samples.splice(0, drop)
  }

  get length() {
    return this.samples.length
  }

  // render writes the buffer out, re-basing time so the file starts at zero.
  render(started: Date, title: string): string {
    if (!this.samples.length) return ''
    const base = this.samples[0].time
    return acmi(
      this.samples.map((s) => ({ time: s.time - base, objects: s.objects })),
      started,
      title
    )
  }
}
