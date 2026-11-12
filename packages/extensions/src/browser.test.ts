import { test } from "node:test";
import assert from "node:assert/strict";
import { BrowserService } from "./browser.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
test("browser scope and user tab ownership enforced", () => {
  const b = new BrowserService();
  b.handle("browser.configure", {
    sites: [
      {
        id: "wiki",
        origin: "https://wiki.example",
        includePaths: ["/space"],
        excludePaths: ["/space/private"],
        actions: ["create", "read", "close"],
      },
    ],
  });
  b.handle("browser.connected", {});
  assert.throws(() =>
    b.handle("browser.command", {
      action: "create",
      site: "wiki",
      url: "https://wiki.example/space-other",
    }),
  );
  assert.throws(() =>
    b.handle("browser.command", {
      action: "create",
      site: "wiki",
      url: "https://wiki.example/space/private/x",
    }),
  );
  b.handle("browser.handoff", {
    tabId: 1,
    url: "https://wiki.example/space/doc",
  });
  assert.throws(() =>
    b.handle("browser.command", { action: "close", tabId: 1 }),
  );
  const c = b.handle("browser.command", { action: "read", tabId: 1 });
  assert.equal(b.handle("browser.poll", {}).commands.length, 1);
  b.handle("browser.result", {
    commandId: c.commandId,
    result: { text: "source" },
  });
  assert.equal(b.handle("browser.result.get", c).state, "complete");
  assert.throws(() =>
    b.handle("browser.result", { commandId: c.commandId, result: {} }),
  );
});
test("release cancels already-polled commands and re-handoff never revives old lease", () => {
  const b = new BrowserService();
  b.handle("browser.configure", {
    sites: [
      {
        id: "wiki",
        origin: "https://wiki.example",
        includePaths: ["/space"],
        actions: ["read"],
      },
    ],
  });
  b.handle("browser.connected", {});
  b.handle("browser.handoff", {
    tabId: 1,
    url: "https://wiki.example/space/doc",
  });
  const c = b.handle("browser.command", { action: "read", tabId: 1 });
  b.handle("browser.poll", {});
  assert.equal(b.handle("browser.validateLease", c).valid, true);
  b.handle("browser.release", { tabId: 1 });
  assert.throws(() => b.handle("browser.validateLease", c), /cancelled/);
  b.handle("browser.handoff", {
    tabId: 1,
    url: "https://wiki.example/space/doc",
  });
  assert.throws(() => b.handle("browser.validateLease", c), /cancelled/);
  assert.equal(
    b.handle("browser.result", {
      commandId: c.commandId,
      result: { text: "late" },
    }).accepted,
    false,
  );
});
test("extension checks actual page scope again inside injected DOM action", async () => {
  const policy = {
    id: "wiki",
    origin: "https://wiki.example",
    includePaths: ["/space"],
    excludePaths: ["/space/private"],
    actions: ["read"],
  };
  let touched = false;
  const context = createContext({
    URL,
    Date,
    Map,
    Promise,
    Error,
    setInterval: () => 1,
    setTimeout: () => 1,
    clearTimeout: () => {},
    location: { href: "https://wiki.example/space/private/secret" },
    document: {
      body: {
        get innerText() {
          touched = true;
          return "secret";
        },
      },
    },
    chrome: {
      runtime: {
        connectNative: () => {
          throw new Error("offline");
        },
        onMessage: { addListener: () => {} },
      },
      tabs: {
        get: async () => ({ url: "https://wiki.example/space/allowed" }),
      },
      scripting: {
        executeScript: async ({ func, args }: any) => [
          { result: func(...args) },
        ],
      },
    },
  });
  runInContext(
    readFileSync(
      resolve(import.meta.dirname, "../../../browser-extension/background.js"),
      "utf8",
    ),
    context,
  );
  context.validation = { valid: true, policy, expires: Date.now() + 10000 };
  runInContext("call=async()=>validation", context);
  const execute = runInContext("execute", context);
  await assert.rejects(
    execute({
      id: "command",
      tabId: 1,
      action: "read",
      policy,
      expires: Date.now() + 10000,
    }),
    /outside the registered scope/,
  );
  assert.equal(touched, false);
});
