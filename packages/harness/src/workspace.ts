import { spawn } from "node:child_process";
import { promises as fs, existsSync } from "node:fs";
import { resolve, relative, isAbsolute, dirname, basename } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Session, RpcError, Settings } from "./types.js";
export const hash = (text: string) =>
  createHash("sha256").update(text).digest("hex");
function terminateTree(child: ReturnType<typeof spawn>) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.on("error", () => child.kill());
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
}
export class Workspace {
  constructor(private settings: () => Settings, private dataDir?: string) {}
  async path(session: Session, path = ".", writing = false) {
    const root = await fs.realpath(session.cwd);
    const candidate = resolve(root, path);
    const rel = relative(root, candidate);
    if (
      rel === ".." ||
      rel.startsWith("..\\") ||
      rel.startsWith("../") ||
      isAbsolute(rel)
    )
      throw new RpcError(
        "OUTSIDE_WORKSPACE",
        "Path is outside session workspace",
      );
    let actual: string;
    try {
      actual = await fs.realpath(candidate);
    } catch (e: any) {
      if (e.code !== "ENOENT" || !writing) throw e;
      let ancestor = dirname(candidate);
      const missing = [basename(candidate)];
      for (;;) {
        try {
          actual = resolve(await fs.realpath(ancestor), ...missing);
          break;
        } catch (error: any) {
          if (error.code !== "ENOENT") throw error;
          missing.unshift(basename(ancestor));
          ancestor = dirname(ancestor);
        }
      }
    }
    const realRel = relative(root, actual);
    if (
      realRel === ".." ||
      realRel.startsWith("..\\") ||
      realRel.startsWith("../") ||
      isAbsolute(realRel)
    )
      throw new RpcError("OUTSIDE_WORKSPACE", "Symlink escapes workspace");
    return actual;
  }
  async remote(
    session: Session,
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    if (signal?.aborted) throw new RpcError("CANCELLED", "Worker request cancelled");
    const settings = this.settings();
    if (method === "sdk.run" && params.timeout === undefined) params = { ...params, timeout: 600 };
    const localPython = resolve(
      ".venv",
      process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
    );
    const python =
      settings.pythonPath || (existsSync(localPython) ? localPython : "python");
    const worker =
      settings.workerPath || resolve("packages/worker/hph_worker.py");
    const target = session.target;
    if (target.kind === "ssh") {
      if (
        !target.host ||
        target.host.startsWith("-") ||
        /[\s\r\n]/.test(target.host)
      )
        throw new RpcError("INVALID_TARGET", "Invalid SSH alias");
      const args = [
        "-u",
        resolve(dirname(worker), "remote.py"),
        "--host",
        target.host,
        "--root",
        session.cwd,
      ];
      if (target.container) args.push("--container", target.container);
      return this.jsonProcess(
        python,
        args,
        JSON.stringify({ id: 1, method, params }),
      );
    }
    if (target.container) {
      return this.jsonProcess(
        python,
        [
          "-u",
          resolve(dirname(worker), "remote.py"),
          "--local-container",
          target.container,
          "--root",
          session.cwd,
        ],
        JSON.stringify({ id: 1, method, params }),
      );
    }
    return this.jsonProcess(
      python,
      ["-u", worker, "--root", session.cwd, ...(this.dataDir ? ["--mail-root", resolve(this.dataDir, "knowledge")] : [])],
      JSON.stringify({ id: 1, method, params }),
    );
  }
  async jsonProcess(
    command: string,
    args: string[],
    request: string,
  ): Promise<any> {
    return new Promise((res, rej) => {
      const child = spawn(command, args, {
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      let out = "",
        err = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdin.on("error", (error) => { clearTimeout(timer); rej(error); });
      const timer = setTimeout(() => {
        terminateTree(child);
        rej(
          new RpcError(
            "WORKER_TIMEOUT",
            "Worker response timed out; side effects may need inspection",
          ),
        );
      }, Math.max(300_000, (Number(JSON.parse(request).params?.timeout) || 0) * 1000 + 60_000));
      child.stdout.on("data", (chunk) => {
        out += chunk;
        if (out.length > 20_000_000) {
          terminateTree(child);
          rej(new RpcError("TOO_LARGE", "Worker response exceeds 20 MB"));
        }
      });
      child.stderr.on("data", (chunk) => {
        err = (err + chunk).slice(-8192);
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        rej(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        try {
          const line = out
            .trim()
            .split("\n")
            .find((l) => {
              try {
                return JSON.parse(l).id === 1;
              } catch {
                return false;
              }
            });
          if (!line)
            throw new RpcError(
              "WORKER_FAILED",
              `Worker exited ${code}: ${err}`,
            );
          const result = JSON.parse(line);
          if (result.error)
            throw new RpcError(
              String(result.error.code),
              String(result.error.message),
            );
          res(result.result);
        } catch (e) {
          rej(e);
        }
      });
      child.stdin.end(request + "\n");
    });
  }
  async list(session: Session, path = ".") {
    if (session.target.kind === "ssh" || session.target.container) {
      const result = await this.remote(session, "files.list", { path });
      return (Array.isArray(result) ? result : result.entries).map(
        (e: any) => ({ ...e, isDirectory: e.isDirectory ?? e.directory }),
      );
    }
    const full = await this.path(session, path);
    const entries = await fs.readdir(full, { withFileTypes: true });
    return entries
      .filter(
        (e) =>
          ![".git", "node_modules", "target", ".venv", ".uv-cache"].includes(
            e.name,
          ),
      )
      .map((e) => ({
        name: e.name,
        path: relative(session.cwd, resolve(full, e.name)),
        isDirectory: e.isDirectory(),
      }))
      .sort(
        (a, b) =>
          Number(b.isDirectory) - Number(a.isDirectory) ||
          a.name.localeCompare(b.name),
      );
  }
  async read(session: Session, path: string) {
    if (session.target.kind === "ssh" || session.target.container) {
      const result = await this.remote(session, "files.read", { path });
      if (result.encoding && result.encoding !== "utf-8")
        throw new RpcError(
          "BINARY_FILE",
          "Binary files require an artifact preview, not the text editor",
        );
      return {
        path,
        content: result.content,
        version: result.hash ?? result.version ?? hash(result.content),
      };
    }
    const full = await this.path(session, path);
    const stat = await fs.stat(full);
    if (stat.size > 4_000_000)
      throw new RpcError(
        "FILE_TOO_LARGE",
        "Editor limit is 4 MB; use an artifact preview",
      );
    const bytes = await fs.readFile(full);
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new RpcError("BINARY_FILE", "File is not valid UTF-8 text"); }
    if (content.includes("\0"))
      throw new RpcError("BINARY_FILE", "File is not text");
    return { path, content, version: hash(content) };
  }
  async preview(session: Session, path: string) {
    const limit = 10 * 1024 * 1024;
    let data: Buffer;
    if (session.target.kind === "ssh" || session.target.container) {
      const result = await this.remote(session, "files.read", { path, limit });
      data = Buffer.from(
        result.content,
        result.encoding === "base64" ? "base64" : "utf8",
      );
    } else {
      const file = await this.path(session, path);
      if ((await fs.stat(file)).size > limit)
        throw new RpcError("FILE_TOO_LARGE", "Image preview limit is 10 MB");
      data = await fs.readFile(file);
    }
    if (data.length > limit)
      throw new RpcError("FILE_TOO_LARGE", "Image preview limit is 10 MB");
    let mime: string;
    if (
      data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      mime = "image/png";
    else if (data[0] === 255 && data[1] === 216 && data[2] === 255)
      mime = "image/jpeg";
    else if (
      ["GIF87a", "GIF89a"].includes(data.subarray(0, 6).toString("ascii"))
    )
      mime = "image/gif";
    else if (
      data.subarray(0, 4).toString("ascii") === "RIFF" &&
      data.subarray(8, 12).toString("ascii") === "WEBP"
    )
      mime = "image/webp";
    else
      throw new RpcError(
        "UNSUPPORTED_PREVIEW",
        "Only PNG, JPEG, GIF and WebP images are supported",
      );
    return { path, mime, base64: data.toString("base64"), size: data.length };
  }
  async write(
    session: Session,
    path: string,
    content: string,
    baseVersion: string | null,
  ) {
    if (session.target.kind === "ssh" || session.target.container) {
      const result = await this.remote(session, "files.write", {
        path,
        content,
        expected_hash: baseVersion,
      });
      return { path, version: result.hash ?? hash(content) };
    }
    const full = await this.path(session, path, true);
    let old: Buffer | undefined;
    try {
      old = await fs.readFile(full);
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
    if (old !== undefined && createHash("sha256").update(old).digest("hex") !== baseVersion)
      throw new RpcError(
        "VERSION_CONFLICT",
        "File changed since it was read; reload and review the diff",
      );
    if (old === undefined && baseVersion !== null)
      throw new RpcError(
        "VERSION_CONFLICT",
        "File was removed since it was read",
      );
    await fs.mkdir(dirname(full), { recursive: true });
    await this.path(session, path, true);
    const temp = full + ".hph-" + randomUUID() + ".tmp";
    const mode = old === undefined ? undefined : (await fs.stat(full)).mode;
    await fs.writeFile(temp, content, { flag: "wx", mode });
    try {
      let latest: Buffer | undefined;
      try {
        latest = await fs.readFile(full);
      } catch (error: any) {
        if (error.code !== "ENOENT") throw error;
      }
      if (latest === undefined ? old !== undefined : old === undefined || !latest.equals(old))
        throw new RpcError(
          "VERSION_CONFLICT",
          "File changed during preparation; reload and review the diff",
        );
      await fs.rename(temp, full);
    } catch (error) {
      await fs.rm(temp, { force: true });
      throw error;
    }
    return { path, version: hash(content) };
  }
  async command(
    session: Session,
    argv: string[],
    cwd?: string,
    signal?: AbortSignal,
  ) {
    if (
      !Array.isArray(argv) ||
      !argv.length ||
      argv.some((a) => typeof a !== "string" || a.includes("\0"))
    )
      throw new RpcError("INVALID_ARGUMENT", "argv must be nonempty strings");
    if (signal?.aborted) throw new RpcError("CANCELLED", "Command cancelled");
    if (session.target.kind === "ssh" || session.target.container) {
      const job = await this.remote(session, "jobs.start", {
        argv,
        cwd: cwd ?? ".",
        timeout: 120,
      });
      let cancelled = false;
      for (;;) {
        if (signal?.aborted && !cancelled) {
          await this.remote(session, "jobs.cancel", { job_id: job.job_id });
          cancelled = true;
        }
        const result = await this.remote(session, "jobs.status", { job_id: job.job_id });
        if (["completed", "failed", "cancelled", "timed_out", "unknown"].includes(result.status)) return result;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    const workdir = await this.path(session, cwd ?? ".");
    return new Promise((res, rej) => {
      const child = spawn(argv[0], argv.slice(1), {
        cwd: workdir,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      let timedOut = false;
      const cancel = () => terminateTree(child);
      const timer = setTimeout(() => { timedOut = true; cancel(); }, 120_000);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); };
      child.stdout.on("data", (b) => (stdout = (stdout + b).slice(-1_000_000)));
      child.stderr.on("data", (b) => (stderr = (stderr + b).slice(-1_000_000)));
      child.on("error", (error) => { cleanup(); rej(error); });
      child.on("close", (exitCode, exitSignal) => {
        cleanup();
        res({ stdout, stderr, exitCode, signal: exitSignal, status: timedOut ? "timed_out" : signal?.aborted ? "cancelled" : exitCode === 0 ? "completed" : "failed" });
      });
    });
  }
}
