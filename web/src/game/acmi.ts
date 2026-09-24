// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// Flight recorder (#212): a rolling buffer of the last few minutes written out
// as TacView ACMI 2.2 text; dependency-free so it unit-tests in isolation. The
// world is flat with a wrap, so the map carries a reference point and metres
// convert to degrees about it (a constant degree of longitude is fine at
// Midway's latitude).

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
// ACMI objects (Weapon+Missile, which TacView flies natively), so a debrief
// sees who fired, at whom, whether the seeker held, how close it came, and how
// it ended.
interface Round {
  shooter: number // recorded id of the launcher
  target?: number // recorded id of the target it was fired at, if any
  seeker: string // guidance state: track / loose (lock broken, ballistic) / lure (seduced by a flare) / midcourse / active / pitbull
  least?: number // closest approach to the target so far, metres (per-frame sampled)
  // Why the lock broke, once it has: 'gimbal' (past the seeker's cone), 'rate'
  // (the sight line turned faster than it can track), 'flare' (seduced and not
  // recovered) or 'cold' (launched without acquisition). Seeker says THAT it is
  // loose; only this says whether the target beat it. With rate, the sight-line
  // rate the seeker measured on the breaking step, rad/s.
  reason?: string
  rate?: number
  // Whether the shooter's own radar still held this round's trackfile THIS
  // step (#33 debrief) - AMRAAM only, a heater has no midcourse phase to lose.
  // A shot that goes long with this false partway through lost its shooter's
  // guidance before it ever reached the target; one that stays true the whole
  // flight and still misses is a seeker/geometry failure instead - the same
  // distinction Reason draws for a heater's broken lock, drawn here for the
  // radar round's own midcourse support.
  support?: boolean
  burst?: number // the fuse's CONTINUOUS closest approach, metres — written with the fate (#58)
  closure?: number // relative speed at detonation, m/s
  when?: number // exact sim time of the fuse, s (the frame grid is ~9 Hz)
  off?: { ahead: number; above: number; right: number } // target -> burst in the target's body frame
  judged?: number // the miss as the damage core measured it, metres (#85) — disagreement with burst is a client/core position split
  fate?: string // written once, on the last sample: fuse / energy / life / ocean / lost / battery
  killed?: boolean // the fuse's verdict, when it fused
}

