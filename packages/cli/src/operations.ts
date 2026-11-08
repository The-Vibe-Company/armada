import { GoldenError } from "@armada/core";
import { parseArgs, single } from "./args.ts";
import type { AuthIo } from "./auth-commands.ts";
import { control } from "./control.ts";

/** API-only command boundary: server-side schemas and policy remain authoritative. */
export async function operation(
  command: string,
  argv: readonly string[],
  auth: AuthIo,
  read: (path?: string) => Promise<string>,
) {
  const args = parseArgs(argv);
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
    const minimum = command === "wait" ? 0 : 1;
    if (!Number.isSafeInteger(seconds) || seconds < minimum || seconds > 600)
      throw new GoldenError("invalid_config", `--timeout must be ${minimum}–600 seconds.`);
  }
  let route: string;
  if (command === "mcp") {
    const [action, id, ...extra] = args.positionals;
    const actions = ["list", "add", "update", "connect", "status", "reconnect", "disable", "revoke", "delete"];
    if (!action || !actions.includes(action) || extra.length || (action !== "list" && action !== "add" && !id))
      throw new GoldenError(
        "invalid_config",
        `Run armada mcp ${actions.join("| ")} [id] [--org UUID] [--file definition.json].`,
      );
    route = `mcp/${action === "add" ? "create" : action}`;
    if (id) body.id = id;
    if (action === "add" || action === "update") {
      let definition: unknown;
      try {
        definition = JSON.parse(await read(single(args, "--file")));
      } catch {
        throw new GoldenError("invalid_config", "Supply a JSON definition on stdin or --file.");
      }
      if (!definition || typeof definition !== "object" || Array.isArray(definition))
        throw new GoldenError("invalid_config", "Expected a connection object.");
      Object.assign(body, definition);
      // CLI selectors cannot be overridden by an imported definition.
      if (id) body.id = id;
      if (single(args, "--org")) body.org = single(args, "--org");
    }
  } else {
    route = `sandbox/${command}`;
    const [id, ...rest] = args.positionals;
    if (command !== "list") {
      if (!id) throw new GoldenError("invalid_config", `armada ${command} needs a sandbox id.`);
      body.id = id;
    }
    if (command === "send" || command === "steer" || command === "exec") {
      if (!rest.length) throw new GoldenError("invalid_config", "Provide the prompt or command after the id.");
      body[command === "send" ? "prompt" : command === "steer" ? "text" : "command"] = rest.join(" ");
    } else if ((command === "list" && id) || rest.length)
      throw new GoldenError("invalid_config", "Unexpected arguments.");
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
    seconds === undefined ? undefined : AbortSignal.timeout((seconds + 15) * 1_000),
  );
  auth.out(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}
