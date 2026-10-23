// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import * as helmet from './helmet'
import * as avionics from './avionics'
import * as navigate from './navigation'

// The cockpit's side of the helmet (#103, #82, NATOPS 2.21): its frame - power,
// alignment, the exits, the IBIT's patterns, HACQ's fall back to VACQ - where it
// believes it looks and draws, the 9M's seeker slaved to it, the HMD format and
// the helmet display. engine.ts cannot be imported (WebGL at module scope), so
// its functions are lifted as text and run around the real helmet and avionics
// modules and a real three.js camera for the pilot's eye.
const source = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8')
function lift(name: string): string {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`${name} not found in engine.ts`)
  const rest = source.slice(start)
  const end = /\n(?=\S)/.exec(rest.slice(1))
  return end ? rest.slice(0, end.index + 1) : rest
}
function line(name: string): string {
  const m = new RegExp(`\\n(?:const|let) ${name}=[^\\n]*\\n`).exec(source)
  if (!m) throw new Error(`${name} not found in engine.ts`)
  return m[0]
}
const D = Math.PI / 180
// The eye at the origin looking down -z, the jet's nose there too; look turns the eye, azimuth + right.
const world = `const D2R=Math.PI/180, HW=1000, HH=800, GR='g', AM='a';
  const devicePixelRatio=1;
  let sim_time=0, glance=0, beat=0.1, presenting=true, ddi_dirty=false, master='nav', designator='right', canopy_gone=false, law_active=false, head_az=0, head_el=0;
  const cfg={ view:'cockpit', tod:'day' }, keys=new Set(), key_of=(a)=>a==='uncage'?'KeyU':a==='sensor.forward'?'Forward':'None';
  let buses={ ac:true }, computers={ one:true, two:true }; const mc=()=>computers;
  const knobs={ hmd:1 }, knob_level=(k)=>knobs[k]??1;
  const RADAR={ auto:false, acm:'bst', stt:null, ls:null }, RADAR_GIMBAL=70*D2R; let hud_shoot=false;
  const nav=navigate.fresh(1); navigate.ready(nav,{ x:0, z:0 });
  const nav_sense=()=>({ dt:0, x:0, z:0, east:0, south:0, tas:0, heading:0, pitch:0, bank:0, airborne:true, brake:false, power:true, radar:false, deck:false, tacan:null });
  const camera=new THREE.PerspectiveCamera(60,HW/HH,0.1,1e7); camera.updateMatrixWorld();
  const look=(az,el=0)=>{ camera.quaternion.setFromEuler(new THREE.Euler(el*D2R,-az*D2R,0,'YXZ')); camera.updateMatrixWorld(); };
  const ownship={ pos:new THREE.Vector3(), fwd:new THREE.Vector3(0,0,-1), right:new THREE.Vector3(1,0,0), up:new THREE.Vector3(0,1,0), canopy:0, msl:2, launching:false, gear:1, group:{ userData:{} } };
  const bit=avionics.fresh(), wrap_axis=(v)=>v;
  let MULTIPLAYER=false, has_enemy=true; const remotes=new Map();
  const bandit={ group:{ visible:true }, pos:new THREE.Vector3(0,0,-2000), fwd:new THREE.Vector3(0,0,-1), reheat:0 };
  const at=(az,el,d)=>new THREE.Vector3(Math.sin(az*D2R)*Math.cos(el*D2R),Math.sin(el*D2R),-Math.cos(az*D2R)*Math.cos(el*D2R)).multiplyScalar(d);`
const defs = [line('hmd'), line('hmd_was'), line('castle'), line('_hmd_q'), line('_hmd_e'), line('_p'), line('seeker_track'), line('amraam_visual'), line('VISUAL')].join('')
const functions = ['helmet_frame', 'hmd_cross', 'hmd_line', 'hmd_at', 'hmd_blanked', 'hmd_seeker', 'hmd_fit', 'hmd_shift', 'hmd_toward', 'hud_fit', 'hud_scale', 'hmd_mark', 'hmd_locator', 'alignment_cross', 'hmd_alignment', 'hmd_pattern', 'draw_hmd', 'ddi_hmd', 'hmd_press', 'ddi_legend', 'proj_dir', 'pip',
  'seeker_reach', 'seeker_toward', 'seeker_look', 'seeker_uncage', 'amraam_field', 'hud_tape', 'designation_line'].map(lift).join('\n')
function pit<T>(body: string): T {
  return new Function('THREE', 'helmet', 'avionics', 'navigate', `${world} ${defs} ${functions}
    const frames=(seconds,dt=0.1)=>{ for(let t=0;t<seconds-1e-9;t+=dt){ sim_time+=dt; glance+=dt; beat=dt; helmet_frame(dt); } };
    const unaligned=()=>{ Object.assign(hmd,helmet.fresh(false,{ azimuth:2*D2R, elevation:-1*D2R, roll:3*D2R },0)); frames(helmet.SBIT+0.1); };
    const deg=(r)=>Math.round(r/D2R*1000)/1000;
    ${body}`)(THREE, helmet, avionics, navigate) as T
}

describe('the helmet each frame', () => {
  it('is powered by its knob and the ac buses, and is ready once its start-up BIT is done', () => {
    expect(pit(`Object.assign(hmd,helmet.fresh(false,{ azimuth:0, elevation:0, roll:0 },0)); knobs.hmd=0; frames(1); const off=hmd.on;
      knobs.hmd=0.4; frames(1); const starting=[hmd.on,helmet.ready(hmd)]; frames(helmet.SBIT); const ready=helmet.ready(hmd);
      buses={ ac:false }; frames(0.1); return [off,starting,ready,hmd.on];`)).toEqual([false, [true, false], true, false])
  })
  it('aligns coarse to where the pilot looks, the cage/uncage switch held a second in a first-person view', () => {
    const s = pit<number[]>(`unaligned(); helmet.press(hmd,20); look(1,-4.5); keys.add('KeyU');
      cfg.view='chase'; frames(2); const outside=hmd.coarse; cfg.view='cockpit';
      frames(0.5); const holding=[hmd.coarse,helmet.message(hmd)]; frames(0.6);
      const o=helmet.offset(hmd), near=(r)=>Math.round(r/D2R*100)/100; return [outside,holding,hmd.coarse,hmd.mode,near(o.azimuth),near(o.elevation),near(o.roll)];`)
    expect(s).toEqual([false, [false, 'ALIGNING'], true, 'fine', -1, 0.5, 3]) // its cross 4° over where the eye looked, the nose 1° left and 0.5° up of that cross: that is the error left, roll untouched
  })
  it('turns ALIGNING to ALIGN FAIL with the canopy up', () => {
    expect(pit(`unaligned(); helmet.press(hmd,20); ownship.canopy=1; keys.add('KeyU'); frames(1.2); return [hmd.coarse,helmet.message(hmd)];`)).toEqual([false, 'ALIGN FAIL'])
  })
  it('ends an alignment on a master mode change, ACM selected or the TDC given to another display (2.21.12.3)', () => {
    const ended = (change: string) => pit<string>(`unaligned(); helmet.press(hmd,20); frames(0.2); ${change}; frames(0.2); return hmd.mode;`)
    expect([ended(''), ended('master="9m"'), ended('RADAR.auto=true'), ended('designator="left"')]).toEqual(['coarse', '', '', ''])
  })
  it('puts up the test patterns once its IBIT passes', () => {
    expect(pit(`avionics.start(bit,['hmd'],{ hmd:'ok' },{ grounded:true, consent:false, test:false }); frames(1); const during=hmd.patterns;
      for(let t=0;t<25;t+=0.1){ avionics.step(bit,{ hmd:'ok' },0.1,false); sim_time+=0.1; helmet_frame(0.1); } return [during,hmd.patterns>0,helmet.pattern(hmd)>=0];`)).toEqual([-1, true, true])
  })
  it('takes HACQ and LACQ back to VACQ when it can no longer slave the radar (2.21.17)', () => {
    for (const mode of ['hacq', 'lacq'])
      expect(pit(`RADAR.auto=true; RADAR.acm='${mode}'; frames(0.1); const kept=RADAR.acm; computers={ one:true, two:false }; frames(0.1); return [kept,RADAR.acm];`)).toEqual([mode, 'vacq'])
  })
  it('turns HACQ to LACQ with the sensor switch held forward 800 ms, and leaves it HACQ released sooner (the DCS guide)', () => {
    const held = (seconds: number) => pit<string>(`RADAR.auto=true; RADAR.acm='hacq'; castle=glance; keys.add('Forward'); frames(${seconds}); keys.delete('Forward'); frames(1); return RADAR.acm+' '+castle;`)
    expect([held(0.5), held(0.9)]).toEqual(['hacq null', 'lacq null'])
  })
  it('gives the TDC back to the displays out of NAV', () => {
    expect(pit(`hmd.priority=true; frames(0.1); const kept=hmd.priority; master='gun'; frames(0.1); return [kept,hmd.priority];`)).toEqual([true, false])
  })
})

