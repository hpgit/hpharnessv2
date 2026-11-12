import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { BrowserService } from "./browser.js";
import { KnowledgeStore } from "./knowledge.js";
import { handleGit } from "./git.js";
import { VectorIndex } from "./vectors.js";

export interface ServerConfig {
  command: string;
  args?: string[];
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}
export function serverLaunch(p: any): {
  config: ServerConfig;
  rootUri: string;
  remote: boolean;
} {
  if (p.target?.kind !== "ssh")
    return {
      config: p,
      rootUri: pathToFileURL(resolve(p.cwd)).href,
      remote: false,
    };
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.@-]*$/.test(p.target.host ?? ""))
    throw new Error("Invalid SSH host alias");
  if (!p.cwd?.startsWith("/"))
    throw new Error("Remote workspace requires an absolute POSIX path");
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  const argv = p.target.container
    ? [
        "docker",
        "exec",
        "-i",
        "-w",
        p.cwd,
        p.target.container,
        p.command,
        ...(p.args ?? []),
      ]
    : [p.command, ...(p.args ?? [])];
  const command =
    (p.target.container ? "" : "cd " + quote(p.cwd) + " && ") +
    argv.map(quote).join(" ");
  return {
    config: {
      command: "ssh",
      args: ["-T", "-o", "BatchMode=yes", "--", p.target.host, command],
      cwd: process.cwd(),
      timeoutMs: p.timeoutMs,
    },
    rootUri: "file://" + p.cwd.split("/").map(encodeURIComponent).join("/"),
    remote: true,
  };
}
/** LSP uses byte-count framing, MCP stdio uses one JSON object per line. */
export class RpcProcess extends EventEmitter {
  private child: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private closed = false;
  constructor(
    readonly config: ServerConfig,
    readonly framing: "lsp" | "lines",
  ) {
    super();
    this.child = spawn(config.command, config.args ?? [], {
      cwd: config.cwd,
      env: { ...process.env, ...config.env },
      shell: false,
      windowsHide: true,
      stdio: "pipe",
    });
    this.child.stdout.on("data", (data: Buffer) => {
      try {
        this.consume(data);
      } catch (error) {
        this.fail(error as Error);
        this.child.kill();
      }
    });
    this.child.stderr.on("data", (data) => this.emit("log", String(data)));
    this.child.on("error", (error) => this.fail(error));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.on("exit", (code) =>
      this.fail(new Error("Server exited " + code)),
    );
  }
  private fail(error: Error) {
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
  }
  private consume(data: Buffer) {
    this.buffer = Buffer.concat([this.buffer, data]);
    if (this.buffer.length > 32 * 1024 * 1024)
      throw new Error("Server message too large");
    while (this.buffer.length) {
      let payload: Buffer;
      if (this.framing === "lines") {
        const n = this.buffer.indexOf(10);
        if (n < 0) return;
        payload = this.buffer.subarray(0, n);
        this.buffer = this.buffer.subarray(n + 1);
        if (!payload.length) continue;
      } else {
        const end = this.buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const match = /Content-Length:\s*(\d+)/i.exec(
          this.buffer.subarray(0, end).toString(),
        );
        if (!match) throw new Error("Invalid LSP header");
        const length = Number(match[1]);
        if (length > 32 * 1024 * 1024)
          throw new Error("Server message too large");
        if (this.buffer.length < end + 4 + length) return;
        payload = this.buffer.subarray(end + 4, end + 4 + length);
        this.buffer = this.buffer.subarray(end + 4 + length);
      }
      const m = JSON.parse(payload.toString("utf8"));
      if (m.method && m.id !== undefined) {
        // safe answers for server-initiated configuration; never auto-apply edits
        const result =
          m.method === "workspace/configuration"
            ? (m.params?.items ?? []).map(() => null)
            : m.method === "workspace/applyEdit"
              ? {
                  applied: false,
                  failureReason: "Apply edits through reviewed editor changes",
                }
              : null;
        this.send({ jsonrpc: "2.0", id: m.id, result });
        this.emit("request", m);
      } else if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        if (p) {
          this.pending.delete(m.id);
          clearTimeout(p.timer);
          m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
        }
      } else this.emit("notification", m);
    }
  }
  private send(message: unknown) {
    if (this.closed) throw new Error("Server is closed");
    const body = Buffer.from(JSON.stringify(message));
    this.child.stdin.write(
      this.framing === "lsp"
        ? Buffer.concat([
            Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),
            body,
          ])
        : Buffer.concat([body, Buffer.from("\n")]),
    );
  }
  notify(method: string, params?: unknown) {
    this.send({ jsonrpc: "2.0", method, params });
  }
  request(method: string, params?: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(method + " timed out"));
      }, this.config.timeoutMs ?? 30000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  close() {
    this.fail(new Error("Server closed"));
    this.child.kill();
  }
}
export const languageServers = [
  {
    languages: ["python"],
    id: "pyright",
    command: "pyright-langserver",
    args: ["--stdio"],
    source: "https://github.com/microsoft/pyright",
  },
  {
    languages: ["c", "cpp"],
    id: "clangd",
    command: "clangd",
    args: [],
    source: "https://github.com/clangd/clangd",
  },
  {
    languages: ["cmake"],
    id: "cmake",
    command: "cmake-language-server",
    args: [],
    source: "https://github.com/regen100/cmake-language-server",
  },
  {
    languages: ["typescript", "javascript"],
    id: "typescript",
    command: "typescript-language-server",
    args: ["--stdio"],
    source:
      "https://github.com/typescript-language-server/typescript-language-server",
  },
  {
    languages: ["rust"],
    id: "rust-analyzer",
    command: "rust-analyzer",
    args: [],
    source: "https://github.com/rust-lang/rust-analyzer",
  },
  {
    languages: ["kotlin"],
    id: "kotlin",
    command: "kotlin-lsp",
    args: ["--stdio"],
    source: "https://github.com/Kotlin/kotlin-lsp",
  },
  {
    languages: ["java"],
    id: "jdtls",
    command: "jdtls",
    args: [],
    source: "https://github.com/eclipse-jdtls/eclipse.jdt.ls",
  },
  {
    languages: ["groovy", "gradle"],
    id: "groovy",
    command: "java",
    args: ["-jar", "groovy-language-server-all.jar"],
    source: "https://github.com/GroovyLanguageServer/groovy-language-server",
  },
] as const;

