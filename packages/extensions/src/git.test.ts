import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitCommand, handleGit } from "./git.js";
test("Git selected file patch stages only that change and invalid patch preserves index", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "hph-git-"));
  const p = { cwd };
  try {
    await gitCommand(p, ["init"]);
    writeFileSync(join(cwd, "a.txt"), "before\n");
    writeFileSync(join(cwd, "b.txt"), "before\n");
    await gitCommand(p, ["add", "."]);
    await gitCommand(p, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "initial",
    ]);
    writeFileSync(join(cwd, "a.txt"), "after\n");
    writeFileSync(join(cwd, "b.txt"), "after\n");
    const diff = (await handleGit("git.diff", { cwd, path: "a.txt" })) as any;
    await handleGit("git.apply", { cwd, patch: diff.stdout, cached: true });
    const staged = (await handleGit("git.diff", { cwd, cached: true })) as any;
    assert.match(staged.stdout, /a.txt/);
    assert.doesNotMatch(staged.stdout, /b.txt/);
    await assert.rejects(
      handleGit("git.apply", { cwd, patch: "invalid", cached: true }),
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
