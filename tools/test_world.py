#!/usr/bin/env python3
# Copyright © 2026 Mochisoft OÜ
# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
"""Tests for world.py, the low quality global map's baker: the arc-metre grid, the
resampling onto it, the land outline drawn as each pixel's share of land and written as
land.bin, the colour carried over the sea, and the baked map agreeing with land.bin."""
import json
import math
import struct
import unittest

import numpy as np
from PIL import Image

import world


class Grid(unittest.TestCase):
    def test_a_pixel_spans_its_metres_of_equatorial_arc(self):
        self.assertEqual(world.size(2048), (19568, 9784))
        self.assertEqual(world.size(8192), (4892, 2446))
        # the global grid is the fine one four to a side, to the pixel
        self.assertEqual(world.size(2048)[0] // 4, world.size(8192)[0])
        self.assertEqual(world.size(2048)[1] // 4, world.size(8192)[1])
        metres_per_degree = world.EQUATOR * math.pi / 180   # along the equator
        self.assertAlmostEqual(math.degrees(2048 / world.EQUATOR) * metres_per_degree, 2048, places=6)

    def test_centres_and_places_are_inverse(self):
        for column, row in ((0, 0), (19567, 9783), (8000, 3100)):
            longitude, latitude = world.centre(2048, column, row)
            x, y = world.place(2048, longitude, latitude)
            self.assertAlmostEqual(x, column + 0.5, places=9)
            self.assertAlmostEqual(y, row + 0.5, places=9)
        self.assertEqual(world.place(2048, -180, 90), (0, 0))


class Resample(unittest.TestCase):
    def test_samples_the_source_where_each_pixel_lies(self):
        # a source whose red is its longitude in degrees east of 180 W, over 0..359
        width, height = 360, 180
        source = np.zeros((height, width, 3), np.uint8)
        source[:, :, 0] = np.arange(width)[None, :] % 256
        source[:, :, 1] = np.arange(height)[:, None]
        out = world.resample(source, 200000, 0, 10)
        step = math.degrees(200000 / world.EQUATOR)
        for column in (3, 20, 50):
            longitude = (column + 0.5) * step   # degrees east of 180 W
            self.assertAlmostEqual(out[0, column, 0], longitude - 0.5, delta=1e-3)
            latitude = (5 + 0.5) * step   # degrees south of 90 N
            self.assertAlmostEqual(out[5, column, 1], latitude - 0.5, delta=1e-3)

    def test_wraps_east_west_past_the_antimeridian(self):
        source = np.zeros((180, 360, 3), np.uint8)
        source[:, 0] = 200   # the first column of the source, at 180 W
        # at 150 km a pixel the grid's last centre lies at 180.45 E, past the source's last
        # column centre (179.5 E): it takes most of its colour from the first column, at 180 W
        step = math.degrees(150000 / world.EQUATOR)
        width = world.size(150000)[0]
        self.assertAlmostEqual(-180 + (width - 0.5) * step, 180.45, delta=0.01)
        out = world.resample(source, 150000, 0, 1)
        self.assertAlmostEqual(out[0, -1, 0], 200 * 0.95, delta=1)
        self.assertEqual(out[0, -2, 0], 0)


class Land(unittest.TestCase):
    def test_draws_the_share_of_each_pixel_that_is_land(self):
        step = math.degrees(200000 / world.EQUATOR)
        # a square of land covering pixels 2..4 by 3..5 exactly, and half of pixel 5 across
        west, east = -180 + 2 * step, -180 + 5.5 * step
        north, south = 90 - 3 * step, 90 - 6 * step
        polygons = [[[(west, north), (east, north), (east, south), (west, south), (west, north)]]]
        share = world.land(polygons, 200000, 0, 0, 8, 8)
        self.assertEqual(share[4, 3], 255)
        self.assertEqual(share[4, 1], 0)
        self.assertAlmostEqual(int(share[4, 5]), 128, delta=1)
        self.assertEqual(share[2, 3], 0)

    def test_cuts_out_a_hole(self):
        step = math.degrees(200000 / world.EQUATOR)
        outer = [(-180, 90), (-180 + 8 * step, 90), (-180 + 8 * step, 90 - 8 * step), (-180, 90 - 8 * step)]
        hole = [(-180 + 3 * step, 90 - 3 * step), (-180 + 5 * step, 90 - 3 * step), (-180 + 5 * step, 90 - 5 * step), (-180 + 3 * step, 90 - 5 * step)]
        share = world.land([[outer, hole]], 200000, 0, 0, 8, 8)
        self.assertEqual(share[1, 1], 255)
        self.assertEqual(share[4, 4], 0)

    def test_sees_land_past_the_antimeridian_from_the_last_column(self):
        # land just east of 180 W lies under the grid's last pixel, which runs past 180 E
        width = world.size(2048000)[0]
        polygons = [[[(-180, 10), (-175, 10), (-175, -10), (-180, -10)]]]
        span = width * math.degrees(2048000 / world.EQUATOR) - 360   # degrees the last pixel runs past 180 E: 7.9
        self.assertGreater(span, 5)
        share = world.land(polygons, 2048000, width - 1, 4, 1, 1)
        # the pixel's samples lie 4.6 degrees apart from 171.85 E; the one at 181.05 E (178.95 W) is
        # land, in the three sample rows between 10 N and 10 S: 3 of 16
        self.assertEqual(share[0, 0], round(3 * 255 / 16))
        self.assertEqual(world.land(polygons, 2048000, width - 2, 4, 1, 1)[0, 0], 0)


class LandFile(unittest.TestCase):
    def test_toggles_clip_to_the_earth_and_merge_where_spans_meet(self):
        # spans in 512 m samples; a unit is 64 m, eight to a sample
        span = np.array([[2.0, 3.0], [3.0, 5.0], [-1.0, 0.5], [9.0, 12.0]])
        self.assertEqual(world.toggles(span, 2048, 80), [0, 4, 16, 40, 72, 80])
        self.assertEqual(world.toggles(np.zeros((0, 2)), 2048, 80), [])

    def test_round_trips_through_the_file_and_answers_by_the_hosts_rule(self):
        units = math.ceil(2 * math.pi * world.EQUATOR / world.UNIT)
        rows = [[] for _ in range(4)]
        # in the second row (90 N less 512-1024 m), land from 100 to 200 units and 300 to the earth's end
        rows[1] = [100, 200, 300, units]
        data = world.encode(rows, units)
        self.assertEqual(data[:4], b"LAND")
        latitude = 90 - math.degrees(1.5 * world.ROW / world.EQUATOR)   # the second row's middle
        def at(unit):
            return -180 + math.degrees((unit + 0.5) * world.UNIT / world.EQUATOR)
        self.assertFalse(world.landed(data, latitude, at(99)))
        self.assertTrue(world.landed(data, latitude, at(100)))
        self.assertTrue(world.landed(data, latitude, at(199)))
        self.assertFalse(world.landed(data, latitude, at(200)))
        self.assertTrue(world.landed(data, latitude, at(300)))
        self.assertTrue(world.landed(data, latitude, 179.99))
        self.assertFalse(world.landed(data, 90 - math.degrees(0.5 * world.ROW / world.EQUATOR), at(150)))   # the first row is all sea

    def test_varints_round_trip(self):
        for value in (0, 1, 127, 128, 300, 626173, 2 ** 31):
            encoded = world.varint(value)
            self.assertEqual(world.unvarint(encoded, 0), (value, len(encoded)))


class Spread(unittest.TestCase):
    def test_carries_the_coast_colour_over_the_sea_and_leaves_land_alone(self):
        colour = np.zeros((5, 5, 3), np.float32)
        colour[:, :2] = (100, 150, 50)   # land
        colour[:, 2:] = (0, 0, 80)       # the source's ocean
        share = np.zeros((5, 5), np.uint8)
        share[:, :2] = 255
        out = world.spread(colour, share, passes=3)
        self.assertTrue(np.allclose(out[:, :2], (100, 150, 50)))
        self.assertTrue(np.allclose(out[:, 2:], (100, 150, 50)))   # no ocean blue left next to the coast

    def test_does_not_reach_across_from_the_far_edge(self):
        colour = np.zeros((6, 6, 3), np.float32)
        colour[0, :] = (255, 0, 0)   # land along the top edge only
        share = np.zeros((6, 6), np.uint8)
        share[0, :] = 255
        out = world.spread(colour, share, passes=1)
        self.assertTrue(np.allclose(out[1], (255, 0, 0)))
        self.assertTrue(np.allclose(out[5], 0))   # the bottom row is not the top row's neighbour


class Baked(unittest.TestCase):
    """The map as world.py last wrote it: the drawn land and the land the hosts collide with are one outline."""

    def setUp(self):
        land = world.OUT / "land.bin"
        if not land.exists():
            self.skipTest("the world map is not baked")
        data = land.read_bytes()
        version, self.row, self.unit, count, units = struct.unpack_from("<BHHII", data, 4)
        position = 4 + struct.calcsize("<BHHII")
        self.rows = []
        for _ in range(count):
            n, position = world.unvarint(data, position)
            values, last = [], 0
            for _ in range(n):
                gap, position = world.unvarint(data, position)
                last += gap
                values.append(last)
            self.rows.append(np.array(values))
        self.manifest = json.loads((world.OUT / "world.json").read_text())

    def landed(self, latitude, longitude):
        """The hosts' rule (flight/land.go), radians."""
        row = min(len(self.rows) - 1, max(0, int((math.pi / 2 - latitude) * world.EQUATOR / self.row)))
        unit = int(((longitude + math.pi) % (2 * math.pi)) * world.EQUATOR / self.unit)
        return int(np.searchsorted(self.rows[row], unit, side="right")) % 2 == 1

    def agreement(self, share, metres, top, left, step):
        same = total = 0
        for y in range(0, share.shape[0], step):
            for x in range(0, share.shape[1], step):
                latitude = math.pi / 2 - (top + y + 0.5) * metres / world.EQUATOR
                longitude = -math.pi + (left + x + 0.5) * metres / world.EQUATOR
                if latitude < -math.pi / 2 or longitude >= math.pi:
                    continue
                total += 1
                same += (share[y, x] > 127) == self.landed(latitude, longitude)
        return same / total

    def test_the_fine_tiles_draw_the_land_the_hosts_collide_with(self):
        tile = self.manifest["fine"]["tile"]
        for row, column in [(1, 10), (2, 9), (4, 13), (1, 0), (1, 19), (9, 5)]:  # the Baltic, Biscay, south India, Chukotka either side of 180, Antarctica
            share = np.asarray(Image.open(world.OUT / "fine" / f"{row}-{column}-land.png"))
            self.assertGreater(self.agreement(share, world.FINE, row * tile, column * tile, 4), 0.99, f"tile {row}-{column}")

    def test_the_global_level_draws_it_too(self):
        share = np.asarray(Image.open(world.OUT / "global-land.png"))
        self.assertGreater(self.agreement(share, world.GLOBAL, 0, 0, 3), 0.97)


if __name__ == "__main__":
    unittest.main()
