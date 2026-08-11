// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The loadout model (#17): per-station fixtures and stores over the flight
// core's fitment catalog. Stations run 1..9, port tip to starboard tip
// (NATOPS numbering). A station holds one FIXTURE (the pylon or adapter
// chain collapsed to a single choice) exposing one or two POINTS, each
// holding a store or nothing. Structure (which fixtures a station accepts,
// which stores a point accepts) lives here; every number (mass, drag, fuel
// capacity, mask bit order) comes from the core's catalog at runtime so the
// two sides cannot drift.

// One fitment-catalog entry, as the flight core publishes it: the
// world-owned property table (this module deliberately does NOT import the
// flight module — the core hands its catalog to resolve() at the call site,
// which keeps this file pure for unit tests).
export interface Fitment {
  name: string
  station: number
  mass: number // kg (dry mass for tanks)
  area: number // m² flat plate
  fuel: number // kg usable capacity; 0 = dry store
  lateral: number // m buttline arm, signed port-negative — asymmetry arithmetic
}

// One station's configuration. fixture: "" none | "rail" single launcher
// | "twin" dual adapter | "pylon" wet pylon. stores: one id per point,
// "" empty | "9m" AIM-9 | "tank" 330 gal external tank.
export interface Slot {
  fixture: string
  stores: string[]
}

// Loadout maps station number (as a string key — the shape JSON persistence
// and the wire carry) to its slot. normalize() guarantees all nine stations.
export type Loadout = Record<string, Slot>

// Which fixtures each station accepts. Tips carry the integral LAU-7 — not
// removable, so the setup shows no fixture choice there. Cheek stations 4/6
// (#27) take the LAU-116 ejector — 'rail' in this vocabulary, with no visual
// piece: the round sits flush against the fuselage as on the real jet. The
// inboard pylons 3/7 take the twin too — the LAU-115C with a LAU-127 bolted
// to each side, the dual carriage behind the ten-AMRAAM fit.
export const STATIONS: Record<number, { fixtures: string[]; locked?: boolean }> = {
  1: { fixtures: ['rail'], locked: true },
  2: { fixtures: ['', 'rail', 'twin'] },
  3: { fixtures: ['', 'pylon', 'twin'] },
  4: { fixtures: ['', 'rail'] },
  5: { fixtures: ['', 'pylon'] },
  6: { fixtures: ['', 'rail'] },
  7: { fixtures: ['', 'pylon', 'twin'] },
  8: { fixtures: ['', 'rail', 'twin'] },
  9: { fixtures: ['rail'], locked: true },
}

// points is how many store points a fixture exposes.
export function points(fixture: string): number {
  if (fixture === 'twin') return 2
  return fixture ? 1 : 0
}

// options lists the store ids one point accepts (always including empty).
// The cheek stations are radar-missile positions (#27): AIM-120C only.
// Every rail point — the wing rail, and each side of a twin — is a LAU-127,
// which carries both missile families. The inboard pylons 3/7 are
// Sparrow-capable stations: the LAU-115C hangs a missile there — either
// family, single or twin pair — the real fuel-versus-magazine choice; the
// centreline never carries a missile at all.
export function options(station: number, fixture: string): string[] {
  if (station === 1 || station === 9) return ['', '9m']
  if (station === 4 || station === 6) return fixture === 'rail' ? ['', '120c'] : ['']
  if (fixture === 'rail' || fixture === 'twin') return ['', '9m', '120c']
  if (fixture === 'pylon') return station === 5 ? ['', 'tank'] : ['', 'tank', '9m', '120c']
  return ['']
}

// entries names the catalog entries a station's slot attaches: the fixture
// hardware (tips: none — the integral rail lives in the empty weight), then
// one entry per occupied point. Twin points map outer first ("a"), matching
// the firing order.
export function entries(station: number, slot: Slot): string[] {
  const out: string[] = []
  if (station === 1 || station === 9) {
    if (slot.stores[0] === '9m') out.push('tip' + station)
    return out
  }
  if (!slot.fixture) return out
  out.push(slot.fixture + station)
  if (slot.fixture === 'twin') {
    if (slot.stores[0]) out.push(slot.stores[0] + station + 'a')
    if (slot.stores[1]) out.push(slot.stores[1] + station + 'b')
  } else if (slot.stores[0]) {
    out.push(slot.stores[0] + station) // any occupied single point: 9m2, 120c4, tank3, 9m7...
  }
  return out
}

