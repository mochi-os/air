// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// The flight log at its own address (/air/history/), declared in app.json the
// same way the root page is. It is a DESTINATION, not an overlay, so it has no
// Close button: Back is how you leave a page.

import { createFileRoute, Link } from '@tanstack/react-router'
import { Trans } from '@lingui/react/macro'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@mochi/web/components/ui/button'
import { MatchHistory } from '../components/MatchHistory'
import { recording } from '../game/engine'

function History() {
  return (
    <div className='bg-background min-h-screen overflow-auto p-6'>
      <div className='mx-auto w-full max-w-5xl'>
        <div className='mb-4 flex items-center justify-between'>
          <h2 className='text-2xl font-semibold tracking-tight'>
            <Trans>History</Trans>
          </h2>
          <Button asChild type='button' variant='outline'>
            <Link to='/'>
              <ArrowLeft className='size-4' />
              <Trans>Back</Trans>
            </Link>
          </Button>
        </div>
        <MatchHistory recording={recording} />
      </div>
    </div>
  )
}

export const Route = createFileRoute('/history')({ component: History })
