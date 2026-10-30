// The room's view rules (THE-1996), pure: the question pinned for the owner,
// the ids in a message, a tool call's quiet line, the state a coordinator's
// line names.
import type { ChatItem } from "@armada/protocol";
import type { Group } from "@/fleet/overview";
import type { FleetState, FoldedInboxItem } from "@/fleet/state";

export interface Choice {
  label: string;
  /** Said "(recommended)" in the question: the primary button. */
  recommended: boolean;
}

/** A question for the owner as V1 stores it: its text, then an "Options:" list (numbered or bulleted). */
export function parseQuestion(body: string): { question: string; choices: Choice[] } {
  const [question = body, options = ""] = body.split(/\n\s*\nOptions:\s*\n/);
  const choices = options
    .split("\n")
    .map((line) => line.match(/^\s*(?:\d+[.)]|[-*•])\s+(.+?)\s*$/)?.[1])
    .filter((label): label is string => !!label)
    .map((label) => {
      const plain = label.replace(/\s*(?:\((?:recommended)\)|[—–-]\s*recommended)\s*$/i, "");
      return { label: plain, recommended: plain !== label };
    });
  return { question: question.trim(), choices };
}

/** The questions waiting for the owner, oldest first: the open owner requests of the fold's inbox. */
export const ownerQuestions = (state: FleetState): FoldedInboxItem[] =>
  state.inbox.filter((i) => i.kind === "owner-request");

/** A piece of a message and where it starts in it. */
export type Segment = { text: string; kind: "text" | "ticket" | "pr"; at: number };
const IDS = /\b([A-Z][A-Z0-9]*-\d+)\b|(#\d+)\b/g;

/** A message cut at its ticket ids (`ABC-12`) and pull requests (`#34`), set apart in the room. */
export function segments(text: string): Segment[] {
  const out: Segment[] = [];
  let at = 0;
  for (const m of text.matchAll(IDS)) {
    const index = m.index ?? 0;
    if (index > at) out.push({ text: text.slice(at, index), kind: "text", at });
    out.push({ text: m[0], kind: m[1] ? "ticket" : "pr", at: index });
    at = index + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), kind: "text", at });
  return out;
}

/** The first ticket a message names, if any. */
const firstTicket = (text: string) => segments(text).find((s) => s.kind === "ticket")?.text ?? null;

/**
 * The state each coordinator line shows on its dot: the named ticket's group
 * now, on the newest line naming it; older lines about it show a quiet dot,
 * since the state they told has passed.
 */
export function lineGroups(
  items: readonly ChatItem[],
  groupOf: (ticket: string) => Group | null,
): Map<string, Group | null> {
  const out = new Map<string, Group | null>();
  const told = new Set<string>();
  for (let k = items.length - 1; k >= 0; k--) {
    const item = items[k];
    if (item?.kind !== "line") continue;
    const ticket = firstTicket(item.body);
    out.set(item.id, ticket && !told.has(ticket) ? groupOf(ticket) : null);
    if (ticket) told.add(ticket);
  }
  return out;
}

const brief = (value: unknown): string => {
  const text = typeof value === "string" ? JSON.stringify(value) : (JSON.stringify(value) ?? "");
  return text.length > 48 ? `${text.slice(0, 47)}…` : text;
};

/** A tool call's one quiet line: its arguments, short, and how it ended. */
export function toolLine(item: Extract<ChatItem, { kind: "tool" }>): { args: string; outcome: string } {
  const input = item.input;
  const args =
    input && typeof input === "object" && !Array.isArray(input)
      ? Object.entries(input)
          .map(([k, v]) => `${k}: ${brief(v)}`)
          .join(", ")
      : input === null
        ? ""
        : brief(input);
  if (item.output === null) return { args, outcome: "running" };
  if (!item.failed) return { args, outcome: "done" };
  try {
    const facts = JSON.parse(item.output) as { message?: unknown };
    if (typeof facts.message === "string" && facts.message) return { args, outcome: `refused: ${facts.message}` };
  } catch {
    /* Not the facts' JSON: said plainly below. */
  }
  return { args, outcome: "failed" };
}

/** A tool's input or output as it opens: JSON indented, other text as it came. */
export function pretty(value: unknown): string {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2) ?? "";
}
