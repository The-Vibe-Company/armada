const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const diagnosticSteps = new Set(["scoped_launch_diagnostic", "scoped_message_diagnostic", "scoped_stop_diagnostic"]);

function records(jsonl: string, strict = false) {
  return jsonl.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const value: unknown = JSON.parse(line);
      if (value !== null && typeof value === "object" && !Array.isArray(value))
        return [value as Record<string, unknown>];
    } catch {
      // Smoke stdout can include human-readable notices. Railway output must be JSONL.
    }
    if (strict) throw new Error("Invalid candidate log record.");
    return [];
  });
}

function correlationKeys(smoke: string) {
  const keys = new Set<string>();
  for (const record of records(smoke)) {
    if (typeof record.step !== "string" || !diagnosticSteps.has(record.step)) continue;
    if (typeof record.operationId === "string" && uuid.test(record.operationId))
      keys.add(`operationId:${record.operationId}`);
    if (typeof record.toolRequestId === "string" && uuid.test(record.toolRequestId))
      keys.add(`requestId:${record.toolRequestId}`);
  }
  return keys;
}

export function scopedEvidenceFilter(smoke: string) {
  const keys = [...correlationKeys(smoke)];
  if (keys.length) return `@event:operator_failure AND (${keys.map((key) => `@${key}`).join(" OR ")})`;
}

export function scopedEvidence(smoke: string, logs: string) {
  const keys = correlationKeys(smoke);
  const unmatched = new Set(keys);
  const diagnostics = records(logs, true).flatMap((record) => {
    if (record.event !== "operator_failure") return [];
    const ids: Partial<Record<"operationId" | "requestId" | "sandboxId", string>> = Object.fromEntries(
      ["operationId", "requestId", "sandboxId"].flatMap((field) => {
        const value = record[field];
        return typeof value === "string" && uuid.test(value) ? [[field, value]] : [];
      }),
    );
    const matches = (["operationId", "requestId"] as const)
      .map((field) => `${field}:${ids[field]}`)
      .filter((key) => keys.has(key));
    if (!matches.length) return [];
    for (const match of matches) unmatched.delete(match);
    const codes: Partial<Record<"phase" | "code" | "refusalCode" | "causeCode" | "errorClass", string>> =
      Object.fromEntries(
        ["phase", "code", "refusalCode", "causeCode", "errorClass"].flatMap((field) => {
          const value = record[field];
          return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.]{0,95}$/.test(value) ? [[field, value]] : [];
        }),
      );
    const sqlState =
      record.errorClass === "PostgresError" && typeof record.message === "string"
        ? /(?:^SQLSTATE ([0-9A-Z]{5})$| \(SQLSTATE ([0-9A-Z]{5})\)$)/.exec(record.message)
        : null;
    const stack = Array.isArray(record.stack)
      ? record.stack
          .filter((frame) => typeof frame === "string" && /^(?:[\w@.-]+\/)*[\w.-]+:\d{1,7}:\d{1,7}$/.test(frame))
          .slice(0, 8)
      : [];
    return [
      { ...ids, ...codes, ...(sqlState && { sqlState: sqlState[1] ?? sqlState[2] }), ...(stack.length && { stack }) },
    ];
  });
  return {
    step: "scoped_server_evidence",
    diagnostics,
    unmatchedOperationIds: [...unmatched].filter((key) => key.startsWith("operationId:")).map((key) => key.slice(12)),
    unmatchedRequestIds: [...unmatched].filter((key) => key.startsWith("requestId:")).map((key) => key.slice(10)),
  };
}

if (import.meta.main) {
  const smoke = await Bun.file(process.argv[2]!).text();
  if (process.argv[3] === "--filter") {
    console.log(scopedEvidenceFilter(smoke) ?? "");
  } else {
    console.log(JSON.stringify(scopedEvidence(smoke, await Bun.stdin.text())));
  }
}