// Flight is the standard ACMI telemetry set. TacView knows these property
// names and plots them, which is what makes a recording a handling-analysis
// tool and not just a 3D replay (#216).
interface Flight {
  aoa?: number // degrees
  g?: number // load factor
  gear?: number // gear position, 0 down .. 1 up (#86)
  flaps?: number // flap SELECT: 0 auto, 1 half, 2 full (#86) — the FCS configuration, not the surface
  trim?: number // pitch trim (#86)
  lateral?: number // roll stick input, dev builds (#86)
  // The g-limit override paddle switch and its cost (#33 debrief): held, the
  // FCS commands to 10 g instead of the airframe's own 7.5 g ceiling, and the
  // exposure between those two - g·s beyond 7.5 g - accrues into `stress`
  // whether or not the pull ever nears 10 g. Structural failure (a shed wing)
  // is judged against 1.5x the UN-raised ceiling, weakened by accumulated
  // stress, so a pilot can shed a wing under override alone with no enemy
  // fire at all - the exact margin isn't recorded (it needs the battle
  // package's own wing-health state, which never reaches the client), but
  // override held plus a rising Stress trace is the same finding a real
  // structural-limits overstress would leave.
  override?: boolean
  stress?: number // accumulated overstress exposure, g·s beyond the airframe's un-raised limit
  // Yaw rate, degrees/second, real-world convention (positive = nose right)
  // (#33 debrief). NOT a departure flag - it is the raw rate the cockpit's
  // own departure/AoA tone is proxied from (engine.ts's departure_drive),
  // and the flight model's actual departure signature is sideslip, which
  // never reaches the client at all (investigated, not exposed by the wasm
  // core). Elevated, sustained yaw rate not explained by a rudder/yaw input
  // is the best signal available without a wire-format change; it will both
  // miss genuine low-speed ballistic departures with a weaker yaw signature
  // and fire on a deliberate hard yaw check that never departed anything.
  // Written every sample like AOA/G - a debrief reads its trace.
  yawrate?: number
  tas?: number // true airspeed, m/s
  ias?: number // indicated/calibrated airspeed, m/s
  mach?: number
  fuel?: number // kilograms remaining — ACMI's standard FuelWeight, which TacView plots like any other channel
  rounds?: number // gun rounds remaining
  // The battle channels (#238), from the wasm battle module. Struck is
  // CUMULATIVE rounds taken, so sampling loses nothing: its steps are the hits.
  struck?: number // cumulative rounds taken
  burning?: boolean // an engine or fuel fire is alight
  thrust?: number // thrust fraction lost, 0..1
  structure?: number // whole-airframe element loss, summed: what a hit counter reads
  wing?: number // wing loss the aero flies: what a performance claim rests on
  leak?: number // fuel loss, kg/s
  fate?: string // how this life ended: pilot / fire / sea / midair / building / post / island / verdict / probe / battle / surface
  // Who ended it, when anyone is credited: the debrief keeps the mechanism in
  // Fate and gains the attribution here, the way a missile carries Parent.
  killer?: string
  stick?: number // control-law channels: developer builds only
  stabilator?: number // degrees
  // The weapons channels (#33). Missiles is the stores count, so a launch is a
  // step like a gun burst. Cue is what the HUD was telling the pilot (gun /
  // heater / radar SHOOT states, the breakaway X, or empty).
  missiles?: number // heaters + radar rounds remaining
  cue?: string // '' | 'gun' | '9m' | 'steady' | 'flash' | 'break'
  // This burst's closest MISS: how far the nearest round passed from the
  // target's skin, and which way it went by, in the TARGET's body frame. The
  // gun's answer to a missile's least and off. Struck counts what connected,
  // so a burst that hits is fully described; without these a burst that misses
  // says nothing at all, and a debrief can only reconstruct it from the tracks
  // against the body ORIGIN, which on a 17 m airframe seen end-on is the wrong
  // body. Shipped, not developer-only: "why did I miss" sits with fuel and
  // rounds, not with the control-law channels.
  graze?: number // metres from the skin, 0 for a graze
  miss?: { ahead: number; above: number; right: number }
  // The bandit's decision journal (journal.ts), developer recordings only:
  // what the arbiter weighed at each re-plan, how far its forecasts landed from
  // the truth, the reflexes that pre-empted it, and the g it asked for at each
  // stage between the play and the stick. The first three are EVENTS - each
  // value opens with the brain's tick, so no two are alike and the delta
  // encoding below emits every one.
  decision?: string
  forecast?: string
  bypass?: string
  demand?: string
  // Countermeasures: the ownship's flare and chaff INVENTORIES (a dispense is
  // a step); the bandit records a cumulative flare dispense COUNT instead —
  // same shape, same information (its steps are the dispenses). Both carry a
  // 40/20 load since #43; before it the bandit's dispenser was bottomless.
  flares?: number
  chaff?: number
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
  // Acquire/undesignate presses that actually changed the lock state (#33
  // debrief): "sim time|acquire or undesignate|effect", effect one of ls / stt
  // / cone / lost (acquire) or step / break / clear (undesignate). Several
  // landing between two samples join with ';', like the bandit's own journal
  // below - the timestamp is what keeps two landings from ever reading alike,
  // so the delta encoding never mistakes a repeat for no change. A press with
  // no effect writes nothing: the Radar channel not moving already says so,
  // and this channel exists precisely to stop guessing whether a lock the
  // pilot expected ever actually formed.
  input?: string
  // Why the ownship's own hard lock (STT) dropped, when it did (#33 debrief):
  // "sim time|reason", reason one of lost (the target vanished from the
  // truth feed), gimbal (past the ±70° antenna limit), range (past the
  // tracker's hold multiple), jam (a jammer starved it past burn-through) or
  // notch (near-zero closing speed starved it - a beaming defence). This is
  // the automatic, physics-driven counterpart to Input above: a lock can
  // break with no press at all, so it rides its own channel rather than
  // borrowing that vocabulary. A SIL break writes nothing here - the Radar
  // channel already shows that one directly. Event-encoded like Input;
  // several breaks between two kept samples join with ';'.
  break?: string
  // When weapons went free, and why (#33 debrief): "sim time|reason", reason
  // 'merge' (an actual 3/9-line crossing opened a hold, single- or
  // multiplayer) or 'start' (a BVR joust that never held at all - weapons
  // free from spawn). Without this, a debrief could only infer the merge
  // from geometry against the first 3/9 crossing; this removes the need.
  // Event-encoded like Input and Break.
  merge?: string
  // The bandit's own control state, so its plays can be judged from its inputs
  // rather than inferred from position at 9 Hz.
  spool?: number // engine spool 0..1 (a Mochi extension; TacView will not plot it)
}

