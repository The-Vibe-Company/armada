import { AuthError } from "@armada/auth";
import {
  ORCHESTRATOR_CONTRACT_VERSION,
  ORCHESTRATOR_DEFAULTS,
  type OrchestratorCreate,
  type OrchestratorDetail,
  type OrchestratorEvent,
  type OrchestratorEventPage,
  type OrchestratorFence,
  type OrchestratorList,
  type OrchestratorMessage,
  type OrchestratorOperation,
  parseMachineSize,
} from "@armada/core";
import { type Args, parseArgs, single } from "./args.ts";
import { ArmadaApiError, createArmadaApiClient } from "./armada-api.ts";
import type { AuthIo } from "./auth-commands.ts";

export const ORCHESTRATOR_HELP = `Usage: armada orchestrator <command> [options]
  create <name> --org <id> --golden <id> --provider boat|modal --agent claude|codex
         --model <id> --model-account <id> [--reasoning-effort <level>] [--repo <repository>]
         [--size small|medium|large|xlarge] [--idle-seconds <900..86400>] --idempotency-key <key>
  list --org <id> [--cursor <cursor>] [--limit <1..100>]
  capabilities
  detail <id> --org <id>
  send|steer <id> <text> --org <id> --expected-revision <revision> --idempotency-key <key>
  stop|resume|recover <id> --org <id> --expected-revision <revision> --idempotency-key <key>
  events <id> --org <id> [--cursor <cursor>] [--limit <1..500>] [--all|--follow]
  Omit --size to use server repository > golden > legacy defaults.
  All commands accept --json. Events with --json emit one JSON page per line,
  including the server cursor for reconnect. Reuse the original key and identical
  arguments after an uncertain mutation; inspect detail/events for completion.
  Recover nonallocatingly terminates an exact uncertain first create or blocked first-incarnation stop;
  repeat its original key/arguments to retry only that exact termination.
  Completed recovery receipts replay read-only; recovery never forks.
  Resume restores native state without sending a prompt. The server decides
  availability, account access, continuity and lifecycle; no local quota policy.
`;

type ReadCommand = { action: "list" | "detail" | "events" | "capabilities"; id?: string; query: URLSearchParams };
type MutationCommand = {
  action: "create" | "message" | "steer" | "stop" | "resume" | "recover";
  id?: string;
  key: string;
  orgId: string;
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
    "--size",
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
      "--size",
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
      // Actual #662 b6ca6e1 additive size field; shared #653 validator, no local policy.
      ...(single(args, "--size") === undefined ? {} : { size: parseMachineSize(single(args, "--size")) }),
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
    command = { action, key: idempotencyKey(args), orgId: body.orgId, body };
  } else if (action === "list" || action === "detail" || action === "events" || action === "capabilities") {
    if (positionals.length !== (action === "list" || action === "capabilities" ? 0 : 1))
      usage(`${action} ${action === "list" ? "takes no ID" : "needs one ID"}.`);
    const query = new URLSearchParams();
    if (action !== "capabilities") {
      allow("--org");
      query.set("orgId", required(args, "--org"));
    }
    if (action === "list") allow("--cursor", "--limit");
    if (action === "events") allow("--cursor", "--limit", "--all", "--follow");
    if (action === "list" || action === "events") {
      const cursor = single(args, "--cursor");
      if (cursor !== undefined) query.set("cursor", cursor);
      if (single(args, "--limit") !== undefined)
        query.set("limit", String(integer(args, "--limit", 1, action === "list" ? 100 : 500)));
    }
    command = { action, ...(positionals[0] === undefined ? {} : { id: positionals[0] }), query };
  } else if (
    action === "send" ||
    action === "steer" ||
    action === "stop" ||
    action === "resume" ||
    action === "recover"
  ) {
    const message = action === "send" || action === "steer";
    if (positionals.length !== (message ? 2 : 1) || (message && !positionals[1]?.trim()))
      usage(`${action} needs one ID${message ? " and one nonempty text argument" : ""}.`);
    allow("--expected-revision", "--idempotency-key", "--org");
    const fence: OrchestratorFence = {
      expectedRevision: integer(args, "--expected-revision", 0, Number.MAX_SAFE_INTEGER),
    };
    command = {
      action: action === "send" ? "message" : action,
      id: positionals[0] as string,
      key: idempotencyKey(args),
      orgId: required(args, "--org"),
      body: message ? { ...fence, text: positionals[1] as string } : fence,
    };
  } else usage("Choose create, list, detail, send, steer, stop, resume, recover, events or capabilities.");
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
  if (key.trim() !== key || !/^[\x20-\x7e]{1,128}$/.test(key))
    usage("--idempotency-key must contain 1–128 printable ASCII characters without leading or trailing spaces.");
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

