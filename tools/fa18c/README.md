# F/A-18C

## Our own model: sources

The F/A-18C is being rebuilt as our own model (`claude/plans/air-fa18c.md`); the sections after this one
describe tools for the model it replaces. Every source the build draws on is listed in `references.json`, with
its licence and what the build may do with it: `trace` (a US government work, may be traced and matched),
`facts` (its numbers may be cited, its figures are never traced into the repository: NATOPS, and the contractor,
grant and AIAA reports) or `look`. Every dimension the build uses is in `facts.json` with its source and where
in it.

```
python3 -I fetch.py    # downloads each reference into references/ (ignored by git), checked by hash
python3 -I views.py    # true-scale top, side and front silhouettes from the HATP three-view
```

- **`fetch.py`** - fetches every `references.json` entry with a url into `references/` and checks its
  SHA-256; a file already there with the right hash is kept.
- **`views.py`** - renders the HATP overview's figure 2 (NASA, public domain) at 600 DPI and fills each view's
  outline into a silhouette mask, written to `references/<view>.png` with `references/views.json` (metres per
  pixel, nose apex, centreline). The side and front views are scaled by their dimension bars, 56.00 ft and
  37.417 ft. The figure draws the top view about 1.5% smaller, so it is scaled by its own 56 ft length; its
  span with missiles then reads 12.33 m, NATOPS's 40 ft 5 in to 0.1%. The figure is a sketch: the masks
  check outlines to a few centimetres.

  It also traces TP-3111 figure 5's six sections (FS 107 to 357, the last three with the LEX) into
  `references/sections.json`, at the one scale that fits TM-101724's heights and widths at FS 107, 142 and
  184 to 0.8 in. Where sources disagree, measured and dimensioned data win over the sketches. The HATP
  silhouettes run 2-6 in larger than these sections, partly the drawn line's width, and its top view draws the
  LEX 9-15 in wider than TP-3111 and TM-101724 agree on.

  Last, `references/profiles.json`: the HATP side view's top and keel lines and the top view's half-width at
  each inch of station, registered on the nose apex (FS 60.5, WL 100) and moved in by half the drawn line.

```
blender -b --factory-startup --python-exit-code 1 -P build.py -- OUT.glb OUT.json FEATURES.json [--draft] [--cache DIR]   # under the probe.slice memory cap
python3 -I check.py OUT.glb OUT.json [--only GROUP[,GROUP...]]   # --only: just those groups (overall, layout, layout.motion, ...), as for a negative control
python3 -I outline.py OUT.glb [OVERLAY.png] [--threshold INCHES]
```

The model is checked by the procedure in `../verify/README.md`; these are its F/A-18C parts.

