import { Context } from "cordis";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { CoreContract, RpcError, Notify } from "./types.js";
export interface Generation {
  id: string;
  context: Context;
  core: CoreContract;
  references: number;
  path?: string;
}
export const builtinCore: CoreContract = {
  version: "builtin-1",
  stateVersion: 1,
  systemPrompt:
    "You are an internal development assistant. Use tools to inspect before changing. Respect project instructions and user permissions. Preserve original records. Never claim untested corporate integrations work. Reply in Korean unless asked otherwise.",
  async nextStep(api) {
    for (let attempt = 0; ; attempt++)
      try {
        const result = await api.complete();
        return { ...result, continue: !!result.toolCalls?.length };
      } catch (error: any) {
        const transient =
          [408, 429, 500, 502, 503, 504].includes(error.status) ||
          ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT"].includes(
            error.cause?.code,
          );
        if (
          api.signal.aborted ||
          !transient ||
          attempt >= (api.retryLimit ?? 2)
        )
          throw error;
        await new Promise<void>((resolve, reject) => {
          const done = () => {
            clearTimeout(timer);
            api.signal.removeEventListener("abort", cancel);
            resolve();
          };
          const cancel = () => {
            clearTimeout(timer);
            api.signal.removeEventListener("abort", cancel);
            reject(api.signal.reason);
          };
          const timer = setTimeout(done, 250 * 2 ** attempt);
          api.signal.addEventListener("abort", cancel, { once: true });
        });
      }
  },
};
export class CoreManager {
  generations = new Map<string, Generation>();
  current!: Generation;
  constructor(private notify: Notify = () => {}) {}
  async load(filePath?: string, activate = true) {
    const context = new Context();
    let core: CoreContract;
    try {
      if (filePath) {
        const module = await import(
          pathToFileURL(resolve(filePath)).href + "?generation=" + randomUUID()
        );
        if (typeof module.apply !== "function")
          throw new RpcError(
            "INVALID_PLUGIN",
            "Core plugin must export apply(ctx)",
          );
        context.plugin(module.apply);
        await context.start();
        core = context.get("agentCore");
      } else {
        core = { ...builtinCore };
        context.plugin((ctx: Context) => {
          ctx.set("agentCore", core);
        });
        await context.start();
        core = context.get("agentCore");
      }
      if (
        !core ||
        typeof core.version !== "string" ||
        core.stateVersion !== 1 ||
        typeof core.systemPrompt !== "string" ||
        typeof core.nextStep !== "function"
      )
        throw new RpcError(
          "INCOMPATIBLE_CORE",
          "Core must provide agentCore {version,stateVersion:1,systemPrompt,nextStep(api)}",
        );
      const generation = {
        id: randomUUID(),
        context,
        core,
        references: 0,
        path: filePath,
      };
      if (!activate) {
        await context.stop();
        return generation;
      }
      this.generations.set(generation.id, generation);
      this.current = generation;
      this.notify("core.changed", { id: generation.id, version: core.version });
      await this.collect();
      return generation;
    } catch (e) {
      await context.stop();
      throw e;
    }
  }
  acquire(id = this.current.id) {
    const generation = this.generations.get(id);
    if (!generation) throw new RpcError("CORE_NOT_FOUND", id);
    generation.references++;
    return generation;
  }
  async release(id: string) {
    const generation = this.generations.get(id);
    if (generation)
      generation.references = Math.max(0, generation.references - 1);
    await this.collect();
  }
  async collect() {
    for (const [id, g] of this.generations)
      if (g !== this.current && g.references === 0) {
        await g.context.stop();
        this.generations.delete(id);
        this.notify("core.disposed", { id });
      }
  }
  status() {
    return {
      current: this.current?.id,
      generations: [...this.generations.values()].map((g) => ({
        id: g.id,
        version: g.core.version,
        references: g.references,
        path: g.path,
      })),
    };
  }
  async close() {
    for (const g of this.generations.values()) await g.context.stop();
    this.generations.clear();
  }
}
