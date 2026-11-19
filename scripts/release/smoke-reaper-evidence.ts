export const reaperLogLimit = 500;
const windowMs = 15 * 60_000;
const freshMs = 5 * 60_000;

type Provider = "modal" | "docker";
const providers: readonly Provider[] = ["modal", "docker"];

export function checkReaperEvidence(jsonl: string, now: number) {
  const lines = jsonl.split("\n").filter((line) => line.trim());
  const problems = new Set<string>();
  const machineIds = { modal: new Set<string>(), docker: new Set<string>() };
  type Observation = { timestamp: number; healthy: boolean };
  const latest = { modal: new Map<string, Observation>(), docker: new Map<string, Observation>() };
  let discoveryFailure = -Infinity;

  const volume = { current: 0, previous: 0 };
  for (const line of lines) {
    let record: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      record = parsed as Record<string, unknown>;
    } catch {
      problems.add("invalid_log_record");
      continue;
    }
    const previousDeployment = record.previousDeployment === true;
    volume[previousDeployment ? "previous" : "current"]++;
    const timestamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
    if (!Number.isFinite(timestamp)) {
      problems.add("invalid_log_timestamp");
      continue;
    }
    if (timestamp < now - windowMs || timestamp > now) continue;
    if (!previousDeployment && record.event === "provider_reaper_retry" && record.phase === "discovery") {
      discoveryFailure = Math.max(discoveryFailure, timestamp);
      continue;
    }
    const provider = providers.find((candidate) => candidate === record.provider);
    if (!provider) continue;
    if (record.event === "reaper_overdue_machines") {
      if (
        !Array.isArray(record.machineIds) ||
        record.machineIds.length === 0 ||
        !record.machineIds.every((id) => typeof id === "string" && id.trim())
      ) {
        problems.add("invalid_overdue_machine_ids");
        continue;
      }
      for (const id of record.machineIds) machineIds[provider].add(id);
    }
    if (record.metric !== "reaper_unknown_machines") continue;
    if (typeof record.source !== "string" || !record.source.trim()) {
      problems.add("invalid_reaper_source");
      continue;
    }
    const overdue = record.overdue;
    if (typeof overdue !== "number" || !Number.isSafeInteger(overdue) || overdue < 0) {
      problems.add("invalid_overdue_count");
      continue;
    }
    if (overdue > 0) problems.add(`overdue_machines:${provider}`);
    if (previousDeployment) continue;
    const healthy = record.complete === true && overdue === 0;
    const previous = latest[provider].get(record.source);
    if (!previous || timestamp > previous.timestamp || (timestamp === previous.timestamp && !healthy)) {
      latest[provider].set(record.source, { timestamp, healthy });
    }
  }
  if (Math.max(volume.current, volume.previous) >= reaperLogLimit) problems.add("log_limit_reached");
  if (
    Number.isFinite(discoveryFailure) &&
    ![...latest.modal.values()].some((observation) => observation.healthy && observation.timestamp > discoveryFailure)
  )
    problems.add("modal_discovery_incomplete");
  for (const provider of providers) {
    if (latest[provider].size === 0) problems.add(`missing_reaper_evidence:${provider}`);
    for (const [source, { timestamp, healthy }] of latest[provider]) {
      if (timestamp < now - freshMs || !healthy) problems.add(`incomplete_reaper_evidence:${provider}:${source}`);
    }
  }
  return {
    step: "smoke_reaper_evidence",
    pass: problems.size === 0 && machineIds.modal.size === 0 && machineIds.docker.size === 0,
    problems: [...problems].sort(),
    overdueMachineIds: { modal: [...machineIds.modal].sort(), docker: [...machineIds.docker].sort() },
  };
}

if (import.meta.main) {
  const evidence = checkReaperEvidence(await Bun.stdin.text(), Date.now());
  console.log(JSON.stringify(evidence));
  if (!evidence.pass) process.exitCode = 1;
}