- **`build.py`** - builds the model in Blender from `facts.json` and the traced references, into the
  plan's contract (Contract in `air-fa18c.md`): true metres in the engine's axes, origin FS 456, WL 105, each
  moving part a node on its hinge resting unrotated, and its joints in OUT.json. The lifting surfaces take
  NACA 65A sections from TR-84's tables; the hinged surfaces' chord fractions follow from their published
  areas over the spans in `facts.json` `layout`. The forebody lofts the cited sections over the HATP keel
  line, its nosecone on TM-101724's drooped axis; over FS 150-404 its bottom is flattened up onto the keel the
  photos' lower outline reads (`layout.belly`, `keeled()`), 0.3-2.1 in above that line, within 4-5 in of
  the keel only, its lower sides held; the LEX is a wedge whose span and heights come from
  TM-101724, cr186938 and the traced sections, its nearly flat underside traced too (`lex.underside`) and
  carried down behind FS 357 onto the wing root's lower surface, so the root lies inside it (`layout.lex`
  underside), faired behind the LEX-wing junction onto the wing root. Every
  trace is read through its pixel steps, never step by step: the HATP profiles through each step's midpoint
  and then a 4 in Gaussian (`smoothed()`), the traced sections' outlines by a 1 in Gaussian along them
  (`destaired()`). Every run between cited values (section shapes, ratios, widths, the rear body's and the
  nacelles' knots) is a monotone cubic that arrives level at its last knot (`onward()`), never a straight run,
  which creases the skin at each knot. The top line follows the canopy's located points to the joint
  behind the canopy (FS 334). The canopy's aft fairing widens from the canopy's own section at FS 290 to
  the joint's wherever the joint is the wider, and closes round the glass's pointed top above (`flared()`).
  The glass ends on a cut along its lower edge as two side photos show it (`layout.canopy glass_edge`,
  `glass_edge()`), rising from a rail along the sill to a rounded tip at the canopy's aft end, with the
  canopy's metal panel below it; the faces are cut along that line, not ended on the loft's rings.
  Past the photos' last top reading (FS 318) the canopy's top falls on to the spine's crown at its aft end
  (FS 325), and behind it the spine runs flat on the crown, meeting the canopy at the corner the profiles
  show: the section's part above the crown is squashed to that top (`tailed()`, `layout.canopy` tail, the
  user's decision once the sky check had twelve photos on it; the old model's section laid here before
  stood its hood 1.8 in higher and its base 2-2.7 in outside the head-on photos). From the joint to the rear fuselage (FS 412)
  each share of the section's height runs on one cubic from the joint's section to the rear fuselage's,
  leaving the joint level and arriving with the rear fuselage's slope, its top on the spine's crown and
  its lower body through the cited FS 357 section too (`lofted()`). No measured line is passed through
  point by point there: the side seam's points, which scatter by a few tenths of an inch, rippled the side
  when the skin was drawn through them. Behind the LEX the rear fuselage is a narrow spine on a
  broad deck (`layout.spine`): the crown is the profile photo's skyline cast onto the centreline (the HATP
  side view runs up to 3 in above it), the spine's width above its centre runs through the triangulated
  lower ends of its panel joints, and the deck stands near the LEX root's height from JOIN aft, joining the
  nacelles smoothly with its edge inside their sides, and drawing in and down into them by FS 640. The loft has a ring every 3 in over the nose and every 4 in
  from the canopy's aft end to the nozzles. The fairing settles once onto the line the skin runs along where
  it lands (85% of `FAIRING` behind the junction), from the blade as it stands at the junction with its edge
  riding the wing. Each inlet is a raked D-shaped mouth through the lip points the photos measure
  (`layout.inlet`), its flat side inboard beside a splitter plate, its duct running from the mouth's D through
  the nacelle to the engine face at X/D 6.5 (TM-103703), the F404's 28 in circle on the engine's axis
  (`engine.face`): its sections, fitted for room, rise over the stowed main gear, and each main bay's roof stands
  under the duct (`layout.inlet` duct, `bay_roof()`). The face's disc and hub close it, painted the engine's bare
  metal (`faced()`); the walls keep the airframe's greys, shaded by the occlusion alone, whose reach (Cycles' 10 m
  with no world) takes in the whole duct. Behind the lip its outer skin rides the
  nacelle as it grows (`target()`), carrying the mouth's D as it stands off the nacelle at the lip, that
  difference fading out by `JOIN` (FS 440), where it hands over to the rear fuselage on one ring, round the
  duct, where the nacelles join the fuselage whole; each nacelle's bottom follows `layout.nacelle`:
  the HATP keel line to FS 500, the photos' lower outline over FS 606-630, and the profile photo's outline
  on to the nozzles. Below it the closed main gear doors stand as a long blister (`layout.nacelle` door,
  FS 460-576, up to 3.8 in deep), which the HATP figure's wind-tunnel model lacks: `doored()` lowers the
  outline onto the doors' line across their span only (BL 16-42), so the tunnel between the nacelles keeps
  its shape, and the blister ends in the step up the photos show at FS 574-578. On each nacelle's side over the
  cheek station stands its fairing, one faired body, airframe (`fairing_cheek_*`, `layout.nacelle` cheek). Over the main gear bays
  the bottom runs nearly flat out to the bay's outboard edge, where the outer door hangs, and a band rises
  straight from it to a crease on the side (`layout.nacelle` bay): `bay()` joins that wedge to the sided
  outline, and one of the loft's columns (`BAY_COLUMN`) is pinned to the corner, which columns 4-5 in apart
  otherwise cut off by more or less from station to station. Between the flaps and the
  stabilators each nacelle's outer side is flatter than its section (`layout.nacelle` side, from the body
  strips and the lower corner seen from below): `nacelle_side()` solves the outboard half's width and
  exponent through both, `union_ring()` draws the deck's edge in to `DECK_SIDE`, where the union passes within
  0.1 in of the strips' line, and the plain and reshaped outlines are blended point by point, easing in from FS 480 and out by
  FS 680. Behind the speedbrake the top's centreline falls into the V between the nacelles' tops and the
  body narrows to the strip between the nozzles (`layout.spine` tail, `narrowing()`), the steps round the
  section spaced along its legs between the nacelle's top, side and bottom (`spaced()`). The body's top there
  is the V's floor (`core_power()`), its walls straight from the floor's edges to the nacelles' tops,
  giving way to their round sides at the nozzles (`walled()`), and below a notch no ray from the centre
  sees is closed over its mouth (`valley()`); each nacelle ends on its outer flaps' start circle, `LIP`
  outside it, its lip over them (`layout.nacelle` end). The crest checks the side outline's top there;
  ahead of the speedbrake it stays as fitted, the photos there unsettled.
  From `JOIN` aft the points that bridge the tunnel between the nacelles run evenly along the outline
  without the side's reshaping, placed at the same angles on the outline with it (`along()`). Behind the forebody the sections' lower
  steps run evenly along the outline, not round its centre, and the fuselage is split into triangles before
  any panel is cut from it, so panel and skin share them. The canopy's sill, top line and
  leaning bow and aft edge are where the photos put them (`layout.canopy`), the glass's section a
  superellipse fitted to the photos' outlines; its shell stands a seal's step proud of the loft over a strip
  of skin left under its rim, so it slides aft up the sill and swings about its aft top clear of the skin
  (`layout.motion canopy`, `proud()`). The nose carries the probes, fairings, light strips and blade
  the photos place (`layout.aoa`, `pitot`, `blisters`, `formation`, `blade`; each angle-of-attack probe's plate
  and its seam each an open band, `band()`, the plate's opening under the probe's flange, the seam's inner ring
  0.002 in outside the plate's, past `tidy()`'s weld, so each paints on its own island), the fins their tip pods
  (`layout.pods`) and a fixed root piece under each (`fin_root_*`: the root's section carried down the fin's
  plane to half an inch inside the built skin, cast point by point every 2 in of chord, since the root is a
  straight chord over a deck that falls away aft) with the riveted fairing along its outboard side
  (`fin_fairing_*`, `layout.fin` fairing: from the fin's face at the photos' upper edge straight down to the
  nacelle at its foot, and behind the band a plate on to the rudder's lower leading corner, drawn in onto the
  fin, its foot on the fin root's traced line, aft), the rudders' outline the photos' (`layout.rudder`); under each outer panel hangs the fairing at the fold hinge that carries the position
  light (`underwing()`, `layout.wing_fairing`: pointed in plan, a blunt nose, square at the aileron's hinge and
  a shallower tail piece on the aileron, both folding and flexing with the panel), and a simple cockpit with
  its pilot sits under the canopy (`layout.cockpit`). Each nozzle
  is twelve flaps, each its own joint (`layout.petals`): a curved outer flap with its stepped tab, and inside
  it the divergent and convergent flaps of the gas path, closing together; the burner's dark duct lies beyond
  the throat, and the paint gives the flaps bare metal outside, the divergent flaps' cooling holes and a dark
  ring of brackets at the exit (`layout.paint.nozzle`). The probe swings out about its root behind its door
  by the least turn that takes its nozzle to where two photos put it, the door riding it; the panel over the
  opening ahead of it is a door of its own, opening while the nozzle passes and shut again before the probe is
  out (`layout.motion probe`, `forward_door()`); the speedbrake turns to where three photos put it open, on
  a two-stage actuator from its well (`layout.speedbrake`, `speedbrake()`). The hook (`tailhook()`, `layout.hook`)
  hangs from the keel's aft end, its pivot fitting, which turns on the keel with the hook's sideways swing; its
  shank, the forging round the pin and the point are white, as the gear is, the point one casting: the shank
  flaring into its body round the aft-facing bore, the shoe under it leaning toward the pivot, and the through
  bolt's hex head and nut on the body's sides; the hold-down damper runs from a trunnion in the keel to a clevis
  on the forging. Flush panels (the speedbrake, the gear doors) are
  cut from the fuselage's own built skin (`cut()`, between stations and buttlines or inside a convex plan
  outline; a door of several convex pieces leaves no wall where two meet, and a piece may take only skin
  facing its way more steeply, as the main inner door's corner panel does short of the nacelle's side), its
  outer face on every facet, flush, its slivers collapsed first, each edge split half its depth under the skin
  (above, the outer face's finish; below, the inside's, `shape.flush`). Stood 0.15 in proud, each door's edge
  was a step the viewer's lamp lit as a light outline. The probe's doors, a loft over the skin's rings over a
  hole kept up to 0.09 in inside their edges, still stand 0.15 in off: the door's aft edge, swinging out with the
  probe, clears the skin behind it no closer. The
  paint draws the seam round each closed door as a panel line (`rims()`: each cut panel's outline, the probe
  door's curve and the forward door's rim); once the airframe is built, the skin under each door is cut away and a
  well stands behind the opening (`wells()`, `layout.wells`): each gear bay, the speedbrake's and the probe's,
  walls and a roof standing on the skin, their feet half of `UNDER` inside it (a main bay's roof under its inlet duct, sloping with it), sized to hold
  the parts that stow there, its faces turned in
  (`node(inside=True)`: `tidy()` turns every face out, and an open box's out is away from its bay). A cut's
  plane takes a corner within 1e-5 m of it as on it. Before the hidden faces go, every part is mended
  (`mended()`, `mend()`): edges under 0.01 in and faces of no area dissolved; each face with a straight corner
  (a cut's point on an edge of a face it did not reach), which split later across the edge lays a triangle of
  no area and bends the shading round it, split into triangles inside its outline, as a well's concave cap
  needs; and dissolved again, for a triangle of no area the split lays where a face's corners run on one line,
  until no face with a straight corner is left (dissolving such a triangle rejoins it to its neighbour, which
  the cull's own split would lay flat again). The cull then judges the triangles exported. The
  cut is made last, after everything that drapes on or casts at the closed skin. Parts that stow inside it
  (the gear) are placed by ray casts on the built parts (`built()`). The gear stands where the photos put it (`layout.gear` legs and
  doors): each main leg a post down to a trailing arm's pivot, the arm carrying the wheel (its turn about the
  pivot the leg's compression), a shock absorber, a side brace folding at a knee and the planing mechanism's
  connecting link and bell crank (the side brace's knee gear down where the photos last see the brace, at the
  bay's edge, as dvids4642471 shows it with its boss and downlock spring; its structure pin placed for room
  and the inlet duct over it raised for the boss to fold clear); the leg swings aft about one trunnion axis, its shock drawn in and its axle
  turned a quarter so the wheel lies flat in the bay (`layout.motion.stowed`, `main_members()`). The main leg
  too rests as it hangs in flight: the arm drooped below its standing angle by the shock's 12 in stroke, which
  the oleo drive takes back up to the stance the photos show (the points file's `static`). The shock turns
  about the boss the side close-up (dvids8678626, its camera solved from its EXIF focal length) shows where it
  meets the skin; its white upper cylinder runs on past that pin into the bay as far as the piston's stroke
  needs. Its eye swings round the arm's pivot out of the plane the shock turns in (the pin stands to one side
  of the arm), so each drive turns it and then leans it onto the eye (the `shock_aim`/`shock_lean` and
  `shock_turn`/`shock` pairs). Its castings are traced from the close-ups (`layout.gear` legs main castings:
  the post's head and clamp bands, the lower casting flaring to the fork's cheeks round the pivot boss, the
  clevis holding the shock's top (its outboard cheek a lug round the pin, the connecting link passing outboard
  of the casting), the tapered arm with its flange and its brake line in a coiled guard, the planing rod riding
  the arm from a pin on the pivot's axis to the axle's fitting, the shock's white cap with its red band over
  the polished body and the can's ribbed collar, the can narrowing to its neck; the connecting link a white
  sleeve, a polished rod between two lock collars and a white rod end; the side brace's foot a universal joint,
  as dvids8678626 shows it: its fork's pin square to the brace and to a bolt down through the fork's middle,
  on which a spool turns in a clevis off the post, its castellated nut and end below, the fork rolling on the
  brace and the spool on its bolt to keep the pin square through the stroke, `layout.motion` braces side
  foot), and the fittings read off them face on
  (castings fittings: the pivot's and the shock's top pins hollow, the bell crank's round bolt heads, the
  castings' edges rounded, `hollow()`, `stud()`, `filleted()`; their heights off the faces they sit on are
  `STANDOFF`, which the photos, seeing them face on, cannot give), and each wheel's face from the side photos (`layout.gear` tyres:
  the tread's grooves, the rim's flange round a recessed disc with the main wheels' lightening holes, the bolt
  circle, the cap and axle nut; the main wheels' brakes on their inner faces, `tyre()`). Each leg's `full` in
  the points file is the oleo drive with the leg fully in (the main shock's body meeting its can's end, the
  nose piston its post's head), the most the engine pushes it. The nose leg is a
  vertical post hung from its trunnion on a yoke, with its castings traced from the side photos (`layout.gear`
  legs nose castings: the steering housing, the collar with the steering's bronze ring gear its top band, the
  steering block, the web out to the drag brace's pin with a raised rim round it, notched where the stowed rod
  lies (`notched()`), the torque link's bosses and links, round bolt heads on the pivot plates), the piston, the axle's
  fork, the holdback bar and its spring, the drag brace (the retraction actuator: its cylinder turning about
  its pin in the airframe, the rod sliding out of it to a clevis on the web's pin, hollow, and the strip that closes
  its slot in the skin, `actuator()`), the launch bar (a flat bar with its black band and the head the shuttle
  takes) raised, the landing lamp and the approach lights' box on the post's front, each lens its own node the
  engine lights (the approach lights with the angle of attack, as the cockpit indexer), and the squared block on
  the post's port front over the housing (`gear_nose_block`). The leg rests as it
  hangs in flight, the oleo out by its extension; the oleo drive pushes it in, and the stance the photos show
  is the extension's worth of it (the points file's gear `static`). The holdback folds up along the piston as
  the oleo comes out (it rides `oleo.nose`, trailing at the standing stroke), so it lies folded in flight and
  through every retraction, and the launch bar folds down along the post's front as the leg retracts, each as far
  as its neighbours let it (`tucked()`). Each door, hinged on the
  skin, opens by the angle that brings its free edge's ends nearest the photos', and closes as long along the
  skin as the photos show it open (the forward nose doors to the centreline, where the leg passes). The gear's
  joints each ride one mechanism's drive (`sequenced()`): `gear.doors`, `gear.nose` or `gear.main`, each
  stroking as an actuator does (`stroked()`, `layout.motion stroke`): gathering speed over a short share of
  its time, steady, then easing to a stop. The points file's `motion.gear` gives each mechanism's share of
  the stroke's time each way (`timeline()`): up, the nose leg leads, the mains follow and the doors close last
  (`layout.motion sequence` and `doors`); down, the doors open first and both legs fall together
  (`layout.motion extension`). The engine runs them by direction (`web/src/game/gear.ts`); the checks pose
  the whole gear by one value through the retraction's timeline (`verify/model.py` `sequence()`). The third
  output, the features file, names points and curves on the model with the node each rides on, for the photo
  match. `--draft` leaves out the paint bake (seconds instead of minutes). `--cache DIR` keeps the atlases'
  UVs and bakes between builds (`../cache.py`): the jet's under a key of every part's faces, the stencils'
  frames, the atlas's layout, the nozzles' flaps and the code that unwraps and bakes; the stores' under their
  own faces, the airframe's within 13 in of them and that reach, their atlas's size and their code. Both keys
  are taken before either bakes. A build whose key an entry holds takes the UVs and bakes from it and makes
  the model a cold build makes, byte for byte: a painted build of 11 min takes 51 s when nothing the bakes
  come from changed (the paint's colours, panels and stencils' lettering, the points), and a change to the
  stores alone bakes only theirs (40 s). An entry is about 50 MB; the three latest made or used of each
  atlas are kept. `--facts FILE` builds from another facts file, and `--keys FILE` writes the two keys from a
  draft and stops. `test_build.py` holds each key to what it comes from on drafts (`KeyTest`, about 8 min)
  and the cache to the cold build (`CacheTest`, about 15 min), and the wing's flex morph at rest unweighted.
- **`check.py`** - the facts check: measures the built model back against every `facts.json` entry, posed
  where the entry needs it, and fails outside each tolerance; entries it does not measure are listed in
  `EXEMPT` with the reason, and `test_check.py` fails on an entry that is neither. Shape checks (`shape.*`)
  cover what no number does: the LEX running into the wing with no step; every stowed part, and the
  cockpit, inside the airframe at rest (`STOWED`: a ray each way along each axis meets it; `HULL` holds the
  parts on the skin too, since the hidden faces under them are gone); the skin every check measures closed,
  each opening by its door's outer face moved back to the skin it was cut from (`plugs()`), and each closed
  door's outline meeting the skin round its opening (`FLUSH`, `rim()`); each well open under its doors,
  no two of its doors closing on each other (`stacked()`), its faces turned toward its opening, holding its stowed parts (with the skin round it and the parts standing on that skin, which close the holes the cull leaves under them), inside the airframe and
  holding no other part (`layout.wells`); the gear in its finishes and each tyre's hub its share of the radius
  (`paint.gear`, `layout.gear`), and with the atlas the legs lit as they stand gear down; each left part the mirror
  image of its right twin, at rest and gear down; parts lying against each other (`SEAMS`: the inlets, the
  LEX and its fairing, the wing root, the fuselage) never crossing back and forth where they show; nothing
  poking through the LEX's fairing, which covers the wing's root end; nothing a mechanism moves passing through
  anything it neither carries nor rides (`SWEPT`: the gear at 41 steps of its stroke, the probe, the canopy,
  the fold, the speedbrake and the hook at 21, and the hook's sideways swing held down from stop to stop, the
  only way the wire swings it (`HELD`, `STROKES`); parts riding another mechanism's joints together are left to the
  static checks, and a door keeps its seat wherever it stands as it rests), each moving part pulled in by a
  seam first (`clearance()`, `shrunk()`, `through()`: designed contacts, `JOINED`, are judged by where they
  meet at the sweep's first pose, gear down, a door's crossings near its hinge are its hinge's, a closed door's seat is the wells'
  check's, and two crossings are signed off: the main shock's upper cylinder past its pin, hidden in the bay,
  with the connecting link (`OVERLAPS`), and the side brace's foot's clevis from its lower lug down passing
  through the open inner door and the bay's edge mid-stroke (`FOOTED`, by depth down the foot's bolt)); each
  linkage's shared pin, carried by both its members' nodes at 81 steps, within 0.05 in (the side brace's foot,
  the connecting link's end, the nose drag brace's eye, the speedbrake actuator's eye on its lug, `pinned()`:
  the keys are thinned to each joint's own motion,
  `thinned()`, so linked members keyed alike cannot drift apart between keys); each inlet's duct holding nothing
  else of the jet, rays from its axis meeting its own walls or engine face first and from the front (`strays()`),
  and dvids8025511's sight lines into it ending on its walls, never on a face across it short of the engine face
  (`head_on()`); the fuselage's store mounts on the skin; each fin, its rudder's lower end and its root piece standing on the skin all along the root, each
  face's foot (its lowest corners along the fin's span, either side of its mid-plane) on or in the skin
  (`shape.seated`); no crease in the skin away from its real edges (`shape.bend`: fixed lines on the skin seen from
  above, below and outboard, and over the LEX and its fairing from above, each bend over 4 in either side
  counted where most of it lies within 2 in, so smooth curvature is not; the canopy is left out only on the
  lines that meet it; each view's tolerance lies between the fixed build and one with its rings spread out;
  on the fairing a step counts as a bend, not as an edge), and the canopy's aft end turning no sharper than
  a fillet where its fairing meets the spine, an inch either side;
  the belly between the nose and the inlets bending no more than its curve; the fuselage's section,
  where each inlet hands over, standing nowhere outside the inlet's last ring where it juts out past the
  section 4.5 in ahead (`shape.joint`); the nacelles' skin round the main gear's openings and the cheek station
  shading smooth as exported, its corners' normals as the GLB carries them: no triangle of no area, no corner's
  normal over 30 deg off its triangle's, no edge shaded smooth turning over 45 deg (`shape.smooth`); no wave on the same lines, a dip between humps or a hump
  between dips within 80 in standing over 0.15 in (`shape.wave`), which no crease check sees; the
  spine's crown, flank, side seam and deck where the photos put them (and the canopy's top behind its aft end within 0.3 in of the photos' height: `layout.canopy`)
  (`layout.spine`); and each
  panel line (`layout.panels`, cast onto the skin from the photos) within an inch of the skin as built,
  which the paint otherwise finds only when it is baked. On a painted build it reads the paint too, off
  the atlas the GLB carries: no texel lying under two painted faces (`paint.overlap`), each stencil on skin
  of its own island, dense enough for its lettering, and drawn whole (`layout.stencils`), and the panel
  lines darker than the skin beside them along their whole length, and so each closed door's outline against
  the door and skin beside it, as is the LEX's root slot against the LEX
  beside it, and the left duct's walls in view no darker than the occlusion's floor, light near the lip and
  darkening with depth (`shades()`). A draft carries no atlas: its paint goes
  unchecked, and the check says so.
- **`outline.py`** - the outline check: the model's top, side and front silhouettes at the HATP masks' scale,
  registered on the apex and centreline, with the share of their union both cover, and every place the
  outlines part by more than a threshold, worst first, in stations, waterlines and buttlines.
- **`photos.json`** - the photo match's catalogue (`../verify/photos.py`): the frame, the anchors the sources
  cite, and per photo its marks, traced edges and pose. The pose the points are measured in, and each photo of
  the jet standing, give the oleos as `"static"`: the stance the points file gives, where the sources cite the
  axles, rather than the gear's rest, which hangs as in flight. **`marking.md`** names every point and edge and
  how to mark them.
- **`checklist.json`** - every visible shape, region by region, with the photos that show it and whether the
  model matches.
- **`tips.py`** - the wing's and the stabilators' tip heights from the solved photos (`photos.py --cameras`):
  one offset per surface shared by every photo, the whole surface raised or (`--rotate`) turned about its
  root, each photo's deflections fitted beside it or (`--neutral`) held at rest, and each photo left out in
  turn. Ground photos droop the flaps and ailerons 40-45 deg; in-flight photos show the wing bent up at 1 g.
  The model rests at the ground shape (`layout.wing`).
- **`render.py`** - renders the model posed from its points file as the engine poses it (`gear=1 canopy=1`
  ...), in Workbench: the rig contract's check that every joint turns, slides or shows as its keys say.

```
python3 -I ../verify/photos.py photos.json OUT.glb OUT.json FEATURES.json --check --overlays DIR --cameras CAMERAS.json --jobs 4
python3 -I ../verify/skyline.py photos.json OUT.glb OUT.json CAMERAS.json SKY --jobs 4
blender -b --factory-startup --python-exit-code 1 -P ../verify/view.py -- OUT.glb OUT.json CAMERAS.json RENDERS
python3 -I ../verify/photos.py photos.json OUT.glb OUT.json FEATURES.json --sheets RENDERS SHEETS
python3 -I ../verify/page.py photos.json CAMERAS.json SKY SHEETS GATE.txt PAGE --kicker "F/A-18C · Air" --name "Hornet shape review"
blender -b --factory-startup --python-exit-code 1 -P render.py -- OUT.glb OUT.json DIR gear=1 canopy=1
python3 -I tips.py photos.json CAMERAS.json OUT.glb OUT.json FEATURES.json --photos ID,... [--drop ID:MARK,...] [--neutral] [--rotate]
python3 -I test_check.py
```

The facts check, the outline check, `test_check.py` and the photo gate run side by side, the sky check after
the gate whose cameras it reads: 335 s for them all on this machine, against 500 s one after another.

Before it paints, the build removes the faces no view can see (`../hidden.py`): each mesh cut into the triangles
it is drawn as, then every triangle lying inside or against another part that moves with it, judged part by part
on what each rides (a surface, a door, a store the loadout shows, a mesh with shape keys each its own). They are
the skin under the windscreen's and canopy sill's fittings and under the fins' root fairings, the fairings' caps
inside the fins, the pilot inside the seat and the like: about 2,100 triangles, drawn and painted for nothing.
`check.py`'s `shape.hidden` holds the build to none.

The build also unwraps every part into one atlas and bakes its ambient occlusion in Cycles (`paint.png`
beside OUT.glb), the shading the paint is laid over, its texel-to-texel noise smoothed within each island
(`soften()`). Faces of more than four corners are triangulated first (a
long bent cap laid flat in one piece overlapped itself); faces the islands lay over others get islands of their
own (`unfolded()`), and once packed the atlas is searched again at its own size, what it finds laid into a strip
along its right side the packing leaves free (`STRIP`), never packed again. Each texel's surface normal picks the
upper grey or, facing down, the lower (`layout.paint`, sampled in the reference photo). A texel of the 2048
atlas is about 0.7 in on the jet: the skin under each stencil gets its own island four times as dense
(`stencil_islands()`), the inlets' ducts behind their first fitted section, dark, islands 0.3 as dense
(`coarsened()`: at the rest's density they pushed the stencils' coarsest texel past its limit), and the panel
lines, 0.4 in wide, shade each texel by the share of it they cover. A door's seam runs along an island's edge
on both sides, where the edge texel's centre lies anywhere up to a texel in: by area the deep ones went bare and
the seam broke into dots, so every texel within a texel of a seam takes at least a line's share of it
(`covering()`); a texel of the bake's margin takes the size of the texel whose place it repeats
(`texel_size()`), so the seam shades it too; and each door's islands are scaled until their texels are no
longer across than along (`sharpened()`: smart_project foreshortened a forward nose door's to 1.0 in across its
centreline edge, too coarse to draw the seam there). The
slot along each LEX's root (`layout.lex` slot), an opening, is painted the same way as a dark band 3 in wide
until the paint is traced. The landing gear takes finishes of its own, materials sharing the atlas
(`layout.paint.gear`, `ATLASED`): white for the legs, braces, the nose hubs, the bays and the doors' inner faces
(`cut(inside=)`), rubber for the tyres, chrome for the polished pistons and the planing link's rod, and the main
hubs' grey (`tyre()` closes each wheel with a hub `layout.gear.tyres` sizes); a bake of each texel's material
picks its colour, shaded, with no panel lines or stencils. What is seen only open (the gear, its doors and bays,
the speedbrake, the probe and their wells, `exposed()`) takes its occlusion from a second bake with the gear down,
the speedbrake up and the probe out (`OPENED`, `posed()`): baked stowed behind closed doors it sat at the
occlusion's floor, sRGB 32, 37, 42 whatever its colour. That bake reaches 24 in (`OPEN_REACH`), so the legs are
shaded by their own castings and what stands near them, not by the whole airframe over them, which with no
ground under the jet left them grey where the photos show them white. The rest is shaded at rest, so nothing
hanging open shadows the belly it stows against; so are a door's outer face and its edges, which closed stand in
a gap of no width against the hole's rim and show only through the crack the two rims leave at a glancing view
(shaded open, unshaded, they lit there as a dashed light line round each door). Only its inside, turned against
the skin, takes the open pose's.

Our model's distant stages wait until the model is finished (the user, 2026-11-02): the first set was
deleted. These scripts stay for then, building from the painted model (the old model's own pipeline is below):

```
python3 -I stages.py OUT.glb OUT.json PARTS.glb POSE.json   # coloured parts and the posed jet, gear up and down
blender -b --factory-startup --python-exit-code 1 -P decimate.py -- PARTS.glb FAR.glb
python3 -I farcheck.py [-v] FAR.glb POSE.json                 # -v writes views.png here: move it out
cp FAR.glb far-unpacked.glb                                  # gltfpack runs sandboxed, seeing only this repository
~/bin/bwrap-build ../gltfpack-native -i far-unpacked.glb -o ../../web/src/assets/fa18c-far-new.glb -cc -kn
rm far-unpacked.glb
```

- **`stages.py`** - poses our model gear up and gear down through its points file, colours every corner
  from the paint atlas, splits what moves with the gear from the airframe, and drops the faces a flood from
  outside never reaches. It writes the parts for `decimate.py` and the posed jet in the form `farcheck.py`
  reads. `test_check.py` holds a provenance test: none of our model's scripts names the old model, its
  stages or the vendor downloads.

- **gltfpack** - compresses and quantises the stages (`-cc`) and keeps their node names (`-kn`), which the
  engine finds them by: about 60 KB, against 250 KB unpacked. `farcheck.py` reads the unpacked file. The
  engine can draw the stages only with the model they were built from: they hang inside its glTF scene.

### Wing flex

The wing bends up with the lift (facts `layout.flex`; plan, Wing flex). `build.py` (`Bend`) bends it as a
cantilever from the LEX-wing junction to tm212871's level-flight rise, 2.1 in at the tip at 1 g. Each hinged
surface and the fold rides a bend joint, `flex_<part>`, that turns and slides it with the wing at its hinge line's
middle (the fold's at its leading end, on the fold line's axis, under the fold's hinge on the upper skin's
peak). Each wing mesh carries the rest as the shape key
`flex`. The drive `load` is the lift's load factor, 0 parked and 1 in level flight. A photo in flight poses
`"load": 1`, and `render.py ... load=7.5` shows the limit. `check.py` holds:
- the tip's rise, and the shape against tm210726's ground test;
- the root still;
- each joint's turn and rise against the mesh;
- the seams at 1 and 7.5 g.

The game flies this model (claude/plans/air-fa18c.md, step 4). After a painted build that passes its checks,
copy the model and its points file in together, `cp OUT.glb ../../web/src/assets/fa18c.glb` and
`cp OUT.json ../../web/src/assets/fa18c.json`, then `/build air`: the engine reads its joints and points from the
JSON, so the two must come from one build. Until the cockpit and distant stages are rebuilt, the old model stays
as `fa18c-old.glb`: the pilot's jet in first person and the frame its cockpit is measured in.

The model carries its own stores (claude/plans/air-fa18c.md #9; `stores()` in `build.py`): the SUU-63 and SUU-62
pylons, the LAU-115C/As with a LAU-7 and a LAU-127 on each side, the LAU-116s (a hook on each hanger of its round,
`hooks()`, the forward one where the photos put it, ahead of the round's forward hanger; the block each shows on the
nacelle's side ahead of the cheek box, with the fairing over it and the ramp ahead of it, is the airframe's, as the clean
jets' photos show it: the ramp, block, fairing and box are one loft from the ramp's front to the box's aft edge
(`cheeks()`), each section (`cheek_ring()`) from the nacelle's skin out along the bottom, round its corner, up the
outboard face on its leaning plane (`cheek_face()`, measured at the slot), over the box's top corner and the ledge the
fairing stands set in from, and on one cubic over into the skin, meeting it turned into it along the fairing's line,
eased flat onto the box's top where the fairing falls to it; over the block the face rises from the box's top's height
straight on to the line; ahead of the front edge the ramp's sections are the front edge's, scaled to the ramp's line
and drawn in to the skin, a crease along the front edge; behind the box's top drop its aft face sweeps from the skin
back out to the aft edge, concave, the face rounding into it; the rest of the launcher lies inside the nacelle and is
not built; the slot sinks into the face square to it (`recessed()`)), the
330-gallon tanks and the wingtip
LAU-7s, each a node named for its station (`pylon_2`, `rail_8a`, `launcher_8b`, `tank_7`). Each but the wingtip rails
is a `show` joint on the drive `stores`, hidden at rest; a photo's pose shows the ones it carries (`"joints":
{"tank_7": 1}`), and the engine those its loadout carries (`web/src/game/hang.ts`). The points file's `stores` lists
them and each hardpoint's `rounds` where its missiles hang. Their places are the photos' (`facts.json`
`layout.stores`), their sizes the sources' (`stores`). The missiles are built apart (`../missiles`). The wingtip
rails carry the launcher adapter's two housings, one above the rail and one below, each with a formation strip
flush on its outboard face where the photos put it (`layout.strips` `tip` and `undertip`, `formation_tip_left`,
`formation_undertip_right`), parallel to the rail at the gaps the photos show to its edges (`gap`, checked); the
housings' sizes are by eye.

The stores carry an atlas of their own (`layout.stores.paint`, `paint_stores()` in `build.py`, painted by
`finish.py`, a JPEG): unwrapped apart from the airframe's, its ambient occlusion baked in layers, each part with
only the parts it is always shown with (the pylons alone, a rack or a tank under its pylon, a rail or a LAU-127
beside its rack), so no part carries the shadow of one the loadout can leave off; then the airframe's lower grey
under that shading, the missiles' calibrated wear, and the 330-gallon tanks' joint rings and filler cap as the
photos show them. `check.py` reads it back through the station 7 tank's UVs (`paint.stores`). Every store part touches what it
hangs from and every round its rail (`shape.attached`: a pylon on the wing, a rack or a tank on its pylon, a side rail
on its rack, each round hung from its seat as the engine hangs it, by the shipped missiles), within 0.1 in. Nothing a
store shows stands outside the cheek box's outboard face (rays in from outboard along it, `layout.nacelle`), and each
LAU-116's block, read with no stores shown, meets the photos' marks within their spread (the crest's buttline too), the
fairing's and the ramp's lines the photos', the fairing set in over the box and its face and bottom running on into the
box's at their joint (`layout.stores`); and the box's face on its leaning plane, its slot's outline and depth square to
it, and its aft face leaving the skin where the photos put it, halfway along its run its share of the way out
(`layout.nacelle`).

## Factory-fresh paint

`web/src/assets/fa18c-old.glb` (`fa18c.glb` until our model replaced it) is the JPEG model from before #200 with its atlases repainted clean (#147), then
encoded to KTX2. The source atlases carry a service jet's wear: grime on the skin, and chipped paint on the
cockpit's sills, walls and throttle grips.

```
git show 6e3003c50^:web/src/assets/fa18c.glb > /tmp/source.glb
python3 fresh.py /tmp/source.glb /tmp/fresh.glb [preview]                    # preview: each atlas before and after
python3 ../texswap.py /tmp/fresh.glb ../../web/src/assets/fa18c-old.glb etc1s 15,19,20,21,22
```

- **`fresh.py`** - repaints each atlas in `ATLASES` over the texels its materials' triangles cover. The exterior
  (`skin`) keeps a broad base, the panel lines, rivets and stencils above a noise floor, and every marking that
  stands well off the base; the nozzle petals' grain goes under a higher floor. The cockpit and the gear (`pit`)
  take an edge-preserving smoothing that keeps hard edges and the baked shading. Per atlas, rectangles name what
  else to fill: paint chips on an island's edge (`chips`), light scuffs and worn bands on dark frames (`light`, and
  `faint` for fainter ones on plain paint), a strip's dashed worn edge, averaged along the strip (`along`), every
  flake (`clean`), whole islands to repaint as the exterior is (`skin`), parts to paint whole in their colour
  (`flat`, and `discs` for round button faces, their legend kept), whole islands to paint in a colour of their own
  (`paint`: the shoulder spotlights' housings and arms, in the cockpit's grey), triangles to point at a patch of
  their own where their UVs lie on a neighbour's (`patch`: the spotlights' lenses, which share their barrels' ends),
  and what to leave as it was (`keep`: the pilot, the engine faces, the compass card). Every texel outside the triangles' coverage then takes its island's edge, so
  filtering never meets the background or the wear the source painted past an island. The canopy sills' rivets are
  cleared from atlas 9: the engine builds them as geometry (`RIVETS` in engine.ts), since at three texels across
  the painted ones stretch to soft dashes.
- **`../texswap.py`** - encodes the atlases to KTX2: UASTC for the panel atlases that carry lettering, ETC1S for
  the rest. Its temporary files go beside the output and are removed.

## Distant stages

Builds `web/src/assets/fa18c-far.glb`, the stages the engine draws another jet with once it is small
on screen (engine.ts, distance stages): a merged **medium** model of about 5,000 triangles from 80 down
to 8 reference pixels long (1/1080 of the view's height; 280 m to 2.8 km at normal zoom), a **far**
silhouette of 400 from 8 to 2, then a dot, cut from the old model (`fa18c-old.glb`) in its frame until they are
rebuilt from ours. The old model is never rewritten: its rig finds parts by name, so nothing here round-trips it.

```
cd ../../web && pnpm exec tsx tools/pose.ts ../tools/fa18c/pose.json   # posed as the engine draws it
cd ../tools/fa18c
python3 far.py                                                         # coloured parts, interior dropped
PYTHONPATH=$HOME/.local/lib/python3.14/site-packages blender -b --factory-startup \
  --python-use-system-env -P decimate.py -- parts.glb fa18c-far.glb   # each part to its budget
python3 farcheck.py -v                                                 # and views.png to look at
../gltfpack-native -i fa18c-far.glb -o ../../web/src/assets/fa18c-far.glb -cc -kn
```

- **`web/tools/pose.ts`** — poses the shipped jet with model.ts's own `posed()` (the static fixes,
  every scrubbed family at neutral, the surfaces at neutral: gear up) and again with the gear family
  at the end of its moving span (gear down), and writes every mesh in the model's own frame.
- **`far.py`** — splits the meshes into the airframe, what moves with the gear (in each pose) and
  the burner's glowing faces; colours every corner from the original download's textures by
  material name (the shipped KTX2 cannot be decoded here; the UVs are the same); makes glass a dark
  opaque tint and leaves out the near-invisible helpers and the decal overlays; and drops the faces
  a voxel flood from outside never reaches (the cockpit behind the closed canopy, the engine cans).
- **`decimate.py`** — welds and collapses each part to its budget; the far silhouette is first
  remeshed to one watertight shell, since a collapse cannot merge the jet's separate panels.
- **`farcheck.py`** — every stage present and within budget, nearly every vertex on the posed jet,
  the airframe and far stages spanning the jet, and the far colours matching the airframe's.

The burner keeps its own glow; the formation strips' night glow is not carried into the stages.
