import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Configuration } from "../src/config.js";

test("settings ignore presentation metadata and detect external edits", () => {
  const root = mkdtempSync(join(tmpdir(), "hph-config-"));
  try {
    const path = join(root, "settings.yaml");
    const config = new Configuration(path);
    assert.equal(config.validate({ provider: { protocol: "openai-compatible" } }).provider.protocol, "openai-compatible");
    config.update({ configPath: "ignored", configError: "ignored", maxAgents: 2,
      projectOverrides: { project: { maxAgents: 3, configPath: "ignored", configError: "ignored" } },
      sessionOverrides: { session: { maxModelRequests: 4, configPath: "ignored", configError: "ignored" } },
    } as any);
    assert.doesNotMatch(readFileSync(path, "utf8"), /configPath|configError/);
    assert.equal(config.effective("project").value.maxAgents, 3);
    assert.equal(config.effective(undefined, "session").value.maxModelRequests, 4);
    assert.deepEqual(config.value.projectOverrides?.project, { maxAgents: 3 });
    assert.deepEqual(config.value.sessionOverrides?.session, { maxModelRequests: 4 });
    writeFileSync(path, "maxAgents: 4\nprovider:\n  timeoutMs: 500\n");
    assert.equal(config.effective().value.maxAgents, 4);
    config.update({ maxModelRequests: 5 });
    assert.equal(config.value.maxAgents, 4);
    writeFileSync(path, "provider:\n  timeoutMs: -1\n");
    assert.equal(config.effective().value.maxAgents, 4);
    assert.match(config.error!, /timeoutMs/);
    assert.throws(() => config.update({ provider: { protocol: "unsupported" } } as any), /protocol/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
