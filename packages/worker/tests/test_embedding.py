from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from embedding import EmbeddingService


class EmbeddingContracts(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.service = EmbeddingService(self.root / "missing-model", self.root)

    def tearDown(self):
        self.temp.cleanup()

    def test_unavailable_model_never_returns_fake_vector(self):
        self.assertFalse(self.service.status()["available"])
        self.assertEqual(self.service.status()["fallback"], "keyword")
        with self.assertRaisesRegex(RuntimeError, "UNAVAILABLE"):
            self.service.embed({"items": [{"text": "hello"}]})

    def test_query_document_code_prompts_are_distinct(self):
        text, opts = self.service.prepare({"text": "문서 검색"}, "query")
        self.assertEqual(opts["prompt_name"], "SearchQuery")
        _, opts = self.service.prepare({"kind": "code", "text": "class"}, "query")
        self.assertEqual(opts["prompt_name"], "CodeRetrieval")
        text, opts = self.service.prepare({"kind": "code", "text": "print(1)", "title": "main.py"}, "document")
        self.assertEqual(text, "title: main.py | text: print(1)")
        self.assertEqual(opts, {})

    def test_version_mismatch_and_pause_block_index(self):
        with self.assertRaisesRegex(ValueError, "INDEX_MISMATCH"):
            self.service.embed({"fingerprint": "old", "items": [{"text": "hello"}]})
        self.service.dispatch("embedding.pause", {})
        with self.assertRaisesRegex(RuntimeError, "INDEX_PAUSED"):
            self.service.embed({"items": [{"text": "hello"}]})
        with self.assertRaisesRegex(RuntimeError, "UNAVAILABLE"):
            self.service.embed({"purpose": "query", "items": [{"text": "hello"}]})

    def test_image_paths_remain_local(self):
        with self.assertRaises(ValueError):
            self.service.prepare({"kind": "image", "path": "https://example.com/image.png"}, "document")
        with self.assertRaises(ValueError):
            self.service.prepare({"kind": "image", "path": "../outside.png"}, "document")

    def test_revision_and_dimension_change_identity(self):
        other = EmbeddingService(self.root / "missing-model", self.root, revision="next")
        self.assertNotEqual(other.fingerprint, self.service.fingerprint)
        other = EmbeddingService(self.root / "missing-model", self.root, dimensions=512)
        self.assertNotEqual(other.fingerprint, self.service.fingerprint)


if __name__ == "__main__":
    unittest.main()
