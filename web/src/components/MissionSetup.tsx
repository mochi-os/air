// Copyright © 2026 Mochi OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { useId, type ReactNode } from 'react'
import { Trans } from '@lingui/react/macro'
import { Play, RotateCcw } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@mochi/web/components/ui/tabs'
import { Button } from '@mochi/web/components/ui/button'
import { Slider } from '@mochi/web/components/ui/slider'
import { Switch } from '@mochi/web/components/ui/switch'
import { Label } from '@mochi/web/components/ui/label'
import { Separator } from '@mochi/web/components/ui/separator'
import { RadioGroup, RadioGroupItem } from '@mochi/web/components/ui/radio-group'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@mochi/web/components/ui/dialog'
import {
  DEFAULT_CONFIG,
  GRAPHICS_PRESETS,
  type GraphicsPreset,
  type MissionConfig,
} from '../lib/config'

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className='text-muted-foreground mt-4 mb-2 text-xs font-medium tracking-wide uppercase first:mt-0'>
      {children}
    </div>
  )
}

function Key({ children }: { children: ReactNode }) {
  return (
    <kbd className='bg-muted text-foreground inline-block rounded border px-1.5 py-0.5 font-mono text-xs leading-none'>
      {children}
    </kbd>
  )
}

// A standard single-select radio group laid out inline.
function Choice<T extends string>({
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
    <RadioGroup
      value={value}
      onValueChange={(v) => onChange(v as T)}
      className='flex flex-wrap gap-x-6 gap-y-2'
    >
      {options.map((o) => {
        const id = `${baseId}-${o.value}`
        return (
          <div key={o.value} className='flex items-center gap-2'>
            <RadioGroupItem value={o.value} id={id} />
            <Label htmlFor={id} className='cursor-pointer font-normal'>
              {o.label}
            </Label>
          </div>
        )
      })}
    </RadioGroup>
  )
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  suffix,
  decimals = 0,
  onChange,
}: {
  label: ReactNode
  value: number
  min: number
  max: number
  step: number
  suffix?: string
  decimals?: number
  onChange: (value: number) => void
}) {
  // i18n-format-ok: technical engine setting (resolution factor, segment count), not a locale-sensitive quantity
  const display = (decimals ? value.toFixed(decimals) : String(value)) + (suffix ?? '')
  return (
    <div className='space-y-1.5'>
      <div className='flex items-center justify-between'>
        <Label className='font-normal'>{label}</Label>
        <span className='text-muted-foreground text-sm tabular-nums'>{display}</span>
      </div>
      <Slider
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(parseFloat(e.currentTarget.value))}
      />
    </div>
  )
}

function SwitchRow({
  id,
  label,
  checked,
  onChange,
}: {
  id: string
  label: ReactNode
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <div className='flex items-center justify-between gap-4'>
      <Label htmlFor={id} className='cursor-pointer font-normal'>
        {label}
      </Label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  )
}

