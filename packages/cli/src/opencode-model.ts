import { stripVTControlCharacters } from "node:util";
import { type Io, UsageError } from "./io.ts";

interface Model {
  id: string;
  name: string;
  provider: string;
}

const displayName = (value: unknown): value is string =>
  typeof value === "string" && !!value.trim() && !/[\r\n]/.test(value) && stripVTControlCharacters(value) === value;

// Verbose models contain providerID, not the provider's display name. Join
// them to OpenCode's local catalog, then apply the resolved V1 configuration
// used by `models` and the TUI (the V2 catalog does not apply those overrides).
function providersFrom(raw: string, configuration: string): { id: string; name: string }[] {
  try {
    const catalog = JSON.parse(stripVTControlCharacters(raw));
    const config = JSON.parse(stripVTControlCharacters(configuration));
    const providers: { id: string; name: string }[] = Array.isArray(catalog?.providers)
      ? catalog.providers.filter(
          (provider: { id?: unknown; name?: unknown } | null) =>
            provider && displayName(provider.id) && displayName(provider.name),
        )
      : [];
    for (const [id, value] of Object.entries(config?.provider ?? {})) {
      const name = (value as { name?: unknown } | null)?.name;
      if (!displayName(id) || (name !== undefined && !displayName(name))) continue;
      if (name === undefined && providers.some((provider) => provider.id === id)) continue;
      for (let index = providers.length - 1; index >= 0; index--)
        if (providers[index]?.id === id) providers.splice(index, 1);
      providers.push({ id, name: name ?? id });
    }
    return providers;
  } catch {
    return [];
  }
}

// `opencode models --verbose` emits an exact ID followed by a pretty JSON
// object. Keep only identity fields; never surface the raw provider metadata.
function modelsFrom(raw: string, providers: { id: string; name: string }[]): Model[] {
  const models: Model[] = [];
  for (const match of stripVTControlCharacters(raw).matchAll(/^([^\s/#]+\/[^\s#]+)\r?\n(\{\r?\n[\s\S]*?^\})/gm)) {
    try {
      const metadata = JSON.parse(match[2] ?? "");
      const id = match[1] ?? "";
      if (metadata && `${metadata.providerID}/${metadata.id}` === id && displayName(metadata.name))
        for (const provider of providers.filter((provider) => provider.id === metadata.providerID))
          models.push({ id, name: metadata.name, provider: provider.name });
    } catch {}
  }
  return models;
}

function selectedModel(pane: string, models: Model[]): string | null {
  // Recorded OpenCode prompt footer: `Build auto · Big Pickle OpenCode Zen`.
  // Older releases omit auto and the separator. Read only the prompt footer,
  // not a command echo, a model-picker list or arbitrary text mentioning a model.
  const lines = stripVTControlCharacters(pane).split("\n");
  const footers = lines.flatMap((line, index) => {
    // The border may be absent (theme background, or a cropped pane). In
    // that case require the modern footer's separator instead of accepting
    // arbitrary lines that merely mention a model.
    const bordered = /^\s*╹/.test(lines[index + 1] ?? "");
    const pattern = bordered
      ? /^(?:[┃│]\s*)?[A-Z][\w-]*(?:\s+auto)?(?:\s+·)?\s+(.+)$/
      : /^(?:[┃│]\s*)?[A-Z][\w-]*(?:\s+auto)?\s+·\s+(.+)$/;
    const match = line.trim().match(pattern);
    return match?.[1] ? [match[1]] : [];
  });
  const candidates = models.filter((model) =>
    footers.some((footer) =>
      [model.name, model.id].some((name) => {
        const identity = `${name} ${model.provider}`;
        return footer === identity || footer.startsWith(`${identity} · `);
      }),
    ),
  );
  const ids = [...new Set(candidates.map((model) => model.id))];
  // Duplicate complete display identities cannot establish the exact ID.
  return ids.length === 1 ? (ids[0] ?? null) : null;
}

/** Before sending any brief, require the running TUI to show the profile model. */
export async function verifyOpenCodeModel(io: Io, pane: string, expected: string): Promise<void> {
  const failure = () => new UsageError(`could not verify OpenCode model ${expected} from its pane; launch stopped`);
  if (!io.exec) throw failure();
  const metadata = await io
    .exec("opencode", ["models", "--verbose"], { cwd: io.cwd, timeoutMs: 5_000 })
    .catch(() => null);
  if (metadata?.code !== 0) throw failure();
  const catalog = await io.exec("opencode", ["debug", "v2"], { cwd: io.cwd, timeoutMs: 5_000 }).catch(() => null);
  if (catalog?.code !== 0) throw failure();
  const config = await io.exec("opencode", ["debug", "config"], { cwd: io.cwd, timeoutMs: 5_000 }).catch(() => null);
  const models = config?.code === 0 ? modelsFrom(metadata.stdout, providersFrom(catalog.stdout, config.stdout)) : [];
  if (!models.some((model) => model.id === expected)) throw failure();
  const now = io.now ?? (() => new Date());
  const deadline = now().getTime() + 5_000;
  for (let attempt = 0; attempt < 20; attempt++) {
    const remaining = deadline - now().getTime();
    if (remaining <= 0) break;
    const reading = await io
      .exec("herdr", ["pane", "read", pane, "--source", "visible"], {
        cwd: io.cwd,
        timeoutMs: Math.min(1_000, remaining),
      })
      .catch(() => null);
    if (reading?.code !== 0) throw failure();
    const text = stripVTControlCharacters(reading.stdout);
    if (/ProviderModelNotFoundError|Model not found:/i.test(text))
      throw new UsageError(`OpenCode could not load profile model ${expected}; launch stopped`);
    const selected = selectedModel(text, models);
    if (selected === expected) return;
    if (selected) throw new UsageError(`OpenCode model differs from profile ${expected}; launch stopped`);
    const delay = Math.min(250, deadline - now().getTime());
    if (delay > 0) await (io.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms))))(delay);
  }
  throw failure();
}
