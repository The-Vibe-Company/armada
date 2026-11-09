import { AuthError } from "@armada/auth";
import {
  ORCHESTRATOR_CONTRACT_VERSION,
  ORCHESTRATOR_DEFAULTS,
  type OrchestratorCreate,
  type OrchestratorDetail,
  type OrchestratorEvent,
  type OrchestratorFence,
  type OrchestratorList,
  type OrchestratorMessage,
  type OrchestratorOperation,
} from "@armada/core";
import { type Args, parseArgs, single } from "./args.ts";

export const ORCHESTRATOR_HELP = `Usage: armada orchestrator <command> [options]
  create <name> --org <id> --golden <id> --provider boat|modal --agent claude|codex
         --model <id> --model-account <id> [--reasoning-effort <level>] [--repo <repository>]
         [--idle-seconds <900..86400>] --idempotency-key <key>
  list --org <id> [--cursor <cursor>] [--limit <1..100>]
  detail <id>
  send|steer <id> <text> --expected-revision <revision> --idempotency-key <key>
  stop|resume <id> --expected-revision <revision> --idempotency-key <key>
  events <id> [--cursor <cursor>] [--limit <1..500>] [--all|--follow]
  All commands accept --json. Events with --json emit one JSON page per line,
  including the server cursor for reconnect. Reuse the original key and identical
  arguments after an uncertain mutation; inspect detail/events for completion.
  Resume restores native state without sending a prompt. The server decides
  availability, account access, continuity and lifecycle; no local quota policy.
`;

type ReadCommand = { action: "list" | "detail" | "events"; id?: string; query: URLSearchParams };
type MutationCommand = {
  action: "create" | "message" | "steer" | "stop" | "resume";
  id?: string;
  key: string;
  body: OrchestratorCreate | OrchestratorFence | OrchestratorMessage;
};
export type OrchestratorCommand = (ReadCommand | MutationCommand) & {
  json: boolean;
  all: boolean;
  follow: boolean;
};

/** Parse against the exported v1 contract, without resolving server-owned policy locally. */
export function parseOrchestratorCommand(argv: readonly string[]): OrchestratorCommand {
  const args = parseArgs(argv, [
    "--golden",
    "--model-account",
    "--idle-seconds",
    "--expected-revision",
    "--cursor",
    "--limit",
  ]);
  const [action, ...positionals] = args.positionals;
  const common = {
    json: args.options.has("--json"),
    all: args.options.has("--all"),
    follow: args.options.has("--follow"),
  };
  const allowed = new Set(["--json"]);
  const allow = (...names: string[]) => {
    for (const name of names) allowed.add(name);
  };
  let command: ReadCommand | MutationCommand;
  if (action === "create") {
    if (positionals.length !== 1 || !positionals[0]?.trim()) usage("create needs one name.");
    allow(
      "--org",
      "--golden",
      "--provider",
      "--agent",
      "--model",
      "--model-account",
      "--reasoning-effort",
      "--repo",
      "--idle-seconds",
      "--idempotency-key",
    );
    const provider = required(args, "--provider");
    const harness = required(args, "--agent");
    if (provider !== "boat" && provider !== "modal") usage("--provider must be boat or modal.");
    if (harness !== "claude" && harness !== "codex") usage("--agent must be claude or codex.");
    const body: OrchestratorCreate = {
      version: ORCHESTRATOR_CONTRACT_VERSION,
      name: positionals[0],
      orgId: required(args, "--org"),
      goldenId: required(args, "--golden"),
      provider,
      harness,
      model: required(args, "--model"),
      modelAccountId: required(args, "--model-account"),
    };
    const repo = single(args, "--repo");
    const effort = single(args, "--reasoning-effort");
    if (repo !== undefined) body.repo = repo;
    if (effort !== undefined) body.reasoningEffort = effort;
    if (single(args, "--idle-seconds") !== undefined)
      body.idleSeconds = integer(
        args,
        "--idle-seconds",
        ORCHESTRATOR_DEFAULTS.minIdleSeconds,
        ORCHESTRATOR_DEFAULTS.maxIdleSeconds,
      );
    command = { action, key: idempotencyKey(args), body };
  } else if (action === "list" || action === "detail" || action === "events") {
    if (positionals.length !== (action === "list" ? 0 : 1))
      usage(`${action} ${action === "list" ? "takes no ID" : "needs one ID"}.`);
    const query = new URLSearchParams();
    if (action === "list") {
      allow("--org", "--cursor", "--limit");
      query.set("orgId", required(args, "--org"));
    }
    if (action === "events") allow("--cursor", "--limit", "--all", "--follow");
    if (action !== "detail") {
      const cursor = single(args, "--cursor");
      if (cursor !== undefined) query.set("cursor", cursor);
      if (single(args, "--limit") !== undefined)
        query.set("limit", String(integer(args, "--limit", 1, action === "list" ? 100 : 500)));
    }
    command = { action, ...(positionals[0] === undefined ? {} : { id: positionals[0] }), query };
  } else if (action === "send" || action === "steer" || action === "stop" || action === "resume") {
    const message = action === "send" || action === "steer";
    if (positionals.length !== (message ? 2 : 1) || (message && !positionals[1]?.trim()))
      usage(`${action} needs one ID${message ? " and one nonempty text argument" : ""}.`);
    allow("--expected-revision", "--idempotency-key");
    const fence: OrchestratorFence = {
      expectedRevision: integer(args, "--expected-revision", 0, Number.MAX_SAFE_INTEGER),
    };
    command = {
      action: action === "send" ? "message" : action,
      id: positionals[0] as string,
      key: idempotencyKey(args),
      body: message ? { ...fence, text: positionals[1] as string } : fence,
    };
  } else usage("Choose create, list, detail, send, steer, stop, resume or events.");
  for (const option of args.options.keys()) {
    if (!allowed.has(option)) usage(`${option} is not supported by ${action}.`);
    single(args, option);
  }
  return { ...command, ...common };
}

