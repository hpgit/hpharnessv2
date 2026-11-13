import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Harness } from "../src/harness.js";
import { ModelInvoke } from "../src/types.js";

async function fixture(invoke: ModelInvoke = async () => ({ text: "done" })) {
  const root = await fs.mkdtemp(join(tmpdir(), "hph-review-"));
  let h = await new Harness(join(root, "state"), () => {}, invoke).start();
  const project = await h.rpc("projects.create", { name: "review", root });
  const session = await h.rpc("sessions.create", { projectId: project.id });
  return { root, project, session, get h() { return h; },
    async reopen() { await h.close(); h = await new Harness(join(root, "state"), () => {}, invoke).start(); },
    async close() { await h.close(); await fs.rm(root, { recursive: true, force: true }); },
  };
}
// Keep polling on real time when a test controls the harness's duration timer.
const pollTimeout = globalThis.setTimeout;
async function until(check: () => boolean) {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await new Promise((r) => pollTimeout(r, 10));
  }
  throw new Error("condition timed out");
}
const writes = () => ["one", "two"].map((id) => ({ id, name: "files_write", arguments: { path: id + ".txt", content: id, baseVersion: null } }));

for (const duration of [false, true]) test(`review: ${duration ? "duration" : "explicit"} cancellation drains approvals and queued run`, async (t) => {
  let steps = 0;
  const f = await fixture(async () => {
    if (++steps === 1) return { text: "", toolCalls: writes() };
    // Exercise a successor slower than the old 100 ms wall-clock assumption.
    if (duration) await new Promise((r) => pollTimeout(r, 150));
    return { text: "next completed" };
  });
  try {
    await f.h.rpc("settings.update", { maxAgents: 1, ...(duration ? { maxDurationMs: 100 } : {}) });
    if (duration) t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
    const first = await f.h.rpc("runs.start", { sessionId: f.session.id, input: "first" });
    const second = await f.h.rpc("runs.start", { sessionId: f.session.id, input: "second" });
    await until(() => f.h.store.list<any>("approval").some((a) => a.status === "pending"));
    assert.equal((await f.h.rpc("runs.status", { runId: second.id })).status, "queued");
    // Expire only the first run, after it actually reaches approval. Leave the
    // second run's clock still so slow CI disk I/O cannot cancel it as well.
    if (duration) t.mock.timers.tick(100);
    else await f.h.rpc("runs.cancel", { runId: first.id });
    await until(() => [first.id, second.id].every((id) =>
      ["completed", "cancelled", "failed"].includes(f.h.store.get<any>("run", id)!.status)));
    assert.equal((await f.h.rpc("runs.status", { runId: first.id })).status, "cancelled");
    const cancelled = await f.h.rpc("runs.status", { runId: first.id });
    if (duration) assert.equal(cancelled.error, "Configured duration limit reached");
    assert.deepEqual(await f.h.rpc("runs.cancel", { runId: first.id }), cancelled);
    assert.equal((await f.h.rpc("runs.status", { runId: second.id })).status, "completed");
    assert.equal(f.h.store.list<any>("approval").filter((a) => a.status === "pending").length, 0);
    for (const path of ["one.txt", "two.txt"]) await assert.rejects(fs.stat(join(f.root, path)));
    const completed = await f.h.rpc("runs.cancel", { runId: second.id });
    assert.equal(completed.status, "completed");
    assert.deepEqual(await f.h.rpc("runs.cancel", { runId: second.id }), completed);
  } finally { t.mock.timers.reset(); await f.close(); }
});

test("review: cancelling a failed run preserves its terminal error", async () => {
  const f = await fixture(async () => { throw new Error("permanent model failure"); });
  try {
    const run = await f.h.rpc("runs.start", { sessionId: f.session.id, input: "fail" });
    await f.h.waitForIdle();
    const failed = await f.h.rpc("runs.status", { runId: run.id });
    assert.equal(failed.status, "failed");
    assert.match(failed.error, /permanent model failure/);
    assert.deepEqual(await f.h.rpc("runs.cancel", { runId: run.id }), failed);
  } finally { await f.close(); }
});

