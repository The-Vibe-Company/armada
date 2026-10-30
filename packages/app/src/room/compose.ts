// The owner's field's rules (THE-2051), after T3 Code's composer
// (`apps/web/src/composer-logic.ts`, `chat/composerPromptHistory.ts`,
// `composerDraftStore.ts`): which key sends, the owner's earlier messages
// walked with the arrows, the field's height, the drafts kept per project.
// No DOM here: `Composer.tsx` reads the field and applies what these decide.
import type { ChatItem } from "@armada/protocol";
import type { DaemonState } from "@/protocol/client";

/** One entry of `localStorage`: every project's draft, by project id. */
export const DRAFTS_KEY = "armada:composer-drafts:v1";
/** A draft is written this long after the last keystroke. */
export const DRAFT_WAIT = 300;
/** The field's tallest (`max-h-52`): past it, the field scrolls. */
export const FIELD_MAX = 208;

export interface KeyPress {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  /** An input method is composing: its Enter picks a character, it sends nothing. */
  isComposing?: boolean;
  /** 229 while an input method holds the key (Safari ends a composition with an Enter whose `isComposing` is false). */
  keyCode?: number;
}

/** What a key does in the field; null leaves it to the textarea (Shift+Enter inserts a line). */
export type Intent = "send" | "older" | "newer" | "leave" | "page-up" | "page-down";
/** The intents that walk the owner's earlier messages. */
export type Walk = Exclude<Intent, "send" | "page-up" | "page-down">;

/** Where the caret is: on the field's first line, on its last (a selection counts by its ends). */
export function caretLines(value: string, start: number, end: number): { first: boolean; last: boolean } {
  return { first: !value.slice(0, start).includes("\n"), last: !value.slice(end).includes("\n") };
}

/**
 * Enter and ⌘/Ctrl+Enter send; ↑ on the first line goes to an older message,
 * ↓ on the last line to a newer one while the owner walks them; Esc leaves.
 */
export function keyIntent(press: KeyPress, where: { first: boolean; last: boolean; browsing: boolean }): Intent | null {
  if (press.isComposing || press.keyCode === 229) return null;
  if (press.key === "Enter") return press.shiftKey || press.altKey ? null : "send";
  const plain = !press.shiftKey && !press.metaKey && !press.ctrlKey && !press.altKey;
  // PageUp and PageDown page the thread above the field (THE-2054).
  if (press.key === "PageUp" && plain) return "page-up";
  if (press.key === "PageDown" && plain) return "page-down";
  if (press.key === "ArrowUp" && plain && where.first) return "older";
  if (press.key === "ArrowDown" && plain && where.last && where.browsing) return "newer";
  if (press.key === "Escape" && where.browsing) return "leave";
  return null;
}

/** The owner's messages of the conversation, newest first, a message said twice in a row once. */
export function ownerHistory(items: readonly ChatItem[]): string[] {
  const said: string[] = [];
  for (const item of items) {
    if (item.kind !== "owner") continue;
    const body = item.body.trim();
    if (body && said[said.length - 1] !== body) said.push(body);
  }
  return said.reverse();
}

/**
 * The draft set aside while the owner walks their earlier messages, and the
 * message recalled (its place in the history, 0 the newest). `index` is null
 * once the owner edits a recalled message: the arrows move the caret again
 * (the edit is never replaced), the draft is still aside, and it comes back
 * once that message is sent, or on Esc.
 */
export interface Recall {
  index: number | null;
  draft: string;
}

/**
 * One step through the history: the field's new text and where the owner is,
 * or null when there is nowhere to go (the key is the textarea's again). Past
 * the newest, or on Esc, the draft set aside comes back.
 */
export function stepHistory(
  history: readonly string[],
  text: string,
  recall: Recall | null,
  intent: Walk,
): { text: string; recall: Recall | null } | null {
  const at = recall?.index ?? null;
  if (intent === "leave") return recall ? { text: recall.draft, recall: null } : null;
  if (recall && at === null) return null;
  if (intent === "older") {
    const index = at === null ? 0 : at + 1;
    const older = history[index];
    if (older === undefined) return null;
    return { text: older, recall: { index, draft: recall ? recall.draft : text } };
  }
  if (!recall || at === null) return null;
  const newer = history[at - 1];
  return newer === undefined
    ? { text: recall.draft, recall: null }
    : { text: newer, recall: { ...recall, index: at - 1 } };
}

/**
 * Once the daemon admitted `sent`: the field's next text (the draft set aside,
 * else nothing), or null when the owner already wrote something else meanwhile.
 */
export function afterSend(sent: string, current: string, recall: Recall | null): string | null {
  return current.trim() === sent ? (recall?.draft ?? "") : null;
}

/** The field's height for its content (its `scrollHeight` at `height: auto`, two lines at least): up to `FIELD_MAX`, then it scrolls. */
export function fieldHeight(scrollHeight: number): { height: number; scrolls: boolean } {
  return { height: Math.min(scrollHeight, FIELD_MAX), scrolls: scrollHeight > FIELD_MAX };
}

export type DraftStorage = Pick<Storage, "getItem" | "setItem">;
export interface Timers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}
const realTimers: Timers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The browser's `localStorage`, or null where there is none or it refuses access. */
export function browserStorage(): DraftStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readAll(storage: DraftStorage): Record<string, string> {
  try {
    const value: unknown = JSON.parse(storage.getItem(DRAFTS_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    return {};
  }
}

/** The project's kept draft, "" for none. */
export function draftOf(storage: DraftStorage | null, project: string): string {
  return storage ? (readAll(storage)[project] ?? "") : "";
}

/**
 * Keeps a project's draft: `keep` writes it `DRAFT_WAIT` after the last call,
 * `flush` writes a waiting one now (the room closing), `drop` forgets it (sent).
 * A full or refused storage loses the draft, never the message.
 */
export function draftKeeper(storage: DraftStorage, timers: Timers = realTimers) {
  let waiting: { project: string; text: string } | null = null;
  let timer: unknown = null;
  const write = (project: string, text: string) => {
    const all = readAll(storage);
    if (text.trim()) all[project] = text;
    else delete all[project];
    try {
      storage.setItem(DRAFTS_KEY, JSON.stringify(all));
    } catch {
      // Quota or privacy mode: the field still holds the text.
    }
  };
  const flush = () => {
    if (timer !== null) timers.clear(timer);
    timer = null;
    const draft = waiting;
    waiting = null;
    if (draft) write(draft.project, draft.text);
  };
  return {
    keep(project: string, text: string) {
      if (timer !== null) timers.clear(timer);
      waiting = { project, text };
      timer = timers.set(flush, DRAFT_WAIT);
    },
    flush,
    drop(project: string) {
      waiting = { project, text: "" };
      flush();
    },
  };
}

/** The coordinator's model, when the daemon says it: the saved one, else its provider's default. */
export function coordinatorModel(credentials: DaemonState["credentials"]): string | null {
  if (!credentials?.provider) return null;
  if (credentials.config?.model) return credentials.config.model;
  const schema = credentials.models?.find((m) => m.kind === credentials.provider)?.config;
  const model = (schema as { properties?: { model?: { default?: unknown } } } | null)?.properties?.model?.default;
  return typeof model === "string" && model ? model : null;
}
