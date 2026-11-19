// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// A single-player joust the pilot has lost is decided only once nothing he
// left flying can still down the bandit, as the server's reckon decides a
// match: his missiles and gun rounds in the air, a fire burning in it. Until
// then the bandit stays his target, the fight's clock runs on without him,
// and the menu waits. engine.ts cannot be imported (WebGL at module scope), so
// the functions are lifted from its source and run against stand-ins.
const source = readFileSync(
  fileURLToPath(new URL('./engine.ts', import.meta.url)),
  'utf8'
)
function lift(name: string): string {
  const start = source.indexOf(`function ${name}(`)
  expect(start, `${name} in engine.ts`).toBeGreaterThan(0)
  const rest = source.slice(start)
  const end = /\n(?=\S)/.exec(rest.slice(1))
  return end ? rest.slice(0, end.index + 1) : rest
}

interface World {
  has_enemy: boolean
  own_aloft: number
  own_kills: number
  crash_t: number
  mission_done: boolean
  bandit: {
    group: { visible: boolean }
    harm: { burning: boolean; fire: number[] }
    struck?: number
  }
  missiles: { active: boolean; enemy: boolean }[]
  stores: string[]
  over: unknown[]
  after: number
  destroyed: string[]
  flown?: object
  progress?: number[]
}

// world runs body against a fresh stand-in world with the named functions
// lifted into it, and hands back the world as the body left it.
function world(
  names: string[],
  body: string,
  set: Partial<World> = {},
  extra = ''
): World {
  const w: World = {
    has_enemy: true,
    own_aloft: 0,
    own_kills: 0,
    crash_t: 3,
    mission_done: false,
    bandit: {
      group: { visible: true },
      harm: { burning: false, fire: [0, 0] },
    },
    missiles: [],
    stores: [],
    over: [],
    after: 0,
    destroyed: [],
    ...set,
  }
  return new Function(
    'w',
    `let { has_enemy, own_aloft, own_kills, crash_t, mission_done } = w;
     const { bandit, missiles, over } = w;
     const burning_stores = () => w.stores;
     const presenting = true, beat = 0.5, sim_time = 20, mission_zero = 5;
     const ownship = { fate: 'missile', struck: 2, throttle: 0.4 };
     const on_over = (r) => over.push(r);
     ${extra}
     ${names.map(lift).join('\n')}
     ${body}
     return { ...w, has_enemy, own_aloft, own_kills, crash_t, mission_done };`
  )(w) as World
}

