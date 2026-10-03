import { stripVTControlCharacters } from "node:util";
import { type Io, UsageError } from "./io.ts";

interface Model {
  id: string;
  name: string;
}

// `opencode models --verbose` emits an exact ID followed by a pretty JSON
// object. Keep only identity fields; never surface the raw provider metadata.
function modelsFrom(raw: string): Model[] {
  const models: Model[] = [];
  for (const match of stripVTControlCharacters(raw).matchAll(/^([^\s/#]+\/[^\s#]+)\r?\n(\{\r?\n[\s\S]*?^\})/gm)) {
    try {
      const metadata = JSON.parse(match[2] ?? "");
      const id = match[1] ?? "";
      if (
        metadata &&
        `${metadata.providerID}/${metadata.id}` === id &&
        typeof metadata.name === "string" &&
        metadata.name.trim() &&
        !/[\r\n]/.test(metadata.name) &&
        stripVTControlCharacters(metadata.name) === metadata.name
      )
        models.push({ id, name: metadata.name });
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
    if (!/^\s*╹/.test(lines[index + 1] ?? "")) return [];
    const match = line.trim().match(/^(?:[┃│]\s*)?[A-Z][\w-]*(?:\s+auto)?(?:\s+·)?\s+(.+)$/);
    return match?.[1] ? [match[1]] : [];
  });
  const candidates = models.filter((model) =>
    footers.some((footer) => footer.startsWith(`${model.name} `) || footer.startsWith(`${model.id} `)),
  );
  const ids = [...new Set(candidates.map((model) => model.id))];
  // Duplicate display names across providers cannot establish the exact ID.
  return ids.length === 1 ? (ids[0] ?? null) : null;
}

/** Before sending any brief, require the running TUI to show the profile model. */
export async function verifyOpenCodeModel(io: Io, pane: string, expected: string): Promise<void> {
  const failure = () => new UsageError(`could not verify OpenCode model ${expected} from its pane; launch stopped`);
  if (!io.exec) throw failure();
  const metadata = await io
    .exec("opencode", ["models", "--verbose"], { cwd: io.cwd, timeoutMs: 5_000 })
    .catch(() => null);
  const models = metadata?.code === 0 ? modelsFrom(metadata.stdout) : [];
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