function required(args: Args, name: string): string {
  const value = single(args, name);
  if (!value?.trim()) usage(`${name} is required.`);
  return value;
}
function integer(args: Args, name: string, min: number, max: number): number {
  const value = required(args, name);
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < min || number > max)
    usage(`${name} must be an integer from ${min} to ${max}.`);
  return number;
}
function idempotencyKey(args: Args): string {
  const key = required(args, "--idempotency-key");
  if (!/^[\x20-\x7e]{1,128}$/.test(key)) usage("--idempotency-key must contain 1–128 printable ASCII characters.");
  return key;
}
function usage(message: string): never {
  throw new AuthError(message, "usage");
}

/** Human summaries deliberately say admitted/pending, not that a runtime action completed. */
export function orchestratorSummary(value: OrchestratorList | OrchestratorDetail | OrchestratorOperation): string {
  if ("items" in value)
    return (
      value.items
        .map(
          (item) =>
            `${item.id}\t${item.configuration.name}\t${item.state}\t${item.configuration.harness}/${item.configuration.model}\t${item.configuration.provider}\trev ${item.revision}`,
        )
        .join("\n") || "No orchestrators."
    );
  if ("orchestrator" in value) {
    const item = value.orchestrator;
    return `${item.configuration.name} (${item.id})\n${item.state}; continuity ${item.continuity}; revision ${item.revision}\n${item.configuration.harness}/${item.configuration.model} on ${item.configuration.provider}\nIdle deadline: ${item.idleDeadline ?? "none"}${item.blockedReason ? `\nBlocked: ${item.blockedReason}` : ""}\n${value.operations.length} operations; ${value.waits.length} waits; ${value.childSandboxIds.length} children`;
  }
  return `${value.kind} ${value.state}: operation ${value.id}; orchestrator ${value.orchestratorId}; revision ${value.revision}${value.errorCode ? `; ${value.errorCode}` : ""}`;
}

export function orchestratorEventSummary(event: OrchestratorEvent): string {
  // Preserve new event kinds rather than silently dropping their contents.
  return `${event.id}\t${event.at}\t${JSON.stringify(event)}`;
}
