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
  reported. A photo's file must be a picture, fetched or kept: an image host that answers page headers with a
  page of its own (Reddit) is asked as for a picture where the entry says `"image": true`.
- **`sources.py`** - checks each quote against its source's text: HTML without its scripts, a PDF in reading
  order and in its layout (a table's rows stay whole only in the second), whitespace, quote marks and dashes
  folded.
- `references/research/` holds the research behind decisions 24 and 26 (LSO grading, the TACAN ident, the
  arresting gear and catapults), with the restricted LSO NATOPS text that must never be committed.

## Build

```
python3 -I paint.py DECK.png                                                                     # the deck's texture
python3 -I letters.py LETTERING.png                                                              # the lettering's texture
python3 -I weather.py MAPS.npz MATERIAL COLOUR.png HEIGHT.png                                    # one weathered atlas (the build runs it)
blender -b --factory-startup --python-use-system-env -P build.py -- OUT.glb OUT.json [FEATURES.json] [--draft]   # under the probe.slice memory cap
```

- **`paint.py`** - the flight deck's paint (decision 6) from `layout.markings`, drawn in deck metres: the image
  is the deck seen from above, bow to the right, port at the top. Then `layout.stains` and the deck's wear as
  photographed (`layout.wear`): the non-skid's mottling, the landing area's tyre marks generated landing by
  landing and fitted to the band measured in a rectified overhead, the blast deflectors' soot and the scorch
  forward of their hinges, fluid drips, the tie-down fittings' lattice, and tyre tracks taxiing onto the
  catapults and the elevators and turning off the landing area.
- **`letters.py`** - the lettering (decision 17) from `layout.lettering`: each cell of a small atlas holds a
  piece of text, white with a dark outline, stretched to fill its cell, or shapes drawn in the cell's own
  metres: polygons with holes and a drop shadow (the island's 78s, traced from a rectified photo), discs and
  rings, text in one colour or runs of several (the stencils and placards), and grime toward the foot. With
  `cutout` the atlas is clear but for what is drawn, so a plate shows the weathered face behind it.
- **`plates.py`** - the lettering plates' frames and the lamps round a cell's shapes (`lamps`: offset out from
  each outline and into each hole, spaced evenly), shared by the build, which stands a lamp at each, and
  `weather.py`, which runs rust from their brackets.
- **`weather.py`** - one weathered atlas (decision 17) from the maps the build bakes for a group of meshes
  (`layout.weathering.groups`): the haze grey shifting plate to plate with touch-ups and mottling, the plates'
  seams and frames as grooves in a height map, streaks of rust or dirty water from the group's fittings and the
  runs the photos measure (`runs`), each face's streaks as heavy as its photos' (`regions`), grime toward the
  deck or the waterline, walking surfaces darker, the occlusion multiplied in. Over that, wear by zone: each
  texel's level, 0 almost clean to 1 the most worn, from the group's `level` and its `zones` (boxes, soft-edged,
  and facings), scales the paint's blotching (stretched up the walls), grime patches, rust and dirty water
  weeping down the walls, the scum line above the boot top and scuffs through dark paint (`wear`). The zones'
  levels are measured in the public-domain broadsides, transoms and bows (`references/research/weather`): the
  hull's lower walls the most worn, then the transom, the undersides, the island's lowest storeys, the flare
  and the sponsons, the rest of the island, its top and the mast, and the radomes almost clean. A group takes
  over the grey, or the paint it names (`from`: the island's radomes, `domes`, in their own white; the boot top,
  `boot`, in its black, colour only: `flat`).
- **`build.py`** - the model in the plan's Contract: true metres, x forward, y up, z starboard, the origin on
  the centreline at the deployed waterline midway along the flight deck.
  - The deck wears `paint.py`'s texture and the lettering's plates `letters.py`'s, which the build runs
    unless `--draft`. Each plate maps its cell to read from outside its face. Its aft edge rounds down
    (`deck.round`): the deck is cut along lines parallel to that edge and each vertex dropped on a parabola
    over the last `length` metres, its edge plate's top and foot with it.
  - Each moving part is a node on its hinge or slide line, resting unrotated:
    - the catapult shuttles, the blast deflectors (hinged on their measured forward edges) and the two
      integrated catapult control stations (`consoles`): each a cab sliding up `rise` out of the surface it
      sits in, its lid the layout's outline with its top in the deck's paint, a darker tier under it, its
      faces leaning in from its foot to its head with `panes` windows in each, and a skirt that stays under
      the surface; the waist's stands in a well outboard of the deck's edge (`sponsons`);
    - the arresting gear's deck sheaves (in their own white) and wire supports, and the barricade's
      stanchions, hinged at their heads; a part stowed in the deck sits 2 cm under its top (`STOWED`), which
      hides it, where level with it the two surfaces tore;
    - the port whips, which lower for flight operations;
    - the elevators.
  - The pendants, the lens's lights and the deck's lights are the engine's, drawn from the ship file.
  - The island is prisms level by level (sloped where a level's plan at its top differs), radomes turned to
    their measured profiles (`profile`: acorns, capsules, spheres on drums) and poles, and its details
    (`island.details`: the mast's trunk, rings, platforms, yardarm fittings and masthead, the walkways with
    their stiffeners and struts, railings (the roofs' from `references/research/roofs`: the radome decks', the
    top roof's, and posts with sagging chains round the aft radome platforms), the windows' frames, mullions, wiper motors and conduits, the radar
    faces' frames, the floodlight banks, ladders, pipes, the stair, the fittings on the base's faces, the
    halyards) as parts: boxes, cylinders, prisms, railings, dishes, domes, lathes, paths (bars or pipes along
    a line), ladders, stairs, plates and rings. The windows and radar covers are plates on its faces; a
    window that gives a `radius` has its corners rounded, and a `frame` sets it in a flatter rim. Its glazed
    levels (`island.cabs`) are seen through: each one's room and an opening through each glazed face are cut
    from the blocks (an exact boolean, before the radomes and poles join them, which it would trim), and
    each opening is filled with a see-through pane (`pane`, tinted, alpha 0.45: glTF's BLEND) leaning out at
    its head, a frame about every 2 m and heavier sill and head bars in the island's grey, a wiper per bay
    where the opening has `wipers`, a conduit above the head where it gives one, and a dark console inside,
    all in `island_details` (the engine's crash box is the body's). The openings' reveals are the wall's grey,
    the room's walls and ceiling `room` (the island's paint in the room's shade) and its floor dark: from the
    photos' camera the glass reads at 0.15-0.28 of its frame's brightness, as the sunlit photo's do. The
    windows the panes replace (`cab`) draw no plate. The radomes are smooth
    in a flat node (`SMOOTHED`), 48 round.
  - Unless `--draft`, each weathered group's faces are unwrapped into one atlas (a mesh's one `atlas` UV
    layer, which its groups share) and baked: each texel's position, normal and occlusion, from which
    `weather.py` draws the colour and height maps; the height is baked into a normal map, unless the group is
    `flat` (the boot top: colour alone, its relief too fine to see). While a group bakes,
    every other face's UVs are gathered to one point, so only its own faces reach its images.
  - The weapons are kinds of parts in their own frame (`weapons.kinds`: the Mk 29, RAM, Phalanx and gun) and the
    mounts that place them (`weapons.mounts`): each at its foot, trained and elevated as photographed, on a
    pedestal where it has one.
  - The bow's mast is square, with its fittings as parts on it; each port whip's hinge housing stays at the
    deck's edge as the whip lowers.
  - The hull is a loft of sections from the transom to the bow: keel, hull side to each side's knuckle, the
    flare, and the gallery wall up to the deck's edge, or along a wall (`hull.walls`: the quarters', the port
    midbody's) up the wall standing under it. A section stands at every corner of the deck's edge and every
    knot of the knuckle and the gallery, so the flare is flat between them and creases only there, and either
    side of a square step in the deck's edge (the starboard quarter's notch), so the hull steps square under
    it; where
    `hull.flare` gives creases that slant (the angled deck's), flat facets between them take the sections'
    place; the blisters on the hull side under the elevators (`hull.blisters`) stand out from it. It is symmetric below the knuckles, wears `antifouling` below the band's top, `boot` up to the
    boot top, and ahead of its last station runs each height straight to the bow's forward edge: the stem's
    flat front (`hull.front`, its half-width by height, rising into the face's bottom edge, a section at each
    knot of the stem it rises past), or above it the bow's flat face (`hull.face`); the sections ahead take
    the front or the face as their flat bottom.
  - The sponsons are prisms whose tops and bottoms may slope (a height per corner); `wedges` are sections
    carried along x, such as the transom's flare. Each corner is a landmark for the photo match. The gun
    tubs (`tubs`) on the aft sponsons' faces are a floor, a railing round its outboard sides and a knee
    under its aft end; their guns are weapons' mounts.
  - The catwalks follow the deck's edge between their ends: a floor from inside the band out, a toe board,
    rails and posts on the outer edge, plate knees under it down to the edge. The platforms off them, the
    edge domes' platforms (carried in to the catwalk or the band) and their knees likewise. The raft racks
    hang outboard of the railing: a canister lying fore and aft in each tier, on cradles. The safety nets
    (`nets`, the `net` material: a small image of rust-brown cord whose holes are cut out, both faces drawn)
    rise outward from the railing's top on frames, their outer edge hanging `catwalks.net.sag` between each
    pair, except where a rack or platform stands, and over the bow and round the stern's round-down
    (`catwalks.nets`, each hung to its own side from its own floor). Every railing and the
    nets' frames are in the `rail` material, grey as the rest: bars thinner than a photo resolves, which the
    photo checks leave out.
  - The transom's face stands round its stepped recess, with the windows, the catwalk band, the walkway and
    its fascia (cut back round the drop-light pole: its `rail` and its `aft` edge each one line or several,
    the fascia standing out from the walkway along each piece), the post frame and its fenders, the
    drop-light pole (`transom.drop`, in two sections where it has a `gap`; `references/research/drop`) and
    the Phalanx's raised deck (`transom.plinth`:
    its plan at its foot and its `upper` plan at its top, its sides sloping between); the rest as parts
    (`transom.details`, measured in DVIDS 7694418 and the 2023 overhead through their cameras:
    `references/research/transom2`, `transom3`, `overhead` and `sponsons`): the recess's mezzanine, doors and
    cabinet, the boat landing under the post frame, the scuppers, pipe and mooring chocks, the port quarter's
    chocks, the box behind the Phalanx with its sponson's railing, fairlead and gas bottles, the LSO's windscreen
    at the port quarter's corner, a box on its pedestal and a hose reel there, the red circle round the starboard aft sponson's RAM, the port aft sponson's pipe, low box and
    netted cage with the gallery's ladder down to it, both aft sponsons' railings, the red circle round the
    Mk 29 (a ring's `sweep` keeps the arcs the deck's edges leave), and the wall under the port notch's forward
    catwalk with its locker, ladder, low box and door. A deck circle takes its sponson's slope through its
    `facing`.
  - The lettering's plates: the island's numbers on its faces with their lamps, its stencils and placards,
    and the stem's draught marks on the hull's side just aft of the stem, tangent to it.
  - OUT.json is the ship file (`ford.json`): the deck layout the engine and the flight core read (the
    landing line, wires and their sheaves, the lens and the lights among it), the island's collision prisms,
    the hull's waterline, and every joint's axis, drive and keys.
  - FEATURES.json holds the named points and curves the photo match measures.
- **Into the game:** `web/src/assets/ford.glb` is the build with its images in KTX2 and `ford.json` its ship
  file. `python3 -I ../texswap.py OUT.glb ford.glb etc1s 1,3,5,7` encodes the deck and the weathered colour
  atlases ETC1S (the deck's 4x4 blocks are 16 cm, finer than its thinnest marking; worn, UASTC made it 5.4 MB
  against ETC1S's 1.1) and the lettering and the three normal maps UASTC (the build writes its images in the order deck,
  hull normal, hull, island normal, island, radomes' normal, radomes, lettering, nets, boot top; check the order before
  reusing the indices). Run it in a folder inside the project, which its sandboxed encoder can reach.

## Check

```
python3 -I check.py OUT.glb OUT.json   # every fact measured back on the build, or exempt with its reason
python3 -I ../verify/photos.py photos.json OUT.glb OUT.json FEATURES.json --check --cameras CAMERAS.json   # the photo match
python3 -I ../verify/skyline.py photos.json OUT.glb OUT.json CAMERAS.json DIR                            # the sky check
```

- **`check.py`** - measures the build and its ship file against every `facts.json` entry, each within a stated
  tolerance, and fails outside it. Entries it does not measure are in `EXEMPT` with the reason; `shape.*`
  holds what no fact states (the hull under the deck, symmetric below its knuckles; the island on the deck; the
  deck's top on its round-down's curve). The landing centreline reaches the deck's aft edge, its yellow drawn
  over the ramp's white, as DVIDS 7694418 shows it across the round-down; and the bow control station's band lies right
  outside its lid's rim on every side. The drop-light pole's yellow runs from its foot to its top with no face
  reaching into its gap, and lines of sight aft from it past the walkway's height meet nothing. Every island
  railing and chain keeps clear of every radome's profile across its height. Every railing and deck circle on a
  sponson keeps to its top, within 0.01 m of its plane and inside its edges.
- **`photos.json`** - the photo match's catalogue for the shared tools in `../verify` (their README): the
  photos' marks, the deck plan's anchors, the sea at the waterline, and the ship's regions (port and starboard,
  by part family). Run both under the probe.slice memory cap.

## Tests

```
python3 -I test_sources.py
python3 -I test_paint.py
python3 -I test_check.py
python3 -I test_weather.py
python3 -I test_plates.py
python3 -I test_build.py   # runs Blender: under the probe.slice memory cap
```

`test_paint.py` also holds the tyre marks to the measured band (core and shoulders along the landing line), its
taper and rounded aft edge, the streaks' contrast, the tracks' smoothness and their place on the texture, the soot
on its panel and the scorch forward of its hinge, the drips' places, the mottling's spread, the tie-downs on their
lattice, and the taxi tracks onto a catapult (faded where they join it) and an elevator, and off the landing
area (faded in where they leave it).

`test_weather.py` weathers a plain wall's maps: the seams darker and grooved, the plates' tones, touch-ups,
streaks only below a sill, measured runs where they are put, regions scaling a face's streaks, a group's own
paint, walking surfaces, the occlusion, the grime toward the deck, and the sources at the lamps and the
radomes' seams, and a deck of its own non-skid (the stern's lower decks) with its plates' seams lighter; the
transom's rust where the photo puts it; the wear by zone (each zone over the
last, its edges soft, its facings), the worn wall blotchier as the level rises and its blotches long up the
wall, grime patches darker and browner, weeps down walls only, rusting and as many as the wear says, the scum
line just above the boot top, scuffs long fore and aft, none of them on an unworn wall; the facts' wear
against the photos' own measure (the lower hull at the low end of the 2022-2025 broadsides, every other zone
cleaner, the island's top and the mast the cleanest); and the hash's lots a seed apart unrelated. `test_plates.py` checks the plates' frames, the rings offset round a shape and into its holes,
the lamps carried onto a plate, and `letters.py`'s drawn shapes: a hole with the shadow cast into it, discs,
rings, runs of colours and grime.

