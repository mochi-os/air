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
  const start = menu.indexOf("<div className='bg-background fixed inset-0", menu.indexOf('export function MissionSetup'))
  const page = menu.slice(start, menu.indexOf('<MenuDialog', start)) // what the menu draws, before its dialogs
  it('opens with Fly across both columns, an aircraft on it, and it shows the create flight dialog', () => {
    expect(page).toMatch(/<Tile\s+icon=\{Plane\}\s+title=\{<Trans>Fly<\/Trans>\}\s+onOpen=\{\(\) => setDialog\('mission'\)\}\s+className='col-span-2'\s+\/>/)
    expect(menu).toMatch(/open=\{dialog === 'mission'\}\s+onClose=\{close\}\s+title=\{<Trans>Create flight<\/Trans>\}/)
    expect(menu).not.toContain('Create mission')
  })
  it('never flies from the menu itself: only the create flight dialog starts a flight', () => {
    expect(page).not.toContain('onStart')
    expect(menu.match(/onStart\(\)/g)).toHaveLength(1)
  })
  it('sets Join server and Flight log in the second row, Settings and Feedback in the third', () => {
    const at = (s: string) => page.indexOf(s)
    const order = ["setDialog('mission')", "setDialog('server')", '<Trans>Flight log</Trans>', "setDialog('settings')", "setDialog('feedback')"].map(at)
    for (const i of order) expect(i).toBeGreaterThan(0)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(page.match(/col-span-2/g)).toHaveLength(1) // Fly alone spans the row
    expect(menu).toContain("<FeedbackDialog open={dialog === 'feedback'} onClose={close} />")
  })
  it('asks about flight recordings with a switch left of the dialog\'s Fly, middle aligned, until it is set, allowed unless turned off, and never with a pop-up', () => {
    const route = read('../routes/index.tsx')
    const settings = read('../components/SettingsDialog.tsx')
    // the footer's row: the switch at its start, Fly pushed to its end, their middles level
    expect(menu).toMatch(/footer=\{\s*<div className='flex items-center gap-4'>\s*<SharingSwitch\s+sharing=\{config\.sharing\}\s+onChange=\{\(v\) => set\('sharing', v\)\}\s+\/>\s*<Button\s+className='ms-auto [^']*'\s+onClick=\{\(\) => \{\s*(?:\/\/[^\n]*\n\s*)*if \(config\.sharing === undefined\) set\('sharing', true\)\s*close\(\)\s*onStart\(\)/)
    // so Fly answers it as shown and it is asked on the first flight only
    const component = /function SharingSwitch\([^]*?\n\}\n/.exec(menu)![0]
    // only until it is set, judged once per opening so it stays while flipped
    expect(component).toMatch(/const \[unset\] = useState\(\(\) => sharing === undefined\)\s+if \(!unset\) return null/)
    expect(component).toMatch(/<Switch\s+id='mission-sharing'\s+checked=\{sharing !== false\}\s+onCheckedChange=\{onChange\}\s+\/>\s*<Label\s+htmlFor='mission-sharing'/)
    expect(menu.match(/mission-sharing/g)).toHaveLength(2) // nowhere else in the dialog
    expect(settings).toContain('checked={config.sharing !== false}')
    expect(route).not.toMatch(/SharingDialog|config\.sharing|ResponsiveDialog/)
    expect(route).toMatch(/onStart=\{launch\}/)
  })
  it("draws each button as a compact card, the icon beside its name, and a rule over Reference and Credits", () => {
    const tile = /const TILE =\s+'([^']*)'/.exec(menu)![1].split(' ')
    for (const box of ['bg-surface-1', 'border-border', 'border-[length:var(--card-border-width)]', 'rounded-lg', 'shadow-[var(--card-shadow)]', 'flex-row', 'py-3']) expect(tile).toContain(box)
    expect(menu).toMatch(/function TileFace\([\s\S]*?<span className='[^']*\bsize-8\b[^']*'>\s*<Icon className='size-4' \/>\s*<\/span>\s*<span className='[^']*\btruncate text-sm font-semibold'>/)
    expect(menu).toMatch(/function Tile\([\s\S]*?<button type='button' onClick=\{onOpen\} className=\{cn\(TILE, className\)\}>/)
    expect(page).toMatch(/<Link to='\/log' search=\{\(prev\) => prev\} className=\{TILE\}>/)
    expect(page).toMatch(/<div className='text-muted-foreground border-border flex items-center justify-center gap-2 border-t pt-4 text-xs'>\s+<ReferenceDialog \/>/)
  })
})
