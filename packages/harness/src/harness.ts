import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { promises as fs } from "node:fs";
import { Store } from "./store.js";
import { Configuration } from "./config.js";
import { compact, repairToolHistory } from "./context.js";
import { CoreManager } from "./core.js";
import { Workspace, hash } from "./workspace.js";
import { Extensions } from "@hpharness/extensions";
import {
  Approval,
  Message,
  ModelInvoke,
  Notify,
  Project,
  RpcError,
  Run,
  Session,
  Settings,
  Target,
  ToolCall,
} from "./types.js";

const schema = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({ type: "object", properties, required, additionalProperties: false });
const str = { type: "string" };
const extensionReadMethods = new Set([
  "knowledge.search",
  "semantic.search",
  "knowledge.read",
  "knowledge.usage",
  "assets.list",
  "browser.status",
  "browser.result.get",
  "mcp.list",
  "mcp.tools",
  "worker.jobs.status",
  "worker.docker.list",
  "worker.adb.devices",
  "worker.gpu.status",
  "worker.jobs.list",
  "worker.sdk.list",
  "worker.office.ppt_templates",
  "worker.office.word_read",
  "worker.office.excel_read",
  "worker.desktop.windows",
  "worker.desktop.read",
]);
const extensionWriteMethods = new Set([
  "knowledge.ingest",
  "assets.create",
  "assets.version",
  "assets.link",
  "browser.command",
  "mcp.call",
  "worker.jobs.start",
  "worker.jobs.cancel",
  "worker.docker.create",
  "worker.adb.run",
  "worker.gpu.submit",
  "worker.gpu.cancel",
  "worker.sdk.register",
  "worker.sdk.run",
  "worker.outlook.fetch",
  "worker.outlook.attachment",
  "worker.office.edit",
  "worker.docker.start",
  "worker.gpu.upload",
  "worker.gpu.download",
  "worker.office.ppt_add",
  "worker.desktop.lease",
  "worker.desktop.action",
  "worker.desktop.revoke",
]);
export const tools = [
  {
    name: "agents_delegate",
    description:
      "Delegate a subtask to a child agent in the same target and workspace, then wait without occupying an agent slot. Child results retain their own conversation and provenance.",
    parameters: schema({ input: str, title: str }, ["input"]),
  },
  {
    name: "extension_call",
    description:
      "Invoke a configured integration. Read methods: " +
      [...extensionReadMethods].join(", ") +
      ". Other supported actions require individual approval: " +
      [...extensionWriteMethods].join(", ") +
      ". Desktop lease approval authorizes actions on that window until expiry or user input; actions/revoke do not ask again. Process launch configuration is user-only.",
    parameters: schema(
      { method: str, params: { type: "object", additionalProperties: true } },
      ["method", "params"],
    ),
  },
  {
    name: "instructions_list",
    description:
      "Read applicable AGENTS.md instructions from workspace root through a relative directory and discover local SKILL.md packages.",
    parameters: schema({ path: str }),
  },
  {
    name: "files_list",
    description: "List files in the session workspace",
    parameters: schema({ path: str }),
  },
  {
    name: "files_read",
    description: "Read a text file with a version hash",
    parameters: schema({ path: str }, ["path"]),
  },
  {
    name: "files_write",
    description:
      "Write a text file after approval; baseVersion must match last read, or null for a new file",
    parameters: schema(
      { path: str, content: str, baseVersion: { type: ["string", "null"] } },
      ["path", "content", "baseVersion"],
    ),
  },
  {
    name: "command_run",
    description:
      "Run an executable argv in the selected environment after approval. No implicit shell.",
    parameters: schema({ argv: { type: "array", items: str }, cwd: str }, [
      "argv",
    ]),
  },
  {
    name: "memory_search",
    description: "Search verified project and global knowledge",
    parameters: schema({ query: str }, ["query"]),
  },
  {
    name: "knowledge_search",
    description: "Search collected source documents with original provenance",
    parameters: schema({ query: str }, ["query"]),
  },
  {
    name: "artifact_read",
    description: "Read a bounded page from an original tool result using its artifact id; offset and limit are character counts.",
    parameters: schema({ id: str, offset: { type: "integer" }, limit: { type: "integer" } }, ["id"]),
  },
  {
    name: "memory_remember",
    description:
      "Propose a candidate memory with provenance. Only explicit user confirmation promotes it to shared project knowledge.",
    parameters: schema(
      {
        content: str,
        kind: {
          type: "string",
          enum: ["fact", "preference", "decision", "candidate"],
        },
        source: str,
      },
      ["content", "kind", "source"],
    ),
  },
];

async function defaultModel(
  config: any,
  messages: Message[],
  tools: any[],
  signal: AbortSignal,
) {
  const { complete } = await import("@hpharness/providers");
  const protocol =
    config.protocol === "openai-compatible"
      ? "chat-completions"
      : config.protocol;
  const reply = await complete(
    { ...config, protocol, apiKeyPath: config.apiKeyPath ?? config.apiKeyFile },
    { messages, tools, signal },
  );
  return {
    text: reply.message.content,
    toolCalls: reply.message.toolCalls,
    providerData: reply.message.providerData,
    usage: reply.usage,
  };
}

