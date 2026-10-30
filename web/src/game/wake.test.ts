// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import nimitz from '../assets/nimitz.json'
import {
  AGE,
  BAND,
  GROUP,
  GROUPS,
  LAID,
  LANE,
  POINTS,
  REACH,
  STEP,
  STREAK,
  WAKE,
  WANDER,
  Wake,
  before,
  hull,
  point,
  reading as carrier_reading,
  type Pose,
} from './wake'

// The carrier's bow wave and wake: the sea's shader draws them from the path
// her stern swept, which Wake keeps from the ship's pose on the clock that
// poses her, and from her waterline in the ship file.
const source = readFileSync(
  fileURLToPath(new URL('./engine.ts', import.meta.url)),
  'utf8'
)
const waterline = nimitz.waterline
const length = waterline.stem - waterline.stern

// A ship steaming steadily on heading h at speed v, at the origin at time 0;
// or turning to port at v/700 rad/s from time 0, straight before it.
function steady(h: number, v: number) {
  return (t: number): Pose => ({
    x: Math.cos(h) * v * t,
    z: -Math.sin(h) * v * t,
    heading: h,
    speed: v,
  })
}
function turning(v: number) {
  const rate = v / 700
  return (t: number): Pose => {
    if (t < 0) return steady(0, v)(t)
    const h = rate * t
    return {
      x: 700 * Math.sin(h),
      z: 700 * (Math.cos(h) - 1),
      heading: h,
      speed: v,
    }
  }
}
function drawn(wake: Wake, time: number, now: Pose) {
  const points = new Float32Array(POINTS * 4)
  const speeds = new Float32Array(Math.ceil(POINTS / 4) * 4)
  const groups = new Float32Array(GROUPS * 4)
  const result = wake.path(time, now, waterline, points, speeds, groups)
  const at = (i: number) => ({
    x: points[i * 4],
    z: points[i * 4 + 1],
    run: points[i * 4 + 2],
    age: points[i * 4 + 3],
    speed: speeds[i],
  })
  return { ...result, points, speeds, groups, at }
}

describe("the ship file's waterline", () => {
  it('runs from the stern to the stem in stations, port inside starboard, a fine bow to a point', () => {
    expect(waterline.stem - waterline.stern).toBeCloseTo(313.87, 1) // the Nimitz's 317 m at the waterline, as the model is built
    expect(waterline.sides.length).toBeGreaterThan(2)
    expect(waterline.sides.length).toBeLessThanOrEqual(2 * 21)
    for (const [port, starboard] of waterline.sides)
      expect(port).toBeLessThanOrEqual(starboard)
    const stem = waterline.sides[waterline.sides.length - 1]
    expect(stem[1] - stem[0]).toBeLessThan(0.5)
  })
  it('is packed for the shader two stations to a vec4, with its span and its greatest breadth', () => {
    const shape = hull(waterline)
    expect(shape.span).toEqual([
      waterline.stern,
      waterline.stem,
      length / (waterline.sides.length - 1),
      waterline.sides.length,
    ])
    waterline.sides.forEach(([port, starboard], i) => {
      expect(shape.stations[i * 2]).toBeCloseTo(port, 4)
      expect(shape.stations[i * 2 + 1]).toBeCloseTo(starboard, 4)
    })
    expect(shape.beam).toBeCloseTo(38.54, 2)
  })
})

