// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
// The model viewer at its own address (/air/models), declared in app.json the
// way the log is. A developer page, English only by decision.
import { lazy, Suspense } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { LazyBoundary } from '@mochi/web'

// Lazy, like the game: three.js stays out of the menu's chunk.
const ModelViewer = lazy(() =>
  import('../components/ModelViewer').then((m) => ({
    default: m.ModelViewer,
  }))
)

function Models() {
  return (
    <LazyBoundary
      fallback={
        <div className='bg-background text-muted-foreground fixed inset-0 flex items-center justify-center text-sm'>
          {/* jsx-text-ok: developer page, English only by decision */}
          The model viewer could not be loaded. Reload the page to try again.
        </div>
      }
    >
      <Suspense fallback={<div className='bg-background fixed inset-0' />}>
        <ModelViewer />
      </Suspense>
    </LazyBoundary>
  )
}

export const Route = createFileRoute('/models')({
  component: Models,
})