test("review: model memories require confirmation before project injection", async () => {
  const contexts: string[] = [];
  let step = 0;
  const secret = "CANDIDATE_UNCONFIRMED_42";
  const f = await fixture(async (_config, messages) => {
    contexts.push(messages.filter((m) => m.role === "system").map((m) => m.content).join("\n"));
    return ++step === 1 ? { text: "", toolCalls: [{ id: "remember", name: "memory_remember", arguments: { content: secret, kind: "fact" } }] } : { text: "done" };
  });
  try {
    await f.h.rpc("runs.start", { sessionId: f.session.id, input: "propose memory" });
    await f.h.waitForIdle();
    const [memory] = await f.h.rpc("memory.list", { projectId: f.project.id });
    assert.equal(Number(memory.confirmed), 0);
    assert(contexts.every((context) => !context.includes(secret)));
    await f.h.rpc("memory.confirm", { id: memory.id });
    await f.h.rpc("runs.start", { sessionId: f.session.id, input: "confirmed" });
    await f.h.waitForIdle();
    assert(contexts.at(-1)!.includes(secret));
    await f.h.rpc("memory.delete", { id: memory.id });
    assert.equal((await f.h.rpc("memory.list", { projectId: f.project.id })).length, 0);
    await f.h.rpc("runs.start", { sessionId: f.session.id, input: "deleted" });
    await f.h.waitForIdle();
    assert(!contexts.at(-1)!.includes(secret));
  } finally { await f.close(); }
});

test("review: large file tool results stay bounded and originals remain pageable", async () => {
  let step = 0;
  const contexts: any[][] = [];
  const f = await fixture(async (_config, messages) => {
    contexts.push(messages);
    return ++step === 1 ? { text: "", toolCalls: [{ id: "read", name: "files_read", arguments: { path: "large.txt" } }] } : { text: "done" };
  });
  try {
    const content = "original-".repeat(15000);
    await fs.writeFile(join(f.root, "large.txt"), content);
    await f.h.rpc("settings.update", { contextMaxChars: 4000 });
    await f.h.rpc("runs.start", { sessionId: f.session.id, input: "read file" });
    await f.h.waitForIdle();
    assert.equal(contexts.length, 2);
    assert(contexts.every((messages) => JSON.stringify(messages).length <= 4000));
    const messages = await f.h.rpc("messages.list", { sessionId: f.session.id });
    const result = JSON.parse(messages.find((m: any) => m.role === "tool").content);
    assert.equal(result.truncated, true);
    let original = "", offset: number | null = 0;
    while (offset !== null) {
      const page = await f.h.rpc("artifacts.read", { id: result.artifactId, offset, limit: 16000 });
      original += page.content; offset = page.nextOffset;
    }
    assert.equal(JSON.parse(original).content, content);
    await assert.rejects(f.h.rpc("artifacts.read", { id: result.artifactId, limit: 16001 }));
  } finally { await f.close(); }
});

test("review: fork and restart repair incomplete tool turns without replay", async () => {
  const contexts: any[][] = [];
  const f = await fixture(async (_config, messages) => { contexts.push(messages); return { text: "recovered" }; });
  try {
    const owner = { id: "incomplete", sessionId: f.session.id, role: "assistant", content: "", createdAt: new Date().toISOString(), toolCalls: writes() };
    f.h.store.put("message", owner);
    const branch = await f.h.rpc("sessions.fork", { sessionId: f.session.id, messageId: owner.id });
    const history = await f.h.rpc("messages.list", { sessionId: branch.id });
    assert.equal(history.filter((m: any) => m.role === "tool").length, 2);
    assert(history.filter((m: any) => m.role === "tool").every((m: any) => /may have occurred/.test(m.content)));
    const crashed = { id: "crashed", sessionId: f.session.id, status: "running", generation: f.h.core.current.id, step: 1, input: "old", createdAt: owner.createdAt };
    const stale = { id: "stale", runId: "crashed", status: "pending" };
    f.h.store.put("run", crashed);
    f.h.store.put("approval", stale);
    await f.reopen();
    assert.equal((await f.h.rpc("runs.status", { runId: "crashed" })).status, "interrupted");
    assert.equal(f.h.store.get<any>("approval", "stale")!.status, "cancelled");
    const resumed = await f.h.rpc("runs.resume", { runId: "crashed", input: "inspect before retry" });
    await f.h.waitForIdle();
    assert.equal((await f.h.rpc("runs.status", { runId: resumed.id })).status, "completed");
    assert.equal(resumed.resumedFrom, "crashed");
    assert.equal(contexts[0].filter((m) => m.role === "tool").length, 2);
    await assert.rejects(fs.stat(join(f.root, "one.txt")));
  } finally { await f.close(); }
});

