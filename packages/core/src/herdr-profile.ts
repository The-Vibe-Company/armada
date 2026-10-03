import { parse } from "smol-toml";
import type { HerdrHarness } from "./config.ts";
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
