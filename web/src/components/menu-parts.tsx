// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

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
  const display = (decimals ? value.toFixed(decimals) : String(value)) + (suffix ?? '')
  return (
    <div className='space-y-2 p-3'>
      <div className='flex items-center justify-between text-sm'>
        <Label className='text-card-foreground font-medium'>{label}</Label>
        <span
          className='text-foreground bg-muted rounded border border-border px-1.5 py-0.5 font-mono text-xs font-semibold tabular-nums'
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
    <div className='flex items-center justify-between gap-4 p-3'>
      <Label htmlFor={id} className='text-card-foreground cursor-pointer text-sm font-medium'>
        {label}
      </Label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  )
}

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
  steady?: boolean
  guarded?: boolean
  children: ReactNode
}) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        onInteractOutside={guarded ? (e) => e.preventDefault() : undefined}
        className={`${
          wide ? 'sm:max-w-4xl' : 'sm:max-w-2xl'
        }${steady ? ' h-[min(48rem,calc(100svh-2rem))]' : ''}`}
      >
        <DialogHeader className='border-b border-border pb-3'>
          <DialogTitle className='text-lg font-semibold tracking-tight'>
            {title}
          </DialogTitle>
        </DialogHeader>
        <div className='flex min-h-0 flex-1 flex-col overflow-y-auto pt-2'>{children}</div>
      </DialogContent>
    </Dialog>
  )
}