describe('where the ship has been', () => {
  it('places a point of her own frame forward along her heading and to starboard', () => {
    const pose = { x: 100, z: -50, heading: 0.4, speed: 0 }
    const ahead = point(pose, 10, 0)
    expect(ahead.x - 100).toBeCloseTo(10 * Math.cos(0.4), 9)
    expect(ahead.z + 50).toBeCloseTo(-10 * Math.sin(0.4), 9)
    const starboard = point(pose, 0, 10)
    expect(
      (starboard.x - 100) * Math.cos(0.4) - (starboard.z + 50) * Math.sin(0.4)
    ).toBeCloseTo(0, 9) // square to the heading
  })
  it('takes her as steaming steadily on before her track begins', () => {
    const ship = steady(0.7, 15.4)
    const back = before(ship(0), 40)
    const want = ship(-40)
    expect(back.x).toBeCloseTo(want.x, 9)
    expect(back.z).toBeCloseTo(want.z, 9)
    expect(back.heading).toBe(0.7)
  })
  it('samples her every STEP seconds back AGE, and only the new samples as time goes on', () => {
    const wake = new Wake()
    let asked = 0
    const ship = steady(0.3, 2.6)
    const counted = (t: number) => (asked++, ship(t))
    wake.follow(1000.5, counted)
    expect(wake.times[0]).toBeLessThanOrEqual(1000.5 - AGE)
    expect(wake.times[wake.times.length - 1]).toBe(1000)
    for (let i = 1; i < wake.times.length; i++)
      expect(wake.times[i] - wake.times[i - 1]).toBeCloseTo(STEP, 9)
    asked = 0
    wake.follow(1004.1, counted)
    expect(asked).toBe(2)
    expect(wake.times[wake.times.length - 1]).toBe(1004)
    expect(wake.times[0]).toBeLessThanOrEqual(1004.1 - AGE)
    expect(wake.times[1]).toBeGreaterThan(1004.1 - AGE)
  })
  it('starts over when the clock goes back, or leaps past the whole wake', () => {
    const wake = new Wake()
    wake.follow(500, steady(0, 15.4))
    const other = steady(1.0, 2.6)
    wake.follow(20, other)
    expect(wake.times[wake.times.length - 1]).toBe(20)
    expect(wake.poses[wake.poses.length - 1].heading).toBe(1.0)
    wake.follow(20 + AGE + 10, steady(2.0, 2.6))
    expect(wake.poses.every((pose) => pose.heading === 2.0)).toBe(true)
  })
  it('reads a speed the source does not give off where she went', () => {
    const wake = new Wake()
    const ship = steady(0.5, 7)
    wake.follow(100, (t) => ({ ...ship(t), speed: NaN }))
    for (const pose of wake.poses) expect(pose.speed).toBeCloseTo(7, 6)
  })
})

