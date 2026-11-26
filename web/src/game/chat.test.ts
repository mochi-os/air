// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { advance, opening, wire } from './chat'

// The prompt's three scopes and the keys that move between them: ` opens
// Team in a teams match and Match otherwise, ` again cycles the two in a
// teams match, Shift+` goes to everyone on the server from anywhere. Team and
// Match ride the match wire; the server line goes to the lobby ring.
describe('the chat prompt scopes', () => {
  it('opens on the team in a teams match and on the match otherwise', () => {
    expect(opening(true)).toBe('team')
    expect(opening(false)).toBe('match')
  })

  it('cycles Team and Match with the chat key in a teams match', () => {
    expect(advance('team', true, false)).toBe('match')
    expect(advance('match', true, false)).toBe('team')
    expect(advance('server', true, false)).toBe('team') // back from the server to the default
  })

  it('has only Match for the chat key outside a teams match', () => {
    expect(advance('match', false, false)).toBe('match')
    expect(advance('server', false, false)).toBe('match')
    expect(advance('team', false, false)).toBe('match')
  })

  it('goes to everyone on the server with the shift chord from anywhere', () => {
    for (const scope of ['team', 'match', 'server'] as const) {
      expect(advance(scope, true, true)).toBe('server')
      expect(advance(scope, false, true)).toBe('server')
    }
  })

  it('carries Team and Match on the match wire and sends the server line to the lobby', () => {
    expect(wire('team')).toBe('team')
    expect(wire('match')).toBe('all')
    expect(wire('server')).toBeNull()
  })
})

