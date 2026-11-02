# Marking the F/A-18C's reference photos

The names and rules for marking points and edges on the reference photos (`photos.json`; procedure in
`../verify/README.md`, step 4). Each point name is a landmark the build exports (its features file), so every
mark has a model counterpart. Accuracy matters more than coverage: a wrong mark is worse than a missing one.
Aim for 3 px at full resolution.

Read pixels with the grid crop, coarse to find a feature, fine to read it, and again with the candidate drawn
on before recording it:

    python3 -I ../verify/crop.py references/photos/FILE x0 y0 x1 y1 STEP OUT.jpg [WIDTH] [x,y:label ...]

## Sides

`left` and `right` are the aircraft's own port and starboard (the pilot's left and right), not the
photo's. In a photo of the jet's right side, the near wing/fin/inlet is the right one. Looking at the
nose from the front, the aircraft's right is on the photo's left. Get this right: it matters.

## Point features (mark only those you can locate to a few pixels)

- `apex`: the very tip of the nose.
- `radome_top`: where the radome joint (a circumferential seam about 5.7 ft behind the tip, where the
  nose cone meets the fuselage) crosses the top centreline / top silhouette of the nose.
- `gun_port`: centre of the gun muzzle port, the small dark slot on the top centreline just ahead of the
  radome joint.
- `windscreen_base`: the windscreen's front base on the centreline, where the glass frame meets the nose top.
- `bow_top`: top of the canopy bow (the frame between the fixed windscreen and the opening canopy), on the centreline.
- `windscreen_top`: top of the fixed windscreen's aft arch, on the centreline. With the canopy shut it is the
  same point as `bow_top`; with the canopy raised, the bow lifts away with it and the arch stays: mark
  `windscreen_top` there, never `bow_top`.
- `canopy_crown`: the highest point of the canopy on the centreline.
- `canopy_aft`: the canopy's aft end on the top centreline, where it meets the spine.
- `bow_foot_left` / `bow_foot_right`: bottom end of the canopy bow on that side, on the canopy sill.
- `sill_aft_left` / `sill_aft_right`: the canopy's aft lower corner on that side (aft end of its sill line).
- `probe_door_front` / `probe_door_aft`: right side only. The refuelling probe's door is a long panel on
  the upper right side of the nose ahead of the windscreen; mark its lower-front and lower-aft corners.
- `lex_apex_left` / `lex_apex_right`: the forward tip of that LEX (leading-edge extension, the thin
  strake along the fuselage side from below the windscreen back to the wing), where its edge leaves the fuselage.
- `lex_wing_left` / `lex_wing_right`: where that LEX's edge meets the wing's leading edge (the kink).
- `lex_fence_top_front_left` / `_right`, `lex_fence_top_aft_left` / `_right`: the top front and top aft
  corners of the small upright fence on that LEX's upper surface.
- The engine inlet sits under the LEX: a D-shaped mouth whose flat side is inboard, facing a curved splitter
  plate that stands off the fuselage just ahead of it. On its lip (its rounded front edge), outer side:
  - `inlet_lip_top_left` / `_right`: the lip's highest point.
  - `inlet_lip_bottom_left` / `_right`: the lip's lowest point.
  - `inlet_lip_outer_left` / `_right`: the lip's most outboard point.
  - `inlet_corner_top_left` / `_right`, `inlet_corner_bottom_left` / `_right`: the top and bottom ends of
    the lip's curve, where it meets the duct's flat inboard wall beside the splitter plate.
- `splitter_top_left` / `_right`, `splitter_bottom_left` / `_right`: the top end (under the LEX) and bottom
  end of the splitter plate's leading edge.
- `fin_tip_leading_left` / `_right`: the fin's top forward corner. `fin_tip_trailing_left` / `_right`:
  its top aft corner (the fin tip carries antenna fairings at the trailing corner: mark the fin's own corner).
- `wingtip_trailing_left` / `_right`: the wingtip's aft outer corner (the wing's own corner, not the
  end of a missile launch rail if one is fitted).