describe('the path the stern swept', () => {
  it('runs back from her stern now along her track, the run along it the distance sailed', () => {
    const ship = steady(0.4, 15.4)
    const wake = new Wake()
    wake.follow(2000.7, ship)
    const now = ship(2000.7)
    const path = drawn(wake, 2000.7, now)
    expect(path.count).toBe(POINTS)
    const lateral = (waterline.sides[0][0] + waterline.sides[0][1]) / 2
    for (let i = 0; i < POINTS; i++) {
      const p = path.at(i)
      const stern = point(ship(2000.7 - p.age), waterline.stern, lateral)
      expect(p.x).toBeCloseTo(stern.x - now.x, 2)
      expect(p.z).toBeCloseTo(stern.z - now.z, 2)
      expect(p.run).toBeCloseTo(15.4 * p.age, 2)
      expect(p.speed).toBeCloseTo(15.4, 4)
    }
    expect(path.at(POINTS - 1).age).toBe(AGE)
    expect(path.at(1).age).toBeLessThan(STEP) // closer together near the ship
  })
  it('has no two points together while she moves, between her newest sample and now as anywhere', () => {
    // A stretch of no length reads every point square to it as on the track: a line drawn across the sea.
    const ship = steady(1.1, 2.6)
    const wake = new Wake()
    for (const time of [300, 300.3, 301.9, 302.0, 305.5]) {
      wake.follow(time, ship)
      const path = drawn(wake, time, ship(time))
      for (let i = 1; i < path.count; i++) {
        const a = path.at(i - 1)
        const b = path.at(i)
        expect(
          Math.hypot(b.x - a.x, b.z - a.z),
          `${time} s, stretch ${i}`
        ).toBeGreaterThan(0.5)
      }
    }
  })
  it('bends through her turn: every point astern in it lies on the circle her stern sweeps', () => {
    const ship = turning(15.4)
    const wake = new Wake()
    const time = 150
    wake.follow(time, ship)
    const now = ship(time)
    const path = drawn(wake, time, now)
    const lateral = (waterline.sides[0][0] + waterline.sides[0][1]) / 2
    const radius = Math.hypot(700 + lateral, waterline.stern) // the stern sits off the reference point the turn is about
    let inside = 0
    for (let i = 0; i < path.count; i++) {
      const p = path.at(i)
      if (p.age > time) continue
      const r = Math.hypot(p.x + now.x, p.z + now.z + 700)
      expect(r, `point ${i}, ${Math.round(p.age)} s ago`).toBeCloseTo(radius, 0)
      inside++
    }
    expect(inside).toBe(19) // the points 150 s old or less: ages AGE (i / 40)^2
  })
  it('stands still with a ship that does', () => {
    const wake = new Wake()
    const ship = steady(0.2, 0)
    wake.follow(60, ship)
    const path = drawn(wake, 60, ship(60))
    for (let i = 1; i < path.count; i++)
      expect(
        Math.hypot(path.at(i).x - path.at(0).x, path.at(i).z - path.at(0).z)
      ).toBeLessThan(1e-6)
    expect(path.speed).toBe(0)
  })
  it('groups its stretches in circles that hold them, each reaching as far as its Kelvin waves and its wash', () => {
    const ship = steady(2.2, 15.4)
    const wake = new Wake()
    wake.follow(900, ship)
    const path = drawn(wake, 900, ship(900))
    const beam = hull(waterline).beam
    for (let k = 0; k < GROUPS; k++) {
      const [x, z, radius, reach] = path.groups.slice(k * 4, k * 4 + 4)
      for (
        let i = k * GROUP;
        i <= Math.min((k + 1) * GROUP, path.count - 1);
        i++
      ) {
        expect(
          Math.hypot(path.at(i).x - x, path.at(i).z - z)
        ).toBeLessThanOrEqual(radius + 1e-3)
      }
      const end = path.at(Math.min((k + 1) * GROUP, path.count - 1)).run
      expect(reach).toBeGreaterThanOrEqual(
        0.3536 * Math.min(end + length, REACH * length) - 1e-3
      )
      expect(reach).toBeGreaterThanOrEqual(
        BAND * beam * (0.8 + 0.45 * Math.sqrt(AGE / 60))
      )
      // and the circle about everything holds each group's reach and the bow
      expect(
        Math.hypot(x - path.centre[0], z - path.centre[1]) + radius + reach
      ).toBeLessThanOrEqual(path.radius + 1e-3)
    }
    expect(
      Math.hypot(path.centre[0], path.centre[1]) + length
    ).toBeLessThanOrEqual(path.radius)
    expect(path.reach).toBe(REACH * length)
  })
  it("marks the groups past a short path's end empty", () => {
    const ship = steady(0, 15.4)
    const wake = new Wake()
    wake.follow(10, (t) => (t < 4 ? null : ship(t))) // nothing known before 4 s
    const path = drawn(wake, 10, ship(10))
    expect(path.count).toBeLessThan(POINTS)
    const empty = Math.floor((path.count - 1) / GROUP) + 1
    for (let k = empty; k < GROUPS; k++) expect(path.groups[k * 4 + 2]).toBe(-1)
  })
})