describe('a joust the pilot has lost', () => {
  const pending = (set: Partial<World>) =>
    world(['joust_pending'], 'w.pending = joust_pending();', set) as World & {
      pending: boolean
    }

  it('waits on each thing he left that can still down the bandit', () => {
    expect(pending({}).pending).toBe(false)
    expect(
      pending({ missiles: [{ active: true, enemy: false }] }).pending,
      'his missile in the air'
    ).toBe(true)
    expect(pending({ own_aloft: 3 }).pending, 'his gun rounds in the air').toBe(
      true
    )
    expect(
      pending({
        bandit: {
          group: { visible: true },
          harm: { burning: true, fire: [0, 0] },
        },
      }).pending,
      'a fuel fire in the bandit'
    ).toBe(true)
    expect(
      pending({
        bandit: {
          group: { visible: true },
          harm: { burning: false, fire: [0, 0.2] },
        },
      }).pending,
      'an engine fire in the bandit'
    ).toBe(true)
    expect(
      pending({ stores: ['9m'] }).pending,
      'a round cooking on its rail'
    ).toBe(true)
  })

  it('waits on nothing that cannot', () => {
    expect(
      pending({ missiles: [{ active: true, enemy: true }] }).pending,
      "the bandit's own round"
    ).toBe(false)
    expect(
      pending({ missiles: [{ active: false, enemy: false }] }).pending,
      'a round already spent'
    ).toBe(false)
    expect(
      pending({ own_aloft: 3, has_enemy: false }).pending,
      'the bandit already down'
    ).toBe(false)
  })

  const fireball = (set: Partial<World>, steps: number, between = '') =>
    world(
      ['joust_pending', 'stand_down', 'fireball'],
      `for (let n = 0; n < ${steps}; n++) { if (!mission_done) fireball(1 / 60); ${between} }`, // as fly_player calls it
      set,
      'const battle_after = () => { w.after++; };'
    )

  it('holds the menu, and the bandit as his target, while his round is in the air', () => {
    const w = fireball({ missiles: [{ active: true, enemy: false }] }, 20) // ten seconds of wall time at half a second a step
    expect(w.mission_done).toBe(false)
    expect(w.crash_t).toBeGreaterThan(0)
    expect(w.has_enemy && w.bandit.group.visible).toBe(true)
    expect(w.after, 'the fight goes on without him').toBe(20)
    expect(w.over).toEqual([])
  })

  it('stands the bandit down and ends the mission once nothing he left can reach it', () => {
    const w = fireball(
      { missiles: [{ active: true, enemy: false }] },
      20,
      'if (n === 9) missiles[0].active = false;'
    )
    expect(w.mission_done).toBe(true)
    expect(w.has_enemy || w.bandit.group.visible).toBe(false)
    expect(w.over).toEqual([{ fate: 'missile', struck: 2, seconds: 15 }])
    expect(w.after).toBe(10)
  })

  it('ends as it always did when he left nothing flying', () => {
    const one = fireball({}, 1)
    expect(
      one.has_enemy || one.bandit.group.visible,
      'stood down at once'
    ).toBe(false)
    expect(one.mission_done, 'the fireball still plays').toBe(false)
    const w = fireball({}, 6)
    expect(w.mission_done).toBe(true)
    expect(w.over).toHaveLength(1)
    expect(w.after).toBe(0)
  })

  it('stands the bandit down at the crash itself only when nothing he left is flying', () => {
    expect(lift('crash_ownship')).toContain('stand_down();')
    expect(lift('crash_ownship')).not.toMatch(/has_enemy=false/)
  })
})

describe('the fight without him', () => {
  // after steps battle_after once, the core answering with what the test sets.
  const after = (flown: object, progress: number[]) =>
    world(
      ['bandit_struck', 'bandit_wounds', 'battle_after'],
      'battle_after(1 / 60); w.calls = calls;',
      { own_aloft: 9, flown, progress },
      `const calls = [], flown = w.flown, progress = w.progress;
       let battle_acc = 0, battle_tick = 0, burst_tick = 4;
       const BATTLE = { explode: 4 };
       const battle_fly = (dt, invulnerable, aim, since) => { calls.push(['fly', invulnerable, since]); return flown; };
       const battle_progress = (throttle, tick) => { calls.push(['progress', throttle, tick]); return progress; };
       const battle_aim = (st) => st, bandit_racks = () => calls.push(['racks']), cooked = () => {}, hit_sparks = () => {};
       const bandit_destroy = (why) => { w.destroyed.push(why); has_enemy = false; };
       const _v = { set: () => _v, applyQuaternion: () => _v, add: () => _v };`
    ) as World & { calls: unknown[][] }

  it('flies his rounds on against the bandit, through a jet that is no longer there', () => {
    const w = after(
      { impacts: [], bandit: 2, own: 0, aloft: { own: 5, bandit: 0 } },
      new Array(64).fill(0)
    )
    expect(w.calls[0]).toEqual(['fly', true, 4])
    expect(w.own_aloft, 'his rounds still flying').toBe(5)
    expect(w.bandit.struck).toBe(2)
    expect(w.calls).toContainEqual(['progress', 0.4, 0])
    expect(w.destroyed).toEqual([])
  })

  it('lets the fire he lit finish the bandit, and scores it', () => {
    const progress = new Array(64).fill(0)
    progress[8] = 1
    progress[10] = 4
    const w = after(
      { impacts: [], bandit: 0, own: 0, aloft: { own: 0, bandit: 0 } },
      progress
    )
    expect(w.destroyed).toEqual(['fire'])
    expect(w.own_kills).toBe(1)
    expect(
      w.calls.some((c) => c[0] === 'racks'),
      'no rails to keep on a jet gone'
    ).toBe(false)
  })
})