test("review: trial core survives restart and tampering invalidates trial", async () => {
  const f = await fixture();
  try {
    const filePath = join(f.root, "trial.mjs");
    await fs.writeFile(filePath, "export function apply(ctx){ctx.set('agentCore',{version:'review-trial',stateVersion:1,systemPrompt:'TRIAL',nextStep:api=>api.complete()});}");
    const proposal = await f.h.rpc("improvements.propose", { title: "review", scope: "core", validation: "test", rollback: "builtin", filePath });
    await f.h.rpc("improvements.approve", { id: proposal.id, approved: true });
    await f.h.rpc("improvements.validate", { id: proposal.id, evidence: "fixture" });
    const trial = await f.h.rpc("improvements.apply", { id: proposal.id });
    await f.reopen();
    assert.equal(f.h.core.current.core.version, "review-trial");
    assert.equal(f.h.store.get<any>("improvement", trial.id)!.status, "trial");
    await fs.appendFile(f.h.core.current.path!, "\n// changed after activation");
    await f.reopen();
    assert.equal(f.h.core.current.core.version, "builtin-1");
    assert.equal(f.h.store.get<any>("improvement", trial.id)!.status, "invalidated");
    await assert.rejects(f.h.rpc("improvements.evaluate", { id: trial.id, evaluation: "better" }), /Apply/);
  } finally { await f.close(); }
});

test("review: recursive delegation stops at maximum depth with one agent slot", async () => {
  const seen = new Set<string>();
  const f = await fixture(async (_config, messages) => {
    const id = messages[0].sessionId;
    if (seen.has(id)) return { text: "finished" };
    seen.add(id);
    return { text: "", toolCalls: [{ id: "delegate", name: "agents_delegate", arguments: { input: "descend" } }] };
  });
  try {
    await f.h.rpc("settings.update", { maxAgents: 1 });
    await f.h.rpc("runs.start", { sessionId: f.session.id, input: "descend" });
    await f.h.waitForIdle();
    const runs = await f.h.rpc("runs.status");
    assert.equal(runs.length, 5);
    assert(runs.every((run: any) => run.status === "completed"));
    const history = runs.flatMap((run: any) => f.h.store.messages<any>(run.sessionId));
    assert(history.some((message: any) => message.role === "tool" && /Maximum delegation depth/.test(message.content)));
    assert.equal(f.h.core.current.references, 0);
  } finally { await f.close(); }
});

for (const budget of ["steps", "tokens"] as const) test(`review: delegation shares root ${budget} budget`, async () => {
  let calls = 0;
  const f = await fixture(async () => {
    calls++;
    return { text: "", usage: { inputTokens: 2, outputTokens: 0 }, toolCalls: [{ id: "delegate", name: "agents_delegate", arguments: { input: "descend" } }] };
  });
  try {
    await f.h.rpc("settings.update", { maxAgents: 1, ...(budget === "steps" ? { maxSteps: 3 } : { maxTokens: 6 }) });
    const root = await f.h.rpc("runs.start", { sessionId: f.session.id, input: "root" });
    await f.h.waitForIdle();
    assert.equal(calls, 3);
    const status = await f.h.rpc("runs.status", { runId: root.id });
    assert.equal(status.status, "failed");
    assert.match(status.error, budget === "steps" ? /step limit/i : /token limit/i);
    assert.equal(f.h.core.current.references, 0);
  } finally { await f.close(); }
});

