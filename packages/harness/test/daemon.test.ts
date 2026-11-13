import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
const main = fileURLToPath(new URL("../main.js", import.meta.url));
function request(
  info: any,
  method: string,
  params = {},
  token = info.token,
): Promise<any> {
  return new Promise((res, rej) => {
    const socket = createConnection(info.port, "127.0.0.1");
    let out = "";
    socket.on("error", rej);
    socket.on("connect", () =>
      socket.write(JSON.stringify({ id: 1, method, params, token }) + "\n"),
    );
    socket.on("data", (chunk) => {
      out += chunk;
      for (const line of out.split("\n").slice(0, -1)) {
        const message = JSON.parse(line);
        if (message.id === 1) {
          socket.end();
          res(message);
        }
      }
    });
    socket.setTimeout(10000, () => {
      socket.destroy();
      rej(new Error("RPC timeout"));
    });
  });
}
test("daemon survives disconnected clients, preserves state and rejects unauthenticated RPC", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "hph-daemon-"));
  const child = spawn(
    process.execPath,
    [main, "--daemon", "--data-dir", root],
    { stdio: "ignore", windowsHide: true },
  );
  try {
    let info: any;
    for (let i = 0; i < 100; i++) {
      try {
        info = JSON.parse(await fs.readFile(join(root, "daemon.json"), "utf8"));
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 30));
      }
    }
    assert(info);
    const ping = await request(info, "ping");
    assert.equal(ping.result.pid, child.pid);
    const created = await request(info, "projects.create", {
      name: "reconnect",
      root,
    });
    assert(created.result.id);
    const projects = await request(info, "projects.list");
    assert.equal(projects.result[0].name, "reconnect");
    const rejected = await request(info, "projects.list", {}, "invalid");
    assert.equal(rejected.error.code, "UNAUTHORIZED");
    const piped = spawn(process.execPath, [main, "--data-dir", root], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    piped.stdout.on("data", (b) => (output += b));
    piped.stdin.end(
      JSON.stringify({ id: 2, method: "projects.list", params: {} }) + "\n",
    );
    await new Promise<void>((res, rej) => {
      piped.on("error", rej);
      piped.on("exit", (code) =>
        code === 0 ? res() : rej(new Error("Piped client failed")),
      );
    });
    assert.equal(JSON.parse(output.trim()).result[0].name, "reconnect");
    const stopped = new Promise<void>((r) => child.once("exit", () => r()));
    assert.equal((await request(info, "daemon.shutdown")).result.shuttingDown, true);
    await stopped;
    await assert.rejects(fs.access(join(root, "daemon.lock")));
    await assert.rejects(fs.access(join(root, "daemon.json")));
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise<void>((r) => child.once("exit", () => r()));
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("daemon recovers a stale lock whose PID belongs to another live process", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "hph-daemon-reused-"));
  await fs.writeFile(join(root, "daemon.lock"), String(process.pid));
  const old = new Date(Date.now() - 60000);
  await fs.utimes(join(root, "daemon.lock"), old, old);
  const child = spawn(process.execPath, [main, "--daemon", "--data-dir", root], { stdio: "ignore", windowsHide: true });
  try {
    let info: any;
    for (let i = 0; i < 100; i++) {
      try { info = JSON.parse(await fs.readFile(join(root, "daemon.json"), "utf8")); break; }
      catch { await new Promise((r) => setTimeout(r, 30)); }
    }
    assert.equal(info?.pid, child.pid);
    assert.equal((await request(info, "ping")).result.pid, child.pid);
    const stopped = new Promise<void>((r) => child.once("exit", () => r()));
    await request(info, "daemon.shutdown");
    await stopped;
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise<void>((r) => child.once("exit", () => r()));
      child.kill(); await stopped;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("client replaces an outdated build through authenticated shutdown", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "hph-daemon-build-"));
  const child = spawn(process.execPath, [main, "--daemon", "--data-dir", root], { stdio: "ignore", windowsHide: true });
  let info: any;
  try {
    for (let i = 0; i < 100; i++) {
      try { info = JSON.parse(await fs.readFile(join(root, "daemon.json"), "utf8")); break; }
      catch { await new Promise((r) => setTimeout(r, 30)); }
    }
    assert.equal(info?.pid, child.pid);
    const created = await request(info, "projects.create", { name: "survives rebuild", root });
    assert.ok(created.result.id);
    await fs.writeFile(join(root, "daemon.json"), JSON.stringify({ ...info, build: "old-build" }));
    const client = spawn(process.execPath, [main, "--data-dir", root], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let output = "", diagnostic = "";
    client.stdout.on("data", (data) => output += data);
    client.stderr.on("data", (data) => diagnostic += data);
    client.stdin.end(JSON.stringify({ id: 1, method: "projects.list" }) + "\n");
    const code = await new Promise((resolve, reject) => { client.once("exit", resolve); client.once("error", reject); });
    assert.equal(code, 0, diagnostic);
    assert.equal(JSON.parse(output.trim()).result[0].name, "survives rebuild");
    const replacement = JSON.parse(await fs.readFile(join(root, "daemon.json"), "utf8"));
    assert.notEqual(replacement.pid, info.pid);
    info = replacement;
    assert.equal((await request(info, "ping")).result.pid, replacement.pid);
  } finally {
    if (info) {
      try { await request(info, "daemon.shutdown"); } catch {}
      for (let i = 0; i < 100; i++) {
        try { await fs.access(join(root, "daemon.lock")); } catch { break; }
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise<void>((r) => child.once("exit", () => r())); child.kill(); await stopped;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("concurrent daemon startup retains one lock owner", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "hph-daemon-concurrent-"));
  const children = [0, 1].map(() => spawn(process.execPath, [main, "--daemon", "--data-dir", root], { stdio: "ignore", windowsHide: true }));
  let info: any;
  try {
    for (let i = 0; i < 100; i++) {
      try { info = JSON.parse(await fs.readFile(join(root, "daemon.json"), "utf8")); break; }
      catch { await new Promise((r) => setTimeout(r, 30)); }
    }
    assert.ok(children.some((child) => child.pid === info?.pid));
    assert.equal((await request(info, "ping")).result.pid, info.pid);
    const owner = JSON.parse(await fs.readFile(join(root, "daemon.lock"), "utf8"));
    assert.equal(owner.pid, info.pid);
    const loser = children.find((child) => child.pid !== info.pid)!;
    if (loser.exitCode === null) await new Promise<void>((resolve) => loser.once("exit", () => resolve()));
    assert.equal(loser.exitCode, 0);
  } finally {
    if (info) { try { await request(info, "daemon.shutdown"); } catch {} }
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const stopped = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        child.kill(); await stopped;
      }
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});
