import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Harness } from "../src/harness.js";
import { ModelInvoke } from "../src/types.js";

async function fixture(invoke: ModelInvoke = async () => ({ text: "done" })) {
  const root = await fs.mkdtemp(join(tmpdir(), "hph-test-"));
  const h = await new Harness(join(root, "state"), () => {}, invoke).start();
  const project = await h.rpc("projects.create", { name: "test", root });
  const session = await h.rpc("sessions.create", { projectId: project.id });
  return {
    h,
    root,
    project,
    session,
    async close() {
      await h.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
async function until(check: () => unknown) {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition timed out");
}
test("durable history, memory Korean search, and isolated session branches", async () => {
  const f = await fixture();
  try {
    await f.h.rpc("memory.upsert", {
      projectId: f.project.id,
      content: "원본 ONNX 기준 비교",
      kind: "decision",
    });
    assert.equal(
      (
        await f.h.rpc("memory.search", {
          projectId: f.project.id,
          query: "원본",
        })
      ).length,
      1,
    );
    await f.h.rpc("runs.start", { sessionId: f.session.id, input: "hello" });
    await f.h.waitForIdle();
    const messages = await f.h.rpc("messages.list", {
      sessionId: f.session.id,
    });
    assert.equal(messages.length, 2);
    const branch = await f.h.rpc("sessions.fork", {
      sessionId: f.session.id,
      messageId: messages[0].id,
    });
    assert.equal(
      (await f.h.rpc("messages.list", { sessionId: branch.id })).length,
      1,
    );
    await f.h.close();
    const reopened = await new Harness(join(f.root, "state")).start();
    assert.equal(
      (await reopened.rpc("messages.list", { sessionId: f.session.id })).length,
      2,
    );
    await reopened.close();
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});
test("file edits reject stale versions, traversal and concurrent conflicting writes", async () => {
  const f = await fixture();
  try {
    const params = { sessionId: f.session.id, path: "test.txt" };
    const created = await f.h.rpc("files.write", {
      ...params,
      content: "a",
      baseVersion: null,
    });
    const writes = await Promise.allSettled([
      f.h.rpc("files.write", {
        ...params,
        content: "b",
        baseVersion: created.version,
      }),
      f.h.rpc("files.write", {
        ...params,
        content: "c",
        baseVersion: created.version,
      }),
    ]);
    assert.equal(writes.filter((x) => x.status === "fulfilled").length, 1);
    await assert.rejects(
      f.h.rpc("files.read", { sessionId: f.session.id, path: "../secret" }),
      /outside/i,
    );
    await assert.rejects(
      f.h.rpc("files.write", {
        ...params,
        content: "d",
        baseVersion: created.version,
      }),
      /changed/,
    );
  } finally {
    await f.close();
  }
});
test("tool mutations wait for exact approval and model receives denied result", async () => {
  let steps = 0;
  const f = await fixture(async () =>
    ++steps === 1
      ? {
          text: "",
          toolCalls: [
            {
              id: "write-1",
              name: "files_write",
              arguments: {
                path: "approved.txt",
                content: "yes",
                baseVersion: null,
              },
            },
          ],
        }
      : { text: "done" },
  );
  try {
    const run = await f.h.rpc("runs.start", {
      sessionId: f.session.id,
      input: "write",
    });
    await until(() =>
      f.h.store.list<any>("approval").some((a) => a.status === "pending"),
    );
    await assert.rejects(fs.stat(join(f.root, "approved.txt")));
    const approval = (await f.h.rpc("approvals.list"))[0];
    assert.equal(approval.runId, run.id);
    await f.h.rpc("approvals.resolve", { id: approval.id, approved: true });
    await f.h.waitForIdle();
    assert.equal(
      await fs.readFile(join(f.root, "approved.txt"), "utf8"),
      "yes",
    );
    await assert.rejects(
      f.h.rpc("approvals.resolve", { id: approval.id, approved: true }),
      /longer active/,
    );
  } finally {
    await f.close();
  }
});
test("core replacement pins active run then migrates only after tool checkpoint", async () => {
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  let step = 0;
  const prompts: string[] = [];
  const f = await fixture(async (_config, messages) => {
    prompts.push(messages[0].content);
    step++;
    if (step === 1) {
      await hold;
      return {
        text: "",
        toolCalls: [{ id: "read", name: "files_list", arguments: {} }],
      };
    }
    return { text: "finished" };
  });
  try {
    const run = await f.h.rpc("runs.start", {
      sessionId: f.session.id,
      input: "inspect",
    });
    await until(() => step === 1);
    const plugin = join(f.root, "core.mjs");
    await fs.writeFile(
      plugin,
      "export function apply(ctx){ctx.set('agentCore',{version:'new-core',stateVersion:1,systemPrompt:'NEW CORE',nextStep:api=>api.complete()});}",
    );
    const changed = await f.h.rpc("core.reload", {
      filePath: plugin,
      migrateActive: true,
    });
    assert.equal(changed.generations.length, 2);
    assert.equal(
      (await f.h.rpc("runs.status", { runId: run.id })).generation,
      run.generation,
    );
    release();
    await f.h.waitForIdle();
    assert.match(prompts[1], /^NEW CORE/);
    assert.equal(f.h.core.status().generations.length, 1);
    assert(f.h.store.events().some((e) => e.type === "run.migrated"));
  } finally {
    release();
    await f.close();
  }
});
test("candidate failure keeps current core and timeout defers active migration", async () => {
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  let step = 0;
  const prompts: string[] = [];
  const f = await fixture(async (_c, m) => {
    prompts.push(m[0].content);
    if (++step === 1) {
      await hold;
      return {
        text: "",
        toolCalls: [{ id: "list", name: "files_list", arguments: {} }],
      };
    }
    return { text: "ok" };
  });
  try {
    const before = f.h.core.current.id;
    const bad = join(f.root, "bad.mjs");
    await fs.writeFile(
      bad,
      "export function apply(ctx){ctx.set('agentCore',{version:'bad',stateVersion:2,systemPrompt:'bad'})}",
    );
    await assert.rejects(
      f.h.rpc("core.reload", { filePath: bad }),
      /stateVersion/,
    );
    assert.equal(f.h.core.current.id, before);
    await f.h.rpc("runs.start", { sessionId: f.session.id, input: "wait" });
    await until(() => step === 1);
    await f.h.rpc("core.reload", { migrateActive: true, timeoutMs: 0 });
    await new Promise((r) => setTimeout(r, 5));
    release();
    await f.h.waitForIdle();
    assert.equal(prompts[0], prompts[1]);
    assert(f.h.store.events().some((e) => e.type === "run.migrationDeferred"));
  } finally {
    release();
    await f.close();
  }
});
test("settings validation preserves last known good YAML and config paths", async () => {
  const f = await fixture();
  try {
    await f.h.rpc("settings.update", { maxAgents: 5 });
    await assert.rejects(f.h.rpc("settings.update", { maxAgents: 0 }), /1..10/);
    await fs.writeFile(f.h.config.path, "broken: [");
    await f.h.rpc("settings.reload");
    assert.equal(f.h.config.value.maxAgents, 5);
    assert(f.h.config.error);
  } finally {
    await f.close();
  }
});
test("approved improvement replaces actual step algorithm, keeps evaluation unknown and rolls back", async () => {
  let modelCalls = 0;
  const f = await fixture(async () => {
    modelCalls++;
    return { text: "model response" };
  });
  try {
    const plugin = join(f.root, "decision.mjs");
    await fs.writeFile(
      plugin,
      "export function apply(ctx){ctx.set('agentCore',{version:'deterministic',stateVersion:1,systemPrompt:'',async nextStep(api){return api.run.step===0?{text:'Inspect first',toolCalls:[{id:'inspect',name:'files_list',arguments:{}}],continue:true}:{text:'Custom decision complete',continue:false};}})}",
    );
    const proposal = await f.h.rpc("improvements.propose", {
      title: "Two-step decision",
      scope: "Replace nextStep algorithm for new runs",
      validation: "Read-only file list then complete",
      rollback: "Restore previous core",
      filePath: plugin,
    });
    await assert.rejects(
      f.h.rpc("improvements.apply", { id: proposal.id }),
      /Approve/,
    );
    await f.h.rpc("improvements.approve", { id: proposal.id, approved: true });
    await f.h.rpc("improvements.validate", {
      id: proposal.id,
      evidence: "Fixture exercises deterministic two-step algorithm",
    });
    const applied = await f.h.rpc("improvements.apply", { id: proposal.id });
    assert.equal(applied.evaluation, "unknown");
    await f.h.rpc("runs.start", { sessionId: f.session.id, input: "go" });
    await f.h.waitForIdle();
    assert.equal(modelCalls, 0);
    assert.equal(
      (await f.h.rpc("messages.list", { sessionId: f.session.id })).at(-1)
        .content,
      "Custom decision complete",
    );
    await f.h.rpc("improvements.evaluate", {
      id: proposal.id,
      evaluation: "better",
      feedback: "Clearer control",
    });
    await f.h.rpc("improvements.rollback", { id: proposal.id });
    await f.h.rpc("runs.start", { sessionId: f.session.id, input: "again" });
    await f.h.waitForIdle();
    assert.equal(modelCalls, 1);
  } finally {
    await f.close();
  }
});
test("cancelled queued requests release generation ownership and never invoke the model", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let calls = 0;
  const f = await fixture(async () => {
    calls++;
    await gate;
    return { text: "done" };
  });
  try {
    await f.h.rpc("runs.start", { sessionId: f.session.id, input: "first" });
    await until(() => calls === 1);
    const queued = await f.h.rpc("runs.start", {
      sessionId: f.session.id,
      input: "second",
    });
    await f.h.rpc("runs.cancel", { runId: queued.id });
    release();
    await f.h.waitForIdle();
    assert.equal(calls, 1);
    assert.equal(
      (await f.h.rpc("runs.status", { runId: queued.id })).status,
      "cancelled",
    );
    assert.equal(f.h.core.current.references, 0);
  } finally {
    release();
    await f.close();
  }
});
test("child delegation releases the sole agent slot and preserves child provenance", async () => {
  const seen = new Map<string, number>();
  const f = await fixture(async (_c, m) => {
    const sid = m[0].sessionId;
    const step = (seen.get(sid) ?? 0) + 1;
    seen.set(sid, step);
    if (
      m.some((x) => x.role === "user" && x.content === "parent") &&
      step === 1
    )
      return {
        text: "",
        toolCalls: [
          {
            id: "delegate",
            name: "agents_delegate",
            arguments: { input: "child", title: "Inspect" },
          },
        ],
      };
    return {
      text: m.some((x) => x.content === "child")
        ? "child result"
        : "parent result",
    };
  });
  try {
    await f.h.rpc("settings.update", { maxAgents: 1 });
    await f.h.rpc("runs.start", { sessionId: f.session.id, input: "parent" });
    await f.h.waitForIdle();
    const runs = await f.h.rpc("runs.status");
    assert.equal(runs.length, 2);
    assert(runs.every((r: any) => r.status === "completed"));
    const child = (await f.h.rpc("sessions.list")).find(
      (s: any) => s.parentId === f.session.id,
    );
    assert(child);
    assert(
      (await f.h.rpc("messages.list", { sessionId: f.session.id })).some(
        (m: any) => m.role === "tool" && m.content.includes("child result"),
      ),
    );
  } finally {
    await f.close();
  }
});
test("project/session overlays apply without widening unrelated projects and token budget halts new effects", async () => {
  const f = await fixture(async () => ({
    text: "",
    usage: { inputTokens: 6, outputTokens: 4 },
    toolCalls: [
      {
        id: "write",
        name: "files_write",
        arguments: { path: "never.txt", content: "bad", baseVersion: null },
      },
    ],
  }));
  try {
    await f.h.rpc("settings.update", {
      projectId: f.project.id,
      settings: { maxTokens: 10, permissions: { write: "allow" } },
    });
    const effective = await f.h.rpc("settings.effective", {
      sessionId: f.session.id,
    });
    assert.equal(effective.value.maxTokens, 10);
    assert.equal(effective.origins.maxTokens, "project");
    assert.equal((await f.h.rpc("settings.get")).permissions.write, "ask");
    const run = await f.h.rpc("runs.start", {
      sessionId: f.session.id,
      input: "budget",
    });
    await f.h.waitForIdle();
    const status = await f.h.rpc("runs.status", { runId: run.id });
    assert.equal(status.status, "failed");
    assert.equal(status.usage.inputTokens, 6);
    assert.match(status.error, /token limit/);
    await assert.rejects(fs.stat(join(f.root, "never.txt")));
    await f.h.rpc("settings.update", {
      sessionId: f.session.id,
      settings: { maxTokens: 20 },
    });
    assert.equal(
      (await f.h.rpc("settings.effective", { sessionId: f.session.id })).value
        .maxTokens,
      20,
    );
  } finally {
    await f.close();
  }
});
test("duration expiry cancels pending approvals without executing or leaving stale queue", async () => {
  const f = await fixture(async () => ({
    text: "",
    toolCalls: [
      {
        id: "wait",
        name: "files_write",
        arguments: { path: "never.txt", content: "bad", baseVersion: null },
      },
    ],
  }));
  try {
    await f.h.rpc("settings.update", { maxDurationMs: 100 });
    const run = await f.h.rpc("runs.start", {
      sessionId: f.session.id,
      input: "wait",
    });
    await f.h.waitForIdle();
    assert.equal(
      (await f.h.rpc("runs.status", { runId: run.id })).status,
      "cancelled",
    );
    assert.equal((await f.h.rpc("approvals.list")).length, 0);
    await assert.rejects(fs.stat(join(f.root, "never.txt")));
  } finally {
    await f.close();
  }
});
test("model extension writes require approval and process configuration is not model-callable", async () => {
  let step = 0;
  const f = await fixture(async () => {
    step++;
    return step === 1
      ? {
          text: "",
          toolCalls: [
            {
              id: "forbidden",
              name: "extension_call",
              arguments: {
                method: "mcp.connect",
                params: { id: "bad", command: "node" },
              },
            },
            {
              id: "asset",
              name: "extension_call",
              arguments: {
                method: "assets.create",
                params: { name: "unapproved" },
              },
            },
          ],
        }
      : { text: "done" };
  });
  try {
    await f.h.rpc("runs.start", {
      sessionId: f.session.id,
      input: "extensions",
    });
    await until(() =>
      f.h.store.list<any>("approval").some((a) => a.status === "pending"),
    );
    const approval = (await f.h.rpc("approvals.list"))[0];
    assert.equal(approval.arguments.method, "assets.create");
    await f.h.rpc("approvals.resolve", { id: approval.id, approved: false });
    await f.h.waitForIdle();
    assert.equal((await f.h.rpc("assets.list")).length, 0);
    const messages = await f.h.rpc("messages.list", {
      sessionId: f.session.id,
    });
    assert(
      messages.some(
        (m: any) => m.role === "tool" && m.content.includes("not exposed"),
      ),
    );
  } finally {
    await f.close();
  }
});
test("candidate changed after validation cannot activate", async () => {
  const f = await fixture();
  try {
    const plugin = join(f.root, "snapshot.mjs");
    await fs.writeFile(
      plugin,
      "export function apply(ctx){ctx.set('agentCore',{version:'snapshot',stateVersion:1,systemPrompt:'',nextStep:async()=>({text:'ok'})})}",
    );
    const p = await f.h.rpc("improvements.propose", {
      title: "Snapshot",
      scope: "core only",
      validation: "contract check",
      rollback: "previous",
      filePath: plugin,
    });
    await f.h.rpc("improvements.approve", { id: p.id, approved: true });
    await f.h.rpc("improvements.validate", {
      id: p.id,
      evidence: "contract fixture",
    });
    await fs.appendFile(plugin, "\n// modified");
    await assert.rejects(
      f.h.rpc("improvements.apply", { id: p.id }),
      /changed after validation/,
    );
    assert.equal(f.h.core.current.core.version, "builtin-1");
  } finally {
    await f.close();
  }
});
test("image preview returns verified binary MIME and refuses active formats", async () => {
  const f = await fixture();
  try {
    await fs.writeFile(
      join(f.root, "pixel.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const result = await f.h.rpc("files.preview", {
      sessionId: f.session.id,
      path: "pixel.png",
    });
    assert.equal(result.mime, "image/png");
    assert(result.base64);
    await fs.writeFile(
      join(f.root, "fake.png"),
      '<svg onload="alert(1)"></svg>',
    );
    await assert.rejects(
      f.h.rpc("files.preview", { sessionId: f.session.id, path: "fake.png" }),
      /Only PNG/,
    );
  } finally {
    await f.close();
  }
});
test("instruction discovery returns root and nested instructions plus available skill paths", async () => {
  let step = 0;
  const f = await fixture(async () =>
    ++step === 1
      ? {
          text: "",
          toolCalls: [
            {
              id: "instructions",
              name: "instructions_list",
              arguments: { path: "src" },
            },
          ],
        }
      : { text: "done" },
  );
  try {
    await fs.mkdir(join(f.root, "src"));
    await fs.mkdir(join(f.root, ".agents/skills/build"), { recursive: true });
    await fs.writeFile(join(f.root, "AGENTS.md"), "Use uv.");
    await fs.writeFile(join(f.root, "src/AGENTS.md"), "Run tests.");
    await fs.writeFile(
      join(f.root, ".agents/skills/build/SKILL.md"),
      "Build skill.",
    );
    await f.h.rpc("runs.start", { sessionId: f.session.id, input: "discover" });
    await f.h.waitForIdle();
    const output = JSON.parse(
      (await f.h.rpc("messages.list", { sessionId: f.session.id })).find(
        (m: any) => m.role === "tool",
      ).content,
    );
    assert.equal(output.instructions.length, 2);
    assert.equal(output.skills[0].path, ".agents/skills/build/SKILL.md");
  } finally {
    await f.close();
  }
});
test("ten agent slots and three model slots remain bounded across many sessions", async () => {
  let active = 0,
    max = 0;
  const f = await fixture(async () => {
    active++;
    max = Math.max(max, active);
    await new Promise((r) => setTimeout(r, 30));
    active--;
    return { text: "done" };
  });
  try {
    for (let i = 0; i < 15; i++) {
      const session = await f.h.rpc("sessions.create", {
        projectId: f.project.id,
      });
      await f.h.rpc("runs.start", { sessionId: session.id, input: "work" });
    }
    await f.h.waitForIdle();
    assert(max <= 3);
    assert(max > 1);
    assert(
      (await f.h.rpc("runs.status")).every(
        (r: any) => r.status === "completed",
      ),
    );
  } finally {
    await f.close();
  }
});
