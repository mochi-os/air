// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

// The flight log pages (#57): every recording is kept, so the log reads the
// flights a page at a time, each page asked for after the last row shown.
const gets: [string, unknown][] = []
let reply: unknown = {}
vi.mock('@mochi/web', () => ({
  createAppClient: () => ({
    get: async (url: string, config: unknown) => {
      gets.push([url, config])
      return reply
    },
  }),
}))
vi.mock('../lib/config-store', () => ({ authenticated: async () => {} }))
const { log } = await import('./net')

const row = { id: 'x1', started: 1700 } as Parameters<typeof log>[0]

describe('log', () => {
  it('asks for the first page with no cursor, and says whether more remain', async () => {
    gets.length = 0
    reply = { data: { matches: [{ id: 'a' }], more: true, totals: null } }
    const result = await log()
    expect(gets).toEqual([['-/match/list', { params: {} }]])
    expect(result.more).toBe(true)
    expect(result.matches).toEqual([{ id: 'a' }])
  })
  it('asks for the page after the last row shown, by its start and id', async () => {
    gets.length = 0
    reply = { data: { matches: [] } }
    const result = await log(row)
    expect(gets).toEqual([['-/match/list', { params: { before: '1700', id: 'x1' } }]])
    expect(result.more).toBe(false) // a server that says nothing has no more
  })
})

describe('the Log page', () => {
  const page = readFileSync(fileURLToPath(new URL('../components/MatchLog.tsx', import.meta.url)), 'utf8')
  it('loads the page after the oldest flight loaded, and appends it', () => {
    expect(page).toContain('const last = matches?.[matches.length - 1]')
    expect(page).toContain('log(last)')
    expect(page).toContain('setMatches((rows) => [...(rows ?? []), ...result.matches])')
    expect(page).toContain('setMore(result.more)')
  })
  it('offers the shared Load more while older flights remain, against every flight flown', () => {
    expect(page).toMatch(/<LoadMore\s+hasMore=\{more\}\s+isLoading=\{loading\}\s+onLoadMore=\{older\}\s+totalShown=\{matches\.length\}\s+total=\{flights\}\s+\/>/)
  })
  it('has no Pin: nothing is pruned, so there is nothing to exempt', () => {
    expect(page).not.toMatch(/\bPin\b|recording_pin|pinned/)
  })
})

// Each result a flight can end with reads differently in every language: ru,
// uk and sk once gave "Flown" and "Finished" the same word, so a sortie flown
// and a match ended looked alike. The labels are read from the Log's own table.
describe('the Log\'s results', () => {
  const page = readFileSync(fileURLToPath(new URL('../components/MatchLog.tsx', import.meta.url)), 'utf8')
  const table = /const reasonLabel = [\s\S]*?\n {4}\}/.exec(page)![0]
  const labels = Array.from(table.matchAll(/t`([^`]+)`/g), (m) => m[1])
  const locales = fileURLToPath(new URL('../locales/', import.meta.url))
  it('reads each result differently in every language', () => {
    expect(labels.length).toBeGreaterThan(5) // the table was found
    for (const locale of readdirSync(locales)) {
      const catalogue = readFileSync(`${locales}${locale}/messages.po`, 'utf8')
      const seen = new Map<string, string>()
      for (const label of labels) {
        const text = new RegExp(`\\nmsgid "${label}"\\nmsgstr "((?:[^"\\\\]|\\\\.)*)"`).exec(catalogue)?.[1]
        if (!text) continue // an overlay falls back to its parent
        expect(seen.get(text), `${locale}: "${label}" and "${seen.get(text)}" both read "${text}"`).toBeUndefined()
        seen.set(text, label)
      }
    }
  })
})

