import { test } from "node:test";
import assert from "node:assert/strict";
import { compact } from "../src/context.js";
import { Message } from "../src/types.js";
test("compaction records source references and never separates a tool result from its call", () => {
  const messages: Message[] = [];
  for (let i = 0; i < 12; i++) {
    messages.push({
      id: "u" + i,
      sessionId: "s",
      role: "user",
      content: "task " + i + "x".repeat(1000),
      createdAt: "",
    });
    messages.push({
      id: "a" + i,
      sessionId: "s",
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call" + i, name: "read", arguments: {} }],
      createdAt: "",
    });
    messages.push({
      id: "t" + i,
      sessionId: "s",
      role: "tool",
      content: "y".repeat(1000),
      toolCallId: "call" + i,
      createdAt: "",
    });
  }
  const original = JSON.stringify(messages);
  const compressed = compact(messages, 5000);
  assert(compressed.summary);
  assert(compressed.sourceIds!.length > 0);
  assert.equal(JSON.stringify(messages), original);
  for (const m of compressed.messages)
    if (m.role === "tool")
      assert(
        compressed.messages.some((a) =>
          a.toolCalls?.some((c) => c.id === m.toolCallId),
        ),
      );
  assert(compressed.messages.length < messages.length);
});
