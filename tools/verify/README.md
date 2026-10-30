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
- each point the photos measure, with its uncertainty, beside the model's, and the miss: a point seen in one
  photo is loose along that camera's line of sight, and its uncertainty says so;
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
- **Distrust a lone answer.** The reported uncertainty is optimistic for a coordinate few photos see across.
  Re-solve with photos added or removed: a value that moves by more than its uncertainty is not settled.
- **Static is not taxiing.** Photos of moving jets sit at their own attitude; a manual's static heights describe
  another. Say which a number is.
- **A miss may be a definition.** A flat canopy top has no single crown; a sloping bow has no single station.
  Before moving the model, check what the mark means on it.
- **Helpers mark well with a dictionary.** Three helpers marked twelve photos from `../fa18c/marking.md` in an
  hour or so each. Check their marks against the overlays and the flagged misses; they also found the wrong
  photo labels.

## Files

- `model.py`: frames, glTF reading and posing, plane cuts, silhouettes, outline distances.
- `camera.py`: the camera, single-photo solves, triangulation, the bundle adjustment.
- `photos.py`: the photo match, overlays, cameras for `view.py`, comparison sheets.
- `view.py`: Blender: renders the model through solved cameras.
- `crop.py`: crops with a labelled pixel grid, for marking.
- `test_verify.py`, `test_photos.py`: `python3 -I test_verify.py`, `python3 -I test_photos.py`.
