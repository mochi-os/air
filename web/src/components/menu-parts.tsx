// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The small pieces every air menu surface is built from. They live here rather
// than in MissionSetup because the Settings dialog moved out of it: the front
// page and the in-flight pause menu now open the SAME settings surface, and
// both sides need these.
import { type ReactNode } from 'react'
import { Slider } from '@mochi/web/components/ui/slider'
import { Switch } from '@mochi/web/components/ui/switch'
import { Label } from '@mochi/web/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@mochi/web/components/ui/dialog'

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className='text-muted-foreground mt-4 mb-2 text-xs font-medium tracking-wide uppercase first:mt-0'>
      {children}
    </div>
  )
}


export function SliderRow({
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
        {/* Instrument readouts are set on the instrument face, not the UI face. */}
        <span
          className='text-muted-foreground text-sm tabular-nums'
          style={{ fontFamily: 'var(--air-mono)' }}
        >
          {display}
        </span>
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


export function SwitchRow({
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


// MenuDialog is the one shell every menu surface opens in: title, scroll, and
// Esc/backdrop dismissal, so each dialog body is just its content.
export function MenuDialog({
  open,
  onClose,
  title,
  wide,
  steady,
  guarded,
  children,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  wide?: boolean
  steady?: boolean // hold one height whatever the options render: the interior scrolls instead of the box breathing as sections expand
  guarded?: boolean // a stray click on the backdrop must not close it: over the game the backdrop IS the flight, and it is the easiest thing in the world to hit
  children: ReactNode
}) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        onInteractOutside={guarded ? (e) => e.preventDefault() : undefined}
        className={`${wide ? 'sm:max-w-4xl' : 'sm:max-w-2xl'}${steady ? ' h-[min(46rem,calc(100svh-2rem))]' : ''}`}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  )
}
