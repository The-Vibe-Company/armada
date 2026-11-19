import { join } from "node:path";

export function smokeDeadlines(greenJournalsNewestFirst: readonly string[]) {
  const samples = new Map<string, number[]>();
  const runsPerStep = new Map<string, number>();
  for (const journal of greenJournalsNewestFirst.slice(0, 20)) {
    const seen = new Set<string>();
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
      seen.add(row.step);
    }
    for (const step of seen) runsPerStep.set(step, (runsPerStep.get(step) ?? 0) + 1);
  }
  return Object.fromEntries(
    [...samples]
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([step, values]) => {
        if (runsPerStep.get(step) !== 20) return [];
        values.sort((a, b) => a - b);
        return [[step, Math.ceil(1.5 * values[Math.ceil(values.length * 0.99) - 1]!)] as const];
      }),
  );
}

if (import.meta.main) {
  const directory = Bun.argv[2];
  if (!directory) throw new Error("Usage: bun scripts/smoke-deadlines.ts <green-journal-directory>");
  const paths = [...new Bun.Glob("*.jsonl").scanSync(directory)].sort().reverse().slice(0, 20);
  const journals = await Promise.all(paths.map((path) => Bun.file(join(directory, path)).text()));
  console.log(JSON.stringify(smokeDeadlines(journals), null, 2));
}
