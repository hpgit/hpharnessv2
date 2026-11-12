import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { defaults, RpcError, Settings } from "./types.js";
export class Configuration {
  value: Settings = structuredClone(defaults);
  error?: string;
  constructor(public path: string) {
    this.reload();
  }
  validate(input: any): Settings {
    if (!input || typeof input !== "object")
      throw new RpcError("INVALID_CONFIG", "Settings must be an object");
    const value = {
      ...defaults,
      ...input,
      provider: { ...defaults.provider, ...input.provider },
      permissions: { ...defaults.permissions, ...input.permissions },
    };
    for (const key of ["maxAgents", "maxModelRequests"])
      if (
        !Number.isInteger(value[key]) ||
        value[key] < 1 ||
        value[key] > (key === "maxAgents" ? 10 : 100)
      )
        throw new RpcError(
          "INVALID_CONFIG",
          `${key} must be 1..${key === "maxAgents" ? 10 : 100}`,
        );
    for (const key of ["maxTokens", "maxDurationMs", "contextMaxChars"])
      if (
        value[key] !== undefined &&
        (!Number.isInteger(value[key]) || value[key] < 1)
      )
        throw new RpcError(
          "INVALID_CONFIG",
          key + " must be a positive integer",
        );
    if (
      value.retryLimit !== undefined &&
      (!Number.isInteger(value.retryLimit) ||
        value.retryLimit < 0 ||
        value.retryLimit > 10)
    )
      throw new RpcError("INVALID_CONFIG", "retryLimit must be 0..10");
    for (const field of ["projectOverrides", "sessionOverrides"])
      for (const override of Object.values(value[field] ?? {}) as any[]) {
        if (
          !override ||
          typeof override !== "object" ||
          override.projectOverrides ||
          override.sessionOverrides
        )
          throw new RpcError("INVALID_CONFIG", "Invalid nested overlay");
        this.validate({
          ...value,
          projectOverrides: undefined,
          sessionOverrides: undefined,
          ...override,
          provider: { ...value.provider, ...override.provider },
          permissions: { ...value.permissions, ...override.permissions },
        });
      }
    if (
      value.maxSteps !== undefined &&
      (!Number.isInteger(value.maxSteps) || value.maxSteps < 1)
    )
      throw new RpcError(
        "INVALID_CONFIG",
        "maxSteps must be a positive integer",
      );
    for (const key of ["command", "write"])
      if (!["ask", "allow"].includes(value.permissions[key]))
        throw new RpcError("INVALID_CONFIG", "Invalid permission");
    if (value.provider.baseUrl && !/^https?:\/\//.test(value.provider.baseUrl))
      throw new RpcError("INVALID_CONFIG", "Provider baseUrl requires http(s)");
    return value;
  }
  reload() {
    if (!existsSync(this.path)) return this.value;
    try {
      const next = this.validate(parse(readFileSync(this.path, "utf8")));
      this.value = next;
      this.error = undefined;
    } catch (e) {
      this.error = String(e);
    }
    return this.value;
  }
  update(input: Partial<Settings>) {
    const next = this.validate({
      ...this.value,
      ...input,
      provider: { ...this.value.provider, ...input.provider },
      permissions: { ...this.value.permissions, ...input.permissions },
    });
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path + ".tmp", stringify(next));
    renameSync(this.path + ".tmp", this.path);
    this.value = next;
    this.error = undefined;
    return next;
  }
  effective(projectId?: string, sessionId?: string) {
    const project =
      (projectId && this.value.projectOverrides?.[projectId]) || {};
    const session =
      (sessionId && this.value.sessionOverrides?.[sessionId]) || {};
    const value = {
      ...this.value,
      ...project,
      ...session,
      provider: {
        ...this.value.provider,
        ...project.provider,
        ...session.provider,
      },
      permissions: {
        ...this.value.permissions,
        ...project.permissions,
        ...session.permissions,
      },
    };
    const origins: Record<string, string> = {};
    for (const key of Object.keys(value))
      origins[key] =
        key in session ? "session" : key in project ? "project" : "user";
    return { value, origins };
  }
  provider(settings = this.value) {
    const p = { ...settings.provider };
    for (const key of ["apiKeyFile", "apiKeyPath", "caPath"])
      if (typeof p[key] === "string")
        p[key] = resolve(dirname(this.path), p[key] as string);
    return p;
  }
}
