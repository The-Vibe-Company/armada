/**
 * The Markdown agents write, read into a small tree React renders as text: no HTML is ever interpreted, and a
 * link keeps its target only for http(s) and mailto. Anything not recognised stays as the text it was.
 */
export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "link"; href: string; children: Inline[] };

export type Block =
  | { kind: "paragraph"; children: Inline[] }
  | { kind: "heading"; level: 1 | 2 | 3; children: Inline[] }
  | { kind: "code"; language: string; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: Inline[][] }
  | { kind: "quote"; children: Inline[] }
  | { kind: "rule" };

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const NUMBERED = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1] ?? "```";
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").trimStart().startsWith(marker)) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      index += 1;
      blocks.push({ kind: "code", language: fence[2] ?? "", text: body.join("\n") });
      continue;
    }
    if (isRule(line)) {
      blocks.push({ kind: "rule" });
      index += 1;
      continue;
    }
    const title = heading(line);
    if (title) {
      blocks.push({ kind: "heading", level: title.level, children: parseInline(title.text) });
      index += 1;
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index] ?? "")) {
        body.push(QUOTE.exec(lines[index] ?? "")?.[1] ?? "");
        index += 1;
      }
      blocks.push({ kind: "quote", children: parseInline(body.join("\n")) });
      continue;
    }
    const numbered = NUMBERED.exec(line);
    if (BULLET.test(line) || numbered) {
      const ordered = numbered !== null;
      const pattern = ordered ? NUMBERED : BULLET;
      const items: string[] = [];
      while (index < lines.length) {
        const current = lines[index] ?? "";
        const match = pattern.exec(current);
        if (match) items.push(match[ordered ? 2 : 1] ?? "");
        else if (current.trim() && /^\s+/.test(current) && items.length > 0) {
          items[items.length - 1] += `\n${current.trim()}`;
        } else break;
        index += 1;
      }
      blocks.push({
        kind: "list",
        ordered,
        start: ordered ? Number(numbered?.[1] ?? 1) : 1,
        items: items.map((item) => parseInline(item)),
      });
      continue;
    }
    const body: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? "";
      if (!current.trim() || FENCE.test(current) || heading(current) !== null || QUOTE.test(current)) break;
      if (body.length > 0 && (BULLET.test(current) || NUMBERED.test(current) || isRule(current))) break;
      body.push(current);
      index += 1;
    }
    blocks.push({ kind: "paragraph", children: parseInline(body.join("\n")) });
  }
  return blocks;
}

// Headings and rules are read by hand: the equivalent regexes backtrack badly on long runs of spaces.

function heading(line: string): { level: 1 | 2 | 3; text: string } | null {
  const body = line.replace(/^ {0,3}/, "");
  let hashes = 0;
  while (hashes < body.length && body[hashes] === "#") hashes += 1;
  if (hashes < 1 || hashes > 6 || !/^[ \t]/.test(body.slice(hashes))) return null;
  let text = body.slice(hashes).trim();
  let end = text.length;
  while (end > 0 && text[end - 1] === "#") end -= 1;
  if (end === 0 || /[ \t]/.test(text[end - 1] ?? "")) text = text.slice(0, end).trimEnd();
  return { level: Math.min(hashes, 3) as 1 | 2 | 3, text };
}

function isRule(line: string): boolean {
  const marks = line.replace(/[ \t]/g, "");
  if (/^ {4}/.test(line) || marks.length < 3) return false;
  const mark = marks[0];
  return (mark === "-" || mark === "*" || mark === "_") && [...marks].every((char) => char === mark);
}

/** A link target kept only when it is a web or mail address; anything else (javascript:, data:, relative) is text. */
export function safeHref(target: string): string | null {
  const trimmed = target.trim();
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:" ? url.href : null;
  } catch {
    return null;
  }
}

export function parseInline(source: string, autolink = true): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ kind: "text", text });
    text = "";
  };
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\" && index + 1 < source.length && /[\\`*_[\]()#>!-]/.test(source[index + 1] ?? "")) {
      text += source[index + 1];
      index += 2;
      continue;
    }
    if (char === "`") {
      const ticks = /^`+/.exec(source.slice(index))?.[0] ?? "`";
      const end = source.indexOf(ticks, index + ticks.length);
      if (end > index) {
        flush();
        out.push({ kind: "code", text: source.slice(index + ticks.length, end).trim() || " " });
        index = end + ticks.length;
        continue;
      }
    }
    if ((char === "*" || char === "_") && source[index + 1] === char) {
      const marker = char + char;
      const end = source.indexOf(marker, index + 2);
      if (end > index + 2) {
        flush();
        out.push({ kind: "strong", children: parseInline(source.slice(index + 2, end), autolink) });
        index = end + 2;
        continue;
      }
    }
    if ((char === "*" || char === "_") && source[index + 1] !== char && source[index + 1] !== " ") {
      const before = source[index - 1];
      const end = source.indexOf(char, index + 1);
      const wordInside = char === "_" && before !== undefined && /\w/.test(before);
      if (end > index + 1 && !wordInside && source[end - 1] !== " ") {
        flush();
        out.push({ kind: "em", children: parseInline(source.slice(index + 1, end), autolink) });
        index = end + 1;
        continue;
      }
    }
    if (char === "[") {
      const link = /^\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/.exec(source.slice(index));
      if (link) {
        const href = safeHref(link[2] ?? "");
        flush();
        // A label never holds a link of its own: `<a>` cannot nest.
        if (href) out.push({ kind: "link", href, children: parseInline(link[1] ?? "", false) });
        else out.push(...parseInline(link[1] ?? "", false));
        index += link[0].length;
        continue;
      }
    }
    if (autolink && char === "h" && /^https?:\/\//.test(source.slice(index, index + 8))) {
      const raw = /^https?:\/\/[^\s<>()]+/.exec(source.slice(index))?.[0] ?? "";
      const trimmed = raw.replace(/[.,;:!?'"]+$/, "");
      const href = safeHref(trimmed);
      if (href) {
        flush();
        out.push({ kind: "link", href, children: [{ kind: "text", text: trimmed }] });
        index += trimmed.length;
        continue;
      }
    }
    text += char;
    index += 1;
  }
  flush();
  return out;
}
