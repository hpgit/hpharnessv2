from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hph_worker import Worker, WorkerError


class OfficeContracts(unittest.TestCase):
    def test_word_read_rejects_changed_bytes_and_always_quits(self):
        with tempfile.TemporaryDirectory() as root:
            worker = Worker(root, Path(root) / 'state')
            path = Path(root) / 'test.docx'
            path.write_bytes(b'original')
            document = Mock()
            document.Content.Text = 'original extracted text'
            app = Mock()
            def opened(*args, **kwargs):
                path.write_bytes(b'concurrent change')
                return document
            app.Documents.Open.side_effect = opened
            with patch.object(worker, 'com', return_value=SimpleNamespace(DispatchEx=lambda _: app)):
                with self.assertRaises(WorkerError) as caught:
                    worker.dispatch('office.word.read', {'path': 'test.docx'})
            self.assertEqual(caught.exception.code, 'CONFLICT')
            self.assertIs(app.DisplayAlerts, False)
            document.Close.assert_called_once_with(SaveChanges=False)
            app.Quit.assert_called_once()

    def test_word_read_quits_even_if_close_fails(self):
        with tempfile.TemporaryDirectory() as root:
            worker = Worker(root, Path(root) / 'state')
            (Path(root) / 'test.docx').write_bytes(b'document')
            document = Mock()
            document.Content.Text = 'text'
            document.Close.side_effect = RuntimeError('close failed')
            app = Mock()
            app.Documents.Open.return_value = document
            with patch.object(worker, 'com', return_value=SimpleNamespace(DispatchEx=lambda _: app)):
                with self.assertRaisesRegex(RuntimeError, 'close failed'):
                    worker.dispatch('office.word.read', {'path': 'test.docx'})
            app.Quit.assert_called_once()
