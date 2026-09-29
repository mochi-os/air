// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

// The network half is stubbed: each record lands at once, each recording
// upload waits for the test to finish it, so the order saves reach the server
// can be read off.
const calls: string[] = []
const uploads: (() => void)[] = []
vi.mock('./net', () => ({
  record: vi.fn(async (row: { reason: string }) => {
    calls.push(`row ${row.reason}`)
  }),
  recording_store: vi.fn(
    (_session: string, _started: number, text: string) =>
      new Promise<boolean>((done) => {
        calls.push(`upload ${text}`)
        uploads.push(() => {
          calls.push(`stored ${text}`)
          done(true)
        })
      })
  ),
}))
const { due, save, FLYING, PERIOD, SORTIE } = await import('./checkpoint')

const settle = () => new Promise((done) => setTimeout(done, 0))

describe('when a flight saves', () => {
  it('first as it becomes a sortie, then every period', () => {
    expect(due(SORTIE - 0.1, -Infinity)).toBe(false) // an aborted start leaves nothing
    expect(due(SORTIE, -Infinity)).toBe(true)
    expect(due(SORTIE + PERIOD - 0.1, SORTIE)).toBe(false)
    expect(due(SORTIE + PERIOD, SORTIE)).toBe(true)
  })
})

describe('the save queue', () => {
  it('stores the row before its recording, and holds each save until the one before it has finished', async () => {
    calls.length = 0
    const row = { world: 'local', title: '', session: 'local-1', mode: 'joust', team: '', started: 1, ended: 2, reason: FLYING, players: '2', kills: 0, deaths: 0, cheated: 0, grade: '', remarks: '', wire: 0 }
    void save(row, { session: 'local-1', started: 1, text: 'first' })
    void save(null, { session: 'local-1', started: 1, text: 'final' })
    await settle()
    expect(calls).toEqual(['row flying', 'upload first']) // the final waits: the first is still uploading
    uploads.shift()!()
    await settle()
    expect(calls).toEqual(['row flying', 'upload first', 'stored first', 'upload final'])
    uploads.shift()!()
    await settle()
    expect(calls[calls.length - 1]).toBe('stored final')
  })
  it('skips a recording with no session to bind to', async () => {
    calls.length = 0
    await save(null, { session: '', started: 1, text: 'orphan' })
    await save(null, null)
    expect(calls).toEqual([])
  })
})

// engine.ts cannot be imported (WebGL at module scope): its hooks are read
// from its source, and lift cuts one top-level function out of it.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
function lift(name: string): string {
  const start = source.indexOf(`function ${name}(`)
  expect(start, `${name} in engine.ts`).toBeGreaterThan(0)
  const rest = source.slice(start)
  const end = /\n(?=\S)/.exec(rest.slice(1))
  return end ? rest.slice(0, end.index + 1) : rest
}

type Saved = [Record<string, unknown> | null, { session: string; text: string } | null]
function engine(setup: string) {
  return new Function(
    'checkpoint_due',
    `let running=true, playback=false, MULTIPLAYER=false, sim_time=0, mission_zero=0, checkpoint_at=-Infinity, onExit=null;
     const cfg={ task:'joust', cheats:{} }; let own_kills=0, own_deaths=0; const passes=[]; const mission_began=1700;
     let net=null, match_started=0, session_over=false; const join={ server:'world', title:'Match', session:'world-session' }; const remotes=new Map();
     const saves=[], rows=[];
     const checkpoint_save=(row,replay)=>{ saves.push([row,replay]); }, net_record=(row)=>rows.push(row);
     const setTimeout=(f)=>f(), lounge_stop=()=>{};
     const CHECKPOINT_FLYING='flying', CHECKPOINT_SORTIE=5;
     const recording_file=()=>({ session:MULTIPLAYER?'world-session':'local-1700', started:MULTIPLAYER?900:1700, text:'at '+Math.round(sim_time) });
     ${['sortie_row', 'match_row', 'recording_checkpoint', 'exit_match', 'net_finish'].map(lift).join('\n')}
     const fly=(seconds)=>{ for(let k=0;k<seconds*10;k++){ sim_time=Math.round(sim_time*10+1)/10; recording_checkpoint(); } };
     ${setup}`
  )(due) as { saves: Saved[]; rows: Record<string, unknown>[] }
}

describe('the log shows a flight that never finished', () => {
  it('labels the reason a flying row keeps', () => {
    const log = readFileSync(fileURLToPath(new URL('../components/MatchLog.tsx', import.meta.url)), 'utf8')
    expect(log).toContain(`${FLYING}: t\`Unfinished\``)
  })
})

describe('the engine saves a flight as it flies', () => {
  it('saves a sortie flying at 5 s and every minute after, recording and all', () => {
    const { saves } = engine('fly(130); return { saves };')
    expect(saves.map(([row]) => row && row.reason)).toEqual(['flying', 'flying', 'flying'])
    expect(saves.map(([, replay]) => replay && replay.text)).toEqual(['at 5', 'at 65', 'at 125'])
    expect(saves[0][0]).toMatchObject({ world: 'local', session: 'local-1700', started: 1700, mode: 'joust' })
  })
  it('saves nothing while a replay plays, or before a match has started', () => {
    expect(engine('playback=true; fly(70); return { saves };').saves).toEqual([])
    expect(engine(`MULTIPLAYER=true; net={ welcome:{ spawn:{ mode:'furball' } }, teams:new Map(), slot:0, leave:()=>{} };
      fly(70); return { saves };`).saves).toEqual([]) // connected, still in the waiting room: no match to key a row on
  })
  it('saves a match against its world session once it has started', () => {
    const { saves } = engine(`MULTIPLAYER=true; net={ welcome:{ spawn:{ mode:'furball' } }, teams:new Map(), slot:0, leave:()=>{} }; match_started=900;
      fly(10); return { saves };`)
    expect(saves).toHaveLength(1)
    expect(saves[0][0]).toMatchObject({ world: 'world', session: 'world-session', started: 900, reason: 'flying' })
  })
  it('finishes the row with its real reason and queues the last recording behind the checkpoints', () => {
    const { saves, rows } = engine('fly(70); own_kills=1; exit_match(); return { saves, rows };')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ session: 'local-1700', reason: 'victory', kills: 1 })
    expect(saves[saves.length - 1]).toEqual([null, { session: 'local-1700', started: 1700, text: 'at 70' }])
  })
  it('leaves nothing for an aborted start', () => {
    const { saves, rows } = engine('fly(4); exit_match(); return { saves, rows };')
    expect([saves, rows]).toEqual([[], []])
  })
  it('records a match\'s finish on its own row', () => {
    const { rows } = engine(`MULTIPLAYER=true; net={ welcome:{ spawn:{ mode:'furball' } }, teams:new Map(), slot:0, leave:()=>{} }; match_started=900;
      net_finish('left'); return { rows };`)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ world: 'world', session: 'world-session', started: 900, reason: 'left', mode: 'furball' })
  })
  it('starts each mission\'s saves afresh', () => {
    expect(lift('start_mission')).toContain('mission_zero=sim_time; fuel_read=false; checkpoint_at=-Infinity;')
    expect(source).toContain('step_world(dt); radar_step(dt); rwr_step(dt); recording_checkpoint();')
  })
})
