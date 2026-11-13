import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RpcProcess,
  languageServers,
  Extensions,
  serverLaunch,
  textChunks,
} from "./index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("embedding chunks bound document requests and preserve image and text vectors", async () => {
  assert.deepEqual(textChunks("😀😀😀", 2, 1), ["😀😀", "😀😀"]);
  assert.throws(() => textChunks("text", 2, 2));
  const root = mkdtempSync(join(tmpdir(), "hph-embedding-chunks-"));
  const extensions = new Extensions(root);
  const calls: any[] = [];
  const vector = (image: boolean) => { const v = Array(768).fill(0); v[image ? 1 : 0] = 1; return v; };
  (extensions as any).embedding = { close() {}, async request(_method: string, p: any) {
    if (p.items.length > 8) throw new Error("Embedding worker accepts at most eight items");
    calls.push(p);
    return { fingerprint: "model", vectors: p.items.map((item: any) => vector(item.kind === "image")) };
  } };
  try {
    const source = await extensions.handle("knowledge.ingest", { projectId: "p", source: "test", title: "test", text: "long document ".repeat(3000) });
    const text = await extensions.handle("embedding.index", { sourceId: source.id, kind: "code" });
    assert.ok(text.chunks > 16);
    assert.ok(calls.every((call) => call.items.length <= 8 && call.items.every((item: any) => item.kind === "code" && item.text.length <= 1200)));
    await extensions.handle("embedding.index", { sourceId: source.id, imagePath: "image.png" });
    const found = await extensions.handle("semantic.search", { projectId: "p", query: "long" });
    assert.equal(found.results.length, 1);
    assert.equal(found.results[0].similarity, 1);
  } finally { extensions.close(); rmSync(root, { recursive: true, force: true }); }
});
test("SSH LSP preserves POSIX URI and shell-quotes argument boundaries", () => {
  const s = serverLaunch({
    command: "clangd",
    args: ["--query-driver=/tmp/a b"],
    cwd: "/home/user/a'b",
    target: { kind: "ssh", host: "wsl" },
  });
  assert.equal(s.rootUri, "file:///home/user/a'b");
  assert.ok(s.config.args?.at(-1)?.includes("'\\''"));
  assert.throws(() =>
    serverLaunch({
      cwd: "/a",
      target: { kind: "ssh", host: "-ProxyCommand=bad" },
    }),
  );
});
test("all required language families have an explicit server registration", () => {
  const supported = languageServers.flatMap((s) => [...s.languages]);
  for (const l of [
    "python",
    "cpp",
    "cmake",
    "typescript",
    "rust",
    "kotlin",
    "java",
    "gradle",
  ])
    assert.ok(supported.includes(l as any));
});
test("MCP line framing preserves UTF-8 and multiplexed request IDs", async () => {
  const code = `process.stdin.setEncoding('utf8');let b='';process.stdin.on('data',d=>{b+=d;while(b.includes('\\n')){let n=b.indexOf('\\n'),m=JSON.parse(b.slice(0,n));b=b.slice(n+1);process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.params})+'\\n');}});`;
  const rpc = new RpcProcess(
    { command: process.execPath, args: ["-e", code], cwd: process.cwd() },
    "lines",
  );
  try {
    assert.deepEqual(
      await Promise.all([
        rpc.request("echo", { text: "한국어" }),
        rpc.request("echo", { n: 2 }),
      ]),
      [{ text: "한국어" }, { n: 2 }],
    );
  } finally {
    rpc.close();
  }
});
test("exiting process rejects pending requests", async () => {
  const rpc = new RpcProcess(
    {
      command: process.execPath,
      args: ["-e", "process.exit(2)"],
      cwd: process.cwd(),
    },
    "lsp",
  );
  try {
    await assert.rejects(rpc.request("initialize", {}), /exited/);
  } finally {
    rpc.close();
  }
});
test("disconnected tools do not silently return mock data", async () => {
  const extensions = new Extensions();
  await assert.rejects(
    extensions.handle("mcp.call", { id: "missing", name: "x" }),
    /not connected/,
  );
});
