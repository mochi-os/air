// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'

// The look-at-target key (#243): a press latches the padlock and the head
// follows the target; the next press, a manual look, a view reset, losing the
// target or leaving the first-person views releases it and the head eases
// home. engine.ts cannot be imported (WebGL at module scope), so look_press and
// update_camera's padlock block are lifted as text and run with stand-ins.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
function lift(name: string): string {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`${name} not found in engine.ts`)
  const rest = source.slice(start)
  const end = /\n(?=\S)/.exec(rest.slice(1))
  return end ? rest.slice(0, end.index + 1) : rest
}
const from = source.indexOf('\t// Padlock (#243)'), to = source.indexOf('\tif(cfg.view!=="chase" || map_on){   // HELD zoom keys')
if (from < 0 || to < from) throw new Error('the padlock block not found in update_camera')
const block = source.slice(from, to)
// pit runs a body against the padlock, in the HUD view with the target 45° left of the nose
function pit<T>(body: string): T {
  return new Function('THREE', `const cfg={ view:"hud" }, PIT_REST=0, _look_d=new THREE.Vector3(), notices=[];
    const ownship={ pos:new THREE.Vector3(), fwd:new THREE.Vector3(1,0,0), up:new THREE.Vector3(0,1,0), right:new THREE.Vector3(0,0,1) };
    let padlocked=false, look_home=false, head_az=0, head_el=0, target={ pos:new THREE.Vector3(1000,0,-1000) };
    const look_target=()=>target, notice=(m)=>notices.push(m), translate=(m)=>m;
    ${lift('look_press')}
    const frame=(dt)=>{ ${block} };
    const frames=(n)=>{ for(let i=0;i<n;i++) frame(1/60); };
    ${body}`)(THREE) as T
}

describe('the look-at-target key', () => {
  it('latches the padlock on a press, and the head follows the target with the key up', () => {
    const s = pit<{ latched: boolean; left: number; right: number; notices: string[] }>('look_press(); const latched=padlocked; frames(120); const left=head_az; target.pos.set(1000,0,1000); frames(120); return { latched, left, right:head_az, notices };')
    expect(s.latched).toBe(true)
    expect(s.left).toBeCloseTo(Math.PI / 4, 3)
    expect(s.right).toBeCloseTo(-Math.PI / 4, 3)
    expect(s.notices).toEqual([])
  })
  it('releases on the next press, and the head eases home', () => {
    expect(pit<unknown[]>('look_press(); frames(120); look_press(); const released=!padlocked; frames(120); return [released, head_az, head_el, look_home];')).toEqual([true, 0, 0, false])
  })
  it('latches nothing without a target, and says so', () => {
    expect(pit('target=null; look_press(); frames(10); return { padlocked, notices, az:head_az };')).toEqual({ padlocked: false, notices: ['NO TARGET'], az: 0 })
  })
  it('does nothing outside the first-person views', () => {
    expect(pit('cfg.view="chase"; look_press(); return { padlocked, notices };')).toEqual({ padlocked: false, notices: [] })
  })
  it('lets go when the target is lost, says so, and eases home', () => {
    expect(pit('look_press(); frames(60); target=null; frames(1); const released=!padlocked; frames(180); return { released, notices, az:head_az };')).toEqual({ released: true, notices: ['NO TARGET'], az: 0 })
  })
  it('lets go quietly when the view leaves the first-person views', () => {
    expect(pit('look_press(); frames(60); cfg.view="chase"; frames(1); return { padlocked, notices, home:look_home };')).toEqual({ padlocked: false, notices: [], home: true })
  })
  it('is worked by the key press, which a stick button replays and a replay still answers', () => {
    expect(source).toContain('if(ch===key_of("look.target")) look_press();')
    expect(lift('watching')).toContain('"look.target"')
    expect(source).not.toContain('keys.has(key_of("look.target"))') // no hold is read
  })
  it('is released by a manual look, a mouse drag, a view reset and a respawn', () => {
    expect(source).toMatch(/if\(daz\|\|del\)\{[^\n]*look_home=false; padlocked=false; \}/)
    expect(source).toContain('if(head_drag){ if(press_moved>=6) padlocked=false;') // a click on a switch is not a drag
    expect(lift('view_reset')).toContain('padlocked=false;')
    expect(lift('reset_ownship')).toContain('designated=-1; padlocked=false;')
    expect(source).toContain('net_waiting=false; padlocked=false;') // a match's respawn
  })
})
