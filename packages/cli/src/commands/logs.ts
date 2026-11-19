import { GoldenError, type Provider } from "@armada/core";
import { flag, oneName, parseArgs, single } from "../args.ts";
import { createArmadaApiClient } from "../armada-api.ts";
import type { Command } from "./command.ts";

const FOLLOW_DELAY_MS = 1_000;
const LOGS_REQUEST_TIMEOUT_MS = 10 * 60_000;

type LogsWireResult = {
  events: Awaited<ReturnType<Provider["events"]>>["events"];
  cursor: string | null;
  hasMore: boolean;
  settled: boolean;
};

const logs: Command["run"] = async (argv, { io, deps, auth }) => {
  const normalized: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--tail") {
      normalized.push("--tail", /^\d+$/.test(argv[i + 1] ?? "") ? argv[++i]! : "100");
    } else normalized.push(arg);
  }
  const args = parseArgs(normalized, ["--tail"]);
  const tail = single(args, "--tail");
  const limit = tail === undefined ? undefined : Number(tail);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 1000))
    throw new GoldenError("invalid_config", "--tail must be between 1 and 1000.");
  if (tail !== undefined && (flag(args, "--all") || single(args, "--since")))
    throw new GoldenError("invalid_config", "--tail cannot be combined with --all or --since.");
  const org = single(args, "--org");
  let firstTail = tail !== undefined;
  const id = oneName(args.positionals);
  const all = flag(args, "--all");
  const follow = flag(args, "--follow");
  const client = await createArmadaApiClient({
    env: auth.env,
    fetch: deps.fetch ?? auth.fetch,
    session: auth.session,
    ...(auth.timeoutMs === undefined ? {} : { timeoutMs: auth.timeoutMs }),
  });
  let settled = false;
  let cursor: string | null = single(args, "--since") ?? null;

  while (!settled) {
    const result = await client.sandboxes.logs<LogsWireResult>(
      {
        id,
        all,
        follow,
        ...(org === undefined ? {} : { org }),
        ...(firstTail ? { direction: "backward", limit } : {}),
        ...(cursor === null ? {} : { cursor }),
      },
      { signal: AbortSignal.timeout(LOGS_REQUEST_TIMEOUT_MS) },
    );
    if (flag(args, "--json")) io.out(`${JSON.stringify(result, null, 2)}\n`);
    else for (const event of result.events) io.out(`${eventText(event)}\n`);
    if (firstTail) {
      firstTail = false;
      result.hasMore = false;
    }
    const nextCursor: string | null = result.cursor ?? cursor;
    const progressed = nextCursor !== cursor;
    if ((all || follow) && result.hasMore && !progressed) {
      throw new GoldenError("invalid_config", "Armada logs response has more events but did not advance its cursor.");
    }
    cursor = nextCursor;
    const drain = all || follow;
    settled = !drain || (!result.hasMore && (!follow || result.settled));
    if (!settled && !result.hasMore)
      await (deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(FOLLOW_DELAY_MS);
  }
  return 0;
};

function eventText(event: Awaited<ReturnType<Provider["events"]>>["events"][number]) {
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

export default {
  name: "logs",
  summary: "Read agent events from a sandbox",
  usage: {
    logs: `  armada logs <sandbox-id> [--tail [n]] [--all] [--follow] [--json]
                                           Read agent events; --all drains available pages, --follow waits for new pages until settled`,
  },
  help: `Read agent events from a sandbox.

Usage:
  armada logs <sandbox-id> [--since <cursor>] [--all] [--follow] [--org <org>] [--json]
  armada logs <sandbox-id> --tail [n] [--follow] [--org <org>] [--json]

Options:
  --since <cursor>  Resume after an opaque cursor returned by a JSON page.
  --tail [n]        Last n events (1–1000; default 100). You cannot combine
                    --tail with --all or --since. With --follow, tail is read once.
  --all             Drain all currently available pages, without polling delays.
  --follow          Drain pages, then poll while active until settled.
                    Ctrl-C stops only this reader, not the agent.
  --org <org>       Override the organization selected by armada org use.
  --json            Stream page objects: events, cursor, hasMore, settled.
                    Multiple pages are not one JSON array. Errors use stderr.

Without --all, --follow or --tail, read one bounded page.
Use armada list --json to find a visible sandbox ID.

Examples:
  armada logs SANDBOX_ID --tail 20
  armada logs SANDBOX_ID --since CURSOR --follow
  armada logs SANDBOX_ID --all --json | jq -c '.events[]'

For other commands and authentication settings: armada --help.
`,
  run: logs,
} satisfies Command;
