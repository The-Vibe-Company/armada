import { parse } from "smol-toml";
import {
  HERDR_FULL_PERMISSION_ARGS,
  HERDR_PERMISSIONS,
  type HerdrHarness,
  type HerdrPermission,
  type HerdrProfile,
} from "./config.ts";
import type { HerdrProfileChoice, ProfileChoice } from "./routing.ts";

/** Actual Herdr kind; native dsh needs resumable input first (THE-949). */
export const herdrHarnessKind = (harness: HerdrHarness): Exclude<HerdrHarness, "deepseek"> =>
  harness === "deepseek" ? "opencode" : harness;

export const herdrHarnessLabel = (harness: HerdrHarness): string =>
  harness === "deepseek" ? "deepseek (OpenCode + DeepSeek model)" : harness;

/** Existing brief/fleet profile fields, with the local harness as the agent. */
export function herdrChoice(choice: HerdrProfileChoice): ProfileChoice {
  return {
    ...choice,
    profile: {
      runtime: "herdr",
      agent: herdrHarnessLabel(choice.profile.harness),
      model: choice.profile.model,
      effort: choice.profile.effort,
      fastMode: false,
    },
  };
}

/** Opaque claim handle; all three identifiers come from the herdr response. */
export const herdrClaimHandle = (handle: { workspace: string; pane: string; agent: string }): string =>
  JSON.stringify({ workspace: handle.workspace, pane: handle.pane, agent: handle.agent });

/** Model names can be served by Zen, OpenRouter or the direct provider. */
export function isDeepseekModel(model: string): boolean {
  const [provider, ...parts] = model.split("/");
  return !!parts.length && (provider === "deepseek" || /(?:^|[/-])deepseek(?:$|[/-])/i.test(parts.join("/")));
}

/** Arguments that make a Herdr profile use its harness's full-permission mode. */
export function herdrPermissionArgs(profile: Pick<HerdrProfile, "harness" | "permissions" | "extraArgs">): string[] {
  const args = [...profile.extraArgs];
  if (profile.permissions !== "full") return args;

  const fullArg = HERDR_FULL_PERMISSION_ARGS[profile.harness];
  const firstMatching = args.findIndex((arg) => arg.trim() === fullArg);
  const withoutMatching = args.filter((arg) => arg.trim() !== fullArg);
  if (firstMatching < 0) return [...withoutMatching, fullArg];

  withoutMatching.splice(firstMatching, 0, fullArg);
  return withoutMatching;
}

type TomlTable = Record<string, unknown>;

const isTable = (value: unknown): value is TomlTable =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const canonicalToml = (value: unknown): string =>
  JSON.stringify(value, (_, nested) =>
    typeof nested === "object" && nested !== null && !Array.isArray(nested)
      ? Object.fromEntries(
          Object.keys(nested)
            .sort()
            .map((key) => [key, nested[key]]),
        )
      : nested,
  );

const linesOf = (text: string): string[] => text.split(/(?<=\n)/);

const lineWithoutEnding = (line: string): string => line.replace(/\r?\n$/, "");

const hasTomlHeader = (line: string): boolean => /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?(?:\r?\n)?$/.test(line);