describe("the wash's pattern, laid in the water", () => {
  const lateral = (waterline.sides[0][0] + waterline.sides[0][1]) / 2
  it('counts her stern on as she steams, so a place in the water reads the same however far she has gone', () => {
    // The shader reads the wash's streaks at travelled less the run back from the stern: for the water her
    // stern passed at a moment, that must not change as she steams on.
    const ship = steady(0.6, 15.4)
    const wake = new Wake()
    const passed = 95 // s: the moment her stern passed the water looked at
    let place = NaN
    for (const time of [100, 100.016, 100.5, 101.25, 103, 110, 140]) {
      wake.follow(time, ship)
      const path = drawn(wake, time, ship(time))
      const run = 15.4 * (time - passed) // how far back along her path that water now lies
      const here = path.travelled - run
      if (Number.isNaN(place)) place = here
      expect(here, `${time} s`).toBeCloseTo(place, 6)
    }
  })
  it('counts the way her stern goes through a turn, on its wider circle', () => {
    const ship = turning(15.4)
    const wake = new Wake()
    const radius = Math.hypot(700 + lateral, waterline.stern)
    let first = NaN
    for (let time = 20; time <= 60; time += 1 / 60) {
      wake.follow(time, ship)
      const path = drawn(wake, time, ship(time))
      if (Number.isNaN(first)) first = path.travelled
      if (time > 59.99)
        expect(path.travelled - first).toBeCloseTo(
          (radius * 15.4 * (time - 20)) / 700,
          1
        )
    }
  })
  it('starts over with the wake, and starts again unseen past whole repeats of its streaks and their wandering', () => {
    const ship = steady(0, 15.4)
    const wake = new Wake()
    wake.follow(100, ship)
    drawn(wake, 100, ship(100))
    wake.follow(150, ship)
    expect(drawn(wake, 150, ship(150)).travelled).toBeCloseTo(15.4 * 50, 6)
    wake.follow(20, ship) // a replay sought back
    expect(drawn(wake, 20, ship(20)).travelled).toBe(0)
    wake.follow(5000, ship) // a leap past the whole wake
    expect(drawn(wake, 5000, ship(5000)).travelled).toBe(0)
    expect(LAID % STREAK).toBe(0)
    expect(LAID % WANDER).toBe(0)
    expect(LAID % LANE).toBe(0)
    const far = new Wake()
    far.travelled = LAID - 10
    far.mark = { ...point(ship(0), waterline.stern, lateral), time: 0 }
    far.follow(1, ship)
    expect(drawn(far, 1, ship(1)).travelled).toBeCloseTo(5.4, 6)
  })
  it('is read where it lies in the water: the streaks at the travelled place, the lumps and boils on the sea chart', () => {
    expect(WAKE).toContain('float water=u_wake_travelled-along,')
    expect(WAKE).toContain(`vec2(water/${STREAK}.0,side/30.0)`)
    expect(WAKE).toContain(`vec2(water/${LANE}.0,side/90.0)`)
    expect(WAKE).toContain(`vec2(water/${WANDER}.0,0.31)`)
    expect(WAKE).toContain('vec2 world=p+u_wake_origin+u_chart;')
    expect(WAKE).not.toMatch(/along\/\d/) // nothing laid along the run back from her stern now
    expect(WAKE).not.toMatch(/texture2D\(u_detail,p\//) // nor about where she is now
    expect(source).toContain('u.u_wake_travelled.value=drawn.travelled;')
  })
})

describe('what the shader draws at steerage way, and the sea breaking on her', () => {
  // The shader's own expressions, evaluated: speed in m/s, sea the wind's speed.
  const smoothstep = (a: number, b: number, x: number) => {
    const t = Math.min(Math.max((x - a) / (b - a), 0), 1)
    return t * t * (3 - 2 * t)
  }
  const clamp = (x: number, a: number, b: number) => Math.min(Math.max(x, a), b)
  const between = (from: string, to: string) => {
    const start = WAKE.indexOf(from)
    expect(start, from).toBeGreaterThan(-1)
    return WAKE.slice(start + from.length, WAKE.indexOf(to, start))
  }
  const expression =
    (text: string, ...names: string[]) =>
    (...values: number[]) =>
      new Function(
        'smoothstep',
        'clamp',
        'max',
        'min',
        'exp',
        'sqrt',
        'mix',
        ...names,
        `return ${text}`
      )(
        smoothstep,
        clamp,
        Math.max,
        Math.min,
        Math.exp,
        Math.sqrt,
        (a: number, b: number, t: number) => a + (b - a) * t,
        ...values
      ) as number
  const churn = expression(between(' churn=', ', slow='), 'speed')
  const push = expression(between(' push=', ', breaking='), 'v')
  const breaking = expression(between(' breaking=', ';'), 'sea')
  const smooth = expression(between('\t\t\tslick=', '*exp(-age/calm)'), 'speed')
  const lasting = (name: string, to: string) => {
    const f = expression(between(` ${name}=`, to), 'sea', 'slow')
    return (speed: number, sea: number) => f(sea, Math.max(speed, 0.3)) * speed // metres astern it lasts, e-folding
  }
  const white = lasting('white', ', green=')
  const green = lasting('green', ', calm=')
  const calm = lasting('calm', ';')
  const trades = 12.9
  it('churns the water at steerage way a third as hard as at full speed, not a fiftieth', () => {
    expect(churn(0)).toBe(0)
    expect(churn(2.6)).toBeGreaterThan(0.3)
    expect(churn(2.6)).toBeLessThan(0.5)
    expect(churn(15.4)).toBe(1)
    expect(push(0)).toBe(0)
    expect(push(2.6)).toBeGreaterThan(0.45)
    expect(push(15.4)).toBe(1)
    expect(smooth(2.6)).toBeGreaterThan(0.5)
    expect(smooth(15.4)).toBe(1)
  })
  it('lasts at steerage way as far as the screws go on churning it, and at speed as long as the sea lets it', () => {
    expect(white(2.6, trades)).toBeGreaterThanOrEqual(100)
    expect(green(2.6, trades)).toBeGreaterThanOrEqual(300)
    expect(calm(2.6, trades)).toBeGreaterThanOrEqual(600)
    expect(white(15.4, trades)).toBeCloseTo((35 / (1 + trades / 20)) * 15.4, 6)
    expect(green(15.4, trades)).toBeCloseTo((70 / (1 + trades / 20)) * 15.4, 6)
    expect(calm(15.4, trades)).toBeCloseTo(
      (1200 / (1 + (trades * trades) / 25)) * 15.4,
      6
    )
  })
  it('breaks the sea white on her in a working breeze and never in a calm', () => {
    expect(breaking(0)).toBe(0)
    expect(breaking(5)).toBe(0)
    expect(breaking(trades)).toBeGreaterThan(0.8)
    expect(WAKE).toContain('if((push>0.0||breaking>0.0)&&')
    expect(WAKE).toContain(
      'float phase=-dot(world,u_downwind)/wavelength+u_time*sea_drift(vec2(pace/wavelength,0.0)).x+texture2D(u_detail,world/170.0).b-0.5;'
    ) // crests laid in the water, running downwind, seamless as the sea's clock wraps, their lines wandering
  })

  // The flight deck overhangs the bow's waterline (13 m past the stem, 12 m and more to either side), so what
  // the bow does is seen from above only where it reaches out past the deck's edge.
  const deck = nimitz.outline as number[][]
  const tip = Math.max(...deck.map((p) => p[0])) - waterline.stem
  const stem = waterline.sides[waterline.sides.length - 1]
  const middle = (stem[0] + stem[1]) / 2
  const across = (fore: number, board: number, points: number[][]) => {
    // how far out from the stem's centre line an outline reaches, to starboard (board 1) or port (-1), at a station
    let most = 0
    points.forEach((a, i) => {
      const b = points[(i + 1) % points.length]
      if ((a[0] - fore) * (b[0] - fore) > 0 || a[0] === b[0]) return
      const z = a[1] + ((b[1] - a[1]) * (fore - a[0])) / (b[0] - a[0])
      most = Math.max(most, board * (z - middle))
    })
    return most
  }
  const step = (waterline.stem - waterline.stern) / (waterline.sides.length - 1)
  const hull = waterline.sides.flatMap((side, i) => [
    [waterline.stern + i * step, side[0]],
    [waterline.stern + i * step, side[1]],
  ])
  const flank = (fore: number, board: number) => {
    // the waterline's z at a station, to one side, from the centre line
    const k = Math.min(
      Math.floor((fore - waterline.stern) / step),
      waterline.sides.length - 2
    )
    const f = (fore - waterline.stern) / step - k
    const j = board > 0 ? 1 : 0
    const z =
      waterline.sides[k][j] +
      (waterline.sides[k + 1][j] - waterline.sides[k][j]) * f
    return board * (z - middle)
  }
  const wide = expression(between(' wide=', ','), 'v')
  const broken = expression(between(' broken=', ','), 'v')
  const course = expression(between(' course=', ';'), 'back', 'v')
  // how far past the deck's edge the crests' white reaches, at its furthest along the stretch where they break hard,
  // on the side where it reaches least
  const past = (v: number) =>
    Math.min(
      ...[1, -1].map((board) => {
        let most = -Infinity
        for (let back = 1; back < 0.5 * broken(v); back++) {
          const fore = waterline.stem - back
          most = Math.max(
            most,
            flank(fore, board) +
              course(back, v) +
              wide(v) -
              across(fore, board, deck)
          )
        }
        return most
      })
    )
  it('at speed throws its bow wave out past the deck: crests peeling off the hull from the stem and flaring out', () => {
    expect(tip).toBeGreaterThan(12)
    expect(hull.length).toBe(2 * waterline.sides.length)
    expect(course(0, 15.4)).toBe(0) // they start at the hull, not out from it
    expect(past(15.4)).toBeGreaterThan(5)
    expect(broken(15.4)).toBeGreaterThan(
      0.2 * (waterline.stem - waterline.stern)
    )
    expect(WAKE).toContain(
      'cap=1.0-smoothstep(0.3*wide,wide,length(vec2(1.5*back,across-middle)));'
    )
    expect(wide(15.4) / 1.5).toBeLessThan(0.5 * tip) // and the white ahead of the stem is a collar about it, no more
  })
  it('at steerage way keeps it under the deck, as the real ship does', () => {
    expect(past(2.6)).toBeLessThan(0)
  })
  it("throws the sea's white out off her from the hull as it falls back, left behind as she steams on", () => {
    const spread = expression(
      between(', spread=', ';'),
      'breaking',
      'exposed',
      'since'
    )
    const burst = expression(
      between('float burst=', ';'),
      'breaking',
      'exposed',
      'hard',
      'since'
    )
    const b = breaking(trades)
    expect(spread(b, 1, 0)).toBeLessThanOrEqual(1.5) // it starts at the hull
    expect(spread(b, 1, 2)).toBeGreaterThan(6) // and is thrown out off the bow
    expect(spread(b, 0, 2)).toBeLessThanOrEqual(1.5) // but runs along her flanks
    expect(burst(b, 1, 1, 0)).toBe(0) // it whitens, it does not switch on
    expect(burst(b, 1, 1, 0.3)).toBeLessThan(burst(b, 1, 1, 0.8))
    expect(burst(b, 0, 1, 1)).toBeLessThan(0.5 * burst(b, 1, 1, 1)) // less on her flanks than at the bow
    expect(WAKE).toContain('float then=fore+v*since;') // the water it lies in was that much further forward along her when the crest struck
    // and gone before the next crest strikes, so nothing vanishes as it does
    const pace = 0.8 * trades
    const period = (2 * Math.PI * pace) / 9.81 // the wavelength 2 pi c^2 / g over the crests' speed
    expect(burst(b, 1, 1, period)).toBeLessThan(0.08)
  })
  it("lays the wash's white in patches fixed in the water, which go out one by one as it ages, at any distance it is seen from", () => {
    const cover = expression(
      between('float cover=', ';'),
      'fresh',
      'lumps',
      'px'
    )
    // A patch is white while its noise stands above what the freshness has fallen to, close to (pixels a few
    // centimetres across) and from afar (metres across) alike: what is white is decided by the water itself.
    for (const px of [0.1, 3, 6]) {
      expect(cover(0.4, 0.9, px), `${px} m`).toBeGreaterThan(0.9)
      expect(cover(0.4, 0.3, px), `${px} m`).toBeLessThan(0.1)
    }
    // Only past what even the long patches resolve is it the share they would cover, which never steps.
    const far = [0.2, 0.35, 0.5, 0.65, 0.8].map((f) => cover(f, 0.5, 40))
    for (let i = 1; i < far.length; i++) {
      expect(far[i]).toBeGreaterThan(far[i - 1])
      expect(far[i] - far[i - 1]).toBeLessThan(0.35)
    }
    // The patches are the finest the pixel resolves: lumps close to, the long patches streaked along the track
    // from afar, both in the water.
    expect(WAKE).toContain('float lumps=mix(fine,coarse,smoothstep(0.5,3.0,px));')
    expect(WAKE).toContain(
      'float coarse=clamp(0.5+4.0*(0.5*lanes+0.5*texture2D(u_detail,world/240.0).b-0.5),0.0,1.0);'
    )
    // and how long the white lasts goes with its age alone, with no lengths of it ending at a set distance behind her
    expect(WAKE).toContain(
      'float fresh=clamp(1.6*sqrt(churn)*exp(-age/white),0.0,1.0);'
    )
  })
})

describe('the Kelvin waves the shader draws', () => {
  // The shader's two roots, the transverse and the divergent wave whose phase is stationary at a point a
  // ratio r off the track: tan(theta) = t solving t / (1 + 2 t^2) = r. Both meet at the wedge's edge.
  const roots = (r: number) => {
    const disc = Math.sqrt(Math.max(1 - 8 * r * r, 0))
    return [(2 * r) / (1 + disc), (1 + disc) / (4 * r)]
  }
  it("are the shader's own expressions", () => {
    expect(WAKE).toContain('y<0.3536*x')
    expect(WAKE).toContain('disc=sqrt(max(1.0-8.0*r*r,0.0))')
    expect(WAKE).toContain(
      'float t=2.0*r/(1.0+disc), q=sqrt(1.0+t*t), phase=k0*(x-y*t)*q;'
    )
    expect(WAKE).toContain(
      't=(1.0+disc)/(4.0*max(r,1.0e-4)); q=sqrt(1.0+t*t); phase=k0*(x-y*t)*q;'
    )
    expect(WAKE.match(/\*sin\(phase\)\*\(dir-off\*t\)\/q;/g)?.length).toBe(2)
    expect(WAKE).toContain('k0=9.81/max(speed*speed,0.25)')
  })
  it('meet a point inside the 19.47 degree wedge with the phase and slope of the wave stationary there', () => {
    for (const r of [0.01, 0.1, 0.2, 0.3, 0.35]) {
      for (const t of roots(r)) {
        expect(t / (1 + 2 * t * t)).toBeCloseTo(r, 9)
        // A wave at angle a to the track, x = 1 astern and y = r off it, has phase (x cos a + y sin a) / cos^2 a
        // (over k0). It is stationary at a = -atan(t), where the shader's phase (x - y t) q must equal it, and
        // the phase's gradient - the slope's direction - runs along (1, -t).
        const phase = (a: number, x = 1, y = r) =>
          (x * Math.cos(a) + y * Math.sin(a)) / Math.cos(a) ** 2
        const a = -Math.atan(t)
        expect((phase(a + 1e-6) - phase(a - 1e-6)) / 2e-6).toBeCloseTo(0, 4)
        const q = Math.sqrt(1 + t * t)
        expect((1 - r * t) * q).toBeCloseTo(phase(a), 9)
        const gradient = [
          (phase(a, 1 + 1e-6) - phase(a, 1 - 1e-6)) / 2e-6,
          (phase(a, 1, r + 1e-6) - phase(a, 1, r - 1e-6)) / 2e-6,
        ]
        expect(gradient[1] / gradient[0]).toBeCloseTo(-t, 6)
      }
    }
    expect(Math.atan(Math.sqrt(1 / 8)) * (180 / Math.PI)).toBeCloseTo(19.47, 2)
    const [a, b] = roots(0.3536)
    expect(a).toBeCloseTo(b, 2)
  })
  it('run along the track at the wavelength 2 pi v^2 / g', () => {
    const v = 15.4
    const k0 = 9.81 / (v * v)
    const [t] = roots(1e-9)
    const q = Math.sqrt(1 + t * t)
    expect((2 * Math.PI) / (k0 * q * q)).toBeCloseTo(
      (2 * Math.PI * v * v) / 9.81,
      6
    ) // 152 m at 30 kt
  })
  it('read as many stretches and groups as the path carries', () => {
    expect(GROUPS * GROUP).toBe(POINTS - 1)
    expect(WAKE).toContain(`uniform vec4 u_wake[${POINTS}]`)
    expect(WAKE).toContain(`uniform vec4 u_wake_group[${GROUPS}]`)
    expect(WAKE).toContain(`for(int j=0;j<${GROUP};j++)`)
  })
})

describe("the engine's wake", () => {
  it("reads the ship's speed and how far back her track is known from the core", () => {
    expect(carrier_reading([1, 2, 0.3, 1, 15.4, 120])).toEqual({
      x: 1,
      z: 2,
      heading: 0.3,
      closed: true,
      speed: 15.4,
      known: 120,
    })
    expect(carrier_reading([1, 2, 0.3, 0, 2.6, -Infinity])?.known).toBe(
      -Infinity
    )
    const older = carrier_reading([1, 2, 0.3, 0]) // a core that predates them
    expect(older?.speed).toBeNaN()
    expect(older?.known).toBe(-Infinity)
    expect(carrier_reading([1, NaN, 0, 0])).toBeNull()
    expect(carrier_reading(null)).toBeNull()
  })
  it('takes her as steaming steadily on before the earliest time her track covers', () => {
    const lift = (name: string) => {
      const start = source.search(new RegExp(`function ${name}\\(`))
      let depth = 0
      for (let i = source.indexOf('{', start); i < source.length; i++) {
        if (source[i] === '{') depth++
        else if (source[i] === '}' && --depth === 0)
          return source.slice(start, i + 1)
      }
      throw new Error(name)
    }
    const known = 50
    const ship = steady(0.9, 15.4)
    // the core's track begins at 50 s with a turn: carried back, it would circle
    const core = (t: number) =>
      t >= known
        ? { ...ship(t), closed: false, known }
        : { x: 0, z: 0, heading: 9, speed: 15.4, closed: false, known }
    const ship_known = new Function(
      'flight_carrier',
      'wake_before',
      `${lift('ship_known')}; return ship_known;`
    )(core, before)
    expect(ship_known(80)).toMatchObject(ship(80))
    const back = ship_known(10)
    expect(back.x).toBeCloseTo(ship(10).x, 6)
    expect(back.z).toBeCloseTo(ship(10).z, 6)
    expect(back.heading).toBe(0.9)
  })
  it("draws the recording's ship in a replay, her heading from its compass yaw", () => {
    const lift = (name: string) =>
      source.slice(
        source.search(new RegExp(`function ${name}\\(`)),
        source.indexOf(
          '\n',
          source.indexOf(
            'return s?',
            source.search(new RegExp(`function ${name}\\(`))
          )
        )
      )
    const scene = () => [
      {
        x: 0,
        z: 0,
        yaw: 10,
        vx: 1,
        vz: 0,
        properties: { Type: 'Air+FixedWing' },
      },
      {
        x: 5,
        z: 6,
        yaw: 70,
        vx: -3,
        vz: 4,
        properties: { Type: 'Sea+Watercraft+AircraftCarrier' },
      },
    ]
    const recorded = new Function(
      'playback',
      'playback_scene',
      'D2R',
      `${lift('ship_recorded')}\nreturn ship_recorded;`
    )({}, scene, Math.PI / 180)
    const pose = recorded(12)
    expect(pose).toMatchObject({ x: 5, z: 6, speed: 5 })
    expect(pose.heading).toBeCloseTo(Math.PI / 2 - (70 * Math.PI) / 180, 9) // as the replay poses the ship
    expect(source).toContain('carrier_place(pose,pose.yaw*D2R)')
    expect(source).toMatch(
      /function carrier_place\(at,yaw\)\{[^\n]*heading=Math\.PI\/2-yaw;/
    )
    const none = new Function(
      'playback',
      'playback_scene',
      'D2R',
      `${lift('ship_recorded')}\nreturn ship_recorded;`
    )({}, () => [scene()[0]], Math.PI / 180)
    expect(none(12)).toBeNull() // a recording made before the ship sailed
  })
  it('lays the wake each frame once the camera is placed, and the sea draws it', () => {
    const frame = source.slice(
      source.indexOf('function frame(){'),
      source.indexOf('render_frame();', source.indexOf('function frame(){'))
    )
    expect(frame).toMatch(
      /if\(ocean\)\{ ocean\.position\.x=camera\.position\.x; ocean\.position\.z=camera\.position\.z; \}\n\twake_frame\(\);/
    )
    const sea = source.slice(
      source.indexOf('const ocean_mat'),
      source.indexOf('// The FFT sea (waves.ts)')
    )
    expect(sea).toContain('`+SEA_TURN+`\n\t\t`+WAKE+`')
    expect(sea).toContain('vec2 wake_off=v_world.xz-u_wake_origin;') // turned into the axes her track is laid in
    expect(sea).toContain('wake_at(wake_off,')
    expect(sea).toContain('lean=lean*(1.0-0.8*wake_slick)+wake_lean;')
    expect(sea).toContain('float foam=max(max(spill,caps*0.9),wake_foam);')
    expect(sea).toContain('cover=max(cover,clamp(wake_foam,0.0,1.0));')
    expect(sea).toContain('rw*=mix(1.0,0.55,wake_slick);')
    expect(sea).toContain(
      'body=mix(body,vec3(0.30,0.60,0.58)*(0.75+0.25*diff),wake_air*0.6);'
    )
    expect(sea).toContain('exp(-dist/6000.0)*(1.0-wake_slick);')
  })
})
