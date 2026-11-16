import { PROMPT_STATUSES } from "@armada/core";

/** Validate the wire fields consumed by CLI operations, before any success output. */
export function validApiReceipt(path: string, value: unknown): boolean {
  if (!record(value)) return false;
  const text = (key: string) => typeof value[key] === "string" && value[key] !== "";
  const bool = (key: string) => typeof value[key] === "boolean";
  switch (path) {
    case "/api/v1/sandbox/stop":
      return text("id") && typeof value.status === "string" && ["stopping", "stopped", "failed"].includes(value.status);
    case "/api/v1/sandbox/send":
      return text("id") && text("promptId") && text("conversationId") && member(value.status, PROMPT_STATUSES);
    case "/api/v1/sandbox/steer":
      return text("id") && text("promptId") && text("conversationId");
    case "/api/v1/sandbox/interrupt":
      return text("id") && value.interrupted === true;
    case "/api/v1/sandbox/exec":
      return (
        text("id") &&
        (value.exitCode === null || Number.isInteger(value.exitCode)) &&
        typeof value.stdout === "string" &&
        typeof value.stderr === "string" &&
        bool("timedOut") &&
        bool("truncated")
      );
    case "/api/v1/sandbox/status":
    case "/api/v1/sandbox/detail":
    case "/api/v1/sandbox/wait":
      return (
        text("id") &&
        member(value.status, ["starting", "ready", "running", "stopping", "stopped", "failed", "deleted"]) &&
        bool("settled") &&
        validPrompt(value.prompt) &&
        (path !== "/api/v1/sandbox/wait" || bool("timedOut"))
      );
    case "/api/v1/logs/read":
      return (
        Array.isArray(value.events) &&
        value.events.every(validEvent) &&
        (value.cursor === null || typeof value.cursor === "string") &&
        bool("hasMore") &&
        bool("settled")
      );
    case "/api/v1/golden/list":
      return (
        Array.isArray(value.goldens) &&
        value.goldens.every(
          (row) =>
            record(row) &&
            typeof row.name === "string" &&
            (row.provider === undefined || member(row.provider, ["boat", "modal", "docker"])) &&
            (row.visibility === undefined || member(row.visibility, ["org", "private"])) &&
            record(row.config) &&
            Array.isArray(row.config.repos),
        )
      );
    case "/api/v1/org/list":
      return (
        Array.isArray(value.orgs) &&
        value.orgs.every(
          (row) =>
            record(row) && typeof row.id === "string" && typeof row.name === "string" && typeof row.role === "string",
        )
      );
    default:
      // API control routes return JSON objects, including explicit empty acknowledgements ({}).
      return true;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function member(value: unknown, choices: readonly string[]): boolean {
  return typeof value === "string" && choices.includes(value);
}

function validPrompt(value: unknown): boolean {
  if (value === null) return true;
  return (
    record(value) &&
    typeof value.promptId === "string" &&
    (value.conversationId === null || typeof value.conversationId === "string") &&
    member(value.state, ["queued", "running", "finished", "interrupted", "failed"]) &&
    (value.reason === null || typeof value.reason === "string") &&
    (value.rateLimit == null ||
      (record(value.rateLimit) &&
        typeof value.rateLimit.message === "string" &&
        typeof value.rateLimit.retryCount === "number" &&
        typeof value.rateLimit.totalWaitMs === "number"))
  );
}

function validEvent(value: unknown): boolean {
  if (!record(value) || typeof value.id !== "string" || typeof value.at !== "number") return false;
  if (value.kind === "other") {
    if (value.type === "armada/modelRateLimit" && record(value.data) && typeof value.data.message === "string")
      return typeof value.data.retryCount === "number" && typeof value.data.totalWaitMs === "number";
    return typeof value.type === "string";
  }
  if (value.kind === "message" || value.kind === "prompt" || value.kind === "steer")
    return typeof value.text === "string";
  return false;
}