## Sky through the hull

```
python3 -I raycheck.py [MODEL.glb]    # exact rays through the hull volume; non-zero on one that sees through
python3 -I skyprobe.py [MODEL.glb]    # finds candidate corridors for raycheck (over-reports open air)
```

Both default to the game's `ford.glb` and read rays in the deck's terms: metres forward, to starboard and
above the flight deck. Run raycheck after any change to the hull loft, its walls, flare or face, the sponsons or
the deck; a new sighting in the game becomes a ray here first.

`test_build.py` builds a small lopsided ship, so a flipped axis shows, and checks:
- the frame, and each joint's sign;
- the control stations: stowed under their surfaces, raised by their rise with the skirt still under, the lid's
  top in the deck's paint over a dark tier, the faces leaning in, and a window counted into each face asked for;
- the deck's paint mapping against `paint.py`'s, and the texture on the deck;
- the lettering's texture, and that each plate reads from outside its face;
- the island's sloped levels;
- the hull's depth, waterline, stem, transom and symmetry, and that every face points outward;
- the bow's face and the stem's front below it as the flat bottom of the sections ahead of them, a section at
  each of the front's knots, and a quarter's wall inside the deck's edge;
- a sloped sponson's corners and a wedge's section, and the draught marks beside the stem reading from outside;
- the deck's round-down: its surface on the curve at every vertex and between them, the edge plate's top and
  foot with it;
