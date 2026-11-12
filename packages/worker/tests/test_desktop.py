from pathlib import Path
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hph_worker import Worker, WorkerError


class Element:
    handle = 123
    def __init__(self, name="Fixture", children=None):
        self.element_info = SimpleNamespace(automation_id=name, control_type="Button", name=name)
        self.items = children or []
        self.invoked = False
    def window_text(self): return self.element_info.name
    def process_id(self): return 4321
    def wrapper_object(self): return self
    def children(self): return self.items
    def is_enabled(self): return True
    def is_visible(self): return True
    def invoke(self): self.invoked = True


class DesktopContracts(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.worker = Worker(self.temp.name, Path(self.temp.name) / "state")
        self.child = Element("Read")
        self.window = Element(children=[self.child])
        self.worker.desktop = lambda: SimpleNamespace(window=lambda **kw: self.window)
        self.tick = 100
        self.worker.input_tick = lambda: self.tick
        self.stamp = patch("hph_worker.process_stamp", return_value="same-process")
        self.stamp.start()
    def tearDown(self):
        self.stamp.stop()
        self.temp.cleanup()
    def lease(self):
        return self.worker.dispatch("desktop.lease", {"approved": True, "handle": 123})
    def test_handoff_required(self):
        with self.assertRaises(WorkerError) as exc:
            self.worker.dispatch("desktop.lease", {"handle": 123})
        self.assertEqual(exc.exception.code, "APPROVAL_REQUIRED")
    def test_snapshot_bound_action(self):
        lease = self.lease()
        snapshot = self.worker.dispatch("desktop.read", lease)
        self.worker.dispatch("desktop.action", dict(lease, expected_snapshot=snapshot["snapshot"], path=[0], action="invoke"))
        self.assertTrue(self.child.invoked)
        self.child.element_info.name = "Changed"
        with self.assertRaises(WorkerError) as exc:
            self.worker.dispatch("desktop.action", dict(lease, expected_snapshot=snapshot["snapshot"], path=[0], action="invoke"))
        self.assertEqual(exc.exception.code, "STALE_SNAPSHOT")
    def test_user_input_reclaims_control(self):
        lease = self.lease()
        self.tick += 1
        with self.assertRaises(WorkerError) as exc:
            self.worker.dispatch("desktop.read", lease)
        self.assertEqual(exc.exception.code, "USER_RECLAIMED")
        self.tick -= 1
        with self.assertRaises(WorkerError) as exc:
            self.worker.dispatch("desktop.read", lease)
        self.assertEqual(exc.exception.code, "HANDOFF_EXPIRED")
    def test_expired_handoff(self):
        lease = self.worker.dispatch("desktop.lease", {"approved": True, "handle": 123, "seconds": .01})
        time.sleep(.02)
        with self.assertRaises(WorkerError) as exc:
            self.worker.dispatch("desktop.read", lease)
        self.assertEqual(exc.exception.code, "HANDOFF_EXPIRED")


if __name__ == "__main__":
    unittest.main()
