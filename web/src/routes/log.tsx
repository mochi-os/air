// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
// The flight log at its own address (/air/log/), declared in app.json the
// same way the root page is. It is a DESTINATION, not an overlay, so it has no
// Close button: Back is how you leave a page.
import { lazy, Suspense, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Trans, useLingui } from '@lingui/react/macro'
import {
  cn,
  isInShell,
  LazyBoundary,
  toast,
  useShellImmersive,
} from '@mochi/web'
import { BackButton } from '@mochi/web/components/layout/back-button'
import { MatchLog } from '../components/MatchLog'
// From the replay seam, NOT from the engine: importing engine.ts here pulled
// the whole simulator and three.js (1,094 kB) into this page's chunk to read one
// in-memory buffer.
import { recording } from '../game/replay'
import { useMissionConfig } from '../lib/config-store'

// The game for a replay, fetched only when one is asked for - the same lazy
// chunk the menu flies with.
const GameCanvas = lazy(() =>
  import('../components/GameCanvas').then((m) => ({ default: m.GameCanvas }))
)

function Log() {
  const { t } = useLingui()
  const navigate = useNavigate()
  const [config, setConfig] = useMissionConfig()
  // The recording being watched, over the log: leaving it comes back here.
  const [watched, setWatched] = useState<string | null>(null)
  useShellImmersive(watched !== null)
  const leave = () => {
    setWatched(null)
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {})
  }
  return (
    <>
      {watched !== null && (
        <LazyBoundary
          onFailure={() => {
            leave()
            toast.error(
              t`The game could not be loaded. Reload the page to try again.`
            )
          }}
        >
          <Suspense
            fallback={<div className='fixed inset-0 z-20 bg-[#0a1412]' />}
          >
            <GameCanvas
              config={config}
              replay={watched}
              onExit={leave}
              onConfigChange={setConfig}
              onConfig={(partial) => setConfig({ ...config, ...partial })}
            />
          </Suspense>
        </LazyBoundary>
      )}
      {/* Hidden, not unmounted, while a replay plays: the table painted over
          the game, and its sort and filters are still there on the way back.
          In the shell at desktop widths the menu is painted over the page's
          top-left corner, and a page without a sidebar clears it with the
          start padding the shared layout uses. */}
      <div
        className={cn(
          watched !== null
            ? 'hidden'
            : 'bg-background min-h-screen overflow-auto p-6',
          watched === null && isInShell() && 'md:ps-24'
        )}
      >
        <div className='w-full'>
          {/* The SHARED back button, not a hand-rolled one: it returns to
            wherever you came from, falls back to the menu on a deep link, and
            knows that history.back() is a silent no-op inside the shell's
            sandboxed iframe. A bespoke Link to '/' had none of that. */}
          <div className='mb-4 flex items-center gap-3'>
            <BackButton
              label={t`Back`}
              onFallback={() =>
                void navigate({ to: '/', search: (prev) => prev })
              }
            />
            <h2 className='text-2xl font-semibold tracking-tight'>
              <Trans>Log</Trans>
            </h2>
          </div>
          <MatchLog
            recording={recording}
            onReplay={(text) => {
              // The click that loaded it is still the gesture fullscreen needs.
              document.documentElement.requestFullscreen?.().catch(() => {})
              setWatched(text)
            }}
          />
        </div>
      </div>
    </>
  )
}

export const Route = createFileRoute('/log')({
  component: Log,
  validateSearch: (search: Record<string, unknown>) => search,
})
