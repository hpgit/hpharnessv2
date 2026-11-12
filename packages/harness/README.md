# Cordis harness

`npm run build --workspace @hpharness/harness` builds `dist/main.js`. Start it from the repository root with `node packages/harness/dist/main.js`. The JSONL client starts or reconnects to a detached local daemon; closing the client or desktop does not stop running tasks. State defaults to `~/.hpharness`, override with `--data-dir` or `HPH_DATA_DIR`. Node 24+ with `node:sqlite` is required.

The daemon descriptor is `daemon.json` in that directory. It contains a loopback TCP port and a random token. Every TCP request requires `{id,method,params,token}`. The stdio client adds the token automatically. Results are `{id,result}` or `{id,error:{code,message}}`; notifications are `{event,data:{seq,id,type,createdAt,data}}`. Never publish the descriptor or data directory.

## Core contract

Cordis is pinned to stable 3.18.1. A candidate is an ESM module exporting `apply(ctx)` and registering `ctx.set('agentCore', contract)`. `contract` provides `version`, `stateVersion: 1`, `systemPrompt`, and `async nextStep(api)`. Optional `buildContext(messages, memories)` and `afterStep(run)` hooks are supported.

`nextStep` receives immutable run snapshot, messages, available tools, AbortSignal, and `complete(messages?)`. It decides whether to call the configured model, what messages to use, which tool calls to request, and whether to continue. It returns `{text, toolCalls?, usage?, providerData?, continue?}`. Thus the actual decision algorithm can change without restarting the supervisor. The supervisor keeps durable records, grants approvals, performs effects, and records the safe checkpoint after all tool results. It never transfers an in-flight JS stack.

```js
export function apply(ctx) {
  ctx.set("agentCore", {
    version: "candidate-1",
    stateVersion: 1,
    systemPrompt: "Inspect before editing. Reply in Korean.",
    async nextStep(api) {
      const result = await api.complete();
      return { ...result, continue: Boolean(result.toolCalls?.length) };
    },
  });
}
```

Use self-contained ESM bundles or immutable versioned dependencies: only the candidate entry URL is cache-busted, not arbitrary transitive imports. Plugins execute trusted local code with the Node process's privileges; Cordis is a lifecycle framework, not a security sandbox. Permission-policy changes require an explicitly scoped improvement proposal. `core.reload` is an explicit developer operation; `improvements.*` supplies the normal proposal/approval/trial/evaluation/rollback workflow. Original events are append-only, not rewritten by rollback.

`core.reload {filePath,migrateActive:false}` pins existing work to its generation. `migrateActive:true` requests a transfer at the next checkpoint. After `timeoutMs` (default 120000), the old run stays pinned. Failed initialization leaves the current core untouched. Old contexts dispose after their last run releases ownership. Core failures are failures, not automatic proof of improvement.

## RPC groups

- `projects.list/create`, `sessions.list/create/update/fork`, `messages.list`.
- `runs.start {sessionId,input}`, `runs.status {runId?}`, `runs.steer {runId,input}`, `runs.cancel {runId}`. New input queues per session; different sessions use separate agent slots.
- `approvals.list`, `approvals.resolve {id,approved}`. Exact tool arguments and execution target are recorded; stale approvals cannot be reused.
- `files.list/read/write {sessionId,path,content?,baseVersion?}`, `files.preview {sessionId,path}` for PNG/JPEG/GIF/WebP (10 MB cap), `command.run {sessionId,argv,cwd?}`. Direct desktop editing/terminal commands are explicit user actions. Model write and command tools ask by default. An argv command is unrestricted code execution after approval; cwd is not an OS sandbox.
- `worker.call {sessionId,method,params}`: durable jobs, Docker, ADB, Office and explicit GPU dummy through the Python worker. The worker and existing environment supply these capabilities; missing dependencies report errors.
- `settings.get/update/reload/effective`: YAML with last-known-good validation. `settings.update {projectId,settings}` and `{sessionId,settings}` persist overlays in the same YAML; `settings.effective {sessionId}` shows values and top-level origins. Credential and CA file paths resolve relative to this YAML. Permissions default to asking; explicit overrides may authorize command/write actions per project or session.
- `memory.list/search/upsert`: provenance-bearing project/global knowledge with Korean substring fallback; `events.list {after}`; `data.export` (metadata and records, not secret-file contents).
- `improvements.propose/approve/validate/apply/evaluate/rollback`: explicit scope, validation and rollback plan; evaluation defaults to `unknown`. After approving, `validate {id,evidence}` checks a self-contained ESM candidate contract, records supplied test evidence and creates a content-hashed snapshot. `apply` rejects modified candidates. It does not automatically execute a free-text validation plan. External effects are not reverted by core rollback.
- `lsp.*`, `mcp.*`, `browser.*`, `knowledge.*`, `assets.*`, `git.*`, `embedding.*`, `semantic.*` are delegated to `@hpharness/extensions`.
- Model `extension_call` exposes only an explicit method allowlist. External writes, registered MCP calls, worker execution and browser actions require individual approval. The model cannot launch arbitrary MCP servers or change connection configuration through this tool. `instructions_list` discovers applicable nested AGENTS.md and workspace-local SKILL.md packages.
- Model `agents_delegate` creates a child session inheriting execution target and settings. The waiting parent releases its active slot, then reacquires a slot before proceeding. Child conversation/result provenance is durable and linked to the parent.

Source records are retained when context is sent. Automatic extractive compaction records the digest and source IDs, preserving complete tool-call/result groups and all original SQLite messages. This digest is a bounded excerpt, not an LLM-generated semantic summary; an oversized single tool group can still exceed the target character budget. Meaningful defaults: at most 10 active agents, 3 model requests, 60000 context characters, two additional transient model retries. Optional `maxSteps`, `maxDurationMs`, `maxTokens` stop new actions; usage is cumulative. A supervisor restart marks nonterminal runs `interrupted` rather than replaying uncertain effects. All-language IDE acceptance, comprehensive periodic collection, endpoint-scoped redaction and price-based budgets remain tracked requirements.

## Validation

`npm test --workspace @hpharness/harness` runs isolated SQLite, Cordis generation, proposal/approval, filesystem conflict, YAML, and real daemon transport tests. Set `HPH_LIVE_TEST=1` for a real tool roundtrip through the configured default localhost Responses endpoint, and `HPH_SSH_TEST=wsl` for worker execution using the existing SSH alias. Those opt-in tests perform read-only tool checks and use isolated scratch directories. They do not validate corporate services.