export class Extensions {
  private knowledge?: KnowledgeStore;
  private embedding?: RpcProcess;
  private vectors?: VectorIndex;
  constructor(dataDir?: string) {
    if (dataDir) {
      this.knowledge = new KnowledgeStore(resolve(dataDir, "knowledge"));
      this.vectors = new VectorIndex(
        resolve(dataDir, "knowledge", "vectors.db"),
      );
    }
  }
  private browser = new BrowserService();
  private lsp = new Map<string, RpcProcess>();
  private mcp = new Map<string, RpcProcess>();
  private diagnostics = new Map<string, unknown>();
  async handle(method: string, p: any): Promise<any> {
    if (method === "embedding.configure") {
      const rpc = new RpcProcess(
        {
          command: p.python,
          args: [
            p.script,
            "--model-dir",
            p.modelDir,
            "--root",
            p.root,
            "--revision",
            p.revision ?? "local",
            "--device",
            p.device ?? "auto",
          ],
          cwd: p.root,
          timeoutMs: 300000,
        },
        "lines",
      );
      try {
        const status = await rpc.request("embedding.status", {});
        this.embedding?.close();
        this.embedding = rpc;
        return status;
      } catch (error) {
        rpc.close();
        throw error;
      }
    }
    if (
      ["embedding.status", "embedding.pause", "embedding.resume"].includes(
        method,
      )
    )
      return this.embedding
        ? this.embedding.request(method, {})
        : {
            ready: false,
            fallback: "keyword",
            reason: "Configure a local embedding worker",
          };
    if (method === "embedding.index") {
      if (!this.embedding || !this.knowledge || !this.vectors)
        throw new Error("Configure embedding and knowledge storage");
      const source = this.knowledge.handle("knowledge.read", {
        id: p.sourceId,
      });
      const response = await this.embedding.request("embedding.embed", {
        purpose: "document",
        items: [
          p.imagePath
            ? { kind: "image", path: p.imagePath }
            : {
                kind: p.kind ?? "text",
                title: source.title,
                text: source.text,
              },
        ],
      });
      const usage = this.knowledge.handle("knowledge.usage", {});
      if (usage.bytes + 65536 > usage.limit)
        throw new Error(
          "Collection quota reached; embedding cache write paused",
        );
      this.vectors.put(source.id, response.fingerprint, response.vectors[0]);
      return {
        sourceId: source.id,
        fingerprint: response.fingerprint,
        dimensions: 768,
      };
    }
    if (method === "semantic.search") {
      if (!this.knowledge) throw new Error("Knowledge storage not configured");
      const keyword = this.knowledge.handle("knowledge.search", p);
      if (!this.embedding || !this.vectors)
        return {
          mode: "keyword",
          reason: "Embedding not configured",
          results: keyword,
        };
      try {
        const response = await this.embedding.request("embedding.embed", {
          purpose: "query",
          items: [{ kind: p.kind ?? "text", text: p.query }],
        });
        const ids = this.knowledge.handle("knowledge.ids", {
          projectId: p.projectId,
        });
        const matches = this.vectors.search(
          response.fingerprint,
          response.vectors[0],
          new Set(ids),
        );
        return {
          mode: "hybrid",
          fingerprint: response.fingerprint,
          results: matches.map((m) => ({
            ...this.knowledge!.handle("knowledge.metadata", { id: m.id }),
            similarity: m.score,
          })),
          keyword,
        };
      } catch (error) {
        return { mode: "keyword", reason: String(error), results: keyword };
      }
    }
    if (method.startsWith("git.")) return handleGit(method, p);
    if (method.startsWith("browser.")) return this.browser.handle(method, p);
    if (method.startsWith("knowledge.") || method.startsWith("assets.")) {
      if (!this.knowledge)
        throw new Error("Knowledge storage directory is not configured");
      return this.knowledge.handle(method, p);
    }
    if (method === "lsp.catalog") return languageServers;
    if (method === "lsp.start") {
      const launch = serverLaunch(p);
      const rpc = new RpcProcess(launch.config, "lsp");
      rpc.on("notification", (message: any) => {
        if (message.method === "textDocument/publishDiagnostics")
          this.diagnostics.set(p.id + "|" + message.params.uri, message.params);
      });
      try {
        const result = await rpc.request("initialize", {
          processId: launch.remote ? null : process.pid,
          rootUri: launch.rootUri,
          workspaceFolders: [{ uri: launch.rootUri, name: "workspace" }],
          capabilities: {
            textDocument: {
              synchronization: { didSave: true },
              completion: { completionItem: { snippetSupport: false } },
            },
            workspace: { configuration: true },
          },
        });
        rpc.notify("initialized", {});
        this.lsp.get(p.id)?.close();
        this.lsp.set(p.id, rpc);
        return result;
      } catch (error) {
        rpc.close();
        throw error;
      }
    }
    if (method === "lsp.stop") {
      this.lsp.get(p.id)?.close();
      this.lsp.delete(p.id);
      return { stopped: true };
    }
    if (method === "lsp.diagnostics")
      return [...this.diagnostics.entries()]
        .filter(([key]) => key.startsWith(p.id + "|"))
        .map(([, value]) => value);
    if (method === "lsp.notify" || method === "lsp.request") {
      const rpc = this.lsp.get(p.id);
      if (!rpc) throw new Error("Language server is not running");
      return method === "lsp.request"
        ? rpc.request(p.method, p.params)
        : (rpc.notify(p.method, p.params), { sent: true });
    }
    if (method === "mcp.connect") {
      const rpc = new RpcProcess(p as ServerConfig, "lines");
      try {
        const result = await rpc.request("initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "hpharness", version: "0.1.0" },
        });
        if (
          !["2025-06-18", "2024-11-05", "2025-03-26"].includes(
            result.protocolVersion,
          )
        )
          throw new Error("Unsupported MCP protocol version");
        rpc.notify("notifications/initialized", {});
        this.mcp.get(p.id)?.close();
        this.mcp.set(p.id, rpc);
        return result;
      } catch (error) {
        rpc.close();
        throw error;
      }
    }
    if (method === "mcp.list") return [...this.mcp.keys()];
    if (method === "mcp.disconnect") {
      this.mcp.get(p.id)?.close();
      this.mcp.delete(p.id);
      return { disconnected: true };
    }
    if (method === "mcp.tools" || method === "mcp.call") {
      const rpc = this.mcp.get(p.id);
      if (!rpc) throw new Error("MCP server is not connected");
      return rpc.request(
        method === "mcp.tools" ? "tools/list" : "tools/call",
        method === "mcp.tools"
          ? {}
          : { name: p.name, arguments: p.arguments ?? {} },
      );
    }
    throw new Error("Unknown extension method " + method);
  }
  close() {
    for (const rpc of [...this.lsp.values(), ...this.mcp.values()]) rpc.close();
    this.embedding?.close();
    this.vectors?.close();
    this.lsp.clear();
    this.mcp.clear();
    this.knowledge?.close();
  }
}