// position converts the flat world's metres to the degrees ACMI carries.
export function position(
  x: number,
  z: number
): { longitude: number; latitude: number } {
  const latitude = MIDWAY.latitude - z / METRES_PER_DEGREE // +z is south
  const longitude =
    MIDWAY.longitude +
    x / (METRES_PER_DEGREE * Math.cos((MIDWAY.latitude * Math.PI) / 180))
  return { longitude, latitude }
}

const round = (v: number, places: number) => {
  const f = Math.pow(10, places)
  return Math.round(v * f) / f
}

// field makes a value safe to interpolate into an ACMI line. The comma
// separates properties and the newline separates records, so a value carrying
// either writes structure rather than text: a multiplayer pilot named
// `x,Type=Ground+Static` reaches the object line through the wire and adds a
// property to their own object in everyone else's recording. Space, not
// removal, so a field keeps its visible length and cannot fuse two words.
// Every interpolation goes through here rather than only the ones that come
// from the network today - "escape the untrusted ones" is the rule that let
// nine of eleven sites go unescaped.
const field = (v: string) => v.replace(/[,\n\r]/g, ' ')

// acmi renders samples as an ACMI 2.2 recording; `started` stamps the reference
// time. Match describes the fight's rules in the header (mode, duel, weapons
// class, bot tier, live cheats) as free-text ACMI global properties.
export interface Match {
  [key: string]: string | number | boolean | undefined
}

// channels maps a multiplayer remote to the data the recorder writes for it
// (#163/#164). Pure, and separate from the engine, for the same reason stamp
// is: the engine cannot be loaded in a test, and this mapping is the part that
// was missing - a remote used to record as position and attitude alone, so a
// debrief of the mode where every opponent is a person knew everything about
// one aircraft and nothing about the other.
//
// Every value here already reached the client on the pose wire. Rounds and
// Struck are the server's own cumulative counts - the belt he has burned, and
// the rounds that have landed on him - so their steps are his bursts and his
// wounds, and they survive the recorder's sampling losslessly. TAS is the
// pose's own speed, which is why a remote no longer has to be
// finite-differenced from position (#161).
export function channels(
  remote: {
    spent?: number
    struck?: number
    speed?: number
    burning?: boolean
    burn?: [number, number]
    thrust?: number
    leak?: number
    reheat?: number
    gear?: number
    missiles?: number
    aoa?: number // degrees, off the pose wire (#164)
    g?: number // load factor (#164)
  },
  emitter?: { mode: number; target: number },
  mine?: number
): Record<string, string | number | boolean> {
  const burn = remote.burn ?? [0, 0]
  const out: Record<string, string | number | boolean> = {
    rounds: remote.spent ?? 0,
    struck: remote.struck ?? 0,
    tas: remote.speed ?? 0,
    burning: !!remote.burning || Math.max(burn[0] ?? 0, burn[1] ?? 0) > 0,
    thrust: remote.thrust ?? 0,
    leak: remote.leak ?? 0,
    burner: remote.reheat ?? 0,
    gear: remote.gear ?? 1,
    missiles: Math.max(0, Math.trunc(remote.missiles ?? 0)),
    // The two a debrief cannot reconstruct from the pose stream: #44 measured a
    // derived nose disagreeing with recorded AOA by up to 80 degrees, so these
    // are recorded or they are guessed.
    aoa: remote.aoa ?? 0,
    g: remote.g ?? 0,
    radar: emitter
      ? emitter.mode >= 2
        ? 'stt'
        : emitter.mode >= 1
          ? 'rws'
          : 'sil'
      : 'sil',
  }
  // Only a lock on US is ours to record: the emitter byte names one slot, and
  // claiming his lock on someone else would be a guess about a fight we cannot
  // see.
  if (emitter && mine !== undefined && emitter.target === mine) out.lock = 1
  return out
}