// normalize coerces arbitrary persisted or wire data into a legal loadout:
// all nine stations present, unknown fixtures and stores dropped, point
// counts matched to the fixture, tips locked to their rail.
export function normalize(raw: unknown): Loadout {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const out: Loadout = {}
  for (let station = 1; station <= 9; station++) {
    const entry = (source[String(station)] ?? {}) as { fixture?: unknown; stores?: unknown }
    const allowed = STATIONS[station].fixtures
    let fixture = typeof entry.fixture === 'string' && allowed.includes(entry.fixture) ? entry.fixture : allowed[0]
    if (STATIONS[station].locked) fixture = allowed[0]
    const wanted = Array.isArray(entry.stores) ? entry.stores : []
    const stores: string[] = []
    for (let p = 0; p < points(fixture); p++) {
      const id = typeof wanted[p] === 'string' ? (wanted[p] as string) : ''
      stores.push(options(station, fixture).includes(id) ? id : '')
    }
    out[String(station)] = { fixture, stores }
  }
  return out
}

// PRESETS are one-tap fills (#17, lineup decided 2026-08-11): Gun (no
// stores — the pure gunfight), Fox 2 (6× AIM-9M — tips plus four wing
// singles, spread for the crisper roll), Fox 3 (tip heaters, six AMRAAM
// singles across the wings and cheeks, and a centreline tank). Contents are
// data; weapon-era presets accumulate, mission presets evolve.
export const PRESETS: Record<string, Loadout> = {
  gun: normalize({}),
  fox2: normalize({
    1: { fixture: 'rail', stores: ['9m'] },
    2: { fixture: 'rail', stores: ['9m'] },
    3: { fixture: 'pylon', stores: ['9m'] },
    7: { fixture: 'pylon', stores: ['9m'] },
    8: { fixture: 'rail', stores: ['9m'] },
    9: { fixture: 'rail', stores: ['9m'] },
  }),
  fox3: normalize({
    1: { fixture: 'rail', stores: ['9m'] },
    2: { fixture: 'rail', stores: ['120c'] },
    3: { fixture: 'pylon', stores: ['120c'] },
    4: { fixture: 'rail', stores: ['120c'] },
    5: { fixture: 'pylon', stores: ['tank'] },
    6: { fixture: 'rail', stores: ['120c'] },
    7: { fixture: 'pylon', stores: ['120c'] },
    8: { fixture: 'rail', stores: ['120c'] },
    9: { fixture: 'rail', stores: ['9m'] },
  }),
}

// migrate maps the retired boolean to its preset: armed configs become
// Fox 2, guns-only becomes Gun.
export function migrate(missiles: boolean): Loadout {
  return structuredClone(missiles ? PRESETS.fox2 : PRESETS.gun)
}

// matches reports which preset a loadout equals, or "" for a custom fill —
// the setup highlights the matching preset button without storing a name.
export function matches(loadout: Loadout): string {
  for (const [name, preset] of Object.entries(PRESETS)) {
    if (JSON.stringify(normalize(loadout)) === JSON.stringify(preset)) return name
  }
  return ''
}

// missiles_loaded: the derived predicate that replaced cfg.missiles — it
// feeds the trigger gate, the bandit doctrine flag, and the joust rule.
// Any missile arms the fight: heaters and the AMRAAM alike (#27).
export function missiles_loaded(loadout: Loadout): boolean {
  for (let station = 1; station <= 9; station++) {
    const stores = loadout[String(station)]?.stores ?? []
    if (stores.includes('9m') || stores.includes('120c')) return true
  }
  return false
}

// strip removes every missile, for lobbies whose match rule forbids them.
// The persisted choice is never written back — the clamp is spawn-level.
export function strip(loadout: Loadout): Loadout {
  const out = normalize(loadout)
  for (let station = 1; station <= 9; station++) {
    const slot = out[String(station)]
    slot.stores = slot.stores.map((id) => (id === '9m' || id === '120c' ? '' : id))
  }
  return out
}

