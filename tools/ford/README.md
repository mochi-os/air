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
  runs the photos measure (`runs`), each face's streaks as heavy as its photos' (`regions`), rust over every face
  in a box where a run cannot follow (`stains`: a rope's chafe in a chock's throat), grime toward the
  deck or the waterline, walking surfaces darker, the occlusion multiplied in. Over that, wear by zone: each
  texel's level, 0 almost clean to 1 the most worn, from the group's `level` and its `zones` (boxes, soft-edged,
  and facings), scales the paint's blotching (stretched up the walls), grime patches, rust and dirty water
  weeping down the walls, the scum line above the boot top and scuffs through dark paint (`wear`). The zones'
  levels are measured in the public-domain broadsides, transoms and bows (`references/research/weather`): the
  hull's lower walls the most worn, then the transom, the undersides, the island's lowest storeys, the flare
  and the sponsons, the rest of the island, its top and the mast, and the radomes almost clean. A group takes
  over the grey, or the paint it names (`from`: the island's radomes, `domes`, in their own white; the boot top,
  `boot`, in its black, colour only: `flat`; the bow's chocks, the coaming, the sheaves and their arms each in
  theirs). The bake poses the joints in `layout.weathering.raised` at their keys' end (the blast deflectors
  raised, as they are seen), so their occlusion is the pose's, and puts them back to rest for export; the pose
  reaches the cache's key through the faces it moves, so only the atlases near them re-bake. After the bake each
  mesh keeps one UV layer (`single_layers()`): where it wears the deck's paint or the lettering beside an
  atlas, the atlas layer (made as a copy of the other) holds both and the other goes, since the engine puts
  each material's images back by name on the first UV set.
