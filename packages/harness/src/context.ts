import { Message } from "./types.js";
/** Preserve complete tool-call groups. The original history always stays in SQLite. */
export function compact(
  messages: Message[],
  maxChars: number,
): { messages: Message[]; summary?: string; sourceIds?: string[] } {
  if (JSON.stringify(messages).length <= maxChars || messages.length < 4)
    return { messages };
  const groups: Message[][] = [];
  for (const message of messages) {
    if (message.role === "tool" && groups.length) groups.at(-1)!.push(message);
    else groups.push([message]);
  }
  let tail: Message[] = [];
  let chars = 0;
  let split = groups.length;
  while (split > 0) {
    const group = groups[split - 1];
    const size = JSON.stringify(group).length;
    if (tail.length && chars + size > maxChars * 0.65) break;
    tail = [...group, ...tail];
    chars += size;
    split--;
  }
  const removed = groups.slice(0, split).flat();
  if (!removed.length) return { messages };
  const summary =
    "Extractive history digest; omissions are intentional. Consult original records for full details.\n" +
    removed
      .map((m) => `[${m.id} ${m.role}] ${m.content.slice(0, 240)}`)
      .join("\n")
      .slice(-Math.floor(maxChars * 0.3));
  const message: Message = {
    id: "compaction-" + removed.at(-1)!.id,
    sessionId: messages[0].sessionId,
    role: "user",
    content: summary,
    createdAt: new Date().toISOString(),
  };
  return {
    messages: [message, ...tail],
    summary,
    sourceIds: removed.map((m) => m.id),
  };
}