// amraams lists the loadout's AIM-120 entries in firing order — cheeks, then
// outboard rails, then inboard pylons, alternating port-first within each
// ring so a full expenditure stays balanced; twins fire the outer round
// before the inner, like the heaters (#27). The k-th launch takes
// amraams[k]; remaining count is amraams.length - fired.
export function amraams(loadout: Loadout): string[] {
  const out: string[] = []
  const ring = (stations: number[]) => {
    const queues = stations.map((station) => {
      const slot = loadout[String(station)] ?? { fixture: '', stores: [] }
      const names: string[] = []
      if (slot.fixture === 'twin') {
        if (slot.stores[0] === '120c') names.push('120c' + station + 'a')
        if (slot.stores[1] === '120c') names.push('120c' + station + 'b')
      } else if ((slot.fixture === 'rail' || slot.fixture === 'pylon') && slot.stores[0] === '120c') {
        names.push('120c' + station)
      }
      return names
    })
    for (let round = 0; queues.some((q) => round < q.length); round++) {
      for (const q of queues) {
        if (round < q.length) out.push(q[round])
      }
    }
  }
  ring([4, 6])
  ring([2, 8])
  ring([3, 7])
  return out
}

// jettison returns a new loadout with a station's departure applied: 'stores'
// empties the mounts and the fixture stays, 'rack' clears the fixture with
// everything on it (the real RACK/LCHR position — rail missiles leave only
// this way, the rail has no ejector). Wingtips (1/9) never jettison.
export function jettison(loadout: Loadout, station: number, what: 'stores' | 'rack'): Loadout {
  const out = normalize(loadout)
  if (station < 2 || station > 8) return out
  const slot = out[String(station)]
  slot.stores = slot.stores.map(() => '')
  if (what === 'rack') slot.fixture = ''
  return normalize(out) // a cleared fixture exposes zero points — keep the shape legal
}

// LIMITS carries each store's carriage envelope, keyed by catalog entry name,
// straight from NATOPS figure 4-4 (A1-F18AC-NFM-000, "MAXIMUM KCAS OR IMN
// WHICHEVER IS LESS"): wing tanks 635 KCAS / Mach 1.6; the centreline tank
// Mach 1.8 with NO KCAS figure (note 5 + 4.1.3.1 item 22.b) — the airspeed
// side is the basic aircraft's own envelope. Acceleration is "LBA — limit
// basic aircraft": tanks carry NO store g limit, and air-to-air missiles,
// rails and pylons appear in figure 4-3's basic-aircraft definition with no
// restriction at all, so they have no entry here (an entry below the FCS's
// own 7.5 g placard shed AIM-9 racks in a failure mode the jet does not
// have). Exceedance accumulates per-station harm; past threshold the
// attachment fails and the store departs through the same separation path
// (#18). JETTISON is the same figure's other half: a deliberate drop is
// clean only below 575 KCAS / Mach 0.95 between +1 and +2 g.
export const LIMITS: Record<string, { knots?: number; mach?: number }> = {
  tank3: { knots: 635, mach: 1.6 },
  tank7: { knots: 635, mach: 1.6 },
  tank5: { mach: 1.8 },
}
export const RELEASE = { knots: 575, mach: 0.95, low: 1.0, high: 2.0 }

// rounds lists the missile catalog entries in the authentic SMS priority
// order (researched 2026-08-05): wingtips first, alternating to the opposite
// station at the same priority level before stepping inboard — starboard tip
// seeds the sequence, outboard rails before the inboard pylons. Twins fire
// their outer round before the inner. The k-th launch takes rounds[k];
// remaining count is rounds.length - fired.
export function rounds(loadout: Loadout): { station: number; name: string }[] {
  const out: { station: number; name: string }[] = []
  const level = (stations: number[]) => {
    const queues = stations.map((station) => {
      const slot = loadout[String(station)] ?? { fixture: '', stores: [] }
      const names: string[] = []
      if (station === 1 || station === 9) {
        if (slot.stores[0] === '9m') names.push('tip' + station)
      } else if (slot.fixture === 'twin') {
        if (slot.stores[0] === '9m') names.push('9m' + station + 'a')
        if (slot.stores[1] === '9m') names.push('9m' + station + 'b')
      } else if (slot.stores[0] === '9m') {
        names.push('9m' + station) // a single on the wing rail or the inboard LAU-115C
      }
      return { station, names }
    })
    for (let round = 0; queues.some((q) => round < q.names.length); round++) {
      for (const q of queues) {
        if (round < q.names.length) out.push({ station: q.station, name: q.names[round] })
      }
    }
  }
  level([9, 1])
  level([8, 2])
  level([7, 3])
  return out
}