test("review: window handoff approval covers actions and cleanup revokes lease", async () => {
  let step = 0;
  const remote: Array<{ method: string; params: any }> = [];
  const f = await fixture(async () => {
    step++;
    const call = (id: string, method: string, params: any) => ({ id, name: "extension_call", arguments: { method: "worker.desktop." + method, params } });
    if (step === 1) return { text: "", toolCalls: [call("lease", "lease", { handle: 42, seconds: 60 })] };
    if (step === 2) return { text: "", toolCalls: [call("read", "read", { lease_id: "lease-42" })] };
    if (step === 3) return { text: "", toolCalls: [call("click", "action", { lease_id: "lease-42", action: "invoke", path: [0], expected_snapshot: "snapshot-42" })] };
    return { text: "finished" };
  });
  f.h.workspace.remote = async (_session, method, params) => {
    remote.push({ method, params });
    return method === "desktop.lease" ? { lease_id: "lease-42" } : method === "desktop.read" ? { snapshot: "snapshot-42", elements: [{ path: [0] }] } : { ok: true };
  };
  try {
    await f.h.rpc("runs.start", { sessionId: f.session.id, input: "use this window" });
    await until(() => f.h.store.list<any>("approval").some((a) => a.status === "pending"));
    const [approval] = await f.h.rpc("approvals.list");
    assert.equal(approval.arguments.method, "worker.desktop.lease");
    assert.equal(remote.length, 0);
    await f.h.rpc("approvals.resolve", { id: approval.id, approved: true });
    await f.h.waitForIdle();
    assert.equal(f.h.store.list<any>("approval").length, 1);
    assert.deepEqual(remote.map((call) => call.method), ["desktop.lease", "desktop.read", "desktop.action", "desktop.revoke"]);
    assert.equal(remote[0].params.approved, true);
    assert.equal(remote.at(-1)!.params.lease_id, "lease-42");
  } finally { await f.close(); }
});

test("review: child token exhaustion blocks later sibling actions in parent turn", async () => {
  const f = await fixture(async (_config, messages) => {
    const parent = messages.some((message) => message.role === "user" && message.content === "root");
    return parent ? {
      text: "", usage: { inputTokens: 1, outputTokens: 0 },
      toolCalls: [
        { id: "delegate", name: "agents_delegate", arguments: { input: "child" } },
        { id: "write", name: "files_write", arguments: { path: "forbidden.txt", content: "must not happen", baseVersion: null } },
      ],
    } : { text: "child done", usage: { inputTokens: 5, outputTokens: 0 } };
  });
  try {
    await f.h.rpc("settings.update", { maxAgents: 1, maxTokens: 6, permissions: { write: "allow" } });
    const root = await f.h.rpc("runs.start", { sessionId: f.session.id, input: "root" });
    await f.h.waitForIdle();
    assert.equal((await f.h.rpc("runs.status", { runId: root.id })).status, "failed");
    await assert.rejects(fs.stat(join(f.root, "forbidden.txt")));
    const messages = await f.h.rpc("messages.list", { sessionId: f.session.id });
    assert.match(messages.find((message: any) => message.toolCallId === "write").content, /token limit/i);
  } finally { await f.close(); }
});

test("review: cancelled external call retains session exclusion until cleanup", async () => {
  let releaseTool!: () => void, releaseOther!: () => void;
  const toolHold = new Promise<void>((resolve) => { releaseTool = resolve; });
  const otherHold = new Promise<void>((resolve) => { releaseOther = resolve; });
  let toolStarted = false, otherStarted = false, nextStarted = false;
  const f = await fixture(async (_config, messages) => {
    const input = messages.filter((message) => message.role === "user").at(-1)!.content;
    if (input === "hold") return { text: "", toolCalls: [{ id: "external", name: "extension_call", arguments: { method: "worker.jobs.list", params: {} } }] };
    if (input === "other") { otherStarted = true; await otherHold; }
    if (input === "next") nextStarted = true;
    return { text: "done" };
  });
  f.h.workspace.remote = async () => { toolStarted = true; await toolHold; return { jobs: [] }; };
  try {
    await f.h.rpc("settings.update", { maxAgents: 2 });
    const first = await f.h.rpc("runs.start", { sessionId: f.session.id, input: "hold" });
    await until(() => toolStarted);
    const next = await f.h.rpc("runs.start", { sessionId: f.session.id, input: "next" });
    const otherSession = await f.h.rpc("sessions.create", { projectId: f.project.id });
    const other = await f.h.rpc("runs.start", { sessionId: otherSession.id, input: "other" });
    await until(() => otherStarted);
    await f.h.rpc("runs.cancel", { runId: first.id });
    releaseOther();
    await until(() => f.h.store.get<any>("run", other.id)?.status === "completed");
    // The other run's completion pumps queued work while the cancelled call is held.
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(nextStarted, false);
    assert.equal((await f.h.rpc("runs.status", { runId: next.id })).status, "queued");
    releaseTool();
    await f.h.waitForIdle();
    assert.equal(nextStarted, true);
    assert.equal((await f.h.rpc("runs.status", { runId: next.id })).status, "completed");
  } finally { releaseTool(); releaseOther(); await f.close(); }
});
