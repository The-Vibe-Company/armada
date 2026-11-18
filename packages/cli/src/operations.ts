import { AuthError } from "@armada/auth";
import { GoldenError, HARNESSES } from "@armada/core";
import { invalidAgentMessage } from "./agent-validation.ts";
import { acceptedOptions, flag, parseArgs, single, uuid } from "./args.ts";
import { ArmadaApiError, type ArmadaCommandClient, createArmadaApiClient } from "./armada-api.ts";
import type { AuthIo } from "./auth-commands.ts";
import { mcpCommand } from "./mcp-commands.ts";
import { resourceAdviceText } from "./resource-advice.ts";
import { sandboxListText } from "./sandbox-list.ts";

/** API-only command boundary: server-side schemas and policy remain authoritative. */
export async function operation(
  command: Exclude<keyof ArmadaCommandClient["sandboxes"], "launch" | "logs"> | "rm" | "mcp",
  argv: readonly string[],
  auth: AuthIo,
  read: (path?: string) => Promise<string>,
  readOptionalStdin: () => Promise<string> = async () => "",
) {
  if (command === "mcp") return mcpCommand(argv, auth, read, readOptionalStdin);
  const args = parseArgs(
    argv,
    command === "report"
      ? ["--reason", "--pr-number", "--pr-url", "--head-sha"]
      : command === "send"
        ? ["--request-id"]
        : command === "list"
          ? ["--status", "--harness", "--golden", "--owner", "--page", "--limit"]
          : [],
    command === "list" ? ["--page-info"] : command === "rm" ? ["--yes"] : command === "status" ? ["--live"] : [],
  );
  const options: Record<string, readonly string[]> = {
    list: ["--status", "--agent", "--harness", "--golden", "--owner", "--page", "--limit", "--page-info"],
    status: ["--live", "--prompt-id"],
    detail: ["--prompt-id"],
    recovery: [],
    advice: [],
    send: ["--request-id", "--conversation", "--model", "--reasoning-effort"],
    steer: ["--conversation"],
    exec: ["--cwd", "--timeout"],
    stop: [],
    wait: ["--timeout", "--prompt-id"],
    interrupt: ["--conversation"],
    report: [
      "--prompt-id",
      ...(args.positionals[1] === "blocked" ? ["--reason"] : ["--pr-number", "--pr-url", "--head-sha"]),
    ],
    "bind-credential": ["--credential-id"],
    extend: ["--ttl"],
    rm: ["--yes"],
  };
  acceptedOptions(args, command, ["--org", "--json", ...(options[command] ?? [])]);
  if (command === "rm") {
    const [id, ...extra] = args.positionals;
    uuid(id, "sandbox id");
    if (extra.length || [...args.options.keys()].some((key) => !["--yes", "--org", "--json"].includes(key)))
      throw new GoldenError("invalid_config", "Run armada rm <sandbox-id> --yes [--org UUID] [--json].");
    if (!flag(args, "--yes"))
      throw new GoldenError(
        "invalid_config",
        "Deletion permanently removes the disk and recovery archives. Pass --yes to confirm.",
      );
    const org = single(args, "--org");
    if (org) uuid(org, "--org");
    const client = await createArmadaApiClient(auth);
    const result = await client.deleteSandbox<{ id: string; status: "deleted" }>(id, org);
    auth.out(flag(args, "--json") ? `${JSON.stringify(result)}\n` : `Deleted sandbox ${result.id}.\n`);
    return 0;
  }
  if (single(args, "--repo") !== undefined)
    throw new GoldenError(
      "invalid_config",
      "Repository context is immutable; select --repo at launch, not on later operations.",
    );
  const body: Record<string, unknown> = {};
  if (command === "status") body.recorded = !flag(args, "--live");
  for (const [flag, key] of Object.entries({
    "--org": "org",
    "--model": "model",
    "--reasoning-effort": "reasoning_effort",
    "--conversation": "conversation_id",
    "--cwd": "cwd",
    "--prompt-id": "prompt_id",
  })) {
    const value = single(args, flag);
    if (value !== undefined) body[key] = value;
  }
  const timeout = single(args, "--timeout");
  if (timeout !== undefined) {
    if (!/^\d+$/.test(timeout)) throw new GoldenError("invalid_config", "--timeout is seconds.");
    const seconds = Number(timeout);
    body.timeout_seconds = seconds;
    const minimum = command === "wait" ? 0 : 1;
    if (!Number.isSafeInteger(seconds) || seconds < minimum || seconds > 600)
      throw new GoldenError("invalid_config", `--timeout must be ${minimum}–600 seconds.`);
  }
  if (command === "send") {
    const requestId = single(args, "--request-id");
    if (requestId !== undefined) uuid(requestId, "--request-id");
    body.request_id = requestId?.toLowerCase() ?? crypto.randomUUID();
  }
  if (command === "list") Object.assign(body, sandboxListFilters(args));
  const [id, ...rest] = args.positionals;
  if (command !== "list") {
    if (!id) throw new GoldenError("invalid_config", `armada ${command} needs a sandbox id.`);
    body.id = id;
  }
  if (command === "extend") {
    uuid(id, "sandbox id");
    const org = single(args, "--org");
    if (org !== undefined) uuid(org, "--org");
    const ttl = single(args, "--ttl");
    if (ttl === undefined || [...args.options.keys()].some((key) => !["--ttl", "--org", "--json"].includes(key)))
      throw new GoldenError("invalid_config", "Run armada extend <sandbox-id> --ttl <duration> [--org UUID] [--json].");
    body.ttlSeconds = parseTtl(ttl);
  }
  if (command === "bind-credential") {
    const credentialId = single(args, "--credential-id");
    uuid(credentialId, "credential id");
    body.credentialId = credentialId;
  }
  if (command === "report") {
    const [state] = rest;
    if (rest.length !== 1 || (state !== "ready" && state !== "blocked") || !body.prompt_id)
      throw new GoldenError("invalid_config", "Use report <id> ready|blocked --prompt-id ID.");
    const outcome: Record<string, unknown> = { state };
    if (state === "blocked") outcome.reason = single(args, "--reason");
    else {
      const number = single(args, "--pr-number");
      if (number !== undefined) outcome.prNumber = Number(number);
      const url = single(args, "--pr-url");
      if (url !== undefined) outcome.prUrl = url;
      const sha = single(args, "--head-sha");
      if (sha !== undefined) outcome.headSha = sha;
    }
    body.outcome = outcome;
  } else if (command === "send" || command === "steer" || command === "exec") {
    if (!rest.length) throw new GoldenError("invalid_config", "Provide the prompt or command after the id.");
    body[command === "send" ? "prompt" : command === "steer" ? "text" : "command"] = rest.join(" ");
  } else if ((command === "list" && id) || rest.length)
    throw new GoldenError("invalid_config", "Unexpected arguments.");
  // A long operation gets its server budget plus transport grace, without retrying an ambiguous write.
  const seconds =
    command === "wait"
      ? Number(body.timeout_seconds ?? 60)
      : command === "exec"
        ? Number(body.timeout_seconds ?? 120)
        : undefined;
  if (command === "send" && !flag(args, "--json"))
    auth.err("Sending message… Waking the sandbox if paused; waiting for acceptance.\n");
  // Match the control proxy ceiling: send may restore paused compute before admitting the turn.
  const signal =
    command === "stop" || command === "bind-credential" || command === "send"
      ? AbortSignal.timeout(660_000)
      : seconds === undefined
        ? undefined
        : AbortSignal.timeout((seconds + 15) * 1_000);
  const request = createArmadaApiClient(auth).then((client) =>
    client.sandboxes[command](body, signal ? { signal } : undefined),
  );
  const result = await request.catch((error: unknown) => {
    // Stop previously collapsed these versioned reasons into an AuthError.
    if (
      command === "stop" &&
      error instanceof ArmadaApiError &&
      error.code === "unavailable" &&
      error.serverCode !== "unavailable" &&
      error.legacyCode === undefined
    )
      throw new ArmadaApiError(
        error.serverCode,
        error.status,
        error.status >= 500
          ? `${error.message} Stop may already have been accepted. Run armada list --json to check state before retrying.`
          : error.message,
        error.details,
        "unavailable",
        1,
      );
    if (
      command === "stop" &&
      error instanceof AuthError &&
      !(error instanceof ArmadaApiError) &&
      error.code === "unavailable"
    )
      throw new AuthError(
        `${error.message} Outcome unknown. Run armada status ${args.positionals[0]} to check before retrying.`,
        "unavailable",
      );
    if (command === "send" && error instanceof AuthError)
      error.message += ` Send request ID: ${body.request_id}. Keep it with the original input when investigating uncertain delivery.`;
    throw error;
  });

  if (command === "advice" && !flag(args, "--json")) {
    const { advice } = result as import("@armada/core").ResourceAdviceResponse;
    auth.out(`${resourceAdviceText(advice) ?? `No resource recommendation (${advice.reason}); defaults unchanged.`}\n`);
  } else if (command === "list" && !flag(args, "--page-info")) {
    const page = result as { sandboxes?: unknown };
    if (!Array.isArray(page?.sandboxes))
      throw new GoldenError("invalid_config", "Armada returned an invalid sandbox page.");
    if (flag(args, "--json") || flag(args, "--page-info"))
      auth.out(`${JSON.stringify(flag(args, "--page-info") ? result : { sandboxes: page.sandboxes }, null, 2)}\n`);
    else auth.out(sandboxListText(page.sandboxes, auth.now()));
  } else {
    if (command === "status" && !flag(args, "--json") && result && typeof result === "object" && "prompt" in result) {
      const prompt = result.prompt as {
        rateLimit?: { message: string; retryCount: number; totalWaitMs: number } | null;
      } | null;
      if (prompt?.rateLimit)
        auth.out(
          `${prompt.rateLimit.message} (retry ${prompt.rateLimit.retryCount}, total wait ${Math.ceil(prompt.rateLimit.totalWaitMs / 1000)} s)\n`,
        );
    }
    auth.out(`${JSON.stringify(result, null, 2)}\n`);
  }
  return 0;
}

