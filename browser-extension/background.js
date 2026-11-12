let port,
  serial = 0,
  busy = false;
const pending = new Map();
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!port) return reject(new Error("Native bridge disconnected"));
    const id = ++serial;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Bridge timeout"));
    }, 12000);
    pending.set(id, { resolve, reject, timer });
    port.postMessage({ id, method, params });
  });
}
function allowed(policy, url, action) {
  const u = new URL(url),
    path = decodeURIComponent(u.pathname),
    matches = (p) =>
      path === p || path.startsWith(p.endsWith("/") ? p : p + "/");
  return (
    u.origin === new URL(policy.origin).origin &&
    policy.actions.includes(action) &&
    policy.includePaths.some(matches) &&
    !(policy.excludePaths || []).some(matches)
  );
}
async function execute(c) {
  const validation = await call("browser.validateLease", { commandId: c.id });
  c = { ...c, policy: validation.policy, expires: validation.expires };
  if (Date.now() > c.expires) throw new Error("Control lease expired");
  if (c.action === "create") {
    if (!allowed(c.policy, c.url, c.action))
      throw new Error("URL outside scope");
    const tab = await chrome.tabs.create({ url: c.url, active: false });
    return { tabId: tab.id, url: tab.url };
  }
  const tab = await chrome.tabs.get(c.tabId);
  if (!allowed(c.policy, tab.url, c.action))
    throw new Error("Tab navigated outside scope");
  if (c.action === "close") {
    await chrome.tabs.remove(c.tabId);
    return { closed: true };
  }
  if (c.action === "navigate") {
    if (!allowed(c.policy, c.url, c.action))
      throw new Error("URL outside scope");
    await chrome.tabs.update(c.tabId, { url: c.url });
    return { navigated: true };
  }
  const result = await chrome.scripting.executeScript({
    target: { tabId: c.tabId },
    func: (action, selector, value, policy) => {
      const current = new URL(location.href),
        path = decodeURIComponent(current.pathname);
      const matches = (p) =>
        path === p || path.startsWith(p.endsWith("/") ? p : p + "/");
      if (
        current.origin !== new URL(policy.origin).origin ||
        !policy.actions.includes(action) ||
        !policy.includePaths.some(matches) ||
        (policy.excludePaths || []).some(matches)
      )
        throw new Error(
          "Page moved outside the registered scope before execution",
        );
      if (action === "read")
        return {
          url: location.href,
          title: document.title,
          text: document.body.innerText.slice(0, 150000),
        };
      const element = document.querySelector(selector);
      if (!element) throw new Error("Element not found");
      if (action === "click") {
        element.click();
        return { clicked: true };
      }
      if (action === "type") {
        if (!("value" in element))
          throw new Error("Element is not editable input");
        element.focus();
        element.value = value;
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return { typed: true };
      }
      throw new Error("Unsupported action");
    },
    args: [c.action, c.selector ?? "", c.text ?? "", c.policy],
  });
  return result[0]?.result;
}
async function poll() {
  if (busy || !port) return;
  busy = true;
  try {
    const { commands = [] } = await call("browser.poll");
    for (const c of commands) {
      try {
        await call("browser.result", {
          commandId: c.id,
          result: await execute(c),
        });
      } catch (error) {
        await call("browser.result", { commandId: c.id, error: String(error) });
      }
    }
  } catch {
  } finally {
    busy = false;
  }
}
function connect() {
  if (port) return;
  try {
    port = chrome.runtime.connectNative("com.hpharness.bridge");
    port.onMessage.addListener((m) => {
      const p = pending.get(m.id);
      if (p) {
        clearTimeout(p.timer);
        pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      }
    });
    port.onDisconnect.addListener(() => {
      port = null;
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("Native bridge disconnected"));
      }
      pending.clear();
    });
    call("browser.connected").catch(() => {});
  } catch {
    port = null;
  }
}
chrome.runtime.onMessage.addListener((m, _sender, reply) => {
  if (m.type === "connect") {
    connect();
    reply({ connected: !!port });
    return;
  }
  if (m.type === "handoff" || m.type === "release") {
    call(
      m.type === "handoff" ? "browser.handoff" : "browser.release",
      m.params,
    ).then(reply, (e) => reply({ error: e.message }));
    return true;
  }
});
setInterval(poll, 1500);
connect();
