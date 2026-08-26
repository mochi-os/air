// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { useEffect, useState, type ReactNode } from 'react'
import { Slider } from '@mochi/web/components/ui/slider'
import { Switch } from '@mochi/web/components/ui/switch'
import { Input } from '@mochi/web/components/ui/input'
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
  tight,
  onChange,
}: {
  label: ReactNode
  value: number
  min: number
  max: number
  step: number
  suffix?: string
  decimals?: number
  tight?: boolean // trim the vertical padding where the row sits in a dense stack (the armament column)
  onChange: (value: number) => void
}) {
  const display = (decimals ? value.toFixed(decimals) : String(value)) + (suffix ?? '')
  return (
    <div className={tight ? 'space-y-2 px-3 py-1' : 'space-y-2 p-3'}>
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

// A number box that can actually be typed into. Clamping on every keystroke
// rewrote the value mid-entry: in a field with a floor of 1500, the first digit
// of 2000 became 1500, and emptying the box snapped it to a default. The draft
// keeps exactly what was typed and is only committed once it is a number the
// range allows, or on blur / Enter, where it is clamped.
export function NumberField({
  id,
  value,
  min,
  max,
  step,
  className,
  onChange,
}: {
  id?: string
  value: number
  min: number
  max: number
  step?: number
  className?: string
  onChange: (value: number) => void
}) {
  const [draft, setDraft] = useState(String(value))
  // The owner stays the source of truth: whatever it holds after a commit (or
  // after changing the value itself) is what the box shows.
  useEffect(() => setDraft(String(value)), [value])

  const settle = () => {
    const parsed = Number(draft)
    const next = draft.trim() === '' || !Number.isFinite(parsed) ? value : Math.max(min, Math.min(max, parsed))
    setDraft(String(next))
    if (next !== value) onChange(next)
  }

  return (
    <Input
      id={id}
      type='number'
      inputMode='numeric'
      min={min}
      max={max}
      step={step}
      value={draft}
      className={className}
      onChange={(e) => {
        const text = e.target.value
        setDraft(text)
        const parsed = Number(text)
        // Live only while the typed number is already inside the range; a
        // half-typed one waits for blur rather than being rewritten under the
        // cursor.
        if (text.trim() !== '' && Number.isFinite(parsed) && parsed >= min && parsed <= max && parsed !== value)
          onChange(parsed)
      }}
      onBlur={settle}
      onKeyDown={(e) => {
        if (e.key === 'Enter') settle()
      }}
    />
  )
}

export function SwitchRow({
  id,
  label,
  checked,
  tight,
  onChange,
}: {
  id: string
  label: ReactNode
  checked: boolean
  tight?: boolean // trim the vertical padding where the row sits in a dense stack
  onChange: (value: boolean) => void
}) {
  return (
    <div className={tight ? 'flex items-center justify-between gap-4 px-3 py-1' : 'flex items-center justify-between gap-4 p-3'}>
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
  footer,
  children,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  wide?: boolean
  steady?: boolean
  guarded?: boolean
  footer?: ReactNode
  children: ReactNode
}) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        onInteractOutside={guarded ? (e) => e.preventDefault() : undefined}
        className={`${
          wide ? 'sm:max-w-4xl' : 'sm:max-w-2xl'
        }${steady ? ' h-[min(53rem,calc(100svh-2rem))]' : ''}`}
      >
        <DialogHeader className='border-b border-border pb-3'>
          <DialogTitle className='text-lg font-semibold tracking-tight'>
            {title}
          </DialogTitle>
        </DialogHeader>
        <div className='flex min-h-0 flex-1 flex-col overflow-y-auto pt-2'>{children}</div>
        {/* Outside the scroller: a footer holds the dialog's primary action,
            which must never scroll out of reach with the body. */}
        {footer && <div className='border-border border-t pt-2'>{footer}</div>}
      </DialogContent>
    </Dialog>
  )
}
