// A dotenv file that a POSIX shell can also `source`: `KEY=value` lines,
// optional `export`, single or double quotes, `#` comments. Pure text in and
// out; reading and writing the file is machine.ts's job.

export interface DotenvFile {
  /** Assigned keys; when a key repeats, the last assignment wins, as in a shell. */
  values: Record<string, string>;
  /** 1-based numbers of non-blank, non-comment lines that are not `KEY=value`. Never their content. */
  invalidLines: number[];
  /** Every key on a `KEY=...` line, including lines whose value is malformed. */
  assigned: string[];
}

const ASSIGNMENT = /^\s*(export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/**
 * Reads one shell word (quotes, backslash escapes), stopping at unquoted
 * whitespace. Returns the value and the trailing `# comment`, if any; null
 * when malformed or followed by anything but a comment.
 */
function shellWord(raw: string): { value: string; comment: string } | null {
  let out = "";
  let k = 0;
  while (k < raw.length) {
    const c = raw.charAt(k);
    if (c === " " || c === "\t") break;
    if (c === "'") {
      const end = raw.indexOf("'", k + 1);
      if (end < 0) return null;
      out += raw.slice(k + 1, end);
      k = end + 1;
    } else if (c === '"') {
      k++;
      for (;;) {
        if (k >= raw.length) return null;
        const d = raw.charAt(k);
        if (d === '"') break;
        const next = raw.charAt(k + 1);
        if (d === "\\" && (next === '"' || next === "\\" || next === "$" || next === "`")) {
          out += next;
          k += 2;
        } else {
          out += d;
          k++;
        }
      }
      k++;
    } else if (c === "\\") {
      if (k + 1 >= raw.length) return null;
      out += raw.charAt(k + 1);
      k += 2;
    } else {
      out += c;
      k++;
    }
  }
  // Only a comment may follow the value.
  const rest = raw.slice(k).trim();
  return rest === "" || rest.startsWith("#") ? { value: out, comment: rest } : null;
}

function parseLine(line: string): { key: string; value: string } | "blank" | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return "blank";
  const m = ASSIGNMENT.exec(line);
  if (!m) return null;
  const word = shellWord(m[3] ?? "");
  return word === null ? null : { key: m[2] ?? "", value: word.value };
}

const splitLines = (text: string) => text.split(/\r?\n/);

export function parseDotenv(text: string): DotenvFile {
  // A Map, then fromEntries: a key such as __proto__ stays a plain own property.
  const values = new Map<string, string>();
  const invalidLines: number[] = [];
  const assigned = new Set<string>();
  splitLines(text).forEach((line, index) => {
    const key = ASSIGNMENT.exec(line)?.[2];
    if (key !== undefined) assigned.add(key);
    const parsed = parseLine(line);
    if (parsed === null) invalidLines.push(index + 1);
    else if (parsed !== "blank") values.set(parsed.key, parsed.value);
  });
  return { values: Object.fromEntries(values), invalidLines, assigned: [...assigned] };
}

// No `~`: a shell expands it at the start of a word or after `:` in an assignment.
const SHELL_SAFE = /^[A-Za-z0-9_\-.:/@+=,%]+$/;

/** Formats a value so that both this parser and a POSIX shell read it back unchanged. */
export function formatDotenvValue(key: string, value: string): string {
  // A line break would split the assignment; no error message ever quotes the value.
  if (/[\r\n\0]/.test(value)) throw new Error(`the value for ${key} contains a line break and cannot be stored`);
  if (value === "") return "''";
  return SHELL_SAFE.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Applies `updates` to dotenv text: a string sets the key, null removes it.
 * The first assignment of a key is rewritten in place (keeping `export`), later
 * duplicates are dropped so they cannot override it, and new keys are appended.
 * Every other line, comment and blank line is kept as it was, and so is a
 * comment at the end of a rewritten line.
 */
export function updateDotenv(text: string, updates: Record<string, string | null>): string {
  const lines = text === "" ? [] : splitLines(text);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const m = ASSIGNMENT.exec(line);
    const key = m?.[2];
    if (!m || key === undefined || !Object.hasOwn(updates, key)) {
      out.push(line);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    const value = updates[key];
    if (value === null || value === undefined) continue;
    const comment = shellWord(m[3] ?? "")?.comment;
    out.push(`${m[1] ?? ""}${key}=${formatDotenvValue(key, value)}${comment ? ` ${comment}` : ""}`);
  }
  for (const [key, value] of Object.entries(updates)) {
    if (seen.has(key) || value === null) continue;
    out.push(`${key}=${formatDotenvValue(key, value)}`);
  }
  return out.length ? `${out.join("\n")}\n` : "";
}
