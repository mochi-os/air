// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import {
  Check,
  ChevronRight,
  CloudRain,
  Compass,
  Crosshair,
  History,
  LogIn,
  Moon,
  Plane,
  PlaneTakeoff,
  Play,
  Settings,
  Ship,
  Signal,
  SignalHigh,
  SignalLow,
  SignalMedium,
  Sliders,
  Sun,
  TriangleAlert,
  User,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react'
import { Input } from '@mochi/web/components/ui/input'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  getErrorMessage,
  useFormat,
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
import { Badge } from '@mochi/web/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@mochi/web/components/ui/card'
import { Tabs, TabsList, TabsTrigger } from '@mochi/web/components/ui/tabs'
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
import { SliderRow, SwitchRow, MenuDialog } from './menu-parts'
import { CLOUD_ICONS, START_ICONS, TOD_ICONS } from './menu-icons'
import { SettingsDialog } from './SettingsDialog'


const LoadoutPreview = lazy(() =>
  import('./LoadoutPreview').then((m) => ({ default: m.LoadoutPreview }))
)

// Both controls take an optional icon per option. The Select trigger and the
// item row are already laid out as an icon-and-text flex pair upstream, so the
// icon travels into the closed control along with the selection, and a list of
// five near-identical words reads as a picture instead.
interface Choice<T extends string> {
  value: T
  label: ReactNode
  icon?: LucideIcon
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (value: T) => void
  options: Choice<T>[]
}) {
  return (
    <Tabs variant='segmented' value={value} onValueChange={(v) => onChange(v as T)} className='w-full'>
      <TabsList className='w-full flex'>
        {options.map(({ value: v, label, icon: Icon }) => (
          <TabsTrigger key={v} value={v} className='flex-1 gap-1.5 text-xs font-semibold'>
            {Icon && <Icon className='size-3.5' />}
            {label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
}

// The front page tiles. They are Cards rather than <button>s: a button's
// content model has no room for the icon/title/hint block, and wrapping one in
// `display: contents` leaves no box for the focus ring to paint on. So the Card
// carries the button role and answers Enter and Space itself, which is what a
// real button would have given for free — without it the three dialogs behind
// these tiles could not be opened from a keyboard at all. Flight log stays a
// real link (middle-click, open in a new tab); its anchor has no box either, so
// the ring is painted on the Card through the group.
const TILE =
  'hover:border-primary/40 hover:bg-hover flex flex-row items-center gap-3 px-3.5 py-3 text-start transition-all cursor-pointer group outline-none'

function TileFace({ icon: Icon, title, hint }: { icon: LucideIcon; title: ReactNode; hint: ReactNode }) {
  return (
    <>
      <div className='bg-muted text-foreground group-hover:text-primary flex size-8 shrink-0 items-center justify-center rounded-md transition-colors'>
        <Icon className='size-4' />
      </div>
      <div className='flex-1 min-w-0'>
        <div className='text-sm font-semibold truncate'>{title}</div>
        <div className='text-muted-foreground text-[11px] leading-tight line-clamp-1'>{hint}</div>
      </div>
    </>
  )
}

function Tile({
  icon,
  title,
  hint,
  onOpen,
}: {
  icon: LucideIcon
  title: ReactNode
  hint: ReactNode
  onOpen: () => void
}) {
  return (
    <Card
      role='button'
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault() // Space scrolls the page otherwise
        onOpen()
      }}
      className={`${TILE} focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]`}
    >
      <TileFace icon={icon} title={title} hint={hint} />
    </Card>
  )
}

function Picker<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (value: T) => void
  options: Choice<T>[]
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as T)}>
      <SelectTrigger className='w-full'>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map(({ value: v, label, icon: Icon }) => (
          <SelectItem key={v} value={v}>
            {Icon && <Icon />}
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

// Full internal fuel, in pounds: the slider's ceiling, the default, and what
// every stores preset loads.
const FULL_FUEL = 10800

function Armament({
  stores,
  fuel,
  catapult,
  onChange,
  onFuel,
  onPreset,
}: {
  stores: Record<string, StationSlot>
  fuel: number
  catapult: boolean
  onChange: (stores: Record<string, StationSlot>) => void
  onFuel: (fuel: number) => void
  onPreset: (stores: Record<string, StationSlot>, fuel: number) => void
}) {
  // Through the app's formatter, not the browser's: History and the server
  // list already format their numbers on the Mochi locale, and toLocaleString
  // put a second thousands style on the same screen.
  const { formatNumber } = useFormat()
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
        return 'AIM-9M'
      case '9m2':
        return '2× AIM-9M'
      case '120c':
        return 'AIM-120C'
      case '120c2':
        return '2× AIM-120C'
      case 'tank':
        return <Trans>Fuel tank</Trans>
      case 'pylon':
        return <Trans>Empty pylon</Trans>
      case 'twin1':
      case 'twin1b':
        return 'AIM-9M'
      case '120c1':
      case '120c1b':
        return 'AIM-120C'
      case 'mixed':
      case 'mixedb':
        return 'AIM-9M + AIM-120C'
      case 'twin0':
        return <Trans>Empty pylon</Trans>
      default:
        return <Trans>None</Trans>
    }
  }
  const presets: { name: 'gun' | 'fox2' | 'fox3'; title: ReactNode }[] = [
    { name: 'gun', title: <Trans>Gun only</Trans> },
    { name: 'fox2', title: 'Fox 2' },
    { name: 'fox3', title: 'Fox 3' },
  ]
  const w = book ? weight(loadout, book) : { hardware: 0, fuel: 0 }
  const gross = book ? Math.round(((book.empty + w.hardware + w.fuel) * 2.2046 + fuel) / 10) * 10 : 0
  const LAUNCH = 48000
  const moment = book ? Math.round((Math.abs(asymmetry(loadout, book)) * 7.233) / 10) * 10 : 0
  const CATAPULT = 6000
  return (
    <div className='space-y-3.5'>
      <div className='relative overflow-hidden rounded-lg border border-border bg-[#060c0b] p-1.5 shadow-inner'>
        <Suspense fallback={<div className='aspect-[29/10] w-full' />}>
          <LoadoutPreview stores={loadout} />
        </Suspense>
      </div>

      <div className='flex flex-wrap gap-2'>
        {presets.map((entry) => {
          const active = preset === entry.name
          return (
            <Button
              key={entry.name}
              type='button'
              variant={active ? 'default' : 'outline'}
              size='sm'
              className='gap-1.5 text-xs font-semibold flex-1'
              onClick={() => onPreset(structuredClone(PRESETS[entry.name]), FULL_FUEL)}
            >
              {active && <Check className='size-3.5' />}
              {entry.title}
            </Button>
          )
        })}
      </div>

      {(() => {
        const cell = (station: number) => {
          const slot = loadout[String(station)]
          const open = outcomes(station)
          const current = outcome(station, slot)
          const usable = open.filter((o) => !o.hidden || o.id === current)
          const dead = usable.length <= 1
          return (
            <div key={station} className='space-y-1.5 rounded-lg border border-border bg-card p-2'>
              {/* Chip first, on a fixed left rail, so every row starts on the
                  same edge and the name is the part that gives way. Both refuse
                  to wrap: squeezed between them the chip used to break over two
                  lines and the cells lost their common height. */}
              <div className='flex items-center gap-1.5 text-xs'>
                <span className='shrink-0 whitespace-nowrap rounded border border-border bg-muted px-1 font-mono text-[10px] text-muted-foreground'>
                  STA {station}
                </span>
                <span className='truncate font-medium text-card-foreground'>{positions[station]}</span>
              </div>
              {dead ? (
                <div className='text-muted-foreground/60 py-1 text-center font-mono text-xs'>—</div>
              ) : (
                <Select
                  value={current || 'none'}
                  onValueChange={(v) => {
                    const picked = open.find((o) => (o.id || 'none') === v)
                    if (picked) onChange({ ...loadout, [String(station)]: structuredClone(picked.slot) })
                  }}
                >
                  <SelectTrigger size='sm' className='h-7 w-full px-2 text-xs'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {usable.map((o) => (
                      <SelectItem key={o.id || 'none'} value={o.id || 'none'} className='text-xs'>
                        {label(o.id)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          )
        }
        // Two columns, not three. At a third of the panel the name and the
        // dropdown had no room and the middle column was mostly empty space.
        // Symmetric stations pair on one row (9 with 1, 8 with 2, and so on)
        // seen from in front of the aircraft, which is the view the loadout
        // picture above takes, and the centerline runs full width beneath.
        return (
          <div className='space-y-2'>
            <div className='grid grid-cols-2 gap-2'>{[9, 1, 8, 2, 7, 3, 6, 4].map(cell)}</div>
            {cell(5)}
          </div>
        )
      })()}

      <SliderRow
        label={<Trans>Internal fuel</Trans>}
        value={fuel}
        min={1500}
        max={FULL_FUEL}
        step={100}
        decimals={0}
        suffix=' lb'
        onChange={onFuel}
      />

      {book && (
        <div className='space-y-2 rounded-lg border border-border bg-card p-3 text-xs'>
          <div className='flex items-center justify-between'>
            <span className='text-muted-foreground font-medium'>
              <Trans>Gross weight</Trans>
            </span>
            <div className='flex items-center gap-2'>
              <span className='font-bold text-foreground tabular-nums' style={{ fontFamily: 'var(--air-mono)' }}>
                {formatNumber(gross)} lb
              </span>
              {gross > LAUNCH ? (
                <Badge variant='destructive' className='text-[10px]'>
                  <Trans>Heavy</Trans>
                </Badge>
              ) : (
                <Badge variant='outline' className='text-[10px] text-muted-foreground'>
                  <Trans>Nominal</Trans>
                </Badge>
              )}
            </div>
          </div>

          {moment > 0 && (
            <div className='flex items-center justify-between text-muted-foreground'>
              <span>
                <Trans>Lateral asymmetry</Trans>
              </span>
              <span className='font-mono font-medium tabular-nums text-foreground'>{formatNumber(moment)} ft·lb</span>
            </div>
          )}

          {gross > LAUNCH && (
            <div className='flex items-center gap-1.5 pt-1 font-medium text-destructive'>
              <TriangleAlert className='size-4 shrink-0' />
              <Trans>{formatNumber(gross - LAUNCH)} lb over maximum launch weight</Trans>
            </div>
          )}
          {catapult && moment > CATAPULT && (
            <div className='flex items-center gap-1.5 pt-1 font-medium text-destructive'>
              <TriangleAlert className='size-4 shrink-0' />
              <Trans>{formatNumber(moment - CATAPULT)} ft·lb over the catapult asymmetry limit</Trans>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const REFERENCE_ROWS: { id: string; label: ReactNode; cells: [string, string, string] }[] = [
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
        <Button type='button' variant='ghost' size='sm' className='text-muted-foreground hover:text-foreground text-xs gap-1.5 h-7 px-2'>
          <Compass className='size-3.5' />
          <Trans>Reference</Trans>
        </Button>
      </DialogTrigger>
      <DialogContent aria-describedby={undefined} className='sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>
            <Trans>F/A-18C reference</Trans>
          </DialogTitle>
        </DialogHeader>
        <div className='overflow-x-auto'>
          <table className='w-full text-sm'>
            <thead>
              <tr className='text-muted-foreground border-b border-border text-left'>
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
                <tr key={row.id} className='border-b border-border/40 border-dashed last:border-0'>
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
        <Button type='button' variant='ghost' size='sm' className='text-muted-foreground hover:text-foreground text-xs gap-1.5 h-7 px-2'>
          <Trans>Credits</Trans>
        </Button>
      </DialogTrigger>
      <DialogContent aria-describedby={undefined}>
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
              Sketchfab
            </a>{' '}
            ·{' '}
            <a
              className='text-primary hover:underline'
              href='https://creativecommons.org/licenses/by/4.0/'
              target='_blank'
              rel='noopener noreferrer'
            >
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
              Sketchfab
            </a>{' '}
            ·{' '}
            <a
              className='text-primary hover:underline'
              href='https://creativecommons.org/licenses/by/4.0/'
              target='_blank'
              rel='noopener noreferrer'
            >
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
              Sketchfab
            </a>{' '}
            ·{' '}
            <a
              className='text-primary hover:underline'
              href='https://creativecommons.org/licenses/by/4.0/'
              target='_blank'
              rel='noopener noreferrer'
            >
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
              Copernicus
            </a>{' '}
            ·{' '}
            <a
              className='text-primary hover:underline'
              href='https://www.openstreetmap.org/copyright'
              target='_blank'
              rel='noopener noreferrer'
            >
              OpenStreetMap
            </a>{' '}
            ·{' '}
            <a
              className='text-primary hover:underline'
              href='https://coastalscience.noaa.gov/'
              target='_blank'
              rel='noopener noreferrer'
            >
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
              three.js
            </a>
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function LobbyChat({ server, callsign }: { server: string; callsign: string }) {
  const { t } = useLingui()
  const identity = useIdentityName()
  const [lounge, setLounge] = useState<WorldChatLine[]>([])
  const [error, setError] = useState('')
  const [up, setUp] = useState(true)
  const cursor = useRef(0)
  const lineRef = useRef<HTMLInputElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  // Whether the reader is parked on the newest line. Recorded when they SCROLL,
  // never when a line lands: appending to a box that is already at the bottom
  // moves the bottom away from an unchanged scrollTop and fires no scroll
  // event, so the same measurement taken from the effect reads as "scrolled up"
  // on any burst longer than the slack.
  const stuck = useRef(true)
  const address = normalize_server(server || default_server())
  const name = (callsign || identity || t`pilot`).slice(0, 32)

  useEffect(() => {
    cursor.current = 0
    setLounge([])
    stuck.current = true // a different server is a different room: start at its newest line
    let alive = true
    const pull = async () => {
      try {
        const reply = await world_chat(address, cursor.current)
        if (!alive) return
        cursor.current = reply.sequence
        if (reply.lines.length) setLounge((have) => [...have, ...reply.lines].slice(-100))
        setUp(true)
      } catch {
        if (alive) setUp(false)
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
    if (!stuck.current) return // reading back through the room: a new line must not drag the view off it
    const box = boxRef.current
    box?.scrollTo({ top: box.scrollHeight })
  }, [lounge])

  const say = async () => {
    const words = lineRef.current?.value.trim()
    if (!words) return
    if (lineRef.current) lineRef.current.value = ''
    stuck.current = true // saying something is asking to be shown it, wherever the reader had scrolled to
    try {
      await world_say(address, name, words)
      const reply = await world_chat(address, cursor.current)
      cursor.current = reply.sequence
      if (reply.lines.length) setLounge((have) => [...have, ...reply.lines].slice(-100))
      setError('')
      setUp(true)
    } catch (e) {
      setUp(false)
      setError(up ? getErrorMessage(e, t`Could not send the message`) : t`World server not reachable`)
    }
  }

  return (
    <div className='flex h-full flex-col'>
      <div className='text-muted-foreground mb-2 text-xs font-semibold tracking-wider uppercase'>
        <Trans>Server chat</Trans>
      </div>
      <div
        ref={boxRef}
        // A line's worth of slack: a reader a pixel or two off the bottom is
        // still on the newest line, and scrollTop lands fractional at some zoom
        // levels.
        onScroll={(e) => {
          const box = e.currentTarget
          stuck.current = box.scrollHeight - box.scrollTop - box.clientHeight < 24
        }}
        className='flex-1 space-y-0.5 overflow-y-auto rounded-lg border border-border bg-card p-2.5 text-sm'
      >
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
              <span className='text-muted-foreground font-medium'>{line.name}: </span>
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
          <LogIn className='size-4' />
          <Trans>Send</Trans>
        </Button>
      </div>
    </div>
  )
}

// Mounted only while the join dialog is open. useServers polls the public
// listing every 30 seconds and cannot sit above an `if (!open) return null` —
// hooks run either way, so the old shape polled from the moment the front page
// loaded, for a dialog most sessions never open.
function ServerFlow({
  onClose,
  config,
  set,
  onChange,
  onJoin,
}: {
  onClose: () => void
  config: MissionConfig
  set: <K extends keyof MissionConfig>(key: K, value: MissionConfig[K]) => void
  onChange: (config: MissionConfig) => void
  onJoin: (join: Join) => void
}) {
  const [entered, setEntered] = useState(false)
  const [address, setAddress] = useState(config.world || '')
  const { servers, version } = useServers()
  const [private_, setPrivate] = useState(false)
  const [world, setWorld] = useState('')
  useEffect(() => {
    if (!entered) return
    const abort = new AbortController()
    setWorld('')
    world_status(normalize_server(config.world || default_server()), abort.signal)
      .then((s) => setWorld(s.name))
      .catch(() => {})
    return () => abort.abort()
  }, [entered, config.world])

  // Minted once per opening of this dialog, not once per render: called in the
  // render body straight, crypto.randomUUID() handed out a fresh token on every
  // keystroke and every 30-second server poll until enter() wrote one into the
  // config, so the offer token identifying this player was never stable before
  // it was saved.
  const minted = useRef('')
  if (!config.pilot && !minted.current) minted.current = crypto.randomUUID()
  const pilot = config.pilot || minted.current
  const recents = String(config.servers ?? '').split('\n').filter(Boolean)
  const enter = (server: string) => {
    const chosen = server.trim() || default_server()
    const next = { ...config, world: chosen, pilot }
    onChange({ ...next, servers: [chosen, ...recents.filter((r) => r !== chosen)].slice(0, 5).join('\n') })
    setEntered(true)
  }
  const leave = () => {
    void world_withdraw(normalize_server(config.world || default_server()), pilot)
    setEntered(false)
    onClose()
  }
  if (!entered) {
    const matched = (r: string) => (servers ?? []).find((s) => normalize_server(s.address) === normalize_server(r))
    const publics = (servers ?? []).filter((s) => !recents.some((r) => normalize_server(r) === normalize_server(s.address)))
    // servers is null until the first response lands. Without a state of its
    // own that showed the private-server card alone, which reads as "there are
    // no public servers" — the answer this dialog does not have yet.
    const listing = servers === null
    const bare = servers !== null && publics.length === 0 && recents.length === 0
    const entry = private_ || bare
    return (
      <MenuDialog open onClose={onClose} title={<Trans>Join server</Trans>}>
        <div className='space-y-4'>
          {recents.length > 0 && (
            <Card>
              <CardHeader className='pb-2'>
                <CardTitle className='text-sm font-semibold'>
                  <Trans>Recent</Trans>
                </CardTitle>
              </CardHeader>
              <CardContent className='flex flex-col gap-1.5'>
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
              </CardContent>
            </Card>
          )}
          {listing && (
            <Card>
              <CardHeader className='pb-2'>
                <CardTitle className='text-sm font-semibold'>
                  <Trans>Public servers</Trans>
                </CardTitle>
              </CardHeader>
              <CardContent className='space-y-1' aria-busy='true'>
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className='bg-muted h-9 animate-pulse rounded-md'
                    style={{ animationDelay: `${i * 60}ms` }}
                  />
                ))}
              </CardContent>
            </Card>
          )}
          {publics.length > 0 && (
            <Card>
              <CardHeader className='pb-2'>
                <CardTitle className='text-sm font-semibold'>
                  <Trans>Public servers</Trans>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ServerList servers={publics} version={version} onPick={(a) => enter(a)} />
              </CardContent>
            </Card>
          )}
          <Card>
            <CardContent className='p-4 space-y-3'>
              <button
                type='button'
                onClick={() => setPrivate(!private_)}
                className='text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider transition-colors'
              >
                <ChevronRight className={`size-4 transition-transform ${entry ? 'rotate-90' : ''}`} />
                <Trans>Connect to private server</Trans>
              </button>
              {entry && (
                <div className='space-y-2 pt-1'>
                  <Input
                    value={address}
                    placeholder={default_server()}
                    onChange={(e) => setAddress(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && enter(address)}
                  />
                  <div className='flex justify-end'>
                    <Button onClick={() => enter(address)} className='gap-2'>
                      <LogIn className='size-4' />
                      <Trans>Connect</Trans>
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </MenuDialog>
    )
  }
  return (
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
  const anyCheat = Object.values(config.cheats ?? {}).some(Boolean)
  const [cheatsOpen, setCheatsOpen] = useState(anyCheat)
  useEffect(() => {
    if (anyCheat) setCheatsOpen(true)
  }, [anyCheat])

  return (
    <div className='space-y-6 sm:grid sm:grid-cols-2 sm:gap-x-6 sm:space-y-0'>
      <div className='space-y-4'>
        <Card>
          <CardHeader className='pb-3'>
            <CardTitle className='text-sm font-semibold'>
              <Trans>Flight Profile</Trans>
            </CardTitle>
          </CardHeader>
          <CardContent className='space-y-3'>
            <div className='space-y-1.5'>
              <Label className='text-xs text-muted-foreground uppercase font-medium'>
                <Trans>Task</Trans>
              </Label>
              <Segmented
                value={config.task}
                onChange={(v) => set('task', v)}
                options={[
                  { value: 'free', label: <Trans>Free flight</Trans>, icon: Plane },
                  { value: 'joust', label: <Trans>Joust against bot</Trans>, icon: Crosshair },
                ]}
              />
            </div>

            {config.task === 'joust' && (
              <div className='grid grid-cols-2 gap-2.5 pt-1'>
                <div className='space-y-1'>
                  <Label className='text-xs text-muted-foreground uppercase font-medium'>
                    <Trans>Engagement</Trans>
                  </Label>
                  <Picker
                    value={config.duel === 'bvr' ? 'bvr' : 'merge'}
                    onChange={(v) => set('duel', v as 'merge' | 'bvr')}
                    options={[
                      { value: 'merge', label: <Trans>Merge (Pass)</Trans>, icon: START_ICONS.merge },
                      { value: 'bvr', label: <Trans>BVR (Start)</Trans>, icon: START_ICONS.bvr },
                    ]}
                  />
                </div>
                <div className='space-y-1'>
                  <Label className='text-xs text-muted-foreground uppercase font-medium'>
                    <Trans>Bandit</Trans>
                  </Label>
                  <Picker
                    value={String(config.bandit || 'pilot') as 'novice' | 'pilot' | 'ace' | 'superhuman'}
                    onChange={(v) => set('bandit', v)}
                    options={[
                      { value: 'novice', label: <Trans>Novice</Trans>, icon: SignalLow },
                      { value: 'pilot', label: <Trans>Pilot</Trans>, icon: SignalMedium },
                      { value: 'ace', label: <Trans>Ace</Trans>, icon: SignalHigh },
                      { value: 'superhuman', label: <Trans>Superhuman</Trans>, icon: Signal },
                    ]}
                  />
                </div>
              </div>
            )}

            {config.task === 'free' && (
              <div className='space-y-2 pt-1'>
                <div className='space-y-1'>
                  <Label className='text-xs text-muted-foreground uppercase font-medium'>
                    <Trans>Departure / Recovery</Trans>
                  </Label>
                  <Picker
                    value={config.start === 'landing' ? 'case2' : config.start}
                    onChange={(v) => {
                      onChange(seedStart(config, v as MissionConfig['start']))
                    }}
                    options={[
                      { value: 'air', label: <Trans>In air</Trans>, icon: Plane },
                      { value: 'runway', label: <Trans>On runway</Trans>, icon: PlaneTakeoff },
                      { value: 'carrier', label: <Trans>On carrier</Trans>, icon: Ship },
                      { value: 'case1', label: <Trans>Case I (day)</Trans>, icon: Sun },
                      { value: 'case2', label: <Trans>Case II (weather)</Trans>, icon: CloudRain },
                      { value: 'case3', label: <Trans>Case III (night)</Trans>, icon: Moon },
                    ]}
                  />
                </div>

                {config.start === 'carrier' && (
                  <div className='space-y-1'>
                    <Label className='text-xs text-muted-foreground uppercase font-medium'>
                      <Trans>Catapult</Trans>
                    </Label>
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
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className='pb-3'>
            <CardTitle className='text-sm font-semibold'>
              <Trans>Environment</Trans>
            </CardTitle>
          </CardHeader>
          <CardContent className='grid grid-cols-2 gap-2.5'>
            <div className='space-y-1'>
              <Label className='text-xs text-muted-foreground uppercase font-medium'>
                <Trans>Time of day</Trans>
              </Label>
              <Picker
                value={config.tod}
                onChange={(v) => set('tod', v)}
                options={[
                  { value: 'day', label: <Trans>Day</Trans>, icon: TOD_ICONS.day },
                  { value: 'night', label: <Trans>Night</Trans>, icon: TOD_ICONS.night },
                ]}
              />
            </div>
            <div className='space-y-1'>
              <Label className='text-xs text-muted-foreground uppercase font-medium'>
                <Trans>Clouds</Trans>
              </Label>
              <Picker
                value={config.clouds}
                onChange={(v) => set('clouds', v)}
                options={[
                  { value: 'none', label: <Trans>None</Trans>, icon: CLOUD_ICONS.none },
                  { value: 'cumulus', label: <Trans>Cumulus</Trans>, icon: CLOUD_ICONS.cumulus },
                  { value: 'high_stratus', label: <Trans>High stratus</Trans>, icon: CLOUD_ICONS.high_stratus },
                  { value: 'mid_stratus', label: <Trans>Mid stratus</Trans>, icon: CLOUD_ICONS.mid_stratus },
                  { value: 'low_stratus', label: <Trans>Low stratus</Trans>, icon: CLOUD_ICONS.low_stratus },
                ]}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className='p-3'>
            <Collapsible open={cheatsOpen} onOpenChange={setCheatsOpen}>
              <CollapsibleTrigger className='text-muted-foreground hover:text-foreground flex w-full items-center justify-between text-xs font-semibold tracking-wider uppercase'>
                <span className='flex items-center gap-1.5'>
                  <ChevronRight className={`size-4 transition-transform ${cheatsOpen ? 'rotate-90' : ''}`} />
                  <Trans>Flight Assists</Trans>
                </span>
                {anyCheat && (
                  <Badge variant='warning' className='text-[10px] py-0 px-1.5'>
                    <Trans>Assists Active</Trans>
                  </Badge>
                )}
              </CollapsibleTrigger>
              <CollapsibleContent className='pt-3 space-y-2'>
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
              </CollapsibleContent>
            </Collapsible>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className='pb-3'>
          <CardTitle className='text-sm font-semibold'>
            <Trans>Armament & Stores</Trans>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Armament
            stores={config.stores}
            fuel={Number(config.fuel) || FULL_FUEL}
            catapult={config.start === 'carrier'}
            onChange={(v) => set('stores', v)}
            onFuel={(v) => set('fuel', v)}
            onPreset={(stores, fuel) => onChange({ ...config, stores, fuel })}
          />
        </CardContent>
      </Card>
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

  const cheats = useRef<Record<string, boolean>>({})
  cheats.current = { ...((config.cheats as Record<string, boolean>) ?? {}) }
  const setCheat = (name: string, value: boolean) => {
    cheats.current = { ...cheats.current, [name]: value }
    set('cheats', cheats.current)
  }

  const [dialog, setDialog] = useState<string | null>(null)
  const { t } = useLingui()
  const [verdict] = useState(() => diagnose())
  const [strained] = useShellStorage('air.performance', 0)
  const [dismissed, setDismissed] = useShellStorage('air.graphics', '')
  const alert = verdict ?? (strained ? 'performance' : null)
  const close = () => setDialog(null)

  const BANDITS: Record<string, ReactNode> = {
    novice: <Trans>Novice</Trans>,
    pilot: <Trans>Pilot</Trans>,
    ace: <Trans>Ace</Trans>,
    superhuman: <Trans>Superhuman</Trans>,
  }
  const STARTS: Record<string, ReactNode> = {
    air: <Trans>In air</Trans>,
    runway: <Trans>On runway</Trans>,
    carrier: <Trans>On carrier</Trans>,
    case1: <Trans>Case I</Trans>,
    case2: <Trans>Case II</Trans>,
    case3: <Trans>Case III</Trans>,
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
    <div className='bg-background fixed inset-0 z-50 overflow-y-auto overflow-x-hidden'>
      <div className='pointer-events-none fixed inset-0 flex items-center justify-center overflow-hidden opacity-[0.12] dark:opacity-[0.15]'>
        <div className='size-[820px] shrink-0 rounded-full border border-dashed border-[var(--air-accent)]' />
        <div className='absolute size-[560px] shrink-0 rounded-full border border-[var(--air-accent)]' />
        <div className='absolute size-[300px] shrink-0 rounded-full border border-dashed border-[var(--air-accent)]' />
        <div className='absolute h-full w-px bg-gradient-to-b from-transparent via-[var(--air-accent)] to-transparent' />
        <div className='absolute h-px w-full bg-gradient-to-r from-transparent via-[var(--air-accent)] to-transparent' />
      </div>

      <div className='flex min-h-full items-center justify-center p-6'>
        <div className='relative z-10 w-full max-w-lg space-y-6'>
          <div className='flex items-center justify-between'>
          <div className='flex items-center gap-3'>
            <div className='flex size-10 items-center justify-center rounded-lg border border-border bg-card shadow-xs'>
              <svg
                viewBox='0 0 24 24'
                aria-hidden='true'
                className='size-6 shrink-0'
                fill='none'
                stroke='var(--air-accent)'
                strokeWidth={2}
                strokeLinecap='round'
                strokeLinejoin='round'
              >
                <path d='M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z' />
              </svg>
            </div>
            <div>
              <h1 className='text-2xl font-bold tracking-tight'>Air</h1>
              <p className='text-muted-foreground text-xs font-medium'>
                <Trans>F/A-18C Strike Fighter</Trans>
              </p>
            </div>
          </div>
          <Badge variant='outline' className='gap-1.5 px-2.5 py-1 font-mono text-xs'>
            <User className='text-muted-foreground size-3' />
            <span>{config.callsign || t`Pilot`}</span>
          </Badge>
        </div>

        {alert && dismissed !== alert && (
          <div className='flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-600'>
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

        <Card
          className='border-primary/40 hover:border-primary transition-all cursor-pointer shadow-sm hover:shadow-md'
          onClick={onStart}
        >
          <CardContent className='p-5 flex items-center justify-between'>
            <div className='space-y-1'>
              <div className='flex items-center gap-2'>
                <Badge variant='default' className='text-[10px] font-bold tracking-wider uppercase'>
                  <Trans>Ready for Sortie</Trans>
                </Badge>
              </div>
              <span className='text-muted-foreground font-mono text-xs'>
                {started}
              </span>
            </div>
            <Button size='lg' className='gap-2 font-bold px-6'>
              <Play className='size-5 fill-current' />
              <Trans>Fly</Trans>
            </Button>
          </CardContent>
        </Card>

        <div className='grid grid-cols-2 gap-3'>
          <Tile icon={Sliders} title={<Trans>Create mission</Trans>} hint={<Trans>Tasks, weather & loadout</Trans>} onOpen={() => setDialog('mission')} />
          <Tile icon={Users} title={<Trans>Join server</Trans>} hint={<Trans>Multiplayer dogfights</Trans>} onOpen={() => setDialog('server')} />
          <Tile icon={Settings} title={<Trans>Settings</Trans>} hint={<Trans>Avionics, HOTAS & audio</Trans>} onOpen={() => setDialog('settings')} />
          <Link to='/history' search={(prev) => prev} className='contents group/tile'>
            <Card className={`${TILE} group-focus-visible/tile:border-ring group-focus-visible/tile:ring-ring/50 group-focus-visible/tile:ring-[3px]`}>
              <TileFace icon={History} title={<Trans>Flight log</Trans>} hint={<Trans>Sortie history & replays</Trans>} />
            </Card>
          </Link>
        </div>

        <div className='text-muted-foreground border-border flex items-center justify-between border-t pt-4 text-xs'>
          <div className='flex items-center gap-2'>
            <ReferenceDialog />
            <span>•</span>
            <CreditsDialog />
          </div>
          <span className='font-mono text-[11px] opacity-60'><Trans>F/A-18C Hornet</Trans></span>
        </div>
      </div>
      </div>

      <MenuDialog
        open={dialog === 'mission'}
        onClose={close}
        title={<Trans>Create mission</Trans>}
        wide
        steady
        footer={
          <div className='flex items-center justify-between'>
            <div className='text-muted-foreground flex items-center gap-2 font-mono text-xs'>
              <span className='size-2 rounded-full' style={{ background: 'var(--air-accent)' }} />
              <span>{started}</span>
            </div>
            <Button
              className='min-w-36 gap-2 font-semibold shadow-sm'
              onClick={() => {
                close()
                onStart()
              }}
            >
              <Play className='size-4 fill-current' />
              <Trans>Fly</Trans>
            </Button>
          </div>
        }
      >
        <MissionPanel config={config} set={set} setCheat={setCheat} onChange={onChange} />
      </MenuDialog>

      <SettingsDialog
        open={dialog === 'settings'}
        onClose={close}
        config={config}
        onChange={onChange}
        tab={tab}
        onTabChange={onTabChange}
      />

      {dialog === 'server' && (
        <ServerFlow onClose={close} config={config} set={set} onChange={onChange} onJoin={onJoin} />
      )}
    </div>
  )
}