// Visual node names shared by the in-game jet and the setup preview, so the
// two can never disagree about what hangs where. TIPS maps the airframe
// GLB's wingtip AIM-9 nodes (sides verified by the index-aware lateral
// probe: Object_145 is the PORT tip). ANCHORS places AIM-9 rounds cloned
// onto the outboard stations, in stores.glb/model.glb space (x lateral with
// POSITIVE x = port, y vertical, z longitudinal): the tip missile mesh
// translates by (anchor - its own centre).
export const TIPS: Record<string, string> = { tip9: 'Object_542', tip1: 'Object_145' }
export const ANCHORS: Record<string, [number, number, number]> = {
  '9m2': [3.61, -0.38, -1.28],
  '9m2a': [3.76, -0.42, -1.28],
  '9m2b': [3.46, -0.42, -1.28],
  '9m8': [-3.61, -0.38, -1.28],
  '9m8a': [-3.76, -0.42, -1.28],
  '9m8b': [-3.46, -0.42, -1.28],
  // Inboard heaters (#27 follow-up): buttline from the art's station-3 tank
  // (2.40 — the mesh flies ~7% wide of the real 2.24, same ratio as the
  // outboard stations), hang heights matching the outboard rounds, and the
  // station's longitudinal shift taken from the AMRAAM anchors' art delta.
  '9m3': [2.4, -0.38, -1.57],
  '9m3a': [2.55, -0.42, -1.57],
  '9m3b': [2.25, -0.42, -1.57],
  '9m7': [-2.4, -0.38, -1.57],
  '9m7a': [-2.55, -0.42, -1.57],
  '9m7b': [-2.25, -0.42, -1.57],
}

// The setup presents each station as ONE dropdown of meaningful end states
// with the fixture derived underneath (#17 menu rework): players choose
// outcomes ("AIM-9", "Fuel tank"), never fixture vocabulary. Entries marked
// hidden only render when they are the current value — they keep older
// hand-built slots (a twin with one round) representable without offering
// them as choices.
export interface Outcome {
  id: string
  slot: Slot
  hidden?: boolean
}

export function outcomes(station: number): Outcome[] {
  if (station === 1 || station === 9) {
    return [
      { id: '', slot: { fixture: 'rail', stores: [''] } },
      { id: '9m', slot: { fixture: 'rail', stores: ['9m'] } },
    ]
  }
  if (station === 2 || station === 8) {
    return [
      { id: '', slot: { fixture: '', stores: [] } },
      { id: '9m', slot: { fixture: 'rail', stores: ['9m'] } },
      { id: '9m2', slot: { fixture: 'twin', stores: ['9m', '9m'] } },
      { id: '120c', slot: { fixture: 'rail', stores: ['120c'] } },
      { id: '120c2', slot: { fixture: 'twin', stores: ['120c', '120c'] } },
      { id: 'pylon', slot: { fixture: 'rail', stores: [''] } },
      { id: 'twin1', slot: { fixture: 'twin', stores: ['9m', ''] }, hidden: true },
      { id: 'twin1b', slot: { fixture: 'twin', stores: ['', '9m'] }, hidden: true },
      { id: '120c1', slot: { fixture: 'twin', stores: ['120c', ''] }, hidden: true },
      { id: '120c1b', slot: { fixture: 'twin', stores: ['', '120c'] }, hidden: true },
      { id: 'mixed', slot: { fixture: 'twin', stores: ['9m', '120c'] }, hidden: true },
      { id: 'mixedb', slot: { fixture: 'twin', stores: ['120c', '9m'] }, hidden: true },
      { id: 'twin0', slot: { fixture: 'twin', stores: ['', ''] }, hidden: true },
    ]
  }
  if (station === 4 || station === 6) {
    return [
      { id: '', slot: { fixture: '', stores: [] } },
      { id: '120c', slot: { fixture: 'rail', stores: ['120c'] } },
    ]
  }
  if (station === 3 || station === 7) {
    return [
      { id: '', slot: { fixture: '', stores: [] } },
      { id: 'tank', slot: { fixture: 'pylon', stores: ['tank'] } },
      { id: '9m', slot: { fixture: 'pylon', stores: ['9m'] } },
      { id: '9m2', slot: { fixture: 'twin', stores: ['9m', '9m'] } },
      { id: '120c', slot: { fixture: 'pylon', stores: ['120c'] } },
      { id: '120c2', slot: { fixture: 'twin', stores: ['120c', '120c'] } },
      { id: 'pylon', slot: { fixture: 'pylon', stores: [''] } },
      { id: 'twin1', slot: { fixture: 'twin', stores: ['9m', ''] }, hidden: true },
      { id: 'twin1b', slot: { fixture: 'twin', stores: ['', '9m'] }, hidden: true },
      { id: '120c1', slot: { fixture: 'twin', stores: ['120c', ''] }, hidden: true },
      { id: '120c1b', slot: { fixture: 'twin', stores: ['', '120c'] }, hidden: true },
      { id: 'mixed', slot: { fixture: 'twin', stores: ['9m', '120c'] }, hidden: true },
      { id: 'mixedb', slot: { fixture: 'twin', stores: ['120c', '9m'] }, hidden: true },
      { id: 'twin0', slot: { fixture: 'twin', stores: ['', ''] }, hidden: true },
    ]
  }
  if (station === 5) {
    return [
      { id: '', slot: { fixture: '', stores: [] } },
      { id: 'tank', slot: { fixture: 'pylon', stores: ['tank'] } },
      { id: 'pylon', slot: { fixture: 'pylon', stores: [''] } },
    ]
  }
  return [{ id: '', slot: { fixture: '', stores: [] } }]
}

