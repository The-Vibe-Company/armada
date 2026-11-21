import { join } from "node:path";
import { isSandboxPlacementProvider } from "../packages/core/src/sandbox-provider.ts";

const GREEN_JOURNAL_LIMIT = 20;
const MIN_STEP_SAMPLES = 20;
const MIN_STEP_DEADLINE_MS = 2_000;
export const USAGE_STATUS_MIN_REQUEST_MS = MIN_STEP_DEADLINE_MS;
export const SMOKE_POLL_INTERVAL_MS = 1_000;
const USAGE_POLL_MIN_MS = 2 * USAGE_STATUS_MIN_REQUEST_MS + SMOKE_POLL_INTERVAL_MS;
const DOCKER_REAL_MODEL_READY_FLOOR_MS = 60_000;
const usagePollSteps = new Set(["usage", "usage_second", "resume_usage"]);

type DeadlineTable = Readonly<Record<string, Readonly<Partial<Record<string, number>>>>>;

export function deadlinesFor(table: DeadlineTable, provider: string, lane: string) {
  const scope = `${provider}/${lane}`;
  return Object.hasOwn(table, scope) ? table[scope]! : {};
}

export function smokeDeadlines(greenJournalsNewestFirst: readonly string[]) {
  const samples = new Map<string, Map<string, number[]>>();
  for (const journal of greenJournalsNewestFirst.slice(0, GREEN_JOURNAL_LIMIT)) {
    for (const line of journal.split("\n")) {
      if (!line.trimStart().startsWith("{")) continue;
      const row = JSON.parse(line);
      if (
        row?.pass !== true ||
        !isSandboxPlacementProvider(row.provider) ||
        typeof row.lane !== "string" ||
        !/^[a-z0-9-]+$/.test(row.lane) ||
        typeof row.step !== "string" ||
        typeof row.elapsedMs !== "number" ||
        !Number.isFinite(row.elapsedMs) ||
        row.elapsedMs <= 0
      )
        continue;
      const scope = `${row.provider}/${row.lane}`;
      const steps = samples.get(scope) ?? new Map<string, number[]>();
      const values = steps.get(row.step) ?? [];
      values.push(row.elapsedMs);
      steps.set(row.step, values);
      samples.set(scope, steps);
    }
  }
  const table: Record<string, Record<string, number>> = {};
  for (const scope of [...samples.keys()].sort()) {
    const steps = samples.get(scope)!;
    const budgets = Object.fromEntries(
      [...steps]
        .sort(([left], [right]) => left.localeCompare(right))
        .flatMap(([step, values]) => {
          if (values.length < MIN_STEP_SAMPLES) return [];
          values.sort((a, b) => a - b);
          const p99 = values[Math.ceil(values.length * 0.99) - 1]!;
          const floor =
            scope === "docker/real-model" && step === "real_model_ready"
              ? DOCKER_REAL_MODEL_READY_FLOOR_MS
              : usagePollSteps.has(step)
                ? USAGE_POLL_MIN_MS
                : MIN_STEP_DEADLINE_MS;
          return [[step, Math.max(floor, Math.ceil(2 * p99))] as const];
        }),
    );
    if (Object.keys(budgets).length > 0) table[scope] = budgets;
  }
  return table;
}

if (import.meta.main) {
  const directory = Bun.argv[2];
  if (!directory) throw new Error("Usage: bun scripts/smoke-deadlines.ts <green-journal-directory>");
  const paths = [...new Bun.Glob("*.jsonl").scanSync(directory)].sort().reverse().slice(0, GREEN_JOURNAL_LIMIT);
  const journals = await Promise.all(paths.map((path) => Bun.file(join(directory, path)).text()));
  console.log(JSON.stringify(smokeDeadlines(journals), null, 2));
}
