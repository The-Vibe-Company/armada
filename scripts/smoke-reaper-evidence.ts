// The workflow fetches filtered logs from the previous live staging server.
export const reaperLogLimit = 500;
const windowMs = 15 * 60_000;
const freshMs = 5 * 60_000;

type Provider = "modal" | "docker";
const providers: readonly Provider[] = ["modal", "docker"];

export function checkReaperEvidence(jsonl: string, now: number) {
  const lines = jsonl.split("\n").filter((line) => line.trim());
  const problems = new Set<string>();
  const machineIds = { modal: new Set<string>(), docker: new Set<string>() };
  const latest = new Map<string, { provider: Provider; timestamp: number; healthy: boolean }>();
  const seen = new Set<Provider>();
  let discoveryFailure = -Infinity;
  let latestModal = -Infinity;

  if (lines.length >= reaperLogLimit) problems.add("log_limit_reached");
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
    const timestamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
    if (!Number.isFinite(timestamp)) {
      problems.add("invalid_log_timestamp");
      continue;
    }
    if (timestamp < now - windowMs || timestamp > now) continue;
    if (record.event === "provider_reaper_retry" && record.phase === "discovery") {
      discoveryFailure = Math.max(discoveryFailure, timestamp);
      continue;
    }
    const provider = record.provider;
    if (provider !== "modal" && provider !== "docker") continue;
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
    const key = `${provider}:${record.source}`;
    const healthy = record.complete === true && overdue === 0;
    const previous = latest.get(key);
    if (!previous || timestamp > previous.timestamp || (timestamp === previous.timestamp && !healthy)) {
      latest.set(key, { provider, timestamp, healthy });
    }
    if (provider === "modal" && healthy) latestModal = Math.max(latestModal, timestamp);
  }
  if (discoveryFailure >= latestModal && Number.isFinite(discoveryFailure)) problems.add("modal_discovery_incomplete");
  for (const [key, { provider, timestamp, healthy }] of latest) {
    seen.add(provider);
    if (timestamp < now - freshMs || !healthy) problems.add(`incomplete_reaper_evidence:${key}`);
  }
  for (const provider of providers) {
    if (!seen.has(provider)) problems.add(`missing_reaper_evidence:${provider}`);
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
