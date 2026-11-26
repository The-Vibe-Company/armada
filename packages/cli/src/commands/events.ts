import { AuthError } from "@armada/auth";
import { GoldenError } from "@armada/core";
import type { ListResult, LogsInput, LogsResult } from "@armada/core/contract";
import { acceptedOptions, flag, parseArgs, single } from "../args.ts";
import { resolveSandboxId } from "../current-sandbox.ts";
import { createSdkCommandClient } from "../sdk-session.ts";
import type { Command } from "./command.ts";

const events: Command["run"] = async (argv, { io, deps, auth }) => {
  const args = parseArgs(argv, ["--tail"], ["-f", "--follow"]);
  acceptedOptions(args, "events", ["-f", "--follow", "--tail", "--org", "--json"]);
  if (args.positionals.length > 1) throw new GoldenError("invalid_config", "Pass at most one sandbox ID.");
  const tail = single(args, "--tail");
  const limit = Number(tail);
  if (tail !== undefined && (!/^\d+$/.test(tail) || limit < 1 || limit > 1000))
    throw new GoldenError("invalid_config", "--tail must be between 1 and 1000.");
  const org = single(args, "--org");
  const follow = flag(args, "-f") || flag(args, "--follow");
  const json = flag(args, "--json");
  const client = await createSdkCommandClient({ ...auth, fetch: deps.fetch ?? auth.fetch });
  const id = await resolveSandboxId(
    args.positionals[0],
    auth.env,
    deps.sandboxFile,
    org,
    client.sandboxes.list<ListResult>,
  );
  const base: LogsInput = { id, follow, ...(org === undefined ? {} : { org }) };
  let firstTail = tail !== undefined;
  let cursor: string | null = null;

  while (true) {
    const page: LogsResult = await client.sandboxes.logs<LogsResult>(
      { ...base, ...(firstTail ? { direction: "backward", limit } : {}), ...(cursor === null ? {} : { cursor }) },
      { signal: AbortSignal.timeout(600_000) },
    );
    for (const event of page.events) io.out(`${json ? JSON.stringify(event) : eventText(event)}\n`);
    const hasMore = !firstTail && page.hasMore;
    firstTail = false;
    const next: string | null = page.cursor ?? cursor;
    if (!follow || (!hasMore && page.settled)) return 0;
    if (hasMore && next === cursor)
      throw new AuthError("Armada events response has more events but did not advance its cursor.", "unavailable");
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
  usage: {
    interactive: `  ${usage}
                                           Read or follow (-f) agent events`,
  },
  help: `Usage: ${usage}
Read one page of agent events. --tail N starts with the last N events (1–1000).
-f follows new events until the sandbox settles. Ctrl-C stops the reader.
Piped output and --json emit one JSON object per event.
`,
  automaticJson: true,
  useSelectedOrg: true,
  validateProfileForHelp: true,
  run: events,
} satisfies Command;
