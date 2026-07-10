#!/usr/bin/env python3
"""Splice the freshly traced outline.json into engine.ts SHIP.outline (the physics
polygon must match the drawn deck strip — same source of truth)."""
import json

ENGINE='/home/alistair/mochi/apps/furball/web/src/game/engine.ts'
O=json.load(open('outline.json'))
pts=','.join(f"[{f},{l}]" for f,l in O['OUT'])
s=open(ENGINE).read()
i1=s.find('outline:[')
i2=s.find('] } };', i1)
assert i1>0 and i2>i1, "outline anchor not found"
s=s[:i1]+'outline:[ '+pts+' '+s[i2:]
open(ENGINE,'w').write(s)
print(f"spliced {len(O['OUT'])} points into SHIP.outline")
