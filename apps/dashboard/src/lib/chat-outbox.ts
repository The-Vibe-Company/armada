import type { ChatItem } from "./chat";

export type PendingMessage = {
  requestId: string;
  promptId: string;
  text: string;
  at: number;
};

export function unconfirmedMessages(pending: PendingMessage[], items: ChatItem[]) {
  if (pending.length === 0) return pending;
  const confirmed = new Set(items.flatMap((item) => (item.kind === "user" ? [item.promptId] : [])));
  return pending.filter((message) => !confirmed.has(message.promptId));
}