/** Candidate #662 HTTP contract. No provider, authority, store or control-proxy implementation here. */
export async function orchestratorCommand(argv: readonly string[], auth: AuthIo): Promise<number> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "help") {
    auth.out(ORCHESTRATOR_HELP);
    return 0;
  }
  const command = parseOrchestratorCommand(argv);
  const client = await createArmadaApiClient(auth, { preserveServerErrors: true });
  const root = "/api/v1/orchestrators";
  if ("body" in command) {
    const path =
      command.action === "create" ? root : `${root}/${encodeURIComponent(command.id ?? "")}/${command.action}`;
    let result: OrchestratorOperation;
    try {
      result = versioned(
        await client.request<OrchestratorOperation>(path, {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": command.key },
          body: JSON.stringify({ ...command.body, orgId: command.orgId }),
          // Boat archival alone can take 150s, before history/receipt publication.
          ...(command.action === "stop" ? { signal: AbortSignal.timeout(300_000) } : {}),
        }),
      );
    } catch (error) {
      if (
        command.action === "stop" &&
        error instanceof AuthError &&
        !(error instanceof ArmadaApiError) &&
        error.code === "unavailable"
      )
        throw new AuthError(
          `Stop outcome unknown. Run armada orchestrator detail ${command.id} --org ${command.orgId} and check events before retrying with the same idempotency key.`,
          "unavailable",
        );
      throw error;
    }
    auth.out(`${command.json ? JSON.stringify(result) : orchestratorSummary(result)}\n`);
    return result.state === "failed" || result.state === "uncertain" ? 1 : 0;
  }
  if (command.action === "capabilities") {
    const result = versioned(
      await client.request<{ version: 1; enabled: boolean; reason: string }>(`${root}/capabilities`),
    );
    auth.out(
      `${command.json ? JSON.stringify(result) : `Orchestrators ${result.enabled ? "enabled" : "disabled"}: ${result.reason}`}\n`,
    );
    return 0;
  }
  const path =
    command.action === "list"
      ? root
      : `${root}/${encodeURIComponent(command.id ?? "")}${command.action === "events" ? "/events" : ""}`;
  if (command.action !== "events") {
    const result = versioned(await client.request<OrchestratorList | OrchestratorDetail>(`${path}?${command.query}`));
    auth.out(`${command.json ? JSON.stringify(result) : orchestratorSummary(result)}\n`);
    return 0;
  }
  // No mutation retries, no synthetic prompts, and no cursor advancement before page delivery.
  // A failed poll exits with the last delivered cursor still present in stdout for reconnect.
  for (;;) {
    const page = versioned(await client.request<OrchestratorEventPage>(`${path}?${command.query}`));
    if (
      !Array.isArray(page.events) ||
      typeof page.hasMore !== "boolean" ||
      (page.cursor !== null && typeof page.cursor !== "string")
    )
      throw new AuthError("Invalid orchestrator event page.", "unavailable");
    auth.out(
      command.json
        ? `${JSON.stringify(page)}\n`
        : `${page.events.map(orchestratorEventSummary).join("\n")}${page.events.length ? "\n" : ""}Cursor: ${JSON.stringify(page.cursor)}\n`,
    );
    if (!command.all && !command.follow) return 0;
    const previous = command.query.get("cursor");
    if (page.cursor !== null) command.query.set("cursor", page.cursor);
    if (page.hasMore && (page.cursor === null || page.cursor === previous))
      throw new AuthError(
        "Orchestrator event cursor did not advance; reconnect from the last delivered cursor.",
        "unavailable",
      );
    if (!page.hasMore) {
      if (!command.follow) return 0;
      await (auth.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(1000);
    }
  }
}

function versioned<T extends { version: number }>(value: T): T {
  if (!value || value.version !== ORCHESTRATOR_CONTRACT_VERSION)
    throw new AuthError("Unsupported orchestrator response version.", "unavailable");
  return value;
}
