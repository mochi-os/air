"""ship.py: the deck layout file the engine and these tools share. Run from this directory:
python3 -m unittest test_ship"""
import math, os, tempfile, unittest
from pathlib import Path
import numpy as np
import ship, cabs


class Layout(unittest.TestCase):
    def test_file_keeps_its_own_layout(self):
        # save() writes dumps(); a file the build re-saves unchanged stays byte for byte the same
        self.assertEqual(ship.dumps(ship.SHIP) + '\n', ship.PATH.read_text())

    def test_save_writes_only_a_change(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'ship.json'
            path.write_text(ship.dumps(ship.SHIP) + '\n')
            was, ship.PATH = ship.PATH, path
            try:
                before = path.stat().st_mtime_ns
                self.assertFalse(ship.save(ship.SHIP))
                self.assertEqual(path.stat().st_mtime_ns, before)
                changed = dict(ship.SHIP, outline=ship.SHIP['outline'][:-1])
                self.assertTrue(ship.save(changed))
                self.assertEqual(path.read_text(), ship.dumps(changed) + '\n')
            finally:
                ship.PATH = was

    def test_points_eight_to_a_line(self):
        text = ship.dumps({'outline': [[i, -i] for i in range(10)], 'line': [[1, 2], [3, 4]]})
        self.assertIn('[0, 0], [1, -1], [2, -2], [3, -3], [4, -4], [5, -5], [6, -6], [7, -7],\n', text)
        self.assertIn('"line": [[1, 2], [3, 4]]', text)


class Geometry(unittest.TestCase):
    def test_line_runs_through_the_spot_turning_to_port(self):
        for c in ship.SHIP['catapults']:
            run = ship.line(c)
            self.assertAlmostEqual(run(c['x']), c['z'])
            self.assertAlmostEqual(run(c['x'] + 10) - c['z'], -10 * math.tan(math.radians(c['heading'])))
        self.assertLess(ship.line({'x': 0, 'z': 0, 'heading': 5})(10), 0)   # positive heading: to port

    def test_axes_are_unit_and_square(self):
        along, starboard = ship.axes({'heading': 0})
        np.testing.assert_allclose(along, [1, 0], atol=1e-12)
        np.testing.assert_allclose(starboard, [0, 1], atol=1e-12)
        along, starboard = ship.axes({'heading': 4.03})
        self.assertAlmostEqual(float(along @ starboard), 0)
        self.assertAlmostEqual(float(np.hypot(*along)), 1)

    def test_catapults_stand_on_the_deck_and_run_off_its_edge(self):
        for c in ship.SHIP['catapults']:
            self.assertTrue(ship.inside(c['x'], c['z']))
            end = ship.end(c, c['x'])
            self.assertGreater(end, c['x'] + c['stroke'])
            self.assertFalse(ship.inside(end + 0.2, ship.line(c)(end + 0.2)))
        self.assertFalse(ship.inside(0, 60))

    def test_cabs_take_their_place_from_the_file(self):
        self.assertEqual(len(cabs.CABS), len(ship.SHIP['cabs']))
        for (f, l, m), c in zip(cabs.CABS, ship.SHIP['cabs']):
            self.assertEqual((f, l), (c['x'], c['z']))
            self.assertAlmostEqual(m, -math.tan(math.radians(c['heading'])))


if __name__ == '__main__':
    unittest.main()
