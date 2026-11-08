# Verifying a generated model

How Air checks a model it builds from sources (the F/A-18C, the Ford-class carrier) against those sources
and against photos of the real thing, and the tools that do it. The F/A-18C in `../fa18c/` is the worked
example; every step names its file there.

One overlap score against a three-view says little: it averages local misses away, the drawing is often a
sketch good to a few inches, and no outline sees a shape inside the silhouette (a fairing, a blend, a
crease). The checks below are local, independent of each other, and each says what it cannot see.

## The procedure

### 1. Cite every number

Every dimension the build uses lives in a facts table with its source and where in it (`../fa18c/facts.json`,
sources in `../fa18c/references.json` with their licences). Placements no source states go in a separate
`layout` section, each saying what it was fitted to; when a later check settles one, its entry cites that
check. Never measure an unlicensed model, and never let a build script open one.

### 2. Facts check: measure the model back

A script measures the built model against every fact, posed where a fact needs it (gear down for heights,
wings folded for the folded span), each within a stated tolerance, and fails outside it
(`../fa18c/check.py`). Every facts entry is either measured or listed as exempt with the reason (not a
shape, not built yet); a test reads the script and fails on an entry that is neither
(`../fa18c/test_check.py`). This catches build drift: lofts, blends and smoothing land somewhere other than
the numbers they were given.

Measure at the feature itself: an edge sampled 3% in from a swept root reads several inches off; extrapolate
to the end instead.

The same script checks what no fact states (`shape.*`), because every source can be met while the model is
still visibly wrong. The F/A-18C passed every fact while its stowed gear, ladder and nose doors hung outside
the skin and its speedbrake stood beside a fin, and the user saw them in the viewer first:

- **Stowed parts lie inside the skin at rest:** a ray each way along each axis from every corner meets the
  airframe. Name the parts (the gear, a ladder, the cockpit); hinged doors and panels are flush, not stowed.
- **Flush panels lie on the skin:** the outer face a set standoff off it along the skin's normal, nowhere
  through it. Measured straight down, times the cosine of the slope of the skin's own facet beneath (a slope
  read across the height map's cells mixes the facets either side of a crease, and read the speedbrake 0.6
  in proud on the spine's shoulder where it stood 0.18), leaving out a cell's margin at the panel's outline,
  where its own edge walls lean.
- **Parts lying against each other never cross back and forth where they show.** Seen from above, below and
  outboard, where two parts lie within half an inch of each other, one stays on top: count the area, two
  cells in from the overlap's edge (where they meet or cross along a line), where the other stands on top
  and either is the outermost surface of the model. A near-level crossing renders as a ragged, flickering
  line. The F/A-18C's facts and every other check passed while its inlet skins crossed the fuselage over 85
  sq in a side and its LEX fairing let the fuselage through over 72; the user saw them first.
- **Left and right mirror each other, at rest and with each mechanism moved,** pairing names whose side is
  anywhere in them (`gear_left_wheel`, not only `aileron_left`); **every other part is symmetric about the
  centreline** but a short list of one-sided parts.

### 3. Outline check: where the outlines part, not one score

Lay the model's silhouettes on the drawing's views at true scale and report, for every outline pixel, its
distance to the other outline, signed, and every place they part by more than a threshold, worst first, in
the project's own units (`model.outlines`, `model.regions`; `../fa18c/outline.py`). A drawing is a sketch: a
miss here is a question for the photos, not a verdict. When two of the drawing's views disagree with each
other, trust neither.

### 4. Photos: measure the real thing

Pick 10-15 public-domain photos (DVIDS, NASA, Navy) that between them see every side: both profiles, head-on,
both front and rear quarters, from below, and close-ups of the busy regions. Use one airframe (or one ship) as
the reference where fittings vary. Record each in the references manifest with its licence and hash.

The catalogue (`../fa18c/photos.json`; format in `photos.py`) holds:

- `frame`: the project's coordinates and how they map to the model frame (`model.Frame`). A ship gives frames
  or feet aft of the bow, height above the keel or waterline, and offset from the centreline. Every report
  prints a miss with the frame's `symbol` and the review page names the unit by its `plural` (`"in"` and
  `"inches"` unless given).
- `points`: coordinates the sources cite, any of the three, each with its uncertainty: the anchors. Add what
  symmetry gives for free: a point on the centreline has offset 0.
- `mirror`: the suffixes of left and right pairs, solved as one point and its mirror image. Leave it out for
  anything asymmetric (a carrier's island).
- `photos`: per photo, where each named point falls (`marks`), traced `edges`, the `pose` the model takes to
  match it (gear down, canopy open, surfaces deflected), pixels to cast onto a plane (`locate`), and
  `"solve": false` for one kept on file but too thinly marked to solve, and `"use": "measure"` for a copyrighted or
  uncredited photo, whose numbers may be read but whose pixels are never published: `page.py` shows the model through
  its camera alone and the sky check's sheets a plain tile. The sky check (5a) reads `clear`,
  `ground`, `stores` and `masks` beside them. Three more set how its camera is solved:
  - `focal`: the lens in the photo's own pixels, the solve's prior in place of the EXIF's, or `false` for no
    prior. A photo cropped and enlarged keeps an EXIF focal that no longer fits its pixels: the Ford's
    dvids9167788 solved 34% longer than its EXIF 28 mm.
  - `horizon`: pixels along the sea's horizon. Each is held to the horizon's dip below level from the camera's
    height over the sea (1.76 minutes of arc times the root of the height in metres, with refraction). It fixes
    the pitch and roll of a low camera whose marks lie in one band, such as a deck edge seen from the water,
    about which the camera could otherwise swing. The report gives its rms in pixels.
  - `sigma`: how far its marks may miss, in pixels (by default the larger of 1.5 and the width over 2500).
    Where its marks disagree with the rest under any one camera, give it its own rms in the bundle: at the
    default it pulls the points it shares and can push another photo past the gate. The F/A-18C's dvids9437764
    fitted at 9 px; at the default 2.4 px it moved dvids9820744's wing edge from 1.17 to 1.51 in (its overlay
    then kept it out of the solve: Pitfalls).
