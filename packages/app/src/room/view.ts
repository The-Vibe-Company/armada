// The room's view rules (THE-1996), pure: the question pinned for the owner,
// the ids in a message, the state a coordinator's line names, and the
// coordinator's work as T3 Code's rows (THE-2053).
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
    .map(choiceOf);
  return { question: question.trim(), choices };
}

/** One choice as written: "(recommended)" or "— recommended" at its end makes it the primary one. */
export function choiceOf(label: string): Choice {
  const plain = label.replace(/\s*(?:\((?:recommended)\)|[—–-]\s*recommended)\s*$/i, "");
  return { label: plain, recommended: plain !== label };
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

type Tool = Extract<ChatItem, { kind: "tool" }>;

/** A field of a tool's input, when it is a non-blank string or a whole number. */
function field(item: Tool, key: string): string | null {
  const input = item.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = (input as Record<string, unknown>)[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return null;
}

/** A tool call's sentence, from its name and input (THE-2053): "Launched THE-12", "Merged #34". */
export function workLabel(item: Tool): string {
  const ticket = field(item, "ticket");
  const pr = field(item, "pr");
  const on = (verb: string, fallback: string) => (ticket ? `${verb} ${ticket}` : fallback);
  switch (item.name) {
    case "fleet.status":
      return "Read the fleet";
    case "inbox.list":
      return "Read the inbox";
    case "inbox.answer":
      return "Answered an inbox item";
    case "worker.launch":
      return on("Launched", "Launched a worker");
    case "worker.relaunch":
      return on("Relaunched", "Relaunched a worker");
    case "worker.message":
      return ticket ? `Messaged ${ticket}'s worker` : "Messaged a worker";
    case "worker.stop":
      return ticket ? `Stopped ${ticket}'s worker` : "Stopped a worker";
    case "merge.check":
      return pr ? `Checked #${pr}` : "Checked a pull request";
    case "merge.run":
      return pr ? `Merged #${pr}` : "Merged a pull request";
    case "hold.add":
      return "Paused merges";
    case "hold.clear":
      return "Cleared a merge pause";
    case "owner.ask":
      return ticket ? `Asked you about ${ticket}` : "Asked you a question";
    case "rules.set":
      return "Changed the rules";
  }
  if (item.name.startsWith("ticket.")) return on("Read", "Read a ticket");
  return ticket ? `Used ${item.name} on ${ticket}` : `Used ${item.name}`;
}

export type WorkIcon = "eye" | "file" | "rocket" | "message" | "square" | "merge" | "help" | "sliders" | "wrench";

/** The icon a tool call's row wears, by its name. */
export function workIcon(name: string): WorkIcon {
  if (name === "fleet.status" || name === "inbox.list") return "eye";
  if (name.startsWith("ticket.")) return "file";
  if (name === "worker.launch" || name === "worker.relaunch") return "rocket";
  if (name === "worker.message") return "message";
  if (name === "worker.stop") return "square";
  if (name.startsWith("merge.")) return "merge";
  if (name === "owner.ask") return "help";
  if (name.startsWith("rules.")) return "sliders";
  return "wrench";
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const times = (n: number) => (n === 1 ? "" : ` ${n} times`);

/** A kind of call in a group's sentence, how it is counted, and its rank (changes first, reads, then the rest). */
function kindOf(name: string): { key: string; rank: number; label: (n: number) => string } {
  switch (name) {
    case "fleet.status":
      return { key: name, rank: 1, label: (n) => `Read the fleet${times(n)}` };
    case "inbox.list":
      return { key: name, rank: 1, label: (n) => `Read the inbox${times(n)}` };
    case "inbox.answer":
      return { key: name, rank: 0, label: (n) => `Answered ${plural(n, "inbox item", "inbox items")}` };
    case "worker.launch":
      return { key: name, rank: 0, label: (n) => `Launched ${plural(n, "worker", "workers")}` };
    case "worker.relaunch":
      return { key: name, rank: 0, label: (n) => `Relaunched ${plural(n, "worker", "workers")}` };
    case "worker.message":
      return { key: name, rank: 0, label: (n) => `Messaged ${plural(n, "worker", "workers")}` };
    case "worker.stop":
      return { key: name, rank: 0, label: (n) => `Stopped ${plural(n, "worker", "workers")}` };
    case "merge.check":
      return { key: name, rank: 1, label: (n) => `Checked ${plural(n, "pull request", "pull requests")}` };
    case "merge.run":
      return { key: name, rank: 0, label: (n) => `Merged ${plural(n, "pull request", "pull requests")}` };
    case "hold.add":
    case "hold.clear":
      return { key: "hold", rank: 0, label: (n) => `Changed merge pauses${times(n)}` };
    case "owner.ask":
      return { key: name, rank: 0, label: (n) => `Asked you ${plural(n, "question", "questions")}` };
    case "rules.set":
      return { key: name, rank: 0, label: (n) => `Changed the rules${times(n)}` };
  }
  if (name.startsWith("ticket."))
    return { key: "ticket", rank: 1, label: (n) => `Read ${plural(n, "ticket", "tickets")}` };
  return { key: "other", rank: 2, label: (n) => `Used ${plural(n, "tool", "tools")}` };
}

/**
 * A group's sentence (T3 Code's `summarizeToolGroup`): its calls counted by
 * kind, at most two kinds named (changes before reads before the rest, then in
 * the order they came), the others counted: "Read the fleet 3 times and
 * launched 2 workers", "…, launched 2 workers and 1 other action".
 */
export function summarizeWork(tools: readonly Tool[]): { summary: string; failed: boolean } {
  const kinds = new Map<string, { index: number; rank: number; count: number; label: (n: number) => string }>();
  for (const tool of tools) {
    const kind = kindOf(tool.name);
    const seen = kinds.get(kind.key);
    if (seen) seen.count++;
    else kinds.set(kind.key, { index: kinds.size, rank: kind.rank, count: 1, label: kind.label });
  }
  const named = [...kinds.values()]
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, 2)
    .sort((a, b) => a.index - b.index);
  const labels = named.map((k) => k.label(k.count));
  const rest = tools.length - named.reduce((n, k) => n + k.count, 0);
  if (rest > 0) labels.push(plural(rest, "other action", "other actions"));
  const words = labels.map((label, k) => (k === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1)));
  const summary = words.length < 3 ? words.join(" and ") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
  return { summary, failed: tools.some((t) => t.failed) };
}

/** A turn's length as its fold says it: "12s", "2m 03s", "1h 04m". */
export function workDuration(ms: number): string {
  const total = Math.max(1, Math.round((Number.isFinite(ms) ? ms : 0) / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m ${pad(total % 60)}s`;
  return `${Math.floor(total / 3600)}h ${pad(Math.floor((total % 3600) / 60))}m`;
}

type Said = Exclude<ChatItem, { kind: "tool" }>;
/** A turn's tool calls, at the place of its first: one row alone, or a group. */
export type Work = { id: string; at: string; tools: Tool[] };
/**
 * One row of the thread: a message or a coordinator's line, a turn's work
 * still open, or a finished turn's work folded under "Worked for 2m 03s"
 * (`label`), above its answer.
 */
export type ThreadRow =
  | { kind: "said"; id: string; item: Said }
  | { kind: "work"; id: string; work: Work }
  | { kind: "fold"; id: string; work: Work; label: string };

/**
 * The thread's rows (THE-2053). A turn's tool calls are one work row where its
 * first call came. The turn ends at the next message: the owner's leaves its
 * work open; the coordinator's answer, or its own line (what it says on its
 * own, as in a turn it ran on a fleet notice), folds the work above it:
 * "Worked for <first call to answer>", or "You stopped this response" when
 * the answer was stopped. A line stays outside the fold, below it.
 */
export function workRows(items: readonly ChatItem[]): ThreadRow[] {
  const out: ThreadRow[] = [];
  let work: Work | null = null;
  for (const item of items) {
    if (item.kind === "tool") {
      if (work) work.tools.push(item);
      else work = { id: item.id, at: item.at, tools: [item] };
      continue;
    }
    if (work) {
      const id = `work:${work.id}`;
      if (item.kind === "owner") out.push({ kind: "work", id, work });
      else {
        const label = item.aborted
          ? "You stopped this response"
          : `Worked for ${workDuration(Date.parse(item.at) - Date.parse(work.at))}`;
        out.push({ kind: "fold", id, work, label });
      }
      work = null;
    }
    out.push({ kind: "said", id: item.id, item });
  }
  if (work) out.push({ kind: "work", id: `work:${work.id}`, work });
  return out;
}

/** A refused call's message, from the facts' JSON it answered (`{"ok":false,"message":…}`). */
export function refusal(item: Tool): string | null {
  if (!item.failed || item.output === null) return null;
  try {
    const facts = JSON.parse(item.output) as { message?: unknown };
    return typeof facts.message === "string" && facts.message ? facts.message : null;
  } catch {
    return null;
  }
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

/** A message's full date for its time's tooltip, in the viewer's zone: "Tuesday, 10 March 2026 at 09:01". */
export function fullTime(at: string, zone: string): string {
  const time = Date.parse(at);
  if (Number.isNaN(time)) return "";
  try {
    return new Intl.DateTimeFormat("en-GB", { dateStyle: "full", timeStyle: "short", timeZone: zone }).format(time);
  } catch {
    return new Date(time).toISOString();
  }
}
