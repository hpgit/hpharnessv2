import { readFile } from "node:fs/promises";
import {
  Agent,
  EnvHttpProxyAgent,
  fetch as requestFetch,
  type Dispatcher,
} from "undici";

export type Protocol = "responses" | "chat-completions" | "anthropic";
export interface ProviderConfig {
  protocol: Protocol;
  baseUrl: string;
  model: string;
  apiKeyPath?: string;
  timeoutMs?: number;
  proxy?: string;
  caPath?: string;
  maxOutputTokens?: number;
}
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  providerData?: unknown;
}
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface ModelRequest {
  messages: Message[];
  tools?: ToolDefinition[];
  signal?: AbortSignal;
}
export interface ModelReply {
  message: Message;
  usage: { inputTokens: number; outputTokens: number };
  finishReason: string;
}
export class ProviderError extends Error {
  constructor(
    message: string,
    public status?: number,
    public body?: unknown,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
function replayData(message: Message, protocol: Protocol): unknown[] | undefined {
  const data = message.providerData as { protocol?: Protocol; data?: unknown } | undefined;
  return data?.protocol === protocol && Array.isArray(data.data) ? data.data : undefined;
}
function errorDetail(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 4096);
  return JSON.stringify(body)?.slice(0, 4096) ?? "";
}
async function diagnosticBody(response: Awaited<ReturnType<typeof requestFetch>>): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Buffer[] = [];
  let remaining = 4096;
  try {
    while (remaining > 0) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value.subarray(0, remaining));
      chunks.push(chunk);
      remaining -= chunk.length;
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks).toString("utf8");
}
const paths: Record<Protocol, string> = {
  responses: "responses",
  "chat-completions": "chat/completions",
  anthropic: "messages",
};