function sandboxListFilters(args: ReturnType<typeof parseArgs>): Record<string, unknown> {
  const allowed = new Set([
    "--status",
    "--agent",
    "--harness",
    "--golden",
    "--owner",
    "--page",
    "--limit",
    "--org",
    "--json",
    "--page-info",
  ]);
  for (const key of args.options.keys())
    if (!allowed.has(key)) throw new GoldenError("invalid_config", `Unsupported sandbox list option '${key}'.`);
  const body: Record<string, unknown> = {};
  const status = single(args, "--status");
  if (status !== undefined) {
    if (!["starting", "ready", "running", "stopping", "stopped", "failed", "deleted"].includes(status))
      throw new GoldenError("invalid_config", "Unknown sandbox status.");
    body.status = [status];
  }
  const agent = single(args, "--agent"),
    harness = single(args, "--harness");
  if (agent !== undefined && harness !== undefined)
    throw new GoldenError("invalid_config", "Use --agent or --harness, not both.");
  const selected = agent ?? harness;
  if (selected !== undefined) {
    if (!HARNESSES.some((value) => value === selected)) throw new GoldenError("invalid_config", invalidAgentMessage());
    body.harness = selected;
  }
  const golden = single(args, "--golden"),
    owner = single(args, "--owner");
  if (golden !== undefined) {
    uuid(golden, "--golden");
    body.golden = golden;
  }
  if (owner !== undefined) {
    if (owner !== "me") uuid(owner, "--owner");
    body.owner = owner;
  }
  for (const [flag, key, max] of [
    ["--page", "page", 1_000_000],
    ["--limit", "limit", 200],
  ] as const) {
    const value = single(args, flag);
    if (value !== undefined) {
      const number = Number(value);
      if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(number) || number > max)
        throw new GoldenError("invalid_config", `${flag} must be 1–${max}.`);
      body[key] = number;
    }
  }
  return body;
}

/** `90`, `90s`, `30m`, `4h` or `2d`. A bare number is seconds. */
export function parseTtl(value: string): number {
  const match = /^([1-9][0-9]*)([smhd]?)$/.exec(value);
  const unit = { "": 1, s: 1, m: 60, h: 3600, d: 86_400 }[match?.[2] ?? ""];
  if (!match?.[1] || unit === undefined) {
    throw new GoldenError("invalid_config", `--ttl '${value}' is not a duration. Use 90, 30m, 4h or 2d.`);
  }
  return Number(match[1]) * unit;
}