- `wingtip_leading_left` / `_right`: the wingtip's forward outer corner (only if no rail hides it).
- `stabilator_tip_leading_left` / `_right`, `stabilator_tip_trailing_left` / `_right`: the horizontal
  tail's tip corners. The trailing corner is rounded: mark where the tip edge's line and the trailing edge's
  line meet, not a point on the round.
- `axle_main_left` / `_right`: centre of that main wheel's hub, as seen.
- `axle_nose_left` / `_right`: centre of that nose wheel's hub (the nose leg has two wheels side by side).
  Mark a hub only where its outboard face shows; a wheel seen from inboard or tread-on is not an axle mark.
- `wheel_main_left` / `_right`, `wheel_nose_left` / `_right`: a wheel seen tread-on (head-on or from
  behind): the centre of the tyre's silhouette.
- `nozzle_root_bottom_left` / `_right`: bottom of that engine nozzle where its petals start.
- `nozzle_exit_bottom_left` / `_right`: bottom of that nozzle's exit lip.
- `hook_point`: the tip of the stowed arresting hook's shoe, under the tail between the nozzles (not where the
  shank passes into the body's outline in a side view, about 35 in forward of it).
- `hook_pivot`: the centre of the round end cap on the arresting hook's pivot fitting, at the shank's forward
  end under the aft fuselage.
- `fold_trailing_left` / `_right`: the trailing-edge flap's outboard trailing corner, at the wing-fold line
  (the aileron's inboard corner lies just outboard of it, a few inches of gap between them).
- `wingtip_trailing_*` is the aileron's outer trailing corner: the aileron runs to the tip. Both it and
  `fold_trailing_*` droop with the flaps on the ground (often 40-45 deg); the solver fits that per photo.
- `aoa_left` / `_right`: the centre of that angle-of-attack probe's round base plate, on the nose's side
  ahead of the windscreen (a short cone stands straight out of it).
- `pitot_tip_left` / `_right`: the front tip of that pitot-static tube, the L-shaped probe low on the nose's
  side ahead of the nose gear.
- `blade_nose_bottom_front` / `blade_nose_bottom_aft`: the lower corners of the blade antenna hanging under
  the nose on the centreline (stencilled DO NOT PAINT).

You may add other crisp, unambiguous points (panel corners, light fittings) that a second photo of yours
also shows, with a descriptive snake_case name and a note: they help tie the cameras together.

## Edges

An edge is 5-15 points along a clearly visible line, in order, each on the line to +-3 px:

- `against: "outline"`: a stretch of the aircraft's silhouette against sky or plain background where
  only the airframe forms the edge (no stores, people, vehicles, shadows). Give each a descriptive name
  (`nose_top`, `canopy`, `spine`, `belly_forward`, `fin_left_trailing`, ...).
- `against: "lex_edge_left"` / `"lex_edge_right"`: that LEX's leading edge.
- `against: "inlet_lip_left"` / `"inlet_lip_right"`: that inlet lip's front edge, from one inner corner
  round the outside to the other.
- `against: "splitter_left"` / `"splitter_right"`: that splitter plate's leading edge, top to bottom.
- `against: "fin_leading_left"` / `"fin_leading_right"`: that fin's leading edge.
- `against: "canopy_sill_left"` / `"canopy_sill_right"`: the canopy's lower edge on that side, bow foot to aft corner.
- `against: "stabilator_leading_left"` etc.: only if the tail looks undeflected.

Add `"snap": 6` to an edge that runs between strongly contrasting areas: the solver then moves each
point to the strongest edge within 6 px.

## Pose

Say how the jet stood: `"pose": {"gear": 1}` for gear down; add `"canopy": 1` if the canopy is open;
note in `notes` anything deflected (flaps, slats, stabilators, rudders) and roughly how much.

## Recording

Each photo's entry in `photos.json`: `file`, `pose`, `marks` (`{"name": [x, y]}`), `edges`
(`{"name": {"against": ..., "points": [[x, y], ...], "snap": 6}}`) and `locate` for pixels to cast onto a
plane. Note in the photo's entry anything uncertain.