/** Decode one profile header through the TOML parser, so quoted names are handled safely. */
const profileHeaderName = (line: string): string | null => {
  const source = lineWithoutEnding(line);
  if (!/^\s*\[(?!\[)/.test(source) || !/herdr\s*\.\s*profiles\s*\./.test(source)) return null;
  try {
    const parsed = parse(`${source}\n`) as TomlTable;
    const herdr = parsed.herdr;
    const profiles = isTable(herdr) ? herdr.profiles : undefined;
    if (!isTable(profiles)) return null;
    const names = Object.keys(profiles);
    return names.length === 1 ? (names[0] ?? null) : null;
  } catch {
    return null;
  }
};

const keyAssignment = (line: string, key: string): boolean =>
  new RegExp(`^\\s*(?:${key}|"${key}"|'${key}')\\s*=`).test(lineWithoutEnding(line));

const keyLine = (lines: string[], key: string): number => {
  for (let i = 1; i < lines.length; i++) if (keyAssignment(lines[i] ?? "", key)) return i;
  return -1;
};

const quotedValueLine = (line: string, key: string): RegExpMatchArray | null =>
  lineWithoutEnding(line).match(
    new RegExp(`^(\\s*(?:${key}|"${key}"|'${key}')\\s*=\\s*)("(?:[^"\\\\]|\\\\.)*"|'[^']*')(.*)$`),
  );

const addLineBreak = (line: string, newline: string): string => (/\r?\n$/.test(line) ? line : `${line}${newline}`);

interface ArrayItem {
  start: number;
  end: number;
  commaAfter: number | null;
  value: string;
}

const skipArrayTrivia = (source: string, start: number, close: number): number => {
  let cursor = start;
  while (cursor < close) {
    if (/\s/.test(source[cursor] ?? "")) {
      cursor++;
      continue;
    }
    if (source[cursor] === "#") {
      const newline = source.indexOf("\n", cursor);
      cursor = newline < 0 || newline > close ? close : newline + 1;
      continue;
    }
    break;
  }
  return cursor;
};

/** Read a simple string array while retaining every source offset for safe item removal. */
const scanStringArray = (source: string, start: number): { close: number; items: ArrayItem[] } => {
  if (source[start] !== "[") throw new Error("could not safely edit extra_args: expected a string array");
  const close = (() => {
    let cursor = start + 1;
    let quote: "'" | '"' | null = null;
    while (cursor < source.length) {
      const char = source[cursor];
      if (quote === "'") {
        if (char === "'") quote = null;
        cursor++;
        continue;
      }
      if (quote === '"') {
        if (char === "\\") {
          cursor += 2;
          continue;
        }
        if (char === '"') quote = null;
        cursor++;
        continue;
      }
      if (char === "'") {
        if (source[cursor + 1] === "'")
          throw new Error("could not safely edit extra_args: multiline strings are unsupported");
        quote = "'";
      } else if (char === '"') {
        if (source[cursor + 1] === '"')
          throw new Error("could not safely edit extra_args: multiline strings are unsupported");
        quote = '"';
      } else if (char === "]") {
        return cursor;
      }
      cursor++;
    }
    throw new Error("could not safely edit extra_args: unterminated string array");
  })();

  const items: ArrayItem[] = [];
  let cursor = skipArrayTrivia(source, start + 1, close);
  while (cursor < close) {
    const quote = source[cursor];
    if (quote !== "'" && quote !== '"') throw new Error("could not safely edit extra_args: expected string values");
    if (source[cursor + 1] === quote)
      throw new Error("could not safely edit extra_args: multiline strings are unsupported");
    const itemStart = cursor;
    cursor++;
    while (cursor < close) {
      if (quote === '"' && source[cursor] === "\\") {
        cursor += 2;
        continue;
      }
      if (source[cursor] === quote) break;
      cursor++;
    }
    if (source[cursor] !== quote) throw new Error("could not safely edit extra_args: unterminated string value");
    const itemEnd = cursor + 1;
    const literal = source.slice(itemStart, itemEnd);
    let decoded: unknown;
    try {
      decoded = (parse(`value = ${literal}\n`) as TomlTable).value;
    } catch {
      throw new Error("could not safely edit extra_args: invalid string value");
    }
    if (typeof decoded !== "string") throw new Error("could not safely edit extra_args: expected string values");
    cursor = skipArrayTrivia(source, itemEnd, close);
    const commaAfter = source[cursor] === "," ? cursor : null;
    items.push({ start: itemStart, end: itemEnd, commaAfter, value: decoded });
    if (commaAfter === null) {
      cursor = skipArrayTrivia(source, cursor, close);
      if (cursor < close) throw new Error("could not safely edit extra_args: expected a comma");
      break;
    }
    cursor = skipArrayTrivia(source, commaAfter + 1, close);
  }
  return { close, items };
};

const arrayAssignment = (
  source: string,
  key: string,
): { start: number; arrayStart: number; scan: ReturnType<typeof scanStringArray> } | null => {
  const pattern = new RegExp(`(^|\\r?\\n)([ \\t]*(?:${key}|"${key}"|'${key}')\\s*=\\s*)`, "g");
  const match = pattern.exec(source);
  if (!match) return null;
  const assignmentStart = (match.index ?? 0) + (match[1]?.length ?? 0);
  let arrayStart = (match.index ?? 0) + match[0].length;
  while (/\s/.test(source[arrayStart] ?? "")) arrayStart++;
  if (source[arrayStart] !== "[") throw new Error(`could not safely edit ${key}: expected a string array`);
  return { start: assignmentStart, arrayStart, scan: scanStringArray(source, arrayStart) };
};

const removeArrayItems = (
  source: string,
  assignment: ReturnType<typeof arrayAssignment>,
  remove: (value: string) => boolean,
): string => {
  if (!assignment) return source;
  const { items } = assignment.scan;
  if (!items.some((item) => remove(item.value))) return source;
  const edits: { start: number; end: number }[] = [];
  for (let start = 0; start < items.length; ) {
    if (!remove(items[start]?.value ?? "")) {
      start++;
      continue;
    }
    let end = start;
    while (end + 1 < items.length && remove(items[end + 1]?.value ?? "")) end++;
    let editStart = items[start]?.start ?? 0;
    let editEnd = items[end]?.end ?? editStart;
    if (end < items.length - 1) {
      const comma = items[end]?.commaAfter;
      if (comma === null || comma === undefined)
        throw new Error("could not safely edit extra_args: invalid separators");
      editEnd = comma + 1;
      while (source[editEnd] === " " || source[editEnd] === "\t") editEnd++;
    } else if (start > 0) {
      const previousComma = items[start - 1]?.commaAfter;
      if (previousComma === null || previousComma === undefined)
        throw new Error("could not safely edit extra_args: invalid separators");
      editStart = previousComma;
      const trailingComma = items[end]?.commaAfter;
      editEnd =
        trailingComma === null || trailingComma === undefined ? (items[end]?.end ?? editEnd) : trailingComma + 1;
    } else {
      const trailingComma = items[end]?.commaAfter;
      editEnd =
        trailingComma === null || trailingComma === undefined ? (items[end]?.end ?? editEnd) : trailingComma + 1;
    }
    edits.push({ start: editStart, end: editEnd });
    start = end + 1;
  }
  let next = source;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    next = `${next.slice(0, edit.start)}${next.slice(edit.end)}`;
  return next;
};

const profileSections = (text: string): Map<string, { start: number; end: number }> => {
  const lines = linesOf(text);
  const found: { name: string; start: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const name = profileHeaderName(lines[i] ?? "");
    if (name) found.push({ name, start: i });
  }
  return new Map(
    found.map((entry, index) => {
      let end = lines.length;
      for (let i = entry.start + 1; i < lines.length; i++) {
        if (hasTomlHeader(lines[i] ?? "")) {
          end = i;
          break;
        }
      }
      const next = found[index + 1];
      if (next && next.start < end) end = next.start;
      return [entry.name, { start: entry.start, end }];
    }),
  );
};

/**
 * Set permissions for named Herdr profiles without rewriting the rest of armada.toml.
 * Existing profile decisions are untouched unless their names are supplied explicitly.
 */
export function setHerdrPermissions(text: string, names: readonly string[], choice: HerdrPermission): string {
  if (!HERDR_PERMISSIONS.includes(choice)) throw new Error('permissions must be "ask" or "full"');
  const raw = parse(text) as TomlTable;
  const requested = [...new Set(names)];
  if (!requested.length) return text;
  const herdr = raw.herdr;
  const profiles = isTable(herdr) ? herdr.profiles : undefined;
  if (!isTable(profiles)) throw new Error("could not safely edit permissions: no [herdr.profiles] table");
  const sections = profileSections(text);
  const lines = linesOf(text);
  const expected = structuredClone(raw) as TomlTable;
  const expectedHerdr = expected.herdr;
  const expectedProfiles = isTable(expectedHerdr) ? expectedHerdr.profiles : undefined;
  if (!isTable(expectedProfiles)) throw new Error("could not safely edit permissions: no [herdr.profiles] table");
  const replacements: { start: number; end: number; source: string }[] = [];

  for (const name of requested) {
    if (!Object.hasOwn(profiles, name) || !isTable(profiles[name]))
      throw new Error(`profile "${name}" is no longer present`);
    const section = sections.get(name);
    if (!section) throw new Error(`use an explicit [herdr.profiles.${name}] section to save permissions`);
    const profile = profiles[name] as TomlTable;
    const harness = profile.harness;
    if (!(typeof harness === "string" && Object.hasOwn(HERDR_FULL_PERMISSION_ARGS, harness)))
      throw new Error(`could not safely edit permissions for profile "${name}": invalid harness`);
    const profileLines = lines.slice(section.start, section.end);
    const permissionLine = keyLine(profileLines, "permissions");
    if (permissionLine >= 0) {
      const match = quotedValueLine(profileLines[permissionLine] ?? "", "permissions");
      if (!match) throw new Error(`could not safely edit permissions for profile "${name}"`);
      const oldValue = match[2] ?? '"ask"';
      const quote = oldValue.startsWith("'") ? "'" : '"';
      const value = quote === "'" ? `'${choice}'` : JSON.stringify(choice);
      const ending = (profileLines[permissionLine] ?? "").match(/\r?\n$/)?.[0] ?? "";
      profileLines[permissionLine] = `${match[1]}${value}${match[3]}${ending}`;
    } else if (Object.hasOwn(profile, "permissions")) {
      throw new Error(`could not safely edit permissions for profile "${name}"`);
    } else {
      const newline = text.includes("\r\n") ? "\r\n" : "\n";
      let insertAt = keyLine(profileLines, "effort");
      insertAt = insertAt < 0 ? keyLine(profileLines, "model") : insertAt;
      insertAt = insertAt < 0 ? 1 : insertAt + 1;
      if (insertAt > 0 && insertAt <= profileLines.length) {
        const previous = insertAt - 1;
        profileLines[previous] = addLineBreak(profileLines[previous] ?? "", newline);
      }
      const sourceLine = profileLines.find((line) => keyAssignment(line, "harness")) ?? "";
      const indent = sourceLine.match(/^\s*/)?.[0] ?? "";
      profileLines.splice(insertAt, 0, `${indent}permissions = ${JSON.stringify(choice)}${newline}`);
    }

    let profileSource = profileLines.join("");
    const existingArgs = profile.extra_args;
    if (choice === "ask" && existingArgs !== undefined) {
      if (!Array.isArray(existingArgs) || !existingArgs.every((arg) => typeof arg === "string"))
        throw new Error(`could not safely edit extra_args for profile "${name}"`);
      const assignment = arrayAssignment(profileSource, "extra_args");
      if (!assignment) throw new Error(`could not safely edit extra_args for profile "${name}"`);
      const scanned = assignment.scan.items.map((item) => item.value);
      if (canonicalToml(scanned) !== canonicalToml(existingArgs))
        throw new Error(`could not safely edit extra_args for profile "${name}"`);
      profileSource = removeArrayItems(
        profileSource,
        assignment,
        (arg) => arg.trim() === HERDR_FULL_PERMISSION_ARGS[harness as HerdrHarness],
      );
      const expectedProfile = expectedProfiles[name] as TomlTable;
      expectedProfile.extra_args = existingArgs.filter(
        (arg) => arg.trim() !== HERDR_FULL_PERMISSION_ARGS[harness as HerdrHarness],
      );
    }
    const updatedProfile = expectedProfiles[name] as TomlTable;
    updatedProfile.permissions = choice;
    replacements.push({ start: section.start, end: section.end, source: profileSource });
  }

  const nextLines = [...lines];
  for (const replacement of replacements.sort((a, b) => b.start - a.start))
    nextLines.splice(replacement.start, replacement.end - replacement.start, ...linesOf(replacement.source));
  const next = nextLines.join("");

  if (canonicalToml(parse(next)) !== canonicalToml(expected))
    throw new Error("could not safely edit profile permissions");
  return next;
}

/** Edit one explicit profile section without serializing the rest of the TOML. */
export function setHerdrModel(text: string, name: string, model: string): string {
  const raw = parse(text);
  const profiles = (raw.herdr as { profiles?: Record<string, { model?: string }> } | undefined)?.profiles;
  if (!profiles?.[name]) throw new Error("profile is no longer present");
  const lines = text.split(/(?<=\n)/);
  let section = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i]?.match(/^\s*\[herdr\s*\.\s*profiles\s*\.\s*(.+?)\]\s*(?:#.*)?(?:\r?\n)?$/);
    if (header) {
      const key = header[1]?.trim();
      // Let the TOML parser decode quoted/escaped profile names.
      if (key && Object.hasOwn(parse(`[${key}]\n`), name)) {
        section = i;
        break;
      }
    }
  }
  if (section < 0) throw new Error("use an explicit [herdr.profiles.<name>] section to save the model");
  for (let i = section + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  let replaced = false;
  for (let i = section + 1; i < end; i++) {
    const match = lines[i]?.match(/^(\s*(?:model|"model"|'model')\s*=\s*)("(?:[^"\\]|\\.)*"|'[^']*')(.*?)(\r?\n)?$/);
    if (match) {
      const value = match[2]?.startsWith("'") && !model.includes("'") ? `'${model}'` : JSON.stringify(model);
      lines[i] = `${match[1]}${value}${match[3]}${match[4] ?? ""}`;
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    const newline = text.includes("\r\n") ? "\r\n" : "\n";
    if (!(lines[section] ?? "").endsWith("\n")) lines[section] += newline;
    lines.splice(section + 1, 0, `model = ${JSON.stringify(model)}${newline}`);
  }
  const next = lines.join("");
  profiles[name].model = model;
  // Refuse unusual syntax instead of risking unrelated values or multiline strings.
  if (JSON.stringify(parse(next)) !== JSON.stringify(raw)) {
    // Missing-key insertion changes object order: compare canonically.
    const canonical = (value: unknown): string =>
      JSON.stringify(value, (_, v) =>
        typeof v === "object" && v !== null && !Array.isArray(v)
          ? Object.fromEntries(
              Object.keys(v)
                .sort()
                .map((key) => [key, v[key]]),
            )
          : v,
      );
    if (canonical(parse(next)) !== canonical(raw)) throw new Error("could not safely edit the profile model");
  }
  return next;
}
