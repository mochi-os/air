"""The catapult control cabs (ICCS "bubbles"): where they stand and how big they are, in one
place for bake_decktex.py (the steel deck plate and its red/yellow border), build_carrier.py
(the cab) and edgecheck.py.

Two cabs, raised for launching: the bow cab between cats 1 and 2, the waist cab at the port
deck edge outboard of cat 4 (navysite.de's flight deck page; the Navy's flight deck manual,
NAVAIR 00-80T-120, calls it the "deckedge ICCS"; the 1:200 plan). The bow cab stands at the
plan's fa, centred in the gap between the two dashed lines that run between cats 1 and 2, where
the plan draws it. The plan draws the waist cab outboard of the painted deck-edge line, its
inboard side on the line; ours is the same, but 4.7 m aft of the plan's fa: the traced deck
edge notches in by 1.3 m at the plan's spot (fa -32 to -23), and the cab's plate keeps 0.15 m
inside it. That leaves the main wheels of a jet on cat 4 about 2.4 m clear, as on the plan.
Each cab lies along the catapults it serves.

No dimensions are published. Navy photographs show an octagon whose walls slope inward, two
windows on each long side about as wide as the single window at each end, one on each corner,
and a flat roof with a round hatch; the side-on photograph's length-to-height ratio fixes the
height. The plan draws both cabs about 2.5 m across.
Deck frame, post-squash metres: fa forward, lat to starboard."""
import numpy as np

# (fa, lat, heading as d(lat)/d(fa) of the long axis)
CABS = [(43.5, 9.71, -0.0289),   # bow: halfway between cat 1's and cat 2's headings
        (-33.5, -32.80, 0.0)]    # waist: along cat 4
LENGTH, WIDTH, CHAMFER, HEIGHT = 3.6, 2.2, 0.5, 0.6   # the base octagon, and the roof above the deck
PLATE = 0.30                 # steel deck plate around the base, its outer BORDER painted
BORDER, DASH = 0.12, 0.70    # the plate's red/yellow border: width, dash length
HATCH = (-0.25, 0.32, 0.06)  # the round roof hatch: along the cab from its centre, radius, height
WHEEL_CLEAR = 2.0            # least distance from any catapult's centreline to a cab's base (edgecheck.py)


def axes(cab):
    # centre, unit long axis, unit cross axis (to starboard when the cab points forward)
    f, l, m = cab
    u = np.array([1.0, m]) / np.hypot(1.0, m)
    return np.array([f, l]), u, np.array([-u[1], u[0]])


def octagon(length, width, chamfer):
    # a chamfered rectangle in the cab's own frame (x along, y across), corners anticlockwise
    a, b, c = length / 2, width / 2, chamfer
    return np.array([(a, b - c), (a - c, b), (-a + c, b), (-a, b - c),
                     (-a, -b + c), (-a + c, -b), (a - c, -b), (a, -b + c)])


def footprint(cab, grow=0.0):
    # the base octagon in the deck frame with every edge moved out by grow: the 45-degree
    # corners keep their angle, so their cut grows by grow*(2-sqrt 2)
    o = octagon(LENGTH + 2 * grow, WIDTH + 2 * grow, CHAMFER + grow * (2 - np.sqrt(2)))
    c, u, w = axes(cab)
    return c + o[:, :1] * u + o[:, 1:] * w
