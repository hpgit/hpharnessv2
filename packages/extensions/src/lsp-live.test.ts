import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Extensions } from "./index.js";
test(
  "real Pyright definitions completion diagnostics UTF8 transport",
  { skip: !process.env.HPH_LSP_TEST },
  async () => {
    const root = resolve(import.meta.dirname, "../../..");
    const folder = await mkdtemp(join(tmpdir(), "hph-lsp-"));
    const file = join(folder, "sample.py");
    const uri = pathToFileURL(file).href;
    const text =
      'def greet(name: str) -> str:\n    return name.upper()\n\ngreeting = greet("한국어")\ngreeting.\n';
    await writeFile(file, text);
    const ext = new Extensions();
    try {
      const init = await ext.handle("lsp.start", {
        id: "python",
        command: process.execPath,
        args: [
          resolve(
            root,
            ".tools/languages/node_modules/pyright/langserver.index.js",
          ),
          "--stdio",
        ],
        cwd: folder,
      });
      assert.ok(init.capabilities.completionProvider);
      await ext.handle("lsp.notify", {
        id: "python",
        method: "textDocument/didOpen",
        params: {
          textDocument: { uri, languageId: "python", version: 1, text },
        },
      });
      const definition = await ext.handle("lsp.request", {
        id: "python",
        method: "textDocument/definition",
        params: { textDocument: { uri }, position: { line: 3, character: 13 } },
      });
      assert.ok(definition?.length);
      const completion = await ext.handle("lsp.request", {
        id: "python",
        method: "textDocument/completion",
        params: { textDocument: { uri }, position: { line: 4, character: 9 } },
      });
      assert.ok(
        (completion.items ?? completion).some((x: any) => x.label === "upper"),
      );
      let diagnostics: any[] = [];
      for (let n = 0; n < 20; n++) {
        diagnostics = await ext.handle("lsp.diagnostics", { id: "python" });
        if (diagnostics.some((x) => x.diagnostics?.length)) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(
        diagnostics.some((x) => x.diagnostics?.length),
        "invalid trailing dot produces diagnostics",
      );
    } finally {
      ext.close();
      await rm(folder, { recursive: true, force: true });
    }
  },
);
