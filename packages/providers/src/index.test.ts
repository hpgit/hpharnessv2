import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  complete,
  decode,
  encode,
  endpoint,
  type Protocol,
  type ProviderConfig,
  type Message,
} from "./index.js";
const base: ProviderConfig = {
  protocol: "responses",
  baseUrl: "http://localhost:10100/v1",
  model: "gpt-6-luna",
};
test("complete endpoint URL is normalized without doubling", () => {
  assert.equal(
    endpoint({ ...base, baseUrl: base.baseUrl + "/responses" }),
    base.baseUrl + "/responses",
  );
  assert.throws(() => endpoint({ ...base, baseUrl: "file:///test" }));
});
test("Responses preserves reasoning and stable call IDs", () => {
  const reply = decode("responses", {
    status: "completed",
    output: [
      { type: "reasoning", id: "r", summary: [] },
      {
        type: "function_call",
        call_id: "c",
        name: "sum",
        arguments: '{"a":1}',
      },
    ],
  });
  const body = encode(base, {
    messages: [reply.message, { role: "tool", content: "2", toolCallId: "c" }],
  });
  assert.equal((body.input as any[])[0].type, "reasoning");
  assert.equal((body.input as any[])[2].call_id, "c");
});
test("Anthropic parallel tool results grouped adjacent to assistant", () => {
  const body = encode(
    { ...base, protocol: "anthropic" },
    {
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "a", name: "x", arguments: {} },
            { id: "b", name: "x", arguments: {} },
          ],
        },
        { role: "tool", content: "1", toolCallId: "a" },
        { role: "tool", content: "2", toolCallId: "b" },
      ],
    },
  );
  assert.equal((body.messages as any[]).length, 2);
  assert.equal((body.messages as any[])[1].content.length, 2);
});
test("malformed args and incomplete generations never execute tools", () => {
  assert.throws(() =>
    decode("responses", { status: "incomplete", output: [] }),
  );
  assert.throws(() =>
    decode("chat-completions", {
      choices: [
        {
          message: {
            tool_calls: [{ id: "x", function: { name: "x", arguments: "[]" } }],
          },
        },
      ],
    }),
  );
});
test("HTTP transport and redacted errors", async () => {
  const server = createServer((req, res) => {
    res.writeHead(401);
    res.end("secret private diagnostic");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await assert.rejects(
      complete(
        {
          ...base,
          baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
        },
        { messages: [{ role: "user", content: "test" }] },
      ),
      (e) => e instanceof Error && e.message === "Model endpoint HTTP 401",
    );
  } finally {
    server.close();
  }
});
for (const protocol of [
  "responses",
  "chat-completions",
  "anthropic",
] as Protocol[])
  test(
    "live gpt-6-luna tool round trip: " + protocol,
    { skip: !process.env.HPH_LIVE_TEST },
    async () => {
      const config = { ...base, protocol, timeoutMs: 120000 };
      const messages: Message[] = [
        {
          role: "system",
          content:
            "You are a test assistant. Call add_numbers exactly once for this request. After its result, answer with only the number.",
        },
        { role: "user", content: "Use add_numbers to add 19 and 23." },
      ];
      const tools = [
        {
          name: "add_numbers",
          description: "Add two numbers",
          parameters: {
            type: "object",
            properties: { a: { type: "number" }, b: { type: "number" } },
            required: ["a", "b"],
            additionalProperties: false,
          },
        },
      ];
      const first = await complete(config, { messages, tools });
      assert.equal(first.message.toolCalls?.length, 1);
      const call = first.message.toolCalls![0];
      assert.equal(call.name, "add_numbers");
      assert.equal(Number(call.arguments.a) + Number(call.arguments.b), 42);
      messages.push(first.message, {
        role: "tool",
        toolCallId: call.id,
        content: "42",
      });
      const second = await complete(config, { messages, tools });
      assert.match(second.message.content, /42/);
      assert.equal(second.message.toolCalls?.length ?? 0, 0);
      assert.ok(second.usage.outputTokens > 0);
    },
  );
