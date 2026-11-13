import datetime as dt
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hph_worker import Worker, WorkerError


class Items(list):
    def Sort(self, *args): pass


class OutlookContracts(unittest.TestCase):
    def test_pagination_reaches_sent_and_default_archive_is_in_state(self):
        def message(identifier):
            return SimpleNamespace(Class=43, EntryID=identifier, ConversationID='thread',
                Subject='subject', Body='body', HTMLBody='', SenderEmailAddress='sender',
                To='to', CC='', ReceivedTime=dt.datetime.now(), Attachments=SimpleNamespace(Count=0))
        folders = {6: SimpleNamespace(StoreID='store', Items=Items([message('inbox')])),
                   5: SimpleNamespace(StoreID='store', Items=Items([message('sent')]))}
        by_id = {item.EntryID: item for folder in folders.values() for item in folder.Items}
        namespace = SimpleNamespace(GetDefaultFolder=lambda key: folders[key], GetItemFromID=lambda key, store: by_id[key])
        client = SimpleNamespace(Dispatch=lambda _: SimpleNamespace(GetNamespace=lambda _: namespace))
        with tempfile.TemporaryDirectory() as root:
            (Path(root) / 'project').mkdir()
            worker = Worker(Path(root) / 'project', Path(root) / 'state')
            with patch.object(worker, 'com', return_value=client):
                first = worker.dispatch('outlook.fetch', {'limit': 1})
                folders[6].Items.insert(0, message('new arrival'))
                second = worker.dispatch('outlook.fetch', {'limit': 1, 'cursor': first['next_cursor']})
            self.assertEqual(first['messages'][0]['folder'], 'inbox')
            self.assertEqual(second['messages'][0]['folder'], 'sent')
            self.assertIsNone(second['next_cursor'])
            self.assertTrue(Path(first['messages'][0]['original']).is_relative_to(worker.state))

    def test_shared_quota_counts_existing_knowledge_and_attachment_bytes(self):
        attachment = SimpleNamespace(Size=6, SaveAsFile=lambda path: Path(path).write_bytes(b'123456'))
        item = SimpleNamespace(Attachments=SimpleNamespace(Item=lambda _: attachment))
        client = SimpleNamespace(Dispatch=lambda _: SimpleNamespace(GetNamespace=lambda _: SimpleNamespace(GetItemFromID=lambda _: item)))
        with tempfile.TemporaryDirectory() as root:
            knowledge = Path(root) / 'knowledge'
            worker = Worker(root, Path(root) / 'state', knowledge)
            (knowledge / 'existing.json').write_bytes(b'12345')
            with patch.object(worker, 'com', return_value=client):
                with self.assertRaises(WorkerError) as caught:
                    worker.dispatch('outlook.attachment', {'entry_id': 'message', 'index': 1, 'output': 'a.txt', 'quota_bytes': 10})
                self.assertEqual(caught.exception.code, 'QUOTA_EXCEEDED')
                result = worker.dispatch('outlook.attachment', {'entry_id': 'message', 'index': 1, 'output': 'a.txt', 'quota_bytes': 11})
            self.assertTrue(Path(result['path']).is_relative_to(knowledge))
            self.assertEqual(result['quota_scope'], 'shared_knowledge_root')
