// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The server's kill event names its cause when there is one worth naming: a
// midair carries cause "midair" and the other jet's slot, and credits nobody.
// The client's handler turns that into the fate the banner and the feed
// read. engine.ts cannot be imported (WebGL at module scope), so the kill case
// is read out of the event switch and run with stand-ins.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
const block = /\n\tcase "kill":[\s\S]*?\n\t\tbreak;/.exec(source)?.[0] ?? ''

interface Call {
  kind: string
  fate: string
  name: string
  victim?: string
}

// Runs the kill case for the event, as the client in slot `me`, with the
// names known; returns the crash and feed calls it made.
function kill(event: Record<string, unknown>, me: number, names: Record<number, string>): Call[] {
  if (!block) throw new Error('kill case not found in engine.ts')
  const run = new Function('e', 'slot', 'net', `const calls=[]; let own_deaths=0, own_kills=0;
    const remotes=new Map(), explosion_at=()=>{}, notice=()=>{}, translate=(t)=>t;
    const crash_ownship=(fate,name)=>calls.push({kind:'crash',fate,name});
    const feed=(fate,name,victim)=>calls.push({kind:'feed',fate,name,victim});
    switch("kill"){ ${block} }
    return calls;`) as (e: Record<string, unknown>, slot: number, net: unknown) => Call[]
  return run(event, Number(event.slot), { slot: me, names: new Map(Object.entries(names).map(([k, v]) => [Number(k), v])) })
}

const names = { 0: 'Alpha', 1: 'Bravo', 2: 'Charlie' }

describe('the kill event on the client', () => {
  it('reads a midair as a collision with the other jet, credited to nobody', () => {
    const calls = kill({ kind: 'kill', slot: 0, by: -1, cause: 'midair', other: 1 }, 0, names)
    expect(calls).toEqual([
      { kind: 'crash', fate: 'midair', name: 'Bravo' },
      { kind: 'feed', fate: 'midair', name: 'Bravo', victim: 'Alpha' },
    ])
  })

  it('reads a credited kill as battle damage by the killer', () => {
    expect(kill({ kind: 'kill', slot: 0, by: 2 }, 0, names)).toEqual([
      { kind: 'crash', fate: 'battle', name: 'Charlie' },
      { kind: 'feed', fate: 'battle', name: 'Charlie', victim: 'Alpha' },
    ])
  })

  it('reads an uncredited kill as battle damage by nobody', () => {
    expect(kill({ kind: 'kill', slot: 0, by: -1 }, 0, names)).toEqual([
      { kind: 'crash', fate: 'battle', name: '' },
      { kind: 'feed', fate: 'battle', name: '', victim: 'Alpha' },
    ])
  })

  it("tells everyone about another jet's midair without crashing this one", () => {
    expect(kill({ kind: 'kill', slot: 2, by: -1, cause: 'midair', other: 1 }, 0, names)).toEqual([
      { kind: 'feed', fate: 'midair', name: 'Bravo', victim: 'Charlie' },
    ])
  })
})