// stamp decides what the header says the fight WAS: its title and the Match_
// block a debrief reads to choose its rules. Pure, and separate from the
// engine, because the engine cannot be loaded in a test and this is the part
// that was wrong (#171).
//
// In multiplayer the SERVER is the authority. The client forces cfg.task to
// "joust" for every match at module init, and cfg.duel and cfg.bandit are the
// player's last SINGLE-PLAYER settings, so a furball against a person recorded
// as "joust-ace" - named after a bot that was not in it - and a debrief read
// the opening seconds under a merge weapons hold that never applied. The
// welcome carries the real mode and the match's weapons rule; both are already
// used elsewhere in the client, so nothing new has to reach the recorder.
export function stamp(fight: {
  multiplayer: boolean
  mode: string // multiplayer: the welcome's session mode. Single player: cfg.task
  duel: string // single player only: the joust's start shape
  bandit: string // single player only: the bandit's tier - a multiplayer match has none
  stage: number // single player only: the bandit brain's structural stage (&stage= in a developer build), 0 for the brain as it stands
  omit: number // single player only: stages left out beneath it, one bit per stage number (&omit=), 0 for none
  weapons: string // 'guns' | 'fox2' | 'open'
  start: string
  clouds: string
  tod: string
  world: string
  callsign: string
  cheats: Record<string, boolean> | undefined
  effects: number | undefined
  version: number
  // What the INPUT DEVICE was, as the browser reported it (#152). A stick in
  // a degraded state flies the jet on its good axes while its hat and trigger
  // send nothing, and the 2026-09-09 sortie was spent before anyone could
  // tell: establishing "was the stick healthy?" afterwards cost a debrief and
  // a code audit, and replugging the stick erased the evidence. Recorded here
  // it survives the replug and the question is a grep.
  stick: string // the pad's id as the Gamepad API gave it, '' for keyboard
  mapping: string // 'standard' when the browser remapped it, else ''
  axes: number
  buttons: number
  unreachable: string // bound actions the device does not report, comma-separated
}): { kind: string; match: Match } {
  const joust = !fight.multiplayer && fight.mode === 'joust'
  // The kind names the fight for the title, the history row and the file: a
  // multiplayer match by its mode, a single-player joust by the bandit it was
  // flown against, anything else a flight.
  const kind = fight.multiplayer
    ? fight.mode || 'furball'
    : joust
      ? 'joust-' + (fight.bandit || 'ace')
      : 'flight'
  return {
    kind,
    match: {
      task: fight.multiplayer ? fight.mode || 'furball' : fight.mode || '',
      // A duel shape and a bandit belong to a single-player joust and to
      // nothing else: empty here means "there was none", and acmi() omits it.
      duel: joust ? fight.duel || 'merge' : '',
      bandit: joust ? fight.bandit || 'ace' : '',
      // Which brain the bandit flew. A stage sortie is judged against that
      // brain, and without this only the pilot's memory could say which it was.
      stage: joust ? String(fight.stage || 0) : '',
      omit: joust && fight.omit ? String(fight.omit) : '',
      weapons: fight.weapons,
      start: fight.start,
      clouds: fight.clouds,
      tod: fight.tod,
      multiplayer: fight.multiplayer ? 1 : 0,
      world: fight.multiplayer ? fight.world : '',
      callsign: fight.callsign,
      cheats: Object.entries(fight.cheats ?? {})
        .filter(([, on]) => on)
        .map(([name]) => name)
        .join('+'),
      effects: String(fight.effects ?? 2),
      version: String(fight.version),
      // Omitted entirely when no pad is attached: acmi() drops empty values,
      // so a keyboard flight carries none of these rather than a row of
      // zeroes that would read as a device reporting nothing.
      stick: fight.stick,
      mapping: fight.stick ? fight.mapping || 'direct' : '',
      axes: fight.stick ? String(fight.axes) : '',
      buttons: fight.stick ? String(fight.buttons) : '',
      unreachable: fight.unreachable,
    },
  }
}

