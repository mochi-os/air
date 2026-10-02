// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.
import { describe, expect, it } from 'vitest'
import * as M from './mids'

// Link 16 through the MIDS terminal (#99, NATOPS 2.13.5.2, 23.2.1, 23.6.2.2.2).
const live: M.Sense = { power: true, held: true, emission: false }
const member = (slot: number, team: string, more: Partial<M.Member> = {}): M.Member => ({ slot, team, sending: true, tracks: [], ...more })
const me = { slot: 0, team: 'blue', receiving: true }

describe('the terminal', () => {
  it('is on the net at a spawn', () => {
    expect([M.receiving(M.fresh(), live), M.sending(M.fresh(), live)]).toEqual([true, true])
  })
  it('neither sends nor receives with Link 16 off, without power or with its crypto variables gone', () => {
    for (const [t, s] of [[{ on: false }, live], [M.fresh(), { ...live, power: false }], [M.fresh(), { ...live, held: false }]] as [M.Terminal, M.Sense][])
      expect([M.receiving(t, s), M.sending(t, s)]).toEqual([false, false])
  })
  it('stops sending under EMCON and goes on receiving', () => {
    const quiet = { ...live, emission: true }
    expect([M.receiving(M.fresh(), quiet), M.sending(M.fresh(), quiet)]).toEqual([true, false])
  })
})

describe('a status off the wire', () => {
  it('reads the flags, the antenna and the tracks', () => {
    expect(M.read({ reply: true, challenge: false, link: true, antenna: 'lower', tracks: [2, 5] }, 63)).toEqual({ reply: true, challenge: false, link: true, antenna: 'lower', tracks: [2, 5] })
  })
  it('takes anything but true as false, and an antenna it does not know as BOTH', () => {
    expect(M.read({ reply: 1, challenge: 'yes', antenna: 'sideways' }, 63)).toEqual({ reply: false, challenge: false, link: false, antenna: 'both', tracks: [] })
  })
  it('keeps only whole slots under the limit, each once', () => {
    expect(M.read({ tracks: [3, 3, 2.5, -1, 63, '4', 7] }, 63).tracks).toEqual([3, 7])
    expect(M.read({ tracks: 'all' }, 63).tracks).toEqual([])
  })
  it('packs its flags and tracks into one array for the input datagram', () => {
    const s = (over: Partial<M.Status>): M.Status => ({ reply: false, challenge: false, link: false, antenna: 'both', tracks: [], ...over })
    expect(M.pack(s({}))).toEqual([0]); expect(M.pack(s({ reply: true }))).toEqual([1]); expect(M.pack(s({ challenge: true }))).toEqual([2]); expect(M.pack(s({ link: true }))).toEqual([4])
    expect(M.pack(s({ antenna: 'upper' }))).toEqual([8]); expect(M.pack(s({ antenna: 'lower' }))).toEqual([16])
    expect(M.pack({ reply: true, challenge: true, link: true, antenna: 'upper', tracks: [3, 12] })).toEqual([15, 3, 12])
  })
  it('stands at everything on for an aircraft nobody has reported for', () => {
    expect(M.STANDING).toEqual({ reply: true, challenge: true, link: true, antenna: 'both', tracks: [] })
  })
})

describe('the picture', () => {
  it('holds the members of the side that are sending', () => {
    const net = [member(0, 'blue'), member(1, 'blue'), member(2, 'blue', { sending: false }), member(3, 'red')]
    expect(M.picture(me, net)).toEqual({ members: [1], donated: [] })
  })
  it('adds the aircraft its members track, once each', () => {
    const net = [member(1, 'blue', { tracks: [3, 4] }), member(2, 'blue', { tracks: [4, 5] }), member(3, 'red'), member(4, 'red'), member(5, 'red')]
    expect(M.picture(me, net)).toEqual({ members: [1, 2], donated: [3, 4, 5] })
  })
  it('leaves out itself and the members it already has', () => {
    const net = [member(0, 'blue', { tracks: [3] }), member(1, 'blue', { tracks: [0, 2, 3] }), member(2, 'blue'), member(3, 'red')] // the net carries the pilot's own report too
    expect(M.picture(me, net)).toEqual({ members: [1, 2], donated: [3] })
  })
  it('takes no tracks from a member that is not sending, nor from the other side', () => {
    const net = [member(1, 'blue', { sending: false, tracks: [3] }), member(4, 'red', { tracks: [5] }), member(3, 'red'), member(5, 'blue', { sending: false })]
    expect(M.picture(me, net)).toEqual({ members: [], donated: [] })
  })
  it('is empty for an aircraft that is not receiving, or has no side', () => {
    const net = [member(1, 'blue', { tracks: [3] })]
    expect(M.picture({ ...me, receiving: false }, net)).toEqual({ members: [], donated: [] })
    expect(M.picture({ ...me, team: '' }, [member(1, '', { tracks: [3] })])).toEqual({ members: [], donated: [] })
  })
})
