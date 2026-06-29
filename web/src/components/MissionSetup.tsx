// Copyright © 2026 Mochi OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { type ReactNode } from 'react'
import { Trans } from '@lingui/react/macro'
import { Play } from 'lucide-react'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@mochi/web/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@mochi/web/components/ui/tabs'
import { Button } from '@mochi/web/components/ui/button'
import { Slider } from '@mochi/web/components/ui/slider'
import { Switch } from '@mochi/web/components/ui/switch'
import { Label } from '@mochi/web/components/ui/label'
import { Separator } from '@mochi/web/components/ui/separator'
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

// A row of toggle buttons acting as a single-select segmented control.
function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (value: T) => void
  options: { value: T; label: ReactNode }[]
}) {
  return (
    <div className='flex flex-wrap gap-2'>
      {options.map((o) => (
        <Button
          key={o.value}
          type='button'
          size='sm'
          // button-icon-ok: segmented single-select toggle, not a primary action
          variant={value === o.value ? 'default' : 'outline'}
          className='min-w-24 flex-1'
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </Button>
      ))}
    </div>
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

export function MissionSetup({
  config,
  onChange,
  onStart,
}: {
  config: MissionConfig
  onChange: (config: MissionConfig) => void
  onStart: () => void
}) {
  const set = <K extends keyof MissionConfig>(key: K, value: MissionConfig[K]) =>
    onChange({ ...config, [key]: value })

  return (
    <div className='bg-background flex min-h-screen items-center justify-center p-4'>
      <Card className='w-full max-w-2xl'>
        <CardHeader>
          <CardTitle className='text-2xl tracking-tight'>Furball</CardTitle>
          <CardDescription>
            <Trans>Carrier air combat — mission setup</Trans>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue='mission'>
            <TabsList className='grid w-full grid-cols-4'>
              <TabsTrigger value='mission'>
                <Trans>Mission</Trans>
              </TabsTrigger>
              <TabsTrigger value='weather'>
                <Trans>Weather</Trans>
              </TabsTrigger>
              <TabsTrigger value='graphics'>
                <Trans>Graphics</Trans>
              </TabsTrigger>
              <TabsTrigger value='about'>
                <Trans>About</Trans>
              </TabsTrigger>
            </TabsList>

            <TabsContent value='mission' className='mt-4'>
              <SectionLabel>
                <Trans>Task</Trans>
              </SectionLabel>
              <Segmented
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
              <Segmented
                value={config.start}
                onChange={(v) => set('start', v)}
                options={[
                  { value: 'air', label: <Trans>In air</Trans> },
                  { value: 'runway', label: <Trans>On runway</Trans> },
                  { value: 'carrier', label: <Trans>On carrier</Trans> },
                ]}
              />
              <p className='text-muted-foreground mt-4 text-sm leading-relaxed'>
                <Trans>
                  A joust pits you against an evasive bandit. An on-carrier start places you on the
                  bow catapult — press Space to launch.
                </Trans>
              </p>
            </TabsContent>

            <TabsContent value='weather' className='mt-4'>
              <SectionLabel>
                <Trans>Time of day</Trans>
              </SectionLabel>
              <Segmented
                value={config.tod}
                onChange={(v) => set('tod', v)}
                options={[
                  { value: 'day', label: <Trans>Day</Trans> },
                  { value: 'dusk', label: <Trans>Dusk</Trans> },
                  { value: 'night', label: <Trans>Night</Trans> },
                ]}
              />
              <SectionLabel>
                <Trans>Clouds</Trans>
              </SectionLabel>
              <Segmented
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

            <TabsContent value='graphics' className='mt-4 space-y-4'>
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
                  label={<Trans>Sensitivity</Trans>}
                  value={config.sens}
                  min={0.4}
                  max={2}
                  step={0.1}
                  decimals={1}
                  suffix='×'
                  onChange={(v) => set('sens', v)}
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
                  label={<Trans>Fire rate</Trans>}
                  value={config.fire_rate}
                  min={1}
                  max={10}
                  step={1}
                  suffix='×'
                  onChange={(v) => set('fire_rate', v)}
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
                  id='invert'
                  label={<Trans>Invert pitch</Trans>}
                  checked={config.invert}
                  onChange={(v) => set('invert', v)}
                />
              </div>
            </TabsContent>

            <TabsContent value='about' className='text-muted-foreground mt-4 space-y-3 text-sm'>
              <p>
                <Trans>
                  A browser-based multiplayer jet-combat prototype — a shared flight model with
                  server-authoritative netcode (work in progress), rendered with Three.js on WebGL2.
                </Trans>
              </p>
              <SectionLabel>
                <Trans>Model attribution</Trans>
              </SectionLabel>
              <p className='leading-relaxed'>
                <Trans>
                  Aircraft model <b>“Modern Jet Fighter — Low Poly (Game Ready)”</b> by <b>3Dima</b>{' '}
                  (Sketchfab), licensed under <b>CC BY 4.0</b>. Modified: rescaled, reoriented nose
                  +X, texture downscaled.
                </Trans>{' '}
                <a
                  className='text-primary hover:underline'
                  href='https://sketchfab.com/3d-models/modern-jet-fighter-low-poly-game-ready-free-cd2bd715dcd14dc4b47ebaeb2403fb89'
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
                  Aircraft carrier <b>“Gerald Ford Aircraft Carrier”</b> by{' '}
                  <b>Usman Zia (Uxxman)</b> (Sketchfab), licensed under <b>CC BY 4.0</b>. Modified:
                  rescaled, reoriented bow +X, sunk to the waterline, texture downscaled.
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
            </TabsContent>
          </Tabs>

          <div className='mt-6 flex items-center justify-between gap-4'>
            <Button
              type='button'
              variant='ghost'
              size='sm'
              className='text-muted-foreground'
              onClick={() => onChange({ ...DEFAULT_CONFIG })}
            >
              <Trans>Reset</Trans>
            </Button>
            <Button className='min-w-40' onClick={onStart}>
              <Play className='size-4' />
              <Trans>Start mission</Trans>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
