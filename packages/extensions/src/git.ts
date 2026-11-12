import { spawn } from "node:child_process";
import { serverLaunch } from "./index.js";
export async function gitCommand(
  p: any,
  args: string[],
  input?: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const launch = serverLaunch({ ...p, command: "git", args });
  return new Promise((resolve, reject) => {
    const child = spawn(launch.config.command, launch.config.args, {
      cwd: launch.config.cwd,
      windowsHide: true,
      shell: false,
      stdio: "pipe",
    });
    let stdout = "",
      stderr = "";
    let exceeded = false;
    const timer = setTimeout(() => child.kill(), 30000);
    child.stdout.on("data", (x) => {
      stdout += x;
      if (stdout.length > 4 * 1024 * 1024) {
        exceeded = true;
        child.kill();
      }
    });
    child.stderr.on("data", (x) => {
      stderr += x;
      if (stderr.length > 100000) child.kill();
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      exceeded
        ? reject(new Error("Git output exceeds 4 MB; narrow the path"))
        : resolve({ stdout, stderr, code });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}
export async function handleGit(method: string, p: any) {
  if (method === "git.status") {
    const r = await gitCommand(p, ["status", "--short", "--branch"]);
    if (r.code !== 0) throw new Error(r.stderr);
    return r;
  }
  if (method === "git.diff") {
    const r = await gitCommand(p, [
      "diff",
      "--no-ext-diff",
      "--no-color",
      ...(p.cached ? ["--cached"] : []),
      "--",
      ...(p.path ? [p.path] : []),
    ]);
    if (r.code !== 0) throw new Error(r.stderr);
    return r;
  }
  if (method === "git.apply") {
    if (
      typeof p.patch !== "string" ||
      !p.patch.startsWith("diff --git ") ||
      p.patch.length > 4 * 1024 * 1024
    )
      throw new Error("Provide a unified Git diff, at most 4 MB");
    const args = [
      "apply",
      ...(p.cached ? ["--cached"] : []),
      ...(p.reverse ? ["--reverse"] : []),
    ];
    const check = await gitCommand(p, [...args, "--check", "-"], p.patch);
    if (check.code !== 0) throw new Error(check.stderr);
    const result = await gitCommand(p, [...args, "-"], p.patch);
    if (result.code !== 0) throw new Error(result.stderr);
    return { applied: true };
  }
  throw new Error("Unsupported Git method");
}
