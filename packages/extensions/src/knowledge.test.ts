import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { KnowledgeStore } from "./knowledge.js";
test("archive deduplicates bytes preserves source versions and stops at physical quota", () => {
  const path = mkdtempSync(join(tmpdir(), "hph-knowledge-"));
  const store = new KnowledgeStore(path, 200000);
  try {
    const a = store.handle("knowledge.ingest", {
      source: "mail:1",
      projectId: "p",
      title: "업무",
      text: "원본",
    });
    store.handle("knowledge.ingest", {
      source: "mail:2",
      projectId: "p",
      title: "업무2",
      text: "원본",
    });
    assert.equal(store.handle("knowledge.usage", {}).blobBytes, 6);
    assert.ok(store.handle("knowledge.usage", {}).bytes > 6);
    assert.equal(
      store.handle("knowledge.search", { projectId: "p", query: "원본" })
        .length,
      2,
    );
    assert.throws(
      () =>
        store.handle("knowledge.ingest", {
          source: "file:3",
          projectId: "p",
          title: "large",
          text: "a".repeat(200000),
        }),
      /quota/,
    );
    assert.equal(
      Buffer.from(
        store.handle("knowledge.read", { id: a.id }).base64,
        "base64",
      ).toString(),
      "원본",
    );
  } finally {
    store.close();
    rmSync(path, { recursive: true, force: true });
  }
});
test("quota includes orphan blobs and text deduplication prevents repeated SQL payloads", () => {
  const path = mkdtempSync(join(tmpdir(), "hph-quota-"));
  const store = new KnowledgeStore(path, 500000);
  try {
    const text = "project source ".repeat(1000);
    for (let i = 0; i < 5; i++)
      store.handle("knowledge.ingest", {
        source: "mail:" + i,
        projectId: "p",
        title: "copy",
        text,
      });
    const db = new DatabaseSync(join(path, "sources.db"));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM texts").get()!.n, 1);
    assert.equal(
      db.prepare("SELECT SUM(length(text)) AS n FROM sources").get()!.n,
      0,
    );
    db.close();
    const before = store.handle("knowledge.usage", {}).bytes;
    writeFileSync(join(path, "blobs", "orphan"), Buffer.alloc(400000));
    assert.ok(store.handle("knowledge.usage", {}).bytes >= before + 400000);
    assert.throws(
      () =>
        store.handle("knowledge.ingest", {
          source: "next",
          projectId: "p",
          title: "new",
          text: "x",
        }),
      /quota/,
    );
    assert.equal(store.handle("knowledge.ids", { projectId: "p" }).length, 5);
    assert.equal(
      store.handle("knowledge.metadata", {
        id: store.handle("knowledge.ids", {})[0],
      }).base64,
      undefined,
    );
  } finally {
    store.close();
    rmSync(path, { recursive: true, force: true });
  }
});
test("shared asset new version does not advance another project", () => {
  const path = mkdtempSync(join(tmpdir(), "hph-assets-"));
  const store = new KnowledgeStore(path);
  try {
    const asset = store.handle("assets.create", { name: "model" });
    const v1 = store.handle("assets.version", {
      id: asset.id,
      location: "original.onnx",
      digest: "a",
    });
    store.handle("assets.link", {
      projectId: "p",
      id: asset.id,
      version: v1.id,
    });
    store.handle("assets.version", {
      id: asset.id,
      location: "new.onnx",
      digest: "b",
    });
    assert.equal(store.handle("assets.list", {})[0].projects[0].version, v1.id);
  } finally {
    store.close();
    rmSync(path, { recursive: true, force: true });
  }
});
