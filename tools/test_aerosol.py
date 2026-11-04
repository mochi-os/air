# Copyright © 2026 Mochisoft OÜ
# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.
#
# Tests for aerosol.py: the images read back to the colour map's depths, months averaged over the
# years, nodes laid where the client's lookup expects them, and the table packed as it decodes.
#
# usage: python3 -I test_aerosol.py
import base64, re, sys, tempfile, unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import aerosol

MAP = """<ColorMaps><ColorMap title="No Data"><Entries>
<ColorMapEntry rgb="255,0,255" transparent="true" nodata="true" ref="0"/></Entries></ColorMap>
<ColorMap title="Aerosol"><Entries>
<ColorMapEntry rgb="255,255,229" transparent="false" sourceValue="[-INF,0.000)" value="[-INF,0.000)" ref="1"/>
<ColorMapEntry rgb="254,246,186" transparent="false" sourceValue="[0.005,0.010)" value="[0.005,0.010)" ref="3"/>
<ColorMapEntry rgb="244,130,29" transparent="false" sourceValue="[0.490,0.495)" value="[0.490,0.495)" ref="100"/>
<ColorMapEntry rgb="102,37,6" transparent="false" sourceValue="[0.900,+INF)" value="[0.900,+INF)" ref="182"/>
</Entries></ColorMap></ColorMaps>"""


def flat(value):
    return [[value] * aerosol.WIDTH for _ in range(aerosol.HEIGHT)]


class Colours(unittest.TestCase):
    def test_reads_each_bin_at_its_middle_and_the_open_bins_at_their_ends(self):
        table = aerosol.colours(MAP)
        self.assertAlmostEqual(table[(254, 246, 186)], 0.0075)
        self.assertAlmostEqual(table[(244, 130, 29)], 0.4925)
        self.assertEqual(table[(255, 255, 229)], 0.0)
        self.assertEqual(table[(102, 37, 6)], aerosol.TOP)

    def test_leaves_out_the_no_data_colour(self):
        self.assertNotIn((255, 0, 255), aerosol.colours(MAP))


class Read(unittest.TestCase):
    def setUp(self):
        from PIL import Image
        self.Image = Image
        self.folder = tempfile.TemporaryDirectory()
        self.path = Path(self.folder.name) / "2020-03.png"

    def tearDown(self):
        self.folder.cleanup()

    def write(self, colour, size=(aerosol.WIDTH, aerosol.HEIGHT), at=None, other=None):
        picture = self.Image.new("RGBA", size, colour + (255,))
        if at:
            picture.putpixel(at, other + (255,))
        picture.save(self.path)

    def test_reads_every_pixel_as_its_bins_depth(self):
        self.write((254, 246, 186), at=(10, 20), other=(244, 130, 29))
        grid = aerosol.read(self.path, aerosol.colours(MAP))
        self.assertEqual((len(grid), len(grid[0])), (aerosol.HEIGHT, aerosol.WIDTH))
        self.assertAlmostEqual(grid[0][0], 0.0075)
        self.assertAlmostEqual(grid[20][10], 0.4925)

    def test_refuses_a_colour_that_is_no_bin(self):
        self.write((254, 246, 186), at=(5, 5), other=(250, 240, 180))  # blended between two bins
        with self.assertRaises(ValueError):
            aerosol.read(self.path, aerosol.colours(MAP))

    def test_refuses_an_image_of_another_size(self):
        self.write((254, 246, 186), size=(720, 360))
        with self.assertRaises(ValueError):
            aerosol.read(self.path, aerosol.colours(MAP))


