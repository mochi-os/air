// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
// Feedback: a post to the Mochi users forum, made as the player through
// their own forums app, the way the Help app's questions go. The forum is
// checked before the player writes a word; the post goes to moderation, so the
// dialog ends as help's question does: submitted, and a way to the forum.
import { useEffect, useState } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import {
  Alert,
  AlertDescription,
  AlertTitle,
  ConfirmDialog,
  getErrorMessage,
  shellNavigateExternal,
  toast,
  useFormat,
} from '@mochi/web'
import { Button } from '@mochi/web/components/ui/button'
import { Input } from '@mochi/web/components/ui/input'
import { Label } from '@mochi/web/components/ui/label'
import { Textarea } from '@mochi/web/components/ui/textarea'
import {
  ArrowRight,
  CheckCircle,
  CircleAlert,
  Loader2,
  MessageSquare,
} from 'lucide-react'
import { feedback_check, feedback_post } from '../game/net'
import { MenuDialog } from './menu-parts'

// Mirrors LONGEST and SHORTEST in air.star, in bytes as the server counts them:
// .length counts UTF-16 code units.
export const LONGEST = { title: 500, body: 50000 }
export const SHORTEST = 20
const encoder = new TextEncoder()
export const bytes = (text: string) => encoder.encode(text).length

type Forum =
  | { status: 'checking' }
  | { status: 'ready' }
  | { status: 'unavailable'; message: string }

export function FeedbackDialog({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const { t } = useLingui()
  const { formatNumber } = useFormat()
  // The title reads fallback, in the player's language, until they edit it.
  const fallback = t`Mochi Air feedback`
  const [edited, setTitle] = useState<string | null>(null)
  const title = edited ?? fallback
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [redirect, setRedirect] = useState('') // the forum, for Go to forum
  const [discard, setDiscard] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [forum, setForum] = useState<Forum>({ status: 'checking' })

  const length = bytes(body)
  const short = bytes(body.trim()) < SHORTEST
  const long = length > LONGEST.body
  const titled = title.trim() !== '' && bytes(title.trim()) <= LONGEST.title
  const ready =
    forum.status === 'ready' && !sending && !short && !long && titled

  useEffect(() => {
    if (!open || sent) return
    let live = true
    setForum({ status: 'checking' })
    feedback_check()
      .then((result) => {
        if (!live) return
        setForum(
          result.available
            ? { status: 'ready' }
            : {
                status: 'unavailable',
                message: result.message || t`Please try again.`,
              }
        )
      })
      .catch((problem: unknown) => {
        if (live)
          setForum({
            status: 'unavailable',
            message: getErrorMessage(problem, t`Please try again.`),
          })
      })
    return () => {
      live = false
    }
  }, [open, sent, attempt, t])

  // finish closes and forgets the draft, so the next Feedback starts afresh.
  const finish = () => {
    setTitle(null)
    setBody('')
    setSent(false)
    setRedirect('')
    setDiscard(false)
    onClose()
  }
  const close = () => {
    if (sending) return
    if (!sent && (title !== fallback || body !== '')) {
      setDiscard(true)
      return
    }
    finish()
  }
  const send = async () => {
    if (!ready) return
    setSending(true)
    try {
      setRedirect(await feedback_post(title.trim(), body.trim()))
      setSent(true)
    } catch (problem) {
      toast.error(t`Couldn't submit`, {
        description: getErrorMessage(problem, t`Please try again.`),
      })
    } finally {
      setSending(false)
    }
  }

  return (
    <>
      <MenuDialog
        open={open}
        onClose={close}
        title={<Trans>Feedback</Trans>}
        guarded
        footer={
          <div className='flex items-center justify-end gap-2'>
            {sent ? (
              <>
                <Button variant='outline' onClick={finish}>
                  <Trans>Close</Trans>
                </Button>
                {redirect && (
                  <Button onClick={() => shellNavigateExternal(redirect)}>
                    <ArrowRight className='size-4' />
                    <Trans>Go to forum</Trans>
                  </Button>
                )}
              </>
            ) : (
              <>
                <Button variant='outline' onClick={close} disabled={sending}>
                  <Trans>Cancel</Trans>
                </Button>
                <Button onClick={() => void send()} disabled={!ready}>
                  {sending ? (
                    <Loader2 className='size-4 animate-spin' />
                  ) : (
                    <MessageSquare className='size-4' />
                  )}
                  <Trans>Post feedback</Trans>
                </Button>
              </>
            )}
          </div>
        }
      >
        {sent ? (
          <div className='flex flex-col items-center gap-3 py-6 text-center'>
            <CheckCircle className='size-12 text-green-500' />
            <p className='font-medium'>
              <Trans>Submitted successfully</Trans>
            </p>
            <p className='text-muted-foreground text-sm'>
              <Trans>
                Your feedback has been submitted and will appear after
                moderation.
              </Trans>
            </p>
          </div>
        ) : (
          <div className='flex flex-col gap-4'>
            {forum.status === 'checking' && (
              <div className='text-muted-foreground flex items-center gap-2 text-sm'>
                <Loader2 className='size-4 animate-spin' />
                <Trans>Loading...</Trans>
              </div>
            )}
            {forum.status === 'unavailable' && (
              <Alert
                variant='destructive'
                className='border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/20 dark:text-amber-100'
              >
                <CircleAlert className='text-amber-700 dark:text-amber-300' />
                <AlertTitle>
                  <Trans>Couldn't reach the destination yet</Trans>
                </AlertTitle>
                <AlertDescription className='text-amber-800 dark:text-amber-200'>
                  <p>{forum.message}</p>
                  <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    onClick={() => setAttempt((n) => n + 1)}
                  >
                    <Trans>Try again</Trans>
                  </Button>
                </AlertDescription>
              </Alert>
            )}
            <div className='flex flex-col gap-2'>
              <Label htmlFor='feedback-title'>
                <Trans>Title</Trans>
              </Label>
              <Input
                id='feedback-title'
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={sending}
              />
            </div>
            <div className='flex flex-col gap-2'>
              <Label htmlFor='feedback-body'>
                <Trans>Details</Trans>
              </Label>
              <Textarea
                id='feedback-body'
                value={body}
                onChange={(e) => setBody(e.target.value)}
                autoFocus
                rows={10}
                disabled={sending}
              />
              <div className='flex items-center justify-between text-xs'>
                <span className='text-muted-foreground'>
                  {short && body.length > 0 && (
                    <Trans>Add a bit more detail.</Trans>
                  )}
                </span>
                <span
                  className={long ? 'text-destructive' : 'text-muted-foreground'}
                >
                  {formatNumber(length)} / {formatNumber(LONGEST.body)}
                </span>
              </div>
            </div>
          </div>
        )}
      </MenuDialog>
      <ConfirmDialog
        open={discard}
        onOpenChange={setDiscard}
        title={t`Discard draft?`}
        desc={t`Your text will be lost.`}
        cancelBtnText={t`Keep editing`}
        confirmText={t`Discard`}
        destructive
        handleConfirm={finish}
      />
    </>
  )
}