describe('his AMRAAM after he is shot down', () => {
  // supported runs step_amraam for one of the pilot's rounds with his radar
  // holding its track, and says whether the round was given support.
  const supported = (crash_t: number) => {
    const given: unknown[] = []
    new Function(
      'given',
      `let crash_t = ${crash_t};
       const bandit = { group: { visible: true }, pos: { x: 0, y: 0, z: 0 }, fwd: { x: 1, y: 0, z: 0 }, speed: 200 };
       const m = { target: bandit, track: 7, slot: 0, mesh: { visible: true } };
       const RADAR = { silent: () => false, stt: 7, tracks: [] };
       const stood = () => ({ x: 0, y: 0, z: 0 }), round_distract = () => false, round_drop = () => {}, post_round = () => {};
       const sim_time = 0, jammer_loud = () => false;
       const round_step = (slot, dt, support) => { given.push(support); return null; };
       ${lift('step_amraam')}
       step_amraam(m, 1 / 60);`
    )(given)
    return given[0] !== null
  }

  it('flies on its own seeker: a pilot shot down supports nothing, as the server has it', () => {
    expect(supported(0), 'alive, the datalink holds').toBe(true)
    expect(supported(3)).toBe(false)
  })
})

// A mutual kill: each jet downed, the second by what the first left flying. A
// match says so at its end, and a single-player flight's log row records it.
describe('a mutual kill', () => {
  // ended runs net_end on the results a match's end carries, and says what it
  // put on the glass.
  const ended = (results: object | null) => {
    const notices: string[] = []
    new Function(
      'notices',
      'results',
      `let session_over = false, running = false;
       const net_finish = () => {}, notice = (m) => notices.push(m), translate = (m) => m, onExit = null;
       ${lift('net_end')}
       net_end('finished', results);`
    )(notices, results)
    return notices
  }

  it('is what a match says when both jets went down, and only then', () => {
    expect(ended({ winner: -1, loser: -1, name: '' })).toEqual(['MUTUAL KILL'])
    expect(ended({ winner: 1, loser: 0, name: 'Viper' })).toEqual([
      'Viper WINS',
    ])
    expect(
      ended({ winner: -1, loser: 1, name: '' }),
      'the winner walked out, and the fallen jet still lost'
    ).toEqual(['SESSION ENDED'])
    expect(ended(null)).toEqual(['SESSION ENDED'])
  })

  // reason is the single-player flight's log row reason for its outcome.
  const reason = (traded: boolean, kills: number, deaths: number) =>
    new Function(
      `const traded = ${traded}, own_kills = ${kills}, own_deaths = ${deaths}; ${lift('sortie_reason')} return sortie_reason();`
    )() as string

  it("is a single-player flight's result, over the kill and the death it scores", () => {
    expect(reason(true, 1, 1)).toBe('traded')
    expect(reason(true, 0, 1), 'a midair').toBe('traded')
    expect(
      reason(false, 1, 1),
      'the bandit down, and the pilot lost on his own later'
    ).toBe('victory')
    expect(reason(false, 1, 0)).toBe('victory')
    expect(reason(false, 0, 1)).toBe('killed')
    expect(reason(false, 0, 0)).toBe('flown')
  })

  // pending runs bandit_pending in a single-player joust whose bandit fell
  // ten seconds into it, at the time given.
  const pending = (set: string, time = 10) =>
    new Function(
      `let MULTIPLAYER = false, has_enemy = false, bandit_aloft = 0, own_burning = false, own_burn = [0, 0];
       const cfg = { task: 'joust' }, bandit = { fate: 'verdict', wrecked: 10 }, ownship = {}, missiles = [], WRECKAGE = 5, sim_time = ${time};
       let stores = [];
       const burning_stores = (st) => (st === ownship ? stores : []);
       ${set}
       ${lift('bandit_pending')}
       return bandit_pending();`
    )() as boolean

  it('is the pilot falling while what the bandit left can still reach him', () => {
    expect(pending('', 12), 'its wreckage still falling').toBe(true)
    expect(pending('', 16), 'the cloud spent').toBe(false)
    expect(
      pending('missiles.push({ active: true, enemy: true });', 40),
      'its round in the air'
    ).toBe(true)
    expect(pending('bandit_aloft = 3;', 40), 'its gun rounds in the air').toBe(
      true
    )
    expect(pending('own_burning = true;', 40), 'a fuel fire in his jet').toBe(
      true
    )
    expect(pending('own_burn[0] = 0.3;', 40), 'an engine fire').toBe(true)
    expect(pending("stores = ['9m'];", 40), 'a round cooking on his rail').toBe(
      true
    )
    expect(
      pending('missiles.push({ active: true, enemy: false });', 40),
      'his own round'
    ).toBe(false)
  })

  it('is no such thing outside a single-player joust the bandit has lost', () => {
    expect(pending('has_enemy = true;', 12), 'the bandit still flying').toBe(
      false
    )
    expect(pending('bandit.fate = undefined;', 12)).toBe(false)
    expect(pending("cfg.task = 'free';", 12)).toBe(false)
    expect(pending('MULTIPLAYER = true;', 12)).toBe(false)
  })

  // crashed runs crash_ownship with the bandit fallen at `fated` as it fell,
  // and says whether the flight is a mutual kill.
  const crashed = (fate: string, wrecked: number | undefined) =>
    new Function(
      `let crash_t = 0, own_written = true, compression = 1, own_killer = '', own_deaths = 0, look_home = false, has_enemy = false, traded = false;
       let bandit_aloft = 0, own_aloft = 0, own_burning = false, own_burn = [0, 0];
       const MULTIPLAYER = false, sim_time = 20, WRECKAGE = 5, cfg = { task: 'joust' }, missiles = [];
       const ownship = { pos: { x: 0, y: 0, z: 0 }, group: { visible: true }, speed: 200 };
       const bandit = { group: { visible: false }, fate: ${JSON.stringify(fate)}, wrecked: ${wrecked} };
       const latch = () => {}, feed = () => {}, explosion_at = () => {}, burning_stores = () => [];
       ${lift('joust_pending')}
       ${lift('stand_down')}
       ${lift('bandit_pending')}
       ${lift('crash_ownship').replace(/ as any/g, '')}
       crash_ownship('missile', 'Bandit'); return traded;`
    )() as boolean

  it("is the pilot downed in the bandit's window, a midair included", () => {
    expect(
      crashed('verdict', 18),
      'two seconds after it, its wreckage still falling'
    ).toBe(true)
    expect(crashed('midair', 20), 'the same instant').toBe(true)
    expect(
      crashed('sea', undefined),
      'it left no wreckage and nothing else'
    ).toBe(false)
  })

  // destroyed runs bandit_destroy with the pilot's crash still burning or
  // not, and says whether the flight is a mutual kill and when the bandit's
  // wreckage was laid in the air.
  const destroyed = (crash_t: number, why = 'verdict') =>
    new Function(
      `let crash_t = ${crash_t}, traded = false, has_enemy = true;
       const bandit = { pos: { x: 0, y: 0, z: 0 }, group: { visible: true } }, sim_time = 5, cfg = {}, BANDIT = 'Bandit';
       const explosion_at = () => {}, flight_debris_lay = () => {}, feed = () => {}, opponent = () => '', notice = () => {}, translate = (t) => t;
       ${lift('bandit_destroy')}
       bandit_destroy(${JSON.stringify(why)}); return { traded, wrecked: bandit.wrecked };`
    )() as { traded: boolean; wrecked?: number }

  it('is the bandit downed after the pilot, by what he left flying', () => {
    expect(destroyed(3).traded).toBe(true)
    expect(
      destroyed(0).traded,
      'the bandit down first: the pilot flies on'
    ).toBe(false)
  })

  it("times the bandit's window from the wreckage it leaves in the air", () => {
    expect(destroyed(0).wrecked).toBe(5)
    expect(destroyed(0, 'sea').wrecked, 'none from the sea').toBeUndefined()
  })

  it("counts the bandit's gun rounds still in the air, as the pilot's", () => {
    const aloft = new Function(
      `let own_aloft = 0, bandit_aloft = 0;
       const bandit = { struck: 0 }, hit_sparks = () => {};
       ${lift('bandit_struck')}
       bandit_struck({ impacts: [], bandit: 0, aloft: { own: 2, bandit: 7 } });
       return [own_aloft, bandit_aloft];`
    )() as number[]
    expect(aloft).toEqual([2, 7])
  })
})
