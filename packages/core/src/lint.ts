// Pure readability rules shared by the CLI's pre-launch lint and brief.
import { SPEC_TITLE } from "./model.ts";

export interface LintRules {
  inShort: string;
  inShortParts: readonly string[];
  titleMax: number;
  severity: "warning" | "error";
}

export const LINT_DEFAULTS: LintRules = {
  inShort: "## In short",
  inShortParts: ["What changes", "Why", "Done when", "Depends on"],
  titleMax: 60,
  severity: "warning",
};

export interface LintProblem {
  code: "in-short" | "in-short-part" | "title-length" | "title-code" | "spec-title";
  severity: LintRules["severity"];
  message: string;
  fix: string;
}

// Example blocks cannot satisfy a ticket's headings or named parts.
function prose(markdown: string): string[] {
  let fence: { mark: string; length: number } | null = null;
  return markdown
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => {
      const opening = line.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (fence) {
        const closing = line.trim();
        if (closing.length >= fence.length && [...closing].every((c) => c === fence?.mark)) fence = null;
        return "";
      }
      if (opening?.[1]) {
        fence = { mark: opening[1][0] ?? "`", length: opening[1].length };
        return "";
      }
      return line;
    });
}

/** null means absent; an empty string means the heading exists with no summary. */
export function extractInShort(description: string, heading = LINT_DEFAULTS.inShort): string | null {
  const lines = prose(description);
  const start = lines.findIndex((line) => line.trimEnd() === heading);
  if (start < 0) return null;
  const level = heading.match(/^#+/)?.[0].length ?? 2;
  const rest: string[] = [];
  const original = description.replaceAll("\r\n", "\n").split("\n");
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const next = line.match(/^(#{1,6})\s/);
    if ((next?.[1] && next[1].length <= level) || /^\s*---\s*$/.test(line)) break;
    rest.push(original[index] ?? "");
  }
  return rest.join("\n").trim();
}

export function lintTicket(
  ticket: { title: string; description: string | null; isSpec: boolean },
  rules: LintRules = LINT_DEFAULTS,
): LintProblem[] {
  const problems: LintProblem[] = [];
  const add = (code: LintProblem["code"], message: string, fix: string) =>
    problems.push({ code, severity: rules.severity, message, fix });
  const section = extractInShort(ticket.description ?? "", rules.inShort);
  if (section === null)
    add("in-short", `Missing ${rules.inShort} section.`, `Add ${rules.inShort} with ${rules.inShortParts.join(", ")}.`);
  else {
    const lines = prose(section).map((line) =>
      line
        .trim()
        .replace(/^(?:[-*+]\s+|#{1,6}\s+)/, "")
        .replace(/[*_]/g, ""),
    );
    for (const part of rules.inShortParts) {
      if (!lines.some((line) => line.startsWith(part) && /^(?:\s*[:.]|\s*$)/.test(line.slice(part.length))))
        add("in-short-part", `Missing ${part} in ${rules.inShort}.`, `Add a "${part}:" part inside ${rules.inShort}.`);
    }
  }
  const title = ticket.title.trim();
  const spec = ticket.isSpec ? title.match(SPEC_TITLE) : null;
  const validNumber = (value: string | undefined) =>
    value !== undefined && Number.isSafeInteger(Number(value)) && Number(value) > 0;
  if (
    ticket.isSpec &&
    (!spec || !validNumber(spec[1]) || (spec[2] !== undefined && !validNumber(spec[2])) || !spec[3]?.trim())
  )
    add(
      "spec-title",
      "Malformed spec title.",
      'Use "Spec N — Name" or "Spec N/M — Name" with positive integer numbers.',
    );
  const name = spec?.[3]?.trim() ?? title;
  const length = [...name].length;
  if (length > rules.titleMax)
    add(
      "title-length",
      `Title has ${length} characters; the limit is ${rules.titleMax}.`,
      `Shorten the title to at most ${rules.titleMax} characters after any spec prefix.`,
    );
  const codePatterns: [RegExp, string][] = [
    [/`/, "backticks"],
    [/(?:[\p{L}\p{N}_.-]+\/|\/)[\p{L}\p{N}_.-]+/u, "paths"],
    [/\b[\w-]+\.[a-zA-Z]{1,10}\b/, "file extensions"],
    [/(?<![\p{L}\p{N}])\p{Ll}+\p{Lu}[\p{L}\p{N}]*/u, "camelCase tokens"],
    [/[\p{L}\p{N}]+_[\p{L}\p{N}_]+/u, "snake_case tokens"],
    [/(?:[\p{L}\p{N}_]+\([^)]*\)|\(\s*\))/u, "function parentheses"],
  ];
  for (const [pattern, what] of codePatterns)
    if (pattern.test(name))
      add(
        "title-code",
        `Title contains ${what}.`,
        `Describe the outcome in plain words; move ${what} to the technical detail.`,
      );
  return problems;
}

export const lintWarning = (ticket: string, problem: LintProblem): string =>
  `${ticket}: ${problem.message} Fix: ${problem.fix}`;
