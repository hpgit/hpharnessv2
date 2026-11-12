import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { Harness } from "../src/harness.js";
test(
  "live Responses tool loop reads workspace and records durable model/tool evidence",
  { skip: !process.env.HPH_LIVE_TEST },
  async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "hph-live-"));
    const h = await new Harness(join(root, "state")).start();
    try {
      await fs.writeFile(join(root, "sentinel.txt"), "CANARY_8519");
      const project = await h.rpc("projects.create", { name: "live", root });
      const session = await h.rpc("sessions.create", { projectId: project.id });
      await h.rpc("settings.update", { maxSteps: 5 });
      const run = await h.rpc("runs.start", {
        sessionId: session.id,
        input:
          "Read sentinel.txt using the files_read tool. Reply with exactly the file contents. Do not guess.",
      });
      await h.waitForIdle(120000);
      const status = await h.rpc("runs.status", { runId: run.id });
      assert.equal(status.status, "completed", status.error);
      const messages = await h.rpc("messages.list", { sessionId: session.id });
      assert(
        messages.some(
          (m: any) => m.role === "tool" && m.content.includes("CANARY_8519"),
        ),
      );
      assert(messages.at(-1).content.includes("CANARY_8519"));
    } finally {
      await h.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
test(
  "SSH worker executes through existing config without WSL dependency",
  { skip: !process.env.HPH_SSH_TEST },
  async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "hph-ssh-"));
    const h = await new Harness(root).start();
    try {
      await h.rpc("settings.update", {
        pythonPath: resolve("../../.venv/Scripts/python.exe"),
        workerPath: resolve("../worker/hph_worker.py"),
      });
      const project = await h.rpc("projects.create", {
        name: "ssh",
        root: "/tmp",
        target: { kind: "ssh", host: process.env.HPH_SSH_TEST },
      });
      const session = await h.rpc("sessions.create", { projectId: project.id });
      const result = await h.rpc("command.run", {
        sessionId: session.id,
        argv: ["python3", "-c", 'print("SSH_HARNESS_OK")'],
      });
      assert.equal(result.stdout.trim(), "SSH_HARNESS_OK");
      const entries = await h.rpc("files.list", { sessionId: session.id });
      assert(Array.isArray(entries));
    } finally {
      await h.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