export function endpoint(config: ProviderConfig): string {
  const url = new URL(config.baseUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new ProviderError("Invalid endpoint URL");
  if (!paths[config.protocol])
    throw new ProviderError("Unsupported provider protocol");
  url.search = "";
  url.hash = "";
  let pathname = url.pathname.replace(/\/+$/, "");
  pathname = pathname.replace(
    /\/(?:responses|chat\/completions|messages)$/,
    "",
  );
  url.pathname = pathname + "/" + paths[config.protocol];
  return url.toString();
}
function argumentsObject(value: unknown): Record<string, unknown> {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new ProviderError("Tool arguments must be a JSON object");
  return parsed as Record<string, unknown>;
}
export function encode(
  config: ProviderConfig,
  request: ModelRequest,
): Record<string, unknown> {
  const tools = request.tools ?? [];
  if (config.protocol === "responses") {
    const input: unknown[] = [];
    for (const m of request.messages) {
      if (m.role === "tool")
        input.push({
          type: "function_call_output",
          call_id: m.toolCallId,
          output: m.content,
        });
      else if (m.role === "assistant" && replayData(m, "responses"))
        input.push(...replayData(m, "responses")!);
      else {
        if (m.content) input.push({ role: m.role, content: m.content });
        for (const t of m.toolCalls ?? [])
          input.push({
            type: "function_call",
            call_id: t.id,
            name: t.name,
            arguments: JSON.stringify(t.arguments),
          });
      }
    }
    return {
      model: config.model,
      input,
      store: false,
      stream: false,
      ...(config.maxOutputTokens
        ? { max_output_tokens: config.maxOutputTokens }
        : {}),
      ...(tools.length
        ? {
            tools: tools.map((t) => ({
              type: "function",
              ...t,
              strict: false,
            })),
          }
        : {}),
    };
  }
  if (config.protocol === "chat-completions")
    return {
      model: config.model,
      stream: false,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content || null,
        ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
        ...(m.toolCalls?.length
          ? {
              tool_calls: m.toolCalls.map((t) => ({
                id: t.id,
                type: "function",
                function: {
                  name: t.name,
                  arguments: JSON.stringify(t.arguments),
                },
              })),
            }
          : {}),
      })),
      ...(tools.length
        ? { tools: tools.map((t) => ({ type: "function", function: t })) }
        : {}),
      ...(config.maxOutputTokens
        ? { max_completion_tokens: config.maxOutputTokens }
        : {}),
    };
  const messages: { role: string; content: any[] }[] = [];
  for (const m of request.messages.filter((m) => m.role !== "system")) {
    const role = m.role === "assistant" ? "assistant" : "user";
    const content =
      m.role === "tool"
        ? [
            {
              type: "tool_result",
              tool_use_id: m.toolCallId,
              content: m.content,
            },
          ]
        : m.role === "assistant" && replayData(m, "anthropic")
          ? replayData(m, "anthropic")!
          : [
              ...(m.content ? [{ type: "text", text: m.content }] : []),
              ...(m.toolCalls ?? []).map((t) => ({
                type: "tool_use",
                id: t.id,
                name: t.name,
                input: t.arguments,
              })),
            ];
    if (messages.at(-1)?.role === role)
      messages.at(-1)!.content.push(...content);
    else messages.push({ role, content });
  }
  return {
    model: config.model,
    max_tokens: config.maxOutputTokens ?? 8192,
    stream: false,
    system: request.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n"),
    messages,
    ...(tools.length
      ? {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.parameters,
          })),
        }
      : {}),
  };
}
export function decode(protocol: Protocol, body: any): ModelReply {
  if (body.error) throw new ProviderError("Provider returned an error: " + errorDetail(body.error), undefined, body.error);
  let message: Message, finishReason: string;
  if (protocol === "responses") {
    if (!Array.isArray(body.output))
      throw new ProviderError("Missing Responses output");
    message = {
      role: "assistant",
      content: body.output
        .filter((x: any) => x.type === "message")
        .flatMap((x: any) => x.content ?? [])
        .filter((x: any) => x.type === "output_text")
        .map((x: any) => x.text)
        .join(""),
      toolCalls: body.output
        .filter((x: any) => x.type === "function_call")
        .map((x: any) => ({
          id: x.call_id,
          name: x.name,
          arguments: argumentsObject(x.arguments),
        })),
      providerData: { protocol, data: body.output },
    };
    finishReason = body.status ?? "unknown";
    if (["failed", "cancelled", "incomplete"].includes(finishReason))
      throw new ProviderError("Responses did not complete: " + finishReason);
  } else if (protocol === "chat-completions") {
    const choice = body.choices?.[0];
    if (!choice?.message)
      throw new ProviderError("Missing Chat Completions message");
    message = {
      role: "assistant",
      content: choice.message.content ?? "",
      toolCalls: (choice.message.tool_calls ?? []).map((x: any) => ({
        id: x.id,
        name: x.function.name,
        arguments: argumentsObject(x.function.arguments),
      })),
    };
    finishReason = choice.finish_reason ?? "unknown";
    if (["length", "content_filter"].includes(finishReason))
      throw new ProviderError("Chat completion stopped: " + finishReason);
  } else {
    if (!Array.isArray(body.content))
      throw new ProviderError("Missing Messages content");
    message = {
      role: "assistant",
      content: body.content
        .filter((x: any) => x.type === "text")
        .map((x: any) => x.text)
        .join(""),
      toolCalls: body.content
        .filter((x: any) => x.type === "tool_use")
        .map((x: any) => ({
          id: x.id,
          name: x.name,
          arguments: argumentsObject(x.input),
        })),
      providerData: { protocol, data: body.content },
    };
    finishReason = body.stop_reason ?? "unknown";
    if (["max_tokens", "refusal"].includes(finishReason))
      throw new ProviderError("Messages stopped: " + finishReason);
  }
  for (const call of message.toolCalls ?? [])
    if (!call.id || !call.name)
      throw new ProviderError("Tool call has no identity");
  return {
    message,
    finishReason,
    usage: {
      inputTokens: body.usage?.input_tokens ?? body.usage?.prompt_tokens ?? 0,
      outputTokens:
        body.usage?.output_tokens ?? body.usage?.completion_tokens ?? 0,
    },
  };
}
export async function complete(
  config: ProviderConfig,
  request: ModelRequest,
): Promise<ModelReply> {
  if (!config.model?.trim()) throw new ProviderError("Configure a model");
  if (config.timeoutMs !== undefined && (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 2147483647))
    throw new ProviderError("timeoutMs must be an integer from 1 to 2147483647");
  const key = config.apiKeyPath
    ? (await readFile(config.apiKeyPath, "utf8")).trim()
    : undefined;
  const ca = config.caPath ? await readFile(config.caPath, "utf8") : undefined;
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (config.protocol === "anthropic") {
    headers["anthropic-version"] = "2023-06-01";
    if (key) headers["x-api-key"] = key;
  } else if (key) headers.authorization = "Bearer " + key;
  const dispatcher: Dispatcher =
    config.proxy ||
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy
      ? new EnvHttpProxyAgent({
          ...(config.proxy
            ? { httpProxy: config.proxy, httpsProxy: config.proxy }
            : {}),
          requestTls: ca ? { ca } : undefined,
          proxyTls: ca ? { ca } : undefined,
        })
      : new Agent({ connect: ca ? { ca } : undefined });
  const timeout = AbortSignal.timeout(config.timeoutMs ?? 120000);
  try {
    const signal = AbortSignal.any([
      timeout,
      ...(request.signal ? [request.signal] : []),
    ]);
    const response = await requestFetch(endpoint(config), {
      method: "POST",
      headers,
      body: JSON.stringify(encode(config, request)),
      dispatcher,
      signal,
      redirect: "error",
    });
    if (!response.ok) {
      const body = await diagnosticBody(response);
      throw new ProviderError(
        "Model endpoint HTTP " + response.status + (body ? ": " + body : ""),
        response.status,
        body,
      );
    }
    return decode(config.protocol, await response.json());
  } catch (error) {
    if (timeout.aborted && !request.signal?.aborted) {
      const failure = new ProviderError("Model request timed out after " + (config.timeoutMs ?? 120000) + "ms", 408);
      failure.cause = { code: "ETIMEDOUT" };
      throw failure;
    }
    throw error;
  } finally {
    await dispatcher.close();
  }
}
