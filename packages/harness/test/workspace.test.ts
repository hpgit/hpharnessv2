import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace, hash } from "../src/workspace.js";
import type { Session, Settings } from "../src/types.js";

test("workspace preserves UTF-8 bytes and creates nested files", async () => {
  const cwd = await fs.mkdtemp(join(tmpdir(), "hph-workspace-"));
  const session = { cwd, target: { kind: "local" } } as Session;
  const workspace = new Workspace(() => ({} as Settings));
  try {
    await workspace.write(session, "new/nested/hello.txt", "안녕", null);
    assert.equal((await workspace.read(session, "new/nested/hello.txt")).content, "안녕");
    await fs.writeFile(join(cwd, "invalid.txt"), Buffer.from([0xff]));
    await assert.rejects(workspace.read(session, "invalid.txt"), /UTF-8/);
    await assert.rejects(workspace.write(session, "invalid.txt", "replacement", hash("�")), /changed/);
    assert.deepEqual(await fs.readFile(join(cwd, "invalid.txt")), Buffer.from([0xff]));
    await fs.writeFile(join(cwd, "bom.txt"), "\ufeffhello");
    const bom = await workspace.read(session, "bom.txt");
    assert.equal(bom.version, hash("\ufeffhello"));
    await workspace.write(session, "bom.txt", bom.content, bom.version);
  } finally { await fs.rm(cwd, { recursive: true, force: true }); }
});

test("local command cancellation terminates child processes", async () => {
  const controller = new AbortController();
  const workspace = new Workspace(() => ({} as Settings));
  const session = { cwd: process.cwd(), target: { kind: "local" } } as Session;
  const pending = workspace.command(session, [process.execPath, "-e", "setInterval(()=>{},1000)"], undefined, controller.signal);
  setTimeout(() => controller.abort(), 100);
  const result = await pending as { status: string };
  assert.equal(result.status, "cancelled");
});

test("remote cancellation reaches the durable job owner", async () => {
  const controller = new AbortController();
  const workspace = new Workspace(() => ({} as Settings));
  const calls: string[] = [];
  workspace.remote = async (_session, method) => {
    calls.push(method);
    if (method === "jobs.start") { controller.abort(); return { job_id: "job" }; }
    if (method === "jobs.cancel") return {};
    return { status: "cancelled" };
  };
  const result = await workspace.command({ target: { kind: "ssh" } } as Session, ["example"], undefined, controller.signal) as { status: string };
  assert.equal(result.status, "cancelled");
  assert.deepEqual(calls, ["jobs.start", "jobs.cancel", "jobs.status"]);
});

