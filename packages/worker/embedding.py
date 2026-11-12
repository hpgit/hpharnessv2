"""Optional offline EmbeddingGemma 2 service; absence is an error, never a fake vector.

Model API: https://developers.googleblog.com/embeddinggemma-2-the-developer-guide/
Model card: https://huggingface.co/google/embeddinggemma-2
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import queue
import sys
import threading


class EmbeddingService:
    def __init__(self, model_dir, root, revision="local", device="auto", dimensions=768):
        if dimensions not in (128, 256, 512, 768):
            raise ValueError("Supported dimensions: 128, 256, 512, 768")
        self.directory = Path(model_dir).expanduser().resolve()
        self.root = Path(root).expanduser().resolve()
        self.revision = revision
        self.device = device
        self.dimensions = dimensions
        self.model = None
        self.paused = False
        metadata = []
        if self.directory.is_dir():
            for path in sorted(self.directory.iterdir()):
                if path.is_file():
                    entry = {"file": path.name, "size": path.stat().st_size, "mtime": path.stat().st_mtime_ns}
                    if path.suffix == ".json":
                        entry["sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
                    metadata.append(entry)
        self.identity = {"model": "google/embeddinggemma-2", "revision": revision, "dimensions": dimensions, "normalize": True, "preprocessing": "embeddinggemma2-search-document-code-v1", "modalities": ["text", "code", "image"], "files": metadata}
        self.fingerprint = hashlib.sha256(json.dumps(self.identity, sort_keys=True).encode()).hexdigest()

    def status(self):
        available = self.directory.is_dir() and (self.directory / "config.json").is_file() and importlib.util.find_spec("sentence_transformers") is not None
        return {"ready": self.model is not None, "available": available, "model_dir": str(self.directory), "dimensions": self.dimensions, "fingerprint": self.fingerprint, "paused": self.paused, "fallback": "keyword", "reason": None if available else "Configure a local model directory and install worker[embedding]"}

    def load(self):
        if self.model is not None:
            return
        if not self.directory.is_dir() or not (self.directory / "config.json").is_file():
            raise RuntimeError("EMBEDDING_UNAVAILABLE: configured local model directory is missing")
        try:
            import torch
            from sentence_transformers import SentenceTransformer
        except ImportError as exc:
            raise RuntimeError("EMBEDDING_UNAVAILABLE: install worker[embedding] using uv") from exc
        device = ("cuda" if torch.cuda.is_available() else "cpu") if self.device == "auto" else self.device
        # No implicit downloads or remote model code. Audio is excluded from this release.
        self.model = SentenceTransformer(str(self.directory), device=device, local_files_only=True, trust_remote_code=False, config_kwargs={"audio_config": None}, model_kwargs={"torch_dtype": torch.float32})

    def prepare(self, item, purpose):
        kind = item.get("kind", "text")
        if kind == "image":
            path = Path(item["path"])
            path = (path if path.is_absolute() else self.root / path).resolve()
            if not path.is_relative_to(self.root) or not path.is_file():
                raise ValueError("Image path is missing or outside the workspace")
            return {"image": str(path)}, {}
        if kind not in ("text", "code") or not isinstance(item.get("text"), str):
            raise ValueError("Embedding item must be text, code, or a workspace image")
        if purpose == "query":
            return item["text"], {"prompt_name": "CodeRetrieval" if kind == "code" else "SearchQuery"}
        title = item.get("title") or "none"
        return f"title: {title} | text: {item['text']}", {}

    def embed(self, params):
        purpose = params.get("purpose", "document")
        if purpose not in ("query", "document"):
            raise ValueError("purpose must be query or document")
        if self.paused and purpose != "query":
            raise RuntimeError("INDEX_PAUSED")
        if params.get("fingerprint") not in (None, self.fingerprint):
            raise ValueError("INDEX_MISMATCH: model or index configuration changed")
        items = params.get("items", [])
        if not isinstance(items, list) or not 1 <= len(items) <= 8:
            raise ValueError("Supply 1 to 8 items per batch; small batches allow query priority")
        prepared = [self.prepare(item, purpose) for item in items]
        self.load()
        vectors = []
        for value, kwargs in prepared:
            vector = self.model.encode(value, normalize_embeddings=True, truncate_dim=self.dimensions, show_progress_bar=False, **kwargs).tolist()
            if len(vector) != self.dimensions or any(not math.isfinite(float(v)) for v in vector):
                raise RuntimeError("Embedding model returned an invalid vector")
            vectors.append(vector)
        return {"vectors": vectors, "dimensions": self.dimensions, "fingerprint": self.fingerprint, "identity": self.identity, "purpose": purpose}

    def dispatch(self, method, params):
        if method == "embedding.status":
            return self.status()
        if method == "embedding.pause":
            self.paused = True
            return self.status()
        if method == "embedding.resume":
            self.paused = False
            return self.status()
        if method == "embedding.embed":
            return self.embed(params)
        raise ValueError("Unknown embedding method")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--root", required=True)
    parser.add_argument("--revision", default="local")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--dimensions", type=int, default=768)
    args = parser.parse_args()
    service = EmbeddingService(args.model_dir, args.root, args.revision, args.device, args.dimensions)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stdin.reconfigure(encoding="utf-8")
    requests = queue.PriorityQueue()
    def read_requests():
        sequence = 0
        for line in sys.stdin:
            sequence += 1
            try:
                request = json.loads(line)
                params = request.get("params", {})
                priority = 0 if request.get("method") != "embedding.embed" or params.get("purpose") == "query" else 10
                requests.put((priority, sequence, request))
            except Exception as exc:
                requests.put((0, sequence, {"id": None, "error": str(exc)}))
        requests.put((100, sequence + 1, None))
    threading.Thread(target=read_requests, daemon=True).start()
    while True:
        _, _, request = requests.get()
        if request is None:
            break
        try:
            if "error" in request:
                raise ValueError(request["error"])
            result = service.dispatch(request.get("method"), request.get("params", {}))
            response = {"id": request.get("id"), "result": result}
        except Exception as exc:
            response = {"id": request.get("id"), "error": {"code": "EMBEDDING_ERROR", "message": str(exc), "fallback": "keyword"}}
        print(json.dumps(response, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
