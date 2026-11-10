import type { ActionResult } from "@/lib/action";

/** A toast's tone: the #757 success and destructive colours, nothing else. */
export type ToastTone = "success" | "destructive";

export type ToastInput = { tone: ToastTone; title: string; description?: string };

export type ToastItem = ToastInput & { id: number; open: boolean };

/** At most this many toasts are open at once: the oldest closes first. */
export const TOAST_LIMIT = 3;

/** How long a toast stays before it closes on its own. A failure stays longer: it has more to read. */
export const TOAST_DURATION: Record<ToastTone, number> = { success: 5000, destructive: 8000 };

/** The toast for an action's result: its message on success, `failure` titling the reason on a refusal. */
export function toastFromResult(result: ActionResult, failure: string): ToastInput {
  return result.ok
    ? { tone: "success", title: result.message }
    : { tone: "destructive", title: failure, description: result.error };
}

const same = (a: ToastInput, b: ToastInput) =>
  a.tone === b.tone && a.title === b.title && a.description === b.description;

/**
 * The list after `next` is shown. Toasts already closed (their exit played) are dropped, the same message open twice
 * is shown once (the new one, so its timer restarts), and beyond `limit` the oldest open toasts close.
 */
export function addToast(list: readonly ToastItem[], next: ToastInput & { id: number }, limit = TOAST_LIMIT) {
  const kept = list.filter((item) => item.open && !same(item, next));
  const added: ToastItem[] = [...kept, { ...next, open: true }];
  const excess = added.length - limit;
  return excess > 0 ? added.map((item, index) => (index < excess ? { ...item, open: false } : item)) : added;
}

/** The list once toast `id` is dismissed: kept, closed, so its exit can play. */
export function closeToast(list: readonly ToastItem[], id: number): ToastItem[] {
  return list.map((item) => (item.id === id ? { ...item, open: false } : item));
}
