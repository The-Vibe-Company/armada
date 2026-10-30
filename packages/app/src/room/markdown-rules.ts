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
  alt?: string | null;
  meta?: string | null;
  children?: MdNode[];
  data?: { hProperties?: Record<string, unknown> };
}

/** The few hast fields `rehypeIds` reads and writes. */
interface HNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HNode[];
}
/** Where an id is never linked: inside a link already, or code. */
const AS_IS = new Set(["a", "code", "pre"]);

/** A ticket id's team prefix (`THE` of `THE-12`). */
export const ticketPrefix = (id: string) => id.replace(/-\d+$/, "");

/**
 * Ticket ids (`THE-12`) link to their session page, `#34` to the pull request
 * on the project's repository. Run on the sanitized tree, so raw HTML can
 * neither fake one nor have one linked inside its own link or code; a ticket
 * links only under one of the project's prefixes (`prefixes`, space-separated),
 * so `UTF-8` stays a word.
 */
export function rehypeIds({ repository, prefixes }: { repository: string; prefixes: string }) {
  const teams = new Set(prefixes.split(" ").filter(Boolean));
  const split = (text: string): HNode[] =>
    segments(text).map((s) => {
      const ticket = s.kind === "ticket";
      if (s.kind === "text" || (ticket && !teams.has(ticketPrefix(s.text)))) return { type: "text", value: s.text };
      return {
        type: "element",
        tagName: "a",
        properties: ticket
          ? { href: sessionHref(s.text), dataTicket: s.text }
          : { href: `https://github.com/${repository}/pull/${s.text.slice(1)}`, dataPr: s.text },
        children: [{ type: "text", value: s.text }],
      };
    });
  const visit = (node: HNode) => {
    if (!node.children || (node.tagName && AS_IS.has(node.tagName))) return;
    node.children = node.children.flatMap((child) => (child.type === "text" ? split(child.value ?? "") : [child]));
    for (const child of node.children) visit(child);
  };
  return (tree: HNode) => visit(tree);
}

/**
 * Images become links to them: the room never fetches a picture a message
 * names (a remote image would load on sight, telling its host the room read it).
 */
export function remarkImages() {
  const visit = (node: MdNode, inLink: boolean) => {
    if (!node.children) return;
    const linked = inLink || node.type === "link" || node.type === "linkReference";
    node.children = node.children.map((child) =>
      child.type === "imageReference" || (child.type === "image" && linked)
        ? // Inside a link (a badge), the link stays the one way out: the image is its words.
          { type: "text", value: child.alt ?? "" }
        : child.type === "image"
          ? { type: "link", url: child.url, children: [{ type: "text", value: child.alt || child.url || "image" }] }
          : child,
    );
    for (const child of node.children) visit(child, linked);
  };
  return (tree: MdNode) => visit(tree, false);
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

/** Elements that would fetch on sight: never kept, whoever wrote them. */
const FETCHING = new Set(["img", "picture", "source", "video", "audio"]);

/** GitHub's own sanitizing, keeping only the marks these plugins add (raw HTML cannot add anything else). */
export const SANITIZE = {
  ...defaultSchema,
  tagNames: (defaultSchema.tagNames ?? []).filter((tag) => !FETCHING.has(tag)),
  attributes: {
    ...defaultSchema.attributes,
    code: [["className", /^language-./], "dataMeta"],
    blockquote: [...(defaultSchema.attributes?.blockquote ?? []), ["dataAlert", ...ALERTS]],
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