- a glazed level: a sight line across the block through both openings, the panes in BLEND leaning out,
  a grey frame every 2 m, wipers only where asked, a conduit, consoles inside, the reveals grey, the room's
  walls and ceiling its own paint and its floor dark, and its window drawn as no plate; a radome smooth and 48
  round with the island's plating flat;
- the island's details as parts (a railing, a dish facing aft, a brace to its end, a box, a bent pipe, a
  ladder's rungs, a stair, a slab), a turned radome in its group above its seam, faces turned out, and the
  lamps round a lettering cell's shapes standing out of the plate; a weapon's mount
  trained and elevated with its pedestal, the square mast with its fitting and a whip's hinge housing;
- a blister rounded at its ends and a square one, standing out from the hull side and running on into it;
- a gun tub's floor, its railing on the outboard sides only, and its knee down to the face; railings in
  their own material;
- the flare's sections at the deck's corners, its creases' facets in place of the sections' strips, and the
  hull whole and wound one way;
- a catwalk's floor, railing and knees off the deck's edge, a platform off it, a dome's platform carried in
  to the edge, the raft canisters in their tiers, and the nets: cut out, both faces, rust-brown, their outer
  edge hanging between the frames, a net on both sides of a platform and none outboard of it, the stern's hung
  aft from its own floor, their frames in the railings' material;
- the transom's fittings: the walkway, drop bar, frame and the plinth's sloping sides, a window rounded at its corners in a flatter
  frame, and a ring part between its radii; the drop bar in two sections round its gap, the walkway cut back round it so
  nothing stands aft of it, the fascia along the cut's sides standing out into the cut and none on the ledge's edge, the
  railing in two lines;
- the weathered atlases: each group's colour and normal maps at its size, its faces in its material with UVs,
  the radomes their own group, and only the group's faces in its atlas; the boot top's colour alone;
- the ship file.
