import { AuthError } from "@armada/auth";
import { GoldenError } from "@armada/core";
import { type LogsInput, type LogsResult, readLogsOperation, sandboxOperations } from "@armada/core/contract";
import type { Armada } from "@armada/sdk";
import { validApiReceipt } from "../api-receipts.ts";
import { acceptedOptions, flag, parseArgs, single } from "../args.ts";
import { resolveSandboxId } from "../current-sandbox.ts";
import { sandboxFailure } from "../sandbox-errors.ts";
import { ArmadaApiError, createArmadaSdkReader, resolveArmadaOrigin } from "../sdk-session.ts";
import type { Command } from "./command.ts";

const events: Command["run"] = async (argv, { io, deps, auth }) => {
  const args = parseArgs(argv, ["--tail"], ["-f"]);
  acceptedOptions(args, "events", ["-f", "--tail", "--org", "--json"]);
  if (args.positionals.length > 1) throw new GoldenError("invalid_config", "Pass at most one sandbox ID.");
  const tail = single(args, "--tail");
  const limit = Number(tail);
  if (tail !== undefined && (!/^\d+$/.test(tail) || limit < 1 || limit > 1000))
    throw new GoldenError("invalid_config", "--tail must be between 1 and 1000.");
  const org = single(args, "--org");
  const follow = flag(args, "-f");
  const json = flag(args, "--json");
  const read = await createArmadaSdkReader({ ...auth, fetch: deps.fetch ?? auth.fetch });
  const request = async <T>(path: string, call: (sdk: Armada) => Promise<T>, signal?: AbortSignal) => {
    const invalidReceipt = () =>
      new AuthError("Armada returned an invalid success receipt. Check the sandbox before retrying.", "unavailable");
    try {
      const value = await read(call, signal);
      if (!validApiReceipt(path, value)) throw invalidReceipt();
      return value;
    } catch (error) {
      if (!(error instanceof ArmadaApiError)) throw error;
      if (error.status >= 200 && error.status < 300) throw invalidReceipt();
      if (error.status === 404 && ["unknown_response", "unknown_route"].includes(error.serverCode)) {
        const origin = await resolveArmadaOrigin(auth);
        throw new ArmadaApiError(
          "unavailable",
          error.status,
          `This Armada deployment at ${origin} does not serve ${path}; the dashboard or server may be out of date. Ask an administrator to verify the deployment.`,
        );
      }
      const failure = sandboxFailure(path, error.status, error.serverCode, undefined);
      if (!failure || !error.status) throw error;
      throw new ArmadaApiError(failure.code, error.status, failure.message, undefined, failure.exitCode);
    }
  };
  const id = await resolveSandboxId(args.positionals[0], auth.env, deps.sandboxFile, org, (input) =>
    request(sandboxOperations.listSandboxes.route.path, (sdk) => sdk.list(input)),
  );
  const base: LogsInput = { id, follow, ...(org === undefined ? {} : { org }) };
  let firstTail = tail !== undefined;
  let cursor: string | null = null;

  while (true) {
    const signal = AbortSignal.timeout(600_000);
    const input: LogsInput = {
      ...base,
      ...(firstTail ? { direction: "backward", limit } : {}),
      ...(cursor === null ? {} : { cursor }),
    };
    const page: LogsResult = await request(
      readLogsOperation.route.path,
      (sdk) => sdk.logs(input, { signal, timeoutMs: 600_000 }),
      signal,
    );
    for (const event of page.events) io.out(`${json ? JSON.stringify(event) : eventText(event)}\n`);
    const hasMore = !firstTail && page.hasMore;
    firstTail = false;
    const next: string | null = page.cursor ?? cursor;
    if (!follow || (!hasMore && page.settled)) return 0;
    if (hasMore && next === cursor)
      throw new GoldenError("invalid_config", "Armada events response has more events but did not advance its cursor.");
    cursor = next;
    if (!hasMore) await (deps.sleep ?? Bun.sleep)(1000);
  }
};

function eventText(event: LogsResult["events"][number]) {
  if (event.kind === "message" || event.kind === "prompt" || event.kind === "steer") return event.text;
  if (
    event.kind === "other" &&
    event.type === "armada/modelRateLimit" &&
    event.data &&
    typeof event.data === "object"
  ) {
    const data = event.data as Record<string, unknown>;
    if (typeof data.message === "string")
      return `${data.message} (retry ${data.retryCount}, total wait ${Number(data.totalWaitMs) / 1000} s)`;
  }
  return JSON.stringify(event);
}

const usage = "armada events [sandbox-id] [-f] [--tail N] [--org UUID] [--json]";

export default {
  name: "events",
  summary: "Read agent events from a sandbox",
  usage: `  ${usage}
                                           Read agent events`,
  help: `Usage: ${usage}
Read one page of agent events. --tail N starts with the last N events (1–1000).
-f follows new events until the sandbox settles. Ctrl-C stops the reader.
Piped output and --json emit one JSON object per event.
`,
  automaticJson: true,
  validateProfileForHelp: true,
  run: events,
} satisfies Command;