class Nodes(unittest.TestCase):
    def test_takes_the_mean_of_the_years(self):
        self.assertEqual(aerosol.mean([flat(0.1), flat(0.3)])[7][9], 0.2)

    def test_lays_the_table_every_ten_degrees_from_90_north_and_180_west(self):
        self.assertEqual((aerosol.SPACING, aerosol.ROWS, aerosol.COLUMNS), (10, 19, 37))
        grid = flat(0.1)
        grid[89 - 28][1] = 0.9  # the cell 28-29 N, 179-178 W: Midway's corner of the world
        table = aerosol.nodes(grid)
        self.assertEqual((len(table), len(table[0])), (aerosol.ROWS, aerosol.COLUMNS))
        # its centre, 28.5 N 178.5 W, is inside the hundred cells within 5 degrees of the node
        # 30 N 180 W, and outside those of every other node
        self.assertAlmostEqual(table[6][0], 0.1 + 0.8 / 100)
        for i, j in ((5, 0), (7, 0), (6, 1), (6, aerosol.COLUMNS - 2)):
            self.assertAlmostEqual(table[i][j], 0.1, msg=(i, j))

    def test_averages_every_cell_within_five_degrees_and_none_past(self):
        grid = flat(0.1)
        for y in range(89 - 34, 89 - 24):  # the cells 25-35 N
            for x in range(175, 185):  # the cells 5 W to 5 E
                grid[y][x] = 0.5
        table = aerosol.nodes(grid)
        self.assertAlmostEqual(table[6][18], 0.5)  # 30 N 0 E: exactly that block
        self.assertAlmostEqual(table[6][17], 0.1)  # 30 N 10 W: none of it
        self.assertAlmostEqual(table[5][18], 0.1)  # 40 N 0 E: none of it

    def test_wraps_across_180_west_and_repeats_the_first_column_last(self):
        grid = flat(0.1)
        grid[45][359] = 0.5  # the cell 44-45 N, 179-180 E: just across the antimeridian from 180 W
        table = aerosol.nodes(grid)
        self.assertAlmostEqual(table[5][0], 0.1 + 0.4 / 100)  # 40 N 180 W
        self.assertAlmostEqual(table[5][aerosol.COLUMNS - 1], 0.1 + 0.4 / 100)

    def test_takes_the_five_rows_of_cells_beside_each_pole(self):
        grid = flat(0.1)
        for x in range(aerosol.WIDTH):
            grid[0][x] = 0.5
        table = aerosol.nodes(grid)
        self.assertAlmostEqual(table[0][18], (0.5 + 4 * 0.1) / 5)  # 90 N: the 85-90 N cells
        self.assertAlmostEqual(table[1][18], 0.1)  # 80 N: the 75-85 N cells


class Pack(unittest.TestCase):
    def test_packs_each_node_in_steps_month_by_month(self):
        months = [[[0.1 * (m + 1)] * aerosol.COLUMNS for _ in range(aerosol.ROWS)] for m in range(aerosol.MONTHS)]
        data = aerosol.pack(months)
        self.assertEqual(len(data), aerosol.MONTHS * aerosol.ROWS * aerosol.COLUMNS)
        size = aerosol.ROWS * aerosol.COLUMNS
        self.assertEqual(data[0], 25)  # January's 0.1
        self.assertEqual(data[2 * size], 75)  # March's 0.3
        self.assertEqual(aerosol.pack([[[2.0]]])[0], 255)  # held to a byte
        self.assertEqual(aerosol.pack([[[0.007]]])[0], 2)  # to the nearest step, 1.75 of them

    def test_writes_the_module_the_client_imports(self):
        text = aerosol.ts(bytes([1, 2, 3]))
        self.assertIn("GENERATED by tools/aerosol.py", text)
        for name, value in (("SPACING", aerosol.SPACING), ("ROWS", aerosol.ROWS), ("COLUMNS", aerosol.COLUMNS), ("MONTHS", aerosol.MONTHS), ("STEP", aerosol.STEP)):
            self.assertRegex(text, rf"\nexport const {name} = {re.escape(str(value))}\n")
        self.assertEqual(base64.b64decode(re.search(r"AEROSOL = '([^']*)'", text).group(1)), bytes([1, 2, 3]))


if __name__ == "__main__":
    unittest.main()
