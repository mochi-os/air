// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { lazy, Suspense, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import {
  Check,
  ChevronRight,
  History,
  LogIn,
  Pencil,
  Play,
  Send,
  Settings,
  TriangleAlert,
  Users,
  X,
} from 'lucide-react'
import { Input } from '@mochi/web/components/ui/input'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  getErrorMessage,
  useShellStorage,
} from '@mochi/web'
import { useIdentityName } from '../lib/config-store'
import { diagnose } from '../lib/graphics'

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@mochi/web/components/ui/select'
import { Button } from '@mochi/web/components/ui/button'
import { Label } from '@mochi/web/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@mochi/web/components/ui/radio-group'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@mochi/web/components/ui/dialog'
import { type MissionConfig, type StationSlot, seedStart } from '../lib/config'
import { ServerList, ServerRow, useServers } from './ServerList'
import { Multiplayer } from './Multiplayer'
import { Link } from '@tanstack/react-router'
import {
  PRESETS,
  asymmetry,
  matches,
  normalize,
  outcome,
  outcomes,
  weight,
  resolve,
  type Catalog,
} from '../game/stores'
import { flight_catalog, flight_load } from '../game/flight'
import {
  default_server,
  normalize_server,
  world_chat,
  world_status,
  world_withdraw,
  world_say,
  type Join,
  type WorldChatLine,
} from '../game/net'
import { SectionLabel, SliderRow, SwitchRow, MenuDialog } from './menu-parts'
import { SettingsDialog } from './SettingsDialog'

// Lazy, like GameCanvas on the route above: LoadoutPreview imports three.js
// directly, so a static import here put the whole renderer in the MENU's chunk
// — for a panel that only ever renders inside the Create mission dialog. The two
// warm together, because whichever loads first brings three with it.
const LoadoutPreview = lazy(() =>
  import('./LoadoutPreview').then((m) => ({ default: m.LoadoutPreview }))
)

// A standard single-select radio group laid out inline.
// Segmented: the short mutually-exclusive groups (2-4 options) as a joined row
// of buttons rather than scattered radio circles. Still a RadioGroup underneath,
// so arrow-key navigation and the screen-reader announcement are unchanged — only
// the skin differs. Long lists do NOT use this: past about four options the row
// wraps and the tightness is lost, which is what crowded the dialog in the first
// place, so Start and Clouds are Selects instead.
function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (value: T) => void
  options: { value: T; label: ReactNode }[]
}) {
  const baseId = useId()
  return (
    <RadioGroup value={value} onValueChange={(v) => onChange(v as T)} className='flex flex-wrap gap-1'>
      {options.map((o) => {
        const id = `${baseId}-${o.value}`
        const on = o.value === value
        return (
          <div key={o.value}>
            <RadioGroupItem value={o.value} id={id} className='peer sr-only' />
            <Label
              htmlFor={id}
              className={`cursor-pointer rounded-md border px-2.5 py-1 text-sm font-normal transition-colors peer-focus-visible:ring-[3px] ${
                on ? 'bg-primary text-primary-foreground border-primary' : 'bg-background hover:bg-muted border-input'
              }`}
            >
              {o.label}
            </Label>
          </div>
        )
      })}
    </RadioGroup>
  )
}

// Picker: a long mutually-exclusive list. A Select costs a click to open, which
// is the right trade only once the options stop fitting on one line.
function Picker<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (value: T) => void
  options: { value: T; label: ReactNode }[]
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as T)}>
      <SelectTrigger className='w-full'>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}