- **`build.py`** - the model in the plan's Contract: true metres, x forward, y up, z starboard, the origin on
  the centreline at the deployed waterline midway along the flight deck.
  - The deck wears `paint.py`'s texture and the lettering's plates `letters.py`'s, which the build runs
    unless `--draft`. Each plate maps its cell to read from outside its face. Its aft edge rounds down
    (`deck.round`): the deck is cut along lines parallel to that edge and each vertex dropped on a parabola
    over the last `length` metres, its edge plate's top and foot with it. Where the plate's foot hangs below
    the deck's underside (the fascia, `round.fascia`) it is a plate `FASCIA` thick, its inner face looking
    inboard and its lower edge down.
  - Every paint is drawn on the front of its faces only (glTF `doubleSided` false), but the sheets seen from
    either side, the panes and the nets (`BOTH`): a face seen from behind is not drawn, so every surface a
    camera can see is a face wound toward it. `outward()` turns each closed group of a piece outward by its
    volume, measured from one of its own vertices in double precision (from the ship's origin in Blender's
    single precision, the volume of a small part 80 m out was lost in the rounding, and good parts turned
    over at random).
  - Nothing lies a little behind a face facing its way, for the game's depth buffer to draw through it from
    afar (`depth.py`: the game camera's near plane, field and lines, and the gap a place a given size across
    needs). Where two pieces of a node touch on the same corners (a sponson's body on its foot) the faces
    between them go and they are one solid, told by the sides the pieces lie on (`tidy()`, before its weld); a plate on a face stands off it as far as
    its size needs (`plate()`, up to `STANDOFF`; a larger one needs the face behind it cut away); a framed window's
    frame is a ring round its glass, the glass standing off the face as a plate does; a stowed console sinks as
    deep as its lid needs, and a whip's hinge housing stands as far over the deck; a railing's rails are each
    one bar mitred along its whole path, its posts (`POST`) a little thinner than the top rail, sunk a
    centimetre and stopping under it, and its mid rail (`MIDDLE`) 5 mm inside the posts' faces each side; a deflector's ribs across its rows are `RIBBED` deeper than those along
    them; a well sill's curb and comb stop `RESTING` under the sill, where the lowered platform rests; a
    blister's ribs stop `SHORT` of its top and bottom; a path of bars (`shape()`'s `path`: frames, seals, the
    halyards) is one piece round its corners, mitred (`swept()`, closed where it ends where it began); a cast
    rim (`lip()`) turns down into its throat at once, with no flat ring in the face; a gun tub's knee's tail
    rises into the sponson from its foot. Where layout parts met in one plane the facts move them apart
    instead (the island's doors as plates, the halyards' feet spread, the bay frame's cross members and
    one brace of each cross slimmer than the others, the vehicles' generators each wall between the ones
    it meets).
  - Each moving part is a node on its hinge or slide line, resting unrotated:
    - the catapult shuttles, the blast deflectors and the two
      integrated catapult control stations (`consoles`): each a cab sliding up `rise` out of the surface it
      sits in, its lid the layout's outline with its top in the deck's paint, a darker tier under it, its
      faces leaning in from its foot to its head with `panes` windows in each, and a skirt that stays under
      the surface; the waist's stands in a well outboard of the deck's edge (`sponsons`);
    - each blast deflector a panel hinged at the forward edge of its opening, inside the deck's yellow
      band, the opening cut from the deck over a pit (`pits`): its face tiles in the deck's paint, its back's
      ribs, its striped free edge and lugs; its keys ease it into and out of its stops. Its struts, a crank
      from a bearing in the pit and a rod to the panel's back (each panel's own lengths, solved to fold flat
      under it lowered), are two joints that `follow` it: their keys' input is its angle, and the ship file
      lists them as its followers;
    - the arresting gear's deck sheaves (in their own white, a red triangle on each drum's side facing its
      wire), the small hatch covers' hinges and handles (`fittings.hatch`, the node `hatches`), and wire
      supports, and the barricade's
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
    a line), ladders, stairs, plates and rings. A railing's posts stand evenly along each straight run, or,
    `bent`, along the whole of a path bent round a rounded corner; one post stands at each corner, square to the turn's
    bisector, and where two railings of one node meet end to end the later one adds none (`stand()`). The windows and radar covers are plates on its faces; a
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
    pedestal where it has one. Their launcher guides are `rounded` parts (a box with the edges along one axis
    rounded off), the Phalanx's radome a turned profile with its flange rings.
  - Every closed piece of a node is turned outward on its own when the node is tidied; an open piece keeps
    the winding it was built with. The weathering bakes read each face's facing, so a piece wound inward
    bakes as if it faced into the solid, and is not drawn where it is seen.
  - The bow's mast is square, with its fittings as parts on it; each port whip's hinge housing stays at the
    deck's edge as the whip lowers.
  - The hull is a loft of sections from the transom to the bow: keel, hull side to each side's knuckle, the
    flare, and the gallery wall up to the deck's edge, or along a wall (`hull.walls`: the quarters', the port
    midbody's) up the wall standing under it. Along a quarter (`hull.quarters`, from its wall's forward end to
    the transom) the section runs from the knuckle out through the quarter's measured points, straight between
    its sections, to the wall's foot, or under a sponson to the sponson's bottom at its inboard edge; it ends
    square at both ends, and its aft end's knuckle and knee are landmarks; a quarter's or a profile's section
    starting under its knuckle would fold the plating back down over the side, and the build refuses it. Where the side steps out of the
    flare (`hull.profiles`: on each side, stretches of measured sections, a ledge, a face, a recessed wall) the
    section runs from the knuckle through the profile's points, straight between its sections (a shorter one's
    last point repeated), and on from its last point to the gallery's foot at the deck's edge as the flare
    does; each stretch ends square, the flare between them. Where a square end's two sections cross (a
    profile's face out of the flare below and inside it above), the face between them is split at each
    crossing into lobes (`earcut()`), one facing out of the stretch and the next into it, each crossing a
    corner of the strips either side so the hull stays closed. The hull's top is an open edge at the deck's
    underside, which the deck closes; where that edge strays outside the deck's outline (the port quarter's
    walls, the starboard gallery's foot, the stem) `lid()` closes the strip between, facing up, an edge that
    crosses the outline split where it does first. Under the round-down, where the side comes up to the deck's
    edge, its top is drawn in by the fascia's thickness times the round-down's share, behind the fascia that
    hangs there. What hangs on the sides clear of the sponsons
    (`hull.details`, `shape()`s: the frame in the starboard bay aft of the island) is built with the
    sponsons. The open decks in the sides (`hull.decks`: each an `outline` on the face whose plan line is
    `face`, cut `depth` in) are pierced into the hull once it is made (`pierce()`): its faces lying in that
    plane round the opening taken out and filled again round it (each outline of that region with the openings
    and earlier rims inside it on its own: given every outline at once, the fill laid triangles across the
    gaps between them), and from the opening's edge walls, a floor
    and a back run in, so nothing else of the mesh changes (Blender's exact boolean rebuilt faces far from
    its cut, and not the same way from run to run). A section stands at every corner of
    the deck's edge and every knot of the knuckle and the gallery, so the flare is flat between them and creases only there, and either
    side of a square step in the deck's edge (the starboard quarter's notch), so the hull steps square under
    it; where
    `hull.flare` gives creases that slant (the angled deck's), flat facets between them take the sections'
    place; the blisters on the hull side under the elevators (`hull.blisters`) stand out from it, a square one
    ribbed upright (`ribs`). Under each
    deck-edge elevator the flare is cut away to its well (`elevators[].well`): the section runs out along the
    flare only as far as the well's wall, which stands on the flare there and rises to the deck's underside,
    along the hull side between the rails the platform runs on (`rails`) and at each end parallel to the
    platform's own, or where an end was measured (`ends`: its x at the platform's inboard edge and at the
    deck's edge; elevator 1's forward end and elevator 2's both, clear of their rails); the platform slides down to the hangar deck (`hangar`), and the hangar door's aperture
    (`opening`) is a hole through the side's plating, `depth` its thickness, and behind it a rectangular room
    (`room`), so the space runs on behind the hole's rounded corners: larger than the hole, its floor 5 cm under
    the sill (the plating's grey, walked on and shaded by the weathering, or its own `floor` paint), `beams`
    under its ceiling. The plating is a skin, as the rest of the hull: no face behind it round the hole, only
    its cut edge `depth` thick. Its door (`door`) is
    shut as the room's back, which is built in pieces (`pierce()`'s room `pieces`): the room's rectangle cut
    square `gap` [aft, forward] short of its ends into two equal leaves a `seam` apart, in the plating's grey,
    and behind the seam and the gaps a dark pocket a metre deep. Nothing lies a few centimetres behind a leaf
    for the depth buffer to draw through it in stripes. A fitting stands on the seam (the node `doors`); it and
    the doorway's forward end are landmarks.
    `pierce()` lays a hole's `floor` paint on its lowest edges by height. Each well's rails (`rail`) are channels on its
    wall centred on their x (flanges, a web and slots closed at the wall, all grey for the weathering's occlusion
    to shade, a foot bar), the well running half a rail past them;
    under a doorway's sill (`sill`) a curb with posts, or the threshold's comb of dark gaps (the node `wells`). It is symmetric below the knuckles; under the waterline a height that is a share of the
    way from the keel up reads each station that share of the way up from its own keel (where the keel rises
    aft, the flat bottom and the bilge carry on between stations), the keel a monotone cubic through the
    stations' keels, the rings below the waterline at shares of that depth closest at the bilge, one on the
    waterline. It wears `antifouling` below the band's top (an edge cut level into the finished hull), `boot` up to the
    boot top, and ahead of its last station runs each height straight to the bow's forward edge: the stem's
    front (`hull.front`, its half-width by height, rising into the face's bottom edge, a section at each
    knot of the stem it rises past and where it rises through the boot top), or above it the bow's flat face
    (`hull.face`, its mooring openings `chocks`: each a cast rim (`lip()`, a half-ellipse section from the
    opening out to its outer radius, rolling over into a barrel inside, shaded smooth, the node `chocks`)
    round a throat pierced `depth` into the bow; its vents `vents`, rounded holes `depth` deep with a grille of
    bars across their mouths, each bowed `bow` out at its middle (the node `vents`), a section above and below
    each so one flat strip of the face holds it, cut before the throats); the sections ahead take the front or the face as their flat bottom. In plan the front's
    corners turn into the sides round a quarter circle (`hull.fillet`, or the front's whole half-width where
    that is less), with sections behind the stem's upright foot to draw it; under the face the rounding
    eases out over `hull.fade`, with sections to draw that too, so the corners meet the face's creases with
    no fold. Over the bow's shoulders
    (`hull.shoulders`, [start, full]) the flare between the knuckle and the gallery's foot follows the
    stations' points above the knuckle, at their heights: in full forward of `full`, straight aft of `start`,
    and between the two easing (smoothstep) from the straight line out to them; aft of `start` those points
    sit on the knuckle, or on a quarter's last point, and weld away; ahead of the last station they run to the
    face's crease by the share of the way raised to `power`, holding their breadth and then turning in. Over a
    crease (`hull.crease`, a side's stretch of plain flare) the plating rises from the knuckle at `slope` to
    `height`, the overhang running out from there to the gallery's foot, a well's wall standing on whichever
    strip it meets; aft of `hold` the bend keeps the |z| it has there, the plating straight from each
    section's knuckle up to it (under the island the knuckle line narrows aft and the plating does not).
    Below the knuckles and over the shoulders
    the hull is shaded smooth, sharp where it turns more than 30 degrees; the rest of the flare flat. A face
    lying wholly on the centreline (where the stem stands upright with a knife edge) is left out.
  - The side's boxes and small openings (`openings()`, after the hull): each box (`hull.boxes`) an upright face
    built back into the hull from a shelf to its top, its aft end raked where it leans, and where the flare
    stands outboard of it the flare cut away level in to the face, its back open (`pierce()`'s `level`, `back`
    None), clear of a well's wall beside it (the node `boxes`); each opening (`hull.openings`) placed by its x
    and height on the outermost plating of its node there (the hull, the boxes or the sponsons): vents
    (holes to a dark back), windows (glass `depth` in, a frame round them), closed chocks (a lip round a
    throat), recesses cut level into the flare (a rim, a railing across the floor and a ledge on knees),
    plain placards, and placards drawn from a lettering cell (the node `side_lettering`), each standing off its face
    5 mm or as far as its size needs (depth.py), a cell's marks able to fill its plate; the frames, lips,
    railings and plain placards the node `frames`. The openings on faces that share a face are cut together.
    Before the openings, the bays (`hull.notches`, `notch()`): over a stretch of the side the plating from a
    floor height up through the crease and the overhang to the foot of the deck edge's face taken out, and a
    bay built behind it (a level floor, ends square across the ship, an upright back `depth` in from the
    plating at its floor, its paint `back`, a ceiling at the foot). One over a box (`box`) starts a quarter
    of a metre under where the flare passes in behind the box's face, the box built back to the bay's back,
    so the box's top is the bay's floor.
  - The anchors (`anchors`, the starboard one given, the port its mirror image) are housed. The hawse pipe's
    end is a grey hood: a pipe of rounded-square section running aft, up and outboard into the plating, closed
    at its far end by a dome, its mouth cut on the slant to open down, its lip rolled round into a dark bore.
    Below the mouth hangs the
    anchor: its shank (a chamfered square bar) from the block up into the near side of the bore, the crown's
    block on the stock (its edges chamfered, a pin standing out of it), the crown's frame reaching away from the
    mouth (one loop of chamfered bar round its slot, its corners mitred, rust, the faces into the slot a darker
    umber), and the stock a round bar through the block with a knob at each end, in the anchors' tan. The hood,
    the tan parts and the rust are weathered groups of their own (`hawse`, `tackle`, `corrosion`), so they carry
    baked occlusion, wear and rust weeps like the hull. The crowns and the stocks' ends are landmarks for the photo match.
  - The bulb (`hull.bulb`, its own node) is a smooth loft: head on its measured outline, carried on above its
    top by the stem's front to the waterline; from the side its forward edge is the stem's profile below the
    waterline through a monotone cubic; in plan its nose a quarter ellipse `nose` long where it is widest,
    shorter in proportion above and below; aft of `taper` it narrows smoothly to nothing in the forefoot.
    Every section has as many heights above the anti-fouling's top and as many below, so the paint's edge
    runs along them.
  - The sponsons are prisms whose tops and bottoms may slope (a height per corner), carrying what stands on and under them (`details`: a deckhouse, railings, slots, and prisms under the deck whose faces slope, given a plan of their own at the top). Each corner is a landmark
    for the photo match. The gun
    tubs (`tubs`) on the aft sponsons' faces are a floor, a railing round its outboard sides and a knee
    under its aft end, holed (`knee.holes`, `section()`'s round holes), its outer end upright for `knee.toe`
    before its edge slopes to its foot; their guns are weapons' mounts. The
    coaming carries its station placards (`coaming.placards`), plates proud of its inboard face.
  - The catwalks follow the deck's edge between their ends: a floor from inside the band out, a toe board,
    rails and posts on the outer edge, plate knees under it down to the edge. The platforms off them, the
    edge domes' platforms (on the catwalk's outer edge, or carried into the band) and their knees likewise.
    Each line along the edge ends square to the ship's length (`offset()`'s `square`), so runs meeting at an x
    cut alike; a corner closer to a line's end than its mitre shifts it is dropped; a platform's inboard edge
    is each run's outer edge along it; and one knee stands at each place, the furthest reaching. The raft racks
    hang outboard of the railing: a canister lying fore and aft in each tier, on cradles. The safety nets
    (`nets`, the `net` material: a small image of rust-brown cord whose holes are cut out, both faces drawn)
    rise outward from the railing's top on frames, their outer edge hanging `catwalks.net.sag` between each
    pair, except where a rack or platform stands, and over the bow and round the stern's round-down
    (`catwalks.nets`, each hung to its own side from its own floor). Every railing and the
    nets' frames are in the `rail` material, grey as the rest: bars thinner than a photo resolves, which the
    photo checks leave out.
  - The transom's face stands round its stepped recess, with the windows, the catwalk band, the walkway and
    its fascia (cut back round the drop-light pole: its `rail` and its `aft` edge each one line or several,
    the fascia and the member under it each one strip along a line, mitred at its corners), the face run on
    outboard of the section on one side (`transom.run`: a solid from the section's side out to |z| `out`,
    `bottom` up to the deck's underside, forward to `forward`, its foot put into the section's side so the two
    faces meet edge to edge), the post frame and its fenders, the
    drop-light pole (`transom.drop`, in two sections where it has a `gap`; `references/research/drop`) and
    the Phalanx's raised deck (`transom.plinth`:
    its plan at its foot and its `upper` plan at its top, its sides sloping between); the rest as parts
    (`transom.details`, measured in DVIDS 7694418 and the 2023 overhead through their cameras:
    `references/research/transom2`, `transom3`, `overhead` and `sponsons`): the recess's mezzanine (run out past the pole by `drop`)
    with its yellow-topped box and the white disc on bars over its aft starboard corner, doors and
    cabinet, the boat landing under the post frame, the scuppers, pipe and mooring chocks, the port quarter's
    chocks, the box behind the Phalanx with its sponson's railing, fairlead and gas bottles, the LSO's windscreen
    at the port quarter's corner, a box on its pedestal and a hose reel there, the red circle round the starboard aft sponson's RAM, the port aft sponson's pipe, low box and
    netted cage with the gallery's ladder down to it, both aft sponsons' railings, the red circle round the
    Mk 29 (a ring's `sweep` keeps the arcs the deck's edges leave), and the wall under the port notch's forward
    catwalk with its locker, ladder, low box and door. A deck circle takes its sponson's slope through its
    `facing`. A part that gives a `mark` is a landmark for the photo match at its `centre`.
  - The lettering's plates: the island's numbers on its faces with their lamps, its stencils and placards,
    and the stem's draught marks on the hull's side just aft of the stem, tangent to it.
  - OUT.json is the ship file (`ford.json`): the deck layout the engine and the flight core read (the
    landing line, wires and their sheaves, the lens and the lights among it), the island's collision prisms,
    the hull's waterline, and every joint's axis, drive and keys.
  - FEATURES.json holds the named points and curves the photo match measures.
