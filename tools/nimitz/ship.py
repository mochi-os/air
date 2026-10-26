"""The Nimitz's deck layout, web/src/assets/nimitz.json: one file for engine.ts and every tool here,
so the catapults the jet flies, the tracks the bake paints and the cabs the build stands beside them
cannot drift apart. Deck frame, metres after the model's lateral squash: x forward, z to starboard;
headings in degrees, positive to port.

build_carrier.py writes the outline it traces (save); everything else in the file is set by hand."""
import json, math
from pathlib import Path
import numpy as np

PATH = Path(__file__).resolve().parents[2] / 'web' / 'src' / 'assets' / 'nimitz.json'
SHIP = json.loads(PATH.read_text())


def line(item):
    # z along a catapult (or anything with x, z, heading) at fore-aft f
    t = math.tan(math.radians(item['heading']))
    return lambda f: item['z'] - t * (f - item['x'])


def axes(item):
    # unit vectors along the heading (forward) and across it (to starboard)
    h = math.radians(item['heading'])
    along = np.array([math.cos(h), -math.sin(h)])
    return along, np.array([-along[1], along[0]])


OUTLINE = np.array(SHIP['outline'], np.float64)
_X, _Z = OUTLINE[:, 0], OUTLINE[:, 1]
_X2, _Z2 = np.roll(_X, -1), np.roll(_Z, -1)


def inside(f, l):
    # whether (f, l) lies on the deck: an even-odd test against the outline
    cross = (_Z > l) != (_Z2 > l)
    with np.errstate(divide='ignore', invalid='ignore'):
        xi = _X + (l - _Z) * (_X2 - _X) / np.where(_Z2 != _Z, _Z2 - _Z, 1)
    return (np.sum(cross & (f < xi)) % 2) == 1


def end(item, start):
    # where a catapult's line, walked forward from start in 0.1 m steps, leaves the deck
    run = line(item)
    f = start
    while f < 170.0:
        if not inside(f + 0.1, run(f + 0.1)):
            return f
        f += 0.1
    return f


def dumps(value, indent=0):
    # the file's own layout: objects one key a line, a list of objects one object a line, a list of
    # points eight to a line, anything else on one line
    pad = '  ' * indent
    if isinstance(value, dict):
        rows = [f'{pad}  {json.dumps(k)}: {dumps(v, indent + 1)}' for k, v in value.items()]
        return '{\n' + ',\n'.join(rows) + '\n' + pad + '}'
    if isinstance(value, list) and value and all(isinstance(v, dict) for v in value):
        return '[\n' + ',\n'.join(pad + '  ' + dumps(v, indent + 1) for v in value) + '\n' + pad + ']'
    if isinstance(value, list) and len(value) > 8 and all(isinstance(v, list) for v in value):
        rows = [', '.join(json.dumps(p) for p in value[i:i + 8]) for i in range(0, len(value), 8)]
        return '[\n' + ',\n'.join(pad + '  ' + r for r in rows) + '\n' + pad + ']'
    return json.dumps(value, ensure_ascii=False)


def save(ship):
    # write the file back when it changed; returns whether it did
    text = dumps(ship) + '\n'
    if PATH.read_text() == text:
        return False
    PATH.write_text(text)
    return True
