import { Message, RpcError } from "./types.js";

/** Repair incomplete turns without replaying effects whose outcome is unknown. */
export function repairToolHistory(messages: Message[]): Message[] {
  const result: Message[] = [];
  let pending = new Map<string, Message>();
  const flush = () => {
    for (const [id, owner] of pending) result.push({
      id: `interrupted-${owner.id}-${id}`, sessionId: owner.sessionId, role: "tool",
      toolCallId: id, createdAt: owner.createdAt,
      content: JSON.stringify({ error: "Tool outcome unavailable at this history boundary. Inspect external state before retrying; the action may have occurred." }),
    });
    pending = new Map();
  };
  for (const message of messages) {
    if (message.role === "tool") {
      if (message.toolCallId && pending.delete(message.toolCallId)) result.push(message);
    } else {
      flush();
      result.push(message);
      for (const call of message.toolCalls ?? []) pending.set(call.id, message);
    }
  }
  flush();
  return result;
}

/** Bounded model view. Originals remain in the message/artifact store. */
export function compact(messages: Message[], maxChars: number): {
  messages: Message[]; summary?: string; sourceIds?: string[];
} {
  const size = (value: unknown) => JSON.stringify(value).length;
  if (size(messages) <= maxChars) return { messages };
  const system = messages.filter((m) => m.role === "system");
  const groups: Message[][] = [];
  for (const message of messages.filter((m) => m.role !== "system")) {
    if (message.role === "tool" && groups.length) groups.at(-1)!.push(message);
    else groups.push([message]);
  }
  const available = maxChars - size(system) - 2;
  if (available < 256) throw new RpcError("CONTEXT_LIMIT", "System instructions exceed the configured context limit");
  let tail: Message[] = [];
  let split = groups.length;
  while (split > 0) {
    const group = groups[split - 1];
    if (tail.length && size([...group, ...tail]) > available * 0.7) break;
    tail = [...group, ...tail];
    split--;
  }
  const removed = groups.slice(0, split).flat();
  const summary = removed.length ?
    "Extractive history digest; consult original records.\n" + removed.map((m) => `[${m.id} ${m.role}] ${m.content.slice(0, 180)}`).join("\n").slice(-Math.floor(available * 0.15)) : undefined;
  const digest: Message[] = summary ? [{
    id: "compaction-" + removed.at(-1)!.id, sessionId: messages[0].sessionId,
    role: "user", content: summary, createdAt: messages[0].createdAt,
  }] : [];
  let result = [...system, ...digest, ...tail];
  if (size(result) > maxChars) {
    // Opaque provider data may duplicate large tool arguments/text. Normalize
    // when it cannot fit; never change executable arguments.
    tail = tail.map(({ providerData: _opaque, ...m }) => m);
    const render = (limit: number) => [...system, ...digest, ...tail.map((m) => ({
      ...m,
      content: m.content.length <= limit ? m.content : m.content.slice(0, limit) + `\n[Truncated; original message ${m.id}]`,
    }))];
    if (size(render(0)) > maxChars) throw new RpcError("CONTEXT_LIMIT", "Tool-call metadata exceeds the configured context limit");
    let low = 0, high = tail.reduce((max, m) => Math.max(max, m.content.length), 0);
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (size(render(mid)) <= maxChars) low = mid;
      else high = mid - 1;
    }
    result = render(low);
  }
  return { messages: result, summary, sourceIds: removed.map((m) => m.id) };
}
