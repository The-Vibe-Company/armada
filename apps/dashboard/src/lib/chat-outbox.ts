import type { ChatItem } from "./chat";

export type PendingMessage = {
  requestId: string;
  promptId: string;
  text: string;
  at: number;
  kind?: "user" | "steer";
  mode?: string;
  confirmedBefore?: number;
  accepted?: boolean;
  failure?: string;
};

export function hasActivePendingMessages(pending: readonly PendingMessage[]) {
  return pending.some((message) => !message.failure);
}

export function unconfirmedMessages(pending: PendingMessage[], items: ChatItem[]) {
  if (pending.length === 0) return pending;
  const confirmedPrompts = new Set(items.flatMap((item) => (item.kind === "user" ? [item.promptId] : [])));
  const confirmedSteers = new Map<string, number>();
  for (const item of items) {
    if (item.kind === "steer") confirmedSteers.set(item.text, (confirmedSteers.get(item.text) ?? 0) + 1);
  }
  return pending.filter((message) => {
    if (message.kind === "steer") {
      return (confirmedSteers.get(message.text) ?? 0) <= (message.confirmedBefore ?? 0);
    }
    return !confirmedPrompts.has(message.requestId) && !confirmedPrompts.has(message.promptId);
  });
}

export function failPendingMessage(pending: PendingMessage[], promptId: string, reason: string) {
  if (!pending.some((message) => message.requestId === promptId || message.promptId === promptId)) return pending;
  return pending.map((message) =>
    message.requestId === promptId || message.promptId === promptId ? { ...message, failure: reason } : message,
  );
}
