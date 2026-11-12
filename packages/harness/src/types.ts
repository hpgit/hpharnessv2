export interface Target {
  kind: "local" | "ssh";
  host?: string;
  container?: string;
}
export interface Project {
  id: string;
  name: string;
  root: string;
  target: Target;
  createdAt: string;
}
export interface Session {
  id: string;
  projectId: string;
  title: string;
  cwd: string;
  target: Target;
  createdAt: string;
  parentId?: string;
  settingsSourceId?: string;
}
export interface Message {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  createdAt: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  providerData?: unknown;
}
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
export interface ModelResult {
  text: string;
  toolCalls?: ToolCall[];
  usage?: unknown;
  providerData?: unknown;
  continue?: boolean;
}
export interface ProviderConfig {
  protocol: string;
  baseUrl: string;
  model: string;
  apiKeyFile?: string;
  [key: string]: unknown;
}
export interface Settings {
  provider: ProviderConfig;
  maxAgents: number;
  maxModelRequests: number;
  maxSteps?: number;
  maxTokens?: number;
  maxDurationMs?: number;
  retryLimit?: number;
  contextMaxChars?: number;
  projectOverrides?: Record<string, Partial<Settings>>;
  sessionOverrides?: Record<string, Partial<Settings>>;
  pythonPath?: string;
  workerPath?: string;
  permissions: { command: "ask" | "allow"; write: "ask" | "allow" };
}
export interface Run {
  id: string;
  sessionId: string;
  status:
    | "queued"
    | "running"
    | "waiting_approval"
    | "waiting_child"
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted";
  generation: string;
  step: number;
  input: string;
  createdAt: string;
  error?: string;
  usage?: unknown;
  pendingGeneration?: string;
  migrationDeadline?: number;
}
export interface Approval {
  id: string;
  runId: string;
  tool: string;
  arguments: Record<string, unknown>;
  target: Target;
  cwd: string;
  status: "pending" | "approved" | "denied" | "cancelled";
  createdAt: string;
}
export interface CoreStepApi {
  run: Readonly<Run>;
  messages: Message[];
  tools: unknown[];
  signal: AbortSignal;
  retryLimit?: number;
  complete(messages?: Message[]): Promise<ModelResult>;
}
export interface CoreContract {
  version: string;
  stateVersion: 1;
  systemPrompt: string;
  nextStep(api: CoreStepApi): Promise<ModelResult>;
  buildContext?(messages: Message[], memory: string[]): Message[];
  afterStep?(run: Readonly<Run>): void | Promise<void>;
}
export interface CoreModule {
  apply(ctx: unknown): void | Promise<void>;
  createCore?(): CoreContract | Promise<CoreContract>;
}
export type Notify = (event: string, data: unknown) => void;
export type ModelInvoke = (
  settings: ProviderConfig,
  messages: Message[],
  tools: unknown[],
  signal: AbortSignal,
) => Promise<ModelResult>;
export class RpcError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export const defaults: Settings = {
  provider: {
    protocol: "responses",
    baseUrl: "http://localhost:10100/v1",
    model: "gpt-6-luna",
  },
  maxAgents: 10,
  maxModelRequests: 3,
  retryLimit: 2,
  contextMaxChars: 60000,
  permissions: { command: "ask", write: "ask" },
};
