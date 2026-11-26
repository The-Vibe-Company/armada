import { AuthError } from "@armada/auth";
import { type GoldenConfig, GoldenError, parseDockerSnapshotRecord, snapshotUpdateAvailable } from "@armada/core";
import { type Args, flag, single, uuid } from "./args.ts";
import type { AuthIo } from "./auth-commands.ts";
import { resolveHost, resolveHostOrganization } from "./host-commands.ts";
import { createSdkCommandClient } from "./sdk-session.ts";
import { waitForSnapshot } from "./snapshot-wait.ts";
import { formatTable } from "./table.ts";

function parseSnapshot(input: unknown) {
  try {
    return parseDockerSnapshotRecord(input);
  } catch {
    throw new AuthError("Armada returned an invalid snapshot response.", "unavailable");
  }
}
export async function dockerSnapshotCommand(
  operation: "ls" | "new" | "update" | "rebuild" | "rm" | "show",
  args: Args,
  io: Pick<AuthIo, "out" | "err">,
  auth: AuthIo,
  sleep: ((ms: number) => Promise<void>) | undefined,
  readConfig: () => Promise<GoldenConfig<string | undefined>>,
  waitSeconds: () => number,
) {
  if (operation === "update" || operation === "rm")
    throw new GoldenError("invalid_config", `snapshot ${operation} supports Boat and Modal only.`);
  const allowed = new Set([
    "--org",
    "--provider",
    "--json",
    ...(operation === "rebuild" ? ["--request-id"] : []),
    ...(operation === "new"
      ? ["--host", "--request-id", "--private", "--config", "--repo", "--init", "--wait", "--timeout"]
      : []),
  ]);
  if ([...args.options.keys()].some((key) => !allowed.has(key)))
    throw new GoldenError("invalid_config", "Unsupported Docker snapshot option.");
  const client = await createSdkCommandClient(auth);
  const org = await resolveHostOrganization(client, single(args, "--org"));
  const post = (operation: Parameters<typeof client.dockerSnapshot>[0], body: object, signal?: AbortSignal) =>
    client.control<Record<string, unknown>>(`docker/snapshots/${operation}`, { org, ...body }, signal);
  if (operation === "ls") {
    if (args.positionals.length) throw new GoldenError("invalid_config", "snapshot ls takes no name.");
    const data = await post("list", {});
    if (!Array.isArray(data.snapshots))
      throw new AuthError("Armada returned an invalid snapshot response.", "unavailable");
    const rows = data.snapshots.map(parseSnapshot);
    const currentVersion = typeof data.currentVersion === "string" ? data.currentVersion : null;
    if (flag(args, "--json")) {
      io.out(`${JSON.stringify(rows, null, 2)}\n`);
    } else if (rows.length === 0) {
      io.out("No snapshots.\n");
    } else {
      io.out(
        formatTable(
          ["ID", "NAME", "STATUS", "VISIBILITY", "HOST", "NOTES"],
          rows.map((r) => [
            r.id,
            r.name,
            r.status,
            r.visibility,
            r.hostName ?? r.hostId,
            [
              r.failureReason,
              r.baselineWarning,
              `Built on Armada ${r.builtOnVersion ?? "unknown version"}${snapshotUpdateAvailable(r.builtOnVersion, currentVersion) ? ` · Update to ${currentVersion}: armada snapshot rebuild ${r.id} --provider docker --org ${org}` : ""}`,
            ]
              .filter(Boolean)
              .join(" · "),
          ]),
        ),
      );
    }
    return 0;
  }
  if (operation === "rebuild") {
    const id = args.positionals[0],
      requestId = single(args, "--request-id") ?? crypto.randomUUID();
    const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
    if (args.positionals.length !== 1 || !id || !uuid.test(id) || !uuid.test(requestId) || id === requestId)
      throw new GoldenError(
        "invalid_config",
        "Use snapshot rebuild SNAPSHOT_UUID --provider docker [--request-id UUID].",
      );
    io.err(
      `Rebuild request ${requestId}. The old snapshot stays usable. Retry with the same --request-id after an unknown outcome.\n`,
    );
    const row = parseSnapshot((await post("rebuild", { id, requestId })).snapshot);
    if (row.id !== requestId)
      throw new GoldenError(
        "build_failed",
        "Rebuild outcome unknown: the server returned a different snapshot. Inspect the printed request ID before retrying.",
      );
    io.out(
      flag(args, "--json")
        ? JSON.stringify(row, null, 2) + "\n"
        : `New Docker snapshot: ${row.id}\nBuild: ${row.status}\nBuilt on Armada: ${row.builtOnVersion ?? "unknown version"}\n${row.baselineWarning ? `${row.baselineWarning}\n` : ""}Original snapshot unchanged: ${id}\n`,
    );
    return 0;
  }
  if (operation === "show") {
    if (args.positionals.length !== 1)
      throw new GoldenError("invalid_config", "snapshot show requires a snapshot UUID.");
    const id = args.positionals[0];
    uuid(id, "snapshot ID");
    const row = parseSnapshot((await post("get", { id })).snapshot);
    io.out(JSON.stringify(row, null, 2) + "\n");
    return 0;
  }
  if (args.positionals.length !== 1)
    throw new GoldenError(
      "invalid_config",
      "Use snapshot new NAME --provider docker --host UUID|NAME --config FILE [--private].",
    );
  const selector = single(args, "--host");
  if (!selector) throw new GoldenError("invalid_config", "Docker snapshot creation requires --host UUID|NAME.");
  const requestId = single(args, "--request-id") ?? crypto.randomUUID();
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(requestId))
    throw new GoldenError("invalid_config", "--request-id requires a UUID.");
  const config = await readConfig();
  const seconds = waitSeconds();
  const hostId = await resolveHost(client, org, selector);
  io.err(`Snapshot request ${requestId}. Reuse this --request-id with identical input after an unknown outcome.\n`);
  let row = parseSnapshot(
    (
      await post("create", {
        name: args.positionals[0],
        hostId,
        requestId,
        visibility: flag(args, "--private") ? "private" : "org",
        config,
      })
    ).snapshot,
  );
  if (row.id !== requestId)
    throw new GoldenError(
      "build_failed",
      `Build outcome unknown. Inspect ${requestId} with snapshot show before retrying.`,
    );
  try {
    row = await waitForSnapshot(
      row,
      seconds,
      sleep,
      ({ status }) => status === "building",
      async (signal) => parseSnapshot((await post("get", { id: requestId }, signal)).snapshot),
    );
  } catch {
    throw new GoldenError(
      "build_failed",
      `Polling stopped; use snapshot show ${requestId} --provider docker --org ${org}.`,
    );
  }
  io.out(
    flag(args, "--json")
      ? JSON.stringify(row, null, 2) + "\n"
      : `Docker snapshot: ${row.id}\nName: ${row.name}\nBuild: ${row.status}\nBuilt on Armada: ${row.builtOnVersion ?? "unknown version"}\n${row.baselineWarning ? `${row.baselineWarning}\n` : ""}Read: armada snapshot show ${row.id} --provider docker --org ${org}\n`,
  );
  if (row.status === "failed")
    throw new GoldenError("build_failed", `Docker snapshot ${row.id} failed. Inspect it with snapshot show.`);
  return 0;
}