export class Harness {
  readonly store: Store;
  readonly config: Configuration;
  readonly core: CoreManager;
  readonly workspace: Workspace;
  readonly extensions: Extensions;
  private live = new Map<
    string,
    { run: Run; abort: AbortController; steering: string[] }
  >();
  private waiting = new Map<
    string,
    { resolve: (allowed: boolean) => void; runId: string }
  >();
  private running = 0;
  private modelActive = 0;
  private modelWaiters: Array<() => void> = [];
  private resumeWaiters: Array<() => void> = [];
  private closing = false;
  private fileWrites: Promise<unknown> = Promise.resolve();
  private coreWrites: Promise<unknown> = Promise.resolve();
  private collectionWrites: Promise<unknown> = Promise.resolve();
  private desktopLeases = new Map<string, string>();
  private budgets = new Map<string, { steps: number; tokens: number; maxSteps?: number; maxTokens?: number; deadline?: number }>();
  constructor(
    readonly dataDir: string,
    private notify: Notify = () => {},
    private invoke: ModelInvoke = defaultModel,
  ) {
    this.store = new Store(join(dataDir, "harness.sqlite"));
    this.config = new Configuration(join(dataDir, "settings.yaml"));
    this.core = new CoreManager((event, data) => this.emit(event, data));
    this.workspace = new Workspace(() => this.config.value, dataDir);
    this.extensions = new Extensions(dataDir);
    for (const run of this.store.list<Run>("run"))
      if (
        ["running", "queued", "waiting_approval", "waiting_child"].includes(
          run.status,
        )
      ) {
        run.status = "interrupted";
        run.error =
          "Supervisor restarted; inspect prior external effects before resuming.";
        this.store.put("run", run);
        this.store.event("run.interrupted", run);
      }
    for (const approval of this.store.list<Approval>("approval"))
      if (approval.status === "pending") {
        approval.status = "cancelled";
        this.store.put("approval", approval);
      }
  }
  async start() {
    const active = this.store.get<any>("core-state", "active");
    try {
      if (active?.path && hash(await fs.readFile(active.path, "utf8")) !== active.hash)
        throw new Error("Persisted core candidate changed");
      await this.core.load(active?.path);
    } catch (error) {
      await this.core.load();
      this.store.put("core-state", { id: "active" });
      this.emit("core.restoreFailed", { error: String(error) });
    }
    for (const proposal of this.store.list<any>("improvement")) {
      if (proposal.status === "trial" && proposal.candidatePath !== this.core.current.path) {
        proposal.status = "invalidated";
        proposal.invalidationReason = "The candidate is not the active core after restart";
        this.store.put("improvement", proposal);
      }
    }
    return this;
  }
  private async activateCore(filePath?: string, expectedHash?: string) {
    const path = filePath ? resolve(filePath) : undefined;
    const digest = path ? hash(await fs.readFile(path, "utf8")) : undefined;
    if (expectedHash && digest !== expectedHash) throw new RpcError("CANDIDATE_CHANGED", "Core changed since it was activated");
    const previous = this.core.current;
    // Retain the old generation until the durable pointer has been committed.
    if (previous) this.core.acquire(previous.id);
    try {
      const next = await this.core.load(path);
      try { this.store.put("core-state", { id: "active", ...{ path, hash: digest } }); }
      catch (error) {
        if (previous) this.core.current = previous;
        throw error;
      }
      return next;
    } finally { if (previous) await this.core.release(previous.id); }
  }
  private emit(event: string, data: unknown) {
    const saved = this.store.event(event, data);
    this.notify(event, { ...saved, data });
  }
  private require<T>(kind: string, id: unknown): T {
    if (typeof id !== "string")
      throw new RpcError("INVALID_ARGUMENT", `${kind} id required`);
    const obj = this.store.get<T>(kind, id);
    if (!obj) throw new RpcError("NOT_FOUND", `${kind} ${id}`);
    return obj;
  }
  private text(value: unknown, label: string) {
    if (typeof value !== "string" || !value.trim())
      throw new RpcError("INVALID_ARGUMENT", label + " is required");
    return value;
  }
  private target(value: any): Target {
    if (!value) return { kind: "local" };
    if (!["local", "ssh"].includes(value.kind))
      throw new RpcError("INVALID_TARGET", "Target kind must be local or ssh");
    if (
      value.kind === "ssh" &&
      (!value.host ||
        typeof value.host !== "string" ||
        /\s/.test(value.host) ||
        value.host.startsWith("-"))
    )
      throw new RpcError("INVALID_TARGET", "SSH alias required");
    if (
      value.container &&
      (typeof value.container !== "string" ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value.container))
    )
      throw new RpcError("INVALID_TARGET", "Invalid container");
    return { kind: value.kind, host: value.host, container: value.container };
  }
  private session(params: any) {
    return this.require<Session>("session", params.sessionId);
  }
  private messages(sessionId: string) {
    return this.store.messages<Message>(sessionId);
  }
  private effectiveSettings(session: Session) {
    return this.config.effective(
      session.projectId,
      session.settingsSourceId ?? session.id,
    ).value;
  }
  private cancelApprovals(runId: string) {
    for (const [id, pending] of this.waiting)
      if (pending.runId === runId) {
        const approval = this.require<Approval>("approval", id);
        approval.status = "cancelled";
        this.store.put("approval", approval);
        this.emit("approval.cancelled", approval);
        pending.resolve(false);
        this.waiting.delete(id);
      }
  }
  private addMessage(
    sessionId: string,
    role: Message["role"],
    content: string,
    extra: Partial<Message> = {},
  ) {
    const msg = {
      ...extra,
      id: randomUUID(),
      sessionId,
      role,
      content,
      createdAt: new Date().toISOString(),
    };
    this.store.put("message", msg);
    this.emit("message.added", msg);
    return msg;
  }
  async rpc(method: string, p: any = {}): Promise<any> {
    if (["core.reload", "improvements.apply", "improvements.rollback", "improvements.validate", "improvements.evaluate"].includes(method)) {
      const task = this.coreWrites.then(() => this.dispatchRpc(method, p));
      this.coreWrites = task.catch(() => {});
      return task;
    }
    return this.dispatchRpc(method, p);
  }
  private async dispatchRpc(method: string, p: any = {}): Promise<any> {
    if (!p || typeof p !== "object" || Array.isArray(p))
      throw new RpcError("INVALID_ARGUMENT", "params must be an object");
    if (method.startsWith("git.")) {
      const session = p.sessionId ? this.session(p) : undefined;
      return this.extensions.handle(
        method,
        session ? { ...p, cwd: session.cwd, target: session.target } : p,
      );
    }
    if (
      [
        "lsp.",
        "mcp.",
        "browser.",
        "knowledge.",
        "assets.",
        "embedding.",
        "semantic.",
      ].some((prefix) => method.startsWith(prefix))
    )
      return this.callExtension(method, p);
    switch (method) {
      case "ping":
        return {
          name: "hpharness",
          version: "0.1.0",
          pid: process.pid,
          core: this.core.status(),
          dataDir: this.dataDir,
        };
      case "projects.list":
        return this.store.list<Project>("project");
      case "projects.create": {
        const target = this.target(p.target);
        const root = this.text(p.root, "root");
        if (target.kind === "local" && !target.container) {
          const stat = await fs.stat(root);
          if (!stat.isDirectory())
            throw new RpcError("INVALID_ARGUMENT", "root must be a directory");
        }
        const project: Project = {
          id: randomUUID(),
          name: this.text(p.name, "name"),
          root:
            target.kind === "local" && !target.container ? resolve(root) : root,
          target,
          createdAt: new Date().toISOString(),
        };
        this.store.put("project", project);
        this.emit("project.created", project);
        return project;
      }
      case "sessions.list":
        return this.store
          .list<Session>("session")
          .filter((s) => !p.projectId || s.projectId === p.projectId);
      case "sessions.create": {
        const project = this.require<Project>("project", p.projectId);
        const session: Session = {
          id: randomUUID(),
          projectId: project.id,
          title: p.title || "새 작업",
          target: this.target(p.target ?? project.target),
          cwd: p.cwd ?? project.root,
          createdAt: new Date().toISOString(),
        };
        this.store.put("session", session);
        this.emit("session.created", session);
        return session;
      }
      case "sessions.fork": {
        const original = this.session(p);
        const session: Session = {
          ...original,
          id: randomUUID(),
          title: p.title ?? original.title + " · 분기",
          parentId: original.id,
          createdAt: new Date().toISOString(),
        };
        const messages = this.messages(original.id);
        const stop = p.messageId
          ? messages.findIndex((m) => m.id === p.messageId)
          : messages.length - 1;
        if (stop < 0)
          throw new RpcError("NOT_FOUND", "Branch message not found");
        this.store.put("session", session);
        for (const m of repairToolHistory(messages.slice(0, stop + 1)))
          this.addMessage(session.id, m.role, m.content, {
            toolCalls: m.toolCalls,
            toolCallId: m.toolCallId,
            providerData: m.providerData,
          });
        this.emit("session.forked", {
          session,
          source: original.id,
          messageId: p.messageId,
        });
        return session;
      }
      case "sessions.update": {
        const s = this.session(p);
        if (
          [...this.live.values()].some(
            (x) =>
              x.run.sessionId === s.id &&
              !["completed", "failed", "cancelled"].includes(x.run.status),
          )
        )
          throw new RpcError(
            "BUSY",
            "Execution target is fixed while work is running",
          );
        if (p.target) s.target = this.target(p.target);
        if (p.cwd) s.cwd = this.text(p.cwd, "cwd");
        if (p.title) s.title = this.text(p.title, "title");
        this.store.put("session", s);
        return s;
      }
      case "messages.list":
        return this.messages(this.session(p).id);
      case "runs.start":
        return this.enqueue(this.session(p), this.text(p.input, "input"));
      case "runs.resume": {
        const previous = this.require<Run>("run", p.runId);
        if (previous.status !== "interrupted") throw new RpcError("INVALID_STATE", "Only interrupted runs can be resumed");
        const next = this.enqueue(this.require<Session>("session", previous.sessionId), this.text(p.input, "input"));
        const live = this.live.get(next.id)!;
        live.run.resumedFrom = previous.id;
        this.store.put("run", live.run);
        return live.run;
      }
      case "runs.status":
        return p.runId
          ? this.require<Run>("run", p.runId)
          : this.store
              .list<Run>("run")
              .filter((r) => !p.sessionId || r.sessionId === p.sessionId);
      case "runs.steer": {
        const live = this.live.get(p.runId);
        if (!live) throw new RpcError("NOT_FOUND", "Active run not found");
        const input = this.text(p.input, "input");
        live.steering.push(input);
        this.emit("run.steeringQueued", { runId: p.runId, input });
        return { queued: true };
      }
      case "runs.cancel": {
        const run = this.require<Run>("run", p.runId);
        if (["completed", "failed", "cancelled", "interrupted"].includes(run.status)) return run;
        const live = this.live.get(run.id);
        live?.abort.abort();
        this.cancelApprovals(run.id);
        if (live?.run.status === "queued") {
          await this.core.release(live.run.generation);
          this.live.delete(run.id);
          this.budgets.delete(run.id);
        }
        run.status = "cancelled";
        if (live) live.run.status = "cancelled";
        this.store.put("run", run);
        this.emit("run.changed", run);
        return run;
      }
      case "approvals.list":
        return this.store
          .list<Approval>("approval")
          .filter((a) => (!p.all ? a.status === "pending" : true));
      case "approvals.resolve": {
        const a = this.require<Approval>("approval", p.id);
        const pending = this.waiting.get(a.id);
        if (a.status !== "pending" || !pending)
          throw new RpcError("STALE_APPROVAL", "Approval is no longer active");
        if (typeof p.approved !== "boolean")
          throw new RpcError("INVALID_ARGUMENT", "approved must be boolean");
        a.status = p.approved ? "approved" : "denied";
        this.store.put("approval", a);
        this.emit("approval.resolved", a);
        pending.resolve(p.approved);
        this.waiting.delete(a.id);
        return a;
      }
      case "core.status":
        return this.core.status();
      case "core.reload": {
        const old = this.core.current.id;
        const next = await this.activateCore(p.filePath);
        if (p.migrateActive)
          for (const live of this.live.values())
            if (live.run.status !== "queued") {
              live.run.pendingGeneration = next.id;
              live.run.migrationDeadline =
                Date.now() + (p.timeoutMs ?? 120_000);
              this.store.put("run", live.run);
            }
        this.emit("core.reload", {
          from: old,
          to: next.id,
          migrateActive: !!p.migrateActive,
        });
        return this.core.status();
      }
      case "settings.get":
        this.config.reload();
        return {
          ...this.config.value,
          configPath: this.config.path,
          configError: this.config.error,
        };
      case "settings.effective": {
        const session = p.sessionId ? this.session(p) : undefined;
        return {
          ...this.config.effective(
            session?.projectId ?? p.projectId,
            session?.id,
          ),
          configPath: this.config.path,
        };
      }
      case "settings.update": {
        let input = p.settings ?? p;
        if (p.sessionId) {
          this.session(p);
          input = {
            sessionOverrides: {
              ...this.config.value.sessionOverrides,
              [p.sessionId]: {
                ...this.config.value.sessionOverrides?.[p.sessionId],
                ...input,
              },
            },
          };
        } else if (p.projectId) {
          this.require("project", p.projectId);
          input = {
            projectOverrides: {
              ...this.config.value.projectOverrides,
              [p.projectId]: {
                ...this.config.value.projectOverrides?.[p.projectId],
                ...input,
              },
            },
          };
        }
        const settings = this.config.update(input);
        this.emit("settings.changed", { configPath: this.config.path });
        return settings;
      }
      case "settings.reload":
        this.config.reload();
        return { ...this.config.value, configError: this.config.error };
      case "memory.list":
      case "memory.search":
        return this.store.memoryList(p.projectId, p.query ?? "");
      case "memory.upsert": {
        const memory = this.store.memoryUpsert({
          ...p,
          content: this.text(p.content, "content"),
          confirmed: p.kind !== "candidate",
        });
        this.emit("memory.changed", memory);
        return memory;
      }
      case "memory.confirm": {
        const previous = this.store.memoryGet(this.text(p.id, "id"));
        if (!previous) throw new RpcError("NOT_FOUND", "Memory not found");
        const memory = this.store.memoryUpsert({
          id: String(previous.id), projectId: previous.projectId == null ? undefined : String(previous.projectId),
          content: String(previous.content), source: String(previous.source),
          kind: previous.kind === "candidate" ? "fact" : String(previous.kind), confirmed: true,
        });
        this.emit("memory.changed", memory);
        return memory;
      }
      case "memory.delete": {
        const result = this.store.memoryDelete(this.text(p.id, "id"));
        this.emit("memory.deleted", result);
        return result;
      }
      case "artifacts.read":
        return this.readArtifact(p);
      case "improvements.list":
        return this.store.list<any>("improvement");
      case "improvements.propose": {
        const proposal = {
          id: randomUUID(),
          title: this.text(p.title, "title"),
          scope: this.text(p.scope, "scope"),
          validation: this.text(p.validation, "validation"),
          rollback: this.text(p.rollback, "rollback"),
          filePath: this.text(p.filePath, "filePath"),
          changesPermissions: !!p.changesPermissions,
          changesStorage: !!p.changesStorage,
          status: "proposed",
          evaluation: "unknown",
          createdAt: new Date().toISOString(),
        };
        this.store.put("improvement", proposal);
        this.emit("improvement.proposed", proposal);
        return proposal;
      }
      case "improvements.approve": {
        const proposal = this.require<any>("improvement", p.id);
        if (proposal.status !== "proposed")
          throw new RpcError("INVALID_STATE", "Proposal must be pending");
        proposal.status = p.approved === true ? "approved" : "rejected";
        proposal.approvedAt = new Date().toISOString();
        this.store.put("improvement", proposal);
        this.emit("improvement.reviewed", proposal);
        return proposal;
      }
      case "improvements.validate": {
        const proposal = this.require<any>("improvement", p.id);
        if (proposal.status !== "approved")
          throw new RpcError(
            "APPROVAL_REQUIRED",
            "Approve proposal before candidate validation",
          );
        const source = await fs.readFile(proposal.filePath, "utf8");
        const digest = hash(source);
        const folder = join(this.dataDir, "core-candidates");
        await fs.mkdir(folder, { recursive: true });
        const candidatePath = join(folder, proposal.id + "-" + digest + ".mjs");
        await fs.writeFile(candidatePath, source);
        await this.core.load(candidatePath, false);
        proposal.candidatePath = candidatePath;
        proposal.candidateHash = digest;
        proposal.validationEvidence = this.text(p.evidence, "evidence");
        proposal.validatedAt = new Date().toISOString();
        this.store.put("improvement", proposal);
        this.emit("improvement.validated", proposal);
        return proposal;
      }
      case "improvements.apply": {
        const proposal = this.require<any>("improvement", p.id);
        if (proposal.status !== "approved")
          throw new RpcError(
            "APPROVAL_REQUIRED",
            "Approve this proposal before applying",
          );
        if (!proposal.candidateHash || !proposal.candidatePath)
          throw new RpcError(
            "VALIDATION_REQUIRED",
            "Validate an immutable candidate and record test evidence first",
          );
        if (
          hash(await fs.readFile(proposal.filePath, "utf8")) !==
            proposal.candidateHash ||
          hash(await fs.readFile(proposal.candidatePath, "utf8")) !==
            proposal.candidateHash
        )
          throw new RpcError(
            "CANDIDATE_CHANGED",
            "Candidate changed after validation; validate again",
          );
        const previous = this.core.current;
        const previousHash = this.store.get<any>("core-state", "active")?.hash;
        const next = await this.activateCore(proposal.candidatePath, proposal.candidateHash);
        proposal.previousCorePath = previous.path;
        proposal.previousCoreHash = previousHash;
        proposal.previousCoreVersion = previous.core.version;
        proposal.appliedGeneration = next.id;
        proposal.status = "trial";
        proposal.appliedAt = new Date().toISOString();
        this.store.put("improvement", proposal);
        this.emit("improvement.applied", proposal);
        return proposal;
      }
      case "improvements.evaluate": {
        const proposal = this.require<any>("improvement", p.id);
        if (proposal.status !== "trial" || proposal.candidatePath !== this.core.current.path)
          throw new RpcError(
            "INVALID_STATE",
            "Apply the proposal before evaluation",
          );
        if (!["better", "same", "worse", "unknown"].includes(p.evaluation))
          throw new RpcError(
            "INVALID_ARGUMENT",
            "Evaluation must be better, same, worse or unknown",
          );
        proposal.evaluation = p.evaluation;
        proposal.feedback = p.feedback ?? "";
        this.store.put("improvement", proposal);
        this.emit("improvement.evaluated", proposal);
        return proposal;
      }
      case "improvements.rollback": {
        const proposal = this.require<any>("improvement", p.id);
        if (proposal.status !== "trial" || proposal.candidatePath !== this.core.current.path)
          throw new RpcError(
            "INVALID_STATE",
            "Only an applied proposal can be rolled back",
          );
        await this.activateCore(proposal.previousCorePath, proposal.previousCoreHash);
        proposal.status = "rolled_back";
        this.store.put("improvement", proposal);
        this.emit("improvement.rolledBack", {
          ...proposal,
          externalEffectsReverted: false,
        });
        return proposal;
      }
      case "files.list":
        return this.workspace.list(this.session(p), p.path);
      case "files.read":
        return this.workspace.read(this.session(p), this.text(p.path, "path"));
      case "files.preview":
        return this.workspace.preview(
          this.session(p),
          this.text(p.path, "path"),
        );
      case "files.write":
        return this.serialWrite(() =>
          this.workspace.write(
            this.session(p),
            this.text(p.path, "path"),
            String(p.content ?? ""),
            p.baseVersion ?? null,
          ),
        );
      case "command.run": {
        const session = this.session(p);
        this.emit("command.started", {
          sessionId: session.id,
          argv: p.argv,
          cwd: p.cwd,
        });
        const result = await this.workspace.command(session, p.argv, p.cwd);
        this.emit("command.completed", { sessionId: session.id, result });
        return result;
      }
      case "worker.call": {
        const session = this.session(p);
        return this.callWorker(
          session,
          this.text(p.method, "method"),
          p.params ?? {},
        );
      }
      case "events.list":
        return this.store.events(p.after ?? 0);
      case "data.export":
        return {
          schemaVersion: 1,
          projects: this.store.list("project"),
          sessions: this.store.list("session"),
          messages: this.store.list("message"),
          runs: this.store.list("run"),
          memory: this.store.memoryList(),
          settings: this.config.value,
        };
      default:
        throw new RpcError("METHOD_NOT_FOUND", method);
    }
  }
  private serialWrite<T>(fn: () => Promise<T>) {
    const task = this.fileWrites.then(fn, fn);
    this.fileWrites = task.catch(() => {});
    return task;
  }
  private collectionWrite<T>(fn: () => Promise<T>) {
    const task = this.collectionWrites.then(fn, fn);
    this.collectionWrites = task.catch(() => {});
    return task;
  }
  private callExtension(method: string, params: any) {
    const invoke = () => this.extensions.handle(method, params);
    return ["knowledge.ingest", "assets.create", "assets.version", "assets.link", "embedding.index"].includes(method)
      ? this.collectionWrite(invoke) : invoke();
  }
  private callWorker(session: Session, method: string, params: Record<string, unknown>, signal?: AbortSignal) {
    const invoke = () => this.workspace.remote(session, method, params, signal);
    return ["outlook.fetch", "outlook.attachment"].includes(method) ? this.collectionWrite(invoke) : invoke();
  }
  private async saveArtifact(content: string, sessionId: string, kind: string) {
    const id = randomUUID();
    const folder = join(this.dataDir, "artifacts");
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(join(folder, id + ".txt"), content, "utf8");
    this.store.put("artifact", { id, ...{ sessionId, kind, chars: content.length, sha256: hash(content) } });
    return id;
  }
  private async readArtifact(p: any, sessionId?: string) {
    const record = this.require<any>("artifact", p.id);
    if (sessionId && record.sessionId !== sessionId) throw new RpcError("NOT_FOUND", "Artifact is outside this session");
    const offset = p.offset ?? 0, limit = p.limit ?? 8000;
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 16000)
      throw new RpcError("INVALID_ARGUMENT", "offset must be nonnegative and limit must be 1..16000");
    const text = await fs.readFile(join(this.dataDir, "artifacts", record.id + ".txt"), "utf8");
    return { id: record.id, offset, totalChars: text.length, content: text.slice(offset, offset + limit), nextOffset: offset + limit < text.length ? offset + limit : null };
  }
  private async boundedResult(result: unknown, session: Session) {
    const serialized = JSON.stringify(result) ?? "null";
    const limit = Math.max(256, Math.min(12000, Math.floor((this.effectiveSettings(session).contextMaxChars ?? 60000) / 4)));
    if (serialized.length <= limit) return result;
    const artifactId = await this.saveArtifact(serialized, session.id, "tool-result");
    return { truncated: true, artifactId, originalChars: serialized.length, preview: serialized.slice(0, Math.floor(limit / 2)), readWith: "artifact_read" };
  }
  enqueue(session: Session, input: string, parent?: Run) {
    const run: Run = {
      id: randomUUID(),
      sessionId: session.id,
      status: "queued",
      generation: this.core.current.id,
      step: 0,
      input,
      createdAt: new Date().toISOString(),
      parentRunId: parent?.id,
    };
    this.core.acquire(run.generation);
    const settings = this.effectiveSettings(session);
    this.budgets.set(run.id, parent ? this.budgets.get(parent.id)! : {
      steps: 0, tokens: 0, maxSteps: settings.maxSteps, maxTokens: settings.maxTokens,
    });
    this.store.put("run", run);
    this.live.set(run.id, { run, abort: new AbortController(), steering: [] });
    this.emit("run.queued", run);
    queueMicrotask(() => this.pump());
    return structuredClone(run);
  }
  private pump() {
    if (this.closing) return;
    while (
      this.resumeWaiters.length &&
      this.running < this.config.value.maxAgents
    ) {
      this.running++;
      this.resumeWaiters.shift()!();
    }
    const busy = new Set(
      [...this.live.values()]
        // A cancelled execution still owns the session until its effects and
        // cleanup have settled and execute's finally removes it from live.
        .filter((x) => x.run.status !== "queued")
        .map((x) => x.run.sessionId),
    );
    for (const live of this.live.values())
      if (
        this.running < this.config.value.maxAgents &&
        live.run.status === "queued" &&
        !busy.has(live.run.sessionId)
      ) {
        busy.add(live.run.sessionId);
        this.running++;
        live.run.status = "running";
        void this.execute(live).finally(() => {
          this.running--;
          this.live.delete(live.run.id);
          this.budgets.delete(live.run.id);
          this.pump();
        });
      }
  }
  private async model<T>(fn: () => Promise<T>): Promise<T> {
    if (this.modelActive >= this.config.value.maxModelRequests)
      await new Promise<void>((r) => this.modelWaiters.push(r));
    this.modelActive++;
    try {
      return await fn();
    } finally {
      this.modelActive--;
      this.modelWaiters.shift()?.();
    }
  }
  private async approval(run: Run, session: Session, call: ToolCall, signal: AbortSignal) {
    if (signal.aborted) throw new RpcError("CANCELLED", "Run cancelled");
    const a: Approval = {
      id: randomUUID(),
      runId: run.id,
      tool: call.name,
      arguments: structuredClone(call.arguments),
      target: structuredClone(session.target),
      cwd: session.cwd,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    run.status = "waiting_approval";
    this.store.put("run", run);
    this.store.put("approval", a);
    const decision = new Promise<boolean>((resolve) =>
      this.waiting.set(a.id, { resolve, runId: run.id }),
    );
    this.emit("approval.requested", a);
    const allowed = await decision;
    run.status = signal.aborted ? "cancelled" : "running";
    this.store.put("run", run);
    return allowed;
  }
  private async tool(
    run: Run,
    session: Session,
    call: ToolCall,
    signal: AbortSignal,
  ) {
    if (signal.aborted) throw new RpcError("CANCELLED", "Run cancelled");
    const p = call.arguments;
    const settings = this.effectiveSettings(session);
    if (!p || typeof p !== "object")
      throw new RpcError("INVALID_ARGUMENT", "Invalid tool arguments");
    let extensionMethod = "";
    if (call.name === "extension_call") {
      extensionMethod = this.text(p.method, "method");
      if (
        !extensionReadMethods.has(extensionMethod) &&
        !extensionWriteMethods.has(extensionMethod)
      )
        throw new RpcError(
          "METHOD_NOT_ALLOWED",
          "Integration method is not exposed to the model: " + extensionMethod,
        );
    }
    if (
      (call.name === "command_run" && settings.permissions.command === "ask") ||
      (call.name === "files_write" && settings.permissions.write === "ask") ||
      (call.name === "extension_call" &&
        extensionWriteMethods.has(extensionMethod) &&
        !["worker.desktop.action", "worker.desktop.revoke"].includes(extensionMethod))
    )
      if (!(await this.approval(run, session, call, signal)))
        throw new RpcError("APPROVAL_DENIED", "User denied this exact action");
    if (signal.aborted) throw new RpcError("CANCELLED", "Run cancelled");
    this.emit("tool.started", {
      runId: run.id,
      call,
      target: session.target,
      cwd: session.cwd,
    });
    let result: unknown;
    switch (call.name) {
      case "agents_delegate":
        result = await this.delegate(run, session, p, signal);
        break;
      case "extension_call": {
        const params = { ...(p.params ?? {}) as Record<string, unknown> };
        if (["worker.desktop.lease", "worker.sdk.register", "worker.sdk.run", "worker.office.edit", "worker.office.ppt_add"].includes(extensionMethod)) params.approved = true;
        if (["worker.desktop.action", "worker.desktop.read", "worker.desktop.revoke"].includes(extensionMethod) &&
            this.desktopLeases.get(String(params.lease_id)) !== run.id)
          throw new RpcError("APPROVAL_REQUIRED", "Acquire a window handoff for this run first");
        if (extensionMethod.startsWith("worker."))
          result = await this.callWorker(
            session,
            extensionMethod.slice(7),
            params,
            signal,
          );
        else
          result = await this.callExtension(extensionMethod, {
            ...params,
            projectId: params.projectId ?? session.projectId,
          });
        if (extensionMethod === "worker.desktop.lease") this.desktopLeases.set((result as any).lease_id, run.id);
        break;
      }
      case "artifact_read":
        result = await this.readArtifact(p, session.id);
        break;
      case "instructions_list":
        result = await this.instructions(session, String(p.path ?? "."));
        break;
      case "files_list":
        result = await this.workspace.list(session, p.path as string);
        break;
      case "files_read":
        result = await this.workspace.read(session, this.text(p.path, "path"));
        break;
      case "files_write":
        result = await this.serialWrite(() =>
          this.workspace.write(
            session,
            this.text(p.path, "path"),
            String(p.content ?? ""),
            p.baseVersion as string | null,
          ),
        );
        break;
      case "command_run":
        result = await this.workspace.command(
          session,
          p.argv as string[],
          p.cwd as string,
          signal,
        );
        break;
      case "memory_search":
        result = this.store.memoryList(
          session.projectId,
          String(p.query ?? ""),
        );
        break;
      case "knowledge_search":
        result = await this.extensions.handle("knowledge.search", {
          projectId: session.projectId,
          query: String(p.query ?? ""),
        });
        break;
      case "memory_remember":
        result = this.store.memoryUpsert({
          projectId: session.projectId,
          content: this.text(p.content, "content"),
          kind: "candidate",
          source: `agent:${run.id}; claimed source: ${String(p.source ?? "")}`,
          confirmed: false,
        });
        break;
      default:
        throw new RpcError("UNKNOWN_TOOL", call.name);
    }
    result = await this.boundedResult(result, session);
    this.emit("tool.completed", { runId: run.id, callId: call.id, result });
    return result;
  }
  private async instructions(session: Session, path: string) {
    const segments = path
      .replaceAll("\\", "/")
      .split("/")
      .filter((x) => x && x !== ".");
    if (
      segments.some((x) => x === "..") ||
      path.startsWith("/") ||
      /^[a-z]:/i.test(path)
    )
      throw new RpcError(
        "OUTSIDE_WORKSPACE",
        "Instruction scope must be relative",
      );
    const instructions: Array<{ path: string; content: string }> = [];
    const skills: Array<{ path: string }> = [];
    for (let i = 0; i <= segments.length; i++) {
      const prefix = segments.slice(0, i).join("/");
      const file = (prefix ? prefix + "/" : "") + "AGENTS.md";
      try {
        const read = await this.workspace.read(session, file);
        instructions.push({ path: file, content: read.content });
      } catch (error: any) {
        if (!["ENOENT", "not_found", "NOT_FOUND"].includes(error.code))
          throw error;
      }
    }
    for (const folder of [".agents/skills", ".codex/skills"])
      try {
        for (const entry of await this.workspace.list(session, folder)) {
          if (!entry.isDirectory) continue;
          const file = folder + "/" + entry.name + "/SKILL.md";
          try {
            await this.workspace.read(session, file);
            skills.push({ path: file });
          } catch {}
        }
      } catch {}
    return { instructions, skills };
  }
  private async delegate(
    run: Run,
    session: Session,
    p: Record<string, unknown>,
    signal: AbortSignal,
  ) {
    let ancestor: Run | undefined = run, depth = 0;
    while (ancestor?.parentRunId) { depth++; ancestor = this.store.get<Run>("run", ancestor.parentRunId); }
    if (depth >= 4) throw new RpcError("DELEGATION_LIMIT", "Maximum delegation depth (4) reached");
    if (signal.aborted) throw new RpcError("CANCELLED", "Parent cancelled");
    const child: Session = {
      ...session,
      id: randomUUID(),
      parentId: session.id,
      settingsSourceId: session.settingsSourceId ?? session.id,
      title: String(p.title ?? "하위 작업"),
      createdAt: new Date().toISOString(),
    };
    this.store.put("session", child);
    const childRun = this.enqueue(child, this.text(p.input, "input"), run);
    this.emit("agent.delegated", {
      parentRunId: run.id,
      childRunId: childRun.id,
      childSessionId: child.id,
    });
    run.status = "waiting_child";
    this.store.put("run", run);
    this.running--;
    this.pump();
    try {
      while (this.live.has(childRun.id)) {
        if (signal.aborted) {
          await this.rpc("runs.cancel", { runId: childRun.id });
          throw new RpcError("CANCELLED", "Parent cancelled");
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      return {
        sessionId: child.id,
        run: this.require("run", childRun.id),
        messages: this.messages(child.id)
          .filter((m) => m.role === "assistant")
          .map((m) => ({ id: m.id, content: m.content })),
      };
    } finally {
      await new Promise<void>((resolve) => {
        const resume = () => {
          run.status = signal.aborted ? "cancelled" : "running";
          this.store.put("run", run);
          resolve();
        };
        if (this.closing) {
          this.running++;
          resume();
        } else {
          this.resumeWaiters.push(resume);
          this.pump();
        }
      });
    }
  }
  private async execute(live: {
    run: Run;
    abort: AbortController;
    steering: string[];
  }) {
    const { run, abort } = live;
    const session = this.require<Session>("session", run.sessionId);
    const initialSettings = this.effectiveSettings(session);
    const budget = this.budgets.get(run.id)!;
    if (!run.parentRunId && initialSettings.maxDurationMs) budget.deadline = Date.now() + initialSettings.maxDurationMs;
    const duration = budget.deadline ? Math.max(1, budget.deadline - Date.now()) : initialSettings.maxDurationMs;
    const timer = duration
      ? setTimeout(() => {
          run.error = "Configured duration limit reached";
          abort.abort(new Error(run.error));
          this.cancelApprovals(run.id);
        }, duration)
      : undefined;
    this.addMessage(session.id, "user", run.input);
    this.emit("run.changed", run);
    try {
      while (!abort.signal.aborted) {
        const settings = this.effectiveSettings(session);
        const limit = settings.maxSteps;
        if ((limit !== undefined && run.step >= limit) || (budget.maxSteps !== undefined && budget.steps >= budget.maxSteps))
          throw new RpcError("STEP_LIMIT", "Configured step limit reached");
        if (budget.maxTokens !== undefined && budget.tokens >= budget.maxTokens)
          throw new RpcError("TOKEN_LIMIT", "Configured token limit reached");
        let generation = this.core.generations.get(run.generation)!;
        if (run.pendingGeneration) {
          if (
            Date.now() <= run.migrationDeadline! &&
            this.core.generations.has(run.pendingGeneration)
          ) {
            const old = run.generation;
            generation = this.core.acquire(run.pendingGeneration);
            run.generation = generation.id;
            await this.core.release(old);
            this.emit("run.migrated", {
              runId: run.id,
              from: old,
              to: run.generation,
            });
          } else this.emit("run.migrationDeferred", { runId: run.id });
          delete run.pendingGeneration;
          delete run.migrationDeadline;
        }
        for (const input of live.steering.splice(0))
          this.addMessage(session.id, "user", input);
        const memories = this.store
          .memoryList(session.projectId)
          .filter((m: any) => m.confirmed === 1 && m.kind !== "candidate")
          .map((m: any) => String(m.content));
        let messages = repairToolHistory(this.messages(session.id));
        if (generation.core.buildContext)
          messages = generation.core.buildContext(messages, memories);
        const compressed = compact(messages, settings.contextMaxChars ?? 60000);
        if (compressed.summary)
          this.emit("context.compacted", {
            runId: run.id,
            summary: compressed.summary,
            sourceIds: compressed.sourceIds,
          });
        messages = compressed.messages;
        let instructions = "";
        try {
          instructions = (await this.workspace.read(session, "AGENTS.md"))
            .content;
        } catch {}
        const context: Message[] = compact([
          {
            id: "system",
            sessionId: session.id,
            role: "system",
            content:
              generation.core.systemPrompt +
              "\nProject knowledge:\n" +
              memories.join("\n") +
              "\nProject instructions:\n" +
              instructions,
            createdAt: new Date().toISOString(),
          },
          ...messages,
        ], settings.contextMaxChars ?? 60000).messages;
        budget.steps++;
        const result = await generation.core.nextStep({
          run: structuredClone(run),
          messages: context,
          tools,
          signal: abort.signal,
          retryLimit: settings.retryLimit,
          complete: (messages = context) =>
            this.model(async () => {
              if (abort.signal.aborted) throw new RpcError("CANCELLED", "Run cancelled");
              const outbound = compact(repairToolHistory(messages), settings.contextMaxChars ?? 60000).messages;
              const serialized = JSON.stringify(outbound);
              const artifactId = await this.saveArtifact(serialized, session.id, "context");
              if (abort.signal.aborted) throw new RpcError("CANCELLED", "Run cancelled");
              this.emit("context.sent", {
                runId: run.id, generation: run.generation,
                artifactId, messageCount: outbound.length, chars: serialized.length,
              });
              return this.invoke(
                this.config.provider(settings),
                outbound,
                tools,
                abort.signal,
              );
            }),
        });
        if (abort.signal.aborted) break;
        run.step++;
        const oldUsage = (run.usage ?? {}) as any;
        const newUsage = (result.usage ?? {}) as any;
        budget.tokens += (newUsage.inputTokens ?? 0) + (newUsage.outputTokens ?? 0);
        run.usage = {
          inputTokens:
            (oldUsage.inputTokens ?? 0) + (newUsage.inputTokens ?? 0),
          outputTokens:
            (oldUsage.outputTokens ?? 0) + (newUsage.outputTokens ?? 0),
          requests: (oldUsage.requests ?? 0) + 1,
        };
        const total =
          (run.usage as any).inputTokens + (run.usage as any).outputTokens;
        const tokenLimitReached =
          (settings.maxTokens !== undefined && total >= settings.maxTokens) ||
          (budget.maxTokens !== undefined && budget.tokens >= budget.maxTokens);
        this.addMessage(session.id, "assistant", result.text, {
          toolCalls: result.toolCalls,
          providerData: result.providerData,
        });
        for (const call of result.toolCalls ?? []) {
          let output: unknown;
          try {
            if (abort.signal.aborted) throw new RpcError("CANCELLED", "Run cancelled; no new tool action was started");
            if (tokenLimitReached || (budget.maxTokens !== undefined && budget.tokens >= budget.maxTokens))
              throw new RpcError(
                "TOKEN_LIMIT",
                "Configured token limit reached; no new tool action was started",
              );
            output = await this.tool(run, session, call, abort.signal);
          } catch (e) {
            output = { error: e instanceof Error ? e.message : String(e) };
            this.emit("tool.failed", {
              runId: run.id,
              callId: call.id,
              error: output,
            });
          }
          this.addMessage(session.id, "tool", JSON.stringify(output), {
            toolCallId: call.id,
          });
        }
        this.store.put("run", run);
        this.emit("run.checkpoint", {
          runId: run.id,
          generation: run.generation,
          step: run.step,
        });
        await generation.core.afterStep?.(structuredClone(run));
        if (tokenLimitReached || (budget.maxTokens !== undefined && budget.tokens >= budget.maxTokens))
          throw new RpcError("TOKEN_LIMIT", "Configured token limit reached");
        if (!(result.continue ?? !!result.toolCalls?.length)) {
          run.status = "completed";
          break;
        }
      }
      if (abort.signal.aborted) run.status = "cancelled";
    } catch (error) {
      run.status = abort.signal.aborted ? "cancelled" : "failed";
      run.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (timer) clearTimeout(timer);
      for (const [leaseId, owner] of this.desktopLeases) if (owner === run.id) {
        this.desktopLeases.delete(leaseId);
        try { await this.workspace.remote(session, "desktop.revoke", { lease_id: leaseId }); }
        catch (error) { this.emit("desktop.revokeFailed", { runId: run.id, leaseId, error: String(error) }); }
      }
      this.store.put("run", run);
      this.emit("run.changed", run);
      await this.core.release(run.generation);
    }
  }
  async waitForIdle(timeout = 30_000) {
    const end = Date.now() + timeout;
    while (this.live.size) {
      if (Date.now() > end) throw new Error("Timed out waiting for idle");
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  async close() {
    this.closing = true;
    for (const resume of this.resumeWaiters.splice(0)) {
      this.running++;
      resume();
    }
    for (const live of this.live.values()) live.abort.abort();
    for (const runId of new Set([...this.waiting.values()].map((w) => w.runId)))
      this.cancelApprovals(runId);
    for (const [id, live] of this.live)
      if (live.run.status === "queued") {
        live.run.status = "cancelled";
        this.store.put("run", live.run);
        await this.core.release(live.run.generation);
        this.live.delete(id);
        this.budgets.delete(id);
      }
    await this.waitForIdle();
    await this.extensions.close();
    await this.core.close();
    this.store.close();
  }
}
