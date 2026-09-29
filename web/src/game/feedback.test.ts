// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

// Feedback: the main menu's post to the Mochi users forum. The server
// half (air.star feedback_check / feedback_post) is driven over real HTTP by
// p2p-test's air-feedback flow; this holds the client half to it.
const posts: [string, unknown][] = []
let reply: unknown = {}
vi.mock('@mochi/web', () => ({
  createAppClient: () => ({
    post: async (url: string, body: unknown) => {
      posts.push([url, body])
      return reply
    },
  }),
}))
vi.mock('../lib/config-store', () => ({ authenticated: async () => {} }))
const { feedback_check, feedback_post } = await import('./net')

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

describe('the feedback calls', () => {
  it('asks whether the forum can take a post, and passes on why not', async () => {
    posts.length = 0
    reply = { data: { available: false, message: 'Forum not found' } }
    expect(await feedback_check()).toEqual({ available: false, message: 'Forum not found' })
    expect(posts).toEqual([['-/feedback/check', {}]])
    reply = { data: { available: true } }
    expect((await feedback_check()).available).toBe(true)
  })
  it('posts the title and the body, and answers where the forum is', async () => {
    posts.length = 0
    reply = { data: { redirect: '/forums/abc123def/' } }
    expect(await feedback_post('Title', 'Body')).toBe('/forums/abc123def/')
    expect(posts).toEqual([['-/feedback/post', { title: 'Title', body: 'Body' }]])
  })
})

describe('the Feedback dialog', () => {
  const dialog = read('../components/Feedback.tsx')
  const server = read('../../../air.star')
  it('holds the post to the server\'s own limits', () => {
    const longest = /^LONGEST = \{"title": (\d+), "body": (\d+)\}/m.exec(server)!
    const shortest = /^SHORTEST = (\d+)/m.exec(server)!
    expect(dialog).toContain(`export const LONGEST = { title: ${longest[1]}, body: ${longest[2]} }`)
    expect(dialog).toContain(`export const SHORTEST = ${shortest[1]}`)
  })
  it('counts bytes as the server does, not UTF-16 units', () => {
    expect(dialog).toContain('export const bytes = (text: string) => encoder.encode(text).length')
    expect(dialog).toMatch(/const short = bytes\(body\.trim\(\)\) < SHORTEST/)
    expect(dialog).toMatch(/const long = length > LONGEST\.body/)
    expect(dialog).toMatch(/const titled = title\.trim\(\) !== '' && bytes\(title\.trim\(\)\) <= LONGEST\.title/)
  })
  it('sends only once the forum answers and the post is within the limits', () => {
    expect(dialog).toMatch(/const ready =\s*forum\.status === 'ready' && !sending && !short && !long && titled/)
    expect(dialog).toMatch(/<Button onClick=\{\(\) => void send\(\)\} disabled=\{!ready\}>/)
  })
  it('ends as help\'s question does: submitted, then Go to forum', () => {
    expect(dialog).toContain('setRedirect(await feedback_post(title.trim(), body.trim()))')
    expect(dialog).toMatch(/\{redirect && \(\s*<Button onClick=\{\(\) => shellNavigateExternal\(redirect\)\}>\s*<ArrowRight className='size-4' \/>\s*<Trans>Go to forum<\/Trans>/)
    expect(dialog).toContain('<Trans>Submitted successfully</Trans>')
  })
  it('is titled Feedback, and only its submit reads Post feedback', () => {
    expect(dialog).toContain('title={<Trans>Feedback</Trans>}')
    expect(dialog).toMatch(/<MessageSquare className='size-4' \/>\s*\)\}\s*<Trans>Post feedback<\/Trans>/)
    expect(dialog.match(/Post feedback/g)).toHaveLength(1)
  })
  it('titles the post Mochi Air feedback until the player edits it, and starts there again', () => {
    expect(dialog).toContain('const fallback = t`Mochi Air feedback`')
    expect(dialog).toContain('const title = edited ?? fallback')
    expect(dialog).toMatch(/onChange=\{\(e\) => setTitle\(e\.target\.value\)\}/)
    expect(dialog).toMatch(/const finish = \(\) => \{\s*setTitle\(null\)/)
  })
  it('puts the cursor in the details, not the title', () => {
    const field = (tag: string) => new RegExp(`<${tag}\\s+id='feedback-\\w+'[\\s\\S]*?/>`).exec(dialog)![0]
    expect(field('Textarea')).toContain('autoFocus')
    expect(field('Input')).not.toContain('autoFocus')
  })
  it('asks before a draft is thrown away, but not an untouched one', () => {
    expect(dialog).toMatch(/if \(!sent && \(title !== fallback \|\| body !== ''\)\) \{\s*setDiscard\(true\)/)
  })
})

describe('the main menu', () => {
  const menu = read('../components/MissionSetup.tsx')
  it('offers Feedback across both columns, shallow, below the four tiles', () => {
    expect(menu).toMatch(/<Tile\s+icon=\{MessageSquare\}\s+title=\{<Trans>Feedback<\/Trans>\}\s+onOpen=\{\(\) => setDialog\('feedback'\)\}\s+className='col-span-2 py-1'\s+\/>/)
    expect(menu.indexOf("setDialog('feedback')")).toBeGreaterThan(menu.indexOf('<Trans>Flight log</Trans>'))
    expect(menu).toContain("<FeedbackDialog open={dialog === 'feedback'} onClose={close} />")
  })
})
