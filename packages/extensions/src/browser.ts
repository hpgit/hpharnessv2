import { randomUUID } from "node:crypto";
export interface Site {
  id: string;
  origin: string;
  includePaths: string[];
  excludePaths?: string[];
  actions: string[];
}
export class BrowserService {
  private sites: Site[] = [];
  private tabs = new Map<
    number,
    {
      site: string;
      owned: boolean;
      expires: number;
      keep: boolean;
      lease: string;
    }
  >();
  private queue: any[] = [];
  private results = new Map<string, any>();
  private seen = 0;
  allowed(site: Site, url: string, action: string) {
    const u = new URL(url);
    const pathname = decodeURIComponent(u.pathname);
    const matches = (p: string) =>
      pathname === p || pathname.startsWith(p.endsWith("/") ? p : p + "/");
    return (
      u.origin === new URL(site.origin).origin &&
      site.actions.includes(action) &&
      site.includePaths.some(matches) &&
      !(site.excludePaths ?? []).some(matches)
    );
  }
  handle(method: string, p: any): any {
    if (method === "browser.configure") {
      if (!Array.isArray(p.sites)) throw new Error("sites must be an array");
      for (const site of p.sites) {
        if (
          !site.id ||
          !Array.isArray(site.actions) ||
          !site.includePaths?.length
        )
          throw new Error("Invalid site");
        if (!["https:", "http:"].includes(new URL(site.origin).protocol))
          throw new Error("Invalid site origin");
      }
      this.sites = p.sites;
      return { sites: this.sites };
    }
    if (method === "browser.status")
      return {
        connected: Date.now() - this.seen < 15000,
        sites: this.sites,
        tabs: [...this.tabs.entries()],
        queued: this.queue.length,
      };
    if (method === "browser.connected" || method === "browser.poll") {
      this.seen = Date.now();
      return { commands: this.queue.splice(0, 8), sites: this.sites };
    }
    if (method === "browser.handoff") {
      const site = this.sites.find((s) => this.allowed(s, p.url, "read"));
      if (!site)
        throw new Error("Register this site and read permission first");
      if (!Number.isInteger(p.tabId))
        throw new Error("A tab identifier is required");
      this.tabs.set(p.tabId, {
        site: site.id,
        owned: false,
        expires: Date.now() + 600000,
        keep: true,
        lease: randomUUID(),
      });
      return { accepted: true };
    }
    if (method === "browser.validateLease") {
      const pending = this.results.get(p.commandId);
      if (!pending || pending.state !== "pending")
        throw new Error("Browser command was cancelled or completed");
      const c = pending.command;
      const site = this.sites.find((s) => s.id === c.site);
      if (!site || !site.actions.includes(c.action) || Date.now() > c.expires)
        throw new Error("Browser command permission expired or changed");
      if (c.action !== "create") {
        const tab = this.tabs.get(c.tabId);
        if (!tab || tab.lease !== c.lease || Date.now() > tab.expires)
          throw new Error("Tab control was reclaimed or expired");
      }
      if (
        ["create", "navigate"].includes(c.action) &&
        !this.allowed(site, c.url, c.action)
      )
        throw new Error("URL outside current registered range");
      return { valid: true, policy: site, expires: c.expires };
    }
    if (method === "browser.result") {
      const previous = this.results.get(p.commandId);
      if (previous?.state === "cancelled")
        return { accepted: false, state: "cancelled" };
      if (!previous || previous.state !== "pending")
        throw new Error("Unknown or completed browser command");
      this.results.set(p.commandId, {
        ...previous,
        state: p.error ? "failed" : "complete",
        result: p.result,
        error: p.error,
      });
      if (
        previous.action === "create" &&
        !p.error &&
        Number.isInteger(p.result?.tabId)
      )
        this.tabs.set(p.result.tabId, {
          site: previous.site,
          owned: true,
          expires: Date.now() + 600000,
          keep: false,
          lease: randomUUID(),
        });
      if (previous.action === "close" && !p.error)
        this.tabs.delete(previous.tabId);
      return { accepted: true };
    }
    if (method === "browser.result.get")
      return this.results.get(p.commandId) ?? null;
    if (method === "browser.release") {
      this.tabs.delete(p.tabId);
      this.queue = this.queue.filter((c) => c.tabId !== p.tabId);
      for (const [id, result] of this.results)
        if (result.state === "pending" && result.tabId === p.tabId)
          this.results.set(id, {
            ...result,
            state: "cancelled",
            error: "User reclaimed tab control",
          });
      return { released: true };
    }
    if (method === "browser.command") {
      if (Date.now() - this.seen >= 15000)
        throw new Error("Chrome is disconnected; pending user connection");
      const action = p.action;
      if (
        !["create", "navigate", "read", "click", "type", "close"].includes(
          action,
        )
      )
        throw new Error("Unsupported browser action");
      const tab = this.tabs.get(p.tabId);
      const site = this.sites.find((s) => s.id === (tab?.site ?? p.site));
      if (!site) throw new Error("Unknown site");
      if (action !== "create" && (!tab || tab.expires < Date.now()))
        throw new Error("Tab handoff absent or expired");
      if (action === "close" && (!tab?.owned || tab.keep))
        throw new Error("User or retained tab must remain open");
      if (!site.actions.includes(action))
        throw new Error("Action outside site permission");
      if (
        ["create", "navigate"].includes(action) &&
        !this.allowed(site, p.url, action)
      )
        throw new Error("URL outside registered range");
      const id = randomUUID();
      const command = {
        ...p,
        id,
        site: site.id,
        policy: site,
        lease: tab?.lease,
        expires: tab?.expires ?? Date.now() + 600000,
      };
      this.queue.push(command);
      this.results.set(id, {
        state: "pending",
        action,
        site: site.id,
        tabId: p.tabId,
        command,
      });
      return { commandId: id, state: "pending" };
    }
    throw new Error("Unknown browser method");
  }
}
