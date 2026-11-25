import type { ChatItem } from "./chat";

export type PendingMessage = {
  requestId: string;
  promptId: string;
  text: string;
  at: number;
  accepted?: boolean;
  failure?: string;
};

export function unconfirmedMessages(pending: PendingMessage[], items: ChatItem[]) {
  if (pending.length === 0) return pending;
  const confirmed = new Set(items.flatMap((item) => (item.kind === "user" ? [item.promptId] : [])));
  return pending.filter((message) => !confirmed.has(message.requestId) && !confirmed.has(message.promptId));
}

export function failPendingMessage(pending: PendingMessage[], promptId: string, reason: string) {
  if (!pending.some((message) => message.requestId === promptId || message.promptId === promptId)) return pending;
  return pending.map((message) =>
    message.requestId === promptId || message.promptId === promptId ? { ...message, failure: reason } : message,
  );
}