describe('the wiring', () => {
  const engine = readFileSync(
    fileURLToPath(new URL('./engine.ts', import.meta.url)),
    'utf8'
  )
  const canvas = readFileSync(
    fileURLToPath(new URL('../components/GameCanvas.tsx', import.meta.url)),
    'utf8'
  )

  it('opens Match or Team on the chat key and Everyone on the server on its shift chord', () => {
    expect(engine).toMatch(
      /function chat_scope\(\)\{ return chat_opening\(net\?\.welcome\?\.spawn\?\.mode==="teams"\); \}/
    )
    expect(engine).toMatch(
      /if\(ch===key_of\("shout"\) && MULTIPLAYER && running && onChat\)\{ e\.preventDefault\(\); onChat\("server"\); \}/
    )
  })

  it('sends a server line to the lobby ring as the pilot, and the match scopes over the wire', () => {
    expect(engine).toMatch(
      /say: \(words\) => \{ if \(MULTIPLAYER && join\) world_say\(join\.server, join\.name, String\(words\)\.slice\(0, 200\)\)\.catch\(\(\) => \{\}\) \},/
    )
    expect(canvas).toMatch(
      /const carried = wire\(chat\)\n\s+if \(carried\) handleRef\.current\?\.chat\(words, carried\)\n\s+else handleRef\.current\?\.say\(words\)/
    )
  })

  it('polls the lobby ring in flight from the match start to its end, printing player lines under EVERYONE', () => {
    expect(engine).toMatch(
      /net=n; match_started=Date\.now\(\); lounge_start\(\);/
    )
    expect(engine).toMatch(
      /function net_finish\(reason\)\{ if\(session_over\) return; session_over=true; lounge_stop\(\);/
    )
    expect(engine).toMatch(
      /comm\("\["\+translate\("EVERYONE"\)\+"\] "\+l\.name\+": "\+l\.text,"#ffe08f"\)/
    )
    expect(engine).toMatch(/lounge=setInterval\(pull,3000\)/)
    expect(canvas).toMatch(/EVERYONE: msg`EVERYONE`,/)
  })

  it('cycles the scope with the chat keys inside the open prompt, and is one bordered element: label, field, X', () => {
    expect(canvas).toMatch(
      /setChat\(\s*advance\(\s*chat,\s*handleRef\.current\.scope\(\) === 'team',\s*chord === handleRef\.current\.key\('shout'\)\s*\)\s*\)/
    )
    expect(canvas).toMatch(
      /<div className='fixed top-56 left-10 z-30 flex items-center rounded border border-white\/30 bg-black\/70 font-mono'>/
    )
    expect(canvas).toMatch(
      /\{chat === 'team' \? \(\s*<Trans>Team<\/Trans>\s*\) : chat === 'match' \? \(\s*<Trans>Match<\/Trans>\s*\) : \(\s*<Trans>Everyone<\/Trans>\s*\)\}/
    )
  })
})

// The lobby ring in flight (#111): its read can take eight seconds against a
// three-second period, so one request is in flight at a time and each answer is
// printed from the last line held on. Two overlapping reads printed the same
// lines twice, and a slow answer arriving after a quick one moved the cursor
// back. Run as text against a stand-in server whose answers arrive when told.
describe('the lobby ring in flight', () => {
  const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
  const block = /\n\/\/ One request is in flight at a time:[\s\S]*?\nfunction lounge_take\(r,cursor\)\{[^\n]*\n[^\n]*\n[^\n]*\n/.exec(source)?.[0] ?? ''
  interface Answer { lines: { sequence: number; name?: string; text?: string; event?: string }[]; sequence: number }
  const rig = () => new Function(`let net={}, session_over=false, tick=null; const join={ server:"w" }, printed=[], asked=[], answers=[];
    const translate=(t)=>t, comm=(t)=>printed.push(t), setInterval=(f)=>{ tick=f; return 1; }, clearInterval=()=>{ tick=null; };
    const world_chat=(server,since)=>{ asked.push(since); return new Promise((resolve,reject)=>answers.push({ resolve, reject })); };
    ${block}
    const settle=async(i,answer)=>{ if(answer) answers[i].resolve(answer); else answers[i].reject(new Error("down")); await new Promise((r)=>setTimeout(r,0)); };
    return { start:lounge_start, stop:lounge_stop, tick:()=>tick&&tick(), settle, printed, asked, take:lounge_take };`)() as {
    start(): void; stop(): void; tick(): void; settle(i: number, answer?: Answer): Promise<void>; printed: string[]; asked: number[]; take(r: Answer, cursor: number): { lines: unknown[]; cursor: number } }
  const line = (sequence: number, text = 'hi' + sequence) => ({ sequence, name: 'BOB', text })

  it('asks again only once the read in flight has answered', async () => {
    expect(block).not.toBe('')
    const r = rig()
    r.start(); r.tick(); r.tick()
    expect(r.asked).toEqual([0]) // the head read still in flight: the ticks skip
    await r.settle(0, { lines: [], sequence: 10 })
    r.tick(); r.tick()
    expect(r.asked).toEqual([0, 10])
    await r.settle(1) // a failed read frees the next tick too
    r.tick()
    expect(r.asked).toEqual([0, 10, 10])
  })

  it('prints each player line once, from the last held on, and never moves the cursor back', async () => {
    const r = rig()
    r.start(); await r.settle(0, { lines: [], sequence: 10 })
    r.tick(); await r.settle(1, { lines: [line(11), line(12), { sequence: 13, event: 'made', name: 'X' }], sequence: 13 })
    r.tick(); await r.settle(2, { lines: [line(12), line(13, 'again'), line(14)], sequence: 14 })
    expect(r.printed).toEqual(['[EVERYONE] BOB: hi11', '[EVERYONE] BOB: hi12', '[EVERYONE] BOB: hi14'])
    expect(r.take({ lines: [line(9)], sequence: 9 }, 14)).toEqual({ lines: [], cursor: 14 }) // an old answer takes nothing and keeps the cursor
  })

  it('drops an answer that arrives after the poll has stopped', async () => {
    const r = rig()
    r.start(); await r.settle(0, { lines: [], sequence: 10 })
    r.tick(); r.stop(); await r.settle(1, { lines: [line(11)], sequence: 11 })
    expect(r.printed).toEqual([])
  })
})
