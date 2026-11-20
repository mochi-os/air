// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The bottom-left legend is one column read as one thing: the stores counters
// at the bottom and the caution stack packed upward above them. Every step in
// it must be the same, and the step between the two halves is the one that was
// wrong — the cautions began 12 px above GUN where everything else steps 18,
// so the last caution crowded the first counter (#186). engine.ts reaches for
// WebGL at module scope and cannot be imported, so it is read as text, as
// hud-catalogue.test.ts does.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')

const pitch = () => {
  const found = source.match(/const STACK_PITCH=(\d+)/)
  return found ? Number(found[1]) : null
}

// The stores counters, in the order they are drawn: each names its own offset
// from the bottom of the HUD.
const counters = () => {
  const rows: { label: string; offset: number }[] = []
  // The first draw of each counter at the left margin. Matched by line rather
  // than by one regex over the call: GUN reads translate('GUN') and 9M is a
  // bare literal, and 120C shares 9M's row at x=150 so it is not one of these.
  const lines = source.split('\n').filter((line) => line.includes(',40,HH-'))
  for (const label of ['GUN', '9M', 'FLARES', 'CHAFF', 'FUEL']) {
    const line = lines.find((at) => at.includes(`"${label}`) || at.includes(`translate("${label}")`))
    const found = line?.match(/,40,HH-(\d+)\)/)
    if (found) rows.push({ label, offset: Number(found[1]) })
  }
  return rows
}

describe('the bottom-left legend steps evenly', () => {
  it('states its pitch once', () => {
    expect(pitch()).toBeGreaterThan(0)
  })

  it('finds every stores counter', () => {
    expect(counters().map((c) => c.label)).toEqual(['GUN', '9M', 'FLARES', 'CHAFF', 'FUEL'])
  })

  it('steps one pitch between counters', () => {
    const rows = counters()
    const steps = rows.slice(1).map((row, at) => rows[at].offset - row.offset)
    expect(steps).toEqual(steps.map(() => pitch()))
  })

  it('starts the caution stack one pitch above the top counter', () => {
    const top = counters()[0]
    // Written as an expression against the same counter and the same constant,
    // so the two cannot drift apart the way the hard-coded pair did.
    expect(source).toContain(`hud_stack.left=stack_draw(rows,40,HH-${top.offset}-STACK_PITCH)`)
  })
})

// The HUD view's furniture is in the pilot's language and number format: the
// team scores (on the map and in the stack) and the trim row went out as bare
// English with toFixed figures beside translated neighbours.
describe('the score and trim rows', () => {
  const lift = (name: string) => { const start = source.indexOf(`function ${name}(`); if (start < 0) throw new Error(name + ' not found in engine.ts'); const rest = source.slice(start); const end = /\n(?=\S)/.exec(rest.slice(1)); return end ? rest.slice(0, end.index + 1) : rest }
  // A catalogue standing in for a language with its own words and a decimal comma and point grouping.
  const words: Record<string, string> = { 'TRIM {pitch} {roll}': 'TRIMM {pitch} {roll}', NU: 'BO', ND: 'BU', RWD: 'RFU', LWD: 'LFU', 'RED {score}': 'ROT {score}', 'BLUE {score}': 'BLAU {score}' }
  const run = <T,>(body: string, language: Record<string, string> = words) => new Function('language', `const net={ score:{ red:12345, blue:0 } };
    const translate=(t,v)=>(language[t]??t).replace(/\\{(\\w+)\\}/g,(_,n)=>v[n]), figure=(v,d)=>v.toFixed(d).replace('.',',').replace(/\\B(?=(\\d{3})+(?!\\d))/g,'.');
    ${lift('score_text')} ${lift('trim_text')}
    ${body}`)(language) as T

  it('writes the trim in the pilot\'s words and number format, leaving out a part at zero without a gap', () => {
    expect(run('return [trim_text(1.53,0),trim_text(0,-3),trim_text(-2,4.4),trim_text(0,0)];')).toEqual(['TRIMM 1,5BO', 'TRIMM 3LFU', 'TRIMM 2,0BU 4RFU', ''])
    expect(run('return trim_text(1.53,-3);', {})).toBe('TRIM 1,5NU 3LWD') // the English
  })

  it('writes each side\'s score in the pilot\'s words and number format', () => {
    expect(run('return [score_text("red"),score_text("blue")];')).toEqual(['ROT 12.345', 'BLAU 0'])
  })

  it('draws the map\'s scores, the stack\'s and its calibration row through them', () => {
    expect(source).toMatch(/mctx\.fillText\(score_text\("red"\),24,70\);/)
    expect(source).toMatch(/mctx\.fillText\(score_text\("blue"\),24,88\);/)
    expect(source).toMatch(/rows\.push\(\["#5a86ff",score_text\("blue"\)\]\);\n\t+rows\.push\(\["#ff5a48",score_text\("red"\)\]\);/)
    expect(source).toMatch(/rows\.push\(\[AM,translate\("STAB \{cycle\}",\{cycle:figure\(stab_cycle,0\)\}\)\]\)/)
    expect(source).not.toMatch(/"(RED|BLUE|TRIM|STAB) "\+/)
  })
})

