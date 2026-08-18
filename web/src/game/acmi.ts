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
  skill?: string // a bot's tier (novice / pilot / ace / superhuman) — shipped: the context that decides whether a play was reasonable
  data?: Flight // per-sample flight data: TacView graphs these natively
  round?: Round // a missile in flight (#33 debrief): its guidance state and, on its last sample, its fate
}

// Round is a missile's per-sample state. Missiles are recorded as their own
// ACMI objects (Weapon+Missile — TacView flies them natively), so a debrief
// sees the whole flight: who fired, at whom, whether the seeker ever held,
// how close it came, and how it ended. Before this a fight won with six 9Ms
// recorded nothing but two structural wounds on the bandit, and the debrief
// called them self-inflicted (2026-08-15).
export interface Round {
  shooter: number // recorded id of the launcher
  target?: number // recorded id of the target it was fired at, if any
  seeker: string // guidance state: track / loose (lock broken, ballistic) / lure (seduced by a flare) / midcourse / active / pitbull
  least?: number // closest approach to the target so far, metres
  fate?: string // written once, on the last sample: fuse / energy / life / ocean / lost / battery
  killed?: boolean // the fuse's verdict, when it fused
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
  fuel?: number // kilograms remaining — ACMI's standard FuelWeight, which TacView plots like any other channel
  rounds?: number // gun rounds remaining
  // The battle channels (#238): the wasm battle module computes all of these
  // every frame, drives the HUD and effects with them, and used to discard
  // them - two debriefs in a row were materially wrong for it (a walked burst
  // that riddled the player read as "missed with everything" at 9 Hz, and a
  // jet ridden down crippled read as controlled flight into the sea). Struck
  // is CUMULATIVE rounds taken, so sampling loses nothing: the total is the
  // total, and its steps are the hits.
  struck?: number // cumulative rounds taken
  burning?: boolean // an engine or fuel fire is alight
  thrust?: number // thrust fraction lost, 0..1
  wing?: number // structural element loss, summed
  leak?: number // fuel loss, kg/s
  fate?: string // how this life ended: pilot / fire / sea / midair / building / post / island / verdict / probe
  stick?: number // control-law channels: developer builds only
  stabilator?: number // degrees
  // The weapons channels (#33 debrief). Missiles is the stores count, so a
  // launch is a step exactly like a gun burst is a Rounds step. Cue is what
  // the HUD was telling the pilot: gun / heater / radar SHOOT states, or the
  // breakaway X, empty when nothing was commanded — a debrief that cannot
  // see the cue cannot judge whether a shot was taken on one, refused on
  // one, or fired without one.
  missiles?: number // heaters + radar rounds remaining
  cue?: string // '' | 'gun' | '9m' | 'steady' | 'flash' | 'break'
  // Countermeasures: the ownship's flare INVENTORY (a dispense is a step);
  // the bandit's dispenser is bottomless, so it records a cumulative dispense
  // COUNT instead — same shape, same information (its steps are the dispenses).
  flares?: number
  // Energy management, TacView-native: throttle 0..1 to MIL and the burner
  // fraction beyond it — the channel that turns "you flew too fast" from an
  // inference off alpha into a recorded fact.
  throttle?: number
  burner?: number
  // The sensor picture: radar mode (rws / tws / stt / sil), the L&S target's
  // recorded id, whether the RWR held a hard-lock warning and a MISSILE call,
  // the jammer's standing state, and the pilot's designated/boxed target —
  // "no shot" and "shooting at the wrong thing" are different findings.
  radar?: string
  lock?: number // recorded id of the STT / L&S target, if any
  rwrlock?: boolean
  rwrmissile?: boolean
  jammer?: boolean
  target?: number // recorded id of the boxed target the HUD was flying against, if any
  // The bandit's own control state, so its plays can be judged from its inputs
  // rather than inferred from position at 9 Hz.
  spool?: number // engine spool 0..1 (a Mochi extension; TacView will not plot it)
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
// Match describes the fight's rules in the header, so a debrief knows what it
// is judging without asking: the mode and duel, the weapons class, the bot
// tier, and any cheats that were live (an invulnerable ownship changes what
// "survived" means). Values are free text; ACMI global properties are.
export interface Match {
  [key: string]: string | number | boolean | undefined
}

export function acmi(samples: Sample[], started: Date, title: string, match?: Match): string {
  const out: string[] = [
    'FileType=text/acmi/tacview',
    'FileVersion=2.2',
    `0,ReferenceTime=${started.toISOString().replace(/\.\d+Z$/, 'Z')}`,
    '0,DataSource=Mochi Air',
    `0,Title=${title.replace(/[,\n]/g, ' ')}`,
    '0,Category=Flight',
  ]
  if (match) {
    for (const [key, value] of Object.entries(match)) {
      if (value === undefined || value === '') continue
      // Match_ prefix keeps these clear of ACMI's reserved global names.
      out.push(`0,Match_${key}=${String(value).replace(/[,\n]/g, ' ')}`)
    }
  }
  // Declared properties are written once per object and repeated only when
  // they change — ACMI is a delta format, and repeating them every frame
  // multiplies the file size for no information.
  const declared = new Map<number, string>()
  const counted = new Map<number, number>() // last written round count, per object
  const battled = new Map<number, string>() // last written battle channels, per object
  const armed = new Map<number, number>() // last written missiles count, per object
  const cued = new Map<number, string>() // last written cue, per object
  const countered = new Map<number, number>() // last written flares, per object
  const sensed_last = new Map<number, string>() // last written sensor group, per object
  const guided = new Map<number, string>() // last written seeker channels, per missile object
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
        if (d.fuel !== undefined) line += `,FuelWeight=${round(d.fuel, 1)}`
        // Rounds are delta-suppressed, unlike the rest: they hold still for
        // whole minutes and then step during a burst, so writing them every
        // sample would be pure padding. Written on change, which is also
        // exactly where a debrief looks - the samples that moved are the shots.
        if (d.rounds !== undefined && counted.get(o.id) !== d.rounds) {
          counted.set(o.id, d.rounds)
          line += `,Rounds=${Math.round(d.rounds)}`
        }
        // The battle channels are delta-suppressed together: they hold for
        // minutes and step at hits, which is exactly where a debrief looks.
        {
          let battle = ''
          if (d.struck !== undefined) battle += `,Struck=${Math.round(d.struck)}`
          if (d.burning !== undefined) battle += `,Burning=${d.burning ? 1 : 0}`
          if (d.thrust !== undefined) battle += `,Thrust=${round(d.thrust, 2)}`
          if (d.wing !== undefined) battle += `,Wing=${round(d.wing, 2)}`
          if (d.leak !== undefined) battle += `,Leak=${round(d.leak, 2)}`
          if (d.fate !== undefined) battle += `,Fate=${d.fate}`
          if (battle && battled.get(o.id) !== battle) {
            battled.set(o.id, battle)
            line += battle
          }
        }
        if (d.stick !== undefined) line += `,Stick=${round(d.stick, 3)}`
        if (d.stabilator !== undefined) line += `,Stabilator=${round(d.stabilator, 2)}`
        // Missiles and the cue are delta-suppressed like the rounds: the count
        // steps at a launch, the cue at the moments the HUD's advice changed.
        if (d.missiles !== undefined && armed.get(o.id) !== d.missiles) {
          armed.set(o.id, d.missiles)
          line += `,Missiles=${Math.round(d.missiles)}`
        }
        if (d.cue !== undefined && cued.get(o.id) !== d.cue) {
          cued.set(o.id, d.cue)
          line += `,Cue=${d.cue}`
        }
        if (d.flares !== undefined && countered.get(o.id) !== d.flares) {
          countered.set(o.id, d.flares)
          line += `,Flares=${Math.round(d.flares)}`
        }
        // Throttle and burner change constantly under a pilot's hand: written
        // every sample, like the flight data.
        if (d.throttle !== undefined) line += `,Throttle=${round(d.throttle, 2)}`
        if (d.burner !== undefined) line += `,Afterburner=${round(d.burner, 2)}`
        if (d.spool !== undefined) line += `,Spool=${round(d.spool, 2)}`
        // The sensor picture is delta-suppressed as one group: it holds for
        // seconds and steps at exactly the moments a debrief cares about.
        {
          let sensed = ''
          if (d.radar !== undefined) sensed += `,Radar=${d.radar}`
          if (d.lock !== undefined) sensed += `,Lock=${d.lock.toString(16)}`
          if (d.rwrlock !== undefined) sensed += `,RwrLock=${d.rwrlock ? 1 : 0}`
          if (d.rwrmissile !== undefined) sensed += `,RwrMissile=${d.rwrmissile ? 1 : 0}`
          if (d.jammer !== undefined) sensed += `,Jammer=${d.jammer ? 1 : 0}`
          if (d.target !== undefined) sensed += `,Target=${d.target.toString(16)}`
          if (sensed && sensed_last.get(o.id) !== sensed) {
            sensed_last.set(o.id, sensed)
            line += sensed
          }
        }
      }
      // A missile's guidance rides on its own object. Shooter and target are
      // identity (written once); the seeker state and closest approach are
      // delta-suppressed; the fate is written on the last sample only, and
      // TacView's Weapon type gives the debrief a track it can fly forward.
      const r = o.round
      if (r) {
        let guide = `,Seeker=${r.seeker}`
        if (r.least !== undefined) guide += `,Least=${round(r.least, 1)}`
        if (r.fate !== undefined) guide += `,Fate=${r.fate},Killed=${r.killed ? 1 : 0}`
        if (guided.get(o.id) !== guide) {
          guided.set(o.id, guide)
          line += guide
        }
      }
      const properties = `${o.name}|${o.label}|${o.colour}|${o.kind}|${o.mode ?? ''}|${o.skill ?? ''}|${r ? `${r.shooter}>${r.target ?? ''}` : ''}`
      if (declared.get(o.id) !== properties) {
        declared.set(o.id, properties)
        line += `,Name=${o.name},Pilot=${o.label},Color=${o.colour},Type=${o.kind}`
        if (o.skill) line += `,Skill=${o.skill}` // the bot's tier, on the object itself: the mission title named it only for jousts, and only in the header
        if (o.mode) line += `,Doctrine=${o.mode}` // developer builds only: the bot's chosen manoeuvre
        if (r) {
          // ACMI's own parent/target linkage, in the object ids the file uses.
          line += `,Parent=${r.shooter.toString(16)}`
          if (r.target !== undefined) line += `,LockedTarget=${r.target.toString(16)}`
        }
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
  render(started: Date, title: string, match?: Match): string {
    if (!this.samples.length) return ''
    const base = this.samples[0].time
    return acmi(
      this.samples.map((s) => ({ time: s.time - base, objects: s.objects })),
      started,
      title,
      match
    )
  }
}
