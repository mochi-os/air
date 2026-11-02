# Gerald R. Ford (CVN-78)

Our own model of the carrier, built from cited sources (`claude/plans/air-ford.md`). It replaces the Nimitz,
whose files it never opens: `test_build.py` fails on any line of code here that names them or
`apps/air/downloads`.

## Sources

Every source is listed in `references.json` with its licence and use: `trace` (a US government work or
CC0 imagery, may be traced and matched), `facts` (its numbers may be cited, never its figures) or `look`.
Every number the build uses is in `facts.json` with its source, where in it, and the words quoted from it;
placements no source states are in its `layout`, each saying what it was measured on.

```
python3 -I fetch.py [--record] [ID ...]   # downloads each reference into references/ (ignored by git), checked by hash
python3 -I sources.py                      # every facts.json quote is in its fetched source
```

- **`fetch.py`** - fetches every entry with a url into `references/` and checks its SHA-256; `--record` fills
  in the hash of a new entry. The Navy's hosts answer only full browser headers; a few serve certificates from
  the DoD's own authority, and those entries are marked `insecure`, the recorded hash vouching for the file. A
  web page (`volatile`) changes under its address: its cached copy is kept, and a fresh fetch that differs is
  reported.
- **`sources.py`** - checks each quote against its source's text: HTML without its scripts, a PDF in reading
  order and in its layout (a table's rows stay whole only in the second), whitespace, quote marks and dashes
  folded.
- `references/research/` holds the research behind decisions 24 and 26 (LSO grading, the TACAN ident, the
  arresting gear and catapults), with the restricted LSO NATOPS text that must never be committed.

## Build

```
python3 -I paint.py DECK.png                                                                     # the deck's texture
blender -b --factory-startup --python-use-system-env -P build.py -- OUT.glb OUT.json [FEATURES.json] [--draft]   # under the probe.slice memory cap
```

- **`paint.py`** - the flight deck's paint (decision 6) from `layout.markings`, drawn in deck metres: the image
  is the deck seen from above, bow to the right, port at the top.
- **`build.py`** - the model in the plan's Contract: true metres, x forward, y up, z starboard, the origin on
  the centreline at the deployed waterline midway along the flight deck.
  - The deck wears `paint.py`'s texture, which the build runs unless `--draft`.
  - Each moving part is a node on its hinge or slide line, resting unrotated: the catapult shuttles, blast
    deflectors (hinged on their measured forward edges) and control cabs, and the elevators.
  - The island is prisms level by level (sloped where a level's plan at its top differs), radomes and poles.
  - The hull is a loft of sections from the transom to the bow: keel, hull side to each side's knuckle, the
    sponsons' sloped underside, and the gallery wall up to the deck's edge. It is symmetric below the
    knuckles, narrows ahead of its last station to the stem, and wears `boot` below the boot top.
  - OUT.json is the ship file (`ford.json`): the deck layout the engine and the flight core read, the
    island's collision prisms, the hull's waterline, and every joint's axis, drive and keys.
  - FEATURES.json holds the named points and curves the photo match measures.

## Check

```
python3 -I check.py OUT.glb OUT.json   # every fact measured back on the build, or exempt with its reason
```

- **`check.py`** - measures the build and its ship file against every `facts.json` entry, each within a stated
  tolerance, and fails outside it. Entries it does not measure are in `EXEMPT` with the reason; `shape.*`
  holds what no fact states (the hull under the deck, symmetric below its knuckles; the island on the deck).

## Tests

```
python3 -I test_sources.py
python3 -I test_paint.py
python3 -I test_check.py
python3 -I test_build.py   # runs Blender: under the probe.slice memory cap
```

`test_build.py` builds a small lopsided ship, so a flipped axis shows, and checks:
- the frame, and each joint's sign;
- the deck's paint mapping against `paint.py`'s, and the texture on the deck;
- the island's sloped levels;
- the hull's depth, waterline, stem, transom and symmetry, and that every face points outward;
- the ship file.
