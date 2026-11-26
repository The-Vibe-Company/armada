import { AuthError } from "@armada/auth";
import { GoldenError, HARNESSES } from "@armada/core";
import {
  DEFAULT_WAIT_SECONDS,
  type ListInput,
  type ListResult,
  MAX_WAIT_SECONDS,
  type WaitResult,
} from "@armada/core/contract";
import { sandboxListInput } from "@armada/core/contract/sandbox";
import { invalidAgentMessage } from "./agent-validation.ts";
import { ArmadaApiError } from "./api-responses.ts";
import { acceptedOptions, flag, parseArgs, single, uuid } from "./args.ts";
import type { AuthIo } from "./auth-commands.ts";
import {
  type CurrentSandboxFile,
  readCurrentSandbox,
  resolveSandboxId,
  resolveSandboxReference,
} from "./current-sandbox.ts";
import { setupStatus } from "./devx.ts";
import { sandboxListText } from "./sandbox-list.ts";
import { type ArmadaCommandClient, createSdkCommandClient } from "./sdk-session.ts";

export async function operation(
  command:
    | Exclude<
        keyof ArmadaCommandClient["sandboxes"],
        | "launch"
        | "list"
        | "logs"
        | "send"
        | "steer"
        | "status"
        | "wait"
        | "advice"
        | "recovery"
        | "extend"
        | "interrupt"
      >
    | "ls"
    | "info"
    | "rm",
  argv: readonly string[],
  auth: AuthIo,
  sandboxFile?: CurrentSandboxFile,
) {
  const args = parseArgs(
    argv,
    command === "report"
      ? ["--reason", "--pr-number", "--pr-url", "--head-sha"]
      : command === "ls"
        ? ["--status", "--ref", "--harness", "--golden", "--owner", "--page", "--limit"]
        : [],
    command === "ls"
      ? ["--page-info"]
      : command === "rm"
        ? ["--yes"]
        : command === "info"
          ? ["--live", "--setup", "--wait"]
          : command === "stop"
            ? ["--turn", "--after"]
            : [],
  );
  const end = argv.indexOf("--");
  if (command === "exec" && (end < 0 || end === argv.length - 1 || args.positionals.length > argv.length - end))
    throw new GoldenError("invalid_config", "Use armada exec [sandbox-id] -- COMMAND.");
  const implicitWithPayload = command === "exec" && end >= 0 && args.positionals.length === argv.length - end - 1;
  const implicitReport =
    command === "report" && args.positionals.length === 1 && ["ready", "blocked"].includes(args.positionals[0] ?? "");
  const [id, ...rest] = implicitWithPayload || implicitReport ? [undefined, ...args.positionals] : args.positionals;
  const options: Record<string, readonly string[]> = {
    ls: ["--status", "--ref", "--agent", "--harness", "--golden", "--owner", "--page", "--limit", "--page-info"],
    info: ["--live", "--prompt-id", "--setup", "--wait", "--timeout"],
    exec: ["--cwd", "--timeout"],
    stop: ["--turn", "--after", "--timeout"],
    report: ["--prompt-id", ...(rest[0] === "blocked" ? ["--reason"] : ["--pr-number", "--pr-url", "--head-sha"])],
    "bind-credential": ["--credential-id"],
    rm: ["--yes"],
  };
  acceptedOptions(args, command, ["--org", "--json", ...(options[command] ?? [])]);
  const org = single(args, "--org");
  const wait = command === "info" && flag(args, "--wait");
  const after = command === "stop" && flag(args, "--after");
  const turn = command === "stop" && flag(args, "--turn");
  if (after && turn) throw new GoldenError("invalid_config", "Choose --turn or --after.");
  let current: string | undefined;
  if (command === "info") {
    const setup = flag(args, "--setup");
    const live = flag(args, "--live");
    const timeout = single(args, "--timeout");
    if (wait && live) throw new GoldenError("invalid_config", "Choose --live or --wait.");
    if (timeout !== undefined && !wait) throw new GoldenError("invalid_config", "Pass --wait to use --timeout.");
    const sandboxRequested = id !== undefined || live || wait || flag(args, "--prompt-id");
    if (setup && sandboxRequested)
      throw new GoldenError(
        "invalid_config",
        "--setup cannot be combined with a sandbox ID, --live, --wait, or --prompt-id.",
      );
    if (rest.length) throw new GoldenError("invalid_config", "Unexpected arguments.");
    if (!setup && id === undefined) current = await readCurrentSandbox(auth.env, sandboxFile);
    if (setup || (!sandboxRequested && !current)) return setupStatus(org, flag(args, "--json"), auth);
  }
  let api: Promise<ArmadaCommandClient> | undefined;
  const client = () => (api ??= createSdkCommandClient(auth));
  const list = async (body: ListInput) => (await client()).sandboxes.list<ListResult>(body);
  const resolveId = (id: string | undefined) =>
    command === "info"
      ? resolveSandboxReference(id, current, org, list)
      : resolveSandboxId(id, auth.env, sandboxFile, org, list);
  if (command === "rm") {
    const [id, ...extra] = args.positionals;
    if (!id || extra.length || [...args.options.keys()].some((key) => !["--yes", "--org", "--json"].includes(key)))
      throw new GoldenError("invalid_config", "Run armada rm <sandbox-id> --yes [--org UUID] [--json].");
    if (!flag(args, "--yes"))
      throw new GoldenError(
        "invalid_config",
        "Deletion permanently removes the disk and recovery archives. Pass --yes to confirm.",
      );
    if (org) uuid(org, "--org");
    uuid(id, "sandbox id");
    const result = await (await client()).deleteSandbox<{ id: string; status: "deleted" }>(id.toLowerCase(), org);
    auth.out(flag(args, "--json") ? `${JSON.stringify(result)}\n` : `Deleted sandbox ${result.id}.\n`);
    return 0;
  }
  const body: Record<string, unknown> = {};
  if (command === "info" && !wait) body.recorded = !flag(args, "--live");
  for (const [flag, key] of Object.entries({
    "--org": "org",
    "--cwd": "cwd",
    "--prompt-id": "prompt_id",
  })) {
    const value = single(args, flag);
    if (value !== undefined) body[key] = value;
  }
  const timeout = single(args, "--timeout");
  if (timeout !== undefined) {
    if (command === "stop" && !after) throw new GoldenError("invalid_config", "Pass --after to use --timeout.");
    if (!/^\d+$/.test(timeout)) throw new GoldenError("invalid_config", "--timeout is seconds.");
    const seconds = Number(timeout);
    body.timeout_seconds = seconds;
    const minimum = wait || after ? 0 : 1;
    if (!Number.isSafeInteger(seconds) || seconds < minimum || seconds > MAX_WAIT_SECONDS)
      throw new GoldenError("invalid_config", `--timeout must be ${minimum}–${MAX_WAIT_SECONDS} seconds.`);
  }
  if (command === "ls") Object.assign(body, sandboxListFilters(args));
  if (command === "bind-credential") {
    const credentialId = single(args, "--credential-id");
    uuid(credentialId, "credential id");
    body.credentialId = credentialId;
  }
  if (command === "report") {
    const [state] = rest;
    if (rest.length !== 1 || (state !== "ready" && state !== "blocked") || !body.prompt_id)
      throw new GoldenError("invalid_config", "Use report [sandbox-id] ready|blocked --prompt-id ID.");
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
  } else if (command === "exec") {
    if (!rest.length) throw new GoldenError("invalid_config", "Provide the command after the id.");
    body.command = rest.join(" ");
  } else if ((command === "ls" && id) || rest.length) throw new GoldenError("invalid_config", "Unexpected arguments.");
  if (command !== "ls") {
    body.id = await resolveId(id);
  }
  const seconds = wait
    ? Number(body.timeout_seconds ?? DEFAULT_WAIT_SECONDS)
    : command === "exec"
      ? Number(body.timeout_seconds ?? 120)
      : undefined;
  let action: keyof ArmadaCommandClient["sandboxes"];
  switch (command) {
    case "stop":
      action = turn ? "interrupt" : "stop";
      break;
    case "info":
      action = wait ? "wait" : "status";
      break;
    case "ls":
      action = "list";
      break;
    default:
      action = command;
  }
  if (after) {
    const waitSeconds = Number(body.timeout_seconds ?? DEFAULT_WAIT_SECONDS);
    const { sandboxes } = await client();
    const deadline = auth.now().getTime() + waitSeconds * 1_000;
    const waited = await sandboxes.wait<WaitResult>(
      { id: body.id, org, timeout_seconds: waitSeconds },
      { signal: AbortSignal.timeout((waitSeconds + 15) * 1_000) },
    );
    if (waited.timedOut || auth.now().getTime() >= deadline) {
      auth.out(`${JSON.stringify({ id: waited.id, status: waited.status, timedOut: true }, null, 2)}\n`);
      return 0;
    }
    delete body.timeout_seconds;
    body.only_if_idle = true;
  }
  const signal =
    action === "stop" || action === "bind-credential"
      ? AbortSignal.timeout(660_000)
      : seconds === undefined
        ? undefined
        : AbortSignal.timeout((seconds + 15) * 1_000);
  const request = client().then((client) => client.sandboxes[action](body, signal ? { signal } : undefined));
  const result = await request.catch((error: unknown) => {
    if (
      action === "stop" &&
      error instanceof ArmadaApiError &&
      error.code === "unavailable" &&
      error.status >= 500 &&
      error.serverCode !== "unavailable"
    )
      throw new ArmadaApiError(
        error.serverCode,
        error.status,
        `${error.message} Stop may already have been accepted. Run armada ls --json to check state before retrying.`,
        error.details,
        1,
      );
    if (
      action === "stop" &&
      error instanceof AuthError &&
      !(error instanceof ArmadaApiError) &&
      error.code === "unavailable"
    )
      throw new AuthError(
        `${error.message} Outcome unknown. Run armada info ${body.id} to check before retrying.`,
        "unavailable",
      );
    throw error;
  });

  if (command === "ls" && !flag(args, "--page-info")) {
    const page = result as { sandboxes?: unknown };
    if (!Array.isArray(page?.sandboxes)) throw new AuthError("Armada returned an invalid sandbox page.", "unavailable");
    if (flag(args, "--json") || flag(args, "--page-info"))
      auth.out(`${JSON.stringify(flag(args, "--page-info") ? result : { sandboxes: page.sandboxes }, null, 2)}\n`);
    else auth.out(sandboxListText(page.sandboxes, auth.now()));
  } else {
    if (
      command === "info" &&
      !wait &&
      !flag(args, "--json") &&
      result &&
      typeof result === "object" &&
      "prompt" in result
    ) {
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
  const body: Record<string, unknown> = {};
  const ref = single(args, "--ref");
  if (ref !== undefined) {
    const parsed = sandboxListInput.shape.externalRef.safeParse(ref);
    if (!parsed.success) throw new GoldenError("invalid_config", `--ref: ${parsed.error.issues[0]?.message}`);
    body.externalRef = parsed.data;
  }
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

export function parseTtl(value: string): number {
  const match = /^([1-9][0-9]*)([smhd]?)$/.exec(value);
  const unit = { "": 1, s: 1, m: 60, h: 3600, d: 86_400 }[match?.[2] ?? ""];
  if (!match?.[1] || unit === undefined) {
    throw new GoldenError("invalid_config", `--ttl '${value}' is not a duration. Use 90, 30m, 4h or 2d.`);
  }
  return Number(match[1]) * unit;
}
