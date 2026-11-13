import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorIndex } from "./vectors.js";
test("vector retrieval isolates project sources and model identity", () => {
  const root = mkdtempSync(join(tmpdir(), "hph-vectors-"));
  const index = new VectorIndex(join(root, "vectors.db"));
  try {
    const a = Array(768).fill(0),
      b = Array(768).fill(0);
    a[0] = 1;
    b[1] = 1;
    index.put("a", "model1", a);
    index.put("b", "model1", b);
    index.put("c", "model2", a);
    assert.equal(
      index.search("model1", a, new Set(["a", "b", "c"]))[0].id,
      "a",
    );
    assert.equal(index.search("model1", a, new Set(["b"]))[0].id, "b");
    assert.equal(index.search("unknown", a, new Set(["a"])).length, 0);
    assert.throws(() => index.put("z", "model1", [1]), /768/);
  } finally {
    index.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("source modalities and chunks coexist and retrieval aggregates the best chunk", () => {
  const root = mkdtempSync(join(tmpdir(), "hph-vector-chunks-"));
  const index = new VectorIndex(join(root, "vectors.db"));
  const a = Array(768).fill(0), b = Array(768).fill(0);
  a[0] = 1; b[1] = 1;
  try {
    index.replace("source", "model", "text", [a, b]);
    index.replace("source", "model", "image", [b]);
    assert.deepEqual(index.search("model", a, new Set(["source"])), [{ id: "source", score: 1 }]);
    index.replace("source", "model", "text", [b]);
    assert.equal(index.search("model", a, new Set(["source"]))[0].score, 0);
    assert.throws(() => index.replace("source", "model", "image", [[1]]));
    assert.equal(index.search("model", b, new Set(["source"]))[0].score, 1);
  } finally { index.close(); rmSync(root, { recursive: true, force: true }); }
});
