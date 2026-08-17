// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The flight log at its own address (/air/history/), declared in app.json the
// same way the root page is. It is a DESTINATION, not an overlay, so it has no
// Close button: Back is how you leave a page.

import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Trans, useLingui } from '@lingui/react/macro'
import { BackButton } from '@mochi/web/components/layout/back-button'
import { MatchHistory } from '../components/MatchHistory'
// From the replay seam, NOT from the engine: importing engine.ts here pulled
// the whole simulator and three.js (1,094 kB) into this page's chunk to read one
// in-memory buffer.
import { recording } from '../game/replay'

function History() {
  const { t } = useLingui()
  const navigate = useNavigate()
  return (
    <div className='bg-background min-h-screen overflow-auto p-6'>
      <div className='mx-auto w-full max-w-5xl'>
        {/* The SHARED back button, not a hand-rolled one: it returns to
            wherever you came from, falls back to the menu on a deep link, and
            knows that history.back() is a silent no-op inside the shell's
            sandboxed iframe. A bespoke Link to '/' had none of that. */}
        <div className='mb-4 flex items-center gap-3'>
          <BackButton label={t`Back`} onFallback={() => void navigate({ to: '/', search: (prev) => prev })} />
          <h2 className='text-2xl font-semibold tracking-tight'>
            <Trans>History</Trans>
          </h2>
        </div>
        <MatchHistory recording={recording} />
      </div>
    </div>
  )
}

export const Route = createFileRoute('/history')({
  component: History,
  validateSearch: (search: Record<string, unknown>) => search,
})
