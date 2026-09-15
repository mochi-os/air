// Mochi Air: drawn oleo travel (#203)
//
// The flight model carries the jet by PENETRATION: flight/gear.go's strut()
// treats leg.Attach as the contact point and generates lift from
// depth = surface - point.Y, so a loaded wheel's contact point sits BELOW the
// runway by load/stiffness (measured ~3 cm nose, ~8 cm mains at 15.8 t, and up
// to Travel*3 under a touchdown transient). Travel never positions the wheel;
// it only clamps the bottoming-out.
//
// The drawn aircraft is one rigid group hung off that same origin, so as a
// strut compresses the drawn wheel descends with the airframe and buries
// itself in the runway - the reported defect. Nothing in the drawing absorbs
// the stroke: the model's `squat` scrub is a single fixed clip fraction,
// applied to all three legs alike and blind to load.
//
// The correction is a per-leg vertical offset of the drawn wheel, closing the
// loop on geometry the client already has (the tyre node's world position, its
// calibrated radius, and the terrain under it). No new state crosses the wasm
// boundary for it: State's own contract says contact bookkeeping that geometry
// can re-derive - strut compression named explicitly - is not carried there.

const clamp = (v: number, low: number, high: number) => (v < low ? low : v > high ? high : v)

// flatten returns how far a loaded tyre's drawn circle should cross the ground
// plane — the contact patch. A tyre is not rigid: it flattens under load and
// the axle drops, so seating the drawn circle exactly tangent to the runway
// draws it a few centimetres too high.
//
// `depth` is the strut compression the physics is carrying (surface minus the
// contact point, the same quantity gear.go turns into spring force), so the
// load is depth*strut and the tyre gives load/tyre. It therefore eases off on
// its own as the wing takes the weight through the takeoff roll — no separate
// schedule — and the bottoming-out clamp is the physics' own Travel*3.
//
// A circle sunk into an opaque plane renders cut flat at the waterline, which
// is what a flattened tyre looks like; this is the standard approximation for
// a tyre whose mesh cannot deform.
export function flatten(
  depth: number,
  strut: number,
  tyre: number,
  travel: number,
  limit = 0,
): number {
  if (!(depth > 0) || !(tyre > 0) || !(strut > 0)) return 0
  if (!Number.isFinite(depth)) return 0
  const carried = travel > 0 ? Math.min(depth, travel * 3) : depth
  const sink = (carried * strut) / tyre
  // A tyre is linear only over its working range, and `limit` is the largest
  // contact patch this wheel may draw: 4.8 cm mains, 0.8 cm nose.
  //
  // These are a VISUAL calibration, chosen against the runway screenshots, and
  // they sit BELOW the physical deflection this airframe produces — 6.1 cm at
  // the mains' measured 0.079 m of strut compression, 1.3 cm at the nose's
  // 0.027. (The mains' physical figure is essentially the published rated 6.3 cm
  // for a 30x11.5-14.5, so the model is honest; the cap is a deliberate choice
  // to draw less of it.) The jet's weight is NOT the reason — the flight model
  // rests at exactly its own equilibrium, ratio 1.000, once the runway is
  // collided at the height it is drawn (#220).
  return limit > 0 ? Math.min(sink, limit) : sink
}

// ease moves current toward target at rate m/s, landing exactly on it.
function ease(current: number, target: number, dt: number, rate: number): number {
  const delta = target - current
  const step = rate * Math.max(dt, 0)
  if (Math.abs(delta) <= step) return target
  return current + Math.sign(delta) * step
}

// oleo returns the next vertical offset, in metres, for one drawn wheel.
//
// `bottom` is the tyre's lowest point in world y WITH the current offset
// already applied (it is measured off the posed node), and `ground` the
// surface beneath that wheel, so the offset that would seat the tyre is
// current - (bottom - ground). Beyond `reach` above the surface the wheel is
// flying and the correction retires, which also keeps a bad terrain sample
// from stretching the gear: nothing can displace a wheel further than `reach`.
// `reach` bounds a bad terrain sample, not the rotation artefact — the caller
// seats only a LOADED strut, and that is what keeps a flying wheel attached.
// It must still clear the real geometric shortfall: the drawn gear is shorter
// than the physics strut, and asymmetrically so (the left main needs 17 cm, the
// right 13), which is why this is not a couple of centimetres.
export function oleo(
  bottom: number,
  ground: number,
  current: number,
  dt: number,
  reach = 0.25,
  rate = 3,
): number {
  if (!Number.isFinite(bottom) || !Number.isFinite(ground) || ground < -1e7)
    return ease(current, 0, dt, rate) // no surface under this wheel
  const gap = bottom - ground // >0 the tyre floats, <0 it is through the surface
  if (gap > reach) return ease(current, 0, dt, rate) // airborne: draw the gear as authored
  return ease(current, clamp(current - gap, -reach, reach), dt, rate)
}
