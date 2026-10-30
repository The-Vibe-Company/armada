// What tells the owner a room needs them (THE-2055), after T3 Code's
// `ThreadNotificationCoordinator.tsx`: a coordinator's turn that ends after
// writing ("Coordinator answered": the conversation, read at the turn's end,
// holds a message written since it began; a fast turn may never stream its
// words), or a question for the owner that opens
// (`owner-request` in the project's inbox), for a project whose room is not on
// screen. A focused window shows an in-app toast; one in the background an OS
// notification and the badge's count, when the owner left them on in
// Settings. Pure over an injected world: the platform's `Notification`, the
// focus, the room on screen, the switch, the toasts and the badge.
import type { ChatItem } from "@armada/protocol";
import type { FoldedInboxItem } from "@/fleet/state";
import type { ChatFrame } from "@/protocol/client";
import { parseQuestion } from "@/room/view";

export type NoticeKind = "answered" | "question";

export const NOTICE_TITLE: Record<NoticeKind, string> = {
  answered: "Coordinator answered",
  question: "Question for you",
};

export interface Notice {
  kind: NoticeKind;
  project: string;
  /** The project's name. */
  name: string;
  /** The first line of the answer or the question; empty when none was heard. */
  line: string;
  /** One per project and kind: a newer notice replaces the older one. */
  tag: string;
}

/** The part of a platform notification the notifier uses. */
export interface OsNotification {
  close(): void;
  onclick: ((event: Event) => void) | null;
}
export interface OsNotificationClass {
  new (title: string, options: { body: string; tag: string; silent: boolean }): OsNotification;
  readonly permission: NotificationPermission;
}

export interface NotifyWorld {
  /** The project whose room is on screen, if any. */
  onScreen(): string | null;
  /** Whether the window has the focus. */
  focused(): boolean;
  /** The Settings switch: OS notifications and the badge. */
  osEnabled(): boolean;
  /** The platform's notifications, when it has them. */
  Notification: OsNotificationClass | undefined;
  /** A project's name, by id. */
  nameOf(project: string): string;
  /** A project's conversation as the daemon reads it now (`chat.read`). */
  read(project: string): Promise<readonly ChatItem[]>;
  toast(notice: Notice): void;
  badge(count: number): void;
  /** Brings the window forward and opens the project's room. */
  open(project: string): void;
}

const LINE_MAX = 120;

/** The first line said, markdown's marks of a heading, a quote or a list left out, cut at 120 characters. */
export function firstLine(text: string): string {
  const line =
    text
      .split("\n")
      .map((l) =>
        l
          .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*•]\s+|\d+[.)]\s+)/, "")
          .replace(/\*\*|__|`/g, "")
          .trim(),
      )
      .find(Boolean) ?? "";
  return line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 1).trimEnd()}…` : line;
}

/** A project's turn as heard: since when it works, and what it streamed of its answer. */
interface Turn {
  since: string;
  text: string;
}

/**
 * What the coordinator wrote in a turn begun at `since`: the newest answer or
 * line of the reading said from then (a second's slack), unless stopped; null
 * for a turn that wrote nothing.
 */
export function answerOf(items: readonly ChatItem[], since: string): string | null {
  const from = Date.parse(since) - 1_000;
  for (let k = items.length - 1; k >= 0; k--) {
    const item = items[k];
    if (!item || item.kind === "tool" || item.kind === "owner") continue;
    if (!(Date.parse(item.at) >= from)) return null;
    if (item.aborted || !item.body.trim()) continue;
    return firstLine(item.body);
  }
  return null;
}

export interface Notifier {
  /** A live frame of any project (the client hears every subscribed project's); a turn's end resolves once told. */
  frame(frame: ChatFrame): Promise<void> | undefined;
  /** A project's open inbox items, on each folded state: the first reading sets what was already open. */
  inbox(project: string, items: readonly FoldedInboxItem[]): void;
  /** The window took the focus: the OS notifications are read, the badge clears. */
  focus(): void;
}

export function createNotifier(world: NotifyWorld): Notifier {
  const turns = new Map<string, Turn>();
  const asked = new Map<string, Set<string>>();
  const shown = new Map<string, OsNotification>();

  function present(kind: NoticeKind, project: string, line: string) {
    if (world.onScreen() === project) return;
    const notice: Notice = { kind, project, name: world.nameOf(project), line, tag: `${project}:${kind}` };
    if (world.focused()) return world.toast(notice);
    const Os = world.Notification;
    if (!world.osEnabled() || !Os || Os.permission !== "granted") return;
    let note: OsNotification;
    try {
      note = new Os(NOTICE_TITLE[kind], {
        body: line ? `${notice.name}\n${line}` : notice.name,
        tag: notice.tag,
        silent: true,
      });
    } catch {
      // A platform may list notifications and still refuse to show one.
      return;
    }
    shown.get(notice.tag)?.close();
    shown.set(notice.tag, note);
    world.badge(shown.size);
    note.onclick = () => {
      note.close();
      if (shown.get(notice.tag) === note) shown.delete(notice.tag);
      world.badge(shown.size);
      world.open(project);
    };
  }

  return {
    frame(frame) {
      const held = turns.get(frame.project);
      if (frame.type === "chat.delta") {
        if (held && frame.kind === "text") turns.set(frame.project, { ...held, text: frame.text });
        return;
      }
      if (frame.type !== "chat.turn") return;
      if (frame.state !== "idle") {
        if (!held) turns.set(frame.project, { since: frame.since, text: "" });
        return;
      }
      turns.delete(frame.project);
      // Only a turn seen to work: the idle turn each subscription starts with says nothing.
      if (!held || world.onScreen() === frame.project) return;
      const streamed = held.text.trim() ? firstLine(held.text) : null;
      return world
        .read(frame.project)
        .then(
          (items) => answerOf(items, held.since),
          () => streamed,
        )
        .then((line) => {
          if (line !== null) present("answered", frame.project, line);
        });
    },
    inbox(project, items) {
      const open = items.filter((i) => i.kind === "owner-request");
      const seen = asked.get(project);
      asked.set(project, new Set(open.map((i) => i.id)));
      // The questions already open when the app first read the project were never news here.
      if (!seen) return;
      for (const item of open)
        if (!seen.has(item.id)) present("question", project, firstLine(parseQuestion(item.body).question));
    },
    focus() {
      if (!shown.size) return;
      for (const note of shown.values()) note.close();
      shown.clear();
      world.badge(0);
    },
  };
}