describe('where the helmet believes it looks and draws', () => {
  it('reports the eye\'s line of sight turned by its error', () => {
    const s = pit<number[]>(`hmd.error={ azimuth:1*D2R, elevation:0.5*D2R, roll:0 }; const l=hmd_line(); return [l.x,l.y,l.z];`)
    expect(s[0]).toBeCloseTo(Math.sin(D) * Math.cos(0.5 * D), 9)
    expect(s[1]).toBeCloseTo(Math.sin(0.5 * D), 9)
    expect(s[2]).toBeCloseTo(-Math.cos(D) * Math.cos(0.5 * D), 9)
  })
  it('draws a direction off where the eye sees it by its error, turned by the roll it believes', () => {
    const s = pit<number[][]>(`const ppd=(HH/2)/Math.tan(camera.fov/2*D2R)*D2R, ahead=new THREE.Vector3(0,0,-1), aside=at(1,0,1);
      hmd.error={ azimuth:1*D2R, elevation:0, roll:0 }; const a=hmd_at(ahead);
      hmd.error={ azimuth:0, elevation:1*D2R, roll:0 }; const b=hmd_at(ahead);
      hmd.error={ azimuth:0, elevation:0, roll:90*D2R }; const c=hmd_at(aside);
      return [a,b,c].map(([x,y])=>[Math.round((x-HW/2)/ppd*100)/100,Math.round((y-HH/2)/ppd*100)/100]);`)
    expect(s).toEqual([[-1, 0], [0, 1], [0, -1]]) // believing itself 1° right, ahead is drawn 1° left; 1° up, 1° low; rolled right, a point on the right is drawn above
  })
  it('blanks with BLNK while it looks through the HUD, and never while aligning', () => {
    const glass = '{ corners:[[400,300],[600,300],[600,500],[400,500]] }'
    expect(pit(`const g=${glass}, r=[hmd_blanked(g)]; hmd.blank=false; r.push(hmd_blanked(g)); hmd.blank=true; hmd.mode='coarse'; r.push(hmd_blanked(g)); hmd.mode='';
      r.push(hmd_blanked({ corners:[[0,0],[100,0],[100,100],[0,100]] })); cfg.view='hud'; head_az=0.2; r.push(hmd_blanked(null)); head_az=0.5; r.push(hmd_blanked(null)); return r;`))
      .toEqual([true, false, false, false, true, false])
  })
  it('carries the AIM-9\'s symbol while it works and its mission computer gives it the line of sight (2.21.15), blanked through the HUD or not', () => {
    expect(pit(`const r=[hmd_seeker()]; computers={ one:false, two:true }; r.push(hmd_seeker()); computers={ one:true, two:false }; r.push(hmd_seeker());
      computers={ one:true, two:true }; cfg.view='chase'; r.push(hmd_seeker()); cfg.view='hud'; head_az=0; r.push(hmd_blanked(null),hmd_seeker()); cfg.view='cockpit'; knobs.hmd=0; frames(0.1); r.push(hmd_seeker()); return r;`)).toEqual([true, true, false, false, true, true, false])
  })
})

describe('the 9M\'s seeker under the helmet', () => {
  it('without the helmet or the radar, looks along the boresight with its 2.5° field (2.21.17)', () => {
    expect(pit(`knobs.hmd=0; frames(0.1); master='9m'; const r=[]; for(const az of [2,3,20]){ bandit.pos.copy(at(az,0,2000)); const s=seeker_look(null,false); r.push([s.lockon,s.line.z<-0.99]); } return r;`))
      .toEqual([[true, true], [false, true], [false, true]])
  })
  it('slaved, has the jet the pilot looks at off the nose, inside its 2.5° field and the 40° gimbal', () => {
    expect(pit(`master='9m'; const r=[]; for(const [jet,eye] of [[35,35],[35,39],[45,45],[0,20]]){ bandit.pos.copy(at(jet,0,2000)); look(eye); r.push(seeker_look(null,false).lockon); } return r;`))
      .toEqual([true, false, false, false]) // looking past the gimbal the seeker stops at 40°; looking away it does not see the nose
  })
  it('looks at the radar\'s target while the radar holds one, wherever the pilot looks, the helmet on or off (the DCS guide\'s L&S slaving)', () => {
    expect(pit(`master='9m'; RADAR.stt='bandit'; bandit.pos.copy(at(35,0,2000)); look(-20); return seeker_look(bandit,false).lockon;`)).toBe(true)
    expect(pit(`master='9m'; RADAR.stt='bandit'; bandit.pos.copy(at(45,0,2000)); look(45); return seeker_look(bandit,false).lockon;`)).toBe(false) // past the gimbal
    expect(pit(`knobs.hmd=0; frames(0.1); master='9m'; RADAR.stt='bandit'; const r=[]; for(const az of [10,35,45]){ bandit.pos.copy(at(az,0,2000)); r.push(seeker_look(bandit,false).lockon); } return r;`)).toEqual([true, true, false])
  })
  it('stays on the boresight without MC2, which slaves it (2.21.15)', () => {
    expect(pit(`knobs.hmd=0; frames(0.1); computers={ one:true, two:false }; master='9m'; RADAR.stt='bandit'; bandit.pos.copy(at(10,0,2000)); return seeker_look(bandit,false).lockon;`)).toBe(false)
  })
  it('is slaved to the helmet only from the pilot\'s own eyes: in another view, the boresight or the radar', () => {
    expect(pit(`master='9m'; cfg.view='chase'; bandit.pos.copy(at(35,0,2000)); look(35); return seeker_look(null,false).lockon;`)).toBe(false)
    expect(pit(`master='9m'; cfg.view='chase'; RADAR.stt='bandit'; bandit.pos.copy(at(35,0,2000)); return seeker_look(bandit,false).lockon;`)).toBe(true)
  })
  it('uncages to track the jet it has, the helmet off too', () => {
    expect(pit(`knobs.hmd=0; frames(0.1); master='9m'; RADAR.stt='bandit'; bandit.pos.copy(at(20,0,2000)); seeker_now=seeker_look(bandit,false); seeker_uncage(); RADAR.stt=null; return [!!seeker_track,seeker_look(null,false).lockon];`)).toEqual([true, true])
  })
  it('uncaged, keeps the jet it had as the pilot looks away, until it leaves the gimbal', () => {
    expect(pit(`master='9m'; bandit.pos.copy(at(20,0,2000)); look(20); seeker_now=seeker_look(null,false); seeker_uncage();
      look(-20); const kept=seeker_look(null,false).lockon; bandit.pos.copy(at(50,0,2000)); const lost=seeker_look(null,false).lockon; const track=seeker_track;
      bandit.pos.copy(at(20,0,2000)); seeker_now=seeker_look(null,false); seeker_uncage(); look(20); seeker_now=seeker_look(null,false); seeker_uncage(); seeker_uncage();
      return [kept,lost,track,seeker_track];`)).toEqual([true, false, null, null]) // pressed twice, caged back
  })
  it('in a match has whichever jet is nearest the line, not the nearest jet', () => {
    expect(pit(`MULTIPLAYER=true; has_enemy=false; master='9m'; const near={ name:'near', group:{ visible:true }, pos:at(22,0,1000), fwd:new THREE.Vector3(0,0,-1), reheat:0 }, far={ name:'far', group:{ visible:true }, pos:at(20,0,3000), fwd:new THREE.Vector3(0,0,-1), reheat:0 };
      remotes.set(1,near); remotes.set(2,far); look(20); return seeker_look(null,false).quarry.name;`)).toBe('far')
  })
  it('looks for nothing outside 9M or in the landing configuration', () => {
    expect(pit(`look(0); const a=seeker_look(null,false); master='9m'; const b=seeker_look(null,true); return [a.line,b.line];`)).toEqual([null, null])
  })
  it('sends the round after what it has, and unguided without tone', () => {
    const fired = (seen: string) => new Function(`let aim='unset'; const arms={ arm:true }, mc=()=>({ one:true, two:true }), notice=()=>{}, translate=(t)=>t, weapons_hold=false, ownship={ launching:false, gear:1, msl:2 }, MULTIPLAYER=false, has_enemy=true, bandit='bandit', master='9m';
      const seeker_now=${seen}, trigger_amraam=()=>{}, launch_missile=(st,target)=>{ aim=target; return true; }, cheat=()=>false, audio_launch=()=>{}, update_rails=()=>{}; ${lift('trigger_missile')}
} trigger_missile(); return aim;`)() as unknown
    expect([fired('{ quarry:"held" }'), fired('{ quarry:null }')]).toEqual(['held', null]) // no tone, unguided: never the bandit for being there (#147)
  })
})