// outcome names the entry a station's slot currently matches ('' = the
// station's empty state; every normalized slot matches something).
export function outcome(station: number, slot: Slot): string {
  const key = JSON.stringify(slot)
  for (const entry of outcomes(station)) {
    if (JSON.stringify(entry.slot) === key) return entry.id
  }
  return ''
}

// Catalog access: the caller reads the core's raw catalog (flight_catalog)
// and resolve() adds the name -> bit index map for mask and weight
// arithmetic.
export interface Catalog {
  stores: Fitment[]
  default: number
  internal: number
  empty: number
  index: Map<string, number>
}

export function resolve(raw: { stores: Fitment[]; default: number; internal: number; empty: number }): Catalog {
  const index = new Map<string, number>()
  raw.stores.forEach((entry, i) => index.set(entry.name, i))
  return { ...raw, index }
}

// mask computes the core attach bitmask for a loadout with `fired` heaters
// (rounds() order) and `expended` AMRAAMs (amraams() order) already away —
// each departure sheds its round's mass and drag in the core. Fixtures and
// tanks always attach; tips ride their catalog bits so the default (bare)
// jet stays a subset.
export function mask(loadout: Loadout, fired: number, book: Catalog, expended = 0): number {
  let bits = 0
  const spent = new Set(rounds(loadout).slice(0, Math.max(0, fired)).map((r) => r.name))
  for (const name of amraams(loadout).slice(0, Math.max(0, expended))) spent.add(name)
  for (let station = 1; station <= 9; station++) {
    for (const name of entries(station, loadout[String(station)] ?? { fixture: '', stores: [] })) {
      if (spent.has(name)) continue
      const bit = book.index.get(name)
      if (bit !== undefined) bits += 2 ** bit // NOT |=: the catalog outgrew 32 bits and JS bitwise is int32; f64 addition is exact here (unique names, bits far below 2^53)
    }
  }
  return bits
}

// weight sums the loadout's hardware and full-tank fuel in kg — the setup's
// gross-weight line and the CHKLST page both build on it. Fired rounds and
// burned external fuel are the caller's concern (they pass fired > 0 or read
// the live external state instead).
export function weight(loadout: Loadout, book: Catalog): { hardware: number; fuel: number } {
  let hardware = 0
  let fuel = 0
  for (let station = 1; station <= 9; station++) {
    for (const name of entries(station, loadout[String(station)] ?? { fixture: '', stores: [] })) {
      const bit = book.index.get(name)
      if (bit === undefined) continue
      hardware += book.stores[bit].mass
      fuel += book.stores[bit].fuel
    }
  }
  return { hardware, fuel }
}

// asymmetry sums the loadout's lateral moment in kg·m, signed port-negative,
// tanks full like weight(). NATOPS 4.1.5 states its limits in ft·lb — the
// display converts (kg·m × 7.233).
export function asymmetry(loadout: Loadout, book: Catalog): number {
  let moment = 0
  for (let station = 1; station <= 9; station++) {
    for (const name of entries(station, loadout[String(station)] ?? { fixture: '', stores: [] })) {
      const bit = book.index.get(name)
      if (bit === undefined) continue
      moment += (book.stores[bit].mass + book.stores[bit].fuel) * (book.stores[bit].lateral ?? 0)
    }
  }
  return moment
}
