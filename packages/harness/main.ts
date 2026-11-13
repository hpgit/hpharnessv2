import { createInterface } from "node:readline";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer, createConnection, Socket } from "node:net";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { promises as fs, openSync, closeSync } from "node:fs";
import { spawn } from "node:child_process";
import { Harness } from "./src/harness.js";
const args = process.argv.slice(2);
const dataFlag = args.indexOf("--data-dir");
const dataDir = resolve(
  dataFlag >= 0
    ? args[dataFlag + 1]
    : (process.env.HPH_DATA_DIR ?? resolve(homedir(), ".hpharness")),
);
const descriptor = join(dataDir, "daemon.json");
type Descriptor = { port: number; token: string; pid: number; version: 1; build?: string };
async function buildId() {
  const hash = createHash("sha256");
  for (const directory of [new URL("./", import.meta.url), new URL("./src/", import.meta.url), new URL("../../providers/dist/", import.meta.url), new URL("../../extensions/dist/", import.meta.url)]) {
    for (const name of (await fs.readdir(directory)).filter((name) => name.endsWith(".js")).sort())
      hash.update(await fs.readFile(new URL(name, directory)));
  }
  return hash.digest("hex");
}
async function control(value: Descriptor, method: string): Promise<any> {
  const socket = await connect(value);
  return new Promise((resolve, reject) => {
    let buffer = "";
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (const line of buffer.split("\n").slice(0, -1)) {
        const reply = JSON.parse(line);
        if (reply.id === "control") {
          socket.destroy();
          resolve(reply);
        }
      }
    });
    socket.write(JSON.stringify({ id: "control", token: value.token, method }) + "\n");
  });
}
const send = (socket: Socket, message: unknown) => {
  if (!socket.destroyed) socket.write(JSON.stringify(message) + "\n");
};
async function daemon() {
  await fs.mkdir(dataDir, { recursive: true });
  const lockPath = join(dataDir, "daemon.lock");
  let lock;
  try {
    lock = await fs.open(lockPath, "wx", 0o600);
    await lock.writeFile(JSON.stringify({ pid: process.pid, instance: randomBytes(16).toString("hex") }));
  } catch (e: any) {
    if (e.code !== "EEXIST") throw e;
    const contents = await fs.readFile(lockPath, "utf8");
    let owner: any;
    try { owner = JSON.parse(contents); } catch {}
    const modern = owner && typeof owner === "object" && typeof owner.instance === "string";
    const pid = Number(modern ? owner.pid : contents);
    let alive = false;
    try {
      if (!Number.isInteger(pid) || pid < 1) throw new Error("Invalid lock PID");
      process.kill(pid, 0);
      alive = true;
      const existing: Descriptor = JSON.parse(await fs.readFile(descriptor, "utf8"));
      if (existing.pid === pid && (await control(existing, "ping")).result?.pid === pid) return;
    } catch {
      // A live reused PID alone is insufficient evidence that this daemon owns it.
    }
    const stat = await fs.stat(lockPath);
    if (modern && alive) {
      if (Date.now() - stat.mtimeMs < 5000) return;
      throw new Error(`Daemon lock belongs to live PID ${pid}, but its authenticated listener is unavailable. Inspect ${descriptor} and ${lockPath}; verify that PID owns the daemon before removing a stale lock.`);
    }
    if ((alive || !Number.isInteger(pid) || pid < 1) && Date.now() - stat.mtimeMs < 5000) return;
    if (await fs.readFile(lockPath, "utf8") !== contents) return;
    await fs.unlink(lockPath);
    return daemon();
  }
  // Keep the ownership lease fresh during slow initialization, before a listener exists.
  const heartbeat = setInterval(() => {
    const now = new Date();
    void lock!.utimes(now, now).catch(() => {});
  }, 1000);
  heartbeat.unref();
  const clients = new Set<Socket>();
  const authenticated = new Set<Socket>();
  const token = randomBytes(32).toString("hex");
  const harness = await new Harness(dataDir, (event, data) => {
    for (const socket of authenticated) send(socket, { event, data });
  }).start();
  const server = createServer((socket) => {
    clients.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("error", () => {});
    socket.on("close", () => {
      clients.delete(socket);
      authenticated.delete(socket);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 8_000_000) {
        socket.destroy();
        return;
      }
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        void (async () => {
          let request: any;
          try {
            request = JSON.parse(line);
            const supplied = Buffer.from(String(request.token ?? ""));
            const expected = Buffer.from(token);
            if (
              supplied.length !== expected.length ||
              !timingSafeEqual(supplied, expected)
            ) {
              send(socket, {
                id: request.id,
                error: {
                  code: "UNAUTHORIZED",
                  message: "Invalid daemon token",
                },
              });
              socket.end();
              return;
            }
            authenticated.add(socket);
            if (typeof request.method !== "string")
              throw new Error("method required");
            if (request.method === "daemon.shutdown") {
              send(socket, { id: request.id, result: { shuttingDown: true } });
              setImmediate(() => void close());
              return;
            }
            const result = await harness.rpc(request.method, request.params);
            send(socket, { id: request.id, result });
          } catch (error: any) {
            send(socket, {
              id: request?.id ?? null,
              error: {
                code: error.code ?? "ERROR",
                message: error.message ?? String(error),
              },
            });
          }
        })();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No listener");
  const value: Descriptor = {
    port: address.port,
    token,
    pid: process.pid,
    version: 1,
    build: await buildId(),
  };
  await fs.writeFile(descriptor + ".tmp", JSON.stringify(value), {
    mode: 0o600,
  });
  await fs.rename(descriptor + ".tmp", descriptor);
  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    for (const socket of clients) socket.end();
    server.close();
    await harness.close();
    clearInterval(heartbeat);
    await lock!.close();
    await fs.rm(lockPath, { force: true });
    await fs.rm(descriptor, { force: true });
    process.exit(0);
  }
  process.on("SIGINT", () => void close());
  process.on("SIGTERM", () => void close());
}
async function connect(value: Descriptor) {
  return new Promise<Socket>((res, rej) => {
    const socket = createConnection({ host: "127.0.0.1", port: value.port });
    socket.once("connect", () => res(socket));
    socket.once("error", rej);
    socket.setTimeout(3000, () =>
      socket.destroy(new Error("Daemon connection timed out")),
    );
  });
}
async function client() {
  await fs.mkdir(dataDir, { recursive: true });
  let value: Descriptor | undefined, socket: Socket | undefined;
  let incompatible: Error | undefined;
  try {
    value = JSON.parse(await fs.readFile(descriptor, "utf8"));
    if (args.includes("--shutdown") || value!.build !== await buildId()) {
      const reply = await control(value!, "daemon.shutdown");
      if (reply.error) {
        incompatible = new Error(`Running daemon PID ${value!.pid} cannot shut down (${reply.error.message}). Stop it before reconnecting to the rebuilt harness.`);
        throw incompatible;
      }
      for (let attempt = 0; attempt < 100; attempt++) {
        try { await fs.access(descriptor); } catch { break; }
        await new Promise((r) => setTimeout(r, 100));
      }
    } else socket = await connect(value!);
  } catch {}
  if (incompatible) throw incompatible;
  if (args.includes("--shutdown")) return;
  if (!socket) {
    const fd = openSync(join(dataDir, "daemon.log"), "a");
    spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), "--daemon", "--data-dir", dataDir],
      {
        cwd: process.cwd(),
        detached: true,
        windowsHide: true,
        stdio: ["ignore", fd, fd],
      },
    ).unref();
    closeSync(fd);
    for (let attempt = 0; attempt < 100; attempt++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        value = JSON.parse(await fs.readFile(descriptor, "utf8"));
        socket = await connect(value!);
        break;
      } catch {}
    }
  }
  if (!socket || !value)
    throw new Error(
      "Cannot start harness daemon; inspect " + join(dataDir, "daemon.log"),
    );
  socket.setTimeout(0);
  let pending = 0,
    inputClosed = false,
    responseBuffer = "";
  socket.on("data", (chunk) => {
    process.stdout.write(chunk);
    responseBuffer += chunk.toString();
    let newline;
    while ((newline = responseBuffer.indexOf("\n")) >= 0) {
      const line = responseBuffer.slice(0, newline);
      responseBuffer = responseBuffer.slice(newline + 1);
      try {
        const response = JSON.parse(line);
        if ("id" in response) pending = Math.max(0, pending - 1);
      } catch {}
    }
    if (inputClosed && pending === 0) socket!.end();
  });
  socket.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  socket.on("close", () => process.exit());
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    try {
      const request = JSON.parse(line);
      pending++;
      socket!.write(JSON.stringify({ ...request, token: value!.token }) + "\n");
    } catch (error: any) {
      process.stdout.write(
        JSON.stringify({
          id: null,
          error: { code: "PARSE_ERROR", message: error.message },
        }) + "\n",
      );
    }
  });
  lines.on("close", () => {
    inputClosed = true;
    if (pending === 0) socket!.end();
  });
  process.stdout.on("error", () => socket!.end());
}
try {
  if (args.includes("--daemon")) await daemon();
  else await client();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
