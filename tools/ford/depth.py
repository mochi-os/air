# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# The game camera's depth buffer, for the faces that lie a little behind
# others: the build stands parts off far enough (build.py) and the stacks
# check holds it to it (stacks.py). The camera (engine.ts) has its near plane
# at NEAR, a FIELD of view over LINES lines, and a 24-bit buffer, whose step
# at distance d is d^2 / (NEAR 2^24). Two faces fight from the distance where
# their overlap spans PIXELS lines, so a gap must clear STEPS steps there: a
# plate 0.5 m across needs 4 mm, a door 8 m across 0.96 m. No imports beyond
# the standard library: Blender's Python reads it too
import math

NEAR = 3.0       # metres: the game camera's near plane
FIELD = 45.0     # degrees: its field of view, top to bottom
LINES = 1080     # the lines it draws them over
PIXELS = 3       # how many of them a place spans for its stripes to show
STEPS = 4        # steps of the depth buffer the gap must clear there


def needed(size):
	# The gap a place `size` across needs
	distance = size * LINES / (2 * math.tan(math.radians(FIELD) / 2) * PIXELS)
	return STEPS * distance ** 2 / (NEAR * 2 ** 24)
