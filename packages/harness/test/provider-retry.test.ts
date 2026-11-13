import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { complete } from "@hpharness/providers";
import { builtinCore } from "../src/core.js";

test("builtin core retries a transport timeout and completes the next request", async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    if (++requests === 1) return;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "recovered" }] }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const signal = new AbortController().signal;
  try {
    const result = await builtinCore.nextStep({
      signal,
      retryLimit: 1,
      complete: async () => {
        const reply = await complete({ protocol: "responses", model: "test", timeoutMs: 100, baseUrl: `http://127.0.0.1:${(server.address() as any).port}` }, { messages: [], signal });
        return { text: reply.message.content };
      },
    } as any);
    assert.equal(result.text, "recovered");
    assert.equal(requests, 2);
  } finally { server.closeAllConnections(); server.close(); }
});