function ControlRow({ action, keys }: { action: ReactNode; keys: ReactNode }) {
  return (
    <div className='flex items-center justify-between gap-4 py-1'>
      <span>{action}</span>
      <span className='flex items-center gap-1 whitespace-nowrap'>{keys}</span>
    </div>
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
          <p>
            <Trans>
              A browser-based multiplayer jet-combat prototype — a shared flight model with
              server-authoritative netcode (work in progress), rendered with Three.js on WebGL2.
            </Trans>
          </p>
          <p className='leading-relaxed'>
            <Trans>
              Aircraft model <b>“Boeing F/A-18E/F Super Hornet”</b> by <b>andertan</b>{' '}
              (Sketchfab), licensed under <b>CC BY 4.0</b>. Modified: rescaled, reoriented nose +X,
              weapons and pylons removed, markings removed, landing gear added, converted to
              metal-rough.
            </Trans>{' '}
            <a
              className='text-primary hover:underline'
              href='https://sketchfab.com/3d-models/boeing-fa-18ef-super-hornet-f71e9fea01e24fea9b1b380161d21d38'
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
              Landing-gear wheels from <b>“F/A-18F Super Hornet Fighter Jet”</b> by{' '}
              <b>Muhamad Mirza Arrafi</b> (Sketchfab), licensed under <b>CC BY 4.0</b>. Modified:
              wheels extracted and mounted on procedural struts.
            </Trans>{' '}
            <a
              className='text-primary hover:underline'
              href='https://sketchfab.com/3d-models/fa-18f-super-hornet-fighter-jet-af08dc9320d14a1094476e0a34bd6750'
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
              Aircraft carrier <b>“Gerald Ford Aircraft Carrier”</b> by <b>Usman Zia (Uxxman)</b>{' '}
              (Sketchfab), licensed under <b>CC BY 4.0</b>. Modified: rescaled, reoriented bow +X,
              sunk to the waterline, texture downscaled.
            </Trans>{' '}
            <a
              className='text-primary hover:underline'
              href='https://sketchfab.com/3d-models/gerald-ford-aircraft-carrier-324120997379466caad30917911bcd8b'
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
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function MissionSetup({
  config,
  onChange,
  tab,
  onTabChange,
  gameInProgress,
  onStart,
  onResume,
  onRestart,
}: {
  config: MissionConfig
  onChange: (config: MissionConfig) => void
  tab: string
  onTabChange: (tab: string) => void
  gameInProgress: boolean
  onStart: () => void
  onResume: () => void
  onRestart: () => void
}) {
  const set = <K extends keyof MissionConfig>(key: K, value: MissionConfig[K]) =>
    onChange({ ...config, [key]: value })

  return (
    <div className='bg-background fixed inset-0 z-50 flex items-center justify-center overflow-auto p-6'>
      <div className='w-full max-w-2xl'>
        <h1 className='mb-6 text-3xl font-semibold tracking-tight'>Furball</h1>
        <div>
          <Tabs variant='underline' value={tab} onValueChange={onTabChange}>
            <TabsList>
              <TabsTrigger value='mission'>
                <Trans>Mission</Trans>
              </TabsTrigger>
              <TabsTrigger value='weather'>
                <Trans>Weather</Trans>
              </TabsTrigger>
              <TabsTrigger value='controls'>
                <Trans>Controls</Trans>
              </TabsTrigger>
              <TabsTrigger value='graphics'>
                <Trans>Graphics</Trans>
              </TabsTrigger>
            </TabsList>

            {/* Fixed-height area so the card doesn't resize when switching tabs */}
            {/* Fixed height so the layout never shifts when switching tabs (Graphics is the tallest). */}
            <div className='h-[30rem] overflow-y-auto pt-4'>
              <TabsContent value='mission'>
                <SectionLabel>
                  <Trans>Task</Trans>
                </SectionLabel>
                <Choice
                  value={config.task}
                  onChange={(v) => set('task', v)}
                  options={[
                    { value: 'free', label: <Trans>Free flight</Trans> },
                    { value: 'joust', label: <Trans>Joust</Trans> },
                  ]}
                />
                <SectionLabel>
                  <Trans>Start</Trans>
                </SectionLabel>
                <Choice
                  value={config.start}
                  onChange={(v) => set('start', v)}
                  options={[
                    { value: 'air', label: <Trans>In air</Trans> },
                    { value: 'runway', label: <Trans>On runway</Trans> },
                    { value: 'carrier', label: <Trans>On carrier</Trans> },
                  ]}
                />
              </TabsContent>

              <TabsContent value='weather'>
                <SectionLabel>
                  <Trans>Time of day</Trans>
                </SectionLabel>
                <Choice
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
                <Choice
                  value={config.clouds}
                  onChange={(v) => set('clouds', v)}
                  options={[
                    { value: 'none', label: <Trans>None</Trans> },
                    { value: 'cumulus', label: <Trans>Cumulus</Trans> },
                    { value: 'high_stratus', label: <Trans>High stratus</Trans> },
                    { value: 'low_stratus', label: <Trans>Low stratus</Trans> },
                  ]}
                />
              </TabsContent>

              <TabsContent value='controls'>
                <SectionLabel>
                  <Trans>Input</Trans>
                </SectionLabel>
                <div className='space-y-4'>
                  <SliderRow
                    label={<Trans>Sensitivity</Trans>}
                    value={config.sens}
                    min={0.4}
                    max={2}
                    step={0.1}
                    decimals={1}
                    suffix='×'
                    onChange={(v) => set('sens', v)}
                  />
                  <SwitchRow
                    id='invert'
                    label={<Trans>Invert pitch</Trans>}
                    checked={config.invert}
                    onChange={(v) => set('invert', v)}
                  />
                </div>
                <Separator className='my-4' />
                <SectionLabel>
                  <Trans>Keys</Trans>
                </SectionLabel>
                <div className='grid gap-x-8 text-sm sm:grid-cols-2'>
                  <ControlRow action={<Trans>Pitch</Trans>} keys={<><Key>W</Key><Key>S</Key></>} />
                  <ControlRow action={<Trans>Roll</Trans>} keys={<><Key>A</Key><Key>D</Key></>} />
                  <ControlRow action={<Trans>Yaw</Trans>} keys={<><Key>Q</Key><Key>E</Key></>} />
                  <ControlRow
                    action={<Trans>Throttle</Trans>}
                    keys={<><Key>Shift</Key><Key>Ctrl</Key></>}
                  />
                  <ControlRow action={<Trans>Launch / guns</Trans>} keys={<Key>Space</Key>} />
                  <ControlRow action={<Trans>Missile</Trans>} keys={<Key>R</Key>} />
                  <ControlRow action={<Trans>Flares</Trans>} keys={<Key>F</Key>} />
                  <ControlRow action={<Trans>Rearm</Trans>} keys={<Key>X</Key>} />
                  <ControlRow action={<Trans>Cycle view</Trans>} keys={<Key>V</Key>} />
                  <ControlRow action={<Trans>Map</Trans>} keys={<Key>M</Key>} />
                  <ControlRow action={<Trans>Pause</Trans>} keys={<Key>P</Key>} />
                  <ControlRow action={<Trans>Return to menu</Trans>} keys={<Key>Esc</Key>} />
                </div>
                <SectionLabel>
                  <Trans>Chase view</Trans>
                </SectionLabel>
                <div className='grid gap-x-8 text-sm sm:grid-cols-2'>
                  <ControlRow
                    action={<Trans>Orbit</Trans>}
                    keys={<><Key>Shift</Key>+<Key>←</Key><Key>→</Key></>}
                  />
                  <ControlRow action={<Trans>Tilt</Trans>} keys={<><Key>,</Key><Key>.</Key></>} />
                  <ControlRow
                    action={<Trans>Distance</Trans>}
                    keys={<><Key>−</Key><Key>=</Key></>}
                  />
                </div>
              </TabsContent>

              <TabsContent value='graphics' className='space-y-4'>
                <div>
                  <SectionLabel>
                    <Trans>Preset</Trans>
                  </SectionLabel>
                  <div className='flex flex-wrap gap-2'>
                    {(['low', 'med', 'high', 'ultra'] as GraphicsPreset[]).map((p) => (
                      <Button
                        key={p}
                        type='button'
                        variant='outline'
                        size='sm'
                        className='min-w-20 flex-1'
                        onClick={() => onChange({ ...config, ...GRAPHICS_PRESETS[p] })}
                      >
                        {p === 'low' ? (
                          <Trans>Low</Trans>
                        ) : p === 'med' ? (
                          <Trans>Medium</Trans>
                        ) : p === 'high' ? (
                          <Trans>High</Trans>
                        ) : (
                          <Trans>Ultra</Trans>
                        )}
                      </Button>
                    ))}
                  </div>
                </div>
                <div className='grid gap-4 sm:grid-cols-2'>
                  <SliderRow
                    label={<Trans>Resolution</Trans>}
                    value={config.render_scale}
                    min={0.4}
                    max={2}
                    step={0.1}
                    decimals={1}
                    suffix='×'
                    onChange={(v) => set('render_scale', v)}
                  />
                  <SliderRow
                    label={<Trans>Exterior detail</Trans>}
                    value={config.exterior_detail}
                    min={1}
                    max={6}
                    step={1}
                    onChange={(v) => set('exterior_detail', v)}
                  />
                  <SliderRow
                    label={<Trans>Ocean detail</Trans>}
                    value={config.ocean_segments}
                    min={64}
                    max={512}
                    step={32}
                    onChange={(v) => set('ocean_segments', v)}
                  />
                  <SliderRow
                    label={<Trans>Extra aircraft</Trans>}
                    value={config.extra_aircraft}
                    min={0}
                    max={40}
                    step={1}
                    onChange={(v) => set('extra_aircraft', v)}
                  />
                </div>
                <Separator />
                <div className='grid gap-3 sm:grid-cols-2'>
                  <SwitchRow
                    id='dyn_res'
                    label={<Trans>Dynamic resolution</Trans>}
                    checked={config.dyn_res}
                    onChange={(v) => set('dyn_res', v)}
                  />
                  <SwitchRow
                    id='lod'
                    label={<Trans>Distance LOD</Trans>}
                    checked={config.lod}
                    onChange={(v) => set('lod', v)}
                  />
                  <SwitchRow
                    id='shadows'
                    label={<Trans>Shadows</Trans>}
                    checked={config.shadows}
                    onChange={(v) => set('shadows', v)}
                  />
                  <SwitchRow
                    id='afterburner'
                    label={<Trans>Afterburner</Trans>}
                    checked={config.afterburner}
                    onChange={(v) => set('afterburner', v)}
                  />
                  <SwitchRow
                    id='tracers'
                    label={<Trans>Tracers</Trans>}
                    checked={config.tracers}
                    onChange={(v) => set('tracers', v)}
                  />
                  <SwitchRow
                    id='missiles'
                    label={<Trans>Missiles</Trans>}
                    checked={config.missiles}
                    onChange={(v) => set('missiles', v)}
                  />
                  <SwitchRow
                    id='flares'
                    label={<Trans>Flares</Trans>}
                    checked={config.flares}
                    onChange={(v) => set('flares', v)}
                  />
                  <SwitchRow
                    id='framerate'
                    label={<Trans>Framerate</Trans>}
                    checked={config.framerate}
                    onChange={(v) => set('framerate', v)}
                  />
                </div>
              </TabsContent>
            </div>
          </Tabs>

          <div className='mt-6 flex items-center justify-between gap-3'>
            <Button
              type='button'
              variant='ghost'
              size='sm'
              className='text-muted-foreground'
              onClick={() => onChange({ ...DEFAULT_CONFIG })}
            >
              <Trans>Reset</Trans>
            </Button>
            {gameInProgress ? (
              <div className='flex gap-2'>
                <Button type='button' variant='outline' onClick={onRestart}>
                  <RotateCcw className='size-4' />
                  <Trans>Restart</Trans>
                </Button>
                <Button className='min-w-32' onClick={onResume}>
                  <Play className='size-4' />
                  <Trans>Resume</Trans>
                </Button>
              </div>
            ) : (
              <Button className='min-w-40' onClick={onStart}>
                <Play className='size-4' />
                <Trans>Start</Trans>
              </Button>
            )}
          </div>
        </div>
        <div className='mt-4 flex justify-center'>
          <CreditsDialog />
        </div>
      </div>
    </div>
  )
}
