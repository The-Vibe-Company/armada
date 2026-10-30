// The room's markdown rules (THE-2050), pure: the ids a message names turned
// into links, GitHub's alerts, a fence's title, the sanitizer's schema, when an
// owner's message folds, and a table as Markdown or CSV for the clipboard.
import { defaultSchema } from "rehype-sanitize";
import { sessionHref } from "@/session/route";
import { segments } from "./view";

/** The few mdast fields these plugins read and write. */
interface MdNode {
  type: string;
  value?: string;
  url?: string;
  meta?: string | null;
  children?: MdNode[];
  data?: { hProperties?: Record<string, unknown> };
}

/** Ticket ids (`THE-12`) link to their session page, `#34` to the pull request on the project's repository. */
export function remarkIds({ repository }: { repository: string }) {
  const pullUrl = (n: string) => `https://github.com/${repository}/pull/${n}`;
  const split = (text: string): MdNode[] =>
    segments(text).map((s) => {
      if (s.kind === "text") return { type: "text", value: s.text };
      const ticket = s.kind === "ticket";
      return {
        type: "link",
        url: ticket ? sessionHref(s.text) : pullUrl(s.text.slice(1)),
        children: [{ type: "text", value: s.text }],
        data: { hProperties: ticket ? { dataTicket: s.text } : { dataPr: s.text } },
      };
    });
  const visit = (node: MdNode) => {
    if (!node.children || node.type === "link" || node.type === "linkReference") return;
    node.children = node.children.flatMap((child) => (child.type === "text" ? split(child.value ?? "") : [child]));
    for (const child of node.children) visit(child);
  };
  return (tree: MdNode) => visit(tree);
}

/** A fence's meta (` ```ts title="a.ts" `) kept on its code, for the block's header. */
export function remarkFenceMeta() {
  const visit = (node: MdNode) => {
    if (node.type === "code" && node.meta) {
      node.data = { ...node.data, hProperties: { ...node.data?.hProperties, dataMeta: node.meta } };
    }
    node.children?.forEach(visit);
  };
  return (tree: MdNode) => visit(tree);
}

export const ALERTS = ["note", "tip", "important", "warning", "caution"] as const;
export type Alert = (typeof ALERTS)[number];
const ALERT_MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\r?\n|$)/i;

/** GitHub's alerts: a quote opening on `[!NOTE]` (or Tip, Important, Warning, Caution) is marked with its kind. */
export function remarkAlerts() {
  const read = (node: MdNode) => {
    if (node.type !== "blockquote") return;
    const paragraph = node.children?.[0];
    const text = paragraph?.children?.[0];
    if (paragraph?.type !== "paragraph" || text?.type !== "text") return;
    const match = ALERT_MARKER.exec(text.value ?? "");
    if (!match?.[1]) return;
    const rest = (text.value ?? "").slice(match[0].length);
    if (rest) text.value = rest;
    else {
      paragraph.children?.shift();
      // A line break right after the marker (remark-breaks) goes with it.
      if (paragraph.children?.[0]?.type === "break") paragraph.children.shift();
      if (!paragraph.children?.length) node.children?.shift();
    }
    node.data = { ...node.data, hProperties: { ...node.data?.hProperties, dataAlert: match[1].toLowerCase() } };
  };
  const visit = (node: MdNode) => {
    node.children?.forEach(visit);
    read(node);
  };
  return (tree: MdNode) => visit(tree);
}

/** GitHub's own sanitizing, keeping only the marks these plugins add (raw HTML cannot add anything else). */
export const SANITIZE = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [["className", /^language-./], "dataMeta"],
    blockquote: [...(defaultSchema.attributes?.blockquote ?? []), ["dataAlert", ...ALERTS]],
    a: [...(defaultSchema.attributes?.a ?? []), "dataTicket", "dataPr"],
  },
};

/** The header's name for a fence: its `title=` or `filename=`, else a word with a dot or a slash, else null. */
export function fenceTitle(meta: string | null | undefined): string | null {
  if (!meta) return null;
  const named = meta.match(/(?:title|filename|file)=(?:"([^"]+)"|'([^']+)'|(\S+))/);
  if (named) return named[1] ?? named[2] ?? named[3] ?? null;
  return meta.split(/\s+/).find((word) => /[./]/.test(word) && !word.includes("=")) ?? null;
}

/** The language a fence names in its code's class (`language-ts`), or null. */
export function fenceLanguage(className: unknown): string | null {
  const classes = Array.isArray(className) ? className.map(String) : String(className ?? "").split(/\s+/);
  return (
    classes
      .find((c) => c.startsWith("language-"))
      ?.slice(9)
      .toLowerCase() || null
  );
}

/** The owner's messages fold past this many characters or lines (T3 Code's rule). */
export const FOLD_CHARS = 600;
export const FOLD_LINES = 8;
export const folds = (text: string) => text.length > FOLD_CHARS || text.split("\n").length > FOLD_LINES;

/** A link that leaves the app: anything but the app's own hash addresses. */
export const leaves = (href: string | undefined) => !!href && !href.startsWith("#");

const markdownCell = (cell: string) => cell.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
const csvCell = (cell: string) => (/[",\n\r]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell);

/** A table's rows (the head's first) as a GitHub table. */
export function tableMarkdown(rows: readonly (readonly string[])[]): string {
  const [head, ...body] = rows;
  if (!head) return "";
  const line = (cells: readonly string[]) => `| ${head.map((_, k) => markdownCell(cells[k] ?? "")).join(" | ")} |`;
  return [line(head), `| ${head.map(() => "---").join(" | ")} |`, ...body.map(line)].join("\n");
}

/** A table's rows as CSV (RFC 4180 quoting). */
export const tableCsv = (rows: readonly (readonly string[])[]): string =>
  rows.map((cells) => cells.map(csvCell).join(",")).join("\n");