// The loadout editor (#17, reworked for first-time readability): the live
// head-on jet on top — a station choice reads on the aircraft itself — then
// the three presets with plain one-line descriptions, and the per-station
// editor folded behind "Customize loadout". Inside, stations are labelled by
// POSITION ("Left wingtip", "Centerline"…, the NATOPS number as a small
// annotation) and each offers ONE dropdown of meaningful end states with the
// fixture derived underneath (game/stores.ts outcomes) — players choose
// "AIM-9" or "Fuel tank", never rail-versus-pylon vocabulary. Numbers come
// from the flight core's catalog, loaded on demand so the menu works before
// any mission starts. Edits build ONE new loadout and call onChange once.
// When `allowed` is false (a guns-only match rule) missile outcomes are
// ABSENT — not greyed; the persisted choice is never written back.
function Armament({
  stores,
  fuel,
  allowed,
  catapult,
  onChange,
  onFuel,
  onPreset,
}: {
  stores: Record<string, StationSlot>
  fuel: number
  allowed: boolean
  catapult: boolean
  onChange: (stores: Record<string, StationSlot>) => void
  onFuel: (fuel: number) => void
  onPreset: (stores: Record<string, StationSlot>, fuel: number) => void
}) {
  const read = () => {
    const raw = flight_catalog('fa18c')
    return raw ? resolve(raw) : null
  }
  const [book, setBook] = useState<Catalog | null>(read)
  useEffect(() => {
    if (book) return
    let gone = false
    void flight_load().then(() => {
      if (!gone) setBook(read())
    })
    return () => {
      gone = true
    }
  }, [book])
  const loadout = normalize(stores)
  const preset = matches(loadout)
  const positions: Record<number, ReactNode> = {
    1: <Trans>Left wingtip</Trans>,
    2: <Trans>Left wing</Trans>,
    3: <Trans>Left wing</Trans>,
    4: <Trans>Fuselage</Trans>,
    5: <Trans>Centerline</Trans>,
    6: <Trans>Fuselage</Trans>,
    7: <Trans>Right wing</Trans>,
    8: <Trans>Right wing</Trans>,
    9: <Trans>Right wingtip</Trans>,
  }
  const label = (id: string): ReactNode => {
    switch (id) {
      case '9m':
        return 'AIM-9M' // designations verbatim, like the Reference dialog's V-speeds
      case '9m2':
        return '2× AIM-9M' // jsx-text-ok: a count and a designation, no prose
      case '120c':
        return 'AIM-120C' // designation verbatim (#27)
      case '120c2':
        return '2× AIM-120C' // jsx-text-ok: a count and a designation, no prose
      case 'tank':
        return <Trans>Fuel tank</Trans>
      case 'pylon':
        return <Trans>Empty pylon</Trans>
      case 'twin1':
      case 'twin1b':
        return 'AIM-9M' // legacy hand-built twin with one round: shown, never offered
      case '120c1':
      case '120c1b':
        return 'AIM-120C' // hand-built twin with one round: shown, never offered
      case 'mixed':
      case 'mixedb':
        return 'AIM-9M + AIM-120C' // jsx-text-ok: designations; the real LAU-115 flies mixed pairs, representable but not offered
      case 'twin0':
        return <Trans>Empty pylon</Trans>
      default:
        return <Trans>None</Trans>
    }
  }
  const presets: { name: 'gun' | 'fox2' | 'fox3'; title: ReactNode }[] = [
    { name: 'gun', title: <Trans>Gun only</Trans> },
    { name: 'fox2', title: 'Fox 2' }, // jsx-text-ok: brevity codes, verbatim
    { name: 'fox3', title: 'Fox 3' }, // jsx-text-ok: brevity codes, verbatim
  ]
  // A preset press SEEDS the fuel load — full internal for every preset since
  // 2026-08-18: the 6,000 lb duel standard the fighters used to seed ended a
  // new pilot's fight on fuel before it ended on a kill (a seven-minute joust
  // at 79% burner landed at 1,000 lb), and an experienced one is a slider
  // pull from a lighter jet. The checkmark keeps tracking stores only, so the
  // slider stays freely overridable without un-checking the preset.
  const FUELS = { gun: 10800, fox2: 10800, fox3: 10800 }
  const w = book ? weight(loadout, book) : { hardware: 0, fuel: 0 }
  const gross = book ? Math.round(((book.empty + w.hardware + w.fuel) * 2.2046 + fuel) / 10) * 10 : 0
  // NATOPS flying-qualities boundary for routine catapult technique: at or
  // below 48,000 lb a hands-off rotation is benign. No v1 loadout can reach
  // it (the warning arms when heavier stores arrive); warn, never clamp.
  const LAUNCH = 48000
  // NATOPS 4.1.5 lateral asymmetry, kg·m → ft·lb: the jet genuinely flies
  // the moment (each store's mass sits at its buttline), so an uneven fill
  // gets its readout — and its 6,000 ft·lb catapult limit when the mission
  // starts on the cat. Warn, never clamp, like the launch weight above.
  const moment = book ? Math.round((Math.abs(asymmetry(loadout, book)) * 7.233) / 10) * 10 : 0
  const CATAPULT = 6000
  return (
    <div className='space-y-3'>
      {/* The fallback holds the preview's exact aspect box, so the dialog does
          not jump when the renderer arrives (and stands in permanently on a
          machine with no WebGL 2, where LoadoutPreview draws nothing). */}
      <Suspense fallback={<div className='aspect-[29/10] w-full' />}>
        <LoadoutPreview stores={loadout} />
      </Suspense>
      <div className='flex flex-wrap gap-2'>
        {presets.map((entry) => (
          <Button key={entry.name} type='button' variant='outline' size='sm' onClick={() => onPreset(structuredClone(PRESETS[entry.name]), FUELS[entry.name])}>
            {preset === entry.name && <Check className='size-4' />}
            {entry.title}
          </Button>
        ))}
      </div>
      {/* The station strip is always visible (2026-08-13): a loadout that
          matches no preset simply shows no check above, and the dropdowns
          ARE the details — folding them behind a button hid the answer to
          "what am I actually carrying". */}
      {(() => {
          const cell = (station: number) => {
            const slot = loadout[String(station)]
            const open = outcomes(station).filter((o) => allowed || !o.slot.stores.some((s) => s === '9m' || s === '120c'))
            const current = outcome(station, slot)
            const usable = open.filter((o) => !o.hidden || o.id === current)
            const dead = usable.length <= 1
            return (
              <div key={station} className='space-y-1'>
                <div className='text-muted-foreground text-xs'>
                  {positions[station]} <span className='opacity-60'>{station}</span>
                </div>
                {dead ? (
                  <div className='text-muted-foreground/60 py-1.5 text-sm'>—</div>
                ) : (
                  <Select
                    value={current || 'none'}
                    onValueChange={(v) => {
                      const picked = open.find((o) => (o.id || 'none') === v)
                      if (picked) onChange({ ...loadout, [String(station)]: structuredClone(picked.slot) })
                    }}
                  >
                    <SelectTrigger size='sm' className='w-full px-2'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {usable.map((o) => (
                        <SelectItem key={o.id || 'none'} value={o.id || 'none'}>
                          {label(o.id)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            )
          }
          // Three columns MIRRORING the nose-on jet above: head-on, the
          // jet's right wing is on the viewer's LEFT. Each column runs
          // wingtip at the top to fuselage at the bottom; the centerline
          // bottom-aligns with the fuselage row. Equal thirds: the longest
          // wing label (2× AIM-120C) and the longest centerline label
          // (Empty pylon) are nearly the same width, and the tight gap and
          // trigger padding buy the text room the stock spacing lacked.
          return (
            <div className='grid grid-cols-3 gap-x-2'>
              <div className='space-y-2'>{[9, 8, 7, 6].map(cell)}</div>
              <div className='flex flex-col justify-end'>{[5].map(cell)}</div>
              <div className='space-y-2'>{[1, 2, 3, 4].map(cell)}</div>
            </div>
          )
        })()}
      <SliderRow label={<Trans>Internal fuel</Trans>} value={fuel} min={1500} max={10800} step={100} decimals={0} suffix=' lb' onChange={onFuel} />
      {book && (
        <div className='text-sm'>
          {/* jsx-text-ok: LB and ft·lb are the cockpit's own unit annunciations, verbatim like the IFEI */}
          <Trans>Gross weight</Trans>{' '}
          <span className='tabular-nums' style={{ fontFamily: 'var(--air-mono)' }}>
            {gross} lb
          </span>
          {/* The asymmetry rides in brackets on the gross-weight line: it is a
              property of the same loadout, and its own line read as a second
              headline for what is really a qualifier. The over-limit warnings
              below stay on their own lines — those ARE headlines. */}
          {moment > 0 && (
            <>
              {' ('}
              {/* Lower case as a mid-sentence qualifier, and a msgid of its own rather than a
                  CSS transform of the capitalised one: German capitalises its nouns, so
                  Asymmetrie must stay capitalised where English asymmetry does not. */}
              <Trans>asymmetry</Trans>{' '}
              <span className='tabular-nums' style={{ fontFamily: 'var(--air-mono)' }}>
                {moment} ft·lb
              </span>
              {')'}
            </>
          )}
          {gross > LAUNCH && (
            <div className='mt-1 flex items-center gap-1.5 text-amber-500'>
              <TriangleAlert className='size-4' />
              <Trans>{gross - LAUNCH} lb over maximum launch weight</Trans>
            </div>
          )}
          {catapult && moment > CATAPULT && (
            <div className='mt-1 flex items-center gap-1.5 text-amber-500'>
              <TriangleAlert className='size-4' />
              <Trans>{moment - CATAPULT} ft·lb over the catapult asymmetry limit</Trans>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
// The measured F/A-18C performance reference (#89): every number flown out of
// the flight model by tools/vspeeds.sh (world repo) — rerun it after flight
// changes and update these cells. Cells are TRUE KCAS, matching the HUD box:
// flight/frames.go Cas() carries the compressible pitot term (#133), so the
// 15,000/30,000 ft cells sit up to ~20 kt above the harness's KEAS printout
// (convert with the compressible formula; sea level is the identity).
// Ranges span light (11.2 t, minimum fuel) to heavy (15.6 t, full internal).
// Rows in sortie order: climb, engine-out, dash, combat, landing. Rotation
// (Vr) is deliberately absent: nosewheel liftoff depends on weight, CG, and
// technique (NATOPS gives no single speed), so a one-number row would
// mislead. The V-speed designations (Vx, Vy, Vs1, Vs0, Vapp, Vyse) are
// international aviation abbreviations and stay verbatim in every locale; the
// descriptive phrase around each is translated. id is the stable React key
// (the label is now a translated node, not a plain string).
const REFERENCE_ROWS: { id: string; label: ReactNode; cells: [string, string, string] }[] = [
  // Regenerated 2026-08-07 against today's flight model (tools/vspeeds.sh,
  // corner acceptance stabilised first — the old cells were recalibration
  // history, corner reading 298 where the jet flies 339). Each cell is
  // light-to-heavy (11.2 t minimum-fuel to 15.6 t full-internal), and the
  // heavy figure is written second even where it is the LOWER speed — the
  // column meaning outranks ascending cosmetics.
  { id: 'vx-mil', label: <Trans>Steepest climb (Vx, 100% thrust)</Trans>, cells: ['186-318', '270-337', '284-343'] },
  { id: 'vx-ab', label: <Trans>Steepest climb (Vx, afterburner)</Trans>, cells: ['Vertical', '229-219', '192-259'] },
  { id: 'vy-mil', label: <Trans>Best climb (Vy, 100% thrust)</Trans>, cells: ['562-576', '445-387', '342-348'] },
  { id: 'vy-ab', label: <Trans>Best climb (Vy, afterburner)</Trans>, cells: ['600-530', '463-475', '354-273'] },
  { id: 'vyse', label: <Trans>Single-engine best climb (Vyse, afterburner)</Trans>, cells: ['359-433', '366-232', '178-199'] },
  { id: 'glide', label: <Trans>Best glide (engines out)</Trans>, cells: ['223-263', '225-266', '229-274'] },
  { id: 'corner', label: <Trans>Corner speed (best instant turn)</Trans>, cells: ['339-386', '337-392', '336-340'] },
  { id: 'sustained', label: <Trans>Best sustained turn speed</Trans>, cells: ['373-470', '408-437', '326-328'] },
  { id: 'tightest', label: <Trans>Tightest sustained turn speed</Trans>, cells: ['167-196', '173-197', '186-201'] },
  { id: 'vs1', label: <Trans>Stall, clean (Vs1)</Trans>, cells: ['159-186', '159-187', '161-191'] },
  { id: 'vs0', label: <Trans>Stall, landing config (Vs0)</Trans>, cells: ['110-126', '108-126', '—'] },
  { id: 'vapp', label: <Trans>Approach, on-speed (Vapp)</Trans>, cells: ['126-148', '126-147', '—'] },
]

function ReferenceDialog() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type='button' variant='link' size='sm' className='text-muted-foreground'>
          <Trans>Reference</Trans>
        </Button>
      </DialogTrigger>
      <DialogContent className='sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>
            <Trans>F/A-18C reference</Trans>
          </DialogTitle>
        </DialogHeader>
        <div className='overflow-x-auto'>
          <table className='w-full text-sm'>
            <thead>
              <tr className='text-muted-foreground border-b text-left'>
                <th className='py-1.5 pr-3 font-medium'></th>
                <th className='px-3 py-1.5 text-right font-medium'>
                  <Trans>Sea level</Trans>
                </th>
                <th className='px-3 py-1.5 text-right font-medium'>
                  <Trans>15,000 AMSL</Trans>
                </th>
                <th className='px-3 py-1.5 text-right font-medium'>
                  <Trans>30,000 AMSL</Trans>
                </th>
              </tr>
            </thead>
            <tbody>
              {REFERENCE_ROWS.map((row) => (
                <tr key={row.id} className='border-b border-dashed last:border-0'>
                  <td className='py-1.5 pr-3 whitespace-nowrap'>{row.label}</td>
                  {row.cells.map((cell, i) => (
                    <td key={i} className='text-muted-foreground px-3 py-1.5 text-right tabular-nums whitespace-nowrap'>
                      {cell === 'Vertical' ? <Trans>Vertical</Trans> : cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className='text-muted-foreground space-y-1 text-xs leading-relaxed'>
          <p>
            <Trans>
              Speeds in KCAS, as a range from light (minimum fuel, no stores) to heavy (maximum
              gross). Data derived experimentally in-game. Any differences from the real aircraft
              reflect simulator flight model errors.
            </Trans>
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function CreditsDialog() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type='button' variant='link' size='sm' className='text-muted-foreground'>
          <Trans>Credits</Trans>
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <Trans>Credits</Trans>
          </DialogTitle>
        </DialogHeader>
        <div className='text-muted-foreground space-y-3 text-sm'>
          <p className='leading-relaxed'>
            <Trans>
              Aircraft model <b>“F/A-18C Hornet”</b> by <b>CreadorDeMu</b> (Sketchfab), licensed
              under <b>CC BY 4.0</b>. Modified: reoriented and rescaled, unused texture payload
              removed, external stores split into a separate file, one shroud mesh mirrored.
            </Trans>{' '}
            <a
              className='text-primary hover:underline'
              href='https://sketchfab.com/3d-models/fa-18c-hornet-1cc5824033d84185b9bf8b222d9bb068'
              target='_blank'
              rel='noopener noreferrer'
            >
              {/* jsx-text-ok: attribution name, required verbatim by the source licence */}
              Sketchfab
            </a>{' '}
            ·{' '}
            <a
              className='text-primary hover:underline'
              href='https://creativecommons.org/licenses/by/4.0/'
              target='_blank'
              rel='noopener noreferrer'
            >
              {/* jsx-text-ok: attribution name, required verbatim by the source licence */}
              CC BY 4.0
            </a>
          </p>
          <p className='leading-relaxed'>
            <Trans>
              Aircraft carrier <b>“USS Nimitz CVN-68 Aircraft Carrier”</b> by{' '}
              <b>Muhamad Mirza Arrafi</b> (Sketchfab), licensed under <b>CC BY 4.0</b>. Modified:
              rescaled, reoriented, sunk to the waterline, and simplified for the web.
            </Trans>{' '}
            <a
              className='text-primary hover:underline'
              href='https://sketchfab.com/3d-models/uss-nimitz-cvn-68-aircraft-carrier-06cf0dba66874934a105b3fe2bfdb0f7'
              target='_blank'
              rel='noopener noreferrer'
            >
              {/* jsx-text-ok: attribution name, required verbatim by the source licence */}
              Sketchfab
            </a>{' '}
            ·{' '}
            <a
              className='text-primary hover:underline'
              href='https://creativecommons.org/licenses/by/4.0/'
              target='_blank'
              rel='noopener noreferrer'
            >
              {/* jsx-text-ok: attribution name, required verbatim by the source licence */}
              CC BY 4.0
            </a>
          </p>
          <p className='leading-relaxed'>
            <Trans>
              Missile model <b>“AIM-120C AMRAAM”</b> by <b>Pippa</b> (Sketchfab), licensed under{' '}
              <b>CC BY 4.0</b>. Modified: rescaled, reoriented, and centred for placement.
            </Trans>{' '}
            <a
              className='text-primary hover:underline'
              href='https://sketchfab.com/3d-models/aim-120c-amraam-62b79b0f76e44684ad43adcc2ae3cdb9'
              target='_blank'
              rel='noopener noreferrer'
            >
              {/* jsx-text-ok: attribution name, required verbatim by the source licence */}
              Sketchfab
            </a>{' '}
            ·{' '}
            <a
              className='text-primary hover:underline'
              href='https://creativecommons.org/licenses/by/4.0/'
              target='_blank'
              rel='noopener noreferrer'
            >
              {/* jsx-text-ok: attribution name, required verbatim by the source licence */}
              CC BY 4.0
            </a>
          </p>
          <p className='leading-relaxed'>
            <Trans>
              Midway Atoll map — imagery contains modified <b>Copernicus Sentinel-2</b> data (2026);
              airfield geometry (runway, taxiways, aprons) © <b>OpenStreetMap</b> contributors,
              licensed under <b>ODbL</b>; coastline and reef data from <b>NOAA NCCOS</b> (public
              domain).
            </Trans>{' '}
            <a
              className='text-primary hover:underline'
              href='https://dataspace.copernicus.eu/'
              target='_blank'
              rel='noopener noreferrer'
            >
              {/* jsx-text-ok: attribution name, required verbatim by the source licence */}
              Copernicus
            </a>{' '}
            ·{' '}
            <a
              className='text-primary hover:underline'
              href='https://www.openstreetmap.org/copyright'
              target='_blank'
              rel='noopener noreferrer'
            >
              {/* jsx-text-ok: attribution name, required verbatim by the source licence */}
              OpenStreetMap
            </a>{' '}
            ·{' '}
            <a
              className='text-primary hover:underline'
              href='https://coastalscience.noaa.gov/'
              target='_blank'
              rel='noopener noreferrer'
            >
              {/* jsx-text-ok: attribution name, required verbatim by the source licence */}
              NOAA NCCOS
            </a>
          </p>
          <p className='leading-relaxed'>
            <Trans>
              Rendering by <b>three.js</b> (MIT licence).
            </Trans>{' '}
            <a
              className='text-primary hover:underline'
              href='https://threejs.org/'
              target='_blank'
              rel='noopener noreferrer'
            >
              {/* jsx-text-ok: attribution name, required verbatim by the source licence */}
              three.js
            </a>
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// The server-wide lobby chat (#84): sits beside the menu so anyone browsing —
// whether or not they've picked a match — can talk about what to fly next.
// Player lines are {name, text}; system lines are structured events rendered
// in the viewer's language. It follows the world server configured on the
// Mission tab, falling back to this host's conventional lobby port.
function LobbyChat({ server, callsign }: { server: string; callsign: string }) {
  const { t } = useLingui()
  const identity = useIdentityName()
  const [lounge, setLounge] = useState<WorldChatLine[]>([])
  const [error, setError] = useState('')
  const [up, setUp] = useState(true) // optimistic until the first poll answers
  const cursor = useRef(0)
  const lineRef = useRef<HTMLInputElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const address = normalize_server(server || default_server())
  const name = (callsign || identity || t`pilot`).slice(0, 32)

  // Poll while the menu is open. This audience has no game connection, so plain
  // HTTP; an unreachable world server just leaves the lobby empty and quiet.
  useEffect(() => {
    cursor.current = 0
    setLounge([])
    let alive = true
    const pull = async () => {
      try {
        const reply = await world_chat(address, cursor.current)
        if (!alive) return
        cursor.current = reply.sequence
        if (reply.lines.length) setLounge((have) => [...have, ...reply.lines].slice(-100))
        setUp(true)
      } catch {
        if (alive) setUp(false) // no reachable world server — the empty state says so
      }
    }
    void pull()
    const chatter = setInterval(pull, 3000)
    return () => {
      alive = false
      clearInterval(chatter)
    }
  }, [address])

  useEffect(() => {
    boxRef.current?.scrollTo({ top: boxRef.current.scrollHeight })
  }, [lounge])

  const say = async () => {
    const words = lineRef.current?.value.trim()
    if (!words) return
    if (lineRef.current) lineRef.current.value = ''
    try {
      await world_say(address, name, words)
      const reply = await world_chat(address, cursor.current)
      cursor.current = reply.sequence
      if (reply.lines.length) setLounge((have) => [...have, ...reply.lines].slice(-100))
      setError('')
      setUp(true)
    } catch (e) {
      // A fetch-level failure carries the browser's raw "Failed to fetch" —
      // when the server is (or just went) unreachable, say that instead.
      setUp(false)
      setError(up ? getErrorMessage(e, t`Could not send the message`) : t`World server not reachable`)
    }
  }

  return (
    <div className='flex h-full flex-col'>
      <div className='text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase'>
        <Trans>Server chat</Trans>
      </div>
      <div ref={boxRef} className='flex-1 space-y-0.5 overflow-y-auto rounded-md border p-2 text-sm'>
        {lounge.length === 0 && (
          <div className='text-muted-foreground text-xs'>
            {up ? <Trans>Nothing yet — say hello.</Trans> : <Trans>No world server.</Trans>}
          </div>
        )}
        {lounge.map((line) =>
          line.event === 'made' ? (
            <div key={line.sequence} className='text-muted-foreground text-xs italic'>
              <Trans>
                {line.name} created “{line.label}”
              </Trans>
            </div>
          ) : (
            <div key={line.sequence} className='break-words'>
              <span className='text-muted-foreground'>{line.name}: </span>
              {line.text}
            </div>
          )
        )}
      </div>
      {error && <div className='text-destructive mt-1 text-xs'>{error}</div>}
      <div className='mt-2 flex gap-2'>
        <Input
          ref={lineRef}
          maxLength={200}
          placeholder={t`Message players on this server`}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void say()
          }}
        />
        <Button type='button' variant='outline' onClick={() => void say()}>
          <Send className='size-4' />
          <Trans>Send</Trans>
        </Button>
      </div>
    </div>
  )
}

const STARTS: Record<string, ReactNode> = {
  air: <Trans>In air</Trans>,
  runway: <Trans>On runway</Trans>,
  carrier: <Trans>On carrier</Trans>,
  case1: <Trans>Case I</Trans>,
  case2: <Trans>Case II</Trans>,
  case3: <Trans>Case III</Trans>,
}

// ServerFlow is the multiplayer half of the menu: pick a server (recents
// first — typing a hostname every time would sting), then a full page of the
// matches it is offering beside its lobby chat. A MATCH is you against each
// other: created, offered, joined, left — never paused or restarted by one
// participant, which is why none of the mission verbs appear here.
function ServerFlow({
  open,
  onClose,
  config,
  set,
  onChange,
  onJoin,
}: {
  open: boolean
  onClose: () => void
  config: MissionConfig
  set: <K extends keyof MissionConfig>(key: K, value: MissionConfig[K]) => void
  onChange: (config: MissionConfig) => void
  onJoin: (join: Join) => void
}) {
  const [entered, setEntered] = useState(false)
  const [address, setAddress] = useState(config.world || '')
  const { servers, version } = useServers()
  // The private-server address entry is collapsed by default; no persistence,
  // because a joined private server lands in recents, which remembers for us.
  const [private_, setPrivate] = useState(false)
  // The server's own name, from its lobby status — every world server
  // advertises one ([world] name), so the page can be titled with it even for
  // private servers the public listing has never heard of. Empty until it
  // answers; the generic heading stands in.
  const [world, setWorld] = useState('')
  useEffect(() => {
    if (!entered) return
    const abort = new AbortController()
    setWorld('')
    world_status(normalize_server(config.world || default_server()), abort.signal)
      .then((s) => setWorld(s.name))
      .catch(() => {}) // unreachable: the generic heading stands
    return () => abort.abort()
  }, [entered, config.world])
  // The pilot token identifies the owner of a match offer across reconnects.
  // It is minted when the player actually enters a server — NOT in an effect at
  // mount: this component is mounted (closed) from the first render, and a
  // write then races config/load, persisting a defaults-shaped config over the
  // saved one. That is the PendingConfig hazard useMissionConfig documents, and
  // it cost a saved callsign.
  const pilot = config.pilot || crypto.randomUUID()
  // Recents live beside the rest of the mission config so they persist with it.
  const recents = String(config.servers ?? '').split('\n').filter(Boolean)
  const enter = (server: string) => {
    const chosen = server.trim() || default_server()
    const next = { ...config, world: chosen, pilot }
    onChange({ ...next, servers: [chosen, ...recents.filter((r) => r !== chosen)].slice(0, 5).join('\n') }) // one write: consecutive set() calls each spread the render's config
    setEntered(true)
  }
  const leave = () => {
    // Leaving the page withdraws any offer you were making: an offer is
    // presence-scoped — you are offering a match while you are here. The
    // server's heartbeat grace only has to cover a tab that vanished.
    void world_withdraw(normalize_server(config.world || default_server()), pilot)
    setEntered(false)
    onClose()
  }
  if (!open) return null
  if (!entered) {
    // A recent that matches a public listing shows ONCE, here in the recent
    // position, under its public name with the live count — the name is the
    // player-facing identity; the raw address is only shown when no listing
    // matches (a private server, or a public one gone quiet), which doubles
    // as the honest signal that the server is not currently announcing.
    const matched = (r: string) => (servers ?? []).find((s) => normalize_server(s.address) === normalize_server(r))
    const publics = (servers ?? []).filter((s) => !recents.some((r) => normalize_server(r) === normalize_server(s.address)))
    // The address entry is the expert path and collapses out of a new
    // player's way — unless it is the only thing the dialog would contain
    // (no listings, no recents: today's lone-private-player state).
    const bare = servers !== null && publics.length === 0 && recents.length === 0
    const entry = private_ || bare
    return (
      <MenuDialog open onClose={onClose} title={<Trans>Join server</Trans>}>
        <div className='space-y-4'>
          {recents.length > 0 && (
            <div className='space-y-2'>
              <SectionLabel>
                <Trans>Recent</Trans>
              </SectionLabel>
              <div className='flex flex-col gap-1'>
                {recents.map((r) => {
                  const s = matched(r)
                  return s ? (
                    <ServerRow key={r} server={s} version={version} onPick={(a) => enter(a)} />
                  ) : (
                    <Button key={r} type='button' variant='outline' className='justify-start font-mono text-sm' onClick={() => enter(r)}>
                      {r}
                    </Button>
                  )
                })}
              </div>
            </div>
          )}
          {/* The public list: community servers hosting air, live from the
              network. Absent entirely when nothing is public, so a lone
              private player just sees the recents + address entry. */}
          {publics.length > 0 && (
            <div className='space-y-2'>
              <SectionLabel>
                <Trans>Public servers</Trans>
              </SectionLabel>
              <ServerList servers={publics} version={version} onPick={(a) => enter(a)} />
            </div>
          )}
          <div className='space-y-2'>
            <button
              type='button'
              onClick={() => setPrivate(!private_)}
              className='text-muted-foreground hover:text-foreground flex items-center gap-1 text-sm transition-colors'
            >
              <ChevronRight className={`size-4 transition-transform ${entry ? 'rotate-90' : ''}`} />
              <Trans>Connect to private server</Trans>
            </button>
            {entry && (
              <>
                <Input
                  value={address}
                  placeholder={default_server()}
                  onChange={(e) => setAddress(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && enter(address)}
                />
                <div className='flex justify-end'>
                  <Button onClick={() => enter(address)}>
                    <LogIn className='size-4' />
                    <Trans>Connect</Trans>
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      </MenuDialog>
    )
  }
  return (
    // The page OWNS the viewport height: a full-height flex column whose two
    // columns fill it, each scrolling its own overflow. Previously the page
    // scrolled as one block and both columns were content-height, so a server
    // with a handful of matches drew everything squashed against the top with
    // the rest of the screen empty — and the chat, which asks for h-full, had
    // no height to fill.
    <div className='bg-background fixed inset-0 z-50 flex flex-col p-6'>
      <div className='mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col gap-6 lg:flex-row'>
        <div className='flex min-h-0 min-w-0 flex-1 flex-col'>
          <div className='mb-4 flex items-center justify-between'>
            <div>
              <h2 className='text-2xl font-semibold tracking-tight'>{world || <Trans>Matches</Trans>}</h2>
              <p className='text-muted-foreground font-mono text-xs'>{config.world}</p>
            </div>
            <Button type='button' variant='outline' onClick={leave}>
              <X className='size-4' />
              <Trans>Leave server</Trans>
            </Button>
          </div>
          <Multiplayer
            rules={config.rules}
            onRules={(rules) => set('rules', rules)}
            stores={config.stores}
            hideServer
            pilot={pilot}
            server={config.world}
            callsign={config.callsign}
            onServer={(v) => set('world', v)}
            onCallsign={(v) => set('callsign', v)}
            onJoin={onJoin}
          />
        </div>
        <div className='flex min-h-0 w-full flex-col max-lg:h-96 lg:w-80'>
          <LobbyChat server={config.world} callsign={config.callsign} />
        </div>
      </div>
    </div>
  )
}

// ---- panels: each former tab body, now mounted inside its dialog ----

function MissionPanel({
  config,
  set,
  setCheat,
  onChange,
}: {
  config: MissionConfig
  set: <K extends keyof MissionConfig>(key: K, value: MissionConfig[K]) => void
  setCheat: (name: string, value: boolean) => void
  onChange: (config: MissionConfig) => void
}) {
  // The Cheats section is folded unless a cheat is actually set. Opening is
  // one-way on purpose: an EFFECT rather than a useState initialiser, so a
  // config that resolves after mount still opens it, and nothing ever closes it
  // for the player — switching the last cheat off would otherwise collapse the
  // section out from under the cursor mid-click.
  const anyCheat = Object.values(config.cheats ?? {}).some(Boolean)
  const [cheatsOpen, setCheatsOpen] = useState(anyCheat)
  useEffect(() => {
    if (anyCheat) setCheatsOpen(true)
  }, [anyCheat])
  return (
    <div className='sm:grid sm:grid-cols-2 sm:gap-x-10'>
    <div>
<SectionLabel>
  <Trans>Mission</Trans>
</SectionLabel>
<Segmented
  value={config.task}
  onChange={(v) => set('task', v)}
  options={[
    { value: 'free', label: <Trans>Free flight</Trans> },
    { value: 'joust', label: <Trans>Joust against bot</Trans> },
  ]}
/>
{config.task === 'joust' && (
  <>
    <SectionLabel>
      <Trans>Start</Trans>
    </SectionLabel>
    <Picker
      value={config.duel === 'bvr' ? 'bvr' : 'merge'}
      onChange={(v) => set('duel', v as 'merge' | 'bvr')}
      options={[
        { value: 'merge', label: <Trans>Merge, fight's on at the pass</Trans> },
        { value: 'bvr', label: <Trans>BVR, fight's on at start</Trans> },
      ]}
    />
    <SectionLabel>
      <Trans>Bandit</Trans>
    </SectionLabel>
    <Picker
      value={String(config.bandit || 'pilot') as 'novice' | 'pilot' | 'ace' | 'superhuman'}
      onChange={(v) => set('bandit', v)}
      options={[
        { value: 'novice', label: <Trans>Novice</Trans> },
        { value: 'pilot', label: <Trans>Pilot</Trans> },
        { value: 'ace', label: <Trans>Ace</Trans> },
        { value: 'superhuman', label: <Trans>Superhuman</Trans> },
      ]}
    />
  </>
)}

{config.task === 'free' && (
  <>
    {/* joust always starts at the symmetric merge, so the start choice applies to free flight only */}
    <SectionLabel>
      <Trans>Start</Trans>
    </SectionLabel>
    <Picker
      value={config.start === 'landing' ? 'case2' : config.start}
      onChange={(v) => {
        // A recovery case IS a weather definition — and a fuel state:
        // picking one seeds the authentic conditions and the arrival gas
        // (seedStart), visibly and freely overridable. One onChange with
        // every seeded field: consecutive set() calls each spread the
        // RENDER's config, so the last would revert the start (the same
        // React-batch clobber the cheats ref works around).
        onChange(seedStart(config, v as MissionConfig['start']))
      }}
      options={[
        { value: 'air', label: <Trans>In air</Trans> },
        { value: 'runway', label: <Trans>On runway</Trans> },
        { value: 'carrier', label: <Trans>On carrier</Trans> },
        { value: 'case1', label: <Trans>Case I (day)</Trans> },
        { value: 'case2', label: <Trans>Case II (weather)</Trans> },
        { value: 'case3', label: <Trans>Case III (night)</Trans> },
      ]}
    />
    {config.start === 'carrier' && (
      <>
        <SectionLabel>
          <Trans>Catapult</Trans>
        </SectionLabel>
        <Segmented
          value={String(config.cat)}
          onChange={(v) => set('cat', parseInt(v, 10))}
          options={[
            { value: '1', label: '1' },
            { value: '2', label: '2' },
            { value: '3', label: '3' },
            { value: '4', label: '4' },
          ]}
        />
      </>
    )}
  </>
)}
{/* The recovery cases SEED the weather (seedStart: Case I day/clear, Case II
    day/mid stratus, Case III night/low stratus) and the fuel that fits them.
    Restating both as peer controls made the panel echo the choice just made,
    which is most of what crowded it. They live behind a disclosure instead —
    still one click from any override, and the summary says what is set so
    nothing is hidden, only folded. */}
<SectionLabel>
  <Trans>Time of day</Trans>
</SectionLabel>
<Picker
  value={config.tod}
  onChange={(v) => set('tod', v)}
  options={[
    { value: 'day', label: <Trans>Day</Trans> },
    { value: 'night', label: <Trans>Night</Trans> },
  ]}
/>
<SectionLabel>
  <Trans>Clouds</Trans>
</SectionLabel>
<Picker
  value={config.clouds}
  onChange={(v) => set('clouds', v)}
  options={[
    { value: 'none', label: <Trans>None</Trans> },
    { value: 'cumulus', label: <Trans>Cumulus</Trans> },
    { value: 'high_stratus', label: <Trans>High stratus</Trans> },
    { value: 'mid_stratus', label: <Trans>Mid stratus</Trans> },
    { value: 'low_stratus', label: <Trans>Low stratus</Trans> },
  ]}
/>
{/* a MATCH takes its cheats from the creator's rules instead — these are the mission's */}
{/* Folded away when every cheat is off, which is the normal state: an honest
    mission should not devote three rows to switches nobody has touched. It
    opens itself if any cheat IS set — including one that arrives late with the
    loaded config — and once open it stays where the player left it, so turning
    the last one off does not snap the section shut under the cursor. */}
<Collapsible open={cheatsOpen} onOpenChange={setCheatsOpen}>
  <CollapsibleTrigger className='text-muted-foreground hover:text-foreground mt-4 mb-2 flex w-full items-center gap-1.5 text-xs font-medium tracking-wide uppercase'>
    <ChevronRight className={`size-4 transition-transform ${cheatsOpen ? 'rotate-90' : ''}`} />
    <Trans>Cheats</Trans>
  </CollapsibleTrigger>
  <CollapsibleContent>
<div className='space-y-2'>
  <SwitchRow
    id='cheat-invulnerable'
    label={config.task === 'free' ? <Trans>Invulnerable</Trans> : <Trans>Invulnerable (human players only)</Trans>}
    checked={!!(config.cheats ?? {}).invulnerable}
    onChange={(v) => setCheat('invulnerable', v)}
  />
  <SwitchRow
    id='cheat-ammunition'
    label={config.task === 'free' ? <Trans>Unlimited ammunition</Trans> : <Trans>Unlimited ammunition (all players)</Trans>}
    checked={!!(config.cheats ?? {}).ammunition}
    onChange={(v) => setCheat('ammunition', v)}
  />
  <SwitchRow
    id='cheat-fuel'
    label={config.task === 'free' ? <Trans>Unlimited fuel</Trans> : <Trans>Unlimited fuel (all players)</Trans>}
    checked={!!(config.cheats ?? {}).fuel}
    onChange={(v) => setCheat('fuel', v)}
  />
</div>
  </CollapsibleContent>
</Collapsible>
</div>
    <div>
<SectionLabel>
  <Trans>Loadout</Trans>
</SectionLabel>
{/* The loadout (#17) is a rule of the fight, like the opponent's skill.
    Presets are one-tap fills that also SEED the fuel load (freely
    overridable after, like the Start cases seed weather); the strip edits
    per station; the joust derives missiles-allowed from whether any missile
    is loaded. onPreset writes stores AND fuel in ONE config patch — two
    set() calls in a batch clobber each other. */}
<Armament
  stores={config.stores}
  fuel={Number(config.fuel) || 10800}
  allowed={true}
  catapult={config.start === 'carrier'}
  onChange={(v) => set('stores', v)}
  onFuel={(v) => set('fuel', v)}
  onPreset={(stores, fuel) => onChange({ ...config, stores, fuel })}
/>
    </div>
    </div>
  )
}

export function MissionSetup({
  config,
  onChange,
  tab,
  onTabChange,
  onStart,
  onJoin,
}: {
  config: MissionConfig
  onChange: (config: MissionConfig) => void
  tab: string
  onTabChange: (tab: string) => void
  onStart: () => void
  onJoin: (join: Join) => void
}) {
  const set = <K extends keyof MissionConfig>(key: K, value: MissionConfig[K]) =>
    onChange({ ...config, [key]: value })

  // Cheat toggles accumulate through a ref: spreading config.cheats from the
  // render clobbers sibling flags when several switches flip inside one React
  // batch (config only re-renders between batches).
  const cheats = useRef<Record<string, boolean>>({})
  cheats.current = { ...((config.cheats as Record<string, boolean>) ?? {}) }
  const setCheat = (name: string, value: boolean) => {
    cheats.current = { ...cheats.current, [name]: value }
    set('cheats', cheats.current)
  }


  // The menu is a front page plus dialogs (#77): one decision per surface.
  // "Mission" is you against the world — configured, owned, pausable; "match"
  // is you against each other — created, offered, joined, and never paused by
  // one participant. The vocabulary is load-bearing, not decorative.
  const [dialog, setDialog] = useState<string | null>(null)
  const { t } = useLingui()
  // Graphics warnings (#55): one banner, three diagnoses, one visible at a
  // time — each names its culprit so the player knows whether to change
  // browser, flip an acceleration setting, or change machine. The capability
  // verdicts are probed here at mount; the performance one is written by the
  // engine's frame-time governor after a sustained pinned-at-the-floor
  // flight, per DEVICE (shell storage, never the cross-device config).
  const [verdict] = useState(() => diagnose())
  const [strained] = useShellStorage('air.performance', 0)
  const [dismissed, setDismissed] = useShellStorage('air.graphics', '')
  const alert = verdict ?? (strained ? 'performance' : null)
  const close = () => setDialog(null)
  // The label must describe what Fly actually does: a joust ignores the start
  // selector entirely (the engine spawns both jets at the merge), so showing
  // the start read as a deck start that then began airborne.
  // Composed from msgids the bandit selector and task label already carry, so
  // every locale is covered with no new translation surface.
  const BANDITS: Record<string, ReactNode> = {
    novice: <Trans>Novice</Trans>,
    pilot: <Trans>Pilot</Trans>,
    ace: <Trans>Ace</Trans>,
    superhuman: <Trans>Superhuman</Trans>,
  }
  const started =
    config.task === 'joust' ? (
      <>
        <Trans>Joust</Trans> · {BANDITS[String(config.bandit || 'pilot')] ?? BANDITS.pilot}
        {config.duel === 'bvr' ? ' · BVR' : ''}
      </>
    ) : (
      STARTS[config.start === 'landing' ? 'case2' : config.start]
    )

  return (
    <div className='bg-background fixed inset-0 z-50 flex items-center justify-center overflow-auto p-6'>
      <div className='w-full max-w-md'>
        {/* The app's own mark beside the wordmark — the front page carried a
            bare <h1> and nothing else of the game in it. Inline SVG rather than
            an <img> so it takes the accent directly and costs no request; the
            same path public/images/icon.svg uses for the launcher. */}
        <div className='mb-8 flex items-center gap-3'>
          <svg
            viewBox='0 0 24 24'
            aria-hidden='true'
            className='size-9 shrink-0'
            fill='none'
            stroke='var(--air-accent)'
            strokeWidth={2}
            strokeLinecap='round'
            strokeLinejoin='round'
          >
            <path d='M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z' />
          </svg>
          {/* jsx-text-ok: the game's name, verbatim in every locale */}
          <h1 className='text-4xl font-semibold tracking-tight'>Air</h1>
        </div>
        {alert && dismissed !== alert && (
          <div className='mb-4 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-600'>
            <TriangleAlert className='mt-0.5 size-4 shrink-0' />
            <div className='flex-1'>
              {alert === 'webgl2' ? (
                <Trans>This browser does not support WebGL 2, so the game cannot run — try a different browser.</Trans>
              ) : alert === 'software' ? (
                <Trans>Hardware graphics acceleration is off — check browser settings or graphics drivers.</Trans>
              ) : (
                <Trans>This machine may be too slow for smooth flight.</Trans>
              )}
            </div>
            <Button type='button' variant='ghost' size='icon' className='size-6 shrink-0' aria-label={t`Dismiss`} onClick={() => setDismissed(alert)}>
              <X className='size-4' />
            </Button>
          </div>
        )}
        <div className='flex flex-col gap-2'>
          {/* The front page is only ever reached with no mission running: the
              pause menu owns Resume and Restart now, over the frozen scene. */}
          <Button className='h-12 justify-start text-base' onClick={onStart}>
            <Play className='size-4' />
            {/* The fast path stays one click: fly the mission already configured,
                labelled with it, so tweak-and-fly never grows a detour. */}
            <Trans>Fly</Trans>
            <span className='text-primary-foreground/70 ml-1 text-sm'>{started}</span>
          </Button>
          <Button type='button' variant='outline' className='h-12 justify-start text-base' onClick={() => setDialog('mission')}>
            <Pencil className='size-4' />
            <Trans>Create mission</Trans>
          </Button>
          <Button type='button' variant='outline' className='h-12 justify-start text-base' onClick={() => setDialog('server')}>
            <Users className='size-4' />
            <Trans>Join server</Trans>
          </Button>
          <Button type='button' variant='outline' className='h-12 justify-start text-base' onClick={() => setDialog('settings')}>
            <Settings className='size-4' />
            <Trans>Settings</Trans>
          </Button>
          <Button type='button' variant='outline' className='h-12 justify-start text-base' asChild>
            <Link to='/history' search={(prev) => prev}>
              <History className='size-4' />
              <Trans>History</Trans>
            </Link>
          </Button>
          <div className='mt-2 flex gap-2'>
            <ReferenceDialog />
            <CreditsDialog />
          </div>
        </div>
      </div>

      <MenuDialog open={dialog === 'mission'} onClose={close} title={<Trans>Create mission</Trans>} wide steady>
        <MissionPanel config={config} set={set} setCheat={setCheat} onChange={onChange} />
        {/* The controls above write through live, so closing keeps the changes
            and the front page's Fly launches them. This is the same action
            without the round trip: create the mission and go. */}
        <div className='mt-4 flex justify-end border-t pt-4'>
          <Button
            className='min-w-40'
            onClick={() => {
              close()
              onStart()
            }}
          >
            <Play className='size-4' />
            <Trans>Fly</Trans>
          </Button>
        </div>
      </MenuDialog>


      <SettingsDialog
        open={dialog === 'settings'}
        onClose={close}
        config={config}
        onChange={onChange}
        tab={tab}
        onTabChange={onTabChange}
      />

      <ServerFlow open={dialog === 'server'} onClose={close} config={config} set={set} onChange={onChange} onJoin={onJoin} />
    </div>
  )
}