// The draws and panel turns that run every frame keep their working in scratch
// made once (#94): every object made there was garbage by the next frame.
describe('the per-frame draws', () => {
  const top = (name: string) => { const start = source.indexOf(`\nfunction ${name}(`); const end = source.slice(start + 1).search(/\n(?=\S)/); return start < 0 ? '' : source.slice(start, start + 1 + end) }
  it('make no vectors, copies, closures or serialised keys of their own', () => {
    for (const name of ['plates_turn', 'centre_turn', 'update_papi', 'glass_rect', 'hud_field', 'hud_edge', 'hud_launch_zone', 'draw_hmd', 'known', 'pointer_draw', 'hints_watch', 'hints_runway']) {
      const body = top(name)
      expect(body, name).not.toBe('')
      expect(body, name).not.toMatch(/new THREE\.|Object\.(entries|values)\(|JSON\.stringify\(|\.filter\(|\.map\(|=>|homeward\(/)
    }
    const hud = top('draw_hud')
    expect(hud.match(/new THREE\.Vector3\(/g)).toEqual(['new THREE.Vector3(']) // the developer's deck probe's alone
    expect(hud).not.toMatch(/const limit=|const heat_shown=\{|round_length\(ownship\.pos\.y\); const t=|muz\.clone\(\)|hud_field\(glass\)\)/)
    expect(hud).toMatch(/const l=round_length\(ownship\.pos\.y\), muz=body_offset\(ownship,6\.0,0\.35,0\.0,_hud_muzzle\);/) // once, not on each of the funnel's eleven passes
  })

  // #201: the projections, the DDI's repeat of the HUD, the pitch ladder, the helmet's marks, the
  // radar picture's link members and the chat log, each into a scratch of its own.
  it('project into scratch and build nothing of their own', () => {
    // a projector, dir_at or hmd_at called with a single argument: a fresh array or vector each time
    const single = /\b(?:proj_dir|proj_point|hmd_at|dir_at)\((?:[^(),]|\([^()]*\))*\)/
    const drawn = (name: string) => top(name).split('\n').filter((line) => !line.includes('DEV_MODE')).join('\n') // a developer probe's own line may allocate
    // dir_at takes its out fifth: four arguments are a fresh vector
    const bare = /\bdir_at\((?:[^(),]|\([^()]*\))*(?:,(?:[^(),]|\([^()]*\))*){3}\)/
    for (const name of ['draw_hud', 'draw_hmd', 'hmd_alignment', 'hmd_mark', 'hud_pitch', 'hud_edge']) {
      expect(drawn(name), name).not.toMatch(single)
      expect(drawn(name), name).not.toMatch(bare)
    }
    for (const name of ['ddi_place', 'ddi_hud', 'hud_pitch', 'hud_edge', 'hmd_toward', 'hmd_mark', 'link_picture16']) {
      const body = top(name)
      expect(body, name).not.toBe('')
      expect(body, name).not.toMatch(/new THREE\.|\.clone\(\)|=>|\.map\(|\[\.\.\.|return \{|return \[|horizon=\[/)
    }
    expect(top('hmd_alignment')).not.toMatch(/ of \[/) // the fine alignment's two crosses, no list built to walk them
    expect(top('draw_hud')).toContain('comms.length=kept;') // the log is compacted in place
    expect(top('draw_hud')).not.toMatch(/comms=comms\.filter\(/)
  })
})
