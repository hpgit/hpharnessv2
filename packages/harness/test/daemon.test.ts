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
  } finally {
    child.kill();
    await new Promise<void>((r) => child.once("exit", () => r()));
    await fs.rm(root, { recursive: true, force: true });
  }
});