- **Into the game:** `web/src/assets/ford.glb` is the build packed by `python3 -I pack.py OUT.glb OUT.json
  ford.glb`, and `ford.json` its ship file. The packing:
  - merges the parts that never move into one node (`ship`), a primitive a paint, which draws the ship in 148
    calls rather than 184. A part stays whole if it is a joint or hangs from one, or if the engine or the far stage
    finds it by name (`KEEP`: the vehicles and the island's walkways, which the engine's deck grid tells apart,
    and the deck, its skirt and underside);
  - encodes the images in KTX2 through `../texswap.py`: the deck and the weathered colour atlases ETC1S (the
    deck's 4x4 blocks are 16 cm, finer than its thinnest marking; worn, UASTC made it 5.4 MB against ETC1S's 1.1),
    the lettering and the three normal maps UASTC;
  - compresses the geometry with meshopt (gltfpack `-cc -noq`: positions stay full floats, since 16 bits over
    the ship's length steps 5 mm; gltfpack drops the UVs of paints with no image, which nothing reads);
  - names each mesh after its part again (gltfpack drops mesh names, and the glTF loader names a part's meshes
    after them, which the engine's deck grid reads);
  - decodes the result with the game's own decoder (`unpack.mjs`, three's MeshoptDecoder under node) and checks it
    against the build: every triangle under the same part, in the same place, wound the same way, with the same
    normals and UVs (gltfpack's dropped degenerate triangles aside), every joint where it was and hanging from the
    same part, the kept parts whole, every mesh named, every material as it was. It exits non-zero on a finding.

  Its working files go in `references/pack/`, inside the project, which the sandboxed encoders can reach. The
  tools that read the game's model (`raycheck.py`, `skyprobe.py`) decode it through `pack.plain()`.
- **The distant model:** `web/src/assets/ford-far.glb`, from the same build by `python3 -I far.py OUT.glb OUT.json
  ford-far.glb`. Past `CARRIER_LIMIT` (engine.ts: about 2.9 km, back to the full model at about 2.5 km) the engine
  draws it in place of every part of the full model but the deck, its skirt and underside (`CARRIER_KEEP`), in one
  call against some 150. It is the build posed as the game draws it (the whips lowered), each corner coloured by
  its paint as the average of its image over a box 1/512 of its width round its UV, in linear light. A cut-out
  paint keeps its mostly solid triangles (the island's plating round its windows) and loses its mostly open ones
  (the nets). gltfpack simplifies it to a quarter (`RATIO`: 38k triangles) and compresses it (0.35 MB). Its check:
  one call, vertex colours, no images, its extent within a pixel at the nearest range it is drawn (`PIXEL`, 1.9 m).
  Rendered at 2.5 km from four bearings it differs from the build's PNG-textured model by 3-6 levels of 255 on
  average over the ship, against the full model's own KTX2 textures' 6-14; unsimplified it differs by 3-5, at a
  tenth by 5-9. It costs 0.1-0.25 ms a frame where the full model costs 0.9-1.8 (three.js, this machine's GPU,
  with and without shadows).

## Check

```
python3 -I check.py OUT.glb OUT.json   # every fact measured back on the build, or exempt with its reason
python3 -I ../verify/photos.py photos.json OUT.glb OUT.json FEATURES.json --check --cameras CAMERAS.json   # the photo match
python3 -I ../verify/skyline.py photos.json OUT.glb OUT.json CAMERAS.json DIR                            # the sky check
blender -b --factory-startup --python-use-system-env -P sides.py -- OUT.glb OUT.json [FACES.json]       # nothing seen from behind
python3 -I stacks.py OUT.glb OUT.json                                                                     # nothing drawn through the face in front
```

- **`sides.py`** - from each face drawn on its front only, rays into the space in front of it and behind it
  (Blender's ray tree; the see-through paints let rays through); one that gets away behind fails the face:
  a part wound inside out, a sheet seen from its back, a crack in a closed hull. A face in its plane facing the
  other way covers its back (a floor and the underside beneath it): each point within 2 mm of the other's
  plane, however far from the origin and however little out of level. Posed at rest and with every joint at its
  keys' end. FACES.json lists each failing face, its node, paint, pose, middle, normal, area and rays.
- **`stacks.py`** - where a face lies a little behind another and overlaps it along its normal, facing the same
  way or drawn on both sides, the depth buffer draws the one behind through the one in front in stripes from
  far enough off. Each such overlap fails where the front can be seen and its gap is under four steps of the
  game camera's depth buffer (near plane 3 m, 45 degrees over 1080 lines, 24 bits) at the distance where the
  overlap still spans three pixels: a plate half a metre across needs 4 mm, a door 8 m across 0.96 m. Its size
  is the side of the largest square inside the overlap, so a grid of ribs counts as its strips. Faces are paired
  among neighbouring cells of their normals (to a fortieth) along each cell's own axis, so two a degree out of
  parallel far from the origin still meet. The model viewer's logarithmic depth buffer is fine enough everywhere
  but at no gap at all.

- **`check.py`** - measures the build and its ship file against every `facts.json` entry, each within a stated
  tolerance, and fails outside it. Entries it does not measure are in `EXEMPT` with the reason; `shape.*`
  holds what no fact states (the hull under the deck, symmetric below its knuckles; the island on the deck; the
  deck's top on its round-down's curve). Where the bow's shoulders are in full, the hull's flare passes through
  each station's points above the knuckle, each side; each hawse hood's outline seen from ahead reaches down to
  its foot and out to its outboard side where the head-on photo measures them, no further (within 0.3 m), its
  top corner from both head-on photos lies on the plating (within 0.3 m), and no plating hides the port hood's
  lip and lit side where
  dvids9688116 sees them past the stem (rays through five of its pixels, through research/bow's camera; the bow
  as the crowns once set it hid all five). The landing centreline reaches the
  deck's aft edge, its yellow drawn
  over the ramp's white, as DVIDS 7694418 shows it across the round-down; and the bow control station's band lies right
  outside its lid's rim on every side. The drop-light pole's yellow runs from its foot to its top with no face
  reaching into its gap, lines of sight aft from it past the walkway's height meet nothing, and the
  recess's raised deck stands out past it at the gap's foot. Every transom deck's edge with a drop beyond it
  (no deck within 1 m below, no wall) has a railing over it, but for the walkway's cut where the pole's ladder
  comes down. Every island
  railing and chain keeps clear of every radome's profile across its height. Every railing and deck circle on a
  sponson keeps to its top, within 0.01 m of its plane and inside its edges.
- **`photos.json`** - the photo match's catalogue for the shared tools in `../verify` (their README): the
  photos' marks, the deck plan's anchors, the sea at the waterline, and the ship's regions (port and starboard,
  by part family). A photo's camera holds only where its marks reach: one marked forward of the island runs on
  unheld over the stern (facts.json `layout.notes.cameras`), so a placement there through a broadside view needs
  marks there too, or the correction `references/research/cameras` fits. Run both under the probe.slice memory cap.

## Tests

```
python3 -I test_sources.py
python3 -I test_paint.py
python3 -I test_check.py
python3 -I test_weather.py
python3 -I test_plates.py
python3 -I test_stacks.py
python3 -I test_sides.py
python3 -I test_raycheck.py
python3 -I test_pack.py
python3 -I test_far.py
python3 -I test_build.py   # runs Blender: under the probe.slice memory cap
```

`test_stacks.py` and `test_sides.py` hold the two checks to small models: the gap a size needs, a door a
little in front of a wall facing as it does, a back drawn, coincident faces, neighbours in a plane, a strip's
overlap and not the face it lies on, a grid of ribs, a stack under a lid and under glass, a plate a degree out of
a deck's plane 160 m out; a box wound out and inside out, a sheet, a crack, a sheet of two faces (one 2 mm out
of level 150 m out), a room glazed over seen through the glass. `test_raycheck.py` holds the ray check to small
models (a box met front first, a floor met from behind, a sheet drawn both ways, faces back to back within
2 cm, a start inside a box, and one inside a box whose ray meets a box within it front first) and its reader to
a small glTF file (the deck's frame, a mirrored node under a moved parent), and to the game's packed model.
`test_pack.py` holds the packing to small models: the fixed parts merged a primitive a paint, a moved, a turned
and a mirrored part carried into the world frame facing as they did, the joints, a part hanging from one and the
kept parts whole, the images copied; each mesh named after its part, a shared one described for each; and the
check finding each change (a triangle lost, turned inside out or moved a millimetre, a normal turned, a UV moved
where the paint draws an image, a kept part merged, a joint moved or hung from another part, a mesh unnamed, a
paint changed) but not a dropped degenerate triangle, a UV where no image is drawn, or a number written to fewer
figures. With node and gltfpack installed it packs one and decodes it. `test_far.py` holds the distant model to
small models: the deck, a part hanging from it and its skirt left to the full model; a whip lowered as the engine
sets it, its normal turned with it; a paint's colour its factor times its image in linear light; a cut-out's solid
half kept and its open half gone; a mirrored part facing out; its check finding images, a second call and a short
extent but passing a miss under a pixel; and its constants (`KEEP`, the switch, the ship's length) the engine's.

`test_paint.py` also holds the tyre marks to the measured band (core and shoulders along the landing line), its
taper and rounded aft edge, the streaks' contrast, the tracks' smoothness and their place on the texture, the soot
on its panel and the scorch forward of its hinge, the drips' places, the mottling's spread, the tie-downs on their
lattice, and the taxi tracks onto a catapult (faded where they join it) and an elevator, and off the landing
area (faded in where they leave it).

`test_weather.py` weathers a plain wall's maps: the seams darker and grooved, the plates' tones, touch-ups,
streaks only below a sill, measured runs where they are put, a heavier run rusting deeper and uncapped,
regions scaling a face's streaks, a group's own
paint, walking surfaces, the occlusion, the grime toward the deck, and the sources at the lamps and the
radomes' seams, and a deck of its own non-skid (the stern's lower decks) with its plates' seams lighter; the
transom's rust where the photo puts it; the starboard well's sill rust where its photo puts it, weighted
past 1; the wear by zone (each zone over the
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
the deck; a new sighting in the game becomes a ray here first. The closed parts are single-sided, so a ray
starts where a camera can stand, outside the ship, and its end only aims it: a start inside a part sees out
through the backs of its walls whatever the model, so each start must see the first wall along each axis, both
ways, from the front. A part built over a ray's start fails it until the start is moved out.

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
- a quarter's section under its wall and under its sponson, its square ends, its landmarks, and the hull
  still closed; a quarter starting under its knuckle refused;
- a profile's section through its points and on to the gallery's foot, a short section's last point
  repeated, its square ends, the flare between two, and the hull still closed; the hull's side details
  built with the sponsons; an open deck pierced into a profile's face to its back, floor and ceiling, its
  raked end, on either side;
- a well's measured end standing where it was measured, clear of its rail, the other end the platform's;
- a well's hangar door pierced through its wall into the hangar behind it, its floor
  under the sill, the wall standing in the door's rounded corners; its door shut as the room's
  back, filling its rectangle short of its ends by its gaps, a dark pocket seen past them and through
  the seam (closed, its faces turned in), nothing behind a leaf or the plating facing either way (`stacked()`),
  the fitting on the seam, and their landmarks; the room rectangular behind the hole's rounded corners,
  its floor dark and not its ceiling, its beams its whole length a third and two thirds through it; its rails' flanges, web, slots, foot and top, the well half a
  rail past them; the sill's curb, posts and comb; a square blister's ribs, and none on a round one;
- the bow face's chocks: each rim's crown halfway out and its height, its throat its depth deep, dark at
  the back, and the face beside it; its vent: a hole its depth deep to its dark back, grey walls, rounded
  corners, the grille's bars across it;
- a crease: the section through its point in its stretch, none outside it, and a well's wall's foot on its
  lower strip; held, its bend's line aft of the hold where the knuckle narrows; on that flare a vent to its back, a window's glass and frame, a chock's lip round an open
  throat, a recess's level floor, back, railing and ledge, a plain placard, a lettered placard on a box (a large one
  standing off as far as its size needs), and a
  box's face proud below the flare and standing in its open cut above it, with its shelf and a window; the
  bow face vent's bars bowed; a bay through the crease and the overhang to the deck edge's foot (its floor,
  ceiling, ends and dark back each facing into it, the plating under and beside it as it was, every edge
  round it shared), and a box high on the flare under a bay (nothing of the hull outboard of its face above
  the crossing, its top the bay's floor built back to the bay's back);
- a red triangle on each sheave's inboard side, only there; a hatch's hinges on its outboard edge and its
  handle on its inboard edge; a coaming placard proud of the inboard face over its run;
- the bow's shoulders: the flare through the station's points in full, the eased share between the
  straight line and them (none at their start, all at full), held out ahead of the last station by the
  share squared, straight aft of them, smooth, and the hull closed with their points under a wall and along
  a quarter;
- the anchors: their landmarks; the stock's ends square to it with a knob round each, smooth; the crown's
  block chamfered at every corner with its pin out of the outer face, its frame a loop of bar open in the
  middle, umber only on the faces into the slot, and the shank, chamfered, into the bore on the crown's side; the hood a rounded square (not an
  ellipse) round its leaning axis, rolled, its mouth cut level for the fixture whatever the lean, the lip
  rolled from the pipe's outside to the bore, the far end a dome, the bore dark to its bottom; and the port
  anchor and hood the starboard ones' mirror images;
- the stem's front rounding into the sides where it leans and where it stands upright, the boot top's edge
  round it along a section, the hull smooth below its knuckles (one normal at each point, the keel's edge and
  the knuckles sharp, the flare flat), no fin on the centreline ahead of the upright stem, and the hull closed;
- the bulb: its section the outline head on and the stem's front above it, its nose on the profile and a
  quarter ellipse in plan, its profile without kinks at the knots, its taper, smooth and outward, and its
  paint's edge along a height;
- a sloped sponson's corners, and the draught marks beside the stem reading from outside;
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
- a gun tub's floor, its railing on the outboard sides only, and its knee down to the face, holed through
  at its holes and solid beside them, its outer end upright for its toe; railings in their own material;
- the flare's sections at the deck's corners, its creases' facets in place of the sections' strips, and the
  hull whole and wound one way;
- a catwalk's floor, railing and knees off the deck's edge, a platform off it, a dome's platform carried in
  to the edge, the raft canisters in their tiers, and the nets: cut out, both faces, rust-brown, their outer
  edge hanging between the frames, a net on both sides of a platform and none outboard of it, the stern's hung
  aft from its own floor, their frames in the railings' material;
- the transom's fittings: the walkway, drop bar, frame and the plinth's sloping sides, a window rounded at its corners in a flatter
  frame, and a ring part between its radii; the drop bar in two sections round its gap, the walkway cut back round it so
  nothing stands aft of it, the fascia along the cut's sides standing out into the cut and none on the ledge's edge, the
  railing in two lines; a railing bent round a corner, its posts evenly along the whole of it, its mid rail
  inside its posts' faces; one post at a railing's corner and none doubled where two railings meet;
- the weathered atlases: each group's colour and normal maps at its size, its faces in its material with UVs,
  the radomes their own group, and only the group's faces in its atlas; the boot top's colour alone; the
  deflector baked raised (its pit's walls open, read through the UV set the material names) and exported at
  rest; the pit's walls and floor facing into it; the cache re-baking only the deflector's atlas when it is
  baked lowered;
- one UV set a mesh, every textured material reading it, the deflector's deck tiles keeping the deck's
  mapping in it;
- the run aft (`SternTest`, the fixture's transom and the station ahead drawn as the Ford's, keel strip under a
  flat bottom): each height under the waterline reads the stations at its share of their depth, and the keel
  bends smoothly through a station; the boot nowhere below the anti-fouling's top;
- the ship file.