- `sea`: the sea's surface as a plane in the frame's names (`"y=0"`), which `horizon` needs. The sky check (5a)
  cuts the model at it, since the water hides what lies under it, and measures a ground photo's horizon from
  the sea's.
- `skyline`: the sky check's regions and what makes a finding (5a), each key defaulting to the F/A-18C's:
  `stretch` (24), `axis` (110), `sectors`, `families`, `moving`, `tolerance` (1), `solid` (the materials whose
  outline is the model's own edge), `label` (`"FS"`), `sectored` (the families split into sectors, `["body"]`),
  `sides` (names for either side of the centreline, each region split by side; none for a mirrored skin),
  `stances` (below) and `horizon` (1.5, below); with `notes` and `posing`, text for the review page (6).
- `poses`: the joints `poses.py` fits (5b), and `subject`: what the photos show, as the review page names it
  (`"aircraft"`).

Marking: read every pixel at full resolution with `crop.py` (a labelled grid), coarse to find, fine to read,
then once more with the candidate drawn on before recording it. Mark corners and crisp seams; a wrong mark is
worse than a missing one. Trace an edge with 5-15 points; add `"snap": 6` where it runs between strong
contrasts, and the solver moves each point onto the strongest edge nearby. The point names are the build's
landmark names (the features file, step 5), so each photo point has a model counterpart. Marking can be
shared out to helpers with a written dictionary of the names (`../fa18c/marking.md`); check their marks on
the overlays and in the bundle's misses.

### 5. The bundle: solve, measure, compare

The build writes a features file beside the model: named points and curves, each with the node it rides on
(`../fa18c/build.py`, third output). A point on a node with shape keys also gives its move under each key at
full weight, in the node's frame (`"morphs": {"flex": [x, y, z]}`, a list of them for a curve). `model.py`
weights a mesh's glTF morph targets by its joint's `morphs`, sparse accessors included, and poses `bend`
joints (a turn about the axis, then a slide along `direction`, keys `[input, turn, slide]`), so the outlines,
the sky check, the bundle's carried marks and `view.py`'s renders all follow a bent wing. Then:

    python3 -I photos.py CATALOGUE MODEL.glb POINTS.json FEATURES.json --overlays DIR --cameras CAMERAS.json

solves every photo's camera (focal length, pose, one radial distortion term) and every marked point at once
(`camera.Bundle`), with the anchors as priors and a robust loss for stray marks. The model's own positions
only start the solve. It reports:

- each photo's fit (pixels), and each mark's miss in project units at the depth it lies;
- each point the photos measure, with its uncertainty (from the photos that see it: each photo's marks weighed
  by how well that photo fits, so a photo that fits badly widens only its own points), beside the model's, and
  the miss. A point seen from
  only one direction is reported `loose` along that camera's line of sight: the photos fix a line, not a
  point, so it is measured at the line's nearest point to the model's and its miss is the part the photo
  sees, across the line;
- how far the photos pull each anchor: a large pull means the citation or the marks are wrong;
- each traced edge's distance from the posed model's silhouette (signed: + where the model stands outside the
  photo's edge) or from one of the build's curves.

A miss on a fitted placement settles it: move the layout entry and cite the photo match. A miss on a cited
fact is a question: check the marks, then the citation.

The match is a gate, not a report: `--check` holds it to the catalogue's `gate` and exits non-zero on a miss
it does not already know of. A traced edge fails when its median miss passes `edge`; a point the photos
measure fails when it misses on any coordinate by more than `sigmas` of its uncertainty and `floor` (both in
the frame's unit). A camera at the field-of-view floor (`field` degrees or less) or fitting its marks worse
than `rms` pixels judges no edge, and its edges are listed as unjudged. `known` names the misses accepted for
now, each with what is wrong; they print on every run, and each is a task. Run `--check` after every change to
the model or the catalogue: while the match only reported, the F/A-18C's spine stood 3.7 in outside a traced
outline for weeks, and the user found the shape wrong before any check did.

### 5a. The outline against the sky: every photo, no tracing

    python3 -I skyline.py CATALOGUE MODEL.glb POINTS.json CAMERAS.json OUT_DIR

Through each camera `photos.py --cameras` solved, it walks the posed model's whole silhouette and, wherever
the photo shows sky beyond it, finds the jet's own edge: walking in from the sky (fitted as a line, since it
often darkens toward the jet), the first sharp change of brightness that holds, darker or brighter, at the
half-way crossing. Sky is even and either bright or blue (a deep blue sky or open sea reads darker in grey
than shaded skin, which is grey); in a photo whose catalogue entry says `"clear": true` (clear blue sky or
open sea beyond the jet, no cloud) the walk reads the blue, not the grey, and the edge is where the blue ends.
A jet painted as blue as the sky (the Blue Angels) also takes `"paint": "blue"`: its edge is read in both the
blue and the grey, and the one nearer the sky taken.
Green is never sky, nor anything under a ground photo's horizon. A ground photo is one whose entry says
`"ground": true`, or, without the key, whose pose has the gear down; `"ground": false` never masks the
horizon. Open sea seen from a low camera can pass for sky: say `true`. Ground begins the `skyline`'s `horizon`
degrees (1.5) under level, or with the catalogue's `sea`, that far under the sea's own horizon, the dip at the
camera's height (1.76 minutes of arc times the root of the height in metres). The model is cut at the sea
too: nothing under the water makes an outline.

Each place is a miss in the frame's unit at the depth of the triangle making the outline there (+ where the
model stands outside), on the region of skin it belongs to: part family, a stretch of stations, and for the
body the sector round the section. The catalogue's `skyline` sets them: `families` (`[[family, [node name
prefix, ...]], ...]`, a part matching none is `body`), `stretch` (the first coordinate's span, 24 in on the
F/A-18C), `sectors` (`[[limit, name], ...]` in degrees from straight up, each up to its limit, the last past
180) round the line at `axis` on the second coordinate and 0 on the third (WL 110 on the centreline), and
`label`, the first coordinate's name in a region's label (`"FS"`). A part a drive in `stances` has moved
from rest in a photo's pose is another shape: its places take the drive's word, and a region such as `gear
FS 264-288 down` is judged apart from the same stretch stowed, where gear-up photos read the closed doors with
the belly. Every drive that takes a part between two shapes belongs in the list, each word distinct within its
family: the F/A-18C's gear, canopy, speedbrake, hook, probe, launch bar, ladder and wing fold (one photo with the
speedbrake open had put the open panel in the top between the fins). The coverage counts each stance's
regions, and the reach adds a pose with every stance its other poses leave stowed let down. Left out: places on glass (and any material
not in `solid`), places whose search crosses a store (the catalogue's `stores`, below) or a mask, and weak
cameras by the gate's rule.

A region is a finding when two or more photos judge it (3 places each at least), the median over them passes
`tolerance` (1 in), and two thirds of them miss on that side: each photo is one measurement with its camera's
own error. Findings on the families in `moving` (the F/A-18C's rudders, flaps, ailerons, leading-edge flaps,
stabilators, nozzles, gear and canopy) are listed apart: their misses follow each photo's pose. The report
ends with the coverage: every region of the skin judged by one photo only or by none.

Some regions no photo can judge: they make the outline from no direction at all (a belly between nacelles,
a side under a wing root, parts behind glass). `--reach` finds them, rendering the model from directions
spread evenly round it at three distances (1.6, 2.5 and 6 times its radius, the nearest with a wide lens, as
photos taken beside the jet are), flown, gear down, with the canopy open, and with every other stance let down
at once as on a deck (`postures()`), and writes the directions each region is on the outline from:

    python3 -I skyline.py CATALOGUE MODEL.glb POINTS.json OUT.json --reach [--count N]

List each region it finds on no outline in the catalogue's `skyline` `unseen`, with what measures it instead
(a cited section, a seam triangulated from photo pairs). The report then lists them apart from the regions no
photo judges, and names any a photo judges after all (a pose or a camera the reach did not try) or that is no
longer on the skin. Distant cameras alone are not enough: on the F/A-18C six regions they found on no outline
were judged by photos taken 12-20 m from the jet or with its canopy open. A region on the outline only from a
narrow set of directions (straight ahead or behind, level) needs a photo from exactly there with sky behind;
the reach's directions say which to look for. Such regions also come and go between direction lattices (a
240-direction run and a 400-direction one disagreed on 11 of the F/A-18C's): keep the count the catalogue's
list was made with. It writes each photo's
overlay (a line from the model's edge to the photo's, green within the tolerance, yellow within 2.5 times it,
magenta beyond) and a sheet per finding with every photo's view of it. Check each finding's sheet by eye
before it becomes a task.

The model carries no stores, and a tank's or missile's skin passes for sky. The catalogue's `stores` gives
each kind as boxes from a station's mount and the load every photo is taken to carry; a photo's own `stores`
overrides it (`null` for an empty station). Default to a full load: a store left out reads as a false miss,
an empty station masked only costs coverage. Give each in-flight photo the load it shows, and size each kind's
boxes from the photos: cast a store's nose and tail from the solved camera onto its waterline and read the
stations off.

What the model does not carry and no station places (a carrier's parked jets, tractors, cranes and people,
different in every photo) goes in the photo's own `masks`: polygons `[[[x, y], ...], ...]` in the photo's
full-resolution pixels. No place whose search crosses one is judged, as for a store.

### 5b. Moving surfaces: fit each photo's pose

    python3 -I poses.py CATALOGUE MODEL.glb POINTS.json CAMERAS.json OUT.json [--only ID,ID]

Most photos' poses are guesses, and a part posed wrong reads as a miss of its shape. For each photo and each
joint the catalogue's `poses` names (`"joints": {name prefix: [low, high, step]}`, in the joint's own units:
radians to turn, metres to slide) whose part the photo judges against the sky in at least 8 places, it moves
that joint alone across its range and keeps the value at which its places miss least (the mean miss with the
worst fifth left out), where it keeps at least three quarters of them. A least at either end of the range is
no fit, so a range runs past the travel. Without `poses` it turns the F/A-18C's hinged surfaces (rudders,
stabilators, flaps, ailerons, leading-edge flaps) from -46 to +46 deg by 0.1 rad. It prints each fit beside
the catalogue's value and writes the `"joints"` entry each photo's pose takes for the fits that halve the
miss. A pose's `"joints": {joint: radians}` (metres for a slide) sets that joint past its drive (`model.py`
`setting`, honoured by `view.py` too): the only way to pose the rudders toed in, which share one drive, or a
flap and an aileron apart. It changes nothing: look at the photo, then copy the fits that are real into the
catalogue and run the sky check again. A fit can absorb a shape error into the angle: trust it where the
fitted angles are what the photo shows (flaps drooped on the ground, rudders toed in on the take-off roll),
and treat a surface whose fits scatter from photo to photo, or leave a miss on the same side in every photo,
as a shape question.

### 6. Comparison sheets: look

    blender -b --factory-startup -P view.py -- MODEL.glb POINTS.json CAMERAS.json RENDERS
    python3 -I photos.py CATALOGUE MODEL.glb POINTS.json FEATURES.json --sheets RENDERS SHEETS

renders the posed model through every solved camera and lays it beside and over the straightened photo. This
is where blends, creases, gaps and missing parts show, which no number above catches. Review every sheet,
region by region.

    python3 -I page.py CATALOGUE CAMERAS.json SKY SHEETS GATE.txt PAGE --kicker "F/A-18C · Air" --name "Hornet shape review"

makes the review page for the build from the run: the gate's output (GATE.txt, `photos.py --check` captured),
the sky check's findings with their sheets and its coverage map, and every photo beside the model through its
camera, the two laid over each other and the sky check's overlay. It names the photos' `subject` and the
frame's unit, shows the `skyline` section's `notes` beside the findings they name, and says how the moving
parts were posed in its `posing` (the F/A-18C's sentence unless given). Publish it with every build that
changes the shape, to the same page, so the user reviews the model as it is, not as it was: the user found the
F/A-18C's spine dip by eye while every number passed.

### 7. The checklist

Keep a list of every visible shape, region by region, with the photos that show it and a status: `unchecked`,
`matches` or `wrong`, and a note (`../fa18c/checklist.json`). A shape inside the outline is only ever
verified here. Nothing ships `unchecked`.

### 8. Loop

Fix the model, rebuild, and run every check again: the facts check, the outline check, the bundle, the sheets.
A fix that moves one thing often moves another.

## Tolerances

Set them by what the source can support: a measured NASA section to half an inch, a planform table to an
inch, a photo-measured point to its reported uncertainty (one to two inches with three or more photos), a
sketch to several inches. Say which in the facts table.

## What each check cannot see

| Check | Blind to |
|---|---|
| facts | anything no source gives a number for; shape between the measured stations |
| outline | the inside of the silhouette; the drawing's own errors |
| photos | points no photo shows from two directions; parts that move between photos unless posed |
| skyline | outline with no sky beyond it (flanks seen only from above or below); glass; moving surfaces until posed (`poses.py`) |
| sheets | small offsets (use the numbers); colour and texture are not shape |

## Pitfalls

What went wrong on the F/A-18C, each a rule now:

- **Judge the outline against sky only, not any even background.** Taking any background even enough beyond
  the edge (trees, hillsides, tarmac), with the walk's evenness, contrast and sharpness the only tests, was
  tried on the F/A-18C's 29 photos (2026-11-04): those places missed by a median of 1.89 in against 0.71 on sky,
  57% past 1.5 in against 25%, and where one photo judged one region against both, the two differed by over an
  inch in 68% of them (dvids9820808: 0.45 in on sky, 6.70 elsewhere). A treeline or a field's edge is a sharp,
  held step too. Coverage the sky leaves open needs another photo, not a looser background.
- **Spread the marks in depth.** A photo whose marks bunch at one end (a rear view marking only fins, nozzles
  and wheels) leaves focal length and distance trading off, and its camera runs off to a distant telephoto. Mark
  six or more points spread along the whole object; a photo that cannot have them goes in the catalogue with
  `"solve": false` and a note why.
- **Anchor what symmetry gives before reading a pair of free points.** A photo whose fixed marks all lie far
  behind the part it measures (a carrier's bow seen from ahead, its marks on the island 250 m aft) leaves the
  camera's sideways place and its heading trading off, and every free point it measures near the part moves
  sideways together. The Ford's bow-face corners came out 2.7 m to starboard, port and starboard pair alike,
  though each pair's half-width agreed with the model within 0.3 m. One anchor on the centreline (`points`, its
  offset 0, the rest loose) brought all four within 0.4 m. A shift common to a mirror pair is the camera; a
  difference between them is the model.
- **Long lenses see depth weakly.** A photo from far off is nearly orthographic: it measures across its line of
  sight well and along it hardly at all. The bundle holds a photo without EXIF focal length to a field of view
  between 1 and 100 degrees; it reads EXIF where the file keeps it, unless the photo's `focal` says otherwise.
- **One name, one point.** The far wheel in a profile shows its inboard face, not the hub face the near wheels
  show; a head-on view shows a tyre's middle. Give each its own name. When two markers place a point
  differently (a seam against the slot cut into it), keep one definition and drop the other.
- **Check the photo's side.** Manifests mislabel: three "right-rear" photos here were behind the left quarter.
  Settle it from which face of a fin or which way lettering reads.
- **Mark fixed structure.** Flaps, slats and tails move between photos; a point on them is only usable with a
  pose read off the photo, and by eye is not good enough to settle a height.
- **One photo cannot place a point in depth.** The inlet lips, marked in one near side view, read 9 in
  outboard of the model; 6.5 in of that lay along the camera's line of sight, where the solve had simply
  left the point. The report now flags such a point `loose` and gives only the miss across the line. Mark
  every point that matters in two photos taken 20 degrees or more apart (a mirror pair counts: its left
  side in one photo and its right in another).
- **A mark on the wrong feature reads as a shape error.** Those same lip marks sat on the splitter plate's
  leading edge, 35 in ahead of the lip; the model's inlet, fitted near them, was 40 in too far forward. A
  second marker reading the same photo from the dictionary caught it. Have a feature that a check turns on
  marked by two helpers, or re-read by one, before moving the model.
- **A point the view hides is not marked where its outline turns.** Seen from behind, the canopy's crown is
  only the top of a dome's outline, a grazing point about 0.25 m ahead of the crown from 8 degrees above; a
  helper moved it onto the crown with the model's own canopy profile, which makes it no measurement of the
  model. A wingtip's leading corner under an empty rail was marked where the leading edge meets the rail, up
  to 15 px inboard. Each failed the gate (the crown 2.9 in forward, the corner 2.6 in inboard) and was set
  aside. Set such a mark aside with its reason in the photo's notes, never adjust it from the model.
- **A camera that passes the gate can still be out of register.** Two launch photos solved within the gate
  (rms 4.7 and 11.7 px), but their overlays showed the model's wings, or its tail, off the photo's along their
  whole length: one's marks all lay within the fins' span, so nothing held its roll across the wings; the
  other's nose and tail disagreed under any one camera. Their median miss gave them away (1.36 and 1.93 in,
  against 0.45-1.1 for the rest), and each read findings of its own (6.8 and 8 in). Read each new photo's
  overlay and median miss before trusting what it judges, and leave out one that misses broadly.
- **Record each photo's stores from that photo.** Eight ground photos of one jet were given the load one profile
  seemed to show, bare wing pylons; a profile cannot tell a near-side tank from a far-side one, and the same
  jet's front-quarter view showed tanks on both inboard pylons. Recorded bare, the tank's outline read as the
  belly 1.4 in inside, and a task was filed on it. Settle a load from a view that separates the stations (a
  front or rear quarter), and where none does, keep the default.
- **A drawn line needs a surface to be measured on.** Casting a traced edge onto an assumed plane is only
  right if the edge lies in it: the splitter's leading edge, cast onto a flat plane, disagreed by 15 in
  between photos because it bows outboard. Solve such an edge from two views together, refining each
  coordinate from the photo that sees it best, and check the result against a third.
- **A mark on a surface lies on that surface.** The probe door's corners, marked in three right-side
  photos, came out of the bundle 3-4 in inside the skin, along the sight lines all three share. Each
  camera's sight line through the mark, cast onto the model's skin, put them within 0.4 in of each other
  instead (`cast.py`). Cast any point that sits on a surface the model already has right; let the bundle
  place only points that stand off it. The same casting measured the nose's small parts (probes,
  fairings, light strips) from one sharp profile, each then checked against the other side's photo.
- **Read each camera's field of view in the report.** A photo whose marks bunch at one end solves to the
  field-of-view floor (1 degree) with its camera hundreds of metres off: nearly orthographic. Its fit to
  the marks can still be good, but its outlines away from them can't judge a shape. The rear photos'
  canopy outlines missed by 2-4 in for that reason; the photos with well-spread marks did not.
- **Let the photos choose a free shape parameter, region by region.** Where no source gives a shape (the
  canopy glass's section), build the model at a range of values and compare the traced outlines of the
  well-solved photos; the cameras don't depend on the model, so only the shape changes between runs, and
  one camera solve serves every build. Split each edge's misses by the station of the model's silhouette
  nearest each point: one score over the whole canopy chose an exponent that was wrong fore and aft at
  once, and an overlay read by eye got the direction backwards. Don't change anything else between the
  builds.
- **Before tuning a free shape, check the measured shape beside it.** The canopy's outlines stood outside
  the photos whatever the glass's exponent, because its top line ran 0.5-1.3 in high behind the crown (the
  traced section's own top kept rising past the crown the photos measure). Read off the profiles, the top
  line took the canopy's median miss from 1.00 in to 0.28; the exponent then mattered by 0.05.
- **Ground photos hide the heights of moving surfaces.** On the ground the flaps droop about 45 degrees,
  the ailerons 42, and the tails tilt. A corner on them moves with an angle no photo states, and the
  wing's height, the surfaces' chords and the droop all move the same corners. Fit the deflection per
  photo with the camera held only where a photo shows two corners of one surface; for the structure's
  height, use photos in flight.
- **Say in the dictionary which part a corner is on.** The wingtip's trailing corner is the aileron's:
  the aileron runs to the tip. The build had it on the fixed wing, so a drooped corner read as a wing
  standing 5 in too high.
- **Distrust a lone answer.** The reported uncertainty is optimistic for a coordinate few photos see across.
  Re-solve with photos added or removed: a value that moves by more than its uncertainty is not settled.
- **A verdict must not hang on a photo that never sees the point.** The bundle scaled every point's uncertainty
  by one figure for the whole solve, so a 14 mm photo fitting at 17 px widened every point and hid ten misses,
  and taking it out failed them all, every miss unchanged. Each photo now scales only its own rows (2026-11-06).
  Adding photos can still move points: the F/A-18C's points aft of the LEX slid 1-1.6 in aft relative to the
  nose (the fin tips over 38 photos) when one new photo's `hook_pivot`, marked on a boss of the lowered shank,
  joined the solve: a mark at the jet's far end that only two other photos see can stretch the whole frame. Leave
  each new group, then each photo in the guilty group, out once and compare before taking a shift for the model's.
- **Static is not taxiing.** Photos of moving jets sit at their own attitude; a manual's static heights describe
  another. Say which a number is.
- **A miss may be a definition.** A flat canopy top has no single crown; a sloping bow has no single station.
  Before moving the model, check what the mark means on it.
- **Cap the helpers' memory.** A crop of `0 0 99999 99999` for an overview is padded past the photo's edge
  to ten billion pixels: 22 GB, and the out-of-memory killer took the whole session down. `crop.py` now holds
  a crop inside the photo and refuses an output over 4000 px; tell helpers to run any image script of their
  own under `systemd-run --user --scope -p MemoryMax=2G -p MemorySwapMax=0`.
- **A thickness from a cross product changes side in the mirror.** Offsetting a plate along
  `along.cross(across)` thickens the left one outboard and the right one inboard. Centre the thickness on the
  plate.
- **A negative control needs a control.** A mutated copy that cannot import its neighbours fails every test,
  so every mutant reads as caught: the F/A-18C's first `enclosed` and `cast.py` controls ran that way, and two
  breaks of each turned out unguarded once the copy kept its `verify` folder beside it. Run the unbroken copy
  first; it must pass.
- **Ground photos and flight photos show different wings.** On the ground the flaps and ailerons droop; in
  flight the wing bends up under its load. The F/A-18C's tips stood about 5 in above its cited anhedral on
  the ground and 10 in in flight. Fit each set apart (`../fa18c/tips.py`) and say which shape the model rests at.
- **An empty selection is a failure, not a crash.** A check that asks for no parts (a part renamed, the old
  build) must report the part missing and carry on.
- **Ground photos with stores cannot place a lower outline.** Tanks, missiles and open gear doors hang
  across it, and which tank is which is a guess: the F/A-18C's nacelle bottom was read off dvids9820808's
  tank at WL 87, and a NASA side view's line rejected on a guess about which tank showed, 10 in from where
  an in-flight photo's sky outline put it. Use a silhouette against the sky, gear up; a line that agrees with
  it (the HATP keel line, within 0.3 in) is then a source, not an error.
- **Break the model as well as the checks.** Revert each fix in a copy of the build (with `verify` beside it
  and the references linked), rebuild a draft, and run the checks. Of fourteen fixes behind the F/A-18C's
  inlet and LEX seams, five were caught at first; tightening the poke-through test to any depth and adding
  the wing-root cover caught four more, two were removed as doing nothing visible, and three still pass
  though the close renders show their defects, which is a task, not a pass.
- **A tolerance that passes a visible defect is too loose.** The LEX's poke-through check allowed 1% of its
  surface; the ragged patches the user saw were 0.82%. Set a shape check's tolerance from the broken model and
  the fixed one, with the margin between them.
- **Every number can pass while the skin creases.** The F/A-18C's forebody met all 404 facts, yet the
  user saw a bend under the nacelles and the audit found ripples along the belly, a crease at each cited
  section and a kink at each rear-body knot: the facts are measured at the knots, and the faults lay between
  them. Follow fixed lines along the skin (constant buttline from above and below, constant waterline from
  the side) and flag where they turn sharply away from a real edge (`../fa18c/check.py` `shape.bend`).
- **Measure a crease, not a curve.** A bend over a few inches either side counts a tight but smooth curve
  (the nose, the canopy's foot) the same as a kink. Count a bend only where most of it lies within the inner
  half of the window: a smooth curve keeps about half its bend there, a kink nearly all. Average each line
  over a few inches against the loft's facets, and leave out windows that cross a real edge, a jump between
  surfaces, or a face turned more than about 35 degrees from the view. Set the tolerance between the broken
  build and the fixed one, as for any shape check.
- **A traced line is a staircase, and so is a traced section.** A silhouette traced at 600 DPI moves in
  steps of one pixel (0.83 in at the F/A-18C's scale); read point by point, every step becomes a ledge in the
  skin. Take the line through each step's midpoint, then smooth it over a few inches, and check that the
  smoothing moves no cited number. A traced cross-section's outline is the same: resampled raw, each point
  lands on a riser or a tread, and the skin between the sections carried 0.2 in bumps that flipped from one
  ring to the next.
- **A window left out of a check hides everything on its lines.** The F/A-18C's bend check left out the
  canopy's stations on every line of every view, so it never saw the forebody's sides from FS 178 to 347,
  where three of the cited sections lie, and a 22 in margin behind the canopy hid a 7 deg crease on the
  spine. Leave out an edge only on the lines that meet it.
- **A cast is only as right as the skin it lands on.** The F/A-18C's dome antenna, cast from one photo that
  looks along the spine onto a spine 5 in too broad, landed on the flank 20 in short of where its sight line
  met the real crown; triangulated from two photos 81 deg apart it sits on the crown. When the skin moves,
  cast again or triangulate. The test works the other way too: once the spine was refitted, joints cast
  from one photo landed within 0.2-0.8 in of where two photos triangulated their ends, where on the old
  skin they missed by 4-9.
- **A drawing's top line can be inches off where a profile's skyline is clean.** The HATP side view ran 1.8-
  2.9 in above the F/A-18C's spine. The profile photo's skyline, found column by column where the sky's
  brightness gives way and cast onto the centreline, agreed with the triangulated panel joints within 0.5
  in. Prefer it, and leave out antennas that break the skyline.
- **A line that runs along the stations will not triangulate from two photos.** Its trace in each photo
  lies near the other's epipolar lines, so every pairing fits with no gap and the answers scatter (BL -58
  to +19 for one spine line). Triangulate only ends, corners and other points that both photos see as the
  same point.
- **A check that runs only in the slow build is skipped by every draft.** The F/A-18C's paint refuses a
  panel line standing an inch off the skin, but drafts skip the paint, so the facts check and 28 mutant
  builds all passed a spine that had moved off three cast lines, and only the painted build stopped. Put
  every guard where the drafts run it. When a shape change moves the skin under a line cast from photos,
  cast it again from the same pixels; recast onto the raised spine, the side line agreed better with its
  second photo (median 0.73 in against 0.94).
- **A check that skips steps can't see a cliff.** The bend check leaves out windows holding a jump between
  surfaces, which is right where parts meet. A fairing that stood level and then dropped 6.6 in within one
  ring span read as two surfaces and passed. Where no step is real, count a step as the bend it is.
- **A traced edge against a curve has no side.** The photo match measures an outline trace with a sign (+
  the model outside) but a trace against one of the build's curves as a distance only. The F/A-18C's fin
  leading edges missed by 1.6-2.8 in against their curve, and were read as "always outward" for a day; the
  sky check found the fins about 1 in aft, the leading edge inside. Read a curve's miss as a size, never a
  direction.
- **Brightness edges, against what the photos hold** (the sky check's lessons, each with its test):
  - A sunlit top is brighter than an overcast sky. A rule that wants the jet darker walked inward past the
    bright top to its shading, 10-12 px inside, and read the spine 4-5 in too high.
  - Processing leaves a halo: the sky darkens 8-10 levels in a band beside a bright edge. Walk past changes
    too weak to be the jet.
  - Shading is not an edge: require the brightness to rise from a quarter to three quarters of the jet's level
    within a few pixels.
  - Glass shows the sky through it, so its outline is no step: the canopy read 3-7 in wrong until glass was
    left out.
  - Label each place by the frontmost triangle under it, not the nearest projected vertex: glass has few
    vertices, and its outline was labelled as the fuselage beside it.
  - A tank or missile the model does not carry passes for sky: mask the stores.
  - Sample an edge by cells, not by every n-th boundary pixel: in row order a vertical edge's two sides
    alternate, and a stride of four only ever reached one of them.
  - A miss bigger than the search's reach is invisible, not small: past the reach the search sees no sky and
    judges nothing. The F/A-18C's aft underside sat 5-9 in inside its photo's outline and read as unjudged,
    so the search retries at two and three times the reach, with a band of sky of fixed size.
  - Stop each search where it meets another of the model's parts. Under the F/A-18C's tail the long
    search crossed the hook and took the photo's hook for the body's edge, 7 in off.
  - Don't judge a place on a part seen past a nearer one just inside it. Beside the Ford's bow, drawn
    too narrow, the model showed its stern 300 m behind. The photo's edge there was the bow's, but the
    miss was read at the stern's depth, doubled, and filed under the stern.
  - Don't judge the waterline. Where the model is cut at the sea, its outline is the sea's, which each
    photo's draught, waves and wake move: the Ford's stern read 1-2 m into its wake's foam, and a 2017
    photo at a light draught read the stem 0.8 m short.
  - Leave out what a photo cannot resolve. The Ford's railings, 5 cm bars, stood 1.1 m proud of every
    deck edge they ran along, while the photos showed the sky through them; the `rail` material is left
    out of the catalogue's `solid` list. Mask a photo's clutter for the same reason: a cargo ship and a
    shore's trees under an overhang read as the hull's edge.
  - A rough sea behind the subject reads as its edge. The walk inward from the band of sky stops at the
    first thing that is not sky, and over the sea that is foam or a wave's lit face: the Ford's stern
    sponson and launcher read 2 m short in her two quarter views while the views against the sky and the
    overhead agreed. Seaward (a photo from the air with the catalogue's `sea`, its band under the sea's
    horizon) the walk starts where the subject's own run, from the model's side, first comes back to the
    background.
  - Give every photo its own stores where its load is known: a default box for a tank under the outer
    pylon, seen from ahead of the jet, hid the whole tail's underside, the one place the model was wrong.
- **A point on a moving part is measured in one pose.** The bundle once triangulated each marked point as one fixed
  position across every photo, so a flap corner drooped 30 deg in one photo and neutral in the rest made that photo's
  camera fail (85 px rms), and stabilator tips at -10 deg on the ground and 0 in flight disagreed by about 5 in. The
  catalogue's `pose` now names the pose every point is measured, cited and reported in; each photo's marks on parts it
  poses otherwise are carried into its pose (`Bundle` `moves`, `Features.between`). Choose a pose the same on both
  sides (the mirrored pairs need it) and the one the cited points describe (the F/A-18C's: gear down).
- **A fixed feature that meets a moving one needs its own name.** With the canopy shut, the windscreen's aft arch and the
  canopy's bow are one point; with it raised, the bow rises 70 in. Two photos had marked the arch as `bow_top`, which
  rides on the canopy, and broke once marks were carried by their pose: the arch is `windscreen_top` now.
- **Fixing a down-weighting can wake photos the solve was ignoring.** Three long-lens rear views (fields 1-3 deg, marks
  bunched at the tail) had fitted at 25 px and so counted for almost nothing. Once their stabilator marks were carried,
  they fitted, began to steer the solve and failed 27 edges elsewhere; out of the solve, the gate was clean again.
  Compare every photo's fit before and after a change to the solve, not only the totals.
- **A sky-check reading near its tolerance moves with the cameras.** Adding five photos and taking four out moved the
  F/A-18C's fin points by 0.3-0.9 in but its fin regions from +0.1 to +1.0 in across 17 photos: small camera changes, summed
  over many photos, shift a median by about the size of the 1 in tolerance. Act on a finding near the tolerance only once
  it holds across camera sets (leave photos out).
- **Size the store boxes from the photos.** The tank box reached 90 in ahead of its mount; the photos put the
  330-gallon tank's nose 128 in ahead, and two views from below read the nose as body skin 21-27 in outside the body
  at FS 336-360. A single missile reached 152 in ahead, twin AIM-120s 131 in and 26 in across, and the Litening pod
  hung ahead of its station altogether.
- **A pose fitted from the outline can fight the photo's own marks.** navy090707's right stabilator and flap fitted
  at +4.3 deg from its outline, but its marks on those surfaces (a stabilator tip corner, the fold corner) fitted at
  3.0 px rms with them at rest and 4.3 posed, and posed they moved the whole solve: another photo's camera slid 17%
  along its depth and two fin edges elsewhere failed. Re-run the gate after writing fits, compare each photo's rms,
  and leave out a fit whose surface carries marks that fit worse for it.
- **A photo that judges almost nothing is the tool's problem first.** The F/A-18C's straight-below view, the best of
  the underside, judged 13 of its 1508 places: its deep blue sky reads grey 65-99, under the 110 the brightness rule
  asks, so nothing beyond the jet counted as sky. A band whose blue stands 40 over its red and green now counts
  however dark (shaded grey paint reaches about 20), and its edge is read in the blue: walked in grey, the LEX's
  shaded underside matched the deep sky and the walk passed it for the sunlit fuselage, reading the LEX 13-19 in
  outside. Read each photo's judged share in the report.
- **A cloud is no bluer than the jet.** Read in blue, a white cloud against the sea under dvids8901347's forebody
  passed for the jet's edge 9.6 in out: one profile cannot tell a cloud from sunlit skin. The blue is read only in
  photos the catalogue marks `"clear": true`, after a look at what lies beyond the jet. Clouds fool the grey walk too:
  a band on a white cloud with dark sea between it and the jet reads the cloud's edge, so a finding carried by one
  photo seen against cloud needs a look at its sheet before it counts.
- **A line along the stations triangulates badly.** The F/A-18C's side seam runs nearly along the epipolar
  lines of every pair of side views, so its ray from one photo meets the other's traced line at a grazing
  angle: traces 1-2 px apart moved its triangulated buttline by up to 2.3 in, which read once as the rear
  fuselage standing 2 in outside it (re-traced densely in two photos of the same side, it agreed with the build
  within 0.6 in). Before reshaping to such a line, trace it again and see how far its points move.
- **A sky-check place's point is its triangle's middle.** Each place records the centroid of the frontmost
  triangle at that pixel, near the silhouette on a finely meshed skin but far from it on a long thin part (the
  hook's triangles span tens of inches): cast its photo edge against the part's geometry, not that point.
- **Some paint is as blue as the sky.** The Blue Angels' navy stands about 33 over its red and green against a
  clear sky's 43, a step short of the contrast, so read in blue the walk passed the navy for sky and stopped at the
  next gold stripe inward: the belly read 1.5-2 in outside in every Blue Angels photo, and the inlets 14-16 in,
  where the model's outline lay on the photo's edge to a pixel. Their entries say `"paint": "blue"`, which reads
  the grey as well (the navy is dark) and keeps the edge nearer the sky (gold trim, which grey passes for sky, is
  found by its blue). A photo admitted or turned away on its sky-check misses was judged on those misses: run it
  again after a reading like this changes.
- **Bright, even backgrounds pass for sky, and so can light paint.** White fabric shelters and an orange
  building behind the F/A-18C's outer wing passed the sky test, and under an overcast its light grey flaps stood
  within the sky's brightness, so the walk crossed them to the wing's dark underside and read them 12-14 in
  inside. Four ground photos made a finding of the flaps that way. Before taking a cluster of misses, look at what
  stands behind it in the photo, and mask what is not sky.
- **A cluster of large misses may be something the model doesn't carry.** Swiss and Spanish jets carry a
  flat-bottomed fitting under the belly between the intakes, which read 6-7 in below it (entered as a store); a
  blade antenna under the forward fuselage read 5-12 in in five photos; the main gear doors' blister, which the
  model lacked, read 2-5 in. Look at the photo at the place before reading such a cluster as the skin.
- **Compare a photo with the others before trusting its reading of one region.** The head-on Navy photo read
  the LEX's edge 1.6 in outside, but it also read the forebody's sides 1.1-1.7 in outside from FS 216 to 384,
  where the other photos fit, while the sharpest head-on view read the LEX within 0.2 in. A photo's median
  offset from the others on the regions they share, and on neighbouring parts, says whether a reading is its
  camera's or the model's.
- **Helpers mark well with a dictionary.** Three helpers marked twelve photos from `../fa18c/marking.md` in an
  hour or so each. Check their marks against the overlays and the flagged misses; they also found the wrong
  photo labels.
- **Measure a part's shape in its own frame.** A camera's registration error at one end of the model moves a
  part as a whole: the F/A-18C's stabilator tips sat 3-6 in apart from photo to photo. Cast the photo's outline
  onto the part's posed plane from the solved camera and fit the shape with the part's offset free: shape
  survives a registration error, position doesn't. The stabilator's trailing corner, fitted as a circle tangent
  to the cited tip and trailing edge, read a 12-13.25 in radius in 7 stabilators of 4 photos, where the model's
  own outline through the same fit read 7.5-8.0 for its 8. Don't judge a round by where the outline seems to
  leave its line: a 13 in circle is still within 0.5 in of its tangent 3.6 in past the tangent point, and that
  reading had put this one at 8 in.
- **A mirrored pair's edge misses carry the camera's registration, left and right in opposite directions.** Read
  a shape (a chord, a span) from the two sides averaged, or from each side against its own other edges (above).
  One side at a time, the F/A-18C's stabilator chord read 2.5 in long; averaged, the three views from straight
  above and below read it within 1 in. The free points' version of this is "Anchor what symmetry gives" above.
  The sky check's misses are + where the model stands outside the photo's edge.
- **A measurement of nothing must fail.** NaN compares false against any tolerance, so a check that reads
  NaN off a missed surface passes. The F/A-18C's `check.result()` turns a non-finite measurement into a
  failure; `test_check.py` holds it.
- **Leave a new photo's marks on surfaces it can't pose out of the shared solve.** Three rear-high photos
  marked on their stabilator tips, hook, drooped flaps and nozzles, with those surfaces' poses guessed,
  dragged the points ten other photos share and failed three edges elsewhere; on fixed structure alone
  (fins, pods, LEX fences) the gate stayed clean. Keep the other marks in the photo's notes until its pose is
  fitted.
- **Triangulate from every pair, and read the spread as the uncertainty.** Photos marked on one cluster of
  structure (all on the fins) leave their distances loose: adding two marks moved a camera 600 in. The
  F/A-18C's speedbrake edges from three photos read 1.4-2.9 in above the skin at one station, pair by pair;
  one pair alone, consistent both ways and stable to a pixel of trace, had said 2.9.
- **Two casts of one line that disagree say the skin is wrong where they meet.** A cast lands where the sight
  line meets the skin, so it moves with the skin's height, an oblique view far more than one square on. The
  F/A-18C's joint behind the canopy cast at FS 333-334 from the right and 338-339 from the left, on a spine
  2 in low. Triangulate the line instead: each pixel along it in one photo against the line's polyline in
  another (mirrored across the centreline for a symmetric line), which needs no skin. Two left photos put
  that joint within 0.3 in of each other, 0.0-0.4 px off their lines.
- **Don't pass a skin through triangulated points one by one.** Points along one line scatter by a few tenths
  of an inch, and a surface drawn exactly through them carries that scatter as waves the eye sees at once:
  the F/A-18C's spine seam, passed point by point, rippled the side 0.5-0.7 in. Build the skin smooth and
  hold it to the points within their spread.
- **Trace a long line densely before triangulating far along it.** A polyline of three points over 100 in
  stands off a curving line between its points, and the triangulation inherits the gap: the F/A-18C's seam
  read 2 in inside a panel joint's end measured at the same station and height.

## Files

- `model.py`: frames, glTF reading and posing, plane cuts, silhouettes, outline distances.
- `camera.py`: the camera, single-photo solves, triangulation, the bundle adjustment.
- `photos.py`: the photo match, overlays, cameras for `view.py`, comparison sheets.
- `view.py`: Blender: renders the model through solved cameras.
- `crop.py`: crops with a labelled pixel grid, for marking.
- `skyline.py`: the outline against the sky in every solved photo, by region, with findings, coverage and
  sheets; with `--reach`, which regions can make the outline at all, and from where.
- `poses.py`: fits each photo's moving parts to its outline against the sky, for the catalogue's poses.
- `page.py`: the review page for one build, from its gate, sky check and sheets.
- `cast.py`: casts a solved photo's pixels onto the posed model's surface or a plane of the project's frame,
  and projects coordinates into a photo to find where to look.
- `test_verify.py`, `test_photos.py`, `test_skyline.py`, `test_poses.py`, `test_page.py`: `python3 -I test_verify.py`, and
  likewise.
