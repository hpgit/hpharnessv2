import { test } from "node:test";
import assert from "node:assert/strict";
import { compact, repairToolHistory } from "../src/context.js";
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
test("even a single oversized latest tool group fits without changing call arguments", () => {
  const messages: Message[] = [
    { id: "s", sessionId: "s", role: "system", content: "Keep instructions", createdAt: "" },
    { id: "a", sessionId: "s", role: "assistant", content: "", toolCalls: [{ id: "c", name: "read", arguments: { path: "test" } }], providerData: { data: "x".repeat(100000) }, createdAt: "" },
    { id: "t", sessionId: "s", role: "tool", toolCallId: "c", content: '\\"\n'.repeat(100000), createdAt: "" },
  ];
  const result = compact(messages, 2000).messages;
  assert(JSON.stringify(result).length <= 2000);
  assert.equal(result[0].content, "Keep instructions");
  assert.deepEqual(result.find((m) => m.role === "assistant")?.toolCalls, messages[1].toolCalls);
  assert.equal(result.at(-1)?.toolCallId, "c");
  assert.equal(messages[2].content.length, 300000);
});
test("unrepresentable system or executable metadata fails instead of exceeding context", () => {
  const base = { id: "m", sessionId: "s", createdAt: "", content: "" };
  assert.throws(() => compact([{ ...base, role: "system", content: "x".repeat(5000) }], 2000), /System instructions/);
  assert.throws(() => compact([{ ...base, role: "assistant", toolCalls: [{ id: "c", name: "write", arguments: { content: "x".repeat(5000) } }] }], 2000), /Tool-call metadata/);
});
test("repair fills each missing result before the next user without claiming success", () => {
  const base = { id: "m", sessionId: "s", createdAt: "", content: "" };
  const repaired = repairToolHistory([
    { ...base, role: "assistant", toolCalls: [{ id: "c1", name: "write", arguments: {} }, { id: "c2", name: "read", arguments: {} }] },
    { ...base, id: "t", role: "tool", toolCallId: "c1", content: "done" },
    { ...base, id: "u", role: "user", content: "Continue" },
  ]);
  assert.equal(repaired[2].toolCallId, "c2");
  assert.match(repaired[2].content, /may have occurred/);
  assert.equal(repaired[3].role, "user");
});
