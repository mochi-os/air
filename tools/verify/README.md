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
  or feet aft of the bow, height above the keel or waterline, and offset from the centreline.
- `points`: coordinates the sources cite, any of the three, each with its uncertainty: the anchors. Add what
  symmetry gives for free: a point on the centreline has offset 0.
- `mirror`: the suffixes of left and right pairs, solved as one point and its mirror image. Leave it out for
  anything asymmetric (a carrier's island).
- `photos`: per photo, where each named point falls (`marks`), traced `edges`, the `pose` the model takes to
  match it (gear down, canopy open, surfaces deflected), pixels to cast onto a plane (`locate`), and
  `"solve": false` for one kept on file but too thinly marked to solve.

Marking: read every pixel at full resolution with `crop.py` (a labelled grid), coarse to find, fine to read,
then once more with the candidate drawn on before recording it. Mark corners and crisp seams; a wrong mark is
worse than a missing one. Trace an edge with 5-15 points; add `"snap": 6` where it runs between strong
contrasts, and the solver moves each point onto the strongest edge nearby. The point names are the build's
landmark names (the features file, step 5), so each photo point has a model counterpart. Marking can be
shared out to helpers with a written dictionary of the names (`../fa18c/marking.md`); check their marks on
the overlays and in the bundle's misses.

### 5. The bundle: solve, measure, compare

The build writes a features file beside the model: named points and curves, each with the node it rides on
(`../fa18c/build.py`, third output). Then:

    python3 -I photos.py CATALOGUE MODEL.glb POINTS.json FEATURES.json --overlays DIR --cameras CAMERAS.json

solves every photo's camera (focal length, pose, one radial distortion term) and every marked point at once
(`camera.Bundle`), with the anchors as priors and a robust loss for stray marks. The model's own positions
only start the solve. It reports:

- each photo's fit (pixels), and each mark's miss in project units at the depth it lies;
- each point the photos measure, with its uncertainty, beside the model's, and the miss. A point seen from
  only one direction is reported `loose` along that camera's line of sight: the photos fix a line, not a
  point, so it is measured at the line's nearest point to the model's and its miss is the part the photo
  sees, across the line;
- how far the photos pull each anchor: a large pull means the citation or the marks are wrong;
- each traced edge's distance from the posed model's silhouette (signed: + where the model stands outside the
  photo's edge) or from one of the build's curves.

A miss on a fitted placement settles it: move the layout entry and cite the photo match. A miss on a cited
fact is a question: check the marks, then the citation.

### 6. Comparison sheets: look

    blender -b --factory-startup -P view.py -- MODEL.glb POINTS.json CAMERAS.json RENDERS
    python3 -I photos.py CATALOGUE MODEL.glb POINTS.json FEATURES.json --sheets RENDERS SHEETS

renders the posed model through every solved camera and lays it beside and over the straightened photo. This
is where blends, creases, gaps and missing parts show, which no number above catches. Review every sheet,
region by region.

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
| sheets | small offsets (use the numbers); colour and texture are not shape |

## Pitfalls

What went wrong on the F/A-18C, each a rule now:

- **Spread the marks in depth.** A photo whose marks bunch at one end (a rear view marking only fins, nozzles
  and wheels) leaves focal length and distance trading off, and its camera runs off to a distant telephoto. Mark
  six or more points spread along the whole object; a photo that cannot have them goes in the catalogue with
  `"solve": false` and a note why.
- **Long lenses see depth weakly.** A photo from far off is nearly orthographic: it measures across its line of
  sight well and along it hardly at all. The bundle holds a photo without EXIF focal length to a field of view
  between 1 and 100 degrees; it reads EXIF where the file keeps it.
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
- **A check that skips steps can't see a cliff.** The bend check leaves out windows holding a jump between
  surfaces, which is right where parts meet. A fairing that stood level and then dropped 6.6 in within one
  ring span read as two surfaces and passed. Where no step is real, count a step as the bend it is.
- **Helpers mark well with a dictionary.** Three helpers marked twelve photos from `../fa18c/marking.md` in an
  hour or so each. Check their marks against the overlays and the flagged misses; they also found the wrong
  photo labels.

## Files

- `model.py`: frames, glTF reading and posing, plane cuts, silhouettes, outline distances.
- `camera.py`: the camera, single-photo solves, triangulation, the bundle adjustment.
- `photos.py`: the photo match, overlays, cameras for `view.py`, comparison sheets.
- `view.py`: Blender: renders the model through solved cameras.
- `crop.py`: crops with a labelled pixel grid, for marking.
- `cast.py`: casts a solved photo's pixels onto the posed model's surface or a plane of the project's frame,
  and projects coordinates into a photo to find where to look.
- `test_verify.py`, `test_photos.py`: `python3 -I test_verify.py`, `python3 -I test_photos.py`.
