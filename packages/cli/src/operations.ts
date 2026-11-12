import { AuthError } from "@armada/auth";
import { GoldenError, HARNESSES } from "@armada/core";
import { flag, parseArgs, single } from "./args.ts";
import { ArmadaApiError, createArmadaApiClient } from "./armada-api.ts";
import type { AuthIo } from "./auth-commands.ts";
import { authorizeConnection, type ConnectionStatus, validateConnectionStatus } from "./connection-authorization.ts";
import { control } from "./control.ts";
import { resourceAdviceText } from "./resource-advice.ts";
import { sandboxListText } from "./sandbox-list.ts";

/** API-only command boundary: server-side schemas and policy remain authoritative. */
export async function operation(
  command: string,
  argv: readonly string[],
  auth: AuthIo,
  read: (path?: string) => Promise<string>,
  readOptionalStdin: () => Promise<string> = async () => "",
) {
  const args = parseArgs(
    argv,
    command === "report"
      ? ["--reason", "--pr-number", "--pr-url", "--head-sha"]
      : command === "mcp"
        ? ["--scope", "--service"]
        : command === "list"
          ? ["--status", "--harness", "--golden", "--owner", "--page", "--limit"]
          : [],
    command === "list" ? ["--page-info"] : command === "rm" ? ["--yes"] : [],
  );
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
    const result = await client.request<{ id: string; status: "deleted" }>(
      `/api/v1/sandboxes/${id}${org ? `?org=${encodeURIComponent(org)}` : ""}`,
      { method: "DELETE" },
    );
    auth.out(flag(args, "--json") ? `${JSON.stringify(result)}\n` : `Deleted sandbox ${result.id}.\n`);
    return 0;
  }
  if (single(args, "--repo") !== undefined)
    throw new GoldenError(
      "invalid_config",
      "Repository context is immutable; select --repo at launch, not on later operations.",
    );
  const body: Record<string, unknown> = {};
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
    const minimum = command === "wait" || command === "mcp" ? 0 : 1;
    if (!Number.isSafeInteger(seconds) || seconds < minimum || seconds > 600)
      throw new GoldenError("invalid_config", `--timeout must be ${minimum}–600 seconds.`);
  }
  let route: string;
  if (command === "mcp") {
    const [action, ...parameters] = args.positionals;
    const actions = [
      "list",
      "catalog",
      "rename",
      "default",
      "sandbox-connections",
      "add",
      "update",
      "connect",
      "status",
      "reconnect",
      "enable",
      "disable",
      "revoke",
      "delete",
    ];
    const serviceId = single(args, "--service");
    const serviceAdd = action === "add" && serviceId !== undefined && parameters.length === 1;
    const shortcut = action === "add" && parameters.length === 2;
    if (
      !action ||
      !actions.includes(action) ||
      (action === "list" || action === "catalog"
        ? parameters.length !== 0
        : action === "add"
          ? parameters.length !== 0 && !shortcut && !serviceAdd
          : action === "rename" || action === "default"
            ? parameters.length !== 2
            : parameters.length !== 1)
    ) {
      throw new GoldenError(
        "invalid_config",
        "Run armada mcp add NAME URL, mcp add --file definition.json, or mcp <action> <id>.",
      );
    }
    const scope = single(args, "--scope");
    if (scope !== undefined && !shortcut && !serviceAdd)
      throw new GoldenError(
        "invalid_config",
        "--scope is for the URL create shortcut only; put scope in a full create definition. Updates cannot change scope.",
      );
    const id = action === "add" || action === "list" || action === "catalog" ? undefined : parameters[0];
    route = `mcp/${action === "add" ? "create" : action}`;
    if (id) body.id = id;
    if (action === "sandbox-connections") {
      uuid(id, "sandbox id");
      // sandboxId is the public read selector; id retains compatibility with the staged control adapter.
      body.sandboxId = id;
    }
    if (action === "enable" || action === "disable") {
      route = "mcp/set-enabled";
      body.enabled = action === "enable";
    }
    if (action === "reconnect") route = "mcp/connect";
    if (action === "rename" || action === "default") {
      route = "mcp/metadata";
      if (action === "rename") body.name = parameters[1];
      else {
        if (!["on", "off"].includes(parameters[1] ?? ""))
          throw new GoldenError("invalid_config", "default requires on or off.");
        body.defaultForLaunch = parameters[1] === "on";
      }
    }
    if (serviceAdd) {
      Object.assign(body, { serviceId, name: parameters[0], scope: scope ?? "personal" });
    } else if (shortcut) {
      if (single(args, "--file") !== undefined)
        throw new GoldenError("invalid_config", "Use either NAME URL or a JSON definition, not both.");
      const [name, url] = parameters;
      if (!name?.trim() || !url)
        throw new GoldenError("invalid_config", "Supply a connection name and public/OAuth URL.");
      if (scope !== undefined && scope !== "personal" && scope !== "org")
        throw new GoldenError("invalid_config", "--scope is personal or org.");
      publicConnectionUrl(url);
      let stdin: string;
      try {
        stdin = await readOptionalStdin();
      } catch {
        throw new GoldenError(
          "invalid_config",
          "Could not read stdin; run the URL shortcut with a terminal/empty stdin, or supply a JSON definition instead.",
        );
      }
      if (stdin.trim())
        throw new GoldenError("invalid_config", "Use either NAME URL or a stdin JSON definition, not both.");
      Object.assign(body, { name, url, scope: scope ?? "personal", transport: "http", authType: "auto" });
    } else if (action === "add" || action === "update") {
      let definition: unknown;
      try {
        definition = JSON.parse(await read(single(args, "--file")));
      } catch {
        throw new GoldenError("invalid_config", "Supply a JSON definition on stdin or --file.");
      }
      if (!definition || typeof definition !== "object" || Array.isArray(definition))
        throw new GoldenError("invalid_config", "Expected a connection object.");
      Object.assign(body, definition);
      // CLI selectors cannot be overridden by an imported definition; scope/auth policy stays backend-owned.
      if (id) body.id = id;
      if (single(args, "--org")) body.org = single(args, "--org");
    }
  } else {
    if (command === "list") Object.assign(body, sandboxListFilters(args));
    route = `sandbox/${command}`;
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
        throw new GoldenError(
          "invalid_config",
          "Run armada extend <sandbox-id> --ttl <duration> [--org UUID] [--json].",
        );
      body.ttl_seconds = parseTtl(ttl);
    }
    if (command === "bind-credential" || command === "repoint-credential") {
      if (command === "repoint-credential") uuid(id, "sandbox id");
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
  }
  if (command === "mcp") {
    // Registry scope must always be explicit; never infer a grant's org from its UUID.
    if (typeof body.org !== "string" || !body.org)
      throw new GoldenError("invalid_config", "Select an org with armada org use or --org UUID.");
    if (route === "mcp/connect") {
      const timeoutSeconds = body.timeout_seconds === undefined ? 300 : Number(body.timeout_seconds);
      if (timeoutSeconds < 0 || timeoutSeconds > 600)
        throw new GoldenError("invalid_config", "Authorization timeout is 0–600 seconds.");
      delete body.timeout_seconds;
      if (args.positionals[0] === "reconnect") await control(auth, "mcp/revoke", { org: body.org, id: body.id });
      const initial = await control<ConnectionStatus>(auth, route, body);
      validateConnectionStatus(initial);
      const id = String(body.id);
      if (initial.connection.id !== id)
        throw new GoldenError("invalid_config", "The server returned another connection.");
      const result = await authorizeConnection(
        auth,
        initial,
        { org: body.org, id },
        { noBrowser: flag(args, "--no-browser"), timeoutSeconds },
      );
      auth.out(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
  }
  // A long operation gets its server budget plus transport grace, without retrying an ambiguous write.
  const seconds =
    command === "wait"
      ? Number(body.timeout_seconds ?? 60)
      : command === "exec"
        ? Number(body.timeout_seconds ?? 120)
        : undefined;
  const result = await control(
    auth,
    route,
    body,
    // Match the control proxy ceiling: Modal stop includes checkpoint and termination phases.
    command === "stop"
      ? AbortSignal.timeout(660_000)
      : seconds === undefined
        ? undefined
        : AbortSignal.timeout((seconds + 15) * 1_000),
  ).catch((error: unknown) => {
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
  } else auth.out(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

/** Secret hygiene only. The server remains authoritative for endpoint validation, discovery and authorization. */
function publicConnectionUrl(value: string): void {
  try {
    const url = new URL(value);
    const secretKey =
      /^(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|key|client[_-]?secret|secret|password|authorization|headers?|bearer|credentials?|code)$/i;
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      [...url.searchParams.keys()].some((key) => secretKey.test(key))
    )
      throw new Error();
  } catch {
    throw new GoldenError(
      "invalid_config",
      "Supply a public/OAuth HTTP URL without credentials. Use stdin or --file for write-only authentication values.",
    );
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuid(value: string | undefined, flag: string): void {
  if (!value || !UUID.test(value)) throw new GoldenError("invalid_config", `${flag} must be a UUID.`);
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
    if (!HARNESSES.some((value) => value === selected))
      throw new GoldenError("invalid_config", "Agent must be claude or codex.");
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