export function acmi(
  samples: Sample[],
  started: Date,
  title: string,
  match?: Match
): string {
  const out: string[] = [
    'FileType=text/acmi/tacview',
    'FileVersion=2.2',
    `0,ReferenceTime=${started.toISOString().replace(/\.\d+Z$/, 'Z')}`,
    '0,DataSource=Mochi Air',
    `0,Title=${field(title)}`,
    '0,Category=Flight',
  ]
  if (match) {
    for (const [key, value] of Object.entries(match)) {
      if (value === undefined || value === '') continue
      // Match_ prefix keeps these clear of ACMI's reserved global names.
      out.push(`0,Match_${key}=${field(String(value))}`)
    }
  }
  // Declared properties are written once per object and repeated only when
  // they change — ACMI is a delta format, and repeating them every frame
  // multiplies the file size for no information.
  const declared = new Map<number, string>()
  const counted = new Map<number, number>() // last written round count, per object
  const battled = new Map<number, string>() // last written battle channels, per object
  const armed = new Map<number, number>() // last written missiles count, per object
  const landed = new Map<number, string>() // last written gear|flaps|trim, per object (#86)
  const cued = new Map<number, string>() // last written cue, per object
  const overridden = new Map<number, boolean>() // last written g-limit override state, per object (#33)
  const grazed = new Map<number, number>() // last written burst miss, per object
  const journalled = new Map<string, string>() // last written decision-journal value, per object and channel
  const countered = new Map<number, number>() // last written flares, per object
  const bloomed = new Map<number, number>() // last written chaff, per object
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
        // Overstress exposure (#33 debrief): g·s beyond the airframe's OWN
        // limit, whether or not the g-limit override raised the commanded
        // ceiling - it accrues in that 7.5-10 g band precisely because the
        // override let the pilot hold it. Written every sample like G/AOA,
        // not delta-suppressed: a debrief reads its TRACE, not its steps.
        if (d.stress !== undefined) line += `,Stress=${round(d.stress, 2)}`
        if (d.yawrate !== undefined) line += `,YawRate=${round(d.yawrate, 1)}`
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
          if (d.struck !== undefined)
            battle += `,Struck=${Math.round(d.struck)}`
          if (d.burning !== undefined) battle += `,Burning=${d.burning ? 1 : 0}`
          if (d.thrust !== undefined) battle += `,Thrust=${round(d.thrust, 2)}`
          // Structure is the whole-airframe element total; Wing is the
          // aero-relevant wing loss the flight model actually flies. These were
          // one channel named `Wing` carrying the total (#103), which is what
          // made a fight's damage impossible to attribute from the recording.
          if (d.structure !== undefined)
            battle += `,Structure=${round(d.structure, 2)}`
          if (d.wing !== undefined) battle += `,Wing=${round(d.wing, 2)}`
          if (d.leak !== undefined) battle += `,Leak=${round(d.leak, 2)}`
          if (d.fate !== undefined) battle += `,Fate=${field(d.fate)}`
          if (d.killer) battle += `,Killer=${field(d.killer)}`
          if (battle && battled.get(o.id) !== battle) {
            battled.set(o.id, battle)
            line += battle
          }
        }
        if (d.stick !== undefined) line += `,Stick=${round(d.stick, 3)}`
        if (d.stabilator !== undefined)
          line += `,Stabilator=${round(d.stabilator, 2)}`
        if (d.lateral !== undefined) line += `,Lateral=${round(d.lateral, 3)}`
        // Configuration (#86): holds for minutes, steps at the moments an
        // approach debrief needs — which pitch law the FCS was flying.
        if (
          d.gear !== undefined ||
          d.flaps !== undefined ||
          d.trim !== undefined
        ) {
          const state = `${round(d.gear ?? 1, 2)}|${d.flaps ?? 0}|${round(d.trim ?? 0, 3)}`
          if (landed.get(o.id) !== state) {
            landed.set(o.id, state)
            line += `,Gear=${round(d.gear ?? 1, 2)},Flaps=${d.flaps ?? 0},Trim=${round(d.trim ?? 0, 3)}`
          }
        }
        // The g-limit override switch (#33 debrief): held rarely and briefly,
        // so delta-suppressed on its own rather than folded into Gear/Flaps/
        // Trim, which read as a landing configuration, not a combat one.
        if (
          d.override !== undefined &&
          overridden.get(o.id) !== d.override
        ) {
          overridden.set(o.id, d.override)
          line += `,Override=${d.override ? 1 : 0}`
        }
        // Missiles and the cue are delta-suppressed like the rounds: the count
        // steps at a launch, the cue at the moments the HUD's advice changed.
        if (d.missiles !== undefined && armed.get(o.id) !== d.missiles) {
          armed.set(o.id, d.missiles)
          line += `,Missiles=${Math.round(d.missiles)}`
        }
        if (d.cue !== undefined && cued.get(o.id) !== d.cue) {
          cued.set(o.id, d.cue)
          line += `,Cue=${field(d.cue)}`
        }
        // The burst's miss. Written whenever it improves within a burst and
        // once more when it clears, so the value standing at any sample is
        // this burst's best and a reader is never handed the last burst's.
        if (d.graze !== undefined && grazed.get(o.id) !== d.graze) {
          grazed.set(o.id, d.graze)
          line += `,Graze=${round(d.graze, 1)}`
          if (d.miss)
            line += `,Miss=${round(d.miss.ahead, 1)}|${round(d.miss.above, 1)}|${round(d.miss.right, 1)}`
        } else if (d.graze === undefined && grazed.has(o.id)) {
          grazed.delete(o.id)
          line += `,Graze=` // the burst is over: an empty field, as the cue channel does it
        }
        for (const [channel, value] of [
          ['Decision', d.decision],
          ['Forecast', d.forecast],
          ['Bypass', d.bypass],
          ['Demand', d.demand],
          ['Input', d.input],
          ['Break', d.break],
          ['Merge', d.merge],
        ] as const) {
          if (value === undefined) continue
          const key = `${o.id}:${channel}`
          if (journalled.get(key) === value) continue
          journalled.set(key, value)
          line += `,${channel}=${field(value)}`
        }
        if (d.flares !== undefined && countered.get(o.id) !== d.flares) {
          countered.set(o.id, d.flares)
          line += `,Flares=${Math.round(d.flares)}`
        }
        if (d.chaff !== undefined && bloomed.get(o.id) !== d.chaff) {
          bloomed.set(o.id, d.chaff)
          line += `,Chaff=${Math.round(d.chaff)}`
        }
        // Throttle and burner change constantly under a pilot's hand: written
        // every sample, like the flight data.
        if (d.throttle !== undefined)
          line += `,Throttle=${round(d.throttle, 2)}`
        if (d.burner !== undefined) line += `,Afterburner=${round(d.burner, 2)}`
        if (d.spool !== undefined) line += `,Spool=${round(d.spool, 2)}`
        // The sensor picture is delta-suppressed as one group: it holds for
        // seconds and steps at exactly the moments a debrief cares about.
        {
          let sensed = ''
          if (d.radar !== undefined) sensed += `,Radar=${field(d.radar)}`
          if (d.lock !== undefined) sensed += `,Lock=${d.lock.toString(16)}`
          if (d.rwrlock !== undefined) sensed += `,RwrLock=${d.rwrlock ? 1 : 0}`
          if (d.rwrmissile !== undefined)
            sensed += `,RwrMissile=${d.rwrmissile ? 1 : 0}`
          if (d.jammer !== undefined) sensed += `,Jammer=${d.jammer ? 1 : 0}`
          if (d.target !== undefined)
            sensed += `,Target=${d.target.toString(16)}`
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
        let guide = `,Seeker=${field(r.seeker)}`
        if (r.support !== undefined) guide += `,Support=${r.support ? 1 : 0}`
        if (r.least !== undefined) guide += `,Least=${round(r.least, 1)}`
        if (r.reason) {
          guide += `,Reason=${field(r.reason)}`
          if (r.rate !== undefined) guide += `,Rate=${round(r.rate, 3)}`
        }
        if (r.fate !== undefined)
          guide += `,Fate=${field(r.fate)},Killed=${r.killed ? 1 : 0}`
        if (r.burst !== undefined) {
          guide += `,Burst=${round(r.burst, 1)},Closure=${round(r.closure ?? 0, 0)},When=${round(r.when ?? 0, 2)}`
          if (r.off)
            guide += `,Off=${round(r.off.ahead, 1)}|${round(r.off.above, 1)}|${round(r.off.right, 1)}`
          // Judged (#85): the miss as the damage core measured it. Burst is the
          // client's continuous CPA; a fusing where the two disagree is the
          // client/core position split that let a 2.0 m detonation do nothing.
          if (r.judged !== undefined) guide += `,Judged=${round(r.judged, 1)}`
        }
        if (guided.get(o.id) !== guide) {
          guided.set(o.id, guide)
          line += guide
        }
      }
      const properties = `${o.name}|${o.label}|${o.colour}|${o.kind}|${o.mode ?? ''}|${o.skill ?? ''}|${r ? `${r.shooter}>${r.target ?? ''}` : ''}`
      if (declared.get(o.id) !== properties) {
        declared.set(o.id, properties)
        line += `,Name=${field(o.name)},Pilot=${field(o.label)},Color=${field(o.colour)},Type=${field(o.kind)}`
        if (o.skill) line += `,Skill=${field(o.skill)}` // the bot's tier, on the object itself: the mission title named it only for jousts, and only in the header
        if (o.mode) line += `,Doctrine=${field(o.mode)}` // developer builds only: the bot's chosen manoeuvre
        if (r) {
          // ACMI's own parent/target linkage, in the object ids the file uses.
          line += `,Parent=${r.shooter.toString(16)}`
          if (r.target !== undefined)
            line += `,LockedTarget=${r.target.toString(16)}`
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

  // due reports whether a sample offered at `time` would be kept: the caller
  // builds the sample before offering it, and anything it DRAINS to build it
  // (the bandit's decision journal) is lost with a sample this drops. At 60
  // frames a second into an 8 Hz recording that was seven drains in eight.
  due(time: number) {
    return this.last < 0 || time - this.last >= 1 / this.rate
  }

  // add samples at the configured rate and drops anything older than the
  // window. `time` is seconds since the mission started.
  add(time: number, objects: Recorded[]) {
    if (!this.due(time)) return
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
