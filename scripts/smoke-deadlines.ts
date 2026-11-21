import { join } from "node:path";

const GREEN_JOURNAL_LIMIT = 20;
const MIN_STEP_SAMPLES = 20;
const MIN_STEP_DEADLINE_MS = 2_000;
export const USAGE_STATUS_MIN_REQUEST_MS = MIN_STEP_DEADLINE_MS;
export const SMOKE_POLL_INTERVAL_MS = 1_000;
const USAGE_POLL_MIN_MS = 2 * USAGE_STATUS_MIN_REQUEST_MS + SMOKE_POLL_INTERVAL_MS;
const usagePollSteps = new Set(["usage", "usage_second", "resume_usage"]);

export function smokeDeadlines(greenJournalsNewestFirst: readonly string[]) {
  const samples = new Map<string, number[]>();
  for (const journal of greenJournalsNewestFirst.slice(0, GREEN_JOURNAL_LIMIT)) {
    for (const line of journal.split("\n")) {
      if (!line.trimStart().startsWith("{")) continue;
      const row = JSON.parse(line);
      if (
        row.pass !== true ||
        typeof row.step !== "string" ||
        typeof row.elapsedMs !== "number" ||
        !Number.isFinite(row.elapsedMs) ||
        row.elapsedMs <= 0
      )
        continue;
      const values = samples.get(row.step) ?? [];
      values.push(row.elapsedMs);
      samples.set(row.step, values);
    }
  }
  return Object.fromEntries(
    [...samples]
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([step, values]) => {
        if (values.length < MIN_STEP_SAMPLES) return [];
        values.sort((a, b) => a - b);
        const p99 = values[Math.ceil(values.length * 0.99) - 1]!;
        const floor = usagePollSteps.has(step) ? USAGE_POLL_MIN_MS : MIN_STEP_DEADLINE_MS;
        return [[step, Math.max(floor, Math.ceil(2 * p99))] as const];
      }),
  );
}

if (import.meta.main) {
  const directory = Bun.argv[2];
  if (!directory) throw new Error("Usage: bun scripts/smoke-deadlines.ts <green-journal-directory>");
  const paths = [...new Bun.Glob("*.jsonl").scanSync(directory)].sort().reverse().slice(0, GREEN_JOURNAL_LIMIT);
  const journals = await Promise.all(paths.map((path) => Bun.file(join(directory, path)).text()));
  console.log(JSON.stringify(smokeDeadlines(journals), null, 2));
}