describe('the HMD format (figures 2-56 and 2-57)', () => {
  const page = (body: string) => pit<{ text: [string, number, number][]; rects: number[][] }>(`const text=[], rects=[];
    const x=new Proxy({}, { get:(t,k)=>k==='fillText'?(s,px,py)=>text.push([String(s),px,py]):k==='strokeRect'?(a,b,c,d)=>rects.push([a,b,c,d]):k==='measureText'?(s)=>({ width:10*String(s).length }):()=>{}, set:()=>true });
    ${body} ddi_hmd(x); return { text, rects };`)
  it('has NORM at 7, BRT AUTO at 11, BLNK boxed at 12, REJECT SETUP over 19 and ALIGN at 20', () => {
    const d = page('')
    expect(d.text).toEqual([['NORM', 176, 30], ['BRT AUTO', 502, 96], ['BLNK', 502, 176], ['REJECT', 176, 462], ['SETUP', 176, 482], ['ALIGN', 96, 482]])
    expect(d.rects).toHaveLength(1) // BLNK's box
  })
  it('boxes ALIGN in an alignment, and offers FINE at 1 once a coarse alignment is valid', () => {
    expect(page('unaligned(); hmd_press(20);').text.find((t) => t[0] === 'FINE')).toBeUndefined()
    const d = page('unaligned(); hmd_press(20); keys.add("KeyU"); frames(1.2);')
    expect(d.text.find((t) => t[0] === 'FINE')).toEqual(['FINE', 10, 416])
    expect(d.rects).toHaveLength(3) // BLNK, ALIGN and FINE
  })
  it('ends an alignment when MENU is pressed on it', () => {
    expect(source).toMatch(/if\(pb===18&&\(st\.menu\|\|st\.page!=="grid"\)\)\{ if\(!st\.menu&&st\.page==="hmd"\)\{ helmet\.exit\(hmd\); hmd\.setup=false; \}/) // and leaves REJECT SETUP's sublevel
  })
})

describe('the helmet display', () => {
  type Drawn = { text: string[]; rects: number[][]; arcs: number[][]; cluster: { helmet: unknown; limited: boolean; sight: unknown }[]; lines: number[][]; moves: number[][]; shifts: number[]; dashed: number[][] }
  const show = (body: string, call = 'draw_hmd(null,false,null,0,null,null)') => pit<Drawn>(`const text=[], rects=[], arcs=[], cluster=[], lines=[], moves=[], shifts=[], dashed=[]; let pen=[0,0], dash=0, translations=0;
    const hctx=new Proxy({}, { get:(t,k)=>k==='fillText'?(s)=>text.push(String(s)):k==='strokeRect'?(a,b,c,d)=>rects.push([a,b,c,d]):k==='arc'?(x,y,r)=>{ arcs.push([x,y,r]); if(dash) dashed.push([x,y,r]); }
      :k==='moveTo'?(x,y)=>{ pen=[x,y]; moves.push([x,y]); }:k==='lineTo'?(x,y)=>{ lines.push([...pen,x,y]); pen=[x,y]; }:k==='setLineDash'?(d)=>{ dash=d.length; }
      :k==='translate'?(x,y)=>{ if(++translations===2) shifts.push(y+HH/2); }:k==='save'?()=>{ translations=0; }:()=>{}, set:()=>true });
    const hud_cluster=(...a)=>cluster.push(a[12]); ${body} ${call}; return { text, rects, arcs, cluster, lines, moves, shifts, dashed };`)
  const ppd = 800 / 60 // the helmet's pixels a degree: an 800-pixel-high 60° field
  it('draws nothing until its start-up BIT is done, or with the knob at OFF', () => {
    expect(show(`Object.assign(hmd,helmet.fresh(false,{ azimuth:0, elevation:0, roll:0 },0)); frames(1);`).lines).toEqual([])
    expect(show(`knobs.hmd=0; frames(0.1);`).lines).toEqual([])
  })
  it('replicates the HUD\'s windows under its own REJECT SETUP, with the open aiming cross 1.9° across, and its dot while it has the TDC', () => {
    const d = show(`hmd.reject=1;`)
    expect(d.cluster.map((w) => w.limited)).toEqual([false])
    expect(d.cluster[0].helmet).toMatchObject({ reject: 1, levels: { MACH: 1 } }) // the helmet itself, for its REJECT SETUP levels
    const arms = d.lines.map(([x1, y1, x2, y2]) => Math.hypot(x2 - x1, y2 - y1) / ppd)
    expect(arms).toHaveLength(4)
    for (const arm of arms) expect(arm).toBeCloseTo(0.65, 1) // 0.95° out with a 0.3° gap at the centre (figure 2-58)
    expect(d.arcs.filter(([, , r]) => r < 2)).toEqual([])
    expect(show(`hmd.priority=true;`).arcs.some(([x, y, r]) => x === 500 && y === 400 && r < 2)).toBe(true) // the dot, not the field's edge
  })
  it('shows a mission computer\'s backup set: MC2\'s keeps the L&S, MC1\'s does not', () => {
    const boxed = 'const boxed={ pos:at(3,0,2000) };'
    expect(show(`${boxed} computers={ one:false, two:true };`, 'draw_hmd(null,false,boxed,0,null,null)').cluster.map((w) => w.limited)).toEqual([true])
    expect(show(`${boxed} computers={ one:false, two:true };`, 'draw_hmd(null,false,boxed,0,null,null)').rects).toHaveLength(1)
    expect(show(`${boxed} computers={ one:true, two:false };`, 'draw_hmd(null,false,boxed,0,null,null)').rects).toHaveLength(0)
  })
  it('boxes the L&S where it believes it is, and outside the field holds the box at its edge and points to it from the aiming cross (the DCS guide)', () => {
    const s = show(`hmd.error={ azimuth:1*D2R, elevation:0, roll:0 }; const boxed={ pos:at(3,0,2000) };`, 'draw_hmd(null,false,boxed,0,null,null)')
    expect(s.rects[0][0] + s.rects[0][2] / 2).toBeCloseTo(500 + Math.tan(2 * D) / Math.tan(30 * D) * 400, 1) // 3° right as the eye sees it, less the 1° it believes
    expect(s.text).not.toContain('2') // under 10° off: no locator line
    const out = show(`const boxed={ pos:at(40,0,2000) };`, 'draw_hmd(null,false,boxed,0,null,null)')
    const R = 10 * ppd, half = 14 * ppd / (800 / 45)   // the field's radius and the box's half-width
    expect(out.rects).toHaveLength(1)
    expect(out.rects[0][0] + half).toBeCloseTo(500 + R - 1.5 * half, 6) // held at the field's right edge
    expect(out.text).toContain('40')
    // Held at the edge it flashes, so it is never read as the box on the jet; on the jet it stays steady.
    expect(show(`glance=0.3; const boxed={ pos:at(40,0,2000) };`, 'draw_hmd(null,false,boxed,0,null,null)').rects).toHaveLength(0)
    expect(show(`glance=0.3; const boxed={ pos:at(3,0,2000) };`, 'draw_hmd(null,false,boxed,0,null,null)').rects).toHaveLength(1)
  })
  it('writes the AMRAAM\'s SHOOT over its box, as the HUD does over its own, and leaves it to the HUD through the glass', () => {
    const shoot = (lit: boolean, setup = '', call = 'draw_hmd(null,false,boxed,0,null,null)') => show(`master='120c'; const attack_cue=()=>({ shoot:${lit}, brk:false }); const boxed={ pos:at(3,0,2000) }; ${setup}`, call).text.includes('SHOOT')
    expect([shoot(true), shoot(false)]).toEqual([true, false])
    expect(shoot(true, `hmd.blank=true; const g={ corners:[[400,300],[600,300],[600,500],[400,500]] };`, 'draw_hmd(g,false,boxed,0,null,null)')).toBe(false) // BLNK through the HUD: the HUD's SHOOT, not a second one
  })
  it('boxes the L&S at the size the HUD draws its own box, so through the HUD the two coincide at every field', () => {
    // draw_hud's box is 14*hs either side, hs the HUD view's 1 or the glass's hud_fit() in the pit
    expect(source).toContain('const hs=glass?hud_fit():1;')
    expect(source).toContain('hctx.strokeRect(box[0]-14*hs,box[1]-14*hs,28*hs,28*hs);')
    const box = (setup: string) => show(`${setup} const boxed={ pos:at(3,0,2000) }; camera.updateProjectionMatrix();`, 'draw_hmd(null,false,boxed,0,null,null)').rects[0]?.[2]
    for (const field of [45, 60, 75]) expect(box(`cfg.view='hud'; master='9m'; camera.fov=${field};`)).toBeCloseTo(28, 9) // the HUD view in an A/A master, where the helmet draws through the HUD even with BLNK: 28 pixels whatever the field
    expect(box(`camera.fov=60;`)).toBeCloseTo(28 * 45 / 60, 9) // the pit, the glass not limiting: the HUD's layout at the world's angle, as before
    const fit = pit<number>(`camera.fov=60; ownship.group.userData.glass={ field:{ top:3, floor:20, side:20 } }; return hud_fit();`)
    expect(fit).toBeLessThan(45 / 60) // a glass too short for the layout shrinks the HUD's symbols to fit it
    expect(box(`camera.fov=60; ownship.group.userData.glass={ field:{ top:3, floor:20, side:20 } };`)).toBeCloseTo(28 * fit, 9) // and the helmet's box with them
  })
  it('draws the locator line from the aiming cross, longer the farther off, with its arrowhead and the angle over the cross', () => {
    const tll = (degrees: number) => pit<{ lines: number[][]; text: [string, number, number][] }>(`const lines=[], text=[]; let pen=[0,0];
      const hctx=new Proxy({}, { get:(t,k)=>k==='moveTo'?(x,y)=>{ pen=[x,y]; }:k==='lineTo'?(x,y)=>{ lines.push([...pen,x,y]); pen=[x,y]; }:k==='fillText'?(s,x,y)=>text.push([String(s),x,y]):()=>{}, set:()=>true });
      const ppd=${ppd}; hmd_locator(at(${degrees},0,1),new THREE.Vector3(0,0,-1),500,400,ppd); return { lines, text };`)
    expect(tll(9).lines).toEqual([])
    const near = tll(20), far = tll(160)
    expect(near.lines).toHaveLength(3) // the line and the arrowhead's two barbs
    const reach = (d: { lines: number[][] }) => (d.lines[0][2] - 500) / ppd
    expect(near.lines[0][0]).toBeCloseTo(500 + 1.3 * ppd, 6) // from just past the cross's arm
    expect(reach(near)).toBeCloseTo(1.3 + 20 / 180 * 6.7, 6)
    expect(reach(far)).toBeCloseTo(1.3 + 160 / 180 * 6.7, 6)
    expect(near.text).toEqual([['20', 500, 400 - 2.2 * ppd]])
  })
  it('in NAV puts the diamond on the designated point and points to it, the L&S\'s line alone when there are both (2.21.14)', () => {
    const point = 'nav.designation={ x:Math.sin(30*D2R)*5000, z:-Math.cos(30*D2R)*5000, elevation:0, stage:"tgt" };'
    const d = show(point)
    expect(d.text).toContain('30')
    expect(d.lines.length).toBe(4 + 3 + 3) // the aiming cross, the diamond's sides after the first point, and the locator line with its barbs
    const both = show(`${point} const boxed={ pos:at(-50,0,2000) };`, 'draw_hmd(null,false,boxed,0,null,null)')
    expect([both.text.includes('50'), both.text.includes('30'), both.rects.length]).toEqual([true, false, 1])
    expect(show(`${point} master='9m';`).text).not.toContain('30') // a NAV designation: no diamond in the A/A masters
  })
  it('flashes ENTERING IBIT while its test runs, then shows its test patterns, and nothing else', () => {
    const testing = show(`bit.tests.hmd=10; glance=0;`)
    expect([testing.text, testing.cluster]).toEqual([['ENTERING IBIT'], []])
    const patterns = show(`hmd.patterns=hmd.time;`)
    expect([patterns.text, patterns.cluster]).toEqual([['STROKE', '-800', '-400', '400', '800', '0.0', '400', '-400'], []])
  })
  it('draws pattern 1\'s squares 1.5° across at ±5°, and its 2.5° ticks 2.3° long across the horizontal axis and 1.8° across the vertical (figure 2-55)', () => {
    const d = show(`hmd.patterns=hmd.time;`)
    expect(d.rects.map(([x, y, w, h]) => [Math.round((x + w / 2 - 500) / ppd), Math.round((y + h / 2 - 400) / ppd), Math.round(w / ppd * 100) / 100])).toEqual([[-5, -5, 1.5], [5, -5, 1.5], [-5, 5, 1.5], [5, 5, 1.5]])
    const ticks = d.lines.map(([x1, y1, x2, y2]) => Math.round(Math.hypot(x2 - x1, y2 - y1) / ppd * 100) / 100).filter((l) => l < 5)
    expect(ticks.sort()).toEqual([...Array(6).fill(1.8), ...Array(6).fill(2.3)])
  })
  it('draws pattern 4\'s four diameters across the whole 20°, through the 2° circle (figure 2-55)', () => {
    const d = show(`hmd.patterns=hmd.time-3.5;`)
    const diameters = d.lines.filter(([x1, y1, x2, y2]) => Math.abs(Math.hypot(x2 - x1, y2 - y1) / ppd - 20) < 1e-6)
    expect(diameters).toHaveLength(4)
    for (const [x1, y1, x2, y2] of diameters) expect([(x1 + x2) / 2, (y1 + y2) / 2]).toEqual([500, 400])
    expect(d.text).toEqual(['3'])
  })
  it('blanks through the HUD with BLNK: all but the aiming cross in NAV; in the A/A masters it keeps the elevation, the L&S and the seeker', () => {
    const glass = 'const g={ corners:[[400,300],[600,300],[600,500],[400,500]] };'
    const nav = show(glass, 'draw_hmd(g,false,null,0,null,null)')
    expect([nav.cluster, nav.lines.length, nav.text]).toEqual([[], 4, []])
    const aa = show(`${glass} master='9m'; const boxed={ pos:at(3,0,2000) }; seeker_now.line=at(3,0,1);`, 'draw_hmd(g,false,boxed,0,null,null)')
    expect([aa.cluster, aa.text, aa.rects.length, aa.arcs.length]).toEqual([[], ['0'], 1, 2]) // the elevation; the field's clip and the seeker's circle
    const aligning = show(`${glass} unaligned(); helmet.press(hmd,20);`, 'draw_hmd(g,false,null,0,null,null)')
    expect(aligning.text).toContain('READY')
  })
  it('shows its alignment crosses and their message alone while aligning, through the HUD or not (figures 2-56, 2-57)', () => {
    const aligning = show(`unaligned(); helmet.press(hmd,20); look(30);`)
    expect([aligning.cluster, aligning.text, aligning.lines.length]).toEqual([[], ['READY'], 2]) // the cross's two bars: no layout, no aiming cross
  })
  it('says ALTITUDE in the HARM window for the GPWS, which draws no arrow there (2.21.13.4)', () => {
    expect(show(`law_active=true;`).text).toContain('ALTITUDE')
  })
  it('lays the HUD\'s windows out at the HUD\'s angles, shrunk to keep them inside its field in a short window', () => {
    const s = pit<number[][]>(`const r=[]; for(const [height,fov] of [[1440,40],[761,70]]){ const ppd=height/fov, ppdv=height/45, R=10*ppd, k=hmd_fit(ppd,ppdv,R);
      const reach=Math.max(172+1.25*ppdv,8.6*ppdv+10,Math.hypot(4.2*ppdv+101,4*ppdv)); r.push([Math.round(k/(ppd/ppdv)*100)/100, reach*k<=0.97*R+1e-9 ? 1 : 0]); } return r;`)
    expect(s[0]).toEqual([1, 1]) // a tall window: the HUD's own angles
    expect(s[1][0]).toBeLessThan(1) // a short one: shrunk
    expect(s[1][1]).toBe(1) // and inside the field
  })
  it('writes the line of sight\'s elevation over the heading scale, signed (the DCS guide), and REJECT SETUP takes it at REJ 2', () => {
    expect(show(`look(0,16);`).text).toContain('+16')
    expect(show(`look(0,-7);`).text).toContain('-7')
    expect(show(`look(0,16); hmd.reject=2;`).text).not.toContain('+16')
    expect(show(`look(0,16); computers={ one:false, two:true };`).text).not.toContain('+16') // nor in a backup set
  })
  it('drops the layout in the A/A masters as the pilot looks up, the jet\'s heading over the aiming cross by 30° (the DCS guide)', () => {
    const shift = (master: string, up: number) => show(`master='${master}'; look(0,${up});`).shifts[0]
    expect([shift('nav', 20), shift('9m', 0), shift('9m', -10)]).toEqual([0, 0, 0])
    const full = pit<number>(`return hmd_shift(new THREE.Vector3(0,Math.sin(30*D2R),-Math.cos(30*D2R)),400,hud_tape(400,800/45,true),10);`)
    expect(full).toBeCloseTo(150 + 1.25 * 800 / 45 - 32 - 9.5, 6)
    expect(pit<number>(`return hmd_shift(new THREE.Vector3(0,Math.sin(45*D2R),-Math.cos(45*D2R)),400,hud_tape(400,800/45,true),10);`)).toBeCloseTo(full, 6)
    expect(pit<number>(`return hmd_shift(new THREE.Vector3(0,Math.sin(15*D2R),-Math.cos(15*D2R)),400,hud_tape(400,800/45,true),10);`)).toBeCloseTo(full / 2, 6)
    expect(shift('9m', 15)).toBeGreaterThan(0)
  })
  it('carries the 9M\'s circle where the seeker looks, smaller once it tracks, with SHOOT over it', () => {
    const base = `master='9m'; seeker_now.line=at(5,0,1); const heat={ shoot:true };`
    const d = show(base, 'draw_hmd(null,false,null,0,null,heat)')
    const circle = d.arcs.find(([, , r]) => Math.abs(r - 2.5 * ppd) < 1e-6)
    expect(circle).toBeDefined()
    expect(d.text).toContain('SHOOT')
    const tracking = show(`${base} seeker_track={};`, 'draw_hmd(null,false,null,0,null,heat)')
    expect(tracking.arcs.some(([, , r]) => Math.abs(r - 1.25 * ppd) < 1e-6)).toBe(true)
    expect(show(`master='9m'; seeker_now.line=at(5,0,1);`, 'draw_hmd(null,false,null,0,null,{ shoot:false })').text).not.toContain('SHOOT')
  })
  it('draws the HACQ or LACQ reticle 5° across with its legend, flashing past the radar\'s gimbal (the DCS guide)', () => {
    const d = show(`master='9m'; RADAR.auto=true; RADAR.acm='lacq';`)
    expect(d.dashed.map(([x, y, r]) => [x, y, Math.round(r / ppd * 100) / 100])).toEqual([[500, 400, 2.5]])
    expect(d.text).toContain('LACQ')
    const past = (time: number) => show(`master='9m'; RADAR.auto=true; RADAR.acm='hacq'; look(75); glance=${time};`).text.includes('HACQ')
    expect([past(0.1), past(0.3)]).toEqual([true, false])
  })
})

describe('the alignment symbols (figures 2-56 to 2-58)', () => {
  const ppd = 800 / 60
  const strokes = (body: string) => pit<number[][]>(`const lines=[]; let pen=[0,0];
    const hctx=new Proxy({}, { get:(t,k)=>k==='moveTo'?(x,y)=>{ pen=[x,y]; }:k==='lineTo'?(x,y)=>{ lines.push([...pen,x,y]); pen=[x,y]; }:()=>{}, set:()=>true });
    ${body} return lines.map((l)=>l.map((v)=>Math.round(v*1000)/1000));`)
  const r = (v: number) => Math.round(v * 1000) / 1000
  it('draws the alignment cross as a bar 10° tall crossed 2.3° below its top by one 9.5° wide', () => {
    expect(strokes(`alignment_cross(100,200,10);`)).toEqual([[100, 177, 100, 277], [52.5, 200, 147.5, 200]])
  })
  it('puts the helmet\'s coarse cross 4° above the display\'s centre, READY 6° below it', () => {
    const lines = strokes(`unaligned(); helmet.press(hmd,20); hmd_alignment(500,400,${ppd});`)
    expect(lines).toEqual([[500, r(400 - 6.3 * ppd), 500, r(400 + 3.7 * ppd)], [r(500 - 4.75 * ppd), r(400 - 4 * ppd), r(500 + 4.75 * ppd), r(400 - 4 * ppd)]])
  })
  it('puts the fine alignment\'s two crosses 1.9° across 4.3° apart down the HUD cross\'s bar', () => {
    const lines = strokes(`unaligned(); helmet.press(hmd,20); keys.add('KeyU'); frames(1.2); look(0,-2); hmd_alignment(500,400,${ppd});`)
    expect(lines).toHaveLength(4)
    const [high, , low] = lines
    expect(r((high[2] - high[0]) / ppd)).toBeCloseTo(1.9, 2)
    const centre = (l: number[]) => (l[1] + l[3]) / 2
    expect((centre(low) - centre(high)) / ppd).toBeCloseTo(Math.tan(6.3 * D) / Math.tan(30 * D) * 400 / ppd - Math.tan(2 * D) / Math.tan(30 * D) * 400 / ppd, 1)
  })
  it('draws the HUD\'s side as the same cross, and the look-direction cross 1.4° across', () => {
    const block = lift('draw_hud')
    expect(block).toContain('if(hmd.mode){ const c=proj_dir(ownship.fwd); if(c) alignment_cross(c[0],c[1],ppd); }')
    expect(block.match(/plus\(p\[0\],p\[1\],0\.7\*ppd\)/g)).toHaveLength(2)
  })
})

describe('the helmet\'s reject levels in the HUD layout', () => {
  const keep = /\n\tconst keep=[^\n]*\n/.exec(lift('hud_cluster'))?.[0] ?? ''
  it('follow the HUD\'s reject switch on the HUD and REJECT SETUP on the helmet', () => {
    const run = (worn: string, reject: number, symbol: string, level: number) => new Function('helmet', `const declutter=${reject}, worn=${worn}, rej=worn?worn.helmet.reject:declutter; ${keep} return keep(${JSON.stringify(symbol)},${level});`)(helmet) as boolean
    const fitted = `{ helmet:Object.assign(helmet.fresh(true,{ azimuth:0, elevation:0, roll:0 },0),{ reject:${1} }) }`
    expect([run('null', 1, 'MACH', 1), run('null', 0, 'MACH', 1), run('null', 1, 'TIME WINDOW', 2)]).toEqual([false, true, true])
    expect([run(fitted, 1, 'MACH', 2), run(fitted, 1, 'HMD ELEV', 1), run(fitted, 1, 'ALTITUDE', 1)]).toEqual([false, true, true])
  })
  it('gate every symbol of the layout REJECT SETUP lists, by its name there', () => {
    const named = [...lift('hud_cluster').matchAll(/keep\("([^"]+)",/g)].map((m) => m[1])
    const listed = helmet.SETUP.flat().filter((e) => e).map((e) => e![0])
    for (const name of named) expect(listed, name).toContain(name)
    expect(new Set(named)).toEqual(new Set(['HMD HEADING', 'ALT_ASPD_BOX', 'AIRSPEED', 'CLIMB_ASPD', 'ALTITUDE', 'BARO/RADALT', 'BARO PRES', 'VSI', 'ALPHA', 'MACH', 'G', 'MAX G', 'TIME WINDOW', 'NIRD CIRCLE', 'A/C HEADING']))
  })
})

describe('REJECT SETUP on the HMD format', () => {
  const page = (body: string) => pit<{ text: string[]; rects: number[][] }>(`const text=[], rects=[];
    const x=new Proxy({}, { get:(t,k)=>k==='fillText'?(s)=>text.push(String(s)):k==='strokeRect'?(a,b,c,d)=>rects.push([a,b,c,d]):k==='measureText'?(s)=>({ width:10*String(s).length }):()=>{}, set:()=>true });
    ${body} ddi_hmd(x); return { text, rects };`)
  it('lists the symbols with their levels, boxes the one selected, and has RETURN in place of REJECT SETUP', () => {
    const d = page('hmd_press(19); hmd_press(4);')
    for (const word of ['ALTITUDE', 'AIRSPEED', 'HMD ELEV', 'WINDOW 10', 'MIDS INFO', 'ON', '1', '2', 'RETURN', 'L', 'E', 'V']) expect(d.text, word).toContain(word)
    expect(d.text).not.toContain('REJECT')
    expect(d.rects).toEqual([[52, 120, 178, 20]]) // AIRSPEED, the second row, from its name to its level
    expect(page('').text).not.toContain('ALTITUDE')
  })
})

describe('the 9M\'s cues, for the HUD or the helmet', () => {
  const line = /\n\tconst heat_shown=[^\n]*\n/.exec(source)?.[0] ?? ''
  const cues = (setup: string) => new Function(`let lockon=true, brk=false, weapons_hold=false, glance=0, cue='steady'; const ownship={ msl:2 }; ${setup} ${lift('heat_lit')} ${line} return heat_shown.shoot;`)() as boolean
  it('cue SHOOT with tone inside the zone, steady or flashing inside Rne, and never inside the breakaway, in the joust\'s hold or with none left (#47)', () => {
    expect(cues('')).toBe(true)
    expect([cues('cue="flash"; glance=0.1;'), cues('cue="flash"; glance=0.3;')]).toEqual([true, false])
    expect([cues('brk=true;'), cues('weapons_hold=true;'), cues('ownship.msl=0;'), cues('cue="break";'), cues('lockon=false;')]).toEqual([false, false, false, false, false])
  })
  it('carry the zone\'s ranges on the steering circle, not on a staff beside the boresight', () => {
    expect(source).not.toMatch(/heat_staff/)
  })
})

// The real cue lights only with the steering dot, the lead for a round fired now, inside the
// allowable steering error circle; the game's 9M takes a 10-degree circle. The dot is drawn in a
// circle the AMRAAM's size, its rim that 10 degrees off the nose.
describe('the 9M\'s steering dot and its circle', () => {
  const steer = `${line('HEAT_ASE')} ${lift('heat_lead')} ${lift('track_range')} ${lift('nird')} ${lift('heat_steered')} ${lift('zone_cue')} ${lift('heat_cue')} ${lift('nird_clock')} ${lift('heat_steering')}`
  // the radar's target 2,000 m out, still unless moved; nose(a) turns the jet's nose a degrees right
  const rig = <T,>(body: string) => pit<T>(`let weapons_hold=false; RADAR.ls='bandit'; ownship.speed=250;
    const target={ position:at(0,0,2000), velocity:{ x:0, y:0, z:0 } }, radar_target=()=>target;
    const nose=(a)=>{ ownship.fwd.set(Math.sin(a*D2R),0,-Math.cos(a*D2R)); ownship.right.set(Math.cos(a*D2R),0,Math.sin(a*D2R)); };
    const zone={ range:2000, minimum:300, escape:1000, max:4000 }; let ladder=null; const heat_zone=()=>ladder; ${steer} ${body}`)
  it('lights SHOOT only with the nose within 10 degrees of the lead, and keeps the breakaway whatever the steering', () => {
    expect(rig(`return [0,9,11,30].map((a)=>{ target.position=at(a,0,2000); return heat_cue(zone); });`)).toEqual(['steady', 'steady', null, null])
    expect(rig(`target.position=at(30,0,200); return heat_cue({ ...zone, range:200 });`)).toBe('break')
    expect(rig(`return [weapons_hold=true, heat_cue(zone)][1];`)).toBeNull()
    expect(rig(`RADAR.ls=null; return heat_cue(zone);`)).toBeNull() // no track, no lead: no SHOOT
  })
  it('leads a crossing target by the round\'s time of flight, the range over the launch speed and about 500 m/s', () => {
    // 2,000 m ahead crossing right at 200 m/s: 2.67 s of flight puts the lead 533 m right, 14.9 degrees
    const lead = Math.atan(200 * 2000 / 750 / 2000) / D
    expect(rig<number>(`target.velocity={ x:200, y:0, z:0 }; const l=heat_lead(); return Math.atan2(l.x,-l.z)/D2R;`)).toBeCloseTo(lead, 6)
    expect(rig(`target.velocity={ x:200, y:0, z:0 }; return [heat_cue(zone), (nose(${lead}), heat_cue(zone))];`)).toEqual([null, 'steady'])
  })
  it('draws the circle the AMRAAM\'s size at the layout\'s centre, the dot inside it exactly while SHOOT may light, pegged past it', () => {
    const dot = (body: string) => rig<number[][]>(`const arcs=[]; const hctx=new Proxy({}, { get:(t,k)=>k==='arc'?(x,y,r)=>arcs.push([x,y,r]):()=>{}, set:()=>true });
      ${body} heat_steering(hctx,'g',500,400,20); return arcs;`)
    const R = 3.2 * 20
    const shown = dot(`target.position=at(5,0,2000);`)
    expect(shown[0]).toEqual([500, 400, R])
    expect(shown[1][0] - 500).toBeCloseTo(R / 2, 6) // 5 degrees right: half way to the rim
    expect(shown[1][1]).toBeCloseTo(400, 6)
    expect(400 - dot(`target.position=at(0,8,2000);`)[1][1]).toBeCloseTo(R * 0.8, 6) // 8 degrees up: up the screen
    expect(dot(`target.position=at(40,0,2000);`)[1][0] - 500).toBeCloseTo(R * 1.35, 6)
    expect(dot(`RADAR.ls=null;`)).toEqual([])
    expect(dot(`ownship.msl=0;`)).toEqual([])
  })
  it('draws in the HUD\'s cluster on the waterline, so the helmet repeats it, with the 9M selected', () => {
    expect(source).toContain('if(master==="9m"&&keep("NIRD CIRCLE",3)&&!limited) heat_steering(hctx,GR,cx,wly,ppdv);')
    expect(lift('hud_cluster')).toContain('const wly=cy-4*ppdv;')
  })
  // The NIRD (the VRS AIM-9 page): Rmin at 2:30, Rmax at 6:00, Rne between, outside the rim; his
  // range an arc from 12 o'clock with a bar at its end, turning counter-clockwise as he closes.
  it('places the ranges on the circle by the clock, Rmin at 2:30 and Rmax at 6:00 whatever their size', () => {
    const clock = (r: number) => rig<number>(`return nird_clock(${r},{ minimum:500, escape:1500, max:3000 });`)
    expect([0, 250, 500, 1500, 3000].map(clock)).toEqual([0, 37.5, 75, 75 + 105 * 1000 / 2500, 180])
    expect(clock(4000)).toBeCloseTo(180 + 105 * 1000 / 2500, 9) // past Rmax at the same rate a metre
    expect(clock(20000)).toBe(330) // and no further than 11 o'clock
  })
  it('draws the range cues as triangles outside the rim and his range as an arc and bar, with the radar\'s zone', () => {
    const draw = (body: string) => rig<{ arcs: number[][]; tips: number[][]; bars: number[][] }>(`const arcs=[], tips=[], bars=[]; let width=0, first=null;
      const hctx=new Proxy({}, { get:(t,k)=>k==='arc'?(...a)=>arcs.push([...a,width]):k==='moveTo'?(x,y)=>{ first=[x,y]; }:k==='lineTo'?(x,y)=>{ if(first){ (width>2?bars:tips).push(first); first=null; } }:()=>{}, set:(t,k,v)=>{ if(k==='lineWidth') width=v; return true; } });
      ladder={ minimum:500, escape:1500, max:3000 }; ${body} heat_steering(hctx,'g',500,400,20); return { arcs, tips, bars };`)
    const R = 64, place = (clock: number, radius: number) => [500 + Math.sin(clock * D) * radius, 400 - Math.cos(clock * D) * radius]
    const d = draw('')
    const near = (a: number[], b: number[]) => { expect(a[0]).toBeCloseTo(b[0], 6); expect(a[1]).toBeCloseTo(b[1], 6) }
    expect(d.tips).toHaveLength(3)
    near(d.tips[0], place(75, R + 2)) // Rmin at 2:30
    near(d.tips[1], place(75 + 105 * 1000 / 2500, R + 2)) // Rne between
    near(d.tips[2], place(180, R + 2)) // Rmax at 6:00
    const at = 75 + 105 * 1500 / 2500 // the target 2,000 m out
    expect(d.arcs[2][3]).toBeCloseTo(-Math.PI / 2, 9)
    expect(d.arcs[2][4]).toBeCloseTo(-Math.PI / 2 + at * D, 9) // the arc from 12 o'clock to his range
    expect(d.arcs[2][5]).toBe(2.5)
    near(d.bars[0], place(at, R))
    expect(draw('target.position=at(0,0,1000);').arcs[2][4]).toBeLessThan(d.arcs[2][4]) // closing turns it counter-clockwise
    expect(draw('ladder.escape=0;').tips).toHaveLength(2) // no no-escape band, no Rne
    expect(draw('ladder.max=0;').arcs).toHaveLength(2) // no zone: the circle and the dot alone
  })
})

// Off the HUD's field the 9M's seeker circle and the TD box are limited to its edge and flash.
describe('a symbol limited to the HUD\'s field', () => {
  const edge = (body: string) => pit<{ at: number[]; limited: boolean }>(`const _q=new THREE.Quaternion();
    ${lift('proj_point')} ${lift('hud_field')} ${lift('hud_room')} ${lift('hud_edge')} ${body}`)
  const glass = 'const glass={ corners:[[400,300],[600,300],[600,500],[400,500]] };'
  it('sits at its projection while that is on the field', () => {
    const s = edge(`return hud_edge(at(10,0,2000),[500,400],null,20);`)
    expect(s.limited).toBe(false)
    expect(s.at[0]).toBeCloseTo(500 + Math.tan(10 * D) / Math.tan(30 * D) * 400, 6)
  })
  it('is pinned inside the field\'s edge, its radius in, on the line from the boresight toward it', () => {
    const right = edge(`return hud_edge(at(50,0,2000),[500,400],null,20);`)
    expect(right.limited).toBe(true)
    expect(right.at[0]).toBeCloseTo(980, 6)
    expect(right.at[1]).toBeCloseTo(400, 6)
    const behind = edge(`return hud_edge(at(170,0,2000),[500,400],null,20);`) // behind the eye, a little right
    expect(behind.limited).toBe(true)
    expect(behind.at[0]).toBeCloseTo(980, 6)
    expect(behind.at[1]).toBeCloseTo(400, 6)
  })
  it('takes the glass for the field in the pit', () => {
    const side = edge(`${glass} return hud_edge(at(20,0,2000),[500,400],glass,20);`)
    expect(side.limited).toBe(true)
    expect(side.at[0]).toBeCloseTo(580, 6)
    expect(side.at[1]).toBeCloseTo(400, 6)
    const top = edge(`${glass} return hud_edge(at(0,20,2000),[500,400],glass,20);`)
    expect(top.at[0]).toBeCloseTo(500, 6)
    expect(top.at[1]).toBeCloseTo(320, 6)
    expect(edge(`${glass} return hud_edge(at(5,0,2000),[500,400],glass,20).limited;`)).toBe(false)
  })
  it('is where the HUD draws the 9M\'s circle and box, flashing while limited, SHOOT kept on the glass, and the locator line then', () => {
    const hud = lift('draw_hud')
    expect(hud).toContain('const spot=look?hud_edge(look,bore,glass,seeker):{ at:bore, limited:false }, at=spot.at;')
    expect(hud).toContain('if(!worn&&(!spot.limited||blink)){ hctx.strokeStyle=GR;')
    expect(hud).toContain('const box=edge?(edge.limited?(master==="9m"&&blink?edge.at:null):edge.at):null;')
    expect(hud).toContain('if(edge&&edge.limited){   // target locator line')
    expect(hud).toContain('hctx.fillText("SHOOT",at[0],room?above:at[1]+seeker+16*hs);')
  })
})

describe('the AIM-120\'s field-of-view circle (the DCS guide, figure 154)', () => {
  it('shows with the AIM-120 selected and no radar target to slave it to, or VISUAL chosen', () => {
    expect(pit(`const r=[]; master='120c'; r.push(amraam_field()); RADAR.stt='bandit'; r.push(amraam_field()); RADAR.stt=null; RADAR.ls='bandit'; r.push(amraam_field());
      amraam_visual=true; r.push(amraam_field()); master='9m'; r.push(amraam_field()); return r;`)).toEqual([true, false, false, true, false])
  })
  const circles = (body: string, call = 'draw_hmd(null,false,null,0,null,null)') => pit<number[][]>(`const dashed=[]; let dash=0;
    const hctx=new Proxy({}, { get:(t,k)=>k==='arc'?(x,y,r)=>{ if(dash) dashed.push([x,y,r]); }:k==='setLineDash'?(d)=>{ dash=d.length; }:()=>{}, set:()=>true });
    const hud_cluster=()=>{}; master='120c'; ${body} ${call}; return dashed.map(([x,y,r])=>[Math.round(x),Math.round(y),Math.round(r/(800/60)*10)/10]);`)
  it('draws it dashed on the helmet about the boresight, 15° across, and keeps it through the HUD in BLNK', () => {
    expect(circles('')).toEqual([[500, 400, 7.5]])
    expect(circles('look(10);')[0][0]).toBeLessThan(500) // the nose 10° left of where the pilot looks
    expect(circles('RADAR.stt="bandit";')).toEqual([])
    expect(circles('', 'draw_hmd(null,true,null,0,null,null)')).toEqual([]) // nor in the landing configuration
    expect(circles('const g={ corners:[[400,300],[600,300],[600,500],[400,500]] };', 'draw_hmd(g,false,null,0,null,null)')).toEqual([[500, 400, 7.5]])
  })
  it('leaves it to REJECT SETUP on the helmet (SP/AMR FOV)', () => {
    expect(circles('hmd.levels["SP/AMR FOV"]=1; hmd.reject=1;')).toEqual([])
    expect(circles('hmd.levels["SP/AMR FOV"]=1;')).toEqual([[500, 400, 7.5]])
  })
  it('draws it on the HUD too, dashed about the boresight', () => {
    expect(lift('draw_hud')).toContain('if(amraam_field()){ const c=proj_dir(ownship.fwd);')
    expect(lift('draw_hud')).toContain('hctx.arc(c[0],c[1],VISUAL/D2R*ppd,0,Math.PI*2);')
  })
  it('takes alone what lies inside it with a VISUAL shot, and nothing outside it', () => {
    const shot = (az: number, visual: boolean, burning = false) => pit<string | null>(`let aim='unset'; amraam_visual=${visual}; const weapons_hold=false, notice=()=>{}, cheat=()=>false, audio_launch=()=>{}, update_rails=()=>{};
      const amraam_departure=()=>({ name:'120c4' }), burning_stores=()=>${burning ? "['120c4']" : '[]'};
      ownship.amraam=2; RADAR.stt=${visual || burning ? 'null' : '"bandit"'}; const launch_amraam=(st,target)=>{ aim=target&&target.name; return true; };
      bandit.name='bandit'; bandit.pos.copy(at(${az},0,4000)); ${lift('trigger_amraam')}
} trigger_amraam(); return aim;`)
    expect([shot(5, true), shot(10, true), shot(20, false)]).toEqual(['bandit', null, 'bandit']) // a supported shot is the radar's, wherever it points
    expect([shot(5, false, true), shot(10, false, true)]).toEqual(['bandit', null]) // a round burning on its rail goes off as a VISUAL shot, no lock needed
  })
  it('in a match, says a VISUAL shot is one with the trigger edge, and still refuses a supported shot without a lock (#155)', () => {
    const edge = (visual: boolean, stt: string, burning = false) => pit<[boolean, boolean, number]>(`let fox3_flag=false, fox3_visual=false; MULTIPLAYER=true; amraam_visual=${visual}; RADAR.stt=${stt};
      const amraam_departure=()=>({ name:'120c4' }), burning_stores=()=>${burning ? "['120c4']" : '[]'};
      const weapons_hold=false, notice=()=>{}, cheat=()=>false, audio_launch=()=>{}, update_rails=()=>{}; ownship.amraam=2; ${lift('trigger_amraam')}
} trigger_amraam(); return [fox3_flag,fox3_visual,ownship.amraam];`)
    expect(edge(true, 'null')).toEqual([true, true, 1])
    expect(edge(false, 'null')).toEqual([false, false, 2])
    expect(edge(false, '"bandit"')).toEqual([true, false, 1])
    expect(edge(false, 'null', true)).toEqual([true, true, 1]) // a burning round goes off as a VISUAL shot: the server fires it, lock or none
  })
})

describe('the heading scale on the helmet (the DCS guide)', () => {
  const start = source.indexOf('\tconst north=(v)=>'), end = source.indexOf('\t// ---- airspeed box', start)
  const section = source.slice(start, end)
  const tape = (looking: number, heading = 0, steer = 'null') => new Function('THREE', 'helmet', 'navigate', `const D2R=Math.PI/180, cx=500, cy=400, ppdv=20, GR='g', aa=false, glass=null, screen=null, master='nav', limited=false, rej=0;
    const nav={ magnetic:false, variation:0 }, link={ five:null }, hold={ modes:{ coupled:false }, source:'track' };
    const ownship={ fwd:{ x:Math.sin(${heading}*D2R), y:0, z:-Math.cos(${heading}*D2R) }, gauges:{ track:${heading}*D2R } }, hud_steer=()=>(${steer});
    const worn={ helmet:helmet.fresh(true,{ azimuth:0, elevation:0, roll:0 },0), limited:false, sight:{ x:Math.sin(${looking}*D2R), y:0, z:-Math.cos(${looking}*D2R) } };
    const keep=(symbol,level)=>helmet.shown(worn.helmet,symbol); ${/\nfunction hud_tape\([^\n]*\n/.exec(source)?.[0] ?? ''}
    const text=[], marks=[]; const hctx=new Proxy({}, { get:(t,k)=>k==='fillText'?(s,x,y)=>text.push([String(s),x]):k==='moveTo'?(x,y)=>marks.push([x,y]):()=>{}, set:()=>true });
    ${section} return { text, marks };`)(THREE, helmet, navigate) as { text: [string, number][]; marks: number[][] }
  it('runs about the heading the helmet looks along, with the jet\'s heading in digits under its middle', () => {
    const d = tape(92, 10)
    expect(d.text.map(([t]) => t)).toEqual(['080', '090', '100', '010'])
    expect(d.marks.some(([, y]) => y === 400 - 150 + 5)).toBe(false) // no T: the digits are the jet's heading
    expect(d.text.find(([t]) => t === '090')?.[1]).toBeCloseTo(500 - 2 * 7, 6)
    expect(d.text.find(([t]) => t === '010')?.[1]).toBe(500)
  })
  it('puts the steering mark at its heading on the scale, held at the end beyond it', () => {
    const at = (looking: number, bearing: number) => tape(looking, 0, `{ bearing:${bearing}*D2R }`).marks.find(([, y]) => y === 400 - 150 + 1)?.[0]
    expect(at(10, 4)).toBeCloseTo(500 - 6 * 7, 6) // steering 004 on a scale about 010
    expect(at(10, 60)).toBeCloseTo(500 + 15 * 7, 6)
  })
})

describe('the wiring', () => {
  it('has its OFF/BRT knob on the spin recovery panel, where the model paints MAP GAIN, OFF on the wheels', () => {
    expect(source).toMatch(/\{ action:"knob\.hmd", at:\[6\.195,0\.315,0\.361\] \}/)
    expect(line('knobs')).toContain('hmd:null')
    expect(lift('reset_ownship')).toMatch(/Object\.assign\(hmd,helmet\.fresh\(air,[^\n]*\); if\(!air\) knobs\.hmd=0; \}/)
  })
  it('gives the cage/uncage switch to an alignment, and the TDC to a fine one', () => {
    expect(source).toContain('if(ch===key_of("uncage")){ if(hmd.mode){ helmet.toggle(hmd); ddi_dirty=true; }')
    expect(source).toContain('if(hmd.mode==="fine") helmet.nudge(hmd,x,y,dt); else tdc_slew(x,y,dt);')
    expect(source).toContain('else if(master==="9m") seeker_uncage(); }')
  })
  it('runs each avionics frame, reads OFF and BIT-start NOT RDY, and has its IBIT and STOP on the BIT display', () => {
    expect(lift('avionics_frame')).toContain('\n\thelmet_frame(dt);\n')
    expect(lift('equipment')).toContain('hmd:!hmd.on?"off":helmet.starting(hmd)?"wait":"ok"')
    expect(line('BIT_LEGENDS') + source).toMatch(/displays:\{ 5:\["DDI","MPCD","HUD"\], 4:\["IFEI"\], 2:\["DMS"\], 11:\["HMD"\] \}/)
    expect(lift('bit_press')).toContain('hmd.patterns=-1;')
  })
  it('draws in the first-person views only, and the HUD draws the AIM-9 circle only when the helmet does not', () => {
    expect(lift('draw_hud')).toContain('if(cfg.view==="hud"||cfg.view==="cockpit") draw_hmd(glass,pa,boxed,vc,ranged?rng:null,heat_shown);')
    expect(lift('draw_hud')).toContain('const worn=hmd_seeker();')
    expect(lift('draw_hud')).toContain('if(!worn&&(!spot.limited||blink)){ hctx.strokeStyle=GR;')
    expect(lift('draw_hud')).toContain('if(!worn&&heat_shown.shoot){') // its SHOOT goes with it
    expect(lift('draw_hud')).toContain('const seeker=(seeker_track?helmet.TRACK:helmet.SEEKER)/D2R*ppd;') // the HUD's own, in the views that overlay it, smaller tracking too
  })
})
